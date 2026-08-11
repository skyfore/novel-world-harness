import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActorModelStore, deterministicActorProposalSource, type ActorProposalCandidate } from "../src/world/actors.js";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import type { Claim, Entity, EventProposal } from "../src/world/model.js";
import { WorldRuntime, adjudicateActorCandidates } from "../src/world/runtime.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-actor-"));
  roots.push(root);
  const entities: Entity[] = [
    { id: "alice", kind: "character", canonicalName: "Alice", aliases: [], evidence: [] },
    { id: "home", kind: "location", canonicalName: "Home", aliases: [], evidence: [] },
    { id: "meeting", kind: "location", canonicalName: "Meeting", aliases: [], evidence: [] },
  ];
  const invitation: Claim = { id: "invited", subject: "alice", predicate: "invited-to-meeting", object: true, epistemicType: "explicit-fact", evidence: [] };
  const context: WorldModelContext = {
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

