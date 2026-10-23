import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { ensureSourceStructure } from "../src/compiler/structure.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { loadCurrentRoleRoster } from "../src/compiler/role-roster-tools.js";
import { RoleReviewWorkStore } from "../src/compiler/role-review-work.js";
import { inspectRetainedRoleReviewBudget, recoverRoleContextBudget, roleReviewBudget } from "../src/compiler/role-review-budget.js";
import { inspectRoleSourceContextContinuation, claimRoleSourceContextContinuation } from "../src/compiler/role-source-context-continuation.js";
import { runBoundedRoleReview, ROLE_WORK_LIMITS } from "../src/workflow/role-review-bounded.js";
import { TraceStore } from "../src/trace/store.js";
import { TraceRecorder } from "../src/trace/recorder.js";
import { worldStorageRoot } from "../src/world/paths.js";
import { withWorkspaceOperationLock } from "../src/util/workspace-lock.js";
import { contentHash } from "../src/world/canonical.js";
import { inspectCompilerStatus } from "../src/compiler/status.js";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { RequirementLedger } from "../src/compiler/requirement-ledger.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture(options: { recovered?: boolean; error?: string; pending?: boolean; proposal?: boolean; read?: boolean;
  toolFailure?: boolean; toolError?: boolean; missingResult?: boolean; orphanResult?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-source-context-")); roots.push(root);
  const f = await createEvidenceFixture(root, "Hero opens the door.\nFriend walks in.\n"); await ensureSourceStructure(root, f.source);
  await new CanonicalModelStore(root).putEntity({ id: "hero", canonicalName: "Hero", kind: "character", aliases: [], evidence: f.evidence("Hero") });
  const { roster, structure } = await loadCurrentRoleRoster(root, f.source.id), batchId = `role-roster-${f.source.id}-context`;
  const store = await RoleReviewWorkStore.open(root, { version: 1, sourceId: f.source.id, sourceHash: roster.sourceSha256,
    subjectHash: roster.subjectHash, batchId, structureHash: contentHash(structure),
    spans: [{ start: 0, end: 21 }, { start: 21, end: f.source.bytes }], legacyDraftHashes: [] });
  const workId = store.workId("source", 0), base = path.join(worldStorageRoot(root), "compiler", "role-review-work");
  await store.beginAttempt(workId); await store.beginAttempt(workId);
  const contextFile = path.join(base, "context", store.planHash, `${contentHash(workId)}.json`);
  const state = { version: 1, planHash: store.planHash, workId, packetHash: contentHash("original prompt"), accesses: [],
    handoffs: [{ generation: 1, accessCount: 1, bytes: 37000, phase: "context" }, { generation: 2, accessCount: 2, bytes: 48001, phase: "context" }] };
  await fs.mkdir(path.dirname(contextFile), { recursive: true });
  await fs.writeFile(contextFile, JSON.stringify({ state, hash: contentHash(state) }));
  const runIds: string[] = [];
  const trace = async (calls: number, error: string) => {
    const recorder = await TraceRecorder.start(new TraceStore(root), { kind: "prepare", sourceId: f.source.id, operationId: batchId });
    await recorder.record("validation.completed", { phase: "role-review-work", planHash: store.planHash, workId, limits: ROLE_WORK_LIMITS });
    for (let i = 0; i < calls; i++) await recorder.record("llm.request.started", {});
    if (options.read || options.pending || options.proposal || options.toolFailure || options.toolError || options.missingResult || options.orphanResult) {
      const context = { ...recorder.rootContext, toolCallId: "original-tool" };
      const toolName = options.proposal ? "propose_role_source_review" : "read_role_work_evidence";
      if (!options.orphanResult) await recorder.record("tool.call.started", { toolName }, context,
        { blobRef: await recorder.putBlob({ unitId: roster.unitIds[0] }) });
      if (!options.pending) await recorder.record(options.proposal || options.toolFailure ? "tool.call.failed" : "tool.call.completed", { toolName }, context,
        options.missingResult ? {} : { blobRef: await recorder.putBlob({ isError: options.toolError ?? options.toolFailure ?? false,
          content: [{ type: "text", text: "Retained evidence tool result" }] }) });
    }
    await recorder.finish("failed", {}, { code: "ROLE_REVIEW_WORK_FAILED", message: error, retryable: false });
    runIds.push(recorder.manifest.id); return recorder.manifest.id;
  };
  const charge = (calls: number) => {
    const budget = roleReviewBudget(root, store.planHash, workId, ROLE_WORK_LIMITS);
    for (let i = 0; i < calls; i++) { budget.beginCall({}); budget.admitPayload({ original: true }); }
    budget.close();
  };
  if (options.recovered) {
    charge(6);
    const error = "Error: Model request budget exhausted: request requires 49000 UTF-8 bytes. Legacy size gate.";
    const runId = await trace(6, error), prior = inspectRetainedRoleReviewBudget(root, store.planHash, workId);
    const record = JSON.parse(await fs.readFile(prior.file, "utf8")); record.state.blocked = true; record.state.failure = { code: "request-size", message: error };
    record.hash = contentHash({ planHash: store.planHash, workId, limits: record.limits, state: record.state });
    await fs.writeFile(prior.file, JSON.stringify(record));
    await recoverRoleContextBudget(root, { sourceId: f.source.id, batchId, workId, expectedBudgetHash: record.hash, failedRunId: runId, implementationRef: "fixture-size-fix" });
    charge(5);
  } else charge(4);
  await trace(options.recovered ? 5 : 4, options.error ?? "Error: ROLE_CONTEXT_REPACK_REQUIRED: tool-result-reserve requires 36239 bytes; host must repack this work with its existing budget and evidence obligations.");
  const input = { sourceId: f.source.id, batchId, workId, runIds, auditRef: "reviewed source context fixture", implementationRef: "tested observational byte policy" };
  return { root, f, roster, store, workId, contextFile, input,
    options: { root, sourceId: f.source.id, compilerBatchId: batchId, configPath: path.join(root, "absent.yaml"), sourceWorkScope: { planHash: store.planHash, workIds: [workId] } } };
}

