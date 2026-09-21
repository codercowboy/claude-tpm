'use strict';
/**
 * export-scaffold.test.js — kind-agnostic filter/combine/dispatch (build-plan §base-lib).
 *
 * Covers: selectRecords (predicate + result-set + passthrough), combine (one-file /
 * per-file), dispatch json (single bare envelope / multi bare ARRAY per Q4) and human
 * (single / multi with the injected converter, full render repeated).
 *
 * Run: node tests/export-scaffold.test.js
 */
const { assert, test, done, throwsMatching } = require('./helpers/harness');
const scaffold = require('../../lib/export-scaffold');

const recs = [
  { schemaVersion: '1.0.0', kind: 'session', session: { number: '0001' } },
  { schemaVersion: '1.0.0', kind: 'session', session: { number: '0002' } },
  { schemaVersion: '1.0.0', kind: 'session', session: { number: '0003' } },
];

test('selectRecords passthrough returns a copy of all', () => {
  const out = scaffold.selectRecords(recs, {});
  assert.strictEqual(out.length, 3);
  assert.notStrictEqual(out, recs, 'a new array');
});

test('selectRecords with a predicate filters', () => {
  const out = scaffold.selectRecords(recs, { filter: (r) => r.session.number !== '0002' });
  assert.deepStrictEqual(out.map((r) => r.session.number), ['0001', '0003']);
});

test('selectRecords with a #1092-style result-set composes (no re-matching)', () => {
  const resultSet = [recs[0], recs[2]];
  const out = scaffold.selectRecords(recs, { filter: resultSet });
  assert.deepStrictEqual(out.map((r) => r.session.number), ['0001', '0003']);
});

test('combine one-file groups all into one unit; per-file splits', () => {
  assert.strictEqual(scaffold.combine(recs, { mode: 'one-file' }).length, 1);
  assert.strictEqual(scaffold.combine(recs, { mode: 'one-file' })[0].length, 3);
  const per = scaffold.combine(recs, { mode: 'per-file' });
  assert.strictEqual(per.length, 3);
  assert.strictEqual(per[0].length, 1);
});

test('combine rejects an unknown mode (fail-loud)', () => {
  throwsMatching(() => scaffold.combine(recs, { mode: 'zip' }), /unknown mode/);
});

test('dispatch json: single group -> bare envelope', () => {
  const out = scaffold.dispatch([recs[0]], { style: 'json', nameFor: (r) => `session-${r.session.number}` });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].suggestedName, 'session-0001.json');
  const parsed = JSON.parse(out[0].body);
  assert.strictEqual(parsed.kind, 'session', 'a bare envelope, not an array');
});

test('dispatch json: multi group -> a bare ARRAY of envelopes (Q4)', () => {
  const out = scaffold.dispatch(recs, { style: 'json', combinedName: 'last-3' });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].suggestedName, 'last-3.json');
  const parsed = JSON.parse(out[0].body);
  assert.ok(Array.isArray(parsed), 'combined JSON is a bare array');
  assert.strictEqual(parsed.length, 3);
});

test('dispatch human: uses the injected converter; multi repeats the full render', () => {
  const converter = (r) => `# Session ${r.session.number}`;
  const single = scaffold.dispatch([recs[1]], { style: 'human', converter, nameFor: (r) => `session-${r.session.number}` });
  assert.strictEqual(single[0].suggestedName, 'session-0002.md');
  assert.strictEqual(single[0].body, '# Session 0002');

  const multi = scaffold.dispatch(recs, { style: 'human', converter, combinedName: 'last-3' });
  assert.strictEqual(multi[0].suggestedName, 'last-3.md');
  assert.strictEqual(multi[0].body, '# Session 0001\n\n# Session 0002\n\n# Session 0003');
});

test('dispatch human without a converter fails loud', () => {
  throwsMatching(() => scaffold.dispatch(recs, { style: 'human' }), /requires a converter/);
});

test('dispatch rejects an unknown style', () => {
  throwsMatching(() => scaffold.dispatch(recs, { style: 'xml' }), /unknown style/);
});

done('export-scaffold.test');
