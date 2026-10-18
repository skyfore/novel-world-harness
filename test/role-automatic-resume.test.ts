import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sourceAuditFixture } from "./helpers/role-source-audit.js";
import { contentHash } from "../src/world/canonical.js";
import { worldStorageRoot } from "../src/world/paths.js";
import { RoleContextCheckpoint } from "../src/compiler/role-context-window.js";
import { roleReviewBudget, inspectRetainedRoleReviewBudget, inspectRoleReviewBudget } from "../src/compiler/role-review-budget.js";
import { ROLE_WORK_LIMITS, runBoundedRoleReview } from "../src/workflow/role-review-bounded.js";
import { TraceStore } from "../src/trace/store.js";
import { TraceRecorder } from "../src/trace/recorder.js";
import { assertAutomaticRoleProgressHistory, inspectAutomaticRoleResume, claimAutomaticRoleResume,
  readAutomaticRoleCorrectionContinuation, readAutomaticRoleProgressContinuation } from "../src/compiler/role-automatic-resume.js";
import { openAutomaticRoleCorrectionBudget, recordAutomaticRoleCorrectionResult } from "../src/compiler/role-automatic-resume.js";
import { assertHostRepairDraft, readRoleAuditHostRepair } from "../src/compiler/role-audit-host-repair.js";
import { readRoleAuditNarrowRepair, ROLE_AUDIT_NARROW_REPAIR_TOOL } from "../src/compiler/role-audit-narrow-repair.js";
import { withWorkspaceOperationLock } from "../src/util/workspace-lock.js";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { ROLE_AUDIT_WORK_TOOL, roleWorkStop } from "../src/compiler/role-review-work.js";
import { roleFindingId } from "../src/compiler/role-review-verification.js";
import { reviewNovelRoles } from "../src/workflow/role-review.js";
import { inspectRoleProviderResumption, authorizeRoleProviderResumption, claimRoleProviderResumption,
  openProviderResumptionBudget, recordProviderResumptionResult, settledProviderResumption } from "../src/compiler/role-provider-resumption.js";

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
  await recorder.record("llm.request.started", { providerId: "openai-codex", modelId: "fixture" }, recorder.rootContext, { callId: "work" });
  b.beginCall({ original: true });
  await recorder.record("llm.response.completed", { providerId: "openai-codex", modelId: "fixture",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 } }, recorder.rootContext,
  { callId: "work", blobRef: await recorder.putBlob({ text: "read and preview" }) });
  await recorder.record("tool.call.started", { toolName: "read_role_session_context" }, recorder.rootContext, { toolCallId: "read", blobRef: await recorder.putBlob({ offset: 0 }) });
  if (mode !== "pending") await recorder.record("tool.call.completed", { toolName: "read_role_session_context" }, recorder.rootContext, { toolCallId: "read", blobRef: await recorder.putBlob({ isError: mode === "tool-error", content: [{ type: "text", text: JSON.stringify({ offset: 0, text: prompt, taskHash, complete: true }) }] }) });
  await recorder.record("tool.call.started", { toolName: "preview_role_review_audit" }, recorder.rootContext, { toolCallId: "preview", blobRef: await recorder.putBlob(f.audit) });
  await recorder.record("tool.call.completed", { toolName: "preview_role_review_audit" }, recorder.rootContext, { toolCallId: "preview", blobRef: await recorder.putBlob({ content: [{ type: "text", text: '{"valid":true}' }] }) });
  b.recordValidatedProgress(`draft:${taskHash}`); b.beginCall({ refused: true });
  await recorder.record("llm.request.started", { providerId: "openai-codex", modelId: "fixture" }, recorder.rootContext, { callId: "refused" });
  await recorder.record("llm.response.failed", { providerId: "openai-codex", errorMessage: mode === "other" ? "Network failure" : refusal,
    usage: mode === "charged" ? { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: 0 }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 } }, recorder.rootContext,
  { callId: "refused", blobRef: await recorder.putBlob({ error: mode === "other" ? "Network failure" : refusal }) });
  await recorder.record("validation.completed", { phase: "role-review-work-stopped", workId, budget: b.report() });
  await recorder.finish("failed", {}, { code: "ROLE_REVIEW_WORK_FAILED", message: `Error: ${mode === "other" ? "Network failure" : refusal}`, retryable: false }); b.close();
  return { ...f, workId, prompt, contextDir, taskHash, trace };
}

async function providerResumptionFixture(mode: "refusal" | "tool" | "charged" = "refusal") {
  const f = await fixture(), quota = (await inspectAutomaticRoleResume(f.store, 0))!;
  if (quota.authority.policy !== "compile-audit-quota-v1") throw new Error("expected quota fixture");
  await withWorkspaceOperationLock(f.root, "compiler", () => claimAutomaticRoleResume(f.store, quota));
  const claim = { planHash: f.store.planHash, workId: f.workId, taskHash: f.taskHash, ordinal: 2,
    budgetHash: quota.authority.budgetHash, recoveryInfo: { authorityHash: quota.authorityHash, failedRunId: quota.authority.runId } };
  await fs.writeFile(path.join(f.contextDir, "2.json"), JSON.stringify({ claim, hash: contentHash(claim) }));
  const budget = roleReviewBudget(f.root, f.store.planHash, f.workId, ROLE_WORK_LIMITS, true, "progress");
  const recorder = await TraceRecorder.start(f.trace, { kind: "prepare", sourceId: f.roster.sourceId, operationId: f.store.plan.batchId });
  await recorder.record("validation.completed", { phase: "role-review-work", planHash: f.store.planHash, workId: f.workId });
  await recorder.record("validation.completed", { phase: "role-request-observation", logicalTaskHash: f.taskHash, sessionOrdinal: 2 });
  budget.beginCall({ refused: "first-request" });
  budget.admitPayload({ refused: "first-request" });
  await recorder.record("llm.request.started", { providerId: "openai-codex", modelId: "fixture" }, recorder.rootContext, { callId: "refused" });
  if (mode === "tool") await recorder.record("tool.call.started", { toolName: "read_role_work_evidence" }, recorder.rootContext, { toolCallId: "uncertain-tool" });
  await recorder.record("llm.response.failed", { providerId: "openai-codex", errorMessage: refusal,
    usage: { input: mode === "charged" ? 1 : 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: mode === "charged" ? 1 : 0, cost: 0 } }, recorder.rootContext,
  { callId: "refused", blobRef: await recorder.putBlob({ error: refusal }) });
  await recorder.record("validation.completed", { phase: "role-review-work-stopped", workId: f.workId, budget: budget.report(), compactions: [] });
  await recorder.finish("failed", {}, { code: "ROLE_REVIEW_WORK_FAILED", message: `Error: ${refusal}`, retryable: false });
  budget.close();
  await new Promise(resolve => setTimeout(resolve, 2));
  const availabilityFile = path.join(f.root, "availability.json"), now = new Date().toISOString();
  await fs.writeFile(availabilityFile, JSON.stringify({ provider: "openai-codex", model: "fixture", capturedAt: now,
    completedAt: now, stopReason: "stop", error: null, text: "OK", usage: { totalTokens: 2 } }));
  const input = { page: 0, failedRunId: (await f.trace.peekRuns({ sourceId: f.roster.sourceId, kind: "prepare", limit: 1 }))[0]!.id,
    authorizationRef: "explicit user resumption after external outage", availabilityFile };
  return { ...f, quota, input };
}

