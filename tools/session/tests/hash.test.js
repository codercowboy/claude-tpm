'use strict';
/**
 * hash.test.js — the SHARED canonical content-hash (lib/hash.js, Q-D).
 *
 * Locks the invariants both sides of the write/read boundary depend on:
 *   - deterministic: same record -> same 12-hex hash, twice.
 *   - shape: 12 lowercase hex chars.
 *   - key-order-independence: shuffling object keys does not change the hash (keys are sorted).
 *   - parse-stability (THE save/doctor agreement proof): hashRecord(rec) ===
 *     hashRecord(JSON.parse(JSON.stringify(rec))) — the doctor hashes the on-disk (parsed) bytes,
 *     the converter hashes the in-memory record; they must agree.
 *   - undefined-drop parity: an undefined-valued key is dropped exactly as JSON.stringify drops it
 *     (so a record with `x: undefined` hashes the same as one without `x`).
 *   - mutation-sensitivity: changing ANY one field changes the hash (incl. a volatile field).
 *   - array order is semantic: reordering array elements changes the hash.
 *
 * Run: node tests/hash.test.js   (also auto-discovered by run-all).
 * Node built-ins only.
 */
const { assert, test, done, fs, path } = require('./helpers/harness');
const { canonicalize, hashRecord } = require('../../lib/hash');

const FIXTURE = path.join(__dirname, 'golden', 'session-0021.fixture.json');
function loadFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

// deep clone with keys inserted in REVERSE order at every object level (to prove order-independence)
function cloneReverseKeys(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(cloneReverseKeys);
  const out = {};
  for (const k of Object.keys(v).reverse()) out[k] = cloneReverseKeys(v[k]);
  return out;
}

test('SHAPE: hashRecord returns 12 lowercase hex chars', () => {
  const h = hashRecord(loadFixture());
  assert.ok(/^[0-9a-f]{12}$/.test(h), `expected 12-hex, got ${JSON.stringify(h)}`);
});

test('DETERMINISTIC: same record hashes identically twice', () => {
  const a = hashRecord(loadFixture());
  const b = hashRecord(loadFixture());
  assert.strictEqual(a, b, 'two hashes of the same record must be equal');
});

test('KEY-ORDER-INDEPENDENT: shuffling object keys does not change the hash', () => {
  const rec = loadFixture();
  const shuffled = cloneReverseKeys(rec);
  assert.strictEqual(hashRecord(shuffled), hashRecord(rec), 'key order must not affect the hash');
  // and the canonical strings themselves must be identical
  assert.strictEqual(canonicalize(shuffled), canonicalize(rec), 'canonical serialization is key-order-stable');
});

test('PARSE-STABILITY: hashRecord(rec) === hashRecord(JSON.parse(JSON.stringify(rec)))', () => {
  const rec = loadFixture();
  const roundTripped = JSON.parse(JSON.stringify(rec));
  assert.strictEqual(hashRecord(rec), hashRecord(roundTripped),
    'the in-memory record and its on-disk (re-parsed) form must hash the same — the save/doctor agreement invariant');
});

test('UNDEFINED-DROP PARITY: an undefined-valued key is dropped like JSON.stringify drops it', () => {
  const base = loadFixture();
  const withUndef = loadFixture();
  withUndef.meta.someFutureField = undefined; // JSON.stringify would omit this key entirely
  assert.strictEqual(hashRecord(withUndef), hashRecord(base),
    'a key with an undefined value must not change the hash (matches JSON.stringify)');
  // an undefined ARRAY element becomes null (also JSON.stringify parity)
  assert.strictEqual(canonicalize([1, undefined, 2]), '[1,null,2]', 'undefined array element -> null');
});

test('MUTATION-SENSITIVITY: changing any one field changes the hash', () => {
  const base = hashRecord(loadFixture());

  const editWhere = loadFixture();
  editWhere.handoff.where = editWhere.handoff.where + ' (edited)';
  assert.notStrictEqual(hashRecord(editWhere), base, 'editing handoff.where changes the hash');

  const editVolatile = loadFixture();
  editVolatile.handoff.updatedAt = '2099-01-01T00:00:00-07:00'; // a VOLATILE field is included
  assert.notStrictEqual(hashRecord(editVolatile), base, 'changing a volatile field (updatedAt) changes the hash');

  const editSeq = loadFixture();
  editSeq.log[0].text = 'tampered';
  assert.notStrictEqual(hashRecord(editSeq), base, 'editing a nested log field changes the hash');
});

test('ARRAY ORDER IS SEMANTIC: reordering array elements changes the hash', () => {
  const base = loadFixture();
  const reordered = loadFixture();
  reordered.log.reverse(); // arrays keep source order, so this must change the hash
  assert.notStrictEqual(hashRecord(reordered), hashRecord(base), 'array reordering changes the hash');
});

test('PRIMITIVES: canonicalize escapes strings and emits compact JSON', () => {
  assert.strictEqual(canonicalize('a"b'), '"a\\"b"', 'string escaping via JSON.stringify');
  assert.strictEqual(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}', 'keys sorted, no whitespace');
  assert.strictEqual(canonicalize(null), 'null', 'null');
  assert.strictEqual(canonicalize(true), 'true', 'boolean');
});

done('hash.test.js');
