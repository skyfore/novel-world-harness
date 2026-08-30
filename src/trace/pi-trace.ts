import type {
  AgentSessionEvent,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  contextSnapshotSchema,
  type ContextPart,
  type ContextPartKind,
  type ContextAuthority,
  type TraceSourceRef,
  type TraceToolDescriptor,
  type TraceUsage,
} from "./schema.js";
import { newTraceId, type TraceContext } from "./recorder.js";
import { redactTraceSecrets, redactTraceText } from "./redaction.js";

export { redactTraceSecrets } from "./redaction.js";

const TRACE_ASSEMBLY_VERSION = "nwh-pi-context/v1";
const DELTA_FLUSH_CHARS = 8 * 1024;
const DELTA_FLUSH_MS = 100;

export type PiTraceContextPartInput = {
  id: string;
  label: string;
  kind: ContextPartKind;
  role: ContextPart["role"];
  authority: ContextAuthority;
  content?: unknown;
  mediaType?: string;
  sourceRefs?: readonly TraceSourceRef[];
  disposition?: ContextPart["disposition"];
  omissionReason?: string;
  logicalMessageIndexes?: readonly number[];
};

export type PiTraceInvocationInput = {
  parent: TraceContext;
  invocationName: string;
  assemblyVersion?: string;
  parts: readonly PiTraceContextPartInput[];
  attempt?: number;
  metadata?: Readonly<Record<string, unknown>>;
};

type ActiveCall = {
  callId: string;
  turnIndex: number;
  context: TraceContext;
  startedAt: number;
  requestAttempts: number;
  parts: ContextPart[];
  tools: TraceToolDescriptor[];
  logicalMessagesRef?: Awaited<ReturnType<TraceContext["recorder"]["putBlob"]>>;
  logicalContextHash?: string;
  estimatedInputTokens?: number;
};

type DeltaBuffer = {
  context: TraceContext;
  callId: string;
  text: string;
};

/**
 * One isolated Pi session inside a larger NWH run. The recorder is observation
 * only: none of these methods can propose or commit world state.
 */
export class PiTraceInvocation {
  readonly context: TraceContext;
  readonly invocationName: string;
  readonly assemblyVersion: string;
  private parts: ContextPart[];
  private tools: TraceToolDescriptor[] = [];
  private activeCall?: ActiveCall;
  private readonly deltaBuffers = new Map<string, DeltaBuffer>();
  private deltaTimer?: NodeJS.Timeout;
  private work: Promise<void> = Promise.resolve();
  private traceFailure?: unknown;
  private finished = false;
  private callCount = 0;
  private systemCaptured = false;

  private constructor(
    context: TraceContext,
    input: PiTraceInvocationInput,
    parts: ContextPart[],
  ) {
    this.context = context;
    this.invocationName = input.invocationName;
    this.assemblyVersion = input.assemblyVersion ?? TRACE_ASSEMBLY_VERSION;
    this.parts = parts;
  }

  static async start(input: PiTraceInvocationInput): Promise<PiTraceInvocation> {
    const context = await input.parent.recorder.child(input.parent, input.invocationName, "pi-invocation");
    const parts = await Promise.all(input.parts.map((part) => materializePart(context, part)));
    const invocation = new PiTraceInvocation(context, input, parts);
    await context.recorder.record("context.assembled", {
      invocationName: input.invocationName,
      assemblyVersion: invocation.assemblyVersion,
      declaredPartCount: parts.length,
      ...(input.attempt !== undefined ? { hostAttempt: input.attempt } : {}),
      ...(input.metadata ? { metadata: redactTraceSecrets(input.metadata) } : {}),
    }, context);
    return invocation;
  }

