import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it } from "vitest";
import { createPlayerActionCaptureTool } from "../src/agent/player-action-tool.js";
import { createPlayerActionModelBoundary, playerActionModelContext } from "../src/agent/pi-player-action.js";
import { canonicalEventToPossibility } from "../src/world/canon-runtime.js";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import type { CanonicalEvent, Claim, Entity } from "../src/world/model.js";
import {
  buildActorScopedActionContext,
  deterministicPlayerIntentCandidate,
  PlayerTurnService,
  validatePlayerActionScope,
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
    { id: "secret-bond", kind: "relationship", canonicalName: "Hidden bond", aliases: [], evidence: [] },
  ];
  const route: Claim = {
    id: "known-route",
    subject: "hero",
    predicate: "knows-route-between",
    object: { route: { from: "hall", waypoints: ["library"], to: "camp" } },
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
      { op: "set", entityId: "secret-bond", field: "relationship.from", value: "hero" },
      { op: "set", entityId: "secret-bond", field: "relationship.to", value: "villain" },
      { op: "set", entityId: "secret-bond", field: "relationship.strength", value: 0.9 },
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
    intent: {
      kind: "act",
      summary: "Walk from the Hall to Camp",
      targets: [{ kind: "entity", entityId: "camp" }],
      sceneTransition: { kind: "arrive", destination: { kind: "entity", entityId: "camp" } },
    },
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
    expect(context.referenceableEntities.map((entity) => entity.id)).toEqual(["camp", "hall", "hero", "library", "mo-yan", "silver-key"]);
    expect(context.presentEntities.map((entity) => entity.id)).toEqual(["hero", "mo-yan"]);
    expect(context.presentEntities.find((entity) => entity.id === "mo-yan")?.name).toBe("Unidentified character 1");
    expect(context.writableEntityIds).toEqual(["hero", "silver-key"]);
    expect(context.ownedEntityState).toEqual({ "silver-key": { "artifact.owner": "hero" } });
    expect(context.writableStateFields.map((field) => field.key)).not.toEqual(expect.arrayContaining([
      "character.experience",
      "character.momentum",
      "character.reputation",
      "relationship.strength",
    ]));
    expect(context.writableStateFields.map((field) => field.key)).toEqual(expect.arrayContaining([
      "character.location",
      "character.plan",
      "artifact.owner",
    ]));
    expect(serialized).not.toContain("secret-bond");
    expect(serialized).not.toContain("future-secret");
    expect(serialized).not.toContain("future-ambush");
    expect(serialized).not.toContain("secret-lair");
    expect(serialized).not.toContain("villain");
    const modelContext = playerActionModelContext(context);
    expect(modelContext).not.toHaveProperty("atCommit");
    expect(modelContext).not.toHaveProperty("temporalContext");
    expect(modelContext.scene).not.toHaveProperty("beat");
    expect(modelContext).not.toHaveProperty("visibleStateFieldTypes");
    expect(modelContext.actorId).toBe("actor-self");
    expect((modelContext.referenceableEntities as Array<{ id: string }>).every((entity) =>
      entity.id === "actor-self" || /^entity-\d{3}$/.test(entity.id))).toBe(true);
    expect((modelContext.knowledge as Array<{ claimId: string }>)[0]?.claimId).toBe("claim-001");
    expect(JSON.stringify(modelContext)).not.toContain('"actorId":"hero"');
    expect(JSON.stringify(modelContext)).not.toContain('"claimId":"known-route"');
    expect(JSON.stringify(modelContext)).not.toContain('"from":"hall"');
    expect(JSON.stringify(modelContext)).not.toContain('"to":"camp"');
    expect(JSON.stringify(modelContext)).not.toContain(head);
  });

  it("decodes only supplied turn-local handles back to host IDs before validation", async () => {
    const { engine, head } = await fixture();
    const boundary = createPlayerActionModelBoundary(await buildActorScopedActionContext(engine, "hero", head));
    const entities = boundary.context.referenceableEntities as Array<{ id: string; name: string }>;
    const claims = boundary.context.knowledge as Array<{ claimId: string }>;
    const actorHandle = boundary.context.actorId as string;
    const hallHandle = entities.find((entity) => entity.name === "Hall")!.id;
    const campHandle = entities.find((entity) => entity.name === "Camp")!.id;
    const decoded = boundary.decodeCandidate({
      title: "Hero walks from the Hall to Camp",
      intent: {
        kind: "act",
        summary: "Walk from the Hall to Camp",
        targets: [{ kind: "entity", entityId: campHandle }],
        sceneTransition: { kind: "arrive", destination: { kind: "entity", entityId: campHandle } },
      },
      participants: [campHandle],
      preconditions: [{ op: "fact-equals", entityId: actorHandle, field: "character.location", value: hallHandle }],
      proposedDelta: {
        version: 1,
        operations: [{ op: "set", entityId: actorHandle, field: "character.location", value: campHandle }],
      },
      requiresKnowledge: [claims[0]!.claimId],
      forbidsKnowledge: [],
    });

    expect(decoded).toEqual(moveToCamp());
  });

  it("does not decode guessed admitted stable IDs that were not supplied as handles", async () => {
    const { engine, head } = await fixture();
    const boundary = createPlayerActionModelBoundary(await buildActorScopedActionContext(engine, "hero", head));
    const decoded = boundary.decodeCandidate({
      title: "Try a stable identifier",
      participants: [],
      preconditions: [],
      proposedDelta: {
        version: 1,
        operations: [{ op: "set", entityId: "hero", field: "character.plan", value: "Wait" }],
      },
      requiresKnowledge: ["known-route"],
      forbidsKnowledge: [],
    });

    expect(decoded.proposedDelta.operations[0]).toEqual(expect.objectContaining({
      entityId: "invalid-model-entity-handle",
    }));
    expect(decoded.requiresKnowledge).toEqual(["invalid-model-claim-handle"]);
  });

  it("discovers entity references in owner-visible state before replacing every stable ID with a turn handle", async () => {
    const { engine, head } = await fixture();
    const revealed = await engine.commitProposal({
      proposalId: "record-custodian",
      branchId: "main",
      expectedParentCommit: head,
      source: "background",
      title: "The owned key records its custodian",
      actorObservations: [{ actorId: "hero", summary: "The owned key records its custodian" }],
      participants: ["hero"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: {
        version: 1,
        operations: [{ op: "set", entityId: "silver-key", field: "artifact.custodian", value: "villain" }],
      },
      causalParents: [],
      evidence: [],
    });
    expect(revealed.report.accepted).toBe(true);
    const scoped = await buildActorScopedActionContext(engine, "hero", revealed.newHead);
    expect(scoped.ownedEntityState["silver-key"]?.["artifact.custodian"]).toBe("villain");
    expect(scoped.referenceableEntities).toContainEqual(expect.objectContaining({ id: "villain", name: "Hidden Villain" }));

    const model = createPlayerActionModelBoundary(scoped).context;
    const owned = model.ownedEntityState as Record<string, Record<string, unknown>>;
    const silverKeyHandle = (model.referenceableEntities as Array<{ id: string; name: string }>)
      .find((entity) => entity.name === "银钥")!.id;
    expect(owned[silverKeyHandle]?.["artifact.custodian"]).toMatch(/^entity-\d{3}$/);
    expect(JSON.stringify(model)).not.toContain('"artifact.custodian":"villain"');
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

  it("rejects counterpart character IDs in character.relationships", async () => {
    const { engine, head } = await fixture();
    const context = await buildActorScopedActionContext(engine, "hero", head);
    const issues = validatePlayerActionScope({
      title: "Record Mo Yan as a relationship",
      participants: [],
      preconditions: [],
      proposedDelta: {
        version: 1,
        operations: [{ op: "add-member", entityId: "hero", field: "character.relationships", member: "mo-yan" }],
      },
      requiresKnowledge: [],
      forbidsKnowledge: [],
    }, context);

    expect(issues).toContainEqual(expect.objectContaining({
      code: "PLAYER_RELATIONSHIP_REFERENCE_INVALID",
      path: "proposedDelta.operations.0.member",
    }));
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
      expect(input.context).not.toHaveProperty("atCommit");
      expect(input.context.scene).not.toHaveProperty("beat");
      expect(input.context.recentVisibleEvents.every((event) => !Object.hasOwn(event, "step"))).toBe(true);
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
    expect(result.proposal?.title).toBe("Attempted player intent (not an asserted outcome): I leave the hall and walk to camp.");
    expect(result.proposal?.title).not.toBe("Hero walks from the Hall to Camp");
    expect(result.validation?.accepted).toBe(true);
    expect(result.eventHash).toBeDefined();
    expect(result.renderedText).toContain("Attempted player intent (not an asserted outcome): I leave the hall and walk to camp.");
    expect(result.renderedText).not.toContain("Hero walks from the Hall to Camp");
    expect((await engine.projector.project(result.newHead)).values.hero?.["character.location"]).toBe("camp");
    expect(observedContext).not.toContain("future-secret");
    expect(observedContext).not.toContain("future-ambush");
  });

  it("realizes an ordinary typed intent through world adjudication before commitment", async () => {
    const { engine } = await fixture();
    const service = new PlayerTurnService(
      engine,
      () => moveToCamp(),
      undefined,
      undefined,
      undefined,
      (input) => {
        expect(input.world.deterministicIssues).toEqual([]);
        expect(input.world.entities.map((entity) => entity.id)).toEqual(expect.arrayContaining(["hero", "camp"]));
        return {
          decision: "realize",
          status: "succeeded",
          eventTitle: "Hero reaches Camp",
          actorObservation: "The Hall falls behind you as Camp opens ahead.",
        };
      },
    );

    const result = await service.turn({ branchId: "main", actorId: "hero", utterance: "Head for Camp." });

    expect(result.accepted).toBe(true);
    expect(result.adjudication).toMatchObject({ decision: "realize", status: "succeeded" });
    expect(result.proposal?.title).toBe("Hero reaches Camp");
    expect(result.proposal?.progress?.outcome).toBe("succeeded");
    expect((await engine.projector.project(result.newHead)).values.hero?.["character.location"]).toBe("camp");
  });

  it("validates the player renderer result and detects branch mutation", async () => {
    const invalidFixture = await fixture();
    const invalidRender = (() => ({ text: "not a string" })) as unknown as NonNullable<ConstructorParameters<typeof PlayerTurnService>[2]>;
    const invalidService = new PlayerTurnService(invalidFixture.engine, () => moveToCamp(), invalidRender);
    await expect(invalidService.turn({
      branchId: "main",
      actorId: "hero",
      utterance: "I leave the hall and walk to camp.",
    })).rejects.toThrow("Player turn renderer must return a string");

    const mutationFixture = await fixture();
    const foreignHead = "c".repeat(64);
    let committedHead = "";
    const mutationService = new PlayerTurnService(mutationFixture.engine, () => moveToCamp(), async (input) => {
      committedHead = input.commitId;
      await mutationFixture.engine.branches.updateHead(input.branchId, input.commitId, foreignHead);
      return "Rendered scene";
    });
    await expect(mutationService.turn({
      branchId: "main",
      actorId: "hero",
      utterance: "I leave the hall and walk to camp.",
    })).rejects.toThrow("Player turn renderer mutated branch truth");
    expect(await mutationFixture.engine.branches.readHead("main")).toBe(foreignHead);
    await mutationFixture.engine.branches.updateHead("main", foreignHead, committedHead);
  });

  it("preserves the story-time anchor and lets repeated perception become a new world beat", async () => {
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
      intent: { kind: "observe", summary: "Observe the current scene", targets: [], sceneTransition: { kind: "stay" } },
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
    expect(second.accepted).toBe(true);
    expect(second.newHead).not.toBe(first.newHead);
    expect(second.proposal?.progress?.noveltyKey).not.toBe(first.proposal?.progress?.noveltyKey);
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
      deterministicPlayerIntentCandidate("wait", { utterance: "等待1年", context }, { amount: 1, unit: "year" }));

    const result = await service.turn({ branchId: "main", actorId: "hero", utterance: "等待1年" });

    expect(result.accepted).toBe(true);
    expect(result.proposal?.timeAdvance).toEqual({ amount: 1, unit: "year" });
    expect(result.proposal?.proposedTime).toEqual({ kind: "exact", value: "1951", precision: "year" });
    const state = await engine.projector.project(result.newHead);
    expect(state.logicalTime.storyTime).toEqual({ kind: "exact", value: "1951", precision: "year" });
    expect(state.logicalTime.elapsedDays).toBeCloseTo(365.2425);
  });

  it("allows a destination acquired through actor knowledge without exposing its state", async () => {
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
      intent: {
        kind: "act",
        summary: "Walk out toward the street",
        targets: [{ kind: "described", description: "街上" }],
        sceneTransition: { kind: "depart", destination: { kind: "described", description: "街上" } },
      },
      participants: [],
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      requiresKnowledge: [],
      forbidsKnowledge: [],
    }));

    const result = await service.turn({ branchId: "main", actorId: "hero", utterance: "我出门去街上走走。" });

    expect(result.accepted).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.proposal?.proposedDelta.operations).toEqual([]);
    expect(result.progressCertificate).toMatchObject({ sceneChanged: true, effectiveStateOperations: 0 });
    expect(result.proposal?.progress?.scene).toMatchObject({ kind: "depart", label: "街上", sceneId: expect.stringMatching(/^open-/) });
    const scene = await projectActorScene(engine, "hero", result.newHead);
    expect(scene.locationId).toBeUndefined();
    expect(scene.label).toBe("街上");
    expect(scene.presentEntityIds).toEqual(["hero"]);
  });

  it("uses typed scene intent instead of matching destination words in any language", async () => {
    const { engine } = await fixture();
    const service = new PlayerTurnService(engine, () => ({
      title: "Hero walks toward the reception room",
      intent: {
        kind: "act",
        summary: "Approach the reception room",
        targets: [{ kind: "described", description: "传达室" }],
        sceneTransition: { kind: "explore", destination: { kind: "described", description: "传达室" } },
      },
      participants: [],
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      requiresKnowledge: [],
      forbidsKnowledge: [],
    }));

    const result = await service.turn({ branchId: "main", actorId: "hero", utterance: "Proceed with it." });

    expect(result.accepted).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.proposal?.progress?.scene).toMatchObject({ kind: "explore", label: "传达室", sceneId: expect.stringMatching(/^open-/) });
    const scene = await projectActorScene(engine, "hero", result.newHead);
    expect(scene.label).toBe("传达室");
  });

  it("commits an LLM-proposed in-world consequence when a desired result directly contradicts world state", async () => {
    const { engine, head } = await fixture();
    const death = await engine.commitProposal({
      proposalId: "mo-yan-dies",
      branchId: "main",
      expectedParentCommit: head,
      source: "background",
      title: "墨砚停止了呼吸",
      actorObservations: [{ actorId: "hero", summary: "墨砚的呼吸停了，身体再没有回应。" }],
      participants: ["hero", "mo-yan"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: {
        version: 1,
        operations: [{ op: "set", entityId: "mo-yan", field: "character.alive", value: false }],
      },
      causalParents: [],
      evidence: [],
    });
    expect(death.report.accepted).toBe(true);
    let adjudicated = false;
    const service = new PlayerTurnService(
      engine,
      () => ({
        title: "尝试让墨砚复活",
        intent: {
          kind: "act",
          summary: "立刻让已经死亡的墨砚恢复生命",
          targets: [{ kind: "entity", entityId: "mo-yan" }],
        },
        participants: [],
        preconditions: [],
        proposedDelta: { version: 1, operations: [] },
        requiresKnowledge: [],
        forbidsKnowledge: [],
      }),
      undefined,
      undefined,
      undefined,
      (input) => {
        adjudicated = true;
        expect(input.world.entities.find((entity) => entity.id === "mo-yan")?.state["character.alive"]).toBe(false);
        expect(JSON.stringify(input.world)).not.toContain("future-ambush");
        return {
          decision: "transform",
          status: "blocked",
          contradiction: {
            kind: "capability",
            summary: "当前世界没有能以普通行动逆转死亡的能力。",
            basis: [
              { source: "state", entityId: "mo-yan", field: "character.alive" },
              { source: "causal-principle", principle: "普通人的即时行动不能让死亡者恢复生命。" },
            ],
          },
          replacement: {
            title: "徒劳的急救",
            intent: {
              kind: "act",
              summary: "跪下反复施救，却只能确认墨砚没有生命反应",
              targets: [{ kind: "entity", entityId: "mo-yan" }],
            },
            participants: [],
            preconditions: [],
            proposedDelta: { version: 1, operations: [] },
            requiresKnowledge: [],
            forbidsKnowledge: [],
          },
          eventTitle: "徒劳的急救没有唤回墨砚",
          actorObservation: "你一遍遍按压、呼喊，掌下的身体依旧冰冷而沉默。",
        };
      },
    );

    const result = await service.turn({ branchId: "main", actorId: "hero", utterance: "我要复活墨砚。" });

    expect(adjudicated).toBe(true);
    expect(result.accepted).toBe(true);
    expect(result.adjudication).toMatchObject({ decision: "transform", status: "blocked" });
    expect(result.proposal?.title).toBe("徒劳的急救没有唤回墨砚");
    expect(result.proposal?.actorObservations).toEqual([{
      actorId: "hero",
      summary: "你一遍遍按压、呼喊，掌下的身体依旧冰冷而沉默。",
    }]);
    expect(result.proposal?.progress).toMatchObject({ outcome: "blocked", channels: expect.arrayContaining(["consequence"]) });
    expect(result.renderedText).toContain("掌下的身体依旧冰冷而沉默");
    expect((await engine.projector.project(result.newHead)).values["mo-yan"]?.["character.alive"]).toBe(false);
  });

  it("refuses an ungrounded transform certificate instead of letting adjudication invent a contradiction", async () => {
    const { engine, head } = await fixture();
    const service = new PlayerTurnService(
      engine,
      () => moveToCamp(),
      undefined,
      undefined,
      undefined,
      () => ({
        decision: "transform",
        status: "blocked",
        contradiction: {
          kind: "state",
          summary: "Invented blocker",
          basis: [{ source: "state", entityId: "hero", field: "character.nonexistent" }],
        },
        replacement: {
          title: "Nothing happens",
          intent: { kind: "act", summary: "Nothing happens", targets: [] },
          participants: [],
          preconditions: [],
          proposedDelta: { version: 1, operations: [] },
          requiresKnowledge: [],
          forbidsKnowledge: [],
        },
        eventTitle: "Nothing happens",
        actorObservation: "Nothing changes.",
      }),
    );

    const result = await service.turn({ branchId: "main", actorId: "hero", utterance: "Walk to Camp." });

    expect(result.accepted).toBe(false);
    expect(result.stage).toBe("adjudication");
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "PLAYER_WORLD_CONTRADICTION_UNGROUNDED" }));
    expect(await engine.branches.readHead("main")).toBe(head);
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
    const learnedRumor = await engine.commitProposal({
      proposalId: "hear-villain-rumor",
      branchId: "main",
      expectedParentCommit: head,
      source: "background",
      title: "Hero hears a rumor about the Hidden Villain",
      actorObservations: [{ actorId: "hero", summary: "Hero hears a rumor about the Hidden Villain" }],
      participants: ["hero"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      proposedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "hero", claimId: "false-rumor", status: "heard", confidence: 0.4 }] },
      causalParents: [],
      evidence: [],
    });
    expect(learnedRumor.report.accepted).toBe(true);
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
    expect(await engine.branches.readHead("main")).toBe(learnedRumor.newHead);
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
          { op: "unset", entityId: "villain", field: "character.location" },
        ],
      },
      proposedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "hero", claimId: "false-rumor", status: "heard", confidence: 0.4 }] },
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

  it("does not let a canon resolver mutate an already scoped player proposal", async () => {
    const { engine } = await fixture();
    let mutationRejected = false;
    const service = new PlayerTurnService(
      engine,
      () => moveToCamp(),
      undefined,
      (proposal) => {
        expect(Object.isFrozen(proposal)).toBe(true);
        expect(Object.isFrozen(proposal.proposedDelta.operations)).toBe(true);
        try {
          proposal.proposedDelta.operations.push({
            op: "set",
            entityId: "villain",
            field: "character.location",
            value: "hall",
          });
        } catch {
          mutationRejected = true;
        }
        return { supersedesCanonicalEventIds: [] };
      },
    );

    const result = await service.turn({ branchId: "main", actorId: "hero", utterance: "I walk to Camp." });

    expect(mutationRejected).toBe(true);
    expect(result.accepted).toBe(true);
    expect(result.proposal?.proposedDelta.operations).toHaveLength(1);
    expect(result.proposal?.proposedDelta.operations[0]).toMatchObject({ entityId: "hero", value: "camp" });
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
      title: "Hero goes to the Secret Lair",
      participants: ["secret-lair"],
      preconditions: [],
      proposedDelta: {
        version: 1,
        operations: [{ op: "set", entityId: "hero", field: "character.location", value: "secret-lair" }],
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
    expect(unowned.contextBefore.referenceableEntities.map((entity) => entity.id)).not.toContain("black-key");
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

  it("constrains adjust-number fields to the host-supplied writable schema", () => {
    const capture = createPlayerActionCaptureTool(undefined, ["artifact.quantity"]);
    const validator = Compile(capture.tool.parameters);
    const adjusted = {
      ...moveToCamp(),
      preconditions: [],
      proposedDelta: {
        version: 1,
        operations: [{ op: "adjust-number", entityId: "silver-key", field: "artifact.quantity", amount: 1 }],
      },
    };
    expect(validator.Check(adjusted)).toBe(true);
    expect(validator.Check({
      ...adjusted,
      proposedDelta: {
        version: 1,
        operations: [{ op: "adjust-number", entityId: "silver-key", field: "character.wealth", amount: 1 }],
      },
    })).toBe(false);
  });
});
