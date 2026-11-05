import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../world/canonical.js";
import { canonicalEventSchema, idSchema, type CanonicalEvent } from "../world/model.js";
import { applyEventExecutions, eventExecutionSchema, type EventExecution } from "../world/event-execution.js";
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
import { consumerStageRecoveryDirectory, consumerStageBudgetDirectories, consumerStageUsage, consumerRecoveryInput, verifyConsumerStageRecovery, assertConsumerRecoveryInput, maybeRecoveryFile } from "./identity-consumer-stage-recovery.js";
import { inspectConsumerBudgetAmendment, consumerRecoveryLimits } from "./identity-consumer-budget-amendment.js";
import { inspectConsumerHostRecovery, consumerHostRecoveryDirectory, consumerHostRecoveryInput } from "./identity-consumer-host-recovery.js";
import { verifyConsumerRefRecovery } from "./identity-consumer-ref-recovery.js";
import { consumerArtifactKey, consumerDependencyCatalog, consumerArtifactReadHint } from "./identity-consumer-artifacts.js";
import { consumerWorkContract, consumerWorkDirectory, consumerWorkInput, workBudgetPolicy, verifyConsumerWorkProgress } from "./consumer-work-plan.js";
import { prepareConsumerWorkExecution, prepareConsumerWorkRecord, verifyRecordedConsumerWork } from "./identity-consumer-work.js";
import { CONSUMER_REVIEW_CORRECTION, deriveConsumerReviewContract, consumerReviewCapability, consumerReviewCorrectionContract } from "./consumer-review-contract.js";
import { consumerReviewCorrectionHash } from "./identity-consumer-correction.js";
import { consumerEvidenceCorrectionHash } from "./identity-consumer-correction.js";
import { CONSUMER_EVIDENCE_COVERAGE, consumerEvidenceCorrectionContract, consumerEvidenceStop, consumerEvidenceCoverage,
  assertConsumerEvidenceRead, additionalConsumerEvidenceSubjects, createConsumerEvidenceReads, acceptConsumerEvidenceRead, type ConsumerReadRequest } from "./consumer-evidence-coverage.js";
import { consumerWorkRecordDirectory, readConsumerWorkRecordEvidence } from "./consumer-work-evidence.js";
import { inspectConsumerEvidenceGap } from "./consumer-evidence-correction.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { assertBoundPreviewAllowance } from "./consumer-review-binding.js";
import { prepareConsumerBindingRecovery, verifyRecordedBindingRecovery } from "./consumer-binding-recovery.js";
import { prepareWorkProviderResumption, verifyRecordedWorkProviderResumption, workProviderStop } from "./consumer-work-provider-resumption.js";

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
export function findConsumerArtifact<T extends { kind: string; id: string; aliases?: string[] }>(catalog: readonly T[], ref: string): T | undefined {
  return catalog.find(c => ref === `${c.kind}:${c.id}` || ref === `${c.kind}/${c.id}` || c.aliases?.includes(ref));
}

export function discoverConsumerArtifacts<T extends { kind: string; id: string; aliases?: string[] }>(catalog: readonly T[], query = "") {
  const term = query.trim().toLowerCase();
  return catalog.filter(c => !term || [`${c.kind}:${c.id}`, ...c.aliases ?? []].some(ref => ref.toLowerCase().includes(term)));
}

