import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { TraceStore } from "../trace/store.js";
import { WorkspaceOperationLock } from "../util/workspace-lock.js";
import { contentHash } from "../world/canonical.js";
import { worldStorageRoot } from "../world/paths.js";
import { inspectRoleReviewBudget, remainingRoleProgressCalls } from "./role-review-budget.js";
import { RoleReviewWorkStore, roleWorkStop } from "./role-review-work.js";
import { loadCurrentRoleRoster } from "./role-roster-tools.js";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const inputSchema = z.object({ planHash: sha, workId: z.string().min(1), runId: z.string().min(1),
  lockRecoveryArchive: z.string().min(1), implementationRef: z.string().min(1) }).strict();
export type RoleHostInterruptionInput = z.infer<typeof inputSchema>;
export type RoleHostInterruptionResume = { policy: "host-interruption"; planHash: string; workId: string; authorityHash: string };
const authoritySchema = z.object({ version: z.literal(1), input: inputSchema, sourceId: z.string(), batchId: z.string(),
  traceHash: sha, budgetHash: sha, taskHash: sha, priorClaimHash: sha, lockRecoveryHash: sha,
  receiptsHash: sha }).strict();
const grantFile = (root: string, input: { planHash: string; workId: string }) => path.join(worldStorageRoot(root),
  "compiler", "role-review-work", "host-interruptions", sha.parse(input.planHash), `${contentHash(input.workId)}.json`);

/** Read-only proof for a host process interruption, never a quota or validation
 * retry. The original first context and every charged call remain consumed. */
export async function inspectRoleHostInterruption(root: string, raw: RoleHostInterruptionInput) {
  const input = inputSchema.parse(raw), traces = new TraceStore(root);
  const run = await traces.peekRun(input.runId), events = await traces.peekEvents(input.runId);
  if (run.kind !== "prepare" || run.status !== "interrupted" || run.error?.code !== "HOST_RESTART_INTERRUPTED_RUN"
    || !run.sourceId || !run.operationId || events.at(-1)?.type !== "run.interrupted") {
    throw roleWorkStop("trace is not a reconciled host interruption; inspect the original run, never substitute a quota or validation failure");
  }
  const archives = await fs.realpath(path.join(workspaceStateDir(root), "locks", "recovered"));
  const archive = await fs.realpath(input.lockRecoveryArchive);
  if (path.dirname(archive) !== archives) throw roleWorkStop("lock recovery proof is outside this workspace");
  const proof = JSON.parse(await fs.readFile(path.join(archive, "recovery.json"), "utf8"));
  const owner = JSON.parse(await fs.readFile(path.join(archive, "owner.json"), "utf8"));
  if (proof.version !== 1 || proof.archivePath !== archive || contentHash(proof.owner) !== contentHash(owner)
    || !owner.host || contentHash(proof.host) !== contentHash(owner.host)
    || !(Date.parse(owner.startedAt) <= Date.parse(run.startedAt) && Date.parse(run.startedAt) < Date.parse(proof.recoveredAt))
    || events.slice(0, -1).some(event => Date.parse(event.observedAt) > Date.parse(proof.recoveredAt))) {
    throw roleWorkStop("lock recovery proof does not cover this interrupted run");
  }
  const work = events.find(event => event.type === "validation.completed" && event.data?.phase === "role-review-work")?.data;
  if (work?.planHash !== input.planHash || work.workId !== input.workId || typeof work.packetHash !== "string") {
    throw roleWorkStop("interrupted trace belongs to another original task");
  }
  // packetHash includes the session's recovery/read instructions. The immutable
  // task identity is recorded independently for every physical request.
  const requests = events.filter(event => event.type === "validation.completed" && event.data?.phase === "role-request-observation");
  const taskHash = requests[0]?.data?.logicalTaskHash;
  if (typeof taskHash !== "string" || !sha.safeParse(taskHash).success || requests.some(event => event.data?.logicalTaskHash !== taskHash
    || event.data?.sessionOrdinal !== 0 || event.data?.planHash !== input.planHash || event.data?.workId !== input.workId)) {
    throw roleWorkStop("interrupted request observations do not prove one original context");
  }
  const pendingTools = new Set<string>();
  for (const event of events) {
    if (event.type === "tool.call.started") pendingTools.add(event.toolCallId ?? "missing-tool-id");
    if (event.type === "tool.call.completed" || event.type === "tool.call.failed") pendingTools.delete(event.toolCallId ?? "missing-tool-id");
  }
  if (pendingTools.size) throw roleWorkStop("interrupted tool result is uncertain; reconcile the exact call before any session recovery");
  const plan = (await RoleReviewWorkStore.plans(root, run.sourceId)).find(plan => plan.batchId === run.operationId);
  if (!plan) throw roleWorkStop("original interrupted role plan is missing");
  const store = new RoleReviewWorkStore(root, plan), current = await loadCurrentRoleRoster(root, run.sourceId);
  store.assertScope(current.roster, contentHash(current.structure), current.structure.sourceBytes);
  store.journal.assertModelRecoveryAllowed();
  const page = plan.spans.findIndex((_, page) => store.workId("source", page) === input.workId);
  if (store.planHash !== input.planHash || page < 0 || store.read("source", page) || store.journal.unresolved().length) {
    throw roleWorkStop("interrupted source work is settled, foreign, or has unresolved proposals");
  }
  const budget = inspectRoleReviewBudget(root, store.planHash, input.workId);
  if (budget.state.blocked || remainingRoleProgressCalls(budget) === 0) throw roleWorkStop("interrupted work has no remaining progress window");
  const contextRoot = path.join(worldStorageRoot(root), "compiler", "role-review-work", "context-loops", store.planHash, contentHash(input.workId));
  const tasks = await fs.readdir(contextRoot);
  if (tasks.length !== 1 || tasks[0] !== taskHash) throw roleWorkStop("interrupted context identity is ambiguous");
  const context = path.join(contextRoot, tasks[0]);
  const files = await fs.readdir(context);
  if (files.length !== 1 || files[0] !== "0.json") throw roleWorkStop("interrupted context recovery is already consumed or unavailable");
  const prior = JSON.parse(await fs.readFile(path.join(context, "0.json"), "utf8"));
  if (prior.hash !== contentHash(prior.claim) || prior.claim.planHash !== store.planHash || prior.claim.workId !== input.workId
    || prior.claim.taskHash !== taskHash || prior.claim.ordinal !== 0) throw roleWorkStop("original context claim changed");
  const authority = authoritySchema.parse({ version: 1, input, sourceId: run.sourceId, batchId: run.operationId,
    traceHash: contentHash(events), budgetHash: budget.hash, taskHash, priorClaimHash: prior.hash,
    lockRecoveryHash: contentHash(proof), receiptsHash: contentHash(plan.spans.map((_, page) => store.read("source", page) ?? null)) });
  return { authority, authorityHash: contentHash(authority), file: grantFile(root, input) };
}

