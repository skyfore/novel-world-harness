# 能力闭环分段实施记录

对应 [Review 落地设计](2026-09-16-review-to-capability-closure.zh-CN.md)。本文件区分每个已提交增量与整个 P1–P7 目标；未完成项不能由局部测试通过推导为完成。

## 提交与进度

| 阶段 | 交付 | 状态 |
| --- | --- | --- |
| 设计基线 | `7078f4c`，方案与前序核验记录 | 已提交 |
| P1a 独立场景要求的持久约束 | `52f72ee`，requirement ledger、注册/查询命令、canonical 重评、冻结快照/恢复/closure/certification 接线 | 已提交；1038 项测试与类型检查通过 |
| P1b 逐能力报告与批次尝试 | `fb4c738`，新 reconciliation 计划冻结 ontology/development/driver 项；finish v2 绑定计划与报告；逐要求保留 deferral | 已提交；1040 项测试与类型检查通过 |
| P1c 归档与快照中的义务保留 | `e9976cf`，当前/历史 finish 统一读取、历史宿主复核、候选认证和恢复前置检查 | 实现完成；1044 项测试与类型检查通过；本记录随该段提交 |
| P1d 独立角色发展预期 | `db1d006`，版本化原文审阅、稳定/变化/未知、双审冲突保留、认证未知门 | 实现完成；1048 项测试及类型检查通过，尚不代表角色语义结算完成 |
| P1e 真实入口自主驱动 | `5ac8844`，排除玩家的引擎提交探针、冻结事件/效果凭据、认证检查 | 实现完成；1056 项测试及类型检查通过，P1 整体仍未完成 |
| P1f 核心角色逐能力评估 | 独立分母、本体精确绑定、发展运行时探针、认证重评 | 实现完成；1066 项测试及类型检查通过，持久角色定义/尝试接线仍未完成 |
| P1 后续完整结算 | 核心角色的独立要求分母、上述结构性修复要求与统一 ledger/evaluator 的消费连接、跨 reparse 的完整义务恢复 | 未完成；P1 整体仍进行中 |
| P2–P7 | 受限修复、语义获知、本体、文学/工作集、自主推进、完整体验验收 | 未完成 |

## P1a 的实际行为

`review-scenes --spec <file>` 保持只读、允许 pending overlay 的诊断行为。新增宿主入口：

```sh
nwh review-scenes --spec independent-scenes.json --register opening-scenes
nwh requirements inspect --source SOURCE_ID
nwh review-scenes --spec revised-scenes.json --register opening-scenes --predecessor EXACT_REVISION_HASH
```

注册在 compiler lock 内执行，先核对注册源的 hash 和每个 exact anchor，再持久化要求。注册入口只接收独立场景规格，不接收模型自报 satisfied。注册时可不满足要求：这种情况保留要求及 blocked/unknown/unmapped 结果，CLI 退出 2。

要求保存于 `worldStorageRoot(root)/compiler/requirements/<sourceId>/`。每个 JSON 记录带 sequence、前驱 hash 和内容 hash，head 原子发布完整链；缓存不是结算依据。原定义和评估记录不删除。同 ID 修改必须显式提供前驱 revision 与审阅依据；换 repair namespace 不会创建新的要求身份。删除 head、缺失已发布记录、坏 hash 均失败并保留原状态，需要宿主检查，不能重置账本后续跑。首次发布在 record 写完而 head 未写完时中断也进入该宿主检查路径；本段没有提供自动重建缺失 head 的权限。

`prepare-all` 在收敛后按 canonical catalog 重评，在发布前要求所有已注册 mandatory requirements 满足。没有 pending 提案参与结算。有效 catalog 或定义版本变化时，旧结果不能复用。只成功的 state-effect 不会清除同场景缺失的 agency/mechanism。

快照保存完整定义修订链，评估作为派生 readiness 结果保存，避免 subject hash 自引用。认证重新读取不可变原文、运行独立场景探针；后续激活/恢复/Play 的同步检查还会重新执行确定性探针，拒绝伪造的 satisfied、遗漏子要求和旧 catalog 结果。当前其他 roster、source accounting、semantic support、quality 门仍保留。

恢复时先验证要求历史，再进行任何世界材料化。新工作区可恢复完整定义链；旧快照不得清掉已有工作区的新增或修订要求，需使用隔离工作区。冻结的旧 bundle 本身不被新注册改变。

这是**已注册独立场景要求**的完整消费链，还不是所有核心角色的要求发现器。未注册独立规格的旧 snapshot 保持原认证路径；下一段 P1b 必须补齐要求分母、逐角色义务与 finish 尝试绑定，不能将这个兼容分支解释为完整 P1。

## 验证

针对性测试 `test/requirement-ledger.test.ts` 的 8 项通过，覆盖部分成功、重启/幂等、前驱修订、真实坏 finish 不改 canonical、pending/finish 不结算、converge 后结算、缺 head/记录及篡改、冻结快照与恢复拒绝。测试使用原创短文本，未调用真实 provider 或修改用户小说运行数据。

`pnpm test --maxWorkers=2`：180 文件、1038 tests 全部通过（70.68 秒）。`pnpm check`：服务端、Web 和 E2E TypeScript 检查全部通过。`git diff --check` 通过。P7 的真实模型和双人体验评价未执行。

## P1b：部分修复报告协议

新 reconciliation plan 为 v3，保存稳定的 `target:capability` ID。角色缺口分为 ontology、development、opening-driver；现有 event/initial-world 保留各自的待复核项。新计划只冻结已发现的工程缺口，不把它们谎称为独立来源审阅的全书能力分母。

`target_reviews[].requirement_reviews` 对每个冻结要求恰好报告一次 proposed/unsupported/capability-gap。目标层可因已有 goal 保持 proposed，但 ontology 等子项必须保留自己的未完成状态；部分成功不能只写 summary。各 capability 的 proposed 必须有对应类型的有效提案，空 action 或无时间边界的静态愿望不能作为 driver/development 提案工作。

finish identity v2 保存计划 hash 和要求列表，原始 input 冻结子报告。恢复时重读原计划并验证版本；计划被改写、缺失或变换作用域会明确停止。旧 v2 计划及 v1 finish 保持可读，不原地补造子要求。