async function checkpointInspection(f: Awaited<ReturnType<typeof providerResumptionFixture>>,
  mode: "complete" | "running" | "model" | "write" | "work" | "incomplete" = "complete") {
  const recorder = await TraceRecorder.start(f.trace, { kind: "prepare", sourceId: f.roster.sourceId,
    ...(mode === "work" ? { operationId: f.store.plan.batchId } : {}) });
  await recorder.record("validation.completed", { phase: "compiler-host", pid: process.pid, parentPid: process.ppid });
  await recorder.record("validation.completed", { phase: "compiler-checkpoints", total: 77, completed: 0,
    skipped: mode === "incomplete" ? 76 : 77, remaining: mode === "incomplete" ? 1 : 0 });
  if (mode === "model") await recorder.record("llm.request.started", { providerId: "openai-codex", modelId: "fixture" });
  if (mode === "write") await recorder.record("world.commit.completed", { commitId: "unexpected-write" });
  if (mode !== "running") await recorder.finish("succeeded");
}

it("permits only a completed zero-call checkpoint inspection ahead of the retained refusal", async () => {
  const f = await providerResumptionFixture(), original = await inspectRoleProviderResumption(f.store, f.input);
  await checkpointInspection(f);
  expect((await inspectRoleProviderResumption(f.store, f.input)).authorityHash).toBe(original.authorityHash);
});

it.each(["running", "model", "write", "work", "incomplete"] as const)(
  "retains the host stop for a later %s trace instead of treating it as read-only verification", async mode => {
    const f = await providerResumptionFixture();
    await checkpointInspection(f, mode);
    await expect(inspectRoleProviderResumption(f.store, f.input)).rejects.toThrow("later compiler invocation or uncertain checkpoint inspection");
  });

async function settledProviderResumptionFixture() {
  const f = await providerResumptionFixture(), before = inspectRoleReviewBudget(f.root, f.store.planHash, f.workId);
  const preview = await inspectRoleProviderResumption(f.store, f.input);
  expect(preview.authority.limits.maxModelCalls).toBe(before.state.progress!.lastProgressCall + ROLE_WORK_LIMITS.maxModelCalls);
  expect(preview.authority.budget.state).toEqual(before.state);
  await expect(authorizeRoleProviderResumption(f.store, f.input, preview.authorityHash)).rejects.toThrow("compiler lock");
  await withWorkspaceOperationLock(f.root, "compiler", () => authorizeRoleProviderResumption(f.store, f.input, preview.authorityHash));
  // Ordinary compile-novel repeats this read-only check after authorization.
  // Recovery must retain the exact authority when that trace becomes newest.
  await checkpointInspection(f);
  const originals = await Promise.all([f.quota.file, path.join(f.contextDir, "2.json")].map(file => fs.readFile(file, "utf8")));
  vi.spyOn(PiAgentSession, "create").mockImplementation(async options => ({
    dispose: async () => {}, abort: async () => {}, promptWithReport: async prompt => {
      if (!prompt.includes("Host-authorized provider resumption.")) throw new Error("downstream semantic repair remains required");
      expect(options.additionalTools!.map(t => t.name).sort()).toEqual(["read_role_work_evidence", "read_role_audit_inventory", "preview_role_review_audit", ROLE_AUDIT_WORK_TOOL].sort());
      for (const budget of Array.isArray(options.requestBudget) ? options.requestBudget : [options.requestBudget]) budget?.beginCall({ provider: "restored" });
      const tool = (name: string) => options.additionalTools!.find(t => t.name === name)!;
      await tool("read_role_work_evidence").execute("read", { unitId: f.unit }, undefined, undefined, {} as never);
      await tool("read_role_audit_inventory").execute("directory", { mode: "directory" }, undefined, undefined, {} as never);
      await tool("preview_role_review_audit").execute("preview", f.audit, undefined, undefined, {} as never);
      await tool(ROLE_AUDIT_WORK_TOOL).execute("propose", f.audit, undefined, undefined, {} as never);
    },
  }) as never);
  await expect(withWorkspaceOperationLock(f.root, "compiler", () => runBoundedRoleReview(f.options, undefined, vi.fn())))
    .rejects.toThrow("downstream semantic repair remains required");
  return { ...f, preview, before, originals };
}

it("resumes a zero-output refused final context only under new host authority and the original call ceiling", async () => {
  const f = await settledProviderResumptionFixture(), { before, originals } = f;
  expect(f.store.read("audit", 0)).toEqual(f.audit);
  expect(inspectRoleReviewBudget(f.root, f.store.planHash, f.workId)).toEqual(before);
  expect(inspectRetainedRoleReviewBudget(f.root, f.store.planHash, f.workId).state.usage.modelCalls).toBe(before.state.usage.modelCalls + 1);
  expect(await Promise.all([f.quota.file, path.join(f.contextDir, "2.json")].map(file => fs.readFile(file, "utf8")))).toEqual(originals);
  expect((await fs.readdir(f.contextDir)).sort()).toEqual(["0.json", "1.json", "2.json"]);
  await expect(assertAutomaticRoleProgressHistory(f.store)).resolves.toBeUndefined();
});

it("retains durable availability evidence and the original checkpoint after successful recovery", async () => {
  const f = await settledProviderResumptionFixture();
  const availability = await fs.readFile(f.input.availabilityFile, "utf8");
  expect(await fs.readFile(`${f.preview.file}.availability.json`, "utf8")).toBe(availability);
  for (const item of f.preview.authority.retainedFiles as Array<{ file: string; hash: string }>) {
    expect(contentHash(await fs.readFile(item.file, "utf8"))).toBe(item.hash);
  }
  await fs.rm(f.input.availabilityFile);
  await expect(assertAutomaticRoleProgressHistory(f.store)).resolves.toBeUndefined();
});

const retainedProviderFiles = ["parent grant", "ordinary context", "ordinary attempt", "original checkpoint", "durable availability", "recovery checkpoint"] as const;
it.each(retainedProviderFiles.flatMap(target => (["alter", "delete"] as const).map(change => ({ target, change }))))(
  "rejects $change of $target after successful provider recovery", async ({ target, change }) => {
    const f = await settledProviderResumptionFixture();
    await expect(assertAutomaticRoleProgressHistory(f.store)).resolves.toBeUndefined();
    const retained = f.preview.authority.retainedFiles as Array<{ file: string; hash: string }>;
    const file = target === "parent grant" ? f.quota.file
      : target === "ordinary context" ? path.join(f.contextDir, "2.json")
      : target === "ordinary attempt" ? retained.find(item => item.file.includes("/attempts/"))!.file
      : target === "original checkpoint" ? retained.find(item => item.file.includes("/context/"))!.file
      : target === "durable availability" ? `${f.preview.file}.availability.json`
      : settledProviderResumption(f.root, f.store.planHash, f.workId)!.checkpointFile!;
    expect(file).toBeTruthy();
    if (change === "delete") await fs.rm(file);
    else await fs.appendFile(file, "\n");
    await expect(assertAutomaticRoleProgressHistory(f.store)).rejects.toThrow(/evidence changed or is missing|checkpoint changed/);
  });

it.each(["first refusal", "final-context refusal", "successful recovery"] as const)(
  "revalidates the %s trace after successful provider recovery", async target => {
    const f = await settledProviderResumptionFixture();
    const runId = target === "first refusal" ? f.quota.authority.runId
      : target === "final-context refusal" ? f.input.failedRunId
      : settledProviderResumption(f.root, f.store.planHash, f.workId)!.trace.runId;
    const index = JSON.parse(await fs.readFile(f.trace.indexPath, "utf8"));
    const entry = index.runs.find((item: { id: string }) => item.id === runId);
    const manifest = path.join(f.trace.root, entry.relativePath, "manifest.json"), raw = await fs.readFile(manifest, "utf8");
    const changed = JSON.parse(raw); changed.counts.llmRequests++;
    await fs.writeFile(manifest, JSON.stringify(changed));
    await expect(assertAutomaticRoleProgressHistory(f.store)).rejects.toThrow("retained trace changed");
    await fs.writeFile(manifest, raw);
    await fs.rm(path.join(f.trace.root, entry.relativePath, "events.jsonl"));
    await expect(assertAutomaticRoleProgressHistory(f.store)).rejects.toThrow("retained trace changed or is missing");
  });

