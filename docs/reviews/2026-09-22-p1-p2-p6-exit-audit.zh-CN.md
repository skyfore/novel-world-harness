# P1 / P2 / P6 退出审计与待办总账

审计日期：2026-09-22。代码基线：`8747e3431f8c06ea3476a5dcaaf851094d7de904`，tree：`42173b07357a679d1fb025aebe783dbeace52751`。初次审计只修改文档；后续 A1 增加验收测试；用户随后明确授权完成 A2–A6，包括必要实现。以下当前结算包含该工作树增量，尚未提交。未修改用户小说记录或降低验收门槛。

## 结论与判定口径

第一工作包及追加授权的 A1–A6 已完成。P1、P6 的本表工程退出范围通过；P2 的最小修复范围及本次登记的有限扩展通过。通用语义修复、全部迁移场景和 P7 真实体验仍不在已完成范围内。

退出要求来自 [Review 落地设计 §3–4、§7–8](../plans/2026-09-16-review-to-capability-closure.zh-CN.md)，并保留 §8 的共同验收约束。下表中：

- **已核实**：源码消费路径和对应断言均存在，工程结果见本文验证记录；只核销该行的有限范围。
- **部分**：主体已有实现，但原要求的完整场景或串联证据不足。
- **开放**：有明确未实现能力，或尚无足以关闭的证据。

不能从测试总数、模型报告 proposed、finish completed 或工具成功反推能力 satisfied。文中的源码、测试链接相对本文件，基线固定后可按测试名称检索，不依赖易漂移的行号。

| 阶段 | 当前结算 | 不能整体关闭的原因 |
| --- | --- | --- |
| P1 义务纵向闭环 | 本表 P1-01–08 工程范围通过 | 包含两来源关键链；既有有效证书的全部替换故障窗口与通用迁移不由此推导 |
| P2 最小上游修复 | 最小范围及 A2–A4 登记扩展通过 | 支持角色 typed binding、单 mention 决议后继修订、新获知联通；事件拆分／合并、无 typed path 和未注册语义模块仍转宿主，不能视为通用修复器 |
| P6 自主与偏离 | 本表 P6-01–07 工程范围通过 | A5 两来源贯通真实 runtime、fork、resume 与完整投影重放；不代替 P7 人工体验 |

## P1：要求、尝试、结算与历史

