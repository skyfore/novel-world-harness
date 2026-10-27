import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../world/canonical.js";
import { RequirementLedger } from "./requirement-ledger.js";
import { UpstreamRepairLedger } from "./upstream-repair-ledger.js";
import { CompilerFinishReceipts } from "./finish-receipts.js";
import { identityRequirementDirectory } from "./identity-requirements.js";
import { identityUpstreamDirectory, verifyIdentityUpstreamAcceptance } from "./identity-requirement-acceptance.js";
import { verifyUpstreamRepairPlan } from "./upstream-repair-preflight.js";
import { readIdentityAuthority } from "./identity-requirement-upstream.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { consumerRevalidationId, consumerRevalidationDirectory, consumerRevalidationScopeSchema,
  validateConsumerRevalidationHistory, validateConsumerCorrectionLineage, type ConsumerRevalidationRecord, type ConsumerRevalidationScope } from "./identity-consumer-revalidation-model.js";
import { verifyIdentityUpstreamSession } from "./identity-upstream-session.js";
import { resolveTextSelectorAnchor } from "./text-anchors.js";
import { TraceStore } from "../trace/store.js";
import { SOURCE_LOCAL_CORRECTION, sourceLocalContractHash, sourceLocalConsumerContract, consumerRevalidationLimits } from "./identity-consumer-correction.js";
import { consumerStageRecoveryDirectory, consumerStageUsage, consumerRecoveryInput, verifyConsumerStageRecovery, assertConsumerRecoveryInput, maybeRecoveryFile } from "./identity-consumer-stage-recovery.js";
import { inspectConsumerBudgetAmendment, consumerRecoveryLimits } from "./identity-consumer-budget-amendment.js";
import { verifyConsumerRefRecovery } from "./identity-consumer-ref-recovery.js";

export const revalidationContract = { terminalTool: "submit_consumer_revalidation", readTools: ["read_consumer_revalidation"], receipt: "retained" as const, allowCorrectedSubmission: true };
export const consumerRevalidationModelScope = (scope: ConsumerRevalidationScope) => {
  const { priorBudgetFiles: _, ...modelScope } = scope; return modelScope;
};
const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
export function revalidationRecords(history: Awaited<ReturnType<RequirementLedger["history"]>>, taskId: string) {
  return history.flatMap(r => r.payload.kind === "identity-consumer-revalidation" && r.payload.record.scope.taskId === taskId ? [r.payload.record] : []);
}

/** Both forms are already emitted by compiler discovery. Resolve an exact
 * kind/id pair only; never change an ID, guess an alias or cross source scope. */
export function findConsumerArtifact<T extends { kind: string; id: string }>(catalog: readonly T[], ref: string): T | undefined {
  return catalog.find(c => ref === `${c.kind}:${c.id}` || ref === `${c.kind}/${c.id}`);
}

export function discoverConsumerArtifacts<T extends { kind: string; id: string }>(catalog: readonly T[], query = "") {
  const term = query.trim().toLowerCase();
  return catalog.filter(c => !term || `${c.kind}:${c.id}`.toLowerCase().includes(term));
}

export function currentConsumerPayload(consumer: { ref: string; reason: string; payload: unknown }, current: {
  payloads: ReadonlyMap<string, unknown>; activeRevisions: ReadonlyMap<string, string>;
}) {
  if (consumer.reason !== "typed-consumer") throw prerequisiteStop("Source-review consumers require their original owning audit, not a world-payload revalidation. Inspect requirements inspect-identity-repairs for the same source/task and its sourceReviewCoverage; preserve the full denominator, no dispatch or unchanged retry");
  const artifactKind: Record<string, string> = { initial: "initial-world", event: "canonical-event", participation: "event-participation",
    spatial: "spatial-relation", scene: "scene-occurrence", frame: "event-frame", action: "action-schema", constraint: "action-constraint",
    norm: "norm-template", process: "process-template", rule: "world-rule", goal: "character-goal", model: "character-model" };
  const [kind, ...idParts] = consumer.ref.split("/"), id = idParts.join("/");
  const annotation = kind === "annotation" && consumer.payload && typeof consumer.payload === "object" && "annotationType" in consumer.payload
    ? String(consumer.payload.annotationType) : null;
  const key = `${annotation ?? artifactKind[kind!] ?? kind}:${kind === "initial" ? "singleton" : id}`;
  const payload = current.payloads.get(key);
  if (!payload || current.activeRevisions.get(key) !== contentHash(payload))
    throw prerequisiteStop("Selected consumer has no exact active world revision; a retained predecessor is audit evidence, not current truth. Inspect the same source/task/ref and its owning replacement history; no fallback to the frozen payload or model dispatch");
  return payload;
}

