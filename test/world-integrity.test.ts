import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { fsckWorld } from "../src/world/fsck.js";
import type { Entity } from "../src/world/model.js";
import { WorldSnapshotStore } from "../src/world/snapshot.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-integrity-"));
  roots.push(root);
  const entities: Entity[] = [
    { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] },
    { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: [] },
  ];
  const context: WorldModelContext = {
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    rules: new Map(),
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
  };
  const engine = new WorldEngine(root, context);
  const genesis = await engine.createBranch("main", "Main", {
    version: 1,
    operations: [
      { op: "set", entityId: "hero", field: "character.alive", value: true },
      { op: "set", entityId: "hero", field: "character.location", value: "hall" },
    ],
  });
  const next = await engine.commitProposal({
    proposalId: "title",
    branchId: "main",
    expectedParentCommit: genesis,
    source: "background",
    title: "Promotion",
    participants: ["hero"],
    proposedTime: { kind: "unknown" },
    preconditions: [],
    proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.title", value: "Commander" }] },
    causalParents: [],
    evidence: [],
  });
  return { root, engine, head: next.newHead, eventHash: next.eventHash! };
}

describe("derived snapshots", () => {
  it("can be created and deleted without changing authoritative projection", async () => {
    const { root, engine, head } = await fixture();
    const authoritative = await engine.projector.project(head);
    const snapshots = new WorldSnapshotStore(root);
    const snapshot = await snapshots.write(head, authoritative);
    expect((await snapshots.read(head))?.state).toEqual(authoritative);
    await snapshots.remove(head);
    expect(await snapshots.read(head)).toBeNull();
    expect(await engine.projector.project(head)).toEqual(authoritative);
    expect(snapshot.stateHash).toBeTruthy();
  });
});

describe("world fsck", () => {
  it("accepts valid history and reports unreachable immutable objects as warnings", async () => {
    const { engine } = await fixture();
    await engine.objects.putDelta({ version: 1, operations: [] });
    const report = await fsckWorld(engine);
    expect(report.ok).toBe(true);
    expect(report.reachableCommits).toBe(2);
    expect(report.orphanObjects.deltas?.length).toBeGreaterThan(0);
    expect(report.issues.some((issue) => issue.code === "ORPHAN_OBJECT")).toBe(true);
  });

  it("detects corruption in a reachable content-addressed delta", async () => {
    const { engine, eventHash } = await fixture();
    const event = await engine.objects.getEvent(eventHash);
    if (!event.effects.stateDeltaHash) throw new Error("fixture event must reference a state delta");
    const filePath = path.join(engine.objects.root, "objects", "deltas", `${event.effects.stateDeltaHash}.json`);
    await fs.writeFile(filePath, '{"version":1,"operations":[]}\n', "utf8");
    const report = await fsckWorld(engine);
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === "BRANCH_REPLAY_FAILED")).toBe(true);
  });

  it("isolates an incomplete branch and continues checking healthy branches", async () => {
    const { engine } = await fixture();
    const broken = path.join(engine.branches.root, "broken");
    await fs.mkdir(broken, { recursive: true });
    await fs.writeFile(path.join(broken, "branch.json"), JSON.stringify({
      id: "broken",
      name: "Broken",
      headCommitId: "0".repeat(64),
    }), "utf8");

    const report = await fsckWorld(engine);
    expect(report.ok).toBe(false);
    expect(report.reachableCommits).toBe(2);
    expect(report.issues).toContainEqual(expect.objectContaining({ code: "INCOMPLETE_BRANCH", branchId: "broken" }));
  });
});
