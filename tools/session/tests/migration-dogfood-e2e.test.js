'use strict';
/**
 * migration-dogfood-e2e.test.js (P05) — the MIGRATION dogfood the per-phase suites don't cover.
 *
 * dogfood-corpus.test.js builds its corpus THROUGH the ops (synthetic-but-real JSON) and explicitly
 * scopes OUT "dogfooding the REAL old-format markdown sessions … awaits #1114 migration". This suite
 * closes exactly that gap: it drives a realistic OLD 3-file markdown corpus THROUGH the real migrator
 * (tpm-session-migrate.runMigration) into a store, then proves each migrated file
 *   (a) is schema-valid and LOADS via the canonical read→migrate→validate path,
 *   (b) EXPORTS single (per-file) AND combined (one-file, JSON bare-array + human), and
 *   (c) RENDERS well-formed human output,
 * across a corpus that deliberately includes a NULL-HANDOFF session and a CARRIED item (a still-open
 * migrated item folded into a new session opened FROM the migrated JSON — migrate → carry-in chain).
 *
 * Everything runs in THROWAWAY dirs (os.tmpdir mkdtemp) — the OLD 3-file inputs are freshly written
 * to scratch --in dirs; output goes only to scratch --out dirs. NEVER the live sessions tree.
 * Run: node tests/migration-dogfood-e2e.test.js   (also auto-discovered by run-all).
 * Node built-ins only.
 */
const os = require('os');
const { assert, test, done, fs, path } = require('./helpers/harness');
const {
  NOW, jsonPath, assertWellFormedHuman, loadEnvelopeFromBody,
} = require('./helpers/e2e-helpers');
const { writeOldSession } = require('./helpers/legacy-builder');

const migrator = require('../tpm-session-migrate');
const model = require('../lib/session-model');
const ops = require('../tpm-session-ops');
const exporter = require('../tpm-session-export');
const { render } = require('../lib/session-converter');

// timestamps well BEFORE NOW so migrated open-item ages render positively.
const T = (h) => `2026-09-10T${String(h).padStart(2, '0')}:00:00-07:00`;

/**
 * Build a realistic OLD 3-file corpus in a scratch dir, migrate each into a shared store, then open
 * one MORE session FROM a migrated one (carry-in). Returns { store, numbers, migrated }.
 */
function buildMigratedCorpus() {
  const inBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-dogfood-old-'));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-dogfood-store-'));

  // 0040 — a full session: handoff + a decision + a log line + one open + one closed item.
  const in40 = writeOldSession(inBase, '0040', {
    handoff: { where: 'bootstrapped the legacy corpus', next: 'migrate it', in_flight: ['a', 'b'], mustNotRedo: ['do not X'] },
    decisions: [{ what: 'store JSON-first', why: 'one canonical file', ts: T(9) }],
    logs: [{ status: 'ADDED', text: 'opened 0040', ts: T(9) }],
    open: [{ id: '40.1', slug: 'open40', text: 'design the ops layer', ts: T(9) }],
    done: [{ id: '40.2', slug: 'done40', text: 'already handled', ts: T(9), closedTs: T(10) }],
  });

  // 0041 — a NULL-HANDOFF session (no Where/Next captured), one log line + one open item.
  const in41 = writeOldSession(inBase, '0041', {
    handoff: null,
    logs: [{ status: 'NOTE', text: 'quick session, no handoff', ts: T(11) }],
    open: [{ id: '41.1', slug: 'open41', text: 'revisit the null-handoff render', ts: T(11) }],
  });

  // 0042 — a full session whose still-open item will be CARRIED into 0043.
  const in42 = writeOldSession(inBase, '0042', {
    handoff: { where: 'work to be continued', next: 'carry the open item forward' },
    decisions: [{ what: 'add the P05 dogfood', why: 'per-phase suites miss cross-cutting invariants', ts: T(12) }],
    open: [{ id: '42.1', slug: 'carry42', text: 'the item that gets carried', ts: T(12) }],
  });

  const migrated = {};
  for (const [num, inDir] of [['0040', in40], ['0041', in41], ['0042', in42]]) {
    const res = migrator.runMigration({ inDir, outDir: store, now: NOW });
    migrated[num] = res.outPath;
    assert.strictEqual(res.outPath, jsonPath(store, num), `migrated ${num} lands at session-${num}.json`);
  }

  // 0043 — a NEW session opened FROM the migrated 0042 JSON: its still-open item is carried forward
  // (same slug, {op:"carry-in", fromSession:"0042"}). This exercises migrate → carry-in end-to-end.
  ops.opOpen({ sessionsDir: store, number: '0043', sessionId: 'sid-43', tpmVersion: '1.0.0', priorSessionPath: migrated['0042'], now: NOW });
  ops.opImportHandoff({ sessionsDir: store, number: '0043', txtFile: writeTmp(store, 'h43.txt', 'continued from 0042'), next: 'close the epic', now: NOW });

  return { store, numbers: ['0040', '0041', '0042', '0043'], migrated };
}

