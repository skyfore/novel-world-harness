import { contentHash } from "../world/canonical.js";
import { annotationAnchors, type SourceAnnotation } from "./annotations.js";
import { prerequisiteStop, type PrerequisiteRecord } from "./role-source-prerequisites.js";
import { representationBatchId, representationRequirementId, representationSemanticHash, representationCatalogHash,
  representationReferences, representationIsReady, validateRepresentationHistory, assertRepresentationReferenceTypes, type RepresentationRecord } from "./source-representation.js";
import { freezeUpstreamRepairPlan, type UpstreamRepairPlan } from "./upstream-repair-plan.js";
import type { SourceSegment } from "./segments.js";
import type { LedgerRecord } from "./requirement-ledger.js";
import { requirementResultSchema } from "./requirement-result.js";

export function representationRecordsFromJournal(journal: LedgerRecord[], taskId: string) {
  return {
    prerequisites: journal.flatMap(r => r.payload.kind === "role-source-prerequisite" && r.payload.record.taskId === taskId ? [r.payload.record] : []),
    records: journal.flatMap(r => r.payload.kind === "source-representation" && r.payload.record.scope.taskId === taskId ? [r.payload.record] : []),
  };
}

/** Only an exact Pi proposal plus independent check can reach the ordinary upstream authorization ledger. */
export function buildRepresentationRepairPlan(prerequisites: PrerequisiteRecord[], records: RepresentationRecord[],
  annotations: SourceAnnotation[], segments: SourceSegment[]): UpstreamRepairPlan {
  validateRepresentationHistory(prerequisites, records);
  if (!representationIsReady(records)) throw prerequisiteStop("Representation review retains a missing condition; no upstream authority exists");
  const record = records[0]!, output = record.output;
  if (output.phase !== "representation-plan") throw prerequisiteStop("Missing original representation proposal");
  assertRepresentationReferenceTypes(output, annotations);
  if (representationCatalogHash(annotations) !== output.catalogHash) throw prerequisiteStop("Source annotation catalog changed after exact-scope review");
  const scope = record.scope, source = scope.prerequisiteScope, batchId = representationBatchId(scope.taskId);
  const created = output.annotations.map(a => a.payload), all = [...annotations, ...created];
  const selected = output.readableAnnotationIds.map(id => {
    const a = annotations.find(a => a.id === id);
    if (!a) throw prerequisiteStop("Reviewed readable annotation is absent");
    return a;
  });
  const anchors = [...created.flatMap(annotationAnchors), ...selected.flatMap(annotationAnchors), ...records.flatMap(r => r.evidence.map(e => e.anchor))];
  const segmentIds = [...new Set(anchors.map(a => {
    const segment = segments.find(s => s.startByte <= a.startByte && s.endByte >= a.endByte);
    if (!segment || segment.sourceId !== source.sourceId) throw prerequisiteStop("Reviewed source anchor escapes immutable segments");
    return segment.id;
  }))].sort();
  const selectedSegments = segmentIds.map(id => segments.find(s => s.id === id)!);
  const baselineRefs = [...selected.map(a => ({ kind: a.annotationType, id: a.id, revisionHash: contentHash(a) })),
    ...selectedSegments.map(s => ({ kind: "source-segment" as const, id: s.id, revisionHash: contentHash(s) }))];
  const deps = (questionId: string) => {
    const q = output.coverage.find(q => q.questionId === questionId)!;
    return [...new Set(q.criteria.flatMap(c => [...c.annotationIds,
      ...c.boundaryIndexes.flatMap(i => [...output.boundaries[i]!.fromAnnotationIds, ...output.boundaries[i]!.toAnnotationIds])]))];
  };
  const requirements = output.coverage.map(q => representationRequirementId(q.questionId));
  const dependencyEdges: UpstreamRepairPlan["dependencyEdges"] = [];
  for (const q of output.coverage) for (const id of deps(q.questionId)) {
    const a = all.find(a => a.id === id)!;
    dependencyEdges.push({ from: `requirement:${representationRequirementId(q.questionId)}`, to: `${a.annotationType}:${id}`, purpose: "requirement" });
  }
  for (const a of created) {
    for (const id of representationReferences(a)) {
      const ref = all.find(a => a.id === id)!;
      dependencyEdges.push({ from: `${a.annotationType}:${a.id}`, to: `${ref.annotationType}:${id}`, purpose: "identity" });
    }
    for (const id of new Set(annotationAnchors(a).map(anchor => selectedSegments.find(s => s.startByte <= anchor.startByte && s.endByte >= anchor.endByte)!.id))) {
      dependencyEdges.push({ from: `${a.annotationType}:${a.id}`, to: `source-segment:${id}`, purpose: "source-evidence" });
    }
  }
  return freezeUpstreamRepairPlan({ version: 1, planId: batchId, batchId,
    requirementSetHash: contentHash({ scope, specification: prerequisites[0]!.output }), requirementIds: requirements,
    sourceRepresentation: { taskId: scope.taskId, planRecordHash: contentHash(record), checkRecordHash: contentHash(records[1]),
      semanticSlots: created.map(a => ({ id: a.id, payloadHash: representationSemanticHash(a) })) },
    predecessorReceiptRefs: [], sourceScope: { sourceId: source.sourceId, sourceSha256: source.sourceHash, segmentIds },
    baselineRefs, readableRefs: baselineRefs.map(({ revisionHash: _, ...ref }) => ref), allowedWrites: [],
    allowedCreations: created.map(a => ({ kind: a.annotationType, id: a.id, maxCount: 1,
      dependencyOf: representationRequirementId(output.coverage.find(q => deps(q.questionId).includes(a.id))!.questionId) })),
    citableEvidenceRefs: segmentIds, dependencyEdges, postconditionIds: requirements,
    authorizationRef: scope.authorizationRef, retryBudgetRef: `${batchId}-budget`,
  });
}

