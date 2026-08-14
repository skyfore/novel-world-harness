import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UserQuestion } from "../src/util/ask-user-question.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { choosePlayExperience } from "../src/world/play-choice.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("structured play choices", () => {
  it("asks for ambiguous instances and characters before activating a session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-play-choice-"));
    roots.push(root);
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] });
    await canon.putEntity({ id: "rival", kind: "character", canonicalName: "Rival", aliases: ["Opponent"], evidence: [] });
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
      return question.header === "Instance" ? "beta" : "rival";
    });

    expect(questions.map((question) => question.header)).toEqual(["Instance", "Character"]);
    expect(selected).toMatchObject({ session: { branchId: "beta", actorId: "rival" } });
  });

  it("resolves free-form instance names and character aliases through custom input", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-play-choice-custom-"));
    roots.push(root);
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] });
    await canon.putEntity({ id: "rival", kind: "character", canonicalName: "Rival", aliases: ["Opponent"], evidence: [] });
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
    const selected = await choosePlayExperience(root, { branchId: "missing", character: "unknown" }, async (question) => {
      prompts.push(question.question);
      const input = question.header === "Instance" ? "Beta Timeline" : "Opponent";
      return question.customInput?.resolve(input);
    });

    expect(prompts).toEqual([
      "No unique instance matches 'missing'. Which novel-world instance do you want to use?",
      "No unique living character matches 'unknown'. Who do you want to play on 'beta'?",
    ]);
    expect(selected).toMatchObject({ session: { branchId: "beta", actorId: "rival" } });
  });
});
