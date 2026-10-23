import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { sourceAnnotationSchema, annotationAnchors, type SourceAnnotation } from "./annotations.js";
import { textAnchorForByteRange, modelTextSelectorSchema } from "./text-anchors.js";
import { prerequisiteNextStep, prerequisiteTaskId, prerequisiteStop, prerequisiteScopeSchema, prerequisiteEvidenceSchema,
  type PrerequisiteRecord } from "./role-source-prerequisites.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().trim().min(1).max(6000);
const evidence = z.array(modelTextSelectorSchema).min(1).max(24);
export const representationScopeSchema = z.object({
  version: z.literal(1), taskId: hash, prerequisiteScope: prerequisiteScopeSchema,
  prerequisiteRecordHashes: z.array(hash).length(4), authorizationRef: text,
}).strict();
export type RepresentationScope = z.infer<typeof representationScopeSchema>;
export const representationPhases = ["representation-plan", "representation-check"] as const;
export const representationBatchId = (taskId: string) => `source-representation-${taskId}`;
export const representationSlotId = (taskId: string, slot: number) => `sr-${taskId.slice(0, 32)}-${slot}`;
export const representationRequirementId = (questionId: string) => `source-representation-${questionId}`;
export function representationSemanticHash(annotation: SourceAnnotation) {
  const { derivation: _, ...semantic } = annotation;
  return contentHash(semantic);
}
export const representationPlanSchema = z.object({
  phase: z.literal("representation-plan"), scopeHash: hash, catalogHash: hash,
  // All IDs are host-allocated. Proposals can only create source observations.
  annotations: z.array(z.object({ slot: z.number().int().min(1).max(48), payload: sourceAnnotationSchema }).strict()).max(48),
  readableAnnotationIds: z.array(text).max(128),
  boundaries: z.array(z.object({
    questionId: hash, kind: z.enum(["identity", "event-correspondence", "voice-attribution", "claim-truth"]),
    status: z.literal("unresolved"), fromAnnotationIds: z.array(text).min(1).max(16), toAnnotationIds: z.array(text).max(16),
    rationale: text, evidence,
  }).strict()).max(96),
  coverage: z.array(z.object({ questionId: hash, impact: z.literal("critical"), originalStatus: z.literal("blocked"),
    criteria: z.array(z.object({ index: z.number().int().nonnegative(), status: z.enum(["represented", "gap"]),
      annotationIds: z.array(text).max(48), boundaryIndexes: z.array(z.number().int().nonnegative()).max(96), rationale: text,
    }).strict()).min(1).max(12), evidence,
  }).strict()).min(1).max(16),
}).strict();
export const representationCheckSchema = z.object({
  phase: z.literal("representation-check"), scopeHash: hash, proposalHash: hash,
  judgments: z.array(z.object({ questionId: hash, verdict: z.enum(["supported", "blocked"]), rationale: text, evidence }).strict()).min(1).max(16),
}).strict();
export const representationOutputSchema = z.union([representationPlanSchema, representationCheckSchema]);
export type RepresentationOutput = z.infer<typeof representationOutputSchema>;
export type RepresentationPlan = z.infer<typeof representationPlanSchema>;
export const representationRecordSchema = z.object({
  scope: representationScopeSchema, phase: z.enum(representationPhases), inputHash: hash, output: representationOutputSchema,
  evidence: z.array(prerequisiteEvidenceSchema).min(1).max(384),
  traceRunId: text, sessionId: text, provider: z.literal("openai-codex"), model: z.literal("gpt-6.1-sol"), subscription: z.literal(true),
  predecessorRecordHash: hash.nullable(),
}).strict();
export type RepresentationRecord = z.infer<typeof representationRecordSchema>;
export const representationAuthoritySchema = z.object({ taskId: hash, planRecordHash: hash, checkRecordHash: hash }).strict();
export type RepresentationAuthority = z.infer<typeof representationAuthoritySchema>;
export const representationCatalogHash = (annotations: SourceAnnotation[]) => contentHash(annotations.slice().sort((a, b) => a.id.localeCompare(b.id)));
export function representationSelectors(output: RepresentationOutput) {
  return output.phase === "representation-plan" ? [...output.boundaries, ...output.coverage].flatMap(i => i.evidence) : output.judgments.flatMap(i => i.evidence);
}
export function representationReferences(a: SourceAnnotation): string[] {
  if (a.annotationType === "discourse-segment") return a.viewpointMentionId ? [a.viewpointMentionId] : [];
  return [...(a.sceneId ? [a.sceneId] : []), ...(a.annotationType === "quotation" ? [a.speakerMentionId, ...a.addresseeMentionIds].filter((v): v is string => !!v)
    : a.annotationType === "event-mention" ? [...a.participantMentionIds, ...(a.discourseSegmentId ? [a.discourseSegmentId] : [])] : [])];
}
function sameIds(actual: string[], expected: string[]) {
  return new Set(actual).size === actual.length && contentHash([...actual].sort()) === contentHash([...expected].sort());
}
export function validateRepresentationHistory(prerequisites: PrerequisiteRecord[], records: RepresentationRecord[]) {
  if (prerequisiteNextStep(prerequisites) !== "host-authorization-review" || prerequisites.length !== 4) throw prerequisiteStop("Representation planning requires four accepted original prerequisite stages");
  const binding = prerequisites[2]!.output;
  if (binding.phase !== "binding" || binding.bindings.some(b => b.route !== "missing-source-representation")) throw prerequisiteStop("This source-only entry requires reviewed missing-source-representation dependencies");
  for (const [i, r] of records.entries()) {
    representationRecordSchema.parse(r);
    if (i >= 2 || r.phase !== representationPhases[i] || r.output.phase !== r.phase
      || r.scope.taskId !== prerequisiteTaskId(prerequisites[0]!.scope)
      || contentHash(r.scope.prerequisiteScope) !== contentHash(prerequisites[0]!.scope)
      || contentHash(r.scope.prerequisiteRecordHashes) !== contentHash(prerequisites.map(contentHash))
      || r.output.scopeHash !== contentHash(r.scope) || (i && contentHash(r.scope) !== contentHash(records[0]!.scope))
      || r.predecessorRecordHash !== (i ? contentHash(records[i - 1]) : null)) throw prerequisiteStop("Representation phase changed original identity, scope or prerequisite history");
    if ([...prerequisites, ...records.slice(0, i)].some(p => p.sessionId === r.sessionId || p.traceRunId === r.traceRunId)) throw prerequisiteStop("Representation stages must use fresh independent Pi sessions");
    const items = r.output.phase === "representation-plan" ? r.output.coverage : r.output.judgments;
    if (!sameIds(items.map(v => v.questionId), r.scope.prerequisiteScope.questions.map(v => v.questionId))) throw prerequisiteStop("Representation review changed the original question denominator");
    if (r.output.phase === "representation-check" && r.output.proposalHash !== contentHash(records[0]!.output)) throw prerequisiteStop("Representation check changed its exact proposal");
    if (contentHash(r.evidence.map(e => e.selector)) !== contentHash(representationSelectors(r.output))
      || r.evidence.some(e => e.anchor.sourceId !== r.scope.prerequisiteScope.sourceId)) throw prerequisiteStop("Representation source evidence receipt is incomplete");
  }
  const output = records[0]?.output, spec = prerequisites[0]!.output;
  if (output?.phase !== "representation-plan" || spec.phase !== "specification") return;
  const ids = output.annotations.map(a => a.payload.id), allIds = [...ids, ...output.readableAnnotationIds];
  if (new Set(allIds).size !== allIds.length || new Set(output.annotations.map(a => a.slot)).size !== ids.length) throw prerequisiteStop("Duplicate representation slot or reused existing ID");
  for (const { slot, payload: a } of output.annotations) {
    if (a.id !== representationSlotId(records[0]!.scope.taskId, slot) || a.sourceId !== records[0]!.scope.prerequisiteScope.sourceId
      || a.derivation.compilerBatchId !== representationBatchId(records[0]!.scope.taskId)
      || a.derivation.runId !== representationBatchId(records[0]!.scope.taskId)
      || a.derivation.provider !== "openai-codex" || a.derivation.model !== "gpt-6.1-sol"
      || representationReferences(a).some(id => !allIds.includes(id))) throw prerequisiteStop("Annotation escapes its host-allocated source-only scope");
  }
  for (const b of output.boundaries) if (!output.coverage.some(q => q.questionId === b.questionId)
    || [...b.fromAnnotationIds, ...b.toAnnotationIds].some(id => !allIds.includes(id))) throw prerequisiteStop("Unresolved boundary lacks exact typed endpoints");
  for (const q of output.coverage) {
    const requirement = spec.requirements.find(r => r.questionId === q.questionId)!;
    if (!sameIds(q.criteria.map(c => String(c.index)), requirement.acceptanceCriteria.map((_, i) => String(i)))) throw prerequisiteStop("Representation coverage omitted an independent acceptance criterion");
    for (const c of q.criteria) if (c.annotationIds.some(id => !allIds.includes(id))
      || c.boundaryIndexes.some(i => output.boundaries[i]?.questionId !== q.questionId)
      || (c.status === "represented" && !c.annotationIds.length && !c.boundaryIndexes.length)) throw prerequisiteStop("Criterion lacks an exact annotation or unresolved-boundary dependency");
  }
  if (ids.some(id => !output.coverage.some(q => q.criteria.some(c => c.annotationIds.includes(id)
    || c.boundaryIndexes.some(i => [...output.boundaries[i]!.fromAnnotationIds, ...output.boundaries[i]!.toAnnotationIds].includes(id)))))) throw prerequisiteStop("Creation has no independent requirement dependency");
}
export function representationIsReady(records: RepresentationRecord[]) {
  const p = records[0]?.output, c = records[1]?.output;
  return records.length === 2 && p?.phase === "representation-plan" && p.annotations.length > 0
    && p.coverage.every(q => q.criteria.every(c => c.status === "represented"))
    && c?.phase === "representation-check" && c.judgments.every(j => j.verdict === "supported");
}
export function assertRepresentationAnchors(output: RepresentationOutput, sourceId: string, bytes: Uint8Array) {
  if (output.phase !== "representation-plan") return;
  for (const { payload } of output.annotations) {
    const ordered = payload.annotationType === "discourse-segment" ? payload.anchors : payload.annotationType === "event-mention" ? payload.extentAnchors : [];
    if (contentHash(ordered) !== contentHash(ordered.slice().sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte))) throw prerequisiteStop("Representation extent anchors must use the existing proposal tool's source order");
    for (const a of annotationAnchors(payload)) {
      if (a.sourceId !== sourceId || contentHash(a) !== contentHash(textAnchorForByteRange(sourceId, bytes, a.startByte, a.endByte))) throw prerequisiteStop("Representation annotation changed immutable source evidence");
    }
    const exact = (a: { startByte: number; endByte: number }) => Buffer.from(bytes).subarray(a.startByte, a.endByte).toString("utf8");
    if ((payload.annotationType === "entity-mention" && payload.form !== "zero-anaphora" && payload.surface !== exact(payload.anchor))
      || (payload.annotationType === "event-mention" && payload.trigger !== exact(payload.triggerAnchor))) throw prerequisiteStop("Mention surface or trigger differs from its exact source anchor");
  }
}

