import { contentHash } from "../world/canonical.js";
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

/** Preserve core ownership while delivering complete overlapping boundary units
 * as context. Large units remain explicit paginated-read obligations. */
export function roleAuditSourcePacket(bytes: Buffer, units: readonly Unit[], span: Span, maxBoundaryBytes = 12_000) {
  const core = roleReviewSourcePacket(bytes, units, span);
  const boundaryIds = core.fragments.filter(f => f.unitId && f.continued).map(f => f.unitId!);
  return { ...core, boundaryContext: {
    ...roleEvidencePacket(bytes, units, boundaryIds, [], maxBoundaryBytes), contextOnly: true,
    guidance: "Complete boundary originals are context for this assigned core only. They never complete or expand a neighboring source work. Follow manifest.requiredButMissing with read_role_work_evidence and every nextOffset.",
  } };
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
  const evidence: Array<{ unitId: string; category: "required" | "background"; text: string }> = [];
  const omittedRefs: Array<{ unitId: string; category: "required" | "background"; omitReason: "requires-paginated-read" }> = [];
  for (const [category, refs] of [["required", required], ["background", background]] as const) {
    for (const unitId of refs) {
      const unit = units.find(u => u.id === unitId);
      if (!unit) throw new Error("ROLE_REVIEW_WORK_HOST_REQUIRED: evidence packet contains a foreign unit. Stop; inspect the original work references, never guess or retry unchanged.");
      const item = { unitId, category, text: bytes.subarray(unit.anchor.startByte, unit.anchor.endByte).toString("utf8") };
      if (Buffer.byteLength(JSON.stringify([...evidence, item])) <= maxBytes) evidence.push(item);
      else omittedRefs.push({ unitId, category, omitReason: "requires-paginated-read" });
    }
  }
  return {
    evidence, manifest: {
      includedRefs: evidence.map(e => e.unitId), omittedRefs,
      requiredButMissing: omittedRefs.filter(e => e.category === "required").map(e => e.unitId),
      guidance: "Omission is a context boundary, never proof of irrelevance. Read requiredButMissing using read_role_work_evidence and every nextOffset before submission. Browse the independent atlas for known counterevidence outside this packet."
    }
  };
}

/** Rebuild decisive text from immutable bytes, not model summaries. Core,
 * neighboring context and exact unit reads overlap: merge byte ranges first. */
export function reassembleRoleContext(bytes: Buffer, units: readonly Unit[], required: Span[], accesses: readonly { tool: string; args: Record<string, unknown>; delivered?:Array<{unitId:string;startOffset:number;endOffset:number}> }[], neighbor?: { page: number; spans: readonly Span[] }, maxBytes = 18000) {
  const ranges = [...required];
  for (const access of accesses) {
    if (access.tool === 'read_role_work_evidence' && typeof access.args.unitId === 'string') {
      const unit = units.find(u => u.id === access.args.unitId);
      if (!unit) throw new Error('ROLE_REVIEW_WORK_HOST_REQUIRED: retained context contains foreign evidence. Stop; preserve the original checkpoint.');
      const delivered=access.delivered?.find(d=>d.unitId===unit.id);
      const offset = delivered?.startOffset ?? access.args.offset ?? 0;
      if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) throw new Error('ROLE_REVIEW_WORK_HOST_REQUIRED: invalid retained evidence cursor. Stop; inspect the checkpoint.');
      const chars = Array.from(bytes.subarray(unit.anchor.startByte, unit.anchor.endByte).toString('utf8'));
      const start = unit.anchor.startByte + Buffer.byteLength(chars.slice(0, offset).join(''));
      const end = start + Buffer.byteLength(chars.slice(offset, delivered?.endOffset ?? offset + 4000).join(''));
      if (start < end) ranges.push({ start, end });
    } else if (access.tool === 'read_role_work_neighbor' && neighbor) {
      const step = access.args.direction === 'previous' ? -1 : access.args.direction === 'next' ? 1 : 0;
      const span = step ? neighbor.spans[neighbor.page + step] : undefined;
      if (span) ranges.push(span);
    }
  }
  const merged: Span[] = [];
  for (const span of ranges.sort((a, b) => a.start - b.start)) {
    if (span.start < 0 || span.end > bytes.length || span.start >= span.end) throw new Error('ROLE_REVIEW_WORK_HOST_REQUIRED: invalid context source range. Stop; preserve scope.');
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  const fragments = merged.flatMap(span => roleReviewSourcePacket(bytes, units, span).fragments);
  const deliveredUnitIds = units.filter(u => merged.some(s => s.start <= u.anchor.startByte && s.end >= u.anchor.endByte)).map(u => u.id);
  const packet = {
    ranges: merged, fragments, manifest: {
      evidenceAuthority: 'immutable-original-source', guidance: 'Text is delivered again in this context. Only the assigned core counts as reviewed; expanded ranges are context. Cite units only where their original text supports the conclusion.'
    }
  };
  const result = { ...packet, packetHash: contentHash(packet) };
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new Error('ROLE_REVIEW_WORK_HOST_REQUIRED: deduplicated decisive originals cannot fit the context packet. Stop for a narrower semantic task; do not drop evidence or substitute a summary.');
  // The host read gate needs these IDs; the model already has them on fragments.
  // Keep bookkeeping out of the serialized evidence packet.
  return { packet: result, deliveredUnitIds };
}
