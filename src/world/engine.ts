import { validateActorOutcomeOwnership } from "./actor-outcome.js";
import { contentHash } from "./canonical.js";
import type { CharacterGoal, CharacterModel } from "./actors.js";
import {
  WORLD_ENGINE_VERSION,
  WORLD_SCHEMA_VERSION,
  actorEventObservationSchema,
  eventProposalSchema,
  knowledgeDeltaSchema,
  normDeltaSchema,
  participantPresenceSchema,
  stateDeltaSchema,
  type ActorEventObservation,
  type Attribution,
  type BranchEventRelation,
  type BranchEventRelationProposal,
  type BranchId,
  type CanonicalEvent,
  type Claim,
  type CommitId,
  type CommittedEvent,
  type Entity,
  type EntityId,
  type EvidenceRef,
  type EventProposal,
  type EventParticipation,
  type EventRelation,
  type KnowledgeDelta,
  type LogicalTime,
  type NormDelta,
  type ObjectHash,
  type ParticipantPresence,
  type Proposition,
  type ProgressCertificate,
  type ProcessDelta,
  type StateDelta,
  type ValidationIssue,
  type ValidationReport,
  type WorldRule,
  type WorldState,
} from "./model.js";
import type { PossibilityTemplate } from "./possibility-model.js";
import {
  StateSchemaRegistry,
  advanceTemporalState,
  applyStateDelta,
  emptyWorldState,
  evaluatePredicate,
  validateEngineInvariants,
  validateResourceConservation,
  validateResourcePolicyCatalog,
  type ResourceConservationPolicy,
} from "./state.js";
import { BranchStore, WorldObjectStore } from "./store.js";
import { nextLogicalTime } from "./time.js";
import { assertEvidenceExclusiveToSource } from "./source-scope.js";
import {
  canonicalAdaptationRoleRequirements,
  validateCanonicalAdaptationContract,
} from "./canonical-adaptation.js";
import { applyKnowledgeDelta, emptyKnowledgeState, isActionableKnowledge, KnowledgeProjector, type KnowledgeState } from "./knowledge.js";
import { isCommunicatingKnowledgeSource, validateKnowledgeSemanticReferences } from "./knowledge-semantics.js";
import { committedHistory, projectActorScene } from "./scene.js";
import type { SpatialRelation } from "./spatial-ontology.js";
import {
  isHardStateRule,
  isNormativeWorldRule,
  resolveEffectiveWorldRules,
  type EffectiveWorldRule,
} from "./world-rule-ontology.js";
import { ProjectionService, type ProjectionOptions, type WorldProjectionBundle } from "./projection-service.js";
import { WorldSnapshotStore } from "./snapshot.js";
import { deriveProgressCertificate, hasMaterialProgress } from "./progress.js";
import { resolveActionInvocation, type ActionSchema } from "./action-ontology.js";
import { normalizeActorProposal } from "./action-invocation.js";
import { validateEffectObligations } from "./effect-obligations.js";
import type { EventFrame } from "./event-frame.js";
import type { SceneOccurrence } from "./scene-occurrence.js";
import type { ActionConstraint } from "./action-constraint.js";
import { resolveActionConstraints, validateActionConstraintCatalog } from "./action-constraint.js";
import type { NormTemplate } from "./norm-ontology.js";
import type { ProcessTemplate } from "./process-ontology.js";
import { materializeProcessProposal, validateProcessTemplateCatalog } from "./process-ontology.js";
import { applyProcessDelta } from "./process-effects.js";
import { deriveAutomaticNormDelta, materializeNormProposal, validateNormTemplateCatalog } from "./norm-ontology.js";
import { applyNormDelta } from "./norm-effects.js";
import {
  applyBranchSemanticDelta,
  materializeBranchSemanticProposal,
  resolveSemanticKnowledgeRefs,
  type BranchSemanticState,
  type EffectProvenance,
} from "./semantic-effects.js";

export type WorldModelContext = {
  canonicalSnapshotHash?: ObjectHash;
  sourceId?: string;
  preparedRevisionHash?: string;
  entities: ReadonlyMap<EntityId, Entity>;
  propositions?: ReadonlyMap<string, Proposition>;
  attributions?: ReadonlyMap<string, Attribution>;
  rules: ReadonlyMap<string, WorldRule>;
  stateSchema: StateSchemaRegistry;
  claims?: ReadonlyMap<string, Claim>;
  events?: ReadonlyMap<string, CanonicalEvent>;
  eventParticipations?: readonly EventParticipation[];
  eventRelations?: readonly EventRelation[];
  spatialOntologyVersion?: "spatial-v1";
  spatialRelations?: readonly SpatialRelation[];
  sceneOccurrences?: readonly SceneOccurrence[];
  eventFrames?: ReadonlyMap<string, EventFrame>;
  actionSchemas?: ReadonlyMap<string, ActionSchema>;
  actionConstraints?: ReadonlyMap<string, ActionConstraint>;
  normTemplates?: ReadonlyMap<string, NormTemplate>;
  processTemplates?: ReadonlyMap<string, ProcessTemplate>;
  resourcePolicies?: readonly ResourceConservationPolicy[];
  actorGoals?: readonly CharacterGoal[];
  actorModels?: ReadonlyMap<string, CharacterModel>;
  possibilityTemplates?: readonly PossibilityTemplate[];
};

export type ResolvedWorldModelContext = WorldModelContext & { canonicalSnapshotHash: ObjectHash };
export type WorldContextResolver = (snapshotHash: ObjectHash) => Promise<WorldModelContext>;

export class WorldProjector {
  private readonly projections: ProjectionService;
  constructor(projections: ProjectionService);
  constructor(objects: WorldObjectStore, context: WorldModelContext);
  constructor(objects: WorldObjectStore, contextForSnapshot: (snapshotHash?: ObjectHash) => Promise<ResolvedWorldModelContext>);
  constructor(
    sourceOrObjects: ProjectionService | WorldObjectStore,
    source?: WorldModelContext | ((snapshotHash?: ObjectHash) => Promise<ResolvedWorldModelContext>),
  ) {
    if (sourceOrObjects instanceof ProjectionService) {
      this.projections = sourceOrObjects;
    } else if (typeof source === "function") {
      this.projections = new ProjectionService(sourceOrObjects, source);
    } else {
      if (!source) throw new Error("WorldProjector requires a model context");
      const context = resolveContext(source);
      this.projections = new ProjectionService(sourceOrObjects, async (snapshotHash) => {
        if (snapshotHash && snapshotHash !== context.canonicalSnapshotHash) throw new Error(`Canonical snapshot is not available: ${snapshotHash}`);
        return context;
      });
    }
  }
  async project(commitId: CommitId, options: ProjectionOptions = {}): Promise<WorldState> {
    return (await this.projections.project(commitId, options)).state;
  }
}

function stateFactsChanged(before: WorldState, after: WorldState): boolean {
  return contentHash({ values: before.values, activeRuleIds: before.activeRuleIds })
    !== contentHash({ values: after.values, activeRuleIds: after.activeRuleIds });
}

function hasNonStateMateriality(proposal: EventProposal, timeChanged: boolean): boolean {
  return timeChanged
    || Boolean(proposal.proposedKnowledge?.operations.length)
    || Boolean(proposal.proposedSemantics?.operations.length)
    || Boolean(proposal.proposedProcesses?.operations.length)
    || Boolean(proposal.proposedNorms?.operations.length)
    || Boolean(proposal.spokenUtterances?.length)
    || Boolean(proposal.progress?.scene);
}

