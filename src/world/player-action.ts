import { z } from "zod";
import { commitKnowledgeAwareAction, validateActionKnowledge, type KnowledgeAwareAction } from "./action-gate.js";
import { contentHash } from "./canonical.js";
import { validateEventProposal, type WorldEngine, type WorldModelContext } from "./engine.js";
import { isActionableKnowledge, KnowledgeProjector } from "./knowledge.js";
import {
  claimSchema,
  entityKindSchema,
  eventProposalSchema,
  idSchema,
  knowledgeDeltaSchema,
  knowledgeStatusSchema,
  narrativeProgressSchema,
  predicateSchema,
  stateDeltaSchema,
  stateFieldSpecSchema,
  stateValueSchema,
  timeAdvanceSchema,
  type CommitId,
  type Entity,
  type EntityId,
  type EventOutcomeStatus,
  type EventProposal,
  type NarrativeProgress,
  type ProgressChannel,
  type Predicate,
  type StoryTime,
  type TimeAdvance,
  type StateFieldSpec,
  type StateValue,
  type ValidationIssue,
  type ValidationReport,
  type WorldState,
} from "./model.js";
import { NarrativeRenderer } from "./narrative.js";
import type { CanonicalChoiceResolution } from "./runtime.js";
import { committedHistory, projectActorScene } from "./scene.js";
import { advanceStoryTime, timeAdvanceInDays } from "./time.js";
import { projectActorVisibleState } from "./actor-visible.js";
import { evidenceBelongsExclusivelyToSource, resolveCommitSourceId } from "./source-scope.js";
import { deepFreeze, immutableClone } from "../util/immutable.js";
import {
  materializeRuntimeContextNeed,
  mergeRuntimeContextSupplements,
  isRuntimeContextGapIssue,
  runtimeContextConsultationResultSchema,
  runtimeContextNeedForIssues,
  runtimeContextRequestSchema,
  runtimeContextSupplementHasMaterial,
  type RuntimeCompilerRepairHint,
  type RuntimeContextConsultationRecord,
  type RuntimeContextConsultationObserver,
  type RuntimeContextNeed,
  type RuntimeContextRequest,
  type RuntimeContextResolver,
  type RuntimeContextSupplement,
} from "./runtime-context.js";
import {
  modelPlayConversation,
  playConversationAtCommit,
  recentPlayConversation,
  type ModelPlayConversationMessage,
} from "./play-conversation.js";
import {
  modelVisibleSpatialRelationSchema,
  modelVisibleSpatialRelations,
  findSpatialRoute,
  resolveActiveSpatialRelations,
  spatialLocationsMayOverlap,
  spatialTravelModeSchema,
} from "./spatial-ontology.js";
import { modelVisibleWorldRules, resolveEffectiveWorldRules } from "./world-rule-ontology.js";

/**
 * The model-facing action shape deliberately omits every authority-bearing
 * EventProposal field. The host supplies identity, branch/head, source, actor,
 * time, causal ancestry, and evidence after this candidate is captured.
 */
export const playerIntentTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("entity"), entityId: idSchema }).strict(),
  z.object({ kind: z.literal("described"), description: z.string().trim().min(1).max(240) }).strict(),
]);
export type PlayerIntentTarget = z.infer<typeof playerIntentTargetSchema>;

export const playerIntentSceneTransitionSchema = z
  .object({
    kind: z.enum(["stay", "depart", "arrive", "explore"]),
    destination: playerIntentTargetSchema.optional(),
    travelMode: spatialTravelModeSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "arrive" && value.destination?.kind !== "entity") {
      ctx.addIssue({ code: "custom", message: "Arrival requires a compiled location entity; use depart/explore for a described open destination", path: ["destination"] });
    }
    if (value.kind === "stay" && value.destination) {
      ctx.addIssue({ code: "custom", message: "A stay transition cannot name a destination", path: ["destination"] });
    }
    if (value.kind === "stay" && value.travelMode) {
      ctx.addIssue({ code: "custom", message: "A stay transition cannot name a travel mode", path: ["travelMode"] });
    }
  });
export type PlayerIntentSceneTransition = z.infer<typeof playerIntentSceneTransitionSchema>;

export const playerInteractionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("speech"),
    content: z.string().trim().min(1).max(800),
    addresseeIds: z.array(idSchema).min(1).max(4),
    channel: z.literal("audible").default("audible"),
  }).strict(),
  z.object({
    kind: z.literal("gesture"),
    description: z.string().trim().min(1).max(800),
    addresseeIds: z.array(idSchema).min(1).max(4),
    channel: z.literal("visible").default("visible"),
  }).strict(),
  z.object({
    kind: z.literal("physical"),
    description: z.string().trim().min(1).max(800),
    addresseeIds: z.array(idSchema).min(1).max(4),
    channel: z.literal("physical").default("physical"),
  }).strict(),
]);
export type PlayerInteraction = z.infer<typeof playerInteractionSchema>;

/**
 * The part of an intent the selected actor can perform without assuming that
 * the surrounding world, another entity, or an unknown fact cooperates. These
 * strings remain proposal/audit data. Their separate shape helps identify an
 * eligible typed fallback, but failed adjudication never makes the strings
 * themselves authoritative.
 */
export const playerControlledActSchema = z.object({
  eventTitle: z.string().trim().min(1).max(500),
  actorObservation: z.string().trim().min(1).max(1_000),
  /** Required at the model boundary so omission cannot silently mean "not directed". */
  interactionMode: z.enum(["none", "direct"]).optional(),
  /** Typed perceptible interaction; desired responses remain outside player control. */
  interaction: playerInteractionSchema.optional(),
}).strict();
export type PlayerControlledAct = z.infer<typeof playerControlledActSchema>;

/**
 * Language-neutral semantic intent proposed by the interpreter. `summary` is
 * explanatory data for another model, never an authority-bearing world fact.
 * Engine-relevant effects are represented by typed targets, scene movement,
 * time and the candidate deltas rather than by matching words in the player's
 * utterance.
 */
export const playerIntentSchema = z
  .object({
    kind: z.enum(["act", "observe", "reflect", "wait"]),
    summary: z.string().trim().min(1).max(1_000),
    controlledAct: playerControlledActSchema.optional(),
    desiredEffect: z.string().trim().min(1).max(1_000).optional(),
    targets: z.array(playerIntentTargetSchema).max(32).default([]),
    sceneTransition: playerIntentSceneTransitionSchema.optional(),
    requestedTimeAdvance: timeAdvanceSchema.optional(),
  })
  .strict();
export type PlayerIntent = z.infer<typeof playerIntentSchema>;

export const playerActionCandidateSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    /** Optional only for host/test compatibility; model adapters require it. */
    intent: playerIntentSchema.optional(),
    participants: z.array(idSchema).default([]),
    preconditions: z.array(predicateSchema).default([]),
    proposedDelta: stateDeltaSchema,
    proposedKnowledge: knowledgeDeltaSchema.optional(),
    requiresKnowledge: z.array(idSchema).default([]),
    forbidsKnowledge: z.array(idSchema).default([]),
  })
  .strict();
export type PlayerActionCandidate = z.infer<typeof playerActionCandidateSchema>;

const playerControlledActModelSchema = z.discriminatedUnion("interactionMode", [
  playerControlledActSchema.omit({ interactionMode: true, interaction: true }).extend({
    interactionMode: z.literal("none"),
  }).strict(),
  playerControlledActSchema.omit({ interactionMode: true, interaction: true }).extend({
    interactionMode: z.literal("direct"),
    interaction: playerInteractionSchema,
  }).strict(),
]);

/** Model translators must make the controllable/effect boundary explicit. */
export const playerActionModelCandidateSchema = playerActionCandidateSchema.extend({
  intent: playerIntentSchema.extend({
    controlledAct: playerControlledActModelSchema,
  }).strict(),
}).strict();

/** A translator may return a candidate or explicitly preserve a material data gap. */
export const playerActionTranslationOutputSchema = z.union([
  playerActionCandidateSchema,
  runtimeContextRequestSchema,
]);
export type PlayerActionTranslationOutput = z.infer<typeof playerActionTranslationOutputSchema>;

const playerWorldEventCopySchema = playerControlledActSchema;

export const playerContradictionBasisSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("state"),
    entityId: idSchema,
    field: z.string().trim().min(1).max(240),
  }).strict(),
  z.object({
    source: z.literal("active-rule"),
    name: z.string().trim().min(1).max(500),
  }).strict(),
  z.object({
    source: z.literal("deterministic-issue"),
    code: z.string().trim().min(1).max(240),
  }).strict(),
  z.object({
    source: z.literal("causal-principle"),
    principle: z.string().trim().min(1).max(1_000),
  }).strict(),
]);
export type PlayerContradictionBasis = z.infer<typeof playerContradictionBasisSchema>;

export const playerWorldResolutionSchema = z.discriminatedUnion("decision", [
  playerWorldEventCopySchema.extend({
    decision: z.literal("realize"),
    status: z.literal("succeeded"),
  }).strict(),
  playerWorldEventCopySchema.extend({
    decision: z.literal("transform"),
    status: z.enum(["partial", "blocked", "interrupted"]),
    contradiction: z.object({
      kind: z.enum(["state", "world-rule", "causality", "capability", "spatial", "knowledge"]),
      summary: z.string().trim().min(1).max(1_000),
      basis: z.array(playerContradictionBasisSchema).min(1).max(16),
    }).strict(),
    replacement: playerActionCandidateSchema,
  }).strict(),
  runtimeContextRequestSchema,
]);
export type PlayerWorldResolution = z.infer<typeof playerWorldResolutionSchema>;

export type PlayerWorldAdjudicationContext = Readonly<{
  entities: Array<{
    id: EntityId;
    kind: z.infer<typeof entityKindSchema>;
    name: string;
    state: Readonly<Record<string, StateValue>>;
  }>;
  activeRules: Array<{
    name: string;
    scope: "global" | "entity" | "location" | "faction" | "institution";
    appliesWhen: Predicate[];
    requires: Predicate[];
    forbids: Predicate[];
  }>;
  scene: {
    label?: string;
    locationId?: EntityId;
    presentEntityIds: EntityId[];
  };
  deterministicIssues: ValidationIssue[];
}>;

export type PlayerWorldAdjudicationInput = Readonly<{
  utterance: string;
  candidate: PlayerActionCandidate;
  actorContext: PlayerActionTranslationContext;
  world: PlayerWorldAdjudicationContext;
  /** Presentation continuity only; currentWorld remains authoritative. */
  recentMessages: readonly ModelPlayConversationMessage[];
  /** Complete safe archive for adapter-owned read-only retrieval. */
  relatedMessages: readonly ModelPlayConversationMessage[];
  /** Host-admitted current-world facts from at most one frozen-source consultation. */
  contextSupplement?: RuntimeContextSupplement["adjudication"];
}>;

/** A world model may resolve an intent, but it still returns only a proposal. */
export type PlayerWorldAdjudicator = (
  input: PlayerWorldAdjudicationInput,
) => Promise<unknown> | unknown;

const actorScopedClaimSchema = claimSchema.omit({ evidence: true });
const actorScopedKnowledgeSchema = z
  .object({
    claimId: idSchema,
    status: knowledgeStatusSchema,
    confidence: z.number().min(0).max(1),
    sourceActorId: idSchema.optional(),
    claim: actorScopedClaimSchema.optional(),
  })
  .strict();

const actorScopedEntitySchema = z
  .object({
    id: idSchema,
    kind: entityKindSchema,
    name: z.string().min(1),
  })
  .strict();

/**
 * This is the complete host-side actor scope used to validate a translated
 * action. The isolated Pi adapter strips host-only fields and replaces stable
 * IDs with turn-local opaque handles before crossing the model boundary. It
 * contains no WorldState, frontier, canonical event list, character
 * goals/models, source evidence, or unacquired claims.
 */
export const actorScopedActionContextSchema = z
  .object({
    actorId: idSchema,
    atCommit: idSchema,
    selfState: z.record(z.string(), stateValueSchema),
    ownedEntityState: z.record(idSchema, z.record(z.string(), stateValueSchema)),
    knowledge: z.array(actorScopedKnowledgeSchema),
    presentEntities: z.array(actorScopedEntitySchema),
    referenceableEntities: z.array(actorScopedEntitySchema),
    writableEntityIds: z.array(idSchema),
    writableStateFields: z.array(stateFieldSpecSchema),
    spatialRelations: z.array(modelVisibleSpatialRelationSchema).default([]),
    scene: z.object({
      beat: z.number().int().nonnegative(),
      label: z.string().optional(),
      locationId: idSchema.optional(),
      locationState: z.record(z.string(), stateValueSchema),
      presentEntityIds: z.array(idSchema),
    }).strict(),
    recentVisibleEvents: z.array(z.object({
      summary: z.string().min(1),
      step: z.number().int().nonnegative(),
    }).strict()).max(8),
    activeThreads: z.array(z.object({
      kind: z.enum(["scene", "plan"]),
      summary: z.string().min(1),
    }).strict()).max(4),
  })
  .strict();
export type ActorScopedActionContext = z.infer<typeof actorScopedActionContextSchema>;

/**
 * The callback-facing view is smaller than the host validation scope. Stable
 * actor capabilities remain available, but replay/chronology identifiers do
 * not cross into an arbitrary translator implementation.
 */
export type PlayerActionTranslationContext = Omit<
  ActorScopedActionContext,
  "atCommit" | "scene" | "recentVisibleEvents"
> & {
  scene: Omit<ActorScopedActionContext["scene"], "beat">;
  recentVisibleEvents: Array<Pick<ActorScopedActionContext["recentVisibleEvents"][number], "summary">>;
};

export type PlayerActionTranslationInput = Readonly<{
  utterance: string;
  context: PlayerActionTranslationContext;
  /** Exact short-term presentation memory; never authoritative world truth. */
  recentMessages: readonly ModelPlayConversationMessage[];
  /** Complete branch/commit-scoped archive, exposed to model adapters only through read-only retrieval. */
  relatedMessages: readonly ModelPlayConversationMessage[];
  /** Host-admitted actor-visible facts from at most one frozen-source consultation. */
  contextSupplement?: RuntimeContextSupplement["translation"];
}>;

export type SafePlayerIntent = "observe" | "reflect" | "wait";

const SAFE_PLAYER_INTENT_TITLES: Record<SafePlayerIntent, string> = {
  observe: "观察当前场景",
  reflect: "整理已知线索",
  wait: "短暂等待并留意变化",
};

