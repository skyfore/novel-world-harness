import fs from "node:fs/promises";
import path from "node:path";
import { RuntimeHooks, withRuntimeHooks } from "../../src/runtime/hooks.js";
import { compilerFailureFingerprint, compilerFailureRepeatedAfterRepair, isCompilerUsageLimit, nextCompilerReset } from "../../src/runtime/codex-compile-loop.js";
import { compileCommand } from "../../src/commands/compile.js";
import { prepareAllCommand } from "../../src/commands/prepare-all.js";
import { inspectCompilerStatus } from "../../src/compiler/status.js";
import { inspectPreparation } from "../../src/workflow/prepare.js";
import { buildWorldReconciliationPrompt } from "../../src/compiler/reconcile-world.js";
import { CompilerProposalObligations } from "../../src/compiler/proposal-obligations.js";
import { withWorkspaceOperationLock } from "../../src/util/workspace-lock.js";
import { SOURCE_ANNOTATION_PROPOSAL_TOOL_NAMES, ENTITY_RESOLUTION_PROPOSAL_TOOL_NAMES, EVENT_RESOLUTION_PROPOSAL_TOOL_NAMES, SOURCE_ACCOUNTING_TOOL_NAMES } from "../../src/compiler/proposal-tools.js";
const directory = new URL("./", import.meta.url), stateFile = new URL("state.json", directory);
const root = process.cwd(), sourceId = "a28585b1cf867f3e3a16", threadId = "01a0912b-5872-75b0-a118-813e3e32d2be";
let previous: Record<string, any> = {};
try { previous = JSON.parse(await fs.readFile(stateFile, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
if (["completed", "repeated-failure"].includes(previous.status)) throw new Error("Loop already stopped; do not restart automatically.");
if (previous.status === "quota-wait" && Date.now() < Date.parse(previous.retryAt)) throw new Error("Quota reset has not arrived; do not retry.");
const state: Record<string, any> = { ...previous, attempt: (previous.attempt ?? 0) + 1, status: "running", startedAt: new Date().toISOString(), sourceId, threadId };
delete state.callback; delete state.retryAt; delete state.endedAt;
async function save() { await fs.writeFile(new URL("state.tmp.json", directory), JSON.stringify(state, null, 2)); await fs.rename(new URL("state.tmp.json", directory), stateFile); }
await save();
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort()); process.once("SIGINT", () => controller.abort());
let quota: string | undefined;
const hooks = new RuntimeHooks({ timeoutMs: 10_000 });
hooks.subscribe(async event => {
  await fs.appendFile(new URL("hooks.jsonl", directory), JSON.stringify({ attempt: state.attempt, ...event }) + "\n");
  if (event.type === "llm.response" && event.error && isCompilerUsageLimit(event.error.message)) {
    quota = event.error.message;
    controller.abort(new Error(quota));
  }
  if (event.type !== "command" || event.name !== "codex.compile-loop.attempt") return;
  state.endedAt = new Date().toISOString();
  if (event.status === "succeeded") {
    state.status = "completed"; delete state.error; delete state.failureFingerprint;
  } else {
    state.error = quota ?? event.error?.message ?? "Compiler failed without a diagnostic.";
    state.failureFingerprint = compilerFailureFingerprint(state.error);
    if (quota || isCompilerUsageLimit(state.error)) {
      state.status = "quota-wait";
      state.retryAt = nextCompilerReset(new Date(), new Date("2026-09-11T20:08:00Z")).toISOString();
    } else {
      state.status = compilerFailureRepeatedAfterRepair(state.failureFingerprint, previous.appliedRepair) ? "repeated-failure" : "needs-review";
    }
  }
  await save();
});
try {
  await withRuntimeHooks(hooks, () => hooks.run("command", "codex.compile-loop.attempt", { workspaceRoot: root, sourceId },
    () => withWorkspaceOperationLock(root, "compiler", async () => {
      const batchId = `reconcile-${sourceId}-bounded-v3-2`;
      if (!state.reviewedBatchFinished) {
        new CompilerProposalObligations(root, sourceId, batchId).assertModelRecoveryAllowed();
        const inspection = await inspectPreparation(root, { sourceId });
        if (!inspection.audit) throw new Error("Compilation audit is missing; preserve state for review.");
        const prompt = await buildWorldReconciliationPrompt(root, sourceId, inspection.audit, 2, { mode: "bounded" });
        await compileCommand({ root, sourceId, compilerBatchId: batchId, configPath: path.join(root, "novel-harness.yaml"), allowMissingConfig: true,
          model: "openai-codex/gpt-5.6-terra", saveSession: false, includeLocalTools: false, acquireLock: false, signal: controller.signal,
          disabledProposalTools: ["propose_state_delta", ...SOURCE_ANNOTATION_PROPOSAL_TOOL_NAMES, ...ENTITY_RESOLUTION_PROPOSAL_TOOL_NAMES, ...EVENT_RESOLUTION_PROPOSAL_TOOL_NAMES, ...SOURCE_ACCOUNTING_TOOL_NAMES],
          prompt: `${prompt}\n\nHost review of the existing failed character proposal is recorded at run-records/2026-09-11-codex-compile-loop/host-review.json. Correct the exact original proposal_id char-lumingfei-model-reconcile-f79769c4862c through normal schema/evidence validation. Do not resubmit either invalid historical input; do not move persistence between legacy maps or prepend legacy: to invent new legacy semantics. Preserve all other successful pending drafts, discovering their current identities before changing anything. Express a source-supported psychological change using the structured character ontology, with evidence and a bounded activation; do not fabricate a numeric change solely to satisfy a target. Finish the batch only after all obligations pass.` });
        state.reviewedBatchFinished = true; await save();
      }
      const selectorBatchId = `reconcile-${sourceId}-bounded-v3-4`;
      if (!state.selectorBatchFinished) {
        new CompilerProposalObligations(root, sourceId, selectorBatchId).assertModelRecoveryAllowed();
        const inspection = await inspectPreparation(root, { sourceId });
        if (!inspection.audit) throw new Error("Compilation audit is missing.");
        const prompt = await buildWorldReconciliationPrompt(root, sourceId, inspection.audit, 4, { mode: "bounded" });
        await compileCommand({ root, sourceId, compilerBatchId: selectorBatchId, configPath: path.join(root, "novel-harness.yaml"), allowMissingConfig: true,
          model: "openai-codex/gpt-5.6-terra", saveSession: false, includeLocalTools: false, acquireLock: false, signal: controller.signal,
          disabledProposalTools: ["propose_state_delta", ...SOURCE_ANNOTATION_PROPOSAL_TOOL_NAMES, ...ENTITY_RESOLUTION_PROPOSAL_TOOL_NAMES, ...EVENT_RESOLUTION_PROPOSAL_TOOL_NAMES, ...SOURCE_ACCOUNTING_TOOL_NAMES],
          prompt: `${prompt}\n\nHost review: the two failed submissions of event-bronze-city-self-destruction-reconcile-33dd4567e83b both retained an extra 着 in the /participants exact selector. The host verified the exact sentence 路明非和诺诺正在潜流中挣扎。 in segment a28585b1cf867f3e3a16-00021-0343cf842992 using the immutable-source anchor resolver. Discover/read source evidence again to confirm; use the same original proposal_id for the correction. Preserve the four other successful pending replacements, reading their exact artifacts before any alteration. Changing unrelated fields or emptying observedOutcome does not repair a quote. Revalidate any source-supported collapse effect against legal registered state fields; do not invent a field or delete an effect merely to evade validation. This review certifies a text anchor only, not the replacement event. Correct once through normal validation, then finish only when all obligations pass.` });
        state.selectorBatchFinished = true; await save();
      }
      // A reviewed fresh repair round needs its own plan and finish-receipt scope.
      // Keep this ID across restarts; never rotate it to escape unresolved obligations.
      const beforeRound = await inspectCompilerStatus(root, sourceId);
      if (beforeRound.sources.some(source => source.hasUnresolvedObligations)) throw new Error("Existing compiler obligations require same-scope recovery before starting the semantic repair round.");
      state.semanticRunId ??= "codex-semantic-plan-fix-20260911";
      await save();
      const result = await prepareAllCommand({ root, sourceId, model: "openai-codex/gpt-5.6-terra", yes: true,
        reparseRunId: state.semanticRunId,
        createBranch: false, restoreCache: false, acquireLock: false, signal: controller.signal });
      const status = await inspectCompilerStatus(root, sourceId);
      await fs.writeFile(new URL("status-after.json", directory), JSON.stringify(status, null, 2));
      const source = status.sources.find(s => s.sourceId === sourceId);
      if (!source?.batchReviewComplete || source.hasUnresolvedObligations || !["create-branch", "ready"].includes(result.stage)) {
        throw new Error(`Compilation returned incomplete: stage=${result.stage}; unresolved=${source?.hasUnresolvedObligations}.`);
      }
      state.finalStage = result.stage;
    })));
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  await fs.writeFile(new URL("status-after.json", directory), JSON.stringify(await inspectCompilerStatus(root, sourceId), null, 2)).catch(error => console.error("Status snapshot failed", error));
}
