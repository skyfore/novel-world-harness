import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../world/canonical.js";
import { worldStorageRoot } from "../world/paths.js";
import { TraceStore } from "../trace/store.js";
import { WorkspaceOperationLock } from "../util/workspace-lock.js";
import { NovelCompilationRunStore } from "../workflow/novel-compilation.js";
import { ROLE_CONTEXT_MAX_SESSIONS } from "../workflow/role-session-context.js";
import { RequirementLedger } from "./requirement-ledger.js";
import { CompilerFinishReceipts } from "./finish-receipts.js";
import { inspectRoleReviewBudget, remainingRoleProgressCalls } from "./role-review-budget.js";
import { ROLE_AUDIT_WORK_TOOL, RoleReviewWorkStore, roleAuditWorkSchema, roleWorkStop } from "./role-review-work.js";
import { loadCurrentRoleRoster } from "./role-roster-tools.js";
import { CompilerProposalObligations } from "./proposal-obligations.js";
import { assertRoleWorkPlanAuthority } from "./role-work-migration.js";

export type MigratedSourceAuditProof = {
  workId: string;
  revisionId: string;
  priorPlanHash: string;
  priorReceiptHash: string;
  allowanceHash: string;
};

export type ExhaustedMigratedSourceAuditResume = {
  policy: "migrated-audit-invocation";
  planHash: string;
  workId: string;
  taskHash: string;
  authorityHash: string;
  maxAdditionalModelCalls: number;
};

type TraceBinding = {
  runId: string;
  runHash: string;
  traceHash: string;
  status: "failed" | "succeeded";
  sessionOrdinal: number;
};

export type ExhaustedMigratedSourceAuditAuthority = {
  version: 1;
  policy: "compile-migrated-audit-invocation-v1";
  sourceId: string;
  sourceHash: string;
  batchId: string;
  planHash: string;
  subjectHash: string;
  revisionId: string;
  workId: string;
  page: number;
  taskHash: string;
  priorBatchId: string;
  priorPlanHash: string;
  priorSubjectHash: string;
  priorWorkId: string;
  priorReceiptHash: string;
  priorAuditHash: string;
  priorAtlasRevision: string;
  priorEntriesHash: string;
  atlasRevision: string;
  entriesHash: string;
  claimAuditsHash: string;
  allowanceHash: string;
  retainedFilesHash: string;
  startingUsage: { modelCalls: number; payloads: number; totalPayloadBytes: number; largestRequestBytes: number };
  startingProgressHash: string;
  maxAdditionalModelCalls: number;
  maxNewInvocations: 1;
  maxNewSessions: 1;
  nextSessionOrdinal: number;
  traces: TraceBinding[];
  scheduleRunId: string;
  scheduleHash: string;
  blockedReceiptHash: string;
};

export type ExhaustedMigratedSourceAuditPreview = {
  authority: ExhaustedMigratedSourceAuditAuthority;
  authorityHash: string;
  file: string;
};

const names = (directory: string) => fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return [] as string[];
  throw error;
});
const readJson = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
const allowanceStop = roleWorkStop("work invocation allowance exhausted").message;
const recoveryBase = (root: string) => path.join(worldStorageRoot(root), "compiler", "role-review-work");

function settledCalls(events: Awaited<ReturnType<TraceStore["peekEvents"]>>, prefix: "tool.call" | "llm") {
  const starts = events.filter(event => event.type === (prefix === "tool.call" ? "tool.call.started" : "llm.request.started"));
  const terminalTypes = prefix === "tool.call"
    ? new Set(["tool.call.completed", "tool.call.failed"])
    : new Set(["llm.response.completed", "llm.response.failed"]);
  return starts.every(start => {
    const terminals = events.filter(event => terminalTypes.has(event.type)
      && event.callId === start.callId && (prefix !== "tool.call" || event.toolCallId === start.toolCallId));
    return terminals.length === 1 && terminals[0]!.seq > start.seq;
  })
    && events.filter(event => terminalTypes.has(event.type)).every(terminal => starts.some(start => start.callId === terminal.callId
      && start.seq < terminal.seq && (prefix !== "tool.call" || start.toolCallId === terminal.toolCallId)));
}

