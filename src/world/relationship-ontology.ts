import { z } from "zod";
import {
  evidenceRefSchema,
  idSchema,
  storyTimeSchema,
  type CanonicalEvent,
  type EvidenceAssertion,
  type EvidenceRef,
  type StoryTime,
  type ValidationIssue,
  type WorldState,
} from "./model.js";
import { compareStoryTime } from "./time.js";
import { policyEpisodeTimeActive, policyStoryScopeActive } from "./policy-time.js";

export const RELATIONSHIP_ONTOLOGY_VERSION = "relationship-v1" as const;

/** Primary social form. Dynamic attitude and obligation are modeled separately. */
export const RELATIONSHIP_TYPE_IDS = [
  "kinship",
  "friendship",
  "romantic",
  "alliance",
  "rivalry",
  "authority",
  "mentorship",
  "service",
  "debt",
  "caregiving",
  "acquaintance",
  "enmity",
] as const;

export const relationshipTypeIdSchema = z.enum(RELATIONSHIP_TYPE_IDS);
export type RelationshipTypeId = z.infer<typeof relationshipTypeIdSchema>;

export const RELATIONSHIP_STANCE_DIMENSION_IDS = [
  "trust",
  "affinity",
  "respect",
  "perceived-threat",
  "dependence",
  "influence",
] as const;

export const relationshipStanceDimensionIdSchema = z.enum(RELATIONSHIP_STANCE_DIMENSION_IDS);
export type RelationshipStanceDimensionId = z.infer<typeof relationshipStanceDimensionIdSchema>;

export type RelationshipStanceDimensionDefinition = {
  id: RelationshipStanceDimensionId;
  ontologyVersion: typeof RELATIONSHIP_ONTOLOGY_VERSION;
  description: string;
  negativeAnchor: string;
  neutralAnchor: string;
  positiveAnchor: string;
};

/** Directional, behaviorally anchored dimensions; none is a moral or clinical judgment. */
export const RELATIONSHIP_STANCE_DIMENSIONS: readonly RelationshipStanceDimensionDefinition[] = Object.freeze([
  {
    id: "trust",
    ontologyVersion: RELATIONSHIP_ONTOLOGY_VERSION,
    description: "Readiness of the source actor to rely on the target's word, competence, or goodwill.",
    negativeAnchor: "Actively distrusts or verifies the target before relying on them.",
    neutralAnchor: "Reliance remains undecided or varies with the immediate evidence.",
    positiveAnchor: "Relies on the target despite meaningful vulnerability or incomplete verification.",
  },
  {
    id: "affinity",
    ontologyVersion: RELATIONSHIP_ONTOLOGY_VERSION,
    description: "The source actor's attraction to or aversion from continued social connection with the target.",
    negativeAnchor: "Avoids, rejects, or resents connection with the target.",
    neutralAnchor: "Neither seeks nor avoids connection beyond present practical needs.",
    positiveAnchor: "Seeks proximity, goodwill, or continued connection with the target.",
  },
  {
    id: "respect",
    ontologyVersion: RELATIONSHIP_ONTOLOGY_VERSION,
    description: "The source actor's valuation of the target's judgment, standing, or conduct.",
    negativeAnchor: "Dismisses or devalues the target's judgment or standing.",
    neutralAnchor: "Assigns no durable positive or negative standing to the target.",
    positiveAnchor: "Defers to or gives material weight to the target's judgment or standing.",
  },
  {
    id: "perceived-threat",
    ontologyVersion: RELATIONSHIP_ONTOLOGY_VERSION,
    description: "How strongly the source actor treats the target as a likely source of harm or loss.",
    negativeAnchor: "Treats the target as protective or as reducing danger.",
    neutralAnchor: "Does not currently treat the target as either protective or threatening.",
    positiveAnchor: "Anticipates harm, coercion, betrayal, or loss from the target.",
  },
  {
    id: "dependence",
    ontologyVersion: RELATIONSHIP_ONTOLOGY_VERSION,
    description: "How much the source actor's goals or welfare rely on the target's continued support.",
    negativeAnchor: "Maintains deliberate independence from the target.",
    neutralAnchor: "Can coordinate with the target without durable reliance.",
    positiveAnchor: "Relies materially or socially on the target for important outcomes.",
  },
  {
    id: "influence",
    ontologyVersion: RELATIONSHIP_ONTOLOGY_VERSION,
    description: "How strongly the target can redirect the source actor's choices.",
    negativeAnchor: "Resists or acts contrary to the target's attempts at direction.",
    neutralAnchor: "Weighs the target's input without a durable tendency to follow it.",
    positiveAnchor: "Frequently changes choices in response to the target's wishes or judgment.",
  },
]);

