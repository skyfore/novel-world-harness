import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditCompiler } from "../src/compiler/audit.js";
import { prepareCompilerBatches } from "../src/compiler/batches.js";
import { EvidenceVerifier } from "../src/compiler/evidence.js";
import { SegmentStore } from "../src/compiler/segments.js";
import { SourceAccountingStore } from "../src/compiler/source-accounting.js";
import {
  SourceStructureStore,
  baseStructuralUnits,
  discourseSegmentSchema,
  materializeSourceStructure,
} from "../src/compiler/structure.js";
import { resolveTextAnchor } from "../src/compiler/text-anchors.js";
import { evidenceAssertionSchema } from "../src/world/model.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("source observation structure and accounting", () => {
  it("materializes a stable paragraph/sentence/non-scene tree whose leaves partition every source byte", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-source-structure-"));
    roots.push(root);
    const content = "第一句。第二句！\n续行没有句号\n\nPrice is 3.14. Done?\n";
    const fixture = await createEvidenceFixture(root, content);
    const first = await materializeSourceStructure(root, fixture.source);
    const second = await materializeSourceStructure(root, fixture.source);
    const base = baseStructuralUnits(first);

    expect(first.units[0]).toMatchObject({ kind: "work" });
    expect(first.units[0]).not.toHaveProperty("parentId");
    expect(first.units.some((unit) => unit.kind === "paragraph")).toBe(true);
    expect(base.some((unit) => unit.kind === "non-scene")).toBe(true);
    expect(base.filter((unit) => unit.kind === "sentence")).toHaveLength(5);
    expect(second.units).toEqual(first.units);
    expect(second.baseUnitIds).toEqual(first.baseUnitIds);
    let cursor = 0;
    for (const unit of base) {
      expect(unit.anchor.startByte).toBe(cursor);
      cursor = unit.anchor.endByte;
      await expect(new EvidenceVerifier(root).inspectAnchor(unit.anchor))
        .resolves.toMatchObject({ valid: true, issues: [] });
    }
    expect(cursor).toBe(Buffer.byteLength(content, "utf8"));
  });

  it("allows overlapping discourse observations without changing structural source order", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-discourse-overlap-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero remembers the fire. He wakes.\n");
    const structure = await materializeSourceStructure(root, fixture.source);
    const sentences = baseStructuralUnits(structure).filter((unit) => unit.kind === "sentence");

    const memory = discourseSegmentSchema.parse({
      version: 1,
      id: "discourse-memory",
      sourceId: fixture.source.id,
      kind: "recollection",
      anchors: [sentences[0]!.anchor],
      evidenceAssertionIds: [],
      proposedBy: "model",
      confidence: 0.9,
    });
    const frame = discourseSegmentSchema.parse({
      version: 1,
      id: "discourse-frame",
      sourceId: fixture.source.id,
      kind: "frame",
      anchors: [structure.units[0]!.anchor],
      evidenceAssertionIds: [],
      proposedBy: "model",
      confidence: 0.8,
    });

    expect(memory.anchors[0]!.startByte).toBeGreaterThanOrEqual(frame.anchors[0]!.startByte);
    expect(memory.anchors[0]!.endByte).toBeLessThanOrEqual(frame.anchors[0]!.endByte);
    expect(baseStructuralUnits(structure).map((unit) => unit.anchor.startByte))
      .toEqual([...baseStructuralUnits(structure)].map((unit) => unit.anchor.startByte).sort((a, b) => a - b));
  });

  it("reports reviewed-but-unbound units, then becomes ready when exact observations cover them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-source-accounting-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero enters.\n\nRain falls.\n");
    await prepareCompilerBatches(root, fixture.source);
    const structure = await new SourceStructureStore(root).read(fixture.source.id);
    const segment = (await new SegmentStore(root).list(fixture.source.id))[0]!;
    const heroAnchor = await resolveTextAnchor(root, segment, {
      segment_id: segment.id,
      exact: "Hero enters.",
      target_path: "/canonicalName",
      relation: "supports",
      strength: "explicit",
    });
    const rainAnchor = await resolveTextAnchor(root, segment, {
      segment_id: segment.id,
      exact: "Rain falls.",
      target_path: "/kind",
      relation: "supports",
      strength: "explicit",
    });
    const heroEvidence = evidenceAssertionSchema.parse({
      version: 1,
      id: "evidence-hero-enters",
      target: { artifactKind: "entity", artifactId: "hero", jsonPointer: "/canonicalName" },
      anchors: [heroAnchor],
      relation: "supports",
      strength: "explicit",
      derivation: { runId: "accounting-test", worker: "test", ontologyVersion: "evidence-v1" },
    });
    const accounting = new SourceAccountingStore(root);
    await accounting.recordBatchReview({
      source: fixture.source,
      structure: structure!,
      batchId: "batch-accounting-test",
      reviews: [{ segment, disposition: "proposed", summary: "Hero was represented; rain needs observation." }],
      evidenceAssertions: [heroEvidence],
    });

    await expect(accounting.summarize(structure!)).resolves.toMatchObject({
      totalUnits: 3,
      accountedUnits: 3,
      unaccountedUnits: 0,
      blockingUnits: 1,
      unitCoverage: 1,
      byteCoverage: 1,
      statusCounts: { represented: 1, "background-only": 1, unresolved: 1 },
    });
    expect((await auditCompiler(root, { sourceId: fixture.source.id })).readiness.accounting).toBe("not-ready");

    await accounting.recordBatchReview({
      source: fixture.source,
      structure: structure!,
      batchId: "batch-accounting-test",
      reviews: [{ segment, disposition: "proposed", summary: "Both semantic sentences now have exact observations." }],
      evidenceAssertions: [heroEvidence],
      annotations: [{ id: "observation-rain", anchors: [rainAnchor] }],
    });
    await expect(accounting.summarize(structure!)).resolves.toMatchObject({
      blockingUnits: 0,
      statusCounts: { represented: 2, "background-only": 1, unresolved: 0 },
    });
    expect((await auditCompiler(root, { sourceId: fixture.source.id })).readiness.accounting).toBe("ready");
  });
});
