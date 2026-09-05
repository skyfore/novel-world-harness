import type {
  BranchSemanticDelta,
  BranchSemanticOperation,
  BranchSemanticProposalDelta,
  CommitId,
  Entity,
  EntityId,
  KnowledgeDelta,
  ObjectHash,
} from "./model.js";
import { branchSemanticDeltaSchema, branchSemanticProposalDeltaSchema, knowledgeDeltaSchema } from "./model.js";
import { contentHash } from "./canonical.js";
import { APPRAISAL_EMOTION_IDS } from "./character-ontology.js";
import { RELATIONSHIP_OBLIGATION_TYPE_IDS, RELATIONSHIP_STANCE_DIMENSION_IDS } from "./relationship-ontology.js";

type RecordedProposition = Extract<BranchSemanticOperation, { op: "record-proposition" }>['proposition'];
type RecordedAttribution = Extract<BranchSemanticOperation, { op: "record-attribution" }>['attribution'];
type RecordedClaim = Extract<BranchSemanticOperation, { op: "record-claim" }>['claim'];
type OpenedGoal = Extract<BranchSemanticOperation, { op: "open-goal" }>['goal'];
type RecordedAppraisal = Extract<BranchSemanticOperation, { op: "record-appraisal" }>['appraisal'];
type CreatedObligation = Extract<BranchSemanticOperation, { op: "create-obligation" }>['obligation'];

export type EffectProvenance = {
  commitId: CommitId;
  eventId: string;
  eventHash: ObjectHash;
};

type Introduced<T> = T & { introducedBy: EffectProvenance };

export type BranchGoal = Introduced<OpenedGoal> & {
  status: "open" | "achieved" | "abandoned" | "failed" | "superseded";
  closedBy?: EffectProvenance;
};

export type BranchRelationship = {
  id: string;
  fromActorId: EntityId;
  toActorId: EntityId;
  dimensions: Record<string, number>;
  introducedBy: EffectProvenance;
  updatedBy: EffectProvenance;
};

export type BranchObligation = Introduced<CreatedObligation> & {
  status: "open" | "fulfilled" | "violated" | "waived" | "expired";
  resolvedBy?: EffectProvenance;
};

export type BranchSemanticState = {
  version: 1;
  atCommit: CommitId;
  propositions: Record<string, Introduced<RecordedProposition>>;
  attributions: Record<string, Introduced<RecordedAttribution>>;
  claims: Record<string, Introduced<RecordedClaim>>;
  goals: Record<string, BranchGoal>;
  appraisals: Record<string, Introduced<RecordedAppraisal>>;
  relationships: Record<string, BranchRelationship>;
  obligations: Record<string, BranchObligation>;
};

export type SemanticReducerContext = {
  entities: ReadonlyMap<EntityId, Entity>;
  canonicalPropositionIds?: ReadonlySet<string>;
  canonicalAttributionIds?: ReadonlySet<string>;
  canonicalClaimIds?: ReadonlySet<string>;
  canonicalGoalIds?: ReadonlySet<string>;
  canonicalEventIds?: ReadonlySet<string>;
  knownCommittedEventIds?: ReadonlySet<string>;
};

type SemanticBindingKind = "proposition" | "attribution" | "claim" | "goal" | "appraisal" | "relationship" | "obligation";
export type SemanticLocalBinding = { id: string; kind: SemanticBindingKind };
export type MaterializedBranchSemantics = {
  delta: BranchSemanticDelta;
  proposalHash: ObjectHash;
  localBindings: ReadonlyMap<string, SemanticLocalBinding>;
};

/**
 * Replace proposal-local refs with host-owned stable IDs. IDs bind to the
 * immutable parent and normalized proposal, so retrying the same proposal at
 * the same head is deterministic while replaying it on another branch/head is
 * distinct.
 */
