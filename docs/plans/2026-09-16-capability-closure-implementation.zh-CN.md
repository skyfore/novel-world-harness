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

P2h 已提交为 `85ab5cc`。

## P2i：converge 后实际修订核验与停止状态

在通用 converge 完成确定性提交后检查所有保留来源的 finished/converged 修复，重新验证原 completed 回执、输出 active revisions、原未授权变更的 baseline 和独立要求定义。没有同源 pending world/annotation/resolution/accounting 工作时，追加 converged 事件，绑定原 finish fingerprint 与完整实际修订集合；账本拒绝遗漏、重复或与授权输出不符的修订。

下游 pending 和宿主观察 I/O 中断保留 finished 状态，可在处理原工作后通过空 converge 重试宿主观察，不重跑模型、不新增尝试。确定性回执/授权冲突转为 needs-host-review，保留原因和当前工件。已经 converged 的计划仍会重新核对实际依赖；变化后停止，未变化的重复观察幂等。prepare-all、repair-existing、reparse 和 proposals converge 显式报告 upstreamRepairIssues。

可移植 checkpoint 扩展保留 finished/converged 的原 envelope 与活动回执，使迁移后仍可凭原证明继续核验。旧历史型候选继续可读，但缺失的 envelope 不会被补造或当成 convergence 证明。新增测试覆盖提交前禁止 converged、真实输出修订、伪造记录拒绝、pending 延后、存储中断后空重试、收敛前后第三方修订均停止，以及 finished/converged 跨工作区继续观察。

converged 仍不等于 evaluated，认证继续保留 NOT_EVALUATED 阻塞。P2 尚待逐独立要求评估、结果失效及认证接线、修复调度/模型会话入口；P1 完整验收映射及 P3–P7 保持原范围，未调用真实 provider 或人工体验评价。

验证：42 项定向回归通过；全量 188 文件、1130 tests 通过（86.39 秒）；服务端、Web、E2E TypeScript 检查及 diff whitespace 检查通过。

P2i 已提交为 `c3c8375`。

## P2j：逐独立要求评估、输入失效和认证重算

新增版本化 upstream evaluation，绑定原 plan/definition、completed receipt、convergence record、实际候选 subject hash 及完整选定 requirement 结果。宿主读取当前工作区并调用原场景/核心角色评估器，不接受模型成功声明；未知、阻塞、未映射均保留原状态。本体、发展、开场驱动仍是分离的义务，局部通过不替代其余项。

认证从当前冻结定义和 canonical 输入重算选定结果，比较实际结果与保留 evaluation，并逐项要求 satisfied。合法关联后继计划承接重叠稳定 requirement ID 的活动义务；旧计划、失败与预算历史不删除，后继尚未评估时仍阻塞。其他角色、世界闭包与真实质量验收 gate 不受这一步替代。

subject hash 投影保留计划、授权、原输入、预算、finish、converge 等输入 payload，排除派生 evaluation/invalidation 及其哈希链元数据；完整原 journal 继续持久化、校验和导入。追加评估不会产生自引用失效。原 host requirement observation 接入上游失效记录：输入变化或 pending 等原因导致候选无法冻结时，保留旧结果并使当前状态回到待评估；认证无需等待显式 refresh 也能拒绝旧 subject。

新增 requirements evaluate-upstream --source，在 compiler lock 下执行宿主结算，返回逐项结果和剩余 issues；有未解决上游问题时退出 2。prepare-all 在候选阶段结算 eligible 修复。重复相同评估幂等；可移植 checkpoint 保存 evaluated 状态，跨工作区恢复后可继续核验，旧记录不会被当作新结果。

回归覆盖缺失能力不冒充成功、篡改结果即使重算 journal hash 仍被认证拒绝、评估/失效不改变自身输入 hash、真实 no-change 要求满足、后来 canonical 改变导致 stale、无法冻结时失效、后继计划仍承接未满足义务，以及核心角色三类能力的独立重算。真实质量验收仍会阻止不完整世界发布。

P2 尚未整体完成：自动修复规划/调度、受限模型会话接入、后继修复执行及全链验收仍待落实。P1 完整验收映射及 P3–P7 保持原范围，未调用真实 provider 或人工体验评价。

验证：66 项定向回归及全量 188 文件、1135 tests 通过（87.23 秒）；随后加强结算入口与未知来源检查，44 项最终定向回归通过。服务端、Web、E2E TypeScript、evaluate-upstream CLI 帮助入口及 diff whitespace 检查通过。

P2j 已提交为 `7628c32`。

## P2k：单槽 Pi 会话、持久预留和后继执行

新增宿主单槽运行入口 runUpstreamRepairModelSlot，沿用 PiAgentSession 的 provider、超时、流式回调和原提案工具 schema。会话创建前持久化原计划、目标、固定 proposal ID 和 prompt hash；不加载项目指令、本地文件工具、NWH extension 或旧会话。仅提供冻结授权上下文读取和对应一种窄提案工具，原文及工件明确视为不可信证据。选定工具先登记尝试，再解析 JSON 和执行原字段、证据、身份及依赖验证；模型不能 finish 或直接修改 canonical。

