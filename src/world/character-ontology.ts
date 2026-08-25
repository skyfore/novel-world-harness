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
} from "./model.js";
import { compareStoryTime } from "./time.js";
import { policyEpisodeTimeActive, policyStoryScopeActive } from "./policy-time.js";
import { relationshipOntologyEvidence } from "./relationship-ontology.js";

export const CHARACTER_ONTOLOGY_VERSION = "character-v1" as const;

export const CHARACTER_DIMENSION_IDS = [
  "risk-tolerance",
  "deliberation",
  "affiliation",
  "dominance",
  "norm-adherence",
  "trust-readiness",
  "persistence",
  "openness-to-revision",
] as const;

export const characterDimensionIdSchema = z.enum(CHARACTER_DIMENSION_IDS);
export type CharacterDimensionId = z.infer<typeof characterDimensionIdSchema>;

export const CHARACTER_CONTEXT_IDS = [
  "physical-danger",
  "resource-scarcity",
  "social-conflict",
  "cooperation",
  "authority-pressure",
  "caregiving",
  "intimacy",
  "public-performance",
  "uncertainty",
  "goal-obstruction",
] as const;

export const characterContextIdSchema = z.enum(CHARACTER_CONTEXT_IDS);
export type CharacterContextId = z.infer<typeof characterContextIdSchema>;

export type CharacterDimensionDefinition = {
  id: CharacterDimensionId;
  ontologyVersion: typeof CHARACTER_ONTOLOGY_VERSION;
  label: string;
  description: string;
  negativeAnchor: string;
  neutralAnchor: string;
  positiveAnchor: string;
  runtimeUse: "decision" | "relationship" | "rendering" | "analysis";
};

/**
 * A deliberately small behavioral vocabulary. The anchors describe observable
 * choices, not moral worth, diagnosis, or an essential personality type.
 */
export const CHARACTER_DIMENSIONS: readonly CharacterDimensionDefinition[] = Object.freeze([
  {
    id: "risk-tolerance",
    ontologyVersion: CHARACTER_ONTOLOGY_VERSION,
    label: "Risk tolerance",
    description: "Willingness to accept uncertain harm or loss for a valued outcome.",
    negativeAnchor: "Consistently chooses the safer available path when stakes are uncertain.",
    neutralAnchor: "Balances likely benefit and harm without a consistent directional preference.",
    positiveAnchor: "Accepts meaningful uncertainty when it advances an important goal.",
    runtimeUse: "decision",
  },
  {
    id: "deliberation",
    ontologyVersion: CHARACTER_ONTOLOGY_VERSION,
    label: "Deliberation",
    description: "Tendency to pause, compare evidence, and plan before acting.",
    negativeAnchor: "Acts rapidly from the first available interpretation.",
    neutralAnchor: "Uses either quick judgment or reflection according to ordinary stakes.",
    positiveAnchor: "Seeks information and compares consequences before committing.",
    runtimeUse: "decision",
  },
  {
    id: "affiliation",
    ontologyVersion: CHARACTER_ONTOLOGY_VERSION,
    label: "Affiliation",
    description: "Tendency to preserve connection, cooperation, and group belonging.",
    negativeAnchor: "Protects autonomy even when cooperation is readily available.",
    neutralAnchor: "Cooperates or separates according to the immediate relationship and goal.",
    positiveAnchor: "Actively maintains bonds and coordinates with trusted others.",
    runtimeUse: "relationship",
  },
  {
    id: "dominance",
    ontologyVersion: CHARACTER_ONTOLOGY_VERSION,
    label: "Dominance",
    description: "Tendency to seek control over shared decisions and contested situations.",
    negativeAnchor: "Yields control or follows another's lead when coordination is needed.",
    neutralAnchor: "Negotiates control according to role, competence, and stakes.",
    positiveAnchor: "Attempts to direct others or determine the course of action.",
    runtimeUse: "relationship",
  },
  {
    id: "norm-adherence",
    ontologyVersion: CHARACTER_ONTOLOGY_VERSION,
    label: "Norm adherence",
    description: "Tendency to follow recognized rules, duties, customs, or procedures.",
    negativeAnchor: "Readily bends a norm when it obstructs the immediate objective.",
    neutralAnchor: "Weighs a norm against its authority, purpose, and consequences.",
    positiveAnchor: "Treats applicable duties and procedures as strong action constraints.",
    runtimeUse: "decision",
  },
  {
    id: "trust-readiness",
    ontologyVersion: CHARACTER_ONTOLOGY_VERSION,
    label: "Trust readiness",
    description: "Readiness to rely on another actor's word, competence, or goodwill.",
    negativeAnchor: "Seeks independent verification before relying on another actor.",
    neutralAnchor: "Calibrates reliance to available evidence and relationship history.",
    positiveAnchor: "Extends reliance before receiving complete verification.",
    runtimeUse: "relationship",
  },
  {
    id: "persistence",
    ontologyVersion: CHARACTER_ONTOLOGY_VERSION,
    label: "Persistence",
    description: "Tendency to continue pursuing an objective through delay or resistance.",
    negativeAnchor: "Disengages or reframes the objective after limited resistance.",
    neutralAnchor: "Continues while expected value remains proportionate to cost.",
    positiveAnchor: "Sustains effort despite repeated obstacles or delayed reward.",
    runtimeUse: "decision",
  },
  {
    id: "openness-to-revision",
    ontologyVersion: CHARACTER_ONTOLOGY_VERSION,
    label: "Openness to revision",
    description: "Readiness to update a plan or interpretation when contrary evidence appears.",
    negativeAnchor: "Maintains the prior plan or interpretation despite meaningful tension.",
    neutralAnchor: "Updates when contrary evidence becomes sufficiently strong.",
    positiveAnchor: "Actively revises beliefs and plans in response to new evidence.",
    runtimeUse: "analysis",
  },
]);

