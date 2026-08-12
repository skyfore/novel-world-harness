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
