import { contentHash } from "./canonical.js";
import type { CharacterGoal, CharacterModel } from "./actors.js";
import {
  WORLD_ENGINE_VERSION,
  WORLD_SCHEMA_VERSION,
  actorEventObservationSchema,
  eventProposalSchema,
  knowledgeDeltaSchema,
  participantPresenceSchema,
  stateDeltaSchema,
  type ActorEventObservation,
  type Attribution,
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
  type ObjectHash,
  type ParticipantPresence,
  type Proposition,
  type StateDelta,
  type ValidationIssue,
  type ValidationReport,
  type WorldRule,
  type WorldState,
} from "./model.js";
import type { PossibilityTemplate } from "./possibility-model.js";
import { StateSchemaRegistry, advanceTemporalState, applyStateDelta, emptyWorldState, evaluatePredicate, validateEngineInvariants } from "./state.js";
import { BranchStore, WorldObjectStore } from "./store.js";
import { assertMonotonicLogicalTime, nextLogicalTime } from "./time.js";
import { assertEvidenceExclusiveToSource } from "./source-scope.js";
import {
  canonicalAdaptationRoleRequirements,
  validateCanonicalAdaptationContract,
} from "./canonical-adaptation.js";
import { isActionableKnowledge, KnowledgeProjector } from "./knowledge.js";
import { isCommunicatingKnowledgeSource, validateKnowledgeSemanticReferences } from "./knowledge-semantics.js";
import { committedHistory, projectActorScene } from "./scene.js";
import type { SpatialRelation } from "./spatial-ontology.js";
import {
  isControlledWorldRule,
  resolveEffectiveWorldRules,
  type EffectiveWorldRule,
} from "./world-rule-ontology.js";

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
  actorGoals?: readonly CharacterGoal[];
  actorModels?: ReadonlyMap<string, CharacterModel>;
  possibilityTemplates?: readonly PossibilityTemplate[];
};

export type ResolvedWorldModelContext = WorldModelContext & { canonicalSnapshotHash: ObjectHash };
export type WorldContextResolver = (snapshotHash: ObjectHash) => Promise<WorldModelContext>;

