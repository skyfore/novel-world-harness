# 剩余能力工作：完整目标与当前证据

用户已授权继续完成所有剩余工作。范围以 `2026-09-16-review-to-capability-closure.zh-CN.md` 的 P1–P7 退出要求及其引用的 T4–T10 为准；本记录不将“当前测试已覆盖的子集”改作最终目标。

P1/P2/P6 及 P3 的已有工程账分别见对应退出审计。旧工作区修改保留，不重做或覆盖上一包。

| 待完成范围 | 必须交付 | 状态 |
| --- | --- | --- |
| P4 主体与渠道 | 稳定实体身份、来源支持的 agency/channel profile；远程主体按渠道交流，照片无当前能动性；无机制不得远程搬物；最后才扩展视角入口 | 档案、引擎权限、玩家／NPC／自主对话、条件话语、远程入口及本轮文本交互已接通；远程视觉和完整 P4 验收仍开放 |
| P4 生命周期 | 区分物理 condition、生命周期、运动阶段、控制权；注册版本化宿主字段／机制并复用 ProcessTemplate；unknown 不自动补时长或恢复 | 待实现与两来源纵向验收 |
| P4 时间与机制 | 核查时间 catalog 和跨事件证据包全消费者；局部顺序／回顾／重叠／后文知识隔离；不从一次 occurrence 强造通用规律 | 待逐消费者审计及补实现 |
| P5 候选依赖图 | branch/head/actor/candidate 修订绑定、可见依赖闭包、选择／省略原因、预算指标与隐藏依赖安全停止 | 进行中；个人经历闭包、候选知识／行动边和宿主作用域已接入，完整退出矩阵仍待核对 |
| P5 文学引用 | 轻量 LiteraryReferenceIndex，合法 source span、情境／目标引用、可见性依据；关键原话须通过角色提案和事件提交，风格不得写事实 | 合法样本索引、叙述接线和冻结目标上的条件话语候选已实现；完整 P5 退出矩阵继续审计 |
| P5 叙述 | 核查原话身份／顺序／合法重复、流式确认和渲染重试全消费者；失败只重渲染，不重新行动 | 既有实现待完整退出审计 |
| P7 冻结工程验收 | 两来源 fresh compile → candidate → certification → 入口 → 连续回合 → fork/replay/resume/divergence；记录坏提案／finish／converge 不改变权威状态 | 待跨包闭环验收 |
| P7 真实模型 | 预先冻结三组 provider/model/config/任务；记录真实 seed 支持、源 hash、逐 requirement 结果、成本和失败样本 | 待运行；先检查可用配置，不假报运行 |
| P7 独立人工 | 两位独立评审，五项 1–5 分原始评分与分歧；知识泄漏／强制 canon／叙述写事实为硬失败 | 待准备可复核完整材料和真实评审，不用模型自评分替代 |

每项持久语义变更均需穿过 proposal/evidence/finish/converge/store/cache/closure/certification/rebuild/runtime，同一事件和投影模型支持 replay。每项机制覆盖两个独立原创场景、正例、反例和 unknown/blocked；完整目标保持开放，不能因某一增量通过就全部结算。

## 当前增量：个人经历的决策依赖

已修复 `decision.experiences` 引用可被保留而对应 knowledge 内容被可选排名挤出的情况；直接字段谓词与旧 `state:` 谓词都参与合同依赖。经历找不到当前隔离视图中的知识记录时，在模型推理前停止，不从 canonical 或其他角色补内容。

manifest 升为 decision-context/v2，增加依赖边、逐条选入／省略理由、字符数与 UTF-8 字节数；这些是宿主审计数据，不加入模型视图，也不冒充 provider token usage。候选版本和 branch/head 绑定、精确候选闭包仍待下一步，未关闭 P5。

定向验证：decision-context、actor-context-retrieval、branch-acquisition 三个文件共 20 项通过；服务端 TypeScript 通过。

## 后续增量：候选依赖与宿主作用域

`DecisionScope` 由运行宿主按真实 branch/head/actor 建立，用 AsyncLocalStorage 隔离并发回合；玩家裁决还绑定规范化候选 hash。翻译、NPC、自主角色和世界裁决进入相应宿主作用域；这些 ID 只进入宿主 manifest／trace，不放进模型提示或回调参数。裁决输入与绑定的候选修订不一致时，在请求 provider 前停止。

工作集解析实际 intendedCandidate，保留候选 requiresKnowledge／forbidsKnowledge／既有知识写入依赖和所选行动合同，并记录显式依赖边。世界裁决现在收到受 actor scope 约束的依赖工作集和同作用域只读检索，原有 currentWorld 裁决权限独立保留。缺失知识或未提供的行动合同不靠猜测补齐；所需可见包超预算仍停止。

验证：decision-context、pi-player-world-adjudicator、player-action、model-actor-policy、npc-reaction 五个文件 63 项通过；服务端 TypeScript 通过。包含并发分支隔离、真实 PlayerTurnService 调用绑定、原始 head 不进入模型数据、候选修订漂移在 provider 调用前拒绝。尚未把这一增量当作 P5 整体退出证据。

下一项文学引用审计已定位 `narrative-source.ts`／`play-opening.ts`：现有素材从可见提交事件的 evidence 截取，但宽 evidence span 与 actor 对整段原文的可见性不能直接等同；新索引需核对精确片段、occurrence 和角色获取边界，并接入实际引用消费者，不能只新增一个无人消费的数据结构。

## 后续增量：精确文学引用索引

新增 `LiteraryReferenceIndex` 派生索引，并由 `buildPlayOpeningFrame` 实际消费。索引绑定 branch/head/actor/source，保存源 byte span／hash、发生事件与 commit、storyTime、speaker/addressee、明确 scene/goal refs，以及可见性依据；索引本身不复制原文正文，不改 canonical、分支事件或角色知识。模型侧仍只获得有界片段和非权威用途说明，不获得宿主索引或身份标识。

修正旧的宽证据读取：actor-visible event 的 evidence 整段不再自动等于 actor-visible prose。选取原文须与已提交的明确角色观察、角色说过／被直接告知的台词，或该角色有修订匹配的 understood Acquisition 的 Expression 精确片段相交。锚点只能裁剪已经许可的长文本，不能扩大到邻句；重复匹配要求 occurrence 特定证据，非 UTF-8 边界不接受。未来 canon、其他角色和兄弟分支不提供引用权限。合法的重复发言保留不同 occurrence 身份。