function writeTmp(dir, name, contents) { const p = path.join(dir, name); fs.writeFileSync(p, contents); return p; }

// ── (a) every migrated file is schema-valid + LOADS + carries the right shape ─────────────────

test('each OLD 3-file session migrates to schema-valid JSON that loads via the canonical path', () => {
  const { store, numbers } = buildMigratedCorpus();
  numbers.forEach((n) => {
    const rec = model.loadSession(jsonPath(store, n)); // read→migrate→validate; throws loud if bad
    assert.strictEqual(rec.kind, 'session', `${n} is kind:session`);
    assert.strictEqual(rec.schemaVersion, '1.0.0', `${n} at schema 1.0.0`);
    assert.strictEqual(rec.meta.number, n, `${n} stored meta.number is the canonical zero-padded string`);
    assert.strictEqual(typeof rec.meta.number, 'string', `${n} meta.number is a STRING`);
  });

  // the null-handoff session really migrated to a null handoff (lifecycle edge preserved).
  assert.strictEqual(model.loadSession(jsonPath(store, '0041')).handoff, null, '0041 is a genuine null-handoff migration');
  // the full sessions kept their handoff.
  assert.ok(model.loadSession(jsonPath(store, '0040')).handoff, '0040 has a handoff');

  // the carried lineage: 0043 physically holds 0042.carry42 with carry-in provenance.
  const s43 = model.loadSession(jsonPath(store, '0043'));
  const carried = s43.punchlist.find((it) => it.slug === 'carry42');
  assert.ok(carried, '0043 carried the migrated 0042 open item (same slug)');
  assert.ok(carried.events.some((e) => e.op === 'carry-in' && e.fromSession === '0042'), 'carry-in event names the source 0042');
});

// ── (b) exports single (per-file) + combined (one-file), JSON + human, all re-load ────────────

test('per-file export: each migrated session exports to JSON that re-loads + human that is well-formed', () => {
  const { store, numbers } = buildMigratedCorpus();
  const out = exporter.exportSessions({ sessionsDir: store, selector: numbers, styles: ['json', 'human'], combine: 'per-file', now: NOW });

  const perJson = out.outputs.filter((o) => o.style === 'json');
  const perHuman = out.outputs.filter((o) => o.style === 'human');
  assert.strictEqual(perJson.length, numbers.length, 'one JSON file per migrated session');
  assert.strictEqual(perHuman.length, numbers.length, 'one human file per migrated session');

  const rtBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-dogfood-rt-'));
  perJson.forEach((o) => {
    const env = JSON.parse(o.body);
    const live = model.loadSession(jsonPath(store, env.meta.number));
    const reloaded = loadEnvelopeFromBody(o.body, rtBase, `perfile-${env.meta.number}`);
    assert.deepStrictEqual(reloaded, live, `per-file JSON ${o.suggestedName} round-trips to the live migrated record`);
  });
  perHuman.forEach((o) => assertWellFormedHuman(o.body, 1, `per-file human ${o.suggestedName}`));
});

test('combined export: one-file JSON is a bare array that re-loads + one-file human is well-formed', () => {
  const { store, numbers } = buildMigratedCorpus();
  const out = exporter.exportSessions({ sessionsDir: store, selector: numbers, styles: ['json', 'human'], combine: 'one-file', now: NOW });

  const combinedJson = out.outputs.find((o) => o.style === 'json');
  const arr = JSON.parse(combinedJson.body);
  assert.ok(Array.isArray(arr), 'combined JSON is a bare array (export-spec Q4)');
  assert.strictEqual(arr.length, numbers.length, 'one envelope per migrated session');
  const rtBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-dogfood-rt-'));
  arr.forEach((env, i) => {
    const loaded = loadEnvelopeFromBody(JSON.stringify(env, null, 2) + '\n', rtBase, `combined-${i}`);
    assert.strictEqual(loaded.kind, 'session', 'each combined-array element re-loads as a valid envelope');
  });

  const combinedHuman = out.outputs.find((o) => o.style === 'human');
  assertWellFormedHuman(combinedHuman.body, numbers.length, 'migrated corpus combined human');
  // the two cross-cutting edges must render within the combined output:
  assert.ok(combinedHuman.body.includes('_No handoff yet'), 'the migrated null-handoff session renders its placeholder');
  assert.ok(/⤴ _carried from 0042_/.test(combinedHuman.body), 'the carried lineage renders its provenance (carried from 0042)');
});

// ── (c) direct render of every migrated record is well-formed ─────────────────────────────────

test('direct render of each migrated record is well-formed human (no leaked undefined / [object Object] / NaN)', () => {
  const { store, numbers } = buildMigratedCorpus();
  numbers.forEach((n) => {
    const rec = model.loadSession(jsonPath(store, n));
    const md = render(rec, { now: NOW });
    assertWellFormedHuman(md, 1, `render ${n}`);
    assert.ok(new RegExp(`^# Session ${n} · `, 'm').test(md), `${n} renders "# Session ${n}"`);
  });
});

done('migration-dogfood-e2e.test.js');
