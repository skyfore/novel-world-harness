import {
  evaluateCharacterGoal,
  resolveCharacterModel,
  type CharacterGoal,
  type CharacterModel,
  type EffectiveCharacterModel,
} from "./actors.js";
import type { WorldEngine } from "./engine.js";
import { actionableKnowledgeClaimIds, KnowledgeProjector } from "./knowledge.js";
import type { LogicalTime, ProgressChannel, StoryTime } from "./model.js";
import { committedHistory, realizedCanonicalEvents } from "./scene.js";
import { evaluatePredicate } from "./state.js";
import { observeCommittedEvent } from "./actor-visible.js";
import { evidenceBelongsExclusivelyToSource, resolveCommitSourceId } from "./source-scope.js";
import { characterOntologyEvidence } from "./character-ontology.js";

export type CharacterLifeStage = {
  value: string;
  source: "explicit-state" | "generic-age-band";
};

export type CharacterLivedExperience = {
  eventId: string;
  atCommit: string;
  title: string;
  logicalTime: LogicalTime;
  participantIds: string[];
  progressChannels: ProgressChannel[];
};

export type CharacterDevelopmentView = {
  actorId: string;
  atCommit: string;
  storyTime?: StoryTime;
  elapsedDays: number;
  ageYears?: number;
  lifeStage?: CharacterLifeStage;
  experiencedEventIds: string[];
  experiencedCanonicalEventIds: string[];
  /** Bounded committed experience context for actor reasoning; never future canon. */
  recentLivedExperiences: CharacterLivedExperience[];
  knownClaimIds: string[];
  model?: EffectiveCharacterModel;
  activeGoalIds: string[];
  completedGoalIds: string[];
  expiredGoalIds: string[];
  achievedMilestoneIds: string[];
};

export type ActorVisibleCharacterDevelopment = {
  storyTime?: StoryTime;
  elapsedDays: number;
  ageYears?: number;
  lifeStage?: CharacterLifeStage;
  recentExperiences: Array<{
    summary: string;
    logicalTime: LogicalTime;
    progressChannels: ProgressChannel[];
  }>;
};

/**
 * A character's growth is a derived view over committed history, private
 * knowledge, and state. It is never a second mutable timeline.
 */