无提案返回也记一次失败，已有 typed 失败不会在会话结束时重复计数。预算跨关联计划保留，耗尽时在 provider 创建前拒绝。一个原始调用未解决时，禁止新模型调用、旁路宿主 staging 和 checkpoint 迁移。写入后 bookkeeping 中断可按原 sessionRef 校验并恢复已存在的草案，不调用模型或重新执行提案工具；没有原 validated 结果时保留预留供宿主检查，不重放。

修正原成功草案的后继限制：旧计划必须已经完成原 finish、明确停止，且新计划通过原依赖修订/定义变化及前驱关联检查；新 proposal ID 不覆盖旧 accepted envelope。尚未完成的成功草案仍不能通过此入口直接替换，相关撤销/退休流程待后续实现。

新增回归覆盖创建 Pi 前已持久预留、仅两种工具及隔离选项、格式错误后同身份一次修正、无提案跨计划预算、第三次 provider 调用前停止、completed 后继保留旧草案，以及写入中断时禁止重复调用/迁移且可恢复原结果。会话测试使用注入的 session factory，未调用真实外部 provider，不能作为真实语义抽取或体验验收证据。

本段是单槽执行 API；自动诊断到计划、完整 DAG 调度和正常命令入口仍待实现。P2 尚未整体完成，P1 完整退出证据映射及 P3–P7 仍保留原范围。

验证：37 项定向回归及全量 188 文件、1139 tests 通过（89.61 秒）；服务端、Web、E2E TypeScript 检查及 diff whitespace 检查通过。

P2k 已提交为 `a86c42f`。

## P2l：已授权单槽执行与原会话恢复命令

新增 requirements run-upstream-slot 和 recover-upstream-session。命令从 inspect-upstream 返回值复制精确 plan/slot/session 引用，不隐式注册或扩大授权，不替代 finish/converge/evaluation。运行命令支持显式 extractor 配置、model override 和受限超时；配置或类型错误在模型调用前拒绝。两条命令均持有 compiler lock，正常异常路径释放锁，进程丢失沿用原锁恢复与原草案恢复协议。

新增命令测试验证模型执行期间确实持锁、并发编译被拒、原错误传播和 finally 释放，以及非法类型/缺失配置不进入模型调用。CLI 帮助可显示两条正常入口。仍无真实 provider 调用；自动规划、DAG 调度及完整 P2 退出证据尚未完成，P3–P7 保持待实施。

验证：两个相关测试文件共 38 项通过；服务端、Web、E2E TypeScript、两个 CLI 帮助入口及 diff whitespace 检查通过。此前单槽底层提交的全仓 1139 项通过；命令接线后未重复全仓测试。

P2l 已提交为 `5b6d41c`。

## P2m：授权 DAG 的顺序调度与恢复复用

新增 stageUpstreamRepairPlan 和 requirements stage-upstream-plan。从原冻结计划计算稳定的依赖优先顺序，先核验已有成功 envelope，再逐槽调用原隔离 Pi 入口。只消费 authorized/staging 计划，不注册或扩大权限；源或 baseline 前置检查失败保留原因并停止原计划。

重启时恢复确有 validated 原结果的未结束会话，再复用原 staged 提案；没有可恢复结果的预留禁止新模型调用。对每个槽再次核验原 envelope、依赖修订、证据和授权字段。运行器返回文本或非持久结果不能当作成功。调度器没有外层模型重试循环，持久失败预算仍由原单槽协议管理。最终只返回 staged，finish/converge/evaluation/publication 仍分别受宿主验证约束。

新增测试覆盖缺 speaker mention 的 quotation 依赖顺序、前置槽成功后中断、续跑只执行缺失槽、整计划重复执行零模型调用、原 canonical 保持不变、baseline 漂移停止，以及空会话预留和虚假运行成功拒绝。测试采用受控槽运行器与真实存储/验证，不是外部 provider 证据。

P2 仍待从结构化诊断生成授权计划、计划/finish 正常宿主命令与整体退出证据；P3–P7 尚未实施。不得将本段 staged 调度等同于完整修复闭环。

验证：全量 189 文件、1142 tests 通过（89.44 秒）；补强前置失败停止状态后，40 项最终定向回归及服务端、Web、E2E TypeScript 检查通过。stage-upstream-plan CLI 帮助与 diff whitespace 检查通过。

P2m 已提交为 `80210eb`。

## P2n：宿主计划生命周期命令

新增 register-upstream-plan、authorize-upstream-plan、finish-upstream-plan、stop-upstream-plan 和 observe-upstream-convergence。登记只保存严格校验后的冻结计划，不授予写权限；授权在 compiler lock 内重新检查当前源和依赖。停止保留原原因、草案和预算，不允许重开原计划。正常宿主范围不新增人工批准步骤。

首次 finish 必须提供原 host review JSON，通过原 schema、精确 segment/inventory、证据及身份校验后冻结再提交；已有 intent 时不重新准备，直接恢复原回执。外部文件若更改输入则拒绝，省略输入即可沿用原 frozen input，支持输出部分接受后的恢复。完成后继续使用实际 convergence 和独立 evaluation，命令不自动认证或发布。

