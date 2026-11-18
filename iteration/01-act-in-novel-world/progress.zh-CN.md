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

## M3 场景入场（代码完成；龙族指标未达标）

| 工作包 | 提交 | 结果 |
|---|---|---|
| 3.1 入场包派生 | `feat(world): derive scene entry seeds for any cut x actor` | `deriveSceneEntrySeed`：开场 → 该事件上已编译的检查点 → 确定性派生 |
| 3.2 接口 | `feat(play): start fresh play at an admitted scene cut` | `GET /api/v1/novels/:id/cuts`；开局请求可选 `cutId`；`nwh play --scene`；`branch.entryCutId` |
| 3.3 阅读视界与引子段 | `feat(world): bound narrative source prose by a read horizon` | `src/world/read-horizon.ts`；引子段；运行时原文咨询的宿主判定 |
| 3.4 场景地点契约 | `feat(compiler): add the scene location contract and completion queue` | `locationUnknown`、`SCENE_LOCATION_MISSING`、补全队列 |
| 3.5 枚举式端到端测试 | `test: enumerate every admitted scene entry end to end` | 10 个场景的合成小说：20 个"切面 × 角色"逐个开局、打 1 个玩家回合、冷重放一致 |

### 龙族实测

| 指标 | 设计目标 | 实测 |
|---|---|---|
| enterable"切面 × 角色" | 不少于原型估计 65 的八成（52） | **0**。可重放切面上有 28 个"切面 × 角色"对，其中 22 个入场状态落地（replayable），但没有一个通过全部 7 个确定性探针：21 个缺可执行的行动机制或目标行动（`ENTRY_ACTION_UNPROVEN` 12、`ACTOR_EFFECT_REQUIRES_MECHANISM` 9），6 个缺操作性上下文（场景无地点、角色无地点/计划），1 个找不到自主驱动事件 |
| 非开场场景开局并完成开场叙事 | 至少 5 个不同场景 | 未运行：需要可入场条目和真实模型叙事 |
| 有地点的场景 | 从 11 提升，缺失的都有显式标注 | 契约与队列已就绪；27/38 个场景缺契约（4 个在地平线内）。补全需要模型驱动的编译批次，会写入用户的真实工作区，本次未运行 |

**解读。** 按 D1，enterable 要求 7 个确定性探针全部通过。龙族的障碍不在入场派生，而在"行动权"：多数角色在源文中没有被编译出可执行的行动机制或目标行动。这正是设计 9.3 风险"抽取稀疏导致世界'薄'"，M4 的行动探针会把它量化。本次没有放宽探针。

### 补充决定

1. **派生入场以确定性检查点表达。** 派生入口被构造为切面事件上的检查点：重申角色前缀折叠后的操作性状态，场景有地点且角色无地点时补地点，身体在场且生死未表态的角色补 `character.alive = true`，在场取场景的 `presentActorIds`。之后复用已有的整条入场流水线（前缀重放、知识、过程、读者前情），不另写一套。
2. **身体在场即在世。** 探针要求入场时显式在世。对于在亲历场景中身体在场、而前缀和检查点都没有表态生死的角色，补 `character.alive = true`。这条推断同样应用于场景入场用到的已编译检查点。若前缀已表态死亡，派生入场报 `ENTRY_ACTOR_DEAD`。
3. **派生入场的知识历史。** 投影期 `replayEntryKnowledge` 原本要在正典事件上找到入场检查点。派生入口没有正典检查点，所以知识历史带 `basis: "derived-scene"`，回放时只从正典前缀重建，不允许它遮蔽已编译的检查点。
4. **已认证或已准入都可以开局。** 不带 `cutId` 的旧请求仍从角色的首个入口开局；未认证但已准入的版本里，首个入口被准入的角色在角色列表中显示为 ready。
5. **场景地点补全只做到队列。** 新增编译批次用途要接入阶段门、完成回执和提示词版本，且补全本身要调用模型写入用户工作区。本迭代提供契约、诊断和按地平线排序的补全队列，批次本身留给 M6.3 的修复排队一起做。

## M4 行动探针（代码完成；龙族真实模型基线未运行）

| 工作包 | 提交 | 结果 |
|---|---|---|
| 4.1 探针运行器 | `feat(eval): add the act probe runner` | `src/eval/act-probe.ts`：6 类意图走生产回合管线；假模型下报告字段齐全、冷重放一致、零知识越界 |
| 4.2 命令与报告 | `feat(cli): add compile-novel probe` | `nwh compile-novel probe [--cut] [--live] [--turns]`；每个入口在隔离的临时工作区开局，不碰用户的实例；报告落盘到工作区的评估记录 |
| 4.3 基线评审 | `docs: record the act probe baseline and issue list` | `probe-baseline.zh-CN.md` |

