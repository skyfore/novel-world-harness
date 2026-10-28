import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { contentHash as h } from "../src/world/canonical.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { mockPiProvider } from "./helpers/pi-provider.js";
import { createIdentityUpstreamStageRunner } from "../src/workflow/identity-consumer-upstream.js";
import { runIdentityFinishRevision } from "../src/workflow/identity-finish-revision.js";
import * as revision from "../src/compiler/identity-finish-revision.js";
import * as finishRevision from "../src/compiler/upstream-repair-finish-revision.js";
import * as acceptance from "../src/compiler/identity-requirement-acceptance.js";
import { UpstreamRepairLedger, upstreamRepairFinishGraphHash } from "../src/compiler/upstream-repair-ledger.js";
import { finishRevisionSemanticInputHash } from "../src/compiler/upstream-repair-finish-revision-intent.js";
import { identityUpstreamBudgetStages } from "../src/compiler/identity-upstream-correction-model.js";
import { inheritConsumerRevalidationBudgets } from "../src/compiler/identity-consumer-revalidation.js";
import * as contractRecovery from "../src/compiler/identity-finish-contract-recovery.js";
import * as evidenceRecovery from "../src/compiler/identity-acceptance-evidence-recovery.js";
import { ProposalStore } from "../src/world/canonical-model.js";
import { TraceStore } from "../src/trace/store.js";
import { captureRecordTree } from "../src/runtime/compile-loop/dedicated-session.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const write = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value));

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-opening-revision-")); roots.push(root);
  const text = "Ada plans to wait.", source = await createEvidenceFixture(root, text), taskId = h("original task");
  const before = { proposal_id: "original-opening", payload: { version: 1, delta: { version: 1, operations: [
    { op: "set", entityId: "ada", field: "character.alive", value: true }] } },
    evidence_segment_ids: [source.segmentId], evidence_selectors: [{ segment_id: source.segmentId, exact: text, target_path: "/delta" }] };
  const plan: any = { planHash: h("original plan"), batchId: "original-batch", requirementSetHash: h("original requirements"),
    sourceScope: { sourceId: source.source.id, sourceSha256: source.source.contentSha256, segmentIds: [source.segmentId] },
    identityRequirements: { taskId, consumerRevalidation: { id: h("original revalidation") } },
    allowedWrites: [{ kind: "initial-world", id: "singleton", pointers: ["/delta"] }], allowedCreations: [],
    baselineRefs: [{ kind: "initial-world", id: "singleton", revisionHash: h(before.payload) }], readableRefs: [{ kind: "initial-world", id: "singleton" }],
    dependencyEdges: [{ from: "requirement:original", to: "initial-world:singleton", purpose: "requirement" }] };
  const directory = acceptance.identityUpstreamDirectory(root, plan); await fs.mkdir(directory, { recursive: true });
  const attempt: any = { attemptRef: h("original attempt"), staged: true, started: { planHash: plan.planHash, inputHash: h(before), toolInput: before } };
  const original: any = { intentHash: h("original finish"), input: { outcome: "complete" }, baselines: [], proposals: [{
    artifactKind: "initial-world", artifactId: "singleton", proposalId: before.proposal_id, attemptRef: attempt.attemptRef, proposalHash: h("envelope"), payloadHash: h(before.payload) }] };
  const stop = { hash: h("original stop"), payload: { kind: "needs-host-review", planHash: plan.planHash, reason: "INACTIONABLE_INITIAL_WORLD" } };
  const state: any = { plans: [{ plan, state: "needs-host-review", originalFinishIntent: original, finishIntent: original }], attempts: [attempt], records: [stop] };
  const authority: any = { version: 1, sourceId: source.source.id, planHash: plan.planHash, batchId: plan.batchId,
    failedFinishRef: stop.hash, failureReason: stop.payload.reason, originalIntentHash: original.intentHash,
    originalGraphHash: upstreamRepairFinishGraphHash(plan, original, new Map([[attempt.attemptRef, attempt]])), sourceScope: plan.sourceScope, finishInput: original.input,
    slots: [{ artifactKind: "initial-world", artifactId: "singleton", originalAttemptRef: attempt.attemptRef, originalProposalId: before.proposal_id,
      originalInputHash: h(before), semanticInputHash: finishRevisionSemanticInputHash(before), toolInput: before, dependencies: [] }] };
  const originalBudgetHash = h("original budget");
  await write(path.join(directory, "start.json"), { plan, order: [{ id: "singleton" }], origin: { originalBudgetHash, priorUsage: { modelCalls: 200, totalPayloadBytes: 1000 } } });
  for (const stage of ["singleton", "acceptance"]) await write(path.join(directory, `${stage}.budget.json`), {
    originalBudgetHash, state: { usage: { modelCalls: 2, totalPayloadBytes: 1000 } } });
  await write(path.join(directory, "acceptance.record.json"), { sessionId: "original-reviewer", traceRunId: "original-trace" });
  vi.spyOn(UpstreamRepairLedger.prototype, "inspect").mockResolvedValue(state);
  vi.spyOn(finishRevision, "inspectUpstreamRepairFinishRevisionAuthority").mockResolvedValue(authority);
  const historicalReview = vi.spyOn(acceptance, "verifyIdentityUpstreamAcceptance").mockResolvedValue({ sessionId: "original-reviewer" } as any);
  const request = { failedFinishRef: stop.hash, authorizationRef: "user:scoped-repair" };
  return { root, directory, plan, state, before, text, source, authority, originalBudgetHash, request, historicalReview };
}

