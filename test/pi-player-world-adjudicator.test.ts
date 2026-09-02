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
    recentMessages: [{ role: "scene", text: "The friend lies motionless before you.", worldStatus: "rendered", authority: "presentation-only", order: 0 }],
    relatedMessages: [{ role: "player", text: "Earlier I promised not to abandon them.", worldStatus: "accepted", authority: "untrusted-player-text", order: 0 }],
    candidate: {
      title: "Try to restore life",
      intent: {
        kind: "act",
        summary: "Immediately restore the fallen friend to life",
        controlledAct: {
          eventTitle: "The traveler attempts resuscitation",
          actorObservation: "You begin an ordinary attempt to resuscitate your fallen friend.",
        },
        desiredEffect: "Restore the fallen friend to life",
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
      expect(options.additionalTools?.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "find_related_messages",
        "read_related_message",
        "propose_player_world_resolution",
      ]));
      const tool = options.additionalTools!.find((candidate) => candidate.name === "propose_player_world_resolution")!;
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
    expect(prompt).toContain("The friend lies motionless before you");
    expect(prompt).not.toContain("hero-stable-id");
    expect(prompt).not.toContain("fallen-friend");
    expect(disposed).toBe(true);
  });

  it("retries once in a fresh isolated session when the first response omits the capture call", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-player-world-adjudicator-retry-"));
    roots.push(root);
    const statuses: string[] = [];
    let created = 0;
    let disposed = 0;
    vi.spyOn(PiAgentSession, "create").mockImplementation(async (options) => {
      created += 1;
      const attempt = created;
      const tool = options.additionalTools!.find((candidate) => candidate.name === "propose_player_world_resolution")!;
      return {
        abort: async () => undefined,
        dispose: async () => { disposed += 1; },
        promptWithReport: async (prompt: string) => {
          if (attempt === 1) {
            expect(prompt).toContain("Resolve the intended immediate action");
          } else {
            expect(prompt).toContain("Fresh protocol-recovery attempt");
            await tool.execute("resolution-retry", {
              decision: "realize",
              status: "succeeded",
              eventTitle: "The traveler begins the attempt",
              actorObservation: "Your hands begin the work, with the outcome not yet assumed.",
            } as never, undefined, undefined, {} as never);
          }
          return { text: "" } as never;
        },
      } as unknown as PiAgentSession;
    });

    const result = await createPiPlayerWorldAdjudicator({ root, onStatus: (status) => statuses.push(status) })(input());

    expect(result).toMatchObject({
      decision: "realize",
      eventTitle: "The traveler begins the attempt",
    });
    expect(created).toBe(2);
    expect(disposed).toBe(2);
    expect(statuses).toContain("行动后果尚未收束，正在重新推演…");
  });

  it("preserves an adjudication data gap and strips stable supplement identifiers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-player-world-context-"));
    roots.push(root);
    let prompt = "";
    vi.spyOn(PiAgentSession, "create").mockImplementation(async (options) => {
      const tool = options.additionalTools!.find((candidate) => candidate.name === "propose_player_world_resolution")!;
      return {
        abort: async () => undefined,
        dispose: async () => undefined,
        promptWithReport: async (value: string) => {
          prompt = value;
          await tool.execute("resolution", {
            decision: "needs-context",
            domain: "causality",
            question: "Did a prior committed event already establish the immediate cause?",
            audience: "world",
            searchTerms: ["promise"],
          } as never, undefined, undefined, {} as never);
          return { text: "" } as never;
        },
      } as unknown as PiAgentSession;
    });
    const value: PlayerWorldAdjudicationInput = {
      ...input(),
      contextSupplement: [{
        summary: "A prior promise is already part of committed history.",
        authority: "committed-world",
        basis: [{ kind: "canonical-event", id: "stable-prior-event-id" }],
      }],
    };

    const result = await createPiPlayerWorldAdjudicator({ root })(value);

    expect(result).toMatchObject({ decision: "needs-context", domain: "causality" });
    expect(prompt).toContain("A prior promise is already part of committed history");
    expect(prompt).not.toContain("stable-prior-event-id");
  });
});
