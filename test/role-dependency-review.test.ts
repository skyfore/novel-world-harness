import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { contentHash as h } from "../src/world/canonical.js";
import { roleDependencyReviewSchema, freezeRoleDependencyReview, assertAdditiveRoleInventory, retainRoleDependencyFiles } from "../src/compiler/role-dependency-review.js";
import * as service from "../src/compiler/role-dependency-review-service.js";
import { RequirementLedger, requirementJournalSchema } from "../src/compiler/requirement-ledger.js";
import { RoleRosterStore } from "../src/compiler/role-roster.js";
import { roleSemanticScopeDirectory, semanticScopeSlotId, inspectSemanticScopePlan, validateSemanticScopePlan } from "../src/compiler/role-semantic-scope.js";
import { runRoleSemanticScope, runRoleSemanticScopeCorrection } from "../src/workflow/role-semantic-scope.js";
import { prepareSemanticScopeCorrection, validateSemanticScopeCorrection, semanticScopeCorrectionDirectory } from "../src/compiler/role-semantic-scope-correction.js";
import { verifySemanticScopeRecord } from "../src/compiler/role-semantic-scope-trace.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { TraceStore } from "../src/trace/store.js";
import { roleDependencyFixture } from "./helpers/role-dependency-fixture.js";
import { captureRoleDependencyHistory } from "../src/compiler/role-dependency-history.js";
import { worldStorageRoot } from "../src/world/paths.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture(parentStateHash = h("BREAK")) {
  const result = await roleDependencyFixture(parentStateHash); roots.push(result.root); return result;
}

it("retains the original history hash across traversal orders while rejecting any file inventory change", () => {
  const original = ["budgets/old.json", "work/plan.json", "attempts/failure.json"].map(path => ({ path, hash: h(path) }));
  const current = original.slice().reverse(), before = h(current);
  expect(retainRoleDependencyFiles(current, original)).toEqual(original);
  expect(h(current)).toBe(before);
  for (const changed of [current.slice(1), [...current, { path: "new-grant.json", hash: h("grant") }],
    [...current.slice(1), current[1]!], current.map((f, i) => i ? f : { ...f, hash: h("changed failure") })]) {
    expect(() => retainRoleDependencyFiles(changed, original)).toThrow(/file inventory changed/);
  }
});

it("reads the exact legacy whole-history layout without dropping archived failures or rebinding new source-local records", async () => {
  const f = await fixture(), sid = f.scope.sourceId, plan = f.review.priorPlan, storage = worldStorageRoot(f.root);
  const journal = createHash("sha256").update(JSON.stringify([sid, plan.batchId])).digest("hex");
  const paths = [`compiler/role-review-work/v1/${h(sid)}/plan.json`,
    `compiler/role-review-work/budgets/${h(plan)}/spent.json`,
    `compiler/role-review-work/context/${h(plan)}/failed.json`,
    `compiler/proposal-obligations/${journal}/attempt.json`];
  const put = async (name: string, body: string) => { const file = path.join(storage, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, body); };
  for (const name of paths) await put(name, name);
  const old = { ...f.review, retainedFiles: paths.slice().reverse().map(name => ({ path: name, hash: createHash("sha256").update(name).digest("hex") })) };
  const oldHash = h(old);
  expect(await captureRoleDependencyHistory(f.root, sid, [plan], old)).toEqual(old.retainedFiles);
  const current = await captureRoleDependencyHistory(f.root, sid, [plan]);
  expect(current).toHaveLength(3);
  expect(current.some(file => file.path.includes("/context/"))).toBe(false);
  await put(paths[2]!, "modified failure");
  await expect(captureRoleDependencyHistory(f.root, sid, [plan], old)).rejects.toThrow(/file inventory changed/);
  await put(paths[2]!, paths[2]!);
  await put("compiler/role-review-work/context/extra.json", "new attempt");
  await expect(captureRoleDependencyHistory(f.root, sid, [plan], old)).rejects.toThrow(/file inventory changed/);
  expect(await captureRoleDependencyHistory(f.root, sid, [plan], { ...f.review, retainedFiles: current })).toEqual(current);
  expect(h(old)).toBe(oldHash);
});

