import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { contentHash } from "../world/canonical.js";
import { TraceStore } from "../trace/store.js";
import { EntityResolutionStore } from "./entity-resolution.js";
import { RequirementLedger } from "./requirement-ledger.js";
import { UpstreamRepairLedger } from "./upstream-repair-ledger.js";
import { prerequisiteEvidenceSchema, prerequisiteStop } from "./role-source-prerequisites.js";
import { modelTextSelectorSchema, textAnchorForByteRange } from "./text-anchors.js";
import type { UpstreamRepairPlan } from "./upstream-repair-plan.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { SegmentStore } from "./segments.js";
import { resolveTextSelectorAnchor } from "./text-anchors.js";
import type { ModelRequestLimits } from "../runtime/model-request-budget.js";
import type { TraceEvent } from "../trace/schema.js";

export const IDENTITY_UPSTREAM_SLOT_LIMITS = Object.freeze({ maxModelCalls: 4, maxRequestBytes: 512_000, maxTotalPayloadBytes: 2_048_000 });
export const IDENTITY_UPSTREAM_ACCEPTANCE_LIMITS = Object.freeze({ maxModelCalls: 24, maxRequestBytes: 512_000, maxTotalPayloadBytes: 12_288_000 });
const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));

async function verifyInvocationBudget(root: string, plan: UpstreamRepairPlan, stage: string, events: TraceEvent[], limits: ModelRequestLimits) {
  const directory = identityUpstreamDirectory(root, plan), invocation = await read(path.join(directory, `${stage}.invocation.json`));
  const budget = await read(path.join(directory, `${stage}.budget.json`));
  const original = (await new RequirementLedger(root, plan.sourceScope.sourceId).sourcePrerequisites(plan.identityRequirements!.taskId))[0]!;
  const requests = events.filter(e => e.type === "llm.request.started"), usage = budget.state?.usage;
  if (invocation.taskId !== plan.identityRequirements!.taskId || invocation.planHash !== plan.planHash
    || budget.taskId !== invocation.taskId || budget.planHash !== plan.planHash || budget.stage !== stage
    || budget.originalBudgetHash !== original.scope.originalBudgetHash || contentHash(budget.limits) !== contentHash(limits)
    || budget.state.blocked || !usage || !Number.isSafeInteger(usage.modelCalls) || usage.modelCalls < 1
    || usage.modelCalls !== requests.length || usage.payloads !== requests.length || usage.modelCalls > limits.maxModelCalls
    || !Number.isSafeInteger(usage.totalPayloadBytes) || usage.totalPayloadBytes < 1 || usage.totalPayloadBytes > limits.maxTotalPayloadBytes
    || !Number.isSafeInteger(usage.largestRequestBytes) || usage.largestRequestBytes < 1 || usage.largestRequestBytes > limits.maxRequestBytes) throw prerequisiteStop("Original invocation or retained request budget changed");
  for (const start of requests) if (!events.some(e => e.type === "llm.response.completed" && e.callId === start.callId && e.seq > start.seq)) throw prerequisiteStop("Unsettled provider request in source upstream trace");
  for (const start of events.filter(e => e.type === "tool.call.started")) if (!events.some(e => ["tool.call.completed", "tool.call.failed"].includes(e.type) && e.toolCallId === start.toolCallId && e.seq > start.seq)) throw prerequisiteStop("Unsettled tool call in source upstream trace");
  return invocation;
}