宿主 deferral 复核对每个未完成的 requirement ID 独立记原因及 audit ref；仅复核其角色 target 不能覆盖这些项。重启和换 namespace 不会清除尚存 finish 回执中的未复核项。`reconciliationAuditResults` 对仍 unresolved 的 target 不再显示 `hostReviewRequired=false`。

复核通过只表示宿主读过缺口，不能作为 semantic satisfied 或发布证据。将这些结构性发现与 P1a 的独立场景/角色评估统一，并在 reparse 归档回执后继续保留全量义务，仍是 P1 的下一项工作。

本段验证：`pnpm test --maxWorkers=2` 的 180 文件、1040 tests 全部通过（70.16 秒），`pnpm check` 全部通过。新增回归包含只提交 goal 的真实 finish、逐能力 deferral、全局比例改善后的计划复用、原计划 hash 被篡改时恢复拒绝，以及宿主不能用整个角色的单条 review 清掉多个能力义务。

## P1c：归档不清除义务

发布检查现在同时读取当前回执与 `finish-receipts/<source>/history/` 的历史回执，校验源、batch 路径、fingerprint、归档原因和生命周期一致性。重建、换 namespace、同 batch 的新工作不能覆盖历史 deferral。原归档格式不变，也不复制出另一套可写世界状态。

显式归档的 prepared/completed 尝试可以按原 fingerprint 做宿主来源复核。复核验证原文 hash，但不要求历史工件仍是 active revision，也不重放旧 proposal。当前未完成的 prepared 回执仍不能当 completed 复核。复核只记录流程责任，不证明语义已经成立。

候选的 compilerSnapshot 保存待复核项与既有决策，认证检查每个源和精确要求身份。恢复首先验证不能丢弃本地义务或撤销已记录的复核，然后只导入历史回执，不重新激活旧 finish。坏 scope 在世界材料化之前被拒绝。

验证：181 文件、1044 tests 通过（`pnpm test --maxWorkers=2`，70.65 秒）；`pnpm check` 通过。新增测试覆盖 prepared/completed 归档、换 batch 后的旧缺口、篡改归档、历史导入、无重放、真实候选认证及恢复前拒绝。角色独立分母及结构性要求的语义结算仍待下一段完成。


## P1d：独立角色发展预期

角色审阅工具现在产生 v2 review，每个候选记录原文支持的稳定性、发展维度和方向，或证据不足。变化须列出 before/after 原文单元，不能用编译出的 goal 或 character model 作为预期来源。两次审阅仍互相隐藏；提案只在原有 finish 握手完成后持久化。

发展要求按原角色候选 ID 命名，定义 hash 绑定源、名单版本和两位审阅者的预期；核心角色取保守并集。两份 changes 各自保留，不能覆盖另一位审阅者发现的变化。稳定与变化冲突、unknown、旧 review 缺字段、尚无身份的遗漏角色都不会自动变成稳定。认证重新从 frozen roster 计算未知项，不能靠清空 readiness.issues 或自报成功绕过。

该段只建立发展预期的独立输入和未知门。尚未把 disposition/episode 的实际运行结果结算到统一 requirement ledger，也未实现历史名单的宿主修订迁移；旧 review 可读但不得当作已有发展审阅。核心角色完整 ontology、发展及真实入口 driver 的联合验收继续属于 P1 未完成项。当前角色审阅工具不授予删旧审阅或重新标记稳定来绕门的能力。

编译流水线版本提升到 35。34 的有效原文编译检查点继续保留，独立角色审阅使用新协议；33 的既有 observation/semantic 迁移规则不变。修订后的回滚回归用明确的历史版本 33，避免相对版本号随升级改变测试含义。

本段最终验证：`pnpm test --maxWorkers=2` 的 181 文件、1048 tests 全部通过（71.08 秒）；`pnpm check` 和 `git diff --check` 通过。回归包含真实角色审阅 finish/recovery、冻结候选及伪造 readiness 拒绝、双审冲突、旧 review 数据未知、外源单元拒绝、流水线迁移与旧回滚保存。未执行真实 provider 或双人体验验收。


## P1e：实际入口自主驱动

每个核心角色入口新增 driver 探针。它在任何合成的玩家 consider/wait 之前，从相同 genesis 分别 fork NPC 与 background 分支，使用现有确定性 actor scheduler、frontier、adjudication 和 WorldEngine.commitProposal。NPC 分支排除被扮演角色；后台排除 player-choice、canon-analogue 及 canonicalEventId，不用未来 canon 的成功回放作为驱动证据。模板按来源筛选，已有的到期 process/norm 继续走生产运行时的派生路径。

只有引擎实际提交、且有效进展证书非空的事件才作为凭据。空 goal、玩家自己的 goal、条件未满足、死亡角色、重复写相同值都不通过。两个分支独立起于原入口，前一个失败/无进展尝试不能改变后一个的检查起点。探针最多考察 32 个 actor candidates 和一个后台提交，在 current-window 内运行；未找到返回 unproven，不声称穷尽所有未来或模型推理可能性。它没有模型预算，也不代替 P6 的真实模型自主推进。

冻结结果包含入口 scope、head、事件正文、所有引用的 state/knowledge/semantic/process/norm 效果正文。临时工作区删除后仍可检查内容 hash、进展指针和来源；domain-module 到期事件使用已在该入口实例化的 process/norm 和冻结模板版本，不伪造小说 EvidenceRefs。认证从冻结输入重新计算角色 cut，核对凭据身份和内容；旧六项探针缺 driver 必须重新评估。此凭据是生产引擎内部 operability 的审计记录，不是独立来源语义召回或真人体验证书。

尚未完成的 P1 项保持不变：把角色 ontology/development/driver 的独立定义、尝试与实际结果统一接入持久 requirement ledger，以及历史角色审阅的保留式修订。P2–P7 仍未完成。

