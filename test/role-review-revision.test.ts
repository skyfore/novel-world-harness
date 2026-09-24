import { roleReviewFinishIssues, roleReviewResumeIssues } from "../src/compiler/role-review-finish.js";
import { reconciliationObligationSnapshotSchema } from "../src/compiler/reconciliation-review-ledger.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { RoleRosterStore, buildRoleRoster, roleRosterSchema } from "../src/compiler/role-roster.js";
import { ensureSourceStructure } from "../src/compiler/structure.js";
import { RequirementLedger, requirementJournalBindingIssues } from "../src/compiler/requirement-ledger.js";
import { registerReviewedCoreRoles } from "../src/compiler/core-role-requirement-service.js";
import { beginCoreRoleReviewRevision } from "../src/compiler/role-review-revision-service.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { loadCurrentRoleRoster } from "../src/compiler/role-roster-tools.js";
import { reviewNovelRoles } from "../src/workflow/role-review.js";
import { contentHash } from "../src/world/canonical.js";
import { CompilerFinishReceipts } from "../src/compiler/finish-receipts.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { preparedSubjectHash } from "../src/compiler/certification.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture(count = 2) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-role-review-revision-")); roots.push(root);
  const source = await createEvidenceFixture(root, "Hero waits. Friend watches.");
  const canon = new CanonicalModelStore(root);
  const entities = ["Hero", "Friend"].map(name => ({ id: name.toLowerCase(), canonicalName: name, kind: "character" as const, aliases: [], evidence: source.evidence(name) }));
  for (const entity of entities) await canon.putEntity(entity);
  const structure = await ensureSourceStructure(root, source.source);
  const roster = buildRoleRoster({ sourceId: source.source.id, sourceSha256: source.source.contentSha256, unitIds: structure.baseUnitIds, entities, annotations: [], resolutions: [] });
  roster.reviews = Array.from({ length: count }, (_, index) => ({ runId: `legacy-${index}`, subjectHash: roster.subjectHash, reviewedUnitIds: roster.unitIds,
    entries: roster.candidates.map(candidate => ({ candidateId: candidate.id, importance: "major", rationale: "Legacy source review", basisUnitIds: roster.unitIds })),
  }));
  const saved = roleRosterSchema.parse(roster), store = new RoleRosterStore(root); await store.write(saved);
  const definition = await registerReviewedCoreRoles(root, { source: source.source, structure, roster: saved });
  const ledger = new RequirementLedger(root, source.source.id);
  const input = { sourceId: source.source.id, revisionId: "development-v2", priorRosterHash: contentHash(saved), predecessorDefinitionRevision: definition?.revisionHash, scopeDecisionRef: "host-review-20260916", reason: "Review legacy missing development expectations without erasing them" };
  return { root, source, canon, store, saved, definition, ledger, input };
}
async function prepareReview(root: string, sourceId: string, batchId: string, shrink = false) {
  const tools = createCompilerProposalToolset(root); await tools.beginBatch([], batchId, sourceId);
  const call = (name: string, input: unknown) => tools.tools.find(tool => tool.name === name)!.execute(name, input as never, undefined, undefined, {} as never);
  const roster = JSON.parse(((await call("read_role_roster", { offset: 0 })).content[0] as { text: string }).text);
  const page = JSON.parse(((await call("read_roster_source_page", { page: 0 })).content[0] as { text: string }).text);
  expect(roster.reviews).toBeUndefined();
  await call("propose_role_roster_review", { subjectHash: roster.subjectHash, entries: roster.candidates.map((candidate: { id: string; name: string }) => ({ candidateId: candidate.id,
    importance: shrink && candidate.name === "Friend" ? "supporting" : "major", rationale: "Independent current source review", basisUnitIds: page.unitIds,
    developmentExpectation: { kind: "stable", rationale: "No lasting change is supported by this short source", basisUnitIds: page.unitIds },
  })) });
  return () => call("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Independent full source review" });
}