export function currentConsumerPayload(consumer: { ref: string; reason: string; payload: unknown }, current: {
  payloads: ReadonlyMap<string, unknown>; activeRevisions: ReadonlyMap<string, string>;
}) {
  if (consumer.reason !== "typed-consumer") throw prerequisiteStop("Source-review consumers require their original owning audit, not a world-payload revalidation. Inspect requirements inspect-identity-repairs for the same source/task and its sourceReviewCoverage; preserve the full denominator, no dispatch or unchanged retry");
  const [kind, ...idParts] = consumer.ref.split("/"), id = idParts.join("/");
  if (kind === "entry") {
    const stop = (reason: string) => prerequisiteStop(`${reason}. Inspect requirements inspect-identity-repairs with the same --source/--task and --ref ${consumer.ref}, and its owning canonical-event/event-execution revisions. Resolve the active dependency before dispatch; no frozen-payload fallback, guessed ref or unchanged retry`);
    const [actorId, eventId] = idParts;
    if (idParts.length !== 2 || !idSchema.safeParse(actorId).success || !idSchema.safeParse(eventId).success)
      throw stop("Entry consumer ref is not the original actor/event pair");
    const active = (key: string) => {
      const payload = current.payloads.get(key);
      if (!payload || current.activeRevisions.get(key) !== contentHash(payload))
        throw stop(`Entry owner has no exact active world revision: ${key}`);
      return payload;
    };
    const rawEvent = active(`canonical-event:${eventId}`), parsedEvent = canonicalEventSchema.safeParse(rawEvent);
    if (!parsedEvent.success || parsedEvent.data.id !== eventId) throw stop("Entry owner is not the exact canonical event");
    const event = rawEvent as CanonicalEvent, bindings: EventExecution[] = [];
    for (const key of current.activeRevisions.keys()) {
      if (!key.startsWith("event-execution:")) continue;
      const raw = active(key), parsed = eventExecutionSchema.safeParse(raw);
      if (!parsed.success || key !== `event-execution:${parsed.data.id}`) throw stop("Active execution binding is missing or invalid");
      const binding = raw as EventExecution;
      if (binding.canonicalEventId !== event.id || !binding.entryCheckpoint
        || binding.actorId !== actorId && binding.entryCheckpoint.actorId !== actorId) continue;
      if (binding.actorId !== binding.entryCheckpoint.actorId) throw stop("Entry execution binding changed its owning actor");
      bindings.push(binding);
    }
    if (bindings.length > 1 || (event.characterEntryCheckpoints ?? []).filter(c => c.actorId === actorId).length > 1)
      throw stop("Entry consumer has ambiguous active checkpoints or execution bindings");
    // Match the inventory/runtime projection without treating a retained entry
    // snapshot as an independently active artifact or mutating either owner.
    const checkpoint = applyEventExecutions([event], bindings)[0]!.characterEntryCheckpoints?.find(c => c.actorId === actorId);
    if (!checkpoint) throw stop("Selected actor has no entry checkpoint in the active event projection");
    return checkpoint;
  }
  const key = consumerArtifactKey(consumer.ref, consumer.payload, id);
  const payload = key ? current.payloads.get(key) : undefined;
  if (!key || !payload || current.activeRevisions.get(key) !== contentHash(payload))
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
    for (const stage of ["entry-presence-proposal", "entry-presence-check"]) {
      const file = path.join(directory, "presence-repair", `${stage}.budget.json`);
      if (await maybeRecoveryFile(file)) await remember(file, undefined, true);
    }
    for (const folder of ["state-repair", "wording-repair", "delta-binding-repair"]) for (const stage of ["entry-state-proposal", "entry-state-check"]) {
      const file = path.join(directory, folder, `${stage}.budget.json`);
      if (await maybeRecoveryFile(file)) await remember(file, undefined, true);
    }
    for (const stage of ["consumer-revalidation", "consumer-revalidation-check"]) for (const dir of consumerStageBudgetDirectories(directory, stage)) {
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
  const catalog = consumerDependencyCatalog([...current.payloads].filter(([key]) => !key.startsWith("source-segment:")).map(([key, payload]) => ({
    kind: key.slice(0, key.indexOf(":")), id: key.slice(key.indexOf(":") + 1), revisionHash: contentHash(payload), payload,
    current: current.activeRevisions.get(key) === contentHash(payload),
  })), { sourceId, sourceHash: prepared.intent.sourceHash }, prepared.inventory, prepared.review.priorRoster);
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
    ...(!retained || retained.executionPolicy ? { executionPolicy: "consumer-work/v1" as const } : {}),
    ...(!retained || retained.reviewContract ? { reviewContract: deriveConsumerReviewContract({ sourceId, ref, current: { payload, revisionHash: contentHash(payload) }, catalog }) } : {}),
    requirementPrefix: retained?.requirementPrefix ?? { length: history.length, head: history.at(-1)!.hash } });
  if ((retained && contentHash(retained) !== contentHash(scope)) || history[scope.requirementPrefix.length - 1]?.hash !== scope.requirementPrefix.head)
    throw prerequisiteStop("Frozen consumer revalidation dependencies changed; preserve both versions, no repinning or redispatch");
  return { scope, original, prepared, consumer, current: { payload, revisionHash: contentHash(payload) }, catalog, receipt, acceptance, previous, directory,
    correctionPredecessor: [] as ConsumerRevalidationRecord[] };
}

