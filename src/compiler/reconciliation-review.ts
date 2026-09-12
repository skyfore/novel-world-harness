import { z } from "zod";
import type { CompilerAuditReport } from "./audit.js";

/** Model reports are accountability records, never evidence of semantic readiness. */
export const reconciliationTargetReviewSchema = z.object({
  target: z.string().min(1),
  disposition: z.enum(["proposed", "unsupported", "capability-gap"]),
  evidence_segment_ids: z.array(z.string().min(1)).min(1),
  summary: z.string().min(1).max(2000),
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
    hostReviewRequired: reviews.find(review => review.target === target)?.disposition !== "proposed",
    modelReport: reviews.find(review => review.target === target) ?? null,
  }));
}

export function reconciliationReviewIssues(
  targets: readonly string[], reviews: readonly ReconciliationTargetReview[],
  proposals: ReadonlyMap<string, { kind: string; payload: Record<string, unknown> }>,
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
  }
  return issues;
}
