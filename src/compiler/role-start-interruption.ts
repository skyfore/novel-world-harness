import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { WorkspaceOperationLock } from "../util/workspace-lock.js";
import { contentHash } from "../world/canonical.js";
import { worldStorageRoot } from "../world/paths.js";
import { inspectRoleReviewBudget, remainingRoleProgressCalls } from "./role-review-budget.js";
import { loadCurrentRoleRoster } from "./role-roster-tools.js";
import { assertRoleWorkPlanAuthority } from "./role-work-migration.js";
import { RoleReviewWorkStore, roleWorkStop } from "./role-review-work.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const inputSchema = z.object({ sourceId: z.string().min(1), batchId: z.string().min(1), workId: z.string().min(1),
  expectedAttemptHash: hash, lockRecoveryArchive: z.string().min(1), implementationRef: z.string().min(1) }).strict();
export type RoleStartInterruptionInput = z.infer<typeof inputSchema>;
const grantFile = (root: string, planHash: string, workId: string) => path.join(worldStorageRoot(root), "compiler",
  "role-review-work", "host-interruptions", "before-session", planHash, `${contentHash(workId)}.json`);
const names = (dir: string) => fs.readdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });

/** Recover the SAME already-claimed invocation only when its mandatory durable
 * session claim was never published. No new attempt, session or budget is granted. */
export async function inspectRoleStartInterruption(root: string, raw: RoleStartInterruptionInput) {
  const input = inputSchema.parse(raw);
  const plan = (await RoleReviewWorkStore.plans(root, input.sourceId)).find(plan => plan.batchId === input.batchId);
  if (!plan?.migration) throw roleWorkStop("pre-session continuation requires the exact authorized migrated plan");
  await assertRoleWorkPlanAuthority(root, plan);
  const store = new RoleReviewWorkStore(root, plan), current = await loadCurrentRoleRoster(root, input.sourceId);
  store.assertScope(current.roster, contentHash(current.structure), current.structure.sourceBytes);
  const candidateId = plan.migration.candidateIds.find(id => store.claimWorkId(id) === input.workId);
  const inherited = store.inheritedAllowance(input.workId);
  store.journal.assertModelRecoveryAllowed();
  if (!candidateId || !store.sourceComplete() || store.claimAudit(candidateId) || store.journal.unresolved().length || !inherited?.budget
    || inherited.budget.state.blocked || !remainingRoleProgressCalls(inherited.budget)) throw roleWorkStop("pre-session claim is foreign, settled, unresolved or exhausted; do not retry");
  const base = path.join(worldStorageRoot(root), "compiler", "role-review-work");
  const dir = path.join(base, "v1", contentHash(input.sourceId), "attempts", contentHash(input.batchId), contentHash(input.workId));
  const attempt = inherited.attempts + 1, files = await names(dir);
  if (attempt > 2 || files.length !== 1 || files[0] !== `${attempt}.json`) throw roleWorkStop("original invocation identity is ambiguous or exhausted; preserve all attempts");
  const record = JSON.parse(await fs.readFile(path.join(dir, files[0]!), "utf8"));
  if (contentHash(record) !== input.expectedAttemptHash || record.planHash !== store.planHash || record.workId !== input.workId) throw roleWorkStop("original invocation changed; inspect its exact retained record, never guess or retry unchanged");
  const archives = await fs.realpath(path.join(workspaceStateDir(root), "locks", "recovered"));
  const archive = await fs.realpath(input.lockRecoveryArchive);
  if (path.dirname(archive) !== archives) throw roleWorkStop("pre-session interruption lacks this workspace's recovered lock");
  const proof = JSON.parse(await fs.readFile(path.join(archive, "recovery.json"), "utf8"));
  const owner = JSON.parse(await fs.readFile(path.join(archive, "owner.json"), "utf8"));
  if (proof.version !== 1 || proof.archivePath !== archive || contentHash(proof.owner) !== contentHash(owner)
    || !owner.host || contentHash(proof.host) !== contentHash(owner.host)
    || !(Date.parse(owner.startedAt) <= Date.parse(record.at) && Date.parse(record.at) < Date.parse(proof.recoveredAt))) {
    throw roleWorkStop("recovered lock does not cover the original pre-session invocation");
  }
  // This runner always publishes its context claim BEFORE creating a model
  // session or trace. Even an empty task directory is uncertain and must stop.
  if ((await names(path.join(base, "context-loops", store.planHash, contentHash(input.workId)))).length
    || (await names(path.join(base, "context", store.planHash))).some(name => name.startsWith(contentHash(input.workId)))
    || (await names(path.join(base, "native-context-fallbacks", store.planHash))).some(name => name.startsWith(contentHash(input.workId)))) {
    throw roleWorkStop("a session or context may already have started; use its original interruption protocol, do not reuse this invocation");
  }
  const budgetFiles = (await names(path.join(base, "budgets", store.planHash))).filter(name => name.startsWith(contentHash(input.workId)));
  if (budgetFiles.some(name => name !== `${contentHash(input.workId)}.json`)) throw roleWorkStop("pre-session budget has pending or recovery records; preserve them and stop");
  const budget = budgetFiles.length ? inspectRoleReviewBudget(root, store.planHash, input.workId) : undefined;
  if (budget && contentHash({ limits: budget.limits, state: budget.state }) !== contentHash(inherited.budget)) throw roleWorkStop("pre-session budget was charged or changed; never infer zero usage or reset it");
  const authority = { version: 1 as const, input, planHash: store.planHash, attempt, lockRecoveryHash: contentHash(proof),
    budgetHash: contentHash(budget ?? null), inheritedAllowanceHash: contentHash(inherited),
    atlasRevision: store.atlasRevision(), entriesHash: store.entriesHash() };
  return { authority, authorityHash: contentHash(authority), file: grantFile(root, store.planHash, input.workId) };
}

export async function grantRoleStartInterruption(root: string, input: RoleStartInterruptionInput, expectedHash: string) {
  if ((await WorkspaceOperationLock.inspect(root)).owner?.pid !== process.pid) throw roleWorkStop("pre-session continuation requires the host compiler lock");
  const preview = await inspectRoleStartInterruption(root, input);
  if (preview.authorityHash !== expectedHash) throw roleWorkStop("pre-session continuation preview changed; inspect the retained attempt and stop unchanged retries");
  await fs.mkdir(path.dirname(preview.file), { recursive: true });
  await fs.writeFile(preview.file, JSON.stringify({ authority: preview.authority, authorityHash: preview.authorityHash }), { flag: "wx", mode: 0o600 });
  return preview;
}

export async function claimRoleStartInterruption(store: RoleReviewWorkStore, workId: string): Promise<number | undefined> {
  const file = grantFile(store.root, store.planHash, workId);
  let record;
  try { record = JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (record.authorityHash !== contentHash(record.authority) || record.authority.planHash !== store.planHash
    || record.authority.input.workId !== workId) throw roleWorkStop("pre-session continuation authority changed");
  const preview = await inspectRoleStartInterruption(store.root, record.authority.input);
  if (preview.authorityHash !== record.authorityHash) throw roleWorkStop("pre-session continuation evidence changed; stop without dispatch");
  try { await fs.writeFile(`${file}.used`, JSON.stringify({ authorityHash: record.authorityHash, at: new Date().toISOString() }), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw roleWorkStop("pre-session continuation already consumed; never repeat it or reset attempts"); throw error; }
  return preview.authority.attempt;
}
