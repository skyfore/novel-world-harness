import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { registerSourceRequirements, settleSourceRequirements } from "../src/compiler/requirement-service.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { SourceAnnotationStore, quotationSchema } from "../src/compiler/annotations.js";
import { contentHash } from "../src/world/canonical.js";
import { freezeUpstreamRepairPlan } from "../src/compiler/upstream-repair-plan.js";
import { UpstreamRepairLedger } from "../src/compiler/upstream-repair-ledger.js";
import { verifyUpstreamRepairPlan } from "../src/compiler/upstream-repair-preflight.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-upstream-ledger-")); roots.push(root);
  const text = 'Ada said, "Wait." Nothing changes.', bytes = Buffer.from(text);
  const source = await createEvidenceFixture(root, text), sourceId = source.source.id;
  const definition = await registerSourceRequirements(root, { sourceId, id: "opening-checks", scopeDecisionRef: "independent-review", spec: {
    version: 1, sourceId, sourceSha256: source.source.contentSha256, review: { method: "independent-source-review", reviewer: "fixture-reviewer", reviewedAt: "2026-09-16T00:00:00Z", auditRef: "original-source-review" },
    cases: [{ id: "waiting", kind: "event-effects", scene: "Opening", rationale: "Nothing changes", evidence: [textAnchorForByteRange(sourceId, bytes, 0, bytes.length)], eventId: "waiting", requiresMechanism: false, expectation: { kind: "no-change", justification: "Source states no change" } }],
  } });
  const requirementIds = (await settleSourceRequirements(root, sourceId)).results[0]!.requirements.map(item => item.id);
  const annotation = quotationSchema.parse({ version: 1, id: "quote-one", sourceId, annotationType: "quotation", anchor: textAnchorForByteRange(sourceId, bytes, text.indexOf("Wait"), text.indexOf("Wait") + 4), mode: "direct", addresseeMentionIds: [], attributionConfidence: 1, derivation: { runId: "original", worker: "propose_quotation", ontologyVersion: "observation-v1" } });
  const annotations = new SourceAnnotationStore(root);
  const write = async (payload = annotation, id = "original-proposal") => {
    await annotations.stage(sourceId, { version: 1, id, annotationType: "quotation", payload, generatedBy: { worker: "fixture" }, createdAt: "2026-09-16T00:00:00Z" });
    await annotations.commitProposals(sourceId, [id]);
  };
  await write();
  const identity = { version: 1 as const, planId: "repair-one", batchId: "repair-batch-one", requirementSetHash: definition.revisionHash, requirementIds, predecessorReceiptRefs: [], sourceScope: { sourceId, sourceSha256: source.source.contentSha256, segmentIds: [source.segmentId] }, baselineRefs: [{ kind: "quotation" as const, id: annotation.id, revisionHash: contentHash(annotation) }], allowedWrites: [{ kind: "quotation" as const, id: annotation.id, pointers: ["/anchor"] }], allowedCreations: [], readableRefs: [{ kind: "quotation" as const, id: annotation.id }], citableEvidenceRefs: [source.segmentId], dependencyEdges: [], postconditionIds: requirementIds, authorizationRef: "host-source-review", retryBudgetRef: "budget-one" };
  const plan = freezeUpstreamRepairPlan(identity), ledger = new UpstreamRepairLedger(root, sourceId);
  const input = { artifactKind: "quotation" as const, artifactId: annotation.id, proposalId: "repair-proposal", inputHash: contentHash("original-input") };
  return { root, source, sourceId, plan, identity, ledger, input, annotation, write };
}

it("retains authorization and reserves attempts before effects across restart", async () => {
  const f = await fixture();
  await f.ledger.register(f.plan); await f.ledger.register(f.plan);
  await expect(f.ledger.startAttempt(f.plan.planHash, f.input)).rejects.toThrow("not authorized");
  await f.ledger.authorize(f.plan.planHash); await f.ledger.authorize(f.plan.planHash);
  const ref = await f.ledger.startAttempt(f.plan.planHash, f.input);
  const restarted = new UpstreamRepairLedger(f.root, f.sourceId);
  await expect(restarted.startAttempt(f.plan.planHash, { ...f.input, proposalId: "new-session-id" })).rejects.toThrow("unresolved");
  await restarted.recordFailure(f.plan.planHash, ref, "Exact selector needs correction");
  await restarted.recordFailure(f.plan.planHash, ref, "Exact selector needs correction");
  await expect(restarted.recordFailure(f.plan.planHash, ref, "Pretend it succeeded")).rejects.toThrow("rewritten");
  await expect(restarted.startAttempt(f.plan.planHash, f.input)).rejects.toThrow("materially corrected");
  await expect(restarted.startAttempt(f.plan.planHash, { ...f.input, inputHash: contentHash("corrected"), proposalId: "rotated" })).rejects.toThrow("same proposal identity");
  const second = await restarted.startAttempt(f.plan.planHash, { ...f.input, inputHash: contentHash("corrected") });
  await restarted.recordFailure(f.plan.planHash, second, "Corrected selector still invalid");
  await expect(restarted.startAttempt(f.plan.planHash, { ...f.input, inputHash: contentHash("third") })).rejects.toThrow("budget exhausted");
  expect((await restarted.inspect()).attempts).toHaveLength(2);
  expect((await restarted.inspect()).plans[0]!.state).toBe("needs-host-review");
  expect((await restarted.history()).filter(record => record.payload.kind === "authorized")).toHaveLength(1);
});

