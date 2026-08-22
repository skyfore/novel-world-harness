import { z } from "zod";
import type { ActorProposalCandidate, ActorProposalSource } from "./actors.js";
import {
  eventProposalSchema,
  idSchema,
  possibilitySchema,
  type BranchId,
  type CommitId,
  type EventProposal,
  type EvidenceRef,
  type Possibility,
  type StoryTime,
  type WorldState,
} from "./model.js";
import { buildFrontier, FrontierStore, possibilityToProposal, selectEligible, type Frontier, type FrontierTemporalMode } from "./frontier.js";
import { WorldEngine } from "./engine.js";
import { committedHistory } from "./scene.js";
import { immutableClone } from "../util/immutable.js";
import type { PlayerActionCandidate } from "./player-action.js";
import type { ModelPlayConversationMessage } from "./play-conversation.js";

const MAX_CALLBACK_CANDIDATES = 10_000;
const MAX_PLAYER_WORLD_RESPONSES = 64;
const actorProposalCandidateSchema = z.object({
  proposal: eventProposalSchema,
  priority: z.number().finite().min(0).max(1),
  goalId: idSchema,
}).strict();

export type PossibilitySource = (input: {
  branchId: BranchId;
  commitId: CommitId;
  state: Readonly<WorldState>;
}) => Promise<readonly Possibility[]> | readonly Possibility[];

export type MoveInput = {
  branchId: BranchId;
  playerProposal?: EventProposal;
  maxActorCandidates?: number;
  maxBackgroundCandidates?: number;
  temporalMode?: FrontierTemporalMode;
};

export type AdjudicationConflict = {
  winnerProposalId: string;
  loserProposalId: string;
  writeKeys: string[];
};

export type MoveResult = {
  previousHead: CommitId;
  newHead: CommitId;
  committedEvents: string[];
  rejectedProposals: string[];
  adjudicationConflicts: AdjudicationConflict[];
  frontier: Frontier;
  renderedText?: string;
};

export type CanonicalChoiceResolution = {
  realizedPossibilityId?: string;
  supersedesCanonicalEventIds: string[];
  threadIds?: string[];
  causalParentEventIds?: string[];
};

export const playerWorldResponseResolutionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("none") }).strict(),
  z.object({ decision: z.literal("select"), possibilityId: idSchema }).strict(),
]);
export type PlayerWorldResponseResolution = z.infer<typeof playerWorldResponseResolutionSchema>;

/**
 * Host-private semantic description of an eligible development. The callback
 * may choose one offered ID, but it cannot invent effects or commit world truth.
 */
export type PlayerWorldResponseOption = Readonly<{
  possibilityId: string;
  kind: Possibility["kind"];
  title: string;
  participantNames: string[];
  stateEffects: string[];
  knowledgeEffects: string[];
  timeEffect?: string;
}>;

export type PlayerWorldResponseResolverInput = Readonly<{
  utterance: string;
  recentMessages: readonly ModelPlayConversationMessage[];
  relatedMessages: readonly ModelPlayConversationMessage[];
  actor: { id: string; name: string };
  scene: {
    label?: string;
    presentEntities: Array<{ id: string; name: string; kind: string }>;
    recentEvents?: Array<{ summary: string }>;
  };
  candidate: PlayerActionCandidate;
  eligibleResponses: PlayerWorldResponseOption[];
}>;

export type PlayerWorldResponseResolver = (
  input: PlayerWorldResponseResolverInput,
) => Promise<unknown> | unknown;

export type PlayerWorldResponseResult = {
  resolution: PlayerWorldResponseResolution;
  previousHead: CommitId;
  newHead: CommitId;
  possibilityId?: string;
  title?: string;
  eventHash?: string;
};

export type NarrativeRender = (input: {
  branchId: BranchId;
  commitId: CommitId;
  state: Readonly<WorldState>;
  committedEvents: readonly string[];
}) => Promise<string | undefined> | string | undefined;