const interpretationStatusSchema = z.enum(["supported", "contested"]);

const dispositionStoryTimeSchema = storyTimeSchema.refine(
  (value) => value.kind !== "relative" || value.relation !== "during",
  "A relative disposition validity must be before or after its anchor event; during requires an explicit comparable story-time window",
);
const developmentStartStoryTimeSchema = storyTimeSchema.refine(
  (value) => value.kind !== "relative" || value.relation === "after",
  "A relative development start must be after its anchor event",
);
const developmentEndStoryTimeSchema = storyTimeSchema.refine(
  (value) => value.kind !== "relative" || value.relation === "before",
  "A relative development end must be before its anchor event",
);

const dispositionScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }).strict(),
  z.object({ kind: z.literal("context"), contextId: characterContextIdSchema }).strict(),
  z.object({ kind: z.literal("target"), targetEntityId: idSchema }).strict(),
  z.object({
    kind: z.literal("context-target"),
    contextId: characterContextIdSchema,
    targetEntityId: idSchema,
  }).strict(),
]);

export const characterDispositionSchema = z.object({
  id: idSchema,
  actorId: idSchema,
  dimensionId: characterDimensionIdSchema,
  value: z.number().finite().min(-1).max(1),
  scope: dispositionScopeSchema,
  stability: z.enum(["stable", "situational"]),
  basis: z.enum(["explicit-characterization", "repeated-behavior", "inferred-pattern"]),
  validStoryTime: dispositionStoryTimeSchema.optional(),
  status: interpretationStatusSchema,
  confidence: z.number().finite().min(0).max(1),
  evidence: z.array(evidenceRefSchema).min(1).max(64),
  counterEvidence: z.array(evidenceRefSchema).min(1).max(64).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.basis === "explicit-characterization"
    && !value.evidence.some((reference) => reference.strength === "explicit")) {
    ctx.addIssue({
      code: "custom",
      path: ["basis"],
      message: "Explicit characterization requires at least one explicit evidence reference",
    });
  }
  if (value.stability === "stable" && value.basis !== "explicit-characterization"
    && distinctEvidenceSpans(value.evidence) < 2) {
    ctx.addIssue({
      code: "custom",
      path: ["evidence"],
      message: "A stable behaviorally inferred disposition requires at least two distinct source spans",
    });
  }
  validateCounterEvidence(value, ctx);
});
export type CharacterDisposition = z.infer<typeof characterDispositionSchema>;

