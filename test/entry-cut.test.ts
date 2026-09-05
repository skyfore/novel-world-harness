import { describe, expect, it } from "vitest";
import { deriveEntryCut } from "../src/world/entry-cut.js";
import type { CanonicalEvent, EventRelation } from "../src/world/model.js";

function event(id: string, day: number | undefined, discourseOrder: number, mode: "scene" | "flashback" | "flashforward" = "scene"): CanonicalEvent {
  return { id, title: id, participants: ["hero"], storyTime: day === undefined ? { kind: "unknown" } : { kind: "ordinal", label: `day ${day}`, orderHint: day },
    narrativeContext: { mode, layerId: "story", discourseOrder }, preconditions: [], observedOutcome: { version: 1, operations: [{ op: "adjust", entityId: "hero", field: "character.wealth", amount: -1 }] },
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
