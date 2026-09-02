# Novel World Harness 可执行世界优化技术计划

- **状态：** Active implementation plan
- **日期：** 2026-09-02
- **适用阶段：** MVP；不承担已有 world/prepared/branch 数据迁移
- **上位决策：** [ADR 0001：世界真相是已提交历史，未来是可能性空间](adr/0001-world-truth-history-and-possibility-space.md)
- **调研依据：** [完整小说语义编译调研报告](novel-semantic-compilation-plan.zh-CN.md)

## 1. 目标与完成定义

本计划把现有的“可验证编译 + 事件提交”纵切，优化为能够支持完整小说解析、
开放玩家行动、人物自主决策和长期世界演化的可执行世界系统。

最终系统必须同时满足：

1. 小说原文仍是 canonical compilation 的证据边界；
2. compiler 可以理解完整 canonical trajectory，但 runtime 不把未来 canon 当作 branch truth；
3. 玩家可以提出未被预编译动作表枚举的新行动；
4. 已知动作、物理条件、世界规则、资源和人物权限可以确定性验证；
5. 人物仅凭自身知识、现场观察、目标、关系和义务决策；
6. 人物目标、评价、关系、义务和持续过程可以随 branch 历史演化；
7. canonical event、actor action、background process 使用同一个 proposal/validation/event model；
8. replay、fork、continuation、counterfactual rewrite 使用同一份 committed history；
9. narrative rendering 只能读取 committed projection，不能写 truth；
10. 编译质量和运行时行为都具有可重复的人工 gold、scenario 和安全门。

完成不以“新增了 schema”或“现有测试仍通过”为准。只有本文第 14 节的安全、
语义、运行时和长篇验收全部有直接证据时，整体优化才算完成。

## 2. 范围和非目标

### 2.1 本轮范围

- 重新定义唯一受支持的 MVP world/prepared/event schema；
- 保留并扩展 content-addressed canonical revisions 和 branch history；
- 新增 SceneOccurrence、EventFrame、ActionSchema、ActionConstraint；
- 新增 BranchSemanticDelta、ProcessDelta、NormDelta；
- 让 typed event relations 真正参与 eligibility 和 scheduling；
- 建立共享历史遍历、独立 typed reducer 的 projection service；
- 连接 hybrid model actor，但不让模型获得世界写权限；
- 扩展 compiler proposal、validation、prepared publication、audit 和 eval；
- 建立代表性的 vertical slice、counterfactual scenario 和多小说 gold。

### 2.2 明确非目标

- 不迁移旧 world/prepared/branch 数据；旧数据可清空并从 immutable source 重编译；
- 不实现 V1–V7/V1–V2 双读、自动升级或 compatibility reducer；
- 不把运行时迁移到 RDF、OWL、图数据库、向量数据库或外部数据库；
- 不实现任意自然语言规则解释器或完整通用 planner；
- 不允许 LLM 直接写文件、canonical model、branch head 或 projection；
- 第一阶段不允许 branch 动态创建稳定 Entity；
- 第一阶段不实现真正同时发生的多事件原子事务；actor candidates 仍确定性排序并逐个重新验证；
- 不以抽取 artifact 数量代替语义 precision/recall 或运行时正确性。

“不迁移历史数据”只移除兼容负担，不取消 source evidence、event sourcing、
StateDelta/KnowledgeDelta 分离、branch isolation 和 replay 等架构边界。

## 3. 现有设计的取舍

