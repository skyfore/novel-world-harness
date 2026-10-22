import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../world/canonical.js";
import { TraceStore } from "../trace/store.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { RequirementLedger } from "./requirement-ledger.js";
import { identityOutputSchema, identityRequirementDirectory, identityRecordDirectory, identitySelectors, IDENTITY_REQUIREMENT_LIMITS, validateIdentityOutput, type IdentityRecord } from "./identity-requirements.js";
import { prepareIdentityRequirements, type PreparedIdentityRequirements } from "./identity-requirement-service.js";
import { identityStageInput, identityPromptInput } from "../workflow/identity-requirements.js";
import { resolveTextSelectorAnchor } from "./text-anchors.js";
import type { ModelRequestUsage } from "../runtime/model-request-budget.js";
import { verifyIdentitySession } from "./identity-session-integrity.js";
import { verifyIdentityRecoveryHostReceipt, type IdentityRecoveryPermit } from "../runtime/compile-loop/identity-recovery-host.js";
import { redactTraceSecrets } from "../trace/redaction.js";

/** beginCall measures the logical context; admitPayload measures the transport
 * JSON. largestRequestBytes is the maximum of BOTH, while totalPayloadBytes
 * counts only admitted transport payloads. The durable context maximum may be
 * larger than every trace payload; it must still cover them and obey the cap. */
export function identityRequestUsageMatches(usage: ModelRequestUsage, payloadBytes: number[], requests: number): boolean {
  return Object.values(usage).every(v => Number.isSafeInteger(v) && v >= 0)
    && requests > 0 && requests <= IDENTITY_REQUIREMENT_LIMITS.maxModelCalls
    && usage.modelCalls === requests && usage.payloads === requests && payloadBytes.length === requests
    && payloadBytes.every(v => Number.isSafeInteger(v) && v >= 0)
    && usage.totalPayloadBytes === payloadBytes.reduce((n, v) => n + v, 0)
    && usage.totalPayloadBytes <= IDENTITY_REQUIREMENT_LIMITS.maxTotalPayloadBytes
    && usage.largestRequestBytes >= Math.max(...payloadBytes)
    && usage.largestRequestBytes <= IDENTITY_REQUIREMENT_LIMITS.maxRequestBytes;
}

export function identityRecoveredUsageMatches(usage: ModelRequestUsage, inherited: ModelRequestUsage, payloadBytes: number[], requests: number) {
  return usage.modelCalls <= IDENTITY_REQUIREMENT_LIMITS.maxModelCalls && usage.totalPayloadBytes <= IDENTITY_REQUIREMENT_LIMITS.maxTotalPayloadBytes
    && usage.largestRequestBytes >= inherited.largestRequestBytes
    && identityRequestUsageMatches({ modelCalls: usage.modelCalls - inherited.modelCalls,
      payloads: usage.payloads - inherited.payloads, totalPayloadBytes: usage.totalPayloadBytes - inherited.totalPayloadBytes,
      largestRequestBytes: usage.largestRequestBytes }, payloadBytes, requests);
}

/** Checks actual read-only Pi calls, independently reconstructed inputs and exact
 * cumulative billing. A successful model label or copied proposal is insufficient. */
