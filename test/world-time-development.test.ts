import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { characterModelSchema, evaluateCharacterGoal, type CharacterGoal, type CharacterModel } from "../src/world/actors.js";
import { projectCharacterDevelopment } from "../src/world/development.js";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { buildFrontier } from "../src/world/frontier.js";
import type { CanonicalEvent, Entity, Possibility, WorldState } from "../src/world/model.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry, evaluatePredicate } from "../src/world/state.js";
import { advanceStoryTime, compareStoryTime } from "../src/world/time.js";

const roots: string[] = [];
const evidence = [{ span: { sourceId: "novel", startLine: 1, endLine: 1, quoteHash: "hash" }, strength: "explicit" as const }];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function world(presence?: "physical" | "mentioned"): Promise<{ engine: WorldEngine; turningPoint: CanonicalEvent }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-world-time-"));
  roots.push(root);
  const hero: Entity = { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence };
  const turningPoint: CanonicalEvent = {
    id: "turning-point",
    title: "Hero survives a turning point",
    participants: ["hero"],
    ...(presence ? { participantPresence: [{ entityId: "hero", mode: presence }] } : {}),
    storyTime: { kind: "exact", value: "2001", precision: "year" },
    timeAdvance: { amount: 1, unit: "year" },
    preconditions: [],
    observedOutcome: { version: 1, operations: [{ op: "adjust-number", entityId: "hero", field: "character.experience", amount: 1 }] },
    evidence,
    causalParents: [],
    confidence: 1,
  };
  const model: CharacterModel = {
    actorId: "hero",
    traits: { trust: 0.4 },
    decisionBiases: { caution: 0.1 },
    developmentPhases: [{
      id: "after-turning-point",
      label: "Changed by lived experience",
      activation: {
        preconditions: [{ op: "fact-gte", entityId: "hero", field: "character.experience", value: 1 }],
        afterCanonicalEventIds: [],
        afterExperiencedCanonicalEventIds: ["turning-point"],
        requiresKnowledge: [],
      },
      traitModifiers: { trust: -0.3 },
      decisionBiasModifiers: { caution: 0.7 },
      evidence,
    }],
    evidence,
  };
  const context: WorldModelContext = {
    entities: new Map([[hero.id, hero]]),
    events: new Map([[turningPoint.id, turningPoint]]),
    rules: new Map(),
    actorModels: new Map([[hero.id, model]]),
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
  };
  return { engine: new WorldEngine(root, context), turningPoint };
}