export async function prepareConsumerRevalidation(root: string, sourceId: string, taskId: string, ref: string, authorizationRef: string, compilerCorrection?: string) {
  if (!compilerCorrection) return prepareOriginalConsumerRevalidation(root, sourceId, taskId, ref, authorizationRef);
  if (compilerCorrection === CONSUMER_REVIEW_CORRECTION || compilerCorrection === CONSUMER_EVIDENCE_COVERAGE)
    return prepareConsumerReviewCorrection(root, sourceId, taskId, ref, authorizationRef, compilerCorrection);
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
  for (const d of p.consumer.dependencies ?? []) {
    const dependency = d as { kind?: string; id?: string }, c = findConsumerArtifact(p.catalog, `${dependency.kind}/${dependency.id}`);
    if (c) dependencyKeys.add(`${c.kind}:${c.id}`);
  }
  const reviewSourceIds = new Set<string>();
  for (const owner of p.scope.reviewContract?.ownerRefs ?? []) {
    const artifact = findConsumerArtifact(p.catalog, owner.ref);
    if (!artifact?.current || artifact.revisionHash !== owner.revisionHash) throw prerequisiteStop("Entry review owner changed; inspect the same source/task/ref owning event and execution, no repinning or unchanged retry");
    dependencyKeys.add(owner.ref);
    for (const { span } of (artifact.payload as { evidence?: Array<{ span: { sourceId: string; startByte: number; endByte: number } }> }).evidence ?? []) {
      const segments = p.prepared.manifest.segments.filter(s => s.startByte < span.endByte && span.startByte < s.endByte);
      if (span.sourceId !== p.scope.sourceId || !segments.length)
        throw prerequisiteStop("Entry owner evidence is outside the original source manifest; inspect the exact owning event evidence, no guessed source or retry");
      segments.forEach(s => reviewSourceIds.add(s.id));
    }
  }
  return { scope: consumerRevalidationModelScope(p.scope), scopeHash: contentHash(p.scope), definition: p.original[0]!.output, definitionCheck: p.original[1]!.output,
    originalQuestions: p.prepared.review.scope.questions, originalSemanticScope: p.prepared.semantic[0]!.output,
    originalConsumer: p.consumer, currentConsumer: p.current, acceptedDependency: p.acceptance.output,
    artifactReadRefs: p.catalog.filter(c => dependencyKeys.has(`${c.kind}:${c.id}`)).map(consumerArtifactReadHint),
    ...(p.scope.compilerCorrection ? { compilerCorrection: p.scope.compilerCorrection.policy === CONSUMER_EVIDENCE_COVERAGE
      ? consumerEvidenceCorrectionContract : p.scope.compilerCorrection.policy === CONSUMER_REVIEW_CORRECTION
        ? consumerReviewCorrectionContract : sourceLocalConsumerContract, previousCompilerJudgments: p.correctionPredecessor.map(r => r.output) } : {}),
    ...(p.scope.reviewContract ? { reviewContract: p.scope.reviewContract, reviewContractHash: contentHash(p.scope.reviewContract) } : {}),
    requiredSourceSegmentIds: [...new Set([...p.prepared.intent.requiredSourceSegmentIds, ...reviewSourceIds,
      ...(check && previous[0]!.output.phase === "consumer-revalidation" ? [...previous[0]!.output.initialWorldRepair?.segmentIds ?? [], ...previous[0]!.output.entityRepair?.segmentIds ?? []] : [])])],
    ...(check ? { proposal: previous[0]!.output, proposalHash: contentHash(previous[0]!.output) } : {}),
    denominator: { total: p.prepared.inventory.consumers.length, refs: p.prepared.inventory.consumers.map(c => c.ref),
      candidateIds: p.prepared.inventory.candidateIds, sourcePages: p.prepared.inventory.sourcePages,
      originalQuestionIds: p.prepared.inventory.originalQuestionIds },
  };
}

/** Explicit correction of a demonstrated host scope ambiguity. This retains the
 * negative pair and uses only its remaining stage allowance, once per consumer. */
