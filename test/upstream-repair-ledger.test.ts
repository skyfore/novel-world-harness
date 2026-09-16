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
async function fixture(text = 'Ada said, "Wait." Nothing changes.', quotedText = "Wait") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-upstream-ledger-")); roots.push(root);
  const bytes = Buffer.from(text);
  const source = await createEvidenceFixture(root, text), sourceId = source.source.id;
  const definition = await registerSourceRequirements(root, { sourceId, id: "opening-checks", scopeDecisionRef: "independent-review", spec: {
    version: 1, sourceId, sourceSha256: source.source.contentSha256, review: { method: "independent-source-review", reviewer: "fixture-reviewer", reviewedAt: "2026-09-16T00:00:00Z", auditRef: "original-source-review" },
    cases: [{ id: "waiting", kind: "event-effects", scene: "Opening", rationale: "Nothing changes", evidence: [textAnchorForByteRange(sourceId, bytes, 0, bytes.length)], eventId: "waiting", requiresMechanism: false, expectation: { kind: "no-change", justification: "Source states no change" } }],
  } });
  const requirementIds = (await settleSourceRequirements(root, sourceId)).results[0]!.requirements.map(item => item.id);
  const annotation = quotationSchema.parse({ version: 1, id: "quote-one", sourceId, annotationType: "quotation", anchor: textAnchorForByteRange(sourceId, bytes, text.indexOf(quotedText), text.indexOf(quotedText) + quotedText.length), mode: "direct", addresseeMentionIds: [], attributionConfidence: 1, derivation: { runId: "original", worker: "propose_quotation", ontologyVersion: "observation-v1" } });
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
  const { InitialWorldStore } = await import("../src/world/initial.js");
  const { CompilerBatchStore, prepareCompilerBatches } = await import("../src/compiler/batches.js");
  const { PreparedNovelCache } = await import("../src/compiler/prepared-cache.js");
  await new InitialWorldStore(f.root).put({ version: 1, evidence: f.source.evidence("Ada"), participantPresence: [{ entityId: "ada", mode: "physical" }], delta: { version: 1, operations: [{ op: "set", entityId: "ada", field: "character.alive", value: true }, { op: "set", entityId: "ada", field: "character.plan", value: "wait" }] } });
  await new CompilerBatchStore(f.root).replaceCompleted(f.sourceId, (await prepareCompilerBatches(f.root, f.source.source)).map(item => item.id));
  const cacheRoot = path.join(f.root, "dag-cache"), cache = new PreparedNovelCache(f.root, cacheRoot);
  const archived = await cache.archiveCandidate(f.source.source);
  const cloneRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-upstream-dag-clone-")); roots.push(cloneRoot);
  const clone = await createEvidenceFixture(cloneRoot, 'Ada said, "Wait." Nothing changes.');
  await new PreparedNovelCache(cloneRoot, cacheRoot).restoreCompilerCheckpoint(clone.source, archived.bundleHash!);
  noReplay.mockClear();
  await executeUpstreamRepairFinish(cloneRoot, f.sourceId, plan.planHash);
  expect((await new EntityResolutionStore(cloneRoot).list(f.sourceId)).map(item => item.id)).toEqual(["new-resolution"]);
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
  expect(intent.authorizationHeadHash).toBe((await f.ledger.history()).find(record => record.payload.kind === "finish-review-recorded")!.hash);
  expect(intent.authorizationHeadHash).not.toBe(priorHead);
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
  await expect(prepareUpstreamRepairFinish(f.root, f.sourceId, f.plan.planHash, { ...input, reviewed_segments: [] })).rejects.toThrow("retained finish review changed");
  await f.write({ ...f.annotation, attributionConfidence: 0.7 }, "host-changed-baseline");
  await expect(prepareUpstreamRepairFinish(f.root, f.sourceId, f.plan.planHash, input)).rejects.toThrow("Active dependency changed");
  expect((await f.ledger.history()).some(record => record.payload.kind === "finish-frozen")).toBe(false);
});