async function currentState(store: RoleReviewWorkStore, workId: string, claimed: boolean) {
  const base = recoveryBase(store.root), workHash = contentHash(workId);
  const attemptDirectory = path.join(base, "v1", contentHash(store.plan.sourceId), "attempts", contentHash(store.plan.batchId), workHash);
  if ((await names(attemptDirectory)).length) throw roleWorkStop("current migrated audit already has an invocation record; preserve it and do not combine recovery authorities");
  for (const kind of ["context", "context-loops", "native-context-fallbacks"] as const) {
    const directory = path.join(base, kind, store.planHash);
    if ((await names(directory)).some(name => name.startsWith(workHash))) {
      throw roleWorkStop("current migrated audit already has context state; preserve the consumed recovery and do not redispatch");
    }
  }
  const budgetDirectory = path.join(base, "budgets", store.planHash);
  const budgetFiles = (await names(budgetDirectory)).filter(name => name.startsWith(workHash));
  if (!claimed) {
    if (budgetFiles.length) throw roleWorkStop("current migrated audit already has budget state; preserve it and do not redispatch");
    return;
  }
  if (budgetFiles.length !== 1 || budgetFiles[0] !== `${workHash}.json`) {
    throw roleWorkStop("claimed migrated audit has missing, pending or ambiguous cumulative usage; stop without dispatch");
  }
  const allowance = store.inheritedAllowance(workId)!;
  const budget = inspectRoleReviewBudget(store.root, store.planHash, store.budgetWorkId(workId));
  if (contentHash({ limits: budget.limits, state: budget.state }) !== contentHash(allowance.budget)) {
    throw roleWorkStop("claimed migrated audit usage differs from the retained cumulative starting point; never reset or infer charges");
  }
}

