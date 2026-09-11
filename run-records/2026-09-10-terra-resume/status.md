# Terra 续编启动记录

- 授权：用户要求“继续编译”。
- 2026-09-10 原宿主只读核验：旧 PID 804373 不存在，hostname/boot ID/PID namespace 与锁记录一致。通过 `compiler-lock recover --owner-token` 归档旧锁，未删除草案或改写检查点。
- 旧锁归档：`/root/.novel-harness/workspaces/v1/novel-world-harness-96fd81aa9a7d/locks/recovered/compiler-bc6ec1a0-c192-464a-9299-19ee6107966a.lock`。
- 新进程由临时 systemd 服务 `nwh-terra-20260910.service` 托管；Restart=no，不自动重试失败。服务保存退出结果，日志独立写入本目录 `rebuild.log`。
- 命令：`node --import tsx src/cli.ts rebuild --source a28585b1cf867f3e3a16`，使用 Pi 保存的默认模型，无命令行模型覆盖。
- 新审计：`run-mtuxcwle-8d73e495-0c0f-4867-a7ce-448df672392c`，启动于 2026-09-10T02:45:12.578Z。
- 2026-09-10T02:45:21.833Z：57/71 已完成，第 58 批（原文 2046–2342 行）进行中，无 unresolved obligations。首请求已记录 `openai-codex/gpt-5.6-terra`，thinking=medium。
- 宿主 systemctl 核验：MainPID=857282，ActiveState=active，SubState=running。启动时的 Result=success/ExecMainStatus=0 不是编译完成证明。
- 后续以 `status --json`、本目录日志及 `systemctl show nwh-terra-20260910.service --property=ActiveState,SubState,MainPID,Result,ExecMainStatus` 为准；这是启动快照。
