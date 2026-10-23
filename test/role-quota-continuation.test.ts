import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { contentHash } from "../src/world/canonical.js";
import { worldStorageRoot } from "../src/world/paths.js";
import { ensureSourceStructure, baseStructuralUnits } from "../src/compiler/structure.js";
import { loadCurrentRoleRoster } from "../src/compiler/role-roster-tools.js";
import { RoleReviewWorkStore } from "../src/compiler/role-review-work.js";
import { roleReviewBudget, inspectRoleReviewBudget } from "../src/compiler/role-review-budget.js";
import { inspectRoleQuotaContinuation, grantRoleQuotaContinuation, claimReservedRoleQuotaAttempt } from "../src/compiler/role-quota-continuation.js";
import { RoleSessionContext } from "../src/workflow/role-session-context.js";
import { runBoundedRoleReview, ROLE_WORK_LIMITS, type RoleWorkInvocation } from "../src/workflow/role-review-bounded.js";
import { newNovelCompilationRun, NovelCompilationRunStore } from "../src/workflow/novel-compilation.js";
import { TraceStore } from "../src/trace/store.js";
import { TraceRecorder } from "../src/trace/recorder.js";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { withWorkspaceOperationLock } from "../src/util/workspace-lock.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const refusal = "Codex error: The usage limit has been reached";
async function fixture(mode = "quota") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "role-quota-")); roots.push(root);
  const f = await createEvidenceFixture(root, "Hero waits.\nThe road is empty.\n"); await ensureSourceStructure(root, f.source);
  await new CanonicalModelStore(root).putEntity({ id: "hero", canonicalName: "Hero", kind: "character", aliases: [], evidence: f.evidence("Hero") });
  const { roster, structure } = await loadCurrentRoleRoster(root, f.source.id), candidateId = roster.candidates[0]!.id;
  const store = await RoleReviewWorkStore.open(root, { version: 1, sourceId: f.source.id, sourceHash: roster.sourceSha256,
    subjectHash: roster.subjectHash, batchId: `role-roster-${f.source.id}-original`, structureHash: contentHash(structure),
    spans: [{ start: 0, end: f.source.bytes }], legacyDraftHashes: [] });
  await store.submit("source", 0, { summary: "Hero and the road", findings: [], openQuestions: [] }, () => {});
  const [unit, counterunit] = [baseStructuralUnits(structure)[0]!, baseStructuralUnits(structure).at(-1)!];
  const entry = { candidateId, importance: "major" as const, rationale: "Viewpoint", basisUnitIds: [unit.id],
    developmentExpectation: { kind: "unknown" as const, rationale: "No lasting change established", basisUnitIds: [unit.id] } };
  store.journal.record("propose_role_roster_entry", { subjectHash: store.plan.subjectHash, entry }, "succeeded");
  const workId = store.claimWorkId(candidateId), options = { root, sourceId: f.source.id, compilerBatchId: store.plan.batchId,
    configPath: path.join(root, "absent.yaml"), model: "openai-codex/gpt-6.1-sol" };
  let original: RoleWorkInvocation | undefined;
  await expect(runBoundedRoleReview(options, async work => { original = work; throw Error("retain task"); })).rejects.toThrow("retain task");
  const taskHash = contentHash(original!.prompt), prompt = new RoleSessionContext(original!).invocation().prompt;
  const base = path.join(worldStorageRoot(root), "compiler", "role-review-work");
  const contextDir = path.join(base, "context-loops", store.planHash, contentHash(workId), taskHash);
  await fs.mkdir(contextDir, { recursive: true });
  const claim = { planHash: store.planHash, workId, taskHash, ordinal: 0 };
  await fs.writeFile(path.join(contextDir, "0.json"), JSON.stringify({ claim, hash: contentHash(claim) }));
  const budget = roleReviewBudget(root, store.planHash, workId, ROLE_WORK_LIMITS, false, "progress"); budget.beginCall({});
  const recorder = await TraceRecorder.start(new TraceStore(root), { kind: "prepare", sourceId: f.source.id, operationId: store.plan.batchId });
  await recorder.record("validation.completed", { phase: "role-review-work", planHash: store.planHash, workId, packetHash: contentHash(prompt) });
  await recorder.record("context.assembled", { phase: "before-agent-start" }, recorder.rootContext, { blobRef: await recorder.putBlob(prompt) });
  await recorder.record("validation.completed", { phase: "role-request-observation", planHash: store.planHash, workId, logicalTaskHash: taskHash, sessionOrdinal: 0, evidenceEpoch: 0 });
  await recorder.record("llm.request.started", { providerId: "openai-codex", modelId: "gpt-6.1-sol" }, recorder.rootContext, { callId: "request" });
  if (mode === "tool") await recorder.record("tool.call.started", { toolName: "read_role_work_evidence" }, recorder.rootContext, { toolCallId: "unsettled" });
  const message = mode === "transport" ? "Network error" : refusal;
  await recorder.record("llm.response.failed", { providerId: "openai-codex", errorMessage: message,
    usage: { input: 0, output: mode === "output" ? 1 : 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 } }, recorder.rootContext, { callId: "request" });
  await recorder.record("validation.completed", { phase: "role-review-work-stopped", workId, compactions: [], budget: budget.report() });
  await recorder.finish("failed", {}, { code: "ROLE_REVIEW_WORK_FAILED", message: `Error: ${message}`, retryable: false }); budget.close();
  const end = Date.parse(recorder.manifest.endedAt!);
  const attemptDir = path.join(base, "v1", contentHash(f.source.id), "attempts", contentHash(store.plan.batchId), contentHash(workId));
  await fs.writeFile(path.join(attemptDir, "2.json"), JSON.stringify({ planHash: store.planHash, workId, at: new Date(end + 2).toISOString() }));
  const schedule = newNovelCompilationRun(f.source);
  schedule.history.push({ phase: "roles", startedAt: new Date(end + 1).toISOString(), finishedAt: new Date(end + 3).toISOString(), status: "blocked",
    error: "ROLE_REVIEW_WORK_HOST_REQUIRED: context loop round already claimed; do not restart or reset counts. Stop; preserve the original plan, batch, drafts and attempts for host review. Do not retry, rotate IDs or mark the batch complete." });
  await new NovelCompilationRunStore(root).write(schedule);
  return { root, store, workId, options, taskHash, contextDir, attemptDir, unit, counterunit,
    packet: JSON.parse(original!.prompt.split("\n").at(-1)!), input: { sourceId: f.source.id, batchId: store.plan.batchId, candidateId,
      runId: recorder.manifest.id, authorizationRef: "explicit-user-resume-after-quota", implementationRef: "tested-dispatch-repair" } };
}

