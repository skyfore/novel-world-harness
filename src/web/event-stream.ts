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
      data,
    });
    this.history.push(event);
    if (this.history.length > this.historyLimit) this.history.splice(0, this.history.length - this.historyLimit);
    for (const listener of this.listeners) listener(event);
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
    for (const event of this.replayAfter(afterEventId)) listener(event);
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
