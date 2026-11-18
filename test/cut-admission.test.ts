import { describe, expect, it } from "vitest";
import { accountingBlockers, admissionManifestIssues, admittedEntries, assertCutAdmission, assertPlayableRevision, buildAdmissionManifest, cutIdFor, horizonFromBlockers } from "../src/compiler/cut-admission.js";
import type { PreparedNovelBundle } from "../src/compiler/prepared-cache.js";
import { buildRoleRoster, type RoleRosterReview } from "../src/compiler/role-roster.js";
import { buildCanonTimeline, deriveBundleCanonTimeline } from "../src/world/canon-timeline.js";
import type { CanonicalEvent, Entity } from "../src/world/model.js";
import { selfActionFixture } from "./helpers/entry-action.js";
import { SCENE_OCCURRENCE_ONTOLOGY_VERSION } from "../src/world/scene-occurrence.js";

const span = (byte: number) => ({ span: { sourceId: "source", startByte: byte, endByte: byte + 4, startLine: 1 + byte, endLine: 1 + byte, quoteHash: "a".repeat(64) }, strength: "explicit" as const });
const evidence = [span(0)];
const entities: Entity[] = ["hero", "regent", "courier"].map((id) => ({ id, kind: "character", canonicalName: id, aliases: [], evidence }));
entities.push({ id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence });

function sceneEvent(id: string, byte: number, operations: CanonicalEvent["observedOutcome"]["operations"] = [], sceneId?: string): CanonicalEvent {
  return {
    id, title: id, ...(sceneId ? { sceneOccurrenceIds: [sceneId] } : {}), readerSummary: `Summary of ${id}`, participants: ["courier"], participantPresence: [{ entityId: "courier", mode: "physical" }],
    storyTime: { kind: "unknown" }, narrativeContext: { layerId: "main", discourseOrder: byte, mode: "scene" },
    preconditions: [], observedOutcome: { version: 1, operations }, evidence: [span(byte)], causalParents: [], confidence: 1,
  };
}

/** Three scenes after a playable opening; the middle event can be broken on demand. */
function fixture(broken: boolean): PreparedNovelBundle {
  const roster = buildRoleRoster({ sourceId: "source", sourceSha256: "b".repeat(64), unitIds: ["unit"], entities, annotations: [], resolutions: [] });
  const review = (runId: string): RoleRosterReview => ({ runId, subjectHash: roster.subjectHash, reviewedUnitIds: ["unit"], entries: roster.candidates.map((x) => ({ candidateId: x.id, importance: "major", rationale: "Central", basisUnitIds: ["unit"] })) });
  roster.reviews = [review("review-1"), review("review-2")];
  const events = [
    sceneEvent("arrival", 100, [], "scene-1"),
    sceneEvent("letter", 200, broken ? [{ op: "set", entityId: "ghost", field: "character.plan", value: "haunt" }] : [], "scene-2"),
    sceneEvent("farewell", 300, [], "scene-3"),
  ];
  const bundle = {
    version: 4, segmenterVersion: 1, batchIds: [],
    compilerSnapshot: { roleRoster: roster, structure: { units: [], baseUnitIds: [], discourseSegments: events.map((_, index) => ({ id: `segment-${index + 1}` })) }, annotations: [], entityResolutions: [], eventResolutions: [], evidenceBindings: [], accounting: null },
    source: { id: "source", contentMd5: "a".repeat(32), contentSha256: "b".repeat(64) },
    canonical: {
      entities, propositions: [], attributions: [], claims: [], events, eventParticipations: [], eventRelations: [], spatialRelations: [],
      sceneOccurrences: events.map((event, index) => ({ ontologyVersion: SCENE_OCCURRENCE_ONTOLOGY_VERSION, id: `scene-${index + 1}`, discourseSegmentIds: [`segment-${index + 1}`], eventIds: [event.id],
        viewpointActorIds: [], presentActorIds: ["courier"], entryConditions: [], exitConditions: [], evidence: event.evidence })), eventFrames: [],
      actionSchemas: [selfActionFixture()], actionConstraints: [], normTemplates: [], processTemplates: [], rules: [], models: [], possibilities: [],
      goals: [{ id: "courier-goal", actorId: "courier", description: "Deliver the letter", priority: 1, requiresKnowledge: [], evidence,
        candidateAction: { title: "Courier chooses the next delivery", preconditions: [], proposedDelta: { version: 1, operations: [{ op: "set", entityId: "courier", field: "character.plan", value: "deliver the letter" }] } } }],
      initialWorld: { version: 1, evidence, participantPresence: [{ entityId: "hero", mode: "physical" }, { entityId: "courier", mode: "physical" }], actorObservations: [{ actorId: "hero", summary: "The hall lies before you" }],
        delta: { version: 1, operations: [
          { op: "set", entityId: "courier", field: "character.alive", value: true }, { op: "set", entityId: "courier", field: "character.location", value: "hall" },
          { op: "set", entityId: "hero", field: "character.alive", value: true }, { op: "set", entityId: "hero", field: "character.location", value: "hall" },
          { op: "set", entityId: "hero", field: "character.plan", value: "Carry a letter" }] },
        projectionSeed: { version: 1, semantics: { version: 1, operations: [] }, processes: { version: 1, operations: [] }, norms: { version: 1, operations: [] }, activeRuleIds: [], elapsedDays: 0 },
      },
    },
    readiness: null, admission: null,
  } as unknown as PreparedNovelBundle;
  bundle.canonical.timeline = deriveBundleCanonTimeline(bundle);
  return bundle;
}

