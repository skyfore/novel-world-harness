import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BeforeAgentStartEvent, BeforeAgentStartEventResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createNwhExtension, splitCommandArguments } from "../src/agent/nwh-extension.js";
import { LocalFileWorkspace } from "../src/workspace/local-files.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const root of temporaryDirectories.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(onSessionShutdown?: () => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-tui-extension-"));
  temporaryDirectories.push(root);
  await fs.mkdir(path.join(root, "chapters"));
  await fs.writeFile(path.join(root, "chapters", "chapter one.md"), "first line\nsecond line\n", "utf8");
  await fs.writeFile(path.join(root, ".env"), "SECRET=do-not-read\n", "utf8");
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void }>();
  const events = new Map<string, (...args: unknown[]) => unknown>();
  const registeredTools: string[] = [];
  const sentUserMessages: string[] = [];
  const pi = {
    registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void }) {
      commands.set(name, command);
    },
    on(name: string, handler: unknown) {
      events.set(name, handler as (...args: unknown[]) => unknown);
    },
    registerTool(tool: { name: string }) {
      registeredTools.push(tool.name);
    },
    sendUserMessage(message: string) {
      sentUserMessages.push(message);
    },
  } as unknown as ExtensionAPI;
  const workspace = await LocalFileWorkspace.create(root);
  await createNwhExtension({ workspace, saveSession: true, mode: "assistant", onSessionShutdown })(pi);
  return { commands, events, registeredTools, root, sentUserMessages };
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

describe("NWH TUI extension", () => {
  it("registers local commands and keeps their output in the transcript", async () => {
    const { commands } = await fixture();
    expect([...commands.keys()]).toEqual(["files", "search", "read", "compile-next", "status", "clear", "help", "exit"]);
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
      { ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionContext,
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
    const transformed = await input?.(
      { type: "input", text: `'${path.join(root, "chapters", "chapter one.md")}'`, source: "interactive" } as InputEvent,
      ctx,
    ) as InputEventResult | undefined;

    expect(transformed?.action).toBe("transform");
    expect(transformed && "text" in transformed ? transformed.text : "").toContain("Begin novel-world compiler batch");
    expect(registeredTools).toContain("propose_entity");
    expect(statuses).toContain("NWH · world compiler loop");
    expect(notifications[0]).toContain("Novel indexed");

    const beforeAgentStart = events.get("before_agent_start");
    const context = await beforeAgentStart?.({
      type: "before_agent_start",
      prompt: transformed && "text" in transformed ? transformed.text : "",
      systemPrompt: "system",
      systemPromptOptions: {},
    } as unknown as BeforeAgentStartEvent) as BeforeAgentStartEventResult | undefined;
    expect(context?.message?.customType).toBe("nwh-compiler-batch");
    expect(context?.message?.display).toBe(false);
    expect(context?.message?.content).toContain("<source-segment");
    expect(context?.message?.content).toContain("first line");
  });

  it("keeps standalone source-code paths as read-only attachments", async () => {
    const { events, registeredTools, root } = await fixture();
    const codePath = path.join(root, "compiler.ts");
    await fs.writeFile(codePath, "export const compiler = true;\n", "utf8");
    const input = events.get("input");
    const notifications: string[] = [];
    const result = await input?.(
      { type: "input", text: `@${codePath}`, source: "interactive" } as InputEvent,
      { ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionContext,
    ) as InputEventResult | undefined;

    expect(result).toEqual({ action: "continue" });
    expect(registeredTools).toEqual([]);
    expect(notifications).toEqual([]);
  });

  it("checkpoints a successful compiler batch before /compile-next advances", async () => {
    const { commands, events, root, sentUserMessages } = await fixture();
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
    await events.get("agent_end")?.(
      {
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "text", text: "batch complete" }], stopReason: "stop" }],
      },
      ctx,
    );
    await commands.get("compile-next")?.handler("", ctx);

    expect(notifications.some((message) => message.includes("checkpointed"))).toBe(true);
    expect(sentUserMessages).toHaveLength(1);
    expect(sentUserMessages[0]).toContain("batch 2/2");
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
