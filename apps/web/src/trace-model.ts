import type { TraceContextSnapshotView, ExpandedContextPart } from "../../../src/trace/projection";
import type { TraceEvent } from "../../../src/trace/schema";

export type TraceLedgerCategory = "run" | "stage" | "context" | "llm" | "tool" | "world" | "presentation";

export type TraceLedgerRow = {
  key: string;
  event: TraceEvent;
  depth: number;
  category: TraceLedgerCategory;
  label: string;
  detail?: string;
  terminal: boolean;
};

export type ContextPartDiff = {
  id: string;
  label: string;
  status: "added" | "removed" | "changed" | "unchanged";
  left?: ExpandedContextPart;
  right?: ExpandedContextPart;
  changes: string[];
};

export function buildTraceLedger(events: TraceEvent[], rootSpanId: string): TraceLedgerRow[] {
  const parents = new Map<string, string>();
  for (const event of events) {
    if (event.parentSpanId && !parents.has(event.spanId)) parents.set(event.spanId, event.parentSpanId);
  }
  const depths = new Map<string, number>([[rootSpanId, 0]]);
  const callOrder = new Map<string, number>();
  for (const event of events) {
    if (event.callId && !callOrder.has(event.callId)) callOrder.set(event.callId, callOrder.size + 1);
  }
  return events.map((event) => {
    const description = describeTraceEvent(event, callOrder.get(event.callId ?? ""));
    return {
      key: `${event.seq}:${event.type}`,
      event,
      depth: spanDepth(event.spanId, rootSpanId, parents, depths, new Set()),
      ...description,
    };
  });
}

export function diffContextParts(
  leftSnapshot?: TraceContextSnapshotView,
  rightSnapshot?: TraceContextSnapshotView,
): ContextPartDiff[] {
  const left = new Map((leftSnapshot?.parts ?? []).map((part) => [part.id, part]));
  const right = new Map((rightSnapshot?.parts ?? []).map((part) => [part.id, part]));
  const leftOrder = new Map((leftSnapshot?.parts ?? []).map((part, index) => [part.id, index]));
  const rightOrder = new Map((rightSnapshot?.parts ?? []).map((part, index) => [part.id, index]));
  const ids = [...new Set([...left.keys(), ...right.keys()])].sort((a, b) => {
    const leftIndex = leftOrder.get(a) ?? -1;
    const rightIndex = rightOrder.get(a) ?? -1;
    const aIndex = leftIndex >= 0 ? leftIndex : 10_000 + rightIndex;
    const bLeftIndex = leftOrder.get(b) ?? -1;
    const bRightIndex = rightOrder.get(b) ?? -1;
    const bIndex = bLeftIndex >= 0 ? bLeftIndex : 10_000 + bRightIndex;
    return aIndex - bIndex || a.localeCompare(b);
  });
  return ids.map((id) => {
    const before = left.get(id);
    const after = right.get(id);
    if (!before) return { id, label: after!.label, status: "added" as const, right: after, changes: ["part added"] };
    if (!after) return { id, label: before.label, status: "removed" as const, left: before, changes: ["part removed"] };
    const changes = changedPartFields(before, after);
    return {
      id,
      label: after.label,
      status: changes.length > 0 ? "changed" as const : "unchanged" as const,
      left: before,
      right: after,
      changes,
    };
  });
}

export function latestContext(contexts: TraceContextSnapshotView[]): TraceContextSnapshotView | undefined {
  return contexts.at(-1);
}

export function playerVisibleText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.narration === "string") return record.narration;
  if (Array.isArray(record.content)) {
    const text = record.content.flatMap((part) => {
      if (typeof part === "string") return [part];
      if (!part || typeof part !== "object") return [];
      const candidate = part as Record<string, unknown>;
      return typeof candidate.text === "string" ? [candidate.text] : [];
    }).join("");
    if (text) return text;
  }
  return undefined;
}