export class WorldRuntime {
  readonly frontierStore: FrontierStore;

  constructor(
    readonly engine: WorldEngine,
    private readonly possibilitySource: PossibilitySource,
    private readonly render?: NarrativeRender,
    private readonly actorProposalSource?: ActorProposalSource,
  ) {
    this.frontierStore = new FrontierStore(engine.workspaceRoot);
  }

  async forkBranch(parentBranchId: BranchId, forkCommitId: CommitId, newBranchId: BranchId, name: string): Promise<void> {
    const parent = await this.engine.branches.read(parentBranchId);
    const parentHead = parent.headCommitId;
    if (!(await this.isAncestor(forkCommitId, parentHead))) {
      throw new Error(`Commit ${forkCommitId} is not an ancestor of branch ${parentBranchId}`);
    }
    await this.engine.branches.create({
      id: newBranchId,
      name,
      ...(parent.sourceId ? { sourceId: parent.sourceId } : {}),
      ...(parent.preparedRevisionHash ? { preparedRevisionHash: parent.preparedRevisionHash } : {}),
      createdAt: new Date().toISOString(),
      parentBranchId,
      forkCommitId,
      headCommitId: forkCommitId,
    });
  }

  async move(input: MoveInput): Promise<MoveResult> {
    const previousHead = await this.engine.branches.readHead(input.branchId);
    let currentHead = previousHead;
    const committedEvents: string[] = [];
    const rejectedProposals: string[] = [];
    const adjudicationConflicts: AdjudicationConflict[] = [];

    if (input.playerProposal) {
      if (input.playerProposal.branchId !== input.branchId) throw new Error("Player proposal branch does not match Move branch");
      const playerProposal = { ...input.playerProposal, expectedParentCommit: currentHead };
      const result = await this.engine.commitProposal(playerProposal);
      if (result.report.accepted) {
        currentHead = result.newHead;
        if (result.eventHash) committedEvents.push(result.eventHash);
      } else {
        rejectedProposals.push(playerProposal.proposalId);
      }
    }

    const actorLimit = boundedLimit(input.maxActorCandidates ?? 1, "maxActorCandidates");
    if (this.actorProposalSource && actorLimit > 0) {
      const rawCandidates = await this.actorProposalSource(immutableClone({
        branchId: input.branchId,
        commitId: currentHead,
      }));
      const candidates = actorProposalCandidateSchema.array().max(MAX_CALLBACK_CANDIDATES)
        .parse(structuredClone(rawCandidates));
      const adjudicated = adjudicateActorCandidates(candidates, actorLimit);
      adjudicationConflicts.push(...adjudicated.conflicts);
      rejectedProposals.push(...adjudicated.conflicts.map((conflict) => conflict.loserProposalId));
      for (const candidate of adjudicated.selected) {
        const proposal = { ...candidate.proposal, branchId: input.branchId, expectedParentCommit: currentHead };
        const result = await this.engine.commitProposal(proposal);
        if (!result.report.accepted) {
          rejectedProposals.push(proposal.proposalId);
          continue;
        }
        currentHead = result.newHead;
        if (result.eventHash) committedEvents.push(result.eventHash);
      }
    }

    const backgroundLimit = boundedLimit(input.maxBackgroundCandidates ?? 0, "maxBackgroundCandidates");
    const temporalMode = backgroundLimit > 0 ? input.temporalMode ?? "advance" : "current-window";
    let latestFrontier = await this.refreshFrontier(input.branchId, currentHead, { temporalMode });
    for (let index = 0; index < backgroundLimit; index += 1) {
      const candidate = selectEligible(latestFrontier, 1)[0];
      if (!candidate) break;
      const proposal = possibilityToProposal(candidate);
      if (!proposal) break;
      const result = await this.engine.commitProposal(proposal);
      if (!result.report.accepted) {
        rejectedProposals.push(proposal.proposalId);
        break;
      }
      currentHead = result.newHead;
      if (result.eventHash) committedEvents.push(result.eventHash);
      latestFrontier = await this.refreshFrontier(input.branchId, currentHead, { temporalMode });
    }

    const state = await this.engine.projector.project(currentHead);
    let renderedText: string | undefined;
    if (this.render) {
      const beforeRender = await this.engine.branches.readHead(input.branchId);
      if (beforeRender !== currentHead) {
        throw new Error(`Cannot render world move at stale commit ${currentHead}; current head is ${beforeRender}`);
      }
      const rendered: unknown = await this.render(immutableClone({
        branchId: input.branchId,
        commitId: currentHead,
        state,
        committedEvents,
      }));
      const afterRender = await this.engine.branches.readHead(input.branchId);
      if (afterRender !== beforeRender) throw new Error("World runtime renderer mutated branch truth");
      if (rendered !== undefined && typeof rendered !== "string") {
        throw new Error("World runtime renderer must return a string or undefined");
      }
      renderedText = rendered;
    }
    return {
      previousHead,
      newHead: currentHead,
      committedEvents,
      rejectedProposals: [...new Set(rejectedProposals)],
      adjudicationConflicts,
      frontier: latestFrontier,
      ...(renderedText ? { renderedText } : {}),
    };
  }