/** A successor's origin already includes the earlier reviews and continuations.
 * Carry their immutable files forward without charging those same calls twice. */
export async function inheritConsumerRevalidationBudgets(upstreamDirectory: string, reviewsDirectory: string) {
  const startFile = path.join(upstreamDirectory, "start.json"), start = await read(startFile);
  const priorUsage = { ...start.origin.priorUsage } as { modelCalls: number; totalPayloadBytes: number };
  const priorBudgetFiles: ConsumerRevalidationScope["priorBudgetFiles"] = [], seen = new Map<string, string>();
  const remember = async (file: string, expectedHash?: string, charge = false) => {
    const value = await read(file), hash = contentHash(value), prior = seen.get(file);
    if ((expectedHash && hash !== expectedHash) || (prior && hash !== prior)) throw prerequisiteStop("Inherited Pi budget changed; preserve its original charges, no revalidation or reset");
    if (prior) return;
    seen.set(file, hash); priorBudgetFiles.push({ path: file, hash });
    if (charge) {
      if (value.originalBudgetHash !== start.origin.originalBudgetHash) throw prerequisiteStop("Review budget changed its original authority; no revalidation or reset");
      priorUsage.modelCalls += value.state.usage.modelCalls; priorUsage.totalPayloadBytes += value.state.usage.totalPayloadBytes;
    }
  };
  await remember(startFile);
  for (const file of start.origin.budgetFiles ?? []) await remember(file.path, file.hash);
  const { identityUpstreamBudgetStages, readIdentityCorrectionIntent } = await import("./identity-upstream-correction-model.js");
  if (await readIdentityCorrectionIntent(upstreamDirectory)) {
    await remember(path.join(upstreamDirectory, "correction.intent.json"));
    await remember(path.join(upstreamDirectory, "correction.proof.json"));
  }
  for (const stage of await identityUpstreamBudgetStages(upstreamDirectory, start.order)) await remember(path.join(upstreamDirectory, `${stage}.budget.json`), undefined, true);
  const names = await fs.readdir(reviewsDirectory, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
  for (const entry of names.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = path.join(reviewsDirectory, entry.name);
    for (const stage of ["consumer-revalidation", "consumer-revalidation-check"]) for (const dir of [directory, consumerStageRecoveryDirectory(directory, stage)]) {
      const file = path.join(dir, `${stage}.budget.json`);
      if (await maybeRecoveryFile(file)) await remember(file, undefined, true);
    }
  }
  return { priorUsage, priorBudgetFiles };
}

/** The completed upstream receipt is a changed dependency, never permission to
 * invoke an old consumed review. Current and original payloads remain separate. */
async function prepareOriginalConsumerRevalidation(root: string, sourceId: string, taskId: string, ref: string, authorizationRef: string) {
  const ledger = new RequirementLedger(root, sourceId), history = await ledger.history(), original = await ledger.identityRequirements(taskId);
  const plans = await new UpstreamRepairLedger(root, sourceId).inspect();
  const upstream = plans.plans.findLast(p => p.plan.identityRequirements?.taskId === taskId && p.plan.identityRequirements.consumerRepair);
  if (!upstream || !["converged", "evaluated"].includes(upstream.state) || !upstream.finishedReceipt || plans.modelSessions.some(s => !s.closed))
    throw prerequisiteStop("Consumer revalidation requires the same task's settled accepted entity repair; inspect requirements inspect-upstream, copy plans[].plan.planHash, no unchanged retry");
  const { prepared } = await readIdentityAuthority(root, upstream.plan);
  const consumer = prepared.inventory.consumers.find(c => c.ref === ref);
  if (!consumer) throw prerequisiteStop("Unknown consumer; inspect-identity-repairs with the same source/task, copy availableRefs[] to --ref once, no guessing");
  const receipt = await new CompilerFinishReceipts(root, sourceId, upstream.plan.batchId).read();
  if (!receipt || receipt.state !== "completed" || receipt.fingerprint !== upstream.finishedReceipt || !receipt.identity.upstreamRepairIntent)
    throw prerequisiteStop("Original entity repair has no exact completed receipt; stop, preserve its history");
  const acceptance = await verifyIdentityUpstreamAcceptance(root, upstream.plan);
  const current = await verifyUpstreamRepairPlan(root, upstream.plan, new Map(receipt.identity.upstreamRepairIntent.proposals.map(p => [`${p.artifactKind}:${p.artifactId}`, p.payloadHash])));
  // Historical resolution baselines remain readable, explicitly distinguished
  // from active decisions. Source-review consumers keep their original owners.
  const catalog = [...current.payloads].filter(([key]) => !key.startsWith("source-segment:")).map(([key, payload]) => ({
    kind: key.slice(0, key.indexOf(":")), id: key.slice(key.indexOf(":") + 1), revisionHash: contentHash(payload), payload,
    current: current.activeRevisions.get(key) === contentHash(payload),
  }));
  const payload = currentConsumerPayload(consumer, current);
  const old = original[0]!.intent, definition = original[0]!.output;
  if (definition.phase !== "identity-definition") throw prerequisiteStop("Original independent requirements missing");
  const idInput = { taskId, ref, receiptFingerprint: receipt.fingerprint }, previous = revalidationRecords(history, taskId).filter(r => consumerRevalidationId(r.scope) === consumerRevalidationId(idInput));
  const directory = path.join(identityRequirementDirectory(root, sourceId, taskId), "consumer-revalidation", consumerRevalidationId(idInput));
  let retained: ConsumerRevalidationScope | null = null;
  try { retained = consumerRevalidationScopeSchema.parse(await read(path.join(directory, "scope.json"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const priorBudgetFiles: ConsumerRevalidationScope["priorBudgetFiles"] = [], priorUsage = { modelCalls: 0, totalPayloadBytes: 0 };
  if (retained) {
    priorBudgetFiles.push(...retained.priorBudgetFiles); Object.assign(priorUsage, retained.priorUsage);
    for (const file of priorBudgetFiles) if (contentHash(await read(file.path)) !== file.hash) throw prerequisiteStop("Inherited Pi budget changed; no revalidation or reset");
  } else {
    const inherited = await inheritConsumerRevalidationBudgets(identityUpstreamDirectory(root, upstream.plan), path.dirname(directory));
    Object.assign(priorUsage, inherited.priorUsage); priorBudgetFiles.push(...inherited.priorBudgetFiles);
  }
  const scope = consumerRevalidationScopeSchema.parse({ version: 1, sourceId, sourceHash: old.sourceHash, taskId, identityIntentHash: contentHash(old),
    inventoryHash: old.inventoryHash, definitionHash: contentHash(definition), requirementIds: definition.requirements.map(r => r.id), ref,
    originalRevisionHash: consumer.revisionHash, currentRevisionHash: contentHash(payload), upstreamPlanHash: upstream.plan.planHash,
    receiptFingerprint: receipt.fingerprint, acceptanceHash: contentHash(acceptance), parentStateHash: old.parentStateHash,
    originalBudgetHash: old.originalBudgetHash, authorizationRef, priorUsage, priorBudgetFiles,
    requirementPrefix: retained?.requirementPrefix ?? { length: history.length, head: history.at(-1)!.hash } });
  if ((retained && contentHash(retained) !== contentHash(scope)) || history[scope.requirementPrefix.length - 1]?.hash !== scope.requirementPrefix.head)
    throw prerequisiteStop("Frozen consumer revalidation dependencies changed; preserve both versions, no repinning or redispatch");
  return { scope, original, prepared, consumer, current: { payload, revisionHash: contentHash(payload) }, catalog, receipt, acceptance, previous, directory,
    correctionPredecessor: [] as ConsumerRevalidationRecord[] };
}

export async function prepareConsumerRevalidation(root: string, sourceId: string, taskId: string, ref: string, authorizationRef: string, compilerCorrection?: string) {
  if (!compilerCorrection) return prepareOriginalConsumerRevalidation(root, sourceId, taskId, ref, authorizationRef);
  if (compilerCorrection !== SOURCE_LOCAL_CORRECTION || !authorizationRef.trim()) throw prerequisiteStop("Unsupported compiler correction; inspect the original same-task blocked consumer and supported source-local-referent/v1 correction, no guessed policy or retry");
  const history = await new RequirementLedger(root, sourceId).history(), all = revalidationRecords(history, taskId);
  const prior = all.findLast(r => r.scope.ref === ref && !r.scope.compilerCorrection);
  if (!prior) throw prerequisiteStop("Compiler correction requires the retained original consumer review; no replacement task or fresh budget");
  const p = await prepareOriginalConsumerRevalidation(root, sourceId, taskId, ref, prior.scope.authorizationRef);
  for (const record of p.previous) await verifyConsumerRevalidationRecord(root, record);
  const compiler = { policy: SOURCE_LOCAL_CORRECTION, predecessorId: consumerRevalidationId(p.scope), predecessorScopeHash: contentHash(p.scope),
    predecessorRecordHashes: p.previous.map(contentHash) as [string, string], contractHash: await sourceLocalContractHash() };
  const id = consumerRevalidationId({ ...p.scope, compilerCorrection: compiler });
  const directory = path.join(path.dirname(p.directory), id);
  let retained: ConsumerRevalidationScope | undefined;
  try { retained = consumerRevalidationScopeSchema.parse(await read(path.join(directory, "scope.json"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const priorUsage = { ...p.scope.priorUsage }, priorBudgetFiles = [...p.scope.priorBudgetFiles];
  for (const stage of ["consumer-revalidation", "consumer-revalidation-check"]) {
    const file = path.join(p.directory, `${stage}.budget.json`), value = await read(file);
    priorBudgetFiles.push({ path: file, hash: contentHash(value) });
    priorUsage.modelCalls += value.state.usage.modelCalls; priorUsage.totalPayloadBytes += value.state.usage.totalPayloadBytes;
  }
  const scope = consumerRevalidationScopeSchema.parse({ ...p.scope, compilerCorrection: compiler, authorizationRef, priorUsage, priorBudgetFiles,
    requirementPrefix: retained?.requirementPrefix ?? { length: history.length, head: history.at(-1)!.hash } });
  validateConsumerCorrectionLineage(scope, all);
  if (retained && contentHash(retained) !== contentHash(scope)) throw prerequisiteStop("Original compiler correction is frozen or consumed; no repinning, changed authorization or new model invocation");
  for (const stage of ["consumer-revalidation", "consumer-revalidation-check"]) await consumerRevalidationLimits(root, scope, stage);
  return { ...p, scope, directory, previous: all.filter(r => consumerRevalidationId(r.scope) === id), correctionPredecessor: p.previous };
}

export function consumerRevalidationInput(p: Awaited<ReturnType<typeof prepareConsumerRevalidation>>, previous: ConsumerRevalidationRecord[], check: boolean) {
  const dependencyKeys = new Set(["initial-world:singleton", ...p.prepared.intent.targets.flatMap(t => [
    `entity-mention:${t.mentionId}`, ...(t.predecessor ? [`entity-resolution:${t.predecessor.id}`] : []),
  ]), ...(p.receipt?.identity.upstreamRepairIntent?.proposals ?? []).map(r => `${r.artifactKind}:${r.artifactId}`)]);
  return { scope: consumerRevalidationModelScope(p.scope), scopeHash: contentHash(p.scope), definition: p.original[0]!.output, definitionCheck: p.original[1]!.output,
    originalQuestions: p.prepared.review.scope.questions, originalSemanticScope: p.prepared.semantic[0]!.output,
    originalConsumer: p.consumer, currentConsumer: p.current, acceptedDependency: p.acceptance.output,
    artifactReadRefs: p.catalog.filter(c => dependencyKeys.has(`${c.kind}:${c.id}`)).map(c => ({ ref: `${c.kind}:${c.id}`,
      revisionHash: c.revisionHash, current: c.current })),
    ...(p.scope.compilerCorrection ? { compilerCorrection: sourceLocalConsumerContract, previousCompilerJudgments: p.correctionPredecessor.map(r => r.output) } : {}),
    requiredSourceSegmentIds: [...new Set([...p.prepared.intent.requiredSourceSegmentIds,
      ...(check && previous[0]!.output.phase === "consumer-revalidation" ? [...previous[0]!.output.initialWorldRepair?.segmentIds ?? [], ...previous[0]!.output.entityRepair?.segmentIds ?? []] : [])])],
    ...(check ? { proposal: previous[0]!.output, proposalHash: contentHash(previous[0]!.output) } : {}),
    denominator: { total: p.prepared.inventory.consumers.length, refs: p.prepared.inventory.consumers.map(c => c.ref),
      candidateIds: p.prepared.inventory.candidateIds, sourcePages: p.prepared.inventory.sourcePages,
      originalQuestionIds: p.prepared.inventory.originalQuestionIds },
  };
}

/** Verify actual Pi submission/read receipts before ledger registration. */
export async function verifyConsumerRevalidationRecord(root: string, record: ConsumerRevalidationRecord) {
  const s = record.scope, ledger = new RequirementLedger(root, s.sourceId), original = await ledger.identityRequirements(s.taskId);
  const all = revalidationRecords(await ledger.history(), s.taskId);
  validateConsumerCorrectionLineage(s, all);
  // Historical evidence is bound to its actual scope, transcript, contract and
  // original budget below. Current implementation bytes gate NEW dispatch in
  // the workflow, not verification of a sealed completed judgment. Otherwise
  // even a later regression-test edit makes every downstream receipt unreadable.
  const prior = record.output.phase === "consumer-revalidation" ? [] : revalidationRecords(await ledger.history(), s.taskId).filter(r => consumerRevalidationId(r.scope) === consumerRevalidationId(s) && r.output.phase === "consumer-revalidation");
  validateConsumerRevalidationHistory([...prior, record], original);
  const baseDirectory = consumerRevalidationDirectory(root, s), stage = record.output.phase;
  const continuation = record.continuationHash ? await verifyConsumerStageRecovery(root, s, stage, record.continuationHash, revalidationContract, record.budgetAmendmentHash) : null;
  const directory = continuation ? consumerStageRecoveryDirectory(baseDirectory, stage) : baseDirectory;
  const amendment = continuation ? await inspectConsumerBudgetAmendment(directory, continuation) : undefined;
  const proof = record.refRecoveryHash ? await verifyConsumerRefRecovery(root, s, directory, revalidationContract, record.refRecoveryHash)
    : await verifyIdentityUpstreamSession(root, directory, stage, { ...record, planHash: contentHash(s) }, revalidationContract);
  const input = await read(path.join(directory, `${stage}.input.json`)), budget = await read(path.join(directory, `${stage}.budget.json`));
  if (continuation) {
    assertConsumerRecoveryInput(await read(path.join(baseDirectory, `${stage}.input.json`)), input);
    const invocation = await read(path.join(directory, `${stage}.invocation.json`));
    if (invocation.scopeHash !== contentHash(s) || invocation.stage !== stage || invocation.continuationHash !== record.continuationHash
      || invocation.budgetAmendmentHash !== record.budgetAmendmentHash)
      throw prerequisiteStop("Continuation invocation is detached from its frozen original failure; no replay");
  }
  const limits = continuation ? consumerRecoveryLimits(continuation, amendment) : await consumerRevalidationLimits(root, s, stage);
  const traces = new TraceStore(root), run = await traces.peekRun(record.traceRunId), events = await traces.peekEvents(record.traceRunId);
  if (run.status !== (record.refRecoveryHash ? "failed" : "succeeded") || run.sourceId !== s.sourceId || contentHash(input) !== record.inputHash
    || proof.sessionId !== record.sessionId || proof.traceRunId !== record.traceRunId
    || contentHash(proof.output) !== contentHash(record.output) || contentHash(input.scope) !== contentHash(consumerRevalidationModelScope(s))
    || contentHash(budget.limits) !== contentHash(limits) || budget.originalBudgetHash !== s.originalBudgetHash
    || budget.budgetAmendmentHash !== record.budgetAmendmentHash)
    throw prerequisiteStop("Consumer revalidation is detached from its actual source, session or budget; stop without replay");
  if (continuation && (contentHash(input.continuation) !== contentHash(consumerRecoveryInput(continuation, amendment))
    || record.sessionId === continuation.originalSessionId || record.traceRunId === continuation.originalTraceRunId
    || run.operationId !== `receipt-bound-${contentHash(s)}-${stage}-continuation`))
    throw prerequisiteStop("Consumer continuation lost its exact failure lineage or fresh evidence session; no retry");
  const sourceIds = new Set<string>(), refs = new Set<string>();
  for (const event of events.filter(e => e.type === "tool.call.completed" && e.data?.toolName === "read_consumer_revalidation")) {
    const call = events.find(e => e.type === "tool.call.started" && e.toolCallId === event.toolCallId);
    if (!call?.blobRef) throw prerequisiteStop("Consumer revalidation lost its complete read receipt");
    const request = await traces.peekBlob(call.blobRef) as { collection?: string; segmentIds?: string[]; refs?: string[] };
    request.segmentIds?.forEach(id => sourceIds.add(id));
    request.refs?.forEach(id => refs.add(request.collection === "artifacts" && !id.includes(":") ? id.replace("/", ":") : id));
  }
  if (input.requiredSourceSegmentIds.some((id: string) => !sourceIds.has(id)) || !refs.has(s.ref)) throw prerequisiteStop("Consumer revalidation omitted required full source or consumer reads");
  if (continuation?.pendingArtifactRefs.some(ref => !refs.has(ref))) throw prerequisiteStop("Consumer continuation omitted its original unfinished artifact reads; no registration or retry");
  const raw = await read(path.join(identityRequirementDirectory(root, s.sourceId, s.taskId), "context.json"));
  if (contentHash(raw.intent) !== s.identityIntentHash || contentHash(raw.inventory) !== s.inventoryHash
    || contentHash(record.evidence.map(e => e.selector)) !== contentHash(record.output.evidence)) throw prerequisiteStop("Consumer revalidation changed its original inventory or evidence");
  if (contentHash(input.definition) !== contentHash(original[0]!.output) || contentHash(input.definitionCheck) !== contentHash(original[1]!.output)
    || contentHash(input.originalQuestions) !== contentHash(raw.review.scope.questions)
    || contentHash(input.originalSemanticScope) !== contentHash(raw.semantic[0].output)
    || contentHash(input.denominator) !== contentHash({ total: raw.inventory.consumers.length, refs: raw.inventory.consumers.map((c: { ref: string }) => c.ref),
      candidateIds: raw.inventory.candidateIds, sourcePages: raw.inventory.sourcePages, originalQuestionIds: raw.inventory.originalQuestionIds })
    || input.originalConsumer.ref !== s.ref || input.originalConsumer.revisionHash !== s.originalRevisionHash
    || input.currentConsumer.revisionHash !== s.currentRevisionHash
    || (record.output.phase === "consumer-revalidation-check" && contentHash(input.proposal) !== contentHash(prior[0]!.output)))
    throw prerequisiteStop("Consumer revalidation input changed its original criteria, question inventory, consumer or checked proposal");
  const inherited = { ...s.priorUsage };
  if (record.output.phase === "consumer-revalidation-check") {
    const proposalUsage = await consumerStageUsage(baseDirectory, "consumer-revalidation");
    inherited.modelCalls += proposalUsage.modelCalls; inherited.totalPayloadBytes += proposalUsage.totalPayloadBytes;
  }
  if (continuation) {
    const failedBudget = await read(path.join(baseDirectory, `${stage}.budget.json`));
    inherited.modelCalls += failedBudget.state.usage.modelCalls; inherited.totalPayloadBytes += failedBudget.state.usage.totalPayloadBytes;
    if (contentHash(inherited) !== contentHash(continuation.priorUsage)) throw prerequisiteStop("Continuation changed its inherited original usage");
  }
  const usage = budget.state.usage;
  if (s.compilerCorrection && (contentHash(input.compilerCorrection) !== contentHash(sourceLocalConsumerContract)
    || contentHash(input.previousCompilerJudgments) !== contentHash(all.filter(r => consumerRevalidationId(r.scope) === s.compilerCorrection!.predecessorId).map(r => r.output))))
    throw prerequisiteStop("Compiler correction omitted its original negative judgments or changed its typed capability contract");
  if (contentHash(budget.priorUsage) !== contentHash(inherited) || usage.modelCalls < 1 || usage.modelCalls > limits.maxModelCalls
    || usage.totalPayloadBytes > limits.maxTotalPayloadBytes || usage.largestRequestBytes > limits.maxRequestBytes
    || contentHash(budget.cumulative) !== contentHash({ modelCalls: inherited.modelCalls + usage.modelCalls, totalPayloadBytes: inherited.totalPayloadBytes + usage.totalPayloadBytes }))
    throw prerequisiteStop("Consumer revalidation reset or detached inherited usage; retain all original charges");
  if (record.output.phase === "consumer-revalidation" && !sameQuestions(record.output.retainedQuestionIds, raw.inventory.originalQuestionIds)) throw prerequisiteStop("Consumer revalidation omitted an original blocked question");
  for (const evidence of record.evidence) {
    const segment = raw.manifest.segments.find((s: { id: string }) => s.id === evidence.selector.segment_id);
    if (!segment || !sourceIds.has(segment.id) || contentHash(await resolveTextSelectorAnchor(root, segment, evidence.selector)) !== contentHash(evidence.anchor))
      throw prerequisiteStop("Consumer revalidation evidence is not the exact original source read");
  }
}
const sameQuestions = (a: string[], b: string[]) => new Set(a).size === a.length && contentHash([...a].sort()) === contentHash([...b].sort());
