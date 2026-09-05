import { expect, it } from "vitest";
import { buildPreparedClosure, affectedClosureNodes, staleClosureNodes } from "../src/compiler/closure.js";
import type { PreparedNovelBundle } from "../src/compiler/prepared-cache.js";

function bundle(): PreparedNovelBundle {
  return {
    source: { id: "source", contentSha256: "a".repeat(64), contentMd5: "b".repeat(32) },
    canonical: { entities: [{ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] }, { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: [] }],
      propositions: [{ id: "p", subjectEntityId: "hero", relationId: "says", object: { kind: "literal", value: "unknown-entity-name is prose" }, polarity: "positive", modality: "asserted", evidence: [] }],
      attributions: [], claims: [], eventParticipations: [], eventRelations: [], spatialRelations: [], sceneOccurrences: [], eventFrames: [], actionSchemas: [], actionConstraints: [], normTemplates: [], processTemplates: [], rules: [], goals: [], models: [], possibilities: [],
      events: [{ id: "e", title: "Hero enters", participants: ["hero"], storyTime: { kind: "unknown" }, preconditions: [], observedOutcome: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.location", value: "hall" }] }, causalParents: [], evidence: [], confidence: 1 }],
      initialWorld: { version: 1, delta: { version: 1, operations: [] }, evidence: [] },
    },
    compilerSnapshot: { structure: { units: [] }, annotations: [{ id: "mention", annotationType: "entity-mention" }], entityResolutions: [{ id: "resolution", mentionId: "mention", entityId: "hero" }], eventResolutions: [], evidenceBindings: [], accounting: null },
  } as unknown as PreparedNovelBundle;
}

it("records explicit typed missing references and never treats proposition prose as an entity ID", () => {
  const input = bundle();
  expect(buildPreparedClosure(input).issues).toEqual([]);
  input.canonical.events[0]!.observedOutcome.operations.push({ op: "set", entityId: "hero", field: "character.location", value: "missing-location" });
  expect(buildPreparedClosure(input).issues).toContainEqual(expect.objectContaining({ code: "CLOSURE_DANGLING_REFERENCE", message: expect.stringContaining("entity/missing-location") }));
});

it("identity revision changes invalidate downstream semantics and events through cyclic dependencies", () => {
  const input = bundle(), graph = buildPreparedClosure(input);
  expect(affectedClosureNodes(graph, [{ kind: "entity-resolution", id: "resolution" }])).toEqual(expect.arrayContaining(["entity/hero", "proposition/p", "event/e"]));
  input.canonical.entities[0]!.aliases = ["The Regent"];
  expect(staleClosureNodes(graph, buildPreparedClosure(input))).toEqual(expect.arrayContaining(["entity/hero", "event/e", "entity-resolution/resolution"]));
  expect(staleClosureNodes(graph, graph)).toEqual([]);
});
