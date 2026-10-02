import { contentHash } from "../world/canonical.js";
import { canonicalEventSchema, eventParticipationSchema, evidenceRefSchema, textAnchorSchema } from "../world/model.js";
import { CanonicalModelStore, ProposalStore } from "../world/canonical-model.js";
import { SourceAnnotationStore } from "./annotations.js";
import { EntityResolutionStore } from "./entity-resolution.js";
import { EventResolutionStore } from "./event-resolution.js";
import { createCompilerProposalToolset } from "./proposal-tools.js";
import { UpstreamRepairLedger, type UpstreamStagedDependency } from "./upstream-repair-ledger.js";
import { assertUpstreamRepairMutation, upstreamRepairReferencedKeys, type UpstreamRepairKind } from "./upstream-repair-plan.js";
import { upstreamRepairHostError, verifyUpstreamRepairPlan } from "./upstream-repair-preflight.js";
import { textAnchorForByteRange } from "./text-anchors.js";
import type { SourceSegment } from "./segments.js";
import { CompilerProposalObligations } from "./proposal-obligations.js";

const toolNames: Record<UpstreamRepairKind, string> = {
  "entity-mention": "propose_entity_mention", "event-mention": "propose_event_mention", quotation: "propose_quotation",
  "discourse-segment": "propose_discourse_segment", "entity-resolution": "propose_entity_resolution", "event-resolution": "propose_event_resolution",
  "canonical-event": "propose_canonical_event", "event-participation": "propose_event_participation",
};
function envelopeEvidenceAssertions(envelope: unknown): readonly unknown[] {
  if (!envelope || typeof envelope !== "object") return [];
  const assertions = (envelope as { evidenceAssertions?: unknown }).evidenceAssertions;
  return Array.isArray(assertions) ? assertions : [];
}
async function pending(root: string, sourceId: string, kind: UpstreamRepairKind, proposalId: string) {
  if (kind === "entity-resolution") return new EntityResolutionStore(root).readProposal(sourceId, "pending", proposalId);
  if (kind === "event-resolution") return new EventResolutionStore(root).readProposal(sourceId, "pending", proposalId);
  if (kind === "canonical-event" || kind === "event-participation") return new ProposalStore(root).readEnvelope("pending", proposalId);
  return new SourceAnnotationStore(root).readProposal(sourceId, "pending", proposalId);
}
function derivation(kind: UpstreamRepairKind, batchId: string) {
  return { runId: batchId, compilerBatchId: batchId, worker: toolNames[kind], ontologyVersion: kind === "entity-resolution" ? "entity-resolution-v1" : kind === "event-resolution" ? "event-resolution-v1" : "observation-v1" };
}

