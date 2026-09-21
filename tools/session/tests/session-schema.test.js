'use strict';
/**
 * session-schema.test.js — kind:"session" payload schema + editable table + registration.
 *
 * Covers (DoD): KNOWN_KINDS registers "session"; the validator ACCEPTS a well-formed record
 * (top-level siblings meta/handoff/log/punchlist) and REJECTS malformed ones; the validator
 * works through the base validateEnvelope 2-arg call (payload=record[kind]=undefined under the
 * sibling shape); lifecycle nullable handoff; the EDITABLE_TABLE is exactly the locked set;
 * MUTATION checks prove each rejection is real (the validator is not a no-op).
 *
 * Run: node tests/session-schema.test.js
 */
const { assert, test, done, throwsMatching } = require('./helpers/harness');
const { KNOWN_KINDS } = require('../../lib/envelope');
const { validateEnvelope } = require('../../lib/validate');
const schema = require('../lib/session-schema');

const TS = '2026-09-19T08:00:00-07:00';

function wellFormed() {
  return {
    schemaVersion: '1.0.0',
    kind: 'session',
    meta: {
      number: '0021',
      sessionIds: ['31569169-6609-4bcf-b90f-448f25ee98a3'],
      openedAt: TS,
      closedAt: null,
      tpmVersion: '0.1.0',
    },
    handoff: {
      where: 'mid-flight', next: 'do the thing',
      in_flight: ['a'], must_not_redo: ['b'], updatedAt: TS,
    },
    log: [
      { seq: 1, ts: TS, type: 'decision', what: 'chose X', why: 'because Y' },
      { seq: 2, ts: TS, type: 'log', status: 'NOTE', text: 'hello' },
    ],
    punchlist: [
      { id: '21.1', slug: 'h5k0gb', text: 'fix it', state: 'open', createdAt: TS,
        events: [{ ts: TS, op: 'add' }] },
    ],
  };
}

test('KNOWN_KINDS registers "session" with a validator + editable table', () => {
  assert.ok(Object.prototype.hasOwnProperty.call(KNOWN_KINDS, 'session'), 'KNOWN_KINDS has session');
  assert.strictEqual(typeof KNOWN_KINDS.session.validatePayload, 'function');
  assert.strictEqual(KNOWN_KINDS.session.editableTable, schema.EDITABLE_TABLE);
});

test('the editable table is EXACTLY the locked set (nothing more, nothing less)', () => {
  const expected = [
    'handoff.where', 'handoff.next', 'handoff.in_flight', 'handoff.must_not_redo',
    'log[].what', 'log[].why', 'log[].status', 'log[].text', 'punchlist[].text',
  ].sort();
  assert.deepStrictEqual(Object.keys(schema.EDITABLE_TABLE).sort(), expected);
  // every mechanical field is ABSENT from the table
  for (const mech of ['meta.number', 'log[].seq', 'log[].ts', 'punchlist[].slug',
    'punchlist[].id', 'punchlist[].state', 'punchlist[].createdAt', 'handoff.updatedAt']) {
    assert.ok(!(mech in schema.EDITABLE_TABLE), `${mech} must NOT be editable`);
  }
});

test('a well-formed session validates (direct call AND through validateEnvelope)', () => {
  const rec = wellFormed();
  schema.validatePayload(rec);                                   // direct
  assert.strictEqual(
    validateEnvelope(rec, { payloadValidator: schema.validatePayload, knownKinds: KNOWN_KINDS }),
    rec,
    'validateEnvelope passes the FULL record as 2nd arg so the sibling-shape validator works even though record["session"] is undefined'
  );
});

test('handoff is NULLABLE (lifecycle A3: opened-but-unsaved)', () => {
  const rec = wellFormed();
  rec.handoff = null;
  schema.validatePayload(rec);           // must NOT throw
  delete rec.handoff;
  schema.validatePayload(rec);           // absent is also fine
});

test('empty log/punchlist arrays are valid defaults', () => {
  const rec = wellFormed();
  rec.log = [];
  rec.punchlist = [];
  schema.validatePayload(rec);
});

// ── MUTATION checks: each rejection is real ──────────────────────────────────

test('missing meta block is rejected', () => {
  const rec = wellFormed(); delete rec.meta;
  throwsMatching(() => schema.validatePayload(rec), /meta block is required/);
});

test('a bare/Z (non-offset) timestamp is rejected', () => {
  const rec = wellFormed(); rec.meta.openedAt = '2026-09-19T08:00:00Z';
  throwsMatching(() => schema.validatePayload(rec), /openedAt.*ISO-8601/);
});

test('handoff present but where empty is rejected', () => {
  const rec = wellFormed(); rec.handoff.where = '';
  throwsMatching(() => schema.validatePayload(rec), /handoff\.where/);
});

test('non-monotonic log seq is rejected (seq is the order authority)', () => {
  const rec = wellFormed(); rec.log[1].seq = 1;   // duplicate of log[0]
  throwsMatching(() => schema.validatePayload(rec), /strictly increasing/);
});

test('a bad log type is rejected', () => {
  const rec = wellFormed(); rec.log[0].type = 'note';
  throwsMatching(() => schema.validatePayload(rec), /type must be/);
});

test('a bad punchlist state is rejected', () => {
  const rec = wellFormed(); rec.punchlist[0].state = 'closed';
  throwsMatching(() => schema.validatePayload(rec), /state must be/);
});

test('a bad punchlist event op is rejected', () => {
  const rec = wellFormed(); rec.punchlist[0].events[0].op = 'nuke';
  throwsMatching(() => schema.validatePayload(rec), /op must be/);
});

done('session-schema.test');
