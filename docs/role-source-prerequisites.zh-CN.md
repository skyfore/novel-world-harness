# 阻塞角色问题的独立来源规格

`role-source-prerequisites/v1` 是源码／宿主前置工作流程。它接受原角色计划中的精确问题 ID、已消耗的负面提案 hash、原预算 hash、主 loop 的停止状态 hash 和用户对前置工作的授权引用。它不续发原审查 grant，也不把分流建议当作依赖解决证据。

流程按固定顺序使用四个隔离的 Pi 会话，provider/model 固定为 `openai-codex/gpt-6.1-sol` OAuth 订阅：

1. 原文规格：只提供原问题和不可变原文读取能力；不提供候选、旧修复提案或分流意见。Pi 为每个问题提出必需表示、验收条件和证据边界。
2. 独立规格复核：新会话重新读原文，逐项接受或阻塞原规格；不得改写规格后自我通过。
3. 类型化依赖映射：规格复核通过后才开放已有结构诊断和工件读取。Pi 绑定精确 finding ID 和候选读取范围，或明确缺少来源表示／本体能力／证据。
4. 独立映射复核：另一会话重新读原文和完整依赖，核对精确映射与缺失条件。

每阶段有一个独立调用标记，最多 24 次模型请求，累计使用量持久化。原角色预算与失败历史保持不变；前置任务 ID 不包含授权措辞、模型 run ID 或新预算，所以改名不能取得第二次机会。任何中断、负面复核、未确定发布或耗尽额度都保留原任务并停止，不自动重开。工具 ID／游标错误只允许依据同工具的返回字段纠正一次。

提案和复核结果逐条进入现有 `RequirementLedger` 的 `role-source-prerequisite` 记录。发布检查独占编译锁、原问题的 blocked 状态、完整问题分母、不可变原文锚点及实际 Pi trace。四阶段不能复用会话或 trace。历史恢复仍需原始字节验证。记录不属于已通过的全书角色名单／场景运行规格，也不会写世界事实、消除原问题或满足可执行认证。

完成只转交 `host-authorization-review`。宿主仍须根据实际结果：核验源与工件版本；确认精确类型化依赖及适用的独立要求；通过既有上游规划、登记和授权门禁；冻结可写字段／新建槽位、预算与重验条件。缺少的注解、本体映射或要求类型必须先实现并验证，不能把共同文本范围、已支持的规格或 `DONE` 当作上游授权。四阶段规格／映射记录本身不能通过 `verifyUpstreamRepairPlan`。

## 缺少来源表示时的精确范围入口

仅当四阶段记录完整、两次独立复核均通过，且原问题映射全部为 `missing-source-representation`，才可依据用户对补齐来源表示的授权进入同一 taskId 下固定的 `representation/` 子目录。新增两个单次阶段是 `representation-plan` 与 `representation-check`，各有最多 24 次请求的独立预算；它们不重跑或挪用原审查、分流和前置阶段的次数。目录、start、invocation 均不可重开，失败和负面审查停止。

Pi 读取不可变原文及当前来源注解，提出具体注解 payload 和未定边界。每项原规格的验收条件必须按原下标映射到精确注解 ID／边界下标，也可以明确记录 gap。新建 ID 由宿主固定分配；只允许已有四种来源注解，不允许修改旧注解、建立实体解析／事件解析或创建世界事实。`discourse-segment.kind=unclassified` 明确保留尚未确定的话语类型，必须填写边界说明；它不等于叙述者或人物直接引语。身份、事件对应、声音归属和主张真值的边界均为 `unresolved`，存于要求账本，不成为运行时世界关系。

另一新 Pi 会话重新读取原文与全部复用注解，逐项复核提案。宿主校验原始字节、完整问题和验收条件分母、具体注解类型、依赖 DAG、实际 Pi trace 与隔离会话，再将提案／复核写入 `RequirementLedger`。负面审查或任何 gap 都不能生成授权预览，`supported` 不能覆盖 gap。

两阶段通过时，`buildRepresentationRepairPlan` 只产生既有 `UpstreamRepairPlan` 的预览。`sourceRepresentation` 引用精确提案与复核记录 hash，每个新建槽位冻结完整语义 payload hash；宿主派生的运行 provenance 单独验证。现有 `UpstreamRepairLedger.register/authorize` 仍是必经入口。预检重新读取实际账本、原四阶段 trace、新两阶段 trace、源布局和注解目录，重新构建完整计划并逐字节比较 hash。换一个授权引用、放宽字段、扩大类型、删除条件或使用无关旧计划均不能通过。