/** Cross-record semantic presence guard run before a managed upstream proposal is written. */
export async function assertUpstreamSemanticPresenceProjection(root: string, kind: UpstreamRepairKind, payload: unknown, dependencies: ReadonlyMap<string, unknown> = new Map()): Promise<void> {
  if (kind !== "canonical-event" && kind !== "event-participation") return;
  const canonical = new CanonicalModelStore(root);
  const entities = new Map((await canonical.listEntities()).map(entity => [entity.id, entity]));
  if (kind === "canonical-event") {
    const event = canonicalEventSchema.parse(payload), presence = new Map((event.participantPresence ?? []).map(item => [item.entityId, item.mode]));
    for (const participantId of event.participants) {
      const entity = entities.get(participantId);
      if (!entity) throw upstreamRepairHostError(`Semantic event ${event.id} participant '${participantId}' is not a readable canonical entity; copy readable[].payload.id from read_upstream_repair_context and correct this slot once`);
      if (entity.kind === "character" && !presence.has(participantId)) throw new Error(`Semantic event ${event.id} must explicitly project participantPresence for character '${participantId}'. Use the evidence-supported physical/remote/mentioned/represented/dream/memory mode, preserve all participants, and correct this exact slot once; never add presence to an artifact`);
      if (entity.kind !== "character" && presence.has(participantId)) throw new Error(`Semantic event ${event.id} participantPresence includes non-character '${participantId}' (${entity.kind}). Remove only that presence entry, preserve the participant and role records, and correct this exact slot once`);
    }
    return;
  }
  const participation = eventParticipationSchema.parse(payload), entity = entities.get(participation.entityId);
  if (!entity) throw upstreamRepairHostError(`Event participation ${participation.id} entity '${participation.entityId}' is not a readable canonical entity; copy readable[].payload.id from read_upstream_repair_context and correct this slot once`);
  const eventInput = dependencies.get(`canonical-event:${participation.eventId}`) ?? await canonical.getEvent(participation.eventId);
  if (!eventInput) throw upstreamRepairHostError(`Event participation ${participation.id} has no staged or canonical event '${participation.eventId}'. Stage the exact declared event dependency first; do not change eventId`);
  const event = canonicalEventSchema.parse(eventInput);
  if (!event.participants.includes(participation.entityId)) throw upstreamRepairHostError(`Event participation ${participation.id} entity '${participation.entityId}' is absent from staged event ${event.id}. Preserve the staged event identity and correct this participation once`);
  const projected = event.participantPresence?.find(item => item.entityId === participation.entityId)?.mode;
  if (entity.kind === "character" && (!participation.presence || participation.presence !== projected)) throw new Error(`Event participation ${participation.id} must copy staged event ${event.id} character presence for '${participation.entityId}' exactly (${projected ?? "missing"}). Correct this slot once; do not guess another mode`);
  if (entity.kind !== "character" && participation.presence !== undefined) throw new Error(`Event participation ${participation.id} assigns ${participation.presence} presence to non-character '${participation.entityId}' (${entity.kind}). Omit presence while preserving its event, entity and semantic role, then correct this exact slot once`);
}
export function checkUpstreamRepairMutation(verified: Pick<Awaited<ReturnType<typeof verifyUpstreamRepairPlan>>, "plan" | "bytes" | "payloads" | "activeRevisions">, kind: UpstreamRepairKind, id: string, payload: unknown, stagedDependencies: ReadonlyMap<string, unknown> = new Map(), evidenceAssertions: readonly unknown[] = []) {
  const { plan, bytes, payloads, activeRevisions } = verified;
  const anchors: Array<ReturnType<typeof textAnchorSchema.parse>> = [];
  const evidenceRefs: Array<ReturnType<typeof evidenceRefSchema.parse>> = [];
  const collect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const anchor = textAnchorSchema.safeParse(value);
    if (anchor.success) { anchors.push(anchor.data); return; }
    const evidence = evidenceRefSchema.safeParse(value);
    if (evidence.success) { evidenceRefs.push(evidence.data); return; }
    for (const child of Object.values(value)) collect(child);
  };
  collect(payload);
  for (const assertion of evidenceAssertions) collect(assertion);
  if (kind.endsWith("resolution")) for (const ref of upstreamRepairReferencedKeys(kind, payload)) {
    if (/^(entity-mention|event-mention|evidence-assertion):/.test(ref)) collect(stagedDependencies.get(ref) ?? payloads.get(ref));
  }
  const cited = new Set<string>();
  for (const reference of evidenceRefs) {
    const segmentId = plan.citableEvidenceRefs.find(id => {
      const segment = payloads.get(`source-segment:${id}`) as SourceSegment;
      if (!segment || reference.span.sourceId !== plan.sourceScope.sourceId) return false;
      if (reference.span.startByte !== undefined || reference.span.endByte !== undefined) return reference.span.startByte !== undefined
        && reference.span.endByte !== undefined && reference.span.startByte >= segment.startByte && reference.span.endByte <= segment.endByte;
      return reference.span.startLine >= segment.startLine && reference.span.endLine <= segment.endLine;
    });
    if (!segmentId) throw upstreamRepairHostError("Repair evidence reference escapes the authorized citable segments");
    cited.add(segmentId);
  }
  for (const anchor of anchors) {
    if (anchor.sourceId !== plan.sourceScope.sourceId || contentHash(anchor) !== contentHash(textAnchorForByteRange(anchor.sourceId, bytes, anchor.startByte, anchor.endByte))) throw upstreamRepairHostError("Repair anchor differs from immutable original bytes");
    const segmentId = plan.citableEvidenceRefs.find(segmentId => {
      const segment = payloads.get(`source-segment:${segmentId}`) as SourceSegment;
      return segment && anchor.startByte >= segment.startByte && anchor.endByte <= segment.endByte;
    });
    if (!segmentId) throw upstreamRepairHostError("Repair evidence escapes the authorized citable segments");
    cited.add(segmentId);
  }
  if (kind === "canonical-event" || kind === "event-participation") {
    const semantic = plan.semanticEventCreations?.find(item => item.canonicalEventId === id
      || item.participants.some(participant => participant.participationId === id));
    if (!semantic || !anchors.length) throw upstreamRepairHostError("Semantic event repair requires exact evidence inside its reviewed source occurrence");
    const reviewed = [semantic.triggerAnchor, ...semantic.extentAnchors];
    if (anchors.some(anchor => !reviewed.some(scope => anchor.sourceId === scope.sourceId
      && anchor.startByte >= scope.startByte && anchor.endByte <= scope.endByte))) {
      throw upstreamRepairHostError("Semantic event exact evidence escapes its reviewed source occurrence");
    }
  }
  assertUpstreamRepairMutation(plan, { kind, id, payload, baseline: payloads.get(`${kind}:${id}`) ?? null, activeRevisions,
    sourceSha256: plan.sourceScope.sourceSha256, requirementSetHash: plan.requirementSetHash, citedSegmentIds: [...cited], hostDerivation: derivation(kind, plan.batchId) });
}

