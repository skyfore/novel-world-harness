import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { contentHash } from "../src/world/canonical.js";
import { worldStorageRoot } from "../src/world/paths.js";
import { workspaceStateDir } from "../src/agent/runtime-paths.js";
import { loadCurrentRoleRoster } from "../src/compiler/role-roster-tools.js";
import { RoleRosterStore } from "../src/compiler/role-roster.js";
import { ensureSourceStructure } from "../src/compiler/structure.js";
import { RoleReviewWorkStore, type RoleReviewPlan } from "../src/compiler/role-review-work.js";
import { beginCoreRoleReviewRevision } from "../src/compiler/role-review-revision-service.js";
import { roleReviewBudget } from "../src/compiler/role-review-budget.js";
import { ROLE_WORK_LIMITS } from "../src/workflow/role-review-bounded.js";
import { inspectRoleStartInterruption, grantRoleStartInterruption } from "../src/compiler/role-start-interruption.js";
import { withWorkspaceOperationLock } from "../src/util/workspace-lock.js";
import { RequirementLedger } from "../src/compiler/requirement-ledger.js";
import { roleQuestions } from "../src/compiler/role-review-verification.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "role-start-interruption-")); roots.push(root);
  const f = await createEvidenceFixture(root, "Hero waits.\n"); await ensureSourceStructure(root, f.source);
  const canon = new CanonicalModelStore(root), hero = { id: "hero", canonicalName: "Hero", kind: "character" as const, aliases: [] as string[], evidence: f.evidence("Hero") };
  await canon.putEntity(hero);
  const { roster, structure } = await loadCurrentRoleRoster(root, f.source.id);
  const old = await RoleReviewWorkStore.open(root, { version: 1, sourceId: f.source.id, sourceHash: roster.sourceSha256, subjectHash: roster.subjectHash,
    batchId: `role-roster-${f.source.id}-original`, structureHash: contentHash(structure), spans: [{ start: 0, end: f.source.bytes }], legacyDraftHashes: [] });
  await old.submit("source", 0, { summary: "Original evidence", findings: [], openQuestions: [] }, () => {});
  const entry = { candidateId: roster.candidates[0]!.id, importance: "major" as const, rationale: "Viewpoint", basisUnitIds: roster.unitIds,
    developmentExpectation: { kind: "unknown" as const, rationale: "No later evidence", basisUnitIds: roster.unitIds } };
  old.journal.record("propose_role_roster_entry", { subjectHash: roster.subjectHash, entry }, "succeeded");
  const saved = { ...roster, reviews: [{ runId: "legacy", subjectHash: roster.subjectHash, reviewedUnitIds: roster.unitIds, entries: [entry], missingMajorCharacters: [] }] };
  await new RoleRosterStore(root).write(saved);
  await old.beginAttempt(old.claimWorkId(entry.candidateId));
  const budget = roleReviewBudget(root, old.planHash, old.claimWorkId(entry.candidateId), ROLE_WORK_LIMITS, false, "progress"); budget.beginCall({}); budget.close();
  await canon.putEntity({ ...hero, aliases: ["Source alias"] });
  const revision = await beginCoreRoleReviewRevision(root, { sourceId: f.source.id, revisionId: "successor", priorRosterHash: contentHash(saved),
    expectedWorkPlanHash: old.planHash, scopeDecisionRef: "fixture-host", reason: "Revalidate changed subject" });
  const store = new RoleReviewWorkStore(root, revision.workMigration!.nextPlan), workId = store.claimWorkId(entry.candidateId);
  expect(await store.beginAttempt(workId)).toBe(2);
  const base = path.join(worldStorageRoot(root), "compiler", "role-review-work");
  const attemptFile = path.join(base, "v1", contentHash(f.source.id), "attempts", contentHash(store.plan.batchId), contentHash(workId), "2.json");
  const originalAttempt = await fs.readFile(attemptFile, "utf8");
  const archive = path.join(workspaceStateDir(root), "locks", "recovered", "compiler-fixture.lock"); await fs.mkdir(archive, { recursive: true });
  const owner = { version: 1, pid: 99999999, token: "old-owner", startedAt: new Date(Date.now() - 60000).toISOString(), host: { hostname: "fixture", bootId: "boot", pidNamespace: "pid:fixture" } };
  await fs.writeFile(path.join(archive, "owner.json"), JSON.stringify(owner));
  await fs.writeFile(path.join(archive, "recovery.json"), JSON.stringify({ version: 1, recoveredAt: new Date(Date.now() + 1).toISOString(), host: owner.host, owner, archivePath: archive }));
  const input = { sourceId: f.source.id, batchId: store.plan.batchId, workId, expectedAttemptHash: contentHash(JSON.parse(originalAttempt)), lockRecoveryArchive: archive, implementationRef: "fixture verified hash lookup repair" };
  return { root, store, base, input, attemptFile, originalAttempt };
}