it("admits requirement edges, retains the original review allowance and rejects writable descendants or no-op drafts", async () => {
  const f = await fixture(), intent = await revision.prepareIdentityFinishRevision(f.root, f.plan, f.directory, f.request);
  expect(f.historicalReview).toHaveBeenCalledWith(f.root, f.plan, true);
  expect(intent.acceptanceLimits).toEqual({ maxModelCalls: 22, maxRequestBytes: 512000, maxTotalPayloadBytes: 12287000 });
  await expect(revision.prepareIdentityFinishRevision(f.root, f.plan, f.directory, { ...f.request, failedFinishRef: h("guessed") })).rejects.toThrow(/currentStop.recordRef/);
  const originalEdges = f.plan.dependencyEdges;
  f.plan.allowedWrites.push({ kind: "entity", id: "ada", pointers: ["/identityConsumption"] });
  f.plan.dependencyEdges = [...originalEdges, { from: "entity:ada", to: "initial-world:singleton", purpose: "dependency" }];
  await expect(revision.prepareIdentityFinishRevision(f.root, f.plan, f.directory, f.request)).rejects.toThrow(/no writable descendants/);
  const proposed = { ...f.before, proposal_id: intent.proposalId, payload: { ...f.before.payload, delta: { ...f.before.payload.delta,
    operations: [...f.before.payload.delta.operations, { op: "set", entityId: "ada", field: "character.plan", value: "wait" }] } } };
  expect(revision.validateIdentityFinishRevisionDraft(intent, proposed)).toEqual(proposed);
  for (const invalid of [{ ...proposed, payload: f.before.payload }, { ...proposed, proposal_id: "renamed" }, { ...proposed, evidence_segment_ids: ["guessed"] }])
    expect(() => revision.validateIdentityFinishRevisionDraft(intent, invalid)).toThrow(/no unchanged/);
});