export const RELATIONSHIP_OBLIGATION_TYPE_IDS = [
  "protect",
  "obey",
  "repay",
  "provide",
  "disclose",
  "refrain",
  "cooperate",
  "care",
  "remain-loyal",
] as const;

export const relationshipObligationTypeIdSchema = z.enum(RELATIONSHIP_OBLIGATION_TYPE_IDS);
export type RelationshipObligationTypeId = z.infer<typeof relationshipObligationTypeIdSchema>;

const interpretationStatusSchema = z.enum(["supported", "contested"]);
const relationshipStoryTimeSchema = storyTimeSchema.refine(
  (value) => value.kind !== "relative" || value.relation !== "during",
  "A relative relationship-policy validity must be before or after its anchor event",
);
const relationshipChangeStartSchema = storyTimeSchema.refine(
  (value) => value.kind !== "relative" || value.relation === "after",
  "A relative relationship-change start must be after its anchor event",
);
const relationshipChangeEndSchema = storyTimeSchema.refine(
  (value) => value.kind !== "relative" || value.relation === "before",
  "A relative relationship-change end must be before its anchor event",
);

const uniqueIds = (maximum = 32) => z.array(idSchema).max(maximum)
  .refine((values) => new Set(values).size === values.length, "IDs must be unique");

const relationshipPolicyActivationSchema = z.object({
  afterWorldEventIds: uniqueIds().default([]),
  afterExperiencedEventIds: uniqueIds().default([]),
  requiresKnowledge: uniqueIds(64).default([]),
  storyWindow: relationshipStoryTimeSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.afterWorldEventIds.length
    && !value.afterExperiencedEventIds.length
    && !value.requiresKnowledge.length
    && !value.storyWindow) {
    ctx.addIssue({ code: "custom", message: "Relationship-policy activation must declare at least one event, knowledge, or story-time gate" });
  }
});

const relationshipPolicyResolutionSchema = z.object({
  afterWorldEventIds: uniqueIds().default([]),
  afterExperiencedEventIds: uniqueIds().default([]),
  requiresKnowledge: uniqueIds(64).default([]),
}).strict().superRefine((value, ctx) => {
  if (!value.afterWorldEventIds.length
    && !value.afterExperiencedEventIds.length
    && !value.requiresKnowledge.length) {
    ctx.addIssue({ code: "custom", message: "Relationship-policy resolution must declare at least one event or knowledge gate" });
  }
});

const relationshipPairFields = {
  actorId: idSchema,
  relationshipEntityId: idSchema,
  targetEntityId: idSchema,
};

export const relationshipStanceSchema = z.object({
  id: idSchema,
  ...relationshipPairFields,
  dimensionId: relationshipStanceDimensionIdSchema,
  value: z.number().finite().min(-1).max(1),
  stability: z.enum(["stable", "situational"]),
  basis: z.enum(["explicit-characterization", "repeated-interaction", "inferred-pattern"]),
  validStoryTime: relationshipStoryTimeSchema.optional(),
  status: interpretationStatusSchema,
  confidence: z.number().finite().min(0).max(1),
  evidence: z.array(evidenceRefSchema).min(1).max(64),
  counterEvidence: z.array(evidenceRefSchema).min(1).max(64).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.basis === "explicit-characterization"
    && !value.evidence.some((reference) => reference.strength === "explicit")) {
    ctx.addIssue({ code: "custom", path: ["basis"], message: "Explicit relationship characterization requires explicit evidence" });
  }
  if (value.stability === "stable" && value.basis !== "explicit-characterization"
    && distinctEvidenceSpans(value.evidence) < 2) {
    ctx.addIssue({ code: "custom", path: ["evidence"], message: "A stable inferred stance requires at least two distinct source spans" });
  }
  validateCounterEvidence(value, ctx);
});
export type RelationshipStance = z.infer<typeof relationshipStanceSchema>;

export const relationshipObligationSchema = z.object({
  id: idSchema,
  ...relationshipPairFields,
  typeId: relationshipObligationTypeIdSchema,
  contentPropositionId: idSchema,
  priority: z.number().finite().min(0).max(1),
  basis: z.enum(["explicit-promise", "social-role", "debt", "command", "inferred-expectation"]),
  activation: relationshipPolicyActivationSchema.optional(),
  resolution: relationshipPolicyResolutionSchema.optional(),
  status: interpretationStatusSchema,
  confidence: z.number().finite().min(0).max(1),
  evidence: z.array(evidenceRefSchema).min(1).max(64),
  counterEvidence: z.array(evidenceRefSchema).min(1).max(64).optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.basis === "explicit-promise" || value.basis === "command")
    && !value.evidence.some((reference) => reference.strength === "explicit")) {
    ctx.addIssue({ code: "custom", path: ["basis"], message: `${value.basis} requires explicit evidence` });
  }
  validateCounterEvidence(value, ctx);
});
export type RelationshipObligation = z.infer<typeof relationshipObligationSchema>;

