import { z } from "zod";
import path from "node:path";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { contentHash } from "../world/canonical.js";
import { modelTextSelectorSchema } from "./text-anchors.js";
import { prerequisiteEvidenceSchema, prerequisiteStop, type PrerequisiteRecord } from "./role-source-prerequisites.js";
import { type RoleDependencyReview } from "./role-dependency-review.js";
import { type SemanticCatalogItem } from "./role-dependency-review-service.js";
import { type RepresentationRecord } from "./source-representation.js";
import { upstreamRepairKindSchema, upstreamRepairReadableRefSchema, upstreamRepairWriteSchema,
  upstreamRepairReferencedKeys, parseUpstreamRepairPayload, repairPointerTokens } from "./upstream-repair-plan.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().trim().min(1).max(6000);
const evidence = z.array(modelTextSelectorSchema).min(1).max(32);
const ref = upstreamRepairReadableRefSchema.extend({ revisionHash: hash }).strict();
export const semanticScopePhases = ["semantic-scope-plan", "semantic-scope-check"] as const;
export const SEMANTIC_SCOPE_LIMITS = Object.freeze({ maxModelCalls: 24, maxRequestBytes: 512_000, maxTotalPayloadBytes: 12_288_000 });
export const roleSemanticScopeDirectory = (root: string, taskId: string, sourceId: string) => path.join(workspaceStateDir(root), "compile-loops", sourceId, "prerequisites", taskId, "semantic-scope");
export const semanticScopePlanSchema = z.object({
  phase: z.literal("semantic-scope-plan"), revisionHash: hash,
  operations: z.array(z.object({
    slot: z.number().int().min(1).max(48), kind: upstreamRepairKindSchema, id: z.string().min(1),
    mode: z.enum(["create", "revise"]),
    baseline: ref.nullable().describe("create requires null. revise requires the exact current target. A superseded resolution belongs in readableRefs, never a creation's write baseline."),
    pointers: z.array(text).max(32).describe("create requires []. revise requires registered field pointers. Root '/' is never a field scope."),
    // Full schema is available through read_semantic_dependencies.schemaKind.
    // Keeping it out of the tool union prevents eight large schemas on every request.
    payloadJson: z.string().min(2).max(100000), readableRefs: z.array(ref).max(128),
    findingIds: z.array(hash).max(32), questionIds: z.array(hash).min(1).max(16),
    rationale: text, evidence,
  }).strict()).max(48),
  questions: z.array(z.object({ questionId: hash, impact: z.literal("critical"), originalStatus: z.literal("blocked"),
    criteria: z.array(z.object({ index: z.number().int().nonnegative(),
      route: z.enum(["typed-repair", "evidence-gap", "ontology-gap", "no-write-assessment"]),
      operationSlots: z.array(z.number().int().min(1).max(48)), rationale: text,
      missingCondition: z.string().max(6000).describe("Retain any unsatisfied condition, including for a partial typed-repair. Nonempty means the criterion remains blocked."), evidence,
    }).strict()).min(1).max(12),
    boundaries: z.array(z.object({ index: z.number().int().nonnegative(), status: z.literal("unresolved"), rationale: text }).strict()).min(1).max(32),
  }).strict()).min(1).max(16),
  consumer: z.object({ priorPlanHash: hash, priorSubjectHash: hash, nextSubjectHash: hash,
    addedCandidateIds: z.array(z.string()), affectedCandidateIds: z.array(z.string()), affectedSourcePages: z.array(z.number().int().nonnegative()),
    preserveOriginalQuestionIds: z.literal(true), renewConsumedGrant: z.literal(false),
    rationale: text, activationConditions: z.array(text).min(1).max(32) }).strict(),
}).strict();
export const semanticScopeCheckSchema = z.object({ phase: z.literal("semantic-scope-check"), revisionHash: hash, proposalHash: hash,
  judgments: z.array(z.object({ questionId: hash, verdict: z.enum(["supported", "blocked"]), rationale: text, evidence }).strict()).min(1).max(16),
  operationJudgments: z.array(z.object({ slot: z.number().int().min(1).max(48), verdict: z.enum(["supported", "blocked"]), rationale: text }).strict()).max(48),
  consumerVerdict: z.enum(["supported", "blocked"]), consumerRationale: text,
}).strict();
export const semanticScopeOutputSchema = z.union([semanticScopePlanSchema, semanticScopeCheckSchema]);
export type SemanticScopeOutput = z.infer<typeof semanticScopeOutputSchema>;
export const semanticScopeCorrectionSchema = z.object({
  version: z.literal(1), policy: z.literal("role-semantic-creation-scope-correction/v1"),
  taskId: hash, revisionHash: hash, authorizationRef: text,
  failedTraceRunId: text, failedSessionId: text, failedTraceHash: hash, failedEventsHash: hash,
  failedSubmissionHash: hash, originalInputHash: hash, originalInvocationHash: hash, originalBudgetHash: hash,
  originalUsage: z.object({ modelCalls: z.number().int().positive(), payloads: z.number().int().positive(),
    totalPayloadBytes: z.number().int().positive(), largestRequestBytes: z.number().int().positive() }).strict(),
  allowedPaths: z.array(z.string().regex(/^\/operations\/\d+\/(?:pointers|baseline)$/)).length(4),
  requirementPrefix: z.object({ length: z.number().int().positive(), head: hash }).strict(),
  retainedFiles: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9._-]+$/), sha256: hash }).strict()).min(1),
}).strict();
export type SemanticScopeCorrection = z.infer<typeof semanticScopeCorrectionSchema>;
export const semanticScopeRecordSchema = z.object({ taskId: hash, revisionHash: hash, phase: z.enum(semanticScopePhases),
  inputHash: hash, output: semanticScopeOutputSchema, evidence: z.array(prerequisiteEvidenceSchema).min(1).max(1024),
  traceRunId: text, sessionId: text, provider: z.literal("openai-codex"), model: z.literal("gpt-6.1-sol"), subscription: z.literal(true),
  predecessorRecordHash: hash.nullable(),
  correction: semanticScopeCorrectionSchema.optional(),
}).strict();
export type SemanticScopeRecord = z.infer<typeof semanticScopeRecordSchema>;
export const semanticScopeSlotId = (taskId: string, slot: number) => `rs-${taskId.slice(0, 32)}-${slot}`;
export function semanticScopeView(r: RoleDependencyReview) {
  return { taskId: r.taskId, revisionHash: r.revisionHash, scope: r.scope, authorizationRef: r.authorizationRef, authority: r.authority,
    priorPlanHash: r.scope.planHash, priorSubjectHash: r.priorRoster.subjectHash, nextSubjectHash: r.nextRoster.subjectHash,
    priorCandidateCount: r.priorRoster.candidates.length, nextCandidateCount: r.nextRoster.candidates.length,
    candidates: r.nextRoster.candidates, addedCandidateIds: r.addedCandidateIds, addedAnnotationIds: r.addedAnnotationIds,
    sourcePages: r.priorPlan.spans.length, upstream: r.upstream, catalogHash: r.catalogHash, discoveryHash: r.discoveryHash,
    retainedHistoryHash: contentHash(r.retainedFiles), prerequisiteRecordHashes: r.prerequisiteRecordHashes, representationRecordHashes: r.representationRecordHashes };
}
export function semanticScopeSelectors(output: SemanticScopeOutput) {
  return output.phase === "semantic-scope-plan" ? [...output.operations.flatMap(o => o.evidence), ...output.questions.flatMap(q => q.criteria.flatMap(c => c.evidence))] : output.judgments.flatMap(j => j.evidence);
}
const same = (a: unknown[], b: unknown[]) => new Set(a).size === a.length && contentHash([...a].sort()) === contentHash([...b].sort());

