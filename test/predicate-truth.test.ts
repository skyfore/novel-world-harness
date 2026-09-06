import { expect, it } from "vitest";
import { DEFAULT_STATE_FIELDS, emptyWorldState, evaluatePredicate, evaluatePredicateTruth, StateSchemaRegistry } from "../src/world/state.js";
import type { Predicate } from "../src/world/model.js";

const alive: Predicate = { op: "fact-equals", entityId: "hero", field: "character.alive", value: true };
it("never turns an unknown fact or unknown story time into permission by negation", () => {
  const state = emptyWorldState("head");
  expect(evaluatePredicateTruth(state, alive)).toBe("unknown");
  expect(evaluatePredicate(state, { op: "not", item: alive })).toBe(false);
  expect(evaluatePredicateTruth(state, { op: "not", item: { op: "story-time-before", time: { kind: "exact", value: "2020-01-01" } } })).toBe("unknown");
  expect(evaluatePredicateTruth(state, { op: "any", items: [alive, { op: "after-step", step: 0 }] })).toBe("unknown");
  state.values.hero = { "character.alive": false };
  expect(evaluatePredicate(state, { op: "not", item: alive })).toBe(true);
});

it("uses absence only for a field whose domain explicitly declares a closed-world assumption", () => {
  const state = emptyWorldState("head");
  const registry = new StateSchemaRegistry(DEFAULT_STATE_FIELDS.map((spec) => spec.key === "character.alive" ? { ...spec, worldAssumption: "closed" } : spec));
  expect(evaluatePredicateTruth(state, alive, registry)).toBe("false");
  expect(evaluatePredicate(state, { op: "not", item: alive }, registry)).toBe(true);
  expect(evaluatePredicate(state, { op: "not", item: alive })).toBe(false);
});
