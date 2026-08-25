import { z } from "zod";

export type ProjectId = string;
export type EntityId = string;
export type ClaimId = string;
export type PropositionId = string;
export type AttributionId = string;
export type CanonicalEventId = string;
export type RuleId = string;
export type BranchId = string;
export type ProposalId = string;
export type CommitId = string;
export type ObjectHash = string;

export const SAFE_LOGICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const idSchema = z.string().regex(
  SAFE_LOGICAL_ID,
  "IDs must start with an ASCII letter or digit and contain only letters, digits, dot, underscore, or hyphen",
).max(200, "IDs must be at most 200 characters");

export const sourceSpanSchema = z
  .object({
    sourceId: idSchema,
    startByte: z.number().int().nonnegative().optional(),
    endByte: z.number().int().nonnegative().optional(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    quoteHash: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.endLine < value.startLine) ctx.addIssue({ code: "custom", message: "endLine must be >= startLine", path: ["endLine"] });
    if (value.startByte !== undefined && value.endByte !== undefined && value.endByte < value.startByte) {
      ctx.addIssue({ code: "custom", message: "endByte must be >= startByte", path: ["endByte"] });
    }
  });
export type SourceSpan = z.infer<typeof sourceSpanSchema>;

export const evidenceRefSchema = z.object({ span: sourceSpanSchema, strength: z.enum(["explicit", "strong-inference", "weak-inference"]) }).strict();
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

export const textAnchorSchema = z
  .object({
    version: z.literal(1),
    sourceId: idSchema,
    startByte: z.number().int().nonnegative(),
    endByte: z.number().int().positive(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    exactHash: z.string().regex(/^[a-f0-9]{64}$/),
    prefixHash: z.string().regex(/^[a-f0-9]{64}$/),
    suffixHash: z.string().regex(/^[a-f0-9]{64}$/),
    contextBytes: z.literal(64),
    normalization: z.literal("source-bytes-v1"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.endByte <= value.startByte) {
      ctx.addIssue({ code: "custom", message: "endByte must be greater than startByte", path: ["endByte"] });
    }
    if (value.endLine < value.startLine) {
      ctx.addIssue({ code: "custom", message: "endLine must be >= startLine", path: ["endLine"] });
    }
  });
export type TextAnchor = z.infer<typeof textAnchorSchema>;

export const evidenceAssertionSchema = z
  .object({
    version: z.literal(1),
    id: idSchema,
    target: z.object({
      artifactKind: idSchema,
      artifactId: idSchema,
      jsonPointer: z.string().refine(
        (value) => /^(?:\/(?:[^~/]|~[01])*)*$/.test(value),
        "jsonPointer must be an RFC 6901 pointer",
      ),
    }).strict(),
    anchors: z.array(textAnchorSchema).min(1).max(16),
    relation: z.enum(["supports", "contradicts", "contextualizes"]),
    strength: z.enum(["explicit", "strong-inference", "weak-inference"]),
    interpretation: z.string().trim().min(1).max(1_000).optional(),
    derivation: z.object({
      runId: z.string().min(1).max(300),
      worker: z.string().min(1),
      compilerBatchId: idSchema.optional(),
      provider: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      promptHash: z.string().min(1).optional(),
      ontologyVersion: z.literal("evidence-v1"),
    }).strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.strength !== "explicit" && !value.interpretation) {
      ctx.addIssue({
        code: "custom",
        message: "Inferred evidence assertions require an interpretation",
        path: ["interpretation"],
      });
    }
    const sourceIds = new Set(value.anchors.map((anchor) => anchor.sourceId));
    if (sourceIds.size !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "One evidence assertion cannot mix source documents",
        path: ["anchors"],
      });
    }
  });
export type EvidenceAssertion = z.infer<typeof evidenceAssertionSchema>;

export const entityKindSchema = z.enum(["character", "location", "faction", "artifact", "institution", "relationship", "concept", "other"]);
export type EntityKind = z.infer<typeof entityKindSchema>;

export const entitySchema = z.object({ id: idSchema, kind: entityKindSchema, canonicalName: z.string().min(1), aliases: z.array(z.string().min(1)), evidence: z.array(evidenceRefSchema) }).strict();
export type Entity = z.infer<typeof entitySchema>;

export const claimSchema = z
  .object({
    id: idSchema,
    subject: idSchema,
    predicate: z.string().min(1),
    object: z.unknown(),
    epistemicType: z.enum(["explicit-fact", "narrator-claim", "character-claim", "rumor", "inference", "interpretation"]),
    speaker: idSchema.optional(),
    evidence: z.array(evidenceRefSchema),
  })
  .strict();
export type Claim = z.infer<typeof claimSchema>;

export const storyTimeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact"), value: z.string().min(1), precision: z.enum(["second", "minute", "hour", "day", "month", "year"]) }).strict(),
  z.object({ kind: z.literal("range"), earliest: z.string().min(1), latest: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("relative"), anchorEventId: idSchema, relation: z.enum(["before", "after", "during"]), offset: z.string().optional() }).strict(),
  z.object({ kind: z.literal("ordinal"), label: z.string().min(1), orderHint: z.number().optional() }).strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
]);
export type StoryTime = z.infer<typeof storyTimeSchema>;

/**
 * A proposition is semantic content, not an assertion that the content is
 * world truth. Truth commitment remains the responsibility of validated
 * events, state deltas, rules, and their branch history.
 */
export const propositionObjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("entity"), entityId: idSchema }).strict(),
  z.object({
    kind: z.literal("literal"),
    value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
  }).strict(),
  z.object({ kind: z.literal("proposition"), propositionId: idSchema }).strict(),
]);
export type PropositionObject = z.infer<typeof propositionObjectSchema>;

export const propositionSchema = z
  .object({
    id: idSchema,
    subjectEntityId: idSchema,
    relationId: idSchema,
    object: propositionObjectSchema,
    polarity: z.enum(["positive", "negative"]),
    modality: z.enum(["asserted", "possible", "necessary", "counterfactual"]),
    validStoryTime: storyTimeSchema.optional(),
    evidence: z.array(evidenceRefSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.object.kind === "proposition" && value.object.propositionId === value.id) {
      ctx.addIssue({ code: "custom", path: ["object", "propositionId"], message: "A proposition cannot contain itself" });
    }
  });
export type Proposition = z.infer<typeof propositionSchema>;

/**
 * Attribution records an epistemic or speech attitude toward a proposition.
 * Accepting this record validates that the attribution is source-grounded; it
 * does not promote the referenced proposition to world truth.
 */