it("seals actual Pi source reads and draft, resumes host revision without replay, and requires a new graph review", async () => {
  const f = await fixture(), intent = await revision.prepareIdentityFinishRevision(f.root, f.plan, f.directory, f.request);
  f.historicalReview.mockRestore();
  await write(path.join(f.directory, "finish-revision.intent.json"), intent);
  const context = { intent, writableFields: ["/delta"], originalToolSchema: {}, originalToolGuidelines: [],
    dependencies: [{ ref: "initial-world:singleton", payload: f.before.payload }], source: [{ segmentId: f.source.segmentId, text: f.text, complete: true }] };
  const proposed = { ...f.before, proposal_id: intent.proposalId, payload: { ...f.before.payload, delta: { ...f.before.payload.delta,
    operations: [...f.before.payload.delta.operations, { op: "set", entityId: "ada", field: "character.plan", value: "wait" }] } } };
  // Historical admission and host persistence are fixtures. Actual Pi tools,
  // durable session, read receipts, source bytes, journal and proof verifier run.
  vi.spyOn(revision, "identityFinishRevisionContext").mockResolvedValue(context);
  vi.spyOn(acceptance, "verifyInvocationBudget").mockResolvedValue({ finishRevisionIntentHash: h(intent) });
  const grant = vi.spyOn(finishRevision, "authorizeUpstreamRepairFinishRevision").mockImplementation(async (_root, _source, _plan, input) => {
    f.state.plans[0].finishRevision = { intent: { ...input, revisionHash: h(input) }, completed: false };
    f.state.plans[0].state = "finish-revising"; return f.state.plans[0].finishRevision.intent;
  });
  const stage = vi.spyOn(finishRevision, "continueUpstreamRepairFinishRevision").mockRejectedValueOnce(Error("interrupted host staging"));
  const create = PiAgentSession.create.bind(PiAgentSession); let calls = 0;
  const dispatch = vi.spyOn(PiAgentSession, "create").mockImplementation(async options => {
    const session = await create({ ...options, model: undefined, piAgentDir: path.join(f.root, "pi") });
    await mockPiProvider(session, { provider: "openai-codex", modelId: "gpt-6.1-sol", response: (_context, index) => {
      if (++calls > 2) throw Error("Unexpected replay");
      return fauxAssistantMessage([index === 0 ? fauxToolCall("read_identity_finish_revision", {}, { id: "read" })
        : fauxToolCall("submit_identity_finish_revision", { proposal_json: JSON.stringify(proposed) }, { id: "submit" })], { stopReason: "toolUse" });
    } }); return session;
  });
  const runner = createIdentityUpstreamStageRunner({ root: f.root, sourceId: f.source.source.id, taskId: intent.taskId, plan: f.plan, directory: f.directory,
    originalBudgetHash: f.originalBudgetHash, origin: {}, assertOriginal: async () => {}, cumulative: async () => ({ modelCalls: 204, totalPayloadBytes: 3000 }), publish: async () => {} });
  await expect(runIdentityFinishRevision(f.root, f.plan, f.directory, intent, runner)).rejects.toThrow(/interrupted/);
  expect((await revision.verifyIdentityFinishRevisionProof(f.root, f.plan, f.directory)).proposal).toEqual(proposed);
  await expect(revision.identityAcceptanceStage(f.root, f.plan, f.directory)).rejects.toThrow(/completed exact/);
  stage.mockImplementationOnce(async () => { f.state.plans[0].finishRevision.completed = true; return {} as any; });
  await runIdentityFinishRevision(f.root, f.plan, f.directory, intent, runner);
  expect(dispatch).toHaveBeenCalledTimes(1); expect(grant).toHaveBeenCalledTimes(1); expect(calls).toBe(2);
  const selected = await revision.identityAcceptanceStage(f.root, f.plan, f.directory);
  expect(selected).toMatchObject({ stage: revision.FINISH_REVISION_ACCEPTANCE, limits: intent.acceptanceLimits });
  // Old acceptance cannot authorize the changed graph even though it exists.
  await expect(acceptance.verifyIdentityUpstreamAcceptance(f.root, f.plan)).rejects.toThrow(/finish-revision-acceptance.record.json/);
  const stages = await identityUpstreamBudgetStages(f.directory, [{ id: "singleton" }]);
  expect(stages).toEqual(["singleton", "acceptance", revision.FINISH_REVISION_DRAFT, revision.FINISH_REVISION_ACCEPTANCE]);
  const draftBudget = JSON.parse(await fs.readFile(path.join(f.directory, `${revision.FINISH_REVISION_DRAFT}.budget.json`), "utf8"));
  await write(path.join(f.directory, `${revision.FINISH_REVISION_ACCEPTANCE}.budget.json`), { originalBudgetHash: f.originalBudgetHash, state: { usage: { modelCalls: 2, totalPayloadBytes: 500 } } });
  const inherited = await inheritConsumerRevalidationBudgets(f.directory, path.join(f.root, "reviews"));
  expect(inherited.priorUsage).toEqual({ modelCalls: 208, totalPayloadBytes: 3500 + draftBudget.state.usage.totalPayloadBytes });
  const frozenContext = path.join(f.directory, `${revision.FINISH_REVISION_DRAFT}.context.json`);
  await write(frozenContext, { ...context, source: [{ ...context.source[0], text: "Invented source" }] });
  await expect(revision.verifyIdentityFinishRevisionProof(f.root, f.plan, f.directory)).rejects.toThrow(/exact original source bytes/);
  await write(frozenContext, context);
  await write(path.join(f.directory, "acceptance.budget.json"), { state: { usage: { modelCalls: 0, totalPayloadBytes: 0 } } });
  await expect(runIdentityFinishRevision(f.root, f.plan, f.directory, intent, runner)).rejects.toThrow(/retained proposal, review, session or budget/);
  expect(dispatch).toHaveBeenCalledTimes(1);
});

