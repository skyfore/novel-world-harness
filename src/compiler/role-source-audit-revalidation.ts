import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../world/canonical.js";
import { worldStorageRoot } from "../world/paths.js";
import { ROLE_CONTEXT_MAX_SESSIONS } from "../workflow/role-session-context.js";
import { RequirementLedger } from "./requirement-ledger.js";
import { CompilerFinishReceipts } from "./finish-receipts.js";
import { remainingRoleProgressCalls } from "./role-review-budget.js";
import { ROLE_AUDIT_WORK_TOOL, RoleReviewWorkStore, roleAuditWorkSchema, roleWorkStop } from "./role-review-work.js";
import { CompilerProposalObligations } from "./proposal-obligations.js";
import { assertRoleWorkPlanAuthority } from "./role-work-migration.js";

export type MigratedSourceAuditProof = {
  workId: string;
  revisionId: string;
  priorPlanHash: string;
  priorReceiptHash: string;
  allowanceHash: string;
};

/** Read-only selection of revalidation already authorized by a subject revision.
 * This does not grant attempts, import an old audit, or revive a stopped task. */
export async function inspectMigratedSourceAudit(store: RoleReviewWorkStore, workId: string): Promise<MigratedSourceAuditProof> {
  await assertRoleWorkPlanAuthority(store.root, store.plan);
  const migration = store.plan.migration;
  const page = store.plan.spans.findIndex((_, index) => store.workId("audit", index) === workId);
  if (!migration || page < 0) throw roleWorkStop("select a migrated source audit using RoleReviewWorkStore.plans and copy workId('audit', page); correct the selection once, never guess IDs");
  store.journal.assertModelRecoveryAllowed();
  if (store.journal.unresolved().length || store.journal.history(ROLE_AUDIT_WORK_TOOL, workId).length) {
    throw roleWorkStop("current-plan audit or unresolved proposal already exists; inspect its original receipt and do not redispatch");
  }
  if (await new CompilerFinishReceipts(store.root, store.plan.sourceId, store.plan.batchId).read()
    || store.journal.history("propose_role_roster_review", "role-roster-review").length) {
    throw roleWorkStop("roster assembly or finish already started; recover that original scope instead of dispatching a source audit");
  }
  const allowance = store.inheritedAllowance(workId);
  if (!allowance?.attempts || !allowance.budget || allowance.attempts >= 2
    || allowance.budget.state.blocked || allowance.budget.state.failure || remainingRoleProgressCalls(allowance.budget) === 0
    || allowance.nativeContextFallback || allowance.contextSessions === undefined || allowance.contextSessions >= ROLE_CONTEXT_MAX_SESSIONS
    || (allowance.contextHandoffs ?? 0) >= 2) {
    throw roleWorkStop("migrated audit lacks an intact remaining invocation, context or progress allowance; retain its stop and do not retry");
  }
  const revision = (await new RequirementLedger(store.root, store.plan.sourceId).roleReviewRevisions())
    .find(item => item.id === migration.revisionId)!;
  const prior = new RoleReviewWorkStore(store.root, revision.workMigration!.priorPlan);
  const receipt = prior.journal.history(ROLE_AUDIT_WORK_TOOL, prior.workId("audit", page)).at(-1);
  if (!receipt || receipt.status !== "succeeded") throw roleWorkStop("predecessor audit has no verified terminal receipt; recover its original task, never replace an interrupted audit with a diagnostic prompt");
  const input = receipt.input as { planHash: string; payload: unknown };
  if (input.planHash !== prior.planHash || receipt.inputHash !== CompilerProposalObligations.identity(ROLE_AUDIT_WORK_TOOL, receipt.input).inputHash) {
    throw roleWorkStop("predecessor audit receipt integrity changed; preserve history and do not retry");
  }
  roleAuditWorkSchema.parse(input.payload);

  // Dispatch opens checkpoints before reserving an invocation. Even an empty
  // local attempt directory cannot prove that changing this task is safe.
  const base = path.join(worldStorageRoot(store.root), "compiler", "role-review-work");
  const workHash = contentHash(workId);
  const attempts = path.join(base, "v1", contentHash(store.plan.sourceId), "attempts", contentHash(store.plan.batchId), workHash);
  const locations = [
    { directory: path.dirname(attempts), prefix: workHash },
    ...["budgets", "context", "context-loops", "native-context-fallbacks"].map(kind => ({ directory: path.join(base, kind, store.planHash), prefix: workHash })),
  ];
  for (const location of locations) {
    const names = await fs.readdir(location.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (names.some(name => name.startsWith(location.prefix))) throw roleWorkStop("current-plan audit already has invocation, context or budget state; preserve the immutable task and do not redispatch");
  }
  return { workId, revisionId: migration.revisionId, priorPlanHash: prior.planHash,
    priorReceiptHash: contentHash(receipt), allowanceHash: contentHash(allowance) };
}