export const attributionSchema = z
  .object({
    id: idSchema,
    propositionId: idSchema,
    holderKind: z.enum(["narrator", "character", "document", "unknown"]),
    holderEntityId: idSchema.optional(),
    attitude: z.enum(["asserts", "knows", "believes", "suspects", "reports", "denies", "questions"]),
    certainty: z.number().finite().min(0).max(1),
    sourceAttributionId: idSchema.optional(),
    quotationIds: z.array(idSchema).min(1).max(64)
      .refine((values) => new Set(values).size === values.length, "quotationIds must be unique")
      .optional(),
    evidence: z.array(evidenceRefSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.holderKind === "character" || value.holderKind === "document") && !value.holderEntityId) {
      ctx.addIssue({ code: "custom", path: ["holderEntityId"], message: `${value.holderKind} attribution requires holderEntityId` });
    }
    if ((value.holderKind === "narrator" || value.holderKind === "unknown") && value.holderEntityId) {
      ctx.addIssue({ code: "custom", path: ["holderEntityId"], message: `${value.holderKind} attribution cannot name a holder entity` });
    }
    if (value.sourceAttributionId === value.id) {
      ctx.addIssue({ code: "custom", path: ["sourceAttributionId"], message: "An attribution cannot source itself" });
    }
  });
export type Attribution = z.infer<typeof attributionSchema>;

/**
 * Human/calendar time and replay order deliberately stay separate. `step` is
 * the authoritative total order of commits. `elapsedDays` is a deterministic
 * duration accumulated by accepted events and is therefore safe to use for
 * ageing, deadlines, recovery, decay, and other continuous world processes.
 */
export const logicalTimeSchema = z
  .object({
    step: z.number().int().nonnegative(),
    storyTime: storyTimeSchema.optional(),
    elapsedDays: z.number().finite().nonnegative().optional(),
  })
  .strict();
export type LogicalTime = z.infer<typeof logicalTimeSchema>;

export const timeAdvanceSchema = z
  .object({
    amount: z.number().finite().positive(),
    unit: z.enum(["minute", "hour", "day", "week", "month", "year"]),
  })
  .strict();
export type TimeAdvance = z.infer<typeof timeAdvanceSchema>;

/** Narrative/discourse order is metadata, never the world clock. */
export const narrativeContextSchema = z
  .object({
    layerId: idSchema,
    discourseOrder: z.number().int().nonnegative(),
    mode: z.enum(["scene", "summary", "flashback", "flashforward", "frame", "recollection", "hypothetical"]),
    viewpointActorId: idSchema.optional(),
  })
  .strict();
export type NarrativeContext = z.infer<typeof narrativeContextSchema>;

/**
 * Participation and bodily presence are deliberately separate. A character can
 * cause or receive an event through a letter, memory, report, or remote channel
 * without sharing the actor's scene.
 */
export const participantPresenceModeSchema = z.enum(["physical", "remote", "mentioned", "represented", "dream", "memory"]);
export type ParticipantPresenceMode = z.infer<typeof participantPresenceModeSchema>;

export const participantPresenceSchema = z.object({
  entityId: idSchema.describe("Canonical character entity ID only. Locations, artifacts, factions, institutions, and relationships are not presence actors."),
  mode: participantPresenceModeSchema
    .describe("How this character participates without conflating mention, representation, memory, or remote contact with bodily presence."),
}).strict();
export type ParticipantPresence = z.infer<typeof participantPresenceSchema>;

/**
 * Typed semantic participation is independent from the legacy participant
 * inventory. It records the entity's role in an occurrence; presence remains
 * character-only and describes access to the lived scene, not causal agency.
 */
export const eventParticipationRoleSchema = z.enum([
  "agent",
  "patient",
  "theme",
  "experiencer",
  "beneficiary",
  "instrument",
  "location",
  "source",
  "destination",
  "other",
]);
export type EventParticipationRole = z.infer<typeof eventParticipationRoleSchema>;

export const eventParticipationSchema = z.object({
  id: idSchema,
  eventId: idSchema,
  entityId: idSchema,
  role: eventParticipationRoleSchema,
  presence: participantPresenceModeSchema.optional(),
  confidence: z.number().finite().min(0).max(1),
  evidence: z.array(evidenceRefSchema),
}).strict();
export type EventParticipation = z.infer<typeof eventParticipationSchema>;

export const valueTypeSchema = z.enum(["boolean", "number", "string", "entity-ref", "entity-ref-set", "json-scalar"]);
export type ValueType = z.infer<typeof valueTypeSchema>;

/**
 * Visibility is enforced when world state crosses an actor/model boundary.
 * Missing visibility is treated as engine-only for legacy or custom fields.
 */
export const stateFieldVisibilitySchema = z.enum(["public", "self", "owner", "knowledge", "engine"]);
export type StateFieldVisibility = z.infer<typeof stateFieldVisibilitySchema>;

export const stateFieldSpecSchema = z
  .object({
    key: z.string().min(1),
    appliesTo: z.array(entityKindSchema).min(1),
    valueType: valueTypeSchema,
    cardinality: z.enum(["one", "many"]),
    visibility: stateFieldVisibilitySchema.optional(),
    required: z.boolean().optional(),
    exclusive: z.boolean().optional(),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
    allowedValues: z.array(z.union([z.boolean(), z.number().finite(), z.string()])).min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.minimum !== undefined || value.maximum !== undefined) && value.valueType !== "number") {
      ctx.addIssue({ code: "custom", message: "minimum/maximum are only valid for number fields" });
    }
    if (value.minimum !== undefined && value.maximum !== undefined && value.minimum > value.maximum) {
      ctx.addIssue({ code: "custom", message: "minimum must be <= maximum", path: ["minimum"] });
    }
    if (value.allowedValues && !["boolean", "number", "string", "json-scalar"].includes(value.valueType)) {
      ctx.addIssue({ code: "custom", message: "allowedValues is valid only for scalar fields", path: ["allowedValues"] });
    }
    if (value.allowedValues && value.valueType !== "json-scalar") {
      const invalidIndex = value.allowedValues.findIndex((item) => typeof item !== value.valueType);
      if (invalidIndex >= 0) {
        ctx.addIssue({
          code: "custom",
          message: `allowedValues item must match valueType '${value.valueType}'`,
          path: ["allowedValues", invalidIndex],
        });
      }
    }
    if (value.allowedValues && new Set(value.allowedValues.map((item) => `${typeof item}:${String(item)}`)).size !== value.allowedValues.length) {
      ctx.addIssue({ code: "custom", message: "allowedValues must be unique", path: ["allowedValues"] });
    }
  });