it("accepts only a receipt-bound additive denominator and keeps an unfinished zero-review plan pending", async () => {
  const f = await fixture();
  expect(f.review.priorRoster.reviews).toEqual([]);
  expect(f.review.nextRoster.candidates).toHaveLength(78);
  expect(f.review.authority).toBe("semantic-scope-planning-only");
  for (const change of [
    (r: any) => r.nextRoster.candidates.shift(),
    (r: any) => { r.nextRoster.candidates[0].name = "changed"; },
    (r: any) => { r.nextRoster.candidates[77].entityId = "invented-identity"; },
    (r: any) => { r.nextRoster.candidates[77].mentionIds = ["not-in-receipt"]; },
    (r: any) => { r.scope.planHash = h("fresh-grant"); },
    (r: any) => { r.priorRoster.reviewRevisionId = "unrelated-revision"; },
  ]) {
    const r: any = structuredClone(f.review); change(r); const { revisionHash: _, ...identity } = r; r.revisionHash = h(identity);
    expect(roleDependencyReviewSchema.safeParse(r).success).toBe(false);
  }
  expect(() => assertAdditiveRoleInventory(f.review.priorRoster, f.review.priorRoster, f.review.addedAnnotationIds)).toThrow("exact unresolved");
});

it("rejects omitted criteria/boundaries, unbound payload references and writes outside exact fields", async () => {
  const f = await fixture(), validate = (p: any, catalog: any[] = []) => validateSemanticScopePlan(p, f.review, f.prepared.prerequisites, f.prepared.representations, catalog, []);
  validate(f.proposal);
  const omitted = structuredClone(f.proposal); omitted.questions[0]!.boundaries = [];
  expect(() => validate(omitted)).toThrow("criterion or unresolved boundary");
  const p = structuredClone(f.proposal), payload = { version: 1, annotationType: "discourse-segment", id: "existing", sourceId: f.scope.sourceId, kind: "unclassified", confidence: 0,
    interpretation: "Unknown voice", anchors: [textAnchorForByteRange(f.scope.sourceId, Buffer.from("Ada waits."), 0, 10)], derivation: { runId: "original", worker: "source", ontologyVersion: "observation-v1" } };
  const baseline: any = { kind: "discourse-segment", id: "existing", revisionHash: h(payload), payload };
  p.operations = [{ slot: 1, id: "existing", kind: "discourse-segment", mode: "revise", baseline: { kind: "discourse-segment", id: "existing", revisionHash: h(payload) },
    pointers: ["/interpretation"], payloadJson: JSON.stringify({ ...payload, interpretation: "Still unknown" }), readableRefs: [], findingIds: [], questionIds: [f.scope.questions[0]!.questionId], rationale: "Scope fixture", evidence: f.evidence }];
  p.questions[0]!.criteria[0] = { ...p.questions[0]!.criteria[0]!, route: "typed-repair", operationSlots: [1], missingCondition: "" };
  validate(p, [baseline]);
  p.operations[0]!.payloadJson = JSON.stringify({ ...payload, kind: "narrator-commentary", interpretation: "Changed without field permission" });
  expect(() => validate(p, [baseline])).toThrow("outside its exact pointer scope");
  p.operations[0]!.payloadJson = JSON.stringify({ ...payload, viewpointMentionId: "invented-ref" });
  expect(() => validate(p, [baseline])).toThrow("unbound typed dependency");
});