export function validateEventProposal(
  proposalInput: EventProposal,
  head: CommitId,
  state: WorldState,
  context: WorldModelContext,
  options: { branchSemantics?: BranchSemanticState; deferMateriality?: boolean; realizedCanonicalEventIds?: ReadonlySet<string> } = {},
): { report: ValidationReport; postState?: WorldState } {
  const proposal = normalizeActorProposal(eventProposalSchema.parse(proposalInput));
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  if (proposal.expectedParentCommit !== head) errors.push({ code: "STALE_PARENT", message: `Expected ${proposal.expectedParentCommit}, current head is ${head}` });
  if (state.atCommit !== head) errors.push({ code: "STATE_HEAD_MISMATCH", message: `Projected state ${state.atCommit} does not match ${head}` });
  for (const entityId of proposal.participants) if (!context.entities.has(entityId)) errors.push({ code: "UNKNOWN_PARTICIPANT", message: `Unknown participant ${entityId}` });
  if (proposal.actorId && !context.entities.has(proposal.actorId)) errors.push({ code: "UNKNOWN_ACTOR", message: `Unknown actor ${proposal.actorId}` });
  proposal.spokenUtterances?.forEach((utterance, index) => {
    const speaker = context.entities.get(utterance.speakerId);
    if (!speaker || speaker.kind !== "character") {
      errors.push({
        code: "INVALID_SPOKEN_UTTERANCE",
        message: `Spoken utterance speaker ${utterance.speakerId} must be a character`,
        path: `spokenUtterances.${index}.speakerId`,
      });
    }
    utterance.addresseeIds.forEach((addresseeId, addresseeIndex) => {
      const addressee = context.entities.get(addresseeId);
      if (!addressee || addressee.kind !== "character") {
        errors.push({
          code: "INVALID_SPOKEN_UTTERANCE",
          message: `Spoken utterance addressee ${addresseeId} must be a character`,
          path: `spokenUtterances.${index}.addresseeIds.${addresseeIndex}`,
        });
      }
    });
  });
  const presenceIds = new Set<string>();
  for (let index = 0; index < (proposal.participantPresence?.length ?? 0); index += 1) {
    const presence = proposal.participantPresence![index]!;
    const entity = context.entities.get(presence.entityId);
    if (!entity || entity.kind !== "character") {
      errors.push({
        code: "INVALID_PARTICIPANT_PRESENCE",
        message: `Participant presence ${presence.entityId} must refer to a character`,
        path: `participantPresence.${index}.entityId`,
      });
    }
    if (!proposal.participants.includes(presence.entityId)) {
      errors.push({
        code: "PARTICIPANT_PRESENCE_NOT_PARTICIPANT",
        message: `Participant presence ${presence.entityId} is not in participants`,
        path: `participantPresence.${index}.entityId`,
      });
    }
    if (presenceIds.has(presence.entityId)) {
      errors.push({
        code: "DUPLICATE_PARTICIPANT_PRESENCE",
        message: `Participant presence ${presence.entityId} is duplicated`,
        path: `participantPresence.${index}.entityId`,
      });
    }
    presenceIds.add(presence.entityId);
  }
  const observedActors = new Set<string>();
  for (let index = 0; index < (proposal.actorObservations?.length ?? 0); index += 1) {
    const observation = proposal.actorObservations![index]!;
    const observer = context.entities.get(observation.actorId);
    if (!observer || observer.kind !== "character") {
      errors.push({ code: "INVALID_EVENT_OBSERVER", message: `Event observer ${observation.actorId} is not a character`, path: `actorObservations.${index}.actorId` });
    }
    if (!proposal.participants.includes(observation.actorId)) {
      errors.push({ code: "INVALID_EVENT_OBSERVER", message: `Event observer ${observation.actorId} must also be a participant`, path: `actorObservations.${index}.actorId` });
    }
    if (observedActors.has(observation.actorId)) {
      errors.push({ code: "DUPLICATE_EVENT_OBSERVER", message: `Event observer ${observation.actorId} has more than one summary`, path: `actorObservations.${index}.actorId` });
    }
    observedActors.add(observation.actorId);
  }
  const affectedActors = new Set<string>();
  for (let index = 0; index < (proposal.actorAffects?.length ?? 0); index += 1) {
    const affect = proposal.actorAffects![index]!;
    const actor = context.entities.get(affect.actorId);
    if (!actor || actor.kind !== "character") {
      errors.push({ code: "INVALID_EVENT_AFFECT_ACTOR", message: `Event affect actor ${affect.actorId} is not a character`, path: `actorAffects.${index}.actorId` });
    }
    if (!proposal.participants.includes(affect.actorId)) {
      errors.push({ code: "INVALID_EVENT_AFFECT_ACTOR", message: `Event affect actor ${affect.actorId} must also be a participant`, path: `actorAffects.${index}.actorId` });
    }
    if (affectedActors.has(affect.actorId)) {
      errors.push({ code: "DUPLICATE_EVENT_AFFECT_ACTOR", message: `Event affect actor ${affect.actorId} has more than one affect`, path: `actorAffects.${index}.actorId` });
    }
    affectedActors.add(affect.actorId);
  }
  let evaluationState = state;
  try {
    const logicalTime = nextLogicalTime(state.logicalTime, proposal.proposedTime, proposal.timeAdvance);
    evaluationState = advanceTemporalState(state, logicalTime, context.stateSchema, context.entities);
  } catch (error) {
    errors.push({ code: "INVALID_WORLD_TIME", message: error instanceof Error ? error.message : String(error), path: "proposedTime" });
  }
  if (proposal.actorId && evaluationState.values[proposal.actorId]?.["character.alive"] === false) errors.push({ code: "ACTOR_DEAD", message: `Actor ${proposal.actorId} is not alive` });
  for (let index = 0; index < (proposal.supersedesCanonicalEventIds?.length ?? 0); index += 1) {
    const eventId = proposal.supersedesCanonicalEventIds![index]!;
    if (!context.events?.has(eventId)) errors.push({ code: "UNKNOWN_SUPERSEDED_CANONICAL_EVENT", message: `Unknown superseded canonical event ${eventId}`, path: `supersedesCanonicalEventIds.${index}` });
  }
  errors.push(...validateCanonicalAdaptationContract(proposal, context));
  for (let index = 0; index < proposal.preconditions.length; index += 1) {
    if (!evaluatePredicate(evaluationState, proposal.preconditions[index]!)) errors.push({ code: "PRECONDITION_FAILED", message: `Precondition ${index} is false`, path: `preconditions.${index}` });
  }
  if (proposal.action) {
    const resolvedAction = resolveActionInvocation(
      proposal.action,
      context.actionSchemas ?? new Map(),
      context.entities,
      {
        participants: proposal.participants,
        proposedDelta: proposal.proposedDelta,
        hasKnowledge: Boolean(proposal.proposedKnowledge?.operations.length),
        hasTimeAdvance: Boolean(proposal.timeAdvance),
        hasSceneTransition: Boolean(proposal.progress?.scene),
        proposalPreconditions: proposal.preconditions,
      },
    );
    errors.push(...resolvedAction.issues);
    resolvedAction.preconditions.forEach((predicate, index) => {
      if (!evaluatePredicate(evaluationState, predicate)) {
        errors.push({
          code: "ACTION_SCHEMA_PRECONDITION_FAILED",
          message: `Action schema precondition ${index} is false`,
          path: `action.preconditions.${index}`,
        });
      }
    });
  }
  if (proposal.proposedKnowledge) {
    const knowledge = knowledgeDeltaSchema.parse(proposal.proposedKnowledge);
    for (let index = 0; index < knowledge.operations.length; index += 1) {
      const operation = knowledge.operations[index]!;
      const actor = context.entities.get(operation.actorId);
      if (!actor || actor.kind !== "character") errors.push({ code: "INVALID_KNOWLEDGE_ACTOR", message: `Knowledge actor ${operation.actorId} is not a character`, path: `proposedKnowledge.operations.${index}` });
      const requiresCataloguedClaim = Boolean(context.claims)
        || Boolean(operation.propositionId)
        || (operation.op === "learn" && Boolean(operation.attributionId));
      if (requiresCataloguedClaim
        && !context.claims?.has(operation.claimId)
        && !options.branchSemantics?.claims[operation.claimId]) {
        errors.push({ code: "UNKNOWN_KNOWLEDGE_CLAIM", message: `Unknown claim ${operation.claimId}`, path: `proposedKnowledge.operations.${index}` });
      }
      if (operation.op === "learn") {
        if (operation.sourceActorId) {
          const source = context.entities.get(operation.sourceActorId);
          if (!isCommunicatingKnowledgeSource(source)) errors.push({ code: "INVALID_KNOWLEDGE_SOURCE", message: `Knowledge source ${operation.sourceActorId} is not a character or communication system`, path: `proposedKnowledge.operations.${index}` });
        }
      }
      errors.push(...validateKnowledgeSemanticReferences(operation, {
        claims: context.claims ?? new Map(),
        propositions: context.propositions,
        attributions: context.attributions,
        ...(options.branchSemantics ? { branchSemantics: options.branchSemantics } : {}),
      }, `proposedKnowledge.operations.${index}`));
    }
  }

  const applicableRules: EffectiveWorldRule[] = [];
  for (const ruleId of evaluationState.activeRuleIds) {
    if (!context.rules.has(ruleId)) {
      errors.push({ code: "UNKNOWN_ACTIVE_RULE", message: `Active rule ${ruleId} is not in the model` });
    }
  }
  if (!errors.some((error) => error.code === "UNKNOWN_ACTIVE_RULE")) {
    applicableRules.push(...resolveEffectiveWorldRules(context.rules, evaluationState).effective);
    for (const rule of applicableRules.filter((candidate) => isHardStateRule(candidate.rule))) {
      if (rule.requires.some((predicate) => !evaluatePredicate(evaluationState, predicate))) {
        errors.push({ code: "STATE_RULE_REQUIREMENT_FAILED", message: `State rule ${rule.id} requirement is not satisfied` });
      }
    }
  }

  let postState: WorldState | undefined;
  let stateChanged = false;
  if (!errors.length) {
    try {
      const delta = stateDeltaSchema.parse(proposal.proposedDelta);
      postState = applyStateDelta(evaluationState, delta, context.stateSchema, context.entities, context.rules);
      errors.push(...validateEffectObligations({ proposal, before: state, after: postState, context,
        realizedCanonicalEventIds: options.realizedCanonicalEventIds }));
      for (const message of validateEngineInvariants(postState, context.stateSchema, context.entities, context.rules)) errors.push({ code: "POST_STATE_INVARIANT", message });
      for (const rule of applicableRules.filter((candidate) => isHardStateRule(candidate.rule))) {
        const forbidden = rule.forbids.some((predicate) => evaluatePredicate(postState!, predicate));
        if (forbidden) {
          errors.push({ code: "STATE_RULE_FORBIDS", message: `State rule ${rule.id} forbids the proposed post-state` });
        }
      }
      errors.push(...resolveActionConstraints(context.actionConstraints?.values() ?? [], {
        invocation: proposal.action,
        actorId: proposal.actorId,
        before: evaluationState,
        after: postState,
      }).issues);
      for (const message of validateResourceConservation(evaluationState, postState, context.resourcePolicies ?? [])) {
        errors.push({ code: "RESOURCE_CONSERVATION_FAILED", message });
      }
      stateChanged = stateFactsChanged(evaluationState, postState);
      const timeChanged = (postState.logicalTime.elapsedDays ?? 0) > (state.logicalTime.elapsedDays ?? 0)
        || JSON.stringify(postState.logicalTime.storyTime) !== JSON.stringify(state.logicalTime.storyTime);
      const hasKnowledgeEffect = Boolean(proposal.proposedKnowledge?.operations.length);
      if (!stateChanged && !hasNonStateMateriality(proposal, timeChanged) && !options.deferMateriality) {
        errors.push({
          code: "EVENT_MATERIALITY_REQUIRED",
          message: "A committed event requires a net state or knowledge effect, an utterance, an adjudicated action outcome, effective time advancement, or a validated scene beat.",
        });
      }
      if (proposal.progress?.channels.includes("state") && !stateChanged) {
        errors.push({ code: "FALSE_STATE_PROGRESS", message: "Progress claims a state change, but the proposed delta leaves projected state unchanged." });
      }
      if (proposal.progress?.channels.includes("knowledge") && !hasKnowledgeEffect) {
        errors.push({ code: "FALSE_KNOWLEDGE_PROGRESS", message: "Progress claims a knowledge change, but the proposal contains no knowledge operation." });
      }
    } catch (error) {
      errors.push({ code: "INVALID_DELTA", message: error instanceof Error ? error.message : String(error) });
    }
  }
  const report: ValidationReport = {
    proposalId: proposal.proposalId,
    evaluatedAtCommit: head,
    accepted: errors.length === 0,
    errors,
    warnings,
    ...(errors.length === 0 && stateChanged ? { derivedDeltaHash: contentHash(proposal.proposedDelta) } : {}),
  };
  return { report, postState: report.accepted ? postState : undefined };
}

