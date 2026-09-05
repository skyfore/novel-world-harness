import { z } from "zod";
import { canonicalJson } from "./canonical.js";
import {
  actionTravelModeSchema,
  evidenceRefSchema,
  idSchema,
  predicateSchema,
  storyTimeSchema,
  type Entity,
  type EvidenceAssertion,
  type EvidenceRef,
  type Predicate,
  type StoryTime,
  type ValidationIssue,
  type WorldState,
} from "./model.js";
import { policyStoryScopeActive } from "./policy-time.js";
import { evaluatePredicate } from "./state.js";

export const SPATIAL_ONTOLOGY_VERSION = "spatial-v1" as const;

export const SPATIAL_TRAVEL_MODE_IDS = actionTravelModeSchema.options;
export const spatialTravelModeSchema = actionTravelModeSchema;
export type SpatialTravelMode = z.infer<typeof spatialTravelModeSchema>;

export const spatialVisibilitySchema = z.enum(["public", "observable", "knowledge", "engine"]);
export type SpatialVisibility = z.infer<typeof spatialVisibilitySchema>;

export const spatialDurationSchema = z.object({
  minimum: z.number().finite().nonnegative(),
  typical: z.number().finite().nonnegative().optional(),
  maximum: z.number().finite().nonnegative().optional(),
  unit: z.enum(["minute", "hour", "day", "week", "month", "year"]),
}).strict().superRefine((duration, ctx) => {
  if (duration.typical !== undefined && duration.typical < duration.minimum) {
    ctx.addIssue({ code: "custom", path: ["typical"], message: "Typical travel duration cannot be shorter than the minimum" });
  }
  if (duration.maximum !== undefined && duration.maximum < (duration.typical ?? duration.minimum)) {
    ctx.addIssue({ code: "custom", path: ["maximum"], message: "Maximum travel duration cannot be shorter than minimum/typical duration" });
  }
});
export type SpatialDuration = z.infer<typeof spatialDurationSchema>;

const uniqueIds = (maximum: number) => z.array(idSchema).max(maximum).superRefine((items, ctx) => {
  if (new Set(items).size !== items.length) ctx.addIssue({ code: "custom", message: "IDs must be unique" });
});

const spatialRelationCommon = {
  ontologyVersion: z.literal(SPATIAL_ONTOLOGY_VERSION),
  id: idSchema,
  basis: z.enum(["explicit", "inferred"]),
  visibility: spatialVisibilitySchema,
  knownByClaimIds: uniqueIds(32).default([]),
  validStoryTime: storyTimeSchema.optional(),
  establishedByEventIds: uniqueIds(32).default([]),
  retiredByEventIds: uniqueIds(32).default([]),
  requires: z.array(predicateSchema).max(32).default([]),
  blockedWhen: z.array(predicateSchema).max(32).default([]),
  status: z.enum(["supported", "contested"]),
  confidence: z.number().finite().min(0).max(1),
  evidence: z.array(evidenceRefSchema).min(1),
  counterEvidence: z.array(evidenceRefSchema).optional(),
} as const;

const containsRelationSchema = z.object({
  ...spatialRelationCommon,
  kind: z.literal("contains"),
  containerLocationId: idSchema,
  containedLocationId: idSchema,
}).strict();

const adjacentRelationSchema = z.object({
  ...spatialRelationCommon,
  kind: z.literal("adjacent"),
  locationIds: z.tuple([idSchema, idSchema]),
}).strict();

const routeRelationSchema = z.object({
  ...spatialRelationCommon,
  kind: z.literal("route"),
  fromLocationId: idSchema,
  toLocationId: idSchema,
  direction: z.enum(["one-way", "two-way"]),
  modes: z.array(spatialTravelModeSchema).min(1).max(SPATIAL_TRAVEL_MODE_IDS.length),
  duration: spatialDurationSchema.optional(),
}).strict();

