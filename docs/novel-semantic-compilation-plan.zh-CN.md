# 技术计划：可溯源的全书小说语义编译

- **状态：** Proposed
- **日期：** 2026-08-25
- **范围：** 小说导入、结构拆分、语义标注、身份消歧、canonical 编译、审计、修复与重解析
- **必须遵守：** [ADR 0001](adr/0001-world-truth-history-and-possibility-space.md)、[ADR 0002](adr/0002-user-level-content-addressed-storage.md)、[ADR 0003](adr/0003-world-time-character-development-and-divergence.md)
- **上位设计：** [Technical Design](technical-design.md)
- **英文对照：** [Evidence-Grounded Full-Novel Semantic Compilation](novel-semantic-compilation-plan.md)

## 1. 计划摘要

当前仓库已经有正确的“可执行小说世界”权威边界：

- 原文是不可变编译证据；
- 模型输出只是 proposal；
- proposal 必须经过确定性验证和显式接受；
- 分支真值是已经提交的事件历史；
- WorldState、角色知识和角色发展都是派生投影；
- future canon 不会因为编译器知道结局就进入活跃分支。

当前主要问题不是模型能力不足，也不是 prompt 长度不够，而是从
“source segment”到“canonical artifact”的跨度太大：

```text
原文字节
  -> chapter/block segment
  -> 模型一次性完成发现、消歧、事件合并、因果解释、状态映射、人物归纳
  -> entity / claim / event / character model
```

中间的实体提及、引语、事件提及、命题归因、时间关系、因果边及其证据没有
被保留下来。最终结果虽然能通过结构校验，却难以回答：

- 这个字段由原文哪一句支持？
- 这是原文明说，还是模型推断？
- “他”“丞相”“孟德”为什么被合并成同一人物？
- 两个事件是因果、前提、时间相邻，还是同一事件的子事件？
- 角色性格变化来自哪次经历，是否只在某个对象或情境下成立？
- 还有多少原文没有被纳入世界模型？

本计划在 segment 和 canonical proposal 之间增加一个非权威的
annotation/resolution plane：

```text
不可变原文
    |
    v
结构单元 + prompt context window
    |
    v
实体/事件/时间/地点 mention + 引语 + 命题
    |
    v
身份、事件、时间和关系 resolution
    |
    v
typed canonical proposal
    |
    v
validate -> accept -> immutable canonical revision
    |
    v
committed history -> WorldState -> runtime
```

该改造不引入数据库、向量检索或第二套世界真值。Annotation 和 resolution
仍然是编译记录或候选解释；只有现有 canonical 接受边界和 runtime commit
边界能够建立真值。

## 2. 研究结论

### 2.1 必须保留的现有优势