两份原创英／中文场景覆盖相邻隐藏信息（包括已知人物的未来行动）、冷加载一致性、角色／分叉隔离；已有两来源真实编译／冻结恢复／Acquisition 验收另接入 understood-expression → 文学引用链。Play 叙述集成用实际已提交台词验证只注入该原句，邻近描写不进入提示。

这是合法样本索引与叙述接线，尚未完成原著关键话语的动机／关系／行动条件候选协议，也不把 style-only 引用当作允许角色自动说出台词。该协议和 P5 完整退出验收继续开放。

本次完整验证：216 文件、1308 项 Vitest 通过（119.67 秒），服务端／Web／E2E TypeScript 通过，diff whitespace 检查通过。首次全套运行因重构时遗漏 `observeCommittedEvent` 导入出现 7 项失败；补回导入后交互流程 69 项独立通过，并用干净进程全套复跑得到上述结果。该失败记录不删除，未扩大 timeout 或放宽断言。

## 后续增量：确定性角色行动入口漏接修复

在原著条件话语的消费者审计中发现，确定性角色调度器虽然已经复制 proposedSemantics／proposedProcesses／proposedNorms，却仍只把状态或知识操作当作有效行动，提前丢弃仅有这些通道的候选。现复用已有 hasActorOutcome 判定，继续交由 engine.previewProposal 校验；没有绕开角色权限、目标激活或提交验证。

新增回归进一步发现，响应型角色行动把所有无状态写入的候选标记为 knowledge，导致纯目标变化触发 FALSE_KNOWLEDGE_PROGRESS。主动与响应两条路径现在均按实际状态／知识操作声明对应 channel。

新增四项回归覆盖主动与响应两种路径：纯目标变化从候选进入提交、选取本身不写分支、物理状态不变、冷启动重放一致；未知激活条件及试图修改他人目标均拒绝并保留 head。相关三个测试文件共 16 项通过，服务端／Web／E2E TypeScript 与 diff whitespace 检查通过。这是既有角色结果协议的入口修复，尚未实现条件原话候选协议，也不是 P5／P7 退出验收；上节的 1308 项全套结果属于此次修复之前的基线。

## 后续增量：原著条件话语候选

在现有冻结 CharacterGoal 的 candidateAction／actionPatterns 上增加 expressionCandidates，而不是新建第二份剧情调度器或原文库。候选引用同来源 UtteranceExpression、当前角色需已理解的知识 claim，以及显式关系条件；动机沿用目标 activation／completion／expiry 和个人经历边界，行动沿用 preconditions 与 action invocation。关系条件限定为说话者到原收话者的关系实体，缺值不被当作成立。

确定性与混合角色策略在宿主侧检查条件后，将原表达的各个精确片段生成 spokenUtterances。每条绑定表达／目标修订、行动／候选／片段索引。提交与重放在事件效果发生之前重新检查条件、原话、人物、顺序、次数和行动绑定；本事件稍后才学到的内容不能授权之前的发言。已发生的发言进入原有锁定台词渲染。未来原话不进入 actor reasoner 提示，候选不会自动实现原著事件，也不会自动写入世界事实、听者知识或说话者信念。已理解但不相信的内容可以被表达；接受它与表达它是不同通道。

编译工具要求新的表达链接、知识引用和每条关系条件有精确 selector；finish／converge、审计、冻结上下文、prepared cache 和依赖闭包均接入。缓存拒绝缺失或过期的目标证据绑定。开场驱动统计识别条件话语，同时验证开场已有知识及关系条件，不能仅凭存在 expressionCandidates 计为已激活。

两份原创英／中文场景覆盖真实工具提案 → finish → converge → 缓存归档 → 新工作区恢复 → 冻结上下文 → 角色候选 → 提交；另覆盖错误台词／修订／重复绑定、未知关系、未获知内容、分支动机变化、当次 learn 越界、重放篡改拒绝、混合策略不调用 reasoner、锁定渲染与信念隔离。相关五文件 44 项通过；域实现的全套回归为 218 文件、1322 项通过（122.32 秒），三套 TypeScript 与 44 项原生语义契约测试通过。随后新增恢复分类及一项恢复回归，两文件共 41 项通过，并再次通过服务端 TypeScript 和 diff whitespace 检查。尚未进行真实模型或独立人工验收，不据此关闭 P4、整个 P5 或 P7。

## 当前增量：来源支持的主体档案与会话权限

实体保留稳定 ID，新增可选 agencyProfile，区分 autonomous/none/unknown 与 bodily/mediated/unknown；旧实体不自动获得能力证明。每个渠道引用已有 ProcessTemplate 的主体、对端、载体角色和活动阶段；物理控制另绑定 ActionSchema。实体精确字段证据进入提案校验、finish/converge、审计、冻结上下文、缓存和依赖闭包。编译管线升为 47，旧语义完成标记失效，原始历史保留。

运行时复用已提交的 ProcessInstance 表示会话，无第二套可变通信状态。提交及冷重放都在当前事件的效果之前检查会话运行状态、阶段、主体与角色绑定；本事件启动会话不能授权自身。远程发声需要 audio/audiovisual 会话，物理状态修改还需同一会话的 physical-control 渠道和精确机制／角色绑定。照片、提及、记忆及梦中表象不能自行行动；远程主体不能伪装身体。引擎升为 0.25.0，避免旧历史被静默套用新权限语义。

ActorDecisionView 只提供当前角色可见的活动会话，模型边界将渠道／过程／机制 ID 映射为句柄；实体名称视图仍使用字段白名单，不携带完整能力档案。错误恢复明确同源发现工具、精确复制字段、最多一次修正，运行时权限失败停止并保留 head。

英／中文两份原创场景覆盖提案 → finish → converge → 缓存归档 → 新工作区恢复 → 冻结上下文 → 会话提交 → 远程发言 → 冷重放，以及无机制搬物、照片行动、未知／暂停会话和同事件自授权拒绝。测试中的通信／机械臂机制是明确的宿主测试模块，不冒充由单次原文自动归纳出的通用规则。