修复执行仍通过原有 typed proposal、finish、convergence 和 evaluation 流程。来源表示要求与原角色问题使用不同 ID；表示要求通过仅说明经独立复核的注解内容已经完整保留。原角色问题不会因此自动 resolved，跨层未知不会成为世界事实，也不授予全局闭合或可执行认证。

修复后由 Pi 独立验收，再按原任务的合法恢复路径交回主 loop。未满足这些条件时主 loop 继续 `BREAK`。后台 hook 只在前置工作结束、阻塞、状态漂移或原进程异常退出时通知一次当前会话；正常进度保持安静。

## 精确提案与提交前独立验收

宿主重新构建并验证预览后，在原 taskId 的固定 `representation/upstream/` 目录执行一次计划。现有上游账本先 `register/authorize`，再按依赖顺序为每个精确槽位保留一次 invocation 和原始输入。每个槽位使用新的 Pi 订阅会话，最多 4 次请求，只能把已经独立复核的 payload 翻译成原 typed proposal 参数；字段、数组顺序、引用和未定边界都不能改变。预算与原模型会话／attempt 关联持久化，语义 payload hash、来源锚点和上游范围通过后才进入 pending。

所有槽位完成后，另一全新的 Pi 会话读取完整实际 pending 图、原独立规格、精确表示提案、复用注解和全部授权来源段落，独立验收来源表示是否完整保留要求。最多 24 次请求；其 supported 只针对表示，不回答原角色问题。输入、提案、证据收据、图 hash、预算与实际 trace 留在原目录。任何负面结果都停止并保留 pending，不能修订或重新运行已消费阶段。

`prepareUpstreamRepairFinish` 与 `verifyUpstreamRepairFinish` 对来源表示计划强制检查这次独立验收：核对实际提案、隔离会话、真实工具提交、完整来源读取、原始输入和累计预算，拒绝用前一阶段范围复核代替提交后的验收。通过后才由既有 finish 收据和 convergence 门禁提交注解。宿主只写编排与收据，不生成小说语义。DONE 表示来源表示已收敛，主 loop 仍为 BREAK；下一步必须把实际收据绑定到原角色审查的合法依赖入口，不能据此复活旧 grant 或直接宣称全局闭合。

## 已提交来源依赖后的候选分母修订

`requirements begin-core-role-dependency-review --scope <原 scope.json> --upstream-plan <已收敛 planHash> --authorization-ref <用户授权>` 提供只读预览；`--apply` 在 compiler 锁内登记 pending 修订。此入口适用于尚无完成 review、候选分母严格增加的情形：必须从实际完成 receipt 中移除且只移除已验收来源产物后，完整重建原 subject；原候选不得修改或消失，新增候选只能来自该收据的未解析 mention。它不能覆盖实体身份变化或合并候选。

记录沿用原 taskId，冻结旧角色计划、76→78 等实际候选差异、原 critical/blocked question ID、全部 role work 文件（包含语义修复预算、失败、grant）、两个 ledger 前缀以及来源执行／验收／finish／convergence。它是 `semantic-scope-planning-only` 权限，**不移动当前 roster 指针、不迁移或重置预算、不创建 successor 审查计划**；已有审查完成门禁保持有效。

后台 `runRoleSemanticScope` 在原任务的固定 `semantic-scope/` 目录执行两个全新 Pi 订阅会话：精确语义范围及 payload 提案、独立复核。各阶段固定最多 24 次请求，单次 invocation；未用完的额度不允许重新开阶段。当前变化的来源依赖是新工作的前提，不可用它重答旧审查或重复规格／分流阶段。

每个独立规格条件对应具体 operation slot 或显式缺项。操作必须使用既有类型、精确目标 ID、当前 baseline/revisionHash、注册字段 pointers、完整 payload、类型化依赖及证据；每个未定边界仍为 unresolved。独立会话重新读取完整原文与全部操作依赖。负面结果／gap 保留为 BREAK；supported 可以支持仍然缺失的条件。