it("rejects deleted original evidence blobs after successful provider recovery", async () => {
  const f = await settledProviderResumptionFixture();
  const event = (await f.trace.peekEvents(f.quota.authority.runId)).find(item => item.blobRef)!;
  const sha = event.blobRef!.sha256;
  await fs.rm(path.join(f.trace.blobsRoot, sha.slice(0, 2), `${sha}.json`));
  await expect(assertAutomaticRoleProgressHistory(f.store)).rejects.toThrow("retained trace changed or is missing");
});

it("does not renew an explicit provider grant when its host context fails", async () => {
  const f = await providerResumptionFixture(), preview = await inspectRoleProviderResumption(f.store, f.input);
  await withWorkspaceOperationLock(f.root, "compiler", async () => {
    await authorizeRoleProviderResumption(f.store, f.input, preview.authorityHash);
    await claimRoleProviderResumption(f.store, preview);
    const budget = openProviderResumptionBudget(preview);
    budget.beginCall({ failedAgain: true }); budget.close();
    await recordProviderResumptionResult(f.store, preview, new Error(refusal));
    await expect(claimRoleProviderResumption(f.store, preview)).rejects.toThrow("already consumed");
    await expect(authorizeRoleProviderResumption(f.store, f.input, preview.authorityHash)).rejects.toThrow("already exists");
  });
  expect(() => settledProviderResumption(f.root, f.store.planHash, f.workId)).toThrow("failed");
  await expect(assertAutomaticRoleProgressHistory(f.store)).rejects.toThrow("failed");
  expect(f.store.read("audit", 0)).toBeUndefined();
});

it("rejects stale availability, altered dependencies and consumed progress in provider host recovery", async () => {
  const f = await providerResumptionFixture(), health = JSON.parse(await fs.readFile(f.input.availabilityFile, "utf8"));
  await fs.writeFile(f.input.availabilityFile, JSON.stringify({ ...health, model: "another-model" }));
  await expect(inspectRoleProviderResumption(f.store, f.input)).rejects.toThrow("availability check");
  await fs.writeFile(f.input.availabilityFile, JSON.stringify(health));
  await expect(inspectRoleProviderResumption(f.store, { ...f.input, authorizationRef: "" })).rejects.toThrow();
  const budget = roleReviewBudget(f.root, f.store.planHash, f.workId, ROLE_WORK_LIMITS, true, "progress");
  budget.beginCall({ laterAttempt: true }); budget.close();
  await expect(inspectRoleProviderResumption(f.store, f.input)).rejects.toThrow("allowance changed");
});

it.each(["tool", "charged"] as const)("does not reauthorize a refused context with %s activity", async mode => {
  const f = await providerResumptionFixture(mode);
  await expect(inspectRoleProviderResumption(f.store, f.input)).rejects.toThrow(mode === "tool" ? "zero tools" : "provider output");
});

async function noProgressFixture(closed = true) {
  const f = await fixture(), quota = (await inspectAutomaticRoleResume(f.store, 0))!;
  await withWorkspaceOperationLock(f.root, "compiler", () => claimAutomaticRoleResume(f.store, quota));
  const recoveryInfo = { reason: "User resumed compile-novel after a settled provider quota stop",
    failedRunId: quota.authority.runId, authorityHash: quota.authorityHash, retainedDraft: quota.authority.retainedDraft };
  const claim = { planHash: f.store.planHash, workId: f.workId, taskHash: f.taskHash, ordinal: 2,
    budgetHash: inspectRoleReviewBudget(f.root, f.store.planHash, f.workId).hash, recoveryInfo, at: new Date().toISOString() };
  await fs.writeFile(path.join(f.contextDir, "2.json"), JSON.stringify({ claim, hash: contentHash(claim) }));
  const draft = closed
    ? { ...f.audit, unresolved: [], questionDispositions: f.audit.questionDispositions.map(item => ({ ...item, status: "resolved" as const })) }
    : f.audit;
  const budget = roleReviewBudget(f.root, f.store.planHash, f.workId, ROLE_WORK_LIMITS, true, "progress");
  const recorder = await TraceRecorder.start(f.trace, { kind: "prepare", sourceId: f.roster.sourceId, operationId: f.store.plan.batchId });
  await recorder.record("validation.completed", { phase: "role-review-work", planHash: f.store.planHash, workId: f.workId,
    packetHash: contentHash("fresh quota context"), limits: ROLE_WORK_LIMITS, modelCallsMode: "progress" });
  const observe = () => recorder.record("validation.completed", { phase: "role-request-observation", planHash: f.store.planHash,
    workId: f.workId, logicalTaskHash: f.taskHash, sessionOrdinal: 2, recoveryReason: JSON.stringify(recoveryInfo) });
  const tool = async (name: string, id: string, args: unknown, result: unknown) => {
    await recorder.record("tool.call.started", { toolName: name }, recorder.rootContext, { toolCallId: id, blobRef: await recorder.putBlob(args) });
    await recorder.record("tool.call.completed", { toolName: name, isError: false }, recorder.rootContext, { toolCallId: id, blobRef: await recorder.putBlob(result) });
  };
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 };
  for (let index = 0; index < 11; index++) {
    budget.beginCall({ continued: index });
    await observe();
    const callId = `continued-${index}`;
    await recorder.record("llm.request.started", { providerId: "openai-codex", modelId: "fixture" }, recorder.rootContext, { callId });
    if (index === 10) {
      await recorder.record("llm.response.failed", { providerId: "openai-codex", errorMessage: "WebSocket closed 1006",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 } }, recorder.rootContext, { callId, blobRef: await recorder.putBlob({ error: "transport" }) });
      continue;
    }
    await recorder.record("llm.response.completed", { providerId: "openai-codex", usage }, recorder.rootContext, { callId, blobRef: await recorder.putBlob({ text: "ok" }) });
    if (index === 0) await tool("read_role_session_context", "restore", { offset: 0 }, { content: [{ type: "text", text: JSON.stringify({ offset: 0, text: f.prompt, taskHash: f.taskHash, complete: true }) }] });
    if (index === 8) await tool("read_role_work_evidence", "evidence", { unitId: f.unit }, { content: [{ type: "text", text: "{}" }] });
    if (index === 9) await tool("preview_role_review_audit", "draft", draft, { content: [{ type: "text", text: JSON.stringify({ valid: true, committed: false }) }] });
  }
  await recorder.record("llm.retry", { attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "WebSocket closed 1006" });
  let exhausted!: Error;
  try { budget.beginCall({ retry: true }); throw new Error("expected no-progress stop"); }
  catch (error) { exhausted = error as Error; }
  await recorder.record("llm.response.failed", { providerId: "openai-codex", errorMessage: exhausted.message,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 } }, recorder.rootContext,
    { callId: "pretransport-retry", blobRef: await recorder.putBlob({ error: exhausted.message }) });
  await recorder.record("validation.completed", { phase: "role-review-work-stopped", workId: f.workId, budget: budget.report(), compactions: [] });
  await recorder.finish("failed", {}, { code: "ROLE_REVIEW_WORK_FAILED", message: `Error: ${exhausted.message}`, retryable: false });
  budget.close();
  return { ...f, draft, quota };
}