export type CommitProposalResult = {
  report: ValidationReport;
  previousHead: CommitId;
  newHead: CommitId;
  eventHash?: string;
  progressCertificate?: ProgressCertificate;
};

export class WorldEngine {
  readonly workspaceRoot: string;
  readonly objects: WorldObjectStore;
  readonly branches: BranchStore;
  readonly projections: ProjectionService;
  readonly projector: WorldProjector;
  readonly context: ResolvedWorldModelContext;
  private readonly contextCache = new Map<ObjectHash, ResolvedWorldModelContext>();
  constructor(workspaceRoot: string, context: WorldModelContext, private readonly contextResolver?: WorldContextResolver) {
    this.workspaceRoot = workspaceRoot;
    this.objects = new WorldObjectStore(this.workspaceRoot);
    this.branches = new BranchStore(this.workspaceRoot);
    this.context = resolveContext(context);
    this.contextCache.set(this.context.canonicalSnapshotHash, this.context);
    this.projections = new ProjectionService(
      this.objects,
      (snapshotHash) => this.contextForSnapshot(snapshotHash),
      new WorldSnapshotStore(this.workspaceRoot),
    );
    this.projector = new WorldProjector(this.projections);
  }
  async contextForCommit(commitId: CommitId): Promise<ResolvedWorldModelContext> {
    const commit = await this.objects.getCommit(commitId);
    return this.contextForSnapshot(commit.canonicalSnapshotHash);
  }
  async createBranch(
    branchId: BranchId,
    name: string,
    initialDelta: StateDelta = { version: 1, operations: [] },
    initialKnowledge?: KnowledgeDelta,
    sourceId?: string,
    preparedRevisionHash?: string,
    initialEvidence: readonly EvidenceRef[] = [],
    initialTime: Omit<LogicalTime, "step"> = {},
    genesisOptions: {
      entryActorId?: EntityId;
      realizesCanonicalEventIds?: readonly string[];
      participantPresence?: readonly ParticipantPresence[];
      actorObservations?: readonly ActorEventObservation[];
    } = {},
  ): Promise<CommitId> {
    if (sourceId && this.context.sourceId && sourceId !== this.context.sourceId) {
      throw new Error(`Cannot create source '${sourceId}' branch from '${this.context.sourceId}' world context.`);
    }
    if (preparedRevisionHash && this.context.preparedRevisionHash && preparedRevisionHash !== this.context.preparedRevisionHash) {
      throw new Error(`Prepared revision ${preparedRevisionHash} does not match captured context ${this.context.preparedRevisionHash}.`);
    }
    const branchSourceId = sourceId ?? this.context.sourceId;
    const branchPreparedRevisionHash = preparedRevisionHash ?? this.context.preparedRevisionHash;
    if (branchPreparedRevisionHash && !branchSourceId) {
      throw new Error("A frozen prepared revision requires a source identity.");
    }
    if (branchSourceId && initialEvidence.length) {
      assertEvidenceExclusiveToSource(initialEvidence, branchSourceId, "Genesis evidence");
    }
    stateDeltaSchema.parse(initialDelta);
    const knowledge = initialKnowledge ? knowledgeDeltaSchema.parse(initialKnowledge) : undefined;
    if (knowledge) validateKnowledgeDeltaForContext(knowledge, this.context);
    const logicalTime: LogicalTime = { step: 0, ...initialTime };
    if (genesisOptions.entryActorId) {
      const entryActor = this.context.entities.get(genesisOptions.entryActorId);
      if (!entryActor || entryActor.kind !== "character") {
        throw new Error(`Genesis entry actor is not a character: ${genesisOptions.entryActorId}`);
      }
    }
    const suppliedPresence = (genesisOptions.participantPresence ?? [])
      .map((presence) => participantPresenceSchema.parse(presence));
    if (suppliedPresence.length > 128) throw new Error("Genesis participant presence exceeds 128 entries.");
    if (
      genesisOptions.entryActorId
      && suppliedPresence.length
      && !suppliedPresence.some((presence) =>
        presence.entityId === genesisOptions.entryActorId && presence.mode === "physical")
    ) {
      throw new Error(`Genesis entry actor ${genesisOptions.entryActorId} must be physically present at its entry checkpoint.`);
    }
    const participantPresence = suppliedPresence.length
      ? suppliedPresence
      : genesisOptions.entryActorId
        ? [{ entityId: genesisOptions.entryActorId, mode: "physical" as const }]
        : [];
    const presenceIds = new Set<string>();
    for (const presence of participantPresence) {
      const entity = this.context.entities.get(presence.entityId);
      if (!entity || entity.kind !== "character") {
        throw new Error(`Genesis presence entity is not a character: ${presence.entityId}`);
      }
      if (presenceIds.has(presence.entityId)) throw new Error(`Genesis presence is duplicated: ${presence.entityId}`);
      presenceIds.add(presence.entityId);
    }
    const actorObservations = (genesisOptions.actorObservations ?? [])
      .map((observation) => actorEventObservationSchema.parse(observation));
    if (actorObservations.length > 128) throw new Error("Genesis actor observations exceed 128 entries.");
    const observationActors = new Set<string>();
    for (const observation of actorObservations) {
      const actor = this.context.entities.get(observation.actorId);
      if (!actor || actor.kind !== "character") {
        throw new Error(`Genesis observer is not a character: ${observation.actorId}`);
      }
      if (observationActors.has(observation.actorId)) {
        throw new Error(`Genesis observer is duplicated: ${observation.actorId}`);
      }
      observationActors.add(observation.actorId);
    }
    const emptyInitialState = { ...emptyWorldState("genesis", 0), logicalTime };
    const initialState = applyStateDelta(
      emptyInitialState,
      initialDelta,
      this.context.stateSchema,
      this.context.entities,
      this.context.rules,
    );
    const invariantErrors = validateEngineInvariants(initialState, this.context.stateSchema, this.context.entities, this.context.rules);
    if (invariantErrors.length) throw new Error(`Invalid initial world state: ${invariantErrors.join("; ")}`);
    const deltaHash = stateFactsChanged(emptyInitialState, initialState)
      ? await this.objects.putDelta(initialDelta)
      : undefined;
    const effectiveInitialKnowledgeIndexes = knowledge
      ? effectiveKnowledgeOperationIndexes(emptyKnowledgeState("genesis"), knowledge)
      : [];
    const knowledgeDeltaHash = knowledge && effectiveInitialKnowledgeIndexes.length
      ? await this.objects.putKnowledgeDelta(knowledge)
      : undefined;
    const effects: CommittedEvent["effects"] = {
      version: 1,
      ...(deltaHash ? { stateDeltaHash: deltaHash } : {}),
      ...(knowledgeDeltaHash ? { knowledgeDeltaHash } : {}),
    };
    const progressCertificate = deriveProgressCertificate({
      effects,
      loaded: {
        ...(deltaHash ? { stateDelta: initialDelta } : {}),
        ...(knowledgeDeltaHash && knowledge ? { knowledgeDelta: knowledge } : {}),
      },
      effectiveStateOperationIndexes: deltaHash
        ? effectiveStateOperationIndexes(emptyInitialState, initialDelta, this.context)
        : [],
      effectiveKnowledgeOperationIndexes: effectiveInitialKnowledgeIndexes,
      utteranceCount: 0,
      timeAdvanced: false,
    });
    const inferredRealizations = [...(this.context.events?.values() ?? [])]
      .filter((event) => canonicalEventSatisfiedAtGenesis(event, initialState, knowledge, this.context.eventRelations ?? []))
      .map((event) => event.id);
    const realizesCanonicalEventIds = [...new Set([
      ...inferredRealizations,
      ...(genesisOptions.realizesCanonicalEventIds ?? []),
    ])].sort();
    for (const eventId of realizesCanonicalEventIds) {
      if (!this.context.events?.has(eventId)) throw new Error(`Genesis realizes unknown canonical event: ${eventId}`);
    }
    const evidence: EvidenceRef[] = structuredClone([...initialEvidence]);
    const eventId = contentHash({
      kind: "genesis",
      branchId,
      logicalTime,
      effects,
      progressCertificate,
      realizesCanonicalEventIds,
      evidence,
      entryActorId: genesisOptions.entryActorId,
      participantPresence,
      actorObservations,
    });
    const participants = [...new Set([
      ...touchedEntities(initialDelta),
      ...touchedKnowledgeEntities(knowledge),
      ...participantPresence.map((presence) => presence.entityId),
      ...actorObservations.map((observation) => observation.actorId),
      ...(genesisOptions.entryActorId ? [genesisOptions.entryActorId] : []),
    ])].sort();
    const event: CommittedEvent = {
      version: 2,
      eventId,
      branchId,
      logicalTime,
      title: "Genesis",
      ...(actorObservations.length ? { actorObservations } : {}),
      participants,
      ...(participantPresence.length ? { participantPresence } : {}),
      effects,
      progressCertificate,
      evidence,
      causalRelations: [],
      causalParents: [],
      ...(realizesCanonicalEventIds.length ? { realizesCanonicalEventIds } : {}),
    };
    const eventHash = await this.objects.putEvent(event);
    const commitHash = await this.objects.putCommit({ version: 1, branchId, logicalTime, eventHashes: [eventHash], canonicalSnapshotHash: this.context.canonicalSnapshotHash, engineVersion: WORLD_ENGINE_VERSION, schemaVersion: WORLD_SCHEMA_VERSION });
    await this.branches.create({
      id: branchId,
      name,
      ...(branchSourceId ? { sourceId: branchSourceId } : {}),
      ...(branchPreparedRevisionHash ? { preparedRevisionHash: branchPreparedRevisionHash } : {}),
      ...(genesisOptions.entryActorId && branchSourceId && branchPreparedRevisionHash
        ? { entryActorId: genesisOptions.entryActorId }
        : {}),
      createdAt: new Date().toISOString(),
      headCommitId: commitHash,
    });
    return commitHash;
  }
  async previewProposal(proposal: EventProposal): Promise<CommitProposalResult> {
    return this.evaluateProposal(proposal, false);
  }

