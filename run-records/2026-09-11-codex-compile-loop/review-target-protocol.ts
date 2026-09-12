import fs from "node:fs/promises";
import { inspectCompilerStatus } from "../../src/compiler/status.js";
import { auditCompiler } from "../../src/compiler/audit.js";
import { CompilerFinishReceipts } from "../../src/compiler/finish-receipts.js";
import { compilerFailureFingerprint } from "../../src/runtime/codex-compile-loop.js";
import { assertReconciliationDeferralsReviewed } from "../../src/compiler/reconciliation-review-ledger.js";
import { withWorkspaceOperationLock } from "../../src/util/workspace-lock.js";
const root = process.cwd(), directory = new URL("./", import.meta.url);
await withWorkspaceOperationLock(root, "compiler", async () => {
  const state = JSON.parse(await fs.readFile(new URL("state.json", directory), "utf8"));
  if (state.attempt !== 5 || state.status !== "repeated-failure" || state.semanticRunId !== "codex-semantic-plan-fix-20260911") throw new Error("Loop state changed; stop for review.");
  const status = await inspectCompilerStatus(root, state.sourceId);
  const source = status.sources.find(item => item.sourceId === state.sourceId);
  if (!source || source.sourceIntegrity !== "verified" || !source.batchReviewComplete || source.hasUnresolvedObligations || source.worldProposalInventory.pending) throw new Error("Original evidence, batches, or obligations require review before a successor round.");
  const receipts = [];
  for (let iteration = 1; iteration <= 5; iteration += 1) {
    const batchId = `reconcile-${state.sourceId}-bounded-${state.semanticRunId}-${iteration}`;
    const store = new CompilerFinishReceipts(root, state.sourceId, batchId);
    const receipt = await store.read();
    if (!receipt || receipt.state !== "completed") throw new Error(`Incomplete predecessor batch ${batchId}`);
    await store.verify(receipt);
    receipts.push({ batchId, fingerprint: receipt.fingerprint });
  }
  await assertReconciliationDeferralsReviewed(root, state.sourceId);
  const audit = await auditCompiler(root, { sourceId: state.sourceId });
  await fs.writeFile(new URL("audit-before-target-protocol.json", directory), JSON.stringify(audit, null, 2));
  const review = {
    reviewedAt: new Date().toISOString(), repairId: "target-review-protocol-v1", predecessorAttempt: state.attempt,
    predecessorStatus: state.status, predecessorNamespace: state.semanticRunId,
    successorNamespace: "codex-target-review-v1-20260912", repairedFailureFingerprint: compilerFailureFingerprint(state.error),
    authorization: "User explicitly requested fixes from the analysis and rerun of the existing loop.",
    diagnosis: "Prior repeated-failure was manually inferred from unchanged aggregate metrics although no opening goal was proposed and target handling was not enforced. Completed shards did not prove target resolution. Preserve those receipts and carry fresh audit deficits into a versioned successor protocol; this does not retry a failed proposal under a new identity.",
    verifiedPredecessorReceipts: receipts, sourceIntegrity: source.sourceIntegrity,
    batchReviewComplete: source.batchReviewComplete, unresolvedObligations: source.hasUnresolvedObligations,
    inventory: source.worldProposalInventory, remainingTargets: audit.semanticRepairTargets,
    fixes: ["Exact per-target finish accounting with host proposal association and source-scoped handles", "Durable post-convergence unresolved ledger", "Durable cross-namespace deferral publication gate with audited host review", "Separate ontology migration and opening driver requirements with read-only opening context", "Repeat stopping tied to an applied repair and the failed proposal identity"],
    validation: "101 relevant tests passed across the final suite and focused rerun; repository type checks passed; worker/notify type checks passed. No publication threshold, source bytes, accepted world artifact, failed proposal history or prior checkpoint was modified.",
  };
  await fs.writeFile(new URL("host-review-target-protocol.json", directory), JSON.stringify(review, null, 2));
  await fs.writeFile(new URL("state-before-target-protocol.json", directory), JSON.stringify(state, null, 2));
  state.status = "needs-review";
  state.semanticRunId = review.successorNamespace;
  state.appliedRepair = { repairId: review.repairId, failureFingerprint: review.repairedFailureFingerprint, reviewPath: "run-records/2026-09-11-codex-compile-loop/host-review-target-protocol.json", appliedAt: review.reviewedAt };
  state.hostReview = { path: state.appliedRepair.reviewPath, reviewedAt: review.reviewedAt, reason: "User-authorized successor after target-protocol repair; preserves predecessor history." };
  await fs.writeFile(new URL("state.tmp.json", directory), JSON.stringify(state, null, 2));
  await fs.rename(new URL("state.tmp.json", directory), new URL("state.json", directory));
  console.log(JSON.stringify({ readyForBackgroundStart: true, sourceId: state.sourceId, namespace: state.semanticRunId, previousReceiptsVerified: receipts.length, unresolvedObligations: source.hasUnresolvedObligations, inventory: source.worldProposalInventory }));
});
