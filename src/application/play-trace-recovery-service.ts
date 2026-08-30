import type { TraceEvent, TraceRunManifest } from "../trace/schema.js";
import { TraceStore, type TraceRunLinkPatch } from "../trace/store.js";
import { PlayConversationStore, type PlayConversationMessage } from "../world/play-conversation.js";
import { PlayerTurnAuditStore, type PlayerTurnAuditRecoveryLink } from "../world/player-turn-audit.js";
import { BranchStore, WorldObjectStore } from "../world/store.js";

export type PlayTraceRecoverySummary = {
  version: 1;
  examined: number;
  diagnosed: number;
  reconciledLinks: number;
};

type RecoveryDiagnostic = {
  code: string;
  summary: string;
  data: Record<string, unknown>;
  links?: Partial<TraceRunLinkPatch>;
};

type CommitPath = {
  valid: boolean;
  eventHashes: Set<string>;
  logicalTime?: unknown;
};

type PresentationRecovery = {
  messageIds: string[];
  sceneRendered: boolean;
  data: Record<string, unknown>;
};

/**
 * Reconciles interrupted player-move observations against durable world and
 * player-turn records. This service may append a diagnostic and repair trace
 * links only; it never writes branch heads, events, sessions, or conversation.
 */
export class PlayTraceRecoveryService {
  private readonly branches: BranchStore;
  private readonly objects: WorldObjectStore;
  private readonly audits: PlayerTurnAuditStore;
  private readonly conversations: PlayConversationStore;

  constructor(readonly root: string, readonly traces: TraceStore) {
    this.branches = new BranchStore(root);
    this.objects = new WorldObjectStore(root);
    this.audits = new PlayerTurnAuditStore(root);
    this.conversations = new PlayConversationStore(root);
  }

  async reconcileInterruptedPlayerMoves(): Promise<PlayTraceRecoverySummary> {
    await this.traces.initialize();
    const runs = await this.traces.listRuns({ kind: "player-move", status: "interrupted", limit: 1_000 });
    let diagnosed = 0;
    let reconciledLinks = 0;
    for (const run of runs) {
      if (run.error?.code !== "HOST_RESTART_INTERRUPTED_RUN") continue;
      const events = await this.traces.readEvents(run.id);
      if (events.some((event) => event.type === "recovery.diagnostic")) continue;
      const diagnostic = await this.diagnose(run, events);
      await this.traces.appendRecoveryDiagnostic(run.id, diagnostic);
      diagnosed += 1;
      if (diagnostic.links && Object.keys(diagnostic.links).length > 0) reconciledLinks += 1;
    }
    return { version: 1, examined: runs.length, diagnosed, reconciledLinks };
  }

  private async diagnose(run: TraceRunManifest, events: TraceEvent[]): Promise<RecoveryDiagnostic> {
    if (!run.branchId || !run.previousHead) {
      return diagnostic(
        "PLAYER_MOVE_RECOVERY_SCOPE_INCOMPLETE",
        "The interrupted player move has no exact branch and previous-head scope. Its world outcome cannot be reconciled; do not replay it unchanged.",
        "unknown",
        "none",
        "inspect-only",
      );
    }

    const branchHead = await this.readBranchHead(run.branchId);
    const presentation = await this.readPresentation(run);
    let audit: PlayerTurnAuditRecoveryLink | undefined;
    try {
      audit = await this.audits.findRecoveryLink(run.branchId, run.id);
    } catch {
      return diagnostic(
        "PLAYER_MOVE_AUDIT_INVALID",
        "A matching player-turn audit exists but failed integrity or uniqueness validation. Branch truth was not changed; inspect the branch before any new action.",
        branchHead && branchHead !== run.previousHead ? "unknown" : "not-observed",
        "invalid-audit",
        "inspect-only",
        { branchHeadAtRecovery: branchHead, ...presentation.data },
      );
    }

    if (audit) return this.fromAudit(run, audit, branchHead, presentation);

    const observedCommit = [...events].reverse().find((event) =>
      event.type === "world.commit.completed"
      && event.data?.accepted === true
      && typeof event.data.finalHead === "string");
    if (observedCommit) return this.fromCommitEvent(run, observedCommit, branchHead, presentation);

    const crossedTraceBoundary = events.some((event) => event.type === "world.commit.started");
    if (!branchHead) {
      return diagnostic(
        "PLAYER_MOVE_BRANCH_UNAVAILABLE",
        "The interrupted run's branch is no longer attached. Historical trace data remains available, but no active branch outcome can be inferred.",
        "unknown",
        crossedTraceBoundary ? "head-only" : "none",
        "inspect-only",
        presentation.data,
      );
    }
    if (branchHead === run.previousHead) {
      return diagnostic(
        "PLAYER_MOVE_NO_HEAD_ADVANCEMENT",
        "The active branch still points to the run's previous head. No committed world mutation is visible; refresh state and submit a new request ID if the action is still desired.",
        "not-observed",
        crossedTraceBoundary ? "head-only" : "none",
        "refresh-and-submit-new-request",
        { branchHeadAtRecovery: branchHead, ...presentation.data },
      );
    }
    return diagnostic(
      "PLAYER_MOVE_HEAD_ADVANCED_UNKNOWN_OUTCOME",
      "The branch advanced after this run's previous head, but no valid audit or completed commit observation attributes that change exactly. Never replay the world mutation unchanged.",
      "unknown",
      "head-only",
      "inspect-only",
      { branchHeadAtRecovery: branchHead, ...presentation.data },
    );
  }

