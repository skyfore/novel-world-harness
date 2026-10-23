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
import { observeRequirementValidity } from "./requirement-observation.js";
import { RoleReviewWorkStore } from "./role-review-work.js";
import { assertRetainedRoleWork, prepareRoleWorkMigration } from "./role-work-migration.js";

export const beginCoreRoleReviewSchema = z.object({
  sourceId: idSchema, revisionId: idSchema, priorRosterHash: z.string().regex(/^[a-f0-9]{64}$/),
  predecessorDefinitionRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  scopeDecisionRef: z.string().trim().min(1), reason: z.string().trim().min(1),
  expectedWorkPlanHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
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
      || (existing.workMigration ? contentHash(existing.workMigration.priorPlan) : undefined) !== input.expectedWorkPlanHash
      || existing.scopeDecisionRef !== input.scopeDecisionRef || existing.reason !== input.reason) throw new Error("Role review revision replay differs from the original host decision. Preserve history and stop unchanged retries; never rewind to an earlier revision");
    assertRoleReviewRevisionEvidence(existing, bytes);
    if (fresh.subjectHash !== existing.nextRoster.subjectHash) throw new Error("Review subject changed during revision recovery; stop for host source review, do not overwrite partial reviews");
    if (existing.workMigration) {
      await assertRetainedRoleWork(root, existing.workMigration);
      await RoleReviewWorkStore.open(root, existing.workMigration.nextPlan);
    }
    if (saved?.reviewRevisionId === existing.id && saved.subjectHash === existing.nextRoster.subjectHash) {
      await observeRequirementValidity(root, input.sourceId);
      return existing;
    }
    if (!saved || contentHash(saved) !== existing.priorRosterHash) throw new Error("Saved roster changed during revision recovery; stop for host review, do not overwrite it");
    await store.write(existing.nextRoster);
    await observeRequirementValidity(root, input.sourceId);
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
  const nextRoster = { ...fresh, reviewRevisionId: input.revisionId };
  const workMigration = await prepareRoleWorkMigration(root, { ...input, priorRoster: saved, nextRoster, structureHash: contentHash(structure) });
  const revision = await ledger.beginRoleReviewRevision({ version: 1, id: input.revisionId, sourceId: source.id, sourceSha256: source.contentSha256,
    predecessorDefinitionRevision: input.predecessorDefinitionRevision ?? null, priorRosterHash: input.priorRosterHash, priorRoster: saved,
    nextRoster, units: baseStructuralUnits(structure), scopeDecisionRef: input.scopeDecisionRef, reason: input.reason,
    ...(workMigration ? { workMigration } : {}),
  }, bytes);
  if (workMigration) await RoleReviewWorkStore.open(root, workMigration.nextPlan);
  await store.write(revision.nextRoster);
  await observeRequirementValidity(root, input.sourceId);
  return revision;
}