**未完成项。** 龙族真实模型基线没有运行：龙族 0 个可入场条目，本机没有模型配置；在龙族上跑探针还需要先发布并激活一个准入版本，这会写入用户的真实缓存和工作区，本次没有自行执行。基线评审改用两类可得数据：合成夹具上的假模型回合度量，以及龙族准入清单的拒绝分布。

### 补充决定

1. **探针在临时工作区运行。** 每个入口在新建的临时工作区里登记同一份不可变源文（`registerSourceContent`），绑定同一个预编译缓存，经准入门禁开局。这样探针产生的分支不会出现在用户的实例列表里。
2. **知识越界的确定性判定。** 角色最终知道的断言中，只能从本分支未解决的正典事件学到、且不能从开场或已解决事件学到的，计为越界。
3. **度量口径。** 世界回应率是被接受回合中有任何回应事件（NPC、世界回应、正典步进、其他角色、后台）的比例；死回合率是它的补集；正典步进率是正典位置前进的回合比例。在 M5 之前，"正典步进"通道统计的是正典脚手架恢复事件。

## M5 正典步进器（已完成）

| 工作包 | 提交 | 结果 |
|---|---|---|
| 5.1 正典发生的实质性 | `feat(world): count a canonical occurrence as material progress` | `occurrence` 通道、`canonicalOccurrence`；世界 schema 3 → 4，引擎 0.36.0 → 0.37.0 |
| 5.2 正典位置、越过规则、窗口 | `feat(world): track the canonical position and expire passed canon` | `canonicalOrder`、越过即过期、窗口 64、地平线冻结进快照 |
| 5.3 步进器与节拍分类 | `feat(world): add the canon stepper with beat classification` | `WorldRuntime.stepCanon`、`src/world/canon-stepper.ts` |
| 5.4 回合集成 | `feat(play): advance canon in every turn of a timeline world` | `performPlayTurn` 顺序改为设计 4.5(6) |
| 5.5 正典状态 | `feat(play): expose canon status to play and narration` | `CanonStatus` 进回合结果、Web 回合结果和叙事帧 |

### 实测

| 指标 | 设计目标 | 实测 |
|---|---|---|
| 游玩中可实现的正典事件（龙族） | 42/79 → 79/79 | 前沿能为之生成提案的正典事件 50 → 79/79（设计写的 42 来自原型估计；按"有类型化效果"实数为 50） |
| 20 回合内正典位置前进 | 跟随正典的脚本下每 3 回合至少前进 1 | 龙族无可入场条目，未测。合成夹具上：第一回合正典位置 0 → 3（两个离屏事件被结算、一个无施事信息的玩家节拍被越过），3 个事件的时间线随即耗尽，状态明确为 `exhausted`。步进语义由 `canon-stepper` 单测覆盖 |
| 死回合率 | M6 指标 | 合成夹具上仍为 5/6：时间线只有 3 个事件，第一回合后正典已耗尽，之后的回合没有可回应的正典。这个夹具不足以衡量"降一半"，需要更长的语料 |

### 补充决定

1. **正典发生的判定只看事件本身。** 提交事件不记录提案来源，创世事件也带 `realizesCanonicalEventIds`。所以"正典发生"判定为：事件的 `canon-*` 可能性恰好是它所实现的正典事件，且不是改编。引擎拒绝同一正典事件的第二次实现（`CANONICAL_EVENT_ALREADY_REALIZED`），保证这总是首次发生。`canonicalOccurrence` 为假时省略，已有证书哈希不变。
2. **时间线世界里，正典按序号而不是故事时间排期。** 有冻结时间线时，前沿用 `canonicalOrder` 对比正典位置，取代 `temporalAnchor` 的故事时间比较；"根场景"启发式改为"时间线上最前面的未解决事件在场"，其余事件回到"参与者已出场"规则。
3. **步进器只为顺序担保。** 前沿中仅因根场景启发式而潜伏的正典事件，步进器视为可行；提案仍由引擎完整校验。这样无施事信息的队首事件（留给世界回应通道）不会卡住后面的正典。
4. **地平线冻结进快照。** 世界快照新增 `canonHorizonIndex`（来自新鲜的准入清单），步进器和可能性窗口都以它为上界；`index ≥ 地平线` 的事件不物化、不结算，状态报 `beyond-horizon`。
5. **新增停止原因 `idle`。** 设计列了 awaiting-player、budget、beyond-horizon、exhausted。当地平线内仍有未解决、未失效的正典，但当前一个都不可行时，返回 `idle`；`exhausted` 只表示地平线内已没有活着的正典。
6. **旧世界保留旧规则。** 设计要求删除"仅当本回合新否定正典才给 1 个后台名额"。在有时间线的世界里，这条规则由步进器取代，后台通道只承载非正典的自主发展；没有时间线的旧世界没有步进器，保留原规则，否则旧世界将完全失去正典推进。

