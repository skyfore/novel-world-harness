import path from "node:path";
import type { ActorProposalCandidate, ActorProposalSource } from "./actors.js";
import type { BranchId, CommitId, EventProposal, Possibility, WorldState } from "./model.js";
import { buildFrontier, FrontierStore, possibilityToProposal, selectEligible, type Frontier } from "./frontier.js";
import { WorldEngine } from "./engine.js";

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
    const workspaceRoot = path.resolve(engine.objects.root, "../../..");
    this.frontierStore = new FrontierStore(workspaceRoot);
  }

  async forkBranch(parentBranchId: BranchId, forkCommitId: CommitId, newBranchId: BranchId, name: string): Promise<void> {
    const parentHead = await this.engine.branches.readHead(parentBranchId);
    if (!(await this.isAncestor(forkCommitId, parentHead))) {
      throw new Error(`Commit ${forkCommitId} is not an ancestor of branch ${parentBranchId}`);
    }
    await this.engine.branches.create({ id: newBranchId, name, parentBranchId, forkCommitId, headCommitId: forkCommitId });
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

    const backgroundLimit = boundedLimit(input.maxBackgroundCandidates ?? 1, "maxBackgroundCandidates");
    let latestFrontier = await this.refreshFrontier(input.branchId, currentHead);
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
      latestFrontier = await this.refreshFrontier(input.branchId, currentHead);
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

  async refreshFrontier(branchId: BranchId, commitId?: CommitId): Promise<Frontier> {
    const head = commitId ?? (await this.engine.branches.readHead(branchId));
    const state = await this.engine.projector.project(head);
    const templates = await this.possibilitySource({ branchId, commitId: head, state });
    const realizedIds = await this.realizedPossibilityIds(head);
    const frontier = buildFrontier(branchId, head, state, templates, { realizedIds });
    await this.frontierStore.write(frontier);
    return frontier;
  }

  async realizedPossibilityIds(commitId: CommitId): Promise<ReadonlySet<string>> {
    const realized = new Set<string>();
    const seen = new Set<string>();
    let cursor: CommitId | undefined = commitId;
    while (cursor) {
      if (seen.has(cursor)) throw new Error(`Commit ancestry cycle detected at ${cursor}`);
      seen.add(cursor);
      const commit = await this.engine.objects.getCommit(cursor);
      for (const eventHash of commit.eventHashes) {
        const event = await this.engine.objects.getEvent(eventHash);
        if (event.possibilityId) realized.add(event.possibilityId);
      }
      cursor = commit.parentCommitId;
    }
    return realized;
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

function boundedLimit(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error(`${name} must be an integer between 0 and 100`);
  return value;
}

