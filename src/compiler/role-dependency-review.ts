import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { roleRosterSchema } from "./role-roster.js";
import { roleReviewPlanSchema } from "./role-review-work.js";
import { prerequisiteScopeSchema, prerequisiteTaskId, prerequisiteStop } from "./role-source-prerequisites.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** A pending denominator revision. It does not replace a plan, migrate allowances,
 * mark any old question resolved, or authorize a model invocation on that plan. */
export const roleDependencyReviewSchema = z.object({
  version: z.literal(1), taskId: hash, revisionHash: hash,
  scope: prerequisiteScopeSchema, authorizationRef: z.string().trim().min(1),
  authority: z.literal("semantic-scope-planning-only"),
  priorPlan: roleReviewPlanSchema, priorRoster: roleRosterSchema, nextRoster: roleRosterSchema,
  prerequisiteRecordHashes: z.array(hash).length(4), representationRecordHashes: z.array(hash).length(2),
  upstream: z.object({ planHash: hash, receiptFingerprint: hash, acceptanceRecordHash: hash,
    convergenceRef: hash, prefixLength: z.number().int().positive(), prefixHead: hash }).strict(),
  requirementPrefix: z.object({ length: z.number().int().positive(), head: hash }).strict(),
  addedCandidateIds: z.array(z.string()).min(1), addedAnnotationIds: z.array(z.string()).min(1),
  catalogHash: hash, discoveryHash: hash,
  retainedFiles: z.array(z.object({ path: z.string().min(1), hash }).strict()).min(1),
}).strict().superRefine(({ revisionHash, ...r }, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (revisionHash !== contentHash(r) || r.taskId !== prerequisiteTaskId(r.scope)
    || contentHash(r.priorPlan) !== r.scope.planHash) fail("Dependency review identity changed");
  if (r.priorPlan.subjectHash !== r.priorRoster.subjectHash || r.priorPlan.sourceHash !== r.scope.sourceHash
    || r.priorPlan.reviewRevisionId !== r.priorRoster.reviewRevisionId || r.nextRoster.reviewRevisionId !== undefined
    || r.priorPlan.sourceId !== r.scope.sourceId || r.nextRoster.reviews.length
    || r.priorRoster.subjectHash === r.nextRoster.subjectHash) fail("Dependency review subject lineage changed");
  for (const roster of [r.priorRoster, r.nextRoster]) if (roster.sourceId !== r.scope.sourceId || roster.sourceSha256 !== r.scope.sourceHash) fail("Dependency review source changed");
  if (contentHash(r.priorRoster.unitIds) !== contentHash(r.nextRoster.unitIds)) fail("Dependency review changed source units");
  try { assertAdditiveRoleInventory(r.priorRoster, r.nextRoster, r.addedAnnotationIds, r.addedCandidateIds); }
  catch (error) { fail(String(error)); }
  if (new Set(r.retainedFiles.map(f => f.path)).size !== r.retainedFiles.length
    || r.retainedFiles.some(f => f.path.startsWith("/") || f.path.split(/[\\/]/).includes(".."))) fail("Invalid retained history path");
});
export type RoleDependencyReview = z.infer<typeof roleDependencyReviewSchema>;

export function assertAdditiveRoleInventory(prior: z.infer<typeof roleRosterSchema>, next: z.infer<typeof roleRosterSchema>,
  annotations: string[], expectedIds?: string[]) {
  if (prior.candidates.some(c => contentHash(c) !== contentHash(next.candidates.find(n => n.id === c.id) ?? null))) {
    throw prerequisiteStop("A prior role candidate was removed or modified; additive dependency review cannot authorize this change");
  }
  const added = next.candidates.filter(c => !prior.candidates.some(p => p.id === c.id));
  if (!added.length || added.some(c => c.entityId || c.resolutionIds.length || !c.mentionIds.length || c.mentionIds.some(id => !annotations.includes(id)))
    || (expectedIds && contentHash(added.map(c => c.id)) !== contentHash(expectedIds))) {
    throw prerequisiteStop("New roster candidates must be exact unresolved mentions from the accepted source receipt");
  }
  return added.map(c => c.id);
}

export function freezeRoleDependencyReview(input: Omit<RoleDependencyReview, "revisionHash">): RoleDependencyReview {
  return roleDependencyReviewSchema.parse({ ...input, revisionHash: contentHash(input) });
}
