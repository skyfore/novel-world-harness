import { contentHash } from "../world/canonical.js";
import { coreRoleDefinitions, type CoreRoleRequirementDefinition } from "./core-role-requirement-records.js";
import type { RequirementSet } from "./requirement-ledger.js";
import { buildSceneRequirementAssessment, SCENE_REQUIREMENT_EVALUATOR_VERSION } from "../eval/scene-requirements.js";
import type { ReconciliationObligationSnapshot } from "./reconciliation-review-ledger.js";
import { upstreamRepairJournalSchema, type UpstreamRepairRecord } from "./upstream-repair-ledger.js";

/** Bind retained host plans to frozen original definitions and receipt identities, not live revisions. */
export function upstreamRepairSnapshotIssues(snapshot: {
  upstreamRepairJournal?: UpstreamRepairRecord[];
  requirementDefinitions?: RequirementSet[];
  coreRoleRequirementDefinitions?: CoreRoleRequirementDefinition[];
  reconciliationObligations?: ReconciliationObligationSnapshot;
}, sourceId: string, sourceSha256: string): string[] {
  const parsed = upstreamRepairJournalSchema.safeParse(snapshot.upstreamRepairJournal ?? []);
  if (!parsed.success) return ["UPSTREAM_REPAIR_JOURNAL_INVALID"];
  const issues: string[] = [];
  for (const record of parsed.data) {
    if (record.sourceId !== sourceId) issues.push("UPSTREAM_REPAIR_JOURNAL_SOURCE_MISMATCH");
    if (record.payload.kind !== "planned") continue;
    const plan = record.payload.plan;
    if (plan.sourceScope.sourceId !== sourceId || plan.sourceScope.sourceSha256 !== sourceSha256) issues.push("UPSTREAM_REPAIR_PLAN_SOURCE_MISMATCH");
    const scene = snapshot.requirementDefinitions?.find(item => item.revisionHash === plan.requirementSetHash);
    const core = snapshot.coreRoleRequirementDefinitions?.find(item => item.revisionHash === plan.requirementSetHash);
    let requirementIds: string[] = [];
    if (scene) requirementIds = buildSceneRequirementAssessment(scene.spec, [], { sourceId: scene.spec.sourceId, sourceSha256: scene.spec.sourceSha256,
      specHash: contentHash(scene.spec), catalogHash: contentHash({}), evaluatorVersion: SCENE_REQUIREMENT_EVALUATOR_VERSION }).requirements.requirements.map(item => item.id);
    else if (core) requirementIds = coreRoleDefinitions({ source: { id: sourceId } }, core.roster).map(item => item.id);
    else issues.push("UPSTREAM_REPAIR_DEFINITION_MISSING");
    if (plan.requirementIds.some(id => !requirementIds.includes(id))) issues.push("UPSTREAM_REPAIR_REQUIREMENT_MISMATCH");
    for (const fingerprint of plan.predecessorReceiptRefs) {
      const receipt = snapshot.reconciliationObligations?.find(item => item.receipt.fingerprint === fingerprint)?.receipt;
      if (!receipt || receipt.state !== "completed" || receipt.identity.sourceId !== sourceId || receipt.identity.sourceSha256 !== sourceSha256) issues.push("UPSTREAM_REPAIR_PREDECESSOR_RECEIPT_MISSING");
    }
  }
  return [...new Set(issues)];
}
