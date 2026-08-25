import { canonicalJson } from "./canonical.js";
import type {
  CanonicalEvent,
  EventRelation,
  EventRelationType,
  ValidationIssue,
} from "./model.js";
import { compareStoryTime } from "./time.js";

export const EVENT_RELATION_PROJECTION_VERSION = 1 as const;

const LEGACY_CAUSAL_TYPES = new Set<EventRelationType>(["causes", "enables"]);
const CAUSAL_ORDER_TYPES = new Set<EventRelationType>(["causes", "enables", "prevents", "motivates", "explains"]);
const INTERVAL_TYPES = new Set<EventRelationType>(["coreference", "subevent", "during", "contains", "overlaps", "starts", "finishes"]);

export type EventRelationCatalog = {
  events: ReadonlyMap<string, CanonicalEvent>;
  relations: Iterable<EventRelation>;
  requireCompleteCausalProjectionForEventIds?: ReadonlySet<string>;
};

export function eventRelationProjectsLegacyCausalParent(relation: EventRelation): boolean {
  return LEGACY_CAUSAL_TYPES.has(relation.type) && relation.status !== "contested";
}

export function validateEventRelationRecord(
  relation: EventRelation,
  events: ReadonlyMap<string, CanonicalEvent>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const from = events.get(relation.fromEventId);
  const to = events.get(relation.toEventId);
  if (!from) issues.push(issue("UNKNOWN_RELATION_SOURCE_EVENT", `Relation ${relation.id} references unknown source event ${relation.fromEventId}`, "fromEventId"));
  if (!to) issues.push(issue("UNKNOWN_RELATION_TARGET_EVENT", `Relation ${relation.id} references unknown target event ${relation.toEventId}`, "toEventId"));
  if (relation.fromEventId === relation.toEventId) {
    issues.push(issue("SELF_EVENT_RELATION", `Relation ${relation.id} connects event ${relation.fromEventId} to itself`, "toEventId"));
  }
  if (!from || !to) return issues;

  const temporalOrder = compareStoryTime(from.storyTime, to.storyTime);
  if (relation.type === "before" && temporalOrder === 1) {
    issues.push(issue("TEMPORAL_RELATION_CONTRADICTION", `Relation ${relation.id} says ${from.id} is before ${to.id}, but their story-time anchors establish the reverse`, "type"));
  } else if (relation.type === "after" && temporalOrder === -1) {
    issues.push(issue("TEMPORAL_RELATION_CONTRADICTION", `Relation ${relation.id} says ${from.id} is after ${to.id}, but their story-time anchors establish the reverse`, "type"));
  } else if (INTERVAL_TYPES.has(relation.type) && temporalOrder !== undefined && temporalOrder !== 0) {
    issues.push(issue("TEMPORAL_RELATION_CONTRADICTION", `Relation ${relation.id} requires temporally compatible intervals, but ${from.id} and ${to.id} are definitely disjoint`, "type"));
  } else if (CAUSAL_ORDER_TYPES.has(relation.type) && temporalOrder === 1) {
    issues.push(issue("TEMPORAL_CAUSAL_REGRESSION", `Relation ${relation.id} has later event ${from.id} ${relation.type} earlier event ${to.id}`, "type"));
  }
  if (eventRelationProjectsLegacyCausalParent(relation) && !to.causalParents.includes(from.id)) {
    issues.push(issue("RELATION_LEGACY_CAUSAL_MISMATCH", `Relation ${relation.id} projects ${from.id} as a causal parent of ${to.id}, but the legacy event does not contain that parent`, "type"));
  }
  return issues;
}

export function projectEventRelations(
  event: CanonicalEvent,
  relations: readonly EventRelation[],
): CanonicalEvent {
  const projectedIds = new Set(relations
    .filter((item) => item.toEventId === event.id && eventRelationProjectsLegacyCausalParent(item))
    .map((item) => item.fromEventId));
  if (!projectedIds.size) return structuredClone(event);
  const causalParents = [
    ...event.causalParents.filter((eventId) => projectedIds.delete(eventId)),
    ...[...projectedIds].sort(),
  ];
  return { ...structuredClone(event), causalParents };
}

