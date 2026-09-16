import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { ProposalStore } from "../world/canonical-model.js";
import { SourceAnnotationStore } from "./annotations.js";
import { EntityResolutionStore } from "./entity-resolution.js";
import { EventResolutionStore } from "./event-resolution.js";
import { SourceAccountingStore } from "./source-accounting.js";
import { compilerFinishInputSchema } from "./finish-input.js";
import { CompilerFinishReceipts } from "./finish-receipts.js";
import { ChapterSplitPlanStore } from "./chapter-split.js";
import { RoleRosterStore } from "./role-roster.js";
import { UpstreamRepairLedger } from "./upstream-repair-ledger.js";
import { verifyUpstreamRepairPlan, upstreamRepairHostError } from "./upstream-repair-preflight.js";
import { recoverUpstreamRepairStage } from "./upstream-repair-staging.js";
import { freezeUpstreamRepairFinishIntent, type UpstreamRepairFinishIntent } from "./upstream-repair-finish-intent.js";
import type { UpstreamRepairPlan } from "./upstream-repair-plan.js";

async function assertFinishInventory(root: string, plan: UpstreamRepairPlan, proposals: UpstreamRepairFinishIntent["proposals"]) {
  const sourceId = plan.sourceScope.sourceId, expected = new Set(proposals.map(item => `${item.artifactKind.endsWith("resolution") ? item.artifactKind : "annotation"}:${item.proposalId}`));
  const actual = [
    ...(await new SourceAnnotationStore(root).listBatchProposals(sourceId, plan.batchId)).map(item => `annotation:${item.id}`),
    ...(await new EntityResolutionStore(root).listRecoverableBatchProposals(sourceId, plan.batchId)).map(item => `entity-resolution:${item.id}`),
    ...(await new EventResolutionStore(root).listRecoverableBatchProposals(sourceId, plan.batchId)).map(item => `event-resolution:${item.id}`),
  ];
  if (actual.length !== expected.size || actual.some(key => !expected.has(key))) throw upstreamRepairHostError("Finish batch contains missing or unauthorized upstream proposals");
  if ((await new SourceAccountingStore(root).listBatchProposals(sourceId, plan.batchId)).length) throw upstreamRepairHostError("Upstream finish cannot include accounting side effects");
  const world = new ProposalStore(root);
  for (const status of ["pending", "accepted"] as const) for (const item of await world.list(status)) {
    const envelope = await world.readEnvelope(status, item.id);
    if ((envelope.generatedBy as { compilerBatchId?: string } | undefined)?.compilerBatchId === plan.batchId) throw upstreamRepairHostError("Upstream finish cannot include world proposals");
  }
  const { WorkspaceStore } = await import("../storage/workspace-store.js");
  const source = await WorkspaceStore.openReadOnly(root).getSource(sourceId);
  if (source?.pendingTitleProposal?.generatedBy.compilerBatchId === plan.batchId
    || (await new ChapterSplitPlanStore(root).read(sourceId))?.generatedBy.compilerBatchId === plan.batchId
    || (await new RoleRosterStore(root).read(sourceId))?.reviews.some(review => review.runId === plan.batchId)) throw upstreamRepairHostError("Upstream finish cannot include unrelated compiler metadata");
  if (await new CompilerFinishReceipts(root, sourceId, plan.batchId).read()) throw upstreamRepairHostError("An ordinary finish receipt already owns this upstream batch; do not reinterpret it as authorization");
}

/** Freeze a host finish intent only; original compiler validation and commit are still a separate gate. */
export async function prepareUpstreamRepairFinish(root: string, sourceId: string, planHash: string, raw: z.input<typeof compilerFinishInputSchema>): Promise<UpstreamRepairFinishIntent> {
  const input = compilerFinishInputSchema.parse(raw), ledger = new UpstreamRepairLedger(root, sourceId);
  const state = await ledger.inspect(), current = state.plans.find(item => item.plan.planHash === planHash);
  if (!current || !["staging", "finish-frozen"].includes(current.state)) throw upstreamRepairHostError("Upstream finish requires an active fully staged plan");
  if (current.finishIntent && contentHash(current.finishIntent.input) !== contentHash(input)) throw upstreamRepairHostError("Original frozen finish input changed");
  const verified = await verifyUpstreamRepairPlan(root, current.plan);
  const proposals: UpstreamRepairFinishIntent["proposals"] = [];
  for (const slot of [...current.plan.allowedWrites, ...current.plan.allowedCreations]) {
    const attempt = state.attempts.find(item => item.started.planHash === planHash && item.started.artifactKind === slot.kind && item.started.artifactId === slot.id && item.staged);
    if (!attempt?.validatedHash) throw upstreamRepairHostError(`Finish slot ${slot.kind}:${slot.id} has no validated staged result`);
    const result = await recoverUpstreamRepairStage(root, sourceId, planHash, attempt.attemptRef);
    proposals.push({ artifactKind: slot.kind, artifactId: slot.id, proposalId: result.proposalId, proposalHash: result.proposalHash, attemptRef: attempt.attemptRef, payloadHash: attempt.validatedHash });
  }
  await assertFinishInventory(root, current.plan, proposals);
  const original = current.finishIntent;
  const intent = freezeUpstreamRepairFinishIntent({ version: 1, planHash, sourceId, sourceSha256: current.plan.sourceScope.sourceSha256,
    requirementSetHash: current.plan.requirementSetHash, authorizationHeadHash: original?.authorizationHeadHash ?? (await ledger.history()).at(-1)!.hash, input,
    proposals: proposals.sort((a, b) => a.attemptRef.localeCompare(b.attemptRef)),
    baselines: current.plan.baselineRefs.map(ref => ({ ...ref, payload: verified.payloads.get(`${ref.kind}:${ref.id}`) })).sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
  });
  await ledger.freezeFinish(intent);
  return intent;
}
