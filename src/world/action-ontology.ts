import { z } from "zod";
import { canonicalJson } from "./canonical.js";
import {
  actionInvocationSchema,
  entityKindSchema,
  evidenceRefSchema,
  idSchema,
  stateValueSchema,
  valueTypeSchema,
  type ActionInvocation,
  type ActionStateAddress,
  type Entity,
  type Predicate,
  type StateDelta,
  type StateOperation,
  type StateValue,
  type ValidationIssue,
} from "./model.js";

export const ACTION_ONTOLOGY_VERSION = "action-schema-v1" as const;

export const templateEntityRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("role"), roleId: idSchema }).strict(),
  z.object({ kind: z.literal("entity"), entityId: idSchema }).strict(),
]);
export type TemplateEntityRef = z.infer<typeof templateEntityRefSchema>;

export const templateValueSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("literal"), value: stateValueSchema }).strict(),
  z.object({ source: z.literal("parameter"), parameterId: idSchema }).strict(),
  z.object({ source: z.literal("role"), roleId: idSchema }).strict(),
]);
export type TemplateValue = z.infer<typeof templateValueSchema>;

export type PredicateTemplate =
  | { op: "fact-equals"; entity: TemplateEntityRef; field: string; value: TemplateValue }
  | { op: "fact-gte"; entity: TemplateEntityRef; field: string; value: number }
  | { op: "fact-lte"; entity: TemplateEntityRef; field: string; value: number }
  | { op: "fact-exists"; entity: TemplateEntityRef; field: string }
  | { op: "entity-in"; entity: TemplateEntityRef; field: string; member: TemplateEntityRef }
  | { op: "rule-active"; ruleId: string }
  | { op: "elapsed-days-gte"; days: number }
  | { op: "elapsed-days-lte"; days: number }
  | { op: "all"; items: PredicateTemplate[] }
  | { op: "any"; items: PredicateTemplate[] }
  | { op: "not"; item: PredicateTemplate };

export const predicateTemplateSchema: z.ZodType<PredicateTemplate> = z.lazy(() => z.discriminatedUnion("op", [
  z.object({ op: z.literal("fact-equals"), entity: templateEntityRefSchema, field: z.string().min(1), value: templateValueSchema }).strict(),
  z.object({ op: z.literal("fact-gte"), entity: templateEntityRefSchema, field: z.string().min(1), value: z.number().finite() }).strict(),
  z.object({ op: z.literal("fact-lte"), entity: templateEntityRefSchema, field: z.string().min(1), value: z.number().finite() }).strict(),
  z.object({ op: z.literal("fact-exists"), entity: templateEntityRefSchema, field: z.string().min(1) }).strict(),
  z.object({ op: z.literal("entity-in"), entity: templateEntityRefSchema, field: z.string().min(1), member: templateEntityRefSchema }).strict(),
  z.object({ op: z.literal("rule-active"), ruleId: idSchema }).strict(),
  z.object({ op: z.literal("elapsed-days-gte"), days: z.number().finite().nonnegative() }).strict(),
  z.object({ op: z.literal("elapsed-days-lte"), days: z.number().finite().nonnegative() }).strict(),
  z.object({ op: z.literal("all"), items: z.array(predicateTemplateSchema).max(64) }).strict(),
  z.object({ op: z.literal("any"), items: z.array(predicateTemplateSchema).max(64) }).strict(),
  z.object({ op: z.literal("not"), item: predicateTemplateSchema }).strict(),
]));

export const actionRoleSpecSchema = z.object({
  id: idSchema,
  label: z.string().trim().min(1).max(240),
  allowedEntityKinds: z.array(entityKindSchema).min(1).max(8),
  minCardinality: z.number().int().nonnegative().max(32),
  maxCardinality: z.number().int().positive().max(32),
}).strict().superRefine((value, ctx) => {
  if (value.maxCardinality < value.minCardinality) {
    ctx.addIssue({ code: "custom", path: ["maxCardinality"], message: "maxCardinality must be >= minCardinality" });
  }
  if (new Set(value.allowedEntityKinds).size !== value.allowedEntityKinds.length) {
    ctx.addIssue({ code: "custom", path: ["allowedEntityKinds"], message: "allowedEntityKinds must be unique" });
  }
});
export type ActionRoleSpec = z.infer<typeof actionRoleSpecSchema>;

