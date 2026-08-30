import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { redactTraceSecrets } from "../trace/redaction.js";
import {
  apiErrorSchema,
  operationAcceptedSchema,
  operationSnapshotSchema,
  type ApiError,
  type OperationAccepted,
  type OperationKind,
  type OperationSnapshot,
} from "./contracts.js";
import { WebEventBroker } from "./event-stream.js";
import { WebApplicationError, webError } from "./errors.js";

export interface OperationRunContext {
  readonly operationId: string;
  readonly runId?: string;
  readonly signal: AbortSignal;
  readonly commitBoundaryCrossed: boolean;
  update(phase: string, progress?: Record<string, unknown>): void;
  markCommitBoundary(progress?: Record<string, unknown>): void;
}

export interface StartOperationInput<T> {
  kind: OperationKind;
  scopeId: string;
  clientRequestId: string;
  request: unknown;
  runId?: string;
  run(context: OperationRunContext): Promise<T>;
}

type OperationRecord = {
  snapshot: OperationSnapshot;
  controller: AbortController;
  promise: Promise<OperationSnapshot>;
  resolve: (snapshot: OperationSnapshot) => void;
};

export interface OperationManagerOptions {
  maxOperations?: number;
  workspaceRoot?: string;
}

export class OperationManager {
  private readonly records = new Map<string, OperationRecord>();
  private readonly idempotency = new Map<string, string>();
  private readonly maxOperations: number;
  private readonly storageRoot?: string;
  private initialization?: Promise<void>;
  private initialized: boolean;

  constructor(
    readonly events: WebEventBroker,
    options: number | OperationManagerOptions = {},
  ) {
    const normalized = typeof options === "number" ? { maxOperations: options } : options;
    this.maxOperations = normalized.maxOperations ?? 1_000;
    this.storageRoot = normalized.workspaceRoot
      ? path.join(workspaceStateDir(normalized.workspaceRoot), "web", "v1", "operations")
      : undefined;
    this.initialized = !this.storageRoot;
    if (!Number.isInteger(this.maxOperations) || this.maxOperations < 10) {
      throw new Error("Operation retention must be an integer of at least 10.");
    }
  }

  initialize(): Promise<void> {
    this.initialization ??= this.loadPersistedOperations();
    return this.initialization;
  }

  start<T>(input: StartOperationInput<T>): OperationAccepted {
    this.assertInitialized();
    const requestFingerprint = stableFingerprint(input.request);
    const idempotencyKey = `${input.kind}:${input.scopeId}:${input.clientRequestId}`;
    const previousId = this.idempotency.get(idempotencyKey);
    if (previousId) {
      const previous = this.records.get(previousId);
      if (!previous) throw new Error(`Operation idempotency index points to missing operation '${previousId}'.`);
      if (previous.snapshot.requestFingerprint !== requestFingerprint) {
        throw webError(
          409,
          "IDEMPOTENCY_CONFLICT",
          `Client request '${input.clientRequestId}' was already used with different input.`,
          { kind: "none" },
        );
      }
      return operationAcceptedSchema.parse({ operation: previous.snapshot, reused: true });
    }

    this.evictCompleted();
    const now = new Date().toISOString();
    const id = `op-${crypto.randomUUID()}`;
    const controller = new AbortController();
    let resolve!: (snapshot: OperationSnapshot) => void;
    const promise = new Promise<OperationSnapshot>((done) => { resolve = done; });
    const record: OperationRecord = {
      controller,
      promise,
      resolve,
      snapshot: operationSnapshotSchema.parse({
        version: 1,
        id,
        kind: input.kind,
        scopeId: input.scopeId,
        clientRequestId: input.clientRequestId,
        requestFingerprint,
        ...(input.runId ? { runId: input.runId } : {}),
        status: "queued",
        cancellable: true,
        commitBoundaryCrossed: false,
        phase: "queued",
        createdAt: now,
        progress: {},
      }),
    };
    this.records.set(id, record);
    this.idempotency.set(idempotencyKey, id);
    try {
      this.publish(record);
    } catch (error) {
      this.records.delete(id);
      this.idempotency.delete(idempotencyKey);
      throw error;
    }
    queueMicrotask(() => { void this.execute(record, input.run); });
    return operationAcceptedSchema.parse({ operation: record.snapshot, reused: false });
  }