  extensionFactory(): ExtensionFactory {
    return (pi) => {
      pi.on("before_agent_start", (event, ctx) => this.enqueue(async () => {
        if (!this.systemCaptured) {
          this.parts.push(await materializePart(this.context, {
            id: `${this.invocationName}.system.final`,
            label: "Final Pi system prompt",
            kind: "system.core",
            role: "system",
            authority: "trusted-system",
            content: event.systemPrompt,
          }));
          this.systemCaptured = true;
        }
        this.tools = await Promise.all(pi.getAllTools()
          .filter((tool) => new Set(pi.getActiveTools()).has(tool.name))
          .map(async (tool): Promise<TraceToolDescriptor> => ({
            name: tool.name,
            description: tool.description,
            parametersRef: await this.context.recorder.putBlob(redactTraceSecrets(tool.parameters)),
          })));
        const promptRef = await this.context.recorder.putBlob(event.prompt, "text/plain; charset=utf-8");
        await this.context.recorder.record("context.assembled", {
          invocationName: this.invocationName,
          phase: "before-agent-start",
          providerId: ctx.model?.provider,
          modelId: ctx.model?.id,
          thinkingLevel: ctx.thinkingLevel,
          toolNames: this.tools.map((tool) => tool.name),
          promptHash: promptRef.sha256,
          redactionPolicy: "nwh-trace-secrets/v1",
        }, this.context, { blobRef: promptRef });
      }));

      pi.on("turn_start", (event) => this.enqueue(async () => {
        if (this.activeCall) await this.closeActiveTurn({ status: "superseded" });
        const context = await this.context.recorder.child(
          this.context,
          `LLM turn ${event.turnIndex + 1}`,
          "llm-turn",
        );
        this.callCount += 1;
        this.activeCall = {
          callId: newTraceId("call"),
          turnIndex: event.turnIndex,
          context,
          startedAt: event.timestamp,
          requestAttempts: 0,
          parts: structuredClone(this.parts),
          tools: structuredClone(this.tools),
        };
      }));

      pi.on("context", (event, ctx) => this.enqueue(async () => {
        const call = await this.requireActiveCall();
        const logicalMessages = redactTraceSecrets(event.messages);
        const logicalMessagesRef = await this.context.recorder.putBlob(logicalMessages);
        const promptIndex = lastMessageIndex(event.messages, "user");
        const parts = call.parts.map((part) => part.logicalMessageIndexes.length > 0 || part.role !== "user" || promptIndex < 0
          ? part
          : { ...part, logicalMessageIndexes: [promptIndex] });
        for (let index = 0; index < event.messages.length; index += 1) {
          const message = event.messages[index] as { role?: unknown };
          if (message.role !== "toolResult") continue;
          parts.push(await materializePart(call.context, {
            id: `${call.callId}.tool-result.${index}`,
            label: `Tool result message ${index + 1}`,
            kind: "tool.result",
            role: "tool",
            authority: "tool-result",
            content: redactTraceSecrets(event.messages[index]),
            logicalMessageIndexes: [index],
          }));
        }
        call.parts = parts;
        call.logicalMessagesRef = logicalMessagesRef;
        call.logicalContextHash = logicalMessagesRef.sha256;
        call.estimatedInputTokens = estimateTokens(JSON.stringify(logicalMessages));
        const snapshotRef = await this.putContextSnapshot(call, ctx);
        await this.context.recorder.record("context.assembled", {
          invocationName: this.invocationName,
          logicalContextHash: logicalMessagesRef.sha256,
          semanticPartCount: parts.length,
          logicalMessageCount: event.messages.length,
          estimatedInputTokens: call.estimatedInputTokens,
        }, call.context, { callId: call.callId, blobRef: snapshotRef });
      }));

      pi.on("before_provider_request", (event, ctx) => this.enqueue(async () => {
        const call = await this.requireActiveCall();
        call.requestAttempts += 1;
        const payloadRef = await this.context.recorder.putBlob(redactTraceSecrets(event.payload));
        await this.context.recorder.record("llm.request.started", {
          invocationName: this.invocationName,
          turnIndex: call.turnIndex,
          requestAttempt: call.requestAttempts,
          providerId: ctx.model?.provider,
          modelId: ctx.model?.id,
          thinkingLevel: ctx.thinkingLevel,
        }, call.context, { callId: call.callId });
        await this.context.recorder.record("llm.request.payload", {
          requestAttempt: call.requestAttempts,
          providerPayloadHash: payloadRef.sha256,
          redactionPolicy: "nwh-trace-secrets/v1",
        }, call.context, { callId: call.callId, blobRef: payloadRef });
        const snapshotRef = await this.putContextSnapshot(call, ctx, payloadRef);
        await this.context.recorder.record("context.finalized", {
          invocationName: this.invocationName,
          requestAttempt: call.requestAttempts,
          logicalContextHash: call.logicalContextHash,
          providerPayloadHash: payloadRef.sha256,
        }, call.context, { callId: call.callId, blobRef: snapshotRef });
      }));

      pi.on("after_provider_response", (event) => this.enqueue(async () => {
        const call = await this.requireActiveCall();
        const headersRef = await this.context.recorder.putBlob(redactTraceSecrets(event.headers));
        await this.context.recorder.record("llm.response.started", {
          requestAttempt: call.requestAttempts,
          httpStatus: event.status,
          responseHeadersRedacted: true,
        }, call.context, { callId: call.callId, blobRef: headersRef });
      }));

      pi.on("message_update", (event) => {
        const update = event.assistantMessageEvent;
        if (update.type === "thinking_delta") {
          const call = this.activeCall;
          if (call) {
            const buffer = this.deltaBuffers.get(`${call.callId}:reasoning`) ?? {
              context: call.context,
              callId: call.callId,
              text: "",
            };
            buffer.text += update.delta;
            this.deltaBuffers.set(`${call.callId}:reasoning`, buffer);
          }
          return;
        }
        if (update.type !== "text_delta" || !this.activeCall) return;
        const key = this.activeCall.callId;
        const buffer = this.deltaBuffers.get(key) ?? {
          context: this.activeCall.context,
          callId: this.activeCall.callId,
          text: "",
        };
        buffer.text += update.delta;
        this.deltaBuffers.set(key, buffer);
        if (buffer.text.length >= DELTA_FLUSH_CHARS) return this.enqueue(() => this.flushDeltas());
        this.scheduleDeltaFlush();
      });

      pi.on("message_end", (event) => {
        if (event.message.role !== "assistant") return;
        const assistant = event.message;
        return this.enqueue(async () => {
          await this.flushDeltas();
          const call = await this.requireActiveCall();
          const message = redactTraceSecrets(assistant);
          const responseRef = await this.context.recorder.putBlob(message);
          const usage = traceUsage(assistant.usage);
          const reasoning = this.deltaBuffers.get(`${call.callId}:reasoning`);
          this.deltaBuffers.delete(`${call.callId}:reasoning`);
          const failed = assistant.stopReason === "error" || assistant.stopReason === "aborted";
          await this.context.recorder.record(failed ? "llm.response.failed" : "llm.response.completed", {
            providerId: assistant.provider,
            modelId: assistant.model,
            responseModelId: assistant.responseModel,
            api: assistant.api,
            stopReason: assistant.stopReason,
            rawStopReason: assistant.rawStopReason,
            errorMessage: assistant.errorMessage ? redactTraceText(assistant.errorMessage) : undefined,
            usage,
            durationMs: Math.max(0, Date.now() - call.startedAt),
            hasReasoning: assistant.content.some((part) => part.type === "thinking"),
            streamedReasoningChars: reasoning?.text.length ?? 0,
            reasoningContentRecorded: false,
          }, call.context, { callId: call.callId, blobRef: responseRef });
        });
      });

      pi.on("tool_execution_start", (event) => this.enqueue(async () => {
        const call = await this.requireActiveCall();
        const inputRef = await this.context.recorder.putBlob(redactTraceSecrets(event.args));
        await this.context.recorder.record("tool.call.started", {
          toolName: event.toolName,
          inputHash: inputRef.sha256,
        }, call.context, { callId: call.callId, toolCallId: event.toolCallId, blobRef: inputRef });
      }));

      pi.on("tool_execution_update", (event) => this.enqueue(async () => {
        const call = await this.requireActiveCall();
        const progressRef = await this.context.recorder.putBlob(redactTraceSecrets(event.partialResult));
        await this.context.recorder.record("tool.call.progress", {
          toolName: event.toolName,
        }, call.context, { callId: call.callId, toolCallId: event.toolCallId, blobRef: progressRef });
      }));

      pi.on("tool_execution_end", (event) => this.enqueue(async () => {
        const call = await this.requireActiveCall();
        const resultRef = await this.context.recorder.putBlob(redactTraceSecrets(event.result));
        await this.context.recorder.record(event.isError ? "tool.call.failed" : "tool.call.completed", {
          toolName: event.toolName,
          isError: event.isError,
        }, call.context, { callId: call.callId, toolCallId: event.toolCallId, blobRef: resultRef });
      }));

      pi.on("turn_end", (event) => this.enqueue(() => this.closeActiveTurn({
        status: "completed",
        turnIndex: event.turnIndex,
        toolResultCount: event.toolResults.length,
      })));
    };
  }

