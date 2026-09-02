import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActorModelStore, deterministicActorProposalSource, evaluateCharacterGoal, type ActorProposalCandidate, type CharacterGoal } from "../src/world/actors.js";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import type { Claim, Entity, EventProposal } from "../src/world/model.js";
import { WorldRuntime, adjudicateActorCandidates } from "../src/world/runtime.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

const novelEvidence = [{
  span: { sourceId: "novel", startLine: 1, endLine: 1, quoteHash: "actor-policy" },
  strength: "explicit" as const,
}];

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-actor-"));
  roots.push(root);
  const entities: Entity[] = [
    { id: "alice", kind: "character", canonicalName: "Alice", aliases: [], evidence: novelEvidence },
    { id: "home", kind: "location", canonicalName: "Home", aliases: [], evidence: novelEvidence },
    { id: "meeting", kind: "location", canonicalName: "Meeting", aliases: [], evidence: novelEvidence },
  ];
  const invitation: Claim = { id: "invited", subject: "alice", predicate: "invited-to-meeting", object: true, epistemicType: "explicit-fact", evidence: novelEvidence };
  const context: WorldModelContext = {
    sourceId: "novel",
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    claims: new Map([[invitation.id, invitation]]),
    rules: new Map(),
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
  };
  const engine = new WorldEngine(root, context);
  const head = await engine.createBranch("main", "Main", {
    version: 1,
    operations: [
      { op: "set", entityId: "alice", field: "character.alive", value: true },
      { op: "set", entityId: "alice", field: "character.location", value: "home" },
    ],
  });
  const actorStore = new ActorModelStore(root);
  await actorStore.putGoal({
    id: "attend-meeting",
    actorId: "alice",
    description: "Attend the meeting after learning about it",
    priority: 0.9,
    requiresKnowledge: ["invited"],
    candidateAction: {
      title: "Alice goes to the meeting",
      preconditions: [{ op: "fact-equals", entityId: "alice", field: "character.location", value: "home" }],
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "alice", field: "character.location", value: "meeting" }] },
    },
    evidence: [{ span: { sourceId: "novel", startLine: 1, endLine: 1, quoteHash: "goal-evidence" }, strength: "strong-inference" }],
  });
  const runtime = new WorldRuntime(engine, () => [], undefined, deterministicActorProposalSource(engine, actorStore));
  return { engine, runtime, head };
}