export type StateFieldSpec = z.infer<typeof stateFieldSpecSchema>;

export const stateValueSchema = z.union([z.boolean(), z.number(), z.string(), z.array(z.string()), z.null()]);
export type StateValue = z.infer<typeof stateValueSchema>;

export type Predicate =
  | { op: "fact-equals"; entityId: EntityId; field: string; value: StateValue }
  | { op: "fact-gte"; entityId: EntityId; field: string; value: number }
  | { op: "fact-lte"; entityId: EntityId; field: string; value: number }
  | { op: "fact-exists"; entityId: EntityId; field: string }
  | { op: "entity-in"; entityId: EntityId; field: string; member: EntityId }
  | { op: "rule-active"; ruleId: RuleId }
  | { op: "after-step"; step: number }
  | { op: "before-step"; step: number }
  | { op: "elapsed-days-gte"; days: number }
  | { op: "elapsed-days-lte"; days: number }
  | { op: "story-time-at-or-after"; time: StoryTime }
  | { op: "story-time-before"; time: StoryTime }
  | { op: "all"; items: Predicate[] }
  | { op: "any"; items: Predicate[] }
  | { op: "not"; item: Predicate };

export const predicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("fact-equals"), entityId: idSchema, field: z.string().min(1), value: stateValueSchema }).strict(),
    z.object({ op: z.literal("fact-gte"), entityId: idSchema, field: z.string().min(1), value: z.number().finite() }).strict(),
    z.object({ op: z.literal("fact-lte"), entityId: idSchema, field: z.string().min(1), value: z.number().finite() }).strict(),
    z.object({ op: z.literal("fact-exists"), entityId: idSchema, field: z.string().min(1) }).strict(),
    z.object({ op: z.literal("entity-in"), entityId: idSchema, field: z.string().min(1), member: idSchema }).strict(),
    z.object({ op: z.literal("rule-active"), ruleId: idSchema }).strict(),
    z.object({ op: z.literal("after-step"), step: z.number().int().nonnegative() }).strict(),
    z.object({ op: z.literal("before-step"), step: z.number().int().nonnegative() }).strict(),
    z.object({ op: z.literal("elapsed-days-gte"), days: z.number().finite().nonnegative() }).strict(),
    z.object({ op: z.literal("elapsed-days-lte"), days: z.number().finite().nonnegative() }).strict(),
    z.object({ op: z.literal("story-time-at-or-after"), time: storyTimeSchema }).strict(),
    z.object({ op: z.literal("story-time-before"), time: storyTimeSchema }).strict(),
    z.object({ op: z.literal("all"), items: z.array(predicateSchema) }).strict(),
    z.object({ op: z.literal("any"), items: z.array(predicateSchema) }).strict(),
    z.object({ op: z.literal("not"), item: predicateSchema }).strict(),
  ]),
);

export const eventRelationTypeSchema = z.enum([
  "coreference",
  "subevent",
  "before",
  "after",
  "during",
  "contains",
  "overlaps",
  "starts",
  "finishes",
  "causes",
  "enables",
  "prevents",
  "motivates",
  "explains",
  "narrative-continuation",
]);
export type EventRelationType = z.infer<typeof eventRelationTypeSchema>;

export const eventRelationStatusSchema = z.enum(["explicit", "inferred", "contested"]);
export type EventRelationStatus = z.infer<typeof eventRelationStatusSchema>;

export const eventRelationSchema = z.object({
  id: idSchema,
  fromEventId: idSchema,
  toEventId: idSchema,
  type: eventRelationTypeSchema,
  status: eventRelationStatusSchema,
  confidence: z.number().finite().min(0).max(1),
  mechanism: z.string().trim().min(1).max(1_000).optional(),
  requiredConditions: z.array(predicateSchema).max(32).optional(),
  evidence: z.array(evidenceRefSchema),
  counterEvidence: z.array(evidenceRefSchema).optional(),
}).strict().superRefine((relation, ctx) => {
  if (relation.fromEventId === relation.toEventId) {
    ctx.addIssue({ code: "custom", path: ["toEventId"], message: "An event relation must connect two distinct canonical events" });
  }
  if (relation.status === "explicit" && !relation.evidence.some((item) => item.strength === "explicit")) {
    ctx.addIssue({ code: "custom", path: ["status"], message: "An explicit event relation requires at least one explicit evidence reference" });
  }
  if (relation.status === "contested" && !(relation.counterEvidence?.length)) {
    ctx.addIssue({ code: "custom", path: ["counterEvidence"], message: "A contested event relation requires counter-evidence" });
  }
  if (["causes", "enables", "prevents", "motivates", "explains"].includes(relation.type)
    && relation.status === "inferred" && !relation.mechanism) {
    ctx.addIssue({ code: "custom", path: ["mechanism"], message: "An inferred causal or explanatory relation requires a mechanism" });
  }
}).describe("An evidence-backed relation between canonical events. Narrative continuation and temporal order never imply causation.");
export type EventRelation = z.infer<typeof eventRelationSchema>;

export const stateOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), entityId: idSchema, field: z.string().min(1), value: stateValueSchema }).strict(),
  z.object({ op: z.literal("unset"), entityId: idSchema, field: z.string().min(1) }).strict(),
  z.object({ op: z.literal("add-member"), entityId: idSchema, field: z.string().min(1), member: idSchema }).strict(),
  z.object({ op: z.literal("remove-member"), entityId: idSchema, field: z.string().min(1), member: idSchema }).strict(),
  z.object({ op: z.literal("adjust-number"), entityId: idSchema, field: z.string().min(1), amount: z.number().finite() }).strict(),
  z.object({ op: z.literal("activate-rule"), ruleId: idSchema }).strict(),
  z.object({ op: z.literal("deactivate-rule"), ruleId: idSchema }).strict(),
]);
export type StateOperation = z.infer<typeof stateOperationSchema>;
export const stateDeltaSchema = z.object({ version: z.literal(1), operations: z.array(stateOperationSchema) }).strict();
export type StateDelta = z.infer<typeof stateDeltaSchema>;