/** Frozen definition binding is shared by candidate loading and live evaluation.
 * Loading a historical plan must not require its postconditions to be current. */
export function representationRequirementDefinition(journal: LedgerRecord[], plan: UpstreamRepairPlan) {
  const authority = plan.sourceRepresentation;
  if (!authority) throw prerequisiteStop("Missing representation authority");
  const { prerequisites, records } = representationRecordsFromJournal(journal, authority.taskId);
  validateRepresentationHistory(prerequisites, records);
  if (!representationIsReady(records) || contentHash(records[0]) !== authority.planRecordHash || contentHash(records[1]) !== authority.checkRecordHash) throw prerequisiteStop("Representation evaluation lacks its exact independent review");
  const output = records[0]!.output;
  if (output.phase !== "representation-plan") throw prerequisiteStop("Missing representation output");
  const source = records[0]!.scope.prerequisiteScope;
  if (source.sourceId !== plan.sourceScope.sourceId || source.sourceHash !== plan.sourceScope.sourceSha256)
    throw prerequisiteStop("Representation requirement source scope drifted");
  if (contentHash(authority.semanticSlots) !== contentHash(output.annotations.map(a => ({ id: a.payload.id, payloadHash: representationSemanticHash(a.payload) })))
    || contentHash(plan.allowedCreations.map(c => [c.kind, c.id]).sort()) !== contentHash(output.annotations.map(a => [a.payload.annotationType, a.payload.id]).sort())) throw prerequisiteStop("Representation evaluation changed its exact reviewed mutation inventory");
  const expectedHash = contentHash({ scope: records[0]!.scope, specification: prerequisites[0]!.output });
  if (expectedHash !== plan.requirementSetHash || contentHash(plan.requirementIds.slice().sort()) !== contentHash(output.coverage.map(q => representationRequirementId(q.questionId)).sort())) throw prerequisiteStop("Representation requirement scope drifted");
  return output;
}

export function representationRequirementResult(journal: LedgerRecord[], annotations: SourceAnnotation[], plan: UpstreamRepairPlan) {
  const output = representationRequirementDefinition(journal, plan);
  const bad = output.annotations.filter(({ payload }) => {
    const active = annotations.find(a => a.id === payload.id);
    return !active || representationSemanticHash(active) !== representationSemanticHash(payload);
  }).map(a => a.payload.id);
  for (const ref of plan.baselineRefs.filter(r => r.kind !== "source-segment")) {
    if (contentHash(annotations.find(a => a.id === ref.id) ?? null) !== ref.revisionHash) bad.push(ref.id);
  }
  return requirementResultSchema.parse({ setId: representationBatchId(plan.sourceRepresentation!.taskId), revisionHash: plan.requirementSetHash,
    catalogHash: contentHash(annotations), evaluatorVersion: "source-representation-only/v1",
    requirements: output.coverage.map(q => ({ id: representationRequirementId(q.questionId), definitionHash: contentHash(q),
      state: bad.length ? "blocked" : "satisfied", blockedBy: bad,
      diagnostics: bad.length ? ["SOURCE_REPRESENTATION_MISSING_OR_CHANGED"] : [],
    })) }); // Only representation preservation; original role-question dispositions are never settled here.
}
