import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { contentHash, canonicalJson } from "../world/canonical.js";
import { idSchema } from "../world/model.js";
import { worldStorageRoot } from "../world/paths.js";
import { upstreamRepairPlanSchema, upstreamRepairKindSchema, type UpstreamRepairPlan } from "./upstream-repair-plan.js";
import { upstreamRepairHostError, verifyUpstreamRepairPlan } from "./upstream-repair-preflight.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const stagedDependencySchema = z.object({ attemptRef: hash, proposalHash: hash }).strict();
export type UpstreamStagedDependency = z.infer<typeof stagedDependencySchema>;
const payloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("planned"), plan: upstreamRepairPlanSchema, predecessorPlanHash: hash.nullable() }).strict(),
  z.object({ kind: z.literal("authorized"), planHash: hash }).strict(),
  z.object({ kind: z.literal("attempt-started"), planHash: hash, artifactKind: upstreamRepairKindSchema, artifactId: idSchema, proposalId: idSchema, inputHash: hash, toolInput: z.unknown().optional() }).strict(),
  z.object({ kind: z.literal("attempt-staged"), planHash: hash, attemptRef: hash, proposalHash: hash }).strict(),
  z.object({ kind: z.literal("attempt-validated"), planHash: hash, attemptRef: hash, payloadHash: hash, dependencies: z.array(stagedDependencySchema).max(256).optional() }).strict(),
  z.object({ kind: z.literal("attempt-failed"), planHash: hash, attemptRef: hash, diagnostic: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("needs-host-review"), planHash: hash, reason: z.string().trim().min(1) }).strict(),
]);
const recordSchema = z.object({ version: z.literal(1), sourceId: idSchema, sequence: z.number().int().nonnegative(), predecessorHash: hash.nullable(), payload: payloadSchema, hash }).strict();
type Record = z.infer<typeof recordSchema>;
type Started = Extract<Record["payload"], { kind: "attempt-started" }>;
type PlanState = { plan: UpstreamRepairPlan; state: "planned" | "authorized" | "staging" | "needs-host-review" };
function project(records: Record[]) {
  const plans = new Map<string, PlanState>();
  const attempts = new Map<string, { started: Started; failed: boolean; staged: boolean; validatedHash?: string; dependencies?: UpstreamStagedDependency[] }>();
  for (const [index, record] of records.entries()) {
    const { hash: ownHash, ...identity } = record;
    if (contentHash(identity) !== ownHash || record.sequence !== index || record.predecessorHash !== (records[index - 1]?.hash ?? null)
      || (index && record.sourceId !== records[0]!.sourceId)) throw upstreamRepairHostError("Repair journal chain mismatch");
    const event = record.payload;
    if (event.kind === "planned") {
      const { plan } = event;
      if (plan.sourceScope.sourceId !== record.sourceId || plans.has(plan.planHash) || [...plans.values()].some(item => item.plan.planId === plan.planId || item.plan.batchId === plan.batchId)) throw upstreamRepairHostError("Repair plan identity was reused");
      const overlapping = [...plans.values()].filter(item => item.plan.requirementIds.some(id => plan.requirementIds.includes(id)));
      const predecessor = overlapping.at(-1);
      if ((predecessor?.plan.planHash ?? null) !== event.predecessorPlanHash) throw upstreamRepairHostError("Repair predecessor does not preserve overlapping requirements");
      const changed = predecessor && (predecessor.plan.requirementSetHash !== plan.requirementSetHash || predecessor.plan.baselineRefs.some(prior => plan.baselineRefs.some(next => next.kind === prior.kind && next.id === prior.id && next.revisionHash !== prior.revisionHash)));
      if (predecessor && (overlapping.some(item => item.state !== "needs-host-review") || !changed)) throw upstreamRepairHostError("A new plan requires stopped predecessors and changed dependency revisions");
      plans.set(plan.planHash, { plan, state: "planned" }); continue;
    }
    const current = plans.get(event.planHash);
    if (!current) throw upstreamRepairHostError("Repair event has no frozen plan");
    if (event.kind === "authorized") {
      if (current.state !== "planned") throw upstreamRepairHostError("Repair authorization was consumed or stopped");
      current.state = "authorized";
    } else if (event.kind === "attempt-started") {
      if (event.toolInput !== undefined && contentHash(event.toolInput) !== event.inputHash) throw upstreamRepairHostError("Reserved tool input hash mismatch");
      assertStart(current, event, plans, attempts);
      attempts.set(record.hash, { started: event, failed: false, staged: false }); current.state = "staging";
    } else if (event.kind === "attempt-validated") {
      const attempt = attempts.get(event.attemptRef);
      if (!attempt || attempt.failed || attempt.staged || attempt.validatedHash || attempt.started.planHash !== event.planHash || current.state !== "staging") throw upstreamRepairHostError("Validated payload does not match the reserved attempt");
      if (new Set(event.dependencies?.map(ref => ref.attemptRef)).size !== (event.dependencies?.length ?? 0)) throw upstreamRepairHostError("Duplicate staged dependency");
      const slots = new Set([...current.plan.allowedWrites, ...current.plan.allowedCreations].map(ref => `${ref.kind}:${ref.id}`));
      const required = new Set<string>(), queue = [`${attempt.started.artifactKind}:${attempt.started.artifactId}`];
      while (queue.length) {
        const node = queue.pop()!;
        for (const edge of current.plan.dependencyEdges.filter(edge => edge.from === node && slots.has(edge.to))) if (!required.has(edge.to)) { required.add(edge.to); queue.push(edge.to); }
      }
      const represented = new Set<string>();
      for (const ref of event.dependencies ?? []) {
        const dependency = attempts.get(ref.attemptRef);
        const staged = records.slice(0, index).find(item => item.payload.kind === "attempt-staged" && item.payload.attemptRef === ref.attemptRef);
        if (!dependency?.staged || dependency.started.planHash !== event.planHash || staged?.payload.kind !== "attempt-staged" || staged.payload.proposalHash !== ref.proposalHash) throw upstreamRepairHostError("Validated dependency lacks its same-plan prior staged result");
        represented.add(`${dependency.started.artifactKind}:${dependency.started.artifactId}`);
      }
      if (required.size !== represented.size || [...required].some(key => !represented.has(key))) throw upstreamRepairHostError("Validated dependency set differs from the declared repair DAG");
      attempt.validatedHash = event.payloadHash;
      attempt.dependencies = event.dependencies;
    } else if (event.kind === "attempt-staged") {
      const attempt = attempts.get(event.attemptRef);
      if (!attempt || attempt.failed || attempt.staged || !attempt.validatedHash || attempt.started.planHash !== event.planHash || current.state !== "staging") throw upstreamRepairHostError("Staged result does not match the reserved attempt");
      attempt.staged = true;
    } else if (event.kind === "attempt-failed") {
      const attempt = attempts.get(event.attemptRef);
      if (!attempt || attempt.failed || attempt.staged || attempt.started.planHash !== event.planHash || !["staging", "needs-host-review"].includes(current.state)) throw upstreamRepairHostError("Failure does not match an active repair attempt");
      attempt.failed = true;
      if (current.plan.requirementIds.some(id => [...attempts.values()].filter(item => item.failed && plans.get(item.started.planHash)!.plan.requirementIds.includes(id)).length >= 2)) current.state = "needs-host-review";
    } else {
      if (current.state === "needs-host-review") throw upstreamRepairHostError("Repair stop was rewritten");
      current.state = "needs-host-review";
    }
  }
  return { plans, attempts };
}
function assertStart(current: PlanState, input: Started, plans: Map<string, PlanState>, attempts: Map<string, { started: Started; failed: boolean; staged: boolean }>) {
  const plan = current.plan;
  if (![...plan.allowedWrites, ...plan.allowedCreations].some(ref => ref.kind === input.artifactKind && ref.id === input.artifactId)) throw upstreamRepairHostError("Attempt escapes the exact allocated write slot");
  const related = [...attempts.values()].filter(item => plans.get(item.started.planHash)!.plan.requirementIds.some(id => plan.requirementIds.includes(id)));
  if (related.some(item => !item.failed && !item.staged)) throw upstreamRepairHostError("A reserved attempt is unresolved; recover that original attempt without opening a new model call");
  for (const requirementId of plan.requirementIds) {
    if (related.filter(item => item.failed && plans.get(item.started.planHash)!.plan.requirementIds.includes(requirementId)).length >= 2) throw upstreamRepairHostError(`Persistent failure budget exhausted for ${requirementId}`);
  }
  if (!["authorized", "staging"].includes(current.state)) throw upstreamRepairHostError("Repair is not authorized or has stopped");
  const previous = related.findLast(item => item.started.artifactKind === input.artifactKind && item.started.artifactId === input.artifactId);
  if (previous?.staged) throw upstreamRepairHostError("This logical repair already has a successful draft; preserve it and require a validated host successor instead of another attempt");
  if (previous && (previous.started.proposalId !== input.proposalId || previous.started.inputHash === input.inputHash)) throw upstreamRepairHostError("Failed repair requires the same proposal identity and one materially corrected input");
}

