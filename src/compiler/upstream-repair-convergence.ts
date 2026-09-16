import { WorkspaceStore } from "../storage/workspace-store.js";
import { ProposalStore } from "../world/canonical-model.js";
import { UpstreamRepairLedger } from "./upstream-repair-ledger.js";
import { CompilerFinishReceipts } from "./finish-receipts.js";
import { SourceAnnotationStore } from "./annotations.js";
import { EntityResolutionStore } from "./entity-resolution.js";
import { EventResolutionStore } from "./event-resolution.js";
import { SourceAccountingStore } from "./source-accounting.js";
import { verifyUpstreamRepairPlan, upstreamRepairHostError } from "./upstream-repair-preflight.js";

/** Reads actual post-commit state. A caller cannot supply revision hashes or success claims. */
export async function verifyUpstreamRepairConvergence(root: string, sourceId: string, planHash: string) {
  const current = (await new UpstreamRepairLedger(root, sourceId).inspect()).plans.find(item => item.plan.planHash === planHash);
  if (!current?.finishIntent || !["finished", "converged", "evaluated"].includes(current.state)) throw upstreamRepairHostError("Convergence requires the original finished repair");
  const receipts = new CompilerFinishReceipts(root, sourceId, current.plan.batchId), receipt = await receipts.read();
  if (!receipt || receipt.state !== "completed") throw upstreamRepairHostError("Convergence requires its original completed active receipt");
  await receipts.verify(receipt);
  const pending = [
    ...await new ProposalStore(root).list("pending", sourceId),
    ...await new SourceAnnotationStore(root).listProposals(sourceId, "pending"),
    ...await new EntityResolutionStore(root).listProposals(sourceId, "pending"),
    ...await new EventResolutionStore(root).listProposals(sourceId, "pending"),
    ...await new SourceAccountingStore(root).listProposals(sourceId, "pending"),
  ];
  if (pending.length) throw new Error("UPSTREAM_REPAIR_CONVERGENCE_PENDING: preserve pending source work; finish, repair or quarantine it through its existing host workflow before convergence observation. Do not rerun the upstream model or reset its plan.");
  const outputs = new Map(current.finishIntent.proposals.map(item => [`${item.artifactKind}:${item.artifactId}`, item.payloadHash]));
  const verified = await verifyUpstreamRepairPlan(root, current.plan, outputs);
  const refs = new Map(current.plan.baselineRefs.map(ref => [`${ref.kind}:${ref.id}`, { kind: ref.kind, id: ref.id }]));
  for (const proposal of current.finishIntent.proposals) refs.set(`${proposal.artifactKind}:${proposal.artifactId}`, { kind: proposal.artifactKind, id: proposal.artifactId });
  const activeRevisions = [...refs].sort(([a], [b]) => a.localeCompare(b)).map(([key, ref]) => ({ ...ref, revisionHash: verified.activeRevisions.get(key)! }));
  return { receiptFingerprint: receipt.fingerprint, activeRevisions };
}

/** Invoked after deterministic convergence, including an empty retry following interruption. */
export async function observeUpstreamRepairConvergence(root: string, sourceId?: string): Promise<string[]> {
  const workspace = WorkspaceStore.openReadOnly(root), sources = sourceId ? [await workspace.getSource(sourceId)] : await workspace.listSources();
  const issues: string[] = [];
  for (const source of sources) {
    if (!source) throw upstreamRepairHostError("Convergence source is not registered");
    const ledger = new UpstreamRepairLedger(root, source.id);
    for (const current of (await ledger.inspect()).plans.filter(item => ["finished", "converged", "evaluated"].includes(item.state))) {
      try { await ledger.recordConverged(current.plan.planHash); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        issues.push(`${source.id}/${current.plan.planHash}: ${message}`);
        // Pending downstream work and interrupted I/O do not revoke the frozen plan.
        // Deterministic receipt/authority failures do, preserving the original reason.
        if (message.startsWith("UPSTREAM_REPAIR_REQUIRES_HOST_REVIEW:") || message.startsWith("Compiler finish requires host review:")) await ledger.stop(current.plan.planHash, message);
      }
    }
  }
  return issues;
}