export class WorldProjector {
  private readonly contextForSnapshot: (snapshotHash?: ObjectHash) => Promise<ResolvedWorldModelContext>;
  constructor(objects: WorldObjectStore, context: WorldModelContext);
  constructor(objects: WorldObjectStore, contextForSnapshot: (snapshotHash?: ObjectHash) => Promise<ResolvedWorldModelContext>);
  constructor(private readonly objects: WorldObjectStore, source: WorldModelContext | ((snapshotHash?: ObjectHash) => Promise<ResolvedWorldModelContext>)) {
    if (typeof source === "function") {
      this.contextForSnapshot = source;
    } else {
      const context = resolveContext(source);
      this.contextForSnapshot = async (snapshotHash) => {
        if (snapshotHash && snapshotHash !== context.canonicalSnapshotHash) throw new Error(`Canonical snapshot is not available: ${snapshotHash}`);
        return context;
      };
    }
  }
  async project(commitId: CommitId): Promise<WorldState> {
    const chain: { id: CommitId; commit: Awaited<ReturnType<WorldObjectStore["getCommit"]>> }[] = [];
    const seen = new Set<string>();
    let cursor: CommitId | undefined = commitId;
    while (cursor) {
      if (seen.has(cursor)) throw new Error(`Commit ancestry cycle detected at ${cursor}`);
      seen.add(cursor);
      const commit = await this.objects.getCommit(cursor);
      if (commit.schemaVersion !== WORLD_SCHEMA_VERSION) throw new Error(`Unsupported world schema version ${commit.schemaVersion} at ${cursor}`);
      if (commit.engineVersion !== WORLD_ENGINE_VERSION) throw new Error(`Unsupported engine version ${commit.engineVersion} at ${cursor}`);
      chain.push({ id: cursor, commit });
      cursor = commit.parentCommitId;
      if (chain.length > 100_000) throw new Error("Commit ancestry exceeds safety limit");
    }
    chain.reverse();
    let state = emptyWorldState(chain[0]?.id ?? commitId, 0);
    let previousTime: LogicalTime | undefined;
    for (const entry of chain) {
      const context = await this.contextForSnapshot(entry.commit.canonicalSnapshotHash);
      if (previousTime) {
        try {
          assertMonotonicLogicalTime(previousTime, entry.commit.logicalTime);
        } catch (error) {
          throw new Error(`Non-monotonic world time at commit ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      state = advanceTemporalState(state, entry.commit.logicalTime, context.stateSchema, context.entities);
      for (const eventHash of entry.commit.eventHashes) {
        const event = await this.objects.getEvent(eventHash);
        if (event.logicalTime.step !== entry.commit.logicalTime.step) throw new Error(`Event/commit logical time mismatch for ${eventHash}`);
        state = applyStateDelta(state, await this.objects.getDelta(event.deltaHash), context.stateSchema, context.entities, context.rules);
      }
      state = { ...state, atCommit: entry.id, logicalTime: entry.commit.logicalTime };
      const invariantErrors = validateEngineInvariants(state, context.stateSchema, context.entities, context.rules);
      if (invariantErrors.length) throw new Error(`Projected state violates invariants: ${invariantErrors.join("; ")}`);
      previousTime = entry.commit.logicalTime;
    }
    return state;
  }
}

export function validateEventProposal(proposalInput: EventProposal, head: CommitId, state: WorldState, context: WorldModelContext): { report: ValidationReport; postState?: WorldState } {
  const proposal = eventProposalSchema.parse(proposalInput);
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
  if (proposal.proposedKnowledge) {
    const knowledge = knowledgeDeltaSchema.parse(proposal.proposedKnowledge);
    for (let index = 0; index < knowledge.operations.length; index += 1) {
      const operation = knowledge.operations[index]!;
      const actor = context.entities.get(operation.actorId);
      if (!actor || actor.kind !== "character") errors.push({ code: "INVALID_KNOWLEDGE_ACTOR", message: `Knowledge actor ${operation.actorId} is not a character`, path: `proposedKnowledge.operations.${index}` });
      if (context.claims && !context.claims.has(operation.claimId)) errors.push({ code: "UNKNOWN_KNOWLEDGE_CLAIM", message: `Unknown claim ${operation.claimId}`, path: `proposedKnowledge.operations.${index}` });
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
    for (const rule of applicableRules) {
      if (rule.requires.some((predicate) => !evaluatePredicate(evaluationState, predicate))) {
        errors.push({ code: "RULE_REQUIREMENT_FAILED", message: `Rule ${rule.id} requirement is not satisfied` });
      }
    }
  }

  let postState: WorldState | undefined;
  if (!errors.length) {
    try {
      const delta = stateDeltaSchema.parse(proposal.proposedDelta);
      postState = applyStateDelta(evaluationState, delta, context.stateSchema, context.entities, context.rules);
      for (const message of validateEngineInvariants(postState, context.stateSchema, context.entities, context.rules)) errors.push({ code: "POST_STATE_INVARIANT", message });
      for (const rule of applicableRules) {
        const forbidden = isControlledWorldRule(rule.rule)
          ? rule.forbids.some((predicate) => evaluatePredicate(postState!, predicate))
          : rule.forbids.length > 0 && rule.forbids.every((predicate) => evaluatePredicate(postState!, predicate));
        if (forbidden) {
          errors.push({ code: "RULE_FORBIDS", message: `Rule ${rule.id} forbids the proposed post-state` });
        }
      }
      const stateChanged = contentHash({ values: state.values, activeRuleIds: state.activeRuleIds })
        !== contentHash({ values: postState.values, activeRuleIds: postState.activeRuleIds });
      const timeChanged = (postState.logicalTime.elapsedDays ?? 0) > (state.logicalTime.elapsedDays ?? 0)
        || JSON.stringify(postState.logicalTime.storyTime) !== JSON.stringify(state.logicalTime.storyTime);
      const hasKnowledgeEffect = Boolean(proposal.proposedKnowledge?.operations.length);
      if (proposal.source === "player" && !stateChanged && !timeChanged && !hasKnowledgeEffect && !proposal.progress) {
        errors.push({
          code: "PLAYER_PROGRESS_REQUIRED",
          message: "An otherwise empty player event requires host-derived narrative progress metadata; raw no-op player commits are forbidden.",
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
  const report: ValidationReport = { proposalId: proposal.proposalId, evaluatedAtCommit: head, accepted: errors.length === 0, errors, warnings, ...(errors.length === 0 ? { derivedDeltaHash: contentHash(proposal.proposedDelta) } : {}) };
  return { report, postState: report.accepted ? postState : undefined };
}

export type CommitProposalResult = { report: ValidationReport; previousHead: CommitId; newHead: CommitId; eventHash?: string };

export class WorldEngine {
  readonly workspaceRoot: string;
  readonly objects: WorldObjectStore;
  readonly branches: BranchStore;
  readonly projector: WorldProjector;
  readonly context: ResolvedWorldModelContext;
  private readonly contextCache = new Map<ObjectHash, ResolvedWorldModelContext>();
  constructor(workspaceRoot: string, context: WorldModelContext, private readonly contextResolver?: WorldContextResolver) {
    this.workspaceRoot = workspaceRoot;
    this.objects = new WorldObjectStore(this.workspaceRoot);
    this.branches = new BranchStore(this.workspaceRoot);
    this.context = resolveContext(context);
    this.contextCache.set(this.context.canonicalSnapshotHash, this.context);
    this.projector = new WorldProjector(this.objects, (snapshotHash) => this.contextForSnapshot(snapshotHash));
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
    const initialState = applyStateDelta(
      { ...emptyWorldState("genesis", 0), logicalTime },
      initialDelta,
      this.context.stateSchema,
      this.context.entities,
      this.context.rules,
    );
    const invariantErrors = validateEngineInvariants(initialState, this.context.stateSchema, this.context.entities, this.context.rules);
    if (invariantErrors.length) throw new Error(`Invalid initial world state: ${invariantErrors.join("; ")}`);
    const deltaHash = await this.objects.putDelta(initialDelta);
    const knowledgeDeltaHash = knowledge ? await this.objects.putKnowledgeDelta(knowledge) : undefined;
    const inferredRealizations = [...(this.context.events?.values() ?? [])]
      .filter((event) => canonicalEventSatisfiedAtGenesis(event, initialState, knowledge))
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
      deltaHash,
      knowledgeDeltaHash,
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
      version: 1,
      eventId,
      branchId,
      logicalTime,
      title: "Genesis",
      ...(actorObservations.length ? { actorObservations } : {}),
      participants,
      ...(participantPresence.length ? { participantPresence } : {}),
      deltaHash,
      ...(knowledgeDeltaHash ? { knowledgeDeltaHash } : {}),
      evidence,
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
      createdAt: new Date().toISOString(),
      headCommitId: commitHash,
    });
    return commitHash;
  }
  async commitProposal(proposal: EventProposal): Promise<CommitProposalResult> {
    const parsed = eventProposalSchema.parse(proposal);
    const branch = await this.branches.read(parsed.branchId);
    const head = branch.headCommitId;
    const context = await this.contextForCommit(head);
    if (branch.sourceId && context.sourceId && branch.sourceId !== context.sourceId) {
      throw new Error(`Branch source '${branch.sourceId}' does not match committed context '${context.sourceId}'.`);
    }
    const sourceId = branch.sourceId ?? context.sourceId;
    if (sourceId && parsed.evidence.length) {
      assertEvidenceExclusiveToSource(parsed.evidence, sourceId, `Event proposal ${parsed.proposalId}`);
    }
    const state = await this.projector.project(head);
    const { report: baseReport, postState } = validateEventProposal(parsed, head, state, context);
    let report = baseReport;
    if (report.accepted && parsed.canonicalAdaptation) {
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
    if (!report.accepted) return { report, previousHead: head, newHead: head };
    if (!postState) throw new Error("Accepted event proposal did not produce a projected post-state");
    const deltaHash = await this.objects.putDelta(parsed.proposedDelta);
    const knowledgeDeltaHash = parsed.proposedKnowledge ? await this.objects.putKnowledgeDelta(parsed.proposedKnowledge) : undefined;
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
      deltaHash,
      knowledgeDeltaHash,
      supersedesCanonicalEventIds: parsed.supersedesCanonicalEventIds,
      possibilityId: parsed.possibilityId,
      canonicalAdaptation: parsed.canonicalAdaptation,
      realizesCanonicalEventIds,
      progress: parsed.progress,
      participantPresence: parsed.participantPresence,
      actorObservations: parsed.actorObservations,
      actorAffects: parsed.actorAffects,
      spokenUtterances: parsed.spokenUtterances,
    });
    const event: CommittedEvent = {
      version: 1,
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
      deltaHash,
      ...(knowledgeDeltaHash ? { knowledgeDeltaHash } : {}),
      evidence: parsed.evidence,
      causalParents: parsed.causalParents,
      ...(parsed.supersedesCanonicalEventIds ? { supersedesCanonicalEventIds: parsed.supersedesCanonicalEventIds } : {}),
      ...(realizesCanonicalEventIds.length ? { realizesCanonicalEventIds } : {}),
      ...(parsed.possibilityId ? { possibilityId: parsed.possibilityId } : {}),
      ...(parsed.canonicalAdaptation ? { canonicalAdaptation: structuredClone(parsed.canonicalAdaptation) } : {}),
      ...(parsed.progress ? { progress: parsed.progress } : {}),
    };
    const eventHash = await this.objects.putEvent(event);
    const commitHash = await this.objects.putCommit({ version: 1, parentCommitId: head, branchId: parsed.branchId, logicalTime, eventHashes: [eventHash], canonicalSnapshotHash: context.canonicalSnapshotHash, engineVersion: WORLD_ENGINE_VERSION, schemaVersion: WORLD_SCHEMA_VERSION });
    await this.branches.updateHead(parsed.branchId, head, commitHash);
    return { report, previousHead: head, newHead: commitHash, eventHash };
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

function canonicalEventSatisfiedAtGenesis(event: CanonicalEvent, state: WorldState, knowledge?: KnowledgeDelta): boolean {
  if (event.causalParents.length > 0 || event.preconditions.some((predicate) => !evaluatePredicate(state, predicate))) return false;
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

function resolveContext(context: WorldModelContext): ResolvedWorldModelContext {
  const canonicalSnapshotHash = context.canonicalSnapshotHash ?? contentHash({
    entities: [...context.entities.entries()].sort(([left], [right]) => left.localeCompare(right)),
    claims: [...(context.claims?.entries() ?? [])].sort(([left], [right]) => left.localeCompare(right)),
    events: [...(context.events?.entries() ?? [])].sort(([left], [right]) => left.localeCompare(right)),
    spatialOntologyVersion: context.spatialOntologyVersion,
    spatialRelations: [...(context.spatialRelations ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
    rules: [...context.rules.entries()].sort(([left], [right]) => left.localeCompare(right)),
    stateFields: context.stateSchema.list(),
  });
  return { ...context, canonicalSnapshotHash };
}

function touchedEntities(delta: StateDelta): EntityId[] {
  return [...new Set(delta.operations.flatMap((operation) => ("entityId" in operation ? [operation.entityId] : [])))].sort();
}
