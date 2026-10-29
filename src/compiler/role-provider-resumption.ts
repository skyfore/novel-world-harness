import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { worldStorageRoot } from "../world/paths.js";
import { TraceStore } from "../trace/store.js";
import { WorkspaceOperationLock } from "../util/workspace-lock.js";
import { ModelRequestBudget, type ModelRequestBudgetState } from "../runtime/model-request-budget.js";
import { inspectRoleReviewBudget, remainingRoleProgressCalls } from "./role-review-budget.js";
import { ROLE_AUDIT_WORK_TOOL, RoleReviewWorkStore, roleAuditWorkSchema, roleWorkStop } from "./role-review-work.js";
import { roleFindingId } from "./role-review-verification.js";

const refusal = "Codex error: The usage limit has been reached";
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const fileHash = (file: string) => contentHash(fs.readFileSync(file, "utf8"));
function stop(reason: string): never { throw roleWorkStop(`${reason}; inspect compile-novel status and the original provider-resumption authority/result. Do not retry, renew this grant, change work IDs or reset prior usage`); }
const base = (root: string) => path.join(worldStorageRoot(root), "compiler", "role-review-work");
const grantFile = (root: string, planHash: string, workId: string) => path.join(base(root), "host-interruptions", "provider-resumption", planHash, `${contentHash(workId)}.json`);
const checkpointFile = (root: string, saved: RoleProviderResumption) => path.join(base(root), "context", saved.authority.planHash,
  `${contentHash(saved.authority.workId)}.json.continuation-${saved.authorityHash}.json`);
const inputSchema = z.object({ page: z.number().int().nonnegative(), failedRunId: z.string().min(1),
  authorizationRef: z.string().trim().min(1), availabilityFile: z.string().min(1) }).strict();
export type RoleProviderResumptionInput = z.infer<typeof inputSchema>;

/** Full compile rechecks already-finished batches before returning to roles.
 * That exact deterministic trace is not another model invocation. Everything
 * else after the retained refusal still requires separate host inspection. */
async function assertNoLaterInvocation(traces: TraceStore, sourceId: string, failedRunId: string) {
  const runs = await traces.peekAllRuns({ sourceId, kind: "prepare" });
  const original = runs.findIndex(run => run.id === failedRunId);
  if (original < 0) stop("the retained refusal is missing from the complete source trace history");
  for (const run of runs.slice(0, original)) {
    const events = await traces.peekEvents(run.id), checkpoints = events[2]?.data;
    if (run.status !== "succeeded" || !run.endedAt || run.operationId || run.lastSeq !== 4
      || Object.values(run.counts).some(value => value !== 0) || Object.values(run.usage).some(value => value !== 0)
      || events.length !== 4 || events.some((event, index) => event.seq !== index + 1 || event.blobRef || event.callId || event.toolCallId)
      || events[0]?.type !== "run.started" || events[0].data?.kind !== "prepare"
      || events[1]?.type !== "validation.completed" || events[1].data?.phase !== "compiler-host"
      || events[2]?.type !== "validation.completed" || checkpoints?.phase !== "compiler-checkpoints"
      || !Number.isSafeInteger(checkpoints.total) || !(Number(checkpoints.total) > 0)
      || checkpoints.completed !== 0 || checkpoints.skipped !== checkpoints.total || checkpoints.remaining !== 0
      || events[3]?.type !== "run.succeeded" || events[3].data?.status !== "succeeded") {
      stop("a later compiler invocation or uncertain checkpoint inspection exists; inspect its exact outcome first");
    }
  }
}

/** Host-only preflight for NEW explicit user authority, after an automatic grant
 * was refused before any useful provider output. It never revives that grant. */
