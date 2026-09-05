import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { createPiPlayerWorldResponseResolver } from "../src/agent/pi-player-world-response.js";
import type { PlayerWorldResponseResolverInput } from "../src/world/runtime.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function input(): PlayerWorldResponseResolverInput {
  return {
    utterance: "I open the letter and read what it says.",
    recentMessages: [{ role: "scene", text: "The sealed letter rests on the desk.", worldStatus: "rendered", authority: "presentation-only", order: 0 }],
    relatedMessages: [{ role: "player", text: "Earlier I asked who delivered the letter.", worldStatus: "accepted", authority: "untrusted-player-text", order: 0 }],
    actor: { id: "hero-stable-id", name: "The student" },
    scene: {
      label: "Bedroom",
      presentEntities: [
        { id: "hero-stable-id", name: "The student", kind: "character" },
        { id: "letter-stable-id", name: "The sealed letter", kind: "artifact" },
      ],
    },
    candidate: {
      title: "Open the sealed letter",
      intent: {
        kind: "act",
        summary: "Open the addressed letter and read it",
        controlledAct: {
          eventTitle: "Open the sealed letter",
          actorObservation: "You break the seal and unfold the letter.",
        },
        desiredEffect: "Learn why the academy wrote",
        targets: [{ kind: "entity", entityId: "letter-stable-id" }],
      },
      participants: [],
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      requiresKnowledge: [],
      forbidsKnowledge: [],
    },
    eligibleResponses: [{
      possibilityId: "canon-secret-letter-event",
      kind: "canon-analogue",
      title: "The student receives the academy invitation",
      participantNames: ["The student", "The sealed letter", "The academy"],
      stateEffects: ["The sealed letter.artifact.owner = The student", "The sealed letter.artifact.delivered = true"],
      knowledgeEffects: ["The student learns (knows, 1): The academy invites The student"],
    }],
  };
}

describe("Pi player-world response resolver", () => {
  it("uses an isolated capture-only call, hides stable IDs, and decodes the offered handle", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-player-world-response-"));
    roots.push(root);
    let prompt = "";
    let disposed = false;
    vi.spyOn(PiAgentSession, "create").mockImplementation(async (options) => {
      expect(options.saveSession).toBe(false);
      expect(options.includeProjectInstructions).toBe(false);
      expect(options.includeLocalTools).toBe(false);
      expect(options.includeNwhExtension).toBe(false);
      expect(options.additionalTools?.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "find_related_messages",
        "read_related_message",
        "select_player_world_response",
      ]));
      const tool = options.additionalTools!.find((candidate) => candidate.name === "select_player_world_response")!;
      return {
        abort: async () => undefined,
        dispose: async () => { disposed = true; },
        promptWithReport: async (value: string) => {
          prompt = value;
          await tool.execute("response", {
            decision: "select",
            responseId: "response-001",
          } as never, undefined, undefined, {} as never);
          return { text: "" } as never;
        },
      } as unknown as PiAgentSession;
    });

    const result = await createPiPlayerWorldResponseResolver({ root })(input());

    expect(result).toEqual({ decision: "select", possibilityId: "canon-secret-letter-event" });
    expect(prompt).toContain("response-001");
    expect(prompt).toContain("The student receives the academy invitation");
    expect(prompt).toContain("The sealed letter rests on the desk");
    expect(prompt).not.toContain("canon-secret-letter-event");
    expect(prompt).not.toContain("hero-stable-id");
    expect(prompt).not.toContain("letter-stable-id");
    expect(disposed).toBe(true);
  });

  it("retries once in a fresh isolated session after an unoffered handle", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-player-world-response-retry-"));
    roots.push(root);
    const statuses: string[] = [];
    let created = 0;
    let disposed = 0;
    const prompts: string[] = [];
    vi.spyOn(PiAgentSession, "create").mockImplementation(async (options) => {
      created += 1;
      const attempt = created;
      const tool = options.additionalTools!.find((candidate) => candidate.name === "select_player_world_response")!;
      return {
        abort: async () => undefined,
        dispose: async () => { disposed += 1; },
        promptWithReport: async (prompt: string) => {
          prompts.push(prompt);
          if (attempt === 1) {
            await tool.execute("invalid", {
              decision: "select",
              responseId: "response-999",
            } as never, undefined, undefined, {} as never);
          } else {
            await tool.execute("none", { decision: "none" } as never, undefined, undefined, {} as never);
          }
          return { text: "" } as never;
        },
      } as unknown as PiAgentSession;
    });

    const result = await createPiPlayerWorldResponseResolver({
      root,
      onStatus: (status) => statuses.push(status),
    })(input());

    expect(result).toEqual({ decision: "none" });
    expect(created).toBe(2);
    expect(disposed).toBe(2);
    expect(statuses).toContain("即时回应尚未收束，正在重新判断…");
    expect(prompts[1]).toContain('"category":"lookup-miss"');
    expect(prompts[1]).toContain("response-999");
    expect(prompts[1]).toContain("response-001");
    expect(prompts[1]).toContain("do not search outside");
  });
});
