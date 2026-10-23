import { z } from "zod";
import { contentHash, canonicalJson } from "../world/canonical.js";
import { idSchema } from "../world/model.js";
import { roleRosterSchema } from "./role-roster.js";
import { structuralUnitSchema } from "./structure.js";
import { assertCoreRoleDefinitionEvidence } from "./core-role-requirement-records.js";
import { roleReviewPlanSchema } from "./role-review-work.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const roleReviewRevisionSchema = z.object({
  version: z.literal(1), id: idSchema, revisionHash: hash, sourceId: idSchema, sourceSha256: hash,
  predecessorDefinitionRevision: hash.nullable(), priorRosterHash: hash, priorRoster: roleRosterSchema,
  nextRoster: roleRosterSchema, units: z.array(structuralUnitSchema).min(1),
  scopeDecisionRef: z.string().trim().min(1), reason: z.string().trim().min(1),
  workMigration: z.object({
    priorPlan: roleReviewPlanSchema, nextPlan: roleReviewPlanSchema,
    retainedFiles: z.array(z.object({ path: z.string().min(1), hash }).strict()).min(1),
  }).strict().optional(),
}).strict().superRefine(({ revisionHash, ...revision }, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (revisionHash !== contentHash(revision) || revision.priorRosterHash !== contentHash(revision.priorRoster)) fail("Role review revision hash mismatch");
  if (!revision.priorRoster.reviews.length || revision.nextRoster.reviews.length || revision.nextRoster.reviewRevisionId !== revision.id) fail("Role review revision must preserve prior work and start an empty authorized review");
  for (const roster of [revision.priorRoster, revision.nextRoster]) {
    if (roster.sourceId !== revision.sourceId || roster.sourceSha256 !== revision.sourceSha256) fail("Role review revision source mismatch");
    if (canonicalJson([...roster.unitIds].sort()) !== canonicalJson(revision.units.map(unit => unit.id).sort())) fail("Role review revision lacks the original source-unit inventory");
  }
  if (revision.units.some(unit => unit.sourceId !== revision.sourceId || unit.anchor.sourceId !== revision.sourceId)) fail("Role review revision unit source mismatch");
  if (revision.workMigration) {
    const { priorPlan, nextPlan, retainedFiles } = revision.workMigration, migration = nextPlan.migration;
    if (!migration || migration.revisionId !== revision.id || nextPlan.reviewRevisionId !== revision.id
      || migration.priorPlanHash !== contentHash(priorPlan) || migration.priorBatchId !== priorPlan.batchId
      || nextPlan.batchId === priorPlan.batchId || priorPlan.sourceId !== revision.sourceId || nextPlan.sourceId !== revision.sourceId
      || priorPlan.sourceHash !== revision.sourceSha256 || nextPlan.sourceHash !== revision.sourceSha256
      || priorPlan.subjectHash !== revision.priorRoster.subjectHash || nextPlan.subjectHash !== revision.nextRoster.subjectHash
      || priorPlan.structureHash !== nextPlan.structureHash || contentHash(priorPlan.spans) !== contentHash(nextPlan.spans)
      || contentHash(revision.priorRoster.candidates) !== contentHash(revision.nextRoster.candidates)
      || contentHash(migration.candidateIds) !== contentHash(revision.nextRoster.candidates.map(candidate => candidate.id))
      || migration.sourceWork.length !== priorPlan.spans.length
      || migration.entries.some(entry => !migration.candidateIds.includes(entry.candidateId))
      || new Set(migration.entries.map(entry => entry.candidateId)).size !== migration.entries.length
      || new Set(migration.allowances.map(item => item.key)).size !== migration.allowances.length
      || new Set(retainedFiles.map(file => file.path)).size !== retainedFiles.length
      || retainedFiles.some(file => file.path.startsWith("/") || file.path.split(/[\\/]/).includes(".."))) fail("Role work migration has inconsistent source, scope or allowance lineage");
  }
});
export type RoleReviewRevision = z.infer<typeof roleReviewRevisionSchema>;
export function assertRoleReviewRevisionEvidence(revision: RoleReviewRevision, bytes: Uint8Array) {
  assertCoreRoleDefinitionEvidence(revision, bytes);
}