observe-upstream-convergence 核对已提交的实际修订，不接受无关 pending 世界提案；仍有同源 pending 时保留原 finished 状态和诊断。这样已有合法冻结计划可经正常 CLI 完成登记→授权→依赖 staging→finish→convergence observation→evaluation，不必借用批量 accept 操作推进其记录。

新增集成测试使用真实文件/账本/annotation 存储，验证跨源登记拒绝、重复登记幂等、登记不等于授权、首次缺 review 不改 canonical、commit 时确实持有 compiler lock、annotation 提交后中断释放锁、替换 frozen input 被拒、原输入恢复和重复 finish 幂等，以及停止后不能重新授权或 finish。没有调用真实外部模型。

P2 自动诊断到严格授权计划及完整退出证据仍未完成；P3–P7 保留原范围。

验证：41 项相关测试通过；最终服务端、Web、E2E TypeScript、requirements 命令列表及 register/finish/convergence 帮助入口、diff whitespace 检查通过。本段未重复全仓测试，最近全仓证据仍是上一段 189 文件、1142 项通过。

P2n 已提交为 `1df2d00`。

## P2o：结构化复核诊断到固定权限计划

新增 upstreamRepairReviewSchema、planUpstreamRepair 与 requirements plan-upstream-repair。输入明确绑定原 source/requirement revisions、计划与预算身份、可引用 segment 和宿主复核依据；不解析错误字符串，也不接受自由 pointer 或 mutation kind。输出仍是 diagnostic-only，不自动登记、授权或写入世界。

先实现两类 annotation 根因。QUOTATION_ANCHOR_INCOMPLETE 核验当前 quotation hash 和宿主复核 expectedAnchor，要求严格扩展当前锚点且精确匹配原文字节、落在明确 citable segment；固定授权仅 /anchor。QUOTATION_SPEAKER_MENTION_MISSING 要求 quotation 的 typed speaker 引用确实缺失，使用该既有引用分配唯一 mention 创建槽，添加原要求和 quotation 的依赖边，不从自由文本猜新 ID。baseline 与 readable 集合由实际对象派生，再通过原完整 source/definition/receipt 预检。

reviewHash 绑定 authorizationRef。SEMANTIC_MODULE_REQUIRED 返回 needs-host-review、无计划；混合存在不支持语义时也不扩大为部分写权限。真实 requirement 满足仍由下游独立 evaluation 判定，生成计划或修好引用不自动清空义务。

回归覆盖严格权限生成、无隐式授权、相同输入稳定、缺 mention→quotation 依赖暂存→原 finish 的实际存储链、源修订后旧诊断拒绝、虚假缺失引用、未扩展锚点、注入额外 pointer、未知语义转宿主审阅，以及第二个原创短文本的较长引语范围。首轮测试错误读取不存在的 anchor.exact，已修正为完整字节锚点比较，保留实际失败记录，不修改产品契约迁就断言。

本段是显式宿主复核输入的自动计划转换，尚未自动发现所有诊断。resolution 与后续 expression/perception/executable 根因的规划策略、P2 完整独立退出证据和 P3–P7 仍待实施。未调用真实 provider 或独立人工评审。

验证：44 项最终定向回归通过；全仓 189 文件、1146 tests 通过（91.80 秒）；服务端、Web、E2E TypeScript、plan-upstream-repair CLI 帮助与 diff whitespace 检查通过。

P2o 已提交为 `c7d60ed`。

## P2p：实际依赖发现、缺失 resolution 规划和负依赖核验

新增 discover-upstream-repairs。读取当前同源 annotations 和 active resolution refs，核验原文字节及 segment layout，报告真正缺失的 speaker mention/entity resolution/event resolution。返回精确 diagnostic、来源 segment 和同源 canonical candidate ID/revision/ref 目录；目录不是身份匹配结论，发现本身不绑定 requirement 或产生授权。已有 unresolved/ambiguous/non-referential 记录不会被当作不存在。

规划器新增 ENTITY_RESOLUTION_MISSING / EVENT_RESOLUTION_MISSING，要求原 mention revision 未变且实际没有 resolution，候选必须明确列出同源 ID 与实际 payload hash。冻结 mention 与候选依赖；只创建一个 resolution，不创建 entity/event。创建 ID 由 source/kind/mention 稳定派生，不随 plan/batch/budget 改名；模型输出必须保持这个槽对应的原 mention。

新增可选 resolutionAbsences 计划约束，兼容读取未声明该约束的旧计划，新缺失 resolution 计划必填。授权、staging、finish/recovery、convergence 原预检及 checkpoint 状态核验均检查实际负依赖：另一个 ID 为同一 mention 建立 resolution 后，旧计划不可再按“缺失”执行。仅原 durable receipt 对应的精确自身输出可在部分提交/恢复中例外通过。约束属于冻结计划与 subject 输入，预算与原历史保持不变。

回归覆盖实体成功决议、事件无法建立匹配时保留 unresolved、稳定槽身份、缺失发现不授予权限、生成计划→原 staging/finish 的实际存储链、已有未知记录不可重复创建、输出 mention 不可偷换，以及后续另一 resolution 使实际预检失败。另验证 checkpoint 接受原自身输出并在 materialize 前拒绝伪造的其他 resolution 状态。没有把结构性缺失消失报告为独立能力满足。

