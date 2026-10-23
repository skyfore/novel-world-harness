import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { worldStorageRoot } from "../world/paths.js";
import { TraceStore } from "../trace/store.js";
import { WorkspaceOperationLock } from "../util/workspace-lock.js";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { CompilerFinishReceipts } from "./finish-receipts.js";
import { loadCurrentRoleRoster } from "./role-roster-tools.js";
import { inspectRetainedRoleReviewBudget, roleContextRecoveryTrace } from "./role-review-budget.js";
import { RoleReviewWorkStore, roleWorkStop } from "./role-review-work.js";

const inputSchema = z.object({ sourceId: z.string().min(1), batchId: z.string().min(1), workId: z.string().min(1),
  runIds: z.array(z.string().min(1)).min(1), auditRef: z.string().min(1), implementationRef: z.string().min(1) }).strict();
export type RoleSourceContextInput = z.infer<typeof inputSchema>;
export type RoleSourceContextResume = { input: RoleSourceContextInput; authorityHash: string };
const filesIn = (dir: string): Promise<string[]> => fs.readdir(dir).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });

/** Host-only migration of retired byte-watermark stops. It grants one physical
 * session, using ONLY the remaining original fixed calls. No proposal failure,
 * quota stop, stalled progress window or uncertain operation is eligible. */
