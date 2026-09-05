import { describe, expect, it } from "vitest";
import {
  eventParticipationsByEvent,
  projectEventParticipations,
  validateEventParticipationCatalog,
} from "../src/world/event-semantics.js";
import type { CanonicalEvent, Entity, EventParticipation } from "../src/world/model.js";

const entities = new Map<string, Entity>([
  ["hero", { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] }],
  ["witness", { id: "witness", kind: "character", canonicalName: "Witness", aliases: [], evidence: [] }],
  ["parcel", { id: "parcel", kind: "artifact", canonicalName: "Parcel", aliases: [], evidence: [] }],
  ["hall", { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: [] }],
]);

const event: CanonicalEvent = {
  id: "delivery",
  title: "Hero carries the parcel into the hall",
  participants: ["hero", "parcel", "hall", "witness"],
  participantPresence: [
    { entityId: "witness", mode: "remote" },
    { entityId: "hero", mode: "physical" },
  ],
  storyTime: { kind: "unknown" },
  preconditions: [],
  observedOutcome: { version: 1, operations: [] },
  evidence: [],
  causalParents: [],
  confidence: 1,
};

const complete: EventParticipation[] = [
  { id: "delivery-hero-agent", eventId: "delivery", entityId: "hero", role: "agent", presence: "physical", confidence: 1, evidence: [] },
  { id: "delivery-hero-experiencer", eventId: "delivery", entityId: "hero", role: "experiencer", presence: "physical", confidence: 0.9, evidence: [] },
  { id: "delivery-parcel-theme", eventId: "delivery", entityId: "parcel", role: "theme", confidence: 1, evidence: [] },
  { id: "delivery-hall-location", eventId: "delivery", entityId: "hall", role: "location", confidence: 1, evidence: [] },
  { id: "delivery-witness-experiencer", eventId: "delivery", entityId: "witness", role: "experiencer", presence: "remote", confidence: 1, evidence: [] },
];

describe("typed event participation", () => {
  it("projects a complete typed role inventory losslessly to legacy runtime fields", () => {
    expect(validateEventParticipationCatalog({
      entities,
      events: new Map([[event.id, event]]),
      participations: complete,
    })).toEqual([]);

    expect(projectEventParticipations(event, complete)).toEqual(event);
    expect(projectEventParticipations(event, [])).toEqual(event);
    expect(projectEventParticipations(event, [])).not.toBe(event);
    expect(eventParticipationsByEvent([...complete].reverse()).get(event.id)?.map((item) => item.id))
      .toEqual(complete.map((item) => item.id).sort());
  });

  it("rejects partial inventories instead of silently shrinking legacy participants", () => {
    const issues = validateEventParticipationCatalog({
      entities,
      events: new Map([[event.id, event]]),
      participations: complete.filter((item) => item.entityId === "hero"),
    });

    expect(issues).toContainEqual(expect.objectContaining({ code: "INCOMPLETE_EVENT_PARTICIPATION" }));
  });

  it("rejects duplicate legacy participant slots that cannot round-trip exactly", () => {
    const issues = validateEventParticipationCatalog({
      entities,
      events: new Map([[event.id, { ...event, participants: ["hero", ...event.participants] }]]),
      participations: complete,
    });

    expect(issues).toContainEqual(expect.objectContaining({ code: "DUPLICATE_LEGACY_EVENT_PARTICIPANT" }));
  });

  it("keeps semantic role, entity kind, and character presence constraints independent", () => {
    const invalid: EventParticipation[] = [
      ...complete,
      { id: "delivery-hero-agent-copy", eventId: "delivery", entityId: "hero", role: "agent", presence: "remote", confidence: 1, evidence: [] },
      { id: "delivery-parcel-location", eventId: "delivery", entityId: "parcel", role: "location", presence: "physical", confidence: 1, evidence: [] },
    ];
    const issues = validateEventParticipationCatalog({
      entities,
      events: new Map([[event.id, event]]),
      participations: invalid,
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "DUPLICATE_EVENT_PARTICIPATION" }),
      expect.objectContaining({ code: "CONFLICTING_PARTICIPATION_PRESENCE" }),
      expect.objectContaining({ code: "INVALID_PARTICIPATION_PRESENCE" }),
      expect.objectContaining({ code: "INVALID_PARTICIPATION_ROLE" }),
    ]));
  });
});
