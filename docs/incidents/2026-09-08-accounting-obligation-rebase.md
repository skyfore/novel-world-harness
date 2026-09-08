# 2026-09-08：source accounting 页失效与持久义务阻塞

本记录固定已发生的事故；修复进度在[实施计划](../plans/2026-09-08-compiler-recovery-and-capability.md)中维护。完整时间线、现场引用和研究依据见[深度审计](../../run-records/2026-09-07-longzu1-full-rebuild/deep-review-2026-09-08/report.zh-CN.md)，机器快照见同目录 `evidence-snapshot.json`。

## 现场边界

- 审计基线：`e00eb9d`，pipeline 34 / prompt 31。
- Source：`a28585b1cf867f3e3a16`；SHA-256：`a28585b1cf867f3e3a1679a09558658338637efd2f0bf15e8d5878b7f9e44fe0`。
- Batch：`batch-a28585b1cf867f3e3a16-00007-executable-e1327f875a22`，计划序号 53/71；切片 00007，原文行 1066–1252。
- Run：`run-mtspxkmt-b07940f0-e82c-4592-b24e-9172c0fc67ea`。
- 截止 2026-09-08 14:32:27 UTC：52 个有效检查点（observation 23、semantic 23、executable 6、boundary 0），403 pending、96 rejected；没有已归档 candidate。52 是集合大小，不意味着最近完成的是 batch 52。

## 因果时间线（UTC）

| 时间 | 审计事件序号 | 上下文与结果 |
| --- | --- | --- |
| 13:51:46.308 | 395 | discovery 返回 20 个 unresolved 单元，token `acctpg-d822695e76f3f23a`。 |
| 13:52:09.143 | 404 | `prop-norm-freedom-day-00007` 成功；旧页中 1 个单元现在由精确证据覆盖。 |
| 13:52:20.952 | 413 | `acct-00007-p07` 使用旧页失败；没有部分 staging，错误仍是通用可重试类别。 |
| 13:52:32.821 | 421 | 重查得到新页；旧页的 19 个剩余单元加 1 个后续单元。 |
| 13:52:47.262 | 431 | 新身份 `acct-00007-p07b` 成功。业务覆盖前进，旧身份失败仍在。 |
| 13:58:12.104 | 656 | 当前 unresolved 单元为 0；这不等于持久操作义务已闭合。 |
| 13:58:26.773 | 665 | finish 在 acceptance 之前拒绝旧 p07 义务。 |
| 13:58:45.626 | 674 | p07 空 decisions 被 schema 拒绝，第二种失败输入耗尽纠正机会。 |
| 13:59:05.779 | 683 | 工具明确 `host-repair-required`、`retryable=false`。 |
| 13:59:16.229 | 700 | 宿主仍因存在成功 drafts 而新建 recovery session。 |
| 14:00:12.957 | 753 | 新 session 再次碰到同一持久禁止重试状态。 |
| 14:00:25.425 | run end | 运行失败，无 batch 53 checkpoint；有效 drafts 和失败历史保留。 |

## 已确认的缺口

1. 宿主恢复判断未读取工具的终止恢复语义和持久义务耗尽状态。
2. 页身份只存在 session 内存中；覆盖变化没有专门错误、差分或同 proposal ID 的恢复说明。
3. 不同身份后继覆盖不能证明旧工作已完成。简单删除失败、空数组、无关成功或泛用 unsupported 都不构成完整覆盖证明。
4. 静态状态文档落后于真实检查点。原文处理、可执行能力、candidate 归档和 closure 是不同状态。
5. 入学事件的 initiator/participation 不一致；射击事件与 schema 的空效果可以相互匹配；活动许可缺少时段/主体范围。这些是独立的世界语义问题，修复 p07 不会自动消除它们。

## 修复约束

保留原始失败和 drafts；覆盖消解必须绑定源哈希、批次、精确旧单元集合及当前有效依赖，并在依赖撤回后重新阻塞。禁止由模型自由裁定旧失败已解决。状态或能力诊断不得写入世界真值；原文独立的验收预期不能从待测 schema 自动复制。真实小说现场不用于写操作重现；使用临时隔离副本和最小合成 fixture。

## 后续授权

用户在深度审计之后明确要求 “record this case and make tech plan split tasks and complete step by step with commit”。这授权本轮记录与代码修复；此前全量编译 guardian 文本保留为历史上下文，不继续把旧轮次的“发现 block 后不改源码”当成本轮修复禁令。
