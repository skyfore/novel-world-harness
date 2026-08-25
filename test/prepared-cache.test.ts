import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { BoundaryCalibrationStore } from "../src/compiler/boundary-calibration.js";
import { convergeWorldProposals } from "../src/compiler/converge.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { canonicalJson, contentHash } from "../src/world/canonical.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { ChapterSplitPlanStore, evaluateChapterSplitPlan } from "../src/compiler/chapter-split.js";
import { WorkspaceStore } from "../src/storage/workspace-store.js";
import { ActorModelStore } from "../src/world/actors.js";

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
  it("refuses to publish controlled character semantics without exact per-item evidence", async () => {
    const cacheRoot = await temporaryRoot("nwh-prepared-character-evidence-cache-");
    const sourceRoot = await temporaryRoot("nwh-prepared-character-evidence-source-");
    const fixture = await createEvidenceFixture(sourceRoot, "Hero waits and carefully weighs the danger.\n");
    const evidence = fixture.evidence("Hero waits and carefully weighs the danger.");
    await new CanonicalModelStore(sourceRoot).putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence,
    });
    await new InitialWorldStore(sourceRoot).put({
      version: 1,
      delta: {
        version: 1,
        operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
      },
      evidence,
    });
    await new ActorModelStore(sourceRoot).putModel({
      actorId: "hero",
      ontologyVersion: "character-v1",
      traits: {},
      decisionBiases: {},
      dispositions: [{
        id: "hero-deliberates",
        actorId: "hero",
        dimensionId: "deliberation",
        value: 0.8,
        scope: { kind: "global" },
        stability: "stable",
        basis: "explicit-characterization",
        status: "supported",
        confidence: 0.9,
        evidence,
      }],
      evidence,
    });
    const batches = await prepareCompilerBatches(sourceRoot, fixture.source);
    await new CompilerBatchStore(sourceRoot).replaceCompleted(
      fixture.source.id,
      batches.map((batch) => batch.id),
    );

    await expect(new PreparedNovelCache(sourceRoot, cacheRoot).publish(fixture.source))
      .rejects.toThrow("has no exact evidence binding");
  });

  it("restores accepted model-inferred title metadata across different upload filenames", async () => {
    const cacheRoot = await temporaryRoot("nwh-prepared-title-cache-");
    const sourceRoot = await temporaryRoot("nwh-prepared-title-source-");
    const content = "The Hidden City\n\nHero waits at the opening.\n";
    const fixture = await createEvidenceFixture(sourceRoot, content, "publisher-upload.txt");
    await (await WorkspaceStore.create(sourceRoot)).restoreSourceTitleInference(fixture.source.id, {
      version: 1,
      sourceId: fixture.source.id,
      title: "The Hidden City",
      evidence: fixture.evidence("The Hidden City")[0]!,
      generatedBy: {
        worker: "propose_novel_title",
        provider: "test",
        model: "semantic-title-model",
        compilerBatchId: `batch-${fixture.source.id}-00001-title`,
      },
      inferredAt: new Date().toISOString(),
    });
    const proposals = new CompilerProposalService(sourceRoot);
    await proposals.submit("entity", {
      proposalId: "title-cache-hero",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: fixture.evidence("Hero") },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("initial-world", {
      proposalId: "title-cache-opening",
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
    const published = await new PreparedNovelCache(sourceRoot, cacheRoot).publish(fixture.source);
    const bundle = JSON.parse(await fs.readFile(path.join(published.cachePath, "bundle.json"), "utf8")) as {
      source: { titleInference?: { title: string } };
    };
    expect(bundle.source.titleInference?.title).toBe("The Hidden City");

    const restoredRoot = await temporaryRoot("nwh-prepared-title-restored-");
    const restoredFixture = await createEvidenceFixture(restoredRoot, content, "opaque-mirror-name.md");
    expect(restoredFixture.source.title).toBe("opaque-mirror-name.md");
    await expect(new PreparedNovelCache(restoredRoot, cacheRoot).restore(restoredFixture.source))
      .resolves.toMatchObject({ status: "restored", bundleHash: published.bundleHash });
    await expect((await WorkspaceStore.create(restoredRoot)).getSource(restoredFixture.source.id)).resolves.toMatchObject({
      title: "The Hidden City",
      titleInference: { title: "The Hidden City", generatedBy: { model: "semantic-title-model" } },
      sourcePath: "opaque-mirror-name.md",
    });
  });

  it("restores the validated chapter split plan with its deterministic batch layout", async () => {
    const cacheRoot = await temporaryRoot("nwh-prepared-chapter-split-cache-");
    const sourceRoot = await temporaryRoot("nwh-prepared-chapter-split-source-");
    const content = ":: 1 :: Opening\nAlice waits.\n\n:: 2 :: Next\nAlice leaves.\n";
    const fixture = await createEvidenceFixture(sourceRoot, content);
    const evaluation = await evaluateChapterSplitPlan(sourceRoot, fixture.source, {
      mode: "custom",
      rule: {
        prefix: ":: ",
        numberStyle: "arabic",
        suffix: " ::",
        caseSensitive: true,
        allowLeadingWhitespace: false,
        allowTrailingText: true,
      },
      examples: [
        { line: 1, text: ":: 1 :: Opening" },
        { line: 4, text: ":: 2 :: Next" },
      ],
      reason: "Two exact author headings establish the split form.",
    }, { compilerBatchId: `structure-${fixture.source.id}-v1`, provider: "test", model: "split" });
    await new ChapterSplitPlanStore(sourceRoot).write(evaluation.plan);

    const proposals = new CompilerProposalService(sourceRoot);
    await proposals.submit("entity", {
      proposalId: "split-alice",
      payload: { id: "alice", kind: "character", canonicalName: "Alice", aliases: [], evidence: fixture.evidence("Alice") },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("initial-world", {
      proposalId: "split-opening",
      payload: {
        version: 1,
        delta: { version: 1, operations: [{ op: "set", entityId: "alice", field: "character.alive", value: true }] },
        evidence: fixture.evidence("Alice waits."),
      },
      generatedBy: { worker: "test" },
    });
    const sourceBatches = await prepareCompilerBatches(sourceRoot, fixture.source);
    expect(sourceBatches.map((batch) => batch.purpose)).toEqual([
      "structure-discovery",
      "source-review",
      "source-review",
    ]);
    await new CompilerBatchStore(sourceRoot).replaceCompleted(fixture.source.id, sourceBatches.map((batch) => batch.id));
    await convergeWorldProposals(sourceRoot, fixture.source.id);
    const published = await new PreparedNovelCache(sourceRoot, cacheRoot).publish(fixture.source);

    const restoredRoot = await temporaryRoot("nwh-prepared-chapter-split-restored-");
    const restoredFixture = await createEvidenceFixture(restoredRoot, content);
    await expect(new ChapterSplitPlanStore(restoredRoot).read(restoredFixture.source.id)).resolves.toBeNull();
    await expect(new PreparedNovelCache(restoredRoot, cacheRoot).restore(restoredFixture.source))
      .resolves.toMatchObject({ status: "restored", bundleHash: published.bundleHash });
    await expect(new ChapterSplitPlanStore(restoredRoot).read(restoredFixture.source.id)).resolves.toMatchObject({
      mode: "custom",
      rule: { prefix: ":: ", suffix: " ::" },
    });
    const restoredBatches = await prepareCompilerBatches(restoredRoot, restoredFixture.source);
    expect(restoredBatches.map((batch) => batch.id)).toEqual(sourceBatches.map((batch) => batch.id));
    await expect(new CompilerBatchStore(restoredRoot).read(restoredFixture.source.id)).resolves.toMatchObject({
      completedBatchIds: sourceBatches.map((batch) => batch.id).sort(),
    });
  });

  it("stores only deterministic source batches after a transient boundary calibration", async () => {
    const cacheRoot = await temporaryRoot("nwh-prepared-boundary-cache-");
    const sourceRoot = await temporaryRoot("nwh-prepared-boundary-source-");
    const content = "Chapter 1\nAlice raises the key and\n\nChapter 2\nopens the gate.\n";
    const fixture = await createEvidenceFixture(sourceRoot, content);
    const regular = await prepareCompilerBatches(sourceRoot, fixture.source);
    expect(regular).toHaveLength(2);
    await new BoundaryCalibrationStore(sourceRoot).request({
      sourceId: fixture.source.id,
      leftSegmentId: regular[0]!.segmentIds[0]!,
      rightSegmentId: regular[1]!.segmentIds[0]!,
      requestedByBatchId: regular[0]!.id,
      requestedBySegmentId: regular[0]!.segmentIds[0]!,
      direction: "next",
      reason: "The action crosses the split.",
    });
    const withCalibration = await prepareCompilerBatches(sourceRoot, fixture.source);
    expect(withCalibration.map((batch) => batch.purpose)).toEqual([
      "source-review",
      "source-review",
      "boundary-calibration",
    ]);

    const proposals = new CompilerProposalService(sourceRoot);
    await proposals.submit("entity", {
      proposalId: "boundary-alice",
      payload: { id: "alice", kind: "character", canonicalName: "Alice", aliases: [], evidence: fixture.evidence("Alice") },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("initial-world", {
      proposalId: "boundary-opening",
      payload: {
        version: 1,
        delta: { version: 1, operations: [{ op: "set", entityId: "alice", field: "character.alive", value: true }] },
        evidence: fixture.evidence("Alice raises the key"),
      },
      generatedBy: { worker: "test" },
    });
    await new CompilerBatchStore(sourceRoot).replaceCompleted(
      fixture.source.id,
      withCalibration.map((batch) => batch.id),
    );
    await convergeWorldProposals(sourceRoot, fixture.source.id);
    const published = await new PreparedNovelCache(sourceRoot, cacheRoot).publish(fixture.source);
    const bundle = JSON.parse(await fs.readFile(path.join(published.cachePath, "bundle.json"), "utf8")) as { batchIds: string[] };
    expect(bundle.batchIds).toEqual(regular.map((batch) => batch.id).sort());

    const restoredRoot = await temporaryRoot("nwh-prepared-boundary-restored-");
    const restoredFixture = await createEvidenceFixture(restoredRoot, content);
    await expect(new PreparedNovelCache(restoredRoot, cacheRoot).restore(restoredFixture.source))
      .resolves.toMatchObject({ status: "restored", bundleHash: published.bundleHash });
  });

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
    const legacyCanonical = currentBundle.canonical as Record<string, unknown>;
    delete legacyCanonical.propositions;
    delete legacyCanonical.attributions;
    delete legacyCanonical.eventParticipations;
    delete legacyCanonical.eventRelations;
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
