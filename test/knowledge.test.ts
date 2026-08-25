import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { KnowledgeProjector } from "../src/world/knowledge.js";
import type { Attribution, Claim, Entity, Proposition } from "../src/world/model.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-knowledge-"));
  roots.push(root);
  const entities: Entity[] = [
    { id: "alice", kind: "character", canonicalName: "Alice", aliases: [], evidence: [] },
    { id: "bob", kind: "character", canonicalName: "Bob", aliases: [], evidence: [] },
    { id: "secret-room", kind: "location", canonicalName: "Secret Room", aliases: [], evidence: [] },
  ];
  const secret: Claim = { id: "secret-exists", subject: "secret-room", predicate: "exists", object: true, epistemicType: "explicit-fact", evidence: [] };
  const proposition: Proposition = {
    id: "secret-room-exists",
    subjectEntityId: "secret-room",
    relationId: "exists",
    object: { kind: "literal", value: true },
    polarity: "positive",
    modality: "asserted",
    evidence: [],
  };
  const attribution: Attribution = {
    id: "alice-reports-secret-room",
    propositionId: proposition.id,
    holderKind: "character",
    holderEntityId: "alice",
    attitude: "reports",
    certainty: 1,
    evidence: [],
  };
  const context: WorldModelContext = {
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    rules: new Map(),
    claims: new Map([[secret.id, secret]]),
    propositions: new Map([[proposition.id, proposition]]),
    attributions: new Map([[attribution.id, attribution]]),
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
  };
  const engine = new WorldEngine(root, context);
  const genesis = await engine.createBranch("main", "Main", {
    version: 1,
    operations: [
      { op: "set", entityId: "alice", field: "character.alive", value: true },
      { op: "set", entityId: "bob", field: "character.alive", value: true },
    ],
  });
  return { engine, genesis };
}

describe("KnowledgeProjector", () => {
  it("commits knowledge for one actor without leaking it to another", async () => {
    const { engine, genesis } = await fixture();
    const result = await engine.commitProposal({
      proposalId: "alice-learns",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "background",
      title: "Alice learns the secret",
      participants: ["alice"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      proposedKnowledge: {
        version: 1,
        operations: [{ op: "learn", actorId: "alice", claimId: "secret-exists", status: "knows", confidence: 1 }],
      },
      causalParents: [],
      evidence: [],
    });
    expect(result.report.accepted).toBe(true);
    const projector = new KnowledgeProjector(engine);
    const alice = await projector.view("alice", result.newHead);
    const bob = await projector.view("bob", result.newHead);
    expect(alice.knowledge.map((entry) => entry.fact.claimId)).toEqual(["secret-exists"]);
    expect(alice.knowledge[0]?.claim?.predicate).toBe("exists");
    expect(bob.knowledge).toEqual([]);
    expect(Object.keys(alice.selfState)).toContain("character.alive");
    expect(alice).not.toHaveProperty("worldState");
  });

  it("forked histories inherit prior knowledge and can diverge after the fork", async () => {
    const { engine, genesis } = await fixture();
    const first = await engine.commitProposal({
      proposalId: "alice-learns",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "background",
      title: "Alice learns",
      participants: ["alice"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      proposedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "alice", claimId: "secret-exists", status: "knows", confidence: 1 }] },
      causalParents: [],
      evidence: [],
    });
    await engine.branches.create({ id: "alt", name: "Alt", parentBranchId: "main", forkCommitId: first.newHead, headCommitId: first.newHead });
    const forgotten = await engine.commitProposal({
      proposalId: "alice-forgets",
      branchId: "alt",
      expectedParentCommit: first.newHead,
      source: "background",
      title: "Alice forgets",
      participants: ["alice"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      proposedKnowledge: { version: 1, operations: [{ op: "forget", actorId: "alice", claimId: "secret-exists" }] },
      causalParents: [],
      evidence: [],
    });
    const projector = new KnowledgeProjector(engine);
    expect((await projector.view("alice", first.newHead)).knowledge).toHaveLength(1);
    expect((await projector.view("alice", forgotten.newHead)).knowledge).toHaveLength(0);
  });

  it("projects proposition, attribution, and acquisition provenance without leaking world truth", async () => {
    const { engine, genesis } = await fixture();
    const result = await engine.commitProposal({
      proposalId: "bob-is-told",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "background",
      title: "Alice tells Bob about the room",
      participants: ["alice", "bob"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      proposedKnowledge: {
        version: 1,
        operations: [{
          op: "learn",
          actorId: "bob",
          claimId: "secret-exists",
          propositionId: "secret-room-exists",
          attributionId: "alice-reports-secret-room",
          acquisitionMode: "told",
          sourceActorId: "alice",
          status: "heard",
          confidence: 0.9,
        }],
      },
      causalParents: [],
      evidence: [],
    });

    expect(result.report.accepted).toBe(true);
    const view = await new KnowledgeProjector(engine).view("bob", result.newHead);
    expect(view.knowledge).toEqual([
      expect.objectContaining({
        fact: expect.objectContaining({
          propositionId: "secret-room-exists",
          attributionId: "alice-reports-secret-room",
          acquisitionMode: "told",
          sourceActorId: "alice",
        }),
        claim: expect.objectContaining({ id: "secret-exists" }),
        proposition: expect.objectContaining({ id: "secret-room-exists" }),
        attribution: expect.objectContaining({ id: "alice-reports-secret-room" }),
      }),
    ]);
    expect(view).not.toHaveProperty("worldState");
  });
});