| 决策 | 现有部分 | 处理方式 |
| --- | --- | --- |
| 保留 | immutable source/evidence、logical identity + revisions | 继续作为 compiler ground-truth 和可审计边界 |
| 保留 | append-only commit/event history、branch CAS、fsck | 扩展 effect reachability 和 projection 检查 |
| 保留 | StateDelta 与 StateSchemaRegistry | 继续表达客观、可执行的世界变化 |
| 保留 | KnowledgeDelta 与 actor-scoped knowledge | 继续表达知道、相信、怀疑、听说和遗忘 |
| 保留 | LLM proposal -> validate -> commit -> render | 所有新 mutation channel 均经过同一边界 |
| 保留 | canonical snapshot 冻结、future canon 只作 possibility | 新 artifact 同样被 snapshot 固定 |
| 增强 | CanonicalEvent、EventParticipation、EventRelation | 增加 scene、frame、role、operational causality |
| 增强 | world-rule-v2 的 evidence、exception、override 机制 | 拆成 StateRule、ActionConstraint、Norm，不复用 legacy rule |
| 增强 | CharacterModel、RelationshipOntology、ActorGoal | canonical baseline + branch semantic overlay |
| 增强 | projectActorScene | 用明确 scene occurrence/transition/presence 替代模糊 progress label |
| 替换 | `causalParents` 作为 frontier 主要依赖 | typed relation + branch causal link 成为唯一运行语义 |
| 替换 | `urgency = 1` 的乘法 possibility score | deterministic tier + tuple ranking |
| 替换 | 模型或 fallback 自报 NarrativeProgress | host-derived ProgressCertificate |
| 替换 | 空 StateDelta 的 generic NPC reaction | 无 material effect/interaction 则不提交 |
| 替换 | workspace 固定 deterministic actor source | injectable hybrid actor policy |
| 替换 | 各 projector 重复扫描完整 ancestry | shared history cursor + typed reducers + checkpoints |
| 删除 | legacy world rule、旧 snapshot/prepared/event readers | MVP 只支持新格式，不迁移旧数据 |

## 4. 权威层与 provenance

```text
Immutable Source Evidence
  │
  ▼
Frozen Canonical Record
  ├── source-derived entities/propositions/events/scenes/rules/policies
  └── every source-derived semantic has exact EvidenceRef/assertion
  │
  ├──────── Domain Modules
  │          engine-owned generic mechanics, versioned as code/data modules
  ▼
Branch Committed History
  └── Event + typed effect deltas + committed-event provenance
  │
  ▼
Derived Projection
  ├── WorldState
  ├── KnowledgeState
  ├── BranchSemanticState
  ├── ProcessState / NormState
  └── SceneIndex / CausalIndex
  │
  ▼
Possibility / Actor Policy / Narrative View
  └── never authoritative until an event is validated and committed
```

必须使用三种不同 provenance，不能互相伪装：

```ts
type SemanticProvenance =
  | { kind: "source"; evidence: EvidenceRef[] }
  | { kind: "domain-module"; moduleId: string; moduleVersion: string }
  | { kind: "committed-event"; eventId: string; effectIndex?: number };
```

- Canonical source artifact 使用 `source`；
- 通用移动、数量守恒等机制使用 `domain-module`；
- branch 中形成的评价、关系和义务使用 `committed-event`；
- model proposal 在 commit 前不是 provenance，也不是 truth。

## 5. 完整小说语义编译流水线

编译采用可恢复、多阶段、窄 typed proposal，而不是一个 prompt 直接生成整本世界。

### 5.1 Stage A：source structure 与 discourse

输出：

- `SourceStructureManifest`；
- work/chapter/section/paragraph/sentence 的无损 byte partition；
- `DiscourseSegment`：scene、summary、flashback、dream、letter、quotation 等；
- `ViewpointSegment`；
- `Quotation` 和 speaker/addressee mention refs；
- story time expression，但不在此阶段断言 event truth。

验收：

- immutable source byte coverage 必须为 100%；
- discourse annotation 可以重叠，但不能改变结构 partition；
- discourse order 与 story time 分开；
- exact selectors 由 host 解析并验证 hash/range。

### 5.2 Stage B：mention 与 identity

输出：

- EntityMention、EventMention、TemporalMention；
- location/rule/process/norm mention annotations；
- source-scoped entity resolutions；
- event coreference/subevent resolutions；
- ambiguous/unresolved/contested revisions。

验收：

- 词面相似只生成候选，不能自动 merge；
- stable Entity identity 与 title/status/location 等 temporal fact 分开；
- 所有 canonical entity/event 必须反向追踪到 accepted mention resolution。

### 5.3 Stage C：proposition、attribution、knowledge semantics

继续保留：

- Proposition 是可复用语义内容，不等于 truth；
- Attribution 表示 narrator/character/document/system 对内容的态度；
- Claim 是现有 world/knowledge 引用的受控投影；
- KnowledgeDelta 只表达 actor 的 epistemic change。

禁止创建 `knows(x, claim)` 一类递归 meta-claim 来替代 KnowledgeDelta。

### 5.4 Stage D：SceneOccurrence

