import type { StoryTime } from "./model.js";
import { comparableStoryTime, storyTimeAtOrAfter, storyTimeBefore, storyTimesOverlap } from "./time.js";

/** Deterministic validity for source-compiled policy at one branch head. */
export function policyStoryScopeActive(
  current: StoryTime | undefined,
  candidate: StoryTime | undefined,
  realizedCanonicalEventIds: ReadonlySet<string>,
): boolean {
  if (!candidate || candidate.kind === "unknown") return true;
  if (candidate.kind === "relative") {
    return candidate.relation === "after"
      ? realizedCanonicalEventIds.has(candidate.anchorEventId)
      : !realizedCanonicalEventIds.has(candidate.anchorEventId);
  }
  if (!current || current.kind === "unknown" || current.kind === "relative") return false;
  if (storyTimesOverlap(current, candidate)) return true;
  return current.kind === "ordinal"
    && candidate.kind === "ordinal"
    && current.orderHint === undefined
    && candidate.orderHint === undefined
    && normalized(current.label) === normalized(candidate.label);
}

/** Deterministic active window for an event-gated policy change. */
export function policyEpisodeTimeActive(
  current: StoryTime | undefined,
  startsAt: StoryTime,
  endsAt: StoryTime | undefined,
  realizedCanonicalEventIds: ReadonlySet<string>,
): boolean {
  const afterStart = startsAt.kind === "unknown"
    || (startsAt.kind === "relative"
      ? realizedCanonicalEventIds.has(startsAt.anchorEventId)
      : storyTimeAtOrAfter(current, startsAt));
  if (!afterStart) return false;
  if (!endsAt || endsAt.kind === "unknown") return true;
  if (endsAt.kind === "relative") return !realizedCanonicalEventIds.has(endsAt.anchorEventId);
  return storyTimeBefore(current, endsAt);
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
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