export const actionParameterSpecSchema = z.object({
  id: idSchema,
  valueType: valueTypeSchema,
  required: z.boolean(),
  allowedValues: z.array(stateValueSchema).min(1).max(64).optional(),
}).strict();
export type ActionParameterSpec = z.infer<typeof actionParameterSpecSchema>;

const actionStateEffectTemplateSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), entity: templateEntityRefSchema, field: z.string().min(1), value: templateValueSchema, required: z.boolean().default(true) }).strict(),
  z.object({ op: z.literal("unset"), entity: templateEntityRefSchema, field: z.string().min(1), required: z.boolean().default(true) }).strict(),
  z.object({ op: z.literal("adjust-number"), entity: templateEntityRefSchema, field: z.string().min(1), amount: z.number().finite().refine((value) => value !== 0), required: z.boolean().default(true) }).strict(),
  z.object({ op: z.literal("add-member"), entity: templateEntityRefSchema, field: z.string().min(1), member: templateEntityRefSchema, required: z.boolean().default(true) }).strict(),
  z.object({ op: z.literal("remove-member"), entity: templateEntityRefSchema, field: z.string().min(1), member: templateEntityRefSchema, required: z.boolean().default(true) }).strict(),
]);
export type ActionStateEffectTemplate = z.infer<typeof actionStateEffectTemplateSchema>;

export const actionSchemaSchema = z.object({
  ontologyVersion: z.literal(ACTION_ONTOLOGY_VERSION),
  id: idSchema,
  name: z.string().trim().min(1).max(300),
  roles: z.array(actionRoleSpecSchema).min(1).max(32),
  initiatorRoleId: idSchema.describe("The single character role that must be bound to the acting character; binding another role does not grant initiation authority."),
  parameters: z.array(actionParameterSpecSchema).max(32),
  preconditions: z.array(predicateTemplateSchema).max(64),
  stateEffects: z.array(actionStateEffectTemplateSchema).max(64),
  effectEnvelope: z.object({
    maxStateOperations: z.number().int().nonnegative().max(128),
    allowedStateFields: z.array(z.string().min(1)).max(128),
    allowsKnowledge: z.boolean(),
    allowsTimeAdvance: z.boolean(),
    allowsSceneTransition: z.boolean(),
  }).strict(),
  induction: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("source-pattern"), supportingEventIds: z.array(idSchema).min(2).max(64) }).strict(),
    z.object({ kind: z.literal("domain-module"), moduleId: idSchema, moduleVersion: z.string().trim().min(1).max(120) }).strict(),
  ]),
  evidence: z.array(evidenceRefSchema),
}).strict().superRefine((value, ctx) => {
  const initiator = value.roles.find((role) => role.id === value.initiatorRoleId);
  if (!initiator || initiator.minCardinality !== 1 || initiator.maxCardinality !== 1 || !initiator.allowedEntityKinds.includes("character")) ctx.addIssue({ code: "custom", path: ["initiatorRoleId"], message: "Action initiator must reference a single required character role" });
  for (const [field, ids] of [
    ["roles", value.roles.map((role) => role.id)],
    ["parameters", value.parameters.map((parameter) => parameter.id)],
    ["allowedStateFields", value.effectEnvelope.allowedStateFields],
  ] as const) {
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", path: [field], message: `${field} identifiers must be unique` });
    }
  }
  if (value.induction.kind === "source-pattern" && !value.evidence.length) {
    ctx.addIssue({ code: "custom", path: ["evidence"], message: "A source-induced action schema requires source evidence" });
  }
  if (value.induction.kind === "source-pattern"
    && new Set(value.induction.supportingEventIds).size !== value.induction.supportingEventIds.length) {
    ctx.addIssue({ code: "custom", path: ["induction", "supportingEventIds"], message: "Supporting event IDs must be unique" });
  }
  if (value.induction.kind === "domain-module" && value.evidence.length) {
    ctx.addIssue({ code: "custom", path: ["evidence"], message: "Domain mechanics use module provenance, not novel EvidenceRefs" });
  }
  if (value.stateEffects.length > value.effectEnvelope.maxStateOperations) {
    ctx.addIssue({ code: "custom", path: ["effectEnvelope", "maxStateOperations"], message: "The effect envelope cannot be smaller than the declared state effect set" });
  }
});
export type ActionSchema = z.infer<typeof actionSchemaSchema>;

