import { applyEventExecutions, validateEventExecutions } from "../world/event-execution.js";
import { z } from "zod";
import { resolveActionInvocation } from "../world/action-ontology.js";
import { contentHash } from "../world/canonical.js";
import { deriveCharacterEntrySeed } from "../world/entry-context.js";
import { deriveEntryCut } from "../world/entry-cut.js";
import { validateEffectObligations } from "../world/effect-obligations.js";
import { predicateSchema, type CanonicalEvent, type ValidationIssue } from "../world/model.js";
import { applyStateDelta, DEFAULT_STATE_FIELDS, emptyWorldState, StateSchemaRegistry } from "../world/state.js";
import { findSpatialRoute, resolveActiveSpatialRelations } from "../world/spatial-ontology.js";
import { timeAdvanceInDays } from "../world/time.js";
import { validateSceneOccurrenceCatalog } from "../world/scene-occurrence.js";
import { buildPreparedClosure } from "./closure.js";
import type { PreparedNovelBundle } from "./prepared-cache.js";
import { majorRoleCandidates, type RoleRoster } from "./role-roster.js";

export const sceneExecutionContractSchema = z.object({
  sceneId: z.string(), revisionHash: z.string(), actualOccurrenceEventIds: z.array(z.string()), participantIds: z.array(z.string()),
  entryCutIds: z.array(z.string()), requiredEntityIds: z.array(z.string()), requiredPredicateIds: z.array(z.string()),
  requiredMechanismIds: z.array(z.string()), knowledgeAcquisitionRefs: z.array(z.string()),
  terminationConditions: z.array(predicateSchema), blockingIssueIds: z.array(z.string()),
}).strict();
export type SceneExecutionContract = z.infer<typeof sceneExecutionContractSchema>;

