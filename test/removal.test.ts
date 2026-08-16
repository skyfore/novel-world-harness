import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { SourceMaterialStore } from "../src/storage/source-material-store.js";
import { WorkspaceStore } from "../src/storage/workspace-store.js";
import { ActorModelStore } from "../src/world/actors.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { PlaySessionStore } from "../src/world/play-session.js";
import { inspectPlayExperience, listPlayableCharacters } from "../src/world/play-experience.js";
import { removeNovel, removeNovelAnalysis, removeWorldInstance } from "../src/world/removal.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function rootFixture(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("novel-world removal", () => {
  it("removes one leaf instance, rejects a parent with a live child, and repairs active resume state", async () => {
    const root = await rootFixture("nwh-remove-instance-");
    const fixture = await createEvidenceFixture(root, "Hero waits.\n", "instance-novel.txt");
    await new CanonicalModelStore(root).putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: fixture.evidence("Hero"),
    });
    const { engine, runtime } = await openWorkspaceWorld(root);
    const head = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    }, undefined, fixture.source.id);
    await runtime.forkBranch("main", head, "child", "Child");
    const sessions = new PlaySessionStore(root);
    await sessions.write({ branchId: "main", sourceId: fixture.source.id, actorId: "hero", lastCommitId: head });
    await sessions.write({ branchId: "child", sourceId: fixture.source.id, actorId: "hero", lastCommitId: head });

    await expect(removeWorldInstance(root, "main")).rejects.toThrow("child instance 'child'");
    await expect(removeWorldInstance(root, "child")).resolves.toMatchObject({
      branchId: "child",
      nextActiveSession: { branchId: "main" },
    });
    await expect(engine.branches.read("child")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(sessions.read()).resolves.toMatchObject({ branchId: "main" });

    await expect(removeWorldInstance(root, "main")).resolves.toMatchObject({
      branchId: "main",
      nextActiveSession: null,
    });
    await expect(sessions.read()).resolves.toBeNull();
  });

  it("resets one novel analysis while retaining its registration and pinned playable instance", async () => {
    const root = await rootFixture("nwh-remove-analysis-");
    const first = await createEvidenceFixture(root, "First Hero waits.\n", "first.txt");
    const second = await createEvidenceFixture(root, "Second Hero waits.\n", "second.txt");
    const canonical = new CanonicalModelStore(root);
    await canonical.putEntity({ id: "first-hero", kind: "character", canonicalName: "First Hero", aliases: [], evidence: first.evidence("First Hero") });
    await canonical.putEntity({ id: "second-hero", kind: "character", canonicalName: "Second Hero", aliases: [], evidence: second.evidence("Second Hero") });
    const actors = new ActorModelStore(root);
    await actors.putModel({ actorId: "first-hero", traits: { patience: 1 }, decisionBiases: {}, evidence: first.evidence("First Hero") });
    await actors.putModel({ actorId: "second-hero", traits: { patience: 1 }, decisionBiases: {}, evidence: second.evidence("Second Hero") });
    await new InitialWorldStore(root).put({ version: 1, delta: { version: 1, operations: [] }, evidence: first.evidence("waits") });
    const batches = await prepareCompilerBatches(root, first.source);
    await new CompilerBatchStore(root).markComplete(first.source.id, batches[0]!.id);
    await new CompilerProposalService(root).submit("entity", {
      proposalId: "first-draft",
      payload: { id: "first-draft-entity", kind: "character", canonicalName: "Draft", aliases: [], evidence: first.evidence("Hero") },
      generatedBy: { worker: "test" },
    });
    const { engine } = await openWorkspaceWorld(root);
    const head = await engine.createBranch("first-world", "First world", {
      version: 1,
      operations: [{ op: "set", entityId: "first-hero", field: "character.alive", value: true }],
    }, undefined, first.source.id);
    await new PlaySessionStore(root).write({ branchId: "first-world", sourceId: first.source.id, actorId: "first-hero", lastCommitId: head });
    const cacheRoot = path.join(root, "prepared-cache");
    const cachePath = path.join(cacheRoot, first.source.contentMd5!);
    await fs.mkdir(cachePath, { recursive: true });
    await fs.writeFile(path.join(cachePath, "debug-marker"), "cached", "utf8");

    const result = await removeNovelAnalysis(root, first.source, { cacheRoot });

    expect(result).toMatchObject({
      canonicalArtifacts: 1,
      actorArtifacts: 1,
      proposals: 1,
      initialWorld: true,
      evidenceIndex: true,
      compilerProgress: true,
      preparedCache: true,
    });
    expect((await (await WorkspaceStore.create(root)).listSources()).map((source) => source.id)).toContain(first.source.id);
    expect((await canonical.listEntities()).map((entity) => entity.id)).toEqual(["second-hero"]);
    expect((await actors.listModels()).map((model) => model.actorId)).toEqual(["second-hero"]);
    await expect(new InitialWorldStore(root).get()).resolves.toBeNull();
    await expect(engine.branches.read("first-world")).resolves.toMatchObject({ sourceId: first.source.id });
    await expect(listPlayableCharacters(root, { branchId: "first-world", source: first.source.id })).resolves.toMatchObject({
      characters: [expect.objectContaining({ id: "first-hero" })],
    });
    await expect(fs.stat(cachePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a novel, all of its instances, and active parsed state without deleting archived evidence", async () => {
    const root = await rootFixture("nwh-remove-novel-");
    const first = await createEvidenceFixture(root, "First Hero waits.\n", "first.txt");
    const second = await createEvidenceFixture(root, "Second Hero waits.\n", "second.txt");
    const canonical = new CanonicalModelStore(root);
    await canonical.putEntity({ id: "first-hero", kind: "character", canonicalName: "First Hero", aliases: [], evidence: first.evidence("First Hero") });
    await canonical.putEntity({ id: "second-hero", kind: "character", canonicalName: "Second Hero", aliases: [], evidence: second.evidence("Second Hero") });
    const { engine } = await openWorkspaceWorld(root);
    const firstHead = await engine.createBranch("first-world", "First", {
      version: 1,
      operations: [{ op: "set", entityId: "first-hero", field: "character.alive", value: true }],
    }, undefined, first.source.id);
    const secondHead = await engine.createBranch("second-world", "Second", {
      version: 1,
      operations: [{ op: "set", entityId: "second-hero", field: "character.alive", value: true }],
    }, undefined, second.source.id);
    const sessions = new PlaySessionStore(root);
    await sessions.write({ branchId: "second-world", sourceId: second.source.id, actorId: "second-hero", lastCommitId: secondHead });
    await sessions.write({ branchId: "first-world", sourceId: first.source.id, actorId: "first-hero", lastCommitId: firstHead });

    const result = await removeNovel(root, first.source, { cacheRoot: path.join(root, "prepared-cache") });

    expect(result.removedBranchIds).toEqual(["first-world"]);
    expect((await (await WorkspaceStore.create(root)).listSources()).map((source) => source.id)).toEqual([second.source.id]);
    expect((await inspectPlayExperience(root)).instances.map((instance) => instance.branchId)).toEqual(["second-world"]);
    await expect(sessions.read()).resolves.toMatchObject({ branchId: "second-world" });
    expect((await canonical.listEntities()).map((entity) => entity.id)).toEqual(["second-hero"]);
    await expect(new SourceMaterialStore().read(first.source)).resolves.toEqual(Buffer.from("First Hero waits.\n"));
  });
});