P2 仍需把诊断与独立要求的绑定纳入自动流程、补齐修订类根因策略与完整退出验收；P3–P7 仍保留原范围。未调用真实 provider 或独立人工评审。

验证：全仓 189 文件、1148 tests 通过（93.38 秒）；补充候选引用输出和 checkpoint 负依赖验证后，61 项最终定向回归及最终服务端、Web、E2E TypeScript 检查通过。discover-upstream-repairs CLI 帮助和 diff whitespace 检查通过。

P2p 已提交为 `8d9e913`。

## P2q：场景要求的实际依赖路径绑定

新增 bindUpstreamRepairRequirements 与 requirements bind-upstream-repairs。compiler lock 内重新发现当前结构诊断、冻结候选、读取原文并重新评估活动独立场景要求；只从尚未满足的 event/norm/action 目标沿实际有向类型依赖追踪到诊断的确切 annotation revision。返回 subject/closure hash、原 definition revision/requirement ID 和路径上的 node revisions，不接受调用方提供的绑定或成功声明。

共享 source/unit、roster、entry、整组 requirements 或文字重叠不会构成绑定依据。无路径的 finding 明确保留 unbound；核心角色绑定仍需独立宿主判断，不从角色名猜关联。闭包只解析一次，每个目标复用一次有界图遍历，避免每个 finding/capability 重复扫描全图。重复节点和过期 edge 拒绝，环不会导致无限遍历。

核查发现闭包遗漏单值 speakerMentionId/viewpointMentionId，已补入 annotation 引用表；缺失说话者和视角引用现在会形成实际 dangling dependency。既有认证入口继续重建 closure 并比较旧评估，新增发现不会绕过 WORLD_CLOSURE_STALE 校验；没有改写原 snapshot 或运行时事件解释。

测试覆盖实际 canonical event→attribution→quotation 依赖与未满足 scene requirement 的绑定、删除依赖后即使原文重叠仍解除绑定、subject 修订变化、不写上游授权历史，以及共享文本/猜测角色/旧 revision/重复节点/环等反例。结果仍是诊断层的依赖证明，不是满足证明或自动写权限。

P2 尚待自动消费这些已证实绑定、核心角色的精确绑定、修订类根因策略与完整退出验收；P3–P7 继续保留原范围。未调用真实 provider 或人工体验评价。

验证：55 项相关回归通过；随后缓存每个目标的图遍历结果，最终全仓 190 文件、1152 tests 通过（91.67 秒）。最终服务端、Web、E2E TypeScript、bind-upstream-repairs CLI 帮助及 diff whitespace 检查通过。

P2q 已提交为 `58203a5`。

## P2r：消费当前场景绑定并冻结完整受支持路径

新增 planBoundUpstreamRepair 与 requirements plan-bound-upstream-repair。请求只选择当前 source/subject/closure/definition/finding 和宿主 scope、预算身份；不能传入替换 requirement ID 列表。宿主重新生成绑定报告，每个 finding 都须在选定定义下有当前未满足要求的类型路径，自动保留其全部关联 requirement IDs。

resolution 候选只选实际 discovery 目录的同类型 ID，revision 由宿主读取；mention 创建拒绝候选配置。沿用原结构化诊断策略产生精确槽，并把绑定路径上的工件修订合并到 baseline/readable refs。扩展的 attribution/claim 等 canonical 类型仅可读，annotation/resolution 六种写类型不扩大。bindingHash 与 reviewHash 留在原 authorizationRef。

测试证明原 event→attribution→quotation 路径完整冻结、原要求集合由绑定派生、无隐式 ledger/授权写入、传入自造要求 ID 或 finding 被拒，以及路径变化后旧请求和旧计划登记均失败。首次追加断言放入了错误的旧测试作用域，定向回归捕获后已移至正确集成用例，未改产品约束掩盖失败。

没有可注册 baseline 表示的路径节点明确停止，不省略 revision guard。当前 evidence-binding/无对应可读工件的结构 discourse 路径、核心角色自动绑定和独立复核 quotation extension 仍需原宿主审阅；本段未把文字重叠当作绑定替代品。P2 与正常编译流程的自动调度接线、修订类根因和完整退出验收仍待完成，P3–P7 保持原目标。未调用真实 provider 或人工体验评价。

验证：63 项最终定向回归通过；全仓 190 文件、1152 tests 通过（90.26 秒）；服务端、Web、E2E TypeScript、plan-bound-upstream-repair CLI 帮助与 diff whitespace 检查通过。

P2r 已提交为 `0eac855`。

## P2s：正常 prepare-all 的已授权修复阶段与取消恢复

新增 prepareAuthorizedUpstreamRepair，接入 prepare-all --upstream-plan / --upstream-finish。在现有 compiler lock 内、普通编译/缓存恢复/广泛协调之前执行明确选定的已有授权计划。首次运行先检查完整 host review 与精确 segment 集合，之后调用原 DAG staging、finish 冻结/提交和实际 convergence observation；已有 intent 时直接恢复原回执，不重新 staging。

