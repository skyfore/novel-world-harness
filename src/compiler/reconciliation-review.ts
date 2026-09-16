import { z } from "zod";
import type { CompilerAuditReport } from "./audit.js";
import { CHARACTER_ONTOLOGY_VERSION } from "../world/character-ontology.js";

export const reconciliationRequirementSchema = z.object({
  id: z.string().min(1), target: z.string().min(1),
  capability: z.enum(["ontology", "development", "opening-driver", "event-semantics", "initial-world"]),
}).strict();
export type ReconciliationRequirement = z.infer<typeof reconciliationRequirementSchema>;
export const reconciliationRequirementReviewSchema = z.object({
  requirementId: z.string().min(1),
  disposition: z.enum(["proposed", "unsupported", "capability-gap"]),
  summary: z.string().min(1).max(2000),
}).strict();

/** Model reports are accountability records, never evidence of semantic readiness. */
export const reconciliationTargetReviewSchema = z.object({
  target: z.string().min(1),
  disposition: z.enum(["proposed", "unsupported", "capability-gap"]),
  evidence_segment_ids: z.array(z.string().min(1)).min(1),
  summary: z.string().min(1).max(2000),
  requirement_reviews: z.array(reconciliationRequirementReviewSchema).max(16).optional(),
}).strict();
export type ReconciliationTargetReview = z.infer<typeof reconciliationTargetReviewSchema>;

export function reconciliationAuditResults(targets: readonly string[], reviews: readonly ReconciliationTargetReview[], audit: CompilerAuditReport) {
  const unresolved = new Set([
    ...audit.semanticRepairTargets.eventIds.map(id => `event:${id}`),
    ...audit.consistency.unconditionalRootEvents.map(id => `event:${id}`),
    ...audit.semanticRepairTargets.characterIds.map(id => `character:${id}`),
    ...(audit.semanticRepairTargets.initialWorld ? ["initial-world:singleton"] : []),
  ]);
  return targets.map(target => ({
    target,
    // Absence from a global threshold-based target list is not per-artifact certification.
    status: unresolved.has(target) ? "unresolved" : "no-current-audit-finding",
    hostReviewRequired: unresolved.has(target) || reconciliationReviewDeferred(reviews.find(review => review.target === target)),
    modelReport: reviews.find(review => review.target === target) ?? null,
  }));
}

export function reconciliationReviewIssues(
  targets: readonly string[], reviews: readonly ReconciliationTargetReview[],
  proposals: ReadonlyMap<string, { kind: string; payload: Record<string, unknown> }>,
  requirements?: readonly ReconciliationRequirement[],
): string[] {
  const issues: string[] = [];
  for (const target of targets) {
    if (reviews.filter(review => review.target === target).length !== 1) issues.push(`Account exactly once for target ${target}.`);
  }
  for (const review of reviews) {
    if (!targets.includes(review.target)) issues.push(`Target ${review.target} is outside this shard.`);
    const matching = [...proposals.values()].some(proposal => {
      const target = proposal.kind === "canonical-event" ? `event:${proposal.payload.id}`
        : proposal.kind === "character-model" || proposal.kind === "character-goal" ? `character:${proposal.payload.actorId}`
        : proposal.kind === "initial-world" ? "initial-world:singleton" : undefined;
      return target === review.target;
    });
    if (review.disposition === "proposed" && !matching) issues.push(`${review.target}: proposed requires an active proposal for this target.`);
    if (review.disposition !== "proposed" && matching) issues.push(`${review.target}: active proposals require disposition=proposed; describe remaining gaps in summary.`);
    if (requirements) {
      const expected = requirements.filter(item => item.target === review.target);
      const reports = review.requirement_reviews ?? [];
      for (const requirement of expected) {
        const found = reports.filter(item => item.requirementId === requirement.id);
        if (found.length !== 1) { issues.push(`Account exactly once for requirement ${requirement.id}.`); continue; }
        const backed = [...proposals.values()].some(proposal => proposalSupportsReconciliationRequirement(requirement, proposal));
        if (found[0]!.disposition === "proposed" && !backed) issues.push(`${requirement.id}: proposed requires a matching capability proposal; another capability cannot substitute.`);
        // A proposal may address only part of this requirement. Unlike the old
        // target rule, an unresolved report is legal even with matching work.
      }
      for (const item of reports) if (!expected.some(requirement => requirement.id === item.requirementId)) issues.push(`Requirement ${item.requirementId} is outside this target's frozen scope.`);
    } else if (review.requirement_reviews?.length) issues.push(`${review.target}: requirement_reviews is outside this legacy batch scope.`);
  }
  return issues;
}

export function reconciliationReviewDeferred(review: ReconciliationTargetReview | undefined): boolean {
  return !review || review.disposition !== "proposed" || Boolean(review.requirement_reviews?.some(item => item.disposition !== "proposed"));
}

/** New receipts preserve each unresolved capability as its own review identity;
 * historical target-only receipts retain their original identity and hash. */
export function reconciliationDeferredRequirementIds(reviews: readonly ReconciliationTargetReview[]): string[] {
  return reviews.flatMap(review => review.requirement_reviews?.length
    ? review.requirement_reviews.filter(item => item.disposition !== "proposed").map(item => item.requirementId)
    : review.disposition !== "proposed" ? [review.target] : []).sort();
}

/** This validates proposal accounting only, never semantic satisfaction. */
export function proposalSupportsReconciliationRequirement(requirement: ReconciliationRequirement, proposal: { kind: string; payload: Record<string, unknown> }): boolean {
  const p = proposal.payload;
  const nonempty = (value: unknown) => Array.isArray(value) && value.length > 0;
  const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (requirement.capability === "event-semantics") return proposal.kind === "canonical-event" && requirement.target === `event:${p.id}`;
  if (requirement.capability === "initial-world") return proposal.kind === "initial-world" && requirement.target === "initial-world:singleton";
  if (requirement.target !== `character:${p.actorId}`) return false;
  if (requirement.capability === "ontology") return proposal.kind === "character-model" && p.ontologyVersion === CHARACTER_ONTOLOGY_VERSION;
  if (requirement.capability === "development") return proposal.kind === "character-model"
    ? nonempty(p.developmentEpisodes) || nonempty(p.developmentPhases)
    : proposal.kind === "character-goal" && Boolean(nonempty(p.requiresKnowledge) || nonempty(p.blockedByKnowledge) || nonempty(p.completion) || nonempty(p.expiry)
      || ["preconditions", "afterCanonicalEventIds", "afterExperiencedCanonicalEventIds"].some(key => nonempty(record(p.activation)[key]))
      || record(p.activation).storyWindow || (Array.isArray(p.milestones) && p.milestones.some(item => nonempty(record(item).conditions))));
  return proposal.kind === "character-goal" && [p.candidateAction, ...(Array.isArray(p.actionPatterns) ? p.actionPatterns : [])].some(action =>
    ["proposedDelta", "proposedKnowledge", "proposedSemantics", "proposedNorms", "proposedProcesses"].some(channel => nonempty(record(record(action)[channel]).operations)));
}
