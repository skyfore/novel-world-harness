import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { textAnchorSchema } from "../world/model.js";
import { roleQuestionSchema } from "./role-review-verification.js";
import { modelTextSelectorSchema } from "./text-anchors.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(6000);
const evidence = z.array(modelTextSelectorSchema).min(1).max(24);
const question = z.object({ questionId: hash, impact: z.literal("critical") });
export const prerequisiteScopeSchema = z.object({
  version: z.literal(1), policy: z.literal("role-source-prerequisites/v1"),
  sourceId: z.string().min(1), sourceHash: hash, planHash: hash,
  auditRevisionId: hash, negativeProposalHash: hash, retainedIssuesHash: hash,
  parentStateHash: hash, originalBudgetHash: hash,
  authorizationRef: text, questions: z.array(roleQuestionSchema).min(1).max(16),
}).strict().superRefine((scope, ctx) => {
  if (scope.questions.some(q => q.planHash !== scope.planHash)
    || new Set(scope.questions.map(q => q.questionId)).size !== scope.questions.length) {
    ctx.addIssue({ code: "custom", message: "Original question scope is inconsistent" });
  }
});
export type PrerequisiteScope = z.infer<typeof prerequisiteScopeSchema>;

// Identity deliberately excludes question selections, run IDs, grants, budgets and authorization text:
// changing those cannot manufacture another attempt for the same original work.
export function prerequisiteTaskId(scope: PrerequisiteScope): string {
  return contentHash({ policy: scope.policy, sourceId: scope.sourceId, planHash: scope.planHash,
    auditRevisionId: scope.auditRevisionId });
}
export const prerequisiteSpecificationSchema = z.object({
  phase: z.literal("specification"), scopeHash: hash,
  requirements: z.array(question.extend({
    kind: z.enum(["identity", "discourse-event-boundary", "quotation-attribution", "source-boundary"]),
    requirement: text, acceptanceCriteria: z.array(text).min(1).max(12),
    evidenceBoundaries: z.array(text).min(1).max(12), evidence,
  }).strict()).min(1).max(16),
}).strict();
export const prerequisiteBindingSchema = z.object({
  phase: z.literal("binding"), scopeHash: hash, specificationHash: hash, discoveryHash: hash,
  bindings: z.array(question.extend({
    route: z.enum(["existing-typed-finding", "missing-source-representation", "ontology-gap", "insufficient-evidence"]),
    findingIds: z.array(hash).max(32), candidateIds: z.array(z.string().min(1)).max(32),
    rationale: text, missingCondition: z.string().max(6000), evidence,
  }).strict()).min(1).max(16),
}).strict();
export const prerequisiteCheckSchema = z.object({
  phase: z.enum(["specification-check", "binding-check"]), scopeHash: hash, proposalHash: hash,
  judgments: z.array(question.extend({ verdict: z.enum(["supported", "blocked"]),
    rationale: text, evidence,
  }).strict()).min(1).max(16),
}).strict();
export const prerequisiteOutputSchema = z.union([
  prerequisiteSpecificationSchema, prerequisiteBindingSchema, prerequisiteCheckSchema,
]);
export type PrerequisiteOutput = z.infer<typeof prerequisiteOutputSchema>;
export type PrerequisitePhase = PrerequisiteOutput["phase"];
export const prerequisitePhases = ["specification", "specification-check", "binding", "binding-check"] as const;
export const prerequisiteEvidenceSchema = z.object({
  selector: modelTextSelectorSchema, anchor: textAnchorSchema,
}).strict();
export const prerequisiteRecordSchema = z.object({
  taskId: hash, scope: prerequisiteScopeSchema, phase: z.enum(prerequisitePhases),
  inputHash: hash, output: prerequisiteOutputSchema,
  evidence: z.array(prerequisiteEvidenceSchema).min(1).max(384),
  traceRunId: z.string().min(1), sessionId: z.string().min(1),
  provider: z.literal("openai-codex"), model: z.literal("gpt-6.1-sol"),
  subscription: z.literal(true), predecessorRecordHash: hash.nullable(),
}).strict();
export type PrerequisiteRecord = z.infer<typeof prerequisiteRecordSchema>;

