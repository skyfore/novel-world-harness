import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stdout } from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareAllCommand } from "../src/commands/prepare-all.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { convergeWorldProposals } from "../src/compiler/converge.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { canonicalJson, contentHash } from "../src/world/canonical.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { WorldEngine } from "../src/world/engine.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import { worldCreateCommand } from "../src/commands/world.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { BranchStore } from "../src/world/store.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { WorkspaceStore } from "../src/storage/workspace-store.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("prepare-all command", () => {
  it("routes an incompatible prepared revision through whole-novel reparse and a fresh branch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-prepare-all-upgrade-"));
    roots.push(root);
    vi.spyOn(stdout, "write").mockImplementation((() => true) as typeof stdout.write);
    const fixture = await createEvidenceFixture(root, "Hero waits at the opening.\n");
    const cacheRoot = path.join(root, "prepared-cache");
    const batches = await prepareCompilerBatches(root, fixture.source);
    await new CompilerBatchStore(root).replaceCompleted(fixture.source.id, batches.map((batch) => batch.id));
    const proposals = new CompilerProposalService(root);
    await proposals.submit("entity", {
      proposalId: "upgrade-hero",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: fixture.evidence("Hero") },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("initial-world", {
      proposalId: "upgrade-opening",
      payload: {
        version: 1,
        delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] },
        evidence: fixture.evidence("Hero waits at the opening."),
      },
      generatedBy: { worker: "test" },
    });
    await convergeWorldProposals(root, fixture.source.id);
    const cache = new PreparedNovelCache(root, cacheRoot);
    const published = await cache.publish(fixture.source);
    await worldCreateCommand(root, "main", undefined, fixture.source.id, cacheRoot);

    const currentBundle = JSON.parse(await fs.readFile(path.join(published.cachePath, "bundle.json"), "utf8")) as Record<string, unknown>;
    delete currentBundle.compilerFingerprint;
    const legacyHash = contentHash(currentBundle);
    const cacheBase = path.join(cacheRoot, published.contentMd5);
    const legacyRevision = path.join(cacheBase, "revisions", legacyHash);
    await fs.mkdir(legacyRevision, { recursive: true });
    await fs.writeFile(path.join(legacyRevision, "bundle.json"), `${canonicalJson(currentBundle)}\n`);
    await fs.writeFile(path.join(legacyRevision, "manifest.json"), `${canonicalJson({
      version: 1,
      contentMd5: published.contentMd5,
      contentSha256: fixture.source.contentSha256,
      sourceId: fixture.source.id,
      bundleHash: legacyHash,
      createdAt: new Date(0).toISOString(),
    })}\n`);
    await fs.writeFile(path.join(cacheBase, "active.json"), `${canonicalJson({
      version: 1,
      contentMd5: published.contentMd5,
      bundleHash: legacyHash,
      updatedAt: new Date(0).toISOString(),
    })}\n`);

    let reparseCalls = 0;
    const result = await prepareAllCommand({ root, sourceId: fixture.source.id, yes: true, cacheRoot }, {
      reparse: async (options) => {
        reparseCalls += 1;
        expect(options.all).toBe(true);
        await prepareAllCommand({
          root,
          sourceId: fixture.source.id,
          yes: true,
          cacheRoot,
          createBranch: false,
          restoreCache: false,
          acquireLock: false,
          reparseBaselineBundleHash: legacyHash,
        }, {
          reparse: async () => { throw new Error("reparse finalization must not recursively reparse"); },
        });
      },
    });

    expect(reparseCalls).toBe(1);
    expect(result.stage).toBe("ready");
    expect(result.branchId).not.toBe("main");
    expect((await new BranchStore(root).read("main")).preparedRevisionHash).toBe(published.bundleHash);
    expect((await new BranchStore(root).read(result.branchId)).preparedRevisionHash).toBe(published.bundleHash);
  });

  it("lets the user stop at review without accepting pending proposals", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-prepare-all-review-"));
    roots.push(root);
    vi.spyOn(stdout, "write").mockImplementation((() => true) as typeof stdout.write);
    const fixture = await createEvidenceFixture(root, "Hero waits.\n");
    const batches = await prepareCompilerBatches(root, fixture.source);
    for (const batch of batches) await new CompilerBatchStore(root).markComplete(fixture.source.id, batch.id);
    const proposals = new CompilerProposalService(root);
    await proposals.submit("entity", {
      proposalId: "entity-review",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: fixture.evidence("Hero") },
      generatedBy: { worker: "test" },
    });
    const asked: string[] = [];

    const result = await prepareAllCommand({ root, sourceId: fixture.source.id, cacheRoot: path.join(root, "prepared-cache") }, {
      ask: async (question) => {
        asked.push(question.header);
        return "review" as never;
      },
    });

    expect(asked).toEqual(["Proposals"]);
    expect(result.stage).toBe("review");
    await expect(proposals.store.list("pending")).resolves.toEqual([
      expect.objectContaining({ id: "entity-review" }),
    ]);
  });

  it("runs every unfinished compiler batch instead of the one-batch prepare default", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-prepare-all-batches-"));
    roots.push(root);
    vi.spyOn(stdout, "write").mockImplementation((() => true) as typeof stdout.write);
    const fixture = await createEvidenceFixture(root, "The world begins quietly.\n");
    let compileCalls = 0;

    const result = await prepareAllCommand({
      root,
      sourceId: fixture.source.id,
      yes: true,
      cacheRoot: path.join(root, "prepared-cache"),
    }, {
      compileSource: async (options) => {
        compileCalls += 1;
        expect(options.maxBatches).toBeUndefined();
        const batches = await prepareCompilerBatches(root, fixture.source);
        for (const batch of batches) await new CompilerBatchStore(root).markComplete(fixture.source.id, batch.id);
        await new CanonicalModelStore(root).putEntity({
          id: "hero",
          kind: "character",
          canonicalName: "Hero",
          aliases: [],
          evidence: fixture.evidence("The world begins quietly."),
        });
        await new CompilerProposalService(root).submit("initial-world", {
          proposalId: "compiled-initial-world",
          payload: {
            version: 1,
            delta: {
              version: 1,
              operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
            },
            evidence: fixture.evidence("The world begins quietly."),
          },
          generatedBy: { worker: "test" },
        });
      },
      compileInitialWorld: async () => { throw new Error("compileInitialWorld should not run"); },
      converge: convergeWorldProposals,
      createBranch: worldCreateCommand,
    });

    expect(compileCalls).toBe(1);
    expect(result.stage).toBe("ready");
  });

  it("accepts every valid preparation proposal and creates a playable branch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-prepare-all-"));
    roots.push(root);
    vi.spyOn(stdout, "write").mockImplementation((() => true) as typeof stdout.write);
    const fixture = await createEvidenceFixture(root, "Hero waits at the opening.\n");
    const batches = await prepareCompilerBatches(root, fixture.source);
    for (const batch of batches) await new CompilerBatchStore(root).markComplete(fixture.source.id, batch.id);
    const proposals = new CompilerProposalService(root);
    await proposals.submit("entity", {
      proposalId: "entity-hero",
      payload: {
        id: "hero",
        kind: "character",
        canonicalName: "Hero",
        aliases: [],
        evidence: fixture.evidence("Hero"),
      },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("initial-world", {
      proposalId: "initial-world",
      payload: {
        version: 1,
        delta: {
          version: 1,
          operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
        },
        evidence: fixture.evidence("Hero waits at the opening."),
      },
      generatedBy: { worker: "test" },
    });

    const result = await prepareAllCommand({
      root,
      sourceId: fixture.source.id,
      yes: true,
      cacheRoot: path.join(root, "prepared-cache"),
    }, {
      compileSource: async () => { throw new Error("compileSource should not run"); },
      compileInitialWorld: async () => { throw new Error("compileInitialWorld should not run"); },
      converge: convergeWorldProposals,
      createBranch: worldCreateCommand,
    });

    expect(result.stage).toBe("ready");
    await expect(proposals.store.list("pending")).resolves.toEqual([]);
    const engine = new WorldEngine(root, {
      entities: new Map(),
      rules: new Map(),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    });
    await expect(engine.branches.read("main")).resolves.toMatchObject({ id: "main" });
  });

  it("creates a source-scoped default branch when main belongs to another novel", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-prepare-all-branch-source-"));
    roots.push(root);
    vi.spyOn(stdout, "write").mockImplementation((() => true) as typeof stdout.write);
    const first = await createEvidenceFixture(root, "First Hero waits.\n", "first-novel.txt");
    const second = await createEvidenceFixture(
      root,
      "The Second Chronicle\nAuthor: Example Writer\n\nChapter 1\nSecond Hero waits.\n",
      "second-novel.txt",
    );
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({
      id: "first-hero",
      kind: "character",
      canonicalName: "First Hero",
      aliases: [],
      evidence: first.evidence("First Hero"),
    });
    const { engine } = await openWorkspaceWorld(root);
    await engine.createBranch("main", "main", {
      version: 1,
      operations: [{ op: "set", entityId: "first-hero", field: "character.alive", value: true }],
    }, undefined, first.source.id);

    const batches = await prepareCompilerBatches(root, second.source);
    await canon.putEntity({
      id: "second-hero",
      kind: "character",
      canonicalName: "Second Hero",
      aliases: [],
      evidence: second.evidence("Second Hero"),
    });
    await new InitialWorldStore(root).put({
      version: 1,
      delta: {
        version: 1,
        operations: [{ op: "set", entityId: "second-hero", field: "character.alive", value: true }],
      },
      evidence: second.evidence("Second Hero waits."),
    });

    for (const batch of batches) await new CompilerBatchStore(root).markComplete(second.source.id, batch.id);
    await expect(prepareAllCommand({
      root,
      sourceId: second.source.id,
      branchId: "main",
      yes: true,
      cacheRoot: path.join(root, "prepared-cache"),
    })).rejects.toThrow("belongs to source");
    await new CompilerBatchStore(root).reset(second.source.id);

    const result = await prepareAllCommand({ root, sourceId: second.source.id, yes: true, cacheRoot: path.join(root, "prepared-cache") }, {
      compileSource: async () => {
        await (await WorkspaceStore.create(root)).restoreSourceTitleInference(second.source.id, {
          version: 1,
          sourceId: second.source.id,
          title: "The Second Chronicle",
          evidence: second.evidence("The Second Chronicle")[0]!,
          generatedBy: {
            worker: "propose_novel_title",
            provider: "test",
            model: "semantic-title-model",
            compilerBatchId: batches[0]!.id,
          },
          inferredAt: new Date().toISOString(),
        });
        for (const batch of batches) await new CompilerBatchStore(root).markComplete(second.source.id, batch.id);
      },
      compileInitialWorld: async () => { throw new Error("compileInitialWorld should not run"); },
      converge: convergeWorldProposals,
      createBranch: worldCreateCommand,
    });

    const expectedBranchId = `the-second-chronicle-${second.source.id.slice(0, 8)}`;
    expect(result).toMatchObject({ stage: "ready", branchId: expectedBranchId });
    await expect(new BranchStore(root).read("main")).resolves.toMatchObject({ sourceId: first.source.id });
    await expect(new BranchStore(root).read(expectedBranchId)).resolves.toMatchObject({
      name: "The Second Chronicle",
      sourceId: second.source.id,
    });
  });

  it("quarantines validation-blocked proposals and completes with validated artifacts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-prepare-all-blocked-"));
    roots.push(root);
    vi.spyOn(stdout, "write").mockImplementation((() => true) as typeof stdout.write);
    const fixture = await createEvidenceFixture(root, "Hero waits.\n");
    const batches = await prepareCompilerBatches(root, fixture.source);
    for (const batch of batches) await new CompilerBatchStore(root).markComplete(fixture.source.id, batch.id);
    await new CanonicalModelStore(root).putEntity({
      id: "playable-hero",
      kind: "character",
      canonicalName: "Playable Hero",
      aliases: [],
      evidence: fixture.evidence("Hero waits."),
    });
    const proposals = new CompilerProposalService(root);
    const invalidEvidence = fixture.evidence("Hero");
    invalidEvidence[0]!.span.quoteHash = "0".repeat(64);
    await proposals.submit("entity", {
      proposalId: "entity-invalid",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: invalidEvidence },
      generatedBy: { worker: "test" },
    });

    const result = await prepareAllCommand({ root, sourceId: fixture.source.id, yes: true, cacheRoot: path.join(root, "prepared-cache") }, {
      compileSource: async () => { throw new Error("compileSource should not run"); },
      compileInitialWorld: async () => {
        await proposals.submit("initial-world", {
          proposalId: "fallback-opening",
          payload: {
            version: 1,
            delta: { version: 1, operations: [] },
            evidence: fixture.evidence("Hero waits."),
          },
          generatedBy: { worker: "test" },
        });
      },
      converge: convergeWorldProposals,
      createBranch: worldCreateCommand,
    });
    expect(result.stage).toBe("ready");
    await expect(proposals.store.list("pending")).resolves.toEqual([]);
    await expect(proposals.store.list("rejected")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "entity-invalid" }),
      expect.objectContaining({ id: "fallback-opening" }),
    ]));
  });

  it("requests and accepts an initial world when source batches did not produce one", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-prepare-all-initial-"));
    roots.push(root);
    vi.spyOn(stdout, "write").mockImplementation((() => true) as typeof stdout.write);
    const fixture = await createEvidenceFixture(root, "The world begins quietly.\n");
    const batches = await prepareCompilerBatches(root, fixture.source);
    for (const batch of batches) await new CompilerBatchStore(root).markComplete(fixture.source.id, batch.id);
    await new CanonicalModelStore(root).putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: fixture.evidence("The world begins quietly."),
    });
    let initialCompilerCalls = 0;

    const result = await prepareAllCommand({
      root,
      sourceId: fixture.source.id,
      yes: true,
      cacheRoot: path.join(root, "prepared-cache"),
      reparseRunId: "repair-test-run",
    }, {
      compileSource: async () => { throw new Error("compileSource should not run"); },
      compileInitialWorld: async (options) => {
        initialCompilerCalls += 1;
        expect(options.includeLocalTools).toBe(false);
        expect(options.segmentIds).toHaveLength(1);
        expect(options.compilerBatchId).toMatch(/^opening-batch-/);
        expect(options.sourceId).toBe(fixture.source.id);
        expect(options.prompt).toContain("<source-segment");
        expect(options.prompt).toContain("The world begins quietly.");
        expect(options.prompt).toContain("one explicit world-time cut");
        expect(options.prompt).toContain("Later discourse may establish a pre-checkpoint fact");
        expect(options.prompt).toContain("never counterpart character IDs");
        expect(options.prompt).toContain("Every proposal envelope ID in this pass must end with -repair-test-run");
        await new CompilerProposalService(root).submit("initial-world", {
          proposalId: "generated-initial-world-repair-test-run",
          payload: {
            version: 1,
            delta: { version: 1, operations: [] },
            evidence: fixture.evidence("The world begins quietly."),
          },
          generatedBy: { worker: "test" },
        });
      },
      converge: convergeWorldProposals,
      createBranch: worldCreateCommand,
    });

    expect(initialCompilerCalls).toBe(1);
    expect(result.stage).toBe("ready");
  });

  it("establishes the opening checkpoint before routing novel-scale semantic repair", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-prepare-all-opening-first-"));
    roots.push(root);
    vi.spyOn(stdout, "write").mockImplementation((() => true) as typeof stdout.write);
    const fixture = await createEvidenceFixture(root, "Hero waits while a long sequence unfolds.\n");
    const batches = await prepareCompilerBatches(root, fixture.source);
    await new CompilerBatchStore(root).replaceCompleted(fixture.source.id, batches.map((batch) => batch.id));
    const canon = new CanonicalModelStore(root);
    const evidence = fixture.evidence("Hero waits while a long sequence unfolds.");
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence });
    for (let index = 1; index <= 20; index += 1) {
      await canon.putEvent({
        id: `opening-first-${index}`,
        title: `Story beat ${index}`,
        readerSummary: `Hero experiences story beat ${index}.`,
        participants: ["hero"],
        participantPresence: [{ entityId: "hero", mode: "physical" }],
        storyTime: { kind: "ordinal", label: `beat ${index}`, orderHint: index },
        narrativeContext: { layerId: "main", discourseOrder: index, mode: "scene" },
        preconditions: [],
        observedOutcome: {
          version: 1,
          operations: [{ op: "set", entityId: "hero", field: "character.momentum", value: index }],
        },
        evidence,
        causalParents: index === 1 ? [] : [`opening-first-${index - 1}`],
        confidence: 1,
      });
    }
    let openingCalls = 0;

    await expect(prepareAllCommand({
      root,
      sourceId: fixture.source.id,
      yes: true,
      cacheRoot: path.join(root, "prepared-cache"),
    }, {
      compileInitialWorld: async (options) => {
        openingCalls += 1;
        expect(options.prompt).toContain("one explicit world-time cut");
        await new CompilerProposalService(root).submit("initial-world", {
          proposalId: "opening-before-semantic-repair",
          payload: {
            version: 1,
            readerSetup: "Hero waits at the opening while the first unresolved story pressure gathers.",
            participantPresence: [{ entityId: "hero", mode: "physical" }],
            checkpoint: { mode: "chronological", rationale: "The source begins with Hero waiting." },
            delta: {
              version: 1,
              operations: [
                { op: "set", entityId: "hero", field: "character.alive", value: true },
                { op: "set", entityId: "hero", field: "character.plan", value: "wait and observe" },
              ],
            },
            evidence,
          },
          generatedBy: { worker: "test", compilerBatchId: options.compilerBatchId },
        });
      },
    })).rejects.toThrow("Automatic preparation stopped at 'repair'");

    expect(openingCalls).toBe(1);
    await expect(new InitialWorldStore(root).get()).resolves.toMatchObject({
      participantPresence: [{ entityId: "hero", mode: "physical" }],
    });
  });

  it("replaces a cached front-matter opening with a narrative-opening revision", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-prepare-all-opening-replacement-"));
    roots.push(root);
    vi.spyOn(stdout, "write").mockImplementation((() => true) as typeof stdout.write);
    const fixture = await createEvidenceFixture(root, [
      "# Collected edition",
      "Publication metadata.",
      "",
      "# Preface",
      "The author discusses writing.",
      "",
      "# Chapter 1",
      "Hero waits at the village gate.",
    ].join("\n"));
    const batches = await prepareCompilerBatches(root, fixture.source);
    for (const batch of batches) await new CompilerBatchStore(root).markComplete(fixture.source.id, batch.id);
    await new CanonicalModelStore(root).putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: batches[2]!.evidence,
    });
    await new InitialWorldStore(root).put({
      version: 1,
      delta: { version: 1, operations: [] },
      evidence: batches[1]!.evidence,
    });

    const result = await prepareAllCommand({ root, sourceId: fixture.source.id, yes: true, cacheRoot: path.join(root, "prepared-cache") }, {
      compileSource: async () => { throw new Error("compileSource should not run"); },
      compileInitialWorld: async (options) => {
        expect(options.prompt).toContain("Hero waits at the village gate.");
        expect(options.prompt).not.toContain("The author discusses writing.");
        await new CompilerProposalService(root).submit("initial-world", {
          proposalId: "replacement-initial-world",
          payload: {
            version: 1,
            delta: { version: 1, operations: [] },
            evidence: batches[2]!.evidence,
          },
          generatedBy: { worker: "test", compilerBatchId: options.compilerBatchId },
        });
      },
      converge: convergeWorldProposals,
      createBranch: worldCreateCommand,
    });

    expect(result.stage).toBe("ready");
    await expect(new InitialWorldStore(root).get()).resolves.toMatchObject({
      evidence: [expect.objectContaining({ span: expect.objectContaining({ startLine: 7 }) })],
    });
  });

  it("uses the restricted single-character opening fallback when the model pass fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-prepare-all-initial-fallback-"));
    roots.push(root);
    vi.spyOn(stdout, "write").mockImplementation((() => true) as typeof stdout.write);
    const fixture = await createEvidenceFixture(root, "The world begins quietly.\n");
    const batches = await prepareCompilerBatches(root, fixture.source);
    for (const batch of batches) await new CompilerBatchStore(root).markComplete(fixture.source.id, batch.id);
    await new CanonicalModelStore(root).putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: fixture.evidence("The world begins quietly."),
    });

    const result = await prepareAllCommand({ root, sourceId: fixture.source.id, yes: true, cacheRoot: path.join(root, "prepared-cache") }, {
      compileSource: async () => { throw new Error("compileSource should not run"); },
      compileInitialWorld: async (options) => {
        await new CompilerProposalService(root).submit("initial-world", {
          proposalId: "partial-model-opening",
          payload: {
            version: 1,
            delta: { version: 1, operations: [] },
            evidence: fixture.evidence("The world begins quietly."),
          },
          generatedBy: { worker: "test", compilerBatchId: options.compilerBatchId },
        });
        throw new Error("provider unavailable");
      },
      converge: convergeWorldProposals,
      createBranch: worldCreateCommand,
    });

    expect(result.stage).toBe("ready");
    await expect(new InitialWorldStore(root).get()).resolves.toMatchObject({
      delta: { operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] },
      evidence: [expect.objectContaining({ span: expect.objectContaining({ sourceId: fixture.source.id }) })],
    });
    await expect(new CompilerProposalService(root).store.list("rejected")).resolves.toContainEqual(
      expect.objectContaining({ id: "partial-model-opening" }),
    );
  });

  it("rejects unattended execution unless --yes is explicit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-prepare-all-nontty-"));
    roots.push(root);
    vi.spyOn(stdout, "write").mockImplementation((() => true) as typeof stdout.write);
    const fixture = await createEvidenceFixture(root, "The world begins quietly.\n");

    await expect(prepareAllCommand({ root, sourceId: fixture.source.id, cacheRoot: path.join(root, "prepared-cache") }))
      .rejects.toThrow("Re-run with --yes");
  });
});