export const relationshipChangeEpisodeSchema = z.object({
  id: idSchema,
  ...relationshipPairFields,
  triggerMode: z.enum(["world", "experienced"]),
  triggerEventIds: uniqueIds().min(1),
  beforeStanceIds: uniqueIds(),
  afterStanceIds: uniqueIds(),
  beforeObligationIds: uniqueIds(),
  afterObligationIds: uniqueIds(),
  mechanismPropositionId: idSchema,
  startsAt: relationshipChangeStartSchema,
  endsAt: relationshipChangeEndSchema.optional(),
  decay: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }).strict(),
    z.object({ kind: z.literal("event-dependent"), reversalEventIds: uniqueIds().min(1) }).strict(),
  ]),
  evidenceStatus: interpretationStatusSchema,
  confidence: z.number().finite().min(0).max(1),
  evidence: z.array(evidenceRefSchema).min(1).max(64),
  counterEvidence: z.array(evidenceRefSchema).min(1).max(64).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.afterStanceIds.length && !value.afterObligationIds.length) {
    ctx.addIssue({ code: "custom", path: ["afterStanceIds"], message: "A relationship change must install at least one stance or obligation" });
  }
  for (const [beforeField, beforeIds, afterField, afterIds] of [
    ["beforeStanceIds", value.beforeStanceIds, "afterStanceIds", value.afterStanceIds],
    ["beforeObligationIds", value.beforeObligationIds, "afterObligationIds", value.afterObligationIds],
  ] as const) {
    const overlap = beforeIds.filter((id) => afterIds.includes(id));
    if (overlap.length) {
      ctx.addIssue({ code: "custom", path: [afterField], message: `${beforeField}/${afterField} must be distinct: ${overlap.join(", ")}` });
    }
  }
  if (value.endsAt && compareStoryTime(value.endsAt, value.startsAt) === -1) {
    ctx.addIssue({ code: "custom", path: ["endsAt"], message: "Relationship change cannot end before it starts" });
  }
  validateCounterEvidence({ status: value.evidenceStatus, counterEvidence: value.counterEvidence }, ctx, "evidenceStatus");
});
export type RelationshipChangeEpisode = z.infer<typeof relationshipChangeEpisodeSchema>;

export const relationshipOntologyModelFields = {
  relationshipOntologyVersion: z.literal(RELATIONSHIP_ONTOLOGY_VERSION).optional(),
  relationshipStances: z.array(relationshipStanceSchema).max(256).optional(),
  relationshipObligations: z.array(relationshipObligationSchema).max(256).optional(),
  relationshipChanges: z.array(relationshipChangeEpisodeSchema).max(256).optional(),
};

export type RelationshipOntologyModel = {
  actorId: string;
  relationshipOntologyVersion?: typeof RELATIONSHIP_ONTOLOGY_VERSION;
  relationshipStances?: RelationshipStance[];
  relationshipObligations?: RelationshipObligation[];
  relationshipChanges?: RelationshipChangeEpisode[];
};

export type RelationshipOntologyReferenceCatalog = {
  entities: ReadonlyMap<string, { kind: string }>;
  propositions: ReadonlySet<string>;
  claims: ReadonlySet<string>;
  events: ReadonlyMap<string, Pick<CanonicalEvent, "participants" | "participantPresence">>;
};