export const knowledgeStatusSchema = z.enum(["knows", "believes", "suspects", "heard", "disbelieves"]);
export const knowledgeAcquisitionModeSchema = z.enum([
  "observed",
  "told",
  "read",
  "inferred",
  "remembered",
  "deceived-misattributed",
]);
export type KnowledgeAcquisitionMode = z.infer<typeof knowledgeAcquisitionModeSchema>;
export const knowledgeOperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("learn"),
    actorId: idSchema,
    claimId: idSchema,
    propositionId: idSchema.optional(),
    attributionId: idSchema.optional(),
    acquisitionMode: knowledgeAcquisitionModeSchema.optional(),
    status: knowledgeStatusSchema,
    confidence: z.number().min(0).max(1),
    sourceActorId: idSchema.optional(),
  }).strict(),
  z.object({ op: z.literal("forget"), actorId: idSchema, claimId: idSchema, propositionId: idSchema.optional() }).strict(),
]).superRefine((value, ctx) => {
  if (value.op !== "learn") return;
  const semantic = Boolean(value.propositionId || value.attributionId || value.acquisitionMode);
  if (semantic && !value.propositionId) {
    ctx.addIssue({ code: "custom", path: ["propositionId"], message: "Semantic knowledge acquisition requires propositionId" });
  }
  if (semantic && !value.acquisitionMode) {
    ctx.addIssue({ code: "custom", path: ["acquisitionMode"], message: "Semantic knowledge acquisition requires acquisitionMode" });
  }
  if (value.attributionId && !value.propositionId) {
    ctx.addIssue({ code: "custom", path: ["attributionId"], message: "attributionId requires propositionId" });
  }
  if (value.acquisitionMode === "told") {
    if (!value.sourceActorId) ctx.addIssue({ code: "custom", path: ["sourceActorId"], message: "Told acquisition requires sourceActorId" });
    if (!value.attributionId) ctx.addIssue({ code: "custom", path: ["attributionId"], message: "Told acquisition requires attributionId" });
  }
  if ((value.acquisitionMode === "read" || value.acquisitionMode === "deceived-misattributed") && !value.attributionId) {
    ctx.addIssue({ code: "custom", path: ["attributionId"], message: `${value.acquisitionMode} acquisition requires attributionId` });
  }
  if (
    value.acquisitionMode
    && value.sourceActorId
    && value.acquisitionMode !== "told"
    && value.acquisitionMode !== "deceived-misattributed"
  ) {
    ctx.addIssue({ code: "custom", path: ["sourceActorId"], message: `${value.acquisitionMode} acquisition cannot name a source actor` });
  }
  if (value.acquisitionMode === "deceived-misattributed" && value.status === "knows") {
    ctx.addIssue({ code: "custom", path: ["status"], message: "Deceived or misattributed content cannot have knows status" });
  }
});
export type KnowledgeOperation = z.infer<typeof knowledgeOperationSchema>;
export const knowledgeDeltaSchema = z.object({ version: z.literal(1), operations: z.array(knowledgeOperationSchema) }).strict();
export type KnowledgeDelta = z.infer<typeof knowledgeDeltaSchema>;

/**
 * A source-backed canonical possibility may expose a small number of semantic
 * roles that can be rebound after branch divergence.  This policy belongs to
 * the possibility layer, not to CanonicalEvent: the source event remains a
 * fixed record of who actually participated on the canonical trajectory.
 */
export const canonicalScaffoldRoleSchema = z.object({
  roleId: idSchema,
  canonicalEntityId: idSchema,
  description: z.string().trim().min(1).max(500),
  allowedEntityKinds: z.array(entityKindSchema).min(1).max(8),
  presence: z.enum(["anywhere", "active-scene"]),
  requiredState: z.array(predicateSchema).max(16),
  requiresKnowledge: z.array(idSchema).max(16),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.allowedEntityKinds).size !== value.allowedEntityKinds.length) {
    ctx.addIssue({ code: "custom", message: "allowedEntityKinds must be unique", path: ["allowedEntityKinds"] });
  }
  if (new Set(value.requiresKnowledge).size !== value.requiresKnowledge.length) {
    ctx.addIssue({ code: "custom", message: "requiresKnowledge must be unique", path: ["requiresKnowledge"] });
  }
});
export type CanonicalScaffoldRole = z.infer<typeof canonicalScaffoldRoleSchema>;

export const canonicalScaffoldSchema = z.object({
  version: z.literal(1),
  mode: z.literal("participant-remap"),
  roles: z.array(canonicalScaffoldRoleSchema).min(1).max(4),
}).strict().superRefine((value, ctx) => {
  const roleIds = new Set<string>();
  const canonicalEntityIds = new Set<string>();
  value.roles.forEach((role, index) => {
    if (roleIds.has(role.roleId)) {
      ctx.addIssue({ code: "custom", message: `Duplicate scaffold role ${role.roleId}`, path: ["roles", index, "roleId"] });
    }
    if (canonicalEntityIds.has(role.canonicalEntityId)) {
      ctx.addIssue({ code: "custom", message: `Canonical entity ${role.canonicalEntityId} is assigned to more than one scaffold role`, path: ["roles", index, "canonicalEntityId"] });
    }
    roleIds.add(role.roleId);
    canonicalEntityIds.add(role.canonicalEntityId);
  });
});
export type CanonicalScaffold = z.infer<typeof canonicalScaffoldSchema>;

export const canonicalRoleBindingSchema = z.object({
  roleId: idSchema,
  canonicalEntityId: idSchema,
  boundEntityId: idSchema,
}).strict();
export type CanonicalRoleBinding = z.infer<typeof canonicalRoleBindingSchema>;

