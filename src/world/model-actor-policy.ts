import { z } from "zod";
import { contentHash } from "./canonical.js";
import type { ActorProposalCandidate, CharacterGoal, CharacterModel } from "./actors.js";
import type { WorldEngine } from "./engine.js";
import { KnowledgeProjector, type ActorWorldView } from "./knowledge.js";
import { knowledgeDeltaSchema, predicateSchema, stateDeltaSchema, type EvidenceRef } from "./model.js";

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
    const goals = [...(await options.goals())]
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
      .slice(0, maxActors);
    const candidates: ActorProposalCandidate[] = [];
    for (const goal of goals) {
      const entity = engine.context.entities.get(goal.actorId);
      if (!entity || entity.kind !== "character") continue;
      const actor = await knowledge.view(goal.actorId, commitId);
      const known = new Set(actor.knowledge.map((entry) => entry.fact.claimId));
      if (goal.requiresKnowledge.some((claimId) => !known.has(claimId))) continue;
      if (goal.blockedByKnowledge?.some((claimId) => known.has(claimId))) continue;

      const model = await options.modelFor(goal.actorId);
      const output = await options.reasoner({ actor, goal, model });
      if (!output) continue;
      const action = actorActionTemplateSchema.parse(output);
      const participants = [...new Set([goal.actorId, ...action.participants])];
      for (const participant of participants) {
        if (!engine.context.entities.has(participant)) throw new Error(`Actor reasoner proposed unknown participant ${participant}`);
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
          proposedTime: { kind: "unknown" },
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