export const spatialRelationSchema = z.discriminatedUnion("kind", [
  containsRelationSchema,
  adjacentRelationSchema,
  routeRelationSchema,
]).superRefine((relation, ctx) => {
  const [left, right] = spatialEndpoints(relation);
  if (left === right) {
    ctx.addIssue({ code: "custom", message: "A spatial relation must connect two distinct locations" });
  }
  if (relation.kind === "adjacent" && relation.locationIds[0].localeCompare(relation.locationIds[1]) >= 0) {
    ctx.addIssue({
      code: "custom",
      path: ["locationIds"],
      message: "Adjacency endpoints must be stored in ascending logical-ID order so the symmetric relation has one identity",
    });
  }
  if (relation.kind === "route" && new Set(relation.modes).size !== relation.modes.length) {
    ctx.addIssue({ code: "custom", path: ["modes"], message: "Route travel modes must be unique" });
  }
  if (relation.visibility === "knowledge" && relation.knownByClaimIds.length === 0) {
    ctx.addIssue({ code: "custom", path: ["knownByClaimIds"], message: "Knowledge-visible spatial relations require at least one grounding claim" });
  }
  if (relation.visibility !== "knowledge" && relation.knownByClaimIds.length > 0) {
    ctx.addIssue({ code: "custom", path: ["knownByClaimIds"], message: "knownByClaimIds is reserved for knowledge-visible spatial relations" });
  }
  if (relation.status === "contested" && !relation.counterEvidence?.length) {
    ctx.addIssue({ code: "custom", path: ["counterEvidence"], message: "A contested spatial relation requires counter-evidence" });
  }
  if (relation.status === "supported" && relation.counterEvidence?.length) {
    ctx.addIssue({ code: "custom", path: ["counterEvidence"], message: "Counter-evidence requires contested status" });
  }
  if (relation.basis === "explicit" && !relation.evidence.some((reference) => reference.strength === "explicit")) {
    ctx.addIssue({ code: "custom", path: ["basis"], message: "An explicit spatial relation requires explicit evidence" });
  }
});
export type SpatialRelation = z.infer<typeof spatialRelationSchema>;
export type SpatialContainsRelation = Extract<SpatialRelation, { kind: "contains" }>;
export type SpatialAdjacentRelation = Extract<SpatialRelation, { kind: "adjacent" }>;
export type SpatialRouteRelation = Extract<SpatialRelation, { kind: "route" }>;

export type SpatialReferenceCatalog = {
  entities: ReadonlyMap<string, Pick<Entity, "kind">>;
  events: ReadonlyMap<string, unknown>;
  claims: ReadonlySet<string>;
  rules: ReadonlySet<string>;
};

/**
 * Validate one source-compiled spatial catalog as a graph. Containment uses
 * immediate-parent edges: supported active-independent edges must be acyclic
 * and one contained place cannot have two direct containers.
 */
export function validateSpatialRelationCatalog(
  relations: Iterable<SpatialRelation>,
  catalog: SpatialReferenceCatalog,
): ValidationIssue[] {
  const values = [...relations];
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  const adjacencyKeys = new Set<string>();
  const directParent = new Map<string, string>();
  const containsGraph = new Map<string, Set<string>>();
  for (const [index, relation] of values.entries()) {
    const prefix = `spatialRelations.${index}`;
    if (ids.has(relation.id)) issues.push(issue("DUPLICATE_SPATIAL_RELATION", `Duplicate spatial relation ${relation.id}`, `${prefix}.id`));
    ids.add(relation.id);
    for (const [endpointIndex, endpoint] of spatialEndpoints(relation).entries()) {
      const entity = catalog.entities.get(endpoint);
      if (!entity) issues.push(issue("UNKNOWN_SPATIAL_LOCATION", `Spatial relation ${relation.id} references unknown location ${endpoint}`, `${prefix}.endpoints.${endpointIndex}`));
      else if (entity.kind !== "location") issues.push(issue("INVALID_SPATIAL_ENDPOINT", `Spatial relation ${relation.id} endpoint ${endpoint} is ${entity.kind}, not location`, `${prefix}.endpoints.${endpointIndex}`));
    }
    relation.establishedByEventIds.forEach((eventId, eventIndex) => {
      if (!catalog.events.has(eventId)) issues.push(issue("UNKNOWN_SPATIAL_EVENT", `Spatial relation ${relation.id} references unknown establishment event ${eventId}`, `${prefix}.establishedByEventIds.${eventIndex}`));
    });
    relation.retiredByEventIds.forEach((eventId, eventIndex) => {
      if (!catalog.events.has(eventId)) issues.push(issue("UNKNOWN_SPATIAL_EVENT", `Spatial relation ${relation.id} references unknown retirement event ${eventId}`, `${prefix}.retiredByEventIds.${eventIndex}`));
    });
    relation.knownByClaimIds.forEach((claimId, claimIndex) => {
      if (!catalog.claims.has(claimId)) issues.push(issue("UNKNOWN_SPATIAL_KNOWLEDGE", `Spatial relation ${relation.id} references unknown knowledge claim ${claimId}`, `${prefix}.knownByClaimIds.${claimIndex}`));
    });
    validateStoryAnchor(relation.validStoryTime, catalog.events, `${prefix}.validStoryTime`, issues);
    [...relation.requires, ...relation.blockedWhen].forEach((predicate, predicateIndex) =>
      validateSpatialPredicate(predicate, catalog, `${prefix}.predicates.${predicateIndex}`, issues));
    if (relation.kind === "adjacent") {
      const key = relation.locationIds.join("\u0000");
      if (adjacencyKeys.has(key)) issues.push(issue("DUPLICATE_SPATIAL_ADJACENCY", `Adjacency ${relation.locationIds.join(" <-> ")} is asserted more than once`, prefix));
      adjacencyKeys.add(key);
    }
    if (relation.kind === "contains" && relation.status === "supported"
      && relation.establishedByEventIds.length === 0 && relation.retiredByEventIds.length === 0
      && relation.validStoryTime === undefined
      && relation.requires.length === 0 && relation.blockedWhen.length === 0) {
      const existing = directParent.get(relation.containedLocationId);
      if (existing && existing !== relation.containerLocationId) {
        issues.push(issue("MULTIPLE_DIRECT_SPATIAL_PARENTS", `Location ${relation.containedLocationId} has direct containers ${existing} and ${relation.containerLocationId}`, `${prefix}.containedLocationId`));
      }
      directParent.set(relation.containedLocationId, relation.containerLocationId);
      const children = containsGraph.get(relation.containerLocationId) ?? new Set<string>();
      children.add(relation.containedLocationId);
      containsGraph.set(relation.containerLocationId, children);
    }
  }
  for (const cycle of directedCycles(containsGraph)) {
    issues.push(issue("SPATIAL_CONTAINMENT_CYCLE", `Spatial containment cycle: ${cycle.join(" -> ")}`, "spatialRelations"));
  }
  return issues;
}

