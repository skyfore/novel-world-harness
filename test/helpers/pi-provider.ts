import { createAssistantMessageEventStream, fauxAssistantMessage, fauxText, getCurrentTools,
  type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { PiAgentSession } from "../../src/agent/pi-session.js";

/** One typed bridge to the embedded runtime; tests use Pi's public session/provider APIs. */
export function piRuntime(session: PiAgentSession): AgentSessionRuntime {
  return (session as unknown as { runtimeHost: AgentSessionRuntime }).runtimeHost;
}

export async function mockPiProvider(session: PiAgentSession, options: {
  response?: (context: TranscriptContext, index: number, signal?: AbortSignal) => Promise<AssistantMessage> | AssistantMessage;
  contextWindow?: number;
} = {}) {
  const host = piRuntime(session);
  const contexts: TranscriptContext[] = [];
  const payloads: unknown[] = [];
  host.services.modelRuntime.registerProvider("nwh-test", {
    api: "nwh-test-api", apiKey: "test-only", baseUrl: "https://invalid.test",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
      contextWindow: options.contextWindow ?? 200_000, maxTokens: 1000,
      cost: { input: 10, output: 10, cacheRead: 0.1, cacheWrite: 10 },
      promptCache: { short: 30 } }],
    streamSimple(model, context, requestOptions) {
      const stream = createAssistantMessageEventStream();
      const index = contexts.push(structuredClone(context)) - 1;
      void (async () => {
        try {
          const payload = { messages: context.messages, tools: getCurrentTools(context.messages) };
          const transformed = await requestOptions?.onPayload?.(payload, model);
          payloads.push(transformed ?? payload);
          const message = options.response ? await options.response(context, index, requestOptions?.signal)
            : fauxAssistantMessage([fauxText("fixture answer")]);
          message.provider = model.provider; message.model = model.id; message.api = model.api;
          message.usage = { input: 100_000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 100_010,
            cost: { input: 1, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 1.001 } };
          stream.push({ type: "start", partial: message });
          if (message.stopReason === "error" || message.stopReason === "aborted") {
            stream.push({ type: "error", reason: message.stopReason, error: message });
          } else {
            stream.push({ type: "done", reason: message.stopReason, message });
          }
          stream.end();
        } catch (error) {
          const message = fauxAssistantMessage([]);
          message.stopReason = requestOptions?.signal?.aborted ? "aborted" : "error";
          message.errorMessage = error instanceof Error ? error.message : String(error);
          stream.push({ type: "error", reason: message.stopReason, error: message });
          stream.end();
        }
      })();
      return stream;
    },
  });
  await host.services.modelRuntime.setRuntimeApiKey("nwh-test", "test-only");
  await host.session.setModel(host.services.modelRuntime.getModel("nwh-test", "fixture")!);
  host.session.settingsManager.applyOverrides({ retry: { enabled: false }, compaction: { enabled: false } });
  return { host, contexts, payloads };
}
