import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { validateFrozenAccounting } from "../src/compiler/certification.js";
import { EvidenceAssertionStore } from "../src/compiler/evidence-assertions.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { SegmentStore } from "../src/compiler/segments.js";
import { SourceAccountingStore } from "../src/compiler/source-accounting.js";
import { baseStructuralUnits, ensureSourceStructure } from "../src/compiler/structure.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { canonicalJson, contentHash } from "../src/world/canonical.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function temporaryRoot(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

it("projects prepared accounting from active evidence after artifact assertion supersession", async () => {
  const root = await temporaryRoot("nwh-accounting-active-projection-");
  const cacheRoot = await temporaryRoot("nwh-accounting-active-projection-cache-");
  const content = "Hero waits at the gate.\nFriend arrives later.\n";
  const fixture = await createEvidenceFixture(root, content);
  const structure = await ensureSourceStructure(root, fixture.source);
  const bytes = Buffer.from(content, "utf8");
  const heroAnchor = textAnchorForByteRange(fixture.source.id, bytes, 0, Buffer.byteLength("Hero", "utf8"));
  const secondStart = bytes.indexOf(Buffer.from("Friend arrives later.", "utf8"));
  const secondAnchor = textAnchorForByteRange(
    fixture.source.id,
    bytes,
    secondStart,
    secondStart + Buffer.byteLength("Friend arrives later.", "utf8"),
  );
  const canonical = new CanonicalModelStore(root);
  await canonical.putEntity({
    id: "hero",
    kind: "character",
    canonicalName: "Hero",
    aliases: [],
    evidence: fixture.evidence("Hero"),
  });
  await new InitialWorldStore(root).put({
    version: 1,
    evidence: fixture.evidence("Hero waits at the gate."),
    delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] },
  });
  const hero = await canonical.getEntity("hero");
  const historicalAssertion = {
    version: 1 as const,
    id: "historical-hero-name",
    target: { artifactKind: "entity", artifactId: "hero", jsonPointer: "/canonicalName" },
    anchors: [heroAnchor, secondAnchor],
    relation: "supports" as const,
    strength: "explicit" as const,
    derivation: { runId: "historical-run", worker: "test", ontologyVersion: "evidence-v1" as const },
  };
  const assertions = new EvidenceAssertionStore(root);
  await assertions.replaceForArtifact("entity", "hero", contentHash(hero), [historicalAssertion]);

  const batches = await prepareCompilerBatches(root, fixture.source);
  const segments = await new SegmentStore(root).list(fixture.source.id);
  const accounting = new SourceAccountingStore(root);
  const historicalManifest = await accounting.recordBatchReview({
    source: fixture.source,
    structure,
    batchId: batches.find(batch => batch.purpose === "source-review")!.id,
    reviews: segments.map(segment => ({
      segment,
      disposition: "proposed" as const,
      summary: "The original exact assertion represented this source unit.",
    })),
    evidenceAssertions: [historicalAssertion],
  });
  const historicalRepresented = historicalManifest.records.filter(record =>
    record.evidenceAssertionIds.includes(historicalAssertion.id));
  expect(historicalRepresented).toHaveLength(2);

  // Replacing an artifact's binding retains its immutable assertion revisions,
  // but the old assertion is no longer active support for source accounting.
  const currentAssertion = {
    ...historicalAssertion,
    id: "current-hero-name",
    anchors: [heroAnchor],
    derivation: { ...historicalAssertion.derivation, runId: "current-run" },
  };
  await assertions.replaceForArtifact("entity", "hero", contentHash(hero), [currentAssertion]);
  await new CompilerBatchStore(root).replaceCompleted(fixture.source.id, batches.map(batch => batch.id));
  const cache = new PreparedNovelCache(root, cacheRoot);
  const bundle = await cache.candidateSnapshot(fixture.source);
  const projected = bundle.compilerSnapshot.accounting!;
  const units = baseStructuralUnits(structure).filter(unit => unit.kind !== "non-scene");
  const heroUnit = units.find(unit => unit.anchor.startByte <= heroAnchor.startByte && unit.anchor.endByte >= heroAnchor.endByte)!;
  const uncoveredUnit = units.find(unit => unit.anchor.startByte <= secondAnchor.startByte && unit.anchor.endByte >= secondAnchor.endByte)!;
  expect(projected.records.find(record => record.unitId === heroUnit.id)).toMatchObject({
    status: "represented",
    evidenceAssertionIds: [currentAssertion.id],
  });
  const uncovered = projected.records.find(record => record.unitId === uncoveredUnit.id)!;
  expect(uncovered).toMatchObject({
    status: "unresolved",
    annotationIds: [],
    evidenceAssertionIds: [],
    reviewedBy: "model",
  });
  expect(uncovered.reason).toContain("no exact assertion or source annotation covers it");
  expect(canonicalJson(projected.batchReviews)).toBe(canonicalJson(historicalManifest.batchReviews));
  expect(projected.updatedAt).toBe(historicalManifest.updatedAt);
  expect((await accounting.read(fixture.source.id))!.records.find(record => record.unitId === uncoveredUnit.id))
    .toMatchObject({ status: "represented", evidenceAssertionIds: [historicalAssertion.id] });
  const issues = validateFrozenAccounting(bundle);
  expect(issues.some(issue => issue.code === "SOURCE_UNIT_UNACCOUNTED" && issue.path === uncoveredUnit.id)).toBe(true);
  expect(issues.some(issue => issue.code === "SOURCE_REPRESENTATION_REFERENCE_INVALID")).toBe(false);

  const archived = await cache.archiveCandidate(fixture.source);
  const raw = JSON.parse(await fs.readFile(path.join(archived.cachePath, "bundle.json"), "utf8"));
  const stale = structuredClone(raw);
  stale.compilerSnapshot.accounting.records = historicalManifest.records;
  const staleHash = contentHash(stale);
  const staleDirectory = path.join(path.dirname(archived.cachePath), staleHash);
  await fs.mkdir(staleDirectory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(staleDirectory, "bundle.json"), `${canonicalJson(stale)}\n`);
  await fs.writeFile(path.join(staleDirectory, "manifest.json"), `${canonicalJson({
    version: 1,
    contentMd5: fixture.source.contentMd5,
    contentSha256: fixture.source.contentSha256,
    sourceId: fixture.source.id,
    bundleHash: staleHash,
    createdAt: new Date().toISOString(),
  })}\n`);
  await expect(cache.restoreCompilerCheckpoint(fixture.source, staleHash))
    .rejects.toThrow("representation is not bound to current snapshot evidence");
});