async function exhaustedMigrationEvidence(store: RoleReviewWorkStore, workId: string, taskHash: string, claimed: boolean) {
  await assertRoleWorkPlanAuthority(store.root, store.plan);
  const current = await loadCurrentRoleRoster(store.root, store.plan.sourceId);
  store.assertScope(current.roster, contentHash(current.structure), current.structure.sourceBytes);
  const migration = store.plan.migration;
  const page = store.plan.spans.findIndex((_, index) => store.workId("audit", index) === workId);
  if (!migration || page < 0 || !/^[a-f0-9]{64}$/.test(taskHash)) {
    throw roleWorkStop("select the exact missing audit and its immutable current prompt from the active migrated plan; never guess an ID or reconstruct a prompt");
  }
  store.journal.assertModelRecoveryAllowed();
  if (store.read("audit", page) || store.journal.unresolved().length || store.journal.history(ROLE_AUDIT_WORK_TOOL, workId).length) {
    throw roleWorkStop("current migrated audit is settled or has proposal history; recover that exact receipt instead of granting another invocation");
  }
  if (await new CompilerFinishReceipts(store.root, store.plan.sourceId, store.plan.batchId).read()
    || store.journal.history("propose_role_roster_review", "role-roster-review").length) {
    throw roleWorkStop("roster assembly or finish already started; recover that original scope instead of reopening a source audit");
  }
  const allowance = store.inheritedAllowance(workId);
  if (!allowance?.budget || allowance.attempts !== 2 || allowance.contextSessions !== ROLE_CONTEXT_MAX_SESSIONS - 1
    || (allowance.contextHandoffs ?? 0) !== 0 || allowance.nativeContextFallback
    || allowance.budget.state.blocked || allowance.budget.state.failure) {
    throw roleWorkStop("exhausted migrated audit does not match two retained invocations, two settled contexts and an intact unblocked budget; preserve its stop");
  }
  const maxAdditionalModelCalls = remainingRoleProgressCalls(allowance.budget);
  if (!maxAdditionalModelCalls) throw roleWorkStop("exhausted migrated audit has no retained progress window; do not reset its counter or grant new calls");
  const revision = (await new RequirementLedger(store.root, store.plan.sourceId).roleReviewRevisions())
    .find(item => item.id === migration.revisionId);
  if (!revision?.workMigration || contentHash(revision.workMigration.nextPlan) !== contentHash(store.plan)) {
    throw roleWorkStop("migrated audit lacks its exact subject-revision authority; preserve both scopes and stop");
  }
  const prior = new RoleReviewWorkStore(store.root, revision.workMigration.priorPlan);
  const priorWorkId = prior.workId("audit", page), receipt = prior.journal.history(ROLE_AUDIT_WORK_TOOL, priorWorkId).at(-1);
  if (!receipt || receipt.status !== "succeeded" || prior.journal.unresolved().length) {
    throw roleWorkStop("predecessor audit is not terminally successful; recover its original task and never replace it with migrated revalidation");
  }
  const input = receipt.input as { planHash: string; entriesHash?: string; payload: unknown };
  if (input.planHash !== prior.planHash || receipt.inputHash !== CompilerProposalObligations.identity(ROLE_AUDIT_WORK_TOOL, receipt.input).inputHash) {
    throw roleWorkStop("predecessor audit receipt integrity changed; preserve history and do not retry");
  }
  const priorAudit = roleAuditWorkSchema.parse(input.payload);
  if (!priorAudit.atlasRevision || !input.entriesHash || !/^[a-f0-9]{64}$/.test(input.entriesHash)) {
    throw roleWorkStop("predecessor audit lacks its exact atlas or entries binding; never infer stale semantic scope");
  }
  const atlasRevision = store.atlasRevision(), entriesHash = store.entriesHash(), claimAudits = store.claimAudits();
  if (store.stagedEntries().some(entry => !claimAudits.some(audit => audit.candidateId === entry.candidateId && audit.verdict === "supported"))) {
    throw roleWorkStop("current migrated audit has a missing or unsupported claim dependency; preserve that original finding instead of reopening source audit work");
  }
  if (priorAudit.atlasRevision === atlasRevision && input.entriesHash === entriesHash) {
    throw roleWorkStop("predecessor audit is not stale against the current subject; import is forbidden and another invocation is unjustified");
  }

  const base = recoveryBase(store.root), priorHash = contentHash(priorWorkId);
  const attemptDirectory = path.join(base, "v1", contentHash(store.plan.sourceId), "attempts", contentHash(prior.plan.batchId), priorHash);
  const attemptNames = (await names(attemptDirectory)).sort();
  if (contentHash(attemptNames) !== contentHash(["1.json", "2.json"])) {
    throw roleWorkStop("predecessor invocation lineage is not exactly the two retained attempts; do not infer or renew an allowance");
  }
  const attempts = await Promise.all(attemptNames.map(name => readJson(path.join(attemptDirectory, name))));
  if (attempts.some(attempt => attempt.planHash !== prior.planHash || attempt.workId !== priorWorkId || Number.isNaN(Date.parse(attempt.at)))) {
    throw roleWorkStop("predecessor attempt identity changed; preserve the retained records and stop");
  }
  const contextRoot = path.join(base, "context-loops", prior.planHash, priorHash);
  const taskDirectories = await names(contextRoot);
  if (taskDirectories.length !== 1 || !/^[a-f0-9]{64}$/.test(taskDirectories[0]!)) {
    throw roleWorkStop("predecessor context task is missing or ambiguous; never reconstruct it from a summary");
  }
  const priorTaskHash = taskDirectories[0]!, contextDirectory = path.join(contextRoot, priorTaskHash);
  const contextNames = await names(contextDirectory);
  if (contextNames.some(name => !/^[01](?:\.outcome)?\.json$/.test(name))) {
    throw roleWorkStop("predecessor context lineage contains an unknown round or write; preserve it for host review");
  }
  const claimNames = contextNames.filter(name => /^[01]\.json$/.test(name)).sort();
  if (contentHash(claimNames) !== contentHash(["0.json", "1.json"])) {
    throw roleWorkStop("predecessor context lineage is incomplete; do not infer a missing session");
  }
  const claims = await Promise.all(claimNames.map(name => readJson(path.join(contextDirectory, name))));
  if (claims.some((record, ordinal) => record.hash !== contentHash(record.claim) || record.claim.planHash !== prior.planHash
    || record.claim.workId !== priorWorkId || record.claim.taskHash !== priorTaskHash || record.claim.ordinal !== ordinal)) {
    throw roleWorkStop("predecessor context claim integrity changed; preserve it and stop");
  }

  const traceStore = new TraceStore(store.root);
  const allRuns = await traceStore.peekAllRuns({ sourceId: store.plan.sourceId, kind: "prepare" });
  const manifests = allRuns.filter(run => run.operationId === prior.plan.batchId);
  const traced: Array<{ binding: TraceBinding; events: Awaited<ReturnType<TraceStore["peekEvents"]>>; startedAt: string; endedAt: string }> = [];
  for (const run of manifests) {
    const events = await traceStore.peekEvents(run.id);
    const work = events.find(event => event.type === "validation.completed" && event.data?.phase === "role-review-work")?.data;
    if (work?.workId !== priorWorkId) continue;
    const observations = events.filter(event => event.type === "validation.completed" && event.data?.phase === "role-request-observation");
    const ordinals = [...new Set(observations.map(event => event.data?.sessionOrdinal))];
    if (run.status !== "failed" && run.status !== "succeeded" || !run.endedAt || work.planHash !== prior.planHash
      || ordinals.length !== 1 || !Number.isInteger(ordinals[0]) || observations.some(event => event.data?.planHash !== prior.planHash
        || event.data?.workId !== priorWorkId || event.data?.logicalTaskHash !== priorTaskHash)
      || !settledCalls(events, "tool.call") || !settledCalls(events, "llm")
      || events.some(event => event.type.startsWith("world.commit."))
      || events.at(-1)?.type !== (run.status === "succeeded" ? "run.succeeded" : "run.failed")) {
      throw roleWorkStop("predecessor trace is nonterminal, ambiguous or crosses the compiler/world boundary; do not grant revalidation");
    }
    const terminalProposal = events.filter(event => event.type === "tool.call.started"
      && event.data?.toolName === ROLE_AUDIT_WORK_TOOL && event.data?.inputHash === contentHash(priorAudit)
      && events.some(done => done.type === "tool.call.completed" && done.toolCallId === event.toolCallId
        && done.data?.toolName === ROLE_AUDIT_WORK_TOOL && done.data?.isError !== true));
    if ((run.status === "succeeded" && terminalProposal.length !== 1) || (run.status === "failed" && terminalProposal.length)) {
      throw roleWorkStop("predecessor trace terminal status disagrees with its audit proposal; preserve the trace and stop");
    }
    traced.push({ binding: { runId: run.id, runHash: contentHash(run), traceHash: contentHash(events), status: run.status,
      sessionOrdinal: ordinals[0] as number }, events, startedAt: run.startedAt, endedAt: run.endedAt });
  }
  traced.sort((left, right) => left.binding.sessionOrdinal - right.binding.sessionOrdinal);
  if (traced.length !== 2 || traced[0]!.binding.sessionOrdinal !== 0 || traced[0]!.binding.status !== "failed"
    || traced[1]!.binding.sessionOrdinal !== 1 || traced[1]!.binding.status !== "succeeded"
    || Date.parse(traced[0]!.endedAt) >= Date.parse(traced[1]!.startedAt)) {
    throw roleWorkStop("predecessor traces do not prove one failed context followed by one terminally successful context; do not create a third ordinary attempt");
  }
  const terminalUsage = traced[1]!.events.findLast(event => event.type === "validation.completed"
    && event.data?.phase === "role-review-work-usage")?.data?.budget as {
      usage?: unknown; progress?: { lastProgressCall?: unknown; milestones?: unknown }; blocked?: unknown;
    } | undefined;
  const traceProgress = terminalUsage?.progress ? {
    lastProgressCall: terminalUsage.progress.lastProgressCall,
    milestones: terminalUsage.progress.milestones,
  } : undefined;
  if (contentHash(terminalUsage?.usage ?? null) !== contentHash(allowance.budget.state.usage)
    || contentHash(traceProgress ?? null) !== contentHash(allowance.budget.state.progress ?? null)
    || terminalUsage?.blocked !== false) {
    throw roleWorkStop("successful predecessor trace does not reconcile to the retained cumulative budget; never infer or reset usage");
  }
  const currentRuns = allRuns.filter(run => run.operationId === store.plan.batchId);
  for (const run of currentRuns) {
    const events = await traceStore.peekEvents(run.id);
    if (events.some(event => event.type === "validation.completed" && event.data?.phase === "role-review-work" && event.data.workId === workId)) {
      throw roleWorkStop("a current-plan trace already exists for the exhausted migrated audit; recover that exact outcome instead of granting a new invocation");
    }
  }

  const schedule = await new NovelCompilationRunStore(store.root).read(store.plan.sourceId);
  const history = schedule?.history ?? [], latest = history.at(-1);
  const currentRunning = latest?.phase === "roles" && latest.status === "running";
  const beforeCurrent = currentRunning ? history.slice(0, -1) : history;
  const blockedIndex = beforeCurrent.findLastIndex(receipt => receipt.phase === "roles" && receipt.status === "blocked"
    && receipt.error === allowanceStop);
  const blocked = blockedIndex >= 0 ? beforeCurrent[blockedIndex] : undefined;
  const laterRoleReceipt = blockedIndex >= 0 && beforeCurrent.slice(blockedIndex + 1).some(receipt => receipt.phase === "roles");
  if (!schedule || schedule.sourceId !== store.plan.sourceId || schedule.sourceSha256 !== store.plan.sourceHash || schedule.completed
    || blocked?.phase !== "roles" || blocked.status !== "blocked" || blocked.error !== allowanceStop || !blocked.finishedAt
    || laterRoleReceipt || (!currentRunning && blockedIndex !== history.length - 1)
    || (currentRunning && Date.parse(latest.startedAt) < Date.parse(blocked.finishedAt))) {
    throw roleWorkStop("latest scheduling history is not the exact settled roles allowance-exhaustion incident; inspect status and do not retry unchanged");
  }
  await currentState(store, workId, claimed);
  const blockedReceiptHash = contentHash(blocked);
  const authority: ExhaustedMigratedSourceAuditAuthority = {
    version: 1, policy: "compile-migrated-audit-invocation-v1", sourceId: store.plan.sourceId,
    sourceHash: store.plan.sourceHash, batchId: store.plan.batchId, planHash: store.planHash,
    subjectHash: store.plan.subjectHash, revisionId: migration.revisionId, workId, page, taskHash,
    priorBatchId: prior.plan.batchId, priorPlanHash: prior.planHash, priorSubjectHash: prior.plan.subjectHash,
    priorWorkId, priorReceiptHash: contentHash(receipt), priorAuditHash: contentHash(priorAudit),
    priorAtlasRevision: priorAudit.atlasRevision, priorEntriesHash: input.entriesHash,
    atlasRevision, entriesHash, claimAuditsHash: contentHash(claimAudits), allowanceHash: contentHash(allowance),
    retainedFilesHash: contentHash(revision.workMigration.retainedFiles), startingUsage: allowance.budget.state.usage,
    startingProgressHash: contentHash(allowance.budget.state.progress ?? null), maxAdditionalModelCalls,
    maxNewInvocations: 1, maxNewSessions: 1, nextSessionOrdinal: allowance.contextSessions,
    traces: traced.map(item => item.binding), scheduleRunId: schedule.id, scheduleHash: contentHash(schedule), blockedReceiptHash,
  };
  const file = path.join(base, "host-interruptions", "migrated-audit-invocation", store.planHash,
    `${contentHash({ scheduleRunId: schedule.id, blockedReceiptHash })}.json`);
  return { authority, authorityHash: contentHash(authority), file };
}