const SAFE_PLAYER_INTENT_ACTOR_OBSERVATIONS: Record<SafePlayerIntent, string> = {
  observe: "你把注意力放回当前场景，仔细观察眼前能够确认的事物。",
  reflect: "你暂时收拢思绪，重新整理自己已经知道的线索。",
  wait: "你暂时没有采取别的行动，只留意时间流逝和周围变化。",
};

/**
 * Convert an already-typed host affordance without asking a model to recover
 * semantics from its display text. Free-form input never uses this shortcut.
 */
export function deterministicPlayerIntentCandidate(
  intent: SafePlayerIntent,
  input: Pick<PlayerActionTranslationInput, "utterance" | "context">,
  requestedTimeAdvance?: TimeAdvance,
): PlayerActionCandidate {
  return playerActionCandidateSchema.parse({
    title: SAFE_PLAYER_INTENT_TITLES[intent],
    intent: {
      kind: intent,
      summary: SAFE_PLAYER_INTENT_TITLES[intent],
      controlledAct: {
        eventTitle: SAFE_PLAYER_INTENT_TITLES[intent],
        actorObservation: SAFE_PLAYER_INTENT_ACTOR_OBSERVATIONS[intent],
      },
      targets: [],
      ...(intent === "observe" ? { sceneTransition: { kind: "stay" } } : {}),
      ...(intent === "wait"
        ? { requestedTimeAdvance: requestedTimeAdvance ?? { amount: 5, unit: "minute" } }
        : {}),
    },
    participants: input.context.presentEntities
      .map((entity) => entity.id)
      .filter((entityId) => entityId !== input.context.actorId),
    preconditions: [],
    proposedDelta: { version: 1, operations: [] },
    requiresKnowledge: [],
    forbidsKnowledge: [],
  });
}

/** A translator may be model-backed, but its only world input is actor-scoped. */
export type PlayerActionTranslator = (
  input: PlayerActionTranslationInput,
) => Promise<unknown> | unknown;

export function playerActionTranslationContext(
  context: ActorScopedActionContext,
): PlayerActionTranslationContext {
  return {
    actorId: context.actorId,
    selfState: structuredClone(context.selfState),
    ownedEntityState: structuredClone(context.ownedEntityState),
    knowledge: structuredClone(context.knowledge),
    presentEntities: structuredClone(context.presentEntities),
    referenceableEntities: structuredClone(context.referenceableEntities),
    spatialRelations: structuredClone(context.spatialRelations),
    writableEntityIds: [...context.writableEntityIds],
    writableStateFields: structuredClone(context.writableStateFields),
    scene: {
      ...(context.scene.label ? { label: context.scene.label } : {}),
      ...(context.scene.locationId ? { locationId: context.scene.locationId } : {}),
      locationState: structuredClone(context.scene.locationState),
      presentEntityIds: [...context.scene.presentEntityIds],
    },
    recentVisibleEvents: context.recentVisibleEvents.map(({ summary }) => ({ summary })),
    activeThreads: structuredClone(context.activeThreads),
  };
}

export type PlayerActionModelBoundary = {
  context: Record<string, unknown>;
  encodeEntityId(entityId: string): string;
  encodeClaimId(claimId: string): string;
  encodeState(values: Readonly<Record<string, StateValue>>): Record<string, unknown>;
  encodePredicate(predicate: Predicate): Predicate;
  encodeCandidate(candidate: PlayerActionCandidate): PlayerActionCandidate;
  decodeEntityId(entityId: string): string;
  decodeClaimId(claimId: string): string;
  decodeCandidate(candidate: PlayerActionCandidate): PlayerActionCandidate;
};

export function playerActionModelContext(context: PlayerActionTranslationContext): Record<string, unknown> {
  return createPlayerActionModelBoundary(context).context;
}

/**
 * Replace every admitted stable entity/claim ID with a turn-local opaque
 * handle. Only the host retains the reverse map used after candidate capture.
 */
export function createPlayerActionModelBoundary(context: PlayerActionTranslationContext): PlayerActionModelBoundary {
  const entityIds = new Set([
    context.actorId,
    ...context.referenceableEntities.map((entity) => entity.id),
    ...context.presentEntities.map((entity) => entity.id),
    ...context.writableEntityIds,
    ...context.scene.presentEntityIds,
    ...(context.scene.locationId ? [context.scene.locationId] : []),
  ]);
  const entityHandles = new Map<string, string>([[context.actorId, "actor-self"]]);
  let entityOrdinal = 0;
  for (const id of [...entityIds].sort()) {
    if (entityHandles.has(id)) continue;
    entityOrdinal += 1;
    entityHandles.set(id, `entity-${String(entityOrdinal).padStart(3, "0")}`);
  }
  const claimHandles = new Map(
    [...new Set(context.knowledge.map((entry) => entry.claimId))].sort()
      .map((id, index) => [id, `claim-${String(index + 1).padStart(3, "0")}`] as const),
  );
  const reverseEntities = new Map<string, string>([...entityHandles].map(([id, handle]) => [handle, id]));
  const reverseClaims = new Map<string, string>([...claimHandles].map(([id, handle]) => [handle, id]));
  const writableFields = new Map(context.writableStateFields.map((field) => [field.key, field]));
  const entityHandle = (id: string): string => entityHandles.get(id) ?? id;
  const scopedEntityHandle = (id: string): string => entityHandles.get(id) ?? "entity-unavailable";
  const claimHandle = (id: string): string => claimHandles.get(id) ?? id;
  const scopedClaimHandle = (id: string): string => claimHandles.get(id) ?? "claim-unavailable";
  const mapEntityRefs = (value: unknown, depth = 0): unknown => {
    if (typeof value === "string") return entityHandle(value);
    if (depth >= 8) return "[nested data omitted]";
    if (Array.isArray(value)) return value.map((item) => mapEntityRefs(item, depth + 1));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, mapEntityRefs(item, depth + 1)]));
  };
  const mapState = (values: Readonly<Record<string, unknown>>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(values).map(([field, value]) => [field, mapEntityRefs(value)]));
  const encodePredicate = (predicate: Predicate): Predicate => {
    const encoded = structuredClone(predicate) as Record<string, unknown>;
    if ((encoded.op === "all" || encoded.op === "any") && Array.isArray(encoded.items)) {
      encoded.items = encoded.items.map((item) => encodePredicate(item as Predicate));
      return encoded as Predicate;
    }
    if (encoded.op === "not" && encoded.item && typeof encoded.item === "object") {
      encoded.item = encodePredicate(encoded.item as Predicate);
      return encoded as Predicate;
    }
    if (typeof encoded.entityId === "string") encoded.entityId = scopedEntityHandle(encoded.entityId);
    if (typeof encoded.member === "string") encoded.member = scopedEntityHandle(encoded.member);
    if (typeof encoded.ruleId === "string") encoded.ruleId = "rule-opaque";
    if (encoded.time && typeof encoded.time === "object" && !Array.isArray(encoded.time)) {
      const time = encoded.time as Record<string, unknown>;
      if (typeof time.anchorEventId === "string") time.anchorEventId = "event-opaque";
    }
    if ("value" in encoded) encoded.value = mapEntityRefs(encoded.value);
    return encoded as Predicate;
  };
  const encodeCandidate = (candidateInput: PlayerActionCandidate): PlayerActionCandidate => {
    const candidate = structuredClone(playerActionCandidateSchema.parse(candidateInput));
    candidate.participants = candidate.participants.map(scopedEntityHandle);
    candidate.preconditions = candidate.preconditions.map(encodePredicate);
    candidate.proposedDelta.operations = candidate.proposedDelta.operations.map((operation) => {
      const encoded = structuredClone(operation) as Record<string, unknown>;
      if (typeof encoded.entityId === "string") encoded.entityId = scopedEntityHandle(encoded.entityId);
      if (typeof encoded.member === "string") encoded.member = scopedEntityHandle(encoded.member);
      if ("value" in encoded) encoded.value = mapEntityRefs(encoded.value);
      return encoded as never;
    });
    if (candidate.proposedKnowledge) {
      candidate.proposedKnowledge.operations = candidate.proposedKnowledge.operations.map((operation) => ({
        ...operation,
        actorId: scopedEntityHandle(operation.actorId),
        claimId: scopedClaimHandle(operation.claimId),
        ...(operation.op === "learn" && operation.sourceActorId
          ? { sourceActorId: scopedEntityHandle(operation.sourceActorId) }
          : {}),
      }));
    }
    candidate.requiresKnowledge = candidate.requiresKnowledge.map(scopedClaimHandle);
    candidate.forbidsKnowledge = candidate.forbidsKnowledge.map(scopedClaimHandle);
    if (candidate.intent) {
      candidate.intent.targets = candidate.intent.targets.map((target) => target.kind === "entity"
        ? { ...target, entityId: scopedEntityHandle(target.entityId) }
        : target);
      const destination = candidate.intent.sceneTransition?.destination;
      if (destination?.kind === "entity") {
        candidate.intent.sceneTransition = {
          kind: candidate.intent.sceneTransition!.kind,
          destination: { ...destination, entityId: scopedEntityHandle(destination.entityId) },
          ...(candidate.intent.sceneTransition!.travelMode
            ? { travelMode: candidate.intent.sceneTransition!.travelMode }
            : {}),
        };
      }
      const interaction = candidate.intent.controlledAct?.interaction;
      if (interaction) {
        interaction.addresseeIds = interaction.addresseeIds.map(scopedEntityHandle);
      }
    }
    return playerActionCandidateSchema.parse(candidate);
  };
  const modelContext: Record<string, unknown> = {
    actorId: entityHandle(context.actorId),
    selfState: mapState(context.selfState),
    ownedEntityState: Object.fromEntries(Object.entries(context.ownedEntityState)
      .map(([entityId, values]) => [entityHandle(entityId), mapState(values)])),
    knowledge: context.knowledge.map((entry) => ({
      claimId: claimHandle(entry.claimId),
      status: entry.status,
      confidence: entry.confidence,
      ...(entry.sourceActorId ? { sourceActorId: entityHandle(entry.sourceActorId) } : {}),
      ...(entry.claim ? {
        claim: {
          ...structuredClone(entry.claim),
          id: claimHandle(entry.claim.id),
          subject: entityHandle(entry.claim.subject),
          object: mapEntityRefs(entry.claim.object),
          ...(entry.claim.speaker ? { speaker: entityHandle(entry.claim.speaker) } : {}),
        },
      } : {}),
    })),
    presentEntities: context.presentEntities.map((entity) => ({ ...entity, id: entityHandle(entity.id) })),
    referenceableEntities: context.referenceableEntities.map((entity) => ({ ...entity, id: entityHandle(entity.id) })),
    spatialRelations: (context.spatialRelations ?? []).map((relation) => {
      if (relation.kind === "contains") return {
        ...relation,
        containerLocationId: entityHandle(relation.containerLocationId),
        containedLocationId: entityHandle(relation.containedLocationId),
      };
      if (relation.kind === "adjacent") return {
        ...relation,
        locationIds: relation.locationIds.map(entityHandle),
      };
      return {
        ...relation,
        fromLocationId: entityHandle(relation.fromLocationId),
        toLocationId: entityHandle(relation.toLocationId),
      };
    }),
    writableEntityIds: context.writableEntityIds.map(entityHandle),
    writableStateFields: structuredClone(context.writableStateFields),
    scene: {
      ...(context.scene.label ? { label: context.scene.label } : {}),
      ...(context.scene.locationId ? { locationId: entityHandle(context.scene.locationId) } : {}),
      locationState: mapState(context.scene.locationState),
      presentEntityIds: context.scene.presentEntityIds.map(entityHandle),
    },
    recentVisibleEvents: context.recentVisibleEvents.map((event) => ({ summary: event.summary })),
    activeThreads: structuredClone(context.activeThreads),
  };
  // Described targets remain ordinary text data. A model must not bypass the
  // handle boundary by guessing an admitted stable ID, so unknown ID-shaped
  // references are decoded to a value the deterministic scope gate rejects.
  let invalidEntityHandle = "invalid-model-entity-handle";
  while (entityIds.has(invalidEntityHandle)) invalidEntityHandle += "-x";
  const knownClaimIds = new Set(claimHandles.keys());
  let invalidClaimHandle = "invalid-model-claim-handle";
  while (knownClaimIds.has(invalidClaimHandle)) invalidClaimHandle += "-x";
  const decodeEntity = (value: string): string =>
    reverseEntities.get(value) ?? (entityHandles.has(value) ? invalidEntityHandle : value);
  const decodeClaim = (value: string): string =>
    reverseClaims.get(value) ?? (claimHandles.has(value) ? invalidClaimHandle : value);
  const decodeStateValue = (field: string, value: unknown): unknown => {
    const valueType = writableFields.get(field)?.valueType;
    if (valueType === "entity-ref" && typeof value === "string") return decodeEntity(value);
    if (valueType === "entity-ref-set" && Array.isArray(value)) {
      return value.map((item) => typeof item === "string" ? decodeEntity(item) : item);
    }
    return value;
  };
  const decodePredicate = (predicate: Record<string, unknown>): Record<string, unknown> => {
    const decoded = structuredClone(predicate);
    if ((decoded.op === "all" || decoded.op === "any") && Array.isArray(decoded.items)) {
      decoded.items = decoded.items.map((item) => decodePredicate(item as Record<string, unknown>));
      return decoded;
    }
    if (decoded.op === "not" && decoded.item && typeof decoded.item === "object") {
      decoded.item = decodePredicate(decoded.item as Record<string, unknown>);
      return decoded;
    }
    if (typeof decoded.entityId === "string") decoded.entityId = decodeEntity(decoded.entityId);
    if (typeof decoded.member === "string") decoded.member = decodeEntity(decoded.member);
    if (typeof decoded.field === "string" && "value" in decoded) {
      decoded.value = decodeStateValue(decoded.field, decoded.value);
    }
    return decoded;
  };
  return {
    context: modelContext,
    encodeEntityId: scopedEntityHandle,
    encodeClaimId: scopedClaimHandle,
    encodeState: (values) => mapState(values),
    encodePredicate,
    encodeCandidate,
    decodeEntityId: decodeEntity,
    decodeClaimId: decodeClaim,
    decodeCandidate(candidateInput) {
      const candidate = structuredClone(candidateInput) as PlayerActionCandidate;
      candidate.participants = candidate.participants.map(decodeEntity);
      candidate.preconditions = candidate.preconditions
        .map((predicate) => decodePredicate(predicate as unknown as Record<string, unknown>) as never);
      candidate.proposedDelta.operations = candidate.proposedDelta.operations.map((operation) => {
        const decoded = structuredClone(operation) as Record<string, unknown>;
        if (typeof decoded.entityId === "string") decoded.entityId = decodeEntity(decoded.entityId);
        if (typeof decoded.member === "string") decoded.member = decodeEntity(decoded.member);
        if (typeof decoded.field === "string" && "value" in decoded) {
          decoded.value = decodeStateValue(decoded.field, decoded.value);
        }
        return decoded as never;
      });
      if (candidate.proposedKnowledge) {
        candidate.proposedKnowledge.operations = candidate.proposedKnowledge.operations.map((operation) => ({
          ...operation,
          actorId: decodeEntity(operation.actorId),
          claimId: decodeClaim(operation.claimId),
          ...(operation.op === "learn" && operation.sourceActorId
            ? { sourceActorId: decodeEntity(operation.sourceActorId) }
            : {}),
        }));
      }
      candidate.requiresKnowledge = candidate.requiresKnowledge.map(decodeClaim);
      candidate.forbidsKnowledge = candidate.forbidsKnowledge.map(decodeClaim);
      if (candidate.intent) {
        candidate.intent.targets = candidate.intent.targets.map((target) => target.kind === "entity"
          ? { ...target, entityId: decodeEntity(target.entityId) }
          : target);
        const destination = candidate.intent.sceneTransition?.destination;
        if (destination?.kind === "entity") {
          candidate.intent.sceneTransition = {
            kind: candidate.intent.sceneTransition!.kind,
            destination: { ...destination, entityId: decodeEntity(destination.entityId) },
            ...(candidate.intent.sceneTransition!.travelMode
              ? { travelMode: candidate.intent.sceneTransition!.travelMode }
              : {}),
          };
        }
        const interaction = candidate.intent.controlledAct?.interaction;
        if (interaction) {
          interaction.addresseeIds = interaction.addresseeIds.map(decodeEntity);
        }
      }
      return playerActionCandidateSchema.parse(candidate);
    },
  };
}