it("reports all invalid creation scopes without rewriting a retained partial proposal", async () => {
  const f = await fixture(), original = f.prepared.representations[0].output.annotations[0].payload;
  const predecessor = { kind: "discourse-segment", id: original.id, revisionHash: h(original) };
  f.proposal.operations = [1, 2, 3].map(slot => ({ slot, kind: "discourse-segment", id: semanticScopeSlotId(f.review.taskId, slot), mode: "create", baseline: slot === 3 ? predecessor : null,
    pointers: ["/"], payloadJson: JSON.stringify({ ...original, id: semanticScopeSlotId(f.review.taskId, slot) }), readableRefs: [predecessor], findingIds: [],
    questionIds: [f.scope.questions[0]!.questionId], rationale: "Partial scope with a retained missing condition", evidence: f.evidence }));
  f.proposal.questions[0]!.criteria[0]!.route = "typed-repair";
  f.proposal.questions[0]!.criteria[0]!.operationSlots = [1, 2, 3];
  const before = structuredClone(f.proposal), args = [f.review, f.prepared.prerequisites, f.prepared.representations, [{ ...predecessor, payload: original }], [] as string[]] as const;
  const issues = inspectSemanticScopePlan(f.proposal, ...args);
  expect(issues.map(i => i.path)).toEqual(["/operations/0/pointers", "/operations/1/pointers", "/operations/2/baseline", "/operations/2/pointers"]);
  expect(() => validateSemanticScopePlan(f.proposal, ...args)).toThrow("Creation requires pointers=[]");
  expect(f.proposal).toEqual(before);
  // A different, syntactically scoped fixture is retainable, not authorization.
  const scoped = structuredClone(f.proposal);
  for (const op of scoped.operations) { op.pointers = []; op.baseline = null; }
  expect(() => validateSemanticScopePlan(scoped, ...args)).not.toThrow();
  const malformed = structuredClone(scoped); malformed.operations[0]!.payloadJson = "invalid JSON";
  expect(inspectSemanticScopePlan(malformed, ...args).map(i => i.path)).toContain("/operations/0/payloadJson");
  expect(() => validateSemanticScopePlan(malformed, ...args)).toThrow(SyntaxError);
  malformed.operations[0]!.pointers = ["/"];
  expect(() => validateSemanticScopePlan(malformed, ...args)).toThrow("ROLE_PREREQUISITE_HOST_REVIEW");
});

