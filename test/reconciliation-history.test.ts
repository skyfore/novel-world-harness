import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { CompilerFinishReceipts } from "../src/compiler/finish-receipts.js";
import { assertReconciliationDeferralsReviewed, captureReconciliationObligations, reconciliationObligationIssues,
  restoreReconciliationObligations, reviewReconciliationDeferrals } from "../src/compiler/reconciliation-review-ledger.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { worldStorageRoot } from "../src/world/paths.js";
import { contentHash } from "../src/world/canonical.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { validateAssessmentRevision } from "../src/compiler/certification.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function setup(content = "Ada waits for news.") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-retained-review-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, content);
  const sourceId = fixture.source.id, batchId = `reconcile-${sourceId}-legacy-review`;
  const receipts = new CompilerFinishReceipts(root, sourceId, batchId);
  const receipt = await receipts.prepare({ version: 1, sourceId, sourceSha256: fixture.source.contentSha256, batchId,
    input: { outcome: "no-artifacts", reviewed_segments: [], summary: "Source review required",
      target_reviews: [{ target: "character:ada", disposition: "capability-gap", evidence_segment_ids: [fixture.segmentId], summary: "The source does not yet support a driver" }] },
    segments: [], dependencies: [], metadata: {},
  });
  return { root, fixture, sourceId, batchId, receipts, receipt };
}

it("keeps retired completed and prepared deferrals actionable without replaying them", async () => {
  for (const completed of [false, true]) {
    const f = await setup();
    if (completed) await f.receipts.complete(f.receipt.fingerprint);
    await f.receipts.archive("Host explicitly retires the attempt before reparse");
    expect(await f.receipts.read()).toBeUndefined();
    await expect(assertReconciliationDeferralsReviewed(f.root, f.sourceId)).rejects.toThrow("character:ada");
    await reviewReconciliationDeferrals(f.root, { sourceId: f.sourceId, batchId: f.batchId, finishFingerprint: f.receipt.fingerprint,
      reviewedAt: new Date().toISOString(), reviews: [{ target: "character:ada", reason: "Reviewed the original immutable passage; no invented driver authorized", auditRef: "independent-host-review" }] });
    await expect(assertReconciliationDeferralsReviewed(f.root, f.sourceId)).resolves.toBeUndefined();
    expect(await f.receipts.read()).toBeUndefined();
    expect((await CompilerFinishReceipts.listRetained(f.root, f.sourceId))[0]!.receipt.state).toBe(completed ? "completed" : "prepared");
  }
});

it("does not let a replacement batch or corrupt archive hide the original obligation", async () => {
  const f = await setup(); await f.receipts.complete(f.receipt.fingerprint);
  const reason = "New namespace does not reset source review";
  await f.receipts.archive(reason);
  const replacement = await f.receipts.prepare({ ...f.receipt.identity, input: { outcome: "no-artifacts", reviewed_segments: [], summary: "No current audit target" } });
  await f.receipts.complete(replacement.fingerprint);
  await expect(assertReconciliationDeferralsReviewed(f.root, f.sourceId)).rejects.toThrow("character:ada");
  const archive = path.join(worldStorageRoot(f.root), "compiler", "finish-receipts", f.sourceId, "history", contentHash(f.batchId), `${f.receipt.fingerprint}-${contentHash(reason)}.json`);
  const original = await fs.readFile(archive, "utf8"), changed = JSON.parse(original);
  changed.receipt.identity.input.target_reviews = [];
  await fs.writeFile(archive, JSON.stringify(changed));
  await expect(captureReconciliationObligations(f.root, f.sourceId)).rejects.toThrow("fingerprint mismatch");
  await fs.writeFile(archive, original);
  expect(await captureReconciliationObligations(f.root, f.sourceId)).toHaveLength(1);
});

it("restores accountability as history and refuses to lose a local obligation or change a review", async () => {
  const f = await setup(); await f.receipts.complete(f.receipt.fingerprint);
  const snapshot = await captureReconciliationObligations(f.root, f.sourceId);
  const importedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-retained-import-")); roots.push(importedRoot);
  await restoreReconciliationObligations(importedRoot, f.sourceId, snapshot);
  expect(await new CompilerFinishReceipts(importedRoot, f.sourceId, f.batchId).read()).toBeUndefined();
  expect(await captureReconciliationObligations(importedRoot, f.sourceId)).toEqual(snapshot);
  await expect(assertReconciliationDeferralsReviewed(importedRoot, f.sourceId)).rejects.toThrow("character:ada");
  await expect(restoreReconciliationObligations(importedRoot, f.sourceId, [])).rejects.toThrow("forget or alter");
  const bad = structuredClone(snapshot);
  bad[0]!.decision = { sourceId: f.sourceId, batchId: f.batchId, finishFingerprint: f.receipt.fingerprint,
    reviewedAt: new Date().toISOString(), reviews: [] };
  await expect(restoreReconciliationObligations(importedRoot, f.sourceId, bad)).rejects.toThrow("scope mismatch");
  expect(reconciliationObligationIssues(snapshot, "foreign-source").join()).toContain("source mismatch");
});

it("carries unreviewed history into real candidate certification and preflights destructive restoration", async () => {
  const f = await setup(); await f.receipts.complete(f.receipt.fingerprint);
  await f.receipts.archive("Prepare a clean rebuild while retaining source debt");
  const canon = new CanonicalModelStore(f.root);
  const entity = { id: "ada", kind: "character" as const, canonicalName: "Ada", aliases: [], evidence: f.fixture.evidence("Ada") };
  await canon.putEntity(entity);
  await new InitialWorldStore(f.root).put({ version: 1, delta: { version: 1, operations: [{ op: "set", entityId: "ada", field: "character.alive", value: true }] }, evidence: f.fixture.evidence("Ada waits for news.") });
  const batches = await prepareCompilerBatches(f.root, f.fixture.source);
  await new CompilerBatchStore(f.root).replaceCompleted(f.sourceId, batches.map(batch => batch.id));
  const cache = new PreparedNovelCache(f.root, path.join(f.root, "cache"));
  const candidate = await cache.inspectCandidate(f.fixture.source);
  expect(candidate.bundle.compilerSnapshot.reconciliationObligations).toHaveLength(1);
  expect(candidate.assessment.issues.some(issue => issue.code === "RECONCILIATION_OBLIGATION_UNRESOLVED")).toBe(true);
  expect(validateAssessmentRevision(candidate.bundle, candidate.assessment).join()).toContain("character:ada");
  const archive = await cache.publish(f.fixture.source, { allowSemanticDebtForRollback: true });
  await reviewReconciliationDeferrals(f.root, { sourceId: f.sourceId, batchId: f.batchId, finishFingerprint: f.receipt.fingerprint, reviewedAt: new Date().toISOString(), reviews: [{ target: "character:ada", reason: "Original source reviewed", auditRef: "host-review" }] });
  // Restoring an old no-decision snapshot must not undo an existing audited decision.
  await canon.putEntity({ ...entity, aliases: ["current version"] });
  await expect(cache.restoreCompilerCheckpoint(f.fixture.source, archive.bundleHash!)).rejects.toThrow("forget or alter");
  expect((await canon.listEntities())[0]!.aliases).toEqual(["current version"]);
  const after = await cache.inspectCandidate(f.fixture.source);
  expect(after.assessment.issues.some(issue => issue.code === "RECONCILIATION_OBLIGATION_UNRESOLVED")).toBe(false);
  expect(after.assessment.fullNovelReady).toBe(false); // Workflow review is not world certification.
});
