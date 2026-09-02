import type { CommitId, Entity, EntityId, NormDelta, NormOperation } from "./model.js";
import type { EffectProvenance } from "./semantic-effects.js";

type InstantiatedNorm = Extract<NormOperation, { op: "instantiate-norm" }>["norm"];

export type NormInstance = InstantiatedNorm & {
  status: "active" | "satisfied" | "violated" | "repaired";
  instantiatedBy: EffectProvenance;
  updatedBy: EffectProvenance;
  resolvedByActorId?: EntityId;
  violationReasonId?: string;
  reparationId?: string;
};

export type NormState = {
  version: 1;
  atCommit: CommitId;
  instances: Record<string, NormInstance>;
};

export function emptyNormState(atCommit: CommitId): NormState {
  return { version: 1, atCommit, instances: {} };
}

export function applyNormDelta(
  input: NormState,
  delta: NormDelta,
  entities: ReadonlyMap<EntityId, Entity>,
  provenance: EffectProvenance,
): NormState {
  const output = structuredClone(input);
  output.atCommit = provenance.commitId;

  for (const operation of delta.operations) {
    switch (operation.op) {
      case "instantiate-norm": {
        const norm = operation.norm;
        if (output.instances[norm.id]) throw new Error(`Duplicate norm ID: ${norm.id}`);
        requireCharacter(entities, norm.subjectActorId, `Norm ${norm.id} subject`);
        if (norm.beneficiaryActorId) requireCharacter(entities, norm.beneficiaryActorId, `Norm ${norm.id} beneficiary`);
        output.instances[norm.id] = {
          ...structuredClone(norm),
          status: "active",
          instantiatedBy: provenance,
          updatedBy: provenance,
        };
        break;
      }
      case "satisfy-norm": {
        const norm = requireNorm(output, operation.normId);
        if (norm.status !== "active") throw new Error(`Norm ${norm.id} cannot be satisfied while ${norm.status}`);
        if (operation.byActorId) requireCharacter(entities, operation.byActorId, `Norm ${norm.id} resolver`);
        norm.status = "satisfied";
        if (operation.byActorId) norm.resolvedByActorId = operation.byActorId;
        norm.updatedBy = provenance;
        break;
      }
      case "violate-norm": {
        const norm = requireNorm(output, operation.normId);
        if (norm.status !== "active") throw new Error(`Norm ${norm.id} cannot be violated while ${norm.status}`);
        if (operation.byActorId) requireCharacter(entities, operation.byActorId, `Norm ${norm.id} violator`);
        norm.status = "violated";
        if (operation.byActorId) norm.resolvedByActorId = operation.byActorId;
        if (operation.reasonId) norm.violationReasonId = operation.reasonId;
        norm.updatedBy = provenance;
        break;
      }
      case "repair-norm": {
        const norm = requireNorm(output, operation.normId);
        if (norm.status !== "violated") throw new Error(`Norm ${norm.id} cannot be repaired while ${norm.status}`);
        if (operation.byActorId) requireCharacter(entities, operation.byActorId, `Norm ${norm.id} repair actor`);
        norm.status = "repaired";
        if (operation.byActorId) norm.resolvedByActorId = operation.byActorId;
        norm.reparationId = operation.reparationId;
        norm.updatedBy = provenance;
        break;
      }
    }
  }
  return output;
}

function requireNorm(state: NormState, normId: string): NormInstance {
  const norm = state.instances[normId];
  if (!norm) throw new Error(`Unknown norm ${normId}`);
  return norm;
}

function requireCharacter(entities: ReadonlyMap<EntityId, Entity>, entityId: EntityId, label: string): Entity {
  const entity = entities.get(entityId);
  if (!entity || entity.kind !== "character") throw new Error(`${label} ${entityId} must be a character`);
  return entity;
}