it.each(["gap-supported", "gap-negative", "typed-supported", "typed-partial", "typed-invalid-create"])("keeps scope stages bounded and grants no writes (%s)", async mode => {
  const f = await fixture(), negative = mode === "gap-negative", typed = mode.startsWith("typed-"), partial = mode === "typed-partial", invalid = mode === "typed-invalid-create";
  if (typed) {
    const payload = f.prepared.representations[0].output.annotations[0].payload;
    const item = { kind: "discourse-segment", id: payload.id, revisionHash: h(payload), payload };
    f.prepared.catalog = [item];
    const { revisionHash: _, ...identity } = f.review;
    f.review = freezeRoleDependencyReview({ ...identity, catalogHash: h([item]) }); f.prepared.review = f.review;
    f.proposal.revisionHash = f.review.revisionHash;
    f.proposal.operations = [{ slot: 1, kind: "discourse-segment", id: payload.id, mode: "revise", baseline: { kind: "discourse-segment", id: payload.id, revisionHash: h(payload) }, pointers: ["/interpretation"],
      payloadJson: JSON.stringify({ ...payload, interpretation: "Updated source observation; semantic uncertainty retained" }), readableRefs: [], findingIds: [], questionIds: f.scope.questions.map(q => q.questionId), rationale: "Exact field fixture", evidence: f.evidence }];
    for (const q of f.proposal.questions) q.criteria[0] = { ...q.criteria[0]!, route: "typed-repair", operationSlots: [1], missingCondition: partial ? "Independent source correspondence still absent" : "" };
    if (invalid) {
      const operation = f.proposal.operations[0]!;
      operation.mode = "create"; operation.id = semanticScopeSlotId(f.review.taskId, 1); operation.pointers = ["/"];
      operation.payloadJson = JSON.stringify({ ...payload, id: operation.id });
    }
  }
  // Isolate host source/receipt verification, covered by upstream/representation integration tests.
  // Exercise the real runner, request charges, trace verifier and requirement publication here.
  vi.spyOn(service, "prepareCoreRoleDependencyReview").mockResolvedValue(f.prepared);
  vi.spyOn(service, "beginCoreRoleDependencyReview").mockImplementation(async () => { await f.ledger.recordRoleDependencyReview(f.review); return f.prepared; });
  vi.spyOn(ModelRuntime, "create").mockResolvedValue({ checkAuth: async () => ({ type: "oauth" }), getProvider: () => ({ auth: { oauth: { isSubscription: true } } }), getModel: () => ({}) } as any);
  let sessions = 0;
  vi.spyOn(PiAgentSession, "create").mockImplementation(async opts => {
    const id = `new-independent-${++sessions}`, trace = opts.trace!.parent!.recorder;
    expect(opts.includeProjectInstructions).toBe(false); expect(opts.includeLocalTools).toBe(false); expect(opts.model).toBe("openai-codex/gpt-6.1-sol");
    return { id, model: opts.model, dispose: async () => {}, abort: async () => {}, async promptWithReport(raw: string) {
      const input = JSON.parse(raw); let n = 0;
      const invoke = async (name: string, args: unknown) => {
        const toolCallId = `call-${++n}`, blobRef = await trace.putBlob(JSON.parse(JSON.stringify(args)));
        await trace.record("tool.call.started", { toolName: name }, undefined, { toolCallId, blobRef });
        try { await opts.additionalTools!.find(t => t.name === name)!.execute(toolCallId, args as any, undefined as any, undefined as any, undefined as any); }
        catch (e) { await trace.record("tool.call.failed", { toolName: name, isError: true }, undefined, { toolCallId }); throw e; }
        await trace.record("tool.call.completed", { toolName: name }, undefined, { toolCallId });
      };
      opts.requestBudget!.beginCall({}); opts.requestBudget!.admitPayload(input);
      await trace.record("llm.request.started", { providerId: "openai-codex", modelId: "gpt-6.1-sol" }, undefined, { callId: "request" });
      await trace.record("llm.response.completed", {}, undefined, { callId: "request" });
      await invoke("read_semantic_source", { segmentIds: [f.f.segmentId] });
      if (typed) await invoke("read_semantic_dependencies", { refs: [`discourse-segment:${f.proposal.operations[0]!.baseline!.id}`] });
      await invoke("submit_role_semantic_scope", input.phase === "semantic-scope-plan" ? f.proposal : { phase: input.phase, revisionHash: f.review.revisionHash,
        proposalHash: h(f.proposal), judgments: f.scope.questions.map(q => ({ questionId: q.questionId, verdict: negative ? "blocked" : "supported", rationale: "Independent review supports retained missing condition", evidence: f.evidence })),
        operationJudgments: f.proposal.operations.map(o => ({ slot: o.slot, verdict: "supported", rationale: "Exact field independently checked" })), consumerVerdict: "supported", consumerRationale: "Original grant is not renewed" });
      return { text: "" };
    } } as any;
  });
  const args = { root: f.root, input: { scope: f.scope, upstreamPlanHash: f.review.upstream.planHash, authorizationRef: f.review.authorizationRef }, assertOriginal: async () => {} };
  if (invalid) {
    await expect(runRoleSemanticScope(args)).rejects.toThrow("Creation requires");
    const dir = roleSemanticScopeDirectory(f.root, f.review.taskId, f.scope.sourceId), read = async (name: string) => JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
    const state = await read("state.json"), before = (await fs.readdir(dir)).sort();
    expect(state.phase).toBe("BREAK"); expect(sessions).toBe(1);
    expect((await read(`semantic-scope-plan.failure-submission-${h(f.proposal)}.json`)).raw).toEqual(f.proposal);
    expect(before).not.toContain("semantic-scope-plan.proposal.json"); expect(before).not.toContain("semantic-scope-check.invocation.json");
    expect((await read("semantic-scope-plan.budget.json")).state.usage.modelCalls).toBe(1);
    expect((await new TraceStore(f.root).peekRun(state.traceRunId)).status).toBe("failed");
    await expect(runRoleSemanticScope(args)).rejects.toThrow("already reserved"); expect(sessions).toBe(1);
    expect((await fs.readdir(dir)).sort()).toEqual(before);
    expect(await f.ledger.roleSemanticScopes(f.review.taskId)).toEqual([]);
    expect((await f.ledger.history()).slice(0, f.history.length)).toEqual(f.history);
    expect(await f.ledger.roleReviewRevisions()).toEqual([]);
    expect(await new RoleRosterStore(f.root).read(f.scope.sourceId)).toEqual(f.review.priorRoster);
    return;
  }
  await runRoleSemanticScope(args);
  const history = await f.ledger.history(), dir = roleSemanticScopeDirectory(f.root, f.review.taskId, f.scope.sourceId);
  expect(history.slice(0, f.history.length)).toEqual(f.history); expect(sessions).toBe(2);
  expect(await f.ledger.roleReviewRevisions()).toEqual([]); expect((await new RoleRosterStore(f.root).read(f.scope.sourceId))).toEqual(f.review.priorRoster);
  expect(await f.ledger.roleSemanticScopes(f.review.taskId)).toHaveLength(2);
  const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
  expect(state.phase).toBe(typed && !partial ? "DONE" : "BREAK"); expect(state.parentCompileResumeAllowed).toBe(false); expect(state.authorityGranted).toBe(false);
  const handoff = JSON.parse(await fs.readFile(path.join(dir, "authorization-review.json"), "utf8"));
  expect(handoff.authorizationGranted).toBe(false); expect(handoff.questions.every((q: any) => q.status === "blocked")).toBe(true);
  await expect(runRoleSemanticScope(args)).rejects.toThrow("already reserved"); expect(sessions).toBe(2);
  for (const name of ["semantic-scope-plan", "semantic-scope-check"]) expect(JSON.parse(await fs.readFile(path.join(dir, `${name}.budget.json`), "utf8")).state.usage.modelCalls).toBe(1);
  const duplicate = structuredClone(history), original = duplicate.at(-1)!;
  const identity = { ...original, sequence: duplicate.length, predecessorHash: original.hash }; const { hash: _, ...rest } = identity;
  duplicate.push({ ...rest, hash: h(rest) }); expect(requirementJournalSchema.safeParse(duplicate).success).toBe(false);
});