接续授权须逐项核对实际记录和 trace：提案／复核的 payload 与字段范围 → 当前类型化 requirement/dependency 入口 → `verifyUpstreamRepairPlan` → `UpstreamRepairLedger.register/authorize` → 窄 typed proposal → 实际 pending 图的独立验收 → 原 finish intent/receipt → convergence → 消费者重新验证。范围规划的 DONE 仅交宿主审查，不替代这条授权链，不使原问题解决，也不使主 loop READY。旧 grant 永远不可续发；任何当前入口不支持的范围都必须明确报告，不能用文本重叠、来源 supported 或无关旧计划补权。

## 四处创建范围错误的一次显式更正

原范围提案已由 Pi 提交、因三处创建 `pointers=["/"]` 和一处创建 `baseline` 错误而停止时，只有用户明确授权更正这四处字段后，宿主才可调用 `prepareSemanticScopeCorrection` 冻结只读 intent。预检须确认这四处是当前全部类型范围错误；被替代的 resolution 已同时留在原 `readableRefs` 和 payload 的 `supersedesResolutionId`；原 trace 已失败且所有请求与工具已结束，原独立复核尚未调用。intent 绑定原输入、失败提交、trace、全部 11 份文件、pending requirement 前缀及原累计用量，不产生更正后的小说提案。

`runRoleSemanticScopeCorrection` 使用同一 taskId 的唯一 `semantic-scope/correction/` 目录。新 Pi 会话只能将上述三个 pointers 改成 `[]`、该 baseline 改成 `null`；完整 payloadJson 字符串、依赖、证据、缺项、消费者条件和数组顺序逐项保持原值。任何越界、再次提交或调用上限错误均停止，禁止重试或更换目录。新预算从原失败阶段完整用量继承，24 次请求及字节总上限不变；原 budget 文件不改写，失败 trace 不改成成功，原 start/invocation 不重跑。

更正通过后才执行原来尚未消费的 `semantic-scope-check`，由全新 Pi 会话重新读原文和全部依赖，独立复核完整提案。该检查沿用原 24 次上限，只允许首次调用。两条新账本记录保留更正 provenance，仍依附原 pending revision，不创建 successor 角色计划、修复 grant 或世界写入。负面复核、任何 `missingCondition` 或 unresolved 缺项均保持 BREAK；supported 可以支持缺项，不能删除缺项或代表原问题解决。后台 hook 仅在结束、阻塞、绑定漂移或原进程退出时回调一次；源码预检期间与正常进度保持安静。

## 独立身份要求与完整消费者审查

`independent-identity-requirements/v1` 用于用户新授权、由冻结范围提供的 `entity-resolution` 创建项（1～48 项）。保持原 prerequisite taskId、pending denominator revision、原 question IDs、实际记录的全部缺项和边界以及所有旧 grant 不变。新要求只定义有来源支持的不确定性表示，不取代原 critical/blocked 问题。

先由新的 Pi 会话根据原文与实际提及／前驱定义要求，再由另一个会话独立复核；这两个会话不能读取待执行 payload 或消费者结论。宿主复用 `buildPreparedClosure` 建立传递消费者清单，加入全部旧角色条目和旧／新分母。调用前固定每片最多 48 项的完整分区；每片依赖绑定／影响提案和独立复核各用一个新会话。分区不得在失败后改名、删减或重复调度。每个固定会话最多 24 次请求，512000 字节／次与 12288000 累计字节；这些是新工作限制，不改写任何旧预算。每次计费同时记录全部旧实际调用／字节和本任务新增累计用量。

消费者图仅把显式类型化引用当成依赖。来源页与旧条目属于复核覆盖范围，不能用于获得写权限。所有候选和判断字段保留；名单中机械的 unitIds／extractionRunIds 清单在模型视图中显示原始 hash 和数量，完整值仍冻结在宿主 inventory。每片完整读取自身消费者和必需原文，不能通过省略消费者通过审查。

新记录进入原 RequirementLedger 的 `identity-requirements` 类型，invocation/input/proposal/record/trace/budget 与前缀均须验证。仅全部独立要求、精确依赖和所有消费者复核有效时才能产生 `upstream-plan.preview.json`。预览仍需现有 `verifyUpstreamRepairPlan`、`UpstreamRepairLedger.register/authorize`；允许的写入只有冻结范围的全部精确决议 payload，宿主仅可加入执行 provenance。原已消费语义提案不得修订。新的来源身份断言、消费者写入、名单激活均不在此权限内。

