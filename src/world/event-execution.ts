import { z } from "zod";
import { actionInvocationSchema, evidenceRefSchema, idSchema, type CanonicalEvent, type Entity, type EventParticipation, type ValidationIssue } from "./model.js";
import { resolveActionInvocation, type ActionSchema } from "./action-ontology.js";
import { canonicalJson } from "./canonical.js";

/** Executable-stage linkage leaves the earlier semantic occurrence immutable. */
export const eventExecutionSchema = z.object({
  id: idSchema, canonicalEventId: idSchema, actorId: idSchema,
  action: actionInvocationSchema.refine((action) => action.lane === "schema-bound", "Execution bindings require an explicit compiled mechanism"),
  evidence: z.array(evidenceRefSchema).min(1),
}).strict();
export type EventExecution = z.infer<typeof eventExecutionSchema>;

export function validateEventExecutions(bindings: readonly EventExecution[], catalog: {
  events: ReadonlyMap<string, CanonicalEvent>; entities: ReadonlyMap<string, Entity>; actionSchemas: ReadonlyMap<string, ActionSchema>;
  participations?: readonly EventParticipation[];
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [], seen = new Set<string>();
  for (const binding of bindings) {
    const path = `event-execution/${binding.id}`, fail = (code: string, message: string) => issues.push({ code, message, path });
    const event = catalog.events.get(binding.canonicalEventId);
    if (seen.has(binding.canonicalEventId)) fail("EVENT_EXECUTION_DUPLICATED", `Event ${binding.canonicalEventId} has multiple execution bindings`);
    seen.add(binding.canonicalEventId);
    if (!event) { fail("EVENT_EXECUTION_EVENT_MISSING", `Unknown canonical event '${binding.canonicalEventId}'`); continue; }
    const sources = new Set(event.evidence.map((reference) => reference.span.sourceId));
    if (sources.size !== 1 || binding.evidence.some((reference) => !sources.has(reference.span.sourceId))) fail("EVENT_EXECUTION_SOURCE_MISMATCH", "Execution binding and occurrence must belong to the same immutable novel");
    if (catalog.entities.get(binding.actorId)?.kind !== "character" || !event.participants.includes(binding.actorId)) fail("EVENT_EXECUTION_ACTOR_INVALID", "The execution initiator must be an actual participating character; presence alone does not establish agency");
    if (!catalog.participations?.some((participation) => participation.eventId === event.id && participation.entityId === binding.actorId && participation.role === "agent")) fail("EVENT_EXECUTION_AGENCY_UNPROVEN", `Binding initiator ${binding.actorId} has no typed agent participation in event ${event.id}`);
    if (event.action && canonicalJson(event.action) !== canonicalJson(binding.action)) fail("EVENT_EXECUTION_CONFLICT", `Binding ${binding.id} conflicts with the occurrence's explicit action`);
    issues.push(...resolveActionInvocation(binding.action, catalog.actionSchemas, catalog.entities, {
      actorId: binding.actorId, participants: event.participants, proposedDelta: event.observedOutcome,
      hasKnowledge: Boolean(event.observedKnowledge?.operations.length), hasTimeAdvance: Boolean(event.timeAdvance), hasSceneTransition: false,
    }).issues.map((issue) => ({ ...issue, path })));
  }
  return issues;
}

/** Resolve only within one frozen catalog; this projection never writes the canonical occurrence. */
export function applyEventExecutions(events: readonly CanonicalEvent[], bindings: readonly EventExecution[]): CanonicalEvent[] {
  const index = new Map(bindings.map((binding) => [binding.canonicalEventId, binding]));
  return events.map((event) => index.has(event.id) ? { ...event, action: index.get(event.id)!.action } : event);
}
