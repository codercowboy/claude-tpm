'use strict';
/**
 * session-model.test.js — the bidirectional session model surface (DoD rows 3–7).
 *
 * Covers: load path is read→migrate→validate (C1 — a NEWER schemaVersion is REFUSED on load,
 * and a mutation-proof shows the guard is `migrate`, not `validate`); round-trip identity
 * (build→atomic save→reload deep-equal); editable-table enforcement (apply/import set ONLY the
 * locked editable set; every mechanical field is ignored even if supplied); mechanical ops
 * (punchlist add/close/reopen/drop/carry-in physical copy, log append-only monotonic seq,
 * handoff replace); lifecycle (null handoff until first save, empty-array defaults, sessionIds
 * appends on resume, seq authority).
 *
 * Run: node tests/session-model.test.js
 */
const path = require('path');
const { assert, test, done, tmpDir, throwsMatching, fs } = require('./helpers/harness');
const io = require('../../lib/io');
const { readEnvelope } = require('../../lib/envelope');
const { validateEnvelope } = require('../../lib/validate');
const { CURRENT } = require('../../lib/version');
const schema = require('../lib/session-schema');
const m = require('../lib/session-model');

const SID = '31569169-6609-4bcf-b90f-448f25ee98a3';
const ISO_TZ = /[+-]\d{2}:\d{2}$/;

function freshOpen() {
  return m.openSession({ number: '0021', sessionId: SID, tpmVersion: '0.1.0' });
}

// ── lifecycle: open shape ────────────────────────────────────────────────────

test('openSession yields the locked lifecycle defaults (null handoff, empty arrays)', () => {
  const rec = freshOpen();
  assert.strictEqual(rec.schemaVersion, CURRENT);
  assert.strictEqual(rec.kind, 'session');
  assert.strictEqual(rec.handoff, null, 'handoff is null until first save (A3)');
  assert.deepStrictEqual(rec.log, [], 'log defaults to []');
  assert.deepStrictEqual(rec.punchlist, [], 'punchlist defaults to []');
  assert.deepStrictEqual(rec.meta.sessionIds, [SID]);
  assert.strictEqual(rec.meta.closedAt, null);
  assert.ok(ISO_TZ.test(rec.meta.openedAt), 'openedAt carries a local offset');
  // top-level SIBLING shape: meta/handoff/log/punchlist are NOT nested under a "session" key
  assert.ok(!('session' in rec), 'no legacy nested "session" key');
  assert.ok('meta' in rec && 'handoff' in rec && 'log' in rec && 'punchlist' in rec);
  schema.validatePayload(rec);   // a freshly opened session is a valid record
});

test('resumeSession appends a new sessionId, ignores a duplicate', () => {
  let rec = freshOpen();
  rec = m.resumeSession(rec, 'aaaa-bbbb');
  assert.deepStrictEqual(rec.meta.sessionIds, [SID, 'aaaa-bbbb']);
  rec = m.resumeSession(rec, SID);              // already present
  assert.deepStrictEqual(rec.meta.sessionIds, [SID, 'aaaa-bbbb'], 'no duplicate on resume');
});

// ── load path C1: read → migrate → validate ──────────────────────────────────

test('loadSession round-trips a saved session and honors the load path', () => {
  const dir = tmpDir('tpm-session-');
  const jsonPath = path.join(dir, 'session-0021.json');
  let rec = freshOpen();
  rec = m.importHandoff(rec, { where: 'here', next: 'there' });
  m.saveSession(rec, { jsonPath });
  const loaded = m.loadSession(jsonPath);
  assert.strictEqual(loaded.kind, 'session');
  assert.strictEqual(loaded.handoff.where, 'here');
});

