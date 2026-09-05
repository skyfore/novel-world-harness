import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { createWorldBranch } from "../src/world/instance.js";
import { BranchStore } from "../src/world/store.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

it("keeps an unreviewed candidate unpublished and rejects an uncertified archive at activate, restore and fresh creation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-certification-gate-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, "Hero waits in the hall.\n");
  await new CanonicalModelStore(root).putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: fixture.evidence("Hero") });
  await new InitialWorldStore(root).put({ version: 1, delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] }, evidence: fixture.evidence("Hero waits in the hall.") });
  const batches = await prepareCompilerBatches(root, fixture.source);
  await new CompilerBatchStore(root).replaceCompleted(fixture.source.id, batches.map((batch) => batch.id));
  const cacheRoot = path.join(root, "prepared-cache"), cache = new PreparedNovelCache(root, cacheRoot);
  const inspected = await cache.inspectCandidate(fixture.source);
  expect(inspected.assessment.fullNovelReady).toBe(false);
  expect(inspected.assessment.issues.map((issue) => issue.code)).toContain("NOVEL_EVALUATION_NOT_RUN");
  await expect(cache.publish(fixture.source)).rejects.toThrow("WORLD_CLOSURE_BLOCKED");
  expect((await cache.lookup(fixture.source)).status).toBe("miss");
  expect(await cache.listRevisions(fixture.source)).toEqual([]);
  const archive = await cache.publish(fixture.source, { allowSemanticDebtForRollback: true });
  expect((await cache.lookup(fixture.source)).status).toBe("miss");
  const canonical = new CanonicalModelStore(root);
  const original = (await canonical.listEntities())[0]!;
  await canonical.putEntity({ ...original, aliases: ["Staging repair"] });
  await cache.restoreCompilerCheckpoint(fixture.source, archive.bundleHash!);
  expect((await canonical.listEntities())[0]!.aliases).toEqual([]);
  expect((await cache.lookup(fixture.source)).status).toBe("miss");
  await expect(cache.activate(fixture.source, archive.bundleHash!)).rejects.toThrow("WORLD_CLOSURE_BLOCKED");
  // A replaced on-disk pointer is not a certificate and cannot bypass any public read gate.
  const activeFile = path.join(path.dirname(path.dirname(archive.cachePath)), "active.json");
  const pointer = JSON.stringify({ version: 1, contentMd5: archive.contentMd5, bundleHash: archive.bundleHash, updatedAt: new Date().toISOString() });
  await fs.writeFile(activeFile, pointer);
  await expect(cache.restore(fixture.source)).rejects.toThrow("WORLD_CLOSURE_BLOCKED");
  await expect(cache.loadFreshActive(fixture.source)).rejects.toThrow("WORLD_CLOSURE_BLOCKED");
  await expect(createWorldBranch(root, "play", undefined, fixture.source.id, cacheRoot, "hero")).rejects.toThrow("WORLD_CLOSURE_BLOCKED");
  expect(await new BranchStore(root).listIds()).toEqual([]);
  expect(await fs.readFile(activeFile, "utf8")).toBe(pointer);
});
