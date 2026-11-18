import { describe, expect, it } from "vitest";
import { BASE_ACTION_SCHEMAS } from "../../src/compiler/pipeline/domain-modules.js";
import { resolveActionInvocation } from "../../src/world/action-ontology.js";
import type { Entity } from "../../src/world/model.js";

const schemas = new Map(BASE_ACTION_SCHEMAS.map((schema) => [schema.id, schema]));
const entity = (id: string, kind: Entity["kind"]): Entity => ({ id, kind, canonicalName: id, aliases: [], evidence: [] });
const entities = new Map([entity("lin", "character"), entity("mo", "character"), entity("gate", "location"), entity("key", "artifact")].map((item) => [item.id, item]));
const none = { hasKnowledge: false, hasTimeAdvance: false, hasSceneTransition: false };
const move = (actorId: string, operations: Array<Record<string, unknown>>, extra: Partial<typeof none> = {}) => resolveActionInvocation(
  { lane: "schema-bound", schemaId: "base-action-move", roleBindings: [{ roleId: "mover", entityIds: ["lin"] }, { roleId: "destination", entityIds: ["gate"] }], parameters: {} },
  schemas, entities, { participants: ["lin", "gate"], actorId, proposedDelta: { version: 1, operations: operations as never }, ...none, ...extra });

describe("base action domain module", () => {
  it("instantiates move within its envelope: mover alive, only the mover's location changes", () => {
    const resolved = move("lin", [{ op: "set", entityId: "lin", field: "character.location", value: "gate" }], { hasSceneTransition: true });
    expect(resolved.issues).toEqual([]);
    expect(resolved.preconditions).toEqual([{ op: "fact-equals", entityId: "lin", field: "character.alive", value: true }]);
    expect(resolved.stateEffects.map((effect) => effect.operation)).toEqual([{ op: "set", entityId: "lin", field: "character.location", value: "gate" }]);
  });

  it("cannot be used to do anything else: another initiator, another field, knowledge, or an effect it does not declare", () => {
    expect(move("mo", [{ op: "set", entityId: "lin", field: "character.location", value: "gate" }]).issues.map((item) => item.code)).toContain("ACTION_INITIATOR_MISMATCH");
    expect(move("lin", [{ op: "set", entityId: "lin", field: "character.alive", value: false }]).issues.map((item) => item.code)).toContain("ACTION_EFFECT_FIELD_FORBIDDEN");
    expect(move("lin", [{ op: "set", entityId: "lin", field: "character.location", value: "gate" }], { hasKnowledge: true }).issues.map((item) => item.code)).toContain("ACTION_KNOWLEDGE_EFFECT_FORBIDDEN");
    expect(move("lin", [{ op: "set", entityId: "mo", field: "character.location", value: "gate" }]).issues.length).toBeGreaterThan(0);
  });

  it("give requires the giver to hold the item and moves custody only to the recipient; take requires an unheld item", () => {
    const give = resolveActionInvocation({ lane: "schema-bound", schemaId: "base-action-give", parameters: {},
      roleBindings: [{ roleId: "giver", entityIds: ["lin"] }, { roleId: "item", entityIds: ["key"] }, { roleId: "recipient", entityIds: ["mo"] }] },
    schemas, entities, { participants: ["lin", "mo", "key"], actorId: "lin", proposedDelta: { version: 1, operations: [{ op: "set", entityId: "key", field: "artifact.custodian", value: "mo" }] }, ...none });
    expect(give.issues).toEqual([]);
    expect(give.preconditions).toEqual([{ op: "fact-equals", entityId: "key", field: "artifact.custodian", value: "lin" }]);
    const take = resolveActionInvocation({ lane: "schema-bound", schemaId: "base-action-take", parameters: {},
      roleBindings: [{ roleId: "taker", entityIds: ["mo"] }, { roleId: "item", entityIds: ["key"] }] },
    schemas, entities, { participants: ["mo", "key"], actorId: "mo", proposedDelta: { version: 1, operations: [{ op: "set", entityId: "key", field: "artifact.custodian", value: "mo" }] }, ...none });
    expect(take.issues).toEqual([]);
    expect(take.preconditions).toEqual([{ op: "not", item: { op: "fact-exists", entityId: "key", field: "artifact.custodian" } }]);
  });
});
