import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash } from "../world/canonical.js";
import { IDENTITY_REQUIREMENT_LIMITS } from "./identity-requirements.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { consumerRevalidationDirectory, type ConsumerRevalidationScope } from "./identity-consumer-revalidation-model.js";
import { CONSUMER_REVIEW_CORRECTION } from "./consumer-review-contract.js";

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
  const parent = path.join(path.dirname(consumerRevalidationDirectory(root, scope)), scope.compilerCorrection.predecessorId);
  if (scope.compilerCorrection.policy === CONSUMER_REVIEW_CORRECTION) {
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

export async function assertConsumerCompilerCorrection(scope: ConsumerRevalidationScope) {
  if (scope.compilerCorrection && scope.compilerCorrection.contractHash !== await (scope.compilerCorrection.policy === CONSUMER_REVIEW_CORRECTION ? consumerReviewCorrectionHash() : sourceLocalContractHash()))
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
    "src/compiler/consumer-review-binding.ts", "src/compiler/review-preview-allowance.ts"];
  return contentHash({ policy: CONSUMER_REVIEW_CORRECTION,
    files: await Promise.all(files.map(async file => ({ file, hash: contentHash(await fs.readFile(path.join(root, file), "utf8")) }))) });
}
