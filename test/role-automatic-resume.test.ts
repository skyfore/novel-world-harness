import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sourceAuditFixture } from "./helpers/role-source-audit.js";
import { contentHash } from "../src/world/canonical.js";
import { worldStorageRoot } from "../src/world/paths.js";
import { RoleContextCheckpoint } from "../src/compiler/role-context-window.js";
import { roleReviewBudget, inspectRoleReviewBudget } from "../src/compiler/role-review-budget.js";
import { ROLE_WORK_LIMITS, runBoundedRoleReview } from "../src/workflow/role-review-bounded.js";
import { TraceStore } from "../src/trace/store.js";
import { TraceRecorder } from "../src/trace/recorder.js";
import { inspectAutomaticRoleResume, claimAutomaticRoleResume } from "../src/compiler/role-automatic-resume.js";
import { withWorkspaceOperationLock } from "../src/util/workspace-lock.js";
import { PiAgentSession } from "../src/agent/pi-session.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const refusal = "Codex error: The usage limit has been reached";
async function fixture(mode = "quota") {
  const f = await sourceAuditFixture(); roots.push(f.root);
  const workId = f.store.workId("audit", 0);
  const packet = { source: { page: 0 }, atlasRevision: f.store.atlasRevision(), expectedQuestions: f.store.questions(0), discoveries: [],
    coverage: { claimAuditsHash: contentHash(f.store.claimAudits()), missingSourceWorkIds: [], missingCandidateIds: [], unresolvedClaimWorkIds: [] } };
  const prompt = `Original immutable audit\n${JSON.stringify(packet)}`, taskHash = contentHash(prompt);
  const b = roleReviewBudget(f.root, f.store.planHash, workId, ROLE_WORK_LIMITS, false, "progress");
  await f.store.beginAttempt(workId); await f.store.beginAttempt(workId);
  const base = path.join(worldStorageRoot(f.root), "compiler", "role-review-work");
  const contextDir = path.join(base, "context-loops", f.store.planHash, contentHash(workId), taskHash);
  await fs.mkdir(contextDir, { recursive: true });
  for (const ordinal of [0, 1]) {
    const claim = { planHash: f.store.planHash, workId, taskHash, ordinal, budgetHash: inspectRoleReviewBudget(f.root, f.store.planHash, workId).hash };
    await fs.writeFile(path.join(contextDir, `${ordinal}.json`), JSON.stringify({ claim, hash: contentHash(claim) }));
  }
  const checkpoint = await RoleContextCheckpoint.open(f.root, f.store.planHash, workId, taskHash);
  await checkpoint.record("read_role_work_evidence", { unitId: f.unit }, { content: [{ type: "text", text: "{}" }] });
  const trace = new TraceStore(f.root), recorder = await TraceRecorder.start(trace, { kind: "prepare", sourceId: f.roster.sourceId, operationId: f.store.plan.batchId });
  await recorder.record("validation.completed", { phase: "role-review-work", planHash: f.store.planHash, workId, packetHash: contentHash("restoration prompt") });
  await recorder.record("validation.completed", { phase: "role-request-observation", logicalTaskHash: taskHash, sessionOrdinal: 1 });
  await recorder.record("llm.request.started", { providerId: "openai-codex", modelId: "fixture" });
  b.beginCall({ original: true });
  await recorder.record("tool.call.started", { toolName: "read_role_session_context" }, recorder.rootContext, { toolCallId: "read", blobRef: await recorder.putBlob({ offset: 0 }) });
  if (mode !== "pending") await recorder.record("tool.call.completed", { toolName: "read_role_session_context" }, recorder.rootContext, { toolCallId: "read", blobRef: await recorder.putBlob({ isError: mode === "tool-error", content: [{ type: "text", text: JSON.stringify({ offset: 0, text: prompt, taskHash, complete: true }) }] }) });
  await recorder.record("tool.call.started", { toolName: "preview_role_review_audit" }, recorder.rootContext, { toolCallId: "preview", blobRef: await recorder.putBlob(f.audit) });
  await recorder.record("tool.call.completed", { toolName: "preview_role_review_audit" }, recorder.rootContext, { toolCallId: "preview", blobRef: await recorder.putBlob({ content: [{ type: "text", text: '{"valid":true}' }] }) });
  b.recordValidatedProgress(`draft:${taskHash}`); b.beginCall({ refused: true });
  await recorder.record("llm.response.failed", { providerId: "openai-codex", errorMessage: mode === "other" ? "Network failure" : refusal });
  await recorder.record("validation.completed", { phase: "role-review-work-stopped", workId, budget: b.report() });
  await recorder.finish("failed", {}, { code: "ROLE_REVIEW_WORK_FAILED", message: `Error: ${mode === "other" ? "Network failure" : refusal}`, retryable: false }); b.close();
  return { ...f, workId, prompt, contextDir, taskHash, trace };
}

