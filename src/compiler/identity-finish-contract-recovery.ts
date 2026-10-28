import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash as h } from "../world/canonical.js";
import { ENTRY_CONTRACT_VERSION } from "../world/entry-contract.js";
import { TraceStore } from "../trace/store.js";
import type { UpstreamRepairPlan } from "./upstream-repair-plan.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { verifyUnsubmittedIdentitySession } from "./identity-session-integrity.js";
import { FINISH_REVISION_DRAFT, FINISH_REVISION_ACCEPTANCE, FINISH_REVISION_LIMITS, finishRevisionContract,
  readIdentityFinishRevision, assertIdentityFinishRevisionRetained, identityFinishRevisionContext } from "./identity-finish-revision.js";

export const ENTRY_CONTRACT_RECOVERY_STAGE = "finish-revision-contract-recovery";
const intentFile = `${ENTRY_CONTRACT_RECOVERY_STAGE}.intent.json`;
const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
const maybe = async (file: string) => { try { return await read(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; } };
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const limits = z.object({ maxModelCalls: z.number().int().positive(), maxRequestBytes: z.number().int().positive(), maxTotalPayloadBytes: z.number().int().positive() }).strict();
const recoverySchema = z.object({ version: z.literal(1), policy: z.literal("identity-entry-contract-recovery/v1"),
  taskId: hash, planHash: hash, finishRevisionIntentHash: hash, authorizationRef: z.string().trim().min(1),
  previousContextHash: hash, contextHash: hash, targetContract: z.literal("entry-capability/v2"),
  limits, traceRunId: z.string().min(1), traceHash: hash,
  retainedFiles: z.array(z.object({ path: z.string().min(1), hash }).strict()).min(1),
}).strict();
export type IdentityEntryContractRecovery = z.infer<typeof recoverySchema>;

export async function readIdentityEntryContractRecovery(directory: string) {
  const value = await maybe(path.join(directory, intentFile));
  return value ? recoverySchema.parse(value) : null;
}

export function remainingEntryRevisionLimits(usage: { modelCalls: number; totalPayloadBytes: number }) {
  if (!Number.isSafeInteger(usage.modelCalls) || usage.modelCalls < 1 || !Number.isSafeInteger(usage.totalPayloadBytes) || usage.totalPayloadBytes < 1)
    throw prerequisiteStop("Original opening draft usage is invalid; preserve its budget, no recovery or reset");
  const remaining = { ...FINISH_REVISION_LIMITS, maxModelCalls: Math.min(2, FINISH_REVISION_LIMITS.maxModelCalls - usage.modelCalls),
    maxTotalPayloadBytes: FINISH_REVISION_LIMITS.maxTotalPayloadBytes - usage.totalPayloadBytes };
  if (remaining.maxModelCalls < 2 || remaining.maxTotalPayloadBytes <= 0)
    throw prerequisiteStop("Original opening draft has insufficient remaining allowance for a full read and submission; no renewed budget or dispatch");
  return remaining;
}

/** Discovery is not admission: a changed schema needs explicit authority and
 * full verification of the stopped session before any new model request. */
export async function inspectEntryContractRecoveryCandidate(directory: string) {
  const context = await maybe(path.join(directory, `${FINISH_REVISION_DRAFT}.context.json`));
  const budget = await maybe(path.join(directory, `${FINISH_REVISION_DRAFT}.budget.json`));
  if (!context || !budget || context.entryContractReview?.contractVersion === ENTRY_CONTRACT_VERSION) return null;
  return { previousContextHash: h(context), targetContract: ENTRY_CONTRACT_VERSION,
    remainingLimits: { ...FINISH_REVISION_LIMITS, maxModelCalls: Math.min(2, FINISH_REVISION_LIMITS.maxModelCalls - budget.state.usage.modelCalls),
      maxTotalPayloadBytes: FINISH_REVISION_LIMITS.maxTotalPayloadBytes - budget.state.usage.totalPayloadBytes },
    executionAuthority: false, requiresExplicitAuthorization: true };
}

export async function assertIdentityEntryContractRecovery(root: string, plan: UpstreamRepairPlan, directory: string, recovery: IdentityEntryContractRecovery) {
  recoverySchema.parse(recovery);
  const intent = await readIdentityFinishRevision(directory);
  if (!intent || h(intent) !== recovery.finishRevisionIntentHash || plan.planHash !== recovery.planHash || intent.taskId !== recovery.taskId)
    throw prerequisiteStop("Entry contract recovery lost its original finish revision; no replacement authority or retry");
  await assertIdentityFinishRevisionRetained(root, plan, directory, intent);
  for (const file of recovery.retainedFiles) {
    const location = path.resolve(directory, file.path);
    if (!location.startsWith(directory + path.sep) || await fs.realpath(location) !== location || h(await fs.readFile(location, "utf8")) !== file.hash)
      throw prerequisiteStop("Entry contract recovery changed a retained failure, context, session or budget; no dispatch or replay");
  }
  const budget = await read(path.join(directory, `${FINISH_REVISION_DRAFT}.budget.json`));
  if (h(recovery.limits) !== h(remainingEntryRevisionLimits(budget.state.usage)))
    throw prerequisiteStop("Entry contract recovery changed the original remaining allowance; no budget reset");
  const traces = new TraceStore(root);
  if (h({ run: await traces.peekRun(recovery.traceRunId), events: await traces.peekEvents(recovery.traceRunId) }) !== recovery.traceHash)
    throw prerequisiteStop("Entry contract recovery lost its settled original trace; preserve history, no retry");
}

/** One explicitly authorized contract transition, within the original unused
 * allowance. Never re-open a failed recovery or change any novel evidence. */
export async function prepareIdentityEntryContractRecovery(root: string, plan: UpstreamRepairPlan, directory: string,
  request: { previousContextHash: string; authorizationRef: string }) {
  const existing = await readIdentityEntryContractRecovery(directory);
  if (existing) {
    if (existing.previousContextHash !== request.previousContextHash || existing.authorizationRef !== request.authorizationRef)
      throw prerequisiteStop("Entry contract recovery is already bound; inspect the same source/task finishRevisionProgress, no renamed authority or retry");
    await assertIdentityEntryContractRecovery(root, plan, directory, existing); return existing;
  }
  const intent = await readIdentityFinishRevision(directory);
  if (!intent || !request.authorizationRef.trim()) throw prerequisiteStop("Entry contract recovery requires the original revision and explicit authorization; no inferred grant");
  const state = await assertIdentityFinishRevisionRetained(root, plan, directory, intent);
  const current = state.plans.find(p => p.plan.planHash === plan.planHash);
  if (current?.state !== "needs-host-review" || current.finishedReceipt || current.finishRevision
    || state.modelSessions?.some(s => !s.closed) || state.attempts.some(a => !a.staged && !a.failed))
    throw prerequisiteStop("Entry contract recovery requires the original settled pre-receipt stop; no recovery of pending writes or completed work");
  for (const name of [`${FINISH_REVISION_DRAFT}.proposal.json`, `${FINISH_REVISION_DRAFT}.session-checkpoint.json`, "finish-revision.proof.json",
    `${FINISH_REVISION_ACCEPTANCE}.invocation.json`, `${ENTRY_CONTRACT_RECOVERY_STAGE}.invocation.json`])
    if (await maybe(path.join(directory, name))) throw prerequisiteStop("Entry contract recovery is consumed or has a prior submission/review; no redispatch");
  const old = await read(path.join(directory, `${FINISH_REVISION_DRAFT}.context.json`));
  if (h(old) !== request.previousContextHash)
    throw prerequisiteStop("Copy finishRevisionProgress.contractRecoveryCandidate.previousContextHash from inspect-identity-repairs in this source/task and correct once; no guessed context or unchanged retry");
  const context = await identityFinishRevisionContext(root, plan, intent);
  if (old.entryContractReview?.contractVersion === ENTRY_CONTRACT_VERSION || context.entryContractReview?.contractVersion !== ENTRY_CONTRACT_VERSION
    || context.entryContractReview.dispatch === "blocked" || h(old.originalToolSchema) === h(context.originalToolSchema)
    || h({ intent: old.intent, writableFields: old.writableFields, dependencies: old.dependencies, source: old.source })
      !== h({ intent: context.intent, writableFields: context.writableFields, dependencies: context.dependencies, source: context.source }))
    throw prerequisiteStop("Entry contract recovery requires a changed entry contract with identical source, dependencies and writable scope; no unchanged retry or scope expansion");
  const failure = await read(path.join(directory, `${FINISH_REVISION_DRAFT}.failure.json`));
  const budget = await read(path.join(directory, `${FINISH_REVISION_DRAFT}.budget.json`));
  const input = await read(path.join(directory, `${FINISH_REVISION_DRAFT}.input.json`));
  const traces = new TraceStore(root), runs = await traces.peekRunsByOperation(plan.sourceScope.sourceId,
    `identity-upstream-${intent.taskId}-${FINISH_REVISION_DRAFT}`), run = runs[0];
  if (runs.length !== 1 || run?.status !== "failed" || !run.endedAt || run.counts.retries
    || !failure.error?.includes("Opening revision has no supported submitted correction")
    || !failure.sessionFile?.startsWith(path.join(directory, "sessions", FINISH_REVISION_DRAFT) + path.sep)
    || await fs.realpath(failure.sessionFile) !== failure.sessionFile || h(input.intent) !== h(intent) || input.contextHash !== h(old))
    throw prerequisiteStop("Entry contract recovery requires the unique settled no-proposal Pi revision and its exact context; no retry");
  const events = await traces.peekEvents(run.id);
  const { verifyInvocationBudget } = await import("./identity-requirement-acceptance.js");
  const invocation = await verifyInvocationBudget(root, plan, FINISH_REVISION_DRAFT, events, FINISH_REVISION_LIMITS);
  const provenance = events.filter(e => e.type === "stage.started" && e.data?.phase === "identity-upstream-slot");
  const reads = events.filter(e => e.type === "tool.call.completed" && e.data?.toolName === finishRevisionContract.readTools[0]);
  if (invocation.finishRevisionIntentHash !== h(intent) || !reads.length || provenance.length !== 1
    || provenance[0]!.data?.sessionId !== failure.sessionId || provenance[0]!.data?.planHash !== plan.planHash
    || provenance[0]!.data?.inputHash !== h(JSON.stringify(input)) || provenance[0]!.data?.subscription !== true
    || events.some(e => e.type.startsWith("world.commit.") || e.type === "llm.response.failed" || e.type === "tool.call.failed"
      || e.type === "tool.call.started" && !finishRevisionContract.readTools.includes(String(e.data?.toolName))
      || e.type === "llm.request.started" && (e.data?.providerId !== "openai-codex" || e.data?.modelId !== "gpt-6.1-sol")))
    throw prerequisiteStop("Entry contract recovery lacks settled read-only subscription evidence; no dispatch");
  for (const event of reads) {
    const result = event.blobRef ? await traces.peekBlob(event.blobRef) as { content?: { type: string; text?: string }[] } : undefined;
    const text = result?.content?.filter(c => c.type === "text").map(c => c.text ?? "").join("");
    if (!text || h(JSON.parse(text)) !== h(old)) throw prerequisiteStop("Original Pi revision did not read its exact complete context; no recovery");
  }
  const proof = verifyUnsubmittedIdentitySession(await fs.readFile(failure.sessionFile, "utf8"), root,
    { sessionId: failure.sessionId, provider: "openai-codex", model: "gpt-6.1-sol" }, JSON.stringify(input),
    await fs.readFile(path.join(directory, `${FINISH_REVISION_DRAFT}.requests.jsonl`), "utf8"),
    await fs.readFile(path.join(directory, `${FINISH_REVISION_DRAFT}.messages.jsonl`), "utf8"), finishRevisionContract);
  const sizes = proof.payloads.map(v => Buffer.byteLength(JSON.stringify(v))), usage = budget.state.usage;
  if (proof.transcript.responses !== usage.modelCalls || sizes.length !== usage.payloads || sizes.reduce((a, b) => a + b, 0) !== usage.totalPayloadBytes
    || Math.max(...sizes, ...proof.contexts.map(c => Buffer.byteLength(JSON.stringify(c)))) !== usage.largestRequestBytes
    || h(failure.usage.usage) !== h(usage)) throw prerequisiteStop("Original no-proposal usage differs from actual Pi requests; no recovery or reset");
  const files = ["finish-revision.intent.json", ...["context.json", "invocation.json", "input.json", "failure.json", "budget.json", "messages.jsonl", "requests.jsonl"]
    .map(suffix => `${FINISH_REVISION_DRAFT}.${suffix}`), path.relative(directory, failure.sessionFile)];
  return recoverySchema.parse({ version: 1, policy: "identity-entry-contract-recovery/v1", taskId: intent.taskId, planHash: plan.planHash,
    finishRevisionIntentHash: h(intent), authorizationRef: request.authorizationRef, previousContextHash: h(old), contextHash: h(context),
    targetContract: ENTRY_CONTRACT_VERSION, limits: remainingEntryRevisionLimits(usage), traceRunId: run.id, traceHash: h({ run, events }),
    retainedFiles: await Promise.all(files.map(async file => ({ path: file, hash: h(await fs.readFile(path.join(directory, file), "utf8")) }))) });
}