/** Derive a source-scoped execution package. Never invent action authority from an observed outcome. */
export function buildSceneExecutionContracts(bundle: PreparedNovelBundle, roster: RoleRoster | null = bundle.compilerSnapshot.roleRoster) {
  const canonical = bundle.canonical, graph = buildPreparedClosure(bundle);
  const entities = new Map(canonical.entities.map((entity) => [entity.id, entity])), events = new Map(canonical.events.map((event) => [event.id, event]));
  const schemas = new Map(canonical.actionSchemas.map((schema) => [schema.id, schema]));
  const issues = validateSceneOccurrenceCatalog({ entities, events, scenes: canonical.sceneOccurrences });
  const major = new Set(roster ? majorRoleCandidates(roster).flatMap((role) => role.entityId ? [role.entityId] : []) : []);
  issues.push(...validateEventExecutions(canonical.eventExecutions ?? [], { events, entities, actionSchemas: schemas, participations: canonical.eventParticipations }));
  const actual = applyEventExecutions(canonical.events, canonical.eventExecutions ?? []).filter((event) => event.narrativeContext?.mode !== "hypothetical");
  for (const event of actual) if (event.participants.some((id) => major.has(id)) && !event.sceneOccurrenceIds?.length) issues.push({ code: "SCENE_EXECUTION_COVERAGE_MISSING", message: `Major-character event ${event.id} has no accepted scene execution package`, path: `event/${event.id}` });
  const contracts = canonical.sceneOccurrences.map((scene): SceneExecutionContract => {
    const sceneEvents = actual.filter((event) => scene.eventIds.includes(event.id) || event.sceneOccurrenceIds?.includes(scene.id));
    const local: ValidationIssue[] = [], fail = (code: string, message: string) => local.push({ code, message, path: `scene/${scene.id}` });
    const participantIds = [...new Set([...scene.presentActorIds, ...sceneEvents.flatMap((event) => event.participants)])].sort();
    const entryCutIds: string[] = [], mechanisms = new Set<string>();
    for (const actor of participantIds.filter((id) => major.has(id))) {
      try { const seed = deriveCharacterEntrySeed(bundle, actor); entryCutIds.push(seed.cut.hash); local.push(...seed.cut.issues); }
      catch (error) { fail("SCENE_MAJOR_ENTRY_MISSING", `${actor}: ${String(error)}`); }
    }
    if (participantIds.some((id) => major.has(id)) && !scene.exitConditions.length) fail("SCENE_TERMINATION_UNSPECIFIED", `Major scene ${scene.id} requires explicit exit conditions`);
    for (const event of sceneEvents) {
      const physical = event.observedOutcome.operations.some((operation) => "field" in operation && !["character.plan", "character.momentum"].includes(operation.field));
      if (event.action?.lane === "schema-bound") {
        mechanisms.add(event.action.schemaId);
        const schema = schemas.get(event.action.schemaId), actorId = event.action.roleBindings.find((binding) => binding.roleId === schema?.initiatorRoleId)?.entityIds[0];
        if (!actorId || !event.participants.includes(actorId)) fail("SCENE_ACTION_INITIATOR_MISSING", `Event ${event.id} has no participating initiator bound to its mechanism`);
        local.push(...resolveActionInvocation(event.action, schemas, entities, { actorId, participants: event.participants, proposedDelta: event.observedOutcome,
          hasKnowledge: Boolean(event.observedKnowledge?.operations.length), hasTimeAdvance: Boolean(event.timeAdvance), hasSceneTransition: false }).issues.map((issue) => ({ ...issue, path: `scene/${scene.id}/event/${event.id}` })));
        if (schema?.induction.kind === "source-pattern" && !bundle.compilerSnapshot.evidenceBindings.some((binding) => binding.artifactKind === "action-schema" && binding.artifactId === schema.id)) fail("SCENE_MECHANISM_EVIDENCE_MISSING", `Source mechanism ${schema.id} has no exact support binding`);
      } else if (physical && canonical.eventParticipations.some((participation) => participation.eventId === event.id && participation.role === "agent" && major.has(participation.entityId))) {
        const agents = canonical.eventParticipations.filter((participation) => participation.eventId === event.id && participation.role === "agent");
        // Movement has an existing host mechanism: the active route and its
        // mode, guards and elapsed duration. Do not demand two travel episodes
        // to invent an additional action schema for an already-proven route.
        const actor = agents.length === 1 ? agents[0]!.entityId : undefined;
        if (actor && event.action?.travelMode) {
          const travel = validateSceneTravel(bundle, event, actor);
          local.push(...travel.issues.map((issue) => ({ ...issue, path: `scene/${scene.id}/event/${event.id}` })));
          travel.relationIds.forEach((id) => mechanisms.add(`spatial/${id}`));
        } else fail("SCENE_EXECUTABLE_MECHANISM_MISSING", `Observed effects in event ${event.id} do not establish a reusable action mechanism`);
      }
      for (const knowledge of event.observedKnowledge?.operations ?? []) if (knowledge.op === "learn" && (!knowledge.propositionId || !knowledge.acquisitionMode)) fail("SCENE_KNOWLEDGE_PATH_MISSING", `Event ${event.id} has an acquisition without its proposition and epistemic path`);
    }
    const nodeKeys = new Set([`scene/${scene.id}`, ...sceneEvents.map((event) => `event/${event.id}`), ...[...mechanisms].map((id) => id.startsWith("spatial/") ? id : `action/${id}`)]);
    const nodeIndex = new Map(graph.nodes.map((node) => [`${node.kind}/${node.id}`, node]));
    const pending = [...nodeKeys];
    while (pending.length) for (const ref of nodeIndex.get(pending.pop()!)?.dependsOn ?? []) {
      if (["source", "unit", "roster"].includes(ref.kind)) continue;
      const dependency = `${ref.kind}/${ref.id}`;
      if (!nodeKeys.has(dependency)) { nodeKeys.add(dependency); pending.push(dependency); }
    }
    const nodes = graph.nodes.filter((node) => nodeKeys.has(`${node.kind}/${node.id}`));
    const dependencies = nodes.flatMap((node) => node.dependsOn);
    local.push(...graph.issues.filter((issue) => issue.path && nodeKeys.has(issue.path)));
    issues.push(...local);
    return { sceneId: scene.id, revisionHash: contentHash({ scene, nodes, entryCutIds }), actualOccurrenceEventIds: sceneEvents.map((event) => event.id).sort(), participantIds, entryCutIds: [...new Set(entryCutIds)].sort(),
      requiredEntityIds: [...new Set([...participantIds, ...dependencies.filter((ref) => ref.kind === "entity").map((ref) => ref.id)])].sort(),
      requiredPredicateIds: [...new Set([...scene.entryConditions, ...scene.exitConditions, ...sceneEvents.flatMap((event) => event.preconditions)].map(contentHash))].sort(),
      requiredMechanismIds: [...mechanisms].sort(), knowledgeAcquisitionRefs: sceneEvents.flatMap((event) => (event.observedKnowledge?.operations ?? []).map((_, index) => `${event.id}/observedKnowledge/operations/${index}`)),
      terminationConditions: structuredClone(scene.exitConditions), blockingIssueIds: local.map(contentHash).sort() };
  });
  return { contracts, issues };
}

