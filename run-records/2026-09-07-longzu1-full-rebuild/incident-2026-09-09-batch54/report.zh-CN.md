# 《龙族Ⅰ·火之晨曦》第 54 批编译失败分析

审计日期：2026-09-09。时间线统一使用 UTC。代码基线：`8db0bc7c132516dfdd5ad64b309cf4596932fbcf`，pipeline 34 / prompt 31。

## 结论

这次失败由“恢复会话复用已成功提案 ID”触发，随后被不一致的恢复协议放大，最终进入当前宿主覆盖复核也无法直接消解的状态。

`acct-00008-p01` 最初已经成功保存 20 个单元的 accounting 草案。第 54 批第一次模型会话提前结束，宿主启动恢复会话；恢复提示明确列出了 p01–p11，但模型仍把 p01 用于另一页。不可变存储正确拒绝覆盖。错误文本要求换新 ID，而持久义务要求原 ID 的一次修正成功；换成 p12 虽然完成了原失败页的处理，却不能解除 p01 的失败义务。finish 提示再次要求原 ID 修正，模型遂尝试仅重放旧 p01 的 4/20 个单元，第二次因内容不一致失败，触发宿主复核门禁。

另一个已实测的缺口是：当前覆盖复核按 proposal ID 排除全部带失败义务的依赖，因此 p01 的原始成功草案也被排除。第二次失败涉及的 4 个旧单元因此无法通过现有 `review-accounting` 证明，尽管它们仍有原始 accounting 草案。

证据不支持把这次停止归因于网络超时、源文件损坏或模型 API 报错。模型为什么提前停止、为什么忽略恢复提示，日志不足以解释其内部原因。

## 当前现场

| 项目 | 只读核查结果 |
| --- | --- |
| source | `a28585b1cf867f3e3a16` |
| SHA-256 | `a28585b1cf867f3e3a1679a09558658338637efd2f0bf15e8d5878b7f9e44fe0`，源完整性通过 |
| batch | `batch-a28585b1cf867f3e3a16-00008-executable-5f11f49f932b` |
| 范围 | 第 8 个切片，原文 1253–1547 行，计划序号 54/71 |
| run | `run-mtsy5p5e-a40498d2-2f9c-406c-8834-c49c6e81b652` |
| 总检查点 | 53/71：observation 23、semantic 23、executable 7、boundary 0 |
| 最近检查点 | 2026-09-08 17:34:20.549，第 53 批 |
| 当前第 54 批 accounting | 31 个 pending 提案，共 616 条单元决定 |
| 世界提案库存 | pending 401、accepted 0、rejected 98；与 accounting 提案是不同库存 |
| 最后运行 | failed，17:50:29.350 结束，`retryable=false` |
| 锁及候选 | 无 compiler lock 记录；无归档 candidate |

检查点百分比 74.6% 仅表示批次审查进度。原文 accounting 完成、世界语义正确、可执行闭合和全书可玩性是不同验收结果。

## 因果时间线

事件序号来自上述 run 的 `events.jsonl`，关键输入与返回内容已另存为 [audit-excerpts.json](audit-excerpts.json)。

| UTC 时间 | seq | 事实及影响 |
| --- | --- | --- |
| 17:34:21.574 | 104 | 第 54 批开始，hostAttempt=0。 |
| 17:35:56.759–17:35:57.823 | 182/183、journal | p01 使用 `acctpg-39fefb7edae08667` 成功，20 单元、background-only；页标记 consumedBy=p01。 |
| 17:39:56 前 | 383 | 模型以普通文本结束：还有 396 个 unresolved 单元，尚未完成 finish。stopReason=stop；没有 API 失败。 |
| 17:39:56.945 | 386–390 | 宿主启动 hostAttempt=1 的新会话；提示中明确列出 p01–p11 为当前 pending 草案，要求保留。 |
| 17:40:30.102–.905 | 404/405 | 新会话把 p01 用于新页 `acctpg-ffe9808a9d32f912`，状态改为 duplicate-description。存储拒绝同 ID 不同内容；SOP 分类为 unexpected-failure、retryable=true。 |
| 17:40:42–17:41:01 | 413–423 | 模型刷新 unresolved 页；返回的新 token 对应原失败页的相同 20 单元。 |
| 17:41:14.097 | 431/432 | 新提案 p12 成功覆盖这 20 单元，使用 background-only；p01 失败仍未解决。 |
| 17:49:42.680 | 792 | discovery 返回 total=0、units=[]。 |
| 17:49:55.004 | 800/801 | finish 因 p01 持久失败拒绝；指引要求相同 tool、相同 proposal_id 修正一次。 |
| 17:50:14.209–.989 | 809/810 | p01 改用 exact decisions，只有原成功草案前 4 个单元。与原 20 单元草案不同，再次冲突。 |
| 17:50:29.350 | 827 | 两个不同失败输入的阈值满足，外层宿主停止运行；无第 54 批检查点。 |