```ts
type SceneOccurrence = {
  id: string;
  discourseSegmentIds: string[];
  eventIds: string[];
  locationId?: EntityId;
  storyInterval?: StoryTime;
  viewpointActorIds: EntityId[];
  presentActorIds: EntityId[];
  entryConditions: Predicate[];
  exitConditions: Predicate[];
  evidence: EvidenceRef[];
};
```

Canonical SceneOccurrence 描述原文中的 scene；branch runtime scene 由 committed
history、location、presence 和 scene transition 推导，不能复制未来 canonical scene。

### 5.5 Stage E：EventFrame 与 canonical event instance

```ts
type EventFrame = {
  id: string;
  name: string;
  roles: EventRoleSpec[];
  temporalShape: "instant" | "interval" | "process-boundary";
};

type EventFrameInstance = {
  frameId: string;
  roleBindings: Record<string, EntityId | EntityId[]>;
  parameters: Record<string, StateValue>;
};
```

`CanonicalEvent` 增加 frame instance、scene refs、observed effect set；一次具体
canonical event 不能被误当成一条通用 ActionSchema。

### 5.6 Stage F：temporal/causal graph

EventRelation 增加：

```ts
type RelationOperationality =
  | "necessary"
  | "contributory"
  | "blocking"
  | "motivational"
  | "explanatory"
  | "non-operational";
```

映射：

- `enables` 通常为 necessary；
- `causes` 必须显式标注 necessary 或 contributory；
- `prevents` 为 blocking；
- `motivates` 只增加特定 actor/goal pressure；
- `explains` 不参与 eligibility；
- `narrative-continuation` 永不推导因果；
- contested relation 永不作为硬执行条件。

### 5.7 Stage G：Action、Rule、Norm、Process induction

只从以下证据生成 source-specific executable semantic：

- 原文明示的能力、限制、制度、誓言、过程；
- 多次事件支持的稳定 action pattern；
- 具有明确前置条件和效果的重复机制。

不能从单个事件自动归纳通用世界规律。通用机制属于 `DomainModule`，不使用
小说 EvidenceRef。

### 5.8 Stage H：character/relationship policy

输出 canonical baseline：

- CharacterGoal；
- dispositions；
- appraisals；
- development episodes；
- directed relationships；
- obligations；
- phase/time/experience activation。

Runtime 只激活 branch 中已实现或该 actor 已经历的 trigger。

### 5.9 Stage I：publication gate

Prepared publication 前必须完成：

- exact evidence assertion closure；
- source ownership closure；
- identity/event resolution closure；
- frame role completeness；
- typed relation graph validation；
- state/action field refs；
- rule/norm/process refs；
- character/relationship refs；
- compiler gold evaluation；
- unresolved/contested inventory 显式保留，不能靠删除 proposal 达到 finish。

## 6. 世界模型目标契约

### 6.1 StateDelta 与 KnowledgeDelta

两者继续保留且不能合并成无类型 effect：

- `StateDelta`：客观世界字段、集合、数量、active rule；
- `KnowledgeDelta`：actor 对 claim/proposition 的知道、相信、怀疑、听说、否认和遗忘。

单个 event 不再强制写空 StateDelta。各 effect channel 可选，但 event 必须有真实
effect、utterance、scene transition 或有效 time/process advancement。

### 6.2 新 effect channels

```ts
type BranchSemanticDelta = {
  version: 1;
  operations: BranchSemanticOperation[];
};

type BranchSemanticOperation =
  | RecordBranchProposition
  | RecordBranchAttribution
  | RecordBranchClaim
  | OpenGoal
  | CloseGoal
  | RecordAppraisal
  | AdjustRelationship
  | CreateObligation
  | ResolveObligation;

type ProcessDelta = {
  version: 1;
  operations: Array<StartProcess | AdvanceProcess | PauseProcess | FinishProcess>;
};

type NormDelta = {
  version: 1;
  operations: Array<InstantiateNorm | SatisfyNorm | ViolateNorm | RepairNorm>;
};
```

第一阶段 branch semantic operations 只能引用 frozen canonical entities。所有新 ID
由 host 根据 branch、parent commit、proposal hash、operation index 和 normalized
payload 生成；模型只使用 turn-local ref。

### 6.3 Event effect references

```ts
type EventEffectsRef = {
  version: 1;
  stateDeltaHash?: ObjectHash;
  knowledgeDeltaHash?: ObjectHash;
  semanticDeltaHash?: ObjectHash;
  processDeltaHash?: ObjectHash;
  normDeltaHash?: ObjectHash;
};
```

