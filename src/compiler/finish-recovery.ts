import { CompilerFinishReceipts, finishHostError } from "./finish-receipts.js";
import { createCompilerProposalToolset } from "./proposal-tools.js";
import { CompilerProposalObligations } from "./proposal-obligations.js";
import { ProposalStore } from "../world/canonical-model.js";
import { loadCompilerArtifactRecords } from "./artifact-retrieval.js";
import { contentHash } from "../world/canonical.js";

/** Host-only, compiler-lock-owned replay; never opens a model session. */
export async function recoverCompilerFinish(root: string, sourceId: string, batchId: string): Promise<boolean> {
  const store = new CompilerFinishReceipts(root, sourceId, batchId), receipt = await store.read();
  if (!receipt) return false;
  new CompilerProposalObligations(root, sourceId, batchId).assertFinishable();
  await store.verify(receipt);
  // World-only reconciliation finishes are followed by a separate convergence
  // step. Once every dependency has been accepted, there is no pending batch
  // left to replay. Verify its still-current outputs instead of re-finishing it.
  // Other finish side effects retain their existing idempotent recovery checks.
  if (receipt.state === "completed" && receipt.identity.dependencies.length > 0
    && receipt.identity.dependencies.every(dependency => dependency.store === "world")
    && Object.keys(receipt.identity.metadata).length === 0) {
    const proposals = new ProposalStore(root);
    const accepted = [];
    for (const dependency of receipt.identity.dependencies) {
      try { accepted.push(await proposals.readEnvelope("accepted", dependency.proposalId)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw finishHostError(String(error)); }
    }
    if (accepted.length === receipt.identity.dependencies.length) {
      try {
        for (const pending of await proposals.list("pending", sourceId)) {
          const envelope = await proposals.readEnvelope("pending", pending.id);
          if ((envelope.generatedBy as { compilerBatchId?: string } | undefined)?.compilerBatchId === batchId) {
            throw new Error("completed batch has new pending proposals");
          }
        }
        const current = await loadCompilerArtifactRecords(root, sourceId);
        for (const envelope of accepted) {
          if (!current.some(record => record.status === "canonical" && record.kind === envelope.kind
            && contentHash(record.payload) === contentHash(envelope.payload))) {
            throw new Error(`accepted finish artifact ${envelope.id} is missing or has changed`);
          }
        }
        return true;
      } catch (error) { throw finishHostError(String(error)); }
    }
  }
  const toolset = createCompilerProposalToolset(root, {}, { recoverPreparedFinish: true });
  const segments = receipt.identity.input.reviewed_segments.map((review) => review.segment_id);
  await toolset.beginBatch(segments, batchId, sourceId);
  const finish = toolset.tools.find((tool) => tool.name === "finish_compiler_batch")!;
  // All original graph, source, accounting and lifecycle checks run again.
  const result = await finish.execute("host-finish-recovery", receipt.identity.input, undefined, undefined, {} as never);
  if (!(result.details as { compilerBatchFinished?: boolean } | undefined)?.compilerBatchFinished) throw finishHostError(`original finish no longer validates: ${JSON.stringify(result.content)}`);
  await store.assertCompleted();
  return true;
}
