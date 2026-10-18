import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { contentHash } from "../src/world/canonical.js";
import { worldStorageRoot } from "../src/world/paths.js";
import { TraceStore } from "../src/trace/store.js";
import { loadCurrentRoleRoster } from "../src/compiler/role-roster-tools.js";
import { ensureSourceStructure } from "../src/compiler/structure.js";
import { RoleRosterStore, roleRosterSchema } from "../src/compiler/role-roster.js";
import { ROLE_AUDIT_WORK_TOOL, RoleReviewWorkStore, roleWorkStop } from "../src/compiler/role-review-work.js";
import { beginCoreRoleReviewRevision } from "../src/compiler/role-review-revision-service.js";
import { assertRetainedRoleWork } from "../src/compiler/role-work-migration.js";
import { claimExhaustedMigratedSourceAudit, inspectExhaustedMigratedSourceAudit, inspectMigratedSourceAudit } from "../src/compiler/role-source-audit-revalidation.js";
import { inspectRoleReviewBudget, roleReviewBudget } from "../src/compiler/role-review-budget.js";
import { ROLE_WORK_LIMITS, runBoundedRoleReview } from "../src/workflow/role-review-bounded.js";
import { runWithRoleContextRecovery } from "../src/workflow/role-session-context.js";
import { NovelCompilationRunStore, newNovelCompilationRun } from "../src/workflow/novel-compilation.js";
import { withWorkspaceOperationLock } from "../src/util/workspace-lock.js";
import { PiAgentSession } from "../src/agent/pi-session.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function recordRoleTrace(store: RoleReviewWorkStore, workId: string, taskHash: string, sessionOrdinal: number, status: "failed" | "succeeded") {
  const traces = new TraceStore(store.root);
  const run = await traces.createRun({ kind: "prepare", sourceId: store.plan.sourceId, operationId: store.plan.batchId });
  await traces.appendEvent(run.id, { type: "validation.completed", spanId: run.rootSpanId,
    data: { phase: "role-review-work", workId, planHash: store.planHash, packetHash: taskHash, limits: ROLE_WORK_LIMITS } });
  const callId = `call-${status}-${sessionOrdinal}`;
  await traces.appendEvent(run.id, { type: "validation.completed", spanId: run.rootSpanId,
    data: { phase: "role-request-observation", workId, planHash: store.planHash, logicalTaskHash: taskHash,
      sessionOrdinal, requestOrdinal: 1, evidenceEpoch: 0 } });
  await traces.appendEvent(run.id, { type: "llm.request.started", spanId: run.rootSpanId, callId,
    data: { providerId: "fixture", modelId: "fixture" } });
  await traces.appendEvent(run.id, { type: "llm.response.completed", spanId: run.rootSpanId, callId,
    data: { providerId: "fixture", modelId: "fixture" } });
  if (status === "succeeded") {
    const toolCallId = `tool-${sessionOrdinal}`;
    await traces.appendEvent(run.id, { type: "tool.call.started", spanId: run.rootSpanId, callId, toolCallId,
      data: { toolName: ROLE_AUDIT_WORK_TOOL, inputHash: contentHash(store.read("audit", 0)) } });
    await traces.appendEvent(run.id, { type: "tool.call.completed", spanId: run.rootSpanId, callId, toolCallId,
      data: { toolName: ROLE_AUDIT_WORK_TOOL, isError: false } });
    const budget = inspectRoleReviewBudget(store.root, store.planHash, workId);
    await traces.appendEvent(run.id, { type: "validation.completed", spanId: run.rootSpanId,
      data: { phase: "role-review-work-usage", workId, budget: { usage: budget.state.usage,
        ...(budget.state.progress ? { progress: { ...budget.state.progress, callsWithoutProgress: budget.state.usage.modelCalls - budget.state.progress.lastProgressCall,
          stallWindowCalls: ROLE_WORK_LIMITS.maxModelCalls } } : {}), blocked: budget.state.blocked } } });
  }
  await traces.finishRun(run.id, status, status === "failed"
    ? { error: { code: "ROLE_REVIEW_WORK_FAILED", message: "settled fixture refusal", retryable: false } } : {});
}