/** Deterministic reference typing and DAG checks before either semantic review or upstream authorization. */
export function assertRepresentationReferenceTypes(output: RepresentationPlan, catalog: SourceAnnotation[]) {
  const created = output.annotations.map(a => a.payload), all = [...catalog, ...created];
  for (const a of created) {
    const expect = (id: string | undefined, type: SourceAnnotation["annotationType"], scene = false) => {
      if (!id) return;
      const ref = all.find(a => a.id === id);
      if (!ref || ref.annotationType !== type || (scene && (ref.annotationType !== "discourse-segment" || ref.kind !== "scene"))) throw prerequisiteStop("Representation dependency has the wrong annotation type or scene kind");
    };
    if (a.annotationType === "discourse-segment") expect(a.viewpointMentionId, "entity-mention");
    else {
      expect(a.sceneId, "discourse-segment", true);
      if (a.annotationType === "event-mention") { a.participantMentionIds.forEach(id => expect(id, "entity-mention")); expect(a.discourseSegmentId, "discourse-segment"); }
      if (a.annotationType === "quotation") { expect(a.speakerMentionId, "entity-mention"); a.addresseeMentionIds.forEach(id => expect(id, "entity-mention")); }
    }
  }
  const pending = new Map(created.map(a => [a.id, a]));
  while (pending.size) {
    const ready = [...pending.values()].filter(a => representationReferences(a).every(id => !pending.has(id)));
    if (!ready.length) throw prerequisiteStop("Representation annotation dependency cycle; preserve the original proposal without a grant");
    ready.forEach(a => pending.delete(a.id));
  }
}