这里不是原 p01 第一次调用就失败：journal 顺序为 running → succeeded → running → failed → running → failed。判断事故时必须保留这段成功前史。

## 根因与责任边界

### 1. 直接触发：恢复会话错误复用已占用 ID

恢复提示实际包含 `<current-batch-active-proposals>`，明确列出 p01–p11；因此不能说宿主完全没有告知既有草案。新会话第一次 accounting 调用仍选择 p01，是可观察的模型协议违例。

提示对恢复的说明已经存在，但 `account_source_units` 的工具级 guidelines 没有提供宿主分配的新提案身份。新页 token 由宿主提供，proposal_id 仍由模型维护。恢复会话重置了交互上下文，人工式 p01、p02 编号容易被重新开始；这是与证据一致的工程风险解释，不是已证明的模型心理原因。

### 2. 存储拒绝覆盖正确，错误分类不完整

`src/compiler/source-accounting.ts:321` 的 `stageProposal` 对 pending 草案比较规范化 identity；不同内容直接拒绝，没有覆盖原文件。identity 包括 decisions 和 generatedBy，不包括 createdAt（约第 690 行）。两次失败都有实质不同的 decisions，不能解释为单纯时间戳变化。

`src/agent/tool-recovery.ts:440` 的 duplicate 匹配覆盖了 “already used”等文本，但没有覆盖实际的 “already exists with different content”。真实返回因此落入 unexpected-failure，未给出准确的重复身份发现/核查路径。

仅扩大正则仍不足以修好事故，因为通用 duplicate SOP 的“保留已有草案并继续/finish”，与已经写入的失败义务并不相容。

### 3. 持久义务身份与不可变草案身份耦合

`src/compiler/proposal-obligations.ts` 以 `[tool, proposalId]` 管理义务。`unresolved()` 看该身份最后状态；`requiringHostReview()` 统计上次成功/unsupported 之后的不同失败 inputHash；两种失败即停止模型恢复。

这一设计能防止改 ID、无关成功或重启抹掉真实失败，但当前无法细分“已有成功草案 A”和“误用 A 的 ID 提交新工作 B”。

具体冲突是：

- 存储：旧 ID 不可变，新内容必须使用新 ID。
- finish/义务：失败必须由相同 ID 的修正解决；别的 ID 成功不算。
- p12 成功：业务覆盖推进，但没有经过验证的 p01→p12 失败工作关联。

不应通过降低熔断阈值、删除义务或允许覆盖 pending 草案来消除这个冲突。

### 4. finish 的统一修正指引诱发无效重试

seq 801 同一错误消息里同时出现 “use a new proposal id” 和 “same exact proposal_id”。这不是抽象推测，而是模型实际收到的文本。

模型随后提交 p01 原成功草案的前 4 个单元。它们不是第一次失败页的 20 单元，也不是原 p01 的完整 20 单元；因此这次尝试既没有恢复原失败工作，也不是合法幂等重放。存储再次拒绝是预期行为。

### 5. 宿主覆盖复核的新盲区：失败身份遮蔽成功版本

第一次失败涉及集合 B（20 单元），第二次失败涉及集合 A 的前 4 单元。二者不重叠，完整消解须证明 24 个单元。

- 集合 B 的 20 个单元：p12 已完整覆盖。
- A 的 4 个单元：原 p01 成功草案仍完整保存，但 p01 同时有后来的失败义务。

`src/compiler/accounting-review.ts` 建立 `activeFailures` 集合，并在扫描 accounting 草案时按 proposal ID 整体跳过。这样做防止失败草案自证成功，但也把 p01 的早先有效版本排除。

只读执行当前 `compiler-obligations review-accounting` 的实际结果为退出码 1：以下 4 个单元缺少可被该证明器接受的 current-batch coverage：

```text
unit-sentence-be24b1f0864a83f61f14a65d
unit-sentence-95ea3faf931b775125dc4bb2
unit-sentence-ed09c39868f65a8150d77365
unit-sentence-ccb8738f573e4a6449df6578
```

因此，不能建议用户直接运行现有命令加 `--apply`；预览已经证明当前现场不满足它的证明规则。

## 与前一事故的关系

