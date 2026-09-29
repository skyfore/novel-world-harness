import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { worldStorageRoot } from "../world/paths.js";
import type { RoleRoster } from "./role-roster.js";
import { CompilerProposalObligations } from "./proposal-obligations.js";

export const ROLE_REVIEW_WORK_VERSION = 1;
export const ROLE_SOURCE_WORK_TOOL = "propose_role_source_review";
export const ROLE_AUDIT_WORK_TOOL = "propose_role_review_audit";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const spanSchema = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict();
export const roleReviewPlanSchema = z.object({
  version: z.literal(1), sourceId: z.string(), sourceHash: hash, subjectHash: hash,
  reviewRevisionId: z.string().optional(), batchId: z.string(), structureHash: hash,
  spans: z.array(spanSchema).min(1), legacyDraftHashes: z.array(hash),
}).strict();
export type RoleReviewPlan = z.infer<typeof roleReviewPlanSchema>;
const findingSchema = z.object({ name: z.string().trim().min(1).max(200),
  observation: z.string().trim().min(1).max(1200), unitIds: z.array(z.string()).min(1).max(24) }).strict();
export const roleSourceWorkSchema = z.object({
  summary: z.string().trim().min(1).max(1600), findings: z.array(findingSchema).max(64),
  openQuestions: z.array(z.string().trim().min(1).max(600)).max(24),
}).strict().refine(value => Buffer.byteLength(JSON.stringify(value)) <= 8000, "Source work notes must fit 8000 UTF-8 bytes; keep precise evidence refs and open questions, not copied source passages");
export const roleAuditWorkSchema = z.object({
  rationale: z.string().trim().min(1).max(2000),
  missingMajorCharacters: z.array(z.object({ name: z.string().trim().min(1).max(200),
    rationale: z.string().trim().min(1).max(1200), basisUnitIds: z.array(z.string()).min(1).max(24) }).strict()).max(64),
  unresolved: z.array(z.string().trim().min(1).max(600)).max(24),
}).strict();
export const boundedRoleReviewEvidenceSchema = z.object({
  version: z.literal(1), plan: roleReviewPlanSchema,
  sourceWork: z.array(roleSourceWorkSchema), auditWork: z.array(roleAuditWorkSchema),
  entriesHash: hash,
}).strict().superRefine((value, ctx) => {
  if (value.sourceWork.length !== value.plan.spans.length || value.auditWork.length !== value.plan.spans.length
    || value.auditWork.some(work => work.unresolved.length)) ctx.addIssue({ code: "custom", message: "Incomplete bounded source/audit work" });
  for (const [index, span] of value.plan.spans.entries()) if (span.start !== (index ? value.plan.spans[index - 1]!.end : 0) || span.end <= span.start) ctx.addIssue({ code: "custom", message: "Non-contiguous source work" });
});
export type RoleSourceWork = z.infer<typeof roleSourceWorkSchema>;
export type RoleAuditWork = z.infer<typeof roleAuditWorkSchema>;
export const roleWorkStop = (reason: string) => new Error(`ROLE_REVIEW_WORK_HOST_REQUIRED: ${reason}. Stop; preserve the original plan, batch, drafts and attempts for host review. Do not retry, rotate IDs or mark the batch complete.`);

