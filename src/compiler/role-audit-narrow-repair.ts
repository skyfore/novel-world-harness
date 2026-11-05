import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ModelRequestBudget, type ModelRequestBudgetState } from "../runtime/model-request-budget.js";
import { TraceStore } from "../trace/store.js";
import { WorkspaceOperationLock } from "../util/workspace-lock.js";
import { contentHash } from "../world/canonical.js";
import {
  assertAutomaticRoleCorrectionHistory,
  readAutomaticRoleCorrectionContinuation,
  readOriginalAutomaticAuditReceipt,
} from "./role-automatic-resume.js";
import { assertHostRepairDraft, readRoleAuditHostRepair } from "./role-audit-host-repair.js";
import { ROLE_AUDIT_WORK_TOOL, RoleReviewWorkStore, roleAuditWorkSchema, roleWorkStop } from "./role-review-work.js";

export const ROLE_AUDIT_NARROW_REPAIR_TOOL = "propose_role_audit_missing_major_append";
export const roleAuditNarrowRepairSchema = z.object({
  missingMajorCharacters: roleAuditWorkSchema.shape.missingMajorCharacters.min(1),
}).strict();

const guard = "audit correction may change only missingMajorCharacters while retaining every blocked question, unresolved fact, discovery disposition and prior evidence basis";
const failedMessage = String(roleWorkStop(guard));
const stop = (reason: string): never => {
  throw roleWorkStop(`${reason}; inspect the original correction authority and trace with compile-novel status. Do not renew either grant, reset usage or retry unchanged`);
};
type Parent = NonNullable<ReturnType<typeof readAutomaticRoleCorrectionContinuation>>;
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const hashFile = (file: string) => contentHash(fs.readFileSync(file, "utf8"));
const repairFile = (parent: Parent) => `${parent.file}.narrow-repair.json`;

/**
 * Read-only proof for the exact full-draft schema failure. The failed
 * three-call correction stays immutable; this consumes at most one call that
 * was already left in its original progress window.
 */
