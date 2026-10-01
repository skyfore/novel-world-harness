import { contentHash } from '../world/canonical.js';
import { roleReviewSourcePacket } from './role-review-context.js';
import { roleWorkStop, type RoleSourceWork } from './role-review-work.js';
type Unit = { id: string; anchor: { startByte: number; endByte: number } };
type Span = { start: number; end: number };
/** Deterministic partition, including overlap at every split. No text is dropped
 * and child sessions never acquire independent identities or budgets. */
export function roleSourceParts(bytes: Buffer, units: readonly Unit[], ranges: readonly Span[], maxBytes = 8500) {
  const split = (span: Span): Span[] => {
    if (Buffer.byteLength(JSON.stringify(roleReviewSourcePacket(bytes, units, span))) <= maxBytes) return [span];
    let mid = Math.floor((span.start + span.end) / 2);
    while (mid > span.start && (bytes[mid]! & 0xc0) === 0x80) mid--;
    if (mid <= span.start) throw roleWorkStop('one evidence fragment cannot fit a partition');
    return [...split({ start: span.start, end: mid }), ...split({ start: mid, end: span.end })];
  };
  const spans = ranges.flatMap(split);
  if (spans.length > 4) throw roleWorkStop('source partition needs more than four evidence sessions; retain parent scope and remaining budget');
  return spans.map((span, index) => {
    // Previous tail lets Pi explicitly inspect crossings, not just independent shards.
    let start = Math.max(ranges.find(r => r.start <= span.start && r.end >= span.end)!.start, span.start - 192);
    while (start < span.start && (bytes[start]! & 0xc0) === 0x80) start++;
    const packet = roleReviewSourcePacket(bytes, units, { start, end: span.end });
    return { index, assignedSpan: span, packet, packetHash: contentHash(packet) };
  });
}
export function assertSourcePartIntegration(parts: readonly RoleSourceWork[], parent: RoleSourceWork, coreIds: ReadonlySet<string>) {
  const questions = parts.flatMap(p => p.openQuestions);
  // Slot count and exact order preserve the same question IDs on ledger replay.
  if (parent.openQuestions.length !== questions.length || questions.some((q, i) => parent.openQuestions[i] !== q)) throw Error('Keep every part open question verbatim and in order. These questions remain unresolved for the later source audit; do not silently resolve or drop them. Correct once under the same parent work.');
  for (const finding of parts.flatMap(p => p.findings)) {
    const refs = finding.unitIds.filter(id => coreIds.has(id));
    if (refs.length && !parent.findings.some(f => f.name === finding.name && refs.every(id => f.unitIds.includes(id)))) throw Error('Every part finding about the assigned core must remain represented by name and original core references. Correct once; never drop a part responsibility.');
  }
}
