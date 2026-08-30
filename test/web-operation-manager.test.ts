import { describe, expect, it } from "vitest";
import { WebEventBroker } from "../src/web/event-stream.js";
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
      run: async (context) => {
        context.update("translating", { turn: 1 });
        context.markCommitBoundary({ candidateId: "candidate-1" });
        context.update("narrating", { turn: 2 });
        return { finalHead: "commit-2" };
      },
    });

    expect(accepted.reused).toBe(false);
    expect(accepted.operation.status).toBe("queued");
    const completed = await manager.wait(accepted.operation.id);

    expect(completed).toMatchObject({
      status: "succeeded",
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
});

function abortPromise(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
