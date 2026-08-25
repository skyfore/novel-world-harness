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
    logicalStep: 1,
    elapsedDays: 0,
    actor: { id: hero.id, name: hero.name },
    selfState: {},
    development: { elapsedDays: 0, recentExperiences: [] },
    ownedEntityState: {},
    knowledge: [],
    presentEntities: [hero],
    referenceableEntities: [hero],
    visibleEntities: [hero],
    recentVisibleEvents: [{ title: "福贵问门外是谁", step: 1 }],
    scene: { key: "opening", beat: 1, label: "门前", locationState: {}, signature: "scene-signature" },
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
    messageHistory: [],
    recentMessages: [{
      role: "player",
      text: "我刚才问过门外是谁。",
      worldStatus: "accepted",
      authority: "untrusted-player-text",
      order: 1,
    }],
    resolvedAct: {
      rawUtterance: "我刚才问过门外是谁。",
      worldStatus: "accepted",
      actualOutcomes: ["你的问话已经传到门外。"],
      lockedUtterances: [{ speaker: "福贵", addressees: ["门外的人"], text: "门外是谁？", mode: "verbatim" }],
    },
    sourceReferences: [{
      ref: "private-source-reference",
      sourceId: "private-source-id",
      startByte: 10,
      endByte: 80,
      startLine: 2,
      endLine: 3,
      text: "风贴着旧门走，灰尘迟了一步才从门槛上醒来。",
      relevance: ["门前的停顿"],
      authority: "style-only",
      safety: "actor-visible-committed-evidence",
    }],
    playContinuity: [{
      role: "scene",
      text: "上一阵风停在门槛外，木板后面始终没有人应声。",
      worldStatus: "rendered",
      authority: "presentation-only",
      order: 0,
    }],
  };
}

const styleAnalysis = {
  proseMode: "贴近人物身体感受的第二人称限知叙事",
  syntax: ["长句承载感官流动，短句压住转折"],
  diction: ["克制、具体，不使用游戏术语"],
  cadence: "先缓后紧，在台词后留出静默",
  dialogueHandling: "让逐字台词单独落下，再写身体余震",
  continuityCues: ["延续门槛与风的意象"],
  avoid: ["把事件压缩成结果摘要"],
};

const dramaturgyAnalysis = {
  dramaticPressure: "问话已传出去，但门外回应尚未被承诺",
  beats: ["承接开口后的呼吸", "让逐字问话落入门板另一侧", "停在可感知的静默"],
  sensoryAnchors: ["门缝的风", "鞋尖前的薄灰"],
  dialoguePlacement: "在第一个动作之后完整保留问句",
  continuityObligations: ["门槛与木板的位置关系不变"],
  closingBeat: "门板后出现一个仍无法解释的轻响",
  avoid: ["替门外的人回答", "替玩家采取下一步行动"],
};

function toolKind(names: readonly string[]): "choice" | "style" | "dramaturgy" | "narrator" {
  if (names.includes("propose_player_choices")) return "choice";
  if (names.includes("propose_literary_style_analysis")) return "style";
  if (names.includes("propose_scene_dramaturgy")) return "dramaturgy";
  return "narrator";
}