export type SemanticScopePlanIssue = { path: string; message: string; category: "scope" | "payload-schema" };

/** Read-only structural inspection; neither normalizes a model submission nor grants authority.
 * Report all independent scope errors so an earlier gap cannot hide an invalid write. */
export function inspectSemanticScopePlan(output: z.infer<typeof semanticScopePlanSchema>, review: RoleDependencyReview,
  prerequisites: PrerequisiteRecord[], representations: RepresentationRecord[], catalog: SemanticCatalogItem[], findingIds: string[]) {
  const issues: SemanticScopePlanIssue[] = [];
  const issue = (path: string, message: string, category: SemanticScopePlanIssue["category"] = "scope") => { issues.push({ path, message, category }); };
  const specification = prerequisites[0]?.output, representation = representations[0]?.output;
  if (specification?.phase !== "specification" || representation?.phase !== "representation-plan"
    || output.revisionHash !== review.revisionHash || !same(output.questions.map(q => q.questionId), review.scope.questions.map(q => q.questionId))) {
    issue("/questions", "Semantic scope changed its independent specifications or original question denominator"); return issues;
  }
  const slots = output.operations.map(o => o.slot), keys = output.operations.map(o => `${o.kind}:${o.id}`);
  if (new Set(slots).size !== slots.length || new Set(keys).size !== keys.length) issue("/operations", "Repeated semantic repair slot");
  const used = new Set<number>();
  for (const [qi, q] of output.questions.entries()) {
    const spec = specification.requirements.find(s => s.questionId === q.questionId);
    if (!spec) { issue(`/questions/${qi}`, "Original independent specification is missing"); continue; }
    if (!same(q.criteria.map(c => c.index), spec.acceptanceCriteria.map((_, i) => i))
      || !same(q.boundaries.map(b => b.index), representation.boundaries.flatMap((b, i) => b.questionId === q.questionId ? [i] : []))) issue(`/questions/${qi}`, "Semantic scope omitted an original criterion or unresolved boundary");
    for (const [ci, c] of q.criteria.entries()) {
      // A scoped partial repair may faithfully retain an unsatisfied condition.
      // Readiness below still rejects it; never delete that condition to retain a proposal.
      if (c.operationSlots.some(s => !output.operations.some(o => o.slot === s && o.questionIds.includes(q.questionId)))
        || new Set(c.operationSlots).size !== c.operationSlots.length
        || (c.route === "typed-repair" ? !c.operationSlots.length : c.operationSlots.length || !c.missingCondition.trim())) issue(`/questions/${qi}/criteria/${ci}`, "Criterion lacks exact repair slots or its explicit missing condition");
      c.operationSlots.forEach(s => used.add(s));
    }
  }
  for (const [oi, o] of output.operations.entries()) {
    const location = `/operations/${oi}`;
    if (!used.has(o.slot) || !same(o.questionIds, [...new Set(o.questionIds)])
      || o.questionIds.some(id => !output.questions.some(q => q.questionId === id && q.criteria.some(c => c.operationSlots.includes(o.slot))))
      || o.findingIds.some(id => !findingIds.includes(id))) issue(location, "Operation is outside an original criterion or current typed finding");
    let payload: ReturnType<typeof parseUpstreamRepairPayload> | undefined;
    try { payload = parseUpstreamRepairPayload(o.kind, JSON.parse(o.payloadJson)); }
    catch { issue(`${location}/payloadJson`, "Payload must match the current schema returned by read_semantic_dependencies.schemaKind", "payload-schema"); }
    if (payload && (("id" in payload ? payload.id : "singleton") !== o.id || ("sourceId" in payload && payload.sourceId !== review.scope.sourceId))) issue(`${location}/payloadJson`, "Semantic payload changed allocated identity or immutable source");
    if (o.readableRefs.some(r => !catalog.some(c => c.kind === r.kind && c.id === r.id && c.revisionHash === r.revisionHash))) issue(`${location}/readableRefs`, "Read-only dependency revision is missing or stale");
    if (payload && upstreamRepairReferencedKeys(o.kind, payload).some(key => !keys.includes(key) && !o.readableRefs.some(r => `${r.kind}:${r.id}` === key))) issue(`${location}/readableRefs`, "Semantic payload has an unbound typed dependency");
    if (o.mode === "create") {
      if (o.id !== semanticScopeSlotId(review.taskId, o.slot) || catalog.some(c => c.id === o.id)) issue(`${location}/id`, "Creation must use one fresh exact host slot without field-edit authority");
      if (o.baseline) issue(`${location}/baseline`, "Creation requires baseline=null; an immutable predecessor is a readableRef, not a write baseline");
      if (o.pointers.length) issue(`${location}/pointers`, "Creation requires pointers=[]; root '/' does not grant field-edit authority");
    } else {
      const validPointers = upstreamRepairWriteSchema.safeParse({ kind: o.kind, id: o.id, pointers: o.pointers }).success;
      if (!validPointers) issue(`${location}/pointers`, "Revision requires exact registered field pointers; root '/' is not allowed");
      if (["entity-resolution", "event-resolution"].includes(o.kind)) issue(location, "Resolution history is immutable; propose a fresh superseding resolution slot");
      const baseline = catalog.find(c => c.kind === o.kind && c.id === o.id);
      if (!o.baseline || !baseline || o.baseline.kind !== o.kind || o.baseline.id !== o.id || o.baseline.revisionHash !== baseline.revisionHash) issue(`${location}/baseline`, "Revision lacks its exact current typed baseline");
      if (baseline && payload && validPointers) {
        const fields = o.pointers.map(p => repairPointerTokens(p)[0]);
        const a = baseline.payload as Record<string, unknown>, b = payload as Record<string, unknown>;
        if ([...new Set([...Object.keys(a), ...Object.keys(b)])].some(key => !fields.includes(key) && contentHash(a[key] ?? null) !== contentHash(b[key] ?? null))) issue(`${location}/payloadJson`, "Semantic payload changes a field outside its exact pointer scope");
      }
    }
  }
  const c = output.consumer;
  if (c.priorPlanHash !== review.scope.planHash || c.priorSubjectHash !== review.priorRoster.subjectHash || c.nextSubjectHash !== review.nextRoster.subjectHash
    || !same(c.addedCandidateIds, review.addedCandidateIds) || c.affectedCandidateIds.some(id => !review.nextRoster.candidates.some(n => n.id === id))
    || !review.addedCandidateIds.every(id => c.affectedCandidateIds.includes(id)) || c.affectedSourcePages.some(p => p >= review.priorPlan.spans.length)) issue("/consumer", "Consumer scope changed the exact old/new denominator");
  return issues;
}

