import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalPossibilitySource } from "../src/world/canon-runtime.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { KnowledgeProjector } from "../src/world/knowledge.js";
import type { CanonicalEvent, Claim, Entity } from "../src/world/model.js";
import { WorldRuntime } from "../src/world/runtime.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-canon-runtime-"));
  roots.push(root);
  const entities: Entity[] = [
    { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] },
  ];
  const claim: Claim = {
    id: "first-witnessed",
    subject: "hero",
    predicate: "witnessed",
    object: "first",
    epistemicType: "explicit-fact",
    evidence: [],
  };
  const context: WorldModelContext = {
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    claims: new Map([[claim.id, claim]]),
    rules: new Map(),
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
  };
  const canon = new CanonicalModelStore(root);
  const first: CanonicalEvent = {
    id: "first",
    title: "First causal event",
    participants: ["hero"],
    storyTime: { kind: "ordinal", label: "first" },
    preconditions: [],
    observedOutcome: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.title", value: "Witness" }] },
    observedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "hero", claimId: "first-witnessed", status: "knows", confidence: 1 }] },
    evidence: [],
    causalParents: [],
    confidence: 1,
  };
  const second: CanonicalEvent = {
    id: "second",
    title: "Second causal event",
    participants: ["hero"],
    storyTime: { kind: "ordinal", label: "second" },
    preconditions: [],
    observedOutcome: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.title", value: "Commander" }] },
    evidence: [],
    causalParents: ["first"],
    confidence: 1,
  };
  await canon.putEvent(first);
  await canon.putEvent(second);
  const engine = new WorldEngine(root, context);
  await engine.createBranch("main", "Main", {
    version: 1,
    operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
  });
  return { engine, runtime: new WorldRuntime(engine, canonicalPossibilitySource(canon)) };
}

describe("canonical runtime possibilities", () => {
  it("keeps a child event latent until its causal parent is realized", async () => {
    const { engine, runtime } = await fixture();
    const before = await runtime.refreshFrontier("main");
    expect(before.evaluated.find((entry) => entry.possibility.id === "canon-first")?.status).toBe("eligible");
    const secondBefore = before.evaluated.find((entry) => entry.possibility.id === "canon-second");
    expect(secondBefore?.status).toBe("latent");
    expect(secondBefore?.reasons.join(" ")).toContain("first");

    const firstMove = await runtime.move({ branchId: "main", maxBackgroundCandidates: 1 });
    expect(firstMove.committedEvents).toHaveLength(1);
    expect((await engine.projector.project(firstMove.newHead)).values.hero?.["character.title"]).toBe("Witness");
    expect((await new KnowledgeProjector(engine).view("hero", firstMove.newHead)).knowledge.map((entry) => entry.fact.claimId)).toEqual(["first-witnessed"]);
    expect(firstMove.frontier.evaluated.find((entry) => entry.possibility.id === "canon-second")?.status).toBe("eligible");

    const secondMove = await runtime.move({ branchId: "main", maxBackgroundCandidates: 1 });
    expect(secondMove.committedEvents).toHaveLength(1);
    expect((await engine.projector.project(secondMove.newHead)).values.hero?.["character.title"]).toBe("Commander");
  });
});
