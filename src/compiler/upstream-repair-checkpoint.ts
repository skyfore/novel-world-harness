import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { SourceAnnotationStore, sourceAnnotationProposalSchema } from "./annotations.js";
import { EntityResolutionStore, identityResolutionProposalSchema } from "./entity-resolution.js";
import { EventResolutionStore, eventResolutionProposalSchema } from "./event-resolution.js";
import { CompilerFinishReceipts, compilerFinishReceiptSchema } from "./finish-receipts.js";
import { UpstreamRepairLedger, inspectUpstreamRepairJournal, upstreamRepairJournalSchema, type UpstreamRepairRecord } from "./upstream-repair-ledger.js";
import { upstreamRepairHostError } from "./upstream-repair-preflight.js";
import { COMPILER_PIPELINE_VERSION } from "./batch-progress.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const common = { planHash: hash, attemptRef: hash, status: z.enum(["pending", "accepted"]) };
const draftSchema = z.discriminatedUnion("store", [
  z.object({ ...common, store: z.literal("annotation"), envelope: sourceAnnotationProposalSchema }).strict(),
  z.object({ ...common, store: z.literal("entity-resolution"), envelope: identityResolutionProposalSchema }).strict(),
  z.object({ ...common, store: z.literal("event-resolution"), envelope: eventResolutionProposalSchema }).strict(),
]);
export const upstreamRepairCheckpointSchema = z.object({
  version: z.literal(1), drafts: z.array(draftSchema), activeReceipts: z.array(compilerFinishReceiptSchema),
}).strict();
export type UpstreamRepairCheckpoint = z.infer<typeof upstreamRepairCheckpointSchema>;
type Draft = UpstreamRepairCheckpoint["drafts"][number];
function storeFor(root: string, store: Draft["store"]) {
  return store === "annotation" ? new SourceAnnotationStore(root) : store === "entity-resolution" ? new EntityResolutionStore(root) : new EventResolutionStore(root);
}

/** Validate complete declared draft membership against the immutable staging journal. */
export function assertUpstreamRepairCheckpoint(input: UpstreamRepairCheckpoint, journal: readonly UpstreamRepairRecord[], sourceId: string, includeCompleted = true) {
  const checkpoint = upstreamRepairCheckpointSchema.parse(input), records = upstreamRepairJournalSchema.parse(journal);
  const state = inspectUpstreamRepairJournal(records);
  const live = new Set(state.plans.filter(item => ["staging", "finish-frozen", ...(includeCompleted ? ["finished", "converged", "evaluated"] : [])].includes(item.state)).map(item => item.plan.planHash));
  const expected = state.attempts.filter(item => live.has(item.started.planHash) && item.staged).map(item => item.attemptRef).sort();
  if (contentHash(expected) !== contentHash(checkpoint.drafts.map(item => item.attemptRef).sort())) throw upstreamRepairHostError("Checkpoint must retain every live staged envelope exactly once");
  const seen = new Set<string>();
  for (const draft of checkpoint.drafts) {
    const key = `${draft.store}:${draft.envelope.id}`;
    const started = records.find(record => record.hash === draft.attemptRef)?.payload;
    const staged = records.find(record => record.payload.kind === "attempt-staged" && record.payload.attemptRef === draft.attemptRef)?.payload;
    const validated = records.find(record => record.payload.kind === "attempt-validated" && record.payload.attemptRef === draft.attemptRef)?.payload;
    if (seen.has(key) || started?.kind !== "attempt-started" || started.planHash !== draft.planHash || started.proposalId !== draft.envelope.id || started.artifactId !== draft.envelope.payload.id
      || (started.artifactKind.endsWith("resolution") ? started.artifactKind : "annotation") !== draft.store
      || (draft.store === "annotation" && started.artifactKind !== draft.envelope.payload.annotationType)
      || draft.envelope.payload.sourceId !== sourceId || staged?.kind !== "attempt-staged" || staged.proposalHash !== contentHash(draft.envelope)
      || validated?.kind !== "attempt-validated" || validated.payloadHash !== contentHash(draft.envelope.payload)) throw upstreamRepairHostError("Checkpoint draft differs from its original validated staged envelope");
    seen.add(key);
  }
  const receiptBatches = new Set<string>();
  for (const receipt of checkpoint.activeReceipts) {
    const intent = receipt.identity.upstreamRepairIntent;
    const frozen = records.find(record => record.payload.kind === "finish-frozen" && record.payload.planHash === intent?.planHash)?.payload;
    const planned = records.find(record => record.payload.kind === "planned" && record.payload.plan.planHash === intent?.planHash)?.payload;
    if (!intent || receipt.identity.pipelineVersion !== COMPILER_PIPELINE_VERSION || receipt.identity.sourceId !== sourceId || frozen?.kind !== "finish-frozen" || contentHash(frozen.intent) !== contentHash(intent)
      || planned?.kind !== "planned" || planned.plan.batchId !== receipt.identity.batchId || receiptBatches.has(receipt.identity.batchId)) throw upstreamRepairHostError("Checkpoint active receipt lacks its exact original authorization");
    receiptBatches.add(receipt.identity.batchId);
    for (const proposal of intent.proposals) {
      const draft = checkpoint.drafts.find(item => item.attemptRef === proposal.attemptRef);
      if (!draft || (receipt.state === "completed" && draft.status !== "accepted")) throw upstreamRepairHostError("Checkpoint receipt is missing its original proposal envelope or completed acceptance");
    }
  }
  for (const draft of checkpoint.drafts) if (draft.status === "accepted" && !checkpoint.activeReceipts.some(receipt => receipt.identity.upstreamRepairIntent?.planHash === draft.planHash)) throw upstreamRepairHostError("Accepted checkpoint output requires its original active receipt");
}

