import { contentHash } from "../world/canonical.js";
import { ProposalStore } from "../world/canonical-model.js";
import { SourceAnnotationStore } from "./annotations.js";
import { EntityResolutionStore } from "./entity-resolution.js";
import { EventResolutionStore } from "./event-resolution.js";
import { CompilerFinishReceipts } from "./finish-receipts.js";
import { assertUpstreamRepairFinishInventory } from "./upstream-repair-finish.js";
import { freezeUpstreamRepairFinishIntent, type UpstreamRepairFinishIntent } from "./upstream-repair-finish-intent.js";
import {
  finishRevisionSemanticInputHash,
  freezeUpstreamRepairFinishRevisionIntent,
  type UpstreamRepairFinishRevisionCorrection,
  type UpstreamRepairFinishRevisionIntent,
} from "./upstream-repair-finish-revision-intent.js";
import { UpstreamRepairLedger, upstreamRepairFinishGraphHash } from "./upstream-repair-ledger.js";
import type { UpstreamRepairKind, UpstreamRepairPlan } from "./upstream-repair-plan.js";
import { upstreamRepairHostError, verifyUpstreamRepairPlan } from "./upstream-repair-preflight.js";
import { continueUpstreamRepairStage, recoverUpstreamRepairStage, stageUpstreamRepair } from "./upstream-repair-staging.js";

type StoredEnvelope = { status: "pending" | "accepted" | "rejected"; envelope: Record<string, unknown> };
export type UpstreamRepairFinishRevisionReview = Omit<UpstreamRepairFinishRevisionIntent, "revisionHash">;

function storeKind(kind: UpstreamRepairKind): "world" | "annotation" | "entity-resolution" | "event-resolution" {
  if (kind === "entity-resolution" || kind === "event-resolution") return kind;
  return kind === "canonical-event" || kind === "event-participation" ? "world" : "annotation";
}

