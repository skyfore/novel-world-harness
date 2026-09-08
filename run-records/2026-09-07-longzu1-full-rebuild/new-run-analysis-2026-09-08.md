# 新运行深度分析：batch 50 的失败恢复与执行闭合

分析对象：`run-mtsiqp45-33329f86-0903-440a-a2f2-1e1f5f6d208e`，2026-09-08 10:20:29–10:24:25 UTC；源码基线 `fb76c04`。本次仅只读检查现场、运行纯内存协议复现并撰写分析；没有重启编译、修改检查点或 world state。

## 结论

直接触发点是 action-schema 提案的精确引句验证失败。更深的问题是：模型混淆全书可发现上下文与本批可引用证据，恢复指引没有形成必须完成的宿主状态约束，finish 工具和外层 checkpoint 门禁使用不同的成功条件。上次补丁正确阻止了本次 accounting-only 假成功，但没有建立跨会话持久化的失败闭合协议。

不应通过删除失败、关闭门禁、修改原文、降低机制证据标准或原样重跑来解决。

## 1. 最新现场与进度

- 运行 manifest 为 failed；13 次 LLM 请求、22 次工具调用，自动 recovery 计数为 0。实际模型为 openai-codex / gpt-5.6-luna，thinking medium。
- batch 47、48、49 获得新检查点；batch 50 未获检查点。
- 当前 pipeline 34 共 50 个有效检查点：46 个 observation/semantic，4 个 executable review（47、48、49、此前恢复的 52）。50 是完成数量，不是连续成功到第 50 批。
- compiler.lock 不存在；这次不是 stale lock，也没有证据表明是网络、超时或进程丢失。
- world proposals：398 pending、93 rejected。pending 包括 75 canonical-event、183 event-participation、36 scene-occurrence、69 entity 等；没有 action-schema、event-execution。
- 本次成功的前三批分别回放 1、5、29 个 accounting proposal，world 均为 0；失败 batch 50 的 finish 回放 36 个 accounting proposal。这些数量不是本轮新生成的 executable 产物。
- `status.md` 顶部仍记录之前的 47/71，已落后于实际文件；`issues.md` 的“过期 ref”判断需要细化为下面已核实的 ID 混用。

## 2. 精确失败链路

审计 events.jsonl 的序号：

1. seq 87–88：查询 unresolved source units，结果为 0。这里只证明现有覆盖/分类账没有待处理单元。
2. seq 96–105：查询 schema、events、execution、annotations；schema/execution 为空，event 返回 75 条，annotation 返回 200/949 条，尚有 nextOffset=200。
3. seq 113–124：读取六个 event，四个成功，两个 ref miss。之后没有执行指引要求的重新 discovery/read。
4. seq 132–133：唯一一次 `propose_action_schema`，在 selector 2 被拒绝；没有一次修正后的提案重试。
5. seq 141–142：模型调用 finish，以 segment disposition=no-artifacts 声称没有足够机制依据；宿主要求保留已有 accounting 并改为 proposed。
6. seq 150–151：模型只改 disposition 后，finish 返回 `compilerBatchFinished=true, terminate=true`，world=0/accounting=36。
7. seq 154：外层报告仍有一个未解决 proposal failure，拒绝 checkpoint 并结束整个运行。

因此“收到 recovery SOP 后继续运行”不能解释为“按 SOP 修复成功”。本轮只修了 finish disposition，没有修复 schema，也没有修复两个读取 ref。

## 3. 引句不是一个错字：四个 selector 中三个有问题

本批唯一可引用 segment 为 `a28585b1cf867f3e3a16-00004-f50b153c1580`，原文 335–692 行。逐条核对工具输入和不可变原文：

| selector | 本批精确匹配 | 根因 |
|---|---|---|
| 1：游戏频道传授秘笈句 | 是，第 460 行 | 第一条通过 |
| 2：`诺诺上线` | 否，整本也无此连续子串 | 本批实际文本为 `“诺诺”上线`，模型省略姓名外的引号 |
| 3：`给你辅导辅导发音` | 否，在第 180 行 | 来自前一 segment 00003，却声明为当前 segment 00004 |
| 4：`切一盘` | 否，在第 152 行 | 同样跨 segment 错配 |

宿主按 selector 顺序 fail-fast，因此运行只暴露第二条。只补上第二条引号，后续仍会失败。

