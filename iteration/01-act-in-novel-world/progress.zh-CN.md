# 迭代 01 实施记录

本文件记录按 `tech-design.zh-CN.md` 第 7 节实施时的进度、实测指标和实现中做出的补充决定。设计文档本身不改；这里的决定若与设计冲突，以这里为准并说明理由。

验证语料：《龙族1》工作区（`a28585b1cf867f3e3a16`），通过 `PreparedNovelCache.repairCandidateSnapshot` 只读构建候选 bundle（约 190 秒，带 1 个 `SOURCE_ISOLATED_BASELINE_INVALID` 基线问题，不影响时间线与切面诊断）。

## M1 时间线（已完成）

| 工作包 | 提交 | 结果 |
|---|---|---|
| 1.1 时间线纯函数 | `feat(world): derive a deterministic canonical timeline` | `src/world/canon-timeline.ts`，`test/canon-timeline.test.ts` |
| 1.2 接入 bundle 与上下文 | `feat(world): freeze the canonical timeline into bundles and snapshots` | `bundle.canonical.timeline`、快照 `timeline`、`WorldModelContext.timeline` |
| 1.3 切面改为时间线驱动 | `feat(world): drive entry cuts by the frozen canonical timeline` | 四个调用点与投影期知识重放都用冻结时间线 |
| 1.4 诊断输出 | `feat(cli): add compile-novel cuts timeline diagnostics` | `nwh compile-novel cuts [--source] [--revision]` |

### 龙族实测

| 指标 | 设计目标 | 实测 |
|---|---|---|
| 时间线全序事件数、约束环 | 79/79、0 | 79/79、0；1 个 `TIMELINE_FLASHBACK_UNANCHORED` 提示；8 个 `assumedPairs` |
| 时间类场景执行失败 | 72 → 0 | 0（原 72 条失败中 `ENTRY_TIME_UNKNOWN` 出现 1424 次，全部消失） |
| 时间线修复后的其他前缀重放失败 | 未知（风险表第 2 条） | 67 条场景执行失败全部变为 `ACTOR_EFFECT_REQUIRES_MECHANISM`，交给 M2 逐切面归因 |

### 补充决定

1. **只有冻结的时间线才驱动切面。** 入场时的切面哈希会在投影期由 `replayEntryKnowledge` 从快照重新推导，两边必须用同一条时间线。因此引擎路径只认 `bundle.canonical.timeline` 或快照中的 `timeline`；`bundleCanonTimeline` 的现场推导只用于诊断。旧 bundle、旧快照、测试里手写的 bundle 继续走故事时间切面。
2. **源范围的当前上下文也带时间线。** `captureCurrent(sourceId)` 从工作区的标注、消解和结构推导出与候选 bundle 相同的时间线，避免"bundle 推导的入场"在当前上下文里重放失败。编译器存储用动态导入，世界层不静态依赖编译器。
3. **时间线世界里分支时钟不比较 `orderHint`。** 按时间线顺序重放时，批次间不连贯的 `orderHint` 会让 `nextLogicalTime` 报"故事时间倒退"。有冻结时间线的上下文里，`ordinal` 只作展示标签，日历时间仍是权威。这是设计第 6 节新增不变量"时间顺序只来自宿主推导的时间线"的直接落实。
4. **未锚定的预叙排在最后。** 设计 D3 只规定了闪回和回忆。没有显式约束的 `flashforward` 若按话语位置放置，会把未来事实带进更早的切面；按 D3 "缺失比错误安全"的同一理由，把它排在所有事件之后，并报提示级 `TIMELINE_FLASHFORWARD_UNANCHORED`。龙族没有预叙事件。
5. **共指事件相邻排列。** 同一共指组的事件取组内最早话语位置，组员按位置连续编号，非首位成员带 `aliasOf`；切面以组首的序号为界。
6. **话语坐标缺失时的退路。** 依次用事件提及锚点、证据字节、源结构的行号映射；完全没有字节信息时用证据行号（只在整份数据都没有字节时才会发生，保证同一坐标系）。坐标相同时用编译器的 `discourseOrder` 作并列裁决，它不会覆盖字节位置。
7. **引擎版本升级推迟到 M5.1。** 旧快照没有时间线，仍按原逻辑投影，结果不变；新快照多了严格 schema 字段，旧引擎读不了，不会静默分叉。所以 1.3 不需要单独升版，和 M5.1 的 schema 3 → 4 一起把引擎升到 0.37.0。
8. **改造过的测试夹具去掉冻结时间线。** `acquisition`、`process-capacity` 两个测试在构建好的 bundle 上增删事件，时间线随之失效；这些测试关注获取与过程语义，删除 `timeline` 后继续走旧切面，时间线语义由专门测试覆盖。

