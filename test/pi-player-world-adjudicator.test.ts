import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { createPiPlayerWorldAdjudicator } from "../src/agent/pi-player-world-adjudicator.js";
import type { PlayerWorldAdjudicationInput } from "../src/world/player-action.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function input(): PlayerWorldAdjudicationInput {
  return {
    utterance: "Attempt the impossible result now.",
    candidate: {
      title: "Try to restore life",
      intent: {
        kind: "act",
        summary: "Immediately restore the fallen friend to life",
        targets: [{ kind: "entity", entityId: "fallen-friend" }],
      },
      participants: [],
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      requiresKnowledge: [],
      forbidsKnowledge: [],
    },
    actorContext: {
      actorId: "hero-stable-id",
      selfState: { "character.alive": true },
      ownedEntityState: {},
      knowledge: [],
      presentEntities: [
        { id: "hero-stable-id", kind: "character", name: "The traveler" },
        { id: "fallen-friend", kind: "character", name: "The fallen friend" },
      ],
      referenceableEntities: [
        { id: "hero-stable-id", kind: "character", name: "The traveler" },
        { id: "fallen-friend", kind: "character", name: "The fallen friend" },
      ],
      writableEntityIds: ["hero-stable-id"],
      writableStateFields: [{
        key: "character.plan",
        appliesTo: ["character"],
        valueType: "string",
        cardinality: "one",
        visibility: "self",
      }],
      scene: { locationState: {}, presentEntityIds: ["hero-stable-id", "fallen-friend"] },
      recentVisibleEvents: [],
      activeThreads: [],
    },
    world: {
      entities: [
        { id: "hero-stable-id", kind: "character", name: "The traveler", state: { "character.alive": true } },
        { id: "fallen-friend", kind: "character", name: "The fallen friend", state: { "character.alive": false } },
      ],
      activeRules: [],
      scene: { presentEntityIds: ["hero-stable-id", "fallen-friend"] },
      deterministicIssues: [],
    },
  };
}

describe("Pi player world adjudicator", () => {
  it("uses one isolated capture-only call and decodes opaque contradiction/replacement handles", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-player-world-adjudicator-"));
    roots.push(root);
    let prompt = "";
    let disposed = false;
    vi.spyOn(PiAgentSession, "create").mockImplementation(async (options) => {
      expect(options.includeProjectInstructions).toBe(false);
      expect(options.includeLocalTools).toBe(false);
      expect(options.includeNwhExtension).toBe(false);
      expect(options.additionalTools).toHaveLength(1);
      const tool = options.additionalTools![0]!;
      expect(tool.name).toBe("propose_player_world_resolution");
      return {
        abort: async () => undefined,
        dispose: async () => { disposed = true; },
        promptWithReport: async (value: string) => {
          prompt = value;
          await tool.execute("resolution", {
            decision: "transform",
            status: "blocked",
            contradiction: {
              kind: "capability",
              summary: "Ordinary action cannot reverse the committed death.",
              basis: [
                { source: "state", entityId: "entity-001", field: "character.alive" },
                { source: "causal-principle", principle: "Ordinary action cannot reverse death." },
              ],
            },
            replacement: {
              title: "The attempt cannot restore life",
              intent: {
                kind: "act",
                summary: "Try to help and encounter an unresponsive body",
                targets: [{ kind: "entity", entityId: "entity-001" }],
              },
              participants: [],
              preconditions: [],
              proposedDelta: { version: 1, operations: [] },
              requiresKnowledge: [],
              forbidsKnowledge: [],
            },
            eventTitle: "The attempt meets an unresponsive silence",
            actorObservation: "Nothing answers the pressure of your hands.",
          } as never, undefined, undefined, {} as never);
          return { text: "" } as never;
        },
      } as unknown as PiAgentSession;
    });

    const result = await createPiPlayerWorldAdjudicator({ root })(input());

    expect(result).toMatchObject({
      decision: "transform",
      replacement: { intent: { targets: [{ kind: "entity", entityId: "fallen-friend" }] } },
    });
    expect((result as { contradiction: { basis: unknown[] } }).contradiction.basis).toEqual(expect.arrayContaining([
      { source: "state", entityId: "fallen-friend", field: "character.alive" },
    ]));
    expect(prompt).toContain("character.alive");
    expect(prompt).not.toContain("hero-stable-id");
    expect(prompt).not.toContain("fallen-friend");
    expect(disposed).toBe(true);
  });
});
