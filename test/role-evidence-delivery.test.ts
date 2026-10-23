import { it, expect } from 'vitest';
import { RoleEvidenceDelivery } from '../src/compiler/role-evidence-delivery.js';
import { roleSourceParts, assertSourcePartIntegration } from '../src/compiler/role-source-parts.js';
import { roleAuditSourcePacket } from '../src/compiler/role-review-context.js';
it('includes a trailing tab as boundary context and leaves large originals explicitly unread',()=>{
  const bytes=Buffer.from('龙接上鼠标。\r\n\t'),units=[{id:'boundary',anchor:{startByte:0,endByte:bytes.length}}],core={start:0,end:bytes.length-1};
  const packet=roleAuditSourcePacket(bytes,units,core);
  expect(packet.core).toEqual(core);
  expect(packet.fragments[0]).toMatchObject({continued:true,text:bytes.subarray(0,-1).toString()});
  expect(packet.boundaryContext.evidence[0]?.text).toBe(bytes.toString());
  const large=roleAuditSourcePacket(bytes,units,core,1);
  expect(large.boundaryContext.evidence).toEqual([]);
  expect(large.boundaryContext.manifest.requiredButMissing).toEqual(['boundary']);
});
it('returns only missing UTF-8 ranges and locates already delivered originals', () => {
  const bytes = Buffer.from('龙😀甲乙丙丁'), unit = { id: 'u', anchor: { startByte: 0, endByte: bytes.length } }, delivery = new RoleEvidenceDelivery(bytes, [unit]);
  delivery.seedSpan({ start: 0, end: Buffer.byteLength('龙😀') }, 'initial packet');
  expect(delivery.complete('u')).toBe(false);
  const next = delivery.read(unit, 0, 'read-1'); expect(next).toMatchObject({ text: '甲乙丙丁', startOffset: 2, endOffset: 6 });
  expect(delivery.complete('u')).toBe(true);
  expect(delivery.read(unit, 0, 'read-2')).toMatchObject({ alreadyDeliveredInCurrentContext: true, locations: ['initial packet', 'read-1'] });
  delivery.clear(); expect(delivery.complete('u')).toBe(false);
});
it('does not turn an out-of-order read or a partial range into full evidence', () => {
  const bytes = Buffer.from('龙'.repeat(9000)), unit = { id: 'u', anchor: { startByte: 0, endByte: bytes.length } }, delivery = new RoleEvidenceDelivery(bytes, [unit]);
  expect(delivery.read(unit, 5000, 'late')).toMatchObject({ startOffset: 5000, endOffset: 9000, nextOffset: 0 });
  expect(delivery.complete('u')).toBe(false);
  expect(delivery.read(unit, 0, 'start')).toMatchObject({ startOffset: 0, endOffset: 4000, nextOffset: 4000 });
  expect(delivery.read(unit, 0, 'middle')).toMatchObject({ startOffset: 4000, endOffset: 5000 });
  expect(delivery.complete('u')).toBe(true);
});
it('partitions all original bytes with boundary overlap without changing parent scope', () => {
  const bytes = Buffer.from('龙😀'.repeat(2000)), units = [{ id: 'u', anchor: { startByte: 0, endByte: bytes.length } }];
  const parts = roleSourceParts(bytes, units, [{ start: 0, end: bytes.length }]);
  expect(parts.length).toBeGreaterThan(1);
  expect(Buffer.concat(parts.map(p => bytes.subarray(p.assignedSpan.start, p.assignedSpan.end)))).toEqual(bytes);
  expect(parts[1]!.packet.core.start).toBeLessThan(parts[1]!.assignedSpan.start);
  for (const p of parts) expect(p.packet.fragments.map(f => f.text).join('')).not.toContain('�');
  expect(() => roleSourceParts(Buffer.from('x'.repeat(100000)), [], [{ start: 0, end: 100000 }])).toThrow('more than four');
});
it('integration cannot erase questions or findings from completed evidence parts', () => {
  const part = { summary: 's', findings: [{ name: 'Hero', observation: 'o', unitIds: ['core'] }], openQuestions: ['Who?'] };
  expect(() => assertSourcePartIntegration([part], { ...part, openQuestions: [] }, new Set(['core']))).toThrow('every part open question');
  expect(() => assertSourcePartIntegration([part], { ...part, findings: [] }, new Set(['core']))).toThrow('Every part finding');
  expect(() => assertSourcePartIntegration([part], part, new Set(['core']))).not.toThrow();
});