it("cannot reset budgets with a new namespace, reordered baseline or a linked revised plan", async () => {
  const f = await fixture(); await f.ledger.register(f.plan); await f.ledger.authorize(f.plan.planHash);
  for (const inputHash of [contentHash("one"), contentHash("two")]) {
    const ref = await f.ledger.startAttempt(f.plan.planHash, { ...f.input, inputHash });
    await f.ledger.recordFailure(f.plan.planHash, ref, "Unsupported source selector");
  }
  await f.ledger.stop(f.plan.planHash, "Host dependency review");
  const nextIdentity = { ...f.identity, planId: "new-namespace", batchId: "new-batch", retryBudgetRef: "new-budget" };
  await expect(f.ledger.register(freezeUpstreamRepairPlan(nextIdentity))).rejects.toThrow("predecessor");
  await expect(f.ledger.register(freezeUpstreamRepairPlan(nextIdentity), f.plan.planHash)).rejects.toThrow("changed dependency revisions");
  const changed = { ...f.annotation, attributionConfidence: 0.8 }; await f.write(changed, "host-revision");
  const next = freezeUpstreamRepairPlan({ ...nextIdentity, baselineRefs: [{ ...f.identity.baselineRefs[0]!, revisionHash: contentHash(changed) }] });
  await f.ledger.register(next, f.plan.planHash); await f.ledger.authorize(next.planHash);
  await expect(f.ledger.startAttempt(next.planHash, { ...f.input, inputHash: contentHash("fresh-session") })).rejects.toThrow("budget exhausted");
  expect((await f.ledger.inspect()).plans).toHaveLength(2);
});

it("rechecks real dependencies before authorization and every reservation, preserving stopped plans", async () => {
  const f = await fixture(); await f.ledger.register(f.plan);
  const changed = { ...f.annotation, attributionConfidence: 0.7 }; await f.write(changed, "host-revision");
  await expect(f.ledger.authorize(f.plan.planHash)).rejects.toThrow("Active dependency changed");
  expect((await f.ledger.inspect()).plans[0]!.state).toBe("needs-host-review");
  await f.write(f.annotation, "host-revert");
  await expect(f.ledger.authorize(f.plan.planHash)).rejects.toThrow("stopped");
  const other = await fixture(); await other.ledger.register(other.plan); await other.ledger.authorize(other.plan.planHash);
  await other.write({ ...other.annotation, attributionConfidence: 0.4 }, "later-revision");
  await expect(other.ledger.startAttempt(other.plan.planHash, other.input)).rejects.toThrow("Active dependency changed");
  expect((await other.ledger.inspect()).attempts).toHaveLength(0);
});

it("fails closed on false requirement, segment and receipt claims, corrupt history and a missing head", async () => {
  const f = await fixture();
  for (const patch of [{ requirementSetHash: contentHash("fake") }, { predecessorReceiptRefs: [contentHash("fake-receipt")] }, { sourceScope: { ...f.identity.sourceScope, segmentIds: ["invented"] }, citableEvidenceRefs: ["invented"] }]) {
    await expect(verifyUpstreamRepairPlan(f.root, freezeUpstreamRepairPlan({ ...f.identity, ...patch }))).rejects.toThrow();
  }
  expect(await f.ledger.history()).toEqual([]);
  await f.ledger.register(f.plan); await f.ledger.authorize(f.plan.planHash);
  const records = await f.ledger.history(), record = records[0]!;
  const file = path.join(f.ledger.directory, `${record.hash}.json`), original = await fs.readFile(file, "utf8");
  await fs.writeFile(file, JSON.stringify({ ...record, sequence: 1 }));
  await expect(f.ledger.history()).rejects.toThrow("index mismatch");
  await fs.writeFile(file, original);
  await fs.rm(path.join(f.ledger.directory, "head.json"));
  await expect(new UpstreamRepairLedger(f.root, f.sourceId).history()).rejects.toThrow("do not initialize a fresh budget");
});

it("stages an authorized quotation through the real narrow tool without committing or permitting ordinary finish", async () => {
  const { stageUpstreamRepair } = await import("../src/compiler/upstream-repair-staging.js");
  const { createCompilerProposalToolset } = await import("../src/compiler/proposal-tools.js");
  const f = await fixture(); await f.ledger.register(f.plan); await f.ledger.authorize(f.plan.planHash);
  const raw = { proposal_id: "repair-proposal", annotation_id: "quote-one", selector: { segment_id: f.source.segmentId, exact: "Wait." }, mode: "direct", addressee_mention_ids: [], attribution_confidence: 1 };
  const staged = await stageUpstreamRepair(f.root, f.sourceId, f.plan.planHash, { kind: "quotation", id: "quote-one" }, raw);
  const annotations = new SourceAnnotationStore(f.root);
  expect(await annotations.read(f.sourceId, "quote-one")).toEqual(f.annotation);
  const draft = await annotations.readProposal(f.sourceId, "pending", staged.proposalId);
  expect(contentHash(draft)).toBe(staged.proposalHash);
  expect(draft.payload.annotationType === "quotation" && draft.payload.anchor.endByte).toBe(f.annotation.anchor.endByte + 1);
  const state = await f.ledger.inspect();
  expect(state.attempts[0]!.staged).toBe(true);
  expect(state.records.map(record => record.payload.kind).slice(-3)).toEqual(["attempt-started", "attempt-validated", "attempt-staged"]);
  await expect(stageUpstreamRepair(f.root, f.sourceId, f.plan.planHash, { kind: "quotation", id: "quote-one" }, { ...raw, proposal_id: "rotated" })).rejects.toThrow("successful draft");
  const ordinary = createCompilerProposalToolset(f.root);
  await expect(ordinary.beginBatch([f.source.segmentId], f.plan.batchId, f.sourceId)).rejects.toThrow("exact active host authorization");
  await expect(ordinary.tools.find(tool => tool.name === "finish_compiler_batch")!.execute("bypass", { outcome: "complete", reviewed_segments: [], summary: "bypass" } as never, undefined, undefined, {} as never)).rejects.toThrow("initialization did not complete");
  const managed = createCompilerProposalToolset(f.root, {}, { upstreamRepair: { planHash: f.plan.planHash, beforeStage: async () => {} } });
  await managed.beginBatch([f.source.segmentId], f.plan.batchId, f.sourceId);
  for (const name of ["finish_compiler_batch", "propose_entity", "propose_novel_title"]) {
    await expect(managed.tools.find(tool => tool.name === name)!.execute("bypass", {} as never, undefined, undefined, {} as never)).rejects.toThrow("only host-guarded staging");
  }
});

