import { contentHash } from "./canonical.js";
import {
  WORLD_ENGINE_VERSION,
  WORLD_SCHEMA_VERSION,
  eventProposalSchema,
  knowledgeDeltaSchema,
  stateDeltaSchema,
  type BranchId,
  type Claim,
  type CommitId,
  type CommittedEvent,
  type Entity,
  type EntityId,
  type EventProposal,
  type StateDelta,
  type ValidationIssue,
  type ValidationReport,
  type WorldRule,
  type WorldState,
} from "./model.js";
import { StateSchemaRegistry, applyStateDelta, emptyWorldState, evaluatePredicate, validateEngineInvariants } from "./state.js";
import { BranchStore, WorldObjectStore } from "./store.js";

export type WorldModelContext = {
  entities: ReadonlyMap<EntityId, Entity>;
  rules: ReadonlyMap<string, WorldRule>;
  stateSchema: StateSchemaRegistry;
  claims?: ReadonlyMap<string, Claim>;
};

export class WorldProjector {
  constructor(private readonly objects: WorldObjectStore, private readonly context: WorldModelContext) {}
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
      if (entry.commit.logicalTime.step <= previousStep) throw new Error(`Non-monotonic logical time at commit ${entry.id}`);
      for (const eventHash of entry.commit.eventHashes) {
        const event = await this.objects.getEvent(eventHash);
        if (event.logicalTime.step !== entry.commit.logicalTime.step) throw new Error(`Event/commit logical time mismatch for ${eventHash}`);
        state = applyStateDelta(state, await this.objects.getDelta(event.deltaHash), this.context.stateSchema, this.context.entities);
      }
      state = { ...state, atCommit: entry.id, logicalTime: entry.commit.logicalTime };
      const invariantErrors = validateEngineInvariants(state, this.context.stateSchema, this.context.entities);
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
      postState = applyStateDelta(state, delta, context.stateSchema, context.entities);
      for (const message of validateEngineInvariants(postState, context.stateSchema, context.entities)) errors.push({ code: "POST_STATE_INVARIANT", message });
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
  constructor(workspaceRoot: string, readonly context: WorldModelContext) {
    this.objects = new WorldObjectStore(workspaceRoot);
    this.branches = new BranchStore(workspaceRoot);
    this.projector = new WorldProjector(this.objects, context);
  }
  async createBranch(branchId: BranchId, name: string, initialDelta: StateDelta = { version: 1, operations: [] }): Promise<CommitId> {
    stateDeltaSchema.parse(initialDelta);
    const initialState = applyStateDelta(emptyWorldState("genesis", 0), initialDelta, this.context.stateSchema, this.context.entities);
    const invariantErrors = validateEngineInvariants(initialState, this.context.stateSchema, this.context.entities);
    if (invariantErrors.length) throw new Error(`Invalid initial world state: ${invariantErrors.join("; ")}`);
    const deltaHash = await this.objects.putDelta(initialDelta);
    const eventId = contentHash({ kind: "genesis", branchId, deltaHash });
    const event: CommittedEvent = { version: 1, eventId, branchId, logicalTime: { step: 0 }, title: "Genesis", participants: touchedEntities(initialDelta), deltaHash, evidence: [], causalParents: [] };
    const eventHash = await this.objects.putEvent(event);
    const commitHash = await this.objects.putCommit({ version: 1, branchId, logicalTime: { step: 0 }, eventHashes: [eventHash], engineVersion: WORLD_ENGINE_VERSION, schemaVersion: WORLD_SCHEMA_VERSION });
    await this.branches.create({ id: branchId, name, headCommitId: commitHash });
    return commitHash;
  }
  async commitProposal(proposal: EventProposal): Promise<CommitProposalResult> {
    const parsed = eventProposalSchema.parse(proposal);
    const head = await this.branches.readHead(parsed.branchId);
    const state = await this.projector.project(head);
    const { report } = validateEventProposal(parsed, head, state, this.context);
    if (!report.accepted) return { report, previousHead: head, newHead: head };
    const deltaHash = await this.objects.putDelta(parsed.proposedDelta);
    const knowledgeDeltaHash = parsed.proposedKnowledge ? await this.objects.putKnowledgeDelta(parsed.proposedKnowledge) : undefined;
    const logicalTime = { step: state.logicalTime.step + 1, storyTime: parsed.proposedTime } as const;
    const eventId = contentHash({ branchId: parsed.branchId, parent: head, proposalId: parsed.proposalId, title: parsed.title, deltaHash, knowledgeDeltaHash });
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
      ...(parsed.possibilityId ? { possibilityId: parsed.possibilityId } : {}),
    };
    const eventHash = await this.objects.putEvent(event);
    const commitHash = await this.objects.putCommit({ version: 1, parentCommitId: head, branchId: parsed.branchId, logicalTime, eventHashes: [eventHash], engineVersion: WORLD_ENGINE_VERSION, schemaVersion: WORLD_SCHEMA_VERSION });
    await this.branches.updateHead(parsed.branchId, head, commitHash);
    return { report, previousHead: head, newHead: commitHash, eventHash };
  }
}

function touchedEntities(delta: StateDelta): EntityId[] {
  return [...new Set(delta.operations.flatMap((operation) => ("entityId" in operation ? [operation.entityId] : [])))].sort();
}

