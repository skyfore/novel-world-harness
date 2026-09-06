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
import { evidenceBelongsExclusivelyToSource, resolveCommitSourceId } from "./source-scope.js";
import { contentHash } from "./canonical.js";
import { isCommunicatingKnowledgeSource, projectPropositionObject } from "./knowledge-semantics.js";
import type { BranchSemanticState } from "./semantic-effects.js";

export type KnowledgeState = {
  atCommit: CommitId;
  actors: Record<EntityId, Record<string, KnowledgeFact>>;
};

export type ActorWorldView = {
  actorId: EntityId;
  atCommit: CommitId;
  selfState: Record<string, unknown>;
  knowledge: Array<{ fact: KnowledgeFact; claim?: Claim; proposition?: Proposition; attribution?: Attribution; branchGrounded?: boolean }>;
};

// Only projector-created entries can use committed-event provenance. A serialized
// or model-provided branchGrounded flag is never an admission credential.
const committedKnowledge = new WeakMap<object, { sourceId?: string; hash: string }>();

export function actorKnowledgeBelongsToSource(entry: ActorWorldView["knowledge"][number], sourceId?: string): boolean {
  if (!entry.claim) return false;
  if (!sourceId) return true;
  if (entry.branchGrounded) {
    const authority = committedKnowledge.get(entry);
    return authority?.sourceId === sourceId && authority.hash === contentHash(entry);
  }
  return evidenceBelongsExclusivelyToSource(entry.claim.evidence, sourceId);
}

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
    && actorKnowledgeBelongsToSource(entry, sourceId));
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
    const projection = await this.engine.projections.project(commitId);
    const knowledge = projection.knowledge;
    const sourceId = await resolveCommitSourceId(this.engine, context, commitId);
    const facts = Object.values(knowledge.actors[actorId] ?? {})
      .sort((left, right) => left.claimId.localeCompare(right.claimId))
      .map((fact) => {
        const branchClaim = projection.semantics.claims[fact.claimId];
        const propositionId = fact.propositionId ?? branchClaim?.propositionId;
        const attributionId = fact.attributionId ?? branchClaim?.attributionId;
        const branchProposition = propositionId ? projection.semantics.propositions[propositionId] : undefined;
        const proposition = propositionId
          ? context.propositions?.get(propositionId) ?? (branchProposition ? stripIntroduced(branchProposition) : undefined)
          : undefined;
        const branchAttribution = attributionId ? projection.semantics.attributions[attributionId] : undefined;
        const attribution = attributionId
          ? context.attributions?.get(attributionId) ?? (branchAttribution ? stripIntroduced(branchAttribution) : undefined)
          : undefined;
        const claim = context.claims?.get(fact.claimId) ?? (branchClaim && proposition
          ? {
              id: branchClaim.id,
              subject: proposition.subjectEntityId,
              predicate: proposition.relationId,
              object: projectPropositionObject(proposition.object),
              epistemicType: attribution?.holderKind === "character" ? "character-claim" as const : "inference" as const,
              ...(attribution?.holderKind === "character" && attribution.holderEntityId
                ? { speaker: attribution.holderEntityId }
                : {}),
              evidence: [],
            }
          : undefined);
        return { fact, claim, proposition, attribution, branchGrounded: Boolean(branchClaim) };
      })
      .map(({ fact, claim, proposition, attribution, branchGrounded }) => ({
        fact,
        ...(claim ? { claim } : {}),
        ...(proposition ? { proposition } : {}),
        ...(attribution ? { attribution } : {}),
        ...(branchGrounded ? { branchGrounded: true } : {}),
      }));
    for (const entry of facts) {
      if (entry.branchGrounded) committedKnowledge.set(entry, { sourceId, hash: contentHash(entry) });
    }
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

function stripIntroduced<T extends { introducedBy: unknown }>(value: T): Omit<T, "introducedBy"> & { evidence: [] } {
  const { introducedBy: _introducedBy, ...semantic } = value;
  return { ...structuredClone(semantic), evidence: [] };
}
