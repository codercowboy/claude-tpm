'use strict';
/**
 * task-doctor.test.js — the READ-ONLY task doctor (`../tpm-task-doctor.js`, #1119 for tasks).
 *
 * Zero-dep, Node built-ins only; a tiny inline harness (exit NON-ZERO on any failure, per the
 * tool-conventions ship-tool bar). Each fixture store is built in an os.tmpdir scratch — NEVER the
 * live store. Run:
 *   node dev/20260920-task-features/task-tooling/tests/task-doctor.test.js
 *
 * Covers (DoD):
 *  - HEALTHY store → exit 0, all bodies valid, no drift, label-index OK. (clean baseline)
 *  - SCHEMA VALIDATION: a body corrupted to break the payload validator is reported (id + stage +
 *    reason), exit 1 — mutation-proven (the SAME store is clean before the corruption).
 *  - HASH-DRIFT: a hand-edited JSON body (banner now stale) is REPORTED as DRIFT, exit 1 —
 *    mutation-proven (clean before the edit).
 *  - LABEL-INDEX: a hand-edited tasks-index.json.labels → MISMATCH + SUGGEST reindex, exit 1;
 *    a MISSING index beside bodies → SUGGEST reindex; a CORRUPT index → SUGGEST reindex.
 *  - OLD-FORMAT: a markdown-only store is DETECTED (via the migrator's detectStore) and the doctor
 *    SUGGESTS migrate, exit 1 — never migrates.
 *  - READ-ONLY PROOF: on every fixture, a recursive snapshot of {mtime,size} + the file set is
 *    IDENTICAL before and after runDoctor — the doctor writes NOTHING.
 *  - EXIT CODES: usage errors (missing/unknown flag, unreadable dir) → 2; clean → 0; problems → 1.
 *  - RULINGS: F3 (null summary/context is LENIENT — not flagged) + T-Q3 (endAction {…, refs:[]})
 *    both validate OK.
 */
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const model = require('../lib/task-model');
const conv = require('../lib/task-converter');
const doctor = require('../tpm-task-doctor');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   - ' + name);
  } catch (e) {
    failed++;
    const detail = e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n         ') : String(e);
    console.log('  FAIL - ' + name + '\n         ' + detail);
  }
}