export const playerTurnInputSchema = z
  .object({
    branchId: idSchema,
    sourceId: idSchema.optional(),
    conversationId: idSchema.optional(),
    actorId: idSchema,
    utterance: z.string().trim().min(1).max(20_000),
  })
  .strict();
export type PlayerTurnInput = z.infer<typeof playerTurnInputSchema>;

export type PlayerTurnStage = "translation" | "scope" | "adjudication" | "knowledge" | "engine" | "committed";

export type PlayerTurnResult = {
  accepted: boolean;
  stage: PlayerTurnStage;
  branchId: string;
  actorId: string;
  previousHead: CommitId;
  newHead: CommitId;
  issues: ValidationIssue[];
  contextBefore: ActorScopedActionContext;
  contextAfter: ActorScopedActionContext;
  renderedText: string;
  intendedCandidate?: PlayerActionCandidate;
  candidate?: PlayerActionCandidate;
  adjudication?: PlayerWorldResolution;
  proposal?: EventProposal;
  validation?: ValidationReport;
  eventHash?: string;
  progressCertificate?: PlayerProgressCertificate;
  /** Safe audit records; exact source text remains in trace/tool blobs. */
  contextConsultations?: RuntimeContextConsultationRecord[];
  /** Transient, authority-labelled projections for downstream runtime consumers. */
  contextSupplement?: RuntimeContextSupplement;
  /** Non-authoritative compiler feedback persisted outside branch truth. */
  repairHints?: RuntimeCompilerRepairHint[];
};

type PlayerTurnContextState = {
  consultations: RuntimeContextConsultationRecord[];
  supplement?: RuntimeContextSupplement;
  repairHints: RuntimeCompilerRepairHint[];
};

export type PlayerProgressCertificate = {
  channels: ProgressChannel[];
  threadIds: string[];
  noveltyKey: string;
  effectiveStateOperations: number;
  knowledgeOperations: number;
  sceneChanged: boolean;
  timeAdvanced: boolean;
  materiallyAdvanced: boolean;
};

export type PlayerTurnAuthority = Readonly<{
  intent?: "act" | SafePlayerIntent;
  affordanceId?: string;
  progress?: NarrativeProgress;
  authorizedKnowledgeClaimIds?: readonly string[];
}>;

export type PlayerTurnRender = (input: Readonly<{
  branchId: string;
  commitId: CommitId;
  actorId: EntityId;
  sourceId?: string;
}>) => Promise<string> | string;

export type PlayerCanonResolver = (proposal: EventProposal) => Promise<CanonicalChoiceResolution> | CanonicalChoiceResolution;

const canonicalChoiceResolutionSchema = z.object({
  realizedPossibilityId: idSchema.optional(),
  supersedesCanonicalEventIds: z.array(idSchema).max(100),
  threadIds: z.array(idSchema).max(100).optional(),
  causalParentEventIds: z.array(idSchema).max(100).optional(),
}).strict();

/**
 * Derive the host-side actor scope from committed actor knowledge at one commit.
 * The isolated Pi adapter additionally replaces stable IDs with turn-local
 * opaque handles before this value crosses the model boundary.
 * Canonical context is used only to resolve names and field types for IDs that
 * are reachable from self state or acquired knowledge. Current WorldState
 * contributes only the ownership fact needed to prove
 * which artifacts the actor may control; no other entity state is exposed.
 */
export async function buildActorScopedActionContext(
  engine: WorldEngine,
  actorId: EntityId,
  commitId: CommitId,
  _utterance?: string,
  sourceId?: string,
): Promise<ActorScopedActionContext> {
  const context = await engine.contextForCommit(commitId);
  const actorEntity = context.entities.get(actorId);
  const effectiveSourceId = await resolveCommitSourceId(
    engine,
    context,
    commitId,
    sourceId,
    "Actor context",
  );
  if (!actorEntity || actorEntity.kind !== "character"
    || !evidenceBelongsExclusivelyToSource(actorEntity.evidence, effectiveSourceId)) {
    throw new Error(`Actor ${actorId} is not a source-owned character in ${effectiveSourceId ?? "the committed world context"}.`);
  }
  const [view, worldState, scene, history] = await Promise.all([
    new KnowledgeProjector(engine).view(actorId, commitId),
    engine.projector.project(commitId),
    projectActorScene(engine, actorId, commitId, effectiveSourceId),
    committedHistory(engine, commitId),
  ]);
  const referenceable = new Set<EntityId>([actorId]);
  const knownIdentities = new Set<EntityId>([actorId]);
  const present = new Set<EntityId>([actorId]);
  const writable = new Set<EntityId>([actorId]);
  const ownedEntityState: Record<EntityId, Record<string, StateValue>> = {};
  const visibleKnowledge = effectiveSourceId
    ? view.knowledge.filter((entry) => entry.claim
      && evidenceBelongsExclusivelyToSource(entry.claim.evidence, effectiveSourceId)
      && entityIdBelongsToSource(entry.claim.subject, context.entities, effectiveSourceId)
      && (!entry.claim.speaker || entityIdBelongsToSource(entry.claim.speaker, context.entities, effectiveSourceId))
      && claimObjectBelongsToSource(entry.claim.object, context.entities, effectiveSourceId))
    : view.knowledge;
  const selfState = sourceSafeVisibleState(view.selfState, context.stateSchema, context.entities, effectiveSourceId);
  const sceneLocationState = sourceSafeVisibleState(scene.locationState, context.stateSchema, context.entities, effectiveSourceId);

  for (const participant of scene.presentEntityIds) {
    const entity = context.entities.get(participant);
    if (!entity || !evidenceBelongsExclusivelyToSource(entity.evidence, effectiveSourceId)) continue;
    present.add(participant);
    referenceable.add(participant);
  }

  addStateEntityReferences(referenceable, selfState, context.stateSchema, context.entities, effectiveSourceId, knownIdentities);
  addStateEntityReferences(referenceable, sceneLocationState, context.stateSchema, context.entities, effectiveSourceId, knownIdentities);

  for (const entry of visibleKnowledge) {
    if (entry.fact.sourceActorId) addExistingEntity(referenceable, entry.fact.sourceActorId, context.entities, effectiveSourceId, knownIdentities);
    if (!entry.claim) continue;
    addExistingEntity(referenceable, entry.claim.subject, context.entities, effectiveSourceId, knownIdentities);
    if (entry.claim.speaker) addExistingEntity(referenceable, entry.claim.speaker, context.entities, effectiveSourceId, knownIdentities);
    addClaimObjectEntities(
      referenceable,
      sourceSafeClaimObject(entry.claim.object, context.entities, effectiveSourceId),
      context.entities,
      effectiveSourceId,
      knownIdentities,
    );
  }

  for (const entity of context.entities.values()) {
    if (!evidenceBelongsExclusivelyToSource(entity.evidence, effectiveSourceId)) continue;
    if (entity.kind === "artifact" && worldState.values[entity.id]?.["artifact.owner"] === actorId) {
      referenceable.add(entity.id);
      knownIdentities.add(entity.id);
      writable.add(entity.id);
      const projected = sourceSafeVisibleState(projectActorVisibleState(
        worldState.values[entity.id] ?? {}, context.stateSchema, "owner"),
      context.stateSchema, context.entities, effectiveSourceId);
      ownedEntityState[entity.id] = projected;
      addStateEntityReferences(referenceable, projected, context.stateSchema, context.entities, effectiveSourceId, knownIdentities);
      continue;
    }
    if (entity.kind === "relationship") {
      // A relationship involving the actor can itself be secret. Its endpoint
      // in world truth is not enough to reveal it; the actor must already have
      // a reference through visible self state or acquired knowledge.
      if (!referenceable.has(entity.id)) continue;
      const relationshipState = worldState.values[entity.id];
      const from = relationshipState?.["relationship.from"];
      const to = relationshipState?.["relationship.to"];
      if (from !== actorId && to !== actorId) continue;
      referenceable.add(entity.id);
      writable.add(entity.id);
      const projected = sourceSafeVisibleState(projectActorVisibleState(
        relationshipState ?? {}, context.stateSchema, "owner"),
      context.stateSchema, context.entities, effectiveSourceId);
      ownedEntityState[entity.id] = projected;
      addStateEntityReferences(referenceable, projected, context.stateSchema, context.entities, effectiveSourceId, knownIdentities);
      if (typeof from === "string") addExistingEntity(referenceable, from, context.entities, effectiveSourceId, knownIdentities);
      if (typeof to === "string") addExistingEntity(referenceable, to, context.entities, effectiveSourceId, knownIdentities);
    }
  }

  const anonymousCounts = new Map<Entity["kind"], number>();
  const referenceableEntities = [...referenceable]
    .map((id) => context.entities.get(id))
    .filter((entity): entity is NonNullable<typeof entity> => Boolean(entity))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((entity) => {
      if (knownIdentities.has(entity.id)) return { id: entity.id, kind: entity.kind, name: entity.canonicalName };
      const ordinal = (anonymousCounts.get(entity.kind) ?? 0) + 1;
      anonymousCounts.set(entity.kind, ordinal);
      return { id: entity.id, kind: entity.kind, name: `Unidentified ${entity.kind} ${ordinal}` };
    });
  const presentEntities = referenceableEntities.filter((entity) => present.has(entity.id));
  const knownClaimIds = new Set(visibleKnowledge
    .filter((entry) => isActionableKnowledge(entry.fact))
    .map((entry) => entry.fact.claimId));
  const realizedCanonicalEventIds = new Set(history.flatMap((entry) => entry.event.realizesCanonicalEventIds ?? []));
  const spatialRelations = modelVisibleSpatialRelations(
    resolveActiveSpatialRelations(context.spatialRelations ?? [], {
      state: worldState,
      realizedCanonicalEventIds,
    }),
    {
      visibleEntityIds: new Set(referenceableEntities.map((entity) => entity.id)),
      knownClaimIds,
      ...(scene.locationId ? { currentLocationId: scene.locationId } : {}),
    },
  );
  const writableKinds = new Set(
    [...writable]
      .map((id) => context.entities.get(id)?.kind)
      .filter((kind): kind is NonNullable<typeof kind> => Boolean(kind)),
  );
  const writableStateFields = context.stateSchema
    .list()
    .filter((spec) => spec.appliesTo.some((kind) => writableKinds.has(kind)))
    // Visibility and mutation authority are distinct, but an engine-only,
    // knowledge-gated, or undeclared field must never become a model write
    // capability merely because its entity kind is writable.
    .filter((spec) => spec.visibility !== undefined
      && spec.visibility !== "engine"
      && spec.visibility !== "knowledge");
  const knowledge = visibleKnowledge.map((entry) => ({
    claimId: entry.fact.claimId,
    status: entry.fact.status,
    confidence: entry.fact.confidence,
    ...(entry.fact.sourceActorId
      && entityIdBelongsToSource(entry.fact.sourceActorId, context.entities, effectiveSourceId)
      ? { sourceActorId: entry.fact.sourceActorId }
      : {}),
    ...(entry.claim
      ? {
          claim: {
            id: entry.claim.id,
            subject: entry.claim.subject,
            predicate: entry.claim.predicate,
            object: sourceSafeClaimObject(entry.claim.object, context.entities, effectiveSourceId),
            epistemicType: entry.claim.epistemicType,
            ...(entry.claim.speaker ? { speaker: entry.claim.speaker } : {}),
          },
        }
      : {}),
  }));
  const recentVisibleEvents = scene.recentEvents.map((event) => ({
    summary: event.title,
    step: event.step,
  }));
  const activeThreads: Array<{ kind: "scene" | "plan"; summary: string }> = scene.recentEvents
    .slice(-3)
    .map((event) => ({ kind: "scene" as const, summary: event.title }));
  const plan = view.selfState["character.plan"];
  if (typeof plan === "string" && plan.trim()) activeThreads.push({ kind: "plan", summary: plan.trim() });
  return actorScopedActionContextSchema.parse({
    actorId,
    atCommit: commitId,
    selfState: structuredClone(selfState),
    ownedEntityState,
    knowledge,
    presentEntities,
    referenceableEntities,
    writableEntityIds: [actorId, ...[...writable].filter((id) => id !== actorId).sort()],
    writableStateFields,
    spatialRelations,
    scene: {
      beat: scene.beat,
      ...(scene.label ? { label: scene.label } : {}),
      ...(scene.locationId ? { locationId: scene.locationId } : {}),
      locationState: structuredClone(sceneLocationState),
      presentEntityIds: [...scene.presentEntityIds],
    },
    recentVisibleEvents,
    activeThreads: activeThreads.slice(-4),
  });
}

/**
 * Fail-closed capability validation for a model candidate. Phase-one player
 * actions may write only the selected character and artifacts currently owned
 * by that character. They may reference only IDs already present in the
 * actor-scoped context and may not alter world rules.
 */
