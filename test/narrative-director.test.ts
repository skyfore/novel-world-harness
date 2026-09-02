import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalEventToPossibility } from "../src/world/canon-runtime.js";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { KnowledgeProjector } from "../src/world/knowledge.js";
import type { CanonicalEvent, Claim, Entity } from "../src/world/model.js";
import { buildNarrativeDirection, publicNarrativeThread, publicPlayerAffordance } from "../src/world/narrative-director.js";
import { PlayerTurnService } from "../src/world/player-action.js";
import { WorldRuntime } from "../src/world/runtime.js";
import { projectActorScene } from "../src/world/scene.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import type { CharacterGoal } from "../src/world/actors.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-director-"));
  roots.push(root);
  const overlappingEvidence = [{
    span: { sourceId: "novel-a", startLine: 7, endLine: 7, quoteHash: "shared-scene-line" },
    strength: "explicit" as const,
  }];
  const entities: Entity[] = [
    { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: overlappingEvidence },
    { id: "rival", kind: "character", canonicalName: "Rival", aliases: [], evidence: overlappingEvidence },
    { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: overlappingEvidence },
    { id: "camp", kind: "location", canonicalName: "Camp", aliases: [], evidence: overlappingEvidence },
  ];
  const route: Claim = {
    id: "route-to-camp",
    subject: "hero",
    predicate: "knows-route-to",
    object: "camp",
    epistemicType: "explicit-fact",
    evidence: overlappingEvidence,
  };
  const concealedClaim: Claim = {
    id: "concealed-meaning",
    subject: "hero",
    predicate: "hidden-meaning-of-scene",
    object: true,
    epistemicType: "interpretation",
    evidence: overlappingEvidence,
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
    evidence: overlappingEvidence,
    causalParents: [],
    confidence: 1,
  };
  const hiddenPolicyGoal: CharacterGoal = {
    id: "hidden-policy-goal",
    actorId: "hero",
    description: "Secret compiler arc: betray Rival after the future coronation",
    priority: 1,
    requiresKnowledge: [],
    activation: {
      preconditions: [{ op: "fact-equals", entityId: "hero", field: "character.alive", value: true }],
      afterCanonicalEventIds: [],
    },
    evidence: [{
      span: { sourceId: "novel-a", startLine: 99, endLine: 99, quoteHash: "hidden-policy" },
      strength: "inferred",
    }],
  };
  const context: WorldModelContext = {
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    claims: new Map([[route.id, route], [concealedClaim.id, concealedClaim]]),
    events: new Map([[leave.id, leave]]),
    rules: new Map(),
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    actorGoals: [hiddenPolicyGoal],
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
  return { engine, runtime, head, leave, overlappingEvidence, concealedClaim };
}

