import crypto from "node:crypto";
import {
  operationAcceptedSchema,
  operationSnapshotSchema,
  type ApiError,
  type OperationAccepted,
  type OperationKind,
  type OperationSnapshot,
} from "./contracts.js";
import { WebEventBroker } from "./event-stream.js";
import { webError } from "./errors.js";

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

export class OperationManager {
  private readonly records = new Map<string, OperationRecord>();
  private readonly idempotency = new Map<string, string>();

  constructor(
    readonly events: WebEventBroker,
    private readonly maxOperations = 1_000,
  ) {
    if (!Number.isInteger(maxOperations) || maxOperations < 10) {
      throw new Error("Operation retention must be an integer of at least 10.");
    }
  }

  start<T>(input: StartOperationInput<T>): OperationAccepted {
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
    this.publish(record);
    queueMicrotask(() => { void this.execute(record, input.run); });
    return operationAcceptedSchema.parse({ operation: record.snapshot, reused: false });
  }

  get(operationId: string): OperationSnapshot {
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
    return [...this.records.values()]
      .map((record) => structuredClone(record.snapshot))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  }

  findByClientRequest(
    kind: OperationKind,
    scopeId: string,
    clientRequestId: string,
  ): OperationSnapshot | undefined {
    const operationId = this.idempotency.get(`${kind}:${scopeId}:${clientRequestId}`);
    return operationId ? this.get(operationId) : undefined;
  }

  cancel(operationId: string): OperationSnapshot {
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
    const record = this.records.get(operationId);
    if (!record) return this.get(operationId);
    return structuredClone(await record.promise);
  }

  private async execute<T>(record: OperationRecord, run: StartOperationInput<T>["run"]): Promise<void> {
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
  if (commitBoundaryCrossed) {
    return {
      code: "OPERATION_INTERRUPTED_AFTER_COMMIT_BOUNDARY",
      message: error instanceof Error ? error.message : String(error),
      retry: { kind: "none" },
    };
  }
  return {
    code: "OPERATION_FAILED",
    message: error instanceof Error ? error.message : String(error),
    retry: { kind: "none" },
  };
}