  get(operationId: string): OperationSnapshot {
    this.assertInitialized();
    const record = this.records.get(operationId);
    if (!record) {
      throw webError(404, "OPERATION_NOT_FOUND", `Unknown operation '${operationId}'.`, {
        kind: "after-refresh",
        discoveryEndpoint: "/api/v1/operations",
        copyField: "id",
        maxAttempts: 1,
      });
    }
    return structuredClone(record.snapshot);
  }

  list(): OperationSnapshot[] {
    this.assertInitialized();
    return [...this.records.values()]
      .map((record) => structuredClone(record.snapshot))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  }

  findByClientRequest(
    kind: OperationKind,
    scopeId: string,
    clientRequestId: string,
  ): OperationSnapshot | undefined {
    this.assertInitialized();
    const operationId = this.idempotency.get(`${kind}:${scopeId}:${clientRequestId}`);
    return operationId ? this.get(operationId) : undefined;
  }

  cancel(operationId: string): OperationSnapshot {
    this.assertInitialized();
    const record = this.records.get(operationId);
    if (!record) return this.get(operationId);
    if (isTerminal(record.snapshot.status)) return structuredClone(record.snapshot);
    if (!record.snapshot.cancellable) {
      throw webError(
        409,
        "OPERATION_NOT_CANCELLABLE",
        `Operation '${operationId}' crossed its commit boundary and cannot be cancelled or retried unchanged.`,
        { kind: "none" },
      );
    }
    record.snapshot = operationSnapshotSchema.parse({
      ...record.snapshot,
      phase: record.snapshot.commitBoundaryCrossed ? "stopping-after-commit" : "cancelling",
      progress: { ...record.snapshot.progress, cancellationRequestedAt: new Date().toISOString() },
    });
    record.controller.abort();
    this.publish(record);
    return structuredClone(record.snapshot);
  }

  async wait(operationId: string): Promise<OperationSnapshot> {
    this.assertInitialized();
    const record = this.records.get(operationId);
    if (!record) return this.get(operationId);
    return structuredClone(await record.promise);
  }

  /**
   * Web operations are process-bound. A graceful host close aborts active work
   * and records an explicit terminal state before the process exits. The
   * underlying task may still unwind asynchronously, but can no longer replace
   * the persisted interruption snapshot.
   */
  shutdown(): void {
    this.assertInitialized();
    for (const record of this.records.values()) {
      if (isTerminal(record.snapshot.status)) continue;
      record.controller.abort();
      record.snapshot = interruptedSnapshot(record.snapshot, "HOST_SHUTDOWN_INTERRUPTED_OPERATION");
      this.publish(record);
      record.resolve(structuredClone(record.snapshot));
    }
  }

  private async execute<T>(record: OperationRecord, run: StartOperationInput<T>["run"]): Promise<void> {
    if (isTerminal(record.snapshot.status)) return;
    record.snapshot = operationSnapshotSchema.parse({
      ...record.snapshot,
      status: "running",
      phase: "starting",
      startedAt: new Date().toISOString(),
    });
    this.publish(record);
    const context: OperationRunContext = {
      operationId: record.snapshot.id,
      ...(record.snapshot.runId ? { runId: record.snapshot.runId } : {}),
      signal: record.controller.signal,
      get commitBoundaryCrossed() { return record.snapshot.commitBoundaryCrossed; },
      update: (phase, progress = {}) => {
        if (isTerminal(record.snapshot.status)) return;
        record.snapshot = operationSnapshotSchema.parse({
          ...record.snapshot,
          phase,
          progress: { ...record.snapshot.progress, ...progress },
        });
        this.publish(record);
      },
      markCommitBoundary: (progress = {}) => {
        if (isTerminal(record.snapshot.status)) return;
        record.snapshot = operationSnapshotSchema.parse({
          ...record.snapshot,
          commitBoundaryCrossed: true,
          phase: "committing",
          progress: { ...record.snapshot.progress, ...progress, commitBoundaryAt: new Date().toISOString() },
        });
        this.publish(record);
      },
    };
    try {
      const result = await run(context);
      if (isTerminal(record.snapshot.status)) return;
      const cancelledBeforeCommit = record.controller.signal.aborted && !record.snapshot.commitBoundaryCrossed;
      record.snapshot = operationSnapshotSchema.parse({
        ...record.snapshot,
        status: cancelledBeforeCommit ? "cancelled" : "succeeded",
        cancellable: false,
        phase: cancelledBeforeCommit
          ? "cancelled"
          : record.controller.signal.aborted ? "completed-after-stop" : "completed",
        finishedAt: new Date().toISOString(),
        ...(cancelledBeforeCommit
          ? { error: operationError(new Error("Cancellation requested."), true, false) }
          : { result }),
      });
    } catch (error) {
      if (isTerminal(record.snapshot.status)) return;
      const cancelled = record.controller.signal.aborted && !record.snapshot.commitBoundaryCrossed;
      record.snapshot = operationSnapshotSchema.parse({
        ...record.snapshot,
        status: cancelled ? "cancelled" : "failed",
        cancellable: false,
        phase: cancelled ? "cancelled" : "failed",
        finishedAt: new Date().toISOString(),
        error: operationError(error, cancelled, record.snapshot.commitBoundaryCrossed),
      });
    }
    this.publish(record);
    record.resolve(structuredClone(record.snapshot));
  }

