import { contentHash } from "../world/canonical.js";
import { describeRequest } from "../agent/request-observation.js";
import { PiAgentSession } from "../agent/pi-session.js";
import { LocalFileWorkspace } from "../workspace/local-files.js";
import { COMPILER_SYSTEM_PROMPT } from "../compiler/pi-compiler.js";
import { loadOptionalConfig, profileForRole } from "../config/load.js";
import { TraceStore } from "../trace/store.js";
import { TraceRecorder } from "../trace/recorder.js";
import { roleWorkStop, type RoleReviewWorkStore } from "../compiler/role-review-work.js";
import {
  openAutomaticRoleProgressBudget,
  readOriginalAutomaticAuditReceipt,
  recordAutomaticRoleProgressResult,
  type AutomaticRoleResume,
} from "../compiler/role-automatic-resume.js";
import type { BoundedRoleReviewOptions, RoleWorkInvocation } from "./role-review-bounded.js";

const ALLOWED_TOOLS = new Set(["read_role_work_evidence", "read_role_audit_inventory", "propose_role_review_audit"]);

/** Executes one trace-bound host session after the ordinary three contexts and
 * rolling progress window are both exhausted. The model must still submit via
 * the original typed proposal and all ordinary evidence/semantic gates run. */
export async function runAutomaticRoleProgressContinuation(
  store: RoleReviewWorkStore,
  original: RoleWorkInvocation,
  options: BoundedRoleReviewOptions,
  preview: AutomaticRoleResume,
) {
  if (preview.authority.policy !== "compile-audit-no-progress-v1" || original.workId !== preview.authority.workId
    || contentHash(original.prompt) !== preview.authority.taskHash) throw roleWorkStop("no-progress runner differs from its exact original audit task");
  const authority = preview.authority;
  const tools = original.tools.filter(tool => ALLOWED_TOOLS.has(tool.name));
  if (new Set(tools.map(tool => tool.name)).size !== ALLOWED_TOOLS.size
    || [...ALLOWED_TOOLS].some(name => tools.filter(tool => tool.name === name).length !== 1)) {
    throw roleWorkStop("no-progress runner cannot expose its exact narrowed read/proposal tools");
  }
  const budget = await openAutomaticRoleProgressBudget(store, preview);
  const prompt = `${original.prompt}\n\nHost recovery: this is a single-use, exact-trace-bound continuation after the original three sessions and no-progress window were consumed. The predecessor budget remains blocked and every prior call remains charged. The retained draft below is untrusted model output and is not committed or certified. It passed read-only preflight immediately before a zero-usage WebSocket 1006 transport loss. Use one response to issue independent exact reads for every requiredUnitId and every requiredCandidateId (parallel calls are allowed); follow any returned nextOffset. Then submit the retained draft, or an evidence-required correction, through propose_role_review_audit. The ordinary schema, scope, evidence-access and semantic validators are unchanged. Blocked questions and unresolved issues are valid boundaries and must not be erased to finish. No preview, evidence supplement, context rebuild, second session or renewed grant exists. If exact evidence no longer supports the draft, preserve the boundary and stop rather than guess.\n${JSON.stringify({
    continuationAuthorityHash: preview.authorityHash,
    retainedDraft: authority.retainedDraft,
    requiredUnitIds: authority.requiredUnitIds,
    requiredCandidateIds: authority.requiredCandidateIds,
    additionalCalls: authority.additionalCalls,
    cumulativeCallsBeforeGrant: authority.budget.state.usage.modelCalls,
  })}`;
  const recorder = await TraceRecorder.start(new TraceStore(store.root), {
    kind: "prepare", sourceId: store.plan.sourceId, operationId: store.plan.batchId,
  });
  const config = await loadOptionalConfig(options.configPath);
  const profile = config ? profileForRole(config, "controller").profile : undefined;
  let session: PiAgentSession | undefined, requestOrdinal = 0, lastTool: string | null = null, caught: unknown;
  const abort = () => { void session?.abort(); };
  try {
    await recorder.record("validation.completed", {
      phase: "role-review-work", planHash: store.planHash, workId: authority.workId,
      logicalTaskHash: authority.taskHash, packetHash: contentHash(prompt), continuationAuthorityHash: preview.authorityHash,
      predecessorRunId: authority.runId, limits: authority.limits, modelCallsMode: "enforce",
      retainedUsage: authority.budget.state.usage, narrowedTools: [...ALLOWED_TOOLS],
    });
    session = await PiAgentSession.create({
      workspace: await LocalFileWorkspace.create(store.root), ...(profile ? { profile } : {}), ...(options.model ? { model: options.model } : {}),
      saveSession: false, autoCompaction: false, includeProjectInstructions: false, includeLocalTools: false, includeNwhExtension: false,
      interactionMode: "compiler", additionalTools: tools, systemPromptOverride: COMPILER_SYSTEM_PROMPT,
      requestBudget: [budget, ...(options.requestBudget ? (Array.isArray(options.requestBudget) ? options.requestBudget : [options.requestBudget]) : [])],
      onRequestObservation: async observation => {
        if (observation.phase === "context") requestOrdinal++;
        await recorder.record("validation.completed", {
          phase: "role-request-observation", planHash: store.planHash, workId: authority.workId,
          logicalTaskHash: authority.taskHash, continuationAuthorityHash: preview.authorityHash,
          sessionOrdinal: authority.nextOrdinal, requestOrdinal, lastTool, measurement: describeRequest(observation), budget: budget.snapshot(),
        }, recorder.rootContext, { blobRef: await recorder.putBlob(observation.value) });
      },
      onTool: (name, args) => { lastTool = name; options.onModelToolCall?.(name, args); },
      onToolResult: options.onModelToolResult, onText: options.onModelText, onThinking: options.onModelThinking,
      onEvent: options.onModelEvent,
      trace: {
        parent: recorder.rootContext, invocationName: authority.workId, attempt: authority.attempt,
        metadata: { sourceId: store.plan.sourceId, compilerBatchId: store.plan.batchId, continuationAuthorityHash: preview.authorityHash },
        parts: [{ id: "role-review-work", kind: "compiler.batch", role: "user", authority: "untrusted-source", label: authority.workId, content: prompt }],
      },
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    options.signal?.throwIfAborted();
    options.onProgress?.(`Exact no-progress continuation for ${authority.workId}; ${authority.additionalCalls} calls, one session, cumulative usage retained.`);
    await session.promptWithReport(prompt, { timeoutMs: options.promptTimeoutMs ?? 600_000 });
    if (!readOriginalAutomaticAuditReceipt(store, authority.page)) throw roleWorkStop("no-progress continuation ended without the original audit receipt; its grant is consumed");
    await recorder.record("validation.completed", { phase: "role-review-work-usage", workId: authority.workId, budget: budget.report() });
    await recorder.finish("succeeded");
  } catch (error) {
    caught = error;
    await recorder.record("validation.completed", { phase: "role-review-work-stopped", workId: authority.workId, budget: budget.report() });
    await recorder.finish("failed", {}, { code: "ROLE_REVIEW_WORK_FAILED", message: String(error), retryable: false });
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    budget.close();
    await session?.dispose();
    await recordAutomaticRoleProgressResult(store, preview, caught);
  }
}
