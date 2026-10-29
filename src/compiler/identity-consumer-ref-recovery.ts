import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../world/canonical.js";
import { TraceStore } from "../trace/store.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { verifyRejectedIdentitySubmission, type IdentitySessionContract } from "./identity-session-integrity.js";
import { consumerEntityRepairId, consumerEntityScopeError, consumerRevalidationProposalSchema, type ConsumerRevalidationScope } from "./identity-consumer-revalidation-model.js";
import { UpstreamRepairLedger } from "./upstream-repair-ledger.js";
import { CompilerFinishReceipts } from "./finish-receipts.js";

const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
export const consumerRefRecoveryFile = (directory: string) => path.join(directory, "consumer-revalidation.ref-recovery.json");

/** Recover only the exact Pi scope rejected for an emitted entity:id spelling.
 * No model replay, normalized proposal, success receipt or world write is made.
 * All original criteria must also pass the ordinary submission validator. */
export async function inspectConsumerRefRecovery(root: string, scope: ConsumerRevalidationScope, directory: string, contract: IdentitySessionContract) {
  const stage = "consumer-revalidation", scopeHash = contentHash(scope), names = await fs.readdir(directory);
  const failed = names.filter(n => n.startsWith(`${stage}.failure-submit-`) && n.endsWith(".json"));
  if (!scope.compilerCorrection || failed.length !== 1 || names.includes(`${stage}.session-checkpoint.json`)
    || names.some(n => n.endsWith(".tmp") || n.endsWith(".pending")))
    throw prerequisiteStop("Rejected-ref recovery requires one settled compiler-correction submission with no successful checkpoint; preserve the original stage, no retry");
  const [failure, rejected, input, invocation, budget] = await Promise.all([
    `${stage}.failure.json`, failed[0]!, `${stage}.input.json`, `${stage}.invocation.json`, `${stage}.budget.json`,
  ].map(n => read(path.join(directory, n))));
  const error = prerequisiteStop(consumerEntityScopeError), output = consumerRevalidationProposalSchema.parse(rejected.raw);
  const entity = output.entityRepair, id = entity && consumerEntityRepairId(entity.ref);
  if (failure.reason !== String(error) || rejected.reason !== String(error) || contentHash(output) !== contentHash(rejected.raw)
    || !id || entity?.ref !== `entity:${id}` || output.scopeHash !== scopeHash || output.ref !== scope.ref
    || invocation.scopeHash !== scopeHash || invocation.stage !== stage || !invocation.continuationHash
    || budget.scopeHash !== scopeHash || budget.stage !== stage || budget.originalBudgetHash !== scope.originalBudgetHash
    || budget.state.blocked || budget.state.failure || contentHash(failure.usage.usage) !== contentHash(budget.state.usage)
    || invocation.budgetAmendmentHash !== budget.budgetAmendmentHash
    || !input.artifactReadRefs?.some((r: { ref: string; revisionHash: string; current: boolean }) => r.ref === entity.ref && r.current && r.revisionHash === entity.revisionHash))
    throw prerequisiteStop("Rejected scope is not the exact discovered entity/ref-format failure; preserve the real failure, no normalization or retry");
  const upstream = (await new UpstreamRepairLedger(root, scope.sourceId).inspect()).plans.find(p => p.plan.planHash === scope.upstreamPlanHash);
  const receipt = upstream && await new CompilerFinishReceipts(root, scope.sourceId, upstream.plan.batchId).read();
  if (!receipt || receipt.state !== "completed" || receipt.fingerprint !== scope.receiptFingerprint
    || !receipt.identity.upstreamRepairIntent?.proposals.some(p => p.artifactKind === "entity" && p.artifactId === id && p.payloadHash === entity.revisionHash))
    throw prerequisiteStop("Rejected entity is not the exact original accepted receipt dependency; no ref recovery or expanded scope");
  if (typeof failure.sessionFile !== "string" || !failure.sessionFile.startsWith(path.join(directory, "sessions", stage) + path.sep)
    || await fs.realpath(failure.sessionFile) !== failure.sessionFile)
    throw prerequisiteStop("Rejected submission lost its original Pi session; no recovery or guessed session");
  const [transcript, requests, messages] = await Promise.all([fs.readFile(failure.sessionFile, "utf8"),
    fs.readFile(path.join(directory, `${stage}.requests.jsonl`), "utf8"), fs.readFile(path.join(directory, `${stage}.messages.jsonl`), "utf8")]);
  const proof = verifyRejectedIdentitySubmission(transcript, root, { sessionId: failure.sessionId, provider: "openai-codex", model: "gpt-6.1-sol", output },
    JSON.stringify(input), requests, messages, contract, error.message);
  const sizes = proof.payloads.map(p => Buffer.byteLength(JSON.stringify(p))), usage = budget.state.usage;
  if (proof.transcript.responses !== usage.modelCalls || sizes.length !== usage.payloads || sizes.reduce((a, b) => a + b, 0) !== usage.totalPayloadBytes
    || Math.max(...sizes, ...proof.contexts.map(c => Buffer.byteLength(JSON.stringify(c)))) !== usage.largestRequestBytes)
    throw prerequisiteStop("Rejected submission charges disagree with its actual Pi requests; no recovery or charge reset");
  const traces = new TraceStore(root), runs = await traces.peekRunsByOperation(scope.sourceId,
    `receipt-bound-${scopeHash}-${stage}-continuation`), run = runs[0];
  if (runs.length !== 1 || !run || run.status !== "failed" || !run.endedAt)
    throw prerequisiteStop("Rejected submission trace is missing, ambiguous or unsettled; inspect its original owner, no recovery");
  const events = await traces.peekEvents(run.id), starts = events.filter(e => e.type === "tool.call.started" && e.data?.toolName === contract.terminalTool);
  const failures = events.filter(e => e.type === "tool.call.failed");
  const requestsStarted = events.filter(e => e.type === "llm.request.started"), stopped = events.filter(e => e.type === "llm.response.failed");
  const hostStopped = proof.messages.at(-1)?.role === "assistant";
  if (starts.length !== 1 || !starts[0]!.blobRef || contentHash(await traces.peekBlob(starts[0]!.blobRef)) !== contentHash(output)
    || failures.length !== 1 || failures[0]!.toolCallId !== starts[0]!.toolCallId
    || events.some(e => e.type.startsWith("world.commit.")) || requestsStarted.length !== usage.modelCalls || run.counts.llmRequests !== usage.modelCalls
    || requestsStarted.some(r => !events.some(e => e.type === "llm.response.completed" && e.callId === r.callId && e.seq > r.seq))
    || stopped.length !== (hostStopped ? 1 : 0) || stopped.some(e => e.seq <= failures[0]!.seq || e.data?.errorMessage !== error.message
      || e.data?.providerId !== "openai-codex" || e.data?.modelId !== "gpt-6.1-sol"
      || Object.values(e.data?.usage ?? {}).some(n => n !== 0) || requestsStarted.some(r => r.callId === e.callId))
    || !events.some(e => e.type === "stage.started" && e.data?.sessionId === failure.sessionId && e.data?.inputHash === contentHash(input)))
    throw prerequisiteStop("Rejected submission is detached from its sole failed tool call and original Pi input; no recovery");
  const sourceRead = new Set<string>(), artifactsRead = new Set<string>(), calls = new Map<string, { collection?: string; segmentIds?: string[]; refs?: string[] }>();
  let consumerRead = false;
  const dependencies = new Map<string, { kind: string; revisionHash: string; current: boolean }>();
  for (const message of proof.messages) {
    if (message.role === "assistant") for (const c of message.content) if (c.type === "toolCall") calls.set(c.id, c.arguments);
    if (message.role !== "toolResult" || message.isError) continue;
    const args = calls.get(message.toolCallId)!;
    const value = JSON.parse(message.content.filter(b => b.type === "text").map(b => b.text).join(""));
    if (args.collection === "source" && args.segmentIds) for (const id of args.segmentIds) {
      if (!value.segments?.some((s: { id: string; complete: boolean }) => s.id === id && s.complete)) throw prerequisiteStop("Rejected proposal source read was incomplete; no recovery");
      sourceRead.add(id);
    }
    if (args.collection === "consumer" && args.refs?.length === 1 && args.refs[0] === scope.ref
      && value.items?.[0]?.ref === scope.ref && contentHash(value.items[0].current.payload) === scope.currentRevisionHash) consumerRead = true;
    if (args.collection === "artifacts" && args.refs) for (const ref of args.refs) {
      const item = value.items?.find((r: { kind: string; id: string }) => ref === `${r.kind}:${r.id}` || ref === `${r.kind}/${r.id}`);
      if (!item || item.revisionHash !== contentHash(item.payload)) throw prerequisiteStop("Rejected proposal dependency read lost its exact payload; no recovery");
      const key = `${item.kind}:${item.id}`; artifactsRead.add(key); dependencies.set(key, item);
    }
  }
  for (const repair of [output.entityRepair, output.initialWorldRepair]) if (repair && (repair.segmentIds.some(id => !sourceRead.has(id))
    || repair.readableRefs.some(r => { const d = dependencies.get(`${r.kind}:${r.id}`); return !d || d.revisionHash !== r.revisionHash || !(d.current || d.kind === "entity-resolution"); })))
    throw prerequisiteStop("Rejected scope omitted a selected source or exact dependency read; no ref recovery");
  if (!consumerRead || input.requiredSourceSegmentIds.some((id: string) => !sourceRead.has(id))
    || input.continuation.pendingArtifactRefs.some((ref: string) => !artifactsRead.has(ref)))
    throw prerequisiteStop("Rejected scope omitted original full evidence reads; no ref recovery");
  const retainedNames = [...names.filter(n => n !== "sessions" && ![`${stage}.proposal.json`, `${stage}.record.json`, `${stage}.ref-recovery.json`].includes(n)),
    path.relative(directory, failure.sessionFile)].sort();
  const retainedFiles = await Promise.all(retainedNames.map(async name => {
    const file = path.join(directory, name);
    if (await fs.realpath(file) !== file || !(await fs.stat(file)).isFile()) throw prerequisiteStop("Rejected-ref recovery contains unexpected retained files; no recovery");
    return { path: name, hash: contentHash(await fs.readFile(file, "utf8")) };
  }));
  const recovery = { version: 1, policy: "consumer-discovered-entity-ref-recovery/v1", scopeHash,
    continuationHash: invocation.continuationHash, ...(invocation.budgetAmendmentHash ? { budgetAmendmentHash: invocation.budgetAmendmentHash } : {}),
    inputHash: contentHash(input), output, sessionId: failure.sessionId, traceRunId: run.id, contractHash: contentHash(contract),
    traceHash: contentHash({ run, events }), retainedFiles, usage, providerCalls: 0, worldWrites: 0,
    originalTraceStatus: "failed", independentCheckRequired: true, parentResumeAllowed: false, certificationGranted: false };
  return { recovery, sourceRead, artifactsRead, consumerRead };
}

export async function verifyConsumerRefRecovery(root: string, scope: ConsumerRevalidationScope, directory: string, contract: IdentitySessionContract, expectedHash: string) {
  const saved = await read(consumerRefRecoveryFile(directory)), { recovery } = await inspectConsumerRefRecovery(root, scope, directory, contract);
  if (contentHash(saved) !== expectedHash || contentHash(recovery) !== expectedHash)
    throw prerequisiteStop("Rejected-ref recovery changed the original failed session or proposal; preserve both records, no retry");
  return recovery;
}
