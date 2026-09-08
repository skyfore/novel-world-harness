import { CompilerFinishReceipts, finishHostError } from "./finish-receipts.js";
import { createCompilerProposalToolset } from "./proposal-tools.js";
import { CompilerProposalObligations } from "./proposal-obligations.js";

/** Host-only, compiler-lock-owned replay; never opens a model session. */
export async function recoverCompilerFinish(root: string, sourceId: string, batchId: string): Promise<boolean> {
  const store = new CompilerFinishReceipts(root, sourceId, batchId), receipt = await store.read();
  if (!receipt) return false;
  new CompilerProposalObligations(root, sourceId, batchId).assertFinishable();
  await store.verify(receipt);
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
