import {
  initTheme,
  type ExtensionUIContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { beforeAll, describe, expect, it } from "vitest";
import { NwhTask, showNwhTask, taskSummary } from "../src/agent/nwh-task.js";

beforeAll(() => initTheme("dark", false));

describe("NWH long-running tasks", () => {
  it("preserves Pi assistant and tool events as a structured transcript", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const task = new NwhTask("reparse-source", "Reparse Novel", "Starting");
    const states: string[] = [];
    task.subscribe(() => states.push(task.snapshot.activity));
    const message = fauxAssistantMessage([
      fauxThinking("private reasoning"),
      fauxText("Reviewing evidence\x1b[31m now."),
      fauxToolCall("propose_entity", { proposal_id: "liubei" }, { id: "tool-1" }),
    ], { stopReason: "toolUse" });

    task.start(async () => {
      task.update("Compiler batch 2/148");
      task.log("Checking evidence boundaries.");
      task.appendAgentEvent({ type: "message_start", message });
      task.appendAgentEvent({ type: "message_end", message });
      task.appendAgentEvent({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "propose_entity",
        args: { proposal_id: "liubei" },
      });
      task.appendAgentEvent({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "propose_entity",
        result: { content: [{ type: "text", text: "recorded" }], details: { recorded: true } },
        isError: false,
      });
      await gate;
    });

    expect(task.snapshot.status).toBe("running");
    expect(task.snapshot.logs).toEqual(["Checking evidence boundaries."]);
    expect(task.snapshot.transcript.map((entry) => entry.kind)).toEqual(["progress", "assistant", "tool"]);
    const assistant = task.snapshot.transcript.find((entry) => entry.kind === "assistant");
    expect(assistant?.kind === "assistant" && assistant.message.content).toContainEqual(
      expect.objectContaining({ type: "text", text: "Reviewing evidence␛[31m now." }),
    );
    const tool = task.snapshot.transcript.find((entry) => entry.kind === "tool");
    expect(tool).toMatchObject({
      kind: "tool",
      toolCallId: "tool-1",
      toolName: "propose_entity",
      args: { proposal_id: "liubei" },
      result: { content: [{ type: "text", text: "recorded" }], isError: false },
      isPartial: false,
    });
    release();
    await task.completion;
    expect(task.snapshot.status).toBe("completed");
    expect(states).toContain("Compiler batch 2/148");
    expect(taskSummary(task, task.snapshot.startedAt + 3_000)).toContain("completed");
    expect(task.snapshot.settledAt).toBeDefined();
  });

  it("does not duplicate elapsed time already supplied by a live compiler heartbeat", () => {
    const task = new NwhTask("reparse-source", "Reparse Novel");
    task.update("Compiler batch 2/148 · waiting · elapsed 48s");
    expect(taskSummary(task, task.snapshot.startedAt + 49_000)).toBe(
      "Reparse Novel · running · Compiler batch 2/148 · waiting · elapsed 48s",
    );
  });

  it("retains task errors for /tasks inspection", async () => {
    const task = new NwhTask("reparse-source", "Reparse Novel");
    task.start(async () => { throw new Error("provider unavailable"); });
    await task.completion;
    expect(task.snapshot).toMatchObject({ status: "failed", error: "provider unavailable" });
    expect(task.snapshot.logs.at(-1)).toBe("Error: provider unavailable");
    expect(task.snapshot.transcript.at(-1)).toMatchObject({ kind: "progress", message: "Error: provider unavailable" });
  });

  it("coalesces high-frequency assistant stream updates and flushes the final message", () => {
    const task = new NwhTask("stream", "Streaming task");
    const started = fauxAssistantMessage([fauxText("")], { stopReason: "pending" });
    task.appendAgentEvent({ type: "message_start", message: started });
    for (let index = 1; index <= 100; index += 1) {
      task.appendAgentEvent({
        type: "message_update",
        message: fauxAssistantMessage([fauxText(`token ${index}`)], { stopReason: "pending" }),
        assistantMessageEvent: { type: "text_delta", delta: String(index) },
      });
    }
    expect(task.snapshot.transcript).toHaveLength(1);
    expect(task.snapshot.transcript[0]?.revision).toBe(0);
    const completed = fauxAssistantMessage([fauxText("final model answer")], { stopReason: "stop" });
    task.appendAgentEvent({ type: "message_end", message: completed });
    expect(task.snapshot.transcript[0]).toMatchObject({
      kind: "assistant",
      streaming: false,
      message: { content: [{ type: "text", text: "final model answer" }] },
    });
  });

  it("exposes cancellation to the operation and settles as cancelled", async () => {
    const task = new NwhTask("cancel", "Cancelable task");
    task.start((signal) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }));
    expect(task.cancel()).toBe(true);
    expect(task.snapshot.status).toBe("cancelling");
    await task.completion;
    expect(task.snapshot.status).toBe("cancelled");
  });

  it("renders live model output and tools with Pi components, then backgrounds with left arrow", async () => {
    const task = new NwhTask("reparse-source", "Reparse Novel");
    task.start(() => new Promise<void>(() => {}));
    const message = fauxAssistantMessage([
      fauxThinking("checking chapter evidence"),
      fauxText("I am reviewing chapter evidence now."),
    ]);
    task.appendAgentEvent({ type: "message_start", message });
    task.appendAgentEvent({
      type: "tool_execution_start",
      toolCallId: "tool-live",
      toolName: "propose_entity",
      args: { proposal_id: "liubei" },
    });
    let rendered: string[] = [];
    const ui = taskUi((component, resolve) => {
      rendered = component.render(100);
      component.handleInput?.("\x1b[D");
      return resolve;
    });

    await expect(showNwhTask(ui, task, "/novel")).resolves.toBe("background");
    expect(task.snapshot.status).toBe("running");
    expect(rendered.join("\n")).not.toContain("Model output");
    expect(rendered.join("\n")).toContain("checking chapter evidence");
    expect(rendered.join("\n")).toContain("I am reviewing chapter evidence now.");
    expect(rendered.join("\n")).toContain("propose_entity");
  });

  it("shows thinking while streaming and collapses it after completion until Pi's thinking key expands it", async () => {
    const task = new NwhTask("reparse-source", "Reparse Novel");
    const streaming = fauxAssistantMessage([
      fauxThinking("inspect private evidence chain"),
      fauxText("Public answer."),
    ], { stopReason: "pending" });
    task.appendAgentEvent({ type: "message_start", message: streaming });
    expect(task.snapshot.transcript).toContainEqual(expect.objectContaining({ kind: "assistant", streaming: true }));
    const completed = { ...streaming, stopReason: "stop" as const };
    task.appendAgentEvent({ type: "message_end", message: completed });
    task.start(async () => undefined);
    await task.completion;

    let collapsed = "";
    let expanded = "";
    const ui = taskUi((component, resolve) => {
      collapsed = component.render(100).join("\n");
      component.handleInput?.("ctrl+t");
      expanded = component.render(100).join("\n");
      component.handleInput?.("\x1b[D");
      return resolve;
    });

    await expect(showNwhTask(ui, task, "/novel")).resolves.toBe("settled");
    expect(collapsed).toContain("Thinking complete");
    expect(collapsed).not.toContain("inspect private evidence chain");
    expect(expanded).toContain("inspect private evidence chain");
    expect(expanded).toContain("Public answer.");
  });

  it("collapses a thinking block on thinking_end while the assistant message is still streaming", async () => {
    const task = new NwhTask("stream", "Streaming task");
    task.start(() => new Promise<void>(() => {}));
    const message = fauxAssistantMessage([
      fauxThinking("reasoning that has just completed"),
      fauxText("The public answer is now streaming."),
    ], { stopReason: "pending" });
    task.appendAgentEvent({ type: "message_start", message });
    task.appendAgentEvent({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content: "reasoning that has just completed",
      },
    });

    expect(task.snapshot.transcript[0]).toMatchObject({
      kind: "assistant",
      streaming: true,
      completedThinkingBlocks: [0],
    });

    let collapsed = "";
    let expanded = "";
    const ui = taskUi((component) => {
      collapsed = component.render(100).join("\n");
      component.handleInput?.("ctrl+t");
      expanded = component.render(100).join("\n");
      component.handleInput?.("\x1b[D");
    });

    await expect(showNwhTask(ui, task, "/novel")).resolves.toBe("background");
    expect(collapsed).toContain("Thinking complete");
    expect(collapsed).not.toContain("reasoning that has just completed");
    expect(collapsed).toContain("The public answer is now streaming.");
    expect(expanded).toContain("reasoning that has just completed");
  });

  it("keeps live output at the end and lets the foreground overlay page through earlier task events", async () => {
    const task = new NwhTask("reparse-source", "Reparse Novel");
    task.start(() => new Promise<void>(() => {}));
    for (let index = 1; index <= 40; index += 1) task.log(`progress line ${index}`);
    let latest = "";
    let earlier = "";
    const ui = taskUi((component) => {
      latest = component.render(100).join("\n");
      component.handleInput?.("\x1b[5~");
      earlier = component.render(100).join("\n");
      component.handleInput?.("\x1b[D");
    });

    await expect(showNwhTask(ui, task, "/novel")).resolves.toBe("background");
    const latestLines = latest.split("\n").map((line) => line.trim());
    const earlierLines = earlier.split("\n").map((line) => line.trim());
    expect(latestLines).toContain("progress line 40");
    expect(latestLines).not.toContain("progress line 1");
    expect(earlierLines).toContain("progress line 1");
    expect(earlierLines).not.toContain("progress line 40");
  });
});

type TestTaskComponent = {
  render(width: number): string[];
  handleInput?(data: string): void;
};

function taskUi(
  inspect: (component: TestTaskComponent, resolve: (value: "background" | "settled") => void) => unknown,
): ExtensionUIContext {
  let toolsExpanded = false;
  return {
    custom: async (factory: (...args: unknown[]) => unknown) => new Promise<"background" | "settled">((resolve) => {
      const component = factory(
        { requestRender() {}, terminal: { rows: 30 } },
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        {
          matches: (data: string, action: string) =>
            (action === "app.tools.expand" && data === "ctrl+o")
            || (action === "app.thinking.toggle" && data === "ctrl+t")
            || (action === "app.clear" && data === "ctrl+c"),
        } as KeybindingsManager,
        resolve,
      ) as TestTaskComponent;
      inspect(component, resolve);
    }),
    getToolsExpanded: () => toolsExpanded,
    setToolsExpanded: (expanded: boolean) => { toolsExpanded = expanded; },
  } as unknown as ExtensionUIContext;
}
