import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stdout } from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCommand } from "../src/commands/prepare.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { inspectPreparation, novelScalePublicationRepairReasons } from "../src/workflow/prepare.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { BranchStore } from "../src/world/store.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { SourceMaterialStore } from "../src/storage/source-material-store.js";
import { NOVEL_SCALE_SOURCE_BYTE_THRESHOLD } from "../src/compiler/scale.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("preparation workflow inspection", () => {
  it("requires all traceability dimensions before novel-scale publication", () => {
    const blocked = novelScalePublicationRepairReasons({
      canonical: { events: 20 },
      readiness: {
        evidence: "unknown",
        accounting: "not-ready",
        resolution: "ready",
        blockingIssues: ["missing exact binding", "unaccounted sentence"],
      },
      observations: { unaccountedUnits: 17, blockingUnits: 2 },
      resolutions: { missing: 1, ambiguous: 0, unresolved: 0 },
      eventResolutions: { missing: 2, ambiguous: 1, unresolved: 0 },
    });
    expect(blocked).toEqual([
      expect.stringContaining("exact evidence=unknown"),
      "missing exact binding",
      "unaccounted sentence",
    ]);
    expect(blocked[0]).toContain("source accounting=not-ready (17 unaccounted, 2 blocking unit(s))");
    expect(blocked[0]).toContain("identity/event resolution=ready (3 missing, 1 ambiguous/unresolved mention(s))");

    expect(novelScalePublicationRepairReasons({
      canonical: { events: 19 },
      readiness: { evidence: "unknown", accounting: "unknown", resolution: "unknown", blockingIssues: [] },
      observations: { unaccountedUnits: 999, blockingUnits: 999 },
      resolutions: { missing: 0, ambiguous: 0, unresolved: 0 },
      eventResolutions: { missing: 0, ambiguous: 0, unresolved: 0 },
    })).toEqual([]);
    expect(novelScalePublicationRepairReasons({
      sources: { bytes: NOVEL_SCALE_SOURCE_BYTE_THRESHOLD },
      canonical: { events: 1 },
      readiness: { evidence: "unknown", accounting: "unknown", resolution: "unknown", blockingIssues: [] },
      observations: { unaccountedUnits: 999, blockingUnits: 999 },
      resolutions: { missing: 0, ambiguous: 0, unresolved: 0 },
      eventResolutions: { missing: 0, ambiguous: 0, unresolved: 0 },
    })).toEqual([expect.stringContaining("Novel-scale publication requires")]);
    expect(novelScalePublicationRepairReasons({
      canonical: { events: 20 },
      readiness: { evidence: "ready", accounting: "ready", resolution: "ready", blockingIssues: [] },
      observations: { unaccountedUnits: 0, blockingUnits: 0 },
      resolutions: { missing: 0, ambiguous: 0, unresolved: 0 },
      eventResolutions: { missing: 0, ambiguous: 0, unresolved: 0 },
    })).toEqual([]);
  });

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

  it("requires a committed source character before creating a playable branch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-prepare-ready-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "The world begins quietly.\n");
    const batches = await prepareCompilerBatches(root, fixture.source);
    for (const batch of batches) await new CompilerBatchStore(root).markComplete(fixture.source.id, batch.id);
    const initial = new InitialWorldStore(root);
    await initial.put({
      version: 1,
      delta: { version: 1, operations: [] },
      evidence: fixture.evidence("The world begins quietly."),
    });

    await expect(inspectPreparation(root)).resolves.toMatchObject({
      stage: "repair",
      branchId: "main",
      repairReasons: [expect.stringContaining("No committed character entities")],
    });

    await new CanonicalModelStore(root).putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: fixture.evidence("The world begins quietly."),
    });
    await initial.put({
      version: 1,
      delta: {
        version: 1,
        operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
      },
      evidence: fixture.evidence("The world begins quietly."),
    });

    await expect(inspectPreparation(root)).resolves.toMatchObject({ stage: "create-branch", branchId: "main" });
    const { engine } = await openWorkspaceWorld(root);
    const opening = await initial.get();
    await engine.createBranch("main", "main", opening!.delta, opening?.knowledge);
    await expect(inspectPreparation(root)).resolves.toMatchObject({
      stage: "ready",
      next: "nwh characters --branch main",
    });
  });

  it("requires replacement when an accepted initial world is grounded in front matter", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-prepare-front-matter-"));
    roots.push(root);
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

    await expect(inspectPreparation(root, { sourceId: fixture.source.id })).resolves.toMatchObject({
      stage: "needs-initial-world",
      repairReasons: [expect.stringContaining("grounded outside the selected narrative opening")],
      next: "nwh compile \"Propose an evidence-backed replacement initial world for the opening state\"",
    });
  });

  it("keeps a playable first-chapter checkpoint when a non-actionable prologue precedes it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-prepare-prologue-opening-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, [
      "# Prologue",
      "A dream passes in darkness.",
      "",
      "# Chapter 1",
      "Hero wakes at home and decides to leave.",
    ].join("\n"));
    const batches = await prepareCompilerBatches(root, fixture.source);
    for (const batch of batches) await new CompilerBatchStore(root).markComplete(fixture.source.id, batch.id);
    const firstChapter = batches.find((batch) => batch.startLine === 4)!;
    await new CanonicalModelStore(root).putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: firstChapter.evidence,
    });
    await new InitialWorldStore(root).put({
      version: 1,
      participantPresence: [{ entityId: "hero", mode: "physical" }],
      delta: {
        version: 1,
        operations: [
          { op: "set", entityId: "hero", field: "character.alive", value: true },
          { op: "set", entityId: "hero", field: "character.location", value: "home" },
        ],
      },
      checkpoint: { mode: "chronological", narrativeLayerId: "main", rationale: "First actionable scene." },
      evidence: firstChapter.evidence,
    });

    await expect(inspectPreparation(root, { sourceId: fixture.source.id })).resolves.not.toMatchObject({
      stage: "needs-initial-world",
    });
  });

  it("detects a legacy genesis whose pinned snapshot contains no playable source character", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-prepare-legacy-branch-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero waits.\n");
    const batches = await prepareCompilerBatches(root, fixture.source);
    for (const batch of batches) await new CompilerBatchStore(root).markComplete(fixture.source.id, batch.id);

    // Simulate a branch produced by the old preparation path: its persisted
    // canonical snapshot contains no characters even though current canon is later repaired.
    const { engine: legacy } = await openWorkspaceWorld(root);
    await legacy.createBranch("legacy", "legacy");

    await new CanonicalModelStore(root).putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: fixture.evidence("Hero waits."),
    });
    await new InitialWorldStore(root).put({
      version: 1,
      delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] },
      evidence: fixture.evidence("Hero waits."),
    });

    await expect(inspectPreparation(root, { sourceId: fixture.source.id, branchId: "legacy" })).resolves.toMatchObject({
      stage: "repair",
      repairReasons: [expect.stringContaining("pinned genesis snapshot")],
      next: `nwh prepare --source ${fixture.source.id} --branch <new-branch-id>`,
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

  it("the command never accepts pending proposals and refuses an unplayable auto-created branch", async () => {
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
    const blocked = await prepareCommand({ root, sourceId: fixture.source.id, maxBatches: 0 });
    expect(blocked.stage).toBe("repair");
    expect(blocked.repairReasons).toContainEqual(expect.stringContaining("No committed character entities"));
    await expect(new BranchStore(root).read("main")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
