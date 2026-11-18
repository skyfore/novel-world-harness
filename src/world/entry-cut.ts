import { TemporalConstraints } from "./temporal-constraints.js";
import { contentHash } from "./canonical.js";
import type { CanonicalEvent, EventRelation, StoryTime, ValidationIssue } from "./model.js";
import { compareStoryTime } from "./time.js";
import { timelineBlockedFromIndex, timelineGroupStart, timelineIndex, type CanonTimeline } from "./canon-timeline.js";

export type EntryCut = {
  version: 1;
  beforeEventId?: string;
  storyTime?: StoryTime;
  completedEventIds: string[];
  replayEventIds: string[];
  excludedEventIds: string[];
  ambiguousEventIds: string[];
  issues: ValidationIssue[];
  /** Present when membership was decided by a frozen canonical timeline. */
  timelineHash?: string;
  /** Non-blocking cut diagnostics (timeline mode only). */
  advisories?: ValidationIssue[];
  hash: string;
};

export type EntryCutInput = {
  events: readonly CanonicalEvent[]; relations: readonly EventRelation[];
  beforeEventId?: string; storyTime?: StoryTime;
  baselineEventId?: string; baselineTime?: StoryTime; completeCheckpoint?: boolean;
  /** Frozen host chronology. When present it alone decides cut membership. */
  timeline?: CanonTimeline;
  /** Timeline position of an opening without a checkpoint event (see openingTimelineIndex). */
  baselineIndex?: number;
};

/**
 * With a frozen timeline, membership is decided by timeline index alone.
 * Legacy snapshots without one fall back to story-time comparison.
 */
export function deriveEntryCut(input: EntryCutInput): EntryCut {
  return input.timeline ? deriveTimelineEntryCut(input, input.timeline) : deriveStoryTimeEntryCut(input);
}

const material = (event: CanonicalEvent) => Boolean(event.observedOutcome.operations.length || event.observedKnowledge?.operations.length);

function deriveTimelineEntryCut(input: EntryCutInput, timeline: CanonTimeline): EntryCut {
  const events = new Map(input.events.map((event) => [event.id, event]));
  const index = timelineIndex(timeline);
  const issues: ValidationIssue[] = [], advisories: ValidationIssue[] = [];
  const unknown = (code: string, id: string, role: string) => issues.push({ code, message: `The ${role} event ${id} is not on the canonical timeline`, path: `event/${id}` });
  let baseline = input.baselineIndex ?? 0;
  if (input.baselineEventId) {
    const start = timelineGroupStart(timeline, input.baselineEventId, index);
    if (start === undefined) unknown("ENTRY_BASELINE_EVENT_UNKNOWN", input.baselineEventId, "opening checkpoint");
    else baseline = start;
  }
  let target = baseline;
  if (input.beforeEventId) {
    const start = timelineGroupStart(timeline, input.beforeEventId, index);
    if (start === undefined) { unknown("ENTRY_CUT_EVENT_UNKNOWN", input.beforeEventId, "entry"); target = -1; }
    else target = start;
  }
  const blockedFrom = timelineBlockedFromIndex(timeline);
  if (blockedFrom !== undefined && target > blockedFrom) {
    issues.push({ code: "TIMELINE_CONSTRAINT_CYCLE", message: `The cut follows an unresolved temporal constraint cycle at timeline index ${blockedFrom}; reconcile the cycle before entering here.` });
  }
  if (!input.completeCheckpoint && target >= 0 && target < baseline) {
    issues.push({ code: "ENTRY_HISTORICAL_SEED_REQUIRED", message: "Historical entry requires a complete pre-event checkpoint; a later opening cannot seed its past" });
  }
  const completed: string[] = [];
  const groups = new Map<string, CanonicalEvent[]>();
  for (const entry of timeline.entries) {
    if (entry.index >= target) break;
    const event = events.get(entry.eventId);
    if (!event) continue;
    completed.push(event.id);
    const root = entry.aliasOf ?? entry.eventId;
    groups.set(root, [...(groups.get(root) ?? []), event]);
  }
  const replay: CanonicalEvent[] = [];
  for (const [root, group] of groups) {
    const representative = [...group].sort((a, b) => Number(material(b)) - Number(material(a)) || a.id.localeCompare(b.id))[0]!;
    const distinctEffects = new Set(group.filter(material).map((item) => contentHash({ delta: item.observedOutcome, knowledge: item.observedKnowledge })));
    if (distinctEffects.size > 1) issues.push({ code: "ENTRY_COREFERENCE_EFFECT_CONFLICT", message: `Coreferent event ${representative.id} has competing effect definitions`, path: `event/${representative.id}` });
    if (!input.completeCheckpoint && (timelineGroupStart(timeline, root, index) ?? -1) >= baseline) replay.push(representative);
  }
  replay.sort((a, b) => index.get(a.id)! - index.get(b.id)!);
  const replayed = new Set(replay.map((event) => event.id));
  for (const pair of timeline.assumedPairs) {
    if (!replayed.has(pair.earlier) || !replayed.has(pair.later)) continue;
    advisories.push({ code: "ENTRY_EFFECT_ORDER_UNKNOWN", message: `Effects of ${pair.earlier} and ${pair.later} on ${pair.addresses.join(", ")} are ordered by discourse position, not a proven constraint`, path: `event/${pair.later}` });
  }
  const done = new Set(completed);
  const boundaryTime = input.storyTime ?? (input.beforeEventId ? events.get(input.beforeEventId)?.storyTime : undefined);
  const byIssue = (a: ValidationIssue, b: ValidationIssue) => a.code.localeCompare(b.code) || a.message.localeCompare(b.message);
  const subject = {
    version: 1 as const, ...(input.beforeEventId ? { beforeEventId: input.beforeEventId } : {}), ...(boundaryTime ? { storyTime: boundaryTime } : {}),
    completedEventIds: [...completed].sort(), replayEventIds: replay.map((event) => event.id),
    excludedEventIds: input.events.map((event) => event.id).filter((id) => !done.has(id)).sort(), ambiguousEventIds: [],
    issues: issues.sort(byIssue), timelineHash: timeline.hash, advisories: advisories.sort(byIssue),
  };
  return { ...subject, hash: contentHash(subject) };
}

function deriveStoryTimeEntryCut(input: EntryCutInput): EntryCut {
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
  const temporal = new TemporalConstraints(events, input.relations);
  const precedes = (a: string, b: string) => temporal.definitelyBefore(root(a), root(b));
  const boundaryTime = input.storyTime ?? (input.beforeEventId ? events.get(input.beforeEventId)?.storyTime : undefined);
  const baselineTime = input.baselineTime ?? (input.baselineEventId ? events.get(input.baselineEventId)?.storyTime : undefined);
  const issues: ValidationIssue[] = temporal.issues.map(issue => ({ ...issue, code: "ENTRY_TIME_CONFLICT" }));
  const groups = new Map<string, CanonicalEvent[]>();
  for (const event of input.events) {
    const id = root(event.id);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id)!.push(event);
  }
  const completed: CanonicalEvent[] = [], replay: CanonicalEvent[] = [], excluded: string[] = [], ambiguous: string[] = [];
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
      if (!input.completeCheckpoint && (baselineOrder === 0 || baselineOrder === 1 || input.baselineEventId && (root(input.baselineEventId) === root(event.id) || precedes(input.baselineEventId, event.id)))) replay.push(event);
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
  const replayRanks = new Map(temporal.order(replay.map(event => event.id)).map((id, index) => [id, index]));
  replay.sort((a, b) => replayRanks.get(a.id)! - replayRanks.get(b.id)!);
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
