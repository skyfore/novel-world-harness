import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { contentHash as h } from "../src/world/canonical.js";
import { buildIdentityRepairHandoff, inspectIdentityRepairHandoff } from "../src/compiler/identity-repair-handoff.js";
import { identityReviewStatus } from "../src/compiler/identity-review-status.js";
import { identityRequirementsReady, identityRecordSchema, type IdentityRecord } from "../src/compiler/identity-requirements.js";
import { verifyIdentityRecord } from "../src/compiler/identity-requirement-trace.js";
import { buildIdentityRepairPlan } from "../src/compiler/identity-requirement-upstream.js";
import { RequirementLedger } from "../src/compiler/requirement-ledger.js";
import { inspectCompilerStatus } from "../src/compiler/status.js";
import { captureRecordTree } from "../src/runtime/compile-loop/dedicated-session.js";
import { workspaceStateDir } from "../src/agent/runtime-paths.js";
import { identityFixture } from "./helpers/identity-fixture.js";
import { realIdentityFixture } from "./helpers/identity-real-fixture.js";

function fixture() {
  const f = identityFixture();
  const payloads = { "entity/unknown": { id: "unknown", canonicalName: "the stranger" },
    "event/encounter": { id: "encounter", participants: ["unknown"] },
    "initial/src": { entities: ["unknown"] }, "entity-resolution/old": { entityId: "unknown" },
    "staged-role/role-old": { candidateId: "role-old" } };
  const graph = { version: 1, nodes: [
    { kind: "entity", id: "unknown", dependsOn: [{ kind: "entity-resolution", id: "old", uses: [] }] },
    { kind: "event", id: "encounter", dependsOn: [{ kind: "entity", id: "unknown", uses: [{ pointer: "/participants/0", purpose: "identity" }] }] },
    { kind: "initial", id: "src", dependsOn: [{ kind: "entity", id: "unknown", uses: [{ pointer: "/entities/0", purpose: "entry-seed" }] }] },
    { kind: "entity-resolution", id: "old", dependsOn: [{ kind: "entity", id: "unknown", uses: [{ pointer: "/entityId", purpose: "identity" }] }] },
  ].map(n => ({ ...n, revisionHash: h(payloads[`${n.kind}/${n.id}` as keyof typeof payloads]) })), issues: [] };
  Object.assign(f.inventory, { graphHash: h(graph), consumers: Object.entries(payloads).map(([ref, payload]) => ({ ref, payload,
    revisionHash: h(payload), reason: ref.startsWith("staged-role/") ? "source-review-coverage" : "typed-consumer", dependencies: [] })) });
  f.p.graph = graph;
  f.intent.inventoryHash = h(f.inventory);
  f.intent.consumerShards = [{ index: 0, refs: ["entity/unknown"] }, { index: 1, refs: Object.keys(payloads).filter(r => r !== "entity/unknown") }];
  for (const record of f.records) {
    const out = record.output;
    out.intentHash = h(f.intent);
    if (out.phase === "identity-consumers" || out.phase === "identity-consumers-check") {
      out.inventoryHash = h(f.inventory);
      const refs = f.intent.consumerShards[out.shard]!.refs;
      if (out.phase === "identity-consumers") out.consumers = refs.map(ref => ({ ref, revisionHash: h(payloads[ref as keyof typeof payloads]),
        disposition: ref === "entity/unknown" ? "additional-repair-required" : "revalidate-required", rationale: "Identity dependency needs review",
        requiredAction: "Preserve history; establish a typed consumer repair and independently validate it" }));
      else out.consumers = refs.map(ref => ({ ref, verdict: "supported", rationale: "Support the retained repair requirement" }));
    }
  }
  const firstCheck = f.records[3]!.output;
  if (firstCheck.phase !== "identity-consumers-check") throw new Error("fixture");
  firstCheck.denominatorVerdict = "blocked";
  firstCheck.denominatorRationale = "Global coverage was not inspected in this shard";
  rechain(f.records);
  return f;
}
function rechain(records: IdentityRecord[]) {
  for (const [i, record] of records.entries()) {
    if ("definitionHash" in record.output) record.output.definitionHash = h(records[0]!.output);
    if ("proposalHash" in record.output) record.output.proposalHash = h(records[i - 1]!.output);
    record.predecessorRecordHash = i ? h(records[i - 1]) : null;
  }
}

