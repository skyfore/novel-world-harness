import { describe, expect, it, vi } from "vitest";
import { currentRuntimeHooks, RuntimeHooks, withRuntimeHooks, type RuntimeHookEvent } from "../src/runtime/hooks.js";
import { HookCommand } from "../src/runtime/hook-command.js";
import { createPiHooksExtension, withCommandHooks } from "../src/agent/pi-hooks.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function capture(hooks = new RuntimeHooks()) {
  const events: RuntimeHookEvent[] = [];
  hooks.subscribe(event => { events.push(event); });
  return { hooks, events };
}
describe("runtime hooks", () => {
  it("awaits async observers, preserves results, correlates nested operations and unsubscribes", async () => {
    const { hooks, events } = capture();
    let done = false;
    const unsubscribe = hooks.subscribe(async () => { await Promise.resolve(); done = true; });
    const result = await hooks.run("command", "test", {}, () => currentRuntimeHooks().run("play.turn", "turn", {}, async () => 42));
    expect(result).toBe(42);
    expect(done).toBe(true);
    expect(events.map(e => e.type)).toEqual(["play.turn", "command"]);
    expect(events[0]!.parentId).toBe(events[1]!.id);
    unsubscribe(); done = false;
    await hooks.run("command", "test", {}, async () => {});
    expect(done).toBe(false);
  });
  it("isolates failures and timeouts without replacing the original business exception", async () => {
    const onError = vi.fn();
    const { hooks, events } = capture(new RuntimeHooks({ timeoutMs: 10, onError }));
    hooks.subscribe(() => { throw new Error("observer failure"); });
    hooks.subscribe(async () => { await new Promise(() => {}); });
    const error = new Error("original");
    await expect(hooks.run("command", "test", {}, async () => { throw error; })).rejects.toBe(error);
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("failed");
    expect(onError).toHaveBeenCalledTimes(2);
  });
  it("keeps concurrent scopes isolated and reports aborts", async () => {
    const a = capture(), b = capture();
    await Promise.all([a, b].map(({ hooks }, i) => withRuntimeHooks(hooks, async () => {
      await Promise.resolve();
      await currentRuntimeHooks().run("command", String(i), {}, async () => {});
    })));
    expect(a.events.map(e => e.name)).toEqual(["0"]);
    expect(b.events.map(e => e.name)).toEqual(["1"]);
    await expect(a.hooks.run("command", "abort", {}, async () => { throw new DOMException("cancelled", "AbortError"); })).rejects.toThrow();
    expect(a.events.at(-1)!.status).toBe("cancelled");
  });
  it("does not let an observer mutate event metadata", async () => {
    const { hooks, events } = capture(new RuntimeHooks({ onError: () => {} }));
    hooks.subscribe(event => { (event.metadata as Record<string, unknown>).sourceId = "changed"; });
    await hooks.run("compilation", "publish", { sourceId: "original" }, async () => {});
    expect(events[0]!.metadata.sourceId).toBe("original");
    expect(Object.isFrozen(events[0])).toBe(true);
  });
  it("observes nested Commander success and rejection once per action", async () => {
    const { hooks, events } = capture();
    const program = new HookCommand("nwh");
    program.command("world").command("show").action(async () => {});
    program.command("fail").action(async () => { throw new Error("command failed"); });
    await withRuntimeHooks(hooks, () => program.parseAsync(["world", "show"], { from: "user" }));
    await expect(withRuntimeHooks(hooks, () => program.parseAsync(["fail"], { from: "user" }))).rejects.toThrow("command failed");
    expect(events.map(e => [e.name, e.status])).toEqual([["nwh world show", "succeeded"], ["nwh fail", "failed"]]);
  });
});

describe("Pi lifecycle bridge", () => {
  it("waits for settled after retries, observes failed tools, and ignores duplicate settled", async () => {
    const { hooks, events } = capture();
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = { on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler) } as unknown as ExtensionAPI;
    await createPiHooksExtension(hooks, "/workspace")(pi);
    const ctx = { sessionManager: { getSessionId: () => "session" } };
    const fire = (name: string, event = {}) => handlers.get(name)?.(event, ctx);
    await fire("agent_start");
    await fire("message_end", { message: { role: "assistant", provider: "test", model: "model", stopReason: "error", errorMessage: "network" } });
    await fire("agent_start"); // automatic retry, not a new user turn
    await fire("message_end", { message: { role: "assistant", provider: "test", model: "model", stopReason: "stop" } });
    await fire("tool_execution_end", { toolName: "read_file", toolCallId: "call", isError: true });
    expect(events.some(e => e.type === "session.turn")).toBe(false);
    await fire("agent_settled"); await fire("agent_settled");
    expect(events.map(e => [e.type, e.status])).toEqual([
      ["llm.response", "failed"], ["llm.response", "succeeded"], ["tool", "failed"], ["session.turn", "succeeded"],
    ]);
    expect(events.every(e => e.metadata.sessionId === "session")).toBe(true);
  });
  it("observes slash handler errors without replacing Pi registration", async () => {
    const { hooks, events } = capture();
    const commands = new Map<string, any>();
    const pi = { registerCommand: (name: string, command: unknown) => commands.set(name, command) } as unknown as ExtensionAPI;
    withCommandHooks(pi, "/workspace").registerCommand("test", { handler: async () => { throw new Error("slash failed"); } });
    await expect(withRuntimeHooks(hooks, () => commands.get("test").handler("", { sessionManager: { getSessionId: () => "s" } }))).rejects.toThrow("slash failed");
    expect(events.map(e => [e.name, e.status])).toEqual([["/test", "failed"]]);
  });
});
