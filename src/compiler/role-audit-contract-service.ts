import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../world/canonical.js";
import { worldStorageRoot } from "../world/paths.js";
import { WorkspaceOperationLock } from "../util/workspace-lock.js";
import { RoleReviewWorkStore, ROLE_CLAIM_AUDIT_TOOL, roleWorkStop } from "./role-review-work.js";
import { RequirementLedger } from "./requirement-ledger.js";
import { captureRoleWorkAllowance, mutableRoleReview, assertRoleJudgmentHistory } from "./role-judgment-repair-service.js";
import { remainingRoleProgressCalls } from "./role-review-budget.js";
import { roleJudgmentWorkId } from "./role-judgment-revision.js";
import { ROLE_CLAIM_CONTRACT, ROLE_AUDIT_CONTRACT_AUTHORITY_TOOL, roleAuditContractAuthoritySchema,
  roleAuditContractRevisionId, type RoleAuditContractAuthority } from "./role-audit-contract.js";

export type RoleAuditContractAuthorization = { sourceId: string; batchId: string; planHash: string;
  candidateId: string; predecessorReceiptHash: string; authorizationRef: string; diagnosisRef: string };

export async function assertRoleAuditContractHistory(store: RoleReviewWorkStore, authority: RoleAuditContractAuthority) {
  const records = await new RequirementLedger(store.root, store.plan.sourceId).history();
  if (!records.some(r => r.payload.kind === "role-audit-contract-authority" && contentHash(r.payload.authority) === contentHash(authority))) {
    throw roleWorkStop("audit contract revision lacks its original host authority");
  }
  for (const file of authority.retainedFiles) {
    if (contentHash(await fs.readFile(path.join(worldStorageRoot(store.root), file.path), "utf8")) !== file.hash) {
      throw roleWorkStop("audit contract predecessor history changed; preserve receipts and cumulative charges");
    }
  }
}

/** Read-only, exact-receipt preview. The host diagnoses a changed audit contract;
 * it does not decide the literary verdict or reopen the consumed old task. */
export async function inspectRoleAuditContractAuthorization(root: string, input: RoleAuditContractAuthorization) {
  const plan = (await RoleReviewWorkStore.plans(root, input.sourceId)).find(p => p.batchId === input.batchId);
  if (!plan || contentHash(plan) !== input.planHash) throw roleWorkStop("unknown audit contract plan; use requirements inspect, copy roleReviewPlans[].batchId and planHash, correct once without guessing");
  const store = new RoleReviewWorkStore(root, plan);
  const existing = store.auditContractAuthorities().find(a => a.entry.candidateId === input.candidateId);
  if (existing) {
    if (existing.authorizationRef !== input.authorizationRef || existing.diagnosisRef !== input.diagnosisRef
      || existing.predecessorReceiptHash !== input.predecessorReceiptHash) throw roleWorkStop("audit contract authority is fixed; renaming cannot grant another invocation");
    await assertRoleAuditContractHistory(store, existing);
    return { authority: existing, authorityHash: contentHash(existing) };
  }
  await mutableRoleReview(store);
  for (const a of store.judgmentAuthorities()) await assertRoleJudgmentHistory(store, a);
  const entry = store.stagedEntries().find(e => e.candidateId === input.candidateId);
  const predecessorAudit = store.claimAudit(input.candidateId), predecessorWorkId = store.claimWorkId(input.candidateId);
  const receipt = store.journal.history(ROLE_CLAIM_AUDIT_TOOL, predecessorWorkId).at(-1);
  if (!entry || !predecessorAudit || predecessorAudit.verdict === "supported" || !receipt || receipt.status !== "succeeded"
    || contentHash(receipt) !== input.predecessorReceiptHash) throw roleWorkStop("unknown or unsettled predecessor; use compile-novel status, copy roleReviewWork[].claimFindings[].candidateId and receiptHash, correct once without guessing");
  if ((receipt.input as { contract?: unknown }).contract !== undefined) throw roleWorkStop("receipt already uses a versioned contract; unchanged revalidation is forbidden");
  const retainedFiles: RoleAuditContractAuthority["retainedFiles"] = [];
  const allowance = await captureRoleWorkAllowance(store, predecessorWorkId, retainedFiles, true);
  const semantic = store.judgmentRevisions().find(r => r.entry.candidateId === entry.candidateId);
  if (semantic) {
    retainedFiles.push(...semantic.authority.retainedFiles);
    await captureRoleWorkAllowance(store, roleJudgmentWorkId(semantic.authority.revisionId), retainedFiles, true);
  }
  if (!allowance.attempts || !allowance.budget || remainingRoleProgressCalls(allowance.budget) === 0) throw roleWorkStop("contract revision requires retained invocation charges and an unexhausted progress window");
  const authority = roleAuditContractAuthoritySchema.parse({ version: 1,
    revisionId: roleAuditContractRevisionId(store.planHash, entry.candidateId),
    sourceId: plan.sourceId, sourceHash: plan.sourceHash, planHash: store.planHash, batchId: plan.batchId,
    subjectHash: plan.subjectHash, structureHash: plan.structureHash,
    authorizationRef: input.authorizationRef, diagnosisRef: input.diagnosisRef,
    fromContract: "unversioned", toContract: ROLE_CLAIM_CONTRACT,
    entry, predecessorAudit, predecessorWorkId, predecessorReceiptHash: contentHash(receipt),
    allowance, maxInvocations: 1, maxNewSessions: 1,
    retainedFiles: [...new Map(retainedFiles.map(f => [f.path, f])).values()].sort((a, b) => a.path.localeCompare(b.path)) });
  return { authority, authorityHash: contentHash(authority) };
}

export async function authorizeRoleAuditContractRevision(root: string, input: RoleAuditContractAuthorization, expectedAuthorityHash: string) {
  if ((await WorkspaceOperationLock.inspect(root)).owner?.pid !== process.pid) throw roleWorkStop("audit contract revision requires the owning compiler lock");
  const preview = await inspectRoleAuditContractAuthorization(root, input);
  if (preview.authorityHash !== expectedAuthorityHash) throw roleWorkStop("audit contract preview changed; inspect the exact preview before one corrected host invocation");
  const plan = (await RoleReviewWorkStore.plans(root, input.sourceId)).find(p => p.batchId === input.batchId)!;
  const store = new RoleReviewWorkStore(root, plan), ledger = new RequirementLedger(root, input.sourceId);
  await ledger.recordRoleJudgmentFinding({ planHash: store.planHash, workId: preview.authority.predecessorWorkId, audit: preview.authority.predecessorAudit });
  await ledger.authorizeRoleAuditContractRevision(preview.authority);
  if (!store.auditContractAuthorities().some(a => a.revisionId === preview.authority.revisionId)) {
    store.journal.record(ROLE_AUDIT_CONTRACT_AUTHORITY_TOOL, { proposal_id: preview.authority.revisionId, authority: preview.authority }, "succeeded");
  }
  return preview;
}
