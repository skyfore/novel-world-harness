# 迭代 01 技术设计：在小说世界里行动（Act in Novel World）

| 项 | 值 |
|---|---|
| 状态 | 已定稿；第 9 节的决策已于 2026-11-18 确认，可按第 7 节开工 |
| 日期 | 2026-11-18 |
| 代码基线 | `13c926b` |
| 验证语料 | 《龙族1》（本机 `~/.novel-harness` 工作区，798 KB，79 个正典事件，38 个场景） |
| 文档性质 | 后续开发的指导方向；工作包可直接拆成任务执行 |

## 1. 目标

**迭代目标**：在《龙族1》的真实编译产物上，用户可以选择任意一个已准入的场景、以该场景中任意一个在场角色的身份开局，连续行动 20 回合以上；世界对行动有回应，正典剧情会推进或被偏离，全部历史可冷重放。

**成功标准**（详见第 8 节）：

1. 至少 20 个场景可入场，每个场景至少 1 个可入场角色。
2. 至少 1 个非开场场景完成 20 回合真实模型游玩，冷重放一致，零知识越界。
3. 20 回合内正典位置按时间线前进；未被玩家破坏的正典事件会自己发生。
4. 每回合的结果有度量数据（接受率、世界回应率、正典步进率、延迟），用来决定下一迭代的优先级。

**非目标**：

- 全书认证（保留为最高等级，不在本迭代关键路径上）。
- 运行时生成全新剧情线（等本迭代的度量数据出来后再定）。
- 提高全书抽取密度（只做入场和行动直接需要的局部补全）。
- 数据库、向量检索、对"提案→校验→提交"边界的任何放松。

## 2. 背景：为什么现在一步都走不了

### 2.1 现状事实

| 事实 | 证据 |
|---|---|
| 入场是"每个角色一个固定入口"，没有场景参数 | `src/world/entry-context.ts:107`、`src/web/contracts.ts:764-771` |
| 全书任何一处残留问题都否决全部入场 | `src/compiler/certification.ts:108`、`:162` |
| 龙族：77/77 批次完成，869 个 issue，0 分支，0 次游玩 | 本机工作区 |
| 时间权威是模型给的自由标量 `orderHint`，被当成全局严格序 | `src/compiler/proposal-tools.ts:916`、`src/world/time.ts:52-53` |
| `orderHint` 跨批次不连贯：第 6–9 段用 70–100，第 10–13 段用 30–50 | 本机工作区 |
| 72 条场景执行失败全部是 `ENTRY_TIME_UNKNOWN` | `src/world/entry-cut.ts:71` |
| 没有类型化效果的正典事件，运行时无法提交 | `src/world/frontier.ts:410-421` |
| 龙族 79 个事件中 29 个没有任何状态、知识或时间效果；另有 8 个以它们为必要因。合计 37 个（47%）在游玩中永远不会发生 | 本机工作区 |
| 79 个事件的 `timeAdvance` 全部为空，正典不推进时间 | 本机工作区 |
| 普通回合默认不推进正典后台事件 | `src/world/play-experience.ts:508-513` |

### 2.2 "在小说世界里行动"需要的三项保真

| 保真项 | 含义 | 现状 | 本迭代的组件 |
|---|---|---|---|
| 处境保真 | 入场和每回合后的处境与小说在该时刻一致，不泄露未来 | 无法入场；派生入口没有场景细节来源 | 时间线、切面准入、入场包、阅读视界 |
| 行动权 | 玩家的自由意图能被表达、被认真对待、受世界约束 | 回合链路已存在，但从未在真实数据上跑过 | 行动探针（先度量，再修） |
| 回应连续性 | 其他角色和正典动量按小说的方式回应，故事持续前进 | 近半正典事件不可提交；离屏正典不前进 | 正典步进器、NPC 台词参照 |

### 2.3 原型验证

我用只读脚本直接读取龙族工作区的正典产物做了原型。状态归约是简化版（只处理 set/unset），没有经过引擎校验，"可入场"类数字是估计。