本段验证：`pnpm test --maxWorkers=2` 的 181 文件、1056 tests 全部通过（72.61 秒）；`pnpm check` 和 `git diff --check` 通过。9 项入口测试覆盖 NPC/环境/到期 process 的实际提交，以及静态目标、玩家行动、未满足条件、死亡 NPC、同值写入、未来 canon、坏效果 hash/进展指针和过期 cut。未调用真实模型，未进行 P7 人工体验验收。


## P1f：逐角色能力评估

新增 `core-role-capabilities.ts`，复用 `SemanticRequirement`、五种 RequirementState、依赖结算及 `RequirementResult` schema。独立名单确定 source-review 分母和每个角色的 ontology/development/opening-driver 三个稳定 ID。遗漏角色也有自己的三项要求；未解析身份只阻塞该角色的能力，不抹掉其他角色已经证明的能力。全局发布仍保留既有 roster 完整性门。

ontology 要求当前 character-v1 模型、支持的 disposition、有效实体/事件/目标绑定，以及匹配当前模型 hash 的精确证据断言。仅有 goal 或旧 traits 数字不满足本体。development 对每位独立审阅者的每条预期分别匹配维度、方向、相同上下文和前后原文单元；触发事件也必须与 episode 的证据重叠。然后调用生产 `resolveCharacterOntology` 检查触发前、完整触发后、缺一个触发、只有 world truth 没有 actor experience，以及声明的 reversal；不把未来 canon 当成该角色已经经历的事实。既有先前事件按确定时间或因果祖先构造探针上下文，不能用全书未来事件凑齐条件。

长期发展必须体现在稳定 disposition 的变化上。独立 no-development/稳定预期允许 appraisal 和临时情境倾向；更改稳定基线的 episode、时间有效性或旧 trait/bias 阶段偏移不能在稳定预期下直接通过。驱动项单独消费 P1e 的实际提交凭据，不以 ontology 或 development 的成功代替。任一 canonical/证据绑定/subject/引擎版本改变，旧结果都不能直接复用。

候选 readiness 保存 `coreRoleResult`；认证从冻结名单、模型、精确绑定和入口输入重算每项结果，拒绝缺项、旧结果与伪造 satisfied。旧候选没有这个结果时不具备新的核心角色能力证据。此模块评估运行时后置条件与已验证的原文绑定，不替代整本书的独立语义支持、场景执行及真人质量评审门。

本段尚未把角色定义修订与 reconciliation attempts 接入追加式 requirement ledger。角色结果当前随冻结候选保存；跨 reparse 的独立角色定义历史、宿主保留式复核修订、converge 后持久结算仍是下一段工作，不能将 P1f 当作 P1 全部完成。P2–P7 保持未完成。

本段最终测试：`pnpm test --maxWorkers=2` 的 182 文件、1066 tests 全部通过（74.54 秒）。新增 10 项核心角色评估测试覆盖完整逐项满足、driver 成功而角色模型缺失、错误方向/前后原文/触发事件/上下文、未经历事件、缺失 episode、临时状态不能冒充长期发展、稳定角色无需虚构成长、遗漏角色保留、精确断言作用域、旧绑定以及伪造结果。P7 的真实模型和独立人工体验未执行。

本段 `pnpm check`（服务端、Web、E2E TypeScript）与 `git diff --check` 也全部通过。


P1f 已提交为 `7dd21e4`。

## P1g：角色要求的持久修订与候选结算

两份独立角色审阅完成后，宿主将完整名单、原文基础单元、能力定义 hash、前驱与范围决策追加到既有 requirement ledger。定义校验不可变原文 hash、连续完整的基础分区及精确锚点；旧审阅 run ID 不得改写。自动登记不能删除既有要求。显式宿主命令 `requirements register-core-roles` 需要范围决策、原因和精确前驱，保留被移除的要求 ID 与全部历史；该命令不创建新审阅，也不将范围调整解释为 satisfied。

第二份审阅已经保存、账本发布失败时，原 finish recovery 可幂等补齐登记，无需重提单次模型提案。候选保存完整定义链，认证验证其活动定义、名单和原文；缺少登记的旧候选不能取得新的角色能力认证。恢复在世界材料化前检查本地历史必须为输入历史的前缀，禁止旧候选抹掉新义务。

prepare-all 的候选检查把逐项角色评估追加到账本，绑定冻结 subject 和当前定义；登记前重新运行确定性 evaluator，拒绝伪造成功、源 hash 不符及旧定义。同一结果重复登记不追加记录，blocked 结果也保留。闭包只把活动角色定义作为当前依赖，历史定义作为审计材料保留。

本段仍未完成 reconciliation attempts 与独立角色要求的关联、converge 后角色结算及失效记录，也未提供旧审阅的保留式重新双审工作流。P1 仍未完成，P2–P7 保持未完成；真实模型和独立人工体验验收尚未执行。

验证：全量 183 文件、1071 tests 通过（74.46 秒），服务端、Web、E2E TypeScript 检查通过。新增回归覆盖定义重启幂等、显式前驱/范围缩减、审阅不可改写、坏原文字节/锚点/分区、恢复历史前缀、真实冻结候选与确定性结算，以及审阅已保存但登记失败的 finish recovery。随后补充源 hash 拒绝断言，并复跑针对性测试及类型检查。


P1g 已提交为 `1a71717`。

## P1h：独立要求与修复尝试关联

新 reconciliation plan v4 在创建时冻结当时已登记的核心角色 definition revision、spec hash 和每项要求 hash；没有已登记范围时显式保存 null。工程 target/capability 通过精确 targetRef 和 capability 对应独立角色 ID，可以保留同一实体的多个独立候选要求。旧 v2/v3 计划和旧 finish 不重写，也不事后补造它们未曾冻结的关联。

finish v2 增加宿主生成的 requirementAttempts，保存独立 definition hash、repair run、原报告 ID、modelOutcome、原文 segment 引用及匹配本能力的提案 hash。匹配调用既有逐能力 proposal accounting：静态 goal 不充当 ontology 或 opening-driver，另一角色的可执行 goal 也不能代替。模型仍不能报告 satisfied；completed 只意味着 finish 协议完成。