async function correctionFixture(recordLateProgress = true) {
  const f = await sourceAuditFixture({ findings: [
    { name: "External rescuers", observation: "Unnamed rescuers decide whether to withdraw." },
    { name: "Hero receives letter", observation: "Hero remains central to the letter event." },
  ] });
  roots.push(f.root);
  const workId = f.store.workId("audit", 0), candidateId = f.roster.candidates[0]!.id;
  const discoveries = f.store.read("source", 0)!.findings.map((finding, index) => ({
    findingId: roleFindingId(f.store.planHash, 0, index), ...finding,
  }));
  const failedDraft = {
    rationale: "Retain the unresolved rescue boundary.", atlasRevision: f.store.atlasRevision(),
    missingMajorCharacters: [{ name: "Merged responder", rationale: "This draft incorrectly merged the assigned identity.", basisUnitIds: [f.unit] }],
    questionDispositions: f.store.questions(0).map(question => ({ questionId: question.questionId, status: "blocked" as const,
      rationale: "The assigned core does not settle delivery knowledge.", basisUnitIds: [f.unit] })),
    discoveryDispositions: [
      { findingId: discoveries[0]!.findingId, disposition: "missing-major" as const, candidateIds: [],
        rationale: "The unnamed rescuers have a consequential decision.", basisUnitIds: [f.unit] },
      { findingId: discoveries[1]!.findingId, disposition: "mapped" as const, candidateIds: [candidateId],
        rationale: "The existing Hero judgment covers this finding.", basisUnitIds: [f.unit] },
    ],
    unresolved: ["The rescuers remain unnamed and the delivery question remains open."],
  };
  const corrected = { ...failedDraft, missingMajorCharacters: [
    { name: "External rescuers", rationale: "The assigned unnamed rescuers make the consequential withdrawal decision and remain distinct.", basisUnitIds: [f.unit] },
  ] };
  const packet = { source: { page: 0 }, atlasRevision: f.store.atlasRevision(), expectedQuestions: f.store.questions(0), discoveries,
    coverage: { claimAuditsHash: contentHash(f.store.claimAudits()), entriesHash: f.store.entriesHash(),
      missingSourceWorkIds: [], missingCandidateIds: [], unresolvedClaimWorkIds: [] } };
  const prompt = `Original immutable audit correction\n${JSON.stringify(packet)}`, taskHash = contentHash(prompt);
  const budget = roleReviewBudget(f.root, f.store.planHash, workId, ROLE_WORK_LIMITS, false, "progress");
  await f.store.beginAttempt(workId); await f.store.beginAttempt(workId);
  for (let index = 0; index < 5; index++) {
    budget.beginCall({ retained: index });
    if (recordLateProgress && index === 2) budget.recordValidatedProgress(`retained:${taskHash}`);
  }
  const base = path.join(worldStorageRoot(f.root), "compiler", "role-review-work");
  const contextDir = path.join(base, "context-loops", f.store.planHash, contentHash(workId), taskHash);
  await fs.mkdir(contextDir, { recursive: true });
  for (const ordinal of [0, 1]) {
    const claim = { planHash: f.store.planHash, workId, taskHash, ordinal,
      budgetHash: inspectRoleReviewBudget(f.root, f.store.planHash, workId).hash, recoveryInfo: null, at: new Date().toISOString() };
    await fs.writeFile(path.join(contextDir, `${ordinal}.json`), JSON.stringify({ claim, hash: contentHash(claim) }));
  }
  const checkpoint = await RoleContextCheckpoint.open(f.root, f.store.planHash, workId, taskHash);
  await checkpoint.record("read_role_work_evidence", { unitId: f.unit }, { content: [{ type: "text", text: "{}" }] });
  const diagnostic = "missingMajorCharacters: Missing-major discovery must retain External rescuers. Copy the assigned discovery name into missingMajorCharacters with original evidence. Preserve the finding and correct once; never drop responsibilities.";
  const envelope = { proposal_id: workId, planHash: f.store.planHash, payload: failedDraft, entriesHash: f.store.entriesHash() };
  f.store.journal.record(ROLE_AUDIT_WORK_TOOL, envelope, "running");
  f.store.journal.record(ROLE_AUDIT_WORK_TOOL, envelope, "failed", `Error: ${diagnostic}`);
  const recovery = { version: 1, failedTool: ROLE_AUDIT_WORK_TOOL, category: "invalid-arguments", retryable: true,
    retryCondition: "At most one materially corrected retry in this assigned work while its original context and proposal correction remain available.",
    steps: ["Correct every listed path together and preview before the remaining proposal attempt."] };
  const failedResult = { content: [{ type: "text", text: `${diagnostic}\n\n<nwh-tool-recovery>\n${JSON.stringify(recovery)}\n</nwh-tool-recovery>` }],
    details: { nwhToolRecovery: recovery } };
  const trace = new TraceStore(f.root), recorder = await TraceRecorder.start(trace, {
    kind: "prepare", sourceId: f.roster.sourceId, operationId: f.store.plan.batchId,
  });
  await recorder.record("validation.completed", { phase: "role-review-work", planHash: f.store.planHash, workId,
    limits: ROLE_WORK_LIMITS, modelCallsMode: "progress" });
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 };
  const request = async (index: number, text = "tool") => {
    budget.beginCall({ incident: index });
    await recorder.record("validation.completed", { phase: "role-request-observation", planHash: f.store.planHash, workId,
      logicalTaskHash: taskHash, sessionOrdinal: 1, requestOrdinal: index, recoveryReason: null });
    const callId = `correction-${index}`;
    await recorder.record("llm.request.started", { providerId: "openai-codex", modelId: "fixture" }, recorder.rootContext, { callId });
    await recorder.record("llm.response.completed", { providerId: "openai-codex", modelId: "fixture", stopReason: index === 3 ? "stop" : "tool_use", usage },
      recorder.rootContext, { callId, blobRef: await recorder.putBlob({ content: [{ type: "text", text }], stopReason: index === 3 ? "stop" : "tool_use" }) });
  };
  await request(1);
  await recorder.record("tool.call.started", { toolName: "read_role_session_context" }, recorder.rootContext,
    { toolCallId: "restore", blobRef: await recorder.putBlob({ offset: 0 }) });
  await recorder.record("tool.call.completed", { toolName: "read_role_session_context", isError: false }, recorder.rootContext,
    { toolCallId: "restore", blobRef: await recorder.putBlob({ content: [{ type: "text", text: JSON.stringify({ offset: 0, text: prompt, taskHash, complete: true }) }] }) });
  await request(2);
  await recorder.record("tool.call.started", { toolName: ROLE_AUDIT_WORK_TOOL, inputHash: contentHash(failedDraft) }, recorder.rootContext,
    { toolCallId: "proposal", blobRef: await recorder.putBlob(failedDraft) });
  await recorder.record("tool.call.failed", { toolName: ROLE_AUDIT_WORK_TOOL, isError: true }, recorder.rootContext,
    { toolCallId: "proposal", blobRef: await recorder.putBlob(failedResult) });
  await request(3, "The invalid proposal was not committed. No correction allowance remains, so I stopped.");
  await recorder.record("validation.completed", { phase: "role-review-work-stopped", workId, budget: budget.report(), compactions: [] });
  const failure = roleWorkStop("model ended without the assigned work receipt");
  await recorder.finish("failed", {}, { code: "ROLE_REVIEW_WORK_FAILED", message: String(failure), retryable: false });
  budget.close();
  return { ...f, workId, candidateId, prompt, taskHash, contextDir, failedDraft, corrected, trace };
}

