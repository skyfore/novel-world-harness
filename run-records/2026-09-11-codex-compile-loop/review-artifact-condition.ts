import fs from "node:fs/promises";
import { CompilerProposalObligations } from "../../src/compiler/proposal-obligations.js";
import { CompilerProposalService } from "../../src/compiler/proposals.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../../src/world/state.js";
import { withWorkspaceOperationLock } from "../../src/util/workspace-lock.js";
const root = process.cwd(), sourceId = "a28585b1cf867f3e3a16";
const batchId = `reconcile-${sourceId}-bounded-codex-semantic-plan-fix-20260911-4`;
const proposalId = "event-zero-launches-torpedo-00022-reconcile-5c52d91d0334-codex-semantic-plan-fix-20260911";
await withWorkspaceOperationLock(root, "compiler", async () => {
  const journal = new CompilerProposalObligations(root, sourceId, batchId);
  const failed = journal.history("propose_canonical_event", proposalId).filter(a => a.status === "failed");
  const expected = ["80b123e2b18fabb47a9ddb648b17f64a3ca3c02691512ae29046a765f2c37b96", "0b26cdaded517831a6e97f454ee5885b8d253a5bc5176c2d239b6c18897735f4"];
  if (JSON.stringify(failed.map(a => a.inputHash)) !== JSON.stringify(expected)) throw new Error("Incident changed; fresh host review required.");
  const store = new CompilerProposalService(root).store;
  for (const status of ["pending", "accepted", "rejected"] as const) {
    if ((await store.list(status)).some(p => p.id === proposalId)) throw new Error("Proposal was staged; fresh review required.");
  }
  const registry = new StateSchemaRegistry(DEFAULT_STATE_FIELDS), field = registry.get("artifact.condition");
  const diagnoses = failed.map(attempt => {
    const input = attempt.input as { payload: { observedOutcome: { operations: Array<{field: string; value: string}> } } };
    const op = input.payload.observedOutcome.operations[0];
    if (op?.field !== "artifact.condition" || op.value !== "launched") throw new Error("Failed effect changed.");
    let diagnostic = "";
    try { registry.validateValue(field, op.value, new Map()); } catch (error) { diagnostic = String(error); }
    if (!diagnostic.toLowerCase().includes("number")) throw new Error("The state registry no longer rejects the type mismatch.");
    return { inputHash: attempt.inputHash, diagnostic, field, rejectedValue: op.value };
  });
  const reason = "Both submissions assign the lifecycle string launched to numeric artifact.condition [0,1]; the second only changes selectors and retains the invalid effect. The production state registry reproduces the type rejection, and neither submission staged a proposal. The reconciliation prompt now includes the complete authoritative state field catalog and instructions to repair the named type error. Preserve all failures and the four other successful pending proposals. Authorize one corrected proposal under the same ID through normal schema, evidence, monotonicity and finish gates. This review provides no numeric replacement, certifies no new semantics, and does not authorize inventing fields or removing established effects to evade validation. If the source-supported change is not representable, report the exact capability gap to the host.";
  await fs.writeFile(new URL("host-review-artifact-condition.json", import.meta.url), JSON.stringify({ sourceId, batchId, proposalId, reviewedAt: new Date().toISOString(), reason, diagnoses, failed }, null, 2));
  journal.reviewUnsupported("propose_canonical_event", proposalId, reason, "run-records/2026-09-11-codex-compile-loop/host-review-artifact-condition.json");
  journal.assertModelRecoveryAllowed();
  console.log("Type failure reproduced; host review recorded. No world truth or numeric replacement committed.");
});
