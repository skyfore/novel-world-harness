import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { contentHash } from "../src/world/canonical.js";
import { worldStorageRoot } from "../src/world/paths.js";
import { loadCurrentRoleRoster } from "../src/compiler/role-roster-tools.js";
import { ensureSourceStructure } from "../src/compiler/structure.js";
import { RoleRosterStore, roleRosterSchema } from "../src/compiler/role-roster.js";
import { RoleReviewWorkStore } from "../src/compiler/role-review-work.js";
import { beginCoreRoleReviewRevision } from "../src/compiler/role-review-revision-service.js";
import { assertRetainedRoleWork } from "../src/compiler/role-work-migration.js";
import { inspectMigratedSourceAudit } from "../src/compiler/role-source-audit-revalidation.js";
import { inspectRoleReviewBudget, roleReviewBudget } from "../src/compiler/role-review-budget.js";
import { ROLE_WORK_LIMITS, runBoundedRoleReview } from "../src/workflow/role-review-bounded.js";
import { runWithRoleContextRecovery } from "../src/workflow/role-session-context.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture(options: { exhausted?: boolean; blocked?: boolean; noReceipt?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-audit-revalidation-")); roots.push(root);
  const source = await createEvidenceFixture(root, "Hero helps Friend.\nFriend thanks Hero.\n");
  await ensureSourceStructure(root, source.source);
  const canon = new CanonicalModelStore(root);
  for (const name of ["Hero", "Friend"]) await canon.putEntity({ id: name.toLowerCase(), canonicalName: name,
    kind: "character", aliases: [], evidence: source.evidence(name) });
  const { roster, structure } = await loadCurrentRoleRoster(root, source.source.id), unit = roster.unitIds[0]!;
  const old = await RoleReviewWorkStore.open(root, { version: 1, sourceId: roster.sourceId, sourceHash: roster.sourceSha256,
    subjectHash: roster.subjectHash, batchId: `role-roster-${roster.sourceId}-old`, structureHash: contentHash(structure),
    spans: [{ start: 0, end: source.source.bytes }], legacyDraftHashes: [] });
  await old.submit("source", 0, { summary: "An exchange", findings: [], openQuestions: ["What is their earlier relationship?"] }, () => {});
  const entries = roster.candidates.map(c => ({ candidateId: c.id, importance: "major" as const, rationale: "Source interaction", basisUnitIds: [unit],
    developmentExpectation: { kind: "unknown" as const, rationale: "No later evidence", basisUnitIds: [unit] } }));
  for (const entry of entries) old.journal.record("propose_role_roster_entry", { subjectHash: roster.subjectHash, entry }, "succeeded");
  const oldWorkId = old.workId("audit", 0);
  await old.beginAttempt(oldWorkId);
  const budget = roleReviewBudget(root, old.planHash, oldWorkId, ROLE_WORK_LIMITS, false, "progress");
  await runWithRoleContextRecovery(old, { workId: oldWorkId, prompt: "Original source audit", tools: [], complete: () => true }, async () => {
    budget.beginCall({ original: true });
    if (!options.noReceipt) await old.submit("audit", 0, { rationale: "Retained diagnostic", missingMajorCharacters: [], unresolved: ["Earlier relationship unknown"],
      atlasRevision: old.atlasRevision(), questionDispositions: old.questions(0).map(q => ({ questionId: q.questionId, status: "blocked", rationale: "Earlier events not established", basisUnitIds: [unit] })), discoveryDispositions: [] }, () => {});
  });
  if (options.exhausted) await old.beginAttempt(oldWorkId);
  if (options.blocked) {
    for (let call = 1; call < ROLE_WORK_LIMITS.maxModelCalls; call++) budget.beginCall({ call });
    expect(() => budget.beginCall({ over: true })).toThrow("no new validated progress");
  }
  budget.close();
  const saved = roleRosterSchema.parse({ ...roster, reviews: [{ runId: "legacy-review", subjectHash: roster.subjectHash, reviewedUnitIds: roster.unitIds, entries }] });
  await new RoleRosterStore(root).write(saved);
  const hero = await canon.getEntity("hero"); await canon.putEntity({ ...hero, aliases: ["Source alias"] });
  const revision = await beginCoreRoleReviewRevision(root, { sourceId: roster.sourceId, revisionId: "changed-subject", priorRosterHash: contentHash(saved),
    expectedWorkPlanHash: old.planHash, scopeDecisionRef: "fixture-subject-review", reason: "Revalidate the changed subject, retaining old evidence and every allowance" });
  const store = new RoleReviewWorkStore(root, revision.workMigration!.nextPlan), workId = store.workId("audit", 0);
  // Complete independent current claim verification, with no source audit import.
  for (const entry of store.stagedEntries()) await store.submitClaim({ candidateId: entry.candidateId, claimRevision: contentHash(entry), atlasRevision: store.atlasRevision(),
    packetHash: contentHash(entry), verdict: "supported", rationale: "The unknown boundary follows the fixture", basisUnitIds: [unit], counterevidence: { searchedUnitIds: [unit], rationale: "No further evidence" },
    checks: ["importance", "identity", "development"].map(kind => ({ kind, verdict: "supported", rationale: "Source boundary retained", basisUnitIds: [unit] })) }, entry.candidateId, () => {});
  const scope = { planHash: store.planHash, atlasRevision: store.atlasRevision(), entriesHash: store.entriesHash(), claimAuditsHash: contentHash(store.claimAudits()),
    workIds: [workId], missingSourceWorkIds: [], missingCandidateIds: [], unresolvedClaimWorkIds: [] };
  const runOptions = { root, sourceId: roster.sourceId, compilerBatchId: store.plan.batchId, configPath: path.join(root, "absent.yaml") };
  return { root, old, store, workId, oldWorkId, unit, revision, scope, runOptions };
}

