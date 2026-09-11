# 开局编译阻塞深度 Review

审查时间：2026-09-11。代码基线：`8db0bc7c132516dfdd5ad64b309cf4596932fbcf`。对象：《龙族Ⅰ·火之晨曦》定时续编中的 opening publication pass。本文时间线使用北京时间。

## 结论

这次 block 是模型提交错误和宿主协议缺口共同导致的。直接停止点是两种不同失败输入耗尽了持久纠正机会；两个输入失败于不同校验层。模型确实修正了第一层报告的问题，却在第二次才收到第一层未暴露的开局语义要求。随后第三次调用被宿主门禁拦截。

根因不能仅归为“模型漏了三个字段”，也不能归为额度或网络问题。已确认的系统问题有：模型公开契约与内部校验不完整对齐；逐层报错与单次纠正预算不匹配；失败后通用清理违反保留复核现场的要求；状态查询遗漏开局批次；开局流程没有接入此次普通批次使用的完整审计 trace。

还发现此前状态报告没有体现的第二条失败义务：`p-mention-opening-man` 失败后，模型改用 `p-mention-opening-man-v2` 成功，但旧身份的失败没有被解决。即使修好 initial-world，直接 finish 仍会遇到它。

## 现场与证据边界

- 源 ID：`a28585b1cf867f3e3a16`。
- 开局批次：`opening-batch-a28585b1cf867f3e3a16-00002-executable-684389ad80a1`，是普通 71 批之外的补充发布步骤。
- 定时服务：`nwh-opening-20260911.service`，03:15 启动，03:21:14 以退出码 1 结束。
- 普通批次：71/71 已完成，检查点未因此丢失；无完整归档 candidate、无编译锁。
- 实际开局义务：2 条 failed，其中 initial-world 已要求 host review，mention 旧身份尚有单次失败。
- 已暂存后被宿主拒绝的工件：2 个 entity mention、2 个 entity resolution、1 个 entity，共 5 个；没有成功保存的 initial-world。

本次主要依据持久 proposal journal（含精确输入、inputHash、失败诊断、时间）、rejected 工件、服务日志和当前代码。开局调用未提供 trace，`saveSession=false`；未找到与这次 19:15 UTC 开局执行对应的 run manifest。因此不能声称取得了全部原始模型消息、第三次提交全文或完整 provider payload。

附件保留 [opening-obligations.json](opening-obligations.json)（原文件路径、文件哈希和完整 journal）、[initial-world-attempts.json](initial-world-attempts.json)、[validation-replay.json](validation-replay.json)、[compiler-status.json](compiler-status.json)。

## 失败链条

| 北京时间 | 事实 | 影响 |
| --- | --- | --- |
| 03:16:44.143 | `p-mention-opening-man`：surface 为“他”，selector.exact 为“他猛地坐起”，违反非零提及 surface 必须等于 exact 的规则。 | 第一个未解决义务形成。 |
| 03:16:59.192 | 模型改为 p-mention-opening-man-v2，用 exact=“他”及 prefix/suffix 消歧，暂存成功。 | 修正了业务输入，但新 proposal ID 不消除旧失败身份。 |
| 03:17:18–03:18:54 | 人世位置实体、相关提及和身份解析陆续暂存成功。 | 这些是待 finish 的草案，不是已认证世界真值。 |
| 03:18:54.125 | initial-world 第一次输入在工具参数 preflight 被拒绝。 | 尚未进入执行期 Zod 开局校验，失败预算计入一次。 |
| 03:19:55.113–.206 | 相同 initial-world ID 第二次输入通过工具参数校验，进入 execute，随后被 Zod 自定义规则拒绝。 | 第二种失败 inputHash 形成，触发 host review。 |
| 约 03:20:59 | 日志显示第三次 `propose_initial_world` 调用。 | 原始第三次参数未持久化；代码与只读门禁复现表明此时已禁止继续验证。不能把它计为第三份已执行并校验失败的候选。 |
| 约 03:21:12 | 模型输出需要宿主裁决、保留草案并停止的文字。 | 模型没有完成 finish。 |
| 随后 | `prepare-all` 捕获异常，拒绝 5 个当前开局草案，尝试 deterministic fallback。 | 复核所需 active 草案状态被改变；历史文件仍在。 |
| 03:21:14 | 长篇保护拒绝 alive-only fallback，服务退出。 | 最终命令错误变成 fallback 不可用，而非原始 host-review 原因。 |

这里是“原始输入 + 一次修正”失败，并不是模型真正拥有两次纠正机会。日志中模型对次数的自然语言描述不应代替 journal。

## 第一层：参数错误及输入/输出 schema 不一致

第一份 initial-world 输入的工具校验错误是：

1. 六条 reader fact 均省略 `focalKnowledgeClaimIds` 和 `dependsOnFactIds`。
2. `evidence_selectors[2].relation` 填为 `explicit`，把 strength 值错用到了 relation。
3. 同一 selector 校验同时报告缺 `interpretation`。由于第二份输入把 relation 改为 supports 后，该项报错也消失，不能据此推断所有 explicit selector 都必须增加 interpretation。