## M2 切面准入（已完成）

| 工作包 | 提交 | 结果 |
|---|---|---|
| 2.1 issue 归属 | `feat(compiler): attribute closure issues to their dependency nodes` | `src/compiler/issue-attribution.ts`；`assessNovelClosure` 汇总处补 `path` |
| 2.2 准入清单 | `feat(compiler): derive a per-cut admission manifest` | `src/compiler/cut-admission.ts`；`bundle.admission` |
| 2.3 按"切面 × 角色"探针 | `refactor(compiler): extract per-entry deterministic probes` | `probeEntry`；`major-character-playability` 不变通过 |
| 2.4 门禁替换 | `feat(play): gate fresh play and activation on per-cut admission` | `assertPlayableRevision`、`assertCutAdmission`；`compile-novel admit [--activate]`；配置 `play.minimumAdmissionTier` |
| 2.5 清单进诊断与 Web | `feat(cli): report admission tiers in cut diagnostics and preparation` | `compile-novel cuts` 输出等级、首要阻塞和覆盖率；准备页显示切面准入覆盖率 |

### 龙族实测

| 指标 | 设计目标 | 实测 |
|---|---|---|
| 无归属 issue | 不超过 14 | 2（均为全书级名册评审：`ROSTER_REVIEW_INCOMPLETE`、`ROSTER_NO_MAJOR_CHARACTERS`）；853 个 issue 中 851 个归属到节点 |
| replayable 切面 | 第一个阻塞单元之前的 20 个全部通过；通不过的有具体归因 | **10 个**（47 个切面、38 个场景中 7 个），地平线在时间线第 11 位。未达到 20；其余全部有具体归因：首个封锁是 `event-car-stop-00005` 重放时 `SPATIAL_LOCATION_REQUIRED`（人物从未设定的地点移动），之后叠加记账（508 KB 一带）与依赖失效 |
| enterable"切面 × 角色" | M3 指标 | 0。确定性探针的拒绝分布：入场状态缺显式 `character.alive`（7）、探针回合要求行动机制（5）、找不到自主驱动事件（1）。这是 M3 派生入场要解决的问题 |

### 补充决定

1. **前缀按"正典发生"重放。** 设计说 replayable 复用 `executeSceneEvent`。它原来把有施事者的历史事件当成 `actor` 提案校验，于是 `character.plan` 之类的变化要求可执行的行动机制；而运行时提交正典可能性用的是 `canon-candidate`。准入必须预测"游玩能否到达这个状态"，所以前缀重放用与运行时相同的语义（新增 `canonOccurrences` 选项）。场景执行契约仍用更严的 actor 语义，因为它回答的是"这个场景能否被角色执行"。这一改动把龙族的地平线从第 5 位推进到第 11 位。
2. **准入输入只取保留的基线问题。** 闭包评估中的场景契约问题（`SCENE_EXECUTION_INVALID`）基于更严的 actor 语义，不作为准入输入；闭包图悬空引用、记账、机制支持在清单内部单独计算。
3. **地平线按时间线位置计算。** 每个位置 i 表示 `entries[i]` 发生前的世界；位置可重放当且仅当它不早于开场、不超过重放失败点、话语位置之前没有阻塞单元、闭包内没有失效依赖、之前没有约束环。地平线是从开场起连续可重放的最远位置；步进器只能结算 `index < 地平线` 的事件。
4. **只用冻结清单开局。** `assertCutAdmission` 校验清单的 subjectHash 和 timelineHash 与 bundle 一致；没有冻结时间线的旧 bundle 只能走全书认证。
5. **`assessSemanticSupport` 性能修复。** 原实现对每条证据断言扫描全部单元并做数组 `includes`，龙族上 131 秒；改为按字节索引和按字段索引，输出逐字节相同，27 毫秒。
6. **Web 只读冻结清单。** 准备页显示活动版本的准入覆盖率，不在读模型里重跑探针；有可入场条目时允许创建实例。
7. **门禁集成测试替换记账校验。** `novel-certification-gate` 的部分准入用例在真实工作区和缓存上走发布、激活和开局，记账局部性已有单测，所以在该用例里替换 `validateFrozenAccounting`，测试内注明原因。
