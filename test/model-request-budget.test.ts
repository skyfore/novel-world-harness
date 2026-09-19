import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { ModelRequestBudget, ModelRequestBudgetError, installModelRequestBudget } from "../src/agent/model-request-budget.js";

type BudgetAgent = Pick<AgentSession["agent"], "streamFunction" | "onPayload">;
const limits = { maxModelCalls: 2, maxRequestBytes: 1000, maxTotalPayloadBytes: 1500 };
const model = {} as Parameters<NonNullable<BudgetAgent["onPayload"]>>[1];

function agent() {
  return { streamFunction: vi.fn(), onPayload: vi.fn(async (payload) => payload) } as unknown as BudgetAgent;
}

describe("model request budget", () => {
  it("counts UTF-8 bytes, includes schema/system data, and never treats character counts as tokens", () => {
    const budget = new ModelRequestBudget(limits);
    const payload = { system: "中😀", tools: [{ name: "capture", schema: { properties: { value: { type: "string" } } } }] };
    budget.beginCall(payload);
    budget.admitPayload(payload);
    expect(budget.snapshot()).toEqual({ modelCalls: 1, payloads: 1, totalPayloadBytes: Buffer.byteLength(JSON.stringify(payload)), largestRequestBytes: Buffer.byteLength(JSON.stringify(payload)) });
    expect(() => budget.admitPayload({ system: "中".repeat(400) })).toThrow(ModelRequestBudgetError);
    expect(() => budget.admitPayload({ tiny: true })).toThrow("do not retry");
  });

  it("blocks tool-transcript growth and cumulative payloads without silently truncating data", () => {
    const budget = new ModelRequestBudget(limits);
    const payload = { messages: [{ role: "toolResult", content: "x".repeat(800) }] };
    budget.admitPayload(payload);
    expect(() => budget.admitPayload(payload)).toThrow("cumulative");
    expect(budget.snapshot().payloads).toBe(1);
  });

  it("shares the model-call limit across fresh protocol sessions and never dispatches over-budget calls", () => {
    const budget = new ModelRequestBudget(limits);
    const first = agent();
    const dispatch1 = first.streamFunction;
    installModelRequestBudget(first, budget);
    first.streamFunction(model, {} as never);
    const second = agent();
    const dispatch2 = second.streamFunction;
    installModelRequestBudget(second, budget);
    second.streamFunction(model, {} as never);
    expect(() => second.streamFunction(model, {} as never)).toThrow("model-call limit");
    expect(dispatch1).toHaveBeenCalledTimes(1);
    expect(dispatch2).toHaveBeenCalledTimes(1);
  });

  it("checks transformed provider payloads outside swallowed extension callbacks", async () => {
    const target = agent();
    target.onPayload = async () => ({ tools: "x".repeat(1200) });
    installModelRequestBudget(target, new ModelRequestBudget(limits));
    await expect(target.onPayload!({ small: true }, model)).rejects.toThrow("UTF-8 bytes");
  });

  it("preserves prior payload transformations and undefined means unchanged", async () => {
    const target = agent();
    target.onPayload = async () => ({ replaced: true });
    const budget = new ModelRequestBudget(limits);
    installModelRequestBudget(target, budget);
    await expect(target.onPayload!({ original: true }, model)).resolves.toEqual({ replaced: true });
    const fallback = agent();
    fallback.onPayload = async () => undefined;
    installModelRequestBudget(fallback, budget);
    await expect(fallback.onPayload!({ original: true }, model)).resolves.toEqual({ original: true });
    expect(budget.snapshot().payloads).toBe(2);
  });

  it("rejects invalid limits and non-serializable payloads without leaking content", () => {
    expect(() => new ModelRequestBudget({ ...limits, maxModelCalls: NaN })).toThrow("Invalid model request limit");
    const budget = new ModelRequestBudget(limits);
    const circular: Record<string, unknown> = { secret: "do-not-echo-this" };
    circular.self = circular;
    expect(() => budget.admitPayload(circular)).toThrow("not JSON serializable");
    try { budget.beginCall({}); } catch (error) { expect(String(error)).not.toContain("do-not-echo-this"); }
  });
});
