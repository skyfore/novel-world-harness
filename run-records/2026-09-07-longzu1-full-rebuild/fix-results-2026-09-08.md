# 《龙族》block 修复及真实验证结果

截至 2026-09-08T07:41:42.630Z，原阻塞的 executable batch 52 已通过 finish 并保存检查点，compiler.lock 已正常释放。本次没有启动全书调度或发布候选世界。

## 实现

1. `nwh compiler-lock inspect/recover`：owner token 核验、宿主/boot/PID namespace 核验、Linux flock 串行化恢复、死 PID 复核、归档旧锁及恢复记录；拒绝存活 owner 和不可信进程视图。旧 owner 无宿主信息，必须在原宿主核实后显式 attestation。没有自动夺锁或删锁捷径。
2. `rebuild` / `compile-source` 在 SIGINT/SIGTERM 时合作取消，沿 finally 清理 session 和释放锁。不可捕获的进程/宿主失效仍走显式锁恢复。
3. executable accounting 继承同一 source、同一证据片段、已 checkpoint 的前序阶段精确覆盖。当前 annotation refs 与未歧义的 pending world proposal assertions 参与投影；不读取 rejected 证据、不把其他片段或未完成阶段提升为覆盖、不把 mention 提升为执行能力。
4. pipeline 34 保留 pipeline 33 的 observation/semantic 检查点及草案历史，重新审核 executable 阶段。旧 pending accounting 中被新增前序覆盖替代的单元仅在投影中跳过，原草案不被直接改写。
5. 完成输出分开统计 world / annotations / resolutions / accounting。accounting-only complete 若仍有 proposal failure，宿主拒绝 checkpoint，不能掩盖执行提案失败。无失败但只有 accounting 的批次可以记录审核进度，不能据此认证可玩性。
6. CLI 编译默认启用独立 TraceRecorder/Pi trace，记录工具结果、finish 诊断和运行结局；不复用跨证据边界的模型会话。prompt fingerprint 升至 30。
7. execution binding 的 action schema 直接使用 schema-bound 结构，替代只在运行时起效的 union refine。模型看到的 JSON Schema 不再包含不允许的 ad-hoc 分支；新增 envelope 层级和机制 discovery 的有限恢复 SOP。
8. accounting finish 的 no-artifacts 冲突提前按片段诊断，要求修正 reviewed_segments.disposition，保留有效页；accounting 诊断优先于泛化 offset 分类，不再要求对 finish 传 offset。
9. 增加宿主专用的 `SourceAccountingStore.reproposeRejected`：对已审计的错误撤回，用新 ID 重提相同 source/batch 的原决定并记录 restoredFrom；原 rejected 历史保留，新副本仍必须通过正常 finish。

## 真实验证发现与处置

### 遗留锁

在非沙箱宿主 PID namespace `pid:[4026531836]` 中确认原 PID 346496/346483 不存在。先保存完整工作区备份：

`/tmp/nwh-longzu-before-block-fix-20260908.tar.gz`

随后通过新命令恢复。旧锁及 owner 信息归档于：

`/root/.novel-harness/workspaces/v1/novel-world-harness-96fd81aa9a7d/locks/recovered/compiler-147a15c3-bcab-4348-a669-cadf620c94d0.lock`

原进程消失的触发原因仍无证据，不归因为 OOM 或 SIGKILL。

### batch 51 诊断切片

审计：`run-mtsc7r3l-6d0cf25b-c424-4bf2-ae2f-530d93ac9352`；日志：`block-fix-smoke.log`。

- 覆盖继承后，review 从 0 evidenceSpans / 0 annotationSpans 变成 45 / 52，保留的模型分类从 203 条变成 151 条。
- 捕获 10 次 event-execution 工具失败：先把 evidence_segment_ids/evidence_selectors 错放到 payload 内；修正外层结构后，ad-hoc action 又被运行时拒绝。
- 确认 provider JSON Schema 与运行时 refine 不一致，随即修正为结构化 schema-bound 限制，并补测试及具体 SOP。
- 该诊断回合在完成门禁修复前以 accounting-only finish 取得过检查点。最终门禁应拒绝这一结局，因此通过受 compiler lock 保护的 CompilerBatchStore.markIncomplete 撤销该单批检查点；没有修改其世界提案，也没有将该回合当作执行闭合成功。

### batch 52 中间验证

审计：`run-mtscfy68-6256d05e-4859-4fbf-a5e3-5d3a5ede9369`；日志：`block-fix-batch52.log`。

- 从旧 p01–p12 接续到 p31，完成剩余逐句分类。
- finish 把“没有新的机制”误写为 segment no-artifacts，暴露了宿主错误指引：建议撤回已分类页；分页提示中的 offset 又触发错误的通用恢复类别。
- 模型依照旧指引撤回了 p01–p12；数据仍在 rejected 历史。本回合 10 分钟超时取消，无 batch 52 检查点，锁正常释放。
- 修正上述两项宿主诊断；使用类型化 API 将 12 页精确重提为 `acct-00006-p01-restored` 至 `p12-restored`，每页带 restoredFrom。p13–p31 保持不动。恢复审计：`run-mtsd1fkp-3ea5e2ef-33bf-460d-b244-0420ff06b78e`。
- 上述撤回和恢复均如实记录；不是悄悄把 rejected 文件改回 pending，也不是删除错误历史。

### batch 52 最终验证

审计：`run-mtsd1rab-88d6aa4e-293a-458a-9bac-1e23b5eeb54b`；日志：`block-fix-batch52-recovery.log`。

- 原文单元 638，其中前序精确覆盖 represented 46，模型分类投影 592，未覆盖单元 0。
- 31 个 accounting proposals accepted，其中 12 个 restored 副本的 decisions 与原 rejected 提案逐项完全一致；accounting pending 为 0。
- 该 review 记录 9 个 evidenceSpans、60 个 annotationSpans，segment disposition 为 proposed。
- 新宿主回合 32 秒完成 finish；本回合工具错误 0。
- batch 52 已 checkpoint，compiler.lock 不存在。

## 最终状态与边界

pipeline 34 当前有效检查点为 47/71：observation 23、semantic 23、executable 1（原序号 52）。旧 51/71 不再直接表示升级后的有效完成率；前五个 executable 批次需要在新覆盖/完成契约下重新审核，已有原文提取和草案历史均保留。

本次验证没有产生新的 executable world proposals，也没有证明全书已完成、候选闭合或世界可玩。事件精确身份、source evidence、执行机制和世界提交约束均未放宽。

验证：完整 `pnpm run check` 通过；完整 `pnpm test` 通过（163 个测试文件、941 项测试）。覆盖竞争恢复、活 owner/异 namespace 拒绝、SIGTERM 释放、跨阶段及跨批次覆盖、旧草案恢复与 finish、完成门禁、模型可见 action schema 和错误恢复指引。
