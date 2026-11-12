import type { SceneCapabilitySpec, SceneReviewCatalog } from "../eval/scene-capabilities.js";
import { contentHash } from "../world/canonical.js";
import { predicatesEntail } from "../world/predicate-implication.js";

/** Source-review obligations, never an inference that an empty delta is valid.
 * Existing independently registered scene requirements remain the only way to
 * supply expectations. This projection adds no alternate semantic ledger. */
export function inspectSemanticCoverage(sourceId: string, catalog: Pick<SceneReviewCatalog, "events" | "goals">, specs: readonly SceneCapabilitySpec[]) {
  type EventCase = Extract<SceneCapabilitySpec["cases"][number], { kind: "event-effects" }>;
  const reviewsByEvent = new Map<string, Array<{ specHash: string; caseId: string; disposition: EventCase["expectation"]["kind"] }>>();
  const reviewedGoals = new Set<string>();
  for (const spec of specs) {
    if (spec.sourceId !== sourceId) continue;
    const specHash = contentHash(spec);
    for (const test of spec.cases) {
      if (test.kind === "goal-lifecycle") reviewedGoals.add(test.goalId);
      if (test.kind !== "event-effects") continue;
      const reviews = reviewsByEvent.get(test.eventId) ?? [];
      reviews.push({ specHash, caseId: test.id, disposition: test.expectation.kind });
      reviewsByEvent.set(test.eventId, reviews);
    }
  }
  const belongs = (value: { evidence: Array<{ span: { sourceId: string } }> }) => value.evidence.length > 0 && value.evidence.every(e => e.span.sourceId === sourceId);
  const events = [...catalog.events.values()].filter(belongs).sort((a, b) => a.id.localeCompare(b.id)).map(event => {
    const reviews = reviewsByEvent.get(event.id) ?? [];
    return { ref: `event:${event.id}`, revisionHash: contentHash(event), stateOperations: event.observedOutcome.operations.length,
      knowledgeOperations: event.observedKnowledge?.operations.length ?? 0, reviews, reviewRequired: reviews.length === 0 };
  });
  const goals = [...catalog.goals?.values() ?? []].filter(belongs).sort((a, b) => a.id.localeCompare(b.id)).map(goal => ({
    ref: `goal:${goal.id}`, revisionHash: contentHash(goal), reviewRequired: !reviewedGoals.has(goal.id),
    activationEntailsCompletion: Boolean(goal.completion?.length && goal.completion.every(p => predicatesEntail(goal.activation?.preconditions ?? [], p))),
  }));
  const missing = [...events, ...goals].filter(item => item.reviewRequired).map(item => item.ref);
  return { policy: "semantic-coverage/v1", authority: "diagnostic-only", events, goals, missingReviewRefs: missing,
    issues: [...missing.map(ref => `SEMANTIC_SOURCE_REVIEW_REQUIRED: ${ref}; register an independent source-grounded event-effects/goal-lifecycle case through review-scenes --register, retaining unknown and unmapped outcomes.`),
      ...goals.filter(g => g.activationEntailsCompletion).map(g => `GOAL_ACTIVE_AND_COMPLETE: ${g.ref}; activation entails completion, so the goal cannot drive progress.`)],
    interpretation: "A source review distinguishes expressed effects, justified no-change, unknown evidence and unmapped semantics. Nonempty operations and review coverage do not prove support; the exact registered cases must still pass against current revisions. This inventory does not grant repair, certification or activation." };
}