async function hostReadFaultFixture(foreignRead = false, exhausted = false) {
  const f = await correctionFixture(), preview = (await inspectAutomaticRoleResume(f.store, 0))!;
  if (preview.authority.policy !== "compile-audit-correction-v1") throw new Error("expected correction authority");
  await withWorkspaceOperationLock(f.root, "compiler", async () => {
    await claimAutomaticRoleResume(f.store, preview);
    const { budget, contextFile } = await openAutomaticRoleCorrectionBudget(f.store, preview);
    const recorder = await TraceRecorder.start(f.trace, { kind: "prepare", sourceId: f.roster.sourceId, operationId: f.store.plan.batchId });
    await recorder.record("validation.completed", { phase: "role-review-work", planHash: f.store.planHash, workId: f.workId,
      logicalTaskHash: f.taskHash, continuationAuthorityHash: preview.authorityHash });
    const request = async (index: number) => {
      budget.beginCall({ restored: index });
      await recorder.record("llm.request.started", { providerId: "openai-codex" }, recorder.rootContext, { callId: `call-${index}` });
      await recorder.record("llm.response.completed", { providerId: "openai-codex", stopReason: index === 0 ? "toolUse" : "stop" }, recorder.rootContext,
        { callId: `call-${index}`, blobRef: await recorder.putBlob({ content: [{ type: "text", text: index === 0 ? "read" : "host stop" }] }) });
    };
    await request(0);
    const args = { candidateId: foreignRead ? "foreign-id" : f.candidateId, mode: "detail" };
    const error = roleWorkStop("correction inventory reads must use only exact candidate IDs retained by the failed draft");
    await recorder.record("tool.call.started", { toolName: "read_role_audit_inventory", inputHash: contentHash(args) }, recorder.rootContext,
      { toolCallId: "read", blobRef: await recorder.putBlob(args) });
    await recorder.record("tool.call.failed", { toolName: "read_role_audit_inventory", isError: true }, recorder.rootContext,
      { toolCallId: "read", blobRef: await recorder.putBlob({ content: [{ type: "text", text: error.message }],
        details: { nwhToolRecovery: { category: "host-repair-required", retryable: false } } }) });
    await request(1);
    if (exhausted) await request(2);
    await recorder.record("validation.completed", { phase: "role-review-work-stopped", workId: f.workId, budget: budget.report() });
    await recorder.finish("failed", {}, { code: "ROLE_REVIEW_WORK_FAILED", message: String(error), retryable: false });
    budget.close();
    await recordAutomaticRoleCorrectionResult(f.store, preview, contextFile, error);
  });
  const parent = readAutomaticRoleCorrectionContinuation(f.root, f.store.planHash, f.workId)!;
  return { ...f, parent, corrected: { ...f.corrected,
    missingMajorCharacters: [...f.failedDraft.missingMajorCharacters, ...f.corrected.missingMajorCharacters] } };
}

async function fullDraftSchemaFaultFixture() {
  // Match the production incident: four calls remained in the original
  // progress window, three were allocated to the failed correction grant.
  const f = await correctionFixture(false), preview = (await inspectAutomaticRoleResume(f.store, 0))!;
  if (preview.authority.policy !== "compile-audit-correction-v1") throw new Error("expected correction authority");
  await withWorkspaceOperationLock(f.root, "compiler", async () => {
    await claimAutomaticRoleResume(f.store, preview);
    const { budget, contextFile } = await openAutomaticRoleCorrectionBudget(f.store, preview);
    const recorder = await TraceRecorder.start(f.trace, {
      kind: "prepare", sourceId: f.roster.sourceId, operationId: f.store.plan.batchId,
    });
    await recorder.record("validation.completed", {
      phase: "role-review-work",
      planHash: f.store.planHash,
      workId: f.workId,
      logicalTaskHash: f.taskHash,
      continuationAuthorityHash: preview.authorityHash,
    });
    const request = async (index: number, stopReason: "toolUse" | "stop") => {
      budget.beginCall({ fullDraftSchemaFault: index });
      const callId = `full-draft-${index}`;
      await recorder.record("llm.request.started", { providerId: "openai-codex" }, recorder.rootContext, { callId });
      await recorder.record("llm.response.completed", { providerId: "openai-codex", stopReason }, recorder.rootContext, {
        callId,
        blobRef: await recorder.putBlob({ content: [{ type: "text", text: stopReason === "stop" ? "host stop" : "tool" }], stopReason }),
      });
    };
    const successfulTool = async (name: string, id: string, args: Record<string, unknown>, value: unknown) => {
      await recorder.record("tool.call.started", { toolName: name, inputHash: contentHash(args) }, recorder.rootContext,
        { toolCallId: id, blobRef: await recorder.putBlob(args) });
      await recorder.record("tool.call.completed", { toolName: name, isError: false }, recorder.rootContext,
        { toolCallId: id, blobRef: await recorder.putBlob({ content: [{ type: "text", text: JSON.stringify(value) }] }) });
    };
    await request(0, "toolUse");
    await successfulTool("read_role_audit_inventory", "candidate", { candidateId: f.candidateId, mode: "detail" }, { mode: "detail" });
    await successfulTool("read_role_work_evidence", "evidence", { unitId: f.unit }, { unitId: f.unit });
    await request(1, "toolUse");
    const rejectedDraft = { ...f.corrected, rationale: "This over-broad preview rewrote a protected audit rationale." };
    const error = roleWorkStop("audit correction may change only missingMajorCharacters while retaining every blocked question, unresolved fact, discovery disposition and prior evidence basis");
    const args = rejectedDraft;
    await recorder.record("tool.call.started", { toolName: "preview_role_review_audit", inputHash: contentHash(args) }, recorder.rootContext,
      { toolCallId: "preview", blobRef: await recorder.putBlob(args) });
    await recorder.record("tool.call.failed", { toolName: "preview_role_review_audit", isError: true }, recorder.rootContext, {
      toolCallId: "preview",
      blobRef: await recorder.putBlob({
        content: [{ type: "text", text: error.message }],
        details: { nwhToolRecovery: { category: "host-repair-required", retryable: false } },
      }),
    });
    await request(2, "stop");
    await recorder.record("validation.completed", { phase: "role-review-work-stopped", workId: f.workId, budget: budget.report() });
    await recorder.finish("failed", {}, { code: "ROLE_REVIEW_WORK_FAILED", message: String(error), retryable: false });
    budget.close();
    await recordAutomaticRoleCorrectionResult(f.store, preview, contextFile, error);
  });
  const parent = readAutomaticRoleCorrectionContinuation(f.root, f.store.planHash, f.workId)!;
  return {
    ...f,
    parent,
    addition: { missingMajorCharacters: f.corrected.missingMajorCharacters },
    corrected: {
      ...f.failedDraft,
      missingMajorCharacters: [...f.failedDraft.missingMajorCharacters, ...f.corrected.missingMajorCharacters],
    },
  };
}

it("preserves each prior missing-character finding even when a replacement reuses all its evidence", async () => {
  const f = await hostReadFaultFixture();
  const dropped = { ...f.corrected, missingMajorCharacters: f.corrected.missingMajorCharacters.slice(1) };
  expect(dropped.missingMajorCharacters[0]!.basisUnitIds).toEqual(f.failedDraft.missingMajorCharacters[0]!.basisUnitIds);
  expect(() => assertHostRepairDraft(f.parent, dropped)).toThrow("complete prior character entry");
  const altered = { ...f.corrected, missingMajorCharacters: f.corrected.missingMajorCharacters.map((entry, index) => index ? entry : { ...entry, rationale: "weakened finding" }) };
  expect(() => assertHostRepairDraft(f.parent, altered)).toThrow("complete prior character entry");
  expect(assertHostRepairDraft(f.parent, f.corrected)).toEqual(f.corrected);
});

