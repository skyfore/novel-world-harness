import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiPlayerActionTranslator } from "../src/agent/pi-player-action.js";
import { PiAgentSession } from "../src/agent/pi-session.js";
import type { PlayerActionTranslationInput } from "../src/world/player-action.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function input(withSupplement = false): PlayerActionTranslationInput {
  const base: PlayerActionTranslationInput = {
    utterance: "我走到陈雯雯面前和她说话。",
    context: {
      actorId: "hero-stable-id",
      selfState: { "character.alive": true },
      ownedEntityState: {},
      knowledge: [],
      presentEntities: [
        { id: "hero-stable-id", kind: "character", name: "路明非" },
        { id: "visible-person", kind: "character", name: "Unidentified character 1" },
      ],
      referenceableEntities: [
        { id: "hero-stable-id", kind: "character", name: "路明非" },
        { id: "visible-person", kind: "character", name: "Unidentified character 1" },
      ],
      writableEntityIds: ["hero-stable-id"],
      writableStateFields: [],
      spatialRelations: [],
      scene: { locationState: {}, presentEntityIds: ["hero-stable-id", "visible-person"] },
      recentVisibleEvents: [],
      activeThreads: [],
    },
    recentMessages: [],
    relatedMessages: [],
  };
  return withSupplement ? {
    ...base,
    contextSupplement: [{
      summary: "仅为解释本次输入：玩家所说的“陈雯雯”指向当前可见但尚未获得姓名知识的人物。",
      authority: "turn-reference",
      basis: [{ kind: "entity", id: "visible-person" }],
    }],
  } : base;
}

describe("Pi player action context request", () => {
  it("can preserve a material data gap instead of guessing or refusing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-player-context-"));
    roots.push(root);
    let prompt = "";
    let disposed = false;
    vi.spyOn(PiAgentSession, "create").mockImplementation(async (options) => {
      expect(options.includeProjectInstructions).toBe(false);
      expect(options.includeLocalTools).toBe(false);
      expect(options.includeNwhExtension).toBe(false);
      expect(options.additionalTools?.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "find_actor_context",
        "read_actor_context",
        "request_player_context",
        "propose_player_action",
      ]));
      const requestTool = options.additionalTools!.find((tool) => tool.name === "request_player_context")!;
      return {
        abort: async () => undefined,
        dispose: async () => { disposed = true; },
        promptWithReport: async (value: string) => {
          prompt = value;
          await requestTool.execute("request", {
            decision: "needs-context",
            domain: "relationship",
            question: "What prior relationship explains how the actor would address this person?",
            audience: "actor",
            searchTerms: ["陈雯雯"],
          } as never, undefined, undefined, {} as never);
          return { text: "" } as never;
        },
      } as unknown as PiAgentSession;
    });

    const result = await createPiPlayerActionTranslator({ root })(input());

    expect(result).toMatchObject({ decision: "needs-context", domain: "relationship" });
    expect(prompt).toContain("entity-001");
    expect(prompt).not.toContain("visible-person");
    expect(prompt).not.toContain("hero-stable-id");
    expect(disposed).toBe(true);
  });

  it("maps an admitted turn reference to an opaque handle and decodes the retried candidate", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-player-reference-"));
    roots.push(root);
    let prompt = "";
    vi.spyOn(PiAgentSession, "create").mockImplementation(async (options) => {
      const proposalTool = options.additionalTools!.find((tool) => tool.name === "propose_player_action")!;
      return {
        abort: async () => undefined,
        dispose: async () => undefined,
        promptWithReport: async (value: string) => {
          prompt = value;
          await proposalTool.execute("proposal", {
            title: "路明非走到眼前的人面前开口",
            intent: {
              kind: "act",
              summary: "走到陈雯雯面前并和她说话",
              controlledAct: {
                eventTitle: "路明非向眼前的人开口",
                actorObservation: "你走到眼前的人面前并开口。",
                interactionMode: "direct",
                interaction: {
                  kind: "speech",
                  content: "你好。",
                  addresseeIds: ["entity-001"],
                  channel: "audible",
                },
              },
              targets: [{ kind: "entity", entityId: "entity-001" }],
            },
            participants: ["entity-001"],
            preconditions: [],
            proposedDelta: { version: 1, operations: [] },
            requiresKnowledge: [],
            forbidsKnowledge: [],
          } as never, undefined, undefined, {} as never);
          return { text: "" } as never;
        },
      } as unknown as PiAgentSession;
    });

    const result = await createPiPlayerActionTranslator({ root })(input(true));

    expect(result).toMatchObject({
      participants: ["visible-person"],
      intent: {
        targets: [{ kind: "entity", entityId: "visible-person" }],
        controlledAct: { interaction: { addresseeIds: ["visible-person"] } },
      },
    });
    expect(prompt).toContain("turn-reference");
    expect(prompt).toContain("entity-001");
    expect(prompt).not.toContain("visible-person");
    expect(prompt).not.toContain("hero-stable-id");
  });
});
