'use strict';
/**
 * validate.test.js — base envelope validation, kind-delegated (DoD row 7).
 *
 * Covers: valid envelope passes; bad schemaVersion / missing kind / unknown kind (when a
 * knownKinds map is supplied) throw loud; the payloadValidator is invoked with the payload
 * and can veto; a MUTATION check proves a bad payload is actually caught (the validator is
 * not a no-op).
 *
 * Run: node tests/validate.test.js
 */
const { assert, test, done, throwsMatching } = require('./helpers/harness');
const { validateEnvelope } = require('../../lib/validate');

test('a well-formed envelope validates and is returned', () => {
  const rec = { schemaVersion: '1.0.0', kind: 'session', session: { number: '0001' } };
  assert.strictEqual(validateEnvelope(rec, {}), rec);
});

test('a bad schemaVersion throws', () => {
  throwsMatching(() => validateEnvelope({ schemaVersion: 'v1', kind: 'session' }, {}), /schemaVersion/);
  throwsMatching(() => validateEnvelope({ kind: 'session' }, {}), /schemaVersion/);
});

test('a missing/empty kind throws', () => {
  throwsMatching(() => validateEnvelope({ schemaVersion: '1.0.0', kind: '' }, {}), /kind/);
});

test('an unknown kind throws when knownKinds is supplied', () => {
  const rec = { schemaVersion: '1.0.0', kind: 'widget' };
  throwsMatching(() => validateEnvelope(rec, { knownKinds: { session: 1 } }), /unknown kind 'widget'/);
});

test('payloadValidator is called with the payload and can veto (MUTATION check)', () => {
  let seen;
  const payloadValidator = (payload) => {
    seen = payload;
    if (!payload || payload.number !== '0001') throw new Error('bad session payload');
  };
  const good = { schemaVersion: '1.0.0', kind: 'session', session: { number: '0001' } };
  validateEnvelope(good, { payloadValidator });
  assert.deepStrictEqual(seen, { number: '0001' }, 'validator received the payload');

  const bad = { schemaVersion: '1.0.0', kind: 'session', session: { number: 'WRONG' } };
  throwsMatching(() => validateEnvelope(bad, { payloadValidator }), /bad session payload/);
});

test('payloadValidator also receives the full record as second arg', () => {
  let secondArg;
  validateEnvelope(
    { schemaVersion: '1.0.0', kind: 'session', session: {}, handoff: null },
    { payloadValidator: (_p, rec) => { secondArg = rec; } }
  );
  assert.ok(secondArg && 'handoff' in secondArg, 'validator can reach sibling blocks via the record');
});

done('validate.test');