这仅完成主体档案和引擎渠道权限。玩家／NPC 交互适配器、远程视角入口、文本与远程视觉接收、生命周期模块及 P4 全消费者验收继续开放，不能据此关闭整个 P4。

补充权限审计：知道会话 ID 不等于知道机制。提交与冷重放使用发言／操作主体在事件前的 actionable knowledge 检查过程及控制机制可见性；engine-only 或缺少知识门槛的机制不可用于渠道授权。对应隐藏／未知机制反例已加入。

下一增量的已定位消费者：`playerInteractionSchema` 尚不接受会话绑定；`playerActionToKnowledgeAwareAction` 与 `respondOneNpc` 的交互记录仍固定为 physical，观察文案仍假设“面前的人”；`validatePlayerActionSpatialScope` 按物理共处判定其他角色。必须把受限的当前会话绑定贯穿候选句柄、依赖包、空间校验、事件 presence、参与者载体和观察文案，再核查 `entry-context` / `entry-knowledge` 的身体入口证明。不能仅放宽入口枚举或把远程对端当作 physically present。

本增量最终验证：全套 Vitest 219 文件、1330 项全部通过（122.26 秒）；三套 TypeScript 检查通过；原生语义契约命令通过（本次 Node 汇总显示 2 个文件子测试）；diff whitespace 检查通过。日志 `/tmp/agency-profile-final-tests.log`。先前全量中的两条测试 localRef 格式错误已修复，上述为修复和隐藏机制权限补强后的完整重跑，不以局部通过替代全套结果。尚未开展真实模型或两位独立人工验收。

## 后续增量：玩家回合与直接 NPC 回复的远程渠道

`playerInteractionSchema` 的精确 speech 支持 channelBinding；候选编码／解码、当前角色作用域、候选依赖包和 PlayerTurnService 均保留并核对渠道与过程句柄。当前已提交、机制已披露、由角色占据主体角色的会话允许角色引用其匿名对端和载体，不赋予全局姓名、对端状态或物理共处。未知／暂停会话和缺失决策依赖在模型或提交前停止；通信渠道不能豁免搬物等物理效果。

玩家提案构造及直接 NPC 回复使用当前角色的会话生成载体参与者和 remote presence，不再将远程双方固定标为 physical。NPC 返回渠道必须由该 NPC 自己的 profile 授权；发送方的渠道不自动成为接收方能力。NPC 回复前验证触发发言确实存在于已提交历史且文字／会话绑定匹配。Pi 入站消息仅表达 remote delivery，不把发送方原始渠道／过程 ID 送进模型；模型回复选择自己的 opaque handles。音频观察不携带视觉表情。

场景投影要求观察主体也具有本事件的 physical presence，才能从同事件其他人物推导共处；远程观察者不继承他人的场景切换。旧的实际共处仍按既有位置与在场证据投影。

两份原创场景新增完整 PlayerTurnService → 直接 NPC 回复 → 冷重放测试，验证匿名对端、句柄往返、完整候选依赖、音频不能搬物、伪造触发文字拒绝、暂停后回合拒绝且 head 不变。另有 Pi 入站 ID 不泄漏回归。此增量尚未扩展远程视角入口，也没有声称自主调度的 model-actor-policy／确定性条件话语已接通远程输出；这些消费者与文本／视觉接收、生命周期和整体 P4/P7 退出验收仍开放。

本增量最终验证：完整 Vitest 219 文件、1333 项通过（125.40 秒）；三套 TypeScript 和 diff whitespace 检查通过。全量日志 `/tmp/remote-interaction-full-tests.log`。真实 provider 与独立人工评审未运行，完整目标保持开放。

## 后续增量：自主角色的渠道发言与确定性条件话语

修复 model-actor-policy 将模型的 typed interaction 丢弃，以及将纯 speech 判作无效果的问题。自主角色复用玩家交互的事件构造边界，保留精确台词、当前会话、载体参与者、remote presence 和受限观察；调度器仍先预览验证，再按实际 head 提交。角色模型只看到当前角色的 opaque channel/process handles，暂停后旧候选不能提交。

条件原话沿用冻结的 goal／expression 和原有知识、动机、关系、行动前提。需要远程发送时，从已提交过程状态及主体知识门槛中找唯一可用 audio/audiovisual 会话，宿主生成绑定；缺失或多义时停止，不把运行时 process ID 编入源目标，不删掉位置或其他原始前提来强行触发。提交与冷重放都使用事件之前的过程状态重新生成并核对同一绑定。确定性独立行动、被已提交远程发言触发的回复，以及混合策略的 compiled-action 通路均接入；远程回复资格与物理共处集合保持分离。引擎升为 0.26.0，prepared cache 的 engine fingerprint 随之失效，旧历史不静默改写。

两份原创场景验证自主模型候选 → WorldRuntime.move → 事件 → 冷重放、暂停后拒绝和知识隔离。另两份条件话语场景验证无模型调用的混合策略、确定性远程回复、精确重复原话、双会话歧义、暂停后拒绝，以及删除渠道绑定的重放篡改拒绝。源表达的编译归档／恢复原有用例继续回归；新增远程组合用例使用明确宿主测试模块和冻结上下文，不冒充真实模型验收或全流程入口验收。

入口剩余消费者已核对：characterEntryCheckpointSchema 硬性要求 physical；entry-context 的开场／事件入口筛选依赖身体检查点；entry-knowledge 的历史知识重建也有身体校验；compiler validator 拒绝非 physical 的 opening actorObservation。entryProjectionSeed 已能承载 processes，可复用已有过程状态，但必须证明它在入口 cut 之前成立，并把渠道、角色、载体、知识门槛和精确字段来源接入所有校验，不能单独放宽入口枚举。远程入口、文本／视觉接收、生命周期、时间机制消费者审计及 P5/P7 完整验收仍开放。

入口审计补充：WorldEngine.createBranch 的 entryActorId、compiler audit 的开场角色／观察完整性、proposal-tools 的 initial-world 描述，以及 batches 与 play-opening 的开场／建议提示也依赖身体在场。后续入口工作必须一起调整，并继续让无来源支持的照片／记忆／提及保持不可入场。