export const APPRAISAL_EMOTION_IDS = [
  "joy",
  "distress",
  "hope",
  "fear",
  "relief",
  "disappointment",
  "pride",
  "shame",
  "gratitude",
  "anger",
  "liking",
  "disliking",
  "surprise",
  "uncertainty",
] as const;

export const appraisalEmotionSchema = z.enum(APPRAISAL_EMOTION_IDS);

export const appraisalEpisodeSchema = z.object({
  id: idSchema,
  actorId: idSchema,
  eventId: idSchema,
  interpretationPropositionId: idSchema,
  basis: z.enum(["experienced", "reported", "inferred"]),
  emotion: z.object({
    label: appraisalEmotionSchema,
    intensity: z.number().finite().min(0).max(1),
  }).strict(),
  affectedGoalIds: z.array(idSchema).max(32),
  resultingIntention: z.string().trim().min(1).max(1_000).optional(),
  status: interpretationStatusSchema,
  confidence: z.number().finite().min(0).max(1),
  evidence: z.array(evidenceRefSchema).min(1).max(64),
  counterEvidence: z.array(evidenceRefSchema).min(1).max(64).optional(),
}).strict().superRefine(validateCounterEvidence);
export type AppraisalEpisode = z.infer<typeof appraisalEpisodeSchema>;

export const developmentEpisodeSchema = z.object({
  id: idSchema,
  actorId: idSchema,
  triggerMode: z.enum(["world", "experienced"]),
  triggerEventIds: z.array(idSchema).min(1).max(32)
    .refine((values) => new Set(values).size === values.length, "triggerEventIds must be unique"),
  beforeDispositionIds: z.array(idSchema).max(32)
    .refine((values) => new Set(values).size === values.length, "beforeDispositionIds must be unique"),
  afterDispositionIds: z.array(idSchema).min(1).max(32)
    .refine((values) => new Set(values).size === values.length, "afterDispositionIds must be unique"),
  mechanism: z.string().trim().min(1).max(2_000),
  startsAt: developmentStartStoryTimeSchema,
  endsAt: developmentEndStoryTimeSchema.optional(),
  decay: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }).strict(),
    z.object({ kind: z.literal("event-dependent"), reversalEventIds: z.array(idSchema).min(1).max(32) }).strict(),
  ]),
  evidenceStatus: interpretationStatusSchema,
  confidence: z.number().finite().min(0).max(1),
  evidence: z.array(evidenceRefSchema).min(1).max(64),
  counterEvidence: z.array(evidenceRefSchema).min(1).max(64).optional(),
}).strict().superRefine((value, ctx) => {
  const overlap = value.beforeDispositionIds.filter((id) => value.afterDispositionIds.includes(id));
  if (overlap.length) {
    ctx.addIssue({
      code: "custom",
      path: ["afterDispositionIds"],
      message: `Development before/after disposition IDs must be distinct: ${overlap.join(", ")}`,
    });
  }
  if (value.endsAt && compareStoryTime(value.endsAt, value.startsAt) === -1) {
    ctx.addIssue({ code: "custom", path: ["endsAt"], message: "Development episode cannot end before it starts" });
  }
  validateCounterEvidence({
    status: value.evidenceStatus,
    counterEvidence: value.counterEvidence,
  }, ctx, "evidenceStatus");
});
export type DevelopmentEpisode = z.infer<typeof developmentEpisodeSchema>;

export const characterOntologyModelFields = {
  ontologyVersion: z.literal(CHARACTER_ONTOLOGY_VERSION).optional(),
  dispositions: z.array(characterDispositionSchema).max(256).optional(),
  appraisalEpisodes: z.array(appraisalEpisodeSchema).max(256).optional(),
  developmentEpisodes: z.array(developmentEpisodeSchema).max(256).optional(),
};

export type CharacterOntologyModel = {
  actorId: string;
  ontologyVersion?: typeof CHARACTER_ONTOLOGY_VERSION;
  traits: Record<string, number>;
  decisionBiases: Record<string, number>;
  dispositions?: CharacterDisposition[];
  appraisalEpisodes?: AppraisalEpisode[];
  developmentEpisodes?: DevelopmentEpisode[];
};