it("revalidates a migrated diagnostic with inherited calls and session ordinals, preserving negative findings and all global gates", async () => {
  const f = await fixture(), proof = await inspectMigratedSourceAudit(f.store, f.workId), finalize = vi.fn();
  const before = inspectRoleReviewBudget(f.root, f.old.planHash, f.oldWorkId);
  await expect(f.store.assertUnstarted(f.workId)).rejects.toThrow("work already started");
  let sessions = 0;
  await runBoundedRoleReview({ ...f.runOptions, sourceAuditScope: { ...f.scope, migratedAudits: [proof] } }, async work => {
    const allowance = f.store.inheritedAllowance(work.workId)!;
    const budget = roleReviewBudget(f.root, f.store.planHash, work.workId, ROLE_WORK_LIMITS, true, "progress", allowance.budget);
    expect(budget.snapshot().modelCalls).toBe(before.state.usage.modelCalls);
    await runWithRoleContextRecovery(f.store, work, async invocation => {
      sessions++;
      expect(invocation.sessionOrdinal).toBe(1);
      const call = (name: string, args: unknown) => invocation.tools.find(t => t.name === name)!.execute(name, args as never, undefined, undefined, {} as never);
      let offset: number | undefined = 0;
      do { const result = await call("read_role_session_context", { offset }); offset = JSON.parse((result.content[0] as { text: string }).text).nextOffset; } while (offset !== undefined);
      budget.beginCall({ revalidation: true });
      await call("read_role_work_evidence", { unitId: f.unit });
      await call("propose_role_review_audit", { rationale: "Current subject independently checked", missingMajorCharacters: [], unresolved: ["Earlier relationship still unknown"],
        atlasRevision: f.store.atlasRevision(), questionDispositions: f.store.questions(0).map(q => ({ questionId: q.questionId, status: "blocked", rationale: "Original source gives no prior history", basisUnitIds: [f.unit] })), discoveryDispositions: [] });
    });
    budget.close();
  }, finalize);
  expect(sessions).toBe(1);
  expect(finalize).not.toHaveBeenCalled();
  expect(f.store.read("audit", 0)?.unresolved).toEqual(["Earlier relationship still unknown"]);
  expect(f.store.auditComplete()).toBe(false);
  expect(inspectRoleReviewBudget(f.root, f.store.planHash, f.workId).state.usage.modelCalls).toBe(before.state.usage.modelCalls + 1);
  expect(inspectRoleReviewBudget(f.root, f.old.planHash, f.oldWorkId)).toEqual(before);
  await assertRetainedRoleWork(f.root, f.revision.workMigration!);
  await expect(f.store.beginAttempt(f.workId)).rejects.toThrow("allowance exhausted");
  await expect(inspectMigratedSourceAudit(f.store, f.workId)).rejects.toThrow("already exists");
});

it.each(["missing", "changed", "duplicate"] as const)("rejects a %s migration proof before reserving an invocation", async kind => {
  const f = await fixture(), proof = await inspectMigratedSourceAudit(f.store, f.workId), runner = vi.fn();
  const migratedAudits = kind === "missing" ? undefined : kind === "changed" ? [{ ...proof, priorReceiptHash: "0".repeat(64) }] : [proof, proof];
  await expect(runBoundedRoleReview({ ...f.runOptions, sourceAuditScope: { ...f.scope, migratedAudits } }, runner, vi.fn())).rejects.toThrow(/already started|preview changed|invalid source audit scope/);
  expect(runner).not.toHaveBeenCalled();
  expect(await inspectMigratedSourceAudit(f.store, f.workId)).toEqual(proof);
});

it.each(["exhausted", "blocked", "noReceipt"] as const)("does not reopen a migrated audit with %s predecessor state", async kind => {
  const f = await fixture({ [kind]: true });
  await expect(inspectMigratedSourceAudit(f.store, f.workId)).rejects.toThrow(/remaining invocation|terminal receipt/);
  await assertRetainedRoleWork(f.root, f.revision.workMigration!);
});

it.each(["attempt", "checkpoint", "budget"] as const)("refuses a current-plan %s even without a proposal", async kind => {
  const f = await fixture();
  if (kind === "attempt") await f.store.beginAttempt(f.workId);
  else {
    const base = path.join(worldStorageRoot(f.root), "compiler", "role-review-work", kind === "checkpoint" ? "context" : "budgets", f.store.planHash);
    await fs.mkdir(base, { recursive: true });
    await fs.writeFile(path.join(base, contentHash(f.workId) + ".json.pending"), "uncertain original task");
  }
  await expect(inspectMigratedSourceAudit(f.store, f.workId)).rejects.toThrow("already has invocation, context or budget state");
});

it("rejects changed predecessor files and wrong work scope without creating a new task", async () => {
  const f = await fixture();
  await expect(inspectMigratedSourceAudit(f.store, f.store.workId("source", 0))).rejects.toThrow("select a migrated source audit");
  const old = roleReviewBudget(f.root, f.old.planHash, f.oldWorkId, ROLE_WORK_LIMITS, true, "progress");
  old.beginCall({ changed: true }); old.close();
  await expect(inspectMigratedSourceAudit(f.store, f.workId)).rejects.toThrow("retained work or budget changed");
});