it("discovers a consumed no-proposal draft without implying a new grant, starting review or changing its records", async () => {
  const f = await fixture(), intent = await revision.prepareIdentityFinishRevision(f.root, f.plan, f.directory, f.request);
  await write(path.join(f.directory, "finish-revision.intent.json"), intent);
  const stage = revision.FINISH_REVISION_DRAFT;
  await write(path.join(f.directory, `${stage}.invocation.json`), { planHash: f.plan.planHash });
  await write(path.join(f.directory, `${stage}.budget.json`), { state: { usage: { modelCalls: 2, totalPayloadBytes: 500 } }, cumulative: { modelCalls: 206 } });
  expect(await revision.inspectIdentityFinishRevisionProgress(f.directory)).toMatchObject({ blocked: true, stages: [
    { stage, status: "unsettled" }, { stage: revision.FINISH_REVISION_ACCEPTANCE, status: "not-started" }] });
  await write(path.join(f.directory, `${stage}.failure.json`), { error: "No source-supported submitted correction; no redispatch" });
  const files = await fs.readdir(f.directory), before = await Promise.all(files.map(async file => h(await fs.readFile(path.join(f.directory, file), "utf8"))));
  expect(await revision.inspectIdentityFinishRevisionProgress(f.directory)).toMatchObject({ inspection: "recorded-only", blocked: true,
    resumeCondition: expect.stringContaining("No model redispatch"), stages: [
      { stage, status: "stopped", diagnostic: "No source-supported submitted correction; no redispatch", usage: { modelCalls: 2 },
        modelResponseFile: path.join(f.directory, `${stage}.messages.jsonl`) },
      { stage: revision.FINISH_REVISION_ACCEPTANCE, status: "not-started", usage: null }] });
  expect(await fs.readdir(f.directory)).toEqual(files);
  expect(await Promise.all(files.map(async file => h(await fs.readFile(path.join(f.directory, file), "utf8"))))).toEqual(before);
});

async function stoppedOpeningFixture(recoverySubmits = true) {
  const f = await fixture(), intent = await revision.prepareIdentityFinishRevision(f.root, f.plan, f.directory, f.request);
  await write(path.join(f.directory, "finish-revision.intent.json"), intent);
  const oldContext = { intent, writableFields: ["/delta"], originalToolSchema: {}, originalToolGuidelines: [],
    dependencies: [{ ref: "initial-world:singleton", payload: f.before.payload }], source: [{ segmentId: f.source.segmentId, text: f.text, complete: true }] };
  const context = { ...oldContext, originalToolSchema: { type: "object" },
    entryContractReview: { contractVersion: "entry-capability/v2", dispatch: "requires-existing-authority-and-source-review", gaps: [] } };
  const contextRead = vi.spyOn(revision, "identityFinishRevisionContext").mockResolvedValue(oldContext);
  vi.spyOn(acceptance, "verifyInvocationBudget").mockImplementation(async (_root, _plan, stage) =>
    JSON.parse(await fs.readFile(path.join(f.directory, `${stage}.invocation.json`), "utf8")));
  const proposed = { ...f.before, proposal_id: intent.proposalId, payload: { ...f.before.payload, delta: { ...f.before.payload.delta,
    operations: [...f.before.payload.delta.operations, { op: "set", entityId: "ada", field: "character.plan", value: "wait" }] } } };
  const create = PiAgentSession.create.bind(PiAgentSession); let sessions = 0, calls = 0;
  const dispatch = vi.spyOn(PiAgentSession, "create").mockImplementation(async options => {
    const recovered = ++sessions > 1;
    const session = await create({ ...options, model: undefined, piAgentDir: path.join(f.root, "pi") });
    await mockPiProvider(session, { provider: "openai-codex", modelId: "gpt-6.1-sol", response: (_context, index) => {
      calls++;
      if (index === 0) return fauxAssistantMessage([fauxToolCall("read_identity_finish_revision", {}, { id: "read" })], { stopReason: "toolUse" });
      if (!recovered || !recoverySubmits) return fauxAssistantMessage([{ type: "text", text: "The current contract does not support a correction; no proposal submitted." }], { stopReason: "stop" });
      return fauxAssistantMessage([fauxToolCall("submit_identity_finish_revision", { proposal_json: JSON.stringify(proposed) }, { id: "submit" })], { stopReason: "toolUse" });
    } }); return session;
  });
  const runner = createIdentityUpstreamStageRunner({ root: f.root, sourceId: f.source.source.id, taskId: intent.taskId, plan: f.plan, directory: f.directory,
    originalBudgetHash: f.originalBudgetHash, origin: {}, assertOriginal: async () => {}, cumulative: async () => {
      const usage = { modelCalls: 204, totalPayloadBytes: 3000 };
      for (const stage of [revision.FINISH_REVISION_DRAFT, contractRecovery.ENTRY_CONTRACT_RECOVERY_STAGE]) {
        const file = path.join(f.directory, `${stage}.budget.json`);
        try { const b = JSON.parse(await fs.readFile(file, "utf8")); usage.modelCalls += b.state.usage.modelCalls; usage.totalPayloadBytes += b.state.usage.totalPayloadBytes; }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      }
      return usage;
    }, publish: async () => {} });
  await expect(runIdentityFinishRevision(f.root, f.plan, f.directory, intent, runner)).rejects.toThrow(/no supported submitted correction/);
  contextRead.mockResolvedValue(context as any);
  const request = { previousContextHash: h(oldContext), authorizationRef: "user:explicit-contract-transition" };
  const prepare = () => contractRecovery.prepareIdentityEntryContractRecovery(f.root, f.plan, f.directory, request);
  return { ...f, intent, oldContext, context, contextRead, proposed, runner, request, prepare, dispatch, calls: () => calls };
}