| 发现 | 数据 |
|---|---|
| 精确话语坐标已存在 | 79/79 个事件都能经"事件消解 → 事件提及标注"拿到字节锚点，跨度中位数 108 字节 |
| 事件自带 evidence 太粗 | 79 个事件只有 19 个不同起点，跨度中位数 30 KB |
| 话语序与显式约束零冲突 | 36 条显式顺序约束（22 enables、8 causes、4 before、2 相对时间）无一矛盾，可排出 79/79 全序 |
| 入场可派生 | 95 个"场景 × 在场角色"对中 65 个可入场：19 个用已有检查点，31 个靠重放状态，15 个靠场景地点；覆盖 25 个角色、30/38 个场景 |
| 问题可局部化 | 869 个 issue 中 855 个已带节点归属；601 个阻塞单元集中在 331–379 KB 和 508 KB 两处；20 个场景在第一个阻塞单元之前 |
| 节拍可分类 | 62/79 个事件有施事者。主角在场的 49 个事件里，13 个他是施事者，29 个是别人，7 个无施事信息 |
| 台词可作角色参照 | 160 条引语中 145 条能解析到说话人实体，覆盖 32 个角色 |

## 3. 设计总览

```
编译期（冻结进 bundle）                     游玩期（分支）
┌──────────────┐                 ┌────────────────────────────────┐
│ ① 正典时间线  │──index──────────▶│ 入场：切面 + 角色 → Genesis      │
│ ② 切面准入清单│──tier/horizon───▶│                                │
│ ③ 入场包派生  │──seed───────────▶│ 回合：玩家 → NPC → 世界回应      │
└──────────────┘                 │        → ⑤ 正典步进 → 叙事       │
        ▲                        │ ④ 阅读视界：叙事/NPC 的原文边界   │
        │ 优先级                  └───────────────┬────────────────┘
┌──────────────┐                                  │
│ ⑥ 行动探针    │◀────────── 每回合度量 ────────────┘
└──────────────┘
```

六个组件：

1. **正典时间线**：全书正典事件的确定性全序，宿主推导，不由模型给。
2. **切面准入**：把"能不能玩"的判定单位从全书改成切面，问题只封锁受影响的切面。
3. **入场包派生**：对任意"场景 × 在场角色"确定性派生入场状态和知识。
4. **阅读视界**：分支在原文中"已经读到哪里"的确定性边界，叙事和 NPC 只能参照边界之前的原文。
5. **正典步进器**：按时间线顺序、逐个解决正典事件；别人的事会自己发生，玩家自己的事等玩家来做。
6. **行动探针**：对每个可入场切面跑脚本化回合，产出行动质量度量。

术语：**切面**指某个正典事件发生前那一刻的世界；**地平线**指从开场起连续可重放的最远时间线位置；**正典位置**指分支已经处理到时间线的哪里。

## 4. 详细设计

### 4.1 正典时间线

```ts
// src/world/canon-timeline.ts（新增）
type CanonTimeline = {
  version: 1; sourceId: string; subjectHash: string;
  entries: Array<{
    eventId: string; index: number; discourseByte: number;
    basis: "discourse" | "constraint";
    constraintIds: string[];
  }>;
  // 顺序是默认而非被证明、且写同一状态地址的事件对
  assumedPairs: Array<{ earlier: string; later: string; addresses: string[] }>;
  issues: ValidationIssue[];
};
function buildCanonTimeline(input: {
  events: readonly CanonicalEvent[]; relations: readonly EventRelation[];
  eventResolutions: readonly EventResolution[]; annotations: readonly SourceAnnotation[];
}): CanonTimeline;
```

算法（纯函数，无模型）：

1. **坐标**：`discourseByte` 取事件消解到的事件提及锚点的最小起始字节。缺锚点时退回 evidence 起点并报 `TIMELINE_ANCHOR_MISSING`（局部 issue）。
2. **约束边**：before/after/during/contains/starts/finishes 关系、相对时间锚、causes/enables（因先于果）、可比较的日历时间。contested 关系不用。
3. **排序**：拓扑排序，就绪集合里取 `discourseByte` 最小者。约束成环报 `TIMELINE_CONSTRAINT_CYCLE`（硬错误，封锁环内事件之后的切面）。
4. **叙事模式**：
   - hypothetical 不进时间线（现状如此）。
   - flashback、recollection 不做特殊前置，和其他事件一样按话语位置放置；只有带证据的显式约束才能把它们前移。
   - 没有任何显式约束的 flashback、recollection 报 `TIMELINE_FLASHBACK_UNANCHORED`（提示级，归属到该事件），用来驱动编译侧补 before/after 关系。
   - 理由见第 9 节决策 D3。
5. **`orderHint` 不参与排序**，字段保留仅作展示。

消费方：

