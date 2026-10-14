import { roleAuditWorkSchema, sourceAuditProofSchema, type RoleAuditWork } from "./role-source-audit-model.js";
import { sourceAuditRepairWorkId, sourceAuditCheckWorkId } from "./role-source-audit-model.js";
import { sourceAuditAuthorities, sourceAuditProofs, assertSourceAuditHistory } from "./role-source-audit-repair.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ROLE_CLAIM_CONTRACT, ROLE_AUDIT_CONTRACT_AUTHORITY_TOOL, roleAuditContractAuthoritySchema,
  roleAuditContractProofSchema, roleContractAuditWorkId, type RoleAuditContractAuthority } from "./role-audit-contract.js";
import { contentHash } from "../world/canonical.js";
import { worldStorageRoot } from "../world/paths.js";
import type { RoleRoster } from "./role-roster.js";
import { roleRosterEntrySchema } from "./role-roster-entry.js";
import { roleWorkAllowanceSchema } from "./role-work-allowance.js";
import { CompilerProposalObligations } from "./proposal-obligations.js";
import { immutableClone } from "../util/immutable.js";
import { ROLE_JUDGMENT_AUTHORITY_TOOL, ROLE_JUDGMENT_REVISION_TOOL, roleJudgmentAuthoritySchema,
  roleJudgmentRevisionInputSchema, roleJudgmentRevisionProofSchema, roleJudgmentWorkId, roleSuccessorAuditWorkId,
  type RoleJudgmentRevisionProof, type RoleJudgmentAuthority } from "./role-judgment-revision.js";

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
  migration: z.object({
    revisionId: z.string(), priorBatchId: z.string(), priorPlanHash: hash,
    candidateIds: z.array(z.string()),
    sourceWork: z.array(z.lazy(() => roleSourceWorkSchema).nullable()),
    entries: z.array(z.lazy(() => roleRosterEntrySchema)),
    allowances: z.array(roleWorkAllowanceSchema),
  }).strict().optional(),
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
export const boundedRoleReviewEvidenceSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]), plan: roleReviewPlanSchema,
  claimAudits: z.array(roleClaimAuditSchema).optional(),
  judgmentRevisions: z.array(roleJudgmentRevisionProofSchema).optional(),
  auditContractRevisions: z.array(roleAuditContractProofSchema).optional(),
  sourceAuditRevisions: z.array(sourceAuditProofSchema).optional(),
  sourceWork: z.array(roleSourceWorkSchema), auditWork: z.array(roleAuditWorkSchema),
  entriesHash: hash,
}).strict().superRefine((value, ctx) => {
  if (value.sourceWork.length !== value.plan.spans.length || value.auditWork.length !== value.plan.spans.length
    || value.auditWork.some(work => work.unresolved.length)) ctx.addIssue({ code: "custom", message: "Incomplete bounded source/audit work" });
  if (value.version === 1 && (value.judgmentRevisions?.length || value.auditContractRevisions?.length || value.sourceAuditRevisions?.length)) ctx.addIssue({code: "custom", message: "Versioned revision proof requires verification evidence v2"});
  if (value.version === 2) {
    if (!value.claimAudits?.length || value.claimAudits.some(a => a.verdict !== "supported")) ctx.addIssue({ code: "custom", message: "Missing or blocked claim audits" });
    const planHash = contentHash(value.plan), atlasRevision = contentHash(value.sourceWork);
    const sourceRepairs = value.sourceAuditRevisions ?? [];
    if (new Set(sourceRepairs.map(p => p.authority.page)).size !== sourceRepairs.length
      || sourceRepairs.some(p => p.authority.planHash !== planHash || p.authority.sourceHash !== value.plan.sourceHash
        || p.authority.sourceId !== value.plan.sourceId || p.authority.batchId !== value.plan.batchId
        || p.authority.subjectHash !== value.plan.subjectHash || p.authority.structureHash !== value.plan.structureHash
        || p.authority.atlasRevision !== atlasRevision || p.authority.entriesContentHash !== value.entriesHash
        || p.authority.claimAuditsHash !== contentHash(value.claimAudits)
        || contentHash(p.proposal) !== contentHash(value.auditWork[p.authority.page] ?? null))) {
      ctx.addIssue({ code: "custom", message: "Source audit repair lacks current dependencies and independent verification" });
    }
    for (const [page, work] of value.auditWork.entries()) {
      const note = value.sourceWork[page];
      if (!note || work.atlasRevision !== atlasRevision || !work.questionDispositions || !work.discoveryDispositions
        || !sameIds(work.questionDispositions.map(q => q.questionId), roleQuestions(planHash, page, note).map(q => q.questionId))
        || work.questionDispositions.some(q => q.status !== "resolved")
        || !sameIds(work.discoveryDispositions.map(d => d.findingId), note.findings.map((_, i) => roleFindingId(planHash, page, i)))
        || work.discoveryDispositions.some(d => d.disposition === "blocked")) ctx.addIssue({ code: "custom", message: "Unclosed source questions/discoveries or stale atlas" });
    }
    if (value.claimAudits?.some(a => a.atlasRevision !== atlasRevision)) ctx.addIssue({ code: "custom", message: "Stale claim audit atlas" });
    const contracts = value.auditContractRevisions ?? [];
    if (new Set(contracts.map(r => r.authority.entry.candidateId)).size !== contracts.length
      || contracts.some(({authority: a, audit}) => a.planHash !== planHash || a.sourceHash !== value.plan.sourceHash
        || a.sourceId !== value.plan.sourceId || a.batchId !== value.plan.batchId || a.subjectHash !== value.plan.subjectHash
        || a.structureHash !== value.plan.structureHash || a.predecessorAudit.atlasRevision !== atlasRevision
        || !value.claimAudits?.some(current => contentHash(current) === contentHash(audit)))) {
      ctx.addIssue({code: "custom", message: "Audit contract revision lacks exact current plan and independent receipt"});
    }
    const revisions = value.judgmentRevisions ?? [];
    if (new Set(revisions.map(r => r.entry.candidateId)).size !== revisions.length
      || revisions.some(r => r.authority.policy.planHash !== planHash
        || r.authority.policy.sourceHash !== value.plan.sourceHash
        || r.authority.policy.subjectHash !== value.plan.subjectHash
        || r.authority.policy.structureHash !== value.plan.structureHash
        || r.authority.policy.batchId !== value.plan.batchId
        || r.authority.policy.sourceId !== value.plan.sourceId
        || r.authority.predecessorAudit.atlasRevision !== atlasRevision
        || !value.claimAudits?.some(a => a.candidateId === r.entry.candidateId && a.claimRevision === contentHash(r.entry) && a.verdict === "supported"))) {
      ctx.addIssue({ code: "custom", message: "Semantic revision lacks exact independent successor verification" });
    }
  }
  for (const [index, span] of value.plan.spans.entries()) if (span.start !== (index ? value.plan.spans[index - 1]!.end : 0) || span.end <= span.start) ctx.addIssue({ code: "custom", message: "Non-contiguous source work" });
});
export type RoleSourceWork = z.infer<typeof roleSourceWorkSchema>;
export { roleAuditWorkSchema, type RoleAuditWork } from "./role-source-audit-model.js";
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
  private readonly frozenPlanHash: string;
  // A workflow owns the compiler lock. Only the typed authority/proposal writes
  // below invalidate this projection; status creates a new read-only store.
  private cachedAuditContractAuthorities?: RoleAuditContractAuthority[];
  private cachedJudgmentAuthorities?: RoleJudgmentAuthority[];
  private cachedJudgmentRevisions?: RoleJudgmentRevisionProof[];
  refreshJudgmentRevisions() { this.cachedAuditContractAuthorities = undefined; this.cachedJudgmentAuthorities = undefined; this.cachedJudgmentRevisions = undefined; }
  constructor(readonly root: string, readonly plan: RoleReviewPlan) {
    roleReviewPlanSchema.parse(plan);
    this.plan = immutableClone(plan);
    this.frozenPlanHash = contentHash(this.plan);
    this.journal = new CompilerProposalObligations(root, plan.sourceId, plan.batchId);
  }
  get planHash() { return this.frozenPlanHash; }
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
    const { assertRoleWorkPlanAuthority } = await import("./role-work-migration.js");
    await assertRoleWorkPlanAuthority(root, plan);
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
  allowanceKey(workId: string): string {
    for (const [page] of this.plan.spans.entries()) for (const kind of ["source", "audit"] as const) {
      if (workId === this.workId(kind, page)) return `${kind}:${page}`;
    }
    for (const id of this.plan.migration?.candidateIds ?? []) {
      if (workId === `candidate-${id}`) return `candidate:${id}`;
      if (workId === this.claimWorkId(id)) return `claim:${id}`;
    }
    return workId;
  }
  inheritedAllowance(workId: string) {
    const sourceRepair = /^role-audit-(?:repair|check)-/.test(workId)
      ? sourceAuditAuthorities(this).find(a => sourceAuditRepairWorkId(a.revisionId) === workId || sourceAuditCheckWorkId(a.revisionId) === workId) : undefined;
    if (sourceRepair) return sourceRepair.allowance;
    const contract = this.auditContractAuthorities().find(a => roleContractAuditWorkId(a.revisionId) === workId);
    if (contract) return contract.allowance;
    for (const authority of this.judgmentAuthorities()) {
      const proposalId = roleJudgmentWorkId(authority.revisionId);
      const proof = this.judgmentRevisions().find(r => r.authority.revisionId === authority.revisionId);
      if (workId === proposalId || (proof && workId === roleSuccessorAuditWorkId(proof))) {
        const original = workId === proposalId ? authority.candidateAllowance : authority.claimAllowance;
        // Distinct, explicitly authorized semantic work inherits cumulative
        // budget and context usage. It cannot revive a stopped predecessor.
        return { ...original, budget: authority.claimAllowance.budget };
      }
    }
    if (!this.plan.migration) return;
    const key = this.allowanceKey(workId);
    return this.plan.migration.allowances.find(item => item.key === key);
  }
  read(kind: "source", page: number): RoleSourceWork | undefined;
  read(kind: "audit", page: number): RoleAuditWork | undefined;
  read(kind: "source" | "audit", page: number): RoleSourceWork | RoleAuditWork | undefined {
    if (kind === "audit") {
      const repair = sourceAuditProofs(this, page)[0];
      if (repair) return repair.proposal;
    }
    const tool = kind === "source" ? ROLE_SOURCE_WORK_TOOL : ROLE_AUDIT_WORK_TOOL;
    const latest = this.journal.history(tool, this.workId(kind, page)).at(-1);
    if (!latest) return kind === "source" ? this.plan.migration?.sourceWork[page] ?? undefined : undefined;
    if (latest.status !== "succeeded") return undefined;
    const input = latest.input as { planHash: string; payload: unknown; entriesHash?: string };
    if (kind === "audit" && input.entriesHash !== this.entriesHash()) throw roleWorkStop("staged entries changed after audit");
    if (latest.inputHash !== CompilerProposalObligations.identity(tool, latest.input).inputHash || input.planHash !== this.planHash) throw roleWorkStop("work receipt belongs to another plan");
    return kind === "source" ? roleSourceWorkSchema.parse(input.payload) : roleAuditWorkSchema.parse(input.payload);
  }
  entriesHash() {
    const local = this.journal.latestAttempts("propose_role_roster_entry").map(a => ({ id: a.proposalId, hash: a.inputHash, status: a.status })).sort((a, b) => a.id.localeCompare(b.id));
    const original = this.plan.migration ? { retained: this.plan.migration.entries, local } : local;
    const revisions = this.judgmentRevisions();
    return contentHash(revisions.length ? { original, revisions } : original);
  }
  sourceComplete() { return this.plan.spans.every((_, page) => Boolean(this.read("source", page))); }
  atlasRevision() { return contentHash(this.plan.spans.map((_, page) => this.read("source", page))); }
  questions(page: number) { const note = this.read("source", page); return note ? roleQuestions(this.planHash, page, note) : []; }
  originalClaimWorkId(candidateId: string) { return `role-claim-v2-${contentHash({ plan: this.planHash, candidateId })}`; }
  claimWorkId(candidateId: string) {
    const contract = this.auditContractAuthorities().find(a => a.entry.candidateId === candidateId);
    if (contract) return roleContractAuditWorkId(contract.revisionId);
    return this.semanticClaimWorkId(candidateId);
  }
  semanticClaimWorkId(candidateId: string) {
    const revision = this.judgmentRevisions().find(r => r.entry.candidateId === candidateId);
    return revision ? roleSuccessorAuditWorkId(revision) : this.originalClaimWorkId(candidateId);
  }
  /** Proposal and independent successor audit share one cumulative budget. */
  budgetWorkId(workId: string) {
    const repair = workId.startsWith("role-audit-check-")
      ? sourceAuditAuthorities(this).find(a => sourceAuditCheckWorkId(a.revisionId) === workId) : undefined;
    if (repair) return sourceAuditRepairWorkId(repair.revisionId);
    const revision = this.judgmentRevisions().find(r => roleSuccessorAuditWorkId(r) === workId);
    return revision ? roleJudgmentWorkId(revision.authority.revisionId) : workId;
  }
  auditContractAuthorities(): RoleAuditContractAuthority[] {
    if (this.cachedAuditContractAuthorities) return this.cachedAuditContractAuthorities;
    const authorities = this.journal.latestAttempts(ROLE_AUDIT_CONTRACT_AUTHORITY_TOOL).map(record => {
      const a = roleAuditContractAuthoritySchema.parse((record.input as {authority: unknown}).authority);
      const receipt = this.journal.history(ROLE_CLAIM_AUDIT_TOOL, a.predecessorWorkId).at(-1);
      if (record.status !== "succeeded" || record.proposalId !== a.revisionId
        || record.inputHash !== CompilerProposalObligations.identity(record.tool, record.input).inputHash
        || a.planHash !== this.planHash || a.sourceId !== this.plan.sourceId || a.sourceHash !== this.plan.sourceHash
        || a.batchId !== this.plan.batchId || a.subjectHash !== this.plan.subjectHash || a.structureHash !== this.plan.structureHash
        || a.predecessorWorkId !== this.semanticClaimWorkId(a.entry.candidateId)
        || contentHash(this.stagedEntries().find(e => e.candidateId === a.entry.candidateId) ?? null) !== contentHash(a.entry)
        || a.predecessorAudit.atlasRevision !== this.atlasRevision()
        || !receipt || receipt.status !== "succeeded" || contentHash(receipt) !== a.predecessorReceiptHash
        || (receipt.input as {contract?: unknown}).contract !== undefined
        || (receipt.input as {planHash: string}).planHash !== this.planHash
        || contentHash((receipt.input as {payload: unknown}).payload) !== contentHash(a.predecessorAudit)) {
        throw roleWorkStop("audit contract predecessor or authority changed");
      }
      return a;
    });
    if (new Set(authorities.map(a => a.entry.candidateId)).size !== authorities.length) throw roleWorkStop("duplicate audit contract authority");
    return this.cachedAuditContractAuthorities = immutableClone(authorities);
  }
  auditContractProofs() {
    return this.auditContractAuthorities().flatMap(authority => {
      const audit = this.claimAudit(authority.entry.candidateId);
      return audit?.verdict === "supported" ? [roleAuditContractProofSchema.parse({authority, audit})] : [];
    });
  }
  judgmentAuthorities() {
    if (this.cachedJudgmentAuthorities) return this.cachedJudgmentAuthorities;
    return this.cachedJudgmentAuthorities = immutableClone(this.journal.latestAttempts(ROLE_JUDGMENT_AUTHORITY_TOOL).map(record => {
      if (record.status !== "succeeded") throw roleWorkStop("uncertain semantic revision authority; recover its original publication, do not retry");
      const authority = roleJudgmentAuthoritySchema.parse((record.input as { authority: unknown }).authority);
      const original = this.originalStagedEntries().find(e => e.candidateId === authority.predecessor.candidateId);
      const receipt = this.journal.history(ROLE_CLAIM_AUDIT_TOOL, authority.predecessorAuditWorkId).at(-1);
      if (record.proposalId !== authority.revisionId
        || record.inputHash !== CompilerProposalObligations.identity(record.tool, record.input).inputHash
        || authority.policy.planHash !== this.planHash || authority.policy.sourceHash !== this.plan.sourceHash
        || authority.policy.subjectHash !== this.plan.subjectHash || authority.policy.structureHash !== this.plan.structureHash
        || authority.policy.batchId !== this.plan.batchId || authority.policy.sourceId !== this.plan.sourceId
        || authority.predecessorAuditWorkId !== this.originalClaimWorkId(authority.predecessor.candidateId)
        || contentHash(original ?? null) !== contentHash(authority.predecessor)
        || !receipt || receipt.status !== "succeeded" || contentHash(receipt) !== authority.predecessorReceiptHash
        || contentHash((receipt.input as { payload: unknown }).payload) !== contentHash(authority.predecessorAudit)
        || authority.predecessorAudit.atlasRevision !== this.atlasRevision()) throw roleWorkStop("semantic revision predecessor or authority changed");
      return authority;
    }).sort((a, b) => a.revisionId.localeCompare(b.revisionId)));
  }
  judgmentRevisions(): RoleJudgmentRevisionProof[] {
    if (this.cachedJudgmentRevisions) return this.cachedJudgmentRevisions;
    const authorities = this.judgmentAuthorities();
    return this.cachedJudgmentRevisions = immutableClone(this.journal.latestAttempts(ROLE_JUDGMENT_REVISION_TOOL).flatMap(record => {
      if (record.status !== "succeeded") return [];
      const input = roleJudgmentRevisionInputSchema.parse((record.input as { payload: unknown }).payload);
      const authority = authorities.find(a => a.revisionId === input.revisionId);
      if (!authority || record.proposalId !== roleJudgmentWorkId(input.revisionId)
        || (record.input as { planHash: string }).planHash !== this.planHash
        || record.inputHash !== CompilerProposalObligations.identity(record.tool, record.input).inputHash) throw roleWorkStop("semantic revision has no exact retained authority");
      return [roleJudgmentRevisionProofSchema.parse({ authority, entry: input.entry })];
    }).sort((a, b) => a.entry.candidateId.localeCompare(b.entry.candidateId)));
  }
  claimAudit(candidateId: string): RoleClaimAudit | undefined {
    const record = this.journal.history(ROLE_CLAIM_AUDIT_TOOL, this.claimWorkId(candidateId)).at(-1);
    if (!record || record.status !== "succeeded") return undefined;
    const input = record.input as {planHash: string; payload: unknown; contract?: unknown};
    if (input.planHash !== this.planHash || record.inputHash !== CompilerProposalObligations.identity(ROLE_CLAIM_AUDIT_TOOL, record.input).inputHash) throw roleWorkStop("claim audit integrity mismatch");
    const contract = this.auditContractAuthorities().find(a => a.entry.candidateId === candidateId);
    if (contract && contentHash(input.contract ?? null) !== contentHash(contract.toContract)) throw roleWorkStop("audit receipt lacks its authorized contract version");
    const audit = roleClaimAuditSchema.parse(input.payload);
    if (contract && audit.packetHash !== contract.predecessorAudit.packetHash) throw roleWorkStop("contract revalidation changed its frozen evidence packet");
    const entry = this.stagedEntries().find(e => e.candidateId === candidateId);
    if (audit.candidateId !== candidateId || audit.claimRevision !== contentHash(entry ?? null) || audit.atlasRevision !== this.atlasRevision()) throw roleWorkStop("claim or atlas changed after audit");
    return audit;
  }
  originalStagedEntries() {
    // A later rejected overwrite must not hide an immutable predecessor. Its
    // unresolved obligation still blocks continuation and final assembly.
    const local = this.journal.latestAttempts("propose_role_roster_entry").flatMap(latest => {
      const prior = this.journal.history(latest.tool, latest.proposalId).findLast(a => a.status === "succeeded");
      return prior ? [roleRosterEntrySchema.parse((prior.input as { entry: unknown }).entry)] : [];
    });
    return [...(this.plan.migration?.entries ?? []).filter(entry => !local.some(item => item.candidateId === entry.candidateId)), ...local];
  }
  stagedEntries() {
    const revisions = this.judgmentRevisions();
    return this.originalStagedEntries().map(entry => revisions.find(r => r.entry.candidateId === entry.candidateId)?.entry ?? entry);
  }
  claimAudits() { return this.stagedEntries().flatMap(e => { const audit = this.claimAudit(e.candidateId); return audit ? [audit] : []; }); }
  /** Read-only version accounting. Old receipts remain inspectable without
   * being accepted by the strict current-revision accessors or finish gates. */
  reviewFreshness() {
    const atlasRevision = this.atlasRevision(), entriesHash = this.entriesHash();
    const sourceRepairs = new Map(sourceAuditProofs(this).map(p => [p.authority.page, p]));
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
      const repair = sourceRepairs.get(page);
      if (repair) return [{ workId: sourceAuditCheckWorkId(repair.authority.revisionId), page, receiptHash: contentHash(repair), audit: repair.proposal, current: true }];
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
    for (const authority of sourceAuditAuthorities(this)) await assertSourceAuditHistory(this, authority);
    const { assertRoleClaimContinuationHistory } = await import("./role-claim-continuation.js");
    await assertRoleClaimContinuationHistory(this);
    this.refreshJudgmentRevisions();
    const { assertRoleJudgmentHistory } = await import("./role-judgment-repair-service.js");
    for (const authority of this.judgmentAuthorities()) await assertRoleJudgmentHistory(this, authority);
    const { RequirementLedger } = await import("./requirement-ledger.js");
    const ledger = new RequirementLedger(this.root, this.plan.sourceId);
    const { assertRoleAuditContractHistory } = await import("./role-audit-contract-service.js");
    for (const authority of this.auditContractAuthorities()) await assertRoleAuditContractHistory(this, authority);
    await ledger.assertRoleEvidenceNeedsResolved(this.planHash);
    await ledger.assertRoleJudgmentFindingsResolved(this.planHash, this.judgmentRevisions(), this.claimAudits(), this.auditContractProofs());
    const history = await ledger.history();
    for (const proof of sourceAuditProofs(this)) {
      if (!history.some(r => r.payload.kind === "role-source-audit-repair" && contentHash(r.payload.proof) === contentHash(proof))) {
        throw roleWorkStop("source audit repair ledger publication incomplete; resume the original bounded workflow before assembly");
      }
    }
    for (let page = 0; page < this.plan.spans.length; page++) {
      const audit = this.read("audit", page);
      for (const question of this.questions(page)) {
        if (!history.some(r => r.payload.kind === "role-review-question" && contentHash(r.payload.question) === contentHash(question))
          || !history.some(r => r.payload.kind === "role-review-question-disposition" && r.payload.planHash === this.planHash && r.payload.auditRef === contentHash(audit)
            && contentHash(r.payload.disposition) === contentHash(audit?.questionDispositions?.find(q => q.questionId === question.questionId) ?? null))) throw roleWorkStop("question ledger publication incomplete; recover the original bounded workflow before assembly");
      }
    }
  }
  claimEnvelope(candidateId: string, raw: unknown) {
    return { proposal_id: this.claimWorkId(candidateId), planHash: this.planHash, contract: ROLE_CLAIM_CONTRACT, payload: raw };
  }
  async submitClaim(raw: unknown, candidateId: string, validate: (value: RoleClaimAudit) => void) {
    this.journal.assertModelRecoveryAllowed();
    if (this.claimAudit(candidateId)) throw roleWorkStop("claim audit already settled");
    const input = this.claimEnvelope(candidateId, raw);
    this.journal.assertRetryAllowed(ROLE_CLAIM_AUDIT_TOOL, input);
    const prior = this.journal.history(ROLE_CLAIM_AUDIT_TOOL, input.proposal_id).at(-1);
    if (prior?.status === "failed" && prior.inputHash === CompilerProposalObligations.identity(ROLE_CLAIM_AUDIT_TOOL, input).inputHash) throw roleWorkStop("unchanged failed claim audit");
    this.journal.record(ROLE_CLAIM_AUDIT_TOOL, input, "running");
    try { const value = roleClaimAuditSchema.parse(raw); validate(value); this.journal.record(ROLE_CLAIM_AUDIT_TOOL, input, "succeeded"); }
    catch (error) { this.journal.record(ROLE_CLAIM_AUDIT_TOOL, input, "failed", String(error)); throw error; }
  }
  async submitJudgmentRevision(raw: unknown, revisionId: string, validate: (entry: z.infer<typeof roleRosterEntrySchema>) => void) {
    this.journal.assertModelRecoveryAllowed();
    const authority = this.judgmentAuthorities().find(a => a.revisionId === revisionId);
    if (!authority || this.judgmentRevisions().some(r => r.authority.revisionId === revisionId)) throw roleWorkStop("semantic revision is unauthorized or already settled");
    const input = { proposal_id: roleJudgmentWorkId(revisionId), planHash: this.planHash, payload: raw };
    this.journal.assertRetryAllowed(ROLE_JUDGMENT_REVISION_TOOL, input);
    const prior = this.journal.history(ROLE_JUDGMENT_REVISION_TOOL, input.proposal_id).at(-1);
    if (prior?.status === "failed" && prior.inputHash === CompilerProposalObligations.identity(ROLE_JUDGMENT_REVISION_TOOL, input).inputHash) throw roleWorkStop("unchanged failed semantic revision");
    this.journal.record(ROLE_JUDGMENT_REVISION_TOOL, input, "running");
    try {
      const proposal = roleJudgmentRevisionInputSchema.parse(raw);
      if (proposal.revisionId !== revisionId) throw roleWorkStop("foreign semantic revision identity");
      const proof = roleJudgmentRevisionProofSchema.parse({ authority, entry: proposal.entry });
      validate(proof.entry);
      this.journal.record(ROLE_JUDGMENT_REVISION_TOOL, input, "succeeded");
      this.cachedJudgmentRevisions = undefined;
    } catch (error) { this.journal.record(ROLE_JUDGMENT_REVISION_TOOL, input, "failed", String(error)); throw error; }
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
    if (files.length || this.inheritedAllowance(workId)?.attempts) throw roleWorkStop('work already started; preserve its original task prompt and claims, do not opt into a different draft workflow');
  }
  async beginAttempt(workId: string) {
    const { claimRoleStartInterruption } = await import("./role-start-interruption.js");
    const continued = await claimRoleStartInterruption(this, workId);
    if (continued !== undefined) return continued;
    const dir = path.join(directory(this.root, this.plan.sourceId), "attempts", contentHash(this.plan.batchId), contentHash(workId));
    await fs.mkdir(dir, { recursive: true });
    const first = 1 + (this.inheritedAllowance(workId)?.attempts ?? 0);
    const semantic = this.judgmentAuthorities().some(a => roleJudgmentWorkId(a.revisionId) === workId)
      || (/^role-audit-(?:repair|check)-/.test(workId) && sourceAuditAuthorities(this).some(a => sourceAuditRepairWorkId(a.revisionId) === workId || sourceAuditCheckWorkId(a.revisionId) === workId))
      || this.judgmentRevisions().some(r => roleSuccessorAuditWorkId(r) === workId)
      || this.auditContractAuthorities().some(a => roleContractAuditWorkId(a.revisionId) === workId);
    for (let attempt = first; attempt <= (semantic ? first : 2); attempt++) {
      try {
        await fs.writeFile(path.join(dir, `${attempt}.json`), JSON.stringify({ planHash: this.planHash, workId, at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
        return attempt;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    throw roleWorkStop("work invocation allowance exhausted");
  }
}
