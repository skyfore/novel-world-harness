import type { ActorProposalCandidate, ActorProposalSource } from "./actors.js";
import type { BranchId, CommitId, EventProposal, EvidenceRef, Possibility, StoryTime, WorldState } from "./model.js";
import { buildFrontier, FrontierStore, possibilityToProposal, selectEligible, type Frontier, type FrontierTemporalMode } from "./frontier.js";
import { WorldEngine } from "./engine.js";
import { committedHistory } from "./scene.js";

export type PossibilitySource = (input: {
  branchId: BranchId;
  commitId: CommitId;
  state: WorldState;
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

export type NarrativeRender = (input: {
  branchId: BranchId;
  commitId: CommitId;
  state: WorldState;
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
      const candidates = await this.actorProposalSource({ branchId: input.branchId, commitId: currentHead });
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
    const renderedText = await this.render?.({ branchId: input.branchId, commitId: currentHead, state, committedEvents });
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
    const templates = await this.possibilitySource({ branchId, commitId: head, state });
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
  const titleScore = lexicalAffinity(proposal.title, possibility.title);
  return participantScore * 0.35 + writeScore * 0.45 + titleScore * 0.2;
}

function lexicalAffinity(left: string, right: string): number {
  const tokens = (value: string) => new Set(
    value.normalize("NFKC").toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 1),
  );
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / new Set([...leftTokens, ...rightTokens]).size;
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
    else writes.set(`state:${operation.entityId}:${operation.field}`, { op: operation.op, member: operation.member });
  }
  return writes;
}

function boundedLimit(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error(`${name} must be an integer between 0 and 100`);
  return value;
}
