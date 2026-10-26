import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { contentHash as h } from "../src/world/canonical.js";
import { mockPiProvider } from "./helpers/pi-provider.js";
import { createIdentityUpstreamStageRunner } from "../src/workflow/identity-consumer-upstream.js";
import { runIdentityUpstreamCorrection } from "../src/workflow/identity-upstream-correction.js";
import { identityCorrectionIntentSchema, validateIdentityEvidenceCorrection, identityUpstreamBudgetStages,
  IDENTITY_CORRECTION_LIMITS, IDENTITY_CORRECTION_STAGE } from "../src/compiler/identity-upstream-correction-model.js";
import * as correction from "../src/compiler/identity-upstream-correction.js";
import * as acceptance from "../src/compiler/identity-requirement-acceptance.js";
import * as staging from "../src/compiler/upstream-repair-staging.js";
import { UpstreamRepairLedger } from "../src/compiler/upstream-repair-ledger.js";
import { inheritConsumerRevalidationBudgets } from "../src/compiler/identity-consumer-revalidation.js";
import { TraceStore } from "../src/trace/store.js";
import { LocalFileWorkspace } from "../src/workspace/local-files.js";
import { identityUpstreamSessionContract } from "../src/compiler/identity-upstream-session.js";
import { verifyFailedIdentitySession } from "../src/compiler/identity-session-integrity.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const write = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value));
function fixture() {
  const failed = { proposal_id: "same-proposal", payload: { readerSetup: "Ada waits.", checkpoint: { kind: "source-position" } },
    evidence_segment_ids: ["seg"], evidence_selectors: [{ segment_id: "seg", exact: "Ada waits.", target_path: "/readerContext/facts/0" }] };
  const context = { plan: { planHash: h("same-plan") }, evidence: [{ segmentId: "seg", text: "Ada waits." }], stagedDependencies: [{ ref: "entity:ada", payload: { id: "ada" } }] };
  const contract = { originalArgumentSchema: {}, originalToolGuidelines: ["Bind exact summary fields"] };
  const intent = identityCorrectionIntentSchema.parse({ version: 1, policy: "initial-world-field-evidence-correction/v1", planHash: h("same-plan"),
    taskId: h("same-task"), target: { kind: "initial-world", id: "singleton" }, failedAttemptRef: h("failed"), failedSessionRef: h("failed-pi"),
    proposalId: failed.proposal_id, authorizationRef: "user accepted bounded correction", originalBudgetHash: h("original-budget"), originHash: h("origin"),
    priorUsage: { modelCalls: 221, totalPayloadBytes: 52724172 }, limits: IDENTITY_CORRECTION_LIMITS, failureRecordHash: h("failure-record"),
    originalInputHash: h(failed), contextHash: h(context), toolContractHash: h(contract), traceHash: h("failed-trace"),
    ledgerPrefix: { length: 4, head: h("ledger-head") }, retainedFiles: [{ path: "singleton.failure.json", hash: h("old failure") }] });
  const proposed = { ...failed, evidence_selectors: [{ ...failed.evidence_selectors[0], target_path: "/readerContext/facts/0/summary" }] };
  const plan: any = { planHash: intent.planHash, sourceScope: { sourceId: "src" }, identityRequirements: { taskId: intent.taskId } };
  const input = { intent, failedProposal: failed, diagnostic: "MISSING_OPENING_FIELD_EVIDENCE", context, ...contract };
  return { failed, proposed, plan, input, intent };
}

it("keeps the original payload, proposal identity and source scope while allowing a Pi-authored evidence correction", () => {
  const f = fixture(); expect(validateIdentityEvidenceCorrection(f.failed, f.proposed)).toEqual(f.proposed);
  for (const changed of [f.failed, { ...f.proposed, proposal_id: "new" }, { ...f.proposed, payload: { ...f.proposed.payload, readerSetup: "Invented" } },
    { ...f.proposed, evidence_segment_ids: ["other"] }, { ...f.proposed, extra: "unscoped" }])
    expect(() => validateIdentityEvidenceCorrection(f.failed, changed)).toThrow();
});