完成回执以原 fingerprint 追加到 requirement ledger，重复完成、checkpoint 校验、宿主 finish recovery 和收敛后的 requirement service 都可幂等补齐。归档回执只补历史尝试，不重放写入或要求旧工件仍 active。prepared snapshot 复用已冻结的 reconciliation receipts，认证检查尝试的原独立定义，恢复先检查不能遗失本地尝试，再导入定义和历史回执。独立要求修订后，旧计划在打开模型前停止，旧 finish 不能重放，但其尝试历史保留。

范围限制：首次 prepare-all 的独立双审当前仍位于最终候选阶段，尚须前移到修复计划之前，才能使首次修复也绑定独立范围。converge 后逐角色评估与 stale 事件、receipt/definition/subject 结算幂等键，以及旧审阅的保留式重新双审仍待实施。本段只记录尝试，不将其当作能力满足或 P1 完成。P2–P7 和真实模型/人工体验验收仍未完成。

本段验证：`pnpm test --maxWorkers=2` 的 184 文件、1073 tests 通过（75.78 秒）；服务端、Web、E2E TypeScript 检查与 `git diff --check` 通过。真实 finish 回归覆盖只修静态 goal 的逐项缺口、完成后账本失败的恢复、重复补齐、归档重启、计划复用、修订后拒绝重放、缺定义认证诊断、历史导入及恢复前拒绝遗失尝试；独立匹配测试验证按角色及能力选择提案、禁止 satisfied 和禁止猜测范围。未调用真实 provider，未进行人工体验验收。


P1h 已提交为 `fcbafcc`。

## P1i：前置双审与修复后的逐项结算

prepare-all 在初始世界准备完成后、任何语义修复计划创建之前执行两份独立来源审阅。内部 stopAfterInitialWorld 回滚路径仍停在原边界。真实工具测试执行两次读取、单次提案和 finish 握手，确认首次修复 prompt 已冻结双审的独立范围；没有使用跳过审阅的测试替身来证明这一行为。

每个语义修复 shard 完成 converge 与坏提案隔离后，从当前 canonical 构造冻结候选并评估角色能力。候选仍拒绝 pending 世界/观察/解析/核算提案和未完成的来源批次。评估记录之后追加每个尝试的结算，幂等键绑定原 receipt fingerprint、requirement ID、definition hash 和 subject hash，结算引用同一账本中已有的完整角色评估。原本无提案的 unsupported/capability-gap 报告也有逐项实际结果，但不把该模型报告当作成功证据。

提案关联核验 accepted envelope hash 以及冻结 canonical 中的实际 payload；旧定义、未 active 或已被替换的提案记录 stale，原结果保留。候选改变时追加旧评估的失效事件，然后写新结果。来源身份变化导致旧双审无法直接复用时，先保留旧结果失效，再停止要求宿主复核，不默认为仍可认证。相同冻结 subject 的同一结算键若出现不同依赖结果会停止宿主检查，不删除旧记录或重放提案。

故障注入覆盖主评估已写入、逐项结算未完成时中断；恢复只补齐缺失结算，重复运行不增加记录。测试也覆盖初始世界有效 revision 改变、独立要求修订、身份变动无法认证、pending 提案拒绝，以及已接受但后被替换的 goal 变 stale。结算是当前后置条件的观察，不宣称某次模型工作单独造成满足。

本段仍不构成 P1 全部完成：完整评估/失效/结算历史的 frozen snapshot 引用与恢复、旧审阅的保留式重新双审、以及来源其他写入入口的失效观察仍需补齐。P2–P7 尚未完成；真实 provider 和独立人工体验验收尚未执行。

验证：全量 185 文件、1075 tests 通过（76.81 秒），服务端、Web、E2E TypeScript 检查通过。随后新增提案 active revision 的存储级回归，角色账本 6 项测试全部通过；该新增测试使用直接存储布置 accepted 状态，不冒称它验证了真实 converge。真实 prepare-all 顺序测试和既有 converge 回归共同验证各自边界。


P1i 已提交为 `a3022bf`。

## P1j：完整结算历史的候选冻结与恢复

compilerSnapshot 新增可选 requirementJournal，保存既有追加式账本的原始完整哈希链；场景和角色定义、finish 尝试、完整评估、失效与逐项结算共同保留原顺序和 hash。磁盘读取与候选解析共用同一链校验器，检查源、序号、前驱、内容 hash、定义继承、原回执、评估引用和结算键。历史角色评估还核对逐项 ID/definition hash，不能通过改写分母解释旧结果。

新候选的定义投影和回执必须与完整链对应。当前认证要求带独立定义的候选提供历史；旧格式仍可读取，但不能补造缺失的旧评估来取得当前认证。历史结果是审计证据，认证仍重算冻结 canonical 的实际能力。新增或导入审计历史改变 bundle hash；semantic subject hash 和当前世界输入比较显式排除重复的完整链，保留原有独立定义和回执输入，避免评估引用自己或仅因追加结果不断失效。

恢复先校验整条链、每份定义的不可变原文及本地链必须为输入链的前缀，再材料化世界。导入逐条复用原始 payload，重建相同序号/前驱/hash；中断可按已验证前缀续传，不恢复模型写入权限。旧候选不能抹去新增失效记录，错误在 canonical 写入前报告。已有定义/回执恢复继续幂等工作，历史导入不变成 active finish 或公开 Play 发布。

回归使用真实候选归档和新工作区 checkpoint 恢复，覆盖完整角色评估/失效/结算链保真、重复恢复、原文错误、坏 record hash、重新哈希后仍无效的 evaluationRef、缺回执、旧候选拒绝清除新失效记录，以及伪造历史 satisfied 不能代替当前独立评估。场景链也覆盖前缀导入与丢失评估拒绝。

P1 仍待完成旧审阅的保留式重新双审及迁移，并需审计其他 canonical 写入入口的失效观察。P2–P7 保持未完成；本段未调用真实 provider，也未执行独立人工体验验收。

本段最终验证：`pnpm test --maxWorkers=2` 的 185 文件、1077 tests 全部通过（76.33 秒）；`pnpm check` 的服务端、Web、E2E TypeScript 检查及 `git diff --check` 通过。


P1j 已提交为 `8b9d48a`。

## P1k：旧角色审阅的保留式迁移

