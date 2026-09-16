import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { registerSourceRequirements, settleSourceRequirements } from "../src/compiler/requirement-service.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { SourceAnnotationStore, quotationSchema } from "../src/compiler/annotations.js";
import { contentHash } from "../src/world/canonical.js";
import { freezeUpstreamRepairPlan } from "../src/compiler/upstream-repair-plan.js";
import { UpstreamRepairLedger } from "../src/compiler/upstream-repair-ledger.js";
import { verifyUpstreamRepairPlan } from "../src/compiler/upstream-repair-preflight.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
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
