import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { WorldContextStore } from "../src/world/context.js";
import { WorldEngine } from "../src/world/engine.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("CanonicalModelStore revisions", () => {
  it("moves a logical ref to a new immutable revision without deleting history", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-canon-revision-"));
    roots.push(root);
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] });
    const first = await canon.currentRevision("entities", "hero");
    expect(first).not.toBeNull();

    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: ["The Hero"], evidence: [] });
    const second = await canon.currentRevision("entities", "hero");
    expect(second).not.toBeNull();
    expect(second?.hash).not.toBe(first?.hash);
    expect((await canon.getEntity("hero")).aliases).toEqual(["The Hero"]);

    const revisions = await canon.listRevisions("entities", "hero");
    expect(revisions).toHaveLength(2);
    expect(revisions.map((revision) => revision.hash)).toContain(first?.hash);
    expect(revisions.map((revision) => revision.hash)).toContain(second?.hash);
    await expect(canon.getEntityRevision("hero", first!.hash)).resolves.toMatchObject({ aliases: [] });
  });

  it("pins branch projection to the canonical snapshot captured at genesis", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-context-snapshot-"));
    roots.push(root);
    const canon = new CanonicalModelStore(root);
    const contexts = new WorldContextStore(root, canon);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] });
    const firstContext = await contexts.captureCurrent();
    const firstEngine = new WorldEngine(root, firstContext, (hash) => contexts.load(hash));
    const head = await firstEngine.createBranch("original", "Original", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });

    await canon.putEntity({ id: "hero", kind: "artifact", canonicalName: "Hero relic", aliases: [], evidence: [] });
    const latestContext = await contexts.captureCurrent();
    expect(latestContext.canonicalSnapshotHash).not.toBe(firstContext.canonicalSnapshotHash);
    const reopened = new WorldEngine(root, latestContext, (hash) => contexts.load(hash));

    await expect(reopened.projector.project(head)).resolves.toMatchObject({ values: { hero: { "character.alive": true } } });
    await expect(reopened.contextForCommit(head)).resolves.toMatchObject({ canonicalSnapshotHash: firstContext.canonicalSnapshotHash });
    expect((await reopened.contextForCommit(head)).entities.get("hero")?.kind).toBe("character");
    await expect(reopened.createBranch("latest", "Latest", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    })).rejects.toThrow("does not apply to artifact");
  });
});

