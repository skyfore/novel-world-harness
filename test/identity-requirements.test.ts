import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiAgentSession } from "../src/agent/pi-session.js";
import * as service from "../src/compiler/identity-requirement-service.js";
import { identityRequirementDirectory } from "../src/compiler/identity-requirements.js";
import { runIdentityRequirements } from "../src/workflow/identity-requirements.js";
import { contentHash as h } from "../src/world/canonical.js";
import { identityIntentSchema, identityRequirementId, identityRequirementsReady, identitySemanticHash, identityStages, identityConsumersReviewable, identityDefinitionGaps,
  validateIdentityHistory, validateIdentityOutput, type IdentityRecord } from "../src/compiler/identity-requirements.js";
import { identityStageInput, identityStageCatalog, identityConsumerView } from "../src/workflow/identity-requirements.js";
import { buildIdentityRepairPlan } from "../src/compiler/identity-requirement-upstream.js";
import { assertUpstreamRepairMutation, freezeUpstreamRepairPlan, upstreamRepairPlanSchema } from "../src/compiler/upstream-repair-plan.js";
import { ModelRequestBudget } from "../src/runtime/model-request-budget.js";
import * as identityTrace from "../src/compiler/identity-requirement-trace.js";
import { identityRecoveryHost, inspectIdentityDefinitionRecovery, type IdentityDefinitionRecovery } from "../src/compiler/identity-definition-recovery.js";
import { RequirementLedger } from "../src/compiler/requirement-ledger.js";
import { TraceRecorder } from "../src/trace/recorder.js";
import { TraceStore } from "../src/trace/store.js";
import { digest } from "../src/runtime/compile-loop/workspace.js";
import { prerequisiteStop } from "../src/compiler/role-source-prerequisites.js";
import { inspectIdentityConsumerContinuation, type IdentityConsumerContinuation } from "../src/compiler/identity-consumer-continuation.js";
import { verifySemanticCorrectionJournal } from "../src/compiler/role-semantic-scope-correction.js";
import * as anchors from "../src/compiler/text-anchors.js";
import { inspectIdentityContextRecovery, type IdentityContextRecovery } from "../src/compiler/identity-context-recovery.js";
import { identityContextRecoveryDirectory } from "../src/compiler/identity-requirements.js";
import { identityPromptInput } from "../src/workflow/identity-requirements.js";
import * as handoff from "../src/runtime/compile-loop/prerequisite-handoff.js";
import { captureRecordTree } from "../src/runtime/compile-loop/dedicated-session.js";
import { mockPiProvider } from "./helpers/pi-provider.js";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { decodeJsonValues } from "../src/agent/lossless-json-context.js";

import { identityFixture as fixture } from "./helpers/identity-fixture.js";
const rechain = (records: IdentityRecord[]) => { for (let i = 1; i < records.length; i++) { records[i]!.predecessorRecordHash = h(records[i - 1]); if ("proposalHash" in records[i]!.output) (records[i]!.output as any).proposalHash = h(records[i - 1]!.output); } };

function withDefinitionGaps(f = fixture(), classified = true) {
  const definition = f.records[0]!.output;
  if (definition.phase !== "identity-definition") throw Error("fixture");
  definition.requirements.forEach((r, i) => { r.missingCondition = `Original identity bridge ${i} remains unknown`; });
  for (const r of f.records.slice(2)) {
    if (r.output.phase === "identity-consumers") {
      r.output.definitionHash = h(definition);
      if (classified) for (const b of r.output.bindings) b.definitionGap = { conditionHash: h(definition.requirements.find(d => d.id === b.requirementId)!.missingCondition),
        disposition: "retained-boundary", rationale: "Finite unresolved representation preserves the original question", evidence: definition.requirements[0]!.evidence };
    } else if (r.output.phase === "identity-consumers-check" && classified) for (const j of r.output.judgments) j.definitionGap = {
      conditionHash: h(definition.requirements.find(d => d.id === j.id)!.missingCondition), disposition: "retained-boundary", verdict: "supported",
      rationale: "Fresh review of the exact payload and retained boundary", evidence: definition.requirements[0]!.evidence };
  }
  rechain(f.records); return f;
}

it("separates read-only consumer review from authority while preserving every original gap", () => {
  const f = withDefinitionGaps(), original = structuredClone(f.records.slice(0, 2)), frozen = h(f.semantic);
  expect(identityConsumersReviewable(original)).toBe(true); expect(identityRequirementsReady(original)).toBe(false);
  validateIdentityOutput(f.intent, f.records, f.inventory, f.semantic);
  const plan = buildIdentityRepairPlan(f.p, f.records);
  expect(plan.identityRequirements!.recordHashes).toEqual(f.records.map(h));
  expect(f.records.slice(0, 2)).toEqual(original); expect(h(f.semantic)).toBe(frozen);
  expect(plan.requirementIds).not.toEqual(f.inventory.originalQuestionIds);
  expect((identityStageInput(f.p, "identity-consumers", original, 0) as any).definitionGaps).toEqual(identityDefinitionGaps(original[0]!.output));
});

