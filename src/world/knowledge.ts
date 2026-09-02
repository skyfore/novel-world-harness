import type { Attribution, Claim, CommitId, EntityId, KnowledgeFact, Proposition, WorldState } from "./model.js";
import type { WorldEngine } from "./engine.js";
import { knownStateFieldKeys, projectActorVisibleState } from "./actor-visible.js";
import { evidenceBelongsExclusivelyToSource } from "./source-scope.js";

export type KnowledgeState = {
  atCommit: CommitId;
  actors: Record<EntityId, Record<string, KnowledgeFact>>;
};

export type ActorWorldView = {
  actorId: EntityId;
  atCommit: CommitId;
  selfState: Record<string, unknown>;
  knowledge: Array<{ fact: KnowledgeFact; claim?: Claim; proposition?: Proposition; attribution?: Attribution }>;
};

export function isActionableKnowledge(fact: KnowledgeFact): boolean {
  return fact.status !== "disbelieves";
}

export function actionableKnowledgeEntries(
  view: ActorWorldView,
  sourceId?: string,
): Array<ActorWorldView["knowledge"][number] & { claim: Claim }> {
  return view.knowledge.filter((entry): entry is ActorWorldView["knowledge"][number] & { claim: Claim } =>
    Boolean(entry.claim)
    && isActionableKnowledge(entry.fact)
    && evidenceBelongsExclusivelyToSource(entry.claim?.evidence ?? [], sourceId));
}

export function actionableKnowledgeClaimIds(view: ActorWorldView, sourceId?: string): Set<string> {
  return new Set(actionableKnowledgeEntries(view, sourceId).map((entry) => entry.fact.claimId));
}

export class KnowledgeProjector {
  constructor(private readonly engine: WorldEngine) {}

  async project(commitId: CommitId): Promise<KnowledgeState> {
    const chain: { id: CommitId; eventHashes: string[] }[] = [];
    const seen = new Set<string>();
    let cursor: CommitId | undefined = commitId;
    while (cursor) {
      if (seen.has(cursor)) throw new Error(`Commit ancestry cycle detected at ${cursor}`);
      seen.add(cursor);
      const commit = await this.engine.objects.getCommit(cursor);
      chain.push({ id: cursor, eventHashes: commit.eventHashes });
      cursor = commit.parentCommitId;
    }
    chain.reverse();
    const actors: KnowledgeState["actors"] = {};
    for (const entry of chain) {
      for (const eventHash of entry.eventHashes) {
        const event = await this.engine.objects.getEvent(eventHash);
        if (!event.effects.knowledgeDeltaHash) continue;
        const delta = await this.engine.objects.getKnowledgeDelta(event.effects.knowledgeDeltaHash);
        for (const operation of delta.operations) {
          const actor = (actors[operation.actorId] ??= {});
          if (operation.op === "forget") {
            delete actor[operation.claimId];
            continue;
          }
          actor[operation.claimId] = {
            actorId: operation.actorId,
            claimId: operation.claimId,
            ...(operation.propositionId ? { propositionId: operation.propositionId } : {}),
            ...(operation.attributionId ? { attributionId: operation.attributionId } : {}),
            ...(operation.acquisitionMode ? { acquisitionMode: operation.acquisitionMode } : {}),
            status: operation.status,
            confidence: operation.confidence,
            acquiredAtCommit: entry.id,
            ...(operation.sourceActorId ? { sourceActorId: operation.sourceActorId } : {}),
          };
        }
      }
    }
    return { atCommit: commitId, actors };
  }

  async view(actorId: EntityId, commitId: CommitId, worldState?: WorldState): Promise<ActorWorldView> {
    const context = await this.engine.contextForCommit(commitId);
    const entity = context.entities.get(actorId);
    if (!entity || entity.kind !== "character") throw new Error(`Actor view requires a character: ${actorId}`);
    const state = worldState ?? (await this.engine.projector.project(commitId));
    if (state.atCommit !== commitId) throw new Error(`World state ${state.atCommit} does not match requested commit ${commitId}`);
    const knowledge = await this.project(commitId);
    const facts = Object.values(knowledge.actors[actorId] ?? {})
      .sort((left, right) => left.claimId.localeCompare(right.claimId))
      .map((fact) => ({
        fact,
        claim: context.claims?.get(fact.claimId),
        proposition: fact.propositionId ? context.propositions?.get(fact.propositionId) : undefined,
        attribution: fact.attributionId ? context.attributions?.get(fact.attributionId) : undefined,
      }))
      .map(({ fact, claim, proposition, attribution }) => ({
        fact,
        ...(claim ? { claim } : {}),
        ...(proposition ? { proposition } : {}),
        ...(attribution ? { attribution } : {}),
      }));
    const stateKnowledge = knownStateFieldKeys(
      actorId,
      facts
        .filter((entry) => entry.claim && isActionableKnowledge(entry.fact))
        .flatMap((entry) => entry.claim ? [entry.claim] : []),
    );
    return {
      actorId,
      atCommit: commitId,
      selfState: projectActorVisibleState(
        state.values[actorId] ?? {},
        context.stateSchema,
        "self",
        stateKnowledge,
      ),
      knowledge: facts,
    };
  }
}
