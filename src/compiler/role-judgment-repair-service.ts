import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../world/canonical.js";
import { worldStorageRoot } from "../world/paths.js";
import { WorkspaceOperationLock } from "../util/workspace-lock.js";
import { RoleReviewWorkStore, ROLE_CLAIM_AUDIT_TOOL, roleWorkStop } from "./role-review-work.js";
import { CompilerFinishReceipts } from "./finish-receipts.js";
import { RequirementLedger } from "./requirement-ledger.js";
import { loadCurrentRoleRoster } from "./role-roster-tools.js";
import { assertRoleWorkPlanAuthority } from "./role-work-migration.js";
import { inspectRetainedRoleReviewBudget, remainingRoleProgressCalls } from "./role-review-budget.js";
import { roleJudgmentAuthoritySchema, roleJudgmentRepairPolicySchema, roleJudgmentRevisionId,
  ROLE_JUDGMENT_AUTHORITY_TOOL, type RoleJudgmentAuthority, type RoleJudgmentRepairPolicy } from "./role-judgment-revision.js";
import type { RoleWorkAllowance } from "./role-work-allowance.js";

async function requireLock(root: string) {
  if ((await WorkspaceOperationLock.inspect(root)).owner?.pid !== process.pid) throw roleWorkStop("semantic repair requires the owning compiler lock");
}
export async function mutableRoleReview(store: RoleReviewWorkStore) {
  await assertRoleWorkPlanAuthority(store.root, store.plan);
  store.journal.assertModelRecoveryAllowed();
  if (store.journal.unresolved().length) throw roleWorkStop("recover the original unresolved proposals before semantic repair");
  if (await new CompilerFinishReceipts(store.root, store.plan.sourceId, store.plan.batchId).read()
    || store.journal.history("propose_role_roster_review", "role-roster-review").length
    || store.reviewFreshness().sourceAudits.length) throw roleWorkStop("semantic revision requires a review before source audit or finish; retain downstream receipts for an explicit dependency revision");
  if (!store.sourceComplete()) throw roleWorkStop("semantic revision requires complete source work; finish the original source scope first");
  const current = await loadCurrentRoleRoster(store.root, store.plan.sourceId);
  store.assertScope(current.roster, contentHash(current.structure), current.source.bytes);
  return current;
}

export type RoleJudgmentRepairAuthorization = { sourceId: string; batchId: string; planHash: string; authorizationRef: string };
/** Read-only preview. A policy authorizes bounded work, never a literary verdict. */
export async function inspectRoleJudgmentRepairAuthorization(root: string, input: RoleJudgmentRepairAuthorization) {
  const plan = (await RoleReviewWorkStore.plans(root, input.sourceId)).find(p => p.batchId === input.batchId);
  if (!plan || contentHash(plan) !== input.planHash) throw roleWorkStop("unknown repair plan; inspect compile-novel status and requirements inspect, copy roleReviewPlans[].planHash and batchId, correct once without guessing");
  const store = new RoleReviewWorkStore(root, plan), current = await mutableRoleReview(store);
  const policy = roleJudgmentRepairPolicySchema.parse({ version: 1, sourceId: plan.sourceId,
    sourceHash: plan.sourceHash, planHash: store.planHash, batchId: plan.batchId, subjectHash: plan.subjectHash,
    structureHash: plan.structureHash, candidateIds: current.roster.candidates.map(c => c.id),
    authorizationRef: input.authorizationRef, maxSuccessorsPerCandidate: 1, maxInvocationsPerTask: 1 });
  const prior = await new RequirementLedger(root, input.sourceId).roleJudgmentRepairPolicy(store.planHash);
  if (prior && contentHash(prior) !== contentHash(policy)) throw roleWorkStop("semantic repair authority is already fixed; reuse its exact reference, never rename it to renew allowance");
  return { policy, authorityHash: contentHash(policy) };
}
export async function authorizeRoleJudgmentRepairs(root: string, input: RoleJudgmentRepairAuthorization, expectedAuthorityHash: string) {
  await requireLock(root);
  const preview = await inspectRoleJudgmentRepairAuthorization(root, input);
  if (preview.authorityHash !== expectedAuthorityHash) throw roleWorkStop("semantic repair authorization changed; inspect its exact preview before one corrected host invocation");
  await new RequirementLedger(root, input.sourceId).authorizeRoleJudgmentRepairs(preview.policy);
  return preview;
}

