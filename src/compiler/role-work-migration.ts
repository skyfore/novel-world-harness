import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { contentHash } from "../world/canonical.js";
import { worldStorageRoot } from "../world/paths.js";
import { RoleReviewWorkStore, roleWorkStop, type RoleReviewPlan } from "./role-review-work.js";
import { RequirementLedger } from "./requirement-ledger.js";
import { CompilerFinishReceipts } from "./finish-receipts.js";
import { inspectRetainedRoleReviewBudget } from "./role-review-budget.js";
import type { RoleRoster } from "./role-roster.js";
import type { RoleReviewRevision } from "./role-review-revision.js";
import type { RoleWorkAllowance } from "./role-work-allowance.js";
import { CompilerProposalObligations } from "./proposal-obligations.js";

const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export async function activeRoleWorkPlans(root: string, sourceId: string) {
  const revisions = await new RequirementLedger(root, sourceId).roleReviewRevisions();
  const retired = new Set(revisions.flatMap(revision => revision.workMigration ? [revision.workMigration.priorPlan.batchId] : []));
  return (await RoleReviewWorkStore.plans(root, sourceId)).filter(plan => !retired.has(plan.batchId));
}
export async function assertRoleWorkPlanAuthority(root: string, plan: RoleReviewPlan) {
  const revisions = await new RequirementLedger(root, plan.sourceId).roleReviewRevisions();
  if (revisions.some(revision => revision.workMigration?.priorPlan.batchId === plan.batchId)) {
    throw roleWorkStop("this plan is immutable superseded history; inspect requirements inspect and resume its recorded successor, never retry the old scope");
  }
  if (!plan.migration) return;
  const revision = revisions.find(item => item.id === plan.migration!.revisionId);
  if (!revision?.workMigration || contentHash(revision.workMigration.nextPlan) !== contentHash(plan)) {
    throw roleWorkStop("migration lacks its exact host revision; inspect requirements inspect and recover the original begin-core-role-review decision, never guess a plan or repeat unchanged");
  }
  await assertRetainedRoleWork(root, revision.workMigration);
}
export async function assertRetainedRoleWork(root: string, migration: NonNullable<RoleReviewRevision["workMigration"]>) {
  for (const file of migration.retainedFiles) {
    const target = path.resolve(worldStorageRoot(root), file.path);
    if (!target.startsWith(worldStorageRoot(root) + path.sep) || digest(await fs.readFile(target)) !== file.hash) {
      throw roleWorkStop("retained work or budget changed after migration; preserve both versions and stop for host review, do not retry");
    }
  }
}

/** Host-only exact-equivalence migration. Notes and judgments stay proposals;
 * no claim/source audit or completed independent review is imported. */