  private async fromAudit(
    run: TraceRunManifest,
    audit: PlayerTurnAuditRecoveryLink,
    branchHead: string | undefined,
    presentation: PresentationRecovery,
  ): Promise<RecoveryDiagnostic> {
    if (
      audit.previousHead !== run.previousHead
      || (run.playerMoveId && audit.playerMoveId !== run.playerMoveId)
    ) {
      return diagnostic(
        "PLAYER_MOVE_AUDIT_SCOPE_MISMATCH",
        "The matching audit does not agree with the trace's previous head or player-move identity. No trace links were repaired.",
        "unknown",
        "invalid-audit",
        "inspect-only",
        { branchHeadAtRecovery: branchHead, auditId: audit.id, ...presentation.data },
      );
    }
    let path: CommitPath;
    try {
      path = await this.commitPath(audit.previousHead, audit.finalHead);
    } catch {
      return diagnostic(
        "PLAYER_MOVE_AUDIT_COMMIT_UNREADABLE",
        "The audit's commit path could not be verified from immutable world objects. No trace links were repaired.",
        "unknown",
        "invalid-audit",
        "inspect-only",
        { branchHeadAtRecovery: branchHead, auditId: audit.id, ...presentation.data },
      );
    }
    const acceptedPathValid = audit.accepted
      ? path.valid && audit.finalHead !== audit.previousHead && Boolean(audit.eventHash) && path.eventHashes.has(audit.eventHash!)
      : audit.finalHead === audit.previousHead;
    if (!acceptedPathValid) {
      return diagnostic(
        "PLAYER_MOVE_AUDIT_COMMIT_MISMATCH",
        "The audit does not prove the claimed accepted/rejected outcome against the immutable commit path. No trace links were repaired.",
        "unknown",
        "invalid-audit",
        "inspect-only",
        { branchHeadAtRecovery: branchHead, auditId: audit.id, ...presentation.data },
      );
    }
    const headRelation = await this.headRelation(audit.finalHead, branchHead);
    const presentationMessageIds = [...new Set([
      ...run.presentationMessageIds,
      ...presentation.messageIds,
    ])];
    const links: Partial<TraceRunLinkPatch> = {
      finalHead: audit.finalHead,
      auditId: audit.id,
      presentationMessageIds,
      ...(audit.eventHash ? { eventHash: audit.eventHash } : {}),
      ...(path.logicalTime !== undefined
        ? { storyTimeAfter: { commitId: audit.finalHead, logicalTime: structuredClone(path.logicalTime) } }
        : {}),
    };
    if (!audit.accepted) {
      return diagnostic(
        "PLAYER_MOVE_REJECTION_RECONCILED_FROM_AUDIT",
        "A content-verified turn audit proves that the interrupted request was rejected without advancing world truth.",
        "rejected",
        "turn-audit",
        "inspect-only",
        { branchHeadAtRecovery: branchHead, headRelation, ...presentation.data },
        links,
      );
    }
    const safeAction = presentation.sceneRendered ? "inspect-only" : "retry-narration-only";
    return diagnostic(
      "PLAYER_MOVE_COMMIT_RECONCILED_FROM_AUDIT",
      "A content-verified turn audit and immutable commit path prove that world truth was committed. The world mutation must not be replayed.",
      "committed",
      "turn-audit",
      safeAction,
      { branchHeadAtRecovery: branchHead, headRelation, ...presentation.data },
      links,
    );
  }

  private async fromCommitEvent(
    run: TraceRunManifest,
    event: TraceEvent,
    branchHead: string | undefined,
    presentation: PresentationRecovery,
  ): Promise<RecoveryDiagnostic> {
    const finalHead = event.data!.finalHead as string;
    const eventHash = typeof event.data?.eventHash === "string" ? event.data.eventHash : undefined;
    let path: CommitPath;
    try {
      path = await this.commitPath(run.previousHead!, finalHead);
    } catch {
      path = { valid: false, eventHashes: new Set() };
    }
    if (!path.valid || finalHead === run.previousHead || !eventHash || !path.eventHashes.has(eventHash)) {
      return diagnostic(
        "PLAYER_MOVE_TRACE_COMMIT_MISMATCH",
        "The completed commit observation does not verify against the immutable commit path. No trace links were repaired.",
        "unknown",
        "invalid-trace-event",
        "inspect-only",
        { branchHeadAtRecovery: branchHead, commitEventSeq: event.seq, ...presentation.data },
      );
    }
    const headRelation = await this.headRelation(finalHead, branchHead);
    const presentationMessageIds = [...new Set([
      ...run.presentationMessageIds,
      ...presentation.messageIds,
    ])];
    const links: Partial<TraceRunLinkPatch> = {
      finalHead,
      eventHash,
      presentationMessageIds,
      ...(path.logicalTime !== undefined
        ? { storyTimeAfter: { commitId: finalHead, logicalTime: structuredClone(path.logicalTime) } }
        : {}),
    };
    return diagnostic(
      "PLAYER_MOVE_COMMIT_RECONCILED_FROM_TRACE_EVENT",
      "The append-only commit observation and immutable commit path prove that world truth was committed. The world mutation must not be replayed.",
      "committed",
      "trace-event",
      presentation.sceneRendered ? "inspect-only" : "retry-narration-only",
      { branchHeadAtRecovery: branchHead, headRelation, commitEventSeq: event.seq, ...presentation.data },
      links,
    );
  }

