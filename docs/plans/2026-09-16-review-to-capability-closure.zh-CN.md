# Review 落地设计：能力结算、受限修复与角色体验

当前实现与退出状态请查 [2026-09-22 P1/P2/P6 退出审计](../reviews/2026-09-22-p1-p2-p6-exit-audit.zh-CN.md) 与 [分段实施记录的当前进度入口](2026-09-16-capability-closure-implementation.zh-CN.md)。本文保留设计基线；下述“尚未实施”指方案编写时，不是当前分支状态。§8 的原始验收要求继续有效。

状态：技术方案，尚未实施下述新增契约。核查分支 `codex/compiler-recovery-fixes`，基线 `bdf79b848d2dc363c0fcd1252b5cacec94561219`。本次 `git pull --ff-only` 成功，HEAD 与远端跟踪分支一致。

本文将两份 review 与当前实现对齐，并明确下一批可执行工作。继承 [证据优先世界模型方案](2026-09-16-evidence-first-world-model.zh-CN.md) 的 D1–D9；其中 T0–T3 的实际范围以源码和本次验证为准。本文补齐它尚未展开的持久结算、执行协议、文学表达、上下文和推进策略。历史报告保留其原基线，不改写为当前实现结论。

依据：[编译架构 review](../reviews/2026-09-15-compiler-architecture-review.zh-CN.md)、[解析与角色体验 review](../reviews/2026-09-15-novel-world-parsing-and-play-report.zh-CN.md)、[首批实施记录](2026-09-16-evidence-first-world-model-implementation.zh-CN.md)、[ADR 0001](../adr/0001-world-truth-history-and-possibility-space.md)、[工具恢复协议](../agent-tool-recovery.md)。本文不新增外部研究结论；方案选择是基于仓库代码的工程决策。

## 1. 当前差异：哪些结论仍然成立

| Review 问题 | 当前源码证据 | 当前判断 / 对应设计 |
| --- | --- | --- |
| 架构 §3.1、体验 §8.4：上游依赖需要个案脚本 | `commands/prepare-all.ts` 仍禁用 annotation/resolution/accounting 写工具；`knowledge-repair.ts` 是专用计划 | 权限隔离保留；缺统一可执行修复，见 §4 |
| 架构 §3.2、体验 §8.1：kind 掩盖 value 越界 | `content-support.ts` 明确排除 kind，`attribution-trace.ts` 调用该内核 | 原反例已修；不是完整表达边模型。无 object assertions 的旧入口仍返回空 issues，见 §5 |
| 架构 §3.3、体验 §8.2：部分成功没有持久义务 | `reconciliation-review.ts` 仍按 target 的任意提案要求 proposed；ledger 仍只扫描非 proposed | 仍未修。新 `semantic-requirements.ts` 是诊断，不消费旧 ledger，见 §3 |
| 架构 §3.4：observed 只检查标签 | `knowledge-repair.ts` 仍检查 observed 且无 attribution/sourceActor；未要求 perception ref | 仍缺事件、观察者、渠道及 cut 绑定，见 §5 |
| 架构 §3.5：开局选择不等于驱动能力 | `opening-driver.ts` 仍有字典序和全书参与频率回退 | 只能当发现提示，不能当开局能力证明，见 §7 |
| 架构 §3.6、体验 §9.3：独立验收未统一 | `scene-capabilities.ts` 已输出逐 requirement 诊断；`certification.ts` 使用另一套 scene execution contracts | 接入部分完成；缺冻结要求集和认证结算，见 §3、§8 |
| 体验 §5：每次上下文缺行动依赖闭合证明 | `actor-context-retrieval.ts/selectRecords` 是 section 优先级与关键词排序 | 保留现有预算与可见性过滤，增加依赖包和测量，见 §6 |
| 体验 §6、§8.3：文学依据与原话次数/顺序 | `play-opening.ts/assertPlaySceneNarration` 仍为 includes；`narrative-source.ts` 是可见历史的有限样本 | 次数、顺序、原著关键话语绑定和声音验收仍缺，见 §6 |
| 体验 §7.3：置信度混入压力 | `canon-runtime.ts/canonicalEventToPossibility` 为 `pressure: event.confidence` | 明确分开来源支持、世界压力和呈现偏好，见 §7 |
| 两份报告：批次/覆盖率不等于可玩 | finish、source accounting、场景诊断、认证拥有不同输入与消费方 | 不合并为一个百分比；分层验收，见 §8 |

