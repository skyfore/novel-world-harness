import { canonicalJson } from "./canonical.js";
import type {
  CanonicalEvent,
  Entity,
  EventParticipation,
  ParticipantPresence,
  ValidationIssue,
} from "./model.js";

export const EVENT_PARTICIPATION_PROJECTION_VERSION = 1 as const;

export type EventParticipationCatalog = {
  entities: ReadonlyMap<string, Entity>;
  events: ReadonlyMap<string, CanonicalEvent>;
  participations: Iterable<EventParticipation>;
};

export function validateEventParticipationRecord(
  participation: EventParticipation,
  entities: ReadonlyMap<string, Entity>,
  events: ReadonlyMap<string, CanonicalEvent>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const event = events.get(participation.eventId);
  const entity = entities.get(participation.entityId);
  if (!event) {
    issues.push(issue("UNKNOWN_PARTICIPATION_EVENT", `Participation ${participation.id} references unknown event ${participation.eventId}`, "eventId"));
  }
  if (!entity) {
    issues.push(issue("UNKNOWN_PARTICIPATION_ENTITY", `Participation ${participation.id} references unknown entity ${participation.entityId}`, "entityId"));
    return issues;
  }
  if (participation.presence && entity.kind !== "character") {
    issues.push(issue("INVALID_PARTICIPATION_PRESENCE", `Participation ${participation.id} assigns ${participation.presence} presence to non-character ${participation.entityId}`, "presence"));
  }
  if (participation.role === "experiencer" && entity.kind !== "character") {
    issues.push(issue("INVALID_PARTICIPATION_ROLE", `Experiencer ${participation.entityId} must be a character`, "role"));
  }
  if (participation.role === "location" && entity.kind !== "location") {
    issues.push(issue("INVALID_PARTICIPATION_ROLE", `Location participant ${participation.entityId} must be a location entity`, "role"));
  }
  if (event && !event.participants.includes(participation.entityId)) {
    issues.push(issue("PARTICIPATION_LEGACY_MISMATCH", `Participation ${participation.id} entity ${participation.entityId} is absent from event ${event.id} legacy participants`, "entityId"));
  }
  if (event && participation.presence) {
    const legacyMode = event.participantPresence?.find((item) => item.entityId === participation.entityId)?.mode;
    if (legacyMode !== participation.presence) {
      issues.push(issue("PARTICIPATION_PRESENCE_PROJECTION_MISMATCH", `Participation ${participation.id} presence ${participation.presence} does not match event ${event.id} legacy presence ${legacyMode ?? "missing"}`, "presence"));
    }
  }
  return issues;
}

/**
 * Returns a runtime-compatible event projection. Legacy events with no typed
 * records remain byte-for-byte compatible; once records exist for an event,
 * their entity and presence inventory becomes authoritative.
 */
export function projectEventParticipations(
  event: CanonicalEvent,
  participations: readonly EventParticipation[],
): CanonicalEvent {
  const selected = participations.filter((item) => item.eventId === event.id);
  if (!selected.length) return structuredClone(event);

  const entityIds = new Set(selected.map((item) => item.entityId));
  const participants = [
    ...event.participants.filter((entityId) => entityIds.delete(entityId)),
    ...[...entityIds].sort(),
  ];
  const presenceByEntity = new Map<string, ParticipantPresence["mode"]>();
  for (const participation of [...selected].sort((left, right) => left.id.localeCompare(right.id))) {
    if (participation.presence && !presenceByEntity.has(participation.entityId)) {
      presenceByEntity.set(participation.entityId, participation.presence);
    }
  }
  const remainingPresenceIds = new Set(presenceByEntity.keys());
  const presenceOrder = [
    ...(event.participantPresence ?? []).flatMap((item) =>
      remainingPresenceIds.delete(item.entityId) ? [item.entityId] : []),
    ...[...remainingPresenceIds].sort(),
  ];
  const participantPresence = presenceOrder.flatMap((entityId) => {
    const mode = presenceByEntity.get(entityId);
    return mode ? [{ entityId, mode }] : [];
  });
  const projected: CanonicalEvent = {
    ...structuredClone(event),
    participants,
  };
  if (participantPresence.length) projected.participantPresence = participantPresence;
  else delete projected.participantPresence;
  return projected;
}

