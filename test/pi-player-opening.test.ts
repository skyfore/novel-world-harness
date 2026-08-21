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
    behavioralContext: {
      traits: { 迟疑: 0.7, 善于自嘲: 0.8 },
      decisionBiases: { 避免正面冲突: 0.6 },
      activeGoals: [],
    },
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
  it("keeps valid scene prose when the provider omits the auxiliary choice call", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-opening-no-choices-"));
    roots.push(root);
    const narration = "闷热的风贴着走廊缓慢移动，你朝前迈出的脚步把身后的嘈杂一点点推远。墙内断续的说话声听不真切，传达室的方向却比刚才明确了些；鞋底擦过水泥地面时，那声短促的金属碰响又从前方落了下来，近得像有什么刚刚碰上门框。";
    let created = 0;
    const prompts: string[] = [];
    const systemPrompts: string[] = [];
    vi.spyOn(PiAgentSession, "create").mockImplementation(async (options) => {
      created += 1;
      systemPrompts.push(options.systemPromptOverride ?? "");
      return {
        abort: async () => undefined,
        dispose: async () => undefined,
        promptWithReport: async (prompt: string) => {
          prompts.push(prompt);
          return { text: narration } as never;
        },
      } as unknown as PiAgentSession;
    });
    const attempts: number[] = [];

    const result = await createPiPlayerOpeningNarrator({ root })(playerSceneModelFrame(frame()), "turn", {
      onAttempt: (attempt) => attempts.push(attempt),
    });

    expect(result).toEqual({ narration, choices: [] });
    expect(created).toBe(1);
    expect(attempts).toEqual([1]);
    expect(prompts).toHaveLength(1);
    expect(systemPrompts[0]).toContain("Before any narration");
    expect(systemPrompts[0]).toContain("must contain tool calls only");
    expect(prompts[0]).toContain("Phase 1 — choices");
    expect(prompts[0]).not.toContain("host-choice-repair");
  });

  it("makes choice capture the tool-only first phase before scene narration", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-opening-choice-first-"));
    roots.push(root);
    const narration = "门缝里的风卷起脚边一层薄灰，你站在原地，听见木板另一侧传来两次短促的摩擦声。昏黄灯光沿着门框轻轻晃动，那道新鲜划痕仍停在鞋尖前；片刻之后，门外有人压低声音咳了一下，又立刻安静下来。";
    const prompts: string[] = [];
    const toolResults: string[] = [];
    vi.spyOn(PiAgentSession, "create").mockImplementation(async (options) => {
      const choiceTool = options.additionalTools?.find((tool) => tool.name === "propose_player_choices");
      if (!choiceTool) throw new Error("missing choice tool");
      return {
        abort: async () => undefined,
        dispose: async () => undefined,
        promptWithReport: async (prompt: string) => {
          prompts.push(prompt);
          const result = await choiceTool.execute("choice-first", {
            choices: [
              { action: "蹲下来，用指尖沿着鞋尖前的划痕摸一遍。" },
              { action: "贴近门板，对门外说：“我听见你了。”" },
            ],
          } as never, undefined, undefined, {} as never);
          toolResults.push(result.content.flatMap((item) => item.type === "text" ? [item.text] : []).join(""));
          return { text: narration } as never;
        },
      } as unknown as PiAgentSession;
    });

    const result = await createPiPlayerOpeningNarrator({ root })(playerSceneModelFrame(frame()), "turn");

    expect(result).toEqual({
      narration,
      choices: [
        { action: "蹲下来，用指尖沿着鞋尖前的划痕摸一遍。" },
        { action: "贴近门板，对门外说：“我听见你了。”" },
      ],
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("before emitting any narration");
    expect(prompts[0]).toContain("complete player command");
    expect(prompts[0]).toContain("<committed-actor-frame>");
    expect(toolResults).toEqual([expect.stringContaining("Now stream only the requested scene narration")]);
  });

  it("does not use host language matching to reject an otherwise structural scene draft", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-opening-retry-"));
    roots.push(root);
    const prompts: string[] = [];
    const choiceTools: unknown[] = [];
    const disposed: number[] = [];
    const drafts = [
      "REJECTED_DRAFT_SENTINEL：风从门缝里挤进来，卷起脚边一层薄灰。走廊深处传来两次短促的摩擦声，门板随之轻轻震动。你可以先检查门前的痕迹，也可以隔门询问，或者转身离开——下一步由你决定。",
      "风从门缝里挤进来，卷起脚边一层薄灰。你停在门前，听见木板深处传来两次轻微的摩擦声，却还不能断定里面有什么。昏黄灯光沿着门框晃了一下，门板随即安静下来；只有门缝里的灰尘仍在缓慢打转，鞋尖前那道新鲜划痕清晰得有些刺眼。",
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
            choices: [
              { action: "贴近门缝，听听外面是谁在走动。" },
              { action: "隔着门喊一句：“谁啊？”" },
            ],
          } as never, undefined, undefined, {} as never);
          return { text: drafts[sessionIndex] } as never;
        },
      } as unknown as PiAgentSession;
    });
    const attempts: number[] = [];
    const result = await createPiPlayerOpeningNarrator({ root })(playerSceneModelFrame(frame()), "opening", {
      onAttempt: (attempt) => attempts.push(attempt),
    });

    expect(result).toMatchObject({
      narration: drafts[0],
      choices: [
        { action: "贴近门缝，听听外面是谁在走动。" },
        { action: "隔着门喊一句：“谁啊？”" },
      ],
    });
    expect(created).toBe(1);
    expect(choiceTools).toHaveLength(1);
    expect(disposed).toEqual([0]);
    expect(attempts).toEqual([1]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("<committed-actor-frame>");
    expect(prompts.join("\n")).not.toContain("branch-stable-id");
    expect(prompts.join("\n")).not.toContain("commit-stable-id");
    expect(prompts.join("\n")).not.toContain("hero-stable-id");
    expect(prompts[0]).toContain("concrete thing the actor could do now");
    expect(prompts[0]).toContain("complete player command");
    expect(prompts[0]).toContain("leaves a later model to decide");
    expect(prompts[0]).not.toContain("aff-observe");
  });
});
