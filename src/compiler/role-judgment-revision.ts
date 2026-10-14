import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { roleRosterEntrySchema } from "./role-roster-entry.js";
import { roleClaimAuditSchema } from "./role-review-verification.js";
import { roleWorkAllowanceSchema } from "./role-work-allowance.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1);
export const ROLE_JUDGMENT_AUTHORITY_TOOL = "authorize_role_judgment_revision";
export const ROLE_JUDGMENT_REVISION_TOOL = "propose_role_judgment_revision";

/** Host authority is limited to one semantic successor per candidate in this
 * exact review. It never changes the role denominator or certification policy. */
export const roleJudgmentRepairPolicySchema = z.object({
  version: z.literal(1), sourceId: text, sourceHash: hash, planHash: hash,
  batchId: text, subjectHash: hash, structureHash: hash,
  candidateIds: z.array(text).min(1), authorizationRef: text,
  maxSuccessorsPerCandidate: z.literal(1), maxInvocationsPerTask: z.literal(1),
}).strict().refine(p => new Set(p.candidateIds).size === p.candidateIds.length, "Duplicate repair candidate");
export type RoleJudgmentRepairPolicy = z.infer<typeof roleJudgmentRepairPolicySchema>;

export const roleJudgmentAuthoritySchema = z.object({
  version: z.literal(1), revisionId: hash, policy: roleJudgmentRepairPolicySchema,
  predecessor: roleRosterEntrySchema, predecessorAudit: roleClaimAuditSchema,
  predecessorAuditWorkId: text, predecessorReceiptHash: hash,
  candidateAllowance: roleWorkAllowanceSchema, claimAllowance: roleWorkAllowanceSchema,
  retainedFiles: z.array(z.object({ path: text, hash }).strict()),
}).strict().superRefine((a, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (a.revisionId !== roleJudgmentRevisionId(a.policy.planHash, a.predecessor.candidateId)) fail("Revision identity changed");
  if (!a.policy.candidateIds.includes(a.predecessor.candidateId)
    || a.predecessorAudit.candidateId !== a.predecessor.candidateId
    || a.predecessorAudit.claimRevision !== contentHash(a.predecessor)
    || a.predecessorAudit.verdict === "supported") fail("Revision requires an exact unsupported predecessor");
  if (a.candidateAllowance.key !== `candidate-${a.predecessor.candidateId}`
    || a.claimAllowance.key !== a.predecessorAuditWorkId) fail("Retained allowance identity changed");
  if (!a.claimAllowance.budget || a.claimAllowance.budget.state.blocked || a.candidateAllowance.budget?.state.blocked
    || a.claimAllowance.nativeContextFallback || a.candidateAllowance.nativeContextFallback
    || (a.claimAllowance.contextSessions ?? 0) >= 3 || (a.candidateAllowance.contextSessions ?? 0) >= 3
    || (a.claimAllowance.contextHandoffs ?? 0) >= 2 || (a.candidateAllowance.contextHandoffs ?? 0) >= 2) fail("Retained work cannot bypass a budget or context stop");
  if (a.retainedFiles.some(f => f.path.startsWith("/") || f.path.split(/[\\/]/).includes(".."))
    || new Set(a.retainedFiles.map(f => f.path)).size !== a.retainedFiles.length) fail("Invalid retained history paths");
});
export type RoleJudgmentAuthority = z.infer<typeof roleJudgmentAuthoritySchema>;
export const roleJudgmentRevisionInputSchema = z.object({ revisionId: hash, entry: roleRosterEntrySchema }).strict();
export const roleJudgmentRevisionProofSchema = z.object({
  authority: roleJudgmentAuthoritySchema, entry: roleRosterEntrySchema,
}).strict().superRefine(({ authority, entry }, ctx) => {
  if (entry.candidateId !== authority.predecessor.candidateId || !entry.developmentExpectation
    || contentHash(entry) === contentHash(authority.predecessor)) {
    ctx.addIssue({ code: "custom", message: "Semantic successor must change the same candidate's complete judgment" });
  }
  if (authority.predecessorAudit.checks.some(c => c.kind === "importance" && c.verdict === "supported")
    && entry.importance !== authority.predecessor.importance) {
    ctx.addIssue({ code: "custom", message: "Repair cannot change independently supported importance to reduce requirements" });
  }
});
export type RoleJudgmentRevisionProof = z.infer<typeof roleJudgmentRevisionProofSchema>;
export const roleJudgmentFindingSchema = z.object({
  planHash: hash, workId: text, audit: roleClaimAuditSchema,
}).strict().refine(f => f.audit.verdict !== "supported", "Supported audit is not a finding");
export type RoleJudgmentFinding = z.infer<typeof roleJudgmentFindingSchema>;

export function roleJudgmentRevisionId(planHash: string, candidateId: string) {
  return contentHash({ policy: "role-judgment-successor-v1", planHash, candidateId });
}
export const roleJudgmentWorkId = (revisionId: string) => `role-judgment-revision-${revisionId}`;
export const roleSuccessorAuditWorkId = (proof: RoleJudgmentRevisionProof) =>
  `role-claim-successor-${contentHash({ revisionId: proof.authority.revisionId, claimRevision: contentHash(proof.entry) })}`;
