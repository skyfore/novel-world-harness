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
import { checkUpstreamRepairMutation, recoverUpstreamRepairStage } from "./upstream-repair-staging.js";
import { UpstreamRepairFinishValidationError, freezeUpstreamRepairFinishIntent, type UpstreamRepairFinishIntent } from "./upstream-repair-finish-intent.js";
import type { UpstreamRepairPlan } from "./upstream-repair-plan.js";

async function assertFinishInventory(root: string, plan: UpstreamRepairPlan, proposals: UpstreamRepairFinishIntent["proposals"], intent?: UpstreamRepairFinishIntent) {
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
  const receipt = await new CompilerFinishReceipts(root, sourceId, plan.batchId).read();
  if (receipt && (!intent || contentHash(receipt.identity.upstreamRepairIntent ?? null) !== contentHash(intent))) throw upstreamRepairHostError("An ordinary finish receipt already owns this upstream batch; do not reinterpret it as authorization");
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

/** Host verification accepts own exact outputs only after the original receipt is durable. */
export async function verifyUpstreamRepairFinish(root: string, sourceId: string, planHash: string, expectedIntent?: UpstreamRepairFinishIntent, requireCommitted = false, expectedBatchId?: string) {
  const current = (await new UpstreamRepairLedger(root, sourceId).inspect()).plans.find(item => item.plan.planHash === planHash);
  if (!current?.finishIntent || !["finish-frozen", "finished"].includes(current.state)) throw upstreamRepairHostError("Original active frozen finish intent is missing");
  const { plan, finishIntent: intent } = current;
  if (expectedBatchId && plan.batchId !== expectedBatchId) throw upstreamRepairHostError("Finish receipt batch differs from retained authorization");
  if (expectedIntent && contentHash(intent) !== contentHash(expectedIntent)) throw upstreamRepairHostError("Finish receipt differs from retained authorization");
  await assertFinishInventory(root, plan, intent.proposals, intent);
  const receipt = await new CompilerFinishReceipts(root, sourceId, plan.batchId).read();
  const committedOutputs = new Map<string, string>(), outputs = new Map<string, unknown>();
  for (const proposal of intent.proposals) {
    const store = proposal.artifactKind === "entity-resolution" ? new EntityResolutionStore(root) : proposal.artifactKind === "event-resolution" ? new EventResolutionStore(root) : new SourceAnnotationStore(root);
    let envelope;
    try { envelope = await store.readProposal(sourceId, "pending", proposal.proposalId); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; envelope = await store.readProposal(sourceId, "accepted", proposal.proposalId); }
    if (contentHash(envelope) !== proposal.proposalHash || contentHash(envelope.payload) !== proposal.payloadHash) throw upstreamRepairHostError("Original finish proposal envelope changed");
    const key = `${proposal.artifactKind}:${proposal.artifactId}`;
    outputs.set(key, envelope.payload);
    if (receipt) committedOutputs.set(key, proposal.payloadHash);
  }
  const verified = await verifyUpstreamRepairPlan(root, plan, committedOutputs);
  if (requireCommitted) for (const proposal of intent.proposals) if (verified.activeRevisions.get(`${proposal.artifactKind}:${proposal.artifactId}`) !== proposal.payloadHash) throw upstreamRepairHostError("Completed finish output is no longer active");
  // Re-run the field and source guard against the original baselines, never
  // against a partially committed proposal masquerading as its own baseline.
  for (const baseline of intent.baselines) { const key = `${baseline.kind}:${baseline.id}`; verified.payloads.set(key, baseline.payload); verified.activeRevisions.set(key, baseline.revisionHash); }
  for (const creation of plan.allowedCreations) { const key = `${creation.kind}:${creation.id}`; verified.payloads.delete(key); verified.activeRevisions.delete(key); }
  for (const proposal of intent.proposals) checkUpstreamRepairMutation(verified, proposal.artifactKind, proposal.artifactId, outputs.get(`${proposal.artifactKind}:${proposal.artifactId}`), outputs);
  return intent;
}

/** Compiler-lock-owned host executor; no model session and no replacement inputs. */
export async function executeUpstreamRepairFinish(root: string, sourceId: string, planHash: string) {
  const intent = await verifyUpstreamRepairFinish(root, sourceId, planHash);
  const ledger = new UpstreamRepairLedger(root, sourceId), current = (await ledger.inspect()).plans.find(item => item.plan.planHash === planHash)!;
  const receipts = new CompilerFinishReceipts(root, sourceId, current.plan.batchId), receipt = await receipts.read();
  if (receipt?.state !== "completed") {
    const { createCompilerProposalToolset } = await import("./proposal-tools.js");
    const toolset = createCompilerProposalToolset(root, {}, { recoverPreparedFinish: true, upstreamFinish: intent });
    await toolset.beginBatch(current.plan.sourceScope.segmentIds, current.plan.batchId, sourceId);
    const result = await toolset.tools.find(tool => tool.name === "finish_compiler_batch")!.execute("host-upstream-finish", intent.input, undefined, undefined, {} as never).catch(async error => {
      if (error instanceof UpstreamRepairFinishValidationError) {
        await ledger.stop(planHash, error.message);
        throw upstreamRepairHostError(`Original finish validation failed: ${error.message}`);
      }
      throw error; // Interrupted host I/O retains its recoverable original intent.
    });
    if (!(result.details as { compilerBatchFinished?: boolean })?.compilerBatchFinished) {
      const reason = `Original finish validation failed: ${JSON.stringify(result.content)}`;
      await ledger.stop(planHash, reason);
      throw upstreamRepairHostError(reason);
    }
  }
  await receipts.assertCompleted();
  const completed = (await receipts.read())!;
  await ledger.recordFinished(planHash, completed.fingerprint);
  const { observeRequirementValidity } = await import("./requirement-observation.js");
  await observeRequirementValidity(root, sourceId);
  return completed;
}