提案 supportingEventIds 也来自 00003。全书 artifact discovery 允许发现这些上下文，但这不自动授予本批引用其原文的权限。应先确定机制真正依赖哪些 occurrence，再由宿主调度拥有这些精确证据的受限任务；不能把所有 selector 的 segment_id 改为当前批次，或直接让模型任意扩大证据范围。

另一个待审语义问题：提案将在线对局和远程辅导合并为“远程在线交流”，同时 stateEffects 为空、knowledge/time/scene effects 全关闭。即使引句修正，也不能据此认定它能解释相关事件的实际结果。需要独立验证机制共性及 event-execution 的 observedOutcome，而不是只追求 schema 校验通过。

## 4. 两个 ref miss 是命名空间混淆，不是数据过期

seq 101 的 discovery 已返回可用 ref：

| discovery 返回的 ref | logicalId | 模型实际构造的错误 ref |
|---|---|---|
| `pending:event-nono-stabbed-00022-v4` | `event-norton-stabs-nono-00022` | `pending:event-norton-stabs-nono-00022-v4` |
| `pending:event-suit-exchange-00022-v3` | `event-nono-exchanges-suit-00022` | `pending:event-nono-exchanges-suit-00022-v3` |

`artifact-retrieval.ts:268` 使用 proposal envelope ID 生成 ref；logicalId 是领域对象稳定身份。模型把 logicalId、pending 前缀和版本后缀拼成了读取地址。

这两个错误不是最终 proposalFailed=1 的来源，读取失败不计入 proposal failure。但它们说明模型没有可靠遵守“复制 exact ref”的协议，并且在当前 00004 切片中读取 00007/00022 的事件，加重了证据范围混淆。

## 5. 完成协议的三个缺口

### 5.1 门禁位于终止和持久化之后

`proposal-tools.ts:2940` 之后执行各类提交；`:2974` 附近 accept accounting 并 recordBatchReview；然后返回 terminate=true。外层 `compile-source.ts:218` 才调用 `compilerBatchFailure`；`batches.ts:691` 的 markComplete 因 runner 抛错而没有执行。

现场确有 batch 50 的 accounting batchReview（10:24:25.922Z），但没有对应 batch checkpoint。未发生错误 world truth 提交；问题是 review 已持久化、工具向模型宣告成功，而宿主最终拒绝成功。新会话会再次看到已有 accepted accounting。

### 5.2 未解决失败不持久化

`batch-outcome.ts` 从本次 messages 建立 failed Set。schema 失败发生在 submit 前，pending/rejected 目录中均无该 proposal；真实诊断虽在 audit 中，但没有被 hydrate 成下一轮必须解决的批次状态。

纯内存调用现有 outcome 函数的复现结果（不是重新编译）：

| 输入 | proposalFailed | compilerBatchFailure |
|---|---:|---|
| schema failure → accounting-only finish | 1 | 拒绝，且 recoverable=false |
| 新会话仅回放已有 accounting 并 finish | 0 | 无错误 |
| schema failure → finish 中有 1 个不相关 world proposal | 1 | 无错误 |

第二行说明跨会话遗忘风险；第三行说明 `world===0` 数量判断不足以表达“每个失败是否已被解决”。这是代码级复现，不声称真实运行已经执行了这两种绕过。

### 5.3 缺少有依据的放弃/转交状态

正确修复后同一个 proposal identity 成功，可以清除当前会话 failed key。但“发现原提案不受证据支持，合理放弃或移交另一证据批次”没有结构化闭合记录。盲目增加重试次数只会在未闭合失败和遗忘失败之间摆动。

## 6. 为什么反复有 review 进度，却没有 executable 产物

三个因素共同作用：

- 恢复 prompt 明确指导“accounting unresolved 清零后调用 finish”；模型容易把旧账本回放视为任务完成。executable stage 的机制审查没有独立的逐事件完成约束。
- `source-pattern` 要求至少两个 supportingEventIds；原文工作却按单 segment 划分。模型能看到全书事件，但只持有一块可引用原文，缺少明确的跨 occurrence 机制归纳调度。
- prompt 要求读完整 observation/semantic catalogs，但模型实际只读取 200/949 annotations，就转向提案和结束。全量阅读指令与大上下文工作流不匹配。