it.each(["supported", "negative-check", "escaped-payload", "budget-bound", "tampered-history"])("corrects only the authorized four fields with original cumulative charges (%s)", async outcome => {
  const parent = { phase: "BREAK", childPid: null, originalFailures: 2 };
  const f = await fixture(createHash("sha256").update(JSON.stringify(parent)).digest("hex"));
  const sourceId = f.scope.sourceId, taskId = f.review.taskId;
  const mentions = [1, 2, 3].map(i => ({ kind: "entity-mention", id: `mention-${i}`, payload: { id: `mention-${i}`, sourceId, surface: "Ada" } }));
  const previous = { version: 1, id: "old-resolution", sourceId, mentionId: "mention-3", status: "unresolved", candidates: [], rationale: "Unresolved original decision",
    derivation: { runId: "old", worker: "test", ontologyVersion: "entity-resolution-v1" } };
  const catalog = [...mentions, { kind: "entity-resolution", id: previous.id, payload: previous }].map(i => ({ ...i, revisionHash: h(i.payload) }));
  f.prepared.catalog = catalog;
  const { revisionHash: _, ...identity } = f.review;
  f.review = freezeRoleDependencyReview({ ...identity, catalogHash: h(catalog) }); f.prepared.review = f.review; f.proposal.revisionHash = f.review.revisionHash;
  const ref = (i: number) => ({ kind: catalog[i]!.kind, id: catalog[i]!.id, revisionHash: catalog[i]!.revisionHash }) as any;
  f.proposal.operations = [1, 2, 3].map(slot => ({ slot, kind: "entity-resolution", id: semanticScopeSlotId(taskId, slot), mode: "create", baseline: slot === 3 ? ref(3) : null, pointers: ["/"],
    payloadJson: JSON.stringify({ ...previous, id: semanticScopeSlotId(taskId, slot), mentionId: `mention-${slot}`, ...(slot === 3 ? { supersedesResolutionId: previous.id } : {}) }),
    readableRefs: [ref(slot - 1), ...(slot === 3 ? [ref(3)] : [])], findingIds: [], questionIds: [f.scope.questions[0]!.questionId], rationale: "Partial repair; original criterion remains blocked", evidence: f.evidence }));
  f.proposal.questions[0]!.criteria[0]!.route = "typed-repair"; f.proposal.questions[0]!.criteria[0]!.operationSlots = [1, 2, 3];
  const directory = roleSemanticScopeDirectory(f.root, taskId, sourceId), correctionDirectory = semanticScopeCorrectionDirectory(f.root, f.review);
  await fs.mkdir(path.resolve(directory, "../../.."), { recursive: true }); await fs.writeFile(path.resolve(directory, "../../..", "state.json"), JSON.stringify(parent));
  vi.spyOn(service, "prepareCoreRoleDependencyReview").mockResolvedValue(f.prepared);
  vi.spyOn(service, "beginCoreRoleDependencyReview").mockImplementation(async () => { await f.ledger.recordRoleDependencyReview(f.review); return f.prepared; });
  vi.spyOn(ModelRuntime, "create").mockResolvedValue({ checkAuth: async () => ({ type: "oauth" }), getProvider: () => ({ auth: { oauth: { isSubscription: true } } }), getModel: () => ({}) } as any);
  let sessions = 0;
  vi.spyOn(PiAgentSession, "create").mockImplementation(async opts => {
    const ordinal = ++sessions, id = `scope-session-${ordinal}`, trace = opts.trace!.parent!.recorder;
    expect(opts.model).toBe("openai-codex/gpt-6.1-sol"); expect(opts.includeLocalTools).toBe(false); expect(opts.autoCompaction).toBe(false);
    return { id, model: opts.model, dispose: async () => {}, abort: async () => {}, async promptWithReport(raw: string) {
      const input = JSON.parse(raw); let n = 0;
      const charge = async (index: number) => {
        opts.requestBudget!.beginCall({}); opts.requestBudget!.admitPayload(input);
        const callId = `request-${index}`, blobRef = await trace.putBlob(input);
        await trace.record("llm.request.started", { providerId: "openai-codex", modelId: "gpt-6.1-sol" }, undefined, { callId });
        await trace.record("llm.request.payload", {}, undefined, { callId, blobRef });
        await trace.record("llm.response.completed", {}, undefined, { callId });
      };
      for (let i = 0; i < (ordinal === 1 ? 12 : ordinal === 2 && outcome === "budget-bound" ? 13 : 1); i++) await charge(i);
      if (ordinal === 2) expect(opts.requestBudget!.snapshot().modelCalls).toBe(13);
      if (ordinal === 3) expect(opts.requestBudget!.snapshot().modelCalls).toBe(1);
      const invoke = async (name: string, args: unknown) => {
        const toolCallId = `tool-${++n}`, blobRef = await trace.putBlob(JSON.parse(JSON.stringify(args)));
        await trace.record("tool.call.started", { toolName: name }, undefined, { toolCallId, blobRef });
        try { await opts.additionalTools!.find(t => t.name === name)!.execute(toolCallId, args as any, undefined as any, undefined as any, undefined as any); }
        catch (e) { await trace.record("tool.call.failed", { toolName: name, isError: true }, undefined, { toolCallId }); throw e; }
        await trace.record("tool.call.completed", { toolName: name }, undefined, { toolCallId });
      };
      await invoke("read_semantic_source", { segmentIds: [f.f.segmentId] });
      await invoke("read_semantic_dependencies", { refs: catalog.map(c => `${c.kind}:${c.id}`) });
      if (ordinal === 1) { await invoke("submit_role_semantic_scope", f.proposal); return { text: "" }; }
      expect(input.correction.originalSubmission).toEqual(f.proposal);
      if (ordinal === 2) {
        const corrected = structuredClone(input.correction.originalSubmission);
        for (const op of corrected.operations) { op.pointers = []; op.baseline = null; }
        if (outcome === "escaped-payload") corrected.operations[0].payloadJson += " ";
        await invoke("submit_role_semantic_scope", corrected);
      } else {
        await invoke("submit_role_semantic_scope", { phase: "semantic-scope-check", revisionHash: f.review.revisionHash, proposalHash: h(input.proposal),
          judgments: f.scope.questions.map(q => ({ questionId: q.questionId, verdict: outcome === "negative-check" ? "blocked" : "supported", rationale: "Independently retained source gap", evidence: f.evidence })),
          operationJudgments: input.proposal.operations.map((o: any) => ({ slot: o.slot, verdict: "supported", rationale: "Checked exact unchanged payload" })), consumerVerdict: "supported", consumerRationale: "Pending only" });
      }
      return { text: "" };
    } } as any;
  });
  const options = { root: f.root, input: { scope: f.scope, upstreamPlanHash: f.review.upstream.planHash, authorizationRef: f.review.authorizationRef }, assertOriginal: async () => {} };
  await expect(runRoleSemanticScope(options)).rejects.toThrow("Creation requires");
  // This session double does not emit runtime hook events.
  await fs.writeFile(path.join(directory, "hooks.jsonl"), "", { flag: "wx" });
  // Real failed trace and charged budget, not a fabricated success or a fresh task.
  const before = Object.fromEntries(await Promise.all((await fs.readdir(directory)).map(async n => [n, await fs.readFile(path.join(directory, n), "utf8")])));
  const prefix = await f.ledger.history();
  const authorizationRef = "User explicitly authorizes only the three pointers and one baseline correction, preserving original cumulative budget";
  const preview = await prepareSemanticScopeCorrection(f.root, options.input, authorizationRef);
  expect(preview.authority.originalUsage.modelCalls).toBe(12); expect(preview.authority.allowedPaths).toHaveLength(4);
  const correctedFixture = structuredClone(f.proposal); for (const op of correctedFixture.operations) { op.pointers = []; op.baseline = null; }
  validateSemanticScopeCorrection(f.proposal, correctedFixture, preview.authority);
  for (const mutate of [
    (p: typeof f.proposal) => { p.questions[0]!.criteria[0]!.missingCondition = ""; },
    (p: typeof f.proposal) => { p.operations[0]!.payloadJson += " "; },
    (p: typeof f.proposal) => { p.consumer.activationConditions.push("skip acceptance"); },
    (p: typeof f.proposal) => { p.operations.reverse(); },
  ]) { const changed = structuredClone(correctedFixture); mutate(changed); expect(() => validateSemanticScopeCorrection(f.proposal, changed, preview.authority)).toThrow("outside the four"); }
  const args = { ...options, authorizationRef, expectedCorrectionHash: h(preview.authority) };
  if (outcome === "tampered-history") {
    const file = path.join(directory, "semantic-scope-plan.budget.json"), originalBytes = await fs.readFile(file, "utf8"), b = JSON.parse(originalBytes);
    b.state.usage.modelCalls = 0; await fs.writeFile(file, JSON.stringify(b));
    await expect(runRoleSemanticScopeCorrection(args)).rejects.toThrow("charged Pi subscription"); expect(sessions).toBe(1);
    await fs.writeFile(file, originalBytes);
    return;
  }
  if (["escaped-payload", "budget-bound"].includes(outcome)) await expect(runRoleSemanticScopeCorrection(args)).rejects.toThrow(outcome === "escaped-payload" ? "outside the four" : "budget exhausted");
  else await runRoleSemanticScopeCorrection(args);
  for (const [name, bytes] of Object.entries(before)) expect(await fs.readFile(path.join(directory, name), "utf8")).toBe(bytes);
  const originalState = JSON.parse(before["state.json"]!), originalRun = await new TraceStore(f.root).peekRun(originalState.traceRunId);
  expect(originalRun.status).toBe("failed"); expect(originalRun.counts.llmRequests).toBe(12);
  const read = async (name: string) => JSON.parse(await fs.readFile(path.join(correctionDirectory, name), "utf8"));
  const budget = await read("semantic-scope-correction.budget.json");
  expect(budget.state.usage.modelCalls).toBe(outcome === "budget-bound" ? 24 : 13); expect(budget.limits.maxModelCalls).toBe(24);
  expect(budget.predecessorBudgetHash).toBe(preview.authority.originalBudgetHash);
  const state = await read("state.json"); expect(state.phase).toBe("BREAK"); expect(state.authorityGranted).toBe(false);
  const records = await f.ledger.roleSemanticScopes(taskId);
  expect(records).toHaveLength(["escaped-payload", "budget-bound"].includes(outcome) ? 0 : 2);
  expect((await f.ledger.history()).slice(0, prefix.length)).toEqual(prefix);
  expect(await new RoleRosterStore(f.root).read(sourceId)).toEqual(f.review.priorRoster);
  if (records.length) {
    expect(records[0]!.correction).toEqual(preview.authority);
    expect(records[0]!.output).toEqual(correctedFixture);
    expect(new Set([preview.authority.failedSessionId, ...records.map(r => r.sessionId)]).size).toBe(3);
    // A forged cumulative charge cannot be accepted even with a successful trace.
    const file = path.join(correctionDirectory, "semantic-scope-correction.budget.json"), bytes = await fs.readFile(file, "utf8");
    await fs.writeFile(file, JSON.stringify({ ...budget, state: { ...budget.state, usage: { ...budget.state.usage, modelCalls: 1, payloads: 1 } } }));
    await expect(verifySemanticScopeRecord(f.root, f.review, records[0]!)).rejects.toThrow("provenance");
    await fs.writeFile(file, bytes);
  } else expect((await fs.readdir(directory)).some(n => n.startsWith("semantic-scope-check."))).toBe(false);
  const count = sessions; await expect(runRoleSemanticScopeCorrection(args)).rejects.toThrow("already consumed"); expect(sessions).toBe(count);
});