test('C1: a NEWER schemaVersion is REFUSED on load (migrate runs in the load path)', () => {
  const dir = tmpDir('tpm-session-');
  const jsonPath = path.join(dir, 'session-9999.json');
  const rec = freshOpen();
  rec.schemaVersion = '9.9.9';                 // unknown, newer than CURRENT
  io.atomicWriteFileSync(jsonPath, JSON.stringify(rec, null, 2) + '\n', {});

  // real load path REFUSES it, loud, naming the version
  throwsMatching(() => m.loadSession(jsonPath), /9\.9\.9/);

  // MUTATION-PROOF that the guard is `migrate`, not `validate`: a load path that skips migrate
  // (read → validate only) ACCEPTS the very same newer file — so the refusal above is proof
  // that loadSession runs migrate BETWEEN read and validate (C1 contract).
  const env = readEnvelope(jsonPath);
  let acceptedWithoutMigrate = false;
  try {
    validateEnvelope(env._raw, { payloadValidator: schema.validatePayload });
    acceptedWithoutMigrate = true;
  } catch (_) { /* validate alone must NOT be what rejects a newer-but-shape-valid file */ }
  assert.ok(acceptedWithoutMigrate, 'read→validate (no migrate) accepts the newer file — hence migrate is the guard');
});

// ── round-trip identity ──────────────────────────────────────────────────────

test('round-trip identity: persisted record reloads deep-equal', () => {
  const dir = tmpDir('tpm-session-');
  const jsonPath = path.join(dir, 'session-0021.json');
  let rec = freshOpen();
  rec = m.appendLog(rec, { type: 'decision', what: 'chose X', why: 'Y' });
  rec = m.addPunchlist(rec, { text: 'do a thing', slug: 'aaa111' });
  rec = m.importHandoff(rec, { where: 'w', next: 'n', in_flight: 'solo' });

  const persisted = m.saveSession(rec, { jsonPath });   // returns exactly what was written
  const reloaded = m.loadSession(jsonPath);
  assert.deepStrictEqual(reloaded, persisted, 'what saveSession persisted reloads identically');
});

test('round-trip identity (null-handoff, no stamping): in === out exactly', () => {
  const dir = tmpDir('tpm-session-');
  const jsonPath = path.join(dir, 'session-0022.json');
  const rec = freshOpen();                    // handoff:null → no updatedAt stamping
  const persisted = m.saveSession(rec, { jsonPath });
  const reloaded = m.loadSession(jsonPath);
  assert.deepStrictEqual(reloaded, rec, 'unstamped record round-trips byte-identical');
  assert.deepStrictEqual(persisted, rec);
});

test('preserve-unknown survives a model round-trip', () => {
  const dir = tmpDir('tpm-session-');
  const jsonPath = path.join(dir, 'session-0021.json');
  const rec = freshOpen();
  rec.futureField = { addedBy: 'a newer writer' };     // unknown to this code
  m.saveSession(rec, { jsonPath });
  const loaded = m.loadSession(jsonPath);
  assert.deepStrictEqual(loaded.futureField, { addedBy: 'a newer writer' }, 'unknown keys preserved');
});

// ── editable-table enforcement ───────────────────────────────────────────────

test('applySession sets ONLY the editable handoff fields; mechanical/array-element ignored', () => {
  let rec = freshOpen();
  rec.handoff = { where: 'old', next: 'old', in_flight: [], must_not_redo: [], updatedAt: '2026-09-19T00:00:00-07:00' };
  const out = m.applySession(rec, {
    'handoff.where': 'new-where',
    'handoff.in_flight': 'lonely',          // bare string → normalized to ['lonely']
    'meta.number': 'HACKED',                // mechanical → ignored
    'handoff.updatedAt': 'HACKED',          // mechanical → ignored
    'log[].what': 'should be ignored',      // array-element → ignored by generic layer
    'punchlist[].state': 'done',            // mechanical → ignored
  });
  assert.strictEqual(out.handoff.where, 'new-where');
  assert.deepStrictEqual(out.handoff.in_flight, ['lonely'], 'string[] normalized');
  assert.strictEqual(out.handoff.next, 'old', 'untouched editable stays');
  assert.strictEqual(out.meta.number, '0021', 'mechanical meta.number NOT changed');
  assert.strictEqual(out.handoff.updatedAt, '2026-09-19T00:00:00-07:00', 'mechanical updatedAt NOT changed by apply');
});

