import { ProposalStore } from "../../world/canonical-model.js";
import { validateSourceAnnotationClosure } from "../annotations.js";
import type { AdmissionManifest } from "../cut-admission-schema.js";
import type { CompletenessMeasure, WorldCompletenessReport } from "../world-completeness.js";
import { PipelineStore } from "./store.js";
import { loadPipelineView, measureView } from "./view.js";

/**
 * Closure (design 5.8), replacing the old eleven dimensions with three:
 * structural and evidence validity, the completeness report (no gap in
 * range; every unknown carries its reason), and the per-cut admission list.
 */
export type PipelineClosure = {
  version: 1;
  sourceId: string;
  limit: number;
  checkedAt: string;
  structural: { pendingProposals: number; annotationIssues: string[]; heldScopes: string[]; unfinishedScopes: string[] };
  completeness: { report: Pick<WorldCompletenessReport, "summary" | "policy" | "version">; gaps: Array<Pick<CompletenessMeasure, "id" | "numerator" | "total" | "note">>; unknown: Array<{ id: string; reason: string }> };
  admission: { checked: boolean; admittedCuts: number; enterable: number; blocked: number } | null;
  issues: string[];
  passed: boolean;
};

/** Why a measure is unknown, or null when the unknown is unexplained (that fails closure). */
function unknownReason(measure: CompletenessMeasure, report: WorldCompletenessReport): string | null {
  if (measure.total === 0) return "nothing in range to measure";
  if (measure.denominator === "roster" && !report.roster.reviewed) return "roster not independently reviewed (blocks only full certification, decision D7)";
  if (measure.note) return measure.note;
  return null;
}

export async function checkPipelineClosure(root: string, sourceId: string, limit: number, options: { admission?: AdmissionManifest | null } = {}): Promise<PipelineClosure> {
  const view = await loadPipelineView(root, sourceId);
  const admission = options.admission ?? null;
  // With the candidate's admission manifest, enterability is measured, not left unknown.
  const report = measureView(view, { startByte: 0, endByte: limit }, admission ? { admission } : {});
  const pending = await new ProposalStore(root).list("pending", sourceId);
  const annotationIssues = await validateSourceAnnotationClosure(root, sourceId, [], { includeCommitted: true, verifyAnchors: true });
  const receipts = await new PipelineStore(root, sourceId).receipts();
  const inRange = receipts.filter((receipt) => receipt.range.startByte < limit);
  const held = inRange.filter((receipt) => receipt.status === "held").map((receipt) => receipt.id);
  const unfinished = inRange.filter((receipt) => receipt.status === "running").map((receipt) => receipt.id);
  const gaps = report.measures.filter((item) => item.status === "gap" && item.layer !== "cost");
  const unknown = report.measures.filter((item) => item.status === "unknown").map((item) => ({ id: item.id, reason: unknownReason(item, report) }));
  const issues = [
    ...(pending.length ? [`${pending.length} canonical proposals still pending`] : []),
    ...annotationIssues.slice(0, 20),
    ...held.map((id) => `scope ${id} held for host review`),
    ...unfinished.map((id) => `scope ${id} unfinished`),
    ...gaps.map((item) => `gap ${item.id}: ${item.numerator}/${item.total}${item.id === "agency.speaking-enterable" && report.queues.speakingNotEnterable.length ? ` (not enterable: ${report.queues.speakingNotEnterable.slice(0, 10).join(", ")})` : ""}`),
    ...unknown.filter((item) => item.reason === null).map((item) => `unknown ${item.id} without a reason`),
    ...(admission && !admission.cuts.some((cut) => cut.tier !== "blocked") ? ["no cut admits an entry"] : []),
  ];
  return {
    version: 1, sourceId, limit, checkedAt: new Date().toISOString(),
    structural: { pendingProposals: pending.length, annotationIssues, heldScopes: held, unfinishedScopes: unfinished },
    completeness: { report: { summary: report.summary, policy: report.policy, version: report.version }, gaps: gaps.map(({ id, numerator, total, note }) => ({ id, numerator, total, ...(note ? { note } : {}) })),
      unknown: unknown.map((item) => ({ id: item.id, reason: item.reason ?? "unexplained" })) },
    admission: admission ? { checked: true, admittedCuts: admission.cuts.filter((cut) => cut.tier !== "blocked").length,
      enterable: admission.cuts.reduce((total, cut) => total + cut.actors.filter((actor) => actor.tier !== "blocked").length, 0), blocked: admission.cuts.filter((cut) => cut.tier === "blocked").length } : null,
    issues, passed: issues.length === 0,
  };
}