  async refreshFrontier(
    branchId: BranchId,
    commitId?: CommitId,
    options: { temporalMode?: FrontierTemporalMode } = {},
  ): Promise<Frontier> {
    const head = commitId ?? (await this.engine.branches.readHead(branchId));
    const [state, temporalAnchor, activity] = await Promise.all([
      this.engine.projector.project(head),
      this.temporalAnchor(head),
      this.branchActivity(head),
    ]);
    const rawTemplates = await this.possibilitySource(immutableClone({ branchId, commitId: head, state }));
    const templates = possibilitySchema.array().max(MAX_CALLBACK_CANDIDATES)
      .parse(structuredClone(rawTemplates));
    const history = await this.possibilityHistory(head);
    const frontier = buildFrontier(branchId, head, state, templates, {
      realizedIds: history.realizedIds,
      supersededIds: history.supersededIds,
      temporalMode: options.temporalMode ?? "current-window",
      ...(temporalAnchor ? { temporalAnchor } : {}),
      activeEntityIds: activity.entityIds,
      activeEvidence: activity.evidence,
    });
    await this.frontierStore.write(frontier);
    return frontier;
  }

  async realizedPossibilityIds(commitId: CommitId): Promise<ReadonlySet<string>> {
    return (await this.possibilityHistory(commitId)).realizedIds;
  }

  async conflictingEligibleCanonicalEventIds(proposal: EventProposal): Promise<string[]> {
    return (await this.resolveEligibleCanonicalEvents(proposal)).supersedesCanonicalEventIds;
  }

  async resolveEligibleCanonicalEvents(proposal: EventProposal): Promise<CanonicalChoiceResolution> {
    const frontier = await this.refreshFrontier(proposal.branchId, proposal.expectedParentCommit);
    const eligible = frontier.evaluated.filter((entry) =>
      entry.status === "eligible"
      && (Boolean(entry.possibility.canonicalEventId) || entry.possibility.kind === "player-choice")
      && Boolean(proposal.actorId && entry.possibility.participants.includes(proposal.actorId)),
    );
    const matching = eligible.filter((entry) => effectsEquivalent(proposal, entry.possibility));
    const supersedesCanonicalEventIds = eligible
      .filter((entry) => Boolean(entry.possibility.canonicalEventId) && deltasConflict(proposal.proposedDelta, entry.possibility.proposedDelta))
      .map((entry) => entry.possibility.canonicalEventId!)
      .sort();
    const attached = eligible
      .map((entry) => ({ entry, affinity: proposalPossibilityAffinity(proposal, entry.possibility) }))
      .filter(({ affinity }) => affinity >= 0.35)
      .sort((left, right) => right.affinity - left.affinity || left.entry.possibility.id.localeCompare(right.entry.possibility.id))
      .slice(0, 2);
    const causalParentEventIds: string[] = [];
    for (const { event } of (await committedHistory(this.engine, proposal.expectedParentCommit)).reverse()) {
      if (!proposal.actorId || event.participants.includes(proposal.actorId)) {
        causalParentEventIds.push(event.eventId);
        break;
      }
    }
    return {
      ...(matching.length === 1 ? { realizedPossibilityId: matching[0]!.possibility.id } : {}),
      supersedesCanonicalEventIds,
      threadIds: attached.map(({ entry }) => entry.possibility.id),
      causalParentEventIds,
    };
  }