it("never infers repair permission from supported legacy gaps or incomplete typed checks", () => {
  const legacy = withDefinitionGaps(fixture(), false), old = h(legacy.records);
  expect(identityConsumersReviewable(legacy.records.slice(0, 2))).toBe(true);
  expect(identityRequirementsReady(legacy.records)).toBe(false);
  expect(() => buildIdentityRepairPlan(legacy.p, legacy.records)).toThrow("no repair authority"); expect(h(legacy.records)).toBe(old);
  for (const mutate of [(r: any[]) => { delete r[2].output.bindings[0].definitionGap; delete r[3].output.judgments[0].definitionGap; },
    (r: any[]) => { delete r[3].output.judgments[0].definitionGap; },
    (r: any[]) => { r[3].output.judgments[0].definitionGap.verdict = "blocked"; },
    (r: any[]) => { r[2].output.bindings[0].missingCondition = "Finite repair needs independent evidence"; },
    ...["repair-prerequisite", "unknown"].map(disposition => (r: any[]) => {
      r[2].output.bindings[0].definitionGap.disposition = disposition; r[3].output.judgments[0].definitionGap.disposition = disposition;
    })]) {
    const f = withDefinitionGaps(); mutate(f.records); rechain(f.records);
    expect(identityRequirementsReady(f.records)).toBe(false); expect(() => buildIdentityRepairPlan(f.p, f.records)).toThrow("no repair authority");
  }
  const negative = withDefinitionGaps(); (negative.records[1]!.output as any).judgments[0].verdict = "blocked"; rechain(negative.records);
  expect(identityConsumersReviewable(negative.records)).toBe(false);
  const gap = withDefinitionGaps(); (gap.records[0]!.output as any).requirements[0].disposition = "evidence-gap"; rechain(gap.records);
  expect(identityConsumersReviewable(gap.records.slice(0, 2))).toBe(false);
});

it("binds gap assessments to the exact immutable condition and independent disposition", () => {
  for (const mutate of [(r: any[]) => { r[2].output.bindings[0].definitionGap.conditionHash = h("different gap"); },
    (r: any[]) => { r[3].output.judgments[0].definitionGap.disposition = "unknown"; },
    (r: any[]) => { r[3].output.judgments[0].definitionGap.conditionHash = h("different gap"); }]) {
    const f = withDefinitionGaps(); mutate(f.records); rechain(f.records);
    expect(() => validateIdentityHistory(f.records)).toThrow(/condition|disposition/);
  }
});

it("verifies old semantic correction history after exact identity appends without reopening dispatch", () => {
  const f = fixture(), review: any = { taskId: f.intent.taskId, revisionHash: f.intent.revisionHash, scope: {
    sourceId: f.intent.sourceId, sourceHash: f.intent.sourceHash, parentStateHash: f.intent.parentStateHash, planHash: f.intent.originalPlanHash, originalBudgetHash: f.intent.originalBudgetHash } };
  const semantic = f.semantic.map(s => ({ ...s, taskId: f.intent.taskId }));
  const prefix: any[] = [{ hash: h("pending"), payload: { kind: "role-dependency-review", review } },
    ...semantic.map(record => ({ hash: h(record), payload: { kind: "role-semantic-scope", record } }))];
  for (const r of f.records) { r.intent.semanticRecordHashes = semantic.map(h); r.intent.requirementPrefix = { length: 3, head: prefix[2]!.hash }; r.output.intentHash = h(r.intent); }
  for (const r of f.records) if (r.output.phase === "identity-consumers") r.output.definitionHash = h(f.records[0]!.output);
  rechain(f.records);
  const history = [...prefix, ...f.records.map(record => ({ hash: h(record), payload: { kind: "identity-requirements", record } }))] as any;
  expect(() => verifySemanticCorrectionJournal(history, review, false)).not.toThrow();
  expect(() => verifySemanticCorrectionJournal(history, review, true)).toThrow("consumed");
  for (const mutate of [(h: any[]) => { h[3].payload.record.intent.requirementPrefix.head = h[0].hash; },
    (h: any[]) => { h[3].payload.record.intent.taskId = "f".repeat(64); },
    (h: any[]) => { h.push({ payload: { kind: "role-dependency-review", review } }); },
    (h: any[]) => { h[2].payload.record.output.phase = "changed"; }]) {
    const bad = structuredClone(history); mutate(bad); expect(() => verifySemanticCorrectionJournal(bad, review, false)).toThrow();
  }
});

