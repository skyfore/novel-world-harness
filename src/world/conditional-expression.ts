import { resolveActiveSpatialRelations, spatialLocationsMayOverlap } from "./spatial-ontology.js";
import { agencySpeechEnvelope, projectAgencyChannels } from "./agency-profile.js";
import { evidenceBelongsExclusivelyToSource } from "./source-scope.js";
import { contentHash } from "./canonical.js";
import { evaluateCharacterGoal, goalSupportedInCurrentPhase, type CharacterGoal } from "./actors.js";
import type { WorldModelContext } from "./engine.js";
import type { EvidenceAssertion, SpokenUtterance, ValidationIssue, ActionInvocation, Predicate, WorldState } from "./model.js";
import type { WorldProjectionBundle } from "./projection-service.js";
import { isActionableKnowledge } from "./knowledge.js";
import { experiencedCanonicalEvents, realizedCanonicalEvents } from "./scene.js";
import { evaluatePredicateTruth } from "./state.js";
import { deriveAdHocAction } from "./action-invocation.js";

type Action = NonNullable<CharacterGoal["candidateAction"]>;
type Catalog = Pick<WorldModelContext, "utteranceExpressions" | "claims" | "entities">;
type Before = Pick<WorldProjectionBundle, "state" | "knowledge" | "history" | "processes">;
const actions = (goal: CharacterGoal) => [goal.candidateAction, ...(goal.actionPatterns ?? [])];
const recovery = " Preserve the branch head and stop this candidate. Rebuild it from the same frozen goal and actor knowledge; do not guess references, remove expression bindings or retry unchanged.";

function relationshipScope(predicate: Predicate, context: Catalog, goal: CharacterGoal, addressees: readonly string[], state?: WorldState): boolean {
  if (predicate.op === "all" || predicate.op === "any") return predicate.items.length > 0 && predicate.items.every(item => relationshipScope(item, context, goal, addressees, state));
  if (predicate.op === "not") return relationshipScope(predicate.item, context, goal, addressees, state);
  return "entityId" in predicate && context.entities.get(predicate.entityId)?.kind === "relationship"
    && predicate.field.startsWith("relationship.")
    && (!state || state.values[predicate.entityId]?.["relationship.from"] === goal.actorId
      && addressees.includes(String(state.values[predicate.entityId]?.["relationship.to"])));
}

/** The existing frozen goal owns motivation and action gates; no second policy store. */
export function validateGoalExpressions(goal: CharacterGoal, context: Catalog): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  actions(goal).forEach((action, actionIndex) => action?.expressionCandidates?.forEach((candidate, candidateIndex) => {
    const path = `${actionIndex === 0 ? "candidateAction" : `actionPatterns.${actionIndex - 1}`}.expressionCandidates.${candidateIndex}`;
    const fail = (code: string, message: string) => issues.push({ code, message, path });
    const expression = context.utteranceExpressions?.get(candidate.expressionId);
    if (!expression) {
      fail("GOAL_EXPRESSION_MISSING", "Expression is absent. In this source use find_compiler_artifacts (kind utterance-expression), copy results[].readArguments.ref into read_compiler_artifact.ref, then payload.id into expressionId; at most one corrected retry. Stop if absent; do not guess or retry unchanged.");
      return;
    }
    if (expression.modality !== "speech" || expression.speakerId !== goal.actorId || !expression.addresseeIds.length
      || expression.addresseeIds.some(id => context.entities.get(id)?.kind !== "character" || !action.participants?.includes(id))) {
      fail("GOAL_EXPRESSION_PARTICIPANTS", "A spoken candidate needs its original speaker and all character addressees in the action participants.");
    }
    if (expression.fragments.some(fragment => fragment.text !== fragment.text.trim() || fragment.text.length > 2_000)) {
      fail("GOAL_EXPRESSION_LENGTH", "Each exact fragment must fit one untrimmed spoken occurrence; refine the source-supported expression, never silently crop it.");
    }
    if (candidate.relationshipConditions.some(predicate => !relationshipScope(predicate, context, goal, expression.addresseeIds))) {
      fail("GOAL_EXPRESSION_RELATIONSHIP", "Relationship conditions must address explicit relationship fields; unrelated world predicates belong in action preconditions.");
    }
    const claims = candidate.requiredKnowledgeClaimIds.map(id => context.claims?.get(id));
    if (claims.some(claim => !claim)) {
      fail("GOAL_EXPRESSION_KNOWLEDGE", "Required knowledge must reference existing same-source claims; source existence alone is not speaker knowledge.");
    }
    const sameSource = (evidence: CharacterGoal["evidence"]) => evidence.length > 0 && evidence.every(ref => ref.span.sourceId === expression.quotation.anchor.sourceId);
    if (!sameSource(goal.evidence) || claims.some(claim => claim && !sameSource(claim.evidence))) {
      fail("GOAL_EXPRESSION_SOURCE", "Goal, content knowledge and expression must belong to the same source.");
    }
  }));
  return issues;
}

