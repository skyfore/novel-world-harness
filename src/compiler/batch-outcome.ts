export type CompilerBatchOutcome = {
  assistantStopReason?: string;
  assistantErrorMessage?: string;
  proposalSucceeded: number;
  proposalFailed: number;
  completionSignaled: boolean;
  completionOutcome?: "complete" | "no-artifacts";
  blockedReason?: string;
  /** Compiler mutation/control calls that never received a tool result and were not superseded by a verified retry. */
  unresolvedToolCalls?: number;
};

export function isCompilerProposalTool(toolName: string): boolean {
  return toolName.startsWith("propose_");
}

export function compilerBatchOutcomeFromMessages(messages: readonly unknown[]): CompilerBatchOutcome {
  const calls = new Map<string, { toolName: string; proposalId?: string; withdrawnProposalId?: string; finishOutcome?: "complete" | "no-artifacts" }>();
  const failed = new Set<string>();
  const succeeded = new Set<string>();
  const withdrawn = new Set<string>();
  const resultCallIds = new Set<string>();
  let assistantStopReason: string | undefined;
  let assistantErrorMessage: string | undefined;
  let completionOutcome: "complete" | "no-artifacts" | undefined;
  let blockedReason: string | undefined;

  for (const value of messages) {
    if (!value || typeof value !== "object") continue;
    const message = value as Record<string, unknown>;
    if (message.role === "assistant") {
      if (typeof message.stopReason === "string") {
        assistantStopReason = message.stopReason;
        assistantErrorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
      }
      if (!Array.isArray(message.content)) continue;
      for (const contentValue of message.content) {
        if (!contentValue || typeof contentValue !== "object") continue;
        const content = contentValue as Record<string, unknown>;
        if (
          content.type !== "toolCall" ||
          typeof content.id !== "string" ||
          typeof content.name !== "string" ||
          !isCompilerProposalTool(content.name)
            && content.name !== "withdraw_compiler_proposal"
            && content.name !== "finish_compiler_batch"
        ) continue;
        const args = content.arguments;
        if (content.name === "finish_compiler_batch") {
          const outcome = finishOutcome(args);
          calls.set(content.id, outcome ? { toolName: content.name, finishOutcome: outcome } : { toolName: content.name });
        } else if (content.name === "withdraw_compiler_proposal") {
          const withdrawnProposalId = proposalEnvelopeIdentity(args);
          calls.set(content.id, withdrawnProposalId ? { toolName: content.name, withdrawnProposalId } : { toolName: content.name });
        } else {
          const proposalId = proposalIdentity(content.name, args);
          calls.set(content.id, proposalId ? { toolName: content.name, proposalId } : { toolName: content.name });
        }
      }
      continue;
    }
    if (message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    resultCallIds.add(message.toolCallId);
    const call = calls.get(message.toolCallId);
    const toolName = call?.toolName ?? (typeof message.toolName === "string" ? message.toolName : "");
    const details = message.details && typeof message.details === "object" && !Array.isArray(message.details)
      ? message.details as Record<string, unknown>
      : undefined;
    if (details?.compilerBatchBlocked === true) {
      blockedReason = typeof details.reason === "string" ? details.reason : "compiler circuit breaker opened";
      continue;
    }
    if (toolName === "finish_compiler_batch") {
      if (message.isError !== true && call?.finishOutcome) {
        completionOutcome = call.finishOutcome;
        if (Array.isArray(details?.proposalIds)) {
          for (const proposalId of details.proposalIds) {
            if (typeof proposalId !== "string") continue;
            const suffix = `:envelope:${proposalId}`;
            if (![...succeeded].some((key) => key.endsWith(suffix))) succeeded.add(`finish:envelope:${proposalId}`);
          }
        }
      }
      continue;
    }
    if (toolName === "withdraw_compiler_proposal") {
      if (message.isError !== true && call?.withdrawnProposalId) {
        withdrawn.add(call.withdrawnProposalId);
        for (const key of succeeded) {
          if (key.endsWith(`:${call.withdrawnProposalId}`)) succeeded.delete(key);
        }
      }
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

  let unresolvedToolCalls = 0;
  for (const [toolCallId, call] of calls) {
    if (resultCallIds.has(toolCallId)) continue;
    if (call.proposalId) {
      const proposalRecovered = [...succeeded].some((key) => key.endsWith(`:${call.proposalId}`))
        || withdrawn.has(call.proposalId);
      if (proposalRecovered) continue;
    }
    if (call.finishOutcome && completionOutcome !== undefined) continue;
    if (call.withdrawnProposalId && withdrawn.has(call.withdrawnProposalId)) continue;
    unresolvedToolCalls += 1;
  }

  return {
    assistantStopReason,
    ...(assistantErrorMessage ? { assistantErrorMessage } : {}),
    proposalSucceeded: succeeded.size,
    proposalFailed: failed.size,
    completionSignaled: completionOutcome !== undefined,
    ...(completionOutcome ? { completionOutcome } : {}),
    ...(blockedReason ? { blockedReason } : {}),
    ...(unresolvedToolCalls ? { unresolvedToolCalls } : {}),
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

function proposalEnvelopeIdentity(argsValue: unknown): string | undefined {
  if (!argsValue || typeof argsValue !== "object" || Array.isArray(argsValue)) return undefined;
  const proposalId = (argsValue as Record<string, unknown>).proposal_id;
  return typeof proposalId === "string" ? `envelope:${proposalId}` : undefined;
}

export function compilerBatchFailure(outcome: CompilerBatchOutcome): string | undefined {
  if (outcome.blockedReason) return `compiler circuit breaker stopped the batch: ${outcome.blockedReason}`;
  if (outcome.assistantStopReason !== "stop") {
    const detail = outcome.assistantErrorMessage ? `: ${outcome.assistantErrorMessage}` : "";
    return `model ended with ${outcome.assistantStopReason ?? "no final assistant response"}${detail}`;
  }
  if (outcome.unresolvedToolCalls) {
    return `${outcome.unresolvedToolCalls} compiler tool call(s) ended without a tool result`;
  }
  if (!outcome.completionSignaled) {
    if (outcome.proposalFailed > 0) return `${outcome.proposalFailed} proposal tool call(s) failed`;
    return "the model did not explicitly finish the compiler batch";
  }
  if (outcome.completionOutcome === "complete" && outcome.proposalSucceeded === 0) {
    return "the model declared completion without a valid typed proposal";
  }
  if (outcome.completionOutcome === "no-artifacts" && outcome.proposalSucceeded > 0) {
    return "the model declared no artifacts after recording proposals";
  }
  if (outcome.completionOutcome === "no-artifacts" && outcome.proposalFailed > 0) {
    return `${outcome.proposalFailed} proposal tool call(s) failed before the model declared no artifacts`;
  }
  return undefined;
}

export function isRecoverableCompilerBatchInterruption(outcome: CompilerBatchOutcome): boolean {
  if (outcome.blockedReason) {
    // The tool-call breaker protects one model turn, not the immutable batch.
    // A fresh turn can hydrate the exact active drafts, reset the per-turn
    // counter, and continue from deterministic closure diagnostics. Other
    // circuit-breaker causes (for example repeated identical finish failures)
    // indicate a semantic loop and must remain terminal.
    return outcome.blockedReason.startsWith("compiler tool-call safety fuse tripped")
      || outcome.blockedReason.startsWith("compiler tool-call budget exceeded");
  }
  return outcome.assistantStopReason === "error" || Boolean(outcome.unresolvedToolCalls);
}
