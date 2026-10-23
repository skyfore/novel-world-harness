import { contentHash } from "../world/canonical.js";
import { inspectCompilerStatus } from "./status.js";
import { UpstreamRepairLedger } from "./upstream-repair-ledger.js";
import { NovelCompilationRunStore, NOVEL_COMPILATION_PHASES, type NovelCompilationRun } from "../workflow/novel-compilation.js";

type SourceStatus = Awaited<ReturnType<typeof inspectCompilerStatus>>["sources"][number];
type UpstreamState = Awaited<ReturnType<UpstreamRepairLedger["inspect"]>>;
export type CompilationHandoffTask = {
  id: string;
  kind: "identity-consumers" | "source-audit" | "upstream-repair" | "inspection" | "phase";
  state: "blocked" | "available" | "pending" | "recorded";
  dependsOn: string[];
  refs: string[];
  reason: string;
  command: { program: "nwh"; args: string[] };
  execution: "existing-phase" | "inspect-only";
  resumeCondition: string;
};

/** Scheduling projection only. Every execution still enters its original host
 * verifier, ledger, budget and finish protocol. Historical receipts never grant
 * permission to skip a validator or reopen a consumed model invocation. */
export function compilationHandoff(source: SourceStatus, run: NovelCompilationRun | null, upstream: UpstreamState) {
  const tasks: CompilationHandoffTask[] = [], sid = source.sourceId;
  const command = (...args: string[]) => ({ program: "nwh" as const, args: [...args, "--source", sid] });
  const currentWork = source.roleReviewWork.filter(p => p.current);
  const openPlans = new Set(currentWork.filter(p => p.openQuestions || p.blockedAudits).map(p => p.planHash));
  const roleDependencies: string[] = [];
  if (source.roleReviewInspection === "unknown" || source.identityReviews.inspection === "unknown") {
    const id = "inspection:role-dependencies";
    roleDependencies.push(id);
    tasks.push({ id, kind: "inspection", state: "blocked", dependsOn: [], refs: [], execution: "inspect-only",
      reason: source.diagnostics.join("; ") || "Role/identity dependency inspection is unknown.",
      command: command("compile-novel", "status"),
      resumeCondition: "Repair the reported host storage/ledger inspection error before dispatch. Missing or unreadable records are not approval; do not retry models unchanged." });
  }
  for (const task of source.identityReviews.tasks.filter(t => openPlans.has(t.originalPlanHash))) {
    const id = `identity:${task.taskId}`;
    roleDependencies.push(id);
    const additional = task.shards.reduce((n, s) => n + s.dispositions["additional-repair-required"], 0);
    const revalidate = task.shards.reduce((n, s) => n + s.dispositions["revalidate-required"], 0);
    tasks.push({ id, kind: "identity-consumers", state: "blocked", dependsOn: [],
      refs: [task.taskId, task.intentHash, task.inventoryHash], execution: "inspect-only",
      reason: `${task.recordedReviewedShards}/${task.totalShards} shards and ${task.recordedReviewedConsumers}/${task.totalConsumers} consumers reviewed; ${additional} additional repairs, ${revalidate} revalidations. Recorded review support is not execution authority.`,
      command: command("requirements", "inspect-identity-repairs", "--task", task.taskId),
      resumeCondition: "Copy items[].ref into --ref in this same source/task. Complete the original independent review and supported typed repair/acceptance, revalidate every affected consumer and original question, then verify the source-audit handoff. Preserve all consumed stages and inherited usage; no unchanged retry or parent resume from inspection." });
  }
  const activeRepairs = upstream.plans.filter((item, index, all) => item.plan.requirementIds.some(id =>
    !all.slice(index + 1).some(next => next.plan.requirementIds.includes(id))));
  for (const repair of activeRepairs.filter(p => p.state !== "evaluated")) {
    const id = `upstream:${repair.plan.planHash}`;
    const revalidate = repair.state === "converged";
    const available = ["authorized", "staging", "finish-frozen", "finished"].includes(repair.state)
      && Boolean(repair.finishIntent || repair.finishReview);
    tasks.push({ id, kind: "upstream-repair", state: revalidate ? "pending" : available ? "available" : "blocked", dependsOn: revalidate ? ["phase:repair"] : [],
      refs: [repair.plan.planHash, ...repair.plan.requirementIds],
      reason: `Original upstream plan is ${repair.state}; ${repair.finishIntent || repair.finishReview ? "original finish review retained" : "original finish review required"}.`,
      command: revalidate ? command("compile-novel", "requirements") : available ? command("compile-novel", "recover", "--upstream-plan", repair.plan.planHash)
        : command("requirements", "inspect-upstream"),
      execution: revalidate || available ? "existing-phase" : "inspect-only",
      resumeCondition: "Use the exact plans[].plan.planHash and original finish review. Existing authorization, source/dependency revisions, acceptance and remaining allowance must pass the original verifier. Convergence still requires consumer/requirement revalidation; stopped plans cannot be reopened by this plan." });
  }
  for (const work of currentWork) for (const repair of work.sourceAuditRepairs.filter(r => r.blockedProposal || (r.verificationVerdict && r.verificationVerdict !== "supported"))) {
    const id = `source-audit:${repair.revisionId}`;
    tasks.push({ id, kind: "source-audit", state: "blocked", dependsOn: [...roleDependencies],
      refs: [work.planHash, repair.revisionId, repair.predecessorWorkId], execution: "inspect-only",
      reason: `Source page ${repair.page} retains a consumed negative repair or independent check.`,
      command: command("compile-novel", "status"),
      resumeCondition: "Resolve the retained upstream evidence/dependency conditions through supported typed scopes, then verify the original audit's legal continuation. Do not rerun this single-use repair, clear its questions or renew its budget." });
    roleDependencies.push(id);
  }
  let previous: string | undefined;
  for (const phase of NOVEL_COMPILATION_PHASES) {
    const id = `phase:${phase}`, receipt = run?.history.findLast(r => r.phase === phase);
    const dependencies = previous ? [previous] : [];
    if (phase === "roles") dependencies.push(...roleDependencies);
    if (phase === "recover") dependencies.push(...tasks.filter(t => t.kind === "upstream-repair" && t.state === "blocked").map(t => t.id));
    const blocked = dependencies.some(id => tasks.find(t => t.id === id)?.state === "blocked");
    tasks.push({ id, kind: "phase", state: blocked || receipt?.status === "blocked" ? "blocked"
      : receipt?.status === "completed" ? "recorded" : previous ? "pending" : "available",
      dependsOn: [...new Set(dependencies)], refs: [], execution: "existing-phase",
      reason: receipt?.error ?? (receipt ? `Historical ${receipt.status} scheduling receipt; current inputs must be revalidated.` : "No completed scheduling receipt."),
      command: command("compile-novel", phase),
      resumeCondition: "Complete dependencies using their original authority and retained recovery protocol. This phase revalidates current evidence; a recorded receipt is not a certificate." });
    previous = id;
  }
  return { version: 1 as const, policy: "compilation-handoff/v1", authority: "diagnostic-only" as const,
    sourceId: sid, sourceSha256: source.sourceSha256,
    inputHash: contentHash({ source, run, upstreamHead: upstream.records.at(-1)?.hash ?? null }),
    batchExecution: { completed: source.completedBatches, total: source.totalBatches,
      checkpointComplete: source.batchReviewComplete, finishVerification: "requires-current-host-verification" },
    delivery: { inspection: source.candidates.inspection,
      archivedRevisions: source.candidates.revisions.map(r => ({ bundleHash: r.bundleHash, archivedAt: r.archivedAt,
        recordedClosure: r.closure.status, recordedFullNovelReady: r.fullNovelReady, active: r.active })),
      currentInputsCertified: "not-reverified", branchId: run?.branchId ?? null,
      interpretation: "Archive, recorded certificate and active pointer are distinct. Archived evaluations are not proof that the current working candidate is certified; certify/activate recheck their exact revisions." },
    currentRolePlanHashes: currentWork.map(p => p.planHash),
    retiredRolePlanHashes: source.roleReviewWork.filter(p => !p.current).map(p => p.planHash),
    tasks,
    blockers: tasks.filter(t => t.kind !== "phase" && t.state === "blocked").map(t => t.id),
    closure: run?.closure ?? null,
    interpretation: "All tasks are discoverable; no queue tail is omitted. This plan does not grant writes, renew attempts, validate historical closure against current inputs, certify or activate a candidate. Full compile-novel re-enters the same phase implementations in dependency order." };
}

