# Web UI MVP 验收矩阵

状态：已实现，作为发布前回归门禁

日期：2026-08-30

本矩阵把 [`web-ui-mvp-design.zh-CN.md`](./web-ui-mvp-design.zh-CN.md) 的验收标准逐项映射到生产代码和自动化测试。它只声明本地单用户 MVP 已完成，不把“任意长篇小说的模型解析质量”或 Phase 3 扩展能力包装成已经解决的问题。

## 用户需求闭环

| 用户能力 | 生产实现 | 自动化证据 | 结论 |
| --- | --- | --- | --- |
| 浏览器完成小说注册、解析/继续解析、proposal 审核与收敛 | `SourceApplicationService`、`PreparationApplicationService`、`ProposalApplicationService`；`/novels/new` 与 `/novels/:sourceId/compile` | `web-compiler-service.test.ts`；`web-mvp.spec.ts` 的 register → compile all → accept | 完成 |
| 创建世界实例、选择全部有证据角色入口、Play、继续历史会话 | `PlayApplicationService.startFreshPlay` 原子创建 instance + session；小说页从 frozen base 选角色，instance 页明确只继续已有历史 | `character-entry-play.test.ts`、`web-play-service.test.ts`、`play-session-v2.test.ts`；真实 Chromium 流程覆盖 opening、choice、自由动作、reload/continue | 完成 |
| 新会话、新时间线与单写者约束 | 每次小说页 Web Play 都创建独立 branch/session/conversation；相同或不同角色均不复用已有世界；较晚角色从 prepared checkpoint 创建 sibling branch；同一 branch 仍仅一名 active writer | `character-entry-play.test.ts` 验证同角色双开、base 哈希一致且提交互不影响；`play-conversation.test.ts`、`play-session-v2.test.ts` | 完成 |
| 小说化开场与第三人称输出 | pinned reader prelude 只进入 step-zero 最终 narrator；choice/action/NPC/world 均不可见；正文强制 focalized third-person，对白可自然使用“我/你” | `character-entry-play.test.ts`、`play-opening.test.ts`、`pi-player-opening.test.ts` | 完成 |
| 模型、事件、地点、规则、provenance 图谱 | 一个 `OntologyProjectionService` 派生五类 typed-property-graph；Cytoscape 图、筛选表格和证据 inspector 共用服务端 projection | `web-ontology-projection.test.ts`；Chromium 流程检查五个入口、future layer、表格与原文证据 | 完成 |
| 查看每个 Play 的全部 LLM/Tool/Context/Time/Response | append-only run/span/call/tool ledger；semantic parts、logical messages、redacted provider payload、response、usage/timing、world effects 与 context diff | `pi-trace.test.ts`、`trace-store.test.ts`、`trace-service.test.ts`、`web-trace-model.test.ts`；Chromium 逐 tab 验收 | 完成 |
| 模型/provider 设置仍使用 Pi | Web 模型目录、write-only API key、OAuth/device/manual prompt、按角色 profile；实际调用仍经 `PiAgentSession` 与 Pi runtime | `web-model-settings.test.ts`、`pi-trace.test.ts` | 完成 |
| clear/new/continue/archive/restore/remove 等基础能力 | transcript clear 不改世界；session remove 只删 presentation；instance/novel removal 先展示 effect manifest；历史 session 在 branch 删除后 detached 且可读 | `web-play-service.test.ts`、`play-session-v2.test.ts`、`web-maintenance-service.test.ts`；Chromium 覆盖 archive/restore/activate/clear/remove/preview | 完成 |

## 设计验收标准

### Play 与一致性

| 验收点 | 对应机制与测试 |
| --- | --- |
| 重复 `clientRequestId` 不产生第二次提交 | 长操作 `OperationManager` 与短命令 `WebMutationJournal` 都持久化 request fingerprint；同 ID/异 body 冲突。见 `web-operation-manager.test.ts`、`web-mutation-journal.test.ts`、`web-play-service.test.ts`。 |
| head 冲突不会静默提交 | 每次 move 在启动前和执行时校验 `expectedHead`，返回 `BRANCH_HEAD_MOVED` 与一次 refresh SOP。见 `web-play-service.test.ts`。 |
| commit 前取消不改变 world truth | Abort 在 deterministic commit boundary 前终止，head 与 presentation 保持不变。见 `web-play-service.test.ts`。 |
| commit 后 Stop 不回滚或重放 | operation 标出 commit boundary；世界提交保留，只开放经 trace/head 校验的 narration-only retry。见 `web-play-service.test.ts`。 |
| 浏览器刷新不中断后台动作 | operation 在页面之外运行，SSE cursor + authoritative HTTP snapshot 恢复观察；Chromium 在 move 后 reload 并继续同一 session。 |
| 高频流式输出不冻结界面 | 生产 UI 在 React 外按 animation frame 折叠 SSE delta；`web-narration-stream-store.test.ts` 证明 320 次 append 只产生一次帧通知，Chromium 随后继续完成 action、reload 与 trace 检查。 |

