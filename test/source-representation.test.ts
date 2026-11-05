import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { runSourceRepresentationReview } from "../src/workflow/source-representation.js";
import { requirementJournalSchema } from "../src/compiler/requirement-ledger.js";
import { representationSemanticHash, validateRepresentationHistory } from "../src/compiler/source-representation.js";
import { representationRequirementResult } from "../src/compiler/source-representation-upstream.js";
import { assertUpstreamRepairMutation, freezeUpstreamRepairPlan, type UpstreamRepairPlan } from "../src/compiler/upstream-repair-plan.js";
import { verifyUpstreamRepairPlan } from "../src/compiler/upstream-repair-preflight.js";
import { UpstreamRepairLedger } from "../src/compiler/upstream-repair-ledger.js";
import { stageUpstreamRepair, upstreamRepairSlotContext } from "../src/compiler/upstream-repair-staging.js";
import { SourceAnnotationStore, discourseObservationSchema } from "../src/compiler/annotations.js";
import { withWorkspaceOperationLock } from "../src/util/workspace-lock.js";
import { contentHash } from "../src/world/canonical.js";
import { upstreamRepairSnapshotIssues } from "../src/compiler/upstream-repair-snapshot.js";

import { representationFixture as fixture, cleanupRepresentationFixtures } from "./helpers/source-representation.js";
afterEach(cleanupRepresentationFixtures);

it("retains exact scopes in fresh Pi sessions and enters only the ordinary host authorization ledger", async () => {
  const f = await fixture(); expect(f.sessions()).toBe(6); expect(f.state.phase).toBe("DONE"); expect(f.state.authorizationGranted).toBe(false);
  expect((await f.ledger.history()).slice(0, f.before.length)).toEqual(f.before);
  expect(await new SourceAnnotationStore(f.root).list(f.f.source.id)).toEqual([]);
  const plan = JSON.parse(await fs.readFile(path.join(f.directory, "upstream-plan.preview.json"), "utf8")) as UpstreamRepairPlan;
  const upstream = new UpstreamRepairLedger(f.root, f.f.source.id);
  expect((await upstream.inspect()).plans).toEqual([]);
  await withWorkspaceOperationLock(f.root, "compiler", async () => { await verifyUpstreamRepairPlan(f.root, plan); await upstream.register(plan); await upstream.authorize(plan.planHash); });
  expect((await upstream.inspect()).plans[0]!.state).toBe("authorized");
  const snapshot = { upstreamRepairJournal: await upstream.history(), requirementJournal: await f.ledger.history() };
  expect(upstreamRepairSnapshotIssues(snapshot, f.f.source.id, f.f.source.contentSha256)).toEqual([]);
  // A definition can be frozen before its postconditions exist; it must still
  // retain the original independent check and every source prerequisite.
  expect(upstreamRepairSnapshotIssues({ ...snapshot, requirementJournal: snapshot.requirementJournal.filter(r => r.payload.kind !== "source-representation") }, f.f.source.id, f.f.source.contentSha256))
    .toContain("UPSTREAM_REPAIR_REPRESENTATION_AUTHORITY_MISMATCH");
  expect(upstreamRepairSnapshotIssues({ ...snapshot, requirementJournal: snapshot.requirementJournal.filter(r => r.payload.kind !== "role-source-prerequisite") }, f.f.source.id, f.f.source.contentSha256))
    .toContain("UPSTREAM_REPAIR_REPRESENTATION_AUTHORITY_MISMATCH");
  expect(plan.allowedCreations).toHaveLength(1); expect(plan.allowedWrites).toEqual([]);
  const target = plan.allowedCreations[0]!;
  await withWorkspaceOperationLock(f.root, "compiler", async () => {
    const context = await upstreamRepairSlotContext(f.root, f.f.source.id, plan.planHash, target);
    const reviewed = context.reviewedSourceAnnotation!, payload = reviewed.payload;
    if (payload.annotationType !== "discourse-segment") throw Error("fixture");
    await stageUpstreamRepair(f.root, f.f.source.id, plan.planHash, target, { proposal_id: "reviewed-observation", annotation_id: payload.id,
      kind: payload.kind, selectors: reviewed.selectors.map(s => s.selector), confidence: payload.confidence, interpretation: payload.interpretation });
  });
  expect((await new SourceAnnotationStore(f.root).listProposals(f.f.source.id, "pending"))).toHaveLength(1);
  expect(await new SourceAnnotationStore(f.root).list(f.f.source.id)).toEqual([]);
  await expect(runSourceRepresentationReview(f.args)).rejects.toThrow(/retained history/);
  await expect(runSourceRepresentationReview({ ...f.args, directory: path.join(f.root, "renamed") })).rejects.toThrow(/another task/);
  expect(f.sessions()).toBe(6);
});