export function validateSceneTravel(bundle: PreparedNovelBundle, event: CanonicalEvent, actorId: string): { issues: ValidationIssue[]; relationIds: string[] } {
  const canonical = bundle.canonical, opening = canonical.initialWorld;
  const checkpoint = event.characterEntryCheckpoints?.find((cut) => cut.actorId === actorId && cut.projectionSeed);
  const cut = deriveEntryCut({ events: canonical.events, relations: canonical.eventRelations,
    beforeEventId: event.id, storyTime: event.storyTime, baselineEventId: opening.checkpoint?.beforeCanonicalEventId,
    baselineTime: opening.checkpoint?.storyTime, completeCheckpoint: Boolean(checkpoint) });
  if (cut.issues.length) return { issues: cut.issues, relationIds: [] };
  try {
    const entities = new Map(canonical.entities.map((entity) => [entity.id, entity]));
    const rules = new Map(canonical.rules.map((rule) => [rule.id, rule]));
    const registry = new StateSchemaRegistry(DEFAULT_STATE_FIELDS);
    const seed = checkpoint?.projectionSeed ?? opening.projectionSeed;
    let before = emptyWorldState(contentHash({ source: bundle.source, cut }));
    before.activeRuleIds = [...(seed?.activeRuleIds ?? [])];
    before.logicalTime = { step: 0, elapsedDays: seed?.elapsedDays ?? 0, storyTime: event.storyTime };
    before = applyStateDelta(before, checkpoint?.delta ?? opening.delta, registry, entities, rules);
    for (const id of cut.replayEventIds) {
      const prior = canonical.events.find((candidate) => candidate.id === id)!;
      before = applyStateDelta(before, prior.observedOutcome, registry, entities, rules);
      before.logicalTime.elapsedDays = (before.logicalTime.elapsedDays ?? 0) + timeAdvanceInDays(prior.timeAdvance);
    }
    const after = applyStateDelta(before, event.observedOutcome, registry, entities, rules);
    after.logicalTime = { ...before.logicalTime, elapsedDays: (before.logicalTime.elapsedDays ?? 0) + timeAdvanceInDays(event.timeAdvance) };
    const realized = new Set(cut.completedEventIds);
    const issues = validateEffectObligations({ proposal: { source: "actor", actorId, action: event.action }, before, after,
      context: { entities, rules, stateSchema: registry, spatialOntologyVersion: "spatial-v1", spatialRelations: canonical.spatialRelations }, realizedCanonicalEventIds: realized });
    const from = before.values[actorId]?.["character.location"], to = after.values[actorId]?.["character.location"];
    const route = typeof from === "string" && typeof to === "string" && from !== to
      ? findSpatialRoute(resolveActiveSpatialRelations(canonical.spatialRelations, { state: before, realizedCanonicalEventIds: realized }), from, to, event.action?.travelMode) : undefined;
    if (!route) issues.push({ code: "SCENE_TRAVEL_WITNESS_MISSING", message: `Event ${event.id} has no actual route-backed movement` });
    return { issues, relationIds: issues.length ? [] : route?.relationIds ?? [] };
  } catch (error) { return { issues: [{ code: "SCENE_TRAVEL_STATE_UNPROVEN", message: `${event.id}: ${String(error)}` }], relationIds: [] }; }
}