计划仍需先经原宿主策略登记授权，不把 diagnostic-only 输出或 planned/stopped 状态当权限。坏输入在模型调用前停止；冻结输入不可替换。原 finish 部分提交可用同一 planHash 省略 review 文件恢复。成功后本次 prepare-all 禁用旧缓存恢复，继续原要求结算、候选和认证流程，不修改旧 published bundle，不将 converged 当作 evaluated。

新增协作取消：prepare-all CLI 传递 SIGINT/SIGTERM，单槽调用转发 Pi abort、清理会话并保存原结束原因；预先取消不增加预留。已调用且没有 typed 结果仍遵循既有失败预算与停止协议，未解决写入保持原恢复约束。没有新增外层模型重试循环或模型写工具。

测试验证选定修复先于普通 compile、确实持锁、失败释放锁并阻止后续编译、成功后不调用 cache restore、错误选项组合拒绝、首次 review 缺失/错误不调用模型、部分提交恢复不重新 staging、重复恢复幂等，以及取消传播和持久原始诊断。

本段为明确选定授权计划的正常流程入口；自动发现/规划/授权策略尚未默认调度所有根因。核心角色及不支持路径/修订策略、P2 完整退出验收和 P3–P7 仍待完成。未调用真实 provider 或人工体验评价。

验证：65 项最终定向回归通过；全仓 190 文件、1155 tests 通过（91.13 秒）；最终服务端、Web、E2E TypeScript、prepare-all CLI 帮助与 diff whitespace 检查通过。

P2s 已提交为 `92c2100`。

## P2t：持久复核输入与默认授权计划续跑

新增 append-only finish-review-recorded 记录。prepare-all 在 staging/模型调用前保存完整宿主复核，绑定原计划和精确 source segment 集合；重复保存同一输入幂等，替换输入拒绝。finish intent 继续冻结实际 proposals、原始 baselines 与当前授权链头，并检查其输入与已保存复核一致。旧日志没有单独复核事件时，仍可恢复原 frozen intent。

默认 prepare-all 在普通编译和缓存恢复之前，顺序恢复该 source 当前有效的 authorized/staging/finish-frozen/finished 计划。只恢复既有授权，不从诊断创建权限；当前 needs-host-review 计划阻止普通模型流程。首次缺失复核时在模型前停止并给出原 source/plan 的修复命令。宿主中断后无需原外部文件即可继续，finish-upstream-plan 也可读取同一份持久输入。

回归覆盖复核先于 staging 持久化、中断后默认输入恢复、禁止复核替换、单次记录幂等、默认准备优先路由已有授权、停止状态不继续普通编译，以及原 finish、checkpoint 和预算恢复约束。

本段只补齐既有授权任务的默认续跑。新根因的自动规划/授权策略、核心角色和未支持路径/修订策略、P2 完整退出验收、P3–P7 仍未完成。没有真实 provider 或人工体验验收证据。

验证：67 项定向测试通过；最终全仓 190 文件、1157 tests 通过（92.28 秒）；服务端、Web、E2E TypeScript 与 diff whitespace 检查通过。

P2t 已提交为 `d8ca239`。

## P2u：结构 discourse 的独立只读依赖校验

新增 structural-discourse 只读引用。bound planner 根据实际 structure manifest 区分结构 discourse 与 Pi discourse-segment annotation，分别冻结同 ID 工件的 revision；预检从原 source/hash 的结构清单读取，checkpoint 校验从原 frozen structure 读取。既有六类 typed 写权限不扩展。

新增真实 event→attribution→quotation→structural discourse→annotation discourse→viewpoint mention 的未满足要求绑定用例，验证缺失 resolution 的修复计划保留两种 discourse baseline。两条负例验证结构 revision 变更或删除在模型 attempt 前停止，结构工件不能放入 allowedWrites。原七种 staging/finish/converge/evaluate 状态的跨工作区恢复用例均加入结构 baseline，检验 portable checkpoint 不丢失依赖。

此段补齐结构路径 guard，不代表 P2 完整退出验收。evidence-binding 表示、核心角色自动绑定及修订类策略等仍待落实；P3–P7 仍在原目标范围。未调用真实 provider 或人工体验评价。

验证：全仓 190 文件、1159 tests 通过（90.41 秒）；最终预检只读取声明结构依赖的调整后，52 项定向测试及服务端、Web、E2E TypeScript 检查通过；diff whitespace 检查通过。

P2u 已提交为 `bf461a9`。

## P2v：引语修复到原获知要求结算的串联验收

新增 upstream-repair-acceptance.test.ts。两段独立原创 note-reading 场景改变角色名称、句序并加入无关角色；在写入候选世界工件之前，从原文字节冻结阅读前后及 believes 状态预期。测试通过真实宿主 planner、授权 ledger、typed staging、原 finish、converge、source requirement settlement 和 upstream evaluation 串联验证。

截短 quotation 无法支持 proposition 的精确 /object/value 证据；原 attribution/event 草案首先由正常 commit validator 阻断。宿主修复完整引语后，同一批下游草案以原 ID 和完整原 envelope 提交，独立要求保持原 ID/分母并由未满足转为满足，原 repair 最终 evaluated。检查非授权 quotation 字段不变，未通过重写 attribution、改变 acquisitionMode 或替换 proposition 绕过证据。

