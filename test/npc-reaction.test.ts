import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import {
  playerActionToKnowledgeAwareAction,
  type PlayerActionCandidate,
} from "../src/world/player-action.js";
import { respondToNpcInteractions } from "../src/world/npc-reaction.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-npc-reaction-"));
  roots.push(root);
  const context: WorldModelContext = {
    entities: new Map([
      ["hero", { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] }],
      ["npc", { id: "npc", kind: "character", canonicalName: "Witness", aliases: [], evidence: [] }],
      ["hall", { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: [] }],
    ]),
    rules: new Map(),
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
  };
  const engine = new WorldEngine(root, context);
  const genesis = await engine.createBranch("main", "Main", {
    version: 1,
    operations: [
      { op: "set", entityId: "hero", field: "character.alive", value: true },
      { op: "set", entityId: "hero", field: "character.location", value: "hall" },
      { op: "set", entityId: "npc", field: "character.alive", value: true },
      { op: "set", entityId: "npc", field: "character.location", value: "hall" },
    ],
  });
  const candidate: PlayerActionCandidate = {
    title: "Hero asks the witness",
    intent: {
      kind: "act",
      summary: "Ask the witness where the letter came from",
      controlledAct: {
        eventTitle: "Hero asks the witness",
        actorObservation: "You ask the nearby witness where the letter came from.",
        interaction: {
          kind: "speech",
          content: "Where did this letter come from?",
          addresseeIds: ["npc"],
          channel: "audible",
        },
      },
      desiredEffect: "Receive an answer",
      targets: [{ kind: "entity", entityId: "npc" }],
    },
    participants: ["npc"],
    preconditions: [],
    proposedDelta: { version: 1, operations: [] },
    requiresKnowledge: [],
    forbidsKnowledge: [],
  };
  const playerAction = playerActionToKnowledgeAwareAction({
    branchId: "main",
    actorId: "hero",
    expectedParentCommit: genesis,
    utterance: "Where did this letter come from?",
    candidate,
  });
  const committed = await engine.commitProposal({
    ...playerAction.proposal,
    progress: {
      version: 1,
      channels: ["relationship", "consequence"],
      threadIds: [],
      noveltyKey: "player-asks-witness",
    },
  });
  if (!committed.eventHash) throw new Error("fixture player event did not commit");
  return {
    engine,
    candidate,
    trigger: await engine.objects.getEvent(committed.eventHash),
  };
}

describe("reactive NPC response lane", () => {
  it("calls an addressed NPC even without a compiled model or goal and commits exact causal speech plus affect", async () => {
    const { engine, candidate, trigger } = await fixture();
    const reasoner = vi.fn((input) => {
      expect(input.trigger.perceivedSummary).toContain("Where did this letter come from?");
      expect(input.trigger.interaction).toMatchObject({ kind: "speech", addresseeIds: ["npc"] });
      expect(input.recentPerceivedMessages.at(-1)?.text).toContain("Where did this letter come from?");
      expect(input.relatedPerceivedMessages.at(-1)?.text).toContain("Where did this letter come from?");
      expect(input.development.model).toBeUndefined();
      expect(input.activeGoals).toEqual([]);
      return {
        responseKind: "speak",
        eventTitle: "The witness answers the question",
        npcObservation: "You answer the nearby person's direct question, keeping your voice low.",
        playerObservation: "The witness answers in a low voice.",
        emotion: { label: "wary", intensity: 0.55, expression: "His eyes remain on the doorway." },
        interaction: {
          kind: "speech",
          content: "A courier left it before dawn.",
          addresseeIds: ["hero"],
          channel: "audible",
        },
        preconditions: [],
        proposedDelta: { version: 1, operations: [] },
        communicatedClaimIds: [],
        requiresKnowledge: [],
        forbidsKnowledge: [],
      };
    });

    const result = await respondToNpcInteractions({
      engine,
      branchId: "main",
      playerId: "hero",
      playerCandidate: candidate,
      triggerEvent: trigger,
      reasoner,
    });

    expect(reasoner).toHaveBeenCalledOnce();
    expect(result.failures).toEqual([]);
    expect(result.responses).toEqual([
      expect.objectContaining({ actorId: "npc", responseKind: "speak", emotion: { label: "wary", intensity: 0.55, expression: "His eyes remain on the doorway." } }),
    ]);
    expect(result.responses[0]?.trace).toMatchObject({
      candidate: { responseKind: "speak" },
      proposal: { source: "actor", causalParents: [trigger.eventId] },
      validation: { accepted: true },
    });
    const event = await engine.objects.getEvent(result.responses[0]!.eventHash);
    expect(event.actorId).toBe("npc");
    expect(event.causalParents).toEqual([trigger.eventId]);
    expect(event.actorObservations).toContainEqual({
      actorId: "hero",
      summary: "面前的人回答：“A courier left it before dawn.” His eyes remain on the doorway.",
    });
    expect(event.actorAffects).toEqual([{
      actorId: "npc",
      label: "wary",
      intensity: 0.55,
      expression: "His eyes remain on the doorway.",
    }]);
    const repeated = await respondToNpcInteractions({
      engine,
      branchId: "main",
      playerId: "hero",
      playerCandidate: candidate,
      triggerEvent: trigger,
      reasoner,
    });
    expect(reasoner).toHaveBeenCalledOnce();
    expect(repeated.newHead).toBe(result.newHead);
    expect(repeated.responses[0]).toMatchObject({
      eventHash: result.responses[0]!.eventHash,
      responseKind: "speak",
    });
  });

  it("commits explicit silence instead of returning an empty reaction", async () => {
    const { engine, candidate, trigger } = await fixture();
    const result = await respondToNpcInteractions({
      engine,
      branchId: "main",
      playerId: "hero",
      playerCandidate: candidate,
      triggerEvent: trigger,
      reasoner: () => ({
        responseKind: "ignore",
        eventTitle: "The witness deliberately withholds an answer",
        npcObservation: "You hear the question and deliberately remain silent.",
        playerObservation: "The witness heard you but gave no answer.",
        emotion: { label: "guarded", intensity: 0.7, expression: "He closes his mouth and looks away." },
        preconditions: [],
        proposedDelta: { version: 1, operations: [] },
        communicatedClaimIds: [],
        requiresKnowledge: [],
        forbidsKnowledge: [],
      }),
    });

    expect(result.responses).toHaveLength(1);
    const event = await engine.objects.getEvent(result.responses[0]!.eventHash);
    expect(event.actorObservations?.find((entry) => entry.actorId === "hero")?.summary)
      .toContain("选择不回答");
    expect(event.progress?.noveltyKey).toMatch(/^npc-reaction:[a-f0-9]{32}:ignore$/);
  });

  it("does not invoke the reactive lane without a typed perceptible interaction", async () => {
    const { engine, candidate, trigger } = await fixture();
    const reasoner = vi.fn();
    const withoutInteraction: PlayerActionCandidate = {
      ...candidate,
      intent: {
        ...candidate.intent!,
        controlledAct: {
          eventTitle: candidate.intent!.controlledAct!.eventTitle,
          actorObservation: candidate.intent!.controlledAct!.actorObservation,
        },
      },
    };
    const result = await respondToNpcInteractions({
      engine,
      branchId: "main",
      playerId: "hero",
      playerCandidate: withoutInteraction,
      triggerEvent: trigger,
      reasoner,
    });
    expect(reasoner).not.toHaveBeenCalled();
    expect(result.responses).toEqual([]);
  });
});