it("retains historical recovery records for inspection without restoring the retired execution adapter", async () => {
  const f = fixture(), records = f.records.slice(0, 4);
  for (const r of records.slice(2)) Object.assign(r, { contextRecoveryHash: h("archived proof"),
    contextRecoveryGateHash: h("archived gate"), contextRecoveryAttempt: 2 });
  rechain(records);
  const before = h(records);
  expect(h(records.map(r => identityRecordSchema.parse(r)))).toBe(before);
  expect(identityReviewStatus(records)).toMatchObject({ recordedReviewedShards: 1, recordedGlobalRepairSupport: false, executionAuthority: false });
  expect(buildIdentityRepairHandoff(f.p, records)).toMatchObject({ total: 1, executionAuthority: false });
  await expect(verifyIdentityRecord("/nonexistent", records[3]!, records.slice(0, 3)))
    .rejects.toThrow(/inspection-only.*inspect-identity-repairs/);
  expect(h(records)).toBe(before);
});

it("separates a fully recorded local review from blocked repair and unread global scope without reinterpreting history", () => {
  const f = fixture(), records = f.records.slice(0, 4), before = h(records);
  const status = identityReviewStatus(records);
  expect(status).toMatchObject({ totalShards: 2, recordedReviewedShards: 1, totalConsumers: 5, recordedReviewedConsumers: 1,
    unreviewedShards: [1], recordedGlobalRepairSupport: false, executionAuthority: false });
  expect(status.shards[0]).toMatchObject({ recordedReviewComplete: true, recordedRepairSupport: false,
    denominator: { verdict: "blocked", scope: "not-recorded" }, dispositions: { "additional-repair-required": 1 } });
  expect(status.originalQuestionIds).toHaveLength(3);
  expect(status.targetQuestionIds).toHaveLength(1);
  expect(identityReviewStatus(f.records.slice(0, 2)).originalQuestionIds).toBeNull();
  expect(h(records)).toBe(before);
  expect(() => buildIdentityRepairPlan(f.p, records)).toThrow("no repair authority");
});

it("hands off an unsupported entity repair with exact cyclic dependency baselines and separate source-review coverage", () => {
  const f = fixture(), before = h(f);
  const result = buildIdentityRepairHandoff(f.p, f.records.slice(0, 4), { ref: "entity/unknown", limit: 2 });
  expect(result).toMatchObject({ selected: { payload: { id: "unknown", canonicalName: "the stranger" },
    recordedAssessment: { disposition: "additional-repair-required", independentReview: { verdict: "supported" } } },
  capability: { existingArtifactRevision: "unsupported-kind", writableFields: [], originalIdentityScopeAllowsConsumerWrites: false },
  downstream: { total: 4, nextOffset: 2 }, executionAuthority: false });
  if (!("downstream" in result)) throw new Error("detail missing");
  const second = buildIdentityRepairHandoff(f.p, f.records.slice(0, 4), { ref: "entity/unknown", offset: result.downstream.nextOffset!, limit: 2 });
  if (!("downstream" in second)) throw new Error("detail missing");
  expect(second.downstream.nextOffset).toBeNull();
  expect(result.baselineManifest).toHaveLength(4);
  expect(second.baselineManifestHash).toBe(result.baselineManifestHash);
  const all = [...result.downstream.items, ...second.downstream.items];
  expect(all.map(c => c.ref).sort()).toEqual(["entity/unknown", "entity-resolution/old", "event/encounter", "initial/src"].sort());
  expect(all.find(c => c.ref === "event/encounter")).toMatchObject({ recordedAssessment: null, shard: 1,
    dependencies: { count: 1, readRef: "event/encounter" } });
  const event = buildIdentityRepairHandoff(f.p, f.records.slice(0, 4), { ref: "event/encounter" });
  if (!("selected" in event)) throw new Error("detail missing");
  expect(event.selected.dependencies).toEqual([{ kind: "entity", id: "unknown", uses: [{ pointer: "/participants/0", purpose: "identity" }] }]);
  expect(all.find(c => c.ref === "event/encounter")!.dependencies.hash).toBe(h(event.selected.dependencies));
  expect(result.sourceReviewCoverage).toEqual([{ ref: "staged-role/role-old", revisionHash: h({ candidateId: "role-old" }), reason: "source-review-coverage", shard: 1 }]);
  expect(h(f)).toBe(before);
});