/** Every spatial edge must be bound to exact, host-resolved source text. */
export function validateSpatialEvidenceAssertions(
  relation: SpatialRelation,
  assertions: readonly EvidenceAssertion[],
): ValidationIssue[] {
  const selected = assertions.filter((assertion) => assertion.target.artifactKind === "spatial-relation"
    && assertion.target.artifactId === relation.id);
  const supports = selected.filter((assertion) => assertion.relation === "supports");
  const contradicts = selected.filter((assertion) => assertion.relation === "contradicts");
  const issues: ValidationIssue[] = [];
  if (!supports.length) issues.push(issue("MISSING_EXACT_SPATIAL_SUPPORT", `Spatial relation ${relation.id} requires exact supporting evidence`, "evidence"));
  if (relation.status === "contested" && !contradicts.length) {
    issues.push(issue("MISSING_EXACT_SPATIAL_COUNTER_EVIDENCE", `Contested spatial relation ${relation.id} requires exact contradicting evidence`, "counterEvidence"));
  }
  if (relation.status === "supported" && contradicts.length) {
    issues.push(issue("UNDECLARED_SPATIAL_CONTEST", `Spatial relation ${relation.id} has contradicting evidence but is marked supported`, "status"));
  }
  if (!sameSet(assertionEvidenceKeys(supports), new Set(relation.evidence.map(evidenceKey)))) {
    issues.push(issue("SPATIAL_SUPPORT_BINDING_MISMATCH", `Spatial relation ${relation.id} evidence does not exactly match its supporting assertions`, "evidence"));
  }
  if (!sameSet(assertionEvidenceKeys(contradicts), new Set((relation.counterEvidence ?? []).map(evidenceKey)))) {
    issues.push(issue("SPATIAL_COUNTER_BINDING_MISMATCH", `Spatial relation ${relation.id} counter-evidence does not exactly match its contradicting assertions`, "counterEvidence"));
  }
  if (relation.basis === "explicit" && !supports.some((assertion) => assertion.strength === "explicit")) {
    issues.push(issue("MISSING_EXACT_EXPLICIT_SPATIAL_SUPPORT", `Explicit spatial relation ${relation.id} requires an exact explicit assertion`, "basis"));
  }
  return issues;
}

export type ActiveSpatialRelation = SpatialRelation;

