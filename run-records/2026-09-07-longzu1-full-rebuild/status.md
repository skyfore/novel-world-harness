# 《龙族Ⅰ·火之晨曦》全量候选编译：运行状态

## 2026-09-08 batch 50 恢复协议修复后（当前）

- 有效检查点 50/71：46 个 observation/semantic，executable review 为原序号 47、48、49、52。batch 50 尚未 checkpoint。
- pipeline 34、prompt 31。未重跑真实 LLM 编译；真实审计输入已在隔离副本验证新门禁及正常 finish。
- 已在 compiler lock 内把旧 run 的无效 schema 提案导入持久化失败记录，并作有原文依据及 auditRef 的 unsupported-as-submitted 宿主复核；所有草案、accounting 和检查点保持原样，锁已释放。
- 类型检查和 947 项测试通过。原文审查完成数不代表 executable closure；全书可玩性仍未认证。
- 详见 [obligation-fix-results-2026-09-08.md](obligation-fix-results-2026-09-08.md)。下方为历史状态。

## 2026-09-08 修复后状态（取代下方历史运行状态）

- 原阻塞的 executable batch 52 已在 `2026-09-08T07:41:42.630Z` 通过 finish/checkpoint；本轮验证结束，compiler.lock 已释放。
- 当前版本：pipeline 34、prompt 30。有效检查点 47/71：observation 23、semantic 23、executable 1（原序号 52）。迁移保留前序提取与草案，旧 executable 检查点需要按新契约重新审核。
- batch 52：31 个 accounting proposals accepted，638 个单元中 represented 46、分类投影 592；12 页恢复副本与原决定一致，原 rejected 历史保留。
- 修复涵盖锁恢复、跨阶段覆盖、工具 schema/运行时一致性、accounting-only 完成门禁与 finish 恢复 SOP。
- 尚未完成全书编译或可玩性认证；本次没有新 executable world proposals。
- 最终审计：`run-mtsd1rab-88d6aa4e-293a-458a-9bac-1e23b5eeb54b`。经过一次超时和错误指引修复后的完整处置见 [fix-results-2026-09-08.md](fix-results-2026-09-08.md)。
- 完整类型检查和 941 项测试通过。

## 原运行状态（历史记录，保留）

- 启动时间（UTC）：2026-09-07T09:28:53Z
- 工作目录：`/root/workplace/novel-world-harness`
- 命令：`pnpm dev rebuild --source a28585b1cf867f3e3a16`（恢复执行中）
- 进程：rebuild 运行中（包装 PID 346483；实际 compiler PID 346496；已在 2026-09-07T15:44:13Z 再次核实存活）
- source ID：`a28585b1cf867f3e3a16`（从实际注册结果取得）
- 原文 SHA-256：`a28585b1cf867f3e3a1679a09558658338637efd2f0bf15e8d5878b7f9e44fe0`
- Git commit：`44669a83e49f031eb67ca68a4a61cc188b510a07`
- 工作树：仅有本运行记录的未跟踪守护 prompt；未改动编译源码
- 版本契约：prepared V4；world schema V3；engine 0.4.0；storage v3；cache V3；canonical snapshot V9；pipeline 33；prompt 29
- Pi 模型：项目既有 Pi 默认配置；未传入 `--model` 覆盖。实际 provider/model 待由运行工件确认。
- 日志：`ingest.log`（退出码 0）、`rebuild.log`（运行中）
- 阶段：observation 23/23 已完成；semantic 已检查点至 batch 37/71；当前 semantic batch 38/71（2724–3024）；executable/boundary 尚未开始。
- 最近成功检查点：semantic batch 37/71；21 个 active proposals 待后续确定性收敛。
- 当前问题：batch 35 的 `铜罐` 精确名称 trace 失败已按有限 recovery SOP 修复并通过 finish handshake；无当前 blocker。
- candidate revision hash：无
- 实际用量：请求/token/费用尚未由可审计运行产物提供，标为未知；不估算。

## 预检事实

1. `pnpm dev doctor` 通过：Node 22.19.0、pnpm 11.21.0、工作区和用户级运行目录可读写，Pi 管理的认证可用；未记录或输出密钥。
2. 预检时 `pnpm dev novels` 显示没有注册小说；已执行 ingest 并以退出码 0 完成。`status` 证实 23 个 evidence segments、prepared cache 缺失、0 个 completed batches。
3. 启动 ingest 前没有发现本工作区存活的 NWH/Pi 编译进程、锁、repair journal 或 checkpoint；ingest 后再次检查亦无遗留写锁。
4. 不可变源副本 `/root/.novel-harness/sources/v1/a28585b1cf867f3e3a1679a09558658338637efd2f0bf15e8d5878b7f9e44fe0/source.utf8` 存在、只读，且其 SHA-256 与原文相同。
5. observation batches 1–3 均已通过 finish barrier；各批次出现的草案替换均由模型调用项目的 `withdraw_compiler_proposal` 后重新 `finish_compiler_batch`，无人工跳过、无手改 checkpoint。
6. 2026-09-07T15:29Z 恢复 batch 35：保留该批所有 active drafts，在新 host-started turn 中发现并读取 annotation、提交精确 `铜罐` mention 的 identity resolution，首次实际修正后的 finish handshake 成功。原始 `黄铜罐` mention 未被错误当作精确名称 trace。
