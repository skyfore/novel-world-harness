import { describe, expect, it } from "vitest";
import { observeCommittedEvent, projectActorVisibleState } from "../src/world/actor-visible.js";
import type { CommittedEvent } from "../src/world/model.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

function event(overrides: Partial<CommittedEvent> = {}): CommittedEvent {
  return {
    version: 2,
    eventId: "event-1",
    branchId: "main",
    logicalTime: { step: 1 },
    title: "The hidden conspirator marks Hero without Hero noticing",
    participants: ["hero"],
    effects: { version: 1, stateDeltaHash: "0".repeat(64) },
    progressCertificate: {
      version: 1,
      stateOperations: [{ effectHash: "0".repeat(64), operationIndex: 0 }],
      knowledgeOperations: [],
      semanticOperations: [],
      processOperations: [],
      normOperations: [],
      utteranceCount: 0,
      timeAdvanced: false,
      channels: ["state"],
    },
    evidence: [],
    causalParents: [],
    ...overrides,
  };
}

describe("actor-visible projection", () => {
  it("enforces self, owner, public, knowledge and engine-only state classes", () => {
    const schema = new StateSchemaRegistry([
      ...DEFAULT_STATE_FIELDS,
      { key: "character.secretScore", appliesTo: ["character"], valueType: "number", cardinality: "one" },
    ]);
    expect(projectActorVisibleState({
      "character.location": "hall",
      "character.health": 0.5,
      "character.experience": 99,
      "character.reputation": -0.2,
      "character.secretScore": 7,
    }, schema, "self")).toEqual({
      "character.location": "hall",
      "character.health": 0.5,
    });
    expect(projectActorVisibleState({
      "character.reputation": -0.2,
    }, schema, "self", new Set(["character.reputation"]))).toEqual({
      "character.reputation": -0.2,
    });
    expect(projectActorVisibleState({
      "location.open": true,
      "location.condition": 0.7,
      "location.controller": "faction-secret",
    }, schema, "public")).toEqual({
      "location.open": true,
      "location.condition": 0.7,
    });
    expect(projectActorVisibleState({
      "relationship.from": "hero",
      "relationship.to": "rival",
      "relationship.strength": -0.8,
    }, schema, "owner")).toEqual({
      "relationship.from": "hero",
      "relationship.to": "rival",
    });
  });

  it("does not equate participation with knowledge of an omniscient event title", () => {
    expect(observeCommittedEvent(event(), "hero")?.summary)
      .toBe("A committed change involving the character became perceptible.");
    expect(observeCommittedEvent(event({
      actorObservations: [{ actorId: "hero", summary: "Hero notices a cold sting." }],
    }), "hero")?.summary).toBe("Hero notices a cold sting.");
    expect(observeCommittedEvent(event({ actorId: "hero", title: "Hero opens the door" }), "hero")?.summary)
      .toBe("A committed change involving the character became perceptible.");
    expect(observeCommittedEvent(event(), "bystander")).toBeUndefined();
  });
});