| ID | 原退出条件／契约 | 实现与测试证据 | 判定与边界 |
| --- | --- | --- | --- |
| P1-01 | 只修 goal，不能顺带结算 ontology / opening-driver | [reconciliation-review.ts](../../src/compiler/reconciliation-review.ts)、[core-role-capabilities.ts](../../src/compiler/core-role-capabilities.ts)；[reconciliation-review.test.ts](../../test/reconciliation-review.test.ts) 的 `does not let a goal proposal account for ontology` 及真实 finish 测试；[core-role-capabilities.test.ts](../../test/core-role-capabilities.test.ts) 分别评估三能力 | 已核实；A1 两场景新增真实静态 goal 提案与独立角色结算，ontology/driver 仍 blocked |
| P1-02 | restart、namespace、覆盖率改善不消除义务 | [requirement-ledger.ts](../../src/compiler/requirement-ledger.ts)、[reconciliation-review-ledger.ts](../../src/compiler/reconciliation-review-ledger.ts)；[reconciliation-review.test.ts](../../test/reconciliation-review.test.ts) 中 coverage 改善后保留原计划／deferral；[reconciliation-history.test.ts](../../test/reconciliation-history.test.ts) 中 replacement batch、archive、restore | 已核实；scope reduction 必须有显式审阅，不视为完成旧义务 |
| P1-03 | 坏 finish 不改变 canonical；pending / finish 不等于 satisfied | [requirement-ledger.test.ts](../../test/requirement-ledger.test.ts) 的 `settles only committed active artifacts after the real proposal, finish and convergence chain` 明确比较坏 finish 前后的 canonical、receipt，并在 converge 后才消除 issues | 已核实；A1 补坏 finish 的 canonical／pending／receipt 比较和禁止新增 active；已有有效 publication 的全部故障窗口仍不由此推导 |
| P1-04 | 独立角色分母、定义修订与审阅迁移保留历史 | [core-role-requirement-service.ts](../../src/compiler/core-role-requirement-service.ts)、[role-review-revision-service.ts](../../src/compiler/role-review-revision-service.ts)；[core-role-requirement-ledger.test.ts](../../test/core-role-requirement-ledger.test.ts)、[role-review-revision.test.ts](../../test/role-review-revision.test.ts) 的显式范围缩减、双审、旧记录与指针恢复 | 已核实；不再把“角色定义持久化／旧审阅修订”列为未实现 |
| P1-05 | 尝试绑定原定义／回执；converge 后逐项结算；中断只补账 | [requirement-attempts.ts](../../src/compiler/requirement-attempts.ts)、[core-role-requirement-service.ts](../../src/compiler/core-role-requirement-service.ts)；[prepare-role-requirements.test.ts](../../test/prepare-role-requirements.test.ts)、[core-role-requirement-ledger.test.ts](../../test/core-role-requirement-ledger.test.ts) 的 `recovers post-convergence settlement without replay`、superseded proposal 测试 | 已核实；settlement 不是对某次模型修复因果贡献的证明 |
| P1-06 | 输入变化使旧结果 stale；正常接受与 metadata 写入不能继承旧成功 | [requirement-observation.ts](../../src/compiler/requirement-observation.ts)、converge、proposals、role-review-revision 宿主接线；[core-role-requirement-ledger.test.ts](../../test/core-role-requirement-ledger.test.ts)、[role-review-revision.test.ts](../../test/role-review-revision.test.ts) 的失效中断恢复 | 已核实到领域入口；直接底层 store 写入不自动追加编译账本，需宿主 refresh，认证仍重算；不建议向 reducer 注入编译账本写入 |
| P1-07 | 完整历史随候选冻结／恢复；伪造 satisfied 和旧候选回滚不能过关 | [prepared-cache.ts](../../src/compiler/prepared-cache.ts)、[certification.ts](../../src/compiler/certification.ts)；[requirement-ledger.test.ts](../../test/requirement-ledger.test.ts)、[core-role-requirement-ledger.test.ts](../../test/core-role-requirement-ledger.test.ts) 的 lineage、journal、rollback、forged success 测试 | 已核实；冻结历史是审计证据，认证继续检查当前冻结输入 |
| P1-08 | 每项机制至少两个独立短场景，预期先冻结，包含反例与 unknown / blocked | [p1-exit-acceptance.test.ts](../../test/p1-exit-acceptance.test.ts) 新增“维持计划”与“改变计划但长期发展未知”两个来源场景，先登记预期，再写候选，贯通真实工具及账本 | A1 关键链已核实；不将两个工程来源场景算作真实模型或人工评价，也不自动外推所有机制 |

## P2：授权修复及重新结算