新增宿主命令 `requirements begin-core-role-review`，要求明确 revision ID、旧 savedRosterHash、已有定义前驱（如有）、scope-decision 和原因。`requirements inspect` 提供同源精确字段及原修订决策。命令先将完整旧名单（包括部分审阅）、新来源名单、基础原文单元和决策追加到账本，再切换当前名单；缺原文、坏前驱和未处理的 prepared finish 都不会清空旧工作。新旧名单的原文字节与单元范围必须一致并可验证，不能为迁移伪造历史锚点。

迁移开启新 reviewRevisionId，由宿主自动附加到每份新审阅和 finish metadata，模型不能选择。新双审仍独立读取完整原文、互相隐藏判断，再通过现有单次提案与 finish 握手保存。旧批次即使在开启修订前已捕获提案，也不能提交到新轮次。来源身份变化不再静默抛弃旧名单；必须通过明确宿主修订保留旧工作。

故障发生在决策已记账、当前名单尚未切换时，可用原命令幂等恢复；完成新第一份审阅后再次执行原命令也不会清空它。同范围的新一轮 partial review 不能再次 reset；身份确已变化时，新的明确宿主决策可以保留并替代不能继续的部分审阅。历史 reviewer run ID 不得被改写。

开始重新审阅不自动批准缩减范围。新双审若移除旧名单的核心角色，第二个 finish 保持 prepared，新名单保留供宿主审查；单独登记具体范围决策后，工作流先恢复该原 finish，再继续，不开启多余的模型审阅。这个检查也保护尚未形成完整旧 requirement set 的历史部分审阅。旧版缺字段的数据原样保留为 unknown，既不抹除也不补成 stable。

当前 review revision 随 compilerSnapshot 作为独立输入冻结，并与完整账本核对；它进入 semantic subject hash，因此开始新审阅会改变评估输入。新双审及新定义未完成时不能用旧完整名单取得认证。新工作区恢复保留修订授权和完整前驱历史。

本段仍未宣告 P1 完成：需继续审计所有 canonical 写入入口的失效观察和完整验收映射，再推进 P2–P7。测试里的模型回调执行真实工具与 finish，但不是外部 provider；真实模型及独立人工体验验收仍未执行。

补充边界：每次已保存的角色审阅快照也追加到账本，保护尚未凑齐双审的新第一份审阅。旧候选恢复不能覆盖它；只有 scope 字段而缺少 journal 授权的新轮次快照在材料化前拒绝。这份快照不代替 finish completed 或能力认证。P1 整体验收仍需审计角色未完成 finish 的完整候选恢复路径，而非仅凭当前完成态恢复测试推导全部恢复场景已完成。

最终验证：`pnpm test --maxWorkers=2` 的 186 文件、1081 tests 全部通过（75.29 秒）；随后补充的缺授权边界通过 13 项针对性回归。服务端、Web、E2E TypeScript 检查与 `git diff --check` 通过，新 CLI 帮助入口已验证。没有调用真实 provider 或执行人工体验评价。

P1k 已提交为 `46dcf72`。

## P1l：角色审阅 finish 的候选恢复与认证边界

候选现在保留没有 target review 的角色审阅回执。只有冻结时仍活动的 prepared 纯角色审阅回执带有 resumeRoleReview 标记；恢复前校验原文、当前名单 subject、审阅轮次和已保存审阅内容。带世界提案依赖、其他 metadata 或 requirement attempt 的回执不具备这个恢复权限。恢复保留历史副本，并恢复原活动意图，工作流先完成原 finish 再请求下一份审阅。

模型审阅已保存不等于 finish 已完成。当前名单引用的模型审阅缺少、错配或未完成回执都会阻止认证，也不能通过继续模型会话掩盖。退休回执不带恢复标记，保持历史状态；宿主可用明确的新审阅修订保留并替代无法继续的部分工作，但活动 prepared 回执仍必须先处理。旧候选不能把已完成回执降回 prepared。

新增回归覆盖保存前中断、保存后完成标记前中断、已退休回执三种情况，使用真实工具和候选归档在新工作区重复恢复。验证原 finish 先于第二次模型调用恢复、退休回执不激活、错误 epoch 和世界依赖被拒绝、原工作区不被改写，以及旧候选不能撤销后续完成。

验证：14 项针对性测试通过；`pnpm test --maxWorkers=2` 的 186 文件、1084 tests 全部通过（75.65 秒）；`pnpm check` 的服务端、Web、E2E TypeScript 检查通过。P1 仍需完成其他 canonical 写入入口的失效观察和整体验收映射；P2–P7 尚未完成。未调用真实 provider，未执行独立人工体验验收。

P1l 已提交为 `5ac2535`。

## P1m：通用收敛与单条接受后的失效观察

通用 convergeWorldProposals 和单条提案接受命令新增宿主要求观察，补上 prepare-all 专用修复路径之外的入口。单条与批量接受 CLI 使用 compiler lock；prepare-all、reparse、repair-existing 继续由原宿主操作持锁。观察保守扫描已保留的来源：场景使用当前 canonical 评估，角色仅比较已有评估与完整当前候选 subject，变化时追加失效而不宣布新满足。没有历史评估时不补造结果。

收敛之后可能还有待隔离的无效提案，或当前 initial world 已不可冻结。这些情况记录原始错误原因及 nextSubjectSnapshotHash=null，明确表示无法观察有效后继快照；不伪造 hash，也不阻断既有 quarantine 流程。各宿主收敛报告保留这些问题。再次经过真实角色评估时，即使回到此前同一 subject，也追加失效之后的新结果；同一评估之后的重复观察保持幂等。

接受成功后账本追加失败不回滚已经提交的世界，也不要求重跑模型。新增 requirements refresh --source 在 compiler lock 下补观察，并打印账本；未能冻结当前角色输入时退出 2。空 converge 重试同样补观察。requirements inspect 保持只读。测试用真实提案接受验证 append 中断后的 accepted 状态、空重试补失效且不重复接受，以及缺 initial world 和待隔离草稿不会继承旧成功。

这仍不是 P1 的完整完成声明：直接底层 store 写入、独立 metadata/范围变化命令的即时观察及完整验收映射还需核对；当前认证继续从冻结输入重算。P2–P7 尚未完成；未调用真实 provider，未执行独立人工体验验收。