async function frozenQuotationFinish(freeze = true) {
  const { stageUpstreamRepair } = await import("../src/compiler/upstream-repair-staging.js");
  const { prepareUpstreamRepairFinish } = await import("../src/compiler/upstream-repair-finish.js");
  const f = await fixture(); await f.ledger.register(f.plan); await f.ledger.authorize(f.plan.planHash);
  await stageUpstreamRepair(f.root, f.sourceId, f.plan.planHash, { kind: "quotation", id: "quote-one" }, { proposal_id: "repair-proposal", annotation_id: "quote-one", selector: { segment_id: f.source.segmentId, exact: "Wait." }, mode: "direct", addressee_mention_ids: [], attribution_confidence: 1 });
  const finishInput = { outcome: "complete" as const, reviewed_segments: [{ segment_id: f.source.segmentId, disposition: "proposed" as const, summary: "Reviewed" }], summary: "Bounded repair" };
  const intent = freeze ? await prepareUpstreamRepairFinish(f.root, f.sourceId, f.plan.planHash, finishInput) : undefined;
  return { ...f, intent, finishInput };
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

it.each(["staged", "frozen", "partial", "completed", "finished", "converged", "evaluated"])("ports original upstream drafts and %s finish state into a fresh workspace", async point => {
  const { executeUpstreamRepairFinish } = await import("../src/compiler/upstream-repair-finish.js");
  const { CompilerFinishReceipts } = await import("../src/compiler/finish-receipts.js");
  const { PreparedNovelCache } = await import("../src/compiler/prepared-cache.js");
  const { CanonicalModelStore } = await import("../src/world/canonical-model.js");
  const { InitialWorldStore } = await import("../src/world/initial.js");
  const { CompilerBatchStore, prepareCompilerBatches } = await import("../src/compiler/batches.js");
  const { assertUpstreamRepairCheckpoint } = await import("../src/compiler/upstream-repair-checkpoint.js");
  const f = await frozenQuotationFinish(point !== "staged");
  const entity = { id: "ada", kind: "character" as const, canonicalName: "Ada", aliases: [], evidence: f.source.evidence("Ada") };
  await new CanonicalModelStore(f.root).putEntity(entity);
  await new InitialWorldStore(f.root).put({ version: 1, evidence: f.source.evidence("Ada"), participantPresence: [{ entityId: "ada", mode: "physical" }], delta: { version: 1, operations: [{ op: "set", entityId: "ada", field: "character.alive", value: true }, { op: "set", entityId: "ada", field: "character.plan", value: "wait" }] } });
  const batches = await prepareCompilerBatches(f.root, f.source.source);
  await new CompilerBatchStore(f.root).replaceCompleted(f.sourceId, batches.map(batch => batch.id));
  if (point === "partial") {
    const original = SourceAnnotationStore.prototype.commitProposals;
    vi.spyOn(SourceAnnotationStore.prototype, "commitProposals").mockImplementationOnce(async function (...args) { await original.apply(this, args); throw new Error("checkpoint injected crash"); });
  } else if (point === "completed") vi.spyOn(UpstreamRepairLedger.prototype, "recordFinished").mockRejectedValueOnce(new Error("checkpoint injected crash"));
  if (["partial", "completed"].includes(point)) await expect(executeUpstreamRepairFinish(f.root, f.sourceId, f.plan.planHash)).rejects.toThrow("checkpoint injected");
  const { convergeWorldProposals } = await import("../src/compiler/converge.js");
  if (["finished", "converged", "evaluated"].includes(point)) await executeUpstreamRepairFinish(f.root, f.sourceId, f.plan.planHash);
  if (["converged", "evaluated"].includes(point)) await convergeWorldProposals(f.root, f.sourceId);
  if (point === "evaluated") await f.ledger.recordEvaluation(f.plan.planHash);
  const receipts = new CompilerFinishReceipts(f.root, f.sourceId, f.plan.batchId), originalReceipt = await receipts.read();
  const cacheRoot = path.join(f.root, "portable-cache"), cache = new PreparedNovelCache(f.root, cacheRoot);
  const bundle = await cache.candidateSnapshot(f.source.source), checkpoint = bundle.compilerSnapshot.upstreamRepairCheckpoint!;
  expect(checkpoint.drafts).toHaveLength(1);
  expect(checkpoint.drafts[0]!.status).toBe(["staged", "frozen"].includes(point) ? "pending" : "accepted");
  expect(checkpoint.activeReceipts).toEqual(originalReceipt ? [originalReceipt] : []);
  const corrupt = structuredClone(checkpoint); corrupt.drafts[0]!.envelope.createdAt = "2026-09-17T00:00:00Z";
  expect(() => assertUpstreamRepairCheckpoint(corrupt, bundle.compilerSnapshot.upstreamRepairJournal!, f.sourceId)).toThrow("original validated");
  expect(() => assertUpstreamRepairCheckpoint({ ...checkpoint, drafts: [] }, bundle.compilerSnapshot.upstreamRepairJournal!, f.sourceId)).toThrow("every live staged");
  const archived = await cache.archiveCandidate(f.source.source);
  const cloneRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-upstream-portable-")); roots.push(cloneRoot);
  const clone = await createEvidenceFixture(cloneRoot, 'Ada said, "Wait." Nothing changes.');
  const cloneCache = new PreparedNovelCache(cloneRoot, cacheRoot);
  if (point === "staged") {
    const local = new SourceAnnotationStore(cloneRoot), draft = checkpoint.drafts[0]!;
    if (draft.store !== "annotation") throw new Error("Expected quotation fixture");
    await local.stage(f.sourceId, { ...draft.envelope, id: "local-stray" });
    await expect(cloneCache.restoreCompilerCheckpoint(clone.source, archived.bundleHash!)).rejects.toThrow("unrelated local pending");
    expect(await new CanonicalModelStore(cloneRoot).listEntities()).toEqual([]);
    expect((await local.listProposals(f.sourceId, "pending")).map(item => item.id)).toEqual(["local-stray"]);
    await local.withdraw(f.sourceId, "local-stray");
  }
  await cloneCache.restoreCompilerCheckpoint(clone.source, archived.bundleHash!);
  await cloneCache.restoreCompilerCheckpoint(clone.source, archived.bundleHash!);
  const cloneReceipts = new CompilerFinishReceipts(cloneRoot, f.sourceId, f.plan.batchId);
  expect(await cloneReceipts.read()).toEqual(originalReceipt);
  expect(await new UpstreamRepairLedger(cloneRoot, f.sourceId).history()).toEqual(await f.ledger.history());
  const proposals = new SourceAnnotationStore(cloneRoot);
  expect(await proposals.readProposal(f.sourceId, checkpoint.drafts[0]!.status, "repair-proposal")).toEqual(checkpoint.drafts[0]!.envelope);
  const { prepareUpstreamRepairFinish } = await import("../src/compiler/upstream-repair-finish.js");
  const expectedIntent = f.intent ?? await prepareUpstreamRepairFinish(cloneRoot, f.sourceId, f.plan.planHash, f.finishInput);
  const noStage = vi.spyOn(SourceAnnotationStore.prototype, "stage");
  const completed = await executeUpstreamRepairFinish(cloneRoot, f.sourceId, f.plan.planHash);
  expect(completed.state).toBe("completed");
  expect(completed.identity.upstreamRepairIntent).toEqual(expectedIntent);
  expect(noStage).not.toHaveBeenCalled();
  expect((await proposals.read(f.sourceId, "quote-one")).anchor.endByte).toBe(f.annotation.anchor.endByte + 1);
  if (originalReceipt) expect(completed.fingerprint).toBe(originalReceipt.fingerprint);
  expect((await convergeWorldProposals(cloneRoot, f.sourceId)).upstreamRepairIssues).toBeUndefined();
  expect((await new UpstreamRepairLedger(cloneRoot, f.sourceId).inspect()).plans[0]!.state).toBe(point === "evaluated" ? "evaluated" : "converged");
  // Later convergence cannot be replaced by an earlier portable checkpoint.
  if (["converged", "evaluated"].includes(point)) await cloneCache.restoreCompilerCheckpoint(clone.source, archived.bundleHash!);
  else await expect(cloneCache.restoreCompilerCheckpoint(clone.source, archived.bundleHash!)).rejects.toThrow();
});

it("observes actual upstream revisions after convergence and preserves the unevaluated gate", async () => {
  const { executeUpstreamRepairFinish } = await import("../src/compiler/upstream-repair-finish.js");
  const { convergeWorldProposals } = await import("../src/compiler/converge.js");
  const { upstreamRepairJournalSchema, upstreamRepairUnsettledIssues } = await import("../src/compiler/upstream-repair-ledger.js");
  const f = await frozenQuotationFinish();
  await expect(f.ledger.recordConverged(f.plan.planHash)).rejects.toThrow("original finished repair");
  await executeUpstreamRepairFinish(f.root, f.sourceId, f.plan.planHash);
  expect((await f.ledger.inspect()).plans[0]!.state).toBe("finished");
  expect((await convergeWorldProposals(f.root, f.sourceId)).upstreamRepairIssues).toBeUndefined();
  const records = await f.ledger.history(), last = records.at(-1)!;
  expect(last.payload).toMatchObject({ kind: "converged", planHash: f.plan.planHash, activeRevisions: [{ kind: "quotation", id: "quote-one", revisionHash: contentHash(await new SourceAnnotationStore(f.root).read(f.sourceId, "quote-one")) }] });
  expect((await f.ledger.inspect()).plans[0]!.state).toBe("converged");
  expect(upstreamRepairUnsettledIssues(records)).toEqual([expect.stringContaining("NOT_EVALUATED")]);
  await convergeWorldProposals(f.root, f.sourceId);
  expect(await f.ledger.history()).toEqual(records);
  const altered = structuredClone(records), bad = altered.at(-1)!;
  if (bad.payload.kind !== "converged") throw new Error("Expected convergence");
  bad.payload.activeRevisions[0]!.revisionHash = "0".repeat(64);
  const { hash: _hash, ...identity } = bad; bad.hash = contentHash(identity);
  expect(() => upstreamRepairJournalSchema.parse(altered)).toThrow("authorized outputs");
});

it("defers convergence for downstream pending work and retries only host observation", async () => {
  const { executeUpstreamRepairFinish } = await import("../src/compiler/upstream-repair-finish.js");
  const { convergeWorldProposals } = await import("../src/compiler/converge.js");
  const f = await frozenQuotationFinish(); await executeUpstreamRepairFinish(f.root, f.sourceId, f.plan.planHash);
  const annotations = new SourceAnnotationStore(f.root);
  await annotations.stage(f.sourceId, { version: 1, id: "downstream-pending", annotationType: "quotation", payload: { ...f.annotation, id: "downstream-quote" }, generatedBy: { worker: "fixture", compilerBatchId: "downstream-batch" }, createdAt: "2026-09-16T00:00:00Z" });
  expect((await convergeWorldProposals(f.root, f.sourceId)).upstreamRepairIssues).toEqual([expect.stringContaining("CONVERGENCE_PENDING")]);
  expect((await f.ledger.inspect()).plans[0]!.state).toBe("finished");
  await annotations.withdraw(f.sourceId, "downstream-pending");
  vi.spyOn(UpstreamRepairLedger.prototype, "recordConverged").mockRejectedValueOnce(new Error("injected journal storage interruption"));
  expect((await convergeWorldProposals(f.root, f.sourceId)).upstreamRepairIssues).toEqual([expect.stringContaining("storage interruption")]);
  expect((await f.ledger.inspect()).plans[0]!.state).toBe("finished");
  await convergeWorldProposals(f.root, f.sourceId);
  expect((await f.ledger.inspect()).plans[0]!.state).toBe("converged");
  expect((await f.ledger.inspect()).attempts).toHaveLength(1);
});

it.each([false, true])("stops changed active revisions on convergence (previously converged=%s)", async wasConverged => {
  const { executeUpstreamRepairFinish } = await import("../src/compiler/upstream-repair-finish.js");
  const { convergeWorldProposals } = await import("../src/compiler/converge.js");
  const f = await frozenQuotationFinish(); await executeUpstreamRepairFinish(f.root, f.sourceId, f.plan.planHash);
  if (wasConverged) await convergeWorldProposals(f.root, f.sourceId);
  const changed = { ...f.annotation, attributionConfidence: 0.4 }; await f.write(changed, "later-third-party-revision");
  const result = await convergeWorldProposals(f.root, f.sourceId);
  expect(result.upstreamRepairIssues?.[0]).toContain("Active dependency changed");
  expect((await f.ledger.inspect()).plans[0]!.state).toBe("needs-host-review");
  expect(await new SourceAnnotationStore(f.root).read(f.sourceId, "quote-one")).toEqual(changed);
  const history = await f.ledger.history();
  await convergeWorldProposals(f.root, f.sourceId);
  expect(await f.ledger.history()).toEqual(history);
});

async function convergedEvaluationFixture() {
  const { CanonicalModelStore } = await import("../src/world/canonical-model.js");
  const { InitialWorldStore } = await import("../src/world/initial.js");
  const { CompilerBatchStore, prepareCompilerBatches } = await import("../src/compiler/batches.js");
  const { PreparedNovelCache } = await import("../src/compiler/prepared-cache.js");
  const { executeUpstreamRepairFinish } = await import("../src/compiler/upstream-repair-finish.js");
  const { convergeWorldProposals } = await import("../src/compiler/converge.js");
  const f = await frozenQuotationFinish(), canonical = new CanonicalModelStore(f.root);
  await canonical.putEntity({ id: "ada", kind: "character", canonicalName: "Ada", aliases: [], evidence: f.source.evidence("Ada") });
  await new InitialWorldStore(f.root).put({ version: 1, evidence: f.source.evidence("Ada"), participantPresence: [{ entityId: "ada", mode: "physical" }], delta: { version: 1, operations: [{ op: "set", entityId: "ada", field: "character.alive", value: true }, { op: "set", entityId: "ada", field: "character.plan", value: "wait" }] } });
  await new CompilerBatchStore(f.root).replaceCompleted(f.sourceId, (await prepareCompilerBatches(f.root, f.source.source)).map(item => item.id));
  await executeUpstreamRepairFinish(f.root, f.sourceId, f.plan.planHash);
  await convergeWorldProposals(f.root, f.sourceId);
  return { ...f, canonical, cache: new PreparedNovelCache(f.root, path.join(f.root, "eval-cache")) };
}

it("records actual per-requirement failures without a hash cycle and rejects forged success", async () => {
  const { preparedSubjectHash, validateAssessmentRevision } = await import("../src/compiler/certification.js");
  const { upstreamRepairEvaluationIssues } = await import("../src/compiler/upstream-repair-evaluation.js");
  const f = await convergedEvaluationFixture();
  const before = await f.cache.candidateSnapshot(f.source.source), subject = preparedSubjectHash(before);
  const { settleUpstreamRepairRequirements } = await import("../src/compiler/upstream-repair-evaluation.js");
  const settlement = await settleUpstreamRepairRequirements(f.root, f.sourceId), result = settlement.results[0]!;
  expect(settlement.results).toHaveLength(1);
  expect(settlement.issues.some(issue => issue.includes("REQUIREMENT_UNRESOLVED"))).toBe(true);
  await expect(settleUpstreamRepairRequirements(f.root, "missing-source")).rejects.toThrow("Evaluation source is not registered");
  expect(result.subjectSnapshotHash).toBe(subject);
  expect(result.result.requirements.map(item => item.id).sort()).toEqual(f.plan.requirementIds.slice().sort());
  expect(result.result.requirements.some(item => item.state !== "satisfied")).toBe(true);
  expect((await f.ledger.inspect()).plans[0]!.state).toBe("evaluated");
  const { bundle, assessment } = await f.cache.inspectCandidate(f.source.source);
  expect(preparedSubjectHash(bundle)).toBe(subject);
  expect(upstreamRepairEvaluationIssues(bundle, assessment).some(issue => issue.includes("REQUIREMENT_UNRESOLVED"))).toBe(true);
  expect(validateAssessmentRevision(bundle, assessment).some(issue => issue.includes("UPSTREAM_REPAIR_REQUIREMENT_UNRESOLVED"))).toBe(true);
  const records = await f.ledger.history();
  await f.ledger.recordEvaluation(f.plan.planHash);
  expect(await f.ledger.history()).toEqual(records);
  const forged = structuredClone(bundle), last = forged.compilerSnapshot.upstreamRepairJournal!.at(-1)!;
  if (last.payload.kind !== "evaluated") throw new Error("Expected evaluation");
  for (const item of last.payload.evaluation.result.requirements) { item.state = "satisfied"; item.diagnostics = []; item.blockedBy = []; }
  const { hash: _hash, ...identity } = last; last.hash = contentHash(identity);
  expect(preparedSubjectHash(forged)).toBe(subject);
  expect(upstreamRepairEvaluationIssues(forged, assessment)).toContain(`UPSTREAM_REPAIR_EVALUATION_MISMATCH: ${f.plan.planHash}`);
});

it("certifies only actual satisfied repair obligations and invalidates changed or unobservable inputs", async () => {
  const { canonicalEventSchema } = await import("../src/world/model.js");
  const { convergeWorldProposals } = await import("../src/compiler/converge.js");
  const { preparedSubjectHash } = await import("../src/compiler/certification.js");
  const { upstreamRepairEvaluationIssues } = await import("../src/compiler/upstream-repair-evaluation.js");
  const { observeRequirementValidity } = await import("../src/compiler/requirement-observation.js");
  const f = await convergedEvaluationFixture();
  const event = canonicalEventSchema.parse({ id: "waiting", title: "Waiting", participants: ["ada"], participantPresence: [{ entityId: "ada", mode: "physical" }], storyTime: { kind: "unknown" }, preconditions: [], observedOutcome: { version: 1, operations: [] }, causalParents: [], confidence: 1, evidence: f.source.evidence("Nothing changes.") });
  await f.canonical.putEvent(event);
  const result = await f.ledger.recordEvaluation(f.plan.planHash);
  expect(result.result.requirements.every(item => item.state === "satisfied")).toBe(true);
  let current = await f.cache.inspectCandidate(f.source.source);
  expect(upstreamRepairEvaluationIssues(current.bundle, current.assessment)).toEqual([]);
  // Other closure/role/quality requirements remain independent; repair satisfaction is not publication.
  expect(current.assessment.fullNovelReady).toBe(false);
  const annotations = new SourceAnnotationStore(f.root);
  await annotations.stage(f.sourceId, { version: 1, id: "unrelated-pending", annotationType: "quotation", payload: { ...f.annotation, id: "other-quote" }, generatedBy: { worker: "fixture" }, createdAt: "2026-09-16T00:00:00Z" });
  await observeRequirementValidity(f.root, f.sourceId);
  expect((await f.ledger.inspect()).plans[0]!.state).toBe("converged");
  expect((await f.ledger.history()).at(-1)!.payload).toMatchObject({ kind: "evaluation-invalidated", nextSubjectSnapshotHash: null });
  await annotations.withdraw(f.sourceId, "unrelated-pending");
  expect(preparedSubjectHash(await f.cache.candidateSnapshot(f.source.source))).toBe(result.subjectSnapshotHash);
  await f.ledger.recordEvaluation(f.plan.planHash);
  await f.canonical.putEvent({ ...event, observedOutcome: { version: 1, operations: [{ op: "set", entityId: "ada", field: "character.alive", value: false }] } });
  current = await f.cache.inspectCandidate(f.source.source);
  expect(upstreamRepairEvaluationIssues(current.bundle, current.assessment)).toContain(`UPSTREAM_REPAIR_EVALUATION_STALE: ${f.plan.planHash}`);
  await convergeWorldProposals(f.root, f.sourceId);
  expect((await f.ledger.inspect()).plans[0]!.state).toBe("converged");
  const changed = await f.ledger.recordEvaluation(f.plan.planHash);
  expect(changed.result.requirements.some(item => item.state !== "satisfied")).toBe(true);
  expect(changed.subjectSnapshotHash).not.toBe(result.subjectSnapshotHash);
});

it("keeps successor obligations unresolved instead of erasing failed predecessor history", async () => {
  const { upstreamRepairEvaluationIssues } = await import("../src/compiler/upstream-repair-evaluation.js");
  const f = await convergedEvaluationFixture(); await f.ledger.recordEvaluation(f.plan.planHash);
  const prior = await f.ledger.history();
  await f.ledger.stop(f.plan.planHash, "Host approved a revised source dependency");
  const changed = { ...f.annotation, attributionConfidence: 0.7 }; await f.write(changed, "host-successor-baseline");
  const next = freezeUpstreamRepairPlan({ ...f.identity, planId: "successor", batchId: "successor-batch", baselineRefs: [{ kind: "quotation", id: changed.id, revisionHash: contentHash(changed) }] });
  await f.ledger.register(next, f.plan.planHash);
  const { bundle, assessment } = await f.cache.inspectCandidate(f.source.source);
  expect(upstreamRepairEvaluationIssues(bundle, assessment)).toEqual([`UPSTREAM_REPAIR_NOT_EVALUATED: ${next.planHash} (planned)`]);
  expect((await f.ledger.history()).slice(0, prior.length)).toEqual(prior);
});

it("allows a stopped completed repair to have a validated successor without rewriting its old draft", async () => {
  const { executeUpstreamRepairFinish } = await import("../src/compiler/upstream-repair-finish.js");
  const { stageUpstreamRepair } = await import("../src/compiler/upstream-repair-staging.js");
  const f = await frozenQuotationFinish(); await executeUpstreamRepairFinish(f.root, f.sourceId, f.plan.planHash);
  const annotations = new SourceAnnotationStore(f.root), old = await annotations.readProposal(f.sourceId, "accepted", "repair-proposal"), current = await annotations.read(f.sourceId, "quote-one");
  await f.ledger.stop(f.plan.planHash, "Host reviewed the next bounded source refinement");
  const { CompilerFinishReceipts } = await import("../src/compiler/finish-receipts.js");
  const receipt = await new CompilerFinishReceipts(f.root, f.sourceId, f.plan.batchId).read();
  const next = freezeUpstreamRepairPlan({ ...f.identity, planId: "next-completed-repair", batchId: "next-completed-batch", predecessorReceiptRefs: [receipt!.fingerprint], baselineRefs: [{ kind: "quotation", id: current.id, revisionHash: contentHash(current) }] });
  await f.ledger.register(next, f.plan.planHash); await f.ledger.authorize(next.planHash);
  await stageUpstreamRepair(f.root, f.sourceId, next.planHash, { kind: "quotation", id: current.id }, { proposal_id: "successor-proposal", annotation_id: current.id, selector: { segment_id: f.source.segmentId, exact: '"Wait."' }, mode: "direct", addressee_mention_ids: [], attribution_confidence: 1 });
  expect(await annotations.readProposal(f.sourceId, "accepted", "repair-proposal")).toEqual(old);
  expect((await f.ledger.inspect()).attempts).toHaveLength(2);
});

it("reserves one isolated Pi slot before session construction and charges malformed payloads before correction", async () => {
  const { runUpstreamRepairModelSlot } = await import("../src/compiler/pi-upstream-repair.js");
  const f = await fixture(); await f.ledger.register(f.plan); await f.ledger.authorize(f.plan.planHash);
  const dispose = vi.fn(async () => {});
  const createSession = vi.fn(async (options: import("../src/agent/pi-session.js").PiAgentSessionOptions) => {
    expect((await f.ledger.inspect()).modelSessions).toHaveLength(1);
    expect(options).toMatchObject({ saveSession: false, includeProjectInstructions: false, includeLocalTools: false, includeNwhExtension: false, trackLastOpenedSession: false });
    expect(options.sessionId).toBeUndefined();
    expect(options.additionalTools?.map(tool => tool.name)).toEqual(["read_upstream_repair_context", "propose_quotation"]);
    return { dispose, promptWithReport: async (prompt: string) => {
      const data = JSON.parse(prompt), tool = options.additionalTools!.find(tool => tool.name === "propose_quotation")!;
      const call = async (proposal_json: string) => tool.execute("model-call", tool.prepareArguments!({ proposal_json }) as never, undefined, undefined, {} as never);
      expect(data.context.evidence[0].segmentId).toBe(f.source.segmentId);
      await expect(call("not JSON")).rejects.toThrow();
      expect((await f.ledger.inspect()).attempts[0]!.failed).toBe(true);
      await call(JSON.stringify({ annotation_id: "quote-one", selector: { segment_id: f.source.segmentId, exact: "Wait." }, mode: "direct", addressee_mention_ids: [], attribution_confidence: 1 }));
      return {} as never;
    } };
  });
  await runUpstreamRepairModelSlot(f.root, f.sourceId, f.plan.planHash, { kind: "quotation", id: "quote-one" }, {}, createSession);
  expect(dispose).toHaveBeenCalledOnce();
  const state = await f.ledger.inspect();
  expect(state.modelSessions[0]).toMatchObject({ closed: true, chargedFailure: false });
  expect(state.attempts).toHaveLength(2);
  expect(state.attempts[0]!.started.proposalId).toBe(state.attempts[1]!.started.proposalId);
  expect(state.attempts[1]!.staged).toBe(true);
  expect(await new SourceAnnotationStore(f.root).read(f.sourceId, "quote-one")).toEqual(f.annotation);
  await expect(runUpstreamRepairModelSlot(f.root, f.sourceId, f.plan.planHash, { kind: "quotation", id: "quote-one" }, {}, createSession)).rejects.toThrow("successful draft");
  expect(createSession).toHaveBeenCalledOnce();
});

it("counts model sessions with no proposal across revised plans and stops before a third provider invocation", async () => {
  const { runUpstreamRepairModelSlot } = await import("../src/compiler/pi-upstream-repair.js");
  const f = await fixture(), createSession = vi.fn(async () => ({ dispose: async () => {}, promptWithReport: async () => ({} as never) }));
  let plan = f.plan, predecessor: string | null = null;
  for (let index = 0; index < 3; index++) {
    if (index) {
      const changed = { ...f.annotation, attributionConfidence: 1 - index / 10 }; await f.write(changed, `host-model-baseline-${index}`);
      predecessor = plan.planHash;
      plan = freezeUpstreamRepairPlan({ ...f.identity, planId: `model-plan-${index}`, batchId: `model-batch-${index}`, baselineRefs: [{ kind: "quotation", id: changed.id, revisionHash: contentHash(changed) }] });
    }
    await f.ledger.register(plan, predecessor); await f.ledger.authorize(plan.planHash);
    await expect(runUpstreamRepairModelSlot(f.root, f.sourceId, plan.planHash, { kind: "quotation", id: "quote-one" }, {}, createSession)).rejects.toThrow(index < 2 ? "without its required" : "budget exhausted");
  }
  expect(createSession).toHaveBeenCalledTimes(2);
  expect((await f.ledger.inspect()).modelSessions.filter(item => item.chargedFailure)).toHaveLength(2);
});

it("recovers an interrupted model write without invoking the provider or staging twice", async () => {
  const { runUpstreamRepairModelSlot, recoverUpstreamRepairModelSession } = await import("../src/compiler/pi-upstream-repair.js");
  const { captureUpstreamRepairCheckpoint } = await import("../src/compiler/upstream-repair-checkpoint.js");
  const f = await fixture(); await f.ledger.register(f.plan); await f.ledger.authorize(f.plan.planHash);
  const createSession = vi.fn(async (options: import("../src/agent/pi-session.js").PiAgentSessionOptions) => ({
    dispose: async () => {}, promptWithReport: async () => {
      const tool = options.additionalTools!.find(item => item.name === "propose_quotation")!;
      await tool.execute("interrupted", tool.prepareArguments!({ proposal_json: JSON.stringify({ annotation_id: "quote-one", selector: { segment_id: f.source.segmentId, exact: "Wait." }, mode: "direct", addressee_mention_ids: [], attribution_confidence: 1 }) }) as never, undefined, undefined, {} as never);
      return {} as never;
    },
  }));
  const record = vi.spyOn(UpstreamRepairLedger.prototype, "recordStaged").mockRejectedValueOnce(new Error("interrupted staged result append"));
  const invoke = () => runUpstreamRepairModelSlot(f.root, f.sourceId, f.plan.planHash, { kind: "quotation", id: "quote-one" }, {}, createSession);
  await expect(invoke()).rejects.toThrow("original unresolved attempt");
  record.mockRestore();
  const reservation = (await f.ledger.inspect()).modelSessions[0]!;
  expect(reservation.closed).toBe(false);
  await expect(captureUpstreamRepairCheckpoint(f.root, f.sourceId)).rejects.toThrow("unresolved model session");
  await expect(invoke()).rejects.toThrow();
  expect(createSession).toHaveBeenCalledOnce();
  const stage = vi.spyOn(SourceAnnotationStore.prototype, "stage");
  await recoverUpstreamRepairModelSession(f.root, f.sourceId, reservation.sessionRef);
  expect(stage).not.toHaveBeenCalled();
  expect((await f.ledger.inspect()).modelSessions[0]).toMatchObject({ closed: true, chargedFailure: false });
  expect((await f.ledger.inspect()).attempts).toHaveLength(1);
  expect(await new SourceAnnotationStore(f.root).read(f.sourceId, "quote-one")).toEqual(f.annotation);
});

it("schedules prerequisite slots and resumes retained drafts without re-running their model calls", async () => {
  const { stageUpstreamRepairPlan, upstreamRepairSlotOrder } = await import("../src/compiler/upstream-repair-scheduler.js");
  const { stageUpstreamRepair } = await import("../src/compiler/upstream-repair-staging.js");
  const f = await fixture(), requirement = f.identity.requirementIds[0]!;
  const plan = freezeUpstreamRepairPlan({ ...f.identity,
    allowedWrites: [{ kind: "quotation", id: "quote-one", pointers: ["/anchor", "/speakerMentionId"] }],
    allowedCreations: [{ kind: "entity-mention", id: "new-speaker", maxCount: 1, dependencyOf: requirement }],
    dependencyEdges: [{ from: `requirement:${requirement}`, to: "entity-mention:new-speaker", purpose: "identity" }, { from: "quotation:quote-one", to: "entity-mention:new-speaker", purpose: "identity" }],
  });
  await f.ledger.register(plan); await f.ledger.authorize(plan.planHash);
  expect(upstreamRepairSlotOrder(plan).map(slot => slot.kind)).toEqual(["entity-mention", "quotation"]);
  let interrupt = true;
  const run = vi.fn(async (root: string, sourceId: string, planHash: string, target: { kind: import("../src/compiler/upstream-repair-plan.js").UpstreamRepairKind; id: string }) => {
    if (target.kind === "quotation" && interrupt) throw new Error("host interrupted before consumer invocation");
    const raw = target.kind === "entity-mention"
      ? { proposal_id: "speaker-draft", annotation_id: target.id, selector: { segment_id: f.source.segmentId, exact: "Ada" }, surface: "Ada", form: "proper", kind_candidates: ["character"], confidence: 1 }
      : { proposal_id: "quote-draft", annotation_id: target.id, selector: { segment_id: f.source.segmentId, exact: "Wait." }, mode: "direct", speaker_mention_id: "new-speaker", addressee_mention_ids: [], attribution_confidence: 1 };
    return { sessionRef: "test-host-runner", ...await stageUpstreamRepair(root, sourceId, planHash, target, raw) };
  });
  await expect(stageUpstreamRepairPlan(f.root, f.sourceId, plan.planHash, {}, run)).rejects.toThrow("host interrupted");
  expect((await f.ledger.inspect()).attempts).toHaveLength(1);
  interrupt = false; run.mockClear();
  const result = await stageUpstreamRepairPlan(f.root, f.sourceId, plan.planHash, {}, run);
  expect(result.results.map(item => item.reused)).toEqual([true, false]);
  expect(run).toHaveBeenCalledOnce();
  expect(run.mock.calls[0]![3].kind).toBe("quotation");
  run.mockClear();
  expect((await stageUpstreamRepairPlan(f.root, f.sourceId, plan.planHash, {}, run)).results.every(item => item.reused)).toBe(true);
  expect(run).not.toHaveBeenCalled();
  expect(await new SourceAnnotationStore(f.root).read(f.sourceId, "quote-one")).toEqual(f.annotation);
  await f.write({ ...f.annotation, attributionConfidence: 0.5 }, "host-drift");
  await expect(stageUpstreamRepairPlan(f.root, f.sourceId, plan.planHash, {}, run)).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
  expect((await f.ledger.inspect()).plans[0]!.state).toBe("needs-host-review");
});

it("rejects scheduler text-only success and unresolved original reservations before another invocation", async () => {
  const { stageUpstreamRepairPlan } = await import("../src/compiler/upstream-repair-scheduler.js");
  const f = await fixture(); await f.ledger.register(f.plan); await f.ledger.authorize(f.plan.planHash);
  const run = vi.fn(async () => ({ sessionRef: "fake", proposalId: "fake", attemptRef: "fake", proposalHash: "fake" }));
  await expect(stageUpstreamRepairPlan(f.root, f.sourceId, f.plan.planHash, {}, run)).rejects.toThrow("without a durable staged result");
  await f.ledger.startModelSession(f.plan.planHash, { artifactKind: "quotation", artifactId: "quote-one", proposalId: "reserved", promptHash: "a".repeat(64) });
  run.mockClear();
  await expect(stageUpstreamRepairPlan(f.root, f.sourceId, f.plan.planHash, {}, run)).rejects.toThrow("no recoverable validated result");
  expect(run).not.toHaveBeenCalled();
});

it("runs frozen host registration, authorization and interrupted finish through locked commands", async () => {
  const { registerUpstreamRepairPlanCommand, authorizeUpstreamRepairPlanCommand, finishUpstreamRepairPlanCommand, stopUpstreamRepairPlanCommand } = await import("../src/commands/upstream-repair.js");
  const { stageUpstreamRepair } = await import("../src/compiler/upstream-repair-staging.js");
  const { WorkspaceOperationLock } = await import("../src/util/workspace-lock.js");
  const f = await fixture(), planFile = path.join(f.root, "host-plan.json"), inputFile = path.join(f.root, "host-finish.json");
  await fs.writeFile(planFile, JSON.stringify(f.plan));
  await expect(registerUpstreamRepairPlanCommand(f.root, "wrong-source", planFile)).rejects.toThrow("differs from --source");
  expect(await f.ledger.history()).toEqual([]);
  expect((await registerUpstreamRepairPlanCommand(f.root, f.sourceId, planFile)).state).toBe("planned");
  const registered = await f.ledger.history();
  await registerUpstreamRepairPlanCommand(f.root, f.sourceId, planFile);
  expect(await f.ledger.history()).toEqual(registered);
  const raw = { proposal_id: "command-proposal", annotation_id: "quote-one", selector: { segment_id: f.source.segmentId, exact: "Wait." }, mode: "direct", addressee_mention_ids: [], attribution_confidence: 1 };
  await expect(stageUpstreamRepair(f.root, f.sourceId, f.plan.planHash, { kind: "quotation", id: "quote-one" }, raw)).rejects.toThrow("not authorized");
  expect((await authorizeUpstreamRepairPlanCommand(f.root, f.sourceId, f.plan.planHash)).state).toBe("authorized");
  await stageUpstreamRepair(f.root, f.sourceId, f.plan.planHash, { kind: "quotation", id: "quote-one" }, raw);
  await expect(finishUpstreamRepairPlanCommand(f.root, f.sourceId, f.plan.planHash)).rejects.toThrow("First finish requires");
  expect(await new SourceAnnotationStore(f.root).read(f.sourceId, "quote-one")).toEqual(f.annotation);
  const input = { outcome: "complete", reviewed_segments: [{ segment_id: f.source.segmentId, disposition: "proposed", summary: "Reviewed original source" }], summary: "Bounded quotation repair" };
  await fs.writeFile(inputFile, JSON.stringify(input));
  const original = SourceAnnotationStore.prototype.commitProposals;
  vi.spyOn(SourceAnnotationStore.prototype, "commitProposals").mockImplementationOnce(async function (...args) {
    expect((await WorkspaceOperationLock.inspect(f.root)).owner?.pid).toBe(process.pid);
    await original.apply(this, args);
    throw new Error("command interrupted after authorized annotation commit");
  });
  await expect(finishUpstreamRepairPlanCommand(f.root, f.sourceId, f.plan.planHash, inputFile)).rejects.toThrow("command interrupted");
  expect((await WorkspaceOperationLock.inspect(f.root)).owner).toBeUndefined();
  expect((await f.ledger.inspect()).plans[0]!.state).toBe("finish-frozen");
  const partial = await new SourceAnnotationStore(f.root).read(f.sourceId, "quote-one");
  await fs.writeFile(inputFile, JSON.stringify({ ...input, summary: "replacement review" }));
  await expect(finishUpstreamRepairPlanCommand(f.root, f.sourceId, f.plan.planHash, inputFile)).rejects.toThrow("Original frozen finish input changed");
  expect(await new SourceAnnotationStore(f.root).read(f.sourceId, "quote-one")).toEqual(partial);
  const result = await finishUpstreamRepairPlanCommand(f.root, f.sourceId, f.plan.planHash);
  expect(result.state).toBe("finished"); expect(result.receipt.state).toBe("completed");
  const records = await f.ledger.history();
  expect((await finishUpstreamRepairPlanCommand(f.root, f.sourceId, f.plan.planHash)).receipt).toEqual(result.receipt);
  expect(await f.ledger.history()).toEqual(records);
  expect((await stopUpstreamRepairPlanCommand(f.root, f.sourceId, f.plan.planHash, "Host reviewed a dependency revision")).state).toBe("needs-host-review");
  await expect(authorizeUpstreamRepairPlanCommand(f.root, f.sourceId, f.plan.planHash)).rejects.toThrow("stopped");
  await expect(finishUpstreamRepairPlanCommand(f.root, f.sourceId, f.plan.planHash)).rejects.toThrow("Original active frozen finish intent is missing");
});

it("derives only exact quotation and missing-speaker policy from reviewed typed diagnostics", async () => {
  const { planUpstreamRepair } = await import("../src/compiler/upstream-repair-planner.js");
  const { stageUpstreamRepair } = await import("../src/compiler/upstream-repair-staging.js");
  const f = await fixture(), requirementId = f.identity.requirementIds[0]!;
  const quotation = { ...f.annotation, speakerMentionId: "absent-speaker" }; await f.write(quotation, "reviewed-quote");
  const review = { version: 1, sourceId: f.sourceId, sourceSha256: f.source.source.contentSha256, planId: "derived-plan", batchId: "derived-batch", requirementSetHash: f.plan.requirementSetHash,
    requirementIds: f.plan.requirementIds, predecessorReceiptRefs: [], segmentIds: [f.source.segmentId], citableEvidenceRefs: [f.source.segmentId], authorizationRef: "independent-quotation-review", retryBudgetRef: "original-budget",
    diagnostics: [{ code: "QUOTATION_ANCHOR_INCOMPLETE", quotationId: quotation.id, revisionHash: contentHash(quotation), requirementId, expectedAnchor: textAnchorForByteRange(f.sourceId, Buffer.from('Ada said, "Wait." Nothing changes.'), 11, 16) },
      { code: "QUOTATION_SPEAKER_MENTION_MISSING", quotationId: quotation.id, revisionHash: contentHash(quotation), requirementId }] };
  const result = await planUpstreamRepair(f.root, review), plan = result.plan!;
  expect(result.status).toBe("ready-for-host-authorization");
  expect(result.authority).toBe("diagnostic-only");
  expect(await f.ledger.history()).toEqual([]);
  expect(plan.allowedWrites).toEqual([{ kind: "quotation", id: quotation.id, pointers: ["/anchor"] }]);
  expect(plan.allowedCreations).toEqual([{ kind: "entity-mention", id: "absent-speaker", maxCount: 1, dependencyOf: requirementId }]);
  expect(plan.readableRefs).toEqual([{ kind: "quotation", id: quotation.id }]);
  expect((await planUpstreamRepair(f.root, review)).plan).toEqual(plan);
  await f.ledger.register(plan); await f.ledger.authorize(plan.planHash);
  await stageUpstreamRepair(f.root, f.sourceId, plan.planHash, { kind: "entity-mention", id: "absent-speaker" }, { proposal_id: "derived-speaker", annotation_id: "absent-speaker", selector: { segment_id: f.source.segmentId, exact: "Ada" }, surface: "Ada", form: "proper", kind_candidates: ["character"], confidence: 1 });
  await stageUpstreamRepair(f.root, f.sourceId, plan.planHash, { kind: "quotation", id: quotation.id }, { proposal_id: "derived-quotation", annotation_id: quotation.id, selector: { segment_id: f.source.segmentId, exact: "Wait." }, mode: "direct", speaker_mention_id: "absent-speaker", addressee_mention_ids: [], attribution_confidence: 1 });
  const { prepareUpstreamRepairFinish, executeUpstreamRepairFinish } = await import("../src/compiler/upstream-repair-finish.js");
  await prepareUpstreamRepairFinish(f.root, f.sourceId, plan.planHash, { outcome: "complete", reviewed_segments: [{ segment_id: f.source.segmentId, disposition: "proposed", summary: "Independent source review" }], summary: "Repair source dependencies" });
  await executeUpstreamRepairFinish(f.root, f.sourceId, plan.planHash);
  expect((await new SourceAnnotationStore(f.root).read(f.sourceId, "absent-speaker")).annotationType).toBe("entity-mention");
  expect(quotationSchema.parse(await new SourceAnnotationStore(f.root).read(f.sourceId, quotation.id)).anchor).toEqual(review.diagnostics[0]!.expectedAnchor);
  await expect(planUpstreamRepair(f.root, review)).rejects.toThrow("reviewed revision changed");
});

it("refuses false diagnostic claims and routes unsupported semantics to host review without authority", async () => {
  const { planUpstreamRepair } = await import("../src/compiler/upstream-repair-planner.js");
  const f = await fixture(), requirementId = f.plan.requirementIds[0]!;
  const review = { version: 1, sourceId: f.sourceId, sourceSha256: f.source.source.contentSha256, planId: "review-plan", batchId: "review-batch", requirementSetHash: f.plan.requirementSetHash,
    requirementIds: f.plan.requirementIds, predecessorReceiptRefs: [], segmentIds: [f.source.segmentId], citableEvidenceRefs: [f.source.segmentId], authorizationRef: "review", retryBudgetRef: "review-budget" };
  await expect(planUpstreamRepair(f.root, { ...review, diagnostics: [{ code: "QUOTATION_SPEAKER_MENTION_MISSING", quotationId: f.annotation.id, revisionHash: contentHash(f.annotation), requirementId }] })).rejects.toThrow("genuinely absent typed annotation dependency");
  await expect(planUpstreamRepair(f.root, { ...review, diagnostics: [{ code: "QUOTATION_ANCHOR_INCOMPLETE", quotationId: f.annotation.id, revisionHash: contentHash(f.annotation), requirementId, expectedAnchor: f.annotation.anchor }] })).rejects.toThrow("strict original-byte extension");
  await expect(planUpstreamRepair(f.root, { ...review, diagnostics: [{ code: "QUOTATION_ANCHOR_INCOMPLETE", quotationId: f.annotation.id, revisionHash: contentHash(f.annotation), requirementId, expectedAnchor: f.annotation.anchor, pointers: ["/mode"] }] })).rejects.toThrow();
  expect(await planUpstreamRepair(f.root, { ...review, diagnostics: [{ code: "SEMANTIC_MODULE_REQUIRED", semanticKind: "unknown-duration-incapacity", requirementId }] })).toMatchObject({ authority: "diagnostic-only", status: "needs-host-review", plan: null });
  expect(await f.ledger.history()).toEqual([]);
  expect(await new SourceAnnotationStore(f.root).read(f.sourceId, f.annotation.id)).toEqual(f.annotation);
});


it("plans a second source's longer quotation without widening identity or other fields", async () => {
  const { planUpstreamRepair } = await import("../src/compiler/upstream-repair-planner.js");
  const text = 'Behind a wall, Ren whispered, "Stay by the gate." Nothing changes.';
  const f = await fixture(text, "Stay"), full = "Stay by the gate.", start = text.indexOf(full);
  const review = { version: 1, sourceId: f.sourceId, sourceSha256: f.source.source.contentSha256, planId: "ren-plan", batchId: "ren-batch", requirementSetHash: f.plan.requirementSetHash,
    requirementIds: f.plan.requirementIds, predecessorReceiptRefs: [], segmentIds: [f.source.segmentId], citableEvidenceRefs: [f.source.segmentId], authorizationRef: "ren-source-review", retryBudgetRef: "ren-budget",
    diagnostics: [{ code: "QUOTATION_ANCHOR_INCOMPLETE", quotationId: f.annotation.id, revisionHash: contentHash(f.annotation), requirementId: f.plan.requirementIds[0]!, expectedAnchor: textAnchorForByteRange(f.sourceId, Buffer.from(text), start, start + full.length) }] };
  const result = await planUpstreamRepair(f.root, review);
  expect(result.plan!.allowedWrites).toEqual([{ kind: "quotation", id: f.annotation.id, pointers: ["/anchor"] }]);
  expect(result.plan!.allowedCreations).toEqual([]);
  expect(result.plan!.sourceScope.sourceId).toBe(f.sourceId);
  await expect(planUpstreamRepair(f.root, { ...review, diagnostics: [{ ...review.diagnostics[0], revisionHash: "a".repeat(64) }] })).rejects.toThrow("reviewed revision changed");
  expect(await f.ledger.history()).toEqual([]);
});

it.each(["entity", "event"] as const)("discovers missing %s resolution and derives a stable source-bound creation policy", async kind => {
  const { discoverUpstreamRepairDiagnostics } = await import("../src/compiler/upstream-repair-discovery.js");
  const { planUpstreamRepair } = await import("../src/compiler/upstream-repair-planner.js");
  const { stageUpstreamRepair } = await import("../src/compiler/upstream-repair-staging.js");
  const { entityMentionSchema, eventMentionSchema } = await import("../src/compiler/annotations.js");
  const { CanonicalModelStore } = await import("../src/world/canonical-model.js");
  const { EntityResolutionStore } = await import("../src/compiler/entity-resolution.js");
  const { EventResolutionStore } = await import("../src/compiler/event-resolution.js");
  const f = await fixture(), bytes = Buffer.from('Ada said, "Wait." Nothing changes.');
  const entity = { id: "ada", kind: "character" as const, canonicalName: "Ada", aliases: [], evidence: f.source.evidence("Ada") };
  await new CanonicalModelStore(f.root).putEntity(entity);
  const mention = kind === "entity"
    ? entityMentionSchema.parse({ version: 1, id: "source-person", sourceId: f.sourceId, annotationType: "entity-mention", anchor: textAnchorForByteRange(f.sourceId, bytes, 0, 3), surface: "Ada", form: "proper", kindCandidates: ["character"], confidence: 1, derivation: f.annotation.derivation })
    : eventMentionSchema.parse({ version: 1, id: "source-action", sourceId: f.sourceId, annotationType: "event-mention", triggerAnchor: textAnchorForByteRange(f.sourceId, bytes, 4, 8), trigger: "said", extentAnchors: [textAnchorForByteRange(f.sourceId, bytes, 0, 17)], eventTypeCandidates: ["communication"], participantMentionIds: [], salience: "supporting", confidence: 1, derivation: f.annotation.derivation });
  const annotations = new SourceAnnotationStore(f.root);
  await annotations.stage(f.sourceId, { version: 1, id: "source-mention", annotationType: mention.annotationType, payload: mention, generatedBy: { worker: "fixture" }, createdAt: "2026-09-16T00:00:00Z" });
  await annotations.commitProposals(f.sourceId, ["source-mention"]);
  const discovery = await discoverUpstreamRepairDiagnostics(f.root, f.sourceId);
  expect(discovery.authority).toBe("diagnostic-only");
  expect(discovery.findings).toHaveLength(1);
  expect(discovery.findings[0]!.sourceSegmentIds).toEqual([f.source.segmentId]);
  expect(await f.ledger.history()).toEqual([]);
  const review = { version: 1, sourceId: f.sourceId, sourceSha256: f.source.source.contentSha256, planId: "resolution-plan", batchId: "resolution-batch", requirementSetHash: f.plan.requirementSetHash,
    requirementIds: f.plan.requirementIds, predecessorReceiptRefs: [], segmentIds: [f.source.segmentId], citableEvidenceRefs: [f.source.segmentId], authorizationRef: "source-resolution-review", retryBudgetRef: "resolution-budget",
    diagnostics: [{ ...discovery.findings[0]!.diagnostic, requirementId: f.plan.requirementIds[0]!, candidates: kind === "entity" ? [{ id: entity.id, revisionHash: contentHash(entity) }] : [] }] };
  const plan = (await planUpstreamRepair(f.root, review)).plan!, slot = plan.allowedCreations[0]!;
  expect(plan.allowedWrites).toEqual([]);
  expect(slot.kind).toBe(`${kind}-resolution`);
  expect((await planUpstreamRepair(f.root, { ...review, planId: "another-plan", batchId: "another-batch", retryBudgetRef: "another-budget" })).plan!.allowedCreations[0]!.id).toBe(slot.id);
  await f.ledger.register(plan); await f.ledger.authorize(plan.planHash);
  const input = kind === "entity"
    ? { proposal_id: "resolution-result", resolution_id: slot.id, mention_id: mention.id, status: "resolved", entity_id: entity.id, candidates: [{ entity_id: entity.id, confidence: 1, basis_mention_ids: [mention.id], evidence_assertion_ids: [], rationale: "Exact original named mention" }], rationale: "Reviewed identity" }
    : { proposal_id: "resolution-result", resolution_id: slot.id, event_mention_ids: [mention.id], status: "unresolved", candidates: [], supersedes_resolution_ids: [], rationale: "Source does not establish a canonical event match" };
  await stageUpstreamRepair(f.root, f.sourceId, plan.planHash, slot, input);
  const { prepareUpstreamRepairFinish, executeUpstreamRepairFinish } = await import("../src/compiler/upstream-repair-finish.js");
  await prepareUpstreamRepairFinish(f.root, f.sourceId, plan.planHash, { outcome: "complete", reviewed_segments: [{ segment_id: f.source.segmentId, disposition: "proposed", summary: "Original mention reviewed" }], summary: "Bounded resolution result" });
  await executeUpstreamRepairFinish(f.root, f.sourceId, plan.planHash);
  const stored = kind === "entity" ? await new EntityResolutionStore(f.root).list(f.sourceId) : await new EventResolutionStore(f.root).list(f.sourceId);
  expect(stored[0]!.status).toBe(kind === "entity" ? "resolved" : "unresolved");
  expect((await discoverUpstreamRepairDiagnostics(f.root, f.sourceId)).findings).toEqual([]);
  await expect(planUpstreamRepair(f.root, review)).rejects.toThrow("Resolution already exists");
  expect((await f.ledger.inspect()).plans[0]!.state).toBe("finished"); // No inferred satisfaction.
  const { assertUpstreamRepairMutation } = await import("../src/compiler/upstream-repair-plan.js");
  expect(() => assertUpstreamRepairMutation(plan, { kind: slot.kind, id: slot.id,
    payload: kind === "entity" ? { ...stored[0], mentionId: "different-mention" } : { ...stored[0], eventMentionIds: ["different-mention"] }, baseline: null,
    activeRevisions: new Map(plan.baselineRefs.map(ref => [`${ref.kind}:${ref.id}`, ref.revisionHash])), sourceSha256: plan.sourceScope.sourceSha256,
    requirementSetHash: plan.requirementSetHash, citedSegmentIds: [f.source.segmentId], hostDerivation: stored[0]!.derivation,
  })).toThrow("exact absent mention slot");
  const competing = { ...stored[0]!, id: "competing-resolution" };
  const { captureUpstreamRepairCheckpoint, assertUpstreamRepairCheckpointState } = await import("../src/compiler/upstream-repair-checkpoint.js");
  const checkpoint = (await captureUpstreamRepairCheckpoint(f.root, f.sourceId))!;
  const verified = await verifyUpstreamRepairPlan(f.root, plan, new Map([[`${slot.kind}:${slot.id}`, contentHash(stored[0])]]));
  await assertUpstreamRepairCheckpointState(checkpoint, await f.ledger.history(), f.sourceId, f.source.source.contentSha256, bytes, verified.payloads);
  await expect(assertUpstreamRepairCheckpointState(checkpoint, await f.ledger.history(), f.sourceId, f.source.source.contentSha256, bytes,
    new Map([...verified.payloads, [`${slot.kind}:${competing.id}`, competing]]))).rejects.toThrow("Resolution absence changed");

  const envelope = { version: 1 as const, id: "competing-proposal", generatedBy: { worker: "host-fixture" }, createdAt: "2026-09-16T00:00:00Z" };
  if (kind === "entity") {
    const { identityResolutionSchema } = await import("../src/compiler/entity-resolution.js");
    const store = new EntityResolutionStore(f.root);
    await store.stage(f.sourceId, { ...envelope, payload: identityResolutionSchema.parse(competing) });
    await store.commitProposals(f.sourceId, [envelope.id]);
  } else {
    const { eventResolutionSchema } = await import("../src/compiler/event-resolution.js");
    const store = new EventResolutionStore(f.root);
    await store.stage(f.sourceId, { ...envelope, payload: eventResolutionSchema.parse(competing) });
    await store.commitProposals(f.sourceId, [envelope.id]);
  }
  await expect(verifyUpstreamRepairPlan(f.root, plan, new Map([[`${slot.kind}:${slot.id}`, contentHash(stored[0])]]))).rejects.toThrow("Resolution absence changed");
});

it("binds regenerated findings to unresolved scene obligations through actual canonical dependencies", async () => {
  const { bindUpstreamRepairRequirements } = await import("../src/compiler/upstream-repair-binding.js");
  const { CanonicalModelStore } = await import("../src/world/canonical-model.js");
  const { canonicalEventSchema } = await import("../src/world/model.js");
  const { InitialWorldStore } = await import("../src/world/initial.js");
  const { CompilerBatchStore, prepareCompilerBatches } = await import("../src/compiler/batches.js");
  const f = await fixture('Ada told Bo, "Wait." Nothing changes.');
  await f.write({ ...f.annotation, speakerMentionId: "missing-speaker" }, "missing-speaker-quote");
  const canonical = new CanonicalModelStore(f.root);
  for (const [id, name] of [["ada", "Ada"], ["bo", "Bo"]] as const) await canonical.putEntity({ id, kind: "character", canonicalName: name, aliases: [], evidence: f.source.evidence(name) });
  await canonical.putProposition({ id: "waiting-content", subjectEntityId: "bo", relationId: "wait", object: { kind: "literal", value: true }, polarity: "positive", modality: "asserted", evidence: f.source.evidence("Wait.") });
  await canonical.putAttribution({ id: "spoken-content", propositionId: "waiting-content", holderKind: "character", holderEntityId: "ada", attitude: "asserts", certainty: 1, quotationIds: [f.annotation.id], evidence: f.source.evidence("Wait.") });
  await canonical.putClaim({ id: "heard-content", subject: "bo", predicate: "wait", object: true, epistemicType: "character-claim", speaker: "ada", evidence: f.source.evidence("Wait.") });
  const event = canonicalEventSchema.parse({ id: "waiting", title: "Waiting", participants: ["ada", "bo"], participantPresence: [{ entityId: "ada", mode: "physical" }, { entityId: "bo", mode: "physical" }], storyTime: { kind: "unknown" }, preconditions: [], causalParents: [], confidence: 1, evidence: f.source.evidence("Nothing changes."),
    observedOutcome: { version: 1, operations: [{ op: "set", entityId: "bo", field: "character.plan", value: "leave" }] },
    observedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "bo", claimId: "heard-content", propositionId: "waiting-content", attributionId: "spoken-content", acquisitionMode: "told", sourceActorId: "ada", status: "knows", confidence: 1 }] } });
  await canonical.putEvent(event);
  await new InitialWorldStore(f.root).put({ version: 1, evidence: f.source.evidence("Bo"), participantPresence: [{ entityId: "bo", mode: "physical" }], delta: { version: 1, operations: [{ op: "set", entityId: "bo", field: "character.alive", value: true }, { op: "set", entityId: "bo", field: "character.plan", value: "wait" }] } });
  await new CompilerBatchStore(f.root).replaceCompleted(f.sourceId, (await prepareCompilerBatches(f.root, f.source.source)).map(item => item.id));
  const result = await bindUpstreamRepairRequirements(f.root, f.sourceId);
  expect(result.authority).toBe("diagnostic-only");
  expect(result.bindings.some(item => item.requirementId === "waiting:state-effect" && item.path.map(node => node.id).join("/") === "waiting/spoken-content/quote-one")).toBe(true);
  expect(result.bindings.every(item => item.state !== "satisfied")).toBe(true);
  expect(await f.ledger.history()).toEqual([]);
  const { planBoundUpstreamRepair } = await import("../src/compiler/upstream-repair-bound-plan.js");
  const request = { version: 1, sourceId: f.sourceId, subjectSnapshotHash: result.subjectSnapshotHash, closureHash: result.closureHash,
    requirementSetHash: f.plan.requirementSetHash, findingIds: result.discovery.findings.map(item => item.findingId),
    planId: "bound-plan", batchId: "bound-batch", authorizationRef: "bound-host-review", retryBudgetRef: "bound-budget",
    segmentIds: [f.source.segmentId], citableEvidenceRefs: [f.source.segmentId], predecessorReceiptRefs: [] };
  const bound = await planBoundUpstreamRepair(f.root, request);
  expect(bound.plan.requirementIds).toEqual([...new Set(result.bindings.map(item => item.requirementId))].sort());
  expect(bound.plan.allowedWrites).toEqual([]);
  expect(bound.plan.allowedCreations).toHaveLength(1);
  expect(bound.plan.baselineRefs.map(item => `${item.kind}:${item.id}`)).toEqual(["attribution:spoken-content", "canonical-event:waiting", "quotation:quote-one"]);
  expect(await f.ledger.history()).toEqual([]);
  await expect(planBoundUpstreamRepair(f.root, { ...request, requirementIds: ["invented-success"] })).rejects.toThrow();
  await expect(planBoundUpstreamRepair(f.root, { ...request, findingIds: ["a".repeat(64)] })).rejects.toThrow("lacks a current typed path");
  await expect(planBoundUpstreamRepair(f.root, { ...request, subjectSnapshotHash: "b".repeat(64) })).rejects.toThrow("Bound repair inputs changed");
  // Removing the actual dependency must remove the link even though the source evidence still overlaps.
  await canonical.putEvent({ ...event, observedKnowledge: { version: 1, operations: [] } });
  const changed = await bindUpstreamRepairRequirements(f.root, f.sourceId);
  expect(changed.bindings).toEqual([]);
  expect(changed.unboundFindingIds).toHaveLength(1);
  expect(changed.subjectSnapshotHash).not.toBe(result.subjectSnapshotHash);
  await expect(planBoundUpstreamRepair(f.root, request)).rejects.toThrow("Bound repair inputs changed");
  await expect(verifyUpstreamRepairPlan(f.root, bound.plan)).rejects.toThrow("Active dependency changed: canonical-event:waiting");
  await expect(f.ledger.register(bound.plan)).rejects.toThrow("Active dependency changed");
  expect(await f.ledger.history()).toEqual([]);
});

