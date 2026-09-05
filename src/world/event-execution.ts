import { z } from "zod";
import { actionInvocationSchema, characterEntryCheckpointSchema, entryProjectionSeedSchema, evidenceRefSchema, idSchema, type CanonicalEvent, type Entity, type EventParticipation, type ValidationIssue } from "./model.js";
import { resolveActionInvocation, type ActionSchema } from "./action-ontology.js";
import { canonicalJson } from "./canonical.js";

/** Executable-stage linkage leaves the earlier semantic occurrence immutable. */
export const eventExecutionSchema = z.object({
  id: idSchema, canonicalEventId: idSchema, actorId: idSchema,
  action: actionInvocationSchema.refine((action) => action.lane === "schema-bound", "Execution bindings require an explicit compiled mechanism").optional(),
  entryCheckpoint: characterEntryCheckpointSchema.safeExtend({ projectionSeed: entryProjectionSeedSchema }).optional(),
  evidence: z.array(evidenceRefSchema).min(1),
}).strict().refine((binding) => Boolean(binding.action || binding.entryCheckpoint), "An execution binding must supply an action mechanism or a complete character entry checkpoint");
export type EventExecution = z.infer<typeof eventExecutionSchema>;

export function validateEventExecutions(bindings: readonly EventExecution[], catalog: {
  events: ReadonlyMap<string, CanonicalEvent>; entities: ReadonlyMap<string, Entity>; actionSchemas: ReadonlyMap<string, ActionSchema>;
  participations?: readonly EventParticipation[];
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [], seen = new Set<string>(), entries = new Set<string>();
  for (const binding of bindings) {
    const path = `event-execution/${binding.id}`, fail = (code: string, message: string) => issues.push({ code, message, path });
    const event = catalog.events.get(binding.canonicalEventId);
    if (binding.action && seen.has(binding.canonicalEventId)) fail("EVENT_EXECUTION_DUPLICATED", `Event ${binding.canonicalEventId} has multiple action execution bindings`);
    if (binding.action) seen.add(binding.canonicalEventId);
    if (!event) { fail("EVENT_EXECUTION_EVENT_MISSING", `Unknown canonical event '${binding.canonicalEventId}'`); continue; }
    const sources = new Set(event.evidence.map((reference) => reference.span.sourceId));
    if (sources.size !== 1 || binding.evidence.some((reference) => !sources.has(reference.span.sourceId))) fail("EVENT_EXECUTION_SOURCE_MISMATCH", "Execution binding and occurrence must belong to the same immutable novel");
    if (catalog.entities.get(binding.actorId)?.kind !== "character" || !event.participants.includes(binding.actorId)) fail("EVENT_EXECUTION_ACTOR_INVALID", "The execution initiator must be an actual participating character; presence alone does not establish agency");
    if (binding.action) {
      if (!catalog.participations?.some((participation) => participation.eventId === event.id && participation.entityId === binding.actorId && participation.role === "agent")) fail("EVENT_EXECUTION_AGENCY_UNPROVEN", `Binding initiator ${binding.actorId} has no typed agent participation in event ${event.id}`);
      if (event.action?.lane === "schema-bound" && canonicalJson(event.action) !== canonicalJson(binding.action)) fail("EVENT_EXECUTION_CONFLICT", `Binding ${binding.id} conflicts with the occurrence's explicit mechanism`);
      if (event.action?.travelMode && event.action.travelMode !== binding.action.travelMode) fail("EVENT_EXECUTION_TRAVEL_CONFLICT", "The binding must preserve the occurrence's observed travel mode");
      issues.push(...resolveActionInvocation(binding.action, catalog.actionSchemas, catalog.entities, {
        actorId: binding.actorId, participants: event.participants, proposedDelta: event.observedOutcome,
        hasKnowledge: Boolean(event.observedKnowledge?.operations.length), hasTimeAdvance: Boolean(event.timeAdvance), hasSceneTransition: false,
      }).issues.map((issue) => ({ ...issue, path })));
    }
    if (binding.entryCheckpoint) {
      const checkpoint = binding.entryCheckpoint, entryKey = `${event.id}/${binding.actorId}`;
      if (entries.has(entryKey)) fail("EVENT_ENTRY_DUPLICATED", `Event ${event.id} has multiple entry bindings for ${binding.actorId}`);
      entries.add(entryKey);
      if (checkpoint.actorId !== binding.actorId) fail("EVENT_ENTRY_ACTOR_MISMATCH", "The entry checkpoint must belong to the binding's character");
      if (!event.participantPresence?.some((presence) => presence.entityId === binding.actorId && presence.mode === "physical")
        && !catalog.participations?.some((participation) => participation.eventId === event.id && participation.entityId === binding.actorId && participation.presence === "physical")) fail("EVENT_ENTRY_PRESENCE_UNPROVEN", "The character entry must precede an actual embodied occurrence");
      for (const presence of checkpoint.participantPresence) if (!event.participants.includes(presence.entityId) || catalog.entities.get(presence.entityId)?.kind !== "character") fail("EVENT_ENTRY_PRESENCE_INVALID", `Checkpoint presence ${presence.entityId} is not a participating character`);
    }
  }
  return issues;
}

/** Resolve only within one frozen catalog; this projection never writes the canonical occurrence. */
export function applyEventExecutions(events: readonly CanonicalEvent[], bindings: readonly EventExecution[]): CanonicalEvent[] {
  const index = new Map(events.map((event) => [event.id, event]));
  for (const binding of bindings) {
    const event = index.get(binding.canonicalEventId);
    if (!event) continue;
    index.set(event.id, { ...event, ...(binding.action ? { action: binding.action } : {}),
      ...(binding.entryCheckpoint ? { characterEntryCheckpoints: [
        ...(event.characterEntryCheckpoints ?? []).filter((checkpoint) => checkpoint.actorId !== binding.actorId), binding.entryCheckpoint,
      ].sort((a, b) => a.actorId.localeCompare(b.actorId)) } : {}) });
  }
  return events.map((event) => index.get(event.id)!);
}
