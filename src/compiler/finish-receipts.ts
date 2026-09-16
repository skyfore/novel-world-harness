import { upstreamRepairFinishIntentSchema } from "./upstream-repair-finish-intent.js";
import { compilerFinishInputSchema } from "./finish-input.js";
export { compilerFinishInputSchema } from "./finish-input.js";
import { coreRoleAttemptSchema, coreRoleAttemptScopeSchema, coreRoleAttemptReports, linkCoreRoleAttemptProposals, coreRoleAttemptScope } from "./requirement-attempts.js";
import { reconciliationRequirementSchema } from "./reconciliation-review.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { worldStorageRoot } from "../world/paths.js";
import { idSchema } from "../world/model.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { sourceTitleProposalSchema } from "../storage/novel-title.js";
import { SourceMaterialStore } from "../storage/source-material-store.js";
import { ProposalStore } from "../world/canonical-model.js";
import { SourceAnnotationStore } from "./annotations.js";
import { EntityResolutionStore } from "./entity-resolution.js";
import { EventResolutionStore } from "./event-resolution.js";
import { SourceAccountingStore } from "./source-accounting.js";
import { sourceSegmentSchema } from "./segments.js";
import { chapterSplitPlanSchema } from "./chapter-split.js";
import { roleRosterReviewSchema } from "./role-roster.js";
import { COMPILER_PIPELINE_VERSION } from "./batch-progress.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const dependencySchema = z.object({ store: z.enum(["world", "annotation", "entity-resolution", "event-resolution", "accounting"]), proposalId: idSchema, hash: hashSchema }).strict();
type Dependency = z.infer<typeof dependencySchema>;
const identitySchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]), pipelineVersion: z.number().int().positive(), sourceId: idSchema, sourceSha256: hashSchema, batchId: idSchema,
  upstreamRepairIntent: upstreamRepairFinishIntentSchema.optional(),
  requirementScope: z.object({ planHash: hashSchema, requirements: z.array(reconciliationRequirementSchema), coreRoleScope: coreRoleAttemptScopeSchema.nullable().optional() }).strict().optional(),
  requirementAttempts: z.array(coreRoleAttemptSchema).optional(),
  input: compilerFinishInputSchema, segments: z.array(sourceSegmentSchema), dependencies: z.array(dependencySchema),
  metadata: z.object({ title: sourceTitleProposalSchema.optional(), chapterSplit: chapterSplitPlanSchema.optional(), roleReview: roleRosterReviewSchema.optional() }).strict(),
}).strict().superRefine((identity, ctx) => {
  if ((identity.version === 3) !== Boolean(identity.upstreamRepairIntent)) ctx.addIssue({ code: "custom", message: "Finish upstream scope/version mismatch" });
  const upstream = identity.upstreamRepairIntent;
  if (upstream) {
    const expected = upstream.proposals.map(p => ({ store: p.artifactKind.endsWith("resolution") ? p.artifactKind : "annotation", proposalId: p.proposalId, hash: p.proposalHash })).sort((a, b) => `${a.store}:${a.proposalId}`.localeCompare(`${b.store}:${b.proposalId}`));
    if (identity.requirementScope || identity.requirementAttempts || Object.keys(identity.metadata).length || upstream.sourceId !== identity.sourceId || upstream.sourceSha256 !== identity.sourceSha256 || contentHash(upstream.input) !== contentHash(identity.input)
      || contentHash(expected) !== contentHash(identity.dependencies.slice().sort((a, b) => `${a.store}:${a.proposalId}`.localeCompare(`${b.store}:${b.proposalId}`)))) ctx.addIssue({ code: "custom", message: "Finish differs from frozen upstream authority" });
  }
  const scope = identity.requirementScope?.coreRoleScope;
  if (Boolean(scope) !== Boolean(identity.requirementAttempts)) ctx.addIssue({ code: "custom", message: "Finish independent attempts/scope mismatch" });
  if (scope && identity.requirementAttempts) {
    const expected = coreRoleAttemptReports({ batchId: identity.batchId, scope, requirements: identity.requirementScope!.requirements, reviews: identity.input.target_reviews ?? [] });
    if (contentHash(expected) !== contentHash(identity.requirementAttempts.map(attempt => ({ ...attempt, proposalRefs: [] })))) ctx.addIssue({ code: "custom", message: "Finish attempt reports differ from independent scope" });
    for (const attempt of identity.requirementAttempts) {
      if (attempt.modelOutcome === "proposed" && !attempt.proposalRefs.length) ctx.addIssue({ code: "custom", message: "Proposed attempt has no proposal dependency" });
      if (new Set(attempt.proposalRefs.map(ref => ref.proposalId)).size !== attempt.proposalRefs.length || attempt.proposalRefs.some(ref => ref.store !== "world" || !identity.dependencies.some(dependency => contentHash(dependency) === contentHash(ref)))) ctx.addIssue({ code: "custom", message: "Attempt proposal escapes frozen dependencies" });
      if (attempt.evidenceRefs.some(ref => !identity.segments.some(segment => ref === `source-segment:${segment.id}`))) ctx.addIssue({ code: "custom", message: "Attempt evidence escapes frozen source segments" });
    }
  }
  if ((identity.version === 2) !== Boolean(identity.requirementScope)) ctx.addIssue({ code: "custom", message: "Finish requirement scope/version mismatch" });
});
export const compilerFinishReceiptSchema = z.object({
  identity: identitySchema, fingerprint: hashSchema, state: z.enum(["prepared", "completed"]),
  preparedAt: z.string().datetime(), completedAt: z.string().datetime().optional(),
}).strict().superRefine((receipt, ctx) => {
  if (contentHash(receipt.identity) !== receipt.fingerprint) ctx.addIssue({ code: "custom", message: "finish fingerprint mismatch" });
  if ((receipt.state === "completed") !== Boolean(receipt.completedAt)) ctx.addIssue({ code: "custom", message: "finish completion timestamp mismatch" });
});
export type CompilerFinishReceipt = z.infer<typeof compilerFinishReceiptSchema>;
export type CompilerFinishIdentity = Omit<z.infer<typeof identitySchema>, "pipelineVersion" | "requirementAttempts">;
const archivedFinishSchema = z.object({ receipt: compilerFinishReceiptSchema, reason: z.string().trim().min(1), archivedAt: z.string().datetime() }).strict();