  private publish(record: OperationRecord): void {
    // Operation progress and results cross both the durable storage and SSE
    // boundaries. Keep a final guard here so callers cannot accidentally
    // publish provider credentials through a newly added progress field.
    record.snapshot = sanitizeOperationSnapshot(record.snapshot);
    this.persist(record.snapshot);
    this.events.publish("operation.changed", { operation: structuredClone(record.snapshot) }, {
      operationId: record.snapshot.id,
      ...(record.snapshot.runId ? { runId: record.snapshot.runId } : {}),
    });
  }

  private evictCompleted(): void {
    if (this.records.size < this.maxOperations) return;
    const completed = [...this.records.entries()]
      .filter(([, record]) => isTerminal(record.snapshot.status))
      .sort(([, left], [, right]) => Date.parse(left.snapshot.finishedAt ?? left.snapshot.createdAt) - Date.parse(right.snapshot.finishedAt ?? right.snapshot.createdAt));
    while (this.records.size >= this.maxOperations && completed.length) {
      const [id, record] = completed.shift()!;
      this.records.delete(id);
      this.idempotency.delete(`${record.snapshot.kind}:${record.snapshot.scopeId}:${record.snapshot.clientRequestId}`);
      this.removePersisted(id);
    }
    if (this.records.size >= this.maxOperations) {
      throw webError(503, "OPERATION_CAPACITY_REACHED", "All retained operations are still active; wait for one to finish before starting another.", {
        kind: "after-refresh",
        discoveryEndpoint: "/api/v1/operations",
        copyField: "status",
        maxAttempts: 1,
      });
    }
  }

  private async loadPersistedOperations(): Promise<void> {
    if (!this.storageRoot) {
      this.initialized = true;
      return;
    }
    await fsPromises.mkdir(this.storageRoot, { recursive: true, mode: 0o700 });
    const names = (await fsPromises.readdir(this.storageRoot))
      .filter((name) => name.endsWith(".json"))
      .sort();
    const recovered: OperationRecord[] = [];
    for (const name of names) {
      const filePath = path.join(this.storageRoot, name);
      const loaded = operationSnapshotSchema.parse(JSON.parse(await fsPromises.readFile(filePath, "utf8")));
      const snapshot = sanitizeOperationSnapshot(loaded);
      const expectedName = this.persistedName(snapshot.id);
      if (name !== expectedName) {
        throw new Error(`Operation manifest '${name}' does not match operation '${snapshot.id}'.`);
      }
      if (JSON.stringify(snapshot) !== JSON.stringify(loaded)) this.persist(snapshot);
      const terminal = isTerminal(snapshot.status)
        ? snapshot
        : interruptedSnapshot(snapshot, "HOST_RESTART_INTERRUPTED_OPERATION");
      recovered.push(this.restoredRecord(terminal));
      if (terminal !== snapshot) this.persist(terminal);
    }
    recovered
      .sort((left, right) => Date.parse(left.snapshot.createdAt) - Date.parse(right.snapshot.createdAt) || left.snapshot.id.localeCompare(right.snapshot.id))
      .forEach((record) => {
        const key = `${record.snapshot.kind}:${record.snapshot.scopeId}:${record.snapshot.clientRequestId}`;
        const priorId = this.idempotency.get(key);
        if (priorId) {
          throw new Error(`Persisted operations '${priorId}' and '${record.snapshot.id}' share one idempotency key.`);
        }
        this.records.set(record.snapshot.id, record);
        this.idempotency.set(key, record.snapshot.id);
      });
    this.initialized = true;
    for (const record of recovered) {
      if (record.snapshot.phase === "interrupted-after-restart") this.publish(record);
    }
    while (this.records.size > this.maxOperations) this.evictCompleted();
  }