it("preserves legacy reviews, recovers the revision pointer and completes two independently finished new reviews", async () => {
  const f = await fixture();
  await new InitialWorldStore(f.root).put({ version: 1, evidence: f.source.evidence("Hero waits."), participantPresence: [{ entityId: "hero", mode: "physical" }], delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }, { op: "set", entityId: "hero", field: "character.plan", value: "wait" }] } });
  const batches = await prepareCompilerBatches(f.root, f.source.source); await new CompilerBatchStore(f.root).replaceCompleted(f.source.source.id, batches.map(batch => batch.id));
  const cache = new PreparedNovelCache(f.root, path.join(f.root, "cache")), before = await cache.candidateSnapshot(f.source.source);
  const write = vi.spyOn(RoleRosterStore.prototype, "write").mockRejectedValueOnce(new Error("interrupted pointer publication"));
  await expect(beginCoreRoleReviewRevision(f.root, f.input)).rejects.toThrow("interrupted pointer publication");
  expect(await f.store.read(f.source.source.id)).toEqual(f.saved);
  expect((await f.ledger.roleReviewRevisions())[0]!.priorRoster).toEqual(f.saved);
  await expect(loadCurrentRoleRoster(f.root, f.source.source.id)).rejects.toThrow("Stop model retries");
  write.mockRestore();
  await beginCoreRoleReviewRevision(f.root, f.input);
  const pending = await cache.inspectCandidate(f.source.source);
  expect(preparedSubjectHash(pending.bundle)).not.toBe(preparedSubjectHash(before));
  expect(pending.assessment.issues.some(issue => issue.message.includes("CORE_ROLE_REVIEW_REVISION_PENDING"))).toBe(true);
  const missingAuthorization = structuredClone(pending.bundle.compilerSnapshot); delete missingAuthorization.requirementJournal;
  expect(requirementJournalBindingIssues(missingAuthorization, f.source.source.id, f.source.source.contentSha256)).toContain("CORE_ROLE_REVIEW_REVISION_MISMATCH");
  const pendingArchive = await cache.archiveCandidate(f.source.source);
  let calls = 0;
  await reviewNovelRoles({ root: f.root, sourceId: f.source.source.id, configPath: path.join(f.root, "absent.yaml") }, async options => {
    calls++;
    await (await prepareReview(f.root, f.source.source.id, options.compilerBatchId!))();
    if (calls === 1) {
      await beginCoreRoleReviewRevision(f.root, f.input);
      expect((await f.store.read(f.source.source.id))!.reviews).toHaveLength(1);
      await expect(cache.restoreCompilerCheckpoint(f.source.source, pendingArchive.bundleHash!)).rejects.toThrow("discard or rewrite current audit history");
      expect((await f.store.read(f.source.source.id))!.reviews).toHaveLength(1);
      await expect(beginCoreRoleReviewRevision(f.root, { ...f.input, revisionId: "reset-partial", priorRosterHash: contentHash((await f.store.read(f.source.source.id))!) })).rejects.toThrow("incomplete");
    }
  });
  expect(calls).toBe(2);
  const current = (await f.store.read(f.source.source.id))!;
  expect(current.reviews.every(review => review.version === 2 && review.reviewRevisionId === f.input.revisionId)).toBe(true);
  expect(new Set(current.reviews.map(review => review.runId)).size).toBe(2);
  expect((await f.ledger.roleReviewRevisions())[0]!.priorRoster).toEqual(f.saved);
  expect(await f.ledger.coreRoleDefinitionHistory()).toHaveLength(2);
  const candidate = await cache.inspectCandidate(f.source.source);
  expect(candidate.assessment.issues.some(issue => issue.message.includes("CORE_ROLE_REVIEW_REVISION_PENDING"))).toBe(false);
  expect(candidate.bundle.compilerSnapshot.coreRoleReviewRevision?.id).toBe(f.input.revisionId);
  const archive = await cache.archiveCandidate(f.source.source);
  const cloneRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-review-revision-clone-")); roots.push(cloneRoot);
  const cloneSource = await createEvidenceFixture(cloneRoot, "Hero waits. Friend watches.");
  await new PreparedNovelCache(cloneRoot, path.join(f.root, "cache")).restoreCompilerCheckpoint(cloneSource.source, archive.bundleHash!);
  expect(await new RequirementLedger(cloneRoot, cloneSource.source.id).history()).toEqual(await f.ledger.history());
  expect((await loadCurrentRoleRoster(cloneRoot, cloneSource.source.id)).roster).toEqual(current);
});

