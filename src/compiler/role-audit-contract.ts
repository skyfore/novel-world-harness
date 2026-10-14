import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { roleRosterEntrySchema } from "./role-roster-entry.js";
import { roleClaimAuditSchema } from "./role-review-verification.js";
import { roleWorkAllowanceSchema } from "./role-work-allowance.js";

// Receipts written before this contract had no version field. They remain
// unversioned historical results, never retroactively relabelled as v2.
export const ROLE_CLAIM_CONTRACT = Object.freeze({ version: 2,
  purpose: "evidence-faithfulness-of-classification", unknown: "audit-boundary-separately-from-certification" });
export const ROLE_AUDIT_CONTRACT_AUTHORITY_TOOL = "authorize_role_audit_contract_revision";
const hash = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().trim().min(1);
export const roleAuditContractRevisionId = (planHash: string, candidateId: string) =>
  contentHash({ planHash, candidateId, contract: ROLE_CLAIM_CONTRACT });
export const roleContractAuditWorkId = (revisionId: string) => `role-claim-contract-${revisionId}`;
export const roleAuditContractAuthoritySchema = z.object({
  version: z.literal(1), revisionId: hash, sourceId: text, sourceHash: hash,
  planHash: hash, batchId: text, subjectHash: hash, structureHash: hash,
  authorizationRef: text, diagnosisRef: text,
  fromContract: z.literal("unversioned"), toContract: z.object({ version: z.literal(2),
    purpose: z.literal("evidence-faithfulness-of-classification"), unknown: z.literal("audit-boundary-separately-from-certification") }).strict(),
  entry: roleRosterEntrySchema, predecessorAudit: roleClaimAuditSchema,
  predecessorWorkId: text, predecessorReceiptHash: hash,
  // These are cumulative ordinals, unlike the ordinary two-invocation limit.
  allowance: roleWorkAllowanceSchema.extend({ attempts: z.number().int().nonnegative() }),
  maxInvocations: z.literal(1), maxNewSessions: z.literal(1),
  retainedFiles: z.array(z.object({ path: text, hash }).strict()).min(1),
}).strict().superRefine((a, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (a.revisionId !== roleAuditContractRevisionId(a.planHash, a.entry.candidateId)
    || a.predecessorAudit.candidateId !== a.entry.candidateId
    || a.predecessorAudit.claimRevision !== contentHash(a.entry)
    || a.predecessorAudit.verdict === "supported"
    || a.allowance.key !== a.predecessorWorkId) fail("Contract revision requires an exact settled negative predecessor");
  if (!a.allowance.budget || a.allowance.budget.state.blocked || a.allowance.nativeContextFallback
    || (a.allowance.contextHandoffs ?? 0) >= 2) fail("Contract revision cannot clear a budget or context recovery stop");
  if (a.retainedFiles.some(f => f.path.startsWith("/") || f.path.split(/[\\/]/).includes(".."))
    || new Set(a.retainedFiles.map(f => f.path)).size !== a.retainedFiles.length) fail("Invalid retained audit history paths");
});
export type RoleAuditContractAuthority = z.infer<typeof roleAuditContractAuthoritySchema>;
export const roleAuditContractProofSchema = z.object({ authority: roleAuditContractAuthoritySchema,
  audit: roleClaimAuditSchema }).strict().superRefine(({authority: a, audit}, ctx) => {
  if (audit.verdict !== "supported" || audit.candidateId !== a.entry.candidateId
    || audit.claimRevision !== contentHash(a.entry) || audit.atlasRevision !== a.predecessorAudit.atlasRevision
    || audit.packetHash !== a.predecessorAudit.packetHash) {
    ctx.addIssue({ code: "custom", message: "Contract resolution requires supported revalidation of the unchanged claim and evidence packet" });
  }
});
export type RoleAuditContractProof = z.infer<typeof roleAuditContractProofSchema>;