const hash = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().trim().min(1).max(6000);
export const identityUpstreamDirectory = (root: string, plan: UpstreamRepairPlan) => {
  if (!plan.identityRequirements) throw prerequisiteStop("Identity upstream execution has no exact representation authority");
  return path.join(workspaceStateDir(root), "compile-loops", plan.sourceScope.sourceId, "prerequisites", plan.identityRequirements.taskId, "identity-requirements", "upstream");
};
export const identityUpstreamAcceptanceSchema = z.object({
  phase: z.literal("upstream-acceptance"), planHash: hash, graphHash: hash,
  judgments: z.array(z.object({ requirementId: text, verdict: z.enum(["supported", "blocked"]), rationale: text,
    evidence: z.array(modelTextSelectorSchema).min(1).max(24) }).strict()).min(1).max(16),
}).strict();
export const identityUpstreamAcceptanceRecordSchema = z.object({
  taskId: hash, planHash: hash, graphHash: hash, inputHash: hash, output: identityUpstreamAcceptanceSchema,
  traceRunId: text, sessionId: text, provider: z.literal("openai-codex"), model: z.literal("gpt-6.1-sol"), subscription: z.literal(true),
  evidence: z.array(prerequisiteEvidenceSchema).min(1).max(384),
}).strict();
export type IdentityUpstreamAcceptanceRecord = z.infer<typeof identityUpstreamAcceptanceRecordSchema>;
export const identityUpstreamSlotRecordSchema = z.object({ planHash: hash, target: z.object({ kind: z.string(), id: z.string() }).strict(),
  traceRunId: text, sessionId: text, sessionRef: hash, attemptRef: hash, proposalId: text, proposalHash: hash }).strict();
export type IdentityUpstreamSlotRecord = z.infer<typeof identityUpstreamSlotRecordSchema>;

/** Read exact original staged envelopes; accepted history remains identical after a finish. */
export async function identityUpstreamGraph(root: string, plan: UpstreamRepairPlan) {
  if (!plan.identityRequirements || plan.allowedWrites.length) throw prerequisiteStop("Only reviewed identity creations may enter this acceptance graph");
  const state = await new UpstreamRepairLedger(root, plan.sourceScope.sourceId).inspect();
  const current = state.plans.find(p => p.plan.planHash === plan.planHash);
  if (!current || contentHash(current.plan) !== contentHash(plan) || current.state === "needs-host-review"
    || state.modelSessions.some(s => s.started.planHash === plan.planHash && !s.closed)) throw prerequisiteStop("Original upstream plan has stopped or unsettled sessions");
  const store = new EntityResolutionStore(root), graph = [];
  for (const target of plan.allowedCreations) {
    const attempt = state.attempts.findLast(a => a.started.planHash === plan.planHash && a.started.artifactId === target.id && a.staged);
    if (!attempt?.validatedHash || attempt.failed || !attempt.started.modelSessionRef) throw prerequisiteStop("A source slot lacks its original Pi-staged attempt");
    let envelope;
    try { envelope = await store.readProposal(plan.sourceScope.sourceId, "pending", attempt.started.proposalId); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; envelope = await store.readProposal(plan.sourceScope.sourceId, "accepted", attempt.started.proposalId); }
    const staged = state.records.find(r => r.payload.kind === "attempt-staged" && r.payload.attemptRef === attempt.attemptRef)?.payload;
    if (envelope.payload.id !== target.id || target.kind !== "entity-resolution" || contentHash(envelope.payload) !== attempt.validatedHash
      || staged?.kind !== "attempt-staged" || staged.proposalHash !== contentHash(envelope)) throw prerequisiteStop("Source acceptance graph differs from the original validated proposal");
    graph.push({ target: { kind: target.kind, id: target.id }, attemptRef: attempt.attemptRef, sessionRef: attempt.started.modelSessionRef,
      proposalId: envelope.id, proposalHash: contentHash(envelope), payloadHash: attempt.validatedHash, payload: envelope.payload });
  }
  if (state.attempts.some(a => a.started.planHash === plan.planHash && !a.staged && !a.failed)) throw prerequisiteStop("Unsettled source proposal attempt");
  return graph;
}