| ID | 原退出条件／契约 | 实现与测试证据 | 判定与边界 |
| --- | --- | --- | --- |
| P2-01 | 引语缺口阻塞下游 → 受限修复 → converge → 原要求重新满足 | [upstream-repair-acceptance.test.ts](../../test/upstream-repair-acceptance.test.ts) 的两组 note-reading 场景，预期先登记；完整／截短正反例；比较原 proposal envelope、要求 ID 和未授权字段 | legacy reading 保留；A4 另增 Expression / Acquisition 真实修复联通，见实施记录 |
| P2-02 | 缺 speaker mention → 修复 → 身份决议 → 下游结算；未知身份仍阻断 | 同一测试的 Ari/Wen 与 Lio/Mira 两组场景；真实 discovery、planner、staging、finish、普通 resolution 工具与 convergence；未解决身份时保留 pending 和原要求 | 已核实；身份决议步骤使用普通窄编译工具，不能表述为从根因发现到全部修复的无人干预自动链 |
| P2-03 | 越权字段／引用／创建槽拒绝，未改字段不变 | [upstream-repair-plan.ts](../../src/compiler/upstream-repair-plan.ts) 的实际差异和 JSON Pointer 校验；[upstream-repair-plan.test.ts](../../test/upstream-repair-plan.test.ts) 的数组、转义、授权槽与范围反例；[upstream-repair-ledger.test.ts](../../test/upstream-repair-ledger.test.ts) 的真实工具 staging 拒绝 | 已核实；严格注册类型，不授予通用写能力 |
| P2-04 | 旧 revision、错误来源、依赖变更在模型／提交前停止 | preflight、bound-plan、finish、convergence；[upstream-repair-ledger.test.ts](../../test/upstream-repair-ledger.test.ts) 的 stale baseline、third-party revision、structural discourse、resolution absence 反例 | 已核实；保留原草案与授权历史 |
| P2-05 | 失败／调用预算跨会话及后继计划保留，不能洗掉 | [upstream-repair-ledger.ts](../../src/compiler/upstream-repair-ledger.ts)、[pi-upstream-repair.ts](../../src/compiler/pi-upstream-repair.ts)；ledger 测试的 `counts model sessions with no proposal across revised plans`、malformed payload、budget restore | 已核实；测试中的 Pi provider 为受控替身，不是外部模型质量证据 |
| P2-06 | 授权 DAG 按依赖执行，finish 中断和跨工作区恢复不重复模型写入 | scheduler、finish-intent、checkpoint、preparation；ledger 测试覆盖 staged/frozen/partial/completed/finished/converged/evaluated 七状态及默认 prepare 续跑 | 已核实到已支持计划；不证明新根因自动规划／授权 |
| P2-07 | 修复完成后重算原独立要求，未满足不得认证 | [upstream-repair-evaluation.ts](../../src/compiler/upstream-repair-evaluation.ts)；ledger 的 `certifies only actual satisfied repair obligations`；[core-role-capabilities.test.ts](../../test/core-role-capabilities.test.ts) 的核心角色结果重算与伪造结果拒绝 | 已核实；评估与绑定分开；A2 新增实际依赖绑定，不把绑定当满足证明 |
| P2-08 | 诊断到核心角色及修订类根因的计划 | [upstream-repair-binding.ts](../../src/compiler/upstream-repair-binding.ts)、[upstream-repair-planner.ts](../../src/compiler/upstream-repair-planner.ts)；[upstream-repair-ledger.test.ts](../../test/upstream-repair-ledger.test.ts) 的 core obligations、existing decision 测试 | A2/A3 登记范围已核实：模型／真实入口／非焦点在场目标依赖，以及单 mention 的实体／事件决议修订；拆并和未知模块不支持，仍停止 |
| P2-09 | 新持久获知类型与修复、冻结、重放使用同一条链 | [acquisition.test.ts](../../test/acquisition.test.ts)、[perception-observation.test.ts](../../test/perception-observation.test.ts) 的 `repair=true` 变体均先走真实授权修复；保留旧变体 | 已核实：两个来源分别覆盖引文扩展→Expression→Acquisition、决议修订→Perception→Acquisition，含证据拒绝、归档恢复、角色隔离、fork 与 replay |

## P6：自主驱动、排序与偏离