  /**
   * Resolves an immediate world-side response to an already committed player
   * action. This is deliberately separate from canonical-choice matching:
   * opening a letter is not effect-equivalent to the outside world delivering
   * that letter. The resolver can only select a currently eligible, offered
   * possibility; the engine remains the sole authority that validates and
   * commits its typed effects as a second event.
   */
  async respondToPlayer(input: {
    branchId: BranchId;
    actorId: string;
    utterance: string;
    candidate: PlayerActionCandidate;
    scene: PlayerWorldResponseResolverInput["scene"];
    expectedHead: CommitId;
    resolver: PlayerWorldResponseResolver;
    causalParentEventId?: string;
    recentMessages?: readonly ModelPlayConversationMessage[];
    relatedMessages?: readonly ModelPlayConversationMessage[];
  }): Promise<PlayerWorldResponseResult> {
    const actualHead = await this.engine.branches.readHead(input.branchId);
    if (actualHead !== input.expectedHead) {
      throw new Error(`Cannot resolve player world response at stale commit ${input.expectedHead}; current head is ${actualHead}`);
    }

    const [frontier, context] = await Promise.all([
      this.refreshFrontier(input.branchId, input.expectedHead, { temporalMode: "current-window" }),
      this.engine.contextForCommit(input.expectedHead),
    ]);
    const actor = context.entities.get(input.actorId);
    if (!actor || actor.kind !== "character") throw new Error(`Unknown player actor ${input.actorId}`);
    const offered = frontier.evaluated
      .filter((entry) =>
        entry.status === "eligible"
        && entry.possibility.participants.includes(input.actorId)
        && entry.possibility.kind !== "player-choice"
        && entry.possibility.kind !== "actor-plan"
        && Boolean(entry.possibility.proposedDelta)
        && Boolean(
          entry.possibility.proposedDelta?.operations.length
          || entry.possibility.proposedKnowledge?.operations.length
          || entry.possibility.timeAdvance,
        ),
      )
      .slice(0, MAX_PLAYER_WORLD_RESPONSES);
    if (!offered.length) {
      return {
        resolution: { decision: "none" },
        previousHead: input.expectedHead,
        newHead: input.expectedHead,
      };
    }

    const eligibleResponses = offered.map(({ possibility }) => describePlayerWorldResponse(possibility, context));
    const rawResolution = await input.resolver(immutableClone({
      utterance: input.utterance,
      recentMessages: input.recentMessages ?? [],
      relatedMessages: input.relatedMessages ?? [],
      actor: { id: actor.id, name: actor.canonicalName },
      scene: input.scene,
      candidate: input.candidate,
      eligibleResponses,
    }));
    const resolution = playerWorldResponseResolutionSchema.parse(structuredClone(rawResolution));
    if (resolution.decision === "none") {
      return {
        resolution,
        previousHead: input.expectedHead,
        newHead: input.expectedHead,
      };
    }

    const selected = offered.find(({ possibility }) => possibility.id === resolution.possibilityId);
    if (!selected) {
      throw new Error(`Player world response selected a possibility that was not offered: ${resolution.possibilityId}`);
    }
    const headBeforeCommit = await this.engine.branches.readHead(input.branchId);
    if (headBeforeCommit !== input.expectedHead) {
      throw new Error(`Cannot commit player world response at stale commit ${input.expectedHead}; current head is ${headBeforeCommit}`);
    }
    const baseProposal = possibilityToProposal(selected);
    if (!baseProposal) throw new Error(`Selected possibility ${resolution.possibilityId} has no committable effect`);
    const proposal = eventProposalSchema.parse({
      ...baseProposal,
      expectedParentCommit: input.expectedHead,
      causalParents: [...new Set([
        ...baseProposal.causalParents,
        ...(input.causalParentEventId ? [input.causalParentEventId] : []),
      ])],
    });
    const committed = await this.engine.commitProposal(proposal);
    if (!committed.report.accepted) {
      const details = committed.report.errors.map((issue) => `${issue.code}: ${issue.message}`).join("; ");
      throw new Error(`Selected player world response was rejected: ${details || "unknown validation failure"}`);
    }
    return {
      resolution,
      previousHead: input.expectedHead,
      newHead: committed.newHead,
      possibilityId: selected.possibility.id,
      title: selected.possibility.title,
      ...(committed.eventHash ? { eventHash: committed.eventHash } : {}),
    };
  }