/** Continuous, UTF-8-safe core spans; no semantic claims are made by splitting. */
export function roleReviewSpans(bytes: Buffer, maxBytes = 6000) {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) throw new Error("Invalid role review span size");
  const spans: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + maxBytes, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    // Prefer a paragraph boundary, but retain every byte and split oversized units.
    const newline = bytes.lastIndexOf(10, end - 1);
    if (newline >= start + maxBytes / 2) end = newline + 1;
    spans.push({ start, end }); start = end;
  }
  return spans;
}
function directory(root: string, sourceId: string) {
  return path.join(worldStorageRoot(root), "compiler", "role-review-work", "v1", contentHash(sourceId));
}
export class RoleReviewWorkStore {
  readonly journal: CompilerProposalObligations;
  constructor(readonly root: string, readonly plan: RoleReviewPlan) {
    roleReviewPlanSchema.parse(plan);
    this.journal = new CompilerProposalObligations(root, plan.sourceId, plan.batchId);
  }
  get planHash() { return contentHash(this.plan); }
  static async plans(root: string, sourceId: string): Promise<RoleReviewPlan[]> {
    const dir = directory(root, sourceId);
    const names = await fs.readdir(dir).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
    return Promise.all(names.filter(name => name.endsWith(".json")).map(async name => {
      const record = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
      const plan = roleReviewPlanSchema.parse(record.plan);
      if (record.hash !== contentHash(plan) || plan.sourceId !== sourceId || name !== `${contentHash(plan.batchId)}.json`) throw roleWorkStop("plan integrity mismatch");
      return plan;
    }));
  }
  static async open(root: string, plan: RoleReviewPlan) {
    const existing = (await this.plans(root, plan.sourceId)).find(p => p.batchId === plan.batchId);
    if (existing && contentHash(existing) !== contentHash(plan)) throw roleWorkStop("plan changed");
    if (!existing) {
      await fs.mkdir(directory(root, plan.sourceId), { recursive: true });
      await fs.writeFile(path.join(directory(root, plan.sourceId), `${contentHash(plan.batchId)}.json`),
        JSON.stringify({ hash: contentHash(plan), plan }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    }
    return new RoleReviewWorkStore(root, plan);
  }
  assertScope(roster: RoleRoster, structureHash?: string, sourceBytes?: number) {
    if (roster.sourceId !== this.plan.sourceId || roster.sourceSha256 !== this.plan.sourceHash || roster.subjectHash !== this.plan.subjectHash
      || roster.reviewRevisionId !== this.plan.reviewRevisionId || (structureHash && structureHash !== this.plan.structureHash) || (sourceBytes !== undefined && this.plan.spans.at(-1)?.end !== sourceBytes)) throw roleWorkStop("source/roster/structure revision changed");
  }
  workId(kind: "source" | "audit", page: number) {
    if (!Number.isInteger(page) || !this.plan.spans[page]) throw roleWorkStop("unknown host work index");
    return `role-${kind}-${this.planHash.slice(0, 20)}-${page}`;
  }
  read(kind: "source", page: number): RoleSourceWork | undefined;
  read(kind: "audit", page: number): RoleAuditWork | undefined;
  read(kind: "source" | "audit", page: number): RoleSourceWork | RoleAuditWork | undefined {
    const tool = kind === "source" ? ROLE_SOURCE_WORK_TOOL : ROLE_AUDIT_WORK_TOOL;
    const latest = this.journal.history(tool, this.workId(kind, page)).at(-1);
    if (!latest || latest.status !== "succeeded") return undefined;
    const input = latest.input as { planHash: string; payload: unknown; entriesHash?: string };
    if (kind === "audit" && input.entriesHash !== this.entriesHash()) throw roleWorkStop("staged entries changed after audit");
    if (latest.inputHash !== CompilerProposalObligations.identity(tool, latest.input).inputHash || input.planHash !== this.planHash) throw roleWorkStop("work receipt belongs to another plan");
    return kind === "source" ? roleSourceWorkSchema.parse(input.payload) : roleAuditWorkSchema.parse(input.payload);
  }
  entriesHash() { return contentHash(this.journal.latestAttempts("propose_role_roster_entry").map(a => ({ id: a.proposalId, hash: a.inputHash, status: a.status })).sort((a, b) => a.id.localeCompare(b.id))); }
  sourceComplete() { return this.plan.spans.every((_, page) => Boolean(this.read("source", page))); }
  auditComplete() { return this.plan.spans.every((_, page) => this.read("audit", page)?.unresolved.length === 0); }
  missingMajorCharacters() { return this.plan.spans.flatMap((_, page) => this.read("audit", page)?.missingMajorCharacters ?? []); }
  /** A receipt IS a validated journal success, avoiding a second mutable done flag. */
  async submit(kind: "source" | "audit", page: number, raw: unknown, validate: (payload: RoleSourceWork | RoleAuditWork) => void) {
    this.journal.assertModelRecoveryAllowed();
    if (this.read(kind as "source", page)) throw roleWorkStop("work is single-use and already settled");
    const tool = kind === "source" ? ROLE_SOURCE_WORK_TOOL : ROLE_AUDIT_WORK_TOOL;
    const input = { proposal_id: this.workId(kind, page), planHash: this.planHash, payload: raw, ...(kind === "audit" ? { entriesHash: this.entriesHash() } : {}) };
    this.journal.assertRetryAllowed(tool, input);
    const prior = this.journal.history(tool, input.proposal_id).at(-1);
    if (prior?.status === "failed" && prior.inputHash === CompilerProposalObligations.identity(tool, input).inputHash) throw roleWorkStop("unchanged failed work submission");
    this.journal.record(tool, input, "running");
    try {
      const value = kind === "source" ? roleSourceWorkSchema.parse(raw) : roleAuditWorkSchema.parse(raw);
      validate(value);
      this.journal.record(tool, input, "succeeded");
    } catch (error) { this.journal.record(tool, input, "failed", String(error)); throw error; }
  }
  /** Attempts survive zero-proposal exits. New invocations never reset allowance. */
  async beginAttempt(workId: string) {
    const dir = path.join(directory(this.root, this.plan.sourceId), "attempts", contentHash(this.plan.batchId), contentHash(workId));
    await fs.mkdir(dir, { recursive: true });
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await fs.writeFile(path.join(dir, `${attempt}.json`), JSON.stringify({ planHash: this.planHash, workId, at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
        return;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    throw roleWorkStop("work invocation allowance exhausted");
  }
}
