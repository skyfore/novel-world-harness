import fs from "node:fs/promises";
import path from "node:path";
import { TraceStore } from "../trace/store.js";
import { contentHash } from "../world/canonical.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import type { RoleDependencyReview } from "./role-dependency-review.js";
import { semanticScopeOutputSchema, semanticScopeSelectors, roleSemanticScopeDirectory, SEMANTIC_SCOPE_LIMITS,
  validateSemanticScopePlan, semanticScopeView, type SemanticScopeRecord } from "./role-semantic-scope.js";
import { prepareCoreRoleDependencyReview } from "./role-dependency-review-service.js";
import { SegmentStore } from "./segments.js";
import { resolveTextSelectorAnchor } from "./text-anchors.js";
import { verifySemanticScopeCorrection, validateSemanticScopeCorrection, semanticScopeCorrectionDirectory, semanticScopeCorrectionStage } from "./role-semantic-scope-correction.js";

/** Verify actual submission, fresh reads, frozen input and durable request charges. */
export async function verifySemanticScopeRecord(root: string, review: RoleDependencyReview, record: SemanticScopeRecord) {
  const { RequirementLedger } = await import("./requirement-ledger.js");
  const prior = record.phase === "semantic-scope-check" ? (await new RequirementLedger(root, review.scope.sourceId).roleSemanticScopes(review.taskId))[0] : undefined;
  const authority = record.correction ?? prior?.correction;
  const correction = authority ? await verifySemanticScopeCorrection(root, review, authority) : undefined;
  const stage = record.correction ? semanticScopeCorrectionStage : record.phase;
  const directory = record.correction ? semanticScopeCorrectionDirectory(root, review) : roleSemanticScopeDirectory(root, review.taskId, review.scope.sourceId);
  const read = async (name: string) => JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
  const input = await read(`${stage}.input.json`), invocation = await read(`${stage}.invocation.json`), budget = await read(`${stage}.budget.json`);
  if (contentHash(input) !== record.inputHash || contentHash(input.review) !== contentHash(semanticScopeView(review))
    || contentHash(await read(`${stage}.proposal.json`)) !== contentHash(record.output)
    || invocation.taskId !== review.taskId || invocation.revisionHash !== review.revisionHash || invocation.phase !== stage
    || budget.taskId !== review.taskId || budget.phase !== stage || budget.originalBudgetHash !== review.scope.originalBudgetHash
    || contentHash(budget.limits) !== contentHash(SEMANTIC_SCOPE_LIMITS) || budget.state.blocked) throw prerequisiteStop("Semantic scope input, invocation or retained budget changed");
  if (authority && (!correction || contentHash(input.correction) !== contentHash({ authority, originalSubmission: correction.original })
    || invocation.correctionHash !== contentHash(authority) || record.sessionId === authority.failedSessionId
    || record.traceRunId === authority.failedTraceRunId)) throw prerequisiteStop("Correction/check lost the failed submission, authority or independent session");
  const store = new TraceStore(root), run = await store.peekRun(record.traceRunId), events = await store.peekEvents(record.traceRunId);
  const requests = events.filter(e => e.type === "llm.request.started");
  const inherited = record.correction?.originalUsage;
  if (record.correction) {
    const payloads = events.filter(e => e.type === "llm.request.payload");
    if (budget.predecessorBudgetHash !== record.correction.originalBudgetHash || budget.correctionHash !== contentHash(record.correction)
      || budget.state.usage.modelCalls > SEMANTIC_SCOPE_LIMITS.maxModelCalls || budget.state.usage.totalPayloadBytes > SEMANTIC_SCOPE_LIMITS.maxTotalPayloadBytes
      || payloads.length !== requests.length || payloads.some(e => !e.blobRef)
      || budget.state.usage.totalPayloadBytes !== inherited!.totalPayloadBytes + payloads.reduce((n, e) => n + e.blobRef!.byteLength, 0)
      || budget.state.usage.largestRequestBytes < inherited!.largestRequestBytes || budget.state.usage.largestRequestBytes > SEMANTIC_SCOPE_LIMITS.maxRequestBytes) throw prerequisiteStop("Correction reset or exceeded the original cumulative request/byte allowance");
  }
  const submissions = events.filter(e => e.type === "tool.call.completed" && e.data?.toolName === "submit_role_semantic_scope");
  const provenance = events.filter(e => e.type === "stage.started" && e.data?.phase === "role-semantic-scope-session");
  if (run.status !== "succeeded" || !run.endedAt || run.sourceId !== review.scope.sourceId || run.operationId !== `role-semantic-scope-${review.taskId}-${stage}`
    || run.counts.retries || !requests.length || requests.length > SEMANTIC_SCOPE_LIMITS.maxModelCalls
    || requests.length + (inherited?.modelCalls ?? 0) !== budget.state.usage.modelCalls || requests.length + (inherited?.payloads ?? 0) !== budget.state.usage.payloads
    || requests.some(e => e.data?.providerId !== record.provider || e.data?.modelId !== record.model)
    || submissions.length !== 1 || provenance.length !== 1 || provenance[0]!.data?.sessionId !== record.sessionId
    || provenance[0]!.data?.inputHash !== record.inputHash || provenance[0]!.data?.revisionHash !== review.revisionHash || provenance[0]!.data?.subscription !== true
    || events.some(e => e.type.startsWith("world.commit.") || e.type === "llm.response.failed"
      || (e.type === "tool.call.started" && !["read_semantic_source", "read_semantic_dependencies", "submit_role_semantic_scope"].includes(String(e.data?.toolName))))) throw prerequisiteStop("Semantic scope lacks actual independent read-only Pi subscription provenance");
  if (authority && provenance[0]!.data?.correctionHash !== contentHash(authority)) throw prerequisiteStop("Pi session did not bind the exact correction intent");
  for (const request of requests) if (!request.callId || events.filter(e => e.type === "llm.response.completed" && e.callId === request.callId && e.seq > request.seq).length !== 1) throw prerequisiteStop("Semantic scope has an unsettled or duplicated provider response");
  for (const start of events.filter(e => e.type === "tool.call.started")) if (!events.some(e => ["tool.call.completed", "tool.call.failed"].includes(e.type) && e.toolCallId === start.toolCallId && e.seq > start.seq)) throw prerequisiteStop("Semantic scope has an unsettled tool invocation");
  const start = events.find(e => e.type === "tool.call.started" && e.toolCallId === submissions[0]!.toolCallId);
  if (!start?.blobRef || contentHash(semanticScopeOutputSchema.parse(await store.peekBlob(start.blobRef))) !== contentHash(record.output)) throw prerequisiteStop("Semantic scope output is not the actual Pi submission");
  const delivered = new Set<string>(), references = new Set<string>();
  for (const end of events.filter(e => e.type === "tool.call.completed" && e.seq < start.seq)) {
    const begin = events.find(e => e.type === "tool.call.started" && e.toolCallId === end.toolCallId);
    if (!begin?.blobRef) throw prerequisiteStop("Semantic scope read has no retained input");
    const args = await store.peekBlob(begin.blobRef) as { segmentIds?: string[]; refs?: string[] };
    if (end.data?.toolName === "read_semantic_source") args.segmentIds?.forEach(id => delivered.add(id));
    if (end.data?.toolName === "read_semantic_dependencies") args.refs?.forEach(id => references.add(id));
  }
  const prepared = correction?.prepared ?? await prepareCoreRoleDependencyReview(root, { scope: review.scope, upstreamPlanHash: review.upstream.planHash, authorizationRef: review.authorizationRef });
  if (contentHash(prepared.review) !== contentHash(review) || [...prepared.prerequisites, ...prepared.representations].some(r => r.sessionId === record.sessionId || r.traceRunId === record.traceRunId)) throw prerequisiteStop("Semantic session reuses prior work or stale dependencies");
  const proposal = record.output.phase === "semantic-scope-plan" ? record.output : input.proposal;
  if (correction) validateSemanticScopeCorrection(correction.original, proposal, correction.authority);
  if (record.output.phase === "semantic-scope-check") {
    if (!prior || record.predecessorRecordHash !== contentHash(prior) || contentHash(proposal) !== contentHash(prior.output)
      || input.proposalHash !== contentHash(prior.output) || record.output.proposalHash !== contentHash(prior.output)) throw prerequisiteStop("Independent session did not receive the actual retained proposal");
  }
  if (contentHash(input.specification) !== contentHash(prepared.prerequisites[0]!.output)
    || contentHash(input.representation) !== contentHash(prepared.representations[0]!.output)
    || contentHash(input.requiredSourceSegmentIds) !== contentHash(prepared.upstreamPlan.sourceScope.segmentIds)
    || input.requiredSourceSegmentIds.some((id: string) => !delivered.has(id))) throw prerequisiteStop("Semantic scope omitted the current independent specifications or required fresh source reads");
  validateSemanticScopePlan(proposal, review, prepared.prerequisites, prepared.representations, prepared.catalog, prepared.discovery.findings.map(f => f.findingId));
  for (const op of proposal.operations) for (const ref of [...op.readableRefs, ...(op.baseline ? [op.baseline] : [])]) if (!references.has(`${ref.kind}:${ref.id}`)) throw prerequisiteStop("Semantic scope did not read every exact dependency afresh");
  const selectors = semanticScopeSelectors(record.output), manifest = await new SegmentStore(root).readManifest(review.scope.sourceId);
  if (semanticScopeSelectors(proposal).some(e => !delivered.has(e.segment_id))) throw prerequisiteStop("Independent scope omitted fresh reads of proposal evidence");
  if (contentHash(selectors) !== contentHash(record.evidence.map(e => e.selector))) throw prerequisiteStop("Semantic scope evidence inventory changed");
  for (const e of record.evidence) {
    const segment = manifest?.segments.find(s => s.id === e.selector.segment_id);
    if (!segment || !delivered.has(segment.id) || contentHash(await resolveTextSelectorAnchor(root, segment, e.selector)) !== contentHash(e.anchor)) throw prerequisiteStop("Semantic scope evidence lacks a fresh complete original-source read");
  }
}