/** Validates a proposal's exact ranges, not its semantic truth or authority. */
export function validateSemanticScopePlan(...args: Parameters<typeof inspectSemanticScopePlan>) {
  const issues = inspectSemanticScopePlan(...args);
  if (issues.some(i => i.category === "scope")) throw prerequisiteStop(issues.map(i => `${i.path}: ${i.message}`).join("; "));
  // Keep payload syntax/schema failures eligible for the existing one changed
  // tool correction; scope, stale dependency and consumed-stage errors stay fatal.
  for (const operation of args[0].operations) parseUpstreamRepairPayload(operation.kind, JSON.parse(operation.payloadJson));
}

export function validateSemanticScopeHistory(review: RoleDependencyReview, records: SemanticScopeRecord[]) {
  if (records.length > 2) throw prerequisiteStop("Semantic scope phases already consumed");
  const sessions = new Set<string>(), traces = new Set<string>();
  for (const [i, r] of records.entries()) {
    semanticScopeRecordSchema.parse(r);
    if (r.taskId !== review.taskId || r.revisionHash !== review.revisionHash || r.phase !== semanticScopePhases[i]
      || r.output.phase !== r.phase || r.output.revisionHash !== r.revisionHash || r.predecessorRecordHash !== (i ? contentHash(records[i - 1]) : null)
      || sessions.has(r.sessionId) || traces.has(r.traceRunId)) throw prerequisiteStop("Semantic scope history is repeated, stale or not independent");
    if (r.correction && (i !== 0 || r.correction.taskId !== r.taskId || r.correction.revisionHash !== r.revisionHash
      || r.correction.failedSessionId === r.sessionId || r.correction.failedTraceRunId === r.traceRunId)) throw prerequisiteStop("Semantic correction reuses its failed session or changes task lineage");
    if (records[0]?.correction && (r.sessionId === records[0].correction.failedSessionId || r.traceRunId === records[0].correction.failedTraceRunId)) throw prerequisiteStop("Independent check reused the original failed scope session");
    sessions.add(r.sessionId); traces.add(r.traceRunId);
  }
  const p = records[0]?.output, check = records[1]?.output;
  if (p?.phase === "semantic-scope-plan" && check?.phase === "semantic-scope-check"
    && (check.proposalHash !== contentHash(p) || !same(check.judgments.map(j => j.questionId), p.questions.map(q => q.questionId))
      || !same(check.operationJudgments.map(j => j.slot), p.operations.map(o => o.slot)))) throw prerequisiteStop("Independent scope check omitted exact operations or questions");
}
export function semanticScopeReady(records: SemanticScopeRecord[]) {
  const p = records[0]?.output, c = records[1]?.output;
  return p?.phase === "semantic-scope-plan" && c?.phase === "semantic-scope-check" && p.operations.length > 0
    && p.questions.every(q => q.criteria.every(a => a.route === "typed-repair" && !a.missingCondition.trim()))
    && c.judgments.every(j => j.verdict === "supported") && c.operationJudgments.every(j => j.verdict === "supported") && c.consumerVerdict === "supported";
}