async function prepareConsumerReviewCorrection(root: string, sourceId: string, taskId: string, ref: string, authorizationRef: string,
  policy: typeof CONSUMER_REVIEW_CORRECTION | typeof CONSUMER_EVIDENCE_COVERAGE) {
  const history = await new RequirementLedger(root, sourceId).history(), all = revalidationRecords(history, taskId);
  const predecessor = all.findLast(r => r.scope.ref === ref && !r.scope.compilerCorrection);
  if (!predecessor || !authorizationRef.trim() || authorizationRef === predecessor.scope.authorizationRef)
    throw consumerEvidenceStop("Compiler correction needs later authorization and the original independently blocked consumer");
  const p = await prepareOriginalConsumerRevalidation(root, sourceId, taskId, ref, predecessor.scope.authorizationRef);
  if (!p.scope.executionPolicy || p.previous.length !== 2 || policy === CONSUMER_REVIEW_CORRECTION && (p.scope.reviewContract || !ref.startsWith("entry/")))
    throw prerequisiteStop("Only a completed legacy entry review can receive this scope correction; preserve its original stage, no repeated correction or retry");
  for (const record of p.previous) await verifyConsumerRevalidationRecord(root, record);
  const gap = policy === CONSUMER_EVIDENCE_COVERAGE ? await inspectConsumerEvidenceGap(root, p.scope, p.previous) : undefined;
  if (policy === CONSUMER_EVIDENCE_COVERAGE && !gap) throw consumerEvidenceStop("Both original reviews must have verifiable omitted source reads; complete evidence or a semantic disagreement cannot receive this correction");
  if (gap) for (const stage of gap.stages) {
    const { plan, reads } = await readConsumerWorkRecordEvidence(root, p.previous.find(record => record.output.phase === stage.stage)!);
    if (contentHash(plan.baseInput.currentConsumer) !== contentHash(p.current))
      throw consumerEvidenceStop("Evidence correction changed the original consumer revision");
    for (const artifact of plan.artifacts) {
      const current = findConsumerArtifact(p.catalog, `${artifact.kind}:${artifact.id}`);
      if (!current || current.revisionHash !== artifact.revisionHash || current.current !== artifact.current || current.evidenceRole !== artifact.evidenceRole)
        throw consumerEvidenceStop("Evidence correction changed an original dependency revision");
    }
    for (const artifact of reads.artifacts.subjects.values()) {
      if (findConsumerArtifact(p.catalog, artifact.ref)?.revisionHash !== artifact.revisionHash)
        throw consumerEvidenceStop("Evidence correction changed an originally read dependency revision");
    }
  }
  const correction = { policy, predecessorId: consumerRevalidationId(p.scope), predecessorScopeHash: contentHash(p.scope),
    predecessorRecordHashes: p.previous.map(contentHash) as [string, string],
    contractHash: await (policy === CONSUMER_EVIDENCE_COVERAGE ? consumerEvidenceCorrectionHash() : consumerReviewCorrectionHash()),
    ...(gap ? { evidenceGapHash: contentHash(gap) } : {}) };
  const directory = consumerRevalidationDirectory(root, { ...p.scope, compilerCorrection: correction });
  const retained = await maybeRecoveryFile(path.join(directory, "scope.json")) as ConsumerRevalidationScope | null;
  const priorUsage = { ...p.scope.priorUsage }, priorBudgetFiles = [...p.scope.priorBudgetFiles];
  for (const stage of ["consumer-revalidation", "consumer-revalidation-check"]) {
    const old = path.join(consumerWorkDirectory(p.directory), `${stage}.input.json`), input = await read(old);
    if (policy === CONSUMER_REVIEW_CORRECTION && (input.reviewContract || input.capability?.kind !== "initial-world" || input.scope.ref !== ref))
      throw prerequisiteStop("Retained entry review does not demonstrate the legacy opening-scope ambiguity; no semantic retry or correction grant");
    for (const d of consumerStageBudgetDirectories(p.directory, stage)) {
      const file = path.join(d, `${stage}.budget.json`), budget = await maybeRecoveryFile(file);
      if (!budget) continue;
      priorUsage.modelCalls += budget.state.usage.modelCalls; priorUsage.totalPayloadBytes += budget.state.usage.totalPayloadBytes;
      if (!priorBudgetFiles.some(f => f.path === file)) priorBudgetFiles.push({ path: file, hash: contentHash(budget) });
    }
  }
  const scope = consumerRevalidationScopeSchema.parse({ ...p.scope, authorizationRef, compilerCorrection: correction, priorUsage, priorBudgetFiles,
    ...(policy === CONSUMER_REVIEW_CORRECTION ? { reviewContract: deriveConsumerReviewContract({ sourceId, ref, current: p.current, catalog: p.catalog }) } : {}),
    requirementPrefix: retained?.requirementPrefix ?? { length: history.length, head: history.at(-1)!.hash } });
  validateConsumerCorrectionLineage(scope, all);
  if (retained && contentHash(retained) !== contentHash(scope)) throw prerequisiteStop("Frozen review-scope correction changed; preserve the original authorization, source and dependencies, no repinning or retry");
  for (const stage of ["consumer-revalidation", "consumer-revalidation-check"]) await consumerRevalidationLimits(root, scope, stage);
  return { ...p, scope, directory, previous: all.filter(r => consumerRevalidationId(r.scope) === consumerRevalidationId(scope)), correctionPredecessor: p.previous };
}