describe("world time and character development", () => {
  it("advances derived calendar anchors across leap days and years", () => {
    expect(advanceStoryTime(
      { kind: "exact", value: "1948", precision: "year" },
      { amount: 1, unit: "year" },
    )).toEqual({ kind: "exact", value: "1949", precision: "year" });
    expect(advanceStoryTime(
      { kind: "exact", value: "2000-02-28", precision: "day" },
      { amount: 1, unit: "day" },
    )).toEqual({ kind: "exact", value: "2000-02-29", precision: "day" });
    expect(compareStoryTime(
      { kind: "exact", value: "2000-02-28T13:00Z", precision: "hour" },
      { kind: "exact", value: "2000-02-28T12:00Z", precision: "hour" },
    )).toBe(1);
  });

  it("rejects a development phase with no activation boundary", () => {
    expect(() => characterModelSchema.parse({
      actorId: "hero",
      traits: {},
      decisionBiases: {},
      developmentPhases: [{
        id: "always-on-fake-growth",
        label: "Fake growth",
        activation: {
          preconditions: [],
          afterCanonicalEventIds: [],
          afterExperiencedCanonicalEventIds: [],
          requiresKnowledge: [],
        },
        traitModifiers: { trust: 0.1 },
        decisionBiasModifiers: {},
        evidence,
      }],
      evidence,
    })).toThrow(/at least one state, event, knowledge, or story-time trigger/);
  });

  it("does not treat every exact year as a ten-year character phase", () => {
    const goal: CharacterGoal = {
      id: "year-bound-goal",
      actorId: "hero",
      description: "Only active during 1948",
      priority: 1,
      requiresKnowledge: [],
      activation: {
        preconditions: [],
        afterCanonicalEventIds: [],
        storyWindow: { kind: "exact", value: "1948", precision: "year" },
      },
      evidence,
    };
    const state: WorldState = {
      atCommit: "head",
      logicalTime: { step: 1, elapsedDays: 0 },
      values: {},
      activeRuleIds: [],
    };

    expect(evaluateCharacterGoal(goal, {
      state,
      knownClaimIds: new Set(),
      realizedCanonicalEventIds: new Set(),
      storyTime: { kind: "exact", value: "1948", precision: "year" },
    }).active).toBe(true);
    expect(evaluateCharacterGoal(goal, {
      state,
      knownClaimIds: new Set(),
      realizedCanonicalEventIds: new Set(),
      storyTime: { kind: "exact", value: "1950", precision: "year" },
    }).active).toBe(false);
  });

  it("advances elapsed time and age before evaluating an event", async () => {
    const { engine } = await world();
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "hero", field: "character.ageYears", value: 20 },
        { op: "set", entityId: "hero", field: "character.experience", value: 0 },
      ],
    }, undefined, undefined, undefined, [], {
      storyTime: { kind: "exact", value: "2000", precision: "year" },
      elapsedDays: 0,
    });
    const committed = await engine.commitProposal({
      proposalId: "turning-point-proposal",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "canon-candidate",
      title: "Hero survives a turning point",
      actorObservations: [{ actorId: "hero", summary: "Hero survives a turning point" }],
      participants: ["hero"],
      proposedTime: { kind: "exact", value: "2001", precision: "year" },
      timeAdvance: { amount: 1, unit: "year" },
      preconditions: [{ op: "fact-gte", entityId: "hero", field: "character.ageYears", value: 21 }],
      proposedDelta: { version: 1, operations: [{ op: "adjust-number", entityId: "hero", field: "character.experience", amount: 1 }] },
      causalParents: [],
      evidence,
      possibilityId: "canon-turning-point",
    });
    expect(committed.report.accepted).toBe(true);
    const state = await engine.projector.project(committed.newHead);
    expect(state.logicalTime.elapsedDays).toBeCloseTo(365.2425);
    expect(state.values.hero?.["character.ageYears"]).toBeCloseTo(21);
    expect(state.values.hero?.["character.experience"]).toBe(1);
    expect(evaluatePredicate(state, { op: "elapsed-days-gte", days: 365 })).toBe(true);

    const development = await projectCharacterDevelopment(engine, "hero", committed.newHead);
    expect(development.experiencedCanonicalEventIds).toEqual(["turning-point"]);
    expect(development.recentLivedExperiences).toEqual([
      expect.objectContaining({
        title: "Hero survives a turning point",
        participantIds: ["hero"],
      }),
    ]);
    expect(development.model?.activePhaseIds).toEqual(["after-turning-point"]);
    expect(development.model?.traits.trust).toBeCloseTo(0.1);
    expect(development.model?.decisionBiases.caution).toBeCloseTo(0.8);
  });

  it("does not treat a merely mentioned canonical participant as lived experience", async () => {
    const { engine } = await world("mentioned");
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    const committed = await engine.commitProposal({
      proposalId: "mentioned-turning-point",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "canon-candidate",
      title: "Others mention Hero while describing the turning point",
      participants: ["hero"],
      proposedTime: { kind: "exact", value: "2001", precision: "year" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      causalParents: [],
      evidence,
      possibilityId: "canon-turning-point",
    });
    expect(committed.report.accepted).toBe(true);

    const development = await projectCharacterDevelopment(engine, "hero", committed.newHead);
    expect(development.experiencedCanonicalEventIds).toEqual([]);
    expect(development.recentLivedExperiences).toEqual([]);
    expect(development.model?.activePhaseIds).toEqual([]);
  });

  it("rejects a definitely earlier story time", async () => {
    const { engine } = await world();
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    }, undefined, undefined, undefined, [], {
      storyTime: { kind: "exact", value: "2000", precision: "year" },
      elapsedDays: 0,
    });
    const result = await engine.commitProposal({
      proposalId: "backwards",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "background",
      title: "Backwards",
      participants: [],
      proposedTime: { kind: "exact", value: "1990", precision: "year" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      causalParents: [],
      evidence: [],
    });
    expect(result.report.errors).toContainEqual(expect.objectContaining({ code: "INVALID_WORLD_TIME" }));
    expect(result.newHead).toBe(genesis);
  });
});

describe("causal butterfly propagation", () => {
  const state: WorldState = {
    atCommit: "head",
    logicalTime: { step: 2, elapsedDays: 1 },
    values: {},
    activeRuleIds: [],
  };
  const possibility = (id: string, parents: string[] = []): Possibility => ({
    id,
    branchId: "main",
    evaluatedAtCommit: "head",
    kind: "canon-analogue",
    title: id,
    preconditions: [],
    blockers: [],
    participants: [],
    causalParents: parents,
    canonicalEventId: id.replace(/^canon-/, ""),
    pressure: 1,
    relevance: 1,
    proposedDelta: { version: 1, operations: [] },
    evidence: [],
  });

  it("transitively invalidates descendants of a superseded canonical cause", () => {
    const frontier = buildFrontier("main", "head", state, [
      possibility("canon-cause"),
      possibility("canon-child", ["cause"]),
      possibility("canon-grandchild", ["child"]),
      { ...possibility("alternative"), kind: "causal-consequence", canonicalEventId: undefined },
    ], { supersededIds: new Set(["canon-cause"]), realizedIds: new Set() });
    expect(frontier.evaluated.find((entry) => entry.possibility.id === "canon-cause")?.status).toBe("superseded");
    expect(frontier.evaluated.find((entry) => entry.possibility.id === "canon-child")?.status).toBe("invalidated");
    expect(frontier.evaluated.find((entry) => entry.possibility.id === "canon-grandchild")?.status).toBe("invalidated");
    expect(frontier.evaluated.find((entry) => entry.possibility.id === "alternative")?.status).toBe("eligible");
  });
});
