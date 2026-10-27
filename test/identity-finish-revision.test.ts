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
