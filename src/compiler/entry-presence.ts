import { contentHash } from "../world/canonical.js";
import { canonicalEventSchema, eventParticipationSchema, type EvidenceRef } from "../world/model.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";

type Baseline = { kind: "canonical-event" | "event-participation"; id: string; payload: unknown; revisionHash: string };
type Wording = { title: string; readerSummary: string; readerSetup: string; actorObservation: string; rationale: string };
const stop = (reason: string) => prerequisiteStop(`${reason}. Discover canonical-event and event-participation with find_compiler_artifacts in the same source, copy results[].readArguments.ref into read_compiler_artifact.ref once. Preserve source uncertainty and the original revision; scope or ownership changes require host review, no guessed ID or unchanged retry.`);

/** A typed proposal transformation usable by compilation or repair adapters.
 * It grants no authority to commit and makes no claim of executable completion. */
export function lowerUnresolvedEntryPresence<T extends Baseline>(scope: { actorId: string; eventId: string; baselines: readonly T[] }, wording: Wording, evidence: EvidenceRef[]) {
  if (scope.baselines.filter(b => b.kind === "canonical-event" && b.id === scope.eventId).length !== 1
    || new Set(scope.baselines.map(b => `${b.kind}:${b.id}`)).size !== scope.baselines.length)
    throw stop("Presence repair needs one exact owning event and unique dependencies");
  return scope.baselines.map(b => {
    if (b.revisionHash !== contentHash(b.payload)) throw stop("Frozen presence baseline changed");
    if (b.kind === "event-participation") {
      const p = eventParticipationSchema.parse(b.payload);
      if (p.id !== b.id || p.eventId !== scope.eventId || p.entityId !== scope.actorId) throw stop("Presence participation escaped the exact actor/occurrence");
      return { ...b, payload: eventParticipationSchema.parse({ ...p, presence: "unresolved" }) };
    }
    const e = canonicalEventSchema.parse(b.payload), entries = e.characterEntryCheckpoints?.filter(c => c.actorId === scope.actorId);
    if (e.id !== scope.eventId || b.id !== e.id || entries?.length !== 1 || !e.participantPresence?.some(p => p.entityId === scope.actorId))
      throw stop("Presence repair needs its exact active event and entry");
    return { ...b, payload: canonicalEventSchema.parse({ ...e, title: wording.title, readerSummary: wording.readerSummary,
      participantPresence: e.participantPresence.map(p => p.entityId === scope.actorId ? { ...p, mode: "unresolved" } : p),
      characterEntryCheckpoints: e.characterEntryCheckpoints!.map(c => c.actorId !== scope.actorId ? c : {
        actorId: c.actorId, readerSetup: wording.readerSetup, actorObservation: wording.actorObservation,
        participantPresence: c.participantPresence.map(p => p.entityId === scope.actorId ? { ...p, mode: "unresolved" } : p),
        delta: { version: 1, operations: [] }, admission: { status: "blocked", reason: "presence-unresolved", rationale: wording.rationale, evidence },
      }) }) };
  });
}
