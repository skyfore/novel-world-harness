import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contentHash } from "../src/world/canonical.js";
import { WorldContextStore } from "../src/world/context.js";
import { WorldEngine } from "../src/world/engine.js";
import type { PreparedNovelBundle } from "../src/compiler/prepared-cache.js";
import { cutIdFor, deriveBundleCanonTimeline } from "../src/world/canon-timeline.js";
import { deriveSceneEntrySeed } from "../src/world/entry-context.js";
import type { CanonicalEvent, Entity } from "../src/world/model.js";
import { SCENE_OCCURRENCE_ONTOLOGY_VERSION } from "../src/world/scene-occurrence.js";

const span = (byte: number) => ({ span: { sourceId: "source", startByte: byte, endByte: byte + 4, startLine: 1 + byte, endLine: 1 + byte, quoteHash: "a".repeat(64) }, strength: "explicit" as const });
const entities: Entity[] = [
  ...["hero", "courier", "stranger"].map((id): Entity => ({ id, kind: "character", canonicalName: id, aliases: [], evidence: [span(0)] })),
  { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: [span(0)] },
  { id: "street", kind: "location", canonicalName: "Street", aliases: [], evidence: [span(0)] },
];

function event(id: string, byte: number, sceneId: string, participants: string[], operations: CanonicalEvent["observedOutcome"]["operations"], knowledge?: CanonicalEvent["observedKnowledge"]): CanonicalEvent {
  return {
    id, title: id, readerSummary: `What happened in ${id}`, participants, participantPresence: participants.map((entityId) => ({ entityId, mode: "physical" as const })),
    storyTime: { kind: "unknown" }, narrativeContext: { layerId: "main", discourseOrder: byte, mode: "scene" }, sceneOccurrenceIds: [sceneId],
    preconditions: [], observedOutcome: { version: 1, operations }, ...(knowledge ? { observedKnowledge: knowledge } : {}),
    evidence: [span(byte)], causalParents: [], confidence: 1,
  };
}

function fixture(): PreparedNovelBundle {
  const events = [
    event("arrival", 100, "scene-hall", ["hero", "courier"], [{ op: "set", entityId: "courier", field: "character.plan", value: "deliver the letter" }]),
    event("secret", 200, "scene-hall-2", ["courier", "hero"], [{ op: "set", entityId: "hero", field: "character.plan", value: "open the letter" }],
      { version: 1, operations: [{ op: "learn", actorId: "hero", claimId: "claim-secret", status: "believes", confidence: 1 }] }),
    event("chase", 300, "scene-street", ["hero", "stranger"], [{ op: "set", entityId: "hero", field: "character.location", value: "street" }]),
  ];
  const scene = (id: string, eventId: string, present: string[], locationId?: string) => ({ ontologyVersion: SCENE_OCCURRENCE_ONTOLOGY_VERSION, id, discourseSegmentIds: [`segment-${id}`], eventIds: [eventId],
    ...(locationId ? { locationId } : {}), viewpointActorIds: [], presentActorIds: present, entryConditions: [], exitConditions: [], evidence: [span(0)] });
  const bundle = {
    version: 4, segmenterVersion: 1, batchIds: [], readiness: null, admission: null,
    source: { id: "source", contentMd5: "a".repeat(32), contentSha256: "b".repeat(64) },
    compilerSnapshot: { structure: { units: [], baseUnitIds: [], discourseSegments: [] }, annotations: [], entityResolutions: [], eventResolutions: [], evidenceBindings: [], accounting: null, roleRoster: null },
    canonical: {
      entities, propositions: [], attributions: [], events,
      claims: [{ id: "claim-secret", subject: "courier", predicate: "carries", object: "a sealed letter", epistemicType: "explicit-fact", evidence: [span(200)] }], eventParticipations: [], eventRelations: [], spatialRelations: [], eventFrames: [],
      sceneOccurrences: [scene("scene-hall", "arrival", ["hero", "courier"], "hall"), scene("scene-hall-2", "secret", ["courier", "hero"]), scene("scene-street", "chase", ["hero", "stranger"], "street")],
      actionSchemas: [], actionConstraints: [], normTemplates: [], processTemplates: [], rules: [], goals: [], models: [], possibilities: [],
      initialWorld: { version: 1, evidence: [span(0)], participantPresence: [{ entityId: "hero", mode: "physical" }],
        delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }, { op: "set", entityId: "hero", field: "character.location", value: "hall" }, { op: "set", entityId: "hero", field: "character.plan", value: "wait" }] },
        projectionSeed: { version: 1, semantics: { version: 1, operations: [] }, processes: { version: 1, operations: [] }, norms: { version: 1, operations: [] }, activeRuleIds: [], elapsedDays: 0 } },
    },
  } as unknown as PreparedNovelBundle;
  bundle.canonical.timeline = deriveBundleCanonTimeline(bundle);
  return bundle;
}

const cut = (bundle: PreparedNovelBundle, eventId: string) => cutIdFor(eventId, bundle.canonical.timeline!.hash);
const value = (seed: { delta: { operations: Array<{ op: string; entityId?: string; field?: string; value?: unknown }> } }, entityId: string, field: string) =>
  seed.delta.operations.filter((operation) => operation.op === "set" && operation.entityId === entityId && operation.field === field).at(-1)?.value;

