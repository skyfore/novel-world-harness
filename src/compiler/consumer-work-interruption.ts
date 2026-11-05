import fs from "node:fs/promises";
import path from "node:path";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { contentHash } from "../world/canonical.js";
import { TraceStore } from "../trace/store.js";
import { inspectProcessLiveness, withWorkspaceOperationLock } from "../util/workspace-lock.js";
import { retainPiArtifact } from "../workflow/receipt-bound-pi-stage.js";
import { consumerRevalidationDirectory, consumerRevalidationScopeSchema } from "./identity-consumer-revalidation-model.js";
import { consumerWorkContract, consumerWorkDirectory, consumerWorkInput, workBudgetPolicy, type ConsumerWorkPlan } from "./consumer-work-plan.js";
import { maybeRecoveryFile } from "./identity-consumer-stage-recovery.js";
import { verifyInterruptedFirstRequest } from "./identity-session-integrity.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";

export const consumerWorkOwnerExited = "CONSUMER_WORK_OWNER_EXITED";
const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
const stop = (reason: string) => prerequisiteStop(`${reason}. Run requirements inspect-identity-repairs in the same source/task/ref; copy summary.consumerRevalidation.attempts[].directory and that attempt's stages[].stage. Correct a missing ID/ref once from this discovery, never guess. Inspect compiler-lock on its owning host and recover its exact owner.token, then use settle-interrupted-consumer with that archived lock. Only a complete first request with no output or tools may continue once, with remaining charges retained. Unknown host, live owner, partial evidence or any submission: stop, never retry or delete the invocation.`);

