import { describe, expect, it } from "vitest";
import type { PreparedNovelBundle } from "../src/compiler/prepared-cache.js";
import { DEFAULT_COMPLETENESS_POLICY, measureWorldCompleteness } from "../src/compiler/world-completeness.js";
import { formatCompletenessTable } from "../src/commands/novel-completeness.js";

const lines = ["\t“我们走。”路明非说。\n", "\t诺诺点头，“好。”\n", "\t风吹过走廊。\n", "\t“这是什么？”路明非问。\n"];
const text = lines.join("");
const source = Buffer.from(text, "utf8");
const byteOf = (needle: string, from = 0) => Buffer.byteLength(text.slice(0, text.indexOf(needle, from)), "utf8");
const anchor = (needle: string, from = 0) => {
  const startByte = byteOf(needle, from);
  return { version: 1, sourceId: "src", startByte, endByte: startByte + Buffer.byteLength(needle, "utf8"), startLine: 1, endLine: 1, exactHash: "0".repeat(64) };
};
const unitAnchors = lines.map((line, index) => anchor(line, index === 0 ? 0 : text.indexOf(line)));
const units = unitAnchors.map((unitAnchor, index) => ({ version: 1, id: `u${index}`, sourceId: "src", kind: "sentence", anchor: unitAnchor, ordinal: index, proposedBy: "deterministic", confidence: 1, evidenceAssertionIds: [] }));
const derivation = { runId: "run", worker: "test", ontologyVersion: "observation-v1" };
const span = (startByte: number, endByte: number) => ({ span: { sourceId: "src", startByte, endByte, startLine: 1, endLine: 1, quoteHash: "0".repeat(64) }, strength: "explicit" });

function bundle(): PreparedNovelBundle {
  const record = (unitId: string, status: string) => ({ version: 1, unitId, status, annotationIds: [], evidenceAssertionIds: [], reviewedBy: "model", reviewedAt: "2026-11-18T00:00:00.000Z", batchIds: [] });
  return {
    source: { id: "src" },
    admission: null,
    canonical: {
      entities: [
        { id: "lu", kind: "character", canonicalName: "路明非", aliases: [], evidence: [] },
        { id: "nono", kind: "character", canonicalName: "诺诺", aliases: [], evidence: [] },
        { id: "hall", kind: "location", canonicalName: "走廊", aliases: [], evidence: [] },
      ],
      events: [{ id: "e1", title: "走", participants: ["lu"], preconditions: [], causalParents: [], confidence: 1, evidence: [],
        observedOutcome: { version: 1, operations: [{ op: "set", entityId: "lu", field: "character.location", value: "hall" }] } }],
      eventParticipations: [{ id: "p1", eventId: "e1", entityId: "lu", role: "agent", presence: "physical", confidence: 1, evidence: [] }],
      sceneOccurrences: [{ ontologyVersion: "scene-occurrence-v1", id: "s1", discourseSegmentIds: ["ds1"], eventIds: ["e1"], locationId: "hall", viewpointActorIds: [], presentActorIds: ["lu"],
        entryConditions: [], exitConditions: [], evidence: [span(unitAnchors[0]!.startByte, unitAnchors[1]!.endByte)] }],
      spatialRelations: [], semanticEffects: [], eventExecutions: [], acquisitions: [], goals: [],
      models: [{ actorId: "lu", traits: { brave: 0.5 }, decisionBiases: {}, evidence: [] }],
      initialWorld: { delta: { version: 1, operations: [] }, participantPresence: [{ entityId: "lu", mode: "physical" }] },
    },
    compilerSnapshot: {
      structure: { units, baseUnitIds: units.map((unit) => unit.id) },
      annotations: [
        { version: 1, id: "m1", sourceId: "src", derivation, annotationType: "entity-mention", anchor: anchor("路明非"), surface: "路明非", form: "proper", kindCandidates: ["character"], confidence: 1 },
        { version: 1, id: "m2", sourceId: "src", derivation, annotationType: "entity-mention", anchor: anchor("诺诺"), surface: "诺诺", form: "proper", kindCandidates: ["character"], confidence: 1 },
        { version: 1, id: "q1", sourceId: "src", derivation, annotationType: "quotation", anchor: anchor("“我们走。”"), mode: "direct", speakerMentionId: "m1", addresseeMentionIds: [], attributionConfidence: 1 },
        { version: 1, id: "ds1", sourceId: "src", derivation, annotationType: "discourse-segment", kind: "scene", anchors: [unitAnchors[0]], confidence: 1 },
        { version: 1, id: "em1", sourceId: "src", derivation, annotationType: "event-mention", triggerAnchor: anchor("走"), trigger: "走", extentAnchors: [unitAnchors[0]],
          eventTypeCandidates: ["movement"], participantMentionIds: ["m1"], salience: "major", confidence: 1 },
      ],
      entityResolutions: [
        { id: "r1", mentionId: "m1", status: "resolved", entityId: "lu" },
        { id: "r2", mentionId: "m2", status: "resolved", entityId: "nono" },
      ],
      eventResolutions: [{ id: "er1", eventMentionIds: ["em1"], status: "new-event", canonicalEventId: "e1", supersedesResolutionIds: [] }],
      evidenceBindings: [],
      accounting: { records: [record("u0", "represented"), record("u1", "background-only"), record("u2", "background-only"), record("u3", "duplicate-description")] },
      roleRoster: null,
    },
  } as unknown as PreparedNovelBundle;
}