本增量最终验证：完整 Vitest 219 文件、1337 项通过（124.85 秒）；三套 TypeScript 检查、原生语义契约命令（Node 汇总 2 个文件子测试）及 diff whitespace 检查通过。日志 `/tmp/autonomous-channel-full-tests.log`。真实 provider／独立人工验收尚未开展，远程入口及总目标不据此关闭。


## 后续增量：开场远程入口与 Genesis 权限重放

开场入口复用 entryProjectionSeed 的过程快照：仅有 remote 标记不产生入口权限，角色还须有自主主体档案，以及入口之前已经运行、阶段有效、角色／对端／载体绑定齐全且机制对该角色可见的会话。照片、提及和缺少档案的远程身份不能成为入口。开场远程 presence 和快照中的每项过程操作均要求精确字段来源支持，经过提案、finish/converge、归档绑定验证与新工作区重建；不从未来事件补出会话。

创建分支将宿主选择的 entryActorId 写入 Genesis，冷重放在应用效果前重新检查入口权限，非 Genesis 不得设置该字段。角色观察也经过检查，不能通过省略 entryActorId 绕过远程观察权限。叙述模型收到仅含渠道类型及角色可见名称的主体信息，不含原始会话／机制 ID；Pi 上下文裁剪保留该信息。compiler audit 分开报告 openingPhysicalPresence 和 openingLivePresence，远程入口不会抬高身体在场覆盖率。

两份原创英／中文场景贯通提案 → finish → converge → 缓存归档 → 新工作区恢复 → 入口选择 → Genesis → 首轮发言 → 冷重放；反例包含无会话、暂停会话、无会话观察、删除 Genesis 会话效果和删除精确证据绑定。引擎升至 0.27.0，编译管线升至 48，旧语义缓存不被静默沿用。

本增量仅开放开场入口。后续 canonical event 的 characterEntryCheckpoint、历史知识 cut 和事件执行证据仍需一起接通；文本／视觉接收、生命周期、时间机制消费者审计以及 P5/P7 退出验收仍开放。测试使用明确的宿主测试模块，未运行真实 provider 或两位独立人工评审。

本增量最终验证：完整 Vitest 219 文件、1337 项通过（124.11 秒）；三套 TypeScript、原生语义契约命令（Node 汇总 2 个文件子测试）和 diff whitespace 检查通过。完整日志 `/tmp/entry-agency-final-tests.log`。首次全量有一项旧审计文案断言失败；更新为身体／渠道访问诊断，并增加两种覆盖率的分别断言后，全套重新通过。另有去除 entryActorId 后仍拒绝无会话观察／冷重放的反例，包含在最终全量中。


## 后续增量：后续章节远程入口与历史获知重建

characterEntryCheckpoint 支持有完整 projectionSeed 的 remote 入口；仅改 presence 仍不能通过。事件／执行绑定验证检查角色自主档案、入口前活动会话、阶段与角色／载体绑定，以及目标 occurrence 的实际远程参与。目标事件若只是照片／提及，不能由检查点升级为当前活动角色。入口选项、源场景投影、Genesis 和历史知识冷重放均检查这一边界。

canonical-event 内联检查点和独立 event-execution 的远程入口字段都要求精确来源支持，包括检查点角色、执行绑定的角色／occurrence 链接、remote mode 和每项历史过程操作。检查接入提案、提交、审计、prepared cache；冻结上下文验证保留获知收据目录。审计将执行绑定投影合并后再统计后续入口覆盖率，避免把已完成的独立检查点漏计；同一视图也核对 occurrence 的远程参与。

宿主为后续远程入口派生知识历史 cut，使用开场与入口前真实发生的获知操作，目标事件及未来事件不进入入口知识。完整状态／过程快照不替代角色经历。检查点中与历史完全相同的 acquisition 操作只作为快照引用，不再次消耗同一收据；改变收据内容仍走原校验，不能通过去重修正或伪造经验。历史 hash、已发生事件集合、预期知识和入口会话在创建／冷重放中再验证。引擎升为 0.28.0，编译管线升为 49。

两份原创英／中文场景分别覆盖开场及后续章节的真实工具提案 → finish → converge → 归档 → 新工作区恢复 → 入口 → 发言 → 冷重放。新增反例包括无完整快照、暂停会话、以表象冒充远程参与、错误历史 cut、目标事件提前实现，以及执行绑定精确证据被移除。另在原有真实获知／修复两条测试路径上组合显式宿主通信模块，验证知识门槛使用早先已验证收据、历史收据只执行一次和未来推理不泄漏；该组合模块是测试宿主配置，不冒充原文自动归纳的通信机制。

扩大后的八文件 80 项回归、三套 TypeScript 与原生语义契约命令已通过。全量验证结果另记。文本／远程视觉接收、生命周期、时间机制消费者审计、P5 完整失败矩阵和 P7 工程／真实 provider／两位独立人工验收继续开放，不据此关闭整个 P4 或总目标。

下一消费者已定位：branch-acquisition 的 told／deceived-misattributed 接收仍要求双方 physical；当前远程发言可提交和回复，但不会因此自动产生合法的获知收据。read 路径仍要求文档与读者物理共处，perception-observation 的已注册视觉 lowering 也只支持现场直接视觉。后续须先让远程语音的 typed receipt 使用事件前已提交的渠道权限，再接文本／远程视觉；不能删掉身体检查后把所有远程内容当作已理解或真实。

本增量最终验证：完整 Vitest 219 文件、1339 项通过（126.64 秒）；服务端／Web／E2E TypeScript、原生语义契约命令（Node 汇总 2 个文件子测试）及 diff whitespace 检查通过。日志 `/tmp/later-entry-full-tests.log`。定向测试曾暴露审计未合并执行绑定，以及测试通信模块缺少终止阶段／载体类型不符；分别修正实际审计投影和测试模块后得到上述全量结果。真实模型与独立人工验收仍未运行。


## 后续增量：当前事件的远程语音获知收据

branch-acquisition 的 told／deceived-misattributed 不再把身体共处作为唯一接收路径。绑定语音必须使用事件前已提交的活动 audio/audiovisual 会话，校验发送主体、阶段、角色／载体、全部收话者与机制可见性。收话者必须是本事件实际 physical／remote 角色，表象或无自主主体权限不能获知。发送动作的验证与收据验证复用同一渠道规则；仅仅知道 process ID 不能授权接收，本事件启动／恢复会话也不能自授权。非渠道的现场语音仍保留身体与已知位置检查。

