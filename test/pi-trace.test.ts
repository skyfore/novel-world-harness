import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TraceRecorder } from "../src/trace/recorder.js";
import { contextSnapshotSchema } from "../src/trace/schema.js";
import { TraceStore } from "../src/trace/store.js";
import {
  PiTraceInvocation,
  createPiTraceExtension,
  redactTraceSecrets,
} from "../src/trace/pi-trace.js";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { LocalFileWorkspace } from "../src/workspace/local-files.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-trace-"));
  roots.push(root);
  return root;
}

describe("Pi trace conformance", () => {
  it("loads after prompt privacy and never persists Pi's appended workspace path", async () => {
    const root = await workspace();
    const store = new TraceStore(root);
    const recorder = await TraceRecorder.start(store, {
      id: "run-pi-extension-order",
      kind: "prepare",
    });
    const session = await PiAgentSession.create({
      workspace: await LocalFileWorkspace.create(root),
      runtimeDir: path.join(root, "user-runtime"),
      piAgentDir: path.join(root, "pi-agent"),
      saveSession: false,
      includeNwhExtension: false,
      trace: {
        parent: recorder.rootContext,
        invocationName: "privacy-order-check",
        parts: [],
      },
    });
    const internals = session as unknown as {
      runtimeHost: {
        session: {
          systemPrompt: string;
          _baseSystemPromptOptions: unknown;
          _extensionRunner: {
            emitBeforeAgentStart(
              prompt: string,
              images: undefined,
              systemPrompt: string,
              options: unknown,
            ): Promise<{ systemPrompt?: string } | undefined>;
          };
        };
      };
    };
    const piSession = internals.runtimeHost.session;
    expect(piSession.systemPrompt).toContain(root);
    await piSession._extensionRunner.emitBeforeAgentStart(
      "hello",
      undefined,
      piSession.systemPrompt,
      piSession._baseSystemPromptOptions,
    );
    await session.dispose();
    await recorder.finish("succeeded");

    expect(await readTree(store.root)).not.toContain(root);
  });

  it("captures final context, provider payload, tools, retry, response, and usage without secrets or hidden reasoning", async () => {
    const root = await workspace();
    const store = new TraceStore(root);
    const recorder = await TraceRecorder.start(store, {
      id: "run-pi-conformance",
      kind: "player-move",
      playSessionId: "play-main",
    });
    const invocation = await PiTraceInvocation.start({
      parent: recorder.rootContext,
      invocationName: "interpret-player-action",
      parts: [
        {
          id: "player-utterance",
          label: "Player utterance",
          kind: "player.utterance",
          role: "user",
          authority: "untrusted-player",
          content: "Open the door.",
        },
        {
          id: "actor-state",
          label: "Actor-visible committed state",
          kind: "actor.state",
          role: "user",
          authority: "actor-visible",
          content: { location: "hall" },
        },
      ],
    });

    const harness = fakeExtensionHarness();
    createPiTraceExtension(invocation)(harness.api);
    const ctx = {
      model: { provider: "fake-provider", id: "fake-model" },
      thinkingLevel: "medium",
    };
    const now = Date.now();
    await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "Translate the action.",
      systemPrompt: "Final system role and capability contract.",
      systemPromptOptions: {},
    }, ctx);
    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: now }, ctx);
    await harness.emit("context", {
      type: "context",
      messages: [{ role: "user", content: "Translate the action.", timestamp: now }],
    }, ctx);
    await harness.emit("before_provider_request", {
      type: "before_provider_request",
      payload: {
        model: "fake-model",
        authorization: "Bearer canary-authorization",
        apiKey: "canary-api-key",
        prompt: "sk-canary-provider-secret",
      },
    }, ctx);
    await harness.emit("after_provider_response", {
      type: "after_provider_response",
      status: 200,
      headers: { "content-type": "text/event-stream", "set-cookie": "canary-cookie" },
    }, ctx);
    invocation.recordRetry({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 250,
      errorMessage: "Bearer canary-retry-secret",
    });
    await harness.emit("message_update", {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "thinking_delta", delta: "canary-hidden-reasoning" },
    }, ctx);
    await harness.emit("message_update", {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "Door opened." },
    }, ctx);
    await harness.emit("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "tool-call-1",
      toolName: "propose_player_action",
      args: { password: "canary-tool-password", title: "Open the door" },
    }, ctx);
    await harness.emit("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "tool-call-1",
      toolName: "propose_player_action",
      result: { credential: "canary-tool-credential", accepted: true },
      isError: false,
    }, ctx);
    await harness.emit("message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "canary-hidden-reasoning", thinkingSignature: "canary-signature" },
          { type: "text", text: "Door opened." },
        ],
        api: "openai-responses",
        provider: "fake-provider",
        model: "fake-model",
        usage: {
          input: 100,
          output: 20,
          cacheRead: 10,
          cacheWrite: 5,
          reasoning: 4,
          totalTokens: 135,
          cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
        },
        stopReason: "stop",
        errorMessage: "Bearer canary-final-error-secret",
        timestamp: now + 20,
      },
    }, ctx);
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: {},
      toolResults: [{}],
    }, ctx);
    await invocation.complete();
    const manifest = await recorder.finish("succeeded");

    expect(manifest.counts).toEqual({ llmRequests: 1, toolCalls: 1, retries: 1 });
    expect(manifest.usage).toMatchObject({
      input: 100,
      output: 20,
      cacheRead: 10,
      cacheWrite: 5,
      reasoning: 4,
      totalTokens: 135,
      cost: 0.03,
    });
    const events = await store.readEvents(manifest.id);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "context.assembled",
      "context.finalized",
      "llm.request.started",
      "llm.request.payload",
      "llm.response.started",
      "llm.response.delta",
      "llm.response.completed",
      "llm.retry",
      "tool.call.started",
      "tool.call.completed",
    ]));

    const finalized = events.find((event) => event.type === "context.finalized");
    expect(finalized?.blobRef).toBeDefined();
    const snapshot = contextSnapshotSchema.parse(await store.getBlob(finalized!.blobRef!));
    expect(snapshot).toMatchObject({
      invocationName: "interpret-player-action",
      providerId: "fake-provider",
      modelId: "fake-model",
      thinkingLevel: "medium",
    });
    expect(snapshot.parts.map((part) => part.kind)).toEqual(expect.arrayContaining([
      "system.core",
      "player.utterance",
      "actor.state",
    ]));
    expect(snapshot.parts.find((part) => part.id === "player-utterance")?.logicalMessageIndexes).toEqual([0]);
    expect(snapshot.tools).toHaveLength(1);
    expect(await store.getBlob(snapshot.providerPayloadRef!)).toEqual({
      model: "fake-model",
      authorization: "[REDACTED]",
      apiKey: "[REDACTED]",
      prompt: "[REDACTED]",
    });

    const response = events.find((event) => event.type === "llm.response.completed");
    const responseBlob = await store.getBlob(response!.blobRef!);
    expect(JSON.stringify(responseBlob)).toContain("Door opened.");
    expect(JSON.stringify(responseBlob)).not.toContain("canary-hidden-reasoning");
    expect(response?.data.errorMessage).toBe("[REDACTED]");

    const persistedTrace = await readTree(store.root);
    for (const secret of [
      "canary-authorization",
      "canary-api-key",
      "canary-provider-secret",
      "canary-cookie",
      "canary-retry-secret",
      "canary-final-error-secret",
      "canary-tool-password",
      "canary-tool-credential",
      "canary-hidden-reasoning",
      "canary-signature",
    ]) {
      expect(persistedTrace).not.toContain(secret);
    }
  });

  it("redacts nested values, bearer tokens, API keys, signatures, and cycles", () => {
    const input: Record<string, unknown> = {
      nested: { access_token: "one", harmless: "Bearer canary-token" },
      api_key: "two",
      thinkingSignature: "three",
      max_tokens: 4096,
      totalTokens: 12,
      prose: "safe",
    };
    input.self = input;
    expect(redactTraceSecrets(input)).toEqual({
      nested: { access_token: "[REDACTED]", harmless: "[REDACTED]" },
      api_key: "[REDACTED]",
      thinkingSignature: "[REDACTED]",
      max_tokens: 4096,
      totalTokens: 12,
      prose: "safe",
      self: "[Circular]",
    });
  });
});

function fakeExtensionHarness() {
  const handlers = new Map<string, Array<(event: any, context: any) => unknown>>();
  const api = {
    on(name: string, handler: (event: any, context: any) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    getActiveTools() {
      return ["propose_player_action"];
    },
    getAllTools() {
      return [{
        name: "propose_player_action",
        description: "Capture one candidate.",
        parameters: { type: "object", properties: { title: { type: "string" } } },
        sourceInfo: { source: "test" },
      }];
    },
  } as any;
  return {
    api,
    async emit(name: string, event: unknown, context: unknown) {
      for (const handler of handlers.get(name) ?? []) await handler(event, context);
    },
  };
}

async function readTree(root: string): Promise<string> {
  const chunks: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else chunks.push(await fs.readFile(target, "utf8"));
    }
  };
  await visit(root);
  return chunks.join("\n");
}
