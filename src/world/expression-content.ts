import { propositionObjectSchema, type Proposition } from "./model.js";
import { contentHash } from "./canonical.js";
import { assessQuotationContentSupport, type ContentAssertion, type ContentSpan, type ContentSupportAssessment } from "./expression-content-support.js";

type ContentObject = Pick<Proposition, "id" | "object">;
export type ExpressionContentAssessment = {
  status: ContentSupportAssessment["status"];
  objects: Array<ContentSupportAssessment & { propositionId: string; objectHash: string }>;
  issues: Array<{ code: "EXPRESSION_CONTENT_MISSING" | "EXPRESSION_CONTENT_OUTSIDE" | "EXPRESSION_PROPOSITION_MISSING" | "EXPRESSION_PROPOSITION_CYCLE" | "EXPRESSION_EXPANSION_LIMIT"; propositionId: string }>;
};

/** The caller supplies this expression's evidence and frozen proposition revisions.
 * Schema-derived obligations never shrink to whichever assertions were submitted.
 * This proves containment, not entailment or source authenticity.
 */
export function assessExpressionObjectSupport(rootId: string, propositions: ReadonlyMap<string, ContentObject>, assertions: readonly ContentAssertion[], fragments: readonly ContentSpan[]): ExpressionContentAssessment {
  const objects: ExpressionContentAssessment["objects"] = [], issues: ExpressionContentAssessment["issues"] = [];
  const visited = new Set<string>();
  const walk = (id: string, ancestors: ReadonlySet<string>) => {
    if (ancestors.has(id)) { issues.push({ code: "EXPRESSION_PROPOSITION_CYCLE", propositionId: id }); return; }
    if (visited.has(id)) return;
    if (ancestors.size >= 32 || visited.size >= 128) { issues.push({ code: "EXPRESSION_EXPANSION_LIMIT", propositionId: id }); return; }
    visited.add(id);
    const proposition = propositions.get(id);
    if (!proposition || proposition.id !== id) { issues.push({ code: "EXPRESSION_PROPOSITION_MISSING", propositionId: id }); return; }
    const object = propositionObjectSchema.parse(proposition.object);
    const requiredPaths = Object.keys(object).filter(key => key !== "kind").map(key => `/object/${key}`);
    const assessment = assessQuotationContentSupport(id, assertions, fragments, requiredPaths);
    objects.push({ propositionId: id, objectHash: contentHash(object), ...assessment });
    if (assessment.status !== "supported") issues.push({ code: assessment.status === "unverified" ? "EXPRESSION_CONTENT_MISSING" : "EXPRESSION_CONTENT_OUTSIDE", propositionId: id });
    if (object.kind === "proposition") walk(object.propositionId, new Set([...ancestors, id]));
  };
  walk(rootId, new Set());
  return { status: issues.some(issue => !["EXPRESSION_CONTENT_MISSING", "EXPRESSION_PROPOSITION_MISSING"].includes(issue.code)) ? "unsupported" : issues.length ? "unverified" : "supported", objects, issues };
}
