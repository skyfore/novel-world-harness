import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { roleQuestionDispositionSchema, roleDiscoveryDispositionSchema, sameIds } from "./role-review-verification.js";
import { roleWorkAllowanceSchema } from "./role-work-allowance.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(2000);
export const roleAuditWorkSchema = z.object({
  rationale: text,
  missingMajorCharacters: z.array(z.object({ name: z.string().trim().min(1).max(200),
    rationale: z.string().trim().min(1).max(1200), basisUnitIds: z.array(z.string()).min(1).max(24) }).strict()).max(64),
  questionDispositions: z.array(roleQuestionDispositionSchema).max(24).optional(),
  discoveryDispositions: z.array(roleDiscoveryDispositionSchema).max(64).optional(),
  atlasRevision: hash.optional(),
  unresolved: z.array(z.string().trim().min(1).max(600)).max(24),
}).strict();
export type RoleAuditWork = z.infer<typeof roleAuditWorkSchema>;
export const SOURCE_AUDIT_AUTHORITY = "authorize_role_source_audit_repair";
export const SOURCE_AUDIT_REPAIR = "propose_role_source_audit_repair";
export const SOURCE_AUDIT_CHECK = "propose_role_source_audit_repair_check";
export const sourceAuditRevisionId = (planHash: string, page: number) => contentHash({ policy: "source-audit-repair-v1", planHash, page });
export const sourceAuditRepairWorkId = (revisionId: string) => `role-audit-repair-${revisionId}`;
export const sourceAuditCheckWorkId = (revisionId: string) => `role-audit-check-${revisionId}`;
export const sourceAuditBlocked = (audit: RoleAuditWork) => Boolean(audit.unresolved.length
  || !audit.questionDispositions || audit.questionDispositions.some(q => q.status === "blocked")
  || !audit.discoveryDispositions || audit.discoveryDispositions.some(d => d.disposition === "blocked"));

/** A compilation request authorizes one evidence repair and one independent
 * check. It never authorizes changing the source, candidate set or old verdict. */
export const sourceAuditAuthoritySchema = z.object({
  version: z.literal(1), policy: z.literal("compile-source-audit-repair-v1"), revisionId: hash,
  sourceId: text, sourceHash: hash, planHash: hash, batchId: text, subjectHash: hash, structureHash: hash,
  page: z.number().int().nonnegative(), predecessorWorkId: text, predecessorReceiptHash: hash,
  predecessor: roleAuditWorkSchema, atlasRevision: hash, entriesHash: hash, entriesContentHash: hash, claimAuditsHash: hash,
  allowance: roleWorkAllowanceSchema,
  retainedFiles: z.array(z.object({ path: text, hash }).strict()),
}).strict().superRefine((a, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (a.revisionId !== sourceAuditRevisionId(a.planHash, a.page)
    || a.predecessorWorkId !== `role-audit-v2-${a.planHash.slice(0, 20)}-${a.page}` || !sourceAuditBlocked(a.predecessor)
    || a.predecessor.atlasRevision !== a.atlasRevision) fail("Repair requires the exact current blocked source audit");
  const b = a.allowance.budget;
  if (!b || b.state.blocked || b.state.failure || a.allowance.nativeContextFallback
    || b.state.usage.modelCalls - (b.state.progress?.lastProgressCall ?? 0) >= b.limits.maxModelCalls) fail("Repair cannot renew exhausted or unknown predecessor usage");
  if (a.retainedFiles.some(f => f.path.startsWith("/") || f.path.split(/[\\/]/).includes(".."))
    || new Set(a.retainedFiles.map(f => f.path)).size !== a.retainedFiles.length) fail("Invalid retained source audit history");
});
export type SourceAuditAuthority = z.infer<typeof sourceAuditAuthoritySchema>;
const check = z.object({ verdict: z.enum(["supported", "insufficient", "contradicted"]), rationale: text,
  basisUnitIds: z.array(z.string().min(1)).min(1).max(64) }).strict();
export const sourceAuditCheckSchema = z.object({
  revisionId: hash, proposalHash: hash, verdict: check.shape.verdict,
  questions: z.array(check.extend({ questionId: hash })).max(24),
  discoveries: z.array(check.extend({ findingId: hash })).max(64),
  predecessorIssues: z.array(check.extend({ index: z.number().int().nonnegative() })).max(24),
}).strict();
export type SourceAuditCheck = z.infer<typeof sourceAuditCheckSchema>;
export const sourceAuditProofSchema = z.object({
  authority: sourceAuditAuthoritySchema, proposal: roleAuditWorkSchema, verification: sourceAuditCheckSchema,
}).strict().superRefine(({ authority: a, proposal: p, verification: v }, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (v.revisionId !== a.revisionId || v.proposalHash !== contentHash(p) || p.atlasRevision !== a.atlasRevision
    || sourceAuditBlocked(p) || v.verdict !== "supported") fail("Source audit repair lacks a supported, closed independent check");
  if (!sameIds(v.questions.map(q => q.questionId), (p.questionDispositions ?? []).map(q => q.questionId))
    || !sameIds(v.discoveries.map(d => d.findingId), (p.discoveryDispositions ?? []).map(d => d.findingId))
    || !sameIds(v.predecessorIssues.map(i => String(i.index)), a.predecessor.unresolved.map((_, i) => String(i)))
    || [...v.questions, ...v.discoveries, ...v.predecessorIssues].some(c => c.verdict !== "supported")) fail("Independent check omitted a responsibility or retained issue");
  if (a.predecessor.missingMajorCharacters.some(m => !p.missingMajorCharacters.some(n => contentHash(n) === contentHash(m)))) fail("Source repair cannot remove a missing major character requirement");
});
export type SourceAuditProof = z.infer<typeof sourceAuditProofSchema>;