Delta 保持独立 schema、hash、store 和 reducer；`EventEffectsRef` 只定义一个
CommittedEvent 的原子效果集合。

### 6.4 CommittedEvent V2

```ts
type CommittedEventV2 = {
  version: 2;
  eventId: string;
  branchId: string;
  logicalTime: LogicalTime;
  action?: ActionInstance | AdHocActionRecord;
  actorId?: EntityId;
  participants: EntityId[];
  participantPresence: ParticipantPresence[];
  sceneTransition?: SceneTransition;
  effects: EventEffectsRef;
  causalRelations: BranchEventRelation[];
  canonicalLinks: CanonicalEventLink[];
  utterances: SpokenUtterance[];
  progress: ProgressCertificate;
  provenance: SemanticProvenance[];
};
```

删除 `causalParents` 作为权威字段。兼容 projection 不在本计划范围内。

### 6.5 ActionSchema 与 AdHocAction

```ts
type ActionSchema = {
  id: string;
  frameId: string;
  roles: ActionRoleSpec[];
  applicability: PredicateTemplate[];
  knowledgeRequirements: KnowledgePredicateTemplate[];
  presenceRequirements: PresenceTemplate[];
  effectPolicy: ActionEffectPolicy;
  footprint: ActionFootprintTemplate;
  duration?: DurationTemplate;
  visibility: "public" | "knowledge" | "engine";
  evidence: EvidenceRef[];
};
```

ActionSchema 是 affordance、binding 和 validation schema，不是允许动作白名单：

1. 能绑定已知 schema 时走 schema-bound lane；
2. 不能绑定时走 AdHocAction lane；
3. AdHocAction 仍必须声明 reads/writes/resources、受影响目标和 effect proposal；
4. 两条 lane 最终进入同一个 deterministic validation/commit pipeline。

现有 `Predicate` 保留给具体 world/entity/time condition；参数化 action condition 使用
独立 `PredicateTemplate`，绑定 role 后求值，避免污染已提交 state predicate 语义。

### 6.6 规则分层

| 层 | 权威 | 失败语义 |
| --- | --- | --- |
| EngineInvariant | deterministic code/domain module | proposal 无效，不能 commit |
| StateRule | temporal world data | pre/post state 无效或要求不满足 |
| ActionConstraint | temporal world data + action pattern | 动作不可执行或需不同 binding/resource |
| NormTemplate/Instance | temporal social/legal data | 动作可发生，但生成 satisfaction/violation/reparation |
| Narrative convention | meta semantic | 只影响分析、候选排序或 rendering |

保留 world-rule-v2 的 evidence、exception、priority、defeasible、explicit override 思想，
但删除 legacy rule union，并把 state/action/norm schema 分开。

### 6.7 Process

```ts
type ProcessTemplate = {
  id: string;
  ownerRoles: ActionRoleSpec[];
  activation: PredicateTemplate[];
  cadence: TimeExpression;
  transition: ProcessTransitionTemplate;
  termination: PredicateTemplate[];
  visibility: "public" | "observable" | "knowledge" | "engine";
  evidence: EvidenceRef[];
};
```

ProcessState 从 committed ProcessDelta 投影。Scheduler 只跳到下一个 meaningful due
time，不逐秒模拟。

## 7. Projection 架构

保留独立 typed reducers，但共享一次 commit ancestry traversal：

```text
ProjectionService.project(commit)
  └── SharedHistoryCursor / nearest checkpoint + tail
      ├── StateReducer
      ├── KnowledgeReducer
      ├── BranchSemanticReducer
      ├── ProcessReducer
      ├── NormReducer
      ├── SceneReducer
      └── CausalReducer
```

```ts
type WorldProjectionBundle = {
  atCommit: CommitId;
  state: WorldState;
  knowledge: KnowledgeState;
  semantics: BranchSemanticState;
  processes: ProcessState;
  norms: NormState;
  scenes: SceneIndex;
  causality: CausalIndex;
};
```

- reducer 保持独立单元测试和访问策略；
- actor view 从 bundle 投影，不接收整个 bundle；
- snapshot/checkpoint 是 cache，不是 authority；
- checkpoint 带各 reducer schema/version，失配直接重建；
- fsck 必须比较从历史重放和 checkpoint 的 hash。

## 8. Proposal、验证和提交

统一 move pipeline：

