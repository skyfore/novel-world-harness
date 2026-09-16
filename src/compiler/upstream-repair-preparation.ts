import { UpstreamRepairLedger } from "./upstream-repair-ledger.js";
import { compilerFinishInputSchema } from "./finish-input.js";
import { stageUpstreamRepairPlan } from "./upstream-repair-scheduler.js";
import { prepareUpstreamRepairFinish, executeUpstreamRepairFinish } from "./upstream-repair-finish.js";
import { observeUpstreamRepairConvergence } from "./upstream-repair-convergence.js";
import { upstreamRepairHostError } from "./upstream-repair-preflight.js";
import { contentHash } from "../world/canonical.js";
import type { UpstreamRepairModelOptions } from "./pi-upstream-repair.js";

/** Compiler-lock-owned preparation phase. Never implicitly creates or authorizes a plan. */
export async function prepareAuthorizedUpstreamRepair(root: string, sourceId: string, planHash: string,
  rawFinish: unknown, options: UpstreamRepairModelOptions = {}, stagePlan: typeof stageUpstreamRepairPlan = stageUpstreamRepairPlan) {
  options.signal?.throwIfAborted();
  const ledger = new UpstreamRepairLedger(root, sourceId);
  const current = (await ledger.inspect()).plans.find(item => item.plan.planHash === planHash);
  if (!current || !["authorized", "staging", "finish-frozen", "finished", "converged", "evaluated"].includes(current.state)) throw upstreamRepairHostError("Preparation requires an existing authorized repair; inspect-upstream plans[].plan.planHash. Do not reopen a stopped plan or infer authorization from a diagnostic");
  const input = rawFinish === undefined ? undefined : compilerFinishInputSchema.parse(rawFinish);
  if (current.finishIntent) {
    if (input && contentHash(input) !== contentHash(current.finishIntent.input)) throw upstreamRepairHostError("Preparation cannot replace the original frozen finish review; resume with no replacement input");
  } else {
    if (!input || input.outcome !== "complete" || input.target_reviews !== undefined
      || contentHash(input.reviewed_segments.map(item => item.segment_id).sort()) !== contentHash(current.plan.sourceScope.segmentIds.slice().sort())) throw upstreamRepairHostError("Preparation requires an exact complete host finish review before invoking any model; preserve the original source segment scope and do not invent review completion");
    await stagePlan(root, sourceId, planHash, options);
    options.signal?.throwIfAborted();
    await prepareUpstreamRepairFinish(root, sourceId, planHash, input);
  }
  options.signal?.throwIfAborted();
  const receipt = await executeUpstreamRepairFinish(root, sourceId, planHash);
  const issues = await observeUpstreamRepairConvergence(root, sourceId);
  const state = (await ledger.inspect()).plans.find(item => item.plan.planHash === planHash)!.state;
  if (state === "needs-host-review") throw upstreamRepairHostError(`Preparation stopped after actual revision observation: ${issues.join("; ")}`);
  return { planHash, receiptFingerprint: receipt.fingerprint, state, issues };
}