it("continues the original size-recovered source once using its last fixed call and normal proposal validation", async () => {
  const f = await fixture({ recovered: true, read: true }), before = await fs.readFile(f.contextFile, "utf8");
  const ledger = new RequirementLedger(f.root, f.f.source.id);
  await ledger.recordRoleEvidenceNeed(f.store.planHash, f.workId, {
    question: "Complete this original source review", missing: "No accepted source receipt",
    decisionImpact: "Blocks source coverage", searchedUnitIds: [], requestedUnitIds: [f.roster.unitIds[0]!],
  });
  const preview = await inspectRoleSourceContextContinuation(f.root, f.input);
  expect(preview.authority.remainingCalls).toBe(1);
  await expect(fs.stat(preview.file)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(claimRoleSourceContextContinuation(f.root, { input: f.input, authorityHash: preview.authorityHash })).rejects.toThrow("compiler lock");
  let dispatched = 0;
  await withWorkspaceOperationLock(f.root, "compiler", async () => {
    await runBoundedRoleReview({ ...f.options, sourceContextResume: { input: f.input, authorityHash: preview.authorityHash } }, async work => {
      dispatched++; expect(work.workId).toBe(f.workId); expect(work.retainedBudgetRequired).toBe(true);
      const body = JSON.parse(work.prompt.split("\n").at(-1)!);
      expect(body.contextEvidence.fragments.map((v: { text: string }) => v.text).join("")).toContain("Hero opens the door.");
      const budget = roleReviewBudget(f.root, f.store.planHash, f.workId, ROLE_WORK_LIMITS, true);
      budget.beginCall({}); budget.admitPayload({ prompt: work.prompt });
      expect(budget.recordValidatedProgress("preview")).toBe(false); budget.close();
      await work.tools.find(t => t.name === "propose_role_source_review")!.execute("submit", { summary: "Hero acts in the supplied core", findings: [{ name: "Hero", observation: "Opens the door", unitIds: [body.assignedCoreUnitIds[0]] }], openQuestions: ["Friend's prior location is unspecified"] } as never, undefined, undefined, {} as ExtensionContext);
    }, async () => { throw Error("global finish forbidden"); });
  });
  expect(dispatched).toBe(1); expect(f.store.read("source", 0)?.findings[0]?.name).toBe("Hero");
  expect(f.store.sourceComplete()).toBe(false); expect(await fs.readFile(f.contextFile, "utf8")).toBe(before);
  expect(inspectRetainedRoleReviewBudget(f.root, f.store.planHash, f.workId).state.usage.modelCalls).toBe(12);
  const history = await ledger.history();
  const need = history.find(r => r.payload.kind === "role-review-evidence-need")!;
  expect(history.find(r => r.payload.kind === "role-review-evidence-resolution")?.payload).toMatchObject({
    planHash: f.store.planHash, workId: f.workId, needRef: contentHash(need.payload),
    resolutionRef: contentHash([f.store.journal.history("propose_role_source_review", f.workId).at(-1)!.inputHash]),
  });
  expect(history.some(r => r.payload.kind === "role-review-question" && r.payload.question.text.includes("prior location"))).toBe(true);
  await expect(f.store.beginAttempt(f.workId)).rejects.toThrow("invocation allowance exhausted");
  await expect(runBoundedRoleReview({ ...f.options, sourceContextResume: { input: f.input, authorityHash: preview.authorityHash } }, async () => { dispatched++; })).rejects.toThrow("unfinished original source");
  expect(dispatched).toBe(1);
});

it("keeps consumed authority after a crash, and rejects changed previews or mixed recovery scopes before dispatch", async () => {
  const f = await fixture(), preview = await inspectRoleSourceContextContinuation(f.root, f.input);
  await withWorkspaceOperationLock(f.root, "compiler", async () => {
    await expect(claimRoleSourceContextContinuation(f.root, { input: f.input, authorityHash: contentHash("stale") })).rejects.toThrow("authority changed");
    await expect(runBoundedRoleReview({ ...f.options, sourceContextResume: { input: f.input, authorityHash: preview.authorityHash }, partitionedSourceWorkIds: [f.workId] }, async () => { throw Error("must not dispatch"); })).rejects.toThrow("only its exact original");
    await claimRoleSourceContextContinuation(f.root, { input: f.input, authorityHash: preview.authorityHash });
    await expect(claimRoleSourceContextContinuation(f.root, { input: f.input, authorityHash: preview.authorityHash })).rejects.toThrow("already consumed");
  });
  expect(f.store.read("source", 0)).toBeUndefined();
  expect(inspectRetainedRoleReviewBudget(f.root, f.store.planHash, f.workId).state.usage.modelCalls).toBe(4);
});

it("enforces the fixed remaining allowance in the production runner without opening a new context loop", async () => {
  const f = await fixture({ recovered: true }), preview = await inspectRoleSourceContextContinuation(f.root, f.input);
  const create = vi.spyOn(PiAgentSession, "create").mockImplementation(async options => {
    const budgets = Array.isArray(options.requestBudget) ? options.requestBudget : [options.requestBudget!];
    return { promptWithReport: async (prompt: string) => {
      for (const budget of budgets) budget.beginCall({ prompt });
      const tools = options.additionalTools!;
      expect(tools.some(t => t.name === "request_role_session_rebuild")).toBe(false);
      const draft = { summary: "Fixture source", findings: [], openQuestions: ["Original uncertainty remains"] };
      await tools.find(t => t.name === "preview_role_source_review")!.execute("preview", draft as never, undefined, undefined, {} as ExtensionContext);
      // Preview cannot create a progress window in this fixed legacy allowance.
      expect(() => budgets[1]!.beginCall({ prompt })).toThrow("model-call limit reached");
      throw Error("fixture final call consumed without submission");
    }, dispose: async () => {}, abort: async () => {} } as unknown as PiAgentSession;
  });
  await withWorkspaceOperationLock(f.root, "compiler", async () => {
    await expect(runBoundedRoleReview({ ...f.options, sourceContextResume: { input: f.input, authorityHash: preview.authorityHash } })).rejects.toThrow("final call consumed");
  });
  expect(create).toHaveBeenCalledOnce();
  const budget = inspectRetainedRoleReviewBudget(f.root, f.store.planHash, f.workId);
  expect(budget.state).toMatchObject({ blocked: true, usage: { modelCalls: 12 }, failure: { code: "call-limit" } });
  expect(budget.state.progress).toBeUndefined();
  expect(f.store.read("source", 0)).toBeUndefined();
});

it.each([
  [{ error: "Error: The usage limit has been reached" }, "not a retired byte-watermark"],
  [{ error: "Error: Model request budget exhausted: no new validated progress in 12 model calls" }, "not a retired byte-watermark"],
  [{ pending: true }, "tool result is uncertain"],
  [{ proposal: true }, "cannot repeat a proposal"],
  [{ toolFailure: true }, "tool failure"],
  [{ toolError: true }, "tool error"],
  [{ missingResult: true }, "tool result is uncertain"],
  [{ orphanResult: true }, "tool result is uncertain"],
] as const)("refuses nontechnical or uncertain historical stops: %j", async (options, message) => {
  const f = await fixture(options); await expect(inspectRoleSourceContextContinuation(f.root, f.input)).rejects.toThrow(message);
});

it("rejects incomplete traces, exhausted fixed calls, and changed evidence without replacing the original work", async () => {
  const f = await fixture({ recovered: true });
  await expect(inspectRoleSourceContextContinuation(f.root, { ...f.input, runIds: f.input.runIds.slice(1) })).rejects.toThrow("trace must be included");
  const budget = roleReviewBudget(f.root, f.store.planHash, f.workId, ROLE_WORK_LIMITS, true); budget.beginCall({}); budget.close();
  await expect(inspectRoleSourceContextContinuation(f.root, f.input)).rejects.toThrow("allowance is exhausted");
  const g = await fixture(), entity = (await new CanonicalModelStore(g.root).listEntities())[0]!;
  await new CanonicalModelStore(g.root).putEntity({ ...entity, aliases: ["new identity"] });
  await expect(inspectRoleSourceContextContinuation(g.root, g.input)).rejects.toThrow("revision changed");
});

it("marks dependent audits stale on an atlas change while preserving their receipts and strict finish gates", async () => {
  const f = await fixture(), unit = f.roster.unitIds[0]!, candidateId = f.roster.candidates[0]!.id;
  await f.store.submit("source", 1, { summary: "Friend enters", findings: [], openQuestions: [] }, () => {});
  const entry = { candidateId, importance: "major", rationale: "Door action", basisUnitIds: [unit], developmentExpectation: { kind: "unknown", rationale: "No development evidence", basisUnitIds: [unit] } };
  f.store.journal.record("propose_role_roster_entry", { subjectHash: f.roster.subjectHash, entry }, "succeeded");
  await f.store.submitClaim({ candidateId, claimRevision: contentHash(entry), atlasRevision: f.store.atlasRevision(), packetHash: contentHash("packet"), verdict: "supported", rationale: "Fixture", basisUnitIds: [unit],
    counterevidence: { searchedUnitIds: [unit], rationale: "Fixture" }, checks: ["importance", "identity", "development"].map(kind => ({ kind, verdict: "supported", rationale: "Fixture", basisUnitIds: [unit] })) }, candidateId, () => {});
  await f.store.submit("audit", 1, { rationale: "Fixture", missingMajorCharacters: [], unresolved: [], questionDispositions: [], discoveryDispositions: [], atlasRevision: f.store.atlasRevision() }, () => {});
  const before = f.store.reviewFreshness(); expect(before.claimAudits[0]?.current).toBe(true);
  const preview = await inspectRoleSourceContextContinuation(f.root, f.input);
  expect(preview.authority.dependentReceipts).toHaveLength(2);
  await withWorkspaceOperationLock(f.root, "compiler", () => runBoundedRoleReview({ ...f.options, sourceContextResume: { input: f.input, authorityHash: preview.authorityHash } }, async work => {
    await work.tools.find(t => t.name === "propose_role_source_review")!.execute("submit", { summary: "Hero acts", findings: [], openQuestions: ["Motivation unresolved"] } as never, undefined, undefined, {} as ExtensionContext);
  }));
  const after = f.store.reviewFreshness();
  expect(after.claimAudits[0]).toMatchObject({ receiptHash: before.claimAudits[0]!.receiptHash, current: false });
  expect(after.sourceAudits[0]).toMatchObject({ receiptHash: before.sourceAudits[0]!.receiptHash, current: false });
  expect(() => f.store.auditComplete()).toThrow("changed after audit");
  const status = await inspectCompilerStatus(f.root, f.f.source.id);
  expect(status.sources[0]?.roleReviewWork[0]).toMatchObject({ reviewedSources: 2, staleSourceAudits: 1, staleClaimAudits: 1, verifiedClaims: 0, pendingClaimVerifications: 1, auditedSources: 0, openQuestions: 1 });
});
