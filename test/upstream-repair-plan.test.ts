import { expect, it } from "vitest";
import { contentHash } from "../src/world/canonical.js";
import { quotationSchema } from "../src/compiler/annotations.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { assertUpstreamRepairMutation, freezeUpstreamRepairPlan, repairPointerTokens, upstreamRepairPlanSchema } from "../src/compiler/upstream-repair-plan.js";

function fixture() {
  const bytes = Buffer.from('Hero said "Wait here."'), sourceId = "source-one";
  const baseline = quotationSchema.parse({ version: 1, id: "quote-one", sourceId, annotationType: "quotation", anchor: textAnchorForByteRange(sourceId, bytes, 11, 15), mode: "direct", addresseeMentionIds: ["listener-one", "listener-two"], attributionConfidence: 1,
    derivation: { runId: "original", worker: "propose_quotation", ontologyVersion: "observation-v1" } });
  const identity = { version: 1 as const, planId: "quote-repair", batchId: "repair-batch", requirementSetHash: contentHash("independent-requirements"), requirementIds: ["opening:complete-expression"], predecessorReceiptRefs: [contentHash("completed-original-finish")],
    sourceScope: { sourceId, sourceSha256: contentHash("immutable-source"), segmentIds: ["segment-one", "segment-two"] },
    baselineRefs: [{ kind: "quotation" as const, id: baseline.id, revisionHash: contentHash(baseline) }, ...["listener-one", "listener-two"].map(id => ({ kind: "entity-mention" as const, id, revisionHash: contentHash(id) }))],
    allowedWrites: [{ kind: "quotation" as const, id: baseline.id, pointers: ["/anchor"] }], allowedCreations: [],
    readableRefs: [...["listener-one", "listener-two"].map(id => ({ kind: "entity-mention" as const, id })), { kind: "quotation" as const, id: baseline.id }, { kind: "source-segment" as const, id: "segment-two" }], citableEvidenceRefs: ["segment-one"],
    dependencyEdges: [{ from: "requirement:opening:complete-expression", to: "quotation:quote-one", purpose: "quotation" as const }],
    postconditionIds: ["opening:complete-expression"], authorizationRef: "host-policy:quotation-repair-v1", retryBudgetRef: "retained-repair-budget",
  };
  const plan = freezeUpstreamRepairPlan(identity), derivation = { ...baseline.derivation, runId: plan.batchId, compilerBatchId: plan.batchId };
  const payload = { ...baseline, anchor: textAnchorForByteRange(sourceId, bytes, 11, 20), derivation };
  const input = { kind: "quotation" as const, id: baseline.id, baseline, payload, activeRevisions: new Map(identity.baselineRefs.map(ref => [`${ref.kind}:${ref.id}`, ref.revisionHash])), sourceSha256: plan.sourceScope.sourceSha256, requirementSetHash: plan.requirementSetHash, citedSegmentIds: ["segment-one"], hostDerivation: derivation };
  return { identity, plan, input };
}

it("bounds quotation expansion by frozen dependencies and preserves every unapproved field", () => {
  const { plan, input } = fixture();
  expect(() => assertUpstreamRepairMutation(plan, input)).not.toThrow();
  for (const patch of [{ mode: "free-indirect", interpretation: "changed" }, { addresseeMentionIds: ["listener-two"] }, { speakerMentionId: "invented-speaker" }, { id: "replacement" }]) {
    expect(() => assertUpstreamRepairMutation(plan, { ...input, payload: { ...input.payload, ...patch } })).toThrow(/Unauthorized|escapes plan|Unfrozen dependency/);
  }
  expect(() => assertUpstreamRepairMutation(plan, { ...input, citedSegmentIds: ["segment-two"] })).toThrow("not citable");
  expect(() => assertUpstreamRepairMutation(plan, { ...input, activeRevisions: new Map([["quotation:quote-one", contentHash("changed")]]) })).toThrow("Active baseline changed");
  expect(() => assertUpstreamRepairMutation(plan, { ...input, baseline: { ...input.baseline, attributionConfidence: 0.5 } })).toThrow("exact frozen baseline");
  expect(() => assertUpstreamRepairMutation(plan, { ...input, requirementSetHash: contentHash("smaller-denominator") })).toThrow("requirement revision changed");
  expect(() => assertUpstreamRepairMutation(plan, { ...input, sourceSha256: contentHash("different-source") })).toThrow("Source or requirement revision changed");
  expect(() => assertUpstreamRepairMutation(plan, { ...input, payload: { ...input.payload, derivation: { ...input.payload.derivation, runId: "model-chosen" } } })).toThrow("provenance");
});

it.each(["", "/", "/anchorX", "/anchor~1endByte", "/anchor/endByte", "/anchor~2", "/addresseeMentionIds/0", "/addresseeMentionIds/-", "/derivation", "/sourceId"])("rejects unregistered pointer %s before authorization", pointer => {
  const { identity } = fixture();
  expect(() => freezeUpstreamRepairPlan({ ...identity, allowedWrites: [{ ...identity.allowedWrites[0]!, pointers: [pointer] }] })).toThrow();
});

it("decodes pointers and authorizes complete arrays only through an explicit field permission", () => {
  expect(repairPointerTokens("/a~1b/~0c")).toEqual(["a/b", "~c"]);
  const { identity, input } = fixture();
  const plan = freezeUpstreamRepairPlan({ ...identity, allowedWrites: [{ ...identity.allowedWrites[0]!, pointers: ["/anchor", "/addresseeMentionIds"] }] });
  expect(() => assertUpstreamRepairMutation(plan, { ...input, payload: { ...input.payload, addresseeMentionIds: ["listener-two"] } })).not.toThrow();
});

