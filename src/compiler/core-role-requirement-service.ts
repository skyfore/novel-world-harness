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