  private restoredRecord(snapshot: OperationSnapshot): OperationRecord {
    const controller = new AbortController();
    if (isTerminal(snapshot.status)) controller.abort();
    let resolve!: (value: OperationSnapshot) => void;
    const promise = new Promise<OperationSnapshot>((done) => { resolve = done; });
    const record = { snapshot, controller, promise, resolve };
    if (isTerminal(snapshot.status)) resolve(structuredClone(snapshot));
    return record;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error("Persistent operation manager is not initialized. Call and await initialize() before serving requests.");
    }
  }

  private persist(snapshot: OperationSnapshot): void {
    if (!this.storageRoot) return;
    fs.mkdirSync(this.storageRoot, { recursive: true, mode: 0o700 });
    const target = path.join(this.storageRoot, this.persistedName(snapshot.id));
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, target);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
      }
      throw error;
    }
  }

  private removePersisted(operationId: string): void {
    if (!this.storageRoot) return;
    try {
      fs.unlinkSync(path.join(this.storageRoot, this.persistedName(operationId)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private persistedName(operationId: string): string {
    return `${crypto.createHash("sha256").update(operationId).digest("hex")}.json`;
  }
}

function stableFingerprint(input: unknown): string {
  return crypto.createHash("sha256").update(stableJson(input)).digest("hex");
}

function stableJson(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(stableJson).join(",")}]`;
  if (input && typeof input === "object") {
    return `{${Object.entries(input as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${JSON.stringify(key)}:${stableJson(value)}`)
      .join(",")}}`;
  }
  return JSON.stringify(input) ?? "null";
}

function isTerminal(status: OperationSnapshot["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "interrupted";
}

function operationError(error: unknown, cancelled: boolean, commitBoundaryCrossed: boolean): ApiError {
  if (cancelled) {
    return {
      code: "OPERATION_CANCELLED",
      message: "The operation was cancelled before its commit boundary.",
      retry: { kind: "after-user-action" },
    };
  }
  const cause = error instanceof WebApplicationError
    ? sanitizeApiError(error.detail)
    : apiErrorSchema.parse(redactTraceSecrets({
      code: "OPERATION_FAILED",
      message: operationErrorMessage(error),
      retry: { kind: "after-user-action" },
    }));
  if (commitBoundaryCrossed) {
    return apiErrorSchema.parse(redactTraceSecrets({
      code: "OPERATION_INTERRUPTED_AFTER_COMMIT_BOUNDARY",
      message: `The operation failed after crossing its commit boundary: ${cause.message} Reconcile the current snapshot and trace; do not replay the mutation unchanged.`,
      details: {
        causeCode: cause.code,
        ...(cause.details !== undefined ? { causeDetails: cause.details } : {}),
      },
      retry: { kind: "none" },
    }));
  }
  return cause;
}

function sanitizeApiError(error: ApiError): ApiError {
  return apiErrorSchema.parse(redactTraceSecrets(error));
}

function operationErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || "The operation failed without an error message.";
}

function sanitizeOperationSnapshot(snapshot: OperationSnapshot): OperationSnapshot {
  return operationSnapshotSchema.parse(redactTraceSecrets(snapshot));
}

function interruptedSnapshot(
  snapshot: OperationSnapshot,
  code: "HOST_RESTART_INTERRUPTED_OPERATION" | "HOST_SHUTDOWN_INTERRUPTED_OPERATION",
): OperationSnapshot {
  const afterCommit = snapshot.commitBoundaryCrossed;
  return operationSnapshotSchema.parse({
    ...snapshot,
    status: "interrupted",
    cancellable: false,
    phase: code === "HOST_RESTART_INTERRUPTED_OPERATION" ? "interrupted-after-restart" : "interrupted-on-shutdown",
    finishedAt: new Date().toISOString(),
    progress: {
      ...snapshot.progress,
      interruptedAt: new Date().toISOString(),
      interruption: code === "HOST_RESTART_INTERRUPTED_OPERATION" ? "host-restart" : "host-shutdown",
    },
    error: {
      code: afterCommit ? "OPERATION_INTERRUPTED_AFTER_COMMIT_BOUNDARY" : code,
      message: afterCommit
        ? "The host stopped after the operation crossed its commit boundary. Reconcile the branch head and trace; do not replay the world mutation unchanged."
        : "The host stopped before the operation crossed its commit boundary. Review the trace and current snapshot before starting one new request.",
      retry: afterCommit ? { kind: "none" } : { kind: "after-user-action" },
    },
  });
}
