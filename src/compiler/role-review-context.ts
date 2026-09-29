import { roleReviewSpans } from "./role-review-work.js";
type Unit = { id: string; anchor: { startByte: number; endByte: number } };
type Span = { start: number; end: number };
/** Pure context assembly: gap text is retained exactly once, long IDs count toward size. */
export function roleReviewSourcePacket(bytes: Buffer, units: readonly Unit[], span: Span) {
  const fragments: Array<{ unitId: string | null; text: string; continued: boolean }> = [];
  let cursor = span.start;
  for (const unit of units.filter(u => u.anchor.startByte < span.end && u.anchor.endByte > span.start)) {
    const start = Math.max(span.start, unit.anchor.startByte), end = Math.min(span.end, unit.anchor.endByte);
    if (start > cursor) fragments.push({ unitId: null, text: bytes.subarray(cursor, start).toString("utf8"), continued: false });
    fragments.push({ unitId: unit.id, text: bytes.subarray(start, end).toString("utf8"), continued: start > unit.anchor.startByte || end < unit.anchor.endByte });
    cursor = end;
  }
  if (cursor < span.end) fragments.push({ unitId: null, text: bytes.subarray(cursor, span.end).toString("utf8"), continued: false });
  return { core: span, fragments };
}
export function boundedRoleReviewSpans(bytes: Buffer, units: readonly Unit[]) {
  const split = (span: Span): Span[] => {
    if (Buffer.byteLength(JSON.stringify(roleReviewSourcePacket(bytes, units, span))) <= 16_000) return [span];
    let middle = Math.floor((span.start + span.end) / 2);
    while (middle > span.start && (bytes[middle]! & 0xc0) === 0x80) middle--;
    if (middle <= span.start) throw new Error("ROLE_REVIEW_WORK_HOST_REQUIRED: source metadata cannot fit one bounded packet. Stop; inspect source structure, never truncate evidence or retry unchanged.");
    return [...split({ start: span.start, end: middle }), ...split({ start: middle, end: span.end })];
  };
  return roleReviewSpans(bytes).flatMap(split);
}
