import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import type { Entity, EventProposal, Possibility } from "../src/world/model.js";
import { WorldRuntime } from "../src/world/runtime.js";
import { buildFrontier, selectEligible } from "../src/world/frontier.js";
import { emptyWorldState } from "../src/world/state.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-runtime-"));
  roots.push(root);
  const entities: Entity[] = [
    { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] },
    { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: [] },
    { id: "camp", kind: "location", canonicalName: "Camp", aliases: [], evidence: [] },
  ];
  const context: WorldModelContext = {
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    rules: new Map(),
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
  };
  const engine = new WorldEngine(root, context);
  const templates = ({ branchId, commitId }: { branchId: string; commitId: string }): Possibility[] => [
    {
      id: "canon-promotion",
      branchId,
      evaluatedAtCommit: commitId,
      kind: "canon-analogue",
      title: "Canonical promotion",
      preconditions: [{ op: "fact-equals", entityId: "hero", field: "character.location", value: "hall" }],
      blockers: [{ op: "fact-equals", entityId: "hero", field: "character.location", value: "camp" }],
      participants: ["hero"],
      causalParents: [],
      canonicalEventId: "canon-event-promotion",
      pressure: 1,
      relevance: 1,
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.title", value: "Commander" }] },
      evidence: [],
    },
  ];
  return { root, engine, runtime: new WorldRuntime(engine, templates) };
}

describe("WorldRuntime", () => {
  it("keeps player-only choices visible but out of background scheduling", () => {
    const state = emptyWorldState("head");
    const base = {
      branchId: "main",
      evaluatedAtCommit: "head",
      title: "Choice",
      preconditions: [],
      blockers: [],
      participants: ["hero"],
      causalParents: [],
      pressure: 1,
      relevance: 1,
      proposedDelta: { version: 1 as const, operations: [] },
      evidence: [],
    };
    const frontier = buildFrontier("main", "head", state, [
      { ...base, id: "player-only", kind: "player-choice" },
      { ...base, id: "actor-only", kind: "actor-plan" },
      { ...base, id: "background", kind: "generated" },
    ]);
    expect(frontier.evaluated.find((entry) => entry.possibility.id === "player-only")?.status).toBe("eligible");
    expect(selectEligible(frontier).map((entry) => entry.possibility.id)).toEqual(["background"]);
    expect(selectEligible(frontier, 10, { includePlayerChoices: true }).map((entry) => entry.possibility.id).sort()).toEqual(["actor-only", "background", "player-only"]);
  });

  it("keeps a consequence latent until its non-canonical possibility parent is realized", () => {
    const state = emptyWorldState("head");
    const consequence: Possibility = {
      id: "consequence",
      branchId: "main",
      evaluatedAtCommit: "head",
      kind: "causal-consequence",
      title: "Consequence",
      preconditions: [],
      blockers: [],
      participants: ["hero"],
      causalParents: ["player-choice"],
      pressure: 1,
      relevance: 1,
      proposedDelta: { version: 1, operations: [] },
      evidence: [],
    };
    expect(buildFrontier("main", "head", state, [consequence]).evaluated[0]?.status).toBe("latent");
    expect(buildFrontier("main", "head", state, [consequence], { realizedIds: new Set(["player-choice"]) }).evaluated[0]?.status).toBe("eligible");
  });

  it("lets a canonical possibility realize once from surviving conditions", async () => {
    const { engine, runtime } = await fixture();
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "hero", field: "character.location", value: "hall" },
      ],
    });

    const result = await runtime.move({ branchId: "main", maxBackgroundCandidates: 1 });
    expect(result.previousHead).toBe(genesis);
    expect(result.newHead).not.toBe(genesis);
    expect(result.committedEvents).toHaveLength(1);
    expect(result.frontier.evaluated.find((entry) => entry.possibility.id === "canon-promotion")?.status).toBe("realized");
    const state = await engine.projector.project(result.newHead);
    expect(state.values.hero?.["character.title"]).toBe("Commander");

    const second = await runtime.move({ branchId: "main", maxBackgroundCandidates: 1 });
    expect(second.newHead).toBe(result.newHead);
    expect(second.committedEvents).toEqual([]);
    expect(second.frontier.evaluated.find((entry) => entry.possibility.id === "canon-promotion")?.status).toBe("realized");
  });

  it("forks history and keeps a destroyed canonical future blocked", async () => {
    const { engine, runtime } = await fixture();
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "hero", field: "character.location", value: "hall" },
      ],
    });
    await runtime.forkBranch("main", genesis, "alternate", "Alternate");

    const leave: EventProposal = {
      proposalId: "leave-before-promotion",
      branchId: "alternate",
      expectedParentCommit: genesis,
      source: "player",
      actorId: "hero",
      title: "Leave the hall",
      participants: ["hero"],
      proposedTime: { kind: "ordinal", label: "before promotion" },
      preconditions: [{ op: "fact-equals", entityId: "hero", field: "character.location", value: "hall" }],
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.location", value: "camp" }] },
      causalParents: [],
      evidence: [],
    };
    const alternate = await runtime.move({ branchId: "alternate", playerProposal: leave, maxBackgroundCandidates: 1 });
    const altEntry = alternate.frontier.evaluated.find((entry) => entry.possibility.id === "canon-promotion");
    expect(altEntry?.status).toBe("blocked");
    expect(alternate.committedEvents).toHaveLength(1);
    const altState = await engine.projector.project(alternate.newHead);
    expect(altState.values.hero?.["character.location"]).toBe("camp");
    expect(altState.values.hero?.["character.title"]).toBeUndefined();

    expect(await engine.branches.readHead("main")).toBe(genesis);
    const mainState = await engine.projector.project(genesis);
    expect(mainState.values.hero?.["character.location"]).toBe("hall");
  });
});