验证：`pnpm test --maxWorkers=2` 的 186 文件、1085 tests 全部通过（78.37 秒）；最终 `pnpm check` 的服务端、Web、E2E TypeScript 检查、`git diff --check` 及新 CLI 帮助入口通过。

P1m 已提交为 `366c874`。

## P1n：审阅范围与 finish 元数据写入后的观察

角色审阅宿主修订的首次执行、指针恢复和原决策重放都观察当前要求；已保存的第一份审阅及双审定义登记也接入同一入口。旧评估不会因暂未开始下次 converge 而继续被当作当前结果。观察不制造新满足，也不清除已有审阅。

finish_compiler_batch 在原回执标记 completed 后观察要求，将不可冻结原因放入文本和 requirementValidityIssues。若这一阶段追加账本失败，completed 回执和已保存 metadata 保留，恢复原 finish 只补观察，不重开模型审阅。已收敛 world-only 回执的恢复快捷路径同样接入。旧单次提交、原依赖核验和恢复边界保持有效。

回归先创建真实候选评估，再开启宿主修订，验证立即失效及原决策重放幂等；随后在第一份新审阅 finish 标记 completed 后注入观察失败，验证回执与审阅仍保留，重复宿主恢复不会增加审阅或能力评估，且最终失效引用当前真实 subject hash。

该接线位于 compiler/宿主领域入口，未向底层世界 store 或运行时 reducer 引入编译账本写入。底层直接写入后的宿主可用 refresh；认证仍强制重算当前冻结输入。P1 的完整验收矩阵仍需核对，P2 的宿主授权修复执行链尚未落地，P3–P7 也未完成。未调用真实 provider 或进行独立人工体验评价。

验证：15 项针对性测试通过；全量 186 文件、1086 tests 通过（77.38 秒）；服务端、Web、E2E TypeScript 检查及 diff whitespace 检查通过。

P1n 已提交为 `dfb6ad8`。

## P2a：受限上游修复的严格计划与差异校验

新增 upstream-repair-plan，冻结 source/requirement hash、原回执引用、所有有效依赖 revision、固定逻辑对象、允许字段、精确新建槽、可读引用、可引用 segment、依赖边、后置要求、授权及预算引用。schema 拒绝未注册写入类型、重复成员、缺基线、缺依赖槽、范围越界、依赖环与后置要求分母缩减。保留完整计划 hash；冻结本身不代表已持久授权。

写入前纯校验器使用既有 annotation/entity-resolution/event-resolution schema，比较实际 baseline/payload 差异。JSON Pointer 先解码再按注册字段匹配，不使用字符串前缀；数组只接受宿主明确授权的整个字段，不接受下标或 '-'。id/source 等未授权字段保持不变，derivation 必须精确匹配宿主本批次 provenance。身份、引语与话语中的 typed refs 必须有冻结可读依赖，或使用声明的创建依赖边；可读不等于可引用。新对象只能占用宿主预分配的单个逻辑 ID 槽，不能借计数扩大对象种类或范围。

15 项测试覆盖引语截断扩展、身份决议绑定、数组位移权限、转义 pointer、越权字段、来源/要求/依赖修订冲突、引用越界、伪造 hash、循环、分母缩减、任意新 ID 和未声明的新建依赖。服务端、Web、E2E TypeScript 检查通过。本段没有接入模型工具或执行写入；原文字节校验仍由现有证据验证器负责，测试证明的是计划和纯校验边界。

P2 尚未完成：必须继续接入持久授权状态与跨会话预算、现有窄提案工具、finish 授权回执和恢复、converge 后基线复核及逐项评估，才可执行缺 mention/quotation 的上游修复。P1 整体验收映射及 P3–P7 保持待完成。未运行真实 provider 或人工体验验收。

P2a 已提交为 `70d78b6`。

## P2b：宿主持久授权、预检与跨会话失败预算

新增 upstream-repair-preflight，从真实工作区读取并验证原文字节、deterministic segment 布局、当前独立要求定义、可读 artifact、全部 baseline revision 和 retained completed 前驱回执身份。角色定义若已进入新审阅轮次，不再以旧名单授予修复权限。授权与每次预留尝试前都重验；基线变化将原计划保留为 needs-host-review。

新增同源追加式哈希账本，保存 planned、authorized、attempt-started、attempt-failed、needs-host-review 事件；不可变 record 文件和原子 head 更新复用本地文件架构。读者验证 source、序号、前驱、内容 hash 及完整状态转移。缺 head 但保留 record 时拒绝初始化，避免预算丢失。注册与授权重放幂等；旧失败诊断不得重写。

尝试先预留再执行，未有结果时禁止开始另一模型调用。首次失败后只允许相同 proposal ID 的一次实质纠正；每个稳定 requirement ID 的累计两次失败使计划停止。计数跨 plan/batch/retryBudgetRef 保留，缩小或合并计划仍按重叠 requirement 计算。新计划要求所有重叠前驱停止、链接最近前驱并有真实共享依赖 revision 或要求 revision 变化；重排 baseline 不能伪装变化，新的计划也不能清零预算。暂未提供预算重置权限。

新增只读 requirements inspect-upstream，供宿主检查 plans[].plan.planHash、attempts[].attemptRef 及原始链。校验还补上 annotation 各类型共享逻辑 ID 命名空间的碰撞，不能用另一 annotationType 把已存在对象当作新建槽。

测试使用真实原文、来源定义与已提交 quotation，验证注册/授权、预留后重启、一次纠正、错误引用、身份轮换、两次失败停止、关联新计划不重置预算、真实依赖变化、损坏链和缺 head。当前仍无模型执行入口；成功 staging、窄工具接线、finish 授权、候选快照与恢复链尚未落地，不宣称 P2 完成。P1 完整验收映射及 P3–P7 保持待完成；未调用真实 provider 或人工体验评价。

验证：全量 188 文件、1105 tests 通过（79.41 秒）；服务端、Web、E2E TypeScript 检查、diff whitespace 检查和 inspect-upstream CLI 帮助入口通过。