## M6 按探针数据补强（部分完成）

| 工作包 | 提交 | 结果 |
|---|---|---|
| 6.1 NPC 台词参照 | `feat(play): give NPC reactions their own source lines as voice references` | 声音索引冻结进 bundle 与快照；只取阅读视界之内、说话人解析为角色的最近 6 条引语，每条不超过 240 字符，按哈希校验原文。龙族 160 条引语中 144 条入索引，覆盖 31 个角色（原型估计 145 条、32 个角色） |
| 6.2 复跑探针 | 本节记录 | 合成夹具上与 M4 基线对比：正典步进率 0 → 1/6，第一回合正典位置 0 → 3；死回合率仍为 5/6，因为 3 个事件的时间线在第一回合后耗尽，状态明确为 `exhausted`。"死回合率降一半"需要更长的语料，龙族又没有可入场条目，本次无法给出有效对比 |
| 6.3 修复按切面排队 | `feat(compiler): order repair by the first blocked cut after the horizon` | `compile-novel plan` 的首项是"地平线之后第一个封锁切面"的修复任务，按拒绝码归组并给出节点。龙族的清单指向唯一节点 `event/event-car-stop-00005`，它挡住了 37 个切面 |
| 6.4 基线清单前三项 | 见下 | 第 1 项（正典不前进）由 M5 完成；第 2 项（行动机制）和第 3 项（空间与地点）需要模型驱动的编译批次，本次未做 |

**6.4 为什么停在这里。** 设计第 1 节把"对'提案→校验→提交'边界的任何放松"列为非目标。龙族余下的阻塞（角色没有源文支持的行动机制、`event-car-stop-00005` 让人物从未设定的地点移动）都是编译数据缺口，修复路径是编译侧补全，不是放宽引擎校验。这些补全需要调用模型并写入用户的真实工作区：本机没有模型配置，这类写入也不应自行执行。本迭代已把它们精确定位：地平线任务给出唯一的首要修复节点，场景地点队列给出 27 个缺契约场景，准入清单给出每个"切面 × 角色"的首个拒绝原因。

## 验收对照（设计第 8.1 节）

| 里程碑 | 指标 | 设计目标 | 本次结果 |
|---|---|---|---|
| M1 | 时间线全序、约束环 | 79/79、0 | **达成**：79/79、0 |
| M1 | 时间类场景执行失败 | 72 → 0 | **达成**：0 |
| M2 | replayable 切面 | 第一个阻塞单元之前的 20 个全部通过；通不过的有具体归因 | **部分**：10 个；其余全部有具体归因（首因 `event-car-stop-00005`） |
| M2 | 无归属 issue | 不超过 14 | **达成**：2 |
| M3 | enterable"切面 × 角色" | 不少于 52 | **未达成**：0；22 个入场状态落地，卡在行动与驱动探针（编译侧缺口） |
| M3 | 非开场场景开局并完成开场叙事 | 至少 5 个场景 | **未运行**：无可入场条目、无模型配置；合成小说上 10 个场景、20 个"切面 × 角色"均可开局并冷重放一致 |
| M4 | 基线报告 | 覆盖全部可入场切面的 6 类意图 | **部分**：探针与命令已就绪，合成夹具假模型基线已出；龙族真实模型基线未运行 |
| M5 | 游玩中可实现的正典事件 | 79/79 | **达成**：79/79 |
| M5 | 20 回合内正典位置前进 | 每 3 回合至少前进 1 | **未在龙族上测**；合成夹具上第一回合前进 3 位后时间线耗尽，步进语义由单测覆盖 |
| M6 | 死回合率 | 比基线降一半 | **未能有效对比**（见 6.2） |
| M6 | 连续游玩 | 至少 1 个非开场场景 20 回合，冷重放一致，零知识越界 | **未运行**：依赖可入场条目与真实模型 |

**结论。** 设计的六个组件都已落地并有测试覆盖：时间线、切面准入、场景入场、阅读视界、正典步进器、行动探针，外加 NPC 台词参照与修复排队。全量 `pnpm check` 和 `pnpm test` 通过（313 个测试文件）。龙族的终局指标被两类编译数据缺口卡住：主要角色缺源文支持的行动机制，以及空间与地点数据。现在它们已被精确定位，下一步是模型驱动的编译补全，再用 `compile-novel admit`、`compile-novel probe --live` 复测。
