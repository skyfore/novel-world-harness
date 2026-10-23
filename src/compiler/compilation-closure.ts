import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { WorkspaceOperationLock } from "../util/workspace-lock.js";
import { auditCompiler, type CompilerAuditReport } from "./audit.js";
import { inspectCompilerStatus } from "./status.js";
import { CompilerFinishReceipts } from "./finish-receipts.js";
import { RequirementLedger } from "./requirement-ledger.js";
import { settleSourceRequirements } from "./requirement-service.js";
import { SourceAccountingStore, isBlockingSourceAccountingStatus } from "./source-accounting.js";
import { loadCurrentRoleRoster } from "./role-roster-tools.js";
import { validateRoleRoster } from "./role-roster.js";
import { roleReviewFinishIssues } from "./role-review-finish.js";
import { captureReconciliationObligations, reconciliationObligationIssues } from "./reconciliation-review-ledger.js";
import { coreRoleDefinitions, coreRoleDefinitionBindingIssues } from "./core-role-requirement-records.js";
import { baseStructuralUnits } from "./structure.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const dimensions = ["source", "batch-execution", "execution-obligations", "role-source-review", "upstream-handoff",
  "structural", "evidence", "accounting", "resolution", "semantic", "registered-requirements"] as const;
export const compilationClosureSchema = z.object({
  version: z.literal(1), policy: z.literal("compilation-closure/v1"),
  sourceId: z.string(), sourceSha256: digest, compilerFingerprintHash: digest,
  inputHash: digest, auditHash: digest, requirementHead: digest.nullable(), capturedAt: z.string(),
  complete: z.boolean(), certificationGranted: z.literal(false),
  gates: z.array(z.object({
    dimension: z.enum(dimensions), state: z.enum(["passed", "blocked", "unknown"]),
    refs: z.array(z.string()), reasons: z.array(z.string()),
    owner: z.enum(["source", "recover", "batches", "roles", "repair", "requirements"]),
  }).strict()),
  accounting: z.object({ total: z.number(), accounted: z.number(), represented: z.number(), deferred: z.number(), blocking: z.number() }).strict(),
  interpretation: z.string(),
}).strict().superRefine((report, ctx) => {
  if (report.gates.length !== dimensions.length || new Set(report.gates.map(g => g.dimension)).size !== dimensions.length)
    ctx.addIssue({ code: "custom", message: "Compilation closure must retain every required dimension exactly once" });
  if (report.complete !== report.gates.every(g => g.state === "passed"))
    ctx.addIssue({ code: "custom", message: "Compilation closure cannot override a blocked or unknown gate" });
});
export type CompilationClosure = z.infer<typeof compilationClosureSchema>;
type SourceStatus = Awaited<ReturnType<typeof inspectCompilerStatus>>["sources"][number];

/** Deterministic assembly; no semantic judgments are generated from counts.
 * Required unknown dimensions remain unknown, and empty obligation lists do
 * not discharge source accounting or independent requirements. */
export function compilationClosureReport(input: {
  source: SourceStatus; fingerprint: unknown; audit: CompilerAuditReport;
  unverifiedBatchIds: string[]; receiptErrors: string[];
  requirementIssues: string[]; requirementHead: string | null;
  roleIssues: string[];
  blockedUnitIds: string[]; handoffBlockers: string[];
}): CompilationClosure {
  const { source, audit } = input;
  const gates: CompilationClosure["gates"] = [];
  const gate = (dimension: CompilationClosure["gates"][number]["dimension"], state: CompilationClosure["gates"][number]["state"],
    owner: CompilationClosure["gates"][number]["owner"], refs: string[] = [], reasons: string[] = []) => {
    gates.push({ dimension, state, owner, refs, reasons });
  };
  gate("source", source.sourceIntegrity === "verified" && source.plan.available ? "passed" : "unknown", "source", [source.sourceId],
    source.sourceIntegrity === "verified" && source.plan.available ? [] : ["Immutable source and current segment plan must both be verified."]);
  gate("batch-execution", source.batchReviewComplete && !input.unverifiedBatchIds.length && !input.receiptErrors.length ? "passed" : "blocked", "batches",
    input.unverifiedBatchIds, input.receiptErrors);
  gate("execution-obligations", source.obligations.length || source.finish.receipts.some(r => r.recoveryRequired) ? "blocked"
    : source.finish.inspection === "verified" ? "passed" : "unknown", "recover",
    [...source.obligations.map(o => `${o.batchId}/${o.tool}/${o.proposalId}`), ...source.finish.receipts.filter(r => r.recoveryRequired).map(r => r.batchId)],
    source.obligations.map(o => o.diagnostic));
  const work = source.roleReviewWork.filter(w => w.current);
  const outstanding = work.filter(w => w.reviewedSources < w.sourceWorks || w.auditedSources < w.sourceWorks
    || w.openQuestions || w.blockedAudits || w.pendingClaimVerifications || w.unauditedClaims || w.staleSourceAudits || w.staleClaimAudits);
  gate("role-source-review", source.roleReviewInspection === "unknown" ? "unknown" : outstanding.length || input.roleIssues.length ? "blocked" : "passed", "roles",
    outstanding.map(w => w.planHash), [...input.roleIssues, ...outstanding.map(w => `${w.planHash}: ${w.auditedSources}/${w.sourceWorks} source audits closed; ${w.openQuestions} open questions.`)]);
  gate("upstream-handoff", source.identityReviews.inspection === "unknown" ? "unknown" : input.handoffBlockers.length ? "blocked" : "passed", "repair", input.handoffBlockers);
  for (const dimension of ["structural", "evidence", "accounting", "resolution", "semantic"] as const) {
    const state = audit.readiness[dimension];
    gate(dimension, state === "ready" ? "passed" : state === "not-ready" ? "blocked" : "unknown", "repair",
      dimension === "accounting" ? input.blockedUnitIds
        : dimension === "resolution" ? [...audit.resolutions.missingMentionIds, ...audit.eventResolutions.missingMentionIds] : [],
      state === "ready" ? [] : audit.readiness.blockingIssues);
  }
  gate("registered-requirements", input.requirementIssues.length ? "blocked" : "passed", "requirements", [], input.requirementIssues);
  return compilationClosureSchema.parse({ version: 1, policy: "compilation-closure/v1", sourceId: source.sourceId, sourceSha256: source.sourceSha256,
    compilerFingerprintHash: contentHash(input.fingerprint), inputHash: contentHash(input), auditHash: contentHash(audit), requirementHead: input.requirementHead,
    capturedAt: new Date().toISOString(), complete: gates.every(g => g.state === "passed"), certificationGranted: false, gates,
    accounting: { total: audit.observations.baseUnits, accounted: audit.observations.accountedUnits,
      represented: audit.observations.statusCounts.represented, deferred: audit.observations.statusCounts["intentionally-deferred"], blocking: audit.observations.blockingUnits },
    interpretation: "Current source/global compilation checks only. Independent semantic/support specifications and runtime evaluation still run before certification. This scheduling snapshot is historical after any input change; it never authorizes activation or replaces requirement/repair ledgers." });
}