it("keeps independent definition blind to frozen repair payloads, consumers and candidate outcomes", () => {
  const f = fixture();
  const input = JSON.stringify(identityStageInput(f.p, "identity-definition", []));
  expect(input).not.toContain("payloadJson"); expect(input).not.toContain("event/consumer"); expect(input).not.toContain("SECRET_CANDIDATE_OUTCOME");
  expect(identityStageCatalog(f.p, "identity-definition").map(c => c.ref)).toEqual(f.intent.targets.map(t => `entity-mention:${t.mentionId}`));
  expect(JSON.stringify(identityStageInput(f.p, "identity-consumers", f.records.slice(0, 2), 0))).toContain("payloadJson");
});
it("requires every fixed shard and fresh independent session without resetting 143 old calls", () => {
  const f = fixture(); validateIdentityOutput(f.intent, f.records, f.inventory, f.semantic); expect(identityRequirementsReady(f.records)).toBe(true);
  expect(identityRequirementsReady(f.records.slice(0, -1))).toBe(false); expect(identityRequirementsReady([])).toBe(false);
  const bad = structuredClone(f.records); bad[3]!.sessionId = bad[2]!.sessionId; expect(() => validateIdentityHistory(bad)).toThrow("independent session");
  const reset = structuredClone(f.records); reset[4]!.intent.priorUsage.modelCalls = 0; expect(() => validateIdentityHistory(reset)).toThrow();
});
it("rejects omitted consumers, source pages, original questions and typed dependencies", () => {
  for (const field of ["consumers", "sourcePages", "originalQuestionIds"] as const) {
    const f = fixture(); (f.records[2]!.output as any)[field].pop(); rechain(f.records);
    expect(() => validateIdentityOutput(f.intent, f.records, f.inventory, f.semantic)).toThrow();
  }
  const f = fixture(); (f.records[2]!.output as any).bindings[0].dependencyRefs = ["entity-mention:guessed"]; rechain(f.records);
  expect(() => validateIdentityOutput(f.intent, f.records, f.inventory, f.semantic)).toThrow("typed dependencies");
});
it("retains negative consumer findings and independent missing conditions without authorizing a plan", () => {
  for (const mutate of [(r: any[]) => { r[2].output.consumers[0].disposition = "additional-repair-required"; },
    (r: any[]) => { r[2].output.bindings[0].missingCondition = "Required source identity remains unavailable"; },
    (r: any[]) => { r[3].output.denominatorVerdict = "blocked"; }]) {
    const f = fixture(); mutate(f.records); rechain(f.records); expect(identityRequirementsReady(f.records)).toBe(false);
    expect(() => buildIdentityRepairPlan(f.p, f.records)).toThrow("no repair authority");
  }
});
it("an exact plan cannot widen types, mutate a frozen payload or satisfy an incompatible independent definition", () => {
  const f = fixture(), plan = buildIdentityRepairPlan(f.p, f.records);
  expect(plan.allowedWrites).toEqual([]); expect(plan.requirementIds).toHaveLength(3); expect(plan.identityRequirements?.recordHashes).toHaveLength(6);
  const { planHash: _, ...identity } = plan;
  expect(() => freezeUpstreamRepairPlan({ ...identity, allowedCreations: [{ ...identity.allowedCreations[0]!, kind: "entity-mention" }, ...identity.allowedCreations.slice(1)] })).toThrow();
  const payload = JSON.parse(f.semantic[0].output.operations[0].payloadJson);
  const mutation = { kind: "entity-resolution" as const, id: payload.id, baseline: null, payload: { ...payload, rationale: "Unauthorized meaning change" }, activeRevisions: new Map(plan.baselineRefs.map(r => [`${r.kind}:${r.id}`, r.revisionHash])), sourceSha256: plan.sourceScope.sourceSha256, requirementSetHash: plan.requirementSetHash, citedSegmentIds: ["seg"], hostDerivation: payload.derivation };
  expect(() => assertUpstreamRepairMutation(plan, mutation)).toThrow("exact semantic payload");
  const bad = structuredClone(plan); bad.identityRequirements!.semanticSlots.pop(); expect(upstreamRepairPlanSchema.safeParse(bad).success).toBe(false);
  expect(identitySemanticHash(payload)).toBe(identitySemanticHash({ ...payload, derivation: { ...payload.derivation, runId: "actual-host-provenance" } }));
});
it("roster views preserve every semantic candidate while hashing mechanical provenance inventories", () => {
  const roster = { unitIds: ["u1", "u2"], extractionRunIds: ["run"], candidates: [{ id: "c", mentionIds: ["m"] }], reviews: [{ verdict: "blocked" }] };
  expect(identityConsumerView("roster/source", roster)).toEqual({ candidates: roster.candidates, reviews: roster.reviews, unitInventory: { count: 2, hash: h(roster.unitIds) }, extractionInventory: { count: 1, hash: h(roster.extractionRunIds) } });
  expect(roster.unitIds).toEqual(["u1", "u2"]);
});

it("retains an unread-source failure and cumulative charge, then refuses to start the consumed intent again", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-identity-runner-")), f = fixture();
  f.p.bytes = Buffer.from("Ada waits."); f.p.manifest.segments[0] = { id: "seg", startByte: 0, endByte: 10 };
  const before = h(f.intent), dir = identityRequirementDirectory(root, f.intent.sourceId, f.intent.taskId);
  let sessions = 0;
  try {
    vi.spyOn(service, "prepareIdentityRequirements").mockResolvedValue(f.p);
    vi.spyOn(ModelRuntime, "create").mockResolvedValue({ checkAuth: async () => ({ type: "oauth" }), getProvider: () => ({ auth: { oauth: { isSubscription: true } } }), getModel: () => ({}) } as any);
    vi.spyOn(PiAgentSession, "create").mockImplementation(async options => {
      sessions++; expect(options.includeLocalTools).toBe(false); expect(options.model).toBe("openai-codex/gpt-6.1-sol");
      return { id: "new-independent-test-session", model: options.model, abort: async () => {}, dispose: async () => {}, async promptWithReport(input: string) {
        options.requestBudget!.beginCall({}); options.requestBudget!.admitPayload(JSON.parse(input));
        await options.additionalTools!.find(t => t.name === "submit_identity_requirements")!.execute("unread-submission", f.records[0]!.output as any, undefined as any, undefined as any, undefined as any);
      } } as any;
    });
    const options = { root, input: {} as any, authorizationRef: f.intent.authorizationRef, priorUsage: f.intent.priorUsage, expectedIntentHash: h(f.intent), assertOriginal: async () => {} };
    await expect(runIdentityRequirements(options)).rejects.toThrow("Read every required source");
    const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
    const budget = JSON.parse(await fs.readFile(path.join(dir, "identity-definition.budget.json"), "utf8"));
    expect(state.phase).toBe("BREAK"); expect(state.authorityGranted).toBe(false); expect(budget.state.usage.modelCalls).toBe(1); expect(budget.cumulative.modelCalls).toBe(144);
    expect((await fs.readdir(dir)).some(n => n.endsWith(".record.json"))).toBe(false);
    await expect(runIdentityRequirements(options)).rejects.toThrow("already reserved"); expect(sessions).toBe(1); expect(h(f.intent)).toBe(before);
  } finally { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); }
});