describe("scene entry seeds", () => {
  it("enters the same character at two different scenes with state from just before each event", () => {
    const bundle = fixture();
    const opening = deriveSceneEntrySeed(bundle, cut(bundle, "arrival"), "hero");
    expect(opening.entryBasis).toBe("opening");
    expect(opening.sceneIds).toEqual(["scene-hall"]);

    const second = deriveSceneEntrySeed(bundle, cut(bundle, "secret"), "hero");
    expect(second.entryBasis).toBe("derived");
    expect(second.cut.completedEventIds).toEqual(["arrival"]);
    expect(value(second, "hero", "character.location")).toBe("hall");
    expect(value(second, "hero", "character.plan")).toBe("wait");
    expect(value(second, "courier", "character.plan")).toBe("deliver the letter");
    expect(second.knowledge?.operations ?? []).toEqual([]);
    expect(second.participantPresence).toEqual([{ entityId: "courier", mode: "physical" }, { entityId: "hero", mode: "physical" }]);
    expect(second.readerContext.storySoFar.map((beat) => beat.eventId)).toEqual(["arrival"]);

    const third = deriveSceneEntrySeed(bundle, cut(bundle, "chase"), "hero");
    expect(third.entryBasis).toBe("derived");
    expect(third.cut.completedEventIds).toEqual(["arrival", "secret"]);
    expect(value(third, "hero", "character.plan")).toBe("open the letter");
    expect(value(third, "hero", "character.location")).toBe("hall");
    expect(third.knowledge?.operations).toEqual([expect.objectContaining({ op: "learn", actorId: "hero", claimId: "claim-secret" })]);
    expect(third.cut.hash).not.toBe(second.cut.hash);
  });

  it("supplies scene location and explicit life only for a present actor without them", () => {
    const bundle = fixture();
    const stranger = deriveSceneEntrySeed(bundle, cut(bundle, "chase"), "stranger");
    expect(stranger.entryBasis).toBe("derived");
    expect(value(stranger, "stranger", "character.location")).toBe("street");
    expect(value(stranger, "stranger", "character.alive")).toBe(true);
    expect(stranger.readerContext.entrySetup).toContain("Street");
    expect(() => deriveSceneEntrySeed(bundle, cut(bundle, "secret"), "stranger")).toThrow("ENTRY_CONTEXT_MISSING");
    // No scene location and no prior context: nothing to ground the entry in.
    const unplaced = fixture();
    unplaced.canonical.sceneOccurrences[2]!.locationId = undefined;
    unplaced.canonical.timeline = deriveBundleCanonTimeline(unplaced);
    expect(() => deriveSceneEntrySeed(unplaced, cut(unplaced, "chase"), "stranger")).toThrow("ENTRY_CONTEXT_MISSING");
  });

  it("refuses unknown cuts, non-characters, dead actors and revisions without a frozen timeline", () => {
    const bundle = fixture();
    expect(() => deriveSceneEntrySeed(bundle, "f".repeat(64), "hero")).toThrow("ENTRY_CUT_UNKNOWN");
    expect(() => deriveSceneEntrySeed(bundle, cut(bundle, "chase"), "hall")).toThrow("ENTRY_ACTOR_UNKNOWN");
    const dead = fixture();
    dead.canonical.events[1]!.observedOutcome.operations.push({ op: "set", entityId: "stranger", field: "character.alive", value: false });
    dead.canonical.timeline = deriveBundleCanonTimeline(dead);
    expect(() => deriveSceneEntrySeed(dead, cut(dead, "chase"), "stranger")).toThrow("ENTRY_ACTOR_DEAD");
    const legacy = fixture();
    delete legacy.canonical.timeline;
    expect(() => deriveSceneEntrySeed(legacy, cut(bundle, "chase"), "hero")).toThrow("ENTRY_TIMELINE_REQUIRED");
  });

  it("creates and replays a branch from a derived entry with inherited knowledge", async () => {
    const bundle = fixture();
    const seed = deriveSceneEntrySeed(bundle, cut(bundle, "chase"), "hero");
    expect(seed.projectionSeed?.knowledgeHistory).toMatchObject({ basis: "derived-scene", beforeCanonicalEventId: "chase", actorId: "hero" });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-scene-entry-"));
    try {
      const context = await new WorldContextStore(root).capturePrepared("source", contentHash("scene-entry"), bundle.canonical);
      const engine = new WorldEngine(root, context);
      const head = await engine.createBranch("scene", "Scene entry", seed.delta, seed.knowledge, "source", contentHash("scene-entry"), seed.evidence,
        { elapsedDays: seed.projectionSeed!.elapsedDays }, { entryActorId: "hero", projectionSeed: seed.projectionSeed, realizesCanonicalEventIds: seed.realizesCanonicalEventIds, participantPresence: seed.participantPresence, actorObservations: seed.actorObservations });
      const replay = await new WorldEngine(root, context).projections.project(head, { fresh: true, useCheckpoints: false });
      expect(replay.state.values.hero?.["character.plan"]).toBe("open the letter");
      expect(replay.knowledge.actors.hero?.["claim-secret"]).toMatchObject({ status: "believes" });
      const forged = { ...seed.projectionSeed!, knowledgeHistory: { ...seed.projectionSeed!.knowledgeHistory!, basis: undefined } };
      await expect(engine.createBranch("forged", "Forged", seed.delta, seed.knowledge, "source", contentHash("scene-entry"), seed.evidence,
        { elapsedDays: 0 }, { entryActorId: "hero", projectionSeed: forged, realizesCanonicalEventIds: seed.realizesCanonicalEventIds })).rejects.toThrow("ENTRY_KNOWLEDGE_HISTORY_INVALID");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
