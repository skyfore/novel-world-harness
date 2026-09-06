import { contentHash } from "../world/canonical.js";
import { deriveEntryCut } from "../world/entry-cut.js";
import { validateEventProposal, type WorldModelContext } from "../world/engine.js";
import { applyEventExecutions } from "../world/event-execution.js";
import { applyKnowledgeDelta, emptyKnowledgeState } from "../world/knowledge.js";
import type { CanonicalEvent, WorldState } from "../world/model.js";
import { applyBranchSemanticDelta, emptyBranchSemanticState } from "../world/semantic-effects.js";
import { applyProcessDelta, emptyProcessState } from "../world/process-effects.js";
import { applyNormDelta, emptyNormState } from "../world/norm-effects.js";
import { isNormativeWorldRule } from "../world/world-rule-ontology.js";
import { applyStateDelta, DEFAULT_STATE_FIELDS, emptyWorldState, StateSchemaRegistry, validateEngineInvariants } from "../world/state.js";
import type { PreparedNovelBundle } from "./prepared-cache.js";

/** A scene cut is tied to this occurrence, never to the actor's first playable scene. */
export function executeSceneEvent(bundle: PreparedNovelBundle, target: CanonicalEvent, actorId?: string) {
  const c = bundle.canonical, opening = c.initialWorld;
  const events = applyEventExecutions(c.events, c.eventExecutions ?? []);
  const event = events.find((item) => item.id === target.id) ?? target;
  const checkpoint = event.characterEntryCheckpoints?.find((item) => item.actorId === actorId && item.projectionSeed);
  const cut = deriveEntryCut({ events, relations: c.eventRelations, beforeEventId: event.id, storyTime: event.storyTime,
    baselineEventId: opening.checkpoint?.beforeCanonicalEventId, baselineTime: opening.checkpoint?.storyTime,
    completeCheckpoint: Boolean(checkpoint) });
  if (cut.issues.length) throw new Error(cut.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "));
  const context: WorldModelContext = {
    sourceId: bundle.source.id, entities: new Map(c.entities.map((item) => [item.id, item])), rules: new Map(c.rules.map((item) => [item.id, item])),
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS), events: new Map(events.map((item) => [item.id, item])),
    claims: new Map(c.claims.map((item) => [item.id, item])), propositions: new Map(c.propositions.map((item) => [item.id, item])), attributions: new Map(c.attributions.map((item) => [item.id, item])),
    actionSchemas: new Map(c.actionSchemas.map((item) => [item.id, item])), actionConstraints: new Map(c.actionConstraints.map((item) => [item.id, item])),
    processTemplates: new Map(c.processTemplates.map((item) => [item.id, item])), normTemplates: new Map(c.normTemplates.map((item) => [item.id, item])),
    spatialOntologyVersion: "spatial-v1", spatialRelations: c.spatialRelations, eventRelations: c.eventRelations,
  };
  const seed = checkpoint?.projectionSeed ?? opening.projectionSeed;
  let state = emptyWorldState(contentHash({ source: bundle.source, cut }));
  state.logicalTime = { step: 0, elapsedDays: seed?.elapsedDays ?? 0, ...(checkpoint ? { storyTime: event.storyTime } : opening.checkpoint?.storyTime ? { storyTime: opening.checkpoint.storyTime } : {}) };
  state.activeRuleIds = [...(seed?.activeRuleIds ?? [])];
  state = applyStateDelta(state, checkpoint?.delta ?? opening.delta, context.stateSchema, context.entities, context.rules);
  const invariantErrors = validateEngineInvariants(state, context.stateSchema, context.entities, context.rules);
  if (invariantErrors.length) throw new Error(`SCENE_INITIAL_STATE_INVALID: ${invariantErrors.join("; ")}`);
  const provenance = { commitId: state.atCommit, eventId: "scene-cut", eventHash: contentHash(cut) };
  const semantics = seed ? applyBranchSemanticDelta(emptyBranchSemanticState(state.atCommit), seed.semantics, {
    entities: context.entities, canonicalPropositionIds: new Set(context.propositions?.keys()), canonicalAttributionIds: new Set(context.attributions?.keys()),
    canonicalClaimIds: new Set(context.claims?.keys()), canonicalGoalIds: new Set(c.goals.map((goal) => goal.id)), canonicalEventIds: new Set(context.events?.keys()), knownCommittedEventIds: new Set(),
  }, provenance) : emptyBranchSemanticState(state.atCommit);
  if (seed) {
    applyProcessDelta(emptyProcessState(state.atCommit), seed.processes, { entities: context.entities, templates: context.processTemplates! }, provenance, state.logicalTime.elapsedDays ?? 0);
    applyNormDelta(emptyNormState(state.atCommit), seed.norms, { entities: context.entities, templates: context.normTemplates!, postState: state,
      normativeRuleIds: new Set(c.rules.filter(isNormativeWorldRule).map((rule) => rule.id)) }, provenance);
  }
  const knowledgeContext = { entities: context.entities, claims: context.claims, propositions: context.propositions, attributions: context.attributions, branchSemantics: semantics };
  let knowledge = emptyKnowledgeState(state.atCommit);
  const initialKnowledge = checkpoint?.knowledge ?? (!checkpoint ? opening.knowledge : undefined);
  if (initialKnowledge) knowledge = applyKnowledgeDelta(knowledge, initialKnowledge, state.atCommit, knowledgeContext);
  const realized = new Set(cut.completedEventIds.filter((id) => !cut.replayEventIds.includes(id)));
  const execute = (occurrence: CanonicalEvent, before: WorldState) => {
    const schema = occurrence.action?.lane === "schema-bound" ? context.actionSchemas?.get(occurrence.action.schemaId) : undefined;
    const initiator = occurrence.action?.lane === "schema-bound" ? occurrence.action.roleBindings.find((role) => role.roleId === schema?.initiatorRoleId)?.entityIds[0]
      : c.eventParticipations.find((participation) => participation.eventId === occurrence.id && participation.role === "agent")?.entityId;
    const result = validateEventProposal({ proposalId: `scene-${occurrence.id}`, branchId: "scene-validation", expectedParentCommit: before.atCommit,
      source: initiator ? "actor" : "background", ...(initiator ? { actorId: initiator } : {}), title: occurrence.title, participants: occurrence.participants,
      proposedTime: occurrence.storyTime, preconditions: occurrence.preconditions, proposedDelta: occurrence.observedOutcome,
      ...(occurrence.observedKnowledge ? { proposedKnowledge: occurrence.observedKnowledge } : {}), ...(occurrence.action ? { action: occurrence.action } : {}),
      ...(occurrence.timeAdvance ? { timeAdvance: occurrence.timeAdvance } : {}), causalParents: occurrence.causalParents, evidence: occurrence.evidence,
    }, before.atCommit, before, context, { branchSemantics: semantics, realizedCanonicalEventIds: realized, deferMateriality: true });
    if (!result.report.accepted || !result.postState) throw new Error(result.report.errors.map((issue) => `${issue.code}: ${issue.message}`).join("; "));
    if (occurrence.observedKnowledge) knowledge = applyKnowledgeDelta(knowledge, occurrence.observedKnowledge, before.atCommit, knowledgeContext);
    return result.postState;
  };
  for (const id of cut.replayEventIds) { state = execute(context.events!.get(id)!, state); realized.add(id); }
  const before = state, after = execute(event, before);
  return { cut, before, after, context, knowledge, hash: contentHash({ cut, before, actorId: actorId ?? null }) };
}
