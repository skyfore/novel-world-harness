import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../world/canonical.js";
import type { ModelRequestUsage } from "../runtime/model-request-budget.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { verifyIdentitySessionEvidence, type IdentitySessionContract } from "./identity-session-integrity.js";
import { TraceStore } from "../trace/store.js";

export const identityUpstreamSessionContract = (stage: string): IdentitySessionContract => stage === "acceptance"
  ? { terminalTool: "submit_identity_upstream_acceptance", readTools: ["read_identity_upstream_acceptance"], receipt: "retained", allowCorrectedSubmission: true }
  : { terminalTool: stage === "entity" ? "propose_entity" : stage === "initial-world" ? "propose_initial_world" : "propose_entity_resolution", readTools: ["read_upstream_repair_context"], receipt: "staged", allowCorrectedSubmission: true };

/** Seal only a complete actual Pi transcript, its live message observations and
 * its unmodified request journal. An interrupted invocation is never replayed. */
export async function prepareIdentityUpstreamCheckpoint(root: string, directory: string, stage: string, input: {
  planHash: string; sessionId: string; sessionFile: string; traceRunId: string; contract: IdentitySessionContract;
  prompt: string; usage: ModelRequestUsage; providerUsage: unknown;
  transportRecoveryHash?: string;
}) {
  const [transcript, requests, messages] = await Promise.all([fs.readFile(input.sessionFile, "utf8"),
    fs.readFile(path.join(directory, `${stage}.requests.jsonl`), "utf8"), fs.readFile(path.join(directory, `${stage}.messages.jsonl`), "utf8")]);
  const submitted = messages.trimEnd().split("\n").flatMap(line => {
    const m = JSON.parse(line).message;
    return m.role === "assistant" ? m.content.filter((b: any) => b.type === "toolCall" && b.name === input.contract.terminalTool) : [];
  });
  if (!submitted.length) throw prerequisiteStop("Upstream session lacks its typed submission; retain invocation and charges, no redispatch");
  const output = submitted.at(-1).arguments;
  const proof = verifyIdentitySessionEvidence(transcript, root, { sessionId: input.sessionId, provider: "openai-codex", model: "gpt-6.1-sol", output },
    input.prompt, requests, messages, input.contract, true);
  assertRequestUsage(proof, input.usage);
  const transportRetryTraceHash = await verifyTransportRetryTrace(root, stage, input, proof);
  const checkpoint = { version: 1, status: "complete", ...input, output, transcript: proof.transcript,
    ...(transportRetryTraceHash ? { transportRetryTraceHash } : {}),
    transcriptHash: contentHash(transcript), requestsHash: contentHash(requests), messagesHash: contentHash(messages) };
  return checkpoint;
}

