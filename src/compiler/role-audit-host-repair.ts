import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { contentHash } from "../world/canonical.js";
import { TraceStore } from "../trace/store.js";
import { ModelRequestBudget, type ModelRequestBudgetState } from "../runtime/model-request-budget.js";
import { WorkspaceOperationLock } from "../util/workspace-lock.js";
import { ROLE_AUDIT_WORK_TOOL, RoleReviewWorkStore, roleAuditWorkSchema, roleWorkStop } from "./role-review-work.js";
import { assertAutomaticRoleCorrectionHistory, readAutomaticRoleCorrectionContinuation, readOriginalAutomaticAuditReceipt } from "./role-automatic-resume.js";

const guard = "correction inventory reads must use only exact candidate IDs retained by the failed draft";
const failedMessage = String(roleWorkStop(guard));
const stop = (reason: string): never => { throw roleWorkStop(`${reason}; inspect the original correction authority and trace with compile-novel status. Do not renew the grant, reset usage or retry unchanged`); };
type Parent = NonNullable<ReturnType<typeof readAutomaticRoleCorrectionContinuation>>;
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const hashFile = (file: string) => contentHash(fs.readFileSync(file, "utf8"));
const repairFile = (parent: Parent) => `${parent.file}.host-repair.json`;

/** A host tool implementation fault can restore only the one unspent call of
 * the failed correction. It never renews that grant or an ordinary context. */
