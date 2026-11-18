import { describe, expect, it } from "vitest";
import {
  buildCanonTimeline,
  canonTimelineSchema,
  timelineBlockedFromIndex,
  timelineIndex,
  TIMELINE_UNANCHORED_BYTE,
  type TimelineAnnotation,
  type TimelineEventResolution,
} from "../src/world/canon-timeline.js";
import type { CanonicalEvent, EventRelation, StoryTime } from "../src/world/model.js";

type Mode = NonNullable<CanonicalEvent["narrativeContext"]>["mode"];

function event(id: string, options: { mode?: Mode; storyTime?: StoryTime; writes?: string; evidenceByte?: number } = {}): CanonicalEvent {
  return {
    id,
    title: id,
    participants: ["hero"],
    storyTime: options.storyTime ?? { kind: "unknown" },
    ...(options.mode ? { narrativeContext: { layerId: "story", discourseOrder: 0, mode: options.mode } } : {}),
    preconditions: [],
    observedOutcome: { version: 1, operations: options.writes ? [{ op: "set", entityId: "hero", field: options.writes, value: id }] : [] },
    evidence: [{ span: { sourceId: "src", startLine: 1, endLine: 1, quoteHash: "q", ...(options.evidenceByte === undefined ? {} : { startByte: options.evidenceByte, endByte: options.evidenceByte + 10 }) }, strength: "explicit" }],
    causalParents: [],
    confidence: 1,
  };
}

function rel(from: string, type: EventRelation["type"], to: string, status: EventRelation["status"] = "inferred"): EventRelation {
  return {
    id: `${from}-${type}-${to}`, fromEventId: from, toEventId: to, type,
    operationality: ["causes", "enables"].includes(type) ? "necessary" : "non-operational",
    status, confidence: 1, evidence: [],
    ...(["causes", "enables"].includes(type) ? { mechanism: "because" } : {}),
    ...(status === "contested" ? { counterEvidence: [{ span: { sourceId: "src", startLine: 1, endLine: 1, quoteHash: "c" }, strength: "weak-inference" as const }] } : {}),
  };
}

/** One resolved event mention per event, anchored at the given byte. */
function anchors(positions: Record<string, number>): { eventResolutions: TimelineEventResolution[]; annotations: TimelineAnnotation[] } {
  const eventResolutions: TimelineEventResolution[] = [];
  const annotations: TimelineAnnotation[] = [];
  for (const [eventId, byte] of Object.entries(positions)) {
    const anchor = { startByte: byte, endByte: byte + 20 };
    annotations.push({ annotationType: "event-mention", id: `mention-${eventId}`, triggerAnchor: anchor, extentAnchors: [anchor] });
    eventResolutions.push({ id: `resolution-${eventId}`, status: "resolved", canonicalEventId: eventId, eventMentionIds: [`mention-${eventId}`] });
  }
  return { eventResolutions, annotations };
}

const order = (timeline: ReturnType<typeof buildCanonTimeline>) => timeline.entries.map((entry) => entry.eventId);
const codes = (timeline: ReturnType<typeof buildCanonTimeline>) => timeline.issues.map((issue) => `${issue.code}@${issue.path}`);

