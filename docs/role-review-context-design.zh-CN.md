# 全书角色复核的上下文与可恢复调度设计

状态：核心有界审阅路径已实现；真实 Pi 质量／用量试验及扩展能力待验证，见第 11 节。日期：2026-09-29。

范围：`reviewNovelRoles` 的独立角色分母、重要性与发展预期复核；不改变运行时角色知识、世界事件权威或全书认证标准。当前 Codex 仅负责源码设计与工程验证，所有小说语义分析和提案由 Pi 执行。

后续统一修订方案：[上下文与核验能力 v2](role-review-context-v2-plan.zh-CN.md)。涉及全局导航、问题逐项闭合、动态补证和旧草稿核验时，以 v2 的待实施要求为准；本文保留原设计与已实现范围记录。

## 1. 结论与设计目标

采用**全书分段审阅 → 带来源的审阅索引 → 逐角色证据工作包 → 全局补漏与冲突检查 → 原有提交协议**。宿主安排工作、限定上下文并验证状态；Pi 负责发现角色、解释证据、提出判断。所有阶段都保持同一独立审阅的身份。

不是把全书压成一份摘要后当作事实，也不是只搜索已知人物名字。全书覆盖与局部工作上下文分别建模：前者是审阅任务的持久进度，后者是当前一步所需的有限材料。

目标：

- 每个原文范围都有明确的审阅工作与状态，遗漏角色仍能被发现。
- 角色重要性、稳定性和变化判断可回到精确原文；证据存在不等于证据支持语义。
- 已完成工作可恢复，正常换工作单元不重读整书、不清除提案失败历史。
- 模型输入由当前任务决定，不由聊天记录长度决定。
- 保留两轮独立审阅、既有 requirement/repair ledger、proposal → validate → finish。
- 不增加外部数据库、向量检索、通用模型写文件工具或产品级统一 token 配额。

## 2. 证据与根因

最近一轮 `run-mumdd9wl-323ffc11-3a84-4f22-9cdc-8db8d64f5fdf`：

| 指标 | 实测 |
| --- | --- |
| 模型请求 | 70 次；69 次有完成响应与用量记录 |
| 单请求 input + cacheRead 中位数 / 最大值 | 580,290 / 597,491 token |
| 超过 500,000 token 的响应 | 54 次 |
| 非缓存输入 / 缓存读取 / 输出 | 1,804,903 / 31,720,832 / 13,746 token |
| 最后请求 JSON 大小 | 1,920,755 字节 |
| 全书页面读取 | 34 页 × 3 个会话 = 102 页次 |
| 新增角色草稿 | 15；累计 28/76 |

34 个唯一页面包含约 278,913 字符原文；序列化工具正文约 1,175,290 字符。10,990 个页面内 unit 记录（含跨页重复）中，unit ID 自身约占 417,632 字符。分页控制了每次工具返回的体积，没有限制之后请求累积携带的原文和协议开销。

用量解释限制：上述 token 是 Pi 记录的 provider usage 口径，不是我们独立测量的实际注意力窗口。最后一次本地逻辑估算约 355,324 token；目录声明的模型窗口又是 272,000，与 provider usage 不一致。必须检查 tokenizer、usage 归一化、实际出站载荷及服务端行为，不能据此宣称模型真实支持 60 万窗口，也不能假定自动压缩有效。请求字节数、计数方式和服务端额度规则应分开报告；此次错误未说明额度类别或恢复时间。

源码根因：

- `src/workflow/role-review.ts`：一次 `compile` 承担完整独立审阅，阶段推进仅写在任务提示里。
- `src/compiler/role-roster-tools.ts`：先读整书才能暂存条目；`visited` 为内存集合，重建工具集即丢失；工具输出重复携带长 ID。
- `preview_role_roster_review`：进度查询和完整校验共用路径，空草稿显示分母不匹配，缺少阶段化下一步。
- `src/commands/compile.ts` / `src/compiler/batch-outcome.ts`：恢复按整个 compiler prompt 进行；暂存能恢复，但阅读和上下文从头开始。
- `src/compiler/pi-compiler.ts`：来源限定的会话禁止保存／接续旧 transcript。这是正确的隔离边界，不应为了恢复进度而取消。
- `src/agent/model-request-budget.ts`：已有直接挂在 Pi 请求路径上的 admission 实现；不能直接套用 actor 的默认预算或重试规则。