export type ResolvedActionInvocation = {
  issues: ValidationIssue[];
  preconditions: Predicate[];
  stateEffects: Array<{ operation: StateOperation; required: boolean }>;
};

/** Resolve and validate the schema-bound lane; ad-hoc actions keep normal engine validation. */
export function resolveActionInvocation(
  invocationInput: ActionInvocation,
  schemas: ReadonlyMap<string, ActionSchema>,
  entities: ReadonlyMap<string, Entity>,
  input: {
    participants: readonly string[];
    actorId?: string;
    proposedDelta: StateDelta;
    hasKnowledge: boolean;
    hasTimeAdvance: boolean;
    hasSceneTransition: boolean;
    proposalPreconditions?: readonly Predicate[];
  },
): ResolvedActionInvocation {
  const invocation = actionInvocationSchema.parse(invocationInput);
  if (invocation.lane === "ad-hoc") {
    return {
      issues: validateAdHocActionFootprint(invocation, input.proposedDelta, input.proposalPreconditions ?? [], entities),
      preconditions: [],
      stateEffects: [],
    };
  }
  const schema = schemas.get(invocation.schemaId);
  if (!schema) return {
    issues: [issue("UNKNOWN_ACTION_SCHEMA", `Unknown action schema ${invocation.schemaId}`, "action.schemaId")],
    preconditions: [],
    stateEffects: [],
  };
  const issues = validateActionBindings(schema, invocation, entities, input.participants);
  const roles = new Map(invocation.roleBindings.map((binding) => [binding.roleId, binding.entityIds]));
  if (input.actorId && (roles.get(schema.initiatorRoleId)?.length !== 1 || roles.get(schema.initiatorRoleId)?.[0] !== input.actorId)) issues.push(issue("ACTION_INITIATOR_MISMATCH", "The action initiator role must be bound to the acting character", "action.roleBindings"));
  const parameters = invocation.parameters;
  validateActionParameters(schema, parameters, issues);
  let preconditions: Predicate[] = [];
  let stateEffects: Array<{ operation: StateOperation; required: boolean }> = [];
  if (!issues.length) {
    try {
      preconditions = schema.preconditions.map((template) => instantiatePredicate(template, roles, parameters));
      stateEffects = schema.stateEffects.map((template) => instantiateEffect(template, roles, parameters));
    } catch (error) {
      issues.push(issue("ACTION_TEMPLATE_BINDING_FAILED", error instanceof Error ? error.message : String(error), "action.roleBindings"));
    }
  }
  if (input.proposedDelta.operations.length > schema.effectEnvelope.maxStateOperations) {
    issues.push(issue("ACTION_EFFECT_ENVELOPE_EXCEEDED", `Action ${schema.id} exceeds its maximum state operation count`, "proposedDelta.operations"));
  }
  for (const [index, operation] of input.proposedDelta.operations.entries()) {
    if ("field" in operation && !schema.effectEnvelope.allowedStateFields.includes(operation.field)) {
      issues.push(issue("ACTION_EFFECT_FIELD_FORBIDDEN", `Action ${schema.id} cannot write ${operation.field}`, `proposedDelta.operations.${index}.field`));
    }
  }
  if (input.hasKnowledge && !schema.effectEnvelope.allowsKnowledge) {
    issues.push(issue("ACTION_KNOWLEDGE_EFFECT_FORBIDDEN", `Action ${schema.id} does not allow a knowledge effect`, "proposedKnowledge"));
  }
  if (input.hasTimeAdvance && !schema.effectEnvelope.allowsTimeAdvance) {
    issues.push(issue("ACTION_TIME_EFFECT_FORBIDDEN", `Action ${schema.id} does not allow time advancement`, "timeAdvance"));
  }
  if (input.hasSceneTransition && !schema.effectEnvelope.allowsSceneTransition) {
    issues.push(issue("ACTION_SCENE_EFFECT_FORBIDDEN", `Action ${schema.id} does not allow a scene transition`, "progress.scene"));
  }
  if (!issues.length) validateInstantiatedEffects(input.proposedDelta, stateEffects, schema.id, issues);
  return { issues, preconditions, stateEffects };
}

