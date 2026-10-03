import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeContext, type Context, type Tool } from "@earendil-works/pi-ai";
import type { AgentSession, Extension, ExtensionFactory, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { registerNwhContextProjection } from "./context-projection.js";
import { assertNwhContextEdits } from "./context-policy.js";

const dispatchScope = new AsyncLocalStorage<{ consumed: boolean; check: () => void }>();
const guardedRuntimes = new WeakSet<ModelRuntime>();
const criticalEvents = new Set(["before_agent_start", "context", "context_with_system", "session_before_compact", "session_before_tree", "cache_warming_decision"]);

function stop(reason: string): never {
  throw new Error(`NWH request policy stopped dispatch: ${reason}. Preserve this session for host review; do not retry or bypass the policy.`);
}

/** Deny calls that bypass the foreground/summary guard, including Pi cache timers. */
function guardRuntime(runtime: ModelRuntime): void {
  if (guardedRuntimes.has(runtime)) return;
  const stream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => {
    const token = dispatchScope.getStore();
    if (!token || token.consumed) stop("request was not authorized by the session boundary");
    token.check();
    token.consumed = true;
    return stream(model, context, options);
  };
  guardedRuntimes.add(runtime);
}

export function createNwhRequestPolicy(options: {
  redact: (text: string) => string;
  includeNwhExtension: boolean;
  allowedToolNames: ReadonlySet<string>;
}) {
  let prompt: string | undefined;
  let failure: string | undefined;
  let expectedHandlers: Map<string, Extension["handlers"]> | undefined;
  let connectErrors: (() => void) | undefined;
  const stopWarming = async () => ({ action: "stop" as const });
  const factory: ExtensionFactory = pi => {
    expectedHandlers = undefined;
    pi.on("cache_warming_decision", stopWarming);
    pi.on("session_start", () => connectErrors?.());
    pi.on("before_agent_start", event => { prompt = options.redact(event.systemPrompt); });
    if (!options.includeNwhExtension) registerNwhContextProjection(pi);
    pi.on("context_with_system", (event, ctx) => {
      try {
        const active = new Set(pi.getActiveTools());
        const tools = pi.getAllTools().filter(tool => active.has(tool.name));
        for (const tool of tools) if (!options.allowedToolNames.has(tool.name)) stop("tool outside the host allowlist");
        // Persisted prompt/tool deltas are transport history, not current scope.
        // Rebuild the head from this turn's trusted prompt and live tool loadout.
        return { messages: [{
          role: "system" as const,
          content: prompt ?? options.redact(ctx.getSystemPrompt()),
          toolsAdded: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
          timestamp: Date.now(),
        }, ...event.messages.filter(message => message.role !== "system")] };
      } catch (error) {
        failure = error instanceof Error ? error.message : "context projection failed";
        throw error;
      }
    });
  };

  function install(session: AgentSession, runtime: ModelRuntime): void {
    guardRuntime(runtime);
    let observedRunner: AgentSession["extensionRunner"] | undefined;
    let unsubscribe: (() => void) | undefined;
    connectErrors = () => {
      if (observedRunner === session.extensionRunner) return;
      unsubscribe?.();
      observedRunner = session.extensionRunner;
      unsubscribe = observedRunner.onError(error => {
        if (criticalEvents.has(error.event)) failure = `trusted ${error.event} handler failed`;
      });
    };
    const check = () => {
      connectErrors!();
      if (failure) stop(failure);
      assertNwhContextEdits(session.sessionManager.getBranch());
      const loaded = session.resourceLoader.getExtensions();
      if (loaded.errors.length) stop("trusted extension loading failed");
      const known = new Set(["nwh-hooks", "nwh-tool-recovery", "nwh-prompt-privacy", "nwh-request-policy", "nwh-trace",
        ...(options.includeNwhExtension ? ["nwh"] : [])].map(name => `<inline:${name}>`));
      if (loaded.extensions.some(extension => !known.has(extension.path))) stop("unexpected extension loaded");
      const policy = loaded.extensions.find(extension => extension.path === "<inline:nwh-request-policy>");
      if (!policy?.handlers.get("cache_warming_decision")?.length
        || !policy.handlers.get("context_with_system")?.length) stop("required request policy is missing");
      const projection = options.includeNwhExtension
        ? loaded.extensions.find(extension => extension.path === "<inline:nwh>") : policy;
      for (const event of ["context", "session_before_compact", "session_before_tree"]) {
        if (!projection?.handlers.get(event)?.length) stop(`required ${event} projection is missing`);
      }
      if (!expectedHandlers) expectedHandlers = new Map(loaded.extensions.map(extension => [extension.path,
        new Map([...extension.handlers].filter(([event]) => criticalEvents.has(event)).map(([event, handlers]) => [event, [...handlers]]))]));
      for (const extension of loaded.extensions) {
        for (const [event, handlers] of expectedHandlers.get(extension.path) ?? []) {
          const actual = extension.handlers.get(event);
          if (!actual || actual.length !== handlers.length || actual.some((handler, index) => handler !== handlers[index])) {
            stop(`trusted ${event} handlers changed without reload`);
          }
        }
      }
      for (const name of session.getActiveToolNames()) {
        if (!options.allowedToolNames.has(name)) stop("active tool outside the host allowlist");
      }
    };
    const assertTools = (tools: readonly Pick<Tool, "name">[]) => {
      const active = new Set(session.getActiveToolNames());
      for (const tool of tools) {
        if (!active.has(tool.name) || !options.allowedToolNames.has(tool.name)) stop("request declares a tool outside the active scope");
      }
    };
    const checkPayload = (payload: unknown) => {
      check();
      const encoded = JSON.stringify(payload);
      if (options.redact(encoded) !== encoded) stop("provider payload contains a host workspace path");
      if (payload && typeof payload === "object" && "tools" in payload && Array.isArray(payload.tools)) {
        for (const tool of payload.tools) {
          const declarations = tool.functionDeclarations ?? [tool.function ?? tool];
          assertTools(declarations);
        }
      }
      return payload;
    };
    const onPayload = session.agent.onPayload;
    session.agent.onPayload = async (payload, model) => {
      const transformed = await onPayload?.(payload, model);
      return checkPayload(transformed === undefined ? payload : transformed);
    };
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = (model, context, requestOptions) => {
      check();
      const normalized = normalizeContext(context as Context);
      for (const message of normalized.messages) {
        if (message.role === "system") assertTools(message.toolsAdded ?? []);
      }
      const clean = { messages: normalized.messages.map(message => message.role !== "system" ? message : {
        ...message,
        content: typeof message.content === "string" ? options.redact(message.content)
          : message.content.map(block => ({ ...block, text: options.redact(block.text) })),
        ...(message.sections ? { sections: Object.fromEntries(Object.entries(message.sections)
          .map(([name, text]) => [name, text === null ? null : options.redact(text)])) } : {}),
      }) };
      return dispatchScope.run({ consumed: false, check }, () => stream(model, normalizeContext(clean), {
        ...requestOptions,
        onPayload: async (payload, requestModel) => {
          const transformed = await requestOptions?.onPayload?.(payload, requestModel);
          return checkPayload(transformed === undefined ? payload : transformed);
        },
      }));
    };
    const beforeToolCall = session.agent.beforeToolCall;
    session.agent.beforeToolCall = async (context, signal) => {
      check();
      if (!session.getActiveToolNames().includes(context.toolCall.name)) {
        return { block: true, reason: "Tool is outside the active NWH scope. Stop for host review; do not retry through a nested tool call." };
      }
      return beforeToolCall?.(context, signal);
    };
    check();
  }
  return { factory, install };
}
