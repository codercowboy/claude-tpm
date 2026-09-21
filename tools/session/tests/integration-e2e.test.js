'use strict';
/**
 * integration-e2e.test.js (P07) — the full cross-cutting session-tooling flow the per-phase suites
 * don't exercise as ONE story:
 *
 *   open → note(decide + log) → punchlist add/close/carry-in → import(handoff/log/punchlist) →
 *   save → export(single + multi combined/per-file, JSON + human) → close(guard)
 *
 * Runs entirely against a THROWAWAY sessions dir (os.tmpdir mkdtemp) — NEVER the live sessions dir.
 * At EVERY mutating step it asserts (a) the on-disk canonical JSON round-trips through the real
 * read→migrate→validate load path and equals what the op returned, and (b) the derived human render
 * is well-formed. The export leg asserts every LOCKED shape (single JSON/human, combined JSON = bare
 * array + combined human = repeated header, per-file) AND that each exported JSON re-loads.
 *
 * Run: node tests/integration-e2e.test.js   (also auto-discovered by run-all).
 * Node built-ins only.
 */
const { assert, test, done } = require('./helpers/harness');
const {
  NOW, scratch, jsonPath, mdPath, writeTmp, fs,
  renderWellFormed, assertPersistedMatches, loadEnvelopeFromBody, assertWellFormedHuman,
} = require('./helpers/e2e-helpers');

const ops = require('../tpm-session-ops');
const model = require('../lib/session-model');
const exporter = require('../tpm-session-export');

const ISO_TZ = /[+-]\d{2}:\d{2}$/;