export function materializeBranchSemanticProposal(
  input: BranchSemanticProposalDelta,
  options: { branchId: string; parentCommitId: CommitId; proposalHash?: ObjectHash },
): MaterializedBranchSemantics {
  const proposal = branchSemanticProposalDeltaSchema.parse(input);
  const proposalHash = options.proposalHash ?? contentHash(proposal);
  const localBindings = new Map<string, SemanticLocalBinding>();
  const operations: BranchSemanticOperation[] = [];
  const introduce = (localRef: string, kind: SemanticBindingKind, index: number, payload: unknown): string => {
    if (localBindings.has(localRef)) throw new Error(`Turn-local semantic ref ${localRef} is introduced more than once`);
    const id = `branch-${kind}-${contentHash({
      version: 1,
      branchId: options.branchId,
      parentCommitId: options.parentCommitId,
      proposalHash,
      operationIndex: index,
      kind,
      localRef,
      payload,
    }).slice(0, 32)}`;
    localBindings.set(localRef, { id, kind });
    return id;
  };
  const resolve = (ref: string, expected: SemanticBindingKind | readonly SemanticBindingKind[]): string => {
    if (!ref.startsWith("local-")) return ref;
    const binding = localBindings.get(ref);
    if (!binding) throw new Error(`Turn-local semantic ref ${ref} must be introduced by an earlier operation`);
    const expectedKinds = typeof expected === "string" ? [expected] : expected;
    if (!expectedKinds.includes(binding.kind)) {
      throw new Error(`Turn-local semantic ref ${ref} is ${binding.kind}, expected ${expectedKinds.join(" or ")}`);
    }
    return binding.id;
  };

  proposal.operations.forEach((operation, operationIndex) => {
    switch (operation.op) {
      case "record-proposition": {
        const id = introduce(operation.localRef, "proposition", operationIndex, operation.proposition);
        const object = operation.proposition.object.kind === "proposition"
          ? { ...operation.proposition.object, propositionId: resolve(operation.proposition.object.propositionId, "proposition") }
          : structuredClone(operation.proposition.object);
        operations.push({ op: operation.op, proposition: { id, ...structuredClone(operation.proposition), object } });
        break;
      }
      case "record-attribution": {
        const id = introduce(operation.localRef, "attribution", operationIndex, operation.attribution);
        operations.push({
          op: operation.op,
          attribution: {
            id,
            ...structuredClone(operation.attribution),
            propositionId: resolve(operation.attribution.propositionId, "proposition"),
            ...(operation.attribution.sourceAttributionId
              ? { sourceAttributionId: resolve(operation.attribution.sourceAttributionId, "attribution") }
              : {}),
          },
        });
        break;
      }
      case "record-claim": {
        const id = introduce(operation.localRef, "claim", operationIndex, operation.claim);
        operations.push({
          op: operation.op,
          claim: {
            id,
            ...structuredClone(operation.claim),
            propositionId: resolve(operation.claim.propositionId, "proposition"),
            ...(operation.claim.attributionId
              ? { attributionId: resolve(operation.claim.attributionId, "attribution") }
              : {}),
          },
        });
        break;
      }
      case "open-goal": {
        const id = introduce(operation.localRef, "goal", operationIndex, operation.goal);
        operations.push({
          op: operation.op,
          goal: {
            id,
            ...structuredClone(operation.goal),
            ...(operation.goal.parentGoalId ? { parentGoalId: resolve(operation.goal.parentGoalId, "goal") } : {}),
          },
        });
        break;
      }
      case "close-goal":
        operations.push({ ...operation, goalId: resolve(operation.goalId, "goal") });
        break;
      case "record-appraisal": {
        const id = introduce(operation.localRef, "appraisal", operationIndex, operation.appraisal);
        const target = operation.appraisal.target.kind === "proposition"
          ? { ...operation.appraisal.target, propositionId: resolve(operation.appraisal.target.propositionId, "proposition") }
          : structuredClone(operation.appraisal.target);
        operations.push({ op: operation.op, appraisal: { id, ...structuredClone(operation.appraisal), target } });
        break;
      }
      case "adjust-relationship": {
        const relationshipId = operation.createIfMissing
          ? introduce(operation.relationshipRef, "relationship", operationIndex, operation)
          : resolve(operation.relationshipRef, "relationship");
        operations.push({
          op: operation.op,
          relationshipId,
          fromActorId: operation.fromActorId,
          toActorId: operation.toActorId,
          dimensionId: operation.dimensionId,
          amount: operation.amount,
        });
        break;
      }
      case "create-obligation": {
        const id = introduce(operation.localRef, "obligation", operationIndex, operation.obligation);
        operations.push({ op: operation.op, obligation: { id, ...structuredClone(operation.obligation) } });
        break;
      }
      case "resolve-obligation":
        operations.push({ ...operation, obligationId: resolve(operation.obligationId, "obligation") });
        break;
    }
  });
  return {
    delta: branchSemanticDeltaSchema.parse({ version: 1, operations }),
    proposalHash,
    localBindings,
  };
}

