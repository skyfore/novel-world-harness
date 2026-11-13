# 《龙族Ⅰ·火之晨曦》定向编译闭合技术计划

2026-11-11 制定。审计时的代码基线为 `7522fa8`，编译流水线 50，提示版本 51，引擎 0.36.0。用第一卷验证从发现原文遗漏到场景可执行的完整过程。编译器应能把缺口送回有权限的阶段，修订后的场景应能在隔离分支中执行、重放并偏离原著。进入产品代码的是通用能力，书中对象只作验收案例。

**实施进度。** 第②步的目标完成条件修订已随 `c158227` 合入 `main`，11 项合成回归通过。本卷曼斯目标的独立原文规格、修订回执和严格候选重建结果仍待验收。[目标修订回归](../../test/goal-lifecycle-repair.test.ts)

## 交付顺序

| 顺序 | 可交付结果 | 完成证据 |
| --- | --- | --- |
| ① 保护当前断点，准备独立规格 | 找到原队列可以交接的边界，准备曼斯目标的两个时间切面 | 当前草稿、账本前缀、预算和未派发队尾可复核。独立规格能在旧目标上复现失败 |
| ② 打通单目标修订 | 用原目标 ID 修订有问题的完成条件 | 两个时间切面通过，严格候选构建越过原错误，重复恢复产生同一份提交回执 |
| ③ 打通来源遗漏的回送 | 从第 12 段一条原文要求追到提及、解析、事件、效果和记账修订 | 能逐项说明哪条原文要求被验证解决、哪条因什么依赖继续阻塞 |
| ④ 接入身份与时间依赖 | 关系自身的缺陷能交给对应修复范围，时间诊断能定位共同前提 | 原身份分母对账，一个具名场景通过真实执行内核的入口、行动、知识与重放检查 |
| ⑤ 扩展到整卷 | 在同一套验收流程上处理其余片段和角色 | 当前修订取得全局闭合、独立评测、认证及相应交付回执 |

①的断点复核和③的原文审阅可并行。②在本卷登记规格前须先核对①的账本前缀。先用两个不同的缺口验证修复接口，再把已经验证的路径接入自动调度。

## 基线与可核验的假设

本机审计在 `run-records/2026-11-11-longzu-audit/`。其中 `verification.json` 记录输入、分母、归档和停止条件，`findings.json` 保存逐项 ID。这些是本地运行资料。可携带的回归样例使用合成原文。

| 观察对象 | 固定基线 |
| --- | --- |
| 输入与交付 | source ID `a28585b1cf867f3e3a16`，SHA-256 `a28585b1cf867f3e3a1679a09558658338637efd2f0bf15e8d5878b7f9e44fe0`。77/77 批次回执通过。当前修复诊断对象 `58aa7a8f6de2…`，严格构建被目标校验阻断。旧归档 `bd8e25645bdf…` 未激活 |
| 来源与独立要求 | 10,957 个单元均已记账，601 个显式延后。第 12 段 600 个，第 16 段 1 个。43 个实体提及和 152 个事件提及缺解析记录。63 个工件缺精确字段证据。已有 79 个事件、15 个目标，对应的 94 项独立复核规格均缺失 |
| 角色与消费者 | 当前角色来源先行审阅 137/137，审计通过 0/137，开放问题 683 个。身份任务原分片 1/12 已审，覆盖 48/536。补充逐项复验独立完成 61/536、解除 58/536。这两套记录按稳定引用对账 |
| 场景 | 38/38 个现有场景有阻塞。72 条场景执行失败均含 `ENTRY_TIME_UNKNOWN`。按“入口事件、无法定位的有影响事件”对旧诊断文本去重，得到 72 个入口、50 个有影响事件、1,424 对关系待判。这个数用于排查，同一条有证据的时间约束可能解释多对关系 |

### ① 先保住已消费的独立检查

`shard 1` 的 48 项中，18 项解除、2 项判定阻塞、28 项待完成。停止对象为 `event-relation/rel-man-asks-eva-orders-00009`。原提案已登记，独立检查因提供方限额中断，留有一份草稿。必须区分编译锁已释放与工作已经结算。