/** Validate that an unknown action still declares an exact, inspectable footprint. */
export function validateAdHocActionFootprint(
  invocation: Extract<ActionInvocation, { lane: "ad-hoc" }>,
  delta: StateDelta,
  preconditions: readonly Predicate[],
  entities: ReadonlyMap<string, Entity>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const addressKey = (address: ActionStateAddress) => `${address.entityId}\u0000${address.field}`;
  const reads = new Set(invocation.footprint.reads.map(addressKey));
  const writes = new Set(invocation.footprint.writes.map(addressKey));
  const actualWrites = new Set(delta.operations.flatMap((operation) =>
    "entityId" in operation && "field" in operation
      ? [`${operation.entityId}\u0000${operation.field}`]
      : []));
  for (const [field, addresses] of [["reads", invocation.footprint.reads], ["writes", invocation.footprint.writes]] as const) {
    addresses.forEach((address, index) => {
      if (!entities.has(address.entityId)) {
        issues.push(issue("UNKNOWN_ACTION_FOOTPRINT_ENTITY", `Ad-hoc action footprint references unknown entity ${address.entityId}`, `action.footprint.${field}.${index}.entityId`));
      }
    });
  }
  for (const key of actualWrites) {
    if (!writes.has(key)) issues.push(issue("AD_HOC_ACTION_WRITE_UNDECLARED", `Ad-hoc action writes undeclared state address ${printAddress(key)}`, "action.footprint.writes"));
  }
  for (const key of writes) {
    if (!actualWrites.has(key)) issues.push(issue("AD_HOC_ACTION_WRITE_UNUSED", `Ad-hoc action declares unused write ${printAddress(key)}`, "action.footprint.writes"));
  }
  for (const predicate of preconditions) {
    for (const address of predicateStateAddresses(predicate)) {
      const key = addressKey(address);
      if (!reads.has(key)) issues.push(issue("AD_HOC_ACTION_READ_UNDECLARED", `Ad-hoc action precondition reads undeclared state address ${printAddress(key)}`, "action.footprint.reads"));
    }
  }
  invocation.footprint.resources.forEach((claim, index) => {
    const key = addressKey(claim);
    if (!entities.has(claim.entityId)) {
      issues.push(issue("UNKNOWN_ACTION_RESOURCE_ENTITY", `Resource claim references unknown entity ${claim.entityId}`, `action.footprint.resources.${index}.entityId`));
    }
    if (!reads.has(key)) {
      issues.push(issue("ACTION_RESOURCE_READ_REQUIRED", `Resource claim ${printAddress(key)} must be declared as a read`, `action.footprint.resources.${index}`));
    }
    const mutates = ["consume", "produce", "transfer-in", "transfer-out"].includes(claim.mode);
    if (mutates && !writes.has(key)) {
      issues.push(issue("ACTION_RESOURCE_WRITE_REQUIRED", `Mutating resource claim ${printAddress(key)} must be declared as a write`, `action.footprint.resources.${index}`));
    }
    if (!mutates) return;
    const expected = ["consume", "transfer-out"].includes(claim.mode) ? -claim.amount! : claim.amount!;
    const matching = delta.operations.some((operation) => operation.op === "adjust-number"
      && operation.entityId === claim.entityId
      && operation.field === claim.field
      && operation.amount === expected);
    if (!matching) {
      issues.push(issue("ACTION_RESOURCE_CLAIM_MISMATCH", `Resource claim ${claim.mode} ${claim.amount} does not match a numeric state adjustment`, `action.footprint.resources.${index}`));
    }
  });
  return issues;
}

