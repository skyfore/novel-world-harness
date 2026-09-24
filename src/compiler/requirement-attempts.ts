import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { coreRoleDefinitions, type CoreRoleRequirementDefinition } from "./core-role-requirement-records.js";
import { proposalSupportsReconciliationRequirement, type ReconciliationRequirement, type ReconciliationTargetReview } from "./reconciliation-review.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1);
export const requirementProposalRefSchema = z.object({ store: z.enum(["world", "annotation", "entity-resolution", "event-resolution", "accounting"]), proposalId: text, hash }).strict();
export const coreRoleAttemptScopeSchema = z.object({
  definitionRevision: hash, specHash: hash,
  requirements: z.array(z.object({ id: text, definitionHash: hash, targetRef: text, capability: text }).strict()).min(1),
}).strict().superRefine((scope, ctx) => {
  if (new Set(scope.requirements.map(item => item.id)).size !== scope.requirements.length) ctx.addIssue({ code: "custom", message: "Duplicate independent requirement" });
});
export type CoreRoleAttemptScope = z.infer<typeof coreRoleAttemptScopeSchema>;
export const coreRoleAttemptSchema = z.object({
  requirementId: text, definitionHash: hash, definitionRevision: hash, repairRunId: text,
  reportRequirementId: text, proposalRefs: z.array(requirementProposalRefSchema),
  modelOutcome: z.enum(["proposed", "unsupported", "capability-gap"]),
  evidenceRefs: z.array(text).min(1), summary: text,
}).strict();
export type CoreRoleAttempt = z.infer<typeof coreRoleAttemptSchema>;

export function coreRoleAttemptScope(definition: CoreRoleRequirementDefinition): CoreRoleAttemptScope {
  return { definitionRevision: definition.revisionHash, specHash: definition.specHash,
    requirements: coreRoleDefinitions({ source: { id: definition.sourceId } }, definition.roster)
      .map(item => ({ id: item.id, definitionHash: contentHash(item), targetRef: item.targetRef, capability: item.capability })),
  };
}

/** Only host-validated reports are mapped; unattempted capabilities remain obligations. */
export function coreRoleAttemptReports(input: {
  batchId: string; requirements: readonly ReconciliationRequirement[]; scope: CoreRoleAttemptScope;
  reviews: readonly ReconciliationTargetReview[];
}): CoreRoleAttempt[] {
  const attempts: CoreRoleAttempt[] = [];
  for (const review of input.reviews) for (const report of review.requirement_reviews ?? []) {
    const structural = input.requirements.find(item => item.id === report.requirementId && item.target === review.target);
    if (!structural) throw new Error("Attempt report escapes its frozen plan; stop for host review");
    for (const definition of input.scope.requirements.filter(item => item.targetRef === structural.target && item.capability === structural.capability)) {
      attempts.push({ requirementId: definition.id, definitionHash: definition.definitionHash, definitionRevision: input.scope.definitionRevision,
        repairRunId: input.batchId, reportRequirementId: structural.id, proposalRefs: [], modelOutcome: report.disposition,
        evidenceRefs: review.evidence_segment_ids.map(id => `source-segment:${id}`), summary: report.summary });
    }
  }
  return attempts;
}

export function linkCoreRoleAttemptProposals(attempts: CoreRoleAttempt[], requirements: readonly ReconciliationRequirement[], proposals: readonly {
  ref: z.infer<typeof requirementProposalRefSchema>; kind: string; payload: Record<string, unknown>;
}[]): CoreRoleAttempt[] {
  return attempts.map(attempt => ({ ...attempt, proposalRefs: proposals
    .filter(proposal => proposalSupportsReconciliationRequirement(requirements.find(item => item.id === attempt.reportRequirementId)!, proposal))
    .map(proposal => proposal.ref) }));
}
