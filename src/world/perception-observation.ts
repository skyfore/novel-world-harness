import { z } from "zod";
import { contentHash } from "./canonical.js";
import { idSchema, evidenceRefSchema, textAnchorSchema, stateValueSchema, predicateSchema,
  type CanonicalEvent, type Entity, type EvidenceAssertion, type KnowledgeOperation, type Proposition,
  type ValidationIssue, type WorldState } from "./model.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry, evaluatePredicateTruth } from "./state.js";

export const PERCEPTION_OBSERVATION_VERSION = "perception-observation-v1" as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const perceptionObservationSchema = z.object({
  ontologyVersion: z.literal(PERCEPTION_OBSERVATION_VERSION), id: idSchema,
  observerId: idSchema, canonicalEventId: idSchema,
  cut: z.enum(["event-start", "event-end"]),
  channel: z.enum(["vision", "hearing", "touch", "smell", "taste", "interoception"]),
  phenomenon: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("state-value"), entityId: idSchema, field: z.string().min(1), value: stateValueSchema }).strict(),
    z.object({ kind: z.literal("sensory-phenomenon"), entityId: idSchema.optional(), description: z.string().trim().min(1).max(2_000) }).strict(),
  ]),
  access: z.object({ locationId: idSchema, conditions: z.array(predicateSchema).min(1).max(32) }).strict(),
  lowering: z.discriminatedUnion("status", [
    z.object({ status: z.literal("mapped"), mechanism: z.literal("direct-vision-v1") }).strict(),
    z.object({ status: z.literal("unmapped"), reason: z.enum(["unsupported-channel", "unsupported-phenomenon", "unresolved-access"]) }).strict(),
  ]),
  trace: z.object({
    observerMentionId: idSchema, observerMentionHash: hash,
    observerResolutionId: idSchema, observerResolutionHash: hash,
    eventMentionId: idSchema, eventMentionHash: hash,
    eventResolutionId: idSchema, eventResolutionHash: hash,
    anchors: z.array(textAnchorSchema).min(1).max(32),
  }).strict(),
  evidence: z.array(evidenceRefSchema).min(1),
}).strict();
export type PerceptionObservation = z.infer<typeof perceptionObservationSchema>;
const same = (left: unknown, right: unknown) => left !== undefined && right !== undefined && contentHash(left) === contentHash(right);

