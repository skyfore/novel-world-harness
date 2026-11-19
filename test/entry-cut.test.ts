import { describe, expect, it } from "vitest";
import { deriveEntryCut } from "../src/world/entry-cut.js";
import { buildCanonTimeline } from "../src/world/canon-timeline.js";
import type { CanonicalEvent, EventRelation } from "../src/world/model.js";

function event(id: string, day: number | undefined, discourseOrder: number, mode: "scene" | "flashback" | "flashforward" = "scene"): CanonicalEvent {
  return { id, title: id, participants: ["hero"], storyTime: day === undefined ? { kind: "unknown" } : { kind: "ordinal", label: `day ${day}`, orderHint: day },
    narrativeContext: { mode, layerId: "story", discourseOrder }, preconditions: [], observedOutcome: { version: 1, operations: [{ op: "adjust-number", entityId: "hero", field: "character.wealth", amount: -1 }] },
    evidence: [], causalParents: [], confidence: 1 };
}

describe("story-time entry cuts", () => {
  it("replays a past event revealed later once, and excludes current and future outcomes", () => {
    const events = [event("opening", 0, 0), event("future-death", 3, 1, "flashforward"), event("transfer", 1, 8, "flashback"), event("transfer-mentioned", 1, 4), event("entry", 2, 5)];
    const relations: EventRelation[] = [{ id: "same-transfer", fromEventId: "transfer", toEventId: "transfer-mentioned", type: "coreference", operationality: "non-operational", status: "inferred", confidence: 1, evidence: [] }];
    const cut = deriveEntryCut({ events, relations, beforeEventId: "entry", baselineEventId: "opening" });
    expect(cut.issues).toEqual([]);
    expect(cut.replayEventIds).toEqual(["opening", "transfer"]);
    expect(cut.excludedEventIds).toEqual(["entry", "future-death"]);
    expect(cut.completedEventIds).toContain("transfer-mentioned");
    expect(deriveEntryCut({ events: [...events].reverse(), relations, beforeEventId: "entry", baselineEventId: "opening" })).toEqual(cut);
  });

  it("blocks unknown or conflicting order of material effects", () => {
    const events = [event("opening", 0, 0), event("unknown-change", undefined, 1), event("entry", 2, 2)];
    expect(deriveEntryCut({ events, relations: [], beforeEventId: "entry", baselineEventId: "opening" }).issues).toContainEqual(expect.objectContaining({ code: "ENTRY_TIME_UNKNOWN" }));
    const relations: EventRelation[] = [{ id: "wrong-order", fromEventId: "entry", toEventId: "opening", type: "before", operationality: "non-operational", status: "inferred", confidence: 1, evidence: [] }];
    expect(deriveEntryCut({ events, relations, beforeEventId: "entry", baselineEventId: "opening" }).issues).toContainEqual(expect.objectContaining({ code: "ENTRY_TIME_CONFLICT" }));
  });

  it("requires a complete checkpoint for historical entry before the opening", () => {
    const input = { events: [event("past", -2, 8, "flashback"), event("opening", 0, 0)], relations: [], beforeEventId: "past", baselineEventId: "opening" };
    expect(deriveEntryCut(input).issues).toContainEqual(expect.objectContaining({ code: "ENTRY_HISTORICAL_SEED_REQUIRED" }));
    expect(deriveEntryCut({ ...input, completeCheckpoint: true }).issues).toEqual([]);
  });
});