async function fixture(options: { exhausted?: boolean; blocked?: boolean; noReceipt?: boolean; recoverableExhausted?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-audit-revalidation-")); roots.push(root);
  const source = await createEvidenceFixture(root, "Hero helps Friend.\nFriend thanks Hero.\n");
  await ensureSourceStructure(root, source.source);
  const canon = new CanonicalModelStore(root);
  for (const name of ["Hero", "Friend"]) await canon.putEntity({ id: name.toLowerCase(), canonicalName: name,
    kind: "character", aliases: [], evidence: source.evidence(name) });
  const { roster, structure } = await loadCurrentRoleRoster(root, source.source.id), unit = roster.unitIds[0]!;
  const old = await RoleReviewWorkStore.open(root, { version: 1, sourceId: roster.sourceId, sourceHash: roster.sourceSha256,
    subjectHash: roster.subjectHash, batchId: `role-roster-${roster.sourceId}-old`, structureHash: contentHash(structure),
    spans: [{ start: 0, end: source.source.bytes }], legacyDraftHashes: [] });
  await old.submit("source", 0, { summary: "An exchange", findings: [], openQuestions: ["What is their earlier relationship?"] }, () => {});
  const entries = roster.candidates.map(c => ({ candidateId: c.id, importance: "major" as const, rationale: "Source interaction", basisUnitIds: [unit],
    developmentExpectation: { kind: "unknown" as const, rationale: "No later evidence", basisUnitIds: [unit] } }));
  for (const entry of entries) old.journal.record("propose_role_roster_entry", { subjectHash: roster.subjectHash, entry }, "succeeded");
  const oldWorkId = old.workId("audit", 0);
  const budget = roleReviewBudget(root, old.planHash, oldWorkId, ROLE_WORK_LIMITS, false, "progress");
  const originalPrompt = "Original source audit", originalTaskHash = contentHash(originalPrompt);
  await old.beginAttempt(oldWorkId);
  if (options.recoverableExhausted) {
    const contextDirectory = path.join(worldStorageRoot(root), "compiler", "role-review-work", "context-loops",
      old.planHash, contentHash(oldWorkId), originalTaskHash);
    const recordContext = async (ordinal: number) => {
      await fs.mkdir(contextDirectory, { recursive: true });
      const claim = { planHash: old.planHash, workId: oldWorkId, taskHash: originalTaskHash, ordinal,
        budgetHash: inspectRoleReviewBudget(root, old.planHash, oldWorkId).hash, recoveryInfo: null, at: new Date().toISOString() };
      await fs.writeFile(path.join(contextDirectory, `${ordinal}.json`), JSON.stringify({ claim, hash: contentHash(claim) }));
    };
    budget.beginCall({ original: 1 });
    await recordContext(0);
    await recordRoleTrace(old, oldWorkId, originalTaskHash, 0, "failed");
    await old.beginAttempt(oldWorkId);
    budget.beginCall({ original: 2 });
    await recordContext(1);
    if (!options.noReceipt) {
      await old.submit("audit", 0, { rationale: "Retained diagnostic", missingMajorCharacters: [], unresolved: ["Earlier relationship unknown"],
        atlasRevision: old.atlasRevision(), questionDispositions: old.questions(0).map(q => ({ questionId: q.questionId, status: "blocked", rationale: "Earlier events not established", basisUnitIds: [unit] })), discoveryDispositions: [] }, () => {});
      budget.recordValidatedProgress(`receipt:${originalTaskHash}`);
    }
    await recordRoleTrace(old, oldWorkId, originalTaskHash, 1, "succeeded");
  } else {
    await runWithRoleContextRecovery(old, { workId: oldWorkId, prompt: originalPrompt, tools: [], complete: () => true }, async () => {
      budget.beginCall({ original: true });
      if (!options.noReceipt) await old.submit("audit", 0, { rationale: "Retained diagnostic", missingMajorCharacters: [], unresolved: ["Earlier relationship unknown"],
        atlasRevision: old.atlasRevision(), questionDispositions: old.questions(0).map(q => ({ questionId: q.questionId, status: "blocked", rationale: "Earlier events not established", basisUnitIds: [unit] })), discoveryDispositions: [] }, () => {});
    });
    if (options.exhausted) await old.beginAttempt(oldWorkId);
  }
  if (options.blocked) {
    for (let call = 1; call < ROLE_WORK_LIMITS.maxModelCalls; call++) budget.beginCall({ call });
    expect(() => budget.beginCall({ over: true })).toThrow("no new validated progress");
  }
  budget.close();
  const saved = roleRosterSchema.parse({ ...roster, reviews: [{ runId: "legacy-review", subjectHash: roster.subjectHash, reviewedUnitIds: roster.unitIds, entries }] });
  await new RoleRosterStore(root).write(saved);
  const hero = await canon.getEntity("hero"); await canon.putEntity({ ...hero, aliases: ["Source alias"] });
  const revision = await beginCoreRoleReviewRevision(root, { sourceId: roster.sourceId, revisionId: "changed-subject", priorRosterHash: contentHash(saved),
    expectedWorkPlanHash: old.planHash, scopeDecisionRef: "fixture-subject-review", reason: "Revalidate the changed subject, retaining old evidence and every allowance" });
  const store = new RoleReviewWorkStore(root, revision.workMigration!.nextPlan), workId = store.workId("audit", 0);
  // Complete independent current claim verification, with no source audit import.
  for (const entry of store.stagedEntries()) await store.submitClaim({ candidateId: entry.candidateId, claimRevision: contentHash(entry), atlasRevision: store.atlasRevision(),
    packetHash: contentHash(entry), verdict: "supported", rationale: "The unknown boundary follows the fixture", basisUnitIds: [unit], counterevidence: { searchedUnitIds: [unit], rationale: "No further evidence" },
    checks: ["importance", "identity", "development"].map(kind => ({ kind, verdict: "supported", rationale: "Source boundary retained", basisUnitIds: [unit] })) }, entry.candidateId, () => {});
  const scope = { planHash: store.planHash, atlasRevision: store.atlasRevision(), entriesHash: store.entriesHash(), claimAuditsHash: contentHash(store.claimAudits()),
    workIds: [workId], missingSourceWorkIds: [], missingCandidateIds: [], unresolvedClaimWorkIds: [] };
  const runOptions = { root, sourceId: roster.sourceId, compilerBatchId: store.plan.batchId, configPath: path.join(root, "absent.yaml") };
  if (options.recoverableExhausted) {
    const run = newNovelCompilationRun(source.source);
    const now = Date.now(), startedAt = new Date(now).toISOString(), finishedAt = new Date(now + 1).toISOString();
    run.history.push({ phase: "roles", startedAt, finishedAt, status: "blocked", error: roleWorkStop("work invocation allowance exhausted").message });
    run.history.push({ phase: "opening", startedAt: new Date(now + 2).toISOString(), finishedAt: new Date(now + 3).toISOString(), status: "completed" });
    run.history.push({ phase: "roles", startedAt: new Date(now + 4).toISOString(), status: "running" });
    await new NovelCompilationRunStore(root).write(run);
  }
  return { root, old, store, workId, oldWorkId, unit, revision, scope, runOptions };
}

it("revalidates a migrated diagnostic with inherited calls and session ordinals, preserving negative findings and all global gates", async () => {
  const f = await fixture(), proof = await inspectMigratedSourceAudit(f.store, f.workId), finalize = vi.fn();
  const before = inspectRoleReviewBudget(f.root, f.old.planHash, f.oldWorkId);
  await expect(f.store.assertUnstarted(f.workId)).rejects.toThrow("work already started");
  let sessions = 0;
  await runBoundedRoleReview({ ...f.runOptions, sourceAuditScope: { ...f.scope, migratedAudits: [proof] } }, async work => {
    const allowance = f.store.inheritedAllowance(work.workId)!;
    const budget = roleReviewBudget(f.root, f.store.planHash, work.workId, ROLE_WORK_LIMITS, true, "progress", allowance.budget);
    expect(budget.snapshot().modelCalls).toBe(before.state.usage.modelCalls);
    await runWithRoleContextRecovery(f.store, work, async invocation => {
      sessions++;
      expect(invocation.sessionOrdinal).toBe(1);
      const call = (name: string, args: unknown) => invocation.tools.find(t => t.name === name)!.execute(name, args as never, undefined, undefined, {} as never);
      let offset: number | undefined = 0;
      do { const result = await call("read_role_session_context", { offset }); offset = JSON.parse((result.content[0] as { text: string }).text).nextOffset; } while (offset !== undefined);
      budget.beginCall({ revalidation: true });
      await call("read_role_work_evidence", { unitId: f.unit });
      await call("propose_role_review_audit", { rationale: "Current subject independently checked", missingMajorCharacters: [], unresolved: ["Earlier relationship still unknown"],
        atlasRevision: f.store.atlasRevision(), questionDispositions: f.store.questions(0).map(q => ({ questionId: q.questionId, status: "blocked", rationale: "Original source gives no prior history", basisUnitIds: [f.unit] })), discoveryDispositions: [] });
    });
    budget.close();
  }, finalize);
  expect(sessions).toBe(1);
  expect(finalize).not.toHaveBeenCalled();
  expect(f.store.read("audit", 0)?.unresolved).toEqual(["Earlier relationship still unknown"]);
  expect(f.store.auditComplete()).toBe(false);
  expect(inspectRoleReviewBudget(f.root, f.store.planHash, f.workId).state.usage.modelCalls).toBe(before.state.usage.modelCalls + 1);
  expect(inspectRoleReviewBudget(f.root, f.old.planHash, f.oldWorkId)).toEqual(before);
  await assertRetainedRoleWork(f.root, f.revision.workMigration!);
  await expect(f.store.beginAttempt(f.workId)).rejects.toThrow("allowance exhausted");
  await expect(inspectMigratedSourceAudit(f.store, f.workId)).rejects.toThrow("already exists");
});

it("claims one trace-bound final context for a successful but invocation-exhausted migrated audit", async () => {
  const f = await fixture({ recoverableExhausted: true });
  const prompt = "Current subject audit with unchanged semantic validators", taskHash = contentHash(prompt);
  const priorReceipt = f.old.journal.history(ROLE_AUDIT_WORK_TOOL, f.oldWorkId).at(-1)!;
  const priorBudget = inspectRoleReviewBudget(f.root, f.old.planHash, f.oldWorkId);
  const preview = await inspectExhaustedMigratedSourceAudit(f.store, f.workId, taskHash);

  expect(preview.authority).toMatchObject({
    policy: "compile-migrated-audit-invocation-v1", workId: f.workId, priorWorkId: f.oldWorkId,
    startingUsage: priorBudget.state.usage, maxAdditionalModelCalls: ROLE_WORK_LIMITS.maxModelCalls,
    maxNewInvocations: 1, maxNewSessions: 1, nextSessionOrdinal: 2,
  });
  expect(preview.authority.traces.map(trace => [trace.status, trace.sessionOrdinal])).toEqual([["failed", 0], ["succeeded", 1]]);
  expect(preview.authority.priorReceiptHash).toBe(contentHash(priorReceipt));
  expect(preview.authority.priorAtlasRevision !== preview.authority.atlasRevision
    || preview.authority.priorEntriesHash !== preview.authority.entriesHash).toBe(true);

  const resume = await withWorkspaceOperationLock(f.root, "compiler", () => claimExhaustedMigratedSourceAudit(f.store, preview));
  await expect(inspectExhaustedMigratedSourceAudit(f.store, f.workId, taskHash)).rejects.toThrow("already consumed");

  const currentBudget = roleReviewBudget(f.root, f.store.planHash, f.workId, ROLE_WORK_LIMITS, true, "progress", f.store.inheritedAllowance(f.workId)!.budget);
  currentBudget.close();
  const unavailable = ["request_role_work_evidence", "request_role_session_rebuild"].map(name => ({ name, execute: vi.fn() })) as never;
  let sessions = 0;
  await runWithRoleContextRecovery(f.store, { workId: f.workId, prompt, tools: unavailable,
    hardModelCallLimit: resume.maxAdditionalModelCalls, complete: () => Boolean(f.store.read("audit", 0)) }, async invocation => {
    sessions++;
    expect(invocation.sessionOrdinal).toBe(2);
    expect(invocation.hardModelCallLimit).toBe(ROLE_WORK_LIMITS.maxModelCalls);
    expect(invocation.tools.map(tool => tool.name)).not.toContain("request_role_work_evidence");
    expect(invocation.tools.map(tool => tool.name)).not.toContain("request_role_session_rebuild");
    await f.store.submit("audit", 0, { rationale: "Current subject checked independently", missingMajorCharacters: [], unresolved: [],
      atlasRevision: f.store.atlasRevision(), questionDispositions: f.store.questions(0).map(question => ({ questionId: question.questionId,
        status: "resolved", rationale: "The supplied exchange establishes the scoped relationship", basisUnitIds: [f.unit] })),
      discoveryDispositions: [] }, () => {});
  }, undefined, resume);

  expect(sessions).toBe(1);
  expect(f.store.read("audit", 0)?.unresolved).toEqual([]);
  expect(inspectRoleReviewBudget(f.root, f.store.planHash, f.workId).state.usage).toEqual(priorBudget.state.usage);
  expect(inspectRoleReviewBudget(f.root, f.old.planHash, f.oldWorkId)).toEqual(priorBudget);
  await assertRetainedRoleWork(f.root, f.revision.workMigration!);
  await expect(inspectExhaustedMigratedSourceAudit(f.store, f.workId, taskHash)).rejects.toThrow(/single-use|settled|proposal history/);
});

it("lets the next ordinary bounded compiler invoke the narrowed grant through unchanged audit validation", async () => {
  const f = await fixture({ recoverableExhausted: true }), finalize = vi.fn();
  const before = f.store.inheritedAllowance(f.workId)!.budget!.state.usage.modelCalls;
  const create = vi.spyOn(PiAgentSession, "create").mockImplementation(async options => {
    const budgets = Array.isArray(options.requestBudget) ? options.requestBudget : [options.requestBudget!];
    return { promptWithReport: async () => {
      for (const budget of budgets) budget?.beginCall({ fixture: "migrated audit" });
      const tools = options.additionalTools!;
      expect(tools.some(tool => tool.name === "request_role_work_evidence" || tool.name === "request_role_session_rebuild")).toBe(false);
      const invoke = (name: string, args: unknown) => tools.find(tool => tool.name === name)!
        .execute(`fixture-${name}`, args as never, undefined, undefined, {} as never);
      let offset: number | undefined = 0;
      do {
        const result = await invoke("read_role_session_context", { offset });
        offset = JSON.parse((result.content[0] as { text: string }).text).nextOffset;
      } while (offset !== undefined);
      const audit = { rationale: "Current subject independently revalidated", missingMajorCharacters: [], unresolved: [],
        atlasRevision: f.store.atlasRevision(), questionDispositions: f.store.questions(0).map(question => ({ questionId: question.questionId,
          status: "resolved", rationale: "The original exchange supports the scoped disposition", basisUnitIds: [f.unit] })),
        discoveryDispositions: [] };
      const preview = await invoke("preview_role_review_audit", audit);
      expect(JSON.parse((preview.content[0] as { text: string }).text)).toMatchObject({ valid: true, committed: false });
      await invoke(ROLE_AUDIT_WORK_TOOL, audit);
      return {} as never;
    }, dispose: async () => {}, abort: async () => {} } as unknown as PiAgentSession;
  });

  await withWorkspaceOperationLock(f.root, "compiler", () => runBoundedRoleReview({ ...f.runOptions, automaticRecovery: true }, undefined, finalize));

  expect(create).toHaveBeenCalledOnce();
  expect(f.store.read("audit", 0)?.unresolved).toEqual([]);
  expect(finalize).toHaveBeenCalledOnce();
  expect(inspectRoleReviewBudget(f.root, f.store.planHash, f.workId).state.usage.modelCalls).toBe(before + 1);
  const attempts = path.join(worldStorageRoot(f.root), "compiler", "role-review-work", "v1", contentHash(f.store.plan.sourceId),
    "attempts", contentHash(f.store.plan.batchId), contentHash(f.workId));
  expect(await fs.readdir(attempts).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error))).toEqual([]);
});

