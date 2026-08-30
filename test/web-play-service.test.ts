import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlayApplicationService } from "../src/application/play-service.js";
import type { PlayerOpeningNarrator } from "../src/agent/pi-player-opening.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { PlayConversationStore } from "../src/world/play-conversation.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { WebEventBroker } from "../src/web/event-stream.js";
import { WebApplicationError } from "../src/web/errors.js";
import { createWebHost } from "../src/web/host.js";
import { OperationManager } from "../src/web/operation-manager.js";
import { workspaceStateDir } from "../src/agent/runtime-paths.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-web-play-service-"));
  roots.push(root);
  const canon = new CanonicalModelStore(root);
  await canon.putEntity({ id: "hero", kind: "character", canonicalName: "林岐", aliases: ["Hero"], evidence: [] });
  await canon.putEntity({ id: "hall", kind: "location", canonicalName: "前厅", aliases: [], evidence: [] });
  await canon.putEntity({ id: "camp", kind: "location", canonicalName: "营地", aliases: [], evidence: [] });
  await canon.putClaim({
    id: "hero-knows-camp",
    subject: "hero",
    predicate: "knows-route-to",
    object: "camp",
    epistemicType: "explicit-fact",
    evidence: [],
  });
  const { engine } = await openWorkspaceWorld(root);
  const genesis = await engine.createBranch("main", "主时间线", {
    version: 1,
    operations: [
      { op: "set", entityId: "hero", field: "character.alive", value: true },
      { op: "set", entityId: "hero", field: "character.location", value: "hall" },
    ],
  }, {
    version: 1,
    operations: [{ op: "learn", actorId: "hero", claimId: "hero-knows-camp", status: "knows", confidence: 1 }],
  });
  const events = new WebEventBroker();
  const operations = new OperationManager(events);
  return { root, engine, genesis, events, operations };
}

const narrator: PlayerOpeningNarrator = (_frame, purpose, observer) => {
  const narration = `你站在前厅斑驳的窗影里，风从门缝缓慢穿过，带来远处草木与尘土的气味。你听见自己的呼吸落在寂静中，也看见通往营地的道路在门外延伸。此刻没有任何力量替你作出决定，只有眼前已经发生的${purpose}场景，等待你的下一步。`;
  observer?.onAttempt?.(1);
  observer?.onText?.(narration);
  return {
    narration,
    choices: [{ action: "走到门边观察道路" }, { action: "留在原地听一听动静" }],
  };
};

function moveCandidate() {
  return {
    title: "林岐离开前厅前往营地",
    participants: ["camp"],
    preconditions: [{ op: "fact-equals" as const, entityId: "hero", field: "character.location", value: "hall" }],
    proposedDelta: {
      version: 1 as const,
      operations: [{ op: "set" as const, entityId: "hero", field: "character.location", value: "camp" }],
    },
    requiresKnowledge: [],
    forbidsKnowledge: [],
  };
}