export async function inspectRoleAuditHostRepair(store: RoleReviewWorkStore, page: number) {
  const workId = store.workId("audit", page);
  const parent = readAutomaticRoleCorrectionContinuation(store.root, store.planHash, workId);
  if (!parent) return;
  const file = repairFile(parent);
  if (fs.existsSync(file)) stop("the host tool repair was already claimed; inspect its settled result");
  await assertAutomaticRoleCorrectionHistory(store, workId);
  const prior = parent.authority, result = read(`${parent.file}.result.json`);
  // Another exact failure shape may have its own narrower host policy. This
  // inspector owns only the historical detail-read guard fault.
  if (result.error !== failedMessage) return;
  if (result.status !== "failed" || result.receiptHash !== null
    || parent.usage.blocked || parent.usage.failure
    || parent.usage.usage.modelCalls !== prior.budget.state.usage.modelCalls + 2
    || prior.limits.maxModelCalls - parent.usage.usage.modelCalls !== 1
    || store.read("audit", page)) stop("the failed correction has no exact unspent final call after the known read-only guard fault; its single grant cannot be renewed");
  const history = store.journal.history(ROLE_AUDIT_WORK_TOOL, workId);
  if (contentHash(history) !== prior.proposalHistoryHash || store.journal.unresolved().length !== 1) {
    stop("the original proposal correction changed or another write remains unresolved");
  }
  const traces = new TraceStore(store.root);
  let selected: { run: Awaited<ReturnType<TraceStore["peekRun"]>>; events: Awaited<ReturnType<TraceStore["peekEvents"]>> } | undefined;
  for (const run of await traces.peekRuns({ sourceId: store.plan.sourceId, kind: "prepare", limit: 1000 })) {
    if (run.operationId !== store.plan.batchId) continue;
    const events = await traces.peekEvents(run.id);
    if (events.some(event => event.data?.phase === "role-review-work" && event.data.workId === workId)) {
      selected = { run, events }; break;
    }
  }
  if (!selected) stop("the failed correction trace is missing");
  const { run, events } = selected!;
  const work = events.filter(event => event.data?.phase === "role-review-work");
  const stopped = events.filter(event => event.data?.phase === "role-review-work-stopped");
  const responses = events.filter(event => event.type === "llm.response.completed");
  if (run.status !== "failed" || !run.endedAt || run.error?.message !== failedMessage
    || run.error?.code !== "ROLE_REVIEW_WORK_FAILED" || run.counts.llmRequests !== 2 || run.counts.retries !== 0
    || events.at(-1)?.type !== "run.failed" || responses.length !== 2
    || events.filter(event => event.type === "llm.request.started").length !== 2
    || events.some(event => event.type === "llm.response.failed" || event.type === "llm.retry")
    || responses[1]?.data?.stopReason !== "stop"
    || work.length !== 1 || work[0]?.data?.continuationAuthorityHash !== parent.authorityHash
    || work[0]?.data?.logicalTaskHash !== prior.taskHash || work[0]?.data?.planHash !== store.planHash
    || stopped.length !== 1 || contentHash((stopped[0]?.data?.budget as { usage?: unknown })?.usage) !== contentHash(parent.usage.usage)) {
    stop("the correction trace is not the exact settled host read fault with known cumulative usage");
  }
  const calls = new Map<string, string>(), ids: string[] = [];
  for (const event of events) {
    if (event.type === "tool.call.started") {
      if (!event.toolCallId || calls.has(event.toolCallId) || event.data?.toolName !== "read_role_audit_inventory" || !event.blobRef) {
        stop("the failed correction contains an unknown tool, duplicate call or mutation");
      }
      const args = await traces.peekBlob(event.blobRef!) as Record<string, unknown>;
      if (contentHash(args) !== event.data?.inputHash || args.mode !== "detail" || typeof args.candidateId !== "string"
        || !prior.requiredCandidateIds.includes(args.candidateId) || Object.keys(args).sort().join(",") !== "candidateId,mode") {
        stop("the rejected inventory call was not an exact in-scope detail read");
      }
      calls.set(event.toolCallId!, args.candidateId as string); ids.push(args.candidateId as string);
    } else if (event.type === "tool.call.completed" || event.type === "tool.call.failed") {
      if (!event.toolCallId || !calls.delete(event.toolCallId) || event.type !== "tool.call.failed"
        || event.data?.toolName !== "read_role_audit_inventory" || !event.blobRef) stop("the read fault has an ambiguous tool outcome");
      const body = await traces.peekBlob(event.blobRef!) as { content?: Array<{ text?: string }>; details?: { nwhToolRecovery?: { category?: string; retryable?: boolean } } };
      if (!body.content?.some(item => item.text?.startsWith(failedMessage.slice("Error: ".length)))
        || body.details?.nwhToolRecovery?.category !== "host-repair-required" || body.details.nwhToolRecovery.retryable !== false) {
        stop("the rejected tool did not retain the exact host repair diagnostic");
      }
    }
  }
  if (calls.size || ids.length !== run.counts.toolCalls || new Set(ids).size !== ids.length
    || contentHash([...ids].sort()) !== contentHash([...prior.requiredCandidateIds].sort())) stop("the failed read set is incomplete or repeated");
  const lastTool = events.findLast(event => event.type.startsWith("tool.call."));
  if (!lastTool || lastTool.seq >= responses[1]!.seq || events.some(event => event.type === "tool.call.started" && event.seq < responses[0]!.seq)) {
    stop("the model did not stop after one batch of rejected reads");
  }
  // Reconstruct the immutable task from its original, complete paged restoration.
  const pages = new Map<number, string>();
  for (const event of await traces.peekEvents(prior.runId)) {
    if (event.type !== "tool.call.completed" || event.data?.toolName !== "read_role_session_context" || !event.blobRef) continue;
    const body = await traces.peekBlob(event.blobRef) as { content?: Array<{ text?: string }> };
    for (const item of body.content ?? []) if (item.text) {
      const page = JSON.parse(item.text);
      if (page.taskHash !== prior.taskHash || !Number.isInteger(page.offset) || typeof page.text !== "string"
        || (pages.has(page.offset) && pages.get(page.offset) !== page.text)) stop("the original task restoration changed");
      pages.set(page.offset, page.text);
    }
  }
  const offsets = [...pages.keys()].sort((a, b) => a - b), originalPrompt = offsets.map(offset => pages.get(offset)!).join("");
  if (offsets.some((offset, index) => offset !== index) || contentHash(originalPrompt) !== prior.taskHash) stop("the original task cannot be restored exactly");
  const checkpointRaw = fs.readFileSync(prior.checkpointFile, "utf8");
  const authority = {
    version: 1 as const, policy: "compile-audit-host-tool-repair-v1" as const,
    sourceHash: store.plan.sourceHash, planHash: store.planHash, workId, page, taskHash: prior.taskHash as string,
    attempt: prior.attempt as number, nextOrdinal: prior.nextOrdinal as number,
    parentFile: parent.file, parentAuthorityHash: parent.authorityHash,
    parentFiles: [parent.file, `${parent.file}.usage.json`, `${parent.file}.result.json`].map(file => ({ file, hash: hashFile(file) })),
    runId: run.id, runHash: contentHash(run), traceHash: contentHash(events),
    checkpointRaw, checkpointHash: contentHash(checkpointRaw), proposalHistoryHash: contentHash(history),
    budget: { ...prior.budget, state: parent.usage }, limits: prior.limits,
    remainingCalls: 1 as const, additionalCalls: 0 as const,
    implementationHash: contentHash(fs.readFileSync(fileURLToPath(import.meta.url), "utf8")),
  };
  return { authority, authorityHash: contentHash(authority), originalPrompt, file };
}
export type RoleAuditHostRepair = NonNullable<Awaited<ReturnType<typeof inspectRoleAuditHostRepair>>>;