it("verifies actual budget semantics when logical context is larger than the provider JSON", () => {
  const budget = new ModelRequestBudget();
  const payloads = [{ input: "a" }, { input: "bb" }];
  for (const payload of payloads) { budget.beginCall({ messages: ["larger logical context".repeat(10)] }); budget.admitPayload(payload); }
  const sizes = payloads.map(p => Buffer.byteLength(JSON.stringify(p))), usage = budget.snapshot();
  expect(usage.largestRequestBytes).toBeGreaterThan(Math.max(...sizes));
  expect(identityTrace.identityRequestUsageMatches(usage, sizes, 2)).toBe(true);
  // Retained incident counters: exact payload total; logical-context high water
  // mark is 1,519 bytes above the largest transport payload.
  expect(identityTrace.identityRequestUsageMatches({ modelCalls: 3, payloads: 3, totalPayloadBytes: 513226, largestRequestBytes: 245574 }, [36695, 232476, 244055], 3)).toBe(true);
  for (const patch of [{ modelCalls: 1 }, { payloads: 3 }, { totalPayloadBytes: usage.totalPayloadBytes - 1 },
    { largestRequestBytes: Math.max(...sizes) - 1 }, { largestRequestBytes: 512001 }, { largestRequestBytes: NaN }]) {
    expect(identityTrace.identityRequestUsageMatches({ ...usage, ...patch }, sizes, 2)).toBe(false);
  }
  expect(identityTrace.identityRequestUsageMatches(usage, sizes.slice(1), 2)).toBe(false);
});

async function retainedDefinitionFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-identity-recovery-")), f = fixture();
  f.p.bytes = Buffer.from("Ada waits."); f.p.manifest.segments[0] = { id: "seg", startByte: 0, endByte: 10 };
  const dir = identityRequirementDirectory(root, f.intent.sourceId, f.intent.taskId), record = f.records[0]!;
  await fs.mkdir(dir, { recursive: true });
  const trace = await TraceRecorder.start(new TraceStore(root), { kind: "prepare", sourceId: f.intent.sourceId,
    operationId: `identity-requirements-${f.intent.taskId}-identity-definition` });
  await trace.finish("succeeded"); record.traceRunId = trace.manifest.id;
  const originalPid = 2147483647, state = { phase: "BREAK", stage: record.stage, childPid: null, intentHash: h(f.intent),
    traceRunId: record.traceRunId, reason: String(prerequisiteStop("Identity record lacks actual bounded Pi subscription provenance")) };
  const values = { "start.json": { taskId: f.intent.taskId, intentHash: h(f.intent), pid: originalPid }, "state.json": state,
    "intent.json": f.intent, "inventory.json": f.inventory, "context.json": {},
    "provider.json": { provider: "openai-codex", model: "gpt-6.1-sol", subscription: true, credentialType: "oauth" },
    "hooks.jsonl": "old immutable hooks", "identity-definition.invocation.json": { pid: originalPid },
    "identity-definition.input.json": identityStageInput(f.p, "identity-definition", []), "identity-definition.proposal.json": record.output,
    "identity-definition.record.json": record, "identity-definition.budget.json": { state: { usage: { modelCalls: 3, totalPayloadBytes: 5000 } },
      cumulative: { modelCalls: 146, totalPayloadBytes: f.intent.priorUsage.totalPayloadBytes + 5000 } } };
  for (const [name, value] of Object.entries(values)) await fs.writeFile(path.join(dir, name), JSON.stringify(value));
  const retainedFiles: Record<string, string> = {};
  for (const name of Object.keys(values)) retainedFiles[name] = createHash("sha256").update(await fs.readFile(path.join(dir, name))).digest("hex");
  const proof: IdentityDefinitionRecovery = { version: 1, policy: "identity-definition-host-accounting/v1", intentHash: h(f.intent),
    stoppedStateHash: digest(state), recordHash: h(record), originalPid, host: await identityRecoveryHost(), reviewedFixRef: "reviewed-test-fix", retainedFiles };
  return { ...f, root, dir, record, proof };
}

it("fails recovery before dispatch on changed files, wrong host, a live owner or a later consumed stage", async () => {
  const f = await retainedDefinitionFixture();
  try {
    const verify = vi.spyOn(identityTrace, "verifyIdentityRecord").mockResolvedValue();
    await expect(inspectIdentityDefinitionRecovery(f.root, f.p, { ...f.proof, host: { ...f.proof.host, pidNamespace: "different" } })).rejects.toThrow("owning-host");
    await expect(inspectIdentityDefinitionRecovery(f.root, f.p, { ...f.proof, originalPid: process.pid })).rejects.toThrow("owner");
    const partial = structuredClone(f.proof); delete partial.retainedFiles["identity-definition.budget.json"];
    await expect(inspectIdentityDefinitionRecovery(f.root, f.p, partial)).rejects.toThrow("freeze every original file");
    const drift = structuredClone(f.proof); drift.retainedFiles["identity-definition.proposal.json"] = h("changed");
    await expect(inspectIdentityDefinitionRecovery(f.root, f.p, drift)).rejects.toThrow("Retained identity file changed");
    const valid = await inspectIdentityDefinitionRecovery(f.root, f.p, f.proof);
    expect(valid.cumulative.modelCalls).toBe(146); expect(valid.remainingStages[0]!.stage).toBe("identity-definition-check");
    expect(verify).toHaveBeenCalledTimes(1);
    // A successful later trace is consumed even if no later artifact was saved.
    const next = await TraceRecorder.start(new TraceStore(f.root), { kind: "prepare", sourceId: f.intent.sourceId,
      operationId: `identity-requirements-${f.intent.taskId}-identity-definition-check` });
    await next.finish("succeeded");
    await expect(inspectIdentityDefinitionRecovery(f.root, f.p, f.proof)).rejects.toThrow("later fixed identity stage was already invoked");
    expect(verify).toHaveBeenCalledTimes(1);
  } finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
});