describe("world-model completeness", () => {
  const policy = { ...DEFAULT_COMPLETENESS_POLICY, speakingLineThreshold: 1 };
  const report = measureWorldCompleteness(bundle(), source, { policy });
  const byId = new Map(report.measures.map((item) => [item.id, item]));

  it("counts source-derived denominators and exposes units whose disposition hides speech or names", () => {
    expect(byId.get("source.accounted")).toMatchObject({ numerator: 4, total: 4, status: "satisfied" });
    // Unit 1 hides unannotated speech (its name is annotated); unit 3 hides speech and a name; unit 2 has no signal.
    expect(byId.get("source.hidden-units")).toMatchObject({ numerator: 2, status: "gap" });
    expect(report.queues.hiddenUnits.ranges.map((range) => [range.startByte, range.speech, range.names]))
      .toEqual([[unitAnchors[1]!.startByte, 1, 0], [unitAnchors[3]!.startByte, 1, 1]]);
    expect(byId.get("observation.speech-annotated")).toMatchObject({ numerator: 1, total: 3, denominator: "source", status: "gap" });
    expect(byId.get("observation.speech-attributed")).toMatchObject({ numerator: 3, total: 3, status: "satisfied",
      note: "1 by compiled quotation annotations, 2 by host lexical cue only." });
    expect(byId.get("observation.names-annotated")).toMatchObject({ numerator: 2, total: 3 });
  });

  it("checks scene presence, space and character depth against who actually speaks", () => {
    expect(byId.get("scenes.speakers-present")).toMatchObject({ numerator: 1, total: 2, status: "gap" });
    expect(report.queues.absentSpeakers).toEqual([{ sceneId: "s1", actorId: "nono", lines: 1 }]);
    expect(byId.get("space.locations-on-graph")).toMatchObject({ numerator: 0, total: 1, status: "gap" });
    expect(report.queues.locationsOffGraph).toEqual(["hall"]);
    expect(report.speakingCharacters.map((item) => [item.actorId, item.lines, item.depth])).toEqual([["lu", 2, true], ["nono", 1, false]]);
    expect(byId.get("characters.speaking-with-disposition")).toMatchObject({ numerator: 1, total: 2 });
    expect(byId.get("events.effectful")).toMatchObject({ numerator: 1, total: 1, status: "satisfied" });
  });

  it("reports a missing denominator as unknown, never as a pass", () => {
    expect(byId.get("characters.roster-reviewed")!.status).toBe("unknown");
    expect(byId.get("agency.speaking-enterable")!.status).toBe("unknown");
    expect(byId.get("knowledge.acquisition-paths")).toMatchObject({ total: 0, ratio: null, status: "unknown" });
    expect(report.summary.unknown).toBeGreaterThanOrEqual(3);
    expect(formatCompletenessTable(report).split("\n")[0]).toContain("unknown");
  });
});
