import type { CanonicalEvent, CommitId, EventRelation, Possibility } from "./model.js";
import type { CanonicalModelStore } from "./canonical-model.js";
import type { PossibilitySource } from "./runtime.js";

export function canonicalEventToPossibility(
  event: CanonicalEvent,
  branchId: string,
  commitId: CommitId,
  relations: readonly EventRelation[] = [],
): Possibility {
  const causalLinks = relations
    .filter((relation) => relation.toEventId === event.id && relation.status !== "contested")
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((relation) => ({
      relationId: relation.id,
      sourceEventId: relation.fromEventId,
      type: relation.type,
      operationality: relation.operationality,
      ...(relation.motivatedActorIds ? { motivatedActorIds: [...relation.motivatedActorIds] } : {}),
      ...(relation.goalIds ? { goalIds: [...relation.goalIds] } : {}),
    }));
  return {
    id: `canon-${event.id}`,
    branchId,
    evaluatedAtCommit: commitId,
    kind: "canon-analogue",
    title: event.title,
    candidateWindow: event.storyTime,
    ...(event.timeAdvance ? { timeAdvance: event.timeAdvance } : {}),
    preconditions: event.preconditions,
    blockers: [],
    participants: event.participants,
    ...(event.participantPresence ? { participantPresence: structuredClone(event.participantPresence) } : {}),
    causalLinks,
    causalParents: event.causalParents,
    canonicalEventId: event.id,
    pressure: event.confidence,
    relevance: 1,
    proposedDelta: event.observedOutcome,
    ...(event.observedKnowledge ? { proposedKnowledge: event.observedKnowledge } : {}),
    ...(event.action ? { action: structuredClone(event.action) } : {}),
    evidence: event.evidence,
  };
}

export function canonicalPossibilitySource(canon: CanonicalModelStore): PossibilitySource {
  return async ({ branchId, commitId }) => {
    const [events, relations] = await Promise.all([canon.listEvents(), canon.listEventRelations()]);
    return events.map((event) => canonicalEventToPossibility(event, branchId, commitId, relations));
  };
}
