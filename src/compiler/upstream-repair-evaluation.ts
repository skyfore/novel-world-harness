import { contentHash } from "../world/canonical.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { inspectUpstreamRepairJournal, UpstreamRepairLedger } from "./upstream-repair-ledger.js";
import { activeRequirementSets, resultFromReport, type RequirementResult } from "./requirement-ledger.js";
import { evaluateReviewedSceneCapabilities } from "../eval/scene-capabilities.js";
import { frozenSceneCatalog } from "./requirement-service.js";
import { evaluateCoreRoleCapabilities } from "./core-role-capabilities.js";
import { preparedSubjectHash, type NovelClosureAssessment } from "./certification.js";
import type { PreparedNovelBundle } from "./prepared-cache.js";
import type { UpstreamRepairPlan } from "./upstream-repair-plan.js";
import { upstreamRepairHostError } from "./upstream-repair-preflight.js";
import { verifyUpstreamRepairConvergence } from "./upstream-repair-convergence.js";
import { upstreamRepairEvaluationSchema, UPSTREAM_REPAIR_EVALUATOR_VERSION } from "./upstream-repair-evaluation-model.js";

type AssessmentInputs = Pick<NovelClosureAssessment, "subjectSnapshotHash" | "roster" | "playability" | "requirementResults" | "coreRoleResult">;

/** Recompute against frozen independently reviewed definitions; never trust recorded success. */
export function upstreamRepairRequirementResult(bundle: PreparedNovelBundle, assessment: AssessmentInputs, plan: UpstreamRepairPlan): RequirementResult {
  const scene = activeRequirementSets(bundle.compilerSnapshot.requirementDefinitions ?? []).find(item => item.revisionHash === plan.requirementSetHash);
  const core = bundle.compilerSnapshot.coreRoleRequirementDefinitions?.at(-1);
  let result: RequirementResult;
  if (scene) {
    const catalog = frozenSceneCatalog(bundle);
    result = resultFromReport(scene, evaluateReviewedSceneCapabilities(scene.spec, catalog), catalog);
    if (contentHash(result) !== contentHash(assessment.requirementResults?.find(item => item.setId === scene.id) ?? null)) throw upstreamRepairHostError("Source-verified requirement assessment differs from recomputed scene result");
  } else if (core?.revisionHash === plan.requirementSetHash) {
    if (!assessment.roster || contentHash(assessment.roster) !== contentHash(core.roster)) throw upstreamRepairHostError("Core requirement assessment no longer matches the original active definition");
    result = evaluateCoreRoleCapabilities(bundle, core.roster, assessment.playability, assessment.subjectSnapshotHash);
    if (contentHash(result) !== contentHash(assessment.coreRoleResult ?? null)) throw upstreamRepairHostError("Core requirement assessment differs from the deterministic result");
  } else throw upstreamRepairHostError("Repair independent requirement definition is no longer active");
  const requirements = result.requirements.filter(item => plan.requirementIds.includes(item.id)).sort((a, b) => a.id.localeCompare(b.id));
  if (requirements.length !== plan.requirementIds.length || new Set(requirements.map(item => item.id)).size !== plan.requirementIds.length) throw upstreamRepairHostError("Evaluation does not cover every original independent requirement");
  return { ...result, requirements };
}

/** Certification consumes current exact results, even when the stored evaluation claims success. */
export function upstreamRepairEvaluationIssues(bundle: PreparedNovelBundle, assessment: AssessmentInputs): string[] {
  let state;
  try { state = inspectUpstreamRepairJournal(bundle.compilerSnapshot.upstreamRepairJournal ?? []); }
  catch { return ["UPSTREAM_REPAIR_JOURNAL_INVALID"]; }
  const subject = preparedSubjectHash(bundle), issues: string[] = [];
  for (const [index, current] of state.plans.entries()) {
    // Linked host successors inherit obligations, not a clean budget. Old attempts remain historical.
    const activeIds = current.plan.requirementIds.filter(id => !state.plans.slice(index + 1).some(next => next.plan.requirementIds.includes(id)));
    if (!activeIds.length) continue;
    if (current.state !== "evaluated" || !current.evaluation) {
      issues.push(`UPSTREAM_REPAIR_NOT_EVALUATED: ${current.plan.planHash} (${current.state})`); continue;
    }
    const evaluation = current.evaluation.result;
    if (evaluation.subjectSnapshotHash !== subject || assessment.subjectSnapshotHash !== subject) {
      issues.push(`UPSTREAM_REPAIR_EVALUATION_STALE: ${current.plan.planHash}`); continue;
    }
    try {
      const expected = upstreamRepairRequirementResult(bundle, assessment, current.plan);
      if (contentHash(expected) !== contentHash(evaluation.result)) { issues.push(`UPSTREAM_REPAIR_EVALUATION_MISMATCH: ${current.plan.planHash}`); continue; }
      for (const requirement of expected.requirements.filter(item => activeIds.includes(item.id))) if (requirement.state !== "satisfied") issues.push(`UPSTREAM_REPAIR_REQUIREMENT_UNRESOLVED: ${requirement.id} (${requirement.state})`);
    } catch (error) { issues.push(`UPSTREAM_REPAIR_EVALUATION_INVALID: ${current.plan.planHash}: ${String(error)}`); }
  }
  return issues;
}