export function validateEventRelationCatalog(catalog: EventRelationCatalog): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const relations = [...catalog.relations];
  const normalized = new Map<string, string>();
  const temporalBefore = new Map<string, string>();
  const temporalOverlap = new Map<string, string>();
  const causalEdges: Array<{ from: string; to: string; id: string }> = [];
  const projectedCausalEdges: Array<{ from: string; to: string; id: string }> = [];
  const subeventEdges: Array<{ from: string; to: string; id: string }> = [];

  for (const relation of relations) {
    issues.push(...validateEventRelationRecord(relation, catalog.events)
      .map((item) => ({ ...item, path: `${relation.id}.${item.path ?? "payload"}` })));
    const key = normalizedRelationKey(relation);
    const duplicate = normalized.get(key);
    if (duplicate) {
      issues.push(issue("DUPLICATE_EVENT_RELATION", `Relations ${duplicate} and ${relation.id} encode the same normalized relation`, relation.id));
    } else {
      normalized.set(key, relation.id);
    }

    const beforeEdge = normalizedBeforeEdge(relation);
    if (beforeEdge) {
      const reverseKey = directedKey(beforeEdge.to, beforeEdge.from);
      const reverse = temporalBefore.get(reverseKey);
      if (reverse) {
        issues.push(issue("CONTRADICTORY_TEMPORAL_RELATION", `Relations ${reverse} and ${relation.id} establish opposite temporal orders`, relation.id));
      }
      temporalBefore.set(directedKey(beforeEdge.from, beforeEdge.to), relation.id);
    }
    if (relation.type === "overlaps") temporalOverlap.set(undirectedKey(relation.fromEventId, relation.toEventId), relation.id);
    if (relation.type === "causes" || relation.type === "enables") {
      causalEdges.push({ from: relation.fromEventId, to: relation.toEventId, id: relation.id });
      if (eventRelationProjectsLegacyCausalParent(relation)) {
        projectedCausalEdges.push({ from: relation.fromEventId, to: relation.toEventId, id: relation.id });
      }
    }
    if (relation.type === "subevent") subeventEdges.push({ from: relation.fromEventId, to: relation.toEventId, id: relation.id });
  }

  for (const [key, relationId] of temporalOverlap) {
    const [left, right] = key.split("\u0000");
    const ordered = temporalBefore.get(directedKey(left!, right!)) ?? temporalBefore.get(directedKey(right!, left!));
    if (ordered) issues.push(issue("CONTRADICTORY_TEMPORAL_RELATION", `Relations ${ordered} and ${relationId} assert both strict order and overlap`, relationId));
  }
  for (const edge of causalEdges) {
    const reverseTemporal = temporalBefore.get(directedKey(edge.to, edge.from));
    if (reverseTemporal) {
      issues.push(issue("CAUSAL_TEMPORAL_CONTRADICTION", `Causal relation ${edge.id} conflicts with temporal relation ${reverseTemporal}`, edge.id));
    }
  }
  issues.push(...directedCycleIssues(causalEdges, "CAUSAL_RELATION_CYCLE", "Causal event relations"));
  issues.push(...directedCycleIssues(subeventEdges, "SUBEVENT_RELATION_CYCLE", "Subevent relations"));
  issues.push(...directedCycleIssues(
    [...temporalBefore].map(([key, id]) => {
      const [from, to] = key.split("\u0000");
      return { from: from!, to: to!, id };
    }),
    "TEMPORAL_RELATION_CYCLE",
    "Strict temporal relations",
  ));

  const projectedByTarget = new Map<string, Set<string>>();
  for (const edge of projectedCausalEdges) {
    const values = projectedByTarget.get(edge.to) ?? new Set<string>();
    values.add(edge.from);
    projectedByTarget.set(edge.to, values);
  }
  const requiredTargets = new Set([
    ...projectedByTarget.keys(),
    ...(catalog.requireCompleteCausalProjectionForEventIds ?? []),
  ]);
  for (const eventId of requiredTargets) {
    const event = catalog.events.get(eventId);
    if (!event) continue;
    const typedIds = [...(projectedByTarget.get(eventId) ?? new Set<string>())].sort();
    const legacyIds = [...new Set(event.causalParents)].sort();
    if (canonicalJson(typedIds) !== canonicalJson(legacyIds)) {
      issues.push(issue("INCOMPLETE_CAUSAL_RELATION_PROJECTION", `Event ${eventId} typed causes/enables parents (${typedIds.join(", ") || "none"}) do not project exactly to legacy causalParents (${legacyIds.join(", ") || "none"})`, eventId));
    }
  }
  return issues;
}

export function eventRelationsByTarget(
  relations: readonly EventRelation[],
): ReadonlyMap<string, readonly EventRelation[]> {
  const byTarget = new Map<string, EventRelation[]>();
  for (const item of relations) byTarget.set(item.toEventId, [...(byTarget.get(item.toEventId) ?? []), item]);
  for (const values of byTarget.values()) values.sort((left, right) => left.id.localeCompare(right.id));
  return byTarget;
}

function normalizedRelationKey(relation: EventRelation): string {
  if (relation.type === "after") return `before:${relation.toEventId}:${relation.fromEventId}`;
  if (relation.type === "contains") return `during:${relation.toEventId}:${relation.fromEventId}`;
  if (relation.type === "coreference" || relation.type === "overlaps") {
    return `${relation.type}:${undirectedKey(relation.fromEventId, relation.toEventId)}`;
  }
  return `${relation.type}:${relation.fromEventId}:${relation.toEventId}`;
}

function normalizedBeforeEdge(relation: EventRelation): { from: string; to: string } | undefined {
  if (relation.type === "before") return { from: relation.fromEventId, to: relation.toEventId };
  if (relation.type === "after") return { from: relation.toEventId, to: relation.fromEventId };
  return undefined;
}

function directedCycleIssues(
  edges: readonly { from: string; to: string; id: string }[],
  code: string,
  label: string,
): ValidationIssue[] {
  const outgoing = new Map<string, Array<{ to: string; id: string }>>();
  for (const edge of edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), { to: edge.to, id: edge.id }]);
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const issues: ValidationIssue[] = [];
  const seenCycles = new Set<string>();
  const visit = (eventId: string) => {
    if (state.get(eventId) === "visited") return;
    if (state.get(eventId) === "visiting") {
      const start = Math.max(0, stack.indexOf(eventId));
      const cycle = [...stack.slice(start), eventId];
      const key = [...new Set(cycle)].sort().join("\u0000");
      if (!seenCycles.has(key)) {
        seenCycles.add(key);
        issues.push(issue(code, `${label} contain a cycle: ${cycle.join(" -> ")}`, cycle[0]!));
      }
      return;
    }
    state.set(eventId, "visiting");
    stack.push(eventId);
    for (const edge of (outgoing.get(eventId) ?? []).sort((left, right) => left.to.localeCompare(right.to) || left.id.localeCompare(right.id))) visit(edge.to);
    stack.pop();
    state.set(eventId, "visited");
  };
  [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))].sort().forEach(visit);
  return issues;
}

function directedKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

function undirectedKey(left: string, right: string): string {
  return [left, right].sort().join("\u0000");
}

function issue(code: string, message: string, path: string): ValidationIssue {
  return { code, message, path };
}
