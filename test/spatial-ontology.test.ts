import { describe, expect, it } from "vitest";
import type { EvidenceAssertion, EvidenceRef, WorldState } from "../src/world/model.js";
import {
  SPATIAL_ONTOLOGY_VERSION,
  SPATIAL_TRAVEL_MODE_IDS,
  findSpatialRoute,
  modelVisibleSpatialRelations,
  resolveActiveSpatialRelations,
  spatialLocationsMayOverlap,
  validateActiveSpatialTopology,
  spatialRelationSchema,
  validateSpatialEvidenceAssertions,
  validateSpatialRelationCatalog,
  type SpatialRelation,
} from "../src/world/spatial-ontology.js";

function evidence(index: number, strength: EvidenceRef["strength"] = "explicit"): EvidenceRef {
  return {
    span: {
      sourceId: "novel",
      startByte: index * 10,
      endByte: index * 10 + 5,
      startLine: index,
      endLine: index,
      quoteHash: String(index).padStart(64, "a").slice(-64),
    },
    strength,
  };
}

function route(overrides: Record<string, unknown> = {}): SpatialRelation {
  return spatialRelationSchema.parse({
    ...commonRelation(),
    kind: "route",
    fromLocationId: "a",
    toLocationId: "b",
    direction: "two-way",
    modes: ["foot"],
    ...overrides,
  });
}

function commonRelation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ontologyVersion: SPATIAL_ONTOLOGY_VERSION,
    id: "road-a-b",
    basis: "explicit",
    visibility: "public",
    status: "supported",
    confidence: 0.9,
    evidence: [evidence(1)],
    ...overrides,
  };
}

function contains(id: string, containerLocationId: string, containedLocationId: string): SpatialRelation {
  return spatialRelationSchema.parse({
    ...commonRelation({ id }),
    kind: "contains",
    containerLocationId,
    containedLocationId,
  });
}

function adjacent(id: string, left: string, right: string): SpatialRelation {
  return spatialRelationSchema.parse({
    ...commonRelation({ id }),
    kind: "adjacent",
    locationIds: [left, right],
  });
}

function assertion(
  relation: SpatialRelation,
  reference: EvidenceRef,
  relationType: "supports" | "contradicts" = "supports",
): EvidenceAssertion {
  return {
    version: 1,
    id: `assertion-${relationType}`,
    target: { artifactKind: "spatial-relation", artifactId: relation.id, jsonPointer: "/kind" },
    anchors: [{
      version: 1,
      sourceId: reference.span.sourceId,
      startByte: reference.span.startByte!,
      endByte: reference.span.endByte!,
      startLine: reference.span.startLine,
      endLine: reference.span.endLine,
      exactHash: reference.span.quoteHash,
      prefixHash: "b".repeat(64),
      suffixHash: "c".repeat(64),
      contextBytes: 64,
      normalization: "source-bytes-v1",
    }],
    relation: relationType,
    strength: reference.strength,
    derivation: {
      runId: "run",
      worker: "test",
      ontologyVersion: "evidence-v1",
    },
  };
}

const catalog = {
  entities: new Map(["a", "b", "c", "region", "other"].map((id) => [id, { kind: id === "other" ? "character" as const : "location" as const }])),
  events: new Map<string, unknown>([["bridge-built", {}], ["bridge-destroyed", {}]]),
  claims: new Set(["map-shows-road"]),
  rules: new Set(["curfew"]),
};