export function validatePlayerActionScope(
  candidateInput: PlayerActionCandidate,
  actorContextInput: ActorScopedActionContext,
  authorizedKnowledgeClaimIds: ReadonlySet<string> = new Set(),
): ValidationIssue[] {
  const candidate = playerActionCandidateSchema.parse(candidateInput);
  const actorContext = actorScopedActionContextSchema.parse(actorContextInput);
  const issues: ValidationIssue[] = [];
  const referenceable = new Set(actorContext.referenceableEntities.map((entity) => entity.id));
  const writable = new Set(actorContext.writableEntityIds);
  const visibleClaims = new Set(actorContext.knowledge.map((entry) => entry.claimId));
  const fieldSpecs = new Map(actorContext.writableStateFields.map((spec) => [spec.key, spec]));
  const entityKinds = new Map(actorContext.referenceableEntities.map((entity) => [entity.id, entity.kind]));

  for (let index = 0; index < candidate.participants.length; index += 1) {
    requireReferenceable(candidate.participants[index]!, `participants.${index}`, referenceable, issues);
  }
  for (let index = 0; index < (candidate.intent?.targets.length ?? 0); index += 1) {
    const target = candidate.intent!.targets[index]!;
    if (target.kind === "entity") {
      requireReferenceable(target.entityId, `intent.targets.${index}.entityId`, referenceable, issues);
    }
  }
  const interaction = candidate.intent?.controlledAct?.interaction;
  for (let index = 0; index < (interaction?.addresseeIds.length ?? 0); index += 1) {
    const addresseeId = interaction!.addresseeIds[index]!;
    requireReferenceable(addresseeId, `intent.controlledAct.interaction.addresseeIds.${index}`, referenceable, issues);
    const addresseeKind = entityKinds.get(addresseeId);
    if (addresseeKind && addresseeKind !== "character") {
      issues.push(issue(
        "PLAYER_INTERACTION_ADDRESSEE_NOT_CHARACTER",
        `Interaction addressee ${addresseeId} is ${addresseeKind}, not a character`,
        `intent.controlledAct.interaction.addresseeIds.${index}`,
      ));
    }
    if (!candidate.participants.includes(addresseeId)) {
      issues.push(issue(
        "PLAYER_INTERACTION_ADDRESSEE_NOT_PARTICIPANT",
        `Interaction addressee ${addresseeId} must be a participant in the controlled act`,
        `intent.controlledAct.interaction.addresseeIds.${index}`,
      ));
    }
  }
  const sceneDestination = candidate.intent?.sceneTransition?.destination;
  if (sceneDestination?.kind === "entity") {
    requireReferenceable(sceneDestination.entityId, "intent.sceneTransition.destination.entityId", referenceable, issues);
    const destinationKind = entityKinds.get(sceneDestination.entityId);
    if (destinationKind && destinationKind !== "location") {
      issues.push(issue(
        "PLAYER_SCENE_DESTINATION_INVALID",
        `Scene destination ${sceneDestination.entityId} is ${destinationKind}, not a location`,
        "intent.sceneTransition.destination.entityId",
      ));
    }
  }
  for (let index = 0; index < candidate.preconditions.length; index += 1) {
    validatePredicateScope(candidate.preconditions[index]!, `preconditions.${index}`, writable, referenceable, fieldSpecs, entityKinds, issues);
  }
  for (let index = 0; index < candidate.proposedDelta.operations.length; index += 1) {
    const operation = candidate.proposedDelta.operations[index]!;
    const operationPath = `proposedDelta.operations.${index}`;
    if (operation.op === "activate-rule" || operation.op === "deactivate-rule") {
      issues.push(issue("PLAYER_RULE_MUTATION_FORBIDDEN", "Player action translation cannot activate or deactivate world rules", operationPath));
      continue;
    }
    if (!writable.has(operation.entityId)) {
      issues.push(issue("PLAYER_WRITE_OUT_OF_SCOPE", `Player action cannot write entity ${operation.entityId}`, `${operationPath}.entityId`));
    }
    const spec = fieldSpecs.get(operation.field);
    if (!spec) {
      issues.push(issue("PLAYER_FIELD_OUT_OF_SCOPE", `Player action cannot write field ${operation.field}`, `${operationPath}.field`));
      continue;
    }
    const entityKind = entityKinds.get(operation.entityId);
    if (!entityKind || !spec.appliesTo.includes(entityKind)) {
      issues.push(issue("PLAYER_FIELD_OUT_OF_SCOPE", `Field ${operation.field} does not apply to ${operation.entityId}`, `${operationPath}.field`));
      continue;
    }
    if (operation.op === "set") validateStateValueReferences(operation.value, spec, `${operationPath}.value`, referenceable, issues);
    if (operation.field === "character.relationships") {
      const addedReferences = operation.op === "set" && Array.isArray(operation.value)
        ? operation.value
        : operation.op === "add-member"
          ? [operation.member]
          : [];
      for (let memberIndex = 0; memberIndex < addedReferences.length; memberIndex += 1) {
        const member = addedReferences[memberIndex];
        if (typeof member !== "string" || !entityKinds.has(member) || entityKinds.get(member) === "relationship") continue;
        issues.push(issue(
          "PLAYER_RELATIONSHIP_REFERENCE_INVALID",
          `character.relationships may reference relationship entities only; ${member} is ${entityKinds.get(member)}`,
          operation.op === "set" ? `${operationPath}.value.${memberIndex}` : `${operationPath}.member`,
        ));
      }
    }
    if (operation.op === "adjust-number" && spec.valueType !== "number") {
      issues.push(issue("PLAYER_FIELD_OUT_OF_SCOPE", `adjust-number requires a numeric field, not ${operation.field}`, `${operationPath}.field`));
    }
    if (operation.op === "add-member" || operation.op === "remove-member") {
      requireReferenceable(operation.member, `${operationPath}.member`, referenceable, issues);
    }
  }

  for (let index = 0; index < (candidate.proposedKnowledge?.operations.length ?? 0); index += 1) {
    const operation = candidate.proposedKnowledge!.operations[index]!;
    const operationPath = `proposedKnowledge.operations.${index}`;
    if (operation.actorId !== actorContext.actorId) {
      issues.push(issue("PLAYER_KNOWLEDGE_ACTOR_OUT_OF_SCOPE", `Player action cannot mutate knowledge for ${operation.actorId}`, `${operationPath}.actorId`));
    }
    if (!visibleClaims.has(operation.claimId) && !authorizedKnowledgeClaimIds.has(operation.claimId)) {
      issues.push(issue("PLAYER_KNOWLEDGE_CLAIM_OUT_OF_SCOPE", `Claim ${operation.claimId} is not in the actor view`, `${operationPath}.claimId`));
    }
    if (operation.op === "learn" && operation.sourceActorId) {
      requireReferenceable(operation.sourceActorId, `${operationPath}.sourceActorId`, referenceable, issues);
    }
  }

  for (const [field, values] of [
    ["requiresKnowledge", candidate.requiresKnowledge],
    ["forbidsKnowledge", candidate.forbidsKnowledge],
  ] as const) {
    values.forEach((claimId, index) => {
      if (!visibleClaims.has(claimId)) {
        issues.push(issue("PLAYER_KNOWLEDGE_CLAIM_OUT_OF_SCOPE", `Claim ${claimId} is not in the actor view`, `${field}.${index}`));
      }
    });
  }
  return issues;
}

/**
 * A model may condition an action only on actor-visible values that actually
 * exist in the sparse committed projection. Missing fields are unknown, not a
 * license to invent a positive precondition. Known-false preconditions are
 * rejected before the engine so the UI can explain/recover from the proposal
 * without presenting a generic commit failure.
 */
export function validatePlayerActionGrounding(
  candidateInput: PlayerActionCandidate,
  actorContextInput: ActorScopedActionContext,
): ValidationIssue[] {
  const candidate = playerActionCandidateSchema.parse(candidateInput);
  const actorContext = actorScopedActionContextSchema.parse(actorContextInput);
  const values = new Map<string, Readonly<Record<string, StateValue>>>([
    [actorContext.actorId, actorContext.selfState],
    ...Object.entries(actorContext.ownedEntityState),
  ]);
  const issues: ValidationIssue[] = [];
  candidate.preconditions.forEach((predicate, index) => {
    const evaluated = evaluateVisiblePredicate(predicate, values);
    if (!evaluated.known) {
      issues.push(issue(
        "PLAYER_PRECONDITION_UNGROUNDED",
        "Player action precondition depends on a field that is absent from the actor-visible committed state",
        `preconditions.${index}`,
      ));
    } else if (!evaluated.value) {
      issues.push(issue(
        "PLAYER_PRECONDITION_UNSATISFIED",
        "Player action precondition is false in the actor-visible committed state",
        `preconditions.${index}`,
      ));
    }
  });
  return issues;
}

/** Keep typed scene semantics and committed location state in one event model. */
function validatePlayerIntentConsistency(
  candidate: PlayerActionCandidate,
  actorId: EntityId,
): ValidationIssue[] {
  const transition = candidate.intent?.sceneTransition;
  if (transition?.kind !== "arrive" || transition.destination?.kind !== "entity") return [];
  const destinationEntityId = transition.destination.entityId;
  const writesDestination = candidate.proposedDelta.operations.some((operation) =>
    operation.op === "set"
    && operation.entityId === actorId
    && operation.field === "character.location"
    && operation.value === destinationEntityId);
  return writesDestination ? [] : [issue(
    "PLAYER_ARRIVAL_REQUIRES_LOCATION_WRITE",
    "A compiled-location arrival must propose the matching character.location state transition.",
    "intent.sceneTransition",
  )];
}

/**
 * Host-only physical interaction gate. Naming an entity makes its identity
 * referenceable, but never proves that a distant character is present. The
 * full projected state is consulted only after model translation and is not
 * returned to the model.
 */
export async function validatePlayerActionSpatialScope(
  engine: WorldEngine,
  candidateInput: PlayerActionCandidate,
  actorId: EntityId,
  commitId: CommitId,
  sourceId?: string,
): Promise<ValidationIssue[]> {
  const candidate = playerActionCandidateSchema.parse(candidateInput);
  const [context, state] = await Promise.all([
    engine.contextForCommit(commitId),
    engine.projector.project(commitId),
  ]);
  const interactionCharacters = new Set<EntityId>();
  for (const participant of candidate.participants) {
    if (participant !== actorId && context.entities.get(participant)?.kind === "character") interactionCharacters.add(participant);
  }
  for (const operation of candidate.proposedDelta.operations) {
    if (
      operation.op === "set"
      && operation.field === "artifact.owner"
      && typeof operation.value === "string"
      && operation.value !== actorId
      && context.entities.get(operation.value)?.kind === "character"
    ) {
      interactionCharacters.add(operation.value);
    }
  }
  for (const operation of candidate.proposedKnowledge?.operations ?? []) {
    if (operation.op === "learn" && operation.sourceActorId && operation.sourceActorId !== actorId
      && context.entities.get(operation.sourceActorId)?.kind === "character") {
      interactionCharacters.add(operation.sourceActorId);
    }
  }
  const actorLocation = state.values[actorId]?.["character.location"];
  const [scene, history] = await Promise.all([
    projectActorScene(engine, actorId, commitId, sourceId),
    committedHistory(engine, commitId),
  ]);
  const present = new Set(scene.presentEntityIds);
  const issues: ValidationIssue[] = [];
  const activeRelations = context.spatialOntologyVersion === "spatial-v1"
    ? resolveActiveSpatialRelations(context.spatialRelations ?? [], {
        state,
        realizedCanonicalEventIds: new Set(history.flatMap((entry) => entry.event.realizesCanonicalEventIds ?? [])),
      })
    : [];
  const destination = candidate.intent?.sceneTransition?.kind === "arrive"
    && candidate.intent.sceneTransition.destination?.kind === "entity"
    ? candidate.intent.sceneTransition.destination.entityId
    : undefined;
  if (destination && context.spatialOntologyVersion === "spatial-v1" && destination !== actorLocation) {
    if (typeof actorLocation !== "string") {
      issues.push(issue(
        "PLAYER_SPATIAL_ORIGIN_UNKNOWN",
        "Compiled-location travel requires a committed current location in a spatial-v1 world.",
        "intent.sceneTransition.destination.entityId",
      ));
    } else {
      const travelMode = candidate.intent?.sceneTransition?.travelMode;
      if (!travelMode) {
        issues.push(issue(
          "PLAYER_SPATIAL_MODE_REQUIRED",
          "Compiled-location travel in a spatial-v1 world requires an explicit travel mode.",
          "intent.sceneTransition.travelMode",
        ));
      }
      const path = travelMode ? findSpatialRoute(activeRelations, actorLocation, destination, travelMode) : undefined;
      if (travelMode && !path) {
        issues.push(issue(
          "PLAYER_SPATIAL_ROUTE_UNPROVEN",
          `No active spatial-v1 ${travelMode} route proves travel from ${actorLocation} to ${destination}; adjacency alone is insufficient.`,
          "intent.sceneTransition.destination.entityId",
        ));
      } else if (path && path.minimumDurationDays !== undefined && path.minimumDurationDays > 0
        && timeAdvanceInDays(candidate.intent?.requestedTimeAdvance) + Number.EPSILON < path.minimumDurationDays) {
        issues.push(issue(
          "PLAYER_SPATIAL_TRAVEL_TOO_FAST",
          `The proposed travel advances less time than the active route's ${path.minimumDurationDays}-day deterministic minimum.`,
          "intent.requestedTimeAdvance",
        ));
      }
    }
  }
  for (const characterId of [...interactionCharacters].sort()) {
    const characterLocation = state.values[characterId]?.["character.location"];
    if (typeof actorLocation === "string" && typeof characterLocation === "string"
      && !spatialLocationsMayOverlap(activeRelations, actorLocation, characterLocation)) {
      issues.push(issue(
        "PLAYER_REMOTE_INTERACTION_FORBIDDEN",
        `Player action cannot physically interact with ${characterId} because committed locations prove that character is elsewhere`,
        "participants",
      ));
    } else if (
      (typeof actorLocation !== "string" || typeof characterLocation !== "string")
      && !present.has(characterId)
    ) {
      issues.push(issue(
        "PLAYER_SPATIAL_CONTEXT_UNKNOWN",
        `Player action cannot yet prove that ${characterId} is present; no contradictory remote location was inferred`,
        "participants",
      ));
    }
  }
  return issues;
}

