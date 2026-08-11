import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commitKnowledgeAwareAction } from "../src/world/action-gate.js";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import type { Claim, Entity } from "../src/world/model.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("knowledge-aware player actions", () => {
  it("rejects a declared secret-dependent action until the actor learns the claim", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-action-gate-"));
    roots.push(root);
    const entities: Entity[] = [{ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] }];
    const secret: Claim = { id: "secret", subject: "hero", predicate: "betrayal", object: true, epistemicType: "explicit-fact", evidence: [] };
    const engine = new WorldEngine(root, {
      entities: new Map(entities.map((entity) => [entity.id, entity])),
      claims: new Map([[secret.id, secret]]),
      rules: new Map(),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    } satisfies WorldModelContext);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    const template = {
      proposal: {
        proposalId: "confront",
        branchId: "main",
        expectedParentCommit: genesis,
        source: "player" as const,
        actorId: "hero",
        title: "Confront the betrayer",
        participants: ["hero"],
        proposedTime: { kind: "unknown" as const },
        preconditions: [],
        proposedDelta: { version: 1 as const, operations: [{ op: "set" as const, entityId: "hero", field: "character.title", value: "Confronter" }] },
        causalParents: [],
        evidence: [],
      },
      requiresKnowledge: ["secret"],
      forbidsKnowledge: [],
    };
    const blocked = await commitKnowledgeAwareAction(engine, template);
    expect(blocked.gate.accepted).toBe(false);
    expect(blocked.result).toBeUndefined();
    expect(blocked.gate.errors.some((error) => error.code === "REQUIRED_KNOWLEDGE_MISSING")).toBe(true);

    const learned = await engine.commitProposal({
      proposalId: "learn-secret",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "background",
      title: "Hero discovers the secret",
      participants: ["hero"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      proposedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "hero", claimId: "secret", status: "knows", confidence: 1 }] },
      causalParents: [],
      evidence: [],
    });
    const allowed = await commitKnowledgeAwareAction(engine, {
      ...template,
      proposal: { ...template.proposal, expectedParentCommit: learned.newHead },
    });
    expect(allowed.gate.accepted).toBe(true);
    expect(allowed.result?.report.accepted).toBe(true);
  });
});
