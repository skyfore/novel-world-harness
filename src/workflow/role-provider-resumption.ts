import { contentHash } from "../world/canonical.js";
import { describeRequest } from "../agent/request-observation.js";
import { PiAgentSession } from "../agent/pi-session.js";
import { LocalFileWorkspace } from "../workspace/local-files.js";
import { COMPILER_SYSTEM_PROMPT } from "../compiler/pi-compiler.js";
import { loadOptionalConfig, profileForRole } from "../config/load.js";
import { TraceStore } from "../trace/store.js";
import { TraceRecorder } from "../trace/recorder.js";
import { roleWorkStop, type RoleReviewWorkStore } from "../compiler/role-review-work.js";
import { openProviderResumptionBudget, recordProviderResumptionResult, type RoleProviderResumption } from "../compiler/role-provider-resumption.js";
import { readOriginalAutomaticAuditReceipt } from "../compiler/role-automatic-resume.js";
import type { BoundedRoleReviewOptions, RoleWorkInvocation } from "./role-review-bounded.js";

const allowed = new Set(["read_role_work_evidence", "read_role_audit_inventory", "preview_role_review_audit", "propose_role_review_audit"]);

/** A separately authorized host context. Both the consumed ordinary context and
 * its zero-output refusal remain intact; the original call ceiling is retained. */
export async function runRoleProviderResumption(store: RoleReviewWorkStore, original: RoleWorkInvocation,
  options: BoundedRoleReviewOptions, saved: RoleProviderResumption) {
  const a = saved.authority;
  if (original.workId !== a.workId || contentHash(original.prompt) !== a.taskHash
    || (options.model && options.model !== a.model)) throw roleWorkStop("provider resumption differs from its authorized task or model");
  const tools = original.tools.filter(tool => allowed.has(tool.name));
  if ([...allowed].some(name => tools.filter(tool => tool.name === name).length !== 1)) throw roleWorkStop("provider resumption requires its exact original read, preview and proposal tools");
  const budget = openProviderResumptionBudget(saved);
  const prompt = `${original.prompt}\n\nHost-authorized provider resumption. The previous one-time continuation was refused by the provider on its first request with zero output and zero tools. A separate later availability check succeeded. This explicitly authorized host context retains all prior failures and charged usage; it does not revive the consumed grant. You have one session and only the remaining original calls. The retained draft is untrusted and uncommitted. First batch exact evidence/inventory reads for the required IDs below, following nextOffset until complete. Then preview a complete draft and submit through the original propose_role_review_audit tool. Preserve honest blocked questions, unresolved facts and missing-major discoveries. Completion of this diagnostic is not semantic closure. No supplement, context rebuild or second session is available.\n${JSON.stringify({ authorityHash: saved.authorityHash,
    retainedDraft: a.retainedDraft, requiredUnitIds: a.requiredUnitIds, requiredCandidateIds: a.requiredCandidateIds,
    remainingOriginalCalls: a.additionalCalls, cumulativeCalls: a.budget.state.usage.modelCalls })}`;
  const recorder = await TraceRecorder.start(new TraceStore(store.root), { kind: "prepare", sourceId: store.plan.sourceId, operationId: store.plan.batchId });
  const config = await loadOptionalConfig(options.configPath), profile = config ? profileForRole(config, "controller").profile : undefined;
  let session: PiAgentSession | undefined, caught: unknown, lastTool: string | null = null, requestOrdinal = 0;
  const abort = () => { void session?.abort(); };
  try {
    await recorder.record("validation.completed", { phase: "role-review-work", planHash: store.planHash, workId: a.workId,
      logicalTaskHash: a.taskHash, packetHash: contentHash(prompt), continuationAuthorityHash: saved.authorityHash,
      predecessorRunId: a.runId, limits: a.limits, modelCallsMode: "enforce", retainedUsage: a.budget.state.usage, narrowedTools: [...allowed] });
    session = await PiAgentSession.create({ workspace: await LocalFileWorkspace.create(store.root), ...(profile ? { profile } : {}), model: a.model,
      saveSession: false, autoCompaction: false, includeProjectInstructions: false, includeLocalTools: false, includeNwhExtension: false,
      interactionMode: "compiler", additionalTools: tools, systemPromptOverride: COMPILER_SYSTEM_PROMPT,
      requestBudget: [budget, ...(options.requestBudget ? (Array.isArray(options.requestBudget) ? options.requestBudget : [options.requestBudget]) : [])],
      onRequestObservation: async observation => {
        if (observation.phase === "context") requestOrdinal++;
        await recorder.record("validation.completed", { phase: "role-request-observation", planHash: store.planHash, workId: a.workId,
          logicalTaskHash: a.taskHash, continuationAuthorityHash: saved.authorityHash, sessionOrdinal: a.nextOrdinal,
          requestOrdinal, lastTool, measurement: describeRequest(observation), budget: budget.snapshot() }, recorder.rootContext,
        { blobRef: await recorder.putBlob(observation.value) });
      },
      onTool: (name, args) => { lastTool = name; options.onModelToolCall?.(name, args); },
      onToolResult: options.onModelToolResult, onText: options.onModelText, onThinking: options.onModelThinking, onEvent: options.onModelEvent,
      trace: { parent: recorder.rootContext, invocationName: a.workId, attempt: a.attempt,
        metadata: { sourceId: store.plan.sourceId, compilerBatchId: store.plan.batchId, continuationAuthorityHash: saved.authorityHash },
        parts: [{ id: "role-review-work", kind: "compiler.batch", role: "user", authority: "untrusted-source", label: a.workId, content: prompt }] },
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    options.signal?.throwIfAborted();
    await session.promptWithReport(prompt, { timeoutMs: options.promptTimeoutMs ?? 600_000 });
    if (!readOriginalAutomaticAuditReceipt(store, a.page)) throw roleWorkStop("provider resumption ended without the original audit receipt; its single host grant is consumed");
    await recorder.record("validation.completed", { phase: "role-review-work-usage", workId: a.workId, budget: budget.report() });
    await recorder.finish("succeeded");
  } catch (error) {
    caught = error;
    await recorder.record("validation.completed", { phase: "role-review-work-stopped", workId: a.workId, budget: budget.report() });
    await recorder.finish("failed", {}, { code: "ROLE_REVIEW_WORK_FAILED", message: String(error), retryable: false });
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    budget.close();
    try { await session?.dispose(); }
    finally { await recordProviderResumptionResult(store, saved, caught, recorder.manifest.id); }
  }
}