1. 读取 branch head 和 frozen canonical context；
2. 构建 actor-scoped projection；
3. natural-language action -> ActionIntent；
4. 尝试 ActionSchema binding；未命中则生成 AdHocAction；
5. host 解析 turn-local refs，分配 branch semantic IDs；
6. 验证 actor capability、knowledge、presence、route、resource 和 authority；
7. 验证 action applicability、ActionConstraint 和 proposal preconditions；
8. preview StateDelta；
9. 验证 EngineInvariant、StateRule、resource conservation；
10. staged semantic catalog 中验证 BranchSemanticDelta；
11. 在 canonical + staged branch catalog 上验证 KnowledgeDelta；
12. 验证/推导 ProcessDelta 和 NormDelta；
13. 执行 cross-channel checks；
14. host 根据真实 material effects 生成 ProgressCertificate；
15. 写 immutable delta objects；
16. 写 CommittedEvent V2；
17. 写 WorldCommit 并 CAS 更新 branch head；
18. 从 committed projection 渲染 narrative。

任何模型输出都只是 proposal。World adjudicator 可以看 engine-private constraints，actor
translator/reasoner 只能得到 actor-safe view。隐藏 constraint 的修正使用绑定 proposal hash
和 commit head 的 opaque token，禁止模型伪造或跨 turn 重用。

## 9. ProgressCertificate

NarrativeProgress 不再是 materiality 的自报来源。模型可提出 presentation hint，host
只能从 committed effects 生成：

```ts
type ProgressCertificate = {
  version: 1;
  stateOperations: EffectPointer[];
  knowledgeOperations: EffectPointer[];
  semanticOperations: EffectPointer[];
  processOperations: EffectPointer[];
  normOperations: EffectPointer[];
  utteranceCount: number;
  sceneTransition?: SceneTransition;
  channels: ProgressChannel[];
};
```

- 没有 material effect、utterance、scene transition 或有效 time/process advancement 的
  event 不能 commit；
- speech 是 committed communicative occurrence，但不自动表示听者相信或知道；
- relationship/consequence channel 必须指向实际 semantic/norm/process effect；
- novelty key 只作 derived rendering/scheduler metadata，不能证明 progress。

## 10. Typed causality 与 scheduler v2

候选来源统一为：

- accepted player consequence；
- direct actor response；
- active goal/obligation；
- due process；
- causal consequence；
- environmental/institutional pressure；
- canonical analogue；
- bounded model-generated proposal。

Eligibility 完全由 deterministic code 计算。调度采用 tier + tuple，而非概率真相或
乘法启发式：

```text
Tier 0  due process / hard deadline / direct response
Tier 1  necessary causal consequence
Tier 2  current-scene active goal or obligation
Tier 3  environmental and institutional pressure
Tier 4  canonical analogue

Within tier:
  dueTime -> pressure -> causalSupport -> sceneRelevance
  -> cooldown/novelty -> stableId
```

- canon affinity 只作同层 tie-breaker；
- canonical precondition 被 branch 破坏后，候选必须 latent/invalidated/transformed；
- motivates 只影响对应 actor/goal；
- explains/narrative-continuation 不触发事件；
- scheduler trace 必须记录每个 factor、gate 和 rejection reason。

## 11. Character runtime 与 hybrid actor

ActorReasoner 只接收：

- actor-visible state 和 owned state；
- actor knowledge/beliefs；
- current scene/present entities；
- active goal/obligation；
- current disposition/appraisal；
- branch-updated visible relationships；
- actor-visible due process；
- recent actor-observable events。

永不接收：

- future canon；
- hidden rule text；
- omniscient state；
- other actor private knowledge；
- compiler evidence/internal IDs；
- unrestricted canonical trajectory。

Hybrid policy：

1. deterministic scheduler 先选相关 actor，禁止每 turn 调用所有人物；
2. 有已编译 action candidate 时直接验证；
3. 无候选时才调用 model reasoner；
4. reasoner 输出 ActionIntent/ActionInstance，不直接输出 committed truth；
5. ad-hoc effects 经 world adjudicator 和正常 gates；
6. 无 material response 时返回 no action，不提交 generic reaction。

多 actor candidate 以 ActionFootprint 处理：

- write/write；
- read/write assumption invalidation；
- resource claims；
- exclusive participants；
- temporal overlap；
- consent/authority；
- 每次前一 candidate commit 后，后续 candidate 必须在新 head 重新验证。

