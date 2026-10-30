import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash as h } from "../world/canonical.js";
import { TraceStore } from "../trace/store.js";
import { UpstreamRepairLedger, upstreamRepairFinishGraphHash } from "./upstream-repair-ledger.js";
import type { UpstreamRepairPlan } from "./upstream-repair-plan.js";
import { inspectUpstreamRepairFinishRevisionAuthority } from "./upstream-repair-finish-revision.js";
import { createCompilerProposalToolset } from "./proposal-tools.js";
import { verifyUpstreamRepairPlan } from "./upstream-repair-preflight.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { verifyIdentityUpstreamSession } from "./identity-upstream-session.js";
import type { IdentitySessionContract } from "./identity-session-integrity.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { SegmentStore } from "./segments.js";
import { diagnoseEntryRepair } from "./entry-repair-diagnostics.js";
import { initialWorldSchema } from "../world/initial.js";
import { entitySchema } from "../world/model.js";
import { actionSchemaSchema } from "../world/action-ontology.js";
import { processTemplateSchema } from "../world/process-ontology.js";
import { acquisitionSchema } from "../world/acquisition.js";
import { ENTRY_CONTRACT_RECOVERY_STAGE, readIdentityEntryContractRecovery, assertIdentityEntryContractRecovery,
  inspectEntryContractRecoveryCandidate } from "./identity-finish-contract-recovery.js";

function openingRepairDiagnostics(intent: IdentityFinishRevisionIntent, writableFields: string[], dependencies: { ref: string; payload: unknown }[], consumed: boolean) {
  const target = intent.authority.slots.find(slot => slot.artifactKind === "initial-world");
  if (!target) return null;
  const entry = initialWorldSchema.omit({ evidence: true }).parse((target.toolInput as { payload: unknown }).payload);
  const entities = new Map(dependencies.filter(d => d.ref.startsWith("entity:")).map(d => {
    const entity = entitySchema.parse(d.payload); return [entity.id, entity] as const;
  }));
  for (const slot of intent.authority.slots.filter(slot => slot.artifactKind === "entity")) {
    const raw = (slot.toolInput as { payload: object }).payload;
    const before = entities.get(slot.artifactId);
    if (before) entities.set(slot.artifactId, entitySchema.parse({ ...raw, evidence: before.evidence }));
  }
  const frozen = <T>(kind: string, schema: z.ZodType<T>) => new Map(dependencies.filter(d => d.ref.startsWith(`${kind}:`))
    .map(d => [d.ref.slice(kind.length + 1), schema.parse(d.payload)]));
  return diagnoseEntryRepair({ sourceId: intent.authority.sourceId, entry, catalog: { entities,
    actionSchemas: frozen("action-schema", actionSchemaSchema), processTemplates: frozen("process-template", processTemplateSchema),
    acquisitions: frozen("acquisition", acquisitionSchema) }, writablePointers: writableFields,
    consumed, catalogScope: "frozen-repair-scope" });
}

export const FINISH_REVISION_DRAFT = "finish-revision-singleton";
export const FINISH_REVISION_ACCEPTANCE = "finish-revision-acceptance";
export const FINISH_REVISION_LIMITS = Object.freeze({ maxModelCalls: 4, maxRequestBytes: 512_000, maxTotalPayloadBytes: 2_048_000 });
export const finishRevisionContract: IdentitySessionContract = { terminalTool: "submit_identity_finish_revision",
  readTools: ["read_identity_finish_revision"], receipt: "retained" };
