import type { CanonicalEvent, EventRelation, ValidationIssue } from "./model.js";
import { comparableStoryTime } from "./time.js";

type Edge = { from: string; to: string; strict: boolean; reason: string };
const start = (id: string) => JSON.stringify(["event", id, "start"]);
const end = (id: string) => JSON.stringify(["event", id, "end"]);

/**
 * A partial-order solver over interval endpoints, not a guessed chronology.
 * Containment is inclusive, overlaps is symmetric intersection; neither creates
 * an event occurrence, duration, causal edge, or arbitrary order between peers.
 * A strict edge inside a non-strict SCC is an inconsistent temporal theory.
 */
export class TemporalConstraints {
  readonly issues: ValidationIssue[] = [];
  private readonly outgoing = new Map<string, Edge[]>();
  private readonly components = new Map<string, number>();
  private readonly rank = new Map<number, number>();
  private readonly reachCache = new Map<string, Map<string, boolean>>();

  constructor(events: ReadonlyMap<string, CanonicalEvent>, relations: readonly EventRelation[]) {
    if (events.size > 25_000 || relations.length > 100_000) {
      this.issues.push({ code: "TEMPORAL_CONSTRAINT_LIMIT", message: "Temporal dependency package exceeds the host graph boundary; split source review without inventing chronology." });
      return;
    }
    const edges: Edge[] = [], nodes = new Set<string>();
    const constants = new Map<string, Map<number, string>>();
    const add = (from: string, to: string, strict: boolean, reason: string) => { nodes.add(from); nodes.add(to); edges.push({ from, to, strict, reason }); };
    const equal = (a: string, b: string, reason: string) => { add(a, b, false, reason); add(b, a, false, reason); };
    const constant = (scale: string, value: number) => {
      const values = constants.get(scale) ?? new Map<number, string>();
      constants.set(scale, values);
      const node = JSON.stringify(["time", scale, value]); values.set(value, node); return node;
    };
    for (const event of events.values()) {
      add(start(event.id), end(event.id), false, `event:${event.id}`);
      const bounds = comparableStoryTime(event.storyTime);
      if (bounds && Number.isFinite(bounds.min) && Number.isFinite(bounds.max)) {
        add(constant(bounds.scale, bounds.min), start(event.id), false, `anchor:${event.id}`);
        add(end(event.id), constant(bounds.scale, bounds.max), false, `anchor:${event.id}`);
      }
      if (event.storyTime.kind === "relative" && event.storyTime.offset === undefined && events.has(event.storyTime.anchorEventId)) {
        const a = event.id, b = event.storyTime.anchorEventId, why = `anchor:${a}`;
        if (event.storyTime.relation === "before") add(end(a), start(b), true, why);
        if (event.storyTime.relation === "after") add(end(b), start(a), true, why);
        if (event.storyTime.relation === "during") { add(start(b), start(a), false, why); add(end(a), end(b), false, why); }
      }
    }
    for (const values of constants.values()) {
      const ordered = [...values].sort(([a], [b]) => a - b);
      for (let i = 1; i < ordered.length; i++) add(ordered[i - 1]![1], ordered[i]![1], true, "ordered-time-anchors");
    }
    for (const relation of relations) {
      if (relation.status === "contested" || !events.has(relation.fromEventId) || !events.has(relation.toEventId)) continue;
      const a = relation.fromEventId, b = relation.toEventId, why = `relation:${relation.id}`;
      switch (relation.type) {
        case "before": add(end(a), start(b), true, why); break;
        case "after": add(end(b), start(a), true, why); break;
        case "during": case "subevent": add(start(b), start(a), false, why); add(end(a), end(b), false, why); break;
        case "contains": add(start(a), start(b), false, why); add(end(b), end(a), false, why); break;
        case "overlaps": add(start(a), end(b), false, why); add(start(b), end(a), false, why); break;
        case "starts": equal(start(a), start(b), why); add(end(a), end(b), false, why); break;
        case "finishes": equal(end(a), end(b), why); add(start(b), start(a), false, why); break;
        case "coreference": equal(start(a), start(b), why); equal(end(a), end(b), why); break;
        // Causal/explanatory and discourse relations do not silently become a strict temporal order.
      }
    }
    const reverse = new Map<string, string[]>();
    for (const edge of edges) {
      const forward = this.outgoing.get(edge.from) ?? []; forward.push(edge); this.outgoing.set(edge.from, forward);
      const backward = reverse.get(edge.to) ?? []; backward.push(edge.from); reverse.set(edge.to, backward);
    }
    for (const edges of this.outgoing.values()) edges.sort((a, b) => a.to.localeCompare(b.to) || Number(a.strict) - Number(b.strict) || a.reason.localeCompare(b.reason));
    for (const nodes of reverse.values()) nodes.sort();
    // Iterative Kosaraju avoids recursion overflow for long novels.
    const visited = new Set<string>(), finish: string[] = [];
    for (const node of [...nodes].sort()) {
      if (visited.has(node)) continue;
      visited.add(node);
      const stack: Array<[string, number]> = [[node, 0]];
      while (stack.length) {
        const frame = stack[stack.length - 1]!, next = this.outgoing.get(frame[0]) ?? [];
        if (frame[1] === next.length) { finish.push(frame[0]); stack.pop(); continue; }
        const to = next[frame[1]++]!.to;
        if (!visited.has(to)) { visited.add(to); stack.push([to, 0]); }
      }
    }
    let component = 0;
    for (const node of finish.reverse()) {
      if (this.components.has(node)) continue;
      const stack = [node]; this.components.set(node, component);
      while (stack.length) for (const prior of reverse.get(stack.pop()!) ?? []) {
        if (!this.components.has(prior)) { this.components.set(prior, component); stack.push(prior); }
      }
      component++;
    }
    const conflicts = new Map<number, Set<string>>();
    for (const edge of edges) if (edge.strict && this.components.get(edge.from) === this.components.get(edge.to)) {
      const key = this.components.get(edge.from)!;
      if (!conflicts.has(key)) conflicts.set(key, new Set());
    }
    for (const edge of edges) {
      const key = this.components.get(edge.from)!;
      if (key === this.components.get(edge.to)) conflicts.get(key)?.add(edge.reason);
    }
    for (const reasons of conflicts.values()) this.issues.push({
      code: "TEMPORAL_CONSTRAINT_CONTRADICTION",
      message: `Inconsistent interval constraints: ${[...reasons].sort().slice(0, 32).join(", ")}. Preserve competing evidence and request source review; do not invent an order.`,
    });
    // Kosaraju's source-first component numbering is a valid topological rank.
    for (let i = 0; i < component; i++) this.rank.set(i, i);
  }