预览、提交及冷重放都将事件前过程状态传给知识验证，理解和相信仍须显式提案且独立检查；未理解者不进入可行动知识，不相信者保留 disbelieves，收到报告不会改写所报告的物理事实。错误渠道权限停止模型重试并保留 head／提案。引擎升至 0.29.0，旧历史不静默改写。

两份原创语音场景覆盖不同物理位置的接收、旁观者／分支隔离、预览不提交、冷重放、未理解／不相信、缺少绑定、错误收话者、表象、会话不存在／暂停，以及同事件恢复后试图自授权。已有英／中文主体档案测试进一步贯通编译 → 归档 → 新工作区重建 → 开场／后续入口 → 宿主类型化语音及收据 → 冷重放；测试宿主明确提供收据提案，不假报已经由真实模型生成。

消费者补强：CLI world validate 和叙事选项预检复用引擎完整预览，避免忽略过程及局部分支语义。只读历史预览与知识门槛固定在所查看的 commit；实际提交仍使用实时 head 并拒绝 STALE_PARENT。无身体角色的等待／思考保持 remote presence。回归覆盖主分支推进后，旧提交上的 fork 仍能生成开场选项，两个 head 均不因预检而改变；旧提案仍不能提交到已推进的主分支。

剩余接收链路不能省略：NPC 回复发生在触发语音之后的另一个事件。现有收据 basis 只引用当前事件 utteranceIndex，不能把已提交的上一事件发言复制进回复来冒充本事件语音；需要来源受限、可重放的历史发言接收引用，并贯穿角色作用域、opaque handles、依赖包和 NPC／玩家接收消费者。NPC 无外向回复时的远程 presence 也仍需核查。文本／远程视觉、生命周期、时间机制及 P5/P7 完整验收继续开放。

本增量最终验证：完整 Vitest 219 文件、1342 项通过（125.27 秒）；服务端／Web／E2E TypeScript、原生语义契约命令（Node 汇总 2 个文件子测试）和 diff whitespace 检查通过。日志 `/tmp/remote-receipt-full-tests.log`。定向测试发现了无身体角色预检的 physical 默认值、历史 fork 被实时知识门槛误拒的问题；修复后上述完整回归通过，未通过删除拒绝条件绕过验证。真实 provider／独立人工验收未运行，总目标保持开放。


## 后续增量：跨事件语音接收与 NPC 独立收据

发言事件的重放器依据事件前知识／过程权限和实际收话者生成投递证明，证明属于派生投影，不是模型可写的世界事实。角色只收到投递给自己、尚未消费的 `decision.pendingSpeech`，内容与原发言一致，事件／人物使用 opaque handles。收据可用 `basis.utteranceEventId` 加原 utteranceIndex 引用这条历史投递；未发生、其他分支、其他收话者、错误索引和重复消费均拒绝。发言之后暂停会话不会抹掉先前实际发生的投递，接收也不会自动等同于理解或相信。

接入事件预览／提交／冷重放、快照版本、角色可见域、候选句柄映射、依赖包以及 Pi 玩家／NPC／自主角色提示。引擎升至 0.30.0；知识 reducer 升至 3，增加 speechDelivery reducer 版本 1。来源归属例外仅允许为当前角色自己的历史收据登记实际说话者的 asserts attribution，不允许代写他人的信念／目标。依赖包缺少所引用投递时在模型请求前停止。历史 ID 错误只能从同一隔离提示复制精确字段修正一次；已消费、工具不活动或预算耗尽停止。

英／中文 NPC 用例贯通玩家发言 → 独立回复事件中的收据 → 冷重放，并覆盖只理解、不向外回复的路径。内部接收使用 reflect 候选，不强求远端发言者物理在场；事件仍保留远程参与，给玩家的观察仅说明尚无渠道回应，不暴露远端表情或“选择忽略”的内部意图。另覆盖两份原创场景的编译／归档／新工作区恢复／开场或后续入口之后，分开发言与接收的宿主类型化提案链路。

定向检查曾发现新增反例误用可见域检查替代最终所有权检查，以及无外向回复时旧候选仍要求远端人物物理在场。分别修正测试层级和实际候选构造，并保留非法所有权／分支不变反例。最终完整验证结果另记；真实 provider 和独立人工评审未运行。文本／远程视觉接收、生命周期、时间机制、P5/P7 完整退出验收仍开放。


后续消费者审计定位：agency profile 已能表示 text，但实际发送适配器只接 audio/audiovisual；分支 read 仍要求已经实现的文档表达及读者／文档物理共处。perception-observation 的 mapped 合同仅有 direct-vision-v1，现有 access 强制 locationId，不能把 audiovisual 标签直接当作远程视觉证明。下一步需要保留发送、投递、来源和感知现象的独立验证，明确文本载体及视觉采集端的过程绑定，再贯穿编译证据、恢复与运行时；不能仅放宽枚举或删掉物理检查。


本增量最终验证：完整 Vitest 219 文件、1347 项通过（128.52 秒）；服务端／Web／E2E TypeScript、原生语义契约（Node 汇总 2 个文件子测试）和 diff whitespace 检查通过。日志 `/tmp/pending-speech-full-tests.log`。无外向回复反例还定位到空间检查将历史 sourceActorId 误判为新的身体交互；只对当前角色精确待接收投递及配对收据豁免这条来源推断，其他参与者／物理变化仍照常校验。修复后四文件 58 项定向测试及上述全量均通过。模型回调仍为确定性测试替身，未声称真实 provider 或人工验收完成。


## 后续增量：已有文档的文本渠道访问验证

分支 read 收据现在必须二选一：精确物理 locationId，或显式 channelBinding。渠道路径复用从语音验证中抽出的 pre-event authority resolver，核对读者自主档案、本人角色、已运行过程／阶段、text 类型、文档 peer、真实载体及机制可见性。仍必须引用本分支已经实现的原文 writing expression、明确收件人和文档 attribution；渠道不会把未来 canon 变成可读材料，也不改变作者或原文。事件预览、提交与冷重放共用此检查，同事件启动／恢复不能自授权。模型句柄映射与候选依赖包保留显式渠道／过程引用。引擎升至 0.31.0。