export function readRoleAuditHostRepair(parent: Parent) {
  const file = repairFile(parent);
  if (!fs.existsSync(file)) return;
  const saved = read(file) as Pick<RoleAuditHostRepair, "authority" | "authorityHash">, a = saved.authority;
  if (saved.authorityHash !== contentHash(a) || a.policy !== "compile-audit-host-tool-repair-v1"
    || a.parentFile !== parent.file || a.parentAuthorityHash !== parent.authorityHash
    || a.workId !== parent.authority.workId || a.planHash !== parent.authority.planHash || a.taskHash !== parent.authority.taskHash
    || a.page !== parent.authority.page || a.attempt !== parent.authority.attempt || a.nextOrdinal !== parent.authority.nextOrdinal
    || a.sourceHash !== parent.authority.sourceHash || a.remainingCalls !== 1 || a.additionalCalls !== 0
    || contentHash(a.limits) !== contentHash(parent.authority.limits) || contentHash(a.budget.state) !== contentHash(parent.usage)
    || a.limits.maxModelCalls - a.budget.state.usage.modelCalls !== 1 || a.checkpointHash !== contentHash(a.checkpointRaw)
    || contentHash(a.parentFiles.map(item => item.file).sort()) !== contentHash([parent.file, `${parent.file}.usage.json`, `${parent.file}.result.json`].sort())
    || a.parentFiles.some(item => hashFile(item.file) !== item.hash)) stop("the host repair changed its parent, checkpoint, limits or consumed usage");
  const usageFile = `${file}.usage.json`;
  if (fs.existsSync(`${usageFile}.pending`) || !fs.existsSync(usageFile)) stop("host repair usage publication is uncertain");
  const usage = read(usageFile);
  if (usage.authorityHash !== saved.authorityHash || usage.hash !== contentHash({ authorityHash: usage.authorityHash, state: usage.state })
    || typeof usage.state?.blocked !== "boolean"
    || contentHash(Object.keys(usage.state.usage ?? {}).sort()) !== contentHash(Object.keys(parent.usage.usage).sort())
    || Object.entries(parent.usage.usage).some(([key, value]) => !Number.isSafeInteger(usage.state.usage[key]) || usage.state.usage[key] < value)
    || usage.state.usage.modelCalls > a.limits.maxModelCalls) stop("host repair usage is unknown, regressed or exceeds its original ceiling");
  return { ...saved, file, usage: usage.state as ModelRequestBudgetState };
}

