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
export const compilerFinishInputSchema = z.object({
  outcome: z.enum(["complete", "no-artifacts"]),
  reviewed_segments: z.array(z.object({ segment_id: idSchema, disposition: z.enum(["proposed", "no-artifacts"]), summary: z.string().min(1).max(500) }).strict()),
  summary: z.string().min(1).max(2_000),
}).strict();
const dependencySchema = z.object({ store: z.enum(["world", "annotation", "entity-resolution", "event-resolution", "accounting"]), proposalId: idSchema, hash: hashSchema }).strict();
type Dependency = z.infer<typeof dependencySchema>;
const identitySchema = z.object({
  version: z.literal(1), pipelineVersion: z.number().int().positive(), sourceId: idSchema, sourceSha256: hashSchema, batchId: idSchema,
  input: compilerFinishInputSchema, segments: z.array(sourceSegmentSchema), dependencies: z.array(dependencySchema),
  metadata: z.object({ title: sourceTitleProposalSchema.optional(), chapterSplit: chapterSplitPlanSchema.optional(), roleReview: roleRosterReviewSchema.optional() }).strict(),
}).strict();
export const compilerFinishReceiptSchema = z.object({
  identity: identitySchema, fingerprint: hashSchema, state: z.enum(["prepared", "completed"]),
  preparedAt: z.string().datetime(), completedAt: z.string().datetime().optional(),
}).strict().superRefine((receipt, ctx) => {
  if (contentHash(receipt.identity) !== receipt.fingerprint) ctx.addIssue({ code: "custom", message: "finish fingerprint mismatch" });
  if ((receipt.state === "completed") !== Boolean(receipt.completedAt)) ctx.addIssue({ code: "custom", message: "finish completion timestamp mismatch" });
});
export type CompilerFinishReceipt = z.infer<typeof compilerFinishReceiptSchema>;
export type CompilerFinishIdentity = Omit<z.infer<typeof identitySchema>, "pipelineVersion">;

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
  async prepare(identityInput: CompilerFinishIdentity) {
    const identity = identitySchema.parse({ ...identityInput, pipelineVersion: COMPILER_PIPELINE_VERSION }), fingerprint = contentHash(identity);
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
    if (receipt.state !== "completed") await this.write({ ...receipt, state: "completed", completedAt: new Date().toISOString() });
  }
  async assertCompleted() {
    const receipt = await this.read();
    if (receipt?.state !== "completed") throw finishHostError("checkpoint requires a completed durable finish receipt");
    await this.verify(receipt);
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
}
