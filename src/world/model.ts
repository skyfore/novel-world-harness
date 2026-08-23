import { z } from "zod";

export type ProjectId = string;
export type EntityId = string;
export type ClaimId = string;
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
export const participantPresenceSchema = z.object({
  entityId: idSchema,
  mode: z.enum(["physical", "remote", "mentioned", "represented", "dream", "memory"]),
}).strict();
export type ParticipantPresence = z.infer<typeof participantPresenceSchema>;

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
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.minimum !== undefined || value.maximum !== undefined) && value.valueType !== "number") {
      ctx.addIssue({ code: "custom", message: "minimum/maximum are only valid for number fields" });
    }
    if (value.minimum !== undefined && value.maximum !== undefined && value.minimum > value.maximum) {
      ctx.addIssue({ code: "custom", message: "minimum must be <= maximum", path: ["minimum"] });
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
export const knowledgeOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("learn"), actorId: idSchema, claimId: idSchema, status: knowledgeStatusSchema, confidence: z.number().min(0).max(1), sourceActorId: idSchema.optional() }).strict(),
  z.object({ op: z.literal("forget"), actorId: idSchema, claimId: idSchema }).strict(),
]);
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
  participantPresence: z.array(participantPresenceSchema).max(128).optional(),
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

export const worldRuleSchema = z.object({ id: idSchema, name: z.string().min(1), scope: z.enum(["global", "entity", "location", "faction", "institution"]), appliesWhen: z.array(predicateSchema), forbids: z.array(predicateSchema).optional(), requires: z.array(predicateSchema).optional(), evidence: z.array(evidenceRefSchema) }).strict();
export type WorldRule = z.infer<typeof worldRuleSchema>;

export const actorEventObservationSchema = z.object({
  actorId: idSchema,
  summary: z.string().trim().min(1).max(1_000),
}).strict();
export type ActorEventObservation = z.infer<typeof actorEventObservationSchema>;

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

export const eventProposalSchema = eventProposalBaseSchema.superRefine(validateCanonicalAdaptationProposalEnvelope);
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

export const knowledgeFactSchema = z.object({ actorId: idSchema, claimId: idSchema, status: knowledgeStatusSchema, confidence: z.number().min(0).max(1), acquiredAtCommit: idSchema, sourceActorId: idSchema.optional() }).strict();
export type KnowledgeFact = z.infer<typeof knowledgeFactSchema>;

export const validationIssueSchema = z.object({ code: z.string().min(1), message: z.string().min(1), path: z.string().optional() }).strict();
export type ValidationIssue = z.infer<typeof validationIssueSchema>;
export const validationReportSchema = z.object({ proposalId: idSchema, evaluatedAtCommit: idSchema, accepted: z.boolean(), errors: z.array(validationIssueSchema), warnings: z.array(validationIssueSchema), derivedDeltaHash: idSchema.optional() }).strict();
export type ValidationReport = z.infer<typeof validationReportSchema>;

export const artifactProposalSchema = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({ id: idSchema, kind: z.string().min(1), schemaVersion: z.number().int().positive(), payload, evidence: z.array(evidenceRefSchema), generatedBy: z.object({ worker: z.string().min(1), provider: z.string().optional(), model: z.string().optional(), promptHash: z.string().optional(), compilerBatchId: idSchema.optional() }).strict(), createdAt: z.string().min(1) }).strict();

export type ArtifactProposal<T> = { id: ProposalId; kind: string; schemaVersion: number; payload: T; evidence: EvidenceRef[]; generatedBy: { worker: string; provider?: string; model?: string; promptHash?: string; compilerBatchId?: string }; createdAt: string };

export const WORLD_SCHEMA_VERSION = 1;
export const WORLD_ENGINE_VERSION = "0.1.0";
