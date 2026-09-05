import { contentHash } from "./canonical.js";
import type { CanonicalEvent, EventRelation, StoryTime, ValidationIssue } from "./model.js";
import { compareStoryTime } from "./time.js";

export type EntryCut = {
  version: 1;
  beforeEventId?: string;
  storyTime?: StoryTime;
  completedEventIds: string[];
  replayEventIds: string[];
  excludedEventIds: string[];
  ambiguousEventIds: string[];
  issues: ValidationIssue[];
  hash: string;
};

/** Story chronology is authority; source position is used only by the reader recap. */
export function deriveEntryCut(input: {
  events: readonly CanonicalEvent[]; relations: readonly EventRelation[];
  beforeEventId?: string; storyTime?: StoryTime;
  baselineEventId?: string; baselineTime?: StoryTime; completeCheckpoint?: boolean;
}): EntryCut {
  const events = new Map(input.events.map((event) => [event.id, event]));
  const canonical = new Map(input.events.map((event) => [event.id, event.id]));
  const root = (id: string): string => {
    let current = id;
    while (canonical.has(current) && canonical.get(current) !== current) current = canonical.get(current)!;
    return current;
  };
  for (const relation of input.relations.filter((x) => x.type === "coreference" && x.status !== "contested")) {
    const [a, b] = [root(relation.fromEventId), root(relation.toEventId)].sort();
    if (a && b) canonical.set(b, a);
  }
  const edges = new Map<string, Set<string>>();
  for (const relation of input.relations.filter((x) => x.status !== "contested" && ["before", "after"].includes(x.type))) {
    const [a, b] = relation.type === "before" ? [relation.fromEventId, relation.toEventId] : [relation.toEventId, relation.fromEventId];
    const from = root(a), to = root(b);
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from)!.add(to);
  }
  const precedes = (a: string, b: string): boolean => {
    const pending = [...(edges.get(root(a)) ?? [])], seen = new Set<string>();
    while (pending.length) {
      const next = pending.pop()!;
      if (next === root(b)) return true;
      if (seen.has(next)) continue;
      seen.add(next); pending.push(...(edges.get(next) ?? []));
    }
    return false;
  };
  const boundaryTime = input.storyTime ?? (input.beforeEventId ? events.get(input.beforeEventId)?.storyTime : undefined);
  const baselineTime = input.baselineTime ?? (input.baselineEventId ? events.get(input.baselineEventId)?.storyTime : undefined);
  const issues: ValidationIssue[] = [];
  const groups = new Map<string, CanonicalEvent[]>();
  for (const event of input.events) {
    const id = root(event.id);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id)!.push(event);
  }
  const completed: CanonicalEvent[] = [], replay: CanonicalEvent[] = [], excluded: string[] = [], ambiguous: string[] = [];
  const material = (event: CanonicalEvent) => event.observedOutcome.operations.length || event.observedKnowledge?.operations.length;
  for (const group of groups.values()) {
    const event = [...group].sort((a, b) => Number(material(b) || 0) - Number(material(a) || 0) || a.id.localeCompare(b.id))[0]!;
    const distinctEffects = new Set(group.filter(material).map((item) => contentHash({ delta: item.observedOutcome, knowledge: item.observedKnowledge })));
    if (distinctEffects.size > 1) issues.push({ code: "ENTRY_COREFERENCE_EFFECT_CONFLICT", message: `Coreferent event ${event.id} has competing effect definitions` });
    if (group.some((x) => x.narrativeContext?.mode === "hypothetical") || input.beforeEventId && root(event.id) === root(input.beforeEventId)) {
      excluded.push(...group.map((x) => x.id)); continue;
    }
    const ordering = compareStoryTime(event.storyTime, boundaryTime);
    const before = input.beforeEventId ? precedes(event.id, input.beforeEventId) : false;
    const after = input.beforeEventId ? precedes(input.beforeEventId, event.id) : false;
    if ((before && after) || before && ordering === 1 || after && ordering === -1) {
      issues.push({ code: "ENTRY_TIME_CONFLICT", message: `Conflicting chronology for ${event.id}` }); ambiguous.push(event.id); continue;
    }
    if (before || ordering === -1) {
      completed.push(event);
      const baselineOrder = compareStoryTime(event.storyTime, baselineTime);
      if (!input.completeCheckpoint && (baselineOrder === 0 || baselineOrder === 1 || input.baselineEventId && precedes(input.baselineEventId, event.id))) replay.push(event);
      else if (!input.completeCheckpoint && baselineOrder === undefined && material(event)) {
        ambiguous.push(event.id); issues.push({ code: "ENTRY_BASELINE_UNKNOWN", message: `Cannot place ${event.id} relative to the opening seed` });
      }
    } else if (after || ordering === 1) excluded.push(...group.map((x) => x.id));
    else {
      ambiguous.push(event.id);
      if (material(event)) issues.push({ code: "ENTRY_TIME_UNKNOWN", message: `Cannot establish whether effect-bearing event ${event.id} happened before entry` });
    }
  }
  if (!input.completeCheckpoint && compareStoryTime(boundaryTime, baselineTime) === -1) {
    issues.push({ code: "ENTRY_HISTORICAL_SEED_REQUIRED", message: "Historical entry requires a complete pre-event checkpoint; a later opening cannot seed its past" });
  }
  replay.sort((a, b) => precedes(a.id, b.id) ? -1 : precedes(b.id, a.id) ? 1 : compareStoryTime(a.storyTime, b.storyTime) ?? a.id.localeCompare(b.id));
  const lastWrite = new Map<string, CanonicalEvent>();
  for (const event of replay) for (const op of event.observedOutcome.operations) {
    const address = "entityId" in op ? `${op.entityId}/${op.field}` : `rule/${op.ruleId}`;
    const prior = lastWrite.get(address);
    if (prior && prior.id !== event.id && compareStoryTime(prior.storyTime, event.storyTime) !== -1 && !precedes(prior.id, event.id)) {
      issues.push({ code: "ENTRY_EFFECT_ORDER_UNKNOWN", message: `Effects of ${prior.id} and ${event.id} overlap without a proven order` });
    }
    lastWrite.set(address, event);
  }
  const subject = {
    version: 1 as const, ...(input.beforeEventId ? { beforeEventId: input.beforeEventId } : {}), ...(boundaryTime ? { storyTime: boundaryTime } : {}),
    completedEventIds: completed.flatMap((x) => groups.get(root(x.id))!.map((item) => item.id)).sort(),
    replayEventIds: replay.map((x) => x.id), excludedEventIds: excluded.sort(), ambiguousEventIds: ambiguous.sort(), issues: issues.sort((a, b) => a.code.localeCompare(b.code) || a.message.localeCompare(b.message)),
  };
  return { ...subject, hash: contentHash(subject) };
}
