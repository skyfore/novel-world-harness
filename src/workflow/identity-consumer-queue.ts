import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { identityRequirementDirectory } from "../compiler/identity-requirements.js";
import { RequirementLedger } from "../compiler/requirement-ledger.js";
import { inspectIdentityRepairHandoff } from "../compiler/identity-repair-handoff.js";
import { currentConsumerPayload, currentConsumerRepair } from "../compiler/identity-consumer-revalidation.js";
import { withIdentityAuthorityVerification } from "../compiler/identity-requirement-upstream.js";
import { consumerProviderResumptionSchema, type ConsumerProviderResumption } from "../compiler/identity-consumer-stage-recovery.js";
import { prerequisiteStop } from "../compiler/role-source-prerequisites.js";
import { withWorkspaceOperationLock, inspectProcessLiveness, linuxHostIdentity } from "../util/workspace-lock.js";
import { runIdentityConsumerRevalidation } from "./identity-consumer-revalidation.js";
import { retainPiArtifact } from "./receipt-bound-pi-stage.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const planSchema = z.object({ version: z.literal(1), policy: z.literal("identity-consumer-queue/v1"), sourceId: z.string(), taskId: hash,
  intentHash: hash, inventoryHash: hash, totalConsumers: z.number().int().positive(), shard: z.number().int().nonnegative().nullable(),
  refs: z.array(z.string()).min(1), authorizationRef: z.string().trim().min(1) }).strict();
export type ConsumerQueuePlan = z.infer<typeof planSchema>;
export type ConsumerQueueItem = { ref: string; status: "recorded" | "blocked" | "waiting" | "running"; result?: string; reason?: string };
type QueueState = { version: 1; planHash: string; status: "running" | "stopped" | "yielded" | "reviewed"; updatedAt: string;
  owner: { pid: number; host?: Awaited<ReturnType<typeof linuxHostIdentity>> }; currentRef: string | null;
  items: ConsumerQueueItem[]; failure?: string; parentResumeAllowed: false; certificationGranted: false };
const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
const maybe = async (file: string) => { try { return await read(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; } };
const directoryFor = (root: string, source: string, task: string, shard?: number) => {
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).parse(source); hash.parse(task);
  if (shard !== undefined) z.number().int().nonnegative().parse(shard);
  return path.join(identityRequirementDirectory(root, source, task), "queues", shard === undefined ? "all" : `shard-${shard}`);
};
const stop = (message: string) => prerequisiteStop(`${message}. Inspect requirements consumer-queue --source <same source> --task <same task> --inspect with the same shard. Copy its plan.authorizationRef when resuming. For a stopped consumer use inspect-identity-repairs in that same scope and its bounded recovery SOP. Do not replay consumed invocations, change the denominator or reset budgets.`);

export function consumerQueueProgress(plan: ConsumerQueuePlan, items: ConsumerQueueItem[]) {
  if (items.some(i => !plan.refs.includes(i.ref)) || new Set(items.map(i => i.ref)).size !== items.length) throw stop("Queue has foreign or duplicate consumers");
  return { originalTotalConsumers: plan.totalConsumers, queuedConsumers: plan.refs.length,
    recorded: items.filter(i => i.status === "recorded").length, blocked: items.filter(i => i.status === "blocked").length,
    waiting: plan.refs.length - items.filter(i => i.status === "recorded" || i.status === "blocked").length,
    certificationGranted: false, interpretation: "Independent review outcomes only; blocked consumers and original source questions remain required. Queue exhaustion is not compilation completion." };
}

