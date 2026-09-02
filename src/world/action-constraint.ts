import { z } from "zod";
import {
  actionInvocationSchema,
  evidenceRefSchema,
  idSchema,
  stateValueSchema,
  type ActionInvocation,
  type Entity,
  type EvidenceRef,
  type StateValue,
  type ValidationIssue,
  type WorldState,
} from "./model.js";
import { evaluatePredicate } from "./state.js";
import type { ActionSchema } from "./action-ontology.js";

export const ACTION_CONSTRAINT_ONTOLOGY_VERSION = "action-constraint-v1" as const;

export const actionPatternSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("any") }).strict(),
  z.object({ kind: z.literal("schema"), schemaId: idSchema }).strict(),
  z.object({ kind: z.literal("ad-hoc"), actionKindId: idSchema }).strict(),
]);
export type ActionPattern = z.infer<typeof actionPatternSchema>;

export const constraintEntityRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("actor") }).strict(),
  z.object({ kind: z.literal("role"), roleId: idSchema }).strict(),
  z.object({ kind: z.literal("entity"), entityId: idSchema }).strict(),
]);
export type ConstraintEntityRef = z.infer<typeof constraintEntityRefSchema>;

export type ConstraintPredicate =
  | { op: "fact-equals"; entity: ConstraintEntityRef; field: string; value: StateValue }
  | { op: "fact-gte"; entity: ConstraintEntityRef; field: string; value: number }
  | { op: "fact-lte"; entity: ConstraintEntityRef; field: string; value: number }
  | { op: "fact-exists"; entity: ConstraintEntityRef; field: string }
  | { op: "all"; items: ConstraintPredicate[] }
  | { op: "any"; items: ConstraintPredicate[] }
  | { op: "not"; item: ConstraintPredicate };

export const constraintPredicateSchema: z.ZodType<ConstraintPredicate> = z.lazy(() => z.discriminatedUnion("op", [
  z.object({ op: z.literal("fact-equals"), entity: constraintEntityRefSchema, field: z.string().min(1), value: stateValueSchema }).strict(),
  z.object({ op: z.literal("fact-gte"), entity: constraintEntityRefSchema, field: z.string().min(1), value: z.number().finite() }).strict(),
  z.object({ op: z.literal("fact-lte"), entity: constraintEntityRefSchema, field: z.string().min(1), value: z.number().finite() }).strict(),
  z.object({ op: z.literal("fact-exists"), entity: constraintEntityRefSchema, field: z.string().min(1) }).strict(),
  z.object({ op: z.literal("all"), items: z.array(constraintPredicateSchema).max(64) }).strict(),
  z.object({ op: z.literal("any"), items: z.array(constraintPredicateSchema).max(64) }).strict(),
  z.object({ op: z.literal("not"), item: constraintPredicateSchema }).strict(),
]));

export const actionConstraintClauseSchema = z.object({
  id: idSchema,
  timing: z.enum(["before", "after"]),
  modality: z.enum(["require", "forbid"]),
  predicate: constraintPredicateSchema,
}).strict();
export type ActionConstraintClause = z.infer<typeof actionConstraintClauseSchema>;

export const actionConstraintExceptionSchema = z.object({
  id: idSchema,
  appliesWhen: z.array(constraintPredicateSchema).min(1).max(32),
}).strict();
export type ActionConstraintException = z.infer<typeof actionConstraintExceptionSchema>;

