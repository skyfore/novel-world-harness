import fs from "node:fs/promises";
import syncFs from "node:fs";
import path from "node:path";
import { contentHash } from "../world/canonical.js";
import { worldStorageRoot } from "../world/paths.js";
import { TraceStore } from "../trace/store.js";
import { WorkspaceOperationLock } from "../util/workspace-lock.js";
import { ModelRequestBudget, type ModelRequestBudgetState } from "../runtime/model-request-budget.js";
import { inspectRoleReviewBudget, remainingRoleProgressCalls } from "./role-review-budget.js";
import { ROLE_AUDIT_WORK_TOOL, RoleReviewWorkStore, roleAuditWorkSchema, roleWorkStop } from "./role-review-work.js";
import { roleFindingId, sameIds } from "./role-review-verification.js";
import { CompilerProposalObligations } from "./proposal-obligations.js";

const refusal = "Codex error: The usage limit has been reached";
const NO_PROGRESS_ADDITIONAL_CALLS = 3;
const CORRECTION_ADDITIONAL_CALLS = 3;
const names = (dir: string): Promise<string[]> => fs.readdir(dir).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
const stop = (why: string) => roleWorkStop(`${why}; inspect compile-novel status and the original trace for this work, preserve its records and do not retry unchanged`);
export type AutomaticRoleResume = Awaited<ReturnType<typeof inspectAutomaticRoleResume>> & {};

type TraceRun = Awaited<ReturnType<TraceStore["peekRun"]>>;
type TraceEvents = Awaited<ReturnType<TraceStore["peekEvents"]>>;

function zeroUsage(value: unknown) {
  const usage = value as { input?: unknown; output?: unknown; totalTokens?: unknown } | undefined;
  return usage?.input === 0 && usage.output === 0 && usage.totalTokens === 0;
}

/** The continuation receipt is the immutable original audit proposal. A later
 * independently checked source-audit repair may supersede the active projection
 * without rewriting this lineage. */
export function readOriginalAutomaticAuditReceipt(store: RoleReviewWorkStore, page: number) {
  const workId = store.workId("audit", page), record = store.journal.history(ROLE_AUDIT_WORK_TOOL, workId).at(-1);
  if (!record || record.status !== "succeeded") return;
  const input = record.input as { planHash?: string; entriesHash?: string; payload?: unknown };
  if (record.inputHash !== CompilerProposalObligations.identity(ROLE_AUDIT_WORK_TOOL, record.input).inputHash
    || input.planHash !== store.planHash || input.entriesHash !== store.entriesHash()) throw stop("original automatic audit receipt scope changed");
  return roleAuditWorkSchema.parse(input.payload);
}

/** A model may incorrectly treat its first invalid typed proposal as exhausted
 * after both ordinary invocations have already been claimed. This policy is
 * deliberately narrower than another invocation: it accepts only a settled
 * no-receipt trace whose sole failed tool is the still-correctable audit input. */