/** Formal pipeline stage, not a status read: settles existing requirements and
 * rechecks original receipts and all source dimensions under compiler ownership.
 * No new model sessions, grants, candidate activation or world edits. */
export async function checkCompilationClosure(root: string, sourceId: string): Promise<CompilationClosure> {
  if ((await WorkspaceOperationLock.inspect(root)).owner?.pid !== process.pid)
    throw new Error("COMPILATION_CLOSURE_LOCK_REQUIRED: use compile-novel closure under the compiler lock; inspect compiler-lock inspect before retrying, never run concurrently.");
  const requirements = await settleSourceRequirements(root, sourceId);
  const [status, audit, accounting, history, obligations] = await Promise.all([
    inspectCompilerStatus(root, sourceId), auditCompiler(root, { sourceId }),
    new SourceAccountingStore(root).read(sourceId), new RequirementLedger(root, sourceId).history(),
    captureReconciliationObligations(root, sourceId),
  ]);
  const source = status.sources[0]!, unverifiedBatchIds: string[] = [], receiptErrors: string[] = [];
  const roleIssues: string[] = [];
  try {
    const { roster, structure } = await loadCurrentRoleRoster(root, sourceId);
    const definitions = history.flatMap(r => r.payload.kind === "core-role-definition" ? [r.payload.definition] : []);
    roleIssues.push(...validateRoleRoster(roster).map(i => `${i.code}: ${i.message}`),
      ...roleReviewFinishIssues(obligations, roster, sourceId),
      ...coreRoleDefinitionBindingIssues(definitions, { sourceId, sourceSha256: source.sourceSha256, roster,
        specHash: contentHash({ definitions: coreRoleDefinitions({ source: { id: sourceId } }, roster), units: baseStructuralUnits(structure) }) }));
  } catch (error) { roleIssues.push(String(error)); }
  for (const batch of source.plan.batches) {
    try {
      if (!source.completedBatchIds.includes(batch.id) || !await new CompilerFinishReceipts(root, sourceId, batch.id).hasVerifiedCompletedReceipt())
        unverifiedBatchIds.push(batch.id);
    } catch (error) { unverifiedBatchIds.push(batch.id); receiptErrors.push(`${batch.id}: ${String(error)}`); }
  }
  const { inspectCompilationHandoff } = await import("./compilation-handoff.js");
  const handoff = await inspectCompilationHandoff(root, sourceId, source);
  return compilationClosureReport({ source, fingerprint: status.compilerFingerprint, audit, unverifiedBatchIds, receiptErrors,
    requirementIssues: [...requirements.issues, ...reconciliationObligationIssues(obligations, sourceId, source.sourceSha256)],
    requirementHead: history.at(-1)?.hash ?? null, roleIssues,
    blockedUnitIds: accounting?.records.filter(r => isBlockingSourceAccountingStatus(r.status)).map(r => r.unitId) ?? [],
    handoffBlockers: handoff.tasks.filter(t => t.kind !== "phase").map(t => t.id) });
}

export function assertCompilationClosure(report: CompilationClosure) {
  const checked = compilationClosureSchema.parse(report);
  if (checked.complete && checked.gates.every(g => g.state === "passed")) return;
  throw new Error(`COMPILATION_CLOSURE_BLOCKED: ${checked.gates.filter(g => g.state !== "passed").map(g => `${g.dimension}=${g.state} (${g.refs.length} references)`).join("; ")}. `
    + `Inspect nwh compile-novel plan --source ${checked.sourceId}; closure.gates retain every reference and owning phase. Resolve the original requirement/repair scope and re-run closure; no unchanged model retry, budget reset or completeness claim.`);
}
