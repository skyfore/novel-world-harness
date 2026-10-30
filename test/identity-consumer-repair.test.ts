import { expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { mockPiProvider } from "./helpers/pi-provider.js";
import { SegmentStore } from "../src/compiler/segments.js";
import * as repairPreparation from "../src/compiler/identity-consumer-repair.js";
import { RequirementLedger } from "../src/compiler/requirement-ledger.js";
import { runIdentityConsumerRepair } from "../src/workflow/identity-consumer-repair.js";
import { verifyConsumerRepairRecord } from "../src/compiler/identity-consumer-repair-trace.js";
import { verifySemanticCorrectionJournal } from "../src/compiler/role-semantic-scope-correction.js";
import { contentHash as h } from "../src/world/canonical.js";
import { inheritedConsumerRepairUsage, consumerRepairIntentSchema, validateConsumerRepairHistory, type ConsumerRepairRecord } from "../src/compiler/identity-consumer-repair-model.js";
import { validateConsumerRepairRevision } from "../src/compiler/identity-consumer-repair-trace.js";
import { assertUpstreamRepairMutation, freezeUpstreamRepairPlan, upstreamRepairConvergedRevisions } from "../src/compiler/upstream-repair-plan.js";
import { identityFixture } from "./helpers/identity-fixture.js";
import { IDENTITY_REQUIREMENT_LIMITS } from "../src/compiler/identity-requirements.js";
import { buildIdentityRepairPlan } from "../src/compiler/identity-requirement-upstream.js";
import { identityUpstreamOrder } from "../src/workflow/identity-consumer-upstream.js";
import { identityRequirementDefinition } from "../src/compiler/identity-requirement-authority.js";
import { buildRevalidatedConsumerPlan } from "../src/compiler/identity-consumer-revalidated-plan.js";
import { consumerRevalidationScopeSchema, type ConsumerRevalidationRecord } from "../src/compiler/identity-consumer-revalidation-model.js";

function fixture(withPredecessor = false, withInitial = false) {
  const f = identityFixture(), records = f.records.slice(0, 4), proposal = records[2]!.output, check = records[3]!.output;
  if (proposal.phase !== "identity-consumers" || check.phase !== "identity-consumers-check") throw Error("fixture");
  const entity = { id: "unknown", kind: "character", canonicalName: "stranger", aliases: [], evidence: [] };
  if (withInitial) {
    f.inventory.consumers[1]!.ref = "initial/src";
    f.intent.consumerShards[1]!.refs = ["initial/src"];
  }
  if (withPredecessor) {
    const target = f.intent.targets.at(-1)!, op = f.semantic[0].output.operations.at(-1), payload = JSON.parse(op.payloadJson);
    const predecessor = { ...payload, id: "original-creation", status: "new-entity", entityId: entity.id };
    target.predecessor = { id: predecessor.id, hash: h(predecessor) };
    op.payloadJson = JSON.stringify({ ...payload, supersedesResolutionId: predecessor.id });
    op.readableRefs.push({ kind: "entity-resolution", id: predecessor.id, revisionHash: h(predecessor) });
    f.p.catalog.push({ kind: "entity-resolution", id: predecessor.id, revisionHash: h(predecessor), payload: predecessor },
      { kind: "entity", id: entity.id, revisionHash: h(entity), payload: entity });
    f.intent.semanticRecordHashes = f.semantic.map(h); f.intent.catalogHash = h(f.p.catalog);
    const binding = proposal.bindings.find(b => b.slot === target.slot)!;
    binding.payloadHash = h(JSON.parse(op.payloadJson)); binding.dependencyRefs = op.readableRefs.map((r: any) => `${r.kind}:${r.id}`);
  }
  proposal.consumers = [{ ref: "entity/unknown", revisionHash: h(entity), disposition: "additional-repair-required", rationale: "Missing identity consumer semantics", requiredAction: "Retain identity history and independently verify typed unknown or isolated consumption" }];
  check.consumers = [{ ref: "entity/unknown", verdict: "supported", rationale: "Source uncertainty retained" }];
  f.inventory.consumers[0] = { ...f.inventory.consumers[0]!, ref: "entity/unknown", payload: entity as any, revisionHash: h(entity) };
  f.intent.consumerShards[0]!.refs = ["entity/unknown"]; f.intent.inventoryHash = h(f.inventory);
  for (const r of records) { r.output.intentHash = h(f.intent); if ("inventoryHash" in r.output) r.output.inventoryHash = h(f.inventory); if ("definitionHash" in r.output) r.output.definitionHash = h(records[0]!.output); }
  for (let i = 1; i < records.length; i++) { records[i]!.predecessorRecordHash = h(records[i - 1]); if ("proposalHash" in records[i]!.output) (records[i]!.output as any).proposalHash = h(records[i - 1]!.output); }
  const intent = consumerRepairIntentSchema.parse({ version: 1, policy: "identity-consumer-repair/v1", sourceId: f.intent.sourceId, sourceHash: f.intent.sourceHash,
    taskId: f.intent.taskId, identityIntentHash: h(f.intent), findingId: h({ taskId: f.intent.taskId, recordHash: h(records[2]), pointer: "/output/consumers/0" }),
    proposalRecordHash: h(records[2]), checkRecordHash: h(records[3]), ref: "entity/unknown", revisionHash: h(entity), definitionHash: h(records[0]!.output),
    requirementIds: f.intent.targets.map(t => t.requirementId), inventoryHash: f.intent.inventoryHash, graphHash: f.inventory.graphHash,
    baselineManifestHash: h("entire original downstream"), conditionHash: h(proposal.consumers[0]!.requiredAction), requirementPrefix: { length: 4, head: h("original") },
    authorizationRef: "user repair same finding", originalBudgetHash: f.intent.originalBudgetHash,
    priorUsage: { modelCalls: 162, totalPayloadBytes: 36884781, budgetFilesHash: h("original failures retained") }, retainedFiles: [{ path: "original-failure.json", hash: h("failure") }] });
  const plan: ConsumerRepairRecord = { intent, inputHash: h("plan"), output: { phase: "consumer-repair-plan", intentHash: h(intent), requirementIds: intent.requirementIds,
    ref: intent.ref, baselineHash: intent.revisionHash, operation: { mode: "capability-gap", requiredCapability: "Typed unknown identity consumption", rationale: "Metadata edits cannot provide consumer isolation" },
    consumerRevalidation: "All original affected refs and original acceptance conditions", retainedBoundaries: "All original unresolved source conditions", evidence: [{ segment_id: "seg", exact: "Ada waits." }] },
    predecessorRecordHash: null, traceRunId: "new-pi-plan", sessionId: "new-pi-plan", provider: "openai-codex", model: "gpt-6.1-sol", subscription: true, evidence: records[0]!.evidence };
  const review: ConsumerRepairRecord = { ...plan, inputHash: h("check"), predecessorRecordHash: h(plan), traceRunId: "new-pi-check", sessionId: "new-pi-check",
    output: { phase: "consumer-repair-check", intentHash: h(intent), requirementIds: intent.requirementIds, proposalHash: h(plan.output), verdict: "supported", rationale: "Supported implementation gap, not repair acceptance", evidence: plan.output.evidence } };
  return { ...f, records, entity, plan, review };
}

it("retains the original finding and criteria while requiring a distinct independent Pi check", () => {
  const f = fixture(), before = h(f.records);
  expect(() => validateConsumerRepairHistory([f.plan, f.review], f.records)).not.toThrow();
  for (const mutate of [
    (p: ConsumerRepairRecord[]) => { p[1]!.sessionId = p[0]!.sessionId; },
    (p: ConsumerRepairRecord[]) => { p[0]!.output.requirementIds.pop(); },
    (p: ConsumerRepairRecord[]) => { p[0]!.intent.conditionHash = h("easier replacement condition"); },
    (p: ConsumerRepairRecord[]) => { p[0]!.intent.inventoryHash = h("smaller denominator"); },
    (p: ConsumerRepairRecord[]) => { p[0]!.intent.proposalRecordHash = h("new finding"); },
  ]) { const p = structuredClone([f.plan, f.review]); mutate(p); expect(() => validateConsumerRepairHistory(p, f.records)).toThrow(); }
  expect(h(f.records)).toBe(before);
});

it("allows only same-finding read-only repair appends when inspecting a consumed semantic correction", () => {
  const f = fixture(), review: any = { taskId: f.intent.taskId, revisionHash: f.intent.revisionHash, scope: {
    sourceId: f.intent.sourceId, sourceHash: f.intent.sourceHash, parentStateHash: f.intent.parentStateHash, planHash: f.intent.originalPlanHash, originalBudgetHash: f.intent.originalBudgetHash } };
  const semantic = f.semantic.map(s => ({ ...s, taskId: f.intent.taskId })), prefix: any[] = [{ hash: h("pending"), payload: { kind: "role-dependency-review", review } },
    ...semantic.map(record => ({ hash: h(record), payload: { kind: "role-semantic-scope", record } }))];
  f.intent.semanticRecordHashes = semantic.map(h); f.intent.requirementPrefix = { length: 3, head: prefix[2]!.hash };
  f.records.forEach((r, i) => { r.output.intentHash = h(f.intent); if ("definitionHash" in r.output) r.output.definitionHash = h(f.records[0]!.output);
    if ("proposalHash" in r.output) r.output.proposalHash = h(f.records[i - 1]!.output); r.predecessorRecordHash = i ? h(f.records[i - 1]) : null; });
  const history: any[] = [...prefix, ...f.records.map(record => ({ hash: h(record), payload: { kind: "identity-requirements", record } }))];
  Object.assign(f.plan.intent, { identityIntentHash: h(f.intent), definitionHash: h(f.records[0]!.output), proposalRecordHash: h(f.records[2]), checkRecordHash: h(f.records[3]),
    findingId: h({ taskId: f.intent.taskId, recordHash: h(f.records[2]), pointer: "/output/consumers/0" }), requirementPrefix: { length: history.length, head: history.at(-1).hash } });
  f.plan.output.intentHash = h(f.plan.intent);
  history.push({ hash: h(f.plan), payload: { kind: "identity-consumer-repair", record: f.plan } });
  expect(() => verifySemanticCorrectionJournal(history, review, false)).not.toThrow();
  expect(() => verifySemanticCorrectionJournal(history, review, true)).toThrow(/consumed/);
  const foreign = structuredClone(history); foreign.at(-1).payload.record.intent.conditionHash = h("another finding");
  expect(() => verifySemanticCorrectionJournal(foreign, review, false)).toThrow();
});

it("charges failed budget lineages once without accepting missing ancestors, forks or resets", () => {
  const f = fixture();
  const usage = (calls: number, bytes: number) => ({ modelCalls: calls, payloads: calls, totalPayloadBytes: bytes, largestRequestBytes: 1000 });
  const budget = (file: string, stage: string, u: ReturnType<typeof usage>, inherited?: ReturnType<typeof usage>) => ({ path: file, hash: h(file), value: {
    stage, intentHash: h(f.intent), originalBudgetHash: f.intent.originalBudgetHash, limits: IDENTITY_REQUIREMENT_LIMITS,
    state: { usage: u, blocked: true, failure: { code: "request-size", message: "original failure" } }, ...(inherited ? { inheritedUsage: inherited } : {}) } });
  const budgets = [budget("a", "consumer", usage(5, 5000)), budget("b", "consumer", usage(10, 8000), usage(5, 5000)), budget("c", "check", usage(3, 2000))];
  expect(inheritedConsumerRepairUsage(budgets, f.records)).toMatchObject({ modelCalls: 156, totalPayloadBytes: 22000 });
  expect(() => inheritedConsumerRepairUsage(budgets.slice(1), f.records)).toThrow(/lineage/);
  expect(() => inheritedConsumerRepairUsage([...budgets, budget("fork", "consumer", usage(9, 6000), usage(5, 5000))], f.records)).toThrow(/lineage/);
  expect(() => inheritedConsumerRepairUsage([budget("reset", "consumer", usage(5, 5000)), budget("decreased", "consumer", usage(2, 2000), usage(5, 5000))], f.records)).toThrow(/decreased/);
});

it("checks actual entity diffs and rejects identity/agency changes hidden behind allowed metadata pointers", () => {
  const f = fixture();
  if (f.plan.output.phase !== "consumer-repair-plan") throw Error("fixture");
  f.plan.output.operation = { mode: "revision", kind: "entity", pointers: ["/canonicalName"], payloadJson: JSON.stringify({ ...f.entity, canonicalName: "unknown stranger" }), rationale: "Fixture metadata repair" };
  expect(() => validateConsumerRepairRevision(f.plan, f.entity)).not.toThrow();
  for (const payload of [{ ...f.entity, id: "other" }, { ...f.entity, kind: "place" }, { ...f.entity, aliases: ["known-person"] }]) {
    f.plan.output.operation.payloadJson = JSON.stringify(payload);
    expect(() => validateConsumerRepairRevision(f.plan, f.entity)).toThrow();
  }
});

it("allows an exact existing entity revision through the upstream mutation gate but never entity creation or unscoped writes", () => {
  const f = fixture(), key = "entity:unknown";
  const plan = freezeUpstreamRepairPlan({ version: 1, planId: "entity-repair", batchId: "entity-repair", sourceScope: { sourceId: "src", sourceSha256: f.intent.sourceHash, segmentIds: ["seg"] },
    requirementSetHash: h("original independent definition"), requirementIds: ["existing-check"], predecessorReceiptRefs: [], baselineRefs: [{ kind: "entity", id: "unknown", revisionHash: h(f.entity) }],
    allowedWrites: [{ kind: "entity", id: "unknown", pointers: ["/canonicalName"] }], allowedCreations: [], readableRefs: [{ kind: "entity", id: "unknown" }],
    citableEvidenceRefs: ["seg"], dependencyEdges: [], postconditionIds: ["existing-check"], authorizationRef: "exact prior authorization", retryBudgetRef: "same-original-budget" });
  const input = { kind: "entity" as const, id: "unknown", baseline: f.entity, payload: { ...f.entity, canonicalName: "unknown stranger" }, activeRevisions: new Map([[key, h(f.entity)]]),
    sourceSha256: f.intent.sourceHash, requirementSetHash: plan.requirementSetHash, citedSegmentIds: ["seg"], hostDerivation: {} };
  expect(() => assertUpstreamRepairMutation(plan, input)).not.toThrow();
  expect(() => assertUpstreamRepairMutation(plan, { ...input, payload: { ...input.payload, aliases: ["known-person"] } })).toThrow(/Unauthorized field difference/);
  expect(() => assertUpstreamRepairMutation(plan, { ...input, activeRevisions: new Map([[key, h("changed")]]) })).toThrow(/baseline changed/);
  const { planHash: _, ...identity } = plan;
  expect(() => freezeUpstreamRepairPlan({ ...identity, allowedWrites: [], allowedCreations: [{ kind: "entity", id: "new" }] })).toThrow();
});

it("carries the checked original consumer finding into exact typed staging without replacing its negative history or granting activation", () => {
  const f = fixture(true), original = h(f.records), repairs = [f.plan, f.review];
  const plan = buildIdentityRepairPlan(f.p, f.records, repairs);
  expect(plan.allowedWrites).toEqual([{ kind: "entity", id: "unknown", pointers: ["/identityConsumption"] }]);
  expect(plan.requirementIds).toEqual(f.plan.intent.requirementIds);
  expect(identityUpstreamOrder(plan).at(-1)).toEqual({ kind: "entity", id: "unknown" });
  expect(plan.identityRequirements?.recordHashes).toEqual(f.records.map(h));
  expect(plan.identityRequirements?.consumerRepair?.recordHashes).toEqual(repairs.map(h));
  expect(h(f.records)).toBe(original);
  expect(() => buildIdentityRepairPlan(f.p, f.records)).toThrow(/no repair authority/);
  const journal: any = [...f.records.map(record => ({ payload: { kind: "identity-requirements", record } })),
    ...repairs.map(record => ({ payload: { kind: "identity-consumer-repair", record } }))];
  expect(identityRequirementDefinition(journal, plan)).toEqual(f.records[0]!.output);
  expect(() => identityRequirementDefinition(journal.slice(0, -1), plan)).toThrow();
  const bad = structuredClone(repairs); if (bad[1]!.output.phase === "consumer-repair-check") bad[1]!.output.verdict = "blocked";
  expect(() => buildIdentityRepairPlan(f.p, f.records, bad)).toThrow(/no typed staging authority/);
  const { planHash: _, ...identity } = plan;
  expect(() => freezeUpstreamRepairPlan({ ...identity, allowedWrites: [{ kind: "entity", id: "unknown", pointers: ["/canonicalName"] }] })).toThrow();
});

it("derives the supported joint repair without recreating identities or clearing old requirements", async () => {
  const f = fixture(true, true), parent = buildIdentityRepairPlan(f.p, f.records, [f.plan, f.review]);
  const decisions = f.semantic[0].output.operations.map((o: any) => JSON.parse(o.payloadJson)), decision = decisions.at(-1);
  const quarantined = { ...f.entity, identityConsumption: { version: 1, mode: "quarantined", status: "unresolved", sourceId: "src", mentionId: decision.mentionId,
    resolutionId: decision.id, resolutionRevisionHash: h(decision), supersedesResolutionIds: ["original-creation"], rationale: "Original unresolved boundary" } };
  const initial = { version: 1, delta: { version: 1, operations: [] }, evidence: [{ span: { sourceId: "src", startLine: 1, endLine: 1, quoteHash: h("Ada waits.") }, strength: "explicit" }] };
  const refs = [...f.p.catalog.filter((r: any) => ["entity-mention", "entity-resolution"].includes(r.kind)).map(({ payload: _, ...r }: any) => r),
    ...decisions.map((d: any) => ({ kind: "entity-resolution", id: d.id, revisionHash: h(d) })),
    { kind: "entity", id: "unknown", revisionHash: h(quarantined) }];
  const scope = consumerRevalidationScopeSchema.parse({ version: 1, sourceId: "src", sourceHash: f.intent.sourceHash, taskId: f.intent.taskId,
    identityIntentHash: h(f.intent), inventoryHash: f.intent.inventoryHash, definitionHash: h(f.records[0]!.output), requirementIds: parent.requirementIds,
    ref: "initial/src", originalRevisionHash: h(initial), currentRevisionHash: h(initial), upstreamPlanHash: parent.planHash,
    receiptFingerprint: h("completed original parent"), acceptanceHash: h("accepted parent"), parentStateHash: f.intent.parentStateHash,
    originalBudgetHash: f.intent.originalBudgetHash, authorizationRef: "continue original repair", priorUsage: { modelCalls: 216, totalPayloadBytes: 51231643 },
    priorBudgetFiles: [{ path: "/tmp/retained-budget", hash: h("retained-budget") }], requirementPrefix: { length: 22, head: h("retained-prefix") },
    compilerCorrection: { policy: "source-local-referent/v1", predecessorId: h("negative"), predecessorScopeHash: h("negative scope"), predecessorRecordHashes: [h("negative1"), h("negative2")], contractHash: h("contract") } });
  const review: ConsumerRevalidationRecord = { scope, inputHash: h("exact input"), predecessorRecordHash: null, sessionId: "proposal-revalidated", traceRunId: "trace-revalidated",
    sessionCheckpointHash: h("actual Pi session"), evidence: f.records[0]!.evidence, output: { phase: "consumer-revalidation", scopeHash: h(scope), ref: scope.ref,
      currentRevisionHash: scope.currentRevisionHash, requirementIds: scope.requirementIds, disposition: "repair-required", rationale: "The original local referent can be represented without claiming cross-person identity",
      requirements: scope.requirementIds.map(id => ({ id, verdict: "blocked", rationale: "Typed revision still required" })), evidence: [{ segment_id: "seg", exact: "Ada waits." }],
      entityRepair: { ref: "entity:unknown", revisionHash: h(quarantined), pointers: ["/identityConsumption"], mode: "source-local", readableRefs: refs, segmentIds: ["seg"], requiredAction: "Retain exact unresolved decision and chain" },
      initialWorldRepair: { pointers: ["/readerSetup", "/delta"], readableRefs: [...refs, { kind: "initial-world", id: "singleton", revisionHash: h(initial) }], segmentIds: ["seg"], requiredAction: "Repair only original opening" },
      retainedQuestionIds: f.inventory.originalQuestionIds, parentResumeAllowed: false } };
  const check: ConsumerRevalidationRecord = { ...review, predecessorRecordHash: h(review), sessionId: "independent-revalidated", traceRunId: "trace-independent",
    output: { phase: "consumer-revalidation-check", scopeHash: h(scope), requirementIds: scope.requirementIds, proposalHash: h(review.output), verdict: "supported", rationale: "Supported original conditions", evidence: review.output.evidence } };
  const plan = buildRevalidatedConsumerPlan(f.p, f.records, parent, [review, check]);
  expect(plan.allowedCreations).toEqual([]);
  expect(plan.requirementIds).toEqual(parent.requirementIds);
  expect(plan.requirementSetHash).toBe(parent.requirementSetHash);
  expect(identityUpstreamOrder(plan)).toEqual([{ kind: "entity", id: "unknown" }, { kind: "initial-world", id: "singleton" }]);
  const converged = upstreamRepairConvergedRevisions(plan, [{ artifactKind: "entity", artifactId: "unknown", payloadHash: h("accepted source-local revision") }]);
  expect(converged.has("entity-resolution:original-creation")).toBe(false);
  expect(converged.get(`entity-resolution:${decision.id}`)).toBe(h(decision));
  expect(converged.get("entity:unknown")).toBe(h("accepted source-local revision"));
  expect(plan.baselineRefs.some(r => r.id === "original-creation")).toBe(true);
  const activeRevisions = new Map(plan.baselineRefs.filter(r => r.id !== "original-creation").map(r => [`${r.kind}:${r.id}`, r.revisionHash]));
  const retired = plan.baselineRefs.find(r => r.id === "original-creation")!;
  const { retainedConsumerResolutionBaselines } = await import("../src/compiler/upstream-repair-checkpoint.js");
  const active = new Map<string, unknown>(f.p.catalog.filter((r: any) => r.id !== retired.id).map((r: any) => [`${r.kind}:${r.id}`, r.payload]));
  for (const d of decisions) active.set(`entity-resolution:${d.id}`, d);
  const lineage: any = { plan: parent, finishedReceipt: scope.receiptFingerprint, finishIntent: {
    baselines: parent.baselineRefs.map(ref => ({ ...ref, payload: f.p.catalog.find((r: any) => r.kind === ref.kind && r.id === ref.id)?.payload })),
    proposals: decisions.map((d: any) => ({ artifactKind: "entity-resolution", artifactId: d.id, payloadHash: h(d) })),
  } };
  const retainedPayload = f.p.catalog.find((r: any) => r.id === retired.id)!.payload;
  expect(retainedConsumerResolutionBaselines(plan, active, lineage)).toEqual(new Map([[`entity-resolution:${retired.id}`, retainedPayload]]));
  expect(active.has(`entity-resolution:${retired.id}`)).toBe(false);
  expect(() => retainedConsumerResolutionBaselines(plan, active)).toThrow(/exact completed parent/);
  expect(() => retainedConsumerResolutionBaselines(plan, active, { ...lineage, finishedReceipt: h("another receipt") })).toThrow(/exact completed parent/);
  const missing = new Map(active); missing.delete(`entity-resolution:${decision.id}`);
  expect(() => retainedConsumerResolutionBaselines(plan, missing, lineage)).toThrow(/retired identity baseline/);
  const changed = new Map(active); changed.set(`entity-resolution:${decision.id}`, { ...decision, rationale: "Changed decision" });
  expect(() => retainedConsumerResolutionBaselines(plan, changed, lineage)).toThrow(/retired identity baseline/);
  const reactivated = new Map(active); reactivated.set(`entity-resolution:${retired.id}`, retainedPayload);
  expect(() => retainedConsumerResolutionBaselines(plan, reactivated, lineage)).toThrow(/Competing resolution|retired identity baseline/);
  const altered = structuredClone(lineage);
  altered.finishIntent.baselines.find((r: any) => r.id === retired.id).payload = { ...retainedPayload, rationale: "Tampered predecessor" };
  expect(() => retainedConsumerResolutionBaselines(plan, active, altered)).toThrow(/Missing original resolution baseline/);
  const local = { ...quarantined, identityConsumption: { ...quarantined.identityConsumption, mode: "source-local", referentScope: { mentionIds: [decision.mentionId], crossIdentity: "unresolved", distinctness: "unasserted" } } };
  const mutation = { kind: "entity" as const, id: "unknown", baseline: quarantined, payload: local, activeRevisions,
    retainedRevisions: new Map([[`entity-resolution:${retired.id}`, retired.revisionHash]]), sourceSha256: scope.sourceHash,
    requirementSetHash: plan.requirementSetHash, citedSegmentIds: ["seg"], hostDerivation: {} };
  expect(() => assertUpstreamRepairMutation(plan, mutation)).not.toThrow();
  expect(() => assertUpstreamRepairMutation(plan, { ...mutation, retainedRevisions: new Map() })).toThrow(/baseline changed/);
  expect(() => assertUpstreamRepairMutation(plan, { ...mutation, payload: { ...local, canonicalName: "Someone else" } })).toThrow(/Unauthorized/);
  expect(() => assertUpstreamRepairMutation(plan, { ...mutation, payload: { ...local, identityConsumption: { ...local.identityConsumption, resolutionRevisionHash: h("different decision") } } })).toThrow(/exact decision/);
  expect(() => assertUpstreamRepairMutation(plan, { ...mutation, kind: "initial-world", id: "singleton", baseline: initial, payload: { ...initial, readerSetup: "Original opening repaired" } })).not.toThrow();
  expect(() => assertUpstreamRepairMutation(parent, mutation)).toThrow();
  const journal: any = [...f.records.map(record => ({ payload: { kind: "identity-requirements", record } })),
    ...[f.plan, f.review].map(record => ({ payload: { kind: "identity-consumer-repair", record } })),
    ...[review, check].map(record => ({ payload: { kind: "identity-consumer-revalidation", record } }))];
  expect(identityRequirementDefinition(journal, plan)).toEqual(f.records[0]!.output);
  expect(() => identityRequirementDefinition(journal.slice(0, -1), plan)).toThrow();
  const bad = structuredClone(check); if (bad.output.phase === "consumer-revalidation-check") bad.output.verdict = "blocked";
  expect(() => buildRevalidatedConsumerPlan(f.p, f.records, parent, [review, bad])).toThrow(/independently supported/);
});

it("seals real Pi read-only sessions, charges inherited usage, and resumes completed planning without dispatch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-consumer-repair-"));
  const providers: Awaited<ReturnType<typeof mockPiProvider>>[] = [];
  try {
    const source = await createEvidenceFixture(root, "Ada waits."), original = fixture();
    const f: ReturnType<typeof fixture> = JSON.parse(JSON.stringify(original).replaceAll('"src"', JSON.stringify(source.source.id)).replaceAll('"seg"', JSON.stringify(source.segmentId)).replaceAll(original.intent.sourceHash, source.source.contentSha256));
    f.records.forEach((r, i) => { r.intent = f.intent; r.output.intentHash = h(f.intent); if ("proposalHash" in r.output) r.output.proposalHash = h(f.records[i - 1]!.output); r.predecessorRecordHash = i ? h(f.records[i - 1]) : null; });
    Object.assign(f.plan.intent, { identityIntentHash: h(f.intent), definitionHash: h(f.records[0]!.output), proposalRecordHash: h(f.records[2]), checkRecordHash: h(f.records[3]),
      findingId: h({ taskId: f.intent.taskId, recordHash: h(f.records[2]), pointer: "/output/consumers/0" }) });
    f.plan.output.intentHash = h(f.plan.intent);
    const prior: ConsumerRepairRecord[] = [], prepared: any = { ...f.p, bytes: Buffer.from("Ada waits."), manifest: await new SegmentStore(root).readManifest(source.source.id), graph: { nodes: [] } };
    prepared.intent = f.intent;
    prepared.inventory = { ...f.inventory, consumers: [{ ref: "entity/unknown", revisionHash: h(f.entity), payload: f.entity, reason: "typed-consumer", dependencies: [] }] };
    const p: any = { intent: f.plan.intent, prepared, identity: f.records, prior, handoff: {
      selected: { ref: "entity/unknown", revisionHash: h(f.entity), payload: f.entity }, activationConditions: ["retain all original boundaries"],
      baselineManifest: [{ ref: "entity/unknown", revisionHash: h(f.entity) }], sourceReviewCoverage: [], capability: { writableFields: ["canonicalName", "aliases", "evidence"] } } };
    vi.spyOn(repairPreparation, "prepareConsumerRepair").mockImplementation(async () => p);
    vi.spyOn(repairPreparation, "assertConsumerRepairRetainedState").mockResolvedValue();
    // The pre-existing task is a fixture. Pi transport, tools, source reads,
    // request journals, independent session validation and budget are real.
    let interruptRegistration = true;
    vi.spyOn(RequirementLedger.prototype, "recordIdentityConsumerRepair").mockImplementation(async record => {
      await verifyConsumerRepairRecord(root, record);
      if (interruptRegistration) { interruptRegistration = false; throw Error("injected host registration failure after complete Pi session"); }
      prior.push(record);
    });
    const originalRuntime = ModelRuntime.create.bind(ModelRuntime);
    vi.spyOn(ModelRuntime, "create").mockImplementation(async options => options?.authPath === getAgentDir() + "/auth.json"
      ? { checkAuth: async () => ({ type: "oauth" }), getProvider: () => ({ auth: { oauth: { isSubscription: true } } }), getModel: () => ({}) } as any : originalRuntime(options));
    const create = PiAgentSession.create.bind(PiAgentSession);
    const dispatch = vi.spyOn(PiAgentSession, "create").mockImplementation(async options => {
      const check = path.basename(options.runtimeDir!) === "consumer-repair-check";
      const session = await create({ ...options, model: undefined, piAgentDir: path.join(root, "pi") });
      providers.push(await mockPiProvider(session, { provider: "openai-codex", modelId: "gpt-6.1-sol", response: (_context, index) => {
        if (index > 1) throw Error(`Unexpected model retry: ${JSON.stringify(_context.messages.slice(-2))}`);
        const output = check ? { ...f.review.output, intentHash: h(f.plan.intent), proposalHash: h(prior[0]!.output) } : f.plan.output;
        return fauxAssistantMessage(index === 0 ? [
          fauxToolCall("read_identity_source", { segmentIds: [source.segmentId], offset: 0 }, { id: `source-${check}` }),
          fauxToolCall("read_identity_dependencies", { refs: ["entity/unknown"], offset: 0 }, { id: `entity-${check}` }),
        ] : [fauxToolCall("submit_identity_requirements", JSON.parse(JSON.stringify(output)), { id: `submit-${check}` })], { stopReason: "toolUse" });
      } }));
      return session;
    });
    const args = { root, sourceId: f.plan.intent.sourceId, taskId: f.intent.taskId, ref: f.plan.intent.ref, authorizationRef: f.plan.intent.authorizationRef };
    await expect(runIdentityConsumerRepair(args)).rejects.toThrow("injected host registration failure");
    expect(dispatch).toHaveBeenCalledTimes(1); expect(prior).toHaveLength(0);
    const outcome = await runIdentityConsumerRepair(args);
    expect(outcome.status).toBe("CAPABILITY_GAP"); expect(outcome.executionAuthority).toBe(false); expect(outcome.parentResumeAllowed).toBe(false);
    expect(outcome.cumulative.modelCalls).toBe(166); expect(outcome.cumulative.totalPayloadBytes).toBeGreaterThan(36884781);
    expect(new Set(prior.map(r => r.sessionId)).size).toBe(2);
    const recoveryFiles = await fs.readdir(path.join(outcome.directory, "host-registration"));
    const failureFile = recoveryFiles.find(n => n.startsWith("state-"))!;
    expect(JSON.parse(await fs.readFile(path.join(outcome.directory, "host-registration", failureFile), "utf8")).reason).toContain("injected host registration failure");
    expect(dispatch).toHaveBeenCalledTimes(2);
    const resumed = await runIdentityConsumerRepair(args);
    expect(resumed.cumulative).toEqual(outcome.cumulative); expect(dispatch).toHaveBeenCalledTimes(2);
    const checkpoint = JSON.parse(await fs.readFile(path.join(outcome.directory, "consumer-repair-plan.session-checkpoint.json"), "utf8"));
    expect(checkpoint.providerUsage.totalTokens).toBe(200020);
    await fs.appendFile(checkpoint.sessionFile, '{"tampered":true}\n');
    await expect(runIdentityConsumerRepair(args)).rejects.toThrow(/changed after sealing/);
    expect(dispatch).toHaveBeenCalledTimes(2);
  } finally {
    for (const provider of providers) await provider.host.session.dispose();
    vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true });
  }
});
