import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WebEventBroker } from "../src/web/event-stream.js";
import { webError } from "../src/web/errors.js";
import { OperationManager } from "../src/web/operation-manager.js";

describe("Web operation manager", () => {
  it("publishes an ordered lifecycle and preserves successful results", async () => {
    const events = new WebEventBroker();
    const manager = new OperationManager(events);

    const accepted = manager.start({
      kind: "player-move",
      scopeId: "play-main",
      clientRequestId: "request-1",
      request: { expectedHead: "commit-1", text: "Open the door." },
      runId: "run-operation-1",
      run: async (context) => {
        expect(context.runId).toBe("run-operation-1");
        expect(context.commitBoundaryCrossed).toBe(false);
        context.update("translating", { turn: 1 });
        context.markCommitBoundary({ candidateId: "candidate-1" });
        expect(context.commitBoundaryCrossed).toBe(true);
        context.update("narrating", { turn: 2 });
        return { finalHead: "commit-2" };
      },
    });

    expect(accepted.reused).toBe(false);
    expect(accepted.operation.status).toBe("queued");
    const completed = await manager.wait(accepted.operation.id);

    expect(completed).toMatchObject({
      status: "succeeded",
      runId: "run-operation-1",
      phase: "completed",
      cancellable: false,
      commitBoundaryCrossed: true,
      result: { finalHead: "commit-2" },
    });
    expect(events.replayAfter().map((event) => event.data.operation)).toEqual([
      expect.objectContaining({ status: "queued", phase: "queued" }),
      expect.objectContaining({ status: "running", phase: "starting" }),
      expect.objectContaining({ status: "running", phase: "translating" }),
      expect.objectContaining({ status: "running", phase: "committing", commitBoundaryCrossed: true }),
      expect.objectContaining({ status: "running", phase: "narrating" }),
      expect.objectContaining({ status: "succeeded", phase: "completed" }),
    ]);
    expect(events.replayAfter().every((event) => event.runId === "run-operation-1")).toBe(true);
  });

  it("reuses an idempotent request and rejects changed input for the same key", async () => {
    const manager = new OperationManager(new WebEventBroker());
    const run = async () => ({ ok: true });
    const first = manager.start({
      kind: "scene-narration",
      scopeId: "play-main",
      clientRequestId: "request-2",
      request: { purpose: "opening", nested: { b: 2, a: 1 } },
      run,
    });
    const replay = manager.start({
      kind: "scene-narration",
      scopeId: "play-main",
      clientRequestId: "request-2",
      request: { nested: { a: 1, b: 2 }, purpose: "opening" },
      run,
    });

    expect(replay.reused).toBe(true);
    expect(replay.operation.id).toBe(first.operation.id);
    expect(() => manager.start({
      kind: "scene-narration",
      scopeId: "play-main",
      clientRequestId: "request-2",
      request: { purpose: "orientation" },
      run,
    })).toThrow("already used with different input");
    await manager.wait(first.operation.id);
  });

  it("cancels work before the commit boundary", async () => {
    const manager = new OperationManager(new WebEventBroker());
    const accepted = manager.start({
      kind: "player-move",
      scopeId: "play-main",
      clientRequestId: "request-3",
      request: { text: "Wait." },
      run: async ({ signal }) => {
        await abortPromise(signal);
        return { unreachable: true };
      },
    });

    const cancelling = manager.cancel(accepted.operation.id);
    expect(cancelling.phase).toBe("cancelling");
    const completed = await manager.wait(accepted.operation.id);
    expect(completed).toMatchObject({
      status: "cancelled",
      phase: "cancelled",
      commitBoundaryCrossed: false,
      error: { code: "OPERATION_CANCELLED" },
    });
  });

  it("stops post-commit work without disguising the committed result as cancelled", async () => {
    const manager = new OperationManager(new WebEventBroker());
    let committed!: () => void;
    const atCommit = new Promise<void>((resolve) => { committed = resolve; });
    const accepted = manager.start({
      kind: "player-move",
      scopeId: "play-main",
      clientRequestId: "request-4",
      request: { text: "Cross the bridge." },
      run: async (context) => {
        context.markCommitBoundary({ previousHead: "commit-1" });
        committed();
        await abortPromise(context.signal);
        return { finalHead: "commit-2", narrationStatus: "skipped" };
      },
    });

    await atCommit;
    const stopping = manager.cancel(accepted.operation.id);
    expect(stopping).toMatchObject({
      phase: "stopping-after-commit",
      commitBoundaryCrossed: true,
    });
    const completed = await manager.wait(accepted.operation.id);
    expect(completed).toMatchObject({
      status: "succeeded",
      phase: "completed-after-stop",
      commitBoundaryCrossed: true,
      result: { finalHead: "commit-2", narrationStatus: "skipped" },
    });
  });

  it("atomically restores operation identity and marks pre-commit work interrupted after restart", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-web-operation-restart-"));
    const first = new OperationManager(new WebEventBroker(), { workspaceRoot: root });
    await first.initialize();
    const accepted = first.start({
      kind: "prepare",
      scopeId: "source-1",
      clientRequestId: "durable-request-1",
      request: { mode: "all" },
      run: async () => new Promise<never>(() => undefined),
    });
    await Promise.resolve();

    const recoveredEvents = new WebEventBroker();
    const recovered = new OperationManager(recoveredEvents, { workspaceRoot: root });
    await recovered.initialize();

    expect(recovered.get(accepted.operation.id)).toMatchObject({
      status: "interrupted",
      phase: "interrupted-after-restart",
      commitBoundaryCrossed: false,
      error: {
        code: "HOST_RESTART_INTERRUPTED_OPERATION",
        retry: { kind: "after-user-action" },
      },
    });
    expect(recoveredEvents.replayAfter().at(-1)?.data.operation).toMatchObject({
      id: accepted.operation.id,
      status: "interrupted",
    });
    const replay = recovered.start({
      kind: "prepare",
      scopeId: "source-1",
      clientRequestId: "durable-request-1",
      request: { mode: "all" },
      run: async () => ({ shouldNotRun: true }),
    });
    expect(replay).toMatchObject({ reused: true, operation: { id: accepted.operation.id, status: "interrupted" } });
    expect(() => recovered.start({
      kind: "prepare",
      scopeId: "source-1",
      clientRequestId: "durable-request-1",
      request: { mode: "different" },
      run: async () => ({ shouldNotRun: true }),
    })).toThrow("already used with different input");
  });

  it("recovers post-commit interruption without authorizing an unchanged replay", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-web-operation-post-commit-"));
    const first = new OperationManager(new WebEventBroker(), { workspaceRoot: root });
    await first.initialize();
    let crossed!: () => void;
    const atBoundary = new Promise<void>((resolve) => { crossed = resolve; });
    const accepted = first.start({
      kind: "player-move",
      scopeId: "session-1",
      clientRequestId: "durable-request-2",
      request: { expectedHead: "commit-before", text: "Proceed." },
      run: async (context) => {
        context.markCommitBoundary({ finalHead: "commit-after" });
        crossed();
        return new Promise<never>(() => undefined);
      },
    });
    await atBoundary;

    const recovered = new OperationManager(new WebEventBroker(), { workspaceRoot: root });
    await recovered.initialize();
    expect(recovered.get(accepted.operation.id)).toMatchObject({
      status: "interrupted",
      commitBoundaryCrossed: true,
      error: {
        code: "OPERATION_INTERRUPTED_AFTER_COMMIT_BOUNDARY",
        retry: { kind: "none" },
      },
    });
  });

  it("flushes a shutdown interruption before returning", async () => {
    const manager = new OperationManager(new WebEventBroker());
    const accepted = manager.start({
      kind: "scene-narration",
      scopeId: "session-2",
      clientRequestId: "shutdown-request",
      request: { purpose: "orientation" },
      run: async () => new Promise<never>(() => undefined),
    });
    await Promise.resolve();
    manager.shutdown();

    await expect(manager.wait(accepted.operation.id)).resolves.toMatchObject({
      status: "interrupted",
      phase: "interrupted-on-shutdown",
      error: { code: "HOST_SHUTDOWN_INTERRUPTED_OPERATION" },
    });
  });

  it("redacts progress and results before persistence, API projection, and SSE", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-web-operation-redaction-"));
    const events = new WebEventBroker();
    const manager = new OperationManager(events, { workspaceRoot: root });
    await manager.initialize();
    const accepted = manager.start({
      kind: "prepare",
      scopeId: "source-redaction",
      clientRequestId: "redaction-request",
      request: { apiKey: "raw-request-secret-canary", mode: "all" },
      run: async (context) => {
        context.update("model-working", {
          authorization: "Bearer operation-progress-canary",
          nested: { apiKey: "plain-progress-secret-canary" },
        });
        return {
          credentials: "plain-result-secret-canary",
          safe: "completed",
        };
      },
    });

    const completed = await manager.wait(accepted.operation.id);
    expect(completed).toMatchObject({
      progress: {
        authorization: "[REDACTED]",
        nested: { apiKey: "[REDACTED]" },
      },
      result: { credentials: "[REDACTED]", safe: "completed" },
    });
    const observable = JSON.stringify({ completed, events: events.replayAfter() });
    const persisted = await readTree(root);
    for (const secret of [
      "raw-request-secret-canary",
      "operation-progress-canary",
      "plain-progress-secret-canary",
      "plain-result-secret-canary",
    ]) {
      expect(observable).not.toContain(secret);
      expect(persisted).not.toContain(secret);
    }
  });

  it("preserves bounded domain recovery instructions on asynchronous failures", async () => {
    const manager = new OperationManager(new WebEventBroker());
    const accepted = manager.start({
      kind: "player-move",
      scopeId: "session-recovery",
      clientRequestId: "recovery-request",
      request: { expectedHead: "commit-old", text: "Proceed." },
      run: async () => {
        throw webError(409, "BRANCH_HEAD_MOVED", "The branch head changed. Bearer operation-error-canary", {
          kind: "after-refresh",
          discoveryEndpoint: "/api/v1/instances/main",
          copyField: "headCommitId",
          maxAttempts: 1,
        }, { apiKey: "plain-error-secret-canary" });
      },
    });

    const completed = await manager.wait(accepted.operation.id);
    expect(completed).toMatchObject({
      status: "failed",
      error: {
        code: "BRANCH_HEAD_MOVED",
        message: "The branch head changed. [REDACTED]",
        details: { apiKey: "[REDACTED]" },
        retry: {
          kind: "after-refresh",
          discoveryEndpoint: "/api/v1/instances/main",
          copyField: "headCommitId",
          maxAttempts: 1,
        },
      },
    });
  });
});

function abortPromise(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function readTree(root: string): Promise<string> {
  const values: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else values.push(await fs.readFile(target, "utf8"));
    }
  }
  await visit(root);
  return values.join("\n");
}