export function predicateStateAddresses(predicate: Predicate): ActionStateAddress[] {
  if (predicate.op === "all" || predicate.op === "any") return predicate.items.flatMap(predicateStateAddresses);
  if (predicate.op === "not") return predicateStateAddresses(predicate.item);
  if ("entityId" in predicate && "field" in predicate) return [{ entityId: predicate.entityId, field: predicate.field }];
  return [];
}

function printAddress(key: string): string {
  return key.replace("\u0000", ".");
}

export function validateActionSchemaCatalog(
  schemaInput: ActionSchema,
  entities: ReadonlyMap<string, Entity>,
  canonicalEventIds: ReadonlySet<string>,
): ValidationIssue[] {
  const schema = actionSchemaSchema.parse(schemaInput);
  const issues: ValidationIssue[] = [];
  if (schema.induction.kind === "source-pattern") {
    schema.induction.supportingEventIds.forEach((eventId, index) => {
      if (!canonicalEventIds.has(eventId)) {
        issues.push(issue("UNKNOWN_ACTION_SUPPORT_EVENT", `Action schema ${schema.id} cites unknown event ${eventId}`, `induction.supportingEventIds.${index}`));
      }
    });
  }
  const roleIds = new Set(schema.roles.map((role) => role.id));
  const parameterIds = new Set(schema.parameters.map((parameter) => parameter.id));
  const inspectEntity = (ref: TemplateEntityRef, path: string) => {
    if (ref.kind === "role" && !roleIds.has(ref.roleId)) issues.push(issue("UNKNOWN_ACTION_TEMPLATE_ROLE", `Unknown action role ${ref.roleId}`, path));
    if (ref.kind === "entity" && !entities.has(ref.entityId)) issues.push(issue("UNKNOWN_ACTION_TEMPLATE_ENTITY", `Unknown canonical entity ${ref.entityId}`, path));
  };
  const inspectValue = (value: TemplateValue, path: string) => {
    if (value.source === "role" && !roleIds.has(value.roleId)) issues.push(issue("UNKNOWN_ACTION_TEMPLATE_ROLE", `Unknown action role ${value.roleId}`, path));
    if (value.source === "parameter" && !parameterIds.has(value.parameterId)) issues.push(issue("UNKNOWN_ACTION_TEMPLATE_PARAMETER", `Unknown action parameter ${value.parameterId}`, path));
  };
  const inspectPredicate = (predicate: PredicateTemplate, path: string): void => {
    if (predicate.op === "all" || predicate.op === "any") return predicate.items.forEach((item, index) => inspectPredicate(item, `${path}.items.${index}`));
    if (predicate.op === "not") return inspectPredicate(predicate.item, `${path}.item`);
    if ("entity" in predicate) inspectEntity(predicate.entity, `${path}.entity`);
    if (predicate.op === "entity-in") inspectEntity(predicate.member, `${path}.member`);
    if (predicate.op === "fact-equals") inspectValue(predicate.value, `${path}.value`);
  };
  schema.preconditions.forEach((predicate, index) => inspectPredicate(predicate, `preconditions.${index}`));
  schema.stateEffects.forEach((effect, index) => {
    inspectEntity(effect.entity, `stateEffects.${index}.entity`);
    if (effect.op === "set") inspectValue(effect.value, `stateEffects.${index}.value`);
    if (effect.op === "add-member" || effect.op === "remove-member") inspectEntity(effect.member, `stateEffects.${index}.member`);
    if (!schema.effectEnvelope.allowedStateFields.includes(effect.field)) {
      issues.push(issue("ACTION_EFFECT_OUTSIDE_ENVELOPE", `Declared effect field ${effect.field} is outside the action envelope`, `stateEffects.${index}.field`));
    }
  });
  return issues;
}

