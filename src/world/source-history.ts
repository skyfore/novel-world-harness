import { replayEntryKnowledge } from "./entry-knowledge.js";
import { validateSemanticEffect } from "./semantic-effect.js";
import { capacityUseIssues, incapacityOnsets, incapacityRecoveries, validateIncapacityChanges } from "./process-capacity.js";
import { materializeProcessProposal } from "./process-ontology.js";
import { contentHash } from "./canonical.js";
import { deriveEntryCut } from "./entry-cut.js";
import { validateEventProposal, type WorldModelContext } from "./engine.js";
import { applyEventExecutions } from "./event-execution.js";
import { applyKnowledgeDelta, emptyKnowledgeState } from "./knowledge.js";
import type { CanonicalEvent, WorldState } from "./model.js";
import { applyBranchSemanticDelta, emptyBranchSemanticState } from "./semantic-effects.js";
import { applyProcessDelta, emptyProcessState } from "./process-effects.js";
import { applyNormDelta, emptyNormState } from "./norm-effects.js";
import { isNormativeWorldRule } from "./world-rule-ontology.js";
import { applyStateDelta, DEFAULT_STATE_FIELDS, emptyWorldState, StateSchemaRegistry, validateEngineInvariants } from "./state.js";
import type { PreparedNovelBundle } from "../compiler/prepared-cache.js";

