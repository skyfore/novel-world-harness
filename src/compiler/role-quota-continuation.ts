import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { worldStorageRoot } from "../world/paths.js";
import { TraceStore } from "../trace/store.js";
import { WorkspaceOperationLock } from "../util/workspace-lock.js";
import { NovelCompilationRunStore } from "../workflow/novel-compilation.js";
import { inspectRoleReviewBudget, remainingRoleProgressCalls } from "./role-review-budget.js";
import { mutableRoleReview } from "./role-judgment-repair-service.js";
import { RoleReviewWorkStore, ROLE_CLAIM_AUDIT_TOOL, roleWorkStop } from "./role-review-work.js";

const inputSchema = z.object({
  sourceId: z.string().min(1), batchId: z.string().min(1), candidateId: z.string().min(1),
  runId: z.string().min(1), authorizationRef: z.string().min(1), implementationRef: z.string().min(1),
}).strict();
export type RoleQuotaContinuationInput = z.infer<typeof inputSchema>;
export type RoleQuotaResume = { policy: "quota-refusal"; planHash: string; workId: string; authorityHash: string };
const refusal = "Codex error: The usage limit has been reached";
const dispatchStop = roleWorkStop("context loop round already claimed; do not restart or reset counts").message;
const grantFile = (root: string, planHash: string, workId: string) => path.join(worldStorageRoot(root), "compiler",
  "role-review-work", "host-interruptions", "quota-refusal", planHash, `${contentHash(workId)}.json`);
const names = (dir: string): Promise<string[]> => fs.readdir(dir).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return [] as string[]; throw e; });
const json = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));

/** A manual dispatch repair after an explicit user resumption. The first
 * provider request was refused without output or tools; a normal restart then
 * reserved attempt 2 but stopped before claiming a new session. Reuse THAT
 * reservation once, without replacing either attempt or adding any allowance. */
