# 能力闭环分段实施记录

对应 [Review 落地设计](2026-09-16-review-to-capability-closure.zh-CN.md)。本文件区分每个已提交增量与整个 P1–P7 目标；未完成项不能由局部测试通过推导为完成。

## 提交与进度

| 阶段 | 交付 | 状态 |
| --- | --- | --- |
| 设计基线 | `7078f4c`，方案与前序核验记录 | 已提交 |
| P1a 独立场景要求的持久约束 | `52f72ee`，requirement ledger、注册/查询命令、canonical 重评、冻结快照/恢复/closure/certification 接线 | 已提交；1038 项测试与类型检查通过 |
| P1b 逐能力报告与批次尝试 | `fb4c738`，新 reconciliation 计划冻结 ontology/development/driver 项；finish v2 绑定计划与报告；逐要求保留 deferral | 已提交；1040 项测试与类型检查通过 |
| P1c 归档与快照中的义务保留 | 当前/历史 finish 统一读取、历史宿主复核、候选认证和恢复前置检查 | 实现完成；1044 项测试与类型检查通过；本记录随该段提交 |
| P1 后续完整结算 | 核心角色的独立要求分母、上述结构性修复要求与统一 ledger/evaluator 的消费连接、跨 reparse 的完整义务恢复 | 未完成；P1 整体仍进行中 |
| P2–P7 | 受限修复、语义获知、本体、文学/工作集、自主推进、完整体验验收 | 未完成 |

## P1a 的实际行为

`review-scenes --spec <file>` 保持只读、允许 pending overlay 的诊断行为。新增宿主入口：

```sh
nwh review-scenes --spec independent-scenes.json --register opening-scenes
nwh requirements inspect --source SOURCE_ID
nwh review-scenes --spec revised-scenes.json --register opening-scenes --predecessor EXACT_REVISION_HASH
```

注册在 compiler lock 内执行，先核对注册源的 hash 和每个 exact anchor，再持久化要求。注册入口只接收独立场景规格，不接收模型自报 satisfied。注册时可不满足要求：这种情况保留要求及 blocked/unknown/unmapped 结果，CLI 退出 2。

要求保存于 `worldStorageRoot(root)/compiler/requirements/<sourceId>/`。每个 JSON 记录带 sequence、前驱 hash 和内容 hash，head 原子发布完整链；缓存不是结算依据。原定义和评估记录不删除。同 ID 修改必须显式提供前驱 revision 与审阅依据；换 repair namespace 不会创建新的要求身份。删除 head、缺失已发布记录、坏 hash 均失败并保留原状态，需要宿主检查，不能重置账本后续跑。首次发布在 record 写完而 head 未写完时中断也进入该宿主检查路径；本段没有提供自动重建缺失 head 的权限。

`prepare-all` 在收敛后按 canonical catalog 重评，在发布前要求所有已注册 mandatory requirements 满足。没有 pending 提案参与结算。有效 catalog 或定义版本变化时，旧结果不能复用。只成功的 state-effect 不会清除同场景缺失的 agency/mechanism。

快照保存完整定义修订链，评估作为派生 readiness 结果保存，避免 subject hash 自引用。认证重新读取不可变原文、运行独立场景探针；后续激活/恢复/Play 的同步检查还会重新执行确定性探针，拒绝伪造的 satisfied、遗漏子要求和旧 catalog 结果。当前其他 roster、source accounting、semantic support、quality 门仍保留。

恢复时先验证要求历史，再进行任何世界材料化。新工作区可恢复完整定义链；旧快照不得清掉已有工作区的新增或修订要求，需使用隔离工作区。冻结的旧 bundle 本身不被新注册改变。

这是**已注册独立场景要求**的完整消费链，还不是所有核心角色的要求发现器。未注册独立规格的旧 snapshot 保持原认证路径；下一段 P1b 必须补齐要求分母、逐角色义务与 finish 尝试绑定，不能将这个兼容分支解释为完整 P1。

