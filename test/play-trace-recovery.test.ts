import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PlayTraceRecoveryService,
  traceProvesCommittedPlayerMove,
} from "../src/application/play-trace-recovery-service.js";
import { TraceRecorder } from "../src/trace/recorder.js";
import { TraceStore } from "../src/trace/store.js";
import { createWebHost } from "../src/web/host.js";
import { PlayConversationStore } from "../src/world/play-conversation.js";
import { PlayerTurnAuditStore } from "../src/world/player-turn-audit.js";
import { WORLD_ENGINE_VERSION, WORLD_SCHEMA_VERSION } from "../src/world/model.js";
import { BranchStore, WorldObjectStore } from "../src/world/store.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-play-trace-recovery-"));
  roots.push(root);
  return root;
}

async function world(root: string): Promise<{
  branches: BranchStore;
  genesis: string;
  committed: string;
  eventHash: string;
}> {
  const objects = new WorldObjectStore(root);
  const branches = new BranchStore(root);
  const genesis = await objects.putCommit({
    version: 1,
    branchId: "main",
    logicalTime: { step: 0 },
    eventHashes: [],
    engineVersion: WORLD_ENGINE_VERSION,
    schemaVersion: WORLD_SCHEMA_VERSION,
  });
  await branches.create({ id: "main", name: "Main", headCommitId: genesis });
  const deltaHash = await objects.putDelta({ version: 1, operations: [] });
  const eventHash = await objects.putEvent({
    version: 1,
    eventId: "event-player-move",
    branchId: "main",
    logicalTime: { step: 1 },
    proposalId: "proposal-player-move",
    title: "The player waits",
    participants: ["hero"],
    deltaHash,
    evidence: [],
    causalParents: [],
    actorId: "hero",
  });
  const committed = await objects.putCommit({
    version: 1,
    parentCommitId: genesis,
    branchId: "main",
    logicalTime: { step: 1 },
    eventHashes: [eventHash],
    engineVersion: WORLD_ENGINE_VERSION,
    schemaVersion: WORLD_SCHEMA_VERSION,
  });
  return { branches, genesis, committed, eventHash };
}

async function orphanedRun(root: string, previousHead: string, id: string): Promise<void> {
  const recorder = await TraceRecorder.start(new TraceStore(root), {
    id,
    kind: "player-move",
    branchId: "main",
    playSessionId: "play-main",
    playerMoveId: `move-${id}`,
    actorId: "hero",
    previousHead,
    storyTimeBefore: { commitId: previousHead, logicalTime: { step: 0 } },
    startedAt: "2026-08-30T12:00:00.000Z",
  });
  await recorder.record("world.commit.started", { kind: "player-action", previousHead });
}

