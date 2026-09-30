import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { worldStorageRoot } from "../world/paths.js";
import { ModelRequestBudget, type ModelRequestLimits, type ModelRequestUsage } from "../runtime/model-request-budget.js";
import { RoleReviewWorkStore, roleWorkStop } from "./role-review-work.js";
import { TraceStore } from "../trace/store.js";
const counter = z.number().int().nonnegative();
const stateSchema = z.object({ usage: z.object({ modelCalls: counter, payloads: counter, totalPayloadBytes: counter, largestRequestBytes: counter }).strict(), blocked: z.boolean(), failure: z.object({ code: z.string(), message: z.string() }).strict().optional() }).strict();
const grantSchema = z.object({ version: z.literal(1), planHash: z.string(), workId: z.string(), priorBudgetHash: z.string(), failedRunId: z.string(), failureTraceHash: z.string(), implementationRef: z.string().min(1), at: z.string(), reason: z.literal("request-size"), initial: stateSchema }).strict();
function budgetPath(root: string, planHash: string, workId: string) { return path.join(worldStorageRoot(root), "compiler", "role-review-work", "budgets", planHash, `${contentHash(workId)}.json`); }
function readBudget(file: string, planHash: string, workId: string, limits?: ModelRequestLimits) {
  if (fs.existsSync(`${file}.pending`)) throw roleWorkStop("uncertain budget publication; inspect the retained pending charge, never reset usage");
  const record = JSON.parse(fs.readFileSync(file, "utf8")), state = stateSchema.parse(record.state);
  if (record.planHash !== planHash || record.workId !== workId || (limits && contentHash(record.limits) !== contentHash(limits)) || record.hash !== contentHash({ planHash, workId, limits: record.limits, state })) throw roleWorkStop("budget scope or integrity changed");
  return { ...record, state } as { hash: string; limits: ModelRequestLimits; state: z.infer<typeof stateSchema> };
}
/** Charged before transport. Recovery uses an immutable grant + separate usage
 * continuation; the original blocked budget is never overwritten or cleared. */
