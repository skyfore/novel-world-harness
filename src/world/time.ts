import type { LogicalTime, StoryTime, TimeAdvance } from "./model.js";

const DAYS_PER_YEAR = 365.2425;
const DAYS_PER_MONTH = DAYS_PER_YEAR / 12;
const MILLISECONDS_PER_DAY = 86_400_000;
const CALENDAR_EPSILON_DAYS = 1 / MILLISECONDS_PER_DAY;

export type ComparableStoryTime = {
  scale: "calendar" | "ordinal";
  min: number;
  max: number;
};

/** Convert an authored duration into the engine's deterministic elapsed-day clock. */
export function timeAdvanceInDays(advance: TimeAdvance | undefined): number {
  if (!advance) return 0;
  switch (advance.unit) {
    case "minute": return advance.amount / (24 * 60);
    case "hour": return advance.amount / 24;
    case "day": return advance.amount;
    case "week": return advance.amount * 7;
    case "month": return advance.amount * DAYS_PER_MONTH;
    case "year": return advance.amount * DAYS_PER_YEAR;
  }
}

/**
 * Advance a branch-derived calendar anchor for explicit player/world waiting.
 * Unorderable relative and ordinal anchors remain unchanged; elapsedDays still
 * records the authoritative duration in those cases.
 */
export function advanceStoryTime(time: StoryTime, advance: TimeAdvance): StoryTime {
  if (time.kind === "exact") {
    const value = shiftCalendarValue(time.value, advance, time.precision);
    return value ? { ...time, value } : structuredClone(time);
  }
  if (time.kind === "range") {
    const earliest = shiftCalendarValue(time.earliest, advance);
    const latest = shiftCalendarValue(time.latest, advance);
    return earliest && latest ? { kind: "range", earliest, latest } : structuredClone(time);
  }
  return structuredClone(time);
}

/**
 * Produces a coarse but deterministic interval for ordering story anchors.
 * Unknown and unresolved relative anchors intentionally remain incomparable.
 */
export function comparableStoryTime(time: StoryTime | undefined): ComparableStoryTime | undefined {
  if (!time || time.kind === "unknown" || time.kind === "relative") return undefined;
  if (time.kind === "ordinal") {
    return typeof time.orderHint === "number"
      ? { scale: "ordinal", min: time.orderHint, max: time.orderHint }
      : undefined;
  }
  if (time.kind === "exact") return calendarInterval(time.value, time.precision);
  const earliest = calendarInterval(time.earliest);
  const latest = calendarInterval(time.latest);
  if (!earliest || !latest) return undefined;
  return {
    scale: "calendar",
    min: Math.min(earliest.min, latest.min),
    max: Math.max(earliest.max, latest.max),
  };
}

/** -1 means left is definitely earlier, 1 later, 0 overlapping/equal. */
export function compareStoryTime(left: StoryTime | undefined, right: StoryTime | undefined): -1 | 0 | 1 | undefined {
  const leftRange = comparableStoryTime(left);
  const rightRange = comparableStoryTime(right);
  if (!leftRange || !rightRange || leftRange.scale !== rightRange.scale) return undefined;
  if (leftRange.max < rightRange.min) return -1;
  if (leftRange.min > rightRange.max) return 1;
  return 0;
}

export function storyTimesOverlap(left: StoryTime | undefined, right: StoryTime | undefined): boolean {
  return compareStoryTime(left, right) === 0;
}

export function storyTimeAtOrAfter(current: StoryTime | undefined, boundary: StoryTime): boolean {
  const order = compareStoryTime(current, boundary);
  return order === 0 || order === 1;
}

export function storyTimeBefore(current: StoryTime | undefined, boundary: StoryTime): boolean {
  return compareStoryTime(current, boundary) === -1;
}

/**
 * Advance both clocks for an accepted event. An unknown proposed anchor keeps
 * the last known story anchor; it never erases temporal knowledge.
 */
export function nextLogicalTime(current: LogicalTime, proposed: StoryTime, advance?: TimeAdvance): LogicalTime {
  const order = compareStoryTime(proposed, current.storyTime);
  if (order === -1) throw new Error("Proposed story time is earlier than committed branch time");
  const storyTime = proposed.kind === "unknown" ? current.storyTime : proposed;
  const explicitDays = timeAdvanceInDays(advance);
  const inferredDays = advance ? 0 : inferElapsedDays(current.storyTime, storyTime);
  return {
    step: current.step + 1,
    ...(storyTime ? { storyTime } : {}),
    elapsedDays: (current.elapsedDays ?? 0) + explicitDays + inferredDays,
  };
}

/** Validate the cumulative clock persisted on a commit during replay. */
export function assertMonotonicLogicalTime(previous: LogicalTime, next: LogicalTime): void {
  if (next.step <= previous.step) throw new Error("Logical step must increase");
  if ((next.elapsedDays ?? 0) < (previous.elapsedDays ?? 0)) throw new Error("Elapsed world time must not move backwards");
  if (compareStoryTime(next.storyTime, previous.storyTime) === -1) throw new Error("Story time must not move backwards");
}