it("never routes a failed narrowed grant into another automatic continuation", async () => {
  const f = await fixture({ recoverableExhausted: true });
  const create = vi.spyOn(PiAgentSession, "create").mockImplementation(async options => ({
    promptWithReport: async () => {
      const budgets = Array.isArray(options.requestBudget) ? options.requestBudget : [options.requestBudget!];
      for (const budget of budgets) budget?.beginCall({ fixture: "consumed failure" });
      throw Error("settled narrowed fixture failure");
    }, dispose: async () => {}, abort: async () => {},
  }) as unknown as PiAgentSession);

  await withWorkspaceOperationLock(f.root, "compiler", async () => {
    await expect(runBoundedRoleReview({ ...f.runOptions, automaticRecovery: true }, undefined, vi.fn()))
      .rejects.toThrow("settled narrowed fixture failure");
    await expect(runBoundedRoleReview({ ...f.runOptions, automaticRecovery: true }, undefined, vi.fn()))
      .rejects.toThrow("single-use migrated-audit invocation grant");
  });
  expect(create).toHaveBeenCalledOnce();
  expect(f.store.read("audit", 0)).toBeUndefined();
});

it("does not convert a bare inherited attempt count into migrated-audit authority", async () => {
  const f = await fixture({ exhausted: true });
  await expect(inspectExhaustedMigratedSourceAudit(f.store, f.workId, contentHash("current prompt")))
    .rejects.toThrow("two retained invocations, two settled contexts");
});

