type Unit = { id: string; anchor: { startByte: number; endByte: number } };
type Delivery = { start: number; end: number; location: string };
/** Current-session original text only. Offsets are Unicode code points, as in
 * read_role_work_evidence. Discovery snippets never enter this ledger. */
export class RoleEvidenceDelivery {
  private delivered = new Map<string, Delivery[]>();
  constructor(private bytes: Buffer, private units: readonly Unit[]) { }
  clear() { this.delivered.clear(); }
  seed(unitId: string, location: string) { const unit = this.units.find(u => u.id === unitId)!; this.mark(unitId, 0, Array.from(this.text(unit)).length, location); }
  seedSpan(span: { start: number; end: number }, location: string) {
    for (const u of this.units) {
      const start = Math.max(span.start, u.anchor.startByte), end = Math.min(span.end, u.anchor.endByte);
      if (start >= end) continue;
      this.mark(u.id, Array.from(this.bytes.subarray(u.anchor.startByte, start).toString('utf8')).length,
        Array.from(this.bytes.subarray(u.anchor.startByte, end).toString('utf8')).length, location);
    }
  }
  private text(unit: Unit) { return this.bytes.subarray(unit.anchor.startByte, unit.anchor.endByte).toString('utf8'); }
  private mark(id: string, start: number, end: number, location: string) { this.delivered.set(id, [...(this.delivered.get(id) ?? []), { start, end, location }]); }
  private missing(id: string, length: number, offset = 0) {
    let cursor = offset;
    for (const r of [...(this.delivered.get(id) ?? [])].sort((a, b) => a.start - b.start)) {
      if (r.end <= cursor) continue;
      if (r.start > cursor) return { start: cursor, end: Math.min(r.start, length) };
      cursor = Math.max(cursor, r.end);
    }
    return cursor < length ? { start: cursor, end: length } : undefined;
  }
  read(unit: Unit, offset: number, location: string) {
    const chars = Array.from(this.text(unit));
    if (offset >= chars.length && offset !== 0) throw Error('Invalid offset. Read this unit with offset=0 and copy nextOffset for one corrected retry.');
    const gap = this.missing(unit.id, chars.length, offset);
    if (!gap) return { unitId: unit.id, alreadyDeliveredInCurrentContext: true, locations: [...new Set((this.delivered.get(unit.id) ?? []).map(r => r.location))], ...(this.missing(unit.id, chars.length) ? { nextOffset: this.missing(unit.id, chars.length)!.start } : {}) };
    const end = Math.min(gap.end, gap.start + 4000);
    this.mark(unit.id, gap.start, end, location);
    const remaining = this.missing(unit.id, chars.length);
    return { unitId: unit.id, text: chars.slice(gap.start, end).join(''), startOffset: gap.start, endOffset: end, location, ...(remaining ? { nextOffset: remaining.start } : {}) };
  }
  complete(id: string) { const unit = this.units.find(u => u.id === id)!; return !this.missing(id, Array.from(this.text(unit)).length); }
}
