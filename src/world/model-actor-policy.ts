import { z } from "zod";
import { contentHash } from "./canonical.js";
import {
  evaluateCharacterGoal,
  goalSupportedInCurrentPhase,
  type ActorProposalCandidate,
  type CharacterGoal,
  type CharacterModel,
  type EffectiveCharacterModel,
} from "./actors.js";
import {
  actorVisibleCharacterDevelopment,
  projectCharacterDevelopment,
  type CharacterDevelopmentView,
  type CharacterLifeStage,
} from "./development.js";
import type { WorldEngine } from "./engine.js";
import { actionableKnowledgeClaimIds, KnowledgeProjector } from "./knowledge.js";
import { knowledgeDeltaSchema, predicateSchema, stateDeltaSchema, type EvidenceRef } from "./model.js";
import {
  buildActorScopedActionContext,
  createPlayerActionModelBoundary,
  playerActionCandidateSchema,
  playerActionTranslationContext,
  validatePlayerActionGrounding,
  validatePlayerActionScope,
  validatePlayerActionSpatialScope,
  type ActorScopedActionContext,
  type PlayerActionTranslationContext,
} from "./player-action.js";
import { committedHistory, experiencedCanonicalEvents, realizedCanonicalEvents } from "./scene.js";
import { AmbiguousLegacySourceError, evidenceBelongsExclusivelyToSource, resolveCommitSourceId } from "./source-scope.js";
import { immutableClone } from "../util/immutable.js";
import { modelVisibleCharacterOntology, type ModelVisibleCharacterOntology } from "./character-ontology.js";
import { modelVisibleRelationshipOntology, type ModelVisibleRelationshipOntology } from "./relationship-ontology.js";

export const actorActionTemplateSchema = z
  .object({
    title: z.string().min(1),
    participants: z.array(z.string()).default([]),
    preconditions: z.array(predicateSchema).default([]),
    proposedDelta: stateDeltaSchema,
    proposedKnowledge: knowledgeDeltaSchema.optional(),
    rationale: z.string().optional(),
  })
  .strict();
export type ActorActionTemplate = z.infer<typeof actorActionTemplateSchema>;

export type ModelActorGoalView = {
  description: string;
  priority: number;
  targetIds: string[];
};

export type ModelActorDevelopmentView = {
  ageYears?: number;
  lifeStage?: CharacterLifeStage;
  recentExperiences: Array<{
    summary: string;
    progressChannels: string[];
  }>;
};

export type ModelActorDispositionView = Pick<EffectiveCharacterModel, "traits" | "decisionBiases"> & {
  dispositions?: ModelVisibleCharacterOntology["dispositions"];
  appraisals?: ModelVisibleCharacterOntology["appraisals"];
  development?: ModelVisibleCharacterOntology["development"];
  relationships?: ModelVisibleRelationshipOntology;
};

export type ModelActorWorldView = {
  actorId: ActorScopedActionContext["actorId"];
  selfState: ActorScopedActionContext["selfState"];
  ownedEntityState: ActorScopedActionContext["ownedEntityState"];
  knowledge: ActorScopedActionContext["knowledge"];
  presentEntities: ActorScopedActionContext["presentEntities"];
  referenceableEntities: ActorScopedActionContext["referenceableEntities"];
  spatialRelations: ActorScopedActionContext["spatialRelations"];
  writableEntityIds: ActorScopedActionContext["writableEntityIds"];
  writableStateFields: ActorScopedActionContext["writableStateFields"];
  scene: Omit<ActorScopedActionContext["scene"], "beat">;
  recentVisibleEvents: Array<Pick<ActorScopedActionContext["recentVisibleEvents"][number], "summary">>;
  activeThreads: ActorScopedActionContext["activeThreads"];
};

/**
 * Complete model-reasoner input. All entity/claim IDs are turn-local opaque
 * handles. It deliberately omits commit/time IDs,
 * compiler evidence, inactive/future model phases, canonical triggers, raw
 * goal action templates, and omniscient state.
 */
export type ActorReasoningInput = {
  actor: ModelActorWorldView;
  goal: ModelActorGoalView;
  model: ModelActorDispositionView | null;
  development: ModelActorDevelopmentView;
};

export type ActorReasoner = (
  input: ActorReasoningInput,
) => Promise<ActorActionTemplate | null> | ActorActionTemplate | null;