it("recovers a written draft only from its pre-write validated intent, without rerunning the tool", async () => {
  const { stageUpstreamRepair, recoverUpstreamRepairStage } = await import("../src/compiler/upstream-repair-staging.js");
  const f = await fixture(); await f.ledger.register(f.plan); await f.ledger.authorize(f.plan.planHash);
  vi.spyOn(UpstreamRepairLedger.prototype, "recordStaged").mockRejectedValueOnce(new Error("interrupted staged result append"));
  await expect(stageUpstreamRepair(f.root, f.sourceId, f.plan.planHash, { kind: "quotation", id: "quote-one" }, { proposal_id: "repair-proposal", annotation_id: "quote-one", selector: { segment_id: f.source.segmentId, exact: "Wait." }, mode: "direct", addressee_mention_ids: [], attribution_confidence: 1 })).rejects.toThrow("exact pending draft");
  vi.restoreAllMocks();
  const reserved = (await f.ledger.inspect()).attempts[0]!;
  expect(reserved.failed).toBe(false); expect(reserved.staged).toBe(false); expect(reserved.validatedHash).toBeTruthy();
  const annotations = new SourceAnnotationStore(f.root);
  const original = await annotations.readProposal(f.sourceId, "pending", "repair-proposal");
  const read = vi.spyOn(SourceAnnotationStore.prototype, "readProposal").mockResolvedValueOnce({ ...original, payload: { ...original.payload, id: "tampered" } });
  await expect(recoverUpstreamRepairStage(f.root, f.sourceId, f.plan.planHash, reserved.attemptRef)).rejects.toThrow("original validated intent");
  read.mockRestore();
  const stage = vi.spyOn(SourceAnnotationStore.prototype, "stage");
  await recoverUpstreamRepairStage(f.root, f.sourceId, f.plan.planHash, reserved.attemptRef);
  await recoverUpstreamRepairStage(f.root, f.sourceId, f.plan.planHash, reserved.attemptRef);
  expect(stage).not.toHaveBeenCalled();
  expect((await f.ledger.inspect()).attempts).toHaveLength(1);
  expect((await f.ledger.inspect()).attempts[0]!.staged).toBe(true);
  expect(await annotations.read(f.sourceId, "quote-one")).toEqual(f.annotation);
});

it("rejects unauthorized actual field differences before writing a draft and retains the failure", async () => {
  const { stageUpstreamRepair } = await import("../src/compiler/upstream-repair-staging.js");
  const f = await fixture(); await f.ledger.register(f.plan); await f.ledger.authorize(f.plan.planHash);
  await expect(stageUpstreamRepair(f.root, f.sourceId, f.plan.planHash, { kind: "quotation", id: "quote-one" }, { proposal_id: "repair-proposal", annotation_id: "quote-one", selector: { segment_id: f.source.segmentId, exact: "Wait." }, mode: "direct", addressee_mention_ids: [], attribution_confidence: 0.5 })).rejects.toThrow("Unauthorized field difference");
  const annotations = new SourceAnnotationStore(f.root);
  expect(await annotations.listProposals(f.sourceId, "pending")).toEqual([]);
  expect(await annotations.read(f.sourceId, "quote-one")).toEqual(f.annotation);
  const state = await f.ledger.inspect();
  expect(state.attempts[0]!.failed).toBe(true); expect(state.plans[0]!.state).toBe("needs-host-review");
});

it("stages a source identity resolution using frozen mention and entity dependencies", async () => {
  const { stageUpstreamRepair } = await import("../src/compiler/upstream-repair-staging.js");
  const { CanonicalModelStore } = await import("../src/world/canonical-model.js");
  const { entityMentionSchema } = await import("../src/compiler/annotations.js");
  const { EntityResolutionStore } = await import("../src/compiler/entity-resolution.js");
  const f = await fixture();
  const entity = { id: "ada", kind: "character" as const, canonicalName: "Ada", aliases: [], evidence: f.source.evidence("Ada") };
  await new CanonicalModelStore(f.root).putEntity(entity);
  const mention = entityMentionSchema.parse({ version: 1, id: "mention-ada", sourceId: f.sourceId, annotationType: "entity-mention", anchor: textAnchorForByteRange(f.sourceId, Buffer.from('Ada said, "Wait." Nothing changes.'), 0, 3), surface: "Ada", form: "proper", kindCandidates: ["character"], confidence: 1, derivation: { runId: "source-review", worker: "propose_entity_mention", ontologyVersion: "observation-v1" } });
  const annotations = new SourceAnnotationStore(f.root);
  await annotations.stage(f.sourceId, { version: 1, id: "mention-proposal", annotationType: "entity-mention", payload: mention, generatedBy: { worker: "fixture" }, createdAt: "2026-09-16T00:00:00Z" });
  await annotations.commitProposals(f.sourceId, ["mention-proposal"]);
  const refs = [{ kind: "entity-mention" as const, id: mention.id, revisionHash: contentHash(mention) }, { kind: "entity" as const, id: entity.id, revisionHash: contentHash(entity) }];
  const plan = freezeUpstreamRepairPlan({ ...f.identity, allowedWrites: [], allowedCreations: [{ kind: "entity-resolution", id: "resolve-ada", maxCount: 1, dependencyOf: f.identity.requirementIds[0]! }], baselineRefs: refs, readableRefs: refs.map(({ kind, id }) => ({ kind, id })), dependencyEdges: [{ from: `requirement:${f.identity.requirementIds[0]}`, to: "entity-resolution:resolve-ada", purpose: "identity" }] });
  await f.ledger.register(plan); await f.ledger.authorize(plan.planHash);
  const staged = await stageUpstreamRepair(f.root, f.sourceId, plan.planHash, { kind: "entity-resolution", id: "resolve-ada" }, {
    proposal_id: "resolve-proposal", resolution_id: "resolve-ada", mention_id: "mention-ada", status: "resolved", entity_id: "ada", candidates: [{ entity_id: "ada", confidence: 1, basis_mention_ids: ["mention-ada"], evidence_assertion_ids: [], rationale: "Exact named mention" }], rationale: "Independent source identity review",
  });
  const resolutions = new EntityResolutionStore(f.root);
  expect(await resolutions.list(f.sourceId)).toEqual([]);
  expect((await resolutions.readProposal(f.sourceId, "pending", staged.proposalId)).payload.entityId).toBe("ada");
  expect((await f.ledger.inspect()).attempts[0]!.staged).toBe(true);
});

