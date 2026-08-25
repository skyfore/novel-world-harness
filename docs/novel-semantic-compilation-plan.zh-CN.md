# 技术计划：可溯源的全书小说语义编译

- **状态：** 进行中——M0 gold schema/baseline scaffold、M1 至 M4、M5a、M5b-1、M5b-2a、M5b-2b 与 M6 的直接证据失效修复已实现；M0 semantic scorer、M5c、M6 portability/传递依赖闭包与 M7 多小说 benchmark 待完成
- **日期：** 2026-08-25
- **本次代码基线验证：** `pnpm build`；`pnpm test`（109 个测试文件、618 项测试通过）
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

本计划最初发现的问题不是模型能力不足，也不是 prompt 长度不够，而是从
“source segment”到“canonical artifact”的跨度过大：

```text
原文字节
  -> chapter/block segment
  -> 模型一次性完成发现、消歧、事件合并、因果解释、状态映射、人物归纳
  -> entity / claim / event / character model
```

M0 至 M5b-2b 已经把实体/事件 mention、引语、discourse、身份/事件 resolution、
命题/归因、参与角色、typed event relation、角色/关系/空间/world-rule ontology
作为可版本化对象接入 proposal、验证、prepared snapshot、audit 和 actor-safe runtime。
宿主现在解析 exact selector，模型不能伪造可信 offset/hash；章节 reparse 也已按
区间包含清理章节内直接语义依赖
（[proposal-tools.ts](../src/compiler/proposal-tools.ts#L114)、
[evidence-assertions.ts](../src/compiler/evidence-assertions.ts#L29)、
[reparse.ts](../src/commands/reparse.ts#L278)）。

因此下图是**研究基线**，不再是完整的当前流程：

- 这个字段由原文哪一句支持？
- 这是原文明说，还是模型推断？
- “他”“丞相”“孟德”为什么被合并成同一人物？
- 两个事件是因果、前提、时间相邻，还是同一事件的子事件？
- 角色性格变化来自哪次经历，是否只在某个对象或情境下成立？
- 还有多少原文没有被纳入世界模型？

当前实现已经在 segment 和 canonical proposal 之间增加了非权威的
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

该改造没有引入数据库、向量检索或第二套世界真值。Annotation 和 resolution
仍然只是编译观察/决策；canonical artifact 也是接受后的编译参考而非活跃分支
事实，只有 runtime commit 能建立 branch truth。

本次深审确认，当前主要风险已经转移到五个更窄但更关键的闭环缺口：

1. scene/discourse 能被观察，但 deterministic structure 实际只物化
   work/paragraph/sentence/non-scene；尚无被接受的 scene membership 把事件、地点、
   时间和参与者连成可执行世界切片；
2. exact evidence binding 在当前 workspace 可审计，但 prepared bundle 没有携带
   assertion/binding，恢复到另一 workspace 后会丢失字段级 provenance；
3. semantic gold schema 已定义，但评分函数仍把所有已标注 semantic layer 标成
   `not-implemented`，不能证明长篇 extraction precision/recall；
4. typed causality 已可验证和审计，但 runtime frontier 仍消费兼容
   `causalParents`；relation 的 mechanism/requiredConditions 尚未成为执行条件；
5. 章节内直接失效已修复，mention → resolution → canonical → runtime 派生物的
   传递 impact closure 仍未实现。

所以当前系统可以宣称“机制可追溯、约束可执行”，不能宣称“任意长篇小说已被
完整且正确理解”。后续路线图以消除这五个证据链断点为目标。

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

### 2.2 章节和 block 是传输结构；scene 观察尚未成为世界分解

当前 segment 仍只有 `section | block`
（[segments.ts](../src/compiler/segments.ts#L16)）。章节识别依赖内置标题模式或
受限的前缀/数字/后缀规则，过大的 section 再按字节、行数和空行切开
（[chapter-split.ts](../src/compiler/chapter-split.ts#L15)、
[segments.ts](../src/compiler/segments.ts#L323)）。这是一套安全的 prompt 传输结构。

M2 已增加 `StructuralUnit` vocabulary 和独立 discourse observation；但代码审查
发现 `materializeSourceStructure` 当前实际只生成 work、paragraph、sentence 与
blank `non-scene`，并把 `discourseSegments` 初始化为空
（[structure.ts](../src/compiler/structure.ts#L87-L167)）。模型可另行记录 scene、
summary、flashback、flashforward、dream、embedded-document 等可重叠 observation，
并验证 viewpoint/mention/quotation/event mention 的引用闭包
（[annotations.ts](../src/compiler/annotations.ts#L124-L181)、
[annotations.ts](../src/compiler/annotations.ts#L550-L634)）。

这已经把 prompt batch、基础结构、话语观察和证据 span 分开，却还缺一个接受后的
`SceneOccurrence/SceneMembership`：当前 canonical event 有 story time 与
narrative context，但没有稳定引用 source scene observation，也没有统一表达 scene
的地点、时间窗口、参与者集合、viewpoint 和跨章 continuation。因此“识别出一段
flashback”并不等于“已经把它编进可执行世界”。

叙事计算研究通常用时间、地点、人物集合和持续行动共同定义 scene，而不是依赖
章节版式
（[Detecting Scenes in Fiction](https://aclanthology.org/2021.eacl-main.276/)）；
后续研究也指出章节属于编辑结构，cliffhanger 可能把同一 scene 分在两章
（[Rethinking Scene Segmentation](https://aclanthology.org/2025.latechclfl-1.8/)）。

**结论：** 现有 transport 与 observation 层方向正确；下一步不是继续细切 chunk，
而是显式 resolve scene occurrence，并把 event/location/time/participant membership
作为有证据、可 revision、非 branch-truth 的编译对象。

### 2.3 精确引用已实现，但 portable provenance 与语义蕴含仍未闭环

基础 `SourceSpan` 记录行号、字节范围和 `quoteHash`，`EvidenceVerifier` 会验证
不可变 source identity、范围与哈希
（[model.ts](../src/world/model.ts#L19)、
[evidence.ts](../src/compiler/evidence.ts#L21)）。M1 又加入宿主解析的 exact selector、
JSON Pointer target、supports/contradicts relation 与 derivation。Assertion revision
和 artifact-hash binding 独立保存，避免仅因 compiler provenance 改变就制造新的
世界 revision
（[evidence-assertions.ts](../src/compiler/evidence-assertions.ts#L15-L130)）；本地
artifact retrieval 也能返回字段路径、强度和精确 anchor
（[artifact-retrieval.ts](../src/compiler/artifact-retrieval.ts#L198-L213)、
[artifact-retrieval.ts](../src/compiler/artifact-retrieval.ts#L323-L334)）。

深审发现两个剩余断点：

1. 通用 target validator 只证明 JSON Pointer 存在、target ID 匹配，并不定义
   “每种 artifact 哪些字段必须有 assertion”；目前只有 character、relationship、
   spatial 和 controlled world-rule 等选定 ontology 具有逐项 support/counter 集合
   完全相等的专用 gate
   （[evidence-assertions.ts](../src/compiler/evidence-assertions.ts#L132-L163)、
   [world-rule-ontology.ts](../src/world/world-rule-ontology.ts#L199-L227)）。
2. `PreparedNovelBundle` 只序列化 canonical arrays，没有 assertion revision/binding
   table；publish 能在原 workspace 重跑部分 exact-evidence gate，但 materialize
   只恢复 canonical artifacts。因此跨 workspace cache restore 后，artifact 仍有
   portable `EvidenceRef`，字段级 assertion/provenance 却不可检索
   （[prepared-cache.ts](../src/compiler/prepared-cache.ts#L60-L92)、
   [prepared-cache.ts](../src/compiler/prepared-cache.ts#L676-L700)）。

[W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)
明确区分 TextPosition 与包含 exact/prefix/suffix 的 TextQuote selector；
[W3C PROV-O](https://www.w3.org/TR/prov-o/) 区分被生成的 Entity、生成 Activity
与负责的 Agent。本项目借用这两个建模原则，不需要采用 RDF。

**结论：** 当前系统可以证明“这条引用精确落在未变化的原文字节上”，并能对选定
ontology 强制字段级支持；它仍不能由结构校验自动证明“这句话语义上蕴含该断言”。
下一步必须补 portable assertion bundle、artifact required-evidence profile 和人工
entailment gold，三者不能相互冒充。

### 2.4 Mention/resolution 已补齐机制，长篇消歧质量仍未被测量

M3 已将 source observation 与 stable identity 分开：entity mention 保存 exact
surface/form/scene，deterministic lexical candidate 只负责召回候选，模型必须提交
resolved/new/ambiguous/unresolved 决策；event mention 与 event resolution 也把
trigger/extent、participant mention、coreference/subevent、merge/split revision
保留下来。Canonical name、alias、event 和 participant 的接受 gate 会反查这些
resolution，而不会因为字符串相似就自动合并
（[annotations.ts](../src/compiler/annotations.ts#L46-L122)、
[entity-resolution.ts](../src/compiler/entity-resolution.ts#L1)、
[event-resolution.ts](../src/compiler/event-resolution.ts#L1)）。

长篇 coreference 明显比短文档困难。BookCoref 的书级样本平均超过
20 万 token，并报告模型在书级长度上的性能退化
（[BookCoref](https://aclanthology.org/2025.acl-long.1197/)）。多语种文学
共指资源也显示中文等语言存在特有挑战
（[GOLEMcoref](https://aclanthology.org/2026.acl-short.39/)）。
官方 [BookNLP](https://github.com/booknlp/booknlp) 也把 mention、coreference、
quotation、entity 和 event 保持为不同输出层。

**结论：** mention/resolution 的 ontology 与 revision 生命周期已经存在，最危险的
“直接用一次模型输出创建身份”问题已被消除。剩余风险是 recall 与跨章 clustering
是否正确：当前没有多小说人工 gold，因而 unresolved queue 和内部 closure 只能证明
过程可审计，不能证明人物没有漏抽、误合并或错误拆分。

### 2.5 Typed 因果关系已可审计，但执行层仍是兼容投影

M4b-2 已增加一等 `EventRelation`：关系独立记录 before/after/during/contains/
overlaps/starts/finishes、causes/enables/prevents/motivates/explains、coreference/
subevent/narrative-continuation，以及 status、confidence、mechanism、
requiredConditions、support/counter evidence
（[model.ts](../src/world/model.ts#L388-L425)）。Catalog validator 检查 endpoint、
时间矛盾、重复/相反关系、causal/subevent/temporal cycle，并只把非 contested 的
`causes`/`enables` 无损投影到 legacy `causalParents`
（[event-relations.ts](../src/world/event-relations.ts#L22-L152)）。

这解决了“图无环就等于因果正确”的表示问题，却还没有完成执行迁移：

- `causes` 与 `enables` 在 compatibility projection 中仍折叠为同一种 parent；
- `requiredConditions` 目前只做 predicate/reference 验证，没有进入 frontier eligibility；
- possibility frontier 仍只消费 `possibility.causalParents` 与自身 preconditions，
  不读取 relation type、status、mechanism 或 condition
  （[frontier.ts](../src/world/frontier.ts#L33-L106)）；
- evaluator 仍按无类型 parent pair 评分，不测 type、status、evidence 或 mechanism。

带有强度、证据和其他属性的关系应成为一等对象，这属于
[W3C N-ary Relations Note](https://www.w3.org/TR/swbp-n-aryRelations/)
描述的关系建模问题。事件共指、时间、因果和 subevent 之间会互相制约，
[MAVEN-ERE](https://aclanthology.org/2022.emnlp-main.60/) 因而采用联合标注；
[EventRelBench](https://aclanthology.org/2025.findings-emnlp.482/) 也显示通用
LLM 在这些关系任务上仍不可靠。

**结论：** typed relation 已完成“表示与审计”，下一步要完成“condition-aware
执行与反事实评测”。Mechanism 仍是解释性 provenance，不能直接写 world truth；
只有其 required condition 在当前 branch state 被确定性满足时，关系才可支撑对应
runtime dependency。

### 2.6 Proposition/Attribution/Knowledge 路径已分层，但仍缺语义 gold

M4a 已把 reusable `Proposition` 与 narrator/character/document/unknown holder 的
`Attribution` 分开；polarity/modality/valid story time 属于命题，asserts/knows/
believes/suspects/reports/denies/questions、certainty、nested source attribution 与
quotation IDs 属于归因。`KnowledgeDelta learn` 仍保留 legacy claim ID，同时增加
content-compatible proposition、attribution 与 observed/told/read/inferred/
remembered/deceived-misattributed acquisition mode
（[model.ts](../src/world/model.ts#L146-L206)、
[attribution-trace.ts](../src/compiler/attribution-trace.ts#L34-L176)）。接受一个
proposition/attribution 只确认它是 source-grounded interpretation，不把命题提升为
WorldState 或任何角色知识；角色知识仍只由 committed KnowledgeDelta 派生。

引语语料通常分别标注 quote span、speaker、addressee 和 cue
（[RiQuA](https://aclanthology.org/2020.lrec-1.104/)）；事件 factuality
研究还需要显式来源和 certainty
（[Event Factuality and Modal Dependency](https://aclanthology.org/2021.acl-long.122/)）。
[ISO-TimeML](https://aclanthology.org/L10-1027/) 也强调文本表达和它所指
事件之间的区别。

**结论：** authority 分层已经落地。剩余问题不是再增加一个自由字段，而是建立
quotation/attribution/acquisition 的人工 gold 与矛盾案例：当前 closure 能拒绝悬空
speaker/addressee 和不合法获取路径，却不能证明模型把自由间接引语、讽刺、撒谎或
不可靠叙述解释正确。

### 2.7 角色发展 authority 正确，性格 ontology 不可比较

当前 goal 已支持知识门槛、事件/时间激活、completion、expiry、milestone
和 candidate action
（[actors.ts](../src/world/actors.ts#L26)）。Development phase 也能依赖
状态、canonical event、角色亲历事件、知识和 story time
（[actors.ts](../src/world/actors.ts#L67)）。

M5a 之前的主要问题——现在保留的 legacy 兼容路径——是 traits 与
decisionBiases 仍可表示任意字符串到数值的 map
（[actors.ts](../src/world/actors.ts#L115)）：

- `brave`、`courage`、`勇敢` 可能成为三个维度；
- 数值没有行为锚点；
- 不区分稳定 disposition、当前 affect、策略和对特定对象的态度；
- 没有 supporting/counter evidence；
- 没有 context、target 和有效时间；
- 多次模型运行之间无法可靠比较。

角色近期经历还固定取最后 12 个直接参与事件
（[development.ts](../src/world/development.ts#L104)），不一定能保留最重要的
目标、关系和创伤性经历。

[PersonaBank](https://aclanthology.org/L16-1163/) 将角色目标、动机、
时间线和 affective impact 放在同一故事表示中；
[Story Commonsense](https://aclanthology.org/P18-1213/) 则关注事件前后的
动机和情绪链。

**结论：** 保留“从历史派生角色发展”的设计，但用版本化行为维度、
target-specific relationship stance、appraisal episode 和 development
episode 代替无定义 trait 字符串。

M5a 已把这个结论落到代码。`character-v1` 注册了 8 个有共同定义与行为
锚点的非诊断性维度，以及 10 个受控情境 ID
（[character-ontology.ts](../src/world/character-ontology.ts#L14)、
[character-ontology.ts](../src/world/character-ontology.ts#L30)）。Disposition
显式拆分 scope、稳定性、推断依据、有效时间、置信度与
supported/contested；基于行为推断 stable disposition 至少需要两个不同原文
span，narrator 明示则必须包含 explicit evidence
（[character-ontology.ts](../src/world/character-ontology.ts#L170)）。Appraisal
把 experienced/reported/inferred event 与 interpretation proposition、受控情绪、
受影响 goal 和 resulting intention 相连；DevelopmentEpisode 则独立记录
trigger mode、before/after disposition、机制、时间、衰减与反转
（[character-ontology.ts](../src/world/character-ontology.ts#L223)、
[character-ontology.ts](../src/world/character-ontology.ts#L242)）。

这些约束不是只写在 prompt 中：V2 schema 拒绝未加 `legacy:` namespace 的
自由 trait/bias key（[actors.ts](../src/world/actors.ts#L112)）；prospective graph
和 commit validator 会拒绝悬空 actor/event/proposition/goal/disposition 引用
（[validator.ts](../src/compiler/validator.ts#L570)）；逐条 supporting/counter
exact assertion 必须与嵌入的 source span 一致，并在 submit、closure、commit、
audit 与 prepared publication 边界重复校验
（[character-ontology.ts](../src/world/character-ontology.ts#L390)、
[prepared-cache.ts](../src/compiler/prepared-cache.ts#L886)）；runtime 仅激活非 contested、
且 event/experience/story-time gate 已满足的记录
（[character-ontology.ts](../src/world/character-ontology.ts#L542)）。给模型的角色
视图会剥离 evidence 与内部 artifact ID，并隐藏 actor 不可见目标的
target-specific disposition
（[character-ontology.ts](../src/world/character-ontology.ts#L632)）。

#### 2.7.1 M5b-1：关系不是一个无方向的“强度”

M5b-1 实施前，执行层其实已经有正确骨架：relationship 是稳定 entity，
`relationship.from/to` 给出方向，`character.relationships` 只保存关系 entity ID。
但仍保留的 legacy 字段暴露了三个压缩问题：`relationship.kind` 是任意字符串，
`relationship.strength` 用一个数混合 trust、affinity、fear、dependence 等不同
概念，`relationship.obligations` 只是无类型 entity set
（[state.ts](../src/world/state.ts#L160)）。CharacterModel 当时也没有逐对象的关系
stance、义务内容、变化原因或事件/知识门控，因而 renderer 能知道“有关系”，
actor policy 却不能可靠回答“谁对谁、在哪个维度、因何、何时改变”。

外部研究支持的是建模原则，而不是本仓库某一组标签。W3C 的
[N-ary Relations ontology pattern](https://www.w3.org/TR/swbp-n-aryRelations/)
建议：当一个关系还带置信度、强度或其他属性时，应把关系实例建成可单独引用的
对象；Social Relations Model 则区分 actor、partner 和特定 dyad 的 effect，并
明确 relationship effect 可以是方向不对称的
（[Kenny, SRM information](https://davidakenny.net/srm/soremo.htm)）。文学计算研究
同样发现整本小说中的关系会随时间演化，静态词典无法表达这种变化
（[Feuding Families and Former Friends](https://aclanthology.org/N16-1180/)）。
PersonaBank 把角色时间线、目标/动机和事件的 affective impact 相连，而不是把
角色归纳成孤立标签
（[PersonaBank](https://aclanthology.org/L16-1163/)）。因此本项目采用
“稳定 directed relationship identity + 分维度 actor policy + event/knowledge
gate”的工程子集；6 个 stance 维度和 9 个 obligation 类型是本仓库的版本化受控
词表，不宣称是通用心理测量标准。

已实现的 `relationship-v1` 包含：

- 12 个 primary relationship type、6 个有负/中/正行为锚点的 directed stance
  维度，以及 9 个 typed obligation 类别
  （[relationship-ontology.ts](../src/world/relationship-ontology.ts#L16)）；
- `RelationshipStance` 把 actor、relationship entity、target、维度、值、稳定性、
  basis、有效时间、supported/contested、置信度与逐项证据绑定；非 narrator
  明示的 stable stance 至少需要两个不同 source span
  （[relationship-ontology.ts](../src/world/relationship-ontology.ts#L174)）；
- `RelationshipObligation` 用 proposition 保存精确内容，用 event、actor
  experience、knowledge 和 story time 控制激活/解除；`RelationshipChange`
  显式连接同一 directed pair 的 before/after stance/obligation、trigger event、
  mechanism proposition、时间窗口与 reversal
  （[relationship-ontology.ts](../src/world/relationship-ontology.ts#L199)）；
- reference closure 会检查 actor/target/relationship kind、event presence、claim、
  proposition、before/after pair 一致性；exact assertion 必须逐项与嵌入
  EvidenceRef 完全相等
  （[relationship-ontology.ts](../src/world/relationship-ontology.ts#L283)、
  [relationship-ontology.ts](../src/world/relationship-ontology.ts#L359)）；
- runtime 只有在当前分支 state 同时证明 `character.relationships` membership、
  `from === actor`、`to === target`、`active === true` 和受控 `type` 时才投影策略；
  future change 必须等待 committed/experienced/known trigger，reversal 后恢复被替换
  策略
  （[relationship-ontology.ts](../src/world/relationship-ontology.ts#L434)、
  [relationship-ontology.ts](../src/world/relationship-ontology.ts#L582)）；
- actor-safe view 按可见 target 聚合，但删除 evidence、proposition/event ID、
  relationship entity ID 和编译解释；同一投影现已进入 proactive actor、reactive
  NPC、player choice/narration 三条模型边界
  （[relationship-ontology.ts](../src/world/relationship-ontology.ts#L528)、
  [model-actor-policy.ts](../src/world/model-actor-policy.ts#L181)、
  [npc-reaction.ts](../src/world/npc-reaction.ts#L258)、
  [play-opening.ts](../src/world/play-opening.ts#L295)）。

关系存在/方向/type/active 仍是 committed event history 派生的 WorldState；stance
和 perceived obligation 只是 CharacterModel 的版本化 policy input，绝不反向写
世界真值。`relationship.type` 现在由 StateSchema 的 `allowedValues` 确定性拒绝
自由值；旧 kind/strength/obligations 仅为 snapshot 兼容保留
（[model.ts](../src/world/model.ts#L297)、[state.ts](../src/world/state.ts#L162)）。
Audit 分别报告 relationship entity 的 directed/type coverage、legacy operation、
stance/obligation/change 数量和引用错误；prepared publication 对
`relationship-v1` 重跑 exact evidence gate
（[audit.ts](../src/compiler/audit.ts#L636)、
[prepared-cache.ts](../src/compiler/prepared-cache.ts#L890)）。测试覆盖 schema、
reference closure、未来信息隔离、wrong-direction fail-closed、reversal、actor-safe
脱敏、exact selector 注入与 audit coverage
（[relationship-ontology.test.ts](../test/relationship-ontology.test.ts#L1)、
[proposal-tools.test.ts](../test/proposal-tools.test.ts#L420)、
[compiler-audit.test.ts](../test/compiler-audit.test.ts#L263)）。

#### 2.7.2 M5b-2a：地点身份、拓扑邻近与可通行路径不是同一事实

M5b-2a 前，地点已经是稳定 `Entity`，动态位置、开放状态与控制者也已经是
`WorldState` 字段；但执行层只有 `character.location` 的精确 ID 比较，既没有地点
包含层级，也不能区分“相邻”与“存在可走路径”，更无法验证方向、交通方式或最短
时间。这样会产生两类相反错误：模型可能把地图上的邻接直接当作通路；也可能把
“人在城堡”与“人在城堡内房间”误判为确定异地。现有 typed state registry 仍是
动态位置/控制权的权威边界，拓扑则必须成为独立、可版本化、可引用的 canonical
artifact（[state.ts](../src/world/state.ts#L127)、
[spatial-ontology.ts](../src/world/spatial-ontology.ts#L58)）。

外部标准支持这种拆分，但本项目只实现执行所需的小型子集。OGC
[GeoSPARQL 1.1](https://docs.ogc.org/is/22-047r1/22-047r1.html) 把拓扑关系作为
可独立查询的二元空间关系，并区分多组关系词表；W3C
[Spatial Data on the Web Best Practices](https://www.w3.org/TR/sdw-bp/) 强调空间
对象应有稳定、可复用的标识，并用适合应用的机器可读关系表达连接；W3C
[OWL-Time](https://www.w3.org/TR/owl-time/) 则把数值时长和时间单位显式分开。
因此这里不引入 RDF、坐标或几何推理，而是保留稳定 location entity，再编译
`contains`、`adjacent`、`route` 三类显式关系。

已实现的 `spatial-v1` 包含：

- `contains` 表示直接容器，`adjacent` 是规范化的无向邻接，`route` 独立记录
  from/to、单/双向、受控交通方式和可选 minimum/typical/maximum duration；
  所有关系还带 basis、public/observable/knowledge/engine visibility、有效故事时间、
  建立/废止事件、state/rule gate、supported/contested、置信度与逐条证据
  （[spatial-ontology.ts](../src/world/spatial-ontology.ts#L19)、
  [spatial-ontology.ts](../src/world/spatial-ontology.ts#L39)、
  [spatial-ontology.ts](../src/world/spatial-ontology.ts#L58)）；
- prospective closure、commit、prepared publication 和 snapshot hydration 都会检查
  endpoint 必须是本 source 的 location，event/claim/rule/predicate 引用必须闭合，
  静态 containment 不得多父或成环；时间/state gate 解算后还会对当前激活的
  containment 重跑单父与无环检查，避免两个各自合法的历史候选在同一分支同时
  激活后破坏拓扑
  （[spatial-ontology.ts](../src/world/spatial-ontology.ts#L145)、
  [spatial-ontology.ts](../src/world/spatial-ontology.ts#L264)、
  [context.ts](../src/world/context.ts#L138)）；
- 模型不能提交自造 byte offset/hash。`propose_spatial_relation` 只接受 exact selector，
  host 解出可信 anchor 后回填 EvidenceRef；support/counter assertion 集合必须与
  artifact 内嵌 evidence 完全相等，并在提交与 prepared cache 再验证
  （[proposal-tools.ts](../src/compiler/proposal-tools.ts#L115)、
  [spatial-ontology.ts](../src/world/spatial-ontology.ts#L205)、
  [prepared-cache.ts](../src/compiler/prepared-cache.ts#L942)）；
- runtime 的通行证明只遍历 active `route`，绝不把 `adjacent` 当 passage；路径解析
  确定性遵守方向和显式 `travelMode`，累加所有已知 minimum duration，并拒绝无路径、
  交通方式不匹配或时间推进过短的 compiled-location arrival
  （[spatial-ontology.ts](../src/world/spatial-ontology.ts#L317)、
  [player-action.ts](../src/world/player-action.ts#L1148)）；
- 精确相同地点或 active containment 的祖先/后代地点只说明“可能处于同一物理
  scope”，不会被旧的字符串不等规则直接判成远程互动；它仍不自动证明房间间可通行
  （[spatial-ontology.ts](../src/world/spatial-ontology.ts#L290)、
  [player-action.ts](../src/world/player-action.ts#L1230)）；
- actor/model 只能看到 endpoint 已可引用且 visibility/knowledge gate 满足的 active
  关系；投影删除 evidence、confidence、内部 relation/event/claim/rule ID，随后再把
  location ID 换成 turn-local opaque handle。engine 可使用完整 topology 做确定性校验，
  但隐藏路线不会因此泄漏给角色
  （[spatial-ontology.ts](../src/world/spatial-ontology.ts#L405)、
  [player-action.ts](../src/world/player-action.ts#L773)）；
- canonical snapshot 升至 v7 并固定 spatial relation revision；旧 v1-v6 snapshot
  以“无 spatial-v1 契约”加载，避免新路径约束倒灌历史分支。Audit 新增 containment、
  adjacency、route、direction、duration、gate、visibility、contest、reference issue 与
  location topology coverage 指标
  （[context.ts](../src/world/context.ts#L45)、
  [context.ts](../src/world/context.ts#L201)、
  [audit.ts](../src/compiler/audit.ts#L685)、
  [audit.ts](../src/compiler/audit.ts#L1184)）。

测试覆盖 schema、悬空/非地点 endpoint、多父/环、动态 gate、方向/方式/时长、
adjacency 不可通行、层级 scope、actor 知识隔离、exact assertion、proposal→commit、
prepared/context 回归和 snapshot revision pinning
（[spatial-ontology.test.ts](../test/spatial-ontology.test.ts#L1)、
[spatial-runtime.test.ts](../test/spatial-runtime.test.ts#L1)、
[proposal-tools.test.ts](../test/proposal-tools.test.ts#L475)、
[canonical-revisions.test.ts](../test/canonical-revisions.test.ts#L80)）。

边界也必须明确：本阶段不从“距离近”“同一地区”或叙述顺序推断通路，不把未知
duration 补成常识值，不做经纬度/几何计算；`location.controller` 仍由 committed
event history 派生的 WorldState 决定。当前路径选择以最少 hop、已知 minimum duration
和 logical ID 确定性打破平局，不承诺现实世界最优路线。

#### 2.7.3 M5b-2b：世界规则必须区分适用、义务、禁止、例外与优先关系

旧 `WorldRule` 只有 scope、`appliesWhen`、`requires`、`forbids` 和 artifact 级
evidence，无法表示规则来源、管辖范围、可废止性、例外、冲突优先关系和角色是否
知道该规则。更危险的是，如果把一个整数 `priority` 当成隐式冲突解决器，两个模型
提案可能在没有原文根据时改变世界法则。

已实现的 `world-rule-v2` 将这类语义编成受控 canonical artifact：

- rule 记录 physical/social/legal/magical/institutional kind，global/entity/location/
  faction/institution scope，authority、jurisdiction、applicability、具体 story-time、
  visibility、knowledge claim、priority、defeasible 与显式 `overridesRuleIds`；
- 每条 require/forbid clause 和每个 exception 都有独立 ID、basis、supported/
  contested、confidence、support/counter evidence；contested item 永不执行；
- legal/institutional rule 必须有有效 authority，bounded jurisdiction 的 entity kind
  和 applicability binding 必须闭合；unknown reference、同一 rule 自相矛盾、
  override 不可废止规则、priority 非严格上升与 override cycle 都 fail closed；
- priority **只排序和校验**，不会自行压过另一规则。只有证据支持的显式 override
  edge 才能停用较低、defeasible rule
  （[model.ts](../src/world/model.ts#L710-L835)、
  [world-rule-ontology.ts](../src/world/world-rule-ontology.ts#L90-L197)）。

这一取舍与一手标准的建模原则一致：
[OASIS LegalRuleML 1.0](https://docs.oasis-open.org/legalruleml/legalruleml-core-spec/v1.0/os/legalruleml-core-spec-v1.0-os.html)
用显式 `Override` 表示规则 superiority，并把 defeasibility 与 rule strength 分开；
[W3C ODRL 2.2](https://www.w3.org/TR/odrl-model/) 分开 permission、prohibition、duty
及其 constraints，并要求显式 conflict strategy，未声明时默认 conflict invalid。
本项目没有照搬法律 ontology，而是实现小说 runtime 所需的最小确定性子集。

Runtime 先从 committed `activeRuleIds` 中解析 time/applicability/exception/override，
在 pre-state 检查 require，在拟议 delta 后的 post-state 检查 forbid；隐藏或角色未知
的规则仍由 engine 执行，但不会进入 actor/NPC prompt
（[world-rule-ontology.ts](../src/world/world-rule-ontology.ts#L230-L328)、
[engine.ts](../src/world/engine.ts#L255-L283)）。这保持了“执行”和“披露”分离。
Audit 统计 controlled/legacy、kind/scope、clause/exception、defeasibility、override、
visibility、exact evidence 与 reference issue；跨 rule 的潜在 require/forbid 冲突只做
诊断，只有有效显式 override 才标为已解决
（[audit.ts](../src/compiler/audit.ts#L1299-L1328)、
[audit.ts](../src/compiler/audit.ts#L1489-L1506)）。

M5 现在只剩 M5c deterministic salience；goal hierarchy/conflict/commitment 以及更深的
institution/faction/artifact/economy domain module 应由 benchmark 暴露的真实失败驱动，
不应先凭想象扩大 ontology。

### 2.8 Source accounting 已有内部 denominator，仍没有独立语义 recall 分母

编译 prompt 明确优先构造 bounded high-leverage graph，而不是穷举 mention；单 batch
最多 24 个 active proposal、40 次一般工具调用
（[batches.ts](../src/compiler/batches.ts#L705-L727)、
[proposal-tools.ts](../src/compiler/proposal-tools.ts#L442-L447)）。M2/M3 后，Audit 已能
用基础 structural unit 与已产生 observation 计算 source accounting、entity/event
resolution 和 proposition-attribution coverage
（[audit.ts](../src/compiler/audit.ts#L1384-L1409)）。这些 denominator 对发现“已观察
但未处理”的缺口有价值。

语义 gate 仍只有在已经抽到至少 20 个事件时才运行
（[audit.ts](../src/compiler/audit.ts#L1366-L1374)）。更关键的是，
`compilerGoldSchema` 虽然已经定义 mention、cluster、quotation、participation、
event relation、proposition、knowledge、state effect 与 character assertion，实际
`evaluateCompilerAgainstGold` 仍只读取 entity/claim/event/rule/goal/model 和 legacy
causal parent ID；每个被标注的 semantic layer 都返回 `not-implemented`
（[compiler-eval.ts](../src/eval/compiler-eval.ts#L397-L511)）。`三国演义` fixture 只
验证字节和 120 回章节形态，不验证语义
（[corpus README](../fixtures/corpus/README.md#L19)、
[corpus-fixture.test.ts](../test/corpus-fixture.test.ts#L8)）。

**结论：** source accounting 已实现，但“模型自己先找出的 mention 数量”不能作为
模型是否漏找 mention 的独立分母。必须实现 semantic evaluator 并加入人工 gold；
在此之前，内部 coverage 只能叫 pipeline accounting，不能叫全书 semantic recall。

### 2.9 Reparse 已修直接证据失效，仍缺传递 dependency closure

Bounded reconciliation 只有两轮，并限制每轮修复的 event/character 数量
（[reconcile-world.ts](../src/compiler/reconcile-world.ts#L15-L25)）。当前目标主要是
已知事件、角色或规则问题，而不是发现模型从未抽取的语义单元
（[reconcile-world.ts](../src/compiler/reconcile-world.ts#L417-L476)）。

本次深审修复了一个直接正确性缺陷：旧实现用 evidence span hash 完全相等匹配章节
batch，因而字段级 exact quote 子区间不会命中；同时遗漏 proposition、attribution、
event participation 和 event relation。当前实现改用 byte/line containment，并覆盖
所有 canonical collection、rule/spatial 的嵌套 evidence 及 character ontology
内部 evidence；只有“全部证据均在选中范围”的 artifact 被移除，跨章 artifact 保留，
immutable revision 与 branch pin 不受影响
（[reparse.ts](../src/commands/reparse.ts#L278-L365)、
[reparse.test.ts](../test/reparse.test.ts#L146)）。

仍未解决的是传递依赖：系统没有计算 mention → resolution → event/relation →
state/knowledge → character/possibility/prepared projection 的 impact closure。聚合型
CharacterModel 若同时含选中章和其他章的 evidence，也只能整体保留，无法只标记其中
一个 disposition/appraisal stale。

**结论：** 直接章节失效已安全修复；M6 仍需显式 `ArtifactDependency`、stale/review
状态和 impact plan。Missing semantic unit 与 stale downstream artifact 必须成为
可查询对象，而不是依靠模型在下一次整章 prompt 中猜测。

### 2.10 深审后的风险排序

| 优先级 | 证据链断点 | 当前后果 | 改造判据 |
|---|---|---|---|
| P0 | Prepared bundle 不携带 exact assertion/binding | cache restore 后字段 provenance 丢失 | 任意 workspace restore 后 assertion 数量、hash、target 与发布前完全相同 |
| P0 | Semantic gold scorer 未实现 | 无法知道 mention、因果、角色和知识抽取是否正确 | 每个已标注 layer 输出 alignment、precision、recall、F1，不再显示假 `not-implemented` 原因 |
| P0 | 无传递 artifact dependency graph | 局部 reparse 可留下 stale downstream semantic | dry-run 能列出直接/传递 impact，commit 后无 dangling current ref，旧 branch 仍 replay |
| P1 | Scene 只是 observation | 世界拆分无法稳定连接地点、时间、人物与事件 | 跨章 scene occurrence 可 resolve/revision，event membership 与 discourse order 分离 |
| P1 | Typed causal condition 未进入 frontier | `causes`/`enables` 执行上仍近似相同 | required condition 在当前 branch 不满足时关系不能解锁 possibility；反事实测试通过 |
| P1 | 近期经历固定 `slice(-12)` | 重要但较早的目标、关系或创伤事件被挤出 actor context | deterministic salience 按目标/关系/未解决义务/新近度组合，actor-safe 且 replay 稳定 |
| P2 | institution/faction/artifact/economy 仍是粗粒度 state fields | 程序、资源流、物品能力难表达 | 只有 benchmark 中重复失败的领域才增加受控 module 与 migration |

P0 是“证据是否可携带、结果是否可测、修复是否完整”的发布可信度问题；P1 是
“世界是否能执行得更像原作”的语义能力问题；P2 必须后置，避免 ontology 在没有
语料证据时膨胀。

### 2.11 外部资料的采用边界

| 一手资料 | 本计划采用的原则 | 明确不推出的结论 |
|---|---|---|
| [W3C Web Annotation](https://www.w3.org/TR/annotation-model/) | position 与 exact/prefix/suffix quote selector 分离 | 不要求 RDF，也不证明引用对断言的语义蕴含 |
| [W3C PROV-O](https://www.w3.org/TR/prov-o/) | source entity、compiler activity、agent/provenance 分离 | provenance 完整不等于模型解释正确 |
| [Detecting Scenes in Fiction](https://aclanthology.org/2021.eacl-main.276/) 与 [Rethinking Scene Segmentation](https://aclanthology.org/2025.latechclfl-1.8/) | scene 依赖时间、地点、人物与行动连续性，可能跨 chapter | 不直接采用论文模型或其 label 作为 runtime truth |
| [BookCoref](https://aclanthology.org/2025.acl-long.1197/)、[GOLEMcoref](https://aclanthology.org/2026.acl-short.39/) 与 [BookNLP](https://github.com/booknlp/booknlp) | 长篇/多语文学共指困难；mention、cluster、quote、entity/event 应分层 | 不把任一外部 pipeline 输出自动接受为 canonical identity |
| [W3C N-ary Relations](https://www.w3.org/TR/swbp-n-aryRelations/)、[MAVEN-ERE](https://aclanthology.org/2022.emnlp-main.60/) 与 [EventRelBench](https://aclanthology.org/2025.findings-emnlp.482/) | 带 type/status/evidence/mechanism 的关系应为一等对象；event relation 任务仍困难 | 关系 schema 合法不代表因果判断正确 |
| [RiQuA](https://aclanthology.org/2020.lrec-1.104/)、[Event Factuality and Modal Dependency](https://aclanthology.org/2021.acl-long.122/) 与 [ISO-TimeML](https://aclanthology.org/L10-1027/) | quotation、speaker/addressee/cue、conceiver/certainty、文本 mention 与所指事件分开 | narrator/character assertion 不自动成为 world truth |
| [PersonaBank](https://aclanthology.org/L16-1163/) 与 [Story Commonsense](https://aclanthology.org/P18-1213/) | 目标、动机、affect、事件前后变化应连接时间线 | 不采用诊断性人格标签，也不从常识补写原作心理 |
| [GeoSPARQL 1.1](https://docs.ogc.org/is/22-047r1/22-047r1.html)、[Spatial Data on the Web BP](https://www.w3.org/TR/sdw-bp/) 与 [OWL-Time](https://www.w3.org/TR/owl-time/) | 空间 identity/topology/route 与 duration/unit 分离 | 邻接不等于可通行，不从现实地图推断小说世界 |
| [OASIS LegalRuleML 1.0](https://docs.oasis-open.org/legalruleml/legalruleml-core-spec/v1.0/os/legalruleml-core-spec-v1.0-os.html) 与 [W3C ODRL 2.2](https://www.w3.org/TR/odrl-model/) | 规则类型、约束、例外/冲突策略与显式 superiority 分开 | priority 数字本身没有推翻另一规则的权威 |
| [W3C SHACL](https://www.w3.org/TR/shacl/) | data 与 constraints 分离，输出逐约束 result，验证不改输入 | 不引入 RDF store；Zod/TypeScript validator 仍是本项目执行边界 |

所有外部资料只支撑 ontology 设计原则和评测必要性；仓库是否实现某项能力，以前述
本地代码与测试引用为准。

## 3. M0-M4、M5a、M5b-1、M5b-2a 与 M5b-2b 完成后的当前流程

```text
nwh ingest
  -> 注册 source metadata
  -> 不可变 source archive
  -> chapter/block segment manifest
  -> 确定性 work/paragraph/sentence/non-scene structure

compile-source / prepare-all
  -> 构造不跨章节的 bounded batch
  -> 每 batch 新建 Pi compiler session
  -> 注入 bounded、可分页 artifact catalog
  -> 提供 source-scoped lexical find/read
  -> 记录精确 entity/event mention、quotation、discourse observation
  -> 记录显式 entity/event resolution decision
  -> 模型提交 typed proposal 与 supporting/contradicting exact selector
  -> 宿主解析可信 anchor、EvidenceRef 与 derivation provenance
  -> character-v1 分离 disposition、appraisal 与 development proposal
  -> relationship-v1 分离 directed stance、typed obligation 与 relationship change
  -> spatial-v1 分离 contains、adjacent 与 direction/mode/duration route
  -> world-rule-v2 分离 applicability、require/forbid clause、exception 与 explicit override
  -> finish 校验 source accounting 与 prospective semantic graph
  -> pending proposal store

accept / prepare
  -> 验证 source hash 与 span
  -> 验证 mention-resolution 与 exact target trace
  -> 验证引用、state schema、participation、epistemic、event/character/relationship/spatial/world-rule ontology
  -> dependency order 与 semantic cycle check
  -> 接受为 immutable canonical revision
  -> prepared publication 重复 whole-catalog projection/readiness gate

audit / reconcile
  -> source-accounting denominator 与 observation/resolution coverage
  -> exact evidence、participation、epistemic、typed causality、character、relationship、spatial 与 rule metric
  -> bounded repair queue；完整 dependency impact closure 留待 M6

reparse
  -> 以 byte/line containment 失效 selected span 内直接 source-backed current artifact
  -> 重新生成 revision
  -> 既有 branch 继续 pin 旧 prepared revision

runtime
  -> committed event history 为 branch truth
  -> Snapshot V7 固定 proposition/attribution/participation/event-relation/spatial-relation revision
  -> typed semantic record 只派生 compatibility event view，不成为 branch truth
  -> character/relationship policy 仅由 committed/experienced/known trigger 激活并保持 actor-safe visibility
  -> active spatial route 确定性约束 compiled arrival 的方向、方式与已知最短时间
  -> active world rule 在 pre/post state 执行 require/forbid，exception/explicit override fail closed
  -> 确定性投影 state、knowledge、scene、development 和 frontier
```

实现仍保持 segment -> batch -> proposal -> validation -> explicit acceptance
-> replay 的权威顺序（[technical-design.md](technical-design.md#L933)）。Source
annotation 与 resolution 已成为 world proposal 之前的非 canonical 层；finish
closure 会拒绝不完整的 prospective graph
（[proposals.ts](../src/compiler/proposals.ts#L316)）。M5a 角色语义、M5b-1 directed
relationship、M5b-2a spatial 与 M5b-2b world-rule 语义现已完成编译、source scope、
审计与 runtime gate。后续仍需 M5c salience selection，M6 的 portable evidence、
semantic evaluator 与 dependency-driven impact closure，以及 M7 的多小说人工标注
semantic benchmark。

### 3.1 研究基线的主要失真点

| 位置 | 当前压缩 | 后果 |
|---|---|---|
| block -> entity | mention 与 identity 合一 | 难以解释或修复跨章消歧 |
| block -> event | event mention 与 occurrence 合一 | 重复描述、回忆和 subevent 易混淆 |
| segment -> evidence | context window 与 citation span 合一 | 无法证明具体字段 |
| participants[] | participation 与 semantic role 合一 | 谁做了什么不明确 |
| causalParents[] | 多种 event relation 合一 | 拓扑有效但语义可能错误 |
| claim | proposition、holder、certainty 合一 | narrator/rumor/belief 容易污染 truth |
| trait map | disposition、affect、stance 合一 | 角色模型不稳定、不可比较 |
| location ID equality | 包含、邻接与通路合一或缺失 | 远程互动误判，移动方式/耗时无法验证 |
| flat world rule | 适用、条款、例外与优先关系合一 | 规则冲突可能靠任意 priority 被静默解决 |
| extracted count | inventory 与 coverage 合一 | 漏抽对象不会进入分母 |

## 4. 目标权威架构

| Plane | 对象 | 权威级别 |
|---|---|---|
| Source | immutable bytes、source manifest | 原文 ground truth 边界 |
| Structure | chapter、paragraph、scene candidate、discourse span | 派生/候选，不是世界真值 |
| Annotation | mention、quotation、proposition mention、event mention | 原文观察，非 canonical |
| Resolution | identity cluster、event coreference、time/relation hypothesis | 版本化编译判断，仍需接受 |
| Canonical | entity、proposition、event、event/spatial relation、rule、character model | 接受后的编译参考 |
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
  quotationIds?: string[];
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

实现进度说明（2026-08-25）：M4a 已完成。M4a-1 将 `Proposition` 与
`Attribution` 落为 source-scoped、不可变 revision 语义 artifact，并接通
proposal、closure、依赖排序、validator、检索、audit、prepared cache、
branch snapshot 与删除生命周期。payload 暂时保留兼容用
`EvidenceRef[]`；字段级 `EvidenceAssertion` 继续由 host 以 artifact revision
为键独立存储，避免在 payload 内复制 assertion ID。M4a-2 为 attribution
增加 quotation ID，校验 character holder 与已解析 speaker、`told` 接收者与已解析
addressee，并将 proposition/attribution/acquisition provenance 接入 compiler
closure、commit、possibility validation、replay、actor projection、prepared
revision 和 audit。`claimId` 继续作为必需的 runtime key，因此旧 prepared
revision 和事件历史仍可读取，新语义字段保持 additive。bridge 只接受能
无损投影到 legacy claim 的 positive/asserted proposition；更丰富的
polarity/modality 在 M4b 替换该 projection 前保持 semantic-only。proposition
与 attribution 均不会自动升级为 world truth。

M4b-1 也已实现。`EventParticipation` 现在是独立 versioned 的
event/entity/semantic-role assertion；character scene presence 是与 role
分离的可选维度，不能再把“在场”误写成“施事”
（[model.ts](../src/world/model.ts#L247)）。catalog validator 会拒绝未知引用、
role/entity kind 不相容、重复 role、冲突 presence，以及任何不能无损投影回
legacy event 字段的 typed inventory
（[event-semantics.ts](../src/world/event-semantics.ts#L18)、
[event-semantics.ts](../src/world/event-semantics.ts#L90)）。compiler finish 会在
checkpoint 前验证 canonical + pending 的 prospective catalog
（[proposals.ts](../src/compiler/proposals.ts#L471)）；prepared publication 与
runtime snapshot hydration 复用同一闸门。Snapshot V5 固定 participation
revision，再派生兼容 event view，不直接改写 world truth
（[context.ts](../src/world/context.ts#L174)、
[context.ts](../src/world/context.ts#L298)）。audit coverage 只统计真实存在的
legacy event/entity slot，孤儿或多余记录不能虚高覆盖率
（[audit.ts](../src/compiler/audit.ts#L514)）。

M4b-2 现已实现。`EventRelation` 已成为独立、不可变 revision artifact；type、
证据状态、confidence、mechanism、条件、支持证据与反证均可单独审阅
（[model.ts](../src/world/model.ts#L360)）。模型侧工具 schema 会剥离支持证据和
反证的可信引用；模型只提交 exact quote selector，宿主独占 byte range/hash
解析权，并把 `contradicts` selector 转成关系反证
（[proposal-tools.ts](../src/compiler/proposal-tools.ts#L215)、
[proposal-tools.ts](../src/compiler/proposal-tools.ts#L850)）。确定性 catalog
validator 校验 endpoint closure、story-time 相容性、inverse normalization、
重复/反向/overlap 矛盾、causal/temporal/subevent cycle，以及与 legacy
`causalParents` 的精确等价
（[event-relations.ts](../src/world/event-relations.ts#L26)、
[event-relations.ts](../src/world/event-relations.ts#L71)）。只有非 contested 的
`causes`/`enables` 能进入兼容投影；`narrative-continuation` 与 contested
解释可以保留审阅，但不能成为 runtime causal ancestry
（[event-relations.ts](../src/world/event-relations.ts#L22)、
[event-relations.ts](../src/world/event-relations.ts#L56)）。compiler 在 finish
前验证 canonical + pending 的 prospective relation graph
（[proposals.ts](../src/compiler/proposals.ts#L392)、
[proposals.ts](../src/compiler/proposals.ts#L504)）；单条与批量 accept 也会在
commit 前验证 prospective canonical relation catalog
（[validator.ts](../src/compiler/validator.ts#L114)）。prepared publication 复用
同一 catalog gate，Snapshot V6 固定 relation revision，并仅在 hydration 时
派生 legacy event view，不改写 canonical artifact
（[context.ts](../src/world/context.ts#L64)、
[context.ts](../src/world/context.ts#L284)）。Audit 按真实 legacy causal edge
计算 typed coverage，并报告 relation 数量与 validation issue，额外关系不能虚高
分母（[audit.ts](../src/compiler/audit.ts#L550)）。

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
  confidence: number;
  evidence: EvidenceRef[];
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
    | "contains"
    | "overlaps"
    | "starts"
    | "finishes"
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
  evidence: EvidenceRef[];
  counterEvidence?: EvidenceRef[];
};
```

与其他迁移后的 semantic artifact 一样，字段/关系级 exact binding 存放在
宿主管理的 `EvidenceAssertionStore` 中，并按不可变 artifact revision 绑定；
payload 保留经过校验的 `EvidenceRef[]`，用于兼容和 source-scope enforcement。

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

版本化 domain modules（character/relationship/spatial/world-rule 已实现受控子集，
其余只按 benchmark 失败推进）：

- character physical/status/resource；
- artifact identity/custody/quantity/condition；
- [M5b-2a 已实现] spatial containment/adjacency/route/travel mode/duration；
- institution membership/authority/procedure；
- faction alignment/control；
- [M5b-1 已实现] directed relationship stance/obligation；
- [M5b-2b 已实现] world-rule applicability/clause/exception/explicit override。

```ts
type ControlledWorldRule = {
  ontologyVersion: "world-rule-v2";
  id: string;
  name: string;
  kind: "physical" | "social" | "legal" | "magical" | "institutional";
  scope: "global" | "entity" | "location" | "faction" | "institution";
  authorityEntityId?: string;
  jurisdictionEntityIds: string[];
  appliesWhen: Predicate[];
  validStoryTime?: StoryTime;
  visibility: "public" | "observable" | "knowledge" | "engine";
  knownByClaimIds: string[];
  priority: number;
  defeasible: boolean;
  overridesRuleIds: string[];
  clauses: Array<{
    id: string;
    modality: "require" | "forbid";
    predicate: Predicate;
    basis: "explicit" | "inferred";
    status: "supported" | "contested";
    confidence: number;
    evidence: EvidenceRef[];
    counterEvidence?: EvidenceRef[];
  }>;
  exceptions: Array<{
    id: string;
    appliesWhen: Predicate[];
    basis: "explicit" | "inferred";
    status: "supported" | "contested";
    confidence: number;
    evidence: EvidenceRef[];
    counterEvidence?: EvidenceRef[];
  }>;
  basis: "explicit" | "inferred";
  status: "supported" | "contested";
  confidence: number;
  evidence: EvidenceRef[];
  counterEvidence?: EvidenceRef[];
};
```

验证策略借鉴 [W3C SHACL](https://www.w3.org/TR/shacl/) 将 data graph 与 shape/
constraint 分开、输出逐约束 validation result 且验证期间保持输入不变的原则；实现仍是
TypeScript/Zod、本地 JSON、proposal validation 和 immutable revision，不引入 RDF。

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
  scope: Global | Context | Target | ContextTarget;
  stability: "stable" | "situational";
  basis: "explicit-characterization" | "repeated-behavior" | "inferred-pattern";
  validStoryTime?: StoryTime;
  status: "supported" | "contested";
  confidence: number;
  evidence: EvidenceRef[];
  counterEvidence?: EvidenceRef[];
};

type AppraisalEpisode = {
  id: string;
  actorId: string;
  eventId: string;
  interpretationPropositionId: string;
  basis: "experienced" | "reported" | "inferred";
  emotion: { label: string; intensity: number };
  affectedGoalIds: string[];
  resultingIntention?: string;
  status: "supported" | "contested";
  evidence: EvidenceRef[];
  counterEvidence?: EvidenceRef[];
};

type DevelopmentEpisode = {
  id: string;
  actorId: string;
  triggerMode: "world" | "experienced";
  triggerEventIds: string[];
  beforeDispositionIds: string[];
  afterDispositionIds: string[];
  mechanism: string;
  startsAt: StoryTime;
  endsAt?: StoryTime;
  decay: None | EventDependent;
  evidenceStatus: "supported" | "contested";
  evidence: EvidenceRef[];
  counterEvidence?: EvidenceRef[];
};
```

约束：

- 初始只建立 actor policy 真正需要的小型受控词汇。
- Context 同样使用小型受控 ID，不让任意 prose 重新变成不可比较的 policy key。
- 单次行为不能自动证明稳定性格，除非有 narrator 明示或重复证据。
- disposition、current affect、target-specific stance、value、goal、tactic 分开。
- 旧自由 trait key 迁移成 `legacy:<key>`，不静默映射。
- Development 仍从 committed history 投影。
- active/resolved/reversed runtime status 必须从 branch head 派生，不能复制编译器
  对完整 canonical arc 的全知结论；linear decay 等 trigger event 能映射到确定性
  elapsed time 后再实现。
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
| Relationship | directed type、stance、obligation、change | pair/type F1、change F1、evidence support、future-leakage failure |
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
context、salience、closure、分页与 audit count。M3b-2 也已在
`src/compiler/event-resolution.ts` 与
`src/compiler/event-resolution-retrieval.ts` 实现：deterministic
evidence/title/participant candidate、显式 coreference/subevent cluster、
resolved/new-event/ambiguous/unresolved 决策、immutable merge/split revision、
participant/canonical-event trace gate、分页、恢复与 major-event audit
coverage；M3 至此完成。

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

实现状态（2026-08-25）：M4a、M4b-1 与 M4b-2 已完成。proposition/attribution identity 与
quotation-backed knowledge acquisition 已接通 source、identity resolution、
closure、commit、replay 和 audit gate。typed event participation 也已接通
revision、retrieval、closure、prepared、snapshot、removal 与 audit 生命周期，
并强制与 legacy participant/presence 无损等价。typed event relation 现已具备
独立 evidence/status/confidence、temporal/causal/subevent 图校验、prepared/
snapshot/audit 生命周期，以及排除 contested 与 narrative-only 关系的 versioned
无损 `causalParents` 兼容投影。

改造：

- quotation/proposition/attribution；
- event participation/relation store；
- temporal relation validator；
- knowledge acquisition 引用 proposition/attribution；
- legacy claim/causalParents projection；
- compiler prompt/catalog 更新。

主要文件：

- `src/world/model.ts`；
- `src/world/event-semantics.ts`；
- `src/world/context.ts`；
- `src/world/knowledge.ts`；
- `src/compiler/proposals.ts`；
- `src/compiler/validator.ts`；
- `src/compiler/batches.ts`；
- `src/compiler/audit.ts`；
- `src/compiler/prepared-cache.ts`；
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

状态：**M5a、M5b-1、M5b-2a 与 M5b-2b 已完成并验证，M5c 待完成。** Character、
directed relationship controlled registry、nested host-owned evidence、
prospective/commit/prepared validation、audit metric 与 actor-safe runtime
projection、spatial topology/route runtime gate，以及 controlled world-rule 的
authority/jurisdiction/clause/exception/override 与 pre/post-state enforcement 均已实现
（[character-ontology.ts](../src/world/character-ontology.ts#L14)、
[relationship-ontology.ts](../src/world/relationship-ontology.ts#L16)、
[world-rule-ontology.ts](../src/world/world-rule-ontology.ts#L15)、
[proposal-tools.ts](../src/compiler/proposal-tools.ts#L312)、
[audit.ts](../src/compiler/audit.ts#L636)）。

改造：

- [M5a 已实现] controlled character dimension registry；
- [M5a 已实现] disposition/appraisal/development episode；
- goal hierarchy/conflict/commitment；
- [M5b-1 已实现] directed target-specific relationship identity/type、stance、
  typed obligation 与 before/after change；
- [M5b-2a 已实现] spatial contains/adjacent/route、visibility、event/state gate、
  travel mode/minimum duration 与 snapshot pinning；
- [M5b-2b 已实现] world-rule kind/scope/jurisdiction/authority、逐条 clause/exception、
  visibility、defeasibility 与 explicit override；
- deterministic salience memory。

主要文件：

- `src/world/actors.ts`；
- `src/world/development.ts`；
- `src/world/state.ts`；
- `src/world/relationship-ontology.ts`；
- `src/world/spatial-ontology.ts`；
- `src/world/world-rule-ontology.ts`；
- `src/world/model-actor-policy.ts`；
- `src/compiler/proposals.ts`；
- `src/compiler/audit.ts`。

完成标准：

- V2 prepared world 不接受未注册 trait key；
- disposition/development 有 context、time、evidence；
- affect、disposition、stance、goal 分开；
- reverse direction 不能复用 forward stance，future relationship policy 不会提前激活；
- 每条 relationship semantic record 有逐项 exact support/counter-evidence；
- actor projection 保持 deterministic 和 knowledge-safe。
- adjacency 不会被当作 route；compiled arrival 必须匹配 active route 的方向、
  travel mode 与已知 minimum duration；旧 snapshot 不被追溯施加新约束。
- contested rule/clause/exception 不执行；priority 不会在缺少显式 override 时静默解决
  冲突；engine-hidden/unknown rule 仍执行但不会泄漏到 actor prompt。

### M6：Dependency-aware Audit、Reconcile 与 Reparse

目标：缺失和过期语义能够被发现并安全修复。

状态：**直接证据失效修复已完成；portable evidence、semantic evaluator 与传递
impact closure 待完成。** 章节 reparse 现已覆盖全部 canonical semantic collection、
嵌套 ontology evidence 与 exact subspan containment，并保持跨章 artifact 和旧分支。

改造：

- prepared bundle 增加 versioned evidence assertion revision/binding manifest，
  publish/activate/materialize 校验 artifact hash 与 target closure；
- 为 entity/event/proposition/attribution/participation/relation/character/spatial/rule
  定义 required-evidence profile，区分 blocking、review 与 optional target；
- 实现 semantic gold alignment 和每层 precision/recall/F1；
- 从 typed records 重建 dependency graph；
- source anchor 变化后计算 impact closure；
- downstream artifact 标记 stale/review-required；
- reconcile 读取 accounting gap 和 unresolved queue；
- 新 readiness/publication gate；
- 保持 branch pinning/rollback。

主要文件：

- `src/compiler/audit.ts`；
- `src/compiler/evidence-assertions.ts`；
- `src/eval/compiler-eval.ts`；
- `src/compiler/reconcile-world.ts`；
- `src/commands/reparse.ts`；
- `src/compiler/prepared-cache.ts`；
- `src/workflow/prepare.ts`。

完成标准：

- prepared revision 在另一 workspace materialize 后仍能逐字段检索相同 exact
  assertion，旧 bundle 明确进入 legacy evidence mode；
- gold 中每个已标注 semantic layer 都被真实评分，未实现维度不能进入 macro F1；
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

### 分批实施、迁移与逐步验收

每个 package 必须独立完成“schema/实现 → unit/integration → full suite → commit”，
不得把多个 authority 变化压进一个不可回滚提交：

1. **P0-A Portable evidence。** Bundle format 增加可选 `evidenceAssertions` 与 bindings；
   publish 复制 immutable assertion revisions，materialize 先恢复 assertions 再恢复
   canonical current refs，activate 对 artifact hash、assertion hash、source scope 和
   JSON Pointer 做全量校验。旧 v1 bundle dual-read，但 audit 标记
   `portableExactEvidence=unknown`，不能伪装为满足新 gate。
2. **P0-B Semantic evaluator。** 先实现 exact/overlap anchor matching，再实现 entity/
   event cluster alignment，随后评 participation role、typed relation、proposition/
   acquisition、state effect 与 character assertion。Macro F1 只聚合真正 evaluated
   layer；每个 false positive/negative 输出 gold ID、actual ID 和 alignment reason。
3. **P0-C Dependency graph。** 引入 versioned typed edge（evidence-target、mention-
   resolution、canonical-reference、projection-input）；`reparse --dry-run` 输出直接与
   transitive impact、preserve reason 和 branch pins，确认后只移动 current refs，永不
   删除 immutable revision。跨章聚合 artifact 标为 `review-required`，不静默保留为新鲜。
4. **P1-A Scene occurrence。** 在 discourse observation 之上增加 scene resolution；
   显式记录 source anchors、story interval、location、participant membership、viewpoint、
   continuation/coreference，并允许一个章节多个 scene、一个 scene 跨章节、flashback
   与 frame overlap。CanonicalEvent 通过 membership 引用 occurrence，但 occurrence 不
   自身建立 branch truth。
5. **P1-B Conditional causality。** 将非 contested causes/enables 的
   `requiredConditions` 编译进 possibility dependency；commit/frontier 在当前 state
   确定性求值。新增“删去原因/条件后结果不可解锁”的 counterfactual tests，
   `narrative-continuation` 永远不能替代 causal support。
6. **P1-C Deterministic salience。** 替换固定 `slice(-12)`：候选来自 actor 亲历的
   committed history，按 unresolved goal、active obligation、relationship target、
   appraisal/development trigger、progress channel 与 recency 的版本化权重排序；相同
   branch/context 必须产生相同结果，且 actor-invisible event 永不入选。
7. **P2 Domain growth。** 只有当多小说 gold/e2e failure 重复证明现有 typed state
   不足时，才分别引入 institution procedure、faction command、artifact capability/
   custody flow 或 economy/resource ledger；每个 module 单独 ADR、ontology version、
   legacy migration 和 actor-visibility test。

完成 P0 后，项目才能可靠回答“编译结果是否可携带、可测量、可局部修复”；完成 P1
后，才能更可靠地回答“某个世界场景为何发生、谁能经历、何种条件使后续可能”；P2
只提升已被数据证明的领域表达能力。

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

M1 的本地 exact evidence 已完成，但 P0-A 的 portability 与 P0-B 的独立 denominator
仍是扩大 ontology 前的硬前置；否则只会扩大不可验证输出。

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

| 研究基线 | 当前已实现 | P0/P1 完成后 |
|---|---|---|
| Artifact 引用整个 prompt segment | 选定 ontology 的字段/关系使用 host-owned exact assertion | assertion 随 prepared revision 可携带，所有 required target 有显式 profile |
| 字节有效性与解释强度混合 | anchor hash、support/contradict、basis/status 已分开 | 独立 entailment gold 测量语义支持是否正确 |
| 模型直接创建 entity/event identity | mention inventory 与 entity/event resolution 有独立 revision | gold 测得跨章 cluster precision/recall，变更可算 impact closure |
| chapter/block 代表叙事结构 | 基础 structure 与 overlapping discourse observation 分开 | scene occurrence 跨章连接 location/time/participant/event membership |
| participant 是无角色 ID | typed participation role/presence 独立有 evidence | scene membership 与 actor experience 一致性可评测 |
| causalParents 混合多类关系 | typed relation 分开 cause/enable/prevent/motivate/time/subevent/continuation | required condition 驱动 frontier，并用反事实测试验证 |
| Claim 混合内容与来源 | proposition、attribution、quotation、acquisition 分开 | gold 覆盖不可靠叙述、自由间接引语、欺骗与知识路径 |
| trait 是任意 scalar key | character-v1、relationship-v1 有 context/time/target/正反 evidence | salience 由 goal/obligation/relationship/experience 确定性选择 |
| 空间与规则是粗粒度字段 | spatial-v1 与 world-rule-v2 已进入 engine/actor-safe projection | benchmark 驱动更窄的 institution/artifact/economy module |
| audit 只统计已抽取 inventory | source accounting 与内部 closure 已可报告 | 人工 gold 提供独立 semantic denominator 与 CI gate |
| reconcile/reparse 只修少量旧 artifact | selected chapter 直接 evidence dependency 已完整失效 | dry-run/commit 计算全部 downstream impact 并标记聚合 semantic stale |

P0/P1 完成后系统能够在明确置信边界内回答：

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
