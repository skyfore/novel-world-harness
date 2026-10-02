import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxText, getCurrentTools } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { ModelRequestBudget } from "../src/agent/model-request-budget.js";
import { LocalFileWorkspace } from "../src/workspace/local-files.js";
import { mockPiProvider } from "./helpers/pi-provider.js";

const roots: string[] = [];
const sessions: PiAgentSession[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const session of sessions.splice(0)) await session.dispose();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function create(includeNwhExtension = false, cacheWarming: "idle" | "streaming" = "idle", budget?: ModelRequestBudget, additionalTools?: ToolDefinition[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-policy-"));
  roots.push(root);
  const piDir = path.join(root, "pi");
  await fs.mkdir(piDir);
  const settings = JSON.stringify({ cacheWarming, retry: { enabled: false }, compaction: { enabled: false } });
  await fs.writeFile(path.join(piDir, "settings.json"), settings);
  const session = await PiAgentSession.create({ workspace: await LocalFileWorkspace.create(root),
    runtimeDir: path.join(root, "runtime"), piAgentDir: piDir, saveSession: true,
    includeLocalTools: false, includeNwhExtension, requestBudget: budget, additionalTools });
  sessions.push(session);
  return { session, root, piDir, settings };
}

describe("Pi 1.0 request policy", () => {
  it.each([false, true])("projects canonical history and prompt/tool deltas with main extension=%s", async include => {
    const { session, root } = await create(include);
    const provider = await mockPiProvider(session);
    const manager = provider.host.session.sessionManager;
    manager.appendCustomMessageEntry("nwh-compiler-batch", "PRIVATE_EVIDENCE", false);
    manager.appendMessage({ role: "system", content: "FUTURE_CANON", timestamp: 1,
      toolsAdded: [{ name: "bash", description: "FORBIDDEN_TOOL", parameters: { type: "object" } }] });
    manager.appendMessage(fauxAssistantMessage([fauxText("PRIVATE_COMPILER_RESULT")]));
    manager.appendCustomMessageEntry("nwh-play", "PRIVATE_PLAYER_SCENE", true);
    await session.prompt("ordinary visible request");
    await session.prompt("second request");
    const payload = JSON.stringify(provider.payloads);
    expect(provider.payloads).toHaveLength(2);
    for (const secret of ["PRIVATE_EVIDENCE", "PRIVATE_COMPILER_RESULT", "PRIVATE_PLAYER_SCENE", "FUTURE_CANON", "FORBIDDEN_TOOL", root]) {
      expect(payload).not.toContain(secret);
    }
    expect(payload).toContain("ordinary visible request");
    expect(JSON.stringify(manager.getEntries())).toContain("PRIVATE_EVIDENCE");
  });

  it("fails closed before transport when a mandatory projection is removed", async () => {
    const { session } = await create();
    const provider = await mockPiProvider(session);
    const policy = provider.host.session.resourceLoader.getExtensions().extensions.find(extension => extension.path === "<inline:nwh-request-policy>")!;
    policy.handlers.delete("context");
    await expect(session.prompt("hello")).rejects.toThrow("required context projection");
    expect(provider.payloads).toHaveLength(0);
    expect(provider.contexts).toHaveLength(0);
  });

  it("rejects provider payloads that reacquire an out-of-scope tool", async () => {
    const { session } = await create();
    const provider = await mockPiProvider(session);
    await expect(provider.host.session.agent.onPayload!({ tools: [{ type: "function", function: { name: "bash" } }] }, provider.host.session.model!))
      .rejects.toThrow("outside the active scope");
    expect(provider.payloads).toHaveLength(0);
  });

  it.each([false, true])("disables idle warming without changing global preferences, main extension=%s", async include => {
    const { session, piDir, settings } = await create(include, "idle");
    const provider = await mockPiProvider(session);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await session.prompt("a cacheable turn");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(provider.payloads).toHaveLength(1);
    expect(provider.host.session.cacheWarmingStatus?.state).toBe("inactive");
    expect(await fs.readFile(path.join(piDir, "settings.json"), "utf8")).toBe(settings);
  });

  it("blocks warming even if a policy disappears after a stream starts", async () => {
    const { session } = await create(false, "streaming");
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const provider = await mockPiProvider(session, { response: async () => {
      await pending;
      return fauxAssistantMessage([fauxText("done")]);
    } });
    // Give warming a prior real usage estimate, then leave the next call streaming.
    provider.host.session.sessionManager.appendMessage({ ...fauxAssistantMessage([fauxText("prior")]),
      usage: { input: 100_000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 100_001,
        cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 } } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const prompt = session.prompt("keep streaming");
    // File I/O remains real; wait for provider dispatch without advancing cache time.
    await vi.waitFor(() => expect(provider.payloads).toHaveLength(1));
    provider.host.session.resourceLoader.getExtensions().extensions
      .find(extension => extension.path === "<inline:nwh-request-policy>")!.handlers.delete("cache_warming_decision");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(provider.payloads).toHaveLength(1);
    release();
    await prompt;
    await expect(session.prompt("next")).rejects.toThrow("required request policy");
  });

  it("counts manual summaries and rejects an additional summary before transport", async () => {
    const budget = new ModelRequestBudget({ maxModelCalls: 4, maxRequestBytes: 500_000, maxTotalPayloadBytes: 2_000_000 });
    const { session } = await create(false, "idle", budget);
    const provider = await mockPiProvider(session);
    provider.host.session.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 20, reserveTokens: 1000 } });
    await session.prompt("first ordinary conversation ".repeat(100));
    await session.prompt("second ordinary conversation ".repeat(100));
    await session.prompt("third ordinary conversation ".repeat(100));
    await provider.host.session.compact();
    expect(provider.payloads).toHaveLength(4);
    expect(budget.snapshot()).toMatchObject({ modelCalls: 4, payloads: 4 });
    expect(budget.report().providerUsage.reports).toBe(4);
    await expect(session.prompt("exhausted")).rejects.toThrow("model-call limit");
    expect(provider.payloads).toHaveLength(4);
  });

  it("projects tree summary input in place and retains trusted summary metadata", async () => {
    const budget = new ModelRequestBudget({ maxModelCalls: 10, maxRequestBytes: 500_000, maxTotalPayloadBytes: 2_000_000 });
    const { session } = await create(false, "idle", budget);
    const provider = await mockPiProvider(session);
    const manager = provider.host.session.sessionManager;
    await session.prompt("common ancestor");
    const target = manager.getLeafId()!;
    manager.appendCustomMessageEntry("nwh-compiler-batch", "TREE_PRIVATE_EVIDENCE", false);
    manager.appendMessage({ role: "system", content: "TREE_PRIVATE_PROMPT", timestamp: 1 });
    manager.appendMessage(fauxAssistantMessage([fauxText("TREE_PRIVATE_RESULT")]));
    manager.appendCustomMessageEntry("nwh-narrator", "TREE_PRIVATE_SCENE", true);
    await session.prompt("visible branch conversation");
    const result = await provider.host.session.navigateTree(target, { summarize: true });
    expect(result.cancelled).toBe(false);
    expect(provider.payloads).toHaveLength(3);
    expect(JSON.stringify(provider.payloads[2])).toContain("visible branch conversation");
    expect(JSON.stringify(provider.payloads[2])).not.toContain("TREE_PRIVATE");
    expect(manager.getEntries().some(entry => entry.type === "custom" && entry.customType === "nwh-context-policy")).toBe(true);
    await session.prompt("continue after tree summary");
    expect(JSON.stringify(provider.payloads.at(-1))).not.toContain("TREE_PRIVATE");
    expect(budget.snapshot()).toMatchObject({ modelCalls: 4, payloads: 4 });
    expect(budget.report().providerUsage.reports).toBe(4);
  });

  it("drops untrusted legacy summaries and keeps the original history", async () => {
    const { session } = await create();
    const provider = await mockPiProvider(session);
    const manager = provider.host.session.sessionManager;
    manager.appendCustomMessageEntry("nwh-compiler-batch", "COMPILER_EVIDENCE", false);
    const kept = manager.appendMessage({ role: "user", content: "visible past", timestamp: 2 });
    manager.appendCompaction("UNTRUSTED_FUTURE_SUMMARY", kept, 50_000);
    await session.prompt("ordinary continuation");
    expect(JSON.stringify(provider.payloads)).not.toContain("UNTRUSTED_FUTURE_SUMMARY");
    expect(JSON.stringify(manager.getEntries())).toContain("UNTRUSTED_FUTURE_SUMMARY");
  });

  it("charges failed and retried provider calls once each", async () => {
    const budget = new ModelRequestBudget({ maxModelCalls: 3, maxRequestBytes: 500_000, maxTotalPayloadBytes: 2_000_000 });
    const { session } = await create(false, "idle", budget);
    const provider = await mockPiProvider(session, { response: (_context, index) => {
      const message = fauxAssistantMessage([fauxText("recovered")]);
      if (index === 0) { message.stopReason = "error"; message.errorMessage = "503 Service Unavailable"; }
      return message;
    } });
    provider.host.session.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
    await expect(session.prompt("retry fixture")).resolves.toBe("recovered");
    expect(budget.snapshot()).toMatchObject({ modelCalls: 2, payloads: 2 });
    expect(budget.report().providerUsage.reports).toBe(2);
  });

  it("counts automatic compaction and excludes private transcript content", async () => {
    const budget = new ModelRequestBudget({ maxModelCalls: 10, maxRequestBytes: 500_000, maxTotalPayloadBytes: 2_000_000 });
    const { session } = await create(false, "idle", budget);
    const provider = await mockPiProvider(session, { contextWindow: 100_500 });
    await session.prompt("ordinary prior text ".repeat(100));
    provider.host.session.sessionManager.appendCustomMessageEntry("nwh-play", "AUTO_PRIVATE_SCENE", true);
    provider.host.session.settingsManager.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 20, reserveTokens: 1000 } });
    await session.prompt("ordinary next text ".repeat(100));
    expect(provider.host.session.sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(true);
    expect(provider.payloads.length).toBeGreaterThan(2);
    expect(JSON.stringify(provider.payloads)).not.toContain("AUTO_PRIVATE_SCENE");
    expect(budget.snapshot()).toMatchObject({ modelCalls: provider.payloads.length, payloads: provider.payloads.length });
    expect(budget.report().providerUsage.reports).toBe(provider.payloads.length);
  });

  it("aborts an in-flight summary without committing a partial checkpoint", async () => {
    const { session } = await create();
    let summaryStarted!: () => void;
    const started = new Promise<void>(resolve => { summaryStarted = resolve; });
    const provider = await mockPiProvider(session, { response: async (_context, index, signal) => {
      if (index === 2) {
        summaryStarted();
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) reject(new Error("aborted"));
          else signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return fauxAssistantMessage([fauxText("answer")]);
    } });
    provider.host.session.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 20, reserveTokens: 1000 } });
    await session.prompt("first long text ".repeat(100));
    await session.prompt("second long text ".repeat(100));
    const summary = provider.host.session.compact();
    const assertion = expect(summary).rejects.toThrow(/abort|cancel/iu);
    await started;
    provider.host.session.abortCompaction();
    await assertion;
    expect(provider.host.session.sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(false);
  });

  it("retains guards and cumulative budgets across extension reload", async () => {
    const budget = new ModelRequestBudget({ maxModelCalls: 2, maxRequestBytes: 500_000, maxTotalPayloadBytes: 2_000_000 });
    const { session } = await create(false, "idle", budget);
    const first = await mockPiProvider(session);
    await session.prompt("before reload");
    await first.host.session.reload();
    const second = await mockPiProvider(session);
    await session.prompt("after reload");
    await expect(session.prompt("budget remains consumed")).rejects.toThrow("model-call limit");
    expect(first.payloads).toHaveLength(1);
    expect(second.payloads).toHaveLength(1);
    expect(budget.snapshot()).toMatchObject({ modelCalls: 2, payloads: 2 });
  });

  it("honors visible context edits in tree summaries without changing stored evidence", async () => {
    const { session } = await create();
    const provider = await mockPiProvider(session);
    const manager = provider.host.session.sessionManager;
    await session.prompt("ancestor");
    const target = manager.getLeafId()!;
    const edited = manager.appendMessage({ role: "user", content: "REMOVED_DIALOGUE", timestamp: 1 });
    manager.appendContextEdit(edited, { content: "REPLACEMENT_DIALOGUE" });
    await session.prompt("continue");
    await provider.host.session.navigateTree(target, { summarize: true });
    expect(JSON.stringify(provider.payloads)).not.toContain("REMOVED_DIALOGUE");
    expect(JSON.stringify(provider.payloads.at(-1))).toContain("REPLACEMENT_DIALOGUE");
    expect(JSON.stringify(manager.getEntries())).toContain("REMOVED_DIALOGUE");
  });

  it("refuses context edits that hide a compiler privacy boundary", async () => {
    const { session } = await create();
    const provider = await mockPiProvider(session);
    const manager = provider.host.session.sessionManager;
    const boundary = manager.appendCustomMessageEntry("nwh-compiler-batch", "PRIVATE", false);
    manager.appendMessage(fauxAssistantMessage([fauxText("COMPILER_SECRET")]));
    manager.appendContextEdit(boundary, null);
    await expect(session.prompt("ordinary")).rejects.toThrow("context edit targets private");
    expect(provider.payloads).toHaveLength(0);
  });

  it("does not grant a nested tool call access to inactive tools", async () => {
    const hidden = vi.fn(async () => ({ content: [{ type: "text" as const, text: "forbidden" }], details: {} }));
    const hiddenTool = defineTool({ name: "hidden_fixture", label: "Hidden", description: "Hidden", parameters: Type.Object({}), execute: hidden });
    let nestedError: boolean | undefined;
    const caller = defineTool({ name: "caller_fixture", label: "Caller", description: "Caller", parameters: Type.Object({}),
      async execute(_id, _input, _signal, _update, context) {
        const outcome = await context.executeTool("hidden_fixture", {});
        nestedError = outcome.isError;
        return outcome.result;
      } });
    const { session } = await create(false, "idle", undefined, [caller, hiddenTool]);
    const provider = await mockPiProvider(session, { response: (_context, index) => {
      if (index > 0) return fauxAssistantMessage([fauxText("finished")]);
      return { ...fauxAssistantMessage([{ type: "toolCall", id: "call-1", name: "caller_fixture", arguments: {} }]), stopReason: "toolUse" };
    } });
    provider.host.session.setActiveToolsByName(["caller_fixture"]);
    await session.prompt("exercise nested scope");
    expect(nestedError).toBe(true);
    expect(hidden).not.toHaveBeenCalled();
    for (const context of provider.contexts) {
      expect(getCurrentTools(context.messages).map(tool => tool.name)).toEqual(["caller_fixture"]);
    }
  });
});