/** Capture only existing envelopes; unresolved writes require ordinary local recovery first. */
export async function captureUpstreamRepairCheckpoint(root: string, sourceId: string): Promise<UpstreamRepairCheckpoint | undefined> {
  const state = await new UpstreamRepairLedger(root, sourceId).inspect();
  const drafts: Draft[] = [], activeReceipts = [];
  for (const current of state.plans.filter(item => ["staging", "finish-frozen", "finished", "converged", "evaluated"].includes(item.state))) {
    if (state.attempts.some(item => item.started.planHash === current.plan.planHash && !item.failed && !item.staged)) throw upstreamRepairHostError("Checkpoint has an unresolved reserved attempt; recover the original draft before capture");
    const receipt = await new CompilerFinishReceipts(root, sourceId, current.plan.batchId).read();
    if (receipt) { await new CompilerFinishReceipts(root, sourceId, current.plan.batchId).verify(receipt); activeReceipts.push(receipt); }
    for (const attempt of state.attempts.filter(item => item.started.planHash === current.plan.planHash && item.staged)) {
      if (!receipt) {
        const { recoverUpstreamRepairStage } = await import("./upstream-repair-staging.js");
        await recoverUpstreamRepairStage(root, sourceId, current.plan.planHash, attempt.attemptRef);
      }
      const store = attempt.started.artifactKind.endsWith("resolution") ? attempt.started.artifactKind as "entity-resolution" | "event-resolution" : "annotation";
      let status: "pending" | "accepted" = "pending", envelope;
      try { envelope = await storeFor(root, store).readProposal(sourceId, status, attempt.started.proposalId); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; status = "accepted"; envelope = await storeFor(root, store).readProposal(sourceId, status, attempt.started.proposalId); }
      drafts.push(draftSchema.parse({ planHash: current.plan.planHash, attemptRef: attempt.attemptRef, store, status, envelope }));
    }
  }
  if (!drafts.length && !activeReceipts.length) return undefined;
  const checkpoint = upstreamRepairCheckpointSchema.parse({ version: 1, drafts, activeReceipts });
  assertUpstreamRepairCheckpoint(checkpoint, state.records, sourceId);
  return checkpoint;
}