export const actionConstraintSchema = z.object({
  ontologyVersion: z.literal(ACTION_CONSTRAINT_ONTOLOGY_VERSION),
  id: idSchema,
  name: z.string().trim().min(1).max(400),
  actionPattern: actionPatternSchema,
  appliesWhen: z.array(constraintPredicateSchema).max(32).default([]),
  clauses: z.array(actionConstraintClauseSchema).min(1).max(64),
  exceptions: z.array(actionConstraintExceptionSchema).max(32).default([]),
  priority: z.number().int().min(0).max(10_000),
  defeasible: z.boolean(),
  overridesConstraintIds: z.array(idSchema).max(64).default([]),
  status: z.enum(["supported", "contested"]),
  visibility: z.enum(["public", "observable", "knowledge", "engine"]),
  induction: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("source-pattern"), supportingEventIds: z.array(idSchema).min(1).max(64) }).strict(),
    z.object({ kind: z.literal("domain-module"), moduleId: idSchema, moduleVersion: z.string().trim().min(1).max(120) }).strict(),
  ]),
  evidence: z.array(evidenceRefSchema),
}).strict().superRefine((value, ctx) => {
  for (const [path, ids] of [
    ["clauses", value.clauses.map((item) => item.id)],
    ["exceptions", value.exceptions.map((item) => item.id)],
    ["overridesConstraintIds", value.overridesConstraintIds],
  ] as const) {
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: [path], message: `${path} identifiers must be unique` });
  }
  if (value.overridesConstraintIds.includes(value.id)) {
    ctx.addIssue({ code: "custom", path: ["overridesConstraintIds"], message: "An action constraint cannot override itself" });
  }
  if (value.induction.kind === "source-pattern" && !value.evidence.length) {
    ctx.addIssue({ code: "custom", path: ["evidence"], message: "A source-induced action constraint requires source evidence" });
  }
  if (value.induction.kind === "domain-module" && value.evidence.length) {
    ctx.addIssue({ code: "custom", path: ["evidence"], message: "Domain constraints use module provenance, not novel EvidenceRefs" });
  }
});
export type ActionConstraint = z.infer<typeof actionConstraintSchema>;

export type ActionConstraintResolution = {
  effective: ActionConstraint[];
  inactive: Array<{
    constraintId: string;
    reason: "contested" | "action-mismatch" | "not-applicable" | "exception" | "overridden";
    exceptionId?: string;
    overridingConstraintId?: string;
  }>;
  issues: ValidationIssue[];
};

export function validateActionConstraintCatalog(
  constraintsInput: Iterable<ActionConstraint>,
  input: {
    entities: ReadonlyMap<string, Entity>;
    actionSchemas: ReadonlyMap<string, ActionSchema>;
  },
): ValidationIssue[] {
  const constraints = [...constraintsInput].map((item) => actionConstraintSchema.parse(item));
  const byId = new Map(constraints.map((item) => [item.id, item]));
  const issues: ValidationIssue[] = [];
  if (byId.size !== constraints.length) issues.push(issue("DUPLICATE_ACTION_CONSTRAINT", "Action constraint IDs must be unique", "actionConstraints"));
  for (const [index, constraint] of constraints.entries()) {
    if (constraint.actionPattern.kind === "schema" && !input.actionSchemas.has(constraint.actionPattern.schemaId)) {
      issues.push(issue("UNKNOWN_CONSTRAINT_ACTION_SCHEMA", `Constraint ${constraint.id} references unknown action schema ${constraint.actionPattern.schemaId}`, `actionConstraints.${index}.actionPattern.schemaId`));
    }
    const roleIds = constraint.actionPattern.kind === "schema"
      ? new Set(input.actionSchemas.get(constraint.actionPattern.schemaId)?.roles.map((role) => role.id) ?? [])
      : new Set<string>();
    const inspect = (predicate: ConstraintPredicate, path: string): void => {
      if (predicate.op === "all" || predicate.op === "any") return predicate.items.forEach((item, itemIndex) => inspect(item, `${path}.items.${itemIndex}`));
      if (predicate.op === "not") return inspect(predicate.item, `${path}.item`);
      if (predicate.entity.kind === "entity" && !input.entities.has(predicate.entity.entityId)) {
        issues.push(issue("UNKNOWN_CONSTRAINT_ENTITY", `Constraint ${constraint.id} references unknown entity ${predicate.entity.entityId}`, `${path}.entity.entityId`));
      }
      if (predicate.entity.kind === "role" && !roleIds.has(predicate.entity.roleId)) {
        issues.push(issue("UNKNOWN_CONSTRAINT_ROLE", `Constraint ${constraint.id} references unavailable role ${predicate.entity.roleId}`, `${path}.entity.roleId`));
      }
    };
    constraint.appliesWhen.forEach((item, itemIndex) => inspect(item, `actionConstraints.${index}.appliesWhen.${itemIndex}`));
    constraint.clauses.forEach((item, itemIndex) => inspect(item.predicate, `actionConstraints.${index}.clauses.${itemIndex}.predicate`));
    constraint.exceptions.forEach((exception, exceptionIndex) => exception.appliesWhen.forEach((item, itemIndex) =>
      inspect(item, `actionConstraints.${index}.exceptions.${exceptionIndex}.appliesWhen.${itemIndex}`)));
    constraint.overridesConstraintIds.forEach((targetId, targetIndex) => {
      const target = byId.get(targetId);
      const path = `actionConstraints.${index}.overridesConstraintIds.${targetIndex}`;
      if (!target) issues.push(issue("UNKNOWN_OVERRIDDEN_CONSTRAINT", `Constraint ${constraint.id} overrides unknown constraint ${targetId}`, path));
      else if (!target.defeasible) issues.push(issue("INDEFEASIBLE_CONSTRAINT_OVERRIDE", `Constraint ${targetId} is not defeasible`, path));
      else if (constraint.priority <= target.priority) issues.push(issue("INVALID_CONSTRAINT_PRIORITY", `Overriding constraint ${constraint.id} must have higher priority than ${targetId}`, path));
    });
  }
  for (const cycle of overrideCycles(new Map(constraints.map((item) => [item.id, new Set(item.overridesConstraintIds)])))) {
    issues.push(issue("ACTION_CONSTRAINT_OVERRIDE_CYCLE", `Action constraint override cycle: ${cycle.join(" -> ")}`, "actionConstraints"));
  }
  return issues;
}