it("restores only the unspent call after an exact host read fault, through ordinary roles, without renewing its failed grant", async () => {
  const f = await hostReadFaultFixture();
  const preserved = await Promise.all(["", ".usage.json", ".result.json"].map(suffix => fs.readFile(f.parent.file + suffix, "utf8")));
  const preview = (await inspectAutomaticRoleResume(f.store, 0))!;
  expect(preview.authority).toMatchObject({ policy: "compile-audit-host-tool-repair-v1", remainingCalls: 1, additionalCalls: 0 });
  const entry = vi.fn(async () => { throw new Error("host repair reached bounded review"); });
  await expect(reviewNovelRoles({ root: f.root, sourceId: f.roster.sourceId }, entry)).rejects.toThrow("host repair reached bounded review");
  expect(entry).toHaveBeenCalledOnce();
  const create = vi.spyOn(PiAgentSession, "create").mockImplementation(async options => ({
    dispose: async () => {}, abort: async () => {}, promptWithReport: async prompt => {
      if (!prompt.includes("Host tool-fault restoration:")) throw new Error("downstream semantic repair remains required");
      expect(options.additionalTools!.map(tool => tool.name)).toEqual([ROLE_AUDIT_WORK_TOOL]);
      const packet = JSON.parse(prompt.split("\n").at(-1)!);
      expect(packet.restoredReads.some((item: any) => item.args.candidateId === f.candidateId && item.result.mode === "detail")).toBe(true);
      for (const budget of Array.isArray(options.requestBudget) ? options.requestBudget : [options.requestBudget]) budget?.beginCall({ correction: "final" });
      const result = await options.additionalTools![0]!.execute("proposal", f.corrected, undefined, undefined, {} as never);
      expect(result.terminate).toBe(true);
    },
  }) as never);
  await expect(withWorkspaceOperationLock(f.root, "compiler", () => runBoundedRoleReview(f.options, undefined, vi.fn())))
    .rejects.toThrow("downstream semantic repair remains required");
  expect(create).toHaveBeenCalledTimes(2);
  expect(f.store.read("audit", 0)).toEqual(f.corrected);
  expect(await Promise.all(["", ".usage.json", ".result.json"].map(suffix => fs.readFile(f.parent.file + suffix, "utf8")))).toEqual(preserved);
  const repair = readRoleAuditHostRepair(f.parent)!;
  expect(repair.usage.usage.modelCalls).toBe(f.parent.authority.limits.maxModelCalls);
  expect(inspectRetainedRoleReviewBudget(f.root, f.store.planHash, f.workId).state.usage.modelCalls).toBe(repair.usage.usage.modelCalls);
  expect((await fs.readdir(f.contextDir)).sort()).toEqual(["0.json", "1.json", "2.json"]);
  await expect(assertAutomaticRoleProgressHistory(f.store)).resolves.toBeUndefined();
  await expect(claimAutomaticRoleResume(f.store, preview)).rejects.toThrow("compiler lock");
});

it("uses one retained original call and an append-only schema after an exact over-broad audit preview", async () => {
  const f = await fullDraftSchemaFaultFixture();
  const preserved = await Promise.all(["", ".usage.json", ".result.json"].map(suffix => fs.readFile(f.parent.file + suffix, "utf8")));
  const preview = (await inspectAutomaticRoleResume(f.store, 0))!;
  expect(preview.authority).toMatchObject({
    policy: "compile-audit-narrow-schema-repair-v1",
    remainingCalls: 1,
    additionalCalls: 1,
    retainedProgressCalls: 1,
    limits: { maxModelCalls: f.parent.usage.usage.modelCalls + 1 },
  });
  const entry = vi.fn(async () => { throw new Error("narrow schema repair reached bounded review"); });
  await expect(reviewNovelRoles({ root: f.root, sourceId: f.roster.sourceId }, entry))
    .rejects.toThrow("narrow schema repair reached bounded review");
  expect(entry).toHaveBeenCalledOnce();

  const create = vi.spyOn(PiAgentSession, "create").mockImplementation(async options => ({
    dispose: async () => {}, abort: async () => {}, promptWithReport: async prompt => {
      if (!prompt.includes("Host narrow-schema restoration:")) throw new Error("downstream semantic repair remains required");
      expect(options.additionalTools!.map(tool => tool.name)).toEqual([ROLE_AUDIT_NARROW_REPAIR_TOOL]);
      const parameters = options.additionalTools![0]!.parameters as any;
      expect(Object.keys(parameters.properties)).toEqual(["missingMajorCharacters"]);
      expect(parameters.additionalProperties).toBe(false);
      const packet = JSON.parse(prompt.split("\n").at(-1)!);
      expect(packet).toMatchObject({
        exactMissingDiscoveryNames: ["External rescuers"],
        priorMissingMajorCharacters: f.failedDraft.missingMajorCharacters,
        cumulativeCalls: f.parent.usage.usage.modelCalls,
        maxCumulativeCalls: f.parent.usage.usage.modelCalls + 1,
      });
      expect(packet.restoredReads.some((item: any) => item.args.candidateId === f.candidateId && item.result.mode === "detail")).toBe(true);
      for (const budget of Array.isArray(options.requestBudget) ? options.requestBudget : [options.requestBudget]) {
        budget?.beginCall({ narrowSchemaRepair: true });
      }
      const result = await options.additionalTools![0]!.execute("append", f.addition, undefined, undefined, {} as never);
      expect(result.terminate).toBe(true);
    },
  }) as never);
  await expect(withWorkspaceOperationLock(f.root, "compiler", () => runBoundedRoleReview(f.options, undefined, vi.fn())))
    .rejects.toThrow("Repair cannot renew exhausted or unknown predecessor usage");
  expect(create).toHaveBeenCalledOnce();
  const receipt = f.store.read("audit", 0)!;
  expect(receipt).toEqual(f.corrected);
  expect(receipt.questionDispositions).toEqual(f.failedDraft.questionDispositions);
  expect(receipt.discoveryDispositions).toEqual(f.failedDraft.discoveryDispositions);
  expect(receipt.unresolved).toEqual(f.failedDraft.unresolved);
  expect(receipt.rationale).toBe(f.failedDraft.rationale);
  expect(await Promise.all(["", ".usage.json", ".result.json"].map(suffix => fs.readFile(f.parent.file + suffix, "utf8")))).toEqual(preserved);
  const repair = readRoleAuditNarrowRepair(f.parent)!;
  expect(repair.usage.usage.modelCalls).toBe(f.parent.usage.usage.modelCalls + 1);
  expect(inspectRetainedRoleReviewBudget(f.root, f.store.planHash, f.workId).state.usage.modelCalls)
    .toBe(repair.usage.usage.modelCalls);
  expect((await fs.readdir(f.contextDir)).sort()).toEqual(["0.json", "1.json", "2.json"]);
  await expect(assertAutomaticRoleProgressHistory(f.store)).resolves.toBeUndefined();
  await expect(withWorkspaceOperationLock(f.root, "compiler", () => claimAutomaticRoleResume(f.store, preview)))
    .rejects.toThrow("automatic audit recovery preview changed");
});

it.each(["foreign-read", "exhausted"])("does not restore %s as a host implementation fault", async mode => {
  const f = await hostReadFaultFixture(mode === "foreign-read", mode === "exhausted");
  await expect(inspectAutomaticRoleResume(f.store, 0)).rejects.toThrow("ROLE_REVIEW_WORK_HOST_REQUIRED");
  expect(readRoleAuditHostRepair(f.parent)).toBeUndefined();
});

it("a host-restored correction cannot drop responsibilities or be claimed again after failure", async () => {
  const f = await hostReadFaultFixture();
  const create = vi.spyOn(PiAgentSession, "create").mockImplementation(async options => ({
    dispose: async () => {}, abort: async () => {}, promptWithReport: async () => {
      for (const budget of Array.isArray(options.requestBudget) ? options.requestBudget : [options.requestBudget]) budget?.beginCall({ correction: "final" });
      await options.additionalTools![0]!.execute("proposal", { ...f.corrected, unresolved: [] }, undefined, undefined, {} as never);
    },
  }) as never);
  await expect(withWorkspaceOperationLock(f.root, "compiler", () => runBoundedRoleReview(f.options, undefined, vi.fn())))
    .rejects.toThrow("must preserve every responsibility");
  await expect(withWorkspaceOperationLock(f.root, "compiler", () => runBoundedRoleReview(f.options, undefined, vi.fn())))
    .rejects.toThrow("already claimed");
  expect(create).toHaveBeenCalledOnce();
  expect(f.store.read("audit", 0)).toBeUndefined();
});

