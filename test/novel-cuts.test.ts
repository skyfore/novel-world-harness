import { describe, expect, it } from "vitest";
import type { PreparedNovelBundle } from "../src/compiler/prepared-cache.js";
import { summarizeNovelCuts } from "../src/commands/novel-cuts.js";
import { deriveBundleCanonTimeline } from "../src/world/canon-timeline.js";
import type { CanonicalEvent, EventRelation } from "../src/world/model.js";

const event = (id: string, line: number): CanonicalEvent => ({
  id, title: `Title ${id}`, participants: [], storyTime: { kind: "unknown" }, preconditions: [],
  observedOutcome: { version: 1, operations: [] }, causalParents: [], confidence: 1,
  evidence: [{ span: { sourceId: "src", startLine: line, endLine: line, startByte: line * 100, endByte: line * 100 + 10, quoteHash: `q${line}` }, strength: "explicit" }],
});
const before = (id: string, from: string, to: string): EventRelation => ({ id, fromEventId: from, toEventId: to, type: "before", operationality: "non-operational", status: "inferred", confidence: 1, evidence: [] });

function bundle(events: CanonicalEvent[], relations: EventRelation[] = []): PreparedNovelBundle {
  return {
    source: { id: "src" },
    canonical: { events, eventRelations: relations, sceneOccurrences: [{ id: "scene-1", eventIds: [events[0]!.id] }] },
  } as unknown as PreparedNovelBundle;
}

describe("compile-novel cuts diagnostics", () => {
  it("lists the full timeline with scenes and reports a frozen or derived origin", () => {
    const prepared = bundle([event("b", 2), event("a", 1), event("c", 3)]);
    const derived = summarizeNovelCuts(prepared);
    expect(derived.bundle.frozenTimeline).toBe(false);
    expect(derived.timeline).toMatchObject({ events: 3, ordered: 3, cycles: 0, assumedPairs: 0 });
    expect(derived.timeline.entries.map((entry) => [entry.index, entry.eventId, entry.sceneIds])).toEqual([[0, "a", []], [1, "b", ["scene-1"]], [2, "c", []]]);
    expect(derived.timeline.issueCounts).toEqual({ TIMELINE_ANCHOR_MISSING: 3 });
    prepared.canonical.timeline = deriveBundleCanonTimeline(prepared);
    expect(summarizeNovelCuts(prepared, "revision", { bundleHash: "f".repeat(64) }).bundle).toMatchObject({ origin: "revision", frozenTimeline: true, bundleHash: "f".repeat(64) });
  });

  it("counts each constraint cycle once and reports where cuts become blocked", () => {
    const report = summarizeNovelCuts(bundle([event("a", 1), event("p", 2), event("q", 3)], [before("pq", "p", "q"), before("qp", "q", "p")]));
    expect(report.timeline.cycles).toBe(1);
    expect(report.timeline.blockedFromIndex).toBe(1);
    expect(report.timeline.entries.filter((entry) => "cycle" in entry).map((entry) => entry.eventId)).toEqual(["p", "q"]);
  });
});

describe("compile-novel cuts admission summary", () => {
  it("reports tiers, the first blocking cause and coverage per cut", async () => {
    const { summarizeAdmission } = await import("../src/commands/novel-cuts.js");
    const issue = { code: "CUT_PREFIX_REPLAY_FAILED", message: "Canonical event b fails", path: "event/b" };
    const manifest = {
      version: 1 as const, sourceId: "src", subjectHash: "a".repeat(64), timelineHash: "b".repeat(64), baselineIndex: 0, horizonIndex: 1,
      replay: { limitIndex: 1, failedEventId: "b", failure: "fails" }, globalIssues: [],
      cuts: [
        { cutId: "c".repeat(64), beforeEventId: "a", sceneId: "s1", sceneIds: ["s1"], index: 0, discourseByte: 1, tier: "enterable" as const, blocking: [], advisories: [], dependsOn: [], closureHash: "d".repeat(64),
          actors: [{ actorId: "hero", tier: "enterable" as const, entryBasis: "opening" as const, probes: [], issues: [] }, { actorId: "villain", tier: "replayable" as const, entryBasis: "derived" as const, probes: [], issues: [{ code: "MAJOR_ROLE_ENTRY_BLOCKED", message: "x" }] }] },
        { cutId: "e".repeat(64), beforeEventId: "c", sceneIds: ["s2", "s3"], index: 2, discourseByte: 3, tier: "blocked" as const, blocking: [issue, { ...issue, code: "CUT_DEPENDENCY_INVALID" }], advisories: [], dependsOn: [], closureHash: "f".repeat(64), actors: [] },
      ],
    };
    const summary = summarizeAdmission(manifest, { origin: "frozen", probed: true, scenes: 4 });
    expect(summary.coverage).toEqual({ cuts: 2, tiers: { enterable: 1, blocked: 1 }, scenes: 4, scenesAdmissible: 1, admittedEntries: 1, minimumTier: "enterable" });
    expect(summary.cuts[1]).toMatchObject({ tier: "blocked", firstBlocking: issue, blockingCodes: ["CUT_PREFIX_REPLAY_FAILED", "CUT_DEPENDENCY_INVALID"] });
    expect(summary.cuts[0]!.actors[1]).toMatchObject({ actorId: "villain", firstIssue: { code: "MAJOR_ROLE_ENTRY_BLOCKED" } });
    expect(summarizeAdmission(manifest, { origin: "computed", probed: false, scenes: 4, minimumTier: "replayable" }).coverage.admittedEntries).toBe(2);
  });
});