/** Read-only host preview for the one exceptional case where a completed audit
 * became stale solely through an authorized subject migration after consuming
 * both predecessor invocations. This never imports that old audit or writes. */
export async function inspectExhaustedMigratedSourceAudit(store: RoleReviewWorkStore, workId: string, taskHash: string): Promise<ExhaustedMigratedSourceAuditPreview> {
  await assertNoClaimedExhaustedMigratedSourceAudit(store);
  const preview = await exhaustedMigrationEvidence(store, workId, taskHash, false);
  if ((await names(path.dirname(preview.file))).includes(path.basename(preview.file))) {
    throw roleWorkStop("the exact migrated-audit invocation grant is already consumed; inspect its result and never renew it");
  }
  return preview;
}

/** A consumed exceptional grant has precedence over every ordinary automatic
 * correction. Its failure may not be reclassified into another continuation. */
export async function assertNoClaimedExhaustedMigratedSourceAudit(store: RoleReviewWorkStore) {
  const directory = path.join(recoveryBase(store.root), "host-interruptions", "migrated-audit-invocation", store.planHash);
  const files = await names(directory);
  for (const name of files) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) throw roleWorkStop("migrated-audit recovery directory contains an uncertain write; preserve it and stop");
    const record = await readJson(path.join(directory, name));
    if (record.authorityHash !== contentHash(record.authority) || record.authority?.version !== 1
      || record.authority?.policy !== "compile-migrated-audit-invocation-v1" || record.authority?.planHash !== store.planHash) {
      throw roleWorkStop("migrated-audit recovery claim integrity changed; preserve it and stop");
    }
  }
  if (files.length) throw roleWorkStop("a single-use migrated-audit invocation grant for this plan is already consumed; recover its exact result and never route it into another automatic continuation");
}

