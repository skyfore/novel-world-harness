import { actionSchemaSchema } from "../../src/world/action-ontology.js";
import type { ActionInvocation } from "../../src/world/model.js";

export const giftSchema = actionSchemaSchema.parse({
  ontologyVersion: "action-schema-v1", id: "gift-item", name: "Give an owned item", initiatorRoleId: "giver",
  roles: [
    { id: "giver", label: "Giver", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 },
    { id: "recipient", label: "Recipient", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 },
    { id: "item", label: "Item", allowedEntityKinds: ["artifact"], minCardinality: 1, maxCardinality: 1 },
  ], parameters: [],
  preconditions: [{ op: "fact-equals", entity: { kind: "role", roleId: "item" }, field: "artifact.owner", value: { source: "role", roleId: "giver" } }],
  stateEffects: [{ op: "set", entity: { kind: "role", roleId: "item" }, field: "artifact.owner", value: { source: "role", roleId: "recipient" } }],
  effectEnvelope: { maxStateOperations: 1, allowedStateFields: ["artifact.owner"], allowsKnowledge: false, allowsTimeAdvance: false, allowsSceneTransition: false },
  induction: { kind: "domain-module", moduleId: "test-possession", moduleVersion: "1" }, evidence: [],
});

export const giftSilverKey: ActionInvocation = { lane: "schema-bound", schemaId: giftSchema.id, parameters: {},
  roleBindings: [{ roleId: "giver", entityIds: ["hero"] }, { roleId: "recipient", entityIds: ["mo-yan"] }, { roleId: "item", entityIds: ["silver-key"] }] };
