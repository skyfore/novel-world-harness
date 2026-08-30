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
      result: { narrationStatus: "rendered", headCommitId: genesis },
    });

    const accepted = await service.startPlayerMove(created.session.id, {
      text: "我离开前厅，去营地。",
      expectedHead: genesis,
      clientRequestId: "move-1",
    });
    const completed = await operations.wait(accepted.operation.id);
    expect(completed).toMatchObject({
      status: "succeeded",
      commitBoundaryCrossed: true,
      result: {
        accepted: true,
        previousHead: genesis,
        narrationStatus: "rendered",
        logicalStep: 1,
      },
    });
    const result = completed.result as { finalHead: string };
    expect(result.finalHead).not.toBe(genesis);
    expect((await engine.projector.project(result.finalHead)).values.hero?.["character.location"]).toBe("camp");

    const detail = await service.getSession(created.session.id);
    expect(detail.headCommitId).toBe(result.finalHead);
    expect(detail.messages.map((message) => [message.role, message.status])).toEqual([
      ["scene", "rendered"],
      ["player", "accepted"],
      ["scene", "rendered"],
    ]);
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
    expect(cancelled).toMatchObject({ status: "cancelled", commitBoundaryCrossed: false });
    expect(await engine.branches.readHead("main")).toBe(genesis);
    expect(await new PlayConversationStore(root).list("main")).toEqual([]);
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