it.each([false, true])("checks complete trace history for contract recovery, including an older duplicate: %s", async duplicate => {
  const f = await stoppedOpeningFixture(), expected = await f.prepare(), traces = new TraceStore(f.root);
  const original = await traces.peekRun(expected.traceRunId), originalTime = Date.parse(original.startedAt);
  // Keep a valid original outside the recent window, or keep it newest while
  // hiding an ambiguous older invocation beyond that window.
  if (duplicate) {
    const other = await traces.createRun({ kind: "prepare", sourceId: original.sourceId, operationId: original.operationId,
      startedAt: new Date(originalTime - 3000).toISOString() });
    await traces.finishRun(other.id, "failed", { endedAt: new Date(originalTime - 2500).toISOString() });
  }
  const foreign = await traces.createRun({ kind: "prepare", sourceId: "another-source", operationId: original.operationId });
  await traces.finishRun(foreign.id, "failed");
  const seed = await traces.createRun({ kind: "prepare", sourceId: original.sourceId, operationId: "unrelated-operation",
    startedAt: new Date(originalTime + (duplicate ? -2000 : 1000)).toISOString() });
  const later = await traces.finishRun(seed.id, "succeeded", { endedAt: new Date(Date.parse(seed.startedAt) + 100).toISOString() });
  const events = await traces.peekEvents(seed.id), index = JSON.parse(await fs.readFile(traces.indexPath, "utf8"));
  // Seed another 999 settled trace fixtures without paying for repeated index
  // rewrites. Recovery itself still reads the real on-disk index and manifests.
  for (let offset = 0; offset < 999; offset += 32) {
    await Promise.all(Array.from({ length: Math.min(32, 999 - offset) }, async (_, j) => {
      const id = `unrelated-${offset + j}`, rootSpanId = `span-${id}`;
      const relativePath = `runs/${later.startedAt.slice(0, 7)}/${id}`, directory = path.join(traces.root, relativePath);
      await fs.mkdir(directory, { recursive: true });
      await write(path.join(directory, "manifest.json"), { ...later, id, rootSpanId });
      await fs.writeFile(path.join(directory, "events.jsonl"), events.map(e => JSON.stringify({ ...e, runId: id, spanId: rootSpanId })).join("\n") + "\n");
      index.runs.push({ id, relativePath, startedAt: later.startedAt, kind: later.kind, status: later.status, sourceId: later.sourceId });
    }));
  }
  await write(traces.indexPath, index);
  const recent = await traces.peekRuns({ sourceId: original.sourceId, limit: 1000 });
  expect(recent.some(run => run.id === original.id)).toBe(duplicate);
  const before = captureRecordTree(traces.root), retained = captureRecordTree(f.directory);
  if (duplicate) await expect(f.prepare()).rejects.toThrow(/unique settled no-proposal Pi revision/);
  else await expect(f.prepare()).resolves.toEqual(expected);
  expect(captureRecordTree(traces.root)).toEqual(before);
  expect(captureRecordTree(f.directory)).toEqual(retained);
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  expect(f.calls()).toBe(2);
});

