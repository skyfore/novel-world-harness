import { contentHash } from "../world/canonical.js";

type Message = { role: string; content?: unknown; toolName?: string; toolCallId?: string; isError?: boolean };

/** Count actual tool results, including SDK rejections before execute(). A
 * persisted transcript carries the allowance across validation and sealing. */
export function assertReviewPreviewAllowance(messages: readonly Message[], options: {
  previewTool: string; terminalTool: string; correctionsRemaining: number;
  matchesScope: (args: Record<string, unknown>) => boolean;
  stop: (reason: string) => Error;
}) {
  const calls = new Map<string, Record<string, unknown>>(), failedArguments = new Set<string>();
  let failures = 0;
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const call of message.content) if (call?.type === "toolCall" && call.arguments && typeof call.arguments === "object")
        calls.set(call.id, call.arguments);
    }
    if (message.role !== "toolResult" || !message.isError) continue;
    if (message.toolName === options.terminalTool) throw options.stop("Bound terminal submission failed; no repeated submission");
    if (message.toolName !== options.previewTool) continue;
    const args = calls.get(message.toolCallId ?? "");
    if (!args || !options.matchesScope(args)) throw options.stop("Preview changed its original scope or checked proposal");
    const argumentHash = contentHash(args);
    if (failedArguments.has(argumentHash) || ++failures > options.correctionsRemaining)
      throw options.stop("Original preview correction allowance exhausted");
    failedArguments.add(argumentHash);
  }
}