describe("timeline entry cuts", () => {
  const unknownTime = (id: string, mode: "scene" | "flashback" = "scene", writes = true): CanonicalEvent => ({
    ...event(id, undefined, 0, mode),
    ...(writes ? {} : { observedOutcome: { version: 1, operations: [] } }),
  });
  const at = (events: CanonicalEvent[], relations: EventRelation[] = []) => {
    const positions = Object.fromEntries(events.map((item, index) => [item.id, (index + 1) * 100]));
    return buildCanonTimeline({
      sourceId: "src", events, relations,
      annotations: events.map((item) => ({ annotationType: "event-mention" as const, id: `m-${item.id}`, triggerAnchor: { startByte: positions[item.id]!, endByte: positions[item.id]! + 5 }, extentAnchors: [{ startByte: positions[item.id]!, endByte: positions[item.id]! + 5 }] })),
      eventResolutions: events.map((item) => ({ id: `r-${item.id}`, status: "resolved", canonicalEventId: item.id, eventMentionIds: [`m-${item.id}`] })),
    });
  };

  it("decides membership by timeline index even when story time is unknown", () => {
    const events = [unknownTime("opening"), unknownTime("change"), unknownTime("entry"), unknownTime("later"), unknownTime("revealed-past", "flashback")];
    const relations: EventRelation[] = [{ id: "past-before-change", fromEventId: "revealed-past", toEventId: "change", type: "before", operationality: "non-operational", status: "explicit", confidence: 1, evidence: [{ span: { sourceId: "src", startLine: 1, endLine: 1, quoteHash: "q" }, strength: "explicit" }] }];
    const timeline = at(events, relations);
    expect(timeline.entries.map((entry) => entry.eventId)).toEqual(["opening", "revealed-past", "change", "entry", "later"]);
    const cut = deriveEntryCut({ events, relations, beforeEventId: "entry", baselineEventId: "opening", timeline });
    expect(cut.issues).toEqual([]);
    expect(cut.completedEventIds).toEqual(["change", "opening", "revealed-past"]);
    expect(cut.replayEventIds).toEqual(["opening", "revealed-past", "change"]);
    expect(cut.excludedEventIds).toEqual(["entry", "later"]);
    expect(cut.timelineHash).toBe(timeline.hash);
    expect(cut.advisories).toEqual(expect.arrayContaining([expect.objectContaining({ code: "ENTRY_EFFECT_ORDER_UNKNOWN" })]));
    expect(deriveEntryCut({ events, relations }).issues).toContainEqual(expect.objectContaining({ code: "ENTRY_TIME_UNKNOWN" }));
    expect(deriveEntryCut({ events: [...events].reverse(), relations, beforeEventId: "entry", baselineEventId: "opening", timeline })).toEqual(cut);
  });

  it("replays only from the opening position and needs a checkpoint before it", () => {
    const events = [unknownTime("prelude"), unknownTime("opening-point"), unknownTime("entry")];
    const timeline = at(events);
    const cut = deriveEntryCut({ events, relations: [], beforeEventId: "entry", baselineIndex: 1, timeline });
    expect(cut.completedEventIds).toEqual(["opening-point", "prelude"]);
    expect(cut.replayEventIds).toEqual(["opening-point"]);
    const historical = { events, relations: [], beforeEventId: "prelude", baselineEventId: "opening-point", timeline };
    expect(deriveEntryCut(historical).issues).toContainEqual(expect.objectContaining({ code: "ENTRY_HISTORICAL_SEED_REQUIRED" }));
    expect(deriveEntryCut({ ...historical, completeCheckpoint: true }).issues).toEqual([]);
    expect(deriveEntryCut({ ...historical, completeCheckpoint: true }).replayEventIds).toEqual([]);
  });

  it("blocks only cuts after a constraint cycle and keeps coreference conflicts hard", () => {
    const events = [unknownTime("a"), unknownTime("p"), unknownTime("q"), unknownTime("z")];
    const relation = (id: string, from: string, to: string): EventRelation => ({ id, fromEventId: from, toEventId: to, type: "before", operationality: "non-operational", status: "inferred", confidence: 1, evidence: [] });
    const cyclic = at(events, [relation("pq", "p", "q"), relation("qp", "q", "p")]);
    expect(deriveEntryCut({ events, relations: [], beforeEventId: "p", timeline: cyclic }).issues).toEqual([]);
    expect(deriveEntryCut({ events, relations: [], beforeEventId: "z", timeline: cyclic }).issues).toContainEqual(expect.objectContaining({ code: "TIMELINE_CONSTRAINT_CYCLE" }));
    const twins: EventRelation = { id: "same", fromEventId: "p", toEventId: "q", type: "coreference", operationality: "non-operational", status: "inferred", confidence: 1, evidence: [] };
    const conflicting = events.map((item) => item.id === "q" ? { ...item, observedOutcome: { version: 1 as const, operations: [{ op: "set" as const, entityId: "hero", field: "character.plan", value: "other" }] } } : item);
    const aliasTimeline = at(conflicting, [twins]);
    expect(deriveEntryCut({ events: conflicting, relations: [twins], beforeEventId: "z", timeline: aliasTimeline }).issues).toContainEqual(expect.objectContaining({ code: "ENTRY_COREFERENCE_EFFECT_CONFLICT" }));
    expect(deriveEntryCut({ events, relations: [], beforeEventId: "missing", timeline: at(events) }).issues).toContainEqual(expect.objectContaining({ code: "ENTRY_CUT_EVENT_UNKNOWN" }));
  });
});
