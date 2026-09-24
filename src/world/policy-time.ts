import type { StoryTime } from "./model.js";
import { comparableStoryTime, storyTimeAtOrAfter, storyTimeBefore } from "./time.js";

/** Scope truth is separate from the caller's decision to omit an unproven policy. */
export function policyStoryScopeTruth(
  current: StoryTime | undefined, candidate: StoryTime | undefined,
  realizedCanonicalEventIds: ReadonlySet<string>,
): "true" | "false" | "unknown" {
  if (candidate?.kind === "relative") {
    if (candidate.offset !== undefined || candidate.relation === "during"
      || !realizedCanonicalEventIds.has(candidate.anchorEventId)) return "unknown";
    return candidate.relation === "after" ? "true" : "false";
  }
  return worldRuleStoryScopeTruth(current, candidate);
}

/** Only proven scope can influence actor policy or authorize a spatial route. */
export function policyStoryScopeActive(
  current: StoryTime | undefined, candidate: StoryTime | undefined,
  realizedCanonicalEventIds: ReadonlySet<string>,
): boolean {
  return policyStoryScopeTruth(current, candidate, realizedCanonicalEventIds) === "true";
}

/** Deterministic active window for an event-gated policy change. */
export function policyEpisodeTimeActive(
  current: StoryTime | undefined,
  startsAt: StoryTime,
  endsAt: StoryTime | undefined,
  realizedCanonicalEventIds: ReadonlySet<string>,
): boolean {
  // Free-text offsets are not executable durations, even when their anchor occurred.
  if ((startsAt.kind === "relative" && startsAt.offset !== undefined)
    || (endsAt?.kind === "relative" && endsAt.offset !== undefined)) return false;
  const afterStart = startsAt.kind === "unknown"
    || (startsAt.kind === "relative"
      ? realizedCanonicalEventIds.has(startsAt.anchorEventId)
      : storyTimeAtOrAfter(current, startsAt));
  if (!afterStart) return false;
  if (!endsAt || endsAt.kind === "unknown") return true;
  if (endsAt.kind === "relative") return !realizedCanonicalEventIds.has(endsAt.anchorEventId);
  return storyTimeBefore(current, endsAt);
}

/** A rule's bounded validity needs containment of the cut, not merely overlap. */
export function worldRuleStoryScopeTruth(
  current: StoryTime | undefined, candidate: StoryTime | undefined,
): "true" | "false" | "unknown" {
  if (!candidate) return "true";
  // Schemas reject these rule bounds; never interpret malformed/legacy input as unbounded.
  if (candidate.kind === "unknown" || candidate.kind === "relative") return "unknown";
  const cut = comparableStoryTime(current), window = comparableStoryTime(candidate);
  if (!cut || !window || cut.scale !== window.scale) return "unknown";
  if (cut.max < window.min || cut.min > window.max) return "false";
  return cut.min >= window.min && cut.max <= window.max ? "true" : "unknown";
}