/** Resolve semantic refs used by KnowledgeDelta after semantic staging. */
export function resolveSemanticKnowledgeRefs(
  input: KnowledgeDelta,
  localBindings: ReadonlyMap<string, SemanticLocalBinding>,
): KnowledgeDelta {
  const resolve = (ref: string, expected: SemanticBindingKind): string => {
    if (!ref.startsWith("local-")) return ref;
    const binding = localBindings.get(ref);
    if (!binding) throw new Error(`Knowledge references unknown turn-local semantic ref ${ref}`);
    if (binding.kind !== expected) throw new Error(`Knowledge ref ${ref} is ${binding.kind}, expected ${expected}`);
    return binding.id;
  };
  return knowledgeDeltaSchema.parse({
    version: 1,
    operations: input.operations.map((operation) => ({
      ...structuredClone(operation),
      claimId: resolve(operation.claimId, "claim"),
      ...(operation.propositionId ? { propositionId: resolve(operation.propositionId, "proposition") } : {}),
      ...(operation.op === "learn" && operation.attributionId
        ? { attributionId: resolve(operation.attributionId, "attribution") }
        : {}),
    })),
  });
}

export function emptyBranchSemanticState(atCommit: CommitId): BranchSemanticState {
  return {
    version: 1,
    atCommit,
    propositions: {},
    attributions: {},
    claims: {},
    goals: {},
    appraisals: {},
    relationships: {},
    obligations: {},
  };
}