/** A scene cut is tied to this occurrence, never to the actor's first playable scene. */
export function executeSceneEvent(bundle: PreparedNovelBundle, target: CanonicalEvent, actorId?: string, options: { beforeOnly?: boolean; ignoreCheckpoint?: boolean; sourceEventRevisions?: ReadonlyMap<string, string> } = {}) {
  const c = bundle.canonical, opening = c.initialWorld;
  const events = applyEventExecutions(c.events, c.eventExecutions ?? []);
  const event = events.find((item) => item.id === target.id) ?? target;
  const checkpoint = options.ignoreCheckpoint ? undefined : event.characterEntryCheckpoints?.find((item) => item.actorId === actorId && item.projectionSeed);
  const cut = deriveEntryCut({ events, relations: c.eventRelations, beforeEventId: event.id, storyTime: event.storyTime,
    baselineEventId: opening.checkpoint?.beforeCanonicalEventId, baselineTime: opening.checkpoint?.storyTime,
    completeCheckpoint: Boolean(checkpoint) });
  if (cut.issues.length) throw new Error(cut.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "));
  const context: WorldModelContext = {
    initialWorld: opening, eventExecutions: new Map((c.eventExecutions ?? []).map(binding => [binding.id, binding])),
    sourceId: bundle.source.id, entities: new Map(c.entities.map((item) => [item.id, item])), rules: new Map(c.rules.map((item) => [item.id, item])),
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS), events: new Map(events.map((item) => [item.id, item])),
    claims: new Map(c.claims.map((item) => [item.id, item])), propositions: new Map(c.propositions.map((item) => [item.id, item])), attributions: new Map(c.attributions.map((item) => [item.id, item])),
    sourceEventRevisions: options.sourceEventRevisions ?? new Map(c.events.map(event => [event.id, contentHash(event)])),
    semanticEffects: new Map((c.semanticEffects ?? []).map(item => [item.id, item])),
    acquisitions: new Map((c.acquisitions ?? []).map(item => [item.id, item])), utteranceExpressions: new Map((c.utteranceExpressions ?? []).map(item => [item.id, item])), perceptionObservations: new Map((c.perceptionObservations ?? []).map(item => [item.id, item])),
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
  const processContext = { entities: context.entities, templates: context.processTemplates! };
  let processes = emptyProcessState(state.atCommit);
  if (seed) {
    processes = applyProcessDelta(emptyProcessState(state.atCommit), seed.processes, { entities: context.entities, templates: context.processTemplates!, allowHistoricalStarts: true }, provenance, state.logicalTime.elapsedDays ?? 0);
    applyNormDelta(emptyNormState(state.atCommit), seed.norms, { entities: context.entities, templates: context.normTemplates!, postState: state,
      normativeRuleIds: new Set(c.rules.filter(isNormativeWorldRule).map((rule) => rule.id)) }, provenance);
  }
  const knowledgeContext = { acquisitions: context.acquisitions, utteranceExpressions: context.utteranceExpressions, perceptionObservations: context.perceptionObservations, entities: context.entities, claims: context.claims, propositions: context.propositions, attributions: context.attributions, branchSemantics: semantics };
  let knowledge = emptyKnowledgeState(state.atCommit);
  const initialKnowledge = checkpoint?.knowledge ?? (!checkpoint ? opening.knowledge : undefined);
  const initialCapacityIssues = capacityUseIssues({ knowledge: seed?.knowledgeHistory ? undefined : initialKnowledge }, processes, processes, processContext.templates, context.perceptionObservations);
  if (initialCapacityIssues.length) throw new Error(initialCapacityIssues.map(issue => `${issue.code}: ${issue.message}`).join("; "));
  if (seed?.knowledgeHistory) knowledge = replayEntryKnowledge(seed.knowledgeHistory, context, cut.completedEventIds, initialKnowledge, state.atCommit);
  else if (initialKnowledge) knowledge = applyKnowledgeDelta(knowledge, initialKnowledge, state.atCommit, { ...knowledgeContext, currentCanonicalEventIds: new Set<string>(), realizedCanonicalEventIds: new Set<string>() });
  const aliases = new Map(events.map((occurrence) => [occurrence.id, new Set([occurrence.id])]));
  for (const relation of c.eventRelations.filter((item) => item.type === "coreference" && item.status !== "contested")) {
    const group = new Set([...(aliases.get(relation.fromEventId) ?? []), ...(aliases.get(relation.toEventId) ?? [])]);
    for (const id of group) aliases.set(id, group);
  }
  // Every alias of a replayed occurrence is still future until that occurrence executes.
  const pendingIds = new Set(cut.replayEventIds.flatMap((id) => [...(aliases.get(id) ?? [id])]));
  const realized = new Set(cut.completedEventIds.filter((id) => !pendingIds.has(id)));
  const execute = (occurrence: CanonicalEvent, before: WorldState) => {
    const meaningIssues = [...(context.semanticEffects?.values() ?? [])].filter(effect => effect.canonicalEventId === occurrence.id).flatMap(effect => validateSemanticEffect(effect, {
      entities: context.entities, events: new Map(c.events.map(item => [item.id, item])), processTemplates: context.processTemplates,
      actionSchemas: context.actionSchemas, eventExecutions: new Map((c.eventExecutions ?? []).map(item => [item.id, item])),
      eventParticipations: new Map(c.eventParticipations.map(item => [item.id, item])),
    }));
    if (meaningIssues.length) throw new Error(meaningIssues.map(issue => `${issue.code}: ${issue.message}`).join("; "));
    const schema = occurrence.action?.lane === "schema-bound" ? context.actionSchemas?.get(occurrence.action.schemaId) : undefined;
    const initiator = occurrence.action?.lane === "schema-bound" ? occurrence.action.roleBindings.find((role) => role.roleId === schema?.initiatorRoleId)?.entityIds[0]
      : c.eventParticipations.find((participation) => participation.eventId === occurrence.id && participation.role === "agent")?.entityId;
    const useIssues = capacityUseIssues({ actorId: initiator }, processes, processes, processContext.templates);
    if (useIssues.length) throw new Error(useIssues.map(issue => `${issue.code}: ${issue.message}`).join("; "));
    const result = validateEventProposal({ proposalId: `scene-${occurrence.id}`, branchId: "scene-validation", expectedParentCommit: before.atCommit,
      source: initiator ? "actor" : "canon-candidate", possibilityId: `canon-${occurrence.id}`, ...(initiator ? { actorId: initiator } : {}), title: occurrence.title, participants: occurrence.participants,
      proposedTime: occurrence.storyTime, preconditions: occurrence.preconditions, proposedDelta: occurrence.observedOutcome,
      ...(occurrence.observedKnowledge ? { proposedKnowledge: occurrence.observedKnowledge } : {}), ...(occurrence.action ? { action: occurrence.action } : {}),
      ...(occurrence.timeAdvance ? { timeAdvance: occurrence.timeAdvance } : {}), causalParents: occurrence.causalParents, evidence: occurrence.evidence,
    }, before.atCommit, before, context, { knowledge, branchSemantics: semantics, realizedCanonicalEventIds: realized, deferMateriality: true });
    if (!result.report.accepted || !result.postState) throw new Error(result.report.errors.map((issue) => `${issue.code}: ${issue.message}`).join("; "));
    const onsets = incapacityOnsets(context.semanticEffects?.values() ?? [], new Set([occurrence.id]), processContext.templates);
    const processOperations = [...onsets, ...incapacityRecoveries(c.eventExecutions ?? [], new Set([occurrence.id]), processes, processContext.templates, occurrence.action)];
    const processDelta = processOperations.length ? materializeProcessProposal({ version: 1, operations: processOperations }, {
      branchId: "scene-validation", parentCommitId: before.atCommit, proposalHash: contentHash(occurrence),
      templates: processContext.templates, elapsedDays: result.postState.logicalTime.elapsedDays ?? 0,
    }).delta : { version: 1 as const, operations: [] };
    const eventProvenance = { commitId: before.atCommit, eventId: occurrence.id, eventHash: contentHash(occurrence) };
    validateIncapacityChanges({ actorId: initiator, action: occurrence.action }, processDelta, processes, processContext, before, result.postState, eventProvenance, onsets);
    const afterProcesses = applyProcessDelta(processes, processDelta, processContext, eventProvenance, result.postState.logicalTime.elapsedDays ?? 0);
    const receiptIssues = capacityUseIssues({ knowledge: occurrence.observedKnowledge }, processes, afterProcesses, processContext.templates, context.perceptionObservations);
    if (receiptIssues.length) throw new Error(receiptIssues.map(issue => `${issue.code}: ${issue.message}`).join("; "));
    processes = afterProcesses;
    if (occurrence.observedKnowledge) knowledge = applyKnowledgeDelta(knowledge, occurrence.observedKnowledge, before.atCommit, { ...knowledgeContext, currentCanonicalEventIds: new Set([occurrence.id]), realizedCanonicalEventIds: new Set([...realized, occurrence.id]), perceptionOccurrence: { eventIds: new Set([occurrence.id]), before, after: result.postState, schema: context.stateSchema } });
    return result.postState;
  };
  for (const id of cut.replayEventIds) { state = execute(context.events!.get(id)!, state); for (const alias of aliases.get(id) ?? [id]) realized.add(alias); }
  const before = state, beforeProcesses = processes, beforeKnowledge = knowledge, after = options.beforeOnly ? before : execute(event, before);
  return { cut, before, after, context, knowledge, beforeKnowledge, beforeProcesses, processes, hash: contentHash({ cut, before, beforeProcesses, beforeKnowledge, actorId: actorId ?? null }) };
}
