import { predicateSchema, stateOperationSchema, type StateFieldSpec } from "./model.js";
import type { ActionSchema } from "./action-ontology.js";
import { predicateReferences, stateOperationReferences } from "./state-references.js";

/** Schema reference positions shared by compilation and runtime. Never infer
 * identity from an ID suffix, free text, or a value without its field type. */
export const worldReferenceFields = {
  entityId: "entity", actorId: "entity", subjectEntityId: "entity", holderEntityId: "entity",
  fromActorId: "entity", toActorId: "entity", debtorActorId: "entity", creditorActorId: "entity",
  beneficiaryActorId: "entity", sourceActorId: "entity", authorityEntityId: "entity", subjectActorId: "entity",
  byActorId: "entity", acknowledgedByActorId: "entity", focalActorId: "entity", viewpointActorId: "entity",
  observerId: "entity", speakerId: "entity", documentId: "entity", actualSourceActorId: "entity", believedSourceActorId: "entity",
  fromLocationId: "entity", toLocationId: "entity", containerLocationId: "entity", containedLocationId: "entity", locationId: "entity",
  destinationEntityId: "entity", canonicalEntityId: "entity", boundEntityId: "entity", sceneActorId: "entity",
  targetActorId: "entity", targetEntityId: "entity", relationshipEntityId: "entity", recipientId: "entity",
  ownerId: "entity", ownerEntityId: "entity", listenerId: "entity", characterId: "entity", entryActorId: "entity",
  subject: "entity", speaker: "entity", entityIds: "entity", actorIds: "entity", entities: "entity", participants: "entity",
  targetEntityIds: "entity", targetIds: "entity", presentActorIds: "entity", viewpointActorIds: "entity", motivatedActorIds: "entity",
  jurisdictionEntityIds: "entity", locationIds: "entity", addresseeIds: "entity", exclusiveParticipantIds: "entity",
  consentActorIds: "entity", authorityEntityIds: "entity", peerEntityIds: "entity", carrierEntityIds: "entity",
  presentEntityIds: "entity", writableEntityIds: "entity",
  propositionId: "proposition", propositionIds: "proposition", contentPropositionId: "proposition", mechanismPropositionId: "proposition", interpretationPropositionId: "proposition",
  attributionId: "attribution", attributionIds: "attribution", sourceAttributionId: "attribution",
  claimId: "claim", claimIds: "claim", knownByClaimIds: "claim", requiresKnowledge: "claim", requiredKnowledgeClaimIds: "claim",
  blockedByKnowledge: "claim", forbidsKnowledge: "claim", focalKnowledgeClaimIds: "claim",
  eventId: "event", eventIds: "event", canonicalEventId: "event", canonicalEventIds: "event", causalParents: "event",
  sourceCanonicalEventId: "event", fromEventId: "event", toEventId: "event", anchorEventId: "event", beforeCanonicalEventId: "event",
  afterCanonicalEventIds: "event", afterExperiencedCanonicalEventIds: "event", triggerEventIds: "event", reversalEventIds: "event",
  supportingEventIds: "event", establishedByEventIds: "event", retiredByEventIds: "event", utteranceEventId: "event", messageEventId: "event",
  ruleId: "rule", ruleIds: "rule", activeRuleIds: "rule", overridesRuleIds: "rule",
  schemaId: "action", actionSchemaId: "action", actionSchemaIds: "action",
  sceneOccurrenceIds: "scene", frameId: "frame", eventFrameId: "frame", executionId: "event-execution", eventExecutionId: "event-execution",
  semanticEffectId: "semantic-effect", acquisitionId: "acquisition", priorAcquisitionId: "acquisition", premiseAcquisitionIds: "acquisition",
  observationId: "perception-observation", perceptionId: "perception-observation",
  utteranceExpressionId: "utterance-expression", expressionId: "utterance-expression", expressionIds: "utterance-expression",
  normTemplateId: "norm", overridesTemplateIds: "norm", processTemplateId: "process", overridesConstraintIds: "constraint",
  goalId: "goal", goalIds: "goal", affectedGoalIds: "goal", parentGoalId: "goal",
} as const;
export type WorldReferenceKind = typeof worldReferenceFields[keyof typeof worldReferenceFields];
export type WorldReference = { kind: WorldReferenceKind; id: string; pointer: string };
export type ReferenceFields = ReadonlyMap<string, Pick<StateFieldSpec, "valueType">>;
const escaped = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
const ignored = new Set(["evidence", "counterEvidence", "derivation", "identityConsumption", "description", "summary", "rationale", "interpretation"]);

/** Enumerate direct typed dependencies, including seeds, template bindings and
 * schema-bound parameters. Following the resulting graph is the caller's job. */
export function worldArtifactReferences(value: unknown, fields: ReferenceFields, pointer = "",
  actionSchemas?: ReadonlyMap<string, Pick<ActionSchema, "parameters">>): WorldReference[] {
  const refs: WorldReference[] = [];
  const add = (kind: WorldReferenceKind, value: unknown, at: string) => {
    if (typeof value === "string") refs.push({ kind, id: value, pointer: at });
    else if (Array.isArray(value)) value.forEach((id, i) => { if (typeof id === "string") refs.push({ kind, id, pointer: `${at}/${i}` }); });
  };
  const typedValue = (type: string | undefined, value: unknown, at: string) => {
    if (type === "entity-ref" && typeof value === "string" || type === "entity-ref-set" && Array.isArray(value)) add("entity", value, at);
  };
  const visit = (value: unknown, at: string, channel?: "norm" | "process") => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach((item, i) => visit(item, `${at}/${i}`, channel)); return; }
    const record = value as Record<string, unknown>;
    const operation = stateOperationSchema.safeParse(record), predicate = operation.success ? undefined : predicateSchema.safeParse(record);
    if (operation.success) { refs.push(...stateOperationReferences(operation.data, fields, at)); return; }
    if (predicate?.success) { refs.push(...predicateReferences(predicate.data, fields, at)); return; }
    for (const [key, child] of Object.entries(record)) {
      if (ignored.has(key)) continue;
      const next = `${at}/${escaped(key)}`;
      if (key === "parameters") {
        const specs = Array.isArray(child) ? child as ActionSchema["parameters"] : typeof record.schemaId === "string" ? actionSchemas?.get(record.schemaId)?.parameters ?? [] : [];
        for (const [i, spec] of specs.entries()) {
          if (Array.isArray(child)) (spec.allowedValues ?? []).forEach((v, j) => typedValue(spec.valueType, v, `${next}/${i}/allowedValues/${j}`));
          else typedValue(spec.valueType, child && typeof child === "object" ? (child as Record<string, unknown>)[spec.id] : undefined, `${next}/${escaped(spec.id)}`);
        }
        continue;
      }
      if (key === "value") {
        if (typeof record.field === "string") {
          const literal = child && typeof child === "object" && "source" in child && child.source === "literal" && "value" in child;
          typedValue(fields.get(record.field)?.valueType, literal ? child.value : child, literal ? `${next}/value` : next);
        }
        continue;
      }
      if (key === "object" && (!child || typeof child !== "object" || !("kind" in child))) continue;
      const kind = (worldReferenceFields as Readonly<Record<string, WorldReferenceKind>>)[key] ?? (key === "templateId" ? channel : undefined);
      if (kind) add(kind, child, next);
      visit(child, next, ["norm", "norms", "proposedNorms"].includes(key) ? "norm" : ["process", "processes", "proposedProcesses"].includes(key) ? "process" : channel);
    }
  };
  visit(value, pointer);
  return refs;
}
