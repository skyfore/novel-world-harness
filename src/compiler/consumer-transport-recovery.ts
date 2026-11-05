import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { TraceStore } from "../trace/store.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { prepareIdentityUpstreamCheckpoint } from "./identity-upstream-session.js";
import { consumerWorkContract, consumerWorkInput, workBudgetPolicy, type ConsumerWorkPlan } from "./consumer-work-plan.js";
import type { ConsumerRevalidationScope } from "./identity-consumer-revalidation-model.js";
import { readConsumerWorkMessages } from "./consumer-work-evidence.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const consumerTransportRecoveryRequestSchema = z.object({
  scopeHash: hash, stage: z.enum(["consumer-revalidation", "consumer-revalidation-check"]),
  failedTraceRunId: z.string().min(1), failureHash: hash,
  authorizationRef: z.string().trim().min(1), authorizedAt: z.string().datetime(),
}).strict();
export type ConsumerTransportRecoveryRequest = z.infer<typeof consumerTransportRecoveryRequestSchema>;
const recoverySchema = z.object({
  version: z.literal(1), policy: z.literal("consumer-transport-registration/v1"),
  sourceId: z.string(), taskId: z.string(), ref: z.string(), executionPlanHash: hash,
  request: consumerTransportRecoveryRequestSchema, traceManifestHash: hash,
  retainedFiles: z.array(z.object({ path: z.string(), hash }).strict()),
  providerCalls: z.literal(0), originalFailurePreserved: z.literal(true),
}).strict();
const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
export const transportRecoveryFile = (directory: string, stage: string) => path.join(directory, `${stage}.transport-recovery.json`);
const suffixes = ["plan", "invocation", "input", "proposal", "budget", "failure"];
const originalSealFailures = [
  "Error: ROLE_PREREQUISITE_HOST_REVIEW: Identity transcript is truncated, forked or edited; retain its complete original evidence.",
  "Error: ROLE_PREREQUISITE_HOST_REVIEW: Identity context edit is not one recorded unsubmitted WebSocket retry; preserve its complete history, no redispatch.",
];
const isOriginalSealFailure = (reason: unknown) => typeof reason === "string" && originalSealFailures.some(prefix => reason.startsWith(prefix));

export const transportRecoveryStop = (reason: string) => prerequisiteStop(`${reason}. Inspect requirements inspect-identity-repairs for the same source/task/ref; copy stages[].execution.transportRecoveryCandidate scopeHash, stage, failedTraceRunId and failureHash into --recover-transport-retry JSON, with the later authorizationRef and authorizedAt. Inspect with --inspect-execution first. Correct an ID once from discovery only; never guess or retry unchanged. Missing terminal receipt, failed tools, changed evidence, consumed independent check or exhausted budget forbids new generation. This recovery seals the original submission only, preserves all charges and never resumes the parent or certifies the world`);

export async function inspectConsumerTransportRecoveryCandidate(root: string, sourceId: string, scopeHash: string, directory: string, stage: string, failure: any) {
  if (!isOriginalSealFailure(failure?.reason)) return undefined;
  const runs = await new TraceStore(root).peekRunsByOperation(sourceId, `receipt-bound-${scopeHash}-${stage}-work-v1`);
  if (runs.length !== 1 || runs[0]!.status !== "failed" || !runs[0]!.endedAt) return undefined;
  return { scopeHash, stage, failedTraceRunId: runs[0]!.id, failureHash: contentHash(failure),
    recoveryFile: transportRecoveryFile(directory, stage), providerCalls: 0 };
}

/** Restore a successful terminal tool receipt rejected only while sealing its
 * transport retry. This never issues another proposal/model invocation. */
