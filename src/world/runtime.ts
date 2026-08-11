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
  maxBackgroundCandidates?: number;
};

export type MoveResult = {
  previousHead: CommitId;
  newHead: CommitId;
  committedEvents: string[];
  rejectedProposals: string[];
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
  ) {
    this.frontierStore = new FrontierStore(engine.objects.root.replace(/\/objects$/, "").replace(/\/world\/v1$/, ""));
  }

  async forkBranch(parentBranchId: BranchId, forkCommitId: CommitId, newBranchId: BranchId, name: string): Promise<void> {
    const parentHead = await this.engine.branches.readHead(parentBranchId);
    if (!(await this.isAncestor(forkCommitId, parentHead))) {
      throw new Error(`Commit ${forkCommitId} is not an ancestor of branch ${parentBranchId}`);
    }
    await this.engine.branches.create({
      id: newBranchId,
      name,
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

    const limit = input.maxBackgroundCandidates ?? 1;
    if (!Number.isInteger(limit) || limit < 0 || limit > 100) throw new Error("maxBackgroundCandidates must be an integer between 0 and 100");
    let latestFrontier = await this.refreshFrontier(input.branchId, currentHead);

    for (let index = 0; index < limit; index += 1) {
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
      latestFrontier = await this.refreshFrontier(input.branchId, currentHead, new Set([candidate.possibility.id]));
    }

    const state = await this.engine.projector.project(currentHead);
    const renderedText = await this.render?.({ branchId: input.branchId, commitId: currentHead, state, committedEvents });
    return {
      previousHead,
      newHead: currentHead,
      committedEvents,
      rejectedProposals,
      frontier: latestFrontier,
      ...(renderedText ? { renderedText } : {}),
    };
  }

  async refreshFrontier(branchId: BranchId, commitId?: CommitId, realizedIds?: ReadonlySet<string>): Promise<Frontier> {
    const head = commitId ?? (await this.engine.branches.readHead(branchId));
    const state = await this.engine.projector.project(head);
    const templates = await this.possibilitySource({ branchId, commitId: head, state });
    const frontier = buildFrontier(branchId, head, state, templates, { realizedIds });
    await this.frontierStore.write(frontier);
    return frontier;
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