  recordRetry(event: Extract<AgentSessionEvent, { type: "auto_retry_start" }>): void {
    this.enqueueDetached(async () => {
      const call = this.activeCall;
      await this.context.recorder.record("llm.retry", {
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorMessage: redactTraceText(event.errorMessage),
      }, call?.context ?? this.context, call ? { callId: call.callId } : {});
    });
  }

  async complete(): Promise<void> {
    if (this.finished) return this.flush();
    await this.enqueue(async () => {
      await this.flushDeltas();
      if (this.activeCall) await this.closeActiveTurn({ status: "settled-without-turn-end" });
      await this.context.recorder.finishStage(this.context, { status: "succeeded", callCount: this.callCount });
      this.finished = true;
    });
    await this.flush();
  }

  async fail(error: unknown): Promise<void> {
    if (this.finished) return this.flush();
    await this.enqueue(async () => {
      await this.flushDeltas();
      if (this.activeCall) {
        await this.context.recorder.failStage(this.activeCall.context, error);
        this.activeCall = undefined;
      }
      await this.context.recorder.failStage(this.context, error);
      this.finished = true;
    });
    await this.flush();
  }

  async flush(): Promise<void> {
    await this.work;
    if (this.traceFailure) throw this.traceFailure;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.work.then(async () => {
      if (this.traceFailure) throw this.traceFailure;
      await operation();
    });
    this.work = result.catch((error) => {
      this.traceFailure ??= error;
    });
    return result;
  }

