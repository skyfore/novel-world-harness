import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CharacterGoal } from "../src/world/actors.js";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { modelActorProposalSource, type ActorReasoningInput } from "../src/world/model-actor-policy.js";
import type { Claim, Entity } from "../src/world/model.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("model actor policy", () => {
  it("passes actor-scoped knowledge rather than compiler omniscience to the reasoner", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-model-actor-"));
    roots.push(root);
    const entities: Entity[] = [
      { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] },
      { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: [] },
    ];
    const publicClaim: Claim = { id: "public", subject: "hero", predicate: "invited", object: true, epistemicType: "explicit-fact", evidence: [] };
    const secretClaim: Claim = { id: "secret", subject: "hero", predicate: "future-betrayal", object: true, epistemicType: "explicit-fact", evidence: [] };
    const context: WorldModelContext = {
      entities: new Map(entities.map((entity) => [entity.id, entity])),
      claims: new Map([[publicClaim.id, publicClaim], [secretClaim.id, secretClaim]]),
      rules: new Map(),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    };
    const engine = new WorldEngine(root, context);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "hero", field: "character.location", value: "hall" },
      ],
    });
    const learned = await engine.commitProposal({
      proposalId: "learn-public",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "background",
      title: "Hero learns invitation",
      participants: ["hero"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      proposedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "hero", claimId: "public", status: "knows", confidence: 1 }] },
      causalParents: [],
      evidence: [],
    });

    const goal: CharacterGoal = {
      id: "respond",
      actorId: "hero",
      description: "Respond to the invitation",
      priority: 1,
      requiresKnowledge: ["public"],
      evidence: [{ span: { sourceId: "test", startLine: 1, endLine: 1, quoteHash: "x" }, strength: "strong-inference" }],
    };
    let observed: ActorReasoningInput | undefined;
    const source = modelActorProposalSource(engine, {
      goals: async () => [goal],
      modelFor: async () => null,
      reasoner(input) {
        observed = input;
        return {
          title: "Hero responds",
          participants: [],
          preconditions: [],
          proposedDelta: { version: 1, operations: [] },
        };
      },
    });
    const candidates = await source({ branchId: "main", commitId: learned.newHead });
    expect(candidates).toHaveLength(1);
    expect(observed?.actor.knowledge.map((entry) => entry.fact.claimId)).toEqual(["public"]);
    expect(JSON.stringify(observed)).not.toContain("future-betrayal");
    expect(observed).not.toHaveProperty("worldState");
  });
});
