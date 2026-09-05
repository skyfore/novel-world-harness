import { describe, expect, it } from "vitest";
import type { CanonicalEvent, Entity, EvidenceRef } from "../src/world/model.js";
import { validateSceneOccurrenceCatalog, type SceneOccurrence } from "../src/world/scene-occurrence.js";

const evidence: EvidenceRef = {
  span: { sourceId: "novel", startLine: 1, endLine: 1, startByte: 0, endByte: 4, quoteHash: "a".repeat(64) },
  strength: "explicit",
};
const entities = new Map<string, Entity>([
  ["hero", { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [evidence] }],
  ["hall", { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: [evidence] }],
]);
const event: CanonicalEvent = {
  id: "arrival",
  title: "Arrival",
  participants: ["hero", "hall"],
  participantPresence: [{ entityId: "hero", mode: "physical" }],
  storyTime: { kind: "ordinal", label: "opening", orderHint: 1 },
  preconditions: [],
  observedOutcome: { version: 1, operations: [] },
  sceneOccurrenceIds: ["opening-scene"],
  evidence: [evidence],
  causalParents: [],
  confidence: 1,
};
const scene: SceneOccurrence = {
  ontologyVersion: "scene-occurrence-v1",
  id: "opening-scene",
  discourseSegmentIds: ["segment-1"],
  eventIds: [event.id],
  locationId: "hall",
  viewpointActorIds: ["hero"],
  presentActorIds: ["hero"],
  entryConditions: [],
  exitConditions: [],
  evidence: [evidence],
};

describe("SceneOccurrence", () => {
  it("enforces reciprocal scene/event closure and physical presence", () => {
    expect(validateSceneOccurrenceCatalog({ entities, events: new Map([[event.id, event]]), scenes: [scene] })).toEqual([]);

    const issues = validateSceneOccurrenceCatalog({
      entities,
      events: new Map([[event.id, event]]),
      scenes: [{ ...scene, eventIds: [], presentActorIds: [] }],
    });
    expect(issues).toContainEqual(expect.objectContaining({ code: "EVENT_SCENE_BACKLINK_REQUIRED" }));

    const physicalIssues = validateSceneOccurrenceCatalog({
      entities,
      events: new Map([[event.id, event]]),
      scenes: [{ ...scene, presentActorIds: [] }],
    });
    expect(physicalIssues).toContainEqual(expect.objectContaining({ code: "SCENE_PHYSICAL_PRESENCE_MISSING" }));
  });
});
