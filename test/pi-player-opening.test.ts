import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { createPiPlayerOpeningNarrator } from "../src/agent/pi-player-opening.js";
import { playerSceneModelFrame, type PlayOpeningFrame } from "../src/world/play-opening.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function frame(): PlayOpeningFrame {
  const hero = { id: "hero-stable-id", kind: "character" as const, name: "福贵" };
  return {
    branchId: "branch-stable-id",
    commitId: "commit-stable-id",
    logicalStep: 0,
    elapsedDays: 0,
    actor: { id: hero.id, name: hero.name },
    selfState: {},
    development: { elapsedDays: 0, recentExperiences: [] },
    ownedEntityState: {},
    knowledge: [],
    presentEntities: [hero],
    referenceableEntities: [hero],
    visibleEntities: [hero],
    recentVisibleEvents: [],
    scene: { key: "opening", beat: 0, label: "门前", locationState: {}, signature: "scene-signature" },
    activeThreads: [],
    affordances: [{
      id: "aff-observe",
      label: "观察门前",
      description: "先确认眼前有什么动静。",
      action: "我先观察门前的动静。",
      intent: "observe",
      recommended: true,
    }],
  };
}

describe("Pi player scene narrator", () => {
  it("runs a rejected-draft retry in a fresh isolated session with the full actor frame", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-opening-retry-"));
    roots.push(root);
    const prompts: string[] = [];
    const choiceTools: unknown[] = [];
    const disposed: number[] = [];
    const drafts = [
      "REJECTED_DRAFT_SENTINEL",
      "风从门缝里挤进来，卷起脚边一层薄灰。你停在门前，听见木板深处传来轻微的摩擦声，却还不能断定里面有什么。空气里没有替你作出的决定，只有这一刻清楚而克制的迟疑；你可以先看清门前的痕迹，再决定下一步如何行动。",
    ];
    let created = 0;
    vi.spyOn(PiAgentSession, "create").mockImplementation(async (options) => {
      const sessionIndex = created;
      created += 1;
      const choiceTool = options.additionalTools?.find((tool) => tool.name === "propose_player_choices");
      if (!choiceTool) throw new Error("missing choice tool");
      choiceTools.push(choiceTool);
      return {
        abort: async () => undefined,
        dispose: async () => { disposed.push(sessionIndex); },
        promptWithReport: async (prompt: string) => {
          prompts.push(prompt);
          await choiceTool.execute("choice", {
            choices: [{
              affordanceId: "aff-observe",
              label: "观察门前",
              description: "先确认眼前有什么动静。",
              action: "我先观察门前的动静。",
              intent: "observe",
              recommended: true,
            }],
          } as never, undefined, undefined, {} as never);
          return { text: drafts[sessionIndex] } as never;
        },
      } as unknown as PiAgentSession;
    });
    const attempts: number[] = [];
    const result = await createPiPlayerOpeningNarrator({ root })(playerSceneModelFrame(frame()), "opening", {
      onAttempt: (attempt) => attempts.push(attempt),
    });

    expect(result).toMatchObject({ narration: drafts[1], choices: [{ affordanceId: "aff-observe" }] });
    expect(created).toBe(2);
    expect(choiceTools[0]).not.toBe(choiceTools[1]);
    expect(disposed.sort()).toEqual([0, 1]);
    expect(attempts).toEqual([1, 2]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("<committed-actor-frame>");
    expect(prompts[1]).toContain("fresh independent rendering attempt");
    expect(prompts[1]).not.toContain("REJECTED_DRAFT_SENTINEL");
    expect(prompts.join("\n")).not.toContain("branch-stable-id");
    expect(prompts.join("\n")).not.toContain("commit-stable-id");
    expect(prompts.join("\n")).not.toContain("hero-stable-id");
  });
});
