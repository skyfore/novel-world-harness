import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, contentHash } from "../src/world/canonical.js";
import {
  WORLD_ENGINE_VERSION,
  WORLD_SCHEMA_VERSION,
  committedEventSchema,
  type StateDelta,
  type WorldCommit,
} from "../src/world/model.js";
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

  it("accepts only Event V2 with typed content-addressed effect references", () => {
    const knowledgeDeltaHash = "a".repeat(64);
    const event = {
      version: 2,
      eventId: "event-1",
      branchId: "main",
      logicalTime: { step: 1 },
      title: "A witness learns the password",
      participants: ["witness"],
      effects: { version: 1, knowledgeDeltaHash },
      evidence: [],
      causalParents: [],
    } as const;

    expect(committedEventSchema.parse(event).effects).toEqual({ version: 1, knowledgeDeltaHash });
    expect(committedEventSchema.safeParse({
      ...event,
      version: 1,
      deltaHash: "legacy-delta",
    }).success).toBe(false);
    expect(committedEventSchema.safeParse({
      ...event,
      effects: { version: 1, stateDeltaHash: "logical-id-is-not-a-content-hash" },
    }).success).toBe(false);
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

  it("stores semantic, process, and norm deltas in distinct typed channels", async () => {
    const root = await tempRoot();
    const store = new WorldObjectStore(root);
    const semantic = {
      version: 1 as const,
      operations: [{
        op: "record-proposition" as const,
        proposition: {
          id: "branch-proposition-1",
          subjectEntityId: "hero",
          relationId: "promised-to-return",
          object: { kind: "literal" as const, value: true },
          polarity: "positive" as const,
          modality: "asserted" as const,
        },
      }],
    };
    const processes = {
      version: 1 as const,
      operations: [{
        op: "start-process" as const,
        process: { id: "storm-1", ownerEntityIds: ["valley"], phaseId: "forming", progress: 0.1 },
      }],
    };
    const norms = {
      version: 1 as const,
      operations: [{
        op: "instantiate-norm" as const,
        norm: {
          id: "promise-1",
          templateId: "keep-promises",
          subjectActorId: "hero",
          beneficiaryActorId: "witness",
          description: "Hero should return before nightfall.",
        },
      }],
    };

    const semanticHash = await store.putSemanticDelta(semantic);
    const processHash = await store.putProcessDelta(processes);
    const normHash = await store.putNormDelta(norms);
    await expect(store.getSemanticDelta(semanticHash)).resolves.toEqual(semantic);
    await expect(store.getProcessDelta(processHash)).resolves.toEqual(processes);
    await expect(store.getNormDelta(normHash)).resolves.toEqual(norms);
    await expect(store.putSemanticDelta({
      version: 1,
      operations: [{
        op: "adjust-relationship",
        relationshipId: "hero-witness",
        fromActorId: "hero",
        toActorId: "witness",
        dimensionId: "trust",
        amount: 0,
      }],
    })).rejects.toThrow("Relationship adjustment cannot be zero");
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

  it("publishes a new branch only after branch metadata and head are complete", async () => {
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
    await expect(fs.access(path.join(branches.root, "main", "branch.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(branches.root, "main", "head.json"))).resolves.toBeUndefined();
    expect((await fs.readdir(branches.root)).some((name) => name.startsWith(".staging-main-"))).toBe(false);
  });

  it("does not automatically steal a stale branch lock", async () => {
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

    await expect(branches.withLock("main", async () => "recovered")).rejects.toThrow("stale lock");
    const status = await branches.inspectLock("main");
    expect(status.present).toBe(true);
    expect(status.stale).toBe(true);
  });

  it("does not delete a replacement lock when the old holder releases", async () => {
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
    const lockPath = path.join(branches.root, "main", "lock");
    const replacementToken = "replacement-token";

    await branches.withLock("main", async () => {
      await fs.rm(lockPath);
      await fs.writeFile(
        lockPath,
        `${JSON.stringify({ version: 2, pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString(), token: replacementToken })}\n`,
        "utf8",
      );
    });

    const status = await branches.inspectLock("main");
    expect(status.present).toBe(true);
    expect(status.metadata?.version).toBe(2);
    expect(status.metadata?.version === 2 ? status.metadata.token : undefined).toBe(replacementToken);
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
