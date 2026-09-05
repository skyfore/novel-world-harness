import { expect, it } from "vitest";
import { validateSceneTravel } from "../src/compiler/scene-execution-contracts.js";
import type { PreparedNovelBundle } from "../src/compiler/prepared-cache.js";
import { canonicalEventSchema } from "../src/world/model.js";
import { spatialRelationSchema } from "../src/world/spatial-ontology.js";

it("uses the actual pre-event route mechanism and rejects impossible duration or unrelated effects", () => {
  const evidence = [{ span: { sourceId: "book", startLine: 1, endLine: 1, quoteHash: "a".repeat(64) }, strength: "explicit" as const }];
  const event = canonicalEventSchema.parse({ id: "walk", title: "Hero walks to the port", storyTime: { kind: "ordinal", label: "opening", orderHint: 1 }, participants: ["hero"], preconditions: [], causalParents: [], confidence: 1, evidence,
    action: { lane: "ad-hoc", actionKindId: "walk", description: "Walk to port", footprint: { reads: [], writes: [{ entityId: "hero", field: "character.location" }], resources: [] }, travelMode: "foot" }, timeAdvance: { amount: 2, unit: "hour" },
    observedOutcome: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.location", value: "port" }] } });
  const route = spatialRelationSchema.parse({ ontologyVersion: "spatial-v1", id: "road", kind: "route", basis: "explicit", fromLocationId: "village", toLocationId: "port", direction: "two-way", modes: ["foot"], duration: { minimum: 2, unit: "hour" }, evidence, confidence: 1, status: "supported", visibility: "public", establishedByEventIds: [], retiredByEventIds: [], requires: [], blockedWhen: [] });
  const bundle = { source: { id: "book" }, canonical: {
    entities: ["hero", "village", "port"].map((id) => ({ id, kind: id === "hero" ? "character" : "location", canonicalName: id, aliases: [], evidence })),
    events: [event], eventRelations: [], rules: [], spatialRelations: [route],
    initialWorld: { checkpoint: { beforeCanonicalEventId: event.id, storyTime: event.storyTime }, delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.location", value: "village" }] } },
  } } as unknown as PreparedNovelBundle;
  expect(validateSceneTravel(bundle, event, "hero")).toEqual({ issues: [], relationIds: ["road"] });
  expect(validateSceneTravel(bundle, { ...event, timeAdvance: { amount: 1, unit: "hour" } }, "hero").issues).toContainEqual(expect.objectContaining({ code: "SPATIAL_TRAVEL_TOO_FAST" }));
  expect(validateSceneTravel(bundle, { ...event, observedOutcome: { version: 1, operations: [...event.observedOutcome.operations, { op: "set", entityId: "hero", field: "character.wealth", value: 1000 }] } }, "hero").issues).toContainEqual(expect.objectContaining({ code: "ACTOR_EFFECT_REQUIRES_MECHANISM" }));
});