describe("cut admission manifest", () => {
  it("admits the prefix before an injected replay failure, blocks later cuts and recovers monotonically", async () => {
    const broken = fixture(true);
    const manifest = await buildAdmissionManifest(broken);
    expect(manifest.baselineIndex).toBe(0);
    expect(manifest.replay).toMatchObject({ limitIndex: 1, failedEventId: "letter" });
    expect(manifest.horizonIndex).toBe(1);
    expect(manifest.cuts.map((cut) => [cut.beforeEventId, cut.sceneId, cut.tier])).toEqual([
      ["arrival", "scene-1", "reviewed"], ["letter", "scene-2", "replayable"], ["farewell", "scene-3", "blocked"],
    ]);
    const opening = manifest.cuts[0]!;
    expect(opening.actors.find((actor) => actor.actorId === "hero")).toMatchObject({ tier: "reviewed", entryBasis: "opening" });
    expect(opening.actors.find((actor) => actor.actorId === "hero")!.probes.map((probe) => probe.kind)).toEqual(["genesis", "decision", "driver", "intent", "wait", "resume", "fork"]);
    expect(manifest.cuts[2]!.blocking).toEqual([
      expect.objectContaining({ code: "CUT_PREFIX_REPLAY_FAILED", path: "event/letter" }),
      expect.objectContaining({ code: "CUT_DEPENDENCY_INVALID", path: "event/letter" }),
    ]);
    expect(manifest.globalIssues.map((issue) => issue.code)).toContain("SOURCE_PARTITION_INVALID");

    const repaired = await buildAdmissionManifest(fixture(false), { probe: false });
    expect(repaired.replay).toEqual({ limitIndex: 3 });
    expect(repaired.horizonIndex).toBe(3);
    expect(repaired.cuts.every((cut) => cut.tier !== "blocked")).toBe(true);
    for (const cut of manifest.cuts) if (cut.tier !== "blocked") expect(repaired.cuts.find((item) => item.cutId === cut.cutId)?.tier).not.toBe("blocked");
  });

  it("gates play on a fresh manifest and the minimum tier", async () => {
    const bundle = fixture(true);
    expect(() => assertPlayableRevision(bundle)).toThrow(/CUT_ADMISSION_MISSING/);
    bundle.admission = await buildAdmissionManifest(bundle);
    expect(admissionManifestIssues(bundle, bundle.admission)).toEqual([]);
    expect(assertPlayableRevision(bundle)).toBe("admitted");
    const opening = cutIdFor("arrival", bundle.canonical.timeline!.hash);
    expect(assertCutAdmission(bundle, opening, "hero").actor.tier).toBe("reviewed");
    expect(() => assertCutAdmission(bundle, opening, "hero", "certified")).toThrow(/certified is required/);
    expect(() => assertCutAdmission(bundle, cutIdFor("farewell", bundle.canonical.timeline!.hash), "hero")).toThrow(/blocked \(CUT_PREFIX_REPLAY_FAILED, CUT_DEPENDENCY_INVALID\)/);
    expect(() => assertCutAdmission(bundle, "f".repeat(64), "hero")).toThrow(/unknown cut/);
    expect(admittedEntries(bundle).map(({ cut, actor }) => `${cut.beforeEventId}:${actor.actorId}`)).toEqual(["arrival:hero"]);
    const stale = { ...bundle, canonical: { ...bundle.canonical, events: [...bundle.canonical.events, sceneEvent("late", 400)] } };
    stale.canonical.timeline = deriveBundleCanonTimeline(stale);
    expect(admissionManifestIssues(stale, bundle.admission).join(" ")).toMatch(/CUT_ADMISSION_STALE/);
    expect(admittedEntries(stale)).toEqual([]);
  });

  it("blocks positions after the earliest unaccounted source unit and derives the contiguous horizon", () => {
    const timeline = buildCanonTimeline({ sourceId: "s", relations: [], events: [sceneEvent("a", 100), sceneEvent("b", 200), sceneEvent("c", 300)] });
    const issue = { code: "SOURCE_UNIT_UNACCOUNTED", message: "unit", path: "u" };
    const blockers = accountingBlockers(timeline, [{ startByte: 250, issue }, { startByte: 900, issue }]);
    expect(blockers).toEqual([expect.objectContaining({ from: 2 })]);
    expect(horizonFromBlockers(0, 3, blockers)).toBe(1);
    expect(horizonFromBlockers(0, 3, [])).toBe(3);
    expect(horizonFromBlockers(1, 3, [{ from: 1, issue }])).toBe(0);
    expect(accountingBlockers(timeline, [{ startByte: 5_000, issue }])).toEqual([expect.objectContaining({ from: 3 })]);
  });
});
