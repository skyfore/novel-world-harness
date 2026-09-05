import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { RepairRunStore } from "../src/compiler/repair-run.js";
import { repairExistingCommand } from "../src/commands/repair-existing.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

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