| ID | 原退出条件／契约 | 实现与测试证据 | 判定与边界 |
| --- | --- | --- | --- |
| P6-01 | 焦点角色无动作，在 pre-event cut 仍能证明合法驱动 | [entry-driver-probe.ts](../../src/compiler/entry-driver-probe.ts) 在独立 forks 排除焦点角色和 future canon；[major-character-playability.test.ts](../../test/major-character-playability.test.ts) 覆盖 NPC、环境、到期过程的真实提交 | 已核实；A5 两来源补真实独立分支入口探针及投影比较，不合成玩家 wait |
| P6-02 | 静态 goal、玩家自己的行动、死亡／阻断／无变化候选不能冒充驱动 | playability 的 `does not certify %s as an autonomous driver`；[actor-alternatives.test.ts](../../test/actor-alternatives.test.ts) 的替代搜索和预算用尽；[reconciliation-review.test.ts](../../test/reconciliation-review.test.ts) 两组未定位入口义务 | 已核实；有界搜索未找到不等于证明世界不存在合法行动 |
| P6-03 | 只改 confidence，不改变世界压力；自报 pressure 不获权限 | [canon-runtime.ts](../../src/world/canon-runtime.ts)、[frontier.ts](../../src/world/frontier.ts)；[world-pressure.test.ts](../../test/world-pressure.test.ts) 两组桥／灯场景比较 factors 与排序 tuple，并拒绝伪造 due 标签 | 已核实；来源支持、合法性和排序分开 |
| P6-04 | 压力只来自当前冻结目标或宿主到期证明 | [goal-pressure.ts](../../src/world/goal-pressure.ts)、runtime / frontier；[goal-pressure.test.ts](../../test/goal-pressure.test.ts)、[typed-causal-scheduler.test.ts](../../test/typed-causal-scheduler.test.ts) 两组规范／过程到期场景，包含 fork、旧 head 与篡改 witness | 已核实；没有独立 hazard 本体，能用 process 表达的危险走既有机制 |
| P6-05 | 先 gate 合法性，再排序；非法高优先级不能挤掉合法候选 | [actors.ts](../../src/world/actors.ts)；[actor-legality-ranking.test.ts](../../test/actor-legality-ranking.test.ts) 两组场景检查真实 head、拒绝 trace、unknown 和无提交；alternative 测试检查同角色替代行动 | 已核实；后续真实提交仍需当前 head 验证 |
| P6-06 | 破坏必要原因后，canon 不能被偏好强制执行 | world-pressure 两场景中 precondition=false/unknown、necessary cause 被 supersede 后均不可选；[canonical-adaptation.test.ts](../../test/canonical-adaptation.test.ts) 的 `rechecks scaffold causal dependencies at the final engine boundary`；[canon-runtime.test.ts](../../test/canon-runtime.test.ts) 的 latent child | 已核实；[p6-exit-acceptance.test.ts](../../test/p6-exit-acceptance.test.ts) 两来源贯通玩家破坏原因、实际调度、完整投影、fork/replay/resume；未知许可及最高 canonAffinity 也不能绕过因果门 |
| P6-07 | 新策略冻结，旧历史不被静默重解释 | world-pressure 的 policy cache、snapshot、旧 engine 拒绝与原字节不变测试 | 已核实；当前 engine 为 0.23.0、pipeline 为 46；拒绝旧版本不等于迁移完成 |

## 可逐项关闭的剩余清单

以下交付项已按用户追加授权完成。勾选仅覆盖明示的工程范围，具体断言及验证记录见下文。