it("keeps denominator support distinct from all-shard readiness and additional repair", () => {
  const f = fixture(), check = f.records[3]!.output;
  if (check.phase !== "identity-consumers-check") throw new Error("fixture");
  check.denominatorVerdict = "supported"; rechain(f.records);
  expect(identityReviewStatus(f.records).shards[0]).toMatchObject({ denominator: { scope: "not-recorded", verdict: "supported" }, recordedRepairSupport: false });
  expect(identityRequirementsReady(f.records)).toBe(false);
  expect(() => buildIdentityRepairPlan(f.p, f.records)).toThrow("no repair authority");
  const clean = identityFixture();
  expect(identityReviewStatus(clean.records.slice(0, 4))).toMatchObject({ recordedGlobalRepairSupport: false, unreviewedShards: [1] });
});

it("preserves payload prerequisites even when the same definition condition has a supported retained-boundary assessment", () => {
  const f = identityFixture(), definition = f.records[0]!.output;
  if (definition.phase !== "identity-definition") throw new Error("fixture");
  definition.requirements[0]!.missingCondition = "Original identity remains unresolved";
  for (const record of f.records.slice(2)) {
    if (record.output.phase === "identity-consumers") {
      record.output.bindings[0]!.missingCondition = "Old entity consumption still needs a supported repair";
      record.output.bindings[0]!.definitionGap = { conditionHash: h(definition.requirements[0]!.missingCondition),
        disposition: "retained-boundary", rationale: "Unknown identity can be preserved", evidence: definition.requirements[0]!.evidence };
    } else if (record.output.phase === "identity-consumers-check") record.output.judgments[0]!.definitionGap = {
      conditionHash: h(definition.requirements[0]!.missingCondition), disposition: "retained-boundary", verdict: "supported",
      rationale: "Original question remains open", evidence: definition.requirements[0]!.evidence };
  }
  rechain(f.records);
  expect(identityReviewStatus(f.records)).toMatchObject({ recordedGlobalRepairSupport: false,
    retainedDefinitionConditions: [{ condition: "Original identity remains unresolved" }] });
  expect(identityReviewStatus(f.records).shards[0]!.payloadConditions[0]!.condition).toBe("Old entity consumption still needs a supported repair");
});

it.each(["payload", "graph", "omission", "duplicate"])("rejects %s drift rather than producing a usable handoff", mutation => {
  const f = fixture();
  if (mutation === "payload") (f.inventory.consumers[0]!.payload as any).canonicalName = "changed";
  if (mutation === "graph") f.p.graph.nodes[1].dependsOn = [];
  if (mutation === "omission" || mutation === "duplicate") {
    const record = f.records[2]!;
    if (record.output.phase !== "identity-consumers") throw new Error("fixture");
    record.output.consumers = mutation === "omission" ? [] : [record.output.consumers[0]!, record.output.consumers[0]!];
    rechain(f.records);
  }
  expect(() => buildIdentityRepairHandoff(f.p, f.records, { ref: "entity/unknown" })).toThrow();
});