/** Replay/audit lineage for a committed scaffold instantiation. */
export const canonicalAdaptationSchema = z.object({
  version: z.literal(1),
  scaffoldPossibilityId: idSchema,
  adaptedFromCanonicalEventId: idSchema,
  sceneActorId: idSchema,
  roleBindings: z.array(canonicalRoleBindingSchema).min(1).max(4),
  coreEffectHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((value, ctx) => {
  const roleIds = new Set<string>();
  const canonicalEntityIds = new Set<string>();
  const boundEntityIds = new Set<string>();
  value.roleBindings.forEach((binding, index) => {
    if (roleIds.has(binding.roleId)) {
      ctx.addIssue({ code: "custom", message: `Duplicate adaptation role ${binding.roleId}`, path: ["roleBindings", index, "roleId"] });
    }
    if (canonicalEntityIds.has(binding.canonicalEntityId)) {
      ctx.addIssue({ code: "custom", message: `Canonical entity ${binding.canonicalEntityId} is rebound more than once`, path: ["roleBindings", index, "canonicalEntityId"] });
    }
    if (boundEntityIds.has(binding.boundEntityId)) {
      ctx.addIssue({ code: "custom", message: `Bound entity ${binding.boundEntityId} fills more than one role`, path: ["roleBindings", index, "boundEntityId"] });
    }
    roleIds.add(binding.roleId);
    canonicalEntityIds.add(binding.canonicalEntityId);
    boundEntityIds.add(binding.boundEntityId);
  });
});
export type CanonicalAdaptation = z.infer<typeof canonicalAdaptationSchema>;

/**
 * A source-grounded cut immediately before one character's first embodied
 * canonical scene. It is distinct from the event outcome: the delta/knowledge
 * describe facts already true at the cut, actorObservation is limited to what
 * that character can perceive, and readerSetup is presentation-only context.
 */
export const characterEntryCheckpointSchema = z
  .object({
    actorId: idSchema,
    readerSetup: z.string().trim().min(1).max(1_500),
    actorObservation: z.string().trim().min(1).max(1_000),
    participantPresence: z.array(participantPresenceSchema).min(1).max(128),
    delta: stateDeltaSchema,
    knowledge: knowledgeDeltaSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    let actorIsPhysical = false;
    for (let index = 0; index < value.participantPresence.length; index += 1) {
      const presence = value.participantPresence[index]!;
      if (seen.has(presence.entityId)) {
        ctx.addIssue({
          code: "custom",
          message: "Entry checkpoint presence entries must have unique entity IDs",
          path: ["participantPresence", index, "entityId"],
        });
      }
      seen.add(presence.entityId);
      if (presence.entityId === value.actorId && presence.mode === "physical") actorIsPhysical = true;
    }
    if (!actorIsPhysical) {
      ctx.addIssue({
        code: "custom",
        message: "An entry checkpoint must establish its selected actor as physically present",
        path: ["participantPresence"],
      });
    }
  });
export type CharacterEntryCheckpoint = z.infer<typeof characterEntryCheckpointSchema>;

/**
 * A committed event may advance the playable narrative without changing a
 * canonical state field. These tags are typed, validated commit metadata rather
 * than prose: the host derives channels/identity, while a world adjudication may
 * propose the outcome status. They make scene movement, relationships, plans,
 * pressures, consequences, and thread attachment replayable from branch history.
 */
export const progressChannelSchema = z.enum([
  "state",
  "knowledge",
  "scene",
  "relationship",
  "resource",
  "plan",
  "thread",
  "time-pressure",
  "consequence",
]);
export type ProgressChannel = z.infer<typeof progressChannelSchema>;

export const eventOutcomeStatusSchema = z.enum(["succeeded", "partial", "blocked", "interrupted"]);
export type EventOutcomeStatus = z.infer<typeof eventOutcomeStatusSchema>;

export const sceneTransitionSchema = z
  .object({
    kind: z.enum(["stay", "depart", "arrive", "explore"]),
    /**
     * Branch-local identity for an open scene that has not been reconciled to
     * a compiled location entity. Labels are presentation and localization;
     * they must never be used as scene identity for new events.
     */
    sceneId: idSchema.optional(),
    label: z.string().trim().min(1).max(240).optional(),
    destinationEntityId: idSchema.optional(),
    beat: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.sceneId && value.kind !== "depart" && value.kind !== "explore") {
      ctx.addIssue({ code: "custom", message: "sceneId is reserved for open depart/explore transitions", path: ["sceneId"] });
    }
    if (value.destinationEntityId && value.kind !== "arrive") {
      ctx.addIssue({ code: "custom", message: "destinationEntityId requires an arrive transition", path: ["destinationEntityId"] });
    }
  });
export type SceneTransition = z.infer<typeof sceneTransitionSchema>;

export const narrativeProgressSchema = z
  .object({
    version: z.literal(1),
    channels: z.array(progressChannelSchema).min(1),
    threadIds: z.array(idSchema).default([]),
    noveltyKey: z.string().trim().min(1).max(500),
    outcome: eventOutcomeStatusSchema.optional(),
    scene: sceneTransitionSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.channels).size !== value.channels.length) {
      ctx.addIssue({ code: "custom", message: "Progress channels must be unique", path: ["channels"] });
    }
    if (new Set(value.threadIds).size !== value.threadIds.length) {
      ctx.addIssue({ code: "custom", message: "Progress thread IDs must be unique", path: ["threadIds"] });
    }
    if (value.scene && !value.channels.includes("scene")) {
      ctx.addIssue({ code: "custom", message: "A scene transition requires the scene progress channel", path: ["channels"] });
    }
  });
export type NarrativeProgress = z.infer<typeof narrativeProgressSchema>;

export const canonicalEventSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  /** Completed-event recap for a reader who enters at a later source scene. */
  readerSummary: z.string().trim().min(1).max(1_500).optional(),
  participants: z.array(idSchema),
  participantPresence: z.array(participantPresenceSchema).max(128).optional()
    .describe("Exactly one presence entry for every character participant; never include non-character participants."),
  characterEntryCheckpoints: z.array(characterEntryCheckpointSchema).max(128).optional(),
  storyTime: storyTimeSchema,
  timeAdvance: timeAdvanceSchema.optional(),
  narrativeContext: narrativeContextSchema.optional(),
  preconditions: z.array(predicateSchema),
  observedOutcome: stateDeltaSchema,
  observedKnowledge: knowledgeDeltaSchema.optional(),
  evidence: z.array(evidenceRefSchema),
  causalParents: z.array(idSchema),
  confidence: z.number().min(0).max(1),
}).strict();
export type CanonicalEvent = z.infer<typeof canonicalEventSchema>;

export const worldRuleScopeSchema = z.enum(["global", "entity", "location", "faction", "institution"]);
export const worldRuleKindSchema = z.enum(["physical", "social", "legal", "magical", "institutional"]);
export const worldRuleVisibilitySchema = z.enum(["public", "observable", "knowledge", "engine"]);
export const worldRuleClauseModalitySchema = z.enum(["require", "forbid"]);
const worldRuleStoryTimeSchema = storyTimeSchema.refine(
  (value) => value.kind !== "relative" && value.kind !== "unknown",
  "World-rule validity must use a concrete calendar/range/ordinal scope; event-driven changes use committed activate-rule/deactivate-rule operations",
);

