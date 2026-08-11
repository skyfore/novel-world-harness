import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import type { Entity, Possibility } from "../src/world/model.js";
import { runCanonReplay } from "../src/world/replay.js";
import { WorldRuntime } from "../src/world/runtime.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup(startInHall = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-replay-"));
  roots.push(root);
  const entities: Entity[] = [
    { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] },
    { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: [] },
    { id: "camp", kind: "location", canonicalName: "Camp", aliases: [], evidence: [] },
  ];
  const context: WorldModelContext = {
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    rules: new Map(),
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
  };
  const engine = new WorldEngine(root, context);
  await engine.createBranch("replay", "Replay", {
    version: 1,
    operations: [
      { op: "set", entityId: "hero", field: "character.alive", value: true },
      { op: "set", entityId: "hero", field: "character.location", value: startInHall ? "hall" : "camp" },
    ],
  });
  const source = ({ branchId, commitId }: { branchId: string; commitId: string }): Possibility[] => [
    {
      id: "promotion",
      branchId,
      evaluatedAtCommit: commitId,
      kind: "canon-analogue",
      title: "Promotion",
      preconditions: [{ op: "fact-equals", entityId: "hero", field: "character.location", value: "hall" }],
      blockers: [{ op: "fact-equals", entityId: "hero", field: "character.location", value: "camp" }],
      participants: ["hero"],
      causalParents: [],
      canonicalEventId: "canon-promotion",
      pressure: 1,
      relevance: 1,
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.title", value: "Commander" }] },
      evidence: [],
    },
  ];
  return new WorldRuntime(engine, source);
}

describe("canon replay", () => {
  it("reaches a canonical checkpoint through surviving conditions", async () => {
    const runtime = await setup(true);
    const result = await runCanonReplay(runtime, "replay", [
      {
        id: "promoted",
        label: "hero promoted",
        expected: [{ op: "fact-equals", entityId: "hero", field: "character.title", value: "Commander" }],
      },
    ]);
    expect(result.passed).toBe(true);
    expect(result.moves).toBe(1);
    expect(result.diagnostics).toEqual([]);
  });

  it("diagnoses a destroyed canonical path instead of forcing the event", async () => {
    const runtime = await setup(false);
    const result = await runCanonReplay(runtime, "replay", [
      {
        id: "promoted",
        label: "hero promoted",
        expected: [{ op: "fact-equals", entityId: "hero", field: "character.title", value: "Commander" }],
      },
    ]);
    expect(result.passed).toBe(false);
    expect(result.endCommit).toBe(result.startCommit);
    expect(result.diagnostics[0]?.code).toBe("BLOCKED");
  });
});