/** Host-only storage, always called under the compiler lock. No model tool is granted by registration. */
export class UpstreamRepairLedger {
  readonly directory: string;
  constructor(private root: string, readonly sourceId: string) {
    idSchema.parse(sourceId);
    this.directory = path.join(worldStorageRoot(root), "compiler", "upstream-repairs", contentHash(sourceId));
  }
  async history(): Promise<Record[]> {
    let head: { hash: string; sequence: number };
    try { head = z.object({ hash, sequence: z.number().int().nonnegative() }).strict().parse(JSON.parse(await fs.readFile(path.join(this.directory, "head.json"), "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const files = await fs.readdir(this.directory).catch(error => { if (error.code === "ENOENT") return [] as string[]; throw error; });
      if (files.some(file => /^[a-f0-9]{64}\.json$/.test(file))) throw upstreamRepairHostError("Repair journal head is missing; do not initialize a fresh budget");
      return [];
    }
    const records: Record[] = []; let cursor: string | null = head.hash;
    for (let sequence = head.sequence; sequence >= 0; sequence--) {
      if (!cursor) throw upstreamRepairHostError("Repair journal predecessor is missing");
      const record = recordSchema.parse(JSON.parse(await fs.readFile(path.join(this.directory, `${cursor}.json`), "utf8")));
      if (record.hash !== cursor || record.sourceId !== this.sourceId || record.sequence !== sequence) throw upstreamRepairHostError("Repair journal source or index mismatch");
      records.unshift(record); cursor = record.predecessorHash;
    }
    project(records); return records;
  }
  async inspect() { const records = await this.history(); const state = project(records); return { records, plans: [...state.plans.values()], attempts: [...state.attempts].map(([attemptRef, value]) => ({ attemptRef, ...value })) }; }
  private async append(payload: Record["payload"]): Promise<Record> {
    const records = await this.history(), identity = { version: 1 as const, sourceId: this.sourceId, sequence: records.length, predecessorHash: records.at(-1)?.hash ?? null, payload };
    const record = recordSchema.parse({ ...identity, hash: contentHash(identity) }); project([...records, record]);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = path.join(this.directory, `${record.hash}.json`), temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, canonicalJson(record) + "\n", { flag: "wx", mode: 0o600 });
      try { await fs.link(temporary, destination); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || canonicalJson(JSON.parse(await fs.readFile(destination, "utf8"))) !== canonicalJson(record)) throw error; }
      await fs.unlink(temporary);
      await fs.writeFile(temporary, canonicalJson({ hash: record.hash, sequence: record.sequence }) + "\n", { mode: 0o600 });
      await fs.rename(temporary, path.join(this.directory, "head.json"));
    } finally { await fs.rm(temporary, { force: true }); }
    return record;
  }
  async register(raw: UpstreamRepairPlan, predecessorPlanHash: string | null = null): Promise<void> {
    const plan = upstreamRepairPlanSchema.parse(raw), records = await this.history();
    const existing = records.find(record => record.payload.kind === "planned" && record.payload.plan.planHash === plan.planHash);
    if (existing?.payload.kind === "planned") {
      if (existing.payload.predecessorPlanHash !== predecessorPlanHash) throw upstreamRepairHostError("Original plan predecessor changed");
      return;
    }
    await verifyUpstreamRepairPlan(this.root, plan);
    await this.append({ kind: "planned", plan, predecessorPlanHash });
  }
  async authorize(planHash: string): Promise<void> {
    const current = project(await this.history()).plans.get(planHash);
    if (!current || current.state === "needs-host-review") throw upstreamRepairHostError("Plan is missing or stopped");
    await this.verifyOrStop(current.plan);
    if (current.state === "planned") await this.append({ kind: "authorized", planHash });
  }
  private async verifyOrStop(plan: UpstreamRepairPlan) {
    try { return await verifyUpstreamRepairPlan(this.root, plan); }
    catch (error) { await this.stop(plan.planHash, error instanceof Error ? error.message : String(error)); throw error; }
  }
  async startAttempt(planHash: string, input: Omit<Started, "kind" | "planHash">): Promise<string> {
    const started = payloadSchema.parse({ kind: "attempt-started", planHash, ...input }) as Started;
    const state = project(await this.history()), current = state.plans.get(planHash);
    if (!current) throw upstreamRepairHostError("Plan is missing");
    assertStart(current, started, state.plans, state.attempts);
    await this.verifyOrStop(current.plan);
    return (await this.append(started)).hash;
  }
  async recordFailure(planHash: string, attemptRef: string, diagnostic: string): Promise<void> {
    const records = await this.history();
    const existing = records.find(record => record.payload.kind === "attempt-failed" && record.payload.attemptRef === attemptRef);
    if (existing?.payload.kind === "attempt-failed") {
      if (existing.payload.planHash !== planHash || existing.payload.diagnostic !== diagnostic) throw upstreamRepairHostError("Original failure was rewritten");
      return;
    }
    await this.append({ kind: "attempt-failed", planHash, attemptRef, diagnostic });
  }
  /** Freeze the host-validated normalized payload before any proposal write. */
  async recordValidated(planHash: string, attemptRef: string, payloadHash: string, dependencies: UpstreamStagedDependency[] = []): Promise<void> {
    const records = await this.history();
    const existing = records.find(record => record.payload.kind === "attempt-validated" && record.payload.attemptRef === attemptRef);
    if (existing?.payload.kind === "attempt-validated") {
      if (existing.payload.planHash !== planHash || existing.payload.payloadHash !== payloadHash || contentHash(existing.payload.dependencies ?? []) !== contentHash(dependencies)) throw upstreamRepairHostError("Original validated payload or dependencies were rewritten");
      return;
    }
    await this.append({ kind: "attempt-validated", planHash, attemptRef, payloadHash, dependencies });
  }
  /** Called only after the host has verified the exact pending envelope and mutation. */
  async recordStaged(planHash: string, attemptRef: string, proposalHash: string): Promise<void> {
    const records = await this.history();
    const existing = records.find(record => record.payload.kind === "attempt-staged" && record.payload.attemptRef === attemptRef);
    if (existing?.payload.kind === "attempt-staged") {
      if (existing.payload.planHash !== planHash || existing.payload.proposalHash !== proposalHash) throw upstreamRepairHostError("Original staged result was rewritten");
      return;
    }
    await this.append({ kind: "attempt-staged", planHash, attemptRef, proposalHash });
  }
  async stop(planHash: string, reason: string): Promise<void> {
    const state = project(await this.history()).plans.get(planHash);
    if (!state) throw upstreamRepairHostError("Plan is missing");
    if (state.state === "needs-host-review") return;
    await this.append({ kind: "needs-host-review", planHash, reason });
  }
}