it.each(["missing", "changed", "duplicate"] as const)("rejects a %s migration proof before reserving an invocation", async kind => {
  const f = await fixture(), proof = await inspectMigratedSourceAudit(f.store, f.workId), runner = vi.fn();
  const migratedAudits = kind === "missing" ? undefined : kind === "changed" ? [{ ...proof, priorReceiptHash: "0".repeat(64) }] : [proof, proof];
  await expect(runBoundedRoleReview({ ...f.runOptions, sourceAuditScope: { ...f.scope, migratedAudits } }, runner, vi.fn())).rejects.toThrow(/already started|preview changed|invalid source audit scope/);
  expect(runner).not.toHaveBeenCalled();
  expect(await inspectMigratedSourceAudit(f.store, f.workId)).toEqual(proof);
});

it.each(["exhausted", "blocked", "noReceipt"] as const)("does not reopen a migrated audit with %s predecessor state", async kind => {
  const f = await fixture({ [kind]: true });
  await expect(inspectMigratedSourceAudit(f.store, f.workId)).rejects.toThrow(/remaining invocation|terminal receipt/);
  await assertRetainedRoleWork(f.root, f.revision.workMigration!);
});

it.each(["attempt", "checkpoint", "budget"] as const)("refuses a current-plan %s even without a proposal", async kind => {
  const f = await fixture();
  if (kind === "attempt") await f.store.beginAttempt(f.workId);
  else {
    const base = path.join(worldStorageRoot(f.root), "compiler", "role-review-work", kind === "checkpoint" ? "context" : "budgets", f.store.planHash);
    await fs.mkdir(base, { recursive: true });
    await fs.writeFile(path.join(base, contentHash(f.workId) + ".json.pending"), "uncertain original task");
  }
  await expect(inspectMigratedSourceAudit(f.store, f.workId)).rejects.toThrow("already has invocation, context or budget state");
});

it("rejects changed predecessor files and wrong work scope without creating a new task", async () => {
  const f = await fixture();
  await expect(inspectMigratedSourceAudit(f.store, f.store.workId("source", 0))).rejects.toThrow("select a migrated source audit");
  const old = roleReviewBudget(f.root, f.old.planHash, f.oldWorkId, ROLE_WORK_LIMITS, true, "progress");
  old.beginCall({ changed: true }); old.close();
  await expect(inspectMigratedSourceAudit(f.store, f.workId)).rejects.toThrow("retained work or budget changed");
});
