/**
 * Independent capability requirements and diagnostic-only repair planning.
 * The caller owns evidence verification and fingerprint construction. These
 * records are neither model authorization nor a full-novel certificate.
 */
export type RequirementStage = "source-review" | "semantic" | "executable" | "ontology";
export type RequirementState = "satisfied" | "blocked" | "unknown" | "unmapped" | "stale";
export type RequirementContext = {
  sourceId: string;
  sourceSha256: string;
  specHash: string;
  catalogHash: string;
  evaluatorVersion: string;
};
export type SemanticRequirement = {
  id: string;
  sourceId: string;
  targetRef: string;
  capability: string;
  stage: RequirementStage;
  expectation: { kind: string; [key: string]: unknown };
  evidenceRefs: readonly string[];
  dependsOn: readonly string[];
};
export type RequirementObservation = {
  requirementId: string;
  context: RequirementContext;
  state: Exclude<RequirementState, "stale">;
  diagnostics: readonly string[];
};
export type RequirementAssessment = {
  version: 1;
  authority: "diagnostic-only";
  context: RequirementContext;
  complete: boolean;
  requirements: Array<SemanticRequirement & {
    state: RequirementState;
    ownState: RequirementState;
    blockedBy: string[];
    diagnostics: string[];
  }>;
};

const STAGES = new Set(["source-review", "semantic", "executable", "ontology"]);
const STATES = new Set(["satisfied", "blocked", "unknown", "unmapped"]);
const HASH = /^[a-f0-9]{64}$/;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const unique = (values: readonly string[]) => [...new Set(values)].sort(compare);

