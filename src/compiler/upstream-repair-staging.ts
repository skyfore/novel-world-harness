import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withNwhToolRecovery } from "../agent/tool-recovery.js";
import { contentHash } from "../world/canonical.js";
import { textAnchorSchema } from "../world/model.js";
import { SourceAnnotationStore } from "./annotations.js";
import { EntityResolutionStore } from "./entity-resolution.js";
import { EventResolutionStore } from "./event-resolution.js";
import { createCompilerProposalToolset } from "./proposal-tools.js";
import { UpstreamRepairLedger, type UpstreamStagedDependency } from "./upstream-repair-ledger.js";
import { assertUpstreamRepairMutation, upstreamRepairReferencedKeys, type UpstreamRepairKind } from "./upstream-repair-plan.js";
import { upstreamRepairHostError, verifyUpstreamRepairPlan } from "./upstream-repair-preflight.js";
import { textAnchorForByteRange } from "./text-anchors.js";
import type { SourceSegment } from "./segments.js";

const toolNames: Record<UpstreamRepairKind, string> = {
  "entity-mention": "propose_entity_mention", "event-mention": "propose_event_mention", quotation: "propose_quotation",
  "discourse-segment": "propose_discourse_segment", "entity-resolution": "propose_entity_resolution", "event-resolution": "propose_event_resolution",
};
async function pending(root: string, sourceId: string, kind: UpstreamRepairKind, proposalId: string) {
  if (kind === "entity-resolution") return new EntityResolutionStore(root).readProposal(sourceId, "pending", proposalId);
  if (kind === "event-resolution") return new EventResolutionStore(root).readProposal(sourceId, "pending", proposalId);
  return new SourceAnnotationStore(root).readProposal(sourceId, "pending", proposalId);
}
function derivation(kind: UpstreamRepairKind, batchId: string) {
  return { runId: batchId, compilerBatchId: batchId, worker: toolNames[kind], ontologyVersion: kind === "entity-resolution" ? "entity-resolution-v1" : kind === "event-resolution" ? "event-resolution-v1" : "observation-v1" };
}
function checkMutation(verified: Awaited<ReturnType<typeof verifyUpstreamRepairPlan>>, kind: UpstreamRepairKind, id: string, payload: unknown, stagedDependencies: ReadonlyMap<string, unknown> = new Map()) {
  const { plan, bytes, payloads, activeRevisions } = verified;
  const anchors: Array<ReturnType<typeof textAnchorSchema.parse>> = [];
  const collect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const anchor = textAnchorSchema.safeParse(value);
    if (anchor.success) { anchors.push(anchor.data); return; }
    for (const child of Object.values(value)) collect(child);
  };
  collect(payload);
  if (kind.endsWith("resolution")) for (const ref of upstreamRepairReferencedKeys(kind, payload)) {
    if (/^(entity-mention|event-mention|evidence-assertion):/.test(ref)) collect(stagedDependencies.get(ref) ?? payloads.get(ref));
  }
  const cited = new Set<string>();
  for (const anchor of anchors) {
    if (anchor.sourceId !== plan.sourceScope.sourceId || contentHash(anchor) !== contentHash(textAnchorForByteRange(anchor.sourceId, bytes, anchor.startByte, anchor.endByte))) throw upstreamRepairHostError("Repair anchor differs from immutable original bytes");
    const segmentId = plan.citableEvidenceRefs.find(segmentId => {
      const segment = payloads.get(`source-segment:${segmentId}`) as SourceSegment;
      return segment && anchor.startByte >= segment.startByte && anchor.endByte <= segment.endByte;
    });
    if (!segmentId) throw upstreamRepairHostError("Repair evidence escapes the authorized citable segments");
    cited.add(segmentId);
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
      const attempt = state.attempts.find(item => item.started.planHash === plan.planHash && item.started.artifactKind === slot.kind && item.started.artifactId === slot.id && item.staged);
      if (!attempt) throw upstreamRepairHostError(`Declared dependency ${edge.to} has no staged result; stage that original host slot first without retrying this consumer unchanged`);
      const children = await visit(edge.to);
      if (contentHash(attempt.dependencies ?? []) !== contentHash(children.refs)) throw upstreamRepairHostError(`Staged dependency input revisions changed: ${edge.to}`);
      const envelope = await pending(root, plan.sourceScope.sourceId, slot.kind, attempt.started.proposalId).catch(error => { throw upstreamRepairHostError(`Declared staged dependency cannot be read: ${edge.to}; ${String(error)}`); });
      const staged = state.records.find(record => record.payload.kind === "attempt-staged" && record.payload.attemptRef === attempt.attemptRef)?.payload;
      if (staged?.kind !== "attempt-staged" || staged.proposalHash !== contentHash(envelope) || attempt.validatedHash !== contentHash(envelope.payload)
        || contentHash(envelope.generatedBy) !== contentHash({ compilerBatchId: plan.batchId, worker: toolNames[slot.kind] })) throw upstreamRepairHostError(`Declared staged dependency differs from its original envelope: ${edge.to}`);
      checkMutation(verified, slot.kind, slot.id, envelope.payload, children.payloads);
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
export async function stageUpstreamRepair(root: string, sourceId: string, planHash: string, target: { kind: UpstreamRepairKind; id: string }, raw: Record<string, unknown>) {
  const ledger = new UpstreamRepairLedger(root, sourceId);
  const current = (await ledger.inspect()).plans.find(item => item.plan.planHash === planHash);
  if (!current) throw upstreamRepairHostError("Repair plan is missing");
  // Wrong order is a host scheduling issue, not a failed model attempt.
  await stagedDependencies(root, await verifyUpstreamRepairPlan(root, current.plan), target);
  const proposalId = typeof raw.proposal_id === "string" ? raw.proposal_id : "";
  const attemptRef = await ledger.startAttempt(planHash, { artifactKind: target.kind, artifactId: target.id, proposalId, inputHash: contentHash(raw), toolInput: raw });
  try {
    const tools = createCompilerProposalToolset(root, {}, { upstreamRepair: { planHash, beforeStage: async (kind, id, payload) => {
      if (kind !== target.kind || id !== target.id) throw upstreamRepairHostError("Proposed artifact differs from the reserved host slot");
      const verified = await verifyUpstreamRepairPlan(root, current.plan), dependencies = await stagedDependencies(root, verified, target);
      checkMutation(verified, kind, id, payload, dependencies.payloads);
      await ledger.recordValidated(planHash, attemptRef, contentHash(payload), dependencies.refs);
    } } });
    await tools.beginBatch(current.plan.sourceScope.segmentIds, current.plan.batchId, sourceId);
    const tool = withNwhToolRecovery(tools.tools.find(tool => tool.name === toolNames[target.kind])!);
    const prepared = tool.prepareArguments ? tool.prepareArguments(raw) : raw;
    const result = await tool.execute(attemptRef, prepared as never, undefined, undefined, {} as ExtensionContext);
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
  checkMutation(verified, attempt.started.artifactKind, attempt.started.artifactId, envelope.payload, dependencies.payloads);
  const proposalHash = contentHash(envelope);
  await ledger.recordStaged(planHash, attemptRef, proposalHash);
  return { attemptRef, proposalId: envelope.id, proposalHash };
}