| 消费方 | 改动 |
|---|---|
| `deriveEntryCut`（`src/world/entry-cut.ts:19`） | 切面成员由 `index` 决定。`ENTRY_TIME_UNKNOWN`、`ENTRY_BASELINE_UNKNOWN` 不再产生；`ENTRY_EFFECT_ORDER_UNKNOWN` 降为切面提示；共指效果冲突仍是硬错误 |
| 四个调用点 | `entry-context.ts:190`、`:213`，`source-history.ts:25`，`scene-execution-contracts.ts:106` |
| 读者前情顺序（`entry-context.ts:458`） | 现在按粗 evidence 行号排，改用时间线 |
| 前沿时间闸（`frontier.ts` 的 `assessTemporalCompatibility`） | 正典可能性改用 `index` 相对正典位置比较，见 4.5 |

落点：在 `PreparedNovelCache.buildBundle` 里计算，写入 `bundle.canonical.timeline`；`ScopedWorldArtifacts`（`src/world/context.ts:74`）和快照 schema（`:41`）加可选字段；`WorldModelContext.timeline`。

### 4.2 切面准入

```ts
// src/compiler/cut-admission.ts（新增）
type AdmissionTier = "blocked" | "replayable" | "enterable" | "reviewed" | "certified";
type CutAdmission = {
  cutId: string;               // contentHash({ beforeEventId, timelineHash })
  beforeEventId: string; sceneId?: string; index: number;
  tier: AdmissionTier;
  actors: Array<{ actorId: string; tier: AdmissionTier;
    entryBasis: "opening" | "checkpoint" | "derived"; issues: ValidationIssue[] }>;
  blocking: ValidationIssue[]; advisories: ValidationIssue[];
  dependsOn: string[];         // 闭包节点 key，用于失效
};
type AdmissionManifest = {
  version: 1; subjectHash: string; timelineHash: string;
  horizonIndex: number; cuts: CutAdmission[];
};
```

| 等级 | 条件 | 复用 |
|---|---|---|
| replayable | 时间线无硬错误；开场到切面的前缀逐事件通过引擎校验；切面话语位置之前没有阻塞性记账单元；依赖闭包内无悬空引用 | `executeSceneEvent`、`validateFrozenAccounting`、`buildPreparedClosure` |
| enterable（按角色） | 入场状态落地；7 个确定性探针通过 | `assessEntryState`、`playability.ts:64-88` |
| reviewed | 闭包内工件的机制支持评审、事件效果独立用例通过 | `assessSemanticSupport`、需求账本 |
| certified | 该入口的真实模型评估通过 | `novel-play-quality.ts`、4.7 的行动探针 |

规则：

- **issue 必须带节点归属。** 在 `assessNovelClosure` 汇总处统一补 `path`。无归属的全局 issue（名册、核心角色、评估未运行等）只影响 `certified`。
- **地平线**：从开场起连续 `replayable` 的最远 `index`。
- **门禁替换。** 新增 `assertCutAdmission(bundle, cutId, actorId, minTier)`，用于开局和激活。`assertPreparedReadiness` 保留，仅用于"全书认证"标识。
- **默认最低等级 `enterable`**，由配置 `play.minimumAdmissionTier` 控制，界面标注等级。
- **性能。** 清单沿时间线单次前向折叠算出，在每个场景首事件处取状态快照，冻结进 bundle；开局只校验哈希。现有做法是每个场景事件都从开场重放（`scene-execution-contracts.ts:44`），且每次开局重算。

### 4.3 入场包派生

```ts
// src/world/entry-context.ts（新增导出）
function deriveSceneEntrySeed(bundle: PreparedNovelBundle, cutId: string, actorId: string): CharacterEntrySeed;
```

依次尝试：开场 → 该事件上已编译的检查点 → 确定性派生。派生规则：

| 内容 | 来源 |
|---|---|
| 状态 | 前缀折叠。角色缺入场上下文、场景有 `locationId` 且角色在 `presentActorIds` 中时，补 `character.location`，证据取场景证据 |
| 在场 | 场景的 `presentActorIds`，模式 physical |
| 知识 | 前缀知识增量重放（`src/world/entry-knowledge.ts` 已有） |
| 过程与生效规则 | 现有合成逻辑（`entry-context.ts:225-278`） |
| 读者前情 | 各事件 `readerSummary` 按时间线序 |
| 场景细节 | 见 4.4 的引子段 |

派生不出时，只把这一个"切面 × 角色"标为 blocked 并带 `ENTRY_CONTEXT_MISSING`，不影响其他切面。

接口：

- `startFreshPlayRequestSchema` 增加可选 `cutId`；缺省为该角色首个可入场切面，旧请求行为不变。
- 新增场景列表：`GET /api/v1/novels/:id/cuts`，返回场景、可入场角色、等级。
- CLI：`nwh play --scene <sceneId> --character <id>`。
- `createWorldBranch`（`src/world/instance.ts:18`）增参 `entryCutId`；`branchSchema`（`src/world/model.ts:1818`）增可选 `entryCutId`。

