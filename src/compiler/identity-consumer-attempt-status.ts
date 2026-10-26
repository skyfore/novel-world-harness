import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../world/canonical.js";
import { identityRequirementDirectory, type IdentityRecord } from "./identity-requirements.js";
import { consumerRevalidationId, consumerRevalidationScopeSchema, validateConsumerCorrectionLineage,
  type ConsumerRevalidationRecord, type ConsumerRevalidationScope } from "./identity-consumer-revalidation-model.js";
import { consumerRevalidationLimits } from "./identity-consumer-correction.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { consumerStageRecoveryDirectory, consumerStageRecoverySchema, consumerRecoveryPreflight } from "./identity-consumer-stage-recovery.js";
import { inspectConsumerBudgetAmendment, consumerRecoveryLimits } from "./identity-consumer-budget-amendment.js";

export type ConsumerRevalidationAttempt = {
  id: string; ref: string; scopeHash: string; directory: string;
  compilerCorrection: ConsumerRevalidationScope["compilerCorrection"] | null;
  status: string; reason: string | null; recordedStages: number; semanticJudgmentPending: boolean;
  cumulative: { modelCalls: number; totalPayloadBytes: number };
  stages: Array<{ stage: string; invocationConsumed: boolean; sealedSubmission: boolean; recorded: boolean;
    failure: string | null; usage: { modelCalls: number; totalPayloadBytes: number };
    remainingAllowance: { modelCalls: number; totalPayloadBytes: number };
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
    if (state && (state.scopeHash !== scopeHash || state.sourceId !== sourceId || state.taskId !== scope.taskId || state.ref !== scope.ref))
      throw prerequisiteStop("Consumer attempt state has another scope; inspect its original state and failure, no retry");
    const stages: ConsumerRevalidationAttempt["stages"] = [];
    for (const stage of ["consumer-revalidation", "consumer-revalidation-check"]) {
      const [budget, invocation, checkpoint, failure] = await Promise.all(["budget", "invocation", "session-checkpoint", "failure"]
        .map(suffix => maybe(path.join(directory, `${stage}.${suffix}.json`))));
      const limits = await consumerRevalidationLimits(root, scope, stage);
      const usage = { modelCalls: budget?.state?.usage?.modelCalls ?? 0, totalPayloadBytes: budget?.state?.usage?.totalPayloadBytes ?? 0 };
      if ((invocation && (invocation.scopeHash !== scopeHash || invocation.stage !== stage))
        || (budget && (budget.scopeHash !== scopeHash || budget.stage !== stage || budget.originalBudgetHash !== scope.originalBudgetHash
          || contentHash(budget.limits) !== contentHash(limits)))
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
      stages.push({ stage, invocationConsumed: Boolean(invocation), sealedSubmission: Boolean(checkpoint),
        recorded: retained.some(r => r.output.phase === stage), failure: failure?.reason ?? null, usage,
        ...(continuation ? { continuation } : {}),
        remainingAllowance: { modelCalls: Math.max(0, (continuation?.preflight.remainingAllowance.maxModelCalls ?? limits.maxModelCalls - usage.modelCalls) - (continuation?.usage.modelCalls ?? 0)),
          totalPayloadBytes: Math.max(0, limits.maxTotalPayloadBytes - usage.totalPayloadBytes - (continuation?.usage.totalPayloadBytes ?? 0)) } });
    }
    attempts.push({ id: entry.name, ref: scope.ref, scopeHash, directory, compilerCorrection: scope.compilerCorrection ?? null,
      status: state?.status ?? "FROZEN", reason: state?.reason ?? null, recordedStages: retained.length,
      semanticJudgmentPending: retained.length < 2, cumulative, stages,
      verification: "host-snapshot-only", executionAuthority: false, parentResumeAllowed: false });
  }
  return attempts;
}
