import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentHash } from "../src/world/canonical.js";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { fsckWorld } from "../src/world/fsck.js";
import { WORLD_ENGINE_VERSION, WORLD_SCHEMA_VERSION, type Entity } from "../src/world/model.js";
import { WorldSnapshotStore } from "../src/world/snapshot.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import { deriveProgressCertificate } from "../src/world/progress.js";

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
    const authoritative = await engine.projections.project(head, { fresh: true });
    const snapshots = new WorldSnapshotStore(root);
    const snapshot = await snapshots.write(authoritative);
    expect((await snapshots.read(head))?.projection).toEqual(authoritative);
    await snapshots.remove(head);
    expect(await snapshots.read(head)).toBeNull();
    expect(await engine.projections.project(head, { fresh: true })).toEqual(authoritative);
    expect(snapshot.version).toBe(2);
    expect(snapshot.projectionHash).toBeTruthy();
  });

  it("rejects state-only V1 snapshots instead of migrating them implicitly", async () => {
    const { root, head } = await fixture();
    const snapshots = new WorldSnapshotStore(root);
    await fs.mkdir(snapshots.root, { recursive: true });
    await fs.writeFile(path.join(snapshots.root, `${head}.json`), JSON.stringify({
      version: 1,
      commitId: head,
      state: { atCommit: head, logicalTime: { step: 1 }, values: {}, activeRuleIds: [] },
    }), "utf8");

    await expect(snapshots.read(head)).resolves.toBeNull();
    await expect(snapshots.inspect(head)).resolves.toMatchObject({
      status: "invalid",
      reason: expect.stringContaining("Unsupported projection checkpoint version"),
    });
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

  it("tracks every typed effect channel as reachable branch history", async () => {
    const { engine, head } = await fixture();
    const semanticDeltaHash = await engine.objects.putSemanticDelta({
      version: 1,
      operations: [{
        op: "record-proposition",
        proposition: {
          id: "hero-remembers-vow",
          subjectEntityId: "hero",
          relationId: "remembers-vow",
          object: { kind: "literal", value: true },
          polarity: "positive",
          modality: "asserted",
        },
      }],
    });
    const eventHash = await engine.objects.putEvent({
      version: 2,
      eventId: "records-vow",
      branchId: "main",
      logicalTime: { step: 2 },
      title: "The vow becomes branch truth",
      participants: ["hero"],
      effects: { version: 1, semanticDeltaHash },
      progressCertificate: deriveProgressCertificate({
        effects: { version: 1, semanticDeltaHash },
        loaded: { semanticDelta: await engine.objects.getSemanticDelta(semanticDeltaHash) },
        utteranceCount: 0,
        timeAdvanced: false,
      }),
      evidence: [],
      causalRelations: [],
      causalParents: [],
    });
    const commitHash = await engine.objects.putCommit({
      version: 1,
      parentCommitId: head,
      branchId: "main",
      logicalTime: { step: 2 },
      eventHashes: [eventHash],
      engineVersion: WORLD_ENGINE_VERSION,
      schemaVersion: WORLD_SCHEMA_VERSION,
    });
    await engine.branches.updateHead("main", head, commitHash);

    const report = await fsckWorld(engine);
    expect(report.ok).toBe(true);
    expect(report.reachableSemanticDeltas).toBe(1);
    expect(report.orphanObjects.semantics).toEqual([]);
  });

  it("reports a self-consistent checkpoint that drifts from genesis replay", async () => {
    const { root, engine, head } = await fixture();
    const snapshots = new WorldSnapshotStore(root);
    const checkpoint = await snapshots.write(await engine.projections.project(head, { fresh: true, useCheckpoints: false }));
    checkpoint.projection.state.values.hero!["character.title"] = "False Commander";
    checkpoint.projectionHash = contentHash(checkpoint.projection);
    await fs.writeFile(
      path.join(snapshots.root, `${head}.json`),
      `${JSON.stringify(checkpoint, null, 2)}\n`,
      "utf8",
    );

    const report = await fsckWorld(engine);
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "warning", code: "CHECKPOINT_DRIFT", objectId: head }),
    ]));
  });

  it("reports and ignores a corrupt checkpoint cache", async () => {
    const { root, engine, head } = await fixture();
    const snapshots = new WorldSnapshotStore(root);
    await snapshots.write(await engine.projections.project(head, { fresh: true, useCheckpoints: false }));
    const checkpointPath = path.join(snapshots.root, `${head}.json`);
    const raw = JSON.parse(await fs.readFile(checkpointPath, "utf8")) as { projectionHash: string };
    raw.projectionHash = "0".repeat(64);
    await fs.writeFile(checkpointPath, `${JSON.stringify(raw)}\n`, "utf8");

    const report = await fsckWorld(engine);
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "warning", code: "INVALID_CHECKPOINT", objectId: head }),
    ]));
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