const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const limits = z.object({ maxModelCalls: z.number().int().positive(), maxRequestBytes: z.number().int().positive(), maxTotalPayloadBytes: z.number().int().positive() }).strict();
const authoritySchema = z.object({ version: z.literal(1), sourceId: z.string(), planHash: hash, batchId: z.string(), failedFinishRef: hash,
  failureReason: z.string(), originalIntentHash: hash, originalGraphHash: hash,
  sourceScope: z.object({ sourceId: z.string(), sourceSha256: hash, segmentIds: z.array(z.string()) }).strict(),
  finishInput: z.unknown(), slots: z.array(z.object({ artifactKind: z.string(), artifactId: z.string(), originalAttemptRef: hash,
    originalProposalId: z.string(), originalInputHash: hash, semanticInputHash: hash, toolInput: z.unknown(), dependencies: z.array(z.unknown()) }).strict()),
}).strict();
export const identityFinishRevisionIntentSchema = z.object({ version: z.literal(1), policy: z.literal("identity-opening-finish-revision/v1"),
  taskId: hash, planHash: hash, authorizationRef: z.string().trim().min(1), authority: authoritySchema,
  proposalId: z.string(), acceptanceLimits: limits,
  retainedFiles: z.array(z.object({ path: z.string(), hash }).strict()).min(1),
  ledgerPrefix: z.object({ length: z.number().int().positive(), head: hash }).strict(),
}).strict();
export type IdentityFinishRevisionIntent = z.infer<typeof identityFinishRevisionIntentSchema>;
export async function readIdentityFinishRevision(directory: string) {
  try { return identityFinishRevisionIntentSchema.parse(await read(path.join(directory, "finish-revision.intent.json"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** Read-only recovery discovery. A retained invocation/failure is not a fresh
 * grant, and a recorded seal still needs its original proof verification. */
export async function inspectIdentityFinishRevisionProgress(directory: string) {
  const intent = await readIdentityFinishRevision(directory);
  if (!intent) return null;
  const maybe = async (file: string) => {
    try { return await read(path.join(directory, file)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  const recovery = await readIdentityEntryContractRecovery(directory);
  const { readAcceptanceEvidenceRecovery, EVIDENCE_ACCEPTANCE_STAGE } = await import("./identity-acceptance-evidence-recovery.js");
  const evidenceRecovery = await readAcceptanceEvidenceRecovery(directory);
  const stages = await Promise.all([FINISH_REVISION_DRAFT, ...(recovery ? [ENTRY_CONTRACT_RECOVERY_STAGE] : []), FINISH_REVISION_ACCEPTANCE,
    ...(evidenceRecovery ? [EVIDENCE_ACCEPTANCE_STAGE] : [])].map(async stage => {
    const [invocation, failure, checkpoint, budget, record] = await Promise.all([
      maybe(`${stage}.invocation.json`), maybe(`${stage}.failure.json`), maybe(`${stage}.session-checkpoint.json`), maybe(`${stage}.budget.json`),
      maybe(`${stage}.record.json`),
    ]);
    const rejected = record?.output?.judgments?.filter((j: { verdict: string }) => j.verdict === "blocked");
    return { stage, status: failure || rejected?.length ? "stopped" as const : checkpoint ? "sealed" as const : invocation ? "unsettled" as const : "not-started" as const,
      diagnostic: failure?.error ?? (rejected?.length ? `Independent acceptance blocked: ${rejected.map((j: { requirementId: string }) => j.requirementId).join(", ")}` : null), usage: budget?.state?.usage ?? null, cumulative: budget?.cumulative ?? null,
      modelResponseFile: invocation ? path.join(directory, `${stage}.messages.jsonl`) : null };
  }));
  const activeStages = (recovery ? stages.slice(1) : stages).filter(s => !evidenceRecovery || s.stage !== FINISH_REVISION_ACCEPTANCE);
  const blocked = activeStages.some(s => s.status === "stopped" || s.status === "unsettled");
  const context = await maybe(`${recovery ? ENTRY_CONTRACT_RECOVERY_STAGE : FINISH_REVISION_DRAFT}.context.json`) ?? await maybe(`${FINISH_REVISION_DRAFT}.context.json`);
  const entryContractReview = context ? openingRepairDiagnostics(intent, context.writableFields, context.dependencies,
    activeStages.some(stage => stage.status !== "not-started")) : null;
  const rejected = await maybe(`${FINISH_REVISION_ACCEPTANCE}.record.json`), rejectedInput = await maybe(`${FINISH_REVISION_ACCEPTANCE}.input.json`);
  return { inspection: "recorded-only" as const, blocked, stages, entryContractReview,
    contractRecovery: recovery ? { intentHash: h(recovery), stage: ENTRY_CONTRACT_RECOVERY_STAGE, limits: recovery.limits, authorizationRef: recovery.authorizationRef } : null,
    contractRecoveryCandidate: recovery ? null : await inspectEntryContractRecoveryCandidate(directory),
    acceptanceEvidenceRecovery: evidenceRecovery ? { intentHash: h(evidenceRecovery), stage: EVIDENCE_ACCEPTANCE_STAGE, limits: evidenceRecovery.limits } : null,
    acceptanceEvidenceRecoveryCandidate: recovery && !evidenceRecovery && rejected?.output?.judgments?.some((j: { verdict: string }) => j.verdict === "blocked") && rejectedInput && rejectedInput.stagedEvidence === undefined
      ? { rejectedInputHash: rejected.inputHash, executionAuthority: false, condition: "Verify omitted existing field evidence on the identical graph under the retained explicit contract-recovery authorization; no proposal change or budget renewal." } : null,
    resumeCondition: blocked
      ? "The original finish revision has a stopped or unsettled invocation. Inspect stages[].diagnostic and copy stages[].modelResponseFile to read the retained assistant explanation; that explanation is not independent acceptance. No model redispatch, renamed grant, budget reset or parent resume. Preserve the current source/scope stop for host review."
      : "Only the original unconsumed stage or sealed host continuation may proceed after its existing verifier; recorded status grants no new authority." };
}

export async function assertIdentityFinishRevisionRetained(root: string, plan: UpstreamRepairPlan, directory: string, intent: IdentityFinishRevisionIntent) {
  const state = await new UpstreamRepairLedger(root, plan.sourceScope.sourceId).inspect();
  const current = state.plans.find(p => p.plan.planHash === plan.planHash), original = current?.originalFinishIntent ?? current?.finishIntent;
  const stopped = state.records.find(r => r.hash === intent.authority.failedFinishRef);
  const attempts = new Map(state.attempts.filter(a => a.started.planHash === plan.planHash).map(a => [a.attemptRef, a]));
  if (intent.planHash !== plan.planHash || intent.taskId !== plan.identityRequirements?.taskId
    || original?.intentHash !== intent.authority.originalIntentHash
    || state.records[intent.ledgerPrefix.length - 1]?.hash !== intent.ledgerPrefix.head
    || stopped?.payload.kind !== "needs-host-review" || stopped.payload.planHash !== plan.planHash
    || stopped.payload.reason !== intent.authority.failureReason || intent.authority.planHash !== plan.planHash
    || intent.authority.sourceId !== plan.sourceScope.sourceId || intent.authority.batchId !== plan.batchId
    || h(intent.authority.sourceScope) !== h(plan.sourceScope) || h(intent.authority.finishInput) !== h(original.input)
    || intent.authority.originalGraphHash !== upstreamRepairFinishGraphHash(plan, original, attempts)
    || intent.authority.slots.length !== original.proposals.length || intent.authority.slots.some(slot => {
      const attempt = attempts.get(slot.originalAttemptRef), proposal = original.proposals.find(p => p.attemptRef === slot.originalAttemptRef);
      return !proposal || proposal.artifactKind !== slot.artifactKind || proposal.artifactId !== slot.artifactId
        || proposal.proposalId !== slot.originalProposalId || attempt?.started.inputHash !== slot.originalInputHash
        || h(attempt.started.toolInput) !== h(slot.toolInput) || h(slot.toolInput) !== slot.originalInputHash;
    }))
    throw prerequisiteStop("Opening finish revision lost its original stopped graph or ledger prefix; preserve history, no retry");
  for (const file of intent.retainedFiles) {
    const location = path.resolve(directory, file.path);
    if (!location.startsWith(directory + path.sep) || await fs.realpath(location) !== location || h(await fs.readFile(location, "utf8")) !== file.hash)
      throw prerequisiteStop("Opening finish revision changed a retained proposal, review, session or budget; no dispatch or retry");
  }
  const { IDENTITY_UPSTREAM_ACCEPTANCE_LIMITS } = await import("./identity-requirement-acceptance.js");
  const prior = await read(path.join(directory, "acceptance.budget.json"));
  const remaining = { ...IDENTITY_UPSTREAM_ACCEPTANCE_LIMITS,
    maxModelCalls: IDENTITY_UPSTREAM_ACCEPTANCE_LIMITS.maxModelCalls - prior.state.usage.modelCalls,
    maxTotalPayloadBytes: IDENTITY_UPSTREAM_ACCEPTANCE_LIMITS.maxTotalPayloadBytes - prior.state.usage.totalPayloadBytes };
  if (h(intent.acceptanceLimits) !== h(remaining) || remaining.maxModelCalls <= 0 || remaining.maxTotalPayloadBytes <= 0)
    throw prerequisiteStop("Opening revision has no unchanged remaining independent acceptance allowance; no reset or dispatch");
  return state;
}

/** One explicit semantic correction of the stopped singleton. Other slots are
 * read-only, and the original independent acceptance allowance is not renewed. */
export async function prepareIdentityFinishRevision(root: string, plan: UpstreamRepairPlan, directory: string,
  request: { failedFinishRef: string; authorizationRef: string }) {
  const existing = await readIdentityFinishRevision(directory);
  if (existing) {
    if (existing.authority.failedFinishRef !== request.failedFinishRef || existing.authorizationRef !== request.authorizationRef)
      throw prerequisiteStop("The opening finish revision is already bound; copy typedRepairs[].currentStop.recordRef from inspect-identity-repairs in this source/task once, no renamed grant or retry");
    await assertIdentityFinishRevisionRetained(root, plan, directory, existing); return existing;
  }
  const authority = await inspectUpstreamRepairFinishRevisionAuthority(root, plan.sourceScope.sourceId, plan.planHash);
  const target = authority.slots.find(s => s.artifactKind === "initial-world" && s.artifactId === "singleton");
  const writable = new Set([...plan.allowedWrites, ...plan.allowedCreations].map(s => `${s.kind}:${s.id}`));
  if (!plan.identityRequirements?.consumerRevalidation || authority.failedFinishRef !== request.failedFinishRef || !target
    || plan.dependencyEdges.some(e => e.to === "initial-world:singleton" && writable.has(e.from)) || !request.authorizationRef.trim())
    throw prerequisiteStop("Opening finish revision requires the exact stopped singleton and no writable descendants. Inspect same-source/task typedRepairs[].currentStop.recordRef and correct an ID once; unsupported scope requires host review, no retry");
  const { verifyIdentityUpstreamAcceptance, IDENTITY_UPSTREAM_ACCEPTANCE_LIMITS } = await import("./identity-requirement-acceptance.js");
  await verifyIdentityUpstreamAcceptance(root, plan, true);
  const budget = await read(path.join(directory, "acceptance.budget.json"));
  const acceptanceLimits = { ...IDENTITY_UPSTREAM_ACCEPTANCE_LIMITS,
    maxModelCalls: IDENTITY_UPSTREAM_ACCEPTANCE_LIMITS.maxModelCalls - budget.state.usage.modelCalls,
    maxTotalPayloadBytes: IDENTITY_UPSTREAM_ACCEPTANCE_LIMITS.maxTotalPayloadBytes - budget.state.usage.totalPayloadBytes };
  const files = (await fs.readdir(directory, { recursive: true, withFileTypes: true })).filter(e => e.isFile())
    .map(e => path.relative(directory, path.join(e.parentPath, e.name)))
    .filter(f => f !== "state.json" && !f.startsWith("history/")).sort();
  const state = await new UpstreamRepairLedger(root, plan.sourceScope.sourceId).inspect();
  const intent = identityFinishRevisionIntentSchema.parse({ version: 1, policy: "identity-opening-finish-revision/v1",
    taskId: plan.identityRequirements.taskId, planHash: plan.planHash, authorizationRef: request.authorizationRef, authority,
    proposalId: `upstream-fr-${h({ plan: plan.planHash, failedFinishRef: authority.failedFinishRef }).slice(0, 40)}`, acceptanceLimits,
    retainedFiles: await Promise.all(files.map(async file => ({ path: file, hash: h(await fs.readFile(path.join(directory, file), "utf8")) }))),
    ledgerPrefix: { length: state.records.length, head: state.records.at(-1)!.hash } });
  await assertIdentityFinishRevisionRetained(root, plan, directory, intent);
  return intent;
}

export async function identityFinishRevisionContext(root: string, plan: UpstreamRepairPlan, intent: IdentityFinishRevisionIntent) {
  const verified = await verifyUpstreamRepairPlan(root, plan);
  const tool = createCompilerProposalToolset(root).tools.find(t => t.name === "propose_initial_world")!;
  const writableFields = plan.allowedWrites.find(w => w.kind === "initial-world" && w.id === "singleton")!.pointers;
  const dependencies = plan.readableRefs.filter(r => r.kind !== "source-segment")
    .map(r => ({ ref: `${r.kind}:${r.id}`, payload: verified.payloads.get(`${r.kind}:${r.id}`) }));
  return { intent, originalToolSchema: tool.parameters, originalToolGuidelines: tool.promptGuidelines ?? [],
    writableFields, dependencies, entryContractReview: openingRepairDiagnostics(intent, writableFields, dependencies, false),
    source: plan.sourceScope.segmentIds.map(segmentId => {
      const segment = verified.payloads.get(`source-segment:${segmentId}`) as { startByte: number; endByte: number };
      return { segmentId, text: verified.bytes.subarray(segment.startByte, segment.endByte).toString("utf8"), complete: true };
    }) };
}

/** The model owns semantic content. Host only checks original identity/scope;
 * normal evidence and commit validators still process the replacement. */
export function validateIdentityFinishRevisionDraft(intent: IdentityFinishRevisionIntent, raw: unknown) {
  const proposal = z.object({ proposal_id: z.string(), payload: z.unknown(), evidence_segment_ids: z.array(z.string()).min(1),
    evidence_selectors: z.array(z.unknown()).min(1) }).strict().parse(raw);
  const original = intent.authority.slots.find(s => s.artifactKind === "initial-world" && s.artifactId === "singleton")!;
  const before = original.toolInput as { payload: unknown };
  if (proposal.proposal_id !== intent.proposalId || proposal.evidence_segment_ids.some(id => !intent.authority.sourceScope.segmentIds.includes(id))
    || h(proposal.payload) === h(before.payload))
    throw prerequisiteStop("Opening revision requires a material payload correction under the exact supplied proposal ID and source scope; no unchanged, evidence-only or renamed retry");
  return proposal;
}

export async function verifyIdentityFinishRevisionProof(root: string, plan: UpstreamRepairPlan, directory: string) {
  const intent = await readIdentityFinishRevision(directory);
  if (!intent) throw prerequisiteStop("Missing original opening revision intent; no inferred authority");
  await assertIdentityFinishRevisionRetained(root, plan, directory, intent);
  const recovery = await readIdentityEntryContractRecovery(directory);
  if (recovery) await assertIdentityEntryContractRecovery(root, plan, directory, recovery);
  const stage = recovery ? ENTRY_CONTRACT_RECOVERY_STAGE : FINISH_REVISION_DRAFT;
  const proof = await read(path.join(directory, "finish-revision.proof.json"));
  const input = await read(path.join(directory, `${stage}.input.json`));
  const context = await read(path.join(directory, `${stage}.context.json`));
  const proposal = validateIdentityFinishRevisionDraft(intent, await read(path.join(directory, `${stage}.proposal.json`)));
  if (recovery ? proof.contractRecoveryHash !== h(recovery) || input.contractRecoveryHash !== h(recovery) || h(context) !== recovery.contextHash
    : proof.contractRecoveryHash || input.contractRecoveryHash)
    throw prerequisiteStop("Opening revision lost its exact authorized contract transition; no staging or retry");
  const refs = plan.readableRefs.filter(r => r.kind !== "source-segment").map(r => `${r.kind}:${r.id}`);
  if (h(context.writableFields) !== h(plan.allowedWrites.find(w => w.kind === "initial-world" && w.id === "singleton")?.pointers)
    || h(context.dependencies.map((d: { ref: string }) => d.ref)) !== h(refs)
    || context.dependencies.some((d: { ref: string; payload: unknown }) =>
      h(d.payload) !== plan.baselineRefs.find(r => `${r.kind}:${r.id}` === d.ref)?.revisionHash))
    throw prerequisiteStop("Opening revision changed or expanded its frozen dependency/read scope; no staging or retry");
  const source = await WorkspaceStore.openReadOnly(root).getSource(plan.sourceScope.sourceId);
  if (!source || source.contentSha256 !== plan.sourceScope.sourceSha256) throw prerequisiteStop("Opening revision source changed; no retry");
  const bytes = await readSourceMaterial(root, source), manifest = await new SegmentStore(root).readManifest(source.id);
  const segments = plan.sourceScope.segmentIds.map(segmentId => {
    const segment = manifest?.segments.find(s => s.id === segmentId);
    if (!segment) throw prerequisiteStop("Opening revision source segment missing; inspect same-source status, no guessed segment or retry");
    return { segmentId, text: bytes.subarray(segment.startByte, segment.endByte).toString("utf8"), complete: true };
  });
  if (h(context.source) !== h(segments)) throw prerequisiteStop("Opening revision did not retain the exact original source bytes; no retry");
  const checkpoint = await verifyIdentityUpstreamSession(root, directory, stage, proof, finishRevisionContract);
  if (proof.planHash !== plan.planHash || proof.intentHash !== h(intent) || proof.inputHash !== h(input) || proof.outputHash !== h(proposal)
    || h(input.intent) !== h(intent) || input.contextHash !== h(context) || h(context.intent) !== h(intent)
    || h(JSON.parse(checkpoint.output.proposal_json)) !== h(proposal)) throw prerequisiteStop("Opening revision proof differs from its exact Pi submission; no staging or retry");
  const traces = new TraceStore(root), run = await traces.peekRun(proof.traceRunId), events = await traces.peekEvents(proof.traceRunId);
  const { verifyInvocationBudget } = await import("./identity-requirement-acceptance.js");
  const invocation = await verifyInvocationBudget(root, plan, stage, events, recovery?.limits ?? FINISH_REVISION_LIMITS);
  const submits = events.filter(e => e.type === "tool.call.completed" && e.data?.toolName === finishRevisionContract.terminalTool);
  const call = submits.length === 1 ? events.find(e => e.type === "tool.call.started" && e.toolCallId === submits[0]!.toolCallId) : undefined;
  const reads = events.filter(e => e.type === "tool.call.completed" && e.data?.toolName === finishRevisionContract.readTools[0]);
  const provenance = events.filter(e => e.type === "stage.started" && e.data?.phase === "identity-upstream-slot");
  if (invocation.finishRevisionIntentHash !== h(intent) || (recovery && invocation.contractRecoveryHash !== h(recovery))
    || run.status !== "succeeded" || !run.endedAt || run.sourceId !== plan.sourceScope.sourceId
    || run.counts.retries || run.operationId !== `identity-upstream-${intent.taskId}-${stage}`
    || !call?.blobRef || !reads.length || reads.some(e => e.seq >= call.seq) || h(await traces.peekBlob(call.blobRef)) !== h(checkpoint.output)
    || provenance.length !== 1 || provenance[0]!.data?.sessionId !== proof.sessionId || provenance[0]!.data?.planHash !== plan.planHash
    || provenance[0]!.data?.inputHash !== h(JSON.stringify(input)) || provenance[0]!.data?.subscription !== true
    || events.some(e => e.type.startsWith("world.commit.") || e.type === "llm.response.failed" || e.type === "tool.call.failed"
      || (e.type === "tool.call.started" && ![...finishRevisionContract.readTools, finishRevisionContract.terminalTool].includes(String(e.data?.toolName)))
      || (e.type === "llm.request.started" && (e.data?.providerId !== "openai-codex" || e.data?.modelId !== "gpt-6.1-sol"))))
    throw prerequisiteStop("Opening revision lacks settled read-only Pi evidence; retain failures, no retry");
  for (const event of reads) {
    const result = event.blobRef ? await traces.peekBlob(event.blobRef) as { content?: { type: string; text?: string }[] } : undefined;
    const text = result?.content?.filter(c => c.type === "text").map(c => c.text ?? "").join("");
    if (!text || h(JSON.parse(text)) !== h(context)) throw prerequisiteStop("Opening revision did not read its full frozen source context; no retry");
  }
  const original = await read(path.join(directory, "acceptance.record.json"));
  if (original.sessionId === proof.sessionId || original.traceRunId === proof.traceRunId)
    throw prerequisiteStop("Opening revision reused the original independent reviewer; no acceptance or retry");
  return { intent, proof, proposal };
}

export async function identityAcceptanceStage(root: string, plan: UpstreamRepairPlan, directory: string) {
  const current = (await new UpstreamRepairLedger(root, plan.sourceScope.sourceId).inspect()).plans.find(p => p.plan.planHash === plan.planHash);
  if (!current?.finishRevision) return null;
  const verified = await verifyIdentityFinishRevisionProof(root, plan, directory);
  if (!current.finishRevision.completed || current.finishRevision.intent.auditRef !== `pi-identity-finish-revision:${h(verified.proof)}`)
    throw prerequisiteStop("Revised opening graph lacks its completed exact Pi-backed revision; no finish or unchanged retry");
  const { readAcceptanceEvidenceRecovery, assertAcceptanceEvidenceRecovery, EVIDENCE_ACCEPTANCE_STAGE } = await import("./identity-acceptance-evidence-recovery.js");
  const evidenceRecovery = await readAcceptanceEvidenceRecovery(directory);
  if (evidenceRecovery) await assertAcceptanceEvidenceRecovery(root, plan, directory, evidenceRecovery);
  return { stage: evidenceRecovery ? EVIDENCE_ACCEPTANCE_STAGE : FINISH_REVISION_ACCEPTANCE, limits: evidenceRecovery?.limits ?? verified.intent.acceptanceLimits, evidenceRecovery, ...verified };
}