  private enqueueDetached(operation: () => Promise<void>): void {
    void this.enqueue(operation).catch(() => undefined);
  }

  private async requireActiveCall(): Promise<ActiveCall> {
    if (this.activeCall) return this.activeCall;
    const context = await this.context.recorder.child(this.context, "LLM turn (unindexed)", "llm-turn");
    this.callCount += 1;
    this.activeCall = {
      callId: newTraceId("call"),
      turnIndex: this.callCount - 1,
      context,
      startedAt: Date.now(),
      requestAttempts: 0,
      parts: structuredClone(this.parts),
      tools: structuredClone(this.tools),
    };
    return this.activeCall;
  }

  private async closeActiveTurn(data: Record<string, unknown>): Promise<void> {
    const call = this.activeCall;
    if (!call) return;
    await this.flushDeltas();
    await this.context.recorder.finishStage(call.context, {
      ...data,
      callId: call.callId,
      requestAttempts: call.requestAttempts,
      durationMs: Math.max(0, Date.now() - call.startedAt),
    });
    this.activeCall = undefined;
  }

  private async putContextSnapshot(
    call: ActiveCall,
    ctx: ExtensionContext,
    providerPayloadRef?: Awaited<ReturnType<TraceContext["recorder"]["putBlob"]>>,
  ) {
    const snapshot = contextSnapshotSchema.parse({
      version: 1,
      callId: call.callId,
      invocationName: this.invocationName,
      assemblyVersion: this.assemblyVersion,
      providerId: ctx.model?.provider,
      modelId: ctx.model?.id,
      thinkingLevel: ctx.thinkingLevel,
      parts: call.parts,
      tools: call.tools,
      logicalMessagesRef: call.logicalMessagesRef,
      providerPayloadRef,
      logicalContextHash: call.logicalContextHash,
      providerPayloadHash: providerPayloadRef?.sha256,
      estimatedInputTokens: call.estimatedInputTokens,
    });
    return this.context.recorder.putBlob(snapshot);
  }

  private scheduleDeltaFlush(): void {
    if (this.deltaTimer) return;
    this.deltaTimer = setTimeout(() => {
      this.deltaTimer = undefined;
      this.enqueueDetached(() => this.flushDeltas());
    }, DELTA_FLUSH_MS);
    this.deltaTimer.unref();
  }

  private async flushDeltas(): Promise<void> {
    if (this.deltaTimer) clearTimeout(this.deltaTimer);
    this.deltaTimer = undefined;
    const buffers = [...this.deltaBuffers.entries()].filter(([key, buffer]) => !key.endsWith(":reasoning") && buffer.text.length > 0);
    for (const [key, buffer] of buffers) {
      this.deltaBuffers.delete(key);
      const blobRef = await this.context.recorder.putBlob(buffer.text, "text/plain; charset=utf-8");
      await this.context.recorder.record("llm.response.delta", {
        charCount: buffer.text.length,
      }, buffer.context, { callId: buffer.callId, blobRef });
    }
  }
}

export function createPiTraceExtension(invocation: PiTraceInvocation): ExtensionFactory {
  return invocation.extensionFactory();
}

async function materializePart(context: TraceContext, input: PiTraceContextPartInput): Promise<ContextPart> {
  const disposition = input.disposition ?? "included";
  const sanitized = input.content === undefined ? undefined : redactTraceSecrets(input.content);
  const serialized = sanitized === undefined
    ? ""
    : typeof sanitized === "string"
      ? sanitized
      : JSON.stringify(sanitized);
  const contentRef = disposition === "omitted" || sanitized === undefined
    ? undefined
    : await context.recorder.putBlob(
      sanitized,
      input.mediaType ?? (typeof sanitized === "string" ? "text/plain; charset=utf-8" : "application/json"),
    );
  return {
    id: input.id,
    label: input.label,
    kind: input.kind,
    role: input.role,
    authority: input.authority,
    sourceRefs: structuredClone([...(input.sourceRefs ?? [])]),
    ...(contentRef ? { contentRef } : {}),
    charCount: serialized.length,
    estimatedTokens: estimateTokens(serialized),
    disposition,
    ...(input.omissionReason ? { omissionReason: input.omissionReason } : {}),
    logicalMessageIndexes: [...(input.logicalMessageIndexes ?? [])],
  };
}

function lastMessageIndex(messages: readonly unknown[], role: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown };
    if (message?.role === role) return index;
  }
  return -1;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function traceUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  cost: { total: number };
}): TraceUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
    totalTokens: usage.totalTokens,
    cost: usage.cost.total,
  };
}