## 验证

针对性测试 `test/requirement-ledger.test.ts` 的 8 项通过，覆盖部分成功、重启/幂等、前驱修订、真实坏 finish 不改 canonical、pending/finish 不结算、converge 后结算、缺 head/记录及篡改、冻结快照与恢复拒绝。测试使用原创短文本，未调用真实 provider 或修改用户小说运行数据。

`pnpm test --maxWorkers=2`：180 文件、1038 tests 全部通过（70.68 秒）。`pnpm check`：服务端、Web 和 E2E TypeScript 检查全部通过。`git diff --check` 通过。P7 的真实模型和双人体验评价未执行。

## P1b：部分修复报告协议

新 reconciliation plan 为 v3，保存稳定的 `target:capability` ID。角色缺口分为 ontology、development、opening-driver；现有 event/initial-world 保留各自的待复核项。新计划只冻结已发现的工程缺口，不把它们谎称为独立来源审阅的全书能力分母。

`target_reviews[].requirement_reviews` 对每个冻结要求恰好报告一次 proposed/unsupported/capability-gap。目标层可因已有 goal 保持 proposed，但 ontology 等子项必须保留自己的未完成状态；部分成功不能只写 summary。各 capability 的 proposed 必须有对应类型的有效提案，空 action 或无时间边界的静态愿望不能作为 driver/development 提案工作。

finish identity v2 保存计划 hash 和要求列表，原始 input 冻结子报告。恢复时重读原计划并验证版本；计划被改写、缺失或变换作用域会明确停止。旧 v2 计划及 v1 finish 保持可读，不原地补造子要求。

宿主 deferral 复核对每个未完成的 requirement ID 独立记原因及 audit ref；仅复核其角色 target 不能覆盖这些项。重启和换 namespace 不会清除尚存 finish 回执中的未复核项。`reconciliationAuditResults` 对仍 unresolved 的 target 不再显示 `hostReviewRequired=false`。

复核通过只表示宿主读过缺口，不能作为 semantic satisfied 或发布证据。将这些结构性发现与 P1a 的独立场景/角色评估统一，并在 reparse 归档回执后继续保留全量义务，仍是 P1 的下一项工作。

本段验证：`pnpm test --maxWorkers=2` 的 180 文件、1040 tests 全部通过（70.16 秒），`pnpm check` 全部通过。新增回归包含只提交 goal 的真实 finish、逐能力 deferral、全局比例改善后的计划复用、原计划 hash 被篡改时恢复拒绝，以及宿主不能用整个角色的单条 review 清掉多个能力义务。

## P1c：归档不清除义务

发布检查现在同时读取当前回执与 `finish-receipts/<source>/history/` 的历史回执，校验源、batch 路径、fingerprint、归档原因和生命周期一致性。重建、换 namespace、同 batch 的新工作不能覆盖历史 deferral。原归档格式不变，也不复制出另一套可写世界状态。

显式归档的 prepared/completed 尝试可以按原 fingerprint 做宿主来源复核。复核验证原文 hash，但不要求历史工件仍是 active revision，也不重放旧 proposal。当前未完成的 prepared 回执仍不能当 completed 复核。复核只记录流程责任，不证明语义已经成立。

候选的 compilerSnapshot 保存待复核项与既有决策，认证检查每个源和精确要求身份。恢复首先验证不能丢弃本地义务或撤销已记录的复核，然后只导入历史回执，不重新激活旧 finish。坏 scope 在世界材料化之前被拒绝。

验证：181 文件、1044 tests 通过（`pnpm test --maxWorkers=2`，70.65 秒）；`pnpm check` 通过。新增测试覆盖 prepared/completed 归档、换 batch 后的旧缺口、篡改归档、历史导入、无重放、真实候选认证及恢复前拒绝。角色独立分母及结构性要求的语义结算仍待下一段完成。
