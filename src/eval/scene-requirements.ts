import {
  assessSemanticRequirements, planRequirementRepairs,
  type RequirementContext, type RequirementObservation, type RequirementStage,
  type SemanticRequirement,
} from "../compiler/semantic-requirements.js";
import type { SceneCapabilityIssue, SceneCapabilitySpec } from "./scene-capabilities.js";

export const SCENE_REQUIREMENT_EVALUATOR_VERSION = "scene-requirements-v1";
type CaseResult = {
  id: string;
  status: "verified" | "blocked" | "unknown" | "unsupported";
  issues: readonly SceneCapabilityIssue[];
};

/** Split independently specified checks, never infer the denominator from drafts. */
export function buildSceneRequirementAssessment(
  spec: SceneCapabilitySpec,
  results: readonly CaseResult[],
  context: RequirementContext,
) {
  if (context.sourceId !== spec.sourceId || context.sourceSha256 !== spec.sourceSha256
    || context.evaluatorVersion !== SCENE_REQUIREMENT_EVALUATOR_VERSION) throw new Error("Scene requirement context mismatch");
  const caseIds = new Set(spec.cases.map(item => item.id));
  if (caseIds.size !== spec.cases.length) throw new Error("Duplicate scene requirement case");
  const byId = new Map<string, CaseResult>();
  for (const result of results) {
    if (!caseIds.has(result.id) || byId.has(result.id)) throw new Error(`Unknown or duplicate scene result ${result.id}`);
    byId.set(result.id, result);
  }
  const definitions: SemanticRequirement[] = [], observations: RequirementObservation[] = [];
  for (const item of spec.cases) {
    const result = byId.get(item.id), issues = result?.issues ?? [];
    const targetRef = item.kind === "event-effects" ? `event:${item.eventId}`
      : item.kind === "knowledge-cut" ? `event:${item.acquisitionEventId}`
        : item.kind === "norm-scope" ? `norm:${item.normId}` : `action:${item.action.schemaId}`;
    const evidenceRefs = [...new Set(item.evidence.map(anchor =>
      `source-anchor:${anchor.sourceId}:${anchor.startByte}:${anchor.endByte}:${anchor.exactHash}`))];
    const common = issues.filter(issue => issue.stage === "source-review");
    const agency = (issue: SceneCapabilityIssue) => issue.code === "SCENE_INITIATOR_ROLE_UNPROVEN"
      || issue.code === "EVENT_EXECUTION_AGENCY_UNPROVEN";
    const add = (capability: string, stage: RequirementStage, expectation: SemanticRequirement["expectation"],
      findings: readonly SceneCapabilityIssue[], dependsOn: string[] = [],
      explicitState?: RequirementObservation["state"]) => {
      const id = `${item.id}:${capability}`;
      definitions.push({ id, sourceId: spec.sourceId, targetRef, capability, stage,
        expectation: structuredClone(expectation), evidenceRefs, dependsOn });
      if (result) observations.push({ requirementId: id, context: { ...context },
        state: explicitState ?? (findings.length ? "blocked" : "satisfied"),
        diagnostics: findings.map(issue => `${issue.code}: ${issue.message}`) });
      return id;
    };
    const children: string[] = [];
    if (item.kind === "event-effects") {
      children.push(add("state-effect", "semantic", { ...item.expectation },
        [...common, ...issues.filter(issue => (issue.stage === "semantic" && !agency(issue)) || issue.stage === "ontology")]));
      if (item.initiatorId) children.push(add("agency", "semantic",
        { kind: "agent-participation", actorId: item.initiatorId }, [...common, ...issues.filter(agency)]));
      if (item.requiresMechanism) children.push(add("mechanism", "executable", { kind: "mechanism-required", eventId: item.eventId },
        [...common, ...issues.filter(issue => issue.stage === "executable" || agency(issue))], [...children]));
    }
    // The full independently supplied case preserves unclassified failures and
    // non-event checks. Child successes never erase its original diagnostics.
    const caseState = result?.status === "verified" ? "satisfied"
      : result?.status === "unsupported" ? "unmapped" : result?.status === "unknown" ? "unknown" : "blocked";
    add("case-validation", item.kind === "norm-scope" || item.kind === "action-probe" ? "executable" : "semantic",
      { ...item }, issues, children, caseState);
  }
  const requirements = assessSemanticRequirements(definitions, observations, context);
  return { requirements, requirementRepairPlan: planRequirementRepairs(requirements) };
}