export function validateRelationshipOntologyReferences(
  model: RelationshipOntologyModel,
  catalog: RelationshipOntologyReferenceCatalog,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const stances = new Map((model.relationshipStances ?? []).map((item) => [item.id, item]));
  const obligations = new Map((model.relationshipObligations ?? []).map((item) => [item.id, item]));
  const validatePair = (item: RelationshipPair, prefix: string, label: string) => {
    if (item.actorId !== model.actorId) {
      issues.push(issue("RELATIONSHIP_ONTOLOGY_ACTOR_MISMATCH", `${label} belongs to ${item.actorId}, not model actor ${model.actorId}`, `${prefix}.actorId`));
    }
    if (catalog.entities.get(item.relationshipEntityId)?.kind !== "relationship") {
      issues.push(issue("INVALID_RELATIONSHIP_ENTITY", `${label} references ${item.relationshipEntityId}, which is not a relationship entity`, `${prefix}.relationshipEntityId`));
    }
    const targetKind = catalog.entities.get(item.targetEntityId)?.kind;
    if (!targetKind) {
      issues.push(issue("UNKNOWN_RELATIONSHIP_TARGET", `${label} targets unknown entity ${item.targetEntityId}`, `${prefix}.targetEntityId`));
    } else if (!["character", "faction", "institution"].includes(targetKind)) {
      issues.push(issue("INVALID_RELATIONSHIP_TARGET", `${label} targets ${targetKind} entity ${item.targetEntityId}; social targets must be characters, factions, or institutions`, `${prefix}.targetEntityId`));
    }
    if (item.targetEntityId === model.actorId) {
      issues.push(issue("SELF_RELATIONSHIP_TARGET", `${label} cannot target its own actor`, `${prefix}.targetEntityId`));
    }
  };
  for (let index = 0; index < (model.relationshipStances?.length ?? 0); index += 1) {
    const item = model.relationshipStances![index]!;
    const prefix = `relationshipStances.${index}`;
    validatePair(item, prefix, `Relationship stance ${item.id}`);
    validateStoryAnchor(item.validStoryTime, catalog.events, `${prefix}.validStoryTime`, issues);
  }
  for (let index = 0; index < (model.relationshipObligations?.length ?? 0); index += 1) {
    const item = model.relationshipObligations![index]!;
    const prefix = `relationshipObligations.${index}`;
    validatePair(item, prefix, `Relationship obligation ${item.id}`);
    if (!catalog.propositions.has(item.contentPropositionId)) {
      issues.push(issue("UNKNOWN_OBLIGATION_PROPOSITION", `Relationship obligation ${item.id} references unknown proposition ${item.contentPropositionId}`, `${prefix}.contentPropositionId`));
    }
    validatePolicyActivation(item.activation, model.actorId, catalog, `${prefix}.activation`, issues);
    validatePolicyResolution(item.resolution, model.actorId, catalog, `${prefix}.resolution`, issues);
  }
  for (let index = 0; index < (model.relationshipChanges?.length ?? 0); index += 1) {
    const item = model.relationshipChanges![index]!;
    const prefix = `relationshipChanges.${index}`;
    validatePair(item, prefix, `Relationship change ${item.id}`);
    item.triggerEventIds.forEach((eventId, eventIndex) => {
      validateEventReference(eventId, item.triggerMode === "experienced", model.actorId, catalog.events, `${prefix}.triggerEventIds.${eventIndex}`, issues);
    });
    if (!catalog.propositions.has(item.mechanismPropositionId)) {
      issues.push(issue("UNKNOWN_RELATIONSHIP_MECHANISM", `Relationship change ${item.id} references unknown proposition ${item.mechanismPropositionId}`, `${prefix}.mechanismPropositionId`));
    }
    for (const [field, ids, records] of [
      ["beforeStanceIds", item.beforeStanceIds, stances],
      ["afterStanceIds", item.afterStanceIds, stances],
      ["beforeObligationIds", item.beforeObligationIds, obligations],
      ["afterObligationIds", item.afterObligationIds, obligations],
    ] as const) {
      ids.forEach((id, itemIndex) => {
        const referenced = records.get(id);
        if (!referenced) {
          issues.push(issue("UNKNOWN_RELATIONSHIP_CHANGE_ITEM", `Relationship change ${item.id} references unknown policy item ${id}`, `${prefix}.${field}.${itemIndex}`));
        } else if (!sameRelationshipPair(item, referenced)) {
          issues.push(issue("RELATIONSHIP_CHANGE_PAIR_MISMATCH", `Relationship change ${item.id} references ${id} from a different directed relationship`, `${prefix}.${field}.${itemIndex}`));
        }
      });
    }
    validateStoryAnchor(item.startsAt, catalog.events, `${prefix}.startsAt`, issues);
    validateStoryAnchor(item.endsAt, catalog.events, `${prefix}.endsAt`, issues);
    if (item.decay.kind === "event-dependent") {
      item.decay.reversalEventIds.forEach((eventId, eventIndex) => {
        validateEventReference(eventId, false, model.actorId, catalog.events, `${prefix}.decay.reversalEventIds.${eventIndex}`, issues);
      });
    }
  }
  return issues;
}

