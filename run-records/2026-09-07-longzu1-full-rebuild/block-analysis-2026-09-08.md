# 《龙族Ⅰ·火之晨曦》解析阻塞追因（2026-09-08）

本次为只读现场分析；未启动模型、移除锁、修改 compiler/world state 或改写既有运行记录。源码基线为 `44669a83e49f031eb67ca68a4a61cc188b510a07`。时间均为 UTC。

## 1. 当前实际状态

source：`a28585b1cf867f3e3a16`。

状态根目录：`/root/.novel-harness/workspaces/v1/novel-world-harness-96fd81aa9a7d/`，下文世界路径相对其 `world/v3/`。

| 指标 | 本次文件核验结果 |
| --- | --- |
| 批次检查点 | 51/71；observation 23、semantic 23、executable 5 |
| 最后检查点时间 | `2026-09-07T17:28:52.093Z` |
| 中断位置 | batch 52，segment 00006，executable，原文行 789–1065 |
| 当前批次 ID | `batch-a28585b1cf867f3e3a16-00006-executable-91a6ca318dcb` |
| 当前批草案 | `acct-00006-p01` 至 `p12`，12 个 pending accounting proposal，240 个不重复 unit ID |
| 草案分类 | background-only 176；duplicate-description 64 |
| 最后草案时间 | `2026-09-07T17:34:09.933Z`，p12 已落盘 |
| 世界提案 | pending 398；accepted 0；rejected 93；pending 全部不属于 executable 批次 |
| 当前持久化执行机制 | pending 中 action-schema、rule、event-execution 等均为 0 |
| candidate / runtime | 当前 world/v3 仅 evidence、proposals、compiler；尚不能认定候选闭合或可玩 |

检查点依据：`compiler/batches/a28585b1cf867f3e3a16.json`。第 52 批草案依据：`compiler/observations/v1/accounting/proposals/a28585b1cf867f3e3a16/pending/`。

扫描当前 world/v3 的 4,541 个 JSON 均可解析；这是文件可读性检查，不等同于 schema、引用闭合或 replay 验证。不可变源文件重新计算的 SHA-256 与登记值 `a28585b1cf867f3e3a1679a09558658338637efd2f0bf15e8d5878b7f9e44fe0` 一致。

## 2. 当前硬阻塞：异常中断后的锁恢复缺口

确认的因果链：第 52 批未完成 finish → compiler lock 遗留 → 后续 rebuild 在获取锁阶段失败 → 无法进入同批草案恢复。

- `locks/compiler.lock/owner.json` 仍记录 PID 346496、startedAt `2026-09-07T15:26:09.200Z`。
- `rebuild.log:9643` 已记录后续启动返回 `Workspace has a stale compiler lock`；该次获取锁时，程序判定 owner 不存活。
- `src/util/workspace-lock.ts:59` 明确不自动夺锁，因为普通 rename/delete 不能提供可移植的 compare-and-delete，可能误删竞争者新建的锁。
- 释放依赖同文件 `release()` 的 token 核对，正常命令通过 `withWorkspaceOperationLock()` 的 `finally` 调用。当前 CLI/公开恢复流程未提供 stale lock repair 入口。
- `src/commands/rebuild.ts:13` 在准备恢复、读取草案之前就获取全局 compiler lock。现有 batch recovery 无法越过这道宿主入口。

因此，锁防护本身符合并发安全意图；工程缺口是“要求显式恢复”但没有可调用、安全且可审计的恢复协议。单纯增加模型重试次数无效。

**尚未确定进程最初为什么退出。** 最后正常工具调用是 p12，日志没有紧随其后的 timeout、circuit breaker、模型错误或正常结束。当前工具进程处于隔离 PID 视图，不能用本次 `ps` 看不到原 PID 来证明整个宿主没有 writer；本次确认的是持久化锁与历史 stale-lock 诊断。