  private async possibilityHistory(commitId: CommitId): Promise<{ realizedIds: ReadonlySet<string>; supersededIds: ReadonlySet<string> }> {
    const realized = new Set<string>();
    const superseded = new Set<string>();
    const seen = new Set<string>();
    let cursor: CommitId | undefined = commitId;
    while (cursor) {
      if (seen.has(cursor)) throw new Error(`Commit ancestry cycle detected at ${cursor}`);
      seen.add(cursor);
      const commit = await this.engine.objects.getCommit(cursor);
      for (const eventHash of commit.eventHashes) {
        const event = await this.engine.objects.getEvent(eventHash);
        if (event.possibilityId) realized.add(event.possibilityId);
        for (const eventId of event.realizesCanonicalEventIds ?? []) realized.add(`canon-${eventId}`);
        for (const eventId of event.supersedesCanonicalEventIds ?? []) superseded.add(`canon-${eventId}`);
      }
      cursor = commit.parentCommitId;
    }
    return { realizedIds: realized, supersededIds: superseded };
  }

  private async temporalAnchor(commitId: CommitId): Promise<StoryTime | undefined> {
    const seen = new Set<string>();
    let cursor: CommitId | undefined = commitId;
    while (cursor) {
      if (seen.has(cursor)) throw new Error(`Commit ancestry cycle detected at ${cursor}`);
      seen.add(cursor);
      const commit = await this.engine.objects.getCommit(cursor);
      if (commit.logicalTime.storyTime && commit.logicalTime.storyTime.kind !== "unknown") {
        return commit.logicalTime.storyTime;
      }
      cursor = commit.parentCommitId;
    }
    return undefined;
  }

  private async branchActivity(commitId: CommitId): Promise<{ entityIds: ReadonlySet<string>; evidence: EvidenceRef[] }> {
    const active = new Set<string>();
    const evidence: EvidenceRef[] = [];
    // Participation introduces an entity to this branch. It must not vanish
    // from the possibility frontier merely because the latest committed turn
    // was a solo plan or scene transition. Future-canon identities still stay
    // latent because they have never participated in committed history.
    for (const { event } of await committedHistory(this.engine, commitId)) {
      for (const participant of event.participants) active.add(participant);
      evidence.push(...event.evidence);
    }
    return { entityIds: active, evidence };
  }