export type CharacterOntologyReferenceCatalog = {
  entities: ReadonlyMap<string, { kind: string }>;
  propositions: ReadonlySet<string>;
  events: ReadonlyMap<string, Pick<CanonicalEvent, "participants" | "participantPresence">>;
  goals: ReadonlyMap<string, { actorId: string }>;
};

export function validateCharacterOntologyReferences(
  model: CharacterOntologyModel,
  catalog: CharacterOntologyReferenceCatalog,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const dispositions = new Map((model.dispositions ?? []).map((item) => [item.id, item]));
  for (let index = 0; index < (model.dispositions?.length ?? 0); index += 1) {
    const item = model.dispositions![index]!;
    const prefix = `dispositions.${index}`;
    if (item.actorId !== model.actorId) {
      issues.push(issue("CHARACTER_ONTOLOGY_ACTOR_MISMATCH", `Disposition ${item.id} belongs to ${item.actorId}, not model actor ${model.actorId}`, `${prefix}.actorId`));
    }
    const targetId = item.scope.kind === "target" || item.scope.kind === "context-target"
      ? item.scope.targetEntityId
      : undefined;
    if (targetId && !catalog.entities.has(targetId)) {
      issues.push(issue("UNKNOWN_DISPOSITION_TARGET", `Disposition ${item.id} targets unknown entity ${targetId}`, `${prefix}.scope.targetEntityId`));
    }
    validateStoryAnchor(item.validStoryTime, catalog.events, `${prefix}.validStoryTime`, issues);
  }
  for (let index = 0; index < (model.appraisalEpisodes?.length ?? 0); index += 1) {
    const item = model.appraisalEpisodes![index]!;
    const prefix = `appraisalEpisodes.${index}`;
    if (item.actorId !== model.actorId) {
      issues.push(issue("CHARACTER_ONTOLOGY_ACTOR_MISMATCH", `Appraisal ${item.id} belongs to ${item.actorId}, not model actor ${model.actorId}`, `${prefix}.actorId`));
    }
    const event = catalog.events.get(item.eventId);
    if (!event) {
      issues.push(issue("UNKNOWN_APPRAISAL_EVENT", `Appraisal ${item.id} references unknown event ${item.eventId}`, `${prefix}.eventId`));
    } else if (!eventAvailableToActor(event, model.actorId)) {
      issues.push(issue("UNAVAILABLE_APPRAISAL_EVENT", `Appraisal ${item.id} references an acquisition/interpretation event that does not include ${model.actorId}`, `${prefix}.eventId`));
    }
    if (!catalog.propositions.has(item.interpretationPropositionId)) {
      issues.push(issue("UNKNOWN_APPRAISAL_PROPOSITION", `Appraisal ${item.id} references unknown proposition ${item.interpretationPropositionId}`, `${prefix}.interpretationPropositionId`));
    }
    for (let goalIndex = 0; goalIndex < item.affectedGoalIds.length; goalIndex += 1) {
      const goalId = item.affectedGoalIds[goalIndex]!;
      const goal = catalog.goals.get(goalId);
      if (!goal) issues.push(issue("UNKNOWN_APPRAISAL_GOAL", `Appraisal ${item.id} references unknown goal ${goalId}`, `${prefix}.affectedGoalIds.${goalIndex}`));
      else if (goal.actorId !== model.actorId) issues.push(issue("FOREIGN_APPRAISAL_GOAL", `Appraisal ${item.id} references goal ${goalId} owned by ${goal.actorId}`, `${prefix}.affectedGoalIds.${goalIndex}`));
    }
  }
  for (let index = 0; index < (model.developmentEpisodes?.length ?? 0); index += 1) {
    const item = model.developmentEpisodes![index]!;
    const prefix = `developmentEpisodes.${index}`;
    if (item.actorId !== model.actorId) {
      issues.push(issue("CHARACTER_ONTOLOGY_ACTOR_MISMATCH", `Development episode ${item.id} belongs to ${item.actorId}, not model actor ${model.actorId}`, `${prefix}.actorId`));
    }
    for (let eventIndex = 0; eventIndex < item.triggerEventIds.length; eventIndex += 1) {
      const eventId = item.triggerEventIds[eventIndex]!;
      const event = catalog.events.get(eventId);
      if (!event) issues.push(issue("UNKNOWN_DEVELOPMENT_EVENT", `Development episode ${item.id} references unknown event ${eventId}`, `${prefix}.triggerEventIds.${eventIndex}`));
      else if (item.triggerMode === "experienced" && !eventAvailableToActor(event, model.actorId)) {
        issues.push(issue("UNEXPERIENCED_DEVELOPMENT_EVENT", `Experienced development episode ${item.id} references an event that does not include ${model.actorId}`, `${prefix}.triggerEventIds.${eventIndex}`));
      }
    }
    for (const [field, ids] of [
      ["beforeDispositionIds", item.beforeDispositionIds],
      ["afterDispositionIds", item.afterDispositionIds],
    ] as const) {
      for (let dispositionIndex = 0; dispositionIndex < ids.length; dispositionIndex += 1) {
        if (!dispositions.has(ids[dispositionIndex]!)) {
          issues.push(issue("UNKNOWN_DEVELOPMENT_DISPOSITION", `Development episode ${item.id} references unknown disposition ${ids[dispositionIndex]}`, `${prefix}.${field}.${dispositionIndex}`));
        }
      }
    }
    validateStoryAnchor(item.startsAt, catalog.events, `${prefix}.startsAt`, issues);
    validateStoryAnchor(item.endsAt, catalog.events, `${prefix}.endsAt`, issues);
    if (item.decay.kind === "event-dependent") {
      item.decay.reversalEventIds.forEach((eventId, eventIndex) => {
        if (!catalog.events.has(eventId)) {
          issues.push(issue("UNKNOWN_DEVELOPMENT_EVENT", `Development episode ${item.id} references unknown reversal event ${eventId}`, `${prefix}.decay.reversalEventIds.${eventIndex}`));
        }
      });
    }
  }
  return issues;
}