### 4.4 阅读视界与场景落地

派生入口没有预制的场景导语，叙事模型如果拿不到场景文字就只能凭记忆编。需要一个确定性的原文边界，既给细节又不泄露未来。

```ts
// src/world/read-horizon.ts（新增）
type ReadHorizon = { horizonByte: number; frozenByDivergence: boolean; excludedRanges: Array<[number, number]> };
function deriveReadHorizon(timeline: CanonTimeline, resolved: ReadonlySet<string>,
  superseded: ReadonlySet<string>, mentionExtents: ReadonlyMap<string, Array<[number, number]>>): ReadHorizon;
```

定义：

- `horizonByte` 是时间线上下一个未解决事件的 `discourseByte`。
- 分支一旦取代过正典事件，边界停在第一次偏离事件的 `discourseByte`。之后的原文是没有发生的平行事实，不得作事实依据。
- `excludedRanges` 是所有未解决事件的提及范围，用来剔除边界之前的预叙。
- 一段原文可用，当且仅当它的结束字节不超过 `horizonByte`，且不与 `excludedRanges` 重叠。

三处使用：

| 使用点 | 改动 |
|---|---|
| 开场引子段 | `buildNarrativeSourceReferences`（`src/world/narrative-source.ts:41`）在第 0 步增加候选：同一章内、边界之前的原文，由近及远、按段落边界截取，权威为"仅呈现"。不新增常量，沿用现有上限（4 段、每段 1,800 字符、合计 6,000 字符，`:5-7`）；已提交且角色可见的文本优先占用额度，引子段只填剩余部分 |
| 运行时原文咨询 | `admitRuntimeContextProposal`（`src/agent/pi-runtime-context.ts:193`）现在信任模型自报的 `temporalClass`，再用工件关联排除未来；增加按字节位置的宿主判定，模型自报只能更严不能更松 |
| NPC 台词参照 | 见 4.6 |

**场景落地的最小契约**（编译侧）：每个场景要么有 `locationId`，要么显式标注地点未知及理由。缺失时报 `SCENE_LOCATION_MISSING`，归属到该场景，只封锁"靠场景地点补位"的派生入口。配一个窄范围补全批次，证据范围限定为该场景的话语段，按地平线顺序排队。龙族现状是 11/38 个场景有地点。

### 4.5 正典步进器

这是"推进剧情"的核心。现在的行为是：普通回合不推进正典；没有类型化效果的事件根本提交不了。

**(1) 正典发生本身计入实质性。** 实现一个正典事件是分支真相的一部分，它改变可能性空间。

- `progressChannelSchema`（`src/world/model.ts:1218`）新增通道 `occurrence`；`progressCertificateSchema` 新增 `canonicalOccurrence: boolean`。
- 条件：提案来源为 `canon-candidate`，`possibilityId` 指向未实现的正典事件，且不是改编。
- 改动点：`progress.ts` 的三个函数、`engine.ts` 的两处实质性判定、`frontier.ts:412-421` 的 `hasEffect`。
- 效果：龙族 37 个"永远不会发生"的事件变为可实现。

**(2) 正典位置与越过规则。**

- 正典位置 `p` 等于"已解决事件的最大 `index` 加一"。已解决指已实现、已改编或已取代；Genesis 解决切面之前的全部事件。
- `index < p` 且未解决的事件，状态为 `expired`（原因：已越过），其必要后继为 `invalidated`。复用 `propagateInvalidatedDescendants`。
- 取代 `runtime.ts:1012` 的 `temporalAnchor` 作为正典可能性的时间依据。

**(3) 窗口。** `possibilitySource`（`src/world/workspace-runtime.ts:40`）只物化 `index` 在 `[p, p+W)` 且不超过地平线的正典事件，`W` 默认 64。现在每次刷新都把全书事件重新映射并整份落盘。

**(4) 节拍分类。** 对当前玩家角色 `a` 和事件 `e`：

| 类别 | 判定 | 处理 |
|---|---|---|
| 离屏 | `a` 不是 `e` 的可参与者（`eventAvailableToActor`，`model.ts:308`） | 可行则由步进器自动提交 |
| 世界节拍 | `a` 可参与，施事者是别人 | 实体参与者与 `a` 同场且可行时自动提交；每回合至多 1 个 |
| 玩家节拍 | `a` 是施事者 | 不自动提交；作为选项提供给玩家；等待玩家 |
| 无施事信息 | `a` 可参与，没有施事者记录 | 只经世界回应通道提交（需模型在候选中选中） |

**(5) 步进过程。**

