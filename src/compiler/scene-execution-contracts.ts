import { applyEventExecutions, validateEventExecutions } from "../world/event-execution.js";
import { z } from "zod";
import { resolveActionInvocation } from "../world/action-ontology.js";
import { contentHash } from "../world/canonical.js";
import { deriveCharacterEntrySeed } from "../world/entry-context.js";
import { predicateSchema, type ValidationIssue } from "../world/model.js";
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
        fail("SCENE_EXECUTABLE_MECHANISM_MISSING", `Observed effects in event ${event.id} do not establish a reusable action mechanism`);
      }
      for (const knowledge of event.observedKnowledge?.operations ?? []) if (knowledge.op === "learn" && (!knowledge.propositionId || !knowledge.acquisitionMode)) fail("SCENE_KNOWLEDGE_PATH_MISSING", `Event ${event.id} has an acquisition without its proposition and epistemic path`);
    }
    const nodeKeys = new Set([`scene/${scene.id}`, ...sceneEvents.map((event) => `event/${event.id}`), ...[...mechanisms].map((id) => `action/${id}`)]);
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
