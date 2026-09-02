import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveActionInvocation, validateActionSchemaCatalog, type ActionSchema } from "../src/world/action-ontology.js";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import type { Entity } from "../src/world/model.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const entityList: Entity[] = [
  { id: "giver", kind: "character", canonicalName: "Giver", aliases: [], evidence: [] },
  { id: "recipient", kind: "character", canonicalName: "Recipient", aliases: [], evidence: [] },
  { id: "key", kind: "artifact", canonicalName: "Key", aliases: [], evidence: [] },
];
const entities = new Map(entityList.map((entity) => [entity.id, entity]));
const transfer: ActionSchema = {
  ontologyVersion: "action-schema-v1",
  id: "transfer-item",
  name: "Transfer an item",
  roles: [
    { id: "giver", label: "Giver", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 },
    { id: "recipient", label: "Recipient", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 },
    { id: "item", label: "Item", allowedEntityKinds: ["artifact"], minCardinality: 1, maxCardinality: 1 },
  ],
  parameters: [],
  preconditions: [{
    op: "fact-equals",
    entity: { kind: "role", roleId: "item" },
    field: "artifact.owner",
    value: { source: "role", roleId: "giver" },
  }],
  stateEffects: [{
    op: "set",
    entity: { kind: "role", roleId: "item" },
    field: "artifact.owner",
    value: { source: "role", roleId: "recipient" },
    required: true,
  }],
  effectEnvelope: {
    maxStateOperations: 1,
    allowedStateFields: ["artifact.owner"],
    allowsKnowledge: false,
    allowsTimeAdvance: false,
    allowsSceneTransition: false,
  },
  induction: { kind: "domain-module", moduleId: "core-possession", moduleVersion: "1" },
  evidence: [],
};
const invocation = {
  lane: "schema-bound" as const,
  schemaId: transfer.id,
  roleBindings: [
    { roleId: "giver", entityIds: ["giver"] },
    { roleId: "recipient", entityIds: ["recipient"] },
    { roleId: "item", entityIds: ["key"] },
  ],
  parameters: {},
};

describe("ActionSchema", () => {
  it("resolves role templates and enforces the declared effect envelope", () => {
    expect(validateActionSchemaCatalog(transfer, entities, new Set())).toEqual([]);
    const resolved = resolveActionInvocation(invocation, new Map([[transfer.id, transfer]]), entities, {
      participants: ["giver", "recipient", "key"],
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "key", field: "artifact.owner", value: "recipient" }] },
      hasKnowledge: false,
      hasTimeAdvance: false,
      hasSceneTransition: false,
    });
    expect(resolved.issues).toEqual([]);
    expect(resolved.preconditions).toEqual([{ op: "fact-equals", entityId: "key", field: "artifact.owner", value: "giver" }]);

    const forbidden = resolveActionInvocation(invocation, new Map([[transfer.id, transfer]]), entities, {
      participants: ["giver", "recipient", "key"],
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "key", field: "artifact.delivered", value: true }] },
      hasKnowledge: true,
      hasTimeAdvance: false,
      hasSceneTransition: false,
    });
    expect(forbidden.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "ACTION_EFFECT_FIELD_FORBIDDEN",
      "ACTION_KNOWLEDGE_EFFECT_FORBIDDEN",
    ]));
  });

  it("requires unknown actions to use the explicit ad-hoc lane and applies schema preconditions in the engine", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-action-schema-"));
    roots.push(root);
    const context: WorldModelContext = {
      entities,
      rules: new Map(),
      actionSchemas: new Map([[transfer.id, transfer]]),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    };
    const engine = new WorldEngine(root, context);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "giver", field: "character.alive", value: true },
        { op: "set", entityId: "recipient", field: "character.alive", value: true },
        { op: "set", entityId: "key", field: "artifact.owner", value: "giver" },
      ],
    });
    const base = {
      branchId: "main",
      expectedParentCommit: genesis,
      source: "player" as const,
      actorId: "giver",
      title: "Transfer the key",
      participants: ["giver", "recipient", "key"],
      proposedTime: { kind: "unknown" as const },
      preconditions: [],
      proposedDelta: { version: 1 as const, operations: [{ op: "set" as const, entityId: "key", field: "artifact.owner", value: "recipient" }] },
      causalParents: [],
      evidence: [],
    };
    const unknown = await engine.commitProposal({
      ...base,
      proposalId: "unknown-schema",
      action: { ...invocation, schemaId: "not-registered" },
    });
    expect(unknown.report.errors).toContainEqual(expect.objectContaining({ code: "UNKNOWN_ACTION_SCHEMA" }));
    expect(await engine.branches.readHead("main")).toBe(genesis);

    const committed = await engine.commitProposal({ ...base, proposalId: "bound-transfer", action: invocation });
    expect(committed.report.accepted).toBe(true);
    expect((await engine.objects.getEvent(committed.eventHash!)).action).toEqual(invocation);

    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-ad-hoc-action-"));
    roots.push(secondRoot);
    const adHocEngine = new WorldEngine(secondRoot, context);
    const adHocGenesis = await adHocEngine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "key", field: "artifact.owner", value: "giver" }],
    });
    const adHoc = await adHocEngine.commitProposal({
      ...base,
      proposalId: "explicit-ad-hoc",
      expectedParentCommit: adHocGenesis,
      action: { lane: "ad-hoc", description: "An uncompiled but bounded transfer" },
    });
    expect(adHoc.report.accepted).toBe(true);
  });
});