const worldRuleEvidenceShape = {
  basis: z.enum(["explicit", "inferred"]),
  status: z.enum(["supported", "contested"]),
  confidence: z.number().finite().min(0).max(1),
  evidence: z.array(evidenceRefSchema).min(1),
  counterEvidence: z.array(evidenceRefSchema).optional(),
} as const;

export const worldRuleClauseSchema = z.object({
  id: idSchema,
  modality: worldRuleClauseModalitySchema,
  predicate: predicateSchema,
  ...worldRuleEvidenceShape,
}).strict().superRefine(validateWorldRuleEvidenceShape);
export type WorldRuleClause = z.infer<typeof worldRuleClauseSchema>;

export const worldRuleExceptionSchema = z.object({
  id: idSchema,
  appliesWhen: z.array(predicateSchema).min(1).max(32),
  ...worldRuleEvidenceShape,
}).strict().superRefine(validateWorldRuleEvidenceShape);
export type WorldRuleException = z.infer<typeof worldRuleExceptionSchema>;

export const legacyWorldRuleSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  scope: worldRuleScopeSchema,
  appliesWhen: z.array(predicateSchema),
  forbids: z.array(predicateSchema).optional(),
  requires: z.array(predicateSchema).optional(),
  evidence: z.array(evidenceRefSchema),
}).strict();
export type LegacyWorldRule = z.infer<typeof legacyWorldRuleSchema>;

export const controlledWorldRuleSchema = z.object({
  ontologyVersion: z.literal("world-rule-v2"),
  id: idSchema,
  name: z.string().trim().min(1).max(500),
  kind: worldRuleKindSchema,
  scope: worldRuleScopeSchema,
  authorityEntityId: idSchema.optional(),
  jurisdictionEntityIds: z.array(idSchema).max(64).default([]),
  appliesWhen: z.array(predicateSchema).max(64).default([]),
  validStoryTime: worldRuleStoryTimeSchema.optional(),
  visibility: worldRuleVisibilitySchema,
  knownByClaimIds: z.array(idSchema).max(64).default([]),
  priority: z.number().int().min(0).max(10_000),
  defeasible: z.boolean(),
  overridesRuleIds: z.array(idSchema).max(64).default([]),
  clauses: z.array(worldRuleClauseSchema).min(1).max(64),
  exceptions: z.array(worldRuleExceptionSchema).max(32).default([]),
  ...worldRuleEvidenceShape,
}).strict().superRefine((rule, ctx) => {
  validateWorldRuleEvidenceShape(rule, ctx);
  for (const [field, values] of [
    ["jurisdictionEntityIds", rule.jurisdictionEntityIds],
    ["knownByClaimIds", rule.knownByClaimIds],
    ["overridesRuleIds", rule.overridesRuleIds],
  ] as const) {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: "custom", path: [field], message: `${field} must contain unique IDs` });
    }
  }
  if (rule.scope === "global" && rule.jurisdictionEntityIds.length) {
    ctx.addIssue({ code: "custom", path: ["jurisdictionEntityIds"], message: "A global rule cannot declare a bounded jurisdiction" });
  }
  if (rule.scope !== "global" && !rule.jurisdictionEntityIds.length) {
    ctx.addIssue({ code: "custom", path: ["jurisdictionEntityIds"], message: `A ${rule.scope}-scoped rule requires at least one jurisdiction entity` });
  }
  if (rule.visibility === "knowledge" && !rule.knownByClaimIds.length) {
    ctx.addIssue({ code: "custom", path: ["knownByClaimIds"], message: "A knowledge-visible rule requires at least one grounding claim" });
  }
  if (rule.visibility !== "knowledge" && rule.knownByClaimIds.length) {
    ctx.addIssue({ code: "custom", path: ["knownByClaimIds"], message: "knownByClaimIds is reserved for knowledge-visible rules" });
  }
  if (rule.overridesRuleIds.includes(rule.id)) {
    ctx.addIssue({ code: "custom", path: ["overridesRuleIds"], message: "A rule cannot override itself" });
  }
  const semanticIds = [...rule.clauses, ...rule.exceptions].map((item) => item.id);
  if (new Set(semanticIds).size !== semanticIds.length) {
    ctx.addIssue({ code: "custom", path: ["clauses"], message: "Clause and exception IDs must be unique within one rule" });
  }
  if (rule.status === "supported" && !rule.clauses.some((clause) => clause.status === "supported")) {
    ctx.addIssue({ code: "custom", path: ["clauses"], message: "A supported rule requires at least one supported executable clause" });
  }
});
export type ControlledWorldRule = z.infer<typeof controlledWorldRuleSchema>;

export const worldRuleSchema = z.union([controlledWorldRuleSchema, legacyWorldRuleSchema]);
export type WorldRule = z.infer<typeof worldRuleSchema>;

function validateWorldRuleEvidenceShape(
  value: { basis: "explicit" | "inferred"; status: "supported" | "contested"; evidence: EvidenceRef[]; counterEvidence?: EvidenceRef[] },
  ctx: z.RefinementCtx,
): void {
  const evidenceKeys = value.evidence.map((reference) => JSON.stringify(reference));
  if (new Set(evidenceKeys).size !== evidenceKeys.length) {
    ctx.addIssue({ code: "custom", path: ["evidence"], message: "Rule evidence references must be unique" });
  }
  const counterKeys = (value.counterEvidence ?? []).map((reference) => JSON.stringify(reference));
  if (new Set(counterKeys).size !== counterKeys.length) {
    ctx.addIssue({ code: "custom", path: ["counterEvidence"], message: "Rule counter-evidence references must be unique" });
  }
  const overlap = counterKeys.filter((key) => evidenceKeys.includes(key));
  if (overlap.length) {
    ctx.addIssue({ code: "custom", path: ["counterEvidence"], message: "One exact source reference cannot both support and contradict the same rule semantic" });
  }
  if (value.status === "contested" && !value.counterEvidence?.length) {
    ctx.addIssue({ code: "custom", path: ["counterEvidence"], message: "A contested rule semantic requires counter-evidence" });
  }
  if (value.status === "supported" && value.counterEvidence?.length) {
    ctx.addIssue({ code: "custom", path: ["counterEvidence"], message: "Counter-evidence requires contested status" });
  }
  if (value.basis === "explicit" && !value.evidence.some((reference) => reference.strength === "explicit")) {
    ctx.addIssue({ code: "custom", path: ["basis"], message: "An explicit rule semantic requires explicit evidence" });
  }
}

