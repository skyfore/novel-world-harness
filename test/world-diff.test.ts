import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffWorldBranches } from "../src/world/diff.js";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import type { Entity, EventProposal } from "../src/world/model.js";
import { WorldRuntime } from "../src/world/runtime.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("world branch diff", () => {
  it("reports divergent event history and actor knowledge even when final state matches", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-diff-"));
    roots.push(root);
    const entities: Entity[] = [{ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] }];
    const context: WorldModelContext = {
      entities: new Map(entities.map((entity) => [entity.id, entity])),
      claims: new Map([["secret", { id: "secret", subject: "hero", predicate: "knows", object: true, epistemicType: "explicit-fact", evidence: [] }]]),
      rules: new Map(),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    };
    const engine = new WorldEngine(root, context);
    const genesis = await engine.createBranch("left", "left", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    const runtime = new WorldRuntime(engine, () => []);
    await runtime.forkBranch("left", genesis, "right", "right");
    const base = {
      expectedParentCommit: genesis,
      source: "player" as const,
      participants: ["hero"],
      proposedTime: { kind: "unknown" as const },
      preconditions: [],
      proposedDelta: { version: 1 as const, operations: [] },
      causalParents: [],
      evidence: [],
    };
    const left: EventProposal = {
      ...base,
      proposalId: "left-learns",
      branchId: "left",
      title: "Learns the secret",
      proposedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "hero", claimId: "secret", status: "knows", confidence: 1 }] },
    };
    const right: EventProposal = {
      ...base,
      proposalId: "right-waits",
      branchId: "right",
      title: "Waits",
      progress: { version: 1, channels: ["time-pressure"], threadIds: ["thread-wait"], noveltyKey: "wait-once" },
    };
    expect((await engine.commitProposal(left)).report.accepted).toBe(true);
    expect((await engine.commitProposal(right)).report.accepted).toBe(true);

    const result = await diffWorldBranches(engine, "left", "right");
    expect(result.commonAncestor).toBe(genesis);
    expect(result.stateDifferences).toEqual([]);
    expect(result.history.leftOnly.map((entry) => entry.title)).toEqual(["Learns the secret"]);
    expect(result.history.rightOnly.map((entry) => entry.title)).toEqual(["Waits"]);
    expect(result.knowledgeDifferences).toHaveLength(1);
    expect(result.knowledgeDifferences[0]).toMatchObject({ actorId: "hero", claimId: "secret", left: { status: "knows" } });
  });
});
