import { describe, expect, it } from "vitest";
import {
  eventRelationProjectsLegacyCausalParent,
  projectEventRelations,
  validateEventRelationCatalog,
} from "../src/world/event-relations.js";
import { eventRelationSchema, type CanonicalEvent, type EventRelation } from "../src/world/model.js";

function event(id: string, orderHint: number, causalParents: string[] = []): CanonicalEvent {
  return {
    id,
    title: id,
    participants: [],
    storyTime: { kind: "ordinal", label: id, orderHint },
    preconditions: [],
    observedOutcome: { version: 1, operations: [] },
    evidence: [],
    causalParents,
    confidence: 1,
  };
}

const first = event("first", 1);
const second = event("second", 2, ["first"]);
const third = event("third", 3, ["second"]);
const events = new Map([[first.id, first], [second.id, second], [third.id, third]]);

function relation(
  id: string,
  fromEventId: string,
  toEventId: string,
  type: EventRelation["type"],
): EventRelation {
  return {
    id,
    fromEventId,
    toEventId,
    type,
    status: "inferred",
    confidence: 0.8,
    ...(["causes", "enables", "prevents", "motivates", "explains"].includes(type)
      ? { mechanism: `${fromEventId} makes ${toEventId} possible` }
      : {}),
    evidence: [],
  };
}

describe("typed event relations", () => {
  it("validates independent temporal and causal relations and projects only causes/enables", () => {
    const relations = [
      relation("first-causes-second", "first", "second", "causes"),
      relation("second-enables-third", "second", "third", "enables"),
      relation("first-before-second", "first", "second", "before"),
      relation("second-before-third", "second", "third", "before"),
      relation("first-narrative-third", "first", "third", "narrative-continuation"),
    ];

    expect(validateEventRelationCatalog({ events, relations })).toEqual([]);
    expect(projectEventRelations(second, relations)).toEqual(second);
    expect(projectEventRelations(third, relations)).toEqual(third);
    expect(eventRelationProjectsLegacyCausalParent(relations[0]!)).toBe(true);
    expect(eventRelationProjectsLegacyCausalParent(relations[4]!)).toBe(false);
  });

  it("does not let narrative continuation satisfy a required causal projection", () => {
    const narrative = relation("first-continues-second", "first", "second", "narrative-continuation");
    const issues = validateEventRelationCatalog({
      events,
      relations: [narrative],
      requireCompleteCausalProjectionForEventIds: new Set(["second"]),
    });

    expect(issues).toContainEqual(expect.objectContaining({ code: "INCOMPLETE_CAUSAL_RELATION_PROJECTION" }));
  });

  it("keeps contested causal interpretations reviewable but outside runtime causal ancestry", () => {
    const contested = {
      ...relation("first-may-cause-second", "first", "second", "causes"),
      status: "contested" as const,
      counterEvidence: [{
        span: { sourceId: "novel", startLine: 1, endLine: 1, quoteHash: "counter" },
        strength: "explicit" as const,
      }],
    };

    expect(eventRelationProjectsLegacyCausalParent(contested)).toBe(false);
    expect(projectEventRelations(second, [contested])).toEqual(second);
    expect(validateEventRelationCatalog({
      events,
      relations: [contested],
      requireCompleteCausalProjectionForEventIds: new Set(["second"]),
    })).toContainEqual(expect.objectContaining({ code: "INCOMPLETE_CAUSAL_RELATION_PROJECTION" }));
  });

  it("normalizes inverse relations and blocks temporal and causal contradictions", () => {
    const issues = validateEventRelationCatalog({
      events,
      relations: [
        relation("first-before-second", "first", "second", "before"),
        relation("second-after-first", "second", "first", "after"),
        relation("second-before-first", "second", "first", "before"),
        relation("first-causes-second", "first", "second", "causes"),
      ],
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "DUPLICATE_EVENT_RELATION" }),
      expect.objectContaining({ code: "TEMPORAL_RELATION_CONTRADICTION" }),
      expect.objectContaining({ code: "CONTRADICTORY_TEMPORAL_RELATION" }),
      expect.objectContaining({ code: "CAUSAL_TEMPORAL_CONTRADICTION" }),
      expect.objectContaining({ code: "TEMPORAL_RELATION_CYCLE" }),
    ]));
  });

  it("detects causal cycles independently from legacy parent projection", () => {
    const cyclicEvents = new Map([
      ["first", event("first", 1, ["third"])],
      ["second", event("second", 2, ["first"])],
      ["third", event("third", 3, ["second"])],
    ]);
    const issues = validateEventRelationCatalog({
      events: cyclicEvents,
      relations: [
        relation("first-causes-second", "first", "second", "causes"),
        relation("second-causes-third", "second", "third", "causes"),
        relation("third-causes-first", "third", "first", "causes"),
      ],
    });

    expect(issues).toContainEqual(expect.objectContaining({ code: "CAUSAL_RELATION_CYCLE" }));
  });

  it("requires evidence/status semantics at schema validation time", () => {
    const base = {
      id: "first-causes-second",
      fromEventId: "first",
      toEventId: "second",
      type: "causes" as const,
      confidence: 0.8,
      evidence: [],
    };
    expect(eventRelationSchema.safeParse({ ...base, status: "explicit" }).success).toBe(false);
    expect(eventRelationSchema.safeParse({ ...base, status: "inferred" }).success).toBe(false);
    expect(eventRelationSchema.safeParse({ ...base, status: "contested", mechanism: "Weather", counterEvidence: [] }).success).toBe(false);
  });
});
