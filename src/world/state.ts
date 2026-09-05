import type {
  Entity,
  EntityId,
  Predicate,
  StateDelta,
  StateFieldSpec,
  StateOperation,
  StateValue,
  WorldState,
  WorldRule,
} from "./model.js";
import { compareStoryTime } from "./time.js";
import { RELATIONSHIP_TYPE_IDS } from "./relationship-ontology.js";

export class StateSchemaRegistry {
  private readonly specs = new Map<string, StateFieldSpec>();

  constructor(specs: StateFieldSpec[]) {
    for (const input of specs) {
      const legacyVisibility = input.visibility ?? legacyDefaultVisibility(input.key);
      const spec = legacyVisibility ? { ...input, visibility: legacyVisibility } : input;
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
    if (operation.op === "adjust-number") {
      if (spec.cardinality !== "one" || spec.valueType !== "number") {
        throw new Error(`adjust-number requires a single numeric field: ${operation.field}`);
      }
    }
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
        if (spec.minimum !== undefined && value < spec.minimum) throw new Error(`${spec.key} must be >= ${spec.minimum}`);
        if (spec.maximum !== undefined && value > spec.maximum) throw new Error(`${spec.key} must be <= ${spec.maximum}`);
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
    if (spec.allowedValues && !spec.allowedValues.some((allowed) => Object.is(allowed, value))) {
      throw new Error(`${spec.key} must be one of: ${spec.allowedValues.map(String).join(", ")}`);
    }
    if (spec.cardinality === "many" && !Array.isArray(value)) {
      throw new Error(`Expected many-valued state for ${spec.key}`);
    }
    if (spec.cardinality === "one" && Array.isArray(value)) {
      throw new Error(`Expected single-valued state for ${spec.key}`);
    }
  }
}

/** In-memory compatibility migration for snapshots captured before visibility v1. */
function legacyDefaultVisibility(key: string): StateFieldSpec["visibility"] {
  if ([
    "character.experience", "character.momentum", "relationship.strength",
    "institution.resources", "faction.resources",
  ].includes(key)) return "engine";
  if ([
    "character.reputation", "location.controller", "institution.leader",
    "institution.members", "faction.leader", "faction.members",
  ].includes(key)) return "knowledge";
  if ([
    "artifact.custodian", "artifact.quantity", "artifact.condition", "artifact.delivered",
    "relationship.from", "relationship.to", "relationship.type", "relationship.kind", "relationship.active",
    "relationship.obligations",
  ].includes(key)) return "owner";
  if ([
    "character.alive", "character.title", "artifact.owner", "location.open",
    "location.condition", "institution.active", "institution.status", "faction.active",
  ].includes(key)) return "public";
  if ([
    "character.ageYears", "character.lifeStage", "character.health", "character.wealth",
    "character.location", "character.faction", "character.plan", "character.relationships",
    "character.obligations", "character.inventory",
  ].includes(key)) return "self";
  return undefined;
}

export const DEFAULT_STATE_FIELDS: StateFieldSpec[] = [
  { key: "character.alive", appliesTo: ["character"], valueType: "boolean", cardinality: "one", visibility: "public" },
  { key: "character.ageYears", appliesTo: ["character"], valueType: "number", cardinality: "one", visibility: "self", minimum: 0 },
  { key: "character.lifeStage", appliesTo: ["character"], valueType: "string", cardinality: "one", visibility: "self" },
  { key: "character.health", appliesTo: ["character"], valueType: "number", cardinality: "one", visibility: "self", minimum: 0, maximum: 1 },
  { key: "character.experience", appliesTo: ["character"], valueType: "number", cardinality: "one", visibility: "engine", minimum: 0 },
  { key: "character.reputation", appliesTo: ["character"], valueType: "number", cardinality: "one", visibility: "knowledge", minimum: -1, maximum: 1 },
  { key: "character.wealth", appliesTo: ["character"], valueType: "number", cardinality: "one", visibility: "self" },
  { key: "character.location", appliesTo: ["character"], valueType: "entity-ref", cardinality: "one", visibility: "self" },
  { key: "character.faction", appliesTo: ["character"], valueType: "entity-ref", cardinality: "one", visibility: "self" },
  { key: "character.title", appliesTo: ["character"], valueType: "string", cardinality: "one", visibility: "public" },
  { key: "character.plan", appliesTo: ["character"], valueType: "string", cardinality: "one", visibility: "self" },
  { key: "character.momentum", appliesTo: ["character"], valueType: "number", cardinality: "one", visibility: "engine" },
  { key: "character.relationships", appliesTo: ["character"], valueType: "entity-ref-set", cardinality: "many", visibility: "self" },
  { key: "character.obligations", appliesTo: ["character"], valueType: "entity-ref-set", cardinality: "many", visibility: "self" },
  { key: "character.inventory", appliesTo: ["character"], valueType: "entity-ref-set", cardinality: "many", visibility: "self" },
  { key: "artifact.owner", appliesTo: ["artifact"], valueType: "entity-ref", cardinality: "one", visibility: "public", exclusive: true },
  { key: "artifact.custodian", appliesTo: ["artifact"], valueType: "entity-ref", cardinality: "one", visibility: "owner", exclusive: true },
  { key: "artifact.quantity", appliesTo: ["artifact"], valueType: "number", cardinality: "one", visibility: "owner", minimum: 0 },
  { key: "artifact.condition", appliesTo: ["artifact"], valueType: "number", cardinality: "one", visibility: "owner", minimum: 0, maximum: 1 },
  { key: "artifact.delivered", appliesTo: ["artifact"], valueType: "boolean", cardinality: "one", visibility: "owner" },
  { key: "location.open", appliesTo: ["location"], valueType: "boolean", cardinality: "one", visibility: "public" },
  { key: "location.condition", appliesTo: ["location"], valueType: "number", cardinality: "one", visibility: "public", minimum: 0, maximum: 1 },
  { key: "location.controller", appliesTo: ["location"], valueType: "entity-ref", cardinality: "one", visibility: "knowledge", exclusive: true },
  { key: "institution.active", appliesTo: ["institution"], valueType: "boolean", cardinality: "one", visibility: "public" },
  { key: "institution.status", appliesTo: ["institution"], valueType: "string", cardinality: "one", visibility: "public" },
  { key: "institution.leader", appliesTo: ["institution"], valueType: "entity-ref", cardinality: "one", visibility: "knowledge", exclusive: true },
  { key: "institution.members", appliesTo: ["institution"], valueType: "entity-ref-set", cardinality: "many", visibility: "knowledge" },
  { key: "institution.resources", appliesTo: ["institution"], valueType: "number", cardinality: "one", visibility: "engine" },
  { key: "faction.active", appliesTo: ["faction"], valueType: "boolean", cardinality: "one", visibility: "public" },
  { key: "faction.leader", appliesTo: ["faction"], valueType: "entity-ref", cardinality: "one", visibility: "knowledge", exclusive: true },
  { key: "faction.members", appliesTo: ["faction"], valueType: "entity-ref-set", cardinality: "many", visibility: "knowledge" },
  { key: "faction.resources", appliesTo: ["faction"], valueType: "number", cardinality: "one", visibility: "engine" },
  { key: "relationship.from", appliesTo: ["relationship"], valueType: "entity-ref", cardinality: "one", visibility: "owner", required: true },
  { key: "relationship.to", appliesTo: ["relationship"], valueType: "entity-ref", cardinality: "one", visibility: "owner", required: true },
  {
    key: "relationship.type",
    appliesTo: ["relationship"],
    valueType: "string",
    cardinality: "one",
    visibility: "owner",
    allowedValues: [...RELATIONSHIP_TYPE_IDS],
  },
  /** @deprecated Free-form compatibility field. New compilation uses relationship.type. */
  { key: "relationship.kind", appliesTo: ["relationship"], valueType: "string", cardinality: "one", visibility: "owner" },
  /** @deprecated One scalar cannot represent multidimensional directed stance. */
  { key: "relationship.strength", appliesTo: ["relationship"], valueType: "number", cardinality: "one", visibility: "engine", minimum: -1, maximum: 1 },
  { key: "relationship.active", appliesTo: ["relationship"], valueType: "boolean", cardinality: "one", visibility: "owner" },
  /** @deprecated Untyped entity references are retained for snapshot compatibility. */
  { key: "relationship.obligations", appliesTo: ["relationship"], valueType: "entity-ref-set", cardinality: "many", visibility: "owner" },
];

export type ResourceAccount = { entityId: EntityId; field: string };
export type ResourceConservationPolicy = {
  id: string;
  accounts: readonly ResourceAccount[];
  mode: "conserved" | "non-increasing";
  tolerance?: number;
};

/**
 * Deterministic hook for closed or depleting resource systems. Production is
 * represented by a separate policy/process, never smuggled in as an arbitrary
 * state write.
 */
export function validateResourceConservation(
  before: WorldState,
  after: WorldState,
  policies: readonly ResourceConservationPolicy[],
): string[] {
  const issues: string[] = [];
  for (const policy of policies) {
    if (!policy.accounts.length) {
      issues.push(`Resource policy ${policy.id} has no accounts`);
      continue;
    }
    const keys = policy.accounts.map((account) => `${account.entityId}\u0000${account.field}`);
    if (new Set(keys).size !== keys.length) {
      issues.push(`Resource policy ${policy.id} repeats an account`);
      continue;
    }
    const readTotal = (state: WorldState): number | undefined => {
      let total = 0;
      for (const account of policy.accounts) {
        const value = state.values[account.entityId]?.[account.field];
        if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
        total += value;
      }
      return total;
    };
    const beforeTotal = readTotal(before);
    const afterTotal = readTotal(after);
    if (beforeTotal === undefined || afterTotal === undefined) {
      issues.push(`Resource policy ${policy.id} requires every account to have a finite numeric value`);
      continue;
    }
    const tolerance = policy.tolerance ?? 1e-9;
    if (!Number.isFinite(tolerance) || tolerance < 0) {
      issues.push(`Resource policy ${policy.id} has invalid tolerance ${String(tolerance)}`);
      continue;
    }
    const delta = afterTotal - beforeTotal;
    if (policy.mode === "conserved" && Math.abs(delta) > tolerance) {
      issues.push(`Resource policy ${policy.id} requires total ${beforeTotal} to remain conserved; proposed total is ${afterTotal}`);
    }
    if (policy.mode === "non-increasing" && delta > tolerance) {
      issues.push(`Resource policy ${policy.id} forbids unmodeled production; total rises from ${beforeTotal} to ${afterTotal}`);
    }
  }
  return issues;
}

export function validateResourcePolicyCatalog(
  policies: readonly ResourceConservationPolicy[],
  registry: StateSchemaRegistry,
  entities: ReadonlyMap<EntityId, Entity>,
): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const policy of policies) {
    if (ids.has(policy.id)) issues.push(`Duplicate resource policy ${policy.id}`);
    ids.add(policy.id);
    for (const account of policy.accounts) {
      const entity = entities.get(account.entityId);
      if (!entity) {
        issues.push(`Resource policy ${policy.id} references unknown entity ${account.entityId}`);
        continue;
      }
      try {
        const field = registry.get(account.field);
        if (field.valueType !== "number" || field.cardinality !== "one") {
          issues.push(`Resource policy ${policy.id} account ${account.entityId}.${account.field} must be a single numeric field`);
        }
        if (!field.appliesTo.includes(entity.kind)) {
          issues.push(`Resource policy ${policy.id} field ${account.field} does not apply to ${entity.kind}`);
        }
      } catch (error) {
        issues.push(`Resource policy ${policy.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return issues;
}

export function emptyWorldState(atCommit: string, step = 0): WorldState {
  return { atCommit, logicalTime: { step }, values: {}, activeRuleIds: [] };
}

export type PredicateTruth = "true" | "false" | "unknown";

/** Negation preserves missing information; only declared closed-world fields imply absence. */
export function evaluatePredicateTruth(state: WorldState, predicate: Predicate, registry?: StateSchemaRegistry): PredicateTruth {
  const truth = (value: boolean): PredicateTruth => value ? "true" : "false";
  const fields = "entityId" in predicate ? state.values[predicate.entityId] : undefined;
  if ("entityId" in predicate && "field" in predicate && (!fields || !Object.hasOwn(fields, predicate.field) || fields[predicate.field] === null)) {
    const spec = registry?.list().find((field) => field.key === predicate.field)
      ?? DEFAULT_STATE_FIELDS.find((field) => field.key === predicate.field);
    return spec?.worldAssumption === "closed" ? "false" : "unknown";
  }
  switch (predicate.op) {
    case "fact-equals": return truth(deepEqual(fields?.[predicate.field], predicate.value));
    case "fact-gte":
    case "fact-lte": {
      const value = fields?.[predicate.field];
      return typeof value === "number" ? truth(predicate.op === "fact-gte" ? value >= predicate.value : value <= predicate.value) : "unknown";
    }
    case "fact-exists": return "true";
    case "entity-in": {
      const value = fields?.[predicate.field];
      return Array.isArray(value) ? truth(value.includes(predicate.member)) : "unknown";
    }
    // These inventories are complete committed engine projections, hence closed-world.
    case "rule-active": return truth(state.activeRuleIds.includes(predicate.ruleId));
    case "after-step": return truth(state.logicalTime.step > predicate.step);
    case "before-step": return truth(state.logicalTime.step < predicate.step);
    case "elapsed-days-gte": return truth((state.logicalTime.elapsedDays ?? 0) >= predicate.days);
    case "elapsed-days-lte": return truth((state.logicalTime.elapsedDays ?? 0) <= predicate.days);
    case "story-time-at-or-after":
    case "story-time-before": {
      const order = compareStoryTime(state.logicalTime.storyTime, predicate.time);
      return order === undefined ? "unknown" : truth(predicate.op === "story-time-before" ? order === -1 : order >= 0);
    }
    case "all": {
      const items = predicate.items.map((item) => evaluatePredicateTruth(state, item, registry));
      return items.includes("false") ? "false" : items.includes("unknown") ? "unknown" : "true";
    }
    case "any": {
      const items = predicate.items.map((item) => evaluatePredicateTruth(state, item, registry));
      return items.includes("true") ? "true" : items.includes("unknown") ? "unknown" : "false";
    }
    case "not": {
      const item = evaluatePredicateTruth(state, predicate.item, registry);
      return item === "unknown" ? item : item === "true" ? "false" : "true";
    }
  }
}

export function evaluatePredicate(state: WorldState, predicate: Predicate, registry?: StateSchemaRegistry): boolean {
  return evaluatePredicateTruth(state, predicate, registry) === "true";
}

export function applyStateDelta(
  input: WorldState,
  delta: StateDelta,
  registry: StateSchemaRegistry,
  entities: ReadonlyMap<EntityId, Entity>,
  worldRules: ReadonlyMap<string, WorldRule>,
): WorldState {
  const values: WorldState["values"] = {};
  for (const [entityId, fields] of Object.entries(input.values)) values[entityId] = cloneFields(fields);
  const activeRules = new Set(input.activeRuleIds);

  for (const operation of delta.operations) {
    registry.validateOperation(operation, entities);
    if (operation.op === "activate-rule") {
      if (!worldRules.has(operation.ruleId)) throw new Error(`Unknown world rule: ${operation.ruleId}`);
      activeRules.add(operation.ruleId);
      continue;
    }
    if (operation.op === "deactivate-rule") {
      if (!worldRules.has(operation.ruleId)) throw new Error(`Unknown world rule: ${operation.ruleId}`);
      activeRules.delete(operation.ruleId);
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
      case "adjust-number": {
        const existing = current[operation.field];
        if (typeof existing !== "number" || !Number.isFinite(existing)) {
          throw new Error(`Cannot adjust unknown or non-numeric state field: ${operation.entityId}.${operation.field}`);
        }
        const next = existing + operation.amount;
        registry.validateValue(registry.get(operation.field), next, entities);
        current[operation.field] = next;
        break;
      }
    }
  }

  return { ...input, values, activeRuleIds: [...activeRules].sort() };
}

/**
 * Apply deterministic continuous effects before an event's predicates and
 * delta are evaluated. Only explicit, already-known state is advanced; the
 * engine never invents an age or health value from prose.
 */
export function advanceTemporalState(
  input: WorldState,
  logicalTime: WorldState["logicalTime"],
  registry: StateSchemaRegistry,
  entities: ReadonlyMap<EntityId, Entity>,
): WorldState {
  const elapsed = (logicalTime.elapsedDays ?? 0) - (input.logicalTime.elapsedDays ?? 0);
  if (elapsed < 0) throw new Error("Elapsed world time cannot move backwards");
  const values: WorldState["values"] = {};
  for (const [entityId, fields] of Object.entries(input.values)) values[entityId] = cloneFields(fields);
  if (elapsed > 0) {
    for (const [entityId, entity] of entities) {
      if (entity.kind !== "character" || values[entityId]?.["character.alive"] === false) continue;
      const age = values[entityId]?.["character.ageYears"];
      if (typeof age !== "number") continue;
      const nextAge = age + elapsed / 365.2425;
      registry.validateValue(registry.get("character.ageYears"), nextAge, entities);
      values[entityId]!["character.ageYears"] = nextAge;
    }
  }
  return { ...input, logicalTime, values };
}

export function validateEngineInvariants(
  state: WorldState,
  registry: StateSchemaRegistry,
  entities: ReadonlyMap<EntityId, Entity>,
  rules?: ReadonlyMap<string, WorldRule>,
): string[] {
  const errors: string[] = [];
  if (rules) {
    for (const ruleId of state.activeRuleIds) {
      if (!rules.has(ruleId)) errors.push(`active state references unknown rule ${ruleId}`);
    }
  }
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
    for (const spec of registry.list()) {
      if (!spec.required || !spec.appliesTo.includes(entity.kind)) continue;
      if (!Object.prototype.hasOwnProperty.call(fields, spec.key) || fields[spec.key] === null) {
        errors.push(`${entityId}.${spec.key}: required state field is missing`);
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