上游 finish 必须验证独立 Pi 对实际 pending 决议图的验收记录、原 typed proposal 会话、计费和来源读取；无验收不能提交。新要求满足只证明对应不确定性表示，原问题、全局闭合与可执行认证继续单独判定。任何 gap、额外修复需求、负面复核或未知影响保留并停止放权。后台只回调完成、阻塞或异常退出，正常进度保持安静。

### 未定边界与修复前提

独立定义及复核支持有限 `uncertainty-preservation` 要求时，可以继续原固定的**只读**消费者审查。定义里的 `missingCondition` 原样保留；它本身不说明缺的是原身份问题的证据，还是当前有限修复的前提。宿主不能按措辞自行分类，也不能因 `supported` 将它清空。

每片 Pi 消费者提案必须针对原缺项的精确 `conditionHash` 填写绑定中的 `definitionGap`，明确为 `retained-boundary`、`repair-prerequisite` 或 `unknown`，附理由和原文证据。随后独立 Pi 会话在同一 requirement 的 judgment 中复核同一条件、同一分类。只有每片都支持 `retained-boundary`，当前 payload 的独立验收条件满足、绑定自身 `missingCondition` 为空，且完整消费者影响复核通过，才能构建原精确上游预览。缺分类的旧记录、真正的修复前提、未知、负面复核及额外修复需求均不能放权。原问题缺项、critical/blocked 和未定边界继续保留，来源证据不会因此升级为身份事实。

对旧的“定义已有支持，但因非空缺项禁止消费者审查”停止，可在修复经审查测试后使用 `inspectIdentityConsumerContinuation` 检查原宿主、完整文件哈希、两份已登记记录、当前源与消费者清单以及全部未消费阶段。`continueConsumers` 仅继续原 intent 的固定消费者分片，不重跑或重登记定义，不修改原 taskId、失败、grants、分母、分片、每阶段预算或累计计费。单次续行凭证、零写入收据和状态写入 `consumer-review`；原 `state` 与 `host-recovery` 保持原样。任意分片复核不通过即停止；后续不得借此重启已消费阶段。该入口不恢复主编译器。

### 消费者缺口的只读移交

`nwh requirements inspect-identity-repairs --source <source-id>` 从现有 RequirementLedger 发现 `tasks[].taskId`。追加 `--task <task-id>` 可分页查看已登记消费者处置；复制 `items[].ref` 或 `availableRefs[]` 到 `--ref`，可读取该消费者的完整当前载荷、精确修订、依赖字段指针及类型化下游闭包。`baselineManifest` 保留闭包全部 ref/revisionHash，`downstream.nextOffset` 用于继续读取下游清单；清单保留依赖数量与 hash，复制 `downstream.items[].dependencies.readRef` 到相同 source/task 的 `--ref` 可读取完整指针，不将所有节点的依赖重复展开在一页中。来源复核条目和分母覆盖单独保留，不被当成类型化写权限。该入口不调用模型、不创建任务、不更改原记录或尝试次数。

`compile-novel status` 和 `status --json` 的 `sources[].identityReviews` 分别报告已登记的分片审查、未审分片、待修复处置及整体修复支持。`recordedReviewComplete` 只表示提案和独立复核已在账本中，不表示缺口解决或宿主验收通过；状态快照不重新执行 trace／宿主验证。详细移交重新核对当前来源和冻结输入，仍不能替代执行授权。`supported` 可以支持“需要额外修复”；原 `blocked`、`missingCondition` 和独立定义中的保留边界分别呈现，不能按文字相似度互相覆盖。

额外实体修复不能借原 resolution 创建槽位执行。移交中的 `capability.existingArtifactRevision=unsupported-kind/unsupported-revision` 表示当前上游协议缺少对应操作；必须先实现来源限定、精确基线绑定的类型化修复及独立验收，再提出具体语义方案。不得以闭包为删除清单，也不得自动合并、重绑、放行旧实体，或通过 `--rebuild` 清掉本次停止。未完成的能力继续作为原账本处置保留；移交结果不是新的权威账本。
