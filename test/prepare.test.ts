import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stdout } from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCommand } from "../src/commands/prepare.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { inspectPreparation } from "../src/workflow/prepare.js";
import { WorldEngine } from "../src/world/engine.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { StateSchemaRegistry, DEFAULT_STATE_FIELDS } from "../src/world/state.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { SourceMaterialStore } from "../src/storage/source-material-store.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("preparation workflow inspection", () => {
  it("derives a resumable review barrier and playable readiness from authoritative stores", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-prepare-"));
    roots.push(root);
    await expect(inspectPreparation(root)).resolves.toMatchObject({
      stage: "needs-source",
      next: "nwh prepare <novel-path>",
    });

    const fixture = await createEvidenceFixture(root, "Hero opens the gate.\n");
    const source = fixture.source;
    const batches = await prepareCompilerBatches(root, source);
    await expect(inspectPreparation(root)).resolves.toMatchObject({ stage: "compile", source: { id: source.id } });
    for (const batch of batches) await new CompilerBatchStore(root).markComplete(source.id, batch.id);
    await expect(inspectPreparation(root)).resolves.toMatchObject({ stage: "needs-initial-world" });

    await new CompilerProposalService(root).submit("entity", {
      proposalId: "entity-hero",
      payload: {
        id: "hero",
        kind: "character",
        canonicalName: "Hero",
        aliases: [],
        evidence: fixture.evidence("Hero opens the gate."),
      },
      generatedBy: { worker: "test" },
    });
    await expect(inspectPreparation(root)).resolves.toMatchObject({
      stage: "review",
      next: "nwh proposals show entity-hero",
    });
  });

  it("requires an accepted initial world, creates no branch itself, and detects an existing branch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-prepare-ready-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "The world begins quietly.\n");
    const batches = await prepareCompilerBatches(root, fixture.source);
    for (const batch of batches) await new CompilerBatchStore(root).markComplete(fixture.source.id, batch.id);
    await new InitialWorldStore(root).put({
      version: 1,
      delta: { version: 1, operations: [] },
      evidence: fixture.evidence("The world begins quietly."),
    });

    await expect(inspectPreparation(root)).resolves.toMatchObject({ stage: "create-branch", branchId: "main" });
    const engine = new WorldEngine(root, {
      entities: new Map(),
      rules: new Map(),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    });
    await engine.createBranch("main", "main");
    await expect(inspectPreparation(root)).resolves.toMatchObject({
      stage: "ready",
      next: "nwh play-world --branch main --list-characters",
    });
  });

  it("does not let another source's pending proposals block the selected source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-prepare-source-isolation-"));
    roots.push(root);
    const selected = await createEvidenceFixture(root, "Selected opening.\n", "selected.txt");
    const foreign = await createEvidenceFixture(root, "Foreign hero.\n", "foreign.txt");
    const batches = await prepareCompilerBatches(root, selected.source);
    for (const batch of batches) await new CompilerBatchStore(root).markComplete(selected.source.id, batch.id);
    await new CompilerProposalService(root).submit("entity", {
      proposalId: "foreign-hero",
      payload: {
        id: "foreign-hero",
        kind: "character",
        canonicalName: "Foreign Hero",
        aliases: [],
        evidence: foreign.evidence("Foreign hero."),
      },
      generatedBy: { worker: "test" },
    });
    await fs.writeFile(path.join(root, foreign.source.sourcePath), "Foreign source changed after ingest.\n", "utf8");

    await expect(inspectPreparation(root, { sourceId: selected.source.id })).resolves.toMatchObject({
      stage: "needs-initial-world",
      pending: [],
      audit: { sources: { registered: 1, changedSinceIngest: [] } },
    });
  });

  it("reports the selected source's concrete repair reason and scoped audit command", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-prepare-repair-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Original opening.\n", "selected.txt");
    await prepareCompilerBatches(root, fixture.source);
    const archived = path.join(new SourceMaterialStore().root, fixture.source.contentSha256);
    await fs.chmod(archived, 0o700);
    await fs.rm(archived, { recursive: true, force: true });
    await fs.writeFile(path.join(root, fixture.source.sourcePath), "Changed opening.\n", "utf8");

    await expect(inspectPreparation(root, { sourceId: fixture.source.id })).resolves.toMatchObject({
      stage: "repair",
      next: `nwh audit --source ${fixture.source.id}`,
      repairReasons: [expect.stringContaining("Archived source material")],
      audit: { sources: { registered: 1, changedSinceIngest: [fixture.source.id] } },
    });
  });

  it("the command never accepts pending proposals and only auto-creates a branch after deterministic gates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-prepare-command-"));
    roots.push(root);
    vi.spyOn(stdout, "write").mockImplementation((() => true) as typeof stdout.write);
    const fixture = await createEvidenceFixture(root, "A quiet opening.\n");
    const batches = await prepareCompilerBatches(root, fixture.source);
    for (const batch of batches) await new CompilerBatchStore(root).markComplete(fixture.source.id, batch.id);
    const proposals = new CompilerProposalService(root);
    await proposals.submit("entity", {
      proposalId: "pending-hero",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: fixture.evidence("A quiet opening.") },
      generatedBy: { worker: "test" },
    });

    const review = await prepareCommand({ root, sourceId: fixture.source.id, maxBatches: 0 });
    expect(review.stage).toBe("review");
    await expect(proposals.store.list("pending")).resolves.toEqual([
      expect.objectContaining({ id: "pending-hero" }),
    ]);

    await proposals.store.transition("pending-hero", "pending", "rejected");
    await new InitialWorldStore(root).put({
      version: 1,
      delta: { version: 1, operations: [] },
      evidence: fixture.evidence("A quiet opening."),
    });
    const ready = await prepareCommand({ root, sourceId: fixture.source.id, maxBatches: 0 });
    expect(ready.stage).toBe("ready");
    await expect(new WorldEngine(root, {
      entities: new Map(),
      rules: new Map(),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    }).branches.read("main")).resolves.toMatchObject({ id: "main" });
  });
});