it("recovers a verified old-contract no-proposal session using only its remaining budget and a new graph review", async () => {
  const f = await stoppedOpeningFixture();
  await expect(runIdentityFinishRevision(f.root, f.plan, f.directory, f.intent, f.runner)).rejects.toThrow(/consumed/);
  const recovery = await f.prepare();
  const originals = await Promise.all(recovery.retainedFiles.map(async file => fs.readFile(path.join(f.directory, file.path), "utf8")));
  const oldBudget = JSON.parse(await fs.readFile(path.join(f.directory, `${revision.FINISH_REVISION_DRAFT}.budget.json`), "utf8"));
  expect(recovery.limits).toEqual({ maxModelCalls: 2, maxRequestBytes: 512000, maxTotalPayloadBytes: 2048000 - oldBudget.state.usage.totalPayloadBytes });
  expect(await contractRecovery.inspectEntryContractRecoveryCandidate(f.directory)).toMatchObject({ previousContextHash: h(f.oldContext), executionAuthority: false });
  await write(path.join(f.directory, `${contractRecovery.ENTRY_CONTRACT_RECOVERY_STAGE}.intent.json`), recovery);
  const grant = vi.spyOn(finishRevision, "authorizeUpstreamRepairFinishRevision").mockImplementation(async (_root, _source, _plan, input) => {
    f.state.plans[0].finishRevision = { intent: { ...input, revisionHash: h(input) }, completed: false };
    return f.state.plans[0].finishRevision.intent;
  });
  const finish = vi.spyOn(finishRevision, "continueUpstreamRepairFinishRevision").mockRejectedValueOnce(Error("host interrupted"));
  await expect(runIdentityFinishRevision(f.root, f.plan, f.directory, f.intent, f.runner)).rejects.toThrow(/host interrupted/);
  const verified = await revision.verifyIdentityFinishRevisionProof(f.root, f.plan, f.directory);
  expect(verified.proposal).toEqual(f.proposed); expect(verified.proof.contractRecoveryHash).toBe(h(recovery));
  finish.mockImplementationOnce(async () => { f.state.plans[0].finishRevision.completed = true; return {} as any; });
  await runIdentityFinishRevision(f.root, f.plan, f.directory, f.intent, f.runner);
  expect(f.dispatch).toHaveBeenCalledTimes(2); expect(f.calls()).toBe(4); expect(grant).toHaveBeenCalledTimes(1);
  expect(await Promise.all(recovery.retainedFiles.map(async file => fs.readFile(path.join(f.directory, file.path), "utf8")))).toEqual(originals);
  expect(await revision.identityAcceptanceStage(f.root, f.plan, f.directory)).toMatchObject({ stage: revision.FINISH_REVISION_ACCEPTANCE, limits: f.intent.acceptanceLimits });
  f.historicalReview.mockRestore();
  await expect(acceptance.verifyIdentityUpstreamAcceptance(f.root, f.plan)).rejects.toThrow(/finish-revision-acceptance.record.json/);
  const stages = await identityUpstreamBudgetStages(f.directory, [{ id: "singleton" }]);
  expect(stages).toEqual(["singleton", "acceptance", revision.FINISH_REVISION_DRAFT, contractRecovery.ENTRY_CONTRACT_RECOVERY_STAGE, revision.FINISH_REVISION_ACCEPTANCE]);
  await write(path.join(f.directory, `${revision.FINISH_REVISION_ACCEPTANCE}.budget.json`), { originalBudgetHash: f.originalBudgetHash, state: { usage: { modelCalls: 2, totalPayloadBytes: 500 } } });
  const newBudget = JSON.parse(await fs.readFile(path.join(f.directory, `${contractRecovery.ENTRY_CONTRACT_RECOVERY_STAGE}.budget.json`), "utf8"));
  expect(newBudget.priorUsage.modelCalls).toBe(206); expect(newBudget.cumulative.modelCalls).toBe(208);
  expect((await inheritConsumerRevalidationBudgets(f.directory, path.join(f.root, "reviews"))).priorUsage).toEqual({
    modelCalls: 210, totalPayloadBytes: 3500 + oldBudget.state.usage.totalPayloadBytes + newBudget.state.usage.totalPayloadBytes });
});

