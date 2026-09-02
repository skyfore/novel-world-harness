import type {
  CanonicalEvent,
  EventRelation,
  EventRelationType,
  ValidationIssue,
} from "./model.js";
import { compareStoryTime } from "./time.js";

export const EVENT_RELATION_PROJECTION_VERSION = 1 as const;

const CAUSAL_ORDER_TYPES = new Set<EventRelationType>(["causes", "enables", "prevents", "motivates", "explains"]);
const INTERVAL_TYPES = new Set<EventRelationType>(["coreference", "subevent", "during", "contains", "overlaps", "starts", "finishes"]);

export type EventRelationCatalog = {
  events: ReadonlyMap<string, CanonicalEvent>;
  relations: Iterable<EventRelation>;
  /** @deprecated T9 removes canonical-event parent projection from compiler convergence. */
  requireCompleteCausalProjectionForEventIds?: ReadonlySet<string>;
};

export function eventRelationIsRuntimeOperational(relation: EventRelation): boolean {
  return relation.status !== "contested"
    && !["explanatory", "non-operational"].includes(relation.operationality);
}

/** @deprecated Compiler-only bridge until T9; runtime reads operationality directly. */
export function eventRelationProjectsLegacyCausalParent(relation: EventRelation): boolean {
  return relation.status !== "contested" && relation.operationality === "necessary";
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

  // Contested relations remain reviewable evidence. They cannot reject a
  // canonical publication or enter any hard temporal/causal execution graph.
  if (relation.status !== "contested") {
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
  }
  if (relation.operationality === "motivational") {
    relation.motivatedActorIds?.forEach((actorId, index) => {
      if (!to.participants.includes(actorId)) {
        issues.push(issue("MOTIVATED_ACTOR_NOT_TARGET_PARTICIPANT", `Relation ${relation.id} motivates ${actorId}, who is not a participant in target event ${to.id}`, `motivatedActorIds.${index}`));
      }
    });
  }
  return issues;
}

/** @deprecated Typed EventRelation records are read directly; events are never rewritten into parent lists. */
export function projectEventRelations(
  event: CanonicalEvent,
  _relations: readonly EventRelation[],
): CanonicalEvent {
  return structuredClone(event);
}

export function validateEventRelationCatalog(catalog: EventRelationCatalog): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const relations = [...catalog.relations];
  const normalized = new Map<string, string>();
  const temporalBefore = new Map<string, string>();
  const temporalOverlap = new Map<string, string>();
  const causalEdges: Array<{ from: string; to: string; id: string }> = [];
  const subeventEdges: Array<{ from: string; to: string; id: string }> = [];
  const relationIds = new Set<string>();

  for (const relation of relations) {
    if (relationIds.has(relation.id)) {
      issues.push(issue("DUPLICATE_EVENT_RELATION_ID", `Duplicate event relation ID ${relation.id}`, relation.id));
    }
    relationIds.add(relation.id);
    issues.push(...validateEventRelationRecord(relation, catalog.events)
      .map((item) => ({ ...item, path: `${relation.id}.${item.path ?? "payload"}` })));
    const key = normalizedRelationKey(relation);
    const duplicate = normalized.get(key);
    if (duplicate) {
      issues.push(issue("DUPLICATE_EVENT_RELATION", `Relations ${duplicate} and ${relation.id} encode the same normalized relation`, relation.id));
    } else {
      normalized.set(key, relation.id);
    }

    const beforeEdge = relation.status === "contested" ? undefined : normalizedBeforeEdge(relation);
    if (beforeEdge) {
      const reverseKey = directedKey(beforeEdge.to, beforeEdge.from);
      const reverse = temporalBefore.get(reverseKey);
      if (reverse) {
        issues.push(issue("CONTRADICTORY_TEMPORAL_RELATION", `Relations ${reverse} and ${relation.id} establish opposite temporal orders`, relation.id));
      }
      temporalBefore.set(directedKey(beforeEdge.from, beforeEdge.to), relation.id);
    }
    if (relation.status !== "contested" && relation.type === "overlaps") temporalOverlap.set(undirectedKey(relation.fromEventId, relation.toEventId), relation.id);
    if (relation.status !== "contested" && (relation.type === "causes" || relation.type === "enables")) {
      causalEdges.push({ from: relation.fromEventId, to: relation.toEventId, id: relation.id });
    }
    if (relation.status !== "contested" && relation.type === "subevent") subeventEdges.push({ from: relation.fromEventId, to: relation.toEventId, id: relation.id });
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