export function roleReviewBudget(root: string, planHash: string, workId: string, limits: ModelRequestLimits, requireExisting = false) {
  const base = budgetPath(root, planHash, workId);
  fs.mkdirSync(path.dirname(base), { recursive: true, mode: 0o700 });
  let file = base, initial: z.infer<typeof stateSchema> | undefined;
  try { initial = readBudget(base, planHash, workId, limits).state; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (fs.existsSync(`${base}.context-recovery.json`)) {
    const record = JSON.parse(fs.readFileSync(`${base}.context-recovery.json`, "utf8")), grant = grantSchema.parse(record.grant);
    const original = readBudget(base, planHash, workId, limits);
    if (record.hash !== contentHash(grant) || grant.priorBudgetHash !== original.hash || grant.planHash !== planHash || grant.workId !== workId || !original.state.blocked || grant.initial.blocked
      || contentHash(grant.initial.usage) !== contentHash(original.state.usage)) throw roleWorkStop("invalid context recovery lineage");
    file = `${base}.after-context-recovery.json`;
    try {
      initial = readBudget(file, planHash, workId, limits).state;
      if ((Object.keys(grant.initial.usage) as Array<keyof ModelRequestUsage>).some(k => initial!.usage[k] < grant.initial.usage[k])) throw roleWorkStop("context recovery usage regressed");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; initial = grant.initial; }
  }
  if (!initial && requireExisting) throw roleWorkStop("prior work has no retained usage record; recover original usage from trace, never assume zero usage");
  const save = (state: z.infer<typeof stateSchema>) => {
    const record = { planHash, workId, limits, state }, temporary = `${file}.pending`;
    fs.writeFileSync(temporary, JSON.stringify({ ...record, hash: contentHash(record) }), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  };
  initial ??= { usage: { modelCalls: 0, payloads: 0, totalPayloadBytes: 0, largestRequestBytes: 0 }, blocked: false };
  if (!fs.existsSync(file)) save(initial);
  return new ModelRequestBudget(limits, { initial, save });
}

/** Host-only under the compiler lock. A trace-proven request-size stop can be
 * repaired once; quota, call/byte exhaustion and unknown failures cannot. */
export async function recoverRoleContextBudget(root: string, input: { sourceId: string; batchId: string; workId: string; expectedBudgetHash: string; failedRunId: string; implementationRef: string }) {
  const plan = (await RoleReviewWorkStore.plans(root, input.sourceId)).find(p => p.batchId === input.batchId);
  if (!plan) throw roleWorkStop("context recovery has no original plan");
  const store = new RoleReviewWorkStore(root, plan);
  const page = plan.spans.findIndex((_, i) => store.workId("source", i) === input.workId);
  // The initial repair authority is deliberately limited to unfinished source work.
  if (page < 0 || store.read("source", page) || store.journal.unresolved().length) throw roleWorkStop("context recovery requires an unfinished source work without unresolved proposals");
  const { loadCurrentRoleRoster } = await import("./role-roster-tools.js");
  const current = await loadCurrentRoleRoster(root, input.sourceId);
  store.assertScope(current.roster, contentHash(current.structure), current.structure.sourceBytes);
  const file = budgetPath(root, store.planHash, input.workId), prior = readBudget(file, store.planHash, input.workId);
  if (fs.existsSync(`${file}.context-recovery.json`)) throw roleWorkStop("context recovery already granted; never grant another allowance");
  if (prior.hash !== input.expectedBudgetHash || !prior.state.blocked || prior.state.usage.modelCalls >= prior.limits.maxModelCalls || prior.state.usage.totalPayloadBytes >= prior.limits.maxTotalPayloadBytes
    || (prior.state.failure && prior.state.failure.code !== "request-size")) throw roleWorkStop("budget recovery is stale or resource-exhausted");
  const traces = new TraceStore(root), run = await traces.peekRun(input.failedRunId), events = await traces.peekEvents(input.failedRunId);
  const failure = events.findLast(e => e.type === "run.failed")?.data?.error as { message?: string } | undefined;
  const size = /^(?:Error|ModelRequestBudgetError): Model request budget exhausted: request requires (\d+) UTF-8 bytes\./.exec(failure?.message ?? "");
  if (run.status !== "failed" || run.sourceId !== input.sourceId || run.operationId !== input.batchId || !size || Number(size[1]) <= prior.limits.maxRequestBytes
    || !events.some(e => e.type === "validation.completed" && e.data?.phase === "role-review-work" && e.data?.workId === input.workId && e.data?.planHash === store.planHash && contentHash(e.data.limits) === contentHash(prior.limits))) throw roleWorkStop("trace does not prove this work's request-size stop");
  const grant = grantSchema.parse({ version: 1, planHash: store.planHash, workId: input.workId, priorBudgetHash: prior.hash, failedRunId: input.failedRunId, failureTraceHash: contentHash(events), implementationRef: input.implementationRef, at: new Date().toISOString(), reason: "request-size", initial: { usage: prior.state.usage, blocked: false } });
  fs.writeFileSync(`${file}.context-recovery.json`, JSON.stringify({ grant, hash: contentHash(grant) }), { flag: "wx", mode: 0o600 });
  return { grantHash: contentHash(grant), remainingCalls: prior.limits.maxModelCalls - prior.state.usage.modelCalls, retainedUsage: prior.state.usage };
}

export async function roleContextRecoveryTrace(root: string, planHash: string, workId: string): Promise<string | undefined> {
  const base = budgetPath(root, planHash, workId), file = `${base}.context-recovery.json`;
  if (!fs.existsSync(file)) return;
  const record = JSON.parse(fs.readFileSync(file, "utf8")), grant = grantSchema.parse(record.grant), prior = readBudget(base, planHash, workId);
  if (record.hash !== contentHash(grant) || grant.priorBudgetHash !== prior.hash || grant.planHash !== planHash || grant.workId !== workId) throw roleWorkStop("context recovery reference integrity changed");
  const events = await new TraceStore(root).peekEvents(grant.failedRunId);
  if (contentHash(events) !== grant.failureTraceHash) throw roleWorkStop("context recovery trace changed after authorization");
  return grant.failedRunId;
}
