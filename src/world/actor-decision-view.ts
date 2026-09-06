import { actionSchemaSchema } from "./action-ontology.js";
import { processTemplateSchema } from "./process-ontology.js";
import { normTemplateSchema } from "./norm-ontology.js";
import { actionConstraintSchema, type ActionPattern } from "./action-constraint.js";
import { z } from "zod";
import { projectCharacterDevelopment } from "./development.js";
import type { WorldEngine } from "./engine.js";
import { idSchema, predicateSchema, worldRuleSchema, valueTypeSchema, type StateValue, type ValueType } from "./model.js";
import { processOwnerEntityIds } from "./process-ontology.js";
import { evidenceBelongsExclusivelyToSource } from "./source-scope.js";
import { DEFAULT_STATE_FIELDS } from "./state.js";
import { mechanismIsDisclosed } from "./mechanism-visibility.js";
import { actorContractVisibility, contractReferenceIds, contractFieldKeys, mapActorContract } from "./actor-contracts.js";
import { worldRuleEvidence } from "./world-rule-ontology.js";

const hostChecks = { hostChecksRequired: z.boolean().default(false) };
const visibleWorldRuleSchema = z.object(worldRuleSchema.shape).pick({ id: true, name: true, kind: true, scope: true, authorityEntityId: true, jurisdictionEntityIds: true,
  appliesWhen: true, validStoryTime: true, priority: true, defeasible: true, overridesRuleIds: true, status: true }).extend({
  clauses: z.array(z.object({ id: idSchema, modality: z.enum(["require", "forbid"]), predicate: predicateSchema })),
  exceptions: z.array(z.object({ id: idSchema, appliesWhen: z.array(predicateSchema) })), ...hostChecks,
});
const visibleActionConstraintSchema = z.object(actionConstraintSchema.shape).pick({ id: true, name: true, actionPattern: true, appliesWhen: true, exceptions: true,
  priority: true, defeasible: true, overridesConstraintIds: true, status: true }).extend({ clauses: z.array(actionConstraintSchema.shape.clauses.element), ...hostChecks });

/** Actor-owned decision facts shared by player translation, NPCs and autonomous actors. */
export const actorDecisionViewSchema = z.object({
  capabilities: z.object({
    actions: z.array(z.object(actionSchemaSchema.shape).pick({ id: true, name: true, roles: true, initiatorRoleId: true, parameters: true, preconditions: true, stateEffects: true, effectEnvelope: true }).extend({ fieldValueTypes: z.record(z.string(), valueTypeSchema).default({}), ...hostChecks })),
    processes: z.array(z.object(processTemplateSchema.shape).pick({ id: true, name: true, ownerRoles: true, phases: true, initialPhaseId: true, transitions: true, outcomeIds: true, cadence: true, actorControls: true }).extend(hostChecks)),
    norms: z.array(z.object(normTemplateSchema.shape).pick({ id: true, name: true, modality: true, defaultDeadlineDays: true, actionPattern: true, authorityEntityId: true,
      appliesWhen: true, exceptions: true, reparations: true, priority: true, defeasible: true, overridesTemplateIds: true, status: true }).extend(hostChecks)),
  }).strict().default({ actions: [], processes: [], norms: [] }),
  constraints: z.object({ worldRules: z.array(visibleWorldRuleSchema), actions: z.array(visibleActionConstraintSchema) }).strict().default({ worldRules: [], actions: [] }),
  fieldValueTypes: z.record(z.string(), valueTypeSchema).default({}),
  goals: z.array(z.object({ id: idSchema, description: z.string(), priority: z.number(), targetIds: z.array(idSchema) }).strict()),
  appraisals: z.array(z.object({ id: idSchema, targetKind: z.enum(["entity", "event", "proposition"]), targetId: idSchema.optional(), dimensionId: idSchema, value: z.number() }).strict()),
  relationships: z.array(z.object({ id: idSchema, counterpartyId: idSchema, dimensions: z.record(z.string(), z.number()) }).strict()),
  obligations: z.array(z.object({ id: idSchema, role: z.enum(["debtor", "creditor"]), counterpartyId: idSchema.optional(), kindId: idSchema, description: z.string(), status: z.string() }).strict()),
  norms: z.array(z.object({ id: idSchema, templateId: idSchema, name: z.string(), modality: z.enum(["obligation", "prohibition", "permission"]), role: z.enum(["subject", "beneficiary"]), status: z.enum(["active", "violated"]), dueInDays: z.number().optional() }).strict()),
  processes: z.array(z.object({ id: idSchema, templateId: idSchema, name: z.string(), phase: z.string(), status: z.enum(["running", "paused"]), progress: z.number(), dueInDays: z.number().optional() }).strict()),
}).strict();
export type ActorDecisionView = z.infer<typeof actorDecisionViewSchema>;