- [x] **A1 — P1 两来源退出验收。** 为逐能力部分成功、跨 namespace/reparse 义务保留、坏 finish 与结算恢复，建立两个独立原创场景；先固定 source/hash/预期，再写候选。比较 canonical、active publication、定义分母和历史；包括 unknown/blocked、依赖变更 stale、故障后只补账。保留现有单元测试，不以改名后的同一对象自动冒充独立语义场景。归属：P1 验收补证。
- [x] **A2 — 核心角色修复绑定。** 从独立 ontology/development/driver 要求沿真实版本化依赖找到根因；正例与共享原文但无依赖路径的反例均通过；不靠文本重叠或角色名猜测。角色评估器已经存在，不重复实现。归属：本次追加授权的实现范围。
- [x] **A3 — 现有决议及更多根因的修订策略。** 先登记支持的诊断码／类型，再实现精确 baseline、允许字段、前驱授权、预算和后置条件。unknown/ambiguous 决议不得以重复创建洗掉。unsupported semantic module 继续停止，扩展范围须明确。归属：本次追加授权的实现范围。
- [x] **A4 — P2 × 新获知协议联通。** 保留 legacy 测试，另用两个预先声明来源场景走受限修复 → Expression/Perception/Acquisition → finish/converge → 冻结恢复 → 角色获知及 replay/fork；移除关键证据／绑定时保持原要求未满足。归属：本次 P2/P3 联通验收；不等于要求在此实现全部分支临时获知。
- [x] **A5 — P6 两来源完整运行验收。** 分别覆盖焦点无动作的合法驱动和玩家破坏必要原因后的分歧；比较已提交历史及 state/knowledge/norm/process/active-rule 投影、fork 隔离与 resume/replay 一致性；高 canon 偏好不能产生非法事件，重试不能重复提交。先复用／定位已有断言，仅补未覆盖组合。归属：P6 退出补证。
- [x] **A6 — 三阶段最终结算。** A1/A5 的共同约束以及声明的 P2 范围验收完成后，逐行更新本表；明确“P2 最小范围完成”和“通用扩展仍开放”的区别。若 A2/A3 延后，保留范围理由和开放项，不能从分母删除后声称通用 P2 完成。

P3 分支新获知与 legacy 迁移、P4 远程渠道／照片／完整生命周期、P5 文学引用及表达绑定、P7 真实 provider 和独立人工体验仍是各自工作包，不因本次核销工程子项而关闭。真实 provider 与人工体验应独立留证；不将它们偷换为 P1/P2/P6 单元测试的先决条件，也不以工程通过替代 P7。

## A1 后续实施记录（2026-09-22）

代码仍基于 `8747e34`，新增 [p1-exit-acceptance.test.ts](../../test/p1-exit-acceptance.test.ts)，文件 SHA-256 为 `d1783d1a4fc130106157ab99b93ab1c80a236e70ff735abf677c8379ed27b404`。没有生产代码改动。

两段原创来源分别是中文守闸者维持原计划，以及英文检修者发现泄漏后改变计划；两者都有无关旁观者，后一场景包含干扰话语，且明确不能从一次计划改变推出长期人物发展。场景预期及角色预期在候选模型／目标写入前登记并固定 source hash。模型、事件背景由工程夹具提供，非 fresh model compile；两份角色 review 也是工程输入，不冒充两位真人审阅。

实际断言覆盖：

- 正确 event effect 修复仅结算原场景要求；静态 goal 被真实工具接受后，独立 ontology 和 opening-driver 仍为 blocked，长期发展证据不足场景保留 unknown。
- 错误 no-artifacts finish 拒绝后 canonical、pending envelope、finish receipt 边界不变；合法 finish 后尚未 converge 时不能结算成功。
- finish 已完成但 attempt 追加中断、主评估已保存但逐尝试结算中断均通过故障注入验证。恢复保留原 proposal envelope；重复恢复／结算不增加账本记录。
- 覆盖率提高、换 namespace、原回执归档不能消除原定义和 deferral；跨工作区 checkpoint 恢复幂等，无 pending 提案重放；在恢复工作区调用真实 archiveSource 和 invalidatePreparationArtifacts（whole=true）后，定义和原历史前缀仍完整。这是 reparse 失效边界验收，不是重新运行模型编译整本小说。
- 依赖修订后旧场景评估 stale；精确证据绑定不匹配使候选不可冻结，宿主追加 nextSubjectSnapshotHash=null 的失效记录，不能沿用旧成功或编造新 subject。旧 checkpoint 不得覆盖较新的审计链。
- 原不可变 rollback bundle hash 始终不变；严格 publish 因未完成要求失败，active 始终为空。此场景没有预先存在的有效生产证书，未伪造 active 指针，也没有使用 offline-preparation 的认证替身。因此这证明“失败不得产生发布”及“旧档案不被改写”，不额外声称已证明所有既有 certified publication 的替换故障窗口。