it.each(["transport", "tool", "output"])("refuses %s histories before granting dispatch", async mode => {
  const f = await fixture(mode);
  await expect(inspectRoleQuotaContinuation(f.root, f.input)).rejects.toThrow("zero-output provider refusal");
});
it.each(["budget", "attempt", "session", "claim"])("binds %s state and refuses changes after preview", async change => {
  const f = await fixture(), preview = await inspectRoleQuotaContinuation(f.root, f.input);
  if (change === "budget") { const b = roleReviewBudget(f.root, f.store.planHash, f.workId, ROLE_WORK_LIMITS, true, "progress"); b.beginCall({}); b.close(); }
  if (change === "attempt") await fs.rm(path.join(f.attemptDir, "2.json"));
  if (change === "session") await fs.writeFile(path.join(f.contextDir, "1.json"), "{}");
  if (change === "claim") f.store.journal.record("propose_role_roster_entry", { subjectHash: f.store.plan.subjectHash, entry: { ...f.packet.entry, rationale: "Changed" } }, "succeeded");
  await withWorkspaceOperationLock(f.root, "compiler", async () => {
    await expect(grantRoleQuotaContinuation(f.root, f.input, preview.authorityHash)).rejects.toThrow("ROLE_REVIEW_WORK_HOST_REQUIRED");
  });
  await expect(fs.stat(preview.file)).rejects.toMatchObject({ code: "ENOENT" });
});