export async function prepareConsumerTransportRecovery(root: string, scope: ConsumerRevalidationScope,
  work: { directory: string; plan: ConsumerWorkPlan }, requestInput: ConsumerTransportRecoveryRequest) {
  const request = consumerTransportRecoveryRequestSchema.parse(requestInput), { directory, plan } = work;
  const stage = request.stage, traces = new TraceStore(root);
  if (request.scopeHash !== contentHash(scope) || stage !== plan.stage || plan.bindingRecoveryHash
    || request.authorizationRef === scope.authorizationRef)
    throw transportRecoveryStop("Transport registration requires the exact original work stage and later user authorization");
  const files = Object.fromEntries(await Promise.all(suffixes.map(async suffix => [suffix, await read(path.join(directory, `${stage}.${suffix}.json`))])));
  const { failure, budget, invocation, proposal, input } = files;
  const run = await traces.peekRun(request.failedTraceRunId);
  if (contentHash(files.plan) !== contentHash(plan) || contentHash(failure) !== request.failureHash || !isOriginalSealFailure(failure.reason)
    || run.status !== "failed" || !run.endedAt || run.sourceId !== scope.sourceId
    || run.operationId !== `receipt-bound-${request.scopeHash}-${stage}-work-v1`
    || !Number.isFinite(Date.parse(request.authorizedAt)) || Date.parse(request.authorizedAt) <= Date.parse(run.endedAt)
    || Date.parse(request.authorizedAt) > Date.now()
    || invocation.scopeHash !== request.scopeHash || invocation.stage !== stage || invocation.executionPlanHash !== contentHash(plan)
    || budget.scopeHash !== request.scopeHash || budget.stage !== stage || budget.executionPlanHash !== contentHash(plan)
    || budget.originalBudgetHash !== scope.originalBudgetHash || contentHash(budget.policy) !== contentHash(workBudgetPolicy(plan))
    || contentHash(budget.limits) !== contentHash(plan.limits) || budget.state.blocked || budget.state.failure
    || contentHash(input) !== contentHash(consumerWorkInput(plan)) || proposal.scopeHash !== request.scopeHash || proposal.phase !== stage)
    throw transportRecoveryStop("Original transport failure, authorization, input or retained budget does not match");
  if (!failure.sessionFile?.startsWith(path.join(directory, "sessions", stage) + path.sep)
    || await fs.realpath(failure.sessionFile) !== failure.sessionFile)
    throw transportRecoveryStop("Original failed session is outside its retained stage");
  const retainedFiles = await retainedOriginalFiles(directory, stage, failure.sessionFile);
  const recovery = recoverySchema.parse({ version: 1, policy: "consumer-transport-registration/v1", sourceId: scope.sourceId,
    taskId: scope.taskId, ref: scope.ref, executionPlanHash: contentHash(plan), request,
    traceManifestHash: contentHash(run), retainedFiles, providerCalls: 0, originalFailurePreserved: true });
  try {
    const saved = await read(transportRecoveryFile(directory, stage));
    if (contentHash(saved) !== contentHash(recovery)) throw transportRecoveryStop("The original transport registration proof is already frozen; no replacement authorization");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const checkpoint = await prepareIdentityUpstreamCheckpoint(root, directory, stage, {
    planHash: request.scopeHash, sessionId: failure.sessionId, sessionFile: failure.sessionFile, traceRunId: request.failedTraceRunId,
    contract: consumerWorkContract, prompt: JSON.stringify(input), usage: budget.state.usage,
    providerUsage: failure.usage.providerUsage, transportRecoveryHash: contentHash(recovery),
  });
  if (!checkpoint.transportRetryTraceHash || contentHash(checkpoint.output) !== contentHash(proposal))
    throw transportRecoveryStop("The original terminal submission is missing or differs from the retained proposal");
  const { messages } = await readConsumerWorkMessages(directory, stage, checkpoint.messagesHash);
  return { recovery, checkpoint, messages };
}

async function retainedOriginalFiles(directory: string, stage: string, sessionFile: string) {
  const files = [...suffixes.map(suffix => path.join(directory, `${stage}.${suffix}.json`)),
    path.join(directory, `${stage}.requests.jsonl`), path.join(directory, `${stage}.messages.jsonl`), sessionFile];
  return Promise.all(files.map(async file => ({ path: file, hash: contentHash(await fs.readFile(file, "utf8")) })));
}

export async function verifyConsumerTransportRecovery(root: string, directory: string, stage: string, checkpoint: {
  transportRecoveryHash: string; sessionFile: string; sessionId: string; traceRunId: string; planHash: string;
}) {
  const recovery = recoverySchema.parse(await read(transportRecoveryFile(directory, stage)));
  const scope = await read(path.join(path.dirname(directory), "scope.json")) as ConsumerRevalidationScope;
  const plan = await read(path.join(directory, `${stage}.plan.json`)) as ConsumerWorkPlan;
  if (contentHash(recovery) !== checkpoint.transportRecoveryHash || stage !== recovery.request.stage
    || recovery.request.failedTraceRunId !== checkpoint.traceRunId || recovery.request.scopeHash !== checkpoint.planHash
    || contentHash(await retainedOriginalFiles(directory, stage, checkpoint.sessionFile)) !== contentHash(recovery.retainedFiles))
    throw transportRecoveryStop("Sealed transport registration lost its original scope, failure or journals");
  const expected = await prepareConsumerTransportRecovery(root, scope, { directory, plan }, recovery.request);
  if (contentHash(expected.checkpoint) !== contentHash(checkpoint))
    throw transportRecoveryStop("Sealed transport registration changed its exact original submission");
}