首轮夹具错误地期望 segment 工具保留原事件的窄证据范围，按工具实际生成整段 EvidenceRef 修正后，继续保留完整事件比对。第二轮直接改事件触发 stale exact-evidence binding；保留这个真实失败，改为断言停止冻结和宿主失效，而不是篡改绑定让测试通过。独立类型检查补齐 review schema 的 missingMajorCharacters 字段。

最终定向回归：p1-exit-acceptance、requirement-ledger、core-role-requirement-ledger、core-role-capabilities、reconciliation-review、reconciliation-history、role-review-revision、prepare-role-requirements、compiler-finish-recovery、reparse，共 **10 文件／71 项通过，12.93 秒**。新测试另用 TypeScript strict / NodeNext / ES2023 单文件入口执行 noEmit 检查通过（仓库常规 tsconfig 不包含 test，所以单独检查）。这是 A1 当时的定向记录，不与下方原基线的 168 项相加。后续 A2–A6 实施与最终验证见下一节。

## A2–A6 实施与最终结算（2026-09-22）

- **A2：核心角色依赖绑定。** 重用独立 core-role definition 与确定性 evaluator，只为未满足项建立路径。ontology/development 从精确 character-model 出发；opening-driver 使用推导成功的真实入口，以及非焦点、明确 physical 在场角色的目标。补齐 closure 中发展阶段／触发／反转事件的类型边。入口和路径节点均冻结为只读 baseline；没有模型、没有真实入口或只有共享 source/unit 不授予绑定。入口失败原诊断保留在 coreRoleBlockers。两来源测试同时验证三能力、非焦点 goal guard、删依赖后绑定消失及旧计划拒绝。
- **A3：受限决议修订。** 新登记 ENTITY_RESOLUTION_REVISION、EVENT_RESOLUTION_REVISION；当前仅支持一份决议对一个原 mention 的一对一修订。冻结旧 ID/hash、mention、候选和 source scope，宿主分配确定性新 ID，强制 supersedes。unknown/ambiguous 原文完整保留于旧版本和 finish baseline；可仍输出 unresolved，不能把修订当满足。沿用持久预算、前驱计划审阅及后置评估。恢复和 checkpoint 仅允许原回执证明的精确后继；旧前驱只作为历史证据，不出现在当前 activeRevisions。实体 unresolved/ambiguous、事件 unresolved、错误 hash／mention、后继已提交但 finish 中断的恢复、重复完成和 checkpoint 均有断言。修复了引文扩展计划未冻结原 speaker/addressee 引用的实际缺口。
- **A4：新获知联通。** 保留既有 legacy 及未修复变体；两段英／中文来源新增 repair=true。引文截短后真实授权扩展，再编译 Expression、Acquisition、记忆与推断；感知场景先将 unresolved 事件决议按新策略修订，再编译 Perception 和带 acquisitionId 的 observed 获取。两条链都走真实窄工具、finish、converge、archiveCandidate、跨工作区 restore、runtime 和 fork/replay；缺关键证据、无 prior experience、错误 cut／访问及绑定失效仍拒绝。修复回执与原 requirement 不凭工具成功自动核销。工程输入不冒充 fresh provider 编译或真人独立审核。
- **A5：完整运行验收。** 新增中文守闸与英文灯塔来源；焦点无动作时分别证实非焦点 NPC／到期背景驱动。玩家 supersede 必要原因后，后继保持 invalidated；canonAffinity=1 不获得合法性。比较整个 projection（history、state、knowledge、norms、processes、active rules 等实际对象），其中 norm/process 实例非空，knowledge/active rules 不声称此夹具均为非空。重启引擎、fork 和 fresh/no-checkpoint replay 一致，原分支不受影响，重试不重复提交；未破坏原因的对照分支仍可执行 canon。
- **A6：结算。** 本表 P1/P6 明示范围与 P2 最小范围及 A2/A3 有限扩展通过。通用事件拆并、缺少可冻结 typed path 的自动语义修复、分支临时 Acquisition／legacy 完整迁移、其他 P3–P5 扩展和 P7 保持后续范围；不把这些删除后宣称完整小说世界系统已交付。