/** Reads existing stores only; safe for status and planning before model work. */
export async function inspectCompilationHandoff(root: string, sourceId: string, source?: SourceStatus, run?: NovelCompilationRun | null) {
  const current = source ?? (await inspectCompilerStatus(root, sourceId)).sources[0]!;
  const [saved, upstream] = await Promise.all([run === undefined ? new NovelCompilationRunStore(root).read(sourceId) : run,
    new UpstreamRepairLedger(root, sourceId).inspect()]);
  return compilationHandoff(current, saved, upstream);
}

/** Before another role model session, expose the exact dependency rather than
 * redispatching a negative, single-use source audit. Never handles unknown errors
 * as permission to continue. Upstream recovery runs earlier in the full pipeline. */
export async function assertRoleCompilationHandoff(root: string, sourceId: string) {
  const plan = await inspectCompilationHandoff(root, sourceId);
  const blockers = plan.tasks.filter(t => ["identity-consumers", "source-audit", "inspection"].includes(t.kind) && t.state === "blocked");
  if (blockers.length) throw new Error(`ROLE_PREREQUISITE_HOST_REVIEW: COMPILATION_PREREQUISITES_BLOCKED: ${blockers.map(t => `${t.id}: ${t.reason}`).join("; ")}\n`
    + `Inspect nwh compile-novel plan --source ${sourceId}; use tasks[].command and satisfy tasks[].resumeCondition. Preserve original grants, traces and budgets; no unchanged role retry or parent resume.`);
}