/** Called under the compiler lock. Reads and evaluates actual state, never accepts model results. */
export async function prepareUpstreamRepairEvaluation(root: string, sourceId: string, planHash: string) {
  await verifyUpstreamRepairConvergence(root, sourceId, planHash);
  const state = await new UpstreamRepairLedger(root, sourceId).inspect(), current = state.plans.find(item => item.plan.planHash === planHash)!;
  const convergence = state.records.find(item => item.payload.kind === "converged" && item.payload.planHash === planHash);
  if (!convergence || convergence.payload.kind !== "converged") throw upstreamRepairHostError("Requirement evaluation requires an observed convergence record");
  const source = await WorkspaceStore.openReadOnly(root).getSource(sourceId);
  if (!source) throw upstreamRepairHostError("Evaluation source is not registered");
  const { PreparedNovelCache } = await import("./prepared-cache.js");
  const { bundle, assessment } = await new PreparedNovelCache(root).inspectCandidate(source).catch(error => {
    throw upstreamRepairHostError(`Evaluation inputs cannot be frozen: ${String(error)}; inspect the original source workflow, then use requirements evaluate-upstream --source ${sourceId} after host repair`);
  });
  return upstreamRepairEvaluationSchema.parse({ version: 1, evaluatorVersion: UPSTREAM_REPAIR_EVALUATOR_VERSION,
    planHash, requirementSetHash: current.plan.requirementSetHash, receiptFingerprint: convergence.payload.receiptFingerprint,
    convergenceRef: convergence.hash, subjectSnapshotHash: preparedSubjectHash(bundle), result: upstreamRepairRequirementResult(bundle, assessment, current.plan) });
}

/** Separate host settlement; completion/convergence alone never grants capability success. */
export async function settleUpstreamRepairRequirements(root: string, sourceId: string) {
  const source = await WorkspaceStore.openReadOnly(root).getSource(sourceId);
  if (!source) throw upstreamRepairHostError("Evaluation source is not registered");
  const ledger = new UpstreamRepairLedger(root, sourceId), results = [];
  for (const current of (await ledger.inspect()).plans.filter(item => ["converged", "evaluated"].includes(item.state))) results.push(await ledger.recordEvaluation(current.plan.planHash));
  if (!(await ledger.inspect()).plans.length) return { results, issues: [] as string[] };
  const { PreparedNovelCache } = await import("./prepared-cache.js");
  const { bundle, assessment } = await new PreparedNovelCache(root).inspectCandidate(source);
  return { results, issues: upstreamRepairEvaluationIssues(bundle, assessment) };
}

/** Invalidate derived results after any host input change, including an unfreezable candidate. */
export async function observeUpstreamRepairEvaluationValidity(root: string, sourceId: string) {
  const ledger = new UpstreamRepairLedger(root, sourceId), evaluated = (await ledger.inspect()).plans.filter(item => item.state === "evaluated");
  if (!evaluated.length) return;
  const source = await WorkspaceStore.openReadOnly(root).getSource(sourceId);
  let nextSubject: string | null = null, reason = "Current frozen compiler inputs changed";
  try {
    if (!source) throw upstreamRepairHostError("Evaluation source is not registered");
    const { PreparedNovelCache } = await import("./prepared-cache.js");
    nextSubject = preparedSubjectHash(await new PreparedNovelCache(root).candidateSnapshot(source));
  } catch (error) { reason = `Current evaluation inputs cannot be frozen: ${String(error)}`; }
  for (const current of evaluated) await ledger.invalidateEvaluation(current.plan.planHash, nextSubject, reason);
}
