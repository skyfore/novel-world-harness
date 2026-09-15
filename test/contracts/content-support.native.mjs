import test from 'node:test';
import assert from 'node:assert/strict';
import { assessQuotationContentSupport as assess } from '../../src/compiler/content-support.ts';

const span = (startByte = 0, endByte = 10, sourceId = 'source') => ({ sourceId, startByte, endByte });
const evidence = (jsonPointer, anchors = [span()], extra = {}) => ({
  target: { artifactKind: 'proposition', artifactId: 'p', jsonPointer },
  relation: 'supports', anchors, ...extra,
});
const quote = [span(0, 10)];

test('kind evidence cannot mask value outside quotation', () => {
  const bad = evidence('/object/value', [span(20, 30)]);
  assert.equal(assess('p', [bad], quote).status, 'unsupported');
  assert.equal(assess('p', [bad, evidence('/object/kind')], quote).status, 'unsupported');
});
test('discriminator-only and absent evidence stay unverified', () => {
  for (const assertions of [[], [evidence('/object/kind')], [evidence('/subjectEntityId')]]) {
    assert.equal(assess('p', assertions, quote).status, 'unverified');
  }
});
test('different expressions may supply alternative evidence for one content field', () => {
  assert.equal(assess('p', [evidence('/object/value', [span(20, 30)]), evidence('/object/value')], quote).status, 'supported');
});
test('all anchors in one assertion are conjunctive', () => {
  assert.equal(assess('p', [evidence('/object/value', [span(), span(20, 30)])], quote).status, 'unsupported');
});
test('multiple cited fragments cover separate anchors without inventing intervening text', () => {
  const quotes = [span(0, 10), span(20, 30)];
  assert.equal(assess('p', [evidence('/object/value', quotes)], quotes).status, 'supported');
  assert.equal(assess('p', [evidence('/object/value', [span(5, 25)])], quotes).status, 'unsupported');
});
test('whole-object evidence can support the complete object', () => {
  assert.equal(assess('p', [evidence('/object'), evidence('/object/value', [span(20, 30)])], quote).status, 'supported');
});
test('every distinct content path needs its own support unless whole-object proof exists', () => {
  const result = assess('p', [evidence('/object/value'), evidence('/object/entityId', [span(20, 30)])], quote);
  assert.deepEqual(result.supportedPaths, ['/object/value']);
  assert.deepEqual(result.missingPaths, ['/object/entityId']);
  assert.equal(result.status, 'unsupported');
});
test('wrong proposition, artifact kind and relation cannot support content', () => {
  const wrong = [
    evidence('/object/value', [span()], { target: { artifactKind: 'proposition', artifactId: 'q', jsonPointer: '/object/value' } }),
    evidence('/object/value', [span()], { target: { artifactKind: 'entity', artifactId: 'p', jsonPointer: '/object/value' } }),
    evidence('/object/value', [span()], { relation: 'contextualizes' }),
  ];
  assert.equal(assess('p', wrong, quote).status, 'unverified');
});
test('source identity matters even with identical offsets', () => {
  assert.equal(assess('p', [evidence('/object/value', [span(0, 10, 'other')])], quote).status, 'unsupported');
});
test('invalid, empty and zero-length anchors fail closed', () => {
  for (const anchors of [[], [span(2, 2)], [span(-1, 5)], [span(0, Infinity)], [span(0.5, 3)]]) {
    assert.equal(assess('p', [evidence('/object/value', anchors)], quote).status, 'unsupported');
  }
});
test('invalid cited span is not authority', () => {
  assert.equal(assess('p', [evidence('/object/value')], [span(-1, 20)]).status, 'unsupported');
});
test('half-open exact containment admits boundaries, not partial overlap', () => {
  assert.equal(assess('p', [evidence('/object/value')], quote).status, 'supported');
  for (const outside of [span(9, 11), span(10, 11)]) {
    assert.equal(assess('p', [evidence('/object/value', [outside])], quote).status, 'unsupported');
  }
});
test('all current semantic object variants work without metadata laundering', () => {
  for (const pointer of ['/object/value', '/object/entityId', '/object/propositionId']) {
    assert.equal(assess('p', [evidence(pointer)], quote).status, 'supported');
  }
});
test('assertion order and uniform offset translation do not change the answer', () => {
  for (let shift = 0; shift < 50; shift++) {
    const good = evidence('/object/value', [span(shift, shift + 10)]);
    const bad = evidence('/object/value', [span(shift + 20, shift + 30)]);
    const q = [span(shift, shift + 10)];
    assert.deepEqual(assess('p', [good, bad], q), assess('p', [bad, good], q));
  }
});
test('does not mutate input assertions or source ranges', () => {
  const input = [evidence('/object/value')];
  const before = structuredClone(input);
  assess('p', input, quote);
  assert.deepEqual(input, before);
});
