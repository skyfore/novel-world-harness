import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import type { Claim, Entity, EvidenceRef } from "../src/world/model.js";
import { buildActorScopedActionContext } from "../src/world/player-action.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const evidence = (sourceId: string): EvidenceRef[] => [{
  span: { sourceId, startLine: 1, endLine: 1, quoteHash: `${sourceId}-hash` },
  strength: "explicit",
}];

describe("actor source isolation", () => {
  it("uses the captured world source even when a caller omits sourceId", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-player-source-"));
    roots.push(root);
    const entities: Entity[] = [
      { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: evidence("source-a") },
      { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: evidence("source-a") },
      { id: "token", kind: "artifact", canonicalName: "Token", aliases: [], evidence: evidence("source-a") },
      { id: "intruder", kind: "character", canonicalName: "Intruder", aliases: [], evidence: evidence("source-b") },
      { id: "lair", kind: "location", canonicalName: "Lair", aliases: [], evidence: evidence("source-b") },
    ];
    const claims: Claim[] = [
      { id: "known-hall", subject: "hero", predicate: "knows-place", object: "hall", epistemicType: "explicit-fact", evidence: evidence("source-a") },
      { id: "foreign-secret", subject: "intruder", predicate: "waits-at", object: "lair", epistemicType: "explicit-fact", evidence: evidence("source-b") },
      { id: "mixed-secret", subject: "hero", predicate: "mentions", object: "intruder", epistemicType: "explicit-fact", evidence: [...evidence("source-a"), ...evidence("source-b")] },
      { id: "foreign-endpoint", subject: "intruder", predicate: "entered", object: "hall", epistemicType: "explicit-fact", evidence: evidence("source-a") },
      { id: "foreign-object", subject: "hero", predicate: "suspects", object: { nested: ["intruder"] }, epistemicType: "explicit-fact", evidence: evidence("source-a") },
    ];
    const context: WorldModelContext = {
      sourceId: "source-a",
      entities: new Map(entities.map((entity) => [entity.id, entity])),
      claims: new Map(claims.map((claim) => [claim.id, claim])),
      rules: new Map(),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    };
    const engine = new WorldEngine(root, context);
    const head = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.location", value: "lair" },
        { op: "set", entityId: "intruder", field: "character.location", value: "lair" },
        { op: "set", entityId: "token", field: "artifact.owner", value: "hero" },
        { op: "set", entityId: "token", field: "artifact.custodian", value: "intruder" },
      ],
    }, {
      version: 1,
      operations: [
        { op: "learn", actorId: "hero", claimId: "known-hall", status: "knows", confidence: 1, sourceActorId: "intruder" },
        { op: "learn", actorId: "hero", claimId: "foreign-secret", status: "knows", confidence: 1 },
        { op: "learn", actorId: "hero", claimId: "mixed-secret", status: "knows", confidence: 1 },
        { op: "learn", actorId: "hero", claimId: "foreign-endpoint", status: "knows", confidence: 1 },
        { op: "learn", actorId: "hero", claimId: "foreign-object", status: "knows", confidence: 1 },
      ],
    });

    const projected = await buildActorScopedActionContext(engine, "hero", head);
    expect(projected.knowledge.map((entry) => entry.claimId)).toEqual(["known-hall"]);
    expect(projected.knowledge[0]).not.toHaveProperty("sourceActorId");
    expect(projected.referenceableEntities.map((entity) => entity.id)).toEqual(["hall", "hero", "token"]);
    expect(projected.selfState).not.toHaveProperty("character.location");
    expect(projected.scene).not.toHaveProperty("locationId");
    expect(projected.scene).not.toHaveProperty("label");
    expect(projected.ownedEntityState.token).toEqual({ "artifact.owner": "hero" });
    expect(JSON.stringify(projected)).not.toContain("foreign-secret");
    expect(JSON.stringify(projected)).not.toContain("mixed-secret");
    expect(JSON.stringify(projected)).not.toContain("foreign-endpoint");
    expect(JSON.stringify(projected)).not.toContain("foreign-object");
    expect(JSON.stringify(projected)).not.toContain("intruder");
    expect(JSON.stringify(projected)).not.toContain("lair");
    await expect(buildActorScopedActionContext(engine, "hero", head, undefined, "source-b"))
      .rejects.toThrow("does not match committed branch context");
  });
});