export async function openRoleAuditHostRepairBudget(store: RoleReviewWorkStore, preview: RoleAuditHostRepair) {
  if ((await WorkspaceOperationLock.inspect(store.root)).owner?.pid !== process.pid) stop("host tool repair requires the compiler lock");
  const parent = readAutomaticRoleCorrectionContinuation(store.root, store.planHash, preview.authority.workId)!;
  const saved = readRoleAuditHostRepair(parent);
  if (!saved || saved.authorityHash !== preview.authorityHash || fs.existsSync(`${preview.file}.started.json`)
    || fs.existsSync(`${preview.file}.result.json`) || saved.usage.blocked
    || contentHash(saved.usage) !== contentHash(parent.usage)) stop("host tool repair was already dispatched or its retained state changed");
  fs.writeFileSync(`${preview.file}.started.json`, JSON.stringify({ authorityHash: preview.authorityHash, at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  return new ModelRequestBudget(preview.authority.limits, { initial: saved!.usage, save(state) {
    const value = { authorityHash: preview.authorityHash, state }, file = `${preview.file}.usage.json`;
    fs.writeFileSync(`${file}.pending`, JSON.stringify({ ...value, hash: contentHash(value) }), { flag: "wx", mode: 0o600 });
    fs.renameSync(`${file}.pending`, file);
  } }, { modelCallsMode: "enforce", requestBytesMode: "observe", totalBytesMode: "observe" });
}

export function assertHostRepairDraft(parent: Parent, raw: unknown) {
  const draft = roleAuditWorkSchema.parse(raw), prior = parent.authority, failed = roleAuditWorkSchema.parse(prior.failedDraft);
  const unchanged = ({ missingMajorCharacters: _, ...rest }: typeof draft) => rest;
  const retained = draft.missingMajorCharacters.slice(0, failed.missingMajorCharacters.length);
  const additions = draft.missingMajorCharacters.slice(failed.missingMajorCharacters.length);
  const missingNames = prior.correctionTargets.filter((name: string) => !failed.missingMajorCharacters.some(item => item.name === name));
  if (contentHash(unchanged(draft)) !== contentHash(unchanged(failed)) || contentHash(draft) === contentHash(failed)
    || contentHash(retained) !== contentHash(failed.missingMajorCharacters)
    || contentHash(additions.map(item => item.name).sort()) !== contentHash([...missingNames].sort())) {
    stop("host repair may only append the exact missing discovery names and must preserve every responsibility, complete prior character entry and evidence basis");
  }
  return draft;
}

export function recordRoleAuditHostRepairResult(store: RoleReviewWorkStore, preview: RoleAuditHostRepair, runId: string, error?: unknown) {
  const parent = readAutomaticRoleCorrectionContinuation(store.root, store.planHash, preview.authority.workId)!;
  const record = readRoleAuditHostRepair(parent)!;
  const receipt = readOriginalAutomaticAuditReceipt(store, preview.authority.page);
  const succeeded = error === undefined && Boolean(receipt);
  fs.writeFileSync(`${preview.file}.result.json`, JSON.stringify({ authorityHash: preview.authorityHash, runId,
    status: succeeded ? "succeeded" : "failed", receiptHash: succeeded ? contentHash(receipt) : null,
    usage: record.usage, checkpointHash: hashFile(parent.authority.checkpointFile),
    proposalHistoryHash: contentHash(store.journal.history(ROLE_AUDIT_WORK_TOOL, preview.authority.workId)),
    ...(error === undefined ? {} : { error: String(error) }) }), { flag: "wx", mode: 0o600 });
}

export async function assertRoleAuditHostRepairHistory(store: RoleReviewWorkStore, parent: Parent) {
  const record = readRoleAuditHostRepair(parent);
  if (!record) stop("the failed correction has no verified host repair");
  const a = record!.authority, traces = new TraceStore(store.root);
  if (contentHash(await traces.peekRun(a.runId)) !== a.runHash || contentHash(await traces.peekEvents(a.runId)) !== a.traceHash) stop("the retained host fault trace changed");
  const before = JSON.parse(a.checkpointRaw), now = read(parent.authority.checkpointFile);
  if (before.hash !== contentHash(before.state) || now.hash !== contentHash(now.state)
    || contentHash(now.state.accesses.slice(0, before.state.accesses.length)) !== contentHash(before.state.accesses)
    || contentHash({ ...now.state, accesses: before.state.accesses }) !== contentHash(before.state)) stop("the host repair changed its original context beyond appended access records");
  if (!fs.existsSync(`${record!.file}.result.json`) || !fs.existsSync(`${record!.file}.started.json`)) stop("host repair has an uncertain outcome; do not redispatch");
  const result = read(`${record!.file}.result.json`), started = read(`${record!.file}.started.json`);
  const history = store.journal.history(ROLE_AUDIT_WORK_TOOL, a.workId), prefix = history.slice(0, parent.authority.proposalHistoryLength), suffix = history.slice(prefix.length);
  const receipt = readOriginalAutomaticAuditReceipt(store, a.page);
  const run = await traces.peekRun(result.runId);
  if (started.authorityHash !== record!.authorityHash || result.authorityHash !== record!.authorityHash || result.status !== "succeeded"
    || contentHash(result.usage) !== contentHash(record!.usage) || record!.usage.blocked || record!.usage.failure
    || record!.usage.usage.modelCalls !== a.limits.maxModelCalls || run.status !== "succeeded"
    || run.sourceId !== store.plan.sourceId || run.operationId !== store.plan.batchId
    || result.checkpointHash !== hashFile(parent.authority.checkpointFile) || result.proposalHistoryHash !== contentHash(history)
    || contentHash(prefix) !== a.proposalHistoryHash || suffix.length !== 2 || suffix[0]?.status !== "running" || suffix[1]?.status !== "succeeded"
    || suffix[0].inputHash !== suffix[1].inputHash || !receipt || result.receiptHash !== contentHash(receipt)) {
    stop("host repair failed or lacks its exact validated receipt; its remaining-call restoration cannot be repeated");
  }
  assertHostRepairDraft(parent, receipt);
}
