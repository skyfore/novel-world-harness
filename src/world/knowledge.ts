import type {
  Attribution,
  Claim,
  CommitId,
  Entity,
  EntityId,
  KnowledgeDelta,
  KnowledgeFact,
  Proposition,
  WorldState,
} from "./model.js";
import type { WorldEngine } from "./engine.js";
import { knownStateFieldKeys, projectActorVisibleState } from "./actor-visible.js";
import { evidenceBelongsExclusivelyToSource } from "./source-scope.js";
import { isCommunicatingKnowledgeSource } from "./knowledge-semantics.js";
import type { BranchSemanticState } from "./semantic-effects.js";

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

export type KnowledgeReducerContext = {
  entities: ReadonlyMap<EntityId, Entity>;
  claims?: ReadonlyMap<string, Claim>;
  propositions?: ReadonlyMap<string, Proposition>;
  attributions?: ReadonlyMap<string, Attribution>;
  branchSemantics: BranchSemanticState;
};

export function emptyKnowledgeState(atCommit: CommitId): KnowledgeState {
  return { atCommit, actors: {} };
}

/**
 * Knowledge is reduced after semantic effects in the same event. This makes a
 * local proposition/attribution/claim reference legal without promoting it to
 * canonical evidence or leaking it to another actor.
 */
export function applyKnowledgeDelta(
  input: KnowledgeState,
  delta: KnowledgeDelta,
  commitId: CommitId,
  context: KnowledgeReducerContext,
): KnowledgeState {
  const actors = structuredClone(input.actors);
  const hasClaim = (id: string) => Boolean(context.branchSemantics.claims[id]) || Boolean(context.claims?.has(id));
  const hasProposition = (id: string) => Boolean(context.branchSemantics.propositions[id]) || Boolean(context.propositions?.has(id));
  const hasAttribution = (id: string) => Boolean(context.branchSemantics.attributions[id]) || Boolean(context.attributions?.has(id));

  for (const operation of delta.operations) {
    const actorEntity = context.entities.get(operation.actorId);
    if (!actorEntity || actorEntity.kind !== "character") {
      throw new Error(`Knowledge actor ${operation.actorId} must be a character`);
    }
    const actor = (actors[operation.actorId] ??= {});
    if (operation.op === "forget") {
      delete actor[operation.claimId];
      continue;
    }
    if ((context.claims || operation.propositionId || operation.attributionId) && !hasClaim(operation.claimId)) {
      throw new Error(`Knowledge acquisition references unknown claim ${operation.claimId}`);
    }
    if (operation.propositionId && !hasProposition(operation.propositionId)) {
      throw new Error(`Knowledge acquisition references unknown proposition ${operation.propositionId}`);
    }
    if (operation.attributionId && !hasAttribution(operation.attributionId)) {
      throw new Error(`Knowledge acquisition references unknown attribution ${operation.attributionId}`);
    }
    const claim = context.branchSemantics.claims[operation.claimId];
    if (claim && operation.propositionId && claim.propositionId !== operation.propositionId) {
      throw new Error(`Knowledge claim ${operation.claimId} does not describe proposition ${operation.propositionId}`);
    }
    const attribution = operation.attributionId
      ? context.branchSemantics.attributions[operation.attributionId] ?? context.attributions?.get(operation.attributionId)
      : undefined;
    if (attribution && operation.propositionId && attribution.propositionId !== operation.propositionId) {
      throw new Error(`Knowledge attribution ${operation.attributionId} does not describe proposition ${operation.propositionId}`);
    }
    if (operation.sourceActorId) {
      const source = context.entities.get(operation.sourceActorId);
      if (!isCommunicatingKnowledgeSource(source)) {
        throw new Error(`Knowledge source ${operation.sourceActorId} is not a character or communication system`);
      }
    }
    actor[operation.claimId] = {
      actorId: operation.actorId,
      claimId: operation.claimId,
      ...(operation.propositionId ? { propositionId: operation.propositionId } : {}),
      ...(operation.attributionId ? { attributionId: operation.attributionId } : {}),
      ...(operation.acquisitionMode ? { acquisitionMode: operation.acquisitionMode } : {}),
      status: operation.status,
      confidence: operation.confidence,
      acquiredAtCommit: commitId,
      ...(operation.sourceActorId ? { sourceActorId: operation.sourceActorId } : {}),
    };
  }
  return { atCommit: commitId, actors };
}

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
    return (await this.engine.projections.project(commitId)).knowledge;
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
