import { contextSnapshotSchema, traceIdentifierSchema, traceUsageSchema, type TraceEvent, type TraceRunManifest } from "../trace/schema.js";
import {
  traceCallDetailSchema,
  traceEventPayloadSchema,
  traceRunDetailViewSchema,
  type TraceCallDetail,
  type TraceContextSnapshotView,
  type TraceEventPayload,
  type TraceResponseView,
  type TraceRunDetailView,
  type TraceToolCallView,
} from "../trace/projection.js";
import { TraceStore, type TraceRunFilter } from "../trace/store.js";
import { webError } from "../web/errors.js";

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
};

export type TraceRunSearchFilter = TraceRunFilter & {
  modelId?: string;
  stage?: string;
  startedAfter?: string;
  startedBefore?: string;
};

export class TraceApplicationService {
  constructor(readonly store: TraceStore) {}

  async listRuns(filter: TraceRunSearchFilter = {}): Promise<TraceRunManifest[]> {
    const { modelId, stage, startedAfter, startedBefore, limit = 200, ...storeFilter } = filter;
    const requestedLimit = traceRunLimitSchema.parse(limit);
    const afterTime = startedAfter ? parseFilterTime(startedAfter, "startedAfter") : undefined;
    const beforeTime = startedBefore ? parseFilterTime(startedBefore, "startedBefore") : undefined;
    if (!modelId && !stage && !startedAfter && !startedBefore) {
      return this.store.listRuns({ ...storeFilter, limit: requestedLimit });
    }
    const candidates = await this.store.listRuns({ ...storeFilter, limit: 1_000 });
    const selected: TraceRunManifest[] = [];
    for (const manifest of candidates) {
      const startedTime = Date.parse(manifest.startedAt);
      if (afterTime !== undefined && startedTime < afterTime) continue;
      if (beforeTime !== undefined && startedTime >= beforeTime) continue;
      if (modelId || stage) {
        const events = await this.store.readEvents(manifest.id);
        if (modelId && !events.some((event) =>
          stringData(event, "modelId") === modelId
          || stringData(event, "responseModelId") === modelId)) continue;
        if (stage && !events.some((event) =>
          stringData(event, "kind") === stage
          || stringData(event, "label") === stage
          || stringData(event, "invocationName") === stage)) continue;
      }
      selected.push(manifest);
      if (selected.length === requestedLimit) break;
    }
    return selected;
  }

  async getRun(runIdValue: string): Promise<TraceRunDetailView> {
    const runId = traceIdentifierSchema.parse(runIdValue);
    try {
      const [manifest, events] = await Promise.all([
        this.store.getRun(runId),
        this.store.readEvents(runId),
      ]);
      return traceRunDetailViewSchema.parse({
        version: 1,
        manifest,
        events,
        callIds: [...new Set(events.flatMap((event) => event.callId ? [event.callId] : []))],
      });
    } catch (error) {
      if (isUnknownRun(error)) throw runNotFound(runId);
      throw error;
    }
  }

  async getEvents(runIdValue: string, afterSeq = 0): Promise<TraceEvent[]> {
    const runId = traceIdentifierSchema.parse(runIdValue);
    try {
      return await this.store.readEvents(runId, afterSeq);
    } catch (error) {
      if (isUnknownRun(error)) throw runNotFound(runId);
      throw error;
    }
  }

  async getEventPayload(runIdValue: string, seq: number): Promise<TraceEventPayload> {
    const eventSeq = traceEventSequenceSchema.parse(seq);
    const run = await this.getRun(runIdValue);
    const event = run.events.find((candidate) => candidate.seq === eventSeq);
    if (!event) {
      throw webError(404, "TRACE_EVENT_NOT_FOUND", `Trace run '${run.manifest.id}' has no event at sequence ${eventSeq}.`, {
        kind: "after-refresh",
        discoveryEndpoint: `/api/v1/runs/${encodeURIComponent(run.manifest.id)}/events`,
        copyField: "[].seq",
        maxAttempts: 1,
      });
    }
    if (!event.blobRef) {
      throw webError(404, "TRACE_EVENT_PAYLOAD_NOT_FOUND", `Trace event ${eventSeq} has no content-addressed payload.`, {
        kind: "none",
      });
    }
    return traceEventPayloadSchema.parse({
      version: 1,
      runId: run.manifest.id,
      seq: eventSeq,
      event,
      content: await this.store.getBlob(event.blobRef),
    });
  }

