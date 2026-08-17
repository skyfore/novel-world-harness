import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { convergeWorldProposals } from "../src/compiler/converge.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { canonicalJson, contentHash } from "../src/world/canonical.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("versioned prepared novel cache", () => {
  it("refuses to create from an active bundle after newer accepted source artifacts make it stale", async () => {
    const cacheRoot = await temporaryRoot("nwh-prepared-fresh-cache-");
    const sourceRoot = await temporaryRoot("nwh-prepared-fresh-source-");
    const fixture = await createEvidenceFixture(sourceRoot, "Hero waits at the opening.\n");
    const proposals = new CompilerProposalService(sourceRoot);
    await proposals.submit("entity", {
      proposalId: "fresh-hero",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: fixture.evidence("Hero") },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("initial-world", {
      proposalId: "fresh-opening",
      payload: {
        version: 1,
        delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] },
        evidence: fixture.evidence("Hero waits at the opening."),
      },
      generatedBy: { worker: "test" },
    });
    const batches = await prepareCompilerBatches(sourceRoot, fixture.source);
    await new CompilerBatchStore(sourceRoot).replaceCompleted(fixture.source.id, batches.map((batch) => batch.id));
    await convergeWorldProposals(sourceRoot, fixture.source.id);
    const cache = new PreparedNovelCache(sourceRoot, cacheRoot);
    const published = await cache.publish(fixture.source);
    await expect(cache.loadFreshActive(fixture.source)).resolves.toMatchObject({ bundleHash: published.bundleHash });

    const canon = new CanonicalModelStore(sourceRoot);
    const hero = await canon.getEntity("hero");
    await canon.putEntity({ ...hero, aliases: ["The Hero"] });

    await expect(cache.loadFreshActive(fixture.source)).rejects.toThrow("stale relative to accepted workspace artifacts");
    await expect(cache.loadFreshActive(fixture.source)).rejects.toThrow("entities differ");
    const revised = await cache.publish(fixture.source);
    await expect(cache.loadFreshActive(fixture.source)).resolves.toMatchObject({ bundleHash: revised.bundleHash });
  });

  it("reuses active MD5 revisions while immutable revisions and branches remain independent", async () => {
    const cacheRoot = await temporaryRoot("nwh-prepared-cache-");
    const sourceRoot = await temporaryRoot("nwh-prepared-source-");
    const content = "Hero waits at the opening.\n";
    const fixture = await createEvidenceFixture(sourceRoot, content);
    const proposals = new CompilerProposalService(sourceRoot);
    await proposals.submit("entity", {
      proposalId: "entity-hero",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: fixture.evidence("Hero") },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("initial-world", {
      proposalId: "opening-world",
      payload: {
        version: 1,
        delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] },
        evidence: fixture.evidence("Hero waits at the opening."),
      },
      generatedBy: { worker: "test" },
    });
    const batches = await prepareCompilerBatches(sourceRoot, fixture.source);
    await new CompilerBatchStore(sourceRoot).replaceCompleted(fixture.source.id, batches.map((batch) => batch.id));
    const convergence = await convergeWorldProposals(sourceRoot, fixture.source.id);
    expect(convergence.canonical.accepted).toHaveLength(2);

    const sourceCache = new PreparedNovelCache(sourceRoot, cacheRoot);
    const published = await sourceCache.publish(fixture.source);
    expect(published).toMatchObject({ status: "published", contentMd5: fixture.source.contentMd5 });
    const cachedBundlePath = path.join(published.cachePath, "bundle.json");
    const immutableBaseline = await fs.readFile(cachedBundlePath, "utf8");
    expect((await fs.stat(cachedBundlePath)).mode & 0o222).toBe(0);
    await fs.rm(path.join(sourceRoot, fixture.source.sourcePath));
    await expect(sourceCache.lookup(fixture.source)).resolves.toMatchObject({
      status: "already-cached",
      bundleHash: published.bundleHash,
    });

    const reusedRoot = await temporaryRoot("nwh-prepared-reuse-");
    const reusedFixture = await createEvidenceFixture(reusedRoot, content, "same-content-different-name.md");
    const restored = await new PreparedNovelCache(reusedRoot, cacheRoot).restore(reusedFixture.source);
    expect(restored).toMatchObject({ status: "restored", contentMd5: published.contentMd5, bundleHash: published.bundleHash });
    await expect(new CanonicalModelStore(reusedRoot).getEntity("hero")).resolves.toMatchObject({ aliases: [] });
    await expect(new InitialWorldStore(reusedRoot).get()).resolves.toMatchObject({ delta: { operations: [expect.objectContaining({ value: true })] } });
    const reusedBatches = await prepareCompilerBatches(reusedRoot, reusedFixture.source);
    await expect(new CompilerBatchStore(reusedRoot).read(reusedFixture.source.id)).resolves.toMatchObject({
      completedBatchIds: reusedBatches.map((batch) => batch.id).sort(),
    });

    const initial = await new InitialWorldStore(reusedRoot).get();
    if (!initial) throw new Error("restored initial world missing");
    const { engine } = await openWorkspaceWorld(reusedRoot);
    await engine.createBranch("main", "main", initial.delta, initial.knowledge);
    await engine.createBranch("alternate", "alternate", initial.delta, initial.knowledge);
    const mainHead = await engine.branches.readHead("main");
    await engine.commitProposal({
      proposalId: "hero-falls",
      branchId: "main",
      expectedParentCommit: mainHead,
      source: "player",
      actorId: "hero",
      title: "Hero falls",
      participants: ["hero"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: false }] },
      causalParents: [],
      evidence: fixture.evidence("Hero"),
    });
    expect((await engine.projector.project(await engine.branches.readHead("main"))).values.hero?.["character.alive"]).toBe(false);
    expect((await engine.projector.project(await engine.branches.readHead("alternate"))).values.hero?.["character.alive"]).toBe(true);
    expect(await fs.readFile(cachedBundlePath, "utf8")).toBe(immutableBaseline);

    const originalEntity = await new CanonicalModelStore(sourceRoot).getEntity("hero");
    await new CanonicalModelStore(sourceRoot).putEntity({ ...originalEntity, aliases: ["Hero"] });
    const revised = await sourceCache.publish(fixture.source);
    expect(revised).toMatchObject({ status: "published", contentMd5: published.contentMd5 });
    expect(revised.bundleHash).not.toBe(published.bundleHash);
    expect(await fs.readFile(cachedBundlePath, "utf8")).toBe(immutableBaseline);
    await expect(sourceCache.listRevisions(fixture.source)).resolves.toEqual([
      expect.objectContaining({ bundleHash: published.bundleHash, active: false }),
      expect.objectContaining({ bundleHash: revised.bundleHash, active: true }),
    ]);

    await new PreparedNovelCache(reusedRoot, cacheRoot).activate(reusedFixture.source, revised.bundleHash!);
    const reopened = await openWorkspaceWorld(reusedRoot);
    const oldMainHead = await reopened.engine.branches.readHead("main");
    expect((await reopened.engine.contextForCommit(oldMainHead)).entities.get("hero")?.aliases).toEqual([]);
    const latestHead = await reopened.engine.createBranch("latest", "latest", initial.delta, initial.knowledge);
    expect((await reopened.engine.contextForCommit(latestHead)).entities.get("hero")?.aliases).toEqual(["Hero"]);

    const thirdRoot = await temporaryRoot("nwh-prepared-third-");
    const thirdFixture = await createEvidenceFixture(thirdRoot, content);
    await expect(new PreparedNovelCache(thirdRoot, cacheRoot).restore(thirdFixture.source)).resolves.toMatchObject({ status: "restored" });
    await expect(new CanonicalModelStore(thirdRoot).getEntity("hero")).resolves.toMatchObject({ aliases: ["Hero"] });

    await sourceCache.activate(fixture.source, published.bundleHash!);
    const fourthRoot = await temporaryRoot("nwh-prepared-fourth-");
    const fourthFixture = await createEvidenceFixture(fourthRoot, content);
    await expect(new PreparedNovelCache(fourthRoot, cacheRoot).restore(fourthFixture.source)).resolves.toMatchObject({ status: "restored" });
    await expect(new CanonicalModelStore(fourthRoot).getEntity("hero")).resolves.toMatchObject({ aliases: [] });

    const legacyCacheRoot = await temporaryRoot("nwh-prepared-legacy-");
    const legacyDirectory = path.join(legacyCacheRoot, published.contentMd5);
    await fs.mkdir(legacyDirectory, { mode: 0o700 });
    await fs.copyFile(path.join(published.cachePath, "bundle.json"), path.join(legacyDirectory, "bundle.json"));
    await fs.copyFile(path.join(published.cachePath, "manifest.json"), path.join(legacyDirectory, "manifest.json"));
    await fs.chmod(legacyDirectory, 0o500);
    const legacyCache = new PreparedNovelCache(sourceRoot, legacyCacheRoot);
    await expect(legacyCache.lookup(fixture.source)).resolves.toMatchObject({ status: "already-cached", cachePath: legacyDirectory });
    await expect(legacyCache.publish(fixture.source)).resolves.toMatchObject({ status: "already-cached", bundleHash: published.bundleHash });
    await expect(legacyCache.listRevisions(fixture.source)).resolves.toEqual([
      expect.objectContaining({ bundleHash: published.bundleHash, active: true }),
    ]);

    const semanticLegacyRoot = await temporaryRoot("nwh-prepared-semantic-legacy-");
    const semanticLegacyBase = path.join(semanticLegacyRoot, published.contentMd5);
    const currentBundle = JSON.parse(await fs.readFile(path.join(published.cachePath, "bundle.json"), "utf8")) as Record<string, unknown>;
    delete currentBundle.compilerFingerprint;
    const legacyHash = contentHash(currentBundle);
    const semanticLegacyRevision = path.join(semanticLegacyBase, "revisions", legacyHash);
    await fs.mkdir(semanticLegacyRevision, { recursive: true });
    await fs.writeFile(path.join(semanticLegacyRevision, "bundle.json"), `${canonicalJson(currentBundle)}\n`);
    await fs.writeFile(path.join(semanticLegacyRevision, "manifest.json"), `${canonicalJson({
      version: 1,
      contentMd5: published.contentMd5,
      contentSha256: fixture.source.contentSha256,
      sourceId: fixture.source.id,
      bundleHash: legacyHash,
      createdAt: new Date(0).toISOString(),
    })}\n`);
    await fs.writeFile(path.join(semanticLegacyBase, "active.json"), `${canonicalJson({
      version: 1,
      contentMd5: published.contentMd5,
      bundleHash: legacyHash,
      updatedAt: new Date(0).toISOString(),
    })}\n`);
    await expect(new PreparedNovelCache(sourceRoot, semanticLegacyRoot).lookup(fixture.source)).resolves.toMatchObject({
      status: "miss",
      bundleHash: legacyHash,
      requiresReparse: true,
      reason: expect.stringContaining("incompatible semantic pipeline"),
    });
  });
});