## 12. 存储与唯一 schema

不实现历史迁移，但继续使用已有 content-addressed local storage：

```text
world/v2/
  objects/
    deltas/
    knowledge/
    semantics/
    processes/
    norms/
    events/
    commits/
  branches/
  snapshots/
  frontier/
  canon/
```

唯一受支持格式：

- `WORLD_STORAGE_VERSION = "v2"`；
- CanonicalSnapshot V8；
- PreparedNovelBundle V3；
- CommittedEvent V2；
- EventEffectsRef V1；
- ProjectionCheckpoint V2。

CanonicalSnapshot V8 至少固定：

- entities/propositions/attributions/claims；
- events/participations/relations；
- spatial relations；
- scene occurrences/event frames；
- action schemas/action constraints；
- state rules/norm templates/process templates；
- character goals/models/relationship policies；
- possibility templates；
- state field specs/domain module refs；
- source ID/prepared revision/evidence assertion binding manifest。

删除旧 schema union 和 legacy supplement/recovery 只表示新 world 数据需要重新 prepare，
不删除 immutable source archive。

## 13. 工作包、依赖、提交和验收

每个工作包必须独立提交。一个工作包只有在其列出的测试和全量 `pnpm run check`
通过后才能标为完成。实现过程中本表是权威 tracker。

### T0 — 技术计划与基线

- **状态：** complete
- **依赖：** 无
- **提交边界：** 只包含本计划、README 入口和基线说明
- **验收：** `pnpm test`、`pnpm run check`；计划覆盖目标、非目标、模型、任务、测试
- **建议提交：** `docs: add executable world optimization plan`

### T1 — 新 schema 核心与干净存储边界

- **状态：** complete
- **依赖：** T0
- **主要文件：**
  - `src/world/model.ts`
  - `src/world/store.ts`
  - `src/world/context.ts`
  - `src/world/snapshot.ts`
  - `src/compiler/prepared-cache.ts`
- **交付：**
  - world/v2；
  - Event V2 + EventEffectsRef；
  - Snapshot V8 only；Prepared V3 only；
  - legacy schema readers 删除；
  - StateDelta/KnowledgeDelta 保留且 event effect refs 可选；
  - 空 effect materiality contract。
- **测试：** schema round-trip、hash、store corruption、new-context publication、old-format rejection
- **建议提交：** `refactor: establish executable world v2 schemas`
- **完成说明：** 已启用 `world/v2`、Event V2/EventEffectsRef V1、CanonicalSnapshot V8、PreparedNovelBundle V3；旧格式无迁移读取路径；空 delta 不再作为 effect 占位，非 genesis 事件由 deterministic materiality gate 与 fsck 双重校验。

### T2 — Shared projection 与 typed effect channels

- **状态：** in progress
- **依赖：** T1
- **主要文件：**
  - 新建 `src/world/projection-service.ts`
  - 新建 `src/world/semantic-effects.ts`
  - 新建 `src/world/process-effects.ts`
  - 新建 `src/world/norm-effects.ts`
  - `src/world/engine.ts`
  - `src/world/knowledge.ts`
  - `src/world/scene.ts`
  - `src/world/fsck.ts`
- **交付：** shared history cursor、typed reducers、projection bundle、checkpoint、fsck reachability
- **测试：** deterministic replay、fork isolation、missing/corrupt effect、checkpoint drift、cross-channel refs
- **建议提交：** `feat: project typed branch effects from shared history`

### T3 — ProgressCertificate 与正确性闭环

- **状态：** pending
- **依赖：** T2
- **主要文件：**
  - `src/world/engine.ts`
  - `src/world/player-action.ts`
  - `src/world/actors.ts`
  - `src/world/runtime.ts`
- **交付：** host-derived certificate、empty-event rejection、utterance semantics、opaque constraint tokens
- **测试：** false progress、empty actor reaction、speech vs knowledge、token spoof/reuse、hidden disclosure
- **建议提交：** `feat: derive material progress at the commit boundary`

### T4 — SceneOccurrence、EventFrame、ActionSchema

- **状态：** pending
- **依赖：** T1、T2
- **主要文件：**
  - 新建 `src/world/scene-occurrence.ts`
  - 新建 `src/world/event-frame.ts`
  - 新建 `src/world/action-ontology.ts`
  - `src/world/canonical-model.ts`
  - `src/world/context.ts`
  - `src/compiler/proposals.ts`
  - `src/compiler/proposal-tools.ts`
  - `src/compiler/validator.ts`
