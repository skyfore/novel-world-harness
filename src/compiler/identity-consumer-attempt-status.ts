import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../world/canonical.js";
import { TraceStore } from "../trace/store.js";
import { identityRequirementDirectory, type IdentityRecord } from "./identity-requirements.js";
import { consumerRevalidationId, consumerRevalidationScopeSchema, validateConsumerCorrectionLineage,
  type ConsumerRevalidationRecord, type ConsumerRevalidationScope } from "./identity-consumer-revalidation-model.js";
import { consumerRevalidationLimits } from "./identity-consumer-correction.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { consumerStageRecoveryDirectory, consumerStageRecoverySchema, consumerRecoveryPreflight } from "./identity-consumer-stage-recovery.js";
import { inspectConsumerBudgetAmendment, consumerRecoveryLimits } from "./identity-consumer-budget-amendment.js";
import { consumerHostRecoveryDirectory, oldSourceSearchError, type ConsumerHostRecovery } from "./identity-consumer-host-recovery.js";
import { consumerWorkDirectory, consumerWorkBudgetPolicy, type ConsumerWorkPlan } from "./consumer-work-plan.js";

export type ConsumerRevalidationAttempt = {
  id: string; ref: string; scopeHash: string; directory: string;
  compilerCorrection: ConsumerRevalidationScope["compilerCorrection"] | null;
  status: string; reason: string | null; recordedStages: number; semanticJudgmentPending: boolean;
  cumulative: { modelCalls: number; totalPayloadBytes: number };
  stages: Array<{ stage: string; invocationConsumed: boolean; sealedSubmission: boolean; recorded: boolean;
    traceRunId?: string | null;
    failure: string | null; usage: { modelCalls: number; totalPayloadBytes: number };
    remainingAllowance: { modelCalls: number; totalPayloadBytes: number };
    execution?: { policy: string; planHash: string; scenario: string; status: string; invocationConsumed: boolean;
      sealedSubmission: boolean; failure: string | null; recovery: unknown; usage: { modelCalls: number; totalPayloadBytes: number };
      callsWithoutProgress: number; stallWindowCalls: number; draftCount: number };
    hostRecoveryCandidate?: { scopeHash: string; stage: "consumer-revalidation"; failedTraceRunId: string; failureHash: string; cause: "request-size" | "source-search-contract"; currentMaxRequestBytes: number };
    hostRecovery?: { hash: string; status: string; request: ConsumerHostRecovery["request"]; failure: string | null; traceRunId: string | null;
      providerResumption?: { status: string; preflight: ReturnType<typeof consumerRecoveryPreflight>; invocationConsumed: boolean; sealedSubmission: boolean;
        failure: string | null; usage: { modelCalls: number; totalPayloadBytes: number } };
      usage: { modelCalls: number; totalPayloadBytes: number }; proposalLimits: ConsumerHostRecovery["proposalLimits"]; checkLimits: ConsumerHostRecovery["checkLimits"] };
    continuation?: { status: string; preflight: ReturnType<typeof consumerRecoveryPreflight>;
      invocationConsumed: boolean; sealedSubmission: boolean; failure: string | null;
      recoveredSubmission?: boolean;
      usage: { modelCalls: number; totalPayloadBytes: number } } }>;
  verification: "host-snapshot-only"; executionAuthority: false; parentResumeAllowed: false;
};

const maybe = async (file: string) => {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
};

/** Failed invocations have no semantic ledger record. Expose their retained
 * state and charges without manufacturing a judgment or a retry authority. */
