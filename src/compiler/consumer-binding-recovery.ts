import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { TraceStore } from "../trace/store.js";
import { consumerWorkContract, consumerWorkInput, consumerReviewRecoveryBudgetPolicy, workBudgetPolicy, type ConsumerWorkPlan } from "./consumer-work-plan.js";
import { CONSUMER_REVIEW_BINDING, bindingRecoveryDirectory, bindingRecoveryStop, boundConsumerReviewSchema } from "./consumer-review-binding.js";
import { validateConsumerReviewAssessment } from "./consumer-review-contract.js";
import { validateConsumerRevalidationHistory, type ConsumerRevalidationRecord, type ConsumerRevalidationScope } from "./identity-consumer-revalidation-model.js";
import { verifyStoppedReadOnlyIdentitySession } from "./identity-session-integrity.js";
import { assertConsumerWorkRetained, verifyRecordedConsumerWork } from "./identity-consumer-work.js";
import { maybeRecoveryFile } from "./identity-consumer-stage-recovery.js";
import { resolveTextSelectorAnchor } from "./text-anchors.js";
import { SegmentStore } from "./segments.js";
import { RequirementLedger } from "./requirement-ledger.js";
import { consumerWorkRecordDirectory } from "./consumer-work-evidence.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/), count = z.number().int().nonnegative();
export const consumerBindingRecoverySchema = z.object({ version: z.literal(1), policy: z.literal("consumer-binding-recovery/v1"),
  scopeHash: hash, stage: z.literal("consumer-revalidation-check"), authorizationRef: z.string().trim().min(1),
  originalPlanHash: hash, originalInputHash: hash, originalSessionId: z.string().min(1), originalTraceRunId: z.string().min(1),
  proposalRecordHash: hash, rejectedPreviewHash: hash, traceHash: hash,
  retainedFiles: z.array(z.object({ path: z.string().min(1), hash }).strict()).min(9),
  priorUsage: z.object({ modelCalls: count, totalPayloadBytes: count }).strict(),
  limits: z.object({ maxModelCalls: count, maxRequestBytes: count, maxTotalPayloadBytes: count }).strict(),
  previewCorrectionsRemaining: z.literal(0), parentResumeAllowed: z.literal(false),
}).strict();
export type ConsumerBindingRecovery = z.infer<typeof consumerBindingRecoverySchema>;
const read = async (f: string) => JSON.parse(await fs.readFile(f, "utf8"));

export function deriveBindingRecoveryPlan(original: ConsumerWorkPlan, recovery: ConsumerBindingRecovery): ConsumerWorkPlan {
  if (original.stage !== recovery.stage || contentHash(original) !== recovery.originalPlanHash || original.scopeHash !== recovery.scopeHash
    || original.reviewBinding || original.bindingRecoveryHash) throw bindingRecoveryStop("Recovery changed the original unbound check plan");
  return { ...original, reviewBinding: CONSUMER_REVIEW_BINDING, bindingRecoveryHash: contentHash(recovery),
    limits: recovery.limits, priorUsage: recovery.priorUsage, budgetPolicy: consumerReviewRecoveryBudgetPolicy,
    authorizationRef: recovery.authorizationRef, retainedFiles: [...original.retainedFiles, ...recovery.retainedFiles] };
}

/** A one-time repair of exactly one rejected preview, before any submission.
 * All source/criteria, actual requests and original charges remain immutable.
 * The hypothetical corrected shape below proves eligibility only; it is never
 * registered, submitted or treated as semantic support. Pi must review again. */