/** Verify actual Pi submission/read receipts before ledger registration. */
export async function verifyConsumerRevalidationRecord(root: string, record: ConsumerRevalidationRecord) {
  const s = record.scope, ledger = new RequirementLedger(root, s.sourceId), original = await ledger.identityRequirements(s.taskId);
  const all = revalidationRecords(await ledger.history(), s.taskId);
  validateConsumerCorrectionLineage(s, all);
  if (s.compilerCorrection?.policy === CONSUMER_EVIDENCE_COVERAGE) {
    const previous = all.filter(r => consumerRevalidationId(r.scope) === s.compilerCorrection!.predecessorId);
    const gap = await inspectConsumerEvidenceGap(root, previous[0]!.scope, previous);
    if (!gap || contentHash(gap) !== s.compilerCorrection.evidenceGapHash)
      throw consumerEvidenceStop("Evidence correction lost its exact original omitted-read proof");
  }
  // Historical evidence is bound to its actual scope, transcript, contract and
  // original budget below. Current implementation bytes gate NEW dispatch in
  // the workflow, not verification of a sealed completed judgment. Otherwise
  // even a later regression-test edit makes every downstream receipt unreadable.
  const prior = record.output.phase === "consumer-revalidation" ? [] : revalidationRecords(await ledger.history(), s.taskId).filter(r => consumerRevalidationId(r.scope) === consumerRevalidationId(s) && r.output.phase === "consumer-revalidation");
  validateConsumerRevalidationHistory([...prior, record], original);
  const baseDirectory = consumerRevalidationDirectory(root, s), stage = record.output.phase;
  let work: Awaited<ReturnType<typeof prepareConsumerWorkExecution>> | undefined;
  if (record.executionPlanHash) {
    const historical = all.some(accepted => contentHash(accepted) === contentHash(record));
    work = record.providerResumptionHash
      ? historical ? await verifyRecordedWorkProviderResumption(root, record)
        : await prepareWorkProviderResumption(root, s, await prepareConsumerWorkRecord(root, s, prior, stage))
      : record.bindingRecoveryHash
      ? historical ? await verifyRecordedBindingRecovery(root, record, prior[0]!)
        : await prepareConsumerBindingRecovery(root, s, await prepareConsumerWorkRecord(root, s, prior, stage), prior[0]!)
      : historical ? await verifyRecordedConsumerWork(root, record) : await prepareConsumerWorkRecord(root, s, prior, stage);
    if (contentHash(work.plan) !== record.executionPlanHash || work.directory !== consumerWorkRecordDirectory(root, record))
      throw prerequisiteStop("Work record lost its frozen execution plan; no registration or retry");
  }
  const hostRecovery = record.hostRecoveryHash ? await inspectConsumerHostRecovery(root, s, revalidationContract, undefined, record.hostRecoveryHash) : undefined;
  const continuation = record.continuationHash ? await verifyConsumerStageRecovery(root, s, stage, record.continuationHash, revalidationContract, record.budgetAmendmentHash, hostRecovery) : null;
  const failedDirectory = hostRecovery && stage === "consumer-revalidation" ? consumerHostRecoveryDirectory(baseDirectory) : baseDirectory;
  const directory = work ? work.directory : continuation ? consumerStageRecoveryDirectory(failedDirectory, stage) : failedDirectory;
  const amendment = continuation ? await inspectConsumerBudgetAmendment(directory, continuation) : undefined;
  const proof = record.refRecoveryHash ? await verifyConsumerRefRecovery(root, s, directory, revalidationContract, record.refRecoveryHash)
    : await verifyIdentityUpstreamSession(root, directory, stage, { ...record, planHash: contentHash(s) }, work ? consumerWorkContract : revalidationContract);
  const input = await read(path.join(directory, `${stage}.input.json`)), budget = await read(path.join(directory, `${stage}.budget.json`));
  if (work) {
    const invocation = await read(path.join(directory, `${stage}.invocation.json`));
    if (contentHash(input) !== contentHash(consumerWorkInput(work.plan)) || budget.executionPlanHash !== record.executionPlanHash
      || contentHash(budget.policy) !== contentHash(workBudgetPolicy(work.plan)) || invocation.executionPlanHash !== record.executionPlanHash
      || work.plan.bindingRecoveryHash !== record.bindingRecoveryHash || budget.bindingRecoveryHash !== record.bindingRecoveryHash || invocation.bindingRecoveryHash !== record.bindingRecoveryHash
      || work.plan.providerResumptionHash !== record.providerResumptionHash || budget.providerResumptionHash !== record.providerResumptionHash || invocation.providerResumptionHash !== record.providerResumptionHash
      || invocation.scopeHash !== contentHash(s) || invocation.stage !== stage)
      throw prerequisiteStop("Consumer work input, policy or invocation changed; preserve the original execution plan, no registration or retry");
    const messages = (await fs.readFile(path.join(directory, `${stage}.messages.jsonl`), "utf8")).trimEnd().split("\n").map(line => JSON.parse(line).message);
    if (work.plan.reviewBinding) assertBoundPreviewAllowance(messages, s, input.proposalHash, Boolean(record.bindingRecoveryHash));
    verifyConsumerWorkProgress(work.plan, budget.state, messages);
    if (work.plan.providerResumption?.draft !== undefined && contentHash(record.output) !== contentHash(work.plan.providerResumption.draft))
      throw workProviderStop("Recorded continuation changed the original validated draft");
    const lastPreview = messages.findLast(m => m.role === "toolResult" && !m.isError && m.toolName === "preview_consumer_revalidation");
    const preview = lastPreview?.content.find((c: { type: string }) => c.type === "text");
    if (!preview || JSON.parse(preview.text).draftHash !== contentHash(record.output)
      || contentHash(await read(path.join(directory, `${stage}.draft-${contentHash(record.output)}.json`)))
        !== contentHash({ workKey: work.plan.workKey, output: record.output, evidence: record.evidence }))
      throw prerequisiteStop("Consumer submission has no exact validated retained draft; no registration or retry");
  }
  if (continuation) {
    assertConsumerRecoveryInput(await read(path.join(failedDirectory, `${stage}.input.json`)), input);
    const invocation = await read(path.join(directory, `${stage}.invocation.json`));
    if (invocation.scopeHash !== contentHash(s) || invocation.stage !== stage || invocation.continuationHash !== record.continuationHash
      || invocation.budgetAmendmentHash !== record.budgetAmendmentHash)
      throw prerequisiteStop("Continuation invocation is detached from its frozen original failure; no replay");
  }
  const limits = work ? work.plan.limits : continuation ? consumerRecoveryLimits(continuation, amendment)
    : hostRecovery ? (stage === "consumer-revalidation" ? hostRecovery.proposalLimits : hostRecovery.checkLimits) : await consumerRevalidationLimits(root, s, stage);
  if (hostRecovery) {
    const invocation = await read(path.join(directory, `${stage}.invocation.json`));
    if (invocation.scopeHash !== contentHash(s) || invocation.stage !== stage || invocation.hostRecoveryHash !== record.hostRecoveryHash
      || contentHash(input.hostRecovery) !== contentHash(consumerHostRecoveryInput(hostRecovery)))
      throw prerequisiteStop("Consumer host recovery detached its input or invocation; no registration or retry");
    if (stage === "consumer-revalidation") assertConsumerRecoveryInput(await read(path.join(baseDirectory, `${stage}.input.json`)), input);
  }
  const traces = new TraceStore(root), run = await traces.peekRun(record.traceRunId), events = await traces.peekEvents(record.traceRunId);
  if (run.status !== (record.refRecoveryHash || "transportRecoveryHash" in proof && proof.transportRecoveryHash ? "failed" : "succeeded") || run.sourceId !== s.sourceId || contentHash(input) !== record.inputHash
    || proof.sessionId !== record.sessionId || proof.traceRunId !== record.traceRunId
    || contentHash(proof.output) !== contentHash(record.output) || contentHash(input.scope) !== contentHash(consumerRevalidationModelScope(s))
    || contentHash(budget.limits) !== contentHash(limits) || budget.originalBudgetHash !== s.originalBudgetHash
    || budget.budgetAmendmentHash !== record.budgetAmendmentHash || budget.hostRecoveryHash !== record.hostRecoveryHash)
    throw prerequisiteStop("Consumer revalidation is detached from its actual source, session or budget; stop without replay");
  if (continuation && (contentHash(input.continuation) !== contentHash(consumerRecoveryInput(continuation, amendment))
    || record.sessionId === continuation.originalSessionId || record.traceRunId === continuation.originalTraceRunId
    || run.operationId !== `receipt-bound-${contentHash(s)}-${stage}${hostRecovery ? "-host-recovery" : ""}-continuation`))
    throw prerequisiteStop("Consumer continuation lost its exact failure lineage or fresh evidence session; no retry");
  if (hostRecovery && run.operationId !== `receipt-bound-${contentHash(s)}-${stage}-host-recovery${continuation ? "-continuation" : ""}`)
    throw prerequisiteStop("Consumer host recovery lost its exact operation; no registration or retry");
  if (work && run.operationId !== `receipt-bound-${contentHash(s)}-${stage}-work-v1${record.bindingRecoveryHash ? "-binding-recovery" : ""}${record.providerResumptionHash ? "-provider-resumption" : ""}`)
    throw prerequisiteStop("Consumer work lost its exact trace operation; no registration or retry");
  const raw = await read(path.join(identityRequirementDirectory(root, s.sourceId, s.taskId), "context.json"));
  const canonicalRef = (ref: string) => {
    const consumer = raw.inventory.consumers.find((c: { ref: string }) => c.ref === ref || c.ref.replace("/", ":") === ref);
    return consumer && consumerArtifactKey(consumer.ref, consumer.payload, s.sourceId) || ref.replace("/", ":");
  };
  const reads = createConsumerEvidenceReads(), sourceIds = reads.sourceIds, refs = reads.consumerRefs, artifactReads = reads.artifacts;
  if (work) {
    work.plan.sources.forEach(s => sourceIds.add(s.id)); refs.add(s.ref);
    work.plan.artifacts.forEach(a => refs.add(`${a.kind}:${a.id}`));
  }
  for (const event of events.filter(e => e.type === "tool.call.completed" && e.data?.toolName === "read_consumer_revalidation")) {
    const call = events.find(e => e.type === "tool.call.started" && e.toolCallId === event.toolCallId);
    if (!call?.blobRef) throw prerequisiteStop("Consumer revalidation lost its complete read receipt");
    const request = await traces.peekBlob(call.blobRef) as ConsumerReadRequest;
    const result = event.blobRef ? await traces.peekBlob(event.blobRef) as { content?: { type: string; text?: string }[] } : undefined;
    const text = result?.content?.find(c => c.type === "text")?.text;
    if (!text) throw prerequisiteStop("Consumer read lost its complete result receipt; no registration or retry");
    acceptConsumerEvidenceRead(reads, request, JSON.parse(text), canonicalRef);
  }
  artifactReads.completed.forEach(ref => refs.add(ref));
  if (work?.plan.providerResumption && (work.plan.providerResumption.requiredSourceSegmentIds.some(id => !sourceIds.has(id))
    || work.plan.providerResumption.requiredArtifactRefs.some(ref => !refs.has(ref))))
    throw workProviderStop("Continuation omitted its original additional evidence reads");
  for (const required of work?.plan.providerResumption?.requiredArtifactRevisions ?? []) {
    const actual = artifactReads.subjects.get(required.ref) ?? work!.plan.artifacts.find(a => `${a.kind}:${a.id}` === required.ref);
    if (actual?.revisionHash !== required.revisionHash) throw workProviderStop("Continuation changed an original additional dependency revision");
  }
  if (work?.plan.evidenceCoverage) {
    assertConsumerEvidenceRead(work.plan.evidenceCoverage, sourceIds);
    if (artifactReads.subjects.size) {
      const source = await (await WorkspaceStore.create(root)).getSource(s.sourceId);
      if (!source || source.contentSha256 !== s.sourceHash) throw consumerEvidenceStop("Source for additional consumer reads changed");
      assertConsumerEvidenceRead(consumerEvidenceCoverage(s.sourceId, await readSourceMaterial(root, source), raw.manifest.segments,
        additionalConsumerEvidenceSubjects(artifactReads)), sourceIds);
    }
  }
  if (input.requiredSourceSegmentIds.some((id: string) => !sourceIds.has(id)) || !refs.has(s.ref)) throw prerequisiteStop("Consumer revalidation omitted required full source or consumer reads");
  if (continuation?.pendingArtifactRefs.some(ref => !refs.has(canonicalRef(ref)))) throw prerequisiteStop("Consumer continuation omitted its original unfinished artifact reads; no registration or retry");
  if (hostRecovery && (hostRecovery.requiredSourceSegmentIds.some(id => !sourceIds.has(id))
    || hostRecovery.requiredArtifactRefs.some(ref => !refs.has(canonicalRef(ref)))))
    throw prerequisiteStop("Consumer host recovery omitted its retained source/dependency reads; no registration or retry");
  if (contentHash(raw.intent) !== s.identityIntentHash || contentHash(raw.inventory) !== s.inventoryHash
    || contentHash(record.evidence.map(e => e.selector)) !== contentHash(record.output.evidence)) throw prerequisiteStop("Consumer revalidation changed its original inventory or evidence");
  const criteria = work ? work.plan.baseInput : input;
  if (s.reviewContract && (contentHash(criteria.reviewContract) !== contentHash(s.reviewContract) || criteria.reviewContractHash !== contentHash(s.reviewContract)
    || contentHash(criteria.capability) !== contentHash(consumerReviewCapability(s))))
    throw prerequisiteStop("Consumer review lost its frozen target cut or read-only capability; preserve the original scope, no registration or retry");
  if (contentHash(criteria.definition) !== contentHash(original[0]!.output) || contentHash(criteria.definitionCheck) !== contentHash(original[1]!.output)
    || contentHash(input.originalQuestions) !== contentHash(raw.review.scope.questions)
    || contentHash(input.originalSemanticScope) !== contentHash(raw.semantic[0].output)
    || contentHash(criteria.denominator) !== contentHash({ total: raw.inventory.consumers.length, refs: raw.inventory.consumers.map((c: { ref: string }) => c.ref),
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
  if (hostRecovery && stage === "consumer-revalidation") Object.assign(inherited, hostRecovery.priorUsage);
  if (continuation) {
    const failedBudget = await read(path.join(failedDirectory, `${stage}.budget.json`));
    inherited.modelCalls += failedBudget.state.usage.modelCalls; inherited.totalPayloadBytes += failedBudget.state.usage.totalPayloadBytes;
    if (contentHash(inherited) !== contentHash(continuation.priorUsage)) throw prerequisiteStop("Continuation changed its inherited original usage");
  }
  if (work) Object.assign(inherited, work.plan.priorUsage);
  const usage = budget.state.usage;
  if (s.compilerCorrection && (contentHash(input.compilerCorrection) !== contentHash(s.compilerCorrection.policy === CONSUMER_EVIDENCE_COVERAGE
    ? consumerEvidenceCorrectionContract : s.compilerCorrection.policy === CONSUMER_REVIEW_CORRECTION ? consumerReviewCorrectionContract : sourceLocalConsumerContract)
    || contentHash(input.previousCompilerJudgments) !== contentHash(all.filter(r => consumerRevalidationId(r.scope) === s.compilerCorrection!.predecessorId).map(r => r.output))))
    throw prerequisiteStop("Compiler correction omitted its original negative judgments or changed its typed capability contract");
  if (contentHash(budget.priorUsage) !== contentHash(inherited) || usage.modelCalls < 1 || (!work || work.plan.budgetPolicy) && usage.modelCalls > limits.maxModelCalls
    || (!work || work.plan.budgetPolicy) && usage.totalPayloadBytes > limits.maxTotalPayloadBytes || usage.largestRequestBytes > limits.maxRequestBytes
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