`src/compiler/proposal-tools.ts:345` 使用 `z.toJSONSchema(inputSchema)` 生成模型参数 schema。当前转换结果把 Zod `.default([])` 的数组列入 required；原始 Zod 输入本来能够对省略值补默认。这在只读对照中得到确认：

| 导出方式 | fact required |
| --- | --- |
| 当前默认导出 | id、kind、summary、temporalClass、basis、entityIds、focalKnowledgeClaimIds、dependsOnFactIds |
| 显式 `{ io: "input" }` | id、kind、summary、temporalClass、basis |

见 [schema-io-comparison.json](schema-io-comparison.json)。模型没有遵循公开 required，属于提交错误；但输入与内部默认能力的差异是可以消除的宿主摩擦。不能仅切换导出模式就宣布修复完成，还需验证宿主正常化及其余工具的一致性。

## 第二层：公开 schema 允许的输入仍被隐藏的条件规则拒绝

第二次输入做了可验证的实际修正：补齐上述数组，并把 relation 改为 supports。参数校验通过；fact 的类别与 actor-stance 缺项没有变化。

`src/world/initial.ts:59` 与 `:114` 的 superRefine 进一步要求：

- actor-stance 必须有 `holderEntityId`，明确是谁的立场。
- actor-stance 必须有 `stance`，明确立场方向。
- 整个 facts 集合必须包含 `kind="causal-premise"` 的事实。

模型提交的事实类别为 focal-identity、time-place、entity-identity、completed-prior-beat、actor-stance、immediate-pressure。它虽然把 `ctx-dream-beat` 放进 `causalFactIds`，却没有任何 causal-premise 分类；“引用为因果”不满足当前“必须存在该类别”的约束。

公开 JSON Schema 中 holderEntityId 和 stance 都是普通 optional 字段，没有表达 actor-stance 的条件必填；facts 的数组 schema 也没有表达指定类别必须各存在一条。代码注释解释了规则，但注释不会自动成为模型工具说明。宿主自然语言 prompt 提到 causal premises 和 actual holder/direction，故不能说模型完全未获提醒；准确问题是这些提醒没有完整映射成可验证、显式的字段/枚举契约。

**只读复现结果：**

- 第一份原始输入：参数校验失败；直接对其 payload 做独立 Zod 校验也已能检测出同样的三个语义缺陷。
- 第二份原始输入：参数校验通过；Zod 恰好报告 holderEntityId、stance、causal-premise 三项。
- 在内存副本里补齐三项后，基础 Zod schema 可通过；既有 journal 的 `assertRetryAllowed` 仍在执行前拒绝调用。

内存补值仅用于证明校验层与门禁行为，不是已通过源证据审查的修复提案。没有提交它、改写世界或绕过门禁。

## 为什么一次修正不够

`src/compiler/proposal-tools.ts:2668` 的 trackProposal 在 preflight 和 execute 失败时都写入同一持久 journal。`src/compiler/proposal-obligations.ts:87` 按同 tool/proposalId 自上次解决以来的不同失败 inputHash 计数；达到 2 就进入宿主复核。

问题在于第一次校验提前返回，第二层可在原始输入上发现的问题没有一并报告。当前恢复建议又强调“修改第一个路径的最小字段”“相同诊断再次出现则停止”（`src/agent/tool-recovery.ts:756`）。实际门禁却不要求诊断相同：只要两种输入失败就停止。模型因此按照第一组报错修正，也会在下一层报错时耗尽纠正预算。

门禁阻止无限重试本身正确。修复应优先让第一次诊断完整、公开契约一致，并明确剩余纠正次数；不应简单提高阈值或删除历史。

## 独立的 mention 身份恢复问题

旧 `p-mention-opening-man` 的失败输入从未成功修正。v2 与它共享 logical annotation_id=`mention-opening-man`，但持久义务按 proposal_id 区分，因此业务层的相同逻辑提及不等于旧调用义务已经闭合。

这与 earlier accounting 事故具有相同的模式：新 ID 的成功不能自动解除原 ID 的失败。对于此次初次调用从未成功暂存的情况，本应保留原 envelope ID 修正 exact/surface，而非提交 v2。

需要独立处置该旧失败，不能只看最终 initial-world 异常。当前 v2 和相关 resolution 还已进入 rejected 历史，真实恢复必须同时检查它们的版本与依赖状态，不能把它们当作仍 active。

## 宿主错误处理扩大了问题

### 无差别清理与 host-review 语义相冲突

`src/commands/prepare-all.ts:342` 对所有开局异常使用同一 catch，调用 `rejectPendingCompilerBatchProposals`，没有区分 provider failure、可恢复中断和 `CompilerHostReviewRequiredError`。

`src/compiler/proposals.ts:329` 会拒绝同批 world、annotation、resolution 和 accounting 等 pending 工件。现场明确发生了 5 个草案的 pending→rejected 转移：

```text
p-mention-opening-man-v2
p-mention-opening-humanworld
p-entity-opening-humanworld
p-resolve-opening-man
p-resolve-opening-humanworld
```