/** Requires the host's compiler lock and an exact reviewed preview. */
export async function grantRoleHostInterruption(root: string, input: RoleHostInterruptionInput, expectedHash: string) {
  const lock = await WorkspaceOperationLock.inspect(root);
  if (lock.owner?.pid !== process.pid) throw roleWorkStop("host interruption grant requires the current process's compiler lock");
  const preview = await inspectRoleHostInterruption(root, input);
  if (preview.authorityHash !== expectedHash) throw roleWorkStop("host interruption preview changed; inspect before granting");
  await fs.mkdir(path.dirname(preview.file), { recursive: true });
  await fs.writeFile(preview.file, JSON.stringify({ authority: preview.authority, authorityHash: preview.authorityHash }), { flag: "wx", mode: 0o600 });
  return preview;
}

export async function inspectInterruptedRoleSession(store: RoleReviewWorkStore, input: RoleHostInterruptionResume) {
  const record = JSON.parse(await fs.readFile(grantFile(store.root, input), "utf8"));
  const authority = authoritySchema.parse(record.authority);
  if (record.authorityHash !== input.authorityHash || contentHash(authority) !== input.authorityHash
    || authority.input.planHash !== store.planHash || authority.input.workId !== input.workId
    || authority.sourceId !== store.plan.sourceId || authority.batchId !== store.plan.batchId) throw roleWorkStop("host interruption grant scope changed");
  const current = await inspectRoleHostInterruption(store.root, authority.input);
  if (current.authorityHash !== input.authorityHash) throw roleWorkStop("interrupted trace, budget, receipts or context changed after host review");
  return { workId: input.workId, taskHash: authority.taskHash,
    recoveryInfo: { reason: "Verified host process interruption; resume the original task without resetting usage", interruptedRunId: authority.input.runId, hostAuthorityHash: input.authorityHash } };
}