export async function inspectConsumerQueue(root: string, sourceId: string, taskId: string, shard?: number) {
  const directory = directoryFor(root, sourceId, taskId, shard), raw = await maybe(path.join(directory, "plan.json"));
  if (!raw) return { directory, plan: null, state: null, progress: null };
  const plan = planSchema.parse(raw), state: QueueState | null = await maybe(path.join(directory, "state.json"));
  if (plan.sourceId !== sourceId || plan.taskId !== taskId || plan.shard !== (shard ?? null) || state && state.planHash !== contentHash(plan)) throw stop("Queue scope changed");
  const liveness = state?.status === "running" ? await inspectProcessLiveness(state.owner) : null;
  return { directory, plan, state, activity: liveness === "exited" ? "orphaned" : liveness === "unknown" ? "liveness-unknown" : state?.status ?? "prepared",
    processLiveness: liveness, progress: consumerQueueProgress(plan, state?.items ?? []) };
}

/** Durable scheduling only. Every item enters the same original independent
 * review and receipt verifier. No queue state can clear a ledger requirement. */
export async function runIdentityConsumerQueue(options: {
  root: string; sourceId: string; taskId: string; authorizationRef: string; shard?: number; limit?: number;
  providerResumption?: ConsumerProviderResumption; onProgress?: (event: unknown) => void;
}, dependencies = { inspect: inspectIdentityRepairHandoff, review: runIdentityConsumerRevalidation, currentRepair: currentConsumerRepair }) {
  if (options.shard !== undefined && (!Number.isSafeInteger(options.shard) || options.shard < 0)
    || options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) throw stop("Queue shard/limit must be nonnegative/positive integers");
  return withWorkspaceOperationLock(options.root, "compiler", async () => {
    const { root, sourceId, taskId } = options;
    const records = await new RequirementLedger(root, sourceId).identityRequirements(taskId), intent = records[0]?.intent;
    if (!intent) throw stop("Queue has no original identity task");
    const refs = options.shard === undefined ? intent.consumerShards.flatMap(s => s.refs) : intent.consumerShards.find(s => s.index === options.shard)?.refs;
    if (!refs?.length || new Set(refs).size !== refs.length) throw stop("Queue shard is absent or duplicated in the original inventory");
    const plan = planSchema.parse({ version: 1, policy: "identity-consumer-queue/v1", sourceId, taskId, intentHash: contentHash(intent), inventoryHash: intent.inventoryHash,
      totalConsumers: intent.consumerShards.reduce((sum, s) => sum + s.refs.length, 0), shard: options.shard ?? null, refs, authorizationRef: options.authorizationRef });
    const directory = directoryFor(root, sourceId, taskId, options.shard);
    await fs.mkdir(directory, { recursive: true });
    const savedPlan = await maybe(path.join(directory, "plan.json"));
    if (savedPlan && contentHash(savedPlan) !== contentHash(plan)) throw stop("Frozen queue plan or authorization changed");
    await retainPiArtifact(path.join(directory, "plan.json"), plan);
    const previous: QueueState | null = await maybe(path.join(directory, "state.json"));
    if (previous && previous.planHash !== contentHash(plan)) throw stop("Queue state lost its plan");
    const state: QueueState = { version: 1, planHash: contentHash(plan), status: "running", updatedAt: new Date().toISOString(),
      owner: { pid: process.pid, ...(process.platform === "linux" ? { host: await linuxHostIdentity() } : {}) }, currentRef: null,
      items: [], parentResumeAllowed: false, certificationGranted: false };
    const save = async () => {
      const old = await maybe(path.join(directory, "state.json"));
      if (old) { await fs.mkdir(path.join(directory, "history"), { recursive: true }); await retainPiArtifact(path.join(directory, "history", `${contentHash(old)}.json`), old); }
      state.updatedAt = new Date().toISOString();
      const temp = path.join(directory, `state.${crypto.randomUUID()}.tmp`);
      await fs.writeFile(temp, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await fs.rename(temp, path.join(directory, "state.json"));
      options.onProgress?.({ directory, ...state, progress: consumerQueueProgress(plan, state.items) });
    };
    const request = options.providerResumption ? consumerProviderResumptionSchema.parse(options.providerResumption) : undefined;
    if (request) await retainPiArtifact(path.join(directory, `continuation-${request.scopeHash}.json`), request);
    let dispatched = 0;
    let target: Awaited<ReturnType<typeof currentConsumerRepair>> | undefined;
    try {
      await save();
      for (const ref of refs) {
        const fresh = await dependencies.inspect(root, sourceId, { taskId, ref });
        if (!("selected" in fresh) || fresh.intentHash !== plan.intentHash || fresh.inventoryHash !== plan.inventoryHash || fresh.selected.ref !== ref)
          throw stop("Current consumer discovery changed its frozen queue scope");
        if (fresh.selected.reason !== "typed-consumer" || ref === `roster/${sourceId}`) {
          state.items.push({ ref, status: "blocked", reason: "Original source-review owner must resolve this consumer; it cannot be replaced by a typed consumer review." });
          await save(); continue;
        }
        // The queue owns the compiler lock. Its review stages append judgments
        // without changing the upstream receipt or its canonical inputs.
        target ??= await withIdentityAuthorityVerification(() => dependencies.currentRepair(root, sourceId, taskId));
        const { receipt, upstream, current } = target;
        const revision = contentHash(currentConsumerPayload(fresh.selected, current));
        const matches = (r: { ref: string; upstreamPlanHash: string; receiptFingerprint: string; currentRevisionHash: string }) =>
          r.ref === ref && r.upstreamPlanHash === upstream.plan.planHash && r.receiptFingerprint === receipt.fingerprint && r.currentRevisionHash === revision;
        const reviews = fresh.summary.consumerRevalidation.currentReviews ?? fresh.summary.consumerRevalidation.reviews;
        const review = reviews.findLast(matches), attempts = fresh.summary.consumerRevalidation.attempts.filter(matches);
        if (review && review.status !== "awaiting-independent-check") {
          state.items.push({ ref, status: ["unaffected", "revalidated"].includes(review.status) ? "recorded" : "blocked", result: review.status });
          await save(); continue;
        }
        if (dispatched >= (options.limit ?? plan.refs.length)) { state.status = "yielded"; break; }
        if (attempts.length > 1) throw stop(`Consumer ${ref} has multiple historical scopes; select its exact correction through the original recovery command`);
        const attempt = attempts[0];
        const retainedScope = attempt ? await read(path.join(attempt.directory, "scope.json")) : undefined;
        const continuation = attempt ? await maybe(path.join(directory, `continuation-${attempt.scopeHash}.json`)) : undefined;
        const args = { root, sourceId, taskId, ref, authorizationRef: retainedScope?.authorizationRef ?? plan.authorizationRef, acquireLock: false,
          ...(retainedScope?.compilerCorrection ? { compilerCorrection: retainedScope.compilerCorrection.policy } : {}),
          ...(continuation ? { providerResumption: consumerProviderResumptionSchema.parse(continuation), resumeUnsubmitted: "run" as const } : {}) };
        const inspected = await dependencies.review({ ...args, ...(continuation ? { resumeUnsubmitted: "inspect" as const } : { inspectExecution: true }) });
        if (!["ready", "sealed"].includes(inspected.status)) throw stop(`Consumer ${ref} is ${inspected.status}; no unchanged dispatch`);
        const item: ConsumerQueueItem = { ref, status: "running" };
        state.items.push(item); state.currentRef = ref; await save();
        const result = await dependencies.review(args); dispatched++;
        if (!["unaffected", "revalidated", "blocked", "repair-required"].includes(result.status)) throw stop(`Consumer ${ref} stopped as ${result.status}`);
        item.status = ["unaffected", "revalidated"].includes(result.status) ? "recorded" : "blocked"; item.result = result.status;
        state.currentRef = null; await save();
      }
      if (state.status === "running") state.status = "reviewed";
      await save();
      return { directory, state, progress: consumerQueueProgress(plan, state.items) };
    } catch (error) { state.status = "stopped"; state.failure = String(error); await save(); throw error; }
  });
}