/** Construct the only EventProposal that may cross the world-engine boundary. */
export function playerActionToKnowledgeAwareAction(input: {
  branchId: string;
  actorId: EntityId;
  expectedParentCommit: CommitId;
  utterance: string;
  candidate: PlayerActionCandidate;
  proposedTime?: StoryTime;
  timeAdvance?: TimeAdvance;
  eventTitle?: string;
  actorObservation?: string;
}): KnowledgeAwareAction {
  const candidate = playerActionCandidateSchema.parse(input.candidate);
  const proposalId = `player-${contentHash({
    branchId: input.branchId,
    actorId: input.actorId,
    expectedParentCommit: input.expectedParentCommit,
    utterance: input.utterance,
    candidate,
  }).slice(0, 24)}`;
  const actorObservations = [{
    actorId: input.actorId,
    summary: input.actorObservation ?? playerIntentObservation(input.utterance),
  }];
  const interaction = candidate.intent?.controlledAct?.interaction;
  const physicalParticipantIds = [...new Set([
    input.actorId,
    ...(interaction?.addresseeIds ?? []),
  ])].sort();
  for (const addresseeId of [...new Set(interaction?.addresseeIds ?? [])].sort()) {
    if (addresseeId === input.actorId) continue;
    const perceived = interaction?.kind === "speech"
      ? `面前的人对你说：“${interaction.content}”`
      : interaction?.kind === "gesture"
        ? `面前的人向你做出动作：${interaction.description}`
        : interaction?.kind === "physical"
          ? `面前的人与你发生直接互动：${interaction.description}`
          : undefined;
    if (perceived) actorObservations.push({ actorId: addresseeId, summary: boundedObservation(perceived) });
  }
  const proposal = eventProposalSchema.parse({
    proposalId,
    branchId: input.branchId,
    expectedParentCommit: input.expectedParentCommit,
    source: "player",
    actorId: input.actorId,
    title: input.eventTitle ?? playerIntentTitle(input.utterance),
    actorObservations,
    ...(interaction?.kind === "speech"
      ? {
          spokenUtterances: [{
            speakerId: input.actorId,
            addresseeIds: [...new Set(interaction.addresseeIds)].sort(),
            content: interaction.content,
            channel: "audible" as const,
          }],
        }
      : {}),
    participants: [...new Set([input.actorId, ...candidate.participants])],
    participantPresence: physicalParticipantIds.map((entityId) => ({ entityId, mode: "physical" as const })),
    proposedTime: input.proposedTime ?? { kind: "unknown" },
    ...(input.timeAdvance ? { timeAdvance: input.timeAdvance } : {}),
    preconditions: candidate.preconditions,
    proposedDelta: candidate.proposedDelta,
    ...(candidate.proposedKnowledge ? { proposedKnowledge: candidate.proposedKnowledge } : {}),
    causalParents: [],
    evidence: [],
  });
  return {
    proposal,
    requiresKnowledge: candidate.requiresKnowledge,
    forbidsKnowledge: candidate.forbidsKnowledge,
  };
}

function boundedObservation(value: string): string {
  const characters = Array.from(value.trim());
  return characters.length <= 1_000 ? characters.join("") : `${characters.slice(0, 999).join("")}…`;
}

function playerIntentObservation(utterance: string): string {
  const normalized = utterance.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const characters = Array.from(normalized);
  const bounded = characters.length <= 800
    ? normalized
    : `${characters.slice(0, 800).join("")}…`;
  return `Attempted player intent (not an asserted outcome): ${bounded}`;
}

function playerIntentTitle(utterance: string): string {
  return playerIntentObservation(utterance);
}

/**
 * One player turn: actor-scoped intent proposal -> current-world adjudication
 * -> capability/knowledge/invariant validation -> commit -> actor rendering.
 */
export class PlayerTurnService {
  private readonly render: PlayerTurnRender;

  constructor(
    private readonly engine: WorldEngine,
    private readonly translator: PlayerActionTranslator,
    render?: PlayerTurnRender,
    private readonly resolveCanon?: PlayerCanonResolver,
    private readonly beforeCommit?: () => Promise<void> | void,
    private readonly adjudicator?: PlayerWorldAdjudicator,
    private readonly contextResolver?: RuntimeContextResolver,
    private readonly contextObserver?: RuntimeContextConsultationObserver,
  ) {
    if (render) this.render = render;
    else {
      const renderer = new NarrativeRenderer(engine);
      this.render = ({ branchId, commitId, actorId, sourceId }) =>
        renderer.render(branchId, commitId, { pointOfView: "actor", actorId }, sourceId);
    }
  }

  async turn(inputValue: PlayerTurnInput, authority: PlayerTurnAuthority = {}): Promise<PlayerTurnResult> {
    const input = playerTurnInputSchema.parse(inputValue);
    const previousHead = await this.engine.branches.readHead(input.branchId);
    const [contextBefore, storyTime, worldContext, worldState, conversation] = await Promise.all([
      buildActorScopedActionContext(this.engine, input.actorId, previousHead, input.utterance, input.sourceId),
      latestCommittedStoryTime(this.engine, previousHead),
      this.engine.contextForCommit(previousHead),
      this.engine.projector.project(previousHead),
      playConversationAtCommit(this.engine, input.branchId, previousHead, input.actorId, input.conversationId),
    ]);
    const relatedMessages = modelPlayConversation(conversation);
    const recentMessages = modelPlayConversation(recentPlayConversation(conversation));
    const authorizedKnowledgeClaimIds = new Set(authority.authorizedKnowledgeClaimIds ?? []);
    const contextState: PlayerTurnContextState = { consultations: [], repairHints: [] };
    let consultationUsed = false;
    const consult = async (
      need: RuntimeContextNeed,
      candidate?: PlayerActionCandidate,
      world?: PlayerWorldAdjudicationContext,
    ): Promise<{ result?: ReturnType<typeof runtimeContextConsultationResultSchema.parse>; issue?: ValidationIssue }> => {
      if (consultationUsed) {
        return { issue: issue("PLAYER_CONTEXT_RETRY_EXHAUSTED", "The one permitted source-context consultation for this player move has already been used.") };
      }
      consultationUsed = true;
      await this.contextObserver?.onGapDetected?.(structuredClone(need));
      if (!this.contextResolver) {
        return { issue: issue("PLAYER_CONTEXT_RESOLVER_UNAVAILABLE", "The action requires source context that is not available in this runtime.") };
      }
      const before = await this.engine.branches.readHead(input.branchId);
      if (before !== previousHead) {
        return { issue: issue("STALE_PARENT", `Player turn began at ${previousHead}, current head is ${before}`) };
      }
      try {
        const result = runtimeContextConsultationResultSchema.parse(await this.contextResolver(deepFreeze({
          need,
          branchId: input.branchId,
          actorId: input.actorId,
          expectedHead: previousHead,
          ...(input.sourceId ? { sourceId: input.sourceId } : {}),
          utterance: input.utterance,
          actorContext: structuredClone(contextBefore),
          ...(candidate ? { candidate: structuredClone(candidate) } : {}),
          ...(world ? { world: structuredClone(world) } : {}),
        })));
        const after = await this.engine.branches.readHead(input.branchId);
        if (after !== previousHead) {
          return { issue: issue("STALE_PARENT", `Source consultation began at ${previousHead}, current head is ${after}`) };
        }
        await this.contextObserver?.onSupplementValidated?.(structuredClone(result));
        contextState.consultations.push(structuredClone(result.record));
        contextState.supplement = mergeRuntimeContextSupplements(contextState.supplement, result.supplement);
        contextState.repairHints.push(...structuredClone(result.repairHints));
        return { result };
      } catch (error) {
        if (isAbortError(error)) throw error;
        return {
          issue: issue(
            "PLAYER_CONTEXT_CONSULTATION_FAILED",
            error instanceof Error ? error.message : String(error),
          ),
        };
      }
    };
    const reject = (
      stage: Exclude<PlayerTurnStage, "committed">,
      issues: ValidationIssue[],
      candidate?: PlayerActionCandidate,
      proposal?: EventProposal,
      validation?: ValidationReport,
      evaluatedHead?: CommitId,
    ) => this.rejected(
      input,
      previousHead,
      contextBefore,
      stage,
      issues,
      candidate,
      proposal,
      validation,
      evaluatedHead,
      contextState,
    );

    let intendedCandidate: PlayerActionCandidate | undefined;
    let groundingIssues: ValidationIssue[] = [];
    let intentConsistencyIssues: ValidationIssue[] = [];
    for (let attempt = 1; attempt <= 2 && !intendedCandidate; attempt += 1) {
      let translated: unknown;
      try {
        translated = await this.translator(deepFreeze({
          utterance: input.utterance,
          context: playerActionTranslationContext(contextBefore),
          recentMessages,
          relatedMessages,
          ...(contextState.supplement?.translation.length
            ? { contextSupplement: structuredClone(contextState.supplement.translation) }
            : {}),
        }));
      } catch (error) {
        if (isAbortError(error)) throw error;
        return reject("translation", [
          issue("PLAYER_ACTION_TRANSLATION_FAILED", error instanceof Error ? error.message : String(error)),
        ]);
      }

      const parsedOutput = playerActionTranslationOutputSchema.safeParse(translated);
      if (!parsedOutput.success) {
        return reject("translation", parsedOutput.error.issues.map((entry) => issue(
          "INVALID_PLAYER_ACTION_CANDIDATE",
          entry.message,
          entry.path.length ? entry.path.join(".") : undefined,
        )));
      }
      if ("decision" in parsedOutput.data) {
        const need = materializeRuntimeContextNeed(parsedOutput.data, "translation");
        const consulted = await consult(need);
        if (
          attempt === 1
          && consulted.result?.record.retryRecommended
          && contextState.supplement
          && runtimeContextSupplementHasMaterial(contextState.supplement, "translation")
        ) continue;
        return reject("translation", [
          ...(consulted.issue ? [consulted.issue] : []),
          issue("PLAYER_CONTEXT_DATA_UNRESOLVED", "The requested action depends on context that could not be admitted into the actor-visible translation scope."),
        ]);
      }

      const candidate = normalizeStructuredPlayerCandidate(parsedOutput.data, authority.intent);
      const scopeIssues = validatePlayerActionScope(candidate, contextBefore, authorizedKnowledgeClaimIds);
      if (scopeIssues.length) {
        const need = attempt === 1 ? runtimeContextNeedForIssues("translation", input.utterance, scopeIssues) : undefined;
        const consulted = need ? await consult(need, candidate) : undefined;
        if (
          consulted?.result?.record.retryRecommended
          && contextState.supplement
          && runtimeContextSupplementHasMaterial(contextState.supplement, "translation")
        ) continue;
        return reject("scope", [...scopeIssues, ...(consulted?.issue ? [consulted.issue] : [])], candidate);
      }
      groundingIssues = validatePlayerActionGrounding(candidate, contextBefore);
      intentConsistencyIssues = validatePlayerIntentConsistency(candidate, input.actorId);
      const ungroundedIssues = groundingIssues.filter((entry) => entry.code === "PLAYER_PRECONDITION_UNGROUNDED");
      if (ungroundedIssues.length) {
        const need = attempt === 1 ? runtimeContextNeedForIssues("translation", input.utterance, groundingIssues) : undefined;
        const consulted = need ? await consult(need, candidate) : undefined;
        if (
          consulted?.result?.record.retryRecommended
          && contextState.supplement
          && runtimeContextSupplementHasMaterial(contextState.supplement, "translation")
        ) continue;
        return reject("scope", [...groundingIssues, ...(consulted?.issue ? [consulted.issue] : [])], candidate);
      }
      intendedCandidate = candidate;
    }
    if (!intendedCandidate) {
      return reject("translation", [issue("PLAYER_CONTEXT_RETRY_EXHAUSTED", "Player action translation remained unresolved after one source-context retry.")]);
    }

    let candidate = intendedCandidate;
    let outcomeStatus: EventOutcomeStatus = "succeeded";
    let eventTitle: string | undefined;
    let actorObservation: string | undefined;
    let adjudication: PlayerWorldResolution | undefined;
    const nonFatalIssues: ValidationIssue[] = [];

    if (this.adjudicator) {
      const intendedTiming = playerCandidateTiming(intendedCandidate, storyTime);
      let previewAction = playerActionToKnowledgeAwareAction({
        branchId: input.branchId,
        actorId: input.actorId,
        expectedParentCommit: previousHead,
        utterance: input.utterance,
        candidate: intendedCandidate,
        ...(intendedTiming.proposedTime ? { proposedTime: intendedTiming.proposedTime } : {}),
        ...(intendedTiming.timeAdvance ? { timeAdvance: intendedTiming.timeAdvance } : {}),
      });
      const previewProgress = await derivePlayerProgress(
        this.engine,
        input,
        intendedCandidate,
        contextBefore,
        { supersedesCanonicalEventIds: [] },
        authority,
        "succeeded",
      );
      previewAction = {
        ...previewAction,
        proposal: eventProposalSchema.parse({ ...previewAction.proposal, progress: previewProgress.value }),
      };
      const [spatialIssues, knowledgePreview] = await Promise.all([
        validatePlayerActionSpatialScope(this.engine, intendedCandidate, input.actorId, previousHead, input.sourceId),
        validateActionKnowledge(this.engine, previewAction),
      ]);
      const enginePreview = validateEventProposal(previewAction.proposal, previousHead, worldState, worldContext).report;
      const deterministicIssues = uniqueIssues([
        ...intentConsistencyIssues,
        ...groundingIssues,
        ...spatialIssues,
        ...knowledgePreview.errors,
        ...enginePreview.errors,
      ]);
      const adjudicationWorld = buildPlayerWorldAdjudicationContext(
        contextBefore,
        intendedCandidate,
        worldContext,
        worldState,
        deterministicIssues,
      );
      let resolutionFailure: ValidationIssue[] | undefined;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        let proposedResolution: unknown;
        try {
          proposedResolution = await this.adjudicator(deepFreeze({
            utterance: input.utterance,
            candidate: structuredClone(intendedCandidate),
            actorContext: playerActionTranslationContext(contextBefore),
            world: adjudicationWorld,
            recentMessages,
            relatedMessages,
            ...(contextState.supplement?.adjudication.length
              ? { contextSupplement: structuredClone(contextState.supplement.adjudication) }
              : {}),
          }));
        } catch (error) {
          if (isAbortError(error)) throw error;
          resolutionFailure = [
            issue("PLAYER_WORLD_ADJUDICATION_FAILED", error instanceof Error ? error.message : String(error)),
          ];
          break;
        }
        const parsedResolution = playerWorldResolutionSchema.safeParse(proposedResolution);
        if (!parsedResolution.success) {
          resolutionFailure = parsedResolution.error.issues.map((entry) => issue(
            "INVALID_PLAYER_WORLD_RESOLUTION",
            entry.message,
            entry.path.length ? entry.path.join(".") : undefined,
          ));
          break;
        }
        if (parsedResolution.data.decision === "needs-context") {
          if (deterministicIssues.some((entry) => !isRuntimeContextGapIssue(entry))) {
            return reject("adjudication", [
              issue(
                "PLAYER_CONTEXT_REQUEST_NOT_DATA_GAP",
                "The adjudicator requested source context even though the supplied deterministic issues already contain a definitive contradiction or boundary failure.",
              ),
              ...deterministicIssues,
            ], intendedCandidate, previewAction.proposal);
          }
          const need = materializeRuntimeContextNeed(parsedResolution.data, "adjudication", deterministicIssues.map((entry) => entry.code));
          const consulted = await consult(need, intendedCandidate, adjudicationWorld);
          if (
            attempt === 1
            && consulted.result?.record.retryRecommended
            && contextState.supplement
            && runtimeContextSupplementHasMaterial(contextState.supplement, "adjudication")
          ) continue;
          return reject("adjudication", [
            ...deterministicIssues,
            ...(consulted.issue ? [consulted.issue] : []),
            issue("PLAYER_CONTEXT_DATA_UNRESOLVED", "The world outcome depends on source context that could not be admitted as current branch authority."),
          ], intendedCandidate, previewAction.proposal);
        }

        adjudication = parsedResolution.data;
        eventTitle = adjudication.eventTitle;
        actorObservation = adjudication.actorObservation;
        outcomeStatus = adjudication.status;
        if (adjudication.decision === "realize") {
          if (deterministicIssues.length) {
            const need = attempt === 1
              ? runtimeContextNeedForIssues("adjudication", input.utterance, deterministicIssues)
              : undefined;
            const consulted = need ? await consult(need, intendedCandidate, adjudicationWorld) : undefined;
            if (
              consulted?.result?.record.retryRecommended
              && contextState.supplement
              && runtimeContextSupplementHasMaterial(contextState.supplement, "adjudication")
            ) continue;
            return reject("adjudication", [
              issue(
                "PLAYER_WORLD_CONTRADICTION_UNRESOLVED",
                "The world adjudicator tried to realize an intent that still contradicts committed state or active rules.",
              ),
              ...deterministicIssues,
              ...(consulted?.issue ? [consulted.issue] : []),
            ], intendedCandidate, previewAction.proposal);
          }
        } else {
          const contradictionIssues = validatePlayerWorldContradiction(adjudication, adjudicationWorld);
          if (contradictionIssues.length) {
            return reject("adjudication", contradictionIssues, intendedCandidate);
          }
          candidate = normalizeStructuredPlayerCandidate(adjudication.replacement, undefined);
          const replacementIssues = [
            ...validatePlayerActionScope(candidate, contextBefore, authorizedKnowledgeClaimIds),
            ...validatePlayerIntentConsistency(candidate, input.actorId),
            ...validatePlayerActionGrounding(candidate, contextBefore),
            ...await validatePlayerActionSpatialScope(this.engine, candidate, input.actorId, previousHead, input.sourceId),
          ];
          if (replacementIssues.length) {
            return reject("adjudication", [
              issue(
                "PLAYER_WORLD_REPLACEMENT_INVALID",
                "The proposed in-world consequence did not satisfy the same capability and grounding boundary as every other event.",
              ),
              ...replacementIssues,
            ], intendedCandidate);
          }
        }
        break;
      }
      if (resolutionFailure) {
        const fallback = controlledObservationFallback(intendedCandidate, deterministicIssues);
        if (!fallback) {
          return reject("adjudication", resolutionFailure, intendedCandidate, previewAction.proposal);
        }
        candidate = fallback.candidate;
        eventTitle = fallback.eventTitle;
        actorObservation = fallback.actorObservation;
        outcomeStatus = "succeeded";
        nonFatalIssues.push(issue(
          "PLAYER_WORLD_ADJUDICATION_CONTROLLED_ACT_FALLBACK",
          `World adjudication did not return a valid resolution (${resolutionFailure[0]?.code ?? "unknown"}); only the deterministically validated actor-controlled observation was committed.`,
          "intent.controlledAct",
        ));
      }
    } else {
      if (groundingIssues.length || intentConsistencyIssues.length) {
        return reject("scope", [
          ...groundingIssues,
          ...intentConsistencyIssues,
        ], intendedCandidate);
      }
      const spatialIssues = await validatePlayerActionSpatialScope(this.engine, candidate, input.actorId, previousHead, input.sourceId);
      if (spatialIssues.length) {
        const need = runtimeContextNeedForIssues("adjudication", input.utterance, spatialIssues);
        const consulted = need ? await consult(need, intendedCandidate) : undefined;
        return reject("scope", [...spatialIssues, ...(consulted?.issue ? [consulted.issue] : [])], intendedCandidate);
      }
    }