it("continues the same unstarted invocation once without replacing its record or granting another attempt", async () => {
  const f = await fixture(), preview = await inspectRoleStartInterruption(f.root, f.input);
  await expect(f.store.beginAttempt(f.input.workId)).rejects.toThrow("allowance exhausted");
  await expect(grantRoleStartInterruption(f.root, f.input, preview.authorityHash)).rejects.toThrow("compiler lock");
  await withWorkspaceOperationLock(f.root, "compiler", async () => {
    await grantRoleStartInterruption(f.root, f.input, preview.authorityHash);
    expect(await f.store.beginAttempt(f.input.workId)).toBe(2);
    await expect(f.store.beginAttempt(f.input.workId)).rejects.toThrow("already consumed");
  });
  expect(await fs.readFile(f.attemptFile, "utf8")).toBe(f.originalAttempt);
  const inherited = f.store.inheritedAllowance(f.input.workId)!.budget!;
  const budget = roleReviewBudget(f.root, f.store.planHash, f.input.workId, ROLE_WORK_LIMITS, true, "progress", inherited);
  expect(budget.snapshot()).toEqual(inherited.state.usage); budget.close();
});

it.each(["context", "budget", "attempt", "archive"] as const)("rejects %s changes after preview instead of guessing pre-session safety", async change => {
  const f = await fixture(), preview = await inspectRoleStartInterruption(f.root, f.input);
  await withWorkspaceOperationLock(f.root, "compiler", () => grantRoleStartInterruption(f.root, f.input, preview.authorityHash));
  if (change === "context") await fs.mkdir(path.join(f.base, "context-loops", f.store.planHash, contentHash(f.input.workId), contentHash("original-task")), { recursive: true });
  if (change === "budget") {
    const budget = roleReviewBudget(f.root, f.store.planHash, f.input.workId, ROLE_WORK_LIMITS, false, "progress", f.store.inheritedAllowance(f.input.workId)!.budget);
    budget.beginCall({}); budget.close();
  }
  if (change === "attempt") await fs.writeFile(f.attemptFile, JSON.stringify({ ...JSON.parse(f.originalAttempt), workId: "foreign" }));
  if (change === "archive") {
    const file = path.join(f.input.lockRecoveryArchive, "recovery.json"), proof = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, JSON.stringify({ ...proof, recoveredAt: "2000-01-01T00:00:00Z" }));
  }
  await expect(f.store.beginAttempt(f.input.workId)).rejects.toThrow("ROLE_REVIEW_WORK_HOST_REQUIRED");
  await expect(fs.stat(`${preview.file}.used`)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps a large migration's identity stable and resolves repeated budgets without rehashing the whole plan", () => {
  const ids = Array.from({ length: 76 }, (_, i) => `candidate-${i}`), spans = Array.from({ length: 137 }, (_, i) => ({ start: i, end: i + 1 }));
  const plan: RoleReviewPlan = { version: 1, sourceId: "source", sourceHash: "0".repeat(64), subjectHash: "1".repeat(64), structureHash: "2".repeat(64), batchId: "successor", reviewRevisionId: "revision", spans, legacyDraftHashes: [],
    migration: { revisionId: "revision", priorBatchId: "prior", priorPlanHash: "3".repeat(64), candidateIds: ids,
      sourceWork: spans.map(() => ({ summary: "x".repeat(1500), findings: [], openQuestions: Array.from({ length: 10 }, () => "y".repeat(500)) })), entries: [],
      allowances: [...spans.flatMap((_, i) => ["source", "audit"].map(kind => ({ key: `${kind}:${i}`, attempts: 1 }))), ...ids.flatMap(id => [{ key: `candidate:${id}`, attempts: 1 }, { key: `claim:${id}`, attempts: 1 }])] } };
  const hash = contentHash(plan), store = new RoleReviewWorkStore("/tmp/readonly-role-hash-test", plan), workId = store.claimWorkId(ids[0]!);
  plan.spans[0]!.end = 999; plan.migration!.allowances.at(-1)!.attempts = 2;
  expect(store.planHash).toBe(hash); expect(contentHash(store.plan)).toBe(hash);
  expect(() => { store.plan.spans[0]!.end = 999; }).toThrow();
  const start = performance.now();
  for (let i = 0; i < 1000; i++) expect(store.inheritedAllowance(workId)).toEqual({ key: `claim:${ids[0]}`, attempts: 1 });
  expect(performance.now() - start).toBeLessThan(1000);
});

it("resumes already registered questions in bulk while retaining duplicate identity checks", async () => {
  const f = await fixture(), ledger = new RequirementLedger(f.root, f.input.sourceId);
  const questions = roleQuestions(f.store.planHash, 0, { findings: [], openQuestions: ["Who waited?", "Why wait?"] });
  await ledger.registerRoleQuestions([...questions, ...questions]);
  const before = await ledger.history();
  await ledger.registerRoleQuestions(questions);
  expect(await ledger.history()).toEqual(before);
  expect(before.filter(record => record.payload.kind === "role-review-question")).toHaveLength(2);
  const changed = { ...questions[0]!, text: "Different question" };
  await expect(ledger.registerRoleQuestions([changed])).rejects.toThrow("identity collision");
});