每段原文另有仍然截短的反例：提交与 finish 成功不等于能力通过，下游原草案继续 pending，要求继续未满足，修复 ledger 保持 finished 且不能产生 evaluated。此处主动验证修复后重新结算，而不是以工具成功返回作为效果证明。

本段为确定性工程验收；原 canonical 背景为测试夹具，不是 fresh model compile，fixture review 不冒充独立人工体验评价。尚未覆盖缺 mention 的完整串联验收、所有角色/修订根因或 P2 全部退出条件；P3–P7 仍待落实。没有真实 provider 调用或人工体验验收证据。

验证：全仓 191 文件、1163 tests 通过（94.35 秒）；最终反例具备完整背景并明确断言 pending 下游导致 candidate 拒绝，4 项定向测试通过；服务端、Web、E2E TypeScript 与 diff whitespace 检查通过。

P2v 已提交为 `819222e`。

## P2w：缺失 speaker mention 到身份决议及获知结算的串联验收

新增两段原创说话/听话场景，改名、改变对话与叙述顺序并加入无关角色。原文明确听者等候消息，独立冻结听话前后及 believes 预期；初始场景依据原文建立行动 plan，避免以 bare alive 清单跳过生产 candidate 可行动性验证。

真实 discovery 从 quotation 的 dangling speakerMentionId 产生 typed finding，宿主 planner 仅授权对应 ID 的 entity-mention 创建。沿 ledger/staging/finish 创建 mention 后，quotation 全字段不变，下游 attribution/event 仍因未决 speaker identity 阻断，独立要求未满足。随后原普通编译窄工具提交 source-grounded entity resolution，原 finish 提交决议，converge 沿用下游原 proposal ID/envelope，最终相同要求集合满足并进入 evaluated。

每段场景另有 unresolved 决议反例：保留不确定身份，不将 mention 或 resolution 提交成功视为理解/获知成功；原草案保持 pending，原要求保持未满足，candidate 明确因 pending 草案拒绝，原修复停留 finished。首次测试遗漏 mention surface，原工具明确拒绝；补齐真实输入后，多角色 initial-world 可行动性检查进一步要求开场依据，修正源夹具后通过。未降低产品校验或绕过 finish。

本段补齐 P2 缺 mention 的确定性串联证据。新根因的完整调度/策略、核心角色绑定和全部退出审计仍未完成，P3–P7 保持原目标范围。背景 canonical 为工程夹具，不是 fresh model compile；没有真实 provider 或独立人工体验证据。

验证：最终全仓 191 文件、1167 tests 通过（93.08 秒）；8 项串联定向测试通过；服务端、Web、E2E TypeScript 与 diff whitespace 检查通过。

P2w 已提交为 `80e1d34`。

## P3a：SemanticEffect 首条持久纵向链

新增独立 semantic-effect-v1 工件，区别于分支已提交 semantic delta。首个宿主注册表包含 state-change（field/value）和 temporary-incapacity（action/speech/perception、独立 duration），绑定原 occurrence、subject 和 validTime onset。lowering 独立记录；state-change 只有同 occurrence 的 action-bearing event-execution、原 agency/schema 验证和精确 set outcome 全部通过才可 mapped；失能暂保留 unmapped，包括未知时长，不伪造数值或执行能力。

同一实现覆盖 compiler proposal schema/semantic-stage 窄工具、逐语义字段精确 evidence、finish graph/converge、canonical revision store、artifact discovery、编译工作集、audit、prepared candidate/restore、closure、reparse、冻结 runtime context、API 和运行时消费。新类型只作为 P2 的只读 baseline，不扩展上游六类写权限。compiler pipeline 升至 36：兼容旧版只保留 structure/observation checkpoints，semantic/executable 必须重验；engine 0.5.0 对旧 branch history 明确拒绝解释，旧无新类型的 canonical snapshot 可读但不补造效果。

运行时只通过原 action/reducer 执行 mapped 效果，不追加另一份 state delta。canonical realization、genesis realization 和 projection replay 均拒绝 unmapped 效果；未来 canon 不因此成为当前事实，也不阻止没有声称实现该 canon 的独立行为。快照冻结 effect revision，原 source/背景事件不被效果工件反向改写。新模型工具沿正常 Pi withNwhToolRecovery 注册；缺 ref 提供同 source 的 finder/readArguments.ref/payload.id 和一次纠正约束，未映射/时间或 lowering 冲突明确停止原任务。

两段原创失能场景验证精确字段证据缺失拒绝、finish→converge 持久化、完整 closure refs、跨工作区 checkpoint 恢复、冻结 context 重载、unmapped 实现与 genesis 拒绝、丢失字段证据后 candidate 拒绝且旧快照保留。另两段改名/句序扰动的赠物场景验证真实 action execution lowering、错误 outcome/缺 execution 拒绝、实际 branch commit 和无 checkpoint 重放、原状态/事件不变，以及坏 finish 不写 canonical。恢复协议测试检查精确字段和有界重试。

这是一条新持久类型的纵向实现，不代表 P3 完成：Expression/Perception/Acquisition 及其复用命题/嵌套/晚期报告/legacy 验收仍待完成；失能执行扩展属于 P4，P5–P7 仍在原目标范围。P1/P2 余下完整退出审计仍保留。未调用真实 provider 或独立人工体验评价。