export function resolveActiveSpatialRelations(
  relations: readonly SpatialRelation[],
  input: {
    state: WorldState;
    realizedCanonicalEventIds: ReadonlySet<string>;
  },
): ActiveSpatialRelation[] {
  const active = relations
    .filter((relation) => relation.status === "supported")
    .filter((relation) => relation.establishedByEventIds.length === 0
      || relation.establishedByEventIds.some((eventId) => input.realizedCanonicalEventIds.has(eventId)))
    .filter((relation) => !relation.retiredByEventIds.some((eventId) => input.realizedCanonicalEventIds.has(eventId)))
    .filter((relation) => policyStoryScopeActive(
      input.state.logicalTime.storyTime,
      relation.validStoryTime,
      input.realizedCanonicalEventIds,
    ))
    .filter((relation) => relation.requires.every((predicate) => evaluatePredicate(input.state, predicate)))
    .filter((relation) => !relation.blockedWhen.some((predicate) => evaluatePredicate(input.state, predicate)))
    .sort((left, right) => left.id.localeCompare(right.id));
  const topologyIssues = validateActiveSpatialTopology(active);
  if (topologyIssues.length) {
    throw new Error(`Invalid active spatial topology: ${topologyIssues.map((item) => `${item.code}: ${item.message}`).join("; ")}`);
  }
  return active;
}

/** Validate the containment graph after temporal/state gates have resolved. */
export function validateActiveSpatialTopology(relations: readonly ActiveSpatialRelation[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const directParent = new Map<string, string>();
  const graph = new Map<string, Set<string>>();
  for (const relation of relations) {
    if (relation.kind !== "contains") continue;
    const existing = directParent.get(relation.containedLocationId);
    if (existing && existing !== relation.containerLocationId) {
      issues.push(issue(
        "MULTIPLE_ACTIVE_SPATIAL_PARENTS",
        `Location ${relation.containedLocationId} has active direct containers ${existing} and ${relation.containerLocationId}`,
        relation.id,
      ));
    }
    directParent.set(relation.containedLocationId, relation.containerLocationId);
    const children = graph.get(relation.containerLocationId) ?? new Set<string>();
    children.add(relation.containedLocationId);
    graph.set(relation.containerLocationId, children);
  }
  for (const cycle of directedCycles(graph)) {
    issues.push(issue("ACTIVE_SPATIAL_CONTAINMENT_CYCLE", `Active spatial containment cycle: ${cycle.join(" -> ")}`, "spatialRelations"));
  }
  return issues;
}

/** Equal locations and ancestor/descendant locations may describe one physical scope. */
export function spatialLocationsMayOverlap(
  relations: readonly ActiveSpatialRelation[],
  leftLocationId: string,
  rightLocationId: string,
): boolean {
  if (leftLocationId === rightLocationId) return true;
  const graph = new Map<string, string[]>();
  for (const relation of relations) {
    if (relation.kind !== "contains") continue;
    graph.set(relation.containerLocationId, [
      ...(graph.get(relation.containerLocationId) ?? []),
      relation.containedLocationId,
    ]);
  }
  return spatialReachable(graph, leftLocationId, rightLocationId)
    || spatialReachable(graph, rightLocationId, leftLocationId);
}

export type SpatialRoutePath = {
  fromLocationId: string;
  toLocationId: string;
  relationIds: string[];
  locationIds: string[];
  minimumDurationDays?: number;
};

/** Deterministic shortest-hop route; duration breaks ties before logical IDs. */
export function findSpatialRoute(
  relations: readonly ActiveSpatialRelation[],
  fromLocationId: string,
  toLocationId: string,
  mode?: SpatialTravelMode,
): SpatialRoutePath | undefined {
  if (fromLocationId === toLocationId) {
    return { fromLocationId, toLocationId, relationIds: [], locationIds: [fromLocationId], minimumDurationDays: 0 };
  }
  const graph = new Map<string, Array<{ to: string; relation: SpatialRouteRelation; days?: number }>>();
  const add = (from: string, to: string, relation: SpatialRouteRelation) => {
    const edge = { to, relation, ...(relation.duration ? { days: durationDays(relation.duration.minimum, relation.duration.unit) } : {}) };
    graph.set(from, [...(graph.get(from) ?? []), edge]);
  };
  for (const relation of relations) {
    if (relation.kind !== "route") continue;
    if (mode && !relation.modes.includes(mode)) continue;
    add(relation.fromLocationId, relation.toLocationId, relation);
    if (relation.direction === "two-way") add(relation.toLocationId, relation.fromLocationId, relation);
  }
  for (const edges of graph.values()) edges.sort((left, right) => left.to.localeCompare(right.to) || left.relation.id.localeCompare(right.relation.id));
  type Candidate = { at: string; relationIds: string[]; locationIds: string[]; hops: number; knownDays: number; allDurationsKnown: boolean };
  const queue: Candidate[] = [{ at: fromLocationId, relationIds: [], locationIds: [fromLocationId], hops: 0, knownDays: 0, allDurationsKnown: true }];
  const best = new Map<string, { hops: number; knownDays: number; allDurationsKnown: boolean; key: string }>();
  while (queue.length) {
    queue.sort(compareRouteCandidates);
    const current = queue.shift()!;
    const key = current.relationIds.join("\u0000");
    const previous = best.get(current.at);
    if (previous && compareRouteRank(current, previous) >= 0) continue;
    best.set(current.at, {
      hops: current.hops,
      knownDays: current.knownDays,
      allDurationsKnown: current.allDurationsKnown,
      key,
    });
    if (current.at === toLocationId) {
      return {
        fromLocationId,
        toLocationId,
        relationIds: current.relationIds,
        locationIds: current.locationIds,
        ...(current.allDurationsKnown ? { minimumDurationDays: current.knownDays } : {}),
      };
    }
    for (const edge of graph.get(current.at) ?? []) {
      if (current.locationIds.includes(edge.to)) continue;
      queue.push({
        at: edge.to,
        relationIds: [...current.relationIds, edge.relation.id],
        locationIds: [...current.locationIds, edge.to],
        hops: current.hops + 1,
        knownDays: current.knownDays + (edge.days ?? 0),
        allDurationsKnown: current.allDurationsKnown && edge.days !== undefined,
      });
    }
  }
  return undefined;
}

function spatialReachable(graph: ReadonlyMap<string, readonly string[]>, from: string, to: string): boolean {
  const pending = [from];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.shift()!;
    if (current === to) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(graph.get(current) ?? []).filter((item) => !visited.has(item)).sort());
  }
  return false;
}

export const modelVisibleSpatialRelationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("contains"), containerLocationId: idSchema, containedLocationId: idSchema }).strict(),
  z.object({ kind: z.literal("adjacent"), locationIds: z.tuple([idSchema, idSchema]) }).strict(),
  z.object({
    kind: z.literal("route"),
    fromLocationId: idSchema,
    toLocationId: idSchema,
    direction: z.enum(["one-way", "two-way"]),
    modes: z.array(spatialTravelModeSchema),
    duration: spatialDurationSchema.optional(),
  }).strict(),
]);
export type ModelVisibleSpatialRelation = z.infer<typeof modelVisibleSpatialRelationSchema>;

/** Actor/model projection strips evidence, compiler confidence, gates, and IDs. */
export function modelVisibleSpatialRelations(
  relations: readonly ActiveSpatialRelation[],
  input: {
    visibleEntityIds: ReadonlySet<string>;
    knownClaimIds: ReadonlySet<string>;
    currentLocationId?: string;
  },
): ModelVisibleSpatialRelation[] {
  return relations.flatMap((relation): ModelVisibleSpatialRelation[] => {
    const endpoints = spatialEndpoints(relation);
    if (!endpoints.every((endpoint) => input.visibleEntityIds.has(endpoint))) return [];
    if (relation.visibility === "engine") return [];
    if (relation.visibility === "observable" && !endpoints.includes(input.currentLocationId ?? "")) return [];
    if (relation.visibility === "knowledge"
      && !relation.knownByClaimIds.some((claimId) => input.knownClaimIds.has(claimId))) return [];
    if (relation.kind === "contains") return [{
      kind: relation.kind,
      containerLocationId: relation.containerLocationId,
      containedLocationId: relation.containedLocationId,
    }];
    if (relation.kind === "adjacent") return [{ kind: relation.kind, locationIds: [...relation.locationIds] }];
    return [{
      kind: relation.kind,
      fromLocationId: relation.fromLocationId,
      toLocationId: relation.toLocationId,
      direction: relation.direction,
      modes: [...relation.modes],
      ...(relation.duration ? { duration: structuredClone(relation.duration) } : {}),
    }];
  });
}

export function spatialRelationEvidence(relation: SpatialRelation): EvidenceRef[] {
  return [...relation.evidence, ...(relation.counterEvidence ?? [])];
}

export function spatialEndpoints(relation: SpatialRelation): [string, string] {
  if (relation.kind === "contains") return [relation.containerLocationId, relation.containedLocationId];
  if (relation.kind === "adjacent") return relation.locationIds;
  return [relation.fromLocationId, relation.toLocationId];
}

