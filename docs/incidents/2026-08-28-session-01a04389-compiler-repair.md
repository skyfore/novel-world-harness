# Harness 会话 01a04389 编译事故修复报告

日期：2026-08-28  
会话：`01a04389-5554-75a3-9f12-fb4f9ecda6e0`  
小说源：`a28585b1cf867f3e3a16`（《龙族1·火之晨曦》，798095 bytes）

## 结论

会话产生的确定性状态损坏已经修复：悬空事件解析、被批次图错误连带拒绝的事件/参与/关系/空间记录、诺玛系统归因、缺失 opening world、拒绝原因缺失和一个误标为 narrator 的路明非归因均已通过新修订恢复。旧提案及旧拒绝历史没有被覆盖。

最终恢复 dry-run 为 0 个待修复工件、0 个缺失规范事件、0 个缺失身份解析、0 个待补拒绝诊断。最终审计中 pending=0、无效实体/事件解析=0、事件与空间关系校验错误=0、证据引用/断言错误=0、因果缺父/成环/时间倒退均为 0。

小说仍不是 publication-ready。剩余问题是原始全书解析的语义覆盖不足，不能通过程序自动虚构事实来消除，详见“未伪造修复的覆盖缺口”。

## 原始证据与故障边界

- 原始会话日志：`/root/.novel-harness/sessions/novel-world-harness-96fd81aa9a7d/2026-08-27T14-04-28-884Z_01a04389-5554-75a3-9f12-fb4f9ecda6e0.jsonl`，共 6269 行、约 17.57 MB。
- 日志第 6261 行再次调用 `finish_compiler_batch`，第 6262 行仍只报告一条 claim 投影错误；第 6267 行第三次 finish；第 6268 行返回 `compilerBatchFinished:true`，证明旧 finish 握手能够在未运行实际 canonical commit 图验证时宣布批次完成。
- 小说源注册记录：`/root/.novel-harness/workspaces/v1/novel-world-harness-96fd81aa9a7d/sources/a28585b1cf867f3e3a16.json`，其中记录标题、798095 bytes 和完整 SHA-256。
- 修复前完整备份：`/tmp/nwh-pre-repair-backup.FizNwq`（80 MB）。后续两次尾项修复前备份：`/tmp/nwh-pre-system-attribution-repair.HJwStd`、`/tmp/nwh-pre-final-attribution-repair.GhYkgX`。

## 根因与代码修复

### 1. 图候选互相污染

旧 convergence 在逐条验证之前，先把所有 pending event/spatial relations 一起加入 catalog。一个坏端点、时间倒退或环会让同批有效关系共享全图错误，导致整批连带拒绝。

修复位于 `src/compiler/validator.ts`：

- 先做 record-local 端点/字段校验；
- 独立关系按稳定顺序贪心加入 prospective catalog；
- 投射同一事件 `causalParents` 的关系按目标事件成组预验，整组通过后再提交；
- spatial relations 使用同样的隔离边界；
- `validatePendingStructure` 使用与实际提交相同的顺序和分组规则，避免 finish 预演再次产生批次污染。

回归证据：`test/compiler-validator.test.ts` 覆盖坏关系隔离、完整 causal-parent 组和反向边导致环时只拦截第二条；`test/proposal-tools.test.ts` 覆盖坏空间端点不污染有效空间边。

### 2. finish 握手没有预演真实 commit 语义

`src/compiler/proposal-tools.ts` 现在在 finish 内调用 `CompilerCommitService.validatePendingStructure`，并把每个候选的确定性代码、路径和消息纳入统一诊断。错误修复前不会提交 resolution metadata，也不会 checkpoint。

### 3. 无工具结果的调用被错误视为完成

`src/compiler/batch-outcome.ts` 现在追踪每个 compiler mutation/control call 的 tool result。只有相同 proposal ID 的已验证重放、成功撤回或后续成功 finish 才能消解 unmatched call；否则批次保持可恢复失败，不能 checkpoint。

回归证据：`test/compiler-batches.test.ts` 覆盖“一个 proposal call 无结果但随后 finish 成功”仍失败，以及同 ID 成功重放后才恢复。

### 4. 通信系统被强制当作 character

旧 attribution schema 不允许 system holder，知识源验证也只允许 character，导致诺玛（规范实体 kind=`other`）的归因和引用它们的事件失败。

修复位于：

- `src/world/model.ts`：新增 `holderKind=system`；
- `src/world/knowledge-semantics.ts`：统一 character/communication-system 来源语义；
- `src/compiler/validator.ts`、`src/compiler/possibility-commit.ts`、`src/world/engine.ts`、`src/world/actors.ts`：编译、可能性、运行时和 actor locality 采用同一规则；
- `src/compiler/batches.ts`：编译提示明确要求只有显式建模的通信系统才能使用 system holder。

恢复时还检查 quotation → speaker mention → current identity resolution：只有说话者闭合到同一规范实体才转换。五条独立诺玛归因及四条事件依赖归因转换为 system；`atr10_23v` 的引语 `qu10_lmf_quiet` 说话者已解析为 `lumingfei`，因此从 narrator 改为 character，而不是猜测 holder。

### 5. 拒绝原因丢失与悬空 resolution

`ProposalStore.reject` 现在先持久化不可变 rejection report，再移动 proposal，避免出现“已拒绝但无原因”。convergence、CLI 手工拒绝、withdraw、批次失败及 reparse invalidation 都写入明确代码。