it("requires a separate concrete scope decision when new reviews remove old major-role obligations", async () => {
  const f = await fixture(); await beginCoreRoleReviewRevision(f.root, f.input);
  let lastBatch = "";
  await expect(reviewNovelRoles({ root: f.root, sourceId: f.source.source.id }, async options => {
    lastBatch = options.compilerBatchId!;
    await (await prepareReview(f.root, f.source.source.id, lastBatch, true))();
  })).rejects.toThrow("removes retained major roles");
  expect((await f.store.read(f.source.source.id))!.reviews).toHaveLength(2);
  expect(await f.ledger.coreRoleDefinitionHistory()).toHaveLength(1);
  const definition = await registerReviewedCoreRoles(f.root, await loadCurrentRoleRoster(f.root, f.source.source.id), { predecessorRevision: f.definition!.revisionHash, scopeDecisionRef: "host-inspected-new-reviews", scopeChangeReason: "Concrete source review classifies Friend as supporting; prior obligations remain in history" });
  expect(definition!.removedRequirementIds).toHaveLength(3);
  await reviewNovelRoles({ root: f.root, sourceId: f.source.source.id }, async () => { throw new Error("Recovery must not open another model review"); });
  expect((await new CompilerFinishReceipts(f.root, f.source.source.id, lastBatch).read())!.state).toBe("completed");
  expect(await f.ledger.coreRoleDefinitionHistory()).toHaveLength(2);
});

it("preserves partial old work and rejects its in-flight proposal after the host starts another review epoch", async () => {
  const f = await fixture(1), finish = await prepareReview(f.root, f.source.source.id, `role-roster-${f.source.source.id}-old-inflight`);
  const revision = await beginCoreRoleReviewRevision(f.root, f.input);
  expect(revision.priorRoster.reviews).toHaveLength(1);
  await expect(finish()).rejects.toThrow("ROSTER_REVIEW_REVISION_STALE");
  expect((await f.store.read(f.source.source.id))!.reviews).toEqual([]);
  expect(await f.ledger.coreRoleDefinitionHistory()).toEqual([]);
});

it("stops on a stale host predecessor, pending finish or changed identity without erasing the saved roster", async () => {
  const f = await fixture(); const before = await f.ledger.history();
  await expect(beginCoreRoleReviewRevision(f.root, { ...f.input, priorRosterHash: "0".repeat(64) })).rejects.toThrow("copy savedRosterHash");
  expect(await f.ledger.history()).toEqual(before);
  const hero = await f.canon.getEntity("hero"); await f.canon.putEntity({ ...hero, aliases: ["Changed identity inventory"] });
  await expect(loadCurrentRoleRoster(f.root, f.source.source.id)).rejects.toThrow("source identity");
  expect(await f.store.read(f.source.source.id)).toEqual(f.saved);
  const receipts = new CompilerFinishReceipts(f.root, f.source.source.id, `role-roster-${f.source.source.id}-pending`);
  await receipts.prepare({ version: 1, sourceId: f.source.source.id, sourceSha256: f.source.source.contentSha256, batchId: receipts.batchId, input: { outcome: "complete", reviewed_segments: [], summary: "Prepared source review" }, segments: [], dependencies: [], metadata: { roleReview: f.saved.reviews[0]! } });
  await expect(beginCoreRoleReviewRevision(f.root, f.input)).rejects.toThrow("still prepared");
  expect(await f.ledger.history()).toEqual(before);
  await receipts.archive("Host explicitly retires the old prepared review after its identity scope changed");
  await beginCoreRoleReviewRevision(f.root, f.input);
  const revised = await loadCurrentRoleRoster(f.root, f.source.source.id);
  expect(revised.roster.subjectHash).not.toBe(f.saved.subjectHash);
  expect((await f.ledger.roleReviewRevisions())[0]!.priorRoster).toEqual(f.saved);
  expect((await CompilerFinishReceipts.listRetained(f.root, f.source.source.id))[0]!.archived).toBe(true);
});