export function validateRelationshipOntologyEvidenceAssertions(
  model: RelationshipOntologyModel,
  assertions: readonly EvidenceAssertion[],
): ValidationIssue[] {
  if (model.relationshipOntologyVersion !== RELATIONSHIP_ONTOLOGY_VERSION) return [];
  const issues: ValidationIssue[] = [];
  const validateItem = (
    field: "relationshipStances" | "relationshipObligations" | "relationshipChanges",
    index: number,
    item: { id: string; evidence: readonly EvidenceRef[]; counterEvidence?: readonly EvidenceRef[] },
    status: "supported" | "contested",
  ): EvidenceAssertion[] => {
    const pointer = `/${field}/${index}`;
    const selected = assertions.filter((assertion) => assertion.target.jsonPointer === pointer
      || assertion.target.jsonPointer.startsWith(`${pointer}/`));
    const supports = selected.filter((assertion) => assertion.relation === "supports");
    const contradicts = selected.filter((assertion) => assertion.relation === "contradicts");
    if (!supports.length) {
      issues.push(issue("MISSING_EXACT_RELATIONSHIP_SUPPORT", `${field} item ${item.id} requires exact supporting evidence`, `${field}.${index}`));
    }
    if (status === "contested" && !contradicts.length) {
      issues.push(issue("MISSING_EXACT_RELATIONSHIP_COUNTER_EVIDENCE", `Contested ${field} item ${item.id} requires exact contradicting evidence`, `${field}.${index}`));
    }
    if (status === "supported" && contradicts.length) {
      issues.push(issue("UNDECLARED_RELATIONSHIP_CONTEST", `${field} item ${item.id} has contradicting evidence but is marked supported`, `${field}.${index}`));
    }
    const supportKeys = assertionEvidenceKeys(supports);
    const counterKeys = assertionEvidenceKeys(contradicts);
    if (!sameSet(supportKeys, new Set(item.evidence.map(evidenceKey)))) {
      issues.push(issue("RELATIONSHIP_SUPPORT_BINDING_MISMATCH", `${field} item ${item.id} embedded evidence does not exactly match its supporting assertions`, `${field}.${index}.evidence`));
    }
    if (!sameSet(counterKeys, new Set((item.counterEvidence ?? []).map(evidenceKey)))) {
      issues.push(issue("RELATIONSHIP_COUNTER_BINDING_MISMATCH", `${field} item ${item.id} embedded counter-evidence does not exactly match its contradicting assertions`, `${field}.${index}.counterEvidence`));
    }
    return supports;
  };
  (model.relationshipStances ?? []).forEach((item, index) => {
    const supports = validateItem("relationshipStances", index, item, item.status);
    if (item.basis === "explicit-characterization" && !supports.some((assertion) => assertion.strength === "explicit")) {
      issues.push(issue("MISSING_EXACT_EXPLICIT_RELATIONSHIP_CHARACTERIZATION", `Relationship stance ${item.id} requires exact explicit support`, `relationshipStances.${index}.basis`));
    }
    if (item.stability === "stable" && item.basis !== "explicit-characterization"
      && distinctAssertionAnchors(supports) < 2) {
      issues.push(issue("INSUFFICIENT_EXACT_STABLE_RELATIONSHIP_EVIDENCE", `Stable inferred stance ${item.id} requires two distinct exact anchors`, `relationshipStances.${index}.evidence`));
    }
  });
  (model.relationshipObligations ?? []).forEach((item, index) => {
    const supports = validateItem("relationshipObligations", index, item, item.status);
    if ((item.basis === "explicit-promise" || item.basis === "command")
      && !supports.some((assertion) => assertion.strength === "explicit")) {
      issues.push(issue("MISSING_EXACT_EXPLICIT_OBLIGATION", `Relationship obligation ${item.id} requires exact explicit support`, `relationshipObligations.${index}.basis`));
    }
  });
  (model.relationshipChanges ?? []).forEach((item, index) => {
    validateItem("relationshipChanges", index, item, item.evidenceStatus);
  });
  return issues;
}

export type EffectiveRelationshipStance = Pick<RelationshipStance,
  "id" | "relationshipEntityId" | "targetEntityId" | "dimensionId" | "value" | "stability" | "confidence">
  & { relationshipType: RelationshipTypeId };
export type EffectiveRelationshipObligation = Pick<RelationshipObligation,
  "id" | "relationshipEntityId" | "targetEntityId" | "typeId" | "priority" | "confidence">
  & { relationshipType: RelationshipTypeId };
export type EffectiveRelationshipChange = Pick<RelationshipChangeEpisode,
  "id" | "relationshipEntityId" | "targetEntityId" | "afterStanceIds" | "afterObligationIds" | "confidence">
  & { relationshipType: RelationshipTypeId; status: "active" };

export type EffectiveRelationshipOntology = {
  relationshipStances: EffectiveRelationshipStance[];
  relationshipObligations: EffectiveRelationshipObligation[];
  relationshipChanges: EffectiveRelationshipChange[];
};