describe("actor policy", () => {
  it("keeps future-window goals latent until branch story time or their relative anchor is committed", () => {
    const base: CharacterGoal = {
      id: "future-goal",
      actorId: "alice",
      description: "Act in a later phase",
      priority: 0.8,
      requiresKnowledge: [],
      activation: {
        preconditions: [],
        afterCanonicalEventIds: [],
        storyWindow: { kind: "exact", value: "2050", precision: "year" },
      },
      evidence: [{ span: { sourceId: "novel", startLine: 50, endLine: 50, quoteHash: "future-goal" }, strength: "explicit" }],
    };
    const state = { atCommit: "head", logicalTime: { step: 0 }, values: {}, activeRuleIds: [] };

    expect(evaluateCharacterGoal(base, { state, knownClaimIds: new Set() }).active).toBe(false);
    expect(evaluateCharacterGoal(base, {
      state,
      knownClaimIds: new Set(),
      storyTime: { kind: "exact", value: "2050", precision: "year" },
    }).active).toBe(true);

    const relative: CharacterGoal = {
      ...base,
      activation: {
        preconditions: [],
        afterCanonicalEventIds: [],
        storyWindow: { kind: "relative", anchorEventId: "phase-anchor", relation: "after" },
      },
    };
    expect(evaluateCharacterGoal(relative, { state, knownClaimIds: new Set() }).active).toBe(false);
    expect(evaluateCharacterGoal(relative, {
      state,
      knownClaimIds: new Set(),
      realizedCanonicalEventIds: new Set(["phase-anchor"]),
    }).active).toBe(true);

    const personal: CharacterGoal = {
      ...base,
      activation: {
        preconditions: [],
        afterCanonicalEventIds: [],
        afterExperiencedCanonicalEventIds: ["betrayal"],
      },
    };
    expect(evaluateCharacterGoal(personal, {
      state,
      knownClaimIds: new Set(),
      realizedCanonicalEventIds: new Set(["betrayal"]),
      experiencedCanonicalEventIds: new Set(),
    })).toMatchObject({
      active: false,
      reasons: [expect.stringContaining("personally experienced")],
    });
    expect(evaluateCharacterGoal(personal, {
      state,
      knownClaimIds: new Set(),
      realizedCanonicalEventIds: new Set(["betrayal"]),
      experiencedCanonicalEventIds: new Set(["betrayal"]),
    }).active).toBe(true);
  });

  it("does not act on compiler knowledge the actor has not acquired", async () => {
    const { engine, runtime, head } = await fixture();
    const beforeKnowledge = await runtime.move({ branchId: "main", maxActorCandidates: 1, maxBackgroundCandidates: 0 });
    expect(beforeKnowledge.newHead).toBe(head);

    const learned = await engine.commitProposal({
      proposalId: "learn-invitation",
      branchId: "main",
      expectedParentCommit: head,
      source: "background",
      title: "Alice receives the invitation",
      participants: ["alice"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      proposedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "alice", claimId: "invited", status: "knows", confidence: 1 }] },
      causalParents: [],
      evidence: [],
    });
    expect(learned.report.accepted).toBe(true);

    const afterKnowledge = await runtime.move({ branchId: "main", maxActorCandidates: 1, maxBackgroundCandidates: 0 });
    expect(afterKnowledge.committedEvents).toHaveLength(1);
    expect((await engine.projector.project(afterKnowledge.newHead)).values.alice?.["character.location"]).toBe("meeting");
  });

  it("does not treat a disbelieved claim as actionable knowledge", async () => {
    const { engine, runtime, head } = await fixture();
    const learned = await engine.commitProposal({
      proposalId: "reject-invitation",
      branchId: "main",
      expectedParentCommit: head,
      source: "background",
      title: "Alice dismisses the invitation as false",
      participants: ["alice"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      proposedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "alice", claimId: "invited", status: "disbelieves", confidence: 1 }] },
      causalParents: [],
      evidence: [],
    });
    expect(learned.report.accepted).toBe(true);
    const result = await runtime.move({ branchId: "main", maxActorCandidates: 1, maxBackgroundCandidates: 0 });
    expect(result.newHead).toBe(learned.newHead);
    expect((await engine.projector.project(result.newHead)).values.alice?.["character.location"]).toBe("home");
  });

  it("does not turn a model profile alone into a generic NPC reaction event", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-actor-reaction-"));
    roots.push(root);
    const entities: Entity[] = [
      { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: novelEvidence },
      { id: "rival", kind: "character", canonicalName: "Rival", aliases: [], evidence: novelEvidence },
      { id: "room", kind: "location", canonicalName: "Room", aliases: [], evidence: novelEvidence },
    ];
    const context: WorldModelContext = {
      sourceId: "novel",
      entities: new Map(entities.map((entity) => [entity.id, entity])),
      rules: new Map(),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    };
    const engine = new WorldEngine(root, context);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "hero", field: "character.location", value: "room" },
        { op: "set", entityId: "rival", field: "character.alive", value: true },
        { op: "set", entityId: "rival", field: "character.location", value: "room" },
      ],
    });
    const store = new ActorModelStore(root);
    await store.putModel({
      actorId: "rival",
      traits: { responsive: 0.8 },
      decisionBiases: {},
      evidence: [{ span: { sourceId: "novel", startLine: 1, endLine: 1, quoteHash: "rival-model" }, strength: "strong-inference" }],
    });
    const player = await engine.commitProposal({
      proposalId: "player-confronts-rival",
      branchId: "main",
      expectedParentCommit: genesis,
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
        outcome: "succeeded",
        scene: { kind: "stay", beat: 2 },
      },
    });
    expect(player.report.accepted).toBe(true);
    const runtime = new WorldRuntime(engine, () => [], undefined, deterministicActorProposalSource(engine, store));

    const result = await runtime.move({ branchId: "main", maxActorCandidates: 1, maxBackgroundCandidates: 0 });

    expect(result.committedEvents).toEqual([]);
    expect(result.newHead).toBe(player.newHead);
  });
});

describe("actor adjudication", () => {
  it("selects the higher-priority writer and reports the conflicting loser", () => {
    const proposal = (id: string, target: string): EventProposal => ({
      proposalId: id,
      branchId: "main",
      expectedParentCommit: "head",
      source: "actor",
      actorId: id,
      title: id,
      participants: [id],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "shared", field: "character.location", value: target }] },
      causalParents: [],
      evidence: [],
    });
    const candidates: ActorProposalCandidate[] = [
      { goalId: "low", priority: 0.2, proposal: proposal("low", "a") },
      { goalId: "high", priority: 0.9, proposal: proposal("high", "b") },
    ];
    const result = adjudicateActorCandidates(candidates, 2);
    expect(result.selected.map((candidate) => candidate.proposal.proposalId)).toEqual(["high"]);
    expect(result.conflicts).toEqual([{ winnerProposalId: "high", loserProposalId: "low", writeKeys: ["state:shared:character.location"] }]);
  });
});