it("charges argument validation failures before staging and permits just the corrected original proposal", async () => {
  const { stageUpstreamRepair } = await import("../src/compiler/upstream-repair-staging.js");
  const f = await fixture(); await f.ledger.register(f.plan); await f.ledger.authorize(f.plan.planHash);
  const input = { proposal_id: "repair-proposal", annotation_id: "quote-one", selector: { segment_id: f.source.segmentId, exact: "Wait." }, mode: "invented-mode", addressee_mention_ids: [], attribution_confidence: 1 };
  await expect(stageUpstreamRepair(f.root, f.sourceId, f.plan.planHash, { kind: "quotation", id: "quote-one" }, input)).rejects.toThrow();
  expect((await f.ledger.inspect()).attempts[0]!.failed).toBe(true);
  await stageUpstreamRepair(f.root, f.sourceId, f.plan.planHash, { kind: "quotation", id: "quote-one" }, { ...input, mode: "direct" });
  const attempts = (await f.ledger.inspect()).attempts;
  expect(attempts).toHaveLength(2); expect(attempts[1]!.staged).toBe(true);
  expect(attempts[0]!.started.proposalId).toBe(attempts[1]!.started.proposalId);
});

it("consumes only declared same-plan staged mentions and freezes their exact revisions for resolution recovery", async () => {
  const { stageUpstreamRepair, recoverUpstreamRepairStage } = await import("../src/compiler/upstream-repair-staging.js");
  const { CanonicalModelStore } = await import("../src/world/canonical-model.js");
  const { EntityResolutionStore } = await import("../src/compiler/entity-resolution.js");
  const f = await fixture();
  const entity = { id: "ada", kind: "character" as const, canonicalName: "Ada", aliases: [], evidence: f.source.evidence("Ada") };
  await new CanonicalModelStore(f.root).putEntity(entity);
  const requirement = f.identity.requirementIds[0]!;
  const plan = freezeUpstreamRepairPlan({ ...f.identity, allowedWrites: [], baselineRefs: [{ kind: "entity", id: entity.id, revisionHash: contentHash(entity) }], readableRefs: [{ kind: "entity", id: entity.id }],
    allowedCreations: [{ kind: "discourse-segment", id: "new-scene", maxCount: 1, dependencyOf: requirement }, { kind: "entity-mention", id: "new-mention", maxCount: 1, dependencyOf: requirement }, { kind: "entity-resolution", id: "new-resolution", maxCount: 1, dependencyOf: requirement }],
    dependencyEdges: [{ from: `requirement:${requirement}`, to: "discourse-segment:new-scene", purpose: "source-evidence" }, { from: "entity-mention:new-mention", to: "discourse-segment:new-scene", purpose: "source-evidence" }, { from: `requirement:${requirement}`, to: "entity-mention:new-mention", purpose: "source-evidence" }, { from: `requirement:${requirement}`, to: "entity-resolution:new-resolution", purpose: "identity" }, { from: "entity-resolution:new-resolution", to: "entity-mention:new-mention", purpose: "identity" }],
  });
  await f.ledger.register(plan); await f.ledger.authorize(plan.planHash);
  const resolutionInput = { proposal_id: "resolution-proposal", resolution_id: "new-resolution", mention_id: "new-mention", status: "resolved", entity_id: "ada", candidates: [{ entity_id: "ada", confidence: 1, basis_mention_ids: ["new-mention"], evidence_assertion_ids: [], rationale: "Exact new mention" }], rationale: "Source-grounded identity" };
  const resolve = () => stageUpstreamRepair(f.root, f.sourceId, plan.planHash, { kind: "entity-resolution", id: "new-resolution" }, resolutionInput);
  await expect(resolve()).rejects.toThrow("has no staged result");
  expect((await f.ledger.inspect()).attempts).toHaveLength(0);
  const scene = await stageUpstreamRepair(f.root, f.sourceId, plan.planHash, { kind: "discourse-segment", id: "new-scene" }, { proposal_id: "scene-proposal", annotation_id: "new-scene", kind: "scene", selectors: [{ segment_id: f.source.segmentId, exact: 'Ada said, "Wait." Nothing changes.' }], confidence: 1 });
  const mention = await stageUpstreamRepair(f.root, f.sourceId, plan.planHash, { kind: "entity-mention", id: "new-mention" }, { proposal_id: "mention-proposal", annotation_id: "new-mention", selector: { segment_id: f.source.segmentId, exact: "Ada" }, surface: "Ada", form: "proper", kind_candidates: ["character"], scene_id: "new-scene", confidence: 1 });
  const annotations = new SourceAnnotationStore(f.root), original = await annotations.readProposal(f.sourceId, "pending", mention.proposalId);
  const tampered = vi.spyOn(SourceAnnotationStore.prototype, "readProposal").mockResolvedValueOnce({ ...original, createdAt: "2026-09-17T00:00:00Z" });
  await expect(resolve()).rejects.toThrow("original envelope");
  tampered.mockRestore();
  expect((await f.ledger.inspect()).attempts).toHaveLength(2);
  const resolved = await resolve();
  const state = await f.ledger.inspect(), attempt = state.attempts.find(item => item.attemptRef === resolved.attemptRef)!;
  expect(attempt.dependencies).toEqual([{ attemptRef: mention.attemptRef, proposalHash: mention.proposalHash }, { attemptRef: scene.attemptRef, proposalHash: scene.proposalHash }].sort((a, b) => a.attemptRef.localeCompare(b.attemptRef)));
  expect(await new EntityResolutionStore(f.root).list(f.sourceId)).toEqual([]);
  await expect(annotations.read(f.sourceId, "new-mention")).rejects.toThrow();
  const corrupted = vi.spyOn(SourceAnnotationStore.prototype, "readProposal").mockResolvedValueOnce({ ...original, payload: { ...original.payload, id: "substituted" } });
  await expect(recoverUpstreamRepairStage(f.root, f.sourceId, plan.planHash, resolved.attemptRef)).rejects.toThrow("original envelope");
  corrupted.mockRestore();
  const noReplay = vi.spyOn(EntityResolutionStore.prototype, "stage");
  await recoverUpstreamRepairStage(f.root, f.sourceId, plan.planHash, resolved.attemptRef);
  expect(noReplay).not.toHaveBeenCalled();
  await expect(f.ledger.recordValidated(plan.planHash, resolved.attemptRef, attempt.validatedHash!, [])).rejects.toThrow("dependencies were rewritten");
  const { prepareUpstreamRepairFinish, executeUpstreamRepairFinish } = await import("../src/compiler/upstream-repair-finish.js");
  await prepareUpstreamRepairFinish(f.root, f.sourceId, plan.planHash, { outcome: "complete", reviewed_segments: [{ segment_id: f.source.segmentId, disposition: "proposed", summary: "Reviewed full dependency chain" }], summary: "Repair missing mention and resolution" });
  vi.spyOn(EntityResolutionStore.prototype, "commitProposals").mockRejectedValueOnce(new Error("injected between annotation and resolution stores"));
  await expect(executeUpstreamRepairFinish(f.root, f.sourceId, plan.planHash)).rejects.toThrow("injected between");
  expect((await annotations.read(f.sourceId, "new-mention")).id).toBe("new-mention");
  expect(await new EntityResolutionStore(f.root).list(f.sourceId)).toEqual([]);
  await executeUpstreamRepairFinish(f.root, f.sourceId, plan.planHash);
  expect((await new EntityResolutionStore(f.root).list(f.sourceId)).map(item => item.id)).toEqual(["new-resolution"]);
  expect(noReplay).not.toHaveBeenCalled();
});