it("previews a partially executed quota stop without writes, retaining the exact task and draft", async () => {
  const f = await fixture(), first = await inspectAutomaticRoleResume(f.store, 0), second = await inspectAutomaticRoleResume(f.store, 0);
  expect(first).toEqual(second);
  expect(first!.originalPrompt).toBe(f.prompt);
  expect(first!.authority).toMatchObject({ attempt: 2, nextOrdinal: 2, retainedDraft: f.audit });
  await expect(fs.stat(first!.file)).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["pending", "tool-error", "other"])("does not resume %s outcomes as quota failures", async mode => {
  const f = await fixture(mode);
  await expect(inspectAutomaticRoleResume(f.store, 0)).rejects.toThrow("ROLE_REVIEW_WORK_HOST_REQUIRED");
});
it("rechecks the retained budget before claiming and never grants an additional semantic attempt", async () => {
  const f = await fixture(), preview = (await inspectAutomaticRoleResume(f.store, 0))!;
  await expect(claimAutomaticRoleResume(f.store, preview)).rejects.toThrow("compiler lock");
  await withWorkspaceOperationLock(f.root, "compiler", async () => {
    expect(await claimAutomaticRoleResume(f.store, preview)).toBe(2);
    await expect(claimAutomaticRoleResume(f.store, preview)).rejects.toThrow("already claimed");
  });
  await expect(f.store.beginAttempt(f.workId)).rejects.toThrow("allowance exhausted");
});
it("the normal workflow restores the original context, finishes the interrupted audit and retains every prior call", async () => {
  const f = await fixture(), before = inspectRoleReviewBudget(f.root, f.store.planHash, f.workId), finalize = vi.fn();
  const create = vi.spyOn(PiAgentSession, "create").mockImplementation(async options => ({
    dispose: async () => {}, abort: async () => {}, promptWithReport: async () => {
      for (const b of Array.isArray(options.requestBudget) ? options.requestBudget : [options.requestBudget]) b?.beginCall({ resumed: true });
      const invoke = (name: string, input: unknown) => options.additionalTools!.find(t => t.name === name)!.execute(name, input as never, undefined, undefined, {} as never);
      const closed = { ...f.audit, unresolved: [], questionDispositions: f.audit.questionDispositions.map(q => ({ ...q, status: "resolved" })) };
      expect((await invoke("propose_role_review_audit", closed)).isError).toBe(true);
      let offset: number | undefined = 0;
      do { const r = await invoke("read_role_session_context", { offset }); offset = JSON.parse((r.content[0] as { text: string }).text).nextOffset; } while (offset !== undefined);
      await invoke("read_role_work_evidence", { unitId: f.unit });
      await invoke("propose_role_review_audit", closed);
    },
  }) as never);
  await withWorkspaceOperationLock(f.root, "compiler", () => runBoundedRoleReview(f.options, undefined, finalize));
  expect(create).toHaveBeenCalledOnce(); expect(finalize).toHaveBeenCalledOnce();
  expect(f.store.auditComplete()).toBe(true);
  expect(inspectRoleReviewBudget(f.root, f.store.planHash, f.workId).state.usage.modelCalls).toBe(before.state.usage.modelCalls + 1);
  expect((await fs.readdir(f.contextDir)).sort()).toEqual(["0.json", "1.json", "2.json"]);
});

it("refuses automatic continuation if usage changed after the original stop", async () => {
  const f = await fixture(), preview = (await inspectAutomaticRoleResume(f.store, 0))!;
  const b = roleReviewBudget(f.root, f.store.planHash, f.workId, ROLE_WORK_LIMITS, true, "progress");
  b.beginCall({ subsequent: true }); b.close();
  await withWorkspaceOperationLock(f.root, "compiler", () => expect(claimAutomaticRoleResume(f.store, preview)).rejects.toThrow("changed or exhausted usage"));
  await expect(fs.stat(preview.file)).rejects.toMatchObject({ code: "ENOENT" });
});
