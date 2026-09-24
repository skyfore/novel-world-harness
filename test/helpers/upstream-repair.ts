import { registerSourceRequirements } from "../../src/compiler/requirement-service.js";
import { planUpstreamRepair } from "../../src/compiler/upstream-repair-planner.js";
import { UpstreamRepairLedger } from "../../src/compiler/upstream-repair-ledger.js";
import { stageUpstreamRepair } from "../../src/compiler/upstream-repair-staging.js";
import { prepareUpstreamRepairFinish, executeUpstreamRepairFinish } from "../../src/compiler/upstream-repair-finish.js";
import { textAnchorForByteRange } from "../../src/compiler/text-anchors.js";
import type { CanonicalEvent } from "../../src/world/model.js";
import type { UpstreamRepairKind } from "../../src/compiler/upstream-repair-plan.js";

/** Real host review, authorization, narrow proposal and durable finish; no mocked gates. */
export async function repairForEvent(input: {
  root: string; sourceId: string; sourceSha256: string; segmentId: string; bytes: Buffer; event: CanonicalEvent;
  diagnostic: Record<string, unknown>; proposal: (slot: { kind: UpstreamRepairKind; id: string }) => unknown;
}) {
  const { root, sourceId, sourceSha256, segmentId, bytes, event } = input;
  const definition = await registerSourceRequirements(root, { sourceId, id: "repair-acceptance", scopeDecisionRef: "original-source-review",
    spec: { version: 1, sourceId, sourceSha256, review: { method: "independent-source-review", reviewer: "fixture-author", reviewedAt: "2026-09-22T00:00:00Z", auditRef: "independent-scene-expectation" },
      cases: [{ id: "occurrence", kind: "event-effects", scene: event.title, eventId: event.id, rationale: "Retain the original scene obligation throughout upstream repair",
        evidence: [textAnchorForByteRange(sourceId, bytes, 0, bytes.length)], requiresMechanism: false, expectation: { kind: "delta", delta: event.observedOutcome } }] } });
  const requirementId = "occurrence:state-effect";
  const { plan } = await planUpstreamRepair(root, { version: 1, sourceId, sourceSha256, requirementSetHash: definition.revisionHash,
    requirementIds: [requirementId], planId: "acceptance-repair", batchId: "acceptance-repair", predecessorReceiptRefs: [],
    segmentIds: [segmentId], citableEvidenceRefs: [segmentId], authorizationRef: "original-source-review", retryBudgetRef: "acceptance-budget",
    diagnostics: [{ ...input.diagnostic, requirementId }] });
  if (!plan) throw new Error("Acceptance repair policy missing");
  const ledger = new UpstreamRepairLedger(root, sourceId);
  await ledger.register(plan); await ledger.authorize(plan.planHash);
  const slot = [...plan.allowedWrites, ...plan.allowedCreations][0]!;
  await stageUpstreamRepair(root, sourceId, plan.planHash, slot, input.proposal(slot));
  await prepareUpstreamRepairFinish(root, sourceId, plan.planHash, { outcome: "complete", reviewed_segments: [{ segment_id: segmentId, disposition: "proposed", summary: "Source dependency reviewed" }], summary: "Repair before semantic acquisition compilation" });
  await executeUpstreamRepairFinish(root, sourceId, plan.planHash);
  await ledger.recordConverged(plan.planHash);
  return plan;
}