/** Apply branch-emergent semantics in operation order so same-event local references are deterministic. */
export function applyBranchSemanticDelta(
  input: BranchSemanticState,
  delta: BranchSemanticDelta,
  context: SemanticReducerContext,
  provenance: EffectProvenance,
): BranchSemanticState {
  const output = structuredClone(input);
  output.atCommit = provenance.commitId;

  const hasProposition = (id: string) => Boolean(output.propositions[id]) || Boolean(context.canonicalPropositionIds?.has(id));
  const hasAttribution = (id: string) => Boolean(output.attributions[id]) || Boolean(context.canonicalAttributionIds?.has(id));
  const hasGoal = (id: string) => Boolean(output.goals[id]) || Boolean(context.canonicalGoalIds?.has(id));

  for (const operation of delta.operations) {
    switch (operation.op) {
      case "record-proposition": {
        const proposition = operation.proposition;
        assertUnusedId(proposition.id, output.propositions, context.canonicalPropositionIds, "proposition");
        requireEntity(context.entities, proposition.subjectEntityId, "Proposition subject");
        if (proposition.object.kind === "entity") {
          requireEntity(context.entities, proposition.object.entityId, "Proposition object");
        }
        if (proposition.object.kind === "proposition") {
          if (proposition.object.propositionId === proposition.id) {
            throw new Error(`Branch proposition ${proposition.id} cannot contain itself`);
          }
          if (!hasProposition(proposition.object.propositionId)) {
            throw new Error(`Branch proposition ${proposition.id} references unknown proposition ${proposition.object.propositionId}`);
          }
        }
        output.propositions[proposition.id] = { ...structuredClone(proposition), introducedBy: provenance };
        break;
      }
      case "record-attribution": {
        const attribution = operation.attribution;
        assertUnusedId(attribution.id, output.attributions, context.canonicalAttributionIds, "attribution");
        if (!hasProposition(attribution.propositionId)) {
          throw new Error(`Branch attribution ${attribution.id} references unknown proposition ${attribution.propositionId}`);
        }
        if (attribution.holderEntityId) {
          const holder = requireEntity(context.entities, attribution.holderEntityId, "Attribution holder");
          if (attribution.holderKind === "character" && holder.kind !== "character") {
            throw new Error(`Attribution holder ${holder.id} must be a character`);
          }
        }
        if (attribution.sourceAttributionId && !hasAttribution(attribution.sourceAttributionId)) {
          throw new Error(`Branch attribution ${attribution.id} references unknown source attribution ${attribution.sourceAttributionId}`);
        }
        output.attributions[attribution.id] = { ...structuredClone(attribution), introducedBy: provenance };
        break;
      }
      case "record-claim": {
        const claim = operation.claim;
        assertUnusedId(claim.id, output.claims, context.canonicalClaimIds, "claim");
        if (!hasProposition(claim.propositionId)) {
          throw new Error(`Branch claim ${claim.id} references unknown proposition ${claim.propositionId}`);
        }
        if (claim.attributionId && !hasAttribution(claim.attributionId)) {
          throw new Error(`Branch claim ${claim.id} references unknown attribution ${claim.attributionId}`);
        }
        const attribution = claim.attributionId ? output.attributions[claim.attributionId] : undefined;
        if (attribution && attribution.propositionId !== claim.propositionId) {
          throw new Error(`Branch claim ${claim.id} attribution does not describe proposition ${claim.propositionId}`);
        }
        output.claims[claim.id] = { ...structuredClone(claim), introducedBy: provenance };
        break;
      }
      case "open-goal": {
        const goal = operation.goal;
        assertUnusedId(goal.id, output.goals, context.canonicalGoalIds, "goal");
        requireCharacter(context.entities, goal.actorId, "Goal actor");
        for (const targetId of goal.targetEntityIds) requireEntity(context.entities, targetId, "Goal target");
        if (goal.parentGoalId && !hasGoal(goal.parentGoalId)) {
          throw new Error(`Branch goal ${goal.id} references unknown parent goal ${goal.parentGoalId}`);
        }
        output.goals[goal.id] = { ...structuredClone(goal), status: "open", introducedBy: provenance };
        break;
      }
      case "close-goal": {
        const goal = output.goals[operation.goalId];
        if (!goal) throw new Error(`Cannot close unknown or canonical-only branch goal ${operation.goalId}`);
        if (goal.status !== "open") throw new Error(`Branch goal ${operation.goalId} is already ${goal.status}`);
        goal.status = operation.outcome;
        goal.closedBy = provenance;
        break;
      }
      case "record-appraisal": {
        const appraisal = operation.appraisal;
        assertUnusedId(appraisal.id, output.appraisals, undefined, "appraisal");
        requireCharacter(context.entities, appraisal.actorId, "Appraisal actor");
        if (!(APPRAISAL_EMOTION_IDS as readonly string[]).includes(appraisal.dimensionId)) {
          throw new Error(`Unknown appraisal emotion ${appraisal.dimensionId}`);
        }
        if (appraisal.target.kind === "entity") {
          requireEntity(context.entities, appraisal.target.entityId, "Appraisal target");
        } else if (appraisal.target.kind === "proposition" && !hasProposition(appraisal.target.propositionId)) {
          throw new Error(`Appraisal ${appraisal.id} references unknown proposition ${appraisal.target.propositionId}`);
        } else if (appraisal.target.kind === "event"
          && appraisal.target.eventId !== provenance.eventId
          && !context.knownCommittedEventIds?.has(appraisal.target.eventId)
          && !context.canonicalEventIds?.has(appraisal.target.eventId)) {
          throw new Error(`Appraisal ${appraisal.id} references unknown event ${appraisal.target.eventId}`);
        }
        const materializedAppraisal = appraisal.target.kind === "current-event"
          ? { ...structuredClone(appraisal), target: { kind: "event" as const, eventId: provenance.eventId } }
          : structuredClone(appraisal);
        output.appraisals[appraisal.id] = { ...materializedAppraisal, introducedBy: provenance };
        break;
      }
      case "adjust-relationship": {
        requireCharacter(context.entities, operation.fromActorId, "Relationship source");
        requireCharacter(context.entities, operation.toActorId, "Relationship target");
        if (operation.fromActorId === operation.toActorId) throw new Error("A directed relationship cannot target the same actor");
        if (!(RELATIONSHIP_STANCE_DIMENSION_IDS as readonly string[]).includes(operation.dimensionId)) {
          throw new Error(`Unknown relationship stance dimension ${operation.dimensionId}`);
        }
        const entity = context.entities.get(operation.relationshipId);
        if (entity && entity.kind !== "relationship") {
          throw new Error(`Relationship ID ${operation.relationshipId} collides with ${entity.kind} entity`);
        }
        const relationship = output.relationships[operation.relationshipId] ?? {
          id: operation.relationshipId,
          fromActorId: operation.fromActorId,
          toActorId: operation.toActorId,
          dimensions: {},
          introducedBy: provenance,
          updatedBy: provenance,
        };
        if (relationship.fromActorId !== operation.fromActorId || relationship.toActorId !== operation.toActorId) {
          throw new Error(`Relationship ${operation.relationshipId} endpoints cannot change`);
        }
        const next = (relationship.dimensions[operation.dimensionId] ?? 0) + operation.amount;
        if (next < -1 || next > 1) {
          throw new Error(`Relationship ${operation.relationshipId}.${operation.dimensionId} must remain within [-1, 1]`);
        }
        relationship.dimensions[operation.dimensionId] = next;
        relationship.updatedBy = provenance;
        output.relationships[operation.relationshipId] = relationship;
        break;
      }
      case "create-obligation": {
        const obligation = operation.obligation;
        assertUnusedId(obligation.id, output.obligations, undefined, "obligation");
        requireCharacter(context.entities, obligation.debtorActorId, "Obligation debtor");
        if (obligation.creditorActorId) requireCharacter(context.entities, obligation.creditorActorId, "Obligation creditor");
        if (!(RELATIONSHIP_OBLIGATION_TYPE_IDS as readonly string[]).includes(obligation.kindId)) {
          throw new Error(`Unknown relationship obligation type ${obligation.kindId}`);
        }
        output.obligations[obligation.id] = {
          ...structuredClone(obligation),
          status: "open",
          introducedBy: provenance,
        };
        break;
      }
      case "resolve-obligation": {
        const obligation = output.obligations[operation.obligationId];
        if (!obligation) throw new Error(`Cannot resolve unknown obligation ${operation.obligationId}`);
        if (obligation.status !== "open") throw new Error(`Obligation ${operation.obligationId} is already ${obligation.status}`);
        obligation.status = operation.resolution;
        obligation.resolvedBy = provenance;
        break;
      }
    }
  }
  return output;
}

