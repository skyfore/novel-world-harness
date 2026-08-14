import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { pinBranchPreparationContexts, WorldContextStore } from "../src/world/context.js";
import { WorldEngine } from "../src/world/engine.js";
import { ActorModelStore } from "../src/world/actors.js";
import { canonicalJson, contentHash } from "../src/world/canonical.js";
import { DEFAULT_STATE_FIELDS } from "../src/world/state.js";

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

  it("pins actor policy for legacy version-1 branch snapshots before current policy changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-legacy-context-snapshot-"));
    roots.push(root);
    const canon = new CanonicalModelStore(root);
    const actors = new ActorModelStore(root);
    const contexts = new WorldContextStore(root, canon);
    const evidence = [{
      span: { sourceId: "source", startLine: 1, endLine: 1, startByte: 0, endByte: 4, quoteHash: "a".repeat(64) },
      strength: "explicit" as const,
    }];
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] });
    await actors.putGoal({ id: "hero-goal", actorId: "hero", description: "Old policy", priority: 0.5, requiresKnowledge: [], evidence });
    const heroRef = await canon.currentRevision("entities", "hero");
    if (!heroRef) throw new Error("missing hero revision");
    const legacySnapshot = {
      version: 1 as const,
      entities: [heroRef],
      claims: [],
      events: [],
      rules: [],
      stateFields: DEFAULT_STATE_FIELDS,
    };
    const legacyHash = contentHash(legacySnapshot);
    await fs.mkdir(contexts.root, { recursive: true });
    await fs.writeFile(path.join(contexts.root, `${legacyHash}.json`), `${canonicalJson(legacySnapshot)}\n`);
    const engine = new WorldEngine(root, await contexts.load(legacyHash), (hash) => contexts.load(hash));
    const head = await engine.createBranch("legacy", "Legacy");

    expect(await pinBranchPreparationContexts(root)).toBe(1);
    await actors.putGoal({ id: "hero-goal", actorId: "hero", description: "New policy", priority: 0.8, requiresKnowledge: [], evidence });
    const reopened = new WorldEngine(root, await contexts.captureCurrent(), (hash) => contexts.load(hash));
    expect((await reopened.contextForCommit(head)).actorGoals?.[0]?.description).toBe("Old policy");
    expect(reopened.context.actorGoals?.[0]?.description).toBe("New policy");
  });
});