/** Read only the declared dependency DAG, verifying every prior intent and exact envelope. */
async function stagedDependencies(root: string, verified: Awaited<ReturnType<typeof verifyUpstreamRepairPlan>>, target: { kind: UpstreamRepairKind; id: string }) {
  const { plan } = verified, state = await new UpstreamRepairLedger(root, plan.sourceScope.sourceId).inspect();
  const slots = new Map([...plan.allowedWrites, ...plan.allowedCreations].map(ref => [`${ref.kind}:${ref.id}`, ref]));
  const inspected = new Map<string, { payloads: Map<string, unknown>; refs: UpstreamStagedDependency[] }>();
  const visit = async (node: string): Promise<{ payloads: Map<string, unknown>; refs: UpstreamStagedDependency[] }> => {
    const cached = inspected.get(node);
    if (cached) return cached;
    const payloads = new Map<string, unknown>(), refs = new Map<string, UpstreamStagedDependency>();
    for (const edge of plan.dependencyEdges.filter(edge => edge.from === node)) {
      const slot = slots.get(edge.to);
      if (!slot) continue; // Existing immutable dependencies remain in the canonical preflight map.
      const attempt = state.attempts.findLast(item => item.started.planHash === plan.planHash && item.started.artifactKind === slot.kind && item.started.artifactId === slot.id && item.staged);
      if (!attempt) throw upstreamRepairHostError(`Declared dependency ${edge.to} has no staged result; stage that original host slot first without retrying this consumer unchanged`);
      const children = await visit(edge.to);
      if (contentHash(attempt.dependencies ?? []) !== contentHash(children.refs)) throw upstreamRepairHostError(`Staged dependency input revisions changed: ${edge.to}`);
      const envelope = await pending(root, plan.sourceScope.sourceId, slot.kind, attempt.started.proposalId).catch(error => { throw upstreamRepairHostError(`Declared staged dependency cannot be read: ${edge.to}; ${String(error)}`); });
      const staged = state.records.find(record => record.payload.kind === "attempt-staged" && record.payload.attemptRef === attempt.attemptRef)?.payload;
      if (staged?.kind !== "attempt-staged" || staged.proposalHash !== contentHash(envelope) || attempt.validatedHash !== contentHash(envelope.payload)
        || contentHash(envelope.generatedBy) !== contentHash({ compilerBatchId: plan.batchId, worker: toolNames[slot.kind] })) throw upstreamRepairHostError(`Declared staged dependency differs from its original envelope: ${edge.to}`);
      checkUpstreamRepairMutation(verified, slot.kind, slot.id, envelope.payload, children.payloads,
        envelopeEvidenceAssertions(envelope));
      for (const [key, payload] of children.payloads) payloads.set(key, payload);
      for (const ref of children.refs) refs.set(ref.attemptRef, ref);
      payloads.set(edge.to, envelope.payload);
      refs.set(attempt.attemptRef, { attemptRef: attempt.attemptRef, proposalHash: staged.proposalHash });
    }
    const result = { payloads, refs: [...refs.values()].sort((a, b) => a.attemptRef.localeCompare(b.attemptRef)) };
    inspected.set(node, result);
    return result;
  };
  return visit(`${target.kind}:${target.id}`);
}

