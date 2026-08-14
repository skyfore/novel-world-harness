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
  type EventProposal,
  type KnowledgeDelta,
  type ObjectHash,
  type StateDelta,
  type ValidationIssue,
  type ValidationReport,
  type WorldRule,
  type WorldState,
} from "./model.js";
import type { PossibilityTemplate } from "./possibility-model.js";
import { StateSchemaRegistry, applyStateDelta, emptyWorldState, evaluatePredicate, validateEngineInvariants } from "./state.js";
import { BranchStore, WorldObjectStore } from "./store.js";

export type WorldModelContext = {
  canonicalSnapshotHash?: ObjectHash;
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
    let previousStep = -1;
    for (const entry of chain) {
      const context = await this.contextForSnapshot(entry.commit.canonicalSnapshotHash);
      if (entry.commit.logicalTime.step <= previousStep) throw new Error(`Non-monotonic logical time at commit ${entry.id}`);
      for (const eventHash of entry.commit.eventHashes) {
        const event = await this.objects.getEvent(eventHash);
        if (event.logicalTime.step !== entry.commit.logicalTime.step) throw new Error(`Event/commit logical time mismatch for ${eventHash}`);
        state = applyStateDelta(state, await this.objects.getDelta(event.deltaHash), context.stateSchema, context.entities, context.rules);
      }
      state = { ...state, atCommit: entry.id, logicalTime: entry.commit.logicalTime };
      const invariantErrors = validateEngineInvariants(state, context.stateSchema, context.entities, context.rules);
      if (invariantErrors.length) throw new Error(`Projected state violates invariants: ${invariantErrors.join("; ")}`);
      previousStep = entry.commit.logicalTime.step;
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
  if (proposal.actorId && state.values[proposal.actorId]?.["character.alive"] === false) errors.push({ code: "ACTOR_DEAD", message: `Actor ${proposal.actorId} is not alive` });
  for (let index = 0; index < (proposal.supersedesCanonicalEventIds?.length ?? 0); index += 1) {
    const eventId = proposal.supersedesCanonicalEventIds![index]!;
    if (!context.events?.has(eventId)) errors.push({ code: "UNKNOWN_SUPERSEDED_CANONICAL_EVENT", message: `Unknown superseded canonical event ${eventId}`, path: `supersedesCanonicalEventIds.${index}` });
  }
  for (let index = 0; index < proposal.preconditions.length; index += 1) {
    if (!evaluatePredicate(state, proposal.preconditions[index]!)) errors.push({ code: "PRECONDITION_FAILED", message: `Precondition ${index} is false`, path: `preconditions.${index}` });
  }
  if (proposal.proposedKnowledge) {
    const knowledge = knowledgeDeltaSchema.parse(proposal.proposedKnowledge);
    for (let index = 0; index < knowledge.operations.length; index += 1) {
      const operation = knowledge.operations[index]!;
      const actor = context.entities.get(operation.actorId);
      if (!actor || actor.kind !== "character") errors.push({ code: "INVALID_KNOWLEDGE_ACTOR", message: `Knowledge actor ${operation.actorId} is not a character`, path: `proposedKnowledge.operations.${index}` });
      if (operation.op === "learn") {
        if (operation.sourceActorId) {
          const source = context.entities.get(operation.sourceActorId);
          if (!source || source.kind !== "character") errors.push({ code: "INVALID_KNOWLEDGE_SOURCE", message: `Knowledge source ${operation.sourceActorId} is not a character`, path: `proposedKnowledge.operations.${index}` });
        }
        if (context.claims && !context.claims.has(operation.claimId)) errors.push({ code: "UNKNOWN_KNOWLEDGE_CLAIM", message: `Unknown claim ${operation.claimId}`, path: `proposedKnowledge.operations.${index}` });
      }
    }
  }

  const applicableRules: WorldRule[] = [];
  for (const ruleId of state.activeRuleIds) {
    const rule = context.rules.get(ruleId);
    if (!rule) {
      errors.push({ code: "UNKNOWN_ACTIVE_RULE", message: `Active rule ${ruleId} is not in the model` });
      continue;
    }
    if (!rule.appliesWhen.every((predicate) => evaluatePredicate(state, predicate))) continue;
    applicableRules.push(rule);
    if (rule.requires?.some((predicate) => !evaluatePredicate(state, predicate))) {
      errors.push({ code: "RULE_REQUIREMENT_FAILED", message: `Rule ${ruleId} requirement is not satisfied` });
    }
  }

  let postState: WorldState | undefined;
  if (!errors.length) {
    try {
      const delta = stateDeltaSchema.parse(proposal.proposedDelta);
      postState = applyStateDelta(state, delta, context.stateSchema, context.entities, context.rules);
      for (const message of validateEngineInvariants(postState, context.stateSchema, context.entities, context.rules)) errors.push({ code: "POST_STATE_INVARIANT", message });
      for (const rule of applicableRules) {
        if (rule.forbids?.length && rule.forbids.every((predicate) => evaluatePredicate(postState!, predicate))) {
          errors.push({ code: "RULE_FORBIDS", message: `Rule ${rule.id} forbids the proposed post-state` });
        }
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
  readonly objects: WorldObjectStore;
  readonly branches: BranchStore;
  readonly projector: WorldProjector;
  readonly context: ResolvedWorldModelContext;
  private readonly contextCache = new Map<ObjectHash, ResolvedWorldModelContext>();
  constructor(workspaceRoot: string, context: WorldModelContext, private readonly contextResolver?: WorldContextResolver) {
    this.objects = new WorldObjectStore(workspaceRoot);
    this.branches = new BranchStore(workspaceRoot);
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
  ): Promise<CommitId> {
    stateDeltaSchema.parse(initialDelta);
    const knowledge = initialKnowledge ? knowledgeDeltaSchema.parse(initialKnowledge) : undefined;
    if (knowledge) validateKnowledgeDeltaForContext(knowledge, this.context);
    const initialState = applyStateDelta(emptyWorldState("genesis", 0), initialDelta, this.context.stateSchema, this.context.entities, this.context.rules);
    const invariantErrors = validateEngineInvariants(initialState, this.context.stateSchema, this.context.entities, this.context.rules);
    if (invariantErrors.length) throw new Error(`Invalid initial world state: ${invariantErrors.join("; ")}`);
    const deltaHash = await this.objects.putDelta(initialDelta);
    const knowledgeDeltaHash = knowledge ? await this.objects.putKnowledgeDelta(knowledge) : undefined;
    const realizesCanonicalEventIds = [...(this.context.events?.values() ?? [])]
      .filter((event) => canonicalEventSatisfiedAtGenesis(event, initialState, knowledge))
      .map((event) => event.id)
      .sort();
    const eventId = contentHash({ kind: "genesis", branchId, deltaHash, knowledgeDeltaHash, realizesCanonicalEventIds });
    const event: CommittedEvent = {
      version: 1,
      eventId,
      branchId,
      logicalTime: { step: 0 },
      title: "Genesis",
      participants: [...new Set([...touchedEntities(initialDelta), ...touchedKnowledgeEntities(knowledge)])].sort(),
      deltaHash,
      ...(knowledgeDeltaHash ? { knowledgeDeltaHash } : {}),
      evidence: [],
      causalParents: [],
      ...(realizesCanonicalEventIds.length ? { realizesCanonicalEventIds } : {}),
    };
    const eventHash = await this.objects.putEvent(event);
    const commitHash = await this.objects.putCommit({ version: 1, branchId, logicalTime: { step: 0 }, eventHashes: [eventHash], canonicalSnapshotHash: this.context.canonicalSnapshotHash, engineVersion: WORLD_ENGINE_VERSION, schemaVersion: WORLD_SCHEMA_VERSION });
    await this.branches.create({ id: branchId, name, headCommitId: commitHash });
    return commitHash;
  }
  async commitProposal(proposal: EventProposal): Promise<CommitProposalResult> {
    const parsed = eventProposalSchema.parse(proposal);
    const head = await this.branches.readHead(parsed.branchId);
    const context = await this.contextForCommit(head);
    const state = await this.projector.project(head);
    const { report } = validateEventProposal(parsed, head, state, context);
    if (!report.accepted) return { report, previousHead: head, newHead: head };
    const deltaHash = await this.objects.putDelta(parsed.proposedDelta);
    const knowledgeDeltaHash = parsed.proposedKnowledge ? await this.objects.putKnowledgeDelta(parsed.proposedKnowledge) : undefined;
    const logicalTime = { step: state.logicalTime.step + 1, storyTime: parsed.proposedTime } as const;
    const eventId = contentHash({
      branchId: parsed.branchId,
      parent: head,
      proposalId: parsed.proposalId,
      title: parsed.title,
      deltaHash,
      knowledgeDeltaHash,
      supersedesCanonicalEventIds: parsed.supersedesCanonicalEventIds,
      possibilityId: parsed.possibilityId,
    });
    const event: CommittedEvent = {
      version: 1,
      eventId,
      branchId: parsed.branchId,
      logicalTime,
      proposalId: parsed.proposalId,
      title: parsed.title,
      participants: parsed.participants,
      deltaHash,
      ...(knowledgeDeltaHash ? { knowledgeDeltaHash } : {}),
      evidence: parsed.evidence,
      causalParents: parsed.causalParents,
      ...(parsed.supersedesCanonicalEventIds ? { supersedesCanonicalEventIds: parsed.supersedesCanonicalEventIds } : {}),
      ...(parsed.possibilityId ? { possibilityId: parsed.possibilityId } : {}),
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
    return !Array.isArray(value) || !value.includes(operation.member);
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
