import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stdout } from "node:process";
import { afterEach, expect, it, vi } from "vitest";
import { BoundaryCalibrationStore } from "../src/compiler/boundary-calibration.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { RepairRunStore } from "../src/compiler/repair-run.js";
import { rebuildCommand } from "../src/commands/rebuild.js";
import { repairExistingCommand } from "../src/commands/repair-existing.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

it("archives already-complete current staging without treating it as a historical repair fork", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-rebuild-current-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, "Chapter 1\nAlice raises the key and\n\nChapter 2\nopens the gate.\n");
  await new CanonicalModelStore(root).putEntity({
    id: "alice",
    kind: "character",
    canonicalName: "Alice",
    aliases: [],
    evidence: fixture.evidence("Alice"),
  });
  await new InitialWorldStore(root).put({
    version: 1,
    evidence: fixture.evidence("Alice raises the key"),
    delta: { version: 1, operations: [{ op: "set", entityId: "alice", field: "character.alive", value: true }] },
  });

  const regular = await prepareCompilerBatches(root, fixture.source);
  const calibrations = new BoundaryCalibrationStore(root);
  await calibrations.request({
    sourceId: fixture.source.id,
    leftSegmentId: regular[0]!.segmentIds[0]!,
    rightSegmentId: regular[1]!.segmentIds[0]!,
    requestedByBatchId: regular[0]!.id,
    requestedBySegmentId: regular[0]!.segmentIds[0]!,
    direction: "next",
    reason: "The action crosses the split.",
  });
  const completed = await prepareCompilerBatches(root, fixture.source);
  await new CompilerBatchStore(root).replaceCompleted(fixture.source.id, completed.map((batch) => batch.id));

  const output: string[] = [];
  vi.spyOn(stdout, "write").mockImplementation(((value: string | Uint8Array) => {
    output.push(String(value));
    return true;
  }) as typeof stdout.write);
  const cacheRoot = path.join(root, "cache");
  await expect(rebuildCommand({
    root,
    configPath: path.join(root, "not-used.yaml"),
    sourceId: fixture.source.id,
    cacheRoot,
    acquireLock: false,
  })).resolves.toBeUndefined();

  const result = JSON.parse(output.join("")) as { candidateBundleHash: string; activeBundleHash: string | null };
  const cache = new PreparedNovelCache(root, cacheRoot);
  expect(result.candidateBundleHash).toMatch(/^[a-f0-9]{64}$/);
  expect(result.activeBundleHash).toBeNull();
  expect((await cache.peekArchivedRevisions(fixture.source)).map((revision) => revision.bundleHash))
    .toEqual([result.candidateBundleHash]);
  expect((await cache.lookup(fixture.source)).status).toBe("miss");
  expect(await new RepairRunStore(root).read(fixture.source.id)).toBeNull();
  expect(await calibrations.list(fixture.source.id)).toHaveLength(1);
  expect((await new CompilerBatchStore(root).read(fixture.source.id)).completedBatchIds)
    .toEqual(completed.map((batch) => batch.id).sort());
});

it("resumes completed compiler work against an unpublished archive and never activates it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-rebuild-candidate-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, "Hero waits in Hall.\n"), evidence = fixture.evidence("Hero waits in Hall.");
  const canonical = new CanonicalModelStore(root);
  await canonical.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence });
  await canonical.putEntity({ id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence });
  await new InitialWorldStore(root).put({ version: 1, evidence, delta: { version: 1, operations: [
    { op: "set", entityId: "hero", field: "character.alive", value: true }, { op: "set", entityId: "hero", field: "character.location", value: "hall" }, { op: "set", entityId: "hero", field: "character.plan", value: "wait" },
  ] } });
  const batches = await prepareCompilerBatches(root, fixture.source), store = new CompilerBatchStore(root);
  await store.replaceCompleted(fixture.source.id, batches.map((batch) => batch.id));
  const cacheRoot = path.join(root, "cache"), cache = new PreparedNovelCache(root, cacheRoot);
  const parent = await cache.archiveCandidate(fixture.source);
  expect((await cache.lookup(fixture.source)).status).toBe("miss");
  const options = { root, configPath: path.join(root, "not-used.yaml"), sourceId: fixture.source.id, fromRevision: parent.bundleHash!, candidateOnly: true, cacheRoot };
  await expect(repairExistingCommand(options, { compileSource: async () => {
    await canonical.putEntity({ ...await canonical.getEntity("hero"), aliases: ["Hero"] });
    await store.replaceCompleted(fixture.source.id, [batches[0]!.id]);
    throw new Error("simulated interrupted Pi transport");
  } })).rejects.toThrow("paused without discarding completed work");
  const journal = (await new RepairRunStore(root).read(fixture.source.id))!;
  expect(journal.activeAtStart).toBeNull();
  expect((await canonical.getEntity("hero")).aliases).toEqual(["Hero"]);
  expect((await cache.lookup(fixture.source)).status).toBe("miss");
  const result = await repairExistingCommand(options, { compileSource: async () => {
    expect((await store.read(fixture.source.id)).completedBatchIds).toContain(batches[0]!.id);
    expect((await canonical.getEntity("hero")).aliases).toEqual(["Hero"]);
    await store.replaceCompleted(fixture.source.id, batches.map((batch) => batch.id));
  }, finishPreparation: async (input) => {
    expect(input.candidateOnly).toBe(true);
    return {} as never; // Component boundary only; no model trace or quality certificate is produced.
  } });
  expect(result.resumed).toBe(true);
  expect(result.runId).toBe(journal.runId);
  expect(result.candidateBundleHash).toMatch(/^[a-f0-9]{64}$/);
  expect(result.activeBundleHash).toBeNull();
  expect((await cache.lookup(fixture.source)).status).toBe("miss");
  expect(await new RepairRunStore(root).read(fixture.source.id)).toBeNull();
  await expect(cache.activate(fixture.source, result.candidateBundleHash!)).rejects.toThrow("WORLD_CLOSURE_BLOCKED");
});
