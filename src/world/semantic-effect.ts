import { z } from "zod";
import { contentHash } from "./canonical.js";
import { evidenceRefSchema, idSchema, stateValueSchema, storyTimeSchema, type CanonicalEvent, type Entity, type EventParticipation, type EvidenceAssertion, type ValidationIssue } from "./model.js";
import { validateEventExecutions, type EventExecution } from "./event-execution.js";
import type { ActionSchema } from "./action-ontology.js";

export const SEMANTIC_EFFECT_VERSION = "semantic-effect-v1" as const;
const common = {
  ontologyVersion: z.literal(SEMANTIC_EFFECT_VERSION), id: idSchema,
  canonicalEventId: idSchema, subjectEntityId: idSchema, validTime: storyTimeSchema,
  evidence: z.array(evidenceRefSchema).min(1),
};
const unmapped = z.object({ status: z.literal("unmapped"), reason: z.enum(["unsupported-mechanism", "unknown-duration", "missing-execution"]) }).strict();
export const semanticEffectSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("state-change"), args: z.object({ field: z.string().trim().min(1), value: stateValueSchema }).strict(),
    lowering: z.discriminatedUnion("status", [unmapped, z.object({ status: z.literal("mapped"), executionId: idSchema }).strict()]) }).strict(),
  z.object({ ...common, kind: z.literal("temporary-incapacity"), args: z.object({ capacity: z.enum(["action", "speech", "perception"]),
    duration: z.discriminatedUnion("kind", [z.object({ kind: z.literal("unknown") }).strict(), z.object({ kind: z.literal("days"), days: z.number().finite().positive() }).strict()]) }).strict(), lowering: unmapped }).strict(),
]);
export type SemanticEffect = z.infer<typeof semanticEffectSchema>;

/** Meaning is source data. Only an independently validated execution can lower it. */
export function validateSemanticEffect(effect: SemanticEffect, catalog: {
  entities: ReadonlyMap<string, Entity>; events: ReadonlyMap<string, CanonicalEvent>; eventExecutions?: ReadonlyMap<string, EventExecution>; actionSchemas?: ReadonlyMap<string, ActionSchema>; eventParticipations?: ReadonlyMap<string, EventParticipation>;
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [], event = catalog.events.get(effect.canonicalEventId);
  const fail = (code: string, message: string, path: string) => issues.push({ code, message, path });
  if (!event) fail("SEMANTIC_EFFECT_EVENT_MISSING", `Semantic effect ${effect.id} requires occurrence ${effect.canonicalEventId}`, "canonicalEventId");
  if (!catalog.entities.has(effect.subjectEntityId)) fail("SEMANTIC_EFFECT_SUBJECT_MISSING", `Unknown effect subject ${effect.subjectEntityId}`, "subjectEntityId");
  if (event && !event.participants.includes(effect.subjectEntityId)) fail("SEMANTIC_EFFECT_SUBJECT_OUTSIDE_EVENT", "Effect subject must participate in its occurrence", "subjectEntityId");
  if (event && contentHash(event.storyTime) !== contentHash(effect.validTime)) fail("SEMANTIC_EFFECT_TIME_MISMATCH", "Effect onset must retain its occurrence time, including unknown time", "validTime");
  if (effect.kind === "temporary-incapacity" && catalog.entities.get(effect.subjectEntityId)?.kind !== "character") fail("SEMANTIC_EFFECT_SUBJECT_KIND", "Incapacity requires a character subject", "subjectEntityId");
  if (effect.lowering.status === "mapped") {
    const execution = catalog.eventExecutions?.get(effect.lowering.executionId);
    if (!execution?.action || execution.canonicalEventId !== effect.canonicalEventId) fail("SEMANTIC_EFFECT_EXECUTION_MISSING", "Mapped effect requires an action execution of the same occurrence", "lowering.executionId");
    if (execution) issues.push(...validateEventExecutions([execution], { entities: catalog.entities, events: catalog.events, actionSchemas: catalog.actionSchemas ?? new Map(), participations: [...(catalog.eventParticipations?.values() ?? [])] }));
    if (effect.kind === "state-change" && !event?.observedOutcome.operations.some(op => op.op === "set" && op.entityId === effect.subjectEntityId && op.field === effect.args.field && contentHash(op.value) === contentHash(effect.args.value))) fail("SEMANTIC_EFFECT_LOWERING_MISMATCH", "Mapped effect must match an exact set operation in the validated occurrence", "args");
  }
  return issues;
}

/** Every semantic field needs this artifact's own exact source support. */
export function validateSemanticEffectEvidence(effect: SemanticEffect, assertions: readonly EvidenceAssertion[]): ValidationIssue[] {
  const paths = ["/canonicalEventId", "/subjectEntityId", "/kind", "/validTime", ...(effect.kind === "state-change" ? ["/args/field", "/args/value"] : ["/args/capacity", "/args/duration"])];
  return paths.filter(pointer => !assertions.some(a => a.target.artifactKind === "semantic-effect" && a.target.artifactId === effect.id && a.target.jsonPointer === pointer && a.relation === "supports" && a.anchors.length > 0))
    .map(pointer => ({ code: "SEMANTIC_EFFECT_EVIDENCE_MISSING", message: `Semantic effect ${effect.id} requires exact support at ${pointer}`, path: pointer }));
}

/** Called only for attempted canonical realization, never to activate future canon. */
export function semanticEffectRealizationIssues(effects: Iterable<SemanticEffect>, eventIds: ReadonlySet<string>): ValidationIssue[] {
  return [...effects].filter(effect => eventIds.has(effect.canonicalEventId) && effect.lowering.status === "unmapped")
    .map(effect => ({ code: "SEMANTIC_EFFECT_UNMAPPED", message: `Occurrence ${effect.canonicalEventId} has unmapped semantic effect ${effect.id}; stop realization until its original mechanism is supported`, path: "semanticEffects" }));
}