it("freezes and restores upstream budgets with candidates and rejects old or unbound history before world writes", async () => {
  const { PreparedNovelCache } = await import("../src/compiler/prepared-cache.js");
  const { CanonicalModelStore } = await import("../src/world/canonical-model.js");
  const { InitialWorldStore } = await import("../src/world/initial.js");
  const { CompilerBatchStore, prepareCompilerBatches } = await import("../src/compiler/batches.js");
  const { SegmentStore } = await import("../src/compiler/segments.js");
  const { CompilerFinishReceipts } = await import("../src/compiler/finish-receipts.js");
  const { preparedSubjectHash, validateAssessmentRevision } = await import("../src/compiler/certification.js");
  const { upstreamRepairSnapshotIssues } = await import("../src/compiler/upstream-repair-snapshot.js");
  const f = await fixture(), canonical = new CanonicalModelStore(f.root);
  const entity = { id: "ada", kind: "character" as const, canonicalName: "Ada", aliases: [], evidence: f.source.evidence("Ada") };
  await canonical.putEntity(entity);
  await new InitialWorldStore(f.root).put({ version: 1, evidence: f.source.evidence("Ada"), participantPresence: [{ entityId: "ada", mode: "physical" }], delta: { version: 1, operations: [{ op: "set", entityId: "ada", field: "character.alive", value: true }, { op: "set", entityId: "ada", field: "character.plan", value: "wait" }] } });
  const batches = await prepareCompilerBatches(f.root, f.source.source);
  await new CompilerBatchStore(f.root).replaceCompleted(f.sourceId, batches.map(batch => batch.id));
  const receipts = new CompilerFinishReceipts(f.root, f.sourceId, "original-annotation-finish");
  const receipt = await receipts.prepare({ version: 1, sourceId: f.sourceId, sourceSha256: f.source.source.contentSha256, batchId: receipts.batchId, input: { outcome: "complete", reviewed_segments: [], summary: "Original annotation finish" }, segments: await new SegmentStore(f.root).list(f.sourceId), dependencies: await receipts.dependencies({ annotation: ["original-proposal"] }), metadata: {} });
  await receipts.complete(receipt.fingerprint);
  const cache = new PreparedNovelCache(f.root, path.join(f.root, "cache")), old = await cache.archiveCandidate(f.source.source);
  const plan = freezeUpstreamRepairPlan({ ...f.identity, predecessorReceiptRefs: [receipt.fingerprint] });
  await f.ledger.register(plan); await f.ledger.authorize(plan.planHash);
  const beforeFailures = await cache.candidateSnapshot(f.source.source);
  for (const inputHash of [contentHash("one"), contentHash("two")]) {
    const ref = await f.ledger.startAttempt(plan.planHash, { ...f.input, inputHash });
    await f.ledger.recordFailure(plan.planHash, ref, "Retained source-selector failure");
  }
  const current = await cache.inspectCandidate(f.source.source), records = await f.ledger.history();
  expect(current.bundle.compilerSnapshot.upstreamRepairJournal).toEqual(records);
  expect(preparedSubjectHash(current.bundle)).not.toBe(preparedSubjectHash(beforeFailures));
  expect(current.assessment.issues.some(issue => issue.code === "UPSTREAM_REPAIR_UNRESOLVED")).toBe(true);
  expect(validateAssessmentRevision(current.bundle, current.assessment).some(issue => issue.startsWith("UPSTREAM_REPAIR_NOT_EVALUATED"))).toBe(true);
  expect(current.bundle.compilerSnapshot.reconciliationObligations?.some(item => item.receipt.fingerprint === receipt.fingerprint)).toBe(true);
  expect(upstreamRepairSnapshotIssues({ ...current.bundle.compilerSnapshot, requirementDefinitions: [] }, f.sourceId, f.source.source.contentSha256)).toContain("UPSTREAM_REPAIR_DEFINITION_MISSING");
  expect(upstreamRepairSnapshotIssues({ ...current.bundle.compilerSnapshot, reconciliationObligations: [] }, f.sourceId, f.source.source.contentSha256)).toContain("UPSTREAM_REPAIR_PREDECESSOR_RECEIPT_MISSING");
  const archived = await cache.archiveCandidate(f.source.source);
  await canonical.putEntity({ ...entity, aliases: ["Unchanged by rejected restore"] });
  const beforeRestore = contentHash(await canonical.listEntities());
  await expect(cache.restoreCompilerCheckpoint(f.source.source, old.bundleHash!)).rejects.toThrow("forget or rewrite retained plans");
  expect(contentHash(await canonical.listEntities())).toBe(beforeRestore);
  const cloneRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-upstream-budget-clone-")); roots.push(cloneRoot);
  const clone = await createEvidenceFixture(cloneRoot, 'Ada said, "Wait." Nothing changes.');
  const cloneCache = new PreparedNovelCache(cloneRoot, path.join(f.root, "cache"));
  await cloneCache.restoreCompilerCheckpoint(clone.source, archived.bundleHash!);
  await cloneCache.restoreCompilerCheckpoint(clone.source, archived.bundleHash!);
  const restored = new UpstreamRepairLedger(cloneRoot, clone.source.id);
  expect(await restored.history()).toEqual(records);
  await expect(restored.startAttempt(plan.planHash, { ...f.input, inputHash: contentHash("new workspace retry") })).rejects.toThrow("budget exhausted");
  expect(await CompilerFinishReceipts.list(cloneRoot, clone.source.id)).toEqual([]);
  expect((await CompilerFinishReceipts.listRetained(cloneRoot, clone.source.id)).map(item => item.receipt.fingerprint)).toContain(receipt.fingerprint);
  await expect(restored.restore([], Buffer.from('Ada said, "Wait." Nothing changes.'))).rejects.toThrow("forget or rewrite");
  const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-upstream-bad-import-")); roots.push(emptyRoot);
  await expect(new UpstreamRepairLedger(emptyRoot, f.sourceId).restore(records, Buffer.from("wrong original bytes"))).rejects.toThrow("immutable original source bytes");
  const corrupt = structuredClone(records); corrupt[0]!.hash = "0".repeat(64);
  await expect(new UpstreamRepairLedger(emptyRoot, f.sourceId).restore(corrupt, Buffer.from('Ada said, "Wait." Nothing changes.'))).rejects.toThrow("chain mismatch");
});

