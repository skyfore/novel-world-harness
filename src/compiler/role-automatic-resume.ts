import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../world/canonical.js";
import { worldStorageRoot } from "../world/paths.js";
import { TraceStore } from "../trace/store.js";
import { WorkspaceOperationLock } from "../util/workspace-lock.js";
import { inspectRoleReviewBudget, remainingRoleProgressCalls } from "./role-review-budget.js";
import { RoleReviewWorkStore, roleWorkStop } from "./role-review-work.js";
import { roleFindingId } from "./role-review-verification.js";

const refusal = "Codex error: The usage limit has been reached";
const names = (dir: string): Promise<string[]> => fs.readdir(dir).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
const stop = (why: string) => roleWorkStop(`${why}; inspect compile-novel status and the original trace for this work, preserve its records and do not retry unchanged`);
export type AutomaticRoleResume = Awaited<ReturnType<typeof inspectAutomaticRoleResume>> & {};

/** Read-only. A new compile invocation may resume a settled provider refusal,
 * including a partially executed audit. Never replay an uncertain tool write,
 * validation failure, exhausted budget or a successful negative judgment. */
export async function inspectAutomaticRoleResume(store: RoleReviewWorkStore, page: number) {
  const workId = store.workId("audit", page);
  if (store.read("audit", page)) return;
  const base = path.join(worldStorageRoot(store.root), "compiler", "role-review-work");
  const attemptDir = path.join(base, "v1", contentHash(store.plan.sourceId), "attempts", contentHash(store.plan.batchId), contentHash(workId));
  const attempts = await names(attemptDir);
  if (!attempts.length) return;
  if (attempts.some(n => !/^[12]\.json$/.test(n))) throw stop("unknown audit attempt lineage");
  store.journal.assertModelRecoveryAllowed();
  if (store.journal.unresolved().length) throw stop("unresolved proposal prevents automatic transport recovery");
  const traces = new TraceStore(store.root);
  // Bounded discovery fails closed when an older original trace is outside the
  // window. It never selects an earlier failure behind a newer invocation.
  let selected: { run: Awaited<ReturnType<TraceStore["peekRun"]>>; events: Awaited<ReturnType<TraceStore["peekEvents"]>> } | undefined;
  for (const run of await traces.peekRuns({ sourceId: store.plan.sourceId, kind: "prepare", limit: 1000 })) {
    if (run.operationId !== store.plan.batchId) continue;
    const events = await traces.peekEvents(run.id);
    if (events.some(e => e.data?.phase === "role-review-work" && e.data.workId === workId)) { selected = { run, events }; break; }
  }
  if (!selected) throw stop("started audit has no discoverable settled trace");
  const { run, events } = selected;
  if (run.status !== "failed" || !run.endedAt || run.error?.code !== "ROLE_REVIEW_WORK_FAILED"
    || run.error.message !== `Error: ${refusal}` || events.at(-1)?.type !== "run.failed") throw stop("original audit stop is not a settled provider quota refusal");
  const invocation = events.filter(e => e.data?.phase === "role-review-work");
  if (invocation.length !== 1 || invocation[0]!.data?.planHash !== store.planHash
    || invocation[0]!.data?.workId !== workId) throw stop("quota trace belongs to a different invocation");
  const lastFailure = events.findLast(e => e.type === "llm.response.failed");
  if (lastFailure?.data?.errorMessage !== refusal || lastFailure.data.providerId !== "openai-codex") throw stop("provider failure does not match the quota stop");
  const observations = events.filter(e => e.data?.phase === "role-request-observation");
  const taskHash = observations[0]?.data?.logicalTaskHash, ordinal = observations[0]?.data?.sessionOrdinal;
  if (typeof taskHash !== "string" || !/^[a-f0-9]{64}$/.test(taskHash) || !Number.isInteger(ordinal)
    || observations.some(e => e.data?.logicalTaskHash !== taskHash || e.data.sessionOrdinal !== ordinal)) throw stop("stopped audit has ambiguous task or session identity");
  const budget = inspectRoleReviewBudget(store.root, store.planHash, workId);
  const stopped = events.findLast(e => e.data?.phase === "role-review-work-stopped")?.data;
  if (stopped?.workId !== workId || budget.state.blocked || budget.state.failure || !remainingRoleProgressCalls(budget)
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
  if (pending.size) throw stop("quota trace contains an unfinished tool call");
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
  const taskNames = await names(workContexts);
  if (taskNames.length !== 1 || taskNames[0] !== taskHash) throw stop("audit has multiple or unknown logical tasks");
  const contextDir = path.join(workContexts, taskHash), allContextFiles = await names(contextDir);
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
  const authority = { version: 1, policy: "compile-audit-quota-v1", planHash: store.planHash, workId, page,
    runId: run.id, runHash: contentHash(run), traceHash: contentHash(events), budgetHash: budget.hash,
    taskHash, attempt: Math.max(...attempts.map(n => Number(n[0]))), nextOrdinal: lastOrdinal + 1,
    atlasRevision: store.atlasRevision(), entriesHash: store.entriesHash(), claimAuditsHash: contentHash(store.claimAudits()), retainedFiles, retainedDraft: retainedDraft ?? null };
  return { authority, authorityHash: contentHash(authority), originalPrompt,
    file: path.join(base, "host-interruptions", "compile-quota", store.planHash, `${contentHash({ workId, runId: run.id })}.json`) };
}

export async function claimAutomaticRoleResume(store: RoleReviewWorkStore, preview: AutomaticRoleResume) {
  if ((await WorkspaceOperationLock.inspect(store.root)).owner?.pid !== process.pid) throw stop("automatic quota recovery requires the compiler lock");
  const current = await inspectAutomaticRoleResume(store, preview.authority.page);
  if (!current || current.authorityHash !== preview.authorityHash) throw stop("quota recovery preview changed");
  await fs.mkdir(path.dirname(preview.file), { recursive: true });
  try { await fs.writeFile(preview.file, JSON.stringify({ authority: preview.authority, authorityHash: preview.authorityHash }), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw stop("quota continuation was already claimed; inspect its original result"); throw error; }
  return preview.authority.attempt;
}

export async function inspectClaimedAutomaticResume(store: RoleReviewWorkStore, preview: AutomaticRoleResume) {
  const saved = await read(preview.file), current = await inspectAutomaticRoleResume(store, preview.authority.page);
  if (!current || current.authorityHash !== preview.authorityHash || saved.authorityHash !== contentHash(saved.authority)
    || saved.authorityHash !== preview.authorityHash) throw stop("claimed quota continuation dependencies changed");
  return { workId: preview.authority.workId, taskHash: preview.authority.taskHash, nextOrdinal: preview.authority.nextOrdinal,
    recoveryInfo: { reason: "User resumed compile-novel after a settled provider quota stop", failedRunId: preview.authority.runId,
      authorityHash: preview.authorityHash, retainedDraft: preview.authority.retainedDraft } };
}
