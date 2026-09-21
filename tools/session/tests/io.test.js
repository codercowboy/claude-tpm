'use strict';
/**
 * io.test.js — atomic write + fail-loud read (DoD rows 1 & 2).
 *
 * Covers:
 *  - happy-path atomic write + read-back.
 *  - FORCED-WRITE-FAILURE at rename AND at fsync: proves NO partial/corrupt target is
 *    left, the pre-existing canonical file is byte-UNCHANGED, and no orphaned .tmp remains.
 *  - fail-loud read: ENOENT and invalid-JSON both throw a LOUD error naming the file;
 *    NEVER return an empty object.
 *  - a MUTATION check: with the fault-injecting wrapper removed the same write succeeds,
 *    proving the failure test could actually observe the difference (not a no-op).
 *
 * Run: node tests/io.test.js
 */
const { assert, test, done, tmpDir, withFailingFs, fs, path } = require('./helpers/harness');
const io = require('../../lib/io');

function tmpFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
}

test('atomicWriteFileSync writes then reads back exactly', () => {
  const dir = tmpDir('tpm-io-');
  const fp = path.join(dir, 'session-0001.json');
  io.atomicWriteFileSync(fp, '{"a":1}\n');
  assert.strictEqual(fs.readFileSync(fp, 'utf8'), '{"a":1}\n');
  assert.deepStrictEqual(tmpFiles(dir), [], 'no leftover .tmp after a successful write');
});

test('forced RENAME failure leaves the pre-existing file byte-unchanged + no orphan tmp', () => {
  const dir = tmpDir('tpm-io-');
  const fp = path.join(dir, 'session-0002.json');
  const original = '{"canonical":"v1"}\n';
  io.atomicWriteFileSync(fp, original);            // seed a good canonical file
  const before = fs.readFileSync(fp, 'utf8');

  let threw = false;
  withFailingFs('renameSync', () => {
    try { io.atomicWriteFileSync(fp, '{"canonical":"v2-should-not-land"}\n'); }
    catch (e) { threw = true; assert.ok(/failed writing/.test(e.message), 'loud throw naming the file'); }
  });
  assert.ok(threw, 'a rename failure must throw');
  assert.strictEqual(fs.readFileSync(fp, 'utf8'), before, 'target byte-identical to the pre-existing file');
  assert.strictEqual(before, original, 'sanity: seed unchanged');
  assert.deepStrictEqual(tmpFiles(dir), [], 'the partial temp file was cleaned up (no orphan)');
});

test('forced FSYNC failure leaves no target created + no orphan tmp', () => {
  const dir = tmpDir('tpm-io-');
  const fp = path.join(dir, 'session-0003.json');   // does NOT pre-exist

  let threw = false;
  withFailingFs('fsyncSync', () => {
    try { io.atomicWriteFileSync(fp, '{"x":1}\n'); }
    catch (e) { threw = true; assert.ok(/failed writing/.test(e.message)); }
  });
  assert.ok(threw, 'an fsync failure must throw');
  assert.ok(!fs.existsSync(fp), 'no partial canonical file was created');
  assert.deepStrictEqual(tmpFiles(dir), [], 'no orphaned .tmp left behind');
});

test('MUTATION check: without the injected fault the same write succeeds', () => {
  const dir = tmpDir('tpm-io-');
  const fp = path.join(dir, 'session-0004.json');
  io.atomicWriteFileSync(fp, '{"ok":true}\n');       // no wrapper -> must NOT throw
  assert.strictEqual(fs.readFileSync(fp, 'utf8'), '{"ok":true}\n');
});

test('readCanonicalSync round-trips a written file', () => {
  const dir = tmpDir('tpm-io-');
  const fp = path.join(dir, 'session-0005.json');
  io.atomicWriteFileSync(fp, JSON.stringify({ a: 1, b: [2, 3] }));
  assert.deepStrictEqual(io.readCanonicalSync(fp), { a: 1, b: [2, 3] });
});

test('readCanonicalSync fails LOUD on a missing file (never returns {})', () => {
  const dir = tmpDir('tpm-io-');
  const fp = path.join(dir, 'nope.json');
  let result;
  let threw = false;
  try { result = io.readCanonicalSync(fp); }
  catch (e) { threw = true; assert.ok(e.message.includes(fp), 'error names the file'); assert.ok(/cannot read/.test(e.message)); }
  assert.ok(threw, 'a missing file must throw');
  assert.strictEqual(result, undefined, 'must NOT have returned a default/empty object');
});

test('readCanonicalSync fails LOUD on invalid JSON naming the file', () => {
  const dir = tmpDir('tpm-io-');
  const fp = path.join(dir, 'broken.json');
  fs.writeFileSync(fp, '{ this is not json ');
  let threw = false;
  try { io.readCanonicalSync(fp); }
  catch (e) { threw = true; assert.ok(e.message.includes(fp)); assert.ok(/not valid JSON/.test(e.message)); }
  assert.ok(threw, 'invalid JSON must throw');
});

done('io.test');
