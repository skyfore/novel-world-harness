import {
  AssistantMessageComponent,
  getMarkdownTheme,
  keyHint,
  ToolExecutionComponent,
  type AgentSessionEvent,
  type ExtensionUIContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  Container,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { formatElapsed } from "../util/elapsed-status.js";

export type NwhTaskStatus = "running" | "completed" | "failed";

type NwhTaskTranscriptBase = {
  id: number;
  revision: number;
};

export type NwhTaskTranscriptEntry = NwhTaskTranscriptBase & (
  | { kind: "progress"; message: string }
  | { kind: "assistant"; message: AssistantMessage; streaming: boolean }
  | {
    kind: "tool";
    toolCallId: string;
    toolName: string;
    args: unknown;
    result?: {
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      details?: unknown;
      isError: boolean;
    };
    isPartial: boolean;
  }
);

type NewNwhTaskTranscriptEntry = NwhTaskTranscriptEntry extends infer Entry
  ? Entry extends NwhTaskTranscriptEntry
    ? Omit<Entry, "id" | "revision">
    : never
  : never;

export type NwhTaskSnapshot = {
  id: string;
  title: string;
  status: NwhTaskStatus;
  activity: string;
  logs: readonly string[];
  transcript: readonly NwhTaskTranscriptEntry[];
  startedAt: number;
  error?: string;
};

export class NwhTask {
  private static readonly MAX_TRANSCRIPT_ENTRIES = 2_000;
  private readonly listeners = new Set<() => void>();
  private readonly logLines: string[] = [];
  private readonly transcriptEntries: NwhTaskTranscriptEntry[] = [];
  private state: NwhTaskSnapshot;
  private completionPromise: Promise<void> = Promise.resolve();
  private nextTranscriptId = 1;

  constructor(id: string, title: string, activity = "Starting") {
    this.state = {
      id,
      title,
      status: "running",
      activity,
      logs: this.logLines,
      transcript: this.transcriptEntries,
      startedAt: Date.now(),
    };
  }

  get snapshot(): NwhTaskSnapshot {
    return this.state;
  }

  get completion(): Promise<void> {
    return this.completionPromise;
  }

  start(operation: () => Promise<void>): void {
    this.completionPromise = operation().then(
      () => this.settle("completed", "Complete"),
      (error) => this.settle("failed", "Stopped", error instanceof Error ? error.message : String(error)),
    );
  }

  update(activity: string): void {
    if (this.state.status !== "running") return;
    this.state = { ...this.state, activity };
    this.emit();
  }

  log(message: string): void {
    if (this.logLines.at(-1) === message) return;
    this.logLines.push(message);
    if (this.logLines.length > 200) this.logLines.splice(0, this.logLines.length - 200);
    this.appendTranscript({ kind: "progress", message: sanitizeText(message) });
  }

  appendAgentEvent(event: AgentSessionEvent): void {
    if (this.state.status !== "running") return;
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.appendTranscript({ kind: "assistant", message: sanitizeAssistantMessage(event.message), streaming: true });
      return;
    }
    if (event.type === "message_update" && event.message.role === "assistant") {
      const entry = this.findStreamingAssistant();
      const message = sanitizeAssistantMessage(event.message);
      if (entry) this.replaceTranscript(entry, { ...entry, revision: entry.revision + 1, message });
      else this.appendTranscript({ kind: "assistant", message, streaming: true });
      return;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const entry = this.findStreamingAssistant();
      const message = sanitizeAssistantMessage(event.message);
      if (entry) this.replaceTranscript(entry, { ...entry, revision: entry.revision + 1, message, streaming: false });
      else this.appendTranscript({ kind: "assistant", message, streaming: false });
      return;
    }
    if (event.type === "tool_execution_start") {
      this.appendTranscript({
        kind: "tool",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: cloneValue(event.args),
        isPartial: true,
      });
      return;
    }
    if (event.type === "tool_execution_update") {
      this.updateTool(event.toolCallId, event.toolName, event.args, event.partialResult, false, true);
      return;
    }
    if (event.type === "tool_execution_end") {
      this.updateTool(event.toolCallId, event.toolName, undefined, event.result, event.isError, false);
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private updateTool(
    toolCallId: string,
    toolName: string,
    args: unknown,
    result: unknown,
    isError: boolean,
    isPartial: boolean,
  ): void {
    const entry = [...this.transcriptEntries].reverse().find(
      (candidate): candidate is Extract<NwhTaskTranscriptEntry, { kind: "tool" }> =>
        candidate.kind === "tool" && candidate.toolCallId === toolCallId,
    );
    const normalizedResult = normalizeToolResult(result, isError);
    if (entry) {
      this.replaceTranscript(entry, {
        ...entry,
        revision: entry.revision + 1,
        ...(args === undefined ? {} : { args: cloneValue(args) }),
        result: normalizedResult,
        isPartial,
      });
      return;
    }
    this.appendTranscript({
      kind: "tool",
      toolCallId,
      toolName,
      args: cloneValue(args ?? {}),
      result: normalizedResult,
      isPartial,
    });
  }

  private findStreamingAssistant(): Extract<NwhTaskTranscriptEntry, { kind: "assistant" }> | undefined {
    return [...this.transcriptEntries].reverse().find(
      (entry): entry is Extract<NwhTaskTranscriptEntry, { kind: "assistant" }> =>
        entry.kind === "assistant" && entry.streaming,
    );
  }

  private appendTranscript(entry: NewNwhTaskTranscriptEntry): void {
    this.transcriptEntries.push({ ...entry, id: this.nextTranscriptId++, revision: 0 } as NwhTaskTranscriptEntry);
    if (this.transcriptEntries.length > NwhTask.MAX_TRANSCRIPT_ENTRIES) {
      this.transcriptEntries.splice(0, this.transcriptEntries.length - NwhTask.MAX_TRANSCRIPT_ENTRIES);
    }
    this.state = { ...this.state, transcript: [...this.transcriptEntries] };
    this.emit();
  }

  private replaceTranscript(previous: NwhTaskTranscriptEntry, next: NwhTaskTranscriptEntry): void {
    const index = this.transcriptEntries.indexOf(previous);
    if (index < 0) return;
    this.transcriptEntries[index] = next;
    this.state = { ...this.state, transcript: [...this.transcriptEntries] };
    this.emit();
  }

  private settle(status: Exclude<NwhTaskStatus, "running">, activity: string, error?: string): void {
    this.state = { ...this.state, status, activity, ...(error ? { error } : {}) };
    if (error) this.log(`Error: ${error}`);
    else this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export function taskSummary(task: NwhTask, now = Date.now()): string {
  const snapshot = task.snapshot;
  const elapsed = snapshot.activity.includes("· elapsed ") ? "" : ` · elapsed ${formatElapsed(now - snapshot.startedAt)}`;
  return `${snapshot.title} · ${snapshot.status} · ${snapshot.activity}${elapsed}`;
}

export async function showNwhTask(ui: ExtensionUIContext, task: NwhTask, cwd = process.cwd()): Promise<"background" | "settled"> {
  if (typeof ui.custom !== "function") {
    await task.completion;
    return "settled";
  }
  return ui.custom<"background" | "settled">((tui, theme, keybindings, done) => {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      done(task.snapshot.status === "running" ? "background" : "settled");
    };
    const view = new NwhTaskView(
      tui,
      theme,
      keybindings,
      task,
      cwd,
      close,
      typeof ui.getToolsExpanded === "function" ? ui.getToolsExpanded() : false,
      (expanded) => ui.setToolsExpanded?.(expanded),
    );
    const unsubscribe = task.subscribe(() => tui.requestRender());
    view.onDispose = unsubscribe;
    return view;
  }, {
    overlay: true,
    overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center", margin: 1 },
  });
}

type RenderedTranscriptEntry = {
  revision: number;
  component: Component;
};

class NwhTaskView implements Component {
  onDispose?: () => void;
  private readonly titleText: Text;
  private readonly statusText: Text;
  private readonly footerText: Text;
  private readonly transcriptContainer = new Container();
  private readonly renderedEntries = new Map<number, RenderedTranscriptEntry>();
  private readonly renderedOrder: number[] = [];
  private toolsExpanded: boolean;
  private thinkingExpanded = false;
  private scrollOffset = 0;
  private viewportHeight = 3;
  private contentHeight = 0;
  private followingEnd = true;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly task: NwhTask,
    private readonly cwd: string,
    private readonly dismiss: () => void,
    toolsExpanded: boolean,
    private readonly setToolsExpanded: (expanded: boolean) => void,
  ) {
    this.toolsExpanded = toolsExpanded;
    this.titleText = new Text("", 1, 0);
    this.statusText = new Text("", 1, 0);
    this.footerText = new Text(
      theme.fg("dim", `←/Esc background · PgUp/PgDn scroll · ${keyHint("app.tools.expand", "tools")} · ${keyHint("app.thinking.toggle", "thinking")}`),
      1,
      0,
    );
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.left) || matchesKey(data, Key.escape)) {
      this.dismiss();
      return;
    }
    if (this.keybindings.matches(data, "app.tools.expand")) {
      this.toolsExpanded = !this.toolsExpanded;
      this.setToolsExpanded(this.toolsExpanded);
      this.refreshVisibility();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollBy(-Math.max(1, this.viewportHeight - 2));
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollBy(Math.max(1, this.viewportHeight - 2));
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollBy(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollBy(1);
      return;
    }
    if (this.keybindings.matches(data, "app.thinking.toggle")) {
      this.thinkingExpanded = !this.thinkingExpanded;
      this.refreshVisibility();
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    this.refreshHeader();
    this.syncTranscript();
    const safeWidth = Math.max(1, width);
    const transcriptLines = this.transcriptContainer.render(safeWidth);
    this.contentHeight = transcriptLines.length;
    this.viewportHeight = Math.max(3, this.tui.terminal.rows - 7);
    const maxOffset = Math.max(0, this.contentHeight - this.viewportHeight);
    if (this.followingEnd) this.scrollOffset = maxOffset;
    else this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
    const end = Math.min(this.contentHeight, this.scrollOffset + this.viewportHeight);
    const position = this.contentHeight > this.viewportHeight
      ? this.theme.fg("dim", ` ${this.scrollOffset + 1}-${end}/${this.contentHeight}`)
      : "";
    const footer = this.footerText.render(safeWidth).map((line, index) =>
      index === 0 ? truncateToWidth(`${line}${position}`, safeWidth) : line);
    return [
      ...this.titleText.render(safeWidth),
      ...this.statusText.render(safeWidth),
      "",
      ...transcriptLines.slice(this.scrollOffset, end),
      "",
      ...footer,
    ];
  }

  invalidate(): void {
    this.titleText.invalidate();
    this.statusText.invalidate();
    this.footerText.invalidate();
    this.transcriptContainer.invalidate();
    this.refreshHeader();
    this.syncTranscript();
  }

  dispose(): void {
    this.onDispose?.();
  }

  private scrollBy(lines: number): void {
    const maxOffset = Math.max(0, this.contentHeight - this.viewportHeight);
    this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset + lines));
    this.followingEnd = this.scrollOffset === maxOffset;
    this.tui.requestRender();
  }

  private refreshHeader(): void {
    const snapshot = this.task.snapshot;
    const state = snapshot.status === "completed"
      ? this.theme.fg("success", "completed")
      : snapshot.status === "failed"
        ? this.theme.fg("error", "failed")
        : this.theme.fg("dim", "running");
    const activityElapsed = snapshot.activity.includes("· elapsed ")
      ? ""
      : ` · elapsed ${formatElapsed(Date.now() - snapshot.startedAt)}`;
    this.titleText.setText(this.theme.fg("accent", this.theme.bold(`NWH task · ${snapshot.title}`)));
    this.statusText.setText(`${state} · ${snapshot.activity}${activityElapsed}`);
  }

  private syncTranscript(): void {
    const entries = this.task.snapshot.transcript;
    const ids = entries.map((entry) => entry.id);
    const prefixMatches = this.renderedOrder.every((id, index) => ids[index] === id);
    if (!prefixMatches || ids.length < this.renderedOrder.length) {
      this.transcriptContainer.clear();
      this.renderedEntries.clear();
      this.renderedOrder.splice(0);
    }
    for (const entry of entries) {
      const rendered = this.renderedEntries.get(entry.id);
      if (!rendered) {
        const component = this.createTranscriptComponent(entry);
        this.renderedEntries.set(entry.id, { revision: entry.revision, component });
        this.renderedOrder.push(entry.id);
        this.transcriptContainer.addChild(component);
      } else if (rendered.revision !== entry.revision) {
        this.updateTranscriptComponent(rendered.component, entry);
        rendered.revision = entry.revision;
      }
    }
    if (!entries.length && !this.renderedEntries.has(0)) {
      const placeholder = new Text(this.theme.fg("dim", "Waiting for the model or compiler host…"), 1, 0);
      this.renderedEntries.set(0, { revision: 0, component: placeholder });
      this.transcriptContainer.addChild(placeholder);
    } else if (entries.length && this.renderedEntries.has(0)) {
      this.transcriptContainer.clear();
      this.renderedEntries.clear();
      this.renderedOrder.splice(0);
      this.syncTranscript();
    }
  }

  private createTranscriptComponent(entry: NwhTaskTranscriptEntry): Component {
    if (entry.kind === "progress") return new Text(this.theme.fg("dim", entry.message), 1, 0);
    if (entry.kind === "assistant") {
      const component = new AssistantMessageComponent(
        undefined,
        !entry.streaming && !this.thinkingExpanded,
        getMarkdownTheme(),
        "Thinking complete · Ctrl+T to expand",
      );
      component.updateContent(entry.message, entry.streaming);
      return component;
    }
    const component = new ToolExecutionComponent(entry.toolName, entry.toolCallId, entry.args, {}, undefined, this.tui, this.cwd);
    component.setArgsComplete();
    component.markExecutionStarted();
    component.setExpanded(this.toolsExpanded);
    if (entry.result) component.updateResult(entry.result, entry.isPartial);
    return component;
  }

  private updateTranscriptComponent(component: Component, entry: NwhTaskTranscriptEntry): void {
    if (entry.kind === "assistant" && component instanceof AssistantMessageComponent) {
      component.setHideThinkingBlock(!entry.streaming && !this.thinkingExpanded);
      component.updateContent(entry.message, entry.streaming);
    } else if (entry.kind === "tool" && component instanceof ToolExecutionComponent) {
      component.updateArgs(entry.args);
      component.setArgsComplete();
      component.markExecutionStarted();
      component.setExpanded(this.toolsExpanded);
      if (entry.result) component.updateResult(entry.result, entry.isPartial);
    }
  }

  private refreshVisibility(): void {
    for (const entry of this.task.snapshot.transcript) {
      const component = this.renderedEntries.get(entry.id)?.component;
      if (entry.kind === "assistant" && component instanceof AssistantMessageComponent) {
        component.setHideThinkingBlock(!entry.streaming && !this.thinkingExpanded);
      } else if (entry.kind === "tool" && component instanceof ToolExecutionComponent) {
        component.setExpanded(this.toolsExpanded);
      }
    }
  }
}

