import test from 'node:test';
import assert from 'node:assert/strict';
import { assessSemanticRequirements as assess, planRequirementRepairs as plan } from '../../src/compiler/semantic-requirements.ts';

const context = { sourceId: 'source', sourceSha256: 'a'.repeat(64), specHash: 'b'.repeat(64), catalogHash: 'c'.repeat(64), evaluatorVersion: 'test-v1' };
const requirement = (id = 'r', changes = {}) => ({ id, sourceId: 'source', targetRef: 'event:e', capability: id,
  stage: 'semantic', expectation: { kind: 'check', description: 'Independent requirement' }, evidenceRefs: ['anchor:one'], dependsOn: [], ...changes });
const observation = (id = 'r', changes = {}) => ({ requirementId: id, context: { ...context }, state: 'satisfied', diagnostics: [], ...changes });

test('all current independent requirements must succeed', () => {
  assert.equal(assess([requirement()], [observation()], context).complete, true);
});
test('an empty requirement set is not certified', () => {
  assert.equal(assess([], [], context).complete, false);
});
test('missing observation stays unknown rather than disappearing', () => {
  const result = assess([requirement('one'), requirement('two')], [observation('one')], context);
  assert.equal(result.complete, false);
  assert.equal(result.requirements.find(r => r.id === 'one').state, 'satisfied');
  assert.equal(result.requirements.find(r => r.id === 'two').state, 'unknown');
});
test('same target can retain several independent obligations', () => {
  const result = assess([requirement('state'), requirement('knowledge')], [observation('state'), observation('knowledge', { state: 'blocked' })], context);
  assert.equal(result.requirements.length, 2);
  assert.equal(result.complete, false);
});
test('proposed is not a valid verification state', () => {
  assert.throws(() => assess([requirement()], [observation('r', { state: 'proposed' })], context), /Invalid observation state/);
});
test('unmapped source concept survives an attempted satisfied relabel', () => {
  const source = requirement('r', { expectation: { kind: 'unmapped', concept: 'temporary incapacity', affectedEntityIds: ['a'] } });
  const result = assess([source], [observation()], context);
  assert.equal(result.requirements[0].state, 'unmapped');
  assert.equal(result.requirements[0].expectation.concept, 'temporary incapacity');
  assert.equal(result.complete, false);
});
test('an independently specified no-change requirement may pass', () => {
  const result = assess([requirement('r', { expectation: { kind: 'no-change', justification: 'Independent review found no change' } })], [observation()], context);
  assert.equal(result.complete, true);
  assert.equal(result.requirements[0].expectation.kind, 'no-change');
});
for (const key of ['sourceSha256', 'specHash', 'catalogHash', 'evaluatorVersion']) {
  test(`changed ${key} invalidates an earlier result`, () => {
    const value = key === 'evaluatorVersion' ? 'other-v2' : 'd'.repeat(64);
    const result = assess([requirement()], [observation('r', { context: { ...context, [key]: value } })], context);
    assert.equal(result.requirements[0].state, 'stale');
    assert.equal(result.complete, false);
  });
}
test('foreign source definition or result is rejected', () => {
  assert.throws(() => assess([requirement('r', { sourceId: 'other' })], [], context), /foreign source/);
  assert.throws(() => assess([requirement()], [observation('r', { context: { ...context, sourceId: 'other' } })], context), /Foreign observation/);
});
test('duplicate definitions and duplicate results never use last-write-wins', () => {
  assert.throws(() => assess([requirement(), requirement()], [], context), /Duplicate requirement/);
  assert.throws(() => assess([requirement()], [observation(), observation()], context), /Duplicate observation/);
});
test('unknown result identity is rejected', () => {
  assert.throws(() => assess([requirement()], [observation('other')], context), /Unknown observation/);
});
test('unknown dependency is rejected', () => {
  assert.throws(() => assess([requirement('r', { dependsOn: ['missing'] })], [], context), /Unknown dependency/);
});
test('self-cycle and multi-node dependency cycle are rejected', () => {
  assert.throws(() => assess([requirement('r', { dependsOn: ['r'] })], [], context), /cycle/);
  assert.throws(() => assess([requirement('a', { dependsOn: ['b'] }), requirement('b', { dependsOn: ['a'] })], [], context), /cycle/);
});
test('input order does not alter topological evaluation', () => {
  const defs = [requirement('b', { dependsOn: ['a'] }), requirement('a')];
  const obs = [observation('b'), observation('a')];
  assert.deepEqual(assess(defs, obs, context), assess([...defs].reverse(), [...obs].reverse(), context));
});
test('unsatisfied dependencies block transitive success without losing own result', () => {
  const result = assess([requirement('a'), requirement('b', { dependsOn: ['a'] }), requirement('c', { dependsOn: ['b'] })],
    [observation('a', { state: 'blocked' }), observation('b'), observation('c')], context);
  assert.deepEqual(result.requirements.map(r => r.state), ['blocked', 'blocked', 'blocked']);
  assert.equal(result.requirements[1].ownState, 'satisfied');
});
test('diagnostics cannot accompany a satisfied verification', () => {
  assert.equal(assess([requirement()], [observation('r', { diagnostics: ['Trace missing'] })], context).requirements[0].state, 'blocked');
});
test('malformed fingerprints are rejected', () => {
  assert.throws(() => assess([requirement()], [], { ...context, specHash: 'invalid' }), /Invalid requirement specHash/);
});
test('missing or duplicate evidence and duplicate dependencies are rejected', () => {
  for (const changes of [{ evidenceRefs: [] }, { evidenceRefs: ['a', 'a'] }, { dependsOn: ['r', 'r'] }]) {
    assert.throws(() => assess([requirement('r', changes)], [], context));
  }
});
test('expectation and all output objects are copied, not mutated in place', () => {
  const defs = [requirement('r', { expectation: { kind: 'check', nested: { value: 1 } } })];
  const snapshot = structuredClone(defs);
  const result = assess(defs, [observation()], context);
  result.requirements[0].expectation.nested.value = 2;
  result.context.specHash = 'd'.repeat(64);
  assert.deepEqual(defs, snapshot);
  assert.equal(context.specHash, 'b'.repeat(64));
});
test('repair output grants no execution or world-writing authority', () => {
  const result = plan(assess([requirement()], [], context));
  assert.equal(result.authority, 'diagnostic-only');
  assert.equal(result.tasks[0].requiresHostAuthorization, true);
  assert.equal(result.tasks[0].action, 'source-grounded-review');
});
test('bounded plans preserve all omitted requirement identities', () => {
  const result = plan(assess([requirement('c'), requirement('a'), requirement('b')], [], context), 1);
  assert.deepEqual(result.tasks.map(t => t.requirementId), ['a']);
  assert.deepEqual(result.remainingRequirementIds, ['b', 'c']);
});
test('invalid repair limits are rejected rather than silently coerced', () => {
  const result = assess([requirement()], [], context);
  for (const limit of [0, -1, 129, 1.5, NaN, Infinity]) assert.throws(() => plan(result, limit), /Repair limit/);
});
test('unmapped requirement requests ontology design rather than fabricating a field', () => {
  const result = plan(assess([requirement('r', { expectation: { kind: 'unmapped', concept: 'unknown dimension' } })], [], context));
  assert.equal(result.tasks[0].stage, 'ontology');
  assert.equal(result.tasks[0].action, 'host-design-review');
});
test('stale evidence requests reevaluation, not a semantic rewrite', () => {
  const result = plan(assess([requirement()], [observation('r', { context: { ...context, catalogHash: 'd'.repeat(64) } })], context));
  assert.equal(result.tasks[0].action, 'reevaluate');
});
test('dependent successes need revalidation after upstream repair', () => {
  const result = plan(assess([requirement('a'), requirement('b', { dependsOn: ['a'] })], [observation('b')], context));
  assert.deepEqual(result.tasks.map(t => t.requirementId), ['a', 'b']);
  assert.equal(result.tasks[1].action, 'revalidate-after-dependencies');
  assert.equal(result.tasks[1].readyForHostReview, false);
  assert.deepEqual(result.tasks[1].blockedBy, ['a']);
});
test('satisfied requirements are omitted from repairs, not from assessment', () => {
  const assessment = assess([requirement()], [observation()], context);
  assert.equal(assessment.requirements.length, 1);
  assert.deepEqual(plan(assessment).tasks, []);
});