  async getCall(callIdValue: string, runIdValue?: string): Promise<TraceCallDetail> {
    const callId = traceIdentifierSchema.parse(callIdValue);
    let run: TraceRunDetailView | undefined;
    if (runIdValue) {
      run = await this.getRun(runIdValue);
      if (!run.events.some((event) => event.callId === callId)) run = undefined;
    } else {
      for (const candidate of await this.store.listRuns({ limit: 1_000 })) {
        const events = await this.store.readEvents(candidate.id);
        if (events.some((event) => event.callId === callId)) {
          run = traceRunDetailViewSchema.parse({
            version: 1,
            manifest: candidate,
            events,
            callIds: [...new Set(events.flatMap((event) => event.callId ? [event.callId] : []))],
          });
          break;
        }
      }
    }
    if (!run) {
      const discoveryEndpoint = runIdValue
        ? `/api/v1/runs/${encodeURIComponent(runIdValue)}`
        : "/api/v1/runs?limit=1000";
      throw webError(404, "TRACE_CALL_NOT_FOUND", `Unknown trace call '${callId}'${runIdValue ? ` in run '${runIdValue}'` : ""}.`, {
        kind: "after-refresh",
        discoveryEndpoint,
        copyField: "callIds[]",
        maxAttempts: 1,
      });
    }
    return this.projectCall(run.manifest.id, callId, run.events.filter((event) => event.callId === callId));
  }

  private async projectCall(runId: string, callId: string, events: TraceEvent[]): Promise<TraceCallDetail> {
    const contexts: TraceContextSnapshotView[] = [];
    for (const event of events) {
      if ((event.type !== "context.assembled" && event.type !== "context.finalized") || !event.blobRef) continue;
      const parsed = contextSnapshotSchema.safeParse(await this.store.getBlob(event.blobRef));
      if (!parsed.success || parsed.data.callId !== callId) continue;
      const snapshot = parsed.data;
      const requestAttempt = numberData(event, "requestAttempt");
      contexts.push({
        eventSeq: event.seq,
        ...(requestAttempt !== undefined ? { requestAttempt } : {}),
        snapshot,
        parts: await Promise.all(snapshot.parts.map(async (part) => ({
          ...part,
          ...(part.contentRef ? { content: await this.store.getBlob(part.contentRef) } : {}),
        }))),
        availableTools: await Promise.all(snapshot.tools.map(async (tool) => ({
          ...tool,
          parameters: await this.store.getBlob(tool.parametersRef),
        }))),
        ...(snapshot.logicalMessagesRef ? { logicalMessages: await this.store.getBlob(snapshot.logicalMessagesRef) } : {}),
        ...(snapshot.providerPayloadRef ? { providerPayload: await this.store.getBlob(snapshot.providerPayloadRef) } : {}),
      });
    }

    const responses: TraceResponseView[] = [];
    for (const event of events) {
      const status = responseStatus(event);
      if (!status) continue;
      responses.push({
        seq: event.seq,
        status,
        observedAt: event.observedAt,
        data: structuredClone(event.data ?? {}),
        ...(event.blobRef ? { content: await this.store.getBlob(event.blobRef) } : {}),
      });
    }

    const tools = await this.projectTools(events);
    const usage = { ...EMPTY_USAGE } as ReturnType<typeof traceUsageSchema.parse>;
    for (const event of events) {
      if (event.type !== "llm.response.completed" && event.type !== "llm.response.failed") continue;
      const parsed = traceUsageSchema.safeParse(event.data?.usage);
      if (!parsed.success) continue;
      usage.input += parsed.data.input;
      usage.output += parsed.data.output;
      usage.cacheRead += parsed.data.cacheRead;
      usage.cacheWrite += parsed.data.cacheWrite;
      usage.totalTokens += parsed.data.totalTokens;
      usage.cost += parsed.data.cost;
      if (parsed.data.reasoning !== undefined) usage.reasoning = (usage.reasoning ?? 0) + parsed.data.reasoning;
    }
    const started = events.find((event) => event.type === "llm.request.started")?.observedAt;
    const firstResponse = events.find((event) =>
      event.type === "llm.response.started"
      || event.type === "llm.response.delta"
      || event.type === "llm.response.completed"
      || event.type === "llm.response.failed")?.observedAt;
    const ended = [...events].reverse().find((event) =>
      event.type === "llm.response.completed" || event.type === "llm.response.failed")?.observedAt;
    const latestContext = contexts.at(-1);
    return traceCallDetailSchema.parse({
      version: 1,
      runId,
      callId,
      ...(latestContext?.snapshot.invocationName ? { invocationName: latestContext.snapshot.invocationName } : {}),
      ...(started ? { startedAt: started } : {}),
      ...(firstResponse ? { firstResponseAt: firstResponse } : {}),
      ...(ended ? { endedAt: ended } : {}),
      ...(started && firstResponse ? { timeToFirstResponseMs: elapsedMs(started, firstResponse) } : {}),
      ...(started && ended ? { durationMs: elapsedMs(started, ended) } : {}),
      counts: {
        requests: events.filter((event) => event.type === "llm.request.started").length,
        retries: events.filter((event) => event.type === "llm.retry").length,
        tools: tools.length,
      },
      usage,
      contexts,
      responses,
      tools,
      events,
    });
  }

