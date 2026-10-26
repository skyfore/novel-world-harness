import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { TraceStore } from "../trace/store.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { verifyUnsubmittedIdentitySession, type IdentitySessionContract } from "./identity-session-integrity.js";
import { consumerRevalidationDirectory, type ConsumerRevalidationScope } from "./identity-consumer-revalidation-model.js";
import { consumerRevalidationLimits } from "./identity-consumer-correction.js";
import { consumerRecoveryLimits, inspectConsumerBudgetAmendment, type ConsumerBudgetAmendment } from "./identity-consumer-budget-amendment.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/), count = z.number().int().nonnegative();
const totals = z.object({ modelCalls: count, totalPayloadBytes: count }).strict();
export const consumerStageRecoverySchema = z.object({ version: z.literal(1), policy: z.literal("consumer-unsubmitted-continuation/v1"),
  scopeHash: hash, stage: z.enum(["consumer-revalidation", "consumer-revalidation-check"]),
  authorizationRef: z.string().min(1), originalSessionId: z.string().min(1), originalTraceRunId: z.string().min(1),
  originalInputHash: hash, traceHash: hash, contractHash: hash,
  retainedFiles: z.array(z.object({ path: z.string().min(1), hash }).strict()).min(7),
  priorUsage: totals, limits: z.object({ maxModelCalls: count, maxRequestBytes: count, maxTotalPayloadBytes: count }).strict(),
  priorReadFailures: count.max(1), failedReadRequests: z.array(z.unknown()), pendingArtifactRefs: z.array(z.string()),
  minimumModelCalls: z.literal(2),
}).strict();
export type ConsumerStageRecovery = z.infer<typeof consumerStageRecoverySchema>;
export const consumerStageRecoveryDirectory = (directory: string, stage: string) => path.join(directory, `${stage}.continuation`);
const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
export const maybeRecoveryFile = async (file: string) => {
  try { return await read(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
};

/** Charges from every segment stay under the original scope and stage. */
export async function consumerStageUsage(directory: string, stage: string) {
  const total = { modelCalls: 0, totalPayloadBytes: 0 };
  for (const dir of [directory, consumerStageRecoveryDirectory(directory, stage)]) {
    const budget = await maybeRecoveryFile(path.join(dir, `${stage}.budget.json`));
    if (budget) { total.modelCalls += budget.state.usage.modelCalls; total.totalPayloadBytes += budget.state.usage.totalPayloadBytes; }
  }
  return total;
}

const canonicalRef = (ref: string) => ref.includes(":") ? ref : ref.replace("/", ":");

/** Inspect only a settled, read-only, never-submitted failure. A fresh linked
 * segment must re-read evidence; old discovery/read receipts grant no clearance.
 * Two calls is a lower bound (read, then sole submission), never a promise of completion. */
export async function prepareConsumerStageRecovery(root: string, scope: ConsumerRevalidationScope,
  stage: ConsumerStageRecovery["stage"], contract: IdentitySessionContract) {
  const directory = consumerRevalidationDirectory(root, scope), scopeHash = contentHash(scope);
  const get = (suffix: string) => read(path.join(directory, `${stage}.${suffix}`));
  if (await maybeRecoveryFile(path.join(directory, `${stage}.session-checkpoint.json`))
    || await maybeRecoveryFile(path.join(directory, `${stage}.record.json`)) || await maybeRecoveryFile(path.join(directory, `${stage}.proposal.json`)))
    throw prerequisiteStop("This stage already has a submission/checkpoint; recover its original registration, no unsubmitted continuation");
  const [failure, invocation, budget, input] = await Promise.all(["failure.json", "invocation.json", "budget.json", "input.json"].map(get));
  const limits = await consumerRevalidationLimits(root, scope, stage);
  if (contentHash(await read(path.join(directory, "scope.json"))) !== scopeHash
    || invocation.scopeHash !== scopeHash || invocation.stage !== stage || !Number.isSafeInteger(invocation.pid) || invocation.pid <= 0
    || budget.scopeHash !== scopeHash || budget.stage !== stage || budget.originalBudgetHash !== scope.originalBudgetHash
    || contentHash(budget.limits) !== contentHash(limits) || budget.state.blocked || budget.state.failure
    || failure.reason !== String(prerequisiteStop("Pi returned without a revalidation submission; preserve failure and budget, no new invocation"))
    || contentHash(failure.usage.usage) !== contentHash(budget.state.usage))
    throw prerequisiteStop("Unsubmitted continuation lost its exact settled failure, scope or remaining budget; preserve the originals, no retry or reset");
  const sessionFile = failure.sessionFile;
  if (typeof sessionFile !== "string" || !sessionFile.startsWith(path.join(directory, "sessions", stage) + path.sep)
    || await fs.realpath(sessionFile) !== sessionFile)
    throw prerequisiteStop("Failed Pi session is outside its original stage; no continuation or guessed session");
  const [transcript, requests, messages] = await Promise.all([fs.readFile(sessionFile, "utf8"),
    fs.readFile(path.join(directory, `${stage}.requests.jsonl`), "utf8"), fs.readFile(path.join(directory, `${stage}.messages.jsonl`), "utf8")]);
  const proof = verifyUnsubmittedIdentitySession(transcript, root, { sessionId: failure.sessionId, provider: "openai-codex", model: "gpt-6.1-sol" },
    JSON.stringify(input), requests, messages, contract);
  const usage = budget.state.usage, sizes = proof.payloads.map(p => Buffer.byteLength(JSON.stringify(p)));
  if (proof.transcript.responses !== usage.modelCalls || sizes.length !== usage.payloads
    || sizes.reduce((a, b) => a + b, 0) !== usage.totalPayloadBytes
    || Math.max(...sizes, ...proof.contexts.map(c => Buffer.byteLength(JSON.stringify(c)))) !== usage.largestRequestBytes
    || usage.modelCalls > limits.maxModelCalls || usage.totalPayloadBytes > limits.maxTotalPayloadBytes || usage.largestRequestBytes > limits.maxRequestBytes)
    throw prerequisiteStop("Failed stage charges disagree with its actual Pi requests; retain every charge, no continuation");
  const traces = new TraceStore(root), candidates = (await traces.peekRuns({ sourceId: scope.sourceId, limit: 1000 }))
    .filter(r => r.operationId === `receipt-bound-${scopeHash}-${stage}`);
  const run = candidates[0];
  if (candidates.length !== 1 || !run || run.status !== "failed" || !run.endedAt)
    throw prerequisiteStop("Original failed trace is missing, ambiguous or unsettled; inspect its owning operation, no continuation");
  const events = await traces.peekEvents(run.id);
  if (!events.some(e => e.type === "stage.started" && e.data?.sessionId === failure.sessionId && e.data?.inputHash === contentHash(input)))
    throw prerequisiteStop("Failed session is detached from its original trace/input; no continuation");
  const calls = new Map<string, unknown>(), failedReadRequests: unknown[] = [], requested = new Set<string>(), completed = new Set<string>();
  for (const message of proof.messages) {
    if (message.role === "assistant") for (const b of message.content) if (b.type === "toolCall") calls.set(b.id, b.arguments);
    if (message.role !== "toolResult") continue;
    const raw = calls.get(message.toolCallId) as { collection?: string; refs?: string[] };
    if (message.isError) {
      if (message.content.some(b => b.type === "text" && b.text.includes("ROLE_PREREQUISITE_HOST_REVIEW")))
        throw prerequisiteStop("Original read hit a host/scope stop, not a recoverable discovery error; no continuation");
      failedReadRequests.push(raw);
      if (raw.collection === "artifacts") raw.refs?.forEach(ref => requested.add(canonicalRef(ref)));
    } else if (raw.collection === "artifacts" && raw.refs) raw.refs.forEach(ref => completed.add(canonicalRef(ref)));
  }
  if (failedReadRequests.length > 1) throw prerequisiteStop("Original read correction allowance is exhausted; preserve the circuit breaker, no continuation");
  const priorUsage = { ...scope.priorUsage };
  if (stage === "consumer-revalidation-check") {
    const previous = await consumerStageUsage(directory, "consumer-revalidation");
    priorUsage.modelCalls += previous.modelCalls; priorUsage.totalPayloadBytes += previous.totalPayloadBytes;
  }
  if (contentHash(budget.priorUsage) !== contentHash(priorUsage)
    || contentHash(budget.cumulative) !== contentHash({ modelCalls: priorUsage.modelCalls + usage.modelCalls, totalPayloadBytes: priorUsage.totalPayloadBytes + usage.totalPayloadBytes }))
    throw prerequisiteStop("Failed consumer stage reset inherited charges; no continuation");
  priorUsage.modelCalls += usage.modelCalls; priorUsage.totalPayloadBytes += usage.totalPayloadBytes;
  const names = ["scope.json", path.relative(directory, sessionFile), ...(await fs.readdir(directory)).filter(n => n.startsWith(`${stage}.`) && !n.endsWith(".continuation"))].sort();
  const retainedFiles = await Promise.all(names.map(async name => {
    const file = path.join(directory, name);
    if (name.endsWith(".tmp") || await fs.realpath(file) !== file || !(await fs.stat(file)).isFile()) throw prerequisiteStop("Failed stage contains an unexpected or unsettled retained file; no continuation");
    return { path: name, hash: contentHash(await fs.readFile(file, "utf8")) };
  }));
  return consumerStageRecoverySchema.parse({ version: 1, policy: "consumer-unsubmitted-continuation/v1", scopeHash, stage,
    authorizationRef: scope.authorizationRef, originalSessionId: failure.sessionId, originalTraceRunId: run.id,
    originalInputHash: contentHash(input), traceHash: contentHash({ run, events }), contractHash: contentHash(contract), retainedFiles,
    priorUsage, limits: { ...limits, maxModelCalls: limits.maxModelCalls - usage.modelCalls, maxTotalPayloadBytes: limits.maxTotalPayloadBytes - usage.totalPayloadBytes },
    priorReadFailures: failedReadRequests.length, failedReadRequests, pendingArtifactRefs: [...requested].filter(ref => !completed.has(ref)), minimumModelCalls: 2 });
}

export function consumerRecoveryPreflight(plan: ConsumerStageRecovery, amendment?: ConsumerBudgetAmendment) {
  const limits = consumerRecoveryLimits(plan, amendment);
  const ready = limits.maxModelCalls >= plan.minimumModelCalls && limits.maxTotalPayloadBytes > 0;
  return { status: ready ? "ready" as const : "budget-blocked" as const, scopeHash: plan.scopeHash, stage: plan.stage,
    continuationHash: contentHash(plan), remainingAllowance: limits, minimumModelCalls: plan.minimumModelCalls,
    ...(amendment ? { budgetAmendmentHash: contentHash(amendment), budgetAmendment: amendment.request, originalRemainingAllowance: plan.limits } : {}),
    pendingArtifactRefs: plan.pendingArtifactRefs, cumulative: plan.priorUsage, modelDispatchAllowed: ready,
    reason: ready ? amendment ? "Explicit call amendment permits this original fresh evidence-read and sole-submission segment; original byte caps and single-use gate still apply."
      : "Remaining original allowance permits starting a fresh evidence-read and sole-submission segment; actual byte/call gates still apply."
      : `Original stage has ${plan.limits.maxModelCalls} model calls remaining; at least ${plan.minimumModelCalls} are required for evidence reads followed by a separate submission. Preserve the failure and unused allowance; no borrowing from independent review, reset or dispatch.`,
    parentResumeAllowed: false, certificationGranted: false };
}

export const consumerRecoveryInput = (plan: ConsumerStageRecovery, amendment?: ConsumerBudgetAmendment) => ({ policy: plan.policy, continuationHash: contentHash(plan),
  ...(amendment ? { budgetAmendment: amendment, budgetAmendmentHash: contentHash(amendment) } : {}),
  originalSessionId: plan.originalSessionId, originalInputHash: plan.originalInputHash, failedReadRequests: plan.failedReadRequests,
  pendingArtifactRefs: plan.pendingArtifactRefs, priorReadFailures: plan.priorReadFailures,
  instructions: "Continue only this original unsubmitted review. Re-read all required source, consumer and selected artifact dependencies in this fresh Pi session. Earlier discovery/read receipts are history, not this session's evidence. Prior failed read allowance is retained. The submission must be the sole tool call after completed reads. Preserve original criteria, questions, identities, failures and budget; no world writes or parent resume." });

export function assertConsumerRecoveryInput(original: Record<string, unknown>, continued: Record<string, unknown>) {
  const stable = ({ artifactReadRefs: _discovery, continuation: _lineage, ...input }: Record<string, unknown>) => input;
  if (contentHash(stable(original)) !== contentHash(stable(continued)))
    throw prerequisiteStop("Continuation changed the original model input beyond corrected discovery metadata; preserve the original criteria and complete scope, no repinning");
}

export async function verifyConsumerStageRecovery(root: string, scope: ConsumerRevalidationScope, stage: ConsumerStageRecovery["stage"], expectedHash: string, contract: IdentitySessionContract, expectedAmendmentHash?: string) {
  const directory = consumerRevalidationDirectory(root, scope), saved = consumerStageRecoverySchema.parse(await read(path.join(consumerStageRecoveryDirectory(directory, stage), "continuation.json")));
  const amendment = await inspectConsumerBudgetAmendment(consumerStageRecoveryDirectory(directory, stage), saved);
  if (contentHash(saved) !== expectedHash || contentHash(await prepareConsumerStageRecovery(root, scope, stage, contract)) !== expectedHash
    || (amendment ? contentHash(amendment) : undefined) !== expectedAmendmentHash || !consumerRecoveryPreflight(saved, amendment).modelDispatchAllowed)
    throw prerequisiteStop("Continuation changed its exact original failure or has insufficient allowance; preserve both segments, no retry, repinning or new segment");
  return saved;
}