it("registers the original retained proposal once and charges only the next stage while preserving the host failure", async () => {
  const f = await retainedDefinitionFixture(), registered: IdentityRecord[] = [];
  let calls = 0;
  try {
    vi.spyOn(service, "prepareIdentityRequirements").mockResolvedValue(f.p);
    vi.spyOn(identityTrace, "verifyIdentityRecord").mockResolvedValue();
    vi.spyOn(RequirementLedger.prototype, "identityRequirements").mockImplementation(async () => registered);
    vi.spyOn(RequirementLedger.prototype, "recordIdentityRequirements").mockImplementation(async r => { registered.push(r); });
    vi.spyOn(RequirementLedger.prototype, "history").mockResolvedValue([{ hash: h("retained original registration") }] as any);
    vi.spyOn(ModelRuntime, "create").mockResolvedValue({ checkAuth: async () => ({ type: "oauth" }), getProvider: () => ({ auth: { oauth: { isSubscription: true } } }), getModel: () => ({}) } as any);
    vi.spyOn(PiAgentSession, "create").mockImplementation(async options => {
      calls++; expect(options.model).toBe("openai-codex/gpt-6.1-sol"); expect(options.trace!.invocationName).toBe("identity-definition-check");
      return { id: "fresh-independent-check", model: options.model, abort: async () => {}, dispose: async () => {}, async promptWithReport(input: string) {
        const value = JSON.parse(input); expect(value.proposalHash).toBe(h(f.record.output));
        options.requestBudget!.beginCall({}); options.requestBudget!.admitPayload(value);
        throw Error("Independent test session stopped; no retry");
      } } as any;
    });
    const options = { root: f.root, input: {} as any, authorizationRef: f.intent.authorizationRef, priorUsage: f.intent.priorUsage,
      expectedIntentHash: h(f.intent), assertOriginal: async () => {}, recoverDefinition: f.proof };
    await expect(runIdentityRequirements(options)).rejects.toThrow("Independent test session stopped");
    expect(calls).toBe(1); expect(registered.map(h)).toEqual([h(f.record)]);
    const budget = JSON.parse(await fs.readFile(path.join(f.dir, "identity-definition-check.budget.json"), "utf8"));
    expect(budget.cumulative.modelCalls).toBe(147); expect(budget.state.usage.modelCalls).toBe(1);
    expect(budget.cumulative.totalPayloadBytes).toBe(f.intent.priorUsage.totalPayloadBytes + 5000 + budget.state.usage.totalPayloadBytes);
    for (const [name, hash] of Object.entries(f.proof.retainedFiles)) expect(createHash("sha256").update(await fs.readFile(path.join(f.dir, name))).digest("hex")).toBe(hash);
    const receipt = JSON.parse(await fs.readFile(path.join(f.dir, "host-recovery/registration-receipt.json"), "utf8"));
    expect(receipt.providerCalls).toBe(0); expect(receipt.worldWrites).toBe(0); expect(receipt.cumulative.modelCalls).toBe(146);
    await expect(runIdentityRequirements(options)).rejects.toThrow(); expect(calls).toBe(1); expect(registered).toHaveLength(1);
  } finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
});

async function retainedConsumerFixture() {
  const f = await retainedDefinitionFixture(); withDefinitionGaps(f);
  const trace = await TraceRecorder.start(new TraceStore(f.root), { kind: "prepare", sourceId: f.intent.sourceId,
    operationId: `identity-requirements-${f.intent.taskId}-identity-definition-check` });
  await trace.finish("succeeded"); f.records[1]!.traceRunId = trace.manifest.id; rechain(f.records);
  const originalPid = f.proof.originalPid, { bytes, ...context } = f.p;
  const state = { phase: "BREAK", stage: "identity-definition-check", childPid: null, traceRunId: null,
    intentHash: h(f.intent), newModelCalls: 6, cumulativeModelCalls: 149,
    reason: String(prerequisiteStop("Independent definition retains a gap or negative review; no consumer dispatch and no definition retry")) };
  await fs.mkdir(path.join(f.dir, "host-recovery"));
  const values = { "context.json": { ...context, sourceBytesBase64: Buffer.from(bytes).toString("base64") },
    "identity-definition.proposal.json": f.records[0]!.output, "identity-definition.record.json": f.records[0],
    "identity-definition-check.invocation.json": { pid: originalPid }, "identity-definition-check.input.json": identityStageInput(f.p, "identity-definition-check", f.records.slice(0, 1)),
    "identity-definition-check.proposal.json": f.records[1]!.output, "identity-definition-check.record.json": f.records[1],
    "identity-definition-check.budget.json": { state: { usage: { modelCalls: 3, totalPayloadBytes: 6000 } }, cumulative: { modelCalls: 149, totalPayloadBytes: f.intent.priorUsage.totalPayloadBytes + 11000 } },
    "host-recovery/start.json": { pid: originalPid, taskId: f.intent.taskId, intentHash: h(f.intent) }, "host-recovery/state.json": state,
    "host-recovery/intent.json": f.proof, "host-recovery/hooks.jsonl": "retained recovery hook", "host-recovery/registration-receipt.json": { recordHash: h(f.records[0]) } };
  for (const [name, value] of Object.entries(values)) await fs.writeFile(path.join(f.dir, name), JSON.stringify(value));
  const retainedFiles: Record<string, string> = {};
  for (const prefix of ["", "host-recovery/"]) for (const entry of await fs.readdir(path.join(f.dir, prefix), { withFileTypes: true })) {
    if (entry.isFile()) retainedFiles[prefix + entry.name] = createHash("sha256").update(await fs.readFile(path.join(f.dir, prefix, entry.name))).digest("hex");
  }
  const continuation: IdentityConsumerContinuation = { version: 1, policy: "identity-consumer-gap-review/v1", intentHash: h(f.intent),
    stoppedStateHash: digest(state), stoppedDirectory: "host-recovery", recordHashes: f.records.slice(0, 2).map(h), originalPid,
    host: await identityRecoveryHost(), reviewedFixRef: "reviewed-source-gap-fix", authorizationRef: "Continue only original unconsumed consumer reviews", retainedFiles };
  return { ...f, continuation };
}