export function modelActorProposalSource(
  engine: WorldEngine,
  options: {
    goals: () => Promise<readonly CharacterGoal[]>;
    modelFor: (actorId: string) => Promise<CharacterModel | null>;
    reasoner: ActorReasoner;
    maxActorsPerRefresh?: number;
  },
): (input: { branchId: string; commitId: string }) => Promise<readonly ActorProposalCandidate[]> {
  const knowledge = new KnowledgeProjector(engine);
  const maxActors = options.maxActorsPerRefresh ?? 20;
  if (!Number.isInteger(maxActors) || maxActors <= 0 || maxActors > 100) throw new Error("maxActorsPerRefresh must be 1..100");

  return async ({ branchId, commitId }) => {
    const [context, state, history] = await Promise.all([
      engine.contextForCommit(commitId),
      engine.projector.project(commitId),
      committedHistory(engine, commitId),
    ]);
    let activeSourceId: string | undefined;
    try {
      activeSourceId = await resolveCommitSourceId(engine, context, commitId, undefined, "Model actor scheduler");
    } catch (error) {
      if (error instanceof AmbiguousLegacySourceError) return [];
      throw error;
    }
    const belongsToActiveWorld = (evidence: Parameters<typeof evidenceBelongsExclusivelyToSource>[0]) => activeSourceId
      ? evidenceBelongsExclusivelyToSource(evidence, activeSourceId)
      : evidence.length === 0;
    const goals = [...(context.actorGoals ?? await options.goals())]
      .filter((goal) => belongsToActiveWorld(goal.evidence))
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
      .slice(0, maxActors);
    const candidates: ActorProposalCandidate[] = [];
    const developmentByActor = new Map<string, Promise<CharacterDevelopmentView>>();
    for (const goal of goals) {
      const entity = context.entities.get(goal.actorId);
      if (!entity || entity.kind !== "character") continue;
      if (!belongsToActiveWorld(entity.evidence) || !belongsToActiveWorld(goal.evidence)) continue;
      const actorHistory = history.filter((entry) => !entry.event.evidence.length
        || belongsToActiveWorld(entry.event.evidence));
      const realizedCanonicalEventIds = realizedCanonicalEvents(actorHistory);
      const experiencedCanonicalEventIds = experiencedCanonicalEvents(actorHistory, goal.actorId, context.events);
      const rawActor = await knowledge.view(goal.actorId, commitId);
      const known = actionableKnowledgeClaimIds(rawActor, activeSourceId);
      if (!evaluateCharacterGoal(goal, {
        state,
        knownClaimIds: known,
        realizedCanonicalEventIds,
        experiencedCanonicalEventIds,
        storyTime: state.logicalTime.storyTime,
      }).active || !goalSupportedInCurrentPhase(goal, actorHistory, goal.actorId)) continue;

      const candidateModel = context.actorModels
        ? context.actorModels.get(goal.actorId) ?? null
        : await options.modelFor(goal.actorId);
      const model = candidateModel
        && belongsToActiveWorld(candidateModel.evidence)
        ? candidateModel
        : null;
      let developmentPromise = developmentByActor.get(goal.actorId);
      if (!developmentPromise) {
        developmentPromise = projectCharacterDevelopment(engine, goal.actorId, commitId, {
          goals,
          model,
        });
        developmentByActor.set(goal.actorId, developmentPromise);
      }
      const development = await developmentPromise;
      const scoped = await buildActorScopedActionContext(engine, goal.actorId, commitId, undefined, activeSourceId);
      const referenceable = new Set(scoped.referenceableEntities.map(({ id }) => id));
      const boundary = createPlayerActionModelBoundary(playerActionTranslationContext(scoped));
      const modelScoped = boundary.context as unknown as PlayerActionTranslationContext;
      const entityHandles = new Map(scoped.referenceableEntities.flatMap((entity, index) => {
        const handle = modelScoped.referenceableEntities[index]?.id;
        return handle ? [[entity.id, handle] as const] : [];
      }));
      const visibleDevelopment = actorVisibleCharacterDevelopment(development, []);
      const visibleOntology = development.model
        ? modelVisibleCharacterOntology(development.model, (entityId) => entityHandles.get(entityId))
        : undefined;
      const visibleRelationships = development.model
        ? modelVisibleRelationshipOntology(development.model, (entityId) => entityHandles.get(entityId))
        : undefined;
      const actor: ModelActorWorldView = {
        actorId: modelScoped.actorId,
        selfState: structuredClone(modelScoped.selfState),
        ownedEntityState: structuredClone(modelScoped.ownedEntityState),
        knowledge: structuredClone(modelScoped.knowledge),
        presentEntities: structuredClone(modelScoped.presentEntities),
        referenceableEntities: structuredClone(modelScoped.referenceableEntities),
        spatialRelations: structuredClone(modelScoped.spatialRelations),
        writableEntityIds: [...modelScoped.writableEntityIds],
        writableStateFields: structuredClone(modelScoped.writableStateFields),
        scene: {
          ...(modelScoped.scene.label ? { label: modelScoped.scene.label } : {}),
          ...(modelScoped.scene.locationId ? { locationId: modelScoped.scene.locationId } : {}),
          locationState: structuredClone(modelScoped.scene.locationState),
          presentEntityIds: [...modelScoped.scene.presentEntityIds],
        },
        recentVisibleEvents: modelScoped.recentVisibleEvents.map(({ summary }) => ({ summary })),
        activeThreads: structuredClone(modelScoped.activeThreads),
      };
      const output = await options.reasoner(immutableClone({
        actor,
        goal: {
          description: goal.description,
          priority: goal.priority,
          targetIds: (goal.targetIds ?? [])
            .filter((id) => referenceable.has(id))
            .flatMap((id) => entityHandles.get(id) ?? []),
        },
        model: development.model
          ? {
              traits: structuredClone(development.model.traits),
              decisionBiases: structuredClone(development.model.decisionBiases),
              ...(visibleOntology?.dispositions.length ? { dispositions: structuredClone(visibleOntology.dispositions) } : {}),
              ...(visibleOntology?.appraisals.length ? { appraisals: structuredClone(visibleOntology.appraisals) } : {}),
              ...(visibleOntology?.development.length ? { development: structuredClone(visibleOntology.development) } : {}),
              ...(visibleRelationships?.length ? { relationships: structuredClone(visibleRelationships) } : {}),
            }
          : null,
        development: {
          ...(visibleDevelopment.ageYears !== undefined ? { ageYears: visibleDevelopment.ageYears } : {}),
          ...(visibleDevelopment.lifeStage ? { lifeStage: structuredClone(visibleDevelopment.lifeStage) } : {}),
          recentExperiences: visibleDevelopment.recentExperiences.map((experience) => ({
            summary: experience.summary,
            progressChannels: [...experience.progressChannels],
          })),
        },
      }));
      if (!output) continue;
      const encodedAction = actorActionTemplateSchema.parse(output);
      const candidate = boundary.decodeCandidate(playerActionCandidateSchema.parse({
        title: encodedAction.title,
        participants: encodedAction.participants,
        preconditions: encodedAction.preconditions,
        proposedDelta: encodedAction.proposedDelta,
        ...(encodedAction.proposedKnowledge ? { proposedKnowledge: encodedAction.proposedKnowledge } : {}),
        requiresKnowledge: [],
        forbidsKnowledge: [],
      }));
      const capabilityIssues = [
        ...validatePlayerActionScope(candidate, scoped),
        ...validatePlayerActionGrounding(candidate, scoped),
        ...await validatePlayerActionSpatialScope(engine, candidate, goal.actorId, commitId, activeSourceId),
      ];
      if (capabilityIssues.length) continue;
      const participants = [...new Set([goal.actorId, ...candidate.participants])];
      const evidence: EvidenceRef[] = goal.evidence;
      candidates.push({
        goalId: goal.id,
        priority: goal.priority,
        proposal: {
          proposalId: `actor-model-${contentHash({ goal: goal.id, branchId, commitId, candidate }).slice(0, 24)}`,
          branchId,
          expectedParentCommit: commitId,
          source: "actor",
          actorId: goal.actorId,
          title: `Validated actor action by ${entity.canonicalName}`,
          participants,
          proposedTime: state.logicalTime.storyTime ?? { kind: "unknown" },
          preconditions: candidate.preconditions,
          proposedDelta: candidate.proposedDelta,
          ...(candidate.proposedKnowledge ? { proposedKnowledge: candidate.proposedKnowledge } : {}),
          causalParents: [],
          evidence,
        },
      });
    }
    return candidates;
  };
}
