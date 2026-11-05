import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash } from "../world/canonical.js";
import { IDENTITY_REQUIREMENT_LIMITS } from "./identity-requirements.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { assertConsumerCorrectionOwner, consumerRevalidationId, consumerRevalidationScopeSchema, consumerRevalidationDirectory, type ConsumerRevalidationScope } from "./identity-consumer-revalidation-model.js";
import { CONSUMER_REVIEW_CORRECTION } from "./consumer-review-contract.js";
import { CONSUMER_EVIDENCE_COVERAGE } from "./consumer-evidence-coverage.js";

export const SOURCE_LOCAL_CORRECTION = "source-local-referent/v1" as const;
export const sourceLocalConsumerContract = {
  policy: SOURCE_LOCAL_CORRECTION,
  correction: "The former schema and agency gate conflated unresolved cross-person identity with lack of an executable local referent. A source-local handle does not assert equality with a named character or distinctness from every other character.",
  unchanged: "Original source, requirements, critical questions, evidence/agency/knowledge/time gates, full consumer denominator and all historical decisions remain authoritative. Existing quarantined artifacts stay blocked until a typed independently accepted revision is committed. Source-local mode does not grant bodily presence, historical relationships, future knowledge or global completion.",
  capability: "An existing entity may revise only identityConsumption to source-local, keeping status=unresolved and its exact current unresolved decision and predecessor chain. referentScope lists only mentions at the same source anchor, crossIdentity=unresolved, distinctness=unasserted. Exact supporting evidence for /identityConsumption/mode and /identityConsumption/referentScope is required through the existing evidence protocol. Existing initial-world fields may be repaired separately under the same original conditions.",
};

/** A bounded correction of a proven code limitation, not a new semantic task.
 * Its stable policy/parent key allows one continuation and cannot mint retries
 * by editing code, changing authorizations or rotating stage names. */
export async function sourceLocalContractHash() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const files = ["src/world/model.ts", "src/world/identity-consumption.ts", "src/world/agency-profile.ts",
    "src/compiler/entity-identity-consumption.ts", "test/identity-consumption.test.ts"];
  return contentHash({ contract: sourceLocalConsumerContract,
    files: await Promise.all(files.map(async file => ({ file, hash: contentHash(await fs.readFile(path.join(root, file), "utf8")) }))) });
}

export async function consumerRevalidationLimits(root: string, scope: ConsumerRevalidationScope, stage: string) {
  if (!scope.compilerCorrection) return IDENTITY_REQUIREMENT_LIMITS;
  await assertConsumerCorrectionSlot(root, scope);
  const parent = path.join(path.dirname(consumerRevalidationDirectory(root, scope)), scope.compilerCorrection.predecessorId);
  if (scope.compilerCorrection.policy === CONSUMER_REVIEW_CORRECTION || scope.compilerCorrection.policy === CONSUMER_EVIDENCE_COVERAGE) {
    const file = path.join(parent, "execution-v1", `${stage}.budget.json`), value = JSON.parse(await fs.readFile(file, "utf8"));
    if (value.originalBudgetHash !== scope.originalBudgetHash || value.state.blocked || value.state.failure || value.budgetAmendmentHash
      || !scope.priorBudgetFiles.some(b => b.path === file && b.hash === contentHash(value)))
      throw prerequisiteStop("Review-scope correction lost the settled predecessor allowance; preserve its stop and budget, no dispatch or reset");
    return remainingConsumerReviewLimits(value);
  }
  const file = path.join(parent, `${stage}.budget.json`), value = JSON.parse(await fs.readFile(file, "utf8"));
  if (contentHash(value.limits) !== contentHash(IDENTITY_REQUIREMENT_LIMITS)
    || value.originalBudgetHash !== scope.originalBudgetHash || value.state.blocked || value.state.failure
    || !scope.priorBudgetFiles.some(b => b.path === file && b.hash === contentHash(value)))
    throw prerequisiteStop("Compiler correction lost its exact original stage budget; preserve all charges, no dispatch");
  const limits = { ...IDENTITY_REQUIREMENT_LIMITS,
    maxModelCalls: IDENTITY_REQUIREMENT_LIMITS.maxModelCalls - value.state.usage.modelCalls,
    maxTotalPayloadBytes: IDENTITY_REQUIREMENT_LIMITS.maxTotalPayloadBytes - value.state.usage.totalPayloadBytes };
  if (limits.maxModelCalls <= 0 || limits.maxTotalPayloadBytes <= 0)
    throw prerequisiteStop("Original consumer stage has no remaining allowance for its compiler correction; no reset or renamed stage");
  return limits;
}

