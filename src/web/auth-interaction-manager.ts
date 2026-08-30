import crypto from "node:crypto";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import {
  answerAuthInteractionRequestSchema,
  authInteractionPromptSchema,
  authInteractionSnapshotSchema,
  type AuthInteractionSnapshot,
} from "./contracts.js";
import { WebEventBroker } from "./event-stream.js";
import { webError } from "./errors.js";

type PendingInteraction = {
  snapshot: AuthInteractionSnapshot;
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
  onChange: (snapshot: AuthInteractionSnapshot) => void;
};

export class AuthInteractionManager {
  private readonly records = new Map<string, PendingInteraction>();

  constructor(
    private readonly events: WebEventBroker,
    private readonly timeoutMs = 5 * 60_000,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) throw new Error("Auth interaction timeout must be at least one second.");
  }

  request(
    operationId: string,
    providerId: string,
    promptValue: AuthPrompt,
    operationSignal: AbortSignal,
    onChange: (snapshot: AuthInteractionSnapshot) => void,
  ): Promise<string> {
    if (operationSignal.aborted || promptValue.signal?.aborted) return Promise.reject(new Error("Login cancelled."));
    const prompt = authInteractionPromptSchema.parse({
      type: promptValue.type,
      message: promptValue.message,
      ...("placeholder" in promptValue && promptValue.placeholder ? { placeholder: promptValue.placeholder } : {}),
      ...(promptValue.type === "select" ? { options: promptValue.options } : {}),
    });
    const now = new Date();
    const id = `interaction-${crypto.randomUUID()}`;
    const snapshot = authInteractionSnapshotSchema.parse({
      version: 1,
      id,
      operationId,
      providerId,
      status: "pending",
      prompt,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.timeoutMs).toISOString(),
    });
    return new Promise<string>((resolve, reject) => {
      const abort = () => this.settle(id, "cancelled", new Error("Login prompt cancelled."), onChange);
      operationSignal.addEventListener("abort", abort, { once: true });
      promptValue.signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => {
        operationSignal.removeEventListener("abort", abort);
        promptValue.signal?.removeEventListener("abort", abort);
      };
      const timer = setTimeout(() => {
        this.settle(id, "expired", new Error("Login prompt expired. Start one new login operation."), onChange);
      }, this.timeoutMs);
      timer.unref?.();
      this.records.set(id, { snapshot, resolve, reject, timer, cleanup, onChange });
      onChange(structuredClone(snapshot));
      this.events.publish("interaction.requested", { interaction: structuredClone(snapshot) }, { operationId });
    });
  }

  answer(interactionId: string, inputValue: unknown): AuthInteractionSnapshot {
    const input = answerAuthInteractionRequestSchema.parse(inputValue);
    const record = this.records.get(interactionId);
    if (!record) {
      throw webError(404, "INTERACTION_NOT_FOUND", `Unknown auth interaction '${interactionId}'. Refresh the provider login operation and copy its exact progress.interaction.id.`, {
        kind: "after-refresh",
        discoveryEndpoint: "/api/v1/operations?kind=provider-login",
        copyField: "progress.interaction.id",
        maxAttempts: 1,
      });
    }
    if (record.snapshot.status !== "pending") {
      throw webError(409, "INTERACTION_ALREADY_RESOLVED", `Auth interaction '${interactionId}' is already ${record.snapshot.status}. Do not submit another answer.`, { kind: "none" });
    }
    if (record.snapshot.prompt.type === "select" && !record.snapshot.prompt.options.some((option) => option.id === input.answer)) {
      throw webError(400, "INTERACTION_OPTION_INVALID", `Answer must copy one exact option id from interaction '${interactionId}'.`, {
        kind: "after-user-action",
        discoveryEndpoint: `/api/v1/operations/${encodeURIComponent(record.snapshot.operationId)}`,
        copyField: "progress.interaction.prompt.options[].id",
        maxAttempts: 1,
      });
    }
    clearTimeout(record.timer);
    record.cleanup();
    record.snapshot = authInteractionSnapshotSchema.parse({
      ...record.snapshot,
      status: "answered",
      resolvedAt: new Date().toISOString(),
    });
    record.onChange(structuredClone(record.snapshot));
    record.resolve(input.answer);
    this.events.publish("interaction.resolved", {
      interaction: structuredClone(record.snapshot),
    }, { operationId: record.snapshot.operationId });
    return structuredClone(record.snapshot);
  }

  private settle(
    interactionId: string,
    status: "cancelled" | "expired",
    error: Error,
    onChange: (snapshot: AuthInteractionSnapshot) => void,
  ): void {
    const record = this.records.get(interactionId);
    if (!record || record.snapshot.status !== "pending") return;
    clearTimeout(record.timer);
    record.cleanup();
    record.snapshot = authInteractionSnapshotSchema.parse({
      ...record.snapshot,
      status,
      resolvedAt: new Date().toISOString(),
    });
    onChange(structuredClone(record.snapshot));
    record.reject(error);
    this.events.publish("interaction.resolved", {
      interaction: structuredClone(record.snapshot),
    }, { operationId: record.snapshot.operationId });
  }
}