async function inspectCorrectionResume(input: {
  store: RoleReviewWorkStore; page: number; base: string; attempts: string[];
  run: TraceRun; events: TraceEvents; traces: TraceStore;
}) {
  const { store, page, base, attempts, run, events, traces } = input;
  const workId = store.workId("audit", page);
  const inheritedAllowance = store.inheritedAllowance(workId);
  const inheritedAttempts = inheritedAllowance?.attempts ?? 0;
  const expectedAttempts = Array.from({ length: 2 - inheritedAttempts }, (_, index) => `${inheritedAttempts + index + 1}.json`);
  const history = store.journal.history(ROLE_AUDIT_WORK_TOOL, workId);
  const unresolved = store.journal.unresolved();
  if (inheritedAttempts > 1 || contentHash(attempts) !== contentHash(expectedAttempts) || unresolved.length !== 1
    || unresolved[0]!.tool !== ROLE_AUDIT_WORK_TOOL || unresolved[0]!.proposalId !== workId
    || history.length !== 2 || history[0]?.status !== "running" || history[1]?.status !== "failed"
    || history[0].inputHash !== history[1].inputHash
    || contentHash(history[0].input) !== contentHash(history[1].input)
    || history.some(record => record.hostReview || record.coverageProof)) {
    throw stop("audit correction does not have one exact, unused proposal correction after both ordinary invocations");
  }
  const failed = history[1]!, envelope = failed.input as {
    proposal_id?: unknown; planHash?: unknown; entriesHash?: unknown; payload?: unknown;
  };
  if (failed.inputHash !== CompilerProposalObligations.identity(ROLE_AUDIT_WORK_TOOL, failed.input).inputHash
    || envelope.proposal_id !== workId || envelope.planHash !== store.planHash
    || envelope.entriesHash !== store.entriesHash()) throw stop("failed audit proposal identity or frozen entries changed");
  const failedDraft = roleAuditWorkSchema.parse(envelope.payload);
  const diagnostic = failed.diagnostic.replace(/^Error: /, "");
  const correctionTargets = diagnostic.split("\n").filter(Boolean).map(line => {
    const match = /^missingMajorCharacters: Missing-major discovery must retain (.+)\. Copy the assigned discovery name into missingMajorCharacters with original evidence\. Preserve the finding and correct once; never drop responsibilities\.$/u.exec(line);
    if (!match) throw stop("failed audit diagnostic is not the narrow missing-major-name correction");
    return match[1]!;
  });
  if (!correctionTargets.length || new Set(correctionTargets).size !== correctionTargets.length
    || correctionTargets.every(name => failedDraft.missingMajorCharacters.some(item => item.name === name))) {
    throw stop("failed audit diagnostic has no exact, materially correctable discovery name");
  }

  const budget = inspectRoleReviewBudget(store.root, store.planHash, workId);
  const expectedFailure = String(roleWorkStop("model ended without the assigned work receipt"));
  if (run.kind !== "prepare" || run.status !== "failed" || !run.endedAt
    || run.sourceId !== store.plan.sourceId || run.operationId !== store.plan.batchId
    || run.error?.code !== "ROLE_REVIEW_WORK_FAILED" || run.error.message !== expectedFailure
    || events.at(-1)?.type !== "run.failed" || budget.state.blocked || budget.state.failure
    || remainingRoleProgressCalls(budget) < CORRECTION_ADDITIONAL_CALLS) {
    throw stop("latest audit stop is not the exact settled no-receipt failure with a finite retained progress window");
  }
  const works = events.filter(event => event.type === "validation.completed" && event.data?.phase === "role-review-work");
  const stopped = events.filter(event => event.type === "validation.completed" && event.data?.phase === "role-review-work-stopped");
  const observations = events.filter(event => event.type === "validation.completed" && event.data?.phase === "role-request-observation");
  const taskHash = observations[0]?.data?.logicalTaskHash;
  if (works.length !== 1 || works[0]!.data?.planHash !== store.planHash || works[0]!.data?.workId !== workId
    || contentHash(works[0]!.data?.limits) !== contentHash(budget.limits) || works[0]!.data?.modelCallsMode !== "progress"
    || stopped.length !== 1 || stopped[0]!.data?.workId !== workId
    || !Array.isArray(stopped[0]!.data?.compactions) || (stopped[0]!.data!.compactions as unknown[]).length
    || contentHash((stopped[0]!.data?.budget as { usage?: unknown } | undefined)?.usage ?? null) !== contentHash(budget.state.usage)
    || typeof taskHash !== "string" || !/^[a-f0-9]{64}$/.test(taskHash) || !observations.length
    || observations.some(event => event.data?.planHash !== store.planHash || event.data?.workId !== workId
      || event.data?.logicalTaskHash !== taskHash || event.data?.sessionOrdinal !== 1
      || event.data?.recoveryReason !== null)) {
    throw stop("no-receipt trace has ambiguous work, task, final ordinary session or cumulative usage");
  }
  if (events.some(event => event.type === "llm.response.failed" || event.type === "llm.retry")
    || run.counts.retries !== 0
    || events.filter(event => event.type === "llm.request.started").length !== run.counts.llmRequests
    || events.filter(event => event.type === "llm.response.completed").length !== run.counts.llmRequests) {
    throw stop("no-receipt trace contains a provider failure, retry or uncertain model response");
  }

  const allowedReads = new Set(["read_role_session_context", "read_role_context_history", "read_role_audit_inventory",
    "read_role_work_neighbor", "read_role_work_evidence", "read_role_review_notes", "read_role_review_atlas", "preview_role_review_audit"]);
  const pending = new Map<string, { name: string; event: TraceEvents[number] }>();
  const pages = new Map<number, string>();
  let failedToolSeq = -1, failedToolResult: any, failedRaw: unknown;
  for (const event of events) {
    if (event.type === "tool.call.started") {
      const name = String(event.data?.toolName);
      if (!event.toolCallId || pending.has(event.toolCallId) || !event.blobRef
        || (name !== ROLE_AUDIT_WORK_TOOL && !allowedReads.has(name))) throw stop("no-receipt trace contains an unknown mutation or duplicate tool call");
      pending.set(event.toolCallId, { name, event });
      if (name === ROLE_AUDIT_WORK_TOOL) {
        if (failedRaw !== undefined) throw stop("no-receipt trace contains more than one proposal call");
        failedRaw = await traces.peekBlob(event.blobRef);
        if (event.data?.inputHash !== contentHash(failedRaw)) throw stop("failed proposal trace input hash changed");
      }
      continue;
    }
    if (event.type !== "tool.call.completed" && event.type !== "tool.call.failed") continue;
    const started = event.toolCallId ? pending.get(event.toolCallId) : undefined;
    if (!started || started.name !== event.data?.toolName || !event.blobRef) throw stop("no-receipt trace has an unmatched tool result");
    pending.delete(event.toolCallId!);
    const result = await traces.peekBlob(event.blobRef) as { isError?: boolean; content?: Array<{ type: string; text?: string }>; details?: any };
    const errored = event.type === "tool.call.failed" || event.data?.isError === true || result.isError === true;
    if (errored) {
      if (started.name !== ROLE_AUDIT_WORK_TOOL || failedToolSeq >= 0) throw stop("no-receipt trace contains a read failure or multiple failed tools");
      failedToolSeq = event.seq; failedToolResult = result;
      continue;
    }
    if (started.name === ROLE_AUDIT_WORK_TOOL) throw stop("failed audit trace contains a successful mutation outcome");
    if (started.name === "read_role_session_context") for (const item of result.content ?? []) {
      if (item.type !== "text" || !item.text) continue;
      const body = JSON.parse(item.text);
      if (body.taskHash !== taskHash || !Number.isInteger(body.offset) || typeof body.text !== "string"
        || (body.nextOffset !== undefined && body.nextOffset !== body.offset + 1)) throw stop("restored correction task page has foreign identity or discontinuous paging");
      const prior = pages.get(body.offset);
      if (prior !== undefined && prior !== body.text) throw stop("restored correction task page changed between reads");
      pages.set(body.offset, body.text);
    }
  }
  const toolStarts = events.filter(event => event.type === "tool.call.started");
  const toolOutcomes = events.filter(event => event.type === "tool.call.completed" || event.type === "tool.call.failed");
  const recovery = failedToolResult?.details?.nwhToolRecovery;
  const recoveryText = failedToolResult?.content?.find((item: { type: string; text?: string }) => item.type === "text")?.text;
  if (pending.size || failedToolSeq < 0 || contentHash(failedRaw) !== contentHash(failedDraft)
    || toolStarts.length !== run.counts.toolCalls || toolOutcomes.length !== run.counts.toolCalls
    || recovery?.version !== 1 || recovery.failedTool !== ROLE_AUDIT_WORK_TOOL
    || recovery.category !== "invalid-arguments" || recovery.retryable !== true
    || typeof recovery.retryCondition !== "string" || !/one materially corrected retry/i.test(recovery.retryCondition)
    || typeof recoveryText !== "string" || !recoveryText.startsWith(diagnostic)) {
    throw stop("failed audit tool did not publish the exact retryable typed correction diagnostic");
  }
  const afterFailure = events.filter(event => event.type === "llm.response.completed" && event.seq > failedToolSeq);
  const finalResponse = afterFailure[0];
  const finalBody = finalResponse?.blobRef ? await traces.peekBlob(finalResponse.blobRef) as any : undefined;
  const finalText = finalBody?.content?.find((item: { type: string; text?: string }) => item.type === "text")?.text;
  if (afterFailure.length !== 1 || finalResponse !== events.findLast(event => event.type === "llm.response.completed")
    || finalResponse?.data?.stopReason !== "stop" || typeof finalText !== "string" || !finalText.trim()
    || events.some(event => event.type === "tool.call.started" && event.seq > failedToolSeq)) {
    throw stop("model did not stop cleanly after the retryable failed proposal");
  }

  const offsets = [...pages.keys()].sort((a, b) => a - b);
  if (!offsets.length || offsets.some((offset, index) => offset !== index)) throw stop("original correction task restoration is incomplete");
  const originalPrompt = offsets.map(offset => pages.get(offset)!).join("");
  if (contentHash(originalPrompt) !== taskHash) throw stop("restored original correction task changed");
  const packet = JSON.parse(originalPrompt.split("\n").at(-1)!);
  const discoveries = store.read("source", page)!.findings.map((finding, index) => ({ findingId: roleFindingId(store.planHash, page, index), ...finding }));
  if (packet.source?.page !== page || packet.atlasRevision !== store.atlasRevision()
    || contentHash(packet.expectedQuestions) !== contentHash(store.questions(page))
    || contentHash(packet.discoveries) !== contentHash(discoveries)
    || packet.coverage?.claimAuditsHash !== contentHash(store.claimAudits())
    || packet.coverage?.entriesHash !== store.entriesHash()
    || [packet.coverage?.missingSourceWorkIds, packet.coverage?.missingCandidateIds, packet.coverage?.unresolvedClaimWorkIds]
      .some(ids => !Array.isArray(ids) || ids.length)
    || !sameIds(failedDraft.questionDispositions?.map(item => item.questionId) ?? [], store.questions(page).map(item => item.questionId))
    || !sameIds(failedDraft.discoveryDispositions?.map(item => item.findingId) ?? [], discoveries.map(item => item.findingId))
    || correctionTargets.some(name => !discoveries.some((item: { name: string }) => item.name === name))) {
    throw stop("restored correction dependencies, responsibilities or exact discovery names changed");
  }

  const attemptDir = path.join(base, "v1", contentHash(store.plan.sourceId), "attempts", contentHash(store.plan.batchId), contentHash(workId));
  const workContexts = path.join(base, "context-loops", store.planHash, contentHash(workId));
  const taskNames = (await names(workContexts)).sort();
  if (taskNames.length !== 1 || taskNames[0] !== taskHash) throw stop("audit correction has multiple or unknown logical tasks");
  const contextDir = path.join(workContexts, taskHash), allContextFiles = (await names(contextDir)).sort();
  const inheritedSessions = inheritedAllowance?.contextSessions ?? 0;
  const expectedContextOrdinals = Array.from({ length: 2 - inheritedSessions }, (_, index) => inheritedSessions + index);
  if (inheritedSessions > 1 || allContextFiles.some(name => !/^[01](?:\.outcome)?\.json$/.test(name))) throw stop("final ordinary correction context is already claimed or uncertain");
  const contextFiles = allContextFiles.filter(name => /^\d+\.json$/.test(name));
  if (contentHash(contextFiles.map(name => Number(name[0]))) !== contentHash(expectedContextOrdinals)) {
    throw stop("audit correction does not retain exactly one final ordinary context");
  }
  const retainedFiles: Array<{ file: string; hash: string }> = [];
  for (const file of [...attempts.map(name => path.join(attemptDir, name)), ...allContextFiles.map(name => path.join(contextDir, name))]) {
    const raw = await fs.readFile(file, "utf8"), value = JSON.parse(raw);
    if (value.claim && (value.hash !== contentHash(value.claim) || value.claim.planHash !== store.planHash
      || value.claim.workId !== workId || value.claim.taskHash !== taskHash
      || value.claim.ordinal !== Number(path.basename(file, ".json")))) throw stop("retained correction session claim changed");
    if (file.endsWith(".outcome.json") && (value.taskHash !== taskHash || value.ordinal !== Number(path.basename(file, ".outcome.json")))) {
      throw stop("retained correction session outcome changed");
    }
    if (!value.claim && !file.endsWith(".outcome.json")
      && (value.planHash !== store.planHash || value.workId !== workId)) throw stop("retained correction invocation changed");
    retainedFiles.push({ file, hash: contentHash(raw) });
  }
  const checkpointFile = path.join(base, "context", store.planHash, `${contentHash(workId)}.json`);
  const checkpointRaw = await fs.readFile(checkpointFile, "utf8"), checkpoint = JSON.parse(checkpointRaw);
  if (checkpoint.hash !== contentHash(checkpoint.state) || checkpoint.state.packetHash !== taskHash
    || checkpoint.state.planHash !== store.planHash || checkpoint.state.workId !== workId
    || checkpoint.state.handoffs.length || (checkpoint.state.inheritedHandoffs ?? 0)
    || (await names(path.dirname(checkpointFile))).some(name => name.startsWith(path.basename(checkpointFile) + "."))) {
    throw stop("correction checkpoint is changed, pending or requires another recovery");
  }
  const requiredUnitIds = [...new Set([
    ...failedDraft.missingMajorCharacters.flatMap(item => item.basisUnitIds),
    ...(failedDraft.questionDispositions ?? []).flatMap(item => item.basisUnitIds),
    ...(failedDraft.discoveryDispositions ?? []).flatMap(item => item.basisUnitIds),
  ])].sort();
  const requiredCandidateIds = [...new Set((failedDraft.discoveryDispositions ?? []).flatMap(item => item.candidateIds))].sort();
  const correctionDir = path.join(base, "host-interruptions", "compile-audit-correction", store.planHash);
  const correctionFile = path.join(correctionDir, `${contentHash({ workId, runId: run.id })}.json`);
  for (const name of (await names(correctionDir)).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    const file = path.join(correctionDir, name), saved = await read(file);
    if (saved.authority?.workId === workId && file !== correctionFile) throw stop("another correction grant already targets this audit");
  }
  if (readAutomaticRoleProgressContinuation(store.root, store.planHash, workId)) throw stop("audit already has a different automatic continuation lineage");
  const authority = {
    version: 1 as const, policy: "compile-audit-correction-v1" as const, planHash: store.planHash, workId, page,
    sourceHash: store.plan.sourceHash, runId: run.id, runHash: contentHash(run), traceHash: contentHash(events), taskHash,
    attempt: 2, nextOrdinal: 2, inheritedAllowance: inheritedAllowance ?? null, inheritedAllowanceHash: contentHash(inheritedAllowance ?? null),
    atlasRevision: store.atlasRevision(), entriesHash: store.entriesHash(),
    claimAuditsHash: contentHash(store.claimAudits()), budget, remainingProgressCalls: remainingRoleProgressCalls(budget),
    proposalHistoryHash: contentHash(history), proposalHistoryLength: history.length, failedInputHash: failed.inputHash,
    failedDraft, failedDraftHash: contentHash(failedDraft), diagnostic, diagnosticHash: contentHash(diagnostic), correctionTargets,
    retainedFiles, contextDir, checkpointFile, checkpointBefore: checkpoint.state, checkpointBeforeHash: contentHash(checkpointRaw), requiredUnitIds, requiredCandidateIds,
    additionalCalls: CORRECTION_ADDITIONAL_CALLS,
    limits: { ...budget.limits, maxModelCalls: budget.state.usage.modelCalls + CORRECTION_ADDITIONAL_CALLS },
  };
  return { authority, authorityHash: contentHash(authority), originalPrompt, file: correctionFile };
}

