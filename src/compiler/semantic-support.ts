import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import type { ValidationIssue } from "../world/model.js";
import type { PreparedNovelBundle } from "./prepared-cache.js";

export const supportReviewSchema = z.object({
  assertionId: z.string().min(1), assertionHash: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(["supports", "contradicts", "underdetermined"]),
  scope: z.enum(["occurrence", "mechanism"]), rationale: z.string().trim().min(1),
}).strict();
export type SupportReview = z.infer<typeof supportReviewSchema>;
export const supportAssessmentSchema = z.object({
  assertionId: z.string(), assertionHash: z.string(), artifactKind: z.string(), artifactId: z.string(), jsonPointer: z.string(),
  sourceUnitIds: z.array(z.string()), decision: z.enum(["supports", "contradicts", "underdetermined"]),
  method: z.enum(["independent-frozen-review", "unreviewed-extraction"]), scope: z.enum(["occurrence", "mechanism"]),
  rationale: z.string(),
}).strict();
export type SupportAssessment = z.infer<typeof supportAssessmentSchema>;
const mechanismKinds = new Set(["event-execution", "action-schema", "action-constraint", "norm-template", "process-template", "world-rule"]);

/** An exact anchor proves location in the source, not semantic entailment or a reusable mechanism. */
export function assessSemanticSupport(bundle: PreparedNovelBundle, reviews: readonly SupportReview[] = []): { assessments: SupportAssessment[]; issues: ValidationIssue[] } {
  const assertions = bundle.compilerSnapshot.evidenceBindings.flatMap((binding) => binding.assertions), issues: ValidationIssue[] = [];
  const reviewMap = new Map(reviews.map((review) => [review.assertionId, review]));
  if (reviewMap.size !== reviews.length) issues.push({ code: "SUPPORT_REVIEW_DUPLICATED", message: "Independent evidence assertion reviews must be unique" });
  for (const review of reviews) if (!assertions.some((assertion) => assertion.id === review.assertionId && contentHash(assertion) === review.assertionHash)) issues.push({ code: "SUPPORT_REVIEW_STALE", message: `Support review ${review.assertionId} does not match a frozen assertion` });
  const assessments = assertions.map((assertion): SupportAssessment => {
    const review = reviewMap.get(assertion.id), scope = mechanismKinds.has(assertion.target.artifactKind) ? "mechanism" : "occurrence";
    const valid = review?.assertionHash === contentHash(assertion) && review.scope === scope;
    return { assertionId: assertion.id, assertionHash: contentHash(assertion), ...assertion.target,
      sourceUnitIds: bundle.compilerSnapshot.structure.units.filter((unit) => bundle.compilerSnapshot.structure.baseUnitIds.includes(unit.id) && assertion.anchors.some((anchor) => anchor.sourceId === bundle.source.id && anchor.startByte < unit.anchor.endByte && anchor.endByte > unit.anchor.startByte)).map((unit) => unit.id),
      decision: valid ? review!.decision : "underdetermined", method: valid ? "independent-frozen-review" : "unreviewed-extraction", scope,
      rationale: valid ? review!.rationale : "An extraction assertion and valid source anchor do not independently establish field support or mechanism applicability." };
  });
  // Reusable abilities require independent support of executable fields. A
  // review of a name or one observed episode cannot certify those mechanisms.
  const canonical = bundle.canonical;
  const inventory: Array<[string, readonly { id: string; induction?: { kind: string } }[]]> = [
    ["event-execution", canonical.eventExecutions ?? []], ["action-schema", canonical.actionSchemas],
    ["action-constraint", canonical.actionConstraints], ["norm-template", canonical.normTemplates],
    ["process-template", canonical.processTemplates], ["world-rule", canonical.rules],
  ];
  const payloads = new Map(inventory.flatMap(([kind, artifacts]) => artifacts
    .filter((artifact) => artifact.induction?.kind !== "domain-module")
    .map((artifact) => [`${kind}/${artifact.id}`, artifact] as const)));
  const required = bundle.compilerSnapshot.evidenceBindings.filter((binding) => payloads.has(`${binding.artifactKind}/${binding.artifactId}`));
  for (const artifactKey of payloads.keys()) if (!required.some((binding) => `${binding.artifactKind}/${binding.artifactId}` === artifactKey)) {
    issues.push({ code: "MECHANISM_SUPPORT_MISSING", message: `${artifactKey} has no exact executable-field evidence binding` });
  }
  for (const binding of required) {
    const fields = new Set(binding.assertions.filter((assertion) => assertion.relation !== "contextualizes" && !["", "/name", "/description"].includes(assertion.target.jsonPointer)).map((assertion) => assertion.target.jsonPointer));
    if (!fields.size) issues.push({ code: "MECHANISM_SUPPORT_MISSING", message: `${binding.artifactKind}/${binding.artifactId} has no executable-field support targets` });
    // Reviewing one effect must not silently certify unreviewed guards, roles,
    // exceptions, authority, or extra effects in the same mechanism.
    const payload = payloads.get(`${binding.artifactKind}/${binding.artifactId}`)!;
    for (const field of executableLeaves(payload)) if (![...fields].some((target) => field === target || field.startsWith(`${target}/`))) {
      issues.push({ code: "MECHANISM_SUPPORT_MISSING", message: `${binding.artifactKind}/${binding.artifactId}${field} has no field support target`, path: field });
    }
    for (const field of fields) {
      const assessmentsForField = assessments.filter((assessment) => assessment.artifactKind === binding.artifactKind && assessment.artifactId === binding.artifactId && assessment.jsonPointer === field);
      if (assessmentsForField.some((assessment) => assessment.decision === "contradicts")) issues.push({ code: "MECHANISM_SUPPORT_CONFLICT", message: `Independent counterevidence remains for ${binding.artifactKind}/${binding.artifactId}${field}`, path: field });
      else if (!assessmentsForField.some((assessment) => assessment.decision === "supports" && assessment.scope === "mechanism")) issues.push({ code: "MECHANISM_SUPPORT_UNREVIEWED", message: `Executable field ${binding.artifactKind}/${binding.artifactId}${field} requires independent mechanism review`, path: field });
    }
  }
  return { assessments, issues };
}

function executableLeaves(payload: unknown, pointer = ""): string[] {
  if (!payload || typeof payload !== "object") return [pointer];
  const entries = Object.entries(payload).filter(([field]) => pointer !== "" || !["id", "ontologyVersion", "name", "description", "evidence", "counterEvidence"].includes(field));
  if (!entries.length) return pointer ? [pointer] : [];
  return entries.flatMap(([field, value]) => executableLeaves(value, `${pointer}/${field.replace(/~/g, "~0").replace(/\//g, "~1")}`));
}
