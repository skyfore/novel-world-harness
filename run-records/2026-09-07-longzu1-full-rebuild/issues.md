# 问题清单

## 2026-09-07T09:36Z — 非 block：批次草案受控替换

- 阶段/批次/source：observation，batch 1（后续 batch 2–3 也发生同类替换），`a28585b1cf867f3e3a16`
- 事实：首次 finish 后模型提交了带 `-v2` 的修订草案，并调用 `withdraw_compiler_proposal` 撤回被替代草案，随后再次调用 finish。batch 1、2、3 均获宿主 finish handshake 验证。
- 判断：非 block。项目工具的受控 withdraw/replace 路径保留 rejected history；没有手工删除、跳过或改写完成标记，且每个批次已实际 checkpoint。
- 影响：无已证实的完整性影响；候选仍未生成，后续全书闭合尚未执行。
- 现场：`rebuild.log`；持久化 workspace 的 compiler proposals/batches；最近成功 checkpoint 见 `status.md`。

记录规则：仅记录经证实的问题；推测会明确标注。出现会影响数据正确性、证据链或恢复安全性的情况即按用户协议升级为 block，并停止新的编译调度。
