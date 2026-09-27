import { z } from "zod";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";
import { canonicalJson, contentHash } from "../world/canonical.js";
import { CanonicalModelStore } from "../world/canonical-model.js";
import { idSchema } from "../world/model.js";
import {
  CompilerProposalObligations,
  sourcePatternDependencyCorrectionSchema,
  type SourcePatternDependencyCorrection,
} from "./proposal-obligations.js";
import { createCompilerProposalToolset } from "./proposal-tools.js";
import { compilerProposalSchemas, type CompilerProposalKind } from "./proposals.js";
import { readAccountingBatchSegments } from "./accounting-review.js";
import { segmentEvidenceRef } from "./segments.js";
import {
  jsonPointerExists,
  modelEvidenceSelectorsSchema,
  resolveTextAnchor,
} from "./text-anchors.js";
import { UpstreamRepairLedger } from "./upstream-repair-ledger.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const supportedToolSchema = z.enum([
  "propose_action_schema",
  "propose_action_constraint",
  "propose_norm_template",
  "propose_process_template",
]);
const sourcePatternInputSchema = z.object({
  proposal_id: idSchema,
  payload: z.object({
    id: idSchema,
    induction: z.object({
      kind: z.literal("source-pattern"),
      supportingEventIds: z.array(idSchema).min(1).max(64),
    }).strict(),
  }).passthrough(),
  evidence_segment_ids: z.array(idSchema).min(1).max(16),
  evidence_selectors: modelEvidenceSelectorsSchema.optional(),
}).strict();
export const sourcePatternObligationReviewSchema = z.object({
  version: z.literal(1),
  sourceId: idSchema,
  batchId: idSchema,
  tool: supportedToolSchema,
  proposalId: idSchema,
  failedInputHashes: z.array(sha256Schema).min(2),
  upstreamPlanHash: sha256Schema,
  upstreamReceiptFingerprint: sha256Schema,
  reason: z.string().trim().min(1),
  auditRef: z.string().trim().min(1),
  input: sourcePatternInputSchema,
}).strict();
export type SourcePatternObligationReview = z.infer<typeof sourcePatternObligationReviewSchema>;

const toolKinds: Record<z.infer<typeof supportedToolSchema>, CompilerProposalKind> = {
  propose_action_schema: "action-schema",
  propose_action_constraint: "action-constraint",
  propose_norm_template: "norm-template",
  propose_process_template: "process-template",
};

export type SourcePatternObligationPreview = {
  status: "verified-preview";
  executableCertification: false;
  binding: SourcePatternDependencyCorrection;
  batchSegmentIds: string[];
  evidencePreview: Array<{
    segmentId: string;
    targetPath: string;
    exactHash: string;
    startByte: number;
    endByte: number;
  }>;
  upstreamEvidence: Array<{
    canonicalEventId: string;
    segmentIds: string[];
    trigger: { startByte: number; endByte: number; exactHash: string };
    extents: Array<{ startByte: number; endByte: number; exactHash: string }>;
  }>;
};
export type SourcePatternObligationResult = SourcePatternObligationPreview | (Omit<SourcePatternObligationPreview, "status"> & {
  status: "staged";
  proposal: unknown;
});

export async function reviewSourcePatternObligation(
  root: string,
  raw: unknown,
  apply = false,
): Promise<SourcePatternObligationResult> {
  const review = sourcePatternObligationReviewSchema.parse(raw);
  if (!apply) return buildSourcePatternObligationPreview(root, review);
  return withWorkspaceOperationLock(root, "compiler", async () => {
    const preview = await buildSourcePatternObligationPreview(root, review);
    const toolset = createCompilerProposalToolset(root, {}, { hostObligationCorrection: true });
    await toolset.beginBatch(preview.batchSegmentIds, review.batchId, review.sourceId);
    const tool = toolset.tools.find(candidate => candidate.name === review.tool);
    if (!tool) throw new Error(`Host dependency correction tool ${review.tool} is unavailable.`);
    const journal = new CompilerProposalObligations(root, review.sourceId, review.batchId);
    const proposal = await journal.withHostSourcePatternDependencyCorrection(
      review.tool,
      review.input,
      preview.binding,
      review.reason,
      review.auditRef,
      async () => {
        const prepared = tool.prepareArguments ? await tool.prepareArguments(review.input) : review.input;
        return tool.execute("host-source-pattern-dependency-correction", prepared as never, undefined, undefined, {} as never);
      },
    );
    return { ...preview, status: "staged", proposal };
  });
}