export async function verifyIdentityUpstreamSlotTrace(root: string, plan: UpstreamRepairPlan, raw: IdentityUpstreamSlotRecord) {
  const record = identityUpstreamSlotRecordSchema.parse(raw), state = await new UpstreamRepairLedger(root, plan.sourceScope.sourceId).inspect();
  const attempt = state.attempts.find(a => a.attemptRef === record.attemptRef), session = state.modelSessions.find(s => s.sessionRef === record.sessionRef);
  if (record.planHash !== plan.planHash || !session?.closed || session.chargedFailure || !attempt?.staged || attempt.failed
    || attempt.started.modelSessionRef !== record.sessionRef || attempt.started.artifactKind !== record.target.kind || attempt.started.artifactId !== record.target.id
    || attempt.started.proposalId !== record.proposalId || session.started.planHash !== plan.planHash) throw prerequisiteStop("Slot trace lacks the exact settled upstream reservation");
  const store = new TraceStore(root), run = await store.peekRun(record.traceRunId), events = await store.peekEvents(record.traceRunId);
  const tool = `propose_${record.target.kind.replaceAll("-", "_")}`;
  const provenance = events.filter(e => e.type === "stage.started" && e.data?.phase === "identity-upstream-slot");
  const completed = events.filter(e => e.type === "tool.call.completed" && e.data?.toolName === tool);
  const requests = events.filter(e => e.type === "llm.request.started");
  const invocation = await verifyInvocationBudget(root, plan, record.target.id, events, IDENTITY_UPSTREAM_SLOT_LIMITS);
  const input = await read(path.join(identityUpstreamDirectory(root, plan), `${record.target.id}.input.json`));
  if (contentHash(invocation.target) !== contentHash(record.target) || contentHash(JSON.stringify(input)) !== session.started.promptHash
    || input.proposalId !== record.proposalId || contentHash(input.context.plan) !== contentHash(plan)) throw prerequisiteStop("Staging input differs from the original reserved Pi prompt");
  if (run.status !== "succeeded" || !run.endedAt || run.sourceId !== plan.sourceScope.sourceId || run.operationId !== `identity-upstream-${plan.identityRequirements!.taskId}-${record.target.id}`
    || run.counts.retries || !requests.length || requests.some(e => e.data?.providerId !== "openai-codex" || e.data?.modelId !== "gpt-6.1-sol")
    || provenance.length !== 1 || provenance[0]!.data?.sessionId !== record.sessionId || provenance[0]!.data?.planHash !== plan.planHash
    || provenance[0]!.data?.inputHash !== session.started.promptHash || contentHash(provenance[0]!.data?.target) !== contentHash(record.target)
    || provenance[0]!.data?.subscription !== true || completed.length !== 1
    || events.some(e => e.type.startsWith("world.commit.") || e.type === "llm.response.failed" || (e.type === "tool.call.started" && ![tool, "read_upstream_repair_context"].includes(String(e.data?.toolName))))) throw prerequisiteStop("Slot lacks actual bounded Pi subscription provenance");
  const call = events.find(e => e.type === "tool.call.started" && e.toolCallId === completed[0]!.toolCallId);
  const args = call?.blobRef ? await store.peekBlob(call.blobRef) as { proposal_json?: string } : undefined;
  if (!args?.proposal_json || contentHash(JSON.parse(args.proposal_json)) !== contentHash(attempt.started.toolInput)) throw prerequisiteStop("Staged source proposal is not the actual Pi tool input");
  for (const start of events.filter(e => e.type === "tool.call.started")) if (!events.some(e => ["tool.call.completed", "tool.call.failed"].includes(e.type) && e.toolCallId === start.toolCallId && e.seq > start.seq)) throw prerequisiteStop("Slot has an unsettled tool call");
}