  private async projectTools(events: TraceEvent[]): Promise<TraceToolCallView[]> {
    const tools = new Map<string, TraceToolCallView>();
    for (const event of events) {
      if (!event.toolCallId || !event.type.startsWith("tool.call.")) continue;
      const previous = tools.get(event.toolCallId);
      const name = stringData(event, "toolName") ?? previous?.name ?? "unknown-tool";
      const content = event.blobRef ? await this.store.getBlob(event.blobRef) : undefined;
      if (event.type === "tool.call.started") {
        tools.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          name,
          status: "running",
          startedSeq: event.seq,
          ...(content !== undefined ? { input: content } : {}),
          progress: [],
        });
      } else if (event.type === "tool.call.progress") {
        const current = previous ?? { toolCallId: event.toolCallId, name, status: "running" as const, progress: [] };
        tools.set(event.toolCallId, {
          ...current,
          progress: [...current.progress, ...(content !== undefined ? [content] : [])],
        });
      } else {
        const current = previous ?? { toolCallId: event.toolCallId, name, status: "running" as const, progress: [] };
        tools.set(event.toolCallId, {
          ...current,
          status: event.type === "tool.call.failed" ? "failed" : "completed",
          endedSeq: event.seq,
          ...(content !== undefined ? { result: content } : {}),
        });
      }
    }
    return [...tools.values()].sort((left, right) =>
      (left.startedSeq ?? Number.MAX_SAFE_INTEGER) - (right.startedSeq ?? Number.MAX_SAFE_INTEGER)
      || left.toolCallId.localeCompare(right.toolCallId));
  }
}

// Event sequence zero is reserved for a cursor; payload lookup always targets an event.
const traceEventSequenceSchema = traceUsageSchema.shape.input.positive();
const traceRunLimitSchema = traceUsageSchema.shape.input.positive().max(1_000);

function parseFilterTime(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Trace run ${label} must be an ISO 8601 timestamp.`);
  return parsed;
}

function elapsedMs(startedAt: string, endedAt: string): number {
  return Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
}

function responseStatus(event: TraceEvent): TraceResponseView["status"] | undefined {
  if (event.type === "llm.response.started") return "started";
  if (event.type === "llm.response.completed") return "completed";
  if (event.type === "llm.response.failed") return "failed";
  if (event.type === "llm.response.delta") return "delta";
  return undefined;
}

function stringData(event: TraceEvent, key: string): string | undefined {
  const value = event.data?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberData(event: TraceEvent, key: string): number | undefined {
  const value = event.data?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isUnknownRun(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Unknown trace run '");
}

function runNotFound(runId: string) {
  return webError(404, "TRACE_RUN_NOT_FOUND", `Unknown trace run '${runId}'.`, {
    kind: "after-refresh",
    discoveryEndpoint: "/api/v1/runs",
    copyField: "[].id",
    maxAttempts: 1,
  });
}
