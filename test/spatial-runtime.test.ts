import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import type { Claim, Entity, EvidenceRef } from "../src/world/model.js";
import {
  buildActorScopedActionContext,
  validatePlayerActionSpatialScope,
  type PlayerActionCandidate,
} from "../src/world/player-action.js";
import { spatialRelationSchema } from "../src/world/spatial-ontology.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const evidence: EvidenceRef[] = [{
  span: { sourceId: "novel", startByte: 0, endByte: 10, startLine: 1, endLine: 1, quoteHash: "a".repeat(64) },
  strength: "explicit",
}];

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-spatial-runtime-"));
  roots.push(root);
  const entities: Entity[] = [
    { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence },
    { id: "village", kind: "location", canonicalName: "Village", aliases: [], evidence },
    { id: "harbor", kind: "location", canonicalName: "Harbor", aliases: [], evidence },
    { id: "cliff", kind: "location", canonicalName: "Cliff", aliases: [], evidence },
  ];
  const routeClaim: Claim = {
    id: "road-on-map",
    subject: "hero",
    predicate: "route-to",
    object: "harbor",
    epistemicType: "explicit-fact",
    evidence,
  };
  const context: WorldModelContext = {
    sourceId: "novel",
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    claims: new Map([[routeClaim.id, routeClaim]]),
    events: new Map(),
    rules: new Map(),
    spatialOntologyVersion: "spatial-v1",
    spatialRelations: [spatialRelationSchema.parse({
      ontologyVersion: "spatial-v1",
      id: "village-harbor-road",
      kind: "route",
      fromLocationId: "village",
      toLocationId: "harbor",
      direction: "two-way",
      modes: ["foot"],
      duration: { minimum: 2, typical: 2, maximum: 2, unit: "hour" },
      basis: "explicit",
      visibility: "knowledge",
      knownByClaimIds: ["road-on-map"],
      status: "supported",
      confidence: 1,
      evidence,
    })],
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
  };
  const engine = new WorldEngine(root, context);
  const head = await engine.createBranch("main", "Main", {
    version: 1,
    operations: [
      { op: "set", entityId: "hero", field: "character.alive", value: true },
      { op: "set", entityId: "hero", field: "character.location", value: "village" },
    ],
  }, {
    version: 1,
    operations: [{ op: "learn", actorId: "hero", claimId: "road-on-map", status: "knows", confidence: 1 }],
  }, "novel", undefined, evidence, {}, {
    entryActorId: "hero",
    participantPresence: [{ entityId: "hero", mode: "physical" }],
  });
  return { root, engine, head };
}

function travel(amount: number, destination = "harbor", travelMode: "foot" | "water" = "foot"): PlayerActionCandidate {
  return {
    title: "Travel",
    intent: {
      kind: "act",
      summary: "Walk to the harbor",
      controlledAct: { eventTitle: "Hero leaves", actorObservation: "I set out.", interactionMode: "none" },
      targets: [{ kind: "entity", entityId: destination }],
      sceneTransition: { kind: "arrive", destination: { kind: "entity", entityId: destination }, travelMode },
      requestedTimeAdvance: { amount, unit: "hour" },
    },
    participants: [],
    preconditions: [],
    proposedDelta: {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.location", value: destination }],
    },
    requiresKnowledge: [],
    forbidsKnowledge: [],
  };
}

describe("spatial-v1 runtime", () => {
  it("rejects unproved and too-fast compiled travel but accepts the active route minimum", async () => {
    const { engine, head } = await fixture();
    await expect(validatePlayerActionSpatialScope(engine, travel(1), "hero", head, "novel"))
      .resolves.toContainEqual(expect.objectContaining({ code: "PLAYER_SPATIAL_TRAVEL_TOO_FAST" }));
    await expect(validatePlayerActionSpatialScope(engine, travel(2), "hero", head, "novel"))
      .resolves.toEqual([]);
    await expect(validatePlayerActionSpatialScope(engine, travel(2, "cliff"), "hero", head, "novel"))
      .resolves.toContainEqual(expect.objectContaining({ code: "PLAYER_SPATIAL_ROUTE_UNPROVEN" }));
    await expect(validatePlayerActionSpatialScope(engine, travel(2, "harbor", "water"), "hero", head, "novel"))
      .resolves.toContainEqual(expect.objectContaining({ code: "PLAYER_SPATIAL_ROUTE_UNPROVEN" }));
  });

  it("projects a knowledge-gated route only after its claim is actionable and strips evidence", async () => {
    const { engine, head } = await fixture();
    const context = await buildActorScopedActionContext(engine, "hero", head, undefined, "novel");
    expect(context.spatialRelations).toEqual([expect.objectContaining({
      kind: "route",
      fromLocationId: "village",
      toLocationId: "harbor",
    })]);
    expect(JSON.stringify(context.spatialRelations)).not.toMatch(/evidence|confidence|road-on-map/);
  });
});