export async function inspectConsumerRevalidationAttempts(root: string, sourceId: string, original: IdentityRecord[], records: ConsumerRevalidationRecord[]) {
  const first = original[0];
  if (!first) return [];
  const base = path.join(identityRequirementDirectory(root, sourceId, first.intent.taskId), "consumer-revalidation");
  let entries;
  try { entries = await fs.readdir(base, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const attempts: ConsumerRevalidationAttempt[] = [];
  for (const entry of entries.filter(e => e.isDirectory() && /^[a-f0-9]{64}$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = path.join(base, entry.name), scope = consumerRevalidationScopeSchema.parse(await maybe(path.join(directory, "scope.json")));
    const scopeHash = contentHash(scope);
    if (consumerRevalidationId(scope) !== entry.name || scope.sourceId !== sourceId || scope.taskId !== first.intent.taskId
      || scope.identityIntentHash !== contentHash(first.intent) || scope.definitionHash !== contentHash(first.output))
      throw prerequisiteStop("Consumer attempt lost its original scope; inspect its retained scope.json and requirement ledger, no model retry or inferred judgment");
    validateConsumerCorrectionLineage(scope, records);
    const retained = records.filter(r => consumerRevalidationId(r.scope) === entry.name);
    if (retained.some(r => contentHash(r.scope) !== scopeHash)) throw prerequisiteStop("Consumer attempt differs from its recorded scope; preserve both records, no retry");
    const state = await maybe(path.join(directory, "state.json")), cumulative = { ...scope.priorUsage };
    const hostDirectory = consumerHostRecoveryDirectory(directory), hostPlan: ConsumerHostRecovery | null = await maybe(path.join(hostDirectory, "recovery.json"));
    if (state && (state.scopeHash !== scopeHash || state.sourceId !== sourceId || state.taskId !== scope.taskId || state.ref !== scope.ref))
      throw prerequisiteStop("Consumer attempt state has another scope; inspect its original state and failure, no retry");
    const stages: ConsumerRevalidationAttempt["stages"] = [];
    for (const stage of ["consumer-revalidation", "consumer-revalidation-check"]) {
      const [budget, invocation, checkpoint, failure] = await Promise.all(["budget", "invocation", "session-checkpoint", "failure"]
        .map(suffix => maybe(path.join(directory, `${stage}.${suffix}.json`))));
      const limits = stage === "consumer-revalidation-check" && hostPlan ? hostPlan.checkLimits : await consumerRevalidationLimits(root, scope, stage);
      const usage = { modelCalls: budget?.state?.usage?.modelCalls ?? 0, totalPayloadBytes: budget?.state?.usage?.totalPayloadBytes ?? 0 };
      if ((invocation && (invocation.scopeHash !== scopeHash || invocation.stage !== stage))
        || (budget && (budget.scopeHash !== scopeHash || budget.stage !== stage || budget.originalBudgetHash !== scope.originalBudgetHash
          || contentHash(budget.limits) !== contentHash(limits)
          || (stage === "consumer-revalidation-check" && budget.hostRecoveryHash !== (hostPlan ? contentHash(hostPlan) : undefined))))
        || Object.values(usage).some(value => !Number.isSafeInteger(value) || value < 0))
        throw prerequisiteStop("Consumer attempt budget or invocation changed scope; preserve the original files and charges, no retry or budget reset");
      cumulative.modelCalls += usage.modelCalls; cumulative.totalPayloadBytes += usage.totalPayloadBytes;
      let continuation: ConsumerRevalidationAttempt["stages"][number]["continuation"];
      const recoveryDirectory = consumerStageRecoveryDirectory(directory, stage);
      const saved = await maybe(path.join(recoveryDirectory, "continuation.json"));
      if (saved) {
        const plan = consumerStageRecoverySchema.parse(saved), amendment = await inspectConsumerBudgetAmendment(recoveryDirectory, plan);
        const effectiveLimits = consumerRecoveryLimits(plan, amendment), preflight = consumerRecoveryPreflight(plan, amendment);
        const [resumedBudget, resumedInvocation, resumedCheckpoint, resumedFailure] = await Promise.all(["budget", "invocation", "session-checkpoint", "failure"]
          .map(suffix => maybe(path.join(recoveryDirectory, `${stage}.${suffix}.json`))));
        const resumedUsage = { modelCalls: resumedBudget?.state?.usage?.modelCalls ?? 0, totalPayloadBytes: resumedBudget?.state?.usage?.totalPayloadBytes ?? 0 };
        if (plan.scopeHash !== scopeHash || plan.stage !== stage || !budget
          || plan.limits.maxModelCalls !== limits.maxModelCalls - usage.modelCalls
          || plan.limits.maxTotalPayloadBytes !== limits.maxTotalPayloadBytes - usage.totalPayloadBytes
          || plan.limits.maxRequestBytes !== limits.maxRequestBytes
          || (resumedBudget && (resumedBudget.scopeHash !== scopeHash || resumedBudget.stage !== stage
            || resumedBudget.originalBudgetHash !== scope.originalBudgetHash || contentHash(resumedBudget.limits) !== contentHash(effectiveLimits)
            || resumedBudget.budgetAmendmentHash !== (amendment ? contentHash(amendment) : undefined)))
          || Object.values(resumedUsage).some(value => !Number.isSafeInteger(value) || value < 0))
          throw prerequisiteStop("Consumer continuation status lost its original scope or stage charges; preserve both attempts, no retry");
        cumulative.modelCalls += resumedUsage.modelCalls; cumulative.totalPayloadBytes += resumedUsage.totalPayloadBytes;
        const recoveredSubmission = retained.some(r => r.output.phase === stage && r.refRecoveryHash);
        continuation = { status: recoveredSubmission ? "recovered-submission" : !preflight.modelDispatchAllowed ? "budget-blocked" : resumedFailure ? "BREAK"
          : resumedCheckpoint ? "sealed" : resumedInvocation ? "RUNNING" : "ready", preflight,
          ...(recoveredSubmission ? { recoveredSubmission: true } : {}),
          invocationConsumed: Boolean(resumedInvocation), sealedSubmission: Boolean(resumedCheckpoint), failure: resumedFailure?.reason ?? null, usage: resumedUsage };
      }
      const failedRuns = failure ? await new TraceStore(root).peekRunsByOperation(sourceId, `receipt-bound-${scopeHash}-${stage}`) : [];
      let hostRecovery: ConsumerRevalidationAttempt["stages"][number]["hostRecovery"];
      let hostRecoveryCandidate: ConsumerRevalidationAttempt["stages"][number]["hostRecoveryCandidate"];
      if (stage === "consumer-revalidation") {
        if (hostPlan) {
          const [b, i, c, f] = await Promise.all(["budget", "invocation", "session-checkpoint", "failure"].map(suffix => maybe(path.join(hostDirectory, `${stage}.${suffix}.json`))));
          const u = { modelCalls: b?.state?.usage?.modelCalls ?? 0, totalPayloadBytes: b?.state?.usage?.totalPayloadBytes ?? 0 };
          if (hostPlan.request.scopeHash !== scopeHash || (b && (b.hostRecoveryHash !== contentHash(hostPlan) || b.scopeHash !== scopeHash
            || b.originalBudgetHash !== scope.originalBudgetHash || contentHash(b.limits) !== contentHash(hostPlan.proposalLimits)))
            || Object.values(u).some(v => !Number.isSafeInteger(v) || v < 0)) throw prerequisiteStop("Host recovery status lost its scope or charges; no retry");
          cumulative.modelCalls += u.modelCalls; cumulative.totalPayloadBytes += u.totalPayloadBytes;
          const hostRuns = f ? await new TraceStore(root).peekRunsByOperation(sourceId, `receipt-bound-${scopeHash}-${stage}-host-recovery`) : [];
          hostRecovery = { hash: contentHash(hostPlan), status: c ? "sealed" : f ? "BREAK" : i ? "RUNNING" : "ready", request: hostPlan.request,
            traceRunId: hostRuns.length === 1 ? hostRuns[0]!.id : null,
            failure: f?.reason ?? null, usage: u, proposalLimits: hostPlan.proposalLimits, checkLimits: hostPlan.checkLimits };
          const resumedDirectory = consumerStageRecoveryDirectory(hostDirectory, stage), resumedPlan = await maybe(path.join(resumedDirectory, "continuation.json"));
          if (resumedPlan) {
            const plan = consumerStageRecoverySchema.parse(resumedPlan), preflight = consumerRecoveryPreflight(plan);
            const [rb, ri, rc, rf] = await Promise.all(["budget", "invocation", "session-checkpoint", "failure"].map(suffix => maybe(path.join(resumedDirectory, `${stage}.${suffix}.json`))));
            const ru = { modelCalls: rb?.state?.usage?.modelCalls ?? 0, totalPayloadBytes: rb?.state?.usage?.totalPayloadBytes ?? 0 };
            if (!b || plan.hostRecoveryHash !== contentHash(hostPlan) || !plan.providerResumption || plan.stage !== stage || plan.scopeHash !== scopeHash
              || plan.limits.maxModelCalls !== hostPlan.proposalLimits.maxModelCalls - u.modelCalls
              || plan.limits.maxTotalPayloadBytes !== hostPlan.proposalLimits.maxTotalPayloadBytes - u.totalPayloadBytes
              || plan.limits.maxRequestBytes !== hostPlan.proposalLimits.maxRequestBytes
              || (ri && (ri.scopeHash !== scopeHash || ri.stage !== stage || ri.hostRecoveryHash !== contentHash(hostPlan) || ri.continuationHash !== contentHash(plan)))
              || (rb && (rb.scopeHash !== scopeHash || rb.stage !== stage || rb.hostRecoveryHash !== contentHash(hostPlan)
                || rb.originalBudgetHash !== scope.originalBudgetHash || rb.budgetAmendmentHash || contentHash(rb.limits) !== contentHash(plan.limits)
                || contentHash(rb.priorUsage) !== contentHash(plan.priorUsage)))
              || Object.values(ru).some(v => !Number.isSafeInteger(v) || v < 0))
              throw prerequisiteStop("Host provider resumption lost its exact recovery or retained charges; preserve all segments, no retry");
            cumulative.modelCalls += ru.modelCalls; cumulative.totalPayloadBytes += ru.totalPayloadBytes;
            hostRecovery.providerResumption = { status: rc ? "sealed" : rf ? "BREAK" : ri ? "RUNNING" : preflight.status, preflight,
              invocationConsumed: Boolean(ri), sealedSubmission: Boolean(rc), failure: rf?.reason ?? null, usage: ru };
          }
        } else {
          const latestFailure = continuation?.failure ? await maybe(path.join(recoveryDirectory, `${stage}.failure.json`)) : failure;
          const cause = latestFailure?.reason === `Error: ${oldSourceSearchError}` ? "source-search-contract"
            : /^Error: Model request budget exhausted: request requires \d+ UTF-8 bytes\./u.test(latestFailure?.reason ?? "") ? "request-size" : undefined;
          const runs = cause ? await new TraceStore(root).peekRunsByOperation(sourceId, `receipt-bound-${scopeHash}-${stage}${continuation?.failure ? "-continuation" : ""}`) : [];
          if (cause && runs.length === 1) hostRecoveryCandidate = { scopeHash, stage, failedTraceRunId: runs[0]!.id,
            failureHash: contentHash(latestFailure), cause, currentMaxRequestBytes: latestFailure.usage.limits.maxRequestBytes };
        }
      }
      const workDirectory = consumerWorkDirectory(directory), plan: ConsumerWorkPlan | null = await maybe(path.join(workDirectory, `${stage}.plan.json`));
      let execution: ConsumerRevalidationAttempt["stages"][number]["execution"];
      if (plan) {
        const [b, i, c, f, preflight] = await Promise.all(["budget", "invocation", "session-checkpoint", "failure", "preflight"]
          .map(suffix => maybe(path.join(workDirectory, `${stage}.${suffix}.json`))));
        const u = { modelCalls: b?.state?.usage?.modelCalls ?? 0, totalPayloadBytes: b?.state?.usage?.totalPayloadBytes ?? 0 };
        if (plan.scopeHash !== scopeHash || plan.stage !== stage || (b && (b.executionPlanHash !== contentHash(plan)
          || b.originalBudgetHash !== scope.originalBudgetHash || contentHash(b.policy) !== contentHash(consumerWorkBudgetPolicy)
          || contentHash(b.limits) !== contentHash(plan.limits))) || (i && (i.executionPlanHash !== contentHash(plan) || i.scopeHash !== scopeHash))
          || Object.values(u).some(v => !Number.isSafeInteger(v) || v < 0))
          throw prerequisiteStop("Consumer execution status lost its frozen plan or actual charges; preserve the original history, no retry");
        cumulative.modelCalls += u.modelCalls; cumulative.totalPayloadBytes += u.totalPayloadBytes;
        execution = { policy: plan.policy, planHash: contentHash(plan), scenario: plan.scenario,
          status: c ? "sealed" : f ? f.recovery?.kind ?? "BREAK" : i ? "RUNNING" : preflight?.status ?? "prepared",
          invocationConsumed: Boolean(i), sealedSubmission: Boolean(c), failure: f?.reason ?? null, recovery: f?.recovery ?? null, usage: u,
          callsWithoutProgress: u.modelCalls - (b?.state?.progress?.lastProgressCall ?? 0), stallWindowCalls: plan.limits.maxModelCalls,
          draftCount: (await fs.readdir(workDirectory)).filter(name => name.startsWith(`${stage}.draft-`)).length };
      }
      stages.push({ stage, invocationConsumed: Boolean(invocation), sealedSubmission: Boolean(checkpoint),
        ...(failure ? { traceRunId: failedRuns.length === 1 ? failedRuns[0]!.id : null } : {}),
        recorded: retained.some(r => r.output.phase === stage), failure: failure?.reason ?? null, usage,
        ...(continuation ? { continuation } : {}),
        ...(execution ? { execution } : {}),
        ...(hostRecovery ? { hostRecovery } : {}), ...(hostRecoveryCandidate ? { hostRecoveryCandidate } : {}),
        remainingAllowance: { modelCalls: Math.max(0, hostRecovery ? hostRecovery.proposalLimits.maxModelCalls - hostRecovery.usage.modelCalls - (hostRecovery.providerResumption?.usage.modelCalls ?? 0)
          : (continuation?.preflight.remainingAllowance.maxModelCalls ?? limits.maxModelCalls - usage.modelCalls) - (continuation?.usage.modelCalls ?? 0)),
          totalPayloadBytes: Math.max(0, hostRecovery ? hostRecovery.proposalLimits.maxTotalPayloadBytes - hostRecovery.usage.totalPayloadBytes - (hostRecovery.providerResumption?.usage.totalPayloadBytes ?? 0)
            : limits.maxTotalPayloadBytes - usage.totalPayloadBytes - (continuation?.usage.totalPayloadBytes ?? 0)) } });
    }
    attempts.push({ id: entry.name, ref: scope.ref, scopeHash, directory, compilerCorrection: scope.compilerCorrection ?? null,
      status: state?.status ?? "FROZEN", reason: state?.reason ?? null, recordedStages: retained.length,
      semanticJudgmentPending: retained.length < 2, cumulative, stages,
      verification: "host-snapshot-only", executionAuthority: false, parentResumeAllowed: false });
  }
  return attempts;
}
