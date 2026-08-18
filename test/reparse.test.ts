import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { convergeWorldProposals } from "../src/compiler/converge.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { parseOrdinalSelection, reparseCommand } from "../src/commands/reparse.js";
import { ActorModelStore } from "../src/world/actors.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { inspectPreparation } from "../src/workflow/prepare.js";
import { canonicalJson, contentHash } from "../src/world/canonical.js";
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

describe("explicit prepared-novel reparsing", () => {
  it("reparses selected detected chapters into a new revision while old branches stay pinned", async () => {
    const root = await temporaryRoot("nwh-reparse-");
    const cacheRoot = await temporaryRoot("nwh-reparse-cache-");
    const fixture = await createEvidenceFixture(root, "# One\nHero waits.\n# Two\nVillain waits.\n");
    const batches = await prepareCompilerBatches(root, fixture.source);
    expect(batches.map((batch) => batch.chapterOrdinal)).toEqual([1, 2]);
    const proposals = new CompilerProposalService(root);
    await proposals.submit("entity", {
      proposalId: "hero-v1",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: batches[0]!.evidence },
      generatedBy: { worker: "test", compilerBatchId: batches[0]!.id },
    });
    await proposals.submit("entity", {
      proposalId: "villain-v1",
      payload: { id: "villain", kind: "character", canonicalName: "Villain", aliases: [], evidence: batches[1]!.evidence },
      generatedBy: { worker: "test", compilerBatchId: batches[1]!.id },
    });
    await proposals.submit("character-goal", {
      proposalId: "villain-goal-v1",
      payload: { id: "villain-goal", actorId: "villain", description: "Wait", priority: 0.5, requiresKnowledge: [], evidence: batches[1]!.evidence },
      generatedBy: { worker: "test", compilerBatchId: batches[1]!.id },
    });
    await proposals.submit("initial-world", {
      proposalId: "opening-v1",
      payload: { version: 1, delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] }, evidence: batches[0]!.evidence },
      generatedBy: { worker: "test", compilerBatchId: `opening-${batches[0]!.id}` },
    });
    await new CompilerBatchStore(root).replaceCompleted(fixture.source.id, batches.map((batch) => batch.id));
    await convergeWorldProposals(root, fixture.source.id);
    const cache = new PreparedNovelCache(root, cacheRoot);
    const first = await cache.publish(fixture.source);
    const initial = await new InitialWorldStore(root).get();
    if (!initial) throw new Error("missing test initial world");
    const before = await openWorkspaceWorld(root);
    const oldHead = await before.engine.createBranch("old", "old", initial.delta, initial.knowledge);
    await fs.rm(path.join(root, fixture.source.sourcePath));
    await new CanonicalModelStore(root).removeCurrent("entities", "villain");
    await new ActorModelStore(root).removeGoal("villain-goal");
    await new CompilerBatchStore(root).markIncomplete(fixture.source.id, [batches[1]!.id]);
    const progressMessages: string[] = [];

    const result = await reparseCommand({
      root,
      configPath: path.join(root, "missing.yaml"),
      sourceId: fixture.source.id,
      chapters: "2",
      cacheRoot,
      onProgress: (message) => progressMessages.push(message),
    }, {
      async compileSource(options) {
        expect(options.batchIds).toEqual([batches[1]!.id]);
        expect(options.promptTransform?.("evidence", batches[1]!)).toContain("detected chapter 2");
        await proposals.submit("entity", {
          proposalId: "villain-v2-reparse-test",
          payload: { id: "villain", kind: "character", canonicalName: "Villain", aliases: ["Villain"], evidence: batches[1]!.evidence },
          generatedBy: { worker: "test", compilerBatchId: batches[1]!.id },
        });
        await proposals.submit("character-goal", {
          proposalId: "villain-goal-v2-reparse-test",
          payload: { id: "villain-goal", actorId: "villain", description: "Act", priority: 0.8, requiresKnowledge: [], evidence: batches[1]!.evidence },
          generatedBy: { worker: "test", compilerBatchId: batches[1]!.id },
        });
        await new CompilerBatchStore(root).markComplete(fixture.source.id, batches[1]!.id);
      },
    });

    expect(result.chapters).toEqual([2]);
    expect(progressMessages).toContainEqual(expect.stringContaining("Detected an interrupted reparse"));
    expect(progressMessages).toContainEqual(expect.stringContaining("baseline restored"));
    expect(result.previousBundleHash).toBe(first.bundleHash);
    expect(result.activeBundleHash).not.toBe(first.bundleHash);
    await expect(new CanonicalModelStore(root).getEntity("hero")).resolves.toMatchObject({ aliases: [] });
    await expect(new CanonicalModelStore(root).getEntity("villain")).resolves.toMatchObject({ aliases: ["Villain"] });
    await expect(new ActorModelStore(root).listGoals("villain")).resolves.toEqual([expect.objectContaining({ description: "Act" })]);

    const reopened = await openWorkspaceWorld(root);
    const oldContext = await reopened.engine.contextForCommit(oldHead);
    expect(oldContext.entities.get("villain")?.aliases).toEqual([]);
    expect(oldContext.actorGoals?.find((goal) => goal.id === "villain-goal")?.description).toBe("Wait");
    const newHead = await reopened.engine.createBranch("new", "new", initial.delta, initial.knowledge);
    const newContext = await reopened.engine.contextForCommit(newHead);
    expect(newContext.entities.get("villain")?.aliases).toEqual(["Villain"]);
    expect(newContext.actorGoals?.find((goal) => goal.id === "villain-goal")?.description).toBe("Act");

    await cache.activate(fixture.source, first.bundleHash!);
    await expect(new CanonicalModelStore(root).getEntity("villain")).resolves.toMatchObject({ aliases: [] });
    await expect(new ActorModelStore(root).listGoals("villain")).resolves.toEqual([expect.objectContaining({ description: "Wait" })]);

    await new CompilerBatchStore(root).markIncomplete(fixture.source.id, [batches[0]!.id]);
    await expect(reparseCommand({
      root,
      configPath: path.join(root, "missing.yaml"),
      sourceId: fixture.source.id,
      chapters: "2",
      cacheRoot,
    })).rejects.toThrow("outside the selected scope (chapter(s) 1)");
  });

  it("parses ordinal selections strictly", () => {
    expect(parseOrdinalSelection("1,3-4", [1, 2, 3, 4], "--chapters")).toEqual([1, 3, 4]);
    expect(() => parseOrdinalSelection("4-2", [1, 2, 3, 4], "--chapters")).toThrow("invalid range");
    expect(() => parseOrdinalSelection("5", [1, 2, 3, 4], "--chapters")).toThrow("unavailable");
  });

  it("rebuilds the whole source and opening state, retaining the prior revision", async () => {
    const root = await temporaryRoot("nwh-reparse-all-");
    const cacheRoot = await temporaryRoot("nwh-reparse-all-cache-");
    const fixture = await createEvidenceFixture(root, "# Opening\nHero waits.\n");
    const batch = (await prepareCompilerBatches(root, fixture.source))[0]!;
    const proposals = new CompilerProposalService(root);
    await proposals.submit("entity", {
      proposalId: "hero-all-v1",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: batch.evidence },
      generatedBy: { worker: "test", compilerBatchId: batch.id },
    });
    await proposals.submit("initial-world", {
      proposalId: "opening-all-v1",
      payload: { version: 1, delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] }, evidence: batch.evidence },
      generatedBy: { worker: "test", compilerBatchId: `opening-${batch.id}` },
    });
    await new CompilerBatchStore(root).markComplete(fixture.source.id, batch.id);
    await convergeWorldProposals(root, fixture.source.id);
    const cache = new PreparedNovelCache(root, cacheRoot);
    const first = await cache.publish(fixture.source);

    const result = await reparseCommand({
      root,
      configPath: path.join(root, "missing.yaml"),
      sourceId: fixture.source.id,
      all: true,
      cacheRoot,
    }, {
      async compileSource(options) {
        expect(options.batchIds).toEqual([batch.id]);
        await proposals.submit("entity", {
          proposalId: "hero-all-v2-reparse-test",
          payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: ["Hero"], evidence: batch.evidence },
          generatedBy: { worker: "test", compilerBatchId: batch.id },
        });
        await new CompilerBatchStore(root).markComplete(fixture.source.id, batch.id);
      },
      async finishPreparation(options) {
        await convergeWorldProposals(root, fixture.source.id);
        await proposals.submit("initial-world", {
          proposalId: "opening-all-v2-reparse-test",
          payload: { version: 1, delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] }, evidence: batch.evidence },
          generatedBy: { worker: "test", compilerBatchId: `opening-${batch.id}` },
        });
        await convergeWorldProposals(root, fixture.source.id);
        await new PreparedNovelCache(root, options.cacheRoot).publish(fixture.source);
        return inspectPreparation(root, { sourceId: fixture.source.id });
      },
    });

    expect(result.previousBundleHash).toBe(first.bundleHash);
    expect(result.activeBundleHash).not.toBe(first.bundleHash);
    await expect(new CanonicalModelStore(root).getEntity("hero")).resolves.toMatchObject({ aliases: ["Hero"] });
    await expect(new InitialWorldStore(root).get()).resolves.not.toBeNull();
    const revisions = await cache.listRevisions(fixture.source);
    expect(revisions).toHaveLength(2);
    expect(revisions.find((revision) => revision.bundleHash === first.bundleHash)?.active).toBe(false);
    expect(revisions.find((revision) => revision.bundleHash === result.activeBundleHash)?.active).toBe(true);

    await expect(reparseCommand({
      root,
      configPath: path.join(root, "missing.yaml"),
      sourceId: fixture.source.id,
      chapters: "1",
      cacheRoot,
    }, {
      async compileSource() { throw new Error("simulated compiler failure"); },
    })).rejects.toThrow(`rolled back to ${result.activeBundleHash}`);
    await expect(cache.lookup(fixture.source)).resolves.toMatchObject({ bundleHash: result.activeBundleHash });
    await expect(new CanonicalModelStore(root).getEntity("hero")).resolves.toMatchObject({ aliases: ["Hero"] });
    await expect(new InitialWorldStore(root).get()).resolves.not.toBeNull();
  });

  it("keeps an incompatible active fingerprint intact when a semantic-upgrade reparse fails", async () => {
    const root = await temporaryRoot("nwh-reparse-legacy-rollback-");
    const cacheRoot = await temporaryRoot("nwh-reparse-legacy-rollback-cache-");
    const fixture = await createEvidenceFixture(root, "# Opening\nHero waits.\n");
    const batch = (await prepareCompilerBatches(root, fixture.source))[0]!;
    const proposals = new CompilerProposalService(root);
    await proposals.submit("entity", {
      proposalId: "legacy-rollback-hero",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: batch.evidence },
      generatedBy: { worker: "test", compilerBatchId: batch.id },
    });
    await proposals.submit("initial-world", {
      proposalId: "legacy-rollback-opening",
      payload: {
        version: 1,
        delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] },
        evidence: batch.evidence,
      },
      generatedBy: { worker: "test", compilerBatchId: `opening-${batch.id}` },
    });
    await new CompilerBatchStore(root).replaceCompleted(fixture.source.id, [batch.id]);
    await convergeWorldProposals(root, fixture.source.id);
    const cache = new PreparedNovelCache(root, cacheRoot);
    const current = await cache.publish(fixture.source);
    const legacyBundle = JSON.parse(await fs.readFile(path.join(current.cachePath, "bundle.json"), "utf8")) as Record<string, unknown>;
    delete legacyBundle.compilerFingerprint;
    const legacyHash = contentHash(legacyBundle);
    const cacheBase = path.join(cacheRoot, current.contentMd5);
    const legacyRevision = path.join(cacheBase, "revisions", legacyHash);
    await fs.mkdir(legacyRevision, { recursive: true });
    await fs.writeFile(path.join(legacyRevision, "bundle.json"), `${canonicalJson(legacyBundle)}\n`);
    await fs.writeFile(path.join(legacyRevision, "manifest.json"), `${canonicalJson({
      version: 1,
      contentMd5: current.contentMd5,
      contentSha256: fixture.source.contentSha256,
      sourceId: fixture.source.id,
      bundleHash: legacyHash,
      createdAt: new Date(0).toISOString(),
    })}\n`);
    await fs.writeFile(path.join(cacheBase, "active.json"), `${canonicalJson({
      version: 1,
      contentMd5: current.contentMd5,
      bundleHash: legacyHash,
      updatedAt: new Date(0).toISOString(),
    })}\n`);

    await expect(reparseCommand({
      root,
      configPath: path.join(root, "missing.yaml"),
      sourceId: fixture.source.id,
      all: true,
      cacheRoot,
    }, {
      async compileSource() { throw new Error("simulated provider failure"); },
    })).rejects.toThrow(`rolled back to ${legacyHash}`);

    await expect(cache.lookup(fixture.source)).resolves.toMatchObject({
      bundleHash: legacyHash,
      requiresReparse: true,
    });
    expect((await cache.listRevisions(fixture.source)).filter((revision) => revision.active))
      .toEqual([expect.objectContaining({ bundleHash: legacyHash })]);
  });
});