export async function projectCharacterDevelopment(
  engine: WorldEngine,
  actorId: string,
  commitId: string,
  overrides: { goals?: readonly CharacterGoal[]; model?: CharacterModel | null } = {},
): Promise<CharacterDevelopmentView> {
  const [context, state, history, actorView] = await Promise.all([
    engine.contextForCommit(commitId),
    engine.projector.project(commitId),
    committedHistory(engine, commitId),
    new KnowledgeProjector(engine).view(actorId, commitId),
  ]);
  const actor = context.entities.get(actorId);
  if (!actor || actor.kind !== "character") throw new Error(`Character development requires a character: ${actorId}`);
  const effectiveSourceId = await resolveCommitSourceId(engine, context, commitId, undefined, "Character development");
  if (!evidenceBelongsExclusivelyToSource(actor.evidence, effectiveSourceId)) {
    throw new Error(`Character ${actorId} is outside the active development source.`);
  }

  const knownClaimIds = actionableKnowledgeClaimIds(actorView, effectiveSourceId);
  const scopedHistory = history.filter((entry) => !entry.event.evidence.length
    || evidenceBelongsExclusivelyToSource(entry.event.evidence, effectiveSourceId));
  const realized = realizedCanonicalEvents(scopedHistory);
  const actorCanExperienceCanonical = (eventId: string) => {
    const event = context.events?.get(eventId);
    if (!event?.participants.includes(actorId)) return false;
    const presence = event.participantPresence?.find((item) => item.entityId === actorId)?.mode;
    return presence ? presence !== "mentioned" && presence !== "represented" : true;
  };
  const experiencedEntries = scopedHistory.filter((entry) => {
    if (!entry.event.participants.includes(actorId)) return false;
    const canonicalIds = entry.event.realizesCanonicalEventIds ?? [];
    return !canonicalIds.length || canonicalIds.some(actorCanExperienceCanonical);
  });
  const experiencedCanonical = new Set(experiencedEntries.flatMap((entry) =>
    (entry.event.realizesCanonicalEventIds ?? []).filter(actorCanExperienceCanonical)));
  const recentLivedExperiences = experiencedEntries
    .filter((entry) => entry.event.title !== "Genesis")
    .slice(-12)
    .flatMap((entry) => {
      const observation = observeCommittedEvent(entry.event, actorId);
      if (!observation) return [];
      return [{
        eventId: entry.event.eventId,
        atCommit: entry.commitId,
        title: observation.summary,
        logicalTime: structuredClone(entry.event.logicalTime),
        participantIds: [actorId],
        progressChannels: [...(entry.event.progress?.channels ?? [])],
      }];
    });
  const candidateModel = overrides.model === undefined ? context.actorModels?.get(actorId) : overrides.model;
  const model = candidateModel
    && evidenceBelongsExclusivelyToSource([
      ...candidateModel.evidence,
      ...characterOntologyEvidence(candidateModel),
    ], effectiveSourceId)
    ? candidateModel
    : undefined;
  const effectiveModel = model ? resolveCharacterModel(model, {
    state,
    knownClaimIds,
    realizedCanonicalEventIds: realized,
    experiencedCanonicalEventIds: experiencedCanonical,
    storyTime: state.logicalTime.storyTime,
  }) : undefined;

  const activeGoalIds: string[] = [];
  const completedGoalIds: string[] = [];
  const expiredGoalIds: string[] = [];
  const achievedMilestoneIds: string[] = [];
  const goals = (overrides.goals ?? context.actorGoals ?? [])
    .filter((goal) => goal.actorId === actorId)
    .filter((goal) => evidenceBelongsExclusivelyToSource(goal.evidence, effectiveSourceId));
  for (const goal of goals) {
    const activation = evaluateCharacterGoal(goal, {
      state,
      knownClaimIds,
      realizedCanonicalEventIds: realized,
      experiencedCanonicalEventIds: experiencedCanonical,
      storyTime: state.logicalTime.storyTime,
    });
    if (activation.active) activeGoalIds.push(goal.id);
    if (activation.complete) completedGoalIds.push(goal.id);
    if (activation.expired) expiredGoalIds.push(goal.id);
    for (const milestone of goal.milestones ?? []) {
      if (milestone.conditions.every((predicate) => evaluatePredicate(state, predicate))) {
        achievedMilestoneIds.push(`${goal.id}:${milestone.id}`);
      }
    }
  }

  const age = state.values[actorId]?.["character.ageYears"];
  const explicitLifeStage = state.values[actorId]?.["character.lifeStage"];
  return {
    actorId,
    atCommit: commitId,
    ...(state.logicalTime.storyTime ? { storyTime: structuredClone(state.logicalTime.storyTime) } : {}),
    elapsedDays: state.logicalTime.elapsedDays ?? 0,
    ...(typeof age === "number" ? { ageYears: age } : {}),
    ...(typeof explicitLifeStage === "string"
      ? { lifeStage: { value: explicitLifeStage, source: "explicit-state" as const } }
      : typeof age === "number"
        ? { lifeStage: { value: genericLifeStage(age), source: "generic-age-band" as const } }
        : {}),
    experiencedEventIds: experiencedEntries.map((entry) => entry.event.eventId),
    experiencedCanonicalEventIds: [...experiencedCanonical].sort(),
    recentLivedExperiences,
    knownClaimIds: [...knownClaimIds].sort(),
    ...(effectiveModel ? { model: effectiveModel } : {}),
    activeGoalIds: activeGoalIds.sort(),
    completedGoalIds: completedGoalIds.sort(),
    expiredGoalIds: expiredGoalIds.sort(),
    achievedMilestoneIds: achievedMilestoneIds.sort(),
  };
}

/** Strip policy/goals, canonical IDs, claim IDs and numeric model internals. */
export function actorVisibleCharacterDevelopment(
  development: CharacterDevelopmentView,
  _goals: readonly CharacterGoal[],
): ActorVisibleCharacterDevelopment {
  return {
    ...(development.storyTime ? { storyTime: structuredClone(development.storyTime) } : {}),
    elapsedDays: development.elapsedDays,
    ...(development.ageYears !== undefined ? { ageYears: development.ageYears } : {}),
    ...(development.lifeStage ? { lifeStage: structuredClone(development.lifeStage) } : {}),
    recentExperiences: development.recentLivedExperiences.map((experience) => ({
      summary: experience.title,
      logicalTime: structuredClone(experience.logicalTime),
      progressChannels: [...experience.progressChannels],
    })),
  };
}

// Kept behind a helper so generic age bands never become authoritative world truth.
function genericLifeStage(age: number): string {
  if (age < 13) return "child";
  if (age < 18) return "adolescent";
  if (age < 60) return "adult";
  return "older-adult";
}