当前 `ContentSupportAssessment.supported` 只证明提供的内容路径具有区间覆盖，不证明自然语言蕴含；内核没有接收 proposition payload，不能独自枚举该对象真正必需的所有语义字段。新表达边验证必须从已解析对象及其版本取得要求，不能从模型愿意提交哪些 assertions 推导分母。

## 2. 交付范围与不变量

目标是“声明范围内的核心角色和关键场景具有可验证的行动、获知、因果后果与文学表达”，不是将任意世界留白补成既定事实。保留全部不可变原文，按具体消费用途编译语义。未映射语义可检索、可修订，不能参与 reducer 假装已经执行。

不更换 TypeScript/Pi/本地文件架构。模型继续只提窄类型候选；宿主负责授权、验证、提交和版本检查。编译工件不直接进入角色上下文；分支事实只由已提交历史产生。本文新增 ledger 是编译工作记录，不是第二套世界真相。

```text
独立来源要求 → 版本化定义 → 场景/语义评估 → 持久义务
                                      ↓
原文/已有工件 → 最小依赖任务 → 窄提案 → finish → converge
                                      ↓
                              重验依赖、入口、能力
                                      ↓
                        冻结 bundle → 认证 → 分支事件
                                                   ↓
                                     角色视图 → 表达
```

任何模型自报 proposed、回执 completed、覆盖率提高，都不能替代评估器给出的 satisfied。已有历史分支固定其原 bundle；新编译 revision 不倒改旧分支或其已获知识。

## 3. 逐要求的持久结算契约

### 3.1 定义、报告、评估、义务分开

复用 `SemanticRequirement` 与五种 `RequirementState`，增加持久版本，不另造近义的完成状态机。

| 记录（拟新增） | 必需字段 / 责任 |
| --- | --- |
| `RequirementDefinition` | `id, definitionHash, sourceId, sourceSha256, targetRef, capability, scope, expectation, dependsOn, evidenceRefs, reviewerRef`；scope 含 canonical cut 或 branch/head；expectation 按 capability 使用严格判别 schema |
| `RequirementSet` | `setId, revisionHash, parentRevision, definitions, mandatoryIds, scopeDecisionRefs`；来源审阅独立决定分母，不由剩余 audit targets 生成 |
| `RequirementAttempt` | `requirementId, definitionHash, repairRunId, proposalRefs, modelOutcome, evidenceRefs`；模型仅报告 proposed/unsupported/capability-gap，不能提交 satisfied |
| `RequirementEvaluation` | 复用现有 source/spec/catalog/evaluator context，附加 `subjectSnapshotHash, cutHash, definitionHash, activeDependencyRevisions, evaluatorResultRef`；结果由宿主评估器生成 |
| `RequirementObligationEvent` | `eventId, predecessorHash, requirementId, definitionHash, kind, attemptRef, evaluationRef, reasonRef`；追加发现、尝试、评估、失效、范围变更记录 |

`scope` 是显式 tagged union；canonical 与 branch/head 不可混用。持久 expectation 的种类由宿主注册并带验证器；现有诊断类型的开放对象不是 mutation schema。

稳定 requirement ID 不含 batch/namespace/模型会话 ID。期望修订保留同一逻辑 ID 的 definition history。删除要求须追加来源审阅和新的要求集版本；旧版可复核，被移除的 mandatory 要求必须展示范围缩减原因，不能悄悄从分母消失。

角色的 ontology、development、opening-driver 分别有 ID；并非要求所有角色都成长。独立审阅可给出有证据的 no-change/no-development 预期，由相应评估器检查。unsupported/capability-gap 是未完成原因；它们不是角色无需能力的证据。

### 3.2 状态规则与恢复

1. 未评估为 unknown；缺前置条件为 blocked；已表示但无 lowering 为 unmapped；版本不匹配为 stale；只有本项后置条件及依赖都通过才为 satisfied。
2. 模型提交目标只新增 attempt。例：`actor:A:goal` 通过，不影响 `actor:A:ontology` 和 `entry:E:driver`。
3. finish v2 冻结 requirement attempts、要求集 hash 和计划 hash；completed 仅表示批次协议完成。converge 后对实际 active revisions 评估，追加结算事件。
4. converge 后、结算前中断：根据已验证 receipt 和 active revision 补评估，以 receipt fingerprint + requirement definition hash + subject hash 为幂等键。不得重新执行模型写入；依赖已经变化则记 stale。
5. 评估后任一有效依赖变化，沿反向依赖图标记 stale；旧成功记录仍保留。初期保留全 catalog hash 的保守失效，只有依赖读取清单完备后才改成局部失效。
6. restart、缩小 repair plan、换 namespace、global audit finding 消失均不能清义务。缓存丢失可由追加记录重建；损坏记录必须失败并要求宿主处理。