async function inspect(root: string, raw: RoleQuotaContinuationInput) {
  const input = inputSchema.parse(raw), traces = new TraceStore(root);
  const plan = (await RoleReviewWorkStore.plans(root, input.sourceId)).find(p => p.batchId === input.batchId);
  if (!plan) throw roleWorkStop("quota continuation plan missing; discover with RoleReviewWorkStore.plans, copy batchId and correct once, never guess");
  const store = new RoleReviewWorkStore(root, plan);
  await mutableRoleReview(store);
  const workId = store.claimWorkId(input.candidateId), entry = store.stagedEntries().find(e => e.candidateId === input.candidateId);
  const inherited = store.inheritedAllowance(workId);
  if (!entry || workId !== store.originalClaimWorkId(input.candidateId)
    || store.journal.history(ROLE_CLAIM_AUDIT_TOOL, workId).length
    || inherited?.attempts || inherited?.contextSessions || inherited?.contextHandoffs || inherited?.nativeContextFallback
    || inherited?.budget?.state.blocked || inherited?.budget?.state.usage.modelCalls) {
    throw roleWorkStop("quota continuation requires an original unaudited claim without inherited consumption; do not retry changed or settled work");
  }
  const budget = inspectRoleReviewBudget(root, store.planHash, workId);
  const run = await traces.peekRun(input.runId), events = await traces.peekEvents(input.runId);
  const requests = events.filter(e => e.type === "llm.request.started");
  const failures = events.filter(e => e.type === "llm.response.failed");
  const zeroUsage = (value: unknown) => !!value && typeof value === "object"
    && ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"].every(k => (value as Record<string, unknown>)[k] === 0);
  if (run.kind !== "prepare" || run.status !== "failed" || !run.endedAt || run.sourceId !== input.sourceId || run.operationId !== input.batchId
    || run.error?.code !== "ROLE_REVIEW_WORK_FAILED" || run.error.message !== `Error: ${refusal}`
    || run.counts.llmRequests !== 1 || run.counts.toolCalls !== 0 || run.counts.retries !== 0 || !zeroUsage(run.usage)
    || requests.length !== 1 || requests[0]!.data?.providerId !== "openai-codex"
    || failures.length !== 1 || failures[0]!.data?.errorMessage !== refusal || failures[0]!.callId !== requests[0]!.callId
    || failures[0]!.data?.providerId !== "openai-codex" || !zeroUsage(failures[0]!.data?.usage)
    || events.some(e => e.type.startsWith("tool.") || e.type === "llm.response.completed") || events.at(-1)?.type !== "run.failed"
    || budget.state.blocked || budget.state.usage.modelCalls !== 1 || !remainingRoleProgressCalls(budget)
    || budget.state.progress?.lastProgressCall || budget.state.progress?.milestones.length) {
    throw roleWorkStop("quota continuation requires one settled zero-output provider refusal, no tools and an unexhausted original budget; other stops must not retry");
  }
  const work = events.find(e => e.type === "validation.completed" && e.data?.phase === "role-review-work")?.data;
  const stop = events.findLast(e => e.type === "validation.completed" && e.data?.phase === "role-review-work-stopped")?.data;
  const observations = events.filter(e => e.type === "validation.completed" && e.data?.phase === "role-request-observation");
  const taskHash = observations[0]?.data?.logicalTaskHash;
  if (work?.planHash !== store.planHash || work.workId !== workId || typeof taskHash !== "string" || !/^[a-f0-9]{64}$/.test(taskHash)
    || observations.some(e => e.data?.logicalTaskHash !== taskHash || e.data?.sessionOrdinal !== 0 || e.data?.evidenceEpoch !== 0
      || e.data?.planHash !== store.planHash || e.data?.workId !== workId)
    || stop?.workId !== workId || !Array.isArray(stop.compactions) || stop.compactions.length
    || contentHash((stop.budget as { usage?: unknown } | undefined)?.usage ?? null) !== contentHash(budget.state.usage)) {
    throw roleWorkStop("quota trace or retained task/usage changed; preserve the original failure and do not retry");
  }
  const promptEvent = events.find(e => e.type === "context.assembled" && e.data?.phase === "before-agent-start");
  const prompt = promptEvent?.blobRef ? await traces.peekBlob(promptEvent.blobRef) : undefined;
  if (typeof prompt !== "string" || contentHash(prompt) !== work.packetHash) throw roleWorkStop("quota task prompt is missing or changed");
  const lines = prompt.split("\n");
  const original = lines.map((_, i) => lines.slice(0, i + 1).join("\n")).find(p => contentHash(p) === taskHash);
  if (!original) throw roleWorkStop("quota task cannot be recovered exactly; do not reconstruct or replace it");
  const packet = JSON.parse(original.split("\n").at(-1)!);
  if (packet.candidateId !== input.candidateId || contentHash(packet.entry) !== contentHash(entry)
    || packet.claimRevision !== contentHash(entry) || packet.atlasRevision !== store.atlasRevision()) {
    throw roleWorkStop("quota claim or source atlas changed; do not reuse this task");
  }
  const base = path.join(worldStorageRoot(root), "compiler", "role-review-work"), key = contentHash(workId);
  const contextRoot = path.join(base, "context-loops", store.planHash, key), contextDir = path.join(contextRoot, taskHash);
  if (contentHash((await names(contextRoot)).sort()) !== contentHash([taskHash])
    || contentHash((await names(contextDir)).sort()) !== contentHash(["0.json"])) throw roleWorkStop("quota context is ambiguous or its next session is already consumed");
  const contextFile = path.join(contextDir, "0.json"), context = await json(contextFile);
  if (context.hash !== contentHash(context.claim) || context.claim.planHash !== store.planHash || context.claim.workId !== workId
    || context.claim.taskHash !== taskHash || context.claim.ordinal !== 0) throw roleWorkStop("original quota context claim changed");
  const attemptDir = path.join(base, "v1", contentHash(input.sourceId), "attempts", contentHash(input.batchId), key);
  if (contentHash((await names(attemptDir)).sort()) !== contentHash(["1.json", "2.json"])) throw roleWorkStop("quota dispatch repair requires the already reserved second attempt; no new invocation is granted");
  const attemptFiles = [path.join(attemptDir, "1.json"), path.join(attemptDir, "2.json")];
  const attempts = await Promise.all(attemptFiles.map(json));
  const schedule = await new NovelCompilationRunStore(root).read(input.sourceId), retry = schedule?.history.at(-1);
  if (attempts.some(a => a.planHash !== store.planHash || a.workId !== workId)
    || !(Date.parse(attempts[0].at) <= Date.parse(run.startedAt)) || !retry?.finishedAt
    || retry.phase !== "roles" || retry.status !== "blocked" || retry.error !== dispatchStop
    || !(Date.parse(run.endedAt) < Date.parse(retry.startedAt) && Date.parse(retry.startedAt) <= Date.parse(attempts[1].at)
      && Date.parse(attempts[1].at) <= Date.parse(retry.finishedAt))) {
    throw roleWorkStop("reserved quota retry lacks its exact pre-dispatch scheduling receipt; do not infer or renew an attempt");
  }
  // A later model run is uncertain even if the caller claims it did no work.
  const latest = (await traces.peekRuns({ sourceId: input.sourceId, kind: "prepare", limit: 1 }))[0];
  if (latest?.id !== input.runId) throw roleWorkStop("a later model invocation exists; inspect its original outcome before any quota continuation");
  const budgetNames = await names(path.join(base, "budgets", store.planHash));
  if (budgetNames.some(n => n.startsWith(key) && n !== `${key}.json`)
    || (await names(path.join(base, "native-context-fallbacks", store.planHash))).some(n => n.startsWith(key))) {
    throw roleWorkStop("quota task has pending charges or another recovery; do not combine authorities");
  }
  const contextNames = (await names(path.join(base, "context", store.planHash))).filter(n => n.startsWith(`${key}.json`));
  if (contextNames.some(n => n !== `${key}.json`)) throw roleWorkStop("quota task has an uncertain or revised evidence checkpoint");
  const checkpointFiles = contextNames.map(n => path.join(base, "context", store.planHash, n));
  for (const file of checkpointFiles) {
    const checkpoint = await json(file);
    if (checkpoint.hash !== contentHash(checkpoint.state) || checkpoint.state.packetHash !== taskHash
      || checkpoint.state.planHash !== store.planHash || checkpoint.state.workId !== workId
      || checkpoint.state.handoffs.length || checkpoint.state.inheritedHandoffs || checkpoint.state.accesses.length) {
      throw roleWorkStop("quota evidence checkpoint contains prior work or changed task data");
    }
  }
  const retainedFiles = await Promise.all([...attemptFiles, contextFile, ...checkpointFiles].map(async file => ({
    path: path.relative(worldStorageRoot(root), file), hash: contentHash(await fs.readFile(file, "utf8")),
  })));
  const authority = { version: 1 as const, policy: "quota-refusal" as const, input, planHash: store.planHash, workId, taskHash,
    sourceHash: plan.sourceHash, entriesHash: store.entriesHash(), atlasRevision: store.atlasRevision(),
    traceHash: contentHash(events), runHash: contentHash(run), retryReceiptHash: contentHash(retry), budgetHash: budget.hash,
    retainedFiles, model: `${requests[0]!.data!.providerId}/${requests[0]!.data!.modelId}`, attempt: 2 as const, sessionOrdinal: 1 as const };
  return { authority, authorityHash: contentHash(authority), file: grantFile(root, store.planHash, workId) };
}

