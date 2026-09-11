# 已收敛分片续跑修复

完成记录 state=completed，而所有世界提案已经从 pending 转为 accepted 时，原恢复逻辑仍重新执行 finish，因活动提案为空误报阻塞。

修复对无元数据副作用的纯世界提案完成记录增加已收敛验证路径：验证来源、完成记录及原依赖包；确认全部提案已接受、当前规范产物与原 payload 完全一致、冻结批次没有新增 pending 工作，然后确认已完成，不重放 finish。依赖消失、拒绝、产物改变仍要求主机审查。prepared、尚未收敛、标注/解析/核算/元数据等其他情形保持原有恢复路径，尤其不重新激活被替代的身份解析。

新增测试覆盖 finish → convergence → 命令重启，使用不存在的模型验证没有开启模型会话，同时检查无重复接受、完成记录未变；另外验证当前产物变化、已接受依赖被移走时仍阻塞。

全量170个文件998项测试通过，pnpm check通过。真实第1、2图裁定分片在锁内验证成功，无需模型调用。

CLI增加 --candidate-only，可用标准命令连续完成后续准备、验证与候选归档，不发布Play：

```sh
node --import tsx src/cli.ts prepare-all --source a28585b1cf867f3e3a16 --yes --candidate-only --model openai-codex/gpt-5.6-terra
```

后台服务 nwh-prepare-continue-20260911.service 执行上述命令；Restart=no。运行日志为 resume.log。修复与续跑不意味着最终候选已经通过审查。