export const actorEventObservationSchema = z.object({
  actorId: idSchema,
  summary: z.string().trim().min(1).max(1_000),
}).strict();
export type ActorEventObservation = z.infer<typeof actorEventObservationSchema>;

/**
 * Exact words that were spoken as part of a committed event. The semantic
 * knowledge transfer still lives in KnowledgeDelta; this record exists so a
 * literary renderer can preserve wording without reverse-engineering dialogue
 * from an actor-observation summary.
 */
export const spokenUtteranceSchema = z.object({
  speakerId: idSchema,
  addresseeIds: z.array(idSchema).min(1).max(16),
  content: z.string().trim().min(1).max(2_000),
  channel: z.literal("audible").default("audible"),
}).strict();
export type SpokenUtterance = z.infer<typeof spokenUtteranceSchema>;

/** Event-scoped affect. Continuity is derived from history; this is not a second mutable character state. */
export const actorAffectSchema = z.object({
  actorId: idSchema,
  label: z.string().trim().min(1).max(120),
  intensity: z.number().min(0).max(1),
  expression: z.string().trim().min(1).max(500).optional(),
}).strict();
export type ActorAffect = z.infer<typeof actorAffectSchema>;

export const eventProposalBaseSchema = z
  .object({
    proposalId: idSchema,
    branchId: idSchema,
    expectedParentCommit: idSchema,
    source: z.enum(["player", "actor", "background", "canon-candidate", "compiler"]),
    actorId: idSchema.optional(),
    title: z.string().min(1),
    actorObservations: z.array(actorEventObservationSchema).max(128).optional(),
    actorAffects: z.array(actorAffectSchema).max(128).optional(),
    spokenUtterances: z.array(spokenUtteranceSchema).max(32).optional(),
    participants: z.array(idSchema),
    participantPresence: z.array(participantPresenceSchema).max(128).optional(),
    proposedTime: storyTimeSchema,
    timeAdvance: timeAdvanceSchema.optional(),
    preconditions: z.array(predicateSchema),
    proposedDelta: stateDeltaSchema,
    proposedKnowledge: knowledgeDeltaSchema.optional(),
    causalParents: z.array(idSchema),
    supersedesCanonicalEventIds: z.array(idSchema).optional(),
    evidence: z.array(evidenceRefSchema),
    possibilityId: idSchema.optional(),
    canonicalAdaptation: canonicalAdaptationSchema.optional(),
    progress: narrativeProgressSchema.optional(),
  })
  .strict();
export type EventProposalBase = z.infer<typeof eventProposalBaseSchema>;

export function validateCanonicalAdaptationProposalEnvelope(
  value: Pick<EventProposalBase, "possibilityId" | "canonicalAdaptation">,
  ctx: z.RefinementCtx,
): void {
  if (value.canonicalAdaptation && value.possibilityId !== value.canonicalAdaptation.scaffoldPossibilityId) {
    ctx.addIssue({
      code: "custom",
      message: "A canonical adaptation must use its scaffold possibility as possibilityId",
      path: ["possibilityId"],
    });
  }
}

export const eventProposalSchema = eventProposalBaseSchema.superRefine((value, ctx) => {
  validateSpokenUtteranceParticipants(value, ctx);
  validateCanonicalAdaptationProposalEnvelope(value, ctx);
});
export type EventProposal = z.infer<typeof eventProposalSchema>;

export const committedEventSchema = z
  .object({
    version: z.literal(1),
    eventId: idSchema,
    branchId: idSchema,
    logicalTime: logicalTimeSchema,
    timeAdvance: timeAdvanceSchema.optional(),
    proposalId: idSchema.optional(),
    title: z.string().min(1),
    actorObservations: z.array(actorEventObservationSchema).max(128).optional(),
    actorAffects: z.array(actorAffectSchema).max(128).optional(),
    spokenUtterances: z.array(spokenUtteranceSchema).max(32).optional(),
    participants: z.array(idSchema),
    participantPresence: z.array(participantPresenceSchema).max(128).optional(),
    deltaHash: idSchema,
    knowledgeDeltaHash: idSchema.optional(),
    evidence: z.array(evidenceRefSchema),
    causalParents: z.array(idSchema),
    supersedesCanonicalEventIds: z.array(idSchema).optional(),
    realizesCanonicalEventIds: z.array(idSchema).optional(),
    possibilityId: idSchema.optional(),
    canonicalAdaptation: canonicalAdaptationSchema.optional(),
    actorId: idSchema.optional(),
    progress: narrativeProgressSchema.optional(),
  })
  .strict()
  .superRefine(validateSpokenUtteranceParticipants)
  .superRefine(validateParticipantPresence)
  .superRefine((value, ctx) => {
    if (value.canonicalAdaptation && value.possibilityId !== value.canonicalAdaptation.scaffoldPossibilityId) {
      ctx.addIssue({
        code: "custom",
        message: "A committed canonical adaptation must retain its scaffold possibilityId",
        path: ["possibilityId"],
      });
    }
    if (value.canonicalAdaptation && value.realizesCanonicalEventIds?.includes(value.canonicalAdaptation.adaptedFromCanonicalEventId)) {
      ctx.addIssue({
        code: "custom",
        message: "An adapted analogue cannot claim exact realization of its source canonical event",
        path: ["realizesCanonicalEventIds"],
      });
    }
  });
export type CommittedEvent = z.infer<typeof committedEventSchema>;

function validateSpokenUtteranceParticipants(
  value: { participants: string[]; spokenUtterances?: SpokenUtterance[] },
  ctx: z.RefinementCtx,
): void {
  value.spokenUtterances?.forEach((utterance, index) => {
    if (!value.participants.includes(utterance.speakerId)) {
      ctx.addIssue({
        code: "custom",
        message: "A spoken utterance speaker must be an event participant",
        path: ["spokenUtterances", index, "speakerId"],
      });
    }
    utterance.addresseeIds.forEach((addresseeId, addresseeIndex) => {
      if (!value.participants.includes(addresseeId)) {
        ctx.addIssue({
          code: "custom",
          message: "A spoken utterance addressee must be an event participant",
          path: ["spokenUtterances", index, "addresseeIds", addresseeIndex],
        });
      }
    });
  });
}

