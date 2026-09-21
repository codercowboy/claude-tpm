'use strict';
/**
 * doctor-nested-matrix.test.js (P05) — the FULL doctor state matrix exercised in the CANONICAL
 * NESTED per-session-dir layout (sessions/session-<NNNN>/session-<NNNN>.json + sibling .md), the
 * live store's real shape per the LOCKED json-format-spec §"On-disk naming + location".
 *
 * session-doctor.test.js already carries the C1 regression (a nested VALID + a nested DRIFT). This
 * COMPLEMENTS it by proving the nested-discovery path (added in the P04 r2 bug-fix) also carries the
 * HARD-FAIL and OLD-FORMAT cases through, in ONE nested store:
 *   - valid in-sync nested            → OK, no drift
 *   - drifted nested                  → DRIFT advisory (banner hash ≠ current), still schema-valid
 *   - corrupt nested JSON             → FAIL[read]
 *   - unknown-newer nested JSON       → FAIL[migrate] (names the version)
 *   - old-format nested subdir (no json) → migrate SUGGESTION + count, never converted
 * plus the exit-code semantics and the definitive byte-snapshot READ-ONLY proof over the nested
 * store (default / --json / --strict, in-process AND via the real CLI).
 *
 * Everything runs in SCRATCH dirs (os.tmpdir mkdtemp); the legacy old-format input is COPIED out of
 * the committed fixtures. NEVER the live sessions tree.
 * Run: node tests/doctor-nested-matrix.test.js   (also auto-discovered by run-all).
 * Node built-ins only.
 */
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { assert, test, done, fs, path } = require('./helpers/harness');

const doctor = require('../tpm-session-doctor');
const { render } = require('../lib/session-converter');

const TOOL = path.join(__dirname, '..', 'tpm-session-doctor.js');
const FIXTURE = path.join(__dirname, 'golden', 'session-0021.fixture.json');
const LEGACY = path.join(__dirname, 'fixtures', 'legacy');
const GOLDEN_NOW = '2026-09-19T13:36:00-07:00';

function tmpDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-doctor-nested-' + (tag || '') + '-')); }
function baseRecord() { return JSON.parse(fs.readFileSync(FIXTURE, 'utf8')); }
function withNumber(num) { const r = baseRecord(); r.meta.number = num; return r; }
function writeJson(dir, num, rec) { fs.writeFileSync(path.join(dir, `session-${num}.json`), JSON.stringify(rec, null, 2) + '\n'); }
function writeMd(dir, num, text) { fs.writeFileSync(path.join(dir, `session-${num}.md`), text); }
function nestDir(root, num) { const d = path.join(root, `session-${num}`); fs.mkdirSync(d, { recursive: true }); return d; }
function copyLegacyInto(destDir, legacyName) {
  const src = path.join(LEGACY, legacyName);
  fs.mkdirSync(destDir, { recursive: true });
  for (const n of fs.readdirSync(src)) fs.copyFileSync(path.join(src, n), path.join(destDir, n));
}

// A NESTED store carrying every state class in its own per-session dir.
function buildNestedMatrix() {
  const root = tmpDir('matrix');

  // valid, in sync
  const okDir = nestDir(root, '0021');
  const ok = withNumber('0021');
  writeJson(okDir, '0021', ok);
  writeMd(okDir, '0021', render(ok, { now: GOLDEN_NOW }));

  // drift: .md banner from A, current json = mutated B
  const driftDir = nestDir(root, '0031');
  const a = withNumber('0031');
  writeMd(driftDir, '0031', render(a, { now: GOLDEN_NOW })); // banner carries hash(A)
  const b = withNumber('0031');
  b.handoff.where = 'HAND-EDITED nested json after the .md was rendered';
  writeJson(driftDir, '0031', b); // current json = B → hash(B) ≠ banner hash(A) → DRIFT

  // unknown-newer schemaVersion, nested
  const newerDir = nestDir(root, '0033');
  const newer = withNumber('0033');
  newer.schemaVersion = '2.0.0';
  writeJson(newerDir, '0033', newer);

  // corrupt json, nested
  const corruptDir = nestDir(root, '0034');
  fs.writeFileSync(path.join(corruptDir, 'session-0034.json'), '{ this is not valid json ');

  // old-format nested subdir (marked 3-file, NO json) → migrate suggestion
  copyLegacyInto(path.join(root, 'session-0007-clean'), 'session-0007-clean');

  return root;
}

function byFile(results, file) { return results.find((r) => r.file === file); }
function nestedKey(num) { return path.join(`session-${num}`, `session-${num}.json`); }