export async function inspectRoleQuotaContinuation(root: string, input: RoleQuotaContinuationInput) {
  const preview = await inspect(root, input);
  if ((await names(path.dirname(preview.file))).includes(path.basename(preview.file))) throw roleWorkStop("quota authority already exists; inspect its original result, never create another grant");
  return preview;
}
export async function grantRoleQuotaContinuation(root: string, input: RoleQuotaContinuationInput, expectedHash: string) {
  if ((await WorkspaceOperationLock.inspect(root)).owner?.pid !== process.pid) throw roleWorkStop("quota continuation requires the owning compiler lock");
  const preview = await inspectRoleQuotaContinuation(root, input);
  if (preview.authorityHash !== expectedHash) throw roleWorkStop("quota preview changed; inspect again and copy authorityHash once, never retry unchanged");
  await fs.mkdir(path.dirname(preview.file), { recursive: true });
  await fs.writeFile(preview.file, JSON.stringify(preview), { flag: "wx", mode: 0o600 });
  return preview;
}
export async function inspectGrantedRoleQuotaContinuation(store: RoleReviewWorkStore, resume: RoleQuotaResume) {
  if (resume.planHash !== store.planHash) throw roleWorkStop("quota authority belongs to another plan");
  const file = grantFile(store.root, store.planHash, resume.workId), saved = await json(file);
  if (saved.authorityHash !== resume.authorityHash || contentHash(saved.authority) !== resume.authorityHash) throw roleWorkStop("quota authority hash changed");
  const current = await inspect(store.root, saved.authority.input);
  if (current.authorityHash !== resume.authorityHash || current.file !== file) throw roleWorkStop("quota authority dependencies changed; stop without dispatch");
  return current;
}
export async function claimReservedRoleQuotaAttempt(store: RoleReviewWorkStore, resume: RoleQuotaResume, taskHash: string) {
  if ((await WorkspaceOperationLock.inspect(store.root)).owner?.pid !== process.pid) throw roleWorkStop("quota dispatch requires the owning compiler lock");
  const current = await inspectGrantedRoleQuotaContinuation(store, resume);
  if (current.authority.taskHash !== taskHash) throw roleWorkStop("quota dispatch task changed; preserve the original prompt and do not retry");
  try { await fs.writeFile(`${current.file}.used`, JSON.stringify({ authorityHash: resume.authorityHash, pid: process.pid }), { flag: "wx", mode: 0o600 }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw roleWorkStop("quota dispatch already consumed; no automatic retry or new allowance"); throw e; }
  return 2;
}
export async function inspectQuotaRoleSession(store: RoleReviewWorkStore, resume: RoleQuotaResume) {
  const current = await inspectGrantedRoleQuotaContinuation(store, resume), used = await json(`${current.file}.used`);
  if (used.authorityHash !== resume.authorityHash || used.pid !== process.pid) throw roleWorkStop("quota dispatch was not claimed by this host invocation");
  return { workId: resume.workId, taskHash: current.authority.taskHash,
    recoveryInfo: { reason: "Explicit user resumption after a zero-output quota refusal", authorityHash: resume.authorityHash, failedRunId: current.authority.input.runId } };
}