it("reuses the reserved second invocation exactly once and retains all old charges and files", async () => {
  const f = await fixture(), preview = await inspectRoleQuotaContinuation(f.root, f.input);
  const before = inspectRoleReviewBudget(f.root, f.store.planHash, f.workId);
  const resume = { policy: "quota-refusal" as const, planHash: f.store.planHash, workId: f.workId, authorityHash: preview.authorityHash };
  await expect(grantRoleQuotaContinuation(f.root, f.input, preview.authorityHash)).rejects.toThrow("compiler lock");
  await withWorkspaceOperationLock(f.root, "compiler", async () => {
    await grantRoleQuotaContinuation(f.root, f.input, preview.authorityHash);
    await expect(claimReservedRoleQuotaAttempt(f.store, resume, "wrong-task")).rejects.toThrow("task changed");
    expect(await claimReservedRoleQuotaAttempt(f.store, resume, f.taskHash)).toBe(2);
    await expect(claimReservedRoleQuotaAttempt(f.store, resume, f.taskHash)).rejects.toThrow("already consumed");
  });
  expect(inspectRoleReviewBudget(f.root, f.store.planHash, f.workId)).toEqual(before);
  expect((await fs.readdir(f.attemptDir)).sort()).toEqual(["1.json", "2.json"]);
  for (const file of preview.authority.retainedFiles) expect(contentHash(await fs.readFile(path.join(worldStorageRoot(f.root), file.path), "utf8"))).toBe(file.hash);
});

it.each(["supported", "insufficient", "quota"])("runs the same claim through normal evidence gates and keeps the %s outcome", async verdict => {
  const f = await fixture(), preview = await inspectRoleQuotaContinuation(f.root, f.input);
  const before = inspectRoleReviewBudget(f.root, f.store.planHash, f.workId);
  const create = vi.spyOn(PiAgentSession, "create").mockImplementation(async options => {
    const budgets = Array.isArray(options.requestBudget) ? options.requestBudget : [options.requestBudget];
    return { dispose: async () => {}, abort: async () => {}, promptWithReport: async () => {
      for (const b of budgets) b?.beginCall({});
      if (verdict === "quota") throw Error(refusal);
      const tools = options.additionalTools!;
      expect(tools.some(t => t.name === "request_role_session_rebuild" || t.name === "request_role_work_evidence")).toBe(false);
      const invoke = (name: string, args: unknown) => tools.find(t => t.name === name)!.execute("fixture-call", args as never, undefined, undefined, {} as never);
      const audit = { candidateId: f.input.candidateId, claimRevision: f.packet.claimRevision, atlasRevision: f.packet.atlasRevision, packetHash: f.packet.packetHash,
        verdict, rationale: "Independent source assessment", basisUnitIds: [f.unit.id], counterevidence: { searchedUnitIds: [f.counterunit.id], rationale: "Read the separate observation" },
        checks: ["importance", "identity", "development"].map(kind => ({ kind, verdict: kind === "development" ? verdict : "supported", rationale: "Evidence checked", basisUnitIds: [f.unit.id] })) };
      expect((await invoke("propose_role_claim_audit", audit)).isError).toBe(true);
      expect(f.store.claimAudit(f.input.candidateId)).toBeUndefined();
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const result = await invoke("read_role_session_context", { offset });
        offset = JSON.parse((result.content[0] as { text: string }).text).nextOffset;
      }
      await invoke("read_role_work_evidence", { unitId: f.counterunit.id });
      await invoke("propose_role_claim_audit", audit);
    } } as unknown as PiAgentSession;
  });
  const resume = { policy: "quota-refusal" as const, planHash: f.store.planHash, workId: f.workId, authorityHash: preview.authorityHash };
  await withWorkspaceOperationLock(f.root, "compiler", async () => {
    await grantRoleQuotaContinuation(f.root, f.input, preview.authorityHash);
    const promise = runBoundedRoleReview({ ...f.options, claimQuotaResume: resume });
    if (verdict === "quota") await expect(promise).rejects.toThrow(refusal); else await promise;
    await expect(runBoundedRoleReview({ ...f.options, claimQuotaResume: resume })).rejects.toThrow("ROLE_REVIEW_WORK_HOST_REQUIRED");
  });
  expect(create).toHaveBeenCalledOnce();
  expect(f.store.claimAudit(f.input.candidateId)?.verdict).toBe(verdict === "quota" ? undefined : verdict);
  expect(inspectRoleReviewBudget(f.root, f.store.planHash, f.workId).state.usage.modelCalls).toBe(before.state.usage.modelCalls + 1);
  expect((await fs.readdir(f.contextDir)).sort()).toEqual(["0.json", "1.json"]);
  expect((await fs.readdir(f.attemptDir)).sort()).toEqual(["1.json", "2.json"]);
});