- **交付：** canonical revisions、role binding、PredicateTemplate、schema-bound/ad-hoc lanes
- **测试：** role cardinality/kind、binding、effect envelope、unknown action fallback、scene closure/evidence
- **建议提交：** `feat: compile scene event and action semantics`

### T5 — Branch semantic character evolution

- **状态：** pending
- **依赖：** T2、T4
- **主要文件：**
  - `src/world/semantic-effects.ts`
  - `src/world/development.ts`
  - `src/world/character-ontology.ts`
  - `src/world/relationship-ontology.ts`
  - `src/world/model-actor-policy.ts`
- **交付：** branch proposition/claim、goal、appraisal、relationship、obligation overlays
- **测试：** deterministic IDs、same-event local refs、fork isolation、visibility、canonical immutability
- **建议提交：** `feat: evolve character policy from branch events`

### T6 — StateRule、ActionConstraint、Norm、Process

- **状态：** pending
- **依赖：** T2、T4、T5
- **主要文件：**
  - 重构 `src/world/world-rule-ontology.ts`
  - 新建 `src/world/action-constraint.ts`
  - 新建 `src/world/norm-ontology.ts`
  - 新建 `src/world/process-ontology.ts`
  - `src/world/state.ts`
  - `src/world/engine.ts`
- **交付：** rule layer split、norm lifecycle、process lifecycle、resource/conservation hooks
- **测试：** physical rejection、legal violation allowed、exception/override、deadline/reparation、due process
- **建议提交：** `feat: execute constraints norms and world processes`

### T7 — Typed causal frontier 与 scheduler v2

- **状态：** pending
- **依赖：** T4、T6
- **主要文件：**
  - `src/world/event-relations.ts`
  - `src/world/frontier.ts`
  - `src/world/runtime.ts`
  - `src/world/canon-runtime.ts`
  - `src/world/possibility-model.ts`
- **交付：** operationality、CausalIndex、tier ranking、due process/norm candidates、trace reasons
- **测试：** necessary/contributory/prevents/motivates/explains、canon invalidation、stable ordering
- **建议提交：** `feat: schedule from typed causality and world pressure`

### T8 — Hybrid actor 与 multi-actor adjudication

- **状态：** pending
- **依赖：** T3、T5、T6、T7
- **主要文件：**
  - `src/world/workspace-runtime.ts`
  - `src/world/model-actor-policy.ts`
  - `src/world/actors.ts`
  - `src/world/runtime.ts`
  - CLI/Pi composition roots
- **交付：** injectable actor policy、salience budget、ActionFootprint conflicts、new-head revalidation
- **测试：** no omniscience/future canon、bounded calls、read/write/resource conflict、no-op omission
- **建议提交：** `feat: connect bounded autonomous actor decisions`

### T9 — Full compiler integration、audit 与 eval

- **状态：** pending
- **依赖：** T4、T5、T6、T7
- **主要文件：**
  - `src/compiler/structure.ts`
  - `src/compiler/batches.ts`
  - `src/compiler/proposals.ts`
  - `src/compiler/validator.ts`
  - `src/compiler/prepared-cache.ts`
  - `src/compiler/audit.ts`
  - `src/eval/compiler-eval.ts`
- **交付：** multi-stage proposal pipeline、new prepared artifacts/assertion bindings、gold layers
- **测试：** source closure、restore portability、semantic precision/recall、selected reparse dependencies
- **建议提交：** `feat: compile and evaluate executable novel semantics`

### T10 — Long-horizon hardening、docs 与 release audit

- **状态：** pending
- **依赖：** T1–T9
- **主要文件：** tests、fixtures、docs、CLI/Web read-only projections
- **交付：** representative corpus、runtime scenarios、checkpoints/performance、explain traces、status docs
- **测试：** 第 14 节完整矩阵、`pnpm test`、`pnpm run check`、`pnpm test:e2e`
- **建议提交：** `test: verify long-horizon executable worlds`

## 14. 最终验收矩阵

### 14.1 安全硬门槛

