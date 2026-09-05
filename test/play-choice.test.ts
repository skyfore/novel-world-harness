import { useOfflinePreparationBoundary } from "./helpers/offline-preparation.js";
useOfflinePreparationBoundary();
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UserQuestion } from "../src/util/ask-user-question.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { createWorldBranch } from "../src/commands/world.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { choosePlayExperience } from "../src/world/play-choice.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("structured play choices", () => {
  it("asks for ambiguous instances and characters before activating a session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-play-choice-"));
    roots.push(root);
    const heroNovel = await createEvidenceFixture(root, "Hero waits.\n", "hero-novel.txt");
    const rivalNovel = await createEvidenceFixture(root, "Rival waits.\n", "rival-novel.txt");
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: heroNovel.evidence("Hero") });
    await canon.putEntity({ id: "rival", kind: "character", canonicalName: "Rival", aliases: ["Opponent"], evidence: rivalNovel.evidence("Rival") });
    const { engine, runtime } = await openWorkspaceWorld(root);
    const alphaHead = await engine.createBranch("alpha", "Alpha", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "rival", field: "character.alive", value: true },
      ],
    }, undefined, rivalNovel.source.id);
    await runtime.forkBranch("alpha", alphaHead, "beta", "Beta");
    const questions: UserQuestion<string>[] = [];

    const selected = await choosePlayExperience(root, {}, async (question) => {
      questions.push(question);
      if (question.header === "Novel") return rivalNovel.source.id;
      return question.header === "Instance" ? "beta" : "rival";
    });

    expect(questions.map((question) => question.header)).toEqual(["Novel", "Instance", "Character"]);
    expect(questions[0]?.options.map((option) => option.value)).toEqual([heroNovel.source.id, rivalNovel.source.id]);
    expect(questions[2]?.options.every((option) => option.recommended !== true)).toBe(true);
    expect(selected).toMatchObject({
      source: { id: rivalNovel.source.id },
      session: { branchId: "beta", sourceId: rivalNovel.source.id, actorId: "rival" },
    });
  });

  it("resolves free-form instance names and character aliases through custom input", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-play-choice-custom-"));
    roots.push(root);
    const heroNovel = await createEvidenceFixture(root, "Hero waits.\n", "hero-timeline.txt");
    const rivalNovel = await createEvidenceFixture(root, "Rival waits.\n", "rival-timeline.txt");
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: heroNovel.evidence("Hero") });
    await canon.putEntity({ id: "rival", kind: "character", canonicalName: "Rival", aliases: ["Opponent"], evidence: rivalNovel.evidence("Rival") });
    const { engine, runtime } = await openWorkspaceWorld(root);
    const alphaHead = await engine.createBranch("alpha", "Alpha Timeline", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "rival", field: "character.alive", value: true },
      ],
    }, undefined, rivalNovel.source.id);
    await runtime.forkBranch("alpha", alphaHead, "beta", "Beta Timeline");

    const prompts: string[] = [];
    const selected = await choosePlayExperience(root, { source: "missing", branchId: "missing", character: "unknown" }, async (question) => {
      prompts.push(question.question);
      const input = question.header === "Novel"
        ? rivalNovel.source.title
        : question.header === "Instance" ? "Beta Timeline" : "Opponent";
      return question.customInput?.resolve(input);
    });

    expect(prompts).toEqual([
      "No unique novel matches 'missing'. Which novel do you want to enter?",
      "No unique instance matches 'missing'. Which novel-world instance do you want to use?",
      "No unique available character matches 'unknown'. Who do you want to play on 'beta'?",
    ]);
    expect(selected).toMatchObject({ session: { branchId: "beta", sourceId: rivalNovel.source.id, actorId: "rival" } });
  });

  it("filters instances by their pinned novel before selecting the only branch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-play-choice-source-"));
    roots.push(root);
    const first = await createEvidenceFixture(root, "Hero waits.\n", "first.txt");
    const second = await createEvidenceFixture(root, "Rival waits.\n", "second.txt");
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: first.evidence("Hero") });
    let world = await openWorkspaceWorld(root);
    await world.engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    }, undefined, first.source.id);
    await canon.putEntity({ id: "rival", kind: "character", canonicalName: "Rival", aliases: [], evidence: second.evidence("Rival") });
    world = await openWorkspaceWorld(root);
    await world.engine.createBranch("second", "Second", {
      version: 1,
      operations: [{ op: "set", entityId: "rival", field: "character.alive", value: true }],
    }, undefined, second.source.id);

    const selected = await choosePlayExperience(root, { source: second.source.id }, async (question) => {
      expect(question.header).toBe("Character");
      return "rival";
    });

    expect(selected).toMatchObject({
      source: { id: second.source.id },
      session: { branchId: "second", sourceId: second.source.id, actorId: "rival" },
    });
    await choosePlayExperience(root, {
      source: first.source.id,
      branchId: "main",
      character: "hero",
    }, async () => undefined);
    await expect(choosePlayExperience(root, { branchId: "second" }, async () => {
      throw new Error("an explicitly named instance should infer its owning novel");
    })).resolves.toMatchObject({
      source: { id: second.source.id },
      session: { branchId: "second", sourceId: second.source.id, actorId: "rival" },
    });
    await expect(choosePlayExperience(root, {
      source: second.source.id,
      branchId: "main",
      character: "rival",
    }, async () => undefined)).rejects.toThrow("belongs to");
  });

  it("creates, continues, and switches source-owned instances from the selected prepared revision", async () => {
    const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-play-cache-"));
    const publisherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-play-publisher-"));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-play-lifecycle-"));
    roots.push(cacheRoot, publisherRoot, root);

    const livingContent = "Fugui waits at the village gate.\n";
    const publishedLiving = await createEvidenceFixture(publisherRoot, livingContent, "living.txt");
    await new CanonicalModelStore(publisherRoot).putEntity({
      id: "fugui",
      kind: "character",
      canonicalName: "Fugui",
      aliases: [],
      evidence: publishedLiving.evidence("Fugui"),
    });
    await new InitialWorldStore(publisherRoot).put({
      version: 1,
      delta: { version: 1, operations: [{ op: "set", entityId: "fugui", field: "character.alive", value: true }] },
      evidence: publishedLiving.evidence("Fugui waits at the village gate."),
    });
    const livingBatches = await prepareCompilerBatches(publisherRoot, publishedLiving.source);
    await new CompilerBatchStore(publisherRoot).replaceCompleted(
      publishedLiving.source.id,
      livingBatches.map((batch) => batch.id),
    );
    const published = await new PreparedNovelCache(publisherRoot, cacheRoot).publish(publishedLiving.source);

    const living = await createEvidenceFixture(root, livingContent, "huozhe.txt");
    const other = await createEvidenceFixture(root, "A warlord waits in the hall.\n", "three-kingdoms.txt");
    await new CanonicalModelStore(root).putEntity({
      id: "warlord",
      kind: "character",
      canonicalName: "Warlord",
      aliases: [],
      evidence: other.evidence("warlord"),
    });
    await new InitialWorldStore(root).put({
      version: 1,
      delta: { version: 1, operations: [{ op: "set", entityId: "warlord", field: "character.alive", value: true }] },
      evidence: other.evidence("A warlord waits in the hall."),
    });
    const otherBatches = await prepareCompilerBatches(root, other.source);
    await new CompilerBatchStore(root).replaceCompleted(other.source.id, otherBatches.map((batch) => batch.id));
    await new PreparedNovelCache(root, cacheRoot).publish(other.source);
    await createWorldBranch(root, "main", undefined, other.source.id, cacheRoot);

    const lifecycle: Array<{ type: string; branchId: string }> = [];
    const first = await choosePlayExperience(root, {
      source: living.source.id,
      instanceMode: "continue",
      preparedCacheRoot: cacheRoot,
      onInstanceLifecycle: (event) => lifecycle.push({ type: event.type, branchId: event.branchId }),
    }, async (question) => {
      expect(question.header).toBe("Character");
      return "fugui";
    });
    expect(first?.session.branchId).not.toBe("main");
    expect(lifecycle).toEqual([{ type: "created", branchId: first!.session.branchId }]);

    const { engine } = await openWorkspaceWorld(root);
    const createdBranch = await engine.branches.read(first!.session.branchId);
    const createdContext = await engine.contextForCommit(createdBranch.headCommitId);
    expect(createdBranch).toMatchObject({
      sourceId: living.source.id,
      preparedRevisionHash: published.bundleHash,
    });
    expect([...createdContext.entities.keys()]).toEqual(["fugui"]);
    expect(createdContext).toMatchObject({
      sourceId: living.source.id,
      preparedRevisionHash: published.bundleHash,
    });

    lifecycle.splice(0);
    const fresh = await choosePlayExperience(root, {
      source: living.source.id,
      instanceMode: "create",
      preparedCacheRoot: cacheRoot,
      onInstanceLifecycle: (event) => lifecycle.push({ type: event.type, branchId: event.branchId }),
    }, async (question) => {
      expect(question.header).toBe("Character");
      return "fugui";
    });
    expect(fresh!.session.branchId).not.toBe(first!.session.branchId);
    expect(lifecycle).toEqual([{ type: "created", branchId: fresh!.session.branchId }]);

    await new InitialWorldStore(publisherRoot).put({
      version: 1,
      delta: {
        version: 1,
        operations: [
          { op: "set", entityId: "fugui", field: "character.alive", value: true },
          { op: "set", entityId: "fugui", field: "character.title", value: "Farmer" },
        ],
      },
      evidence: publishedLiving.evidence("Fugui waits at the village gate."),
    });
    const revised = await new PreparedNovelCache(publisherRoot, cacheRoot).publish(publishedLiving.source);
    expect(revised.bundleHash).not.toBe(published.bundleHash);

    lifecycle.splice(0);
    const continued = await choosePlayExperience(root, {
      source: living.source.id,
      instanceMode: "continue",
      preparedCacheRoot: cacheRoot,
      onInstanceLifecycle: (event) => lifecycle.push({ type: event.type, branchId: event.branchId }),
    }, async () => {
      throw new Error("continue should select the newest source instance without prompting");
    });
    expect(continued!.session.branchId).toBe(fresh!.session.branchId);
    expect(lifecycle).toEqual([{ type: "continued", branchId: fresh!.session.branchId }]);
    expect(continued!.readinessWarnings).toContainEqual(expect.stringContaining("固定在 prepared revision"));
    expect(continued!.readinessWarnings.join(" ")).toContain(revised.bundleHash!.slice(0, 12));

    lifecycle.splice(0);
    const switched = await choosePlayExperience(root, {
      source: living.source.id,
      instanceMode: "switch",
      preparedCacheRoot: cacheRoot,
      onInstanceLifecycle: (event) => lifecycle.push({ type: event.type, branchId: event.branchId }),
    }, async (question) => {
      expect(question.header).toBe("Instance");
      return first!.session.branchId;
    });
    expect(switched!.session.branchId).toBe(first!.session.branchId);
    expect(lifecycle).toEqual([{ type: "switched", branchId: first!.session.branchId }]);
  });
});