describe("narrative scene director", () => {
  it("never turns overlapping source evidence into implicit character knowledge", async () => {
    const { engine, runtime, head, overlappingEvidence, concealedClaim } = await fixture();
    const perceived = await engine.commitProposal({
      proposalId: "ambiguous-scene",
      branchId: "main",
      expectedParentCommit: head,
      source: "background",
      title: "Omniscient hidden meaning",
      actorObservations: [{ actorId: "hero", summary: "Hero notices an ambiguous movement." }],
      participants: ["hero"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: {
        version: 1,
        operations: [{ op: "set", entityId: "hall", field: "location.condition", value: 0.99 }],
      },
      causalParents: [],
      evidence: overlappingEvidence,
    });
    expect(perceived.report.accepted).toBe(true);
    const direction = await buildNarrativeDirection(engine, runtime, "hero", perceived.newHead);
    expect(direction.affordances.flatMap((choice) => choice.authorizedKnowledgeClaimIds)).not.toContain(concealedClaim.id);
    expect(direction.affordances.flatMap((choice) => choice.candidate.proposedKnowledge?.operations ?? [])
      .map((operation) => operation.claimId)).not.toContain(concealedClaim.id);
    expect((await new KnowledgeProjector(engine).view("hero", perceived.newHead)).knowledge.map((entry) => entry.fact.claimId))
      .not.toContain(concealedClaim.id);
  });

  it("returns executable choices without materializing a future canon delta", async () => {
    const { engine, runtime, head } = await fixture();
    const direction = await buildNarrativeDirection(engine, runtime, "hero", head);

    expect(direction.affordances.length).toBeGreaterThanOrEqual(2);
    expect(direction.affordances.filter((choice) => choice.recommended)).toHaveLength(1);
    expect(direction.affordances.every((choice) => choice.progress.channels.length > 0)).toBe(true);
    expect(direction.affordances.every((choice) => choice.progress.noveltyKey.length > 0)).toBe(true);
    expect(direction.threads.some((thread) => thread.kind === "canon-pressure")).toBe(true);
    expect(direction.threads.filter((thread) => thread.kind === "canon-pressure").map(publicNarrativeThread))
      .toEqual(direction.threads.filter((thread) => thread.kind === "canon-pressure").map(() => undefined));
    const actorVisibleDirection = JSON.stringify({
      threads: direction.threads.flatMap((thread) => publicNarrativeThread(thread) ?? []),
      affordances: direction.affordances.map(publicPlayerAffordance),
    });
    expect(actorVisibleDirection).not.toContain("Secret compiler arc");
    expect(actorVisibleDirection).not.toContain("Rival");
    expect(actorVisibleDirection).toContain("Unidentified character 1");
    expect(direction.threads.filter((thread) => thread.kind === "goal").map(publicNarrativeThread))
      .toEqual(direction.threads.filter((thread) => thread.kind === "goal").map(() => undefined));
    expect(direction.affordances.flatMap((choice) => choice.candidate.proposedDelta.operations).some((operation) =>
      operation.op === "add-member"
      && operation.field === "character.relationships"
      && operation.member === "rival")).toBe(false);
    const recommended = direction.affordances.find((choice) => choice.recommended)!;
    expect(direction.affordances.some((choice) => choice.progress.noveltyKey.startsWith("canon-step:"))).toBe(false);

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
    expect(result.newHead).not.toBe(head);
    expect(result.proposal?.possibilityId).not.toBe("canon-leave-for-camp");

    const next = await buildNarrativeDirection(engine, runtime, "hero", result.newHead);
    expect(next.affordances.map((choice) => choice.progress.noveltyKey)).not.toContain(recommended.progress.noveltyKey);
    expect(next.threads.some((thread) => thread.stage >= 1)).toBe(true);
  });

  it("turns an actor-known committed relationship into an executable evolving thread without assuming remote presence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-director-relationship-"));
    roots.push(root);
    const evidence = [{
      span: { sourceId: "novel-a", startLine: 3, endLine: 3, quoteHash: "committed-relationship" },
      strength: "explicit" as const,
    }];
    const entities: Entity[] = [
      { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence },
      { id: "ally", kind: "character", canonicalName: "Ally", aliases: [], evidence },
      { id: "family-bond", kind: "relationship", canonicalName: "Family bond", aliases: [], evidence },
    ];
    const context: WorldModelContext = {
      entities: new Map(entities.map((entity) => [entity.id, entity])),
      claims: new Map(),
      events: new Map(),
      rules: new Map(),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    };
    const engine = new WorldEngine(root, context);
    const head = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "ally", field: "character.alive", value: true },
        { op: "set", entityId: "hero", field: "character.relationships", value: ["family-bond"] },
        { op: "set", entityId: "family-bond", field: "relationship.from", value: "hero" },
        { op: "set", entityId: "family-bond", field: "relationship.to", value: "ally" },
        { op: "set", entityId: "family-bond", field: "relationship.kind", value: "family" },
        { op: "set", entityId: "family-bond", field: "relationship.active", value: true },
      ],
    });
    const runtime = new WorldRuntime(engine, () => []);

    const direction = await buildNarrativeDirection(engine, runtime, "hero", head);
    const relationshipThread = direction.threads.find((thread) => thread.kind === "relationship")!;
    const relationshipChoice = direction.affordances.find((choice) =>
      choice.progress.noveltyKey === "relationship-plan:family-bond:stage-0")!;

    expect(publicNarrativeThread(relationshipThread)).toMatchObject({
      kind: "relationship",
      summary: expect.stringContaining("Ally"),
      stage: "emerging",
    });
    expect(direction.affordances.some((choice) => choice.intent === "observe")).toBe(false);
    expect(relationshipChoice).toMatchObject({ intent: "act", recommended: true });
    expect(relationshipChoice.candidate.participants).toEqual([]);
    expect(relationshipChoice.candidate.proposedDelta.operations).toEqual([
      expect.objectContaining({ op: "set", entityId: "hero", field: "character.plan" }),
    ]);

    const result = await new PlayerTurnService(engine, () => structuredClone(relationshipChoice.candidate)).turn({
      branchId: "main",
      actorId: "hero",
      utterance: relationshipChoice.action,
    }, {
      intent: relationshipChoice.intent,
      affordanceId: relationshipChoice.id,
      progress: relationshipChoice.progress,
      authorizedKnowledgeClaimIds: relationshipChoice.authorizedKnowledgeClaimIds,
    });
    expect(result.accepted).toBe(true);
    expect(result.contextAfter.selfState["character.plan"]).toContain("Ally");

    const next = await buildNarrativeDirection(engine, runtime, "hero", result.newHead);
    expect(next.threads.find((thread) => thread.kind === "relationship")?.stage).toBe(1);
    expect(next.affordances.some((choice) =>
      choice.progress.noveltyKey === "relationship-plan:family-bond:stage-1")).toBe(true);
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
        channels: ["relationship", "thread", "consequence", "scene"],
        threadIds: ["rivalry"],
        noveltyKey: "rivalry:confront",
        scene: { kind: "stay", beat: 2 },
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
        scene: { kind: "arrive", destinationEntityId: "camp", label: "Camp", beat: 3 },
      },
    });
    const scene = await projectActorScene(engine, "hero", moved.newHead);
    expect(scene.locationId).toBe("camp");
    expect(scene.presentEntityIds).toEqual(["hero"]);
  });
});