it("inherits the exhausted slot, additional correction and independent acceptance exactly once", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-correction-budget-")); roots.push(root);
  const upstream = path.join(root, "upstream"), reviews = path.join(root, "reviews"); await fs.mkdir(upstream);
  const f = fixture(), originalBudgetHash = f.intent.originalBudgetHash;
  await write(path.join(upstream, "start.json"), { order: [{ id: "ada" }, { id: "singleton" }], origin: { originalBudgetHash, priorUsage: { modelCalls: 216, totalPayloadBytes: 1000 } } });
  await write(path.join(upstream, "correction.intent.json"), f.intent); await write(path.join(upstream, "correction.proof.json"), { retained: "sealed Pi" });
  for (const [stage, calls] of [["ada", 1], ["singleton", 4], [IDENTITY_CORRECTION_STAGE, 2], ["acceptance", 2]] as const)
    await write(path.join(upstream, `${stage}.budget.json`), { originalBudgetHash, state: { usage: { modelCalls: calls, totalPayloadBytes: calls * 100 } } });
  expect(await identityUpstreamBudgetStages(upstream, [{ id: "ada" }, { id: "singleton" }])).toEqual(["ada", "singleton", IDENTITY_CORRECTION_STAGE, "acceptance"]);
  await expect(identityUpstreamBudgetStages(upstream, [{ id: "singleton" }, { id: "ada" }])).rejects.toThrow(/final slot/);
  const inherited = await inheritConsumerRevalidationBudgets(upstream, reviews);
  expect(inherited.priorUsage).toEqual({ modelCalls: 225, totalPayloadBytes: 1900 });
  expect(inherited.priorBudgetFiles.filter(f => f.path.endsWith(".budget.json"))).toHaveLength(4);
  expect(await inheritConsumerRevalidationBudgets(upstream, reviews)).toEqual(inherited);
});

it("proves all four actual failed Pi calls without manufacturing a success checkpoint or reopening the exhausted slot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-correction-failed-pi-")); roots.push(root);
  const f = fixture(), contract = identityUpstreamSessionContract("initial-world"), prompt = { task: "Synthetic failed slot" };
  const originalCreate = PiAgentSession.create.bind(PiAgentSession); let provider: Awaited<ReturnType<typeof mockPiProvider>> | undefined;
  const dispatch = vi.spyOn(PiAgentSession, "create").mockImplementation(async options => {
    const session = await originalCreate({ ...options, model: undefined, piAgentDir: path.join(root, "pi") });
    provider = await mockPiProvider(session, { provider: "openai-codex", modelId: "gpt-6.1-sol", response: (_context, index) => {
      if (index > 3) throw Error("Exhausted original slot replayed");
      return index === 3 ? fauxAssistantMessage("Stop after failed correction", { stopReason: "stop" })
        : fauxAssistantMessage([index === 1 ? fauxToolCall("read_upstream_repair_context", {}, { id: "read" })
          : fauxToolCall("propose_initial_world", { proposal_json: JSON.stringify(index === 0 ? { ...f.failed, first: true } : f.failed) }, { id: `attempt-${index}` })], { stopReason: "toolUse" });
    } }); return session;
  });
  const runner = createIdentityUpstreamStageRunner({ root, sourceId: "src", taskId: f.intent.taskId, plan: f.plan, directory: root,
    originalBudgetHash: f.intent.originalBudgetHash, origin: "origin", assertOriginal: async () => {}, cumulative: async () => ({ modelCalls: 217, totalPayloadBytes: 1000 }), publish: async () => {} });
  const run = () => runner("singleton", contract, { target: f.intent.target }, IDENTITY_CORRECTION_LIMITS, async (factory, trace, budget) => {
    const session = await factory({ workspace: await LocalFileWorkspace.create(root), model: "openai-codex/gpt-6.1-sol", requestBudget: budget,
      includeProjectInstructions: false, includeLocalTools: false, includeNwhExtension: false, trackLastOpenedSession: false, interactionMode: "compiler",
      trace: { parent: trace.rootContext, invocationName: "singleton", parts: [] }, additionalTools: [
        defineTool({ name: "read_upstream_repair_context", label: "Read fixture", description: "Read exact synthetic context", parameters: Type.Object({}),
          async execute() { return { content: [{ type: "text", text: JSON.stringify({ evidence: "Ada waits." }) }], details: {} }; } }),
        defineTool({ name: "propose_initial_world", label: "Fail fixture", description: "Synthetic retained validation failure", parameters: Type.Object({ proposal_json: Type.String() }),
          async execute() { throw Error("Missing exact summary evidence"); } }),
      ] }); await session.promptWithReport(JSON.stringify(prompt));
  });
  await expect(run()).rejects.toThrow(/terminal submission receipt/);
  const failure = JSON.parse(await fs.readFile(path.join(root, "singleton.failure.json"), "utf8")), messages = await fs.readFile(path.join(root, "singleton.messages.jsonl"), "utf8");
  const proof = verifyFailedIdentitySession(await fs.readFile(failure.sessionFile, "utf8"), root,
    { sessionId: failure.sessionId, provider: "openai-codex", model: "gpt-6.1-sol", output: { proposal_json: JSON.stringify(f.failed) } }, JSON.stringify(prompt),
    await fs.readFile(path.join(root, "singleton.requests.jsonl"), "utf8"), messages, contract);
  expect(proof.transcript.responses).toBe(4); expect(proof.payloads).toHaveLength(4); expect(failure.usage.usage.modelCalls).toBe(4);
  await expect(fs.stat(path.join(root, "singleton.session-checkpoint.json"))).rejects.toThrow();
  await expect(run()).rejects.toThrow(/consumed/); expect(dispatch).toHaveBeenCalledTimes(1); expect(provider?.contexts).toHaveLength(4);
  expect(() => verifyFailedIdentitySession(messages, root, { sessionId: failure.sessionId, provider: "openai-codex", model: "gpt-6.1-sol", output: {} }, "", "", "", contract)).toThrow();
});