拟新增 `compiler/requirement-ledger.ts` 管理纯编译记录，放在 `worldStorageRoot(root)/compiler/requirements/<sourceId>/`。定义和评估使用 hash 文件，义务事件使用独立不可变 JSON 文件及 predecessor hash；索引是可重建缓存。写入复用 compiler lock、临时文件+rename 与完整性检查；不声称跨文件断电事务。读取器验证 source、链和引用 hash，不能因文件存在就当提交成功。

### 3.3 与现有 publication 的接线

`prepare-all` 在计划创建前加载要求集，在 converge 后结算；`review-scenes` 保留独立诊断入口并调用同一 evaluator。`prepared-cache` 将要求集、有效评估与其引用纳入 compilerSnapshot。`closure.ts` 增加明确 ref kind/purpose，`certification.ts` 校验冻结集合中所有 mandatory 要求的当前结果。先计算 subject snapshot hash，再生成评估和证书，保持现有排除派生结果的 hash 方向，禁止自引用。

新要求门与现有 roster、source coverage、semantic support、entry/scene、quality、deferral 门取合取。旧 `assertReconciliationDeferralsReviewed` 在迁移期继续运行；历史 target review 可以导入为 unknown/待审阅，不能把 proposed 转为 satisfied。宿主“已审阅 deferral”只解除流程复核要求，不认证能力。

## 4. 通用受限依赖修复

### 4.1 计划与执行的边界

现有 `planRequirementRepairs` 保持 `authority=diagnostic-only`，不因 readyForHostReview 就自动获得写权限。新增宿主规划器将结构化诊断转换为以下固定输入：

```ts
// 目标接口草案；须落成严格 schema 才能执行。
type AuthorizedRepairPlan = {
  planId: string; planHash: string; requirementSetHash: string;
  requirementIds: string[]; predecessorReceiptRefs: string[];
  sourceScope: { sourceId: string; sourceSha256: string; segmentIds: string[] };
  baselineRefs: Array<{ kind: string; id: string; revisionHash: string }>;
  allowedWrites: Array<{ kind: string; id: string; pointers: string[] }>;
  allowedCreations: Array<{ kind: string; maxCount: number; dependencyOf: string }>;
  readableRefs: string[]; citableEvidenceRefs: string[];
  dependencyEdges: Array<{ from: string; to: string; purpose: string }>;
  postconditionIds: string[]; authorizationRef: string; retryBudgetRef: string;
};
```

`kind/purpose/pointers` 来自宿主类型注册表，不接受模型自由通配符。新实体 ID 在授权范围内由宿主分配；只能补计划中某个依赖槽，不能借 maxCount 新建任意世界对象。readable 与 citable 分开，跨事件 evidence package 须显式授权；上下文可读不自动扩大引用范围。

缺身份决议→observation/resolution；引语截短→annotation；缺获知来源→expression/perception；缺可执行机制→executable；宿主未支持语义种类→ontology review。分类来自诊断码及 typed refs，不解析错误句子或自由文本 summary。

### 4.2 执行协议

顺序为 `planned → authorized → staging → finished → converged → evaluated`，旁路终态为 `needs-host-review`；评估失败保留各 requirement 的实际状态，不冒充整任务成功。

- compiler lock 内核验 source、predecessor receipt、active revisions、授权 hash 和持久失败预算；任何不匹配在模型会话前停止。
- 只开放对应阶段的窄工具；在共同 proposal 校验边界比较 payload 与 baseline 的实际差异。pointer 必须按解析后的 JSON Pointer 匹配，不能简单用字符串前缀；数组需防下标位移扩大修改范围。
- 保留原有 evidence/schema/identity/trace/obligation 验证。修正已成功草案使用正常 successor；从未成功的失败调用遵循原 proposal identity，不能换 ID 洗掉重试计数。
- finish 冻结全部授权依赖；converge 再核对 active revision。未授权字段必须保持原值；必要的撤销或依赖修订必须先进入计划，不能要求语义永远只增不减。
- 重验修改节点的反向依赖、entry cut 与 mandatory requirements。若候选不能通过，保留隔离的 candidate 和义务，禁止激活新 prepared revision；原 publication 继续有效。

