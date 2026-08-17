import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it } from "vitest";
import { createPlayerActionCaptureTool } from "../src/agent/player-action-tool.js";
import { canonicalEventToPossibility } from "../src/world/canon-runtime.js";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import type { CanonicalEvent, Claim, Entity } from "../src/world/model.js";
import {
  buildActorScopedActionContext,
  deterministicPlayerIntentCandidate,
  PlayerTurnService,
  type PlayerActionCandidate,
} from "../src/world/player-action.js";
import { projectActorScene } from "../src/world/scene.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import { WorldRuntime } from "../src/world/runtime.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-player-action-"));
  roots.push(root);
  const entities: Entity[] = [
    { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] },
    { id: "villain", kind: "character", canonicalName: "Hidden Villain", aliases: [], evidence: [] },
    { id: "mo-yan", kind: "character", canonicalName: "墨砚", aliases: ["Mo Yan"], evidence: [] },
    { id: "narrator", kind: "character", canonicalName: "我", aliases: [], evidence: [] },
    { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: [] },
    { id: "camp", kind: "location", canonicalName: "Camp", aliases: [], evidence: [] },
    { id: "library", kind: "location", canonicalName: "Library", aliases: ["藏书楼"], evidence: [] },
    { id: "secret-lair", kind: "location", canonicalName: "Secret Lair", aliases: [], evidence: [] },
    { id: "silver-key", kind: "artifact", canonicalName: "银钥", aliases: ["Silver Key"], evidence: [] },
    { id: "black-key", kind: "artifact", canonicalName: "黑钥", aliases: ["Black Key"], evidence: [] },
  ];
  const route: Claim = {
    id: "known-route",
    subject: "hero",
    predicate: "knows-route-between",
    object: ["hall", "camp"],
    epistemicType: "explicit-fact",
    evidence: [],
  };
  const rumor: Claim = {
    id: "false-rumor",
    subject: "villain",
    predicate: "waits-at",
    object: "hall",
    epistemicType: "rumor",
    evidence: [],
  };
  const futureSecret: Claim = {
    id: "future-secret",
    subject: "villain",
    predicate: "will-ambush-at",
    object: "secret-lair",
    epistemicType: "narrator-claim",
    evidence: [],
  };
  const futureEvent: CanonicalEvent = {
    id: "future-ambush",
    title: "Hidden Villain ambushes Hero in the Secret Lair",
    participants: ["hero", "villain"],
    storyTime: { kind: "ordinal", label: "later" },
    preconditions: [],
    observedOutcome: { version: 1, operations: [] },
    evidence: [],
    causalParents: [],
    confidence: 1,
  };
  const giveKeyEvent: CanonicalEvent = {
    id: "give-key",
    title: "Hero gives the silver key to Mo Yan",
    participants: ["hero", "mo-yan"],
    storyTime: { kind: "ordinal", label: "now" },
    preconditions: [
      { op: "fact-equals", entityId: "hero", field: "character.location", value: "hall" },
      { op: "fact-equals", entityId: "mo-yan", field: "character.location", value: "hall" },
      { op: "fact-equals", entityId: "silver-key", field: "artifact.owner", value: "hero" },
    ],
    observedOutcome: { version: 1, operations: [{ op: "set", entityId: "silver-key", field: "artifact.owner", value: "mo-yan" }] },
    evidence: [],
    causalParents: [],
    confidence: 1,
  };
  const context: WorldModelContext = {
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    claims: new Map([route, rumor, futureSecret].map((claim) => [claim.id, claim])),
    events: new Map([futureEvent, giveKeyEvent].map((event) => [event.id, event])),
    rules: new Map(),
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
  };
  const engine = new WorldEngine(root, context);
  const genesis = await engine.createBranch("main", "Main", {
    version: 1,
    operations: [
      { op: "set", entityId: "hero", field: "character.alive", value: true },
      { op: "set", entityId: "hero", field: "character.location", value: "hall" },
      { op: "set", entityId: "villain", field: "character.alive", value: true },
      { op: "set", entityId: "villain", field: "character.location", value: "secret-lair" },
      { op: "set", entityId: "mo-yan", field: "character.alive", value: true },
      { op: "set", entityId: "mo-yan", field: "character.location", value: "hall" },
      { op: "set", entityId: "silver-key", field: "artifact.owner", value: "hero" },
      { op: "set", entityId: "black-key", field: "artifact.owner", value: "villain" },
    ],
  });
  const learned = await engine.commitProposal({
    proposalId: "learn-known-route",
    branchId: "main",
    expectedParentCommit: genesis,
    source: "background",
    title: "Hero learns the road to Camp",
    participants: ["hero"],
    proposedTime: { kind: "unknown" },
    preconditions: [],
    proposedDelta: { version: 1, operations: [] },
    proposedKnowledge: {
      version: 1,
      operations: [{ op: "learn", actorId: "hero", claimId: "known-route", status: "knows", confidence: 1 }],
    },
    causalParents: [],
    evidence: [],
  });
  return { root, engine, head: learned.newHead };
}