it("seals an actual Pi correction, resumes host staging after interruption without replay, and rejects tampered provenance", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-correction-pi-")); roots.push(root);
  const directory = path.join(root, "upstream"); await fs.mkdir(directory);
  const f = fixture(), failedAttempt = { attemptRef: f.intent.failedAttemptRef, failed: true, staged: false, started: { planHash: f.plan.planHash,
    modelSessionRef: f.intent.failedSessionRef, proposalId: f.intent.proposalId, inputHash: h(f.failed), toolInput: f.failed } };
  const failureRecord = { hash: h("ledger-head"), payload: { kind: "attempt-failed", attemptRef: f.intent.failedAttemptRef } };
  f.input.diagnostic = failureRecord.payload as any;
  const state: any = { plans: [{ plan: f.plan, state: "needs-host-review", hostCorrections: [] }], attempts: [failedAttempt], records: [{ payload: {} }, { payload: {} }, { payload: {} }, failureRecord],
    modelSessions: [{ sessionRef: f.intent.failedSessionRef, closed: true, chargedFailure: false }] };
  await write(path.join(directory, "singleton.failure.json"), { sessionId: "old-pi", error: "original evidence failure" });
  const origin = { originalBudgetHash: f.intent.originalBudgetHash };
  f.intent.originHash = h(origin);
  await write(path.join(directory, "start.json"), { plan: f.plan, origin });
  await write(path.join(directory, "singleton.budget.json"), { usage: { modelCalls: 4 }, originHash: h(origin), originalBudgetHash: f.intent.originalBudgetHash, cumulative: f.intent.priorUsage });
  f.intent.retainedFiles = await Promise.all(["singleton.failure.json", "singleton.budget.json"].map(async file => ({ path: file, hash: h(await fs.readFile(path.join(directory, file), "utf8")) })));
  f.intent.failureRecordHash = h(failureRecord);
  const oldRun: any = { id: "original-failed-run", operationId: `identity-upstream-${f.intent.taskId}-singleton`, status: "failed" };
  f.intent.traceHash = h({ run: oldRun, events: [] });
  vi.spyOn(TraceStore.prototype, "peekRuns").mockResolvedValue([oldRun]);
  const peekEvents = TraceStore.prototype.peekEvents;
  vi.spyOn(TraceStore.prototype, "peekEvents").mockImplementation(function (id, ...args) { return id === oldRun.id ? Promise.resolve([]) : peekEvents.call(this, id, ...args); });
  await write(path.join(directory, "correction.intent.json"), f.intent);
  // Historical task admission and persistence are fixtures. The Pi tools,
  // complete transcript, provider request journal, trace and correction proof
  // verifier below run unchanged; no real source or provider is used.
  vi.spyOn(correction, "identityCorrectionInput").mockResolvedValue(f.input as any);
  vi.spyOn(acceptance, "verifyInvocationBudget").mockImplementation(async () => ({ correctionIntentHash: h(f.intent) }));
  vi.spyOn(UpstreamRepairLedger.prototype, "inspect").mockResolvedValue(state);
  const grant = vi.spyOn(UpstreamRepairLedger.prototype, "authorizeHostCorrection").mockImplementation(async (_planHash, authority) => {
    state.plans[0].hostCorrections.push(authority); state.plans[0].state = "staging";
  });
  const stage = vi.spyOn(staging, "stageUpstreamRepair").mockRejectedValueOnce(Error("interrupted before original host reservation"));
  const create = PiAgentSession.create.bind(PiAgentSession);
  let provider: Awaited<ReturnType<typeof mockPiProvider>> | undefined;
  const dispatch = vi.spyOn(PiAgentSession, "create").mockImplementation(async options => {
    const session = await create({ ...options, model: undefined, piAgentDir: path.join(root, "pi") });
    provider = await mockPiProvider(session, { provider: "openai-codex", modelId: "gpt-6.1-sol", response: (_context, index) => {
      if (index > 1) throw Error("Unexpected replay");
      return fauxAssistantMessage([index === 0 ? fauxToolCall("read_identity_upstream_correction", {}, { id: "read" })
        : fauxToolCall("submit_identity_upstream_correction", { proposal_json: JSON.stringify(f.proposed) }, { id: "submit" })], { stopReason: "toolUse" });
    } }); return session;
  });
  const runner = createIdentityUpstreamStageRunner({ root, sourceId: "src", taskId: f.intent.taskId, plan: f.plan, directory,
    originalBudgetHash: f.intent.originalBudgetHash, origin: "origin", assertOriginal: async () => {}, cumulative: async () => f.intent.priorUsage, publish: async () => {} });
  await expect(runIdentityUpstreamCorrection(root, f.plan, directory, f.intent, runner)).rejects.toThrow(/interrupted/);
  expect(dispatch).toHaveBeenCalledTimes(1); expect(provider?.contexts).toHaveLength(2); expect(grant).toHaveBeenCalledTimes(1);
  const proof = await correction.verifyIdentityCorrectionProof(root, f.plan, directory);
  expect(proof.proposal).toEqual(f.proposed);
  const budget = JSON.parse(await fs.readFile(path.join(directory, `${IDENTITY_CORRECTION_STAGE}.budget.json`), "utf8"));
  expect(budget.priorUsage).toEqual(f.intent.priorUsage); expect(budget.cumulative.modelCalls).toBe(223);
  stage.mockImplementationOnce(async (_root, _source, _plan, target, raw) => {
    expect(raw).toEqual(f.proposed); expect(target).toEqual(f.intent.target);
    state.attempts.push({ attemptRef: h("corrected-attempt"), staged: true, failed: false, validatedHash: h(f.proposed.payload),
      started: { planHash: f.plan.planHash, artifactKind: target.kind, artifactId: target.id, proposalId: f.intent.proposalId, inputHash: h(raw), toolInput: raw } });
    state.records.push({ payload: { kind: "attempt-staged", attemptRef: h("corrected-attempt"), proposalHash: h("staged-envelope") } });
    return { attemptRef: h("corrected-attempt"), proposalId: f.intent.proposalId, proposalHash: h("staged-envelope") } as any;
  });
  const record = await runIdentityUpstreamCorrection(root, f.plan, directory, f.intent, runner);
  await expect(correction.verifyIdentityCorrectedSlot(root, f.plan, directory, record)).resolves.toBeUndefined();
  expect(dispatch).toHaveBeenCalledTimes(1); expect(grant).toHaveBeenCalledTimes(1);
  await expect(correction.verifyIdentityCorrectedSlot(root, f.plan, directory, { ...record, sessionRef: h("fabricated-model-reservation") })).rejects.toThrow(/detached/);
  state.attempts[1].started.modelSessionRef = f.intent.failedSessionRef;
  await expect(correction.verifyIdentityCorrectedSlot(root, f.plan, directory, record)).rejects.toThrow(/detached/);
  delete state.attempts[1].started.modelSessionRef;
  const messagesFile = path.join(directory, `${IDENTITY_CORRECTION_STAGE}.messages.jsonl`), original = await fs.readFile(messagesFile, "utf8");
  await fs.writeFile(messagesFile, original.replace("Ada waits.", "Changed evidence."));
  await expect(correction.verifyIdentityCorrectionProof(root, f.plan, directory)).rejects.toThrow(/changed/);
  await fs.writeFile(messagesFile, original);
  await write(path.join(directory, "singleton.budget.json"), { usage: { modelCalls: 0 }, original: true });
  await expect(runIdentityUpstreamCorrection(root, f.plan, directory, f.intent, runner)).rejects.toThrow(/Original failed slot/);
  expect(dispatch).toHaveBeenCalledTimes(1);
});