describe("player-move trace startup reconciliation", () => {
  it("repairs links from a content-verified audit without replaying world truth", async () => {
    const root = await workspace();
    const { branches, genesis, committed, eventHash } = await world(root);
    await branches.updateHead("main", genesis, committed);
    const runId = "run-recover-after-commit";
    const playerMoveId = `move-${runId}`;
    await orphanedRun(root, genesis, runId);
    const audit = await new PlayerTurnAuditStore(root).write({
      startedAt: "2026-08-30T12:00:00.000Z",
      finishedAt: "2026-08-30T12:00:02.000Z",
      durationMs: 2_000,
      branchId: "main",
      actorId: "hero",
      utterance: "wait",
      origin: "web",
      runId,
      playerMoveId,
      previousHead: genesis,
      finalHead: committed,
      stage: "committed",
      accepted: true,
      issues: [],
      eventHash,
      reactionEvents: [],
      backgroundEvents: [],
    });
    const playerMessage = await new PlayConversationStore(root).append({
      branchId: "main",
      actorId: "hero",
      atCommit: committed,
      eventId: "event-player-move",
      runId,
      playerMoveId,
      role: "player",
      status: "accepted",
      text: "wait",
    });

    const restarted = new TraceStore(root);
    await restarted.initialize();
    const recovery = new PlayTraceRecoveryService(root, restarted);
    await expect(recovery.reconcileInterruptedPlayerMoves()).resolves.toEqual({
      version: 1,
      examined: 1,
      diagnosed: 1,
      reconciledLinks: 1,
    });

    const manifest = await restarted.getRun(runId);
    const events = await restarted.readEvents(runId);
    expect(manifest).toMatchObject({
      status: "interrupted",
      previousHead: genesis,
      finalHead: committed,
      eventHash,
      auditId: audit.id,
      presentationMessageIds: [playerMessage.id],
      storyTimeAfter: { commitId: committed, logicalTime: { step: 1 } },
    });
    expect(events.at(-1)).toMatchObject({
      type: "recovery.diagnostic",
      data: {
        code: "PLAYER_MOVE_COMMIT_RECONCILED_FROM_AUDIT",
        worldOutcome: "committed",
        commitEvidence: "turn-audit",
        recommendedAction: "retry-narration-only",
        unchangedWorldMutationReplayAllowed: false,
        branchHeadAtRecovery: committed,
        headRelation: "exact",
        finalHead: committed,
        eventHash,
        auditId: audit.id,
      },
    });
    expect(traceProvesCommittedPlayerMove(manifest, events)).toBe(true);
    await expect(branches.readHead("main")).resolves.toBe(committed);

    await expect(recovery.reconcileInterruptedPlayerMoves()).resolves.toEqual({
      version: 1,
      examined: 1,
      diagnosed: 0,
      reconciledLinks: 0,
    });
    await expect(restarted.readEvents(runId)).resolves.toHaveLength(events.length);
  });

  it("distinguishes no head advancement from an unattributed advanced head", async () => {
    const noCommitRoot = await workspace();
    const noCommitWorld = await world(noCommitRoot);
    await orphanedRun(noCommitRoot, noCommitWorld.genesis, "run-before-commit");
    const noCommitStore = new TraceStore(noCommitRoot);
    await noCommitStore.initialize();
    await new PlayTraceRecoveryService(noCommitRoot, noCommitStore).reconcileInterruptedPlayerMoves();
    const noCommitEvents = await noCommitStore.readEvents("run-before-commit");
    expect(noCommitEvents.at(-1)).toMatchObject({
      type: "recovery.diagnostic",
      data: {
        code: "PLAYER_MOVE_NO_HEAD_ADVANCEMENT",
        worldOutcome: "not-observed",
        recommendedAction: "refresh-and-submit-new-request",
      },
    });
    expect(traceProvesCommittedPlayerMove(await noCommitStore.getRun("run-before-commit"), noCommitEvents)).toBe(false);

    const unknownRoot = await workspace();
    const unknownWorld = await world(unknownRoot);
    await unknownWorld.branches.updateHead("main", unknownWorld.genesis, unknownWorld.committed);
    await orphanedRun(unknownRoot, unknownWorld.genesis, "run-unknown-after-head");
    const unknownStore = new TraceStore(unknownRoot);
    await unknownStore.initialize();
    await new PlayTraceRecoveryService(unknownRoot, unknownStore).reconcileInterruptedPlayerMoves();
    const unknownManifest = await unknownStore.getRun("run-unknown-after-head");
    const unknownEvents = await unknownStore.readEvents("run-unknown-after-head");
    expect(unknownEvents.at(-1)).toMatchObject({
      type: "recovery.diagnostic",
      data: {
        code: "PLAYER_MOVE_HEAD_ADVANCED_UNKNOWN_OUTCOME",
        worldOutcome: "unknown",
        recommendedAction: "inspect-only",
      },
    });
    expect(unknownManifest.finalHead).toBeUndefined();
    expect(traceProvesCommittedPlayerMove(unknownManifest, unknownEvents)).toBe(false);
    await expect(unknownWorld.branches.readHead("main")).resolves.toBe(unknownWorld.committed);
  });

  it("runs reconciliation before the Web Host serves trace queries", async () => {
    const root = await workspace();
    const { genesis } = await world(root);
    await orphanedRun(root, genesis, "run-host-startup-recovery");
    const app = await createWebHost({
      root,
      serveStatic: false,
      modelCatalogService: { read: async () => ({ providers: [], models: [] }) },
    });
    try {
      const response = await app.inject({ method: "GET", url: "/api/v1/runs/run-host-startup-recovery" });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        manifest: { status: "interrupted" },
        events: [
          expect.objectContaining({ type: "run.started" }),
          expect.objectContaining({ type: "world.commit.started" }),
          expect.objectContaining({ type: "run.interrupted" }),
          expect.objectContaining({
            type: "recovery.diagnostic",
            data: expect.objectContaining({ code: "PLAYER_MOVE_NO_HEAD_ADVANCEMENT" }),
          }),
        ],
      });
    } finally {
      await app.close();
    }
  });
});
