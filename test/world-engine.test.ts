import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import type { Entity, EventProposal } from "../src/world/model.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry, evaluatePredicate } from "../src/world/state.js";

const roots: string[] = [];

async function fixture(): Promise<{ root: string; engine: WorldEngine; context: WorldModelContext }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-engine-"));
  roots.push(root);
  const entities: Entity[] = [
    { id: "cao-cao", kind: "character", canonicalName: "曹操", aliases: [], evidence: [] },
    { id: "hall", kind: "location", canonicalName: "大厅", aliases: [], evidence: [] },
    { id: "camp", kind: "location", canonicalName: "营地", aliases: [], evidence: [] },
  ];
  const context: WorldModelContext = {
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    rules: new Map(),
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
  };
  return { root, engine: new WorldEngine(root, context), context };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("WorldEngine", () => {
  it("reconstructs committed state deterministically from genesis", async () => {
    const { engine } = await fixture();
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "cao-cao", field: "character.alive", value: true },
        { op: "set", entityId: "cao-cao", field: "character.location", value: "hall" },
      ],
    });
    const before = await engine.projector.project(genesis);
    expect(before.values["cao-cao"]?.["character.location"]).toBe("hall");

    const proposal: EventProposal = {
      proposalId: "move-1",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "player",
      actorId: "cao-cao",
      title: "曹操离开大厅",
      participants: ["cao-cao"],
      proposedTime: { kind: "ordinal", label: "after meeting" },
      preconditions: [{ op: "fact-equals", entityId: "cao-cao", field: "character.location", value: "hall" }],
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "cao-cao", field: "character.location", value: "camp" }] },
      causalParents: [],
      evidence: [],
    };
    const result = await engine.commitProposal(proposal);
    expect(result.report.accepted).toBe(true);
    expect(result.newHead).not.toBe(genesis);

    const first = await engine.projector.project(result.newHead);
    const second = await engine.projector.project(result.newHead);
    expect(first).toEqual(second);
    expect(first.logicalTime.step).toBe(1);
    expect(first.values["cao-cao"]?.["character.location"]).toBe("camp");
  });

  it("rejects failed preconditions without moving branch truth", async () => {
    const { engine } = await fixture();
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "cao-cao", field: "character.alive", value: true },
        { op: "set", entityId: "cao-cao", field: "character.location", value: "hall" },
      ],
    });
    const result = await engine.commitProposal({
      proposalId: "invalid-move",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "player",
      actorId: "cao-cao",
      title: "impossible move",
      participants: ["cao-cao"],
      proposedTime: { kind: "unknown" },
      preconditions: [{ op: "fact-equals", entityId: "cao-cao", field: "character.location", value: "camp" }],
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "cao-cao", field: "character.location", value: "camp" }] },
      causalParents: [],
      evidence: [],
    });
    expect(result.report.accepted).toBe(false);
    expect(result.report.errors.some((error) => error.code === "PRECONDITION_FAILED")).toBe(true);
    await expect(engine.branches.readHead("main")).resolves.toBe(genesis);
  });

  it("rejects raw empty player commits and false progress claims", async () => {
    const { engine } = await fixture();
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "cao-cao", field: "character.alive", value: true }],
    });
    const proposal = {
      proposalId: "empty-player-event",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "player" as const,
      actorId: "cao-cao",
      title: "Nothing changes",
      participants: ["cao-cao"],
      proposedTime: { kind: "unknown" as const },
      preconditions: [],
      proposedDelta: { version: 1 as const, operations: [] },
      causalParents: [],
      evidence: [],
    };

    const empty = await engine.commitProposal(proposal);
    expect(empty.report.errors).toContainEqual(expect.objectContaining({ code: "EVENT_MATERIALITY_REQUIRED" }));
    const falseState = await engine.commitProposal({
      ...proposal,
      proposalId: "false-state-progress",
      progress: {
        version: 1,
        channels: ["state"],
        threadIds: [],
        noveltyKey: "false-state",
      },
    });
    expect(falseState.report.errors).toContainEqual(expect.objectContaining({ code: "FALSE_STATE_PROGRESS" }));
    expect(await engine.branches.readHead("main")).toBe(genesis);
  });

  it("rejects activation of an unknown world rule", async () => {
    const { engine } = await fixture();
    const genesis = await engine.createBranch("main", "Main");
    const result = await engine.commitProposal({
      proposalId: "unknown-rule",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "background",
      title: "Activate missing rule",
      participants: [],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [{ op: "activate-rule", ruleId: "missing-rule" }] },
      causalParents: [],
      evidence: [],
    });
    expect(result.report.accepted).toBe(false);
    expect(result.report.errors.some((error) => error.code === "INVALID_DELTA" && error.message.includes("Unknown world rule"))).toBe(true);
    await expect(engine.branches.readHead("main")).resolves.toBe(genesis);
  });

  it("commits material time without persisting an empty state effect", async () => {
    const { engine } = await fixture();
    const genesis = await engine.createBranch("main", "Main");
    const result = await engine.commitProposal({
      proposalId: "wait-one-minute",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "player",
      actorId: "cao-cao",
      title: "曹操等待片刻",
      participants: ["cao-cao"],
      proposedTime: { kind: "unknown" },
      timeAdvance: { amount: 1, unit: "minute" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      causalParents: [],
      evidence: [],
    });

    expect(result.report).toMatchObject({ accepted: true });
    expect(result.report.derivedDeltaHash).toBeUndefined();
    if (!result.eventHash) throw new Error("accepted event must have a hash");
    const event = await engine.objects.getEvent(result.eventHash);
    expect(event.effects).toEqual({ version: 1 });
    expect((await engine.projector.project(result.newHead)).logicalTime.elapsedDays).toBeCloseTo(1 / 1_440);
  });

  it("requires actor-visible event summaries to name unique participating characters", async () => {
    const { engine } = await fixture();
    const genesis = await engine.createBranch("main", "Main");
    const result = await engine.commitProposal({
      proposalId: "invalid-observers",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "background",
      title: "Hidden event title",
      actorObservations: [
        { actorId: "cao-cao", summary: "First observation" },
        { actorId: "cao-cao", summary: "Duplicate observation" },
        { actorId: "hall", summary: "A location cannot observe" },
      ],
      participants: ["cao-cao"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      causalParents: [],
      evidence: [],
    });
    expect(result.report.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "DUPLICATE_EVENT_OBSERVER" }),
      expect.objectContaining({ code: "INVALID_EVENT_OBSERVER" }),
    ]));
    await expect(engine.branches.readHead("main")).resolves.toBe(genesis);
  });

  it("rejects ordinary actions by a dead actor", async () => {
    const { engine } = await fixture();
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "cao-cao", field: "character.alive", value: false }],
    });
    const result = await engine.commitProposal({
      proposalId: "dead-action",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "actor",
      actorId: "cao-cao",
      title: "act",
      participants: ["cao-cao"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      causalParents: [],
      evidence: [],
    });
    expect(result.report.errors.some((error) => error.code === "ACTOR_DEAD")).toBe(true);
  });
});

describe("predicate evaluation", () => {
  it("supports nested boolean predicates and rule visibility", () => {
    const state = {
      atCommit: "x",
      logicalTime: { step: 5 },
      values: { hero: { "character.alive": true, "character.inventory": ["seal"] } },
      activeRuleIds: ["curfew"],
    };
    expect(
      evaluatePredicate(state, {
        op: "all",
        items: [
          { op: "fact-equals", entityId: "hero", field: "character.alive", value: true },
          { op: "entity-in", entityId: "hero", field: "character.inventory", member: "seal" },
          { op: "rule-active", ruleId: "curfew" },
          { op: "after-step", step: 2 },
        ],
      }),
    ).toBe(true);
  });
});