实际引擎测试发现旧分支 physical read 使用了未注册的 artifact.location，早先测试仅手工构造投影值而未证明可提交。现注册此 entity-ref 字段（owner visibility），不推断缺失位置；通过提交真实位置变化验证不同地点拒绝、文档实际到达后可以现场读取。文本渠道读入不移动文档，不把文档报告写成 world truth。两份英／中文原创用例使用明确宿主文档访问模块，覆盖预览无写入、提交、冷重放、精确句柄、旁观者隔离、载体缺失、表象、错误渠道、音频冒充、隐藏机制、未来表达、暂停及同事件恢复，以及未理解／不相信分支。四文件 45 项定向回归通过。

这是已有文档的引擎访问与分支收据增量，尚非完整文本交互退出验收。角色模型目前没有可读文档发现视图；玩家／NPC／自主角色需要将文档、载体纳入事件参与者而不将 artifact 标成 character presence，并保留角色可见的表达／归属／命题／claim 依赖。canonical Acquisition 的 read 仍有 physical 限制，新消息写入／投递尚未实现。须继续贯通这些消费者及两来源编译归档／恢复验收；本次测试宿主提供冻结表达和类型化提案，未冒充编译生成或真实模型运行。远程视觉、生命周期、时间机制、P5/P7 和人工门禁继续开放。


本增量最终验证：完整 Vitest 220 文件、1353 项通过（125.66 秒）；三套 TypeScript、原生语义契约（2 个文件子测试）及 diff whitespace 检查通过。日志 `/tmp/text-channel-full-tests.log`。新用例最初暴露了缺失的文档位置字段，同时测试夹具缺少原表达的收件人／quotation 绑定、错误携带 process 启动输出字段；补齐真实注册字段并修正夹具后定向和全量均通过，未放松原有来源／过程校验。完整 P4/P5/P7 与总目标保持开放。


## 后续增量：角色可读文档视图与三个运行消费者

新增派生的 decision.readableTexts：仅显示当前分支已实现、明确以当前角色为收件人、文档在其引用域内、且拥有唯一可用 text 会话和唯一文档归属的原文表达。原文 fragments 保持分段和精确文字；不会把宽 evidence 段、未来表达、别人的文档、音频或隐藏机制加入视图。所有表达／命题／归属／渠道／过程 ID 都经过 opaque 句柄边界。文档内容仍是不可信材料，不是系统指令或自动成立的知识。

玩家／NPC／自主模型提示可复制一个完整条目，用已有命题创建 local claim，配对自己的 read acquisition 与 learn。模型决定理解／相信的提案仍经引擎验证；视图本身不生成知识。候选依赖包要求精确表达、文档、归属、命题和渠道配对，缺失时停止。补齐 learn.expressionId 和 perceptionId 原先遗漏的句柄映射；原始表达标识不再绕过模型边界。

阅读适配器补入文档和载体参与者，只把当前读者标为 remote，不把 artifact peer 填成 character presence。文本渠道不授予物理接触权限。自主角色构造事件时也复用该适配器；NPC 可以内部阅读而不向玩家泄漏文档内容。两份英／中文用例覆盖 PlayerTurnService、模型自主调度／WorldRuntime、NPC 直接响应及冷重放，并验证三类隔离／句柄往返、缺失依赖、关闭会话后旧候选拒绝。自主用例最初缺少可激活目标，且错误返回玩家 schema 的额外字段；修正夹具后确认真实适配器还须接入 read channel，补齐后五文件 34 项通过。

canonical Acquisition.read 仍待接通渠道合同及编译归档／恢复纵向验收。进一步审计发现其 runtime 参数目前只有 knowledge／currentEventIds／realizedEventIds，未接状态与过程；不能只放宽编译期 physical 检查。后续须一并核对源历史、初始世界、后续入口知识 cut、引擎和投影器，原文阅读证据不能替代已偏离分支里的实际可达性。新消息写入／投递、远程视觉、生命周期、时间机制和 P5/P7 门禁继续开放。当前测试使用确定性模型回调和显式宿主访问模块，未运行真实 provider／独立人工评审。


本增量最终验证：完整 Vitest 220 文件、1359 项通过（129.30 秒）；服务端／Web／E2E TypeScript、原生语义契约（2 个文件子测试）和 diff whitespace 检查通过。日志 `/tmp/readable-text-full-tests.log`。全量还覆盖不可见／未来／非 text 渠道不产生 readableTexts 的反例。没有真实 provider 或新增人工评分，整体目标继续开放。


## 后续增量：编译阅读收据的实际事件访问门禁

在扩展 canonical read 之前，补上已确认的旧路径漏洞：Acquisition 的原文证据和已发生表达不能替代当前分支的实际文档访问。运行验证现在接收 actual occurrence；physical read 必须证明本事件包含读者和确切文档、读者身体在场、两者具有同一已知且有效的 location。未知位置、远端文档或表象读者均拒绝，收据不会因为来源中写过“读到了”而自动成立。编译／迁移仍只验证源合同，运行条件只在实际事件检查。引擎升至 0.32.0。

引擎预览／提交、Genesis 两阶段校验、知识 reducer 和冷重放使用同一事件合同。源历史执行器补传原 occurrence 的 presence 与事件前 processes，并把状态和过程快照交给知识重放。依赖历史 cut 的入口仍通过源历史重建；没有实际 acquiring occurrence 的 checkpoint 不得凭空追加编译阅读收据。语义提案阶段缺少真实状态 cut 的提前知识预检对这类收据延后，最终完整事件校验继续执行，没有豁免最终门禁。

两份原创文档夹具验证远离读者时拒绝且 head 不变、实际送达后接受、冷重放一致，以及把已提交读者改成 represented 后重放拒绝。已有英／中文真实 compiler proposal → finish → converge → frozen context → receipt 测试原先未提供位置；补充原文中明确共处的说明和真实初始位置后继续通过。新增原文说明曾使“notice”证据引用出现两处匹配，调整为无歧义的原文措辞后保留精确证据门禁。五文件 33 项定向回归通过。

