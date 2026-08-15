import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UserQuestion } from "../src/util/ask-user-question.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
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
    });
    await runtime.forkBranch("alpha", alphaHead, "beta", "Beta");
    const questions: UserQuestion<string>[] = [];

    const selected = await choosePlayExperience(root, {}, async (question) => {
      questions.push(question);
      if (question.header === "Novel") return rivalNovel.source.id;
      return question.header === "Instance" ? "beta" : "rival";
    });

    expect(questions.map((question) => question.header)).toEqual(["Novel", "Instance"]);
    expect(questions[0]?.options.map((option) => option.value)).toEqual([heroNovel.source.id, rivalNovel.source.id]);
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
    });
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
      "No unique living character matches 'unknown'. Who do you want to play on 'beta'?",
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

    const selected = await choosePlayExperience(root, { source: second.source.id }, async () => {
      throw new Error("source-scoped single branch and character should not prompt");
    });

    expect(selected).toMatchObject({
      source: { id: second.source.id },
      session: { branchId: "second", sourceId: second.source.id, actorId: "rival" },
    });
    await expect(choosePlayExperience(root, {
      source: second.source.id,
      branchId: "main",
      character: "rival",
    }, async () => undefined)).rejects.toThrow("belongs to");
  });
});
