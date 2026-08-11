import type { Claim, CommitId, EntityId, KnowledgeFact, WorldState } from "./model.js";
import type { WorldEngine } from "./engine.js";

export type KnowledgeState = {
  atCommit: CommitId;
  actors: Record<EntityId, Record<string, KnowledgeFact>>;
};

export type ActorWorldView = {
  actorId: EntityId;
  atCommit: CommitId;
  selfState: Record<string, unknown>;
  knowledge: Array<{ fact: KnowledgeFact; claim?: Claim }>;
};

export function isActionableKnowledge(fact: KnowledgeFact): boolean {
  return fact.status !== "disbelieves";
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
        if (!event.knowledgeDeltaHash) continue;
        const delta = await this.engine.objects.getKnowledgeDelta(event.knowledgeDeltaHash);
        for (const operation of delta.operations) {
          const actor = (actors[operation.actorId] ??= {});
          if (operation.op === "forget") {
            delete actor[operation.claimId];
            continue;
          }
          actor[operation.claimId] = {
            actorId: operation.actorId,
            claimId: operation.claimId,
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
    const entity = this.engine.context.entities.get(actorId);
    if (!entity || entity.kind !== "character") throw new Error(`Actor view requires a character: ${actorId}`);
    const state = worldState ?? (await this.engine.projector.project(commitId));
    if (state.atCommit !== commitId) throw new Error(`World state ${state.atCommit} does not match requested commit ${commitId}`);
    const knowledge = await this.project(commitId);
    const facts = Object.values(knowledge.actors[actorId] ?? {})
      .sort((left, right) => left.claimId.localeCompare(right.claimId))
      .map((fact) => ({ fact, claim: this.engine.context.claims?.get(fact.claimId) }))
      .map(({ fact, claim }) => (claim ? { fact, claim } : { fact }));
    return {
      actorId,
      atCommit: commitId,
      selfState: { ...(state.values[actorId] ?? {}) },
      knowledge: facts,
    };
  }
}

