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
