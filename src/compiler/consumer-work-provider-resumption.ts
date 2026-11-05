import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { TraceStore } from "../trace/store.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { consumerWorkContract, consumerWorkInput, consumerWorkProviderDirectory,
  consumerReviewRecoveryBudgetPolicy, workBudgetPolicy, verifyConsumerWorkProgress, type ConsumerWorkPlan } from "./consumer-work-plan.js";
import { consumerProviderResumptionSchema, maybeRecoveryFile, type ConsumerProviderResumption } from "./identity-consumer-stage-recovery.js";
import { identityQuotaRefusal, verifyWorkQuotaRefusedSession } from "./identity-session-integrity.js";
import { assertConsumerWorkRetained, verifyRecordedConsumerWork } from "./identity-consumer-work.js";
import type { ConsumerRevalidationRecord, ConsumerRevalidationScope } from "./identity-consumer-revalidation-model.js";
import { consumerEvidenceReads } from "./consumer-evidence-coverage.js";
import { consumerWorkRecordDirectory } from "./consumer-work-evidence.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/), count = z.number().int().nonnegative();
export const consumerWorkProviderRecoverySchema = z.object({
  version: z.literal(1), policy: z.literal("consumer-work-provider-resumption/v1"),
  request: consumerProviderResumptionSchema, originalPlanHash: hash, originalInputHash: hash,
  originalSessionId: z.string().min(1), traceHash: hash,
  retainedFiles: z.array(z.object({ path: z.string().min(1), hash }).strict()).min(8),
  priorUsage: z.object({ modelCalls: count, totalPayloadBytes: count }).strict(),
  limits: z.object({ maxModelCalls: count, maxRequestBytes: count, maxTotalPayloadBytes: count }).strict(),
  draft: z.unknown().optional(), requiredSourceSegmentIds: z.array(z.string()), requiredArtifactRefs: z.array(z.string()),
  requiredArtifactRevisions: z.array(z.object({ ref: z.string(), revisionHash: hash }).strict()).optional(),
  parentResumeAllowed: z.literal(false),
}).strict();
export type ConsumerWorkProviderRecovery = z.infer<typeof consumerWorkProviderRecoverySchema>;
const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
export const workProviderStop = (reason: string) => prerequisiteStop(`${reason}. Inspect requirements inspect-identity-repairs in the same source/task/ref; copy execution.providerResumptionCandidate scopeHash, stage and failedTraceRunId into --provider-resumption JSON with later authorizationRef and authorizedAt. Use --resume-unsubmitted inspect before run. Correct an ID once from discovery; never guess, reset usage or retry unchanged. A submitted, unsettled, hard-stopped, changed or already resumed stage must not be restarted`);

export async function inspectWorkProviderCandidate(root: string, sourceId: string, scopeHash: string, directory: string, stage: string, failure: any) {
  if (failure?.reason !== `Error: ${identityQuotaRefusal}` || await maybeRecoveryFile(path.join(directory, `${stage}.session-checkpoint.json`))) return undefined;
  const runs = await new TraceStore(root).peekRunsByOperation(sourceId, `receipt-bound-${scopeHash}-${stage}-work-v1`);
  if (runs.length !== 1 || runs[0]!.status !== "failed" || !runs[0]!.endedAt) return undefined;
  return { scopeHash, stage, failedTraceRunId: runs[0]!.id, failureHash: contentHash(failure), inspectionRequired: true };
}