最终验证（生产改动完成后的本地运行）：

- 全仓 Vitest：**214 文件／1,288 项通过，119.10 秒**。命令为 `node node_modules/vitest/vitest.mjs run --maxWorkers=2`，外加 180 秒宿主超时；退出 0。此前修正夹具过程中的失败不计为通过。
- 最后增强测试后另跑：决议提交后中断及核心角色绑定 **5 项通过**；Acquisition／Perception 联通 **2 文件／16 项通过**。未增加测试数量，不与全仓数累加。
- Native 契约：直接执行两个 `.native.mjs` 入口，**15 + 29 = 44 项通过**。本机 `node --test` 父 runner 仅显示两个文件级结果，因此以直接入口实际列出的契约数为据。
- 服务端、Web、E2E 三套 TypeScript 检查通过；P1/P6 新验收与 Acquisition/Perception 四个入口另跑 strict / NodeNext / ES2023 noEmit 通过。服务端生成与 Web 生产构建通过，Web 有既有大 chunk 提示，不影响退出码。
- 文档本地链接与 `git diff --check` 通过。没有执行真实 provider、人工体验或修改用户小说运行记录。

源码基线仍为 8747e34 加当前未提交 diff，没有新增提交或远端发布。

## 初次审计验证记录（新增 A1 测试之前）

远端 [run 35611599088](https://github.com/skyfore/novel-world-harness/actions/runs/35611599088) 的 verify job 重建并测试了上述 `8747e34` / tree，虽 workflow 触发提交为 `65afe96`，实际受测源码是当前基线。记录为 212 文件／1,275 项 Vitest、44 项 native、三套 TypeScript、生产构建通过。本条是已核对日志的历史远端证据，不冒充本次本地全仓重跑。

本次使用 Node 22.19.0 直接调用现有 Vitest 入口，不安装依赖、不改 lockfile；测试由既有 globalSetup 隔离 NWH_HOME。调用形式为 `node node_modules/vitest/vitest.mjs run --maxWorkers=2 <files>`，下表文件均在 `test/` 下，后缀均为 `.test.ts`。

| 组 | 文件 | 本次实际结果 |
| --- | --- | --- |
| 义务与最小修复／驱动 | requirement-ledger、core-role-requirement-ledger、upstream-repair-acceptance、world-pressure、major-character-playability | 5 文件／42 项通过，6.84 秒 |
| 协议边界与恢复／调度 | reconciliation-review、reconciliation-history、role-review-revision、core-role-capabilities、prepare-role-requirements、upstream-repair-plan、upstream-repair-ledger、upstream-repair-binding、upstream-repair-command、actor-legality-ranking、actor-alternatives、goal-pressure、typed-causal-scheduler、opening-driver | 14 文件／114 项通过，19.49 秒 |
| canon 因果与分歧 | canon-runtime、canonical-adaptation、open-world-progression | 3 文件／12 项通过，1.56 秒 |

合计 **22 文件／168 项定向测试通过**，三次命令均退出 0；这是本次定向回归，不是全仓重跑。上一次核查中本地全仓 Vitest 停在启动输出并被中止，不计成功；本次直接入口的定向运行正常完成，未将两次结果混算。文档本地链接存在性与 `git diff --check` 检查通过。本次没有新增测试或修改生产代码，没有真实 provider、人工评分或用户小说运行记录变更。

## 后续进展：P3g

本审计结束后，分支获知协议、显式证据约束的 legacy 候选迁移及两来源工程退出账已补齐，见 [P3 退出审计](2026-09-22-p3-acquisition-exit-audit.zh-CN.md)。上文将这些列为后续范围是本审计当时的边界；不表示当前仍未实现，也不表示用户旧小说数据已自动迁移。
