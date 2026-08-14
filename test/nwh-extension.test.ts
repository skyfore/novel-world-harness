import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BeforeAgentStartEvent, BeforeAgentStartEventResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext, InputEvent, InputEventResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createNwhExtension, splitCommandArguments } from "../src/agent/nwh-extension.js";
import { LocalFileWorkspace } from "../src/workspace/local-files.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { BranchStore } from "../src/world/store.js";
import { SourceMaterialStore } from "../src/storage/source-material-store.js";
import type { PlayerActionTranslator } from "../src/world/player-action.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { PlaySessionStore } from "../src/world/play-session.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const root of temporaryDirectories.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(onSessionShutdown?: () => Promise<void>, playerTranslator?: PlayerActionTranslator) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-tui-extension-"));
  temporaryDirectories.push(root);
  await fs.mkdir(path.join(root, "chapters"));
  await fs.writeFile(path.join(root, "chapters", "chapter one.md"), "first line\nsecond line\n", "utf8");
  await fs.writeFile(path.join(root, ".env"), "SECRET=do-not-read\n", "utf8");
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void }>();
  const events = new Map<string, (...args: unknown[]) => unknown>();
  const registeredTools: string[] = [];
  const registeredToolDefinitions = new Map<string, ToolDefinition>();
  const sentUserMessages: string[] = [];
  const sentHiddenMessages: string[] = [];
  const sentVisibleMessages: string[] = [];
  const pi = {
    registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void }) {
      commands.set(name, command);
    },
    on(name: string, handler: unknown) {
      events.set(name, handler as (...args: unknown[]) => unknown);
    },
    registerTool(tool: { name: string }) {
      registeredTools.push(tool.name);
      registeredToolDefinitions.set(tool.name, tool as ToolDefinition);
    },
    sendUserMessage(message: string) {
      sentUserMessages.push(message);
    },
    sendMessage(message: { content: string; display?: boolean }, options?: { triggerTurn?: boolean }) {
      if (options?.triggerTurn) sentHiddenMessages.push(message.content);
      else if (message.display) sentVisibleMessages.push(message.content);
    },
  } as unknown as ExtensionAPI;
  const workspace = await LocalFileWorkspace.create(root);
  await createNwhExtension({
    workspace,
    saveSession: true,
    mode: "assistant",
    onSessionShutdown,
    playerTranslator,
    preparedCacheRoot: path.join(root, "prepared-cache"),
  })(pi);
  return { commands, events, registeredTools, registeredToolDefinitions, root, sentUserMessages, sentHiddenMessages, sentVisibleMessages };
}

function commandContext(notifications: string[], actions: { cleared: boolean; shutdown: boolean }): ExtensionCommandContext {
  return {
    ui: { notify(message: string) { notifications.push(message); } },
    model: { provider: "anthropic", id: "claude-sonnet-5" },
    sessionManager: {
      getSessionId: () => "session-1",
      getEntries: () => [],
    },
    newSession: async () => {
      actions.cleared = true;
      return { cancelled: false };
    },
    shutdown: () => { actions.shutdown = true; },
  } as unknown as ExtensionCommandContext;
}

function preparationContext(notifications: string[], questions: string[]): ExtensionCommandContext {
  return {
    ...commandContext(notifications, { cleared: false, shutdown: false }),
    mode: "tui",
    ui: {
      notify(message: string) { notifications.push(message); },
      async select(title: string, choices: string[]) {
        questions.push(title);
        return choices[0];
      },
      setStatus: () => undefined,
      theme: { fg: (_color: string, text: string) => text },
    },
  } as unknown as ExtensionCommandContext;
}

