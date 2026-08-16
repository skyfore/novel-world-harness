import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stdout } from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareAllCommand } from "../src/commands/prepare-all.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { convergeWorldProposals } from "../src/compiler/converge.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { WorldEngine } from "../src/world/engine.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import { worldCreateCommand } from "../src/commands/world.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { BranchStore } from "../src/world/store.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("prepare-all command", () => {
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

    const result = await prepareAllCommand({ root, sourceId: fixture.source.id, yes: true, cacheRoot: path.join(root, "prepared-cache") }, {
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

    const result = await prepareAllCommand({ root, sourceId: fixture.source.id, yes: true, cacheRoot: path.join(root, "prepared-cache") }, {
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
    const second = await createEvidenceFixture(root, "Second Hero waits.\n", "second-novel.txt");
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
    for (const batch of batches) await new CompilerBatchStore(root).markComplete(second.source.id, batch.id);
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

    await expect(prepareAllCommand({
      root,
      sourceId: second.source.id,
      branchId: "main",
      yes: true,
      cacheRoot: path.join(root, "prepared-cache"),
    })).rejects.toThrow("belongs to source");

    const result = await prepareAllCommand({ root, sourceId: second.source.id, yes: true, cacheRoot: path.join(root, "prepared-cache") }, {
      compileSource: async () => { throw new Error("compileSource should not run"); },
      compileInitialWorld: async () => { throw new Error("compileInitialWorld should not run"); },
      converge: convergeWorldProposals,
      createBranch: worldCreateCommand,
    });

    const expectedBranchId = `second-novel-${second.source.id.slice(0, 8)}`;
    expect(result).toMatchObject({ stage: "ready", branchId: expectedBranchId });
    await expect(new BranchStore(root).read("main")).resolves.toMatchObject({ sourceId: first.source.id });
    await expect(new BranchStore(root).read(expectedBranchId)).resolves.toMatchObject({ sourceId: second.source.id });
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

    const result = await prepareAllCommand({ root, sourceId: fixture.source.id, yes: true, cacheRoot: path.join(root, "prepared-cache") }, {
      compileSource: async () => { throw new Error("compileSource should not run"); },
      compileInitialWorld: async (options) => {
        initialCompilerCalls += 1;
        expect(options.includeLocalTools).toBe(false);
        expect(options.segmentIds).toHaveLength(1);
        expect(options.compilerBatchId).toMatch(/^opening-batch-/);
        expect(options.sourceId).toBe(fixture.source.id);
        expect(options.prompt).toContain("<source-segment");
        expect(options.prompt).toContain("The world begins quietly.");
        await new CompilerProposalService(root).submit("initial-world", {
          proposalId: "generated-initial-world",
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

  it("uses a conservative evidence-backed opening fallback when the model pass fails", async () => {
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