export async function prepareConsumerBindingRecovery(root: string, scope: ConsumerRevalidationScope, original: { plan: ConsumerWorkPlan; directory: string },
  proposal: ConsumerRevalidationRecord, authorizationRef?: string) {
  const stage = "consumer-revalidation-check", old = original.directory, directory = bindingRecoveryDirectory(old), get = (suffix: string) => read(path.join(old, `${stage}.${suffix}`));
  const savedRaw = await maybeRecoveryFile(path.join(directory, "recovery.json"));
  const saved = savedRaw ? consumerBindingRecoverySchema.parse(savedRaw) : undefined;
  const authorization = authorizationRef ?? saved?.authorizationRef;
  if (!authorization?.trim() || saved && authorization !== saved.authorizationRef || authorization === scope.authorizationRef)
    throw bindingRecoveryStop("Original failed check requires its explicit later repair authorization");
  if (!scope.reviewContract || original.plan.stage !== stage || original.plan.reviewBinding || original.plan.bindingRecoveryHash
    || proposal.output.phase !== "consumer-revalidation" || contentHash(proposal.scope) !== contentHash(scope)) throw bindingRecoveryStop("Recovery requires the original unbound check and exact sealed proposal");
  for (const suffix of ["record.json", "proposal.json", "session-checkpoint.json"])
    if (await maybeRecoveryFile(path.join(old, `${stage}.${suffix}`))) throw bindingRecoveryStop("Original check already submitted; only sealed registration may be recovered");
  await assertConsumerWorkRetained(original.plan);
  const [input, invocation, budget, failure] = await Promise.all(["input.json", "invocation.json", "budget.json", "failure.json"].map(get));
  const scopeHash = contentHash(scope), planHash = contentHash(original.plan);
  if (contentHash(input) !== contentHash(consumerWorkInput(original.plan)) || input.scopeHash !== scopeHash || input.proposalHash !== contentHash(proposal.output)
    || invocation.scopeHash !== scopeHash || invocation.stage !== stage || invocation.executionPlanHash !== planHash
    || !Number.isSafeInteger(invocation.pid) || invocation.pid <= 0
    || budget.scopeHash !== scopeHash || budget.stage !== stage || budget.executionPlanHash !== planHash || budget.originalBudgetHash !== scope.originalBudgetHash
    || contentHash(budget.limits) !== contentHash(original.plan.limits) || contentHash(budget.policy) !== contentHash(workBudgetPolicy(original.plan))
    || contentHash(budget.priorUsage) !== contentHash(original.plan.priorUsage) || budget.state.blocked || budget.state.failure
    || contentHash(budget.state.usage) !== contentHash(failure.usage?.usage) || budget.state.progress?.lastProgressCall !== 0 || budget.state.progress?.milestones?.length !== 0)
    throw bindingRecoveryStop("Original failed check lost its frozen input, policy or unused progress allowance");
  if (!failure.sessionId || typeof failure.sessionFile !== "string" || !failure.sessionFile.startsWith(path.join(old, "sessions", stage) + path.sep)
    || await fs.realpath(failure.sessionFile) !== failure.sessionFile) throw bindingRecoveryStop("Original failed session ownership changed");
  const [transcript, requests, messages] = await Promise.all([fs.readFile(failure.sessionFile, "utf8"), fs.readFile(path.join(old, `${stage}.requests.jsonl`), "utf8"), fs.readFile(path.join(old, `${stage}.messages.jsonl`), "utf8")]);
  const proof = verifyStoppedReadOnlyIdentitySession(transcript, root, { sessionId: failure.sessionId, provider: "openai-codex", model: "gpt-6.1-sol" },
    JSON.stringify(input), requests, messages, consumerWorkContract, failure.reason.replace(/^Error: /u, ""), false);
  const calls = proof.messages.flatMap(m => m.role === "assistant" ? m.content.filter(b => b.type === "toolCall") : []);
  const errors = proof.messages.filter(m => m.role === "toolResult" && m.isError);
  if (calls.length !== 1 || calls[0]!.name !== "preview_consumer_revalidation" || errors.length !== 1
    || errors[0]!.role !== "toolResult" || errors[0]!.toolCallId !== calls[0]!.id || errors[0]!.toolName !== calls[0]!.name)
    throw bindingRecoveryStop("Only one rejected contract-binding preview is recoverable; reads, repeats or submissions remain stopped");
  const raw = calls[0]!.arguments as Record<string, unknown>, expected = contentHash(scope.reviewContract);
  if (raw.phase !== stage || raw.scopeHash !== scopeHash || raw.proposalHash !== input.proposalHash || raw.reviewContractHash === expected)
    throw bindingRecoveryStop("Original failure is not an isolated check-contract hash mismatch");
  let diagnostic: string | undefined;
  try { validateConsumerReviewAssessment(scope.reviewContract, raw as any); } catch (e) { diagnostic = String(e); }
  const failedPreview = await get(`failure-preview-${contentHash(raw)}.json`);
  if (!diagnostic || failure.reason !== diagnostic || failedPreview.reason !== diagnostic || contentHash(failedPreview.raw) !== contentHash(raw)
    || !errors[0]!.content.some(b => b.type === "text" && b.text.startsWith(diagnostic.replace(/^Error: /u, ""))))
    throw bindingRecoveryStop("Original preview diagnostic changed or another failure was hidden");
  const candidate = boundConsumerReviewSchema(scope, true, input.proposalHash).parse({ ...raw, reviewContractHash: expected });
  if (candidate.phase !== stage) throw bindingRecoveryStop("Check phase changed");
  const manifest = await new SegmentStore(root).readManifest(scope.sourceId);
  const evidence = await Promise.all(candidate.evidence.map(async selector => {
    const segment = manifest?.segments.find(s => s.id === selector.segment_id);
    if (!segment || !original.plan.sources.some(s => s.id === segment.id)) throw bindingRecoveryStop("Rejected preview escaped its complete source packet");
    return { selector, anchor: await resolveTextSelectorAnchor(root, segment, selector) };
  }));
  validateConsumerRevalidationHistory([proposal, { scope, output: candidate, evidence, inputHash: contentHash(input), predecessorRecordHash: contentHash(proposal),
    executionPlanHash: planHash, sessionId: failure.sessionId, traceRunId: "eligibility-only", sessionCheckpointHash: "0".repeat(64) }], await new RequirementLedger(root, scope.sourceId).identityRequirements(scope.taskId));
  const traces = new TraceStore(root), runs = await traces.peekRunsByOperation(scope.sourceId, `receipt-bound-${scopeHash}-${stage}-work-v1`), run = runs[0];
  if (runs.length !== 1 || !run || run.status !== "failed" || !run.endedAt) throw bindingRecoveryStop("Original check trace is unsettled or ambiguous");
  const events = await traces.peekEvents(run.id), started = events.filter(e => e.type === "stage.started" && e.data?.phase === stage && e.data?.scopeHash === scopeHash);
  if (started.length !== 1 || started[0]!.data?.sessionId !== failure.sessionId || started[0]!.data?.inputHash !== contentHash(input)
    || events.at(-1)?.type !== "run.failed") throw bindingRecoveryStop("Original failure lost its actual trace/input linkage");
  const sizes = proof.payloads.map(v => Buffer.byteLength(JSON.stringify(v))), usage = budget.state.usage;
  const priorUsage = { modelCalls: original.plan.priorUsage.modelCalls + usage.modelCalls, totalPayloadBytes: original.plan.priorUsage.totalPayloadBytes + usage.totalPayloadBytes };
  if (proof.transcript.responses !== usage.modelCalls || sizes.length !== usage.payloads || sizes.reduce((a, b) => a + b, 0) !== usage.totalPayloadBytes
    || Math.max(...sizes, ...proof.contexts.map(v => Buffer.byteLength(JSON.stringify(v)))) !== usage.largestRequestBytes
    || contentHash(priorUsage) !== contentHash(budget.cumulative) || usage.largestRequestBytes > original.plan.limits.maxRequestBytes)
    throw bindingRecoveryStop("Original failed check charges differ from actual provider requests");
  const limits = { maxModelCalls: Math.max(0, original.plan.limits.maxModelCalls - usage.modelCalls), maxRequestBytes: original.plan.limits.maxRequestBytes,
    maxTotalPayloadBytes: Math.max(0, original.plan.limits.maxTotalPayloadBytes - usage.totalPayloadBytes) };
  const retainedFiles = [];
  for (const name of (await fs.readdir(old)).sort()) if (name.startsWith(stage + ".") && (await fs.stat(path.join(old, name))).isFile()) {
    const file = path.join(old, name); retainedFiles.push({ path: file, hash: contentHash(await fs.readFile(file, "utf8")) });
  }
  retainedFiles.push({ path: failure.sessionFile, hash: contentHash(transcript) });
  const recovery = consumerBindingRecoverySchema.parse({ version: 1, policy: "consumer-binding-recovery/v1", scopeHash, stage, authorizationRef: authorization,
    originalPlanHash: planHash, originalInputHash: contentHash(input), originalSessionId: failure.sessionId, originalTraceRunId: run.id,
    proposalRecordHash: contentHash(proposal), rejectedPreviewHash: contentHash(raw), traceHash: contentHash({ run, events }), retainedFiles, priorUsage, limits,
    previewCorrectionsRemaining: 0, parentResumeAllowed: false });
  if (saved && contentHash(saved) !== contentHash(recovery)) throw bindingRecoveryStop("Frozen binding recovery changed; no replacement proof");
  const plan = deriveBindingRecoveryPlan(original.plan, recovery), frozenPlan = await maybeRecoveryFile(path.join(directory, `${stage}.plan.json`));
  if (frozenPlan && contentHash(frozenPlan) !== contentHash(plan)) throw bindingRecoveryStop("Frozen recovery execution plan changed");
  return { plan, directory, migrated: true, recovery };
}

export async function verifyRecordedBindingRecovery(root: string, record: ConsumerRevalidationRecord, proposal: ConsumerRevalidationRecord) {
  if (!record.executionPlanHash || !record.bindingRecoveryHash || record.output.phase !== "consumer-revalidation-check"
    || record.continuationHash || record.hostRecoveryHash || record.refRecoveryHash || record.budgetAmendmentHash)
    throw bindingRecoveryStop("Binding recovery cannot combine unrelated authorities");
  const directory = consumerWorkRecordDirectory(root, record);
  const recovery = consumerBindingRecoverySchema.parse(await read(path.join(directory, "recovery.json")));
  if (contentHash(recovery) !== record.bindingRecoveryHash || record.sessionId === recovery.originalSessionId || record.traceRunId === recovery.originalTraceRunId)
    throw bindingRecoveryStop("Binding recovery lost its exact independent continuation");
  const original = await verifyRecordedConsumerWork(root, { ...record, executionPlanHash: recovery.originalPlanHash, bindingRecoveryHash: undefined });
  const work = await prepareConsumerBindingRecovery(root, record.scope, original, proposal);
  if (contentHash(work.plan) !== record.executionPlanHash) throw bindingRecoveryStop("Sealed recovery plan changed");
  return work;
}