it("rejects consumer continuation on changed history, wrong host, negative review or an already invoked shard", async () => {
  const f = await retainedConsumerFixture();
  try {
    vi.spyOn(identityTrace, "verifyIdentityRecord").mockResolvedValue();
    vi.spyOn(RequirementLedger.prototype, "identityRequirements").mockResolvedValue(f.records.slice(0, 2));
    const valid = await inspectIdentityConsumerContinuation(f.root, f.p, f.continuation);
    expect(valid.cumulative.modelCalls).toBe(149); expect(valid.remainingStages.map(s => s.stage)).toEqual(identityStages(f.intent).slice(2).map(s => s.stage));
    await expect(inspectIdentityConsumerContinuation(f.root, f.p, { ...f.continuation, host: { ...f.continuation.host, pidNamespace: "other" } })).rejects.toThrow("owning-host");
    const drift = structuredClone(f.continuation); drift.retainedFiles["identity-definition-check.proposal.json"] = h("changed");
    await expect(inspectIdentityConsumerContinuation(f.root, f.p, drift)).rejects.toThrow("Retained identity file changed");
    const omitted = structuredClone(f.continuation); delete omitted.retainedFiles["identity-definition.budget.json"];
    await expect(inspectIdentityConsumerContinuation(f.root, f.p, omitted)).rejects.toThrow("freeze every original file");
    const check = f.records[1]!.output as any; check.judgments[0].verdict = "blocked";
    await expect(inspectIdentityConsumerContinuation(f.root, f.p, f.continuation)).rejects.toThrow("registrations"); check.judgments[0].verdict = "supported";
    const dispatched = await TraceRecorder.start(new TraceStore(f.root), { kind: "prepare", sourceId: f.intent.sourceId,
      operationId: `identity-requirements-${f.intent.taskId}-identity-consumers-0` });
    await dispatched.finish("failed");
    await expect(inspectIdentityConsumerContinuation(f.root, f.p, f.continuation)).rejects.toThrow("already invoked");
  } finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
});

