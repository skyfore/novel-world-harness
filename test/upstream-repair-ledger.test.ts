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