it.each(["before-save", "before-completion", "retired"])("restores an active prepared pure role finish after %s and completes it before asking for the second review", async interruption => {
  const f = await fixture(); await beginCoreRoleReviewRevision(f.root, f.input);
  await new InitialWorldStore(f.root).put({ version: 1, evidence: f.source.evidence("Hero waits."), participantPresence: [{ entityId: "hero", mode: "physical" }], delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }, { op: "set", entityId: "hero", field: "character.plan", value: "wait" }] } });
  const batches = await prepareCompilerBatches(f.root, f.source.source); await new CompilerBatchStore(f.root).replaceCompleted(f.source.source.id, batches.map(batch => batch.id));
  const batchId = `role-roster-${f.source.source.id}-interrupted`, finish = await prepareReview(f.root, f.source.source.id, batchId);
  const completion = interruption === "before-save" ? vi.spyOn(RoleRosterStore.prototype, "write").mockRejectedValueOnce(new Error("interruption before completed marker")) : vi.spyOn(CompilerFinishReceipts.prototype, "complete").mockRejectedValueOnce(new Error("interruption before completed marker"));
  await expect(finish()).rejects.toThrow("interruption before completed marker"); completion.mockRestore();
  const receipt = (await new CompilerFinishReceipts(f.root, f.source.source.id, batchId).read())!;
  expect(receipt.state).toBe("prepared");
  if (interruption === "retired") await new CompilerFinishReceipts(f.root, f.source.source.id, batchId).archive("Explicit host retirement; do not reactivate this role finish");
  const cache = new PreparedNovelCache(f.root, path.join(f.root, "cache")), candidate = await cache.inspectCandidate(f.source.source);
  const frozen = candidate.bundle.compilerSnapshot.reconciliationObligations!;
  expect(frozen.find(item => item.receipt.fingerprint === receipt.fingerprint)?.resumeRoleReview).toBe(interruption === "retired" ? undefined : true);
  expect(roleReviewFinishIssues(frozen, candidate.bundle.compilerSnapshot.roleRoster, f.source.source.id)).toContain(`ROLE_REVIEW_FINISH_INCOMPLETE: ${batchId}`);
  expect(candidate.assessment.issues.some(issue => issue.message.includes("ROLE_REVIEW_FINISH_INCOMPLETE"))).toBe(true);
  if (interruption !== "before-save") expect(roleReviewFinishIssues([], candidate.bundle.compilerSnapshot.roleRoster, f.source.source.id)).toContain(`ROLE_REVIEW_FINISH_MISSING: ${batchId}`);
  const badScope = structuredClone(candidate.bundle.compilerSnapshot.roleRoster)!; badScope.reviewRevisionId = "other-epoch";
  if (interruption !== "retired") expect(roleReviewResumeIssues(frozen, badScope, f.source.source.id).join()).toContain("ROLE_REVIEW_RESUME_SCOPE_MISMATCH");
  const unsafe = structuredClone(frozen); unsafe[0]!.resumeRoleReview = true; unsafe[0]!.receipt.identity.dependencies = [{ store: "world", proposalId: "unrelated-write", hash: "0".repeat(64) }];
  unsafe[0]!.receipt.fingerprint = contentHash(unsafe[0]!.receipt.identity);
  expect(() => reconciliationObligationSnapshotSchema.parse(unsafe)).toThrow("Only an active pure prepared role-review");
  const archive = await cache.archiveCandidate(f.source.source);
  const cloneRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-role-finish-restore-")); roots.push(cloneRoot);
  const cloneSource = await createEvidenceFixture(cloneRoot, "Hero waits. Friend watches.");
  const cloneCache = new PreparedNovelCache(cloneRoot, path.join(f.root, "cache"));
  await cloneCache.restoreCompilerCheckpoint(cloneSource.source, archive.bundleHash!);
  await cloneCache.restoreCompilerCheckpoint(cloneSource.source, archive.bundleHash!);
  if (interruption === "retired") {
    expect(await new CompilerFinishReceipts(cloneRoot, cloneSource.source.id, batchId).read()).toBeUndefined();
    const model = vi.fn(async () => undefined);
    await expect(reviewNovelRoles({ root: cloneRoot, sourceId: cloneSource.source.id }, model)).rejects.toThrow("ROLE_REVIEW_FINISH_REQUIRES_HOST_REVIEW");
    expect(model).not.toHaveBeenCalled();
    const saved = (await new RoleRosterStore(cloneRoot).read(cloneSource.source.id))!;
    await beginCoreRoleReviewRevision(cloneRoot, { ...f.input, revisionId: "replacement-for-retired-review", priorRosterHash: contentHash(saved), reason: "Host requests fresh reviews while retaining the unfinished retired report" });
    expect((await new RequirementLedger(cloneRoot, cloneSource.source.id).roleReviewRevisions()).at(-1)!.priorRoster).toEqual(saved);
    return;
  }
  expect((await new CompilerFinishReceipts(cloneRoot, cloneSource.source.id, batchId).read())!.state).toBe("prepared");
  let modelCalls = 0;
  await reviewNovelRoles({ root: cloneRoot, sourceId: cloneSource.source.id }, async options => {
    modelCalls++;
    expect((await new CompilerFinishReceipts(cloneRoot, cloneSource.source.id, batchId).read())!.state).toBe("completed");
    expect((await new RoleRosterStore(cloneRoot).read(cloneSource.source.id))!.reviews).toHaveLength(1);
    await expect(cloneCache.restoreCompilerCheckpoint(cloneSource.source, archive.bundleHash!)).rejects.toThrow();
    await (await prepareReview(cloneRoot, cloneSource.source.id, options.compilerBatchId!))();
  });
  expect(modelCalls).toBe(1);
  const reviewed = (await new RoleRosterStore(cloneRoot).read(cloneSource.source.id))!;
  expect(reviewed.reviews[0]).toEqual(receipt.identity.metadata.roleReview);
  const finished = await cloneCache.inspectCandidate(cloneSource.source);
  expect(roleReviewFinishIssues(finished.bundle.compilerSnapshot.reconciliationObligations ?? [], reviewed, cloneSource.source.id)).toEqual([]);
  expect((await new CompilerFinishReceipts(f.root, f.source.source.id, batchId).read())!.state).toBe("prepared");
  await expect(cloneCache.restoreCompilerCheckpoint(cloneSource.source, archive.bundleHash!)).rejects.toThrow();
});

