import { useCallback, useSyncExternalStore } from "react";

type FrameScheduler = (flush: () => void) => void;

const MAX_LIVE_CHARACTERS = 1_000_000;

/**
 * High-frequency narration deltas live outside React and the query cache.
 * Appends are folded once per animation frame; authoritative completed text
 * still comes from the operation/session HTTP projections.
 */
export class NarrationStreamStore {
  private readonly values = new Map<string, string>();
  private readonly pending = new Map<string, string>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private scheduled = false;

  constructor(private readonly schedule: FrameScheduler = scheduleBrowserFrame) {}

  append(operationId: string, delta: string): void {
    if (!operationId || !delta) return;
    this.pending.set(operationId, `${this.pending.get(operationId) ?? ""}${delta}`);
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => this.flush());
  }

  reset(operationId: string): void {
    if (!operationId) return;
    this.pending.delete(operationId);
    const changed = this.values.get(operationId) !== "";
    this.values.set(operationId, "");
    if (changed) this.emit(operationId);
  }

  complete(operationId: string): void {
    if (!operationId) return;
    const visibleChanged = (this.values.get(operationId) ?? "") !== "";
    this.pending.delete(operationId);
    this.values.delete(operationId);
    if (visibleChanged) this.emit(operationId);
  }

  snapshot(operationId?: string): string {
    return operationId ? this.values.get(operationId) ?? "" : "";
  }

  subscribe(operationId: string | undefined, listener: () => void): () => void {
    if (!operationId) return () => undefined;
    const listeners = this.listeners.get(operationId) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(operationId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(operationId);
    };
  }

  private flush(): void {
    this.scheduled = false;
    for (const [operationId, delta] of this.pending) {
      this.pending.delete(operationId);
      const combined = `${this.values.get(operationId) ?? ""}${delta}`;
      this.values.set(
        operationId,
        combined.length <= MAX_LIVE_CHARACTERS
          ? combined
          : `…[live prefix omitted]\n${combined.slice(-MAX_LIVE_CHARACTERS)}`,
      );
      this.emit(operationId);
    }
  }

  private emit(operationId: string): void {
    for (const listener of this.listeners.get(operationId) ?? []) listener();
  }
}

export const narrationStreamStore = new NarrationStreamStore();

export function useNarrationStream(operationId?: string): string {
  const subscribe = useCallback(
    (listener: () => void) => narrationStreamStore.subscribe(operationId, listener),
    [operationId],
  );
  const snapshot = useCallback(() => narrationStreamStore.snapshot(operationId), [operationId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function scheduleBrowserFrame(flush: () => void): void {
  if (typeof globalThis.requestAnimationFrame === "function") {
    globalThis.requestAnimationFrame(() => flush());
    return;
  }
  globalThis.setTimeout(flush, 16);
}