/** Mandatory before finish; checks actual pending/accepted envelopes, not a success label or a preview. */
export async function verifyIdentityUpstreamAcceptance(root: string, plan: UpstreamRepairPlan) {
  const directory = identityUpstreamDirectory(root, plan);
  const record = identityUpstreamAcceptanceRecordSchema.parse(JSON.parse(await fs.readFile(path.join(directory, "acceptance.record.json"), "utf8")));
  const graph = await identityUpstreamGraph(root, plan), ledger = new RequirementLedger(root, plan.sourceScope.sourceId);
  const prerequisites = await ledger.sourcePrerequisites(plan.identityRequirements!.taskId), representations = await ledger.sourceRepresentations(plan.identityRequirements!.taskId);
  const identityRecords = await ledger.identityRequirements(plan.identityRequirements!.taskId);
  const questions = identityRecords[0]?.intent.targets.map(t => ({ requirementId: t.requirementId }));
  const semantic = await ledger.roleSemanticScopes(plan.identityRequirements!.taskId);
  const input = await read(path.join(directory, "acceptance.input.json")), proposal = await read(path.join(directory, "acceptance.proposal.json"));
  if (contentHash(input) !== record.inputHash || contentHash(proposal) !== contentHash(record.output)
    || input.taskId !== record.taskId || input.planHash !== plan.planHash || input.graphHash !== contentHash(graph)
    || contentHash(input.staged) !== contentHash(graph) || contentHash(input.originalQuestions) !== contentHash(prerequisites[0]?.scope.questions)
    || contentHash(input.requirements) !== contentHash(identityRecords[0]?.output) || contentHash(input.identityReviewRecordHashes) !== contentHash(identityRecords.map(contentHash))
    || contentHash(input.consumerRequirements) !== contentHash(identityRecords.flatMap(r => r.output.phase === "identity-consumers" ? r.output.consumers.map(({ rationale: _, ...c }) => c) : []))
    || input.consumerActivationAuthorized !== false
    || contentHash(input.sourceSegmentIds) !== contentHash(plan.sourceScope.segmentIds) || contentHash(input.limits) !== contentHash(IDENTITY_UPSTREAM_ACCEPTANCE_LIMITS)) throw prerequisiteStop("Independent acceptance input or proposal changed");
  const expectedRefs = plan.readableRefs.filter(r => r.kind !== "source-segment");
  if (contentHash(input.currentDependencies.map((a: { ref: unknown }) => a.ref)) !== contentHash(expectedRefs)
    || input.currentDependencies.some((a: { ref: { kind: string; id: string }; payload: unknown }) => contentHash(a.payload) !== plan.baselineRefs.find(r => r.kind === a.ref.kind && r.id === a.ref.id)?.revisionHash)) throw prerequisiteStop("Independent acceptance omitted or changed a reused annotation");
  if (!questions || record.taskId !== plan.identityRequirements!.taskId || record.planHash !== plan.planHash || record.graphHash !== contentHash(graph)
    || record.output.planHash !== plan.planHash || record.output.graphHash !== record.graphHash
    || record.output.judgments.some(j => j.verdict !== "supported")
    || contentHash(record.output.judgments.map(j => j.requirementId).sort()) !== contentHash(questions.map(q => q.requirementId).sort())
    || [...prerequisites, ...representations, ...semantic, ...identityRecords].some(r => r.sessionId === record.sessionId || r.traceRunId === record.traceRunId)) throw prerequisiteStop("Independent source acceptance is negative, incomplete, stale or reused");
  const sessions = new Set([record.sessionId]), traces = new Set([record.traceRunId]);
  for (const item of graph) {
    const staged = identityUpstreamSlotRecordSchema.parse(JSON.parse(await fs.readFile(path.join(directory, `${item.target.id}.record.json`), "utf8")));
    if (staged.proposalHash !== item.proposalHash || staged.attemptRef !== item.attemptRef || staged.sessionRef !== item.sessionRef || contentHash(staged.target) !== contentHash(item.target)
      || sessions.has(staged.sessionId) || traces.has(staged.traceRunId)
      || [...prerequisites, ...representations, ...semantic, ...identityRecords].some(r => r.sessionId === staged.sessionId || r.traceRunId === staged.traceRunId)) throw prerequisiteStop("Acceptance reused a staging session or changed its exact slot");
    await verifyIdentityUpstreamSlotTrace(root, plan, staged); sessions.add(staged.sessionId); traces.add(staged.traceRunId);
  }
  const store = new TraceStore(root), run = await store.peekRun(record.traceRunId), events = await store.peekEvents(record.traceRunId);
  const requests = events.filter(e => e.type === "llm.request.started"), submissions = events.filter(e => e.type === "tool.call.completed" && e.data?.toolName === "submit_identity_upstream_acceptance");
  const provenance = events.filter(e => e.type === "stage.started" && e.data?.phase === "identity-upstream-acceptance");
  const invocation = await verifyInvocationBudget(root, plan, "acceptance", events, IDENTITY_UPSTREAM_ACCEPTANCE_LIMITS);
  if (invocation.graphHash !== record.graphHash) throw prerequisiteStop("Independent acceptance invocation changed its graph");
  if (run.status !== "succeeded" || !run.endedAt || run.sourceId !== plan.sourceScope.sourceId || run.operationId !== `identity-upstream-${record.taskId}-acceptance` || run.counts.retries
    || !requests.length || requests.some(e => e.data?.providerId !== record.provider || e.data?.modelId !== record.model)
    || submissions.length !== 1 || provenance.length !== 1 || provenance[0]!.data?.sessionId !== record.sessionId
    || provenance[0]!.data?.inputHash !== record.inputHash || provenance[0]!.data?.subscription !== true
    || events.some(e => e.type.startsWith("world.commit.") || e.type === "llm.response.failed" || (e.type === "tool.call.started" && !["read_identity_upstream_acceptance", "submit_identity_upstream_acceptance"].includes(String(e.data?.toolName))))) throw prerequisiteStop("Independent acceptance lacks actual read-only Pi subscription provenance");
  const start = events.find(e => e.type === "tool.call.started" && e.toolCallId === submissions[0]!.toolCallId);
  if (!start?.blobRef || contentHash(identityUpstreamAcceptanceSchema.parse(await store.peekBlob(start.blobRef))) !== contentHash(record.output)) throw prerequisiteStop("Acceptance output is not the actual Pi submission");
  const readSegments = new Set<string>();
  for (const completed of events.filter(e => e.type === "tool.call.completed" && e.data?.toolName === "read_identity_upstream_acceptance" && e.seq < start.seq)) {
    const call = events.find(e => e.type === "tool.call.started" && e.toolCallId === completed.toolCallId);
    if (!call?.blobRef) throw prerequisiteStop("Independent source read lacks its original input");
    const args = z.object({ segmentIds: z.array(z.string()) }).strict().parse(await store.peekBlob(call.blobRef));
    if (args.segmentIds.some(id => !plan.sourceScope.segmentIds.includes(id))) throw prerequisiteStop("Independent source read escaped the authorized scope");
    args.segmentIds.forEach(id => readSegments.add(id));
  }
  if (plan.sourceScope.segmentIds.some(id => !readSegments.has(id))) throw prerequisiteStop("Independent acceptance did not read every required source segment afresh");
  const source = await WorkspaceStore.openReadOnly(root).getSource(plan.sourceScope.sourceId);
  if (!source || source.contentSha256 !== plan.sourceScope.sourceSha256) throw prerequisiteStop("Acceptance source changed");
  const bytes = await readSourceMaterial(root, source);
  if (contentHash(record.evidence.map(e => e.selector)) !== contentHash(record.output.judgments.flatMap(j => j.evidence))
    || record.evidence.some(e => contentHash(e.anchor) !== contentHash(textAnchorForByteRange(source.id, bytes, e.anchor.startByte, e.anchor.endByte))
      || Buffer.from(bytes).subarray(e.anchor.startByte, e.anchor.endByte).toString("utf8") !== e.selector.exact)) throw prerequisiteStop("Acceptance evidence changed");
  const manifest = await new SegmentStore(root).readManifest(source.id);
  for (const evidence of record.evidence) {
    const segment = manifest?.segments.find(s => s.id === evidence.selector.segment_id && readSegments.has(s.id));
    if (!segment || contentHash(await resolveTextSelectorAnchor(root, segment, evidence.selector)) !== contentHash(evidence.anchor)) throw prerequisiteStop("Acceptance selector no longer resolves to its original source receipt");
  }
  return record;
}
