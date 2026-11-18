import { z } from "zod";
import { contentHash } from "./canonical.js";
import { idSchema, validationIssueSchema, type CanonicalEvent, type EventRelation, type ValidationIssue } from "./model.js";
import { comparableStoryTime } from "./time.js";

/**
 * Host-derived chronology of canonical events.
 *
 * The timeline is a deterministic linear extension of the explicit temporal
 * and causal constraints, defaulting to discourse (source byte) order where
 * the evidence proves nothing. Model-authored scalar order hints never take
 * part: they are not coherent across compiler batches.
 */
export const CANON_TIMELINE_VERSION = 1 as const;

/** A coordinate that never occurs in a real source; used only for events without any byte anchor. */
export const TIMELINE_UNANCHORED_BYTE = Number.MAX_SAFE_INTEGER;

/** Hard errors block every cut at or after the earliest affected event. */
export const TIMELINE_BLOCKING_CODES: ReadonlySet<string> = new Set(["TIMELINE_CONSTRAINT_CYCLE"]);
/** Advisory diagnostics point compiler repair at missing evidence; they never block a cut. */
export const TIMELINE_ADVISORY_CODES: ReadonlySet<string> = new Set([
  "TIMELINE_ANCHOR_MISSING",
  "TIMELINE_FLASHBACK_UNANCHORED",
  "TIMELINE_FLASHFORWARD_UNANCHORED",
]);

const byteRangeSchema = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);

export const canonTimelineEntrySchema = z.object({
  eventId: idSchema,
  index: z.number().int().nonnegative(),
  discourseByte: z.number().int().nonnegative(),
  basis: z.enum(["discourse", "constraint"]),
  constraintIds: z.array(z.string().min(1)),
  /** Present on coreferent occurrences other than the group's first member. */
  aliasOf: idSchema.optional(),
  /** Exact source extents of the event mentions resolved to this event. */
  extents: z.array(byteRangeSchema),
}).strict();
export type CanonTimelineEntry = z.infer<typeof canonTimelineEntrySchema>;