export async function inspectRoleProviderResumption(store: RoleReviewWorkStore, raw: RoleProviderResumptionInput) {
  const input = inputSchema.parse(raw), workId = store.workId("audit", input.page);
  if (!store.plan.spans[input.page] || store.read("audit", input.page)
    || store.journal.unresolved().length || store.journal.history(ROLE_AUDIT_WORK_TOOL, workId).length) {
    stop("provider resumption requires one unfinished audit with no proposal attempt or unresolved write");
  }
  const traces = new TraceStore(store.root), run = await traces.peekRun(input.failedRunId), events = await traces.peekEvents(input.failedRunId);
  const requests = events.filter(e => e.type === "llm.request.started"), failures = events.filter(e => e.type === "llm.response.failed");
  const observations = events.filter(e => e.data?.phase === "role-request-observation");
  const work = events.filter(e => e.data?.phase === "role-review-work"), stopped = events.filter(e => e.data?.phase === "role-review-work-stopped");
  if (run.status !== "failed" || !run.endedAt || run.sourceId !== store.plan.sourceId || run.operationId !== store.plan.batchId
    || run.error?.code !== "ROLE_REVIEW_WORK_FAILED" || run.error.message !== `Error: ${refusal}`
    || run.counts.llmRequests !== 1 || run.counts.toolCalls !== 0 || run.counts.retries !== 0
    || requests.length !== 1 || failures.length !== 1 || !requests[0]!.callId || failures[0]!.callId !== requests[0]!.callId
    || failures[0]!.seq <= requests[0]!.seq || failures[0]!.data?.errorMessage !== refusal
    || failures[0]!.data?.providerId !== "openai-codex" || requests[0]!.data?.providerId !== "openai-codex"
    || events.some(e => e.type.startsWith("tool.") || e.type.startsWith("world.commit.") || e.type === "llm.response.completed" || e.type === "llm.retry")
    || events.at(-1)?.type !== "run.failed" || work.length !== 1 || work[0]!.data?.workId !== workId
    || work[0]!.data?.planHash !== store.planHash || !observations.length || stopped.length !== 1
    || stopped[0]!.data?.workId !== workId || !Array.isArray(stopped[0]!.data?.compactions) || (stopped[0]!.data!.compactions as unknown[]).length) {
    stop("the failed continuation is not exactly one settled quota-refused request with zero tools");
  }
  for (const usage of [run.usage, failures[0]!.data?.usage] as Array<{ input?: number; output?: number; totalTokens?: number } | undefined>) {
    if (usage?.input !== 0 || usage.output !== 0 || usage.totalTokens !== 0) stop("the refused continuation consumed provider output or has unknown usage");
  }
  const taskHash = observations[0]!.data?.logicalTaskHash;
  if (typeof taskHash !== "string" || observations.some(e => e.data?.logicalTaskHash !== taskHash || e.data?.sessionOrdinal !== 2)) {
    stop("the refused continuation has ambiguous task or final ordinary context identity");
  }
  const contextDir = path.join(base(store.root), "context-loops", store.planHash, contentHash(workId), taskHash);
  const contextFile = path.join(contextDir, "2.json"), context = read(contextFile), claim = context.claim;
  if (context.hash !== contentHash(claim) || claim.planHash !== store.planHash || claim.workId !== workId
    || claim.taskHash !== taskHash || claim.ordinal !== 2 || fs.readdirSync(contextDir).some(n => !/^[0-2](?:\.outcome)?\.json$/.test(n))) {
    stop("the consumed automatic context is changed or has later/uncertain publication");
  }
  const parentDir = path.join(base(store.root), "host-interruptions", "compile-quota", store.planHash);
  const matches = fs.readdirSync(parentDir).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).map(n => ({ file: path.join(parentDir, n), ...read(path.join(parentDir, n)) }))
    .filter(p => p.authorityHash === claim.recoveryInfo?.authorityHash);
  if (matches.length !== 1) stop("the consumed context has no unique original quota authority");
  const parent = matches[0]!, prior = parent.authority;
  if (parent.authorityHash !== contentHash(prior) || prior.policy !== "compile-audit-quota-v1" || prior.maxNewSessions !== 1
    || prior.nextOrdinal !== 2 || prior.planHash !== store.planHash || prior.workId !== workId || prior.page !== input.page
    || prior.taskHash !== taskHash || claim.budgetHash !== prior.budgetHash || claim.recoveryInfo?.failedRunId !== prior.runId
    || prior.atlasRevision !== store.atlasRevision() || prior.entriesHash !== store.entriesHash()
    || prior.claimAuditsHash !== contentHash(store.claimAudits())) stop("the consumed authority or frozen evidence dependencies changed");
  const budget = inspectRoleReviewBudget(store.root, store.planHash, workId), remaining = remainingRoleProgressCalls(budget);
  if (budget.state.blocked || budget.state.failure || remaining <= 0
    || budget.state.usage.modelCalls !== prior.startingUsage.modelCalls + 1
    || budget.state.usage.payloads !== prior.startingUsage.payloads + 1
    || contentHash(budget.state.progress ?? null) !== prior.startingProgressHash
    || contentHash((stopped[0]!.data?.budget as { usage?: unknown })?.usage) !== contentHash(budget.state.usage)
    || remaining !== prior.maxAdditionalModelCalls - 1) stop("the remaining original progress allowance changed or is exhausted");
  const originalRun = await traces.peekRun(prior.runId), originalEvents = await traces.peekEvents(prior.runId);
  if (contentHash(originalRun) !== prior.runHash || contentHash(originalEvents) !== prior.traceHash) stop("the predecessor quota trace changed");
  const pages = new Map<number, string>();
  for (const event of originalEvents) {
    if (event.type !== "tool.call.completed" || event.data?.toolName !== "read_role_session_context" || !event.blobRef) continue;
    const result = await traces.peekBlob(event.blobRef) as { content?: Array<{ type: string; text?: string }> };
    for (const item of result.content ?? []) if (item.type === "text" && item.text) {
      const page = JSON.parse(item.text);
      if (page.taskHash !== taskHash || !Number.isInteger(page.offset) || typeof page.text !== "string"
        || (pages.has(page.offset) && pages.get(page.offset) !== page.text)) stop("original task restoration is ambiguous");
      pages.set(page.offset, page.text);
    }
  }
  const offsets = [...pages.keys()].sort((a, b) => a - b), originalPrompt = offsets.map(n => pages.get(n)!).join("");
  if (!offsets.length || offsets.some((n, i) => n !== i) || contentHash(originalPrompt) !== taskHash) stop("the original task cannot be restored exactly");
  const packet = JSON.parse(originalPrompt.split("\n").at(-1)!);
  if (packet.source?.page !== input.page || packet.atlasRevision !== store.atlasRevision()
    || contentHash(packet.expectedQuestions) !== contentHash(store.questions(input.page))
    || contentHash(packet.discoveries) !== contentHash(store.read("source", input.page)!.findings.map((finding, index) => ({ findingId: roleFindingId(store.planHash, input.page, index), ...finding })))
    || packet.coverage?.claimAuditsHash !== contentHash(store.claimAudits())
    || (packet.coverage?.entriesHash && packet.coverage.entriesHash !== store.entriesHash())) stop("the restored task no longer matches the current responsibilities");
  await assertNoLaterInvocation(traces, store.plan.sourceId, input.failedRunId);
  const health = read(input.availabilityFile), model = String(requests[0]!.data?.modelId);
  if (health.provider !== "openai-codex" || health.model !== model || health.stopReason !== "stop" || health.error !== null
    || health.text?.trim() !== "OK" || !(health.usage?.totalTokens > 0)
    || !(Date.parse(health.capturedAt) > Date.parse(run.endedAt) && Date.parse(health.completedAt) >= Date.parse(health.capturedAt)
      && Date.parse(health.completedAt) <= Date.now())) stop("a newer successful availability check of the same provider/model is required");
  const retainedFiles = [...prior.retainedFiles.map((item: { file: string; hash: string }) => {
    if (fileHash(item.file) !== item.hash) stop("a retained predecessor file changed"); return item;
  }), { file: parent.file, hash: fileHash(parent.file) }, { file: contextFile, hash: fileHash(contextFile) },
  { file: path.resolve(input.availabilityFile), hash: fileHash(input.availabilityFile) }];
  const draft = prior.retainedDraft ? roleAuditWorkSchema.parse(prior.retainedDraft) : null;
  const authority = { version: 1 as const, policy: "host-provider-resumption-v1" as const, input,
    sourceId: store.plan.sourceId, sourceHash: store.plan.sourceHash, planHash: store.planHash, workId, page: input.page,
    taskHash, model: `openai-codex/${model}`, attempt: prior.attempt as number, nextOrdinal: 3,
    parentAuthorityHash: parent.authorityHash as string, runId: run.id, runHash: contentHash(run), traceHash: contentHash(events),
    atlasRevision: store.atlasRevision(), entriesHash: store.entriesHash(), claimAuditsHash: contentHash(store.claimAudits()),
    budget, limits: { ...budget.limits, maxModelCalls: budget.state.usage.modelCalls + remaining },
    additionalCalls: remaining, maxNewSessions: 1, retainedFiles, retainedDraft: draft,
    requiredUnitIds: [...new Set(draft ? [...draft.missingMajorCharacters.flatMap(d => d.basisUnitIds),
      ...(draft.questionDispositions ?? []).flatMap(d => d.basisUnitIds), ...(draft.discoveryDispositions ?? []).flatMap(d => d.basisUnitIds)] : [])].sort(),
    requiredCandidateIds: [...new Set(draft?.discoveryDispositions?.flatMap(d => d.candidateIds) ?? [])].sort() };
  return { authority, authorityHash: contentHash(authority), originalPrompt, file: grantFile(store.root, store.planHash, workId) };
}
export type RoleProviderResumption = Awaited<ReturnType<typeof inspectRoleProviderResumption>>;