export async function inspectRoleAuditNarrowRepair(store: RoleReviewWorkStore, page: number) {
  const workId = store.workId("audit", page);
  const parent = readAutomaticRoleCorrectionContinuation(store.root, store.planHash, workId);
  if (!parent) return;
  const file = repairFile(parent);
  if (fs.existsSync(file)) stop("the narrow schema repair was already claimed; inspect its settled result");
  if (readRoleAuditHostRepair(parent)) stop("the correction already has a different host repair");
  await assertAutomaticRoleCorrectionHistory(store, workId);

  const prior = parent.authority;
  const result = read(`${parent.file}.result.json`);
  const retainedProgressCalls = prior.remainingProgressCalls - prior.additionalCalls;
  if (result.status !== "failed" || result.error !== failedMessage || result.receiptHash !== null
    || parent.usage.blocked || parent.usage.failure
    || parent.usage.usage.modelCalls !== prior.limits.maxModelCalls
    || parent.usage.usage.modelCalls !== prior.budget.state.usage.modelCalls + prior.additionalCalls
    || retainedProgressCalls < 1 || store.read("audit", page)) {
    stop("the failed correction has no exact retained original progress call after the known full-draft schema failure; its single grant cannot be renewed");
  }
  const history = store.journal.history(ROLE_AUDIT_WORK_TOOL, workId);
  if (contentHash(history) !== prior.proposalHistoryHash || store.journal.unresolved().length !== 1
    || result.proposalHistoryHash !== contentHash(history)) {
    stop("the original proposal correction changed or another write remains unresolved");
  }

  const traces = new TraceStore(store.root);
  let selected: { run: Awaited<ReturnType<TraceStore["peekRun"]>>; events: Awaited<ReturnType<TraceStore["peekEvents"]>> } | undefined;
  for (const run of await traces.peekRunsByOperation(store.plan.sourceId, store.plan.batchId)) {
    if (run.kind !== "prepare") continue;
    const events = await traces.peekEvents(run.id);
    if (events.some(event => event.data?.phase === "role-review-work"
      && event.data.workId === workId && event.data.continuationAuthorityHash === parent.authorityHash)) {
      selected = { run, events };
      break;
    }
  }
  if (!selected) stop("the failed full-draft correction trace is missing");
  const { run, events } = selected!;
  const work = events.filter(event => event.data?.phase === "role-review-work");
  const stopped = events.filter(event => event.data?.phase === "role-review-work-stopped");
  const responses = events.filter(event => event.type === "llm.response.completed");
  const requests = events.filter(event => event.type === "llm.request.started");
  if (run.status !== "failed" || !run.endedAt || run.error?.message !== failedMessage
    || run.error?.code !== "ROLE_REVIEW_WORK_FAILED" || run.counts.llmRequests !== 3 || run.counts.retries !== 0
    || events.at(-1)?.type !== "run.failed" || requests.length !== 3 || responses.length !== 3
    || events.some(event => event.type === "llm.response.failed" || event.type === "llm.retry" || event.type.includes("compaction"))
    || responses[0]?.data?.stopReason !== "toolUse" || responses[1]?.data?.stopReason !== "toolUse"
    || responses[2]?.data?.stopReason !== "stop"
    || work.length !== 1 || work[0]?.data?.planHash !== store.planHash
    || work[0]?.data?.logicalTaskHash !== prior.taskHash
    || work[0]?.data?.continuationAuthorityHash !== parent.authorityHash
    || stopped.length !== 1
    || contentHash((stopped[0]?.data?.budget as { usage?: unknown })?.usage) !== contentHash(parent.usage.usage)) {
    stop("the correction trace is not the exact settled three-call full-draft schema failure");
  }

  const pending = new Map<string, { name: string; args: Record<string, unknown>; seq: number }>();
  const candidateIds: string[] = [];
  const evidenceReads = new Set<string>();
  let rejectedDraft: unknown;
  let rejectedSeq = -1;
  let rejectedOutcomeSeq = -1;
  for (const event of events) {
    if (event.type === "tool.call.started") {
      const name = String(event.data?.toolName);
      if (!event.toolCallId || pending.has(event.toolCallId) || !event.blobRef
        || !["read_role_audit_inventory", "read_role_work_evidence", "preview_role_review_audit"].includes(name)) {
        stop("the failed correction contains an unknown tool, duplicate call or mutation");
      }
      const toolCallId = event.toolCallId!;
      const args = await traces.peekBlob(event.blobRef!) as Record<string, unknown>;
      if (event.data?.inputHash !== contentHash(args)) stop("the failed correction tool input changed");
      if (name === "read_role_audit_inventory") {
        if (typeof args.candidateId !== "string" || args.mode !== "detail"
          || !prior.requiredCandidateIds.includes(args.candidateId)
          || Object.keys(args).sort().join(",") !== "candidateId,mode") {
          stop("the correction inventory read was not an exact retained candidate detail read");
        }
        candidateIds.push(args.candidateId as string);
      } else if (name === "read_role_work_evidence") {
        if (typeof args.unitId !== "string" || !prior.requiredUnitIds.includes(args.unitId)
          || (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0))
          || Object.keys(args).some(key => !["unitId", "offset"].includes(key))) {
          stop("the correction evidence read left its exact retained source scope");
        }
        const key = contentHash(args);
        if (evidenceReads.has(key)) stop("the correction repeated an unchanged evidence read");
        evidenceReads.add(key);
      } else {
        if (rejectedDraft !== undefined) stop("the correction attempted more than one full-draft preview");
        rejectedDraft = args;
        rejectedSeq = event.seq;
      }
      pending.set(toolCallId, { name, args, seq: event.seq });
      continue;
    }
    if (event.type !== "tool.call.completed" && event.type !== "tool.call.failed") continue;
    const started = event.toolCallId ? pending.get(event.toolCallId) : undefined;
    if (!started || started.name !== event.data?.toolName || !event.blobRef) stop("the correction has an unmatched tool outcome");
    const exactStarted = started!;
    pending.delete(event.toolCallId!);
    const body = await traces.peekBlob(event.blobRef!) as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
      details?: { nwhToolRecovery?: { category?: string; retryable?: boolean } };
    };
    if (exactStarted.name === "preview_role_review_audit") {
      if (event.type !== "tool.call.failed" || event.data?.isError !== true
        || !body.content?.some(item => item.text?.startsWith(failedMessage.slice("Error: ".length)))
        || body.details?.nwhToolRecovery?.category !== "host-repair-required"
        || body.details.nwhToolRecovery.retryable !== false) {
        stop("the rejected preview did not retain the exact non-retryable schema diagnostic");
      }
      rejectedOutcomeSeq = event.seq;
    } else if (event.type !== "tool.call.completed" || event.data?.isError === true || body.isError === true) {
      stop("an inventory or evidence read failed; this schema repair cannot hide it");
    }
  }
  const toolStarts = events.filter(event => event.type === "tool.call.started");
  const toolOutcomes = events.filter(event => event.type === "tool.call.completed" || event.type === "tool.call.failed");
  if (pending.size || rejectedDraft === undefined || rejectedOutcomeSeq < 0
    || toolStarts.length !== run.counts.toolCalls || toolOutcomes.length !== run.counts.toolCalls
    || new Set(candidateIds).size !== candidateIds.length
    || contentHash([...candidateIds].sort()) !== contentHash([...prior.requiredCandidateIds].sort())
    || events.some(event => event.type.startsWith("tool.call.") && event.seq > rejectedOutcomeSeq)
    || responses[2]!.seq <= rejectedOutcomeSeq) {
    stop("the correction did not finish one complete exact read set followed by one rejected preview and a clean stop");
  }

  const failed = roleAuditWorkSchema.parse(prior.failedDraft);
  const attempted = roleAuditWorkSchema.parse(rejectedDraft);
  const withoutMissing = ({ missingMajorCharacters: _, ...rest }: typeof attempted) => rest;
  const priorBasis = new Set(failed.missingMajorCharacters.flatMap(item => item.basisUnitIds));
  const attemptedBasis = new Set(attempted.missingMajorCharacters.flatMap(item => item.basisUnitIds));
  const allowedNames = new Set([...failed.missingMajorCharacters.map(item => item.name), ...prior.correctionTargets]);
  if (contentHash(withoutMissing(attempted)) === contentHash(withoutMissing(failed))
    || contentHash(attempted) === contentHash(failed)
    || prior.correctionTargets.some((name: string) => !attempted.missingMajorCharacters.some(item => item.name === name))
    || attempted.missingMajorCharacters.some(item => !allowedNames.has(item.name))
    || [...priorBasis].some(id => !attemptedBasis.has(id))
    || attempted.atlasRevision !== failed.atlasRevision) {
    stop("the rejected preview is not the exact intended missing-character correction with only its full-draft fields overproduced");
  }
  if (toolOutcomes.some(event => event.data?.toolName !== "preview_role_review_audit" && event.seq > rejectedSeq)) {
    stop("the rejected preview did not follow its settled reads");
  }

  // Reconstruct the immutable task from the predecessor's complete context pages.
  const pages = new Map<number, string>();
  for (const event of await traces.peekEvents(prior.runId)) {
    if (event.type !== "tool.call.completed" || event.data?.toolName !== "read_role_session_context" || !event.blobRef) continue;
    const body = await traces.peekBlob(event.blobRef) as { content?: Array<{ text?: string }> };
    for (const item of body.content ?? []) if (item.text) {
      const pageBody = JSON.parse(item.text);
      if (pageBody.taskHash !== prior.taskHash || !Number.isInteger(pageBody.offset) || typeof pageBody.text !== "string"
        || (pages.has(pageBody.offset) && pages.get(pageBody.offset) !== pageBody.text)) {
        stop("the original task restoration changed");
      }
      pages.set(pageBody.offset, pageBody.text);
    }
  }
  const offsets = [...pages.keys()].sort((left, right) => left - right);
  const originalPrompt = offsets.map(offset => pages.get(offset)!).join("");
  if (!offsets.length || offsets.some((offset, index) => offset !== index) || contentHash(originalPrompt) !== prior.taskHash) {
    stop("the original task cannot be restored exactly");
  }

  const checkpointRaw = fs.readFileSync(prior.checkpointFile, "utf8");
  const checkpoint = JSON.parse(checkpointRaw);
  const before = prior.checkpointBefore;
  if (result.checkpointHash !== contentHash(checkpointRaw) || checkpoint.hash !== contentHash(checkpoint.state) || !before
    || contentHash(checkpoint.state.accesses.slice(0, before.accesses.length)) !== contentHash(before.accesses)
    || contentHash({ ...checkpoint.state, accesses: before.accesses }) !== contentHash(before)) {
    stop("the correction checkpoint changed beyond exact appended read access");
  }
  const parentFiles = [parent.file, `${parent.file}.usage.json`, `${parent.file}.result.json`]
    .map(parentFile => ({ file: parentFile, hash: hashFile(parentFile) }));
  const authority = {
    version: 1 as const,
    policy: "compile-audit-narrow-schema-repair-v1" as const,
    sourceHash: store.plan.sourceHash,
    planHash: store.planHash,
    workId,
    page,
    taskHash: prior.taskHash as string,
    attempt: prior.attempt as number,
    nextOrdinal: prior.nextOrdinal as number,
    parentFile: parent.file,
    parentAuthorityHash: parent.authorityHash,
    parentFiles,
    runId: run.id,
    runHash: contentHash(run),
    traceHash: contentHash(events),
    rejectedDraft: attempted,
    rejectedDraftHash: contentHash(attempted),
    checkpointRaw,
    checkpointHash: contentHash(checkpointRaw),
    proposalHistoryHash: contentHash(history),
    budget: { ...prior.budget, state: parent.usage },
    limits: { ...prior.limits, maxModelCalls: parent.usage.usage.modelCalls + 1 },
    correctionTargets: prior.correctionTargets as string[],
    requiredCandidateIds: prior.requiredCandidateIds as string[],
    requiredUnitIds: prior.requiredUnitIds as string[],
    retainedProgressCalls,
    remainingCalls: 1 as const,
    additionalCalls: 1 as const,
    implementationHash: contentHash(fs.readFileSync(fileURLToPath(import.meta.url), "utf8")),
  };
  return { authority, authorityHash: contentHash(authority), originalPrompt, file };
}

