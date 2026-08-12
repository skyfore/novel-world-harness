import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
  chargedUsageTokens,
  LIVE_TOKEN_BUDGET_HARD_LIMIT,
  LiveTokenBudgetError,
  LiveTokenBudgetExceededError,
  LiveTokenLedger,
  type LiveTokenUsage,
  wrapLiveStreamFunction,
} from "../src/agent/live-token-ledger.js";
import { compilerLiveTestOptions, DEFAULT_COMPILER_LIVE_MAX_OUTPUT_TOKENS, DEFAULT_COMPILER_LIVE_MAX_REQUESTS } from "../src/compiler/pi-compiler.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function createLedger(limit = 1_000, options: { now?: () => Date; idFactory?: () => string } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-live-budget-"));
  roots.push(root);
  const filePath = path.join(root, ".novel-harness", "live-tests", "token-budget-v1.json");
  const ledger = await LiveTokenLedger.open({ filePath, limit, campaignId: "test-campaign", ...options });
  return { filePath, ledger, root };
}

function reservationInput(contextCeiling = 600) {
  return {
    provider: "fake-provider",
    model: "fake-model",
    runId: "run-1",
    contextCeiling,
    outputCap: 128,
  };
}

function usage(overrides: Partial<LiveTokenUsage> = {}): LiveTokenUsage {
  return {
    input: 100,
    output: 50,
    cacheRead: 20,
    cacheWrite: 5,
    totalTokens: 160,
    ...overrides,
  };
}

describe("compiler live-test defaults", () => {
  it("uses compiler-sized request and output caps while preserving explicit lower limits", () => {
    expect(compilerLiveTestOptions({ ledgerPath: "/tmp/ledger.json" })).toMatchObject({
      maxRequests: DEFAULT_COMPILER_LIVE_MAX_REQUESTS,
      maxOutputTokens: DEFAULT_COMPILER_LIVE_MAX_OUTPUT_TOKENS,
    });
    expect(compilerLiveTestOptions({ ledgerPath: "/tmp/ledger.json", maxRequests: 7, maxOutputTokens: 2048 })).toMatchObject({
      maxRequests: 7,
      maxOutputTokens: 2048,
    });
  });
});

