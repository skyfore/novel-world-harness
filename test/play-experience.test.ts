import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { WorkspaceStore } from "../src/storage/workspace-store.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import {
  inspectPlayExperience,
  listPlayableCharacters,
  performPlayTurn,
  selectPlayExperience,
} from "../src/world/play-experience.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("play experience catalog", () => {
  it("lists novels, filters branch-pinned characters by source, and reports durable progress", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-play-experience-"));
    roots.push(root);
    const first = await createEvidenceFixture(root, "Hero waits.\n", "first.txt");
    const second = await createEvidenceFixture(root, "Rival waits.\n", "second.txt");
    await (await WorkspaceStore.create(root)).ensureProject({ name: "Two Stories", language: "en" });
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: first.evidence("Hero") });
    await canon.putEntity({ id: "rival", kind: "character", canonicalName: "Rival", aliases: [], evidence: second.evidence("Rival") });
    const { engine } = await openWorkspaceWorld(root);
    await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "rival", field: "character.alive", value: true },
      ],
    });

    const before = await inspectPlayExperience(root);
    expect(before.project?.name).toBe("Two Stories");
    expect(before.novels.map((source) => source.title)).toEqual(["first.txt", "second.txt"]);
    expect(before.instances).toEqual([
      expect.objectContaining({ branchId: "main", logicalStep: 0, commitCount: 1, eventCount: 1, active: false }),
    ]);
    await expect(listPlayableCharacters(root, { source: first.source.title })).resolves.toMatchObject({
      branchId: "main",
      source: { id: first.source.id },
      characters: [{ id: "hero", canonicalName: "Hero" }],
    });

    const selection = await selectPlayExperience(root, { branchId: "main", character: "Hero" });
    expect(selection.session).toMatchObject({ branchId: "main", actorId: "hero" });
    await performPlayTurn({
      root,
      branchId: "main",
      actorId: "hero",
      utterance: "I wait.",
      advanceBackground: 0,
      translator: () => ({
        title: "Hero waits",
        participants: [],
        preconditions: [],
        proposedDelta: { version: 1, operations: [] },
        requiresKnowledge: [],
        forbidsKnowledge: [],
      }),
    });

    const after = await inspectPlayExperience(root);
    expect(after.instances).toEqual([
      expect.objectContaining({
        branchId: "main",
        logicalStep: 1,
        commitCount: 2,
        eventCount: 2,
        active: true,
        actorId: "hero",
        actorName: "Hero",
        sessionAtHead: true,
        lastEventTitle: "Hero waits",
      }),
    ]);
  });

  it("requires an explicit instance when multiple branches exist and no resume state is saved", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-play-experience-"));
    roots.push(root);
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] });
    await canon.putEntity({ id: "rival", kind: "character", canonicalName: "Rival", aliases: [], evidence: [] });
    const { engine, runtime } = await openWorkspaceWorld(root);
    const mainHead = await engine.createBranch("alpha", "Alpha", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "rival", field: "character.alive", value: true },
      ],
    });
    await runtime.forkBranch("alpha", mainHead, "beta", "Beta");

    await expect(selectPlayExperience(root, { character: "hero" })).rejects.toThrow("Choose an instance");
    await expect(selectPlayExperience(root, { branchId: "alpha", character: "hero" })).resolves.toMatchObject({ actor: { id: "hero" } });
    await expect(selectPlayExperience(root, { branchId: "beta", character: "rival" })).resolves.toMatchObject({ actor: { id: "rival" } });
    await expect(selectPlayExperience(root, { branchId: "alpha" })).resolves.toMatchObject({ actor: { id: "hero" } });

    const catalog = await inspectPlayExperience(root);
    expect(catalog.instances.find((instance) => instance.branchId === "alpha")).toMatchObject({ actorId: "hero", active: true });
    expect(catalog.instances.find((instance) => instance.branchId === "beta")).toMatchObject({ actorId: "rival", active: false });
  });
});