export async function prepareRoleWorkMigration(root: string, input: {
  sourceId: string; revisionId: string; expectedWorkPlanHash?: string;
  priorRoster: RoleRoster; nextRoster: RoleRoster; structureHash: string;
}): Promise<RoleReviewRevision["workMigration"]> {
  const unfinished: RoleReviewPlan[] = [];
  for (const plan of await activeRoleWorkPlans(root, input.sourceId)) {
    if ((await new CompilerFinishReceipts(root, input.sourceId, plan.batchId).read())?.state !== "completed") unfinished.push(plan);
  }
  if (!unfinished.length) {
    if (input.expectedWorkPlanHash) throw roleWorkStop("no unfinished plan matches the host selection; inspect requirements inspect and copy roleReviewPlans[].planHash for at most one corrected host invocation");
    return;
  }
  if (unfinished.length !== 1 || contentHash(unfinished[0]) !== input.expectedWorkPlanHash) {
    throw roleWorkStop("unfinished review requires explicit plan selection; inspect requirements inspect, copy roleReviewPlans[].planHash into --work-plan, and correct the host invocation once");
  }
  const priorPlan = unfinished[0]!, store = new RoleReviewWorkStore(root, priorPlan);
  await assertRoleWorkPlanAuthority(root, priorPlan);
  if (store.judgmentAuthorities().length || store.auditContractAuthorities().length) throw roleWorkStop("unfinished semantic revisions require their original dependency scope; do not migrate or renew their authority");
  if (priorPlan.subjectHash !== input.priorRoster.subjectHash || priorPlan.reviewRevisionId !== input.priorRoster.reviewRevisionId
    || priorPlan.sourceHash !== input.nextRoster.sourceSha256 || priorPlan.structureHash !== input.structureHash
    || contentHash(input.priorRoster.candidates) !== contentHash(input.nextRoster.candidates)
    || input.priorRoster.subjectHash === input.nextRoster.subjectHash) {
    throw roleWorkStop("migration requires changed subject with identical source, structure and candidate inventory; preserve work for a scoped dependency review, do not retry or broaden this authority");
  }
  store.journal.assertModelRecoveryAllowed();
  if (store.journal.unresolved().length) throw roleWorkStop("original proposals remain unresolved; recover their exact identities before migration");
  for (const record of store.journal.latestAttempts("propose_role_roster_entry")) {
    const proposal = record.input as { subjectHash?: string; reviewRevisionId?: string };
    if (proposal.subjectHash !== priorPlan.subjectHash || proposal.reviewRevisionId !== priorPlan.reviewRevisionId
      || record.inputHash !== CompilerProposalObligations.identity(record.tool, record.input).inputHash) {
      throw roleWorkStop("retained candidate proposal belongs to another subject or has changed; preserve its original identity and stop");
    }
  }
  if (store.journal.history("propose_role_roster_review", "role-roster-review").at(-1)?.status === "succeeded") throw roleWorkStop("a captured independent review needs its original finish; recover that receipt before migration");
  const tasks = [
    ...priorPlan.spans.flatMap((_, page) => (["source", "audit"] as const).map(kind => ({ key: `${kind}:${page}`, workId: store.workId(kind, page) }))),
    ...input.priorRoster.candidates.flatMap(candidate => [{ key: `candidate:${candidate.id}`, workId: `candidate-${candidate.id}` }, { key: `claim:${candidate.id}`, workId: store.claimWorkId(candidate.id) }]),
    { key: "global-assembly", workId: "global-assembly" },
  ];
  const base = path.join(worldStorageRoot(root), "compiler", "role-review-work");
  const allowances: RoleWorkAllowance[] = [];
  for (const task of tasks) {
    const dir = path.join(base, "v1", contentHash(input.sourceId), "attempts", contentHash(priorPlan.batchId), contentHash(task.workId));
    const attempts = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    if (attempts.some(name => !/^[12]\.json$/.test(name))) throw roleWorkStop("unknown invocation record; preserve its authority before migration");
    const prior = store.inheritedAllowance(task.workId);
    const count = Math.max(prior?.attempts ?? 0, ...attempts.map(name => Number(name[0])), 0);
    let budget: RoleWorkAllowance["budget"];
    try { const retained = inspectRetainedRoleReviewBudget(root, store.planHash, task.workId); budget = { limits: retained.limits, state: retained.state }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; budget = prior?.budget; }
    if (count && !budget) throw roleWorkStop(`retained invocation ${task.workId} lacks its budget; recover original trace usage before migration, never assume zero`);
    let contextHandoffs = prior?.contextHandoffs ?? 0;
    try {
      const record = JSON.parse(await fs.readFile(path.join(base, "context", store.planHash, `${contentHash(task.workId)}.json`), "utf8"));
      if (record.hash !== contentHash(record.state) || record.state.planHash !== store.planHash || record.state.workId !== task.workId) throw roleWorkStop("context history integrity changed");
      contextHandoffs = record.state.handoffs.length + (record.state.inheritedHandoffs ?? 0);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let contextSessions = prior?.contextSessions ?? 0;
    const loopDir = path.join(base, "context-loops", store.planHash, contentHash(task.workId));
    const prompts = await fs.readdir(loopDir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    for (const promptHash of prompts) {
      if (!/^[a-f0-9]{64}$/.test(promptHash)) throw roleWorkStop("unknown retained context directory");
      for (const name of await fs.readdir(path.join(loopDir, promptHash))) {
        if (/^[012]\.outcome\.json$/.test(name)) continue;
        if (!/^[012]\.json$/.test(name)) throw roleWorkStop("unknown retained context round");
        const record = JSON.parse(await fs.readFile(path.join(loopDir, promptHash, name), "utf8"));
        if (record.hash !== contentHash(record.claim) || record.claim.planHash !== store.planHash || record.claim.workId !== task.workId
          || record.claim.taskHash !== promptHash || record.claim.ordinal !== Number(name[0])) throw roleWorkStop("retained context round integrity changed");
        contextSessions++;
      }
    }
    const nativeContextFallback = await fs.access(path.join(base, "native-context-fallbacks", store.planHash, `${contentHash(task.workId)}.json`))
      .then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return prior?.nativeContextFallback ?? false; throw error; });
    allowances.push({ key: task.key, attempts: count, contextHandoffs, contextSessions, nativeContextFallback, ...(budget ? { budget } : {}) });
  }
  const retainedFiles: Array<{ path: string; hash: string }> = [];
  async function capture(file: string) {
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw roleWorkStop("symlink in retained work records");
    if (stat.isDirectory()) { for (const name of (await fs.readdir(file)).sort()) await capture(path.join(file, name)); return; }
    if (file.endsWith(".pending") || file.endsWith(".tmp")) throw roleWorkStop("uncertain retained write; recover before migration");
    retainedFiles.push({ path: path.relative(worldStorageRoot(root), file), hash: digest(await fs.readFile(file)) });
  }
  await capture(path.join(base, "v1", contentHash(input.sourceId), `${contentHash(priorPlan.batchId)}.json`));
  await capture(path.join(base, "v1", contentHash(input.sourceId), "attempts", contentHash(priorPlan.batchId)));
  for (const kind of ["budgets", "context", "context-loops", "native-context-fallbacks"]) await capture(path.join(base, kind, store.planHash));
  await capture(path.join(worldStorageRoot(root), "compiler", "proposal-obligations", digest(JSON.stringify([input.sourceId, priorPlan.batchId]))));
  const nextPlan: RoleReviewPlan = {
    version: 1, sourceId: input.sourceId, sourceHash: input.nextRoster.sourceSha256, subjectHash: input.nextRoster.subjectHash,
    reviewRevisionId: input.revisionId, batchId: `role-roster-${input.sourceId}-revision-${contentHash(input.revisionId).slice(0, 24)}`,
    structureHash: input.structureHash, spans: priorPlan.spans, legacyDraftHashes: [],
    migration: { revisionId: input.revisionId, priorBatchId: priorPlan.batchId, priorPlanHash: store.planHash,
      candidateIds: input.nextRoster.candidates.map(candidate => candidate.id),
      sourceWork: priorPlan.spans.map((_, page) => store.read("source", page) ?? null), entries: store.stagedEntries(), allowances },
  };
  return { priorPlan, nextPlan, retainedFiles };
}