/**
 * V2 semantics require exact, host-verifiable assertions per semantic record.
 * Embedded EvidenceRefs remain the portable compatibility representation, but
 * cannot by themselves establish that a quoted span supports this exact item.
 */
export function validateCharacterOntologyEvidenceAssertions(
  model: CharacterOntologyModel,
  assertions: readonly EvidenceAssertion[],
): ValidationIssue[] {
  if (model.ontologyVersion !== CHARACTER_ONTOLOGY_VERSION) return [];
  const issues: ValidationIssue[] = [];
  const forItem = (field: string, index: number) => {
    const prefix = `/${field}/${index}`;
    return assertions.filter((assertion) => assertion.target.jsonPointer === prefix
      || assertion.target.jsonPointer.startsWith(`${prefix}/`));
  };
  const validateItem = (
    field: string,
    index: number,
    id: string,
    status: "supported" | "contested",
    evidence: readonly EvidenceRef[],
    counterEvidence: readonly EvidenceRef[] = [],
  ) => {
    const selected = forItem(field, index);
    const supports = selected.filter((assertion) => assertion.relation === "supports");
    const contradicts = selected.filter((assertion) => assertion.relation === "contradicts");
    if (!supports.length) {
      issues.push(issue(
        "MISSING_EXACT_CHARACTER_SUPPORT",
        `${field} item ${id} requires at least one exact supporting assertion`,
        `${field}.${index}`,
      ));
    }
    if (status === "contested" && !contradicts.length) {
      issues.push(issue(
        "MISSING_EXACT_CHARACTER_COUNTER_EVIDENCE",
        `Contested ${field} item ${id} requires at least one exact contradicting assertion`,
        `${field}.${index}`,
      ));
    }
    if (status === "supported" && contradicts.length) {
      issues.push(issue(
        "UNDECLARED_CHARACTER_CONTEST",
        `${field} item ${id} has exact contradicting evidence but is marked supported`,
        `${field}.${index}`,
      ));
    }
    const referenceKey = (reference: EvidenceRef) => [
      reference.span.sourceId,
      reference.span.startByte ?? "",
      reference.span.endByte ?? "",
      reference.span.quoteHash,
      reference.strength,
    ].join("\u0000");
    const anchorKey = (assertion: EvidenceAssertion, anchor: EvidenceAssertion["anchors"][number]) => [
      anchor.sourceId,
      anchor.startByte,
      anchor.endByte,
      anchor.exactHash,
      assertion.strength,
    ].join("\u0000");
    const supportKeys = new Set(supports.flatMap((assertion) =>
      assertion.anchors.map((anchor) => anchorKey(assertion, anchor))));
    const counterKeys = new Set(contradicts.flatMap((assertion) =>
      assertion.anchors.map((anchor) => anchorKey(assertion, anchor))));
    const evidenceKeys = new Set(evidence.map(referenceKey));
    const counterEvidenceKeys = new Set(counterEvidence.map(referenceKey));
    if (!sameSet(supportKeys, evidenceKeys)) {
      issues.push(issue(
        "CHARACTER_SUPPORT_BINDING_MISMATCH",
        `${field} item ${id} embedded evidence does not exactly match its supporting assertions`,
        `${field}.${index}.evidence`,
      ));
    }
    if (!sameSet(counterKeys, counterEvidenceKeys)) {
      issues.push(issue(
        "CHARACTER_COUNTER_BINDING_MISMATCH",
        `${field} item ${id} embedded counter-evidence does not exactly match its contradicting assertions`,
        `${field}.${index}.counterEvidence`,
      ));
    }
    return supports;
  };
  for (let index = 0; index < (model.dispositions?.length ?? 0); index += 1) {
    const item = model.dispositions![index]!;
    const supports = validateItem(
      "dispositions",
      index,
      item.id,
      item.status,
      item.evidence,
      item.counterEvidence,
    );
    if (item.basis === "explicit-characterization"
      && !supports.some((assertion) => assertion.strength === "explicit")) {
      issues.push(issue(
        "MISSING_EXACT_EXPLICIT_CHARACTERIZATION",
        `Disposition ${item.id} requires an exact explicit supporting assertion`,
        `dispositions.${index}.basis`,
      ));
    }
    if (item.stability === "stable" && item.basis !== "explicit-characterization") {
      const distinctAnchors = new Set(supports.flatMap((assertion) => assertion.anchors).map((anchor) => [
        anchor.sourceId,
        anchor.startByte,
        anchor.endByte,
        anchor.exactHash,
      ].join("\u0000"))).size;
      if (distinctAnchors < 2) {
        issues.push(issue(
          "INSUFFICIENT_EXACT_STABLE_DISPOSITION_EVIDENCE",
          `Stable behavioral disposition ${item.id} requires two distinct exact supporting anchors`,
          `dispositions.${index}.evidence`,
        ));
      }
    }
  }
  for (let index = 0; index < (model.appraisalEpisodes?.length ?? 0); index += 1) {
    const item = model.appraisalEpisodes![index]!;
    validateItem(
      "appraisalEpisodes",
      index,
      item.id,
      item.status,
      item.evidence,
      item.counterEvidence,
    );
  }
  for (let index = 0; index < (model.developmentEpisodes?.length ?? 0); index += 1) {
    const item = model.developmentEpisodes![index]!;
    validateItem(
      "developmentEpisodes",
      index,
      item.id,
      item.evidenceStatus,
      item.evidence,
      item.counterEvidence,
    );
  }
  return issues;
}

