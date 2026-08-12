export type CompilerBatchOutcome = {
  assistantStopReason?: string;
  proposalSucceeded: number;
  proposalFailed: number;
  completionSignaled: boolean;
  completionOutcome?: "complete" | "no-artifacts";
};

export function isCompilerProposalTool(toolName: string): boolean {
  return toolName.startsWith("propose_");
}

export function compilerBatchOutcomeFromMessages(messages: readonly unknown[]): CompilerBatchOutcome {
  const calls = new Map<string, { toolName: string; proposalId?: string; finishOutcome?: "complete" | "no-artifacts" }>();
  const failed = new Set<string>();
  const succeeded = new Set<string>();
  let assistantStopReason: string | undefined;
  let completionOutcome: "complete" | "no-artifacts" | undefined;

  for (const value of messages) {
    if (!value || typeof value !== "object") continue;
    const message = value as Record<string, unknown>;
    if (message.role === "assistant") {
      if (typeof message.stopReason === "string") assistantStopReason = message.stopReason;
      if (!Array.isArray(message.content)) continue;
      for (const contentValue of message.content) {
        if (!contentValue || typeof contentValue !== "object") continue;
        const content = contentValue as Record<string, unknown>;
        if (
          content.type !== "toolCall" ||
          typeof content.id !== "string" ||
          typeof content.name !== "string" ||
          !isCompilerProposalTool(content.name) && content.name !== "finish_compiler_batch"
        ) continue;
        const args = content.arguments;
        if (content.name === "finish_compiler_batch") {
          const outcome = finishOutcome(args);
          calls.set(content.id, outcome ? { toolName: content.name, finishOutcome: outcome } : { toolName: content.name });
        } else {
          const proposalId = proposalIdentity(content.name, args);
          calls.set(content.id, proposalId ? { toolName: content.name, proposalId } : { toolName: content.name });
        }
      }
      continue;
    }
    if (message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    const call = calls.get(message.toolCallId);
    const toolName = call?.toolName ?? (typeof message.toolName === "string" ? message.toolName : "");
    if (toolName === "finish_compiler_batch") {
      if (message.isError !== true && call?.finishOutcome) completionOutcome = call.finishOutcome;
      continue;
    }
    if (!isCompilerProposalTool(toolName)) continue;
    const key = call?.proposalId ? `${toolName}:${call.proposalId}` : `call:${message.toolCallId}`;
    if (message.isError === true) failed.add(key);
    else {
      failed.delete(key);
      succeeded.add(key);
    }
  }

  return {
    assistantStopReason,
    proposalSucceeded: succeeded.size,
    proposalFailed: failed.size,
    completionSignaled: completionOutcome !== undefined,
    ...(completionOutcome ? { completionOutcome } : {}),
  };
}

function finishOutcome(argsValue: unknown): "complete" | "no-artifacts" | undefined {
  if (!argsValue || typeof argsValue !== "object" || Array.isArray(argsValue)) return undefined;
  const outcome = (argsValue as Record<string, unknown>).outcome;
  return outcome === "complete" || outcome === "no-artifacts" ? outcome : undefined;
}

function proposalIdentity(toolName: string, argsValue: unknown): string | undefined {
  if (!argsValue || typeof argsValue !== "object" || Array.isArray(argsValue)) return undefined;
  const args = argsValue as Record<string, unknown>;
  // The envelope ID is the durable identity recorded by ProposalStore and the
  // value acknowledged by finish_compiler_batch. Prefer it even when a failed
  // provider call supplied an unreadable/stringified payload so a corrected
  // retry of that same proposal can resolve the earlier tool error.
  if (typeof args.proposal_id === "string") return `envelope:${args.proposal_id}`;
  let payload = args.payload;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload) as unknown; }
    catch { payload = undefined; }
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (typeof record.id === "string") return `artifact:${record.id}`;
    if (toolName === "propose_character_model" && typeof record.actorId === "string") return `actor:${record.actorId}`;
    if (toolName === "propose_initial_world") return "singleton:initial-world";
  }
  return undefined;
}

export function compilerBatchFailure(outcome: CompilerBatchOutcome): string | undefined {
  if (outcome.assistantStopReason !== "stop") {
    return `model ended with ${outcome.assistantStopReason ?? "no final assistant response"}`;
  }
  if (outcome.proposalFailed > 0) {
    return `${outcome.proposalFailed} proposal tool call(s) failed`;
  }
  if (!outcome.completionSignaled) {
    return "the model did not explicitly finish the compiler batch";
  }
  if (outcome.completionOutcome === "complete" && outcome.proposalSucceeded === 0) {
    return "the model declared completion without a valid typed proposal";
  }
  if (outcome.completionOutcome === "no-artifacts" && outcome.proposalSucceeded > 0) {
    return "the model declared no artifacts after recording proposals";
  }
  return undefined;
}
