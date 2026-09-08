# 问题清单

## 2026-09-08 — block：executable batch 53 的 source-accounting obligation 需要宿主裁定

- 阶段/批次/source：executable，batch 53/71，`a28585b1cf867f3e3a16`。
- 事实：`account_source_units` 的 `acct-00007-p07` 起初因 `unit-sentence-340dcd6070b1aa62ea04c578` 已被 current-batch exact semantics represented 而不能再取得 model disposition；随后模型提交空 `decisions`，违反最小长度 schema。持久化 obligation 将同一 tool/proposal identity 标为两次失败。
- 保护结果：后续相同 identity 获得 `Compiler proposal obligation requires host review`，不可在当前或新 session 重试。编译器的一次有界恢复回合仍读取了当前资料，但没有绕过该保护；结束时 batch 53 未 checkpoint。
- 判断：block。进程已退出，`status` 报告 `completedBatches=52`、403 pending、96 rejected。有效 drafts、审计、obligation journal、账本页和检查点均保留；未删除或重新开始该批。
- 现场：`rebuild.log` 的 batch 53 段；持久化 `world/v3/compiler/proposal-obligations/`；此次运行审计及当前 compiler batch/proposal 工件。

## 2026-09-08 — batch 50 恢复协议已修复，实际检查点待续跑

- 精确复核修正下方“过期 ref”判断：discovery 返回的 ref 正确，模型把 logicalId 拼成了另一个读取 ref。
- 原 schema 实际有三个不匹配 selector，新实现一次报告全部诊断，并把参数预检和提案失败持久化到 source/batch；重启或无关提案不能清除失败。
- finish 在任何 review 写入前检查未解决记录。原始及修正输入均失败后停止，需宿主复核。
- 旧失败已在锁内导入并据原文审计为 unsupported-as-submitted；不意味着机制已编译。隔离真实输入重放通过，947 项测试通过；未新增实际 batch 50 检查点。
- 详见 [obligation-fix-results-2026-09-08.md](obligation-fix-results-2026-09-08.md)。

## 2026-09-08 — 修复并验证原 batch 52 阻塞

- stale compiler lock 已通过新宿主恢复命令归档；原 batch 52 在 `2026-09-08T07:41:42.630Z` 完成检查点，锁已释放。
- 补齐跨阶段精确覆盖；修正 execution binding 模型 JSON Schema 暴露 ad-hoc 分支而运行时拒绝的不一致。
- 修正 accounting-only finish 掩盖 proposal failure，以及 no-artifacts 冲突误导撤回整页/错误分类为 offset 的恢复问题。
- 中间验证因旧指引撤回的 12 页已审计恢复为带来源的新 pending 副本，最终全部 accepted；原 rejected 历史保留。没有隐去失败。
- 新 pipeline 有效检查点为 47/71；尚未完成全书执行闭合或可玩认证。完整证据、备份和测试结果见 [fix-results-2026-09-08.md](fix-results-2026-09-08.md)。

## 2026-09-08 — block：executable batch 50 未能通过提案失败门禁

- 阶段/批次/source：executable，batch 50/71，`a28585b1cf867f3e3a16`。
- 事实：该批先发现两个过期的 `read_compiler_artifact` ref；模型获得同一 active scope 的 discovery 指引后继续。随后 `propose_action_schema schema-remote-communication-00004` 因 segment `a28585b1cf867f3e3a16-00004-f50b153c1580` 的 evidence selector 2 未包含原文精确引句而失败。
- 宿主行为：模型按 `finish_compiler_batch` 的 accounting disposition SOP 做了一次修正并重试 finish；宿主仍检测到一个先前 proposal tool failure，拒绝将 accounting-only 状态 checkpoint 为成功：`Compiler batch 50 was not checkpointed: 1 proposal tool call(s) failed before accounting-only completion`。
- 判断：block。进程已退出；`status` 报告 `completedBatches=50`、398 pending、93 rejected，但本次 batch 50 的 finish 未获 checkpoint，不能据该计数推断该批已成功完成。没有删除锁、草案、账本页或检查点，也未对该诊断发起新的未改变重试。
- 现场：`rebuild.log` 的 batch 50 段、持久化 compiler proposals/batches，以及本次 audit `run-mtsiqp45-33329f86-0903-440a-a2f2-1e1f5f6d208e`。

## 2026-09-07T09:36Z — 非 block：批次草案受控替换

- 阶段/批次/source：observation，batch 1（后续 batch 2–3 也发生同类替换），`a28585b1cf867f3e3a16`
- 事实：首次 finish 后模型提交了带 `-v2` 的修订草案，并调用 `withdraw_compiler_proposal` 撤回被替代草案，随后再次调用 finish。batch 1、2、3 均获宿主 finish handshake 验证。
- 判断：非 block。项目工具的受控 withdraw/replace 路径保留 rejected history；没有手工删除、跳过或改写完成标记，且每个批次已实际 checkpoint。
- 影响：无已证实的完整性影响；候选仍未生成，后续全书闭合尚未执行。
- 现场：`rebuild.log`；持久化 workspace 的 compiler proposals/batches；最近成功 checkpoint 见 `status.md`。

记录规则：仅记录经证实的问题；推测会明确标注。出现会影响数据正确性、证据链或恢复安全性的情况即按用户协议升级为 block，并停止新的编译调度。

## 2026-09-07T15:29Z — 已恢复：batch 35 `铜罐` 精确名称 trace

- 阶段/批次/source：semantic，batch 35/71（`batch-a28585b1cf867f3e3a16-00012-semantic-f959f2526287`），`a28585b1cf867f3e3a16`。
- 原始错误：`artifact-copper-urn-00012` 的 canonicalName `铜罐` 没有 resolved source mention；原回合因此触发 circuit breaker，未 checkpoint。
- 恢复依据：`docs/agent-tool-recovery.md` 与 `src/agent/tool-recovery.ts` 的精确名称 SOP。原文同一 citable slice 存在精确 `铜罐`，而旧 annotation surface 为 `黄铜罐`，不可替代。
- 已执行动作：新 host-started recovery turn 保留 active proposals，使用 discovery/read 验证 annotation，并提交 `pr-copper-urn-exact-00012`；随后一次有实际修正的 finish handshake 通过。
- 影响：batch 35 已 checkpoint；没有清空、重放全书、手改提案或跳过验证。后续编译正在继续。

## 2026-09-07T — block：编译进程消失后遗留 stale compiler lock

- 阶段/批次/source：executable，batch 52/71，`a28585b1cf867f3e3a16`。
- 事实：PID 346496 已不在进程表；最后日志停在 source-accounting page 12，未出现项目退出诊断或正常结束行。最后成功检查点为 batch 51/71。
- 锁：`locks/compiler.lock/owner.json` 仍指向 PID 346496（startedAt `2026-09-07T15:26:09.200Z`）。重新执行 `rebuild` 被项目拒绝为 stale lock。
- 判断：block。源码 `WorkspaceOperationLock` 明确禁止自动夺取 stale lock；没有 CLI 或公开 recovery API，唯一释放路径是原持有者的 token-verified `release()`。手动删除锁会绕过并发/恢复保障。
- 已执行动作：仅做进程、锁、日志、检查点和源码恢复入口的只读核对；未删除锁、未重启、未修改 world/compiler state。
- 建议：提供/实现受 token、owner 元数据和死 PID 复核保护的项目级 stale-lock recovery 命令或 API；之后从 batch 52 的 active drafts 和 checkpoint 恢复。
