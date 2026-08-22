import type { CanonicalEvent, CommitId, Possibility } from "./model.js";
import type { CanonicalModelStore } from "./canonical-model.js";
import type { PossibilitySource } from "./runtime.js";

export function canonicalEventToPossibility(event: CanonicalEvent, branchId: string, commitId: CommitId): Possibility {
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
    causalParents: event.causalParents,
    canonicalEventId: event.id,
    pressure: event.confidence,
    relevance: 1,
    proposedDelta: event.observedOutcome,
    ...(event.observedKnowledge ? { proposedKnowledge: event.observedKnowledge } : {}),
    evidence: event.evidence,
  };
}

export function canonicalPossibilitySource(canon: CanonicalModelStore): PossibilitySource {
  return async ({ branchId, commitId }) => {
    const events = await canon.listEvents();
    return events.map((event) => canonicalEventToPossibility(event, branchId, commitId));
  };
}
