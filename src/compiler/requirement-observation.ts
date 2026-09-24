import { WorkspaceStore } from "../storage/workspace-store.js";
import { RequirementLedger } from "./requirement-ledger.js";
import { settleSourceRequirements } from "./requirement-service.js";
import { PreparedNovelCache } from "./prepared-cache.js";
import { preparedSubjectHash } from "./certification.js";

/** Host operation under the compiler lock. Never turns a prior role result into a new success. */
export async function observeRequirementValidity(root: string, sourceId?: string): Promise<string[]> {
  const issues: string[] = [];
  const workspace = WorkspaceStore.openReadOnly(root);
  const sources = sourceId ? [await workspace.getSource(sourceId)] : await workspace.listSources();
  for (const source of sources) {
    if (!source) throw new Error("Requirement observation source is missing; stop for host storage review, do not guess or retry unchanged.");
    const { observeUpstreamRepairEvaluationValidity } = await import("./upstream-repair-evaluation.js");
    await observeUpstreamRepairEvaluationValidity(root, source.id);
    const ledger = new RequirementLedger(root, source.id);
    const history = await ledger.history();
    if (!history.length) continue;
    try {
      await settleSourceRequirements(root, source.id);
      if (history.some(record => record.payload.kind === "core-role-evaluation")) {
        let subjectHash: string;
        try {
          subjectHash = preparedSubjectHash(await new PreparedNovelCache(root).candidateSnapshot(source));
        } catch (error) {
          // Pending work or an invalid canonical projection cannot inherit old success.
          // No fabricated snapshot hash and no interruption of the quarantine protocol.
          const reason = `Current role subject cannot be frozen: ${error instanceof Error ? error.message : String(error)}. Preserve history and inspect the host state; do not replay accepted proposals or retry models unchanged.`;
          await ledger.invalidateUnobservableCoreRoleEvaluation(reason);
          issues.push(`${source.id}: ${reason}`);
          continue;
        }
        await ledger.invalidateCoreRoleEvaluation(subjectHash);
      }
    } catch (error) {
      throw new Error(`Requirement validity observation failed for ${source.id}: ${error instanceof Error ? error.message : String(error)}. Committed writes remain committed; preserve receipts and history. Stop model retries, repair the reported host state, then run nwh requirements refresh --source ${source.id}; do not replay accepted proposals or reset history.`, { cause: error });
    }
  }
  return issues;
}
