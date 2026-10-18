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
import { identityIntentSchema, identityRequirementId, identityRequirementsReady, identitySemanticHash, identityStages,
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

function fixture() {
  const taskId = h("original-prerequisite"), evidence = [{ segment_id: "seg", exact: "Ada waits." }], questionIds = [h("critical-1"), h("critical-2"), h("critical-3")];
  const targets = [1, 2, 3].map(slot => ({ slot, requirementId: identityRequirementId(taskId, slot), mentionId: `mention-${slot}`, mentionHash: h(slot), predecessor: null, questionIds: [questionIds[0]!] }));
  const operations = targets.map(t => {
    const payload = { version: 1, id: `rs-${taskId.slice(0, 32)}-${t.slot}`, sourceId: "src", mentionId: t.mentionId, status: "unresolved", candidates: [], rationale: "Independent source uncertainty", derivation: { runId: "old", worker: "old", ontologyVersion: "entity-resolution-v1" } };
    return { slot: t.slot, id: payload.id, kind: "entity-resolution", mode: "create", baseline: null, pointers: [], payloadJson: JSON.stringify(payload), readableRefs: [{ kind: "entity-mention", id: t.mentionId, revisionHash: t.mentionHash }], findingIds: [], questionIds: t.questionIds, rationale: "Frozen scope", evidence };
  });
  const semantic: any[] = [{ output: { phase: "semantic-scope-plan", operations, questions: questionIds.map(questionId => ({ questionId, missingCondition: "Original critical evidence missing", boundaries: [{ status: "unresolved" }] })), consumer: { activationConditions: ["Original audit remains blocked"] } } }, { output: { phase: "semantic-scope-check" } }];
  const inventory = { graphHash: h("graph"), roots: ["entity-resolution/old"], closureIssues: [], sourcePages: [0, 2], candidateIds: ["role-old", "role-new"], originalQuestionIds: questionIds,
    consumers: ["event/consumer", "staged-role/role-old"].map(ref => ({ ref, revisionHash: h(ref), payload: { id: ref }, reason: "typed-consumer" as const, dependencies: [] })) };
  const intent = identityIntentSchema.parse({ version: 1, policy: "independent-identity-requirements/v1", taskId, revisionHash: h("76-to-78"), sourceId: "src", sourceHash: h("source"), parentStateHash: h("BREAK"), originalPlanHash: h("original-plan"), originalBudgetHash: h("original-budget"), authorizationRef: "User authorized new independent identity requirements, not old retries",
    semanticRecordHashes: semantic.map(h), retainedConditionsHash: h({ questions: semantic[0].output.questions, consumer: semantic[0].output.consumer }), catalogHash: h("catalog"), inventoryHash: h(inventory), requiredSourceSegmentIds: ["seg"], targets,
    consumerShards: inventory.consumers.map((c, index) => ({ index, refs: [c.ref] })), requirementPrefix: { length: 3111, head: h("requirements") }, upstreamPrefix: { length: 125, head: h("upstream") }, priorUsage: { modelCalls: 143, totalPayloadBytes: 12000, budgetFilesHash: h("143 prior calls with correction inherited once") } });
  const records: IdentityRecord[] = [];
  const common = { intentHash: h(intent), retainedConditionsHash: intent.retainedConditionsHash };
  for (const { stage, phase, shard } of identityStages(intent)) {
    const reqs = targets.map(t => ({ id: t.requirementId, mentionId: t.mentionId, questionIds: t.questionIds, requirement: "Represent only source-supported uncertainty", acceptanceCriteria: ["No unsupported stable identity"], disposition: "uncertainty-preservation", requiredStatus: "unresolved", missingCondition: "", evidence }));
    const judgments = reqs.map(r => ({ id: r.id, verdict: "supported", rationale: "Fresh independent evidence check", evidence }));
    const consumers = inventory.consumers.filter(c => intent.consumerShards[shard ?? -1]?.refs.includes(c.ref));
    const output: any = phase === "identity-definition" ? { ...common, phase, requirements: reqs }
      : phase === "identity-definition-check" ? { ...common, phase, proposalHash: h(records.at(-1)!.output), judgments }
        : phase === "identity-consumers" ? { ...common, phase, shard, definitionHash: h(records[0]!.output), inventoryHash: h(inventory), bindings: targets.map((t, i) => ({ requirementId: t.requirementId, slot: t.slot, payloadHash: h(JSON.parse(operations[i]!.payloadJson)), dependencyRefs: [`entity-mention:${t.mentionId}`], verdict: "supported", rationale: "Exact typed dependency", missingCondition: "", evidence })),
          consumers: consumers.map(c => ({ ref: c.ref, revisionHash: c.revisionHash, disposition: "revalidate-required", rationale: "Transitive identity consumer", requiredAction: "Keep blocked pending independent revalidation" })), candidateIds: inventory.candidateIds, sourcePages: inventory.sourcePages, originalQuestionIds: questionIds, activationConditions: ["Keep original budget and unresolved questions"], parentResumeAllowed: false, renewConsumedGrant: false, evidence }
          : { ...common, phase, shard, proposalHash: h(records.at(-1)!.output), inventoryHash: h(inventory), judgments, consumers: consumers.map(c => ({ ref: c.ref, verdict: "supported", rationale: "Independent consumer review" })), denominatorVerdict: "supported", denominatorRationale: "Entire frozen shard and denominator retained" };
    records.push({ intent, phase, stage, output, inputHash: h(stage), evidence: [{ selector: evidence[0]!, anchor: textAnchorForByteRange("src", Buffer.from("Ada waits."), 0, 10) }], traceRunId: `run-${stage}`, sessionId: `session-${stage}`, provider: "openai-codex", model: "gpt-6.1-sol", subscription: true, predecessorRecordHash: records.length ? h(records.at(-1)) : null } as IdentityRecord);
  }
  const p: any = { intent, inventory, semantic, review: { upstream: { receiptFingerprint: h("source receipt") } }, manifest: { segments: [{ id: "seg" }] }, prerequisites: [{ output: { phase: "specification", requirements: [{ requirement: "Independent original source requirement" }] } }], representations: [{ output: { phase: "representation-plan", boundaries: [{ status: "unresolved" }] } }],
    catalog: [...targets.map(t => ({ kind: "entity-mention", id: t.mentionId, revisionHash: t.mentionHash, payload: { id: t.mentionId } })), { kind: "canonical-event", id: "hidden-outcome", revisionHash: h("outcome"), payload: { text: "SECRET_CANDIDATE_OUTCOME" } }] };
  return { p, records, intent, semantic, inventory };
}
const rechain = (records: IdentityRecord[]) => { for (let i = 1; i < records.length; i++) { records[i]!.predecessorRecordHash = h(records[i - 1]); if ("proposalHash" in records[i]!.output) (records[i]!.output as any).proposalHash = h(records[i - 1]!.output); } };

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
