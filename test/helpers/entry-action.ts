import type { ActionSchema } from "../../src/world/action-ontology.js";

/** Explicit fixture mechanics. Production never installs an implicit action
 * merely to make an entry probe pass. */
export function selfActionFixture(field = "character.plan", before: string = "Carry a letter", after: string = "Read the letter"): ActionSchema {
  return { ontologyVersion: "action-schema-v1", id: "fixture-self-action", name: "Perform the declared local action", visibility: "public",
    initiatorRoleId: "actor", roles: [{ id: "actor", label: "Actor", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 }], parameters: [],
    preconditions: [
      { op: "fact-equals", entity: { kind: "role", roleId: "actor" }, field: "character.alive", value: { source: "literal", value: true } },
      { op: "fact-equals", entity: { kind: "role", roleId: "actor" }, field, value: { source: "literal", value: before } },
    ],
    stateEffects: [{ op: "set", entity: { kind: "role", roleId: "actor" }, field, value: { source: "literal", value: after }, required: true }],
    effectEnvelope: { maxStateOperations: 1, allowedStateFields: [field], allowsKnowledge: false, allowsTimeAdvance: false, allowsSceneTransition: false },
    induction: { kind: "domain-module", moduleId: "explicit-test-mechanics", moduleVersion: "1" }, evidence: [],
  };
}