## 3. 外部调研及适用边界

1. **Lost in the Middle** 在其测试的检索与问答任务中发现位置敏感性，较长输入不保证更好地利用中部信息。它支持对证据位置与干扰项做评测，不证明当前 Sol 的具体失败机制。[原论文](https://arxiv.org/abs/2307.03172)
2. **RULER** 将长上下文能力扩展到多跳、聚合等任务，表明简单找针和模型声明窗口不足以代表有效处理能力。因此本项目应测跨章节发展、别名与因果重要性，而不是只测引用 ID 是否存在。[原论文](https://arxiv.org/abs/2404.06654)
3. Anthropic 的 context engineering 文档讨论按需加载、结构化笔记和压缩，并指出压缩会丢失后续可能重要的信息。本方案采用可回读的来源索引和分阶段工作包；笔记不替代证据。[官方工程文档](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
4. 工具设计应减少含糊、冗余输出，让返回值给出清晰可执行的下一步。本方案据此拆开“待办进度”和“提案合法性”，同时保留确定性校验。[官方工具工程文档](https://www.anthropic.com/engineering/writing-tools-for-agents)
5. **本地 Pi 0.84.2 的实际接口**：`docs/extensions.md` 的 `context` 事件支持每次请求前非破坏性投影消息。项目自身 `installModelRequestBudget` 注释指出 extension 异常可能被捕获后继续，因此强制 admission 不能仅靠事件处理器抛错。以锁定依赖版本的代码和集成测试为准。

上述研究支持设计方向；下文数字是本项目试验起点，不是研究保证的最优参数。

## 4. 分阶段工作与上下文

### A. 固定审阅范围

宿主冻结 source/hash、结构版本、候选 subjectHash、reviewRevisionId、独立审阅 ID、原 batch ID、协议版本、模型记录和计划 hash。锁与现有义务门禁先于模型调用。

按真实章节／段落／结构单元构造连续 core spans。每个原文字节范围必须属于某个 core 或显式的非正文范围；相邻上下文只能作为 context spans，不能重复计为审阅完成。超大段落允许分片，但不丢字节、不在字符中间截断。模型可请求相邻和远端上下文；缺少上下文必须形成待办，不能凭结构划分假定一个场景已经完整。

### B. 全书分段审阅（独立发现）

每个 Pi 工作单元输入：

- 当前连续原文 core、必要的两侧上下文；保持说话者、叙述层次及段落结构。
- 小型章节导航；本轮已有且与本段相关的别名假设和开放问题，均标为待验证。
- 角色发现、行为／关系／视角／发展线索的审阅任务与窄工具。

**不预置所有角色的既有重要性、另一轮判断或已编译性格模型。** 全段浏览阶段先允许发现未在候选清单里的角色，避免名单引导遗漏。

Pi 提交窄类型 `propose_role_source_review`：发现的人物提及、直接证据定位、重要性线索、变化与反证线索、未解指代、跨段问题；也可声明“本范围未发现相关线索”，但须有 rationale 和受检范围。此声明可被后续复核推翻。

宿主校验 scope、原文定位、完整范围记账和字段结构，持久化 work receipt。区分 `delivered`、`reviewed`、`reviewed-with-open-questions`、`blocked`：工具读过不等于审阅完成。只有已验收的分段提案才推进审阅进度；语义理解仍由 Pi 和后续独立检查负责。

### C. 构造本轮来源索引与候选映射

审阅索引是可重建的导航视图，不是第二套世界真相。保存“谁／哪段／什么线索／哪里不确定／证据指针”，不累计一篇无限增长的全书摘要。

宿主只按确定的来源和引用关系索引。未知别名和人物同一性由 Pi 提出，宿主不得凭名字相似自行合并；不能在此阶段越权修改 canonical identity。

映射到冻结候选清单后，对每个候选产生待复核工作。来源发现但未映射的人物保留为独立发现项；最终进入既有 `missingMajorCharacters` 与 requirement/repair 流程，不能为了处理新发现而悄悄改 subjectHash。

### D. 逐角色复核

默认一个角色一个工作单元。输入包包括：

- 当前候选身份与未解决歧义；必要的关系对象最小卡片。
- 本轮审阅发现的相关片段索引、全书分布和开放问题。
- 能支持重要性判断的原文；若判断发展，则包括前后证据、反证和叙述时间信息。
- 此角色已有暂存版本、该身份的失败状态、精确下一步；不携带其他 75 个角色的全部条目。

Pi 可以按名字、别名、原文词句作本地词法查询，也可以沿本轮审阅中提出的指代、关系、事件指针回读。检索只帮助定位，不证明未命中对象不存在；不得用搜索频率替代重要性。

证据选择分为“必需”与“可选”：已知反例、未解同一性、发展前后状态不能因空间不足被静默淘汰。先去重、缩小不相关背景、补充确切邻段；仍超限则拆为证据子任务，最后角色裁决重新读取关键原文。记录 `omittedRefs`、原因、待补证和 packet hash。

`stable` 不是“没搜到变化”；必须有跨全书的审阅覆盖和支持连续性的材料，且无未处理冲突。材料不足为 `unknown`，不得将 unknown 用作低成本通过方式。`changes` 需区分持久倾向、临时情绪、目标改变与叙述顺序；原文页码顺序不自动等于世界时间。

Pi 完成局部预检后沿用 `propose_role_roster_entry` 的原 candidate identity 暂存。正常完成一个角色不调用全局 `finish_compiler_batch`。

### E. 全局补漏与冲突检查

全局 Pi 工作包只包含紧凑角色总表、来源分布、未映射发现项和差异／冲突摘要；不注入所有原文。

检查：遗漏主要人物、未解指代是否隐藏独立人物、晚出场但有关键因果作用的人物、边缘分类是否与证据冲突、发展结论是否忽略反证、章节间判断是否矛盾。名单太大时按明确问题拆分，并保留全局未闭合项目清单，不能随意 top-k 截断分母。

对“没有线索”的范围、疑似关键转折和尾部章节安排补漏回读；抽查不能宣称穷尽语义正确性。新的重大线索回到局部复核或 source work；只有有界的新证据变化才触发重审，反复无进展转入既有修复账本。

### F. 全局提交

宿主验证：所有 source work 已有合法审阅状态、全候选恰好一次有效条目、发现项得到记录、关键开放问题已处理或明确阻塞、原失败义务闭合、所有版本和 hash 一致。

审阅产物充分才开放 assemble/finalize 工作。Pi 调用完整预检和既有 staged assembly，最终仍走 `finish_compiler_batch` 与持久 finish receipt。局部 work receipt、角色草稿、独立 review 完成、全书闭合、认证和激活保持不同含义。

## 5. 上下文装配合同

每次请求由 `ReviewContextAssembler` 生成可审计 manifest：

```ts
type ReviewContextPacket = {
  identity: { sourceHash: string; subjectHash: string; reviewId: string;
    reviewRevisionId?: string; batchId: string; workId: string; planHash: string };
  phase: 'source-review' | 'candidate-review' | 'global-audit' | 'finalize';
  requiredEvidenceRefs: string[];
  includedRefs: string[];
  omittedRefs: Array<{ ref: string; reason: string }>;
  openQuestionRefs: string[];
  authority: 'review-proposals-not-world-truth';
  allowedTools: string[];
  nextAction: { kind: string; workId: string };
  requestBytes: number;
  tokenEstimate: { value: number; method: string; uncertainty: string };
  packetHash: string;
};
```

固定任务与短工具协议放在稳定前缀；当前目标、必需原文和下一步清晰相邻。原文、Pi 笔记和宿主状态显式区分，原文与笔记都不能变成指令。避免对整套世界编译的无关工具和语义规则重复注入。

初始试验配置（总上下文包含 system、schemas、原文、历史；不是原文独享额度）：

| 工作 | 目标输入量 | 处理超限 |
| --- | --- | --- |
| 原文分段审阅 | 12k–24k token | 先按连续结构拆分，保留边界问题 |
| 角色复核 | 16k–32k token | 子问题补证后整合；必须保留反证 |
| 全局检查 | 12k–24k token | 按缺口和冲突拆分，完整分母在宿主 |
| 最终 assembly/finish | 4k–12k token | 工具读取条目引用，模型不重抄全表 |

常规单请求初始 admission 上界设为估算 48k；模型输出预留 8k，总需求必须小于经验证的模型窗口。难例由宿主显式安排较大的有界任务，而不是悄悄删必需原文。估算需用适配的 tokenizer 校准；不可将 `字符数/4` 当作中文或 opaque ID 的精确 token 数。

同时设置这个阶段专用的出站字节限制作为后备：初始 256 KiB，试验校准后调整；检查的是最终 provider payload。token/字节任一超限都在请求前规划更小工作，不能靠报错后原样重试。该 admission 是单阶段资源与结构约束，不是 ADR 禁止的产品级统一 token 配额。

这些数值不能保证额度不会触发。记录累计调用和用量并沿用原 loop 预算；服务端 usage limit 单独停机，不通过换模型、换 ID 或重置预算自动绕过。

## 6. 压缩、引用与消息投影

### 精确引用的紧凑表示

完整 unitId 留在宿主索引。工作包给出确定性的短引用，例如 `p17:u42`，绑定 sourceHash、packetHash、workId、完整 unitId 和必要的子范围。模型工具入参先经窄适配器解析并持久化映射，再进入现有完整 ID 验证；不能直接改全库 ID 或允许模型猜号。

跨工作包引用必须用已持久化的带包标识 ref；旧包失效时拒绝并给出同 scope discovery。最终提案证据仍保存规范 ID 和定位。若这层适配过于复杂，第一期先只对可读输出去重，保留完整引用；不能为省 token 牺牲可回放性。

### 可以丢出当前上下文的内容

已验收且与当前工作无关的原文、其他候选的草稿正文、重复成功确认、重复 schema 展开、已处理工具输出。完整原记录仍留 trace/store。

### 不能被摘要替代的内容

当前决定所依据的原文、重要反证、未解指代和叙述层次、必须处理的开放问题、失败／耗尽状态、版本和来源绑定。模型笔记仅作导航，不能成为最终判断的唯一证据。

### Pi 集成

优先在 work 边界创建新的隔离 Pi invocation，以有限 packet 作为起点；同一 parent batch 的工具状态从持久工作记录恢复，不复用跨来源 transcript。

在单个 invocation 内，用受控 `context` 投影清理已经结算且不再需要的 tool call/result 对。不能留下孤立 tool result，不能删除未结算调用或宿主错误。投影只影响出站消息，不改历史审计与提案 journal。第一期可先不做复杂消息裁剪，依靠小工作单元保证界限。

最后的强制 admission 使用直接 agent callback，复用项目已有模式；不依赖 extension 抛错阻止请求。投影、token 估算、最终 payload admission、trace hash 顺序必须集成测试确认。

## 7. 持久化、调度与错误恢复

建立 role-review 专用 work store，仍为人可读本地文件。它只拥有执行进度，不成为另一套语义 requirement ledger；来源缺口和关键延期继续登记现有 requirement/repair ledger。store 中保存 immutable plan/packet/artifact/receipt，追加式 transition 形成可重放投影。

身份层次：source → review revision → 独立 review/parent batch → work → invocation attempt。工作 ID 从固定计划范围和类型确定；新 invocation 不能取得新提案身份或重置失败历史。现有 source hash、candidate ID、proposal ID 与 finish receipt 权威保持不变。

主状态流：

```text
planned → source-review → candidate-review → global-audit → ready-to-finish → committed
                         ↖ evidence-needed ↙
任意阶段 → blocked(host/scope/quota/deadline) 或 interrupted(resumable)
```

宿主每次只派发明确 work，记录 durable progress hash。局部结果必须有通过校验的 work receipt；模型自然语言说“完成”不算。Pi 自然结束且缺工作回执时，归类为该 work 的早退；在现有恢复政策允许范围内，同 work 有界接续，无进展达到阈值则停止。只做查询、页访问和换措辞不算持久进展。

`compileCommand` 当前要求完整 batch finish，不能直接把一个 source shard 或候选 work 送进去后期待成功。需要新增专用 `runRoleReviewWork` 结果合同；它复用 Pi 隔离和 trace，但以工作回执判断局部完成。全局 `compileCommand`/finish 仍只在最终阶段运行；禁止全局放宽“无 finish 也成功”。

预检结果明确区分：`needs_source_work`、`needs_candidate_work`、`needs_evidence`、`needs_correction`、`ready_to_assemble`、`needs_finish_recovery`、`host_review_required`。正常缺项给 `nextAction`；host stop 优先于任何 suggestedCall。ID 错误指出发现工具与应复制字段，只允许一次纠正重试；scope 变更、耗尽、单次消费和预算失败不得重试。新工具逐一遵守 agent-tool-recovery 文档。

崩溃一致性：持有现有 compiler lock；先写不可变结果与 proposal 记录，再写指向其 hash 的 work receipt／transition。重启依据原 ID、输入 hash、实际提案和 receipt 对账。若提交结果不确定，先恢复／核验，不重新请求模型。不能仅写 done 标记后假定提案已经落盘。

无提案的 source work 也有持久待办；“proposal obligations=0”不能抹掉工作。恢复时加载当前 work 所需来源，而不是把整个 visited 集合清空并重新要求全书阅读。

## 8. 两轮独立性与当前 28 条草稿

两轮可共享不可变原文、结构和确定性的词法索引；不能共享前轮的角色判断、语义笔记、相关性排序或别名推断。每轮自行进行分段发现、候选判断和补漏；宿主比较两轮差异时要标记为后续 reconciliation，不能将比较后结果冒充独立初判。

本方案是协议演进，不能伪造旧进度：

- 保留当前 batch 和 28 个成功条目、所有失败记录及来源证据；不得重新编号以获得重试机会。
- 旧的 page visit 不具备新版本 source-work receipt，标为 legacy，而非自动宣布完成新的全书审阅。
- 旧条目保留原有效性，新协议新增证据／覆盖条件需要专项验证；相同来源下继续处理剩余候选，也不能把整轮认证为新协议已通过。
- 如需将旧审阅接入新计划，显式记录 versioned continuation/adoption decision，绑定旧 batch、全部草稿 hash、未完成范围和新增要求。旧／新混合 provenance 必须进入最终回执；语义 schema 不兼容则走现有 review revision 协议。
- 不复制或暴露前一轮人工复核结果作为本轮的上下文。

## 9. 落地模块与实施顺序

建议新增（名称为提案）：

| 模块 | 责任 |
| --- | --- |
| `src/compiler/role-review-plan.ts` | 冻结范围、分片、确定工作身份与下一步 |
| `src/compiler/role-review-work-store.ts` | 不可变结果、工作回执、重放与恢复 |
| `src/compiler/role-review-context.ts` | 包装原文、来源索引、证据选择、预算与 manifest |
| `src/compiler/role-review-work-tools.ts` | 分段审阅提案、局部完成、有限补证 |
| `src/workflow/role-review.ts` | 派发工作与最后整体验收 |
| 既有 `role-roster-tools.ts` | 角色草稿／完整装配与阶段化 preflight |
| 既有 Pi adapter / trace | 每次请求投影、强制 admission、用量和 lineage |

阶段一：校准 telemetry、增加上下文 manifest 和测试；修复 preflight 的状态表达。仅这些改动不能宣称解决全书上下文问题。

阶段二：实现 source work、持久审阅结果和局部完成协议，接入原 proposal/requirement/finish 边界。

阶段三：实现候选 evidence packet 与全局补漏，按 work 重建隔离 Pi 会话；先做连续、单 worker 调度，不新增并行 agent 的协调复杂度。

阶段四：验证旧 28 条草稿的兼容接续，完成有界 Pi 实验后才恢复长时间全书 loop。模型运行仍由 Pi 负责。

需要明确记录的架构变化：从“一个会话全书访问门禁”改为“一个独立 review 的持久分段审阅门禁”。不能只删除 `visited` 检查；计划、回执、覆盖与 finish 校验必须一起交付。若持久合同变化，新增显式版本与拒绝测试，不能静默迁移。

## 10. 验收与实验

### 确定性测试

- 连续 core 覆盖、UTF-8/跨单元边界、重叠不重复计数、超大单元拆分。
- packet 不包含另一轮语义笔记、未来 runtime 私有状态或无关工具。
- 短 ref 到完整 ID 的唯一映射，过期／错误 packet 拒绝、一次纠正 SOP。
- 正常待办与 host stop 的 nextAction；有 host block 时绝不推荐继续提交。
- source work 中断、proposal 成功但 receipt 未落盘、finish prepared 等边界恢复；不重复消耗原身份。
- 只读早退也保留待办；角色草稿成功后新会话不要求重新访问整书。
- provider payload 逐请求 admission；协议 tool call/result 成对；预算不因换 work 或 invocation 重置。
- 最终 finish 拒绝覆盖缺口、关键未知未登记、遗漏候选和缺失审阅回执。

### 语义评测（Pi 执行）

先用公开／人工合成、有人审定标签的小型多章节文本，覆盖：低频关键人物、晚出场人物、别名／代词、梦境与嵌套叙述、倒叙、稳定角色、暂时情绪、真正持久变化、抽取器漏人、互相矛盾的证据。调整证据位置，加入无关干扰，检查质量是否依赖位置。

比较现有协议与新协议的小规模基线；固定来源、模型和 rubric。真实小说仅在既有授权下由 Pi 做受控试验，不让当前 Codex 手工补语义答案，也不把旧人工结果当作新独立评审输入。

衡量：主要角色召回、错误提升为 major、证据支持率、发展判断与 unknown 校准、跨轮独立性、来源漏读、无效 ID、完成率、每个合法角色新增所消耗的输入／缓存／输出／调用数、重读率、恢复成本、单请求 p50/p95/max。

初始工程目标：常规请求 p95 ≤ 32k、所有常规请求 ≤ 48k 估算；任何必要超限都有记录和拆分；对固定试验整个任务的总输入（包括新增加的全书审阅与全局检查）比旧基线下降至少 70%，同时不降低已标注主要角色召回与证据支持质量。它们是待验证目标，不能从上下文变短直接推定。

粗略量级校验：当前一轮 33.5M 输入/缓存读取只新增 15 条；若局部角色平均 4 次请求 × 24k，则 76 角色约 7.3M，另加每轮分段审阅、全局检查及难例补证。应实测而非承诺固定省费比例，更不能把实验数字当作服务额度保证。

上线前未决项：Sol 实际 tokenizer/usage 口径差异；Pi 自动压缩与投影的具体事件顺序；原 work-store 与提案 journal 的崩溃一致性；development 的跨章证据负荷；legacy 接续的版本边界。逐项有测试和运行证据后才扩大范围。

## 11. 当前实现记录（2026-09-29）

主路径已改为有界 source work、逐候选 work、逐 source core 的全局补漏 audit、最终普通 finish。分段会考虑原文连同 ID 的序列化开销；每个 core packet ≤16,000 字节，审阅笔记 ≤8,000 字节。段落边界优先，超大单元分片并提供邻段及精确分页回读。引用暂时保留完整 unitId，避免引入尚未验证的短引用迁移。

每次 Pi work 使用新隔离会话，12 次模型调用上限；最终出站载荷限制为 **48,000 字节**，它是保守字节 admission，不冒充 48k token 精确测量。该实现先采用更保守的限制，尚未校准 Sol tokenizer。单角色提交前要求本次 work 已完整读取所有引用原文；草稿继续进入原 journal。不会裁剪未完成工具消息，也不自动在超限后原样重试。

`role-review-work/v1` 保存不可变计划和包括零提案早退在内的尝试记录。source/audit 的有效 journal success 本身就是工作回执，不维护第二个可漂移的 done 标志。已有候选草稿的哈希记录在计划中，原 journal 不改写；旧页面访问不能满足新版覆盖。审阅 v3 在最终产物中携带冻结计划、source/audit 结果和条目 hash，随既有 roster/finish/archive 保存；旧 v2 可读。compiler prompt fingerprint 升至 38，主批次 pipeline 不清零。

尚待真实 Pi 小范围实验验证质量和用量目标；这次源码验证不解析真实小说。补漏发现语义冲突时保留 audit 内容并停止，尚未实现自动反复分配语义修复轮；不会伪造修复或让 Codex 代写小说判断。工作计划和未完成 work 的执行记录目前仅保存在原 workspace，不承诺将未完成审阅迁移到另一 workspace；完成后的 v3 审阅证据自包含。短引用优化、自动难例扩容、跨工作区未完成任务迁移属于后续实现，不能由当前测试推断已经支持。