export function deriveWorkProviderPlan(original: ConsumerWorkPlan, recovery: ConsumerWorkProviderRecovery): ConsumerWorkPlan {
  if (original.providerResumptionHash || original.bindingRecoveryHash || contentHash(original) !== recovery.originalPlanHash
    || original.scopeHash !== recovery.request.scopeHash || original.stage !== recovery.request.stage)
    throw workProviderStop("Provider continuation changed its original work plan");
  return { ...original, providerResumptionHash: contentHash(recovery),
    providerResumption: { originalSessionId: recovery.originalSessionId, ...(recovery.draft === undefined ? {} : { draft: recovery.draft }),
      requiredSourceSegmentIds: recovery.requiredSourceSegmentIds, requiredArtifactRefs: recovery.requiredArtifactRefs,
      ...(recovery.requiredArtifactRevisions ? { requiredArtifactRevisions: recovery.requiredArtifactRevisions } : {}) },
    limits: recovery.limits, priorUsage: recovery.priorUsage, budgetPolicy: consumerReviewRecoveryBudgetPolicy,
    authorizationRef: recovery.request.authorizationRef, retainedFiles: [...original.retainedFiles, ...recovery.retainedFiles] };
}

/** Exactly one continuation of an empty quota refusal after successful read-only
 * work. The old draft, full transcript and all charges remain immutable. A draft
 * is confirmed by Pi, never converted into a host-authored semantic judgment. */
