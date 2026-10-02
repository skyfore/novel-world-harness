import crypto from "node:crypto";
import { RoleReviewWorkStore, roleWorkStop } from "../compiler/role-review-work.js";
import { runBoundedRoleReview } from "./role-review-bounded.js";
import { type CompileCommandOptions } from "../commands/compile.js";
import { loadCurrentRoleRoster, roleRosterEntryInputSchema } from "../compiler/role-roster-tools.js";
import { validateRoleRoster } from "../compiler/role-roster.js";
import { registerReviewedCoreRoles } from "../compiler/core-role-requirement-service.js";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";
import { CompilerProposalObligations } from "../compiler/proposal-obligations.js";

export async function reviewNovelRoles(options: Omit<CompileCommandOptions, "prompt" | "compilerBatchId"> & { sourceId: string }, review: (options: CompileCommandOptions & { sourceId: string; compilerBatchId: string }) => Promise<void> = runBoundedRoleReview): Promise<void> {
  if (options.acquireLock !== false) {
    return withWorkspaceOperationLock(options.root, "compiler", () =>
      reviewNovelRoles({ ...options, acquireLock: false }, review));
  }
  const { CompilerFinishReceipts } = await import("../compiler/finish-receipts.js");
  const { recoverCompilerFinish } = await import("../compiler/finish-recovery.js");
  for (const receipt of await CompilerFinishReceipts.list(options.root, options.sourceId)) {
    if (receipt.state === "prepared" && receipt.identity.batchId.startsWith(`role-roster-${options.sourceId}-`)) {
      options.signal?.throwIfAborted();
      await recoverCompilerFinish(options.root, options.sourceId, receipt.identity.batchId);
    }
  }
  let stagedBatchId: string | undefined;
  for (const batchId of CompilerProposalObligations.listBatchIds(options.root, options.sourceId)) {
    if (!batchId.startsWith(`role-roster-${options.sourceId}-`)) continue;
    const journal = new CompilerProposalObligations(options.root, options.sourceId, batchId);
    const roleHistory = journal.history("propose_role_roster_review", "role-roster-review");
    const receipt = await new CompilerFinishReceipts(options.root, options.sourceId, batchId).read();
    const capturedWithoutFinish = roleHistory.at(-1)?.status === "succeeded" && receipt?.state !== "completed";
    if (journal.unresolved().length || capturedWithoutFinish) {
      throw new Error(`ROLE_REVIEW_REQUIRES_HOST_REVIEW: retained obligations in ${batchId}. Inspect compiler-obligations inspect --source ${options.sourceId} --batch ${batchId} and preserve the exact failed inputs. Recover this original scope through a supported host protocol before starting another review; do not retry in a fresh batch or reset attempt history.`);
    }
    if (receipt?.state !== "completed" && journal.latestAttempts("propose_role_roster_entry").some(attempt => attempt.status === "succeeded")) {
      if (stagedBatchId) throw new Error("Multiple unfinished role-review draft scopes exist. Stop for host review; never merge independent reviews or rotate IDs.");
      stagedBatchId = batchId;
    }
  }
  for (const plan of await RoleReviewWorkStore.plans(options.root, options.sourceId)) {
    const receipt = await new CompilerFinishReceipts(options.root, options.sourceId, plan.batchId).read();
    if (receipt?.state === "completed") continue;
    if (stagedBatchId && stagedBatchId !== plan.batchId) throw roleWorkStop("multiple unfinished review scopes");
    stagedBatchId = plan.batchId;
  }
  let { roster } = await loadCurrentRoleRoster(options.root, options.sourceId);
  if (stagedBatchId) {
    const drafts = new CompilerProposalObligations(options.root, options.sourceId, stagedBatchId).latestAttempts("propose_role_roster_entry");
    for (const draft of drafts.filter(attempt => attempt.status === "succeeded")) {
      const input = roleRosterEntryInputSchema.parse(draft.input);
      if (input.subjectHash !== roster.subjectHash || input.reviewRevisionId !== roster.reviewRevisionId
        || !roster.candidates.some(candidate => candidate.id === input.entry.candidateId)) {
        throw new Error(`ROLE_REVIEW_REQUIRES_HOST_REVIEW: staged entries in ${stagedBatchId} belong to changed source or review identity. Preserve drafts and stop; do not start a new batch or change their IDs.`);
      }
    }
  }
  const { captureReconciliationObligations } = await import("../compiler/reconciliation-review-ledger.js");
  const { roleReviewFinishIssues } = await import("../compiler/role-review-finish.js");
  const finishIssues = roleReviewFinishIssues(await captureReconciliationObligations(options.root, options.sourceId), roster, options.sourceId);
  if (finishIssues.length) throw new Error(`ROLE_REVIEW_FINISH_REQUIRES_HOST_REVIEW: ${finishIssues.join("; ")}. Preserve missing or retired receipt evidence and stop model retries. Inspect nwh requirements inspect --source ${options.sourceId}; a new independent review requires an explicit begin-core-role-review decision with the exact savedRosterHash and predecessor, never a reset.`);
  while (roster.reviews.length < 2) {
    options.signal?.throwIfAborted();
    const subjectHash = roster.subjectHash, reviewRevisionId = roster.reviewRevisionId, reviewCount = roster.reviews.length;
    await review({ ...options, compilerBatchId: stagedBatchId ?? `role-roster-${options.sourceId}-${crypto.randomUUID()}` });
    stagedBatchId = undefined;
    ({ roster } = await loadCurrentRoleRoster(options.root, options.sourceId));
    if (roster.subjectHash !== subjectHash || roster.reviewRevisionId !== reviewRevisionId || roster.reviews.length !== reviewCount + 1) throw new Error("ROSTER_REVIEW_NOT_COMMITTED: the review did not finish against unchanged source identity. Stop and inspect compiler diagnostics; do not repeat unchanged work.");
  }
  await registerReviewedCoreRoles(options.root, await loadCurrentRoleRoster(options.root, options.sourceId));
  const issues = validateRoleRoster(roster);
  if (issues.length) throw new Error(`WORLD_CLOSURE_BLOCKED: ${issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}`);
}
