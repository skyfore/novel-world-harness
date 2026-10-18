import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../world/canonical.js";
import { TraceStore } from "../trace/store.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { RequirementLedger } from "./requirement-ledger.js";
import { identityOutputSchema, identityRequirementDirectory, identitySelectors, IDENTITY_REQUIREMENT_LIMITS, validateIdentityOutput, type IdentityRecord } from "./identity-requirements.js";
import { prepareIdentityRequirements, type PreparedIdentityRequirements } from "./identity-requirement-service.js";
import { identityStageInput } from "../workflow/identity-requirements.js";
import { resolveTextSelectorAnchor } from "./text-anchors.js";
import type { ModelRequestUsage } from "../runtime/model-request-budget.js";

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

/** Checks actual read-only Pi calls, independently reconstructed inputs and exact
 * cumulative billing. A successful model label or copied proposal is insufficient. */
export async function verifyIdentityRecord(root: string, record: IdentityRecord, previous: IdentityRecord[], supplied?: PreparedIdentityRequirements) {
  const { intent, phase, stage } = record, dir = identityRequirementDirectory(root, intent.sourceId, intent.taskId);
  const read = async (name: string) => JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
  const review = (await new RequirementLedger(root, intent.sourceId).roleDependencyReviews()).find(r => r.taskId === intent.taskId);
  if (!review) throw prerequisiteStop("Independent identity record lost original denominator revision");
  const p = supplied ?? await prepareIdentityRequirements(root, { scope: review.scope, upstreamPlanHash: review.upstream.planHash, authorizationRef: review.authorizationRef }, intent.authorizationRef, intent.priorUsage, false);
  if (contentHash(p.intent) !== contentHash(intent)) throw prerequisiteStop("Identity requirement dependencies changed");
  validateIdentityOutput(intent, [...previous, record], p.inventory, p.semantic);
  if ([...p.prerequisites, ...p.representations, ...p.semantic, ...previous].some(r => r.sessionId === record.sessionId || r.traceRunId === record.traceRunId)) throw prerequisiteStop("Identity stage reused an old semantic session");
  const input = await read(`${stage}.input.json`), invocation = await read(`${stage}.invocation.json`), budget = await read(`${stage}.budget.json`);
  if (contentHash(input) !== record.inputHash || contentHash(input) !== contentHash(identityStageInput(p, phase, previous, "shard" in record.output ? record.output.shard : undefined))
    || contentHash(await read("intent.json")) !== contentHash(intent) || contentHash(await read("inventory.json")) !== intent.inventoryHash
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
  if (run.status !== "succeeded" || !run.endedAt || run.sourceId !== intent.sourceId || run.operationId !== `identity-requirements-${intent.taskId}-${stage}` || run.counts.retries
    || payloads.some(e => !e.blobRef) || !identityRequestUsageMatches(usage, payloads.map(e => e.blobRef?.byteLength ?? -1), requests.length)
    || submits.length !== 1 || provenance.length !== 1
    || provenance[0]!.data?.sessionId !== record.sessionId || provenance[0]!.data?.inputHash !== record.inputHash || provenance[0]!.data?.intentHash !== contentHash(intent)
    || provenance[0]!.data?.subscription !== true || requests.some(e => e.data?.providerId !== record.provider || e.data?.modelId !== record.model)
    || events.some(e => e.type.startsWith("world.commit.") || e.type === "llm.response.failed" || (e.type === "tool.call.started"
      && !["read_identity_source", "read_identity_dependencies", "submit_identity_requirements"].includes(String(e.data?.toolName))))) throw prerequisiteStop("Identity record lacks actual bounded Pi subscription provenance");
  let oldCalls = intent.priorUsage.modelCalls, oldBytes = intent.priorUsage.totalPayloadBytes;
  for (const r of previous) { const b = await read(`${r.stage}.budget.json`); oldCalls += b.state.usage.modelCalls; oldBytes += b.state.usage.totalPayloadBytes; }
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
