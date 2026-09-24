import { evidenceBelongsExclusivelyToSource } from "./source-scope.js";
import { agencyPresenceIssues, projectAgencyChannels } from "./agency-profile.js";
import { applyProcessDelta, emptyProcessState } from "./process-effects.js";
import type { ActionSchema } from "./action-ontology.js";
import type { ProcessTemplate } from "./process-ontology.js";
import type { CanonicalEvent, EventParticipation, Entity, EntryProjectionSeed, EvidenceAssertion, KnowledgeDelta, ParticipantPresence, ValidationIssue } from "./model.js";

export type EntryAgencyCatalog = { entities: ReadonlyMap<string, Entity>; processTemplates?: ReadonlyMap<string, ProcessTemplate>; actionSchemas?: ReadonlyMap<string, ActionSchema>; sourceId?: string; acquisitions?: ReadonlyMap<string, { reception: { understood: boolean } }> };
type Entry = { participantPresence?: readonly ParticipantPresence[]; projectionSeed?: EntryProjectionSeed; knowledge?: KnowledgeDelta };
const stop = " Preserve the head and stop for host source/checkpoint review; do not invent a session, relabel presence, widen scope or retry unchanged.";

/** Presence alone never turns an image, mention or remote identity into a playable agent. */
export function entryAgencyIssues(actorId: string, entry: Entry, context: EntryAgencyCatalog): ValidationIssue[] {
  const actor = context.entities.get(actorId), presence = entry.participantPresence?.find(item => item.entityId === actorId)?.mode;
  const fail = (message: string): ValidationIssue[] => [{ code: "ENTRY_AGENCY_UNPROVEN", path: "participantPresence", message: message + stop }];
  if (!actor || actor.kind !== "character") return fail("Entry actor is not a character in this source.");
  if (presence !== "physical" && presence !== "remote") return fail("Entry requires bodily presence or an evidenced live channel, not a representation.");
  const agency = agencyPresenceIssues(actor, presence);
  if (agency.length) return agency;
  if (presence === "physical") return [];
  if (!entry.projectionSeed || actor.agencyProfile?.agency !== "autonomous") return fail("Remote entry needs an autonomous profile and complete pre-entry process seed.");
  try {
    const seed = entry.projectionSeed;
    const processes = applyProcessDelta(emptyProcessState("entry"), seed.processes, {
      entities: context.entities, templates: context.processTemplates ?? new Map(), allowHistoricalStarts: true,
    }, { commitId: "entry", eventId: "entry", eventHash: "0".repeat(64) }, seed.elapsedDays);
    const knownClaimIds = new Set<string>();
    for (const op of entry.knowledge?.operations ?? []) if (op.actorId === actorId) {
      if (op.op === "forget") { knownClaimIds.delete(op.claimId); continue; }
      const branchAcquisition = op.acquisitionId ? seed.semantics.operations.find(item => item.op === "record-acquisition" && item.acquisition.id === op.acquisitionId) : undefined;
      const acquisition = branchAcquisition?.op === "record-acquisition" ? branchAcquisition.acquisition : op.acquisitionId ? context.acquisitions?.get(op.acquisitionId) : undefined;
      if (op.status === "disbelieves" || op.acquisitionId && (!acquisition || !acquisition.reception.understood)) knownClaimIds.delete(op.claimId);
      else knownClaimIds.add(op.claimId);
    }
    const sourceId = context.sourceId ?? actor.evidence[0]?.span.sourceId;
    const channels = projectAgencyChannels(actor, processes, context, {
      knownClaimIds, sourceId, visibleEntityIds: new Set([...context.entities.values()].filter(entity => evidenceBelongsExclusivelyToSource(entity.evidence, sourceId)).map(entity => entity.id)),
    });
    if (!channels?.channels.length) return fail("No running, phase-valid, disclosed session binds this entry actor, its peer and carrier.");
    return [];
  } catch (error) { return fail(`Invalid pre-entry process seed: ${String(error)}`); }
}

