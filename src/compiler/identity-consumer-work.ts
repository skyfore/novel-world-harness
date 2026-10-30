import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../world/canonical.js";
import { TraceStore } from "../trace/store.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import type { prepareConsumerRevalidation } from "./identity-consumer-revalidation.js";
import { revalidationContract, prepareConsumerRevalidation as prepareWorkConsumer, consumerRevalidationInput } from "./identity-consumer-revalidation.js";
import type { ConsumerRevalidationRecord, ConsumerRevalidationScope } from "./identity-consumer-revalidation-model.js";
import { initialWorldRevisionFields } from "./initial-world-repair.js";
import { consumerRevalidationDirectory } from "./identity-consumer-revalidation-model.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { consumerStageBudgetDirectories, maybeRecoveryFile, assertConsumerRecoveryInput } from "./identity-consumer-stage-recovery.js";
import { identityQuotaRefusal, verifyQuotaRefusedIdentitySession, verifyStoppedReadOnlyIdentitySession, verifyUnsubmittedIdentitySession } from "./identity-session-integrity.js";
import { CONSUMER_WORK_POLICY, consumerWorkDirectory, createConsumerWorkPlan, type ConsumerWorkPlan, type ConsumerWorkBaseInput, type RetainedWorkFile } from "./consumer-work-plan.js";

type Prepared = Awaited<ReturnType<typeof prepareConsumerRevalidation>>;
const json = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));

export async function prepareConsumerWorkRecord(root: string, scope: ConsumerRevalidationScope, prior: ConsumerRevalidationRecord[], stage: ConsumerWorkPlan["stage"]) {
  const prepared = await prepareWorkConsumer(root, scope.sourceId, scope.taskId, scope.ref, scope.authorizationRef, scope.compilerCorrection?.policy);
  if (contentHash(prepared.scope) !== contentHash(scope)) throw prerequisiteStop("Work record changed its original scope; no registration or retry");
  return prepareConsumerWorkExecution(root, prepared, { ...consumerRevalidationInput(prepared, prior, stage.endsWith("-check")),
    capability: { kind: "initial-world", id: "singleton", writableFields: initialWorldRevisionFields, createsEntity: false } }, stage);
}

/** Only for an exact record already accepted into the verified requirement
 * journal. Its sealed plan is historical evidence; consulting today's active
 * consumer here would invalidate ancestors (or recurse through a successor).
 * New registration still reconstructs and validates the live dependency scope. */
export async function verifyRecordedConsumerWork(root: string, record: ConsumerRevalidationRecord) {
  const scope = record.scope, directory = consumerWorkDirectory(consumerRevalidationDirectory(root, scope));
  const plan = await json(path.join(directory, `${record.output.phase}.plan.json`)) as ConsumerWorkPlan;
  if (contentHash(plan) !== record.executionPlanHash || plan.scopeHash !== contentHash(scope) || plan.stage !== record.output.phase || plan.policy !== CONSUMER_WORK_POLICY)
    throw prerequisiteStop("Recorded consumer work lost its exact sealed plan; preserve history, no registration or retry");
  await assertConsumerWorkRetained(plan);
  const source = await (await WorkspaceStore.create(root)).getSource(scope.sourceId);
  if (!source || source.contentSha256 !== scope.sourceHash) throw prerequisiteStop("Recorded consumer source is missing or changed; no historical verification or retry");
  const expected = createConsumerWorkPlan({ scope, stage: plan.stage, input: plan.baseInput, catalog: plan.artifacts,
    bytes: await readSourceMaterial(root, source), segments: plan.sources, priorUsage: plan.priorUsage,
    retainedFiles: plan.retainedFiles, authorizationRef: plan.authorizationRef, priorReadFailures: plan.priorReadFailures,
    extraSources: plan.sources.map(s => s.id), extraArtifacts: plan.artifacts.map(a => `${a.kind}:${a.id}`) });
  if (contentHash(expected) !== contentHash(plan)) throw prerequisiteStop("Recorded evidence packet no longer reconstructs its original source and artifacts; no retry");
  return { plan, directory, migrated: plan.retainedFiles.length > scope.priorBudgetFiles.length };
}

export async function assertConsumerWorkRetained(plan: ConsumerWorkPlan) {
  for (const file of plan.retainedFiles) if (contentHash(await fs.readFile(file.path, "utf8")) !== file.hash)
    throw prerequisiteStop("Consumer execution migration history changed; inspect the original scope, failure and budget files, no dispatch, registration or retry");
}

/** Convert one settled read-only legacy stage, never a negative judgment or an
 * unknown write outcome. The conversion keeps the old scope/IDs and seals each
 * old file instead of clearing a hard stop or manufacturing a successful read. */