it("invalidates prior role results on a host revision and recovers observation after a completed finish", async () => {
  const { settleCoreRoleRequirements } = await import("../src/compiler/core-role-requirement-service.js");
  const { recoverCompilerFinish } = await import("../src/compiler/finish-recovery.js");
  const f = await fixture();
  await new InitialWorldStore(f.root).put({ version: 1, evidence: f.source.evidence("Hero waits."), participantPresence: [{ entityId: "hero", mode: "physical" }], delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }, { op: "set", entityId: "hero", field: "character.plan", value: "wait" }] } });
  const batches = await prepareCompilerBatches(f.root, f.source.source); await new CompilerBatchStore(f.root).replaceCompleted(f.source.source.id, batches.map(batch => batch.id));
  await settleCoreRoleRequirements(f.root, f.source.source.id, path.join(f.root, "cache"));
  await beginCoreRoleReviewRevision(f.root, f.input);
  let history = await f.ledger.history();
  expect(history.filter(record => record.payload.kind === "core-role-invalidation")).toHaveLength(1);
  const unchanged = history;
  await beginCoreRoleReviewRevision(f.root, f.input);
  expect(await f.ledger.history()).toEqual(unchanged);
  const batchId = `role-roster-${f.source.source.id}-observed`;
  const finish = await prepareReview(f.root, f.source.source.id, batchId);
  // Only interrupt observation after the receipt was actually marked completed.
  const original = CompilerFinishReceipts.prototype.complete;
  vi.spyOn(CompilerFinishReceipts.prototype, "complete").mockImplementationOnce(async function (this: CompilerFinishReceipts, fingerprint) {
    const result = await original.call(this, fingerprint);
    vi.spyOn(RequirementLedger.prototype, "invalidateCoreRoleEvaluation").mockRejectedValueOnce(new Error("interrupted post-finish observation"));
    return result;
  });
  await expect(finish()).rejects.toThrow("Committed writes remain committed");
  expect((await new CompilerFinishReceipts(f.root, f.source.source.id, batchId).read())!.state).toBe("completed");
  const saved = await f.store.read(f.source.source.id);
  expect(saved!.reviews).toHaveLength(1);
  vi.restoreAllMocks();
  await recoverCompilerFinish(f.root, f.source.source.id, batchId);
  await recoverCompilerFinish(f.root, f.source.source.id, batchId);
  expect(await f.store.read(f.source.source.id)).toEqual(saved);
  history = await f.ledger.history();
  expect(history.filter(record => record.payload.kind === "core-role-evaluation")).toHaveLength(1);
  const cache = new PreparedNovelCache(f.root, path.join(f.root, "cache"));
  const currentHash = preparedSubjectHash(await cache.candidateSnapshot(f.source.source));
  expect(history.filter(record => record.payload.kind === "core-role-invalidation" && record.payload.nextSubjectSnapshotHash === currentHash)).toHaveLength(1);
});