不能把 OOM、SIGKILL、终端/会话清理或宿主重启写成事实。需补充原进程所在宿主的退出信号、父进程日志或对应时间的 OOM/cgroup 记录。第 52 批仅运行约 5m16s，默认单回合 timeout 是 60 分钟，现场不支持“该回合达到默认 timeout”。

## 3. 更深的跨阶段覆盖问题

发现一个与锁独立、值得优先修正的实现问题：accounting 的“已有语义覆盖”目前只取当前 compilerBatchId 的成功提案，无法自然继承同 source、同证据片段的前序阶段覆盖。

代码链：

1. `src/compiler/proposal-tools.ts:3056` 恢复 world proposals 时主要按当前 batch ID 过滤；annotation 同样通过 `listBatchProposals(activeSourceId, compilerBatchId)` 获取。
2. `readProspectiveSemanticCoverage()`（同文件约 1708 行）只从这些当前批次集合收集 assertions 和 annotations。
3. finish 中 `recordsSourceAccounting = !stage || stage === "executable"`（约 2704 行），observation/semantic 不写 accounting review。
4. executable 的 `validateBatchReview()` 因而拿不到前两个阶段的精确标注覆盖。分页工具也使用同一 prospective coverage。
5. `src/compiler/source-accounting.ts:245` 的校验只检查传入覆盖；没有覆盖的句子必须由模型另行分类。分页每次最多 20 条（`src/compiler/batches.ts:749`）。

现场与代码一致：

- manifest 只有 5 个 executable batchReviews；每个 review 的 evidenceSpans 和 annotationSpans 都为空。
- 5 批累计 1,566 条模型分类：第 47–51 批分别 7、82、571、703、203 条。
- manifest records 为 duplicate-description 1,313、background-only 261、paratext 4、represented 0。records 包含宿主生成项，因此总量不等于模型 decisions。
- 按当前 annotation refs 解析到对应 revision，提取 entity-mention/event-mention/quotation 的精确锚点，与 accounting 的非 non-scene 单元做字节区间相交：158 个已分类单元与这些已有标注重叠，其中 108 个 duplicate-description、49 个 background-only、1 个 paratext。未把 discourse 大范围锚点计入此数。
- 示例：`unit-sentence-023834854251fcaa686e7580`（原文行 23–24）已有上述类型标注重叠，但 accounting 为 background-only。

这不证明这 158 个单元全部分类错误，更不意味着“有 mention 就有 executable mechanism”。它证明当前 source accounting 不能完整反映前序已确认的 observation coverage，也解释了为什么 executable 大量工作花在重新分类。若需要阶段专属审核，应分别表达“源证据已覆盖”和“执行机制待审核”，避免用一个 represented/background-only 状态混合两者。

第 50 批耗时 17m30s，36 页 accounting 已足以解释大量工具往返。分页负担可能增加长任务暴露于中断的时间，但没有证据证明它触发了本次进程消失。

## 4. 完成检查点不等于产出可执行世界

第 47–51 批日志报告的成功 proposal 数依次为 1、5、29、36、11，总数 82；恰好对应持久化的 82 个 accepted accounting proposals。当前世界 pending 提案按 kind 为：

- event-participation 183；canonical-event 75；entity 69；scene-occurrence 36；event-relation 19。
- proposition 6；attribution 5；claim 4；event-frame 1。
- executable 批次创建的世界 proposal 为 0；当前 pending 的 action-schema/rule/event-execution 为 0。

第 51 批日志出现 `propose_event_execution` 调用，但没有对应持久化 world proposal。**调用日志不是提交成功证据。** 现有日志未保存这些调用的完整 result，无法追溯每个提案具体是 schema、依赖、证据还是其他原因被拒绝。

`src/compiler/batch-outcome.ts` 把 `account_source_units` 计入 proposal 成功数，因此仅完成 accounting 也可能通过 complete finish。这个检查点语义是工作进度，不是执行质量认证。前五片段缺少执行机制不能直接推论整书最终必然失败，但对产品目标是明确的待验证风险。

