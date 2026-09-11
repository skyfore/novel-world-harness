import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type RuntimeHookType = "command" | "user.input" | "llm.response" | "tool" | "session.turn" | "llm.prompt"
  | "compiler.batches" | "compilation" | "play.turn" | "play.response";
export type RuntimeHookStatus = "succeeded" | "failed" | "cancelled";
export type RuntimeHookMetadata = Readonly<Record<string, string | number | boolean | undefined>>;
export type RuntimeHookEvent = Readonly<{
  type: RuntimeHookType;
  id: string;
  parentId?: string;
  name: string;
  status: RuntimeHookStatus;
  timestamp: string;
  durationMs?: number;
  metadata: RuntimeHookMetadata;
  error?: Readonly<{ name: string; message: string }>;
}>;
export type RuntimeHook = (event: RuntimeHookEvent) => void | Promise<void>;
export type RuntimeHookFailure = { event: RuntimeHookEvent; error: unknown };
const scope = new AsyncLocalStorage<{ hooks: RuntimeHooks; operationId?: string }>();

/** Host-only observers. No model tools, state mutation authority, or delivery persistence. */
export class RuntimeHooks {
  private readonly listeners = new Set<RuntimeHook>();
  private readonly timeoutMs: number;
  constructor(private readonly options: {
    timeoutMs?: number;
    onError?: (failure: RuntimeHookFailure) => void | Promise<void>;
  } = {}) {
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("Hook timeout must be positive and finite.");
  }
  subscribe(listener: RuntimeHook): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  async emit(event: Omit<RuntimeHookEvent, "id" | "timestamp"> & { id?: string }): Promise<void> {
    const snapshot: RuntimeHookEvent = Object.freeze({
      parentId: scope.getStore()?.operationId,
      ...event,
      id: event.id ?? randomUUID(),
      timestamp: new Date().toISOString(),
      metadata: Object.freeze({ ...event.metadata }),
      ...(event.error ? { error: Object.freeze({ ...event.error }) } : {}),
    });
    await Promise.all([...this.listeners].map(async (listener) => {
      try {
        await this.bounded(() => listener(snapshot));
      } catch (error) {
        try {
          if (this.options.onError) await this.bounded(() => this.options.onError!({ event: snapshot, error }));
          else process.emitWarning(`Runtime hook failed for ${snapshot.type}/${snapshot.name}: ${String(error)}`);
        } catch (reportError) {
          process.emitWarning(`Runtime hook error reporter failed: ${String(reportError)}`);
        }
      }
    }));
  }
  async run<T>(type: RuntimeHookType, name: string, metadata: RuntimeHookMetadata, operation: () => Promise<T>): Promise<T> {
    const id = randomUUID();
    const parentId = scope.getStore()?.operationId;
    const started = performance.now();
    return scope.run({ hooks: this, operationId: id }, async () => {
      try {
        const result = await operation();
        await this.emit({ type, name, id, parentId, metadata, status: "succeeded", durationMs: performance.now() - started });
        return result;
      } catch (error) {
        await this.emit({ type, name, id, parentId, metadata, status: hookErrorStatus(error), error: hookError(error), durationMs: performance.now() - started });
        throw error;
      }
    });
  }
  private async bounded(operation: () => void | Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(operation),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Runtime hook timed out.")), this.timeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
export function hookError(error: unknown): { name: string; message: string } {
  return error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) };
}
export function hookErrorStatus(error: unknown): RuntimeHookStatus {
  return error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed";
}
export const runtimeHooks = new RuntimeHooks();
export function currentRuntimeHooks(): RuntimeHooks { return scope.getStore()?.hooks ?? runtimeHooks; }
/** Isolate subscriptions across concurrent requests; nested domain and Pi calls inherit this bus. */
export function withRuntimeHooks<T>(hooks: RuntimeHooks, operation: () => T): T {
  return scope.run({ hooks }, operation);
}
