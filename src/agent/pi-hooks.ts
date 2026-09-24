import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { currentRuntimeHooks, type RuntimeHooks, type RuntimeHookStatus } from "../runtime/hooks.js";

/** Pi's settled event includes automatic retries and queued continuation, unlike agent_end. */
export function createPiHooksExtension(hooks: RuntimeHooks, workspaceRoot: string): ExtensionFactory {
  return (pi) => {
    let active = false;
    let started = 0;
    let status: RuntimeHookStatus = "succeeded";
    let error: { name: string; message: string } | undefined;
    pi.on("agent_start", () => {
      if (!active) { active = true; started = performance.now(); status = "succeeded"; error = undefined; }
    });
    pi.on("message_end", async (event, ctx) => {
      if (event.message.role !== "assistant") return;
      const message = event.message;
      status = message.stopReason === "aborted" ? "cancelled" : message.stopReason === "error" ? "failed" : "succeeded";
      error = status === "succeeded" ? undefined : { name: "ModelError", message: message.errorMessage ?? `Model request ${message.stopReason}.` };
      await hooks.emit({ type: "llm.response", name: `${message.provider}/${message.model}`, status, error,
        metadata: { workspaceRoot, sessionId: ctx.sessionManager?.getSessionId?.(), stopReason: message.stopReason } });
    });
    pi.on("tool_execution_end", async (event, ctx) => {
      await hooks.emit({ type: "tool", name: event.toolName, status: event.isError ? "failed" : "succeeded",
        metadata: { workspaceRoot, sessionId: ctx.sessionManager?.getSessionId?.(), toolCallId: event.toolCallId } });
    });
    pi.on("agent_settled", async (_event, ctx) => {
      if (!active) return;
      active = false;
      await hooks.emit({ type: "session.turn", name: "pi.agent", status, error, durationMs: performance.now() - started,
        metadata: { workspaceRoot, sessionId: ctx.sessionManager?.getSessionId?.() } });
    });
  };
}

/** Observe actual slash command handlers without replacing Pi's command routing. */
export function withCommandHooks(pi: ExtensionAPI, workspaceRoot: string): ExtensionAPI {
  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property !== "registerCommand") return Reflect.get(target, property, receiver);
      return ((name, command) => target.registerCommand(name, {
        ...command,
        handler: (args, ctx) => currentRuntimeHooks().run("command", `/${name}`,
          { workspaceRoot, sessionId: ctx.sessionManager?.getSessionId?.() }, () => command.handler(args, ctx)),
      })) satisfies ExtensionAPI["registerCommand"];
    },
  });
}
