import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { worldStorageRoot } from "../world/paths.js";
import type { RoleRoster } from "./role-roster.js";
import { CompilerProposalObligations } from "./proposal-obligations.js";

import { roleClaimAuditSchema, roleQuestionDispositionSchema, roleDiscoveryDispositionSchema, roleQuestions, roleFindingId, sameIds, type RoleClaimAudit } from "./role-review-verification.js";
export const ROLE_CLAIM_AUDIT_TOOL = "propose_role_claim_audit";
export const ROLE_REVIEW_WORK_VERSION = 1; // Immutable plan storage format; verification evidence is v2.
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
export const ROLE_SOURCE_NOTES_MAX_BYTES = 8000;
export const roleSourceNotesSchema = z.object({
  summary: z.string().trim().min(1).max(1600), findings: z.array(findingSchema).max(64),
  openQuestions: z.array(z.string().trim().min(1).max(600)).max(24),
}).strict();
/** Size is an observation, not an evidence/semantic validity condition. */
export const roleSourceWorkSchema = roleSourceNotesSchema
  .describe("Preserve all findings, exact evidence references and unresolved questions. Prefer concise notes; total UTF-8 JSON size is observed, never a reason to omit responsibilities or reject a supported proposal.");
export const roleAuditWorkSchema = z.object({
  rationale: z.string().trim().min(1).max(2000),
  missingMajorCharacters: z.array(z.object({ name: z.string().trim().min(1).max(200),
    rationale: z.string().trim().min(1).max(1200), basisUnitIds: z.array(z.string()).min(1).max(24) }).strict()).max(64),
  questionDispositions: z.array(roleQuestionDispositionSchema).max(24).optional(),
  discoveryDispositions: z.array(roleDiscoveryDispositionSchema).max(64).optional(),
  atlasRevision: hash.optional(),
  unresolved: z.array(z.string().trim().min(1).max(600)).max(24),
}).strict();
export const boundedRoleReviewEvidenceSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]), plan: roleReviewPlanSchema,
  claimAudits: z.array(roleClaimAuditSchema).optional(),
  sourceWork: z.array(roleSourceWorkSchema), auditWork: z.array(roleAuditWorkSchema),
  entriesHash: hash,
}).strict().superRefine((value, ctx) => {
  if (value.sourceWork.length !== value.plan.spans.length || value.auditWork.length !== value.plan.spans.length
    || value.auditWork.some(work => work.unresolved.length)) ctx.addIssue({ code: "custom", message: "Incomplete bounded source/audit work" });
  if (value.version === 2) {
    if (!value.claimAudits?.length || value.claimAudits.some(a => a.verdict !== "supported")) ctx.addIssue({ code: "custom", message: "Missing or blocked claim audits" });
    const planHash = contentHash(value.plan), atlasRevision = contentHash(value.sourceWork);
    for (const [page, work] of value.auditWork.entries()) {
      const note = value.sourceWork[page];
      if (!note || work.atlasRevision !== atlasRevision || !work.questionDispositions || !work.discoveryDispositions
        || !sameIds(work.questionDispositions.map(q => q.questionId), roleQuestions(planHash, page, note).map(q => q.questionId))
        || work.questionDispositions.some(q => q.status !== "resolved")
        || !sameIds(work.discoveryDispositions.map(d => d.findingId), note.findings.map((_, i) => roleFindingId(planHash, page, i)))
        || work.discoveryDispositions.some(d => d.disposition === "blocked")) ctx.addIssue({ code: "custom", message: "Unclosed source questions/discoveries or stale atlas" });
    }
    if (value.claimAudits?.some(a => a.atlasRevision !== atlasRevision)) ctx.addIssue({ code: "custom", message: "Stale claim audit atlas" });
  }
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
    return `role-${kind}-${kind === "audit" ? "v2-" : ""}${this.planHash.slice(0, 20)}-${page}`;
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
  atlasRevision() { return contentHash(this.plan.spans.map((_, page) => this.read("source", page))); }
  questions(page: number) { const note = this.read("source", page); return note ? roleQuestions(this.planHash, page, note) : []; }
  claimWorkId(candidateId: string) { return `role-claim-v2-${contentHash({ plan: this.planHash, candidateId })}`; }
  claimAudit(candidateId: string): RoleClaimAudit | undefined {
    const record = this.journal.history(ROLE_CLAIM_AUDIT_TOOL, this.claimWorkId(candidateId)).at(-1);
    if (!record || record.status !== "succeeded") return undefined;
    const input = record.input as {planHash: string; payload: unknown};
    if (input.planHash !== this.planHash || record.inputHash !== CompilerProposalObligations.identity(ROLE_CLAIM_AUDIT_TOOL, record.input).inputHash) throw roleWorkStop("claim audit integrity mismatch");
    const audit = roleClaimAuditSchema.parse(input.payload);
    const entry = this.stagedEntries().find(e => e.candidateId === candidateId);
    if (audit.candidateId !== candidateId || audit.claimRevision !== contentHash(entry ?? null) || audit.atlasRevision !== this.atlasRevision()) throw roleWorkStop("claim or atlas changed after audit");
    return audit;
  }
  stagedEntries() { return this.journal.latestAttempts("propose_role_roster_entry").filter(a => a.status === "succeeded").map(a => (a.input as {entry: {candidateId: string}}).entry); }
  claimAudits() { return this.stagedEntries().flatMap(e => { const audit = this.claimAudit(e.candidateId); return audit ? [audit] : []; }); }
  /** Read-only version accounting. Old receipts remain inspectable without
   * being accepted by the strict current-revision accessors or finish gates. */
  reviewFreshness() {
    const atlasRevision = this.atlasRevision(), entriesHash = this.entriesHash();
    const retained = (tool: string, workId: string) => {
      const record = this.journal.history(tool, workId).at(-1);
      if (!record || record.status !== "succeeded") return;
      const input = record.input as { planHash: string; payload: unknown; entriesHash?: string };
      if (input.planHash !== this.planHash || record.inputHash !== CompilerProposalObligations.identity(tool, input).inputHash) {
        throw roleWorkStop("review receipt integrity mismatch");
      }
      return { input, receiptHash: contentHash(record) };
    };
    const sourceAudits = this.plan.spans.flatMap((_, page) => {
      const workId = this.workId("audit", page), record = retained(ROLE_AUDIT_WORK_TOOL, workId);
      if (!record) return [];
      const audit = roleAuditWorkSchema.parse(record.input.payload);
      return [{ workId, page, receiptHash: record.receiptHash, audit,
        current: audit.atlasRevision === atlasRevision && record.input.entriesHash === entriesHash }];
    });
    const claimAudits = this.stagedEntries().flatMap(entry => {
      const workId = this.claimWorkId(entry.candidateId), record = retained(ROLE_CLAIM_AUDIT_TOOL, workId);
      if (!record) return [];
      const audit = roleClaimAuditSchema.parse(record.input.payload);
      if (audit.candidateId !== entry.candidateId) throw roleWorkStop("claim audit candidate identity changed");
      return [{ workId, candidateId: entry.candidateId, receiptHash: record.receiptHash, audit,
        current: audit.atlasRevision === atlasRevision && audit.claimRevision === contentHash(entry) }];
    });
    return { atlasRevision, entriesHash, sourceAudits, claimAudits };
  }
  auditComplete() {
    return this.sourceComplete() && this.stagedEntries().length > 0 && this.stagedEntries().every(e => this.claimAudit(e.candidateId)?.verdict === "supported")
      && this.plan.spans.every((_, page) => {
        const work = this.read("audit", page), note = this.read("source", page)!;
        return work?.unresolved.length === 0 && work.atlasRevision === this.atlasRevision()
          && Boolean(work.questionDispositions && sameIds(work.questionDispositions.map(q => q.questionId), this.questions(page).map(q => q.questionId)) && work.questionDispositions.every(q => q.status === "resolved"))
          && Boolean(work.discoveryDispositions && sameIds(work.discoveryDispositions.map(d => d.findingId), note.findings.map((_, i) => roleFindingId(this.planHash, page, i))) && work.discoveryDispositions.every(d => d.disposition !== "blocked"));
      });
  }
  async assertQuestionLedger() {
    const { RequirementLedger } = await import("./requirement-ledger.js");
    const ledger = new RequirementLedger(this.root, this.plan.sourceId);
    await ledger.assertRoleEvidenceNeedsResolved(this.planHash);
    const history = await ledger.history();
    for (let page = 0; page < this.plan.spans.length; page++) {
      const audit = this.read("audit", page);
      for (const question of this.questions(page)) {
        if (!history.some(r => r.payload.kind === "role-review-question" && contentHash(r.payload.question) === contentHash(question))
          || !history.some(r => r.payload.kind === "role-review-question-disposition" && r.payload.planHash === this.planHash && r.payload.auditRef === contentHash(audit)
            && contentHash(r.payload.disposition) === contentHash(audit?.questionDispositions?.find(q => q.questionId === question.questionId) ?? null))) throw roleWorkStop("question ledger publication incomplete; recover the original bounded workflow before assembly");
      }
    }
  }
  async submitClaim(raw: unknown, candidateId: string, validate: (value: RoleClaimAudit) => void) {
    this.journal.assertModelRecoveryAllowed();
    if (this.claimAudit(candidateId)) throw roleWorkStop("claim audit already settled");
    const input = { proposal_id: this.claimWorkId(candidateId), planHash: this.planHash, payload: raw };
    this.journal.assertRetryAllowed(ROLE_CLAIM_AUDIT_TOOL, input);
    const prior = this.journal.history(ROLE_CLAIM_AUDIT_TOOL, input.proposal_id).at(-1);
    if (prior?.status === "failed" && prior.inputHash === CompilerProposalObligations.identity(ROLE_CLAIM_AUDIT_TOOL, input).inputHash) throw roleWorkStop("unchanged failed claim audit");
    this.journal.record(ROLE_CLAIM_AUDIT_TOOL, input, "running");
    try { const value = roleClaimAuditSchema.parse(raw); validate(value); this.journal.record(ROLE_CLAIM_AUDIT_TOOL, input, "succeeded"); }
    catch (error) { this.journal.record(ROLE_CLAIM_AUDIT_TOOL, input, "failed", String(error)); throw error; }
  }
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
  async assertUnstarted(workId: string) {
    const dir = path.join(directory(this.root, this.plan.sourceId), "attempts", contentHash(this.plan.batchId), contentHash(workId));
    const files = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    if (files.length) throw roleWorkStop('work already started; preserve its original task prompt and claims, do not opt into a different draft workflow');
  }
  async beginAttempt(workId: string) {
    const dir = path.join(directory(this.root, this.plan.sourceId), "attempts", contentHash(this.plan.batchId), contentHash(workId));
    await fs.mkdir(dir, { recursive: true });
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await fs.writeFile(path.join(dir, `${attempt}.json`), JSON.stringify({ planHash: this.planHash, workId, at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
        return attempt;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    throw roleWorkStop("work invocation allowance exhausted");
  }
}
