import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../world/canonical.js";
import { worldStorageRoot } from "../world/paths.js";
import { WorkspaceOperationLock } from "../util/workspace-lock.js";
import { CompilerProposalObligations } from "./proposal-obligations.js";
import { ROLE_AUDIT_WORK_TOOL, roleWorkStop, type RoleReviewWorkStore } from "./role-review-work.js";
import { SOURCE_AUDIT_AUTHORITY, SOURCE_AUDIT_REPAIR, SOURCE_AUDIT_CHECK, sourceAuditAuthoritySchema,
  sourceAuditCheckSchema, sourceAuditProofSchema, sourceAuditRevisionId, sourceAuditRepairWorkId,
  sourceAuditCheckWorkId, roleAuditWorkSchema, type SourceAuditAuthority, type SourceAuditProof } from "./role-source-audit-model.js";

function retained(store: RoleReviewWorkStore, tool: string, id: string) {
  const record = store.journal.history(tool, id).at(-1);
  if (!record || record.status !== "succeeded") return;
  if (record.inputHash !== CompilerProposalObligations.identity(tool, record.input).inputHash
    || (record.input as { planHash: string }).planHash !== store.planHash) throw roleWorkStop("source audit repair receipt integrity changed");
  return record;
}
export function sourceAuditAuthorities(store: RoleReviewWorkStore, page?: number): SourceAuditAuthority[] {
  const records = page === undefined ? store.journal.latestAttempts(SOURCE_AUDIT_AUTHORITY)
    : store.journal.history(SOURCE_AUDIT_AUTHORITY, sourceAuditRevisionId(store.planHash, page)).slice(-1);
  if (!records.length) return [];
  const atlasRevision = store.atlasRevision(), entriesHash = store.entriesHash();
  const entriesContentHash = contentHash(store.stagedEntries().sort((a, b) => a.candidateId.localeCompare(b.candidateId)));
  const claimAuditsHash = contentHash(store.claimAudits());
  return records.map(record => {
    if (!retained(store, SOURCE_AUDIT_AUTHORITY, record.proposalId)) throw roleWorkStop("source audit repair authority publication is unfinished");
    const a = sourceAuditAuthoritySchema.parse((record.input as { authority: unknown }).authority);
    const predecessor = retained(store, ROLE_AUDIT_WORK_TOOL, a.predecessorWorkId);
    if (record.proposalId !== a.revisionId || a.planHash !== store.planHash || a.sourceId !== store.plan.sourceId
      || a.sourceHash !== store.plan.sourceHash || a.subjectHash !== store.plan.subjectHash || a.structureHash !== store.plan.structureHash
      || a.batchId !== store.plan.batchId || a.predecessorWorkId !== store.workId("audit", a.page)
      || !predecessor || contentHash(predecessor) !== a.predecessorReceiptHash
      || contentHash((predecessor.input as { payload: unknown }).payload) !== contentHash(a.predecessor)
      || a.atlasRevision !== atlasRevision || a.entriesHash !== entriesHash || a.entriesContentHash !== entriesContentHash
      || a.claimAuditsHash !== claimAuditsHash) throw roleWorkStop("source audit repair dependencies changed; inspect the original plan and receipts, never overwrite them");
    return a;
  });
}
export function sourceAuditRepairState(store: RoleReviewWorkStore, authority: SourceAuditAuthority) {
  const proposal = retained(store, SOURCE_AUDIT_REPAIR, sourceAuditRepairWorkId(authority.revisionId));
  const verification = retained(store, SOURCE_AUDIT_CHECK, sourceAuditCheckWorkId(authority.revisionId));
  const result = {
    proposal: proposal ? roleAuditWorkSchema.parse((proposal.input as { payload: unknown }).payload) : undefined,
    verification: verification ? sourceAuditCheckSchema.parse((verification.input as { payload: unknown }).payload) : undefined,
  };
  if (result.verification && (!result.proposal || result.verification.revisionId !== authority.revisionId
    || result.verification.proposalHash !== contentHash(result.proposal))) throw roleWorkStop("independent source audit check changed its proposal");
  return result;
}
export function sourceAuditProofs(store: RoleReviewWorkStore, page?: number): SourceAuditProof[] {
  return sourceAuditAuthorities(store, page).flatMap(authority => {
    const state = sourceAuditRepairState(store, authority);
    return state.verification?.verdict === "supported" ? [sourceAuditProofSchema.parse({ authority, ...state })] : [];
  });
}
export async function assertSourceAuditHistory(store: RoleReviewWorkStore, authority: SourceAuditAuthority) {
  for (const file of authority.retainedFiles) {
    if (contentHash(await fs.readFile(path.join(worldStorageRoot(store.root), file.path), "utf8")) !== file.hash) {
      throw roleWorkStop("source audit predecessor history or usage changed; preserve all versions and stop");
    }
  }
}
export async function ensureSourceAuditRepair(store: RoleReviewWorkStore, page: number) {
  const { CompilerFinishReceipts } = await import("./finish-receipts.js");
  const { captureRoleWorkAllowance } = await import("./role-judgment-repair-service.js");
  const { assertRoleWorkPlanAuthority } = await import("./role-work-migration.js");
  if ((await WorkspaceOperationLock.inspect(store.root)).owner?.pid !== process.pid) throw roleWorkStop("source audit repair requires the owning compiler lock");
  await assertRoleWorkPlanAuthority(store.root, store.plan);
  store.journal.assertModelRecoveryAllowed();
  if (store.journal.unresolved().length || !store.sourceComplete()
    || store.stagedEntries().some(e => store.claimAudit(e.candidateId)?.verdict !== "supported")
    || await new CompilerFinishReceipts(store.root, store.plan.sourceId, store.plan.batchId).read()
    || store.journal.history("propose_role_roster_review", "role-roster-review").length) {
    throw roleWorkStop("source audit repair requires settled source/claim work before assembly; inspect compile-novel status, preserve unresolved scopes and do not retry unchanged");
  }
  const existing = sourceAuditAuthorities(store, page)[0];
  if (existing) { await assertSourceAuditHistory(store, existing); return existing; }
  const workId = store.workId("audit", page), receipt = retained(store, ROLE_AUDIT_WORK_TOOL, workId);
  if (!receipt) throw roleWorkStop("source audit predecessor is missing; inspect the same plan's reviewFreshness().sourceAudits and copy page once, never guess or retry unchanged");
  const retainedFiles: SourceAuditAuthority["retainedFiles"] = [];
  const allowance = await captureRoleWorkAllowance(store, workId, retainedFiles);
  const authority = sourceAuditAuthoritySchema.parse({ version: 1, policy: "compile-source-audit-repair-v1",
    revisionId: sourceAuditRevisionId(store.planHash, page), sourceId: store.plan.sourceId, sourceHash: store.plan.sourceHash,
    planHash: store.planHash, batchId: store.plan.batchId, subjectHash: store.plan.subjectHash, structureHash: store.plan.structureHash,
    page, predecessorWorkId: workId, predecessorReceiptHash: contentHash(receipt),
    predecessor: roleAuditWorkSchema.parse((receipt.input as { payload: unknown }).payload),
    atlasRevision: store.atlasRevision(), entriesHash: store.entriesHash(),
    entriesContentHash: contentHash(store.stagedEntries().sort((a, b) => a.candidateId.localeCompare(b.candidateId))),
    claimAuditsHash: contentHash(store.claimAudits()), allowance, retainedFiles });
  store.journal.record(SOURCE_AUDIT_AUTHORITY, { proposal_id: authority.revisionId, planHash: store.planHash, authority }, "succeeded");
  return authority;
}
export function submitSourceAuditRepair(store: RoleReviewWorkStore, authority: SourceAuditAuthority,
  kind: "proposal" | "verification", raw: unknown, validate: (value: unknown) => void) {
  store.journal.assertModelRecoveryAllowed();
  const tool = kind === "proposal" ? SOURCE_AUDIT_REPAIR : SOURCE_AUDIT_CHECK;
  const id = kind === "proposal" ? sourceAuditRepairWorkId(authority.revisionId) : sourceAuditCheckWorkId(authority.revisionId);
  if (!sourceAuditAuthorities(store, authority.page).some(a => contentHash(a) === contentHash(authority)) || retained(store, tool, id)) throw roleWorkStop("source audit repair is unauthorized or already settled");
  const input = { proposal_id: id, planHash: store.planHash, payload: raw };
  store.journal.assertRetryAllowed(tool, input);
  const previous = store.journal.history(tool, id).at(-1);
  if (previous?.status === "failed" && previous.inputHash === CompilerProposalObligations.identity(tool, input).inputHash) throw roleWorkStop("unchanged failed source audit repair; inspect the original diagnostic before one corrected submission");
  store.journal.record(tool, input, "running");
  try { validate(raw); store.journal.record(tool, input, "succeeded"); }
  catch (error) { store.journal.record(tool, input, "failed", String(error)); throw error; }
}