P2b 已提交为 `c6e3c94`。

## P2c：真实窄提案 staging 与原草案恢复

新增宿主 stageUpstreamRepair，先预留原始工具输入及 hash，再调用既有 annotation/resolution 窄工具。参数准备也在预留之后，保留原 CompilerProposalObligations 和 withNwhToolRecovery 处理；参数错误计入失败预算，允许原 proposal ID 的一次实质纠正。

在 annotation、entity-resolution、event-resolution 的共同落盘边界追加宿主 gate，读取实际当前依赖，校验规范化 payload 的差异、原文字节 anchor、可引用 segment 与宿主 provenance。先追加 attempt-validated payload hash，再写 pending 草案，最后用 attempt-staged 冻结 envelope hash。未授权字段在落盘前拒绝，不把待验证草案变成当前 annotation/resolution 或世界真相。

若草案已写而成功记账中断，恢复依据预写入 intent 校验原 pending payload 和完整 envelope provenance，不重跑工具。缺失或篡改草案停止宿主复核；成功草案不可通过新 proposal ID 被覆盖。不确定是否已写入的宿主故障不会被记成可自动重试的模型错误。

受管 batch ID 只能以原活动授权进入 staging，普通 begin/finish 无法绕过。初始化失败后继续调用工具也会被拒绝；即使带 staging 授权，普通 finish、世界提案、检索和无关 metadata 仍未开放。尚未新增自主模型会话入口，授权 finish 接线完成前只允许宿主受限 staging。

新增真实工具回归覆盖截短 quotation 扩展、已冻结 mention/entity 的身份决议、参数纠正、越权字段、pending 草案成功记账中断与幂等恢复、篡改 intent 拒绝、普通及受管 finish 绕过拒绝；原 current annotation/resolution 在这些测试中保持未提交。针对性测试共 24 项通过。

P2 仍待实现同计划中新建依赖的有序消费、授权 finish 及恢复、候选快照中的计划/预算保留、converge 后基线复核和逐项评估，不能据当前 staging 测试宣称已完成缺 mention/quotation 的完整修复链。P1 整体验收映射及 P3–P7 仍待完成；没有调用真实 provider 或人工体验评价。

验证：全量 188 文件、1110 tests 通过（79.83 秒）；随后加强 envelope provenance 及受管工具绕过检查，并禁止受管初始化清除原边界请求，24 项针对性回归通过。最终服务端、Web、E2E TypeScript 检查及 diff whitespace 检查通过。

P2c 已提交为 `72dbd91`。

## P2d：声明的 pending 依赖链与精确修订绑定

宿主 staging 现在按计划声明的 write/creation 依赖边消费同计划已成功记账的草案，递归验证每个先前 intent、envelope hash、payload hash、provenance、原文 anchor 与传递依赖。使用 DAG 节点缓存避免共享子图重复展开；不把任意 pending 数据覆盖进 canonical preflight。解析 resolution 的来源支持时，仅使用声明并已验证的 staged dependency。

依赖尚未 staged 时，在工具参数准备和失败预算预留前停止消费者，由宿主先调度原依赖槽。已被替换、丢失或篡改的依赖不能成为消费者输入。每次 attempt-validated 冻结完整传递依赖闭包的 attemptRef/proposalHash；账本校验所有引用来自同计划更早的 staged 结果，并核对闭包与计划 DAG 一致。消费者恢复重新核验这些原引用，不重跑工具，不允许改写依赖集合。

新增真实工具回归走通 pending discourse→pending entity mention→pending entity resolution 三层链，验证错误顺序不消耗模型失败预算、改变依赖 envelope 被拒、消费者冻结传递依赖、恢复无需再次 stage，以及当前 annotation/resolution 仍未提交。25 项针对性测试通过。

P2 仍未完成：授权 finish 与恢复、计划/预算的候选快照保留、converge 后实际 revision 复核及逐项评估仍需接线；普通 finish 仍被禁止，尚无自主修复模型会话。P1 完整验收映射及 P3–P7 继续保留原范围，未调用真实 provider 或人工体验评价。

验证：全量 188 文件、1111 tests 通过（80.33 秒）；服务端、Web、E2E TypeScript 检查及 diff whitespace 检查通过。

P2d 已提交为 `42b65ee`。

## P2e：候选中的上游历史保留与预算恢复

compilerSnapshot 新增 upstreamRepairJournal，冻结完整计划、授权、原输入、失败、validated intent、staged 结果及依赖链。计划必须绑定快照内保留的原独立要求定义和 completed 前驱回执；无 target review 的普通 annotation-only 前驱也纳入历史回执捕获。当前尚未 evaluated 的上游计划明确阻止认证，不把 authorized/staged 当作能力完成。

材料化前校验完整源、序号、前驱、hash、状态转移及本地链必须为输入链的精确前缀，再校验原文字节。恢复逐条复用原 payload，生成相同原 hash；重复导入幂等，旧候选不能抹除新计划、尝试或失败计数。快照中的上游输入进入当前 subject hash，因此新增预算历史会使旧评估输入失效。

新增真实候选归档/恢复测试：两次失败后生成候选，检查未结算 gate；旧候选被拒且 canonical 未变化；新工作区重复恢复完整链和原前驱回执，第三次尝试仍因预算耗尽拒绝。另覆盖缺原定义/回执、坏 hash 和错误原文字节。导入回执保持历史状态，不激活原 finish。

当前 candidate 仍拒绝 pending proposal，因此本段证明的是可归档候选的完整上游历史及预算恢复；尚未提供带活动 pending 草案图的可移植 checkpoint。导入 journal 不补造丢失草案，也不会执行模型或提案。授权 finish、pending/finish 快照、converge 后核验与逐项评估仍待落地。P1 完整验收映射及 P3–P7 保持待完成，未调用真实 provider 或人工体验评价。

验证：全量 188 文件、1112 tests 通过（80.06 秒）；服务端、Web、E2E TypeScript 检查及 diff whitespace 检查通过。

P2e 已提交为 `7ee0ddf`。

## P2f：冻结原 finish 输入、完整草案集合与基线