function inferElapsedDays(current: StoryTime | undefined, next: StoryTime | undefined): number {
  const left = comparableStoryTime(current);
  const right = comparableStoryTime(next);
  if (!left || !right || left.scale !== "calendar" || right.scale !== "calendar" || right.min <= left.min) return 0;
  return right.min - left.min;
}

function calendarInterval(value: string, declaredPrecision?: "second" | "minute" | "hour" | "day" | "month" | "year"): ComparableStoryTime | undefined {
  const normalized = value.normalize("NFKC").trim();
  const decade = normalized.match(/(?:^|\D)(\d{3,4})s(?:\D|$)/i);
  if (decade) {
    const start = Date.UTC(Number(decade[1]), 0, 1) / MILLISECONDS_PER_DAY;
    const end = Date.UTC(Number(decade[1]) + 10, 0, 1) / MILLISECONDS_PER_DAY;
    return { scale: "calendar", min: start, max: end - CALENDAR_EPSILON_DAYS };
  }
  const parsed = parseCalendarValue(normalized);
  if (!parsed) return undefined;
  const precision = declaredPrecision ?? parsed.precision;
  const start = calendarTimestamp(parsed) / MILLISECONDS_PER_DAY;
  const next = addCalendarUnit(parsed, precision, 1);
  return {
    scale: "calendar",
    min: start,
    max: calendarTimestamp(next) / MILLISECONDS_PER_DAY - CALENDAR_EPSILON_DAYS,
  };
}

type CalendarPrecision = "second" | "minute" | "hour" | "day" | "month" | "year";
type CalendarParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  precision: CalendarPrecision;
};

function parseCalendarValue(value: string): CalendarParts | undefined {
  const match = value.match(/(?:^|\D)(\d{3,4})(?:[-/.年](\d{1,2}))?(?:[-/.月](\d{1,2}))?(?:日)?/);
  if (!match) return undefined;
  const time = value.slice((match.index ?? 0) + match[0].length).match(/^[T\s]*(\d{1,2})(?::|时)(\d{1,2})?(?::|分)?(\d{1,2})?/);
  const year = Number(match[1]);
  const month = Number(match[2] ?? 1);
  const day = Number(match[3] ?? 1);
  const hour = Number(time?.[1] ?? 0);
  const minute = Number(time?.[2] ?? 0);
  const second = Number(time?.[3] ?? 0);
  const precision: CalendarPrecision = time?.[3] !== undefined
    ? "second"
    : time?.[2] !== undefined
      ? "minute"
      : time?.[1] !== undefined
        ? "hour"
        : match[3] !== undefined
          ? "day"
          : match[2] !== undefined
            ? "month"
            : "year";
  const parts = { year, month, day, hour, minute, second, precision };
  const date = new Date(calendarTimestamp(parts));
  if (date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second) return undefined;
  return parts;
}

function shiftCalendarValue(value: string, advance: TimeAdvance, declaredPrecision?: CalendarPrecision): string | undefined {
  if (/\d{3,4}s(?:\D|$)/i.test(value)) return undefined;
  const parsed = parseCalendarValue(value.normalize("NFKC").trim());
  if (!parsed) return undefined;
  const precision = declaredPrecision ?? parsed.precision;
  let shifted: CalendarParts;
  if ((advance.unit === "year" || advance.unit === "month") && Number.isInteger(advance.amount)) {
    shifted = addCalendarUnit(parsed, advance.unit, advance.amount);
  } else {
    const date = new Date(calendarTimestamp(parsed) + timeAdvanceInDays(advance) * MILLISECONDS_PER_DAY);
    shifted = {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds(),
      precision,
    };
  }
  return formatCalendarValue(shifted, precision);
}

function addCalendarUnit(parts: CalendarParts, unit: CalendarPrecision | "year" | "month", amount: number): CalendarParts {
  if (unit === "year" || unit === "month") {
    const totalMonths = parts.year * 12 + (parts.month - 1)
      + (unit === "year" ? amount * 12 : amount);
    const year = Math.floor(totalMonths / 12);
    const month = totalMonths - year * 12 + 1;
    return {
      ...parts,
      year,
      month,
      day: Math.min(parts.day, daysInMonth(year, month)),
    };
  }
  const unitDays: Record<Exclude<CalendarPrecision, "year" | "month">, number> = {
    day: 1,
    hour: 1 / 24,
    minute: 1 / (24 * 60),
    second: 1 / (24 * 60 * 60),
  };
  const date = new Date(calendarTimestamp(parts) + amount * unitDays[unit] * MILLISECONDS_PER_DAY);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    precision: parts.precision,
  };
}

function calendarTimestamp(parts: Omit<CalendarParts, "precision"> | CalendarParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatCalendarValue(parts: CalendarParts, precision: CalendarPrecision): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  const year = pad(parts.year, 4);
  if (precision === "year") return year;
  const month = `${year}-${pad(parts.month)}`;
  if (precision === "month") return month;
  const day = `${month}-${pad(parts.day)}`;
  if (precision === "day") return day;
  const hour = `${day}T${pad(parts.hour)}`;
  if (precision === "hour") return `${hour}:00Z`;
  const minute = `${hour}:${pad(parts.minute)}`;
  if (precision === "minute") return `${minute}Z`;
  return `${minute}:${pad(parts.second)}Z`;
}
