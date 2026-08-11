import type {
  Entity,
  EntityId,
  Predicate,
  StateDelta,
  StateFieldSpec,
  StateOperation,
  StateValue,
  WorldState,
} from "./model.js";

export class StateSchemaRegistry {
  private readonly specs = new Map<string, StateFieldSpec>();

  constructor(specs: StateFieldSpec[]) {
    for (const spec of specs) {
      if (this.specs.has(spec.key)) throw new Error(`Duplicate state field: ${spec.key}`);
      this.specs.set(spec.key, spec);
    }
  }

  get(field: string): StateFieldSpec {
    const spec = this.specs.get(field);
    if (!spec) throw new Error(`Unknown state field: ${field}`);
    return spec;
  }

  list(): StateFieldSpec[] {
    return [...this.specs.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  validateOperation(operation: StateOperation, entities: ReadonlyMap<EntityId, Entity>): void {
    if (operation.op === "activate-rule" || operation.op === "deactivate-rule") return;
    const entity = entities.get(operation.entityId);
    if (!entity) throw new Error(`Unknown entity: ${operation.entityId}`);
    const spec = this.get(operation.field);
    if (!spec.appliesTo.includes(entity.kind)) {
      throw new Error(`State field ${operation.field} does not apply to ${entity.kind}`);
    }
    if (operation.op === "set") this.validateValue(spec, operation.value, entities);
    if (operation.op === "add-member" || operation.op === "remove-member") {
      if (spec.cardinality !== "many" || spec.valueType !== "entity-ref-set") {
        throw new Error(`${operation.op} requires an entity-ref-set field: ${operation.field}`);
      }
      if (!entities.has(operation.member)) throw new Error(`Unknown entity member: ${operation.member}`);
    }
  }

  validateValue(spec: StateFieldSpec, value: StateValue, entities: ReadonlyMap<EntityId, Entity>): void {
    if (value === null) {
      if (spec.required) throw new Error(`Required state field cannot be null: ${spec.key}`);
      return;
    }
    switch (spec.valueType) {
      case "boolean":
        if (typeof value !== "boolean") throw new Error(`Expected boolean for ${spec.key}`);
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Expected finite number for ${spec.key}`);
        break;
      case "string":
      case "json-scalar":
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
          throw new Error(`Expected scalar for ${spec.key}`);
        }
        break;
      case "entity-ref":
        if (typeof value !== "string" || !entities.has(value)) throw new Error(`Expected entity reference for ${spec.key}`);
        break;
      case "entity-ref-set":
        if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !entities.has(id))) {
          throw new Error(`Expected entity reference set for ${spec.key}`);
        }
        break;
    }
    if (spec.cardinality === "many" && !Array.isArray(value)) {
      throw new Error(`Expected many-valued state for ${spec.key}`);
    }
    if (spec.cardinality === "one" && Array.isArray(value)) {
      throw new Error(`Expected single-valued state for ${spec.key}`);
    }
  }
}

export const DEFAULT_STATE_FIELDS: StateFieldSpec[] = [
  { key: "character.alive", appliesTo: ["character"], valueType: "boolean", cardinality: "one" },
  { key: "character.location", appliesTo: ["character"], valueType: "entity-ref", cardinality: "one" },
  { key: "character.faction", appliesTo: ["character"], valueType: "entity-ref", cardinality: "one" },
  { key: "character.title", appliesTo: ["character"], valueType: "string", cardinality: "one" },
  { key: "character.inventory", appliesTo: ["character"], valueType: "entity-ref-set", cardinality: "many" },
  { key: "artifact.owner", appliesTo: ["artifact"], valueType: "entity-ref", cardinality: "one", exclusive: true },
  { key: "faction.leader", appliesTo: ["faction"], valueType: "entity-ref", cardinality: "one", exclusive: true },
];

export function emptyWorldState(atCommit: string, step = 0): WorldState {
  return { atCommit, logicalTime: { step }, values: {}, activeRuleIds: [] };
}

export function evaluatePredicate(state: WorldState, predicate: Predicate): boolean {
  const fields = state.values[predicate.op === "rule-active" || predicate.op === "after-step" || predicate.op === "before-step" || predicate.op === "all" || predicate.op === "any" || predicate.op === "not" ? "" : predicate.entityId];
  switch (predicate.op) {
    case "fact-equals":
      return deepEqual(fields?.[predicate.field], predicate.value);
    case "fact-exists":
      return fields !== undefined && Object.prototype.hasOwnProperty.call(fields, predicate.field) && fields[predicate.field] !== null;
    case "entity-in": {
      const value = fields?.[predicate.field];
      return Array.isArray(value) && value.includes(predicate.member);
    }
    case "rule-active":
      return state.activeRuleIds.includes(predicate.ruleId);
    case "after-step":
      return state.logicalTime.step > predicate.step;
    case "before-step":
      return state.logicalTime.step < predicate.step;
    case "all":
      return predicate.items.every((item) => evaluatePredicate(state, item));
    case "any":
      return predicate.items.some((item) => evaluatePredicate(state, item));
    case "not":
      return !evaluatePredicate(state, predicate.item);
  }
}

export function applyStateDelta(
  input: WorldState,
  delta: StateDelta,
  registry: StateSchemaRegistry,
  entities: ReadonlyMap<EntityId, Entity>,
): WorldState {
  const values: WorldState["values"] = {};
  for (const [entityId, fields] of Object.entries(input.values)) values[entityId] = cloneFields(fields);
  const rules = new Set(input.activeRuleIds);

  for (const operation of delta.operations) {
    registry.validateOperation(operation, entities);
    if (operation.op === "activate-rule") {
      rules.add(operation.ruleId);
      continue;
    }
    if (operation.op === "deactivate-rule") {
      rules.delete(operation.ruleId);
      continue;
    }
    const current = (values[operation.entityId] ??= {});
    switch (operation.op) {
      case "set":
        current[operation.field] = cloneValue(operation.value);
        break;
      case "unset":
        delete current[operation.field];
        break;
      case "add-member": {
        const existing = current[operation.field];
        const next = new Set(Array.isArray(existing) ? existing : []);
        next.add(operation.member);
        current[operation.field] = [...next].sort();
        break;
      }
      case "remove-member": {
        const existing = current[operation.field];
        const next = new Set(Array.isArray(existing) ? existing : []);
        next.delete(operation.member);
        current[operation.field] = [...next].sort();
        break;
      }
    }
  }

  return { ...input, values, activeRuleIds: [...rules].sort() };
}

export function validateEngineInvariants(
  state: WorldState,
  registry: StateSchemaRegistry,
  entities: ReadonlyMap<EntityId, Entity>,
): string[] {
  const errors: string[] = [];
  for (const [entityId, fields] of Object.entries(state.values)) {
    const entity = entities.get(entityId);
    if (!entity) {
      errors.push(`state references unknown entity ${entityId}`);
      continue;
    }
    for (const [field, value] of Object.entries(fields)) {
      try {
        const spec = registry.get(field);
        if (!spec.appliesTo.includes(entity.kind)) throw new Error(`${field} does not apply to ${entity.kind}`);
        registry.validateValue(spec, value, entities);
      } catch (error) {
        errors.push(`${entityId}.${field}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return errors;
}

function cloneFields(fields: Record<string, StateValue>): Record<string, StateValue> {
  const out: Record<string, StateValue> = {};
  for (const [key, value] of Object.entries(fields)) out[key] = cloneValue(value);
  return out;
}

function cloneValue(value: StateValue): StateValue {
  return Array.isArray(value) ? [...value] : value;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  }
  return left === right;
}