  private async isAncestor(ancestor: CommitId, descendant: CommitId): Promise<boolean> {
    let cursor: CommitId | undefined = descendant;
    const seen = new Set<string>();
    while (cursor) {
      if (cursor === ancestor) return true;
      if (seen.has(cursor)) throw new Error(`Commit ancestry cycle detected at ${cursor}`);
      seen.add(cursor);
      cursor = (await this.engine.objects.getCommit(cursor)).parentCommitId;
    }
    return false;
  }
}

function describePlayerWorldResponse(
  possibility: Possibility,
  context: Awaited<ReturnType<WorldEngine["contextForCommit"]>>,
): PlayerWorldResponseOption {
  const entityName = (entityId: string): string => context.entities.get(entityId)?.canonicalName ?? "unknown entity";
  const renderValue = (value: unknown): string => {
    if (typeof value === "string") return context.entities.get(value)?.canonicalName ?? value;
    if (Array.isArray(value)) return `[${value.map((item) => typeof item === "string"
      ? context.entities.get(item)?.canonicalName ?? item
      : JSON.stringify(item)).join(", ")}]`;
    return JSON.stringify(value);
  };
  const stateEffects = (possibility.proposedDelta?.operations ?? []).map((operation) => {
    if (operation.op === "activate-rule") return `activate rule ${context.rules.get(operation.ruleId)?.name ?? "unknown rule"}`;
    if (operation.op === "deactivate-rule") return `deactivate rule ${context.rules.get(operation.ruleId)?.name ?? "unknown rule"}`;
    if (operation.op === "set") return `${entityName(operation.entityId)}.${operation.field} = ${renderValue(operation.value)}`;
    if (operation.op === "unset") return `unset ${entityName(operation.entityId)}.${operation.field}`;
    if (operation.op === "adjust-number") return `adjust ${entityName(operation.entityId)}.${operation.field} by ${operation.amount}`;
    return `${operation.op} ${entityName(operation.member)} in ${entityName(operation.entityId)}.${operation.field}`;
  });
  const knowledgeEffects = (possibility.proposedKnowledge?.operations ?? []).map((operation) => {
    const claim = context.claims?.get(operation.claimId);
    const claimSummary = claim
      ? `${entityName(claim.subject)} ${claim.predicate} ${renderValue(claim.object)}`
      : "an unresolved knowledge claim";
    return operation.op === "learn"
      ? `${entityName(operation.actorId)} learns (${operation.status}, ${operation.confidence}): ${claimSummary}`
      : `${entityName(operation.actorId)} forgets: ${claimSummary}`;
  });
  return {
    possibilityId: possibility.id,
    kind: possibility.kind,
    title: possibility.title,
    participantNames: possibility.participants.map(entityName),
    stateEffects,
    knowledgeEffects,
    ...(possibility.timeAdvance
      ? { timeEffect: `${possibility.timeAdvance.amount} ${possibility.timeAdvance.unit}` }
      : {}),
  };
}

function proposalPossibilityAffinity(proposal: EventProposal, possibility: Possibility): number {
  if (effectsEquivalent(proposal, possibility)) return 1;
  const proposalParticipants = new Set(proposal.participants);
  const possibilityParticipants = new Set(possibility.participants);
  const sharedParticipants = [...proposalParticipants].filter((id) => possibilityParticipants.has(id)).length;
  const participantUnion = new Set([...proposalParticipants, ...possibilityParticipants]).size;
  const participantScore = participantUnion ? sharedParticipants / participantUnion : 0;
  const proposalWrites = new Set(finalStateWrites(proposal.proposedDelta).keys());
  const possibilityWrites = new Set(finalStateWrites(possibility.proposedDelta ?? { version: 1, operations: [] }).keys());
  const sharedWrites = [...proposalWrites].filter((key) => possibilityWrites.has(key)).length;
  const writeUnion = new Set([...proposalWrites, ...possibilityWrites]).size;
  const writeScore = writeUnion ? sharedWrites / writeUnion : 0;
  return participantScore * 0.4 + writeScore * 0.6;
}

