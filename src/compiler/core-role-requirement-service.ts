import { RequirementLedger } from "./requirement-ledger.js";
import { baseStructuralUnits, type SourceStructureManifest } from "./structure.js";
import type { RoleRoster } from "./role-roster.js";
import type { SourceDocument } from "../storage/workspace-store.js";
import { readSourceMaterial } from "../storage/source-material-store.js";

/** Called by the host under the compiler lock, including finish recovery. */
export async function registerReviewedCoreRoles(root: string, input: { source: SourceDocument; structure: SourceStructureManifest; roster: RoleRoster }, decision?: {
  predecessorRevision?: string; scopeDecisionRef: string; scopeChangeReason: string;
}) {
  if (input.roster.reviews.length !== 2) return;
  const ledger = new RequirementLedger(root, input.source.id);
  const previous = (await ledger.coreRoleDefinitionHistory()).at(-1);
  return ledger.registerCoreRoles({ roster: input.roster, units: baseStructuralUnits(input.structure),
    predecessorRevision: decision ? decision.predecessorRevision : previous?.revisionHash,
    scopeDecisionRef: decision?.scopeDecisionRef ?? `independent-role-reviews:${input.roster.reviews.map(review => review.runId).join("+")}`,
    scopeChangeReason: decision?.scopeChangeReason ?? "Two completed independent source reviews establish the retained role requirements; this automatic registration cannot remove existing requirements.",
    allowScopeReduction: Boolean(decision),
  }, await readSourceMaterial(root, input.source));
}

/** Post-convergence host operation. Pending work cannot be used as world truth. */
export async function settleCoreRoleRequirements(root: string, sourceId: string, cacheRoot?: string) {
  const ledger = new RequirementLedger(root, sourceId);
  if (!(await ledger.coreRoleDefinitionHistory()).length) return;
  const { WorkspaceStore } = await import("../storage/workspace-store.js");
  const { PreparedNovelCache } = await import("./prepared-cache.js");
  const { settleSourceRequirements } = await import("./requirement-service.js");
  await settleSourceRequirements(root, sourceId);
  const source = await WorkspaceStore.openReadOnly(root).getSource(sourceId);
  if (!source) throw new Error("Role settlement source is missing; stop for host storage review, never replay model writes");
  const candidate = await new PreparedNovelCache(root, cacheRoot).inspectCandidate(source);
  await ledger.invalidateCoreRoleEvaluation(candidate.assessment.subjectSnapshotHash);
  await ledger.recordCoreRoleEvaluation(candidate.bundle, candidate.assessment);
  return candidate;
}