  definitelyBefore(left: string, right: string): boolean {
    if (this.issues.length || left === right) return false;
    const a = end(left), b = start(right);
    if (!this.components.has(a) || !this.components.has(b)) return false;
    let reachable = this.reachCache.get(a);
    if (!reachable) {
      reachable = new Map<string, boolean>([[a, false]]);
      const pending: Array<[string, boolean]> = [[a, false]];
      while (pending.length) {
        const [from, strict] = pending.pop()!;
        for (const edge of this.outgoing.get(from) ?? []) {
          const nextStrict = strict || edge.strict, previous = reachable.get(edge.to);
          if (previous === true || previous === false && !nextStrict) continue;
          reachable.set(edge.to, nextStrict); pending.push([edge.to, nextStrict]);
        }
      }
      if (this.reachCache.size >= 64) this.reachCache.delete(this.reachCache.keys().next().value!);
      this.reachCache.set(a, reachable);
    }
    return reachable.get(b) === true;
  }

  /** Stable linear extension for replay, not evidence of order between incomparable events. */
  order(ids: readonly string[]): string[] {
    return [...ids].sort((a, b) => (this.rank.get(this.components.get(end(a))!) ?? 0)
      - (this.rank.get(this.components.get(end(b))!) ?? 0) || a.localeCompare(b));
  }
}
