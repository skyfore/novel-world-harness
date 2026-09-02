import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import type { Entity, EventProposal, Possibility } from "../src/world/model.js";
import { WorldRuntime, type NarrativeRender } from "../src/world/runtime.js";
import { buildFrontier, selectEligible } from "../src/world/frontier.js";
import { emptyWorldState } from "../src/world/state.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import { worldStorageRoot } from "../src/world/paths.js";
import type { PlayerActionCandidate } from "../src/world/player-action.js";

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
  const readPromotionCandidate = (): PlayerActionCandidate => ({
    title: "Read the sealed commission",
    intent: {
      kind: "act",
      summary: "Open and read the sealed commission addressed to the hero",
      controlledAct: {
        eventTitle: "Open the sealed commission",
        actorObservation: "The hero opens the sealed commission and reads it.",
      },
      desiredEffect: "Learn what appointment the commission contains",
      targets: [{ kind: "described", description: "the sealed commission" }],
    },
    participants: [],
    preconditions: [],
    proposedDelta: { version: 1, operations: [] },
    requiresKnowledge: [],
    forbidsKnowledge: [],
  });

  it("freezes callback input and snapshots validated possibility output", async () => {
    const { engine } = await fixture();
    const head = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.location", value: "hall" }],
    });
    let callbackInputFrozen = false;
    let retained!: Possibility;
    const runtime = new WorldRuntime(engine, (input) => {
      callbackInputFrozen = Object.isFrozen(input)
        && Object.isFrozen(input.state)
        && Object.isFrozen(input.state.values)
        && Object.isFrozen(input.state.values.hero);
      retained = {
        id: "retained-template",
        branchId: input.branchId,
        evaluatedAtCommit: input.commitId,
        kind: "generated",
        title: "Original title",
        preconditions: [],
        blockers: [],
        participants: ["hero"],
        causalParents: [],
        pressure: 1,
        relevance: 1,
        proposedDelta: { version: 1, operations: [] },
        evidence: [],
      };
      return [retained];
    });

    const frontier = await runtime.refreshFrontier("main", head);
    retained.title = "Mutated after callback";
    retained.participants.push("hall");

    expect(callbackInputFrozen).toBe(true);
    expect(frontier.evaluated[0]?.possibility.title).toBe("Original title");
    expect(frontier.evaluated[0]?.possibility.participants).toEqual(["hero"]);
  });

  it("rejects malformed possibility callback output before frontier evaluation", async () => {
    const { engine } = await fixture();
    const head = await engine.createBranch("main", "Main", { version: 1, operations: [] });
    const runtime = new WorldRuntime(engine, ({ branchId, commitId }) => [{
      id: "invalid-template",
      branchId,
      evaluatedAtCommit: commitId,
      kind: "generated",
      title: "Invalid",
      preconditions: [],
      blockers: [],
      participants: ["hero"],
      causalParents: [],
      pressure: Number.POSITIVE_INFINITY,
      relevance: 1,
      evidence: [],
    } as Possibility]);

    await expect(runtime.refreshFrontier("main", head)).rejects.toThrow();
  });

  it("freezes the renderer frame and validates its result", async () => {
    const { engine } = await fixture();
    const head = await engine.createBranch("main", "Main", { version: 1, operations: [] });
    let frozen = false;
    const runtime = new WorldRuntime(engine, () => [], (input) => {
      frozen = Object.isFrozen(input)
        && Object.isFrozen(input.state)
        && Object.isFrozen(input.state.values)
        && Object.isFrozen(input.committedEvents);
      return "Rendered scene";
    });

    const result = await runtime.move({ branchId: "main" });

    expect(result.newHead).toBe(head);
    expect(result.renderedText).toBe("Rendered scene");
    expect(frozen).toBe(true);

    const invalidRender = (() => ({ text: "invalid" })) as unknown as NarrativeRender;
    const invalidRuntime = new WorldRuntime(engine, () => [], invalidRender);
    await expect(invalidRuntime.move({ branchId: "main" }))
      .rejects.toThrow("World runtime renderer must return a string or undefined");
  });

  it("detects a renderer that rewrites committed branch truth", async () => {
    const { engine } = await fixture();
    const head = await engine.createBranch("main", "Main", { version: 1, operations: [] });
    const foreignHead = "a".repeat(64);
    const runtime = new WorldRuntime(engine, () => [], async ({ branchId, commitId }) => {
      await engine.branches.updateHead(branchId, commitId, foreignHead);
      return "Rendered scene";
    });

    await expect(runtime.move({ branchId: "main" }))
      .rejects.toThrow("World runtime renderer mutated branch truth");
    expect(await engine.branches.readHead("main")).toBe(foreignHead);
    await engine.branches.updateHead("main", foreignHead, head);
  });

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

  it("keeps an unsupported root canon development out of an unrelated active scene", () => {
    const state = emptyWorldState("head");
    const unrelated: Possibility = {
      id: "unrelated-root",
      branchId: "main",
      evaluatedAtCommit: "head",
      kind: "canon-analogue",
      title: "An unrelated root development",
      preconditions: [],
      blockers: [],
      participants: ["rival"],
      causalParents: [],
      canonicalEventId: "unrelated",
      pressure: 1,
      relevance: 1,
      proposedDelta: { version: 1, operations: [] },
      evidence: [],
    };
    const frontier = buildFrontier("main", "head", state, [unrelated], { activeEntityIds: new Set(["hero"]) });
    expect(frontier.evaluated[0]?.status).toBe("latent");
    expect(frontier.evaluated[0]?.reasons.join(" ")).toContain("no participant");
  });

  it("does not activate every disconnected canon root merely because the recurring protagonist participates", () => {
    const state = emptyWorldState("head");
    const root = (id: string, line: number): Possibility => ({
      id,
      branchId: "main",
      evaluatedAtCommit: "head",
      kind: "canon-analogue",
      title: id,
      preconditions: [],
      blockers: [],
      participants: ["hero"],
      causalParents: [],
      canonicalEventId: id,
      pressure: 1,
      relevance: 1,
      proposedDelta: { version: 1, operations: [] },
      evidence: [{ span: { sourceId: "novel", startLine: line, endLine: line, quoteHash: `${id}-evidence` }, strength: "explicit" }],
    });
    const opening = root("opening-root", 1);
    const later = root("later-root", 100);
    const openingEvidence = [{ span: { sourceId: "novel", startLine: 1, endLine: 1, quoteHash: "opening" }, strength: "explicit" as const }];

    const frontier = buildFrontier("main", "head", state, [opening, later], {
      activeEntityIds: new Set(["hero"]),
      activeEvidence: openingEvidence,
    });
    expect(frontier.evaluated.find((entry) => entry.possibility.id === opening.id)?.status).toBe("eligible");
    expect(frontier.evaluated.find((entry) => entry.possibility.id === later.id)?.status).toBe("latent");

    const advanced = buildFrontier("main", "head", state, [opening, later], {
      activeEntityIds: new Set(["hero"]),
      activeEvidence: [...openingEvidence, later.evidence[0]!],
    });
    expect(advanced.evaluated.find((entry) => entry.possibility.id === later.id)?.status).toBe("eligible");
  });

  it("lets a canonical possibility realize once from surviving conditions", async () => {
    const { root, engine, runtime } = await fixture();
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "hero", field: "character.location", value: "hall" },
      ],
    });

    const noImplicitBackground = await runtime.move({ branchId: "main" });
    expect(noImplicitBackground.newHead).toBe(genesis);
    expect(noImplicitBackground.committedEvents).toEqual([]);
    expect(runtime.frontierStore.root).toBe(path.join(worldStorageRoot(root), "frontier"));

    const result = await runtime.move({ branchId: "main", maxBackgroundCandidates: 1 });
    expect(result.previousHead).toBe(genesis);
    expect(result.newHead).not.toBe(genesis);
    expect(result.committedEvents).toHaveLength(1);
    expect(result.frontier.evaluated.find((entry) => entry.possibility.id === "canon-promotion")?.status).toBe("realized");
    const state = await engine.projector.project(result.newHead);
    expect(state.values.hero?.["character.title"]).toBe("Commander");
    expect((await runtime.frontierStore.read("main", genesis, "current-window"))?.temporalMode).toBe("current-window");
    expect((await runtime.frontierStore.read("main", genesis, "advance"))?.temporalMode).toBe("advance");

    const second = await runtime.move({ branchId: "main", maxBackgroundCandidates: 1 });
    expect(second.newHead).toBe(result.newHead);
    expect(second.committedEvents).toEqual([]);
    expect(second.frontier.evaluated.find((entry) => entry.possibility.id === "canon-promotion")?.status).toBe("realized");
  });

  it("commits a selected eligible development as a separate immediate world response", async () => {
    const { engine, runtime } = await fixture();
    const playerHead = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "hero", field: "character.location", value: "hall" },
      ],
    });
    let callbackWasFrozen = false;
    const response = await runtime.respondToPlayer({
      branchId: "main",
      actorId: "hero",
      utterance: "I open the sealed commission and read it.",
      candidate: readPromotionCandidate(),
      scene: {
        label: "Hall",
        presentEntities: [
          { id: "hero", name: "Hero", kind: "character" },
          { id: "hall", name: "Hall", kind: "location" },
        ],
      },
      expectedHead: playerHead,
      resolver: (input) => {
        callbackWasFrozen = Object.isFrozen(input)
          && Object.isFrozen(input.candidate)
          && Object.isFrozen(input.eligibleResponses)
          && Object.isFrozen(input.eligibleResponses[0]?.stateEffects);
        expect(input.eligibleResponses).toHaveLength(1);
        expect(input.eligibleResponses[0]?.stateEffects).toContain("Hero.character.title = Commander");
        return { decision: "select", possibilityId: input.eligibleResponses[0]!.possibilityId };
      },
      causalParentEventId: "player-opened-commission",
    });

    expect(callbackWasFrozen).toBe(true);
    expect(response.previousHead).toBe(playerHead);
    expect(response.newHead).not.toBe(playerHead);
    expect(response.possibilityId).toBe("canon-promotion");
    expect((await engine.projector.project(response.newHead)).values.hero?.["character.title"]).toBe("Commander");
    const event = await engine.objects.getEvent(response.eventHash!);
    expect(event.causalParents).toContain("player-opened-commission");
    expect(event.possibilityId).toBe("canon-promotion");
    expect((await runtime.refreshFrontier("main", response.newHead)).evaluated
      .find((entry) => entry.possibility.id === "canon-promotion")?.status).toBe("realized");
  });

  it("cannot select an unoffered player-world response and leaves the branch unchanged", async () => {
    const { engine, runtime } = await fixture();
    const head = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.location", value: "hall" }],
    });

    await expect(runtime.respondToPlayer({
      branchId: "main",
      actorId: "hero",
      utterance: "I read the commission.",
      candidate: readPromotionCandidate(),
      scene: { presentEntities: [{ id: "hero", name: "Hero", kind: "character" }] },
      expectedHead: head,
      resolver: () => ({ decision: "select", possibilityId: "invented-future" }),
    })).rejects.toThrow("was not offered");
    expect(await engine.branches.readHead("main")).toBe(head);

    const none = await runtime.respondToPlayer({
      branchId: "main",
      actorId: "hero",
      utterance: "I look around.",
      candidate: readPromotionCandidate(),
      scene: { presentEntities: [{ id: "hero", name: "Hero", kind: "character" }] },
      expectedHead: head,
      resolver: () => ({ decision: "none" }),
    });
    expect(none.newHead).toBe(head);
  });

  it("keeps past and future roots outside the active scene, then advances in chronological order only when explicit", () => {
    const state = {
      ...emptyWorldState("head", 4),
      logicalTime: {
        step: 4,
        storyTime: { kind: "exact" as const, value: "1950", precision: "year" as const },
      },
    };
    const possibility = (id: string, year: string): Possibility => ({
      id,
      branchId: "main",
      evaluatedAtCommit: "head",
      kind: "canon-analogue",
      title: id,
      candidateWindow: { kind: "exact", value: year, precision: "year" },
      preconditions: [],
      blockers: [],
      participants: ["hero"],
      causalParents: [],
      canonicalEventId: id,
      pressure: 1,
      relevance: 1,
      proposedDelta: { version: 1, operations: [] },
      evidence: [],
    });
    const templates = [possibility("past", "1940"), possibility("present", "1950"), possibility("future", "1960")];

    const current = buildFrontier("main", "head", state, templates, { temporalMode: "current-window" });
    expect(current.evaluated.find((entry) => entry.possibility.id === "past")?.status).toBe("latent");
    expect(current.evaluated.find((entry) => entry.possibility.id === "present")?.status).toBe("eligible");
    expect(current.evaluated.find((entry) => entry.possibility.id === "future")?.status).toBe("latent");

    const advancing = buildFrontier("main", "head", state, templates, { temporalMode: "advance" });
    expect(selectEligible(advancing).map((entry) => entry.possibility.id)).toEqual(["present", "future"]);
    expect(advancing.evaluated.find((entry) => entry.possibility.id === "past")?.reasons.join(" ")).toContain("earlier than committed");
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