/** Frozen scopes reserve the same allowance even before a semantic record
 * exists (including a crash or failed invocation). The workflow holds the
 * workspace operation lock while checking this and freezing its scope. */
export async function assertConsumerCorrectionSlot(root: string, scope: ConsumerRevalidationScope) {
  if (!scope.compilerCorrection) return;
  const parent = path.dirname(consumerRevalidationDirectory(root, scope));
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries.filter(e => e.isDirectory() && /^[a-f0-9]{64}$/.test(e.name))) {
    let raw: unknown;
    try { raw = JSON.parse(await fs.readFile(path.join(parent, entry.name, "scope.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const attempt = consumerRevalidationScopeSchema.parse(raw);
    if (consumerRevalidationId(attempt) !== entry.name || attempt.sourceId !== scope.sourceId || attempt.taskId !== scope.taskId)
      throw prerequisiteStop("Consumer correction reservation lost its original scope. Inspect the same source/task retained scope.json files; no changed policy, dispatch or retry");
    assertConsumerCorrectionOwner(scope, [attempt]);
  }
}

export async function assertConsumerCompilerCorrection(scope: ConsumerRevalidationScope) {
  if (scope.compilerCorrection && scope.compilerCorrection.contractHash !== await (scope.compilerCorrection.policy === CONSUMER_EVIDENCE_COVERAGE
    ? consumerEvidenceCorrectionHash() : scope.compilerCorrection.policy === CONSUMER_REVIEW_CORRECTION ? consumerReviewCorrectionHash() : sourceLocalContractHash()))
    throw prerequisiteStop("Compiler correction implementation changed after freezing; preserve its original scope and invocation, no repinning or automatic model retry");
}

export function remainingConsumerReviewLimits(value: { limits: { maxModelCalls: number; maxRequestBytes: number; maxTotalPayloadBytes: number }; state: { usage: { modelCalls: number; totalPayloadBytes: number } } }) {
  if (Object.values(value.limits).some(v => !Number.isSafeInteger(v) || v <= 0)
    || [value.state.usage.modelCalls, value.state.usage.totalPayloadBytes].some(v => !Number.isSafeInteger(v) || v < 0))
    throw prerequisiteStop("Original review allowance or usage is invalid; preserve its accounting, no dispatch or reset");
  const limits = { ...value.limits, maxModelCalls: value.limits.maxModelCalls - value.state.usage.modelCalls,
    maxTotalPayloadBytes: value.limits.maxTotalPayloadBytes - value.state.usage.totalPayloadBytes };
  if (limits.maxModelCalls < 2 || limits.maxTotalPayloadBytes <= 0 || Object.values(limits).some(v => !Number.isSafeInteger(v) || v <= 0))
    throw prerequisiteStop("Original review has insufficient remaining allowance for preview and submission; preserve its budget, no new window or retry");
  return limits;
}

export async function consumerReviewCorrectionHash() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const files = ["src/compiler/consumer-review-contract.ts", "src/compiler/identity-consumer-revalidation-model.ts",
    "src/compiler/identity-consumer-revalidation.ts", "src/compiler/identity-consumer-correction.ts", "src/workflow/identity-consumer-revalidation.ts",
    "src/compiler/consumer-work-plan.ts", "src/compiler/identity-consumer-work.ts", "src/workflow/receipt-bound-pi-stage.ts",
    "src/compiler/consumer-review-binding.ts", "src/compiler/review-preview-allowance.ts", "src/compiler/consumer-work-evidence.ts"];
  return contentHash({ policy: CONSUMER_REVIEW_CORRECTION,
    files: await Promise.all(files.map(async file => ({ file, hash: contentHash(await fs.readFile(path.join(root, file), "utf8")) }))) });
}

export async function consumerEvidenceCorrectionHash() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const files = ["src/compiler/consumer-evidence-coverage.ts", "src/compiler/consumer-evidence-correction.ts",
    "src/compiler/identity-consumer-revalidation.ts", "src/compiler/identity-consumer-revalidation-model.ts",
    "src/compiler/identity-consumer-correction.ts", "src/compiler/identity-consumer-artifacts.ts",
    "src/compiler/consumer-work-plan.ts", "src/compiler/consumer-work-evidence.ts", "src/compiler/identity-consumer-work.ts", "src/workflow/identity-consumer-revalidation.ts"];
  return contentHash({ policy: CONSUMER_EVIDENCE_COVERAGE,
    files: await Promise.all(files.map(async file => ({ file, hash: contentHash(await fs.readFile(path.join(root, file), "utf8")) }))) });
}