export const canonTimelineSchema = z.object({
  version: z.literal(CANON_TIMELINE_VERSION),
  sourceId: idSchema,
  subjectHash: z.string().regex(/^[a-f0-9]{64}$/),
  entries: z.array(canonTimelineEntrySchema),
  /** Adjacent writers of one state address whose order is a discourse default, not a proven constraint. */
  assumedPairs: z.array(z.object({ earlier: idSchema, later: idSchema, addresses: z.array(z.string().min(1)).min(1) }).strict()),
  issues: z.array(validationIssueSchema),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type CanonTimeline = z.infer<typeof canonTimelineSchema>;

/** Structural subset of compiler event resolutions; the world layer does not depend on compiler stores. */
export type TimelineEventResolution = {
  id: string;
  status: string;
  canonicalEventId?: string;
  eventMentionIds: readonly string[];
  supersedesResolutionIds?: readonly string[];
};
type Anchor = { startByte: number; endByte: number; startLine?: number };
/** Structural subset of compiler source annotations. */
export type TimelineAnnotation =
  | { annotationType: "event-mention"; id: string; triggerAnchor: Anchor; extentAnchors: readonly Anchor[] }
  | { annotationType: "entity-mention" | "quotation" | "discourse-segment"; id: string };
/** Structural subset of the source structure manifest, used only to map evidence lines to bytes. */
export type TimelineStructure = { units: ReadonlyArray<{ anchor: { startByte: number; startLine: number } }> };

export type BuildCanonTimelineInput = {
  sourceId: string;
  events: readonly CanonicalEvent[];
  relations: readonly EventRelation[];
  eventResolutions?: readonly TimelineEventResolution[];
  annotations?: readonly TimelineAnnotation[];
  structure?: TimelineStructure;
};

type Edge = { from: string; to: string; id: string };

/** Build the deterministic canonical timeline. Pure: no clocks, models or I/O. */
export function buildCanonTimeline(input: BuildCanonTimelineInput): CanonTimeline {
  const issues: ValidationIssue[] = [];
  const actual = [...input.events]
    .filter((event) => event.narrativeContext?.mode !== "hypothetical")
    .sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(actual.map((event) => [event.id, event]));

  // 1. Discourse coordinates from resolved event-mention anchors.
  const extents = mentionExtentsByEvent(input.eventResolutions ?? [], input.annotations ?? [], byId);
  const lineToByte = lineToByteIndex(input.structure);
  const discourse = new Map<string, number>();
  for (const event of actual) {
    const anchored = extents.get(event.id);
    if (anchored?.length) {
      discourse.set(event.id, Math.min(...anchored.map(([start]) => start)));
      continue;
    }
    const fallback = evidenceStartByte(event, lineToByte);
    issues.push({
      code: "TIMELINE_ANCHOR_MISSING",
      message: fallback === undefined
        ? `Event ${event.id} has no resolved event-mention anchor or byte-addressable evidence; it is placed after all anchored events.`
        : `Event ${event.id} has no resolved event-mention anchor; its coarse evidence start is used as the discourse position.`,
      path: `event/${event.id}`,
    });
    discourse.set(event.id, fallback ?? TIMELINE_UNANCHORED_BYTE);
  }

  // 2. Coreferent occurrences share one position.
  const parent = new Map(actual.map((event) => [event.id, event.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let current = id;
    while (parent.get(current) !== root) { const next = parent.get(current)!; parent.set(current, root); current = next; }
    return root;
  };
  for (const relation of input.relations) {
    if (relation.type !== "coreference" || relation.status === "contested") continue;
    if (!byId.has(relation.fromEventId) || !byId.has(relation.toEventId)) continue;
    const [a, b] = [find(relation.fromEventId), find(relation.toEventId)].sort();
    if (a !== b) parent.set(b!, a!);
  }
  const groups = new Map<string, string[]>();
  for (const event of actual) {
    const root = find(event.id);
    groups.set(root, [...(groups.get(root) ?? []), event.id]);
  }
  for (const members of groups.values()) members.sort((a, b) => discourse.get(a)! - discourse.get(b)! || a.localeCompare(b));
  const groupOf = (id: string) => find(id);

  // 3. Explicit constraint edges between groups (earlier -> later).
  const rawEdges: Edge[] = [];
  const add = (earlier: string, later: string, id: string) => {
    if (!byId.has(earlier) || !byId.has(later)) return;
    rawEdges.push({ from: earlier, to: later, id });
  };
  for (const relation of input.relations) {
    if (relation.status === "contested") continue;
    const a = relation.fromEventId, b = relation.toEventId;
    switch (relation.type) {
      case "before": case "causes": case "enables": add(a, b, relation.id); break;
      case "after": add(b, a, relation.id); break;
      // The containing interval begins first; contained moments follow it.
      case "during": case "subevent": case "starts": case "finishes": add(b, a, relation.id); break;
      case "contains": add(a, b, relation.id); break;
      default: break;
    }
  }
  for (const event of actual) {
    const time = event.storyTime;
    if (time.kind !== "relative" || time.offset !== undefined) continue;
    if (time.relation === "before") add(event.id, time.anchorEventId, `anchor:${event.id}`);
    else add(time.anchorEventId, event.id, `anchor:${event.id}`);
  }
  const calendar = actual
    .map((event) => ({ id: event.id, range: comparableStoryTime(event.storyTime) }))
    .filter((item): item is { id: string; range: NonNullable<typeof item.range> } => item.range?.scale === "calendar")
    .sort((a, b) => a.range.min - b.range.min || a.range.max - b.range.max || a.id.localeCompare(b.id));
  // Pairwise comparison is exact; very large calendars fall back to adjacent
  // pairs, which still never invents an order that the anchors do not prove.
  const pairwise = calendar.length <= 2_000;
  for (let i = 0; i < calendar.length; i++) {
    for (let j = i + 1; j < (pairwise ? calendar.length : Math.min(calendar.length, i + 2)); j++) {
      if (calendar[i]!.range.max < calendar[j]!.range.min) add(calendar[i]!.id, calendar[j]!.id, "calendar");
    }
  }

  const touching = new Map<string, Set<string>>();
  const groupEdges = new Map<string, Set<string>>();
  for (const edge of rawEdges) {
    const from = groupOf(edge.from), to = groupOf(edge.to);
    for (const id of [edge.from, edge.to]) touching.set(id, (touching.get(id) ?? new Set()).add(edge.id));
    if (from === to) continue;
    groupEdges.set(from, (groupEdges.get(from) ?? new Set()).add(to));
  }

  // 4. Narrative modes. Unanchored recollections stay at their discourse
  // position (D3); an unanchored flashforward is kept behind every other event
  // so a future fact can never be replayed into an earlier cut.
  const sortKey = new Map<string, number>();
  for (const [root, members] of groups) {
    const constrained = members.some((id) => touching.has(id));
    let key = Math.min(...members.map((id) => discourse.get(id)!));
    for (const id of members) {
      const mode = byId.get(id)!.narrativeContext?.mode;
      if (constrained) continue;
      if (mode === "flashback" || mode === "recollection") {
        issues.push({ code: "TIMELINE_FLASHBACK_UNANCHORED", message: `${mode === "flashback" ? "Flashback" : "Recollection"} ${id} has no explicit temporal constraint; it is placed at its discourse position. Add an evidence-backed before/after relation to move it earlier.`, path: `event/${id}` });
      } else if (mode === "flashforward") {
        issues.push({ code: "TIMELINE_FLASHFORWARD_UNANCHORED", message: `Flashforward ${id} has no explicit temporal constraint; it is kept after all other events so its effects cannot leak into earlier cuts.`, path: `event/${id}` });
      }
    }
    if (!constrained && members.every((id) => byId.get(id)!.narrativeContext?.mode === "flashforward")) key = TIMELINE_UNANCHORED_BYTE;
    sortKey.set(root, key);
  }

  // 5. Strongly connected components expose constraint cycles; the condensed
  // graph is ordered by Kahn's algorithm, preferring the earliest discourse
  // position reachable through successors so a proven predecessor is pulled
  // back to just before its earliest consequence.
  const roots = [...groups.keys()].sort();
  const components = stronglyConnected(roots, groupEdges);
  const componentOf = new Map<string, number>();
  components.forEach((members, index) => members.forEach((root) => componentOf.set(root, index)));
  for (const members of components) {
    const self = members.length === 1 && groupEdges.get(members[0]!)?.has(members[0]!);
    if (members.length < 2 && !self) continue;
    const eventIds = members.flatMap((root) => groups.get(root)!).sort();
    for (const id of eventIds) {
      issues.push({ code: "TIMELINE_CONSTRAINT_CYCLE", message: `Temporal/causal constraints form a cycle among ${eventIds.join(", ")}; cuts from the earliest of them are blocked until the evidence is reconciled.`, path: `event/${id}` });
    }
  }
  const componentEdges = components.map(() => new Set<number>());
  const indegree = components.map(() => 0);
  for (const [from, targets] of groupEdges) for (const to of targets) {
    const a = componentOf.get(from)!, b = componentOf.get(to)!;
    if (a === b || componentEdges[a]!.has(b)) continue;
    componentEdges[a]!.add(b);
    indegree[b]!++;
  }
  const ownKey = components.map((members) => Math.min(...members.map((root) => sortKey.get(root)!)));
  const pulledKey = [...ownKey];
  // Tarjan emits sinks first, so successors are final before their predecessors.
  for (let index = 0; index < components.length; index++) {
    for (const next of componentEdges[index]!) pulledKey[index] = Math.min(pulledKey[index]!, pulledKey[next]!);
  }
  const firstId = components.map((members) => [...members].sort()[0]!);
  const compare = (a: number, b: number) => pulledKey[a]! - pulledKey[b]! || ownKey[a]! - ownKey[b]! || firstId[a]!.localeCompare(firstId[b]!);
  const ready = new MinHeap<number>(compare);
  indegree.forEach((count, index) => { if (count === 0) ready.push(index); });
  const orderedComponents: number[] = [];
  while (ready.size) {
    const next = ready.pop()!;
    orderedComponents.push(next);
    for (const successor of componentEdges[next]!) if (--indegree[successor]! === 0) ready.push(successor);
  }

  const entries: CanonTimelineEntry[] = [];
  for (const component of orderedComponents) {
    const cyclic = components[component]!.length > 1;
    const orderedRoots = [...components[component]!].sort((a, b) => sortKey.get(a)! - sortKey.get(b)! || a.localeCompare(b));
    for (const root of orderedRoots) {
      const members = groups.get(root)!;
      for (const id of members) {
        entries.push({
          eventId: id,
          index: entries.length,
          discourseByte: discourse.get(id)!,
          basis: cyclic || pulledKey[component]! < ownKey[component]! ? "constraint" : "discourse",
          constraintIds: [...(touching.get(id) ?? [])].sort(),
          ...(id === members[0] ? {} : { aliasOf: members[0]! }),
          extents: extents.get(id) ?? [],
        });
      }
    }
  }

  // 6. Same-address writers whose relative order is only a discourse default.
  const assumed = new Map<string, { earlier: string; later: string; addresses: Set<string> }>();
  const lastWriter = new Map<string, string>();
  const reach = new Reachability(groupEdges);
  for (const entry of entries) {
    for (const operation of byId.get(entry.eventId)!.observedOutcome.operations) {
      const address = "entityId" in operation ? `${operation.entityId}/${operation.field}` : `rule/${operation.ruleId}`;
      const prior = lastWriter.get(address);
      lastWriter.set(address, entry.eventId);
      if (!prior || groupOf(prior) === groupOf(entry.eventId)) continue;
      if (reach.reaches(groupOf(prior), groupOf(entry.eventId))) continue;
      const key = `${prior}\u0000${entry.eventId}`;
      const pair = assumed.get(key) ?? { earlier: prior, later: entry.eventId, addresses: new Set<string>() };
      pair.addresses.add(address);
      assumed.set(key, pair);
    }
  }

  const subjectHash = contentHash({
    version: CANON_TIMELINE_VERSION,
    sourceId: input.sourceId,
    events: actual,
    relations: [...input.relations].sort((a, b) => a.id.localeCompare(b.id)),
    discourse: [...discourse].sort(([a], [b]) => a.localeCompare(b)),
    extents: [...extents].sort(([a], [b]) => a.localeCompare(b)),
  });
  const body = {
    version: CANON_TIMELINE_VERSION,
    sourceId: input.sourceId,
    subjectHash,
    entries,
    assumedPairs: [...assumed.values()].map((pair) => ({ earlier: pair.earlier, later: pair.later, addresses: [...pair.addresses].sort() })),
    issues: issues.sort((a, b) => a.code.localeCompare(b.code) || (a.path ?? "").localeCompare(b.path ?? "") || a.message.localeCompare(b.message)),
  };
  return { ...body, hash: contentHash(body) };
}

/** Event ID -> timeline index. Hypothetical and unknown events are absent. */
export function timelineIndex(timeline: Pick<CanonTimeline, "entries">): Map<string, number> {
  return new Map(timeline.entries.map((entry) => [entry.eventId, entry.index]));
}

/** The first coreferent occurrence of an event, or the event itself. */
export function timelineAliasRoot(timeline: Pick<CanonTimeline, "entries">, eventId: string): string {
  return timeline.entries.find((entry) => entry.eventId === eventId)?.aliasOf ?? eventId;
}

/** Earliest index whose cut is blocked by a hard timeline error, or undefined. */
export function timelineBlockedFromIndex(timeline: Pick<CanonTimeline, "entries" | "issues">): number | undefined {
  const index = timelineIndex(timeline);
  const blocked = timeline.issues
    .filter((issue) => TIMELINE_BLOCKING_CODES.has(issue.code) && issue.path?.startsWith("event/"))
    .map((issue) => index.get(issue.path!.slice("event/".length)))
    .filter((value): value is number => value !== undefined);
  return blocked.length ? Math.min(...blocked) : undefined;
}

function mentionExtentsByEvent(
  resolutions: readonly TimelineEventResolution[],
  annotations: readonly TimelineAnnotation[],
  events: ReadonlyMap<string, CanonicalEvent>,
): Map<string, Array<[number, number]>> {
  const mentions = new Map<string, Extract<TimelineAnnotation, { annotationType: "event-mention" }>>();
  for (const annotation of annotations) if (annotation.annotationType === "event-mention") mentions.set(annotation.id, annotation);
  const superseded = new Set(resolutions.flatMap((resolution) => resolution.supersedesResolutionIds ?? []));
  const result = new Map<string, Array<[number, number]>>();
  for (const resolution of [...resolutions].sort((a, b) => a.id.localeCompare(b.id))) {
    if (superseded.has(resolution.id)) continue;
    if (resolution.status !== "resolved" && resolution.status !== "new-event") continue;
    const eventId = resolution.canonicalEventId;
    if (!eventId || !events.has(eventId)) continue;
    const ranges = result.get(eventId) ?? [];
    for (const mentionId of resolution.eventMentionIds) {
      const mention = mentions.get(mentionId);
      if (!mention) continue;
      for (const anchor of mention.extentAnchors) ranges.push([anchor.startByte, anchor.endByte]);
    }
    if (ranges.length) result.set(eventId, ranges);
  }
  for (const [eventId, ranges] of result) {
    const unique = [...new Map(ranges.map((range) => [`${range[0]}:${range[1]}`, range])).values()];
    result.set(eventId, unique.sort((a, b) => a[0] - b[0] || a[1] - b[1]));
  }
  return result;
}

function lineToByteIndex(structure: TimelineStructure | undefined): ((line: number) => number | undefined) | undefined {
  if (!structure?.units.length) return undefined;
  const starts = new Map<number, number>();
  for (const unit of structure.units) {
    const prior = starts.get(unit.anchor.startLine);
    if (prior === undefined || unit.anchor.startByte < prior) starts.set(unit.anchor.startLine, unit.anchor.startByte);
  }
  const lines = [...starts.keys()].sort((a, b) => a - b);
  return (line) => {
    let low = 0, high = lines.length - 1, found: number | undefined;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (lines[middle]! <= line) { found = lines[middle]; low = middle + 1; } else high = middle - 1;
    }
    return found === undefined ? undefined : starts.get(found);
  };
}

function evidenceStartByte(event: CanonicalEvent, lineToByte: ((line: number) => number | undefined) | undefined): number | undefined {
  const bytes = event.evidence.map((reference) => reference.span.startByte ?? lineToByte?.(reference.span.startLine))
    .filter((value): value is number => typeof value === "number");
  return bytes.length ? Math.min(...bytes) : undefined;
}

/** Iterative Tarjan. Components are returned sinks-first (reverse topological order). */
function stronglyConnected(nodes: readonly string[], edges: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const index = new Map<string, number>(), low = new Map<string, number>(), onStack = new Set<string>();
  const stack: string[] = [], result: string[][] = [];
  let counter = 0;
  for (const start of nodes) {
    if (index.has(start)) continue;
    const work: Array<{ node: string; successors: string[]; next: number }> = [];
    const open = (node: string) => {
      index.set(node, counter); low.set(node, counter); counter++;
      stack.push(node); onStack.add(node);
      work.push({ node, successors: [...(edges.get(node) ?? [])].sort(), next: 0 });
    };
    open(start);
    while (work.length) {
      const frame = work[work.length - 1]!;
      if (frame.next < frame.successors.length) {
        const successor = frame.successors[frame.next++]!;
        if (!index.has(successor)) open(successor);
        else if (onStack.has(successor)) low.set(frame.node, Math.min(low.get(frame.node)!, index.get(successor)!));
        continue;
      }
      work.pop();
      if (work.length) {
        const caller = work[work.length - 1]!.node;
        low.set(caller, Math.min(low.get(caller)!, low.get(frame.node)!));
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let member: string;
        do { member = stack.pop()!; onStack.delete(member); component.push(member); } while (member !== frame.node);
        result.push(component.sort());
      }
    }
  }
  return result;
}

class Reachability {
  private readonly cache = new Map<string, Set<string>>();
  constructor(private readonly edges: ReadonlyMap<string, ReadonlySet<string>>) {}
  reaches(from: string, to: string): boolean {
    let seen = this.cache.get(from);
    if (!seen) {
      seen = new Set<string>();
      const pending = [...(this.edges.get(from) ?? [])];
      while (pending.length) {
        const node = pending.pop()!;
        if (seen.has(node)) continue;
        seen.add(node);
        for (const next of this.edges.get(node) ?? []) if (!seen.has(next)) pending.push(next);
      }
      if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(from, seen);
    }
    return seen.has(to);
  }
}

class MinHeap<T> {
  private readonly items: T[] = [];
  constructor(private readonly compare: (a: T, b: T) => number) {}
  get size() { return this.items.length; }
  push(item: T) {
    const items = this.items;
    items.push(item);
    let child = items.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (this.compare(items[child]!, items[parent]!) >= 0) break;
      [items[child], items[parent]] = [items[parent]!, items[child]!];
      child = parent;
    }
  }
  pop(): T | undefined {
    const items = this.items;
    if (!items.length) return undefined;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length) {
      items[0] = last;
      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1, right = left + 1;
        let smallest = parent;
        if (left < items.length && this.compare(items[left]!, items[smallest]!) < 0) smallest = left;
        if (right < items.length && this.compare(items[right]!, items[smallest]!) < 0) smallest = right;
        if (smallest === parent) break;
        [items[parent], items[smallest]] = [items[smallest]!, items[parent]!];
        parent = smallest;
      }
    }
    return top;
  }
}