export function adjudicateActorCandidates(candidates: readonly ActorProposalCandidate[], limit: number): { selected: ActorProposalCandidate[]; conflicts: AdjudicationConflict[] } {
  const ordered = [...candidates].sort((left, right) => right.priority - left.priority || left.proposal.proposalId.localeCompare(right.proposal.proposalId));
  const selected: ActorProposalCandidate[] = [];
  const selectedWrites = new Map<string, string>();
  const conflicts: AdjudicationConflict[] = [];
  for (const candidate of ordered) {
    if (selected.length >= limit) break;
    const writes = proposalWriteSet(candidate.proposal);
    const collisions = [...writes].filter((key) => selectedWrites.has(key));
    if (collisions.length) {
      const winnerProposalId = selectedWrites.get(collisions[0]!)!;
      conflicts.push({ winnerProposalId, loserProposalId: candidate.proposal.proposalId, writeKeys: collisions.sort() });
      continue;
    }
    selected.push(candidate);
    for (const key of writes) selectedWrites.set(key, candidate.proposal.proposalId);
  }
  return { selected, conflicts };
}

function proposalWriteSet(proposal: EventProposal): Set<string> {
  const writes = new Set<string>();
  for (const operation of proposal.proposedDelta.operations) {
    if (operation.op === "activate-rule" || operation.op === "deactivate-rule") writes.add(`rule:${operation.ruleId}`);
    else writes.add(`state:${operation.entityId}:${operation.field}`);
  }
  for (const operation of proposal.proposedKnowledge?.operations ?? []) writes.add(`knowledge:${operation.actorId}:${operation.claimId}`);
  return writes;
}

function deltasConflict(left: EventProposal["proposedDelta"], right?: EventProposal["proposedDelta"]): boolean {
  if (!right) return false;
  const leftWrites = finalStateWrites(left);
  const rightWrites = finalStateWrites(right);
  for (const [key, leftValue] of leftWrites) {
    if (!rightWrites.has(key)) continue;
    if (JSON.stringify(leftValue) !== JSON.stringify(rightWrites.get(key))) return true;
  }
  return false;
}

function effectsEquivalent(proposal: EventProposal, possibility: Possibility): boolean {
  const proposedDelta = possibility.proposedDelta;
  if (!proposedDelta) return false;
  const hasEffect = proposal.proposedDelta.operations.length > 0 || (proposal.proposedKnowledge?.operations.length ?? 0) > 0;
  if (!hasEffect) return false;
  return mapsEqual(finalStateWrites(proposal.proposedDelta), finalStateWrites(proposedDelta))
    && JSON.stringify(proposal.proposedKnowledge?.operations ?? []) === JSON.stringify(possibility.proposedKnowledge?.operations ?? []);
}

function mapsEqual(left: ReadonlyMap<string, unknown>, right: ReadonlyMap<string, unknown>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (!right.has(key) || JSON.stringify(value) !== JSON.stringify(right.get(key))) return false;
  }
  return true;
}

function finalStateWrites(delta: EventProposal["proposedDelta"]): Map<string, unknown> {
  const writes = new Map<string, unknown>();
  for (const operation of delta.operations) {
    if (operation.op === "activate-rule") writes.set(`rule:${operation.ruleId}`, true);
    else if (operation.op === "deactivate-rule") writes.set(`rule:${operation.ruleId}`, false);
    else if (operation.op === "set") writes.set(`state:${operation.entityId}:${operation.field}`, operation.value);
    else if (operation.op === "unset") writes.set(`state:${operation.entityId}:${operation.field}`, { unset: true });
    else if (operation.op === "adjust-number") writes.set(`state:${operation.entityId}:${operation.field}`, { op: operation.op, amount: operation.amount });
    else writes.set(`state:${operation.entityId}:${operation.field}`, { op: operation.op, member: operation.member });
  }
  return writes;
}

function boundedLimit(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error(`${name} must be an integer between 0 and 100`);
  return value;
}
