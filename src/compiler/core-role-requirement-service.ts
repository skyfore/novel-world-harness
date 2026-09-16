import { contentHash } from "../world/canonical.js";
import { RequirementLedger } from "./requirement-ledger.js";
import { baseStructuralUnits, type SourceStructureManifest } from "./structure.js";
import { majorRoleCandidates, type RoleRoster } from "./role-roster.js";
import type { SourceDocument } from "../storage/workspace-store.js";
import { readSourceMaterial } from "../storage/source-material-store.js";

/** Called by the host under the compiler lock, including finish recovery. */
export async function registerReviewedCoreRoles(root: string, input: { source: SourceDocument; structure: SourceStructureManifest; roster: RoleRoster }, decision?: {
  predecessorRevision?: string; scopeDecisionRef: string; scopeChangeReason: string;
}) {
  if (!input.roster.reviews.length) return;
  const ledger = new RequirementLedger(root, input.source.id);
  const bytes = await readSourceMaterial(root, input.source);
  await ledger.recordRoleReviewSnapshot(input.roster, bytes);
  const { observeRequirementValidity } = await import("./requirement-observation.js");
  // Observe saved partial reviews as well; a roster write is not an evaluation.
  await observeRequirementValidity(root, input.source.id);
  if (input.roster.reviews.length !== 2) return;
  const previous = (await ledger.coreRoleDefinitionHistory()).at(-1);
  const revision = (await ledger.roleReviewRevisions()).at(-1);
  if (revision && input.roster.reviewRevisionId === revision.id && !decision && (!previous || contentHash(previous.roster) !== contentHash(input.roster))) {
    const currentIds = new Set(majorRoleCandidates(input.roster).map(role => role.id));
    const removed = majorRoleCandidates(revision.priorRoster).filter(role => !currentIds.has(role.id));
    if (removed.length) throw new Error(`Revised source review removes retained major roles: ${removed.map(role => role.id).join(", ")}. Stop model retries. The host must inspect the saved new reviews and use nwh requirements register-core-roles --source ${input.source.id} with exact predecessor, scope-decision and reason; preserve the prior roster and do not retry unchanged.`);
  }
  const definition = await ledger.registerCoreRoles({ roster: input.roster, units: baseStructuralUnits(input.structure),
    predecessorRevision: decision ? decision.predecessorRevision : previous?.revisionHash,
    scopeDecisionRef: decision?.scopeDecisionRef ?? `independent-role-reviews:${input.roster.reviews.map(review => review.runId).join("+")}`,
    scopeChangeReason: decision?.scopeChangeReason ?? "Two completed independent source reviews establish the retained role requirements; this automatic registration cannot remove existing requirements.",
    allowScopeReduction: Boolean(decision),
  }, bytes);
  await observeRequirementValidity(root, input.source.id);
  return definition;
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