第 53 批旧事故是“发现页之后语义覆盖变化，使旧页失效”，并伴随宿主错误开启禁止的恢复会话。第 54 批的直接错误是同 ID 不同内容；没有 evidence 支持把它归为相同的 coverage-changed 事故。

已有修复确实生效：第 53 批完成了检查点；第 54 批达到两种失败输入后没有再开启新的恢复会话。新事故暴露的是重复身份与覆盖证明之间的契约空隙。

## 影响与未证明事项

没有观察到 p01 原草案被覆盖；失败页 token 没有被失败提交消费；第 54 批没有被错误 checkpoint，世界真值没有因本次 accounting 失败直接提交。

本次 run 记录 83 次 LLM 请求、110 次工具调用、14,238,082 totalTokens，其中 13,641,728 为 cacheRead；这是包含第 53 批恢复和第 54 批两个会话的整轮用量，不是此次错误单独成本。manifest 的 cost 为 0.40210936，未核验其计费口径，不等同真实账单。

大量 background-only 和“没有新机制”的结论只是模型提出的分类。本报告没有逐句认证 616 个 accounting 决定，不能据此断言本切片不存在可执行机制，也不能把修复义务视为语义验收通过。

## 建议修复方案及验收

优先实施隔离 fixture 上的协议修复，再处理真实现场。

| 优先级 | 改动 | 必须通过的验收 |
| --- | --- | --- |
| P0 | 为同 ID 不同内容提供结构化冲突类型，绑定既有草案内容哈希和失败输入；准确返回可用的同作用域发现/读取工具。 | 原错误保持 isError；不输出相互冲突的同 ID/新 ID SOP。 |
| P0 | 区分成功草案身份与失败调用/工作身份，提供受限、可审计的 replacement/settlement 关联。 | 新 ID 的无关成功仍不能清除失败；仅经完整单元证明的后继可消解对应工作。 |
| P0 | 扩展宿主证明以核验“同 ID 的较早成功不可变版本”，而非简单放开 activeFailures 排除。 | 必须验证原成功输入、成功返回、页消费、完整展开内容、源/批次、当前文件哈希；所有 24 单元有证明，依赖撤回后重新阻塞。 |
| P1 | 由宿主发放或建议未占用的 submission 身份；恢复提示同时展示已占用 ID、剩余工作和下一合法操作。 | 恢复会话不会从 p01 重新编号；碰撞不能绕过存储不可变性。 |
| P1 | finish 根据具体失败类型生成恢复指引。 | 已有成功身份被误用时，不再要求模型用截断输入“修复”该草案。 |
| P1 | 补齐跨层事故回归。 | 覆盖“成功 A→同 ID 新页 B 失败→新 ID B 成功→A 子集重试失败→宿主证明”全过程。 |

真实现场恢复应在持有 compiler lock 的宿主路径执行，保留原始失败与成功草案。优先形成绑定版本的证明；若暂时没有合适的 settlement 类型，应补充窄宿主流程，不能泛用 unsupported 掩盖尚未证明的工作。

通过证明后，正常恢复第 54 批，重查当前 unresolved、审查可执行语义、通过 finish receipt 再 checkpoint，然后继续第 55–69 批和两个 boundary 批。全书 candidate/closure 验收另行进行。

## 核查方法与附件

- 只读 `status --json`，快照见 [compiler-status.json](compiler-status.json)。
- 经项目 `TraceStore.peekBlob` 校验此 run 的全部 220 个 tool input/result blob 引用；校验的是存储封装里的规范化 content，与直接哈希外层 JSON 文件不同。
- 对照 p01 journal、原始 pending 草案、两个页回执和 p12 单元集合；关键审计摘录见 [audit-excerpts.json](audit-excerpts.json)。
- 实际执行不带 `--apply` 的宿主覆盖证明预览，确认 4 单元阻塞。
- 现有针对性测试通过：`proposal-obligations`、`accounting-coverage-review`、`tool-recovery`、`compiler-host-review-recovery` 共 4 文件、37 项。它们通过并不表示已覆盖本报告的完整重复身份事故链；本轮未新增或声称完成该回归。
- 此次工作仅分析、运行针对性现有测试并新增报告附件；没有修改编译代码、apply settlement、撤回草案、重启真实编译或写入检查点。

原始状态目录：`/root/.novel-harness/workspaces/v1/novel-world-harness-96fd81aa9a7d/`。原始审计路径：`observability/v1/runs/2026-09/run-mtsy5p5e-a40498d2-2f9c-406c-8834-c49c6e81b652/events.jsonl`。
