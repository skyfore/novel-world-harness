import { z } from "zod";
import { contentHash } from "./canonical.js";
import {
  actorCoordinationSchema,
  evaluateCharacterGoal,
  goalSupportedInCurrentPhase,
  normalizeActorCoordination,
  type ActorCoordination,
  type ActorProposalCandidate,
  type ActorProposalSource,
  type ActorSalienceTrace,
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
import { actionInvocationSchema, knowledgeDeltaSchema, predicateSchema, stateDeltaSchema, type ActionInvocation, type EvidenceRef } from "./model.js";
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
import type { ActorBranchSemanticView } from "./semantic-effects.js";
import { processOwnerEntityIds } from "./process-ontology.js";
import { evaluatePredicate } from "./state.js";

export const actorActionTemplateSchema = z
  .object({
    title: z.string().min(1),
    participants: z.array(z.string()).default([]),
    preconditions: z.array(predicateSchema).default([]),
    proposedDelta: stateDeltaSchema,
    proposedKnowledge: knowledgeDeltaSchema.optional(),
    action: actionInvocationSchema.optional(),
    coordination: actorCoordinationSchema.optional(),
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
  branchAppraisals?: Array<{ targetKind: "entity" | "event" | "proposition"; targetId?: string; dimensionId: string; value: number }>;
  branchRelationships?: Array<{ direction: "outgoing" | "incoming"; counterpartyId: string; dimensions: Record<string, number> }>;
  branchObligations?: Array<{ role: "debtor" | "creditor"; counterpartyId?: string; kindId: string; description: string; status: string }>;
};

type RuntimeActorGoal = {
  id: string;
  actorId: string;
  description: string;
  priority: number;
  targetIds: string[];
  evidence: EvidenceRef[];
  canonical?: CharacterGoal;
  causalEventId?: string;
};

export type ModelActorNormView = {
  name: string;
  modality: "obligation" | "prohibition" | "permission";
  role: "subject" | "beneficiary";
  status: "active" | "violated";
  dueInDays?: number;
};

export type ModelActorProcessView = {
  name: string;
  phase: string;
  status: "running" | "paused";
  progress: number;
  dueInDays?: number;
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
  activeNorms: ModelActorNormView[];
  activeProcesses: ModelActorProcessView[];
  decision?: ActorScopedActionContext["decision"];
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
    maxModelCallsPerRefresh?: number;
  },
): ActorProposalSource {
  const knowledge = new KnowledgeProjector(engine);
  const configuredActorBudget = options.maxActorsPerRefresh ?? 4;
  const configuredModelCallBudget = options.maxModelCallsPerRefresh ?? 1;
  if (!Number.isInteger(configuredActorBudget) || configuredActorBudget <= 0 || configuredActorBudget > 32) {
    throw new Error("maxActorsPerRefresh must be 1..32");
  }
  if (!Number.isInteger(configuredModelCallBudget) || configuredModelCallBudget < 0 || configuredModelCallBudget > 8) {
    throw new Error("maxModelCallsPerRefresh must be 0..8");
  }

  return async ({ branchId, commitId, maxActors, maxModelCalls }) => {
    const actorBudget = Math.min(configuredActorBudget, checkedBudget(maxActors ?? configuredActorBudget, "maxActors", 32));
    const modelCallBudget = Math.min(configuredModelCallBudget, checkedBudget(maxModelCalls ?? configuredModelCallBudget, "maxModelCalls", 8));
    if (actorBudget === 0) return [];
    const [context, projection, history] = await Promise.all([
      engine.contextForCommit(commitId),
      engine.projections.project(commitId),
      committedHistory(engine, commitId),
    ]);
    const state = projection.state;
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
    const canonicalGoals = [...(context.actorGoals ?? await options.goals())]
      .filter((goal) => belongsToActiveWorld(goal.evidence))
      .map((goal): RuntimeActorGoal => ({
        id: goal.id,
        actorId: goal.actorId,
        description: goal.description,
        priority: goal.priority,
        targetIds: [...(goal.targetIds ?? [])],
        evidence: [...goal.evidence],
        canonical: goal,
      }));
    const branchGoals = Object.values(projection.semantics.goals)
      .filter((goal) => goal.status === "open")
      .map((goal): RuntimeActorGoal => ({
        id: goal.id,
        actorId: goal.actorId,
        description: goal.description,
        priority: goal.priority,
        targetIds: [...goal.targetEntityIds],
        evidence: [],
        causalEventId: goal.introducedBy.eventId,
      }));
    const actorHistory = history.filter((entry) => !entry.event.evidence.length
      || belongsToActiveWorld(entry.event.evidence));
    const realizedCanonicalEventIds = realizedCanonicalEvents(actorHistory);
    const knowledgeByActor = new Map<string, Awaited<ReturnType<KnowledgeProjector["view"]>>>();
    const activeGoals: Array<{ goal: RuntimeActorGoal; knownClaimIds: ReadonlySet<string> }> = [];
    for (const goal of [...canonicalGoals, ...branchGoals]
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))) {
      const entity = context.entities.get(goal.actorId);
      if (!entity || entity.kind !== "character" || !belongsToActiveWorld(entity.evidence)) continue;
      let rawActor = knowledgeByActor.get(goal.actorId);
      if (!rawActor) {
        rawActor = await knowledge.view(goal.actorId, commitId);
        knowledgeByActor.set(goal.actorId, rawActor);
      }
      const knownClaimIds = actionableKnowledgeClaimIds(rawActor, activeSourceId);
      if (goal.canonical) {
        const experiencedCanonicalEventIds = experiencedCanonicalEvents(actorHistory, goal.actorId, context.events);
        if (!evaluateCharacterGoal(goal.canonical, {
          state,
          knownClaimIds,
          realizedCanonicalEventIds,
          experiencedCanonicalEventIds,
          storyTime: state.logicalTime.storyTime,
        }).active || !goalSupportedInCurrentPhase(goal.canonical, actorHistory, goal.actorId)) continue;
      }
      activeGoals.push({ goal, knownClaimIds });
    }
    const selected = selectSalientActors(activeGoals, projection, actorHistory)
      .slice(0, actorBudget);
    const candidates: ActorProposalCandidate[] = [];
    const developmentByActor = new Map<string, Promise<CharacterDevelopmentView>>();
    let modelCalls = 0;
    for (const selectedGoal of selected) {
      const { goal, salience, knownClaimIds } = selectedGoal;
      const entity = context.entities.get(goal.actorId);
      if (!entity || entity.kind !== "character") continue;
      const scoped = await buildActorScopedActionContext(engine, goal.actorId, commitId, undefined, activeSourceId);
      const referenceable = new Set(scoped.referenceableEntities.map(({ id }) => id));
      referenceable.add(goal.actorId);

      const compiled = goal.canonical
        ? await firstValidCompiledAction({
            engine,
            goal: goal.canonical,
            actorId: goal.actorId,
            commitId,
            activeSourceId,
            state,
            scoped,
          })
        : undefined;
      if (compiled) {
        candidates.push(actorCandidateFromAction({
          branchId,
          commitId,
          goal,
          actorName: entity.canonicalName,
          candidate: compiled.candidate,
          ...(compiled.action ? { action: compiled.action } : {}),
          coordination: normalizeActorCoordination(goal.actorId, compiled.coordination),
          candidateSource: "compiled-action",
          salience,
          proposedTime: state.logicalTime.storyTime,
        }));
        continue;
      }
      if (modelCalls >= modelCallBudget) continue;
      modelCalls += 1;

      const candidateModel = context.actorModels
        ? context.actorModels.get(goal.actorId) ?? null
        : await options.modelFor(goal.actorId);
      const model = candidateModel && belongsToActiveWorld(candidateModel.evidence) ? candidateModel : null;
      let developmentPromise = developmentByActor.get(goal.actorId);
      if (!developmentPromise) {
        developmentPromise = projectCharacterDevelopment(engine, goal.actorId, commitId, {
          goals: canonicalGoals.flatMap((candidate) => candidate.canonical ? [candidate.canonical] : []),
          model,
        });
        developmentByActor.set(goal.actorId, developmentPromise);
      }
      const development = await developmentPromise;
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
      const visibleBranch = modelVisibleBranchSemantics(development.branchSemantics, goal.actorId, entityHandles);
      const activeNorms = modelVisibleNorms(goal.actorId, knownClaimIds, projection, context.normTemplates ?? new Map());
      const activeProcesses = modelVisibleProcesses(goal.actorId, projection, context.processTemplates ?? new Map());
      const actor: ModelActorWorldView = {
        ...(modelScoped.decision ? { decision: structuredClone(modelScoped.decision) } : {}),
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
        activeNorms: modelScoped.decision?.norms.map(({ id: _id, templateId: _templateId, ...item }) => item) ?? activeNorms,
        activeProcesses: modelScoped.decision?.processes.map(({ id: _id, templateId: _templateId, ...item }) => item) ?? activeProcesses,
      };
      let output: ActorActionTemplate | null;
      try {
        output = await options.reasoner(immutableClone({
          actor,
          goal: {
            description: goal.description,
            priority: goal.priority,
            targetIds: goal.targetIds
              .filter((id) => referenceable.has(id))
              .flatMap((id) => entityHandles.get(id) ?? []),
          },
          model: development.model || hasVisibleBranchSemantics(visibleBranch)
            ? {
                traits: structuredClone(development.model?.traits ?? {}),
                decisionBiases: structuredClone(development.model?.decisionBiases ?? {}),
                ...(visibleOntology?.dispositions.length ? { dispositions: structuredClone(visibleOntology.dispositions) } : {}),
                ...(visibleOntology?.appraisals.length ? { appraisals: structuredClone(visibleOntology.appraisals) } : {}),
                ...(visibleOntology?.development.length ? { development: structuredClone(visibleOntology.development) } : {}),
                ...(visibleRelationships?.length ? { relationships: structuredClone(visibleRelationships) } : {}),
                ...(visibleBranch.branchAppraisals.length ? { branchAppraisals: visibleBranch.branchAppraisals } : {}),
                ...(modelScoped.decision?.relationships.length ? { branchRelationships: modelScoped.decision.relationships.map((item) => ({ direction: "outgoing" as const, counterpartyId: item.counterpartyId, dimensions: item.dimensions })) } : {}),
                ...(visibleBranch.branchObligations.length ? { branchObligations: visibleBranch.branchObligations } : {}),
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
      } catch {
        continue;
      }
      if (!output) continue;
      try {
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
        if (capabilityIssues.length || !candidateHasMaterialEffect(candidate)) continue;
        const action = encodedAction.action ? decodeActionInvocation(encodedAction.action, boundary) : undefined;
        if (action && actionEntityIds(action).some((id) => !referenceable.has(id))) continue;
        const participants = [...new Set([goal.actorId, ...candidate.participants])];
        const coordination = decodeCoordination(encodedAction.coordination, boundary);
        if (!coordinationIsInScope(coordination, participants, referenceable, context.entities)) continue;
        candidates.push(actorCandidateFromAction({
          branchId,
          commitId,
          goal,
          actorName: entity.canonicalName,
          candidate,
          ...(action ? { action } : {}),
          coordination: normalizeActorCoordination(goal.actorId, coordination),
          candidateSource: "model-reasoner",
          salience,
          proposedTime: state.logicalTime.storyTime,
        }));
      } catch {
        // Model output is an untrusted proposal. A malformed or out-of-scope
        // candidate consumes its bounded call but cannot abort the world move.
        continue;
      }
    }
    return candidates;
  };
}

type SelectedActorGoal = {
  goal: RuntimeActorGoal;
  knownClaimIds: ReadonlySet<string>;
  salience: ActorSalienceTrace;
};

function selectSalientActors(
  goals: readonly { goal: RuntimeActorGoal; knownClaimIds: ReadonlySet<string> }[],
  projection: Awaited<ReturnType<WorldEngine["projections"]["project"]>>,
  history: Awaited<ReturnType<typeof committedHistory>>,
): SelectedActorGoal[] {
  const bestByActor = new Map<string, { goal: RuntimeActorGoal; knownClaimIds: ReadonlySet<string> }>();
  for (const entry of goals) {
    const current = bestByActor.get(entry.goal.actorId);
    if (!current || entry.goal.priority > current.goal.priority
      || (entry.goal.priority === current.goal.priority && entry.goal.id.localeCompare(current.goal.id) < 0)) {
      bestByActor.set(entry.goal.actorId, entry);
    }
  }
  const elapsedDays = projection.state.logicalTime.elapsedDays ?? 0;
  const latest = history.at(-1)?.event;
  const latestLocations = new Set((latest?.participants ?? []).flatMap((id) => {
    const location = projection.state.values[id]?.["character.location"];
    return typeof location === "string" ? [location] : [];
  }));
  const selected = [...bestByActor.values()].map(({ goal, knownClaimIds }): SelectedActorGoal => {
    const dueNormCount = Object.values(projection.norms.instances).filter((instance) =>
      instance.subjectActorId === goal.actorId
      && instance.status === "active"
      && instance.dueAtElapsedDays !== undefined
      && instance.dueAtElapsedDays <= elapsedDays).length;
    const dueProcessCount = Object.values(projection.processes.instances).filter((instance) =>
      processOwnerEntityIds(instance).includes(goal.actorId)
      && instance.status === "running"
      && instance.dueAtElapsedDays !== undefined
      && instance.dueAtElapsedDays <= elapsedDays).length;
    const latestEventParticipant = Boolean(latest?.participants.includes(goal.actorId));
    const actorLocation = projection.state.values[goal.actorId]?.["character.location"];
    const currentScene = latestEventParticipant || (typeof actorLocation === "string" && latestLocations.has(actorLocation));
    const distance = [...history].reverse().findIndex(({ event }) => event.actorId === goal.actorId);
    const cooldownPenalty = distance < 0 ? 0 : Math.max(0, 1 - distance / 8);
    const tier = dueNormCount || dueProcessCount ? 0 : latestEventParticipant ? 1 : currentScene ? 2 : 3;
    return {
      goal,
      knownClaimIds,
      salience: {
        tier,
        dueNormCount,
        dueProcessCount,
        latestEventParticipant,
        currentScene,
        goalPriority: goal.priority,
        cooldownPenalty,
      },
    };
  });
  return selected.sort((left, right) => left.salience.tier - right.salience.tier
    || right.salience.dueNormCount - left.salience.dueNormCount
    || right.salience.dueProcessCount - left.salience.dueProcessCount
    || right.goal.priority - left.goal.priority
    || left.salience.cooldownPenalty - right.salience.cooldownPenalty
    || left.goal.actorId.localeCompare(right.goal.actorId)
    || left.goal.id.localeCompare(right.goal.id));
}

async function firstValidCompiledAction(input: {
  engine: WorldEngine;
  goal: CharacterGoal;
  actorId: string;
  commitId: string;
  activeSourceId?: string;
  state: Awaited<ReturnType<WorldEngine["projector"]["project"]>>;
  scoped: ActorScopedActionContext;
}): Promise<{ candidate: ReturnType<typeof playerActionCandidateSchema.parse>; action?: ActionInvocation; coordination?: ActorCoordination } | undefined> {
  for (const action of [input.goal.candidateAction, ...(input.goal.actionPatterns ?? [])]) {
    if (!action || !action.preconditions.every((predicate) => evaluatePredicate(input.state, predicate))) continue;
    const candidate = playerActionCandidateSchema.parse({
      title: action.title,
      participants: action.participants ?? [],
      preconditions: action.preconditions,
      proposedDelta: action.proposedDelta,
      ...(action.proposedKnowledge ? { proposedKnowledge: action.proposedKnowledge } : {}),
      requiresKnowledge: [],
      forbidsKnowledge: [],
    });
    if (!candidateHasMaterialEffect(candidate)) continue;
    const issues = [
      ...validatePlayerActionScope(candidate, input.scoped),
      ...validatePlayerActionGrounding(candidate, input.scoped),
      ...await validatePlayerActionSpatialScope(input.engine, candidate, input.actorId, input.commitId, input.activeSourceId),
    ];
    if (!issues.length) return {
      candidate,
      ...(action.action ? { action: structuredClone(action.action) } : {}),
      ...(action.coordination ? { coordination: structuredClone(action.coordination) } : {}),
    };
  }
  return undefined;
}

function actorCandidateFromAction(input: {
  branchId: string;
  commitId: string;
  goal: RuntimeActorGoal;
  actorName: string;
  candidate: ReturnType<typeof playerActionCandidateSchema.parse>;
  action?: ActionInvocation;
  coordination: ActorCoordination;
  candidateSource: "compiled-action" | "model-reasoner";
  salience: ActorSalienceTrace;
  proposedTime?: ActorProposalCandidate["proposal"]["proposedTime"];
}): ActorProposalCandidate {
  const participants = [...new Set([input.goal.actorId, ...input.candidate.participants])];
  const causalRelations = input.goal.causalEventId ? [{
    fromEventId: input.goal.causalEventId,
    type: "motivates" as const,
    operationality: "motivational" as const,
    actorId: input.goal.actorId,
    goalId: input.goal.id,
    description: "Committed branch goal motivates this actor action",
  }] : [];
  return {
    goalId: input.goal.id,
    priority: input.goal.priority,
    candidateSource: input.candidateSource,
    salience: input.salience,
    coordination: input.coordination,
    proposal: {
      proposalId: `actor-${input.candidateSource}-${contentHash({ goal: input.goal.id, branchId: input.branchId, commitId: input.commitId, candidate: input.candidate, action: input.action, coordination: input.coordination }).slice(0, 24)}`,
      branchId: input.branchId,
      expectedParentCommit: input.commitId,
      source: "actor",
      actorId: input.goal.actorId,
      title: input.candidateSource === "compiled-action" ? input.candidate.title : `Validated actor action by ${input.actorName}`,
      participants,
      proposedTime: input.proposedTime ?? { kind: "unknown" },
      preconditions: input.candidate.preconditions,
      proposedDelta: input.candidate.proposedDelta,
      ...(input.candidate.proposedKnowledge ? { proposedKnowledge: input.candidate.proposedKnowledge } : {}),
      ...(input.action ? { action: input.action } : {}),
      causalRelations,
      causalParents: causalRelations.map((relation) => relation.fromEventId),
      evidence: input.goal.evidence,
    },
  };
}

function candidateHasMaterialEffect(candidate: ReturnType<typeof playerActionCandidateSchema.parse>): boolean {
  return candidate.proposedDelta.operations.length > 0
    || (candidate.proposedKnowledge?.operations.length ?? 0) > 0;
}

function decodeActionInvocation(
  action: ActionInvocation,
  boundary: ReturnType<typeof createPlayerActionModelBoundary>,
): ActionInvocation {
  if (action.lane === "schema-bound") return actionInvocationSchema.parse({
    ...structuredClone(action),
    roleBindings: action.roleBindings.map((binding) => ({
      ...binding,
      entityIds: binding.entityIds.map(boundary.decodeEntityId),
    })),
  });
  const mapAddress = <T extends { entityId: string }>(address: T): T => ({
    ...structuredClone(address),
    entityId: boundary.decodeEntityId(address.entityId),
  });
  return actionInvocationSchema.parse({
    ...structuredClone(action),
    footprint: {
      reads: action.footprint.reads.map(mapAddress),
      writes: action.footprint.writes.map(mapAddress),
      resources: action.footprint.resources.map(mapAddress),
    },
  });
}

function actionEntityIds(action: ActionInvocation): string[] {
  return action.lane === "schema-bound"
    ? action.roleBindings.flatMap((binding) => binding.entityIds)
    : [...action.footprint.reads, ...action.footprint.writes, ...action.footprint.resources].map((item) => item.entityId);
}

function decodeCoordination(
  value: ActorCoordination | undefined,
  boundary: ReturnType<typeof createPlayerActionModelBoundary>,
): ActorCoordination {
  return actorCoordinationSchema.parse({
    exclusiveParticipantIds: (value?.exclusiveParticipantIds ?? []).map(boundary.decodeEntityId),
    consentActorIds: (value?.consentActorIds ?? []).map(boundary.decodeEntityId),
    authorityEntityIds: (value?.authorityEntityIds ?? []).map(boundary.decodeEntityId),
  });
}

function coordinationIsInScope(
  value: ActorCoordination,
  participants: readonly string[],
  referenceable: ReadonlySet<string>,
  entities: ReadonlyMap<string, { kind: string }>,
): boolean {
  const participantSet = new Set(participants);
  return value.exclusiveParticipantIds.every((id) => participantSet.has(id))
    && value.consentActorIds.every((id) => participantSet.has(id) && entities.get(id)?.kind === "character")
    && value.authorityEntityIds.every((id) => referenceable.has(id));
}

function modelVisibleNorms(
  actorId: string,
  knownClaimIds: ReadonlySet<string>,
  projection: Awaited<ReturnType<WorldEngine["projections"]["project"]>>,
  templates: NonNullable<Awaited<ReturnType<WorldEngine["contextForCommit"]>>["normTemplates"]>,
): ModelActorNormView[] {
  const elapsedDays = projection.state.logicalTime.elapsedDays ?? 0;
  return Object.values(projection.norms.instances).flatMap((instance): ModelActorNormView[] => {
    if (instance.status !== "active" && instance.status !== "violated") return [];
    const role = instance.subjectActorId === actorId ? "subject" as const
      : instance.beneficiaryActorId === actorId ? "beneficiary" as const : undefined;
    if (!role) return [];
    const template = templates.get(instance.templateId);
    if (!template || template.visibility === "engine") return [];
    if (template.visibility === "knowledge" && !template.knownByClaimIds.every((claimId) => knownClaimIds.has(claimId))) return [];
    return [{
      name: template.name,
      modality: template.modality,
      role,
      status: instance.status,
      ...(instance.dueAtElapsedDays !== undefined ? { dueInDays: instance.dueAtElapsedDays - elapsedDays } : {}),
    }];
  }).sort((left, right) => (left.dueInDays ?? Number.POSITIVE_INFINITY) - (right.dueInDays ?? Number.POSITIVE_INFINITY)
    || left.name.localeCompare(right.name));
}

function modelVisibleProcesses(
  actorId: string,
  projection: Awaited<ReturnType<WorldEngine["projections"]["project"]>>,
  templates: NonNullable<Awaited<ReturnType<WorldEngine["contextForCommit"]>>["processTemplates"]>,
): ModelActorProcessView[] {
  const elapsedDays = projection.state.logicalTime.elapsedDays ?? 0;
  return Object.values(projection.processes.instances).flatMap((instance): ModelActorProcessView[] => {
    if (instance.status === "finished" || !processOwnerEntityIds(instance).includes(actorId)) return [];
    const template = templates.get(instance.templateId);
    if (!template || template.visibility === "engine" || template.visibility === "knowledge") return [];
    const phase = template.phases.find((item) => item.id === instance.phaseId)?.label;
    if (!phase) return [];
    return [{
      name: template.name,
      phase,
      status: instance.status,
      progress: instance.progress,
      ...(instance.dueAtElapsedDays !== undefined ? { dueInDays: instance.dueAtElapsedDays - elapsedDays } : {}),
    }];
  }).sort((left, right) => (left.dueInDays ?? Number.POSITIVE_INFINITY) - (right.dueInDays ?? Number.POSITIVE_INFINITY)
    || left.name.localeCompare(right.name));
}

function checkedBudget(value: number, label: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label} must be an integer between 0 and ${maximum}`);
  }
  return value;
}

function modelVisibleBranchSemantics(
  semantics: ActorBranchSemanticView,
  actorId: string,
  entityHandles: ReadonlyMap<string, string>,
): Required<Pick<ModelActorDispositionView, "branchAppraisals" | "branchRelationships" | "branchObligations">> {
  const branchAppraisals: NonNullable<ModelActorDispositionView["branchAppraisals"]> = [];
  for (const appraisal of semantics.appraisals) {
    if (appraisal.target.kind === "entity") {
      const targetId = entityHandles.get(appraisal.target.entityId);
      if (targetId) branchAppraisals.push({ targetKind: "entity", targetId, dimensionId: appraisal.dimensionId, value: appraisal.value });
      continue;
    }
    branchAppraisals.push({
      targetKind: appraisal.target.kind === "current-event" ? "event" : appraisal.target.kind,
      dimensionId: appraisal.dimensionId,
      value: appraisal.value,
    });
  }
  const branchRelationships = semantics.relationships.flatMap((relationship) => {
    const outgoing = relationship.fromActorId === actorId;
    const counterpartyId = entityHandles.get(outgoing ? relationship.toActorId : relationship.fromActorId);
    return counterpartyId ? [{
      direction: outgoing ? "outgoing" as const : "incoming" as const,
      counterpartyId,
      dimensions: structuredClone(relationship.dimensions),
    }] : [];
  });
  const branchObligations = semantics.obligations.map((obligation) => {
    const role = obligation.debtorActorId === actorId ? "debtor" as const : "creditor" as const;
    const counterparty = role === "debtor" ? obligation.creditorActorId : obligation.debtorActorId;
    const counterpartyId = counterparty ? entityHandles.get(counterparty) : undefined;
    return {
      role,
      ...(counterpartyId ? { counterpartyId } : {}),
      kindId: obligation.kindId,
      description: obligation.description,
      status: obligation.status,
    };
  });
  return { branchAppraisals, branchRelationships, branchObligations };
}

function hasVisibleBranchSemantics(
  value: ReturnType<typeof modelVisibleBranchSemantics>,
): boolean {
  return value.branchAppraisals.length > 0
    || value.branchRelationships.length > 0
    || value.branchObligations.length > 0;
}