describe("canonical timeline", () => {
  it("defaults to discourse order and ignores model order hints", () => {
    const events = [
      event("late-text", { storyTime: { kind: "ordinal", label: "early", orderHint: 1 } }),
      event("early-text", { storyTime: { kind: "ordinal", label: "late", orderHint: 99 } }),
      event("middle-text"),
    ];
    const timeline = buildCanonTimeline({ sourceId: "src", events, relations: [], ...anchors({ "early-text": 10, "middle-text": 200, "late-text": 900 }) });
    expect(order(timeline)).toEqual(["early-text", "middle-text", "late-text"]);
    expect(timeline.entries.map((entry) => entry.index)).toEqual([0, 1, 2]);
    expect(timeline.entries.every((entry) => entry.basis === "discourse")).toBe(true);
    expect(timeline.entries[0]!.extents).toEqual([[10, 30]]);
    expect(timeline.issues).toEqual([]);
    expect(canonTimelineSchema.parse(timeline)).toEqual(timeline);
  });

  it("moves a proven predecessor to just before its earliest consequence", () => {
    const events = [event("a"), event("c"), event("b"), event("cause"), event("effect")];
    const relations = [rel("b", "before", "a"), rel("cause", "causes", "effect")];
    const timeline = buildCanonTimeline({ sourceId: "src", events, relations, ...anchors({ a: 100, c: 300, b: 500, effect: 600, cause: 800 }) });
    expect(order(timeline)).toEqual(["b", "a", "c", "cause", "effect"]);
    const b = timeline.entries.find((entry) => entry.eventId === "b")!;
    expect(b.basis).toBe("constraint");
    expect(b.constraintIds).toEqual(["b-before-a"]);
    expect(timeline.entries.find((entry) => entry.eventId === "c")!.basis).toBe("discourse");
  });

  it("honours after, containment and relative anchors but not contested relations", () => {
    const events = [
      event("x"), event("y"), event("inner"), event("outer"),
      event("anchored", { storyTime: { kind: "relative", anchorEventId: "x", relation: "before" } }),
      event("disputed"),
    ];
    const relations = [rel("x", "after", "y"), rel("inner", "during", "outer"), rel("disputed", "before", "x", "contested")];
    const timeline = buildCanonTimeline({ sourceId: "src", events, relations, ...anchors({ x: 10, y: 20, inner: 30, outer: 40, anchored: 50, disputed: 60 }) });
    const index = timelineIndex(timeline);
    expect(index.get("y")!).toBeLessThan(index.get("x")!);
    expect(index.get("anchored")!).toBeLessThan(index.get("x")!);
    expect(index.get("outer")!).toBeLessThan(index.get("inner")!);
    expect(index.get("disputed")!).toBe(5);
  });

  it("orders comparable calendar anchors", () => {
    const events = [
      event("spring", { storyTime: { kind: "exact", value: "2004-03-01", precision: "day" } }),
      event("winter", { storyTime: { kind: "exact", value: "2003-12-01", precision: "day" } }),
    ];
    const timeline = buildCanonTimeline({ sourceId: "src", events, relations: [], ...anchors({ spring: 10, winter: 90 }) });
    expect(order(timeline)).toEqual(["winter", "spring"]);
  });

  it("reports constraint cycles as hard errors that block from the earliest member", () => {
    const events = [event("opening"), event("p"), event("q"), event("after")];
    const relations = [rel("p", "before", "q"), rel("q", "before", "p")];
    const timeline = buildCanonTimeline({ sourceId: "src", events, relations, ...anchors({ opening: 0, p: 10, q: 20, after: 30 }) });
    expect(order(timeline)).toEqual(["opening", "p", "q", "after"]);
    expect(codes(timeline)).toEqual(["TIMELINE_CONSTRAINT_CYCLE@event/p", "TIMELINE_CONSTRAINT_CYCLE@event/q"]);
    expect(timelineBlockedFromIndex(timeline)).toBe(1);
    expect(timeline.entries.find((entry) => entry.eventId === "p")!.basis).toBe("constraint");
  });

  it("keeps an unanchored recollection at its discourse position with an advisory", () => {
    const events = [event("now"), event("memory", { mode: "recollection" }), event("next"), event("anchored-flashback", { mode: "flashback" })];
    const relations = [rel("anchored-flashback", "before", "now")];
    const timeline = buildCanonTimeline({ sourceId: "src", events, relations, ...anchors({ now: 10, memory: 20, next: 30, "anchored-flashback": 40 }) });
    expect(order(timeline)).toEqual(["anchored-flashback", "now", "memory", "next"]);
    expect(codes(timeline)).toEqual(["TIMELINE_FLASHBACK_UNANCHORED@event/memory"]);
  });

  it("keeps an unanchored flashforward behind every other event", () => {
    const events = [event("now"), event("prophecy", { mode: "flashforward" }), event("next")];
    const timeline = buildCanonTimeline({ sourceId: "src", events, relations: [], ...anchors({ now: 10, prophecy: 20, next: 30 }) });
    expect(order(timeline)).toEqual(["now", "next", "prophecy"]);
    expect(timeline.entries.at(-1)!.discourseByte).toBe(20);
    expect(codes(timeline)).toEqual(["TIMELINE_FLASHFORWARD_UNANCHORED@event/prophecy"]);
  });

  it("falls back to evidence bytes or structure lines when the mention anchor is missing", () => {
    const events = [event("anchored"), event("coarse", { evidenceByte: 50 }), event("line-only"), event("nothing")];
    const structure = { units: [{ anchor: { startByte: 0, startLine: 1 } }] };
    const timeline = buildCanonTimeline({ sourceId: "src", events: events.slice(0, 2), relations: [], ...anchors({ anchored: 100 }) });
    expect(order(timeline)).toEqual(["coarse", "anchored"]);
    expect(codes(timeline)).toEqual(["TIMELINE_ANCHOR_MISSING@event/coarse"]);
    const withLines = buildCanonTimeline({ sourceId: "src", events: events.slice(2, 3), relations: [], structure });
    expect(withLines.entries[0]!.discourseByte).toBe(0);
    const linesOnly = buildCanonTimeline({ sourceId: "src", events: [{ ...event("ten"), evidence: [{ span: { sourceId: "src", startLine: 10, endLine: 10, quoteHash: "t" }, strength: "explicit" }] }, event("one")], relations: [] });
    expect(linesOnly.entries.map((entry) => [entry.eventId, entry.discourseByte])).toEqual([["one", 1], ["ten", 10]]);
    const bare = buildCanonTimeline({ sourceId: "src", events: [{ ...events[3]!, evidence: [] }], relations: [] });
    expect(bare.entries[0]!.discourseByte).toBe(TIMELINE_UNANCHORED_BYTE);
  });

  it("excludes hypothetical events and keeps coreferent occurrences adjacent", () => {
    const events = [event("dream", { mode: "hypothetical" }), event("told"), event("between"), event("seen")];
    const relations = [rel("told", "coreference", "seen")];
    const timeline = buildCanonTimeline({ sourceId: "src", events, relations, ...anchors({ dream: 5, told: 10, between: 20, seen: 30 }) });
    expect(order(timeline)).toEqual(["told", "seen", "between"]);
    expect(timeline.entries[1]!.aliasOf).toBe("told");
    expect(timeline.entries[0]!.aliasOf).toBeUndefined();
  });

  it("ignores superseded and unresolved mention resolutions", () => {
    const base = anchors({ a: 500, b: 100 });
    base.annotations.push({ annotationType: "event-mention", id: "old", triggerAnchor: { startByte: 1, endByte: 2 }, extentAnchors: [{ startByte: 1, endByte: 2 }] });
    base.eventResolutions.push({ id: "stale", status: "resolved", canonicalEventId: "a", eventMentionIds: ["old"] });
    base.eventResolutions.push({ id: "newer", status: "ambiguous", eventMentionIds: ["old"], supersedesResolutionIds: ["stale"] });
    const timeline = buildCanonTimeline({ sourceId: "src", events: [event("a"), event("b")], relations: [], ...base });
    expect(order(timeline)).toEqual(["b", "a"]);
  });

  it("exposes same-address writers whose order is only assumed", () => {
    const events = [event("first", { writes: "character.plan" }), event("second", { writes: "character.plan" }), event("third", { writes: "character.plan" })];
    const timeline = buildCanonTimeline({ sourceId: "src", events, relations: [rel("second", "before", "third")], ...anchors({ first: 10, second: 20, third: 30 }) });
    expect(timeline.assumedPairs).toEqual([{ earlier: "first", later: "second", addresses: ["hero/character.plan"] }]);
  });

  it("breaks equal coarse coordinates with the compiler's discourse ordinal", () => {
    const events = [
      { ...event("b", { mode: "scene" }), narrativeContext: { layerId: "story", discourseOrder: 2, mode: "scene" as const } },
      { ...event("a", { mode: "scene" }), narrativeContext: { layerId: "story", discourseOrder: 1, mode: "scene" as const } },
      { ...event("z", { mode: "scene" }), narrativeContext: { layerId: "story", discourseOrder: 0, mode: "scene" as const } },
    ];
    const timeline = buildCanonTimeline({ sourceId: "src", events, relations: [] });
    expect(order(timeline)).toEqual(["z", "a", "b"]);
  });

  it("is deterministic under input permutation", () => {
    const events = [event("a"), event("b"), event("c"), event("d", { mode: "flashback" })];
    const relations = [rel("c", "before", "a"), rel("b", "enables", "c")];
    const positions = anchors({ a: 10, b: 40, c: 30, d: 20 });
    const forward = buildCanonTimeline({ sourceId: "src", events, relations, ...positions });
    const reversed = buildCanonTimeline({
      sourceId: "src", events: [...events].reverse(), relations: [...relations].reverse(),
      eventResolutions: [...positions.eventResolutions].reverse(), annotations: [...positions.annotations].reverse(),
    });
    expect(reversed).toEqual(forward);
    expect(order(forward)).toEqual(["b", "c", "a", "d"]);
  });
});