export type RoleAuditNarrowRepair = NonNullable<Awaited<ReturnType<typeof inspectRoleAuditNarrowRepair>>>;

export function readRoleAuditNarrowRepair(parent: Parent) {
  const file = repairFile(parent);
  if (!fs.existsSync(file)) return;
  const saved = read(file) as Pick<RoleAuditNarrowRepair, "authority" | "authorityHash">;
  const a = saved.authority;
  const retainedProgressCalls = parent.authority.remainingProgressCalls - parent.authority.additionalCalls;
  if (saved.authorityHash !== contentHash(a) || a.policy !== "compile-audit-narrow-schema-repair-v1"
    || a.parentFile !== parent.file || a.parentAuthorityHash !== parent.authorityHash
    || a.workId !== parent.authority.workId || a.planHash !== parent.authority.planHash || a.taskHash !== parent.authority.taskHash
    || a.page !== parent.authority.page || a.attempt !== parent.authority.attempt || a.nextOrdinal !== parent.authority.nextOrdinal
    || a.sourceHash !== parent.authority.sourceHash || a.remainingCalls !== 1 || a.additionalCalls !== 1
    || a.retainedProgressCalls !== retainedProgressCalls || retainedProgressCalls < 1
    || contentHash(a.correctionTargets) !== contentHash(parent.authority.correctionTargets)
    || contentHash(a.requiredCandidateIds) !== contentHash(parent.authority.requiredCandidateIds)
    || contentHash(a.requiredUnitIds) !== contentHash(parent.authority.requiredUnitIds)
    || contentHash(a.budget.state) !== contentHash(parent.usage)
    || a.limits.maxModelCalls !== parent.usage.usage.modelCalls + 1
    || contentHash(a.parentFiles.map(item => item.file).sort())
      !== contentHash([parent.file, `${parent.file}.usage.json`, `${parent.file}.result.json`].sort())
    || a.parentFiles.some(item => hashFile(item.file) !== item.hash)
    || a.rejectedDraftHash !== contentHash(a.rejectedDraft)
    || a.checkpointHash !== contentHash(a.checkpointRaw)) {
    stop("the narrow schema repair changed its parent, rejected draft, checkpoint or retained call");
  }
  const usageFile = `${file}.usage.json`;
  if (fs.existsSync(`${usageFile}.pending`) || !fs.existsSync(usageFile)) stop("narrow schema repair usage publication is uncertain");
  const usage = read(usageFile);
  if (usage.authorityHash !== saved.authorityHash
    || usage.hash !== contentHash({ authorityHash: usage.authorityHash, state: usage.state })
    || typeof usage.state?.blocked !== "boolean"
    || contentHash(Object.keys(usage.state.usage ?? {}).sort()) !== contentHash(Object.keys(parent.usage.usage).sort())
    || Object.entries(parent.usage.usage).some(([key, value]) => !Number.isSafeInteger(usage.state.usage[key]) || usage.state.usage[key] < value)
    || usage.state.usage.modelCalls > a.limits.maxModelCalls) {
    stop("narrow schema repair usage is unknown, regressed or exceeds its retained original call");
  }
  return { ...saved, file, usage: usage.state as ModelRequestBudgetState };
}