/** Capture all old allowance records; the successor may add work but cannot
 * overwrite a charge, forget a stop, or reuse a consumed context round. */
export async function captureRoleWorkAllowance(store: RoleReviewWorkStore, workId: string, retainedFiles: RoleJudgmentAuthority["retainedFiles"], versioned = false): Promise<RoleWorkAllowance> {
  const storage = worldStorageRoot(store.root), base = path.join(storage, "compiler", "role-review-work");
  const inherited = store.inheritedAllowance(workId);
  const attemptDir = path.join(base, "v1", contentHash(store.plan.sourceId), "attempts", contentHash(store.plan.batchId), contentHash(workId));
  const names = await fs.readdir(attemptDir).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
  if (names.some(name => !(versioned ? /^[1-9][0-9]*\.json$/ : /^[12]\.json$/).test(name))) throw roleWorkStop("unknown predecessor invocation; inspect its exact history before semantic repair");
  const attempts = Math.max(inherited?.attempts ?? 0, ...names.map(n => Number(n.slice(0, -5))), 0);
  let budget = inherited?.budget;
  try { const b = inspectRetainedRoleReviewBudget(store.root, store.planHash, store.budgetWorkId(workId)); budget = { limits: b.limits, state: b.state }; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (inherited?.budget && budget && (contentHash(inherited.budget.limits) !== contentHash(budget.limits)
    || Object.entries(inherited.budget.state.usage).some(([key, value]) => budget!.state.usage[key as keyof typeof budget.state.usage] < value)
    || (inherited.budget.state.blocked && !budget.state.blocked))) throw roleWorkStop("predecessor usage regressed or cleared an inherited stop");
  if (attempts && !budget) throw roleWorkStop("predecessor usage is missing; recover original charges, never assume zero");
  let contextSessions = inherited?.contextSessions ?? 0, contextHandoffs = inherited?.contextHandoffs ?? 0;
  const context = path.join(base, "context", store.planHash, `${contentHash(workId)}.json`);
  try {
    const record = JSON.parse(await fs.readFile(context, "utf8"));
    if (record.hash !== contentHash(record.state) || record.state.planHash !== store.planHash || record.state.workId !== workId) throw roleWorkStop("predecessor context integrity changed");
    contextHandoffs = record.state.handoffs.length + (record.state.inheritedHandoffs ?? 0);
    if (contextHandoffs < (inherited?.contextHandoffs ?? 0)) throw roleWorkStop("predecessor context usage regressed");
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const loop = path.join(base, "context-loops", store.planHash, contentHash(workId));
  async function capture(file: string) {
    const stat = await fs.lstat(file).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw roleWorkStop("symlink in predecessor history");
    if (stat.isDirectory()) { for (const name of (await fs.readdir(file)).sort()) await capture(path.join(file, name)); return; }
    if (file.endsWith(".pending") || file.endsWith(".tmp")) throw roleWorkStop("uncertain predecessor publication; recover it before semantic repair");
    const raw = await fs.readFile(file, "utf8");
    if (file.startsWith(loop + path.sep) && !file.endsWith(".outcome.json")) {
      const record = JSON.parse(raw);
      if (record.hash !== contentHash(record.claim) || record.claim.planHash !== store.planHash || record.claim.workId !== workId) throw roleWorkStop("predecessor session claim changed");
      contextSessions++;
    }
    retainedFiles.push({ path: path.relative(storage, file), hash: contentHash(raw) });
  }
  await capture(attemptDir); await capture(context); await capture(loop);
  for (const name of await fs.readdir(path.dirname(context)).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; })) {
    if (name.startsWith(path.basename(context) + ".continuation-")) await capture(path.join(path.dirname(context), name));
  }
  const budgetDir = path.join(base, "budgets", store.planHash);
  for (const name of await fs.readdir(budgetDir).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; })) {
    if (name.startsWith(contentHash(store.budgetWorkId(workId)))) await capture(path.join(budgetDir, name));
  }
  const fallback = path.join(base, "native-context-fallbacks", store.planHash, `${contentHash(workId)}.json`);
  const nativeContextFallback = Boolean(inherited?.nativeContextFallback) || await fs.access(fallback).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return false; throw e; });
  await capture(fallback);
  return { key: workId, attempts, contextSessions, contextHandoffs, nativeContextFallback, ...(budget ? { budget } : {}) };
}