it("freezes the exact upstream finish input, staged set and original baselines without committing", async () => {
  const { stageUpstreamRepair } = await import("../src/compiler/upstream-repair-staging.js");
  const { prepareUpstreamRepairFinish } = await import("../src/compiler/upstream-repair-finish.js");
  const { upstreamRepairFinishIntentSchema } = await import("../src/compiler/upstream-repair-finish-intent.js");
  const { CompilerFinishReceipts } = await import("../src/compiler/finish-receipts.js");
  const f = await fixture(); await f.ledger.register(f.plan); await f.ledger.authorize(f.plan.planHash);
  const input = { outcome: "complete" as const, reviewed_segments: [{ segment_id: f.source.segmentId, disposition: "proposed" as const, summary: "Reviewed exact quotation" }], summary: "Host-reviewed bounded upstream repair" };
  await expect(prepareUpstreamRepairFinish(f.root, f.sourceId, f.plan.planHash, input)).rejects.toThrow("fully staged");
  const staged = await stageUpstreamRepair(f.root, f.sourceId, f.plan.planHash, { kind: "quotation", id: "quote-one" }, { proposal_id: "repair-proposal", annotation_id: "quote-one", selector: { segment_id: f.source.segmentId, exact: "Wait." }, mode: "direct", addressee_mention_ids: [], attribution_confidence: 1 });
  const priorHead = (await f.ledger.history()).at(-1)!.hash;
  const intent = await prepareUpstreamRepairFinish(f.root, f.sourceId, f.plan.planHash, input);
  expect(intent.authorizationHeadHash).toBe(priorHead);
  expect(intent.proposals).toEqual([{ artifactKind: "quotation", artifactId: "quote-one", proposalId: staged.proposalId, proposalHash: staged.proposalHash, attemptRef: staged.attemptRef, payloadHash: (await f.ledger.inspect()).attempts[0]!.validatedHash }]);
  expect(intent.baselines[0]!.payload).toEqual(f.annotation);
  expect((await f.ledger.inspect()).plans[0]!.state).toBe("finish-frozen");
  expect(await prepareUpstreamRepairFinish(f.root, f.sourceId, f.plan.planHash, input)).toEqual(intent);
  expect((await f.ledger.history()).filter(record => record.payload.kind === "finish-frozen")).toHaveLength(1);
  await expect(prepareUpstreamRepairFinish(f.root, f.sourceId, f.plan.planHash, { ...input, summary: "Changed after freezing" })).rejects.toThrow("frozen finish input changed");
  await expect(f.ledger.authorize(f.plan.planHash)).rejects.toThrow("already frozen");
  await expect(f.ledger.startAttempt(f.plan.planHash, { ...f.input, inputHash: contentHash("after-finish") })).rejects.toThrow("not authorized");
  const annotations = new SourceAnnotationStore(f.root);
  expect(await annotations.read(f.sourceId, "quote-one")).toEqual(f.annotation);
  expect((await annotations.listProposals(f.sourceId, "pending")).map(item => item.id)).toEqual([staged.proposalId]);
  expect(await new CompilerFinishReceipts(f.root, f.sourceId, f.plan.batchId).read()).toBeUndefined();
  expect(() => upstreamRepairFinishIntentSchema.parse({ ...intent, intentHash: "0".repeat(64) })).toThrow("hash mismatch");
  const cloneRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-frozen-finish-journal-")); roots.push(cloneRoot);
  const clone = new UpstreamRepairLedger(cloneRoot, f.sourceId), history = await f.ledger.history();
  await clone.restore(history, Buffer.from('Ada said, "Wait." Nothing changes.'));
  expect((await clone.inspect()).plans[0]!.finishIntent).toEqual(intent);
});