export function resolveActionConstraints(
  constraintsInput: Iterable<ActionConstraint>,
  input: {
    invocation?: ActionInvocation;
    actorId?: string;
    before: WorldState;
    after: WorldState;
  },
): ActionConstraintResolution {
  const invocation = input.invocation ? actionInvocationSchema.parse(input.invocation) : undefined;
  const inactive: ActionConstraintResolution["inactive"] = [];
  const candidates: ActionConstraint[] = [];
  const issues: ValidationIssue[] = [];
  for (const constraint of [...constraintsInput].sort((left, right) => left.id.localeCompare(right.id))) {
    if (constraint.status === "contested") {
      inactive.push({ constraintId: constraint.id, reason: "contested" });
      continue;
    }
    if (!invocation || !actionPatternMatches(constraint.actionPattern, invocation)) {
      inactive.push({ constraintId: constraint.id, reason: "action-mismatch" });
      continue;
    }
    const binding = constraintBinding(invocation, input.actorId);
    try {
      if (!constraint.appliesWhen.every((predicate) => evaluateConstraintPredicate(input.before, predicate, binding))) {
        inactive.push({ constraintId: constraint.id, reason: "not-applicable" });
        continue;
      }
      const exception = constraint.exceptions.find((candidate) =>
        candidate.appliesWhen.every((predicate) => evaluateConstraintPredicate(input.before, predicate, binding)));
      if (exception) {
        inactive.push({ constraintId: constraint.id, reason: "exception", exceptionId: exception.id });
        continue;
      }
    } catch (error) {
      issues.push(issue("ACTION_CONSTRAINT_BINDING_FAILED", messageOf(error), `actionConstraints.${constraint.id}`));
      continue;
    }
    candidates.push(constraint);
  }
  candidates.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  const effective: ActionConstraint[] = [];
  for (const candidate of candidates) {
    const overriding = effective.find((item) => item.overridesConstraintIds.includes(candidate.id));
    if (overriding) {
      inactive.push({ constraintId: candidate.id, reason: "overridden", overridingConstraintId: overriding.id });
    } else {
      effective.push(candidate);
    }
  }
  for (const constraint of effective) {
    const binding = constraintBinding(invocation!, input.actorId);
    for (const clause of constraint.clauses) {
      try {
        const state = clause.timing === "before" ? input.before : input.after;
        const matched = evaluateConstraintPredicate(state, clause.predicate, binding);
        if (clause.modality === "require" && !matched) {
          issues.push(issue("ACTION_CONSTRAINT_REQUIREMENT_FAILED", `Action constraint ${constraint.id} requirement ${clause.id} is not satisfied`, `actionConstraints.${constraint.id}.clauses.${clause.id}`));
        }
        if (clause.modality === "forbid" && matched) {
          issues.push(issue("ACTION_CONSTRAINT_FORBIDS", `Action constraint ${constraint.id} forbids the action`, `actionConstraints.${constraint.id}.clauses.${clause.id}`));
        }
      } catch (error) {
        issues.push(issue("ACTION_CONSTRAINT_BINDING_FAILED", messageOf(error), `actionConstraints.${constraint.id}.clauses.${clause.id}`));
      }
    }
  }
  return {
    effective: effective.sort((left, right) => left.id.localeCompare(right.id)),
    inactive: inactive.sort((left, right) => left.constraintId.localeCompare(right.constraintId)),
    issues,
  };
}

