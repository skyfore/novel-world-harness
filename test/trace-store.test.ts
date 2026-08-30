import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TraceRecorder } from "../src/trace/recorder.js";
import { TraceStore } from "../src/trace/store.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function workspace(prefix = "nwh-trace-store-"): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("append-only trace storage", () => {
  it("redacts secrets at every event, blob, and manifest persistence boundary", async () => {
    const root = await workspace("nwh-trace-redaction-");
    const store = new TraceStore(root);
    const recorder = await TraceRecorder.start(store, {
      id: "run-redaction-boundary",
      kind: "player-move",
      storyTimeBefore: { label: "Bearer canary-story-before" },
    });
    const blob = await recorder.putBlob({
      authorization: "Bearer canary-blob-header",
      prose: "provider returned sk-canary-blob-value",
    });
    await recorder.record("stage.started", {
      label: "Bearer canary-event-value",
      apiKey: "canary-event-key",
    }, recorder.rootContext, {
      storyTime: { label: "Bearer canary-event-story-time" },
      blobRef: blob,
    });
    const finished = await recorder.finish("failed", {}, {
      code: "PROVIDER_FAILURE",
      message: "Bearer canary-manifest-error",
      retryable: true,
    });

    expect(await store.getBlob(blob)).toEqual({
      authorization: "[REDACTED]",
      prose: "provider returned [REDACTED]",
    });
    expect(finished.storyTimeBefore).toEqual({ label: "[REDACTED]" });
    expect(finished.error?.message).toBe("[REDACTED]");
    const events = await store.readEvents(finished.id);
    expect(events.find((event) => event.type === "stage.started")).toMatchObject({
      storyTime: { label: "[REDACTED]" },
      data: { label: "[REDACTED]", apiKey: "[REDACTED]" },
    });
    expect(events.at(-1)?.data.error).toMatchObject({ message: "[REDACTED]" });

    const persisted = await readDirectoryTree(store.root);
    for (const secret of [
      "canary-story-before",
      "canary-blob-header",
      "canary-blob-value",
      "canary-event-value",
      "canary-event-key",
      "canary-event-story-time",
      "canary-manifest-error",
    ]) {
      expect(persisted).not.toContain(secret);
    }
  });

  it("persists ordered events, content-addressed blobs, counts, usage, and world links", async () => {
    const root = await workspace();
    const store = new TraceStore(root);
    const recorder = await TraceRecorder.start(store, {
      id: "run-test-1",
      rootSpanId: "span-root-1",
      kind: "player-move",
      branchId: "main",
      playSessionId: "play-main",
      playerMoveId: "move-1",
      actorId: "hero",
      previousHead: "commit-before",
      storyTimeBefore: { kind: "ordinal", label: "before" },
      startedAt: "2026-08-30T04:00:00.000Z",
    });
    const firstBlob = await recorder.putBlob({ b: 2, a: 1 });
    const duplicateBlob = await recorder.putBlob({ a: 1, b: 2 });
    expect(duplicateBlob).toEqual(firstBlob);
    expect(await store.getBlob(firstBlob)).toEqual({ a: 1, b: 2 });

    const invocation = await recorder.child(recorder.rootContext, "Interpret player action", "llm-invocation");
    await recorder.record("llm.request.started", { invocationName: "player-action" }, invocation, { callId: "call-1" });
    await recorder.record("context.finalized", { logicalContextHash: firstBlob.sha256 }, invocation, { callId: "call-1", blobRef: firstBlob });
    await recorder.record("tool.call.started", { toolName: "propose_player_action" }, invocation, { callId: "call-1", toolCallId: "tool-1" });
    await recorder.record("tool.call.completed", { toolName: "propose_player_action" }, invocation, { callId: "call-1", toolCallId: "tool-1" });
    await recorder.record("llm.retry", { attempt: 1, delayMs: 250 }, invocation, { callId: "call-1" });
    await recorder.record("llm.response.completed", {
      stopReason: "stop",
      usage: {
        input: 120,
        output: 30,
        cacheRead: 20,
        cacheWrite: 5,
        reasoning: 7,
        totalTokens: 175,
        cost: 0.012,
      },
    }, invocation, { callId: "call-1" });
    await recorder.finishStage(invocation, { status: "captured" });
    await recorder.link({
      operationId: "op-1",
      finalHead: "commit-after",
      eventHash: "event-hash",
      auditId: "turn-audit",
      storyTimeAfter: { kind: "ordinal", label: "after" },
      presentationMessageIds: ["message-player", "message-scene"],
    });
    const completed = await recorder.finish("succeeded", { finalHead: "commit-after" });

    expect(completed).toMatchObject({
      id: "run-test-1",
      status: "succeeded",
      operationId: "op-1",
      previousHead: "commit-before",
      finalHead: "commit-after",
      eventHash: "event-hash",
      auditId: "turn-audit",
      counts: { llmRequests: 1, toolCalls: 1, retries: 1 },
      usage: {
        input: 120,
        output: 30,
        cacheRead: 20,
        cacheWrite: 5,
        reasoning: 7,
        totalTokens: 175,
        cost: 0.012,
      },
    });
    const events = await store.readEvents(completed.id);
    expect(events.map((event) => event.seq)).toEqual(events.map((_event, index) => index + 1));
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "stage.started",
      "llm.request.started",
      "context.finalized",
      "tool.call.started",
      "tool.call.completed",
      "llm.retry",
      "llm.response.completed",
      "stage.finished",
      "run.succeeded",
    ]);
    await expect(recorder.record("stage.started", { label: "late" })).rejects.toThrow("terminal");
    await expect(store.appendEvent(completed.id, { type: "stage.started", spanId: completed.rootSpanId }))
      .rejects.toThrow("already succeeded");
    await expect(recorder.link({ auditId: "audit-linked-after-terminal" })).resolves.toMatchObject({
      status: "succeeded",
      auditId: "audit-linked-after-terminal",
    });
    await expect(store.listRuns({ playSessionId: "play-main" })).resolves.toEqual([expect.objectContaining({ id: completed.id })]);
  });

  it("rebuilds a damaged derived index from run manifests", async () => {
    const root = await workspace("nwh-trace-rebuild-");
    const store = new TraceStore(root);
    const recorder = await TraceRecorder.start(store, {
      id: "run-rebuild",
      kind: "scene-narration",
      branchId: "main",
      playSessionId: "play-main",
      startedAt: "2026-08-30T05:00:00.000Z",
    });
    await recorder.finish("succeeded");
    await fs.writeFile(store.indexPath, "{damaged", "utf8");

    const reopened = new TraceStore(root);
    await reopened.initialize();

    await expect(reopened.listRuns()).resolves.toEqual([
      expect.objectContaining({ id: "run-rebuild", status: "succeeded" }),
    ]);
  });

  it("marks orphaned running manifests interrupted on host restart", async () => {
    const root = await workspace("nwh-trace-interrupt-");
    const firstHost = new TraceStore(root);
    await TraceRecorder.start(firstHost, {
      id: "run-orphaned",
      kind: "player-move",
      branchId: "main",
      previousHead: "commit-before",
      startedAt: "2026-08-30T06:00:00.000Z",
    });

    const restartedHost = new TraceStore(root);
    await restartedHost.initialize();
    const interrupted = await restartedHost.getRun("run-orphaned");

    expect(interrupted).toMatchObject({
      status: "interrupted",
      error: {
        code: "HOST_RESTART_INTERRUPTED_RUN",
        retryable: false,
      },
    });
    expect(interrupted.endedAt).toBeDefined();
    await expect(restartedHost.readEvents("run-orphaned")).resolves.toEqual([
      expect.objectContaining({ seq: 1, type: "run.started" }),
      expect.objectContaining({ seq: 2, type: "run.interrupted" }),
    ]);

    await restartedHost.appendRecoveryDiagnostic("run-orphaned", {
      code: "PLAYER_MOVE_COMMIT_RECONCILED_FROM_AUDIT",
      summary: "The durable audit proves that the move committed.",
      data: { worldOutcome: "committed", unchangedWorldMutationReplayAllowed: false },
      links: {
        finalHead: "commit-after",
        eventHash: "event-after",
        auditId: "turn-after",
        presentationMessageIds: ["message-after"],
        storyTimeAfter: { commitId: "commit-after", logicalTime: { step: 1 } },
      },
    });
    await expect(restartedHost.readEvents("run-orphaned")).resolves.toEqual([
      expect.objectContaining({ seq: 1, type: "run.started" }),
      expect.objectContaining({ seq: 2, type: "run.interrupted" }),
      expect.objectContaining({ seq: 3, type: "recovery.diagnostic" }),
    ]);

    const thirdHost = new TraceStore(root);
    await thirdHost.initialize();
    await expect(thirdHost.getRun("run-orphaned")).resolves.toMatchObject({
      status: "interrupted",
      finalHead: "commit-after",
      eventHash: "event-after",
      auditId: "turn-after",
      presentationMessageIds: ["message-after"],
      storyTimeAfter: { commitId: "commit-after", logicalTime: { step: 1 } },
      lastSeq: 3,
    });
    await thirdHost.appendRecoveryDiagnostic("run-orphaned", {
      code: "PLAYER_MOVE_COMMIT_RECONCILED_FROM_AUDIT",
      summary: "The durable audit proves that the move committed.",
      links: { finalHead: "commit-after" },
    });
    await expect(thirdHost.readEvents("run-orphaned")).resolves.toHaveLength(3);
  });

  it("replays an event appended before a stale manifest and then closes the orphan", async () => {
    const root = await workspace("nwh-trace-replay-");
    const firstHost = new TraceStore(root);
    const recorder = await TraceRecorder.start(firstHost, {
      id: "run-stale-manifest",
      kind: "player-move",
      startedAt: "2026-08-30T07:00:00.000Z",
    });
    await recorder.record("llm.request.started", { invocationName: "player-action" }, recorder.rootContext, { callId: "call-stale" });

    const manifestPath = path.join(firstHost.runsRoot, "2026-08", "run-stale-manifest", "manifest.json");
    const current = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await fs.writeFile(manifestPath, `${JSON.stringify({
      ...current,
      lastSeq: 1,
      counts: { llmRequests: 0, toolCalls: 0, retries: 0 },
    }, null, 2)}\n`, "utf8");

    const restartedHost = new TraceStore(root);
    await restartedHost.initialize();

    await expect(restartedHost.getRun("run-stale-manifest")).resolves.toMatchObject({
      status: "interrupted",
      lastSeq: 3,
      counts: { llmRequests: 1, toolCalls: 0, retries: 0 },
    });
    await expect(restartedHost.readEvents("run-stale-manifest")).resolves.toEqual([
      expect.objectContaining({ seq: 1, type: "run.started" }),
      expect.objectContaining({ seq: 2, type: "llm.request.started" }),
      expect.objectContaining({ seq: 3, type: "run.interrupted" }),
    ]);
  });

  it("recovers a terminal event appended before its manifest update", async () => {
    const root = await workspace("nwh-trace-terminal-replay-");
    const firstHost = new TraceStore(root);
    const recorder = await TraceRecorder.start(firstHost, {
      id: "run-terminal-stale",
      kind: "prepare",
      startedAt: "2026-08-30T08:00:00.000Z",
    });
    await recorder.finish("succeeded");

    const manifestPath = path.join(firstHost.runsRoot, "2026-08", "run-terminal-stale", "manifest.json");
    const current = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await fs.writeFile(manifestPath, `${JSON.stringify({
      ...current,
      status: "running",
      endedAt: undefined,
      lastSeq: 1,
    }, null, 2)}\n`, "utf8");

    const restartedHost = new TraceStore(root);
    await restartedHost.initialize();

    await expect(restartedHost.getRun("run-terminal-stale")).resolves.toMatchObject({
      status: "succeeded",
      lastSeq: 2,
    });
    expect((await restartedHost.readEvents("run-terminal-stale")).map((event) => event.type)).toEqual([
      "run.started",
      "run.succeeded",
    ]);
  });

  it("detects blob corruption and gives bounded run discovery guidance", async () => {
    const root = await workspace("nwh-trace-integrity-");
    const store = new TraceStore(root);
    await store.initialize();
    const blob = await store.putBlob("exact context", "text/plain; charset=utf-8");
    const blobPath = path.join(store.blobsRoot, blob.sha256.slice(0, 2), `${blob.sha256}.json`);
    const stored = JSON.parse(await fs.readFile(blobPath, "utf8")) as Record<string, unknown>;
    stored.content = "changed context";
    await fs.writeFile(blobPath, JSON.stringify(stored), "utf8");

    await expect(store.getBlob(blob)).rejects.toThrow("failed content verification");
    await expect(store.getRun("run-missing")).rejects.toThrow("Use /api/v1/runs and copy an exact id");
    await expect(store.createRun({ id: "../escape", kind: "prepare" })).rejects.toThrow("Trace identifiers");
  });
});

async function readDirectoryTree(root: string): Promise<string> {
  const contents: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else contents.push(await fs.readFile(target, "utf8"));
    }
  }
  await visit(root);
  return contents.join("\n");
}