it("rejects implicit, unchanged, scope-expanded, exhausted or tampered contract recovery before dispatch", async () => {
  const f = await stoppedOpeningFixture();
  await expect(contractRecovery.prepareIdentityEntryContractRecovery(f.root, f.plan, f.directory, { ...f.request, authorizationRef: "" })).rejects.toThrow(/explicit authorization/);
  await expect(contractRecovery.prepareIdentityEntryContractRecovery(f.root, f.plan, f.directory, { ...f.request, previousContextHash: h("guess") })).rejects.toThrow(/previousContextHash/);
  f.contextRead.mockResolvedValue({ ...f.context, originalToolSchema: f.oldContext.originalToolSchema } as any);
  await expect(f.prepare()).rejects.toThrow(/changed entry contract/);
  f.contextRead.mockResolvedValue({ ...f.context, writableFields: ["/delta", "/time"] } as any);
  await expect(f.prepare()).rejects.toThrow(/writable scope/);
  f.contextRead.mockResolvedValue(f.context as any);
  expect(() => contractRecovery.remainingEntryRevisionLimits({ modelCalls: 3, totalPayloadBytes: 1000 })).toThrow(/insufficient/);
  const recovery = await f.prepare();
  await write(path.join(f.directory, `${contractRecovery.ENTRY_CONTRACT_RECOVERY_STAGE}.intent.json`), recovery);
  await expect(contractRecovery.prepareIdentityEntryContractRecovery(f.root, f.plan, f.directory, { ...f.request, authorizationRef: "renamed" })).rejects.toThrow(/already bound/);
  await write(path.join(f.directory, `${revision.FINISH_REVISION_DRAFT}.context.json`), { ...f.oldContext, source: [] });
  await expect(runIdentityFinishRevision(f.root, f.plan, f.directory, f.intent, f.runner)).rejects.toThrow(/retained failure/);
  expect(f.dispatch).toHaveBeenCalledTimes(1);
});

it("retains a failed contract recovery and refuses another invocation or independent acceptance", async () => {
  const f = await stoppedOpeningFixture(false), recovery = await f.prepare();
  await write(path.join(f.directory, `${contractRecovery.ENTRY_CONTRACT_RECOVERY_STAGE}.intent.json`), recovery);
  await expect(runIdentityFinishRevision(f.root, f.plan, f.directory, f.intent, f.runner)).rejects.toThrow(/no supported submitted correction/);
  await expect(runIdentityFinishRevision(f.root, f.plan, f.directory, f.intent, f.runner)).rejects.toThrow(/consumed/);
  expect(f.dispatch).toHaveBeenCalledTimes(2); expect(f.calls()).toBe(4);
  expect(await revision.inspectIdentityFinishRevisionProgress(f.directory)).toMatchObject({ blocked: true, contractRecoveryCandidate: null, stages: [
    { stage: revision.FINISH_REVISION_DRAFT, status: "stopped" },
    { stage: contractRecovery.ENTRY_CONTRACT_RECOVERY_STAGE, status: "stopped" },
    { stage: revision.FINISH_REVISION_ACCEPTANCE, status: "not-started" }] });
  await expect(fs.access(path.join(f.directory, `${revision.FINISH_REVISION_ACCEPTANCE}.invocation.json`))).rejects.toThrow();
});

it("supplies both exact entity field bindings to acceptance and rejects evidence from a different envelope", async () => {
  const f = await fixture();
  const envelope = { id: "entity-proposal", payload: { id: "ada", evidence: [] }, evidenceAssertions: [
    { target: { pointer: "/identityConsumption/mode" }, relation: "supports", strength: "explicit", anchor: { exact: f.text } },
    { target: { pointer: "/identityConsumption/referentScope" }, relation: "supports", strength: "explicit", anchor: { exact: f.text } },
  ] };
  vi.spyOn(ProposalStore.prototype, "readEnvelope").mockResolvedValue(envelope);
  const graph: any = [{ target: { kind: "entity", id: "ada" }, proposalId: envelope.id, proposalHash: h(envelope), payloadHash: h(envelope.payload), payload: envelope.payload }];
  expect(await acceptance.identityUpstreamEvidence(f.root, f.plan, graph)).toEqual([
    { target: graph[0].target, proposalId: envelope.id, proposalHash: h(envelope), evidenceAssertions: envelope.evidenceAssertions }]);
  envelope.evidenceAssertions.pop();
  await expect(acceptance.identityUpstreamEvidence(f.root, f.plan, graph)).rejects.toThrow(/exact staged envelope/);
});