/** Settlement is host bookkeeping, never semantic acceptance or a new grant. */
export async function settleInterruptedConsumerWork(options: {
  root: string; directory: string; stage: "consumer-revalidation" | "consumer-revalidation-check";
  lockRecovery: string; authorizationRef: string; inspect?: boolean;
}) {
  const run = async () => {
    const { root, stage } = options, directory = path.resolve(options.directory);
    const scope = consumerRevalidationScopeSchema.parse(await read(path.join(directory, "scope.json")));
    if (directory !== consumerRevalidationDirectory(root, scope) || await fs.realpath(directory) !== directory || !options.authorizationRef.trim())
      throw stop("Interrupted consumer directory or authorization changed");
    const old = consumerWorkDirectory(directory), get = (suffix: string) => read(path.join(old, `${stage}.${suffix}.json`));
    for (const suffix of ["proposal", "record", "session-checkpoint"])
      if (await maybeRecoveryFile(path.join(old, `${stage}.${suffix}.json`))) throw stop("Original work already submitted");
    const [plan, input, invocation, budget] = await Promise.all(["plan", "input", "invocation", "budget"].map(get));
    const scopeHash = contentHash(scope);
    if (plan.scopeHash !== scopeHash || plan.stage !== stage || plan.providerResumptionHash || plan.bindingRecoveryHash
      || invocation.scopeHash !== scopeHash || invocation.stage !== stage || invocation.executionPlanHash !== contentHash(plan)
      || budget.scopeHash !== scopeHash || budget.stage !== stage || budget.executionPlanHash !== contentHash(plan)
      || budget.originalBudgetHash !== scope.originalBudgetHash || budget.state.blocked || budget.state.failure
      || contentHash(budget.limits) !== contentHash(plan.limits) || contentHash(budget.policy) !== contentHash(workBudgetPolicy(plan))
      || contentHash(budget.priorUsage) !== contentHash(plan.priorUsage) || contentHash(input) !== contentHash(consumerWorkInput(plan)))
      throw stop("Interrupted work lost its original plan, input or allowance");
    const archive = path.resolve(options.lockRecovery);
    if (path.dirname(archive) !== path.join(workspaceStateDir(root), "locks", "recovered") || await fs.realpath(archive) !== archive)
      throw stop("Lock recovery is outside this workspace's preserved lock history");
    const [lock, owner] = await Promise.all([read(path.join(archive, "recovery.json")), read(path.join(archive, "owner.json"))]);
    if (lock.archivePath !== archive || contentHash(lock.owner) !== contentHash(owner) || owner.pid !== invocation.pid
      || contentHash(owner.host) !== contentHash(lock.host) || invocation.host && contentHash(invocation.host) !== contentHash(owner.host)
      || await inspectProcessLiveness(owner) !== "exited") throw stop("Original invocation owner is live, foreign or unverified");
    const traces = new TraceStore(root), runs = await traces.peekRunsByOperation(scope.sourceId, `receipt-bound-${scopeHash}-${stage}-work-v1`);
    const trace = runs[0];
    if (runs.length !== 1 || !trace || !["running", "interrupted"].includes(trace.status)) throw stop("Original trace cannot be settled as interrupted");
    const all = await traces.peekEvents(trace.id), events = all.filter(e => e.type !== "run.interrupted");
    const starts = events.filter(e => e.type === "llm.request.started"), bindings = events.filter(e => e.type === "stage.started" && e.data?.phase === stage && e.data?.scopeHash === scopeHash);
    if (starts.length !== 1 || starts[0]!.data?.providerId !== "openai-codex" || starts[0]!.data?.modelId !== "gpt-6.1-sol"
      || trace.counts.llmRequests !== 1 || trace.counts.toolCalls || trace.counts.retries
      || events.some(e => e.type.startsWith("tool.") || e.type.startsWith("llm.response.") || e.type === "llm.retry" || /^run\.(failed|succeeded)$/u.test(e.type))
      || bindings.length !== 1 || bindings[0]!.data?.phase !== stage || bindings[0]!.data?.scopeHash !== scopeHash
      || bindings[0]!.data?.inputHash !== contentHash(input) || !bindings[0]!.data?.sessionId
      || all.length !== events.length && (all.length !== events.length + 1 || all.at(-1)?.type !== "run.interrupted"))
      throw stop("Original trace is not one unreturned request with no tool execution");
    const sessionId = String(bindings[0]!.data!.sessionId), sessions = path.join(old, "sessions", stage);
    const files = (await fs.readdir(sessions, { recursive: true })).filter(f => f.endsWith(`_${sessionId}.jsonl`)).map(f => path.join(sessions, f));
    if (files.length !== 1 || await fs.realpath(files[0]!) !== files[0]) throw stop("Original saved session is missing or ambiguous");
    const sessionFile = files[0]!;
    const proof = verifyInterruptedFirstRequest(await fs.readFile(sessionFile, "utf8"), root, sessionId, JSON.stringify(input),
      await fs.readFile(path.join(old, `${stage}.requests.jsonl`), "utf8"), await fs.readFile(path.join(old, `${stage}.messages.jsonl`), "utf8"), consumerWorkContract);
    const usage = budget.state.usage, bytes = Buffer.byteLength(JSON.stringify(proof.payloads[0]));
    if (usage.modelCalls !== 1 || usage.payloads !== 1 || usage.totalPayloadBytes !== bytes
      || usage.largestRequestBytes !== Math.max(bytes, Buffer.byteLength(JSON.stringify(proof.contexts[0])))
      || usage.largestRequestBytes > plan.limits.maxRequestBytes
      || (workBudgetPolicy(plan).modelCallsMode === "progress" ? contentHash(budget.state.progress) !== contentHash({ lastProgressCall: 0, milestones: [] }) : budget.state.progress !== undefined)
      || contentHash(budget.cumulative) !== contentHash({ modelCalls: plan.priorUsage.modelCalls + 1, totalPayloadBytes: plan.priorUsage.totalPayloadBytes + bytes }))
      throw stop("Interrupted request charges or progress do not match the complete journal");
    const retained = [sessionFile, path.join(directory, "scope.json"), path.join(archive, "owner.json"), path.join(archive, "recovery.json"),
      ...["plan", "input", "invocation", "budget"].map(s => path.join(old, `${stage}.${s}.json`)),
      ...["requests", "messages"].map(s => path.join(old, `${stage}.${s}.jsonl`))];
    const interruption = { version: 1, policy: "consumer-work-interruption/v1", scopeHash, stage, traceRunId: trace.id,
      sessionId, sessionFile, authorizationRef: options.authorizationRef, lockRecovery: archive, eventsHash: contentHash(events),
      files: await Promise.all(retained.map(async file => ({ path: file, hash: contentHash(await fs.readFile(file, "utf8")) }))),
      providerUsage: "unknown", usage, semanticJudgment: "none" };
    const saved = await maybeRecoveryFile(path.join(old, `${stage}.interruption.json`));
    if (saved && contentHash(saved) !== contentHash(interruption)) throw stop("Frozen interruption proof changed");
    if (options.inspect) return { status: "settlement-ready", scopeHash, stage, traceRunId: trace.id, interruption };
    await retainPiArtifact(path.join(old, `${stage}.interruption.json`), interruption);
    await traces.finishRun(trace.id, "interrupted");
    await retainPiArtifact(path.join(old, `${stage}.failure.json`), { reason: `Error: ${consumerWorkOwnerExited}`, sessionId, sessionFile,
      executionPlanHash: contentHash(plan), usage: { usage }, interruptionHash: contentHash(interruption),
      recovery: { kind: "interrupted", retryAllowed: false, reason: "Owner exited before any response; one later-authorized continuation may use only the original remaining allowance." } });
    return { status: "interrupted", providerResumption: { scopeHash, stage, failedTraceRunId: trace.id,
      authorizationRef: options.authorizationRef, authorizedAt: new Date().toISOString(), cause: "owner-exited" as const } };
  };
  try { return await (options.inspect ? run() : withWorkspaceOperationLock(options.root, "compiler", run)); }
  catch (error) {
    if (String(error).includes("ROLE_PREREQUISITE_HOST_REVIEW")) throw error;
    throw stop(String(error));
  }
}

