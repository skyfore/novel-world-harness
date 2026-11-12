import { z } from "zod";
import { evaluateSceneCapabilities, type SceneCapabilitySpec, type SceneReviewCatalog } from "../eval/scene-capabilities.js";
import type { CharacterGoal } from "../world/actors.js";
import { contentHash } from "../world/canonical.js";
import { idSchema, type EvidenceAssertion } from "../world/model.js";
import { worldRepairReferenceKeys } from "./world-repair-references.js";
import type { RequirementSet } from "./requirement-ledger.js";
import type { UpstreamRepairPlan } from "./upstream-repair-plan.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const goalLifecycleRepairSchema = z.object({
  version: z.literal(1), goalId: idSchema, actorId: idSchema,
  baselineEvidenceHash: hash, retainedEvidenceHash: hash,
}).strict();

export function isCompletionEvidence(assertion: EvidenceAssertion): boolean {
  const pointer = assertion.target.jsonPointer;
  return pointer === "/completion" || pointer.startsWith("/completion/");
}

export function goalEvidenceHash(assertions: readonly EvidenceAssertion[]): string {
  return contentHash([...assertions].sort((a, b) => a.id.localeCompare(b.id)));
}

export function goalLifecycleCases(set: RequirementSet, goalId: string) {
  type Case = Extract<SceneCapabilitySpec["cases"][number], { kind: "goal-lifecycle" }>;
  return set.spec.cases.filter((item): item is Case => item.kind === "goal-lifecycle" && item.goalId === goalId);
}

export function failingGoalCases(spec: SceneCapabilitySpec, bytes: Buffer, catalog: SceneReviewCatalog): string[] {
  const { cases } = evaluateSceneCapabilities(spec, bytes, catalog);
  if (cases.some(item => item.issues.some(issue => issue.code !== "SCENE_GOAL_LIFECYCLE_MISMATCH"))) return [];
  return cases.filter(item => item.status !== "verified").map(item => item.id);
}

export function goalLifecycleSpec(plan: UpstreamRepairPlan, set: RequirementSet | undefined): SceneCapabilitySpec {
  if (!plan.goalLifecycle || !set || set.revisionHash !== plan.requirementSetHash
    || set.spec.sourceId !== plan.sourceScope.sourceId || set.spec.sourceSha256 !== plan.sourceScope.sourceSha256)
    throw new Error("Goal repair lost its source-bound active requirement revision. Inspect requirements inspect for the original source and definitions[].revisionHash. Stop without retrying this scope.");
  const cases = goalLifecycleCases(set, plan.goalLifecycle.goalId);
  if (!cases.length || contentHash(cases.map(item => item.id + ":case-validation").sort()) !== contentHash([...plan.requirementIds].sort()))
    throw new Error("Goal repair must cover every lifecycle case for its goal in the registered set. Inspect the original definitions[].spec.cases and requirement IDs; stop without resubmitting this plan.");
  return { ...set.spec, cases };
}

/** The actor, original lifecycle inputs and the independently specified cuts bound the completion repair. */
export function goalLifecycleReadKeys(goal: CharacterGoal, cases: ReturnType<typeof goalLifecycleCases> = [], actionSchemas?: SceneReviewCatalog["actionSchemas"]): string[] {
  const refs = new Set(worldRepairReferenceKeys(goal, actionSchemas));
  refs.delete("character-goal:" + goal.id);
  for (const item of cases) for (const scenario of item.scenarios) {
    for (const key of worldRepairReferenceKeys(scenario.seed.delta)) refs.add(key);
    for (const id of scenario.knownClaimIds) refs.add("claim:" + id);
    for (const id of [...scenario.realizedEventIds, ...scenario.experiencedEventIds]) refs.add("canonical-event:" + id);
  }
  return [...refs].sort();
}

export type GoalLifecycleReview = { spec: SceneCapabilitySpec; catalog: SceneReviewCatalog };

export function restoreGoalCompletion(goal: CharacterGoal, raw: unknown) {
  const { completion, ...submitted } = raw as Record<string, unknown>;
  const { completion: _old, ...fields } = goal;
  const modelFields = JSON.parse(JSON.stringify(fields, (k, v) => ["evidence", "counterEvidence", "evidenceAssertions"].includes(k) ? undefined : v));
  if (contentHash(submitted) !== contentHash(modelFields))
    throw new Error("Goal repair changed fields outside /completion. Use read_upstream_repair_context and copy readable[].payload for the goal, omitting host evidence. Correct this same slot once; stop on scope change.");
  return { ...goal, completion };
}

/** Reuse the independent scenario evaluator against the exact draft, before it can be committed. */
export function checkGoalLifecycleDraft(plan: UpstreamRepairPlan, review: GoalLifecycleReview | undefined, bytes: Buffer,
  goal: CharacterGoal, assertions: readonly EvidenceAssertion[]) {
  const scope = plan.goalLifecycle;
  if (!scope || !review || goal.actorId !== scope.actorId || goal.id !== scope.goalId)
    throw new Error("Goal lifecycle scope or registered review changed. Stop this stage and inspect the original plan.");
  if (goalEvidenceHash(assertions.filter(a => !isCompletionEvidence(a))) !== scope.retainedEvidenceHash)
    throw new Error("Unrelated goal evidence changed. Preserve the original bindings and stop for host review.");
  const completion = assertions.filter(isCompletionEvidence);
  const anchors = review.spec.cases.flatMap(item => item.evidence);
  if (!goal.completion?.length || completion.some(a => a.target.artifactKind !== "character-goal" || a.target.artifactId !== goal.id
    || !a.anchors.every(anchor => anchors.some(range => anchor.sourceId === range.sourceId && anchor.startByte >= range.startByte && anchor.endByte <= range.endByte)))
    || goal.completion.some((_, index) => !completion.some(a => a.target.jsonPointer === "/completion/" + index && a.relation === "supports" && a.strength !== "weak-inference")))
    throw new Error("Each completion predicate needs exact supports evidence at /completion/<index> inside a registered lifecycle case anchor. Read read_upstream_repair_context, copy evidence[].segmentId and correct the same slot once if the source supports it. Stop for source review otherwise.");
  const goals = new Map(review.catalog.goals);
  goals.set(goal.id, goal);
  const result = evaluateSceneCapabilities(review.spec, bytes, { ...review.catalog, goals });
  if (!result.verified) throw new Error("Goal completion failed the independent lifecycle cases: " +
    result.cases.flatMap(item => item.issues.map(issue => item.id + ": " + issue.message)).join("; ") +
    ". Inspect this same slot and its source in read_upstream_repair_context. Correct once only with new source support; do not change the specification or retry unchanged.");
}
