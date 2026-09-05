import { expect, it } from "vitest";
import { buildPreparedClosure, affectedClosureNodes, staleClosureNodes } from "../src/compiler/closure.js";
import type { PreparedNovelBundle } from "../src/compiler/prepared-cache.js";
import { closureRepairDiagnostics, planClosureRepair } from "../src/compiler/closure-repair.js";
import type { CompilerBatch } from "../src/compiler/batches.js";

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

it("repairs cross-chapter identity consumers without dragging in an unrelated chapter or whole-work containment", () => {
  const input = bundle();
  const span = (startByte: number, endByte: number) => ({ sourceId: "source", startByte, endByte, startLine: startByte + 1, endLine: endByte, quoteHash: "a".repeat(64) });
  input.compilerSnapshot.structure = { ...input.compilerSnapshot.structure, baseUnitIds: ["one", "two", "three"], discourseSegments: [], units: [
    { id: "work", kind: "work", anchor: span(0, 30) },
    ...["one", "two", "three"].map((id, i) => ({ id, kind: "sentence", anchor: span(i * 10, (i + 1) * 10) })),
  ] } as PreparedNovelBundle["compilerSnapshot"]["structure"];
  input.canonical.entities[0]!.evidence = [{ span: span(0, 10) }];
  input.canonical.events[0]!.evidence = [{ span: span(10, 20) }];
  const batches = ["one", "two", "three"].map((id, i) => ({ id, purpose: "semantic", chapterOrdinal: i + 1, evidence: [{ span: span(i * 10, (i + 1) * 10) }] })) as unknown as CompilerBatch[];
  const repair = planClosureRepair(input, batches, ["one"]);
  expect(repair.batchIds).toEqual(["one", "two"]);
  expect(repair.affectedNodeKeys).toContain("event/e");
  expect(repair.sourceUnitIds).toEqual(["one", "two"]);
  expect(planClosureRepair(input, batches, ["one"])).toEqual(repair);
  input.canonical.events[0]!.participants.push("missing");
  const diagnostics = closureRepairDiagnostics(buildPreparedClosure(input));
  expect(diagnostics).toContainEqual(expect.objectContaining({ stage: "identity", severity: "blocking", missingReferences: expect.arrayContaining([expect.objectContaining({ kind: "entity", id: "missing" })]) }));
});

it("indexes discourse and event resolution as their own typed dependencies", () => {
  const input = bundle();
  input.compilerSnapshot.structure.discourseSegments = [{ id: "flashback", anchors: [] }] as never;
  input.compilerSnapshot.annotations[0] = { ...input.compilerSnapshot.annotations[0], discourseSegmentId: "flashback" } as never;
  input.compilerSnapshot.eventResolutions = [{ id: "event-resolution", canonicalEventId: "e", eventMentionIds: ["mention"] }] as never;
  const graph = buildPreparedClosure(input);
  expect(graph.issues).toEqual([]);
  expect(affectedClosureNodes(graph, [{ kind: "discourse", id: "flashback" }])).toContain("event/e");
});

it("tracks entry seed dependencies without treating seed-local semantic identities as missing canonical artifacts", () => {
  const input = bundle();
  input.canonical.initialWorld.projectionSeed = { version: 1, activeRuleIds: [], elapsedDays: 0,
    semantics: { version: 1, operations: [
      { op: "record-proposition", proposition: { ...input.canonical.propositions[0]!, id: "entry-proposition" } },
      { op: "record-claim", claim: { id: "entry-claim", subject: "hero", predicate: "says", object: "hello", evidence: [], confidence: 1 } },
    ] }, processes: { version: 1, operations: [] }, norms: { version: 1, operations: [] } } as never;
  input.canonical.initialWorld.knowledge = { version: 1, operations: [{ op: "learn", actorId: "hero", claimId: "entry-claim", propositionId: "entry-proposition", status: "knows", evidence: [] }] } as never;
  const graph = buildPreparedClosure(input);
  expect(graph.issues).toEqual([]);
  const initial = graph.nodes.find((node) => node.kind === "initial")!;
  expect(initial.dependsOn).toContainEqual(expect.objectContaining({ kind: "entity", id: "hero", uses: expect.arrayContaining([expect.objectContaining({ pointer: "/knowledge/operations/0/actorId", purpose: "entry-seed" })]) }));
  expect(affectedClosureNodes(graph, [{ kind: "entity", id: "hero" }])).toContain("initial/source");
  input.canonical.initialWorld.knowledge!.operations[0] = { ...input.canonical.initialWorld.knowledge!.operations[0], claimId: "unintroduced-claim" } as never;
  expect(buildPreparedClosure(input).issues).toContainEqual(expect.objectContaining({ message: expect.stringContaining("claim/unintroduced-claim") }));
});
