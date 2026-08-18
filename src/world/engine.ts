import { contentHash } from "./canonical.js";
import type { CharacterGoal, CharacterModel } from "./actors.js";
import {
  WORLD_ENGINE_VERSION,
  WORLD_SCHEMA_VERSION,
  eventProposalSchema,
  knowledgeDeltaSchema,
  stateDeltaSchema,
  type BranchId,
  type CanonicalEvent,
  type Claim,
  type CommitId,
  type CommittedEvent,
  type Entity,
  type EntityId,
  type EvidenceRef,
  type EventProposal,
  type KnowledgeDelta,
  type LogicalTime,
  type ObjectHash,
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

export type WorldModelContext = {
  canonicalSnapshotHash?: ObjectHash;
  sourceId?: string;
  preparedRevisionHash?: string;
  entities: ReadonlyMap<EntityId, Entity>;
  rules: ReadonlyMap<string, WorldRule>;
  stateSchema: StateSchemaRegistry;
  claims?: ReadonlyMap<string, Claim>;
  events?: ReadonlyMap<string, CanonicalEvent>;
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
          if (!source || source.kind !== "character") errors.push({ code: "INVALID_KNOWLEDGE_SOURCE", message: `Knowledge source ${operation.sourceActorId} is not a character`, path: `proposedKnowledge.operations.${index}` });
        }
      }
    }
  }

  const applicableRules: WorldRule[] = [];
  for (const ruleId of evaluationState.activeRuleIds) {
    const rule = context.rules.get(ruleId);
    if (!rule) {
      errors.push({ code: "UNKNOWN_ACTIVE_RULE", message: `Active rule ${ruleId} is not in the model` });
      continue;
    }
    if (!rule.appliesWhen.every((predicate) => evaluatePredicate(evaluationState, predicate))) continue;
    applicableRules.push(rule);
    if (rule.requires?.some((predicate) => !evaluatePredicate(evaluationState, predicate))) {
      errors.push({ code: "RULE_REQUIREMENT_FAILED", message: `Rule ${ruleId} requirement is not satisfied` });
    }
  }

  let postState: WorldState | undefined;
  if (!errors.length) {
    try {
      const delta = stateDeltaSchema.parse(proposal.proposedDelta);
      postState = applyStateDelta(evaluationState, delta, context.stateSchema, context.entities, context.rules);
      for (const message of validateEngineInvariants(postState, context.stateSchema, context.entities, context.rules)) errors.push({ code: "POST_STATE_INVARIANT", message });
      for (const rule of applicableRules) {
        if (rule.forbids?.length && rule.forbids.every((predicate) => evaluatePredicate(postState!, predicate))) {
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
    const realizesCanonicalEventIds = [...(this.context.events?.values() ?? [])]
      .filter((event) => canonicalEventSatisfiedAtGenesis(event, initialState, knowledge))
      .map((event) => event.id)
      .sort();
    const evidence: EvidenceRef[] = structuredClone([...initialEvidence]);
    const eventId = contentHash({ kind: "genesis", branchId, logicalTime, deltaHash, knowledgeDeltaHash, realizesCanonicalEventIds, evidence });
    const event: CommittedEvent = {
      version: 1,
      eventId,
      branchId,
      logicalTime,
      title: "Genesis",
      participants: [...new Set([...touchedEntities(initialDelta), ...touchedKnowledgeEntities(knowledge)])].sort(),
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
    const { report, postState } = validateEventProposal(parsed, head, state, context);
    if (!report.accepted) return { report, previousHead: head, newHead: head };
    if (!postState) throw new Error("Accepted event proposal did not produce a projected post-state");
    const deltaHash = await this.objects.putDelta(parsed.proposedDelta);
    const knowledgeDeltaHash = parsed.proposedKnowledge ? await this.objects.putKnowledgeDelta(parsed.proposedKnowledge) : undefined;
    const logicalTime = postState.logicalTime;
    const canonicalPossibilityId = parsed.possibilityId?.startsWith("canon-")
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
      realizesCanonicalEventIds,
      progress: parsed.progress,
      actorObservations: parsed.actorObservations,
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
      participants: parsed.participants,
      deltaHash,
      ...(knowledgeDeltaHash ? { knowledgeDeltaHash } : {}),
      evidence: parsed.evidence,
      causalParents: parsed.causalParents,
      ...(parsed.supersedesCanonicalEventIds ? { supersedesCanonicalEventIds: parsed.supersedesCanonicalEventIds } : {}),
      ...(realizesCanonicalEventIds.length ? { realizesCanonicalEventIds } : {}),
      ...(parsed.possibilityId ? { possibilityId: parsed.possibilityId } : {}),
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
  for (const operation of knowledge.operations) {
    const actor = context.entities.get(operation.actorId);
    if (!actor || actor.kind !== "character") throw new Error(`Initial knowledge actor ${operation.actorId} is not a character`);
    if (operation.op === "learn") {
      if (context.claims && !context.claims.has(operation.claimId)) throw new Error(`Initial knowledge references unknown claim ${operation.claimId}`);
      if (operation.sourceActorId) {
        const source = context.entities.get(operation.sourceActorId);
        if (!source || source.kind !== "character") throw new Error(`Initial knowledge source ${operation.sourceActorId} is not a character`);
      }
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
    rules: [...context.rules.entries()].sort(([left], [right]) => left.localeCompare(right)),
    stateFields: context.stateSchema.list(),
  });
  return { ...context, canonicalSnapshotHash };
}

function touchedEntities(delta: StateDelta): EntityId[] {
  return [...new Set(delta.operations.flatMap((operation) => ("entityId" in operation ? [operation.entityId] : [])))].sort();
}