async function inspectNoProgressResume(input: {
  store: RoleReviewWorkStore; page: number; base: string; attempts: string[];
  run: TraceRun; events: TraceEvents; traces: TraceStore;
}) {
  const { store, page, base, attempts, run, events, traces } = input;
  const workId = store.workId("audit", page);
  const budget = inspectRoleReviewBudget(store.root, store.planHash, workId);
  const failure = budget.state.failure;
  if (run.kind !== "prepare" || run.status !== "failed" || !run.endedAt || run.sourceId !== store.plan.sourceId
    || run.operationId !== store.plan.batchId || run.error?.code !== "ROLE_REVIEW_WORK_FAILED"
    || !budget.state.blocked || failure?.code !== "no-progress" || run.error.message !== `Error: ${failure.message}`
    || budget.state.usage.modelCalls - (budget.state.progress?.lastProgressCall ?? 0) !== budget.limits.maxModelCalls
    || events.at(-1)?.type !== "run.failed") throw stop("latest audit stop is not the exact settled no-progress failure");
  if (store.journal.history(ROLE_AUDIT_WORK_TOOL, workId).length) throw stop("no-progress audit already has proposal history");

  const quotaDir = path.join(base, "host-interruptions", "compile-quota", store.planHash);
  const quotaRecords: Array<{ file: string; saved: any }> = [];
  for (const name of (await names(quotaDir)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort()) {
    const file = path.join(quotaDir, name), saved = await read(file);
    if (saved.authority?.workId === workId) quotaRecords.push({ file, saved });
  }
  if (quotaRecords.length !== 1) throw stop("no-progress audit lacks one exact predecessor quota grant");
  const predecessor = quotaRecords[0]!, prior = predecessor.saved.authority;
  if (predecessor.saved.authorityHash !== contentHash(prior) || prior?.version !== 1 || prior.policy !== "compile-audit-quota-v1"
    || prior.planHash !== store.planHash || prior.workId !== workId || prior.page !== page
    || prior.attempt !== Math.max(...attempts.map(name => Number(name[0]))) || prior.nextOrdinal !== 2
    || prior.atlasRevision !== store.atlasRevision() || prior.entriesHash !== store.entriesHash()
    || prior.claimAuditsHash !== contentHash(store.claimAudits())) throw stop("predecessor quota authority changed or belongs to another audit");
  if (contentHash(await traces.peekRun(prior.runId)) !== prior.runHash
    || contentHash(await traces.peekEvents(prior.runId)) !== prior.traceHash) throw stop("predecessor quota trace changed");

  const works = events.filter(event => event.type === "validation.completed" && event.data?.phase === "role-review-work");
  const stopped = events.findLast(event => event.type === "validation.completed" && event.data?.phase === "role-review-work-stopped")?.data;
  const observations = events.filter(event => event.type === "validation.completed" && event.data?.phase === "role-request-observation");
  const taskHash = observations[0]?.data?.logicalTaskHash;
  if (works.length !== 1 || works[0]!.data?.planHash !== store.planHash || works[0]!.data?.workId !== workId
    || contentHash(works[0]!.data?.limits) !== contentHash(budget.limits) || works[0]!.data?.modelCallsMode !== "progress"
    || typeof taskHash !== "string" || !/^[a-f0-9]{64}$/.test(taskHash) || taskHash !== prior.taskHash || !observations.length
    || observations.some(event => event.data?.planHash !== store.planHash || event.data?.workId !== workId
      || event.data?.logicalTaskHash !== taskHash || event.data?.sessionOrdinal !== 2)
    || stopped?.workId !== workId || !Array.isArray(stopped.compactions) || stopped.compactions.length
    || contentHash((stopped.budget as { usage?: unknown } | undefined)?.usage ?? null) !== contentHash(budget.state.usage)) {
    throw stop("no-progress trace has ambiguous work, task, session or retained usage");
  }
  for (const observation of observations) {
    let recovery: any;
    try { recovery = JSON.parse(String(observation.data?.recoveryReason)); } catch { throw stop("no-progress trace lost its quota recovery identity"); }
    if (recovery.authorityHash !== predecessor.saved.authorityHash || recovery.failedRunId !== prior.runId
      || contentHash(recovery.retainedDraft ?? null) !== contentHash(prior.retainedDraft ?? null)) throw stop("no-progress trace did not execute the claimed predecessor quota grant");
  }

  const failures = events.filter(event => event.type === "llm.response.failed");
  const retries = events.filter(event => event.type === "llm.retry");
  const starts = events.filter(event => event.type === "llm.request.started");
  const completed = events.filter(event => event.type === "llm.response.completed");
  const transport = failures[0], exhausted = failures[1];
  if (failures.length !== 2 || retries.length !== 1 || run.counts.retries !== 1
    || completed.length + 1 !== run.counts.llmRequests || starts.length !== run.counts.llmRequests
    || transport?.data?.providerId !== "openai-codex" || transport.data.errorMessage !== "WebSocket closed 1006"
    || !zeroUsage(transport.data.usage) || !transport.callId || !starts.some(event => event.callId === transport.callId)
    || starts.at(-1)?.callId !== transport.callId
    || retries[0]!.data?.errorMessage !== transport.data.errorMessage
    || exhausted?.data?.errorMessage !== failure.message || !zeroUsage(exhausted.data.usage)
    || !exhausted.callId || starts.some(event => event.callId === exhausted.callId)) {
    throw stop("no-progress trace is not the exact zero-usage transport loss followed by a pre-transport circuit break");
  }

  const allowed = new Set(["read_role_session_context", "read_role_audit_inventory", "read_role_work_neighbor",
    "read_role_work_evidence", "read_role_review_notes", "read_role_review_atlas", "preview_role_review_audit"]);
  const pending = new Map<string, { name: string; event: TraceEvents[number] }>();
  const pages = new Map<number, string>();
  let retainedDraft: unknown, validPreviews = 0, previewSeq = -1;
  for (const event of events) {
    if (event.type === "tool.call.failed") throw stop("no-progress trace contains a tool failure");
    if (event.type === "tool.call.started") {
      const name = String(event.data?.toolName);
      if (!event.toolCallId || !allowed.has(name) || pending.has(event.toolCallId) || !event.blobRef) throw stop("no-progress trace contains a mutation, unknown tool or duplicate call");
      pending.set(event.toolCallId, { name, event });
      if (name === "preview_role_review_audit") { retainedDraft = await traces.peekBlob(event.blobRef); previewSeq = event.seq; }
    }
    if (event.type === "tool.call.completed") {
      const started = event.toolCallId ? pending.get(event.toolCallId) : undefined;
      if (!started || started.name !== event.data?.toolName || !event.blobRef) throw stop("no-progress trace has an unmatched tool result");
      pending.delete(event.toolCallId!);
      const result = await traces.peekBlob(event.blobRef) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
      if (event.data?.isError === true || result.isError) throw stop("no-progress trace retains a tool error");
      if (started.name === "read_role_session_context") for (const item of result.content ?? []) {
        if (item.type !== "text" || !item.text) continue;
        const body = JSON.parse(item.text);
        if (body.taskHash !== taskHash || !Number.isInteger(body.offset) || typeof body.text !== "string") throw stop("restored task page has foreign identity");
        pages.set(body.offset, body.text);
      }
      if (started.name === "preview_role_review_audit") {
        const text = result.content?.find(item => item.type === "text")?.text;
        const body = text ? JSON.parse(text) : undefined;
        if (body?.valid !== true || body.committed !== false) throw stop("retained audit preview was not valid and uncommitted");
        validPreviews++;
      }
    }
  }
  if (pending.size || validPreviews !== 1 || previewSeq < 0 || previewSeq >= transport!.seq
    || events.filter(event => event.type === "tool.call.started").length !== run.counts.toolCalls
    || events.filter(event => event.type === "tool.call.completed").length !== run.counts.toolCalls) throw stop("no-progress trace has uncertain tool publication or preview lineage");
  const draft = roleAuditWorkSchema.parse(retainedDraft);
  if (draft.atlasRevision !== store.atlasRevision()) throw stop("retained audit draft belongs to another atlas");
  const offsets = [...pages.keys()].sort((a, b) => a - b);
  if (!offsets.length || offsets.some((offset, index) => offset !== index)) throw stop("original audit task restoration is incomplete");
  const originalPrompt = offsets.map(offset => pages.get(offset)!).join("");
  if (contentHash(originalPrompt) !== taskHash) throw stop("restored original audit task changed");
  const packet = JSON.parse(originalPrompt.split("\n").at(-1)!);
  if (packet.source?.page !== page || packet.atlasRevision !== store.atlasRevision()
    || contentHash(packet.expectedQuestions) !== contentHash(store.questions(page))
    || contentHash(packet.discoveries) !== contentHash(store.read("source", page)!.findings.map((finding, index) => ({ findingId: roleFindingId(store.planHash, page, index), ...finding })))
    || packet.coverage?.claimAuditsHash !== contentHash(store.claimAudits())
    || (packet.coverage?.entriesHash && packet.coverage.entriesHash !== store.entriesHash())
    || [packet.coverage?.missingSourceWorkIds, packet.coverage?.missingCandidateIds, packet.coverage?.unresolvedClaimWorkIds].some(ids => !Array.isArray(ids) || ids.length)) {
    throw stop("restored audit evidence dependencies changed or remain incomplete");
  }

  const workContexts = path.join(base, "context-loops", store.planHash, contentHash(workId));
  const taskNames = (await names(workContexts)).sort();
  if (taskNames.length !== 1 || taskNames[0] !== taskHash) throw stop("audit has multiple or unknown logical tasks");
  const contextDir = path.join(workContexts, taskHash), allContextFiles = (await names(contextDir)).sort();
  if (allContextFiles.some(name => !/^[0-2](?:\.outcome)?\.json$/.test(name))) throw stop("audit has uncertain context publication");
  const contextFiles = allContextFiles.filter(name => /^\d+\.json$/.test(name));
  if (Math.max(-1, ...contextFiles.map(name => Number(name[0]))) !== 2) throw stop("predecessor quota session was not the final ordinary context");
  const retainedFiles: Array<{ file: string; hash: string }> = [];
  for (const file of [...attempts.map(name => path.join(base, "v1", contentHash(store.plan.sourceId), "attempts", contentHash(store.plan.batchId), contentHash(workId), name)),
    ...allContextFiles.map(name => path.join(contextDir, name)), predecessor.file]) {
    const raw = await fs.readFile(file, "utf8"), value = JSON.parse(raw);
    if (value.claim && (value.hash !== contentHash(value.claim) || value.claim.planHash !== store.planHash
      || value.claim.workId !== workId || value.claim.taskHash !== taskHash
      || value.claim.ordinal !== Number(path.basename(file, ".json")))) throw stop("retained session claim changed");
    if (file.endsWith(".outcome.json") && (value.taskHash !== taskHash || value.ordinal !== Number(path.basename(file, ".outcome.json")))) throw stop("retained session outcome changed");
    if (!value.claim && !file.endsWith(".outcome.json") && file !== predecessor.file
      && (value.planHash !== store.planHash || value.workId !== workId)) throw stop("retained invocation changed");
    retainedFiles.push({ file, hash: contentHash(raw) });
  }
  const finalClaim = JSON.parse(await fs.readFile(path.join(contextDir, "2.json"), "utf8"));
  if (finalClaim.claim?.recoveryInfo?.authorityHash !== predecessor.saved.authorityHash) throw stop("final ordinary context did not consume the predecessor quota grant");
  const checkpointFile = path.join(base, "context", store.planHash, `${contentHash(workId)}.json`);
  const checkpointRaw = await fs.readFile(checkpointFile, "utf8"), checkpoint = JSON.parse(checkpointRaw);
  if (checkpoint.hash !== contentHash(checkpoint.state) || checkpoint.state.packetHash !== taskHash
    || checkpoint.state.planHash !== store.planHash || checkpoint.state.workId !== workId
    || checkpoint.state.handoffs.length || (checkpoint.state.inheritedHandoffs ?? 0)
    || (await names(path.dirname(checkpointFile))).some(name => name.startsWith(path.basename(checkpointFile) + "."))) {
    throw stop("no-progress checkpoint is changed, pending or requires another recovery");
  }
  const requiredUnitIds = [...new Set([
    ...draft.missingMajorCharacters.flatMap(item => item.basisUnitIds),
    ...(draft.questionDispositions ?? []).flatMap(item => item.basisUnitIds),
    ...(draft.discoveryDispositions ?? []).flatMap(item => item.basisUnitIds),
  ])].sort();
  const requiredCandidateIds = [...new Set((draft.discoveryDispositions ?? []).flatMap(item => item.candidateIds))].sort();
  const authority = {
    version: 1 as const, policy: "compile-audit-no-progress-v1" as const, planHash: store.planHash, workId, page,
    sourceHash: store.plan.sourceHash, runId: run.id, runHash: contentHash(run), traceHash: contentHash(events), taskHash,
    attempt: prior.attempt, nextOrdinal: 3, atlasRevision: store.atlasRevision(), entriesHash: store.entriesHash(),
    claimAuditsHash: contentHash(store.claimAudits()), budget, predecessorGrantHash: contentHash(await fs.readFile(predecessor.file, "utf8")),
    predecessorAuthorityHash: predecessor.saved.authorityHash, retainedFiles, checkpointFile, checkpointBeforeHash: contentHash(checkpointRaw),
    retainedDraft: draft, retainedDraftHash: contentHash(draft), requiredUnitIds, requiredCandidateIds,
    additionalCalls: NO_PROGRESS_ADDITIONAL_CALLS,
    limits: { ...budget.limits, maxModelCalls: budget.state.usage.modelCalls + NO_PROGRESS_ADDITIONAL_CALLS },
  };
  return { authority, authorityHash: contentHash(authority), originalPrompt,
    file: path.join(base, "host-interruptions", "compile-no-progress", store.planHash, `${contentHash({ workId, runId: run.id })}.json`) };
}

/** Read-only. A new compile invocation may resume a settled provider refusal,
 * including a partially executed audit. Never replay an uncertain tool write,
 * validation failure, exhausted budget or a successful negative judgment. */
export async function inspectAutomaticRoleResume(store: RoleReviewWorkStore, page: number) {
  const workId = store.workId("audit", page);
  if (store.read("audit", page)) return;
  const { inspectAuthorizedProviderResumption } = await import("./role-provider-resumption.js");
  const providerResumption = await inspectAuthorizedProviderResumption(store, page);
  if (providerResumption) return providerResumption;
  const correction = readAutomaticRoleCorrectionContinuation(store.root, store.planHash, workId);
  if (correction && syncFs.existsSync(`${correction.file}.result.json`)) {
    const { inspectRoleAuditHostRepair } = await import("./role-audit-host-repair.js");
    const hostToolRepair = await inspectRoleAuditHostRepair(store, page);
    if (hostToolRepair) return hostToolRepair;
    const { inspectRoleAuditNarrowRepair } = await import("./role-audit-narrow-repair.js");
    return inspectRoleAuditNarrowRepair(store, page);
  }
  const base = path.join(worldStorageRoot(store.root), "compiler", "role-review-work");
  const attemptDir = path.join(base, "v1", contentHash(store.plan.sourceId), "attempts", contentHash(store.plan.batchId), contentHash(workId));
  const attempts = (await names(attemptDir)).sort();
  if (!attempts.length) return;
  if (attempts.some(n => !/^[12]\.json$/.test(n))) throw stop("unknown audit attempt lineage");
  store.journal.assertModelRecoveryAllowed();
  const unresolved = store.journal.unresolved();
  const traces = new TraceStore(store.root);
  // Inspect the latest matching work invocation across the complete operation
  // history; unrelated newer traces cannot hide the original failure.
  let selected: { run: Awaited<ReturnType<TraceStore["peekRun"]>>; events: Awaited<ReturnType<TraceStore["peekEvents"]>> } | undefined;
  for (const run of await traces.peekRunsByOperation(store.plan.sourceId, store.plan.batchId)) {
    if (run.kind !== "prepare") continue;
    const events = await traces.peekEvents(run.id);
    if (events.some(e => e.data?.phase === "role-review-work" && e.data.workId === workId)) { selected = { run, events }; break; }
  }
  if (!selected) throw stop("started audit has no discoverable settled trace");
  const { run, events } = selected;
  if (unresolved.length) return inspectCorrectionResume({ store, page, base, attempts, run, events, traces });
  const budget = inspectRoleReviewBudget(store.root, store.planHash, workId);
  if (budget.state.blocked && budget.state.failure?.code === "no-progress") {
    return inspectNoProgressResume({ store, page, base, attempts, run, events, traces });
  }
  if (run.status !== "failed" || !run.endedAt || run.error?.code !== "ROLE_REVIEW_WORK_FAILED"
    || run.error.message !== `Error: ${refusal}` || events.at(-1)?.type !== "run.failed") throw stop("original audit stop is not a settled provider quota refusal");
  const invocation = events.filter(e => e.data?.phase === "role-review-work");
  if (invocation.length !== 1 || invocation[0]!.data?.planHash !== store.planHash
    || invocation[0]!.data?.workId !== workId) throw stop("quota trace belongs to a different invocation");
  const requests = events.filter(event => event.type === "llm.request.started");
  const responses = events.filter(event => event.type === "llm.response.completed" || event.type === "llm.response.failed");
  const failures = responses.filter(event => event.type === "llm.response.failed");
  const lastFailure = failures[0];
  const requestIds = new Set<string>();
  const settledRequests = requests.every(request => {
    if (!request.callId || requestIds.has(request.callId)) return false;
    requestIds.add(request.callId);
    const outcomes = responses.filter(response => response.callId === request.callId && response.seq > request.seq);
    return outcomes.length === 1;
  }) && responses.every(response => response.callId && requestIds.has(response.callId));
  if (requests.length !== run.counts.llmRequests || responses.length !== requests.length || failures.length !== 1
    || !settledRequests || lastFailure !== responses.at(-1) || lastFailure?.callId !== requests.at(-1)?.callId
    || lastFailure?.data?.errorMessage !== refusal || lastFailure.data.providerId !== "openai-codex"
    || !zeroUsage(lastFailure.data?.usage) || events.some(event => event.type === "llm.retry" || event.type.startsWith("world.commit."))) {
    throw stop("provider quota stop is not one exact terminal zero-usage refusal after settled model calls");
  }
  const observations = events.filter(e => e.data?.phase === "role-request-observation");
  const taskHash = observations[0]?.data?.logicalTaskHash, ordinal = observations[0]?.data?.sessionOrdinal;
  if (typeof taskHash !== "string" || !/^[a-f0-9]{64}$/.test(taskHash) || !Number.isInteger(ordinal)
    || observations.some(e => e.data?.logicalTaskHash !== taskHash || e.data.sessionOrdinal !== ordinal)) throw stop("stopped audit has ambiguous task or session identity");
  const stopped = events.findLast(e => e.data?.phase === "role-review-work-stopped")?.data;
  const maxAdditionalModelCalls = remainingRoleProgressCalls(budget);
  if (stopped?.workId !== workId || budget.state.blocked || budget.state.failure || !maxAdditionalModelCalls
    || contentHash((stopped?.budget as { usage?: unknown })?.usage ?? null) !== contentHash(budget.state.usage)) throw stop("quota recovery cannot renew changed or exhausted usage");
  const pending = new Map<string, string>(), seenCalls = new Set<string>(), pages = new Map<number, string>();
  let originalPrompt: string | undefined;
  let retainedDraft: unknown;
  for (const event of events) {
    if (event.type === "tool.call.failed") throw stop("a tool failure needs its original recovery");
    if (event.type === "tool.call.started") {
      const name = String(event.data?.toolName);
      if (!event.toolCallId || !/^(read_|preview_role_|refactor_role_work$|request_role_session_rebuild$)/.test(name)) throw stop("quota trace contains a mutation or unknown tool outcome");
      if (seenCalls.has(event.toolCallId)) throw stop("duplicate tool identity in interrupted trace");
      seenCalls.add(event.toolCallId); pending.set(event.toolCallId, name);
      if (name === "preview_role_review_audit" && event.blobRef) retainedDraft = await traces.peekBlob(event.blobRef);
    }
    if (event.type === "tool.call.completed") {
      if (!event.toolCallId || pending.get(event.toolCallId) !== event.data?.toolName || !event.blobRef) throw stop("quota trace has an unmatched tool result");
      pending.delete(event.toolCallId);
      const result = await traces.peekBlob(event.blobRef) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
      if (event.data?.isError === true || result.isError) throw stop("quota trace retains a tool error");
      if (event.data?.toolName === "read_role_session_context") for (const item of result.content ?? []) {
        if (item.type !== "text" || !item.text) continue;
        const body = JSON.parse(item.text);
        if (body.taskHash === taskHash && Number.isInteger(body.offset) && typeof body.text === "string") pages.set(body.offset, body.text);
      }
    }
    if (event.type === "context.assembled" && event.data?.phase === "before-agent-start" && event.blobRef) {
      const prompt = await traces.peekBlob(event.blobRef);
      if (typeof prompt === "string") {
        const lines = prompt.split("\n");
        originalPrompt = lines.map((_, i) => lines.slice(0, i + 1).join("\n")).find(p => contentHash(p) === taskHash);
      }
    }
  }
  if (pending.size || seenCalls.size !== run.counts.toolCalls) throw stop("quota trace contains an unfinished or uncounted tool call");
  originalPrompt ??= [...pages].sort(([a], [b]) => a - b).map(([, text]) => text).join("");
  if (contentHash(originalPrompt) !== taskHash) throw stop("original audit task cannot be reconstructed exactly");
  const packet = JSON.parse(originalPrompt.split("\n").at(-1)!);
  if (packet.source?.page !== page || packet.atlasRevision !== store.atlasRevision()
    || contentHash(packet.expectedQuestions) !== contentHash(store.questions(page))
    || contentHash(packet.discoveries) !== contentHash(store.read("source", page)!.findings.map((finding, index) => ({ findingId: roleFindingId(store.planHash, page, index), ...finding })))
    || packet.coverage?.claimAuditsHash !== contentHash(store.claimAudits())
    || (packet.coverage?.entriesHash && packet.coverage.entriesHash !== store.entriesHash())
    || [packet.coverage?.missingSourceWorkIds, packet.coverage?.missingCandidateIds, packet.coverage?.unresolvedClaimWorkIds].some(ids => ids?.length)) throw stop("quota audit evidence dependencies changed or remain incomplete");
  const workContexts = path.join(base, "context-loops", store.planHash, contentHash(workId));
  const taskNames = (await names(workContexts)).sort();
  if (taskNames.length !== 1 || taskNames[0] !== taskHash) throw stop("audit has multiple or unknown logical tasks");
  const contextDir = path.join(workContexts, taskHash), allContextFiles = (await names(contextDir)).sort();
  if (allContextFiles.some(n => !/^[0-2](?:\.outcome)?\.json$/.test(n))) throw stop("audit has uncertain context publication");
  const contextFiles = allContextFiles.filter(n => /^\d+\.json$/.test(n));
  const lastOrdinal = Math.max(-1, ...contextFiles.map(n => Number(n.slice(0, -5))));
  if (lastOrdinal !== ordinal || lastOrdinal >= 2) throw stop("audit session is uncertain or its remaining context allowance is exhausted");
  const retainedFiles = [];
  for (const file of [...attempts.map(n => path.join(attemptDir, n)), ...allContextFiles.map(n => path.join(contextDir, n))]) {
    const raw = await fs.readFile(file, "utf8"), value = JSON.parse(raw);
    if (value.claim && (value.hash !== contentHash(value.claim) || value.claim.planHash !== store.planHash
      || value.claim.workId !== workId || value.claim.taskHash !== taskHash
      || value.claim.ordinal !== Number(path.basename(file, ".json")))) throw stop("retained session claim changed");
    if (file.endsWith(".outcome.json")) {
      if (value.taskHash !== taskHash || value.ordinal !== Number(path.basename(file, ".outcome.json"))) throw stop("retained session outcome changed");
    } else if (!value.claim && (value.planHash !== store.planHash || value.workId !== workId)) throw stop("retained invocation changed");
    retainedFiles.push({ file, hash: contentHash(raw) });
  }
  const checkpointFile = path.join(base, "context", store.planHash, `${contentHash(workId)}.json`);
  const checkpoint = await read(checkpointFile);
  if (checkpoint.hash !== contentHash(checkpoint.state) || checkpoint.state.packetHash !== taskHash
    || checkpoint.state.planHash !== store.planHash || checkpoint.state.workId !== workId
    || checkpoint.state.handoffs.length || (checkpoint.state.inheritedHandoffs ?? 0)) throw stop("quota context is changed or requires a different recovery");
  if ((await names(path.dirname(checkpointFile))).some(n => n.startsWith(path.basename(checkpointFile) + "."))) throw stop("quota context has pending or separately recovered state");
  retainedFiles.push({ file: checkpointFile, hash: contentHash(await fs.readFile(checkpointFile, "utf8")) });
  const authority = { version: 1 as const, policy: "compile-audit-quota-v1" as const, planHash: store.planHash, workId, page,
    runId: run.id, runHash: contentHash(run), traceHash: contentHash(events), budgetHash: budget.hash,
    taskHash, attempt: Math.max(...attempts.map(n => Number(n[0]))), nextOrdinal: lastOrdinal + 1,
    atlasRevision: store.atlasRevision(), entriesHash: store.entriesHash(), claimAuditsHash: contentHash(store.claimAudits()),
    startingUsage: budget.state.usage, startingProgressHash: contentHash(budget.state.progress ?? null),
    maxAdditionalModelCalls, maxNewSessions: 1 as const, retainedFiles, retainedDraft: retainedDraft ?? null };
  return { authority, authorityHash: contentHash(authority), originalPrompt,
    file: path.join(base, "host-interruptions", "compile-quota", store.planHash, `${contentHash({ workId, runId: run.id })}.json`) };
}

export async function claimAutomaticRoleResume(store: RoleReviewWorkStore, preview: AutomaticRoleResume) {
  if (preview.authority.policy === "host-provider-resumption-v1") {
    const { claimRoleProviderResumption } = await import("./role-provider-resumption.js");
    return claimRoleProviderResumption(store, { ...preview, authority: preview.authority });
  }
  if ((await WorkspaceOperationLock.inspect(store.root)).owner?.pid !== process.pid) throw stop("automatic audit recovery requires the compiler lock");
  const current = await inspectAutomaticRoleResume(store, preview.authority.page);
  if (!current || current.authorityHash !== preview.authorityHash) throw stop("automatic audit recovery preview changed");
  await fs.mkdir(path.dirname(preview.file), { recursive: true });
  try { await fs.writeFile(preview.file, JSON.stringify({ authority: preview.authority, authorityHash: preview.authorityHash }), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw stop("automatic continuation was already claimed; inspect its original result"); throw error; }
  if (preview.authority.policy === "compile-audit-no-progress-v1"
    || preview.authority.policy === "compile-audit-correction-v1"
    || preview.authority.policy === "compile-audit-host-tool-repair-v1"
    || preview.authority.policy === "compile-audit-narrow-schema-repair-v1") {
    const usageFile = `${preview.file}.usage.json`;
    if (syncFs.existsSync(usageFile) || syncFs.existsSync(`${usageFile}.pending`)) throw stop("automatic continuation usage already exists");
    saveProgressUsage(usageFile, preview.authorityHash, { usage: preview.authority.budget.state.usage, blocked: false });
  }
  return preview.authority.attempt;
}

export async function inspectClaimedAutomaticResume(store: RoleReviewWorkStore, preview: AutomaticRoleResume) {
  if (preview.authority.policy !== "compile-audit-quota-v1") throw stop("ordinary context recovery cannot consume a narrowed host grant");
  const saved = await read(preview.file), current = await inspectAutomaticRoleResume(store, preview.authority.page);
  if (!current || current.authorityHash !== preview.authorityHash || saved.authorityHash !== contentHash(saved.authority)
    || saved.authorityHash !== preview.authorityHash) throw stop("claimed quota continuation dependencies changed");
  return { workId: preview.authority.workId, taskHash: preview.authority.taskHash, nextOrdinal: preview.authority.nextOrdinal,
    recoveryInfo: { reason: "User resumed compile-novel after a settled provider quota stop", failedRunId: preview.authority.runId,
      authorityHash: preview.authorityHash, retainedDraft: preview.authority.retainedDraft,
      retainedStartingCalls: preview.authority.startingUsage.modelCalls,
      maxAdditionalModelCalls: preview.authority.maxAdditionalModelCalls } };
}

function saveProgressUsage(file: string, authorityHash: string, state: ModelRequestBudgetState) {
  const value = { authorityHash, state }, pending = `${file}.pending`;
  syncFs.writeFileSync(pending, JSON.stringify({ ...value, hash: contentHash(value) }), { flag: "wx", mode: 0o600 });
  syncFs.renameSync(pending, file);
}

function validUsageState(state: ModelRequestBudgetState) {
  const usage = state?.usage, keys = usage ? Object.keys(usage).sort() : [];
  return Boolean(state) && typeof state.blocked === "boolean"
    && contentHash(keys) === contentHash(["largestRequestBytes", "modelCalls", "payloads", "totalPayloadBytes"])
    && Object.values(usage!).every(value => Number.isSafeInteger(value) && value >= 0)
    && (!state.failure || (typeof state.failure.code === "string" && typeof state.failure.message === "string"));
}

/** Read-only lineage access for status/migration. The predecessor stop remains
 * blocked; this returns only the separately charged finite grant. */
export function readAutomaticRoleProgressContinuation(root: string, planHash: string, workId: string) {
  const dir = path.join(worldStorageRoot(root), "compiler", "role-review-work", "host-interruptions", "compile-no-progress", planHash);
  let entries: string[];
  try { entries = syncFs.readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const matches: Array<{ file: string; authority: any; authorityHash: string }> = [];
  for (const name of entries) {
    const file = path.join(dir, name), saved = JSON.parse(syncFs.readFileSync(file, "utf8"));
    if (saved.authorityHash !== contentHash(saved.authority) || saved.authority?.version !== 1
      || saved.authority?.policy !== "compile-audit-no-progress-v1" || saved.authority?.planHash !== planHash) {
      throw stop("no-progress continuation authority integrity changed");
    }
    if (saved.authority.workId === workId) matches.push({ file, authority: saved.authority, authorityHash: saved.authorityHash });
  }
  if (!matches.length) return;
  if (matches.length !== 1) throw stop("multiple no-progress grants target the same audit");
  const record = matches[0]!, authority = record.authority;
  if (authority.additionalCalls !== NO_PROGRESS_ADDITIONAL_CALLS
    || authority.limits?.maxModelCalls !== authority.budget?.state?.usage?.modelCalls + authority.additionalCalls
    || authority.budget?.state?.blocked !== true || authority.budget?.state?.failure?.code !== "no-progress") {
    throw stop("no-progress grant changed its predecessor stop or finite allowance");
  }
  const usageFile = `${record.file}.usage.json`, pending = `${usageFile}.pending`;
  if (syncFs.existsSync(pending) || !syncFs.existsSync(usageFile)) throw stop("no-progress continuation has uncertain usage publication");
  const usage = JSON.parse(syncFs.readFileSync(usageFile, "utf8"));
  if (usage.authorityHash !== record.authorityHash || usage.hash !== contentHash({ authorityHash: usage.authorityHash, state: usage.state })
    || !validUsageState(usage.state)
    || Object.entries(authority.budget.state.usage as Record<string, number>).some(([key, value]) => usage.state.usage[key] < value)
    || usage.state.usage.modelCalls > authority.limits.maxModelCalls) throw stop("no-progress continuation usage changed or regressed");
  return { ...record, usage: usage.state as ModelRequestBudgetState };
}

/** Read-only access to the distinct final-context correction lineage. The
 * ordinary budget and failed proposal prefix remain immutable. */
export function readAutomaticRoleCorrectionContinuation(root: string, planHash: string, workId: string) {
  const dir = path.join(worldStorageRoot(root), "compiler", "role-review-work", "host-interruptions", "compile-audit-correction", planHash);
  let entries: string[];
  try { entries = syncFs.readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const matches: Array<{ file: string; authority: any; authorityHash: string }> = [];
  for (const name of entries) {
    const file = path.join(dir, name), saved = JSON.parse(syncFs.readFileSync(file, "utf8"));
    if (saved.authorityHash !== contentHash(saved.authority) || saved.authority?.version !== 1
      || saved.authority?.policy !== "compile-audit-correction-v1" || saved.authority?.planHash !== planHash) {
      throw stop("audit-correction continuation authority integrity changed");
    }
    if (saved.authority.workId === workId) matches.push({ file, authority: saved.authority, authorityHash: saved.authorityHash });
  }
  if (!matches.length) return;
  if (matches.length !== 1) throw stop("multiple correction grants target the same audit");
  const record = matches[0]!, authority = record.authority;
  if (authority.additionalCalls !== CORRECTION_ADDITIONAL_CALLS
    || authority.limits?.maxModelCalls !== authority.budget?.state?.usage?.modelCalls + authority.additionalCalls
    || authority.budget?.state?.blocked !== false || authority.budget?.state?.failure
    || authority.remainingProgressCalls < authority.additionalCalls
    || authority.proposalHistoryLength !== 2 || authority.failedDraftHash !== contentHash(authority.failedDraft)
    || authority.diagnosticHash !== contentHash(authority.diagnostic)) {
    throw stop("audit-correction grant changed its failed input, predecessor usage or finite allowance");
  }
  const usageFile = `${record.file}.usage.json`, pending = `${usageFile}.pending`;
  if (syncFs.existsSync(pending) || !syncFs.existsSync(usageFile)) throw stop("audit-correction continuation has uncertain usage publication");
  const usage = JSON.parse(syncFs.readFileSync(usageFile, "utf8"));
  if (usage.authorityHash !== record.authorityHash || usage.hash !== contentHash({ authorityHash: usage.authorityHash, state: usage.state })
    || !validUsageState(usage.state)
    || Object.entries(authority.budget.state.usage as Record<string, number>).some(([key, value]) => usage.state.usage[key] < value)
    || usage.state.usage.modelCalls > authority.limits.maxModelCalls) throw stop("audit-correction continuation usage changed or regressed");
  return { ...record, usage: usage.state as ModelRequestBudgetState };
}

/** Claims the one remaining ordinary context while charging a separate finite
 * cumulative budget. A crash after this write is terminal, not replayable. */
export async function openAutomaticRoleCorrectionBudget(store: RoleReviewWorkStore, preview: AutomaticRoleResume) {
  if (preview.authority.policy !== "compile-audit-correction-v1") throw stop("correction budget requires its exact audit-correction authority");
  if ((await WorkspaceOperationLock.inspect(store.root)).owner?.pid !== process.pid) throw stop("audit-correction continuation requires the compiler lock");
  const current = await inspectAutomaticRoleResume(store, preview.authority.page);
  const record = readAutomaticRoleCorrectionContinuation(store.root, store.planHash, preview.authority.workId);
  if (!current || current.authorityHash !== preview.authorityHash || record?.authorityHash !== preview.authorityHash
    || syncFs.existsSync(`${preview.file}.result.json`) || record.usage.blocked) throw stop("claimed audit-correction continuation is changed, completed or blocked");
  const recoveryInfo = { reason: "Exact host continuation of the unused typed proposal correction",
    failedRunId: preview.authority.runId, authorityHash: preview.authorityHash,
    failedInputHash: preview.authority.failedInputHash, diagnosticHash: preview.authority.diagnosticHash };
  const claim = { planHash: store.planHash, workId: preview.authority.workId, taskHash: preview.authority.taskHash,
    ordinal: preview.authority.nextOrdinal, budgetHash: preview.authority.budget.hash, recoveryInfo, at: new Date().toISOString() };
  const contextFile = path.join(preview.authority.contextDir, `${preview.authority.nextOrdinal}.json`);
  await fs.mkdir(path.dirname(contextFile), { recursive: true });
  try { await fs.writeFile(contextFile, JSON.stringify({ claim, hash: contentHash(claim) }), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw stop("final audit-correction context was already claimed; do not replay it"); throw error; }
  const save = (state: ModelRequestBudgetState) => saveProgressUsage(`${preview.file}.usage.json`, preview.authorityHash, state);
  return { budget: new ModelRequestBudget(preview.authority.limits, { initial: record.usage, save },
    { modelCallsMode: "enforce", requestBytesMode: "observe", totalBytesMode: "observe" }), contextFile, recoveryInfo };
}

export async function recordAutomaticRoleCorrectionResult(store: RoleReviewWorkStore, preview: AutomaticRoleResume, contextFile: string, error?: unknown) {
  if (preview.authority.policy !== "compile-audit-correction-v1") throw stop("correction result requires its exact audit-correction authority");
  const record = readAutomaticRoleCorrectionContinuation(store.root, store.planHash, preview.authority.workId);
  if (!record || record.authorityHash !== preview.authorityHash) throw stop("audit-correction result lost its claimed authority");
  const receipt = readOriginalAutomaticAuditReceipt(store, preview.authority.page);
  const checkpointRaw = await fs.readFile(preview.authority.checkpointFile, "utf8");
  const contextRaw = await fs.readFile(contextFile, "utf8");
  const history = store.journal.history(ROLE_AUDIT_WORK_TOOL, preview.authority.workId);
  const succeeded = error === undefined && Boolean(receipt);
  const result = { authorityHash: preview.authorityHash, status: succeeded ? "succeeded" : "failed",
    receiptHash: succeeded ? contentHash(receipt) : null, usage: record.usage,
    proposalHistoryHash: contentHash(history), contextClaimHash: contentHash(contextRaw), checkpointHash: contentHash(checkpointRaw),
    ...(error === undefined ? {} : { error: String(error) }) };
  try { await fs.writeFile(`${preview.file}.result.json`, JSON.stringify(result), { flag: "wx", mode: 0o600 }); }
  catch (writeError) { if ((writeError as NodeJS.ErrnoException).code === "EEXIST") throw stop("audit-correction continuation result was already published"); throw writeError; }
  return result;
}

/** Opens the already-claimed grant. It cannot create another authority or
 * change the immutable blocked predecessor budget. */
export async function openAutomaticRoleProgressBudget(store: RoleReviewWorkStore, preview: AutomaticRoleResume) {
  if (preview.authority.policy !== "compile-audit-no-progress-v1") throw stop("progress budget requires its exact no-progress authority");
  if ((await WorkspaceOperationLock.inspect(store.root)).owner?.pid !== process.pid) throw stop("no-progress continuation requires the compiler lock");
  const current = await inspectAutomaticRoleResume(store, preview.authority.page);
  const record = readAutomaticRoleProgressContinuation(store.root, store.planHash, preview.authority.workId);
  if (!current || current.authorityHash !== preview.authorityHash || record?.authorityHash !== preview.authorityHash
    || syncFs.existsSync(`${preview.file}.result.json`) || record.usage.blocked) throw stop("claimed no-progress continuation is changed, completed or blocked");
  const save = (state: ModelRequestBudgetState) => saveProgressUsage(`${preview.file}.usage.json`, preview.authorityHash, state);
  return new ModelRequestBudget(preview.authority.limits, { initial: record.usage, save },
    { modelCallsMode: "enforce", requestBytesMode: "observe", totalBytesMode: "observe" });
}

export async function recordAutomaticRoleProgressResult(store: RoleReviewWorkStore, preview: AutomaticRoleResume, error?: unknown) {
  if (preview.authority.policy !== "compile-audit-no-progress-v1") throw stop("result publication requires its exact no-progress authority");
  const record = readAutomaticRoleProgressContinuation(store.root, store.planHash, preview.authority.workId);
  if (!record || record.authorityHash !== preview.authorityHash) throw stop("no-progress result lost its claimed authority");
  const receipt = readOriginalAutomaticAuditReceipt(store, preview.authority.page);
  const checkpointRaw = await fs.readFile(preview.authority.checkpointFile, "utf8");
  const result = { authorityHash: preview.authorityHash, status: receipt ? "succeeded" : "failed",
    receiptHash: receipt ? contentHash(receipt) : null, usage: record.usage, checkpointHash: contentHash(checkpointRaw),
    ...(error === undefined ? {} : { error: String(error) }) };
  try { await fs.writeFile(`${preview.file}.result.json`, JSON.stringify(result), { flag: "wx", mode: 0o600 }); }
  catch (writeError) { if ((writeError as NodeJS.ErrnoException).code === "EEXIST") throw stop("no-progress continuation result was already published"); throw writeError; }
  return result;
}

export async function assertAutomaticRoleCorrectionHistory(store: RoleReviewWorkStore, pendingHostRepairWorkId?: string) {
  const dir = path.join(worldStorageRoot(store.root), "compiler", "role-review-work", "host-interruptions", "compile-audit-correction", store.planHash);
  const entries = (await names(dir)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  for (const name of entries) {
    const saved = await read(path.join(dir, name)), workId = saved.authority?.workId;
    if (typeof workId !== "string") throw stop("audit-correction history lost its work identity");
    const record = readAutomaticRoleCorrectionContinuation(store.root, store.planHash, workId)!;
    const authority = record.authority;
    if (record.authorityHash !== saved.authorityHash || authority.sourceHash !== store.plan.sourceHash
      || authority.atlasRevision !== store.atlasRevision() || authority.entriesHash !== store.entriesHash()
      || authority.claimAuditsHash !== contentHash(store.claimAudits())
      || authority.inheritedAllowanceHash !== contentHash(store.inheritedAllowance(workId) ?? null)
      || contentHash(authority.inheritedAllowance) !== authority.inheritedAllowanceHash) throw stop("audit-correction continuation scope changed");
    const predecessor = inspectRoleReviewBudget(store.root, store.planHash, workId);
    if (predecessor.hash !== authority.budget.hash || contentHash(predecessor.state) !== contentHash(authority.budget.state)
      || predecessor.state.blocked || predecessor.state.failure) throw stop("audit-correction predecessor budget changed or its usage was reset");
    for (const file of authority.retainedFiles) if (contentHash(await fs.readFile(file.file, "utf8")) !== file.hash) {
      throw stop("audit-correction predecessor records changed");
    }
    const traces = new TraceStore(store.root);
    if (contentHash(await traces.peekRun(authority.runId)) !== authority.runHash
      || contentHash(await traces.peekEvents(authority.runId)) !== authority.traceHash) throw stop("audit-correction failure trace changed");
    const history = store.journal.history(ROLE_AUDIT_WORK_TOOL, workId);
    if (contentHash(history.slice(0, authority.proposalHistoryLength)) !== authority.proposalHistoryHash
      || history[authority.proposalHistoryLength - 1]?.inputHash !== authority.failedInputHash) {
      throw stop("audit-correction failed proposal prefix changed");
    }
    const contextFile = path.join(authority.contextDir, `${authority.nextOrdinal}.json`);
    const contextRaw = await fs.readFile(contextFile, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw stop("claimed audit-correction continuation never claimed its final context");
      throw error;
    });
    const context = JSON.parse(contextRaw);
    if (context.hash !== contentHash(context.claim) || context.claim?.planHash !== store.planHash
      || context.claim?.workId !== workId || context.claim?.taskHash !== authority.taskHash
      || context.claim?.ordinal !== authority.nextOrdinal || context.claim?.budgetHash !== authority.budget.hash
      || context.claim?.recoveryInfo?.authorityHash !== record.authorityHash
      || context.claim?.recoveryInfo?.failedRunId !== authority.runId
      || context.claim?.recoveryInfo?.failedInputHash !== authority.failedInputHash
      || context.claim?.recoveryInfo?.diagnosticHash !== authority.diagnosticHash) throw stop("audit-correction final context claim changed");
    const checkpointRaw = await fs.readFile(authority.checkpointFile, "utf8"), checkpoint = JSON.parse(checkpointRaw);
    const before = authority.checkpointBefore;
    if (checkpoint.hash !== contentHash(checkpoint.state) || !before
      || checkpoint.state.planHash !== before.planHash || checkpoint.state.workId !== before.workId
      || checkpoint.state.packetHash !== before.packetHash
      || contentHash(checkpoint.state.handoffs) !== contentHash(before.handoffs)
      || contentHash(checkpoint.state.accesses.slice(0, before.accesses.length)) !== contentHash(before.accesses)) {
      throw stop("audit-correction checkpoint discarded or changed predecessor access history");
    }
    let result: any;
    try { result = await read(`${record.file}.result.json`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw stop("claimed audit-correction continuation has no settled result"); throw error; }
    const { readRoleAuditHostRepair, assertRoleAuditHostRepairHistory } = await import("./role-audit-host-repair.js");
    const { readRoleAuditNarrowRepair, assertRoleAuditNarrowRepairHistory } = await import("./role-audit-narrow-repair.js");
    const hostRepair = readRoleAuditHostRepair(record);
    const narrowRepair = readRoleAuditNarrowRepair(record);
    if (hostRepair && narrowRepair) throw stop("audit-correction continuation has conflicting host repairs");
    if (result.authorityHash !== record.authorityHash || contentHash(result.usage) !== contentHash(record.usage)
      || result.contextClaimHash !== contentHash(contextRaw)
      || result.checkpointHash !== (hostRepair?.authority.checkpointHash ?? narrowRepair?.authority.checkpointHash ?? contentHash(checkpointRaw))
      || result.proposalHistoryHash !== contentHash(hostRepair || narrowRepair ? history.slice(0, authority.proposalHistoryLength) : history)) throw stop("audit-correction result, usage, context or checkpoint changed");
    if (hostRepair) { await assertRoleAuditHostRepairHistory(store, record); continue; }
    if (narrowRepair) { await assertRoleAuditNarrowRepairHistory(store, record); continue; }
    // This read-only exception is solely for the exact host-fault preflight.
    // Claiming and dispatch still require its full trace and remaining-call proof.
    if (result.status === "failed" && pendingHostRepairWorkId === workId) continue;
    const receipt = readOriginalAutomaticAuditReceipt(store, authority.page);
    const suffix = history.slice(authority.proposalHistoryLength);
    if (result.status !== "succeeded" || !receipt || result.receiptHash !== contentHash(receipt)
      || suffix.length !== 2 || suffix[0]?.status !== "running" || suffix[1]?.status !== "succeeded"
      || suffix[0].inputHash !== suffix[1].inputHash || suffix[0].inputHash === authority.failedInputHash
      || contentHash((suffix[1].input as { payload?: unknown }).payload) !== contentHash(receipt)) {
      throw stop("audit-correction continuation failed or lacks one materially corrected exact receipt; its single grant cannot be renewed");
    }
  }
}

/** Every claimed grant is terminal. Success must have its exact receipt;
 * failure or missing publication stops without minting a replacement. */
export async function assertAutomaticRoleProgressHistory(store: RoleReviewWorkStore, pendingHostRepairWorkId?: string) {
  const { assertProviderResumptionHistory } = await import("./role-provider-resumption.js");
  await assertProviderResumptionHistory(store);
  const dir = path.join(worldStorageRoot(store.root), "compiler", "role-review-work", "host-interruptions", "compile-no-progress", store.planHash);
  const entries = (await names(dir)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  for (const name of entries) {
    const saved = await read(path.join(dir, name)), workId = saved.authority?.workId;
    if (typeof workId !== "string") throw stop("no-progress history lost its work identity");
    const record = readAutomaticRoleProgressContinuation(store.root, store.planHash, workId)!;
    const authority = record.authority;
    if (record.authorityHash !== saved.authorityHash || authority.sourceHash !== store.plan.sourceHash
      || authority.atlasRevision !== store.atlasRevision() || authority.entriesHash !== store.entriesHash()
      || authority.claimAuditsHash !== contentHash(store.claimAudits())) throw stop("no-progress continuation scope changed");
    const predecessor = inspectRoleReviewBudget(store.root, store.planHash, workId);
    if (predecessor.hash !== authority.budget.hash || !predecessor.state.blocked || predecessor.state.failure?.code !== "no-progress") {
      throw stop("no-progress predecessor budget changed or its stop was cleared");
    }
    for (const file of authority.retainedFiles) if (contentHash(await fs.readFile(file.file, "utf8")) !== file.hash) {
      throw stop("no-progress predecessor records changed");
    }
    const traces = new TraceStore(store.root);
    const predecessorFile = authority.retainedFiles.find((file: { file: string; hash: string }) => file.hash === authority.predecessorGrantHash);
    if (!predecessorFile) throw stop("no-progress history lost its predecessor quota grant");
    const predecessorGrant = await read(predecessorFile.file);
    if (predecessorGrant.authorityHash !== authority.predecessorAuthorityHash
      || predecessorGrant.authorityHash !== contentHash(predecessorGrant.authority)
      || contentHash(await traces.peekRun(predecessorGrant.authority.runId)) !== predecessorGrant.authority.runHash
      || contentHash(await traces.peekEvents(predecessorGrant.authority.runId)) !== predecessorGrant.authority.traceHash) {
      throw stop("predecessor quota authority or trace changed");
    }
    if (contentHash(await traces.peekRun(authority.runId)) !== authority.runHash
      || contentHash(await traces.peekEvents(authority.runId)) !== authority.traceHash) throw stop("no-progress failure trace changed");
    const resultFile = `${record.file}.result.json`;
    let result: any;
    try { result = await read(resultFile); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw stop("claimed no-progress continuation has no settled result"); throw error; }
    if (result.authorityHash !== record.authorityHash || contentHash(result.usage) !== contentHash(record.usage)
      || contentHash(await fs.readFile(authority.checkpointFile, "utf8")) !== result.checkpointHash) throw stop("no-progress result or final checkpoint changed");
    const receipt = readOriginalAutomaticAuditReceipt(store, authority.page);
    if (result.status !== "succeeded" || !receipt || result.receiptHash !== contentHash(receipt)) {
      throw stop("no-progress continuation failed or lacks its exact receipt; its single grant cannot be renewed");
    }
  }
  await assertAutomaticRoleCorrectionHistory(store, pendingHostRepairWorkId);
}