it("preparation resumes original finish without staging and requires host review before a new model turn", async () => {
  const { prepareAuthorizedUpstreamRepair } = await import("../src/compiler/upstream-repair-preparation.js");
  const f = await frozenQuotationFinish(false), stage = vi.fn(async () => ({ planHash: f.plan.planHash, phase: "staged" as const, results: [] }));
  await expect(prepareAuthorizedUpstreamRepair(f.root, f.sourceId, f.plan.planHash, undefined, {}, stage)).rejects.toThrow("before invoking any model");
  await expect(prepareAuthorizedUpstreamRepair(f.root, f.sourceId, f.plan.planHash, { ...f.finishInput, reviewed_segments: [] }, {}, stage)).rejects.toThrow("exact complete host finish review");
  expect(stage).not.toHaveBeenCalled();
  const original = SourceAnnotationStore.prototype.commitProposals;
  vi.spyOn(SourceAnnotationStore.prototype, "commitProposals").mockImplementationOnce(async function (...args) { await original.apply(this, args); throw new Error("preparation interrupted after commit"); });
  await expect(prepareAuthorizedUpstreamRepair(f.root, f.sourceId, f.plan.planHash, f.finishInput, {}, stage)).rejects.toThrow("preparation interrupted");
  expect(stage).toHaveBeenCalledOnce(); stage.mockClear();
  await expect(prepareAuthorizedUpstreamRepair(f.root, f.sourceId, f.plan.planHash, { ...f.finishInput, summary: "replacement" }, {}, stage)).rejects.toThrow("cannot replace");
  const recovered = await prepareAuthorizedUpstreamRepair(f.root, f.sourceId, f.plan.planHash, undefined, {}, stage);
  expect(recovered.state).toBe("converged"); expect(recovered.issues).toEqual([]);
  expect(stage).not.toHaveBeenCalled();
  expect(await prepareAuthorizedUpstreamRepair(f.root, f.sourceId, f.plan.planHash, undefined, {}, stage)).toEqual(recovered);
});