it("refuses stray batch proposals and stale baselines before freezing finish authority", async () => {
  const { stageUpstreamRepair } = await import("../src/compiler/upstream-repair-staging.js");
  const { prepareUpstreamRepairFinish } = await import("../src/compiler/upstream-repair-finish.js");
  const f = await fixture(); await f.ledger.register(f.plan); await f.ledger.authorize(f.plan.planHash);
  await stageUpstreamRepair(f.root, f.sourceId, f.plan.planHash, { kind: "quotation", id: "quote-one" }, { proposal_id: "repair-proposal", annotation_id: "quote-one", selector: { segment_id: f.source.segmentId, exact: "Wait." }, mode: "direct", addressee_mention_ids: [], attribution_confidence: 1 });
  const annotations = new SourceAnnotationStore(f.root);
  await annotations.stage(f.sourceId, { version: 1, id: "stray-proposal", annotationType: "quotation", payload: { ...f.annotation, id: "not-authorized" }, generatedBy: { worker: "fixture", compilerBatchId: f.plan.batchId }, createdAt: "2026-09-16T00:00:00Z" });
  const input = { outcome: "complete" as const, reviewed_segments: [{ segment_id: f.source.segmentId, disposition: "proposed" as const, summary: "Reviewed" }], summary: "Bounded repair" };
  await expect(prepareUpstreamRepairFinish(f.root, f.sourceId, f.plan.planHash, input)).rejects.toThrow("unauthorized upstream proposals");
  expect((await f.ledger.inspect()).plans[0]!.state).toBe("staging");
  await annotations.withdraw(f.sourceId, "stray-proposal");
  await expect(prepareUpstreamRepairFinish(f.root, f.sourceId, f.plan.planHash, { ...input, reviewed_segments: [] })).rejects.toThrow("reviewed source segments");
  await f.write({ ...f.annotation, attributionConfidence: 0.7 }, "host-changed-baseline");
  await expect(prepareUpstreamRepairFinish(f.root, f.sourceId, f.plan.planHash, input)).rejects.toThrow("Active dependency changed");
  expect((await f.ledger.history()).some(record => record.payload.kind === "finish-frozen")).toBe(false);
});

async function frozenQuotationFinish() {
  const { stageUpstreamRepair } = await import("../src/compiler/upstream-repair-staging.js");
  const { prepareUpstreamRepairFinish } = await import("../src/compiler/upstream-repair-finish.js");
  const f = await fixture(); await f.ledger.register(f.plan); await f.ledger.authorize(f.plan.planHash);
  await stageUpstreamRepair(f.root, f.sourceId, f.plan.planHash, { kind: "quotation", id: "quote-one" }, { proposal_id: "repair-proposal", annotation_id: "quote-one", selector: { segment_id: f.source.segmentId, exact: "Wait." }, mode: "direct", addressee_mention_ids: [], attribution_confidence: 1 });
  const intent = await prepareUpstreamRepairFinish(f.root, f.sourceId, f.plan.planHash, { outcome: "complete", reviewed_segments: [{ segment_id: f.source.segmentId, disposition: "proposed", summary: "Reviewed" }], summary: "Bounded repair" });
  return { ...f, intent };
}

it.each(["none", "annotation", "completion", "journal"])("executes the original authorized finish and recovers after %s without model replay", async point => {
  const { executeUpstreamRepairFinish } = await import("../src/compiler/upstream-repair-finish.js");
  const { CompilerFinishReceipts, compilerFinishReceiptSchema } = await import("../src/compiler/finish-receipts.js");
  const { recoverCompilerFinish } = await import("../src/compiler/finish-recovery.js");
  const { SourceAccountingStore } = await import("../src/compiler/source-accounting.js");
  const f = await frozenQuotationFinish(), receipts = new CompilerFinishReceipts(f.root, f.sourceId, f.plan.batchId);
  const accounting = new SourceAccountingStore(f.root), beforeAccounting = await accounting.read(f.sourceId);
  if (point === "annotation") {
    const original = SourceAnnotationStore.prototype.commitProposals;
    vi.spyOn(SourceAnnotationStore.prototype, "commitProposals").mockImplementationOnce(async function (...args) { await original.apply(this, args); throw new Error("injected post-annotation crash"); });
  } else if (point === "completion") vi.spyOn(CompilerFinishReceipts.prototype, "complete").mockRejectedValueOnce(new Error("injected completion crash"));
  else if (point === "journal") vi.spyOn(UpstreamRepairLedger.prototype, "recordFinished").mockRejectedValueOnce(new Error("injected journal crash"));
  if (point !== "none") {
    await expect(executeUpstreamRepairFinish(f.root, f.sourceId, f.plan.planHash)).rejects.toThrow("injected");
    expect((await receipts.read())?.state).toBe(point === "journal" ? "completed" : "prepared");
    expect((await f.ledger.inspect()).plans[0]!.state).toBe("finish-frozen");
    await expect(recoverCompilerFinish(f.root, f.sourceId, f.plan.batchId)).resolves.toBe(true);
  } else await executeUpstreamRepairFinish(f.root, f.sourceId, f.plan.planHash);
  const receipt = await receipts.read();
  expect(receipt).toMatchObject({ state: "completed", identity: { version: 3, upstreamRepairIntent: f.intent, metadata: {} } });
  expect(() => compilerFinishReceiptSchema.parse({ ...receipt, identity: { ...receipt!.identity, version: 1 }, fingerprint: contentHash({ ...receipt!.identity, version: 1 }) })).toThrow("upstream scope/version");
  expect((await f.ledger.inspect()).plans[0]!.state).toBe("finished");
  const annotations = new SourceAnnotationStore(f.root), active = await annotations.read(f.sourceId, "quote-one");
  expect(active.anchor.endByte).toBe(f.annotation.anchor.endByte + 1);
  expect(active.attributionConfidence).toBe(f.annotation.attributionConfidence);
  expect(await accounting.read(f.sourceId)).toEqual(beforeAccounting);
  const records = await f.ledger.history();
  if (point === "none") {
    const { captureReconciliationObligations } = await import("../src/compiler/reconciliation-review-ledger.js");
    const { upstreamRepairSnapshotIssues } = await import("../src/compiler/upstream-repair-snapshot.js");
    const { RequirementLedger } = await import("../src/compiler/requirement-ledger.js");
    const obligations = await captureReconciliationObligations(f.root, f.sourceId);
    expect(obligations.some(item => item.receipt.fingerprint === receipt!.fingerprint)).toBe(true);
    const snapshot = { upstreamRepairJournal: records, reconciliationObligations: obligations, requirementDefinitions: await new RequirementLedger(f.root, f.sourceId).definitions() };
    expect(upstreamRepairSnapshotIssues(snapshot, f.sourceId, f.source.source.contentSha256)).toEqual([]);
    expect(upstreamRepairSnapshotIssues({ ...snapshot, reconciliationObligations: [] }, f.sourceId, f.source.source.contentSha256)).toContain("UPSTREAM_REPAIR_FINISH_RECEIPT_MISSING");
  }
  await executeUpstreamRepairFinish(f.root, f.sourceId, f.plan.planHash);
  expect(await f.ledger.history()).toEqual(records);
  expect(await receipts.read()).toEqual(receipt);
  expect(await annotations.listProposals(f.sourceId, "pending")).toEqual([]);
  expect((await annotations.listProposals(f.sourceId, "accepted")).filter(item => item.id === "repair-proposal")).toHaveLength(1);
});

