import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BeforeAgentStartEvent, BeforeAgentStartEventResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext, InputEvent, InputEventResult, MarkdownTransformer, MessageRenderer, ReplacedSessionContext, ToolDefinition, TransientAssistantStream, TransientAssistantStreamOptions } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxThinking, type AssistantMessage, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNwhExtension,
  compilerToolNamesForScope,
  filterNwhModelContext,
  parseTuiReparseArguments,
  splitCommandArguments,
  type NwhExtensionOptions,
} from "../src/agent/nwh-extension.js";
import { LocalFileWorkspace } from "../src/workspace/local-files.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { BranchStore } from "../src/world/store.js";
import { SourceMaterialStore } from "../src/storage/source-material-store.js";
import type { PlayerActionTranslator, PlayerWorldAdjudicator } from "../src/world/player-action.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { PlaySessionStore } from "../src/world/play-session.js";
import { COMPILER_TOOL_NAMES } from "../src/compiler/proposal-tools.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { canonicalJson, contentHash } from "../src/world/canonical.js";
import { WorkspaceOperationLock } from "../src/util/workspace-lock.js";
import { PossibilityTemplateStore } from "../src/world/possibility-model.js";

const temporaryDirectories: string[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type RecordedTransientStream = {
  key: string;
  options?: TransientAssistantStreamOptions;
  updates: AssistantMessage[];
  events: AssistantMessageEvent[];
  completed?: AssistantMessage;
  committed?: { customType: string; details?: unknown };
  disposed: boolean;
};

function transientStreamRecorder(streams: RecordedTransientStream[]) {
  return (key: string, options?: TransientAssistantStreamOptions): TransientAssistantStream => {
    const recorded: RecordedTransientStream = {
      key,
      ...(options ? { options } : {}),
      updates: [],
      events: [],
      disposed: false,
    };
    streams.push(recorded);
    return {
      update(message, event) {
        recorded.updates.push(structuredClone(message));
        if (event) recorded.events.push(structuredClone(event));
      },
      complete(message) {
        recorded.completed = structuredClone(message);
      },
      commit(customType, details) {
        recorded.committed = {
          customType,
          ...(details === undefined ? {} : { details: structuredClone(details) }),
        };
      },
      dispose() {
        recorded.disposed = true;
      },
    };
  };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const root of temporaryDirectories.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(
  onSessionShutdown?: () => Promise<void>,
  playerTranslator?: PlayerActionTranslator,
  runReparse?: NwhExtensionOptions["runReparse"],
  playerOpeningNarrator?: NwhExtensionOptions["playerOpeningNarrator"],
  activeWorldScene?: NwhExtensionOptions["activeWorldScene"],
  restoreSavedWorldOnStartup?: NwhExtensionOptions["restoreSavedWorldOnStartup"],
  extensionConfig: {
    mode?: NwhExtensionOptions["mode"];
    preRegisteredToolNames?: readonly string[];
    playerWorldAdjudicator?: PlayerWorldAdjudicator;
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-tui-extension-"));
  temporaryDirectories.push(root);
  await fs.mkdir(path.join(root, "chapters"));
  await fs.writeFile(path.join(root, "chapters", "chapter one.md"), "first line\nsecond line\n", "utf8");
  await fs.writeFile(path.join(root, ".env"), "SECRET=do-not-read\n", "utf8");
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void }>();
  const events = new Map<string, (...args: unknown[]) => unknown>();
  const registeredTools: string[] = [];
  const registeredToolDefinitions = new Map<string, ToolDefinition>();
  const activeTools = new Set<string>();
  const activeToolSnapshots: string[][] = [];
  const sentUserMessages: string[] = [];
  const sentHiddenMessages: string[] = [];
  const sentVisibleMessages: string[] = [];
  const sentMessages: Array<{ customType?: string; content: string; display?: boolean; details?: unknown }> = [];
  const markdownTransformers: MarkdownTransformer[] = [];
  const messageRenderers = new Map<string, MessageRenderer>();
  const appendedEntries: Array<{ customType: string; data?: unknown }> = [];
  let sessionName: string | undefined;
  const pi = {
    registerMessageRenderer(customType: string, renderer: MessageRenderer) {
      messageRenderers.set(customType, renderer);
    },
    appendEntry(customType: string, data?: unknown) {
      appendedEntries.push({ customType, data });
    },
    registerMarkdownTransformer(transformer: MarkdownTransformer) {
      markdownTransformers.push(transformer);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void }) {
      commands.set(name, command);
    },
    on(name: string, handler: unknown) {
      events.set(name, handler as (...args: unknown[]) => unknown);
    },
    registerTool(tool: { name: string }) {
      registeredTools.push(tool.name);
      registeredToolDefinitions.set(tool.name, tool as ToolDefinition);
      activeTools.add(tool.name);
    },
    getActiveTools() {
      return [...activeTools];
    },
    getAllTools() {
      return [...registeredToolDefinitions.values()].map((tool) => ({
        ...tool,
        sourceInfo: {} as never,
      }));
    },
    setActiveTools(names: string[]) {
      activeTools.clear();
      for (const name of names) if (registeredToolDefinitions.has(name)) activeTools.add(name);
      activeToolSnapshots.push([...activeTools].sort());
    },
    sendUserMessage(message: string) {
      sentUserMessages.push(message);
    },
    sendMessage(message: { customType?: string; content: string; display?: boolean; details?: unknown }, options?: { triggerTurn?: boolean }) {
      sentMessages.push(message);
      if (options?.triggerTurn) sentHiddenMessages.push(message.content);
      else if (message.display) sentVisibleMessages.push(message.content);
    },
    setSessionName(name: string) {
      sessionName = name;
    },
    getSessionName() {
      return sessionName;
    },
  } as unknown as ExtensionAPI;
  for (const name of extensionConfig.preRegisteredToolNames ?? []) {
    registeredToolDefinitions.set(name, { name, promptGuidelines: [] } as unknown as ToolDefinition);
    activeTools.add(name);
  }
  const workspace = await LocalFileWorkspace.create(root);
  await createNwhExtension({
    workspace,
    saveSession: true,
    mode: extensionConfig.mode ?? "assistant",
    onSessionShutdown,
    playerTranslator,
    ...(extensionConfig.playerWorldAdjudicator
      ? { playerWorldAdjudicator: extensionConfig.playerWorldAdjudicator }
      : {}),
    playerOpeningNarrator: playerOpeningNarrator ?? (async (frame, purpose) => purpose === "opening"
      ? `门外的风声忽远忽近，你的意识落回此刻。${frame.actor.name}所能确认的一切都在眼前，尚未发生的事仍旧沉默。门缝下的光被什么遮住了一瞬，檐下铜铃却没有响；片刻之后，木板深处又传来一声很轻的摩擦。`
      : purpose === "turn"
        ? `脚下的路已经把你带离原处，新的位置与刚才的行动一起成为无法抹去的事实。${frame.actor.name}能感到行动留下的余波，鞋底还沾着一路带来的细尘。近处的风向已经变了，陌生墙面把远处的声响折回来，身后的来路渐渐沉入昏暗。`
        : `方才的余波还停在感官里，你重新看清自己所处的这一刻。${frame.actor.name}所知道的事情没有凭空增减，周围也没有多出未经证实的答案。近处的光线缓慢移动，刚才那阵响动在墙后停住，空气里只留下潮湿木料的气味。`),
    ...(activeWorldScene !== undefined ? { activeWorldScene } : {}),
    ...(restoreSavedWorldOnStartup !== undefined ? { restoreSavedWorldOnStartup } : {}),
    ...(runReparse ? { runReparse } : {}),
    preparedCacheRoot: path.join(root, "prepared-cache"),
  })(pi);
  return {
    commands,
    events,
    registeredTools,
    registeredToolDefinitions,
    root,
    sentUserMessages,
    sentHiddenMessages,
    sentVisibleMessages,
    sentMessages,
    appendedEntries,
    markdownTransformers,
    messageRenderers,
    activeToolSnapshots,
    getActiveTools: () => [...activeTools].sort(),
    getSessionName: () => sessionName,
  };
}

function commandContext(notifications: string[], actions: { cleared: boolean; shutdown: boolean }): ExtensionCommandContext {
  return {
    ui: { notify(message: string) { notifications.push(message); } },
    model: { provider: "anthropic", id: "claude-sonnet-5" },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionName: () => undefined,
      getEntries: () => [],
    },
    newSession: async () => {
      actions.cleared = true;
      return { cancelled: false };
    },
    shutdown: () => { actions.shutdown = true; },
  } as unknown as ExtensionCommandContext;
}

function sessionReplacingCommandContext(
  previousNotifications: string[],
  replacementNotifications: string[],
  actions: { cleared: boolean },
): ExtensionCommandContext {
  let stale = false;
  const replacementCtx = {
    ui: { notify(message: string) { replacementNotifications.push(message); } },
  } as unknown as ReplacedSessionContext;
  return {
    get ui() {
      if (stale) throw new Error("stale command context");
      return { notify(message: string) { previousNotifications.push(message); } };
    },
    isIdle: () => true,
    newSession: async (options?: Parameters<ExtensionCommandContext["newSession"]>[0]) => {
      actions.cleared = true;
      stale = true;
      await options?.withSession?.(replacementCtx);
      return { cancelled: false };
    },
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
      setWidget: () => undefined,
      theme: { fg: (_color: string, text: string) => text },
    },
  } as unknown as ExtensionCommandContext;
}

async function activateLegacyPreparedRevision(
  cacheRoot: string,
  published: { cachePath: string; contentMd5: string; bundleHash?: string },
  source: { id: string; contentSha256: string },
): Promise<string> {
  const legacyBundle = JSON.parse(await fs.readFile(path.join(published.cachePath, "bundle.json"), "utf8")) as Record<string, unknown>;
  delete legacyBundle.compilerFingerprint;
  const legacyHash = contentHash(legacyBundle);
  const cacheBase = path.join(cacheRoot, published.contentMd5);
  const legacyRevision = path.join(cacheBase, "revisions", legacyHash);
  await fs.mkdir(legacyRevision, { recursive: true });
  await fs.writeFile(path.join(legacyRevision, "bundle.json"), `${canonicalJson(legacyBundle)}\n`);
  await fs.writeFile(path.join(legacyRevision, "manifest.json"), `${canonicalJson({
    version: 1,
    contentMd5: published.contentMd5,
    contentSha256: source.contentSha256,
    sourceId: source.id,
    bundleHash: legacyHash,
    createdAt: new Date(0).toISOString(),
  })}\n`);
  await fs.writeFile(path.join(cacheBase, "active.json"), `${canonicalJson({
    version: 1,
    contentMd5: published.contentMd5,
    bundleHash: legacyHash,
    updatedAt: new Date(0).toISOString(),
  })}\n`);
  return legacyHash;
}