export async function assertRoleJudgmentHistory(store: RoleReviewWorkStore, authority: RoleJudgmentAuthority) {
  const policy = await new RequirementLedger(store.root, store.plan.sourceId).roleJudgmentRepairPolicy(store.planHash);
  if (!policy || contentHash(policy) !== contentHash(authority.policy)) throw roleWorkStop("semantic successor lacks its original host policy");
  for (const file of authority.retainedFiles) {
    if (contentHash(await fs.readFile(path.join(worldStorageRoot(store.root), file.path), "utf8")) !== file.hash) throw roleWorkStop("semantic predecessor history or budget changed; preserve both versions and stop");
  }
}

export async function ensureRoleJudgmentAuthority(store: RoleReviewWorkStore, policy: RoleJudgmentRepairPolicy, candidateId: string) {
  await requireLock(store.root);
  const existing = store.judgmentAuthorities().find(a => a.predecessor.candidateId === candidateId);
  if (existing) { await assertRoleJudgmentHistory(store, existing); return existing; }
  await mutableRoleReview(store);
  const savedPolicy = await new RequirementLedger(store.root, store.plan.sourceId).roleJudgmentRepairPolicy(store.planHash);
  if (!savedPolicy || contentHash(savedPolicy) !== contentHash(policy)) throw roleWorkStop("semantic repair policy changed or was not authorized");
  const predecessor = store.stagedEntries().find(e => e.candidateId === candidateId), predecessorAudit = store.claimAudit(candidateId);
  if (!predecessor || !predecessorAudit || predecessorAudit.verdict === "supported") throw roleWorkStop("semantic repair requires a current settled negative audit");
  const workId = store.originalClaimWorkId(candidateId), receipt = store.journal.history(ROLE_CLAIM_AUDIT_TOOL, workId).at(-1)!;
  const retainedFiles: RoleJudgmentAuthority["retainedFiles"] = [];
  const candidateAllowance = await captureRoleWorkAllowance(store, `candidate-${candidateId}`, retainedFiles);
  const claimAllowance = await captureRoleWorkAllowance(store, workId, retainedFiles);
  if (!claimAllowance.budget || remainingRoleProgressCalls(claimAllowance.budget) === 0
    || (candidateAllowance.budget && remainingRoleProgressCalls(candidateAllowance.budget) === 0)) throw roleWorkStop("semantic repair cannot renew an exhausted predecessor progress window");
  const authority = roleJudgmentAuthoritySchema.parse({ version: 1, revisionId: roleJudgmentRevisionId(store.planHash, candidateId), policy,
    predecessor, predecessorAudit, predecessorAuditWorkId: workId, predecessorReceiptHash: contentHash(receipt),
    candidateAllowance, claimAllowance, retainedFiles: retainedFiles.sort((a, b) => a.path.localeCompare(b.path)) });
  store.journal.record(ROLE_JUDGMENT_AUTHORITY_TOOL, { proposal_id: authority.revisionId, authority }, "succeeded");
  store.refreshJudgmentRevisions();
  return authority;
}