本增量修复 physical read 的实际状态验证，不宣称 canonical 远程 read 合同已经完成。仍需定义可编译的稳定渠道引用、精确证据／依赖修订，并贯穿开场及历史入口过程权限、两来源归档重建。新消息、远程视觉、生命周期、时间机制和 P5/P7 全部门禁继续开放，未运行真实 provider／独立人工验收。


补充主体边界：canonical 与分支 physical read 同时检查 agency profile，不接受无身体／无能动性的角色凭提案 physical 标签获取身体阅读权限。新增“mediated 主体 + 伪 physical 在场”反例，相关两文件 27 项通过。首轮全量 220 文件、1361 项通过（128.68 秒）属于此补充之前的结果；补充后重新完整验证，最终结果另记。


本增量最终验证（含主体边界补充）：完整 Vitest 220 文件、1361 项通过（130.57 秒）；服务端／Web／E2E TypeScript、原生语义契约（2 个文件子测试）及 diff whitespace 检查通过。最终全量日志 `/tmp/canonical-read-final-tests.log`。P4/P5/P7 其余项、真实模型和人工门禁仍未完成，目标保持开放。


## 后续增量：可编译的远程阅读合同与冻结恢复

canonical Acquisition.read 增加可选 textChannel，只记录读者档案内的稳定 channelId 和 processTemplateId，不记录运行分支的 process ID。两个叶字段及对象都有独立精确证据要求。宿主冻结 reader／document entity 与 process-template 修订；提案依赖、同批待提交目录、验证器、审计、上下文捕获／恢复和 prepared closure 均识别这些依赖。actor profile 或模板修订漂移使旧收据失效。引擎升至 0.33.0，编译管线升至 50。

实际获取时，从事件前过程状态解析读者的 source-backed text 渠道，要求模式、角色、文档 peer、载体、运行状态、阶段、机制可见性及唯一性均成立。缺少会话、两个相同有效会话、暂停或同事件恢复均拒绝并保留 head；编译证据不代替运行权限。没有 textChannel 的 physical read 继续执行上一增量的实际共处检查。Genesis 使用显式历史 projectionSeed 作为入口前过程基线，普通过程事件仍不能自授权；初始过程绑定的实体进入 Genesis participants，不必为了让载体“出现”而伪造状态事实。

英／中文两条真实工具路径覆盖 profile／expression／attribution／acquisition 提案 → 缺失叶证据拒绝并按同一 proposal_id 修正一次 → finish → converge → frozen context → prepared closure／归档 → 新工作区恢复 → 运行阅读 → 冷重放。另验证开场已经收到文本的 Genesis：缺少历史会话拒绝，携带会话接受并可重放。过程模板采用显式注册测试宿主模块，开场状态／过程 seed 由测试宿主给出，不声称 LLM 已独立归纳该模块。独立引擎用例覆盖兄弟分支缺会话、双会话歧义、暂停／恢复、文档保留在远端、身份修订失效。

测试定位并修复两处消费者遗漏：WorldContextStore.hydrate 未将过程模板传入 acquisition 校验；closure 的 revision 检查未把 process-template 映射到 process 节点。失败提案测试最初使用不同修复 ID，被既有 obligation ledger 正确阻止 finish；改为原 ID 的一次精确修正，没有绕过账本。两文件 24 项通过（包含四种收据模式的两来源编译子用例）。完整验证另记。

后续章节入口的 knowledgeHistory 重建已有事件前过程传递，但远程 read 与该路径的专门纵向验收尚未补齐，不能据此关闭入口验收。新消息写入／投递、远程视觉、生命周期、时间机制及 P5/P7 全部门禁仍开放。真实 provider 和两位独立人工评审未运行。


本增量最终验证：完整 Vitest 220 文件、1363 项通过（130.48 秒）；服务端／Web／E2E TypeScript、原生语义契约（2 个文件子测试）及 diff whitespace 检查通过。完整日志 `/tmp/compiled-text-full-tests.log`。总体目标保持开放，未将确定性测试计作真实模型或人工验收。


## 后续增量：后续章节入口的远程阅读历史验收

两份英／中文编译场景的远程阅读 occurrence 现在明确携带 observedKnowledge，其冻结 Acquisition 修订对应完整事件。复用已验证的归档／新工作区恢复材料，增加宿主定义的后续 remote checkpoint，检查 deriveCharacterEntrySeed → knowledgeHistory → 创建分支 → 冷重放。收据按原始获取 cut 重新验证并归属新 Genesis；目标入口事件的未来计划不进入当前状态，另一个角色不继承该知识。

反例保留检查点中的可用会话，分别移除或暂停真正历史 baseline 的会话；两者都在最终 createBranch 的历史重建阶段被拒绝，失败分支未落盘。修改 cutHash 同样拒绝。种子推导仅组装历史引用，不承担最终获取权限验证，因此反例明确落在创建／重放的权威边界，不用“生成了种子”冒充入场成功。入场后创建 fork 并提交 alternate-plan，原分支 head 不变，已读收据随历史继承，未来原著事件仍未实现。

本轮只加强验收夹具与断言，没有更改生产逻辑。四文件 32 项定向回归通过（11.77 秒），diff whitespace 检查通过；日志 `/tmp/later-text-entry-tests.log`。生产代码最近的全量基线仍是上一增量的 220 文件／1363 项，不宣称本轮重新运行全量。后续 checkpoint 是测试宿主定义并通过冻结上下文校验，不冒充新的真实 provider 生成／人工评审证据。

下一项是分支新文本消息的写入、投递及接收。目前 readableTexts 读取已编译的 writing expression，不能创造新文本；禁止把文本放进 audible spokenUtterances 或复制旧源表达来伪造消息。新文本需要事件内独立的精确内容与作者／收件人／渠道记录，发送时验证事件前 text 会话，重放派生实际投递；收据保留 read 语义并明确区分原文表达与分支消息来源，理解／相信仍为独立提案。必须贯穿玩家／NPC／自主角色、opaque 句柄、依赖包、精确渲染和分支隔离。远程视觉、生命周期、时间机制、P5/P7 及真实模型／人工门禁继续保持完整目标范围。


## 后续增量：分支文本发送与可重放投递基础

