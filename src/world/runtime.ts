import { z } from "zod";
import { actorProposalCandidateSchema, type ActorCandidateSource, type ActorProposalCandidate, type ActorProposalSource } from "./actors.js";
import {
  eventProposalSchema,
  idSchema,
  possibilityKindSchema,
  possibilitySchema,
  type BranchId,
  type CommitId,
  type ActionResourceClaim,
  type EventProposal,
  type EventEffectsRef,
  type EvidenceRef,
  type Possibility,
  type PossibilityKind,
  type Predicate,
  type StoryTime,
  type ValidationReport,
  type WorldState,
} from "./model.js";
import { buildFrontier, deriveDuePossibilities, FrontierStore, possibilityToProposal, selectEligible, type Frontier, type FrontierTemporalMode, type SchedulerTrace } from "./frontier.js";
import { WorldEngine } from "./engine.js";
import { committedHistory } from "./scene.js";
import { immutableClone } from "../util/immutable.js";
import type { PlayerActionCandidate } from "./player-action.js";
import type { ModelPlayConversationMessage } from "./play-conversation.js";
import {
  canonicalAttachmentResolutionSchema,
  evaluateCanonicalBindingOptions,
  type CanonicalAttachmentResolution,
  type CanonicalAttachmentResolver,
  type CanonicalBindingOption,
} from "./canonical-adaptation.js";
import { isActionableKnowledge, KnowledgeProjector } from "./knowledge.js";
import { projectActorScene } from "./scene.js";
import { comparableStoryTime, compareStoryTime } from "./time.js";
import { contentHash } from "./canonical.js";

const MAX_CALLBACK_CANDIDATES = 10_000;
const MAX_PLAYER_WORLD_RESPONSES = 64;

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
  /** Optional allowlist for background scheduling; actor proposals are unaffected. */
  backgroundKinds?: readonly PossibilityKind[];
  /** Host-derived denylist for candidates disproved by a stronger bounded gate. */
  excludedBackgroundPossibilityIds?: readonly string[];
};

export type AdjudicationConflict = {
  winnerProposalId: string;
  loserProposalId: string;
  writeKeys: string[];
  conflictKinds: ActorConflictKind[];
  keys: string[];
};

export type ActorConflictKind =
  | "write-write"
  | "read-write"
  | "resource"
  | "exclusive-participant"
  | "consent"
  | "authority";

export type ActorCandidateFootprint = {
  reads: string[];
  writes: string[];
  resources: ActionResourceClaim[];
  exclusiveParticipantIds: string[];
  consentActorIds: string[];
  authorityEntityIds: string[];
  temporalWindow: StoryTime;
};

export type MoveResult = {
  previousHead: CommitId;
  newHead: CommitId;
  committedEvents: string[];
  rejectedProposals: string[];
  adjudicationConflicts: AdjudicationConflict[];
  frontier: Frontier;
  trace: WorldMoveTrace;
  renderedText?: string;
};

export type MoveDecisionGateTrace = {
  gate: "materiality" | "conflict" | "validation" | "commit";
  outcome: "pass" | "fail" | "info";
  code: string;
  detail: string;
};

export type ProposalFootprintTrace = {
  reads: string[];
  writes: string[];
  resources: ActionResourceClaim[];
  participantIds: string[];
};

export type ProposalBindingTrace = {
  actionSchemaId?: string;
  actionRoleBindings: Array<{ roleId: string; entityIds: string[] }>;
  canonicalRoleBindings: Array<{
    roleId: string;
    canonicalEntityId: string;
    boundEntityId: string;
  }>;
};

export type MoveCandidateTrace = {
  proposalId: string;
  lane: "player" | "actor" | "background";
  candidateSource: "player" | ActorCandidateSource | PossibilityKind;
  status: "accepted" | "rejected" | "conflict";
  gates: MoveDecisionGateTrace[];
  bindings: ProposalBindingTrace;
  footprint: ProposalFootprintTrace;
  scheduler?: SchedulerTrace;
  effectRefs?: EventEffectsRef;
  commitBoundary: {
    beforeHead: CommitId;
    afterHead: CommitId;
    moved: boolean;
    eventHash?: string;
  };
};

export type WorldMoveTrace = {
  version: 1;
  branchId: BranchId;
  previousHead: CommitId;
  finalHead: CommitId;
  actorBudget: number;
  backgroundBudget: number;
  candidates: MoveCandidateTrace[];
};

