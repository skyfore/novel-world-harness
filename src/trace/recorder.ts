import crypto from "node:crypto";
import {
  type TraceBlobRef,
  type TraceErrorSummary,
  type TraceEvent,
  type TraceEventType,
  type TraceRunManifest,
  type TraceRunStatus,
} from "./schema.js";
import { TraceStore, type AppendTraceEventInput, type CreateTraceRunInput } from "./store.js";

export type TraceContext = {
  recorder: TraceRecorder;
  spanId: string;
  parentSpanId?: string;
  label: string;
  kind: string;
};

export class TraceRecorder {
  private terminal = false;

  private constructor(
    readonly store: TraceStore,
    private manifestValue: TraceRunManifest,
  ) {}

  static async start(store: TraceStore, input: CreateTraceRunInput): Promise<TraceRecorder> {
    const manifest = await store.createRun(input);
    const recorder = new TraceRecorder(store, manifest);
    await recorder.record("run.started", {
      kind: manifest.kind,
      ...(manifest.playSessionId ? { playSessionId: manifest.playSessionId } : {}),
      ...(manifest.branchId ? { branchId: manifest.branchId } : {}),
    });
    return recorder;
  }

  get manifest(): TraceRunManifest {
    return structuredClone(this.manifestValue);
  }

  get rootContext(): TraceContext {
    return {
      recorder: this,
      spanId: this.manifestValue.rootSpanId,
      label: this.manifestValue.kind,
      kind: "run",
    };
  }

  async child(parent: TraceContext, label: string, kind: string): Promise<TraceContext> {
    this.assertOwnContext(parent);
    const context: TraceContext = {
      recorder: this,
      spanId: traceId("span"),
      parentSpanId: parent.spanId,
      label,
      kind,
    };
    await this.record("stage.started", { label, kind }, context);
    return context;
  }

  async finishStage(context: TraceContext, data: Record<string, unknown> = {}): Promise<TraceEvent> {
    return this.record("stage.finished", { label: context.label, kind: context.kind, ...data }, context);
  }

  async failStage(context: TraceContext, error: unknown): Promise<TraceEvent> {
    return this.record("stage.failed", {
      label: context.label,
      kind: context.kind,
      error: error instanceof Error ? error.message : String(error),
    }, context);
  }

  async record(
    type: TraceEventType,
    data: Record<string, unknown> = {},
    context: TraceContext = this.rootContext,
    links: Omit<AppendTraceEventInput, "type" | "spanId" | "parentSpanId" | "data"> = {},
  ): Promise<TraceEvent> {
    if (this.terminal) throw new Error(`Trace run '${this.manifestValue.id}' is terminal.`);
    this.assertOwnContext(context);
    const event = await this.store.appendEvent(this.manifestValue.id, {
      type,
      spanId: context.spanId,
      ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
      data,
      ...links,
    });
    this.manifestValue = await this.store.getRun(this.manifestValue.id);
    return event;
  }

  putBlob(content: unknown, mediaType = "application/json"): Promise<TraceBlobRef> {
    return this.store.putBlob(content, mediaType);
  }

  async link(patch: Parameters<TraceStore["updateRun"]>[1]): Promise<TraceRunManifest> {
    this.manifestValue = await this.store.updateRun(this.manifestValue.id, patch);
    return this.manifest;
  }

  async finish(
    status: Exclude<TraceRunStatus, "running">,
    patch: Parameters<TraceStore["finishRun"]>[2] = {},
    error?: TraceErrorSummary,
  ): Promise<TraceRunManifest> {
    if (this.terminal) return this.manifest;
    const eventType: TraceEventType = status === "succeeded"
      ? "run.succeeded"
      : status === "cancelled"
        ? "run.cancelled"
        : status === "interrupted"
          ? "run.interrupted"
          : "run.failed";
    await this.record(eventType, {
      status,
      ...(patch.finalHead ? { finalHead: patch.finalHead } : {}),
      ...(error ? { error } : {}),
    });
    this.manifestValue = await this.store.finishRun(this.manifestValue.id, status, {
      ...patch,
      ...(error ? { error } : {}),
    });
    this.terminal = true;
    return this.manifest;
  }

  private assertOwnContext(context: TraceContext): void {
    if (context.recorder !== this) throw new Error("Trace context belongs to another run.");
  }
}

export function newTraceId(prefix: "run" | "span" | "call" | "move"): string {
  return traceId(prefix);
}

function traceId(prefix: "run" | "span" | "call" | "move"): string {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID()}`;
}