/** Compiler-lock claim. The single durable record is both authority and usage
 * marker; a crash after this write consumes the grant rather than making its
 * dispatch ambiguous or recreating an ordinary attempt. */
export async function claimExhaustedMigratedSourceAudit(store: RoleReviewWorkStore, preview: ExhaustedMigratedSourceAuditPreview): Promise<ExhaustedMigratedSourceAuditResume> {
  if ((await WorkspaceOperationLock.inspect(store.root)).owner?.pid !== process.pid) {
    throw roleWorkStop("migrated-audit invocation recovery requires the owning compiler lock");
  }
  const current = await inspectExhaustedMigratedSourceAudit(store, preview.authority.workId, preview.authority.taskHash);
  if (current.authorityHash !== preview.authorityHash || current.file !== preview.file) {
    throw roleWorkStop("migrated-audit recovery preview changed; inspect current traces and scope before any dispatch");
  }
  await fs.mkdir(path.dirname(current.file), { recursive: true });
  await fs.writeFile(current.file, JSON.stringify({ authority: current.authority, authorityHash: current.authorityHash,
    claimedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  return { policy: "migrated-audit-invocation", planHash: store.planHash, workId: current.authority.workId,
    taskHash: current.authority.taskHash, authorityHash: current.authorityHash,
    maxAdditionalModelCalls: current.authority.maxAdditionalModelCalls };
}

/** Recheck immediately before publishing the final inherited context claim. */
export async function inspectClaimedExhaustedMigratedSourceAudit(store: RoleReviewWorkStore, resume: ExhaustedMigratedSourceAuditResume) {
  if (resume.policy !== "migrated-audit-invocation" || resume.planHash !== store.planHash) {
    throw roleWorkStop("foreign migrated-audit recovery authority; preserve the current task and stop");
  }
  const recordPreview = await exhaustedMigrationEvidence(store, resume.workId, resume.taskHash, true);
  let record;
  try { record = await readJson(recordPreview.file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw roleWorkStop("migrated-audit recovery was not claimed under the compiler lock"); throw error; }
  if (record.authorityHash !== resume.authorityHash || record.authorityHash !== contentHash(record.authority)
    || record.authorityHash !== recordPreview.authorityHash || contentHash(record.authority) !== contentHash(recordPreview.authority)
    || resume.maxAdditionalModelCalls !== recordPreview.authority.maxAdditionalModelCalls) {
    throw roleWorkStop("migrated-audit recovery authority, trace or cumulative usage changed after claim; stop without dispatch");
  }
  return { workId: resume.workId, taskHash: resume.taskHash, nextOrdinal: recordPreview.authority.nextSessionOrdinal,
    recoveryInfo: { reason: "Host-bound revalidation of a materially changed migrated audit after a successful exhausted predecessor",
      authorityHash: resume.authorityHash, predecessorRunIds: recordPreview.authority.traces.map(trace => trace.runId),
      retainedStartingCalls: recordPreview.authority.startingUsage.modelCalls,
      maxAdditionalModelCalls: recordPreview.authority.maxAdditionalModelCalls } };
}

/** Read-only selection of revalidation already authorized by a subject revision.
 * This does not grant attempts, import an old audit, or revive a stopped task. */
export async function inspectMigratedSourceAudit(store: RoleReviewWorkStore, workId: string): Promise<MigratedSourceAuditProof> {
  await assertRoleWorkPlanAuthority(store.root, store.plan);
  const migration = store.plan.migration;
  const page = store.plan.spans.findIndex((_, index) => store.workId("audit", index) === workId);
  if (!migration || page < 0) throw roleWorkStop("select a migrated source audit using RoleReviewWorkStore.plans and copy workId('audit', page); correct the selection once, never guess IDs");
  store.journal.assertModelRecoveryAllowed();
  if (store.journal.unresolved().length || store.journal.history(ROLE_AUDIT_WORK_TOOL, workId).length) {
    throw roleWorkStop("current-plan audit or unresolved proposal already exists; inspect its original receipt and do not redispatch");
  }
  if (await new CompilerFinishReceipts(store.root, store.plan.sourceId, store.plan.batchId).read()
    || store.journal.history("propose_role_roster_review", "role-roster-review").length) {
    throw roleWorkStop("roster assembly or finish already started; recover that original scope instead of dispatching a source audit");
  }
  const allowance = store.inheritedAllowance(workId);
  if (!allowance?.attempts || !allowance.budget || allowance.attempts >= 2
    || allowance.budget.state.blocked || allowance.budget.state.failure || remainingRoleProgressCalls(allowance.budget) === 0
    || allowance.nativeContextFallback || allowance.contextSessions === undefined || allowance.contextSessions >= ROLE_CONTEXT_MAX_SESSIONS
    || (allowance.contextHandoffs ?? 0) >= 2) {
    throw roleWorkStop("migrated audit lacks an intact remaining invocation, context or progress allowance; retain its stop and do not retry");
  }
  const revision = (await new RequirementLedger(store.root, store.plan.sourceId).roleReviewRevisions())
    .find(item => item.id === migration.revisionId)!;
  const prior = new RoleReviewWorkStore(store.root, revision.workMigration!.priorPlan);
  const receipt = prior.journal.history(ROLE_AUDIT_WORK_TOOL, prior.workId("audit", page)).at(-1);
  if (!receipt || receipt.status !== "succeeded") throw roleWorkStop("predecessor audit has no verified terminal receipt; recover its original task, never replace an interrupted audit with a diagnostic prompt");
  const input = receipt.input as { planHash: string; payload: unknown };
  if (input.planHash !== prior.planHash || receipt.inputHash !== CompilerProposalObligations.identity(ROLE_AUDIT_WORK_TOOL, receipt.input).inputHash) {
    throw roleWorkStop("predecessor audit receipt integrity changed; preserve history and do not retry");
  }
  roleAuditWorkSchema.parse(input.payload);

  // Dispatch opens checkpoints before reserving an invocation. Even an empty
  // local attempt directory cannot prove that changing this task is safe.
  const base = path.join(worldStorageRoot(store.root), "compiler", "role-review-work");
  const workHash = contentHash(workId);
  const attempts = path.join(base, "v1", contentHash(store.plan.sourceId), "attempts", contentHash(store.plan.batchId), workHash);
  const locations = [
    { directory: path.dirname(attempts), prefix: workHash },
    ...["budgets", "context", "context-loops", "native-context-fallbacks"].map(kind => ({ directory: path.join(base, kind, store.planHash), prefix: workHash })),
  ];
  for (const location of locations) {
    const names = await fs.readdir(location.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (names.some(name => name.startsWith(location.prefix))) throw roleWorkStop("current-plan audit already has invocation, context or budget state; preserve the immutable task and do not redispatch");
  }
  return { workId, revisionId: migration.revisionId, priorPlanHash: prior.planHash,
    priorReceiptHash: contentHash(receipt), allowanceHash: contentHash(allowance) };
}