```ts
// src/world/runtime.ts（新增方法）
stepCanon(input: { branchId: string; actorId: string; expectedHead: CommitId;
  budget: number; worldBeatBudget: number }): Promise<CanonStepResult>;
type CanonStepResult = { newHead: CommitId; committed: string[];
  stoppedAt: "awaiting-player" | "budget" | "beyond-horizon" | "exhausted"; position: number };
```

从 `p` 起按时间线顺序扫描：

1. 已解决的跳过。
2. 超过地平线则停，返回 `beyond-horizon`。
3. 已失效或当前不可行的跳过；它们会在后面的事件提交时被越过。
4. 离屏且可行的，提交。
5. 世界节拍且可行的，在额度内提交。
6. 玩家节拍：停下，返回 `awaiting-player`。满足以下任一条件时跳过它继续扫描：
   - 它已连续 `K` 个被接受的玩家回合停在队首，`K` 默认 3；
   - 玩家本回合选择等待（等待就是"让事情自己发生"）；
   - 玩家已离开该场景。

**(6) 回合内的位置。** `performPlayTurn`（`src/world/play-experience.ts`）的顺序改为：玩家提交 → NPC 直接反应 → 世界回应 → 正典脚手架恢复 → `stepCanon` → 其他角色与非正典后台 → 叙事。

- 世界回应已提交正典事件时，本回合 `worldBeatBudget` 为 0。
- 普通回合 `budget` 默认 3；`wait` 和场景切换时默认 8。
- 删除"仅当本回合新否定正典才给 1 个后台名额"的规则（`:508-513`）。

**(7) 可见性不变。** 离屏事件提交后，玩家角色的知识不变；叙事上下文仍只含角色可见的事件。

**(8) 正典状态。** 向叙事上下文和界面暴露 `CanonStatus`：`following`、`diverged`、`beyond-horizon`、`exhausted`。不再静默停滞。

### 4.6 NPC 台词参照

NPC 反应模型现在只有 6/52 个角色有性格模型可用。160 条引语里 145 条能解析到说话人，是现成的角色声音来源。

- 在 NPC 反应和角色推理的输入里增加 `voiceReferences`：该角色在阅读视界之内的最近 6 条引语，每条不超过 240 字符。
- 来源：`compilerSnapshot.annotations` 中的引语标注，经说话人提及的实体消解到角色。
- 这些是角色自己说过的话，且发生在边界之前，不构成知识越界。
- 改动点：`src/world/npc-reaction.ts` 的角色视图、`src/agent/pi-npc-reaction.ts` 的提示。

### 4.7 行动探针

到现在为止没有任何一个真实回合在真实编译数据上跑过。探针先建立基线，再让数据决定修什么。

```ts
// src/eval/act-probe.ts（新增）
type ActProbeTurn = {
  intent: "observe" | "speak" | "follow-canon" | "deviate" | "move" | "wait";
  accepted: boolean; rejectedAt?: string; issueCodes: string[];
  committedByLane: Record<"player" | "npc" | "world-response" | "canon-step" | "actor" | "background", number>;
  canonPositionBefore: number; canonPositionAfter: number;
  modelCalls: number; latencyMs: number;
};
type ActProbeReport = { cutId: string; actorId: string; turns: ActProbeTurn[];
  replayEquivalent: boolean; knowledgeViolations: number;
  rates: { accept: number; worldResponse: number; canonStep: number; deadTurn: number } };
```

- 脚本：每个"切面 × 角色"跑 6 类意图，各 1–3 回合。`follow-canon` 取导演给出的正典向选项，`deviate` 取与之冲突的行动。
- 复用 `src/eval/novel-play-evaluator.ts` 的运行器、知识检查和重放等价检查。
- 两种模式：假模型（进 CI，验证管线）和真实模型（本地跑，产出报告）。
- 命令：`nwh compile-novel probe --source <id> [--cut <id>] [--live]`。
- "死回合"指玩家行动被接受、但世界没有任何回应事件的回合。

## 5. 接口与版本变更汇总

| 变更 | 位置 |
|---|---|
| `WORLD_ENGINE_VERSION` 0.36.0 → 0.37.0 | `src/world/model.ts:2010` |
| `WORLD_SCHEMA_VERSION` 3 → 4（`occurrence` 通道、`branch.entryCutId`、可能性的 `canonicalOrder`） | `model.ts:2009` |
| 快照 schema 增加可选 `timeline` | `src/world/context.ts:41` |
| bundle 增加 `canonical.timeline`、`admission` | `src/compiler/prepared-cache.ts` |
| 开局请求增加可选 `cutId` | `src/web/contracts.ts:764` |
| 新命令 `compile-novel cuts`、`compile-novel probe`；`play --scene` | `src/cli.ts` |
| 配置 `play.minimumAdmissionTier` | `src/config/schema.ts` |

