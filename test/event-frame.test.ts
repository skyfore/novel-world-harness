import { describe, expect, it } from "vitest";
import type { CanonicalEvent, Entity } from "../src/world/model.js";
import { validateEventFrameInstance, type EventFrame } from "../src/world/event-frame.js";

const entities = new Map<string, Entity>([
  ["hero", { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] }],
  ["gate", { id: "gate", kind: "location", canonicalName: "Gate", aliases: [], evidence: [] }],
]);

const frame: EventFrame = {
  ontologyVersion: "event-frame-v1",
  id: "enter-place",
  name: "Enter a place",
  temporalShape: "instant",
  roles: [
    { id: "mover", label: "Mover", semanticRole: "agent", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1, presence: "physical" },
    { id: "destination", label: "Destination", semanticRole: "destination", allowedEntityKinds: ["location"], minCardinality: 1, maxCardinality: 1 },
  ],
  evidence: [],
};

const event: CanonicalEvent = {
  id: "hero-enters",
  title: "Hero enters",
  participants: ["hero", "gate"],
  participantPresence: [{ entityId: "hero", mode: "physical" }],
  storyTime: { kind: "ordinal", label: "opening", orderHint: 1 },
  preconditions: [],
  observedOutcome: { version: 1, operations: [] },
  evidence: [],
  causalParents: [],
  confidence: 1,
};

describe("EventFrame", () => {
  it("accepts a complete occurrence binding with compatible entity kinds and presence", () => {
    expect(validateEventFrameInstance({
      frameId: frame.id,
      roleBindings: [
        { roleId: "mover", entityIds: ["hero"] },
        { roleId: "destination", entityIds: ["gate"] },
      ],
      parameters: {},
    }, frame, entities, event)).toEqual([]);
  });

  it("rejects missing, over-cardinality, wrong-kind, non-participant, and wrong-presence bindings", () => {
    const issues = validateEventFrameInstance({
      frameId: frame.id,
      roleBindings: [{ roleId: "mover", entityIds: ["gate", "hero"] }],
      parameters: {},
    }, frame, entities, { ...event, participants: ["hero"], participantPresence: [{ entityId: "hero", mode: "remote" }] });
    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "EVENT_FRAME_ROLE_CARDINALITY",
      "EVENT_FRAME_ROLE_KIND",
      "EVENT_FRAME_ENTITY_NOT_PARTICIPANT",
      "EVENT_FRAME_ROLE_PRESENCE",
      "MISSING_EVENT_FRAME_ROLE",
    ]));
  });
});
