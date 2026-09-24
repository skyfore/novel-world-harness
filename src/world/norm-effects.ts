import type { ActionInvocation, CommitId, Entity, EntityId, NormDelta, NormOperation, WorldState } from "./model.js";
import type { EffectProvenance } from "./semantic-effects.js";
import { resolveNormTemplateScopes, validateNormReparation, type NormTemplate } from "./norm-ontology.js";

type InstantiatedNorm = Extract<NormOperation, { op: "instantiate-norm" }>["norm"];

export type NormInstance = InstantiatedNorm & {
  status: "active" | "satisfied" | "violated" | "repaired";
  instantiatedBy: EffectProvenance;
  updatedBy: EffectProvenance;
  resolvedByActorId?: EntityId;
  acknowledgedByActorId?: EntityId;
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
  /** State at action time, before its effects; seed callers use postState. */
  beforeState?: WorldState;
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
        requireEffectiveScope(norm, context);
        validateAcknowledgement(norm, operation.acknowledgedByActorId, context);
        if (operation.byActorId) {
          requireCharacter(context.entities, operation.byActorId, `Norm ${norm.id} resolver`);
          if (operation.byActorId !== norm.subjectActorId) throw new Error(`Norm ${norm.id} can only be satisfied by its subject`);
        }
        norm.status = "satisfied";
        if (operation.byActorId) norm.resolvedByActorId = operation.byActorId;
        if (operation.acknowledgedByActorId) norm.acknowledgedByActorId = operation.acknowledgedByActorId;
        norm.updatedBy = provenance;
        break;
      }
      case "violate-norm": {
        const norm = requireNorm(output, operation.normId);
        if (norm.status !== "active") throw new Error(`Norm ${norm.id} cannot be violated while ${norm.status}`);
        requireEffectiveScope(norm, context);
        if (operation.reasonId === "deadline-expired") {
          const elapsed = (context.beforeState ?? context.postState)?.logicalTime.elapsedDays;
          if (context.templates.get(norm.templateId)?.modality !== "obligation" || norm.dueAtElapsedDays === undefined
            || elapsed === undefined || elapsed < norm.dueAtElapsedDays) {
            throw new Error(`NORM_DEADLINE_NOT_DUE: ${norm.id} has no elapsed deadline at this cut. Stop unchanged retries; preserve the instance and establish time through normal committed events before reevaluation. Do not change the reason or ID to bypass this check.`);
          }
        }
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
        validateAcknowledgement(norm, operation.acknowledgedByActorId, context);
        if (operation.byActorId) requireCharacter(context.entities, operation.byActorId, `Norm ${norm.id} repair actor`);
        const template = context.templates.get(norm.templateId);
        if (!template) throw new Error(`Norm ${norm.id} cannot be repaired without an executable norm template`);
        if (!context.postState) throw new Error(`Norm ${norm.id} repair requires the projected post-state`);
        validateNormReparation(norm, template, operation.reparationId, context.action, context.postState);
        norm.status = "repaired";
        if (operation.byActorId) norm.resolvedByActorId = operation.byActorId;
        if (operation.acknowledgedByActorId) norm.acknowledgedByActorId = operation.acknowledgedByActorId;
        norm.reparationId = operation.reparationId;
        norm.updatedBy = provenance;
        break;
      }
    }
  }
  return output;
}

function validateAcknowledgement(norm: NormInstance, actorId: string | undefined, context: NormReducerContext): void {
  if (!actorId) return;
  requireCharacter(context.entities, actorId, `Norm ${norm.id} acknowledger`);
  if (actorId === norm.subjectActorId || (actorId !== norm.beneficiaryActorId
    && actorId !== context.templates.get(norm.templateId)?.authorityEntityId)) {
    throw new Error(`Norm ${norm.id} acknowledgement requires an independent beneficiary or authority`);
  }
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

function requireEffectiveScope(norm: NormInstance, context: NormReducerContext): void {
  // Automatically instantiated normative world-rule violations use their own resolver.
  if (!context.templates.has(norm.templateId)) return;
  const state = context.beforeState ?? context.postState;
  const status = state ? resolveNormTemplateScopes(context.templates.values(), state)
    .find(item => item.template.id === norm.templateId)?.status : "unknown";
  if (status !== "effective") throw new Error(`NORM_SCOPE_NOT_ACTIVE: ${norm.id} template ${norm.templateId} is ${status}. Preserve the unresolved instance; stop unchanged retries and do not substitute IDs or erase exceptions. Reevaluate only after source-supported scope facts change through normal committed events; unknown scope requires host review.`);
}
