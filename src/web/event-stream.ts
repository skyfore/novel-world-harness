import { redactTraceSecrets } from "../trace/redaction.js";
import { webEventSchema, type WebEvent, type WebEventType } from "./contracts.js";

export type WebEventListener = (event: WebEvent) => void;

export class WebEventBroker {
  private sequence = 0;
  private readonly history: WebEvent[] = [];
  private readonly listeners = new Set<WebEventListener>();

  constructor(private readonly historyLimit = 512) {
    if (!Number.isInteger(historyLimit) || historyLimit < 1) {
      throw new Error("Web event history limit must be a positive integer.");
    }
  }

  publish(type: WebEventType, data: Record<string, unknown> = {}, links: {
    operationId?: string;
    runId?: string;
  } = {}): WebEvent {
    const event = webEventSchema.parse({
      version: 1,
      eventId: String(++this.sequence),
      occurredAt: new Date().toISOString(),
      type,
      ...links,
      // SSE is externally observable even on loopback. Redact at this final
      // boundary rather than relying on every publisher to know which nested
      // provider fields may contain credentials.
      data: redactTraceSecrets(data),
    });
    this.history.push(event);
    if (this.history.length > this.historyLimit) this.history.splice(0, this.history.length - this.historyLimit);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A disconnected or faulty SSE consumer is an observation failure,
        // never a business-operation failure. Drop that listener and let the
        // browser recover from authoritative snapshots plus a new cursor.
        this.listeners.delete(listener);
      }
    }
    return event;
  }

  replayAfter(eventId?: string): WebEvent[] {
    if (eventId === undefined || eventId === "") return [...this.history];
    if (!/^\d+$/.test(eventId)) throw new Error("Event cursor must be a non-negative integer string.");
    const cursor = Number(eventId);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Event cursor is outside the supported range.");
    return this.history.filter((event) => Number(event.eventId) > cursor);
  }

  subscribe(listener: WebEventListener, afterEventId?: string): () => void {
    const replay = this.replayAfter(afterEventId);
    try {
      for (const event of replay) listener(event);
    } catch {
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get latestEventId(): string {
    return String(this.sequence);
  }
}

export function serializeServerSentEvent(event: WebEvent): string {
  return `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