后续应选择源证据充分的一个行为切片，追踪 action-schema → event-execution → delta → replay/entry probe，记录每一步诊断；不能用“把 unresolved 都分完”代替这条执行链。

## 5. 历史失败的分层判断

| 批次 | 现场问题与原因边界 | 结果 |
| --- | --- | --- |
| 31、32 | WebSocket closed 1006；传输层错误，不能据此归因第 52 批退出 | 自动重试后 checkpoint |
| 34 | 模型报告亚纪 identity 重复未解、canonical graph 依赖及 event↔scene backlinks 未闭合；宿主记录 3 次 proposal tool 失败。缺少完整 tool result，不能逐项复原 | 新宿主回合 recovery 1/3 后 checkpoint |
| 35 | 宿主确证 `铜罐` canonicalName 缺少 resolved source mention；`黄铜罐` 不满足精确名称链。`entity-resolution.ts:806` 使用 surface 全等，并要求兼容 kind 与有效 resolution | 精确 mention resolution 修复后 checkpoint |
| 45 | 模型报告 participant trace、scene backlink、event 引用问题；宿主记录 22 次 proposal tool 失败。属于多层引用闭合失败，精确调用级根因未持久化 | recovery 1/3 后 checkpoint |
| 49 | 模型报告未产生有效执行机制、尚余 451 accounting units；宿主记录 3 次 proposal tool 失败 | recovery 后以 29 个 accounting proposals checkpoint |
| 52 | p12 已落盘，未 finish；随后出现 stale-lock 错误 | 当前阻塞 |

第 35 批应保留精确 evidence/identity 校验，而非放宽为子串匹配。第 34、45 批也不应以移除图闭合约束来提升完成率。应改善依赖发现和完整错误报告。

## 6. 可观测性缺口与跟进顺序

`status.md` 仍称 batch 38 运行中、无 blocker，与当前 checkpoint 和 issues 冲突。`rebuild.exit` 的 mtime 是 `2026-09-07T12:47:50Z`，早于 PID 346496 启动及第 52 批中断，不能用该文件的 1 判断本次异常退出码。

`src/commands/compile-source.ts:167` 默认只转发可选 onModelToolResult 回调，CLI 无默认 tool-result 持久化；trace 依赖可选 traceParent。隔离 compiler session 明确 `saveSession:false`（`src/compiler/pi-compiler.ts:65`），因此没有可用于补齐错误的会话 transcript。这是调用级追因受限的具体原因，不应通过跨 batch 复用模型会话来修补。

建议按以下顺序跟进：

1. **宿主恢复 P0：** 提供项目级锁检查/恢复协议，校验 workspace、owner 快照及宿主级进程身份，审计并串行化恢复动作，处理 PID 复用、命名空间和竞争者替换锁的竞态；仅核对 token 后直接删除仍不是完整并发方案。保留第 52 批 12 页草案，恢复后重新发现 unresolved 页，不复用旧 pageToken。
2. **证据覆盖 P1：** 在相同 source/segment 范围内投影前序阶段的有效 refs 与 checkpointed 提案证据；排除 rejected、superseded 和越界证据。分别记录 source coverage 与 executable review，不能把 observations 提升成世界事实。回归验证已有精确覆盖不再要求重复分类、真实未覆盖文本仍阻塞。
3. **执行闭合 P1：** 在受控单切片上查明 event-execution 无落盘的错误，形成真实可回放的执行链。为 accounting-only batch 显示清楚的产物统计，继续由世界闭合/可玩性 gate 判定资格。
4. **诊断 P1：** 为每次命令生成独立 run ID，持久化工具结果与恢复类别、finish diagnostic、最后 checkpoint、父 PID/进程身份、退出码或信号；status 从真实状态派生。审计记录与模型上下文隔离，不保存或重用跨证据边界的会话。

本次完成了证据和代码追因，没有执行解锁或继续编译；最初进程终止的触发原因仍未定。
