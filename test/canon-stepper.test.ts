import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCanonTimeline } from "../src/world/canon-timeline.js";
import { classifyCanonBeat, deriveCanonStatus } from "../src/world/canon-stepper.js";
import { contentHash } from "../src/world/canonical.js";
import type { ScopedWorldArtifacts } from "../src/world/context.js";
import type { CanonicalEvent, EventParticipation, EventRelation, StateOperation } from "../src/world/model.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

type Fixture = Awaited<ReturnType<typeof setup>>;

/**
 * Timeline: e0 villain alone (offscreen), e1 friend acts with hero (world beat),
 * e2 hero acts (player beat), e3 villain alone (offscreen), e4 villain alone but
 * it needs e2 to have happened (necessary cause).
 */
async function setup(options: { friendElsewhere?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-canon-stepper-")); roots.push(root);
  const lines = ["Opening.", "Villain schemes.", "Friend greets Hero.", "Hero decides.", "Villain travels.", "Villain answers Hero."];
  const fixture = await createEvidenceFixture(root, lines.join("\n") + "\n");
  const sourceId = fixture.source.id;
  const opening = fixture.evidence("Opening.");
  const character = (id: string) => ({ id, kind: "character" as const, canonicalName: id, aliases: [], evidence: opening });
  const event = (id: string, line: string, participants: string[]): CanonicalEvent => ({
    id, title: line, participants, participantPresence: participants.map((entityId) => ({ entityId, mode: "physical" as const })), storyTime: { kind: "unknown" },
    preconditions: [], observedOutcome: { version: 1, operations: [] }, evidence: fixture.evidence(line), causalParents: [], confidence: 1,
  });
  const events = [
    event("e0", "Villain schemes.", ["villain"]),
    event("e1", "Friend greets Hero.", ["friend", "hero"]),
    event("e2", "Hero decides.", ["hero"]),
    event("e3", "Villain travels.", ["villain"]),
    event("e4", "Villain answers Hero.", ["villain"]),
  ];
  const participation = (eventId: string, entityId: string, role: EventParticipation["role"]): EventParticipation =>
    ({ id: `${eventId}-${entityId}`, eventId, entityId, role, presence: "physical", confidence: 1, evidence: events.find((item) => item.id === eventId)!.evidence });
  const relations: EventRelation[] = [{ id: "e2-enables-e4", fromEventId: "e2", toEventId: "e4", type: "enables", operationality: "necessary", status: "inferred", confidence: 1, mechanism: "the answer needs the decision", evidence: fixture.evidence("Villain answers Hero.") }];
  const at = (id: string, place: string): StateOperation[] => [{ op: "set", entityId: id, field: "character.alive", value: true }, { op: "set", entityId: id, field: "character.location", value: place }];
  const artifacts: ScopedWorldArtifacts = {
    entities: [character("hero"), character("friend"), character("villain"), { id: "hall", kind: "location", canonicalName: "hall", aliases: [], evidence: opening }, { id: "tower", kind: "location", canonicalName: "tower", aliases: [], evidence: opening }],
    propositions: [], attributions: [], claims: [], events, eventParticipations: [participation("e1", "friend", "agent"), participation("e1", "hero", "patient"), participation("e2", "hero", "agent")], eventRelations: relations,
    spatialRelations: [], sceneOccurrences: [], eventFrames: [], actionSchemas: [], rules: [], goals: [], models: [], possibilities: [],
    timeline: buildCanonTimeline({ sourceId, events, relations }),
  };
  const revision = contentHash("stepper");
  const world = await openWorkspaceWorld(root, undefined, { sourceId, preparedRevisionHash: revision, artifacts });
  const head = await world.engine.createBranch("main", "Main", { version: 1, operations: [...at("hero", "hall"), ...at("friend", options.friendElsewhere ? "tower" : "hall"), ...at("villain", "tower")] },
    undefined, sourceId, revision, opening, {}, { entryActorId: "hero", participantPresence: [{ entityId: "hero", mode: "physical" }] });
  return { ...world, head, events };
}

const step = (fixture: Fixture, head: string, extra: Partial<Parameters<Fixture["runtime"]["stepCanon"]>[0]> = {}) =>
  fixture.runtime.stepCanon({ branchId: "main", actorId: "hero", expectedHead: head, budget: 3, worldBeatBudget: 1, ...extra });

async function playerTurn(fixture: Fixture, head: string, plan: string, extra: object = {}) {
  const result = await fixture.engine.commitProposal({ proposalId: `turn-${plan.replace(/\W+/g, "-")}`, branchId: "main", expectedParentCommit: head, source: "player", actorId: "hero", title: plan,
    participants: ["hero"], proposedTime: { kind: "unknown" }, preconditions: [], proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.plan", value: plan }] },
    action: { lane: "ad-hoc", actionKindId: "decide", description: plan, footprint: { reads: [], writes: [{ entityId: "hero", field: "character.plan" }], resources: [] } },
    causalParents: [], evidence: [], ...extra });
  expect(result.report.errors).toEqual([]);
  return result.newHead;
}

describe("canon stepper", () => {
  it("classifies beats from the player's point of view", ({ expect: e }) => {
    const base = { title: "x", storyTime: { kind: "unknown" as const }, preconditions: [], observedOutcome: { version: 1 as const, operations: [] }, evidence: [], causalParents: [], confidence: 1 };
    e(classifyCanonBeat({ ...base, id: "a", participants: ["villain"] }, "hero", ["villain"])).toBe("offscreen");
    e(classifyCanonBeat({ ...base, id: "b", participants: ["hero", "friend"] }, "hero", ["friend"])).toBe("world");
    e(classifyCanonBeat({ ...base, id: "c", participants: ["hero"] }, "hero", ["hero"])).toBe("player");
    e(classifyCanonBeat({ ...base, id: "d", participants: ["hero"] }, "hero", [])).toBe("unattributed");
    e(classifyCanonBeat({ ...base, id: "e", participants: ["hero"], participantPresence: [{ entityId: "hero", mode: "mentioned" }] }, "hero", [])).toBe("offscreen");
  });

  it("settles offscreen and co-located world beats in order and waits at the player's beat", async () => {
    const fixture = await setup();
    const result = await step(fixture, fixture.head);
    expect(result).toMatchObject({ committed: ["e0", "e1"], stoppedAt: "awaiting-player", awaitingEventId: "e2", position: 2 });
    // A replayed projection holds the same canonical history.
    const cold = await fixture.engine.projections.project(result.newHead, { fresh: true, useCheckpoints: false });
    expect(cold.history.flatMap((entry) => entry.event.realizesCanonicalEventIds ?? [])).toEqual(["e0", "e1"]);
  });

  it("skips a world beat whose participants are elsewhere and respects the world-beat budget", async () => {
    const elsewhere = await setup({ friendElsewhere: true });
    expect(await step(elsewhere, elsewhere.head)).toMatchObject({ committed: ["e0"], stoppedAt: "awaiting-player", awaitingEventId: "e2" });
    const noWorldBeats = await setup();
    expect(await step(noWorldBeats, noWorldBeats.head, { worldBeatBudget: 0 })).toMatchObject({ committed: ["e0"], stoppedAt: "awaiting-player" });
    const tight = await setup();
    expect(await step(tight, tight.head, { budget: 1 })).toMatchObject({ committed: ["e0"], stoppedAt: "budget" });
  });

  it("passes the player's beat after patience runs out and never settles its invalidated consequence", async () => {
    const fixture = await setup();
    let head = (await step(fixture, fixture.head)).newHead;
    for (const plan of ["look around", "hesitate"]) {
      head = await playerTurn(fixture, head, plan);
      expect(await step(fixture, head)).toMatchObject({ committed: [], stoppedAt: "awaiting-player", awaitingEventId: "e2" });
    }
    head = await playerTurn(fixture, head, "linger");
    const passed = await step(fixture, head);
    expect(passed).toMatchObject({ committed: ["e3"], passedPlayerBeats: ["e2"], stoppedAt: "exhausted", position: 4 });
    const frontier = await fixture.runtime.refreshFrontier("main", passed.newHead);
    const status = Object.fromEntries(frontier.evaluated.filter((entry) => entry.possibility.canonicalEventId).map((entry) => [entry.possibility.canonicalEventId, entry.status]));
    expect(status).toEqual({ e2: "expired", e4: "invalidated" });
  });

  it("passes the player's beat at once when the player waits, and does not settle a superseded chain", async () => {
    const waited = await setup();
    const head = (await step(waited, waited.head)).newHead;
    expect(await step(waited, head, { playerWaited: true })).toMatchObject({ committed: ["e3"], passedPlayerBeats: ["e2"] });

    const diverged = await setup();
    const before = (await step(diverged, diverged.head)).newHead;
    const superseding = await playerTurn(diverged, before, "refuse to decide", { supersedesCanonicalEventIds: ["e2"] });
    const result = await step(diverged, superseding);
    expect(result.committed).toEqual(["e3"]);
    expect(result.committed).not.toContain("e4");
  });

  it("reports where the branch stands relative to canon", () => {
    const events = ["a", "b", "c"].map((id): CanonicalEvent => ({ id, title: id, participants: [], storyTime: { kind: "unknown" }, preconditions: [], observedOutcome: { version: 1, operations: [] }, evidence: [], causalParents: [], confidence: 1 }));
    const timeline = buildCanonTimeline({ sourceId: "s", events, relations: [] });
    expect(deriveCanonStatus(timeline, [{ realizesCanonicalEventIds: ["a"] }])).toMatchObject({ status: "following", position: 1, total: 3, diverged: false });
    expect(deriveCanonStatus(timeline, [{ supersedesCanonicalEventIds: ["a"] }])).toMatchObject({ status: "diverged", position: 1, diverged: true });
    expect(deriveCanonStatus(timeline, [{ realizesCanonicalEventIds: ["a"] }], 1)).toMatchObject({ status: "beyond-horizon", horizonIndex: 1 });
    expect(deriveCanonStatus(timeline, [{ realizesCanonicalEventIds: ["a", "b", "c"] }])).toMatchObject({ status: "exhausted", position: 3 });
  });
});