/** Must run before materialization writes; do not erase or regress local proposal history. */
export async function assertUpstreamRepairCheckpointRestorable(root: string, sourceId: string, input?: UpstreamRepairCheckpoint) {
  const checkpoint = input ?? { version: 1 as const, drafts: [], activeReceipts: [] };
  for (const store of ["annotation", "entity-resolution", "event-resolution"] as const) {
    const reader = storeFor(root, store);
    for (const pending of await reader.listProposals(sourceId, "pending")) {
      if (!checkpoint.drafts.some(item => item.store === store && item.envelope.id === pending.id)) throw upstreamRepairHostError("Checkpoint would discard an unrelated local pending proposal");
    }
    for (const draft of checkpoint.drafts.filter(item => item.store === store)) for (const status of ["pending", "accepted", "rejected"] as const) {
      let existing;
      try { existing = await reader.readProposal(sourceId, status, draft.envelope.id); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (status === "rejected" || (status === "accepted" && draft.status !== "accepted") || contentHash(existing) !== contentHash(draft.envelope)) throw upstreamRepairHostError("Checkpoint would rewrite or regress a retained proposal envelope");
    }
  }
}

/** Restore bytes and original status only; pending envelopes never mutate current artifacts. */
export async function restoreUpstreamRepairCheckpoint(root: string, sourceId: string, checkpoint: UpstreamRepairCheckpoint) {
  assertUpstreamRepairCheckpoint(checkpoint, await new UpstreamRepairLedger(root, sourceId).history(), sourceId);
  await assertUpstreamRepairCheckpointRestorable(root, sourceId, checkpoint);
  for (const draft of checkpoint.drafts.filter(item => item.status === "accepted")) {
    const current = (await storeFor(root, draft.store).list(sourceId)).find(item => item.id === draft.envelope.payload.id);
    if (!current || contentHash(current) !== contentHash(draft.envelope.payload)) throw upstreamRepairHostError("Restore accepted envelopes only after their verified current snapshot is materialized");
  }
  for (const draft of checkpoint.drafts) {
    const reader = storeFor(root, draft.store);
    try { await reader.readProposal(sourceId, "accepted", draft.envelope.id); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (draft.store === "annotation") await new SourceAnnotationStore(root).stage(sourceId, draft.envelope);
    else if (draft.store === "entity-resolution") await new EntityResolutionStore(root).stage(sourceId, draft.envelope);
    else await new EventResolutionStore(root).stage(sourceId, draft.envelope);
    if (draft.status === "accepted") await reader.commitProposals(sourceId, [draft.envelope.id]);
  }
  for (const receipt of checkpoint.activeReceipts) await CompilerFinishReceipts.restoreActiveUpstreamFinish(root, sourceId, receipt);
}

/** Validate incoming active revisions and field/evidence authority before any materialization write. */
export async function assertUpstreamRepairCheckpointState(checkpoint: UpstreamRepairCheckpoint, journal: readonly UpstreamRepairRecord[], sourceId: string, sourceSha256: string, bytes: Buffer, payloads: Map<string, unknown>) {
  assertUpstreamRepairCheckpoint(checkpoint, journal, sourceId);
  const state = inspectUpstreamRepairJournal(journal), actual = new Map([...payloads].map(([key, value]) => [key, contentHash(value)]));
  const { checkUpstreamRepairMutation } = await import("./upstream-repair-staging.js");
  const segments = [...payloads].filter(([key]) => key.startsWith("source-segment:")).map(([, value]) => contentHash(value)).sort();
  for (const receipt of checkpoint.activeReceipts) if (contentHash(receipt.identity.segments.map(segment => contentHash(segment)).sort()) !== contentHash(segments)) throw upstreamRepairHostError("Checkpoint receipt source segment layout changed");
  for (const current of state.plans.filter(item => ["staging", "finish-frozen", "finished", "converged", "evaluated"].includes(item.state))) {
    const plan = current.plan, original = new Map(payloads);
    if (plan.sourceScope.sourceSha256 !== sourceSha256) throw upstreamRepairHostError("Checkpoint immutable source revision changed");
    const drafts = checkpoint.drafts.filter(item => item.planHash === plan.planHash);
    const receipt = checkpoint.activeReceipts.find(item => item.identity.upstreamRepairIntent?.planHash === plan.planHash);
    const outputs = new Map(drafts.map(item => [`${item.store === "annotation" ? item.envelope.payload.annotationType : item.store}:${item.envelope.payload.id}`, item.envelope.payload]));
    for (const ref of plan.baselineRefs) {
      const key = `${ref.kind}:${ref.id}`, output = outputs.get(key);
      if (actual.get(key) !== ref.revisionHash && (!receipt || !output || actual.get(key) !== contentHash(output))) throw upstreamRepairHostError(`Checkpoint active baseline changed: ${key}`);
    }
    for (const ref of current.finishIntent?.baselines ?? []) original.set(`${ref.kind}:${ref.id}`, ref.payload);
    for (const ref of plan.allowedCreations) {
      const key = `${ref.kind}:${ref.id}`, output = outputs.get(key);
      if (actual.has(key) && (!receipt || !output || actual.get(key) !== contentHash(output))) throw upstreamRepairHostError(`Checkpoint creation conflicts with active artifact: ${key}`);
      original.delete(key);
    }
    for (const draft of drafts) {
      const kind = draft.store === "annotation" ? draft.envelope.payload.annotationType : draft.store;
      if ((draft.status === "accepted" || receipt?.state === "completed") && actual.get(`${kind}:${draft.envelope.payload.id}`) !== contentHash(draft.envelope.payload)) throw upstreamRepairHostError("Checkpoint accepted proposal differs from its active artifact");
      checkUpstreamRepairMutation({ plan, bytes, payloads: original, activeRevisions: new Map([...original].map(([key, value]) => [key, contentHash(value)])) }, kind, draft.envelope.payload.id, draft.envelope.payload, outputs);
    }
  }
}
