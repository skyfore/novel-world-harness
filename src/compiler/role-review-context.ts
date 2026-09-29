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

/** Admission reserves space for instructions/tools. Missing decisive evidence stays
 * explicit and must be read before any judgment can pass the work's read gate. */
export function roleEvidencePacket(bytes: Buffer, units: readonly Unit[], requiredRefs: readonly string[], backgroundRefs: readonly string[] = [], maxBytes = 12_000) {
  const required = [...new Set(requiredRefs)], background = [...new Set(backgroundRefs)].filter(id => !required.includes(id));
  const evidence: Array<{unitId: string; category: "required" | "background"; text: string}> = [];
  const omittedRefs: Array<{unitId: string; category: "required" | "background"; omitReason: "requires-paginated-read"}> = [];
  for (const [category, refs] of [["required", required], ["background", background]] as const) {
    for (const unitId of refs) {
      const unit = units.find(u => u.id === unitId);
      if (!unit) throw new Error("ROLE_REVIEW_WORK_HOST_REQUIRED: evidence packet contains a foreign unit. Stop; inspect the original work references, never guess or retry unchanged.");
      const item = {unitId, category, text: bytes.subarray(unit.anchor.startByte, unit.anchor.endByte).toString("utf8")};
      if (Buffer.byteLength(JSON.stringify([...evidence, item])) <= maxBytes) evidence.push(item);
      else omittedRefs.push({unitId, category, omitReason: "requires-paginated-read"});
    }
  }
  return { evidence, manifest: {includedRefs: evidence.map(e => e.unitId), omittedRefs,
    requiredButMissing: omittedRefs.filter(e => e.category === "required").map(e => e.unitId),
    guidance: "Omission is a context boundary, never proof of irrelevance. Read requiredButMissing using read_role_work_evidence and every nextOffset before submission. Browse the independent atlas for known counterevidence outside this packet."} };
}
