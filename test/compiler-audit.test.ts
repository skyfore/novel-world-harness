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
});

