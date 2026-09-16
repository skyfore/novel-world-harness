import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { idSchema } from "../world/model.js";
import { RequirementLedger } from "./requirement-ledger.js";
import { RoleRosterStore } from "./role-roster.js";
import { readRoleRosterInputs } from "./role-roster-tools.js";
import { baseStructuralUnits } from "./structure.js";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { CompilerFinishReceipts } from "./finish-receipts.js";
import { assertRoleReviewRevisionEvidence } from "./role-review-revision.js";

export const beginCoreRoleReviewSchema = z.object({
  sourceId: idSchema, revisionId: idSchema, priorRosterHash: z.string().regex(/^[a-f0-9]{64}$/),
  predecessorDefinitionRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  scopeDecisionRef: z.string().trim().min(1), reason: z.string().trim().min(1),
}).strict();
/** Host-only, compiler-lock-owned. Publication precedes the recoverable pointer change. */
export async function beginCoreRoleReviewRevision(root: string, raw: z.infer<typeof beginCoreRoleReviewSchema>) {
  const input = beginCoreRoleReviewSchema.parse(raw), ledger = new RequirementLedger(root, input.sourceId);
  const revisions = await ledger.roleReviewRevisions(), existing = revisions.find(revision => revision.id === input.revisionId);
  const { saved, fresh, source, structure } = await readRoleRosterInputs(root, input.sourceId);
  const bytes = await readSourceMaterial(root, source), store = new RoleRosterStore(root);
  if (existing) {
    if (revisions.at(-1)?.id !== existing.id || existing.priorRosterHash !== input.priorRosterHash
      || existing.predecessorDefinitionRevision !== (input.predecessorDefinitionRevision ?? null)
      || existing.scopeDecisionRef !== input.scopeDecisionRef || existing.reason !== input.reason) throw new Error("Role review revision replay differs from the original host decision. Preserve history and stop unchanged retries; never rewind to an earlier revision");
    assertRoleReviewRevisionEvidence(existing, bytes);
    if (fresh.subjectHash !== existing.nextRoster.subjectHash) throw new Error("Review subject changed during revision recovery; stop for host source review, do not overwrite partial reviews");
    if (saved?.reviewRevisionId === existing.id && saved.subjectHash === existing.nextRoster.subjectHash) return existing;
    if (!saved || contentHash(saved) !== existing.priorRosterHash) throw new Error("Saved roster changed during revision recovery; stop for host review, do not overwrite it");
    await store.write(existing.nextRoster);
    return existing;
  }
  if (!saved?.reviews.length) throw new Error("There is no retained review to revise. Continue the current independent review; do not begin another revision or reset partial work");
  if (saved.reviewRevisionId && saved.reviews.length < 2 && saved.subjectHash === fresh.subjectHash) {
    const retained = await CompilerFinishReceipts.listRetained(root, input.sourceId);
    const lacksCompletedFinish = saved.reviews.some(review => review.runId.startsWith(`role-roster-${input.sourceId}-`)
      && !retained.some(item => item.receipt.state === "completed" && contentHash(item.receipt.identity.metadata.roleReview ?? null) === contentHash(review)));
    if (!lacksCompletedFinish) throw new Error("Authorized independent review is incomplete. Resume that review; do not begin another revision or discard partial work");
  }
  if (contentHash(saved) !== input.priorRosterHash || (await ledger.coreRoleDefinitionHistory()).at(-1)?.revisionHash !== input.predecessorDefinitionRevision) throw new Error(`Role revision predecessor is stale. Run nwh requirements inspect --source ${input.sourceId}, copy savedRosterHash and the last coreRoleDefinitions[].revisionHash, and make at most one corrected host retry; never guess or reset history`);
  if ((await CompilerFinishReceipts.list(root, input.sourceId)).some(receipt => receipt.state === "prepared" && receipt.identity.batchId.startsWith(`role-roster-${input.sourceId}-`))) throw new Error("A role-review finish is still prepared. Stop and recover the original finish before revising; preserve its receipt and drafts, never replay it into a new review");
  const revision = await ledger.beginRoleReviewRevision({ version: 1, id: input.revisionId, sourceId: source.id, sourceSha256: source.contentSha256,
    predecessorDefinitionRevision: input.predecessorDefinitionRevision ?? null, priorRosterHash: input.priorRosterHash, priorRoster: saved,
    nextRoster: { ...fresh, reviewRevisionId: input.revisionId }, units: baseStructuralUnits(structure), scopeDecisionRef: input.scopeDecisionRef, reason: input.reason,
  }, bytes);
  await store.write(revision.nextRoster);
  return revision;
}