function moveToCamp(): PlayerActionCandidate {
  return {
    title: "Hero walks from the Hall to Camp",
    participants: ["camp"],
    preconditions: [{ op: "fact-equals", entityId: "hero", field: "character.location", value: "hall" }],
    proposedDelta: {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.location", value: "camp" }],
    },
    requiresKnowledge: ["known-route"],
    forbidsKnowledge: [],
  };
}

describe("actor-scoped player action context", () => {
  it("contains only self state and acquired knowledge, never future canon or hidden world state", async () => {
    const { engine, head } = await fixture();
    const context = await buildActorScopedActionContext(engine, "hero", head);
    const serialized = JSON.stringify(context);

    expect(context.selfState).toEqual({
      "character.alive": true,
      "character.location": "hall",
    });
    expect(context.knowledge.map((entry) => entry.claimId)).toEqual(["known-route"]);
    expect(context.referenceableEntities.map((entity) => entity.id)).toEqual(["camp", "hall", "hero", "mo-yan", "silver-key"]);
    expect(context.presentEntities.map((entity) => entity.id)).toEqual(["hero", "mo-yan"]);
    expect(context.writableEntityIds).toEqual(["hero", "silver-key"]);
    expect(context.ownedEntityState).toEqual({ "silver-key": { "artifact.owner": "hero" } });
    expect(serialized).not.toContain("future-secret");
    expect(serialized).not.toContain("future-ambush");
    expect(serialized).not.toContain("secret-lair");
    expect(serialized).not.toContain("villain");
  });

  it("builds sparse-state-safe host intents without model-invented predicates", async () => {
    const { engine, head } = await fixture();
    const context = await buildActorScopedActionContext(engine, "hero", head);
    for (const intent of ["observe", "reflect", "wait"] as const) {
      const candidate = deterministicPlayerIntentCandidate(intent, { utterance: intent, context });
      expect(candidate.preconditions).toEqual([]);
      expect(candidate.proposedDelta.operations).toEqual([]);
      expect(candidate.title).toBeTruthy();
    }
  });
});