it("cancels an isolated upstream model through Pi and retains its original session outcome", async () => {
  const { runUpstreamRepairModelSlot } = await import("../src/compiler/pi-upstream-repair.js");
  const f = await fixture(); await f.ledger.register(f.plan); await f.ledger.authorize(f.plan.planHash);
  const controller = new AbortController(), reason = new Error("host cancelled preparation");
  const abort = vi.fn(async () => {}), dispose = vi.fn(async () => {});
  const create = vi.fn(async () => ({ abort, dispose, promptWithReport: async () => { controller.abort(reason); return {} as never; } }));
  await expect(runUpstreamRepairModelSlot(f.root, f.sourceId, f.plan.planHash, { kind: "quotation", id: "quote-one" }, { signal: controller.signal }, create)).rejects.toBe(reason);
  expect(abort).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce();
  expect((await f.ledger.inspect()).modelSessions[0]).toMatchObject({ closed: true, chargedFailure: true });
  expect((await f.ledger.history()).at(-1)!.payload).toMatchObject({ kind: "model-session-ended", diagnostic: expect.stringContaining("host cancelled preparation") });
  await expect(runUpstreamRepairModelSlot(f.root, f.sourceId, f.plan.planHash, { kind: "quotation", id: "quote-one" }, { signal: controller.signal }, create)).rejects.toBe(reason);
  expect(create).toHaveBeenCalledOnce();
});