### 4.3 模型可见的失败恢复

所有新增工具必须注册 `withNwhToolRecovery`。artifact miss：同 source 调用 `find_compiler_artifacts`，复制 `readArguments.ref`；annotation miss：调用 `find_source_annotations`，读取返回 ref，引用逻辑对象时复制 `annotationId`。只允许一次有实质纠正的 retry，不猜 ID。

越权、基线冲突、授权已消费、receipt 已完成、循环依赖、无语义模块、预算耗尽：保留 isError、原诊断、计划和草案，明确停止同一任务。新会话不能重置预算。由宿主完成依赖变化后，才可建立关联前驱的新计划。宿主授权是程序权限策略；常规已允许的类型无需每次询问用户，新增本体或权限范围才进入设计审阅。

## 5. 语义效果与获知关系的纵向实施

沿用原方案 T4–T8，先建立一条完整链，再扩展类型：

| 对象 | 精确语义及验证 | 消费者 |
| --- | --- | --- |
| SemanticEffect | typed kind/args、发生事件、主体、validTime、来源支持；lowering status 独立 | compiler diagnostics、execution binding；unmapped 不生成可执行 delta |
| UtteranceExpression | quotation revision、有序片段、proposition revision、speaker/addressee/event、逐语义字段证据 | attribution trace、关键话语候选、told/read acquisition |
| PerceptionObservation | observer、event/cut、channel、可感知对象/现象、源证据、可达性依据 | observed acquisition；删除 sourceActorId 无法替代 perception |
| Acquisition | 模式判别联合、expression/perception/已知前提引用、获得者、获得 cut、理解/相信状态 | knowledge projection、entry seed、角色推理 |

表达 validator 从 proposition object schema 推导 required paths，检查该表达边各字段，嵌套 proposition 验证引用及其内容支持，防循环展开。结构 kind 不替内容；同一命题在不同场景的表达分别使用本次证据。多 anchor 是本次 assertion 的合取，多条同字段支持可作为替代；断开的引文片段不能拼成不存在的连续 exact quote。没有精确表达证据时为 unverified，严格新 compilation 不可认证该表达。

获知时间、原文披露位置、事实有效时间、编译 revision 分离。角色听到谎言可获得相信状态，但不能使命题变成世界真相；翻译可传递内容，不自动授予语言能力。未决的互相矛盾陈述保留 attribution 和 counter-evidence，依赖其真实性的执行保持 unknown/blocked，先不增加一个未经所有 predicate 消费者支持的真值枚举。

每新增持久类型必须同一纵向提交覆盖 `proposals/proposal-tools → validator/evidence → finish/converge → canonical-model/prepared-cache → closure/certification → rebuild → runtime consumer`。原文无精确时长的失能可先 represented-unmapped；临时状态、生命周期、Norm scope 和非物理主体渠道分别复用 state/process/norm/action 模块，不将描述文本塞进数值 condition。

迁移采用版本化 dual-read：旧 claim/proposition/attribution 保持可读，只有查验出真实 evidence 才生成新 expression/acquisition；禁止补造来源。提升 pipeline/schema/engine fingerprint 取决于实际读取、执行契约变化，旧版本 branch 必须维持旧解释或明确拒绝不兼容加载。迁移生成新 candidate，不覆写原 snapshot。

## 6. 上下文与文学保真

### 6.1 按决策依赖构建工作集

在 `actor-context-retrieval.ts` 前增加宿主 `DecisionContextManifest`：branch/head/actor、候选及版本、必需依赖 refs、可见性判定、选入/省略理由、预算口径。先完成 actor/time/scope 过滤，再取候选 preconditions、规则、资源、知识、有效过程及相关目标，最后按现有关键词策略补充样本。

若必要依赖隐藏，角色侧只暴露安全的不可判定信息；裁决器在自身授权视图检查，不将秘密通过“缺失 ref 名称”泄漏给 actor。必要可见依赖超预算则分成有限的查证步骤或阻断本次决策，不截断后继续做确定判断。后续工具结果与 transcript 也计入请求预算，不能只限制初始 JSON。

先记录 UTF-8 bytes、现有字符数、工具 schema/工具结果尺寸和 provider 返回的实际 token usage，明确估算与实际值。不新增未经测量的统一 token 常量。每个数据类型记录 runtime consumer；仅表达用途的纹理保留 source refs，有实际行为后果时通过受限编译提升为语义，而不是默认生成大量空字段。

### 6.2 台词按事件身份保留

