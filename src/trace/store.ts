import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import {
  traceBlobRefSchema,
  traceErrorSummarySchema,
  traceEventSchema,
  traceIdentifierSchema,
  traceRunManifestSchema,
  traceRunKindSchema,
  traceRunStatusSchema,
  type TraceBlobRef,
  type TraceEvent,
  type TraceEventType,
  type TraceRunKind,
  type TraceRunManifest,
  type TraceRunStatus,
} from "./schema.js";
import { z } from "zod";

const runIndexEntrySchema = z.object({
  id: traceIdentifierSchema,
  relativePath: z.string().regex(/^runs\/\d{4}-\d{2}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/),
  startedAt: z.string().datetime({ offset: true }),
  kind: traceRunKindSchema,
  status: traceRunStatusSchema,
  playSessionId: z.string().optional(),
  branchId: z.string().optional(),
}).strict();
const runIndexSchema = z.object({ version: z.literal(1), runs: z.array(runIndexEntrySchema) }).strict();
const storedBlobSchema = z.object({
  version: z.literal(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  content: z.unknown(),
}).strict();

export type CreateTraceRunInput = {
  kind: TraceRunKind;
  sourceId?: string;
  branchId?: string;
  playSessionId?: string;
  playerMoveId?: string;
  actorId?: string;
  operationId?: string;
  previousHead?: string;
  storyTimeBefore?: unknown;
  startedAt?: string;
  id?: string;
  rootSpanId?: string;
};

export type AppendTraceEventInput = {
  type: TraceEventType;
  spanId: string;
  parentSpanId?: string;
  callId?: string;
  toolCallId?: string;
  storyTime?: unknown;
  data?: Record<string, unknown>;
  blobRef?: TraceBlobRef;
  observedAt?: string;
};

export type TraceRunFilter = {
  playSessionId?: string;
  branchId?: string;
  kind?: TraceRunKind;
  status?: TraceRunStatus;
  limit?: number;
};

export type TraceRunLinkPatch = Pick<
  TraceRunManifest,
  "operationId" | "finalHead" | "eventHash" | "auditId" | "presentationMessageIds" | "storyTimeAfter"
>;

export type FinishTraceRunPatch = Partial<TraceRunLinkPatch & Pick<TraceRunManifest, "endedAt" | "error">>;

export class TraceStore {
  readonly root: string;
  readonly runsRoot: string;
  readonly blobsRoot: string;
  readonly indexPath: string;
  private initialization?: Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string) {
    this.root = path.join(workspaceStateDir(workspaceRoot), "observability", "v1");
    this.runsRoot = path.join(this.root, "runs");
    this.blobsRoot = path.join(this.root, "blobs", "sha256");
    this.indexPath = path.join(this.root, "indexes", "runs.json");
  }

  initialize(): Promise<void> {
    this.initialization ??= this.exclusive(async () => {
      await fs.mkdir(path.dirname(this.indexPath), { recursive: true, mode: 0o700 });
      await fs.mkdir(this.runsRoot, { recursive: true, mode: 0o700 });
      const index = await this.loadOrRebuildIndex();
      let changed = false;
      for (const entry of index.runs) {
        let manifest = await this.readManifestAt(entry.relativePath);
        const events = await this.readEventsAt(entry.relativePath, manifest.id);
        const reconciled = replayEvents(manifest, events);
        let entryChanged = false;
        if (!sameJson(manifest, reconciled)) {
          manifest = reconciled;
          entryChanged = true;
        }

        if (manifest.status === "running") {
          const error = {
            code: "HOST_RESTART_INTERRUPTED_RUN",
            message: "The Web Host restarted before this run reached a terminal state. Do not replay a player move without reconciling its branch head and audit links.",
            retryable: false,
          } as const;
          const interruption = await this.appendEventAt(entry.relativePath, manifest, {
            type: "run.interrupted",
            spanId: manifest.rootSpanId,
            data: { status: "interrupted", error },
          });
          manifest = interruption.manifest;
          entryChanged = true;
        }

        if (entryChanged) {
          await this.writeManifestAt(entry.relativePath, manifest);
          changed = true;
        }
        const nextEntry = indexEntry(manifest, entry.relativePath);
        if (!sameJson(entry, nextEntry)) {
          Object.assign(entry, nextEntry);
          changed = true;
        }
      }
      if (changed || !(await exists(this.indexPath))) await this.atomicWrite(this.indexPath, index);
    });
    return this.initialization;
  }

  async createRun(input: CreateTraceRunInput): Promise<TraceRunManifest> {
    await this.initialize();
    return this.exclusive(async () => {
      const startedAt = input.startedAt ?? new Date().toISOString();
      const id = input.id ?? traceId("run");
      const rootSpanId = input.rootSpanId ?? traceId("span");
      const manifest = traceRunManifestSchema.parse({
        version: 1,
        id,
        kind: input.kind,
        status: "running",
        ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        ...(input.branchId ? { branchId: input.branchId } : {}),
        ...(input.playSessionId ? { playSessionId: input.playSessionId } : {}),
        ...(input.playerMoveId ? { playerMoveId: input.playerMoveId } : {}),
        ...(input.actorId ? { actorId: input.actorId } : {}),
        ...(input.operationId ? { operationId: input.operationId } : {}),
        startedAt,
        ...(input.previousHead ? { previousHead: input.previousHead } : {}),
        ...(input.storyTimeBefore !== undefined ? { storyTimeBefore: structuredClone(input.storyTimeBefore) } : {}),
        presentationMessageIds: [],
        rootSpanId,
        lastSeq: 0,
        counts: { llmRequests: 0, toolCalls: 0, retries: 0 },
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
      });
      const relativePath = this.relativeRunPath(manifest);
      if (await exists(path.join(this.root, relativePath))) throw new Error(`Trace run '${id}' already exists.`);
      await fs.mkdir(path.join(this.root, relativePath), { recursive: true, mode: 0o700 });
      await this.writeManifestAt(relativePath, manifest);
      await fs.writeFile(path.join(this.root, relativePath, "events.jsonl"), "", { encoding: "utf8", mode: 0o600 });
      const index = await this.readIndex();
      index.runs.push(indexEntry(manifest, relativePath));
      await this.atomicWrite(this.indexPath, index);
      return structuredClone(manifest);
    });
  }

  async appendEvent(runId: string, input: AppendTraceEventInput): Promise<TraceEvent> {
    await this.initialize();
    return this.exclusive(async () => {
      const { manifest, relativePath } = await this.requireRun(runId);
      if (manifest.status !== "running") throw new Error(`Trace run '${runId}' is already ${manifest.status}; no new events may be appended.`);
      const appended = await this.appendEventAt(relativePath, manifest, input);
      await this.writeManifestAt(relativePath, appended.manifest);
      await this.updateIndexEntry(appended.manifest, relativePath);
      return structuredClone(appended.event);
    });
  }

  async updateRun(runId: string, patch: Partial<TraceRunLinkPatch>): Promise<TraceRunManifest> {
    await this.initialize();
    return this.exclusive(async () => {
      const { manifest, relativePath } = await this.requireRun(runId);
      const updated = traceRunManifestSchema.parse({ ...manifest, ...structuredClone(patch) });
      await this.writeManifestAt(relativePath, updated);
      await this.updateIndexEntry(updated, relativePath);
      return structuredClone(updated);
    });
  }

  async finishRun(
    runId: string,
    status: Exclude<TraceRunStatus, "running">,
    patch: FinishTraceRunPatch = {},
  ): Promise<TraceRunManifest> {
    await this.initialize();
    return this.exclusive(async () => {
      const found = await this.requireRun(runId);
      let { manifest } = found;
      const { relativePath } = found;
      if (manifest.status !== "running" && manifest.status !== status) {
        throw new Error(`Trace run '${runId}' is already ${manifest.status}; it cannot finish as ${status}.`);
      }
      if (manifest.status === "running") {
        const events = await this.readEventsAt(relativePath, runId);
        const terminal = events.at(-1);
        const terminalStatus = terminal ? terminalStatusForEvent(terminal.type) : undefined;
        if (terminalStatus && terminalStatus !== status) {
          throw new Error(`Trace run '${runId}' already records terminal event '${terminal?.type}'.`);
        }
        if (!terminalStatus) {
          const appended = await this.appendEventAt(relativePath, manifest, {
            type: eventTypeForStatus(status),
            spanId: manifest.rootSpanId,
            data: {
              status,
              ...(patch.finalHead ? { finalHead: patch.finalHead } : {}),
              ...(patch.error ? { error: patch.error } : {}),
            },
            ...(patch.endedAt ? { observedAt: patch.endedAt } : {}),
          });
          manifest = appended.manifest;
        }
      }
      const updated = traceRunManifestSchema.parse({
        ...manifest,
        ...structuredClone(patch),
        status,
        endedAt: patch.endedAt ?? manifest.endedAt ?? new Date().toISOString(),
      });
      await this.writeManifestAt(relativePath, updated);
      await this.updateIndexEntry(updated, relativePath);
      return structuredClone(updated);
    });
  }

  async getRun(runId: string): Promise<TraceRunManifest> {
    await this.initialize();
    return structuredClone((await this.requireRun(runId)).manifest);
  }

  async listRuns(filter: TraceRunFilter = {}): Promise<TraceRunManifest[]> {
    await this.initialize();
    const limit = filter.limit ?? 200;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Trace run limit must be an integer between 1 and 1000.");
    const index = await this.readIndex();
    const selected = index.runs
      .filter((entry) => !filter.playSessionId || entry.playSessionId === filter.playSessionId)
      .filter((entry) => !filter.branchId || entry.branchId === filter.branchId)
      .filter((entry) => !filter.kind || entry.kind === filter.kind)
      .filter((entry) => !filter.status || entry.status === filter.status)
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt) || right.id.localeCompare(left.id))
      .slice(0, limit);
    return Promise.all(selected.map(async (entry) => structuredClone(await this.readManifestAt(entry.relativePath))));
  }

  async readEvents(runId: string, afterSeq = 0): Promise<TraceEvent[]> {
    await this.initialize();
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new Error("Trace event cursor must be a non-negative integer.");
    const { relativePath } = await this.requireRun(runId);
    return (await this.readEventsAt(relativePath, runId)).filter((event) => event.seq > afterSeq);
  }

  async putBlob(content: unknown, mediaType = "application/json"): Promise<TraceBlobRef> {
    await this.initialize();
    const serialized = mediaType === "application/json" ? stableJson(content) : String(content);
    const bytes = Buffer.from(serialized, "utf8");
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const reference = traceBlobRefSchema.parse({ sha256, byteLength: bytes.length, mediaType });
    const filePath = this.blobPath(sha256);
    await this.exclusive(async () => {
      if (await exists(filePath)) return;
      await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await this.atomicWrite(filePath, storedBlobSchema.parse({
        version: 1,
        ...reference,
        content: mediaType === "application/json" ? JSON.parse(serialized) : serialized,
      }));
    });
    return reference;
  }

  async getBlob(reference: TraceBlobRef): Promise<unknown> {
    await this.initialize();
    const parsedRef = traceBlobRefSchema.parse(reference);
    const blob = storedBlobSchema.parse(JSON.parse(await fs.readFile(this.blobPath(parsedRef.sha256), "utf8")));
    if (blob.sha256 !== parsedRef.sha256 || blob.byteLength !== parsedRef.byteLength || blob.mediaType !== parsedRef.mediaType) {
      throw new Error(`Trace blob metadata does not match reference '${parsedRef.sha256}'.`);
    }
    const serialized = blob.mediaType === "application/json" ? stableJson(blob.content) : String(blob.content);
    const actualHash = crypto.createHash("sha256").update(serialized).digest("hex");
    if (actualHash !== blob.sha256 || Buffer.byteLength(serialized) !== blob.byteLength) {
      throw new Error(`Trace blob '${blob.sha256}' failed content verification.`);
    }
    return structuredClone(blob.content);
  }

  private async requireRun(runId: string): Promise<{ manifest: TraceRunManifest; relativePath: string }> {
    traceIdentifierSchema.parse(runId);
    const entry = (await this.readIndex()).runs.find((candidate) => candidate.id === runId);
    if (!entry) throw new Error(`Unknown trace run '${runId}'. Use /api/v1/runs and copy an exact id.`);
    return { manifest: await this.readManifestAt(entry.relativePath), relativePath: entry.relativePath };
  }

  private async loadOrRebuildIndex(): Promise<z.infer<typeof runIndexSchema>> {
    try {
      return runIndexSchema.parse(JSON.parse(await fs.readFile(this.indexPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && error instanceof SyntaxError === false && error instanceof z.ZodError === false) throw error;
      const rebuilt = await this.rebuildIndex();
      await this.atomicWrite(this.indexPath, rebuilt);
      return rebuilt;
    }
  }

  private async rebuildIndex(): Promise<z.infer<typeof runIndexSchema>> {
    const entries: z.infer<typeof runIndexEntrySchema>[] = [];
    for (const month of await directoryNames(this.runsRoot)) {
      const monthRoot = path.join(this.runsRoot, month);
      for (const runId of await directoryNames(monthRoot)) {
        const relativePath = path.join("runs", month, runId);
        const manifest = await this.readManifestAt(relativePath);
        entries.push(indexEntry(manifest, relativePath));
      }
    }
    return runIndexSchema.parse({ version: 1, runs: entries });
  }

  private readIndex(): Promise<z.infer<typeof runIndexSchema>> {
    return fs.readFile(this.indexPath, "utf8").then((content) => runIndexSchema.parse(JSON.parse(content)));
  }

  private async updateIndexEntry(manifest: TraceRunManifest, relativePath: string): Promise<void> {
    const index = await this.readIndex();
    const entry = indexEntry(manifest, relativePath);
    const position = index.runs.findIndex((candidate) => candidate.id === manifest.id);
    if (position >= 0) index.runs[position] = entry;
    else index.runs.push(entry);
    await this.atomicWrite(this.indexPath, index);
  }

  private relativeRunPath(manifest: TraceRunManifest): string {
    return path.join("runs", manifest.startedAt.slice(0, 7), manifest.id);
  }

  private readManifestAt(relativePath: string): Promise<TraceRunManifest> {
    return fs.readFile(path.join(this.root, relativePath, "manifest.json"), "utf8")
      .then((content) => traceRunManifestSchema.parse(JSON.parse(content)));
  }

  private writeManifestAt(relativePath: string, manifest: TraceRunManifest): Promise<void> {
    return this.atomicWrite(path.join(this.root, relativePath, "manifest.json"), manifest);
  }

  private async readEventsAt(relativePath: string, runId: string): Promise<TraceEvent[]> {
    const content = await fs.readFile(path.join(this.root, relativePath, "events.jsonl"), "utf8");
    const events = content.split("\n").filter(Boolean).map((line) => traceEventSchema.parse(JSON.parse(line)));
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      if (event.runId !== runId) throw new Error(`Trace run '${runId}' contains an event for '${event.runId}'.`);
      if (event.seq !== index + 1) throw new Error(`Trace run '${runId}' has a non-contiguous event sequence at ${event.seq}; expected ${index + 1}.`);
      if (index < events.length - 1 && terminalStatusForEvent(event.type)) {
        throw new Error(`Trace run '${runId}' contains events after terminal event ${event.seq}.`);
      }
    }
    return events;
  }

  private async appendEventAt(
    relativePath: string,
    manifest: TraceRunManifest,
    input: AppendTraceEventInput,
  ): Promise<{ event: TraceEvent; manifest: TraceRunManifest }> {
    const event = traceEventSchema.parse({
      version: 1,
      runId: manifest.id,
      seq: manifest.lastSeq + 1,
      observedAt: input.observedAt ?? new Date().toISOString(),
      type: input.type,
      spanId: input.spanId,
      ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
      ...(input.callId ? { callId: input.callId } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(input.storyTime !== undefined ? { storyTime: structuredClone(input.storyTime) } : {}),
      ...(input.data ? { data: structuredClone(input.data) } : {}),
      ...(input.blobRef ? { blobRef: input.blobRef } : {}),
    });
    await fs.appendFile(path.join(this.root, relativePath, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
    return { event, manifest: applyEventToManifest(manifest, event) };
  }

  private blobPath(sha256: string): string {
    return path.join(this.blobsRoot, sha256.slice(0, 2), `${sha256}.json`);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async atomicWrite(filePath: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, filePath);
  }
}

function applyEventToManifest(manifest: TraceRunManifest, event: TraceEvent): TraceRunManifest {
  const counts = { ...manifest.counts };
  const usage = { ...manifest.usage };
  if (event.type === "llm.request.started") counts.llmRequests += 1;
  if (event.type === "tool.call.started") counts.toolCalls += 1;
  if (event.type === "llm.retry") counts.retries += 1;
  if ((event.type === "llm.response.completed" || event.type === "llm.response.failed") && event.data?.usage) {
    const candidate = traceUsageSchemaLike(event.data.usage);
    if (candidate) {
      usage.input += candidate.input;
      usage.output += candidate.output;
      usage.cacheRead += candidate.cacheRead;
      usage.cacheWrite += candidate.cacheWrite;
      usage.totalTokens += candidate.totalTokens;
      usage.cost += candidate.cost;
      if (candidate.reasoning !== undefined) usage.reasoning = (usage.reasoning ?? 0) + candidate.reasoning;
    }
  }
  const terminalStatus = terminalStatusForEvent(event.type);
  const finalHead = typeof event.data?.finalHead === "string" ? event.data.finalHead : undefined;
  const error = event.data?.error ? traceErrorSummarySchema.safeParse(event.data.error) : undefined;
  return traceRunManifestSchema.parse({
    ...manifest,
    lastSeq: event.seq,
    counts,
    usage,
    ...(terminalStatus ? { status: terminalStatus, endedAt: event.observedAt } : {}),
    ...(finalHead ? { finalHead } : {}),
    ...(error?.success ? { error: error.data } : {}),
  });
}

function replayEvents(manifest: TraceRunManifest, events: TraceEvent[]): TraceRunManifest {
  let replayed = traceRunManifestSchema.parse({
    ...manifest,
    status: "running",
    endedAt: undefined,
    error: undefined,
    lastSeq: 0,
    counts: { llmRequests: 0, toolCalls: 0, retries: 0 },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  });
  for (const event of events) replayed = applyEventToManifest(replayed, event);
  return replayed;
}

function terminalStatusForEvent(type: TraceEventType): Exclude<TraceRunStatus, "running"> | undefined {
  if (type === "run.succeeded") return "succeeded";
  if (type === "run.failed") return "failed";
  if (type === "run.cancelled") return "cancelled";
  if (type === "run.interrupted") return "interrupted";
  return undefined;
}

function eventTypeForStatus(status: Exclude<TraceRunStatus, "running">): TraceEventType {
  return `run.${status}`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function traceUsageSchemaLike(value: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number; reasoning?: number } | undefined {
  const parsed = z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(),
    cacheWrite: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative(),
    reasoning: z.number().int().nonnegative().optional(),
  }).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function indexEntry(manifest: TraceRunManifest, relativePath: string): z.infer<typeof runIndexEntrySchema> {
  return runIndexEntrySchema.parse({
    id: manifest.id,
    relativePath,
    startedAt: manifest.startedAt,
    kind: manifest.kind,
    status: manifest.status,
    ...(manifest.playSessionId ? { playSessionId: manifest.playSessionId } : {}),
    ...(manifest.branchId ? { branchId: manifest.branchId } : {}),
  });
}

function traceId(prefix: "run" | "span" | "call" | "move"): string {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function directoryNames(root: string): Promise<string[]> {
  try {
    return (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