export async function buildActorDecisionView(
  engine: WorldEngine,
  actorId: string,
  atCommit: string,
  scope: { visibleEntityIds: ReadonlySet<string>; observableEntityIds?: ReadonlySet<string>; knownClaimIds: ReadonlySet<string>; sourceId?: string },
): Promise<ActorDecisionView> {
  const [context, projection, development] = await Promise.all([
    engine.contextForCommit(atCommit), engine.projections.project(atCommit),
    projectCharacterDevelopment(engine, actorId, atCommit),
  ]);
  const activeGoals = new Set(development.activeGoalIds);
  const semantics = development.branchSemantics;
  const visible = (id: string) => scope.visibleEntityIds.has(id);
  const elapsed = projection.state.logicalTime.elapsedDays ?? 0;
  const goals = [
    ...(context.actorGoals ?? []).filter((goal) => goal.actorId === actorId && activeGoals.has(goal.id)
      && evidenceBelongsExclusivelyToSource(goal.evidence, scope.sourceId))
      .map((goal) => ({ id: goal.id, description: goal.description, priority: goal.priority, targetIds: (goal.targetIds ?? []).filter(visible) })),
    ...semantics.goals.filter((goal) => goal.status === "open")
      .map((goal) => ({ id: goal.id, description: goal.description, priority: goal.priority, targetIds: goal.targetEntityIds.filter(visible) })),
  ].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const appraisals = semantics.appraisals.flatMap((item): ActorDecisionView["appraisals"] => {
    if (item.target.kind === "entity" && !visible(item.target.entityId)) return [];
    return [{ id: item.id, targetKind: item.target.kind === "current-event" ? "event" : item.target.kind,
      ...(item.target.kind === "entity" ? { targetId: item.target.entityId } : {}),
      dimensionId: item.dimensionId, value: item.value }];
  });
  // A counterparty's private attitude is not automatically known by its target.
  const relationships = semantics.relationships.filter((item) => item.fromActorId === actorId && visible(item.toActorId))
    .map((item) => ({ id: item.id, counterpartyId: item.toActorId, dimensions: structuredClone(item.dimensions) }));
  const obligations = semantics.obligations.map((item): ActorDecisionView["obligations"][number] => {
    const role = item.debtorActorId === actorId ? "debtor" : "creditor";
    const counterparty = role === "debtor" ? item.creditorActorId : item.debtorActorId;
    return { id: item.id, role, ...(counterparty && visible(counterparty) ? { counterpartyId: counterparty } : {}),
      kindId: item.kindId, description: item.description, status: item.status };
  });
  const norms = Object.values(projection.norms.instances).flatMap((item): ActorDecisionView["norms"] => {
    if (item.status !== "active" && item.status !== "violated") return [];
    const role = item.subjectActorId === actorId ? "subject" : item.beneficiaryActorId === actorId ? "beneficiary" : undefined;
    const template = context.normTemplates?.get(item.templateId);
    if (!role || !template || !mechanismIsDisclosed(template, scope)) return [];
    return [{ id: item.id, templateId: template.id, name: template.name, modality: template.modality, role, status: item.status,
      ...(item.dueAtElapsedDays !== undefined ? { dueInDays: item.dueAtElapsedDays - elapsed } : {}) }];
  });
  const processes = Object.values(projection.processes.instances).flatMap((item): ActorDecisionView["processes"] => {
    if (item.status === "finished" || !processOwnerEntityIds(item).includes(actorId)) return [];
    const template = context.processTemplates?.get(item.templateId);
    if (!template || !mechanismIsDisclosed(template, scope)) return [];
    const phase = template.phases.find((entry) => entry.id === item.phaseId)?.label;
    if (!phase) return [];
    return [{ id: item.id, templateId: template.id, name: template.name, phase, status: item.status, progress: item.progress,
      ...(item.dueAtElapsedDays !== undefined ? { dueInDays: item.dueAtElapsedDays - elapsed } : {}) }];
  });
  norms.sort((a, b) => a.id.localeCompare(b.id));
  processes.sort((a, b) => a.id.localeCompare(b.id));
  const usable = (item: Parameters<typeof mechanismIsDisclosed>[0]) => mechanismIsDisclosed(item, scope);
  const publicRules = [...context.rules.values()].filter((rule) => rule.visibility !== "engine"
    && evidenceBelongsExclusivelyToSource(worldRuleEvidence(rule), scope.sourceId)
    && (rule.visibility !== "knowledge" || rule.knownByClaimIds.some((id) => scope.knownClaimIds.has(id)))
    && (rule.visibility !== "observable" || rule.scope === "global" || rule.jurisdictionEntityIds.some((id) => (scope.observableEntityIds ?? scope.visibleEntityIds).has(id)))
    && rule.jurisdictionEntityIds.every(visible) && (!rule.authorityEntityId || visible(rule.authorityEntityId)));
  const visibleRuleIds = new Set(publicRules.map((rule) => rule.id));
  const safe = actorContractVisibility({ context, actorId, ...scope, visibleRuleIds,
    ownedEntityIds: new Set(Object.entries(projection.state.values).filter(([, values]) => values["artifact.owner"] === actorId).map(([id]) => id)) });
  const visibleValue = (value: StateValue, type: ValueType) => type === "entity-ref" ? typeof value === "string" && visible(value)
    : type === "entity-ref-set" ? Array.isArray(value) && value.every((id) => typeof id === "string" && visible(id)) : true;
  const capabilities = {
    actions: [...(context.actionSchemas?.values() ?? [])].filter(usable).filter((schema) => schema.parameters.every((parameter) => parameter.allowedValues?.every((value) => visibleValue(value, parameter.valueType)) ?? true) && schema.stateEffects.every((effect) =>
      (effect.entity.kind !== "entity" || visible(effect.entity.entityId)) && (!("member" in effect) || effect.member.kind !== "entity" || visible(effect.member.entityId))
      && (!(effect.op === "set" && effect.value.source === "literal") || visibleValue(effect.value.value, context.stateSchema.get(effect.field).valueType))))
      .map(({ id, name, roles, initiatorRoleId, parameters, stateEffects, effectEnvelope, preconditions }) => ({ id, name, roles, initiatorRoleId, parameters, stateEffects, effectEnvelope,
        preconditions: preconditions.filter((predicate) => safe.predicate(predicate, new Set([initiatorRoleId]))),
        hostChecksRequired: preconditions.some((predicate) => !safe.predicate(predicate, new Set([initiatorRoleId]))),
        fieldValueTypes: Object.fromEntries([...stateEffects.map((effect) => effect.field), ...contractFieldKeys(preconditions.filter((predicate) => safe.predicate(predicate, new Set([initiatorRoleId]))))].map((field) => [field, context.stateSchema.get(field).valueType])) })),
    processes: [] as ActorDecisionView["capabilities"]["processes"],
    norms: [] as ActorDecisionView["capabilities"]["norms"],
  };
  const visibleActionIds = new Set(capabilities.actions.map((item) => item.id));
  const safePattern = (pattern?: ActionPattern) => !pattern || pattern.kind !== "schema" || visibleActionIds.has(pattern.schemaId);
  const safePredicates = (predicates: Parameters<typeof safe.predicate>[0][]) => predicates.every((predicate) => safe.predicate(predicate));
  capabilities.processes = [...(context.processTemplates?.values() ?? [])].filter(usable).map(({ id, name, ownerRoles, phases, initialPhaseId, transitions, outcomeIds, cadence, actorControls }) => {
    const controls = (actorControls ?? []).filter((control) => safePattern(control.actionPattern) && [...control.requiresBefore, ...control.requiresAfter].every((predicate) => safe.predicate(predicate,
      new Set(ownerRoles.filter((role) => role.allowedEntityKinds.length === 1 && role.allowedEntityKinds[0] === "character").map((role) => role.id)))));
    return { id, name, ownerRoles, phases, initialPhaseId, transitions, outcomeIds, ...(cadence ? { cadence } : {}), actorControls: controls, hostChecksRequired: controls.length !== (actorControls?.length ?? 0) };
  });
  const knownNorms = [...(context.normTemplates?.values() ?? [])].filter(usable).filter((norm) => safePattern(norm.actionPattern) && (!norm.authorityEntityId || visible(norm.authorityEntityId)));
  const normIds = new Set(knownNorms.map((norm) => norm.id));
  capabilities.norms = knownNorms.map(({ id, name, modality, defaultDeadlineDays, actionPattern, authorityEntityId, appliesWhen, exceptions, reparations, priority, defeasible, overridesTemplateIds, status }) => ({
    id, name, modality, defaultDeadlineDays, actionPattern, authorityEntityId, priority, defeasible, status,
    appliesWhen: appliesWhen.filter((predicate) => safe.predicate(predicate)), exceptions: exceptions.filter((exception) => safePredicates(exception.appliesWhen)),
    reparations: reparations.filter((reparation) => safePattern(reparation.actionPattern) && safePredicates(reparation.requiresAfter)), overridesTemplateIds: overridesTemplateIds.filter((id) => normIds.has(id)),
    hostChecksRequired: !safePredicates(appliesWhen) || exceptions.some((exception) => !safePredicates(exception.appliesWhen)) || reparations.some((reparation) => !safePattern(reparation.actionPattern) || !safePredicates(reparation.requiresAfter)) || overridesTemplateIds.some((id) => !normIds.has(id)),
  }));
  const actionConstraints = [...(context.actionConstraints?.values() ?? [])].filter(usable).filter((constraint) => safePattern(constraint.actionPattern));
  const constraintIds = new Set(actionConstraints.map((constraint) => constraint.id));
  const constraints = {
    worldRules: publicRules.map(({ id, name, kind, scope, authorityEntityId, jurisdictionEntityIds, appliesWhen, validStoryTime, priority, defeasible, overridesRuleIds, status, clauses, exceptions }) => ({
      id, name, kind, scope, authorityEntityId, jurisdictionEntityIds, priority, defeasible, status,
      ...(validStoryTime && !contractReferenceIds(validStoryTime).length ? { validStoryTime } : {}),
      appliesWhen: appliesWhen.filter((predicate) => safe.predicate(predicate)),
      clauses: clauses.filter((clause) => clause.status === "supported" && safe.predicate(clause.predicate)).map(({ id, modality, predicate }) => ({ id, modality, predicate })),
      exceptions: exceptions.filter((exception) => exception.status === "supported" && safePredicates(exception.appliesWhen)).map(({ id, appliesWhen }) => ({ id, appliesWhen })),
      overridesRuleIds: overridesRuleIds.filter((id) => visibleRuleIds.has(id)),
      hostChecksRequired: !safePredicates(appliesWhen) || clauses.some((clause) => !safe.predicate(clause.predicate)) || exceptions.some((exception) => !safePredicates(exception.appliesWhen)) || overridesRuleIds.some((id) => !visibleRuleIds.has(id)) || Boolean(validStoryTime && contractReferenceIds(validStoryTime).length),
    })),
    actions: actionConstraints.map(({ id, name, actionPattern, appliesWhen, clauses, exceptions, priority, defeasible, overridesConstraintIds, status }) => {
      const initiator = actionPattern.kind === "schema" ? context.actionSchemas?.get(actionPattern.schemaId)?.initiatorRoleId : undefined;
      const disclose = (predicate: Parameters<typeof safe.predicate>[0]) => safe.predicate(predicate, new Set(initiator ? [initiator] : []));
      return {
      id, name, actionPattern, priority, defeasible, status, appliesWhen: appliesWhen.filter(disclose),
      clauses: clauses.filter((clause) => disclose(clause.predicate)), exceptions: exceptions.filter((exception) => exception.appliesWhen.every(disclose)), overridesConstraintIds: overridesConstraintIds.filter((id) => constraintIds.has(id)),
      hostChecksRequired: !appliesWhen.every(disclose) || clauses.some((clause) => !disclose(clause.predicate)) || exceptions.some((exception) => !exception.appliesWhen.every(disclose)) || overridesConstraintIds.some((id) => !constraintIds.has(id)),
    }; }),
  };
  const fieldValueTypes = Object.fromEntries(contractFieldKeys({ capabilities, constraints }).map((field) => [field, context.stateSchema.get(field).valueType]));
  return actorDecisionViewSchema.parse({ goals, appraisals, relationships, obligations, norms, processes, capabilities, constraints, fieldValueTypes });
}