验证：最终全仓 192 文件、1173 tests 通过（95.73 秒）；此前 111 项编译/重建定向、65 项类型/状态定向和 33 项语义/恢复定向通过；最终服务端、Web、E2E TypeScript 与 diff whitespace 检查通过。首轮全仓发现工具固定数量及 pipeline-35 进度预期已过时；迁移按新语义边界调整为保留 observation 并重开 semantic/executable，未将旧检查点当作新能力证据。

P3a 已提交为 `1cce655`。

## P3b：表达内容的 schema 覆盖与嵌套验证前置链

修复既有 attribution 内容检查从提交 assertion 推导必需字段的缺口。新增确定性表达内容评估器，从实际 proposition object schema 推导语义叶字段；父命题必须同时覆盖 propositionId 引用及递归子内容，父 /object 的整体证据不能免除子内容要求。每条 assertion 内 anchors 为 AND，同字段的不同 assertion 为 OR；每个 anchor 必须位于某一原始 fragment，不能跨片段空隙。返回具体 proposition ID、object hash、缺失路径及 missing/cycle/expansion-limit 分类，最多展开 32 层。

现有 proposal 与 committed attribution trace 均接入实际命题及精确证据目录，pending overlay 只参与候选验证。错误恢复定位实际缺陷子命题，并提供同 source 的 discovery/ref 字段与一次纠正约束；循环和展开上限明确停止重试。旧三参数纯函数保留兼容，无精确内容断言的旧 attribution 仍可读，不补造证明，也不作为新表达认证。

两个原创改名/句序场景覆盖字段伪装、同命题不同话语、片段间隙、AND/OR、父引用与子内容；额外测试覆盖缺失引用、循环和深度边界。两个持久化场景通过正常 quotation proposal/finish 创建引用，验证已提交父/子命题的异处证据被拒、pending 修正不改 canonical 验证、单独更新 committed binding 后通过且原命题/quotation 不变。最后一步为工程夹具直接更新 evidence binding，不宣称完成新的 Expression finish/converge 纵向链。

本段是生产验证器修复和新表达类型的前置能力，不是 UtteranceExpression 持久化交付；独立 expression revision/evidence、Perception、Acquisition 及 P4–P7 仍待实现。未调用真实 provider 或独立人工体验评价。

验证：全仓 193 文件、1178 tests 通过（96.45 秒）；最终恢复提示定向 3 tests 通过；原生语义契约 2 文件通过；服务端、Web、E2E TypeScript 与 diff whitespace 检查通过。

P3b 已提交为 `206f2a7`。

## P5a：已提交台词身份与完整块验证发布

按方案允许的独立顺序先推进台词机制；P3 Expression/Perception/Acquisition 的完整纵向工件链仍未完成，没有拆出仅 schema 的持久类型提交。

运行时从不可变 eventId 与事件内零起始 utteranceIndex 派生稳定 utteranceId，保留已提交历史的顺序、speaker/addressees 和原字节；actor 可见性过滤后仍使用原事件内索引。无需覆写旧 event 或改变 reducer/engine 解释。新 turn frame 将身份传递给 narrator；同文发言各有独立 ID，不按文本去重。

有身份的 accepted turn 使用 narration-blocks-v1：prose 或 committed-utterance ID。宿主按顺序插入原话，拒绝缺失、重复、逆序、未知 ID，以及 prose 额外复制原话或内部 ID；相邻 prose 也不能拆词绕过。短句/子串歧义要求改写 prose，不删除合法发言。新格式的段落重复检查只针对 prose，长台词合法重说与嵌套短句不会因此被拒。终端和 Web 应用边界再次验证 typed output 与最终文本逐字一致，纯文本不能替有身份 turn 通过新契约。旧无 ID frame/无锁定台词的叙述继续走既有文本格式，不据此宣称新 block 认证。

Pi 在完整输出解析、身份/顺序、叙述约束全部通过后才发布文字；provider text/native assistant events 为草稿，不转发给用户。终端与 Web 同样扣住注入 adapter 的草稿；Web 发布带 validated 标记的完整文字，前端拒绝未验证 delta。断流/取消仍保留已提交 world event，现有 narration-retry 在原 head 只补叙述。非法块只允许同一冻结 frame 的一次干净重渲染；损坏的宿主 ID 在模型调用前停止。消费方回调失败不触发额外模型重渲染。

验收包括两个原创改名/语言扰动场景的同文重说、嵌套、顺序/缺项/未知 ID/分块绕过反例；实际 player/NPC event 派生 ID；Pi 错序首稿→同 frame 第二稿、原生草稿不外泄与 settled 字节一致；终端只发布最终文本；Web 未验证 adapter 草稿不发布、Stop 后原 head 保留、render-only retry 无 world.commit 事件。这里仍是确定性工程证据，没有真实 provider 或独立体验评分。

P5 的 DecisionContextManifest、端到端预算和 LiteraryReferenceIndex 尚未实现；expression ref 绑定等待 P3 的真实持久工件。P1/P2 完整退出审计及 P3/P4/P6/P7 继续保持原范围。

