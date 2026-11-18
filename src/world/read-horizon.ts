import type { CanonTimeline } from "./canon-timeline.js";

/**
 * How far a branch has "read" into its source. Prose is usable as narrative
 * or NPC reference only when it ends at or before horizonByte and does not
 * overlap a still-unresolved event's mention (prolepsis). After the branch
 * supersedes canon, the horizon freezes at the first divergence: later prose
 * describes a parallel history that did not happen here.
 */
export type ReadHorizon = {
  horizonByte: number;
  frozenByDivergence: boolean;
  excludedRanges: Array<[number, number]>;
};

/** Canonical events this branch has realized, adapted or superseded. */
export type BranchCanonResolution = { resolved: Set<string>; superseded: Set<string> };

export function deriveReadHorizon(
  timeline: Pick<CanonTimeline, "entries">,
  resolved: ReadonlySet<string>,
  superseded: ReadonlySet<string> = new Set(),
  mentionExtents?: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>,
): ReadHorizon {
  const extentsOf = (eventId: string, fallback: ReadonlyArray<readonly [number, number]>) => mentionExtents?.get(eventId) ?? fallback;
  const settled = (eventId: string) => resolved.has(eventId) || superseded.has(eventId);
  const next = timeline.entries.find((entry) => !settled(entry.eventId) && !(entry.aliasOf && settled(entry.aliasOf)));
  let horizonByte = next ? next.discourseByte : Number.MAX_SAFE_INTEGER;
  const divergence = timeline.entries.find((entry) => superseded.has(entry.eventId));
  const frozenByDivergence = Boolean(divergence && divergence.discourseByte <= horizonByte);
  if (divergence) horizonByte = Math.min(horizonByte, divergence.discourseByte);
  const ranges: Array<[number, number]> = [];
  for (const entry of timeline.entries) {
    if (settled(entry.eventId) || (entry.aliasOf && settled(entry.aliasOf))) continue;
    for (const [start, end] of extentsOf(entry.eventId, entry.extents)) ranges.push([start, end]);
  }
  return { horizonByte, frozenByDivergence, excludedRanges: mergeRanges(ranges) };
}

/** A source range is usable when it ends within the horizon and avoids every excluded range. */
export function rangeWithinHorizon(horizon: ReadHorizon, startByte: number, endByte: number): boolean {
  if (endByte > horizon.horizonByte) return false;
  return !horizon.excludedRanges.some(([start, end]) => startByte < end && start < endByte);
}

/** Realized, adapted and superseded canonical events of a committed history. */
export function branchCanonResolution(events: ReadonlyArray<{
  realizesCanonicalEventIds?: readonly string[];
  supersedesCanonicalEventIds?: readonly string[];
  canonicalAdaptation?: { adaptedFromCanonicalEventId: string };
}>): BranchCanonResolution {
  const resolved = new Set<string>(), superseded = new Set<string>();
  for (const event of events) {
    for (const id of event.realizesCanonicalEventIds ?? []) resolved.add(id);
    if (event.canonicalAdaptation) resolved.add(event.canonicalAdaptation.adaptedFromCanonicalEventId);
    for (const id of event.supersedesCanonicalEventIds ?? []) superseded.add(id);
  }
  return { resolved, superseded };
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = ranges.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}