function done(suite) {
  console.log(`\n${suite}: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

// ── fixtures ──────────────────────────────────────────────────────────────────

function scratch(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'tpm-doctor-')); }

/**
 * healthyStore() -> dir — a well-formed NEW-format store: two open tasks + one finished, each with
 * labels, persisted through the real model (atomic JSON body + derived .md banner + tasks-index.json
 * + human index views). This is the clean baseline every mutation test starts from.
 */
function healthyStore() {
  const dir = scratch('tpm-doctor-healthy-');
  const save = (rec) => model.saveTask(rec, { tasksDir: dir, render: conv.render, indexRender: conv.renderIndexView });
  save(model.openTask({ headline: 'first task', labels: ['alpha', 'beta'], summary: 'a summary', tasksDir: dir }));
  save(model.openTask({ headline: 'second task', labels: ['beta'], tasksDir: dir }));
  const c = model.openTask({ headline: 'third task', labels: ['gamma'], tasksDir: dir });
  save(model.finishTask(c));
  return dir;
}

/** oldFormatStore() -> dir — a CLEAN markdown-only store (bodies/<bucket>/task-<id>.md, no JSON, no index). */
function oldFormatStore() {
  const dir = scratch('tpm-doctor-old-');
  const bucket = path.join(dir, 'bodies', '1000-1999');
  fs.mkdirSync(bucket, { recursive: true });
  fs.writeFileSync(path.join(bucket, 'task-1000.md'),
    '# #1000 · a legacy task\n\n- **State:** open\n- **Created:** 2026-01-01\n\n## Summary\n\nold.\n');
  fs.writeFileSync(path.join(bucket, 'task-1001.md'),
    '# #1001 · another legacy task\n\n- **State:** open\n- **Created:** 2026-01-02\n');
  fs.writeFileSync(path.join(dir, 'task-index.md'), '# Tasks\n\n**Next ID:** 1002\n');
  return dir;
}

// ── read-only proof helpers ─────────────────────────────────────────────────────

/** snapshot(dir) -> { "<rel>": "<mtimeMs>:<size>" } over every file (recursive), sorted implicitly. */
function snapshot(dir) {
  const out = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const st = fs.statSync(p);
      out[path.relative(dir, p).split(path.sep).join('/')] = `${st.mtimeMs}:${st.size}`;
    }
  })(dir);
  return out;
}

/**
 * assertReadOnly(dir, msg) — run the doctor and assert the file set + every file's {mtime,size} is
 * IDENTICAL before and after. Proves the doctor writes/creates/touches NOTHING. Returns the report.
 */
function assertReadOnly(dir, msg) {
  const before = snapshot(dir);
  const report = doctor.runDoctor({ tasksDir: dir });
  const after = snapshot(dir);
  assert.deepStrictEqual(after, before, (msg || 'doctor') + ' must not change any file (mtime/size/set)');
  return report;
}

// ── tests ───────────────────────────────────────────────────────────────────────

test('HEALTHY store → exit 0, all valid, no drift, label-index OK', () => {
  const dir = healthyStore();
  const r = doctor.runDoctor({ tasksDir: dir });
  assert.strictEqual(r.exitCode, 0, 'clean store exits 0');
  assert.strictEqual(r.summary.bodies, 3, 'three bodies discovered (nested scan)');
  assert.strictEqual(r.summary.valid, 3, 'all three valid');
  assert.strictEqual(r.summary.invalid, 0, 'none invalid');
  assert.strictEqual(r.summary.drift, 0, 'no drift');
  assert.strictEqual(r.summary.labelIndex, 'OK', 'label index consistent');
  assert.strictEqual(r.oldFormat, null, 'not old-format');
});

test('NESTED-LAYOUT aware — bodies discovered under bodies/<bucket>/', () => {
  const dir = healthyStore();
  const r = doctor.runDoctor({ tasksDir: dir });
  for (const b of r.bodies) {
    assert.ok(/^bodies\/\d+-\d+\/task-\d+\.json$/.test(b.file), 'body path is nested: ' + b.file);
  }
});

test('SCHEMA VALIDATION — a corrupted body is reported (mutation-proven clean→invalid)', () => {
  const dir = healthyStore();
  // clean first
  assert.strictEqual(doctor.runDoctor({ tasksDir: dir }).summary.invalid, 0, 'clean before corruption');
  // plant: blank the required headline (breaks validatePayload)
  const bp = model.bodyPathFor(dir, '1000');
  const rec = JSON.parse(fs.readFileSync(bp, 'utf8'));
  rec.headline = '';
  fs.writeFileSync(bp, JSON.stringify(rec, null, 2) + '\n');
  const r = doctor.runDoctor({ tasksDir: dir });
  assert.strictEqual(r.summary.invalid, 1, 'the corrupted body is now invalid');
  assert.strictEqual(r.exitCode, 1, 'problems → exit 1');
  const row = r.bodies.find((b) => b.id === '1000');
  assert.strictEqual(row.validate.status, 'FAIL', 'row FAILs');
  assert.strictEqual(row.validate.stage, 'validate', 'failing stage labeled');
  assert.ok(/headline/.test(row.validate.problem), 'reason names the offending field, got: ' + row.validate.problem);
});

test('SCHEMA VALIDATION — an unparseable body FAILs at the read stage', () => {
  const dir = healthyStore();
  const bp = model.bodyPathFor(dir, '1001');
  fs.writeFileSync(bp, '{ this is not json');
  const r = doctor.runDoctor({ tasksDir: dir });
  const row = r.bodies.find((b) => b.file.includes('1001'));
  assert.strictEqual(row.validate.status, 'FAIL', 'unparseable body FAILs');
  assert.strictEqual(row.validate.stage, 'read', 'labeled at the read stage');
  assert.strictEqual(r.exitCode, 1, 'exit 1');
});

test('HASH-DRIFT — a hand-edited JSON body is REPORTED (mutation-proven clean→drift)', () => {
  const dir = healthyStore();
  assert.strictEqual(doctor.runDoctor({ tasksDir: dir }).summary.drift, 0, 'no drift before the edit');
  // plant: hand-edit the canonical JSON WITHOUT re-rendering the .md → banner now stale
  const bp = model.bodyPathFor(dir, '1000');
  const rec = JSON.parse(fs.readFileSync(bp, 'utf8'));
  rec.headline = 'HAND EDITED — banner not restamped';
  fs.writeFileSync(bp, JSON.stringify(rec, null, 2) + '\n');
  const r = doctor.runDoctor({ tasksDir: dir });
  assert.strictEqual(r.summary.drift, 1, 'drift detected');
  assert.strictEqual(r.exitCode, 1, 'problems → exit 1');
  const row = r.bodies.find((b) => b.id === '1000');
  assert.strictEqual(row.drift.status, 'DRIFT', 'row is DRIFT');
  assert.notStrictEqual(row.drift.bannerHash, row.drift.currentHash, 'banner hash != recomputed hash');
});

test('HASH-DRIFT — a body .md with no banner is UNSTAMPED (advisory, not a failure)', () => {
  const dir = healthyStore();
  const mdPath = model.bodyPathFor(dir, '1001').replace(/\.json$/, '.md');
  fs.writeFileSync(mdPath, '# #1001 · hand-made body with no banner\n');
  const r = doctor.runDoctor({ tasksDir: dir });
  const row = r.bodies.find((b) => b.file.includes('1001'));
  assert.strictEqual(row.drift.status, 'UNSTAMPED', 'unstamped detected');
  assert.strictEqual(r.exitCode, 0, 'UNSTAMPED is advisory — still exit 0');
});

// T-F3 (04 verifier — LOW blind spot; NOT a DoD claim): the drift check keys off the derived `.md`
// sibling. When that sibling is MISSING, checkDrift returns status 'NONE' (line 133: "no derived
// file → nothing to drift-check"), so deleting or de-bannering a `.md` on a JSON-canonical store
// escapes drift detection SILENTLY — the doctor stays green. This test PINS that current behaviour
// (drift NONE, exit unchanged) so any future decision to surface a missing `.md` as an advisory is a
// DELIBERATE change that flips this assertion, not an accidental regression. See decisions.md T-F3.
test('T-F3: a MISSING .md sibling → drift NONE (blind spot PINNED), exit unchanged (0)', () => {
  const dir = healthyStore();
  const clean = doctor.runDoctor({ tasksDir: dir });
  assert.strictEqual(clean.summary.drift, 0, 'baseline: no drift');
  assert.strictEqual(clean.exitCode, 0, 'baseline: clean store exits 0');
  // Delete the derived .md sibling of a valid body — the JSON stays canonical + valid.
  const mdPath = model.bodyPathFor(dir, '1001').replace(/\.json$/, '.md');
  fs.unlinkSync(mdPath);
  assert.ok(!fs.existsSync(mdPath), 'the .md sibling is gone');
  const r = doctor.runDoctor({ tasksDir: dir });
  const row = r.bodies.find((b) => b.file.includes('1001'));
  assert.strictEqual(row.validate.status, 'OK', 'the JSON body is still valid (only its .md is gone)');
  assert.strictEqual(row.drift.status, 'NONE', 'BLIND SPOT: a missing .md sibling reports drift NONE (not surfaced)');
  assert.strictEqual(r.summary.drift, 0, 'no drift counted for the missing sibling');
  assert.strictEqual(r.exitCode, 0, 'exit code UNCHANGED — deleting a .md escapes drift detection silently');
});

test('LABEL-INDEX — a drifted labels map → MISMATCH + SUGGEST reindex, exit 1', () => {
  const dir = healthyStore();
  assert.strictEqual(doctor.runDoctor({ tasksDir: dir }).labelIndex.status, 'OK', 'OK before the edit');
  const ip = path.join(dir, 'tasks-index.json');
  const idx = JSON.parse(fs.readFileSync(ip, 'utf8'));
  idx.labels = { ghost: ['9999'] }; // no longer matches deriveLabelIndex(idx.tasks)
  fs.writeFileSync(ip, JSON.stringify(idx, null, 2) + '\n');
  const r = doctor.runDoctor({ tasksDir: dir });
  assert.strictEqual(r.labelIndex.status, 'MISMATCH', 'mismatch detected');
  assert.ok(/reindex/.test(r.labelIndex.suggestion), 'suggests reindex');
  assert.strictEqual(r.exitCode, 1, 'exit 1');
});

test('LABEL-INDEX — a MISSING index beside bodies → SUGGEST reindex, exit 1', () => {
  const dir = healthyStore();
  fs.unlinkSync(path.join(dir, 'tasks-index.json'));
  const r = doctor.runDoctor({ tasksDir: dir });
  assert.strictEqual(r.labelIndex.status, 'MISSING', 'missing index detected');
  assert.ok(/reindex/.test(r.labelIndex.suggestion), 'suggests reindex');
  assert.strictEqual(r.exitCode, 1, 'exit 1');
});

test('LABEL-INDEX — a CORRUPT index → SUGGEST reindex, exit 1', () => {
  const dir = healthyStore();
  fs.writeFileSync(path.join(dir, 'tasks-index.json'), '{ broken json');
  const r = doctor.runDoctor({ tasksDir: dir });
  assert.strictEqual(r.labelIndex.status, 'CORRUPT', 'corrupt index detected');
  assert.strictEqual(r.exitCode, 1, 'exit 1');
});

test('OLD-FORMAT — a markdown-only store is DETECTED and migrate is SUGGESTED (never migrates)', () => {
  const dir = oldFormatStore();
  const r = doctor.runDoctor({ tasksDir: dir });
  assert.ok(r.oldFormat && r.oldFormat.detected, 'old-format detected');
  assert.strictEqual(r.oldFormat.bodyCount, 2, 'both markdown bodies counted');
  assert.strictEqual(r.oldFormat.marker, '1002', 'Next ID marker read from task-index.md');
  assert.ok(/tpm-task-migrate\.js/.test(r.oldFormat.suggestion), 'suggests the migrator');
  assert.strictEqual(r.exitCode, 1, 'old-format is a problem → exit 1');
  assert.ok(/SUGGEST migrate/.test(doctor.renderHuman(r)), 'human render suggests migrate');
});

test('READ-ONLY — the doctor writes NOTHING on any fixture (mtime/size/set unchanged)', () => {
  // healthy
  assertReadOnly(healthyStore(), 'healthy');
  // drifted body
  const d1 = healthyStore();
  const bp = model.bodyPathFor(d1, '1000');
  const rec = JSON.parse(fs.readFileSync(bp, 'utf8')); rec.headline = 'drift'; fs.writeFileSync(bp, JSON.stringify(rec, null, 2) + '\n');
  assertReadOnly(d1, 'drifted');
  // invalid record
  const d2 = healthyStore();
  const bp2 = model.bodyPathFor(d2, '1000');
  const rec2 = JSON.parse(fs.readFileSync(bp2, 'utf8')); rec2.state = 'bogus'; fs.writeFileSync(bp2, JSON.stringify(rec2, null, 2) + '\n');
  assertReadOnly(d2, 'invalid');
  // label mismatch
  const d3 = healthyStore();
  const ip = path.join(d3, 'tasks-index.json');
  const idx = JSON.parse(fs.readFileSync(ip, 'utf8')); idx.labels = { x: ['1'] }; fs.writeFileSync(ip, JSON.stringify(idx, null, 2) + '\n');
  assertReadOnly(d3, 'label-mismatch');
  // old-format
  assertReadOnly(oldFormatStore(), 'old-format');
});

test('EXIT CODES — usage errors → 2 (missing flag, unknown flag, unreadable dir)', () => {
  assert.strictEqual(doctor.main([]), 2, 'missing --tasks-dir → 2');
  assert.strictEqual(doctor.main(['--bogus']), 2, 'unknown flag → 2');
  assert.strictEqual(doctor.main(['--tasks-dir']), 2, 'flag needs a value → 2');
  const missing = path.join(os.tmpdir(), 'tpm-doctor-nope-' + Date.now());
  assert.strictEqual(doctor.main(['--tasks-dir', missing]), 2, 'unreadable dir → 2');
  assert.strictEqual(doctor.main(['--help']), 0, '--help → 0');
});

test('EXIT CODES — main() returns 0 on a clean store and 1 on a problem', () => {
  const clean = healthyStore();
  assert.strictEqual(doctor.main(['--tasks-dir', clean, '--json']), 0, 'clean → 0');
  const dir = healthyStore();
  const bp = model.bodyPathFor(dir, '1000');
  const rec = JSON.parse(fs.readFileSync(bp, 'utf8')); rec.headline = ''; fs.writeFileSync(bp, JSON.stringify(rec, null, 2) + '\n');
  assert.strictEqual(doctor.main(['--tasks-dir', dir]), 1, 'invalid body → 1');
});

test('RULING F3 — a null summary/context is LENIENT (validates, NOT flagged invalid)', () => {
  const dir = healthyStore();
  const bp = model.bodyPathFor(dir, '1000');
  const rec = JSON.parse(fs.readFileSync(bp, 'utf8'));
  rec.summary = null; rec.context = null;
  fs.writeFileSync(bp, JSON.stringify(rec, null, 2) + '\n');
  const r = doctor.runDoctor({ tasksDir: dir });
  const row = r.bodies.find((b) => b.id === '1000');
  assert.strictEqual(row.validate.status, 'OK', 'null summary/context is not a validation failure');
});

test('RULING T-Q3 — endAction {action, note, refs:[]} validates OK', () => {
  const dir = healthyStore();
  // task 1002 (the third) was finished → give it a fully-shaped endAction and re-save canonically.
  const rec = model.loadTask(model.bodyPathFor(dir, '1002'));
  rec.endAction = { action: 'shipped', note: 'done', refs: ['#1119', '#1074'] };
  model.saveTask(rec, { tasksDir: dir, render: conv.render, indexRender: conv.renderIndexView });
  const r = doctor.runDoctor({ tasksDir: dir });
  const row = r.bodies.find((b) => b.id === '1002');
  assert.strictEqual(row.validate.status, 'OK', 'endAction with refs:[] validates');
  assert.strictEqual(row.drift.status, 'OK', 're-saved body is in sync (no false drift)');
});

done('task-doctor.test.js');