function validateActionBindings(
  schema: ActionSchema,
  invocation: Extract<ActionInvocation, { lane: "schema-bound" }>,
  entities: ReadonlyMap<string, Entity>,
  participants: readonly string[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const specs = new Map(schema.roles.map((role) => [role.id, role]));
  const bindings = new Map(invocation.roleBindings.map((binding) => [binding.roleId, binding.entityIds]));
  for (const binding of invocation.roleBindings) {
    const spec = specs.get(binding.roleId);
    if (!spec) {
      issues.push(issue("UNKNOWN_ACTION_ROLE", `Action schema ${schema.id} has no role ${binding.roleId}`, "action.roleBindings"));
      continue;
    }
    if (binding.entityIds.length < spec.minCardinality || binding.entityIds.length > spec.maxCardinality) {
      issues.push(issue("ACTION_ROLE_CARDINALITY", `Role ${binding.roleId} requires ${spec.minCardinality}..${spec.maxCardinality} entities`, "action.roleBindings"));
    }
    for (const entityId of binding.entityIds) {
      const entity = entities.get(entityId);
      if (!entity) issues.push(issue("UNKNOWN_ACTION_ROLE_ENTITY", `Action role ${binding.roleId} references unknown entity ${entityId}`, "action.roleBindings"));
      else if (!spec.allowedEntityKinds.includes(entity.kind)) issues.push(issue("ACTION_ROLE_KIND", `Action role ${binding.roleId} does not allow ${entity.kind} ${entityId}`, "action.roleBindings"));
      if (!participants.includes(entityId)) issues.push(issue("ACTION_ROLE_NOT_PARTICIPANT", `Action-bound entity ${entityId} must be an event participant`, "participants"));
    }
  }
  for (const spec of schema.roles) {
    if ((bindings.get(spec.id)?.length ?? 0) < spec.minCardinality) {
      issues.push(issue("MISSING_ACTION_ROLE", `Action ${schema.id} requires role ${spec.id}`, "action.roleBindings"));
    }
  }
  return issues;
}

function validateActionParameters(schema: ActionSchema, parameters: Record<string, StateValue>, issues: ValidationIssue[]): void {
  const specs = new Map(schema.parameters.map((parameter) => [parameter.id, parameter]));
  for (const key of Object.keys(parameters)) {
    if (!specs.has(key)) issues.push(issue("UNKNOWN_ACTION_PARAMETER", `Action ${schema.id} has no parameter ${key}`, `action.parameters.${key}`));
  }
  for (const spec of schema.parameters) {
    const value = parameters[spec.id];
    if (value === undefined) {
      if (spec.required) issues.push(issue("MISSING_ACTION_PARAMETER", `Action ${schema.id} requires parameter ${spec.id}`, `action.parameters.${spec.id}`));
      continue;
    }
    if (!stateValueMatchesType(value, spec.valueType)) {
      issues.push(issue("ACTION_PARAMETER_TYPE", `Action parameter ${spec.id} does not match ${spec.valueType}`, `action.parameters.${spec.id}`));
    }
    if (spec.allowedValues && !spec.allowedValues.some((allowed) => canonicalJson(allowed) === canonicalJson(value))) {
      issues.push(issue("ACTION_PARAMETER_VALUE", `Action parameter ${spec.id} is outside its allowed values`, `action.parameters.${spec.id}`));
    }
  }
}

function instantiatePredicate(
  template: PredicateTemplate,
  roles: ReadonlyMap<string, string[]>,
  parameters: Readonly<Record<string, StateValue>>,
): Predicate {
  if (template.op === "all" || template.op === "any") return { op: template.op, items: template.items.map((item) => instantiatePredicate(item, roles, parameters)) };
  if (template.op === "not") return { op: "not", item: instantiatePredicate(template.item, roles, parameters) };
  if (template.op === "rule-active") return { op: "rule-active", ruleId: template.ruleId };
  if (template.op === "elapsed-days-gte" || template.op === "elapsed-days-lte") return { ...template };
  const entityId = resolveOneEntity(template.entity, roles);
  if (template.op === "fact-exists") return { op: template.op, entityId, field: template.field };
  if (template.op === "fact-gte" || template.op === "fact-lte") return { op: template.op, entityId, field: template.field, value: template.value };
  if (template.op === "entity-in") return { op: template.op, entityId, field: template.field, member: resolveOneEntity(template.member, roles) };
  return { op: "fact-equals", entityId, field: template.field, value: resolveTemplateValue(template.value, roles, parameters) };
}

function instantiateEffect(
  template: ActionStateEffectTemplate,
  roles: ReadonlyMap<string, string[]>,
  parameters: Readonly<Record<string, StateValue>>,
): { operation: StateOperation; required: boolean } {
  const entityId = resolveOneEntity(template.entity, roles);
  if (template.op === "set") return { required: template.required, operation: { op: "set", entityId, field: template.field, value: resolveTemplateValue(template.value, roles, parameters) } };
  if (template.op === "unset") return { required: template.required, operation: { op: "unset", entityId, field: template.field } };
  if (template.op === "adjust-number") return { required: template.required, operation: { op: "adjust-number", entityId, field: template.field, amount: template.amount } };
  return { required: template.required, operation: { op: template.op, entityId, field: template.field, member: resolveOneEntity(template.member, roles) } };
}

function validateInstantiatedEffects(
  delta: StateDelta,
  allowedEffects: readonly { operation: StateOperation; required: boolean }[],
  schemaId: string,
  issues: ValidationIssue[],
): void {
  const actual = new Set(delta.operations.map(canonicalJson));
  const allowed = new Set(allowedEffects.map((effect) => canonicalJson(effect.operation)));
  delta.operations.forEach((operation, index) => {
    if (!allowed.has(canonicalJson(operation))) {
      issues.push(issue("ACTION_EFFECT_NOT_DECLARED", `Operation ${index} is not declared by action schema ${schemaId}`, `proposedDelta.operations.${index}`));
    }
  });
  allowedEffects.forEach((effect, index) => {
    if (effect.required && !actual.has(canonicalJson(effect.operation))) {
      issues.push(issue("ACTION_REQUIRED_EFFECT_MISSING", `Required effect ${index} of action schema ${schemaId} is missing`, "proposedDelta.operations"));
    }
  });
}

function resolveOneEntity(reference: TemplateEntityRef, roles: ReadonlyMap<string, string[]>): string {
  if (reference.kind === "entity") return reference.entityId;
  const values = roles.get(reference.roleId) ?? [];
  if (values.length !== 1) throw new Error(`Template role ${reference.roleId} must bind exactly one entity at this use site`);
  return values[0]!;
}

function resolveTemplateValue(
  value: TemplateValue,
  roles: ReadonlyMap<string, string[]>,
  parameters: Readonly<Record<string, StateValue>>,
): StateValue {
  if (value.source === "literal") return structuredClone(value.value);
  if (value.source === "role") return resolveOneEntity({ kind: "role", roleId: value.roleId }, roles);
  const resolved = parameters[value.parameterId];
  if (resolved === undefined) throw new Error(`Missing template parameter ${value.parameterId}`);
  return structuredClone(resolved);
}

function stateValueMatchesType(value: StateValue, type: ActionParameterSpec["valueType"]): boolean {
  if (type === "boolean") return typeof value === "boolean";
  if (type === "number") return typeof value === "number";
  if (type === "string" || type === "entity-ref") return typeof value === "string";
  if (type === "entity-ref-set") return Array.isArray(value) && value.every((item) => typeof item === "string");
  return typeof value === "boolean" || typeof value === "number" || typeof value === "string" || value === null;
}

function issue(code: string, message: string, path?: string): ValidationIssue {
  return path ? { code, message, path } : { code, message };
}