test('importHandoff REPLACES wholesale from editable fields only, re-stamps updatedAt', () => {
  let rec = freshOpen();
  rec = m.importHandoff(rec, {
    where: 'W', next: 'N', in_flight: 'x', must_not_redo: ['y', 'z'],
    updatedAt: 'HACKED', bogus: 'nope',
  });
  assert.deepStrictEqual(rec.handoff.in_flight, ['x']);
  assert.deepStrictEqual(rec.handoff.must_not_redo, ['y', 'z']);
  assert.ok(!('bogus' in rec.handoff), 'non-editable key dropped');
  assert.ok(ISO_TZ.test(rec.handoff.updatedAt) && rec.handoff.updatedAt !== 'HACKED', 'updatedAt is a fresh stamp');
});

test('importLogAddendum is append-only, allocates monotonic seq, ignores supplied seq/ts', () => {
  let rec = freshOpen();
  rec = m.appendLog(rec, { type: 'log', status: 'NOTE', text: 'first' });    // seq 1
  const before = JSON.stringify(rec.log[0]);
  rec = m.importLogAddendum(rec, [
    { type: 'decision', what: 'a', why: 'b', seq: 999, ts: 'HACKED' },       // seq must become 2
    { type: 'log', status: 'X', text: 'c' },                                  // seq 3
  ]);
  assert.deepStrictEqual(rec.log.map((e) => e.seq), [1, 2, 3], 'monotonic seq allocation');
  assert.strictEqual(JSON.stringify(rec.log[0]), before, 'existing entry never rewritten');
  assert.ok(ISO_TZ.test(rec.log[1].ts) && rec.log[1].ts !== 'HACKED', 'supplied ts ignored; fresh stamp');
});

test('importPunchlist adds items, state defaults open, NEVER set by import', () => {
  let rec = freshOpen();
  rec = m.importPunchlist(rec, [{ text: 'aa', state: 'done', slug: 'keep11' }]);
  assert.strictEqual(rec.punchlist[0].state, 'open', 'import never sets state');
  assert.strictEqual(rec.punchlist[0].slug, 'keep11');
  assert.strictEqual(rec.punchlist[0].events[0].op, 'add');
});

// ── mechanical ops ───────────────────────────────────────────────────────────

test('appendLog seq is the monotonic order authority', () => {
  let rec = freshOpen();
  rec = m.appendLog(rec, { type: 'log', status: 'A', text: '1' });
  rec = m.appendLog(rec, { type: 'decision', what: 'w', why: 'y' });
  assert.deepStrictEqual(rec.log.map((e) => e.seq), [1, 2]);
  assert.strictEqual(rec.log[1].type, 'decision');
});

test('addPunchlist mints slug + session-prefixed id + add event', () => {
  let rec = freshOpen();
  rec = m.addPunchlist(rec, { text: 'one' });
  rec = m.addPunchlist(rec, { text: 'two' });
  assert.deepStrictEqual(rec.punchlist.map((it) => it.id), ['21.1', '21.2'], 'id = <number>.<n>, number un-padded');
  assert.notStrictEqual(rec.punchlist[0].slug, rec.punchlist[1].slug, 'distinct slugs');
  assert.strictEqual(rec.punchlist[0].events[0].op, 'add');
});