export type EffectiveCharacterDisposition = Pick<CharacterDisposition,
  "id" | "dimensionId" | "value" | "scope" | "stability" | "confidence">;
export type EffectiveCharacterAppraisal = Pick<AppraisalEpisode,
  "id" | "emotion" | "confidence">;
export type EffectiveDevelopmentEpisode = Pick<DevelopmentEpisode,
  "id" | "triggerMode" | "afterDispositionIds" | "confidence"> & { status: "active" };

export type EffectiveCharacterOntology = {
  legacyDimensions: Record<string, number>;
  dispositions: EffectiveCharacterDisposition[];
  appraisals: EffectiveCharacterAppraisal[];
  developmentEpisodes: EffectiveDevelopmentEpisode[];
};

export function resolveCharacterOntology(
  model: CharacterOntologyModel,
  input: {
    realizedCanonicalEventIds: ReadonlySet<string>;
    experiencedCanonicalEventIds: ReadonlySet<string>;
    storyTime?: StoryTime;
  },
): EffectiveCharacterOntology {
  const supportedDevelopment = (model.developmentEpisodes ?? [])
    .filter((item) => item.evidenceStatus !== "contested");
  const activeDevelopment = supportedDevelopment.filter((item) => {
    const eventIds = item.triggerMode === "experienced"
      ? input.experiencedCanonicalEventIds
      : input.realizedCanonicalEventIds;
    if (!item.triggerEventIds.every((eventId) => eventIds.has(eventId))) return false;
    if (!policyEpisodeTimeActive(input.storyTime, item.startsAt, item.endsAt, input.realizedCanonicalEventIds)) return false;
    if (item.decay.kind === "event-dependent"
      && item.decay.reversalEventIds.some((eventId) => input.realizedCanonicalEventIds.has(eventId))) return false;
    return true;
  });
  const developmentGatedDispositionIds = new Set(supportedDevelopment
    .flatMap((item) => item.afterDispositionIds));
  const activeAfterDispositionIds = new Set(activeDevelopment
    .flatMap((item) => item.afterDispositionIds));
  const displacedBeforeDispositionIds = new Set(activeDevelopment
    .flatMap((item) => item.beforeDispositionIds));
  const dispositions = (model.dispositions ?? [])
    .filter((item) => item.status !== "contested")
    .filter((item) => policyStoryScopeActive(
      input.storyTime,
      item.validStoryTime,
      input.realizedCanonicalEventIds,
    ))
    .filter((item) => !developmentGatedDispositionIds.has(item.id)
      || activeAfterDispositionIds.has(item.id))
    .filter((item) => !displacedBeforeDispositionIds.has(item.id))
    .map(({ id, dimensionId, value, scope, stability, confidence }) => ({
      id,
      dimensionId,
      value,
      scope: structuredClone(scope),
      stability,
      confidence,
    }));
  const appraisals = (model.appraisalEpisodes ?? [])
    .filter((item) => item.status !== "contested")
    .filter((item) => input.experiencedCanonicalEventIds.has(item.eventId))
    .map(({ id, emotion, confidence }) => ({
      id,
      emotion: structuredClone(emotion),
      confidence,
    }));
  // Source compilation may see a complete canonical arc, but runtime status is
  // derived only from committed triggers and reversal events at this branch head.
  const developmentEpisodes = activeDevelopment
    .map(({ id, triggerMode, afterDispositionIds, confidence }) => ({
      id,
      triggerMode,
      afterDispositionIds: [...afterDispositionIds],
      status: "active" as const,
      confidence,
    }));
  return {
    legacyDimensions: legacyCharacterDimensionValues(model.traits, model.decisionBiases),
    dispositions: dispositions.sort((left, right) => left.id.localeCompare(right.id)),
    appraisals: appraisals.sort((left, right) => left.id.localeCompare(right.id)),
    developmentEpisodes: developmentEpisodes.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export type ModelVisibleCharacterOntology = {
  dispositions: Array<{
    dimension: CharacterDimensionId;
    value: number;
    scope:
      | { kind: "global" }
      | { kind: "context"; contextId: CharacterContextId }
      | { kind: "target"; target: string }
      | { kind: "context-target"; contextId: CharacterContextId; target: string };
    stability: "stable" | "situational";
    confidence: number;
  }>;
  appraisals: Array<{
    emotion: { label: z.infer<typeof appraisalEmotionSchema>; intensity: number };
    confidence: number;
  }>;
  development: Array<{ dimensions: CharacterDimensionId[]; status: "active"; confidence: number }>;
};

/** Strip artifact IDs/evidence and omit target-specific policy for invisible targets. */
export function modelVisibleCharacterOntology(
  ontology: EffectiveCharacterOntology,
  targetLabel?: (entityId: string) => string | undefined,
): ModelVisibleCharacterOntology {
  const visibleDispositionIds = new Set<string>();
  const dispositions = ontology.dispositions.flatMap((item) => {
    let scope: ModelVisibleCharacterOntology["dispositions"][number]["scope"];
    if (item.scope.kind === "global") scope = { kind: "global" };
    else if (item.scope.kind === "context") scope = { kind: "context", contextId: item.scope.contextId };
    else {
      const target = targetLabel?.(item.scope.targetEntityId);
      if (!target) return [];
      scope = item.scope.kind === "target"
        ? { kind: "target", target }
        : { kind: "context-target", contextId: item.scope.contextId, target };
    }
    if (visibleDispositionIds.size >= 32) return [];
    visibleDispositionIds.add(item.id);
    return [{
      dimension: item.dimensionId,
      value: item.value,
      scope,
      stability: item.stability,
      confidence: item.confidence,
    }];
  }).slice(0, 32);
  return {
    dispositions,
    appraisals: ontology.appraisals.slice(0, 16).map((item) => ({
      emotion: structuredClone(item.emotion),
      confidence: item.confidence,
    })),
    development: ontology.developmentEpisodes.slice(0, 16).map((item) => ({
      // Expose the behavioral effect, never free-text compiler explanation that
      // could contain an event or entity the actor did not perceive.
      dimensions: [...new Set(ontology.dispositions
        .filter((disposition) => visibleDispositionIds.has(disposition.id)
          && item.afterDispositionIds.includes(disposition.id))
        .map((disposition) => disposition.dimensionId))].sort(),
      status: item.status,
      confidence: item.confidence,
    })),
  };
}

export function legacyCharacterDimensionValues(
  traits: Readonly<Record<string, number>>,
  decisionBiases: Readonly<Record<string, number>>,
): Record<string, number> {
  return Object.fromEntries([
    ...Object.entries(traits).map(([key, value]) => [`legacy:trait:${key}`, value] as const),
    ...Object.entries(decisionBiases).map(([key, value]) => [`legacy:decision-bias:${key}`, value] as const),
  ].sort(([left], [right]) => left.localeCompare(right)));
}

/** All nested policy evidence, including legacy development phases. */
export function characterOntologyEvidence(model: unknown): EvidenceRef[] {
  if (!model || typeof model !== "object" || Array.isArray(model)) return [];
  const record = model as Record<string, unknown>;
  return [...[
    record.developmentPhases,
    record.dispositions,
    record.appraisalEpisodes,
    record.developmentEpisodes,
  ].flatMap((candidate) => Array.isArray(candidate) ? candidate : [])
    .flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const item = candidate as { evidence?: unknown; counterEvidence?: unknown };
      return [item.evidence, item.counterEvidence].flatMap((evidence) =>
        evidence === undefined ? [] : evidenceRefSchema.array().parse(evidence));
    }), ...relationshipOntologyEvidence(model)];
}

function validateCounterEvidence(
  value: { status: "supported" | "contested"; counterEvidence?: readonly EvidenceRef[] },
  ctx: z.RefinementCtx,
  statusPath = "status",
): void {
  if (value.status === "contested" && !value.counterEvidence?.length) {
    ctx.addIssue({ code: "custom", path: ["counterEvidence"], message: "A contested interpretation requires counter-evidence" });
  }
  if (value.status === "supported" && value.counterEvidence?.length) {
    ctx.addIssue({ code: "custom", path: [statusPath], message: "An interpretation with counter-evidence must be marked contested" });
  }
}

function validateStoryAnchor(
  time: StoryTime | undefined,
  events: ReadonlyMap<string, unknown>,
  path: string,
  issues: ValidationIssue[],
): void {
  if (time?.kind === "relative" && !events.has(time.anchorEventId)) {
    issues.push(issue("UNKNOWN_CHARACTER_TIME_ANCHOR", `Character ontology story time references unknown event ${time.anchorEventId}`, `${path}.anchorEventId`));
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

function sameSet<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function issue(code: string, message: string, path: string): ValidationIssue {
  return { code, message, path };
}