export async function verifyIdentityRecord(root: string, record: IdentityRecord, previous: IdentityRecord[], supplied?: PreparedIdentityRequirements,
  recoveryPermit?: IdentityRecoveryPermit) {
  const { intent, phase, stage } = record, dir = identityRecordDirectory(root, record);
  const originalDirectory = identityRequirementDirectory(root, intent.sourceId, intent.taskId);
  const read = async (name: string) => JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
  const review = (await new RequirementLedger(root, intent.sourceId).roleDependencyReviews()).find(r => r.taskId === intent.taskId);
  if (!review) throw prerequisiteStop("Independent identity record lost original denominator revision");
  const p = supplied ?? await prepareIdentityRequirements(root, { scope: review.scope, upstreamPlanHash: review.upstream.planHash, authorizationRef: review.authorizationRef }, intent.authorizationRef, intent.priorUsage, false);
  if (contentHash(p.intent) !== contentHash(intent)) throw prerequisiteStop("Identity requirement dependencies changed");
  validateIdentityOutput(intent, [...previous, record], p.inventory, p.semantic);
  if ([...p.prerequisites, ...p.representations, ...p.semantic, ...previous].some(r => r.sessionId === record.sessionId || r.traceRunId === record.traceRunId)) throw prerequisiteStop("Identity stage reused an old semantic session");
  const input = await read(`${stage}.input.json`), invocation = await read(`${stage}.invocation.json`), budget = await read(`${stage}.budget.json`);
  if (contentHash(input) !== record.inputHash || contentHash(input) !== contentHash(identityStageInput(p, phase, previous, "shard" in record.output ? record.output.shard : undefined))
    || contentHash(JSON.parse(await fs.readFile(path.join(originalDirectory, "intent.json"), "utf8"))) !== contentHash(intent)
    || contentHash(JSON.parse(await fs.readFile(path.join(originalDirectory, "inventory.json"), "utf8"))) !== intent.inventoryHash
    || contentHash(await read(`${stage}.proposal.json`)) !== contentHash(record.output)
    || invocation.taskId !== intent.taskId || invocation.phase !== phase || invocation.stage !== stage || invocation.intentHash !== contentHash(intent)
    || budget.taskId !== intent.taskId || budget.phase !== phase || budget.stage !== stage || budget.intentHash !== contentHash(intent)
    || budget.originalBudgetHash !== intent.originalBudgetHash || contentHash(budget.priorUsage) !== contentHash(intent.priorUsage)
    || contentHash(budget.limits) !== contentHash(IDENTITY_REQUIREMENT_LIMITS) || budget.state.blocked) throw prerequisiteStop("Identity input, invocation, original history or budget changed");
  const traces = new TraceStore(root), run = await traces.peekRun(record.traceRunId), events = await traces.peekEvents(record.traceRunId);
  const requests = events.filter(e => e.type === "llm.request.started"), payloads = events.filter(e => e.type === "llm.request.payload");
  const submits = events.filter(e => e.type === "tool.call.completed" && e.data?.toolName === "submit_identity_requirements");
  const provenance = events.filter(e => e.type === "stage.started" && e.data?.phase === "identity-requirements-session");
  const usage = budget.state.usage;
  const recovery = record.contextRecoveryHash
    ? await (await import("./identity-context-recovery.js")).readIdentityContextRecovery(root, p, record.contextRecoveryHash) : undefined;
  const inherited = recovery && stage === "identity-consumers-0" ? recovery.initial.usage : undefined;
  let measuredPayloads = payloads.map(e => e.blobRef?.byteLength ?? -1);
  if (recovery) await verifyIdentityRecoveryHostReceipt(root, recovery.proof, record.contextRecoveryGateHash, record, recoveryPermit);
  if (recovery && (invocation.contextRecoveryHash !== record.contextRecoveryHash || budget.contextRecoveryHash !== record.contextRecoveryHash
    || (inherited && (contentHash(budget.inheritedUsage) !== contentHash(inherited)
      || contentHash(budget.historicalFailure) !== contentHash(recovery.budget.state.failure)))))
    throw prerequisiteStop("Identity recovery lineage or original failed charge changed");
  if ((provenance.some(e => e.data?.promptVersion === 3) || events.some(e => e.data?.phase === "lossless-json-transport"))
    && invocation.promptVersion !== 3) throw prerequisiteStop("Identity session protocol was downgraded; complete sealed evidence remains mandatory");
  if (invocation.promptVersion === 2 || invocation.promptVersion === 3) {
    const prompt = JSON.stringify(invocation.promptVersion === 3 ? input : identityPromptInput(input));
    const promptEvents = events.filter(e => e.type === "context.assembled" && e.data?.phase === "before-agent-start");
    if (invocation.promptHash !== contentHash(prompt) || promptEvents.length !== 1 || !promptEvents[0]!.blobRef
      || await traces.peekBlob(promptEvents[0]!.blobRef!) !== prompt) throw prerequisiteStop("Identity prompt projection changed or lost its original input binding");
    const journal = await verifyIdentitySession(root, record, prompt, usage, requests.length,
      events.filter(e => ["tool.call.completed", "tool.call.failed"].includes(e.type)).length);
    measuredPayloads = journal.payloads.map(value => Buffer.byteLength(JSON.stringify(value)));
    for (const [i, value] of journal.payloads.entries()) {
      if (!payloads[i]?.blobRef || contentHash(redactTraceSecrets(value)) !== contentHash(await traces.peekBlob(payloads[i]!.blobRef!)))
        throw prerequisiteStop("Identity actual payload and redacted observational trace disagree");
    }
    if (invocation.promptVersion === 3) {
      const transports = events.filter(e => e.type === "context.assembled" && e.data?.phase === "lossless-json-transport");
      const contextBytes = journal.contexts.map(value => Buffer.byteLength(JSON.stringify(value)));
      if (usage.largestRequestBytes !== Math.max(inherited?.largestRequestBytes ?? 0, ...contextBytes, ...measuredPayloads)
        || transports.length !== requests.length || transports.some((e, i) => e.data?.protocol !== "lossless-json-context/v1"
        || typeof e.data?.encodedBytes !== "number" || e.data.encodedBytes > IDENTITY_REQUIREMENT_LIMITS.maxRequestBytes
        || e.data.encodedBytes !== contextBytes[i] || e.data.encodedHash !== contentHash(journal.contexts[i])
        || e.data.originalBytes !== Buffer.byteLength(JSON.stringify(journal.originals[i])) || e.data.originalHash !== contentHash(journal.originals[i])
        || typeof e.data?.originalBytes !== "number" || e.data.encodedBytes > e.data.originalBytes))
        throw prerequisiteStop("Identity request lost its complete lossless transport receipts");
    }
  } else if (recovery || record.sessionCheckpointHash) throw prerequisiteStop("Context reconstruction requires the persisted bounded prompt protocol");
  if (run.status !== "succeeded" || !run.endedAt || run.sourceId !== intent.sourceId || run.operationId !== `identity-requirements-${intent.taskId}-${stage}` || run.counts.retries
    || payloads.some(e => !e.blobRef) || !(inherited
      ? identityRecoveredUsageMatches(usage, inherited, measuredPayloads, requests.length)
      : identityRequestUsageMatches(usage, measuredPayloads, requests.length))
    || submits.length !== 1 || provenance.length !== 1
    || provenance[0]!.data?.sessionId !== record.sessionId || provenance[0]!.data?.inputHash !== record.inputHash || provenance[0]!.data?.intentHash !== contentHash(intent)
    || provenance[0]!.data?.subscription !== true || requests.some(e => e.data?.providerId !== record.provider || e.data?.modelId !== record.model)
    || events.some(e => e.type.startsWith("world.commit.") || e.type === "llm.response.failed" || (e.type === "tool.call.started"
      && !["read_identity_source", "read_identity_dependencies", "submit_identity_requirements"].includes(String(e.data?.toolName))))) throw prerequisiteStop("Identity record lacks actual bounded Pi subscription provenance");
  let oldCalls = intent.priorUsage.modelCalls, oldBytes = intent.priorUsage.totalPayloadBytes;
  for (const r of previous) {
    const b = JSON.parse(await fs.readFile(path.join(identityRecordDirectory(root, r), `${r.stage}.budget.json`), "utf8"));
    oldCalls += b.state.usage.modelCalls; oldBytes += b.state.usage.totalPayloadBytes;
  }
  if (budget.cumulative.modelCalls !== oldCalls + usage.modelCalls || budget.cumulative.totalPayloadBytes !== oldBytes + usage.totalPayloadBytes) throw prerequisiteStop("Identity task cumulative usage was reset or double-counted");
  for (const r of requests) if (!r.callId || events.filter(e => e.type === "llm.response.completed" && e.callId === r.callId && e.seq > r.seq).length !== 1) throw prerequisiteStop("Unsettled identity provider request");
  for (const s of events.filter(e => e.type === "tool.call.started")) if (events.filter(e => ["tool.call.completed", "tool.call.failed"].includes(e.type) && e.toolCallId === s.toolCallId && e.seq > s.seq).length !== 1) throw prerequisiteStop("Unsettled identity tool call");
  const start = events.find(e => e.type === "tool.call.started" && e.toolCallId === submits[0]!.toolCallId);
  if (!start?.blobRef || contentHash(identityOutputSchema.parse(await traces.peekBlob(start.blobRef))) !== contentHash(record.output)) throw prerequisiteStop("Identity record is not the actual Pi proposal");
  const source = new Set<string>(), refs = new Set<string>(), consumers = new Set<string>();
  for (const end of events.filter(e => e.type === "tool.call.completed" && e.seq < start.seq)) {
    const begin = events.find(e => e.type === "tool.call.started" && e.toolCallId === end.toolCallId);
    if (!begin?.blobRef) throw prerequisiteStop("Identity read lacks original arguments");
    const args = await traces.peekBlob(begin.blobRef) as { segmentIds?: string[]; collection?: string; refs?: string[] };
    if (end.data?.toolName === "read_identity_source") args.segmentIds?.forEach(id => source.add(id));
    if (end.data?.toolName === "read_identity_dependencies") args.refs?.forEach(id => (args.collection === "consumers" ? consumers : refs).add(id));
  }
  if (input.requiredSourceSegmentIds.some((id: string) => !source.has(id)) || input.requiredDependencyRefs.some((id: string) => !refs.has(id))
    || (!phase.startsWith("identity-definition") && ("shard" in record.output ? intent.consumerShards[record.output.shard]!.refs : []).some(ref => !consumers.has(ref)))) throw prerequisiteStop("Identity phase did not freshly read the entire required source/dependency/consumer inventory");
  if (phase.endsWith("-check") && identitySelectors(previous.at(-1)!.output).some(e => !source.has(e.segment_id))) throw prerequisiteStop("Independent identity check omitted proposal evidence reads");
  if (contentHash(identitySelectors(record.output)) !== contentHash(record.evidence.map(e => e.selector))) throw prerequisiteStop("Identity evidence denominator changed");
  for (const e of record.evidence) {
    const segment = p.manifest.segments.find(s => s.id === e.selector.segment_id);
    if (!segment || !source.has(segment.id) || contentHash(await resolveTextSelectorAnchor(root, segment, e.selector)) !== contentHash(e.anchor)) throw prerequisiteStop("Identity evidence lacks a fresh complete immutable source read");
  }
}