it("rejects forged hashes, freeform kinds, dependency cycles and denominator shrink", () => {
  const { plan, identity } = fixture();
  expect(() => upstreamRepairPlanSchema.parse({ ...plan, authorizationRef: "altered" })).toThrow("hash mismatch");
  expect(() => upstreamRepairPlanSchema.parse({ ...plan, allowedWrites: [{ kind: "world-rule", id: "anything", pointers: ["/"] }] })).toThrow();
  expect(() => freezeUpstreamRepairPlan({ ...identity, dependencyEdges: [...identity.dependencyEdges, { from: "quotation:quote-one", to: "requirement:opening:complete-expression", purpose: "requirement" }] })).toThrow("cycle");
  expect(() => freezeUpstreamRepairPlan({ ...identity, requirementIds: [...identity.requirementIds, "opening:identity"] })).toThrow("denominator");
  expect(() => freezeUpstreamRepairPlan({ ...identity, baselineRefs: [] })).toThrow("baseline");
});

it("allows creation only at the exact host allocated fresh dependency slot", () => {
  const { identity, input } = fixture();
  const plan = freezeUpstreamRepairPlan({ ...identity, allowedWrites: [], allowedCreations: [{ kind: "quotation", id: "new-quote", maxCount: 1, dependencyOf: identity.requirementIds[0]! }],
    dependencyEdges: [...identity.dependencyEdges, { from: `requirement:${identity.requirementIds[0]}`, to: "quotation:new-quote", purpose: "quotation" }] });
  const creation = { ...input, baseline: null, id: "new-quote", payload: { ...input.payload, id: "new-quote" } };
  expect(() => assertUpstreamRepairMutation(plan, creation)).not.toThrow();
  expect(() => assertUpstreamRepairMutation(plan, { ...creation, id: "extra", payload: { ...creation.payload, id: "extra" } })).toThrow("allocated dependency slot");
  expect(() => assertUpstreamRepairMutation(plan, { ...creation, activeRevisions: new Map([...input.activeRevisions, ["quotation:new-quote", contentHash("existing")]]) })).toThrow("fresh");
  expect(() => assertUpstreamRepairMutation(plan, { ...creation, activeRevisions: new Map([...input.activeRevisions, ["entity-mention:new-quote", contentHash("existing other annotation type")]]) })).toThrow("fresh");
  expect(() => freezeUpstreamRepairPlan({ ...identity, allowedCreations: [{ kind: "quotation", id: "new-quote", maxCount: 1, dependencyOf: "missing" }] })).toThrow("slot");
  const allocatedSpeaker = freezeUpstreamRepairPlan({ ...identity, allowedWrites: [{ ...identity.allowedWrites[0]!, pointers: ["/anchor", "/speakerMentionId"] }],
    allowedCreations: [{ kind: "entity-mention", id: "new-speaker", maxCount: 1, dependencyOf: identity.requirementIds[0]! }],
    dependencyEdges: [...identity.dependencyEdges, { from: `requirement:${identity.requirementIds[0]}`, to: "entity-mention:new-speaker", purpose: "identity" }] });
  expect(() => assertUpstreamRepairMutation(allocatedSpeaker, { ...input, payload: { ...input.payload, speakerMentionId: "new-speaker" } })).toThrow("Undeclared creation dependency");
});

it("binds identity resolution changes to frozen mention and entity dependencies", () => {
  const { identity } = fixture();
  const baseline = { version: 1, id: "resolution-one", sourceId: identity.sourceScope.sourceId, mentionId: "mention-one", status: "unresolved", candidates: [], rationale: "Identity awaiting source review", derivation: { runId: "original", worker: "propose_entity_resolution", ontologyVersion: "entity-resolution-v1" } };
  const refs = [{ kind: "entity-resolution" as const, id: baseline.id, revisionHash: contentHash(baseline) }, { kind: "entity-mention" as const, id: "mention-one", revisionHash: contentHash("mention-one") }, { kind: "entity" as const, id: "actor-one", revisionHash: contentHash("actor-one") }];
  const plan = freezeUpstreamRepairPlan({ ...identity, baselineRefs: refs, readableRefs: refs.map(({ kind, id }) => ({ kind, id })), allowedWrites: [{ kind: "entity-resolution", id: baseline.id, pointers: ["/status", "/candidates", "/entityId", "/mentionId"] }], dependencyEdges: [{ from: `requirement:${identity.requirementIds[0]}`, to: "entity-resolution:resolution-one", purpose: "identity" }] });
  const derivation = { ...baseline.derivation, runId: plan.batchId, compilerBatchId: plan.batchId };
  const payload = { ...baseline, status: "resolved", entityId: "actor-one", candidates: [{ entityId: "actor-one", confidence: 1, basisMentionIds: ["mention-one"], evidenceAssertionIds: [], rationale: "Exact named mention" }], derivation };
  const input = { kind: "entity-resolution" as const, id: baseline.id, baseline, payload, activeRevisions: new Map(refs.map(ref => [`${ref.kind}:${ref.id}`, ref.revisionHash])), sourceSha256: plan.sourceScope.sourceSha256, requirementSetHash: plan.requirementSetHash, citedSegmentIds: ["segment-one"], hostDerivation: derivation };
  expect(() => assertUpstreamRepairMutation(plan, input)).not.toThrow();
  expect(() => assertUpstreamRepairMutation(plan, { ...input, payload: { ...payload, mentionId: "unplanned-mention" } })).toThrow("Unfrozen dependency");
  expect(() => assertUpstreamRepairMutation(plan, { ...input, activeRevisions: new Map([...input.activeRevisions, ["entity:actor-one", contentHash("changed entity")]]) })).toThrow("Active baseline changed");
});