describe("LiveTokenLedger", () => {
  it("atomically reserves a request and reconciles exact provider usage", async () => {
    let id = 0;
    const now = new Date("2026-08-11T12:00:00.000Z");
    const { filePath, ledger } = await createLedger(1_000, {
      now: () => now,
      idFactory: () => `request-${++id}`,
    });

    const reservation = await ledger.reserve(reservationInput());
    expect(reservation).toMatchObject({ id: "request-1", status: "reserved", contextCeiling: 600 });
    await expect(ledger.status()).resolves.toMatchObject({
      chargedTokens: 0,
      reservedTokens: 600,
      remainingTokens: 400,
      reservedRequests: 1,
    });

    const settled = await ledger.settle(reservation.id, {
      stopReason: "stop",
      usage: usage({ reasoning: 40 }),
    });
    expect(settled).toMatchObject({ status: "settled", chargedTokens: 175, conservative: false });
    await expect(ledger.status()).resolves.toMatchObject({
      chargedTokens: 175,
      reservedTokens: 0,
      remainingTokens: 825,
      settledRequests: 1,
      conservativeChargeTokens: 0,
      reportedUsage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 5, reasoning: 40 },
    });

    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    await expect(fs.stat(`${filePath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("counts cache tokens but does not double-count reasoning tokens", () => {
    expect(chargedUsageTokens(usage({ totalTokens: 170, reasoning: 45 }))).toBe(175);
    expect(chargedUsageTokens(usage({ totalTokens: 190, reasoning: 45 }))).toBe(190);
  });

  it("keeps reconciliation idempotent", async () => {
    const { ledger } = await createLedger();
    const reservation = await ledger.reserve(reservationInput());
    const first = await ledger.settle(reservation.id, { stopReason: "stop", usage: usage() });
    const duplicate = await ledger.settle(reservation.id, {
      stopReason: "stop",
      usage: usage({ input: 900, totalTokens: 900 }),
    });

    expect(duplicate).toEqual(first);
    expect((await ledger.status()).chargedTokens).toBe(175);
  });

  it("charges the full reservation for failures, aborts and missing usage", async () => {
    const { ledger } = await createLedger(3_000);
    const failed = await ledger.reserve(reservationInput(600));
    const aborted = await ledger.reserve({ ...reservationInput(700), runId: "run-2" });
    const missing = await ledger.reserve({ ...reservationInput(800), runId: "run-3" });

    await ledger.settleFailure(failed.id, new Error("provider failed"));
    await ledger.settle(aborted.id, { stopReason: "aborted", usage: usage() });
    await ledger.settle(missing.id, { stopReason: "stop" });

    await expect(ledger.status()).resolves.toMatchObject({
      chargedTokens: 2_100,
      conservativeChargeTokens: 2_100,
      reservedTokens: 0,
      remainingTokens: 900,
    });
  });

  it("leaves an uncompleted reservation consuming budget after a simulated crash", async () => {
    const { filePath, ledger } = await createLedger(1_000);
    await ledger.reserve(reservationInput(700));

    const reopened = await LiveTokenLedger.open({
      filePath,
      limit: 1_000,
      campaignId: "test-campaign",
    });
    await expect(reopened.reserve({ ...reservationInput(301), runId: "run-after-crash" })).rejects.toBeInstanceOf(
      LiveTokenBudgetExceededError,
    );
    expect((await reopened.status()).reservedTokens).toBe(700);
  });

  it("serializes concurrent reservations under the hard budget", async () => {
    const { ledger } = await createLedger(1_000);
    const results = await Promise.allSettled([
      ledger.reserve({ ...reservationInput(600), runId: "concurrent-a" }),
      ledger.reserve({ ...reservationInput(600), runId: "concurrent-b" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await ledger.status()).reservedTokens).toBe(600);
  });

  it("blocks future requests if reported usage exceeds the reserved ceiling", async () => {
    const { ledger } = await createLedger(1_000);
    const reservation = await ledger.reserve(reservationInput(100));
    await ledger.settle(reservation.id, {
      stopReason: "stop",
      usage: usage({ input: 150, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 150 }),
    });

    expect((await ledger.status()).breached).toBe(true);
    await expect(ledger.reserve({ ...reservationInput(1), runId: "blocked" })).rejects.toBeInstanceOf(
      LiveTokenBudgetExceededError,
    );
  });

  it("enforces an immutable campaign and a 100,000,000-token absolute limit", async () => {
    const { filePath } = await createLedger(500);
    await expect(LiveTokenLedger.open({
      filePath,
      campaignId: "test-campaign",
      limit: 501,
    })).rejects.toThrow("limit mismatch");
    await expect(LiveTokenLedger.open({
      filePath: path.join(path.dirname(filePath), "too-large.json"),
      limit: LIVE_TOKEN_BUDGET_HARD_LIMIT + 1,
    })).rejects.toThrow(`hard limit of ${LIVE_TOKEN_BUDGET_HARD_LIMIT}`);
  });

  it("fails closed on a corrupt ledger", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-live-budget-corrupt-"));
    roots.push(root);
    const filePath = path.join(root, "budget.json");
    await fs.writeFile(filePath, "not-json\n", { encoding: "utf8", mode: 0o600 });

    await expect(LiveTokenLedger.open({ filePath, limit: 1_000 })).rejects.toBeInstanceOf(LiveTokenBudgetError);
  });

  it("fails closed instead of bypassing an existing lock", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-live-budget-locked-"));
    roots.push(root);
    const filePath = path.join(root, "budget.json");
    await fs.writeFile(`${filePath}.lock`, "owned\n", { encoding: "utf8", mode: 0o600 });

    await expect(LiveTokenLedger.open({ filePath, limit: 1_000, lockTimeoutMs: 0 })).rejects.toThrow(
      "Refusing to bypass",
    );
  });

  it("repairs only an explicitly inspected stale local lock", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-live-budget-stale-lock-"));
    roots.push(root);
    const filePath = path.join(root, "budget.json");
    const owner = {
      version: 1,
      pid: 2_147_483_647,
      hostname: os.hostname(),
      id: "stale-owner",
      createdAt: new Date("2026-08-11T12:00:00.000Z").toISOString(),
    } as const;
    await fs.writeFile(`${filePath}.lock`, `${JSON.stringify(owner)}\n`, { encoding: "utf8", mode: 0o600 });

    await expect(LiveTokenLedger.inspectLock(filePath)).resolves.toEqual(owner);
    await expect(LiveTokenLedger.repairStaleLock({ filePath, expectedOwnerId: owner.id })).resolves.toBe(true);
    await expect(LiveTokenLedger.inspectLock(filePath)).resolves.toBeUndefined();
    await expect(LiveTokenLedger.open({ filePath, limit: 1_000 })).resolves.toBeInstanceOf(LiveTokenLedger);
  });

  it("refuses to repair a lock owned by the current live process", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-live-budget-active-lock-"));
    roots.push(root);
    const filePath = path.join(root, "budget.json");
    const owner = {
      version: 1,
      pid: process.pid,
      hostname: os.hostname(),
      id: "active-owner",
      createdAt: new Date().toISOString(),
    } as const;
    await fs.writeFile(`${filePath}.lock`, `${JSON.stringify(owner)}\n`, { encoding: "utf8", mode: 0o600 });

    await expect(LiveTokenLedger.repairStaleLock({ filePath, expectedOwnerId: owner.id }))
      .rejects.toThrow("still alive");
  });
});

type FakeModel = {
  provider: string;
  id: string;
  contextWindow: number;
  maxTokens: number;
  marker: string;
};

type FakeOptions = {
  maxTokens?: number;
  maxRetries?: number;
  temperature?: number;
  deferred?: false | { window?: "15m" | "1h" | "24h" };
};

type FakeMessage = {
  stopReason: string;
  usage?: LiveTokenUsage;
  text: string;
  errorMessage?: string;
};

class FakeStream implements AsyncIterable<unknown> {
  constructor(
    private readonly finalMessage: FakeMessage,
    private readonly events: unknown[] = [],
  ) {}

  async *[Symbol.asyncIterator]() {
    for (const event of this.events) yield event;
  }

  async result(): Promise<FakeMessage> {
    return this.finalMessage;
  }
}

class RejectingResultStream implements AsyncIterable<unknown> {
  async *[Symbol.asyncIterator]() {}

  async result(): Promise<FakeMessage> {
    throw new Error("stream result rejected");
  }
}

const fakeModel: FakeModel = {
  provider: "fake-provider",
  id: "fake-model",
  contextWindow: 1_000,
  maxTokens: 65_536,
  marker: "preserved",
};

describe("wrapLiveStreamFunction", () => {
  it("caps both model and request output, disables provider retries, forwards events and settles usage", async () => {
    const { ledger } = await createLedger(5_000);
    const calls: Array<{ model: FakeModel; options?: FakeOptions }> = [];
    const settle = ledger.settle.bind(ledger);
    let settlementCalls = 0;
    ledger.settle = (...args) => {
      settlementCalls += 1;
      return settle(...args);
    };
    const original = async (model: FakeModel, _context: { prompt: string }, options?: FakeOptions) => {
      calls.push({ model, options });
      return new FakeStream(
        { stopReason: "stop", usage: usage(), text: "done" },
        [{ type: "start" }, { type: "done" }],
      );
    };
    const wrapped = wrapLiveStreamFunction(original, {
      ledger,
      runId: "fake-run",
      maxOutputTokens: 4_096,
      maxRequests: 2,
    });

    const stream = wrapped(fakeModel, { prompt: "test" }, { maxTokens: 32_000, maxRetries: 7, temperature: 0.2 });
    expect(stream).not.toBeInstanceOf(Promise);
    expect(stream.constructor).toBe(createAssistantMessageEventStream().constructor);
    const seen: unknown[] = [];
    for await (const event of stream) seen.push(event);
    await expect(stream.result()).resolves.toMatchObject({ text: "done" });

    expect(seen.map((event) => (event as { type: string }).type)).toEqual(["start", "done"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toMatchObject({ maxTokens: 4_096, marker: "preserved" });
    expect(calls[0]?.options).toMatchObject({ maxTokens: 4_096, maxRetries: 0, deferred: false, temperature: 0.2 });
    expect(wrapped.getRequestCount()).toBe(1);
    expect(settlementCalls).toBe(1);
    await expect(ledger.status()).resolves.toMatchObject({ chargedTokens: 175, reservedTokens: 0 });
  });

  it("also respects a model cap lower than the configured live cap", async () => {
    const { ledger } = await createLedger(5_000);
    let observedModelCap = 0;
    let observedOptionCap = 0;
    const original = async (model: FakeModel, _context: object, options?: FakeOptions) => {
      observedModelCap = model.maxTokens;
      observedOptionCap = options?.maxTokens ?? 0;
      return new FakeStream({ stopReason: "stop", usage: usage(), text: "done" });
    };
    const wrapped = wrapLiveStreamFunction(original, {
      ledger,
      runId: "low-model-cap",
      maxOutputTokens: 4_096,
    });

    await (await wrapped({ ...fakeModel, maxTokens: 2_048 }, {})).result();
    expect(observedModelCap).toBe(2_048);
    expect(observedOptionCap).toBe(2_048);
  });

  it("does not raise an existing request cap lower than the configured live cap", async () => {
    const { ledger } = await createLedger(5_000);
    let observedModelCap = 0;
    let observedOptionCap = 0;
    const original = async (model: FakeModel, _context: object, options?: FakeOptions) => {
      observedModelCap = model.maxTokens;
      observedOptionCap = options?.maxTokens ?? 0;
      return new FakeStream({ stopReason: "stop", usage: usage(), text: "done" });
    };
    const wrapped = wrapLiveStreamFunction(original, {
      ledger,
      runId: "low-request-cap",
      maxOutputTokens: 4_096,
    });

    await wrapped(fakeModel, {}, { maxTokens: 1_024 }).result();
    expect(observedModelCap).toBe(1_024);
    expect(observedOptionCap).toBe(1_024);
  });

  it("stops before invoking the provider when the per-run request cap is reached", async () => {
    const { ledger } = await createLedger(5_000);
    let providerCalls = 0;
    const original = async () => {
      providerCalls += 1;
      return new FakeStream({ stopReason: "stop", usage: usage(), text: "done" });
    };
    const wrapped = wrapLiveStreamFunction(original, { ledger, runId: "one-request", maxRequests: 1 });

    await (await wrapped(fakeModel, {})).result();
    await expect(wrapped(fakeModel, {}).result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: expect.stringContaining("request limit"),
    });
    expect(providerCalls).toBe(1);
    expect(wrapped.getRequestCount()).toBe(1);
  });

  it("enforces the same run request cap across wrappers and does not count unused streams", async () => {
    const { ledger } = await createLedger(5_000);
    let providerCalls = 0;
    const original = async () => {
      providerCalls += 1;
      return new FakeStream({ stopReason: "stop", usage: usage(), text: "done" });
    };
    const first = wrapLiveStreamFunction(original, { ledger, runId: "shared-run", maxRequests: 1 });
    const second = wrapLiveStreamFunction(original, { ledger, runId: "shared-run", maxRequests: 2 });

    first(fakeModel, {});
    expect(first.getRequestCount()).toBe(0);
    expect((await ledger.status()).requests).toBe(0);
    await first(fakeModel, {}).result();
    await expect(second(fakeModel, {}).result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: expect.stringContaining("request limit"),
    });
    expect(providerCalls).toBe(1);
    expect(second.getRequestCount()).toBe(0);
  });

  it("stops before invoking the provider when a context-window reservation does not fit", async () => {
    const { ledger } = await createLedger(500);
    let providerCalls = 0;
    const original = async () => {
      providerCalls += 1;
      return new FakeStream({ stopReason: "stop", usage: usage(), text: "done" });
    };
    const wrapped = wrapLiveStreamFunction(original, { ledger, runId: "too-large" });

    await expect(wrapped(fakeModel, {}).result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: expect.stringContaining("budget exhausted"),
    });
    expect(providerCalls).toBe(0);
    expect((await ledger.status()).requests).toBe(0);
  });

  it("settles conservatively if stream creation throws", async () => {
    const { ledger } = await createLedger(2_000);
    const original = async (): Promise<FakeStream> => {
      throw new Error("transport exploded");
    };
    const wrapped = wrapLiveStreamFunction(original, { ledger, runId: "throwing-stream" });

    await expect(wrapped(fakeModel, {}).result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: "transport exploded",
    });
    await expect(ledger.status()).resolves.toMatchObject({
      chargedTokens: 1_000,
      conservativeChargeTokens: 1_000,
      reservedTokens: 0,
    });
  });

  it("continues the guarded pump and reconciles usage if a consumer stops iterating early", async () => {
    const { ledger } = await createLedger(2_000);
    const original = async () => new FakeStream(
      { stopReason: "stop", usage: usage(), text: "done" },
      [{ type: "first" }, { type: "second" }],
    );
    const wrapped = wrapLiveStreamFunction(original, { ledger, runId: "early-return" });
    const stream = wrapped(fakeModel, {});
    const iterator = stream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "first" }, done: false });
    await iterator.return?.();
    await expect(stream.result()).resolves.toMatchObject({ text: "done" });
    await expect(ledger.status()).resolves.toMatchObject({
      chargedTokens: 175,
      conservativeChargeTokens: 0,
      reservedTokens: 0,
    });
  });

  it("settles conservatively if the stream result rejects", async () => {
    const { ledger } = await createLedger(2_000);
    const original = async () => new RejectingResultStream();
    const wrapped = wrapLiveStreamFunction(original, { ledger, runId: "rejecting-result" });

    const stream = await wrapped(fakeModel, {});
    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: "stream result rejected",
    });
    await expect(ledger.status()).resolves.toMatchObject({
      chargedTokens: 1_000,
      conservativeChargeTokens: 1_000,
      reservedTokens: 0,
    });
  });

  it("settles error and aborted final messages conservatively even when usage is reported", async () => {
    const { ledger } = await createLedger(3_000);
    const messages: FakeMessage[] = [
      { stopReason: "error", usage: usage(), text: "error" },
      { stopReason: "aborted", usage: usage(), text: "aborted" },
    ];
    const original = async () => new FakeStream(messages.shift()!);
    const wrapped = wrapLiveStreamFunction(original, { ledger, runId: "failed-finals" });

    await (await wrapped(fakeModel, {})).result();
    await (await wrapped(fakeModel, {})).result();
    await expect(ledger.status()).resolves.toMatchObject({
      chargedTokens: 2_000,
      conservativeChargeTokens: 2_000,
      reservedTokens: 0,
    });
  });
});