历史 680 条无诊断拒绝无法诚实重建原始原因，因此每条报告明确记录 `LEGACY_REJECTION_DIAGNOSTIC_UNAVAILABLE`，并把当前重验结果标为 `LEGACY_CURRENT_*`，两者不混淆。示例：

- `/root/.novel-harness/workspaces/v1/novel-world-harness-96fd81aa9a7d/world/v1/proposals/rejection-reports/at_eva_help.json`
- `/root/.novel-harness/workspaces/v1/novel-world-harness-96fd81aa9a7d/world/v1/proposals/rejection-reports/elr8_01.json`

`quarantineInvalidResolutionBindings` 会在 convergence 后移除引用未存活规范实体/事件的 current ref，同时保留 accepted proposal 和 immutable revision 历史并将 proposal 移入 rejected。

## 数据修复结果

所有恢复都通过 `src/compiler/legacy-recovery.ts` 生成稳定的新 proposal ID；未改写 680 个旧 rejected envelopes。

| 工件 | 修复前 | 修复后 | 净增 |
|---|---:|---:|---:|
| accepted proposals | 1467 | 1823 | 356 |
| attributions | 188 | 198 | 10 |
| canonical events | 118 | 139 | 21 |
| event participations | 455 | 600 | 145 |
| event relations | 0 | 149 | 149 |
| spatial relations | 0 | 30 | 30 |
| initial world | false | true | 1 |

356 个新修订的精确构成：10 attribution + 21 event + 145 participation + 149 event relation + 30 spatial relation + 1 initial world。

opening world 使用源文本第 48–68 行、bytes 5317–8975，quote hash `c3d9af64f640c1695cbaaa92126f6f6308e30662d61d8a3827d482f48b495101`。它只建立开场已成立的路明非 alive/location/plan，checkpoint 位于 `ev_letter` 之前；证据及四条字段级 assertion 保存在：

- `/root/.novel-harness/workspaces/v1/novel-world-harness-96fd81aa9a7d/world/v1/proposals/accepted/legacy-repair-initial-world-7df729dc81f871a2.json`
- `/root/.novel-harness/workspaces/v1/novel-world-harness-96fd81aa9a7d/world/v1/canon/initial-world/current.json`

没有恢复两条仍确定无效的旧关系：

- `elr8_01`：`RELATION_LEGACY_CAUSAL_MISMATCH` + `TEMPORAL_CAUSAL_REGRESSION`；
- `er9_13_prop`：相同两类错误。

此外，19 个未表示的旧 participation logical IDs 均仍有 duplicate、legacy participant mismatch 或 presence projection mismatch；当前 139/139 events 已有 typed participation，600/600 legacy participant slots 已被合法 typed slots 覆盖，因此恢复这些草稿反而会重新制造不一致。最终检查不存在“当前孤立有效但没有 accepted 同逻辑修订”的旧拒绝工件。

## 最终审计快照

执行命令：

```text
pnpm dev audit --root /root/workplace/novel-world-harness --source a28585b1cf867f3e3a16
```

关键结果：

- proposals：pending 0，accepted 1823，rejected 680；680/680 rejection reports 有诊断；
- evidence：1823 artifacts、1831 references，invalidReferences 0；1164 assertions，invalidAssertions 0；
- resolutions：532 entity mentions 中 invalid 0、missing 0、unresolved 5；155 event mentions 中 invalid 0、missing 0、unresolved 13，125 个 major mentions 中 119 已完成；
- event semantics：139/139 events 有 typed participation，600/600 participant slots 对齐；149 relations 中 53 temporal、58 causal、38 narrative-continuation，relation validation issues 0；
- epistemic：234 propositions、198 attributions、198 quotation-linked attributions、109 semantic knowledge operations，invalid traces 0；
- consistency：causalGraphValid=true，missing parents 0，cycles 0，temporal regressions 0；
- recovery idempotency：artifacts 0，missing events 0，unresolved missing mentions 0，diagnostics to backfill 0。

## 未伪造修复的覆盖缺口

这些是原解析质量不足，不是本次状态损坏：

- 10957 个 base units 全部已记账，unaccounted=0，但 9683 个句子仍标为 unresolved；它们的审计原因是所在 segment 有 proposal、但该句没有 exact assertion 或 annotation。把它们批量改成 background-only 会伪造审阅结论。
- 实体解析仍有 5 个明确 unresolved；事件解析仍有 13 个明确 unresolved，其中 6 个是 major。它们现在是诚实的不确定性，不应猜实体或事件。
- 因果图合法但不具备小说级可导航性：89 个 causal components、最大组件 15、91 个 unconditional roots。新增无证据因果边会改变小说事实。
- character development coverage=20%（要求至少 50%）；later embodied character entry checkpoint coverage=34.88%（要求 100%）。补足它们需要逐段证据判断，而不是从人物名或后续情节反推开场状态。
- 因此 readiness 仍为 accounting/resolution/semantic/runtime/publication=`not-ready`，evidence=`unknown`。结构正确不等于整本小说已经语义完备。

正确的下一阶段是 evidence-backed whole-book semantic reparse/reconciliation，并逐条解决上述 unresolved units、major event mentions、角色发展与 entry checkpoint；不能把本次确定性迁移冒充为完整重解析。

## 验证

- `pnpm test`：111 个测试文件、643 个测试全部通过；
- `pnpm run check`：TypeScript 检查通过；
- `git diff --check`：通过；
- 最终 audit 与 recovery dry-run：无结构/证据/解析悬空错误，恢复幂等。
