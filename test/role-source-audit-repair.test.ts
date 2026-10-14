import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { sourceAuditFixture } from "./helpers/role-source-audit.js";
import { contentHash } from "../src/world/canonical.js";
import { withWorkspaceOperationLock } from "../src/util/workspace-lock.js";
import { roleReviewBudget, inspectRoleReviewBudget } from "../src/compiler/role-review-budget.js";
import { ROLE_WORK_LIMITS, runBoundedRoleReview, type RoleWorkInvocation } from "../src/workflow/role-review-bounded.js";
import { SOURCE_AUDIT_REPAIR, SOURCE_AUDIT_CHECK, sourceAuditRepairWorkId } from "../src/compiler/role-source-audit-model.js";
import { sourceAuditProofs, sourceAuditAuthorities } from "../src/compiler/role-source-audit-repair.js";
import { RequirementLedger, requirementJournalBindingIssues } from "../src/compiler/requirement-ledger.js";
import { boundedRoleReviewEvidenceSchema } from "../src/compiler/role-review-work.js";
import { withNwhToolRecovery } from "../src/agent/tool-recovery.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { RoleRosterStore } from "../src/compiler/role-roster.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const call = (work: RoleWorkInvocation, name: string, value: unknown) => work.tools.find(t => t.name === name)!.execute(name, value as never, undefined, undefined, {} as never);
async function fixture() {
  const f = await sourceAuditFixture(); roots.push(f.root);
  const original = f.store.workId("audit", 0);
  await f.store.beginAttempt(original);
  const budget = roleReviewBudget(f.root, f.store.planHash, original, ROLE_WORK_LIMITS, false, "progress");
  budget.beginCall({ original: true });
  await f.store.submit("audit", 0, f.audit, () => {});
  budget.recordValidatedProgress("original-receipt"); budget.close();
  return { ...f, original };
}
function runner(f: Awaited<ReturnType<typeof fixture>>, verdict = "supported") {
  return async (work: RoleWorkInvocation) => {
    const p = JSON.parse(work.prompt.split("\n").at(-1)!);
    const budget = roleReviewBudget(f.root, f.store.planHash, f.store.budgetWorkId(work.workId), ROLE_WORK_LIMITS, false, "progress", f.store.inheritedAllowance(work.workId)?.budget);
    budget.beginCall({ task: work.workId });
    try {
      if (work.workId.startsWith("role-audit-repair-")) {
        await call(work, "read_role_work_evidence", { unitId: f.unit });
        await call(work, SOURCE_AUDIT_REPAIR, { ...f.audit, rationale: "The later letter answers the original question", unresolved: [],
          questionDispositions: f.audit.questionDispositions.map(q => ({ ...q, status: "resolved", rationale: "The letter arrives in the later passage" })) });
      } else {
        const check = { revisionId: p.revisionId, proposalHash: p.proposalHash, verdict,
          questions: p.expectedQuestions.map((q: { questionId: string }) => ({ questionId: q.questionId, verdict, rationale: "Independent later evidence check", basisUnitIds: [f.unit] })),
          discoveries: [], predecessorIssues: p.predecessor.unresolved.map((_: unknown, index: number) => ({ index, verdict, rationale: "Independent issue check", basisUnitIds: [f.unit] })) };
        const unread = await call(work, "preview_role_source_audit_verification", { ...check,
          questions: check.questions.map((q: object) => ({ ...q, basisUnitIds: ["invented-unit"] })) });
        expect(JSON.parse((unread.content[0] as { text: string }).text).valid).toBe(false);
        await call(work, "read_role_work_evidence", { unitId: f.unit });
        await call(work, SOURCE_AUDIT_CHECK, check);
      }
      budget.recordValidatedProgress(`receipt:${work.workId}`);
    } finally { budget.close(); }
  };
}

