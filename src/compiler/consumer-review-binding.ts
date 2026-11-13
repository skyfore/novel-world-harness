import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { consumerReviewAssessmentSchema } from "./consumer-review-contract.js";
import { consumerRevalidationProposalSchema, consumerRevalidationCheckSchema, type ConsumerRevalidationScope } from "./identity-consumer-revalidation-model.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { assertReviewPreviewAllowance } from "./review-preview-allowance.js";

export const CONSUMER_REVIEW_BINDING = "consumer-review-binding/v1" as const;
export const bindingRecoveryDirectory = (directory: string) => `${directory}/contract-binding-recovery`;
export const bindingRecoveryStop = (reason: string) => prerequisiteStop(`${reason}. Inspect requirements inspect-identity-repairs for the same source/task/ref, copy summary.consumerRevalidation.attempts[].scopeHash and stages[].stage; use --recover-contract-binding --inspect-execution only for the original check's single rejected contract-hash preview. Preserve every failure, receipt and charge. Changed host scope, submitted result, repeated preview failure or consumed recovery forbids retry; sealed results permit registration only, never a fresh invocation`);

export function boundConsumerReviewSchema(scope: ConsumerRevalidationScope, check: boolean, proposalHash?: string) {
  if (!scope.reviewContract) throw bindingRecoveryStop("Bound review requires the original exact contract");
  const exact = (value: string, field: string) => z.literal(value).describe(`Copy input.${field} exactly. Never use another hash or compute one. One corrected preview only; scope/host drift stops.`);
  const common = { scopeHash: exact(contentHash(scope), "scopeHash") };
  if (check) {
    if (!proposalHash) throw bindingRecoveryStop("Independent check lost its sealed proposal");
    return consumerRevalidationCheckSchema.extend({ ...common, proposalHash: exact(proposalHash, "proposalHash"),
      reviewContractHash: exact(contentHash(scope.reviewContract), "reviewContractHash") });
  }
  return consumerRevalidationProposalSchema.extend({ ...common, ref: z.literal(scope.ref), currentRevisionHash: z.literal(scope.currentRevisionHash),
    review: consumerReviewAssessmentSchema.extend({ contractHash: exact(contentHash(scope.reviewContract), "reviewContractHash") }) });
}

/** Model input mistakes are distinct from host ownership drift. Callers still
 * validate the immutable scope before every request; this never fixes output. */
export function assertConsumerReviewBinding(scope: ConsumerRevalidationScope, output: { phase: string; scopeHash: string; proposalHash?: string;
  reviewContractHash?: string; review?: { contractHash: string } }, proposalHash?: string) {
  if (!scope.reviewContract || output.scopeHash !== contentHash(scope)
    || output.phase === "consumer-revalidation-check" && output.proposalHash !== proposalHash)
    throw bindingRecoveryStop("Review changed its scope or checked proposal");
  const expected = contentHash(scope.reviewContract), actual = output.phase === "consumer-revalidation-check" ? output.reviewContractHash : output.review?.contractHash;
  if (actual !== expected) throw new Error(`CONSUMER_REVIEW_BINDING_MISMATCH: Copy input.reviewContractHash (${expected}) into ${output.phase === "consumer-revalidation-check" ? "reviewContractHash" : "review.contractHash"}. Other subjectHash/priorSubjectHash fields identify different artifacts. Correct this preview once without changing the scope or proposal; no unchanged retry, host rewrite, budget renewal or semantic clearance.`);
}

/** SDK schema validation may reject a call before execute(). Count its actual
 * tool result as well, so fixed-value schemas cannot bypass the retry bound. */
export function assertBoundPreviewAllowance(messages: any[], scope: ConsumerRevalidationScope, proposalHash: string | undefined, recovery = false) {
  assertReviewPreviewAllowance(messages, { previewTool: "preview_consumer_revalidation", terminalTool: "submit_consumer_revalidation",
    correctionsRemaining: recovery ? 0 : 1, stop: bindingRecoveryStop,
    matchesScope: args => args.scopeHash === contentHash(scope)
      && (args.phase !== "consumer-revalidation-check" || args.proposalHash === proposalHash) });
}