export function decisionReferenceIds(view?: ActorDecisionView): string[] {
  if (!view) return [];
  return [...new Set([
    ...view.capabilities.actions.map((item) => item.id), ...view.capabilities.processes.map((item) => item.id), ...view.capabilities.norms.map((item) => item.id),
    ...view.goals.map((item) => item.id), ...view.appraisals.map((item) => item.id),
    ...view.relationships.map((item) => item.id), ...view.obligations.map((item) => item.id),
    ...view.norms.flatMap((item) => [item.id, item.templateId]),
    ...view.processes.flatMap((item) => [item.id, item.templateId]),
    ...view.constraints.worldRules.map((item) => item.id), ...view.constraints.actions.map((item) => item.id),
    ...contractReferenceIds({ capabilities: view.capabilities, constraints: view.constraints }),
  ])].sort();
}

export function mapActorDecisionView(view: ActorDecisionView, entity: (id: string) => string, ref: (id: string) => string): ActorDecisionView {
  const mapValue = (value: StateValue, type: ValueType | undefined): StateValue => type === "entity-ref" && typeof value === "string" ? entity(value)
    : type === "entity-ref-set" && Array.isArray(value) ? value.map((id) => entity(String(id))) : value;
  return {
    fieldValueTypes: view.fieldValueTypes,
    constraints: {
      worldRules: view.constraints.worldRules.map((item) => mapActorContract({ ...item, id: ref(item.id) }, entity, ref, view.fieldValueTypes)),
      actions: view.constraints.actions.map((item) => mapActorContract({ ...item, id: ref(item.id) }, entity, ref, view.fieldValueTypes)),
    },
    capabilities: {
      actions: view.capabilities.actions.map((x) => ({ ...x, id: ref(x.id),
        preconditions: mapActorContract(x.preconditions, entity, ref, { ...view.fieldValueTypes, ...x.fieldValueTypes }),
        parameters: x.parameters.map((parameter) => ({ ...parameter, ...(parameter.allowedValues ? { allowedValues: parameter.allowedValues.map((value) => parameter.valueType === "entity-ref" && typeof value === "string" ? entity(value) : parameter.valueType === "entity-ref-set" && Array.isArray(value) ? value.map((id) => entity(String(id))) : value) } : {}) })),
        stateEffects: x.stateEffects.map((effect) => ({ ...effect,
          entity: effect.entity.kind === "entity" ? { ...effect.entity, entityId: entity(effect.entity.entityId) } : effect.entity,
          ...("member" in effect && effect.member.kind === "entity" ? { member: { ...effect.member, entityId: entity(effect.member.entityId) } } : {}),
          ...(effect.op === "set" && effect.value.source === "literal" ? { value: { source: "literal" as const, value: mapValue(effect.value.value, x.fieldValueTypes?.[effect.field] ?? DEFAULT_STATE_FIELDS.find((field) => field.key === effect.field)?.valueType) } } : {}),
        })),
      })),
      processes: view.capabilities.processes.map((x) => mapActorContract({ ...x, id: ref(x.id) }, entity, ref, view.fieldValueTypes)),
      norms: view.capabilities.norms.map((x) => mapActorContract({ ...x, id: ref(x.id) }, entity, ref, view.fieldValueTypes)),
    },
    goals: view.goals.map((item) => ({ ...item, id: ref(item.id), targetIds: item.targetIds.map(entity) })),
    appraisals: view.appraisals.map((item) => ({ ...item, id: ref(item.id), ...(item.targetId ? { targetId: entity(item.targetId) } : {}) })),
    relationships: view.relationships.map((item) => ({ ...item, id: ref(item.id), counterpartyId: entity(item.counterpartyId) })),
    obligations: view.obligations.map((item) => ({ ...item, id: ref(item.id), ...(item.counterpartyId ? { counterpartyId: entity(item.counterpartyId) } : {}) })),
    norms: view.norms.map((item) => ({ ...item, id: ref(item.id), templateId: ref(item.templateId) })),
    processes: view.processes.map((item) => ({ ...item, id: ref(item.id), templateId: ref(item.templateId) })),
  };
}
