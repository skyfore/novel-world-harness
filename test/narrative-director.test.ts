import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalEventToPossibility } from "../src/world/canon-runtime.js";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import type { CanonicalEvent, Claim, Entity } from "../src/world/model.js";
import { buildNarrativeDirection } from "../src/world/narrative-director.js";
import { PlayerTurnService } from "../src/world/player-action.js";
import { WorldRuntime } from "../src/world/runtime.js";
import { projectActorScene } from "../src/world/scene.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-director-"));
  roots.push(root);
  const entities: Entity[] = [
    { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] },
    { id: "rival", kind: "character", canonicalName: "Rival", aliases: [], evidence: [] },
    { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: [] },
    { id: "camp", kind: "location", canonicalName: "Camp", aliases: [], evidence: [] },
  ];
  const route: Claim = {
    id: "route-to-camp",
    subject: "hero",
    predicate: "knows-route-to",
    object: "camp",
    epistemicType: "explicit-fact",
    evidence: [],
  };
  const leave: CanonicalEvent = {
    id: "leave-for-camp",
    title: "Hero leaves the Hall for Camp",
    participants: ["hero", "camp"],
    storyTime: { kind: "unknown" },
    preconditions: [{ op: "fact-equals", entityId: "hero", field: "character.location", value: "hall" }],
    observedOutcome: {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.location", value: "camp" }],
    },
    evidence: [],
    causalParents: [],
    confidence: 1,
  };
  const context: WorldModelContext = {
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    claims: new Map([[route.id, route]]),
    events: new Map([[leave.id, leave]]),
    rules: new Map(),
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
  };
  const engine = new WorldEngine(root, context);
  const head = await engine.createBranch("main", "Main", {
    version: 1,
    operations: [
      { op: "set", entityId: "hero", field: "character.alive", value: true },
      { op: "set", entityId: "hero", field: "character.location", value: "hall" },
      { op: "set", entityId: "rival", field: "character.alive", value: true },
      { op: "set", entityId: "rival", field: "character.location", value: "hall" },
    ],
  }, {
    version: 1,
    operations: [{ op: "learn", actorId: "hero", claimId: route.id, status: "knows", confidence: 1 }],
  });
  const runtime = new WorldRuntime(engine, ({ branchId, commitId }) => [
    canonicalEventToPossibility(leave, branchId, commitId),
  ]);
  return { engine, runtime, head };
}

describe("narrative scene director", () => {
  it("returns only executable progress-bearing choices and makes the canon-shaped choice a soft recommendation", async () => {
    const { engine, runtime, head } = await fixture();
    const direction = await buildNarrativeDirection(engine, runtime, "hero", head);

    expect(direction.affordances.length).toBeGreaterThanOrEqual(2);
    expect(direction.affordances.filter((choice) => choice.recommended)).toHaveLength(1);
    expect(direction.affordances.every((choice) => choice.progress.channels.length > 0)).toBe(true);
    expect(direction.affordances.every((choice) => choice.progress.noveltyKey.length > 0)).toBe(true);
    const recommended = direction.affordances.find((choice) => choice.recommended)!;
    expect(recommended.action).toContain("Camp");
    expect(recommended.progress.channels).toEqual(expect.arrayContaining(["state", "scene", "thread"]));

    const turns = new PlayerTurnService(
      engine,
      () => structuredClone(recommended.candidate),
      undefined,
      (proposal) => runtime.resolveEligibleCanonicalEvents(proposal),
    );
    const result = await turns.turn({
      branchId: "main",
      actorId: "hero",
      utterance: recommended.action,
    }, {
      intent: recommended.intent,
      affordanceId: recommended.id,
      progress: recommended.progress,
      authorizedKnowledgeClaimIds: recommended.authorizedKnowledgeClaimIds,
    });

    expect(result.accepted).toBe(true);
    expect(result.progressCertificate).toMatchObject({
      effectiveStateOperations: 1,
      sceneChanged: true,
    });
    expect(result.proposal?.possibilityId).toBe("canon-leave-for-camp");
    expect((await engine.projector.project(result.newHead)).values.hero?.["character.location"]).toBe("camp");

    const next = await buildNarrativeDirection(engine, runtime, "hero", result.newHead);
    expect(next.affordances.map((choice) => choice.progress.noveltyKey)).not.toContain(recommended.progress.noveltyKey);
    expect(next.threads.some((thread) => thread.stage >= 1)).toBe(true);
  });

  it("keeps co-present characters through solo beats and resets presence only at a committed scene boundary", async () => {
    const { engine, head } = await fixture();
    const exchange = await engine.commitProposal({
      proposalId: "exchange",
      branchId: "main",
      expectedParentCommit: head,
      source: "player",
      actorId: "hero",
      title: "Hero confronts Rival",
      participants: ["hero", "rival"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      causalParents: [],
      evidence: [],
      progress: {
        version: 1,
        channels: ["relationship", "thread", "consequence"],
        threadIds: ["rivalry"],
        noveltyKey: "rivalry:confront",
      },
    });
    const plan = await engine.commitProposal({
      proposalId: "solo-plan",
      branchId: "main",
      expectedParentCommit: exchange.newHead,
      source: "player",
      actorId: "hero",
      title: "Hero forms a plan",
      participants: ["hero"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.plan", value: "Reach Camp" }] },
      causalParents: [],
      evidence: [],
      progress: {
        version: 1,
        channels: ["state", "plan", "thread"],
        threadIds: ["rivalry"],
        noveltyKey: "rivalry:plan",
      },
    });

    expect((await projectActorScene(engine, "hero", plan.newHead)).presentEntityIds).toEqual(["hero", "rival"]);

    const moved = await engine.commitProposal({
      proposalId: "move-camp",
      branchId: "main",
      expectedParentCommit: plan.newHead,
      source: "player",
      actorId: "hero",
      title: "Hero leaves for Camp",
      participants: ["hero", "camp"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.location", value: "camp" }] },
      causalParents: [],
      evidence: [],
      progress: {
        version: 1,
        channels: ["state", "scene", "thread"],
        threadIds: ["rivalry"],
        noveltyKey: "rivalry:leave",
        scene: { kind: "arrive", destinationEntityId: "camp", label: "Camp", beat: 1 },
      },
    });
    const scene = await projectActorScene(engine, "hero", moved.newHead);
    expect(scene.locationId).toBe("camp");
    expect(scene.presentEntityIds).toEqual(["hero"]);
  });
});
