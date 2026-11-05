import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import type { ConsumerStageRecovery } from "./identity-consumer-stage-recovery.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const limits = z.object({ maxModelCalls: z.number().int().nonnegative(), maxRequestBytes: z.number().int().nonnegative(),
  maxTotalPayloadBytes: z.number().int().nonnegative() }).strict();
export const consumerBudgetAmendmentRequestSchema = z.object({ continuationHash: hash,
  stage: z.enum(["consumer-revalidation", "consumer-revalidation-check"]),
  additionalCalls: z.number().int().positive().max(12), authorizationRef: z.string().trim().min(1).max(6000),
}).strict();
export type ConsumerBudgetAmendmentRequest = z.infer<typeof consumerBudgetAmendmentRequestSchema>;
export const consumerBudgetAmendmentSchema = z.object({ version: z.literal(1), policy: z.literal("consumer-continuation-call-amendment/v1"),
  request: consumerBudgetAmendmentRequestSchema, scopeHash: hash, originalLimits: limits, limits,
}).strict();
export type ConsumerBudgetAmendment = z.infer<typeof consumerBudgetAmendmentSchema>;

/** Host authorization extends only the not-yet-dispatched segment's call cap.
 * Original budget, byte caps, failed invocation and the single-use gate remain intact. */
export function prepareConsumerBudgetAmendment(plan: ConsumerStageRecovery, raw: ConsumerBudgetAmendmentRequest) {
  const request = consumerBudgetAmendmentRequestSchema.parse(raw);
  if (request.continuationHash !== contentHash(plan) || request.stage !== plan.stage
    || request.authorizationRef === plan.authorizationRef || plan.limits.maxModelCalls >= plan.minimumModelCalls
    || plan.limits.maxTotalPayloadBytes <= 0 || plan.limits.maxModelCalls + request.additionalCalls < plan.minimumModelCalls)
    throw prerequisiteStop("Call amendment needs the exact budget-blocked continuation and a later explicit authorization; copy continuationHash and stage from --resume-unsubmitted inspect once, no scope change or unchanged retry");
  return consumerBudgetAmendmentSchema.parse({ version: 1, policy: "consumer-continuation-call-amendment/v1", request,
    scopeHash: plan.scopeHash, originalLimits: plan.limits, limits: { ...plan.limits, maxModelCalls: plan.limits.maxModelCalls + request.additionalCalls } });
}

export function consumerRecoveryLimits(plan: ConsumerStageRecovery, amendment?: ConsumerBudgetAmendment) {
  if (!amendment) return plan.limits;
  const saved = consumerBudgetAmendmentSchema.parse(amendment);
  if (contentHash(saved) !== contentHash(prepareConsumerBudgetAmendment(plan, saved.request)))
    throw prerequisiteStop("Consumer call amendment changed its original proof or byte/call caps; preserve both budgets, no dispatch or retry");
  return saved.limits;
}

const maybe = async (file: string) => {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
};

/** Read-only preview/verification. A new grant cannot appear after invocation;
 * an existing grant is immutable and every invocation must bind its exact hash. */
export async function inspectConsumerBudgetAmendment(directory: string, plan: ConsumerStageRecovery, request?: ConsumerBudgetAmendmentRequest) {
  const file = path.join(directory, "budget-amendment.json"), raw = await maybe(file);
  const saved = raw ? consumerBudgetAmendmentSchema.parse(raw) : undefined;
  if (saved) consumerRecoveryLimits(plan, saved);
  const candidate = request ? prepareConsumerBudgetAmendment(plan, request) : undefined;
  if (saved && candidate && contentHash(saved) !== contentHash(candidate))
    throw prerequisiteStop("This continuation already has its one immutable call amendment; inspect budget-amendment.json, no replacement, second grant or retry");
  const invocation = await maybe(path.join(directory, `${plan.stage}.invocation.json`));
  if (invocation && (invocation.scopeHash !== plan.scopeHash || invocation.stage !== plan.stage
    || invocation.continuationHash !== contentHash(plan) || invocation.budgetAmendmentHash !== (saved ? contentHash(saved) : undefined)))
    throw prerequisiteStop("Consumer call amendment is missing or was changed after invocation; preserve the original invocation, no retroactive grant or retry");
  if (candidate && !saved) {
    const names = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    if (names.some(name => !["continuation.json", "preflight.json"].includes(name)))
      throw prerequisiteStop("Consumer continuation has already started or contains unsettled files; no call amendment, second segment or retry");
  }
  return saved ?? candidate;
}
