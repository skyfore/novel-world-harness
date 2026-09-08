# 问题清单

## 2026-09-08 — 修复并验证原 batch 52 阻塞

- stale compiler lock 已通过新宿主恢复命令归档；原 batch 52 在 `2026-09-08T07:41:42.630Z` 完成检查点，锁已释放。
- 补齐跨阶段精确覆盖；修正 execution binding 模型 JSON Schema 暴露 ad-hoc 分支而运行时拒绝的不一致。
- 修正 accounting-only finish 掩盖 proposal failure，以及 no-artifacts 冲突误导撤回整页/错误分类为 offset 的恢复问题。
- 中间验证因旧指引撤回的 12 页已审计恢复为带来源的新 pending 副本，最终全部 accepted；原 rejected 历史保留。没有隐去失败。
- 新 pipeline 有效检查点为 47/71；尚未完成全书执行闭合或可玩认证。完整证据、备份和测试结果见 [fix-results-2026-09-08.md](fix-results-2026-09-08.md)。

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