- 相同 commit 全 projection hash 100% 一致；
- branch fork 后 state/knowledge/semantic/process/norm 完全隔离；
- invalid/dangling effect refs 为 0；
- hidden rule、other actor knowledge、future canon leakage 为 0；
- 模型直接 world write 为 0；
- 模型伪造 stable semantic ID/progress/constraint token 全部拒绝；
- empty NPC commit 为 0；
- EngineInvariant/resource conservation violation 为 0；
- renderer 修改 branch head 为 0。

### 14.2 Compiler semantic metrics

人工 gold 必须覆盖：

- mention detection；
- entity/event coreference；
- quotation speaker/addressee；
- proposition/attribution/knowledge acquisition；
- event frame/roles/presence；
- scene boundaries/viewpoint/story time；
- temporal/causal relation + operationality；
- state effects；
- action applicability/effect envelope；
- rules/action constraints/norms/processes；
- character goals/appraisals/relationships/obligations。

安全相关 effect precision 优先于 recall。试运行质量目标在首批人工 baseline 后冻结，
不得用当前 synthetic fixtures 自行设定“已完成”阈值。

### 14.3 Runtime scenarios

至少包含：

1. canonical replay；
2. 玩家破坏 canonical event 的必要前置条件；
3. schema 外但世界允许的 ad-hoc action；
4. 角色相信错误消息、另一角色知道真相；
5. 秘密只被实际观察/接收者获得；
6. 法律/礼法被违反但动作物理成功，随后生成 consequence；
7. process 到期和大跨度时间推进；
8. NPC 主动追求 branch goal；
9. 背叛/结盟改变 relationship 和后续选择；
10. 多 actor 抢夺同一资源；
11. hidden magic/physical rule 阻止动作但不泄漏规则文本；
12. fork 后相同 actor 形成不同知识、关系、目标和未来。

### 14.4 性能和可观测性

- projection 从 nearest checkpoint + tail 重放，不在每个 consumer 重扫完整 ancestry；
- model actor 调用数受 deterministic salience budget 限制；
- compiler 全书 batch 可恢复且 source accounting 闭合；
- 每个 move trace 记录 candidate source、gates、bindings、footprint、scheduler tuple、
  accepted/rejected reason、effect refs 和 commit boundary；
- actor-safe trace 不包含 engine-private details。

## 15. 文献和标准依据

- W3C, [OWL 2 Web Ontology Language Primer](https://www.w3.org/TR/owl2-primer/)：
  ontology 的声明性知识表达、开放世界语义及其与程序/数据库的区别；
- W3C, [Shapes Constraint Language](https://www.w3.org/TR/shacl/)：数据形状和验证约束；
- Baker et al., [The Berkeley FrameNet Project](https://aclanthology.org/C98-1013/)：
  frame 与 semantic roles；
- Palmer et al., [The Proposition Bank](https://aclanthology.org/J05-1004/)：
  predicate/argument role annotation；
- Pustejovsky et al., [TimeML](https://staffwww.dcs.shef.ac.uk/people/R.Gaizauskas/research/papers/iwcs03.pdf)：
  event、time expression 和 temporal links；
- Mostafazadeh et al., [CaTeRS](https://aclanthology.org/W16-1007/)：
  event temporal/causal relations；
- Kowalski & Sergot, [A Logic-based Calculus of Events](https://www.cs.brandeis.edu/~cs112/cs112-2004/newReadings/Kowalski-Sergot.pdf)：
  事件、持续状态和追加式历史；
- Fox & Long, [PDDL2.1](https://strathprints.strath.ac.uk/1846/)：
  action precondition/effect、duration 和 numeric resources；
- OASIS, [LegalRuleML Core Specification](https://docs.oasis-open.org/legalruleml/legalruleml-core-spec/v1.0/legalruleml-core-spec-v1.0.html)：
  obligation、permission、prohibition、violation 和 reparation；
- Park et al., [Generative Agents](https://arxiv.org/abs/2304.03442)：
  memory/reflection/planning 对长期 agent 行为的作用；
- Krishna et al., [FABLES](https://arxiv.org/abs/2404.01261)：
  book-length 内容选择和事实一致性评测难点。

## 16. 基线和进度记录

计划建立时的验证基线：

```text
pnpm run check  PASS
pnpm test       PASS — 134 files / 776 tests
```

后续每个工作包完成时必须更新第 13 节状态，并在提交说明中记录：

- 实际完成的 contract；
- 与计划的偏差及理由；
- 执行的定向测试；
- `pnpm run check` 结果；
- 全量测试结果；
- 下一工作包仍未完成的依赖。