    const timing = playerCandidateTiming(candidate, storyTime);
    let action = playerActionToKnowledgeAwareAction({
      branchId: input.branchId,
      actorId: input.actorId,
      expectedParentCommit: previousHead,
      utterance: input.utterance,
      candidate,
      ...(timing.proposedTime ? { proposedTime: timing.proposedTime } : {}),
      ...(timing.timeAdvance ? { timeAdvance: timing.timeAdvance } : {}),
      ...(eventTitle ? { eventTitle } : {}),
      ...(actorObservation ? { actorObservation } : {}),
    });
    let resolution: CanonicalChoiceResolution = { supersedesCanonicalEventIds: [] };
    if (this.resolveCanon) {
      // The resolver may inspect a proposal but must not edit the already
      // capability-checked candidate by retaining or mutating its reference.
      resolution = canonicalChoiceResolutionSchema.parse(
        await this.resolveCanon(immutableClone(action.proposal)),
      );
      const supersedesCanonicalEventIds = [...new Set(resolution.supersedesCanonicalEventIds)].sort();
      if (supersedesCanonicalEventIds.length || resolution.realizedPossibilityId || resolution.causalParentEventIds?.length) {
        action = {
          ...action,
          proposal: eventProposalSchema.parse({
            ...action.proposal,
            causalParents: [...new Set([
              ...action.proposal.causalParents,
              ...(resolution.causalParentEventIds ?? []),
            ])],
            ...(supersedesCanonicalEventIds.length ? { supersedesCanonicalEventIds } : {}),
            ...(resolution.realizedPossibilityId ? { possibilityId: resolution.realizedPossibilityId } : {}),
          }),
        };
      }
    }

    if (!consultationUsed && this.contextResolver) {
      const literaryRequest = runtimeLiteraryContextRequest(candidate, input.utterance, contextBefore);
      if (literaryRequest) {
        const consulted = await consult(
          materializeRuntimeContextNeed(literaryRequest, "narration"),
          candidate,
        );
        if (consulted.issue) nonFatalIssues.push(consulted.issue);
      }
    }

    let progress: { value: NarrativeProgress; certificate: PlayerProgressCertificate };
    try {
      progress = await derivePlayerProgress(this.engine, input, candidate, contextBefore, resolution, authority, outcomeStatus);
    } catch (error) {
      return reject("scope", [
        issue(
          "INVALID_PLAYER_PROGRESS_AUTHORITY",
          error instanceof Error ? error.message : String(error),
        ),
      ], candidate, action.proposal);
    }
    action = {
      ...action,
      proposal: eventProposalSchema.parse({ ...action.proposal, progress: progress.value }),
    };

    await this.beforeCommit?.();
    const committed = await commitKnowledgeAwareAction(this.engine, action);
    if (!committed.gate.accepted) {
      return reject(
        "knowledge",
        committed.gate.errors,
        candidate,
        action.proposal,
        undefined,
        committed.gate.evaluatedAtCommit,
      );
    }
    if (!committed.result) {
      return reject(
        "engine",
        [issue("PLAYER_ACTION_COMMIT_MISSING", "Player action passed its gate but produced no engine result")],
        candidate,
        action.proposal,
      );
    }
    if (!committed.result.report.accepted) {
      return reject(
        "engine",
        committed.result.report.errors,
        candidate,
        action.proposal,
        committed.result.report,
        committed.result.newHead,
      );
    }

    const newHead = committed.result.newHead;
    const contextAfter = await buildActorScopedActionContext(this.engine, input.actorId, newHead, undefined, input.sourceId);
    const renderedText = await this.renderAt(input.branchId, input.actorId, newHead, input.sourceId);
    return {
      accepted: true,
      stage: "committed",
      branchId: input.branchId,
      actorId: input.actorId,
      previousHead,
      newHead,
      issues: uniqueIssues([...nonFatalIssues, ...committed.result.report.warnings]),
      contextBefore,
      contextAfter,
      renderedText,
      intendedCandidate,
      candidate,
      ...(adjudication ? { adjudication } : {}),
      proposal: action.proposal,
      validation: committed.result.report,
      progressCertificate: progress.certificate,
      ...(committed.result.eventHash ? { eventHash: committed.result.eventHash } : {}),
      ...(contextState.consultations.length ? { contextConsultations: structuredClone(contextState.consultations) } : {}),
      ...(contextState.supplement && runtimeContextSupplementHasMaterial(contextState.supplement)
        ? { contextSupplement: structuredClone(contextState.supplement) }
        : {}),
      ...(contextState.repairHints.length ? { repairHints: structuredClone(contextState.repairHints) } : {}),
    };
  }

  private async rejected(
    input: PlayerTurnInput,
    previousHead: CommitId,
    contextBefore: ActorScopedActionContext,
    stage: Exclude<PlayerTurnStage, "committed">,
    initialIssues: ValidationIssue[],
    candidate?: PlayerActionCandidate,
    proposal?: EventProposal,
    validation?: ValidationReport,
    evaluatedHead?: CommitId,
    contextState?: PlayerTurnContextState,
  ): Promise<PlayerTurnResult> {
    const newHead = evaluatedHead ?? (await this.engine.branches.readHead(input.branchId));
    const issues = [...initialIssues];
    if (newHead !== previousHead && !issues.some((entry) => entry.code === "STALE_PARENT")) {
      issues.push(issue("STALE_PARENT", `Player turn began at ${previousHead}, current head is ${newHead}`));
    }
    const contextAfter = newHead === previousHead
      ? contextBefore
      : await buildActorScopedActionContext(this.engine, input.actorId, newHead, undefined, input.sourceId);
    const renderedText = await this.renderAt(input.branchId, input.actorId, newHead, input.sourceId);
    return {
      accepted: false,
      stage,
      branchId: input.branchId,
      actorId: input.actorId,
      previousHead,
      newHead,
      issues,
      contextBefore,
      contextAfter,
      renderedText,
      ...(candidate ? { candidate } : {}),
      ...(proposal ? { proposal } : {}),
      ...(validation ? { validation } : {}),
      ...(contextState?.consultations.length ? { contextConsultations: structuredClone(contextState.consultations) } : {}),
      ...(contextState?.supplement && runtimeContextSupplementHasMaterial(contextState.supplement)
        ? { contextSupplement: structuredClone(contextState.supplement) }
        : {}),
      ...(contextState?.repairHints.length ? { repairHints: structuredClone(contextState.repairHints) } : {}),
    };
  }

  private async renderAt(branchId: string, actorId: EntityId, commitId: CommitId, sourceId?: string): Promise<string> {
    const before = await this.engine.branches.readHead(branchId);
    if (before !== commitId) throw new Error(`Cannot render player turn at stale commit ${commitId}; current head is ${before}`);
    const rendered: unknown = await this.render(deepFreeze({ branchId, actorId, commitId, ...(sourceId ? { sourceId } : {}) }));
    const after = await this.engine.branches.readHead(branchId);
    if (after !== before) throw new Error("Player turn renderer mutated branch truth");
    if (typeof rendered !== "string") throw new Error("Player turn renderer must return a string");
    return rendered;
  }
}

function normalizeStructuredPlayerCandidate(
  candidateInput: PlayerActionCandidate,
  authorityIntent?: "act" | SafePlayerIntent,
): PlayerActionCandidate {
  const candidate = structuredClone(playerActionCandidateSchema.parse(candidateInput));
  const kind = authorityIntent ?? candidate.intent?.kind ?? "act";
  candidate.intent = {
    ...(candidate.intent ?? {
      kind,
      summary: candidate.title,
      targets: [],
    }),
    kind,
  };
  if (kind === "observe" && !candidate.intent.sceneTransition) {
    candidate.intent.sceneTransition = { kind: "stay" };
  }
  if (kind === "wait" && !candidate.intent.requestedTimeAdvance) {
    candidate.intent.requestedTimeAdvance = { amount: 5, unit: "minute" };
  }
  return playerActionCandidateSchema.parse(candidate);
}

/**
 * Bounded literary consultation is conditional, not a mandatory extra model
 * call. Structured referents and context-sparse direct interactions are the points at which
 * sparse executable data most often loses identity, provenance, or relationship
 * context needed by a reader who has never seen the source novel.
 */
function runtimeLiteraryContextRequest(
  candidate: PlayerActionCandidate,
  utterance: string,
  context: ActorScopedActionContext,
): RuntimeContextRequest | undefined {
  const intent = candidate.intent;
  const described = intent?.targets.filter((target) => target.kind === "described") ?? [];
  const addresseeIds = intent?.controlledAct?.interactionMode === "direct"
    ? intent.controlledAct.interaction?.addresseeIds ?? []
    : [];
  const referenceable = new Map(context.referenceableEntities.map((entity) => [entity.id, entity]));
  const sparseAddressees = [...new Set(addresseeIds)]
    .filter((entityId) => entityId !== context.actorId)
    .filter((entityId) => {
      const entity = referenceable.get(entityId);
      if (!entity || /^Unidentified\s/iu.test(entity.name)) return true;
      return !context.knowledge.some((entry) => entry.claim && (
        entry.claim.subject === entityId
        || entry.claim.speaker === entityId
        || valueContainsEntity(entry.claim.object, entityId)
      ));
    });
  if (!described.length && !sparseAddressees.length) return undefined;
  const searchTerms = [
    ...described.map((target) => target.description),
    ...sparseAddressees.flatMap((entityId) => {
      const name = referenceable.get(entityId)?.name;
      return name && !/^Unidentified\s/iu.test(name) ? [name] : [];
    }),
    Array.from(utterance.normalize("NFKC").trim()).slice(0, 240).join(""),
  ].filter((value) => value.length > 0).slice(0, 8);
  const hasUnidentifiedAddressee = sparseAddressees.some((entityId) =>
    /^Unidentified\s/iu.test(referenceable.get(entityId)?.name ?? ""));
  return runtimeContextRequestSchema.parse({
    decision: "needs-context",
    domain: described.length ? "artifact-provenance" : hasUnidentifiedAddressee ? "identity" : "relationship",
    question: described.length
      ? "Find current-or-prior source context that safely explains the named or described referent and why it matters in this immediate scene."
      : "Find current-or-prior relationship context that helps render this direct interaction without inventing another character's response.",
    audience: "reader",
    searchTerms,
  });
}

