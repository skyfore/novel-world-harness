import type { ActionInvocation, CommitId, Entity, EntityId, NormDelta, NormOperation, WorldState } from "./model.js";
import type { EffectProvenance } from "./semantic-effects.js";
import { validateNormReparation, type NormTemplate } from "./norm-ontology.js";

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

export type NormReducerContext = {
  entities: ReadonlyMap<EntityId, Entity>;
  templates: ReadonlyMap<string, NormTemplate>;
  normativeRuleIds?: ReadonlySet<string>;
  action?: ActionInvocation;
  postState?: WorldState;
};

export function emptyNormState(atCommit: CommitId): NormState {
  return { version: 1, atCommit, instances: {} };
}

export function applyNormDelta(
  input: NormState,
  delta: NormDelta,
  context: NormReducerContext,
  provenance: EffectProvenance,
): NormState {
  const output = structuredClone(input);
  output.atCommit = provenance.commitId;

  for (const operation of delta.operations) {
    switch (operation.op) {
      case "instantiate-norm": {
        const norm = operation.norm;
        if (output.instances[norm.id]) throw new Error(`Duplicate norm ID: ${norm.id}`);
        const template = context.templates.get(norm.templateId);
        if (!template && !context.normativeRuleIds?.has(norm.templateId)) throw new Error(`Unknown norm template ${norm.templateId}`);
        requireCharacter(context.entities, norm.subjectActorId, `Norm ${norm.id} subject`);
        if (norm.beneficiaryActorId) requireCharacter(context.entities, norm.beneficiaryActorId, `Norm ${norm.id} beneficiary`);
        if (template?.modality !== "obligation" && (norm.dueAtElapsedDays !== undefined || norm.dueStoryTime !== undefined)) {
          throw new Error(`Only obligation norm ${norm.id} may declare a deadline`);
        }
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
        if (operation.byActorId) {
          requireCharacter(context.entities, operation.byActorId, `Norm ${norm.id} resolver`);
          if (operation.byActorId !== norm.subjectActorId) throw new Error(`Norm ${norm.id} can only be satisfied by its subject`);
        }
        norm.status = "satisfied";
        if (operation.byActorId) norm.resolvedByActorId = operation.byActorId;
        norm.updatedBy = provenance;
        break;
      }
      case "violate-norm": {
        const norm = requireNorm(output, operation.normId);
        if (norm.status !== "active") throw new Error(`Norm ${norm.id} cannot be violated while ${norm.status}`);
        if (operation.byActorId) {
          requireCharacter(context.entities, operation.byActorId, `Norm ${norm.id} violator`);
          if (operation.byActorId !== norm.subjectActorId) throw new Error(`Norm ${norm.id} can only be violated by its subject`);
        }
        norm.status = "violated";
        if (operation.byActorId) norm.resolvedByActorId = operation.byActorId;
        if (operation.reasonId) norm.violationReasonId = operation.reasonId;
        norm.updatedBy = provenance;
        break;
      }
      case "repair-norm": {
        const norm = requireNorm(output, operation.normId);
        if (norm.status !== "violated") throw new Error(`Norm ${norm.id} cannot be repaired while ${norm.status}`);
        if (operation.byActorId) requireCharacter(context.entities, operation.byActorId, `Norm ${norm.id} repair actor`);
        const template = context.templates.get(norm.templateId);
        if (!template) throw new Error(`Norm ${norm.id} cannot be repaired without an executable norm template`);
        if (!context.postState) throw new Error(`Norm ${norm.id} repair requires the projected post-state`);
        validateNormReparation(norm, template, operation.reparationId, context.action, context.postState);
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