/** Host-only staging under the compiler lock. This is not a model session or finish permit. */
export async function stageUpstreamRepair(root: string, sourceId: string, planHash: string, target: { kind: UpstreamRepairKind; id: string }, raw: unknown, host?: { proposalId: string; modelSessionRef: string }) {
  const ledger = new UpstreamRepairLedger(root, sourceId);
  const current = (await ledger.inspect()).plans.find(item => item.plan.planHash === planHash);
  if (!current) throw upstreamRepairHostError("Repair plan is missing");
  // Wrong order is a host scheduling issue, not a failed model attempt.
  await stagedDependencies(root, await verifyUpstreamRepairPlan(root, current.plan), target);
  const originalInput = raw === undefined ? null : raw;
  const object = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  const proposalId = host?.proposalId ?? (typeof object?.proposal_id === "string" ? object.proposal_id : "");
  const attemptRef = await ledger.startAttempt(planHash, { artifactKind: target.kind, artifactId: target.id, proposalId, inputHash: contentHash(originalInput), toolInput: originalInput, ...(host ? { modelSessionRef: host.modelSessionRef } : {}) });
  return executeUpstreamRepairStage(root, sourceId, planHash, target, raw, attemptRef, proposalId, host);
}

/** Resume one already-reserved exact host input after interruption; never creates another attempt or model session. */
export async function continueUpstreamRepairStage(root: string, sourceId: string, planHash: string, attemptRef: string) {
  const ledger = new UpstreamRepairLedger(root, sourceId), state = await ledger.inspect();
  const attempt = state.attempts.find(item => item.attemptRef === attemptRef), current = state.plans.find(item => item.plan.planHash === planHash);
  if (!current || !attempt || attempt.started.planHash !== planHash || attempt.failed || attempt.started.modelSessionRef || attempt.started.toolInput === undefined) throw upstreamRepairHostError("Exact host staging reservation is missing, failed, model-owned or has no retained input");
  if (attempt.staged) return recoverUpstreamRepairStage(root, sourceId, planHash, attemptRef);
  if (attempt.validatedHash) {
    try {
      const envelope = await pending(root, sourceId, attempt.started.artifactKind, attempt.started.proposalId);
      if (contentHash(envelope.payload) !== attempt.validatedHash) throw upstreamRepairHostError("Persisted finish-revision draft differs from its durable validated input");
      return recoverUpstreamRepairStage(root, sourceId, planHash, attemptRef);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return executeUpstreamRepairStage(root, sourceId, planHash, { kind: attempt.started.artifactKind, id: attempt.started.artifactId }, attempt.started.toolInput, attemptRef, attempt.started.proposalId);
}

async function executeUpstreamRepairStage(root: string, sourceId: string, planHash: string, target: { kind: UpstreamRepairKind; id: string }, raw: unknown, attemptRef: string, proposalId: string, host?: { proposalId: string; modelSessionRef: string }) {
  const ledger = new UpstreamRepairLedger(root, sourceId);
  const current = (await ledger.inspect()).plans.find(item => item.plan.planHash === planHash);
  if (!current) throw upstreamRepairHostError("Repair plan is missing");
  const originalInput = raw === undefined ? null : raw;
  const reserved = (await ledger.inspect()).attempts.find(item => item.attemptRef === attemptRef);
  if (!reserved || reserved.started.planHash !== planHash || reserved.started.artifactKind !== target.kind || reserved.started.artifactId !== target.id
    || reserved.started.proposalId !== proposalId || reserved.started.inputHash !== contentHash(originalInput) || contentHash(reserved.started.toolInput) !== contentHash(originalInput)) {
    throw upstreamRepairHostError("Staging continuation differs from its exact durable attempt");
  }
  const object = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  try {
    if (!object) throw new Error("Repair proposal must be one JSON object. Copy the provided typed tool schema and correct the payload once; do not repeat an unchanged input.");
    if (host && object.proposal_id !== undefined && object.proposal_id !== proposalId) throw upstreamRepairHostError("The model cannot change the host-reserved proposal ID");
    const input = host ? { ...object, proposal_id: proposalId } : object;
    const tools = createCompilerProposalToolset(root, {}, { upstreamRepair: { planHash, beforeStage: async (kind, id, payload, evidenceAssertions = []) => {
      if (kind !== target.kind || id !== target.id) throw upstreamRepairHostError("Proposed artifact differs from the reserved host slot");
      const verified = await verifyUpstreamRepairPlan(root, current.plan), dependencies = await stagedDependencies(root, verified, target);
      checkUpstreamRepairMutation(verified, kind, id, payload, dependencies.payloads, evidenceAssertions);
      await assertUpstreamSemanticPresenceProjection(root, kind, payload, dependencies.payloads);
      await ledger.recordValidated(planHash, attemptRef, contentHash(payload), dependencies.refs);
    } } });
    await tools.beginBatch(current.plan.sourceScope.segmentIds, current.plan.batchId, sourceId);
    const invoke = () => tools.executeHostProposal(toolNames[target.kind], attemptRef, input);
    const obligations = new CompilerProposalObligations(root, sourceId, current.plan.batchId);
    const result = current.hostCorrections?.some(item => item.inputHash === contentHash(input))
      ? await obligations.withHostUpstreamCorrection(toolNames[target.kind], input, planHash, attemptRef, invoke)
      : current.finishRevision
        ? await obligations.withHostUpstreamFinishRevision(toolNames[target.kind], input, planHash, attemptRef, invoke)
        : await invoke();
    if ((result as { isError?: boolean }).isError) throw new Error(result.content.filter(item => item.type === "text").map(item => item.text).join("\n"));
    const recovered = await recoverUpstreamRepairStage(root, sourceId, planHash, attemptRef);
    return { ...recovered, result };
  } catch (error) {
    const attempt = (await ledger.inspect()).attempts.find(item => item.attemptRef === attemptRef)!;
    const message = error instanceof Error ? error.message : String(error);
    // Once a payload intent is durable, a disk write may already have happened.
    // Do not relabel uncertain host effects as a retryable model failure.
    if (!attempt.validatedHash) {
      await ledger.recordFailure(planHash, attemptRef, message);
      if (message.includes("UPSTREAM_REPAIR_REQUIRES_HOST_REVIEW")) await ledger.stop(planHash, message);
      else throw error; // Preserve the original bounded selector/argument correction SOP.
    }
    throw upstreamRepairHostError(`${message}; original attempt ${attemptRef}${attempt.validatedHash ? " requires host recovery of the exact pending draft, never model replay" : " remains in the failure budget"}`);
  }
}

/** Verify an already-written draft against its durable pre-write intent; never execute a tool. */
export async function recoverUpstreamRepairStage(root: string, sourceId: string, planHash: string, attemptRef: string) {
  const ledger = new UpstreamRepairLedger(root, sourceId), state = await ledger.inspect();
  const current = state.plans.find(item => item.plan.planHash === planHash);
  const attempt = state.attempts.find(item => item.attemptRef === attemptRef);
  if (!current || !attempt || attempt.started.planHash !== planHash || attempt.failed || !attempt.validatedHash) throw upstreamRepairHostError("Original validated repair intent is missing; do not invent or replay it");
  const verified = await verifyUpstreamRepairPlan(root, current.plan);
  const envelope = await pending(root, sourceId, attempt.started.artifactKind, attempt.started.proposalId).catch(error => {
    throw upstreamRepairHostError(`Original pending draft cannot be read: ${error instanceof Error ? error.message : String(error)}; inspect nwh requirements inspect-upstream --source ${sourceId}, copy attempts[].attemptRef, and preserve the reserved intent without model replay`);
  });
  const generatedBy = { compilerBatchId: current.plan.batchId, worker: toolNames[attempt.started.artifactKind] };
  if (contentHash(envelope.payload) !== attempt.validatedHash || envelope.id !== attempt.started.proposalId || contentHash(envelope.generatedBy) !== contentHash(generatedBy)) throw upstreamRepairHostError("Pending repair draft differs from its original validated intent");
  const dependencies = await stagedDependencies(root, verified, { kind: attempt.started.artifactKind, id: attempt.started.artifactId });
  if (contentHash(attempt.dependencies ?? []) !== contentHash(dependencies.refs)) throw upstreamRepairHostError("Original validated repair dependency revisions changed");
  checkUpstreamRepairMutation(verified, attempt.started.artifactKind, attempt.started.artifactId, envelope.payload, dependencies.payloads,
    envelopeEvidenceAssertions(envelope));
  await assertUpstreamSemanticPresenceProjection(root, attempt.started.artifactKind, envelope.payload, dependencies.payloads);
  const proposalHash = contentHash(envelope);
  await ledger.recordStaged(planHash, attemptRef, proposalHash);
  return { attemptRef, proposalId: envelope.id, proposalHash };
}

/** Host-only immutable model context; only declared readable refs, evidence and DAG inputs escape. */
export async function upstreamRepairSlotContext(root: string, sourceId: string, planHash: string, target: { kind: UpstreamRepairKind; id: string }) {
  const current = (await new UpstreamRepairLedger(root, sourceId).inspect()).plans.find(item => item.plan.planHash === planHash);
  if (!current || ![...current.plan.allowedWrites, ...current.plan.allowedCreations].some(item => item.kind === target.kind && item.id === target.id)) throw upstreamRepairHostError("Unknown authorized repair slot");
  const verified = await verifyUpstreamRepairPlan(root, current.plan), dependencies = await stagedDependencies(root, verified, target);
  return {
    plan: current.plan, target,
    reviewedOccurrences: (current.plan.semanticEventCreations ?? []).map(item => ({
      ...item,
      triggerExact: verified.bytes.subarray(item.triggerAnchor.startByte, item.triggerAnchor.endByte).toString("utf8"),
      extentExact: item.extentAnchors.map(anchor => verified.bytes.subarray(anchor.startByte, anchor.endByte).toString("utf8")),
    })),
    readable: current.plan.readableRefs.map(ref => ({ ...ref, payload: verified.payloads.get(`${ref.kind}:${ref.id}`) })),
    stagedDependencies: [...dependencies.payloads].map(([ref, payload]) => ({ ref, payload })),
    evidence: current.plan.citableEvidenceRefs.map(segmentId => {
      const segment = verified.payloads.get(`source-segment:${segmentId}`) as SourceSegment;
      return { segmentId, startByte: segment.startByte, endByte: segment.endByte, text: verified.bytes.subarray(segment.startByte, segment.endByte).toString("utf8") };
    }),
  };
}