function sanitizeAssistantMessage(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map((content) => {
      if (content.type === "text") return { ...content, text: sanitizeText(content.text) };
      if (content.type === "thinking") return { ...content, thinking: sanitizeText(content.thinking) };
      return cloneValue(content);
    }),
  };
}

function sanitizeText(value: string): string {
  return value
    .replaceAll("\x1b", "␛")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function normalizeToolResult(
  value: unknown,
  isError: boolean,
): Extract<NwhTaskTranscriptEntry, { kind: "tool" }>["result"] {
  if (value && typeof value === "object" && Array.isArray((value as { content?: unknown }).content)) {
    const result = value as {
      content: Array<{ type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown }>;
      details?: unknown;
    };
    return {
      content: result.content.map((content) => ({
        type: typeof content.type === "string" ? content.type : "text",
        ...(typeof content.text === "string" ? { text: sanitizeText(content.text) } : {}),
        ...(typeof content.data === "string" ? { data: content.data } : {}),
        ...(typeof content.mimeType === "string" ? { mimeType: content.mimeType } : {}),
      })),
      ...(result.details === undefined ? {} : { details: cloneValue(result.details) }),
      isError,
    };
  }
  return {
    content: [{ type: "text", text: safeSerialize(value, 50_000) }],
    isError,
  };
}

function safeSerialize(value: unknown, maxCharacters: number): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    serialized = String(value);
  }
  const safe = sanitizeText(serialized);
  return safe.length > maxCharacters ? `${safe.slice(0, maxCharacters)}\n[tool payload truncated]` : safe;
}
