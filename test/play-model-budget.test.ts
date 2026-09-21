import { describe, expect, it, vi } from "vitest";
import { currentPlayModelBudget, withPlayModelBudget } from "../src/runtime/play-model-budget.js";
import { ModelRequestBudget, ModelRequestBudgetError, installModelRequestBudget } from "../src/agent/model-request-budget.js";
import { RuntimeHooks, withRuntimeHooks, type RuntimeHookEvent } from "../src/runtime/hooks.js";

const limits = { maxModelCalls: 2, maxRequestBytes: 1_000, maxTotalPayloadBytes: 1_500 };

describe("host play model-budget lifetime", () => {
  it("shares consumption across translation, consultation, NPC and render while preserving local gates", async () => {
    const aggregate = new ModelRequestBudget(limits);
    await withPlayModelBudget(async () => {
      const captured = currentPlayModelBudget();
      aggregate.beginCall({ task: "translate" });
      await withPlayModelBudget(async () => {
        expect(currentPlayModelBudget()).toBe(captured);
        aggregate.beginCall({ task: "consult" });
      });
      const dispatch = vi.fn();
      const agent = { streamFunction: dispatch, onPayload: undefined } as Parameters<typeof installModelRequestBudget>[0];
      installModelRequestBudget(agent, [aggregate, new ModelRequestBudget(limits)]);
      expect(() => agent.streamFunction({} as never, {} as never)).toThrow(ModelRequestBudgetError);
      expect(dispatch).not.toHaveBeenCalled();
      expect(() => aggregate.beginCall({ task: "render-retry" })).toThrow("budget exhausted");
    }, { budget: aggregate });
    expect(aggregate.report()).toMatchObject({ blocked: true, closed: true, usage: { modelCalls: 2 } });
  });

  it("isolates simultaneous users without merging counts or leaking scopes", async () => {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const first = new ModelRequestBudget(limits), second = new ModelRequestBudget(limits);
    await Promise.all([
      withPlayModelBudget(async () => { first.beginCall({}); await barrier; expect(currentPlayModelBudget()?.id).toBe("one"); }, { id: "one", budget: first }),
      withPlayModelBudget(async () => { second.beginCall({}); second.beginCall({}); release(); await Promise.resolve(); expect(currentPlayModelBudget()?.id).toBe("two"); }, { id: "two", budget: second }),
    ]);
    expect(currentPlayModelBudget()).toBeUndefined();
    expect(first.snapshot().modelCalls).toBe(1);
    expect(second.snapshot().modelCalls).toBe(2);
  });

  it("rejects late callbacks and replacement gates, while an actual new user input has a fresh lifetime", async () => {
    const budget = new ModelRequestBudget(limits);
    let retained!: ModelRequestBudget;
    await withPlayModelBudget(async () => {
      retained = currentPlayModelBudget()!.budget;
      await expect(withPlayModelBudget(async () => undefined, { budget: new ModelRequestBudget(limits) })).rejects.toThrow("cannot replace");
      await withPlayModelBudget(async () => expect(currentPlayModelBudget()?.budget).not.toBe(budget), { newScope: true });
      expect(currentPlayModelBudget()?.budget).toBe(budget);
    }, { budget });
    expect(() => retained.beginCall({})).toThrow("already ended");
  });

  it("emits one host-only aggregate report with actual provider usage even after failure", async () => {
    const events: RuntimeHookEvent[] = [];
    const hooks = new RuntimeHooks();
    hooks.subscribe(event => { events.push(event); });
    const budget = new ModelRequestBudget(limits);
    await expect(withRuntimeHooks(hooks, () => withPlayModelBudget(async () => {
      budget.beginCall({ secret: "do-not-log" });
      budget.admitPayload({ messages: [] });
      budget.observeUsage({ input: 9, output: 3, cacheRead: 5, totalTokens: 17, cost: { total: 0.02 } });
      throw new Error("provider disconnected");
    }, { id: "move-123", budget }))).rejects.toThrow("provider disconnected");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "model.budget", status: "failed", metadata: {
      budgetId: "move-123", modelCalls: 1, payloads: 1, inputTokens: 9, outputTokens: 3, cacheReadTokens: 5, reportedTotalTokens: 17,
    } });
    expect(JSON.stringify(events)).not.toContain("do-not-log");
  });
});
