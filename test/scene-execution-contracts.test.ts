import { expect, it } from "vitest";
import { buildSceneExecutionContracts, validateSceneTravel } from "../src/compiler/scene-execution-contracts.js";
import { actionSchemaSchema } from "../src/world/action-ontology.js";
import type { PreparedNovelBundle } from "../src/compiler/prepared-cache.js";
import { canonicalEventSchema } from "../src/world/model.js";
import { spatialRelationSchema } from "../src/world/spatial-ontology.js";

it("executes scene preconditions at distinct historical cuts and proves entry and exit conditions", () => {
  const evidence = [{ span: { sourceId: "book", startLine: 1, endLine: 1, quoteHash: "a".repeat(64) }, strength: "explicit" as const }];
  const action = actionSchemaSchema.parse({ ontologyVersion: "action-schema-v1", id: "spend", name: "Spend", initiatorRoleId: "actor",
    roles: [{ id: "actor", label: "Actor", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 }], parameters: [],
    preconditions: [{ op: "fact-gte", entity: { kind: "role", roleId: "actor" }, field: "character.wealth", value: 1 }],
    stateEffects: [{ op: "adjust-number", entity: { kind: "role", roleId: "actor" }, field: "character.wealth", amount: -1 }],
    effectEnvelope: { maxStateOperations: 1, allowedStateFields: ["character.wealth"], allowsKnowledge: false, allowsTimeAdvance: false, allowsSceneTransition: false },
    induction: { kind: "domain-module", moduleId: "money", moduleVersion: "1" }, evidence: [] });
  const events = [1, 2].map((n) => canonicalEventSchema.parse({ id: `e${n}`, title: "Spend", participants: ["hero"],
    participantPresence: [{ entityId: "hero", mode: "physical" }], storyTime: { kind: "ordinal", label: `${n}`, orderHint: n }, preconditions: [],
    observedOutcome: { version: 1, operations: [{ op: "adjust-number", entityId: "hero", field: "character.wealth", amount: -1 }] },
    action: { lane: "schema-bound", schemaId: "spend", roleBindings: [{ roleId: "actor", entityIds: ["hero"] }], parameters: {} },
    sceneOccurrenceIds: [`s${n}`], evidence, causalParents: [], confidence: 1 }));
  const input = { source: { id: "book" }, canonical: { entities: [{ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence }],
    events, actionSchemas: [action], sceneOccurrences: events.map((event, i) => ({ ontologyVersion: "scene-occurrence-v1", id: `s${i + 1}`, discourseSegmentIds: ["discourse"], eventIds: [event.id], viewpointActorIds: ["hero"], presentActorIds: ["hero"],
      entryConditions: [{ op: "fact-equals", entityId: "hero", field: "character.wealth", value: 3 - i }], exitConditions: [{ op: "fact-equals", entityId: "hero", field: "character.wealth", value: 2 - i }], evidence })),
    initialWorld: { delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.wealth", value: 3 }] }, checkpoint: { beforeCanonicalEventId: "e1", storyTime: events[0]!.storyTime } },
    propositions: [], attributions: [], claims: [], eventParticipations: [], eventRelations: [], spatialRelations: [], eventFrames: [], eventExecutions: [], actionConstraints: [], normTemplates: [], processTemplates: [], rules: [], goals: [], models: [], possibilities: [] },
    compilerSnapshot: { roleRoster: null, structure: { units: [], baseUnitIds: [], discourseSegments: [{ id: "discourse" }] }, annotations: [], entityResolutions: [], eventResolutions: [], evidenceBindings: [] } } as unknown as PreparedNovelBundle;
  const result = buildSceneExecutionContracts(input);
  expect(result.issues).toEqual([]);
  expect(result.contracts[0]!.entryCutIds).not.toEqual(result.contracts[1]!.entryCutIds);
  input.canonical.initialWorld.delta.operations[0] = { op: "set", entityId: "hero", field: "character.wealth", value: 0 };
  expect(buildSceneExecutionContracts(input).issues).toContainEqual(expect.objectContaining({ code: "SCENE_EXECUTION_INVALID", message: expect.stringContaining("ACTION_SCHEMA_PRECONDITION_FAILED") }));
});

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