it.each([false, true])("continues only fixed consumer stages with inherited charges and preserves the consumed definitions (negative=%s)", async negative => {
  const f = await retainedConsumerFixture(), registered = f.records.slice(0, 2), dispatched: string[] = [];
  try {
    vi.spyOn(service, "prepareIdentityRequirements").mockResolvedValue(f.p);
    vi.spyOn(identityTrace, "verifyIdentityRecord").mockResolvedValue();
    vi.spyOn(RequirementLedger.prototype, "identityRequirements").mockImplementation(async () => registered);
    vi.spyOn(RequirementLedger.prototype, "recordIdentityRequirements").mockImplementation(async r => { registered.push(r); });
    vi.spyOn(anchors, "resolveTextSelectorAnchor").mockResolvedValue(f.records[0]!.evidence[0]!.anchor);
    vi.spyOn(ModelRuntime, "create").mockResolvedValueOnce({ checkAuth: async () => ({ type: "oauth" }), getProvider: () => ({ auth: { oauth: { isSubscription: true } } }), getModel: () => ({}) } as any);
    const create = PiAgentSession.create.bind(PiAgentSession);
    vi.spyOn(PiAgentSession, "create").mockImplementation(async options => {
      const stage = identityStages(f.intent)[registered.length]!.stage; dispatched.push(stage);
      const session = await create({ ...options, model: undefined, piAgentDir: path.join(f.root, "pi") });
      await mockPiProvider(session, { provider: "openai-codex", modelId: "gpt-6.1-sol", response: (context, index) => {
        const user = context.messages.find(m => m.role === "user")!;
        const raw = typeof user.content === "string" ? user.content : (user.content[0] as any).text;
        const envelope = JSON.parse(raw), input: any = envelope.$nwhContext ? decodeJsonValues(envelope.dictionary, [envelope.value])[0] : envelope;
        expect(input.definitionGaps).toEqual(identityDefinitionGaps(f.records[0]!.output));
        if (index === 0) return fauxAssistantMessage([
          fauxToolCall("read_identity_source", { segmentIds: ["seg"], offset: 0 }, { id: "source" }),
          fauxToolCall("read_identity_dependencies", { collection: "dependencies", refs: input.requiredDependencyRefs, offset: 0 }, { id: "dependencies" }),
          fauxToolCall("read_identity_dependencies", { collection: "consumers", refs: input.inventory.consumers.map((c: any) => c.ref), offset: 0 }, { id: "consumers" }),
        ], { stopReason: "toolUse" });
        if (index !== 1) throw new Error("Unexpected continuation test provider call");
        const output = structuredClone(f.records[registered.length]!.output) as any;
        if (input.proposalHash) { output.proposalHash = input.proposalHash; if (negative) output.judgments[0].definitionGap.verdict = "blocked"; }
        return fauxAssistantMessage([fauxToolCall("submit_identity_requirements", JSON.parse(JSON.stringify(output)), { id: "submission" })], { stopReason: "toolUse" });
      } });
      return session;
    });
    const options = { root: f.root, input: {} as any, authorizationRef: f.intent.authorizationRef, priorUsage: f.intent.priorUsage,
      expectedIntentHash: h(f.intent), assertOriginal: async () => {}, continueConsumers: f.continuation };
    if (negative) await expect(runIdentityRequirements(options)).rejects.toThrow("Consumer shard retains"); else await runIdentityRequirements(options);
    expect(dispatched).toEqual(identityStages(f.intent).slice(2, negative ? 4 : undefined).map(s => s.stage));
    expect(registered.slice(0, 2).map(h)).toEqual(f.continuation.recordHashes);
    const first = JSON.parse(await fs.readFile(path.join(f.dir, "identity-consumers-0.budget.json"), "utf8"));
    expect(first.cumulative.modelCalls).toBe(151); expect(first.cumulative.totalPayloadBytes).toBe(f.intent.priorUsage.totalPayloadBytes + 11000 + first.state.usage.totalPayloadBytes);
    for (const [name, hash] of Object.entries(f.continuation.retainedFiles)) expect(createHash("sha256").update(await fs.readFile(path.join(f.dir, name))).digest("hex")).toBe(hash);
    const state = JSON.parse(await fs.readFile(path.join(f.dir, "consumer-review/state.json"), "utf8"));
    expect(state.phase).toBe(negative ? "BREAK" : "DONE"); expect(state.authorityGranted).toBe(false); expect(state.parentCompileResumeAllowed).toBe(false);
    const receipt = JSON.parse(await fs.readFile(path.join(f.dir, "consumer-review/continuation-receipt.json"), "utf8"));
    expect(receipt.registrationWrites).toBe(0); expect(receipt.cumulative.modelCalls).toBe(149);
    const count = dispatched.length; await expect(runIdentityRequirements(options)).rejects.toThrow(); expect(dispatched).toHaveLength(count);
    if (negative) await expect(fs.stat(path.join(f.dir, "upstream-plan.preview.json"))).rejects.toThrow();
  } finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
});

it("projects only mechanical duplication while retaining every current consumer, question and semantic judgment", () => {
  const f = withDefinitionGaps(), input = identityStageInput(f.p, "identity-consumers-check", f.records.slice(0, 3), 0);
  const copy = structuredClone(input), projected = identityPromptInput(input) as any;
  expect(input).toEqual(copy);
  expect(projected.intent.currentConsumerShard).toEqual(f.intent.consumerShards[0]);
  expect(projected.intent.consumerShardDirectory).toEqual(f.intent.consumerShards.map(s => ({ index: s.index, count: s.refs.length, refsHash: h(s.refs) })));
  expect(projected.inventory).toEqual(input.inventory);
  expect(projected.frozenScope).toEqual(input.frozenScope);
  expect(projected.definitionGaps).toEqual(input.definitionGaps);
  for (const key of ["candidateIds", "sourcePages", "originalQuestionIds"]) {
    expect(projected.proposal[key]).toEqual({ $inputRef: `/inventory/${key}` });
    projected.proposal[key] = projected.inventory[key];
  }
  expect(projected.proposal).toEqual(input.proposal);
  // A mismatched denominator must remain visible to the independent reviewer.
  (copy.proposal as any).candidateIds = ["unexpected"];
  expect((identityPromptInput(copy) as any).proposal.candidateIds).toEqual(["unexpected"]);
});

