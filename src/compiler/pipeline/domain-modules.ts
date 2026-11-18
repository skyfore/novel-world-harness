import { actionSchemaSchema, type ActionSchema } from "../../world/action-ontology.js";
import { canonicalJson } from "../../world/canonical.js";

/**
 * Base actions every novel world has (decision D2): speak, move, observe,
 * give and take. They are host modules, not source facts: no novel evidence,
 * fixed preconditions and effect envelopes, and they never stand in for a
 * capability the source must state (a specific power still needs a
 * source-statement or source-pattern mechanism). Knowledge and presence are
 * still checked by the runtime for every invocation.
 */
export const BASE_ACTION_MODULE = { moduleId: "base-actions", moduleVersion: "1" } as const;

const character = (id: string, label: string, min = 1, max = 1) => ({ id, label, allowedEntityKinds: ["character" as const], minCardinality: min, maxCardinality: max });
const induction = { kind: "domain-module" as const, ...BASE_ACTION_MODULE };
const envelope = (fields: string[], operations: number, knowledge: boolean, scene: boolean) => ({ maxStateOperations: operations, allowedStateFields: fields, allowsKnowledge: knowledge, allowsTimeAdvance: true, allowsSceneTransition: scene });

export const BASE_ACTION_SCHEMAS: readonly ActionSchema[] = Object.freeze([
  {
    ontologyVersion: "action-schema-v1", id: "base-action-speak", name: "Speak", visibility: "public",
    roles: [character("speaker", "Speaker"), character("addressee", "Addressee", 0, 8)], initiatorRoleId: "speaker", parameters: [],
    preconditions: [{ op: "fact-equals", entity: { kind: "role", roleId: "speaker" }, field: "character.alive", value: { source: "literal", value: true } }],
    stateEffects: [], effectEnvelope: envelope([], 0, true, false), induction, evidence: [],
  },
  {
    ontologyVersion: "action-schema-v1", id: "base-action-move", name: "Move", visibility: "public",
    roles: [character("mover", "Mover"), { id: "destination", label: "Destination", allowedEntityKinds: ["location"], minCardinality: 1, maxCardinality: 1 }], initiatorRoleId: "mover", parameters: [],
    preconditions: [{ op: "fact-equals", entity: { kind: "role", roleId: "mover" }, field: "character.alive", value: { source: "literal", value: true } }],
    stateEffects: [{ op: "set", entity: { kind: "role", roleId: "mover" }, field: "character.location", value: { source: "role", roleId: "destination" }, required: true }],
    effectEnvelope: envelope(["character.location"], 1, false, true), induction, evidence: [],
  },
  {
    ontologyVersion: "action-schema-v1", id: "base-action-observe", name: "Observe", visibility: "public",
    roles: [character("observer", "Observer"), { id: "target", label: "Target", allowedEntityKinds: ["character", "location", "artifact", "faction", "institution", "concept", "other"], minCardinality: 0, maxCardinality: 1 }],
    initiatorRoleId: "observer", parameters: [], preconditions: [], stateEffects: [], effectEnvelope: envelope([], 0, true, false), induction, evidence: [],
  },
  {
    ontologyVersion: "action-schema-v1", id: "base-action-give", name: "Give", visibility: "public",
    roles: [character("giver", "Giver"), { id: "item", label: "Item", allowedEntityKinds: ["artifact"], minCardinality: 1, maxCardinality: 1 }, character("recipient", "Recipient")], initiatorRoleId: "giver", parameters: [],
    preconditions: [{ op: "fact-equals", entity: { kind: "role", roleId: "item" }, field: "artifact.custodian", value: { source: "role", roleId: "giver" } }],
    stateEffects: [{ op: "set", entity: { kind: "role", roleId: "item" }, field: "artifact.custodian", value: { source: "role", roleId: "recipient" }, required: true }],
    effectEnvelope: envelope(["artifact.custodian"], 1, false, false), induction, evidence: [],
  },
  {
    ontologyVersion: "action-schema-v1", id: "base-action-take", name: "Take", visibility: "public",
    roles: [character("taker", "Taker"), { id: "item", label: "Item", allowedEntityKinds: ["artifact"], minCardinality: 1, maxCardinality: 1 }], initiatorRoleId: "taker", parameters: [],
    preconditions: [{ op: "not", item: { op: "fact-exists", entity: { kind: "role", roleId: "item" }, field: "artifact.custodian" } }],
    stateEffects: [{ op: "set", entity: { kind: "role", roleId: "item" }, field: "artifact.custodian", value: { source: "role", roleId: "taker" }, required: true }],
    effectEnvelope: envelope(["artifact.custodian"], 1, false, false), induction, evidence: [],
  },
].map((schema) => actionSchemaSchema.parse(schema)));

const registered = new Map(BASE_ACTION_SCHEMAS.map((schema) => [schema.id, canonicalJson(schema)]));

/** A domain-module mechanism is admissible only as an exact copy of a registered host module. */
export function isRegisteredDomainModule(payload: unknown): boolean {
  const parsed = actionSchemaSchema.safeParse(payload);
  return parsed.success && parsed.data.induction.kind === "domain-module" && registered.get(parsed.data.id) === canonicalJson(parsed.data);
}