describe("NWH TUI extension", () => {
  it("registers local commands and keeps their output in the transcript", async () => {
    const { commands, sentUserMessages } = await fixture();
    expect([...commands.keys()]).toEqual(["novels", "instances", "characters", "play", "world-resume", "progress", "leave", "files", "search", "read", "prepare-content", "compile-next", "prepare-all", "status", "clear", "help", "exit"]);
    const notifications: string[] = [];
    const actions = { cleared: false, shutdown: false };
    const ctx = commandContext(notifications, actions);

    await commands.get("files")?.handler("chapter", ctx);
    await commands.get("read")?.handler('"chapters/chapter one.md" 2:2', ctx);
    await commands.get("help")?.handler("", ctx);
    await commands.get("clear")?.handler("", ctx);
    await commands.get("exit")?.handler("", ctx);

    expect(notifications[0]).toContain("chapters/chapter one.md");
    expect(notifications[1]).toContain("2: second line");
    expect(notifications[2]).toContain("/login");
    expect(notifications[2]).toContain("/model");
    expect(actions).toEqual({ cleared: true, shutdown: true });
    expect(sentUserMessages).toEqual([]);
  });

  it("expands explicit file mentions through the safe workspace reader", async () => {
    const { events } = await fixture();
    const input = events.get("before_agent_start");
    expect(input).toBeDefined();
    const result = await input?.({
      type: "before_agent_start",
      prompt: '分析 @"chapters/chapter one.md"',
      systemPrompt: "system",
      systemPromptOptions: {},
    } as unknown as BeforeAgentStartEvent) as BeforeAgentStartEventResult | undefined;
    expect(result?.message?.display).toBe(false);
    expect(result?.message?.content).toContain('<attached-file path="chapters/chapter one.md">');
    expect(result?.message?.content).toContain("first line");
  });

  it("handles denied file mentions before a model turn starts", async () => {
    const { events } = await fixture();
    const input = events.get("input");
    const notifications: string[] = [];
    const result = await input?.(
      { type: "input", text: "读取 @.env", source: "interactive" } as InputEvent,
      { mode: "tui", ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionContext,
    ) as InputEventResult | undefined;
    expect(result).toEqual({ action: "handled" });
    expect(notifications[0]).toContain("Cannot attach local file");
  });

  it("turns a pasted novel path into an indexed compiler batch", async () => {
    const { events, registeredTools, root } = await fixture();
    const input = events.get("input");
    const notifications: string[] = [];
    const statuses: string[] = [];
    const ctx = {
      mode: "tui",
      model: { provider: "anthropic", id: "claude-sonnet-5" },
      ui: {
        notify: (message: string) => notifications.push(message),
        setStatus: (_key: string, value: string) => statuses.push(value),
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionContext;
    const userInput = `'${path.join(root, "chapters", "chapter one.md")}'`;
    const result = await input?.(
      { type: "input", text: userInput, source: "interactive" } as InputEvent,
      ctx,
    ) as InputEventResult | undefined;

    expect(result).toEqual({ action: "continue" });
    expect(registeredTools).toContain("propose_entity");
    expect(registeredTools).toContain("withdraw_compiler_proposal");
    expect(registeredTools).not.toContain("propose_world_rule");
    expect(statuses).toContain("NWH · world compiler loop");
    expect(notifications[0]).toContain("Novel indexed");

    const beforeAgentStart = events.get("before_agent_start");
    const context = await beforeAgentStart?.({
      type: "before_agent_start",
      prompt: userInput,
      systemPrompt: "system",
      systemPromptOptions: {},
    } as unknown as BeforeAgentStartEvent) as BeforeAgentStartEventResult | undefined;
    expect(context?.message?.customType).toBe("nwh-compiler-batch");
    expect(context?.message?.display).toBe(false);
    expect(context?.message?.content).toContain("<source-segment");
    expect(context?.message?.content).toContain("first line");
    expect(context?.message?.content).not.toContain("Begin novel-world compiler batch");

    expect(events.get("tool_call")?.({ type: "tool_call", toolName: "read_file", toolCallId: "read-1", input: {} }, ctx))
      .toMatchObject({ block: true, reason: expect.stringContaining("evidence slice") });
    expect(events.get("tool_call")?.({ type: "tool_call", toolName: "propose_initial_world", toolCallId: "opening-too-early", input: {} }, ctx))
      .toMatchObject({ block: true, reason: expect.stringContaining("dedicated opening-world pass") });
  });

  it("archives /prepare-content text without replacing the visible user command", async () => {
    const { commands, root, sentUserMessages, sentHiddenMessages } = await fixture();
    const notifications: string[] = [];
    const ctx = preparationContext(notifications, []);

    await commands.get("prepare-content")?.handler("第一章\n人物进入城池。", ctx);

    expect(sentUserMessages).toEqual([]);
    expect(sentHiddenMessages).toHaveLength(1);
    expect(sentHiddenMessages[0]).toContain("人物进入城池");
    expect(sentHiddenMessages[0]).toContain("<source-segment");
    expect(notifications).toContainEqual(expect.stringContaining("Archived pasted content"));
    await expect(fs.stat(path.join(root, ".novel-harness"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isolates each compiler batch from earlier transcript context and replaces model-authored completion claims", async () => {
    const { events, root } = await fixture();
    const ctx = {
      mode: "tui",
      model: { provider: "anthropic", id: "claude-sonnet-5" },
      ui: {
        notify: () => undefined,
        setStatus: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionContext;
    await events.get("input")?.(
      { type: "input", text: `'${path.join(root, "chapters", "chapter one.md")}'`, source: "interactive" } as InputEvent,
      ctx,
    );

    const contextResult = events.get("context")?.({
      type: "context",
      messages: [
        { role: "assistant", content: [{ type: "text", text: "old batch claims" }] },
        { role: "custom", customType: "nwh-compiler-batch", content: "current evidence", display: false },
        { role: "assistant", content: [{ type: "text", text: "current batch" }] },
      ],
    }, ctx) as { messages?: Array<{ role: string; customType?: string }> } | undefined;
    expect(contextResult?.messages).toHaveLength(2);
    expect(contextResult?.messages?.[0]).toMatchObject({ role: "custom", customType: "nwh-compiler-batch" });

    const messageResult = events.get("message_end")?.({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Everything is canonical and complete." }] },
    }, ctx) as { message?: { content?: Array<{ type: string; text?: string }> } } | undefined;
    expect(messageResult?.message?.content?.[0]?.text).toContain("host state");
    expect(messageResult?.message?.content?.[0]?.text).toContain("pending proposals");
  });

  it("blocks every subsequent tool call until a circuit-broken agent run settles", async () => {
    const { events } = await fixture();
    const ctx = {} as ExtensionContext;
    expect(events.get("tool_result")?.({
      type: "tool_result",
      toolName: "propose_entity",
      toolCallId: "proposal-blocked",
      input: {},
      content: [],
      isError: false,
      details: { compilerBatchBlocked: true, reason: "tool-call budget exceeded", finishFailureCount: 0, toolCallCount: 41 },
    }, ctx)).toEqual({ isError: true });
    expect(events.get("tool_call")?.({
      type: "tool_call",
      toolName: "propose_entity",
      toolCallId: "late-proposal",
      input: {},
    }, ctx)).toMatchObject({ block: true, terminate: true });

    await events.get("agent_settled")?.({ type: "agent_settled" }, ctx);
    expect(events.get("tool_call")?.({
      type: "tool_call",
      toolName: "propose_entity",
      toolCallId: "next-run",
      input: {},
    }, ctx)).toBeUndefined();
  });

  it("keeps standalone source-code paths as read-only attachments", async () => {
    const { events, registeredTools, root } = await fixture();
    const codePath = path.join(root, "compiler.ts");
    await fs.writeFile(codePath, "export const compiler = true;\n", "utf8");
    const input = events.get("input");
    const notifications: string[] = [];
    const result = await input?.(
      { type: "input", text: `@${codePath}`, source: "interactive" } as InputEvent,
      { mode: "tui", ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionContext,
    ) as InputEventResult | undefined;

    expect(result).toEqual({ action: "continue" });
    expect(registeredTools).toEqual([]);
    expect(notifications).toEqual([]);
  });

  it("routes natural character selection and subsequent input through committed world play", async () => {
    const translator: PlayerActionTranslator = ({ utterance }) => ({
      title: utterance,
      participants: ["camp"],
      preconditions: [{ op: "fact-equals", entityId: "hero", field: "character.location", value: "hall" }],
      proposedDelta: {
        version: 1,
        operations: [{ op: "set", entityId: "hero", field: "character.location", value: "camp" }],
      },
      requiresKnowledge: [],
      forbidsKnowledge: [],
    });
    const { events, root, sentVisibleMessages } = await fixture(undefined, translator);
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "林岐", aliases: ["Lin Qi"], evidence: [] });
    await canon.putEntity({ id: "hall", kind: "location", canonicalName: "前厅", aliases: [], evidence: [] });
    await canon.putEntity({ id: "camp", kind: "location", canonicalName: "营地", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "hero", field: "character.location", value: "hall" },
      ],
    });
    const notifications: string[] = [];
    const statuses: Array<string | undefined> = [];
    const ctx = {
      mode: "tui",
      model: { provider: "anthropic", id: "claude-sonnet-5" },
      ui: {
        notify: (message: string) => notifications.push(message),
        setStatus: (_key: string, value: string | undefined) => statuses.push(value),
        setWorkingMessage: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionContext;
    const input = events.get("input")!;

    await expect(input(
      { type: "input", text: "我想体验林岐这个角色", source: "interactive" } as InputEvent,
      ctx,
    )).resolves.toEqual({ action: "handled" });
    await expect(new PlaySessionStore(root).read()).resolves.toMatchObject({ branchId: "main", actorId: "hero" });
    expect(sentVisibleMessages.join("\n")).toContain("Entered **林岐**");

    await expect(input(
      { type: "input", text: "我离开前厅去营地", source: "interactive" } as InputEvent,
      ctx,
    )).resolves.toEqual({ action: "handled" });

    const reopened = await openWorkspaceWorld(root);
    const head = await reopened.engine.branches.readHead("main");
    expect((await reopened.engine.projector.project(head)).values.hero?.["character.location"]).toBe("camp");
    expect(sentVisibleMessages.join("\n")).toContain("Committed at step 1");
    expect(notifications).toEqual([]);
    expect(statuses).toContain("NWH · 林岐@main · step 1");
  });

  it("opens a structured character question with a free-form alias path for /play", async () => {
    const { commands, root, sentVisibleMessages } = await fixture();
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "林岐", aliases: [], evidence: [] });
    await canon.putEntity({ id: "rival", kind: "character", canonicalName: "宿敌", aliases: ["对手"], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "rival", field: "character.alive", value: true },
      ],
    });
    const questions: string[] = [];
    const inputs: string[] = [];
    const ctx = {
      mode: "tui",
      ui: {
        notify: () => undefined,
        async select(title: string, choices: string[]) {
          questions.push(title);
          return choices.find((choice) => choice.startsWith("Enter a character"));
        },
        async input(title: string) {
          inputs.push(title);
          return "对手";
        },
        setStatus: () => undefined,
        setWorkingMessage: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionCommandContext;

    await commands.get("play")?.handler("", ctx);

    expect(questions).toEqual(["Who do you want to play on 'main'?"]);
    expect(inputs).toEqual(["Character id, name, or alias"]);
    await expect(new PlaySessionStore(root).read()).resolves.toMatchObject({ branchId: "main", actorId: "rival" });
    expect(sentVisibleMessages.join("\n")).toContain("Entered **宿敌**");
  });

  it("chooses a novel before showing a filtered, bounded character picker for /play", async () => {
    const { commands, root } = await fixture();
    const first = await createEvidenceFixture(root, "First Hero waits.\n", "first-world.txt");
    const secondNames = Array.from({ length: 8 }, (_, index) => `Second ${index + 1}`);
    const second = await createEvidenceFixture(root, `${secondNames.join(" waits.\n")} waits.\n`, "second-world.txt");
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "first-hero", kind: "character", canonicalName: "First Hero", aliases: [], evidence: first.evidence("First Hero") });
    for (const [index, name] of secondNames.entries()) {
      await canon.putEntity({ id: `second-${index + 1}`, kind: "character", canonicalName: name, aliases: [], evidence: second.evidence(name) });
    }
    const { engine } = await openWorkspaceWorld(root);
    await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "first-hero", field: "character.alive", value: true },
        ...secondNames.map((_name, index) => ({
          op: "set" as const,
          entityId: `second-${index + 1}`,
          field: "character.alive",
          value: true,
        })),
      ],
    });
    const questions: string[] = [];
    const characterPages: string[][] = [];
    const ctx = {
      mode: "tui",
      ui: {
        notify: () => undefined,
        async select(title: string, choices: string[]) {
          questions.push(title);
          if (title.startsWith("Which novel")) return choices.find((choice) => choice.includes(second.source.title));
          characterPages.push(choices);
          if (characterPages.length === 1) return choices.find((choice) => choice.startsWith("Filter choices"));
          return choices.find((choice) => choice.includes("Second 8"));
        },
        async input(title: string) {
          expect(title).toBe("Filter Character");
          return "Second 8";
        },
        setStatus: () => undefined,
        setWorkingMessage: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionCommandContext;

    await commands.get("play")?.handler("", ctx);

    expect(questions[0]).toBe("Which novel do you want to enter?");
    expect(questions[1]).toContain("Who do you want to play");
    expect(characterPages.every((page) => page.length <= 10)).toBe(true);
    expect(characterPages.flat().join("\n")).not.toContain("First Hero");
    await expect(new PlaySessionStore(root).read()).resolves.toMatchObject({
      branchId: "main",
      sourceId: second.source.id,
      actorId: "second-8",
    });
  });

  it("handles a natural character-list request without invoking the local-file assistant", async () => {
    const { events, root } = await fixture();
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "林岐", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    const notifications: string[] = [];
    const result = await events.get("input")?.(
      { type: "input", text: "这部小说有哪些角色？", source: "interactive" } as InputEvent,
      { mode: "tui", ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionContext,
    ) as InputEventResult | undefined;

    expect(result).toEqual({ action: "handled" });
    expect(notifications.join("\n")).toContain("林岐");
  });

  it("does not fall through to local-file analysis when play is requested before a world exists", async () => {
    const { events } = await fixture();
    const notifications: string[] = [];
    const result = await events.get("input")?.(
      { type: "input", text: "我想体验林岐这个角色", source: "interactive" } as InputEvent,
      { mode: "tui", ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionContext,
    ) as InputEventResult | undefined;

    expect(result).toEqual({ action: "handled" });
    expect(notifications.join("\n")).toContain("No playable instances exist");
  });

  it("offers /prepare-all and completes validated preparation inside the TUI", async () => {
    const { commands, root, sentHiddenMessages } = await fixture();
    const evidence = await createEvidenceFixture(root, "Hero waits at the opening.\n", "ready-novel.txt");
    const batches = await prepareCompilerBatches(root, evidence.source);
    for (const batch of batches) await new CompilerBatchStore(root).markComplete(evidence.source.id, batch.id);
    const proposals = new CompilerProposalService(root);
    await proposals.submit("entity", {
      proposalId: "tui-hero",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: evidence.evidence("Hero") },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("initial-world", {
      proposalId: "tui-initial",
      payload: {
        version: 1,
        delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] },
        evidence: evidence.evidence("Hero waits at the opening."),
      },
      generatedBy: { worker: "test" },
    });
    const notifications: string[] = [];
    const questions: string[] = [];

    await commands.get("prepare-all")?.handler(evidence.source.id, preparationContext(notifications, questions));

    expect(questions).toEqual(["Accept validated proposals?", "Create playable branch?"]);
    expect(notifications.some((message) => message.includes("Preparation complete"))).toBe(true);
    expect(sentHiddenMessages).toEqual([]);
    await expect(new BranchStore(root).read("main")).resolves.toMatchObject({ id: "main" });
  });

  it("supplies opening evidence and requires a successful finish before completing /prepare-all", async () => {
    const { commands, events, registeredToolDefinitions, root, sentHiddenMessages } = await fixture();
    const evidence = await createEvidenceFixture(root, "Hero waits at the opening.\n", "opening-novel.txt");
    const batches = await prepareCompilerBatches(root, evidence.source);
    for (const batch of batches) await new CompilerBatchStore(root).markComplete(evidence.source.id, batch.id);
    const notifications: string[] = [];
    const questions: string[] = [];
    const ctx = preparationContext(notifications, questions);

    await commands.get("prepare-all")?.handler(evidence.source.id, ctx);

    expect(questions).toEqual(["Generate opening world?"]);
    expect(sentHiddenMessages).toHaveLength(1);
    expect(sentHiddenMessages[0]).toContain("<source-segment");
    expect(sentHiddenMessages[0]).toContain("Hero waits at the opening.");
    const segmentId = sentHiddenMessages[0]!.match(/<source-segment id="([^"]+)">/)?.[1];
    expect(segmentId).toBeDefined();

    const initial = registeredToolDefinitions.get("propose_initial_world")!;
    const finish = registeredToolDefinitions.get("finish_compiler_batch")!;
    const proposalInput = {
      proposal_id: "tui-generated-opening",
      payload: {
        version: 1,
        delta: { version: 1, operations: [] },
        evidence: evidence.evidence("Hero waits at the opening."),
      },
    };
    const proposalResult = await initial.execute("opening-proposal", proposalInput as never, undefined, undefined, ctx);
    const finishInput = {
      outcome: "complete",
      reviewed_segments: [{ segment_id: segmentId!, disposition: "proposed", summary: "Recorded the opening state." }],
      summary: "Opening state complete.",
    };
    const finishResult = await finish.execute("opening-finish", finishInput as never, undefined, undefined, ctx);
    await events.get("agent_end")?.({
      type: "agent_end",
      messages: [
        { role: "assistant", content: [{ type: "toolCall", id: "opening-proposal", name: "propose_initial_world", arguments: proposalInput }], stopReason: "toolUse" },
        { role: "toolResult", toolCallId: "opening-proposal", toolName: "propose_initial_world", ...proposalResult, isError: false },
        { role: "assistant", content: [{ type: "toolCall", id: "opening-finish", name: "finish_compiler_batch", arguments: finishInput }], stopReason: "toolUse" },
        { role: "toolResult", toolCallId: "opening-finish", toolName: "finish_compiler_batch", ...finishResult, isError: false },
        { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
      ],
    }, ctx);
    await events.get("agent_settled")?.({ type: "agent_settled" }, ctx);

    expect(questions).toEqual(["Generate opening world?", "Accept validated proposals?", "Create playable branch?"]);
    expect(notifications.some((message) => message.includes("Preparation complete"))).toBe(true);
    await expect(new BranchStore(root).read("main")).resolves.toMatchObject({ id: "main" });
  });

  it("falls back conservatively when an opening-state run never completes its finish handshake", async () => {
    const { commands, events, registeredToolDefinitions, root } = await fixture();
    const evidence = await createEvidenceFixture(root, "Hero waits at the opening.\n", "unfinished-opening.txt");
    const batches = await prepareCompilerBatches(root, evidence.source);
    for (const batch of batches) await new CompilerBatchStore(root).markComplete(evidence.source.id, batch.id);
    const notifications: string[] = [];
    const questions: string[] = [];
    const ctx = preparationContext(notifications, questions);
    await commands.get("prepare-all")?.handler(evidence.source.id, ctx);
    const proposalInput = {
      proposal_id: "partial-opening",
      payload: {
        version: 1,
        delta: { version: 1, operations: [] },
        evidence: evidence.evidence("Hero waits at the opening."),
      },
    };
    const proposalResult = await registeredToolDefinitions.get("propose_initial_world")!
      .execute("partial-opening-call", proposalInput as never, undefined, undefined, ctx);

    await events.get("agent_end")?.({
      type: "agent_end",
      messages: [
        { role: "assistant", content: [{ type: "toolCall", id: "partial-opening-call", name: "propose_initial_world", arguments: proposalInput }], stopReason: "toolUse" },
        { role: "toolResult", toolCallId: "partial-opening-call", toolName: "propose_initial_world", ...proposalResult, isError: false },
        { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
      ],
    }, ctx);
    await events.get("agent_settled")?.({ type: "agent_settled" }, ctx);

    expect(questions).toEqual(["Generate opening world?", "Create playable branch?"]);
    expect(notifications.some((message) => message.includes("Opening-state compiler did not complete") && message.includes("explicitly finish"))).toBe(true);
    expect(notifications.some((message) => message.includes("conservative empty-delta fallback"))).toBe(true);
    await expect(new CompilerProposalService(root).store.list("rejected")).resolves.toContainEqual(
      expect.objectContaining({ id: "partial-opening" }),
    );
    await expect(new BranchStore(root).read("main")).resolves.toMatchObject({ id: "main" });
  });

  it("continues with the next compiler batch automatically during /prepare-all", async () => {
    const { commands, events, root, sentHiddenMessages } = await fixture();
    const content = Array.from({ length: 8 }, (_, index) => `第${index + 1}章\n人物${index + 1}进入城池。\n`).join("\n");
    const evidence = await createEvidenceFixture(root, content, "all-batches.txt");
    const notifications: string[] = [];
    const questions: string[] = [];
    const ctx = preparationContext(notifications, questions);

    await commands.get("prepare-all")?.handler(evidence.source.id, ctx);
    expect(questions).toEqual(["Complete novel compilation?"]);
    expect(sentHiddenMessages).toHaveLength(1);

    const hiddenContext = sentHiddenMessages[0]!;
    expect(hiddenContext).toContain("EvidenceRef");
    expect(hiddenContext).toContain("人物1进入城池");
    const segmentIds = [...hiddenContext.matchAll(/<source-segment id="([^"]+)">/g)].map((match) => match[1]!);
    expect(segmentIds.length).toBeGreaterThan(0);
    const finishInput = {
      outcome: "no-artifacts",
      reviewed_segments: segmentIds.map((segment_id) => ({ segment_id, disposition: "no-artifacts", summary: "No supported facts." })),
      summary: "No supported facts.",
    };
    await events.get("agent_end")?.({
      type: "agent_end",
      messages: [
        { role: "assistant", content: [{ type: "toolCall", id: "finish-all", name: "finish_compiler_batch", arguments: finishInput }], stopReason: "toolUse" },
        { role: "toolResult", toolCallId: "finish-all", toolName: "finish_compiler_batch", content: [], isError: false },
        { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
      ],
    }, ctx);
    await events.get("agent_settled")?.({ type: "agent_settled" }, ctx);

    expect(sentHiddenMessages).toHaveLength(2);
    expect(sentHiddenMessages[1]).toContain("<source-segment");
    expect(sentHiddenMessages[1]).toContain("EvidenceRef");
    expect(notifications.some((message) => message.includes("starting compiler batch 2/"))).toBe(true);
  });

  it("reports the concrete source repair reason instead of a generic /prepare-all failure", async () => {
    const { commands, root, sentUserMessages } = await fixture();
    const evidence = await createEvidenceFixture(root, "Original opening.\n", "repair-source.txt");
    await prepareCompilerBatches(root, evidence.source);
    const archived = path.join(new SourceMaterialStore().root, evidence.source.contentSha256);
    await fs.chmod(archived, 0o700);
    await fs.rm(archived, { recursive: true, force: true });
    await fs.writeFile(path.join(root, evidence.source.sourcePath), "Changed opening.\n", "utf8");
    const notifications: string[] = [];
    const questions: string[] = [];

    await commands.get("prepare-all")?.handler(
      evidence.source.id,
      preparationContext(notifications, questions),
    );

    expect(questions).toEqual([]);
    expect(sentUserMessages).toEqual([]);
    expect(notifications).toContainEqual(expect.stringContaining("Archived source material"));
    expect(notifications).toContainEqual(expect.stringContaining(`nwh audit --source ${evidence.source.id}`));
  });

  it("checkpoints a successful compiler batch before /compile-next advances", async () => {
    const { commands, events, root, sentUserMessages, sentHiddenMessages } = await fixture();
    const novelPath = path.join(root, "long-novel.txt");
    await fs.writeFile(
      novelPath,
      Array.from({ length: 8 }, (_, index) => `第${index + 1}章\n人物${index + 1}进入城池。\n`).join("\n"),
      "utf8",
    );
    const notifications: string[] = [];
    const actions = { cleared: false, shutdown: false };
    const ctx = {
      ...commandContext(notifications, actions),
      mode: "tui",
      ui: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionCommandContext;

    await events.get("input")?.(
      { type: "input", text: novelPath, source: "interactive" } as InputEvent,
      ctx as unknown as ExtensionContext,
    );
    await events.get("agent_end")?.({
      type: "agent_end",
      messages: [
        { role: "assistant", content: [{ type: "toolCall", id: "proposal-1", name: "propose_entity", arguments: { proposal_id: "entity-1" } }], stopReason: "toolUse" },
        { role: "toolResult", toolCallId: "proposal-1", toolName: "propose_entity", content: [], isError: false },
        { role: "assistant", content: [{ type: "toolCall", id: "finish-1", name: "finish_compiler_batch", arguments: { outcome: "complete", proposal_ids: ["entity-1"], summary: "done" } }], stopReason: "toolUse" },
        { role: "toolResult", toolCallId: "finish-1", toolName: "finish_compiler_batch", content: [], isError: false },
        { role: "assistant", content: [{ type: "text", text: "batch complete" }], stopReason: "stop" },
      ],
    }, ctx);
    await events.get("agent_settled")?.({ type: "agent_settled" }, ctx);
    await commands.get("compile-next")?.handler("", ctx);

    expect(notifications.some((message) => message.includes("checkpointed"))).toBe(true);
    expect(sentUserMessages).toEqual([]);
    expect(sentHiddenMessages).toHaveLength(1);
    expect(sentHiddenMessages[0]).toMatch(/batch 2\/\d+/);
    expect(sentHiddenMessages[0]).toContain("<source-segment");
  });

  it("does not checkpoint a compiler batch when proposal tools fail", async () => {
    const { commands, events, root, sentUserMessages, sentHiddenMessages } = await fixture();
    const novelPath = path.join(root, "failed-novel.txt");
    await fs.writeFile(
      novelPath,
      Array.from({ length: 8 }, (_, index) => `第${index + 1}章\n人物${index + 1}进入城池。\n`).join("\n"),
      "utf8",
    );
    const notifications: string[] = [];
    const actions = { cleared: false, shutdown: false };
    const ctx = {
      ...commandContext(notifications, actions),
      mode: "tui",
      ui: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionCommandContext;

    await events.get("input")?.(
      { type: "input", text: novelPath, source: "interactive" } as InputEvent,
      ctx as unknown as ExtensionContext,
    );
    await events.get("agent_end")?.({
      type: "agent_end",
      messages: [
        { role: "assistant", content: [{ type: "toolCall", id: "proposal-failed", name: "propose_entity", arguments: { proposal_id: "entity-failed" } }], stopReason: "toolUse" },
        { role: "toolResult", toolCallId: "proposal-failed", toolName: "propose_entity", content: [], isError: true },
        { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
      ],
    }, ctx);
    await events.get("agent_settled")?.({ type: "agent_settled" }, ctx);
    await commands.get("compile-next")?.handler("", ctx);

    expect(notifications.some((message) => message.includes("not checkpointed") && message.includes("failed"))).toBe(true);
    expect(sentUserMessages).toEqual([]);
    expect(sentHiddenMessages).toHaveLength(1);
    expect(sentHiddenMessages[0]).toMatch(/batch 1\/\d+/);
    expect(sentHiddenMessages[0]).toContain("<source-segment");
  });

  it("lets a successful finish supersede abandoned drafts after low-level retries settle", async () => {
    const { commands, events, root, sentUserMessages, sentHiddenMessages } = await fixture();
    const novelPath = path.join(root, "retry-novel.txt");
    await fs.writeFile(
      novelPath,
      Array.from({ length: 8 }, (_, index) => `第${index + 1}章\n人物${index + 1}进入城池。\n`).join("\n"),
      "utf8",
    );
    const notifications: string[] = [];
    const actions = { cleared: false, shutdown: false };
    const ctx = {
      ...commandContext(notifications, actions),
      mode: "tui",
      ui: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionCommandContext;

    await events.get("input")?.(
      { type: "input", text: novelPath, source: "interactive" } as InputEvent,
      ctx as unknown as ExtensionContext,
    );
    await events.get("agent_end")?.({
      type: "agent_end",
      messages: [
        { role: "assistant", content: [{ type: "toolCall", id: "abandoned", name: "propose_entity", arguments: { proposal_id: "entity-abandoned" } }], stopReason: "toolUse" },
        { role: "toolResult", toolCallId: "abandoned", toolName: "propose_entity", content: [], isError: true },
        { role: "assistant", content: [], stopReason: "error" },
      ],
    }, ctx);
    await events.get("agent_end")?.({
      type: "agent_end",
      messages: [
        { role: "assistant", content: [{ type: "toolCall", id: "recovered", name: "propose_entity", arguments: { proposal_id: "entity-recovered" } }], stopReason: "toolUse" },
        { role: "toolResult", toolCallId: "recovered", toolName: "propose_entity", content: [], isError: false },
        { role: "assistant", content: [{ type: "toolCall", id: "finished", name: "finish_compiler_batch", arguments: { outcome: "complete", proposal_ids: ["entity-recovered"], summary: "done" } }], stopReason: "toolUse" },
        { role: "toolResult", toolCallId: "finished", toolName: "finish_compiler_batch", content: [], isError: false },
        { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
      ],
    }, ctx);
    await events.get("agent_settled")?.({ type: "agent_settled" }, ctx);
    await commands.get("compile-next")?.handler("", ctx);

    expect(notifications.some((message) => message.includes("checkpointed"))).toBe(true);
    expect(sentUserMessages).toEqual([]);
    expect(sentHiddenMessages).toHaveLength(1);
    expect(sentHiddenMessages[0]).toMatch(/batch 2\/\d+/);
    expect(sentHiddenMessages[0]).toContain("<source-segment");
  });

  it("resets the registered finish handshake before the next TUI compiler batch", async () => {
    const { commands, events, registeredToolDefinitions, root } = await fixture();
    const novelPath = path.join(root, "multi-batch-novel.txt");
    await fs.writeFile(
      novelPath,
      Array.from({ length: 8 }, (_, index) => `第${index + 1}章\n这里没有足够事实${index + 1}。\n`).join("\n"),
      "utf8",
    );
    const notifications: string[] = [];
    const actions = { cleared: false, shutdown: false };
    const ctx = {
      ...commandContext(notifications, actions),
      mode: "tui",
      ui: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionCommandContext;

    await events.get("input")?.(
      { type: "input", text: novelPath, source: "interactive" } as InputEvent,
      ctx as unknown as ExtensionContext,
    );
    const finish = registeredToolDefinitions.get("finish_compiler_batch")!;
    const firstPrompt = await events.get("before_agent_start")?.({ type: "before_agent_start", prompt: "compile", systemPrompt: "system", systemPromptOptions: {} });
    const firstSegmentIds = [...String((firstPrompt as { message?: { content?: string } } | undefined)?.message?.content).matchAll(/<source-segment id="([^"]+)">/g)].map((match) => match[1]!);
    const finishInput = {
      outcome: "no-artifacts",
      proposal_ids: [],
      reviewed_segments: firstSegmentIds.map((segment_id) => ({ segment_id, disposition: "no-artifacts", summary: "No supported facts." })),
      summary: "No supported facts.",
    };
    await expect(finish.execute("finish-first", finishInput as never, undefined, undefined, ctx))
      .resolves.toMatchObject({ details: { compilerBatchFinished: true, outcome: "no-artifacts" } });
    await events.get("agent_end")?.({
      type: "agent_end",
      messages: [
        { role: "assistant", content: [{ type: "toolCall", id: "finish-first", name: "finish_compiler_batch", arguments: finishInput }], stopReason: "toolUse" },
        { role: "toolResult", toolCallId: "finish-first", toolName: "finish_compiler_batch", content: [], isError: false },
        { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
      ],
    }, ctx);
    await events.get("agent_settled")?.({ type: "agent_settled" }, ctx);
    await commands.get("compile-next")?.handler("", ctx);

    const secondPrompt = await events.get("before_agent_start")?.({ type: "before_agent_start", prompt: "compile", systemPrompt: "system", systemPromptOptions: {} });
    const secondSegmentIds = [...String((secondPrompt as { message?: { content?: string } } | undefined)?.message?.content).matchAll(/<source-segment id="([^"]+)">/g)].map((match) => match[1]!);
    const secondFinishInput = {
      ...finishInput,
      reviewed_segments: secondSegmentIds.map((segment_id) => ({ segment_id, disposition: "no-artifacts", summary: "No supported facts." })),
    };
    await expect(finish.execute("finish-second", secondFinishInput as never, undefined, undefined, ctx))
      .resolves.toMatchObject({ details: { compilerBatchFinished: true, outcome: "no-artifacts" } });
  });

  it("flushes workspace settings before the TUI process exits", async () => {
    let flushed = false;
    const { events } = await fixture(async () => { flushed = true; });

    await events.get("session_shutdown")?.();

    expect(flushed).toBe(true);
  });

  it("parses quoted command paths without a readline shell", () => {
    expect(splitCommandArguments('"drafts/chapter one.md" 40:80')).toEqual(["drafts/chapter one.md", "40:80"]);
  });
});
