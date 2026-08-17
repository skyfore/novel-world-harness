import { z } from "zod";
import { contentHash } from "./canonical.js";
import { evaluateCharacterGoal, type ActorProposalCandidate, type CharacterGoal, type CharacterModel } from "./actors.js";
import { projectCharacterDevelopment, type CharacterDevelopmentView } from "./development.js";
import type { WorldEngine } from "./engine.js";
import { isActionableKnowledge, KnowledgeProjector, type ActorWorldView } from "./knowledge.js";
import { knowledgeDeltaSchema, predicateSchema, stateDeltaSchema, type EvidenceRef } from "./model.js";
import { committedHistory, realizedCanonicalEvents } from "./scene.js";

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

export type ActorReasoningInput = {
  actor: ActorWorldView;
  goal: CharacterGoal;
  model: CharacterModel | null;
  development: CharacterDevelopmentView;
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
    const realizedCanonicalEventIds = realizedCanonicalEvents(history);
    const goals = [...(await options.goals())]
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
      .slice(0, maxActors);
    const candidates: ActorProposalCandidate[] = [];
    const developmentByActor = new Map<string, Promise<CharacterDevelopmentView>>();
    for (const goal of goals) {
      const entity = context.entities.get(goal.actorId);
      if (!entity || entity.kind !== "character") continue;
      const actor = await knowledge.view(goal.actorId, commitId);
      const known = new Set(actor.knowledge.filter((entry) => isActionableKnowledge(entry.fact)).map((entry) => entry.fact.claimId));
      if (!evaluateCharacterGoal(goal, {
        state,
        knownClaimIds: known,
        realizedCanonicalEventIds,
        storyTime: state.logicalTime.storyTime,
      }).active) continue;

      const model = await options.modelFor(goal.actorId);
      let developmentPromise = developmentByActor.get(goal.actorId);
      if (!developmentPromise) {
        developmentPromise = projectCharacterDevelopment(engine, goal.actorId, commitId, {
          goals,
          model,
        });
        developmentByActor.set(goal.actorId, developmentPromise);
      }
      const development = await developmentPromise;
      const output = await options.reasoner({ actor, goal, model, development });
      if (!output) continue;
      const action = actorActionTemplateSchema.parse(output);
      const participants = [...new Set([goal.actorId, ...action.participants])];
      for (const participant of participants) {
        if (!context.entities.has(participant)) throw new Error(`Actor reasoner proposed unknown participant ${participant}`);
      }
      const evidence: EvidenceRef[] = goal.evidence;
      candidates.push({
        goalId: goal.id,
        priority: goal.priority,
        proposal: {
          proposalId: `actor-model-${contentHash({ goal: goal.id, branchId, commitId, action }).slice(0, 24)}`,
          branchId,
          expectedParentCommit: commitId,
          source: "actor",
          actorId: goal.actorId,
          title: action.title,
          participants,
          proposedTime: state.logicalTime.storyTime ?? { kind: "unknown" },
          preconditions: action.preconditions,
          proposedDelta: action.proposedDelta,
          ...(action.proposedKnowledge ? { proposedKnowledge: action.proposedKnowledge } : {}),
          causalParents: [],
          evidence,
        },
      });
    }
    return candidates;
  };
}