export function actionPatternMatches(pattern: ActionPattern, invocation: ActionInvocation): boolean {
  if (pattern.kind === "any") return true;
  if (pattern.kind === "schema") return invocation.lane === "schema-bound" && invocation.schemaId === pattern.schemaId;
  return invocation.lane === "ad-hoc" && invocation.actionKindId === pattern.actionKindId;
}

type ConstraintBinding = { actorId?: string; roles: ReadonlyMap<string, readonly string[]> };

function constraintBinding(invocation: ActionInvocation, actorId?: string): ConstraintBinding {
  return {
    ...(actorId ? { actorId } : {}),
    roles: invocation.lane === "schema-bound"
      ? new Map(invocation.roleBindings.map((binding) => [binding.roleId, binding.entityIds]))
      : new Map(),
  };
}

function evaluateConstraintPredicate(
  state: WorldState,
  predicate: ConstraintPredicate,
  binding: ConstraintBinding,
): boolean {
  if (predicate.op === "all") return predicate.items.every((item) => evaluateConstraintPredicate(state, item, binding));
  if (predicate.op === "any") return predicate.items.some((item) => evaluateConstraintPredicate(state, item, binding));
  if (predicate.op === "not") return !evaluateConstraintPredicate(state, predicate.item, binding);
  const entityId = resolveConstraintEntity(predicate.entity, binding);
  const fields = state.values[entityId];
  if (predicate.op === "fact-exists") return fields !== undefined
    && Object.prototype.hasOwnProperty.call(fields, predicate.field)
    && fields[predicate.field] !== null;
  const value = fields?.[predicate.field];
  if (predicate.op === "fact-equals") return JSON.stringify(value) === JSON.stringify(predicate.value);
  if (predicate.op === "fact-gte") return typeof value === "number" && value >= predicate.value;
  return typeof value === "number" && value <= predicate.value;
}

function resolveConstraintEntity(reference: ConstraintEntityRef, binding: ConstraintBinding): string {
  if (reference.kind === "entity") return reference.entityId;
  if (reference.kind === "actor") {
    if (!binding.actorId) throw new Error("Constraint requires an event actor");
    return binding.actorId;
  }
  const values = binding.roles.get(reference.roleId) ?? [];
  if (values.length !== 1) throw new Error(`Constraint role ${reference.roleId} must bind exactly one entity`);
  return values[0]!;
}

function overrideCycles(graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id];
      const key = [...new Set(cycle.slice(0, -1))].sort().join("\u0000");
      if (!seen.has(key)) { seen.add(key); cycles.push(cycle); }
      return;
    }
    visiting.add(id);
    stack.push(id);
    for (const target of [...(graph.get(id) ?? [])].sort()) visit(target);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of [...graph.keys()].sort()) visit(id);
  return cycles;
}

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, ...(path ? { path } : {}) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { EvidenceRef };