export async function authorizeRoleProviderResumption(store: RoleReviewWorkStore, input: RoleProviderResumptionInput, expectedHash: string) {
  if ((await WorkspaceOperationLock.inspect(store.root)).owner?.pid !== process.pid) stop("provider resumption authorization requires the compiler lock");
  const preview = await inspectRoleProviderResumption(store, input);
  if (preview.authorityHash !== expectedHash) stop("provider resumption preview changed; copy the new authorityHash after reviewing the change");
  fs.mkdirSync(path.dirname(preview.file), { recursive: true });
  try { fs.writeFileSync(preview.file, JSON.stringify(preview), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") stop("the provider resumption authority already exists"); throw error; }
  return preview;
}

export function readRoleProviderResumption(root: string, planHash: string, workId: string) {
  const file = grantFile(root, planHash, workId);
  if (!fs.existsSync(file)) return;
  const saved = read(file) as RoleProviderResumption, a = saved.authority;
  if (saved.file !== file || saved.authorityHash !== contentHash(a) || a.policy !== "host-provider-resumption-v1"
    || a.planHash !== planHash || a.workId !== workId || contentHash(saved.originalPrompt) !== a.taskHash
    || a.maxNewSessions !== 1 || a.additionalCalls <= 0 || a.nextOrdinal !== 3
    || a.limits.maxModelCalls !== a.budget.state.usage.modelCalls + a.additionalCalls) stop("provider resumption authority integrity changed");
  return saved;
}

export async function inspectAuthorizedProviderResumption(store: RoleReviewWorkStore, page: number) {
  const saved = readRoleProviderResumption(store.root, store.planHash, store.workId("audit", page));
  if (!saved) return;
  if ([".started.json", ".availability.json", ".usage.json", ".result.json"].some(suffix => fs.existsSync(saved.file + suffix))) {
    stop("the provider resumption session was already consumed");
  }
  const current = await inspectRoleProviderResumption(store, saved.authority.input);
  if (current.authorityHash !== saved.authorityHash) stop("provider resumption dependencies changed before dispatch");
  return current;
}

export async function claimRoleProviderResumption(store: RoleReviewWorkStore, expected: RoleProviderResumption) {
  if ((await WorkspaceOperationLock.inspect(store.root)).owner?.pid !== process.pid) stop("provider resumption dispatch requires the compiler lock");
  const saved = await inspectAuthorizedProviderResumption(store, expected.authority.page);
  if (!saved || saved.authorityHash !== expected.authorityHash) stop("provider resumption dispatch authority changed");
  fs.writeFileSync(`${saved.file}.started.json`, JSON.stringify({ authorityHash: saved.authorityHash, pid: process.pid, at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  // The authorization retains the original path/hash, while its exact bytes
  // become durable workspace evidence before any model dispatch. A partial
  // publication consumes this invocation and cannot authorize another session.
  const availability = fs.readFileSync(saved.authority.input.availabilityFile, "utf8");
  if (contentHash(availability) !== availabilityRef(saved).hash) stop("availability evidence changed during dispatch");
  fs.writeFileSync(`${saved.file}.availability.json`, availability, { flag: "wx", mode: 0o600 });
  saveUsage(saved, saved.authority.budget.state);
  return saved.authority.attempt;
}
function availabilityRef(saved: RoleProviderResumption) {
  const refs = saved.authority.retainedFiles.filter((item: { file: string }) => item.file === path.resolve(saved.authority.input.availabilityFile));
  if (refs.length !== 1) stop("provider resumption lost its exact availability evidence reference");
  return refs[0] as { file: string; hash: string };
}
function assertRetainedEvidence(saved: RoleProviderResumption) {
  const availability = availabilityRef(saved);
  for (const item of saved.authority.retainedFiles as Array<{ file: string; hash: string }>) {
    const file = item.file === availability.file ? `${saved.file}.availability.json` : item.file;
    if (!fs.existsSync(file) || fileHash(file) !== item.hash) stop("retained predecessor or availability evidence changed or is missing");
  }
}
function currentCheckpointHash(root: string, saved: RoleProviderResumption) {
  const file = checkpointFile(root, saved);
  if (fs.existsSync(`${file}.pending`)) stop("provider resumption checkpoint publication is uncertain");
  return fs.existsSync(file) ? fileHash(file) : null;
}
function saveUsage(saved: RoleProviderResumption, state: ModelRequestBudgetState) {
  const value = { authorityHash: saved.authorityHash, state }, file = `${saved.file}.usage.json`, pending = `${file}.pending`;
  fs.writeFileSync(pending, JSON.stringify({ ...value, hash: contentHash(value) }), { flag: "wx", mode: 0o600 });
  fs.renameSync(pending, file);
}
export function providerResumptionUsage(saved: RoleProviderResumption) {
  if (fs.existsSync(`${saved.file}.usage.json.pending`)) stop("provider resumption usage publication is uncertain");
  const record = read(`${saved.file}.usage.json`), { hash, ...value } = record;
  if (hash !== contentHash(value) || record.authorityHash !== saved.authorityHash
    || Object.entries(saved.authority.budget.state.usage).some(([k, v]) => !(record.state?.usage?.[k] >= v))) stop("provider resumption cumulative usage changed or regressed");
  return record.state as ModelRequestBudgetState;
}
export function openProviderResumptionBudget(saved: RoleProviderResumption) {
  const started = read(`${saved.file}.started.json`);
  if (started.authorityHash !== saved.authorityHash || started.pid !== process.pid || fs.existsSync(`${saved.file}.result.json`)) stop("provider resumption is not owned by this invocation");
  return new ModelRequestBudget(saved.authority.limits, { initial: providerResumptionUsage(saved), save: state => saveUsage(saved, state) },
    { modelCallsMode: "enforce", requestBytesMode: "observe", totalBytesMode: "observe" });
}
export async function recordProviderResumptionResult(store: RoleReviewWorkStore, saved: RoleProviderResumption, error?: unknown, runId?: string) {
  const receipt = store.journal.history(ROLE_AUDIT_WORK_TOOL, saved.authority.workId).at(-1);
  const traces = new TraceStore(store.root);
  const trace = runId ? { runId, runHash: contentHash(await traces.peekRun(runId)), traceHash: contentHash(await traces.peekEvents(runId)) } : null;
  if (!error && receipt?.status === "succeeded" && !trace) stop("successful provider resumption requires its terminal trace");
  const result = { authorityHash: saved.authorityHash, status: !error && receipt?.status === "succeeded" ? "succeeded" : "failed",
    receiptHash: receipt?.status === "succeeded" ? contentHash(receipt) : null, usage: providerResumptionUsage(saved),
    trace, checkpointHash: currentCheckpointHash(store.root, saved),
    ...(error === undefined ? {} : { error: String(error) }) };
  fs.writeFileSync(`${saved.file}.result.json`, JSON.stringify(result), { flag: "wx", mode: 0o600 });
}

export function settledProviderResumption(root: string, planHash: string, workId: string) {
  const saved = readRoleProviderResumption(root, planHash, workId);
  if (!saved) return;
  if (!fs.existsSync(`${saved.file}.result.json`)) stop("provider resumption has no terminal result");
  const result = read(`${saved.file}.result.json`), usage = providerResumptionUsage(saved);
  if (result.authorityHash !== saved.authorityHash || result.status !== "succeeded" || !result.receiptHash
    || contentHash(result.usage) !== contentHash(usage) || usage.blocked || usage.failure
    || usage.usage.modelCalls > saved.authority.limits.maxModelCalls) stop("provider resumption failed or its result changed");
  assertRetainedEvidence(saved);
  const started = read(`${saved.file}.started.json`);
  if (started.authorityHash !== saved.authorityHash || !Number.isSafeInteger(started.pid) || !result.trace
    || result.checkpointHash !== currentCheckpointHash(root, saved)) stop("provider resumption start, terminal trace or checkpoint changed");
  return { ...saved, usage, receiptHash: result.receiptHash as string, trace: result.trace as { runId: string; runHash: string; traceHash: string },
    checkpointFile: result.checkpointHash === null ? null : checkpointFile(root, saved) };
}

async function assertRetainedTrace(traces: TraceStore, expected: { runId: string; runHash: string; traceHash: string }) {
  try {
    const run = await traces.peekRun(expected.runId), events = await traces.peekEvents(expected.runId);
    if (contentHash(run) !== expected.runHash || contentHash(events) !== expected.traceHash) stop("provider resumption retained trace changed");
    for (const event of events) if (event.blobRef) await traces.peekBlob(event.blobRef);
    return { run, events };
  } catch (error) { stop(`provider resumption retained trace changed or is missing: ${String(error)}`); }
}

export async function assertProviderResumptionHistory(store: RoleReviewWorkStore) {
  const dir = path.join(base(store.root), "host-interruptions", "provider-resumption", store.planHash);
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir).filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
    const raw = read(path.join(dir, name)), saved = readRoleProviderResumption(store.root, store.planHash, raw.authority?.workId);
    if (!saved || saved.file !== path.join(dir, name)) stop("provider resumption history has an invalid identity");
    if (![".started.json", ".availability.json", ".usage.json", ".result.json"].some(suffix => fs.existsSync(saved.file + suffix))) continue;
    const settled = settledProviderResumption(store.root, store.planHash, saved.authority.workId)!;
    const receipt = store.journal.history(ROLE_AUDIT_WORK_TOOL, saved.authority.workId).at(-1);
    if (receipt?.status !== "succeeded" || contentHash(receipt) !== settled.receiptHash
      || inspectRoleReviewBudget(store.root, store.planHash, saved.authority.workId).hash !== saved.authority.budget.hash
      || saved.authority.sourceHash !== store.plan.sourceHash || saved.authority.atlasRevision !== store.atlasRevision()
      || saved.authority.entriesHash !== store.entriesHash() || saved.authority.claimAuditsHash !== contentHash(store.claimAudits())) stop("provider resumption receipt or dependencies changed");
    const traces = new TraceStore(store.root), a = saved.authority;
    const parents = a.retainedFiles.filter((item: { file: string }) => item.file !== availabilityRef(saved).file)
      .map((item: { file: string }) => read(item.file)).filter((value: { authorityHash?: string }) => value.authorityHash === a.parentAuthorityHash);
    if (parents.length !== 1 || parents[0].authorityHash !== contentHash(parents[0].authority)
      || parents[0].authority.policy !== "compile-audit-quota-v1" || parents[0].authority.workId !== a.workId
      || parents[0].authority.planHash !== a.planHash || parents[0].authority.taskHash !== a.taskHash) stop("provider resumption parent authority changed");
    await assertRetainedTrace(traces, a);
    await assertRetainedTrace(traces, parents[0].authority);
    const resumed = await assertRetainedTrace(traces, settled.trace);
    if (resumed.run.status !== "succeeded" || resumed.run.sourceId !== store.plan.sourceId || resumed.run.operationId !== store.plan.batchId
      || !resumed.events.some(event => event.data?.phase === "role-review-work" && event.data.continuationAuthorityHash === saved.authorityHash
        && event.data.workId === a.workId && event.data.logicalTaskHash === a.taskHash)) stop("provider resumption terminal trace has a different scope or result");
  }
}