function valueContainsEntity(value: unknown, entityId: string, depth = 0): boolean {
  if (value === entityId) return true;
  if (depth >= 8 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => valueContainsEntity(item, entityId, depth + 1));
  return Object.values(value as Record<string, unknown>)
    .some((item) => valueContainsEntity(item, entityId, depth + 1));
}

/**
 * A missing/malformed adjudicator response cannot authorize a desired effect.
 * It may, however, leave enough deterministic evidence to commit the selected
 * actor's own bounded observation. Keep this deliberately narrower than normal
 * realization: no writes, knowledge effects, time advance, or scene movement.
 */
function controlledObservationFallback(
  candidateInput: PlayerActionCandidate,
  deterministicIssues: readonly ValidationIssue[],
): { candidate: PlayerActionCandidate; eventTitle: string; actorObservation: string } | undefined {
  const candidate = playerActionCandidateSchema.parse(candidateInput);
  const intent = candidate.intent;
  if (
    deterministicIssues.length
    || intent?.kind !== "observe"
    || !intent.controlledAct
    || intent.sceneTransition?.kind !== "stay"
    || intent.requestedTimeAdvance
    || candidate.proposedDelta.operations.length
    || (candidate.proposedKnowledge?.operations.length ?? 0)
    || candidate.requiresKnowledge.length
    || candidate.forbidsKnowledge.length
  ) return undefined;

  // Do not commit model-authored copy after the semantic adjudicator failed:
  // controlledAct is useful evidence for adjudication/audit, but its prose
  // could still overclaim the desired effect. Materialize only the typed,
  // host-defined observe/stay primitive here.
  const deterministicAct = {
    eventTitle: SAFE_PLAYER_INTENT_TITLES.observe,
    actorObservation: SAFE_PLAYER_INTENT_ACTOR_OBSERVATIONS.observe,
  };
  const fallbackCandidate = playerActionCandidateSchema.parse({
    title: deterministicAct.eventTitle,
    intent: {
      kind: "observe",
      summary: deterministicAct.eventTitle,
      controlledAct: deterministicAct,
      targets: [],
      sceneTransition: { kind: "stay" },
    },
    participants: [],
    preconditions: [],
    proposedDelta: { version: 1, operations: [] },
    requiresKnowledge: [],
    forbidsKnowledge: [],
  });
  return {
    candidate: fallbackCandidate,
    eventTitle: deterministicAct.eventTitle,
    actorObservation: deterministicAct.actorObservation,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === "AbortError" || /\babort(?:ed|ing)?\b/iu.test(error.message));
}

function playerCandidateTiming(
  candidate: PlayerActionCandidate,
  storyTime?: StoryTime,
): { proposedTime?: StoryTime; timeAdvance?: TimeAdvance } {
  const timeAdvance = candidate.intent?.requestedTimeAdvance;
  const proposedTime = storyTime && timeAdvance ? advanceStoryTime(storyTime, timeAdvance) : storyTime;
  return {
    ...(proposedTime ? { proposedTime } : {}),
    ...(timeAdvance ? { timeAdvance } : {}),
  };
}

async function derivePlayerProgress(
  engine: WorldEngine,
  input: PlayerTurnInput,
  candidate: PlayerActionCandidate,
  context: ActorScopedActionContext,
  resolution: CanonicalChoiceResolution,
  authority: PlayerTurnAuthority,
  outcomeStatus: EventOutcomeStatus,
): Promise<{ value: NarrativeProgress; certificate: PlayerProgressCertificate }> {
  const [state, scene, worldContext] = await Promise.all([
    engine.projector.project(context.atCommit),
    projectActorScene(engine, input.actorId, context.atCommit, input.sourceId),
    engine.contextForCommit(context.atCommit),
  ]);
  const effectiveOperations = candidate.proposedDelta.operations.filter((operation) => stateOperationChangesState(operation, state));
  const knowledgeOperations = candidate.proposedKnowledge?.operations.length ?? 0;
  const intent = candidate.intent ?? normalizeStructuredPlayerCandidate(candidate, authority.intent).intent!;
  let progress: NarrativeProgress;

  if (authority.progress) {
    const parsed = narrativeProgressSchema.parse(structuredClone(authority.progress));
    const channels = new Set(parsed.channels);
    if (effectiveOperations.length) channels.add("state");
    if (knowledgeOperations) channels.add("knowledge");
    if (outcomeStatus !== "succeeded") channels.add("consequence");
    const threadIds = [...new Set([...parsed.threadIds, ...(resolution.threadIds ?? [])])];
    if (threadIds.length) channels.add("thread");
    progress = narrativeProgressSchema.parse({
      ...parsed,
      channels: [...channels],
      threadIds,
      outcome: outcomeStatus,
    });
  } else {
    const channels = new Set<ProgressChannel>();
    if (effectiveOperations.length) channels.add("state");
    if (knowledgeOperations) channels.add("knowledge");
    if (effectiveOperations.some(isResourceOperation)) channels.add("resource");
    if (effectiveOperations.some(isRelationshipOperation)) channels.add("relationship");

    const characterParticipants = candidate.participants.filter((participantId) =>
      participantId !== input.actorId
      && worldContext.entities.get(participantId)?.kind === "character"
      && scene.presentEntityIds.includes(participantId));
    const threadIds = [...new Set(resolution.threadIds ?? [])];
    if (!threadIds.length) {
      const latest = scene.recentEvents.at(-1);
      threadIds.push(...(latest?.progress?.threadIds.length
        ? latest.progress.threadIds
        : [`emergent-${contentHash({ actorId: input.actorId, scene: scene.key }).slice(0, 24)}`]));
    }

    const knownMovement = candidate.proposedDelta.operations.find((operation) =>
      operation.op === "set"
      && operation.entityId === input.actorId
      && operation.field === "character.location"
      && typeof operation.value === "string");
    let sceneTransition: NarrativeProgress["scene"];
    if (knownMovement?.op === "set" && typeof knownMovement.value === "string") {
      channels.add("scene");
      channels.add("consequence");
      const destinationEntityId = knownMovement.value;
      sceneTransition = {
        kind: "arrive",
        ...(worldContext.entities.get(destinationEntityId)?.canonicalName
          ? { label: worldContext.entities.get(destinationEntityId)!.canonicalName }
          : {}),
        destinationEntityId,
        beat: scene.beat + 1,
      };
    } else if (intent.sceneTransition) {
      channels.add("scene");
      if (intent.sceneTransition.kind !== "stay") channels.add("consequence");
      const destination = intent.sceneTransition.destination;
      const destinationEntityId = destination?.kind === "entity"
        && worldContext.entities.get(destination.entityId)?.kind === "location"
        ? destination.entityId
        : undefined;
      const openTransition = intent.sceneTransition.kind !== "stay" && !destinationEntityId;
      sceneTransition = {
        kind: destinationEntityId && intent.sceneTransition.kind === "arrive"
          ? "arrive"
          : intent.sceneTransition.kind === "arrive"
            ? "explore"
            : intent.sceneTransition.kind,
        ...(destination?.kind === "described"
          ? { label: destination.description }
          : destinationEntityId
            ? { label: worldContext.entities.get(destinationEntityId)!.canonicalName }
            : intent.sceneTransition.kind === "stay" && scene.label
              ? { label: scene.label }
              : {}),
        ...(destinationEntityId ? { destinationEntityId } : {}),
        ...(openTransition
          ? {
              sceneId: `open-${contentHash({
                branchId: input.branchId,
                parentCommit: context.atCommit,
                actorId: input.actorId,
                beat: scene.beat + 1,
                kind: intent.sceneTransition.kind,
              }).slice(0, 24)}`,
            }
          : {}),
        beat: scene.beat + 1,
      };
    }

    if (intent.kind === "observe" && !sceneTransition) {
      channels.add("scene");
      sceneTransition = {
        kind: "stay",
        ...(scene.label ? { label: scene.label } : {}),
        beat: scene.beat + 1,
      };
    }
    if (intent.kind === "reflect") channels.add("plan");
    if (intent.kind === "wait") {
      channels.add("time-pressure");
      channels.add("consequence");
    }
    if (intent.kind === "act" && characterParticipants.length) {
      channels.add("relationship");
    }
    if (intent.kind === "act" || outcomeStatus !== "succeeded") channels.add("consequence");
    if (intent.kind !== "observe" && (channels.size > 0 || threadIds.length)) channels.add("thread");
    const noveltyKey = `player-${contentHash({
      parentCommit: context.atCommit,
      actorId: input.actorId,
      intent: intent.kind,
      outcome: outcomeStatus,
      participants: [...characterParticipants].sort(),
      operations: effectiveOperations.map(operationKey).sort(),
      claims: (candidate.proposedKnowledge?.operations.map((operation) => operation.claimId) ?? []).sort(),
      threads: [...threadIds].sort(),
      sceneId: sceneTransition?.sceneId,
      destinationEntityId: sceneTransition?.destinationEntityId,
    }).slice(0, 32)}`;
    progress = narrativeProgressSchema.parse({
      version: 1,
      channels: [...channels],
      threadIds,
      noveltyKey,
      outcome: outcomeStatus,
      ...(sceneTransition ? { scene: sceneTransition } : {}),
    });
  }
  const sceneChanged = Boolean(progress.scene && (
    progress.scene.kind !== "stay"
    || (progress.scene.destinationEntityId !== undefined && progress.scene.destinationEntityId !== scene.locationId)
    || (progress.scene.sceneId !== undefined && progress.scene.sceneId !== scene.key.replace(/^scene:/, ""))
  ));
  const timeAdvanced = Boolean(intent.requestedTimeAdvance);
  const certificate: PlayerProgressCertificate = {
    channels: [...progress.channels],
    threadIds: [...progress.threadIds],
    noveltyKey: progress.noveltyKey,
    effectiveStateOperations: effectiveOperations.length,
    knowledgeOperations,
    sceneChanged,
    timeAdvanced,
    materiallyAdvanced: effectiveOperations.length > 0
      || knowledgeOperations > 0
      || sceneChanged
      || timeAdvanced,
  };
  return { value: progress, certificate };
}

function stateOperationChangesState(
  operation: PlayerActionCandidate["proposedDelta"]["operations"][number],
  state: Awaited<ReturnType<WorldEngine["projector"]["project"]>>,
): boolean {
  if (operation.op === "activate-rule") return !state.activeRuleIds.includes(operation.ruleId);
  if (operation.op === "deactivate-rule") return state.activeRuleIds.includes(operation.ruleId);
  const current = state.values[operation.entityId]?.[operation.field];
  if (operation.op === "set") return JSON.stringify(current) !== JSON.stringify(operation.value);
  if (operation.op === "unset") return current !== undefined;
  if (operation.op === "add-member") return !Array.isArray(current) || !current.includes(operation.member);
  if (operation.op === "remove-member") return Array.isArray(current) && current.includes(operation.member);
  return typeof current === "number" && operation.amount !== 0;
}

function isResourceOperation(operation: PlayerActionCandidate["proposedDelta"]["operations"][number]): boolean {
  return "field" in operation && (operation.field.startsWith("artifact.") || operation.field === "character.inventory");
}

function isRelationshipOperation(operation: PlayerActionCandidate["proposedDelta"]["operations"][number]): boolean {
  return "field" in operation && (operation.field.startsWith("relationship.") || operation.field === "character.relationships" || operation.field === "character.obligations");
}

function operationKey(operation: PlayerActionCandidate["proposedDelta"]["operations"][number]): string {
  if (operation.op === "activate-rule" || operation.op === "deactivate-rule") return `rule:${operation.ruleId}`;
  return `${operation.entityId}:${operation.field}:${operation.op}`;
}


function buildPlayerWorldAdjudicationContext(
  actorContext: ActorScopedActionContext,
  candidate: PlayerActionCandidate,
  worldContext: WorldModelContext,
  worldState: WorldState,
  deterministicIssues: ValidationIssue[],
): PlayerWorldAdjudicationContext {
  const relevantEntityIds = new Set<EntityId>([
    actorContext.actorId,
    ...actorContext.scene.presentEntityIds,
    ...(actorContext.scene.locationId ? [actorContext.scene.locationId] : []),
    ...candidate.participants,
    ...(candidate.intent?.targets.flatMap((target) => target.kind === "entity" ? [target.entityId] : []) ?? []),
    ...(candidate.intent?.sceneTransition?.destination?.kind === "entity"
      ? [candidate.intent.sceneTransition.destination.entityId]
      : []),
  ]);
  for (const operation of candidate.proposedDelta.operations) {
    if ("entityId" in operation) relevantEntityIds.add(operation.entityId);
    if ("member" in operation) relevantEntityIds.add(operation.member);
  }
  for (const operation of candidate.proposedKnowledge?.operations ?? []) {
    relevantEntityIds.add(operation.actorId);
    if (operation.op === "learn" && operation.sourceActorId) relevantEntityIds.add(operation.sourceActorId);
  }
  const safeState = (entityId: EntityId): Record<string, StateValue> => {
    const result: Record<string, StateValue> = {};
    for (const [field, value] of Object.entries(worldState.values[entityId] ?? {})) {
      let spec: StateFieldSpec;
      try {
        spec = worldContext.stateSchema.get(field);
      } catch {
        continue;
      }
      if (spec.valueType === "entity-ref") {
        if (typeof value === "string" && relevantEntityIds.has(value)) result[field] = value;
        continue;
      }
      if (spec.valueType === "entity-ref-set") {
        if (Array.isArray(value)) result[field] = value.filter((entry) => relevantEntityIds.has(entry));
        continue;
      }
      result[field] = structuredClone(value);
    }
    return result;
  };
  return {
    entities: actorContext.referenceableEntities
      .filter((entity) => relevantEntityIds.has(entity.id))
      .map((entity) => ({
        id: entity.id,
        kind: entity.kind,
        name: entity.name,
        state: safeState(entity.id),
      })),
    activeRules: modelVisibleWorldRules(
      resolveEffectiveWorldRules(worldContext.rules, worldState).effective,
      {
        knownClaimIds: new Set(actorContext.knowledge
          .filter((item) => item.status !== "disbelieves")
          .map((item) => item.claimId)),
        visibleEntityIds: new Set(actorContext.referenceableEntities.map((entity) => entity.id)),
        observableEntityIds: new Set([
          ...actorContext.presentEntities.map((entity) => entity.id),
          ...(actorContext.scene.locationId ? [actorContext.scene.locationId] : []),
        ]),
        entities: worldContext.entities,
      },
    ),
    scene: {
      ...(actorContext.scene.label ? { label: actorContext.scene.label } : {}),
      ...(actorContext.scene.locationId ? { locationId: actorContext.scene.locationId } : {}),
      presentEntityIds: [...actorContext.scene.presentEntityIds],
    },
    deterministicIssues: structuredClone(deterministicIssues),
  };
}

