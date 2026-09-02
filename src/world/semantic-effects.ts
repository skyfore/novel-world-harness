import type {
  BranchSemanticDelta,
  BranchSemanticOperation,
  CommitId,
  Entity,
  EntityId,
  ObjectHash,
} from "./model.js";

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
        output.appraisals[appraisal.id] = { ...structuredClone(appraisal), introducedBy: provenance };
        break;
      }
      case "adjust-relationship": {
        requireCharacter(context.entities, operation.fromActorId, "Relationship source");
        requireCharacter(context.entities, operation.toActorId, "Relationship target");
        if (operation.fromActorId === operation.toActorId) throw new Error("A directed relationship cannot target the same actor");
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
