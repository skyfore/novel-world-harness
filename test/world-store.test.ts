import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, contentHash } from "../src/world/canonical.js";
import { WORLD_ENGINE_VERSION, WORLD_SCHEMA_VERSION, type StateDelta, type WorldCommit } from "../src/world/model.js";
import { BranchStore, WorldObjectStore } from "../src/world/store.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-world-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("canonical world objects", () => {
  it("hashes semantically identical object key order identically", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
  });
});

describe("WorldObjectStore", () => {
  it("stores immutable content-addressed deltas and commits", async () => {
    const root = await tempRoot();
    const store = new WorldObjectStore(root);
    const delta: StateDelta = {
      version: 1,
      operations: [{ op: "set", entityId: "cao-cao", field: "character.alive", value: true }],
    };
    const deltaHash = await store.putDelta(delta);
    expect(await store.putDelta(delta)).toBe(deltaHash);
    await expect(store.getDelta(deltaHash)).resolves.toEqual(delta);

    const commit: WorldCommit = {
      version: 1,
      branchId: "main",
      logicalTime: { step: 0, storyTime: { kind: "ordinal", label: "opening" } },
      eventHashes: [],
      engineVersion: WORLD_ENGINE_VERSION,
      schemaVersion: WORLD_SCHEMA_VERSION,
    };
    const commitHash = await store.putCommit(commit);
    await expect(store.getCommit(commitHash)).resolves.toEqual(commit);
  });
});

describe("BranchStore", () => {
  it("moves only the branch head and rejects stale parents", async () => {
    const root = await tempRoot();
    const objects = new WorldObjectStore(root);
    const branches = new BranchStore(root);
    const genesis = await objects.putCommit({
      version: 1,
      branchId: "main",
      logicalTime: { step: 0 },
      eventHashes: [],
      engineVersion: WORLD_ENGINE_VERSION,
      schemaVersion: WORLD_SCHEMA_VERSION,
    });
    await branches.create({ id: "main", name: "Main", headCommitId: genesis });

    const next = await objects.putCommit({
      version: 1,
      parentCommitId: genesis,
      branchId: "main",
      logicalTime: { step: 1 },
      eventHashes: [],
      engineVersion: WORLD_ENGINE_VERSION,
      schemaVersion: WORLD_SCHEMA_VERSION,
    });
    await branches.updateHead("main", genesis, next);
    await expect(branches.readHead("main")).resolves.toBe(next);
    await expect(branches.updateHead("main", genesis, next)).rejects.toThrow("Stale branch head");
  });

  it("recovers a lock left by a dead process", async () => {
    const root = await tempRoot();
    const objects = new WorldObjectStore(root);
    const branches = new BranchStore(root);
    const genesis = await objects.putCommit({
      version: 1,
      branchId: "main",
      logicalTime: { step: 0 },
      eventHashes: [],
      engineVersion: WORLD_ENGINE_VERSION,
      schemaVersion: WORLD_SCHEMA_VERSION,
    });
    await branches.create({ id: "main", name: "Main", headCommitId: genesis });
    await fs.writeFile(
      path.join(branches.root, "main", "lock"),
      JSON.stringify({ version: 1, pid: 2_147_483_647, hostname: os.hostname(), createdAt: new Date(0).toISOString() }),
      "utf8",
    );
    await expect(branches.withLock("main", async () => "recovered")).resolves.toBe("recovered");
    expect((await branches.inspectLock("main")).present).toBe(false);
  });

  it("serializes mutations with an exclusive branch lock", async () => {
    const root = await tempRoot();
    const objects = new WorldObjectStore(root);
    const branches = new BranchStore(root);
    const genesis = await objects.putCommit({
      version: 1,
      branchId: "main",
      logicalTime: { step: 0 },
      eventHashes: [],
      engineVersion: WORLD_ENGINE_VERSION,
      schemaVersion: WORLD_SCHEMA_VERSION,
    });
    await branches.create({ id: "main", name: "Main", headCommitId: genesis });

    await branches.withLock("main", async () => {
      await expect(branches.withLock("main", async () => undefined)).rejects.toThrow("Branch is locked");
    });
  });
});

