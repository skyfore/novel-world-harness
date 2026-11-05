import { isDeepStrictEqual } from "node:util";
import type { Predicate } from "./model.js";

/** Conservative proof only: unsupported relationships are never assumed true. */
export function predicatesEntail(assumptions: readonly Predicate[], expected: Predicate): boolean {
  const facts = assumptions.flatMap(function flatten(p): Predicate[] { return p.op === "all" ? p.items.flatMap(flatten) : [p]; });
  if (facts.some(p => isDeepStrictEqual(p, expected))) return true;
  if (expected.op === "all") return expected.items.every(p => predicatesEntail(facts, p));
  if (expected.op === "any") return expected.items.some(p => predicatesEntail(facts, p));
  return facts.some(p => {
    if (p.op === "any") return p.items.length > 0 && p.items.every(item => predicatesEntail([item], expected));
    if ("entityId" in expected && "entityId" in p && p.entityId === expected.entityId && p.field === expected.field) {
      if (expected.op === "fact-exists") return ["fact-equals", "fact-gte", "fact-lte", "entity-in"].includes(p.op);
      if (expected.op === "fact-gte" && (p.op === "fact-gte" || p.op === "fact-equals") && typeof p.value === "number") return p.value >= expected.value;
      if (expected.op === "fact-lte" && (p.op === "fact-lte" || p.op === "fact-equals") && typeof p.value === "number") return p.value <= expected.value;
    }
    if (expected.op === "elapsed-days-gte" && p.op === expected.op) return p.days >= expected.days;
    if (expected.op === "elapsed-days-lte" && p.op === expected.op) return p.days <= expected.days;
    if (expected.op === "after-step" && p.op === expected.op) return p.step >= expected.step;
    if (expected.op === "before-step" && p.op === expected.op) return p.step <= expected.step;
    return false;
  });
}