export type ActorSafeWorldMoveTrace = {
  version: 1;
  advanced: boolean;
  acceptedCount: number;
  rejectedCount: number;
  candidates: Array<{
    lane: MoveCandidateTrace["lane"];
    status: MoveCandidateTrace["status"];
    committed: boolean;
  }>;
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

export type CanonicalRecoveryTrace = {
  scaffoldPossibilityId: string;
  canonicalEventId: string;
  status:
    | "directly-superseded"
    | "already-resolved"
    | "hard-invalidated"
    | "temporarily-unavailable"
    | "exact-event-ready"
    | "no-valid-binding"
    | "resolver-declined"
    | "attached";
  reasons: string[];
  bindingOptionCount?: number;
};

export type CanonicalRecoveryResult = {
  resolution: CanonicalAttachmentResolution;
  previousHead: CommitId;
  newHead: CommitId;
  traces: CanonicalRecoveryTrace[];
  excludedCanonicalPossibilityIds: string[];
  scaffoldPossibilityId?: string;
  canonicalEventId?: string;
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
    const candidateTraces: MoveCandidateTrace[] = [];

    if (input.playerProposal) {
      if (input.playerProposal.branchId !== input.branchId) throw new Error("Player proposal branch does not match Move branch");
      const playerProposal = { ...input.playerProposal, expectedParentCommit: currentHead };
      const beforeHead = currentHead;
      const result = await this.engine.commitProposal(playerProposal);
      candidateTraces.push(await committedMoveCandidateTrace(this.engine, {
        proposal: playerProposal,
        lane: "player",
        candidateSource: "player",
        beforeHead,
        result,
      }));
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
        maxActors: Math.min(actorLimit, 32),
        maxModelCalls: Math.min(actorLimit, 8),
      }));
      const parsedCandidates = actorProposalCandidateSchema.array().max(64)
        .parse(structuredClone(rawCandidates));
      const candidates: ActorProposalCandidate[] = [];
      for (const candidate of parsedCandidates) {
        if (actorProposalHasMaterialEffect(candidate.proposal)) {
          candidates.push(candidate);
          continue;
        }
        rejectedProposals.push(candidate.proposal.proposalId);
        candidateTraces.push(rejectedMoveCandidateTrace({
          proposal: candidate.proposal,
          lane: "actor",
          candidateSource: candidate.candidateSource ?? "injected",
          beforeHead: currentHead,
          status: "rejected",
          gate: {
            gate: "materiality",
            outcome: "fail",
            code: "NO_MATERIAL_EFFECT",
            detail: "Actor candidate has no material state, knowledge, semantic, process, norm, time, utterance, or scene effect.",
          },
          coordination: candidate.coordination,
        }));
      }
      const adjudicated = adjudicateActorCandidates(candidates, actorLimit);
      adjudicationConflicts.push(...adjudicated.conflicts);
      rejectedProposals.push(...adjudicated.conflicts.map((conflict) => conflict.loserProposalId));
      for (const conflict of adjudicated.conflicts) {
        const loser = candidates.find((candidate) => candidate.proposal.proposalId === conflict.loserProposalId)!;
        candidateTraces.push(rejectedMoveCandidateTrace({
          proposal: loser.proposal,
          lane: "actor",
          candidateSource: loser.candidateSource ?? "injected",
          beforeHead: currentHead,
          status: "conflict",
          gate: {
            gate: "conflict",
            outcome: "fail",
            code: `ACTOR_${conflict.conflictKinds.join("_").toUpperCase().replaceAll("-", "_")}_CONFLICT`,
            detail: `Candidate conflicts with ${conflict.winnerProposalId} on ${conflict.keys.join(", ")}.`,
          },
          coordination: loser.coordination,
        }));
      }
      for (const candidate of adjudicated.selected) {
        const observedHead = await this.engine.branches.readHead(input.branchId);
        if (observedHead !== currentHead) {
          throw new Error(`Cannot revalidate actor candidate at stale head ${currentHead}; current branch head is ${observedHead}`);
        }
        const proposal = { ...candidate.proposal, branchId: input.branchId, expectedParentCommit: currentHead };
        const beforeHead = currentHead;
        const result = await this.engine.commitProposal(proposal);
        candidateTraces.push(await committedMoveCandidateTrace(this.engine, {
          proposal,
          lane: "actor",
          candidateSource: candidate.candidateSource ?? "injected",
          beforeHead,
          result,
          coordination: candidate.coordination,
        }));
        if (!result.report.accepted) {
          rejectedProposals.push(proposal.proposalId);
          continue;
        }
        currentHead = result.newHead;
        if (result.eventHash) committedEvents.push(result.eventHash);
      }
    }

    const backgroundLimit = boundedLimit(input.maxBackgroundCandidates ?? 0, "maxBackgroundCandidates");
    const backgroundKinds = input.backgroundKinds
      ? new Set(possibilityKindSchema.array().max(8).parse(input.backgroundKinds))
      : undefined;
    const excludedBackgroundPossibilityIds = new Set(
      idSchema.array().max(MAX_CALLBACK_CANDIDATES).parse(input.excludedBackgroundPossibilityIds ?? []),
    );
    const temporalMode = backgroundLimit > 0 ? input.temporalMode ?? "advance" : "current-window";
    let latestFrontier = await this.refreshFrontier(input.branchId, currentHead, { temporalMode });
    const rejectedAtHead = new Set<string>();
    let backgroundCommits = 0;
    for (let attempt = 0; attempt < MAX_CALLBACK_CANDIDATES && backgroundCommits < backgroundLimit; attempt += 1) {
      const candidate = selectEligible(
        backgroundKinds
          ? {
              ...latestFrontier,
              evaluated: latestFrontier.evaluated.filter((entry) =>
                !excludedBackgroundPossibilityIds.has(entry.possibility.id)
                && !rejectedAtHead.has(entry.possibility.id)
                && backgroundKinds.has(entry.possibility.kind)
                && Boolean(possibilityToProposal(entry))),
            }
          : {
              ...latestFrontier,
              evaluated: latestFrontier.evaluated.filter((entry) =>
                !excludedBackgroundPossibilityIds.has(entry.possibility.id)
                && !rejectedAtHead.has(entry.possibility.id)
                && Boolean(possibilityToProposal(entry))),
            },
        1,
      )[0];
      if (!candidate) break;
      const proposal = possibilityToProposal(candidate);
      if (!proposal) break;
      const beforeHead = currentHead;
      const result = await this.engine.commitProposal(proposal);
      candidateTraces.push(await committedMoveCandidateTrace(this.engine, {
        proposal,
        lane: "background",
        candidateSource: candidate.possibility.kind,
        beforeHead,
        result,
        scheduler: candidate.trace,
      }));
      if (!result.report.accepted) {
        rejectedProposals.push(proposal.proposalId);
        rejectedAtHead.add(candidate.possibility.id);
        continue;
      }
      backgroundCommits += 1;
      rejectedAtHead.clear();
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
      trace: {
        version: 1,
        branchId: input.branchId,
        previousHead,
        finalHead: currentHead,
        actorBudget: actorLimit,
        backgroundBudget: backgroundLimit,
        candidates: candidateTraces,
      },
      ...(renderedText ? { renderedText } : {}),
    };
  }

  async refreshFrontier(
    branchId: BranchId,
    commitId?: CommitId,
    options: { temporalMode?: FrontierTemporalMode } = {},
  ): Promise<Frontier> {
    const head = commitId ?? (await this.engine.branches.readHead(branchId));
    const [projection, context, temporalAnchor, activity] = await Promise.all([
      this.engine.projections.project(head),
      this.engine.contextForCommit(head),
      this.temporalAnchor(head),
      this.branchActivity(head),
    ]);
    const state = projection.state;
    const rawTemplates = await this.possibilitySource(immutableClone({ branchId, commitId: head, state }));
    const due = deriveDuePossibilities({
      branchId,
      commitId: head,
      state,
      processes: projection.processes,
      norms: projection.norms,
      processTemplates: context.processTemplates ?? new Map(),
      normTemplates: context.normTemplates ?? new Map(),
    });
    const templates = possibilitySchema.array().max(MAX_CALLBACK_CANDIDATES)
      .parse(structuredClone([...rawTemplates, ...due]));
    const duplicateId = templates.find((template, index) => templates.findIndex((candidate) => candidate.id === template.id) !== index)?.id;
    if (duplicateId) throw new Error(`Duplicate possibility id ${duplicateId} in the current frontier`);
    const history = await this.possibilityHistory(head);
    const frontier = buildFrontier(branchId, head, state, templates, {
      realizedIds: history.realizedIds,
      adaptedIds: history.adaptedIds,
      supersededIds: history.supersededIds,
      realizationEventIds: history.realizationEventIds,
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
      && !entry.possibility.canonicalScaffold
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
        && !entry.possibility.canonicalScaffold
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
      causalRelations: [
        ...(baseProposal.causalRelations ?? []),
        ...(input.causalParentEventId ? [{
          fromEventId: input.causalParentEventId,
          type: "causes" as const,
          operationality: "contributory" as const,
          description: "Immediate world response to the committed player event",
        }] : []),
      ],
      causalParents: [...new Set([
        ...(baseProposal.causalRelations ?? []).map((relation) => relation.fromEventId),
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

  /**
   * Reuses one explicitly compiled canonical scaffold after branch divergence.
   * The host scans in story-time order, enumerates only bindings that satisfy
   * hard state/knowledge/causal constraints, and lets the model select one
   * opaque binding plus bounded observations/affect. Core effects stay locked.
   */
  async recoverCanonicalTrajectory(input: {
    branchId: BranchId;
    actorId: string;
    expectedHead: CommitId;
    resolver: CanonicalAttachmentResolver;
    temporalMode?: FrontierTemporalMode;
    maxResolverCandidates?: number;
  }): Promise<CanonicalRecoveryResult> {
    const actualHead = await this.engine.branches.readHead(input.branchId);
    if (actualHead !== input.expectedHead) {
      throw new Error(`Cannot recover canonical trajectory at stale commit ${input.expectedHead}; current head is ${actualHead}`);
    }
    const maxResolverCandidates = input.maxResolverCandidates ?? 3;
    if (!Number.isInteger(maxResolverCandidates) || maxResolverCandidates < 0 || maxResolverCandidates > 10) {
      throw new Error("maxResolverCandidates must be an integer between 0 and 10");
    }
    const temporalMode = input.temporalMode ?? "current-window";
    const [frontier, context, state, history, possibilityHistory, scene, knowledge] = await Promise.all([
      this.refreshFrontier(input.branchId, input.expectedHead, { temporalMode }),
      this.engine.contextForCommit(input.expectedHead),
      this.engine.projector.project(input.expectedHead),
      committedHistory(this.engine, input.expectedHead),
      this.possibilityHistory(input.expectedHead),
      projectActorScene(this.engine, input.actorId, input.expectedHead),
      new KnowledgeProjector(this.engine).project(input.expectedHead),
    ]);
    const traces: CanonicalRecoveryTrace[] = [];
    const excludedCanonicalPossibilityIds = new Set<string>();
    if (!possibilityHistory.supersededIds.size || maxResolverCandidates === 0) {
      return {
        resolution: { decision: "none" },
        previousHead: input.expectedHead,
        newHead: input.expectedHead,
        traces,
        excludedCanonicalPossibilityIds: [],
      };
    }
    const activeEntityIds = new Set<string>(scene.presentEntityIds);
    if (scene.locationId) activeEntityIds.add(scene.locationId);
    const availableEntityIds = new Set<string>([
      ...Object.keys(state.values),
      ...history.flatMap(({ event }) => event.participants),
    ]);
    const knownClaimIdsByActor = new Map<string, ReadonlySet<string>>(
      Object.entries(knowledge.actors).map(([actorId, claims]) => [
        actorId,
        new Set(Object.values(claims).filter(isActionableKnowledge).map((fact) => fact.claimId)),
      ]),
    );
    const candidates = frontier.evaluated
      .filter((entry) => Boolean(entry.possibility.canonicalScaffold && entry.possibility.canonicalEventId))
      .sort((left, right) => compareCanonicalRecoveryOrder(left.possibility, right.possibility)
        || left.possibility.id.localeCompare(right.possibility.id));
    let resolverCalls = 0;
    for (const entry of candidates) {
      const scaffold = entry.possibility;
      const canonicalEventId = scaffold.canonicalEventId!;
      const directCanonicalId = `canon-${canonicalEventId}`;
      const traceBase = { scaffoldPossibilityId: scaffold.id, canonicalEventId };
      if (possibilityHistory.supersededIds.has(directCanonicalId)) {
        traces.push({ ...traceBase, status: "directly-superseded", reasons: ["the scaffold's own canonical event was directly replaced by branch history"] });
        continue;
      }
      if (["realized", "adapted", "superseded"].includes(entry.status)) {
        traces.push({ ...traceBase, status: "already-resolved", reasons: [...entry.reasons] });
        continue;
      }
      if (["invalidated", "expired"].includes(entry.status)) {
        traces.push({ ...traceBase, status: "hard-invalidated", reasons: [...entry.reasons] });
        continue;
      }
      const exact = frontier.evaluated.find((candidate) => candidate.possibility.id === directCanonicalId);
      if (exact?.status === "realized" || exact?.status === "adapted") {
        traces.push({
          ...traceBase,
          status: "already-resolved",
          reasons: [exact.status === "adapted"
            ? "a committed functional analogue already fulfills this canonical development"
            : "the exact canonical event is already realized"],
        });
        continue;
      }
      const bindingEvaluation = await evaluateCanonicalBindingOptions({
        scaffold,
        context,
        state,
        knownClaimIdsByActor,
        availableEntityIds,
        activeEntityIds,
        realizedIds: possibilityHistory.realizedIds,
        adaptedIds: possibilityHistory.adaptedIds,
        supersededIds: possibilityHistory.supersededIds,
        temporalMode,
      });
      const canonicalSelfBinding = bindingEvaluation.options.find((option) =>
        option.bindings.every((binding) => binding.canonicalEntityId === binding.boundEntityId));
      const adaptationOptions = bindingEvaluation.options.filter((option) =>
        option.bindings.some((binding) => binding.canonicalEntityId !== binding.boundEntityId));
      if (exact?.status === "eligible" && canonicalSelfBinding) {
        traces.push({
          ...traceBase,
          status: "exact-event-ready",
          reasons: ["the exact canonical event and its canonical role bindings remain eligible"],
          bindingOptionCount: bindingEvaluation.options.length,
        });
        break;
      }
      if (exact?.status === "eligible" && !canonicalSelfBinding) {
        // The scaffold carries stronger functional role gates than the base
        // source event. Do not let the ordinary scheduler immediately bypass
        // those gates with the exact fixed-participant candidate.
        excludedCanonicalPossibilityIds.add(directCanonicalId);
      }
      if (!adaptationOptions.length) {
        const exactGateReason = excludedCanonicalPossibilityIds.has(directCanonicalId)
          ? ["the exact fixed-participant candidate failed the scaffold's stronger role gates and was excluded from this move"]
          : [];
        const bindingReasons = bindingEvaluation.options.length
          ? ["no non-canonical role remapping satisfies the scaffold; canonical-self execution remains on the exact-event path"]
          : (bindingEvaluation.reasons.length ? bindingEvaluation.reasons : entry.reasons);
        traces.push({
          ...traceBase,
          status: entry.status === "latent" || entry.status === "blocked" ? "temporarily-unavailable" : "no-valid-binding",
          reasons: [...exactGateReason, ...bindingReasons],
          bindingOptionCount: adaptationOptions.length,
        });
        continue;
      }
      if (resolverCalls >= maxResolverCandidates) break;
      resolverCalls += 1;
      const canonicalEvent = context.events?.get(canonicalEventId);
      if (!canonicalEvent) {
        traces.push({ ...traceBase, status: "hard-invalidated", reasons: ["the pinned canonical source event is unavailable"] });
        continue;
      }
      const rawResolution = await input.resolver(immutableClone({
        canonicalEvent: {
          title: modelSafeText(canonicalEvent.title, context),
          ...(canonicalEvent.readerSummary ? { readerSummary: modelSafeText(canonicalEvent.readerSummary, context) } : {}),
        },
        scaffold: {
          title: modelSafeText(scaffold.title, context),
        },
        bindingOptions: adaptationOptions.map((option) => bindingOptionView(option, scaffold, context)),
        recentCommittedEvents: history.slice(-8).map(({ event }) => ({
          title: modelSafeText(event.title, context),
          participantNames: event.participants.map((participant) => context.entities.get(participant)?.canonicalName ?? "unknown entity"),
        })),
      }));
      const resolution = canonicalAttachmentResolutionSchema.parse(structuredClone(rawResolution));
      if (resolution.decision === "none") {
        traces.push({
          ...traceBase,
          status: "resolver-declined",
          reasons: [
            ...(excludedCanonicalPossibilityIds.has(directCanonicalId)
              ? ["the exact fixed-participant candidate failed the scaffold's stronger role gates and was excluded from this move"]
              : []),
            "the bounded semantic adapter found no coherent attachment",
          ],
          bindingOptionCount: adaptationOptions.length,
        });
        continue;
      }
      const selected = adaptationOptions.find((option) => option.bindingOptionId === resolution.bindingOptionId);
      if (!selected) throw new Error(`Canonical attachment selected an unoffered binding ${resolution.bindingOptionId}`);
      const boundByRole = new Map(selected.bindings.map((binding) => [binding.roleId, binding.boundEntityId]));
      const actorObservations = resolution.roleObservations.map((observation) => {
        const actorId = boundByRole.get(observation.roleId);
        if (!actorId || context.entities.get(actorId)?.kind !== "character") {
          throw new Error(`Canonical attachment observation references non-character or unknown role ${observation.roleId}`);
        }
        return { actorId, summary: observation.summary };
      });
      const actorAffects = resolution.roleAffects.map((affect) => {
        const actorId = boundByRole.get(affect.roleId);
        if (!actorId || context.entities.get(actorId)?.kind !== "character") {
          throw new Error(`Canonical attachment affect references non-character or unknown role ${affect.roleId}`);
        }
        return {
          actorId,
          label: affect.label,
          intensity: affect.intensity,
          ...(affect.expression ? { expression: affect.expression } : {}),
        };
      });
      const possibility = selected.possibility;
      const proposal = eventProposalSchema.parse({
        proposalId: `canon-adapt-${contentHash({
          scaffoldId: scaffold.id,
          at: input.expectedHead,
          bindings: selected.bindings,
          title: resolution.title,
        }).slice(0, 24)}`,
        branchId: input.branchId,
        expectedParentCommit: input.expectedHead,
        source: "canon-candidate",
        title: resolution.title,
        ...(actorObservations.length ? { actorObservations } : {}),
        ...(actorAffects.length ? { actorAffects } : {}),
        participants: possibility.participants,
        ...(possibility.participantPresence ? { participantPresence: possibility.participantPresence } : {}),
        proposedTime: possibility.candidateWindow ?? { kind: "unknown" },
        ...(possibility.timeAdvance ? { timeAdvance: possibility.timeAdvance } : {}),
        preconditions: possibility.preconditions,
        proposedDelta: possibility.proposedDelta!,
        ...(possibility.proposedKnowledge ? { proposedKnowledge: possibility.proposedKnowledge } : {}),
        causalParents: possibility.causalParents,
        evidence: possibility.evidence,
        possibilityId: scaffold.id,
        canonicalAdaptation: {
          version: 1,
          scaffoldPossibilityId: scaffold.id,
          adaptedFromCanonicalEventId: canonicalEventId,
          sceneActorId: input.actorId,
          roleBindings: selected.bindings,
          coreEffectHash: selected.coreEffectHash,
        },
        progress: {
          version: 1,
          channels: ["thread", "consequence"],
          threadIds: [scaffold.id, directCanonicalId],
          noveltyKey: `canonical-adaptation:${scaffold.id}:${contentHash(selected.bindings).slice(0, 16)}`,
          outcome: "succeeded",
        },
      });
      const committed = await this.engine.commitProposal(proposal);
      if (!committed.report.accepted) {
        const details = committed.report.errors.map((issue) => `${issue.code}: ${issue.message}`).join("; ");
        throw new Error(`Canonical attachment was rejected: ${details || "unknown validation failure"}`);
      }
      traces.push({
        ...traceBase,
        status: "attached",
        reasons: [
          ...(excludedCanonicalPossibilityIds.has(directCanonicalId)
            ? ["the exact fixed-participant candidate failed the scaffold's stronger role gates"]
            : []),
          "a host-validated role binding instantiated the locked canonical scaffold",
        ],
        bindingOptionCount: adaptationOptions.length,
      });
      return {
        resolution,
        previousHead: input.expectedHead,
        newHead: committed.newHead,
        traces,
        excludedCanonicalPossibilityIds: [...excludedCanonicalPossibilityIds].sort(),
        scaffoldPossibilityId: scaffold.id,
        canonicalEventId,
        title: resolution.title,
        ...(committed.eventHash ? { eventHash: committed.eventHash } : {}),
      };
    }
    return {
      resolution: { decision: "none" },
      previousHead: input.expectedHead,
      newHead: input.expectedHead,
      traces,
      excludedCanonicalPossibilityIds: [...excludedCanonicalPossibilityIds].sort(),
    };
  }

  private async possibilityHistory(commitId: CommitId): Promise<{
    realizedIds: ReadonlySet<string>;
    adaptedIds: ReadonlySet<string>;
    supersededIds: ReadonlySet<string>;
    realizationEventIds: ReadonlyMap<string, string>;
  }> {
    const realized = new Set<string>();
    const adapted = new Set<string>();
    const superseded = new Set<string>();
    const realizationEventIds = new Map<string, string>();
    const seen = new Set<string>();
    let cursor: CommitId | undefined = commitId;
    while (cursor) {
      if (seen.has(cursor)) throw new Error(`Commit ancestry cycle detected at ${cursor}`);
      seen.add(cursor);
      const commit = await this.engine.objects.getCommit(cursor);
      for (const eventHash of commit.eventHashes) {
        const event = await this.engine.objects.getEvent(eventHash);
        realized.add(event.eventId);
        realizationEventIds.set(event.eventId, event.eventId);
        if (event.possibilityId) {
          realized.add(event.possibilityId);
          realizationEventIds.set(event.possibilityId, event.eventId);
        }
        for (const eventId of event.realizesCanonicalEventIds ?? []) {
          realized.add(eventId);
          realized.add(`canon-${eventId}`);
          realizationEventIds.set(eventId, event.eventId);
          realizationEventIds.set(`canon-${eventId}`, event.eventId);
        }
        if (event.canonicalAdaptation) {
          const eventId = event.canonicalAdaptation.adaptedFromCanonicalEventId;
          adapted.add(eventId);
          adapted.add(`canon-${eventId}`);
          realizationEventIds.set(eventId, event.eventId);
          realizationEventIds.set(`canon-${eventId}`, event.eventId);
        }
        for (const eventId of event.supersedesCanonicalEventIds ?? []) superseded.add(`canon-${eventId}`);
      }
      cursor = commit.parentCommitId;
    }
    return { realizedIds: realized, adaptedIds: adapted, supersededIds: superseded, realizationEventIds };
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
    if (typeof value === "string") return context.entities.get(value)?.canonicalName ?? modelSafeText(value, context);
    if (Array.isArray(value)) return `[${value.map((item) => typeof item === "string"
      ? context.entities.get(item)?.canonicalName ?? modelSafeText(item, context)
      : JSON.stringify(modelSafeValue(item, context))).join(", ")}]`;
    return JSON.stringify(modelSafeValue(value, context));
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

function bindingOptionView(
  option: CanonicalBindingOption,
  scaffold: Possibility,
  context: Awaited<ReturnType<WorldEngine["contextForCommit"]>>,
) {
  const roleById = new Map(scaffold.canonicalScaffold!.roles.map((role) => [role.roleId, role]));
  const description = describePlayerWorldResponse(option.possibility, context);
  return {
    bindingOptionId: option.bindingOptionId,
    stateEffects: description.stateEffects,
    knowledgeEffects: description.knowledgeEffects,
    roles: option.bindings.map((binding) => {
      const role = roleById.get(binding.roleId)!;
      return {
        roleId: role.roleId,
        description: modelSafeText(role.description, context),
        canonicalName: context.entities.get(binding.canonicalEntityId)?.canonicalName ?? "unknown canonical participant",
        boundName: context.entities.get(binding.boundEntityId)?.canonicalName ?? "unknown current participant",
        boundKind: context.entities.get(binding.boundEntityId)?.kind ?? "unknown",
      };
    }),
  };
}

function modelSafeValue(
  value: unknown,
  context: Awaited<ReturnType<WorldEngine["contextForCommit"]>>,
): unknown {
  if (typeof value === "string") return context.entities.get(value)?.canonicalName ?? modelSafeText(value, context);
  if (Array.isArray(value)) return value.map((item) => modelSafeValue(item, context));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    modelSafeText(key, context),
    modelSafeValue(item, context),
  ]));
}

function modelSafeText(
  value: string,
  context: Awaited<ReturnType<WorldEngine["contextForCommit"]>>,
): string {
  let result = value;
  const entities = [...context.entities.values()].sort((left, right) => right.id.length - left.id.length);
  for (const entity of entities) {
    const escaped = entity.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|[^A-Za-z0-9._-])${escaped}(?=$|[^A-Za-z0-9._-])`, "gu");
    result = result.replace(pattern, (_match, prefix: string) => `${prefix}${entity.canonicalName}`);
  }
  return result;
}

function compareCanonicalRecoveryOrder(left: Possibility, right: Possibility): number {
  const leftTime = comparableStoryTime(left.candidateWindow);
  const rightTime = comparableStoryTime(right.candidateWindow);
  if (leftTime && rightTime && leftTime.scale === rightTime.scale && leftTime.min !== rightTime.min) {
    return leftTime.min - rightTime.min;
  }
  if (leftTime && !rightTime) return -1;
  if (!leftTime && rightTime) return 1;
  const evidenceOrder = (possibility: Possibility) => possibility.evidence.reduce(
    (earliest, reference) => Math.min(earliest, reference.span.startLine),
    Number.POSITIVE_INFINITY,
  );
  return evidenceOrder(left) - evidenceOrder(right);
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
  const footprints = new Map(ordered.map((candidate) => [candidate.proposal.proposalId, actorCandidateFootprint(candidate)]));
  const conflicts: AdjudicationConflict[] = [];
  for (const candidate of ordered) {
    if (selected.length >= limit) break;
    const footprint = footprints.get(candidate.proposal.proposalId)!;
    const collision = selected
      .map((winner) => ({ winner, conflict: actorFootprintConflict(footprints.get(winner.proposal.proposalId)!, footprint, winner, candidate) }))
      .find((entry) => entry.conflict.keys.length > 0);
    if (collision) {
      conflicts.push({
        winnerProposalId: collision.winner.proposal.proposalId,
        loserProposalId: candidate.proposal.proposalId,
        writeKeys: collision.conflict.writeKeys,
        conflictKinds: collision.conflict.kinds,
        keys: collision.conflict.keys,
      });
      continue;
    }
    selected.push(candidate);
  }
  return { selected, conflicts };
}

export function actorCandidateFootprint(candidate: ActorProposalCandidate): ActorCandidateFootprint {
  const footprint = proposalFootprint(candidate.proposal, candidate.coordination);
  return {
    reads: footprint.reads,
    writes: footprint.writes,
    resources: footprint.resources,
    exclusiveParticipantIds: [...new Set([
      ...(candidate.proposal.actorId ? [candidate.proposal.actorId] : []),
      ...(candidate.coordination?.exclusiveParticipantIds ?? []),
    ])].sort(),
    consentActorIds: [...new Set(candidate.coordination?.consentActorIds ?? [])].sort(),
    authorityEntityIds: [...new Set(candidate.coordination?.authorityEntityIds ?? [])].sort(),
    temporalWindow: structuredClone(candidate.proposal.proposedTime),
  };
}

export function actorSafeWorldMoveTrace(trace: WorldMoveTrace): ActorSafeWorldMoveTrace {
  return {
    version: 1,
    advanced: trace.previousHead !== trace.finalHead,
    acceptedCount: trace.candidates.filter((candidate) => candidate.status === "accepted").length,
    rejectedCount: trace.candidates.filter((candidate) => candidate.status !== "accepted").length,
    candidates: trace.candidates.map((candidate) => ({
      lane: candidate.lane,
      status: candidate.status,
      committed: candidate.commitBoundary.moved,
    })),
  };
}

function proposalFootprint(
  proposal: EventProposal,
  coordination?: ActorProposalCandidate["coordination"],
): ProposalFootprintTrace {
  const reads = new Set<string>();
  const writes = new Set<string>();
  proposal.preconditions.forEach((predicate) => predicateReadKeys(predicate).forEach((key) => reads.add(key)));
  for (const operation of proposal.proposedDelta.operations) {
    if (operation.op === "activate-rule" || operation.op === "deactivate-rule") writes.add(`rule:${operation.ruleId}`);
    else writes.add(`state:${operation.entityId}:${operation.field}`);
  }
  for (const operation of proposal.proposedKnowledge?.operations ?? []) writes.add(`knowledge:${operation.actorId}:${operation.claimId}`);
  if (proposal.timeAdvance) writes.add("time:branch-clock");
  const resources = proposal.action?.lane === "ad-hoc"
    ? proposal.action.footprint.resources.map((claim) => structuredClone(claim))
    : [];
  if (proposal.action?.lane === "ad-hoc") {
    for (const address of proposal.action.footprint.reads) reads.add(`state:${address.entityId}:${address.field}`);
    for (const address of proposal.action.footprint.writes) writes.add(`state:${address.entityId}:${address.field}`);
  }
  return {
    reads: [...reads].sort(),
    writes: [...writes].sort(),
    resources: resources.sort((left, right) => resourceKey(left).localeCompare(resourceKey(right)) || left.mode.localeCompare(right.mode)),
    participantIds: [...new Set([
      ...proposal.participants,
      ...(coordination?.exclusiveParticipantIds ?? []),
      ...(coordination?.consentActorIds ?? []),
      ...(coordination?.authorityEntityIds ?? []),
    ])].sort(),
  };
}

async function committedMoveCandidateTrace(
  engine: WorldEngine,
  input: {
    proposal: EventProposal;
    lane: MoveCandidateTrace["lane"];
    candidateSource: MoveCandidateTrace["candidateSource"];
    beforeHead: CommitId;
    result: { report: ValidationReport; newHead: CommitId; eventHash?: string };
    coordination?: ActorProposalCandidate["coordination"];
    scheduler?: SchedulerTrace;
  },
): Promise<MoveCandidateTrace> {
  const accepted = input.result.report.accepted;
  const gates: MoveDecisionGateTrace[] = [];
  for (const issue of input.result.report.errors) gates.push({
    gate: "validation",
    outcome: "fail",
    code: issue.code,
    detail: issue.message,
  });
  for (const issue of input.result.report.warnings) gates.push({
    gate: "validation",
    outcome: "info",
    code: issue.code,
    detail: issue.message,
  });
  if (accepted) gates.unshift({
    gate: "validation",
    outcome: "pass",
    code: "VALIDATION_ACCEPTED",
    detail: "Deterministic proposal validation passed.",
  });
  else if (!gates.some((gate) => gate.outcome === "fail")) gates.push({
    gate: "validation",
    outcome: "fail",
    code: "VALIDATION_REJECTED",
    detail: "Deterministic proposal validation rejected the candidate.",
  });
  gates.push({
    gate: "commit",
    outcome: accepted && input.result.newHead !== input.beforeHead ? "pass" : "fail",
    code: accepted && input.result.newHead !== input.beforeHead ? "COMMIT_ADVANCED_HEAD" : "COMMIT_DID_NOT_ADVANCE_HEAD",
    detail: accepted && input.result.newHead !== input.beforeHead
      ? "Validated effects crossed the atomic commit boundary."
      : "No effects crossed the commit boundary.",
  });
  const event = accepted && input.result.eventHash
    ? await engine.objects.getEvent(input.result.eventHash)
    : undefined;
  return {
    proposalId: input.proposal.proposalId,
    lane: input.lane,
    candidateSource: input.candidateSource,
    status: accepted ? "accepted" : "rejected",
    gates,
    bindings: proposalBindings(input.proposal),
    footprint: proposalFootprint(input.proposal, input.coordination),
    ...(input.scheduler ? { scheduler: structuredClone(input.scheduler) } : {}),
    ...(event ? { effectRefs: structuredClone(event.effects) } : {}),
    commitBoundary: {
      beforeHead: input.beforeHead,
      afterHead: input.result.newHead,
      moved: input.result.newHead !== input.beforeHead,
      ...(input.result.eventHash ? { eventHash: input.result.eventHash } : {}),
    },
  };
}

function rejectedMoveCandidateTrace(input: {
  proposal: EventProposal;
  lane: MoveCandidateTrace["lane"];
  candidateSource: MoveCandidateTrace["candidateSource"];
  beforeHead: CommitId;
  status: "rejected" | "conflict";
  gate: MoveDecisionGateTrace;
  coordination?: ActorProposalCandidate["coordination"];
}): MoveCandidateTrace {
  return {
    proposalId: input.proposal.proposalId,
    lane: input.lane,
    candidateSource: input.candidateSource,
    status: input.status,
    gates: [input.gate],
    bindings: proposalBindings(input.proposal),
    footprint: proposalFootprint(input.proposal, input.coordination),
    commitBoundary: {
      beforeHead: input.beforeHead,
      afterHead: input.beforeHead,
      moved: false,
    },
  };
}

function proposalBindings(proposal: EventProposal): ProposalBindingTrace {
  return {
    ...(proposal.action?.lane === "schema-bound" ? { actionSchemaId: proposal.action.schemaId } : {}),
    actionRoleBindings: proposal.action?.lane === "schema-bound"
      ? proposal.action.roleBindings.map((binding) => ({
          roleId: binding.roleId,
          entityIds: [...binding.entityIds],
        }))
      : [],
    canonicalRoleBindings: (proposal.canonicalAdaptation?.roleBindings ?? []).map((binding) => ({
      roleId: binding.roleId,
      canonicalEntityId: binding.canonicalEntityId,
      boundEntityId: binding.boundEntityId,
    })),
  };
}

function actorFootprintConflict(
  left: ActorCandidateFootprint,
  right: ActorCandidateFootprint,
  leftCandidate: ActorProposalCandidate,
  rightCandidate: ActorProposalCandidate,
): { kinds: ActorConflictKind[]; keys: string[]; writeKeys: string[] } {
  if (!actorWindowsMayOverlap(left.temporalWindow, right.temporalWindow)) return { kinds: [], keys: [], writeKeys: [] };
  const kinds = new Set<ActorConflictKind>();
  const keys = new Set<string>();
  const writeKeys = new Set<string>();
  const leftReads = new Set(left.reads);
  const rightReads = new Set(right.reads);
  const leftWrites = new Set(left.writes);
  const rightWrites = new Set(right.writes);
  for (const key of intersection(leftWrites, rightWrites)) {
    kinds.add("write-write");
    keys.add(key);
    writeKeys.add(key);
  }
  for (const key of [...intersection(leftReads, rightWrites), ...intersection(rightReads, leftWrites)]) {
    kinds.add("read-write");
    keys.add(key);
    writeKeys.add(key);
  }
  for (const leftClaim of left.resources) {
    for (const rightClaim of right.resources) {
      if (resourceKey(leftClaim) !== resourceKey(rightClaim)) continue;
      if (leftClaim.mode === "read" && rightClaim.mode === "read") continue;
      kinds.add("resource");
      keys.add(`resource:${resourceKey(leftClaim)}`);
    }
  }
  for (const entityId of intersection(new Set(left.exclusiveParticipantIds), new Set(right.exclusiveParticipantIds))) {
    kinds.add("exclusive-participant");
    keys.add(`participant:${entityId}`);
  }
  addCoordinationDependencyConflicts("consent", left.consentActorIds, right, rightCandidate, kinds, keys);
  addCoordinationDependencyConflicts("consent", right.consentActorIds, left, leftCandidate, kinds, keys);
  addCoordinationDependencyConflicts("authority", left.authorityEntityIds, right, rightCandidate, kinds, keys);
  addCoordinationDependencyConflicts("authority", right.authorityEntityIds, left, leftCandidate, kinds, keys);
  return {
    kinds: [...kinds].sort(),
    keys: [...keys].sort(),
    writeKeys: [...writeKeys].sort(),
  };
}

function addCoordinationDependencyConflicts(
  kind: "consent" | "authority",
  dependencies: readonly string[],
  other: ActorCandidateFootprint,
  otherCandidate: ActorProposalCandidate,
  kinds: Set<ActorConflictKind>,
  keys: Set<string>,
): void {
  const otherActorId = otherCandidate.proposal.actorId;
  for (const entityId of dependencies) {
    const otherWritesEntity = other.writes.some((key) => key.startsWith(`state:${entityId}:`));
    if (otherActorId !== entityId && !other.exclusiveParticipantIds.includes(entityId) && !otherWritesEntity) continue;
    kinds.add(kind);
    keys.add(`${kind}:${entityId}`);
  }
}

function predicateReadKeys(predicate: Predicate): string[] {
  if (predicate.op === "all" || predicate.op === "any") return predicate.items.flatMap(predicateReadKeys);
  if (predicate.op === "not") return predicateReadKeys(predicate.item);
  if (predicate.op === "rule-active") return [`rule:${predicate.ruleId}`];
  if ("entityId" in predicate && "field" in predicate) return [`state:${predicate.entityId}:${predicate.field}`];
  if (["after-step", "before-step", "elapsed-days-gte", "elapsed-days-lte", "story-time-at-or-after", "story-time-before"].includes(predicate.op)) {
    return ["time:branch-clock"];
  }
  return [];
}

function actorWindowsMayOverlap(left: StoryTime, right: StoryTime): boolean {
  const order = compareStoryTime(left, right);
  return order === undefined || order === 0;
}

function resourceKey(claim: ActionResourceClaim): string {
  return `${claim.entityId}:${claim.field}`;
}

function intersection(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((key) => right.has(key)).sort();
}

function actorProposalHasMaterialEffect(proposal: EventProposal): boolean {
  return proposal.proposedDelta.operations.length > 0
    || (proposal.proposedKnowledge?.operations.length ?? 0) > 0
    || (proposal.proposedSemantics?.operations.length ?? 0) > 0
    || (proposal.proposedProcesses?.operations.length ?? 0) > 0
    || (proposal.proposedNorms?.operations.length ?? 0) > 0
    || (proposal.spokenUtterances?.length ?? 0) > 0
    || Boolean(proposal.timeAdvance)
    || Boolean(proposal.progress?.scene);
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