function validateStoryAnchor(
  time: StoryTime | undefined,
  events: ReadonlyMap<string, unknown>,
  path: string,
  issues: ValidationIssue[],
): void {
  if (time?.kind === "relative" && !events.has(time.anchorEventId)) {
    issues.push(issue("UNKNOWN_SPATIAL_TIME_ANCHOR", `Spatial story time references unknown event ${time.anchorEventId}`, `${path}.anchorEventId`));
  }
}

function validateSpatialPredicate(
  predicate: Predicate,
  catalog: SpatialReferenceCatalog,
  path: string,
  issues: ValidationIssue[],
): void {
  if (predicate.op === "all" || predicate.op === "any") {
    predicate.items.forEach((item, index) => validateSpatialPredicate(item, catalog, `${path}.items.${index}`, issues));
    return;
  }
  if (predicate.op === "not") {
    validateSpatialPredicate(predicate.item, catalog, `${path}.item`, issues);
    return;
  }
  if (predicate.op === "rule-active") {
    if (!catalog.rules.has(predicate.ruleId)) issues.push(issue("UNKNOWN_SPATIAL_RULE", `Spatial gate references unknown rule ${predicate.ruleId}`, `${path}.ruleId`));
    return;
  }
  if ("entityId" in predicate && !catalog.entities.has(predicate.entityId)) {
    issues.push(issue("UNKNOWN_SPATIAL_PREDICATE_ENTITY", `Spatial gate references unknown entity ${predicate.entityId}`, `${path}.entityId`));
  }
  if (predicate.op === "entity-in" && !catalog.entities.has(predicate.member)) {
    issues.push(issue("UNKNOWN_SPATIAL_PREDICATE_MEMBER", `Spatial gate references unknown member ${predicate.member}`, `${path}.member`));
  }
  if ((predicate.op === "story-time-at-or-after" || predicate.op === "story-time-before")) {
    validateStoryAnchor(predicate.time, catalog.events, `${path}.time`, issues);
  }
}

function directedCycles(graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const seenCycles = new Set<string>();
  const visit = (node: string) => {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      const cycle = [...stack.slice(start), node];
      const key = [...new Set(cycle.slice(0, -1))].sort().join("\u0000");
      if (!seenCycles.has(key)) {
        cycles.push(cycle);
        seenCycles.add(key);
      }
      return;
    }
    visiting.add(node);
    stack.push(node);
    for (const child of [...(graph.get(node) ?? [])].sort()) visit(child);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of [...new Set([...graph.keys(), ...[...graph.values()].flatMap((items) => [...items])])].sort()) visit(node);
  return cycles;
}

function evidenceKey(reference: EvidenceRef): string {
  return canonicalJson(reference);
}

function assertionEvidenceKeys(assertions: readonly EvidenceAssertion[]): Set<string> {
  return new Set(assertions.flatMap((assertion) => assertion.anchors.map((anchor) => evidenceKey({
    span: {
      sourceId: anchor.sourceId,
      startByte: anchor.startByte,
      endByte: anchor.endByte,
      startLine: anchor.startLine,
      endLine: anchor.endLine,
      quoteHash: anchor.exactHash,
    },
    strength: assertion.strength,
  }))));
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function durationDays(amount: number, unit: SpatialDuration["unit"]): number {
  if (unit === "minute") return amount / (24 * 60);
  if (unit === "hour") return amount / 24;
  if (unit === "day") return amount;
  if (unit === "week") return amount * 7;
  if (unit === "month") return amount * 30.436875;
  return amount * 365.2425;
}

function compareRouteCandidates(
  left: { hops: number; knownDays: number; allDurationsKnown: boolean; relationIds: string[] },
  right: { hops: number; knownDays: number; allDurationsKnown: boolean; relationIds: string[] },
): number {
  return left.hops - right.hops
    || Number(right.allDurationsKnown) - Number(left.allDurationsKnown)
    || left.knownDays - right.knownDays
    || left.relationIds.join("\u0000").localeCompare(right.relationIds.join("\u0000"));
}

function compareRouteRank(
  candidate: { hops: number; knownDays: number; allDurationsKnown: boolean; relationIds: string[] },
  rank: { hops: number; knownDays: number; allDurationsKnown: boolean; key: string },
): number {
  return candidate.hops - rank.hops
    || Number(rank.allDurationsKnown) - Number(candidate.allDurationsKnown)
    || candidate.knownDays - rank.knownDays
    || candidate.relationIds.join("\u0000").localeCompare(rank.key);
}

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, ...(path ? { path } : {}) };
}