it("retains the host review before staging and resumes it after a host interruption", async () => {
  const { prepareAuthorizedUpstreamRepair, pendingAuthorizedUpstreamRepairs } = await import("../src/compiler/upstream-repair-preparation.js");
  const f = await frozenQuotationFinish(false);
  const interrupted = vi.fn(async () => {
    expect((await f.ledger.inspect()).plans[0]!.finishReview).toEqual(f.finishInput);
    throw new Error("host interruption before model");
  });
  await expect(prepareAuthorizedUpstreamRepair(f.root, f.sourceId, f.plan.planHash, f.finishInput, {}, interrupted)).rejects.toThrow("host interruption");
  expect((await f.ledger.inspect()).plans[0]!.finishIntent).toBeUndefined();
  expect(await pendingAuthorizedUpstreamRepairs(f.root, f.sourceId)).toEqual([f.plan.planHash]);
  await expect(f.ledger.recordFinishReview(f.plan.planHash, { ...f.finishInput, summary: "replacement" })).rejects.toThrow("retained finish review changed");
  const stage = vi.fn(async () => ({ planHash: f.plan.planHash, phase: "staged" as const, results: [] }));
  expect((await prepareAuthorizedUpstreamRepair(f.root, f.sourceId, f.plan.planHash, undefined, {}, stage)).state).toBe("converged");
  expect(stage).toHaveBeenCalledOnce();
  expect((await f.ledger.history()).filter(record => record.payload.kind === "finish-review-recorded")).toHaveLength(1);
  expect(await pendingAuthorizedUpstreamRepairs(f.root, f.sourceId)).toEqual([]);
});

it("default preparation routes retained authorization before ordinary compilation and stops on retained host failures", async () => {
  const { prepareAllCommand } = await import("../src/commands/prepare-all.js");
  const { pendingAuthorizedUpstreamRepairs } = await import("../src/compiler/upstream-repair-preparation.js");
  const f = await frozenQuotationFinish(false);
  await f.ledger.recordFinishReview(f.plan.planHash, f.finishInput);
  const repairUpstream = vi.fn(async () => { throw new Error("default authorized repair selected"); });
  const compileSource = vi.fn();
  await expect(prepareAllCommand({ root: f.root, sourceId: f.sourceId, yes: true }, { repairUpstream, compileSource })).rejects.toThrow("default authorized repair selected");
  expect(repairUpstream).toHaveBeenCalledWith(f.root, f.sourceId, f.plan.planHash, undefined, expect.any(Object));
  expect(compileSource).not.toHaveBeenCalled();
  await f.ledger.stop(f.plan.planHash, "original host failure");
  await expect(pendingAuthorizedUpstreamRepairs(f.root, f.sourceId)).rejects.toThrow("is stopped");
});
