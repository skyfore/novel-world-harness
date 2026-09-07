# 《龙族Ⅰ·火之晨曦》全量候选编译：运行状态

- 启动时间（UTC）：2026-09-07T09:28:53Z
- 工作目录：`/root/workplace/novel-world-harness`
- 命令：`pnpm dev rebuild --source a28585b1cf867f3e3a16`（待执行）
- 进程：rebuild 运行中（包装 PID 299191；实际 compiler PID 299220；workspace compiler lock owner=299220）
- source ID：`a28585b1cf867f3e3a16`（从实际注册结果取得）
- 原文 SHA-256：`a28585b1cf867f3e3a1679a09558658338637efd2f0bf15e8d5878b7f9e44fe0`
- Git commit：`3cf6287e094fdcb7b7e7dbb52d1b8f8b61d0a034`
- 工作树：预检时干净
- 版本契约：prepared V4；world schema V3；engine 0.4.0；storage v3；cache V3；canonical snapshot V9；pipeline 33；prompt 29
- Pi 模型：项目既有 Pi 默认配置；未传入 `--model` 覆盖。实际 provider/model 待由运行工件确认。
- 日志：`ingest.log`（退出码 0）、`rebuild.log`（运行中）
- 阶段：observation 3/69 已完成、66 个待完成（当前 observation batch 4/69）；semantic 0/未知；executable 0/未知；boundary 0/未知
- 最近成功检查点：observation batch 3/69（335–692 之前；34 个 active proposals 待后续确定性收敛）
- 当前问题：无
- candidate revision hash：无
- 实际用量：请求/token/费用尚未由可审计运行产物提供，标为未知；不估算。

## 预检事实

1. `pnpm dev doctor` 通过：Node 22.19.0、pnpm 11.21.0、工作区和用户级运行目录可读写，Pi 管理的认证可用；未记录或输出密钥。
2. 预检时 `pnpm dev novels` 显示没有注册小说；已执行 ingest 并以退出码 0 完成。`status` 证实 23 个 evidence segments、prepared cache 缺失、0 个 completed batches。
3. 启动 ingest 前没有发现本工作区存活的 NWH/Pi 编译进程、锁、repair journal 或 checkpoint；ingest 后再次检查亦无遗留写锁。
4. 不可变源副本 `/root/.novel-harness/sources/v1/a28585b1cf867f3e3a1679a09558658338637efd2f0bf15e8d5878b7f9e44fe0/source.utf8` 存在、只读，且其 SHA-256 与原文相同。
5. observation batches 1–3 均已通过 finish barrier；各批次出现的草案替换均由模型调用项目的 `withdraw_compiler_proposal` 后重新 `finish_compiler_batch`，无人工跳过、无手改 checkpoint。