it("routes one exact retained audit correction through the ordinary roles entry point", async () => {
  const f = await correctionFixture();
  const history = f.store.journal.history(ROLE_AUDIT_WORK_TOOL, f.workId);
  const preview = (await inspectAutomaticRoleResume(f.store, 0))!;
  if (preview.authority.policy !== "compile-audit-correction-v1") throw new Error("expected audit-correction preview");
  const review = vi.fn(async options => {
    expect(options).toMatchObject({ compilerBatchId: f.store.plan.batchId, automaticRecovery: true, acquireLock: false });
    throw new Error("exact correction reached bounded review");
  });

  await expect(reviewNovelRoles({ root: f.root, sourceId: f.roster.sourceId }, review))
    .rejects.toThrow("exact correction reached bounded review");

  expect(review).toHaveBeenCalledOnce();
  expect(f.store.journal.history(ROLE_AUDIT_WORK_TOOL, f.workId)).toEqual(history);
  await expect(fs.stat(preview.file)).rejects.toMatchObject({ code: "ENOENT" });
});

it("previews a partially executed quota stop without writes, retaining the exact task and draft", async () => {
  const f = await fixture(), first = await inspectAutomaticRoleResume(f.store, 0), second = await inspectAutomaticRoleResume(f.store, 0);
  expect(first).toEqual(second);
  expect(first!.originalPrompt).toBe(f.prompt);
  const budget = inspectRoleReviewBudget(f.root, f.store.planHash, f.workId);
  expect(first!.authority).toMatchObject({ attempt: 2, nextOrdinal: 2, retainedDraft: f.audit,
    startingUsage: budget.state.usage, maxAdditionalModelCalls: 11, maxNewSessions: 1 });
  await expect(fs.stat(first!.file)).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["pending", "tool-error", "other", "charged"])("does not resume %s outcomes as quota failures", async mode => {
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
  const preview = (await inspectAutomaticRoleResume(f.store, 0))!;
  if (preview.authority.policy !== "compile-audit-quota-v1") throw new Error("expected quota preview");
  const create = vi.spyOn(PiAgentSession, "create").mockImplementation(async options => ({
    dispose: async () => {}, abort: async () => {}, promptWithReport: async () => {
      const budgets = Array.isArray(options.requestBudget) ? options.requestBudget : [options.requestBudget];
      expect(budgets.some(budget => budget?.limits.maxModelCalls === preview.authority.maxAdditionalModelCalls)).toBe(true);
      expect(options.additionalTools!.map(tool => tool.name)).not.toContain("request_role_session_rebuild");
      expect(options.additionalTools!.map(tool => tool.name)).not.toContain("request_role_work_evidence");
      for (const b of budgets) b?.beginCall({ resumed: true });
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

it("turns the exact final-context transport loss into one narrowed cumulative continuation", async () => {
  const f = await noProgressFixture();
  const before = inspectRoleReviewBudget(f.root, f.store.planHash, f.workId), preview = (await inspectAutomaticRoleResume(f.store, 0))!;
  if (preview.authority.policy !== "compile-audit-no-progress-v1") throw new Error("expected no-progress preview");
  expect(preview.authority).toMatchObject({ policy: "compile-audit-no-progress-v1", additionalCalls: 3,
    limits: { maxModelCalls: before.state.usage.modelCalls + 3 }, retainedDraft: f.draft });
  expect(preview.authority.requiredUnitIds).toContain(f.unit);
  const finalize = vi.fn();
  const create = vi.spyOn(PiAgentSession, "create").mockImplementation(async options => ({
    dispose: async () => {}, abort: async () => {}, promptWithReport: async prompt => {
      expect(prompt).toContain("single-use, exact-trace-bound continuation");
      expect(options.additionalTools!.map(tool => tool.name).sort()).toEqual([
        "propose_role_review_audit", "read_role_audit_inventory", "read_role_work_evidence",
      ]);
      for (const item of Array.isArray(options.requestBudget) ? options.requestBudget : [options.requestBudget]) item?.beginCall({ narrowed: true });
      const invoke = (name: string, input: unknown) => options.additionalTools!.find(tool => tool.name === name)!.execute(name, input as never, undefined, undefined, {} as never);
      for (const unitId of preview.authority.requiredUnitIds) {
        let offset: number | undefined;
        do {
          const result = await invoke("read_role_work_evidence", { unitId, ...(offset === undefined ? {} : { offset }) });
          const body = JSON.parse((result.content[0] as { text: string }).text);
          offset = body.nextOffset;
        } while (offset !== undefined);
      }
      for (const candidateId of preview.authority.requiredCandidateIds) await invoke("read_role_audit_inventory", { candidateId });
      await invoke("propose_role_review_audit", f.draft);
    },
  }) as never);
  await withWorkspaceOperationLock(f.root, "compiler", () => runBoundedRoleReview(f.options, undefined, finalize));
  expect(create).toHaveBeenCalledOnce();
  expect(finalize).toHaveBeenCalledOnce();
  expect(f.store.read("audit", 0)).toEqual(f.draft);
  const unchanged = inspectRoleReviewBudget(f.root, f.store.planHash, f.workId);
  expect(unchanged.hash).toBe(before.hash);
  expect(unchanged.state).toEqual(before.state);
  const continuation = readAutomaticRoleProgressContinuation(f.root, f.store.planHash, f.workId)!;
  expect(continuation.usage.usage.modelCalls).toBe(before.state.usage.modelCalls + 1);
  expect(inspectRetainedRoleReviewBudget(f.root, f.store.planHash, f.workId).state).toMatchObject({
    blocked: true, usage: { modelCalls: before.state.usage.modelCalls + 1 },
  });
  expect(JSON.parse(await fs.readFile(`${continuation.file}.result.json`, "utf8"))).toMatchObject({ status: "succeeded", authorityHash: continuation.authorityHash });
  expect((await fs.readdir(f.contextDir)).sort()).toEqual(["0.json", "1.json", "2.json"]);
  await expect(assertAutomaticRoleProgressHistory(f.store)).resolves.toBeUndefined();
});

it("commits the retained blocked responsibilities unchanged before the preserved stop governs downstream repair", async () => {
  const f = await noProgressFixture(false), preview = (await inspectAutomaticRoleResume(f.store, 0))!;
  if (preview.authority.policy !== "compile-audit-no-progress-v1") throw new Error("expected no-progress preview");
  const create = vi.spyOn(PiAgentSession, "create").mockImplementation(async options => ({
    dispose: async () => {}, abort: async () => {}, promptWithReport: async () => {
      for (const item of Array.isArray(options.requestBudget) ? options.requestBudget : [options.requestBudget]) item?.beginCall({ narrowed: true });
      const invoke = (name: string, input: unknown) => options.additionalTools!.find(tool => tool.name === name)!.execute(name, input as never, undefined, undefined, {} as never);
      for (const unitId of preview.authority.requiredUnitIds) await invoke("read_role_work_evidence", { unitId });
      for (const candidateId of preview.authority.requiredCandidateIds) await invoke("read_role_audit_inventory", { candidateId });
      await invoke("propose_role_review_audit", f.draft);
    },
  }) as never);
  await expect(withWorkspaceOperationLock(f.root, "compiler", () => runBoundedRoleReview(f.options, undefined, vi.fn())))
    .rejects.toThrow("Repair cannot renew exhausted or unknown predecessor usage");
  expect(create).toHaveBeenCalledOnce();
  expect(f.store.read("audit", 0)).toEqual(f.audit);
  expect(f.store.read("audit", 0)?.questionDispositions).toEqual(f.audit.questionDispositions);
  expect(f.store.read("audit", 0)?.unresolved).toEqual(f.audit.unresolved);
  const continuation = readAutomaticRoleProgressContinuation(f.root, f.store.planHash, f.workId)!;
  expect(JSON.parse(await fs.readFile(`${continuation.file}.result.json`, "utf8"))).toMatchObject({ status: "succeeded" });
});

it("records a failed narrowed grant as terminal instead of renewing it", async () => {
  const f = await noProgressFixture();
  vi.spyOn(PiAgentSession, "create").mockImplementation(async options => ({
    dispose: async () => {}, abort: async () => {}, promptWithReport: async () => {
      for (const item of Array.isArray(options.requestBudget) ? options.requestBudget : [options.requestBudget]) item?.beginCall({ narrowed: true });
      throw new Error("fixture provider failure");
    },
  }) as never);
  await expect(withWorkspaceOperationLock(f.root, "compiler", () => runBoundedRoleReview(f.options, undefined, vi.fn()))).rejects.toThrow("fixture provider failure");
  const continuation = readAutomaticRoleProgressContinuation(f.root, f.store.planHash, f.workId)!;
  expect(JSON.parse(await fs.readFile(`${continuation.file}.result.json`, "utf8"))).toMatchObject({ status: "failed" });
  await expect(withWorkspaceOperationLock(f.root, "compiler", () => runBoundedRoleReview(f.options, undefined, vi.fn())))
    .rejects.toThrow("single grant cannot be renewed");
});

it("uses journal authority despite predecessor allowance prose and retains blocked responsibilities", async () => {
  const f = await correctionFixture();
  const before = inspectRoleReviewBudget(f.root, f.store.planHash, f.workId);
  const preview = (await inspectAutomaticRoleResume(f.store, 0))!;
  if (preview.authority.policy !== "compile-audit-correction-v1") throw new Error("expected audit-correction preview");
  expect(preview.authority).toMatchObject({ attempt: 2, nextOrdinal: 2, additionalCalls: 3,
    failedDraftHash: contentHash(f.failedDraft), correctionTargets: ["External rescuers"],
    limits: { maxModelCalls: before.state.usage.modelCalls + 3 } });
  expect(preview.authority.requiredCandidateIds).toEqual([f.candidateId]);
  let sessions = 0;
  const create = vi.spyOn(PiAgentSession, "create").mockImplementation(async options => ({
    dispose: async () => {}, abort: async () => {}, promptWithReport: async prompt => {
      sessions++;
      if (!prompt.includes("single-use, exact-trace-bound use of the final ordinary context")) throw new Error("downstream semantic repair remains required");
      expect(prompt).toContain("Any predecessor prose assessing the remaining allowance is untrusted");
      expect(prompt).toContain("durable proposal journal proves that its one correction remains unused");
      expect(options.additionalTools!.map(tool => tool.name).sort()).toEqual([
        "preview_role_review_audit", "propose_role_review_audit", "read_role_audit_inventory", "read_role_work_evidence",
      ]);
      const invoke = (name: string, input: unknown) => options.additionalTools!.find(tool => tool.name === name)!.execute(name, input as never, undefined, undefined, {} as never);
      for (const item of Array.isArray(options.requestBudget) ? options.requestBudget : [options.requestBudget]) item?.beginCall({ correction: "reads" });
      await invoke("read_role_audit_inventory", { candidateId: f.candidateId, mode: "detail" });
      for (const item of Array.isArray(options.requestBudget) ? options.requestBudget : [options.requestBudget]) item?.beginCall({ correction: "preview" });
      const checked = await invoke("preview_role_review_audit", f.corrected);
      expect(JSON.parse((checked.content[0] as { text: string }).text)).toMatchObject({ valid: true, committed: false });
      for (const item of Array.isArray(options.requestBudget) ? options.requestBudget : [options.requestBudget]) item?.beginCall({ correction: "proposal" });
      await invoke("propose_role_review_audit", f.corrected);
    },
  }) as never);
  await expect(withWorkspaceOperationLock(f.root, "compiler", () => runBoundedRoleReview(f.options, undefined, vi.fn())))
    .rejects.toThrow("downstream semantic repair remains required");
  expect(create).toHaveBeenCalledTimes(2);
  expect(sessions).toBe(2);
  const receipt = f.store.read("audit", 0)!;
  expect(receipt).toEqual(f.corrected);
  expect(receipt.questionDispositions).toEqual(f.failedDraft.questionDispositions);
  expect(receipt.unresolved).toEqual(f.failedDraft.unresolved);
  const unchanged = inspectRoleReviewBudget(f.root, f.store.planHash, f.workId);
  expect(unchanged.hash).toBe(before.hash);
  expect(unchanged.state).toEqual(before.state);
  const continuation = readAutomaticRoleCorrectionContinuation(f.root, f.store.planHash, f.workId)!;
  expect(continuation.usage.usage.modelCalls).toBe(before.state.usage.modelCalls + 3);
  expect(JSON.parse(await fs.readFile(`${continuation.file}.result.json`, "utf8"))).toMatchObject({
    status: "succeeded", authorityHash: continuation.authorityHash, receiptHash: contentHash(f.corrected),
  });
  expect(inspectRetainedRoleReviewBudget(f.root, f.store.planHash, f.workId).state.usage.modelCalls)
    .toBe(before.state.usage.modelCalls + 3);
  expect((await fs.readdir(f.contextDir)).sort()).toEqual(["0.json", "1.json", "2.json"]);
  await expect(assertAutomaticRoleProgressHistory(f.store)).resolves.toBeUndefined();
});

it("keeps blocked questions immutable and makes a violated audit-correction grant terminal", async () => {
  const f = await correctionFixture();
  const create = vi.spyOn(PiAgentSession, "create").mockImplementation(async options => ({
    dispose: async () => {}, abort: async () => {}, promptWithReport: async () => {
      const invoke = (name: string, input: unknown) => options.additionalTools!.find(tool => tool.name === name)!.execute(name, input as never, undefined, undefined, {} as never);
      for (const item of Array.isArray(options.requestBudget) ? options.requestBudget : [options.requestBudget]) item?.beginCall({ correction: "reads" });
      await invoke("read_role_audit_inventory", { candidateId: f.candidateId });
      for (const item of Array.isArray(options.requestBudget) ? options.requestBudget : [options.requestBudget]) item?.beginCall({ correction: "invalid-preview" });
      await invoke("preview_role_review_audit", { ...f.corrected, unresolved: [],
        questionDispositions: f.corrected.questionDispositions.map(item => ({ ...item, status: "resolved" })) });
    },
  }) as never);
  await expect(withWorkspaceOperationLock(f.root, "compiler", () => runBoundedRoleReview(f.options, undefined, vi.fn())))
    .rejects.toThrow("may change only missingMajorCharacters");
  const continuation = readAutomaticRoleCorrectionContinuation(f.root, f.store.planHash, f.workId)!;
  expect(JSON.parse(await fs.readFile(`${continuation.file}.result.json`, "utf8"))).toMatchObject({ status: "failed" });
  expect(f.store.read("audit", 0)).toBeUndefined();
  await expect(withWorkspaceOperationLock(f.root, "compiler", () => runBoundedRoleReview(f.options, undefined, vi.fn())))
    .rejects.toThrow("single grant cannot be renewed");
  expect(create).toHaveBeenCalledOnce();
  await expect(f.store.beginAttempt(f.workId)).rejects.toThrow("allowance exhausted");
});
