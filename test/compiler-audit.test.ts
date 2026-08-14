import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditCompiler } from "../src/compiler/audit.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { SegmentStore, segmentSource } from "../src/compiler/segments.js";
import { CompilerCommitService } from "../src/compiler/validator.js";
import { WorkspaceStore } from "../src/storage/workspace-store.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("compiler audit", () => {
  it("reports verified inventory without inventing unknown semantic coverage", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-audit-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "# Chapter 1\nHero appears.\n");
    const workspace = await WorkspaceStore.create(root);
    const source = await workspace.getSource(fixture.source.id);
    const manifest = await segmentSource(root, source!);
    await new SegmentStore(root).write(manifest);

    const proposals = new CompilerProposalService(root);
    const commits = new CompilerCommitService(root);
    await proposals.submit("entity", {
      proposalId: "hero",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: fixture.evidence("Hero appears.") },
      generatedBy: { worker: "test" },
    });
    expect((await commits.accept("entity", "hero")).accepted).toBe(true);

    const report = await auditCompiler(root);
    expect(report.sources.registered).toBe(1);
    expect(report.sources.segmented).toBe(1);
    expect(report.canonical.entities).toBe(1);
    expect(report.evidence.invalidReferences).toBe(0);
    expect(report.evidence.validBindingRatio).toBe(1);
    expect(report.coverage.entityResolution).toBeNull();
    expect(report.coverage.majorEventResolution).toBeNull();
    expect(report.coverage.epistemicCoverage).toBeNull();
  });

  it("can audit one source without inheriting another source's changed file or artifacts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-audit-source-"));
    roots.push(root);
    const selected = await createEvidenceFixture(root, "Selected hero appears.\n", "selected.txt");
    const foreign = await createEvidenceFixture(root, "Foreign hero appears.\n", "foreign.txt");
    const proposals = new CompilerProposalService(root);
    const commits = new CompilerCommitService(root);
    await proposals.submit("entity", {
      proposalId: "selected-hero",
      payload: { id: "selected-hero", kind: "character", canonicalName: "Selected Hero", aliases: [], evidence: selected.evidence("Selected hero appears.") },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("entity", {
      proposalId: "foreign-hero",
      payload: { id: "foreign-hero", kind: "character", canonicalName: "Foreign Hero", aliases: [], evidence: foreign.evidence("Foreign hero appears.") },
      generatedBy: { worker: "test" },
    });
    expect((await commits.accept("entity", "selected-hero")).accepted).toBe(true);
    expect((await commits.accept("entity", "foreign-hero")).accepted).toBe(true);
    await fs.writeFile(path.join(root, foreign.source.sourcePath), "Foreign source changed.\n", "utf8");

    const report = await auditCompiler(root, { sourceId: selected.source.id });
    expect(report.sources).toMatchObject({ registered: 1, changedSinceIngest: [] });
    expect(report.canonical.entities).toBe(1);
    expect(report.evidence.invalidReferences).toBe(0);
    expect(report.notes[0]).toContain(`scoped to source ${selected.source.id}`);
  });
});