/** Recheck retained bytes and settled trace every time a continuation is used. */
export async function verifyConsumerWorkInterruption(root: string, directory: string, plan: ConsumerWorkPlan, failure: any) {
  const proof = await read(path.join(directory, `${plan.stage}.interruption.json`));
  if (proof.policy !== "consumer-work-interruption/v1" || proof.scopeHash !== plan.scopeHash || proof.stage !== plan.stage
    || failure.reason !== `Error: ${consumerWorkOwnerExited}` || failure.interruptionHash !== contentHash(proof)
    || failure.sessionId !== proof.sessionId || failure.sessionFile !== proof.sessionFile || contentHash(failure.usage?.usage) !== contentHash(proof.usage))
    throw stop("Interrupted continuation lost its settlement proof");
  for (const file of proof.files) if (contentHash(await fs.readFile(file.path, "utf8")) !== file.hash) throw stop("Interrupted original evidence changed");
  const traces = new TraceStore(root), runs = await traces.peekRunsByOperation(plan.baseInput.scope.sourceId, `receipt-bound-${plan.scopeHash}-${plan.stage}-work-v1`);
  const run = runs[0], events = run ? await traces.peekEvents(run.id) : [];
  const starts = events.filter(e => e.type === "llm.request.started"), bindings = events.filter(e => e.type === "stage.started" && e.data?.phase === plan.stage && e.data?.scopeHash === plan.scopeHash);
  if (runs.length !== 1 || run?.id !== proof.traceRunId || run.status !== "interrupted" || !run.endedAt || events.at(-1)?.type !== "run.interrupted"
    || contentHash(events.slice(0, -1)) !== proof.eventsHash || starts.length !== 1 || run.counts.llmRequests !== 1 || run.counts.toolCalls || run.counts.retries
    || starts[0]!.data?.providerId !== "openai-codex" || starts[0]!.data?.modelId !== "gpt-6.1-sol"
    || bindings.length !== 1 || bindings[0]!.data?.sessionId !== proof.sessionId || bindings[0]!.data?.inputHash !== contentHash(consumerWorkInput(plan))
    || events.some(e => e.type.startsWith("tool.") || e.type.startsWith("llm.response.") || e.type === "llm.retry")) throw stop("Interrupted trace lost its exact settled request");
  return proof;
}