/** New links and conditions require their own source selectors at proposal/finish validation. */
export function validateGoalExpressionEvidence(goal: CharacterGoal, assertions: readonly EvidenceAssertion[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  actions(goal).forEach((action, actionIndex) => action?.expressionCandidates?.forEach((candidate, candidateIndex) => {
    const prefix = `/${actionIndex === 0 ? "candidateAction" : `actionPatterns/${actionIndex - 1}`}/expressionCandidates/${candidateIndex}`;
    const paths = [`${prefix}/expressionId`, ...candidate.requiredKnowledgeClaimIds.map((_, i) => `${prefix}/requiredKnowledgeClaimIds/${i}`), ...candidate.relationshipConditions.map((_, i) => `${prefix}/relationshipConditions/${i}`)];
    for (const path of paths) if (!assertions.some(item => item.target.artifactKind === "character-goal" && item.target.artifactId === goal.id
      && item.target.jsonPointer === path && item.relation === "supports" && item.strength !== "weak-inference" && item.anchors.length)) {
      issues.push({ code: "GOAL_EXPRESSION_EVIDENCE_REQUIRED", path, message: "Conditional expression links and gates require exact source support. Inspect the same-source segment, add its supported selector and make at most one corrected proposal; stop if unsupported, without deleting the condition." });
    }
  }));
  return issues;
}

export function expressionActionConditionsSatisfied(goal: CharacterGoal, action: Action, context: WorldModelContext, before: Pick<Before, "state" | "knowledge">): boolean {
  if (!action.expressionCandidates) return true;
  if (validateGoalExpressions(goal, context).length) return false;
  const facts = before.knowledge.actors[goal.actorId] ?? {};
  // Familiarity with the content is distinct from accepting it. A source-backed
  // goal can motivate denial or deception; the utterance never upgrades belief.
  return action.expressionCandidates.every(candidate => candidate.requiredKnowledgeClaimIds.every(id => facts[id] && facts[id]!.reception?.understood !== false)
    && candidate.requiredKnowledgeClaimIds.some(id => facts[id]?.propositionId === context.utteranceExpressions!.get(candidate.expressionId)!.propositionId)
    && candidate.relationshipConditions.every(predicate => relationshipScope(predicate, context, goal, context.utteranceExpressions!.get(candidate.expressionId)!.addresseeIds, before.state)
      && evaluatePredicateTruth(before.state, predicate, context.stateSchema) === "true"));
}

/** Host-only: future source wording is never sent to an actor model for selection. */
export function conditionalExpressionUtterances(goal: CharacterGoal, actionIndex: number, context: WorldModelContext, before: Before): SpokenUtterance[] | undefined {
  const action = actions(goal)[actionIndex];
  if (!action?.expressionCandidates) return [];
  if (validateGoalExpressions(goal, context).length) return undefined;
  // Mutable actor-store fallback cannot authorize source words on a frozen branch.
  if (!context.actorGoals?.some(item => item.id === goal.id && contentHash(item) === contentHash(goal))) return undefined;
  const known = new Set(Object.values(before.knowledge.actors[goal.actorId] ?? {}).filter(isActionableKnowledge).map(fact => fact.claimId));
  if (!evaluateCharacterGoal(goal, {
    state: before.state, knownClaimIds: known,
    realizedCanonicalEventIds: realizedCanonicalEvents(before.history),
    experiencedCanonicalEventIds: experiencedCanonicalEvents(before.history, goal.actorId, context.events),
    storyTime: before.state.logicalTime.storyTime,
  }).active || !goalSupportedInCurrentPhase(goal, before.history, goal.actorId)) return undefined;
  if (!action.preconditions.every(predicate => evaluatePredicateTruth(before.state, predicate, context.stateSchema) === "true")) return undefined;
  if (!expressionActionConditionsSatisfied(goal, action, context, before)) return undefined;
  const result: SpokenUtterance[] = [];
  action.expressionCandidates.forEach((candidate, candidateIndex) => {
    const expression = context.utteranceExpressions!.get(candidate.expressionId)!;
    expression.fragments.forEach((fragment, fragmentIndex) => result.push({
      speakerId: expression.speakerId, addresseeIds: [...expression.addresseeIds], content: fragment.text, channel: "audible",
      expressionBinding: { expressionId: expression.id, expressionRevision: contentHash(expression), goalId: goal.id,
        goalRevision: contentHash(goal), actionIndex, candidateIndex, fragmentIndex },
    }));
  });
  const actor = context.entities.get(goal.actorId)!;
  const channelView = conditionalChannelView(goal.actorId, context, before);
  const spatialRelations = resolveActiveSpatialRelations(context.spatialRelations ?? [], { state: before.state, realizedCanonicalEventIds: realizedCanonicalEvents(before.history) });
  for (const utterance of result) {
    const needsRemote = actor.agencyProfile && actor.agencyProfile.embodiment !== "bodily"
      || utterance.addresseeIds.some(id => {
        const peer = context.entities.get(id);
        if (peer?.agencyProfile && peer.agencyProfile.embodiment !== "bodily") return true;
        const here = before.state.values[goal.actorId]?.["character.location"], there = before.state.values[id]?.["character.location"];
        return Boolean(actor.agencyProfile && typeof here === "string" && typeof there === "string" && !spatialLocationsMayOverlap(spatialRelations, here, there));
      });
    if (!needsRemote) continue;
    const eligible = channelView?.channels.filter(channel => ["audio", "audiovisual"].includes(channel.modality)
      && utterance.addresseeIds.every(id => channel.peerEntityIds.includes(id))) ?? [];
    // A compiled goal cannot guess between live channels or sessions.
    if (eligible.length !== 1) return undefined;
    utterance.channelBinding = { channelId: eligible[0]!.id, processId: eligible[0]!.processId };
  }
  return result.length <= 32 ? result : undefined;
}

/** Used both before commitment and before replay effects; current-event learning cannot authorize speech. */
export function validateConditionalUtterances(event: { actorId?: string; spokenUtterances?: SpokenUtterance[]; action?: ActionInvocation }, context: WorldModelContext, before: Before): ValidationIssue[] {
  const bound = event.spokenUtterances?.filter(item => item.expressionBinding) ?? [];
  if (!bound.length) return [];
  const binding = bound[0]!.expressionBinding!;
  const goal = context.actorGoals?.find(item => item.id === binding.goalId);
  const fail = (code: string, message: string): ValidationIssue[] => [{ code, message: message + recovery, path: "spokenUtterances" }];
  if (!goal || goal.actorId !== event.actorId || contentHash(goal) !== binding.goalRevision) return fail("CONDITIONAL_EXPRESSION_GOAL", "Speech requires its exact frozen speaker goal.");
  const expected = conditionalExpressionUtterances(goal, binding.actionIndex, context, before);
  if (!expected?.length) return fail("CONDITIONAL_EXPRESSION_INELIGIBLE", "Current motivation, knowledge, relationship or action conditions do not authorize this expression.");
  if (contentHash(bound) !== contentHash(expected)) return fail("CONDITIONAL_EXPRESSION_BINDING", "Expression revision, exact words, participants, fragment order and count must match the frozen candidate.");
  const action: Action | undefined = actions(goal)[binding.actionIndex];
  const expectedAction = action?.action ?? (action ? deriveAdHocAction({ kind: "speak", description: action.title, delta: action.proposedDelta, preconditions: action.preconditions }) : undefined);
  if (contentHash(event.action ?? null) !== contentHash(expectedAction ?? null)) return fail("CONDITIONAL_EXPRESSION_ACTION", "Speech must preserve its bound action invocation.");
  return [];
}

function conditionalChannelView(actorId: string, context: WorldModelContext, before: Before) {
  const actor = context.entities.get(actorId);
  if (!actor) return undefined;
  return projectAgencyChannels(actor, before.processes, context, { sourceId: context.sourceId,
    visibleEntityIds: new Set([...context.entities.values()].filter(entity => evidenceBelongsExclusivelyToSource(entity.evidence, context.sourceId)).map(entity => entity.id)),
    knownClaimIds: new Set(Object.values(before.knowledge.actors[actorId] ?? {}).filter(isActionableKnowledge).map(fact => fact.claimId)),
  });
}

export function conditionalSpeechEnvelope(utterances: readonly SpokenUtterance[], context: WorldModelContext, before: Before) {
  if (!utterances.some(utterance => utterance.channelBinding)) return undefined;
  const actorId = utterances[0]!.speakerId;
  return agencySpeechEnvelope(utterances, conditionalChannelView(actorId, context, before)?.channels ?? []);
}