export async function sealIdentityUpstreamSession(root: string, directory: string, stage: string, input: Parameters<typeof prepareIdentityUpstreamCheckpoint>[3]) {
  const checkpoint = await prepareIdentityUpstreamCheckpoint(root, directory, stage, input);
  await fs.writeFile(path.join(directory, `${stage}.session-checkpoint.json`), JSON.stringify(checkpoint, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return checkpoint;
}

export async function verifyIdentityUpstreamSession(root: string, directory: string, stage: string, record: {
  planHash: string; sessionId: string; traceRunId: string; sessionCheckpointHash?: string;
}, contract: IdentitySessionContract) {
  const checkpoint = JSON.parse(await fs.readFile(path.join(directory, `${stage}.session-checkpoint.json`), "utf8"));
  const input = JSON.parse(await fs.readFile(path.join(directory, `${stage}.input.json`), "utf8"));
  const budget = JSON.parse(await fs.readFile(path.join(directory, `${stage}.budget.json`), "utf8"));
  if (!record.sessionCheckpointHash || contentHash(checkpoint) !== record.sessionCheckpointHash || checkpoint.status !== "complete"
    || checkpoint.planHash !== record.planHash || checkpoint.sessionId !== record.sessionId || checkpoint.traceRunId !== record.traceRunId
    || checkpoint.prompt !== JSON.stringify(input) || contentHash(checkpoint.contract) !== contentHash(contract)
    || contentHash(checkpoint.usage) !== contentHash(budget.state.usage) || budget.state.blocked || budget.state.failure
    || !checkpoint.sessionFile.startsWith(path.join(directory, "sessions", stage) + path.sep)
    || await fs.realpath(checkpoint.sessionFile) !== checkpoint.sessionFile)
    throw prerequisiteStop("Original upstream session checkpoint, scope or budget changed; retain it, no retry");
  const [transcript, requests, messages] = await Promise.all([fs.readFile(checkpoint.sessionFile, "utf8"),
    fs.readFile(path.join(directory, `${stage}.requests.jsonl`), "utf8"), fs.readFile(path.join(directory, `${stage}.messages.jsonl`), "utf8")]);
  if (contentHash(transcript) !== checkpoint.transcriptHash || contentHash(requests) !== checkpoint.requestsHash || contentHash(messages) !== checkpoint.messagesHash)
    throw prerequisiteStop("Original upstream transcript or actual requests changed; no replay or authority");
  const proof = verifyIdentitySessionEvidence(transcript, root, { sessionId: record.sessionId, provider: "openai-codex", model: "gpt-6.1-sol", output: checkpoint.output },
    checkpoint.prompt, requests, messages, contract, true);
  if (contentHash(proof.transcript) !== contentHash(checkpoint.transcript)
    || await verifyTransportRetryTrace(root, stage, { ...record, sessionId: record.sessionId }, proof) !== checkpoint.transportRetryTraceHash)
    throw prerequisiteStop("Upstream transcript or original transport retry proof changed; preserve the failure, no replay");
  assertRequestUsage(proof, budget.state.usage);
  if (checkpoint.transportRecoveryHash) {
    const { verifyConsumerTransportRecovery } = await import("./consumer-transport-recovery.js");
    await verifyConsumerTransportRecovery(root, directory, stage, checkpoint);
  }
  return checkpoint;
}

function assertRequestUsage(proof: ReturnType<typeof verifyIdentitySessionEvidence>, usage: ModelRequestUsage) {
  const sizes = proof.payloads.map(p => Buffer.byteLength(JSON.stringify(p)));
  if (proof.transcript.responses !== usage.modelCalls
    || sizes.length !== usage.payloads || sizes.reduce((a, b) => a + b, 0) !== usage.totalPayloadBytes
    || Math.max(...sizes, ...proof.contexts.map(c => Buffer.byteLength(JSON.stringify(c)))) !== usage.largestRequestBytes)
    throw prerequisiteStop("Upstream budget disagrees with actual Pi provider requests; preserve all charges, no retry");
}

/** Corroborate the narrowly accepted Pi omission with the original host trace.
 * No executed tool from the failed response, missing request or second retry is
 * reclassified as successful. Every provider attempt remains charged. */
async function verifyTransportRetryTrace(root: string, stage: string, input: { planHash: string; sessionId: string; traceRunId: string },
  proof: ReturnType<typeof verifyIdentitySessionEvidence>) {
  const retries = proof.transcript.transportRetries;
  if (!retries?.length) return undefined;
  const events = await new TraceStore(root).peekEvents(input.traceRunId);
  const failed = events.filter(e => e.type === "llm.response.failed"), retry = events.filter(e => e.type === "llm.retry");
  const starts = events.filter(e => e.type === "llm.request.started");
  const replies = events.filter(e => e.type === "llm.response.failed" || e.type === "llm.response.completed");
  const binding = events.filter(e => e.type === "stage.started" && e.data?.sessionId === input.sessionId
    && e.data?.phase === stage && e.data?.scopeHash === input.planHash);
  const failure = failed[0], continuation = retry[0];
  const index = starts.findIndex(e => e.callId === failure?.callId);
  if (retries.length !== 1 || failed.length !== 1 || retry.length !== 1 || binding.length !== 1
    || starts.length !== proof.transcript.responses || replies.length !== starts.length
    || failure?.data?.errorMessage !== "WebSocket closed 1006" || failure.data.stopReason !== "error"
    || failure.data.providerId !== "openai-codex" || failure.data.modelId !== "gpt-6.1-sol"
    || continuation?.data?.errorMessage !== failure.data.errorMessage || continuation.data.attempt !== 1
    || typeof continuation.data.maxAttempts !== "number" || continuation.data.maxAttempts < 1 || continuation.data.maxAttempts > 3
    || index < 0 || index !== retries[0]!.responseIndex || !starts[index + 1]
    || binding[0]!.seq >= starts[0]!.seq || new Set(starts.map(e => e.callId)).size !== starts.length
    || starts[index]!.seq >= failure.seq || failure.seq >= continuation.seq || continuation.seq >= starts[index + 1]!.seq
    || events.some(e => e.type.startsWith("tool.") && (e.callId === failure.callId
      || e.seq > starts[index]!.seq && e.seq < starts[index + 1]!.seq))
    || events.some(e => e.type === "tool.call.failed")
    || replies.some((e, i) => e.callId !== starts[i]?.callId || e.seq <= starts[i]!.seq || starts[i + 1] && e.seq >= starts[i + 1]!.seq))
    throw prerequisiteStop("Pi WebSocket retry lacks its exact original trace and unexecuted failed response; preserve all evidence, no registration or replay");
  return contentHash([...binding, ...starts, ...replies, ...retry].sort((a, b) => a.seq - b.seq));
}