export function resolveRelationshipOntology(
  model: RelationshipOntologyModel,
  input: {
    state: WorldState;
    knownClaimIds: ReadonlySet<string>;
    realizedCanonicalEventIds: ReadonlySet<string>;
    experiencedCanonicalEventIds: ReadonlySet<string>;
    storyTime?: StoryTime;
  },
): EffectiveRelationshipOntology {
  const descriptorFor = (item: RelationshipPair) => activeRelationshipDescriptor(input.state, item);
  const supportedChanges = (model.relationshipChanges ?? [])
    .filter((item) => item.evidenceStatus !== "contested")
    .filter((item) => descriptorFor(item));
  const activeChanges = supportedChanges.filter((item) => {
    const triggers = item.triggerMode === "experienced"
      ? input.experiencedCanonicalEventIds
      : input.realizedCanonicalEventIds;
    if (!item.triggerEventIds.every((eventId) => triggers.has(eventId))) return false;
    if (!policyEpisodeTimeActive(input.storyTime, item.startsAt, item.endsAt, input.realizedCanonicalEventIds)) return false;
    return item.decay.kind !== "event-dependent"
      || !item.decay.reversalEventIds.some((eventId) => input.realizedCanonicalEventIds.has(eventId));
  });
  const gatedAfterStanceIds = new Set(supportedChanges.flatMap((item) => item.afterStanceIds));
  const activeAfterStanceIds = new Set(activeChanges.flatMap((item) => item.afterStanceIds));
  const displacedStanceIds = new Set(activeChanges.flatMap((item) => item.beforeStanceIds));
  const gatedAfterObligationIds = new Set(supportedChanges.flatMap((item) => item.afterObligationIds));
  const activeAfterObligationIds = new Set(activeChanges.flatMap((item) => item.afterObligationIds));
  const displacedObligationIds = new Set(activeChanges.flatMap((item) => item.beforeObligationIds));

  const relationshipStances = (model.relationshipStances ?? []).flatMap((item) => {
    if (item.status === "contested"
      || !policyStoryScopeActive(input.storyTime, item.validStoryTime, input.realizedCanonicalEventIds)
      || (gatedAfterStanceIds.has(item.id) && !activeAfterStanceIds.has(item.id))
      || displacedStanceIds.has(item.id)) return [];
    const descriptor = descriptorFor(item);
    if (!descriptor) return [];
    const { id, relationshipEntityId, targetEntityId, dimensionId, value, stability, confidence } = item;
    return [{ id, relationshipEntityId, targetEntityId, dimensionId, value, stability, confidence, relationshipType: descriptor.type }];
  }).sort((left, right) => left.id.localeCompare(right.id));

  const relationshipObligations = (model.relationshipObligations ?? []).flatMap((item) => {
    if (item.status === "contested"
      || !policyGateSatisfied(item.activation, input)
      || (item.resolution && policyResolutionSatisfied(item.resolution, input))
      || (gatedAfterObligationIds.has(item.id) && !activeAfterObligationIds.has(item.id))
      || displacedObligationIds.has(item.id)) return [];
    const descriptor = descriptorFor(item);
    if (!descriptor) return [];
    const { id, relationshipEntityId, targetEntityId, typeId, priority, confidence } = item;
    return [{ id, relationshipEntityId, targetEntityId, typeId, priority, confidence, relationshipType: descriptor.type }];
  }).sort((left, right) => left.id.localeCompare(right.id));

  const relationshipChanges = activeChanges.flatMap((item) => {
    const descriptor = descriptorFor(item);
    if (!descriptor) return [];
    const { id, relationshipEntityId, targetEntityId, afterStanceIds, afterObligationIds, confidence } = item;
    return [{
      id,
      relationshipEntityId,
      targetEntityId,
      afterStanceIds: [...afterStanceIds],
      afterObligationIds: [...afterObligationIds],
      confidence,
      relationshipType: descriptor.type,
      status: "active" as const,
    }];
  }).sort((left, right) => left.id.localeCompare(right.id));
  return { relationshipStances, relationshipObligations, relationshipChanges };
}

export type ModelVisibleRelationshipOntology = Array<{
  target: string;
  type: RelationshipTypeId;
  stances: Array<{
    dimension: RelationshipStanceDimensionId;
    value: number;
    stability: "stable" | "situational";
    confidence: number;
  }>;
  obligations: Array<{
    type: RelationshipObligationTypeId;
    priority: number;
    confidence: number;
  }>;
  changes: Array<{
    dimensions: RelationshipStanceDimensionId[];
    obligationTypes: RelationshipObligationTypeId[];
    status: "active";
    confidence: number;
  }>;
}>;