验证：冻结源码后的全仓 194 文件、1183 tests 通过（94.07 秒）；随后错误保留/停止路径的最终 10 项定向测试通过，包含新增双 malformed JSON 反例。此前终端/Web 等 86 项定向通过。最终服务端、Web、E2E TypeScript 与 diff whitespace 检查通过。首轮全仓期间新增预检测试，已加载模块与新测试混用导致 1 项失败；停止源码修改后完整复跑通过。最初 4 项终端测试仍要求展示原生草稿，已按新发布契约改为验证草稿不可见、最终文本仅发布一次，未删除对应场景。

P5a 已提交为 `5894614`。

## P6a：来源置信度与 canonical 世界压力解耦

移除 canonicalEventToPossibility 的 pressure=event.confidence。原 confidence 只进入独立 sourceConfidence 诊断；没有世界压力依据的 canonical 候选使用中性 0，frontier trace 明示 unspecified。评估器同时忽略旧/外部 canonical 候选携带的 pressure，避免旧派生值绕过转换器重新影响排序。必要因果、阻断、状态和时间门禁保持先于合法候选选择；canonAffinity 不授予合法性。

新增 world-pressure-v2 调度版本，写入新 canonical snapshot、fallback context hash、frontier 与 scheduler trace；旧无策略标记的派生 frontier 不复用。engine 升至 0.6.0，prepared compatibility 随现有 engine fingerprint 改变；旧 branch history 明确拒绝不兼容解释并提供停止 SOP。旧无策略字段的 canonical snapshot 保持可读，不修改其原字节，也不将读取旧 snapshot 等同于迁移旧 history。

两个原创短场景分别冻结桥梁关闭和信号灯熄灭的必要条件，验证 confidence 0.1→1 的压力/factors/排序元组不变，来源诊断独立变化；false/unknown 前提以及被 supersede 的必要原因均不可选，提高 canon 偏好不能使其合法。补充旧 frontier 失效、新快照策略冻结/重载、旧 engine history 拒绝且原 commit/snapshot 不变的持久化测试。已有 typed causal scheduler 的当前已满足 motivation、过程/规范到期与 canonical runtime 回归继续检验。

本段未宣称 P6 全部完成：当前 goal/norm/process/hazard 压力的统一来源验证、非 canonical 自定义模板的 pressure 权限、entry pre-event 真正无动作驱动，以及完整分歧体验矩阵仍待完成。现有已满足 motivational causal link 的独立压力仍沿用既有算法，尚未升级为活动 goal 验证。P3/P4/P5 余项与 P7 仍在原范围；没有真实模型或独立人工体验证据。

验证：全仓 195 文件、1188 tests 通过（96.64 秒）；此前 14 项压力/因果/runtime/projection 定向及 5 项策略冻结/缓存/context 定向通过；最终服务端、Web、E2E TypeScript 与 diff whitespace 检查通过。

P6a 已提交为 `f7b2534`。

## P6b：actor 冲突裁决前的真实引擎门禁

核对发现 WorldRuntime.move 的 actor lane 原先先按优先级裁决冲突，再调用 engine.commitProposal。高优先级的非法候选可以挤掉同主体/资源上的合法方案，而最终自己也提交失败。本段把正常 engine.previewProposal 放到 actor arbitration 之前：保留材料性检查，对本次有界返回候选逐一只读验证，只有通过者参与优先级和冲突裁决；被选者仍在实际提交 head 再验证，预检不替代 commit。

预检拒绝保留真实 ValidationReport，trace 明示 COMMIT_NOT_ATTEMPTED、原 head 未移动；不把它记成冲突落选或成功执行。两个独立原创场景以存活角色的可行计划与不适用条件为独立预期：高优先级 false、次高 unknown 候选均不得压掉低优先级合法计划。测试通过实际 WorldRuntime/WorldEngine 提交合法结果，旧 head 状态不变，全部非法时零事件、head 不变，没有输入玩家动作。

调度策略升为 legality-first-v3，engine 0.7.0，沿既有 snapshot/fallback/frontier/trace/prepared compatibility 冻结路径生效。world-pressure-v2 和无策略字段的旧 canonical snapshots 可读；旧 0.6.0 history 拒绝不兼容解释，不原地改写。置信度与压力分离保持不变。

本段完善已返回 actor 候选的门禁，不宣称所有 entry driver 发现已完成。deterministicActorProposalSource 仍按主体预选单条候选，完整替代 action/goal 枚举和预算诊断待补；selectOpeningDriverActor 在物理角色为空时仍有全书频率回退，及其 reconciliation 义务处理需一起修正，不能仅换选择函数造成义务消失。已有 entry-driver probe 使用隔离 fork/真实 commit，不能把 audit 中 active-goal 数量当作该证明。P3/P4/P5/P6 余项及 P7 继续在原目标内；未调用真实 provider 或独立人工体验评价。

验证：最终全仓 196 文件、1190 tests 通过（94.65 秒）；此前 20 项 actor/runtime/entry-driver/策略定向通过；最终服务端、Web、E2E TypeScript 与 diff whitespace 检查通过。最初新测试把 accepted trace 状态误写为 committed，并要求仅一个 gate，已按既有 trace schema 修正；实现另明确区分预检拒绝与真实 commit 尝试。
