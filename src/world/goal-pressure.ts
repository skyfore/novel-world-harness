import { evaluateCharacterGoal, goalSupportedInCurrentPhase } from "./actors.js";
import { contentHash } from "./canonical.js";
import type { WorldEngine } from "./engine.js";
import { actionableKnowledgeClaimIds, KnowledgeProjector } from "./knowledge.js";
import { committedHistory, experiencedCanonicalEvents, realizedCanonicalEvents } from "./scene.js";
import { AmbiguousLegacySourceError, evidenceBelongsExclusivelyToSource, resolveCommitSourceId } from "./source-scope.js";

/** Host-only derived input. Never accepted from a possibility proposal. */
export type ActiveGoalPressure = { goalId: string; actorId: string; revision: string; pressure: number };

export async function activeGoalPressures(engine: WorldEngine, commitId: string): Promise<ReadonlyMap<string, ActiveGoalPressure>> {
  const context = await engine.contextForCommit(commitId);
  const result = new Map<string, ActiveGoalPressure>();
  // Only pinned goals may affect replay. Mutable actor-store additions are not authority.
  if (!context.actorGoals?.length) return result;
  const [state, history] = await Promise.all([engine.projector.project(commitId), committedHistory(engine, commitId)]);
  let sourceId: string | undefined;
  try { sourceId = await resolveCommitSourceId(engine, context, commitId, undefined, "Goal pressure"); }
  catch (error) { if (error instanceof AmbiguousLegacySourceError) return result; throw error; }
  const belongs = (evidence: Parameters<typeof evidenceBelongsExclusivelyToSource>[0]) => sourceId
    ? evidenceBelongsExclusivelyToSource(evidence, sourceId) : evidence.length === 0;
  const scopedHistory = history.filter(entry => !entry.event.evidence.length || belongs(entry.event.evidence));
  const realized = realizedCanonicalEvents(scopedHistory), knowledge = new KnowledgeProjector(engine);
  const views = new Map<string, ReadonlySet<string>>();
  for (const goal of context.actorGoals) {
    const actor = context.entities.get(goal.actorId);
    if (actor?.kind !== "character" || !belongs(actor.evidence) || !belongs(goal.evidence)
      || !goalSupportedInCurrentPhase(goal, scopedHistory, goal.actorId)) continue;
    let known = views.get(goal.actorId);
    if (!known) {
      known = actionableKnowledgeClaimIds(await knowledge.view(goal.actorId, commitId), sourceId);
      views.set(goal.actorId, known);
    }
    if (!evaluateCharacterGoal(goal, { state, knownClaimIds: known, realizedCanonicalEventIds: realized,
      experiencedCanonicalEventIds: experiencedCanonicalEvents(scopedHistory, goal.actorId, context.events),
      storyTime: state.logicalTime.storyTime,
    }).active) continue;
    result.set(goal.id, { goalId: goal.id, actorId: goal.actorId, revision: contentHash(goal), pressure: goal.priority });
  }
  return result;
}