it("gives same-scope discovery fields and a bounded correction for unknown refs and pagination", () => {
  const f = fixture(), records = f.records.slice(0, 4);
  const list = buildIdentityRepairHandoff(f.p, records);
  expect(list).toMatchObject({ total: 1, items: [{ ref: "entity/unknown" }], availableRefs: expect.arrayContaining(["event/encounter"]) });
  expect(() => buildIdentityRepairHandoff(f.p, records, { ref: "entity/guessed" })).toThrow(/availableRefs.*correct once/);
  expect(() => buildIdentityRepairHandoff(f.p, records, { offset: 50 })).toThrow(/nextOffset once/);
});

it("discovers actual retained Pi records and reports them in compiler status without new calls or ledger writes", async () => {
  const f = await realIdentityFixture();
  try {
    for (const c of f.p.inventory.consumers) {
      c.revisionHash = h(c.payload);
      if (c.ref.startsWith("staged-role/")) c.reason = "source-review-coverage";
    }
    f.p.graph = { version: 1, nodes: f.p.inventory.consumers.filter((c: any) => c.reason === "typed-consumer")
      .map((c: any) => ({ kind: "event", id: c.ref.slice("event/".length), revisionHash: c.revisionHash, dependsOn: [] })), issues: [] };
    f.p.inventory.graphHash = h(f.p.graph); f.p.intent.inventoryHash = h(f.p.inventory);
    f.outputs[2].consumers[0].disposition = "additional-repair-required";
    for (const [i, out] of f.outputs.entries()) {
      out.intentHash = h(f.p.intent);
      if ("inventoryHash" in out) out.inventoryHash = h(f.p.inventory);
      if (out.phase === "identity-consumers") for (const c of out.consumers)
        c.revisionHash = f.p.inventory.consumers.find((item: any) => item.ref === c.ref).revisionHash;
      if ("definitionHash" in out) out.definitionHash = h(f.outputs[0]);
      if ("proposalHash" in out) out.proposalHash = h(f.outputs[i - 1]);
    }
    await expect(f.run()).rejects.toThrow(/inspect-identity-repairs/);
    const sourceId = f.p.intent.sourceId, taskId = f.p.intent.taskId;
    const ledger = new RequirementLedger(f.root, sourceId);
    expect(await ledger.identityRequirements(taskId)).toHaveLength(4);
    const before = captureRecordTree(f.root), stateBefore = captureRecordTree(workspaceStateDir(f.root)), calls = f.transports.length;
    const discovery = await inspectIdentityRepairHandoff(f.root, sourceId);
    expect(discovery).toMatchObject({ tasks: [{ taskId, recordedReviewedShards: 1, recordedGlobalRepairSupport: false }], executionAuthority: false });
    const detail = await inspectIdentityRepairHandoff(f.root, sourceId, { taskId, ref: "event/consumer" });
    expect(detail).toMatchObject({ currentInputs: "verified", modelAndHostAcceptance: "not-reverified",
      capability: { existingArtifactRevision: "unsupported-revision" }, downstream: { total: 1 }, executionAuthority: false });
    const status = await inspectCompilerStatus(f.root, sourceId);
    expect(status.sources[0]!.identityReviews).toMatchObject({ inspection: "recorded", tasks: [{ taskId, recordedGlobalRepairSupport: false }] });
    await expect(inspectIdentityRepairHandoff(f.root, sourceId, { taskId: h("guessed") })).rejects.toThrow(/tasks\[\]\.taskId.*correct once/);
    await expect(inspectIdentityRepairHandoff(f.root, sourceId, { limit: 0 })).rejects.toThrow(/limit 1\.\.48/);
    expect(f.transports).toHaveLength(calls);
    expect(captureRecordTree(f.root)).toEqual(before);
    expect(captureRecordTree(workspaceStateDir(f.root))).toEqual(stateBefore);
  } finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
}, 60000);