describe("PlayerTurnService", () => {
  it("lets the host fill authoritative proposal fields, validates, commits, and renders", async () => {
    const { engine, head } = await fixture();
    let observedContext = "";
    const service = new PlayerTurnService(engine, (input) => {
      observedContext = JSON.stringify(input.context);
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen(input.context)).toBe(true);
      return moveToCamp();
    });

    const result = await service.turn({
      branchId: "main",
      actorId: "hero",
      utterance: "I leave the hall and walk to camp.",
    });

    expect(result.accepted).toBe(true);
    expect(result.stage).toBe("committed");
    expect(result.previousHead).toBe(head);
    expect(result.newHead).not.toBe(head);
    expect(result.proposal).toMatchObject({
      branchId: "main",
      expectedParentCommit: head,
      source: "player",
      actorId: "hero",
      participants: ["hero", "camp"],
      proposedTime: { kind: "unknown" },
      causalParents: [],
      evidence: [],
    });
    expect(result.proposal?.proposalId).toMatch(/^player-[a-f0-9]{24}$/);
    expect(result.validation?.accepted).toBe(true);
    expect(result.eventHash).toBeDefined();
    expect(result.renderedText).toContain("Hero walks from the Hall to Camp");
    expect((await engine.projector.project(result.newHead)).values.hero?.["character.location"]).toBe("camp");
    expect(observedContext).not.toContain("future-secret");
    expect(observedContext).not.toContain("future-ambush");
  });

  it("preserves the story-time anchor but rejects a repeated perception beat that would loop", async () => {
    const { engine, head } = await fixture();
    const anchored = await engine.commitProposal({
      proposalId: "anchor-1950",
      branchId: "main",
      expectedParentCommit: head,
      source: "background",
      title: "The current scene is anchored in 1950",
      participants: ["hero"],
      proposedTime: { kind: "exact", value: "1950", precision: "year" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      causalParents: [],
      evidence: [],
    });
    expect(anchored.report.accepted).toBe(true);
    const service = new PlayerTurnService(engine, () => ({
      title: "Hero observes",
      participants: [],
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      requiresKnowledge: [],
      forbidsKnowledge: [],
    }));
    const first = await service.turn({ branchId: "main", actorId: "hero", utterance: "Observe." });
    const second = await service.turn({ branchId: "main", actorId: "hero", utterance: "Observe again." });
    expect(first.accepted).toBe(true);
    expect(first.progressCertificate?.channels).toContain("scene");
    expect(second.accepted).toBe(false);
    expect(second.issues).toContainEqual(expect.objectContaining({ code: "PLAYER_ACTION_REPEATS_NO_PROGRESS" }));
    expect(second.newHead).toBe(first.newHead);
    expect(first.proposal?.proposedTime).toEqual({ kind: "exact", value: "1950", precision: "year" });
    expect(second.proposal?.proposedTime).toEqual({ kind: "exact", value: "1950", precision: "year" });
  });

  it("advances both elapsed time and a comparable story anchor when the player waits", async () => {
    const { engine, head } = await fixture();
    const anchored = await engine.commitProposal({
      proposalId: "anchor-wait-1950",
      branchId: "main",
      expectedParentCommit: head,
      source: "background",
      title: "The current scene is anchored in 1950",
      participants: ["hero", "mo-yan"],
      proposedTime: { kind: "exact", value: "1950", precision: "year" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      causalParents: [],
      evidence: [],
    });
    expect(anchored.report.accepted).toBe(true);
    const service = new PlayerTurnService(engine, ({ context }) =>
      deterministicPlayerIntentCandidate("wait", { utterance: "等待1年", context }));

    const result = await service.turn({ branchId: "main", actorId: "hero", utterance: "等待1年" });

    expect(result.accepted).toBe(true);
    expect(result.proposal?.timeAdvance).toEqual({ amount: 1, unit: "year" });
    expect(result.proposal?.proposedTime).toEqual({ kind: "exact", value: "1951", precision: "year" });
    const state = await engine.projector.project(result.newHead);
    expect(state.logicalTime.storyTime).toEqual({ kind: "exact", value: "1951", precision: "year" });
    expect(state.logicalTime.elapsedDays).toBeCloseTo(365.2425);
  });

  it("allows an explicitly named destination as a reference without exposing its state", async () => {
    const { engine } = await fixture();
    let observedContext: Parameters<ConstructorParameters<typeof PlayerTurnService>[1]>[0]["context"] | undefined;
    const service = new PlayerTurnService(engine, (input) => {
      observedContext = input.context;
      return {
        title: "Hero goes to the Library",
        participants: ["library"],
        preconditions: [{ op: "fact-equals", entityId: "hero", field: "character.location", value: "hall" }],
        proposedDelta: {
          version: 1,
          operations: [{ op: "set", entityId: "hero", field: "character.location", value: "library" }],
        },
        requiresKnowledge: [],
        forbidsKnowledge: [],
      };
    });

    const result = await service.turn({ branchId: "main", actorId: "hero", utterance: "我去藏书楼。" });

    expect(result.accepted).toBe(true);
    expect(observedContext?.referenceableEntities).toContainEqual(expect.objectContaining({ id: "library", name: "Library" }));
    expect(observedContext?.referenceableEntities.map((entity) => entity.id)).not.toContain("narrator");
    expect(observedContext?.writableEntityIds).not.toContain("library");
    expect(observedContext).not.toHaveProperty("worldState");
    expect((await engine.projector.project(result.newHead)).values.hero?.["character.location"]).toBe("library");
  });

  it("advances into an open scene when a free-form destination has no stable canonical entity", async () => {
    const { engine } = await fixture();
    const service = new PlayerTurnService(engine, () => ({
      title: "Hero walks out toward the street",
      participants: ["uncompiled-street"],
      preconditions: [],
      proposedDelta: {
        version: 1,
        operations: [{ op: "set", entityId: "hero", field: "character.location", value: "uncompiled-street" }],
      },
      requiresKnowledge: [],
      forbidsKnowledge: [],
    }));

    const result = await service.turn({ branchId: "main", actorId: "hero", utterance: "我出门去街上走走。" });

    expect(result.accepted).toBe(true);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "PLAYER_DESTINATION_GENERALIZED" }));
    expect(result.proposal?.proposedDelta.operations).toEqual([]);
    expect(result.progressCertificate).toMatchObject({ sceneChanged: true, effectiveStateOperations: 0 });
    expect(result.proposal?.progress?.scene).toMatchObject({ kind: "depart", label: "街上" });
    const scene = await projectActorScene(engine, "hero", result.newHead);
    expect(scene.locationId).toBeUndefined();
    expect(scene.label).toBe("街上");
    expect(scene.presentEntityIds).toEqual(["hero"]);
  });

  it("allows an actor-owned artifact to be transferred to an explicitly named character", async () => {
    const { engine } = await fixture();
    let observedWritable: string[] = [];
    const service = new PlayerTurnService(engine, (input) => {
      observedWritable = input.context.writableEntityIds;
      return {
        title: "Hero gives the silver key to Mo Yan",
        participants: ["silver-key", "mo-yan"],
        preconditions: [{ op: "fact-equals", entityId: "silver-key", field: "artifact.owner", value: "hero" }],
        proposedDelta: {
          version: 1,
          operations: [{ op: "set", entityId: "silver-key", field: "artifact.owner", value: "mo-yan" }],
        },
        requiresKnowledge: [],
        forbidsKnowledge: [],
      };
    });

    const result = await service.turn({ branchId: "main", actorId: "hero", utterance: "把银钥交给墨砚。" });

    expect(result.accepted).toBe(true);
    expect(observedWritable).toEqual(["hero", "silver-key"]);
    expect(result.contextBefore.referenceableEntities.map((entity) => entity.id)).toContain("mo-yan");
    expect(result.contextBefore.writableEntityIds).not.toContain("mo-yan");
    expect(result.contextBefore.ownedEntityState).toEqual({ "silver-key": { "artifact.owner": "hero" } });
    expect((await engine.projector.project(result.newHead)).values["silver-key"]?.["artifact.owner"]).toBe("mo-yan");
  });

  it("rejects model-supplied authority fields without moving the branch head", async () => {
    const { engine, head } = await fixture();
    const service = new PlayerTurnService(engine, () => ({
      ...moveToCamp(),
      branchId: "model-owned-branch",
      actorId: "villain",
      source: "background",
    }));

    const result = await service.turn({ branchId: "main", actorId: "hero", utterance: "Go to camp." });

    expect(result.accepted).toBe(false);
    expect(result.stage).toBe("translation");
    expect(result.issues.some((entry) => entry.code === "INVALID_PLAYER_ACTION_CANDIDATE")).toBe(true);
    expect(result.renderedText).not.toContain("Hero walks from the Hall to Camp");
    expect(await engine.branches.readHead("main")).toBe(head);
  });

  it("rejects guessed future entities and writes to other actors without moving truth", async () => {
    const { engine, head } = await fixture();
    const hiddenDestination = new PlayerTurnService(engine, () => ({
      ...moveToCamp(),
      title: "Hero finds the secret lair",
      proposedDelta: {
        version: 1,
        operations: [{ op: "set", entityId: "hero", field: "character.location", value: "secret-lair" }],
      },
    }));
    const hiddenResult = await hiddenDestination.turn({ branchId: "main", actorId: "hero", utterance: "Go somewhere hidden." });
    expect(hiddenResult.accepted).toBe(false);
    expect(hiddenResult.stage).toBe("scope");
    expect(hiddenResult.issues).toContainEqual(expect.objectContaining({ code: "PLAYER_ENTITY_OUT_OF_SCOPE" }));
    expect(await engine.branches.readHead("main")).toBe(head);

    const otherActor = new PlayerTurnService(engine, () => ({
      ...moveToCamp(),
      title: "Control the villain",
      proposedDelta: {
        version: 1,
        operations: [{ op: "set", entityId: "villain", field: "character.location", value: "hall" }],
      },
    }));
    const otherResult = await otherActor.turn({ branchId: "main", actorId: "hero", utterance: "Move the villain." });
    expect(otherResult.accepted).toBe(false);
    expect(otherResult.stage).toBe("scope");
    expect(otherResult.issues).toContainEqual(expect.objectContaining({ code: "PLAYER_WRITE_OUT_OF_SCOPE" }));
    expect(await engine.branches.readHead("main")).toBe(head);
  });

  it("rejects a named but distant character as a physical participant", async () => {
    const { engine, head } = await fixture();
    const service = new PlayerTurnService(engine, () => ({
      title: "Hero refuses to hand the silver key to the Hidden Villain",
      participants: ["villain"],
      preconditions: [],
      proposedDelta: {
        version: 1,
        operations: [{ op: "set", entityId: "silver-key", field: "artifact.owner", value: "hero" }],
      },
      requiresKnowledge: [],
      forbidsKnowledge: [],
    }));

    const result = await service.turn({ branchId: "main", actorId: "hero", utterance: "I refuse to give the key to Hidden Villain." });

    expect(result.accepted).toBe(false);
    expect(result.stage).toBe("scope");
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "PLAYER_REMOTE_INTERACTION_FORBIDDEN" }));
    expect(await engine.branches.readHead("main")).toBe(head);
  });

  it("distinguishes scene-grounded presence from unknown and known-remote locations", async () => {
    const { engine, head } = await fixture();
    const sparseScene = await engine.commitProposal({
      proposalId: "sparse-shared-scene",
      branchId: "main",
      expectedParentCommit: head,
      source: "background",
      title: "Hero and Mo Yan remain in the same immediate scene",
      participants: ["hero", "mo-yan"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: {
        version: 1,
        operations: [
          { op: "unset", entityId: "hero", field: "character.location" },
          { op: "unset", entityId: "mo-yan", field: "character.location" },
        ],
      },
      causalParents: [],
      evidence: [],
    });
    expect(sparseScene.report.accepted).toBe(true);

    const coPresent = new PlayerTurnService(engine, () => ({
      title: "Hero speaks quietly to Mo Yan",
      participants: ["mo-yan"],
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      requiresKnowledge: [],
      forbidsKnowledge: [],
    }));
    const presentResult = await coPresent.turn({ branchId: "main", actorId: "hero", utterance: "我对墨砚低声说话。" });
    expect(presentResult.accepted).toBe(true);
    expect(presentResult.contextBefore.presentEntities.map((entity) => entity.id)).toEqual(["hero", "mo-yan"]);

    const uncertain = new PlayerTurnService(engine, () => ({
      title: "Hero tries to address the Hidden Villain",
      participants: ["villain"],
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      requiresKnowledge: [],
      forbidsKnowledge: [],
    }));
    const uncertainResult = await uncertain.turn({ branchId: "main", actorId: "hero", utterance: "我对 Hidden Villain 说话。" });
    expect(uncertainResult.accepted).toBe(false);
    expect(uncertainResult.issues).toContainEqual(expect.objectContaining({ code: "PLAYER_SPATIAL_CONTEXT_UNKNOWN" }));
    expect(uncertainResult.issues).not.toContainEqual(expect.objectContaining({ code: "PLAYER_REMOTE_INTERACTION_FORBIDDEN" }));
  });

  it("host-derives supersession when a co-located player choice conflicts with eligible canon", async () => {
    const { engine } = await fixture();
    const giveKey = engine.context.events!.get("give-key")!;
    const runtime = new WorldRuntime(engine, ({ branchId, commitId }) => [canonicalEventToPossibility(giveKey, branchId, commitId)]);
    const service = new PlayerTurnService(
      engine,
      () => ({
        title: "Hero refuses and keeps the silver key",
        participants: ["mo-yan"],
        preconditions: [{ op: "fact-equals", entityId: "silver-key", field: "artifact.owner", value: "hero" }],
        proposedDelta: {
          version: 1,
          operations: [{ op: "set", entityId: "silver-key", field: "artifact.owner", value: "hero" }],
        },
        requiresKnowledge: [],
        forbidsKnowledge: [],
      }),
      undefined,
      (proposal) => runtime.resolveEligibleCanonicalEvents(proposal),
    );

    const result = await service.turn({ branchId: "main", actorId: "hero", utterance: "I refuse to give Mo Yan the silver key." });

    expect(result.accepted).toBe(true);
    expect(result.proposal?.supersedesCanonicalEventIds).toEqual(["give-key"]);
    const frontier = await runtime.refreshFrontier("main", result.newHead);
    expect(frontier.evaluated.find((entry) => entry.possibility.id === "canon-give-key")?.status).toBe("superseded");
  });

  it("marks a player-performed canonical effect realized instead of scheduling it twice", async () => {
    const { engine } = await fixture();
    const giveKey = engine.context.events!.get("give-key")!;
    const runtime = new WorldRuntime(engine, ({ branchId, commitId }) => [canonicalEventToPossibility(giveKey, branchId, commitId)]);
    const service = new PlayerTurnService(
      engine,
      () => ({
        title: "Hero gives the silver key to Mo Yan",
        participants: ["mo-yan"],
        preconditions: [{ op: "fact-equals", entityId: "silver-key", field: "artifact.owner", value: "hero" }],
        proposedDelta: {
          version: 1,
          operations: [{ op: "set", entityId: "silver-key", field: "artifact.owner", value: "mo-yan" }],
        },
        requiresKnowledge: [],
        forbidsKnowledge: [],
      }),
      undefined,
      (proposal) => runtime.resolveEligibleCanonicalEvents(proposal),
    );

    const result = await service.turn({ branchId: "main", actorId: "hero", utterance: "I give Mo Yan the silver key." });

    expect(result.accepted).toBe(true);
    expect(result.proposal?.possibilityId).toBe("canon-give-key");
    const after = await runtime.move({ branchId: "main", maxActorCandidates: 0, maxBackgroundCandidates: 1 });
    expect(after.committedEvents).toEqual([]);
    expect(after.frontier.evaluated.find((entry) => entry.possibility.id === "canon-give-key")?.status).toBe("realized");
  });

  it("marks a matching player-choice possibility realized for dependent consequences", async () => {
    const { engine } = await fixture();
    const runtime = new WorldRuntime(engine, ({ branchId, commitId }) => [{
      id: "refuse-key",
      branchId,
      evaluatedAtCommit: commitId,
      kind: "player-choice",
      title: "Hero refuses the key transfer",
      preconditions: [{ op: "fact-equals", entityId: "silver-key", field: "artifact.owner", value: "hero" }],
      blockers: [],
      participants: ["hero", "mo-yan"],
      causalParents: [],
      pressure: 1,
      relevance: 1,
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "silver-key", field: "artifact.owner", value: "hero" }] },
      evidence: [],
    }]);
    const service = new PlayerTurnService(
      engine,
      () => ({
        title: "Hero refuses and keeps the key",
        participants: ["mo-yan"],
        preconditions: [{ op: "fact-equals", entityId: "silver-key", field: "artifact.owner", value: "hero" }],
        proposedDelta: { version: 1, operations: [{ op: "set", entityId: "silver-key", field: "artifact.owner", value: "hero" }] },
        requiresKnowledge: [],
        forbidsKnowledge: [],
      }),
      undefined,
      (proposal) => runtime.resolveEligibleCanonicalEvents(proposal),
    );

    const result = await service.turn({ branchId: "main", actorId: "hero", utterance: "I refuse to give Mo Yan the key." });

    expect(result.accepted).toBe(true);
    expect(result.proposal?.possibilityId).toBe("refuse-key");
    expect((await runtime.realizedPossibilityIds(result.newHead)).has("refuse-key")).toBe(true);
  });

  it("rejects an unmentioned destination and an explicitly named but unowned artifact", async () => {
    const { engine, head } = await fixture();
    const unmentionedDestination = new PlayerTurnService(engine, () => ({
      title: "Hero goes to the Library",
      participants: ["library"],
      preconditions: [],
      proposedDelta: {
        version: 1,
        operations: [{ op: "set", entityId: "hero", field: "character.location", value: "library" }],
      },
      requiresKnowledge: [],
      forbidsKnowledge: [],
    }));
    const unmentioned = await unmentionedDestination.turn({ branchId: "main", actorId: "hero", utterance: "我离开这里。" });
    expect(unmentioned.accepted).toBe(false);
    expect(unmentioned.stage).toBe("scope");
    expect(unmentioned.issues).toContainEqual(expect.objectContaining({ code: "PLAYER_ENTITY_OUT_OF_SCOPE" }));
    expect(await engine.branches.readHead("main")).toBe(head);

    const ungrounded = new PlayerTurnService(engine, () => ({
      ...moveToCamp(),
      preconditions: [{ op: "fact-equals", entityId: "hero", field: "character.title", value: "Unwritten" }],
    }));
    const ungroundedResult = await ungrounded.turn({ branchId: "main", actorId: "hero", utterance: "Act as if I had an unwritten title." });
    expect(ungroundedResult.accepted).toBe(false);
    expect(ungroundedResult.stage).toBe("scope");
    expect(ungroundedResult.issues).toContainEqual(expect.objectContaining({ code: "PLAYER_PRECONDITION_UNGROUNDED" }));
    expect(await engine.branches.readHead("main")).toBe(head);

    const unownedArtifact = new PlayerTurnService(engine, () => ({
      title: "Hero gives the black key to Mo Yan",
      participants: ["black-key", "mo-yan"],
      preconditions: [],
      proposedDelta: {
        version: 1,
        operations: [{ op: "set", entityId: "black-key", field: "artifact.owner", value: "mo-yan" }],
      },
      requiresKnowledge: [],
      forbidsKnowledge: [],
    }));
    const unowned = await unownedArtifact.turn({ branchId: "main", actorId: "hero", utterance: "把黑钥交给墨砚。" });
    expect(unowned.accepted).toBe(false);
    expect(unowned.stage).toBe("scope");
    expect(unowned.issues).toContainEqual(expect.objectContaining({ code: "PLAYER_WRITE_OUT_OF_SCOPE" }));
    expect(unowned.contextBefore.referenceableEntities.map((entity) => entity.id)).toEqual(expect.arrayContaining(["black-key", "mo-yan"]));
    expect(unowned.contextBefore.writableEntityIds).not.toContain("black-key");
    expect(await engine.branches.readHead("main")).toBe(head);
  });

  it("surfaces deterministic engine and knowledge rejections and leaves the head unchanged", async () => {
    const { engine, head } = await fixture();
    const impossible = new PlayerTurnService(engine, () => ({
      ...moveToCamp(),
      preconditions: [{ op: "fact-equals", entityId: "hero", field: "character.alive", value: false }],
    }));
    const impossibleResult = await impossible.turn({ branchId: "main", actorId: "hero", utterance: "Go to camp while dead." });
    expect(impossibleResult.accepted).toBe(false);
    expect(impossibleResult.stage).toBe("scope");
    expect(impossibleResult.issues).toContainEqual(expect.objectContaining({ code: "PLAYER_PRECONDITION_UNSATISFIED" }));
    expect(await engine.branches.readHead("main")).toBe(head);

    const disbelieved = await engine.commitProposal({
      proposalId: "hear-false-rumor",
      branchId: "main",
      expectedParentCommit: head,
      source: "background",
      title: "Hero hears and rejects a rumor",
      participants: ["hero"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      proposedKnowledge: {
        version: 1,
        operations: [{ op: "learn", actorId: "hero", claimId: "false-rumor", status: "disbelieves", confidence: 1 }],
      },
      causalParents: [],
      evidence: [],
    });
    const needsRumor = new PlayerTurnService(engine, () => ({
      ...moveToCamp(),
      requiresKnowledge: ["false-rumor"],
    }));
    const knowledgeResult = await needsRumor.turn({ branchId: "main", actorId: "hero", utterance: "Act on the rumor." });
    expect(knowledgeResult.accepted).toBe(false);
    expect(knowledgeResult.stage).toBe("knowledge");
    expect(knowledgeResult.issues).toContainEqual(expect.objectContaining({ code: "REQUIRED_KNOWLEDGE_MISSING" }));
    expect(await engine.branches.readHead("main")).toBe(disbelieved.newHead);
  });
});

describe("player action capture tool", () => {
  it("publishes a strict schema and captures exactly one in-memory candidate without committing", async () => {
    const capture = createPlayerActionCaptureTool();
    const validator = Compile(capture.tool.parameters);
    const candidate = moveToCamp();

    expect(validator.Check(candidate)).toBe(true);
    expect(validator.Check({ ...candidate, branchId: "main", expectedParentCommit: "head" })).toBe(false);
    expect(validator.Check({
      ...candidate,
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "location", value: "camp" }] },
    })).toBe(false);
    expect(JSON.stringify(capture.tool.parameters)).not.toContain("expectedParentCommit");
    const prepared = capture.tool.prepareArguments?.(JSON.stringify(candidate));
    expect(prepared).toEqual(candidate);

    await capture.tool.execute(
      "player-call-1",
      prepared as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    expect(capture.getCandidate()).toEqual(candidate);
    expect(capture.getExecutionAttempts()).toBe(1);
    await expect(capture.tool.execute(
      "player-call-2",
      candidate as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    )).rejects.toThrow("Only one player action candidate");
    expect(capture.getExecutionAttempts()).toBe(2);
  });
});