export function playableEntryActorIds(entry: Entry, context: EntryAgencyCatalog): Set<string> {
  return new Set((entry.participantPresence ?? []).filter(item => !entryAgencyIssues(item.entityId, entry, context).length).map(item => item.entityId));
}

/** Entry channel authority has its own source support, separate from reader prose. */
export function remoteEntryEvidenceIssues(entry: Entry, assertions: readonly EvidenceAssertion[], prefix = ""): ValidationIssue[] {
  const remote = (entry.participantPresence ?? []).flatMap((item, index) => item.mode === "remote" ? [index] : []);
  if (!remote.length || !entry.projectionSeed) return [];
  const paths = [
    ...remote.map(index => `${prefix}/participantPresence/${index}/mode`),
    ...entry.projectionSeed.processes.operations.map((_, index) => `${prefix}/projectionSeed/processes/operations/${index}`),
  ];
  return paths.filter(path => !assertions.some(item => item.target.jsonPointer === path && item.relation === "supports" && item.strength !== "weak-inference" && item.anchors.length))
    .map(path => ({ code: "ENTRY_AGENCY_EVIDENCE_REQUIRED", path, message: "Remote entry presence and each historical process operation need exact same-source evidence at the entry cut. Inspect the named source fields and correct once; stop if unsupported, never infer a pre-entry session from a future occurrence." }));
}

/** Shared by proposal, commit, audit and frozen-cache boundaries. */
export function entryArtifactEvidenceIssues(kind: string, payload: unknown, assertions: readonly EvidenceAssertion[]): ValidationIssue[] {
  const artifact = payload as { characterEntryCheckpoints?: (Entry & { actorId: string })[]; entryCheckpoint?: Entry & { actorId: string } };
  const entries = kind === "canonical-event" ? (artifact.characterEntryCheckpoints ?? []).map((entry, i) => ({ entry, prefix: `/characterEntryCheckpoints/${i}` }))
    : kind === "event-execution" && artifact.entryCheckpoint ? [{ entry: artifact.entryCheckpoint, prefix: "/entryCheckpoint" }] : [];
  return entries.flatMap(({ entry, prefix }) => {
    const issues = remoteEntryEvidenceIssues(entry, assertions, prefix);
    if (!entry.participantPresence?.some(item => item.entityId === entry.actorId && item.mode === "remote")) return issues;
    const paths = [`${prefix}/actorId`, ...(kind === "event-execution" ? ["/actorId", "/canonicalEventId"] : [])];
    for (const path of paths) if (!assertions.some(item => item.target.jsonPointer === path && item.relation === "supports" && item.strength !== "weak-inference" && item.anchors.length)) {
      issues.push({ code: "ENTRY_AGENCY_EVIDENCE_REQUIRED", path, message: "Remote checkpoint identity and occurrence require exact source support at the pre-event cut. Inspect the named source field and correct once; otherwise stop without guessing or relabelling." });
    }
    return issues;
  });
}

/** A remote checkpoint cannot convert a depiction in the occurrence into live participation. */
export function remoteEntryOccurrenceIssues(actorId: string, entry: Entry, event: Pick<CanonicalEvent, "id" | "participants" | "participantPresence">, participations: Iterable<EventParticipation> = []): ValidationIssue[] {
  if (!entry.participantPresence?.some(item => item.entityId === actorId && item.mode === "remote")) return [];
  const mode = event.participantPresence?.find(item => item.entityId === actorId)?.mode;
  if (event.participants.includes(actorId) && (mode === "remote" || mode === undefined && [...participations].some(item => item.eventId === event.id && item.entityId === actorId && item.presence === "remote"))) return [];
  return [{ code: "EVENT_ENTRY_PRESENCE_UNPROVEN", path: "participantPresence", message: "Remote entry requires matching live remote participation in this occurrence." + stop }];
}
