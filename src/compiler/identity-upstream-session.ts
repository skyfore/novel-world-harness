import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../world/canonical.js";
import type { ModelRequestUsage } from "../runtime/model-request-budget.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { verifyIdentitySessionEvidence, type IdentitySessionContract } from "./identity-session-integrity.js";

export const identityUpstreamSessionContract = (stage: string): IdentitySessionContract => stage === "acceptance"
  ? { terminalTool: "submit_identity_upstream_acceptance", readTools: ["read_identity_upstream_acceptance"], receipt: "retained", allowCorrectedSubmission: true }
  : { terminalTool: stage === "entity" ? "propose_entity" : stage === "initial-world" ? "propose_initial_world" : "propose_entity_resolution", readTools: ["read_upstream_repair_context"], receipt: "staged", allowCorrectedSubmission: true };

/** Seal only a complete actual Pi transcript, its live message observations and
 * its unmodified request journal. An interrupted invocation is never replayed. */
export async function sealIdentityUpstreamSession(root: string, directory: string, stage: string, input: {
  planHash: string; sessionId: string; sessionFile: string; traceRunId: string; contract: IdentitySessionContract;
  prompt: string; usage: ModelRequestUsage; providerUsage: unknown;
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
    input.prompt, requests, messages, input.contract);
  const checkpoint = { version: 1, status: "complete", ...input, output, transcript: proof.transcript,
    transcriptHash: contentHash(transcript), requestsHash: contentHash(requests), messagesHash: contentHash(messages) };
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
    checkpoint.prompt, requests, messages, contract);
  const sizes = proof.payloads.map(p => Buffer.byteLength(JSON.stringify(p))), usage = budget.state.usage;
  if (contentHash(proof.transcript) !== contentHash(checkpoint.transcript) || proof.transcript.responses !== usage.modelCalls
    || sizes.length !== usage.payloads || sizes.reduce((a, b) => a + b, 0) !== usage.totalPayloadBytes
    || Math.max(...sizes, ...proof.contexts.map(c => Buffer.byteLength(JSON.stringify(c)))) !== usage.largestRequestBytes)
    throw prerequisiteStop("Upstream budget disagrees with actual Pi provider requests; preserve all charges, no retry");
  return checkpoint;
}