export function isWorldEffectEvent(event: TraceEvent): boolean {
  return event.type === "validation.completed"
    || event.type.startsWith("world.commit.")
    || event.type === "presentation.message.appended";
}

function spanDepth(
  spanId: string,
  rootSpanId: string,
  parents: Map<string, string>,
  depths: Map<string, number>,
  visiting: Set<string>,
): number {
  const cached = depths.get(spanId);
  if (cached !== undefined) return cached;
  if (visiting.has(spanId)) return 0;
  visiting.add(spanId);
  const parent = parents.get(spanId);
  const depth = parent
    ? Math.min(8, spanDepth(parent, rootSpanId, parents, depths, visiting) + 1)
    : spanId === rootSpanId ? 0 : 1;
  visiting.delete(spanId);
  depths.set(spanId, depth);
  return depth;
}

function describeTraceEvent(event: TraceEvent, callOrdinal?: number): Omit<TraceLedgerRow, "key" | "event" | "depth"> {
  const data = event.data ?? {};
  const call = callOrdinal ? `Request #${callOrdinal}` : undefined;
  if (event.type.startsWith("run.")) return {
    category: "run",
    label: event.type === "run.started" ? "Run started" : `Run ${event.type.slice(4)}`,
    detail: stringValue(data.kind) ?? stringValue(data.status),
    terminal: event.type !== "run.started",
  };
  if (event.type.startsWith("stage.")) return {
    category: "stage",
    label: stringValue(data.label) ?? "Stage",
    detail: `${stringValue(data.kind) ?? "host stage"} · ${event.type.slice(6)}`,
    terminal: event.type !== "stage.started",
  };
  if (event.type.startsWith("context.")) return {
    category: "context",
    label: `${call ?? "Context"} · ${event.type === "context.finalized" ? "final context" : "context assembled"}`,
    detail: stringValue(data.invocationName),
    terminal: event.type === "context.finalized",
  };
  if (event.type.startsWith("llm.")) return {
    category: "llm",
    label: `${call ?? "LLM request"} · ${event.type.replace("llm.", "").replaceAll(".", " ")}`,
    detail: stringValue(data.modelId) ?? stringValue(data.stopReason),
    terminal: event.type === "llm.response.completed" || event.type === "llm.response.failed",
  };
  if (event.type.startsWith("tool.call.")) return {
    category: "tool",
    label: `Tool · ${stringValue(data.toolName) ?? event.toolCallId ?? "unknown"}`,
    detail: event.type.slice("tool.call.".length),
    terminal: event.type === "tool.call.completed" || event.type === "tool.call.failed",
  };
  if (event.type.startsWith("world.commit.")) return {
    category: "world",
    label: `World commit · ${event.type.slice("world.commit.".length)}`,
    detail: stringValue(data.finalHead) ?? stringValue(data.previousHead),
    terminal: event.type !== "world.commit.started",
  };
  if (event.type === "validation.completed") return {
    category: "world",
    label: "Deterministic validation",
    detail: booleanValue(data.accepted),
    terminal: true,
  };
  return {
    category: "presentation",
    label: "Presentation message persisted",
    detail: stringValue(data.messageId),
    terminal: true,
  };
}

function changedPartFields(left: ExpandedContextPart, right: ExpandedContextPart): string[] {
  const changes: string[] = [];
  if (left.contentRef?.sha256 !== right.contentRef?.sha256) changes.push("content hash");
  if (left.disposition !== right.disposition) changes.push("disposition");
  if (left.kind !== right.kind) changes.push("kind");
  if (left.authority !== right.authority) changes.push("authority");
  if (left.role !== right.role) changes.push("role");
  if (JSON.stringify(left.logicalMessageIndexes) !== JSON.stringify(right.logicalMessageIndexes)) changes.push("message indexes");
  if (left.charCount !== right.charCount) changes.push("character count");
  return changes;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function booleanValue(value: unknown): string | undefined {
  return typeof value === "boolean" ? (value ? "accepted" : "rejected") : undefined;
}
