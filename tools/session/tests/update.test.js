'use strict';
/**
 * update.test.js — table-driven applyUpdate + trimNonEditable (DoD row 7).
 *
 * Uses a session-shaped editable table (as P03 will hand in) to prove the GENERIC layer:
 *  - applyUpdate sets editable REPLACE fields only; string[] fields normalise a bare
 *    string; MECHANICAL fields in the patch are IGNORED (not an error, not persisted);
 *    array-element ("log[].what") keys are ignored by the generic layer; unknown keys and
 *    untouched branches are preserved; the input record is not mutated.
 *  - trimNonEditable projects the record down to only its scalar/array editable set.
 *
 * Run: node tests/update.test.js
 */
const { assert, test, done } = require('./helpers/harness');
const { applyUpdate, trimNonEditable } = require('../../lib/update');

// A representative editable table (subset of the LOCKED session table, build-plan §2).
const EDITABLE_TABLE = {
  'handoff.where': { edit: 'replace', type: 'string' },
  'handoff.next': { edit: 'replace', type: 'string' },
  'handoff.in_flight': { edit: 'replace', type: 'string[]' },
  'handoff.must_not_redo': { edit: 'replace', type: 'string[]' },
  'log[].what': { edit: 'append', type: 'string' },      // array-element -> generic layer ignores
  'punchlist[].text': { edit: 'add', type: 'string' },   // array-element -> generic layer ignores
};

function baseRecord() {
  return {
    schemaVersion: '1.0.0',
    kind: 'session',
    session: { number: '0021', openedAt: '2026-09-19T08:00:00-07:00' },
    handoff: { where: 'old', next: 'old', in_flight: [], must_not_redo: [], updatedAt: 'x' },
    unknownFutureKey: 'preserve-me',
  };
}

test('applyUpdate sets editable replace fields only', () => {
  const out = applyUpdate(baseRecord(), { 'handoff.where': 'new-where', 'handoff.next': 'new-next' }, { editableTable: EDITABLE_TABLE });
  assert.strictEqual(out.handoff.where, 'new-where');
  assert.strictEqual(out.handoff.next, 'new-next');
});

test('a bare string for a string[] field normalises to a length-1 array', () => {
  const out = applyUpdate(baseRecord(), { 'handoff.in_flight': 'just-one' }, { editableTable: EDITABLE_TABLE });
  assert.deepStrictEqual(out.handoff.in_flight, ['just-one']);
});

test('mechanical fields in the patch are IGNORED (not persisted, not an error)', () => {
  const out = applyUpdate(baseRecord(), {
    'session.number': '9999',            // mechanical -> ignored
    'handoff.updatedAt': 'hacked',       // mechanical -> ignored
    'handoff.where': 'legit',            // editable -> applied
  }, { editableTable: EDITABLE_TABLE });
  assert.strictEqual(out.session.number, '0021', 'mechanical number untouched');
  assert.strictEqual(out.handoff.updatedAt, 'x', 'mechanical updatedAt untouched');
  assert.strictEqual(out.handoff.where, 'legit', 'editable field applied');
});

test('array-element editable keys are ignored by the generic layer', () => {
  const out = applyUpdate(baseRecord(), { 'log[].what': 'should-not-apply-here' }, { editableTable: EDITABLE_TABLE });
  assert.ok(!('log[].what' in out), 'no literal bracket key leaks in');
  assert.deepStrictEqual(out.log, undefined, 'generic layer does not touch the log array');
});

test('unknown keys and untouched branches are preserved; input not mutated', () => {
  const input = baseRecord();
  const out = applyUpdate(input, { 'handoff.where': 'changed' }, { editableTable: EDITABLE_TABLE });
  assert.strictEqual(out.unknownFutureKey, 'preserve-me', 'unknown key preserved');
  assert.strictEqual(out.session.openedAt, '2026-09-19T08:00:00-07:00', 'untouched branch preserved');
  assert.strictEqual(input.handoff.where, 'old', 'input record was not mutated');
});

test('trimNonEditable projects down to the scalar/array editable set only', () => {
  const rec = baseRecord();
  rec.handoff.where = 'W';
  rec.handoff.next = 'N';
  rec.handoff.in_flight = ['a'];
  rec.handoff.must_not_redo = ['b', 'c'];
  const thin = trimNonEditable(rec, { editableTable: EDITABLE_TABLE });
  assert.deepStrictEqual(thin, {
    handoff: { where: 'W', next: 'N', in_flight: ['a'], must_not_redo: ['b', 'c'] },
  });
  assert.ok(!('session' in thin), 'mechanical blocks dropped');
  assert.ok(!('unknownFutureKey' in thin), 'non-editable keys dropped');
});

done('update.test');