function uniqueIssues(issues: readonly ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((entry) => {
    const key = JSON.stringify([entry.code, entry.path, entry.message]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validatePlayerWorldContradiction(
  resolution: Extract<PlayerWorldResolution, { decision: "transform" }>,
  world: PlayerWorldAdjudicationContext,
): ValidationIssue[] {
  const entities = new Map(world.entities.map((entity) => [entity.id, entity]));
  const activeRuleNames = new Set(world.activeRules.map((rule) => rule.name));
  const deterministicCodes = new Set(world.deterministicIssues.map((entry) => entry.code));
  const issues: ValidationIssue[] = [];
  resolution.contradiction.basis.forEach((basis, index) => {
    const path = `contradiction.basis.${index}`;
    if (basis.source === "state") {
      const entity = entities.get(basis.entityId);
      if (!entity || !Object.hasOwn(entity.state, basis.field)) {
        issues.push(issue(
          "PLAYER_WORLD_CONTRADICTION_UNGROUNDED",
          "A state contradiction basis must name a supplied entity field that exists in committed world state.",
          path,
        ));
      }
      return;
    }
    if (basis.source === "active-rule") {
      if (!activeRuleNames.has(basis.name)) {
        issues.push(issue(
          "PLAYER_WORLD_CONTRADICTION_UNGROUNDED",
          "A rule contradiction basis must name a rule active in the supplied world slice.",
          path,
        ));
      }
      return;
    }
    if (basis.source === "deterministic-issue") {
      if (!deterministicCodes.has(basis.code)) {
        issues.push(issue(
          "PLAYER_WORLD_CONTRADICTION_UNGROUNDED",
          "A deterministic contradiction basis must cite an issue produced for this exact candidate.",
          path,
        ));
      }
      return;
    }
    if (resolution.contradiction.kind !== "causality" && resolution.contradiction.kind !== "capability") {
      issues.push(issue(
        "PLAYER_WORLD_CONTRADICTION_UNGROUNDED",
        "A causal-principle basis is valid only for a direct causality or capability contradiction.",
        path,
      ));
    }
  });
  const sources = new Set(resolution.contradiction.basis.map((basis) => basis.source));
  const kindIsGrounded = resolution.contradiction.kind === "state"
    ? sources.has("state")
    : resolution.contradiction.kind === "world-rule"
      ? sources.has("active-rule")
      : resolution.contradiction.kind === "spatial" || resolution.contradiction.kind === "knowledge"
        ? sources.has("deterministic-issue") || sources.has("state")
        : sources.has("causal-principle") || sources.has("state") || sources.has("active-rule");
  if (!kindIsGrounded) {
    issues.push(issue(
      "PLAYER_WORLD_CONTRADICTION_UNGROUNDED",
      `Contradiction kind ${resolution.contradiction.kind} is not supported by a corresponding basis source.`,
      "contradiction.basis",
    ));
  }
  return issues;
}

function validatePredicateScope(
  predicate: Predicate,
  path: string,
  writable: ReadonlySet<string>,
  referenceable: ReadonlySet<string>,
  fieldSpecs: ReadonlyMap<string, StateFieldSpec>,
  entityKinds: ReadonlyMap<string, StateFieldSpec["appliesTo"][number]>,
  issues: ValidationIssue[],
): void {
  if (predicate.op === "all" || predicate.op === "any") {
    predicate.items.forEach((item, index) => validatePredicateScope(item, `${path}.items.${index}`, writable, referenceable, fieldSpecs, entityKinds, issues));
    return;
  }
  if (predicate.op === "not") {
    validatePredicateScope(predicate.item, `${path}.item`, writable, referenceable, fieldSpecs, entityKinds, issues);
    return;
  }
  if (predicate.op === "rule-active") {
    issues.push(issue("PLAYER_RULE_OBSERVATION_FORBIDDEN", "Actor-scoped action translation cannot inspect active world rules", path));
    return;
  }
  if (predicate.op === "after-step" || predicate.op === "before-step") {
    issues.push(issue("PLAYER_LOGICAL_TIME_OBSERVATION_FORBIDDEN", "Actor-scoped action translation cannot inspect engine logical time", path));
    return;
  }
  if (predicate.op === "elapsed-days-gte" || predicate.op === "elapsed-days-lte"
    || predicate.op === "story-time-at-or-after" || predicate.op === "story-time-before") {
    issues.push(issue("PLAYER_WORLD_TIME_OBSERVATION_FORBIDDEN", "Actor-scoped action translation cannot introduce an absolute world-time predicate", path));
    return;
  }
  if (!writable.has(predicate.entityId)) {
    issues.push(issue("PLAYER_PRECONDITION_OUT_OF_SCOPE", `Player action cannot inspect state for ${predicate.entityId}`, `${path}.entityId`));
  }
  const spec = fieldSpecs.get(predicate.field);
  if (!spec) {
    issues.push(issue("PLAYER_FIELD_OUT_OF_SCOPE", `Player action cannot inspect field ${predicate.field}`, `${path}.field`));
    return;
  }
  const entityKind = entityKinds.get(predicate.entityId);
  if (!entityKind || !spec.appliesTo.includes(entityKind)) {
    issues.push(issue("PLAYER_FIELD_OUT_OF_SCOPE", `Field ${predicate.field} does not apply to ${predicate.entityId}`, `${path}.field`));
    return;
  }
  if (predicate.op === "fact-equals") validateStateValueReferences(predicate.value, spec, `${path}.value`, referenceable, issues);
  if (predicate.op === "entity-in") requireReferenceable(predicate.member, `${path}.member`, referenceable, issues);
}

function validateStateValueReferences(
  value: StateValue,
  spec: StateFieldSpec,
  path: string,
  referenceable: ReadonlySet<string>,
  issues: ValidationIssue[],
): void {
  if (spec.valueType === "entity-ref" && typeof value === "string") requireReferenceable(value, path, referenceable, issues);
  if (spec.valueType === "entity-ref-set" && Array.isArray(value)) {
    value.forEach((entityId, index) => requireReferenceable(entityId, `${path}.${index}`, referenceable, issues));
  }
}

function requireReferenceable(
  entityId: string,
  path: string,
  referenceable: ReadonlySet<string>,
  issues: ValidationIssue[],
): void {
  if (!referenceable.has(entityId)) {
    issues.push(issue("PLAYER_ENTITY_OUT_OF_SCOPE", `Entity ${entityId} is not referenceable from the actor view`, path));
  }
}

function addExistingEntity(
  target: Set<EntityId>,
  value: unknown,
  entities: ReadonlyMap<EntityId, Entity>,
  sourceId?: string,
  knownIdentities?: Set<EntityId>,
): void {
  if (typeof value !== "string") return;
  const entity = entities.get(value);
  if (entity && evidenceBelongsExclusivelyToSource(entity.evidence, sourceId)) {
    target.add(value);
    knownIdentities?.add(value);
  }
}

function entityIdBelongsToSource(
  entityId: string,
  entities: ReadonlyMap<EntityId, Entity>,
  sourceId?: string,
): boolean {
  const entity = entities.get(entityId);
  return Boolean(entity && evidenceBelongsExclusivelyToSource(entity.evidence, sourceId));
}

function sourceSafeVisibleState(
  values: Readonly<Record<string, unknown>>,
  stateSchema: { get(field: string): StateFieldSpec },
  entities: ReadonlyMap<EntityId, Entity>,
  sourceId?: string,
): Record<string, StateValue> {
  const safe: Record<string, StateValue> = {};
  for (const [field, value] of Object.entries(values)) {
    let spec: StateFieldSpec;
    try {
      spec = stateSchema.get(field);
    } catch {
      continue;
    }
    if (spec.valueType === "entity-ref") {
      if (typeof value === "string" && entityIdBelongsToSource(value, entities, sourceId)) safe[field] = value;
      continue;
    }
    if (spec.valueType === "entity-ref-set") {
      if (Array.isArray(value)) {
        safe[field] = value.filter((item): item is string =>
          typeof item === "string" && entityIdBelongsToSource(item, entities, sourceId));
      }
      continue;
    }
    safe[field] = structuredClone(value) as StateValue;
  }
  return safe;
}

function sourceSafeClaimObject(
  value: unknown,
  entities: ReadonlyMap<EntityId, Entity>,
  sourceId?: string,
  depth = 0,
): unknown {
  if (typeof value === "string") {
    const entity = entities.get(value);
    return entity && !evidenceBelongsExclusivelyToSource(entity.evidence, sourceId)
      ? "[cross-source entity reference omitted]"
      : value;
  }
  if (depth >= 8) return "[nested data omitted]";
  if (Array.isArray(value)) return value.map((item) => sourceSafeClaimObject(item, entities, sourceId, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [key, sourceSafeClaimObject(item, entities, sourceId, depth + 1)]));
}

function claimObjectBelongsToSource(
  value: unknown,
  entities: ReadonlyMap<EntityId, Entity>,
  sourceId?: string,
  depth = 0,
): boolean {
  if (typeof value === "string") {
    const entity = entities.get(value);
    return !entity || evidenceBelongsExclusivelyToSource(entity.evidence, sourceId);
  }
  if (depth >= 8) return false;
  if (Array.isArray(value)) {
    return value.every((item) => claimObjectBelongsToSource(item, entities, sourceId, depth + 1));
  }
  if (!value || typeof value !== "object") return true;
  return Object.values(value as Record<string, unknown>)
    .every((item) => claimObjectBelongsToSource(item, entities, sourceId, depth + 1));
}

function addClaimObjectEntities(
  target: Set<EntityId>,
  value: unknown,
  entities: ReadonlyMap<EntityId, Entity>,
  sourceId?: string,
  knownIdentities?: Set<EntityId>,
  depth = 0,
): void {
  if (typeof value === "string") {
    addExistingEntity(target, value, entities, sourceId, knownIdentities);
    return;
  }
  if (depth >= 8) return;
  if (Array.isArray(value)) {
    for (const item of value) addClaimObjectEntities(target, item, entities, sourceId, knownIdentities, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const item of Object.values(value as Record<string, unknown>)) {
    addClaimObjectEntities(target, item, entities, sourceId, knownIdentities, depth + 1);
  }
}

function addStateEntityReferences(
  target: Set<EntityId>,
  values: Readonly<Record<string, unknown>>,
  stateSchema: { get(field: string): StateFieldSpec },
  entities: ReadonlyMap<EntityId, Entity>,
  sourceId?: string,
  knownIdentities?: Set<EntityId>,
): void {
  for (const [field, value] of Object.entries(values)) {
    const spec = stateSchema.get(field);
    if (spec.valueType === "entity-ref") {
      addExistingEntity(target, value, entities, sourceId, knownIdentities);
    } else if (spec.valueType === "entity-ref-set" && Array.isArray(value)) {
      for (const item of value) addExistingEntity(target, item, entities, sourceId, knownIdentities);
    }
  }
}

type VisiblePredicateEvaluation = { known: boolean; value: boolean };

function evaluateVisiblePredicate(
  predicate: Predicate,
  values: ReadonlyMap<string, Readonly<Record<string, StateValue>>>,
): VisiblePredicateEvaluation {
  if (predicate.op === "all" || predicate.op === "any") {
    const items = predicate.items.map((item) => evaluateVisiblePredicate(item, values));
    if (predicate.op === "all") {
      if (items.some((item) => item.known && !item.value)) return { known: true, value: false };
      return items.every((item) => item.known)
        ? { known: true, value: true }
        : { known: false, value: false };
    }
    if (items.some((item) => item.known && item.value)) return { known: true, value: true };
    return items.every((item) => item.known)
      ? { known: true, value: false }
      : { known: false, value: false };
  }
  if (predicate.op === "not") {
    const item = evaluateVisiblePredicate(predicate.item, values);
    return item.known ? { known: true, value: !item.value } : item;
  }
  if (predicate.op === "rule-active" || predicate.op === "after-step" || predicate.op === "before-step"
    || predicate.op === "elapsed-days-gte" || predicate.op === "elapsed-days-lte"
    || predicate.op === "story-time-at-or-after" || predicate.op === "story-time-before") {
    // These are rejected by the capability scope gate and are not visible
    // values that grounding should attempt to reinterpret.
    return { known: true, value: true };
  }
  const entity = values.get(predicate.entityId);
  if (!entity || !Object.hasOwn(entity, predicate.field)) return { known: false, value: false };
  const current = entity[predicate.field];
  if (predicate.op === "fact-exists") return { known: true, value: current !== undefined };
  if (predicate.op === "fact-equals") {
    return { known: true, value: JSON.stringify(current) === JSON.stringify(predicate.value) };
  }
  if (predicate.op === "fact-gte") return { known: typeof current === "number", value: typeof current === "number" && current >= predicate.value };
  if (predicate.op === "fact-lte") return { known: typeof current === "number", value: typeof current === "number" && current <= predicate.value };
  if (predicate.op !== "entity-in") return { known: false, value: false };
  return {
    known: true,
    value: Array.isArray(current) && current.includes(predicate.member),
  };
}

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, ...(path ? { path } : {}) };
}

async function latestCommittedStoryTime(engine: WorldEngine, commitId: CommitId): Promise<StoryTime | undefined> {
  const seen = new Set<string>();
  let cursor: CommitId | undefined = commitId;
  while (cursor) {
    if (seen.has(cursor)) throw new Error(`Commit ancestry cycle detected at ${cursor}`);
    seen.add(cursor);
    const commit = await engine.objects.getCommit(cursor);
    if (commit.logicalTime.storyTime && commit.logicalTime.storyTime.kind !== "unknown") {
      return structuredClone(commit.logicalTime.storyTime);
    }
    cursor = commit.parentCommitId;
  }
  return undefined;
}