引擎升版会使旧分支无法投影（`src/world/projection-service.ts:150`）。本机没有真实分支，影响只在测试夹具；本迭代不提供旧分支迁移，旧分支按现有提示拒绝。

## 6. 不变量

**保持不变**：

- 证据哈希校验；模型输出只是提案；叙事不写世界真相。
- 世界真相是提交历史；状态是派生投影。
- 角色知识与世界真相、未来正典隔离。
- 分支钉住冻结版本。
- 正典是引力而不是调度器：步进器只提交前置条件和必要因在本分支仍成立的正典事件。

**新增**：

- 时间顺序只来自宿主推导的时间线，模型标量不参与。
- 正典事件按时间线顺序解决；越过即过期。
- 叙事和 NPC 能看到的原文不超过阅读视界。
- 任何 issue 都有节点归属；没有归属的只影响最高等级。

## 7. 实施计划

顺序固定为 M1 → M2 → M3 → M4 → M5 → M6。M4 的探针先于 M5 的步进器，是为了拿到"没有步进器时"的基线。

### M1 时间线

| 工作包 | 改动点 | 完成标准 |
|---|---|---|
| 1.1 时间线纯函数 | 新增 `src/world/canon-timeline.ts`、`test/canon-timeline.test.ts` | 单测：话语序默认、约束移动、成环报错、未锚定的回忆按话语位置放置并给出提示、缺锚点 |
| 1.2 接入 bundle 与上下文 | `prepared-cache.ts`、`context.ts`、`engine.ts` 的 `WorldModelContext` | 新分支上下文带时间线；旧快照缺省时走旧逻辑 |
| 1.3 切面改为时间线驱动 | `entry-cut.ts` 与 4 个调用点；引擎升版 | `test/entry-cut.test.ts`、`test/entry-context.test.ts` 更新通过 |
| 1.4 诊断输出 | `nwh compile-novel cuts`（先只输出时间线） | 龙族：79/79 全序、0 环 |

### M2 切面准入

| 工作包 | 改动点 | 完成标准 |
|---|---|---|
| 2.1 issue 归属 | `certification.ts` 汇总处；code → 节点映射表 | 每个 code 一条单测；龙族无归属 issue 不超过 14 |
| 2.2 准入清单 | 新增 `src/compiler/cut-admission.ts`、`test/cut-admission.test.ts` | 合成 3 场景夹具：中间注入阻塞单元时前缀可入场、其后封锁；修复后单调恢复 |
| 2.3 探针按"切面 × 角色" | 从 `playability.ts` 抽出 `probeEntry` | `test/major-character-playability.test.ts` 不变通过 |
| 2.4 门禁替换 | `play-roles.ts`、`instance.ts`、`prepared-cache.ts`（`:457`、`:537`、`:781`）、`compile-novel.ts` 的 activate 阶段、配置项 | `test/novel-certification-gate.test.ts` 增加"部分准入可激活、封锁切面被拒" |
| 2.5 清单进诊断与 Web | `compile-novel cuts` 输出等级和首要阻塞；准备页显示覆盖率 | 龙族输出每个切面的等级 |

### M3 场景入场

| 工作包 | 改动点 | 完成标准 |
|---|---|---|
| 3.1 入场包派生 | `entry-context.ts` 的 `deriveSceneEntrySeed` | 单测：同一角色两个不同场景入场；状态为事件前；知识不含未来 |
| 3.2 接口 | `web/contracts.ts`、`play-service.ts`、`cli.ts`、`instance.ts`、`model.ts` | 旧请求不带 `cutId` 行为不变 |
| 3.3 阅读视界与引子段 | 新增 `src/world/read-horizon.ts`；`narrative-source.ts`；`pi-runtime-context.ts` | 单测：边界之后的原文和预叙范围被剔除；偏离后边界冻结 |
| 3.4 场景地点契约 | `SCENE_LOCATION_MISSING`；窄范围补全批次 | 龙族有地点的场景数从 11 提升；缺失的都有显式标注 |
| 3.5 枚举式端到端测试 | 假模型 + 不少于 10 个场景的合成小说 | 枚举全部可入场"切面 × 角色"，逐个开局、打 1 个玩家回合、冷重放一致 |

### M4 行动探针（基线）