export async function prepareWorkProviderResumption(root: string, scope: ConsumerRevalidationScope,
  original: { plan: ConsumerWorkPlan; directory: string }, requested?: ConsumerProviderResumption) {
  const { plan, directory: old } = original, stage = plan.stage, scopeHash = contentHash(scope);
  const directory = consumerWorkProviderDirectory(old, stage), savedRaw = await maybeRecoveryFile(path.join(directory, "recovery.json"));
  const saved = savedRaw ? consumerWorkProviderRecoverySchema.parse(savedRaw) : undefined;
  const request = consumerProviderResumptionSchema.parse(requested ?? saved?.request);
  if (request.scopeHash !== scopeHash || request.stage !== stage || request.authorizationRef === scope.authorizationRef
    || plan.scopeHash !== scopeHash || plan.bindingRecoveryHash || plan.providerResumptionHash
    || saved && contentHash(request) !== contentHash(saved.request))
    throw workProviderStop("The exact original stage and later user authorization are required");
  for (const suffix of ["proposal", "record", "session-checkpoint"])
    if (await maybeRecoveryFile(path.join(old, `${stage}.${suffix}.json`))) throw workProviderStop("Original stage already submitted; recover only its sealed registration");
  await assertConsumerWorkRetained(plan);
  const get = (suffix: string) => read(path.join(old, `${stage}.${suffix}.json`));
  const [input, invocation, budget, failure] = await Promise.all(["input", "invocation", "budget", "failure"].map(get));
  const planHash = contentHash(plan);
  if (failure.reason !== `Error: ${identityQuotaRefusal}` || contentHash(input) !== contentHash(consumerWorkInput(plan))
    || invocation.scopeHash !== scopeHash || invocation.stage !== stage || invocation.executionPlanHash !== planHash
    || !Number.isSafeInteger(invocation.pid) || invocation.pid <= 0
    || budget.scopeHash !== scopeHash || budget.stage !== stage || budget.executionPlanHash !== planHash
    || budget.originalBudgetHash !== scope.originalBudgetHash || budget.state.blocked || budget.state.failure
    || contentHash(budget.limits) !== contentHash(plan.limits) || contentHash(budget.policy) !== contentHash(workBudgetPolicy(plan))
    || contentHash(budget.priorUsage) !== contentHash(plan.priorUsage)
    || contentHash(budget.state.usage) !== contentHash(failure.usage?.usage))
    throw workProviderStop("Original quota failure, input or budget changed");
  if (!failure.sessionId || typeof failure.sessionFile !== "string" || !failure.sessionFile.startsWith(path.join(old, "sessions", stage) + path.sep)
    || await fs.realpath(failure.sessionFile) !== failure.sessionFile) throw workProviderStop("Original session ownership changed");
  const [transcript, requests, messages] = await Promise.all([fs.readFile(failure.sessionFile, "utf8"),
    fs.readFile(path.join(old, `${stage}.requests.jsonl`), "utf8"), fs.readFile(path.join(old, `${stage}.messages.jsonl`), "utf8")]);
  const proof = verifyWorkQuotaRefusedSession(transcript, root, { sessionId: failure.sessionId, provider: "openai-codex", model: "gpt-6.1-sol" },
    JSON.stringify(input), requests, messages, consumerWorkContract);
  verifyConsumerWorkProgress(plan, budget.state, proof.messages);
  const usage = budget.state.usage, sizes = proof.payloads.map(p => Buffer.byteLength(JSON.stringify(p)));
  const priorUsage = { modelCalls: plan.priorUsage.modelCalls + usage.modelCalls, totalPayloadBytes: plan.priorUsage.totalPayloadBytes + usage.totalPayloadBytes };
  if (sizes.length !== usage.payloads || proof.transcript.responses !== usage.modelCalls
    || sizes.reduce((a, b) => a + b, 0) !== usage.totalPayloadBytes
    || Math.max(...sizes, ...proof.contexts.map(c => Buffer.byteLength(JSON.stringify(c)))) !== usage.largestRequestBytes
    || contentHash(priorUsage) !== contentHash(budget.cumulative) || usage.largestRequestBytes > plan.limits.maxRequestBytes)
    throw workProviderStop("Original charges differ from the actual Pi requests");
  const traces = new TraceStore(root), runs = await traces.peekRunsByOperation(scope.sourceId, `receipt-bound-${scopeHash}-${stage}-work-v1`);
  const run = runs[0];
  if (runs.length !== 1 || !run || run.id !== request.failedTraceRunId || run.status !== "failed" || !run.endedAt
    || !(Date.parse(request.authorizedAt) > Date.parse(run.endedAt) && Date.parse(request.authorizedAt) <= Date.now()))
    throw workProviderStop("Original trace is unsettled or lacks later authorization");
  const events = await traces.peekEvents(run.id), starts = events.filter(e => e.type === "llm.request.started");
  const replies = events.filter(e => e.type === "llm.response.completed" || e.type === "llm.response.failed");
  const errors = events.filter(e => e.type === "llm.response.failed"), failed = errors[0];
  const bindings = events.filter(e => e.type === "stage.started" && e.data?.phase === stage && e.data?.scopeHash === scopeHash);
  const zero = (v: any) => v && ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"].every(k => v[k] === 0);
  if (bindings.length !== 1 || bindings[0]!.data?.sessionId !== failure.sessionId || bindings[0]!.data?.inputHash !== contentHash(input)
    || starts.length !== usage.modelCalls || replies.length !== starts.length || errors.length !== 1
    || !failed || failed !== replies.at(-1) || failed.callId !== starts.at(-1)?.callId || failed.data?.errorMessage !== identityQuotaRefusal
    || failed.data?.stopReason !== "error" || !zero(failed.data?.usage)
    || starts.some(e => e.data?.providerId !== "openai-codex" || e.data?.modelId !== "gpt-6.1-sol")
    || replies.some((e, i) => e.callId !== starts[i]?.callId || e.seq <= starts[i]!.seq || starts[i + 1] && e.seq >= starts[i + 1]!.seq)
    || run.counts.llmRequests !== usage.modelCalls || run.counts.toolCalls !== proof.transcript.toolResults || run.counts.retries !== 0
    || events.some(e => e.type === "llm.retry" || e.type === "tool.call.failed" || e.type.startsWith("tool.") && (e.callId === failed.callId || e.seq > starts.at(-1)!.seq))
    || events.at(-1)?.type !== "run.failed") throw workProviderStop("Original quota refusal lost its complete request/tool trace");
  const previews = proof.messages.filter(m => m.role === "toolResult" && m.toolName === "preview_consumer_revalidation");
  let draft: unknown;
  for (const preview of previews) {
    if (preview.role !== "toolResult") continue;
    const value = JSON.parse(preview.content.find(b => b.type === "text")!.text);
    const call = proof.messages.flatMap(m => m.role === "assistant" ? m.content.flatMap(b => b.type === "toolCall" && b.id === preview.toolCallId ? [b] : []) : [])[0];
    if (!value.valid || !call || value.draftHash !== contentHash(call.arguments)) throw workProviderStop("Original preview lost its exact draft");
    const retained = await get(`draft-${value.draftHash}`);
    if (retained.workKey !== plan.workKey || contentHash(retained.output) !== value.draftHash) throw workProviderStop("Original validated draft changed");
    draft = retained.output;
  }
  const reads = consumerEvidenceReads(proof.messages);
  const consumed = workBudgetPolicy(plan).modelCallsMode === "progress" ? usage.modelCalls - budget.state.progress.lastProgressCall : usage.modelCalls;
  const limits = { maxModelCalls: Math.max(0, plan.limits.maxModelCalls - consumed), maxRequestBytes: plan.limits.maxRequestBytes,
    maxTotalPayloadBytes: Math.max(0, plan.limits.maxTotalPayloadBytes - usage.totalPayloadBytes) };
  if (limits.maxModelCalls < 2 || limits.maxTotalPayloadBytes < 2 * Buffer.byteLength(JSON.stringify(input)))
    throw workProviderStop("Original remaining allowance cannot cover fresh evidence and a separate submission");
  const files = [path.join(path.dirname(old), "scope.json"), failure.sessionFile];
  for (const name of (await fs.readdir(old)).sort()) if (name.startsWith(stage + ".") && (await fs.stat(path.join(old, name))).isFile()) files.push(path.join(old, name));
  const retainedFiles = await Promise.all(files.map(async file => ({ path: file, hash: contentHash(await fs.readFile(file, "utf8")) })));
  const recovery = consumerWorkProviderRecoverySchema.parse({ version: 1, policy: "consumer-work-provider-resumption/v1", request,
    originalPlanHash: planHash, originalInputHash: contentHash(input), originalSessionId: failure.sessionId,
    traceHash: contentHash({ run, events }), retainedFiles, priorUsage, limits, ...(draft === undefined ? {} : { draft }),
    requiredSourceSegmentIds: [...reads.sourceIds].sort(), requiredArtifactRefs: [...reads.artifacts.completed].sort(),
    ...(reads.artifacts.subjects.size ? { requiredArtifactRevisions: [...reads.artifacts.subjects.values()].map(({ ref, revisionHash }) => ({ ref, revisionHash })).sort((a, b) => a.ref.localeCompare(b.ref)) } : {}),
    parentResumeAllowed: false });
  if (saved && contentHash(saved) !== contentHash(recovery)) throw workProviderStop("Frozen provider continuation changed; no replacement proof");
  const resumed = deriveWorkProviderPlan(plan, recovery), frozen = await maybeRecoveryFile(path.join(directory, `${stage}.plan.json`));
  if (frozen && contentHash(frozen) !== contentHash(resumed)) throw workProviderStop("Frozen continuation plan changed");
  return { plan: resumed, directory, migrated: true, recovery };
}

export async function verifyRecordedWorkProviderResumption(root: string, record: ConsumerRevalidationRecord) {
  const recovery = consumerWorkProviderRecoverySchema.parse(await read(path.join(consumerWorkRecordDirectory(root, record), "recovery.json")));
  if (!record.providerResumptionHash || contentHash(recovery) !== record.providerResumptionHash
    || record.sessionId === recovery.originalSessionId || record.traceRunId === recovery.request.failedTraceRunId)
    throw workProviderStop("Continuation record lost its original failure and fresh session binding");
  const original = await verifyRecordedConsumerWork(root, { ...record, providerResumptionHash: undefined, executionPlanHash: recovery.originalPlanHash });
  return prepareWorkProviderResumption(root, record.scope, original);
}
