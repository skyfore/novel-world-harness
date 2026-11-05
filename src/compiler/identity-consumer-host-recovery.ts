import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { TraceStore } from "../trace/store.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { consumerRevalidationDirectory, type ConsumerRevalidationScope } from "./identity-consumer-revalidation-model.js";
import { consumerRevalidationLimits } from "./identity-consumer-correction.js";
import { consumerStageRecoveryDirectory, verifyConsumerStageRecovery } from "./identity-consumer-stage-recovery.js";
import { consumerRecoveryLimits, inspectConsumerBudgetAmendment } from "./identity-consumer-budget-amendment.js";
import { verifyStoppedReadOnlyIdentitySession, type IdentitySessionContract } from "./identity-session-integrity.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const consumerHostRecoveryRequestSchema = z.object({
  scopeHash: hash, stage: z.literal("consumer-revalidation"), failedTraceRunId: z.string().min(1), failureHash: hash,
  cause: z.enum(["request-size", "source-search-contract"]), authorizationRef: z.string().trim().min(1).max(6000), authorizedAt: z.iso.datetime(),
  maxRequestBytes: z.number().int().positive().max(2_048_000),
}).strict();
export type ConsumerHostRecoveryRequest = z.infer<typeof consumerHostRecoveryRequestSchema>;
export const consumerHostRecoveryDirectory = (base: string) => path.join(base, "consumer-revalidation.host-recovery");
const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
const maybe = async (file: string) => { try { return await read(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; } };
export const oldSourceSearchError = "query is for artifacts discovery only; copy a known ID/kind, offset=0, then returned items[].ref into refs once.";

/** One explicitly authorized repair of a settled transport/reader defect. The
 * old scopes, invocations and budgets remain immutable; neither stage gains calls
 * or cumulative bytes. Only the separately verified first-request quota protocol
 * may continue this recovery; arbitrary failures cannot create another segment. */
export async function prepareConsumerHostRecovery(root: string, scope: ConsumerRevalidationScope,
  rawRequest: ConsumerHostRecoveryRequest, contract: IdentitySessionContract) {
  const request = consumerHostRecoveryRequestSchema.parse(rawRequest), base = consumerRevalidationDirectory(root, scope);
  const stage = request.stage, directory = consumerHostRecoveryDirectory(base), saved = await maybe(path.join(directory, "recovery.json"));
  if (request.scopeHash !== contentHash(scope) || request.authorizationRef === scope.authorizationRef
    || (saved && contentHash(saved.request) !== contentHash(request)))
    throw prerequisiteStop("Host recovery needs the exact original scope and later authorization; inspect the same source/task/ref attempt, no replacement grant or guessed retry");
  if (!saved && await maybe(path.join(base, "consumer-revalidation-check.invocation.json")))
    throw prerequisiteStop("The original independent check has already started; this read-only proposal recovery cannot renew it");
  const originalLimits = await consumerRevalidationLimits(root, scope, stage);
  const originalCheckLimits = await consumerRevalidationLimits(root, scope, "consumer-revalidation-check");
  const continuationDirectory = consumerStageRecoveryDirectory(base, stage);
  const continuation = await maybe(path.join(continuationDirectory, "continuation.json"));
  const failedDirectory = continuation ? continuationDirectory : base;
  if (continuation) await verifyConsumerStageRecovery(root, scope, stage, contentHash(continuation), contract,
    (await maybe(path.join(continuationDirectory, "budget-amendment.json"))) ? contentHash(await read(path.join(continuationDirectory, "budget-amendment.json"))) : undefined);
  const inherited = { ...scope.priorUsage }, failedReadRequests: unknown[] = [], requiredSourceSegmentIds = new Set<string>(), requiredArtifactRefs = new Set<string>();
  const retainedFiles: Array<{ path: string; hash: string }> = [];
  const retain = async (file: string) => {
    if (await fs.realpath(file) !== file || !(await fs.stat(file)).isFile() || file.endsWith(".tmp")) throw prerequisiteStop("Recovery found an unsettled or redirected file; preserve it, no dispatch");
    retainedFiles.push({ path: path.relative(base, file), hash: contentHash(await fs.readFile(file, "utf8")) });
  };
  await retain(path.join(base, "scope.json"));
  if (contentHash(await read(path.join(base, "scope.json"))) !== contentHash(scope)) throw prerequisiteStop("Recovery scope changed; no dispatch");
  let spentCalls = 0, spentBytes = 0, repairedReadFailures = 0, blockedRequestBytes: number | null = null;
  let originalInputHash = "", failedInputHash = "", traceHash = "";
  for (const dir of continuation ? [base, continuationDirectory] : [base]) {
    const get = (suffix: string) => read(path.join(dir, `${stage}.${suffix}.json`));
    for (const suffix of ["session-checkpoint", "record", "proposal"]) if (await maybe(path.join(dir, `${stage}.${suffix}.json`)))
      throw prerequisiteStop("Failed stage already has a submission; recover its original registration, no new model invocation");
    const [failure, invocation, budget, input] = await Promise.all(["failure", "invocation", "budget", "input"].map(get));
    const isLast = dir === failedDirectory;
    const limits = dir === base ? originalLimits : consumerRecoveryLimits(continuation, await inspectConsumerBudgetAmendment(dir, continuation));
    if (invocation.scopeHash !== request.scopeHash || invocation.stage !== stage || !Number.isSafeInteger(invocation.pid) || invocation.pid <= 0
      || budget.scopeHash !== request.scopeHash || budget.stage !== stage || budget.originalBudgetHash !== scope.originalBudgetHash
      || contentHash(budget.limits) !== contentHash(limits) || contentHash(budget.priorUsage) !== contentHash(inherited)
      || contentHash(failure.usage.usage) !== contentHash(budget.state.usage))
      throw prerequisiteStop("Recovery lost its original scope, invocation or inherited charges; no reset or dispatch");
    const traces = new TraceStore(root), runs = await traces.peekRunsByOperation(scope.sourceId,
      `receipt-bound-${request.scopeHash}-${stage}${dir === base ? "" : "-continuation"}`);
    const run = runs[0];
    if (runs.length !== 1 || !run || run.status !== "failed" || !run.endedAt || (isLast && (run.id !== request.failedTraceRunId
      || contentHash(failure) !== request.failureHash || Date.parse(request.authorizedAt) <= Date.parse(run.endedAt) || Date.parse(request.authorizedAt) > Date.now())))
      throw prerequisiteStop("Recovery requires the exact settled failure and later user authorization; inspect attempts[].stages[].hostRecoveryCandidate, copy its fields once, no guessed trace or unchanged retry");
    const events = await traces.peekEvents(run.id);
    if (!events.some(e => e.type === "stage.started" && e.data?.sessionId === failure.sessionId && e.data?.inputHash === contentHash(input))
      || events.at(-1)?.type !== "run.failed") throw prerequisiteStop("Recovery trace is detached or unsettled; no dispatch");
    if (typeof failure.sessionFile !== "string" || !failure.sessionFile.startsWith(path.join(dir, "sessions", stage) + path.sep)
      || await fs.realpath(failure.sessionFile) !== failure.sessionFile) throw prerequisiteStop("Recovery session escaped its original scope; no dispatch");
    const [session, requests, messages] = await Promise.all([fs.readFile(failure.sessionFile, "utf8"),
      fs.readFile(path.join(dir, `${stage}.requests.jsonl`), "utf8"), fs.readFile(path.join(dir, `${stage}.messages.jsonl`), "utf8")]);
    const sizeStop = isLast && request.cause === "request-size";
    const proof = verifyStoppedReadOnlyIdentitySession(session, root, { sessionId: failure.sessionId, provider: "openai-codex", model: "gpt-6.1-sol" },
      JSON.stringify(input), requests, messages, contract, failure.reason.replace(/^Error: /u, ""), sizeStop);
    const usage = budget.state.usage, sizes = proof.payloads.map(p => Buffer.byteLength(JSON.stringify(p)));
    if (proof.transcript.responses !== usage.modelCalls || sizes.length !== usage.payloads
      || sizes.reduce((a, b) => a + b, 0) !== usage.totalPayloadBytes
      || Math.max(...sizes, ...proof.contexts.map(c => Buffer.byteLength(JSON.stringify(c)))) !== usage.largestRequestBytes
      || usage.modelCalls > limits.maxModelCalls || usage.totalPayloadBytes > limits.maxTotalPayloadBytes || usage.largestRequestBytes > limits.maxRequestBytes)
      throw prerequisiteStop("Recovery charges disagree with the complete Pi session; preserve them, no dispatch");
    if (sizeStop) {
      blockedRequestBytes = proof.blockedRequestBytes ?? null;
      if (!budget.state.blocked || budget.state.failure?.code !== "request-size" || blockedRequestBytes === null
        || !failure.reason.startsWith(`Error: Model request budget exhausted: request requires ${blockedRequestBytes} UTF-8 bytes.`)
        || failure.reason !== `Error: ${budget.state.failure.message}` || blockedRequestBytes <= limits.maxRequestBytes
        || request.maxRequestBytes <= blockedRequestBytes || request.maxRequestBytes <= limits.maxRequestBytes)
        throw prerequisiteStop("Byte recovery does not match the reproduced unsent request or bounded increase; no dispatch");
    } else if (budget.state.blocked || budget.state.failure || (isLast ? failure.reason !== `Error: ${oldSourceSearchError}`
      : failure.reason !== String(prerequisiteStop("Pi returned without a revalidation submission; preserve failure and budget, no new invocation"))))
      throw prerequisiteStop("This failure is not the supported original reader defect; no retry or relabeling");
    const calls = new Map<string, any>();
    for (const m of proof.messages) {
      if (m.role === "assistant") for (const b of m.content) if (b.type === "toolCall") calls.set(b.id, b.arguments);
      if (m.role !== "toolResult") continue;
      const args = calls.get(m.toolCallId);
      if (m.isError) {
        if (request.cause === "source-search-contract" && args?.collection === "source" && typeof args.query === "string"
          && args.query.trim() && args.query.length <= 200 && !args.refs && !args.segmentIds && (args.offset ?? 0) === 0
          && m.content.some(b => b.type === "text" && (b.text === oldSourceSearchError || b.text.startsWith(oldSourceSearchError + "\n\n<nwh-tool-recovery>")))) repairedReadFailures++;
        else {
          if (m.content.some(b => b.type === "text" && b.text.includes("ROLE_PREREQUISITE_HOST_REVIEW"))) throw prerequisiteStop("Original read hit a scope/host stop; no recovery");
          failedReadRequests.push(args);
        }
      } else if (args?.collection === "source") args.segmentIds?.forEach((id: string) => requiredSourceSegmentIds.add(id));
      else if (args?.collection === "artifacts") args.refs?.forEach((ref: string) => requiredArtifactRefs.add(ref));
    }
    if (failedReadRequests.length > 1) throw prerequisiteStop("Original read correction allowance is exhausted; no new allowance");
    input.requiredSourceSegmentIds.forEach((id: string) => requiredSourceSegmentIds.add(id));
    inherited.modelCalls += usage.modelCalls; inherited.totalPayloadBytes += usage.totalPayloadBytes;
    spentCalls += usage.modelCalls; spentBytes += usage.totalPayloadBytes;
    if (contentHash(budget.cumulative) !== contentHash(inherited)) throw prerequisiteStop("Recovery cumulative usage changed; no dispatch");
    if (dir === base) originalInputHash = contentHash(input);
    if (isLast) { failedInputHash = contentHash(input); traceHash = contentHash({ run, events }); }
    await retain(failure.sessionFile);
    for (const name of (await fs.readdir(dir)).filter(n => n.startsWith(`${stage}.`) && n !== `${stage}.continuation` && n !== `${stage}.host-recovery`).sort())
      await retain(path.join(dir, name));
    if (dir !== base) for (const name of ["continuation.json", "preflight.json", "budget-amendment.json", "budget-amendment.preflight.json"])
      if (await maybe(path.join(dir, name))) await retain(path.join(dir, name));
  }
  if (request.cause === "source-search-contract" && (continuation || repairedReadFailures < 1 || request.maxRequestBytes !== originalLimits.maxRequestBytes))
    throw prerequisiteStop("Reader recovery requires the original source-search rejection and unchanged byte limits; no dispatch");
  const proposalLimits = { ...originalLimits, maxModelCalls: originalLimits.maxModelCalls - spentCalls,
    maxTotalPayloadBytes: originalLimits.maxTotalPayloadBytes - spentBytes, maxRequestBytes: request.maxRequestBytes };
  const checkLimits = { ...originalCheckLimits, maxRequestBytes: request.cause === "request-size" ? request.maxRequestBytes : originalCheckLimits.maxRequestBytes };
  if (proposalLimits.maxModelCalls < 2 || proposalLimits.maxTotalPayloadBytes < request.maxRequestBytes)
    throw prerequisiteStop("Original stage lacks enough remaining calls/bytes for this recovery; no borrowing or reset");
  const plan = { version: 1 as const, policy: "consumer-host-recovery/v1" as const, request, originalInputHash, failedInputHash, traceHash,
    contractHash: contentHash(contract), retainedFiles, priorUsage: inherited, proposalLimits, checkLimits,
    requiredSourceSegmentIds: [...requiredSourceSegmentIds], requiredArtifactRefs: [...requiredArtifactRefs], failedReadRequests, repairedReadFailures, blockedRequestBytes };
  if (saved && contentHash(saved) !== contentHash(plan)) throw prerequisiteStop("Original recovery evidence or plan changed; preserve both versions, no second recovery");
  return plan;
}
export type ConsumerHostRecovery = Awaited<ReturnType<typeof prepareConsumerHostRecovery>>;
export async function inspectConsumerHostRecovery(root: string, scope: ConsumerRevalidationScope, contract: IdentitySessionContract,
  request?: ConsumerHostRecoveryRequest, expectedHash?: string) {
  const dir = consumerHostRecoveryDirectory(consumerRevalidationDirectory(root, scope)), saved = await maybe(path.join(dir, "recovery.json"));
  if (!request && !saved) return undefined;
  if (expectedHash && (!saved || contentHash(saved) !== expectedHash)) throw prerequisiteStop("Consumer recovery proof is missing or changed; no registration or retry");
  // Once the check starts, immutable historical verification still applies.
  const plan = await prepareConsumerHostRecovery(root, scope, request ?? saved.request, contract);
  return plan;
}
export const consumerHostRecoveryInput = (plan: ConsumerHostRecovery) => ({ policy: plan.policy, recoveryHash: contentHash(plan),
  request: plan.request, priorUsage: plan.priorUsage, requiredSourceSegmentIds: plan.requiredSourceSegmentIds,
  requiredArtifactRefs: plan.requiredArtifactRefs, repairedReadFailures: plan.repairedReadFailures,
  instructions: "Re-read all original mandatory source, the consumer and these retained dependencies. Preserve every original question and criterion. This repairs only a proven reader/transport stop under explicit host authorization. Submit once after complete reads; no world writes, parent resume or further invocation. Historical failures and usage remain binding." });