拟新增稳定 `utteranceId = eventId + utteranceIndex`，记录 speaker、text、提交顺序和可选 expression ref。`resolvedAct.lockedUtterances` 传递身份与顺序；两次有证据的同文发言拥有不同 ID，不按文本去重。

叙述输出采用内部 typed blocks：`prose` 或 `committed-utterance(utteranceId)`。模型选择语句之间的描写；宿主插入准确台词，并检查每个要求的 ID 恰好一次、顺序一致和无未知 ID。纯文本 includes 保留为旧格式兼容检查，不作新格式认证。输出给用户是正常 prose，不显示内部 ID。prose 中复制锁定台词的额外出现由独立检查拒绝；短句或子串重叠造成歧义时要求重写该 prose block，而不误删合法重复发言。

流式输出在完整 block 校验后才作为已确认叙述发出；需同步调整 `pi-player-opening`、play hooks 和 Web stream store 的消费契约。已提交世界事件在叙述失败后仍然存在，重试只重新渲染原事件序列，不能重复行动。精确字节展示与 settled transcript 保持一致。

### 6.3 文学样本与原著关键话语

在已有 annotation/scene/source references 上建立轻量 `LiteraryReferenceIndex`：source spans、speaker/addressee、时期/情境、用途、相关 scene/goal refs、可见性依据。原文不复制进另一个百科。先仅从当前合法证据取样；未来原著的样本不因标为 style-only 就可以越过现有防泄漏边界。

原著关键台词是有条件的表达候选，必须满足当前动机、知情、关系和行动条件，由人物回应/世界提交链形成 spokenUtterances 后，才进入锁定序列。narrator 不能为了“保留名场面”使它先发生。风格样本只指导表达，不能引入钥匙、承诺、获知等下回合可利用的事实；这些需要 typed proposal 和提交。

机械校验只证明身份、原话、顺序、视角和引用边界，不能证明人物声音与审美。体验验收单独记录声音、关系语境、关键场景因果步骤、重复/空泛程度，并保留失败样本供人工复核。

## 7. 自主推进、canon 与反事实

`selectOpeningDriverActor` 继续作为修复发现提示。真正的 entry-driver requirement 在 pre-event cut 上枚举合法 actor action、过程到期或世界响应候选，验证前提、所需知识、有效机制和有意义效果。焦点昏迷时可由其他主体或环境过程推进；若没有合法候选，明确 blocked，不从全书高频人物制造目标。

将候选评估拆为三个量：来源支持影响是否可采纳及其诊断；world pressure 来自当前 goal/norm deadline/process/hazard；presentation preference 影响合法候选的展示顺序。新 pipeline 停止 `pressure=event.confidence`，没有世界压力依据时使用中性默认并标注未提供，不用抽取置信度代填。策略版本进入冻结版本和重放输入；若保留随机选择，固定 seed。

实现顺序是先 gate 合法性，再排序。原著导向与自由发挥只改变展示/选择偏好，不改变 engine 前提、actor 知识、资源或 commit 权限。玩家破坏 canon 必要原因后，候选必须失效、延后或由独立合法机制改道，不能直接照搬原结果。

声明范围外的行动依次尝试当前可见检索、已有机制组合、版本化宿主默认机制；仍无法表达则返回明确能力缺口。通用分支实体创建/退休需要单独的 typed event、身份分配、closure、replay 和权限设计，属于后续本体扩展，不能由本文的修复计划或叙述即兴开启。

## 8. 分阶段实施与验收矩阵

以下 P 编号细化原 T 计划；不是声称已有实现。