这些草案此前工具调用成功，不代表已经通过全图 finish，但它们应当作为复核现场保留。项目恢复协议和 HostReviewRequired 错误明确要求 preserve drafts；这里不是丢失文件内容，而是宿主改变了这些草案的可恢复状态。这是确定的错误处理缺陷。

### fallback 拒绝正确，但不该接在 host review 后

`src/compiler/batches.ts:400` 对长篇禁止只创建 alive 状态的确定性开局。该保护避免用空壳世界掩盖开局缺失，应保留。

问题在 `prepare-all` 已知需要宿主复核却仍进入 fallback，最终以“retry the model opening compiler”收尾。这与持久门禁“不允许 fresh-session retry”冲突，也掩盖了根本错误。直接重启当前现场会在创建模型 session 前被同一开局 journal 拒绝，然后仍可能走到 fallback；不是恢复路径。

## 状态与可观测性缺口

`src/compiler/status.ts:64` 仅对 `compilerScopePlan` 的普通批次扫描 obligations。开局 ID 由 `prepareOpeningWorldCompilerBatch` 另加 `opening-` 前缀生成，不属于 71 批计划，因此两条真实开局义务都被漏掉。

同时 `prepare-all` 调用 `compileInitialWorld` 时没有传 trace；`compileCommand` 仅转发可选 trace，并不像 `compileSourceCommand` 那样创建新 prepare run。`PiAgentSession` 也只有收到 trace 才记录完整调用审计。

结果是 `status --json` 仍返回上一次普通批次 run 的 succeeded 和 obligations=[]。它不是这次开局 run 成功，不能作为整个 rebuild 成功或无阻塞的证据。此前状态报告中的“无未解决义务”应修正为“普通批次无义务；开局另有两条失败”。

## 世界语义仍需另外审查

模型选择梦醒后的男子作为物理开局，把老唐身份标成 later-discourse-preexisting，并将康斯坦丁 presence 标为 dream；它还把“普普通通的人世”建成 location 实体。是否正确的身份归属、地点粒度和开局切点，需结合原文与现有 canonical identity 独立审查。

本次真正停止发生在基础参数/readerContext 规则，尚未证明上述语义正确，也没有证据将这些语义风险断言为此次直接停止原因。不能仅把 kind 改成 causal-premise 或随意填 holder/stance 就认定生成成功；字段的来源、立场持有者及方向都必须有证据。

## 建议修复顺序与验收条件

| 优先级 | 修复 | 验收 |
| --- | --- | --- |
| P0 | 开局 catch 对 host-review 和中断状态保留现场，直接传播原错误，禁止 fallback。 | 注入 HostReviewRequired 后，不拒绝任何未被诊断的成功草案、不进入 fallback、不创建新 session。 |
| P0 | 状态与 trace 覆盖开局及后续准备阶段。 | 71/71 但开局失败时，显示 opening blocked、两条义务和本次 run；不能只返回旧 succeeded。 |
| P0 | 对齐模型参数 schema、默认值及条件约束。 | 从真实原始输入一次报告可安全判断的缺陷；第二份输入不能出现“公开 schema 接受但没有任何明示规则解释的内部失败”。 |
| P1 | 恢复建议输出完整错误路径和剩余次数，明确两次不同失败也会停止。 | 参数错误→内部语义错误链有明确宿主处理；不使用“相同错误才停”的误导表述。 |
| P1 | 明确未成功提案的同 ID 修正与已成功草案的版本替换边界。 | mention 初次失败后 exact/surface 修正沿用原 proposal_id；新身份成功不隐式清账。 |
| P1 | 增加跨层回归。 | 实际参数工具、Zod、journal、prepare-all catch 和 status 联合覆盖本事故，而非只测单个 helper。 |

当前现场应先保留并审阅两条失败历史和 5 个 rejected 工件，修正宿主流程后用有审计依据的窄恢复操作解决旧义务及依赖状态，再请求模型生成证据支持的开局。不得删除 journal、把无效候选直接接受，或把所有旧错误泛用 unsupported 隐藏。

## 验证与范围

- 直接读取源登记和持久现场，没有写入编译状态。
- 用实际 `validateToolArguments`、`initialWorldSchema.safeParse` 和 `CompilerProposalObligations.assertRetryAllowed` 只读复现两层校验与纠正耗尽。
- 在本地内存对比默认 JSON Schema 导出和 io=input 导出；没有更改运行工具定义。
- 当前 4 组既有测试全部通过：tool-recovery、proposal-obligations、compiler-host-review-recovery、prepare-all，共 **47 项**。现有 fallback 测试主要覆盖小 fixture/provider unavailable，不能证明 host-review 保留现场路径正确。
- 尚无完整原始模型 transcript；恢复 SOP 是依据当前未改代码重建，不能冒充本次完整实际返回快照。第三次输入无法从现有 journal 恢复。
- 本轮仅新增分析附件与报告，未修复生产代码、恢复 rejected 工件、清理义务、重启模型编译或改变 71/71 检查点。