/**
 * Validates reference closure, role/kind constraints, duplicate roles, and a
 * lossless projection to the current CanonicalEvent compatibility fields.
 */
export function validateEventParticipationCatalog(catalog: EventParticipationCatalog): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byEvent = new Map<string, EventParticipation[]>();
  for (const participation of catalog.participations) {
    byEvent.set(participation.eventId, [...(byEvent.get(participation.eventId) ?? []), participation]);
    issues.push(...validateEventParticipationRecord(participation, catalog.entities, catalog.events)
      .map((item) => ({ ...item, path: `${participation.id}.${item.path ?? "payload"}` })));
  }

  for (const [eventId, values] of byEvent) {
    const event = catalog.events.get(eventId);
    if (!event) continue;
    const roleOwners = new Map<string, string>();
    const presenceByEntity = new Map<string, Set<string>>();
    for (const participation of values) {
      const roleKey = `${participation.entityId}:${participation.role}`;
      const prior = roleOwners.get(roleKey);
      if (prior) {
        issues.push(issue("DUPLICATE_EVENT_PARTICIPATION", `Event ${eventId} duplicates role ${participation.role} for ${participation.entityId} in ${prior} and ${participation.id}`, participation.id));
      } else {
        roleOwners.set(roleKey, participation.id);
      }
      if (participation.presence) {
        const modes = presenceByEntity.get(participation.entityId) ?? new Set<string>();
        modes.add(participation.presence);
        presenceByEntity.set(participation.entityId, modes);
      }
    }
    for (const [entityId, modes] of presenceByEntity) {
      if (modes.size > 1) {
        issues.push(issue("CONFLICTING_PARTICIPATION_PRESENCE", `Event ${eventId} assigns conflicting presence modes to ${entityId}: ${[...modes].sort().join(", ")}`, eventId));
      }
    }

    const typedIds = [...new Set(values.map((item) => item.entityId))].sort();
    const legacyEntityIds = new Set(event.participants);
    const legacyIds = [...legacyEntityIds].sort();
    if (legacyEntityIds.size !== event.participants.length) {
      issues.push(issue("DUPLICATE_LEGACY_EVENT_PARTICIPANT", `Event ${eventId} legacy participants contain duplicate entity IDs and cannot be projected losslessly`, eventId));
    }
    if (canonicalJson(typedIds) !== canonicalJson(legacyIds)) {
      issues.push(issue("INCOMPLETE_EVENT_PARTICIPATION", `Event ${eventId} typed participants (${typedIds.join(", ") || "none"}) do not project exactly to legacy participants (${legacyIds.join(", ") || "none"})`, eventId));
    }
    const legacyPresence = new Map((event.participantPresence ?? []).map((item) => [item.entityId, item.mode]));
    for (const entityId of legacyIds) {
      const entity = catalog.entities.get(entityId);
      if (entity?.kind !== "character") continue;
      const typedModes = presenceByEntity.get(entityId) ?? new Set<string>();
      const legacyMode = legacyPresence.get(entityId);
      if (!legacyMode || typedModes.size !== 1 || !typedModes.has(legacyMode)) {
        issues.push(issue("PARTICIPATION_PRESENCE_PROJECTION_MISMATCH", `Event ${eventId} character ${entityId} typed presence must project exactly to legacy mode ${legacyMode ?? "missing"}`, eventId));
      }
    }
    for (const entityId of presenceByEntity.keys()) {
      if (!legacyPresence.has(entityId)) {
        issues.push(issue("PARTICIPATION_PRESENCE_PROJECTION_MISMATCH", `Event ${eventId} typed presence for ${entityId} is absent from legacy participantPresence`, eventId));
      }
    }
  }
  return issues;
}

export function eventParticipationsByEvent(
  participations: readonly EventParticipation[],
): ReadonlyMap<string, readonly EventParticipation[]> {
  const byEvent = new Map<string, EventParticipation[]>();
  for (const item of participations) byEvent.set(item.eventId, [...(byEvent.get(item.eventId) ?? []), item]);
  for (const values of byEvent.values()) values.sort((left, right) => left.id.localeCompare(right.id));
  return byEvent;
}

function issue(code: string, message: string, path: string): ValidationIssue {
  return { code, message, path };
}
