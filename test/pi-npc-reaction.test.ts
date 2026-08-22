import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { createPiNpcReactionReasoner } from "../src/agent/pi-npc-reaction.js";
import type { NpcReactionReasoningInput } from "../src/world/npc-reaction.js";
import { DEFAULT_STATE_FIELDS } from "../src/world/state.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function input(): NpcReactionReasoningInput {
  const writable = DEFAULT_STATE_FIELDS.filter((field) => field.appliesTo.includes("character"));
  return {
    npc: { id: "npc-secret-id", name: "Witness" },
    player: { id: "hero-stable-id", name: "Visitor" },
    trigger: {
      title: "The visitor asks a question",
      perceivedSummary: "面前的人对你说：“Where did the letter come from?”",
      interaction: {
        kind: "speech",
        content: "Where did the letter come from?",
        addresseeIds: ["npc-secret-id"],
        channel: "audible",
      },
    },
    actorContext: {
      actorId: "npc-secret-id",
      selfState: { "character.alive": true, "character.location": "hall-stable-id" },
      ownedEntityState: {},
      knowledge: [],
      presentEntities: [
        { id: "npc-secret-id", kind: "character", name: "Witness" },
        { id: "hero-stable-id", kind: "character", name: "Visitor" },
      ],
      referenceableEntities: [
        { id: "hall-stable-id", kind: "location", name: "Hall" },
        { id: "hero-stable-id", kind: "character", name: "Visitor" },
        { id: "npc-secret-id", kind: "character", name: "Witness" },
      ],
      writableEntityIds: ["npc-secret-id"],
      writableStateFields: writable,
      scene: {
        locationId: "hall-stable-id",
        locationState: {},
        presentEntityIds: ["npc-secret-id", "hero-stable-id"],
      },
      recentVisibleEvents: [{ summary: "The visitor asks a question" }],
      activeThreads: [],
    },
    development: {
      elapsedDays: 0,
      currentAffect: { label: "calm", intensity: 0.2 },
      recentExperiences: [],
    },
    activeGoals: [],
    activeWorldRules: [],
    recentPerceivedMessages: [{ kind: "perceived-event", text: "Where did the letter come from?", order: 4, speaker: "Visitor" }],
    relatedPerceivedMessages: [
      { kind: "perceived-event", text: "Earlier, the visitor mentioned a sealed envelope.", order: 0, speaker: "Visitor" },
      { kind: "perceived-event", text: "Where did the letter come from?", order: 4, speaker: "Visitor" },
    ],
  };
}

describe("Pi NPC reaction reasoner", () => {
  it("provides latest and on-demand actor-safe context and decodes only opaque handles", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-npc-reaction-"));
    roots.push(root);
    const prompts: string[] = [];
    const toolNames: string[][] = [];
    vi.spyOn(PiAgentSession, "create").mockImplementation(async (options) => {
      toolNames.push(options.additionalTools?.map((tool) => tool.name) ?? []);
      const capture = options.additionalTools?.find((tool) => tool.name === "propose_npc_reaction");
      if (!capture) throw new Error("missing NPC capture tool");
      return {
        abort: async () => undefined,
        dispose: async () => undefined,
        promptWithReport: async (prompt: string) => {
          prompts.push(prompt);
          await capture.execute("npc-response", {
            responseKind: "speak",
            eventTitle: "The witness answers",
            npcObservation: "You answer the visitor in a low voice.",
            playerObservation: "The witness answers in a low voice.",
            emotion: { label: "wary", intensity: 0.5, expression: "He glances at the door." },
            interaction: {
              kind: "speech",
              content: "A courier left it.",
              addresseeIds: ["entity-002"],
              channel: "audible",
            },
            preconditions: [],
            proposedDelta: { version: 1, operations: [] },
            communicatedClaimIds: [],
            requiresKnowledge: [],
            forbidsKnowledge: [],
          } as never, undefined, undefined, {} as never);
          return { text: "" } as never;
        },
      } as unknown as PiAgentSession;
    });

    const result = await createPiNpcReactionReasoner({ root })(input());

    expect(result).toMatchObject({
      responseKind: "speak",
      interaction: { content: "A courier left it.", addresseeIds: ["hero-stable-id"] },
    });
    expect(toolNames[0]).toEqual(expect.arrayContaining([
      "find_actor_context",
      "read_actor_context",
      "find_related_messages",
      "read_related_message",
      "propose_npc_reaction",
    ]));
    expect(prompts[0]).toContain("Where did the letter come from?");
    expect(prompts[0]).not.toContain("npc-secret-id");
    expect(prompts[0]).not.toContain("hero-stable-id");
    expect(prompts[0]).not.toContain("hall-stable-id");
  });
});
