import { entryAgencyIssues, remoteEntryOccurrenceIssues, type EntryAgencyCatalog } from "./entry-agency.js";
import type { ProcessTemplate } from "./process-ontology.js";
import { z } from "zod";
import { schemaBoundActionInvocationSchema, characterEntryCheckpointSchema, entryProjectionSeedSchema, evidenceRefSchema, idSchema, type CanonicalEvent, type Entity, type EventParticipation, type ValidationIssue, type EvidenceAssertion } from "./model.js";
import { resolveActionInvocation, type ActionSchema } from "./action-ontology.js";
import { canonicalJson } from "./canonical.js";

/** Executable-stage linkage leaves the earlier semantic occurrence immutable. */
export const eventExecutionSchema = z.object({
  id: idSchema, canonicalEventId: idSchema, actorId: idSchema,
  // Express the lane structurally so JSON Schema shown to the model matches
  // runtime validation. A refine on the union advertised the forbidden ad-hoc
  // lane to providers and rejected it only after they submitted a proposal.
  action: schemaBoundActionInvocationSchema.optional(),
  processRecoveries: z.array(z.object({ processTemplateId: idSchema, subjectEntityId: idSchema, outcomeId: idSchema }).strict()).min(1).max(32).optional(),
  entryCheckpoint: characterEntryCheckpointSchema.safeExtend({ projectionSeed: entryProjectionSeedSchema }).optional(),
  evidence: z.array(evidenceRefSchema).min(1),
}).strict().refine((binding) => Boolean(binding.action || binding.entryCheckpoint || binding.processRecoveries?.length), "An execution binding must supply an action mechanism, process recovery or a complete character entry checkpoint");
export type EventExecution = z.infer<typeof eventExecutionSchema>;

export function validateEventExecutions(bindings: readonly EventExecution[], catalog: {
  events: ReadonlyMap<string, CanonicalEvent>; entities: ReadonlyMap<string, Entity>; actionSchemas: ReadonlyMap<string, ActionSchema>;
  participations?: readonly EventParticipation[];
  processTemplates?: ReadonlyMap<string, ProcessTemplate>;
  acquisitions?: EntryAgencyCatalog["acquisitions"];
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [], seen = new Set<string>(), entries = new Set<string>(), recoveries = new Set<string>();
  for (const binding of bindings) {
    const path = `event-execution/${binding.id}`, fail = (code: string, message: string) => issues.push({ code, message: message + (code === "PROCESS_RECOVERY_MECHANISM_MISSING"
      ? "; call same-source find_compiler_artifacts with kind process-template, copy results[].readArguments.ref into read_compiler_artifact.ref and payload.id into processTemplateId. At most one corrected retry if the source proves this recovery; otherwise stop, never guess IDs or widen scope."
      : code.startsWith("PROCESS_RECOVERY_") ? "; preserve draft and stop for source-supported mechanism review; never retry unchanged or invent recovery." : ""), path });
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
    for (const recovery of binding.processRecoveries ?? []) {
      const key = `${event.id}/${recovery.processTemplateId}/${recovery.subjectEntityId}`;
      if (recoveries.has(key)) fail("PROCESS_RECOVERY_DUPLICATED", "A recovery target may appear only once per occurrence");
      recoveries.add(key);
      const template = catalog.processTemplates?.get(recovery.processTemplateId);
      if (!template?.incapacity || !template.outcomeIds.includes(recovery.outcomeId)) { fail("PROCESS_RECOVERY_MECHANISM_MISSING", "Recovery requires a declared incapacity template and outcome"); continue; }
      if (!event.participantPresence?.some(item => item.entityId === recovery.subjectEntityId && item.mode === "physical")) fail("PROCESS_RECOVERY_SUBJECT_UNPROVEN", "Recovery requires the actual physically present patient");
      if (binding.action) {
        const action = binding.action;
        if (!action.roleBindings.some(role => role.roleId === template.incapacity!.ownerRoleId && role.entityIds.length === 1 && role.entityIds[0] === recovery.subjectEntityId)
          || !template.actorControls?.some(control => control.op === "advance-process" && control.actionPattern.kind === "schema" && control.actionPattern.schemaId === action.schemaId)
          || !template.actorControls?.some(control => control.op === "finish-process" && control.outcomeId === recovery.outcomeId && control.actionPattern.kind === "schema" && control.actionPattern.schemaId === action.schemaId)) fail("PROCESS_RECOVERY_CONTROL_MISMATCH", "Recovery must use the declared action control and bind the same patient");
      } else if (template.incapacity.duration.kind !== "days" || !template.transitions.some(transition => transition.toPhaseId === template.incapacity!.recoveryPhaseId && transition.onDue?.outcomeId === recovery.outcomeId)) fail("PROCESS_RECOVERY_DURATION_UNKNOWN", "Natural recovery requires a declared known-duration due transition");
    }
    if (binding.entryCheckpoint) {
      const checkpoint = binding.entryCheckpoint, entryKey = `${event.id}/${binding.actorId}`;
      if (entries.has(entryKey)) fail("EVENT_ENTRY_DUPLICATED", `Event ${event.id} has multiple entry bindings for ${binding.actorId}`);
      entries.add(entryKey);
      if (checkpoint.actorId !== binding.actorId) fail("EVENT_ENTRY_ACTOR_MISMATCH", "The entry checkpoint must belong to the binding's character");
      const entryMode = checkpoint.participantPresence.find(item => item.entityId === binding.actorId)?.mode;
      if (!event.participantPresence?.some((presence) => presence.entityId === binding.actorId && presence.mode === entryMode)
        && !catalog.participations?.some((participation) => participation.eventId === event.id && participation.entityId === binding.actorId && participation.presence === entryMode)) fail("EVENT_ENTRY_PRESENCE_UNPROVEN", "The character entry requires matching bodily or remote participation in this occurrence");
      issues.push(...remoteEntryOccurrenceIssues(binding.actorId, checkpoint, event, catalog.participations));
      issues.push(...entryAgencyIssues(binding.actorId, checkpoint, { ...catalog, sourceId: [...sources][0] }).map(issue => ({ ...issue, path: `${path}/entryCheckpoint/${issue.path}` })));
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

export function validateProcessRecoveryEvidence(binding: EventExecution, assertions: readonly EvidenceAssertion[]): ValidationIssue[] {
  if (!binding.processRecoveries?.length) return [];
  const pointers = ["/canonicalEventId", "/actorId", ...(binding.action ? ["/action"] : []), ...(binding.processRecoveries ?? []).flatMap((_, index) => ["processTemplateId", "subjectEntityId", "outcomeId"].map(field => `/processRecoveries/${index}/${field}`))];
  return pointers.filter(pointer => !assertions.some(assertion => assertion.target.artifactKind === "event-execution" && assertion.target.artifactId === binding.id && assertion.target.jsonPointer === pointer && assertion.relation === "supports" && assertion.strength !== "weak-inference" && assertion.anchors.length)).map(path => ({ code: "PROCESS_RECOVERY_EVIDENCE_MISSING", message: `Recovery ${binding.id} requires exact source evidence at ${path}; preserve draft and stop for source review`, path }));
}