test('close / reopen / drop set state and append the op event (NOT echoed to log)', () => {
  let rec = freshOpen();
  rec = m.addPunchlist(rec, { text: 'one', slug: 's1' });
  const logLenBefore = rec.log.length;
  rec = m.closePunchlistItem(rec, 's1');
  assert.strictEqual(rec.punchlist[0].state, 'done');
  rec = m.reopenPunchlistItem(rec, '21.1');            // resolve by id too
  assert.strictEqual(rec.punchlist[0].state, 'open');
  rec = m.dropPunchlistItem(rec, 's1');
  assert.strictEqual(rec.punchlist[0].state, 'dropped');
  assert.deepStrictEqual(rec.punchlist[0].events.map((e) => e.op), ['add', 'close', 'reopen', 'drop']);
  assert.strictEqual(rec.log.length, logLenBefore, 'punchlist ops are NOT echoed into log (spec §C)');
});

test('carry-in is a physical copy: SAME slug, NEW id, carry-in event, state open', () => {
  // prior session with one open + one done item
  let prior = m.openSession({ number: '0020', sessionId: 'prev', tpmVersion: '0.1.0' });
  prior = m.addPunchlist(prior, { text: 'still open', slug: 'lineg1' });
  prior = m.addPunchlist(prior, { text: 'finished', slug: 'done01' });
  prior = m.closePunchlistItem(prior, 'done01');

  const next = m.openSession({ number: '0021', sessionId: SID, tpmVersion: '0.1.0', priorSession: prior });
  assert.strictEqual(next.punchlist.length, 1, 'only the still-OPEN item carries in');
  const carried = next.punchlist[0];
  assert.strictEqual(carried.slug, 'lineg1', 'lineage slug preserved (same slug)');
  assert.strictEqual(carried.id, '21.1', 'NEW session-prefixed id');
  assert.strictEqual(carried.state, 'open');
  assert.deepStrictEqual(carried.events.map((e) => e.op), ['carry-in'], 'fresh carry-in event trail');
  assert.strictEqual(carried.text, 'still open');
});

test('closeSession stamps meta.closedAt', () => {
  const rec = m.closeSession(freshOpen());
  assert.ok(ISO_TZ.test(rec.meta.closedAt), 'closedAt stamped with local offset');
});

// ── export shape ─────────────────────────────────────────────────────────────

test('exportSession json returns the full envelope; human requires an injected converter', () => {
  const rec = freshOpen();
  assert.deepStrictEqual(m.exportSession(rec, { style: 'json' }), rec);
  throwsMatching(() => m.exportSession(rec, { style: 'human' }), /requires an injected `render`/);
  assert.strictEqual(m.exportSession(rec, { style: 'human', render: (r) => `#${r.meta.number}` }), '#0021');
});

// ── save invariants ──────────────────────────────────────────────────────────

test('saveSession writes canonical JSON first and regenerates the human file only with a render fn', () => {
  const dir = tmpDir('tpm-session-');
  const jsonPath = path.join(dir, 'session-0021.json');
  const mdPath = path.join(dir, 'session-0021.md');
  let rec = freshOpen();
  rec = m.importHandoff(rec, { where: 'w', next: 'n' });
  m.saveSession(rec, { jsonPath, mdPath, render: (r) => `HUMAN ${r.handoff.where}` });
  assert.ok(fs.existsSync(jsonPath), 'canonical JSON written');
  assert.strictEqual(fs.readFileSync(mdPath, 'utf8'), 'HUMAN w', 'human file regenerated from record');
  // updatedAt was stamped on save (handoff present)
  const loaded = m.loadSession(jsonPath);
  assert.ok(ISO_TZ.test(loaded.handoff.updatedAt));
});

test('saveSession does not mutate the caller record', () => {
  const dir = tmpDir('tpm-session-');
  const jsonPath = path.join(dir, 'session-0021.json');
  let rec = freshOpen();
  rec = m.importHandoff(rec, { where: 'w', next: 'n' });
  const snapshot = JSON.stringify(rec);
  m.saveSession(rec, { jsonPath });
  assert.strictEqual(JSON.stringify(rec), snapshot, 'caller record unchanged (save works on a clone)');
});

done('session-model.test');