export async function prepareConsumerWorkExecution(root: string, p: Prepared, input: ConsumerWorkBaseInput,
  stage: ConsumerWorkPlan["stage"], authorizationRef?: string) {
  const directory = consumerWorkDirectory(p.directory), file = path.join(directory, `${stage}.plan.json`);
  const saved = await maybeRecoveryFile(file) as ConsumerWorkPlan | null;
  if (saved && authorizationRef && saved.authorizationRef !== authorizationRef)
    throw prerequisiteStop("Consumer execution policy is already frozen under its original authorization; no replacement grant or retry");
  const priorUsage = { ...p.scope.priorUsage }, retainedFiles: RetainedWorkFile[] = [], extraSources = new Set<string>(), extraArtifacts = new Set<string>();
  const priorReadFailures: string[] = [];
  const remember = async (file: string) => {
    const hash = contentHash(await fs.readFile(file, "utf8"));
    if (!retainedFiles.some(r => r.path === file)) retainedFiles.push({ path: file, hash });
  };
  for (const inherited of p.scope.priorBudgetFiles) await remember(inherited.path);
  let legacyAttempts = 0;
  for (const priorStage of ["consumer-revalidation", "consumer-revalidation-check"] as const) {
    if (stage === "consumer-revalidation" && priorStage !== stage) continue;
    for (const old of consumerStageBudgetDirectories(p.directory, priorStage)) {
      if (old === directory && priorStage === stage) continue;
      const invocation = await maybeRecoveryFile(path.join(old, `${priorStage}.invocation.json`));
      const budget = await maybeRecoveryFile(path.join(old, `${priorStage}.budget.json`));
      if (!invocation && !budget) continue;
      if (!invocation || !budget || invocation.scopeHash !== contentHash(p.scope) || invocation.stage !== priorStage
        || budget.scopeHash !== contentHash(p.scope) || budget.stage !== priorStage || budget.originalBudgetHash !== p.scope.originalBudgetHash
        || !Number.isSafeInteger(budget.state?.usage?.modelCalls) || budget.state.usage.modelCalls < 0
        || !Number.isSafeInteger(budget.state?.usage?.totalPayloadBytes) || budget.state.usage.totalPayloadBytes < 0)
        throw prerequisiteStop("Consumer execution policy lost its original invocation or usage; inspect that stage, no migration or retry");
      priorUsage.modelCalls += budget.state.usage.modelCalls; priorUsage.totalPayloadBytes += budget.state.usage.totalPayloadBytes;
      if (priorStage !== stage) {
        // A checked proposal is validated by the normal record verifier before
        // the independent check starts. Keep its exact accounting lineage.
        await remember(path.join(old, `${priorStage}.budget.json`));
        if (old === directory) {
          const proposalPlan = await json(path.join(old, `${priorStage}.plan.json`)) as ConsumerWorkPlan;
          proposalPlan.sources.forEach(s => extraSources.add(s.id)); proposalPlan.artifacts.forEach(a => extraArtifacts.add(`${a.kind}:${a.id}`));
          await remember(path.join(old, `${priorStage}.plan.json`));
        }
        continue;
      }
      legacyAttempts++;
      if (!saved && !authorizationRef?.trim()) throw prerequisiteStop("A consumed legacy stage needs explicit execution-policy migration authorization. Inspect the same source/task/ref with --inspect-execution; retain all files and use --execution-authorization-ref under existing user authority, never reset its budget");
      if (budget.budgetAmendmentHash) throw prerequisiteStop("An explicitly amended call allowance cannot be replaced by the progress policy; preserve its original limit and use its existing recovery, no migration");
      if (budget.state.failure?.code === "no-progress") throw prerequisiteStop("A verified no-progress stop cannot be migrated into another progress window; inspect its retained draft and diagnostics, no dispatch or retry");
      for (const suffix of ["proposal.json", "record.json", "session-checkpoint.json"]) if (await maybeRecoveryFile(path.join(old, `${stage}.${suffix}`)))
        throw prerequisiteStop("This legacy stage already has a proposal or sealed result. Recover its exact registration without model generation; no policy migration or replay");
      const failure = await json(path.join(old, `${stage}.failure.json`));
      const oldInput = await json(path.join(old, `${stage}.input.json`));
      assertConsumerRecoveryInput(oldInput, input);
      if (oldInput.scopeHash !== contentHash(p.scope) || !failure.sessionId || !failure.sessionFile
        || !failure.sessionFile.startsWith(path.join(old, "sessions", stage) + path.sep)
        || await fs.realpath(failure.sessionFile) !== failure.sessionFile)
        throw prerequisiteStop("Legacy failure has no exact settled original session; preserve it, no migration or retry");
      const operation = `receipt-bound-${contentHash(p.scope)}-${stage}${invocation.hostRecoveryHash ? "-host-recovery" : ""}${invocation.continuationHash ? "-continuation" : ""}`;
      const traces = new TraceStore(root), runs = await traces.peekRunsByOperation(p.scope.sourceId, operation);
      if (runs.length !== 1 || runs[0]!.status !== "failed" || !runs[0]!.endedAt)
        throw prerequisiteStop("Legacy execution is unsettled or ambiguous; inspect its exact trace, no migration or retry");
      const [transcript, requests, messages] = await Promise.all([fs.readFile(failure.sessionFile, "utf8"),
        fs.readFile(path.join(old, `${stage}.requests.jsonl`), "utf8"), fs.readFile(path.join(old, `${stage}.messages.jsonl`), "utf8")]);
      const record = { sessionId: failure.sessionId, provider: "openai-codex" as const, model: "gpt-6.1-sol" as const };
      const observed = messages.trimEnd().split("\n").map(line => JSON.parse(line).message);
      const last = observed.at(-1), error = failure.reason.replace(/^Error: /u, "");
      const unsentContext = JSON.parse(requests.trimEnd().split("\n").at(-1)!).phase === "original-context";
      const proof = error === identityQuotaRefusal
        ? verifyQuotaRefusedIdentitySession(transcript, root, record, JSON.stringify(oldInput), requests, messages, revalidationContract)
        : last?.stopReason === "error"
          ? verifyStoppedReadOnlyIdentitySession(transcript, root, record, JSON.stringify(oldInput), requests, messages, revalidationContract,
            error, unsentContext)
          : verifyUnsubmittedIdentitySession(transcript, root, record, JSON.stringify(oldInput), requests, messages, revalidationContract);
      const sizes = proof.payloads.map(value => Buffer.byteLength(JSON.stringify(value))), usage = budget.state.usage;
      if (proof.transcript.responses !== usage.modelCalls || sizes.length !== usage.payloads
        || sizes.reduce((a, b) => a + b, 0) !== usage.totalPayloadBytes
        || Math.max(...sizes, ...proof.contexts.map(v => Buffer.byteLength(JSON.stringify(v)))) !== usage.largestRequestBytes
        || contentHash(budget.cumulative) !== contentHash(priorUsage))
        throw prerequisiteStop("Legacy migration usage differs from actual requests or inherited totals; no reset or dispatch");
      if (budget.state.failure && (!budget.state.blocked || budget.state.failure.message !== error
        || budget.state.failure.code === "call-limit" && usage.modelCalls !== budget.limits.maxModelCalls
        || budget.state.failure.code === "request-size" && (!proof.blockedRequestBytes || proof.blockedRequestBytes <= budget.limits.maxRequestBytes)))
        throw prerequisiteStop("Legacy hard stop disagrees with its original budget and unsent request; preserve it, no migration or retry");
      const calls = new Map<string, { collection?: string; refs?: string[]; segmentIds?: string[] }>();
      for (const message of observed) {
        if (message.role === "assistant") for (const call of message.content) if (call.type === "toolCall") calls.set(call.id, call.arguments);
        const request = calls.get(message.toolCallId);
        if (message.role === "toolResult" && request && message.isError && message.toolName === "read_consumer_revalidation") priorReadFailures.push(contentHash(request));
        if (message.role === "toolResult" && request && !message.isError) {
          request.segmentIds?.forEach(id => extraSources.add(id));
          if (request.collection === "artifacts") request.refs?.forEach(ref => extraArtifacts.add(ref));
        }
      }
      oldInput.requiredSourceSegmentIds.forEach((id: string) => extraSources.add(id));
      for (const name of (await fs.readdir(old)).sort()) if (name.startsWith(`${stage}.`) && (await fs.stat(path.join(old, name))).isFile()) await remember(path.join(old, name));
      for (const name of ["continuation.json", "recovery.json", "preflight.json"]) if (await maybeRecoveryFile(path.join(old, name))) await remember(path.join(old, name));
      await remember(failure.sessionFile);
    }
  }
  const plan = createConsumerWorkPlan({ scope: p.scope, stage, input, catalog: p.catalog, bytes: p.prepared.bytes,
    segments: p.prepared.manifest.segments, priorUsage, retainedFiles,
    authorizationRef: saved?.authorizationRef ?? authorizationRef ?? p.scope.authorizationRef,
    extraSources: [...extraSources], extraArtifacts: [...extraArtifacts], priorReadFailures });
  if (saved && (saved.policy !== CONSUMER_WORK_POLICY || contentHash(saved) !== contentHash(plan)))
    throw prerequisiteStop("Frozen work plan changed its source, requirements, dependencies or history; inspect the original plan, no repinning or retry");
  if (saved) await assertConsumerWorkRetained(saved);
  return { plan: saved ?? plan, directory, migrated: legacyAttempts > 0 };
}