在原位置用真实 scope 做了只读实验。其需求账本前缀长度为 3,263，当前账本 3,264 条，新增的一条是该消费者的提案。现有前缀检查通过。在内存副本末尾加入一个无关 `definition` 类型的条目后，同一检查拒绝通过。`recordIdentityConsumerRevalidation` 登记尚未记录的阶段时会执行这项检查。因此，即使两项内容在小说里相互独立，先在本卷执行 `review-scenes --register` 也会破坏这个断点后续登记的条件。[前缀规则](../../src/compiler/identity-consumer-revalidation-model.ts) · [登记实现](../../src/compiler/requirement-ledger.ts)

- 等待期间可以阅读原文、起草规格、计算只读诊断、在合成工作区开发和测试。预览规格可用 `review-scenes --spec <文件>`，记录结果中的 `catalogMode` 和 pending 清单。此路径读取的草稿覆盖视图只用于诊断。
- 同一 Pi 提供方和模型恢复且具备该次续接授权后，从同源、同任务、同 ref 的 `stages[].execution.providerResumptionCandidate` 复制 `scopeHash`、`stage`、`failedTraceRunId`，随实际后续授权及时间执行 `--resume-unsubmitted inspect`。预检可运行时才用相同输入续接独立检查。分片队列可用 `--limit 1` 限定本次新派发数，登记后在锁内核对其余未结算写入和受影响的冻结任务。清单相容时才进入后续写入。[队列及恢复协议](../agent-tool-recovery.md#work-policy-provider-continuation)
- 若原阶段的证据或依赖已变化，保留原失败和草稿，按原任务的宿主审阅路径记录处理结果。来源规格草案和工程验证可以继续。一次合规交接只覆盖已核对的写入范围，后续工作仍在锁内重新核对各自依赖。

从仓库根目录可用以下现有命令复核断点和任务分母。

```sh
source_id=a28585b1cf867f3e3a16
task_id=40cc0f392105c023d5871539ed18a02ac3912092859806943d4877179ef8d7cd
node dist/cli.js compile-novel plan --source "$source_id"
node dist/cli.js requirements consumer-queue --source "$source_id" --task "$task_id" --shard 1 --inspect
node dist/cli.js requirements inspect-identity-repairs --source "$source_id" --task "$task_id" --ref event-relation/rel-man-asks-eva-orders-00009
node dist/cli.js requirements semantic-review-plan --source "$source_id"
```

### ② 按独立规格修订一个角色目标

审计基线中的 `goal-mans-explore-city-00010` 在青铜城被发现且 `location.open == true` 时激活，而完成条件仅要求 `location.open` 存在。本卷验收需要用原文区分开始探索和完成探索的时间切面。[目标校验](../../src/compiler/validator.ts) · [场景规格与求值](../../src/eval/scene-capabilities.ts)

1. **先固定预期。** 独立审阅原文，记录“已激活、仍在探索”和“已有证据足以判定完成”的两个切面，各自给出证据、世界条件、已发生及亲历事件、角色已知信息。在 `goal-lifecycle` 规格中固定预期，运行旧目标获得失败。若原文只描述中止或失败，保留这一语义边界，评估现有 `expiry` 和完成语义的适用性。缺少可表达的成功条件时登记阻塞，禁止虚构一次成功。
2. **使用已合入的修订契约。** `GOAL_COMPLETION_REVISION` 将一条 `character-goal` 绑定到同一角色、目标前驱、已登记的 `goal-lifecycle` 规格修订和原文证据范围。计划经登记、授权后，`propose_character_goal` 可暂存 `/completion` 和对应字段证据的修订。若激活或终止本身也有错误，需根据证据另定范围。[修复规划器](../../src/compiler/upstream-repair-planner.ts) · [修订契约](../../src/compiler/goal-lifecycle-repair.ts)
3. **提交并重验原规格。** 宿主核对前驱和读集，用独立规格检验草稿。`requirements finish-upstream-plan` 冻结草稿，`compile-novel converge` 提交修订，`requirements evaluate-upstream` 在已提交的目标上重验。目标写入后若在证据绑定阶段中断，可凭原回执恢复。[操作步骤](../agent-tool-recovery.md#修订目标的完成条件)
4. **验收。** 在①允许的登记边界，使用 `review-scenes --spec <文件> --register <稳定集ID>`。注册命令可能在已写入定义后以 2 退出，先用 `requirements inspect` 查看原集和失败证据。修订后要求两个时间切面通过，拒绝异角色、异来源、越权字段、前驱过期及改写冻结规格的草稿。最后运行严格 `candidateSnapshot`，记录原错误是否消失以及下一个真实阻塞。`repairCandidateSnapshot` 可供保留错误的诊断使用。[注册入口](../../src/commands/review-scenes.ts) · [两条候选构建路径](../../src/compiler/prepared-cache.ts)

### ③ 在第 12 段闭合一个来源遗漏

选取 `a28585b1cf867f3e3a16-00012-1f6706579fb4`，原文第 2046–2342 行。当前 79 个规范事件的直接证据跨度均未覆盖此段。先读这一段并独立列出有实质后果的事件、报告、知识获得和状态变化，固定原文锚点、叙事层次、参与者及证据边界，再与编译结果匹配。对高比例的背景和重复类别另做分层抽样，保留原理由、样本与未审范围。

**第一条使用船抵达船闸的原提及 `evm-ship-lands-00012`。** 当前 `m-ship-1` 和 `m-dam-1` 已有选定实体，后者指向三峡大坝。原提及的事件解析仍为 `unresolved`。要复核的是二级船闸能否在该切面定位，以及叙述支持客观抵达、对抵达的报告或哪些角色获得消息。大坝的实体 ID 本身不能证明船闸的位置或角色知情。

- **先定位，再开写入范围。** 在现有 requirement ledger 中为“有来源锚点、尚无规范对象”的独立要求增加最小的宿主记录及绑定记录。沿用稳定要求 ID，分别保存来源哈希、原始单元与锚点、要求修订、负责阶段、依赖、核查状态及接受回执。目标工件可以暂缺。修正锚点或绑定工件时追加带前驱的修订。任务清单从这些记录和记账表投影。冻结候选时把有效要求及绑定纳入快照输入，并与账本交叉验证。目前 `requirementSnapshotInputs` 排除原始 journal，单独追加日志不足以让证书随要求变化失效。[需求快照](../../src/compiler/requirement-ledger.ts) · [覆盖计算](../../src/compiler/semantic-coverage.ts)
- **复用已有提及和修订历史。** 已有规范事件时使用 `EVENT_RESOLUTION_REVISION` 绑定发现到的候选及前驱。若确实缺规范事件，现有 `CANONICAL_EVENT_MISSING` 路径会按锚点分配新提及 ID。为“已有提及、缺发生记录”补受控分支，固定原提及修订、原未决解析和所有参与者证据，创建有依据的发生记录及必要参与记录，追加显式继承前驱的解析。全新遗漏才走现有新提及创建路径。地点或报告层次缺证据时，给上游留下精确要求。[修复规划器](../../src/compiler/upstream-repair-planner.ts) · [事件解析](../../src/compiler/event-resolution.ts)
- **记账按原缺口结算。** 同一单元出现新标注后仍须针对原延后理由复核，使用原批次、前驱提案哈希和记账修订。验收包括独立发生与效果规格、对应角色的知识边界、修订后消费者，以及原单元的新旧判断。600 项按具体场景和依赖分组，汇报已验证解决、仍阻塞、尚未审阅的精确 ID。只处理其中一个场景时，第 16 段的一项及其余队尾仍全部可发现。[记账投影](../../src/compiler/source-accounting.ts)

**接回主流程。** 先在 `compile-novel plan` 的只读交接中列出这些任务及其稳定 ID、原证据、依赖、负责阶段、可执行范围与恢复条件。再让主流程在某一阶段因领域问题停止时，选择已有授权、依赖已结算且写入兼容的任务，走同一阶段命令的宿主验证器。

写入在一个编译锁内串行。先恢复未结算的原始写入，再对照开放任务的前缀规则和读集预检拟写账本条目、工件与前驱。发生实际冲突时返回冲突的 task／ref 及可继续的工作。新回执落盘后重算受影响任务，同一输入和失败不能触发再次派发。锁或写入结果不确定时遵守宿主停机规则。CLI、TUI 和 Web 的进展投影采用同一交接结果。[当前阶段循环](../../src/workflow/novel-compilation.ts) · [当前交接](../../src/compiler/compilation-handoff.ts)

若真实切片验证表明无关需求追加反复阻塞其他任务，下一版消费者契约可在预约时冻结实际读集。在原前缀仍可验证的前提下，逐项证明新增记录未改变读集、原授权、预算、单次阶段或分母，才允许登记。未知的记录种类按冲突处理。该版本仅用于新建范围，旧草稿按创建时的契约结算。上线前用同类无关追加、看似无关但改变共用规格的追加各做一项反向回归。

### ④ 身份复验与时间切面

**身份任务保留完整影响范围，按缺陷归属交接。** 536 项包括 459 个类型化消费者、76 项候选角色来源审阅和一份分母。优先使用 `consumer-review/v2` 已有的 `identity-dependencies`、`source-support`、`temporal-boundary` 等检查。投影分别显示该项所消费的身份条件、工件自身条件、独立审查及修订。绑定同一 ref、当前工件与拥有者修订、原问题和检查回执。旧记录若只有总体判断，细项标未知。单项处置由原阶段证据承担，`1/12` 与 `61/536` 分开报告。[消费者契约](../../src/compiler/consumer-review-contract.ts) · [分片验收](../../src/compiler/identity-requirements.ts)

用 `rel-briefing-config-001` 和 `rel-config-cheatmap-001` 验证交接。两条关系的身份兼容性可以有证据，关系本身的“必要使能”仍缺依据。给关系拥有者绑定原负面回执和独立因果规格。现有 graph-adjudication 为修复无条件根而要求 `necessary`，不适合裁定关系强度过强。按原逻辑 ID、端点和证据提供窄的关系复核范围，只有来源支持的强度、状态及配套证据可变，重验关系对运行调度的影响。路鸣泽来访的身体在场继续由入口审阅处理。原三个身份问题、旧名单的悬空解析引用及 137 份来源审计仍按其所属契约验收。启用父任务续跑须重验原条件。[关系校验](../../src/compiler/reconcile-world.ts) · [角色来源审计](../../src/workflow/role-source-audit-repair.ts)

**时间切面先修证据，再评估算法变更的必要性。** 在 `deriveEntryCut` 产出诊断时附带结构化的边界事件 ID、待排序事件 ID、问题种类与修订哈希，经 `executeSceneEvent` 保留到场景契约。按受影响的不同入口数和可核验原文排序，保留全部事件对。第一批可检查“发现青铜城、城门开启、水下地震”相关记录，这三个事件各出现在 71 个入口失败中。共享失败数只决定阅读优先级。

用原文分别验证 `before/after`、区间、故事时间或有依据的历史状态。时间边复用 `propose_event_relation`，由宿主限定端点、允许的时间关系及证据。若需改事件的 `storyTime`，单独绑定原事件修订及该字段。当前 `completeCheckpoint` 可改变基线和重放判断，仍会拒绝无法定位的有影响事件。先沿用现有偏序和拒绝条件。若原文只能支持局部顺序，再单独评估局部投影的 ADR，须证明所有影响当前状态、角色知识和可见后续行动的依赖均已闭合。[时间约束](../../src/world/temporal-constraints.ts) · [时间切面](../../src/world/entry-cut.ts) · [场景执行](../../src/world/source-history.ts)

**首个可执行场景用第 3431 行的 13 号事件验收。** 现有 `event-13-knockout-00017` 的参与者清单只有 13 号，状态与知识操作均为空。独立复核先确认受影响者和进入场景前谁能感知什么。引擎已有 `character.wakefulness = unconscious` 的定性表示，使用它需要受影响主体和该操作的精确证据。施事者行动能力和旁观者获得知识各自需要证据。

在绑定版本的隔离场景中验收动作合法性、可观察后果、知识隔离和同一已提交历史的冷重放。随后在同一基底建分支，改变一项由机制实际读取的前提，检验原事件不会被强制提交。若入口时间或身份仍不足，保存具体反例及负责项，场景继续阻塞。[身体状态证据](../../src/world/bodily-state.ts) · [场景执行契约](../../src/compiler/scene-execution-contracts.ts)

## 回归、兼容与发布

| 要证明的性质 | 回归方式与验收 |
| --- | --- |
| 目标的修订可以从失败候选启动 | `test/goal-lifecycle-repair.test.ts` 已在合成工作区覆盖负例登记、草稿校验、提交和重新求值，以及越权字段、前驱变化、写入中断和幂等恢复 |
| 遗漏可以在没有规范 ID 时进入分母 | 合成片段含已知未决提及和一条完全漏提的事件。两条都可发现，前者只产生一个有效提及链，后者有独立发生和效果证据才能结算。重叠标注不会清除原延后。覆盖 `test/upstream-repair-semantic-event.test.ts` 与 `test/source-accounting-projection.test.ts` |
| 局部调度尊重旧断点 | 角色域阻塞时，兼容且已授权的局部任务能推进。对真实前缀的回归包含兄弟记录可接受、无关后缀拒绝、已封存提案零重放、单次续接、队尾不丢、两写者只成功一次。沿用 `test/identity-consumer-revalidation.test.ts`、`test/identity-consumer-queue.test.ts` 与 `test/novel-compilation.test.ts` |
| 入口修复能解释运行结果 | 覆盖可证先后、重叠、无证先后、倒叙、互相冲突、影响知识的边界事件。只读诊断分组前后相同输入得到同一切面和同一拒绝结果。用 `test/temporal-constraints.test.ts`、`test/entry-cut.test.ts`、`test/scene-execution-contracts.test.ts` 与隔离分支测试验收 |
| 新要求可使旧评估失效 | 老账本、回执及旧归档继续按原版本读取并复算原哈希。先部署能读新版本的宿主，再允许生成新记录。有效要求、被依赖的工件修订或检查器契约变化时，当前认证必须重验。纯调度历史追加应保持相同的评估对象哈希。回退时停用新派发，用兼容读取器审计已写入的历史。已有分支固定原版本 |

编制计划时，在隔离测试目录运行了以下基线用例，5 个测试文件、33 项通过。

```sh
pnpm test test/scene-capabilities.test.ts test/entry-cut.test.ts test/temporal-constraints.test.ts test/upstream-repair-semantic-event.test.ts test/consumer-review-contract.test.ts
```

各项工程合入前再跑对应新增回归、`pnpm check`、`pnpm check:pi-tests`、`pnpm test:semantic-contracts` 和全仓测试。模型侧新增或改动的工具应给出同一范围内的发现工具及精确返回字段，只允许一次纠正。范围冲突、已消费调用和外部等待按原恢复协议处理。真实小说验收逐轮记录来源／候选／要求版本、已解决与新增缺口、受影响 ID、已消费预算和下一合法动作。原会话回执在原目录核验，诊断副本的结果注明用途。[工具恢复协议](../agent-tool-recovery.md) · [编译完整性规范](../novel-compilation-protocol.zh-CN.md)

整卷交付时，先对账原有 601 个延后、195 个缺解析记录的提及、63 个缺精确证据的工件与 94 项独立语义复核，以及修复中新发现的要求。按当前分母重验主要角色、机制和场景。分别出示全局闭合、不可变候选归档、冻结的独立规格、真实 Pi 评测、当前版本认证、激活指针及绑定分支。场景级进展按已验证场景列出，人物身份、因果与时间的关键未知继续阻塞相应交付范围。[交付入口](../../src/commands/compile-novel.ts) · [主要角色与世界闭合决策](../adr/0010-major-character-play-and-world-closure.md)