export const branchSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  sourceId: idSchema.optional(),
  preparedRevisionHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  createdAt: z.string().datetime({ offset: true }).optional(),
  parentBranchId: idSchema.optional(),
  forkCommitId: idSchema.optional(),
  headCommitId: idSchema,
}).strict();
export type Branch = z.infer<typeof branchSchema>;
export const worldCommitSchema = z.object({ version: z.literal(1), parentCommitId: idSchema.optional(), branchId: idSchema, logicalTime: logicalTimeSchema, eventHashes: z.array(idSchema), canonicalSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), engineVersion: z.string().min(1), schemaVersion: z.number().int().positive() }).strict();
export type WorldCommit = z.infer<typeof worldCommitSchema>;
export const worldStateSchema = z.object({ atCommit: idSchema, logicalTime: logicalTimeSchema, values: z.record(z.string(), z.record(z.string(), stateValueSchema)), activeRuleIds: z.array(idSchema) }).strict();
export type WorldState = z.infer<typeof worldStateSchema>;

export const possibilityKindSchema = z.enum([
  "canon-analogue",
  "player-choice",
  "actor-plan",
  "obligation",
  "causal-consequence",
  "background-pressure",
  "environmental",
  "generated",
]);
export type PossibilityKind = z.infer<typeof possibilityKindSchema>;
export const AUTONOMOUS_BACKGROUND_KINDS = [
  "obligation",
  "causal-consequence",
  "background-pressure",
  "environmental",
  "generated",
] as const satisfies readonly PossibilityKind[];

export const possibilityBaseSchema = z
  .object({
    id: idSchema,
    branchId: idSchema,
    evaluatedAtCommit: idSchema,
    kind: possibilityKindSchema,
    title: z.string().min(1),
    candidateWindow: storyTimeSchema.optional(),
    timeAdvance: timeAdvanceSchema.optional(),
    preconditions: z.array(predicateSchema),
    blockers: z.array(predicateSchema),
    expiry: z.array(predicateSchema).optional(),
    participants: z.array(idSchema),
    participantPresence: z.array(participantPresenceSchema).max(128).optional(),
    causalParents: z.array(idSchema),
    canonicalEventId: idSchema.optional(),
    pressure: z.number().min(0),
    relevance: z.number().min(0),
    proposedDelta: stateDeltaSchema.optional(),
    proposedKnowledge: knowledgeDeltaSchema.optional(),
    canonicalScaffold: canonicalScaffoldSchema.optional(),
    evidence: z.array(evidenceRefSchema),
  })
  .strict();
export type PossibilityBase = z.infer<typeof possibilityBaseSchema>;

type CanonicalScaffoldPossibilityShape = Pick<
  PossibilityBase,
  "kind" | "canonicalEventId" | "proposedDelta" | "participants" | "canonicalScaffold"
>;

export function validateCanonicalScaffoldPossibility(value: CanonicalScaffoldPossibilityShape, ctx: z.RefinementCtx): void {
  if (!value.canonicalScaffold) return;
  if (value.kind !== "canon-analogue") {
    ctx.addIssue({ code: "custom", message: "A canonical scaffold must use kind=canon-analogue", path: ["kind"] });
  }
  if (!value.canonicalEventId) {
    ctx.addIssue({ code: "custom", message: "A canonical scaffold must reference canonicalEventId", path: ["canonicalEventId"] });
  }
  if (!value.proposedDelta) {
    ctx.addIssue({ code: "custom", message: "A canonical scaffold requires a typed core effect", path: ["proposedDelta"] });
  }
  value.canonicalScaffold.roles.forEach((role, index) => {
    if (!value.participants.includes(role.canonicalEntityId)) {
      ctx.addIssue({
        code: "custom",
        message: `Scaffold role ${role.roleId} canonical entity must be an event participant`,
        path: ["canonicalScaffold", "roles", index, "canonicalEntityId"],
      });
    }
  });
}

export const possibilitySchema = possibilityBaseSchema.superRefine(validateCanonicalScaffoldPossibility);
export type Possibility = z.infer<typeof possibilitySchema>;

export function validateParticipantPresence(
  value: { participants: readonly string[]; participantPresence?: readonly ParticipantPresence[] },
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (let index = 0; index < (value.participantPresence?.length ?? 0); index += 1) {
    const presence = value.participantPresence![index]!;
    if (!value.participants.includes(presence.entityId)) {
      ctx.addIssue({
        code: "custom",
        message: "Participant presence must refer to an event participant",
        path: ["participantPresence", index, "entityId"],
      });
    }
    if (seen.has(presence.entityId)) {
      ctx.addIssue({
        code: "custom",
        message: "Participant presence entries must have unique entity IDs",
        path: ["participantPresence", index, "entityId"],
      });
    }
    seen.add(presence.entityId);
  }
}

export const knowledgeFactSchema = z.object({
  actorId: idSchema,
  claimId: idSchema,
  propositionId: idSchema.optional(),
  attributionId: idSchema.optional(),
  acquisitionMode: knowledgeAcquisitionModeSchema.optional(),
  status: knowledgeStatusSchema,
  confidence: z.number().min(0).max(1),
  acquiredAtCommit: idSchema,
  sourceActorId: idSchema.optional(),
}).strict();
export type KnowledgeFact = z.infer<typeof knowledgeFactSchema>;

export const validationIssueSchema = z.object({ code: z.string().min(1), message: z.string().min(1), path: z.string().optional() }).strict();
export type ValidationIssue = z.infer<typeof validationIssueSchema>;
export const validationReportSchema = z.object({ proposalId: idSchema, evaluatedAtCommit: idSchema, accepted: z.boolean(), errors: z.array(validationIssueSchema), warnings: z.array(validationIssueSchema), derivedDeltaHash: idSchema.optional() }).strict();
export type ValidationReport = z.infer<typeof validationReportSchema>;

export const artifactProposalSchema = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({ id: idSchema, kind: z.string().min(1), schemaVersion: z.number().int().positive(), payload, evidence: z.array(evidenceRefSchema), evidenceAssertions: z.array(evidenceAssertionSchema).default([]), generatedBy: z.object({ worker: z.string().min(1), provider: z.string().optional(), model: z.string().optional(), promptHash: z.string().optional(), compilerBatchId: idSchema.optional() }).strict(), createdAt: z.string().min(1) }).strict();

export type ArtifactProposal<T> = { id: ProposalId; kind: string; schemaVersion: number; payload: T; evidence: EvidenceRef[]; evidenceAssertions?: EvidenceAssertion[]; generatedBy: { worker: string; provider?: string; model?: string; promptHash?: string; compilerBatchId?: string }; createdAt: string };

export const WORLD_SCHEMA_VERSION = 1;
export const WORLD_ENGINE_VERSION = "0.1.0";