/** Actor/model view strips compiler IDs, propositions, evidence, and invisible targets. */
export function modelVisibleRelationshipOntology(
  ontology: EffectiveRelationshipOntology,
  targetLabel: (entityId: string) => string | undefined,
): ModelVisibleRelationshipOntology {
  const relationshipIds = new Set([
    ...ontology.relationshipStances.map((item) => item.relationshipEntityId),
    ...ontology.relationshipObligations.map((item) => item.relationshipEntityId),
    ...ontology.relationshipChanges.map((item) => item.relationshipEntityId),
  ]);
  return [...relationshipIds].sort().flatMap((relationshipEntityId) => {
    const representative = ontology.relationshipStances.find((item) => item.relationshipEntityId === relationshipEntityId)
      ?? ontology.relationshipObligations.find((item) => item.relationshipEntityId === relationshipEntityId)
      ?? ontology.relationshipChanges.find((item) => item.relationshipEntityId === relationshipEntityId);
    if (!representative) return [];
    const target = targetLabel(representative.targetEntityId);
    if (!target) return [];
    const stances = ontology.relationshipStances
      .filter((item) => item.relationshipEntityId === relationshipEntityId)
      .slice(0, 12)
      .map((item) => ({ dimension: item.dimensionId, value: item.value, stability: item.stability, confidence: item.confidence }));
    const obligations = ontology.relationshipObligations
      .filter((item) => item.relationshipEntityId === relationshipEntityId)
      .slice(0, 12)
      .map((item) => ({ type: item.typeId, priority: item.priority, confidence: item.confidence }));
    const stanceById = new Map(ontology.relationshipStances.map((item) => [item.id, item]));
    const obligationById = new Map(ontology.relationshipObligations.map((item) => [item.id, item]));
    const changes = ontology.relationshipChanges
      .filter((item) => item.relationshipEntityId === relationshipEntityId)
      .slice(0, 12)
      .map((item) => ({
        dimensions: [...new Set(item.afterStanceIds.flatMap((id) => stanceById.get(id)?.dimensionId ?? []))].sort(),
        obligationTypes: [...new Set(item.afterObligationIds.flatMap((id) => obligationById.get(id)?.typeId ?? []))].sort(),
        status: item.status,
        confidence: item.confidence,
      }));
    return [{ target, type: representative.relationshipType, stances, obligations, changes }];
  }).slice(0, 24);
}

export function relationshipOntologyEvidence(model: unknown): EvidenceRef[] {
  if (!model || typeof model !== "object" || Array.isArray(model)) return [];
  const record = model as Record<string, unknown>;
  return [record.relationshipStances, record.relationshipObligations, record.relationshipChanges]
    .flatMap((candidate) => Array.isArray(candidate) ? candidate : [])
    .flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const item = candidate as { evidence?: unknown; counterEvidence?: unknown };
      return [item.evidence, item.counterEvidence].flatMap((evidence) =>
        evidence === undefined ? [] : evidenceRefSchema.array().parse(evidence));
    });
}

type RelationshipPair = Pick<RelationshipStance, "actorId" | "relationshipEntityId" | "targetEntityId">;

function activeRelationshipDescriptor(
  state: WorldState,
  pair: RelationshipPair,
): { type: RelationshipTypeId } | undefined {
  const actorRelationships = state.values[pair.actorId]?.["character.relationships"];
  const relationship = state.values[pair.relationshipEntityId];
  if (!Array.isArray(actorRelationships) || !actorRelationships.includes(pair.relationshipEntityId)
    || relationship?.["relationship.from"] !== pair.actorId
    || relationship?.["relationship.to"] !== pair.targetEntityId
    || relationship?.["relationship.active"] !== true) return undefined;
  const type = relationshipTypeIdSchema.safeParse(relationship["relationship.type"]);
  return type.success ? { type: type.data } : undefined;
}

function policyGateSatisfied(
  activation: RelationshipObligation["activation"],
  input: Parameters<typeof resolveRelationshipOntology>[1],
): boolean {
  if (!activation) return true;
  return activation.afterWorldEventIds.every((eventId) => input.realizedCanonicalEventIds.has(eventId))
    && activation.afterExperiencedEventIds.every((eventId) => input.experiencedCanonicalEventIds.has(eventId))
    && activation.requiresKnowledge.every((claimId) => input.knownClaimIds.has(claimId))
    && policyStoryScopeActive(input.storyTime, activation.storyWindow, input.realizedCanonicalEventIds);
}

function policyResolutionSatisfied(
  resolution: NonNullable<RelationshipObligation["resolution"]>,
  input: Parameters<typeof resolveRelationshipOntology>[1],
): boolean {
  return resolution.afterWorldEventIds.every((eventId) => input.realizedCanonicalEventIds.has(eventId))
    && resolution.afterExperiencedEventIds.every((eventId) => input.experiencedCanonicalEventIds.has(eventId))
    && resolution.requiresKnowledge.every((claimId) => input.knownClaimIds.has(claimId));
}

function validatePolicyActivation(
  activation: RelationshipObligation["activation"],
  actorId: string,
  catalog: RelationshipOntologyReferenceCatalog,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!activation) return;
  activation.afterWorldEventIds.forEach((eventId, index) =>
    validateEventReference(eventId, false, actorId, catalog.events, `${path}.afterWorldEventIds.${index}`, issues));
  activation.afterExperiencedEventIds.forEach((eventId, index) =>
    validateEventReference(eventId, true, actorId, catalog.events, `${path}.afterExperiencedEventIds.${index}`, issues));
  activation.requiresKnowledge.forEach((claimId, index) => {
    if (!catalog.claims.has(claimId)) issues.push(issue("UNKNOWN_RELATIONSHIP_KNOWLEDGE", `Relationship policy references unknown claim ${claimId}`, `${path}.requiresKnowledge.${index}`));
  });
  validateStoryAnchor(activation.storyWindow, catalog.events, `${path}.storyWindow`, issues);
}