async function buildSourcePatternObligationPreview(
  root: string,
  review: SourcePatternObligationReview,
): Promise<SourcePatternObligationPreview> {
  const identity = CompilerProposalObligations.identity(review.tool, review.input);
  if (identity.proposalId !== review.proposalId || review.input.payload.id !== review.proposalId) {
    throw new Error("Host dependency review must retain the exact failed proposal and logical payload ID.");
  }
  const journal = new CompilerProposalObligations(root, review.sourceId, review.batchId);
  const failed = [...new Map(journal.history(review.tool, review.proposalId)
    .filter(attempt => attempt.status === "failed")
    .map(attempt => [attempt.inputHash, attempt])).values()];
  const originalAttempt = failed.find(attempt => sourcePatternInputSchema.safeParse(attempt.input).success);
  const original = sourcePatternInputSchema.safeParse(originalAttempt?.input);
  if (!original.success || !originalAttempt) throw new Error("The failed identity has no original source-pattern input to preserve.");
  const originalEvents = [...new Set(original.data.payload.induction.supportingEventIds)].sort();
  const correctedEvents = [...new Set(review.input.payload.induction.supportingEventIds)].sort();
  const addedEventIds = correctedEvents.filter(id => !originalEvents.includes(id));
  if (!addedEventIds.length) throw new Error("Host dependency correction must add a reviewed canonical event.");

  const state = await new UpstreamRepairLedger(root, review.sourceId).inspect();
  const current = state.plans.find(item => item.plan.planHash === review.upstreamPlanHash);
  const convergence = state.records.find(record => record.payload.kind === "converged"
    && record.payload.planHash === review.upstreamPlanHash);
  if (!current || !["converged", "evaluated"].includes(current.state)
    || current.finishedReceipt !== review.upstreamReceiptFingerprint
    || convergence?.payload.kind !== "converged"
    || convergence.payload.receiptFingerprint !== review.upstreamReceiptFingerprint) {
    throw new Error("Host dependency review requires the exact completed and converged upstream plan and receipt.");
  }
  const authority = current.plan.proposalObligation;
  if (!authority || authority.sourceId !== review.sourceId || authority.batchId !== review.batchId
    || authority.tool !== review.tool || authority.proposalId !== review.proposalId
    || authority.originalInputHash !== originalAttempt.inputHash
    || contentHash([...authority.failedInputHashes].sort()) !== contentHash([...review.failedInputHashes].sort())
    || contentHash([...authority.originalSupportingEventIds].sort()) !== contentHash(originalEvents)
    || contentHash([...authority.originalEvidenceSegmentIds].sort()) !== contentHash([...original.data.evidence_segment_ids].sort())) {
    throw new Error("Selected upstream repair is not bound to this exact durable proposal obligation.");
  }
  const reviewedEventIds = (current.plan.semanticEventCreations ?? []).map(item => item.canonicalEventId).sort();
  if (contentHash(addedEventIds) !== contentHash(reviewedEventIds)) {
    throw new Error("Host dependency correction must add every and only the selected upstream plan's canonical events.");
  }
  const canonical = new CanonicalModelStore(root);
  const addedDependencies: SourcePatternDependencyCorrection["addedDependencies"] = [];
  for (const eventId of correctedEvents) {
    const event = await canonical.getEvent(eventId);
    if (!event) throw new Error(`Corrected source pattern references unknown canonical event ${eventId}.`);
    if (!addedEventIds.includes(eventId)) continue;
    const semantic = current.plan.semanticEventCreations?.find(item => item.canonicalEventId === eventId);
    const active = convergence.payload.activeRevisions.find(item => item.kind === "canonical-event" && item.id === eventId);
    const revisionHash = contentHash(event);
    if (!semantic || active?.revisionHash !== revisionHash) {
      throw new Error(`Added canonical event ${eventId} is not the active output of the selected upstream repair.`);
    }
    addedDependencies.push({ kind: "canonical-event", id: eventId, revisionHash });
  }

  const batchSegments = await readAccountingBatchSegments(root, review.sourceId, review.batchId);
  const batchSegmentIds = batchSegments.map(segment => segment.id).sort();
  const inputSegmentIds = [...review.input.evidence_segment_ids].sort();
  if (canonicalJson(inputSegmentIds) !== canonicalJson([...original.data.evidence_segment_ids].sort())
    || inputSegmentIds.some(id => !batchSegmentIds.includes(id))) {
    throw new Error("Host dependency correction cannot widen or replace the original batch citation scope.");
  }
  const selectedSegments = review.input.evidence_segment_ids.map(id => batchSegments.find(segment => segment.id === id)!);
  compilerProposalSchemas[toolKinds[review.tool]].parse({
    ...review.input.payload,
    evidence: selectedSegments.map(segmentEvidenceRef),
  });
  const byId = new Map(selectedSegments.map(segment => [segment.id, segment]));
  const evidencePreview = [];
  for (const selector of review.input.evidence_selectors ?? []) {
    const segment = byId.get(selector.segment_id);
    if (!segment || !jsonPointerExists(review.input.payload, selector.target_path)) {
      throw new Error(`Host dependency correction has an invalid evidence selector for ${selector.target_path}.`);
    }
    const anchor = await resolveTextAnchor(root, segment, selector);
    evidencePreview.push({
      segmentId: segment.id,
      targetPath: selector.target_path,
      exactHash: anchor.exactHash,
      startByte: anchor.startByte,
      endByte: anchor.endByte,
    });
  }
  const binding = sourcePatternDependencyCorrectionSchema.parse({
    version: 1,
    sourceId: review.sourceId,
    batchId: review.batchId,
    tool: review.tool,
    proposalId: review.proposalId,
    inputHash: identity.inputHash,
    failedInputHashes: [...review.failedInputHashes].sort(),
    upstreamPlanHash: review.upstreamPlanHash,
    upstreamAuthorizationRef: current.plan.authorizationRef,
    receiptFingerprint: review.upstreamReceiptFingerprint,
    convergenceRef: convergence.hash,
    originalSupportingEventIds: originalEvents,
    correctedSupportingEventIds: correctedEvents,
    addedDependencies,
  });
  await journal.withHostSourcePatternDependencyCorrection(
    review.tool,
    review.input,
    binding,
    review.reason,
    review.auditRef,
    async () => undefined,
  );
  return {
    status: "verified-preview",
    executableCertification: false,
    binding,
    batchSegmentIds,
    evidencePreview,
    upstreamEvidence: (current.plan.semanticEventCreations ?? [])
      .filter(item => addedEventIds.includes(item.canonicalEventId))
      .map(item => ({
        canonicalEventId: item.canonicalEventId,
        segmentIds: current.plan.citableEvidenceRefs,
        trigger: {
          startByte: item.triggerAnchor.startByte,
          endByte: item.triggerAnchor.endByte,
          exactHash: item.triggerAnchor.exactHash,
        },
        extents: item.extentAnchors.map(anchor => ({
          startByte: anchor.startByte,
          endByte: anchor.endByte,
          exactHash: anchor.exactHash,
        })),
      })),
  };
}