事件提案／已提交事件新增独立 writtenMessages：精确内容、作者、唯一收件人列表及必填渠道绑定。内容保留空白和换行，不占用 audible spokenUtterances，也不借用 canonical Expression 或伪造文档实体。消息加入事件身份 hash 与独立 text 进展通道／messageCount；纯文本发送可作为实质事件提交，重放验证证书与实际消息数相符。引擎升至 0.34.0，快照增加 textDelivery reducer 版本；编译源协议未改变。

提交和冷重放共用事件前渠道校验：作者必须具备自主能力和已公开、已运行的 text 会话，实际字符作者／收件人均明确 live presence，收件人符合会话 peer，载体实际参与。缺失／暂停／同事件启动或恢复、音频冒充、借用渠道、表象收件人均拒绝。存在 actorId 时只允许自己的署名；无 actorId 的宿主后台发送仍检查每位作者的 action incapacity，不能绕过行动限制。错误沿既有 AGENCY_CHANNEL_UNAVAILABLE 宿主修复 SOP 停止，不猜 ID 或无变化重试。

投影器在验证发送之后派生 (eventId, messageIndex, recipientId) 投递依据，按角色读取精确内容。没有投递依据的裸事件不当作已投递；分叉只继承祖先投递，兄弟分支消息不泄漏；相同文字的不同发送保持不同事件身份。后续暂停会话不抹除过去投递。此阶段投递不生成知识、理解、相信或 world truth，也不产生声音。

新增两份英／中文原创宿主夹具，覆盖预览不改 head、精确文本、提交／快照／冷重放、收件人隔离、重复文字、fork、无效渠道与失败原子性、证书计数篡改及冷重放渠道篡改。行动限制历史 seed 测试最初误带投影输出字段 status/startedBy/updatedBy，被严格 schema 拒绝；改为真实 start-process 输入后通过，没有放松合同。定向基础三文件 37 项通过，追加 fork／incapacity 后两文件 12 项通过；最终全量另记。

这是文本消息的引擎发送与投递基础，尚未完成整条文本交互验收。后续仍须接入独立 read 消息收据来源、角色发现／opaque 引用、玩家／NPC／自主模型、依赖包与精确文本渲染／失败重试；当前适配器未向模型开放此发送字段。新测试用显式宿主模块与类型化提案，不是 provider 生成或新的编译文档。远程视觉、生命周期、时间机制、完整 P5/P7、三套真实 provider 运行及两位独立人工评审继续开放。

本增量最终验证：完整 Vitest 221 文件、1371 项全部通过（132.54 秒）；服务端／Web／E2E TypeScript、原生语义契约（2 个文件子测试）及 diff whitespace 检查通过。完整日志 `/tmp/written-message-full-tests.log`。未运行真实 provider／独立人工评审，完整目标及上述后续工作继续开放。

## 2026-09-24：当前 diff 与文本交互收口

本次用户明确选择“先收口当前 diff 及文本交互”。远程视觉、完整生命周期、时间机制全消费者审计、P5 完整退出矩阵及 P7 不属于本次完成声明；原始 P1–P7 要求不删除，也不将它们改成已完成。

### 分支消息阅读收据（原工作区增量）

引擎为 `0.35.0`、编译管线为 `50`。`read` 获取来源增加显式 `branch-message`，以已投递的 eventId/messageIndex 和原作者的 asserts attribution 绑定分支消息；角色视图提供 `pendingMessages`，使用 opaque 事件／角色句柄并纳入候选依赖闭包。消息投递、理解及相信分别记录；已消费消息不重复获取，断线不抹除过去投递。此项代码原先已在工作区，但上方历史记录只写到 `0.34.0`。

### 文本交互消费者（本次补齐）

- 玩家和自主角色可提出 `interaction.kind=text`，保留精确内容、收件人和必填渠道绑定；作者、事件与提交身份由宿主提供。必须使用角色当前可见且已运行的 text 会话，不能借用发送方渠道、把文字伪装成语音或由发送动作直接改变收件人信念。
- NPC 直接回复支持 `responseKind=text`。入站触发必须与本分支已提交事件和真实投递匹配；Pi 入站提示删除发送方渠道／过程身份，回复选择 NPC 自己的句柄。没有回传权限仍可独立接收／理解消息，不泄漏远端表情或内部意图。
- 自主调度将纯文本发送计作实际事件；媒介化角色通过原有宿主事件构造器保留远程身份，可以在会话暂停后读取已投递文本。编译条件原话保留原行动绑定，不因此补造 ad-hoc 行动。
- 叙述沿用已提交内容块协议。文本块带 `channel=text` 及独立事件／消息索引身份，只向作者和有投递凭据的收件人展示；精确内容由宿主插入。相同文字的两次发送保留两个身份，空白和换行不归一化。叙述长度及术语检查针对已验证块外的 prose，不把合法原文内容当作模型说明。非法顺序／缺失块只允许一次修正渲染，未验证的流式草稿不展示，不重新执行发送。

### 验证和失败记录

新增中英文用例贯通 PlayerTurnService → 消息提交 → NPC 独立收据及回复 → 冷重放，并覆盖自主发送、自主断线阅读、未理解／不相信、发送方渠道借用拒绝、伪造触发、幂等回复、收件人隔离及渲染重试。Pi 适配器测试验证输入渠道 ID 不泄漏、文本重复身份、流式草稿抑制及一次渲染纠正。

测试发现并修复自主调度器遗漏纯文本 material-effect 判定。媒介化内部阅读最初扩展事件构造器过宽，使两条编译条件原话测试因新增 ad-hoc 行动被拒绝；现将补充构造限定于模型候选，保留编译行动原有合同。另修正新测试中的目标来源缺失、actor 模型测试误传 player-only 字段、宿主夹具误当已持久化快照，以及被修改测试文件的独立 strict 类型错误；未放宽来源、渠道或提交门。

最终检查结果与按范围拆分的提交见 [2026-09-24 收口记录](2026-09-24-current-diff-text-closure.zh-CN.md)。本次不执行真实 provider，也不代替两位独立人工评审；不声称完成完整小说 fresh compile 认证或用户旧世界迁移。

本次最终结果：221 文件／1387 项 Vitest、44 项原生契约、三套 TypeScript、三份修改测试的独立 strict 检查、生产构建及 2 项 Chromium 浏览器验收通过。按范围提交为 `3815241`、`f91bf64`、`1e13c32`、`154a992`，验证细节与未关闭范围见上方收口记录。