export type ActorBranchSemanticView = {
  goals: BranchGoal[];
  appraisals: Array<Introduced<RecordedAppraisal>>;
  relationships: BranchRelationship[];
  obligations: BranchObligation[];
};

/** Deterministic semantic visibility policy at the actor boundary. */
export function projectActorBranchSemantics(
  state: BranchSemanticState,
  actorId: EntityId,
): ActorBranchSemanticView {
  return {
    goals: Object.values(state.goals)
      .filter((goal) => goal.actorId === actorId)
      .sort((left, right) => left.id.localeCompare(right.id)),
    appraisals: Object.values(state.appraisals)
      .filter((appraisal) => appraisal.actorId === actorId)
      .sort((left, right) => left.id.localeCompare(right.id)),
    relationships: Object.values(state.relationships)
      .filter((relationship) => relationship.fromActorId === actorId || relationship.toActorId === actorId)
      .sort((left, right) => left.id.localeCompare(right.id)),
    obligations: Object.values(state.obligations)
      .filter((obligation) => obligation.debtorActorId === actorId || obligation.creditorActorId === actorId)
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function assertUnusedId(
  id: string,
  local: Readonly<Record<string, unknown>>,
  canonical: ReadonlySet<string> | undefined,
  kind: string,
): void {
  if (local[id] || canonical?.has(id)) throw new Error(`Duplicate ${kind} ID: ${id}`);
}

function requireEntity(entities: ReadonlyMap<EntityId, Entity>, entityId: EntityId, label: string): Entity {
  const entity = entities.get(entityId);
  if (!entity) throw new Error(`${label} references unknown entity ${entityId}`);
  return entity;
}

function requireCharacter(entities: ReadonlyMap<EntityId, Entity>, entityId: EntityId, label: string): Entity {
  const entity = requireEntity(entities, entityId, label);
  if (entity.kind !== "character") throw new Error(`${label} ${entityId} must be a character`);
  return entity;
}
