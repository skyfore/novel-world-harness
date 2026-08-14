import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { formatElapsed } from "../util/elapsed-status.js";

export type NwhTaskStatus = "running" | "completed" | "failed";

export type NwhTaskSnapshot = {
  id: string;
  title: string;
  status: NwhTaskStatus;
  activity: string;
  logs: readonly string[];
  startedAt: number;
  error?: string;
};

export class NwhTask {
  private readonly listeners = new Set<() => void>();
  private readonly logLines: string[] = [];
  private state: NwhTaskSnapshot;
  private completionPromise: Promise<void> = Promise.resolve();

  constructor(id: string, title: string, activity = "Starting") {
    this.state = { id, title, status: "running", activity, logs: this.logLines, startedAt: Date.now() };
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
    if (this.logLines.at(-1) !== message) this.logLines.push(message);
    if (this.logLines.length > 200) this.logLines.splice(0, this.logLines.length - 200);
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
  return `${snapshot.title} · ${snapshot.status} · ${snapshot.activity} · ${formatElapsed(now - snapshot.startedAt)}`;
}

export async function showNwhTask(ui: ExtensionUIContext, task: NwhTask): Promise<"background" | "settled"> {
  if (typeof ui.custom !== "function") {
    await task.completion;
    return "settled";
  }
  return ui.custom<"background" | "settled">((tui, theme, _keybindings, done) => {
    let closed = false;
    const close = (result: "background" | "settled") => {
      if (closed) return;
      closed = true;
      done(result);
    };
    const view = new NwhTaskView(
      tui,
      task,
      () => close("background"),
      {
        title: (text) => theme.fg("accent", theme.bold(text)),
        success: (text) => theme.fg("success", text),
        error: (text) => theme.fg("error", text),
        muted: (text) => theme.fg("dim", text),
      },
    );
    const unsubscribe = task.subscribe(() => {
      tui.requestRender();
      if (task.snapshot.status !== "running") close("settled");
    });
    view.onDispose = unsubscribe;
    if (task.snapshot.status !== "running") queueMicrotask(() => close("settled"));
    return view;
  });
}

class NwhTaskView implements Component {
  onDispose?: () => void;

  constructor(
    private readonly tui: TUI,
    private readonly task: NwhTask,
    private readonly background: () => void,
    private readonly style: {
      title: (text: string) => string;
      success: (text: string) => string;
      error: (text: string) => string;
      muted: (text: string) => string;
    },
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.left) || matchesKey(data, Key.escape)) {
      this.background();
      return;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const snapshot = this.task.snapshot;
    const state = snapshot.status === "completed"
      ? this.style.success("completed")
      : snapshot.status === "failed"
        ? this.style.error("failed")
        : this.style.muted("running");
    const lines = [
      this.style.title(`NWH task · ${snapshot.title}`),
      `${state} · ${snapshot.activity} · elapsed ${formatElapsed(Date.now() - snapshot.startedAt)}`,
      "",
      ...snapshot.logs.slice(-10).flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - 2)).map((part) => `  ${part}`)),
      "",
      this.style.muted("← or Esc: send to background · /tasks: bring to foreground · ↑/↓: prompt history in editor"),
    ];
    return lines.map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {}

  dispose(): void {
    this.onDispose?.();
  }
}