describe("Web Play application service", () => {
  it("creates, narrates, plays, resumes, and removes a session while preserving branch truth", async () => {
    const { root, engine, genesis, events, operations } = await fixture();
    const service = new PlayApplicationService({
      root,
      events,
      operations,
      translator: () => moveCandidate(),
      narrator,
      advanceBackground: 0,
    });

    await expect(service.listCharacters("main")).resolves.toMatchObject({
      branchId: "main",
      characters: [expect.objectContaining({ id: "hero", canonicalName: "林岐", locationId: "hall" })],
    });
    const created = await service.createSession({
      branchId: "main",
      actorId: "hero",
      title: "林岐的支线",
      clientRequestId: "create-1",
    });
    expect(created).toMatchObject({
      session: { id: "play-main", title: "林岐的支线", status: "active" },
      headCommitId: genesis,
      messages: [],
    });
    const replayedCreate = await service.createSession({
      branchId: "main",
      actorId: "hero",
      title: "林岐的支线",
      clientRequestId: "create-1",
    });
    expect(replayedCreate.session.id).toBe(created.session.id);

    const opening = await service.startSceneNarration(created.session.id, {
      purpose: "opening",
      expectedHead: genesis,
      clientRequestId: "opening-1",
    });
    const openingDone = await operations.wait(opening.operation.id);
    expect(openingDone).toMatchObject({
      status: "succeeded",
      runId: opening.operation.runId,
      result: { narrationStatus: "rendered", headCommitId: genesis, runId: opening.operation.runId },
    });
    const openingTrace = await service.traceStore.getRun(opening.operation.runId!);
    expect(openingTrace).toMatchObject({
      kind: "scene-narration",
      status: "succeeded",
      operationId: opening.operation.id,
      finalHead: genesis,
    });
    expect(openingTrace.presentationMessageIds).toHaveLength(1);

    const accepted = await service.startPlayerMove(created.session.id, {
      text: "我离开前厅，去营地。",
      expectedHead: genesis,
      clientRequestId: "move-1",
    });
    const completed = await operations.wait(accepted.operation.id);
    expect(completed).toMatchObject({
      status: "succeeded",
      runId: accepted.operation.runId,
      commitBoundaryCrossed: true,
      result: {
        accepted: true,
        previousHead: genesis,
        narrationStatus: "rendered",
        logicalStep: 1,
        runId: accepted.operation.runId,
      },
    });
    const result = completed.result as {
      finalHead: string;
      runId: string;
      playerMoveId: string;
      auditId: string;
      eventHash: string;
    };
    expect(result.finalHead).not.toBe(genesis);
    expect((await engine.projector.project(result.finalHead)).values.hero?.["character.location"]).toBe("camp");

    const detail = await service.getSession(created.session.id);
    expect(detail.headCommitId).toBe(result.finalHead);
    expect(detail.messages.map((message) => [message.role, message.status])).toEqual([
      ["scene", "rendered"],
      ["player", "accepted"],
      ["scene", "rendered"],
    ]);
    expect(detail.messages.map((message) => message.runId)).toEqual([
      opening.operation.runId,
      accepted.operation.runId,
      accepted.operation.runId,
    ]);
    expect(detail.messages.slice(1).map((message) => message.playerMoveId)).toEqual([
      result.playerMoveId,
      result.playerMoveId,
    ]);
    const moveTrace = await service.traceStore.getRun(result.runId);
    expect(moveTrace).toMatchObject({
      kind: "player-move",
      status: "succeeded",
      operationId: accepted.operation.id,
      playerMoveId: result.playerMoveId,
      previousHead: genesis,
      finalHead: result.finalHead,
      eventHash: result.eventHash,
      auditId: result.auditId,
    });
    expect(moveTrace.presentationMessageIds).toHaveLength(2);
    const auditFiles = await fs.readdir(path.join(workspaceStateDir(root), "world", "v1", "play", "turns", "main"));
    const audit = JSON.parse(await fs.readFile(
      path.join(workspaceStateDir(root), "world", "v1", "play", "turns", "main", auditFiles[0]!),
      "utf8",
    )) as Record<string, unknown>;
    expect(audit).toMatchObject({
      id: result.auditId,
      runId: result.runId,
      playerMoveId: result.playerMoveId,
      eventHash: result.eventHash,
    });
    expect((await service.traceStore.readEvents(result.runId)).map((event) => event.type)).toEqual(expect.arrayContaining([
      "validation.completed",
      "world.commit.started",
      "world.commit.completed",
      "presentation.message.appended",
      "run.succeeded",
    ]));
    expect(events.replayAfter().map((event) => event.type)).toEqual(expect.arrayContaining([
      "play.narration.delta",
      "play.narration.completed",
      "play.message.appended",
      "catalog.invalidated",
      "operation.changed",
    ]));

    const reused = await service.startPlayerMove(created.session.id, {
      text: "我离开前厅，去营地。",
      expectedHead: genesis,
      clientRequestId: "move-1",
    });
    expect(reused).toMatchObject({ reused: true, operation: { id: accepted.operation.id } });
    await expect(service.startPlayerMove(created.session.id, {
      text: "改成另一个行动",
      expectedHead: genesis,
      clientRequestId: "move-1",
    })).rejects.toMatchObject({ detail: { code: "IDEMPOTENCY_CONFLICT" } });
    await expect(service.startPlayerMove(created.session.id, {
      text: "继续前进",
      expectedHead: genesis,
      clientRequestId: "move-stale",
    })).rejects.toMatchObject({ detail: { code: "STALE_BRANCH_HEAD" } });

    await service.updateSession(created.session.id, { status: "archived" });
    await expect(service.startSceneNarration(created.session.id, {
      purpose: "orientation",
      expectedHead: result.finalHead,
      clientRequestId: "archived-narration",
    })).rejects.toMatchObject({ detail: { code: "PLAY_SESSION_ARCHIVED" } });
    await service.restoreSession(created.session.id);
    await service.activateSession(created.session.id);

    const removed = await service.removeSession(created.session.id);
    expect(removed).toEqual({
      sessionId: created.session.id,
      branchId: "main",
      branchPreserved: true,
      conversationRemoved: true,
    });
    expect(await engine.branches.readHead("main")).toBe(result.finalHead);
    expect((await engine.projector.project(result.finalHead)).values.hero?.["character.location"]).toBe("camp");
    expect(await new PlayConversationStore(root).list("main")).toEqual([]);
    await expect(service.traceStore.listRuns({ playSessionId: created.session.id })).resolves.toHaveLength(2);
  });

  it("cancels before commit without writing world truth or presentation messages", async () => {
    const { root, engine, genesis, events, operations } = await fixture();
    let release!: () => void;
    const translationGate = new Promise<void>((resolve) => { release = resolve; });
    const service = new PlayApplicationService({
      root,
      events,
      operations,
      translator: async () => {
        await translationGate;
        return moveCandidate();
      },
      narrator,
    });
    const session = await service.createSession({
      branchId: "main",
      actorId: "hero",
      clientRequestId: "create-cancel",
    });
    const accepted = await service.startPlayerMove(session.session.id, {
      text: "我要去营地。",
      expectedHead: genesis,
      clientRequestId: "move-cancel",
    });

    operations.cancel(accepted.operation.id);
    release();
    const cancelled = await operations.wait(accepted.operation.id);
    expect(cancelled).toMatchObject({
      status: "cancelled",
      runId: accepted.operation.runId,
      commitBoundaryCrossed: false,
    });
    await expect(service.traceStore.getRun(accepted.operation.runId!)).resolves.toMatchObject({
      status: "cancelled",
      previousHead: genesis,
      finalHead: genesis,
      error: { code: "OPERATION_CANCELLED_BEFORE_COMMIT", retryable: true },
    });
    expect((await service.traceStore.readEvents(accepted.operation.runId!)).some((event) => event.type === "world.commit.started")).toBe(false);
    expect(await engine.branches.readHead("main")).toBe(genesis);
    expect(await new PlayConversationStore(root).list("main")).toEqual([]);
  });

  it("preserves a committed move and marks its run interrupted when Stop arrives during narration", async () => {
    const { root, engine, genesis, events, operations } = await fixture();
    let narrationStarted!: () => void;
    let releaseNarration!: () => void;
    const started = new Promise<void>((resolve) => { narrationStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseNarration = resolve; });
    const blockingNarrator: PlayerOpeningNarrator = async (_frame, _purpose, observer) => {
      narrationStarted();
      await gate;
      observer?.signal?.throwIfAborted();
      return "This narration should never be committed after Stop.";
    };
    const service = new PlayApplicationService({
      root,
      events,
      operations,
      translator: () => moveCandidate(),
      narrator: blockingNarrator,
    });
    const session = await service.createSession({
      branchId: "main",
      actorId: "hero",
      clientRequestId: "create-stop-after-commit",
    });
    const accepted = await service.startPlayerMove(session.session.id, {
      text: "我离开前厅，去营地。",
      expectedHead: genesis,
      clientRequestId: "move-stop-after-commit",
    });

    await started;
    expect(operations.get(accepted.operation.id).commitBoundaryCrossed).toBe(true);
    operations.cancel(accepted.operation.id);
    releaseNarration();
    const completed = await operations.wait(accepted.operation.id);

    expect(completed).toMatchObject({
      status: "succeeded",
      phase: "completed-after-stop",
      commitBoundaryCrossed: true,
      result: { accepted: true, narrationStatus: "skipped", runId: accepted.operation.runId },
    });
    expect(await engine.branches.readHead("main")).not.toBe(genesis);
    const committedHead = await engine.branches.readHead("main");
    expect(await new PlayConversationStore(root).list("main")).toEqual([
      expect.objectContaining({ role: "player", status: "accepted", runId: accepted.operation.runId }),
    ]);
    await expect(service.traceStore.getRun(accepted.operation.runId!)).resolves.toMatchObject({
      status: "interrupted",
      previousHead: genesis,
      error: { code: "OPERATION_INTERRUPTED_AFTER_COMMIT", retryable: false },
    });

    const repairService = new PlayApplicationService({
      root,
      events,
      operations,
      translator: () => moveCandidate(),
      narrator,
    });
    const retry = await repairService.startNarrationRetry(session.session.id, {
      sourceRunId: accepted.operation.runId!,
      expectedHead: committedHead,
      clientRequestId: "retry-narration-after-stop",
    });
    const repaired = await operations.wait(retry.operation.id);
    expect(repaired).toMatchObject({
      status: "succeeded",
      kind: "narration-retry",
      commitBoundaryCrossed: false,
      result: {
        sourceRunId: accepted.operation.runId,
        playerMoveId: expect.any(String),
        headCommitId: committedHead,
        narrationStatus: "rendered",
      },
    });
    expect(await engine.branches.readHead("main")).toBe(committedHead);
    expect(await new PlayConversationStore(root).list("main")).toEqual([
      expect.objectContaining({ role: "player", status: "accepted", runId: accepted.operation.runId }),
      expect.objectContaining({ role: "scene", status: "rendered", runId: retry.operation.runId }),
    ]);
    const retryTrace = await repairService.traceStore.getRun(retry.operation.runId!);
    expect(retryTrace).toMatchObject({
      kind: "narration-retry",
      status: "succeeded",
      previousHead: committedHead,
      finalHead: committedHead,
    });
    const retryEvents = await repairService.traceStore.readEvents(retry.operation.runId!);
    expect(retryEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "validation.completed", data: expect.objectContaining({ worldMutationAllowed: false }) }),
      expect.objectContaining({ type: "presentation.message.appended" }),
    ]));
    expect(retryEvents.some((event) => event.type.startsWith("world.commit."))).toBe(false);
    await expect(repairService.startNarrationRetry(session.session.id, {
      sourceRunId: accepted.operation.runId!,
      expectedHead: committedHead,
      clientRequestId: "retry-narration-again",
    })).rejects.toMatchObject({ detail: { code: "NARRATION_ALREADY_RENDERED", retry: { kind: "none" } } });
  });

  it("surfaces typed application errors", async () => {
    const { root, events, operations } = await fixture();
    const service = new PlayApplicationService({ root, events, operations, translator: () => moveCandidate(), narrator });
    await expect(service.getSession("play-missing")).rejects.toBeInstanceOf(WebApplicationError);
    await expect(service.getSession("play-missing")).rejects.toMatchObject({
      statusCode: 404,
      detail: {
        code: "PLAY_SESSION_NOT_FOUND",
        retry: { discoveryEndpoint: "/api/v1/play-sessions", copyField: "id", maxAttempts: 1 },
      },
    });
  });

  it("exposes the Play service through CSRF-protected versioned HTTP routes", async () => {
    const { root, genesis, events, operations } = await fixture();
    const service = new PlayApplicationService({
      root,
      events,
      operations,
      translator: () => moveCandidate(),
      narrator,
    });
    const app = await createWebHost({
      root,
      serveStatic: false,
      eventBroker: events,
      operationManager: operations,
      playService: service,
      modelCatalogService: { read: async () => ({ providers: [], models: [] }) },
    });
    try {
      const bootstrap = await app.inject({ method: "GET", url: "/api/v1/bootstrap" });
      const csrfToken = (bootstrap.json() as { csrfToken: string }).csrfToken;
      const characters = await app.inject({ method: "GET", url: "/api/v1/instances/main/characters" });
      expect(characters.statusCode).toBe(200);
      expect(characters.json()).toMatchObject({ characters: [expect.objectContaining({ id: "hero" })] });

      const denied = await app.inject({
        method: "POST",
        url: "/api/v1/play-sessions",
        payload: { branchId: "main", actorId: "hero", clientRequestId: "http-create" },
      });
      expect(denied.statusCode).toBe(403);

      const created = await app.inject({
        method: "POST",
        url: "/api/v1/play-sessions",
        headers: { "x-nwh-csrf": csrfToken },
        payload: { branchId: "main", actorId: "hero", clientRequestId: "http-create" },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ session: { id: "play-main" }, headCommitId: genesis });

      const narration = await app.inject({
        method: "POST",
        url: "/api/v1/play-sessions/play-main/narrations",
        headers: { "x-nwh-csrf": csrfToken },
        payload: { purpose: "opening", expectedHead: genesis, clientRequestId: "http-opening" },
      });
      expect(narration.statusCode).toBe(202);
      const operationId = (narration.json() as { operation: { id: string } }).operation.id;
      await operations.wait(operationId);

      const operation = await app.inject({ method: "GET", url: `/api/v1/operations/${operationId}` });
      expect(operation.statusCode).toBe(200);
      expect(operation.json()).toMatchObject({ id: operationId, status: "succeeded" });
      const detail = await app.inject({ method: "GET", url: "/api/v1/play-sessions/play-main" });
      expect(detail.json()).toMatchObject({ messages: [expect.objectContaining({ role: "scene" })] });

      const missingRetrySource = await app.inject({
        method: "POST",
        url: "/api/v1/play-sessions/play-main/retry-narration",
        headers: { "x-nwh-csrf": csrfToken },
        payload: { sourceRunId: "run-missing", expectedHead: genesis, clientRequestId: "http-retry-missing" },
      });
      expect(missingRetrySource.statusCode).toBe(404);
      expect(missingRetrySource.json()).toMatchObject({
        code: "TRACE_RUN_NOT_FOUND",
        retry: { discoveryEndpoint: "/api/v1/runs?sessionId=play-main&kind=player-move", copyField: "id", maxAttempts: 1 },
      });

      const cleared = await app.inject({
        method: "DELETE",
        url: "/api/v1/play-sessions/play-main/messages",
        headers: { "x-nwh-csrf": csrfToken },
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json()).toMatchObject({ branchPreserved: true, cleared: true });
    } finally {
      await app.close();
    }
  });
});
