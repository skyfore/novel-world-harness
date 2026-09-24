import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { characterModelSchema } from "../src/world/actors.js";
import { WorldEngine } from "../src/world/engine.js";
import { WorldRuntime } from "../src/world/runtime.js";
import { projectCharacterDevelopment } from "../src/world/development.js";
import { findSpatialRoute, resolveActiveSpatialRelations, spatialRelationSchema } from "../src/world/spatial-ontology.js";
import { policyEpisodeTimeActive, policyStoryScopeActive, policyStoryScopeTruth } from "../src/world/policy-time.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import type { Entity, StoryTime } from "../src/world/model.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
it.each([
  { actor: "ada", target: "bo", day: "2000-03-04", text: "On March 4, 2000, Ada deliberates carefully and trusts Bo. The footpath from the gate to the field is available that day. Initially only the year is established; the date is then confirmed." },
  { actor: "neri", target: "venn", day: "2000-09-12", text: "On September 12, 2000, Neri deliberates carefully and trusts Venn. The footpath from the gate to the field is available that day. Initially only the year is established; the date is then confirmed." },
])("uses the same proven scope for character, relationship and route policy: $actor", async scene => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-policy-time-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, scene.text), evidence = fixture.evidence(scene.text);
  const window: StoryTime = { kind: "exact", value: scene.day, precision: "day" };
  const model = characterModelSchema.parse({ actorId: scene.actor, ontologyVersion: "character-v1", relationshipOntologyVersion: "relationship-v1", traits: {}, decisionBiases: {}, evidence,
    dispositions: [{ id: "deliberates", actorId: scene.actor, dimensionId: "deliberation", value: 0.7, scope: { kind: "global" }, stability: "situational",
      basis: "explicit-characterization", status: "supported", confidence: 1, validStoryTime: window, evidence }],
    relationshipStances: [{ id: "trusts", actorId: scene.actor, relationshipEntityId: "bond", targetEntityId: scene.target, dimensionId: "trust", value: 0.7,
      stability: "situational", basis: "explicit-characterization", status: "supported", confidence: 1, validStoryTime: window, evidence }],
  });
  const route = spatialRelationSchema.parse({ ontologyVersion: "spatial-v1", id: "path", kind: "route", fromLocationId: "gate", toLocationId: "field", direction: "two-way", modes: ["foot"],
    validStoryTime: window, basis: "explicit", visibility: "public", status: "supported", confidence: 1, evidence });
  const entities: Entity[] = [
    ...[scene.actor, scene.target].map(id => ({ id, kind: "character" as const, canonicalName: id, aliases: [], evidence })),
    ...["gate", "field"].map(id => ({ id, kind: "location" as const, canonicalName: id, aliases: [], evidence })),
    { id: "bond", kind: "relationship", canonicalName: "Friendship", aliases: [], evidence },
  ];
  const engine = new WorldEngine(root, { sourceId: fixture.source.id, entities: new Map(entities.map(entity => [entity.id, entity])), rules: new Map(),
    actorModels: new Map([[scene.actor, model]]), spatialRelations: [route], stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS) });
  const head = await engine.createBranch("main", "Year only", { version: 1, operations: [
    { op: "set", entityId: scene.actor, field: "character.alive", value: true },
    { op: "set", entityId: scene.target, field: "character.alive", value: true },
    { op: "set", entityId: scene.actor, field: "character.relationships", value: ["bond"] },
    { op: "set", entityId: "bond", field: "relationship.from", value: scene.actor },
    { op: "set", entityId: "bond", field: "relationship.to", value: scene.target },
    { op: "set", entityId: "bond", field: "relationship.type", value: "friendship" },
    { op: "set", entityId: "bond", field: "relationship.active", value: true },
  ] }, undefined, undefined, undefined, [], { storyTime: { kind: "exact", value: "2000", precision: "year" } });
  const before = await projectCharacterDevelopment(engine, scene.actor, head);
  expect(before.model?.dispositions).toEqual([]);
  expect(before.model?.relationshipStances).toEqual([]);
  expect(findSpatialRoute(resolveActiveSpatialRelations([route], { state: await engine.projector.project(head), realizedCanonicalEventIds: new Set() }), "gate", "field", "foot")).toBeUndefined();
  const runtime = new WorldRuntime(engine, () => []);
  await runtime.forkBranch("main", head, "unresolved", "Unresolved");
  const confirmed = await engine.commitProposal({ proposalId: "confirm-date", branchId: "main", expectedParentCommit: head, source: "background", title: "Date confirmed",
    participants: [scene.actor, scene.target], proposedTime: window, preconditions: [], causalParents: [], evidence, proposedDelta: { version: 1, operations: [] } });
  expect(confirmed.report.errors).toEqual([]);
  expect(confirmed.report.accepted).toBe(true);
  const after = await projectCharacterDevelopment(engine, scene.actor, confirmed.newHead);
  expect(after.model?.dispositions.map(item => item.id)).toEqual(["deliberates"]);
  expect(after.model?.relationshipStances.map(item => item.id)).toEqual(["trusts"]);
  const currentState = await engine.projector.project(confirmed.newHead);
  expect(findSpatialRoute(resolveActiveSpatialRelations([route], { state: currentState, realizedCanonicalEventIds: new Set() }), "gate", "field", "foot")?.relationIds).toEqual(["path"]);
  expect(await projectCharacterDevelopment(engine, scene.actor, await engine.branches.readHead("unresolved"))).toEqual(before);
  engine.projections.clear();
  expect(await projectCharacterDevelopment(engine, scene.actor, confirmed.newHead)).toEqual(after);
  expect((await engine.projector.project(head)).logicalTime.storyTime).toEqual({ kind: "exact", value: "2000", precision: "year" });
  const known = new Set(["signal"]);
  const offset: StoryTime = { kind: "relative", relation: "after", anchorEventId: "signal", offset: "three days" };
  expect(policyStoryScopeTruth(window, offset, known)).toBe("unknown");
  expect(policyStoryScopeActive(window, offset, known)).toBe(false);
  expect(resolveActiveSpatialRelations([{ ...route, validStoryTime: offset }], { state: currentState, realizedCanonicalEventIds: known })).toEqual([]);
  expect(policyEpisodeTimeActive(window, offset, undefined, known)).toBe(false);
  expect(policyEpisodeTimeActive(window, { kind: "relative", relation: "after", anchorEventId: "signal" }, { kind: "relative", relation: "before", anchorEventId: "end", offset: "one day" }, known)).toBe(false);
  expect(policyStoryScopeTruth(window, { kind: "relative", relation: "before", anchorEventId: "future" }, known)).toBe("unknown");
  expect(policyStoryScopeTruth(window, { kind: "relative", relation: "after", anchorEventId: "signal" }, known)).toBe("true");
  expect(policyStoryScopeTruth(window, { kind: "relative", relation: "before", anchorEventId: "signal" }, known)).toBe("false");
  expect(policyStoryScopeTruth(undefined, window, known)).toBe("unknown");
  expect(policyStoryScopeTruth(window, { kind: "unknown" }, known)).toBe("unknown");
});