it("repairs the blocked audit through ordinary compilation, independently checks it, and retains old evidence and charges", async () => {
  const f = await fixture(), finalize = vi.fn(), old = f.store.journal.history("propose_role_review_audit", f.original);
  const before = inspectRoleReviewBudget(f.root, f.store.planHash, f.original);
  const execute = vi.fn(runner(f));
  await withWorkspaceOperationLock(f.root, "compiler", () => runBoundedRoleReview(f.options, execute, finalize));
  expect(execute).toHaveBeenCalledTimes(2);
  expect(finalize).toHaveBeenCalledOnce();
  expect(f.store.auditComplete()).toBe(true);
  expect(f.store.journal.history("propose_role_review_audit", f.original)).toEqual(old);
  expect(inspectRoleReviewBudget(f.root, f.store.planHash, f.original)).toEqual(before);
  const [proof] = sourceAuditProofs(f.store);
  expect(inspectRoleReviewBudget(f.root, f.store.planHash, sourceAuditRepairWorkId(proof!.authority.revisionId)).state.usage.modelCalls).toBe(before.state.usage.modelCalls + 2);
  expect((await new RequirementLedger(f.root, f.roster.sourceId).history()).some(r => r.payload.kind === "role-source-audit-repair")).toBe(true);
  const evidence = { version: 2, plan: f.store.plan, entriesHash: contentHash(f.store.stagedEntries()), claimAudits: f.store.claimAudits(),
    sourceWork: [f.store.read("source", 0)], auditWork: [f.store.read("audit", 0)], sourceAuditRevisions: [proof] };
  expect(boundedRoleReviewEvidenceSchema.safeParse(evidence).success).toBe(true);
  expect(boundedRoleReviewEvidenceSchema.safeParse({ ...evidence, sourceAuditRevisions: [{ ...proof, verification: { ...proof!.verification, questions: [] } }] }).success).toBe(false);
  // Restart repairs ledger publication only, without another model task.
  const again = vi.fn();
  await withWorkspaceOperationLock(f.root, "compiler", () => runBoundedRoleReview(f.options, again, vi.fn()));
  expect(again).not.toHaveBeenCalled();
  await f.store.assertQuestionLedger();
  // The ordinary assembler transports the proof; an archive without its
  // requirement history cannot silently accept the revised answers.
  const tools = createCompilerProposalToolset(f.root);
  await tools.beginBatch([], f.store.plan.batchId, f.roster.sourceId);
  const proposal = tools.tools.find(t => t.name === "propose_role_roster_review")!;
  await proposal.execute("assemble", { subjectHash: f.roster.subjectHash, staged: true, missingMajorCharacters: [] } as never, undefined, undefined, {} as never);
  const finish = tools.tools.find(t => t.name === "finish_compiler_batch")!;
  await finish.execute("finish", { outcome: "complete", reviewed_segments: [], summary: "Independently checked repaired audit" } as never, undefined, undefined, {} as never);
  const saved = (await new RoleRosterStore(f.root).read(f.roster.sourceId))!;
  expect(saved.reviews[0]!.workEvidence!.sourceAuditRevisions).toEqual([proof]);
  const ledger = new RequirementLedger(f.root, f.roster.sourceId), history = await ledger.history();
  expect(requirementJournalBindingIssues({ roleRoster: saved }, f.roster.sourceId, f.roster.sourceSha256)).toContain("REQUIREMENT_JOURNAL_MISSING");
  expect(requirementJournalBindingIssues({ roleRoster: saved, requirementJournal: history }, f.roster.sourceId, f.roster.sourceSha256)).toEqual([]);
  const stripped = structuredClone(saved);
  delete stripped.reviews[0]!.workEvidence!.sourceAuditRevisions;
  expect(requirementJournalBindingIssues({ roleRoster: stripped, requirementJournal: history }, f.roster.sourceId, f.roster.sourceSha256)).toContain("SOURCE_AUDIT_REPAIR_PROOF_MISSING");
});

it("records invalid repair arguments before Pi dispatch and allows only a real correction", async () => {
  const f = await fixture(), complete = runner(f);
  await withWorkspaceOperationLock(f.root, "compiler", () => runBoundedRoleReview(f.options, async work => {
    if (work.workId.startsWith("role-audit-repair-")) {
      const tool = withNwhToolRecovery(work.tools.find(t => t.name === SOURCE_AUDIT_REPAIR)!);
      expect(() => tool.prepareArguments!({})).toThrow("<nwh-tool-recovery>");
      expect(f.store.journal.history(SOURCE_AUDIT_REPAIR, work.workId)).toHaveLength(1);
      expect(() => tool.prepareArguments!({})).toThrow("ROLE_REVIEW_WORK_HOST_REQUIRED");
      expect(f.store.journal.history(SOURCE_AUDIT_REPAIR, work.workId)).toHaveLength(1);
    }
    await complete(work);
  }, vi.fn()));
  const proof = sourceAuditProofs(f.store)[0]!;
  expect(f.store.journal.history(SOURCE_AUDIT_REPAIR, sourceAuditRepairWorkId(proof.authority.revisionId)).map(r => r.status)).toEqual(["failed", "running", "succeeded"]);
});

it("retains an independent negative verdict and never retries it or certifies on restart", async () => {
  const f = await fixture(), finalize = vi.fn();
  await withWorkspaceOperationLock(f.root, "compiler", async () => {
    await expect(runBoundedRoleReview(f.options, runner(f, "insufficient"), finalize)).rejects.toThrow("independent repair check remains insufficient");
    const again = vi.fn();
    await expect(runBoundedRoleReview(f.options, again, finalize)).rejects.toThrow("independent repair check remains insufficient");
    expect(again).not.toHaveBeenCalled();
  });
  expect(f.store.read("audit", 0)).toEqual(f.audit);
  expect(f.store.auditComplete()).toBe(false);
  expect(finalize).not.toHaveBeenCalled();
});

it("does not grant source repair work after a no-progress stop", async () => {
  const f = await fixture();
  const b = roleReviewBudget(f.root, f.store.planHash, f.original, ROLE_WORK_LIMITS, true, "progress");
  for (let i = 0; i < 12; i++) b.beginCall({ i });
  expect(() => b.beginCall({ exhausted: true })).toThrow(); b.close();
  const execute = vi.fn();
  await withWorkspaceOperationLock(f.root, "compiler", async () => {
    await expect(runBoundedRoleReview(f.options, execute, vi.fn())).rejects.toThrow(/exhausted|usage/);
  });
  expect(execute).not.toHaveBeenCalled();
  expect(sourceAuditAuthorities(f.store)).toEqual([]);
});