/** Only a dedicated source review has no proposal or unrelated metadata writes to replay. */
export function isPureRoleReviewFinish(receipt: CompilerFinishReceipt): boolean {
  const identity = receipt.identity;
  return identity.batchId.startsWith(`role-roster-${identity.sourceId}-`) && identity.input.outcome === "complete"
    && identity.metadata.roleReview?.runId === identity.batchId && Object.keys(identity.metadata).length === 1
    && identity.dependencies.length === 0 && !identity.requirementScope && !identity.requirementAttempts && !identity.input.target_reviews?.length;
}

export function finishHostError(reason: string): Error {
  if (reason.startsWith("Error: Compiler finish requires host review:")) return new Error(reason.slice(7));
  if (reason.startsWith("Compiler finish requires host review:")) return new Error(reason);
  return new Error(`Compiler finish requires host review: ${reason}. Stop model retries and preserve the receipt and drafts. The host may replay only the original verified finish; changed input or dependencies require inspection.`);
}

/** One host-validated finish intent; all users hold the workspace compiler lock. */
export class CompilerFinishReceipts {
  constructor(private readonly root: string, readonly sourceId: string, readonly batchId: string) {}
  private directory() { return path.join(worldStorageRoot(this.root), "compiler", "finish-receipts", idSchema.parse(this.sourceId)); }
  private file() { return path.join(this.directory(), `${contentHash(idSchema.parse(this.batchId))}.json`); }
  async read(): Promise<CompilerFinishReceipt | undefined> {
    try {
      const receipt = compilerFinishReceiptSchema.parse(JSON.parse(await fs.readFile(this.file(), "utf8")));
      if (receipt.identity.sourceId !== this.sourceId || receipt.identity.batchId !== this.batchId) throw new Error("finish scope mismatch");
      return receipt;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw finishHostError(String(error)); }
  }
  private async write(receipt: CompilerFinishReceipt) {
    const file = this.file(), temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(temporary, JSON.stringify(compilerFinishReceiptSchema.parse(receipt), null, 2) + "\n", { mode: 0o600 });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async dependencies(groups: Partial<Record<Dependency["store"], readonly string[]>>): Promise<Dependency[]> {
    const result: Dependency[] = [];
    for (const [store, ids] of Object.entries(groups) as Array<[Dependency["store"], readonly string[]]>) {
      for (const proposalId of [...ids].sort()) result.push({ store, proposalId, hash: contentHash(await this.readDependency(store, proposalId)) });
    }
    return result.sort((a, b) => `${a.store}:${a.proposalId}`.localeCompare(`${b.store}:${b.proposalId}`));
  }
  private async readDependency(store: Dependency["store"], id: string): Promise<unknown> {
    const reader = store === "world" ? (status: "pending" | "accepted") => new ProposalStore(this.root).readEnvelope(status, id)
      : (status: "pending" | "accepted") => {
          const sourceStore = store === "annotation" ? new SourceAnnotationStore(this.root)
            : store === "entity-resolution" ? new EntityResolutionStore(this.root)
              : store === "event-resolution" ? new EventResolutionStore(this.root) : new SourceAccountingStore(this.root);
          return sourceStore.readProposal(this.sourceId, status, id);
        };
    try { return await reader("pending"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return reader("accepted"); }
  }
  async verify(receipt: CompilerFinishReceipt): Promise<void> {
    try {
      compilerFinishReceiptSchema.parse(receipt);
      const identity = receipt.identity;
      if (identity.pipelineVersion !== COMPILER_PIPELINE_VERSION) throw new Error("finish compiler pipeline changed");
      if (identity.sourceId !== this.sourceId || identity.batchId !== this.batchId) throw new Error("finish scope mismatch");
      if (identity.upstreamRepairIntent) {
        const { verifyUpstreamRepairFinish } = await import("./upstream-repair-finish.js");
        await verifyUpstreamRepairFinish(this.root, this.sourceId, identity.upstreamRepairIntent.planHash, identity.upstreamRepairIntent, receipt.state === "completed", identity.batchId);
      }
      if (identity.requirementScope) {
        const { reconciliationReviewScope } = await import("./reconcile-world.js");
        const current = await reconciliationReviewScope(this.root, this.sourceId, this.batchId);
        if (current?.planHash !== identity.requirementScope.planHash || contentHash(current.requirements) !== contentHash(identity.requirementScope.requirements) || contentHash(current.coreRoleScope ?? null) !== contentHash(identity.requirementScope.coreRoleScope ?? null)) throw new Error("finish requirement definition or plan changed");
      }
      if (identity.requirementScope?.coreRoleScope) {
        const { RequirementLedger } = await import("./requirement-ledger.js");
        const definition = (await new RequirementLedger(this.root, this.sourceId).coreRoleDefinitionHistory()).at(-1);
        if (!definition || definition.sourceSha256 !== identity.sourceSha256 || contentHash(coreRoleAttemptScope(definition)) !== contentHash(identity.requirementScope.coreRoleScope)) throw new Error("independent requirement revision changed; preserve this attempt and stop model retries");
        if (contentHash(await this.attempts(identity)) !== contentHash(identity.requirementAttempts)) throw new Error("finish attempt proposal links changed");
      }
      const source = await WorkspaceStore.openReadOnly(this.root).getSource(this.sourceId);
      if (source?.contentSha256 !== identity.sourceSha256) throw new Error("finish source changed");
      const bytes = await new SourceMaterialStore().read(source);
      if (!bytes || crypto.createHash("sha256").update(bytes).digest("hex") !== identity.sourceSha256) throw new Error("finish source bytes changed");
      for (const segment of identity.segments) {
        if (segment.sourceId !== this.sourceId || crypto.createHash("sha256").update(bytes.subarray(segment.startByte, segment.endByte)).digest("hex") !== segment.textSha256) throw new Error(`finish source segment ${segment.id} changed`);
      }
      for (const dependency of identity.dependencies) if (contentHash(await this.readDependency(dependency.store, dependency.proposalId)) !== dependency.hash) throw new Error(`finish dependency ${dependency.store}:${dependency.proposalId} changed`);
    } catch (error) { throw finishHostError(String(error)); }
  }
  private async attempts(identity: CompilerFinishIdentity) {
    const scope = identity.requirementScope!.coreRoleScope!;
    const reports = coreRoleAttemptReports({ batchId: identity.batchId, scope, requirements: identity.requirementScope!.requirements, reviews: identity.input.target_reviews ?? [] });
    const proposals = [];
    for (const ref of identity.dependencies.filter(dependency => dependency.store === "world")) {
      const envelope = await this.readDependency(ref.store, ref.proposalId) as { kind: string; payload: Record<string, unknown> };
      proposals.push({ ref, kind: envelope.kind, payload: envelope.payload });
    }
    return linkCoreRoleAttemptProposals(reports, identity.requirementScope!.requirements, proposals);
  }
  async prepare(identityInput: CompilerFinishIdentity) {
    const identity = identitySchema.parse({ ...identityInput, pipelineVersion: COMPILER_PIPELINE_VERSION,
      ...(identityInput.requirementScope?.coreRoleScope ? { requirementAttempts: await this.attempts(identityInput) } : {}),
    }), fingerprint = contentHash(identity);
    const existing = await this.read();
    if (existing && existing.fingerprint !== fingerprint) throw finishHostError("original finish input, metadata or proposal set changed");
    const receipt = existing ?? compilerFinishReceiptSchema.parse({ identity, fingerprint, state: "prepared", preparedAt: new Date().toISOString() });
    await this.verify(receipt);
    if (!existing) await this.write(receipt);
    return receipt;
  }
  async complete(fingerprint: string) {
    const receipt = await this.read();
    if (!receipt || receipt.fingerprint !== fingerprint) throw finishHostError("completion has no matching prepared intent");
    await this.verify(receipt);
    const completed = receipt.state === "completed" ? receipt : { ...receipt, state: "completed" as const, completedAt: new Date().toISOString() };
    if (completed.identity.upstreamRepairIntent) await this.verify(completed);
    if (receipt.state !== "completed") await this.write(completed);
    await this.retainRequirementAttempts(completed);
  }
  async assertCompleted() {
    const receipt = await this.read();
    if (receipt?.state !== "completed") throw finishHostError("checkpoint requires a completed durable finish receipt");
    await this.verify(receipt);
    await this.retainRequirementAttempts(receipt);
  }
  async retainRequirementAttempts(receipt: CompilerFinishReceipt) {
    if (!receipt.identity.requirementAttempts) return;
    try {
      const { RequirementLedger } = await import("./requirement-ledger.js");
      await new RequirementLedger(this.root, this.sourceId).recordCoreRoleAttempts(receipt);
    } catch (error) { throw finishHostError(String(error)); }
  }
  /** Explicit reparse/restore retirement retains the original intent and reason. */
  async archive(reason: string) {
    if (!reason.trim()) throw new Error("Finish retirement needs an audit reason");
    const receipt = await this.read();
    if (!receipt) return;
    const directory = path.join(this.directory(), "history", contentHash(this.batchId));
    const file = path.join(directory, `${receipt.fingerprint}-${contentHash(reason)}.json`);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const prior = JSON.parse(await fs.readFile(file, "utf8"));
      if (contentHash(prior.receipt) !== contentHash(receipt) || prior.reason !== reason) throw finishHostError("finish archive conflict");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ receipt, reason, archivedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }); }
    }
    await fs.rm(this.file());
  }
  static async archiveSource(root: string, sourceId: string, reason: string, batchIds?: readonly string[]) {
    for (const receipt of await this.list(root, sourceId)) if (!batchIds || batchIds.includes(receipt.identity.batchId)) {
      await new CompilerFinishReceipts(root, sourceId, receipt.identity.batchId).archive(reason);
    }
  }
  static async list(root: string, sourceId: string): Promise<CompilerFinishReceipt[]> {
    const directory = path.join(worldStorageRoot(root), "compiler", "finish-receipts", idSchema.parse(sourceId));
    let names: string[];
    try { names = await fs.readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const result: CompilerFinishReceipt[] = [];
    for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
      const raw = compilerFinishReceiptSchema.parse(JSON.parse(await fs.readFile(path.join(directory, name), "utf8")));
      const receipt = await new CompilerFinishReceipts(root, sourceId, raw.identity.batchId).read();
      if (!receipt || name !== `${contentHash(receipt.identity.batchId)}.json`) throw finishHostError("invalid finish receipt filename");
      result.push(receipt);
    }
    return result;
  }

  /** Historical review evidence, never authorization to replay retired writes. */
  static async listRetained(root: string, sourceId: string): Promise<Array<{ receipt: CompilerFinishReceipt; archived: boolean }>> {
    const current = await this.list(root, sourceId);
    const result = new Map(current.map(receipt => [receipt.fingerprint, { receipt, archived: false }]));
    const directory = path.join(worldStorageRoot(root), "compiler", "finish-receipts", idSchema.parse(sourceId), "history");
    let batches: string[];
    try { batches = await fs.readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [...result.values()]; throw error; }
    for (const batchHash of batches.sort()) {
      if (!/^[a-f0-9]{64}$/.test(batchHash)) throw finishHostError("invalid retained finish directory");
      for (const name of (await fs.readdir(path.join(directory, batchHash))).filter(name => name.endsWith(".json")).sort()) {
        const archived = archivedFinishSchema.parse(JSON.parse(await fs.readFile(path.join(directory, batchHash, name), "utf8")));
        const receipt = archived.receipt;
        if (receipt.identity.sourceId !== sourceId || contentHash(receipt.identity.batchId) !== batchHash || name !== `${receipt.fingerprint}-${contentHash(archived.reason)}.json`) throw finishHostError("retained finish source, identity or filename mismatch");
        const prior = result.get(receipt.fingerprint);
        if (prior && (prior.receipt.preparedAt !== receipt.preparedAt || (prior.receipt.completedAt && receipt.completedAt && prior.receipt.completedAt !== receipt.completedAt))) throw finishHostError("conflicting retained finish lifecycle");
        if (!prior || (prior.archived && receipt.state === "completed")) result.set(receipt.fingerprint, { receipt, archived: true });
      }
    }
    return [...result.values()].sort((a, b) => a.receipt.fingerprint.localeCompare(b.receipt.fingerprint));
  }

  /** Host checkpoint restoration may resume only a pure role finish that was active when frozen. */
  static async restoreActiveRoleReview(root: string, sourceId: string, input: CompilerFinishReceipt): Promise<void> {
    const receipt = compilerFinishReceiptSchema.parse(input);
    if (receipt.identity.sourceId !== sourceId || receipt.state !== "prepared" || !isPureRoleReviewFinish(receipt)) throw finishHostError("restored role finish is outside the source-review-only recovery boundary");
    const store = new CompilerFinishReceipts(root, sourceId, receipt.identity.batchId), existing = await store.read();
    if (existing) {
      if (existing.fingerprint !== receipt.fingerprint || existing.preparedAt !== receipt.preparedAt) throw finishHostError("restored role finish conflicts with the active intent");
      return;
    }
    await store.verify(receipt);
    await store.write(receipt);
  }
  /** Restore only historical accountability, without creating an active finish. */
  static async retainSnapshot(root: string, sourceId: string, receiptInput: CompilerFinishReceipt): Promise<void> {
    const receipt = compilerFinishReceiptSchema.parse(receiptInput);
    if (receipt.identity.sourceId !== sourceId) throw finishHostError("imported finish source mismatch");
    const existing = (await this.listRetained(root, sourceId)).find(item => item.receipt.fingerprint === receipt.fingerprint);
    if (existing) {
      if (contentHash(existing.receipt) !== contentHash(receipt)) throw finishHostError("imported finish conflicts with retained lifecycle");
      return;
    }
    const reason = "Imported frozen reconciliation accountability; replay is not authorized";
    const directory = path.join(worldStorageRoot(root), "compiler", "finish-receipts", sourceId, "history", contentHash(receipt.identity.batchId));
    const file = path.join(directory, `${receipt.fingerprint}-${contentHash(reason)}.json`), temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(temporary, JSON.stringify({ receipt, reason, archivedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
}