function validatePolicyResolution(
  resolution: RelationshipObligation["resolution"],
  actorId: string,
  catalog: RelationshipOntologyReferenceCatalog,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!resolution) return;
  resolution.afterWorldEventIds.forEach((eventId, index) =>
    validateEventReference(eventId, false, actorId, catalog.events, `${path}.afterWorldEventIds.${index}`, issues));
  resolution.afterExperiencedEventIds.forEach((eventId, index) =>
    validateEventReference(eventId, true, actorId, catalog.events, `${path}.afterExperiencedEventIds.${index}`, issues));
  resolution.requiresKnowledge.forEach((claimId, index) => {
    if (!catalog.claims.has(claimId)) issues.push(issue("UNKNOWN_RELATIONSHIP_KNOWLEDGE", `Relationship policy references unknown claim ${claimId}`, `${path}.requiresKnowledge.${index}`));
  });
}

function validateEventReference(
  eventId: string,
  mustBeExperienced: boolean,
  actorId: string,
  events: RelationshipOntologyReferenceCatalog["events"],
  path: string,
  issues: ValidationIssue[],
): void {
  const event = events.get(eventId);
  if (!event) issues.push(issue("UNKNOWN_RELATIONSHIP_EVENT", `Relationship policy references unknown event ${eventId}`, path));
  else if (mustBeExperienced && !eventAvailableToActor(event, actorId)) {
    issues.push(issue("UNEXPERIENCED_RELATIONSHIP_EVENT", `Relationship policy marks event ${eventId} experienced by ${actorId}, but its participation does not permit experience`, path));
  }
}

function validateStoryAnchor(
  time: StoryTime | undefined,
  events: ReadonlyMap<string, unknown>,
  path: string,
  issues: ValidationIssue[],
): void {
  if (time?.kind === "relative" && !events.has(time.anchorEventId)) {
    issues.push(issue("UNKNOWN_RELATIONSHIP_TIME_ANCHOR", `Relationship policy story time references unknown event ${time.anchorEventId}`, `${path}.anchorEventId`));
  }
}

function eventAvailableToActor(
  event: Pick<CanonicalEvent, "participants" | "participantPresence">,
  actorId: string,
): boolean {
  if (!event.participants.includes(actorId)) return false;
  const presence = event.participantPresence?.find((item) => item.entityId === actorId)?.mode;
  return presence ? presence !== "mentioned" && presence !== "represented" : true;
}

function sameRelationshipPair(left: RelationshipPair, right: RelationshipPair): boolean {
  return left.actorId === right.actorId
    && left.relationshipEntityId === right.relationshipEntityId
    && left.targetEntityId === right.targetEntityId;
}

function validateCounterEvidence(
  value: { status: "supported" | "contested"; counterEvidence?: readonly EvidenceRef[] },
  ctx: z.RefinementCtx,
  statusPath = "status",
): void {
  if (value.status === "contested" && !value.counterEvidence?.length) {
    ctx.addIssue({ code: "custom", path: ["counterEvidence"], message: "A contested relationship interpretation requires counter-evidence" });
  }
  if (value.status === "supported" && value.counterEvidence?.length) {
    ctx.addIssue({ code: "custom", path: [statusPath], message: "A relationship interpretation with counter-evidence must be contested" });
  }
}

function distinctEvidenceSpans(evidence: readonly EvidenceRef[]): number {
  return new Set(evidence.map((reference) => [
    reference.span.sourceId,
    reference.span.startByte ?? "",
    reference.span.endByte ?? "",
    reference.span.startLine,
    reference.span.endLine,
    reference.span.quoteHash,
  ].join("\u0000"))).size;
}

function evidenceKey(reference: EvidenceRef): string {
  return [
    reference.span.sourceId,
    reference.span.startByte ?? "",
    reference.span.endByte ?? "",
    reference.span.quoteHash,
    reference.strength,
  ].join("\u0000");
}

function assertionEvidenceKeys(assertions: readonly EvidenceAssertion[]): Set<string> {
  return new Set(assertions.flatMap((assertion) => assertion.anchors.map((anchor) => [
    anchor.sourceId,
    anchor.startByte,
    anchor.endByte,
    anchor.exactHash,
    assertion.strength,
  ].join("\u0000"))));
}

function distinctAssertionAnchors(assertions: readonly EvidenceAssertion[]): number {
  return new Set(assertions.flatMap((assertion) => assertion.anchors).map((anchor) => [
    anchor.sourceId,
    anchor.startByte,
    anchor.endByte,
    anchor.exactHash,
  ].join("\u0000"))).size;
}

function sameSet<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function issue(code: string, message: string, path: string): ValidationIssue {
  return { code, message, path };
}