1. **不可变原文边界。** `ingest` 先归档再切分
   （[ingest.ts](../src/commands/ingest.ts#L9)）；原文经过 UTF-8 校验、
   内容寻址、只读存储，并在读取时重新校验身份和哈希
   （[source-material-store.ts](../src/storage/source-material-store.ts#L26)）。

2. **不可变 canonical revision。** Canonical artifact 使用内容哈希 revision
   和 current ref，逻辑身份与内容版本已经分离
   （[canonical-model.ts](../src/world/canonical-model.ts#L49)）。

3. **proposal → validate → commit。** 当前技术设计已经明确
   segment、batch、typed proposal、验证、显式接受、replay 的顺序
   （[technical-design.md](technical-design.md#L933)）。

4. **事件历史而不是可变 JSON 是分支真值。** 角色发展也从已提交历史、
   私有知识和状态派生，而不是维护第二条角色时间线
   （[development.ts](../src/world/development.ts#L61)）。

5. **叙事时间与世界时间分离。** `StoryTime` 和
   `NarrativeContext` 已经能区分 exact/range/relative/ordinal 以及
   scene/summary/flashback/recollection/hypothetical 等叙事模式
   （[model.ts](../src/world/model.ts#L59)、
   [model.ts](../src/world/model.ts#L91)）。

本计划只能在这些边界内增强语义层，不能绕过或替换它们。

### 2.2 章节和 block 是传输结构，不是小说世界结构

当前 segment 只有 `section | block`
（[segments.ts](../src/compiler/segments.ts#L16)）。章节识别依赖内置标题模式
或一个前缀/数字/后缀规则
（[chapter-split.ts](../src/compiler/chapter-split.ts#L15)）；过大的 section
按字节、行数和空行继续切开
（[segments.ts](../src/compiler/segments.ts#L323)）。

这种设计能安全地建立 prompt batch，但不能表达：

- 卷、部、回、章、场景、beat 的层级；
- 章节开头延续上一章同一场景；
- 一章内多次切换时间、地点和人物集合；
- flashback、梦境、嵌套故事或信件与当前场景重叠；
- 叙述概括与现场行动之间的边界。

叙事计算研究通常用时间、地点、人物集合和持续行动共同定义 scene，而不是
依赖章节版式
（[Detecting Scenes in Fiction](https://aclanthology.org/2021.eacl-main.276/)）。
后续研究也明确指出章节属于编辑结构，cliffhanger 可能把同一 scene 分在两章
（[Rethinking Scene Segmentation](https://aclanthology.org/2025.latechclfl-1.8/)）。

**结论：** 保留现有 chapter/block segment；在其上增加可重叠的结构和话语
标注。Prompt batch、结构单元、scene 和证据 span 必须是四个不同概念。

### 2.3 当前引用能证明字节未变，不能证明断言被原文支持

`SourceSpan` 有行号、字节范围和 `quoteHash`
（[model.ts](../src/world/model.ts#L19)），`EvidenceVerifier` 会验证原文
身份、范围和哈希
（[evidence.ts](../src/compiler/evidence.ts#L21)）。

但模型工具只提交 segment ID；宿主将整个 segment 转成 evidence
（[proposal-tools.ts](../src/compiler/proposal-tools.ts#L114)、
[segments.ts](../src/compiler/segments.ts#L243)）。单个 segment 可达到约
1000 行或 96 KiB
（[segments.ts](../src/compiler/segments.ts#L52)）。

这会混淆三个完全不同的事实：

1. 模型读过这个 segment；
2. 某句话明确支持一个字段；
3. 模型综合整段后做出了人物或因果推断。

编译路径还会把宿主生成的 whole-segment reference 标成 `explicit`。
实体有额外的名称/别名出现检查，但事件效果、因果边和人物 trait 没有通用的
文本蕴含验证
（[evidence.ts](../src/compiler/evidence.ts#L132)）。

[W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)
将文本位置和 exact/prefix/suffix quote selector 分开；
[W3C PROV-O](https://www.w3.org/TR/prov-o/) 区分被生成的 Entity、生成过程
Activity 和 Agent。这两项标准适合用于本项目的精确 anchor 和编译 provenance，
但不要求采用 RDF。

**结论：** “字节绑定是否有效”与“原文是否支持这个解释”必须成为两个字段。
证据必须落到 artifact 字段或关系边，而不是只落到整个 artifact。

### 2.4 缺少 mention/resolution 层是全书身份错误的根源

当前 Entity 只有稳定 ID、kind、canonical name、aliases 和 artifact 级
evidence
（[model.ts](../src/world/model.ts#L40)）。没有：

- 原文 mention；
- 专名、称谓、官职、亲属称谓、代词、集合称呼；
- 候选 entity；
- resolved/ambiguous/unresolved 状态；
- alias 的类型和有效时间；
- merge/split 历史。

长篇 coreference 明显比短文档困难。BookCoref 的书级样本平均超过
20 万 token，并报告模型在书级长度上的性能退化
（[BookCoref](https://aclanthology.org/2025.acl-long.1197/)）。多语种文学
共指资源也显示中文等语言存在特有挑战
（[GOLEMcoref](https://aclanthology.org/2026.acl-short.39/)）。
官方 [BookNLP](https://github.com/booknlp/booknlp) 也把 mention、coreference、
quotation、entity 和 event 保持为不同输出层。

**结论：** mention 是原文观察，entity 是消歧后的稳定身份；二者不能继续
合并成一次模型提交。

### 2.5 当前因果图只验证拓扑，不验证因果

`CanonicalEvent` 只有一个 `causalParents: string[]`，confidence 和
evidence 也只存在于整个事件
（[model.ts](../src/world/model.ts#L400)）。验证器会检查父事件存在、
时间不发生明确回退
（[validator.ts](../src/compiler/validator.ts#L97)），闭包会检查循环
（[proposals.ts](../src/compiler/proposals.ts#L583)）。

但一条关系没有自己的：

- cause/enable/prevent/motivate/explain/subevent 类型；
- source span；
- explicit/inferred/contested 状态；
- confidence；
- mechanism/precondition；
- counter-evidence。

因此叙事相邻、时间先后、前提条件、人物动机和直接因果可能被压缩进同一数组。

带有强度、证据和其他属性的关系应成为一等对象，这属于
[W3C N-ary Relations Note](https://www.w3.org/TR/swbp-n-aryRelations/)
描述的关系建模问题。事件共指、时间、因果和 subevent 之间会互相制约，
[MAVEN-ERE](https://aclanthology.org/2022.emnlp-main.60/) 因而采用联合标注；
[EventRelBench](https://aclanthology.org/2025.findings-emnlp.482/) 也显示通用
LLM 在这些关系任务上仍不可靠。

**结论：** 图无环不等于因果正确。每条 event relation 必须独立建模、引用
和验证。

### 2.6 Claim/Knowledge 方向正确，但 attribution 不足

`Claim` 使用自由 predicate 和 `unknown` object，只能附带较粗的
epistemic type 与可选 speaker
（[model.ts](../src/world/model.ts#L46)）。`KnowledgeDelta` 正确地区分
knows/believes/suspects/heard/disbelieves 与世界状态
（[model.ts](../src/world/model.ts#L200)），但还不能完整表达：

- narrator、人物、文书、传闻的嵌套归因；
- 否认、质疑、撤回、欺骗；
- 直接观察、听说、阅读、推断、回忆；
- 命题成立的 story-time；
- 同一命题在不同人物视角下的不同置信度。

引语语料通常分别标注 quote span、speaker、addressee 和 cue
（[RiQuA](https://aclanthology.org/2020.lrec-1.104/)）；事件 factuality
研究还需要显式来源和 certainty
（[Event Factuality and Modal Dependency](https://aclanthology.org/2021.acl-long.122/)）。
[ISO-TimeML](https://aclanthology.org/L10-1027/) 也强调文本表达和它所指
事件之间的区别。

**结论：** Claim 应拆成 Proposition、Attribution/Factuality 和
actor-specific acquisition，断言不能自动成为世界真值。

### 2.7 角色发展 authority 正确，性格 ontology 不可比较

当前 goal 已支持知识门槛、事件/时间激活、completion、expiry、milestone
和 candidate action
（[actors.ts](../src/world/actors.ts#L26)）。Development phase 也能依赖
状态、canonical event、角色亲历事件、知识和 story time
（[actors.ts](../src/world/actors.ts#L67)）。

问题在于 traits 与 decisionBiases 是任意字符串到数值的 map
（[actors.ts](../src/world/actors.ts#L101)）：

- `brave`、`courage`、`勇敢` 可能成为三个维度；
- 数值没有行为锚点；
- 不区分稳定 disposition、当前 affect、策略和对特定对象的态度；
- 没有 supporting/counter evidence；
- 没有 context、target 和有效时间；
- 多次模型运行之间无法可靠比较。

角色近期经历还固定取最后 12 个直接参与事件
（[development.ts](../src/world/development.ts#L84)），不一定能保留最重要的
目标、关系和创伤性经历。

[PersonaBank](https://aclanthology.org/L16-1163/) 将角色目标、动机、
时间线和 affective impact 放在同一故事表示中；
[Story Commonsense](https://aclanthology.org/P18-1213/) 则关注事件前后的
动机和情绪链。

**结论：** 保留“从历史派生角色发展”的设计，但用版本化行为维度、
target-specific relationship stance、appraisal episode 和 development
episode 代替无定义 trait 字符串。

### 2.8 当前审计没有全书 recall 分母

编译 prompt 明确优先构造 bounded high-leverage graph，而不是穷举 mention
（[batches.ts](../src/compiler/batches.ts#L638)、
[batches.ts](../src/compiler/batches.ts#L659)）。Audit 中
`entityResolution`、`majorEventResolution`、`epistemicCoverage`
被直接设为 `null`
（[audit.ts](../src/compiler/audit.ts#L392)）。

语义 gate 只有在已经抽到至少 20 个事件时才运行
（[audit.ts](../src/compiler/audit.ts#L277)）。现有 evaluator 只比较 logical
ID 集合和无类型 causal edge
（[compiler-eval.ts](../src/eval/compiler-eval.ts#L7)）。
`三国演义` fixture 只验证字节和 120 回章节形态，不验证语义
（[corpus README](../fixtures/corpus/README.md#L19)、
[corpus-fixture.test.ts](../test/corpus-fixture.test.ts#L8)）。

**结论：** 已抽取 artifact 的内部比例不能代表全书覆盖率。必须引入
source accounting 和独立人工 gold denominator。

### 2.9 Reconcile/reparse 只能修已知对象

Bounded reconciliation 只有两轮，并限制每轮修复的 event/character 数量
（[reconcile-world.ts](../src/compiler/reconcile-world.ts#L15)）。当前目标主要是
已知事件缺少 summary、presence、checkpoint、time、effect 或粗粒度角色发展
（[reconcile-world.ts](../src/compiler/reconcile-world.ts#L183)）。

章节 reparse 仅当 artifact 的全部 evidence 都落在选中 span 时才失效该
artifact
（[reparse.ts](../src/commands/reparse.ts#L275)），没有计算 mention →
resolution → event/relation → state/knowledge → character/possibility 的依赖闭包。

**结论：** missing semantic unit 和 stale downstream artifact 必须成为
显式对象。

## 3. 当前流程

```text
nwh ingest
  -> 注册 source metadata
  -> 不可变 source archive
  -> chapter/block segment manifest

compile-source / prepare-all
  -> 构造不跨章节的 bounded batch
  -> 每 batch 新建 Pi compiler session
  -> 注入有限 artifact catalog
  -> 提供 source-scoped lexical find/read
  -> 模型通过 typed tools 提交 proposal
  -> 模型只给 segment handle，宿主注入 whole-segment EvidenceRef
  -> pending proposal store

accept / prepare
  -> 验证 source hash 与 span
  -> 验证实体引用、state schema、时间与因果循环
  -> 接受为 immutable canonical revision

audit / reconcile
  -> 统计 inventory、内部 coverage ratio、图结构
  -> 修复少量已知薄弱 artifact

reparse
  -> 按 evidence containment 失效 current artifact
  -> 重新生成 revision
  -> 既有 branch 继续 pin 旧 prepared revision

runtime
  -> committed event history 为 branch truth
  -> 确定性投影 state、knowledge、scene、development 和 frontier
```

### 3.1 当前主要失真点

| 位置 | 当前压缩 | 后果 |
|---|---|---|
| block -> entity | mention 与 identity 合一 | 难以解释或修复跨章消歧 |
| block -> event | event mention 与 occurrence 合一 | 重复描述、回忆和 subevent 易混淆 |
| segment -> evidence | context window 与 citation span 合一 | 无法证明具体字段 |
| participants[] | participation 与 semantic role 合一 | 谁做了什么不明确 |
| causalParents[] | 多种 event relation 合一 | 拓扑有效但语义可能错误 |
| claim | proposition、holder、certainty 合一 | narrator/rumor/belief 容易污染 truth |
| trait map | disposition、affect、stance 合一 | 角色模型不稳定、不可比较 |
| extracted count | inventory 与 coverage 合一 | 漏抽对象不会进入分母 |

## 4. 目标权威架构

| Plane | 对象 | 权威级别 |
|---|---|---|
| Source | immutable bytes、source manifest | 原文 ground truth 边界 |
| Structure | chapter、paragraph、scene candidate、discourse span | 派生/候选，不是世界真值 |
| Annotation | mention、quotation、proposition mention、event mention | 原文观察，非 canonical |
| Resolution | identity cluster、event coreference、time/relation hypothesis | 版本化编译判断，仍需接受 |
| Canonical | entity、proposition、event、relation、rule、character model | 接受后的编译参考 |
| Branch | committed event history | runtime 真值 |
| Projection | WorldState、knowledge、development、frontier | 确定性派生 |
| Narrative | prose、summary、analysis | 无写 truth 权限 |

必须满足：

1. 每个 annotation 都指向一份不可变 source revision。
2. 每个 resolution 都列出被解释的 annotation。
3. 每个 canonical 关键字段和关系边都有精确 evidence 或显式 inference。
4. Annotation/resolution store 没有写 branch state 的 API。
5. Runtime state 仍然只能通过 validated committed event 改变。
6. Future canon 仍留在 possibility frontier。

## 5. 目标 Ontology

### 5.1 TextAnchor 与字段级 EvidenceAssertion

```ts
type TextAnchor = {
  version: 1;
  sourceId: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  exactHash: string;
  prefixHash?: string;
  suffixHash?: string;
  normalization: "source-bytes-v1";
};

type EvidenceAssertion = {
  version: 1;
  id: string;
  target: {
    artifactKind: string;
    artifactId: string;
    jsonPointer: string;
  };
  anchors: TextAnchor[];
  relation: "supports" | "contradicts" | "contextualizes";
  strength: "explicit" | "strong-inference" | "weak-inference";
  interpretation?: string;
  derivation: {
    runId: string;
    compilerBatchId?: string;
    provider?: string;
    model?: string;
    promptHash: string;
    ontologyVersion: string;
    createdAt: string;
  };
};
```

约束：

- 模型不能提交可信 byte offset 或 hash。
- 模型提交 segment ID、exact quote、可选 prefix/suffix/occurrence。
- 宿主在已验证 segment 内唯一定位 exact quote，计算全局 byte/line/hash。
- exact quote 多次出现且无法消歧时，工具必须拒绝。
- `strength` 表示 source 对 assertion 的支持强度，不能由宿主“成功找到文本”
  自动设为 explicit。
- artifact schema 声明必须有 evidence 的 JSON Pointer。
- 旧 `EvidenceRef[]` 保持可读，但标记为 legacy artifact-level evidence，
  不能满足新的 semantic evidence publication gate。

模型侧输入：

```ts
type ModelEvidenceSelector = {
  segment_id: string;
  exact: string;
  prefix?: string;
  suffix?: string;
  occurrence?: number;
  target_path: string;
  relation: "supports" | "contradicts" | "contextualizes";
  strength: "explicit" | "strong-inference" | "weak-inference";
  interpretation?: string;
};
```

### 5.2 结构、scene、discourse 与 source accounting

```ts
type StructuralUnitKind =
  | "work"
  | "paratext"
  | "volume"
  | "part"
  | "chapter"
  | "scene"
  | "beat"
  | "paragraph"
  | "sentence"
  | "clause"
  | "non-scene";

type StructuralUnit = {
  id: string;
  sourceId: string;
  kind: StructuralUnitKind;
  parentId?: string;
  anchor: TextAnchor;
  ordinal: number;
  proposedBy: "deterministic" | "model" | "human";
  confidence: number;
};

type DiscourseSegment = {
  id: string;
  sourceId: string;
  kind:
    | "scene"
    | "summary"
    | "flashback"
    | "flashforward"
    | "frame"
    | "recollection"
    | "hypothetical"
    | "dream"
    | "embedded-document"
    | "narrator-commentary";
  anchors: TextAnchor[];
  viewpointActorId?: string;
};

type SourceAccountingRecord = {
  unitId: string;
  status:
    | "represented"
    | "background-only"
    | "paratext"
    | "duplicate-description"
    | "unresolved"
    | "intentionally-deferred";
  annotationIds: string[];
  reason?: string;
  reviewedBy: "deterministic" | "model" | "human";
  reviewedAt: string;
};
```

结构树必须完整覆盖 source；discourse span 可以重叠。Prompt batch 只引用这些
单元，不成为新的语义层。

### 5.3 EntityMention 与 IdentityResolution

```ts
type EntityMention = {
  id: string;
  sourceId: string;
  anchor: TextAnchor;
  surface: string;
  form:
    | "proper"
    | "nominal"
    | "pronoun"
    | "title"
    | "kinship"
    | "collective"
    | "zero-anaphora";
  kindCandidates: EntityKind[];
  sceneId?: string;
};

type IdentityResolution = {
  id: string;
  mentionId: string;
  status: "resolved" | "ambiguous" | "new-entity" | "unresolved";
  entityId?: string;
  candidates: Array<{
    entityId: string;
    confidence: number;
    evidenceAssertionIds: string[];
  }>;
  aliasType?: "name" | "title" | "office" | "kinship" | "nickname" | "other";
  validStoryTime?: StoryTime;
  supersedesResolutionId?: string;
};
```

流程：

1. 确定性代码生成 lexical candidate：exact surface、normalized alias、
   title/kinship pattern、scene participants、entity kind。
2. 模型对候选排序或提出 new/unresolved。
3. Validator 检查 mention span、候选存在、类型和 source scope。
4. 接受 resolution revision。
5. Canonical entity 从 accepted resolved mentions 聚合 aliases。

Ambiguous/unresolved 是合法结果，不允许为了闭合 schema 强制创建错误实体。

### 5.4 Quotation、Proposition、Attribution 与 Knowledge

```ts
type Quotation = {
  id: string;
  anchor: TextAnchor;
  mode: "direct" | "indirect" | "free-indirect";
  speakerMentionId?: string;
  addresseeMentionIds: string[];
  cueAnchor?: TextAnchor;
  sceneId?: string;
  attributionConfidence: number;
};

type PropositionObject =
  | { kind: "entity"; entityId: string }
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "proposition"; propositionId: string };

type Proposition = {
  id: string;
  subjectEntityId: string;
  relationId: string;
  object: PropositionObject;
  polarity: "positive" | "negative";
  modality: "asserted" | "possible" | "necessary" | "counterfactual";
  validStoryTime?: StoryTime;
  evidenceAssertionIds: string[];
};

type Attribution = {
  id: string;
  propositionId: string;
  holderEntityId?: string;
  holderKind: "narrator" | "character" | "document" | "unknown";
  attitude:
    | "asserts"
    | "knows"
    | "believes"
    | "suspects"
    | "reports"
    | "denies"
    | "questions";
  certainty: number;
  sourceAttributionId?: string;
  evidenceAssertionIds: string[];
};
```

`KnowledgeDelta` 改为引用 proposition/attribution，并记录 acquisition：

- observed；
- told；
- read；
- inferred；
- remembered；
- deceived/misattributed。

World truth、narrator assertion 和 actor belief 始终是三个不同投影。

### 5.5 EventMention、Participation 与 EventRelation

```ts
type EventMention = {
  id: string;
  sourceId: string;
  triggerAnchors: TextAnchor[];
  extentAnchors: TextAnchor[];
  eventTypeCandidates: string[];
  sceneId?: string;
  discourseSegmentId?: string;
};

type EventResolution = {
  id: string;
  eventMentionIds: string[];
  status: "resolved" | "ambiguous" | "unresolved";
  canonicalEventId?: string;
  supersedesResolutionId?: string;
};

type EventParticipation = {
  id: string;
  eventId: string;
  entityId: string;
  role:
    | "agent"
    | "patient"
    | "theme"
    | "experiencer"
    | "beneficiary"
    | "instrument"
    | "location"
    | "source"
    | "destination"
    | "other";
  presence?: ParticipantPresence["mode"];
  evidenceAssertionIds: string[];
};

type EventRelation = {
  id: string;
  fromEventId: string;
  toEventId: string;
  type:
    | "coreference"
    | "subevent"
    | "before"
    | "after"
    | "during"
    | "overlaps"
    | "causes"
    | "enables"
    | "prevents"
    | "motivates"
    | "explains"
    | "narrative-continuation";
  status: "explicit" | "inferred" | "contested";
  confidence: number;
  mechanism?: string;
  requiredConditions?: Predicate[];
  evidenceAssertionIds: string[];
  counterEvidenceAssertionIds?: string[];
};
```

Validator 必须检查：

1. 两端 reference closure；
2. cause/enable/prevent 与 story-time 不冲突；
3. 只对要求 DAG 的 relation type 做 cycle check；
4. 每条 relation 有独立 evidence；
5. coreference 对称，subevent 非对称且无环；
6. narrative-continuation 不满足 causal dependency；
7. 矛盾时间边产生 blocking issue；
8. inferred relation 不能伪装成 explicit。

迁移期间保留 `CanonicalEvent.causalParents` 读取。新 compiler 生成
`EventRelation`，兼容 projector 按 versioned policy 从 `causes/enables`
关系导出旧父事件。Frontier/invalidation 只在新 prepared fingerprint 发布后
切换到 typed relation。

时间关系先实现 [W3C OWL-Time](https://www.w3.org/TR/owl-time/) 的小型子集：
before、after、during、contains、overlaps、starts、finishes，不引入 RDF。

### 5.6 WorldState、空间、relationship 与 rule

保留当前 typed state registry。无法正确映射的语义继续成为 proposition，
不能强行写入相近字段。

新增版本化 domain modules：

- character physical/status/resource；
- artifact identity/custody/quantity/condition；
- spatial containment/adjacency/route/control/travel duration；
- institution membership/authority/procedure；
- faction alignment/control；
- directed relationship stance/obligation。

```ts
type WorldRuleV2 = {
  id: string;
  name: string;
  kind: "physical" | "social" | "legal" | "magical" | "institutional";
  authorityEntityId?: string;
  jurisdictionEntityIds: string[];
  appliesWhen: Predicate[];
  requires?: Predicate[];
  forbids?: Predicate[];
  effectTemplate?: StateDelta;
  exceptions?: Predicate[];
  priority: number;
  defeasible: boolean;
  validStoryTime?: StoryTime;
  knownByClaimIds?: string[];
  evidenceAssertionIds: string[];
};
```

验证策略借鉴 [W3C SHACL](https://www.w3.org/TR/shacl/) 的数据与约束分离，
但仍用 TypeScript/Zod 和本地 JSON 文件。

### 5.7 Character ontology

```ts
type CharacterDimensionDefinition = {
  id: string;
  ontologyVersion: string;
  label: string;
  description: string;
  negativeAnchor: string;
  neutralAnchor: string;
  positiveAnchor: string;
  runtimeUse: "decision" | "relationship" | "rendering" | "analysis";
};

type CharacterDisposition = {
  id: string;
  actorId: string;
  dimensionId: string;
  value: number;
  context?: string;
  targetEntityId?: string;
  validStoryTime?: StoryTime;
  confidence: number;
  supportingEvidenceAssertionIds: string[];
  contradictingEvidenceAssertionIds: string[];
};

type AppraisalEpisode = {
  id: string;
  actorId: string;
  eventId: string;
  interpretationPropositionId: string;
  emotion: { label: string; intensity: number };
  affectedGoalIds: string[];
  resultingIntention?: string;
  evidenceAssertionIds: string[];
};

type DevelopmentEpisode = {
  id: string;
  actorId: string;
  triggerEventIds: string[];
  beforeDispositionIds: string[];
  afterDispositionIds: string[];
  mechanism: string;
  startsAt: StoryTime;
  endsAt?: StoryTime;
  decay?: { kind: "none" | "linear" | "event-dependent"; rate?: number };
  status: "active" | "resolved" | "reversed";
  evidenceAssertionIds: string[];
};
```

约束：

- 初始只建立 actor policy 真正需要的小型受控词汇。
- 单次行为不能自动证明稳定性格，除非有 narrator 明示或重复证据。
- disposition、current affect、target-specific stance、value、goal、tactic 分开。
- 旧自由 trait key 迁移成 `legacy:<key>`，不静默映射。
- Development 仍从 committed history 投影。
- 将固定“最后 12 个事件”替换为确定性 salience selection：recent、
  goal-relevant、relationship-changing、high-impact，在硬 token budget 内选取。

### 5.8 Artifact dependency

```ts
type ArtifactDependency = {
  from: { kind: string; id: string; revision?: string };
  to: { kind: string; id: string; revision?: string };
  type:
    | "grounded-by"
    | "resolves"
    | "references"
    | "derived-from"
    | "invalidates-with";
};
```

```text
TextAnchor
  -> StructuralUnit / Mention
  -> IdentityResolution / EventResolution
  -> Proposition / CanonicalEvent / EventRelation
  -> StateDelta / KnowledgeDelta / WorldRule
  -> CharacterGoal / DevelopmentEpisode / Possibility
  -> PreparedRevision / runtime checkpoint
```

Dependency graph 从 typed records 重建，不成为独立真值。

## 6. 改造后的编译流程

### Stage A：确定性结构

输入：

- immutable source manifest；
- chapter split plan；
- segment manifest。

输出：

- paragraph/sentence 单元；
- part/chapter/paratext 层级；
- 基于 source ID + byte span 的稳定结构 ID；
- 从结构单元构造的 prompt window。

确定性代码负责 UTF-8、byte coverage、层级 containment、排序与 hash。

### Stage B：高召回语义 inventory

逐个基础 accounting unit 提交：

- entity mention；
- event mention；
- time/place mention；
- quotation；
- scene/discourse boundary；
- source accounting status。

该阶段优化 recall，不得创建 canonical identity、cause、trait 或 state delta。

新增工具：

- `propose_entity_mentions`；
- `propose_event_mentions`；
- `propose_quotation`；
- `propose_scene_boundary`；
- `account_source_units`。

### Stage C：身份与事件 resolution

输入全书 mention、lexical candidates 和 exact paged retrieval，输出：

- entity resolution；
- alias 分类和有效时间；
- event coreference/subevent；
- unresolved/ambiguous queue。

Resolution 可以 revision，但不能修改原 mention span。

### Stage D：命题、时间和关系

输出：

- proposition/attribution；
- quote speaker/addressee；
- event participation role；
- story-time anchor 与 typed temporal relation；
- causes/enables/prevents/motivates/explains。

关系级 evidence 必须存在；推断必须显式标记。

### Stage E：可执行世界编译

该阶段从 accepted/active annotation 和 resolution 生成：

- canonical entity/event；
- state/knowledge delta；
- initial world；
- world rule；
- character goal/model；
- possibility。

仍可回读原文核验，但 canonical proposal 必须引用 annotation/resolution ID 和
字段级 evidence。

### Stage F：全书 reconciliation

输入从“已知 artifact 弱点”扩展为：

- source accounting gap；
- unresolved mention；
- identity/event resolution conflict；
- 无字段 evidence 的 event/relation；
- temporal contradiction；
- recurring character 缺少目标/发展；
- stale dependency closure。

所有修复仍通过 typed proposal，不直接写 canonical store。

## 7. 模型工具和 Prompt 改造

### 7.1 Phase-specific authority

每个阶段只暴露对应 proposal tool：

- inventory 阶段不能提交 state；
- resolution 阶段不能改 source mention；
- executable 阶段只能引用已解析身份；
- reconciliation 只能提交 replacement proposal。

Read/search 继续 source-scoped、分页、词法优先。

### 7.2 Prompt 必须明确的区分

- exhaustive accounting vs selective executable modeling；
- mention vs identity；
- event expression vs canonical occurrence；
- temporal order vs causality；
- narrator assertion vs world truth；
- actor belief vs world truth；
- stable disposition vs current affect；
- context segment vs citation span；
- host-valid bytes vs semantic strength。

这些不是只靠 prompt 的软规则；对应 validator 必须存在。

## 8. 存储与兼容迁移

建议布局：

```text
$NWH_HOME/workspaces/v1/<workspace-id>/
  world/v1/
    compiler/
      semantic/v2/
        <source-id>/
          structure/
          annotations/
          resolutions/
          evidence/
          accounting/
          dependencies/
          refs/
          revisions/
    canon/
      entities/
      claims/
      events/
      rules/
      event-relations/
    proposals/
    prepared/
```

所有新 store 继续使用：

- canonical JSON；
- immutable revision；
- atomic current ref；
- safe ID；
- source-scoped listing；
- content-hash verification。

兼容策略：

1. 旧 `world/v1` artifact 始终可读。
2. 使用 optional V2 字段或独立 V2 store，不让旧 strict schema 失效。
3. Prepared fingerprint 增加 annotation/evidence/ontology/resolver/prompt 版本。
4. 旧 branch 继续 pin 旧 prepared revision。
5. V2 发布默认选择新 branch。
6. 升级旧 workspace 必须显式 whole-source reparse。
7. Legacy evidence 在 audit 中可见，但不满足 `semanticEvidenceReady`。

迁移顺序：

1. 先增加 schema/store，compiler 行为不变。
2. 回填 structural units 和 legacy evidence descriptor。
3. 通过 compiler fingerprint flag 启用 exact selector。
4. 对 gold slice 生成 annotation/resolution。
5. 只对该 slice 启用 V2 canonical 编译。
6. 增加 dual-read compatibility projection。
7. Gate 达标后，新 workspace 默认 V2。
8. 旧 prepared world 仅在显式 reparse 后升级。

## 9. Audit 与 publication gate

将单个 `semanticReady` 拆成显式三态：

```ts
type ReadinessState = "ready" | "not-ready" | "unknown";

type CompilerReadiness = {
  structural: ReadinessState;
  evidence: ReadinessState;
  accounting: ReadinessState;
  resolution: ReadinessState;
  semantic: ReadinessState;
  runtime: ReadinessState;
  publication: ReadinessState;
  unknownDimensions: string[];
  blockingIssues: string[];
};
```

定义：

- `structural`：source、segment、hierarchy、byte coverage 有效。
- `evidence`：每个 required field/relation 有 exact anchor 或显式推理链。
- `accounting`：所有基础单元有 accounting record。
- `resolution`：所有 canonical reference 已解析；ambiguous/unresolved
  在声明阈值内。
- `semantic`：event、relation、time、state/knowledge effect、
  character、rule 通过一致性验证。
- `runtime`：opening checkpoint、presence、actionability、
  autonomous driver、replay 和 knowledge isolation 通过。
- `publication`：所有必需维度都为 ready；unknown 是 blocking。

新的 denominator：

- deterministic structural units；
- inventory pass 的 mention；
- resolved event mention cluster；
- resolved character participation；
- scene 内观察/传播 proposition 所构成的 knowledge opportunity；
- 人工 major-event inventory 或 gold benchmark。

Artifact count 只叫 inventory，不能再叫 semantic coverage。

## 10. 评测方案

| 层 | Gold | 指标 |
|---|---|---|
| Structure | hierarchy、scene boundary | exact/fuzzy boundary P/R/F1 |
| Evidence | field-to-source span | exact match、span IoU、unsupported assertion rate |
| Mention | entity/event/time/place/quote | span/type P/R/F1 |
| Coreference | entity/event cluster | MUC、B³、CEAF、CoNLL |
| Quotation | quote、speaker、addressee、cue | span F1、attribution accuracy |
| Event | event type、participant role | trigger/type/role F1 |
| Time | story anchor、typed relation | relation F1、contradiction rate |
| Causality | typed evidenced edge | edge/type F1、evidence support rate |
| Proposition | polarity、modality、holder、certainty | macro F1、calibration |
| Knowledge | acquisition、visibility | operation F1、leakage failure |
| State | state/knowledge delta | operation accuracy、replay invariant |
| Character | goal、appraisal、development | expert agreement、evidence support |
| E2E | prepare、replay、branch | determinism、divergence、spoiler isolation |

匹配不能只依赖 logical ID，应按 exact anchor、mention cluster、typed relation 和
normalized semantic content 对齐。

Corpus 顺序：

1. 保留 `smoke-world.txt` 作为快速 E2E。
2. 建立一个跨多章深标 gold slice，必须包含别名/称谓/代词、跨章身份、
   direct/indirect quote、错误或不确定 belief、flashback、显式/推断因果、
   relationship/development 和可分支状态变化。
3. 在版本与来源问题解决后，为 `三国演义` 建立受控人工子集。
4. 再加入现代多视角和非线性叙事。
5. 最后进行跨 provider/model 稳定性评测。

首轮 gate，需在获得 baseline 后校准：

- accepted anchor cryptographic validity = 100%；
- published canonical required-field evidence coverage = 100%；
- source accounting coverage = 100%，但 unresolved/deferred 必须单独计数；
- constrained gold mention F1 ≥ 0.90；
- CoNLL coreference ≥ 0.80；
- event trigger F1 ≥ 0.85；
- participant role F1 ≥ 0.80；
- temporal relation F1 ≥ 0.80；
- typed causal relation F1 ≥ 0.75；
- deterministic replay failure = 0；
- actor knowledge leakage failure = 0；
- silently upgraded legacy revision = 0。

这些是工程 gate，不是“文学理解完全正确”的声明。

## 11. 实施里程碑

### M0：Baseline 与 gold denominator

目标：先测量当前系统，再扩大 ontology。

改造：

- 固定 smoke fixture 当前输出；
- 定义 span、mention、cluster、event、role、relation、proposition、
  knowledge、state effect gold schema；
- 标注第一个代表性 slice；
- evaluator 按 anchor/semantic content 对齐；
- 拆分 readiness 字段，但暂不改变发布行为。

主要文件：

- `src/eval/compiler-eval.ts`；
- `src/compiler/audit.ts`；
- `test/compiler-eval.test.ts`；
- `fixtures/corpus/`。

完成标准：

- CI 输出分层指标；
- 缺失 denominator 显式为 unknown/blocking；
- 当前 compiler 有可重复 baseline。

### M1：Exact evidence 与 provenance

目标：每项语义断言都能定位和复核原文。

改造：

- 增加 `TextAnchor`、`EvidenceAssertion`、derivation；
- 实现宿主 exact selector resolver；
- evidence assertion store/verifier；
- model tool selector JSON schema；
- proposal envelope/retrieval 支持字段 evidence；
- artifact schema target-path validator；
- 保留 legacy segment evidence。

主要文件：

- `src/world/model.ts`；
- `src/compiler/proposal-tools.ts`；
- `src/compiler/evidence.ts`；
- `src/compiler/proposals.ts`；
- `src/world/canonical-model.ts`。

完成标准：

- 模型不能写可信 hash/offset；
- 重复 quote 无法消歧时被拒绝；
- source byte 改变会使 anchor 失效；
- strength 不再被自动设为 explicit；
- required field 缺证据时 proposal 被阻止。

### M2：Structure、Mention 与 Accounting

目标：在 canonical 之前建立 source observation 层。

实施状态（2026-08-25）：已完成。`src/compiler/structure.ts` 与
`src/compiler/source-accounting.ts` 实现 deterministic structure/accounting；
`src/compiler/annotations.ts`、`src/compiler/annotation-retrieval.ts` 与
`src/compiler/proposal-tools.ts` 实现 mention、quotation、可重叠 discourse
observation、immutable revision、closure validation、batch recovery、audit、
removal 与分页检索。Identity resolution 明确保留给 M3。

改造：

- structural/discourse schema 和 store；
- deterministic paragraph/sentence unit；
- scene/discourse proposal；
- mention/quotation tools；
- 每个基础单元的 accounting；
- paged annotation retrieval。

建议新增：

- `src/compiler/structure.ts`；
- `src/compiler/annotations.ts`；
- `src/compiler/source-accounting.ts`。

完成标准：

- 每个 source byte 被基础结构单元覆盖；
- 每个 required unit 被 accounting；
- mention extraction 没有 canonical write 权限；
- overlapping discourse span 不破坏文本顺序。

### M3：Identity 与 Event Resolution

目标：跨全书身份和事件融合可见、可 revision。

实施状态（2026-08-25）：M3a entity resolution 已完成。
`src/compiler/entity-resolution.ts` 与
`src/compiler/entity-resolution-retrieval.ts` 已实现 deterministic lexical
candidate、显式 resolved/new-entity/ambiguous/unresolved 决策、immutable
superseding revision、source-scoped 分页、audit denominator，以及 canonical
name/alias trace gate。M3b-1 event mention 也已进入 non-canonical observation
层：保留 exact trigger/extent anchor、participant mention reference、discourse
context、salience、closure、分页与 audit count。M3b-2 event identity/resolution
是下一步。

改造：

- deterministic lexical candidates；
- entity resolution proposal/revision；
- alias type 和 story-time validity；
- event coreference/subevent；
- unresolved/ambiguous queue；
- canonical proposal 前的 resolution closure。

建议新增：

- `src/compiler/entity-resolution.ts`；
- `src/compiler/event-resolution.ts`。

完成标准：

- canonical entity/event reference 可追溯到 resolved mention；
- ambiguous mention 保持可见；
- merge/split 会生成 revision 与 dependency impact；
- 全书 resolution 可分页恢复。

### M4：Typed Event、Proposition 与 Knowledge

目标：拆开时间、因果、归因和知识路径。

改造：

- quotation/proposition/attribution；
- event participation/relation store；
- temporal relation validator；
- knowledge acquisition 引用 proposition/attribution；
- legacy claim/causalParents projection；
- compiler prompt/catalog 更新。

主要文件：

- `src/world/model.ts`；
- `src/world/knowledge.ts`；
- `src/compiler/proposals.ts`；
- `src/compiler/validator.ts`；
- `src/compiler/batches.ts`；
- `src/world/frontier.ts`；
- `src/world/canon-runtime.ts`。

完成标准：

- narrative continuation 不能满足 causal dependency；
- 每条 event relation 独立有 evidence/confidence；
- quote speaker/addressee 可单独审计；
- narrator assertion 不自动成为 state 或 actor knowledge；
- 旧 prepared revision runtime 测试全部通过。

### M5：Character、Relationship、Rule 与 Spatial Ontology

目标：actor behavior 来自上下文化、有证据的角色发展。

改造：

- controlled character dimension registry；
- disposition/appraisal/development episode；
- goal hierarchy/conflict/commitment；
- directed target-specific relationship；
- spatial/world-rule modules；
- deterministic salience memory。

主要文件：

- `src/world/actors.ts`；
- `src/world/development.ts`；
- `src/world/state.ts`；
- `src/world/model-actor-policy.ts`；
- `src/compiler/semantics.ts`。

完成标准：

- V2 prepared world 不接受未注册 trait key；
- disposition/development 有 context、time、evidence；
- affect、disposition、stance、goal 分开；
- actor projection 保持 deterministic 和 knowledge-safe。

### M6：Dependency-aware Audit、Reconcile 与 Reparse

目标：缺失和过期语义能够被发现并安全修复。

改造：

- 从 typed records 重建 dependency graph；
- source anchor 变化后计算 impact closure；
- downstream artifact 标记 stale/review-required；
- reconcile 读取 accounting gap 和 unresolved queue；
- 新 readiness/publication gate；
- 保持 branch pinning/rollback。

主要文件：

- `src/compiler/audit.ts`；
- `src/compiler/reconcile-world.ts`；
- `src/commands/reparse.ts`；
- `src/compiler/prepared-cache.ts`；
- `src/workflow/prepare.ts`。

完成标准：

- source change 能列出所有直接和传递受影响 artifact；
- missing semantic unit 成为 repair target；
- required coverage 为 unknown 时 publication 不通过；
- 旧 branch 继续 replay 旧 revision。

### M7：长篇规模、稳定性与默认发布

目标：证明 V2 可用于长篇并成为新 workspace 默认流程。

改造：

- full-book resumability/memory profiling；
- cross-chapter stitching；
- cross-model/provider stability；
- uncertainty-driven human review queue；
- CLI status/documentation；
- gate 达标后 V2 default。

完成标准：

- 全书 fixture 有 bounded memory 与可恢复进度；
- catalog paging 不丢 exact evidence；
- deterministic layer 不依赖 provider；
- semantic variance 被报告；
- V1 始终可读且明确标记 legacy。

依赖关系：

```text
M0 baseline/gold
  -> M1 exact evidence
      -> M2 structure/mention/accounting
          -> M3 resolution
              -> M4 event/proposition/knowledge
                  -> M5 character/world ontology
                  -> M6 audit/reparse
                      -> M7 rollout
```

M0/M1 必须最先完成。没有精确 evidence 和 denominator 时扩大 ontology，
只会扩大不可验证输出。

## 12. 测试策略

### 12.1 Unit

- 中文 UTF-8 exact selector；
- duplicate exact quote + prefix/suffix；
- byte/line/hash round-trip；
- JSON Pointer target validation；
- mention/resolution closure；
- relation symmetry/acyclicity/time compatibility；
- proposition polarity/modality/attribution chain；
- character vocabulary 和 bounded value；
- accounting state machine；
- dependency closure。

### 12.2 Property/Mutation

- 任意有效 anchor 读回完全相同 bytes；
- 改变一个 byte 只直接破坏覆盖该 byte 的 anchor；
- dependency closure 包含全部 downstream；
- canonical JSON 顺序无关、hash 稳定；
- 非法 relation cycle 被拒绝；
- unresolved annotation 永不进入 runtime state。

### 12.3 Integration

- ingest -> structure -> annotate -> resolve -> compile -> accept；
- accepted field 全部可读取 exact source；
- 跨章 scene continuity；
- 远距离 alias/title resolution；
- rumor vs world truth vs belief；
- explicit vs inferred causality；
- reparse 保留旧 branch 并发布新 revision；
- V1 prepared world 仍可读取。

### 12.4 End-to-end

- canonical replay；
- typed causal descendant invalidation；
- alternative event deterministic state；
- actor knowledge isolation；
- lived/learned trigger 后角色发展；
- narrative 无 truth write 权限。

## 13. 可观测性

每次 compiler run 输出：

- source unit total/accounted/unresolved/deferred；
- mention type 与 unresolved candidate；
- exact evidence valid/invalid/missing；
- entity/event unresolved grounding；
- relation 按 type/status/confidence 分布；
- state/knowledge operation 缺证据数；
- character dimension/development counter-evidence；
- stale dependency 数；
- readiness 与 blocking reason；
- model/provider/prompt/ontology fingerprint。

CLI 必须区分：

- structural compilation complete；
- semantic inventory complete with unresolved items；
- runtime-ready vertical slice；
- full-book publication-ready。

## 14. 风险与对策

| 风险 | 对策 |
|---|---|
| Ontology 扩张拖慢交付 | 按 milestone 推进，先 evidence/mention，再扩领域 |
| 模型产生虚假精确性 | 宿主定位 anchor、显式 inference、边级 evidence、contested 状态 |
| 受控词汇损失文学细节 | 保留 proposition 与 versioned `other`，不强制错误映射 |
| 全书成本增长 | inventory 与 executable compile 分离、分页 catalog、可恢复 checkpoint |
| 错误 merge 污染下游 | immutable resolution revision + dependency closure |
| Exact quote 重复 | prefix/suffix/occurrence，仍不唯一则拒绝 |
| Unicode offset 漂移 | 仅宿主依据 archived source bytes 计算 |
| 旧 world 失效 | dual-read、fingerprint、pinned revision、显式 reparse |
| Audit 制造虚假信心 | unknown blocking、inventory 不叫 coverage、人工 gold |
| Character stereotype | 行为锚点、context/target/time、counter-evidence、禁止诊断性标签 |

## 15. 最终实现效果

| 当前 | 完成后 |
|---|---|
| Artifact 引用整个 prompt segment | 关键字段和关系精确链接原文 |
| 宿主把 segment evidence 标为 explicit | 字节有效性与解释强度分离 |
| 模型直接创建 entity | 先 inventory mention，再 resolve 或保留 ambiguous |
| chapter/block 代表叙事结构 | hierarchy 与 overlapping scene/discourse 并存 |
| participant 是无角色 ID | participation role/presence 独立有 evidence |
| causalParents 混合多类关系 | cause/enable/prevent/motivate/time/subevent/continuation 分开 |
| Claim 高度自由 | proposition、attribution、factuality、acquisition 分开 |
| trait 是任意 scalar key | dimension 版本化、上下文化、时间化、有正反 evidence |
| audit 统计已抽取 inventory | source accounting + gold 提供 denominator |
| reconcile 只修已知事件 | 可发现 missing/unresolved semantic unit |
| reparse 只看 evidence containment | 计算完整 downstream impact，保持 branch pinning |

完成后系统能够回答：

- 每项 world fact、relationship、state delta 由哪段精确原文支持；
- 哪些结论是原文明说，哪些是模型推断或有争议解释；
- 每个稳定实体由哪些 mention 合并而来；
- 事件之间为什么是因果、使能、阻止、动机或仅叙事相邻；
- 某个 branch point 上角色知道、相信、重视、追求和经历了什么；
- 哪些 source unit 仍未解析；
- source/ontology 变化后哪些 artifact 必须重新评审。

## 16. Definition of Done

只有同时满足下列条件，才能宣称一部小说已经编译为“可审计的可执行世界”：

1. 每个 canonical required field 和 relation 都能打开 exact source anchor，
   或显示完整 inference derivation。
2. 每个 entity 都可追溯到 mention cluster；ambiguous/unresolved 没有被隐藏。
3. 每个 canonical event 都可追溯到 event mention，并有 participant role、
   time 和 effect；无 effect 时有显式语义说明。
4. Cause、time、subevent 和 narrative continuation 不再共享一个语义字段。
5. World truth、narrator assertion 和 actor belief 不互相泄漏。
6. Character disposition/development 有 context、time、target 和正反 evidence。
7. 所有基础 source unit 都有 accounting 状态。
8. Required coverage 为 unknown 时，`publicationReady` 必须为 false。
9. Reparse 能列出完整 impact closure，并保持既有 branch 的旧 revision。
10. Gold benchmark 在 CI 中持续报告 structure、evidence、resolution、event、
    causality、knowledge、character 和 runtime 指标。
11. 完整 test/check 通过，canonical replay 与 knowledge isolation 零回归。
12. 新设计仍遵守：原文为证据边界、LLM 仅提案、history 为 branch truth、
    deterministic projection 为唯一 world-state 生成路径。