/** Source perception and executable sensory support are separate contracts. */
export function validatePerceptionObservation(observation: PerceptionObservation, catalog: {
  entities: ReadonlyMap<string, Entity>; events: ReadonlyMap<string, CanonicalEvent>;
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fail = (code: string, message: string, path: string) => issues.push({ code, message, path });
  const event = catalog.events.get(observation.canonicalEventId);
  if (!event) fail("PERCEPTION_EVENT_MISSING", "Perception requires its own canonical occurrence", "canonicalEventId");
  if (catalog.entities.get(observation.observerId)?.kind !== "character") fail("PERCEPTION_OBSERVER_MISSING", "Perception observer must be a canonical character", "observerId");
  if (catalog.entities.get(observation.access.locationId)?.kind !== "location") fail("PERCEPTION_LOCATION_MISSING", "Perception access requires a canonical location", "access.locationId");
  if (observation.phenomenon.entityId && !catalog.entities.has(observation.phenomenon.entityId)) fail("PERCEPTION_TARGET_MISSING", "Perception target is missing", "phenomenon.entityId");
  const sources = new Set([...observation.evidence.map(item => item.span.sourceId), ...observation.trace.anchors.map(item => item.sourceId)]);
  if (sources.size !== 1 || event?.evidence.some(item => !sources.has(item.span.sourceId))) fail("PERCEPTION_SOURCE_MISMATCH", "Perception evidence and occurrence must share one immutable source", "evidence");
  if (event && observation.trace.anchors.some(anchor => !event.evidence.some(ref => ref.span.sourceId === anchor.sourceId
    && ref.span.startByte !== undefined && ref.span.endByte !== undefined && ref.span.startByte <= anchor.startByte && anchor.endByte <= ref.span.endByte))) {
    fail("PERCEPTION_OCCURRENCE_MISMATCH", "Perception anchors must belong to this occurrence's byte evidence", "trace.anchors");
  }
  if (observation.phenomenon.kind === "state-value") {
    try { new StateSchemaRegistry(DEFAULT_STATE_FIELDS).validateOperation({ op: "set", entityId: observation.phenomenon.entityId, field: observation.phenomenon.field, value: observation.phenomenon.value }, catalog.entities); }
    catch (error) { fail("PERCEPTION_TARGET_UNSUPPORTED", error instanceof Error ? error.message : String(error), "phenomenon"); }
  }
  if (event && !event.participants.includes(observation.observerId)) fail("PERCEPTION_OBSERVER_TRACE_MISMATCH", "Observer must participate in the perception occurrence", "observerId");
  if (observation.lowering.status === "unmapped") return issues;
  if (observation.phenomenon.entityId && !event?.participants.includes(observation.phenomenon.entityId)) fail("PERCEPTION_TARGET_UNSUPPORTED", "Direct vision target must participate in this occurrence", "phenomenon.entityId");
  for (const condition of observation.access.conditions) {
    if (condition.op !== "fact-equals") { fail("PERCEPTION_ACCESS_UNSUPPORTED", "Registered direct vision supports only typed fact-equals access conditions; preserve other mechanisms as unmapped", "access.conditions"); continue; }
    try { new StateSchemaRegistry(DEFAULT_STATE_FIELDS).validateOperation({ op: "set", entityId: condition.entityId, field: condition.field, value: condition.value }, catalog.entities); }
    catch (error) { fail("PERCEPTION_ACCESS_UNSUPPORTED", error instanceof Error ? error.message : String(error), "access.conditions"); }
  }
  if (!event?.participantPresence?.some(item => item.entityId === observation.observerId && item.mode === "physical")) fail("PERCEPTION_ACCESS_UNSUPPORTED", "Direct vision requires a physically present observer", "observerId");
  const target = observation.phenomenon;
  // Public visibility is not sensory access. This registered mechanism supports
  // seeing a location's open/closed state, or a bodily present character there.
  const supported = observation.channel === "vision" && target.kind === "state-value" && (
    (target.field === "location.open" && target.entityId === observation.access.locationId && typeof target.value === "boolean")
    || (target.field === "character.location" && target.value === observation.access.locationId
      && event?.participantPresence?.some(item => item.entityId === target.entityId && item.mode === "physical")));
  if (!supported) fail("PERCEPTION_MECHANISM_UNSUPPORTED", "This phenomenon/channel has no registered direct-vision lowering; retain represented-unmapped meaning instead of inventing sensory authority", "lowering");
  const observerLocation = { op: "fact-equals", entityId: observation.observerId, field: "character.location", value: observation.access.locationId };
  if (!observation.access.conditions.some(condition => same(condition, observerLocation))) fail("PERCEPTION_ACCESS_UNSUPPORTED", "Access must require the observer's actual co-location", "access.conditions");
  if (target.kind === "state-value") {
    const predicate = { op: "fact-equals", entityId: target.entityId, field: target.field, value: target.value };
    const grounded = observation.cut === "event-start"
      ? event?.preconditions.some(condition => same(condition, predicate))
      : event?.observedOutcome.operations.some(operation => operation.op === "set" && operation.entityId === target.entityId && operation.field === target.field && same(operation.value, target.value));
    if (!grounded) fail("PERCEPTION_CUT_MISMATCH", "Perceived value must be established at this event's declared start/end cut", "cut");
  }
  return issues;
}

export function validatePerceptionObservationEvidence(observation: PerceptionObservation, assertions: readonly EvidenceAssertion[]): ValidationIssue[] {
  const paths = ["/observerId", "/canonicalEventId", "/cut", "/channel", "/access/locationId",
    ...observation.access.conditions.map((_, index) => `/access/conditions/${index}`),
    ...Object.keys(observation.phenomenon).filter(key => key !== "kind").map(key => `/phenomenon/${key}`)];
  return paths.filter(pointer => !assertions.some(assertion => assertion.target.artifactKind === "perception-observation"
    && assertion.target.artifactId === observation.id && assertion.target.jsonPointer === pointer
    && assertion.relation === "supports" && assertion.strength !== "weak-inference" && assertion.anchors.length
    && assertion.anchors.every(anchor => observation.trace.anchors.some(extent => extent.sourceId === anchor.sourceId && extent.startByte <= anchor.startByte && anchor.endByte <= extent.endByte))))
    .map(path => ({ code: "PERCEPTION_EVIDENCE_MISSING", message: `Perception ${observation.id} needs its own in-occurrence semantic evidence at ${path}`, path }));
}

/** The current event cut, not a later report or a mutable compiler store. */
export function validatePerceptionAcquisition(operation: KnowledgeOperation, catalog: {
  observations: ReadonlyMap<string, PerceptionObservation>; propositions: ReadonlyMap<string, Proposition>;
}, occurrence?: { eventIds: ReadonlySet<string>; before: WorldState; after: WorldState; schema: StateSchemaRegistry }, canonicalEventId?: string): ValidationIssue[] {
  if (operation.op !== "learn") return [];
  const fail = (code: string, message: string): ValidationIssue[] => [{ code, message, path: "perceptionId" }];
  if (!operation.perceptionId) {
    if (operation.acquisitionMode === "observed" && catalog.observations.size > 0 && operation.propositionId && catalog.propositions.has(operation.propositionId)) return fail("PERCEPTION_REQUIRED", "This frozen perception-aware context requires direct perception for observed canonical content. Do not delete provenance or change mode; stop for source compilation if no supported perception exists.");
    return [];
  }
  const observation = catalog.observations.get(operation.perceptionId);
  if (!observation) return fail("ACQUISITION_PERCEPTION_MISSING", "Perception is absent from the frozen scope. For compilation use same-source find_compiler_artifacts (kind perception-observation), copy results[].readArguments.ref into read_compiler_artifact.ref and payload.id into perceptionId, with at most one corrected retry. At runtime stop for host compilation; do not guess or retry unchanged.");
  if (observation.lowering.status !== "mapped") return fail("PERCEPTION_UNMAPPED", "Perception has no supported execution mapping. Preserve evidence and stop for host mechanism review; do not change mode or remove the perception reference.");
  if (operation.acquisitionMode !== "observed" || operation.sourceActorId || operation.attributionId || operation.expressionId || operation.actorId !== observation.observerId) return fail("ACQUISITION_PERCEPTION_MISMATCH", "Observed acquisition must preserve its actual observer and direct perception; deleting a report source is not a perception proof. Correct supported references once or stop for source review.");
  const proposition = operation.propositionId ? catalog.propositions.get(operation.propositionId) : undefined;
  const target = observation.phenomenon;
  if (!proposition || target.kind !== "state-value" || proposition.subjectEntityId !== target.entityId || proposition.relationId !== target.field
    || proposition.polarity !== "positive" || proposition.modality !== "asserted"
    || !same(proposition.object.kind === "entity" ? proposition.object.entityId : proposition.object.kind === "literal" ? proposition.object.value : undefined, target.value)) {
    return fail("ACQUISITION_PERCEPTION_CONTENT_MISMATCH", "Acquired content must be the perceived phenomenon, not the content of a heard report. Preserve drafts and inspect the exact phenomenon once; do not guess or relabel acquisition.");
  }
  if (canonicalEventId && canonicalEventId !== observation.canonicalEventId) return fail("PERCEPTION_CUT_NOT_CURRENT", "Compiler acquisition belongs to a different event than its perception. Preserve the source occurrence and stop; later reports require their own expression, not observed relabeling.");
  if (!occurrence) return [];
  if (!occurrence.eventIds.has(observation.canonicalEventId)) return fail("PERCEPTION_CUT_NOT_CURRENT", "This is not the perception's event cut. Stop; future canon or a later report cannot establish direct observation here. Prior experience requires an explicit remembered acquisition.");
  const state = observation.cut === "event-start" ? occurrence.before : occurrence.after;
  if (observation.access.conditions.some(condition => evaluatePredicateTruth(state, condition, occurrence.schema) !== "true")
    || evaluatePredicateTruth(state, { op: "fact-equals", entityId: target.entityId, field: target.field, value: target.value }, occurrence.schema) !== "true") {
    return fail("PERCEPTION_ACCESS_NOT_PROVEN", "Current world state does not prove this sensory access and phenomenon. Preserve head and stop; resolve the missing conditions through committed events, never erase access requirements or retry unchanged.");
  }
  return [];
}
