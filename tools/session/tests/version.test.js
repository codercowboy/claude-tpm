'use strict';
/**
 * version.test.js — semver compare + migrate / version-tolerance (DoD row 6).
 *
 * Covers:
 *  - compare() semver ordering.
 *  - CURRENT record returns as-is.
 *  - an OLDER-but-known schemaVersion MIGRATES up to CURRENT via a version-keyed
 *    converter path (chained across two hops) — proving the real migration mechanism.
 *  - a NEWER (unknown) schemaVersion is REFUSED loudly, naming the version.
 *  - an older version with NO migrator path throws (no silent pass-through).
 *
 * Run: node tests/version.test.js
 */
const { assert, test, done, throwsMatching } = require('./helpers/harness');
const version = require('../../lib/version');

test('compare orders semver correctly', () => {
  assert.strictEqual(version.compare('1.0.0', '1.0.0'), 0);
  assert.strictEqual(version.compare('0.9.0', '1.0.0'), -1);
  assert.strictEqual(version.compare('1.2.0', '1.10.0'), -1); // numeric, not lexical
  assert.strictEqual(version.compare('2.0.0', '1.9.9'), 1);
});

test('a CURRENT record migrates to itself unchanged', () => {
  const rec = { schemaVersion: version.CURRENT, kind: 'session', session: {} };
  assert.strictEqual(version.migrate(rec), rec);
});

test('an OLDER known version migrates up to CURRENT via a chained converter path', () => {
  // Two-hop registry: 0.8.0 -> 0.9.0 -> 1.0.0. Proves the version-keyed chain, not a no-op.
  const reg = {
    '0.8.0': (r) => Object.assign({}, r, { schemaVersion: '0.9.0', migratedVia08: true }),
    '0.9.0': (r) => Object.assign({}, r, { schemaVersion: '1.0.0', migratedVia09: true }),
  };
  const old = { schemaVersion: '0.8.0', kind: 'session', session: { number: '0001' } };
  const out = version.migrate(old, reg);
  assert.strictEqual(out.schemaVersion, version.CURRENT, 'ends at CURRENT');
  assert.strictEqual(out.migratedVia08, true, 'first hop ran');
  assert.strictEqual(out.migratedVia09, true, 'second hop ran');
  assert.strictEqual(out.session.number, '0001', 'payload carried through');
});

test('a NEWER unknown version is refused LOUD, naming the version', () => {
  const future = { schemaVersion: '2.0.0', kind: 'session' };
  throwsMatching(() => version.migrate(future), /2\.0\.0/, 'refusal names the version');
  throwsMatching(() => version.migrate(future), /newer schemaVersion/);
});

test('an older version with no migrator path throws (no silent pass-through)', () => {
  const old = { schemaVersion: '0.5.0', kind: 'session' };
  throwsMatching(() => version.migrate(old, {}), /no migration path/);
});

test('missing schemaVersion throws', () => {
  throwsMatching(() => version.migrate({ kind: 'session' }), /missing schemaVersion/);
});

done('version.test');