| 工作包 | 改动点 | 完成标准 |
|---|---|---|
| 4.1 探针运行器 | 新增 `src/eval/act-probe.ts`、`test/act-probe.test.ts` | 假模型下 6 类意图跑通，报告字段齐全 |
| 4.2 命令与报告 | `compile-novel probe`；报告落盘到工作区 | 龙族真实模型跑出第一份基线报告 |
| 4.3 基线评审 | 按拒绝码和死回合率排出问题清单 | 清单写回本目录，作为 M6 的输入 |

### M5 正典步进器

| 工作包 | 改动点 | 完成标准 |
|---|---|---|
| 5.1 正典发生的实质性 | `model.ts`、`progress.ts`、`engine.ts`、`frontier.ts:412`；schema 升版 | 单测：无效果的正典事件可提交且只能提交一次；非正典空事件仍被拒 |
| 5.2 正典位置、越过规则、窗口 | `runtime.ts`、`frontier.ts`、`workspace-runtime.ts`、`canon-runtime.ts` | `test/canon-runtime.test.ts`、`test/p6-exit-acceptance.test.ts` 更新通过 |
| 5.3 步进器与节拍分类 | `runtime.ts` 的 `stepCanon`；`test/canon-stepper.test.ts` | 单测：离屏按序结算；世界节拍需同场；玩家节拍等待并在耐心耗尽后被越过；被取代的因果链不结算 |
| 5.4 回合集成 | `play-experience.ts` 的 `performPlayTurn` | `test/open-world-progression.test.ts`、`test/play-turn-idempotency.test.ts` 更新通过 |
| 5.5 正典状态 | 叙事上下文与界面的 `CanonStatus` | 到达地平线或时间线耗尽时有明确状态 |

### M6 按探针数据补强

| 工作包 | 改动点 | 完成标准 |
|---|---|---|
| 6.1 NPC 台词参照 | `npc-reaction.ts`、`pi-npc-reaction.ts` | 单测：只取阅读视界之内、说话人已解析的引语 |
| 6.2 复跑探针 | 同 M4 | 与基线对比，见第 8 节 |
| 6.3 修复按切面排队 | `compilation-handoff.ts` 按"地平线之后第一个封锁切面"分组 | `compile-novel plan` 首项是推进地平线的任务 |
| 6.4 基线清单中的前三项 | 由 4.3 的清单决定 | 各自的拒绝码占比下降 |

## 8. 验收

### 8.1 龙族 1 指标

| 里程碑 | 指标 | 现状 | 目标 |
|---|---|---|---|
| M1 | 时间线全序事件数、约束环 | 无 | 79/79、0 |
| M1 | 时间类场景执行失败 | 72 | 0 |
| M2 | replayable 切面 | 0/38 | 第一个阻塞单元之前的 20 个全部通过；通不过的有具体归因 |
| M3 | enterable"切面 × 角色" | 0 | 不少于原型估计 65 的八成，以引擎校验为准 |
| M3 | 非开场场景开局并完成开场叙事 | 0 | 至少 5 个不同场景 |
| M4 | 基线报告 | 无 | 覆盖全部可入场切面的 6 类意图 |
| M5 | 游玩中可实现的正典事件 | 42/79 | 79/79 |
| M5 | 20 回合内正典位置前进 | 不前进 | 跟随正典的脚本下每 3 回合至少前进 1 |
| M6 | 死回合率 | 待基线 | 比基线下降一半 |
| M6 | 连续游玩 | 0 | 至少 1 个非开场场景 20 回合，冷重放一致，零知识越界 |

### 8.2 自动化测试清单

- 新增：`canon-timeline`、`cut-admission`、`read-horizon`、`canon-stepper`、`act-probe`、枚举式端到端。
- 更新：`entry-cut`、`entry-context`、`canon-runtime`、`p6-exit-acceptance`、`open-world-progression`、`novel-certification-gate`、`play-opening`。
- 每个里程碑结束时全量 `pnpm check` 和 `pnpm test` 通过。

### 8.3 第二语料

M2 之后在三国演义上跑时间线和准入清单，检验多线并行叙事下话语序默认是否站得住。它目前只被做过字节哈希校验。

## 9. 决策记录与风险

### 9.1 决策记录（2026-11-18 确认）