export function prerequisiteStop(reason: string): Error {
  return new Error(`ROLE_PREREQUISITE_HOST_REVIEW: ${reason}. Preserve original questions, consumed grants, budgets, traces and attempts. Do not retry unchanged, rename work, renew a grant or resume the parent compiler.`);
}
function sameIds(actual: string[], expected: string[]) {
  return new Set(actual).size === actual.length && contentHash([...actual].sort()) === contentHash([...expected].sort());
}
export function prerequisiteSelectors(output: PrerequisiteOutput) {
  const items = output.phase === "specification" ? output.requirements : output.phase === "binding" ? output.bindings : output.judgments;
  return items.flatMap(item => item.evidence);
}
export function checkPrerequisiteOutput(raw: unknown, scope: PrerequisiteScope, phase: PrerequisitePhase,
  previous: PrerequisiteRecord[], discovery?: { findings: Array<{ findingId: string }>; candidateRefs: Array<{ id: string }> }) {
  const output = prerequisiteOutputSchema.parse(raw);
  if (output.phase !== phase || output.scopeHash !== contentHash(scope)) throw prerequisiteStop("Submission changed its frozen scope or phase");
  const ids = (output.phase === "specification" ? output.requirements : output.phase === "binding" ? output.bindings : output.judgments).map(q => q.questionId);
  if (!sameIds(ids, scope.questions.map(q => q.questionId))) throw prerequisiteStop("Submission dropped, duplicated or substituted an original critical question");
  if (output.phase === "specification-check" || output.phase === "binding-check") {
    if (output.proposalHash !== contentHash(previous.at(-1)?.output)) throw prerequisiteStop("Independent check does not bind the exact predecessor proposal");
  }
  if (output.phase === "binding") {
    if (!discovery || output.discoveryHash !== contentHash(discovery)
      || output.specificationHash !== contentHash(previous[0]?.output)) throw prerequisiteStop("Typed dependency discovery or independent specification changed");
    for (const item of output.bindings) {
      if (new Set(item.findingIds).size !== item.findingIds.length || new Set(item.candidateIds).size !== item.candidateIds.length
        || item.findingIds.some(id => !discovery.findings.some(f => f.findingId === id))
        || item.candidateIds.some(id => !discovery.candidateRefs.some(c => c.id === id))) throw prerequisiteStop("Unknown or repeated typed dependency; copy discover_prerequisite_dependencies findings[].findingId and candidateRefs[].id exactly");
      if (item.route === "existing-typed-finding" ? !item.findingIds.length || Boolean(item.missingCondition)
        : item.findingIds.length || item.candidateIds.length || !item.missingCondition.trim()) throw prerequisiteStop("Binding must retain either exact findings or an explicit missing condition, never invented authority");
    }
  }
  return output;
}

/** A retained semantic review is not an upstream repair grant or a resolved question. */
export function validatePrerequisiteHistory(records: PrerequisiteRecord[]) {
  for (let index = 0; index < records.length; index++) {
    const record = prerequisiteRecordSchema.parse(records[index]);
    if (index >= prerequisitePhases.length || record.phase !== prerequisitePhases[index]
      || record.output.phase !== record.phase || record.taskId !== prerequisiteTaskId(record.scope)
      || record.output.scopeHash !== contentHash(record.scope)
      || record.predecessorRecordHash !== (index ? contentHash(records[index - 1]) : null)
      || (index && contentHash(record.scope) !== contentHash(records[0]!.scope))) throw prerequisiteStop("Prerequisite stage identity or predecessor changed");
    if (records.slice(0, index).some(prior => prior.sessionId === record.sessionId || prior.traceRunId === record.traceRunId)) throw prerequisiteStop("Independent stages reused a model session or trace");
    const items = record.output.phase === "specification" ? record.output.requirements : record.output.phase === "binding" ? record.output.bindings : record.output.judgments;
    if (!sameIds(items.map(q => q.questionId), record.scope.questions.map(q => q.questionId))) throw prerequisiteStop("Incomplete original question denominator");
    if (record.output.phase === "specification-check" || record.output.phase === "binding-check") {
      if (record.output.proposalHash !== contentHash(records[index - 1]!.output)) throw prerequisiteStop("Check changed its proposal hash");
    }
    if (index > 1) {
      const check = records[1]!.output;
      if (check.phase !== "specification-check" || check.judgments.some(j => j.verdict !== "supported")) throw prerequisiteStop("Unaccepted independent specification cannot authorize dependency mapping");
    }
    if (record.output.phase === "binding" && record.output.specificationHash !== contentHash(records[0]!.output)) throw prerequisiteStop("Binding changed its specification");
    const selectors = prerequisiteSelectors(record.output);
    if (record.evidence.length !== selectors.length || record.evidence.some((e, i) => contentHash(e.selector) !== contentHash(selectors[i])
      || e.anchor.sourceId !== record.scope.sourceId)) throw prerequisiteStop("Exact source evidence receipt is incomplete");
  }
}

export function prerequisiteNextStep(records: PrerequisiteRecord[]): PrerequisitePhase | "blocked" | "host-authorization-review" {
  validatePrerequisiteHistory(records);
  const last = records.at(-1)?.output;
  if (last && "judgments" in last && last.judgments.some(j => j.verdict === "blocked")) return "blocked" as const;
  // Completion opens host review only. No role question is settled by this protocol.
  return records.length >= prerequisitePhases.length ? "host-authorization-review" : prerequisitePhases[records.length]!;
}