describe("spatial ontology", () => {
  it("uses a versioned controlled vocabulary and normalized symmetric adjacency", () => {
    expect(SPATIAL_TRAVEL_MODE_IDS).toContain("portal");
    expect(route()).toMatchObject({ ontologyVersion: "spatial-v1", kind: "route", modes: ["foot"] });
    expect(() => route({ modes: ["telepathy"] })).toThrow();
    expect(() => adjacent("bad-adjacency", "b", "a")).toThrow(/ascending logical-ID order/);
    expect(() => route({ visibility: "knowledge", knownByClaimIds: [] })).toThrow(/grounding claim/);
  });

  it("rejects dangling endpoints, non-location endpoints, duplicate parents, and containment cycles", () => {
    const relations = [
      contains("region-contains-a", "region", "a"),
      contains("b-contains-a", "b", "a"),
      contains("a-contains-region", "a", "region"),
      route({ id: "bad-endpoint", toLocationId: "other" }),
      route({ id: "missing-endpoint", toLocationId: "missing" }),
    ];
    const codes = validateSpatialRelationCatalog(relations, catalog).map((entry) => entry.code);
    expect(codes).toContain("MULTIPLE_DIRECT_SPATIAL_PARENTS");
    expect(codes).toContain("SPATIAL_CONTAINMENT_CYCLE");
    expect(codes).toContain("INVALID_SPATIAL_ENDPOINT");
    expect(codes).toContain("UNKNOWN_SPATIAL_LOCATION");
  });

  it("activates topology only after branch events and state gates, then retires it", () => {
    const relation = route({
      establishedByEventIds: ["bridge-built"],
      retiredByEventIds: ["bridge-destroyed"],
      requires: [{ op: "fact-equals", entityId: "a", field: "location.open", value: true }],
      blockedWhen: [{ op: "rule-active", ruleId: "curfew" }],
    });
    const base: WorldState = {
      atCommit: "head",
      logicalTime: { step: 2 },
      values: { a: { "location.open": true } },
      activeRuleIds: [],
    };
    expect(resolveActiveSpatialRelations([relation], { state: base, realizedCanonicalEventIds: new Set() })).toEqual([]);
    expect(resolveActiveSpatialRelations([relation], {
      state: base,
      realizedCanonicalEventIds: new Set(["bridge-built"]),
    })).toHaveLength(1);
    expect(resolveActiveSpatialRelations([relation], {
      state: { ...base, activeRuleIds: ["curfew"] },
      realizedCanonicalEventIds: new Set(["bridge-built"]),
    })).toEqual([]);
    expect(resolveActiveSpatialRelations([relation], {
      state: base,
      realizedCanonicalEventIds: new Set(["bridge-built", "bridge-destroyed"]),
    })).toEqual([]);
  });

  it("finds only explicit route paths, respects direction, and sums known minimum duration", () => {
    const ab = route({ duration: { minimum: 2, unit: "hour" } });
    const bc = route({
      id: "road-b-c",
      fromLocationId: "b",
      toLocationId: "c",
      direction: "one-way",
      duration: { minimum: 1, unit: "day" },
      evidence: [evidence(2)],
    });
    const adjacency = adjacent("a-c-adjacent", "a", "c");
    expect(findSpatialRoute([ab, bc, adjacency], "a", "c", "foot")).toMatchObject({
      relationIds: ["road-a-b", "road-b-c"],
      locationIds: ["a", "b", "c"],
      minimumDurationDays: 1 + 2 / 24,
    });
    expect(findSpatialRoute([ab, bc, adjacency], "c", "a", "foot")).toBeUndefined();
    expect(findSpatialRoute([ab, bc, adjacency], "a", "c", "water")).toBeUndefined();
    expect(findSpatialRoute([
      route({ id: "unknown-direct" }),
      route({ id: "known-direct", duration: { minimum: 3, unit: "hour" }, evidence: [evidence(3)] }),
    ], "a", "b", "foot")).toMatchObject({
      relationIds: ["known-direct"],
      minimumDurationDays: 3 / 24,
    });
  });

  it("treats containment as overlapping scope and rejects conflicting active parents", () => {
    const outer = contains("world-a", "region", "room");
    const inner = contains("region-room", "room", "alcove");
    expect(spatialLocationsMayOverlap([outer, inner], "region", "alcove")).toBe(true);
    expect(spatialLocationsMayOverlap([outer, inner], "region", "elsewhere")).toBe(false);
    expect(validateActiveSpatialTopology([
      outer,
      contains("world-b", "other-region", "room"),
    ])).toContainEqual(expect.objectContaining({ code: "MULTIPLE_ACTIVE_SPATIAL_PARENTS" }));
  });

  it("projects only actor-visible topology and strips compiler authority", () => {
    const publicRoute = route();
    const observed = route({ id: "observed", visibility: "observable", fromLocationId: "b", toLocationId: "c", evidence: [evidence(2)] });
    const known = route({
      id: "known",
      visibility: "knowledge",
      knownByClaimIds: ["map-shows-road"],
      fromLocationId: "a",
      toLocationId: "c",
      evidence: [evidence(3)],
    });
    const hidden = route({ id: "hidden", visibility: "engine", evidence: [evidence(4)] });
    const visible = modelVisibleSpatialRelations([publicRoute, observed, known, hidden], {
      visibleEntityIds: new Set(["a", "b", "c"]),
      knownClaimIds: new Set(["map-shows-road"]),
      currentLocationId: "a",
    });
    expect(visible.map((item) => item.kind)).toEqual(["route", "route"]);
    expect(JSON.stringify(visible)).not.toMatch(/evidence|confidence|knownByClaimIds|hidden|observed/);
  });

  it("requires embedded support and counter-evidence to exactly match host assertions", () => {
    const support = evidence(1);
    const counter = evidence(2, "strong-inference");
    const contested = route({
      status: "contested",
      basis: "inferred",
      evidence: [support],
      counterEvidence: [counter],
    });
    expect(validateSpatialEvidenceAssertions(contested, [
      assertion(contested, support),
      assertion(contested, counter, "contradicts"),
    ])).toEqual([]);
    expect(validateSpatialEvidenceAssertions(contested, [assertion(contested, support)]).map((entry) => entry.code))
      .toEqual(expect.arrayContaining(["MISSING_EXACT_SPATIAL_COUNTER_EVIDENCE", "SPATIAL_COUNTER_BINDING_MISMATCH"]));
  });
});