describe("NWH TUI extension", () => {
  it("derives fail-closed compiler capabilities for source, opening, and reconciliation turns", () => {
    const source = compilerToolNamesForScope(COMPILER_TOOL_NAMES, "source");
    expect(source).not.toContain("configure_chapter_split");
    expect(source).not.toContain("find_source_evidence");
    expect(source).not.toContain("read_source_evidence");
    expect(source).not.toContain("propose_initial_world");
    expect(source).toContain("propose_novel_title");
    expect(source).toContain("peek_adjacent_evidence");
    expect(source).toContain("defer_boundary_artifact");
    expect(source).not.toContain("replace_boundary_proposal");

    const boundary = compilerToolNamesForScope(COMPILER_TOOL_NAMES, "source", "boundary-calibration");
    expect(boundary).not.toContain("peek_adjacent_evidence");
    expect(boundary).not.toContain("defer_boundary_artifact");
    expect(boundary).toContain("replace_boundary_proposal");
    expect(boundary).not.toContain("propose_novel_title");

    const structure = compilerToolNamesForScope(COMPILER_TOOL_NAMES, "source", "structure-discovery");
    expect(structure).toEqual(["configure_chapter_split", "finish_compiler_batch"]);

    const opening = compilerToolNamesForScope(COMPILER_TOOL_NAMES, "opening");
    expect(opening).toContain("propose_initial_world");
    expect(opening).not.toContain("find_source_evidence");
    expect(opening).not.toContain("propose_canonical_event");
    expect(opening).not.toContain("peek_adjacent_evidence");
    expect(opening).not.toContain("propose_novel_title");

    const reconciliation = compilerToolNamesForScope(COMPILER_TOOL_NAMES, "reconciliation");
    expect(reconciliation).toContain("find_source_evidence");
    expect(reconciliation).toContain("read_source_evidence");
    expect(reconciliation).not.toContain("propose_state_delta");
    expect(reconciliation).not.toContain("peek_adjacent_evidence");
    expect(reconciliation).not.toContain("propose_novel_title");
  });
  it("registers local commands and leaves assistant/thinking rendering to Pi", async () => {
    const { commands, sentUserMessages, markdownTransformers, messageRenderers } = await fixture();
    expect(markdownTransformers).toHaveLength(0);
    expect([...messageRenderers.keys()]).toEqual(["nwh-narrator", "nwh-play"]);
    expect([...commands.keys()]).toEqual(["novels", "instances", "remove", "characters", "play", "world-resume", "continue", "switch", "create-instance", "scene", "progress", "ooc", "leave", "files", "search", "read", "prepare-content", "compile-next", "prepare-all", "reparse", "tasks", "audit", "prepared-cache", "status", "clear", "help", "exit"]);
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

  it("uses the replacement-session context after /clear", async () => {
    const { commands } = await fixture();
    const previousNotifications: string[] = [];
    const replacementNotifications: string[] = [];
    const actions = { cleared: false };
    const ctx = sessionReplacingCommandContext(previousNotifications, replacementNotifications, actions);

    await expect(commands.get("clear")?.handler("", ctx)).resolves.toBeUndefined();

    expect(actions.cleared).toBe(true);
    expect(previousNotifications).toEqual([]);
    expect(replacementNotifications).toEqual([
      "Conversation history cleared. No novel world is active in this conversation; use /novels or /play to choose one.",
    ]);
  });

  it("leaves foreground model progress to Pi's single native loading indicator", async () => {
    const { events } = await fixture();
    const widgets: Array<{ key: string; content: string[] | undefined; placement?: string }> = [];
    const workingMessages: Array<string | undefined> = [];
    const workingIndicators: Array<{ frames?: readonly string[]; intervalMs?: number } | undefined> = [];
    const ctx = {
      mode: "tui",
      sessionManager: { getEntries: () => [] },
      ui: {
        setWidget: (key: string, content: string[] | undefined, options?: { placement?: string }) => {
          widgets.push({ key, content, placement: options?.placement });
        },
        setTitle: () => undefined,
        setWorkingMessage: (message?: string) => { workingMessages.push(message); },
        setWorkingIndicator: (indicator?: { frames?: readonly string[]; intervalMs?: number }) => {
          workingIndicators.push(indicator);
        },
        setHiddenThinkingLabel: () => undefined,
        setStatus: () => undefined,
        setHeader: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionContext;

    await events.get("session_start")?.({ type: "session_start", reason: "new" }, ctx);
    await events.get("agent_start")?.({ type: "agent_start" }, ctx);
    expect(workingMessages).toEqual(["Consulting local evidence..."]);
    expect(workingIndicators).toEqual([{ frames: expect.any(Array), intervalMs: 180 }]);
    expect(workingIndicators[0]?.frames).toHaveLength(4);
    expect(widgets).toEqual([]);

    await events.get("message_update")?.({
      type: "message_update",
      message: fauxAssistantMessage([fauxText("正在回答")]),
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "正在回答" },
    }, ctx);
    expect(widgets).toEqual([]);

    await events.get("agent_settled")?.({ type: "agent_settled" }, ctx);
    expect(widgets).toEqual([]);
  });

  it("shows a first Ctrl+C confirmation and exits only on the second press", async () => {
    const { events } = await fixture(undefined, undefined, undefined, undefined, undefined, false);
    const notifications: string[] = [];
    let terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
    let editorText = "unfinished input";
    let shutdown = false;
    const ctx = {
      mode: "tui",
      isIdle: () => true,
      abort: () => undefined,
      shutdown: () => { shutdown = true; },
      sessionManager: { getEntries: () => [] },
      ui: {
        notify: (message: string) => notifications.push(message),
        onTerminalInput: (handler: typeof terminalInput) => {
          terminalInput = handler;
          return () => { terminalInput = undefined; };
        },
        getEditorText: () => editorText,
        setEditorText: (value: string) => { editorText = value; },
        setTitle: () => undefined,
        setWorkingMessage: () => undefined,
        setWorkingIndicator: () => undefined,
        setHiddenThinkingLabel: () => undefined,
        setStatus: () => undefined,
        setHeader: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionContext;

    await events.get("session_start")?.({ type: "session_start", reason: "new" }, ctx);
    expect(terminalInput?.("\x03")).toEqual({ consume: true });
    expect(editorText).toBe("");
    expect(shutdown).toBe(false);
    expect(notifications.at(-1)).toContain("Press Ctrl+C again within 2s to exit");

    expect(terminalInput?.("\x03")).toEqual({ consume: true });
    expect(shutdown).toBe(true);
    await events.get("session_shutdown")?.();
  });

  it("parses CLI-compatible /reparse flags", () => {
    expect(parseTuiReparseArguments("--chapters 2,37 --source novel-1 --model provider/model"))
      .toEqual({ all: false, chapters: "2,37", source: "novel-1", model: "provider/model" });
    expect(parseTuiReparseArguments("--all --source novel-1"))
      .toEqual({ all: true, source: "novel-1" });
    expect(() => parseTuiReparseArguments("--all --chapters 2"))
      .toThrow("only one reparse scope");
  });

  it("offers a guarded TUI flow for removing one selected world instance", async () => {
    const { commands, root } = await fixture();
    const evidence = await createEvidenceFixture(root, "Hero waits.\n", "remove-from-tui.txt");
    await new CanonicalModelStore(root).putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: evidence.evidence("Hero"),
    });
    const { engine } = await openWorkspaceWorld(root);
    await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    }, undefined, evidence.source.id);
    const notifications: string[] = [];
    const questions: string[] = [];
    const ctx = {
      ...commandContext(notifications, { cleared: false, shutdown: false }),
      mode: "tui",
      ui: {
        notify(message: string) { notifications.push(message); },
        async select(title: string, choices: string[]) {
          questions.push(title);
          if (title === "What do you want to remove?") return choices.find((choice) => choice.includes("One instance"));
          if (title.includes("Which novel-world instance")) return choices.find((choice) => choice.includes("main"));
          if (title === "Remove this instance?") return choices.find((choice) => choice.includes("Remove instance"));
          return undefined;
        },
        setStatus: () => undefined,
        setWidget: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionCommandContext;

    await commands.get("remove")!.handler("", ctx);

    expect(questions).toEqual([
      "What do you want to remove?",
      "Which novel-world instance do you want to use?",
      "Remove this instance?",
    ]);
    expect(notifications).toContainEqual(expect.stringContaining("Removed instance 'main'"));
    await expect(new BranchStore(root).read("main")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exposes an agent tool that writes a meaningful session selector title", async () => {
    const { registeredToolDefinitions, getSessionName } = await fixture();
    const tool = registeredToolDefinitions.get("rename_session")!;

    await tool.execute(
      "rename-session",
      { title: "红楼梦 · 林黛玉支线调试" } as never,
      undefined,
      undefined,
      {} as never,
    );

    expect(getSessionName()).toBe("红楼梦 · 林黛玉支线调试");
  });

  it("blocks world-changing slash commands while Pi is streaming a foreground response", async () => {
    const { commands, sentMessages } = await fixture();
    const notifications: string[] = [];
    const ctx = {
      ...commandContext(notifications, { cleared: false, shutdown: false }),
      isIdle: () => false,
    } as ExtensionCommandContext;

    await commands.get("play")?.handler("hero main", ctx);

    expect(notifications).toContainEqual(expect.stringContaining("current model response is streaming"));
    expect(sentMessages).toEqual([]);
  });

  it("runs the shared reparse service from the TUI with structured confirmation and progress", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { commands, root } = await fixture(undefined, undefined, async (options) => {
      calls.push(options as unknown as Record<string, unknown>);
      options.onProgress?.("compiler progress");
      options.onStatus?.("Compiler batch 2/148 · waiting · elapsed 3s");
      const message = fauxAssistantMessage([
        fauxThinking("reasoning summary"),
        fauxText("Analyzing supplied chapter evidence."),
      ]);
      options.onModelEvent?.({ type: "message_start", message });
      options.onModelEvent?.({ type: "message_end", message });
      return {
        sourceId: options.sourceId!,
        chapters: [2, 3],
        previousBundleHash: "a".repeat(64),
        activeBundleHash: "b".repeat(64),
      };
    });
    const evidence = await createEvidenceFixture(root, "# Preface\nIntro.\n# One\nHero.\n# Two\nVillain.\n", "reparse-novel.txt");
    const notifications: string[] = [];
    const questions: string[] = [];
    const ctx = preparationContext(notifications, questions);

    await commands.get("reparse")?.handler(`--chapters 2-3 --source ${evidence.source.id}`, ctx);
    await commands.get("tasks")?.handler("", ctx);

    expect(questions).toEqual(["Start novel reparse?"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      root,
      sourceId: evidence.source.id,
      chapters: "2,3",
      model: "anthropic/claude-sonnet-5",
    });
    expect(typeof calls[0]?.onProgress).toBe("function");
    expect(typeof calls[0]?.onStatus).toBe("function");
    expect(typeof calls[0]?.onModelEvent).toBe("function");
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.onModelThinking).toBeUndefined();
    expect(calls[0]?.onModelText).toBeUndefined();
    expect(calls[0]?.onModelToolCall).toBeUndefined();
    expect(calls[0]?.onModelToolResult).toBeUndefined();
    expect(notifications).toContainEqual("Reparse complete for chapter(s) 2, 3.");
  });

  it("cancels and joins a background reparse before session shutdown completes", async () => {
    const started = deferred();
    let aborted = false;
    const { commands, events, root } = await fixture(undefined, undefined, async (options) => {
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("Reparse cancelled", "AbortError"));
        }, { once: true });
      });
      throw new Error("unreachable");
    });
    const evidence = await createEvidenceFixture(root, "# One\nHero waits.\n", "cancel-reparse.txt");
    const notifications: string[] = [];
    const ctx = preparationContext(notifications, []);
    const command = commands.get("reparse")!.handler(
      `--all --source ${evidence.source.id}`,
      ctx,
    );
    await started.promise;

    await expect(events.get("input")?.(
      { type: "input", text: `'${path.join(root, evidence.source.sourcePath)}'`, source: "interactive" } as InputEvent,
      ctx,
    )).resolves.toEqual({ action: "handled" });
    expect(notifications).toContainEqual(expect.stringContaining("before starting another compiler"));

    await events.get("session_shutdown")?.();
    await command;

    expect(aborted).toBe(true);
    expect(notifications).toContainEqual(expect.stringContaining("Reparse cancelled safely"));
  });

  it("keeps settled task transcripts selectable after a later task finishes", async () => {
    const { commands, root } = await fixture(undefined, undefined, async (options) => ({
      sourceId: options.sourceId!,
      chapters: [1],
      previousBundleHash: "a".repeat(64),
      activeBundleHash: "b".repeat(64),
    }));
    const evidence = await createEvidenceFixture(root, "# One\nHero waits.\n", "task-history.txt");
    const notifications: string[] = [];
    const questions: string[] = [];
    const ctx = preparationContext(notifications, questions);

    await commands.get("reparse")!.handler(`--all --source ${evidence.source.id}`, ctx);
    await commands.get("reparse")!.handler(`--all --source ${evidence.source.id}`, ctx);
    await commands.get("tasks")!.handler("", ctx);

    expect(questions.filter((question) => question === "Start novel reparse?")).toHaveLength(2);
    expect(questions).toContain("Choose an NWH task");
    expect(notifications.filter((message) => message.includes("Reparse complete"))).toHaveLength(2);
  });

  it("exposes novel audit and prepared-revision inspection in the TUI", async () => {
    const { commands, root } = await fixture();
    const evidence = await createEvidenceFixture(root, "# One\nHero waits.\n", "audited-novel.txt");
    const notifications: string[] = [];
    const ctx = preparationContext(notifications, []);

    await commands.get("audit")?.handler(`--source ${evidence.source.id}`, ctx);
    await commands.get("prepared-cache")?.handler(`list --source ${evidence.source.id}`, ctx);

    expect(notifications[0]).toContain('"invalidReferences": 0');
    expect(notifications[1]).toBe(`No prepared revisions exist for ${evidence.source.title}.`);
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
    const { events, registeredTools, root, getActiveTools } = await fixture();
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
    expect(registeredTools).toContain("propose_world_rule");
    expect(getActiveTools()).toContain("find_compiler_artifacts");
    expect(getActiveTools()).not.toContain("find_source_evidence");
    expect(getActiveTools()).not.toContain("read_source_evidence");
    expect(getActiveTools()).toContain("finish_compiler_batch");
    expect(getActiveTools()).not.toContain("propose_initial_world");
    expect(getActiveTools()).not.toContain("rename_session");
    expect(statuses).toContain("NWH · world compiler loop");
    expect(notifications[0]).toContain("Novel indexed");

    await fs.writeFile(path.join(root, "chapters", "side.md"), "SIDE_FILE_MUST_NOT_ENTER_BOUNDED_COMPILER\n", "utf8");
    const beforeAgentStart = events.get("before_agent_start");
    const context = await beforeAgentStart?.({
      type: "before_agent_start",
      prompt: 'compile @"chapters/side.md"',
      systemPrompt: "system",
      systemPromptOptions: {},
    } as unknown as BeforeAgentStartEvent) as BeforeAgentStartEventResult | undefined;
    expect(context?.message?.customType).toBe("nwh-compiler-batch");
    expect(context?.message?.display).toBe(false);
    expect(context?.message?.content).toContain("<source-segment");
    expect(context?.message?.content).toContain("first line");
    expect(context?.message?.content).not.toContain("SIDE_FILE_MUST_NOT_ENTER_BOUNDED_COMPILER");
    expect(context?.message?.content).not.toContain("<attached-file");
    expect(context?.message?.content).not.toContain("Begin novel-world compiler batch");
    expect(context?.systemPrompt).toContain("Compiler batch mode is enabled");
    expect(context?.systemPrompt).toContain("isolated Novel World Harness compiler");
    expect(context?.systemPrompt).not.toContain("system\n\n");
    expect(context?.systemPrompt).toContain("<nwh-compiler-turn-contract>");
    expect(context?.systemPrompt).toContain("find_compiler_artifacts");

    expect(events.get("tool_call")?.({ type: "tool_call", toolName: "read_file", toolCallId: "read-1", input: {} }, ctx))
      .toMatchObject({ block: true, reason: expect.stringContaining("evidence slice") });
    expect(events.get("tool_call")?.({ type: "tool_call", toolName: "propose_initial_world", toolCallId: "opening-too-early", input: {} }, ctx))
      .toMatchObject({ block: true, reason: expect.stringContaining("dedicated opening-world pass") });
  });

  it("narrows and restores tools that were pre-registered by the standalone compiler session", async () => {
    const baseCompilerTools = ["list_files", "search_files", "read_file", ...COMPILER_TOOL_NAMES];
    const { events, root, getActiveTools } = await fixture(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { mode: "compiler", preRegisteredToolNames: baseCompilerTools },
    );
    const notifications: string[] = [];
    const ctx = {
      mode: "tui",
      model: { provider: "anthropic", id: "claude-sonnet-5" },
      ui: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionContext;

    await events.get("input")?.(
      { type: "input", text: `'${path.join(root, "chapters", "chapter one.md")}'`, source: "interactive" } as InputEvent,
      ctx,
    );

    expect(getActiveTools()).toContain("propose_entity");
    expect(getActiveTools()).toContain("find_compiler_artifacts");
    expect(getActiveTools()).not.toContain("find_source_evidence");
    expect(getActiveTools()).not.toContain("propose_initial_world");
    expect(getActiveTools()).not.toContain("read_file");

    await events.get("agent_settled")?.({ type: "agent_settled" }, ctx);
    expect(getActiveTools()).toEqual([...new Set([...baseCompilerTools, "rename_session"])].sort());
    expect(notifications).toContainEqual(expect.stringContaining("was not checkpointed"));
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

  it("isolates compiler context without replacing the model text that was streamed to the user", async () => {
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

    expect(events.has("message_end")).toBe(false);
  });

  it("removes completed compiler spans from later ordinary assistant context", () => {
    const ordinaryBefore = { role: "user", content: "question before compiler" };
    const ordinaryAfter = { role: "user", content: "question after compiler" };
    const answerAfter = { role: "assistant", content: "ordinary answer" };
    const messages = filterNwhModelContext([
      ordinaryBefore,
      { role: "custom", customType: "nwh-compiler-batch", content: "evidence" },
      { role: "assistant", content: "large compiler response" },
      { role: "toolResult", content: "proposal result" },
      ordinaryAfter,
      answerAfter,
    ], false);
    expect(messages).toEqual([ordinaryBefore, ordinaryAfter, answerAfter]);

    expect(filterNwhModelContext([
      { role: "user", content: "'novel.txt'" },
      { role: "custom", customType: "nwh-compiler-batch", details: { excludePreviousUser: true } },
      { role: "assistant", content: "compiler output" },
      ordinaryAfter,
    ], false)).toEqual([ordinaryAfter]);
  });

  it("projects private NWH content before compaction and branch summarization", async () => {
    const { events, appendedEntries } = await fixture();
    const branchEntries = [
      { type: "custom_message", id: "compiler", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", customType: "nwh-compiler-batch", content: "evidence", display: false },
      { type: "message", id: "answer", parentId: "compiler", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [] } },
      { type: "custom_message", id: "play", parentId: "answer", timestamp: "2026-01-01T00:00:02.000Z", customType: "nwh-play", content: "player wording", display: true },
      { type: "compaction", id: "legacy-summary", parentId: "play", timestamp: "2026-01-01T00:00:03.000Z", firstKeptEntryId: "play", tokensBefore: 10, summary: "legacy potentially mixed summary" },
    ];
    const preparation = {
      messagesToSummarize: [
        { role: "custom", customType: "nwh-compiler-batch", content: "evidence" },
        { role: "assistant", content: "compiler answer" },
      ],
      turnPrefixMessages: [
        { role: "custom", customType: "nwh-play", content: "player wording" },
        { role: "user", content: "ordinary" },
      ],
      previousSummary: "legacy potentially mixed summary",
    };
    events.get("session_before_compact")?.({ preparation, branchEntries }, {});
    expect(preparation.messagesToSummarize).toEqual([]);
    expect(preparation.turnPrefixMessages).toEqual([{ role: "user", content: "ordinary" }]);
    expect(preparation.previousSummary).toBeUndefined();

    const treePreparation = { entriesToSummarize: branchEntries };
    events.get("session_before_tree")?.({ preparation: treePreparation }, {});
    expect(treePreparation.entriesToSummarize).toEqual([]);

    events.get("session_compact")?.({ compactionEntry: { id: "summary-1" } }, {});
    expect(appendedEntries.at(-1)).toMatchObject({
      customType: "nwh-context-policy",
      data: { version: 2, summaryEntryId: "summary-1", summaryKind: "compaction" },
    });
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
    }, ctx)).toMatchObject({ block: true, reason: expect.stringContaining("outside an explicit compiler turn") });
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
    expect(registeredTools).toEqual(["rename_session"]);
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
    const { commands, events, root, sentVisibleMessages } = await fixture(undefined, translator);
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "林岐", aliases: ["Lin Qi"], evidence: [] });
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
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "hero", field: "character.location", value: "hall" },
      ],
    }, {
      version: 1,
      operations: [{ op: "learn", actorId: "hero", claimId: "hero-knows-camp", status: "knows", confidence: 1 }],
    });
    const notifications: string[] = [];
    const statuses: Array<string | undefined> = [];
    const widgets: Array<string[] | undefined> = [];
    const ctx = {
      mode: "tui",
      model: { provider: "anthropic", id: "claude-sonnet-5" },
      ui: {
        notify: (message: string) => notifications.push(message),
        setStatus: (_key: string, value: string | undefined) => statuses.push(value),
        setWidget: (_key: string, value: string[] | undefined) => widgets.push(value),
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
    expect(sentVisibleMessages.join("\n")).not.toContain("Entered **林岐**");
    expect(sentVisibleMessages.join("\n")).toContain("门外的风声忽远忽近");
    await expect(engine.branches.readHead("main")).resolves.toBe(genesis);

    const openingMessageCount = sentVisibleMessages.length;
    await commands.get("continue")?.handler("", ctx as unknown as ExtensionCommandContext);
    expect(sentVisibleMessages).toHaveLength(openingMessageCount);
    await commands.get("switch")?.handler("", ctx as unknown as ExtensionCommandContext);
    expect(sentVisibleMessages).toHaveLength(openingMessageCount);
    await commands.get("scene")?.handler("", ctx as unknown as ExtensionCommandContext);
    expect(sentVisibleMessages).toHaveLength(openingMessageCount + 1);
    expect(sentVisibleMessages.at(-1)).toContain("门外的风声忽远忽近");
    await expect(engine.branches.readHead("main")).resolves.toBe(genesis);

    await expect(input(
      { type: "input", text: "我离开前厅去营地", source: "interactive" } as InputEvent,
      ctx,
    )).resolves.toEqual({ action: "handled" });

    const reopened = await openWorkspaceWorld(root);
    const head = await reopened.engine.branches.readHead("main");
    expect((await reopened.engine.projector.project(head)).values.hero?.["character.location"]).toBe("camp");
    expect(sentVisibleMessages.join("\n")).toContain("脚下的路已经把你带离原处");
    expect(sentVisibleMessages.join("\n")).not.toContain("Committed at step 1");
    expect(widgets.flatMap((widget) => widget ?? []).join("\n")).toContain("正在理解你的行动");
    expect(notifications).toEqual([]);
    expect(statuses).toContain("NWH · 林岐@main · step 1");
  });

  it("animates the shared loading pet while the nested player translator is pending", async () => {
    vi.useFakeTimers();
    const started = deferred();
    const release = deferred();
    const { commands, events, root } = await fixture(undefined, async () => {
      started.resolve();
      await release.promise;
      return {
        title: "Hero observes",
        participants: [],
        preconditions: [],
        proposedDelta: { version: 1, operations: [] },
        requiresKnowledge: [],
        forbidsKnowledge: [],
      };
    });
    await new CanonicalModelStore(root).putEntity({ id: "hero", kind: "character", canonicalName: "福贵", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    const widgets: Array<{ key: string; content: string[] | undefined }> = [];
    const ctx = {
      mode: "tui",
      ui: {
        notify: () => undefined,
        setStatus: () => undefined,
        setWidget: (key: string, content: string[] | undefined) => widgets.push({ key, content }),
        setWorkingMessage: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionContext;
    await commands.get("play")!.handler("hero main", ctx as unknown as ExtensionCommandContext);
    const turn = events.get("input")!(
      { type: "input", text: "我看看四周", source: "interactive" } as InputEvent,
      ctx,
    ) as Promise<InputEventResult>;
    await started.promise;
    expect(widgets.some((widget) => widget.content?.[0]?.includes("(o,o)"))).toBe(true);
    vi.advanceTimersByTime(180);
    expect(widgets.some((widget) => widget.content?.[0]?.includes("(O,o)"))).toBe(true);
    expect(widgets.some((widget) => widget.content?.[0]?.includes("正在理解你的行动"))).toBe(true);
    release.resolve();
    await turn;
    expect(widgets.at(-1)).toMatchObject({ key: "nwh-model-loading", content: undefined });
  });

  it("continues from the unchanged committed scene after a rejected proposal", async () => {
    const translator: PlayerActionTranslator = () => ({
      title: "Hero acts on an unsupported condition",
      participants: [],
      preconditions: [{ op: "fact-equals", entityId: "hero", field: "character.alive", value: false }],
      proposedDelta: { version: 1, operations: [] },
      requiresKnowledge: [],
      forbidsKnowledge: [],
    });
    const { commands, events, root, sentVisibleMessages } = await fixture(undefined, translator);
    await new CanonicalModelStore(root).putEntity({ id: "hero", kind: "character", canonicalName: "福贵", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    const notifications: string[] = [];
    const ctx = {
      mode: "tui",
      ui: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => undefined,
        setWidget: () => undefined,
        setWorkingMessage: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionContext;
    await commands.get("play")!.handler("hero main", ctx as unknown as ExtensionCommandContext);
    await expect(events.get("input")!(
      { type: "input", text: "执行这个动作", source: "interactive" } as InputEvent,
      ctx,
    )).resolves.toEqual({ action: "handled" });

    expect(await engine.branches.readHead("main")).toBe(genesis);
    expect(sentVisibleMessages.join("\n")).toContain("当前场景保持不变");
    expect(sentVisibleMessages.join("\n")).toContain("方才的余波还停在感官里");
    expect(sentVisibleMessages.join("\n")).not.toContain("Action rejected at");
    expect(notifications).toContainEqual(expect.stringContaining("scope/PLAYER_PRECONDITION_UNSATISFIED"));
  });

  it("keeps an observe/stay choice immersive by committing its safe act when adjudication fails", async () => {
    const purposes: string[] = [];
    const turnFrames: string[] = [];
    const translator: PlayerActionTranslator = () => ({
      title: "停下来确认传达室方向",
      intent: {
        kind: "observe",
        summary: "停下来，抬眼尝试确认传达室所在的方向",
        controlledAct: {
          eventTitle: "福贵停下来抬眼观察",
          actorObservation: "你停下来，抬眼查看周围。",
        },
        desiredEffect: "确认传达室所在的方向",
        targets: [{ kind: "described", description: "传达室的方向" }],
        sceneTransition: { kind: "stay" },
      },
      participants: [],
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      requiresKnowledge: [],
      forbidsKnowledge: [],
    });
    const { commands, events, root, sentVisibleMessages } = await fixture(
      undefined,
      translator,
      undefined,
      async (frame, purpose) => {
        purposes.push(purpose);
        if (purpose === "turn") turnFrames.push(JSON.stringify(frame));
        return purpose === "opening"
          ? "冷风从门缝里钻进来，你的意识落回眼前。屋檐下的光影正在缓慢移动，远处的声音被墙面折回，方向仍隐在没有看清的细节里。门板深处又传来一声很轻的摩擦。"
          : "你停在当前的位置，把注意力收回眼前。风声、光影和墙面转角依次进入视野，几处门框的轮廓在明暗之间分开，更远的字迹仍被阴影遮住。走廊尽头，一片窄窄的光斑正落在墙角。";
      },
      undefined,
      undefined,
      {
        playerWorldAdjudicator: () => {
          throw new Error("Expected exactly one valid propose_player_world_resolution call; observed 0.");
        },
      },
    );
    await new CanonicalModelStore(root).putEntity({ id: "hero", kind: "character", canonicalName: "福贵", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    const notifications: string[] = [];
    const ctx = {
      mode: "tui",
      ui: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => undefined,
        setWidget: () => undefined,
        setWorkingMessage: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionContext;

    await commands.get("play")!.handler("hero main", ctx as unknown as ExtensionCommandContext);
    await expect(events.get("input")!(
      { type: "input", text: "停下来，抬眼确认传达室所在的方向。", source: "interactive" } as InputEvent,
      ctx,
    )).resolves.toEqual({ action: "handled" });

    const newHead = await engine.branches.readHead("main");
    expect(newHead).not.toBe(genesis);
    expect((await engine.projector.project(newHead)).logicalTime.step).toBe(1);
    expect(purposes).toEqual(["opening", "turn"]);
    expect(turnFrames.join("\n")).toContain("你把注意力放回当前场景，仔细观察眼前能够确认的事物。");
    const turnFrame = JSON.parse(turnFrames[0]!) as {
      recentVisibleEvents: Array<{ title: string }>;
      recentMessages: Array<{ text: string; authority: string; worldStatus: string }>;
    };
    expect(JSON.stringify(turnFrame.recentVisibleEvents)).not.toContain("传达室");
    expect(turnFrame.recentMessages).toContainEqual({
      text: "停下来，抬眼确认传达室所在的方向。",
      authority: "untrusted-player-text",
      worldStatus: "accepted",
      role: "player",
      order: 0,
    });
    expect(sentVisibleMessages.join("\n")).not.toContain("场外提示");
    expect(sentVisibleMessages.join("\n")).not.toContain("没有形成可验证的新进展");
    expect(notifications).not.toContainEqual(expect.stringContaining("行动未提交"));
  });

  it("routes an LLM-suggested concrete action through translation and deterministic validation", async () => {
    const turnNarrated = deferred();
    const translatedUtterances: string[] = [];
    let adjudicationCalls = 0;
    const opening = "冷风从门缝里钻进来，你听见近处细碎的响动。光影落在脚边，已经知道的事没有凭空改变；门板深处的摩擦声停了片刻，又比先前更近地响了一次。墙角薄灰被风卷出一道弯曲的痕迹。";
    const afterObserve = "你把注意力收回眼前，细小的风声、光影和近处动静重新有了层次。门缝右侧留着一道新鲜划痕，细灰在边缘堆成浅线；木板另一侧的呼吸声忽然停住，走廊也随之安静下来。";
    const { commands, root } = await fixture(
      undefined,
      (input) => {
        translatedUtterances.push(input.utterance);
        return {
          title: "福贵贴近门边倾听",
          participants: [],
          preconditions: [],
          proposedDelta: {
            version: 1,
            operations: [{ op: "set", entityId: "hero", field: "character.plan", value: "听清门外是谁" }],
          },
          requiresKnowledge: [],
          forbidsKnowledge: [],
        };
      },
      undefined,
      async (_frame, purpose) => {
        if (purpose === "opening") {
          return {
            narration: opening,
            choices: [
              { action: "贴近门缝，听清外面那阵细碎的响动。" },
              { action: "朝门外喊一句：“谁在那里？”" },
            ],
          };
        }
        turnNarrated.resolve();
        return {
          narration: afterObserve,
          choices: [
            { action: "退开半步，看看门槛上有没有新留下的痕迹。" },
            { action: "伸手敲两下门板。" },
          ],
        };
      },
      undefined,
      undefined,
      {
        playerWorldAdjudicator: () => {
          adjudicationCalls += 1;
          return {
            decision: "realize",
            status: "succeeded",
            eventTitle: "福贵贴近门边倾听",
            actorObservation: "你贴近门边，细碎的响动隔着木板传来。",
          };
        },
      },
    );
    await new CanonicalModelStore(root).putEntity({ id: "hero", kind: "character", canonicalName: "福贵", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    const offered: string[] = [];
    const widgets: Array<{ key: string; content: string[] | undefined }> = [];
    const ctx = {
      mode: "tui",
      ui: {
        notify: () => undefined,
        async select(_title: string, choices: string[]) {
          offered.push(...choices);
          return choices.find((choice) => choice.includes("贴近门缝"));
        },
        setStatus: () => undefined,
        setWidget: (key: string, content: string[] | undefined) => widgets.push({ key, content }),
        setWorkingMessage: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionCommandContext;

    await commands.get("play")!.handler("hero main", ctx);
    await turnNarrated.promise;
    expect(translatedUtterances).toEqual(["贴近门缝，听清外面那阵细碎的响动。"]);
    expect(adjudicationCalls).toBe(1);
    expect(offered.some((choice) => choice.includes("贴近门缝，听清外面那阵细碎的响动。"))).toBe(true);
    expect(offered.some((choice) => choice.includes(" — "))).toBe(false);
    expect(offered.some((choice) => choice.includes("(recommended)"))).toBe(false);
    expect(widgets.some((widget) => widget.key === "nwh-model-loading" && widget.content?.join("\n").includes("正在理解你的行动"))).toBe(true);
    await expect.poll(() => widgets.at(-1), { timeout: 1_000 }).toMatchObject({ key: "nwh-model-loading", content: undefined });
    expect((await engine.projector.project(await engine.branches.readHead("main"))).logicalTime.step).toBe(1);
  });

  it("answers explicit OOC timeline questions without translating or committing an in-world turn", async () => {
    let translatorCalls = 0;
    const { commands, events, root, sentVisibleMessages } = await fixture(
      undefined,
      () => {
        translatorCalls += 1;
        throw new Error("OOC input must not reach the player translator");
      },
    );
    await new CanonicalModelStore(root).putEntity({ id: "hero", kind: "character", canonicalName: "福贵", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    const ctx = {
      mode: "tui",
      ui: {
        notify: () => undefined,
        setStatus: () => undefined,
        setWidget: () => undefined,
        setWorkingMessage: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionContext;

    await commands.get("play")!.handler("hero main", ctx as unknown as ExtensionCommandContext);
    await expect(events.get("input")!(
      { type: "input", text: "/ooc: 当前时间线在哪里？", source: "interactive" } as InputEvent,
      ctx,
    )).resolves.toEqual({ action: "handled" });

    expect(translatorCalls).toBe(0);
    expect(await engine.branches.readHead("main")).toBe(genesis);
    expect(sentVisibleMessages.join("\n")).toContain("这是场外查询");
    expect(sentVisibleMessages.join("\n")).toContain("committed step 0");
  });

  it("cancels a player translation before commitment and leaves world truth unchanged", async () => {
    const started = deferred();
    const release = deferred();
    const translator: PlayerActionTranslator = async () => {
      started.resolve();
      await release.promise;
      return {
        title: "leave",
        participants: ["camp"],
        preconditions: [],
        proposedDelta: {
          version: 1,
          operations: [{ op: "set", entityId: "hero", field: "character.location", value: "camp" }],
        },
        requiresKnowledge: [],
        forbidsKnowledge: [],
      };
    };
    const { commands, events, root, sentVisibleMessages } = await fixture(undefined, translator);
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "林岐", aliases: [], evidence: [] });
    await canon.putEntity({ id: "hall", kind: "location", canonicalName: "前厅", aliases: [], evidence: [] });
    await canon.putEntity({ id: "camp", kind: "location", canonicalName: "营地", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "hero", field: "character.location", value: "hall" },
      ],
    });
    const ctx = {
      mode: "tui",
      ui: {
        notify: () => undefined,
        setStatus: () => undefined,
        setWidget: () => undefined,
        setWorkingMessage: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionContext;
    await commands.get("play")!.handler("hero main", ctx as unknown as ExtensionCommandContext);

    const action = events.get("input")!(
      { type: "input", text: "我去营地", source: "interactive" } as InputEvent,
      ctx,
    ) as Promise<InputEventResult>;
    await started.promise;
    const leaving = commands.get("leave")!.handler("", ctx as unknown as ExtensionCommandContext);
    await leaving;
    await action;
    release.resolve();

    await expect(engine.branches.readHead("main")).resolves.toBe(genesis);
    expect(sentVisibleMessages).toContainEqual(expect.stringContaining("世界状态没有改变"));
  });

  it("reports narrator failure without presenting canned prose as a story opening", async () => {
    let narratorFrame: Record<string, unknown> | undefined;
    const { commands, root, sentVisibleMessages } = await fixture(
      undefined,
      undefined,
      undefined,
      async (frame) => {
        narratorFrame = frame as unknown as Record<string, unknown>;
        throw new Error("provider unavailable");
      },
    );
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "福贵", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    const notifications: string[] = [];
    const ctx = {
      mode: "tui",
      ui: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => undefined,
        setWorkingMessage: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionCommandContext;

    await commands.get("play")?.handler("hero main", ctx);

    expect(sentVisibleMessages).toHaveLength(1);
    expect(sentVisibleMessages[0]).toContain("没有成功生成故事开场");
    expect(sentVisibleMessages[0]).toContain("/scene");
    expect(sentVisibleMessages[0]).not.toContain("故事正从已提交的起点开始");
    expect(notifications).toContainEqual(expect.stringContaining("Scene narration failed: provider unavailable"));
    expect(notifications.join("\n")).not.toContain("当前位置尚未写入");
    expect(narratorFrame).not.toHaveProperty("branchId");
    expect(narratorFrame).not.toHaveProperty("commitId");
    expect(narratorFrame).not.toHaveProperty("logicalStep");
    expect(narratorFrame).not.toHaveProperty("storyTime");
    expect(narratorFrame?.actor).toEqual({ name: "福贵" });
    await expect(engine.branches.readHead("main")).resolves.toBe(genesis);
  });

  it("retains preflighted host actions when the narrator choice tool is empty", async () => {
    const narration = "热风从门廊里缓缓挤过来，你听见脚边的沙粒被吹得轻轻滚动。眼前已经发生的事情没有退回原处，近处的光影却仍在一点点变化；墙后忽然传来一声短促的碰响，随后又只剩下压低了的说话声。";
    let translatorCalled = false;
    const { commands, root, sentVisibleMessages, sentMessages } = await fixture(
      undefined,
      async () => {
        translatorCalled = true;
        throw new Error("empty choices must wait for free-form input");
      },
      undefined,
      async () => ({ narration, choices: [] }),
    );
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "福贵", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    const notifications: string[] = [];
    const offered: string[][] = [];
    const ctx = {
      mode: "tui",
      ui: {
        notify: (message: string) => notifications.push(message),
        async select(_title: string, choices: string[]) {
          offered.push(choices);
          return undefined;
        },
        setStatus: () => undefined,
        setWidget: () => undefined,
        setWorkingMessage: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionCommandContext;

    await commands.get("play")?.handler("hero main", ctx);

    expect(sentVisibleMessages).toEqual([narration]);
    expect(notifications.some((message) => message.includes("Scene narration failed"))).toBe(false);
    expect(offered).toHaveLength(1);
    expect(offered[0]).toContain("自由输入行动或台词…");
    expect(offered[0]!.some((choice) => choice.includes("离开原地"))).toBe(true);
    const narratorDetails = sentMessages.find((message) => message.customType === "nwh-narrator")?.details as {
      choices?: Array<{ affordanceId?: string }>;
    } | undefined;
    expect(narratorDetails?.choices?.[0]?.affordanceId).toMatch(/^aff-[a-f0-9]{24}$/);
    expect(translatorCalled).toBe(false);
    await expect(engine.branches.readHead("main")).resolves.toBe(genesis);
  });

  it("bridges isolated narrator deltas into the active TUI before persisting the final scene", async () => {
    const started = deferred();
    const release = deferred();
    const finalNarration = "黄昏的微光沿着门边慢慢退去，你听见近处的风声在停顿之间改变方向。熟悉与陌生的感觉同时压在心口，门框投下的影子越拉越长。檐角忽然落下一滴水，正砸在脚边那枚尚未干透的泥印中央。";
    const { commands, root, sentMessages } = await fixture(
      undefined,
      undefined,
      undefined,
      async (_frame, _purpose, observer) => {
        const firstDelta = "黄昏的微光沿着门边慢慢退去";
        observer?.onAttempt?.(1);
        observer?.onEvent?.({ type: "message_start", message: fauxAssistantMessage([]) } as never);
        const firstMessage = fauxAssistantMessage([fauxText(firstDelta)]);
        observer?.onEvent?.({
          type: "message_update",
          message: firstMessage,
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: firstDelta },
        } as never);
        started.resolve();
        await release.promise;
        const remaining = finalNarration.slice(firstDelta.length);
        const finalMessage = fauxAssistantMessage([fauxText(finalNarration)]);
        observer?.onEvent?.({
          type: "message_update",
          message: finalMessage,
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: remaining },
        } as never);
        observer?.onEvent?.({ type: "message_end", message: finalMessage } as never);
        return finalNarration;
      },
    );
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "福贵", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    const streams: RecordedTransientStream[] = [];
    const widgetKeys: string[] = [];
    const ctx = {
      mode: "tui",
      ui: {
        notify: () => undefined,
        setStatus: () => undefined,
        setWorkingMessage: () => undefined,
        openTransientAssistantStream: transientStreamRecorder(streams),
        setWidget: (key: string, content: string[] | undefined) => { if (content) widgetKeys.push(key); },
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionCommandContext;

    const entering = commands.get("play")!.handler("hero main", ctx);
    await started.promise;

    expect(streams[0]?.updates.at(-1)?.content).toContainEqual(expect.objectContaining({
      type: "text",
      text: "黄昏的微光沿着门边慢慢退去",
    }));
    expect(widgetKeys).not.toContain("nwh-player-scene-stream");
    expect(sentMessages.some((message) => message.customType === "nwh-narrator")).toBe(false);

    release.resolve();
    await entering;

    expect(sentMessages.some((message) => message.customType === "nwh-narrator")).toBe(false);
    expect(streams).toHaveLength(1);
    expect(streams[0]?.completed?.content).toContainEqual(expect.objectContaining({ type: "text", text: finalNarration }));
    expect(streams[0]?.committed).toMatchObject({ customType: "nwh-narrator" });
    expect(streams[0]?.disposed).toBe(false);
  });

  it("returns from session_start before generating a restored world's scene", async () => {
    const started = deferred();
    const release = deferred();
    const completed = deferred();
    const finalNarration = "风声从看不见的地方穿过来，你重新意识到脚下的世界仍停在原处。眼前能够确认的细节没有变化，记忆里已经知道的事情也没有多出答案。墙后传来一声压低的咳嗽，随即被木门合页细长的轻响盖住。";
    const { events, root, sentMessages } = await fixture(
      undefined,
      undefined,
      undefined,
      async (_frame, _purpose, observer) => {
        observer?.onAttempt?.(1);
        observer?.onText?.("风声从看不见的地方穿过来");
        started.resolve();
        await release.promise;
        completed.resolve();
        return finalNarration;
      },
    );
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "福贵", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    await new PlaySessionStore(root).write({ branchId: "main", actorId: "hero", lastCommitId: genesis });
    const ctx = {
      mode: "tui",
      model: { provider: "anthropic", id: "claude-sonnet-5" },
      sessionManager: { getEntries: () => [] },
      ui: {
        notify: () => undefined,
        setTitle: () => undefined,
        setWorkingMessage: () => undefined,
        setWorkingIndicator: () => undefined,
        setHiddenThinkingLabel: () => undefined,
        setStatus: () => undefined,
        setHeader: () => undefined,
        setWidget: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionContext;

    await events.get("session_start")?.({ type: "session_start" }, ctx);

    expect(sentMessages.some((message) => message.customType === "nwh-narrator")).toBe(false);
    await started.promise;
    expect(sentMessages.some((message) => message.customType === "nwh-narrator")).toBe(false);

    release.resolve();
    await completed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(sentMessages).toContainEqual(expect.objectContaining({ customType: "nwh-narrator", content: finalNarration, display: true }));
  });

  it("keeps a user-created new session detached from the saved world", async () => {
    let narratorCalls = 0;
    const { events, root, sentMessages, getSessionName } = await fixture(
      undefined,
      undefined,
      undefined,
      async () => {
        narratorCalls += 1;
        return "这段文字不应生成。";
      },
    );
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "福贵", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    await new PlaySessionStore(root).write({ branchId: "main", actorId: "hero", lastCommitId: genesis });
    const statuses: Array<string | undefined> = [];
    const ctx = {
      mode: "tui",
      sessionManager: { getEntries: () => [] },
      ui: {
        notify: () => undefined,
        setTitle: () => undefined,
        setWorkingMessage: () => undefined,
        setWorkingIndicator: () => undefined,
        setHiddenThinkingLabel: () => undefined,
        setStatus: (_key: string, content: string | undefined) => { statuses.push(content); },
        setHeader: () => undefined,
        setWidget: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionContext;

    await events.get("session_start")?.({
      type: "session_start",
      reason: "new",
      previousSessionFile: "/tmp/previous.jsonl",
    }, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(narratorCalls).toBe(0);
    expect(sentMessages).toEqual([]);
    expect(getSessionName()).toBeUndefined();
    expect(statuses).toContain("NWH · ready · no world selected · /novels or /play");
    await expect(new PlaySessionStore(root).read()).resolves.toMatchObject({ branchId: "main", actorId: "hero" });
  });

  it("can start an explicitly blank CLI transcript without attaching the saved world", async () => {
    let narratorCalls = 0;
    const { events, root, sentMessages, getSessionName } = await fixture(
      undefined,
      undefined,
      undefined,
      async () => {
        narratorCalls += 1;
        return "这段文字不应生成。";
      },
      undefined,
      false,
    );
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "福贵", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    await new PlaySessionStore(root).write({ branchId: "main", actorId: "hero", lastCommitId: genesis });
    const ctx = {
      mode: "tui",
      sessionManager: { getEntries: () => [] },
      ui: {
        notify: () => undefined,
        setTitle: () => undefined,
        setWorkingMessage: () => undefined,
        setWorkingIndicator: () => undefined,
        setHiddenThinkingLabel: () => undefined,
        setStatus: () => undefined,
        setHeader: () => undefined,
        setWidget: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionContext;

    await events.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(narratorCalls).toBe(0);
    expect(sentMessages).toEqual([]);
    expect(getSessionName()).toBeUndefined();
  });

  it("does not generate another scene when a restored transcript already contains player custom messages", async () => {
    let narratorCalls = 0;
    const { events, root, sentMessages } = await fixture(
      undefined,
      undefined,
      undefined,
      async () => {
        narratorCalls += 1;
        return "这段文字不应生成。";
      },
      "auto",
    );
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "福贵", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    await new PlaySessionStore(root).write({ branchId: "main", actorId: "hero", lastCommitId: genesis });
    const ctx = {
      mode: "tui",
      sessionManager: {
        getEntries: () => [
          { type: "custom_message", customType: "nwh-play", content: "**福贵:** 我看看四周", display: true },
          { type: "custom_message", customType: "nwh-narrator", content: "旧场景", display: true },
        ],
      },
      ui: {
        notify: () => undefined,
        setTitle: () => undefined,
        setWorkingMessage: () => undefined,
        setWorkingIndicator: () => undefined,
        setHiddenThinkingLabel: () => undefined,
        setStatus: () => undefined,
        setHeader: () => undefined,
        setWidget: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionContext;

    await events.get("session_start")?.({ type: "session_start" }, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(narratorCalls).toBe(0);
    expect(sentMessages.some((message) => message.customType === "nwh-narrator")).toBe(false);
  });

  it("does not honor an automatic startup scene request inside any existing visible transcript", async () => {
    let narratorCalls = 0;
    const { events, root } = await fixture(
      undefined,
      undefined,
      undefined,
      async () => {
        narratorCalls += 1;
        return "这段文字不应生成。";
      },
      "auto",
    );
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "福贵", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    await new PlaySessionStore(root).write({ branchId: "main", actorId: "hero", lastCommitId: genesis });
    const restored = deferred();
    const ctx = {
      mode: "tui",
      sessionManager: {
        getEntries: () => [{ type: "message", message: { role: "user", content: "这是已有会话" } }],
      },
      ui: {
        notify: () => undefined,
        setTitle: () => undefined,
        setWorkingMessage: () => undefined,
        setWorkingIndicator: () => undefined,
        setHiddenThinkingLabel: () => undefined,
        setStatus: (_key: string, content: string | undefined) => {
          if (content?.includes("福贵@main")) restored.resolve();
        },
        setHeader: () => undefined,
        setWidget: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionContext;

    await events.get("session_start")?.({ type: "session_start" }, ctx);
    await restored.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(narratorCalls).toBe(0);
  });

  it("does not narrate twice when /play selects the already active character and instance", async () => {
    let narratorCalls = 0;
    const { commands, root } = await fixture(
      undefined,
      undefined,
      undefined,
      async () => {
        narratorCalls += 1;
        return "风从院墙上缓慢压下来，你站在门窗投下的阴影里。脚下的尘土被吹开一小片，远处模糊的响动隔着墙时断时续。窗纸忽然向内凹了一下，又慢慢恢复原状，院角那串铜片始终没有发出声音。";
      },
    );
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "福贵", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    const ctx = {
      mode: "tui",
      ui: {
        notify: () => undefined,
        setStatus: () => undefined,
        setWidget: () => undefined,
        setWorkingMessage: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionCommandContext;

    await commands.get("play")!.handler("hero main", ctx);
    await commands.get("play")!.handler("hero main", ctx);

    expect(narratorCalls).toBe(1);
  });

  it("restores persisted choices for the current head without making another narrator request", async () => {
    let narratorCalls = 0;
    const { events, root } = await fixture(
      undefined,
      undefined,
      undefined,
      async () => {
        narratorCalls += 1;
        return "不应重新生成";
      },
    );
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "福贵", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    await new PlaySessionStore(root).write({ branchId: "main", actorId: "hero", lastCommitId: genesis });
    const questions: string[] = [];
    const offered: string[] = [];
    const ctx = {
      mode: "tui",
      sessionManager: {
        getEntries: () => [{
          type: "custom",
          customType: "nwh-narrator",
          data: {
            __piAssistantStream: 1,
            message: fauxAssistantMessage([fauxThinking("旧思考"), fauxText("旧场景")]),
            details: {
              version: 1,
              choiceContractVersion: 2,
              branchId: "main",
              actorId: "hero",
              commitId: genesis,
              purpose: "opening",
              choices: [
                { label: "观察", description: "看看周围。", action: "我先观察周围。" },
                { label: "等待", description: "等一小会。", action: "我先等待片刻。" },
              ],
            },
          },
        }],
      },
      ui: {
        notify: () => undefined,
        async select(title: string, choices: string[]) {
          questions.push(title);
          offered.push(...choices);
          return undefined;
        },
        setTitle: () => undefined,
        setWorkingMessage: () => undefined,
        setWorkingIndicator: () => undefined,
        setHiddenThinkingLabel: () => undefined,
        setStatus: () => undefined,
        setHeader: () => undefined,
        setWidget: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionContext;

    await events.get("session_start")?.({ type: "session_start" }, ctx);
    await expect.poll(() => questions, { timeout: 1_000 }).toContain("福贵，你接下来准备怎么做或怎么说？");

    expect(narratorCalls).toBe(0);
    expect(offered).toContain("1. 我先观察周围。");
    expect(offered).toContain("2. 我先等待片刻。");
    expect(offered.some((choice) => choice.includes("看看周围"))).toBe(false);
    expect(offered.some((choice) => choice.includes(" — "))).toBe(false);
    expect(offered.some((choice) => choice.includes("(recommended)"))).toBe(false);
  });

  it("does not restore a pre-contract plan menu or rebuild host choices", async () => {
    let narratorCalls = 0;
    const { events, root } = await fixture(
      undefined,
      undefined,
      undefined,
      async () => {
        narratorCalls += 1;
        return "不应重新生成";
      },
    );
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "路明非", aliases: [], evidence: [] });
    await canon.putEntity({ id: "remote-friend", kind: "character", canonicalName: "老唐", aliases: [], evidence: [] });
    await canon.putEntity({ id: "remote-bond", kind: "relationship", canonicalName: "网友关系", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "remote-friend", field: "character.alive", value: true },
        { op: "set", entityId: "hero", field: "character.relationships", value: ["remote-bond"] },
        { op: "set", entityId: "remote-bond", field: "relationship.from", value: "hero" },
        { op: "set", entityId: "remote-bond", field: "relationship.to", value: "remote-friend" },
        { op: "set", entityId: "remote-bond", field: "relationship.active", value: true },
      ],
    });
    await new PlaySessionStore(root).write({ branchId: "main", actorId: "hero", lastCommitId: genesis });
    const offered: string[] = [];
    const ctx = {
      mode: "tui",
      sessionManager: {
        getEntries: () => [{
          type: "custom",
          customType: "nwh-narrator",
          data: {
            __piAssistantStream: 1,
            message: fauxAssistantMessage([fauxText("旧场景")]),
            details: {
              version: 1,
              branchId: "main",
              actorId: "hero",
              commitId: genesis,
              purpose: "turn",
              choices: [
                { action: "我不再只想着与老唐之间的关系，开始落实一个不会越过当前世界条件的接触计划。" },
                { action: "我沿着刚才确定的立场采取下一项实际行动，不让局势退回原点。" },
              ],
            },
          },
        }],
      },
      ui: {
        notify: () => undefined,
        async select(_title: string, choices: string[]) {
          offered.push(...choices);
          return undefined;
        },
        setTitle: () => undefined,
        setWorkingMessage: () => undefined,
        setWorkingIndicator: () => undefined,
        setHiddenThinkingLabel: () => undefined,
        setStatus: () => undefined,
        setHeader: () => undefined,
        setWidget: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionContext;

    await events.get("session_start")?.({ type: "session_start" }, ctx);
    await expect.poll(() => offered, { timeout: 1_000 }).toContain("自由输入行动或台词…");

    expect(narratorCalls).toBe(0);
    expect(offered).toEqual(["自由输入行动或台词…"]);
    expect(offered.join("\n")).not.toContain("接触计划");
    expect(offered.join("\n")).not.toContain("采取下一项实际行动");
  });

  it("automatically recovers a legacy transcript that ended on a raw engine rejection", async () => {
    const purposes: string[] = [];
    const recovery = "你重新把注意力放回眼前，风声和近处细小的动静都还停留在原来的位置。刚才没有任何未经确认的结果被写进世界，现场也没有因此消失。你仍然可以观察、整理已知之事，或者换一个更明确的即时行动，让这一刻从自己的选择继续。";
    const { events, root } = await fixture(
      undefined,
      undefined,
      undefined,
      async (_frame, purpose) => {
        purposes.push(purpose);
        return recovery;
      },
    );
    await new CanonicalModelStore(root).putEntity({ id: "hero", kind: "character", canonicalName: "福贵", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    await new PlaySessionStore(root).write({ branchId: "main", actorId: "hero", lastCommitId: genesis });
    const entries = [{
      type: "custom_message",
      customType: "nwh-play",
      content: "Action rejected at **engine**; committed world truth is unchanged.\n- PRECONDITION_FAILED",
      display: true,
    }];
    const ctx = {
      mode: "tui",
      isIdle: () => true,
      sessionManager: { getEntries: () => entries },
      ui: {
        notify: () => undefined,
        setTitle: () => undefined,
        setWorkingMessage: () => undefined,
        setWorkingIndicator: () => undefined,
        setHiddenThinkingLabel: () => undefined,
        setStatus: () => undefined,
        setHeader: () => undefined,
        setWidget: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionContext;

    await events.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    await expect.poll(() => purposes, { timeout: 1_000 }).toContain("recovery");
    expect(await engine.branches.readHead("main")).toBe(genesis);
  });

  it("renders native narrator text and thinking deltas and persists exactly the streamed final text", async () => {
    const narration = "雨声沿着屋檐一寸寸落下，你站在昏暗的门槛前。眼前能确认的痕迹都留在湿润光线里，远处的动静却还没有给出答案。檐角最后一滴水砸进石缝，门内随即传来衣料擦过木板的窸窣声。";
    const { commands, root, sentMessages } = await fixture(
      undefined,
      undefined,
      undefined,
      async (_frame, _purpose, observer) => {
        const start = fauxAssistantMessage([]);
        observer?.onAttempt?.(1);
        observer?.onEvent?.({ type: "message_start", message: start } as never);
        const thinking = fauxAssistantMessage([fauxThinking("先确认角色可见范围")]);
        observer?.onEvent?.({
          type: "message_update",
          message: thinking,
          assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "先确认角色可见范围", partial: thinking },
        } as never);
        observer?.onEvent?.({
          type: "message_update",
          message: thinking,
          assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "先确认角色可见范围", partial: thinking },
        } as never);
        const text = fauxAssistantMessage([fauxThinking("先确认角色可见范围"), fauxText(narration)]);
        observer?.onEvent?.({
          type: "message_update",
          message: text,
          assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: narration, partial: text },
        } as never);
        observer?.onEvent?.({ type: "message_end", message: text } as never);
        const followUp = fauxAssistantMessage([fauxThinking("工具返回后确认停止，不再重复正文")]);
        observer?.onEvent?.({ type: "message_start", message: fauxAssistantMessage([]) } as never);
        observer?.onEvent?.({
          type: "message_update",
          message: followUp,
          assistantMessageEvent: {
            type: "thinking_delta",
            contentIndex: 0,
            delta: "工具返回后确认停止，不再重复正文",
            partial: followUp,
          },
        } as never);
        observer?.onEvent?.({
          type: "message_update",
          message: followUp,
          assistantMessageEvent: {
            type: "thinking_end",
            contentIndex: 0,
            content: "工具返回后确认停止，不再重复正文",
            partial: followUp,
          },
        } as never);
        observer?.onEvent?.({ type: "message_end", message: followUp } as never);
        return narration;
      },
    );
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "福贵", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    const streams: RecordedTransientStream[] = [];
    const statuses: string[] = [];
    const widgetKeys: string[] = [];
    const ctx = {
      mode: "tui",
      ui: {
        notify: () => undefined,
        setStatus: (_key: string, status: string | undefined) => { if (status) statuses.push(status); },
        setWorkingMessage: () => undefined,
        openTransientAssistantStream: transientStreamRecorder(streams),
        setWidget: (key: string, content: string[] | undefined) => { if (content) widgetKeys.push(key); },
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionCommandContext;

    await commands.get("play")!.handler("hero main", ctx);

    expect(widgetKeys).not.toContain("nwh-player-scene-stream");
    expect(statuses.join("\n")).toContain("faux/faux-1");
    expect(streams).toHaveLength(1);
    expect(streams[0]?.events.map((event) => event.type)).toEqual([
      "thinking_delta",
      "thinking_end",
      "text_delta",
      "thinking_delta",
      "thinking_end",
    ]);
    expect(streams[0]?.updates.at(-1)?.content).toContainEqual(expect.objectContaining({ type: "text", text: narration }));
    expect(streams[0]?.completed?.content).toContainEqual(expect.objectContaining({
      type: "thinking",
      thinking: "工具返回后确认停止，不再重复正文",
    }));
    expect(streams[0]?.completed?.content).toContainEqual(expect.objectContaining({ type: "text", text: narration }));
    expect(streams[0]?.committed).toMatchObject({ customType: "nwh-narrator" });
    expect(streams[0]?.disposed).toBe(false);
    expect(sentMessages.some((message) => message.customType === "nwh-narrator")).toBe(false);
  });

  it("disposes a rejected scene stream before mounting the replacement attempt", async () => {
    const rejected = "首稿只是一段不足以成立的场景。";
    const accepted = "夜色压低了远处的轮廓，你仍站在原来的位置。近处能够确认的声音和光线都属于此刻，墙上的影子随着灯芯轻轻摇晃。门外传来一声鞋底碾过碎石的脆响，随后停在离门槛很近的地方。";
    const { commands, root, sentMessages } = await fixture(
      undefined,
      undefined,
      undefined,
      async (_frame, _purpose, observer) => {
        observer?.onAttempt?.(1);
        const first = fauxAssistantMessage([fauxText(rejected)]);
        observer?.onEvent?.({ type: "message_start", message: fauxAssistantMessage([]) } as never);
        observer?.onEvent?.({
          type: "message_update",
          message: first,
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: rejected },
        } as never);
        observer?.onEvent?.({ type: "message_end", message: first } as never);
        observer?.onAttempt?.(2);
        const second = fauxAssistantMessage([fauxText(accepted)]);
        observer?.onEvent?.({ type: "message_start", message: fauxAssistantMessage([]) } as never);
        observer?.onEvent?.({
          type: "message_update",
          message: second,
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: accepted },
        } as never);
        observer?.onEvent?.({ type: "message_end", message: second } as never);
        return accepted;
      },
    );
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "福贵", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    const streams: RecordedTransientStream[] = [];
    const ctx = {
      mode: "tui",
      ui: {
        notify: () => undefined,
        setStatus: () => undefined,
        setWorkingMessage: () => undefined,
        openTransientAssistantStream: transientStreamRecorder(streams),
        setWidget: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionCommandContext;

    await commands.get("play")!.handler("hero main", ctx);

    expect(streams).toHaveLength(2);
    expect(streams[0]).toMatchObject({ disposed: true });
    expect(streams[1]).toMatchObject({ disposed: false });
    expect(streams[1]?.completed?.content).toContainEqual(expect.objectContaining({ type: "text", text: accepted }));
    expect(streams[1]?.committed).toMatchObject({ customType: "nwh-narrator" });
    expect(sentMessages.some((message) => message.customType === "nwh-narrator")).toBe(false);
    expect(sentMessages).not.toContainEqual(expect.objectContaining({ customType: "nwh-narrator", content: rejected }));
  });

  it("rejects a settled narrator result that differs from the native text stream", async () => {
    const streamed = "雨停在门槛之外，你能听见檐角最后几滴水落下。屋里没有新的事实凭空出现，眼前仍只有已经看见的门和微暗的光。靠近门轴的位置泛着一线湿亮，木板另一侧忽然传来短促的呼吸声。";
    const settled = "这是一段与用户实际看到的流不相同、因此绝不能写入会话的替代文本。它即使看起来完整，也不能越过真实流与最终消息必须一致的校验边界。用户应当得到明确失败，而不是被悄悄替换输出。";
    const { commands, root, sentMessages } = await fixture(
      undefined,
      undefined,
      undefined,
      async (_frame, _purpose, observer) => {
        const message = fauxAssistantMessage([fauxText(streamed)]);
        observer?.onAttempt?.(1);
        observer?.onEvent?.({ type: "message_start", message: fauxAssistantMessage([]) } as never);
        observer?.onEvent?.({
          type: "message_update",
          message,
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: streamed, partial: message },
        } as never);
        observer?.onEvent?.({ type: "message_end", message } as never);
        return settled;
      },
    );
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "福贵", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    const notifications: string[] = [];
    const ctx = {
      mode: "tui",
      ui: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => undefined,
        setWidget: () => undefined,
        setWorkingMessage: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionCommandContext;

    await commands.get("play")!.handler("hero main", ctx);

    expect(sentMessages.some((message) => message.customType === "nwh-narrator")).toBe(false);
    expect(notifications).toContainEqual(expect.stringContaining("did not match the text shown in the live provider stream"));
  });

  it("keeps free-form input available beside grounded host choices and routes it through the normal player gate", async () => {
    const translated = deferred();
    const utterances: string[] = [];
    const narratorText = "冷风卷过空地，你听见脚边细碎的沙石声。近处的光影和记忆里已经知道的事情彼此交错，却没有带来新的答案。门边压着半片被雨浸透的叶子，叶脉上的水珠正沿着石阶一格一格滚落。";
    const { commands, root } = await fixture(
      undefined,
      async (input) => {
        utterances.push(input.utterance);
        translated.resolve();
        throw new Error("stop after observing selected utterance");
      },
      undefined,
      async () => narratorText,
    );
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "福贵", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    const questions: string[] = [];
    const ctx = {
      mode: "tui",
      ui: {
        notify: () => undefined,
        async select(title: string, choices: string[]) {
          questions.push(title);
          return choices.find((choice) => choice.includes("自由输入行动或台词"));
        },
        async input() {
          return "我靠近门边，仔细听外面的声音。";
        },
        setStatus: () => undefined,
        setWidget: () => undefined,
        setWorkingMessage: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionCommandContext;

    await commands.get("play")!.handler("hero main", ctx);
    await translated.promise;

    expect(questions).toContain("福贵，你接下来准备怎么做或怎么说？");
    expect(utterances).toEqual(["我靠近门边，仔细听外面的声音。"]);
  });

  it("opens a structured character question with a free-form alias path for /play", async () => {
    const { commands, root, sentVisibleMessages, getSessionName } = await fixture();
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

    expect(questions[0]).toBe("Who do you want to play on 'main'?");
    expect(questions).toContain("宿敌，你接下来准备怎么做或怎么说？");
    expect(inputs).toEqual(["Character id, name, or alias"]);
    await expect(new PlaySessionStore(root).read()).resolves.toMatchObject({ branchId: "main", actorId: "rival" });
    expect(getSessionName()).toBe("Novel world · 宿敌 · main");
    expect(sentVisibleMessages.join("\n")).not.toContain("Entered **宿敌**");
    expect(sentVisibleMessages.join("\n")).toContain("门外的风声忽远忽近");
  });

  it("asks which character to inhabit for /play even when only one is available", async () => {
    const { commands, root } = await fixture();
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "林岐", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    const questions: string[] = [];
    const ctx = {
      mode: "tui",
      ui: {
        notify: () => undefined,
        async select(title: string, choices: string[]) {
          questions.push(title);
          if (title.startsWith("Who do you want to play")) {
            return choices.find((choice) => choice.includes("林岐"));
          }
          return undefined;
        },
        setStatus: () => undefined,
        setWidget: () => undefined,
        setWorkingMessage: () => undefined,
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionCommandContext;

    await commands.get("play")?.handler("", ctx);

    expect(questions[0]).toBe("Who do you want to play on 'main'?");
    await expect(new PlaySessionStore(root).read()).resolves.toMatchObject({ branchId: "main", actorId: "hero" });
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
    }, undefined, second.source.id);
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

  it("routes an incompatible prepared revision through rollback-safe reparse before TUI preparation", async () => {
    let cache!: PreparedNovelCache;
    let source!: Awaited<ReturnType<typeof createEvidenceFixture>>["source"];
    let legacyHash = "";
    let reparseCalls = 0;
    const runReparse: NonNullable<NwhExtensionOptions["runReparse"]> = async (options) => {
      reparseCalls += 1;
      expect(options).toMatchObject({ sourceId: source.id, all: true });
      const current = await cache.publish(source);
      return {
        sourceId: source.id,
        chapters: [1],
        previousBundleHash: legacyHash,
        activeBundleHash: current.bundleHash!,
      };
    };
    const { commands, root, sentHiddenMessages } = await fixture(undefined, undefined, runReparse);
    const evidence = await createEvidenceFixture(root, "Hero waits in the Hall at the opening.\n", "legacy-novel.txt");
    source = evidence.source;
    const batches = await prepareCompilerBatches(root, source);
    await new CompilerBatchStore(root).replaceCompleted(source.id, batches.map((batch) => batch.id));
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: evidence.evidence("Hero") });
    await canon.putEntity({ id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: evidence.evidence("Hall") });
    await new InitialWorldStore(root).put({
      version: 1,
      readerSetup: "Hero is waiting in the Hall.",
      participantPresence: [{ entityId: "hero", mode: "physical" }],
      checkpoint: { mode: "chronological", rationale: "The source opens with Hero waiting in the Hall." },
      delta: {
        version: 1,
        operations: [
          { op: "set", entityId: "hero", field: "character.alive", value: true },
          { op: "set", entityId: "hero", field: "character.location", value: "hall" },
        ],
      },
      evidence: evidence.evidence("Hero waits in the Hall at the opening."),
    });
    const cacheRoot = path.join(root, "prepared-cache");
    cache = new PreparedNovelCache(root, cacheRoot);
    const current = await cache.publish(source);
    legacyHash = await activateLegacyPreparedRevision(cacheRoot, current, source);
    await expect(cache.lookup(source)).resolves.toMatchObject({ bundleHash: legacyHash, requiresReparse: true });
    const notifications: string[] = [];
    const questions: string[] = [];

    await commands.get("prepare-all")?.handler(source.id, preparationContext(notifications, questions));

    expect(reparseCalls).toBe(1);
    expect(questions).toEqual(["Upgrade prepared world semantics?", "Create playable branch?"]);
    expect(sentHiddenMessages).toEqual([]);
    expect(notifications).toContainEqual(expect.stringContaining("rollback-safe whole-novel reparse"));
    await expect(cache.lookup(source)).resolves.toMatchObject({ status: "already-cached" });
    expect((await cache.lookup(source)).requiresReparse).toBeUndefined();
    await expect(new BranchStore(root).read("main")).resolves.toMatchObject({ sourceId: source.id });
  });

  it("holds the workspace compiler lock across a multi-turn TUI preparation and releases it on shutdown", async () => {
    const { commands, events, root, sentHiddenMessages } = await fixture();
    const content = Array.from({ length: 8 }, (_, index) => `第${index + 1}章\n人物${index + 1}进入城池。\n`).join("\n");
    const evidence = await createEvidenceFixture(root, content, "locked-prepare.txt");
    const notifications: string[] = [];
    const ctx = preparationContext(notifications, []);

    await commands.get("prepare-all")?.handler(evidence.source.id, ctx);
    expect(sentHiddenMessages).toHaveLength(1);
    await expect(WorkspaceOperationLock.acquire(root, "compiler"))
      .rejects.toThrow("Another compiler operation is already active");

    await events.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
    const recovered = await WorkspaceOperationLock.acquire(root, "compiler");
    await recovered.release();
  });

  it("stops after one circuit-broken reconciliation instead of launching the same repair again", async () => {
    const { commands, events, root, sentHiddenMessages } = await fixture();
    const evidence = await createEvidenceFixture(root, "The Keeper watches. The Hall opens and closes as the weather changes.\n", "reconciliation-failure.txt");
    const batches = await prepareCompilerBatches(root, evidence.source);
    await new CompilerBatchStore(root).replaceCompleted(evidence.source.id, batches.map((batch) => batch.id));
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({
      id: "hall",
      kind: "location",
      canonicalName: "Hall",
      aliases: [],
      evidence: evidence.evidence("Hall"),
    });
    await canon.putEntity({
      id: "keeper",
      kind: "character",
      canonicalName: "Keeper",
      aliases: [],
      evidence: evidence.evidence("Keeper"),
    });
    await new InitialWorldStore(root).put({
      version: 1,
      readerSetup: "The Keeper watches the Hall as changing weather makes its access uncertain.",
      participantPresence: [{ entityId: "keeper", mode: "physical" }],
      checkpoint: { mode: "chronological", rationale: "The Keeper is already watching before the next weather shift." },
      delta: {
        version: 1,
        operations: [
          { op: "set", entityId: "keeper", field: "character.alive", value: true },
          { op: "set", entityId: "keeper", field: "character.location", value: "hall" },
        ],
      },
      evidence: evidence.evidence("The Keeper watches"),
    });
    for (let index = 1; index <= 20; index += 1) {
      await canon.putEvent({
        id: `weather-${String(index).padStart(2, "0")}`,
        title: `Weather shift ${index}`,
        ...(index === 20 ? {} : { readerSummary: `The weather causes shift ${index} at the Hall.` }),
        participants: ["hall"],
        storyTime: { kind: "ordinal", label: `weather shift ${index}`, orderHint: index },
        preconditions: [],
        observedOutcome: {
          version: 1,
          operations: [{ op: "set", entityId: "hall", field: "location.open", value: index % 2 === 0 }],
        },
        evidence: evidence.evidence("The Hall opens and closes as the weather changes."),
        causalParents: index === 1 ? [] : [`weather-${String(index - 1).padStart(2, "0")}`],
        confidence: 1,
      });
    }
    await new PossibilityTemplateStore(root).put({
      id: "continuing-weather",
      kind: "environmental",
      title: "The weather keeps changing access to the Hall",
      candidateWindow: { kind: "ordinal", label: "next weather shift", orderHint: 21 },
      preconditions: [],
      blockers: [],
      participants: ["hall"],
      causalParents: ["weather-20"],
      pressure: 1,
      relevance: 1,
      proposedDelta: {
        version: 1,
        operations: [{ op: "set", entityId: "hall", field: "location.open", value: false }],
      },
      evidence: evidence.evidence("The Hall opens and closes as the weather changes."),
    });
    const notifications: string[] = [];
    const questions: string[] = [];
    const ctx = preparationContext(notifications, questions);

    await commands.get("prepare-all")?.handler(evidence.source.id, ctx);
    expect(questions).toEqual(["Reconcile world semantics?"]);
    expect(sentHiddenMessages).toHaveLength(1);
    expect(sentHiddenMessages[0]).toContain("<world-semantic-reconciliation");

    await events.get("agent_end")?.({
      type: "agent_end",
      messages: [{
        role: "toolResult",
        toolCallId: "over-budget",
        toolName: "read_compiler_artifact",
        isError: true,
        content: [],
        details: {
          compilerBatchBlocked: true,
          reason: "compiler tool-call budget exceeded",
          finishFailureCount: 0,
          toolCallCount: 41,
        },
      }],
    }, ctx);
    await events.get("agent_settled")?.({ type: "agent_settled" }, ctx);

    expect(sentHiddenMessages).toHaveLength(1);
    expect(notifications).toContainEqual(expect.stringContaining("same deterministic repair pass will not be repeated automatically"));
    const recovered = await WorkspaceOperationLock.acquire(root, "compiler");
    await recovered.release();
  });

  it("uses an independent source-owned branch when main is pinned to another novel", async () => {
    const { commands, root } = await fixture();
    const first = await createEvidenceFixture(root, "First Hero waits.\n", "first-novel.txt");
    const second = await createEvidenceFixture(root, "Second Hero waits.\n", "second-novel.txt");
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({
      id: "first-hero",
      kind: "character",
      canonicalName: "First Hero",
      aliases: [],
      evidence: first.evidence("First Hero"),
    });
    const { engine } = await openWorkspaceWorld(root);
    await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "first-hero", field: "character.alive", value: true }],
    }, undefined, first.source.id);

    const batches = await prepareCompilerBatches(root, second.source);
    for (const batch of batches) await new CompilerBatchStore(root).markComplete(second.source.id, batch.id);
    const proposals = new CompilerProposalService(root);
    await proposals.submit("entity", {
      proposalId: "second-hero",
      payload: {
        id: "second-hero",
        kind: "character",
        canonicalName: "Second Hero",
        aliases: [],
        evidence: second.evidence("Second Hero"),
      },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("initial-world", {
      proposalId: "second-opening",
      payload: {
        version: 1,
        delta: {
          version: 1,
          operations: [{ op: "set", entityId: "second-hero", field: "character.alive", value: true }],
        },
        evidence: second.evidence("Second Hero waits."),
      },
      generatedBy: { worker: "test" },
    });
    const notifications: string[] = [];
    const questions: string[] = [];

    await commands.get("prepare-all")?.handler(second.source.id, preparationContext(notifications, questions));

    const expectedBranchId = `novel-${second.source.id.slice(0, 8)}`;
    expect(questions).toEqual(["Accept validated proposals?", "Create playable branch?"]);
    expect(notifications).toContainEqual(expect.stringContaining(`using independent branch '${expectedBranchId}'`));
    await expect(new BranchStore(root).read(expectedBranchId)).resolves.toMatchObject({
      id: expectedBranchId,
      sourceId: second.source.id,
    });
  });

  it("supplies opening evidence and requires a successful finish before completing /prepare-all", async () => {
    const { commands, events, registeredToolDefinitions, root, sentHiddenMessages } = await fixture();
    const evidence = await createEvidenceFixture(root, "Hero waits at the opening.\n", "opening-novel.txt");
    const batches = await prepareCompilerBatches(root, evidence.source);
    for (const batch of batches) await new CompilerBatchStore(root).markComplete(evidence.source.id, batch.id);
    await new CanonicalModelStore(root).putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: evidence.evidence("Hero"),
    });
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
      },
      evidence_segment_ids: [segmentId!],
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
    const segmentId = batches.find((batch) => batch.purpose === "source-review")!.segmentIds[0]!;
    await new CanonicalModelStore(root).putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: evidence.evidence("Hero"),
    });
    const notifications: string[] = [];
    const questions: string[] = [];
    const ctx = preparationContext(notifications, questions);
    await commands.get("prepare-all")?.handler(evidence.source.id, ctx);
    const proposalInput = {
      proposal_id: "partial-opening",
      payload: {
        version: 1,
        delta: { version: 1, operations: [] },
      },
      evidence_segment_ids: [segmentId],
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
    expect(notifications.some((message) => message.includes("restricted single-character opening fallback"))).toBe(true);
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
    expect(hiddenContext).toContain("evidence_segment_ids");
    expect(hiddenContext).not.toContain("quoteHash");
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
    expect(sentHiddenMessages[1]).toContain("evidence_segment_ids");
    expect(sentHiddenMessages[1]).not.toContain("quoteHash");
    expect(notifications.some((message) => message.includes("starting compiler batch 2/"))).toBe(true);
  });

  it("retries one provider-interrupted /prepare-all batch with recovery guidance, then stops with the concrete error", async () => {
    const { commands, events, root, sentHiddenMessages } = await fixture();
    const content = Array.from({ length: 8 }, (_, index) => `第${index + 1}章\n人物${index + 1}进入城池。\n`).join("\n");
    const evidence = await createEvidenceFixture(root, content, "provider-retry.txt");
    const notifications: string[] = [];
    const ctx = preparationContext(notifications, []);

    await commands.get("prepare-all")?.handler(evidence.source.id, ctx);
    expect(sentHiddenMessages).toHaveLength(1);

    const providerError = {
      role: "assistant",
      content: [{ type: "text", text: "request stopped" }],
      stopReason: "error",
      errorMessage: "Provider finish_reason: content_filter",
    };
    await events.get("agent_end")?.({ type: "agent_end", messages: [providerError] }, ctx);
    await events.get("agent_settled")?.({ type: "agent_settled" }, ctx);

    expect(sentHiddenMessages).toHaveLength(2);
    expect(sentHiddenMessages[1]).toContain("batch-recovery attempt 1/1");
    expect(sentHiddenMessages[1]).toContain("batch 1/");
    expect(notifications).toContainEqual(expect.stringContaining("retrying automatically 1/1"));

    await events.get("agent_end")?.({ type: "agent_end", messages: [providerError] }, ctx);
    await events.get("agent_settled")?.({ type: "agent_settled" }, ctx);

    expect(sentHiddenMessages).toHaveLength(2);
    expect(notifications).toContainEqual(expect.stringContaining("content_filter"));
    expect(notifications).toContainEqual(expect.stringContaining("Retry /prepare-all to resume"));
    const progress = await new CompilerBatchStore(root).read(evidence.source.id);
    expect(progress.completedBatchIds).toEqual([]);
  });

  it("retries one tool-budget-interrupted /prepare-all batch with its active drafts", async () => {
    const { commands, events, root, sentHiddenMessages } = await fixture();
    const content = Array.from({ length: 8 }, (_, index) => `第${index + 1}章\n人物${index + 1}进入城池。\n`).join("\n");
    const evidence = await createEvidenceFixture(root, content, "tool-budget-retry.txt");
    const notifications: string[] = [];
    const ctx = preparationContext(notifications, []);

    await commands.get("prepare-all")?.handler(evidence.source.id, ctx);
    expect(sentHiddenMessages).toHaveLength(1);

    const budgetFailure = [
      {
        role: "toolResult",
        toolCallId: "over-budget",
        toolName: "propose_entity",
        isError: true,
        content: [],
        details: {
          compilerBatchBlocked: true,
          reason: "compiler tool-call budget exceeded its 40-call limit",
          finishFailureCount: 1,
          toolCallCount: 41,
        },
      },
      { role: "assistant", content: [{ type: "text", text: "attempt stopped" }], stopReason: "stop" },
    ];
    await events.get("agent_end")?.({ type: "agent_end", messages: budgetFailure }, ctx);
    await events.get("agent_settled")?.({ type: "agent_settled" }, ctx);

    expect(sentHiddenMessages).toHaveLength(2);
    expect(sentHiddenMessages[1]).toContain("batch-recovery attempt 1/1");
    expect(notifications).toContainEqual(expect.stringContaining("retrying automatically 1/1"));

    await events.get("agent_end")?.({ type: "agent_end", messages: budgetFailure }, ctx);
    await events.get("agent_settled")?.({ type: "agent_settled" }, ctx);

    expect(sentHiddenMessages).toHaveLength(2);
    expect(notifications).toContainEqual(expect.stringContaining("tool-call budget exceeded"));
    expect(notifications).toContainEqual(expect.stringContaining("Retry /prepare-all to resume"));
    const progress = await new CompilerBatchStore(root).read(evidence.source.id);
    expect(progress.completedBatchIds).toEqual([]);
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
    const { commands, events, root, sentUserMessages, sentHiddenMessages, getActiveTools } = await fixture();
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
    expect(getActiveTools()).toEqual(["rename_session"]);
    expect(events.get("tool_call")?.({
      type: "tool_call",
      toolName: "propose_entity",
      toolCallId: "forged-outside-compiler",
      input: {},
    }, ctx)).toMatchObject({ block: true, reason: expect.stringContaining("outside an explicit compiler turn") });
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