function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else out[path.relative(root, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}

// ── the nested full matrix ─────────────────────────────────────────────────────

test('NESTED MATRIX: valid / drift / corrupt / unknown-newer / old-format each get the right verdict', () => {
  const root = buildNestedMatrix();
  try {
    const report = doctor.runDoctor({ sessionsDir: root });

    // four canonical nested sessions discovered (valid + drift + newer + corrupt), none silently dropped.
    assert.strictEqual(report.summary.sessions, 4, 'all four nested canonical sessions discovered');

    const ok = byFile(report.results, nestedKey('0021'));
    assert.ok(ok, 'valid nested session found');
    assert.strictEqual(ok.validate.status, 'OK', 'valid nested session validates');
    assert.strictEqual(ok.drift.status, 'OK', 'in-sync nested session is not drifted');

    const drift = byFile(report.results, nestedKey('0031'));
    assert.strictEqual(drift.validate.status, 'OK', 'hand-edited record is still schema-valid');
    assert.strictEqual(drift.drift.status, 'DRIFT', 'hand-edited nested json drifts from its .md banner');
    assert.notStrictEqual(drift.drift.bannerHash, drift.drift.currentHash, 'banner hash ≠ current hash');

    const newer = byFile(report.results, nestedKey('0033'));
    assert.strictEqual(newer.validate.status, 'FAIL', 'unknown-newer nested json fails');
    assert.strictEqual(newer.validate.stage, 'migrate', 'labeled at the migrate stage');
    assert.ok(/2\.0\.0/.test(newer.validate.problem), 'refusal names the newer version');

    const corrupt = byFile(report.results, nestedKey('0034'));
    assert.strictEqual(corrupt.validate.status, 'FAIL', 'corrupt nested json fails');
    assert.strictEqual(corrupt.validate.stage, 'read', 'labeled at the read stage');

    // old-format nested subdir (no canonical json) → still detected + a migrate suggestion emitted.
    const migratable = report.oldFormat.find((o) => o.migratable);
    assert.ok(migratable, 'the old-format nested subdir is detected as migratable');
    assert.strictEqual(migratable.number, '0007', 'detected number from the marked filenames');
    assert.ok(/npx tpm session migrate --in/.test(migratable.suggestion), 'suggestion names the real migrator + --in');

    // summary + exit code
    assert.strictEqual(report.summary.invalid, 2, 'two hard FAILs (corrupt + unknown-newer)');
    assert.strictEqual(report.summary.drift, 1, 'exactly one drift');
    assert.strictEqual(report.summary.migratable, 1, 'one auto-migratable old-format subdir');
    assert.strictEqual(report.exitCode, 1, 'a hard FAIL → exit 1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── read-only over the nested layout (definitive byte-snapshot) ─────────────────

test('NESTED READ-ONLY: no nested file created / deleted / mutated across default / --json / --strict', () => {
  const root = buildNestedMatrix();
  try {
    const before = snapshot(root);
    doctor.runDoctor({ sessionsDir: root });
    doctor.runDoctor({ sessionsDir: root, strict: true });
    for (const args of [['--sessions-dir', root], ['--sessions-dir', root, '--json'], ['--sessions-dir', root, '--strict']]) {
      spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
    }
    const after = snapshot(root);
    assert.deepStrictEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'no nested file created or deleted');
    for (const k of Object.keys(before)) {
      assert.strictEqual(after[k], before[k], `nested file byte-identical after doctor runs: ${k}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── CLI over the nested store ────────────────────────────────────────────────────

test('NESTED CLI: exits 1, prints the nested FAIL + the migrate suggestion; --json parses with nested file keys', () => {
  const root = buildNestedMatrix();
  try {
    const human = spawnSync(process.execPath, [TOOL, '--sessions-dir', root], { encoding: 'utf8' });
    assert.strictEqual(human.status, 1, 'CLI exits 1 on the nested hard FAILs');
    assert.ok(/session-0034[\/\\]session-0034\.json\s+FAIL \[read\]/.test(human.stdout), 'human report shows the nested read FAIL with its nested key');
    assert.ok(/npx tpm session migrate --in/.test(human.stdout), 'human report shows the migrate suggestion');

    const j = spawnSync(process.execPath, [TOOL, '--sessions-dir', root, '--json'], { encoding: 'utf8' });
    assert.strictEqual(j.status, 1, 'JSON mode exits 1 too');
    const parsed = JSON.parse(j.stdout);
    assert.ok(parsed.results.some((r) => r.file === nestedKey('0021')), 'JSON report carries the nested file key');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

done('doctor-nested-matrix.test.js');