it("exposes a sealed negative review as blocked and permits only one unchanged-graph evidence correction within remaining review allowance", async () => {
  const f = await stoppedOpeningFixture(), recovery = await f.prepare();
  await write(path.join(f.directory, `${contractRecovery.ENTRY_CONTRACT_RECOVERY_STAGE}.intent.json`), recovery);
  const graph: any = [{ target: { kind: "entity", id: "ada" }, proposalId: "original", proposalHash: h("envelope"), payloadHash: h("payload") }];
  const evidence = [{ target: graph[0].target, proposalId: "original", proposalHash: h("envelope"), evidenceAssertions: [{ target: { pointer: "/identityConsumption/mode" } }] }];
  const input: any = { graphHash: h(graph), staged: graph };
  const record: any = { inputHash: h(input), graphHash: h(graph), traceRunId: recovery.traceRunId, output: { judgments: [{ requirementId: "original", verdict: "blocked" }] } };
  vi.spyOn(acceptance, "verifyIdentityAcceptanceRejection").mockResolvedValue(record);
  vi.spyOn(acceptance, "identityUpstreamGraph").mockResolvedValue(graph);
  vi.spyOn(acceptance, "identityUpstreamEvidence").mockResolvedValue(evidence);
  const oldFailure = JSON.parse(await fs.readFile(path.join(f.directory, `${revision.FINISH_REVISION_DRAFT}.failure.json`), "utf8"));
  for (const suffix of ["record.json", "input.json", "proposal.json", "invocation.json", "budget.json", "session-checkpoint.json", "messages.jsonl", "requests.jsonl"])
    await write(path.join(f.directory, `${revision.FINISH_REVISION_ACCEPTANCE}.${suffix}`), suffix === "record.json" ? record : suffix === "input.json" ? input
      : suffix === "budget.json" ? { state: { usage: { modelCalls: 2, totalPayloadBytes: 500 } } }
      : suffix === "session-checkpoint.json" ? { sessionFile: oldFailure.sessionFile } : {});
  expect(await revision.inspectIdentityFinishRevisionProgress(f.directory)).toMatchObject({ blocked: true,
    acceptanceEvidenceRecoveryCandidate: { rejectedInputHash: record.inputHash, executionAuthority: false },
    stages: [{ status: "stopped" }, { status: "not-started" }, { status: "stopped", diagnostic: expect.stringContaining("Independent acceptance blocked") }] });
  const request = { rejectedInputHash: record.inputHash, authorizationRef: recovery.authorizationRef };
  const prepare = () => evidenceRecovery.prepareAcceptanceEvidenceRecovery(f.root, f.plan, f.directory, request);
  const admitted = await prepare();
  expect(admitted.limits).toEqual({ maxModelCalls: 20, maxRequestBytes: 512000, maxTotalPayloadBytes: f.intent.acceptanceLimits.maxTotalPayloadBytes - 500 });
  expect(admitted.evidenceHash).toBe(h(evidence));
  await write(path.join(f.directory, `${revision.FINISH_REVISION_ACCEPTANCE}.input.json`), { ...input, stagedEvidence: evidence });
  await expect(prepare()).rejects.toThrow(/omitted existing field evidence/);
  await write(path.join(f.directory, `${revision.FINISH_REVISION_ACCEPTANCE}.input.json`), input);
  await write(path.join(f.directory, `${evidenceRecovery.EVIDENCE_ACCEPTANCE_STAGE}.invocation.json`), {});
  await expect(prepare()).rejects.toThrow(/consumed/);
  await write(path.join(f.directory, `${evidenceRecovery.EVIDENCE_ACCEPTANCE_STAGE}.intent.json`), admitted);
  await write(path.join(f.directory, `${evidenceRecovery.EVIDENCE_ACCEPTANCE_STAGE}.failure.json`), { error: "still blocked" });
  expect(await revision.inspectIdentityFinishRevisionProgress(f.directory)).toMatchObject({ blocked: true, acceptanceEvidenceRecoveryCandidate: null,
    stages: [{ status: "stopped" }, { status: "not-started" }, { status: "stopped" }, { status: "stopped" }] });
  await write(path.join(f.directory, `${revision.FINISH_REVISION_ACCEPTANCE}.budget.json`), { state: { usage: { modelCalls: 0, totalPayloadBytes: 0 } } });
  await expect(evidenceRecovery.assertAcceptanceEvidenceRecovery(f.root, f.plan, f.directory, admitted)).rejects.toThrow(/retained negative review or budget/);
  expect(f.dispatch).toHaveBeenCalledTimes(1);
});
