import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { worldStorageRoot } from "../world/paths.js";
import { TraceStore } from "../trace/store.js";
import { ModelRequestBudget } from "../runtime/model-request-budget.js";
import { inspectRoleReviewBudget } from "./role-review-budget.js";
import { roleWorkStop } from "./role-review-work.js";

const counter = z.number().int().nonnegative();
const stateSchema = z.object({
  usage: z.object({ modelCalls: counter, payloads: counter, totalPayloadBytes: counter, largestRequestBytes: counter }).strict(),
  blocked: z.boolean(), failure: z.object({ code: z.string(), message: z.string() }).strict().optional(),
}).strict();
export type ParentCallContinuation = {
  planHash: string; workId: string; expectedBudgetHash: string;
  sourceId: string; batchId: string; failedRunId: string;
  additionalCalls: number; auditRef: string; implementationRef: string;
};
const basePath = (root: string, input: Pick<ParentCallContinuation, "planHash" | "workId">) =>
  path.join(worldStorageRoot(root), "compiler", "role-review-work", "budgets", input.planHash, `${contentHash(input.workId)}.json`);

/** Explicit host preview only. This never resets a work/proposal allowance. */
export async function inspectParentCallContinuation(root: string, input: ParentCallContinuation) {
  if (!/^[a-f0-9]{64}$/.test(input.planHash) || input.workId !== "continuation-window"
    || !Number.isSafeInteger(input.additionalCalls) || input.additionalCalls <= 0 || input.additionalCalls > 120
    || !input.auditRef.trim() || !input.implementationRef.trim()) throw roleWorkStop("invalid bounded parent budget revision");
  const prior = inspectRoleReviewBudget(root, input.planHash, input.workId);
  if (prior.hash !== input.expectedBudgetHash || !prior.state.blocked || prior.state.failure?.code !== "call-limit"
    || prior.state.usage.modelCalls !== prior.limits.maxModelCalls) throw roleWorkStop("parent call stop changed; inspect its exact retained budget, never clear it");
  const traces = new TraceStore(root), run = await traces.peekRun(input.failedRunId), events = await traces.peekEvents(input.failedRunId);
  const stopped = events.findLast(e => e.type === "validation.completed" && e.data?.phase === "role-review-work-stopped");
  const work = events.findLast(e => e.type === "validation.completed" && e.data?.phase === "role-review-work");
  const budget = stopped?.data?.budget as { blocked?: boolean; usage?: { modelCalls?: number }; limits?: { maxModelCalls?: number } } | undefined;
  if (run.status !== "failed" || run.sourceId !== input.sourceId || run.operationId !== input.batchId
    || !run.error?.message.includes("model-call limit reached") || !work?.data?.planHash || !work.data.workId
    || stopped?.data?.workId !== work.data.workId || budget?.blocked !== false
    || typeof budget.usage?.modelCalls !== "number" || typeof budget.limits?.maxModelCalls !== "number"
    || budget.usage.modelCalls >= budget.limits.maxModelCalls) throw roleWorkStop("trace does not establish a parent call stop with an unexhausted child");
  const child = inspectRoleReviewBudget(root, String(work.data.planHash), String(work.data.workId));
  if (child.state.blocked || contentHash(child.state.usage) !== contentHash(budget.usage)
    || contentHash(child.limits) !== contentHash(budget.limits)) throw roleWorkStop("stopped child usage changed; no implicit continuation");
  const limits = { ...prior.limits, maxModelCalls: prior.limits.maxModelCalls + input.additionalCalls };
  const authority = { version: 1, ...input, priorBudgetHash: prior.hash, limits, initial: { usage: prior.state.usage, blocked: false },
    childPlanHash: String(work.data.planHash), childWorkId: String(work.data.workId), childBudgetHash: child.hash, traceHash: contentHash(events) };
  return { authority, authorityHash: contentHash(authority), file: `${basePath(root, input)}.call-continuation.json` };
}

/** Under the compiler lock. The exhausted record is immutable; a separate
 * continuation starts at its exact cumulative usage, with one explicit grant. */
export async function grantParentCallContinuation(root: string, input: ParentCallContinuation, expectedAuthorityHash: string) {
  const preview = await inspectParentCallContinuation(root, input);
  if (preview.authorityHash !== expectedAuthorityHash) throw roleWorkStop("parent budget authority changed; inspect a fresh preview");
  fs.writeFileSync(preview.file, JSON.stringify({ authority: preview.authority, authorityHash: preview.authorityHash }), { flag: "wx", mode: 0o600 });
  return preview;
}

export function readParentCallContinuation(root: string, input: Pick<ParentCallContinuation, "planHash" | "workId">) {
  const file = `${basePath(root, input)}.call-continuation.json`;
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as Awaited<ReturnType<typeof inspectParentCallContinuation>>;
  const a = record.authority, prior = inspectRoleReviewBudget(root, input.planHash, input.workId);
  if (record.authorityHash !== contentHash(a) || a.planHash !== input.planHash || a.workId !== input.workId
    || a.priorBudgetHash !== prior.hash || a.expectedBudgetHash !== prior.hash || !prior.state.blocked
    || prior.state.failure?.code !== "call-limit" || a.initial.blocked
    || contentHash(a.initial.usage) !== contentHash(prior.state.usage)
    || !Number.isSafeInteger(a.additionalCalls) || a.additionalCalls <= 0 || a.additionalCalls > 120
    || contentHash(a.limits) !== contentHash({ ...prior.limits, maxModelCalls: prior.limits.maxModelCalls + a.additionalCalls })) {
    throw roleWorkStop("parent continuation lineage changed");
  }
  return { ...record, file };
}

export function readParentCallUsage(root: string, input: Pick<ParentCallContinuation, "planHash" | "workId">) {
  const record = readParentCallContinuation(root, input);
  const { authority: a, authorityHash, file } = record;
  const usageFile = `${file}.usage.json`, pending = `${usageFile}.pending`;
  if (fs.existsSync(pending)) throw roleWorkStop("uncertain parent continuation charge; preserve pending publication, do not retry");
  let initial = stateSchema.parse(a.initial);
  if (fs.existsSync(usageFile)) {
    const record = JSON.parse(fs.readFileSync(usageFile, "utf8"));
    const state = stateSchema.parse(record.state);
    if (record.authorityHash !== authorityHash || record.hash !== contentHash({ authorityHash, state })
      || (Object.keys(initial.usage) as Array<keyof typeof initial.usage>).some(k => state.usage[k] < initial.usage[k])) throw roleWorkStop("parent continuation usage regressed");
    initial = state;
  }
  return { ...record, state: initial, hash: contentHash({ authorityHash, state: initial }), usageFile, pending };
}

export function openParentCallContinuation(root: string, input: Pick<ParentCallContinuation, "planHash" | "workId">) {
  const { authority: a, authorityHash, state: initial, usageFile, pending } = readParentCallUsage(root, input);
  const save = (state: z.infer<typeof stateSchema>) => {
    const value = { authorityHash, state };
    fs.writeFileSync(pending, JSON.stringify({ ...value, hash: contentHash(value) }), { flag: "wx", mode: 0o600 });
    fs.renameSync(pending, usageFile);
  };
  if (!fs.existsSync(usageFile)) save(initial);
  return new ModelRequestBudget(a.limits, { initial, save }, { requestBytesMode: "observe", totalBytesMode: "observe" });
}