describe("Pi player scene narrator", () => {
  it("keeps valid literary prose when optional experts omit or fail their capture calls", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-opening-soft-experts-"));
    roots.push(root);
    const narration = "闷热的风贴着走廊缓慢移动，你听见自己的问话越过门槛——“门外是谁？”尾音碰上木板，轻得像一粒灰。墙内断续的说话声听不真切，鞋底擦过水泥地面时，那声短促的金属碰响又从前方落下来，近得像有什么刚刚碰上门框。";
    const calls: Array<{ kind: ReturnType<typeof toolKind>; prompt: string; streamed: boolean; system: string }> = [];
    vi.spyOn(PiAgentSession, "create").mockImplementation(async (options) => {
      const names = options.additionalTools?.map((tool) => tool.name) ?? [];
      const kind = toolKind(names);
      return {
        abort: async () => undefined,
        dispose: async () => undefined,
        promptWithReport: async (prompt: string) => {
          calls.push({
            kind,
            prompt,
            streamed: typeof options.onText === "function",
            system: options.systemPromptOverride ?? "",
          });
          if (kind === "style") throw new Error("optional style provider failed");
          return { text: kind === "narrator" ? narration : "private output ignored" } as never;
        },
      } as unknown as PiAgentSession;
    });
    const attempts: number[] = [];

    const result = await createPiPlayerOpeningNarrator({ root })(playerSceneModelFrame(frame()), "turn", {
      onAttempt: (attempt) => attempts.push(attempt),
    });

    expect(result).toEqual({ narration, choices: [] });
    expect(calls.map((call) => call.kind).sort()).toEqual(["choice", "dramaturgy", "narrator", "style"]);
    expect(calls.filter((call) => call.streamed).map((call) => call.kind)).toEqual(["narrator"]);
    expect(attempts).toEqual([1]);
    const choice = calls.find((call) => call.kind === "choice")!;
    const final = calls.find((call) => call.kind === "narrator")!;
    expect(choice.prompt).toContain("call propose_player_choices exactly once");
    expect(choice.prompt).toContain("我刚才问过门外是谁");
    expect(choice.prompt).not.toContain("风贴着旧门走");
    expect(final.system).toContain("final literary narrator");
    expect(final.prompt).toContain("sourceReferences contains exact source-novel prose");
    expect(final.prompt).toContain("风贴着旧门走");
    expect(final.prompt).toContain("上一阵风停在门槛外");
    expect(final.prompt).not.toContain("private-source-id");
    expect(final.prompt).not.toContain("propose_player_choices");
  });

  it("fans private choice, style, and dramaturgy experts into a tool-free literary narrator", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-opening-fan-in-"));
    roots.push(root);
    const narration = "门缝里的风卷起脚边一层薄灰，你的呼吸在开口前顿了一下。“门外是谁？”问句越过门槛，撞进木板另一侧的昏暗里。没有答案立刻回来；昏黄灯光只沿门框轻轻晃动，那道新鲜划痕仍停在鞋尖前，片刻之后，一声压得极低的咳嗽贴着门板落下，又倏然安静。";
    const prompts = new Map<string, string>();
    const toolResults: string[] = [];
    const narratorToolNames: string[][] = [];
    vi.spyOn(PiAgentSession, "create").mockImplementation(async (options) => {
      const tools = options.additionalTools ?? [];
      const names = tools.map((tool) => tool.name);
      const kind = toolKind(names);
      if (kind === "narrator") narratorToolNames.push(names);
      return {
        abort: async () => undefined,
        dispose: async () => undefined,
        promptWithReport: async (prompt: string) => {
          prompts.set(kind, prompt);
          if (kind === "choice") {
            const tool = tools.find((candidate) => candidate.name === "propose_player_choices")!;
            const result = await tool.execute("choice", {
              choices: [
                { action: "蹲下来，用指尖沿着鞋尖前的划痕摸一遍。" },
                { action: "贴近门板，对门外说：“我听见你了。”" },
              ],
            } as never, undefined, undefined, {} as never);
            toolResults.push(result.content.flatMap((item) => item.type === "text" ? [item.text] : []).join(""));
          } else if (kind === "style") {
            await tools.find((candidate) => candidate.name === "propose_literary_style_analysis")!
              .execute("style", styleAnalysis as never, undefined, undefined, {} as never);
          } else if (kind === "dramaturgy") {
            await tools.find((candidate) => candidate.name === "propose_scene_dramaturgy")!
              .execute("dramaturgy", dramaturgyAnalysis as never, undefined, undefined, {} as never);
          }
          return { text: kind === "narrator" ? narration : "" } as never;
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
    expect(prompts.size).toBe(4);
    expect(prompts.get("style")).toContain("<literary-style-context>");
    expect(prompts.get("dramaturgy")).toContain("<scene-dramaturgy-analysis");
    expect(prompts.get("narrator")).toContain(styleAnalysis.cadence);
    expect(prompts.get("narrator")).toContain(dramaturgyAnalysis.closingBeat);
    expect(prompts.get("narrator")).toContain("authority=\"non-authoritative\"");
    expect(narratorToolNames[0]).toEqual(expect.arrayContaining([
      "find_actor_context",
      "read_actor_context",
      "find_related_messages",
      "read_related_message",
    ]));
    expect(narratorToolNames[0]).not.toEqual(expect.arrayContaining([
      "propose_player_choices",
      "propose_literary_style_analysis",
      "propose_scene_dramaturgy",
    ]));
    expect(toolResults).toEqual([expect.stringContaining("End this private choice-analysis call")]);
  });

  it("does not use host phrase matching to reject structurally valid literary output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-opening-language-neutral-"));
    roots.push(root);
    const narration = "REJECTED_DRAFT_SENTINEL：风从门缝里挤进来，卷起脚边一层薄灰。你听见自己问出“门外是谁？”，门板随之轻轻震动，昏黄灯光沿着墙角晃了一下。那道新鲜划痕还留在鞋尖前，木板另一侧的呼吸声却忽然停住。你可以先检查门前，也可以隔门询问，或者转身离开——下一步由你决定。";
    const prompts: Array<{ kind: ReturnType<typeof toolKind>; prompt: string }> = [];
    let created = 0;
    vi.spyOn(PiAgentSession, "create").mockImplementation(async (options) => {
      created += 1;
      const tools = options.additionalTools ?? [];
      const kind = toolKind(tools.map((tool) => tool.name));
      return {
        abort: async () => undefined,
        dispose: async () => undefined,
        promptWithReport: async (prompt: string) => {
          prompts.push({ kind, prompt });
          if (kind === "choice") {
            await tools.find((tool) => tool.name === "propose_player_choices")!.execute("choice", {
              choices: [
                { action: "贴近门缝，听听外面是谁在走动。" },
                { action: "隔着门喊一句：“我听见你了。”" },
              ],
            } as never, undefined, undefined, {} as never);
          }
          return { text: kind === "narrator" ? narration : "" } as never;
        },
      } as unknown as PiAgentSession;
    });
    const attempts: number[] = [];

    const result = await createPiPlayerOpeningNarrator({ root })(playerSceneModelFrame(frame()), "opening", {
      onAttempt: (attempt) => attempts.push(attempt),
    });

    expect(result).toMatchObject({ narration });
    expect(created).toBe(4);
    expect(attempts).toEqual([1]);
    const finalPrompt = prompts.find((entry) => entry.kind === "narrator")!.prompt;
    const choicePrompt = prompts.find((entry) => entry.kind === "choice")!.prompt;
    expect(finalPrompt).toContain("<committed-actor-frame>");
    expect(finalPrompt).not.toContain("branch-stable-id");
    expect(finalPrompt).not.toContain("commit-stable-id");
    expect(finalPrompt).not.toContain("hero-stable-id");
    expect(choicePrompt).toContain("exact concrete thing the actor could do now");
    expect(choicePrompt).toContain("leaves a later model to decide");
    expect(choicePrompt).not.toContain("aff-observe");
  });

  it("retries only the final literary session when committed dialogue is omitted", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-opening-dialogue-retry-"));
    roots.push(root);
    const drafts = [
      "FIRST_DRAFT_WITHOUT_DIALOGUE：风从门缝里挤进来，薄灰沿着你的鞋尖缓慢打转。木板另一侧始终没有清楚的回应，只有一道细微的摩擦声贴着门框落下；你站在原地，方才开口后的呼吸还没有完全平复，走廊深处的灯影便轻轻晃了一次。",
      "风从门缝里挤进来，薄灰沿着你的鞋尖缓慢打转。你抬眼望着门板，让那句话完整地落过去：“门外是谁？”尾音停住后，木板另一侧仍没有清楚的回应；只有一道细微的摩擦声贴着门框落下，走廊深处的灯影随之轻轻晃了一次。",
    ];
    const counts = { choice: 0, style: 0, dramaturgy: 0, narrator: 0 };
    const narratorPrompts: string[] = [];
    vi.spyOn(PiAgentSession, "create").mockImplementation(async (options) => {
      const tools = options.additionalTools ?? [];
      const kind = toolKind(tools.map((tool) => tool.name));
      counts[kind] += 1;
      return {
        abort: async () => undefined,
        dispose: async () => undefined,
        promptWithReport: async (prompt: string) => {
          if (kind === "choice") {
            await tools.find((tool) => tool.name === "propose_player_choices")!.execute("choice", {
              choices: [
                { action: "俯身查看门槛上的划痕。" },
                { action: "把耳朵贴近门板听里面的动静。" },
              ],
            } as never, undefined, undefined, {} as never);
          } else if (kind === "style") {
            await tools.find((tool) => tool.name === "propose_literary_style_analysis")!
              .execute("style", styleAnalysis as never, undefined, undefined, {} as never);
          } else if (kind === "dramaturgy") {
            await tools.find((tool) => tool.name === "propose_scene_dramaturgy")!
              .execute("dramaturgy", dramaturgyAnalysis as never, undefined, undefined, {} as never);
          } else {
            narratorPrompts.push(prompt);
            return { text: drafts[counts.narrator - 1] } as never;
          }
          return { text: "" } as never;
        },
      } as unknown as PiAgentSession;
    });
    const attempts: number[] = [];

    const result = await createPiPlayerOpeningNarrator({ root })(playerSceneModelFrame(frame()), "turn", {
      onAttempt: (attempt) => attempts.push(attempt),
    });

    expect(result).toMatchObject({ narration: drafts[1] });
    expect(counts).toEqual({ choice: 1, style: 1, dramaturgy: 1, narrator: 2 });
    expect(attempts).toEqual([1, 2]);
    expect(narratorPrompts[1]).toContain("fresh independent literary rendering");
    expect(narratorPrompts[1]).not.toContain("FIRST_DRAFT_WITHOUT_DIALOGUE");
    expect((result as { choices: unknown[] }).choices).toHaveLength(2);
  });
});
