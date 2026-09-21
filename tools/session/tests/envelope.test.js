'use strict';
/**
 * envelope.test.js — envelope read/write + preserve-unknown (DoD row 5).
 *
 * Covers:
 *  - writeEnvelope -> readEnvelope round-trip (atomic write underneath).
 *  - readEnvelope asserts schemaVersion + kind present (fail-loud otherwise).
 *  - PRESERVE-UNKNOWN: an unknown top-level key AND an unknown nested key survive a
 *    write->read->merge->write round-trip (mergePreservingUnknown keeps them; the known
 *    fields are updated).
 *  - refuse-unknown-NEWER is delegated to version.migrate (covered in version.test), and
 *    re-checked here end-to-end: an unknown newer envelope on disk is refused after read.
 *
 * Run: node tests/envelope.test.js
 */
const { assert, test, done, tmpDir, throwsMatching, fs, path } = require('./helpers/harness');
const envelope = require('../../lib/envelope');
const version = require('../../lib/version');

test('writeEnvelope -> readEnvelope round-trip', () => {
  const dir = tmpDir('tpm-env-');
  const fp = path.join(dir, 'session-0001.json');
  const rec = { schemaVersion: '1.0.0', kind: 'session', session: { number: '0001' } };
  envelope.writeEnvelope(fp, rec);
  const env = envelope.readEnvelope(fp);
  assert.strictEqual(env.schemaVersion, '1.0.0');
  assert.strictEqual(env.kind, 'session');
  assert.deepStrictEqual(env.payload, { number: '0001' });
  assert.deepStrictEqual(env._raw, rec, '_raw is the full parsed record');
});

test('readEnvelope fails loud on a missing schemaVersion or kind', () => {
  const dir = tmpDir('tpm-env-');
  const noVer = path.join(dir, 'a.json');
  fs.writeFileSync(noVer, JSON.stringify({ kind: 'session', session: {} }));
  throwsMatching(() => envelope.readEnvelope(noVer), /schemaVersion/);

  const noKind = path.join(dir, 'b.json');
  fs.writeFileSync(noKind, JSON.stringify({ schemaVersion: '1.0.0', session: {} }));
  throwsMatching(() => envelope.readEnvelope(noKind), /kind/);
});

test('PRESERVE-UNKNOWN: unknown top-level + nested keys survive a round-trip', () => {
  const dir = tmpDir('tpm-env-');
  const fp = path.join(dir, 'session-0002.json');
  // A file a NEWER writer produced: it has keys this code does not know about.
  const fromNewerWriter = {
    schemaVersion: '1.0.0',
    kind: 'session',
    session: { number: '0002', futureMechanicalField: 'keep-me' },
    unknownTopLevel: { nested: 'also-keep-me' },
  };
  fs.writeFileSync(fp, JSON.stringify(fromNewerWriter, null, 2) + '\n');

  const env = envelope.readEnvelope(fp);
  // Old code updates only what it knows (session.number) and re-merges over _raw.
  const nextKnown = { session: { number: '0002-updated' } };
  const merged = envelope.mergePreservingUnknown(env._raw, nextKnown);
  envelope.writeEnvelope(fp, merged);

  const reread = envelope.readEnvelope(fp)._raw;
  assert.strictEqual(reread.session.number, '0002-updated', 'known field updated');
  assert.strictEqual(reread.session.futureMechanicalField, 'keep-me', 'unknown nested key preserved');
  assert.deepStrictEqual(reread.unknownTopLevel, { nested: 'also-keep-me' }, 'unknown top-level key preserved');
});

test('mergePreservingUnknown does not mutate its inputs', () => {
  const existing = { a: 1, keep: { x: 1 } };
  const next = { a: 2 };
  const out = envelope.mergePreservingUnknown(existing, next);
  assert.deepStrictEqual(existing, { a: 1, keep: { x: 1 } }, 'existing untouched');
  assert.strictEqual(out.a, 2);
  assert.deepStrictEqual(out.keep, { x: 1 }, 'unknown branch carried');
  out.keep.x = 99;
  assert.strictEqual(existing.keep.x, 1, 'output is a deep clone, not aliased');
});

test('end-to-end: an unknown NEWER envelope on disk is refused after read', () => {
  const dir = tmpDir('tpm-env-');
  const fp = path.join(dir, 'future.json');
  fs.writeFileSync(fp, JSON.stringify({ schemaVersion: '9.9.9', kind: 'session', session: {} }));
  const env = envelope.readEnvelope(fp);         // read succeeds (well-formed envelope)
  throwsMatching(() => version.migrate(env._raw), /9\.9\.9/); // migrate refuses the newer version
});

done('envelope.test');