| 阶段 | 依赖 / 主要修改点 | 必须交付的退出证据 |
| --- | --- | --- |
| P0 基线核验 | 无；原 T1–T3 | 当前工具链下 native、相关集成、全仓 test/check；记录真实失败，见 §9 |
| P1 义务纵向闭环 | P0；原 T2/T9 提前实现 ledger 部分；reconciliation-review、finish-receipts/recovery、prepare-all、prepared-cache、certification | 原创短文本：只修 goal，ontology/driver 仍未结算；restart/namespace/比例改善不消义务；坏 finish 不改变 canonical |
| P2 最小上游修复 | P1；repair planner/executor、proposal-tools、closure、tool-recovery | 缺 mention/quotation 阻塞下游→受限修复→converge→重新评估；越权字段/旧 revision/预算耗尽停止，未改字段不变 |
| P3 语义与获知 | P1/P2；原 T4/T5 | SemanticEffect 和 expression/perception/acquisition 全链；晚期报告改 observed 被拒；复用命题、多话语、多片段、嵌套、legacy 缺证据均有独立预期 |
| P4 执行扩展 | P3；原 T6–T8 | 暂时失能/未知时长、活动规范边界、远程渠道与照片、秘密身份称谓、时间未决和机制反例；相同 reducer 重放 |
| P5 台词与工作集 | P0 可先做测量/台词，关键表达绑定依赖 P3 | 原话逆序/多次/合法同文重说/嵌套短句；断流仅重渲染；依赖超预算不猜；隐藏信息不进入 actor 工作集 |
| P6 自主与偏离 | P1，复杂类型依赖 P4 | 焦点无动作仍有合法驱动；只改 confidence 不改变世界压力；破坏必要原因后 canon 不被强制执行 |
| P7 冻结与体验验收 | P1–P6；原 T10 | fresh compile→candidate→认证→角色入口→连续回合→fork/replay/resume/divergence；真实模型与独立人工评价独立留证 |

P1 不必等所有新本体才能解决部分成功义务；先用已有 goal/model/scene 能力走通。P2 先授权已有 annotation/resolution 类型，暂不允许通用本体扩展。这是依赖排序，最终范围仍包含 P3–P7。

每项机制至少两个独立原创短场景，包含正例、反例、unknown/blocked 路径；加入改名、句序扰动、干扰话语和无关角色，排除针对原案例拟合。预期先从 source 写定并冻结，不能从 compiler 输出反向生成 gold。

运行时验收须比较已提交历史与状态/知识/规范/过程/有效规则投影，检查 fork 隔离、晚入口无后获知识、重试无重复事件、修复不改旧 bundle；新依赖变更使当前评估 stale。坏 proposal、finish 或 converge 必须证明对应 canonical/active publication 未发生未经授权的改变。

三层证据分别报告：确定性工程测试、真实 Pi 的语义抽取表现、独立人工角色体验。P7 实验使用固定 provider/model/config、源 hash、要求集和策略版本，先冻结三个模型运行 seed/任务配置（不支持 provider seed 时如实记录），输出逐 requirement 的通过/阻塞/未知及成本；不得只报批次成功率。先做短场景，达标后再选择有授权的完整文本测量核心角色范围，不将历史单书补修算作 fresh compile。

体验评价采用预先声明的五项 1–5 分量表：人物声音、关系语境、信息一致性、行动后果连续性、关键场景表达；两位独立评审保留原始评分和分歧。首轮是建立基线，不预设质量提高；工程硬约束必须全过，任何知识泄漏/强制 canon/叙述写事实均判该场景失败。后续发布体验阈值基于基线单独确定，不能用平均分掩盖硬约束失败。

## 9. 本次核验与方案完成边界

本次只交付方案及现状核验，不把 P1–P7 标记为已实现；未调用真实 provider、解析小说、启动服务、发布或修改用户运行世界。

当前工具链：Node 22.19.0、pnpm 11.21.0。`pnpm check` 通过服务端、Web、E2E TypeScript 检查。`pnpm test:semantic-contracts` 退出 0，本次 TAP 输出是 2 个文件通过；不将历史记录的 44 tests 当作本次 runner 输出。

首次 `pnpm test`：179 文件中 178 通过，1030 tests 中 1029 通过；`test/novel-evaluation-runner.test.ts` 的首项在 5000ms 超时。该命令与类型检查并行执行，资源竞争是可能原因，但未证明根因。没有更改 timeout 或测试配置来掩盖问题。

独立复跑 `pnpm exec vitest run test/novel-evaluation-runner.test.ts test/quotation-content-support.test.ts test/scene-requirements.test.ts`：3 文件、6 tests 全部通过。随后 `pnpm test --maxWorkers=2`：179 文件、1030 tests 全部通过，用时 68.89 秒。降低并发后的完整通过不能抹去首次默认并发超时；默认并发稳定性保留为 CI 观察项。当前 T1/T2 的 Vitest 接入与全仓类型兼容已获得本地证据，不能外推为真实模型语义正确或 T4–T10 完成。

文档本地链接与代码围栏检查通过，`git diff --check` 通过。此次修改仅为本文及两个既有方案文档的导航链接，未改产品源码、测试或锁文件。

本方案完成条件：当前分支已同步；两份 review 的关键问题均有代码现状、目标契约、接线、迁移和验收映射；对已实现与待实施有明确区分。产品能力完成必须另外满足 P1–P7，不由本次文档完成推导。