async function retainedContextFixture(localFailureUsage = 0) {
  const f = await retainedConsumerFixture(), engineering = path.join(f.dir, "consumer-review/engineering");
  await fs.mkdir(engineering, { recursive: true });
  const traces = new TraceStore(f.root), trace = await TraceRecorder.start(traces, { kind: "prepare", sourceId: f.intent.sourceId,
    operationId: `identity-requirements-${f.intent.taskId}-identity-consumers-0` });
  const payloadRef = await trace.putBlob({ text: "original paid request" });
  for (let i = 0; i < 5; i++) {
    const links = { callId: `call-${i}` };
    await trace.record("llm.request.started", { providerId: "openai-codex", modelId: "gpt-6.1-sol" }, trace.rootContext, links);
    await trace.record("llm.request.payload", {}, trace.rootContext, { ...links, blobRef: payloadRef });
    await trace.record("llm.response.completed", {}, trace.rootContext, links);
  }
  await trace.record("llm.response.failed", { providerId: "openai-codex", modelId: "gpt-6.1-sol",
    errorMessage: "original byte failure", usage: { input: localFailureUsage, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: localFailureUsage, cost: 0 } },
    trace.rootContext, { callId: "locally-refused-step" });
  await trace.finish("failed");
  const usage = { modelCalls: 5, payloads: 5, totalPayloadBytes: 5 * payloadRef.byteLength, largestRequestBytes: payloadRef.byteLength };
  const oldBudget = { state: { usage, blocked: true, failure: { code: "request-size", message: "original byte failure" } } };
  await fs.writeFile(path.join(f.dir, "identity-consumers-0.budget.json"), JSON.stringify(oldBudget));
  await fs.writeFile(path.join(f.dir, "identity-consumers-0.input.json"), JSON.stringify(identityStageInput(f.p, "identity-consumers", f.records.slice(0, 2), 0)));
  const requestFile = path.join(f.root, "request.json");
  await fs.writeFile(requestFile, JSON.stringify({ failedTraceRunId: trace.manifest.id }));
  const spec = { version: 1, root: f.root, sourceId: f.intent.sourceId, taskId: f.intent.taskId, directory: engineering,
    registryFile: "/retained-registry", ownershipLocks: ["/retained-lock"], authorizationRef: "previous authorization",
    incidentFile: "/retained-incident", incidentHash: h("incident"), authorizationFile: "/retained-authorization", authorizationHash: h("authorization"),
    retainedFiles: {}, parentStateFile: "/retained-parent", parentStateHash: f.intent.parentStateHash,
    inherited: { workers: 21, repairs: 20, commands: 83, failures: { original: 2 } }, engineerModel: "gpt-5.6-sol",
    workerEntry: "src/workflow/identity-consumer-context-recovery.ts", workerRequestFile: requestFile, deadline: 1792570345309 };
  const stopped = { phase: "BREAK", childPid: null, workerDispatches: 0, updatedAt: "2026-10-18T20:03:19.012Z" };
  await fs.writeFile(path.join(engineering, "spec.json"), JSON.stringify(spec));
  await fs.writeFile(path.join(engineering, "state.json"), JSON.stringify(stopped));
  await fs.writeFile(path.join(engineering, "start.json"), JSON.stringify({ pid: 2147483647 }));
  const proof: IdentityContextRecovery = { version: 1, policy: "identity-context-reconstruction/v1",
    taskId: f.intent.taskId, sourceId: f.intent.sourceId, intentHash: h(f.intent), originalSpecHash: digest(spec),
    engineeringStateHash: digest(stopped), failedTraceHash: h({ run: await traces.peekRun(trace.manifest.id), events: await traces.peekEvents(trace.manifest.id) }),
    authorizationRef: "Later human authorization: persist sessions and recover with original remaining budget",
    authorizedAt: "2026-10-20T10:00:00.000Z", mode: "reread-immutable-evidence-with-remaining-budget",
    retainedEngineeringFiles: captureRecordTree(engineering) };
  // The existing supervisor's exact-source/history/host/PID guards have their
  // own real regression suite; this fixture exercises the new recovery layer.
  vi.spyOn(handoff, "verifyPrerequisiteHandoff").mockReturnValue({} as any);
  vi.spyOn(identityTrace, "verifyIdentityRecord").mockResolvedValue();
  vi.spyOn(RequirementLedger.prototype, "identityRequirements").mockResolvedValue(f.records.slice(0, 2));
  return { ...f, engineering, proof, oldBudget, traceId: trace.manifest.id, traces };
}

it("rejects missing authorization, changed lineage, consumed submission and a second context reconstruction", async () => {
  const f = await retainedContextFixture();
  try {
    const inspected = await inspectIdentityContextRecovery(f.root, f.p, f.proof);
    expect(inspected.initial.usage).toEqual(f.oldBudget.state.usage);
    expect(inspected.initial.blocked).toBe(false);
    await expect(inspectIdentityContextRecovery(f.root, f.p, { ...f.proof, authorizationRef: "" })).rejects.toThrow();
    await expect(inspectIdentityContextRecovery(f.root, f.p, { ...f.proof, authorizedAt: "2026-10-17T00:00:00.000Z" })).rejects.toThrow("later explicit");
    await expect(inspectIdentityContextRecovery(f.root, f.p, { ...f.proof, failedTraceHash: h("changed") })).rejects.toThrow("exact settled");
    await fs.writeFile(path.join(f.dir, "identity-consumers-0.proposal.json"), "{}");
    await expect(inspectIdentityContextRecovery(f.root, f.p, f.proof)).rejects.toThrow("consumed");
    await fs.rm(path.join(f.dir, "identity-consumers-0.proposal.json"));
    const directory = identityContextRecoveryDirectory(f.root, f.intent.sourceId, f.intent.taskId);
    await fs.mkdir(directory); await fs.writeFile(path.join(directory, "start.json"), "{}");
    await expect(inspectIdentityContextRecovery(f.root, f.p, f.proof)).rejects.toThrow("already consumed");
    expect(JSON.parse(await fs.readFile(path.join(f.dir, "identity-consumers-0.budget.json"), "utf8"))).toEqual(f.oldBudget);
  } finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
});

it("rejects a failed response with provider usage even when no request event was retained", async () => {
  const f = await retainedContextFixture(1);
  try { await expect(inspectIdentityContextRecovery(f.root, f.p, f.proof)).rejects.toThrow("Unsettled calls"); }
  finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
});

it("does not allow a legacy proof and a no-op callback to bypass the repository recovery gate", async () => {
  const f = await retainedContextFixture(), before = captureRecordTree(f.dir);
  try {
    const dispatch = vi.spyOn(PiAgentSession, "create");
    await expect(runIdentityRequirements({ root: f.root, input: {} as any, authorizationRef: f.intent.authorizationRef,
      priorUsage: f.intent.priorUsage, expectedIntentHash: h(f.intent), assertOriginal: async () => {}, recoverContext: f.proof }))
      .rejects.toThrow("repository host gate");
    expect(dispatch).not.toHaveBeenCalled(); expect(captureRecordTree(f.dir)).toEqual(before);
  } finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
});