  async commitProposal(proposal: EventProposal): Promise<CommitProposalResult> {
    return this.evaluateProposal(proposal, true);
  }

  private async evaluateProposal(proposal: EventProposal, persist: boolean): Promise<CommitProposalResult> {
    let parsed = normalizeActorProposal(eventProposalSchema.parse(proposal));
    const branch = await this.branches.read(parsed.branchId);
    const head = branch.headCommitId;
    const context = await this.contextForCommit(head);
    if (branch.sourceId && context.sourceId && branch.sourceId !== context.sourceId) {
      throw new Error(`Branch source '${branch.sourceId}' does not match committed context '${context.sourceId}'.`);
    }
    if (
      branch.preparedRevisionHash
      && branch.preparedRevisionHash !== context.preparedRevisionHash
    ) {
      throw new Error(
        `Branch '${branch.id}' is frozen to prepared revision ${branch.preparedRevisionHash}, `
        + `but commit ${head} resolves ${context.preparedRevisionHash ?? "no prepared revision"}.`,
      );
    }
    const sourceId = branch.sourceId ?? context.sourceId;
    if (sourceId && parsed.evidence.length) {
      assertEvidenceExclusiveToSource(parsed.evidence, sourceId, `Event proposal ${parsed.proposalId}`);
    }
    const projection = await this.projections.project(head);
    const state = projection.state;
    const causalRelationProposals = normalizedCausalRelationProposals(parsed, projection);
    const causalRelationErrors = validateBranchCausalRelationProposals(
      causalRelationProposals,
      parsed,
      projection,
      context,
    );
    let semanticDelta: import("./model.js").BranchSemanticDelta | undefined;
    let stagedSemantics = projection.semantics;
    const semanticErrors: ValidationIssue[] = validateActorOutcomeOwnership(parsed, projection);
    if (parsed.proposedSemantics) {
      try {
        const materialized = materializeBranchSemanticProposal(parsed.proposedSemantics, {
          branchId: parsed.branchId,
          parentCommitId: head,
          proposalHash: contentHash({
            proposalId: parsed.proposalId,
            branchId: parsed.branchId,
            parentCommitId: head,
            proposedSemantics: parsed.proposedSemantics,
          }),
        });
        semanticDelta = materialized.delta;
        if (parsed.proposedKnowledge) {
          parsed = eventProposalSchema.parse({
            ...parsed,
            proposedKnowledge: resolveSemanticKnowledgeRefs(parsed.proposedKnowledge, materialized.localBindings),
          });
        }
        const provisionalProvenance: EffectProvenance = {
          commitId: head,
          eventId: "pending-event",
          eventHash: "0".repeat(64),
        };
        stagedSemantics = applyBranchSemanticDelta(projection.semantics, semanticDelta, {
          entities: context.entities,
          canonicalPropositionIds: context.propositions ? new Set(context.propositions.keys()) : undefined,
          canonicalAttributionIds: context.attributions ? new Set(context.attributions.keys()) : undefined,
          canonicalClaimIds: context.claims ? new Set(context.claims.keys()) : undefined,
          canonicalGoalIds: context.actorGoals ? new Set(context.actorGoals.map((goal) => goal.id)) : undefined,
          canonicalEventIds: context.events ? new Set(context.events.keys()) : undefined,
          knownCommittedEventIds: new Set(Object.keys(projection.causality.events)),
        }, provisionalProvenance);
        if (parsed.proposedKnowledge) {
          applyKnowledgeDelta(projection.knowledge, parsed.proposedKnowledge, head, {
            entities: context.entities,
            claims: context.claims,
            propositions: context.propositions,
            attributions: context.attributions,
            branchSemantics: stagedSemantics,
          });
        }
      } catch (error) {
        semanticErrors.push({
          code: "INVALID_SEMANTIC_DELTA",
          message: error instanceof Error ? error.message : String(error),
          path: "proposedSemantics",
        });
      }
    }
    const { report: baseReport, postState } = validateEventProposal(parsed, head, state, context, {
      branchSemantics: stagedSemantics,
      deferMateriality: true,
      realizedCanonicalEventIds: new Set(projection.history.flatMap((entry) => entry.event.realizesCanonicalEventIds ?? [])),
    });
    let report = baseReport;
    if (semanticErrors.length || causalRelationErrors.length) {
      const { derivedDeltaHash: _derivedDeltaHash, ...withoutDerivedHash } = report;
      report = {
        ...withoutDerivedHash,
        accepted: false,
        errors: [...report.errors, ...semanticErrors, ...causalRelationErrors],
      };
    }
    let processDelta: ProcessDelta | undefined;
    let normDelta: NormDelta | undefined;
    if (report.accepted && postState) {
      const effectErrors: ValidationIssue[] = [];
      const provisionalProvenance: EffectProvenance = {
        commitId: head,
        eventId: "pending-event",
        eventHash: "0".repeat(64),
      };
      try {
        if (parsed.proposedProcesses) {
          processDelta = materializeProcessProposal(parsed.proposedProcesses, {
            branchId: parsed.branchId,
            parentCommitId: head,
            elapsedDays: postState.logicalTime.elapsedDays ?? 0,
            templates: context.processTemplates ?? new Map(),
            proposalHash: contentHash({
              proposalId: parsed.proposalId,
              branchId: parsed.branchId,
              parentCommitId: head,
              proposedProcesses: parsed.proposedProcesses,
            }),
          }).delta;
          applyProcessDelta(
            projection.processes,
            processDelta,
            { entities: context.entities, templates: context.processTemplates ?? new Map() },
            provisionalProvenance,
            postState.logicalTime.elapsedDays ?? 0,
          );
        }
      } catch (error) {
        effectErrors.push({
          code: "INVALID_PROCESS_DELTA",
          message: error instanceof Error ? error.message : String(error),
          path: "proposedProcesses",
        });
      }
      try {
        let stagedNorms = projection.norms;
        let proposedNormDelta: NormDelta | undefined;
        if (parsed.proposedNorms) {
          proposedNormDelta = materializeNormProposal(parsed.proposedNorms, {
            branchId: parsed.branchId,
            parentCommitId: head,
            elapsedDays: postState.logicalTime.elapsedDays ?? 0,
            templates: context.normTemplates ?? new Map(),
            proposalHash: contentHash({
              proposalId: parsed.proposalId,
              branchId: parsed.branchId,
              parentCommitId: head,
              proposedNorms: parsed.proposedNorms,
            }),
          }).delta;
          stagedNorms = applyNormDelta(stagedNorms, proposedNormDelta, {
            entities: context.entities,
            templates: context.normTemplates ?? new Map(),
            normativeRuleIds: new Set([...context.rules.values()].filter(isNormativeWorldRule).map((rule) => rule.id)),
            ...(parsed.action ? { action: parsed.action } : {}),
            postState,
          }, provisionalProvenance);
        }
        const stateBeforeDelta = advanceTemporalState(state, postState.logicalTime, context.stateSchema, context.entities);
        const automatic = deriveAutomaticNormDelta({
          branchId: parsed.branchId,
          parentCommitId: head,
          ...(parsed.actorId ? { actorId: parsed.actorId } : {}),
          ...(parsed.action ? { action: parsed.action } : {}),
          before: stateBeforeDelta,
          after: postState,
          state: stagedNorms,
          templates: context.normTemplates ?? new Map(),
          normativeRules: resolveEffectiveWorldRules(context.rules, stateBeforeDelta).effective
            .filter((rule) => isNormativeWorldRule(rule.rule)),
        });
        normDelta = proposedNormDelta || automatic
          ? normDeltaSchema.parse({
            version: 1,
            operations: [
              ...(proposedNormDelta?.operations ?? []),
              ...(automatic?.operations ?? []),
            ],
          })
          : undefined;
        if (automatic) {
          applyNormDelta(stagedNorms, automatic, {
            entities: context.entities,
            templates: context.normTemplates ?? new Map(),
            normativeRuleIds: new Set([...context.rules.values()].filter(isNormativeWorldRule).map((rule) => rule.id)),
            ...(parsed.action ? { action: parsed.action } : {}),
            postState,
          }, provisionalProvenance);
        }
      } catch (error) {
        effectErrors.push({
          code: "INVALID_NORM_DELTA",
          message: error instanceof Error ? error.message : String(error),
          path: "proposedNorms",
        });
      }
      if (effectErrors.length) {
        const { derivedDeltaHash: _derivedDeltaHash, ...withoutDerivedHash } = report;
        report = { ...withoutDerivedHash, accepted: false, errors: [...report.errors, ...effectErrors] };
      }
    }
    if (parsed.canonicalAdaptation) {
      const runtimeErrors: ValidationIssue[] = [];
      const sceneActor = context.entities.get(parsed.canonicalAdaptation.sceneActorId);
      const [knowledge, history, scene] = await Promise.all([
        new KnowledgeProjector(this).project(head),
        committedHistory(this, head),
        sceneActor?.kind === "character"
          ? projectActorScene(this, sceneActor.id, head).catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      if (!sceneActor || sceneActor.kind !== "character" || !scene) {
        runtimeErrors.push({
          code: "INVALID_CANONICAL_ADAPTATION_SCENE_ACTOR",
          message: `Canonical adaptation scene anchor ${parsed.canonicalAdaptation.sceneActorId} is not an available character`,
          path: "canonicalAdaptation.sceneActorId",
        });
      }
      const availableEntityIds = new Set<string>([
        ...Object.keys(state.values),
        ...history.flatMap(({ event }) => event.participants),
      ]);
      const fulfilledCausalIds = new Set<string>();
      for (const { event } of history) {
        fulfilledCausalIds.add(event.eventId);
        if (event.possibilityId) fulfilledCausalIds.add(event.possibilityId);
        for (const eventId of event.realizesCanonicalEventIds ?? []) {
          fulfilledCausalIds.add(eventId);
          fulfilledCausalIds.add(`canon-${eventId}`);
        }
        if (event.canonicalAdaptation) {
          fulfilledCausalIds.add(event.canonicalAdaptation.adaptedFromCanonicalEventId);
          fulfilledCausalIds.add(`canon-${event.canonicalAdaptation.adaptedFromCanonicalEventId}`);
        }
      }
      for (const parent of parsed.causalParents) {
        if (!fulfilledCausalIds.has(parent) && !fulfilledCausalIds.has(`canon-${parent}`)) {
          runtimeErrors.push({
            code: "CANONICAL_ADAPTATION_CAUSAL_PARENT_REQUIRED",
            message: `Canonical scaffold requires unfulfilled causal parent ${parent}`,
            path: "causalParents",
          });
        }
      }
      for (const requirement of canonicalAdaptationRoleRequirements(parsed, context)) {
        const entity = context.entities.get(requirement.boundEntityId);
        if (!availableEntityIds.has(requirement.boundEntityId)) {
          runtimeErrors.push({
            code: "CANONICAL_ADAPTATION_ENTITY_UNAVAILABLE",
            message: `Canonical scaffold role ${requirement.roleId} binds entity ${requirement.boundEntityId} before it enters branch history`,
            path: "canonicalAdaptation.roleBindings",
          });
        }
        if (entity?.kind === "character" && state.values[entity.id]?.["character.alive"] === false) {
          runtimeErrors.push({
            code: "CANONICAL_ADAPTATION_ENTITY_DEAD",
            message: `Canonical scaffold role ${requirement.roleId} binds dead character ${requirement.boundEntityId}`,
            path: "canonicalAdaptation.roleBindings",
          });
        }
        if (requirement.presence === "active-scene" && !scene?.presentEntityIds.includes(requirement.boundEntityId)) {
          runtimeErrors.push({
            code: "CANONICAL_ADAPTATION_ENTITY_NOT_PRESENT",
            message: `Canonical scaffold role ${requirement.roleId} requires ${requirement.boundEntityId} in the active scene`,
            path: "canonicalAdaptation.roleBindings",
          });
        }
        for (const claimId of requirement.requiresKnowledge) {
          const fact = knowledge.actors[requirement.boundEntityId]?.[claimId];
          if (!fact || !isActionableKnowledge(fact)) {
            runtimeErrors.push({
              code: "CANONICAL_ADAPTATION_KNOWLEDGE_REQUIRED",
              message: `Canonical scaffold role binding ${requirement.boundEntityId} lacks required knowledge ${claimId}`,
              path: "canonicalAdaptation.roleBindings",
            });
          }
        }
      }
      if (runtimeErrors.length) {
        const { derivedDeltaHash: _derivedDeltaHash, ...withoutDerivedHash } = report;
        report = { ...withoutDerivedHash, accepted: false, errors: [...report.errors, ...runtimeErrors] };
      }
    }
    if (report.accepted && parsed.progress?.scene && parsed.actorId) {
      try {
        const actorScene = await projectActorScene(this, parsed.actorId, head, sourceId);
        if (parsed.progress.scene.beat !== actorScene.beat + 1) {
          const { derivedDeltaHash: _derivedDeltaHash, ...withoutDerivedHash } = report;
          report = {
            ...withoutDerivedHash,
            accepted: false,
            errors: [...report.errors, {
              code: "INVALID_SCENE_PROGRESS",
              message: `Scene transition beat ${parsed.progress.scene.beat} must follow committed beat ${actorScene.beat}`,
              path: "progress.scene.beat",
            }],
          };
        }
      } catch (error) {
        const { derivedDeltaHash: _derivedDeltaHash, ...withoutDerivedHash } = report;
        report = {
          ...withoutDerivedHash,
          accepted: false,
          errors: [...report.errors, {
            code: "INVALID_SCENE_PROGRESS",
            message: error instanceof Error ? error.message : String(error),
            path: "progress.scene",
          }],
        };
      }
    }
    if (!report.accepted) return { report, previousHead: head, newHead: head };
    if (!postState) throw new Error("Accepted event proposal did not produce a projected post-state");
    const stateBeforeDelta = advanceTemporalState(state, postState.logicalTime, context.stateSchema, context.entities);
    const effectiveStateIndexes = report.derivedDeltaHash
      ? effectiveStateOperationIndexes(stateBeforeDelta, parsed.proposedDelta, context)
      : [];
    const effectiveKnowledgeIndexes = parsed.proposedKnowledge
      ? effectiveKnowledgeOperationIndexes(projection.knowledge, parsed.proposedKnowledge)
      : [];
    const timeAdvanced = (postState.logicalTime.elapsedDays ?? 0) > (state.logicalTime.elapsedDays ?? 0)
      || JSON.stringify(postState.logicalTime.storyTime) !== JSON.stringify(state.logicalTime.storyTime);
    const hasMaterialCandidate = effectiveStateIndexes.length > 0
      || effectiveKnowledgeIndexes.length > 0
      || Boolean(semanticDelta?.operations.length)
      || Boolean(processDelta?.operations.length)
      || Boolean(normDelta?.operations.length)
      || Boolean(parsed.spokenUtterances?.length)
      || Boolean(parsed.progress?.scene)
      || timeAdvanced;
    if (!hasMaterialCandidate) {
      const { derivedDeltaHash: _derivedDeltaHash, ...withoutDerivedHash } = report;
      report = {
        ...withoutDerivedHash,
        accepted: false,
        errors: [...report.errors, {
          code: "EVENT_MATERIALITY_REQUIRED",
          message: "Commit-boundary reduction found no effective state, knowledge, utterance, scene, or time effect.",
        }],
      };
      return { report, previousHead: head, newHead: head };
    }
    if (!persist) return { report, previousHead: head, newHead: head };
    const deltaHash = effectiveStateIndexes.length
      ? await this.objects.putDelta(parsed.proposedDelta)
      : undefined;
    const knowledgeDeltaHash = parsed.proposedKnowledge && effectiveKnowledgeIndexes.length
      ? await this.objects.putKnowledgeDelta(parsed.proposedKnowledge)
      : undefined;
    const semanticDeltaHash = semanticDelta?.operations.length
      ? await this.objects.putSemanticDelta(semanticDelta)
      : undefined;
    const processDeltaHash = processDelta?.operations.length
      ? await this.objects.putProcessDelta(processDelta)
      : undefined;
    const normDeltaHash = normDelta?.operations.length
      ? await this.objects.putNormDelta(normDelta)
      : undefined;
    const effects: CommittedEvent["effects"] = {
      version: 1,
      ...(deltaHash ? { stateDeltaHash: deltaHash } : {}),
      ...(knowledgeDeltaHash ? { knowledgeDeltaHash } : {}),
      ...(semanticDeltaHash ? { semanticDeltaHash } : {}),
      ...(processDeltaHash ? { processDeltaHash } : {}),
      ...(normDeltaHash ? { normDeltaHash } : {}),
    };
    const progressCertificate = deriveProgressCertificate({
      effects,
      loaded: {
        ...(deltaHash ? { stateDelta: parsed.proposedDelta } : {}),
        ...(knowledgeDeltaHash && parsed.proposedKnowledge ? { knowledgeDelta: parsed.proposedKnowledge } : {}),
        ...(semanticDeltaHash && semanticDelta ? { semanticDelta } : {}),
        ...(processDeltaHash && processDelta ? { processDelta } : {}),
        ...(normDeltaHash && normDelta ? { normDelta } : {}),
      },
      effectiveStateOperationIndexes: effectiveStateIndexes,
      effectiveKnowledgeOperationIndexes: effectiveKnowledgeIndexes,
      utteranceCount: parsed.spokenUtterances?.length ?? 0,
      timeAdvanced,
      ...(parsed.progress?.scene ? { sceneTransition: parsed.progress.scene } : {}),
    });
    if (!hasMaterialProgress(progressCertificate)) throw new Error("Accepted event has no host-certified progress");
    const logicalTime = postState.logicalTime;
    const canonicalPossibilityId = !parsed.canonicalAdaptation && parsed.possibilityId?.startsWith("canon-")
      ? parsed.possibilityId.slice("canon-".length)
      : undefined;
    const realizesCanonicalEventIds = canonicalPossibilityId && context.events?.has(canonicalPossibilityId)
      ? [canonicalPossibilityId]
      : [];
    const eventId = contentHash({
      branchId: parsed.branchId,
      parent: head,
      proposalId: parsed.proposalId,
      title: parsed.title,
      logicalTime,
      timeAdvance: parsed.timeAdvance,
      effects,
      supersedesCanonicalEventIds: parsed.supersedesCanonicalEventIds,
      possibilityId: parsed.possibilityId,
      canonicalAdaptation: parsed.canonicalAdaptation,
      realizesCanonicalEventIds,
      progress: parsed.progress,
      progressCertificate,
      participantPresence: parsed.participantPresence,
      actorObservations: parsed.actorObservations,
      actorAffects: parsed.actorAffects,
      spokenUtterances: parsed.spokenUtterances,
      action: parsed.action,
      causalRelationProposals,
    });
    const causalRelations: BranchEventRelation[] = causalRelationProposals.map((relation, index) => ({
      id: `branch-relation-${contentHash({ eventId, index, relation }).slice(0, 32)}`,
      toEventId: eventId,
      ...structuredClone(relation),
    }));
    const event: CommittedEvent = {
      version: 2,
      eventId,
      branchId: parsed.branchId,
      logicalTime,
      ...(parsed.timeAdvance ? { timeAdvance: parsed.timeAdvance } : {}),
      proposalId: parsed.proposalId,
      ...(parsed.actorId ? { actorId: parsed.actorId } : {}),
      title: parsed.title,
      ...(parsed.actorObservations ? { actorObservations: structuredClone(parsed.actorObservations) } : {}),
      ...(parsed.actorAffects ? { actorAffects: structuredClone(parsed.actorAffects) } : {}),
      ...(parsed.spokenUtterances ? { spokenUtterances: structuredClone(parsed.spokenUtterances) } : {}),
      participants: parsed.participants,
      ...(parsed.participantPresence ? { participantPresence: structuredClone(parsed.participantPresence) } : {}),
      effects,
      progressCertificate,
      evidence: parsed.evidence,
      causalRelations,
      causalParents: [...new Set(causalRelations.map((relation) => relation.fromEventId))],
      ...(parsed.supersedesCanonicalEventIds ? { supersedesCanonicalEventIds: parsed.supersedesCanonicalEventIds } : {}),
      ...(realizesCanonicalEventIds.length ? { realizesCanonicalEventIds } : {}),
      ...(parsed.possibilityId ? { possibilityId: parsed.possibilityId } : {}),
      ...(parsed.canonicalAdaptation ? { canonicalAdaptation: structuredClone(parsed.canonicalAdaptation) } : {}),
      ...(parsed.action ? { action: structuredClone(parsed.action) } : {}),
      ...(parsed.progress ? { progress: parsed.progress } : {}),
    };
    const eventHash = await this.objects.putEvent(event);
    const commitHash = await this.objects.putCommit({ version: 1, parentCommitId: head, branchId: parsed.branchId, logicalTime, eventHashes: [eventHash], canonicalSnapshotHash: context.canonicalSnapshotHash, engineVersion: WORLD_ENGINE_VERSION, schemaVersion: WORLD_SCHEMA_VERSION });
    await this.branches.updateHead(parsed.branchId, head, commitHash);
    return { report, previousHead: head, newHead: commitHash, eventHash, progressCertificate };
  }

  private async contextForSnapshot(snapshotHash?: ObjectHash): Promise<ResolvedWorldModelContext> {
    if (!snapshotHash) return this.context;
    const cached = this.contextCache.get(snapshotHash);
    if (cached) return cached;
    if (!this.contextResolver) throw new Error(`Canonical snapshot is not available: ${snapshotHash}`);
    const loaded = resolveContext(await this.contextResolver(snapshotHash));
    if (loaded.canonicalSnapshotHash !== snapshotHash) {
      throw new Error(`Canonical snapshot resolver returned ${loaded.canonicalSnapshotHash} for ${snapshotHash}`);
    }
    this.contextCache.set(snapshotHash, loaded);
    return loaded;
  }
}

function normalizedCausalRelationProposals(
  proposal: EventProposal,
  projection: WorldProjectionBundle,
): BranchEventRelationProposal[] {
  const resolveSource = (sourceId: string): string => {
    const aliases = sourceId.startsWith("canon-")
      ? new Set([sourceId, sourceId.slice("canon-".length)])
      : new Set([sourceId, `canon-${sourceId}`]);
    const realized = [...projection.history].reverse().find(({ event }) =>
      aliases.has(event.eventId)
      || Boolean(event.possibilityId && aliases.has(event.possibilityId))
      || (event.realizesCanonicalEventIds ?? []).some((eventId) => aliases.has(eventId) || aliases.has(`canon-${eventId}`))
      || Boolean(event.canonicalAdaptation && (
        aliases.has(event.canonicalAdaptation.adaptedFromCanonicalEventId)
        || aliases.has(`canon-${event.canonicalAdaptation.adaptedFromCanonicalEventId}`)
      )));
    return realized?.event.eventId ?? sourceId;
  };
  if (proposal.causalRelations) {
    return proposal.causalRelations.map((relation) => ({ ...structuredClone(relation), fromEventId: resolveSource(relation.fromEventId) }));
  }
  return [...new Set(proposal.causalParents)].map((sourceId) => ({
    fromEventId: resolveSource(sourceId),
    type: "causes",
    operationality: "contributory",
    description: "Legacy proposal linkage normalized by the host",
  }));
}

function validateBranchCausalRelationProposals(
  relations: readonly BranchEventRelationProposal[],
  proposal: EventProposal,
  projection: WorldProjectionBundle,
  context: WorldModelContext,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const signatures = new Set<string>();
  relations.forEach((relation, index) => {
    const path = `causalRelations.${index}`;
    if (!projection.causality.events[relation.fromEventId]) {
      issues.push({
        code: "UNKNOWN_CAUSAL_SOURCE_EVENT",
        message: `Branch causal relation references event ${relation.fromEventId}, which is not in committed ancestry`,
        path: `${path}.fromEventId`,
      });
    }
    const signature = `${relation.fromEventId}\u0000${relation.type}\u0000${relation.operationality}\u0000${relation.actorId ?? ""}\u0000${relation.goalId ?? ""}`;
    if (signatures.has(signature)) {
      issues.push({ code: "DUPLICATE_BRANCH_CAUSAL_RELATION", message: `Duplicate branch causal relation from ${relation.fromEventId}`, path });
    }
    signatures.add(signature);
    if (relation.actorId) {
      const actor = context.entities.get(relation.actorId);
      if (!actor || actor.kind !== "character") {
        issues.push({ code: "INVALID_CAUSAL_MOTIVATED_ACTOR", message: `Causal relation actor ${relation.actorId} must be a character`, path: `${path}.actorId` });
      } else if (!proposal.participants.includes(relation.actorId)) {
        issues.push({ code: "CAUSAL_ACTOR_NOT_PARTICIPANT", message: `Motivated actor ${relation.actorId} must participate in the target event`, path: `${path}.actorId` });
      }
    }
    if (relation.goalId) {
      const canonicalGoal = context.actorGoals?.find((goal) => goal.id === relation.goalId);
      const branchGoal = projection.semantics.goals[relation.goalId];
      if (!canonicalGoal && !branchGoal) {
        issues.push({ code: "UNKNOWN_CAUSAL_GOAL", message: `Causal relation references unknown goal ${relation.goalId}`, path: `${path}.goalId` });
      } else if (relation.actorId && (canonicalGoal?.actorId ?? branchGoal?.actorId) !== relation.actorId) {
        issues.push({ code: "CAUSAL_GOAL_ACTOR_MISMATCH", message: `Goal ${relation.goalId} does not belong to motivated actor ${relation.actorId}`, path: `${path}.goalId` });
      }
    }
  });
  return issues;
}

function validateKnowledgeDeltaForContext(knowledge: KnowledgeDelta, context: WorldModelContext): void {
  for (let index = 0; index < knowledge.operations.length; index += 1) {
    const operation = knowledge.operations[index]!;
    const actor = context.entities.get(operation.actorId);
    if (!actor || actor.kind !== "character") throw new Error(`Initial knowledge actor ${operation.actorId} is not a character`);
    if (operation.op === "learn") {
      if (context.claims && !context.claims.has(operation.claimId)) throw new Error(`Initial knowledge references unknown claim ${operation.claimId}`);
      if (operation.sourceActorId) {
        const source = context.entities.get(operation.sourceActorId);
        if (!isCommunicatingKnowledgeSource(source)) throw new Error(`Initial knowledge source ${operation.sourceActorId} is not a character or communication system`);
      }
    }
    const semanticErrors = validateKnowledgeSemanticReferences(operation, {
      claims: context.claims ?? new Map(),
      propositions: context.propositions,
      attributions: context.attributions,
    }, `knowledge.operations.${index}`);
    if (semanticErrors.length) {
      throw new Error(semanticErrors.map((error) => `${error.code}: ${error.message}`).join("; "));
    }
  }
}

export function canonicalEventSatisfiedAtGenesis(
  event: CanonicalEvent,
  state: WorldState,
  knowledge: KnowledgeDelta | undefined,
  relations: readonly EventRelation[],
): boolean {
  if (relations.some((relation) => relation.toEventId === event.id && relation.status !== "contested" && relation.operationality === "necessary")
    || event.preconditions.some((predicate) => !evaluatePredicate(state, predicate))) return false;
  const stateSatisfied = event.observedOutcome.operations.every((operation) => {
    if (operation.op === "activate-rule") return state.activeRuleIds.includes(operation.ruleId);
    if (operation.op === "deactivate-rule") return !state.activeRuleIds.includes(operation.ruleId);
    const value = state.values[operation.entityId]?.[operation.field];
    if (operation.op === "set") return JSON.stringify(value) === JSON.stringify(operation.value);
    if (operation.op === "unset") return value === undefined;
    if (operation.op === "add-member") return Array.isArray(value) && value.includes(operation.member);
    if (operation.op === "remove-member") return !Array.isArray(value) || !value.includes(operation.member);
    return false;
  });
  const initialKnowledge = knowledge?.operations ?? [];
  const knowledgeSatisfied = (event.observedKnowledge?.operations ?? []).every((operation) =>
    initialKnowledge.some((candidate) => JSON.stringify(candidate) === JSON.stringify(operation)),
  );
  const hasEffect = event.observedOutcome.operations.length > 0 || (event.observedKnowledge?.operations.length ?? 0) > 0;
  return hasEffect && stateSatisfied && knowledgeSatisfied;
}

function touchedKnowledgeEntities(knowledge?: KnowledgeDelta): EntityId[] {
  if (!knowledge) return [];
  return knowledge.operations.flatMap((operation) => operation.op === "learn" && operation.sourceActorId
    ? [operation.actorId, operation.sourceActorId]
    : [operation.actorId]);
}

function effectiveStateOperationIndexes(
  input: WorldState,
  delta: StateDelta,
  context: Pick<WorldModelContext, "stateSchema" | "entities" | "rules">,
): number[] {
  let current = input;
  const effective: number[] = [];
  for (let index = 0; index < delta.operations.length; index += 1) {
    const next = applyStateDelta(
      current,
      { version: 1, operations: [delta.operations[index]!] },
      context.stateSchema,
      context.entities,
      context.rules,
    );
    if (stateFactsChanged(current, next)) effective.push(index);
    current = next;
  }
  return stateFactsChanged(input, current) ? effective : [];
}

function effectiveKnowledgeOperationIndexes(input: KnowledgeState, delta: KnowledgeDelta): number[] {
  const actors = structuredClone(input.actors);
  const before = knowledgeFactsHash(actors);
  const effective: number[] = [];
  for (let index = 0; index < delta.operations.length; index += 1) {
    const operation = delta.operations[index]!;
    const actor = (actors[operation.actorId] ??= {});
    if (operation.op === "forget") {
      if (actor[operation.claimId]) {
        delete actor[operation.claimId];
        effective.push(index);
      }
      continue;
    }
    const desired = {
      actorId: operation.actorId,
      claimId: operation.claimId,
      ...(operation.propositionId ? { propositionId: operation.propositionId } : {}),
      ...(operation.attributionId ? { attributionId: operation.attributionId } : {}),
      ...(operation.acquisitionMode ? { acquisitionMode: operation.acquisitionMode } : {}),
      status: operation.status,
      confidence: operation.confidence,
      ...(operation.sourceActorId ? { sourceActorId: operation.sourceActorId } : {}),
    };
    const existing = actor[operation.claimId];
    if (!existing || contentHash(withoutAcquisitionCommit(existing)) !== contentHash(desired)) {
      effective.push(index);
    }
    actor[operation.claimId] = { ...desired, acquiredAtCommit: "pending" };
  }
  return knowledgeFactsHash(actors) === before ? [] : effective;
}

function knowledgeFactsHash(actors: KnowledgeState["actors"]): string {
  return contentHash(Object.fromEntries(Object.entries(actors).map(([actorId, facts]) => [
    actorId,
    Object.fromEntries(Object.entries(facts).map(([claimId, fact]) => [claimId, withoutAcquisitionCommit(fact)])),
  ])));
}

function withoutAcquisitionCommit<T extends { acquiredAtCommit?: string }>(fact: T): Omit<T, "acquiredAtCommit"> {
  const { acquiredAtCommit: _acquiredAtCommit, ...semanticFact } = fact;
  return semanticFact;
}

function resolveContext(context: WorldModelContext): ResolvedWorldModelContext {
  const ontologyIssues = [
    ...validateActionConstraintCatalog(context.actionConstraints?.values() ?? [], {
      entities: context.entities,
      actionSchemas: context.actionSchemas ?? new Map(),
    }),
    ...validateNormTemplateCatalog(context.normTemplates?.values() ?? [], {
      entities: context.entities,
      claimIds: new Set(context.claims?.keys() ?? []),
      canonicalEventIds: new Set(context.events?.keys() ?? []),
    }),
    ...validateProcessTemplateCatalog(
      context.processTemplates?.values() ?? [],
      new Set(context.events?.keys() ?? []),
    ),
  ];
  const resourceIssues = validateResourcePolicyCatalog(
    context.resourcePolicies ?? [],
    context.stateSchema,
    context.entities,
  );
  if (ontologyIssues.length || resourceIssues.length) {
    throw new Error(`Invalid executable world context: ${[
      ...ontologyIssues.map((item) => `${item.code}: ${item.message}`),
      ...resourceIssues,
    ].join("; ")}`);
  }
  const canonicalSnapshotHash = context.canonicalSnapshotHash ?? contentHash({
    entities: [...context.entities.entries()].sort(([left], [right]) => left.localeCompare(right)),
    claims: [...(context.claims?.entries() ?? [])].sort(([left], [right]) => left.localeCompare(right)),
    events: [...(context.events?.entries() ?? [])].sort(([left], [right]) => left.localeCompare(right)),
    spatialOntologyVersion: context.spatialOntologyVersion,
    spatialRelations: [...(context.spatialRelations ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
    actionConstraints: [...(context.actionConstraints?.entries() ?? [])].sort(([left], [right]) => left.localeCompare(right)),
    normTemplates: [...(context.normTemplates?.entries() ?? [])].sort(([left], [right]) => left.localeCompare(right)),
    processTemplates: [...(context.processTemplates?.entries() ?? [])].sort(([left], [right]) => left.localeCompare(right)),
    resourcePolicies: [...(context.resourcePolicies ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
    rules: [...context.rules.entries()].sort(([left], [right]) => left.localeCompare(right)),
    stateFields: context.stateSchema.list(),
  });
  return { ...context, canonicalSnapshotHash };
}

function touchedEntities(delta: StateDelta): EntityId[] {
  return [...new Set(delta.operations.flatMap((operation) => ("entityId" in operation ? [operation.entityId] : [])))].sort();
}
