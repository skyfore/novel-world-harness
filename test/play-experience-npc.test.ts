import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { performPlayTurn } from "../src/world/play-experience.js";
import { buildPlayOpeningFrame } from "../src/world/play-opening.js";
import { PlayConversationStore } from "../src/world/play-conversation.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("play experience NPC integration", () => {
  it("turns directed speech into a committed NPC reply and carries the exact exchange into the next model call", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-play-npc-integration-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(
      root,
      "Hero asks Witness a question in the hall. Witness listens and answers.\n",
      "npc-dialogue.txt",
    );
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: fixture.evidence("Hero") });
    await canon.putEntity({ id: "witness", kind: "character", canonicalName: "Witness", aliases: [], evidence: fixture.evidence("Witness") });
    await canon.putEntity({ id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: fixture.evidence("hall") });
    const { engine } = await openWorkspaceWorld(root);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "hero", field: "character.location", value: "hall" },
        { op: "set", entityId: "witness", field: "character.alive", value: true },
        { op: "set", entityId: "witness", field: "character.location", value: "hall" },
      ],
    }, undefined, fixture.source.id);
    await new PlayConversationStore(root).append({
      branchId: "main",
      actorId: "hero",
      atCommit: genesis,
      role: "scene",
      status: "rendered",
      text: "The witness waits beside the east door, watching you approach.",
    });
    const npcResponseReasoner = vi.fn(() => ({
      responseKind: "speak",
      eventTitle: "Witness answers Hero",
      npcObservation: "You answer the direct question.",
      playerObservation: "Witness answers you.",
      emotion: { label: "attentive", intensity: 0.4, expression: "The witness meets your eyes." },
      interaction: {
        kind: "speech",
        content: "I saw the courier leave through the east door.",
        addresseeIds: ["hero"],
        channel: "audible",
      },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      communicatedClaimIds: [],
      requiresKnowledge: [],
      forbidsKnowledge: [],
    }));
    const first = await performPlayTurn({
      root,
      branchId: "main",
      actorId: "hero",
      utterance: "Where did the courier go?",
      advanceActors: 1,
      translator: (input) => {
        expect(input.recentMessages).toEqual([
          expect.objectContaining({
            role: "scene",
            text: "The witness waits beside the east door, watching you approach.",
            worldStatus: "rendered",
            authority: "presentation-only",
          }),
        ]);
        return {
          title: "Hero asks Witness about the courier",
          intent: {
            kind: "act",
            summary: "Ask Witness where the courier went",
            controlledAct: {
              eventTitle: "Hero asks Witness about the courier",
              actorObservation: "You ask Witness where the courier went.",
              interaction: {
                kind: "speech",
                content: "Where did the courier go?",
                addresseeIds: ["witness"],
                channel: "audible",
              },
            },
            desiredEffect: "Receive Witness's answer",
            targets: [{ kind: "entity", entityId: "witness" }],
          },
          participants: ["witness"],
          preconditions: [],
          proposedDelta: { version: 1, operations: [] },
          requiresKnowledge: [],
          forbidsKnowledge: [],
        };
      },
      npcResponseReasoner,
    });

    expect(first.result.accepted).toBe(true);
    expect(npcResponseReasoner).toHaveBeenCalledOnce();
    expect(first.npcResponseError).toBeUndefined();
    expect(first.reactionEvents).toEqual([
      expect.objectContaining({ actorId: "witness", responseKind: "speak", title: "Witness answers Hero" }),
    ]);
    expect(first.logicalStep).toBe(2);
    const frame = await buildPlayOpeningFrame(root, "main", "hero", fixture.source.id);
    expect(frame.recentVisibleEvents.at(-1)?.title).toContain("I saw the courier leave through the east door");

    let nextRecent: unknown;
    const second = await performPlayTurn({
      root,
      branchId: "main",
      actorId: "hero",
      utterance: "I nod.",
      advanceActors: 0,
      translator: (input) => {
        nextRecent = input.recentMessages;
        return {
          title: "Hero nods",
          intent: {
            kind: "act",
            summary: "Nod once",
            controlledAct: {
              eventTitle: "Hero nods",
              actorObservation: "You nod once.",
            },
            targets: [],
          },
          participants: [],
          preconditions: [],
          proposedDelta: { version: 1, operations: [] },
          requiresKnowledge: [],
          forbidsKnowledge: [],
        };
      },
    });
    expect(second.result.accepted).toBe(true);
    expect(nextRecent).toEqual([
      expect.objectContaining({
        role: "scene",
        text: "The witness waits beside the east door, watching you approach.",
        worldStatus: "rendered",
        authority: "presentation-only",
      }),
      expect.objectContaining({
        role: "player",
        text: "Where did the courier go?",
        worldStatus: "accepted",
        authority: "untrusted-player-text",
      }),
    ]);
    expect((await new PlayConversationStore(root).list("main")).map((message) => message.text)).toEqual([
      "The witness waits beside the east door, watching you approach.",
      "Where did the courier go?",
      "I nod.",
    ]);
  });
});