export async function inspectRoleSourceContextContinuation(root: string, raw: RoleSourceContextInput) {
  const input = inputSchema.parse(raw);
  if (new Set(input.runIds).size !== input.runIds.length) throw roleWorkStop("duplicate source context trace IDs");
  const plan = (await RoleReviewWorkStore.plans(root, input.sourceId)).find(p => p.batchId === input.batchId);
  if (!plan) throw roleWorkStop("original source context plan missing");
  const store = new RoleReviewWorkStore(root, plan), current = await loadCurrentRoleRoster(root, input.sourceId);
  const bytes = await readSourceMaterial(root, current.source);
  store.assertScope(current.roster, contentHash(current.structure), bytes.length);
  store.journal.assertModelRecoveryAllowed();
  const page = plan.spans.findIndex((_, p) => store.workId("source", p) === input.workId);
  if (page < 0 || store.read("source", page) || store.journal.unresolved().length
    || store.journal.history("propose_role_source_review", input.workId).length
    || store.journal.latestAttempts("propose_role_source_part").some(a => a.proposalId.startsWith(`${input.workId}:`))
    || store.journal.history("request_role_work_evidence", `need-${contentHash({ planHash: store.planHash, workId: input.workId })}`).length) {
    throw roleWorkStop("source context migration requires an unfinished original source with no proposals or evidence supplement");
  }
  if (await new CompilerFinishReceipts(root, input.sourceId, input.batchId).read()) throw roleWorkStop("original source batch has a frozen finish receipt");
  const base = path.join(worldStorageRoot(root), "compiler", "role-review-work"), key = contentHash(input.workId);
  const file = path.join(base, "source-context-continuations", store.planHash, `${key}.json`);
  try { await fs.access(file); throw roleWorkStop("source context continuation already consumed; never redispatch it"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  for (const dir of [path.join(base, "context-loops", store.planHash, key), path.join(base, "native-context-fallbacks", store.planHash)]) {
    const files = await filesIn(dir);
    if (dir.includes("context-loops") ? files.length : files.includes(`${key}.json`)) {
      throw roleWorkStop("modern session recovery already claimed; legacy context migration cannot replace it");
    }
  }
  const attemptsDir = path.join(base, "v1", contentHash(input.sourceId), "attempts", contentHash(input.batchId), key);
  if (contentHash((await filesIn(attemptsDir)).sort()) !== contentHash(["1.json", "2.json"])) {
    throw roleWorkStop("source migration requires the two retained original invocation markers");
  }
  const seals: Record<string, string> = {};
  const read = async (file: string) => {
    const raw = await fs.readFile(file, "utf8"); seals[file] = contentHash(raw); return JSON.parse(raw);
  };
  const attempts = await Promise.all([1, 2].map(n => read(path.join(attemptsDir, `${n}.json`))));
  if (attempts.some(a => a.planHash !== store.planHash || a.workId !== input.workId || !Number.isFinite(Date.parse(a.at)))) {
    throw roleWorkStop("original invocation scope changed");
  }
  const contextFile = path.join(base, "context", store.planHash, `${key}.json`);
  try { await fs.access(`${contextFile}.pending`); throw roleWorkStop("uncertain original context publication"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const context = await read(contextFile);
  if (context.hash !== contentHash(context.state) || context.state.planHash !== store.planHash || context.state.workId !== input.workId
    || context.state.handoffs?.length !== 2 || !Array.isArray(context.state.accesses)) throw roleWorkStop("original legacy context changed or is incomplete");
  const budget = inspectRetainedRoleReviewBudget(root, store.planHash, input.workId);
  if (budget.state.blocked || budget.state.failure || budget.state.progress
    || budget.state.usage.modelCalls >= budget.limits.maxModelCalls) throw roleWorkStop("original fixed source call allowance is exhausted or no longer eligible");
  Object.assign(seals, budget.files);
  const recoveredRun = await roleContextRecoveryTrace(root, store.planHash, input.workId);
  if (recoveredRun && !input.runIds.includes(recoveredRun)) throw roleWorkStop("original size-recovery trace must be included");
  const traces = new TraceStore(root), bindings = [];
  for (const runId of input.runIds) {
    const run = await traces.peekRun(runId), events = await traces.peekEvents(runId);
    const work = events.find(e => e.type === "validation.completed" && e.data?.phase === "role-review-work")?.data;
    if (run.kind !== "prepare" || !["failed", "succeeded"].includes(run.status) || !run.endedAt
      || run.sourceId !== input.sourceId || run.operationId !== input.batchId || work?.planHash !== store.planHash
      || work.workId !== input.workId || contentHash(work.limits) !== contentHash(budget.limits)) throw roleWorkStop("trace does not belong to the original settled source work");
    if (run.status === "failed" && !/^Error: (?:ROLE_CONTEXT_REPACK_REQUIRED: (?:context|tool-result-reserve|provider-payload) requires \d+ bytes;|Model request budget exhausted: request requires \d+ UTF-8 bytes\.)/.test(run.error?.message ?? "")) {
      throw roleWorkStop("source trace is not a retired byte-watermark stop; preserve the actual failure");
    }
    const pending = new Map<string, typeof events[number]>();
    for (const event of events) {
      const id = event.toolCallId ?? event.callId ?? event.spanId;
      if (event.type === "tool.call.started") {
        if (String(event.data?.toolName).startsWith("propose_") || String(event.data?.toolName).startsWith("request_")) {
          throw roleWorkStop("source migration cannot repeat a proposal or evidence-supplement attempt");
        }
        if (pending.has(id) || !event.blobRef) throw roleWorkStop("original tool result is uncertain; inspect the exact trace before recovery");
        await traces.peekBlob(event.blobRef);
        pending.set(id, event);
      } else if (event.type === "tool.call.failed") {
        throw roleWorkStop("original source work has a tool failure; diagnose it separately, never reopen it through byte-watermark recovery");
      } else if (event.type === "tool.call.completed") {
        const start = pending.get(id);
        if (!start || !event.blobRef || (event.data?.toolName !== undefined && event.data.toolName !== start.data?.toolName)) {
          throw roleWorkStop("original tool result is uncertain; inspect the exact trace before recovery");
        }
        const result = await traces.peekBlob(event.blobRef) as { isError?: boolean; content?: unknown[] } | null;
        if (result?.isError) throw roleWorkStop("original source work returned a tool error; preserve the failure for separate host review");
        if (!Array.isArray(result?.content)) throw roleWorkStop("original tool result is uncertain; inspect its retained result before recovery");
        pending.delete(id);
      }
    }
    if (pending.size) throw roleWorkStop("original tool result is uncertain; no source continuation");
    bindings.push({ runId, status: run.status, endedAt: run.endedAt, calls: run.counts.llmRequests, manifestHash: contentHash(run), traceHash: contentHash(events) });
  }
  const last = [...bindings].sort((a, b) => a.endedAt.localeCompare(b.endedAt)).at(-1)!;
  if (bindings.reduce((sum, b) => sum + b.calls, 0) !== budget.state.usage.modelCalls || last.status !== "failed"
    || Date.parse(last.endedAt) < Math.max(...attempts.map(a => Date.parse(a.at)))) {
    throw roleWorkStop("traces do not account for every charged call and the final original stop");
  }
  const freshness = store.reviewFreshness();
  const authority = { version: 1, input, planHash: store.planHash, page, sourceHash: plan.sourceHash,
    atlasRevision: freshness.atlasRevision, entriesHash: freshness.entriesHash, budgetHash: budget.hash,
    remainingCalls: budget.limits.maxModelCalls - budget.state.usage.modelCalls, limits: budget.limits,
    contextHash: context.hash, seals, bindings,
    dependentReceipts: [...freshness.sourceAudits, ...freshness.claimAudits].map(a => ({ workId: a.workId, receiptHash: a.receiptHash, current: a.current })),
    journalHash: contentHash(["propose_role_source_review", "propose_role_source_part", "propose_role_roster_entry", "propose_role_claim_audit", "propose_role_review_audit", "request_role_work_evidence"].flatMap(tool => store.journal.latestAttempts(tool))) };
  return { authority, authorityHash: contentHash(authority), file, context: context.state };
}

/** The lock-owning host consumes a hash-bound preview exactly once, before any
 * model call. A crash after claiming is a stop, never permission to try again. */
export async function claimRoleSourceContextContinuation(root: string, resume: RoleSourceContextResume) {
  const lock = await WorkspaceOperationLock.inspect(root);
  if (lock.owner?.pid !== process.pid) throw roleWorkStop("source context continuation requires the owning host compiler lock");
  const preview = await inspectRoleSourceContextContinuation(root, resume.input);
  if (preview.authorityHash !== resume.authorityHash) throw roleWorkStop("source context authority changed; inspect a fresh preview before dispatch");
  await fs.mkdir(path.dirname(preview.file), { recursive: true, mode: 0o700 });
  await fs.writeFile(preview.file, JSON.stringify({ authority: preview.authority, authorityHash: preview.authorityHash, claimedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  return preview;
}
