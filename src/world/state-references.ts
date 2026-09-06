import type { Predicate, StateFieldSpec, StateOperation, StateValue } from "./model.js";

export type StateReference = { kind: "entity" | "rule" | "event"; id: string; pointer: string };
type Fields = ReadonlyMap<string, Pick<StateFieldSpec, "valueType">>;

function valueReferences(value: StateValue, field: string, fields: Fields, pointer: string): StateReference[] {
  const type = fields.get(field)?.valueType;
  if (type === "entity-ref" && typeof value === "string") return [{ kind: "entity", id: value, pointer }];
  if (type === "entity-ref-set" && Array.isArray(value)) return value.map((id, index) => ({ kind: "entity", id, pointer: `${pointer}/${index}` }));
  return [];
}

/** Exhaustive typed traversal: a collection member is an identity, ordinary text is not. */
export function stateOperationReferences(operation: StateOperation, fields: Fields, pointer = ""): StateReference[] {
  switch (operation.op) {
    case "activate-rule": case "deactivate-rule": return [{ kind: "rule", id: operation.ruleId, pointer: `${pointer}/ruleId` }];
    case "set": return [{ kind: "entity", id: operation.entityId, pointer: `${pointer}/entityId` }, ...valueReferences(operation.value, operation.field, fields, `${pointer}/value`)];
    case "add-member": case "remove-member": return [
      { kind: "entity", id: operation.entityId, pointer: `${pointer}/entityId` },
      { kind: "entity", id: operation.member, pointer: `${pointer}/member` },
    ];
    case "unset": case "adjust-number": return [{ kind: "entity", id: operation.entityId, pointer: `${pointer}/entityId` }];
    default: return unreachable(operation);
  }
}

export function predicateReferences(predicate: Predicate, fields: Fields, pointer = ""): StateReference[] {
  switch (predicate.op) {
    case "all": case "any": return predicate.items.flatMap((item, index) => predicateReferences(item, fields, `${pointer}/items/${index}`));
    case "not": return predicateReferences(predicate.item, fields, `${pointer}/item`);
    case "fact-equals": return [{ kind: "entity", id: predicate.entityId, pointer: `${pointer}/entityId` }, ...valueReferences(predicate.value, predicate.field, fields, `${pointer}/value`)];
    case "entity-in": return [{ kind: "entity", id: predicate.entityId, pointer: `${pointer}/entityId` }, { kind: "entity", id: predicate.member, pointer: `${pointer}/member` }];
    case "fact-gte": case "fact-lte": case "fact-exists": return [{ kind: "entity", id: predicate.entityId, pointer: `${pointer}/entityId` }];
    case "rule-active": return [{ kind: "rule", id: predicate.ruleId, pointer: `${pointer}/ruleId` }];
    case "story-time-before": case "story-time-at-or-after": return predicate.time.kind === "relative" ? [{ kind: "event", id: predicate.time.anchorEventId, pointer: `${pointer}/time/anchorEventId` }] : [];
    case "after-step": case "before-step": case "elapsed-days-gte": case "elapsed-days-lte": return [];
    default: return unreachable(predicate);
  }
}

function unreachable(value: never): never { throw new Error(`Unhandled state reference: ${JSON.stringify(value)}`); }