it.each([{ negative: true }, { gap: true }])("retains supported missing conditions or negative reviews without a grant (%j)", async opts => {
  const f = await fixture(opts); expect(f.state.phase).toBe("BREAK"); expect(f.records).toHaveLength(2);
  await expect(fs.readFile(path.join(f.directory, "upstream-plan.preview.json"))).rejects.toThrow(/ENOENT/);
  expect((await new UpstreamRepairLedger(f.root, f.f.source.id).inspect()).plans).toEqual([]);
  await expect(runSourceRepresentationReview(f.args)).rejects.toThrow(/retained history/); expect(f.sessions()).toBe(6);
});

it("rejects semantic broadening, canonical writes and missing source evidence", async () => {
  const f = await fixture(), plan = JSON.parse(await fs.readFile(path.join(f.directory, "upstream-plan.preview.json"), "utf8")) as UpstreamRepairPlan;
  const p = f.records[0]!.output; if (p.phase !== "representation-plan") throw Error("fixture");
  const payload = p.annotations[0]!.payload;
  const mutation = { kind: payload.annotationType, id: payload.id, baseline: null, payload,
    activeRevisions: new Map(plan.baselineRefs.map(r => [`${r.kind}:${r.id}`, r.revisionHash])), sourceSha256: f.f.source.contentSha256,
    requirementSetHash: plan.requirementSetHash, citedSegmentIds: plan.citableEvidenceRefs, hostDerivation: payload.derivation };
  expect(() => assertUpstreamRepairMutation(plan, mutation)).not.toThrow();
  expect(() => assertUpstreamRepairMutation(plan, { ...mutation, payload: { ...payload, confidence: 1 } })).toThrow(/exact semantic payload/);
  const { planHash: _, ...identity } = plan;
  expect(() => freezeUpstreamRepairPlan({ ...identity, allowedCreations: [{ ...identity.allowedCreations[0]!, kind: "canonical-event" }] })).toThrow(/annotation creations/);
  const forged = freezeUpstreamRepairPlan({ ...identity, authorizationRef: "different grant" });
  await expect(verifyUpstreamRepairPlan(f.root, forged)).rejects.toThrow(/exact scope/);
  const missing = representationRequirementResult(await f.ledger.history(), [], plan);
  expect(missing.requirements.every(r => r.state === "blocked")).toBe(true);
  expect(representationRequirementResult(await f.ledger.history(), [payload], plan).requirements.every(r => r.state === "satisfied")).toBe(true);
  expect((await f.ledger.history()).filter(r => r.payload.kind === "role-review-question-disposition").every(r => r.payload.kind === "role-review-question-disposition" && r.payload.disposition.status === "blocked")).toBe(true);
  expect(representationSemanticHash({ ...payload, derivation: { ...payload.derivation, worker: "host-stage" } })).toBe(representationSemanticHash(payload));
});

it("rejects dropped criteria, reused independent sessions, forged ledger ordering and source restore drift", async () => {
  const f = await fixture();
  expect(() => validateRepresentationHistory(f.prerequisites, [f.records[0]!, { ...f.records[1]!, sessionId: f.records[0]!.sessionId }])).toThrow(/fresh independent/);
  const bad = structuredClone(f.records); if (bad[0]!.output.phase !== "representation-plan") throw Error("fixture");
  bad[0]!.output.coverage[0]!.criteria[0]!.index = 1;
  expect(() => validateRepresentationHistory(f.prerequisites, [bad[0]!])).toThrow(/acceptance criterion/);
  expect(() => validateRepresentationHistory(f.prerequisites, [...f.records, f.records[1]!])).toThrow();
  const journal = await f.ledger.history();
  expect(requirementJournalSchema.safeParse(journal.filter(r => r.payload.kind !== "role-source-prerequisite")).success).toBe(false);
  await expect(f.ledger.assertJournalRestorable(journal, Buffer.from("Changed source"))).rejects.toThrow(/evidence/);
  const p = f.records[0]!.output; if (p.phase !== "representation-plan") throw Error("fixture");
  expect(discourseObservationSchema.safeParse({ ...p.annotations[0]!.payload, interpretation: undefined }).success).toBe(false);
});