test('end-to-end: open→note→punchlist(add/close/carry-in)→import→save→export→close, round-tripping every step', () => {
  const dir = scratch('tpm-int-');

  // ── a PRIOR session (0030) with a still-open item, so carry-in has a real source ──
  ops.opOpen({ sessionsDir: dir, number: '0030', sessionId: 'sid-prior', tpmVersion: '1.0.0', now: NOW });
  ops.opPunchlist({ sessionsDir: dir, number: '0030', action: 'add', text: 'legacy open task', slug: 'leg030', now: NOW });

  // ── 1. open a fresh session (null handoff) ──
  let rec = ops.opOpen({ sessionsDir: dir, number: '0031', sessionId: 'sid-a', tpmVersion: '1.0.0', now: NOW });
  assert.strictEqual(rec.handoff, null, 'fresh open has a null handoff');
  assertPersistedMatches(dir, '0031', rec, 'after open');
  let md = renderWellFormed(rec, 1, 'after open');
  assert.ok(md.includes('_No handoff yet'), 'null-handoff placeholder rendered after open');

  // ── 2. note: a plain log line, then a decision (append-only, monotonic seq) ──
  ops.opNote({ sessionsDir: dir, number: '0031', type: 'log', status: 'PROGRESS', text: 'started work', now: NOW });
  rec = ops.opNote({ sessionsDir: dir, number: '0031', type: 'decision', what: 'chose approach A', why: 'it composes the base lib', now: NOW });
  assert.deepStrictEqual(rec.log.map((e) => e.seq), [1, 2], 'monotonic seq across two notes');
  assert.strictEqual(rec.log[1].type, 'decision');
  assertPersistedMatches(dir, '0031', rec, 'after note');

  // ── 3. punchlist: add, close, then carry-in the prior session's open item ──
  ops.opPunchlist({ sessionsDir: dir, number: '0031', action: 'add', text: 'do the thing', slug: 's031a', now: NOW });
  ops.opPunchlist({ sessionsDir: dir, number: '0031', action: 'close', idOrSlug: 's031a', now: NOW });
  rec = ops.opPunchlist({
    sessionsDir: dir, number: '0031', action: 'carry-in',
    priorSessionPath: jsonPath(dir, 30), item: 'leg030', now: NOW,
  });
  const carried = rec.punchlist.find((it) => it.slug === 'leg030');
  assert.ok(carried, 'carried item present by lineage slug');
  assert.strictEqual(carried.state, 'open', 'carried item is open');
  assert.strictEqual(carried.events.find((e) => e.op === 'carry-in').fromSession, '0030', 'fromSession provenance stamped');
  md = renderWellFormed(rec, 1, 'after punchlist ops');
  assert.ok(md.includes('⤴ _carried from 0030_ — legacy open task'), 'carried marker renders in the .md');
  assert.ok(/~~`#31\.1` do the thing~~/.test(md), 'closed item struck through in the Done section');
  assertPersistedMatches(dir, '0031', rec, 'after punchlist ops');

  // ── 4. import: handoff (text + next), a log addendum (append-only), punchlist items ──
  const hf = writeTmp(dir, 'handoff.txt', 'we are mid-flow on the integration story\nsecond line');
  rec = ops.opImportHandoff({
    sessionsDir: dir, number: '0031', txtFile: hf, next: 'export then close',
    inFlight: ['export leg'], mustNotRedo: ['re-open closed items'], now: NOW,
  });
  assert.strictEqual(rec.handoff.where, 'we are mid-flow on the integration story\nsecond line');
  assert.strictEqual(rec.handoff.next, 'export then close');
  assert.deepStrictEqual(rec.handoff.in_flight, ['export leg']);
  assertPersistedMatches(dir, '0031', rec, 'after import-handoff');

  const beforeLog = JSON.stringify(model.loadSession(jsonPath(dir, 31)).log);
  const lf = writeTmp(dir, 'add.txt', 'a rich\nmulti-line addendum from a file');
  rec = ops.opImportLog({ sessionsDir: dir, number: '0031', txtFile: lf, status: 'IMPORTED', now: NOW });
  assert.strictEqual(JSON.stringify(rec.log.slice(0, 2)), beforeLog, 'existing log entries never rewritten by import');
  assert.strictEqual(rec.log[2].text, 'a rich\nmulti-line addendum from a file', 'multi-line body imported verbatim');
  assertPersistedMatches(dir, '0031', rec, 'after import-log');

  const pf = writeTmp(dir, 'items.json', JSON.stringify([{ text: 'imported item one', state: 'done', slug: 'imp001' }, 'imported item two']));
  rec = ops.opImportPunchlist({ sessionsDir: dir, number: '0031', file: pf, now: NOW });
  const imp = rec.punchlist.find((it) => it.slug === 'imp001');
  assert.strictEqual(imp.state, 'open', 'import NEVER sets state (file said "done")');
  assertPersistedMatches(dir, '0031', rec, 'after import-punchlist');

  // ── 5. save: re-persist + regenerate the .md; re-stamp handoff.updatedAt ──
  fs.writeFileSync(mdPath(dir, 31), 'STALE HAND-EDIT');
  rec = ops.opSave({ sessionsDir: dir, number: '0031', now: NOW });
  assert.notStrictEqual(fs.readFileSync(mdPath(dir, 31), 'utf8'), 'STALE HAND-EDIT', 'save regenerated the .md over a hand-edit');
  assert.ok(ISO_TZ.test(rec.handoff.updatedAt), 'updatedAt is a valid local-offset stamp');
  assertPersistedMatches(dir, '0031', rec, 'after save');

  // ── 6. EXPORT — single + multi, combined + per-file, JSON + human — each round-trips ──
  const rtDir = scratch('tpm-int-rt-');

  // single JSON (bare envelope) + single human
  let out = exporter.exportSessions({ sessionsDir: dir, selector: ['0031'], styles: ['json', 'human'], now: NOW });
  assert.strictEqual(out.outputs.length, 2, 'single session, two styles → two outputs');
  const singleJson = out.outputs.find((o) => o.style === 'json');
  const singleHuman = out.outputs.find((o) => o.style === 'human');
  assert.ok(!Array.isArray(JSON.parse(singleJson.body)), 'single JSON export is a bare envelope, not an array');
  const rtSingle = loadEnvelopeFromBody(singleJson.body, rtDir, 'single');
  assert.deepStrictEqual(rtSingle, rec, 'exported single JSON re-loads identical to the live record');
  assertWellFormedHuman(singleHuman.body, 1, 'single human export');

  // multi combined JSON (bare ARRAY of envelopes, Q4) + combined human (header REPEATED, Q4)
  out = exporter.exportSessions({ sessionsDir: dir, selector: ['0030', '0031'], styles: ['json', 'human'], combine: 'one-file', now: NOW });
  const combinedJson = out.outputs.find((o) => o.style === 'json');
  const combinedHuman = out.outputs.find((o) => o.style === 'human');
  const arr = JSON.parse(combinedJson.body);
  assert.ok(Array.isArray(arr) && arr.length === 2, 'combined JSON is a bare array of 2 envelopes (Q4)');
  arr.forEach((env, i) => {
    const loaded = loadEnvelopeFromBody(JSON.stringify(env, null, 2) + '\n', rtDir, `combined-${i}`);
    assert.strictEqual(loaded.kind, 'session', 'each combined-array element is a valid session envelope');
  });
  assertWellFormedHuman(combinedHuman.body, 2, 'combined human export (header repeated per session)');

  // multi per-file JSON + human
  out = exporter.exportSessions({ sessionsDir: dir, selector: ['0030', '0031'], styles: ['json', 'human'], combine: 'per-file', now: NOW });
  const perJson = out.outputs.filter((o) => o.style === 'json');
  const perHuman = out.outputs.filter((o) => o.style === 'human');
  assert.strictEqual(perJson.length, 2, 'per-file JSON → one file per session');
  assert.strictEqual(perHuman.length, 2, 'per-file human → one file per session');
  perJson.forEach((o, i) => {
    assert.ok(!Array.isArray(JSON.parse(o.body)), 'each per-file JSON is a bare envelope');
    loadEnvelopeFromBody(o.body, rtDir, `perfile-${i}`); // re-loads/validates or throws
  });
  perHuman.forEach((o) => assertWellFormedHuman(o.body, 1, 'per-file human export'));

  // ── 7. close: the #1115 guard PASSES (handoff + punchlist both present); seals + renders closed ──
  rec = ops.opClose({ sessionsDir: dir, number: '0031', now: NOW });
  assert.ok(ISO_TZ.test(rec.meta.closedAt), 'closedAt stamped by a guarded close');
  const finalMd = renderWellFormed(rec, 1, 'after close');
  assert.ok(finalMd.includes('· **closed** ·'), 'the derived .md shows the closed state');
  assertPersistedMatches(dir, '0031', rec, 'after close');
});

done('integration-e2e.test.js');