  private async readPresentation(run: TraceRunManifest): Promise<PresentationRecovery> {
    if (!run.branchId) return { messageIds: [], sceneRendered: false, data: { presentationStatus: "unavailable" } };
    let messages: PlayConversationMessage[];
    try {
      messages = (await this.conversations.list(run.branchId)).filter((message) => message.runId === run.id);
    } catch {
      return {
        messageIds: [],
        sceneRendered: false,
        data: { presentationStatus: "unreadable", presentationMessageIds: [] },
      };
    }
    const messageIds = messages.sort((left, right) => left.sequence - right.sequence).map((message) => message.id);
    const sceneRendered = messages.some((message) => message.role === "scene" && message.status === "rendered");
    return {
      messageIds,
      sceneRendered,
      data: {
        presentationStatus: sceneRendered ? "rendered" : messageIds.length ? "partial" : "missing",
        presentationMessageIds: messageIds,
      },
    };
  }

  private async readBranchHead(branchId: string): Promise<string | undefined> {
    try {
      return await this.branches.readHead(branchId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async headRelation(finalHead: string, branchHead: string | undefined): Promise<string> {
    if (!branchHead) return "branch-unavailable";
    if (branchHead === finalHead) return "exact";
    try {
      return (await this.commitPath(finalHead, branchHead)).valid ? "descendant" : "diverged";
    } catch {
      return "unreadable";
    }
  }

  private async commitPath(ancestor: string, descendant: string): Promise<CommitPath> {
    const eventHashes = new Set<string>();
    let cursor = descendant;
    let descendantLogicalTime: unknown;
    const seen = new Set<string>();
    for (let depth = 0; depth < 100_000; depth += 1) {
      if (seen.has(cursor)) throw new Error(`Commit ancestry cycle detected at '${cursor}'.`);
      seen.add(cursor);
      const commit = await this.objects.getCommit(cursor);
      descendantLogicalTime ??= commit.logicalTime;
      if (cursor === ancestor) return { valid: true, eventHashes, logicalTime: descendantLogicalTime };
      commit.eventHashes.forEach((hash) => eventHashes.add(hash));
      if (!commit.parentCommitId) return { valid: false, eventHashes, logicalTime: descendantLogicalTime };
      if (commit.parentCommitId === ancestor) return { valid: true, eventHashes, logicalTime: descendantLogicalTime };
      cursor = commit.parentCommitId;
    }
    throw new Error(`Commit path from '${descendant}' exceeded the recovery bound.`);
  }
}

function diagnostic(
  code: string,
  summary: string,
  worldOutcome: "committed" | "rejected" | "not-observed" | "unknown",
  commitEvidence: "turn-audit" | "trace-event" | "head-only" | "none" | "invalid-audit" | "invalid-trace-event",
  recommendedAction: "retry-narration-only" | "refresh-and-submit-new-request" | "inspect-only",
  data: Record<string, unknown> = {},
  links?: Partial<TraceRunLinkPatch>,
): RecoveryDiagnostic {
  return {
    code,
    summary,
    data: {
      recoveryVersion: "player-move-reconciliation/v1",
      worldOutcome,
      commitEvidence,
      recommendedAction,
      unchangedWorldMutationReplayAllowed: false,
      ...data,
    },
    ...(links ? { links } : {}),
  };
}

export function traceProvesCommittedPlayerMove(run: TraceRunManifest, events: readonly TraceEvent[]): boolean {
  return events.some((event) => event.type === "world.commit.completed" && event.data?.accepted === true)
    || events.some((event) =>
      event.type === "recovery.diagnostic"
      && event.data?.worldOutcome === "committed"
      && (event.data.commitEvidence === "turn-audit" || event.data.commitEvidence === "trace-event")
      && event.data.finalHead === run.finalHead
      && event.data.eventHash === run.eventHash
      && event.data.unchangedWorldMutationReplayAllowed === false
      && (event.data.commitEvidence !== "turn-audit" || event.data.auditId === run.auditId));
}