| 编号 | 决策 | 理由 | 否决的方案 |
|---|---|---|---|
| D1 | 默认最低准入等级为 `enterable`，界面标注等级；`play.minimumAdmissionTier` 可调高 | 确定性探针通过就能玩，无人值守可达；要求 `reviewed` 会把只能人工提供的评审输入放回关键路径 | 默认 `reviewed` |
| D2 | 正典发生本身计入实质性：新增 `occurrence` 通道，世界 schema 3 → 4，引擎 0.36.0 → 0.37.0，不做旧分支迁移 | "某个正典事件在本分支发生了"是分支真相，会改变可能性空间；本机没有真实分支，升版成本只在测试夹具 | 把无效果事件当作场景节拍提交：不用升版，但借用了别的通道的语义，还要绕开节拍连续性校验 |
| D3 | 未锚定的回忆和闪回按话语位置放置，不自动前置到开场之前 | 前置一旦放错，会把未来的事实和知识带进更早的切面，直接违反"未来正典不是分支真相"和知识隔离；按话语位置最坏只是早期切面缺一个过去的事实，缺失比错误安全。实现也更简单，没有特殊分支 | 一律排到开场之前 |
| D4 | 玩家节拍的耐心值 `K` 为 3 个被接受的玩家回合；等待或离开场景立即越过。世界节拍每回合至多 1 个；步进预算普通回合 3、等待和场景切换 8。全部可配 | 步进器按顺序处理，停在玩家节拍时离屏世界也跟着停，所以等待必须有上限；1 个世界节拍避免正典跑在玩家前面 | 无限等待玩家；每回合不限世界节拍 |
| D5 | 引子段不新增常量，沿用现有叙事参照上限，已提交可见文本优先 | 现有上限已经过叙事提示的预算约束；先用探针数据看够不够 | 为引子段单开更大的额度 |

### 9.2 复查条件

这些默认值在以下情况出现时重新评估，不需要提前讨论：

- **D3**：三国演义的时间线里，带状态或知识效果的未锚定回忆超过 10 个，或探针报告出现因缺失过去事实导致的拒绝。
- **D4**：M6 复跑探针后死回合率没有降到基线的一半，或"跟随正典"脚本下正典位置跑到玩家前面超过 1 个场景。
- **D5**：开场叙事的校验失败率超过两成，或人工抽查发现场景细节明显靠编。

### 9.3 风险

| 风险 | 应对 |
|---|---|
| 话语序默认在强非线性叙事下排错 | 靠显式约束修正，`assumedPairs` 暴露风险；三国演义验证 |
| 修掉时间线后前缀重放在引擎校验上失败 | 没有运行过，数量未知；M2 的诊断输出给出逐切面归因 |
| 世界节拍自动提交让正典跑在玩家前面 | 每回合至多 1 个；额度和耐心值可配，按探针数据调 |
| 抽取稀疏导致世界"薄" | 本迭代不解决，探针让它可观测 |
| 每回合估计 7–9 个模型会话（按代码接线推算，未实测），延迟可能偏高 | 探针记录实际调用数和延迟；叙事快路径放到后续迭代 |

## 10. 后续迭代

- 运行时生成新可能性：正典耗尽或深度偏离后的剧情来源。
- 分支随修订快进：编译改进流入进行中的游玩。
- 叙事快路径：简单对话回合用单会话。
- 空间关系补全：龙族现在 0 条，玩家无法到达已编译的地点。
- 全书认证：在切面覆盖率到 100% 之后再做。

## 附录 A：关键代码索引

| 主题 | 位置 |
|---|---|
| 切面推导 | `src/world/entry-cut.ts:19` |
| 入口枚举与入场包 | `src/world/entry-context.ts:107`、`:166` |
| 场景事件前缀重放 | `src/world/source-history.ts:20` |
| 场景执行契约 | `src/compiler/scene-execution-contracts.ts:26` |
| 就绪评估与全书门禁 | `src/compiler/certification.ts:57`、`:162` |
| 角色探针 | `src/compiler/playability.ts:41` |
| 开局与分支创建 | `src/world/instance.ts:18`、`src/application/play-service.ts` 的 `startFreshPlay` |
| 引擎校验与提交 | `src/world/engine.ts:199`、`:751` |
| 前沿与可能性提交 | `src/world/frontier.ts:114`、`:410` |
| 运行时回合 | `src/world/runtime.ts:286`、`:499`、`:592`、`:705` |
| 玩家回合编排 | `src/world/play-experience.ts:328` 的 `performPlayTurn` |
| NPC 直接反应 | `src/world/npc-reaction.ts:159` |
| 玩家行动范围 | `src/world/player-action.ts:861`、`:1064` |
| 叙事导演 | `src/world/narrative-director.ts:93` |
| 运行时原文咨询 | `src/world/runtime-context.ts`、`src/agent/pi-runtime-context.ts:193` |
| 叙事原文参照 | `src/world/narrative-source.ts:41` |
| 真实模型评估 | `src/eval/novel-play-evaluator.ts` |