export async function openRoleAuditNarrowRepairBudget(store: RoleReviewWorkStore, preview: RoleAuditNarrowRepair) {
  if ((await WorkspaceOperationLock.inspect(store.root)).owner?.pid !== process.pid) stop("narrow schema repair requires the compiler lock");
  const parent = readAutomaticRoleCorrectionContinuation(store.root, store.planHash, preview.authority.workId)!;
  const saved = readRoleAuditNarrowRepair(parent);
  if (!saved || saved.authorityHash !== preview.authorityHash || fs.existsSync(`${preview.file}.started.json`)
    || fs.existsSync(`${preview.file}.result.json`) || saved.usage.blocked
    || contentHash(saved.usage) !== contentHash(parent.usage)) {
    stop("narrow schema repair was already dispatched or its retained state changed");
  }
  const claimed = saved!;
  fs.writeFileSync(`${preview.file}.started.json`, JSON.stringify({ authorityHash: preview.authorityHash, at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  return new ModelRequestBudget(preview.authority.limits, { initial: claimed.usage, save(state) {
    const value = { authorityHash: preview.authorityHash, state };
    const usageFile = `${preview.file}.usage.json`;
    fs.writeFileSync(`${usageFile}.pending`, JSON.stringify({ ...value, hash: contentHash(value) }), { flag: "wx", mode: 0o600 });
    fs.renameSync(`${usageFile}.pending`, usageFile);
  } }, { modelCallsMode: "enforce", requestBytesMode: "observe", totalBytesMode: "observe" });
}

export function buildRoleAuditNarrowRepairDraft(parent: Parent, raw: unknown) {
  const additions = roleAuditNarrowRepairSchema.parse(raw).missingMajorCharacters;
  const failed = roleAuditWorkSchema.parse(parent.authority.failedDraft);
  return assertHostRepairDraft(parent, {
    ...failed,
    missingMajorCharacters: [...failed.missingMajorCharacters, ...additions],
  });
}

export function recordRoleAuditNarrowRepairResult(store: RoleReviewWorkStore, preview: RoleAuditNarrowRepair, runId: string, error?: unknown) {
  const parent = readAutomaticRoleCorrectionContinuation(store.root, store.planHash, preview.authority.workId)!;
  const record = readRoleAuditNarrowRepair(parent)!;
  const receipt = readOriginalAutomaticAuditReceipt(store, preview.authority.page);
  const succeeded = error === undefined && Boolean(receipt);
  fs.writeFileSync(`${preview.file}.result.json`, JSON.stringify({
    authorityHash: preview.authorityHash,
    runId,
    status: succeeded ? "succeeded" : "failed",
    receiptHash: succeeded ? contentHash(receipt) : null,
    usage: record.usage,
    checkpointHash: hashFile(parent.authority.checkpointFile),
    proposalHistoryHash: contentHash(store.journal.history(ROLE_AUDIT_WORK_TOOL, preview.authority.workId)),
    ...(error === undefined ? {} : { error: String(error) }),
  }), { flag: "wx", mode: 0o600 });
}

export async function assertRoleAuditNarrowRepairHistory(store: RoleReviewWorkStore, parent: Parent) {
  const record = readRoleAuditNarrowRepair(parent);
  if (!record) stop("the failed full-draft correction has no verified narrow schema repair");
  const exactRecord = record!;
  const a = exactRecord.authority;
  const traces = new TraceStore(store.root);
  if (contentHash(await traces.peekRun(a.runId)) !== a.runHash || contentHash(await traces.peekEvents(a.runId)) !== a.traceHash) {
    stop("the retained full-draft failure trace changed");
  }
  const before = JSON.parse(a.checkpointRaw);
  const now = read(parent.authority.checkpointFile);
  if (before.hash !== contentHash(before.state) || now.hash !== contentHash(now.state)
    || contentHash(now.state.accesses.slice(0, before.state.accesses.length)) !== contentHash(before.state.accesses)
    || contentHash({ ...now.state, accesses: before.state.accesses }) !== contentHash(before.state)) {
    stop("the narrow schema repair changed its original context beyond appended read access");
  }
  if (!fs.existsSync(`${exactRecord.file}.result.json`) || !fs.existsSync(`${exactRecord.file}.started.json`)) {
    stop("narrow schema repair has an uncertain outcome; do not redispatch");
  }
  const result = read(`${exactRecord.file}.result.json`);
  const started = read(`${exactRecord.file}.started.json`);
  const history = store.journal.history(ROLE_AUDIT_WORK_TOOL, a.workId);
  const prefix = history.slice(0, parent.authority.proposalHistoryLength);
  const suffix = history.slice(prefix.length);
  const receipt = readOriginalAutomaticAuditReceipt(store, a.page);
  const run = await traces.peekRun(result.runId);
  if (started.authorityHash !== exactRecord.authorityHash || result.authorityHash !== exactRecord.authorityHash
    || result.status !== "succeeded" || contentHash(result.usage) !== contentHash(exactRecord.usage)
    || exactRecord.usage.blocked || exactRecord.usage.failure || exactRecord.usage.usage.modelCalls !== a.limits.maxModelCalls
    || run.status !== "succeeded"
    || run.sourceId !== store.plan.sourceId || run.operationId !== store.plan.batchId
    || result.checkpointHash !== hashFile(parent.authority.checkpointFile)
    || result.proposalHistoryHash !== contentHash(history)
    || contentHash(prefix) !== a.proposalHistoryHash
    || suffix.length !== 2 || suffix[0]?.status !== "running" || suffix[1]?.status !== "succeeded"
    || suffix[0].inputHash !== suffix[1].inputHash || !receipt || result.receiptHash !== contentHash(receipt)) {
    stop("narrow schema repair failed or lacks its exact validated receipt; its retained original call cannot be repeated");
  }
  assertHostRepairDraft(parent, receipt);
}