function requireText(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${label}`);
}
function checkContext(context: RequirementContext): void {
  requireText(context.sourceId, "source identity");
  requireText(context.evaluatorVersion, "evaluator version");
  for (const key of ["sourceSha256", "specHash", "catalogHash"] as const) {
    if (!HASH.test(context[key])) throw new Error(`Invalid requirement ${key}`);
  }
}
function sameContext(a: RequirementContext, b: RequirementContext): boolean {
  return a.sourceId === b.sourceId && a.sourceSha256 === b.sourceSha256
    && a.specHash === b.specHash && a.catalogHash === b.catalogHash
    && a.evaluatorVersion === b.evaluatorVersion;
}

/** Stable topological order; missing dependencies and cycles are not success. */
function orderedRequirements(requirements: readonly SemanticRequirement[], sourceId: string): SemanticRequirement[] {
  const byId = new Map<string, SemanticRequirement>();
  for (const item of requirements) {
    requireText(item.id, "requirement identity");
    requireText(item.targetRef, "requirement target");
    requireText(item.capability, "capability");
    if (item.sourceId !== sourceId) throw new Error(`Requirement ${item.id} has a foreign source`);
    if (byId.has(item.id)) throw new Error(`Duplicate requirement ${item.id}`);
    if (!STAGES.has(item.stage)) throw new Error(`Invalid requirement stage for ${item.id}`);
    if (!item.expectation || typeof item.expectation !== "object" || Array.isArray(item.expectation)) throw new Error(`Missing independent expectation for ${item.id}`);
    requireText(item.expectation.kind, "expectation kind");
    if (!item.evidenceRefs.length || unique(item.evidenceRefs).length !== item.evidenceRefs.length) throw new Error(`Missing or duplicate evidence for ${item.id}`);
    item.evidenceRefs.forEach(value => requireText(value, "evidence reference"));
    if (unique(item.dependsOn).length !== item.dependsOn.length) throw new Error(`Duplicate dependency for ${item.id}`);
    byId.set(item.id, item);
  }
  for (const item of requirements) for (const dependency of item.dependsOn) {
    if (!byId.has(dependency)) throw new Error(`Unknown dependency ${dependency} of ${item.id}`);
  }
  const result: SemanticRequirement[] = [], done = new Set<string>();
  const pending = new Set(byId.keys());
  while (pending.size) {
    const ready = [...pending].filter(id => byId.get(id)!.dependsOn.every(dependency => done.has(dependency))).sort(compare);
    if (!ready.length) throw new Error(`Requirement dependency cycle: ${[...pending].sort(compare).join(", ")}`);
    for (const id of ready) {
      pending.delete(id); done.add(id); result.push(byId.get(id)!);
    }
  }
  return result;
}

export function assessSemanticRequirements(
  definitions: readonly SemanticRequirement[],
  observations: readonly RequirementObservation[],
  context: RequirementContext,
): RequirementAssessment {
  checkContext(context);
  const definitionsInOrder = orderedRequirements(definitions, context.sourceId);
  const ids = new Set(definitions.map(item => item.id));
  const results = new Map<string, RequirementObservation>();
  for (const observation of observations) {
    if (!ids.has(observation.requirementId)) throw new Error(`Unknown observation ${observation.requirementId}`);
    if (results.has(observation.requirementId)) throw new Error(`Duplicate observation ${observation.requirementId}`);
    checkContext(observation.context);
    if (observation.context.sourceId !== context.sourceId) throw new Error(`Foreign observation ${observation.requirementId}`);
    if (!STATES.has(observation.state)) throw new Error(`Invalid observation state for ${observation.requirementId}`);
    observation.diagnostics.forEach(value => requireText(value, "diagnostic"));
    results.set(observation.requirementId, observation);
  }
  const states = new Map<string, RequirementState>();
  const requirements = definitionsInOrder.map(definition => {
    const result = results.get(definition.id);
    let ownState: RequirementState = result?.state ?? "unknown";
    const diagnostics = [...(result?.diagnostics ?? [])];
    if (!result) diagnostics.push("REQUIREMENT_NOT_EVALUATED");
    else if (!sameContext(result.context, context)) {
      ownState = "stale"; diagnostics.push("REQUIREMENT_REVISION_STALE");
    }
    // Independent unmapped semantics cannot be certified by relabeling output.
    if (ownState !== "stale" && definition.expectation.kind === "unmapped") {
      ownState = "unmapped"; diagnostics.push("SEMANTIC_LOWERING_REQUIRED");
    }
    if (ownState === "satisfied" && diagnostics.length) ownState = "blocked";
    const blockedBy = definition.dependsOn.filter(id => states.get(id) !== "satisfied").sort(compare);
    const state: RequirementState = ownState === "satisfied" && blockedBy.length ? "blocked" : ownState;
    if (blockedBy.length) diagnostics.push("REQUIREMENT_DEPENDENCY_UNSATISFIED");
    states.set(definition.id, state);
    return { ...structuredClone(definition), state, ownState, blockedBy, diagnostics: unique(diagnostics) };
  });
  return {
    version: 1, authority: "diagnostic-only", context: { ...context },
    complete: requirements.length > 0 && requirements.every(item => item.state === "satisfied"), requirements,
  };
}

/** No writes, sessions, retries or field-creation authority are granted here. */
export function planRequirementRepairs(assessment: RequirementAssessment, limit = 32) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new Error("Repair limit must be an integer in 1..128");
  if (assessment.authority !== "diagnostic-only") throw new Error("Invalid assessment authority");
  checkContext(assessment.context);
  // Revalidate topology even when an assessment was deserialized by the host.
  const ordered = orderedRequirements(assessment.requirements, assessment.context.sourceId);
  const byId = new Map(assessment.requirements.map(item => [item.id, item]));
  const unresolved = ordered.filter(item => byId.get(item.id)!.state !== "satisfied");
  const unresolvedIds = new Set(unresolved.map(item => item.id));
  const tasks = unresolved.slice(0, limit).map(item => {
    const result = byId.get(item.id)!;
    const blockedBy = item.dependsOn.filter(id => unresolvedIds.has(id)).sort(compare);
    return {
      requirementId: item.id, targetRef: item.targetRef, capability: item.capability,
      stage: result.state === "unmapped" ? "ontology" as const : item.stage,
      action: result.state === "stale" ? "reevaluate" as const
        : result.state === "unmapped" ? "host-design-review" as const
          : result.ownState === "satisfied" ? "revalidate-after-dependencies" as const : "source-grounded-review" as const,
      blockedBy, readyForHostReview: blockedBy.length === 0,
      requiresHostAuthorization: true as const,
      evidenceRefs: [...item.evidenceRefs], expectation: structuredClone(item.expectation),
    };
  });
  return {
    version: 1 as const, authority: "diagnostic-only" as const, context: { ...assessment.context }, tasks,
    remainingRequirementIds: unresolved.slice(limit).map(item => item.id),
  };
}