规模证据：batch 50 首个 provider payload 的 tools JSON 约 335,446 字符，26 个工具；首轮 usage 为 input 150,357 tokens，最后一轮 input+cacheRead 为 201,768。一次 event discovery 返回约 62 KB，一次 annotation discovery 返回约 77 KB。这些是请求上下文负担，不应把跨请求累计 totalTokens 当成唯一上下文长度。上下文过大是有证据的负担；它是否直接导致此次错误仍是待实验验证的推断，不能单凭这一轮归因于模型能力。

## 7. 分优先级解决方案

### P0：先修失败闭合和提交边界

1. 增加 source+batch+contract scoped 的持久化 attempt/obligation 记录。记录 tool、proposal identity、输入摘要、诊断、证据 scope、修正次数、状态；audit 保留完整原始错误。
2. 将同一规则移入 finish 的验证阶段，在任何 accept/review commit/terminate 之前检查 unresolved obligations；外层保留同一校验作为防御，不再各自维护不同判断。
3. 允许三种有审计的闭合：同一失败对应的修正提案通过验证；经过明确复核后判为 unsupported；宿主创建有目标证据 scope 的 deferred task。后两者只能结束本地审查，不能伪装成 executable coverage 已完成。
4. 后续会话必须 hydrate 这些 obligations。为每个 obligation 最多允许一次有实际修改的重试；同诊断重复、证据 scope 不足或宿主错误时停止/转交，不进行原样循环。
5. commit 使用可恢复的 finish receipt/journal 绑定 review、接受结果和 checkpoint。崩溃恢复重放同一 receipt；不能仅凭 accounting accepted 状态推断完成。

### P1：修证据与读取协议

1. selector 验证一次返回全部缺失/歧义诊断，带 selector index、target_path 和合法 segment ID；仍严格使用原文精确匹配，不自动归一化标点。
2. 明确 ref 与 logicalId 的不同用途。读取工具始终精确 lookup；在 discovery 中直接提供可复制 read 参数，并以本批 overlap 优先返回结果。不可自动把猜测 ref 转换成任意同名对象。
3. 分开“本批可引用 evidence”与“全书只读 context”。需要跨批机制归纳时，生成显式机制候选任务，由宿主核验 supporting event IDs 并附加其确切 source spans。
4. 新机制任务仍不能修写早期事件、扩大角色知识或将未来 canon 当作 runtime 当前 truth。

### P1：建立独立 executable 覆盖账本

对每个 occurrence 记录 reviewed、bound、unsupported、deferred 及验证依据，并跟踪 schema/supporting occurrences 的依赖。source accounting unresolved=0 只说明文本处置完成。最终认证只接受满足相应 entry/runtime 要求的 verified bindings，不接受 world proposal 数量或审查计数替代。

状态展示分别给出 source-review progress、verified execution bindings、unresolved obligations、deferred mechanisms、certification blockers；不要要求每个 segment 强行制造一个 schema。

### P2：减少上下文负担，再做模型对比

按“发现候选 → 机制提案 → 绑定/验证”拆分工具集，减少每次发送的巨大 JSON Schema；catalog 默认提供当前事件和依赖的紧凑索引，按需读精确 payload。完整阅读要求改成有宿主覆盖记录的分页任务。使用固定同一 evidence fixture 对比模型/上下文方案，衡量首次验证成功率、跨 scope 引句、闭合结果与 token 消耗。

## 8. 实施验收与现场恢复

- 用本轮真实输入构造脱敏 fixture：四个 selectors 一次诊断出后三个问题；精确引号修正不会偷偷授权前一 segment 的引句。
- ref 测试覆盖 envelope ID 与 logicalId 不同，模型必须复制 discovery ref。
- 集成测试覆盖：失败后 accounting-only finish、附加不相关 world proposal、新会话恢复、进程中断，均不能清除 unresolved obligation。
- finish 被拒绝时没有新增 accepted/review/checkpoint 副作用；journal 重放保持幂等。
- 完成 P0 后，把此次已审计失败导入 batch 50 obligation，保留现有 36 页与历史，不删除锁/草案/检查点。只跑 batch 50 的有界恢复。
- 回归复核 executable review 47–49、52 的真实能力覆盖；保留其 source-review 成果，不能把“无需新产物”当作已经可玩。
- 机制证据确属跨切片时，先创建宿主限定的跨 occurrence 任务，再验证 schema→binding→observedOutcome；本批若证据不足，明确记录 deferred/unsupported，而不是编造动作效果。

现有纯内存复现已证实门禁缺口；上述方案尚未实施，不能把本分析当作修复完成或新的可玩性认证。