### Trace 与可核验性

| 验收点 | 对应机制与测试 |
| --- | --- |
| LLM、tool、retry 数准确 | Pi lifecycle extension 把一次 provider request 定义为一个 call，并用稳定 `callId/toolCallId/spanId` 聚合 manifest 计数。见 `pi-trace.test.ts`、`trace-store.test.ts`。 |
| 上下文不是事后拆 prompt | adapter 在组装时产生 semantic context parts；同时保留 final logical messages 与 provider-serialized payload/hash。见 `pi-trace.test.ts`、`trace-service.test.ts`。 |
| 父子关系不依赖写入时序 | ledger 依据显式 span parent 构树。见 `web-trace-model.test.ts`。 |
| 世界链路完整 | run 链接 previous/final head、event hash、audit、player move 与 presentation message；story time 和 wall time 分开显示。见 `web-play-service.test.ts`、`trace-service.test.ts`。 |
| Trace 不成为世界真相 | recorder 只写 observability store；recovery 只追加 diagnostic/修复 observation link，不调用 world commit。见 `play-trace-recovery.test.ts`。 |
| secret 不跨越可观察边界 | TraceStore、OperationManager、WebEventBroker 与 HTTP error handler 均有最终脱敏；包含 API key 的登录 request body 不会被持久化或广播。见 `trace-store.test.ts`、`pi-trace.test.ts`、`web-model-settings.test.ts`、`web-operation-manager.test.ts`、`web-foundation.test.ts` 以及 Chromium canary。 |

### Ontology 与世界真相

| 验收点 | 对应机制与测试 |
| --- | --- |
| 五个视图来自同一投影服务 | model/events/places/rules/provenance 只读同一 canonical/world stores，不存在 Web 图数据库。见 `web-ontology-projection.test.ts`。 |
| 无 dangling edge，可回到 revision/evidence | projection 只输出端点均在 scope 内的边；node detail 返回 revision identity 与 source excerpt。见 `web-ontology-projection.test.ts`。 |
| future canon 不泄漏进 branch truth | 默认隐藏；显式打开后只在独立 possibility/future layer 展示。见 `web-ontology-projection.test.ts` 与 Chromium 验收。 |
| `atCommit` 是祖先时刻投影 | 服务端验证 branch ancestry，并按该 commit 投影规则、空间关系与状态；非法 commit 返回有界 recovery。见 `web-ontology-projection.test.ts`。 |

### 崩溃恢复与危险操作

| 验收点 | 对应机制与测试 |
| --- | --- |
| server restart 后长操作可解释 | 未终止 operation 原子转为 `interrupted`；跨过 commit boundary 的操作明确禁止原样重放。见 `web-operation-manager.test.ts`。 |
| 短命令 unknown outcome 不被重放 | orphan mutation 变为 `MUTATION_INTERRUPTED`，必须刷新权威 snapshot 并使用新请求。见 `web-mutation-journal.test.ts`。 |
| 中断 player move 可对账 | 启动时校验 content-addressed turn audit、immutable ancestry、branch head 与 presentation links；歧义保持 unknown。见 `play-trace-recovery.test.ts`。 |
| remove/reset 的影响可预览 | 服务端生成精确 effect manifest/hash，执行时重新计算并拒绝 stale preview；immutable source bytes 与 trace 保留。见 `web-maintenance-service.test.ts`、`web-foundation.test.ts`。 |

## 发布门禁

每次 Web MVP 发布至少执行：

```bash
pnpm run check
pnpm test
pnpm test:e2e
```

本次验收结果：TypeScript 三套工程检查通过；Vitest 130 个测试文件、734 个测试通过；production Fastify host + Chromium 完整旅程通过。

`test:e2e` 会构建生产 server 与 SPA，并让真实 Chromium 走完整浏览器旅程。浏览器测试在模型输出点使用确定性 adapter，避免网络和费用让验收不稳定；Pi 的真实生命周期、最终 request 序列化、tool/retry/usage 捕获则由独立 conformance tests 覆盖。两者共同证明“浏览器业务闭环”和“底层仍为 Pi”这两个不同边界。

## 明确保留到后续迭代

- 任意体量、题材小说的解析质量基准与模型调优；MVP 保证工作流和可审计性，不保证语义抽取已经达到产品终态。
- Phase 3 的大图 neighborhood/pagination/cache、trace retention/export、OpenTelemetry exporter、高级 branch/context diff 与移动端适配。
- 多用户、远程部署、账号/RBAC、云同步和外部数据库。