it("does not overwrite a third-party revision during authorized partial-finish recovery", async () => {
  const { executeUpstreamRepairFinish } = await import("../src/compiler/upstream-repair-finish.js");
  const { CompilerFinishReceipts } = await import("../src/compiler/finish-receipts.js");
  const f = await frozenQuotationFinish();
  vi.spyOn(CompilerFinishReceipts.prototype, "complete").mockRejectedValueOnce(new Error("injected before completion"));
  await expect(executeUpstreamRepairFinish(f.root, f.sourceId, f.plan.planHash)).rejects.toThrow("injected");
  const changed = { ...f.annotation, attributionConfidence: 0.4 }; await f.write(changed, "host-intervened");
  await expect(executeUpstreamRepairFinish(f.root, f.sourceId, f.plan.planHash)).rejects.toThrow("Active dependency changed");
  expect(await new SourceAnnotationStore(f.root).read(f.sourceId, "quote-one")).toEqual(changed);
  expect((await new CompilerFinishReceipts(f.root, f.sourceId, f.plan.batchId).read())?.state).toBe("prepared");
});

it("runs the original finish graph validation before any authorized canonical mutation", async () => {
  const { stageUpstreamRepair } = await import("../src/compiler/upstream-repair-staging.js");
  const { prepareUpstreamRepairFinish, executeUpstreamRepairFinish } = await import("../src/compiler/upstream-repair-finish.js");
  const { CompilerFinishReceipts } = await import("../src/compiler/finish-receipts.js");
  const f = await fixture(), requirement = f.identity.requirementIds[0]!;
  const discourse = { version: 1 as const, sourceId: f.sourceId, id: "summary-context", annotationType: "discourse-segment" as const, kind: "summary" as const, anchors: [f.annotation.anchor], confidence: 1, derivation: f.annotation.derivation };
  const store = new SourceAnnotationStore(f.root);
  await store.stage(f.sourceId, { version: 1, id: "summary-original", annotationType: "discourse-segment", payload: discourse, generatedBy: { worker: "fixture" }, createdAt: "2026-09-16T00:00:00Z" });
  await store.commitProposals(f.sourceId, ["summary-original"]);
  const plan = freezeUpstreamRepairPlan({ ...f.identity, allowedWrites: [], baselineRefs: [...f.identity.baselineRefs, { kind: "discourse-segment", id: discourse.id, revisionHash: contentHash(discourse) }], readableRefs: [...f.identity.readableRefs, { kind: "discourse-segment", id: discourse.id }], allowedCreations: [{ kind: "entity-mention", id: "bad-surface", maxCount: 1, dependencyOf: requirement }], dependencyEdges: [{ from: `requirement:${requirement}`, to: "entity-mention:bad-surface", purpose: "source-evidence" }] });
  await f.ledger.register(plan); await f.ledger.authorize(plan.planHash);
  await stageUpstreamRepair(f.root, f.sourceId, plan.planHash, { kind: "entity-mention", id: "bad-surface" }, { proposal_id: "bad-mention-proposal", annotation_id: "bad-surface", selector: { segment_id: f.source.segmentId, exact: "Ada" }, surface: "Ada", scene_id: discourse.id, form: "proper", kind_candidates: ["character"], confidence: 1 });
  await prepareUpstreamRepairFinish(f.root, f.sourceId, plan.planHash, { outcome: "complete", reviewed_segments: [{ segment_id: f.source.segmentId, disposition: "proposed", summary: "Reviewed" }], summary: "Invalid semantic trace" });
  const annotations = new SourceAnnotationStore(f.root), before = await annotations.list(f.sourceId);
  await expect(executeUpstreamRepairFinish(f.root, f.sourceId, plan.planHash)).rejects.toThrow("scene");
  expect(await annotations.list(f.sourceId)).toEqual(before);
  expect((await f.ledger.inspect()).plans[0]!.state).toBe("needs-host-review");
  expect(await new CompilerFinishReceipts(f.root, f.sourceId, plan.batchId).read()).toBeUndefined();
});
