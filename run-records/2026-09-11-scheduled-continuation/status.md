# 一次性定时续编

- 用户指定：北京时间 2026-09-11 03:15 后继续后续编译。
- 时间：2026-09-10 19:15:00 UTC = 2026-09-11 03:15:00 Asia/Shanghai。
- 主机 systemd timer：`nwh-opening-20260911.timer`，一次性绝对日期，AccuracySec=1s，Persistent=true（错过时在主机恢复且定时器激活后补执行）。
- 执行服务：`nwh-opening-20260911.service`。使用 `openai-codex/gpt-5.6-terra`，思考级别沿用 Pi 默认。Restart=no，不无限重试额度错误。
- 命令沿用 `rebuild --source a28585b1cf867f3e3a16`，从已有编译状态继续；当前 71/71 审查检查点已完成，待开局状态生成及候选归档等后续处理。正常编译锁阻止并行写入，不强行清理他人的锁。
- 执行日志：本目录 `rebuild.log`（执行时创建）。服务退出状态由 systemd 保存。
- 定时器是主机任务，未创建应用内 automation，也未配置消息通知。
- 核查：`systemctl list-timers --all nwh-opening-20260911.timer`；执行后查看对应 service 的 Result/ExecMainStatus 和日志。
