import type { PredicateTemplate } from "./action-ontology.js";
import type { ConstraintPredicate } from "./action-constraint.js";
import type { Predicate, StateValue, ValueType } from "./model.js";
import type { WorldModelContext } from "./engine.js";
import { knownStateFieldKeys } from "./actor-visible.js";

type ContractPredicate = Predicate | PredicateTemplate | ConstraintPredicate;

/** A compound condition is disclosed whole or withheld whole; NOT/OR are never weakened. */
export function actorContractVisibility(input: {
  context: WorldModelContext; actorId: string; visibleEntityIds: ReadonlySet<string>; knownClaimIds: ReadonlySet<string>;
  visibleRuleIds: ReadonlySet<string>; ownedEntityIds: ReadonlySet<string>;
}) {
  const visible = (id: string) => input.visibleEntityIds.has(id);
  const claims = [...(input.context.claims?.values() ?? [])].filter((claim) => input.knownClaimIds.has(claim.id));
  const value = (item: StateValue, field: string) => {
    const type = input.context.stateSchema.get(field).valueType;
    return type === "entity-ref" ? typeof item === "string" && visible(item)
      : type === "entity-ref-set" ? Array.isArray(item) && item.every(visible) : true;
  };
  const predicate = (item: ContractPredicate, selfRoles: ReadonlySet<string> = new Set()): boolean => {
    if (item.op === "all" || item.op === "any") return item.items.every((child) => predicate(child, selfRoles));
    if (item.op === "not") return predicate(item.item, selfRoles);
    if (item.op === "rule-active") return input.visibleRuleIds.has(item.ruleId);
    if (item.op === "story-time-before" || item.op === "story-time-at-or-after") return item.time.kind !== "relative";
    if (!("field" in item)) return true;
    const reference = "entityId" in item ? { kind: "entity" as const, entityId: item.entityId } : item.entity;
    const entityId = reference.kind === "entity" ? reference.entityId
      : reference.kind === "actor" || selfRoles.has(reference.roleId) ? input.actorId : undefined;
    if (reference.kind === "entity" && !visible(reference.entityId)) return false;
    const spec = input.context.stateSchema.get(item.field);
    if (spec.visibility !== "public"
      && !(spec.visibility === "self" && entityId === input.actorId)
      && !(spec.visibility === "owner" && entityId && (entityId === input.actorId || input.ownedEntityIds.has(entityId)))
      && !(spec.visibility === "knowledge" && entityId && knownStateFieldKeys(entityId, claims).has(item.field))) return false;
    if (item.op === "entity-in") return typeof item.member === "string" ? visible(item.member)
      : item.member.kind !== "entity" || visible(item.member.entityId);
    if (item.op !== "fact-equals") return true;
    if (item.value && typeof item.value === "object" && !Array.isArray(item.value) && "source" in item.value) {
      return item.value.source !== "literal" || value(item.value.value, item.field);
    }
    return value(item.value as StateValue, item.field);
  };
  return { predicate, value };
}

/** Map typed identities only; prose and vocabulary IDs are not entity references. */
export function mapActorContract<T>(input: T, entity: (id: string) => string, ref: (id: string) => string, fieldTypes: Record<string, ValueType>): T {
  const mapValue = (value: unknown, type?: ValueType): unknown => type === "entity-ref" && typeof value === "string" ? entity(value)
    : type === "entity-ref-set" && Array.isArray(value) ? value.map((id) => entity(String(id))) : value;
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== "object") return item;
    const input = item as Record<string, unknown>;
    const output = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, visit(value)]));
    for (const key of ["entityId", "authorityEntityId"]) if (typeof input[key] === "string") output[key] = entity(input[key]);
    for (const key of ["schemaId", "ruleId", "anchorEventId"]) if (typeof input[key] === "string") output[key] = ref(input[key]);
    for (const key of ["jurisdictionEntityIds"]) if (Array.isArray(input[key])) output[key] = input[key].map((id) => entity(String(id)));
    for (const key of ["overridesRuleIds", "overridesConstraintIds", "overridesTemplateIds"]) if (Array.isArray(input[key])) output[key] = input[key].map((id) => ref(String(id)));
    if (typeof input.member === "string") output.member = entity(input.member);
    if (typeof input.field === "string" && "value" in input) {
      const value = input.value;
      output.value = value && typeof value === "object" && !Array.isArray(value) && "source" in value
        ? value.source === "literal" && "value" in value ? { ...value, value: mapValue(value.value, fieldTypes[input.field]) } : value
        : mapValue(value, fieldTypes[input.field]);
    }
    return output;
  };
  return visit(input) as T;
}

export function contractReferenceIds(input: unknown): string[] {
  if (Array.isArray(input)) return input.flatMap(contractReferenceIds);
  if (!input || typeof input !== "object") return [];
  return Object.entries(input).flatMap(([key, value]) => {
    if (["schemaId", "ruleId", "anchorEventId"].includes(key) && typeof value === "string") return [value];
    if (["overridesRuleIds", "overridesConstraintIds", "overridesTemplateIds"].includes(key) && Array.isArray(value)) return value as string[];
    return contractReferenceIds(value);
  });
}

export function contractFieldKeys(input: unknown): string[] {
  if (Array.isArray(input)) return input.flatMap(contractFieldKeys);
  if (!input || typeof input !== "object") return [];
  return Object.entries(input).flatMap(([key, value]) => key === "field" && typeof value === "string" ? [value] : contractFieldKeys(value));
}