async function readStoredEnvelopes(root: string, sourceId: string, kind: UpstreamRepairKind, proposalId: string): Promise<StoredEnvelope[]> {
  const selected = storeKind(kind), found: StoredEnvelope[] = [];
  for (const status of ["pending", "accepted", "rejected"] as const) {
    try {
      const envelope = selected === "world" ? await new ProposalStore(root).readEnvelope(status, proposalId)
        : selected === "annotation" ? await new SourceAnnotationStore(root).readProposal(sourceId, status, proposalId)
          : selected === "entity-resolution" ? await new EntityResolutionStore(root).readProposal(sourceId, status, proposalId)
            : await new EventResolutionStore(root).readProposal(sourceId, status, proposalId);
      found.push({ status, envelope: envelope as unknown as Record<string, unknown> });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return found;
}

async function rejectOriginalDraft(root: string, sourceId: string, correction: UpstreamRepairFinishRevisionCorrection, revisionHash: string, proposalHash: string): Promise<void> {
  const found = await readStoredEnvelopes(root, sourceId, correction.artifactKind, correction.originalProposalId);
  if (found.length !== 1 || contentHash(found[0]!.envelope) !== proposalHash || found[0]!.status === "accepted") throw upstreamRepairHostError("Finish revision original draft is missing, ambiguous, accepted or changed");
  if (found[0]!.status === "rejected") return;
  const selected = storeKind(correction.artifactKind);
  if (selected === "world") {
    await new ProposalStore(root).reject(correction.originalProposalId, [{
      code: "UPSTREAM_FINISH_REVISION_SUPERSEDED",
      message: `Host-reviewed pre-receipt finish revision ${revisionHash} replaces this failed graph member while retaining its immutable audit history.`,
    }]);
  } else if (selected === "annotation") await new SourceAnnotationStore(root).withdraw(sourceId, correction.originalProposalId);
  else if (selected === "entity-resolution") await new EntityResolutionStore(root).withdraw(sourceId, correction.originalProposalId);
  else await new EventResolutionStore(root).withdraw(sourceId, correction.originalProposalId);
}

async function assertNoFinishReceipt(root: string, sourceId: string, batchId: string): Promise<void> {
  if (await new CompilerFinishReceipts(root, sourceId, batchId).read()) throw upstreamRepairHostError("Finish revision is forbidden after any prepared or completed receipt; recover the original receipt instead");
}

function planAttempts(state: Awaited<ReturnType<UpstreamRepairLedger["inspect"]>>, planHash: string) {
  return new Map(state.attempts.filter(item => item.started.planHash === planHash).map(item => [item.attemptRef, item]));
}

function originalProposalMap(intent: UpstreamRepairFinishIntent) {
  return new Map(intent.proposals.map(proposal => [`${proposal.artifactKind}:${proposal.artifactId}`, proposal]));
}

async function assertOriginalPendingGraph(root: string, sourceId: string, plan: UpstreamRepairPlan, intent: UpstreamRepairFinishIntent): Promise<void> {
  for (const proposal of intent.proposals) {
    const found = await readStoredEnvelopes(root, sourceId, proposal.artifactKind, proposal.proposalId);
    if (found.length !== 1 || found[0]!.status !== "pending" || contentHash(found[0]!.envelope) !== proposal.proposalHash
      || contentHash(found[0]!.envelope.payload) !== proposal.payloadHash) throw upstreamRepairHostError("Finish revision requires every original output to remain one exact uncommitted pending draft");
  }
  await assertUpstreamRepairFinishInventory(root, plan, intent.proposals, intent);
}

/** Read-only same-plan discovery. Copy its exact hash/ref fields into one reviewed revision. */
export async function inspectUpstreamRepairFinishRevisionAuthority(root: string, sourceId: string, planHash: string) {
  const ledger = new UpstreamRepairLedger(root, sourceId), state = await ledger.inspect();
  const current = state.plans.find(item => item.plan.planHash === planHash), head = state.records.at(-1);
  const original = current?.originalFinishIntent ?? current?.finishIntent;
  if (!current || current.state !== "needs-host-review" || !original || current.finishRevision || current.finishedReceipt
    || head?.payload.kind !== "needs-host-review" || head.payload.planHash !== planHash
    || state.modelSessions.some(item => !item.closed)
    || state.attempts.some(item => item.started.planHash === planHash && !item.failed && !item.staged)) {
    throw upstreamRepairHostError("Finish revision authority requires the exact settled stopped pre-receipt plan head with no prior revision or open I/O");
  }
  await assertNoFinishReceipt(root, sourceId, current.plan.batchId);
  await verifyUpstreamRepairPlan(root, current.plan);
  await assertOriginalPendingGraph(root, sourceId, current.plan, original);
  const attempts = planAttempts(state, planHash), slots = original.proposals.map(proposal => {
    const attempt = attempts.get(proposal.attemptRef);
    if (!attempt?.staged || attempt.started.toolInput === undefined || attempt.started.inputHash !== contentHash(attempt.started.toolInput)) throw upstreamRepairHostError("Original finish graph lacks an exact retained staged tool input");
    return {
      artifactKind: proposal.artifactKind,
      artifactId: proposal.artifactId,
      originalAttemptRef: proposal.attemptRef,
      originalProposalId: proposal.proposalId,
      originalInputHash: attempt.started.inputHash,
      semanticInputHash: finishRevisionSemanticInputHash(attempt.started.toolInput),
      toolInput: attempt.started.toolInput,
      dependencies: attempt.dependencies ?? [],
    };
  });
  return {
    version: 1 as const,
    sourceId,
    planHash,
    batchId: current.plan.batchId,
    failedFinishRef: head.hash,
    failureReason: head.payload.reason,
    originalIntentHash: original.intentHash,
    originalGraphHash: upstreamRepairFinishGraphHash(current.plan, original, attempts),
    sourceScope: current.plan.sourceScope,
    finishInput: original.input,
    slots,
  };
}

/** Freeze one exact host-reviewed correction graph. Caller holds the compiler lock. */
export async function authorizeUpstreamRepairFinishRevision(root: string, sourceId: string, planHash: string, raw: UpstreamRepairFinishRevisionReview) {
  const authority = await inspectUpstreamRepairFinishRevisionAuthority(root, sourceId, planHash);
  const revision = freezeUpstreamRepairFinishRevisionIntent(raw);
  if (revision.sourceId !== sourceId || revision.planHash !== planHash || revision.failedFinishRef !== authority.failedFinishRef
    || revision.originalIntentHash !== authority.originalIntentHash || revision.originalGraphHash !== authority.originalGraphHash) {
    throw upstreamRepairHostError("Finish revision review differs from the exact same-scope authority; inspect again and copy failedFinishRef, originalIntentHash and originalGraphHash without guessing");
  }
  const originals = new Map(authority.slots.map(slot => [`${slot.artifactKind}:${slot.artifactId}`, slot]));
  for (const correction of revision.corrections) {
    const original = originals.get(`${correction.artifactKind}:${correction.artifactId}`);
    if (!original || correction.originalAttemptRef !== original.originalAttemptRef || correction.originalProposalId !== original.originalProposalId
      || correction.originalInputHash !== original.originalInputHash) throw upstreamRepairHostError("Finish revision correction must copy the exact original slot fields from same-plan authority");
    const replacement = await readStoredEnvelopes(root, sourceId, correction.artifactKind, correction.replacementProposalId);
    if (replacement.length) throw upstreamRepairHostError("Finish revision replacement proposal ID already exists; do not reuse or rotate around retained history");
  }
  await new UpstreamRepairLedger(root, sourceId).authorizeFinishRevision(revision);
  return revision;
}

function correctionOrder(plan: UpstreamRepairPlan, corrections: readonly UpstreamRepairFinishRevisionCorrection[]) {
  const byKey = new Map(corrections.map(item => [`${item.artifactKind}:${item.artifactId}`, item])), ordered: UpstreamRepairFinishRevisionCorrection[] = [], visiting = new Set<string>(), done = new Set<string>();
  const visit = (key: string) => {
    if (done.has(key)) return;
    if (visiting.has(key)) throw upstreamRepairHostError("Finish revision correction graph contains a dependency cycle");
    visiting.add(key);
    for (const edge of plan.dependencyEdges.filter(item => item.from === key && byKey.has(item.to))) visit(edge.to);
    visiting.delete(key); done.add(key); ordered.push(byKey.get(key)!);
  };
  for (const key of [...byKey.keys()].sort()) visit(key);
  return ordered;
}

/** Continue only the frozen revision intent, recovering exact writes and then restoring the normal finish gate. */
export async function continueUpstreamRepairFinishRevision(root: string, sourceId: string, planHash: string, revisionHash: string) {
  const ledger = new UpstreamRepairLedger(root, sourceId), initial = await ledger.inspect();
  const current = initial.plans.find(item => item.plan.planHash === planHash), revision = current?.finishRevision;
  if (!current || !revision || revision.intent.revisionHash !== revisionHash || revision.completed || current.state !== "finish-revising") throw upstreamRepairHostError("Exact active finish revision is missing, consumed or stopped; inspect the retained plan and do not grant another revision");
  await assertNoFinishReceipt(root, sourceId, current.plan.batchId);
  await verifyUpstreamRepairPlan(root, current.plan);
  const original = current.originalFinishIntent;
  if (!original) throw upstreamRepairHostError("Original failed finish intent is missing");
  const originalAttempts = planAttempts(initial, planHash);
  if (upstreamRepairFinishGraphHash(current.plan, original, originalAttempts) !== revision.intent.originalGraphHash) throw upstreamRepairHostError("Original finish graph, baselines, source scope or dependency hashes changed");
  const originals = originalProposalMap(original);
  for (const correction of revision.intent.corrections) {
    const proposal = originals.get(`${correction.artifactKind}:${correction.artifactId}`)!;
    await rejectOriginalDraft(root, sourceId, correction, revisionHash, proposal.proposalHash);
  }
  for (const correction of correctionOrder(current.plan, revision.intent.corrections)) {
    let state = await ledger.inspect();
    const existing = state.attempts.find(item => item.started.planHash === planHash && item.started.proposalId === correction.replacementProposalId);
    if (existing?.failed) throw upstreamRepairHostError("Reviewed finish revision failed and consumed its single grant; preserve both drafts and request host review");
    if (existing) await continueUpstreamRepairStage(root, sourceId, planHash, existing.attemptRef);
    else await stageUpstreamRepair(root, sourceId, planHash, { kind: correction.artifactKind, id: correction.artifactId }, correction.toolInput);
  }
  const state = await ledger.inspect(), refreshed = state.plans.find(item => item.plan.planHash === planHash)!;
  if (refreshed.state !== "finish-revising" || refreshed.finishRevision?.intent.revisionHash !== revisionHash) throw upstreamRepairHostError("Finish revision stopped before all exact replacements were validated");
  const corrections = new Map(revision.intent.corrections.map(item => [`${item.artifactKind}:${item.artifactId}`, item]));
  const proposals: UpstreamRepairFinishIntent["proposals"] = [];
  for (const slot of [...current.plan.allowedWrites, ...current.plan.allowedCreations]) {
    const key = `${slot.kind}:${slot.id}`, correction = corrections.get(key), prior = originals.get(key)!;
    const attempt = correction
      ? state.attempts.find(item => item.started.planHash === planHash && item.started.proposalId === correction.replacementProposalId && item.staged)
      : state.attempts.find(item => item.attemptRef === prior.attemptRef && item.staged);
    if (!attempt?.validatedHash) throw upstreamRepairHostError(`Finish revision slot ${key} has no effective validated staged result`);
    const recovered = await recoverUpstreamRepairStage(root, sourceId, planHash, attempt.attemptRef);
    proposals.push({ artifactKind: slot.kind, artifactId: slot.id, proposalId: recovered.proposalId, proposalHash: recovered.proposalHash, attemptRef: attempt.attemptRef, payloadHash: attempt.validatedHash });
  }
  await assertUpstreamRepairFinishInventory(root, current.plan, proposals);
  const intent = freezeUpstreamRepairFinishIntent({
    version: 1,
    planHash,
    sourceId,
    sourceSha256: original.sourceSha256,
    requirementSetHash: original.requirementSetHash,
    authorizationHeadHash: revision.ref,
    input: original.input,
    proposals: proposals.sort((left, right) => left.attemptRef.localeCompare(right.attemptRef)),
    baselines: original.baselines,
  });
  await ledger.completeFinishRevision(planHash, revisionHash, intent);
  return intent;
}