新增宿主 prepareUpstreamRepairFinish，重新校验原始依赖修订、全部计划槽和已冻结的 staged 依赖闭包，再检查 batch 的精确 proposal 集合。额外 annotation/resolution、accounting、world proposal、无关 metadata 或已有普通 finish 回执均不能混入该授权。

finish-frozen 事件绑定原输入、授权链 head、来源与要求版本、每项 attemptRef/envelope hash/payload hash，并保留只读原 baseline payload。账本校验计划槽、reviewed segments 与 baseline 集合完整一致，拒绝未解决的预留尝试。冻结后不能再次授权或追加草案；重复准备只接受相同原输入和仍匹配的草案/基线，返回同一 intent。独立提取原 compilerFinishInputSchema，保留原导出兼容性和字段语义。

新增回归证明冻结及重放不提交当前 annotation、不生成 CompilerFinishReceipt，拒绝额外草案、遗漏 reviewed segments、基线变化、修改输入和伪造 hash；journal 恢复保留原冻结意图，不补造 pending 草案。

本段只是授权 finish 的冻结意图，尚未执行原 finish 验证与提交，也不代表 completed 或能力满足。授权 finish 的实际执行/中断恢复、活动 pending checkpoint、converge 后评估仍需落地。P1 完整验收映射及 P3–P7 保持待完成，未调用真实 provider 或人工体验评价。

验证：定向 26 tests 通过；全量 188 文件、1114 tests 通过（80.37 秒）；服务端、Web、E2E TypeScript 检查及 diff whitespace 检查通过。

P2f 已提交为 `352d18b`。

## P2g：授权 finish 实际提交与原回执恢复

新增 executeUpstreamRepairFinish 宿主执行入口，仅接受原 source/planHash，复用已冻结输入和既有 finish 的图闭包、来源及生命周期验证。新增 v3 回执绑定完整 upstream intent、精确 proposal dependencies 和空 metadata，保留 v1/v2 兼容读取。先持久化原回执，再由原 annotation/resolution 提交路径写入；该权限不包含 source accounting、world 或无关 metadata。

恢复读取原 pending/accepted envelope，校验 envelope/payload hash。只有持久原回执已存在，预检才允许计划槽的 active revision 为原 baseline 或本次精确输出；其他修订拒绝覆盖。字段/证据 guard 始终对冻结原 baseline 重验，不能用部分提交结果作自身基线。完成回执前再次核实全部输出已经 active。recoverCompilerFinish 自动将 v3 回执路由到相同宿主入口，不启动模型、不重跑提案工具。

finished 事件绑定实际 completed receipt fingerprint；回执完成后记账中断可幂等补齐。追加后重新观察独立要求有效性，重启也可补齐这一步。候选历史保留上游回执，finished journal 必须与对应原回执绑定，仍以未 evaluated 阻止认证。

测试覆盖 quotation 扩展、annotation 写后/完成前/账本记账前中断、三层 discourse→mention→resolution 的跨存储部分提交恢复、第三方修订拒绝覆盖、重复恢复不重复接受、不写 source accounting，以及原 finish 在提交前拒绝错误 discourse kind 并停止计划。完成仅代表批次协议，不代表缺口评估成功。

P2 仍待活动 pending/finish 可移植 checkpoint、converge 后实际修订复核及逐项评估、宿主修复调度与模型会话接入；P1 完整验收映射及 P3–P7 仍未完成。未调用真实 provider 或人工体验评价。

验证：全量 188 文件、1120 tests 通过（82.60 秒）；随后补强持久回执修订授权、快照回执绑定和确定性 finish 失败停止状态，32 项定向回归通过。服务端、Web、E2E TypeScript 检查及 diff whitespace 检查通过。

P2g 已提交为 `1300043`。

## P2h：活动草案与 finish 的可移植候选恢复

新增 upstreamRepairCheckpoint，保存 live staging/finish-frozen 计划的全部原始 envelope、pending/accepted 状态和显式活动 v3 回执。成员必须与完整 journal 中的 attempt、validated payload、staged envelope hash 精确一致；遗漏草案、重复身份、缺原回执或已完成回执对应未接受草案均拒绝。未解决的预留尝试先执行原本地恢复，不补造 envelope。

候选允许保存这组已验证的上游 pending 草案，其他 pending compiler/world 工作仍拒绝。导入在 materialize 写入前验证原文字节、segment layout、独立要求历史、原 baseline、字段/证据权限、已接受输出的 active revision 及回执生命周期；本地无关 pending、同 ID 不同内容、rejected 身份或 accepted→pending 回退均拒绝。原账本前缀及保留要求/回执检查继续生效。

恢复复用原 envelope 字节，不执行模型工具。pending 只恢复草案；accepted 只能在已验证 snapshot 的同一输出上恢复原接受状态。活动回执必须明确存在于 checkpoint，且原授权、已恢复 envelope、来源和 segment 均通过验证，才重新成为可恢复的活动 finish；历史前驱回执不激活。恢复保留原 fingerprint、preparedAt、输入和预算。完成后追加的新 journal 阻止较旧 checkpoint 覆盖。

新增跨工作区回归覆盖 staging、冻结未提交、annotation 提交后中断、回执完成但尚未写 finished 的四类状态；重复导入幂等，之后可继续原 finish，且不会重跑提案工具。覆盖篡改 envelope、遗漏草案、本地无关 pending 拒绝及失败前 canonical 未写入。

另将 discourse→mention→resolution 跨存储中断点归档到新工作区，恢复已接受 annotation 与仍 pending 的 resolution，再完成原 finish，验证多类型依赖链迁移。

该路径仍使用候选的既有前提：原始 compiler batches 已完成、存在 evidence-backed initial world；本段没有新增任意早期编译状态的通用 checkpoint。P2 仍待 converge 后实际修订复核与逐项评估、修复调度/模型会话接入；P1 完整验收映射及 P3–P7 仍未完成，未调用真实 provider 或人工体验评价。

验证：全量 188 文件、1123 tests 通过（82.00 秒）；随后补充 staging 与跨存储依赖链迁移、活动回执/接受状态约束，36 项定向回归通过。服务端、Web、E2E TypeScript 检查及 diff whitespace 检查通过。
