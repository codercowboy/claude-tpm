'use strict';
/**
 * session-doctor.test.js — the READ-ONLY session doctor (tpm-session-doctor.js, #1119 + #1114 A/D).
 *
 * Runs entirely against SCRATCH fixture dirs built under os.tmpdir() (never the live sessions tree,
 * never the sandbox fixtures in place — the P03 legacy inputs are COPIED out). Covers the §B4
 * matrix:
 *   - valid in-sync (json + md, hash matches)         → OK, exit 0
 *   - schema-invalid (empty handoff.where)            → FAIL[validate], exit ≠0
 *   - unknown-newer (schemaVersion 2.0.0)             → FAIL[migrate], exit ≠0
 *   - corrupt json (non-JSON bytes)                   → FAIL[read], exit ≠0
 *   - drift (md (generated from: …) ≠ recompute of current json) → DRIFT advisory, exit 0, --strict→≠0
 *   - unstamped md (no (generated from: …) token)                 → UNSTAMPED advisory
 *   - old-format present (marked 3-file, no json)     → migrate suggestion + count, no convert
 *   - old-format not-auto-migratable (refusal shape)  → advisory naming the reason, no convert
 *   - number-form (non-canonical meta.number)         → WARN advisory
 *   - STRICTLY READ-ONLY: byte-snapshot before/after all runs — every file identical, none
 *     created/deleted (the definitive read-only proof, over a dir with old-format + drift cases).
 *
 * Run: node tests/session-doctor.test.js   (also auto-discovered by run-all).
 * Node built-ins only.
 */
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { assert, test, done, throwsMatching, fs, path } = require('./helpers/harness');

const doctor = require('../tpm-session-doctor');
const { render } = require('../lib/session-converter');
const { hashRecord } = require('../../lib/hash');

const TOOL = path.join(__dirname, '..', 'tpm-session-doctor.js');
const FIXTURE = path.join(__dirname, 'golden', 'session-0021.fixture.json');
const LEGACY = path.join(__dirname, 'fixtures', 'legacy');
const GOLDEN_NOW = '2026-09-19T13:36:00-07:00';

function baseRecord() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}
function withNumber(num) {
  const rec = baseRecord();
  rec.meta.number = num;
  return rec;
}
function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-doctor-' + (tag || '') + '-'));
}
function writeJson(dir, num, rec) {
  fs.writeFileSync(path.join(dir, `session-${num}.json`), JSON.stringify(rec, null, 2) + '\n');
}
function writeMd(dir, num, text) {
  fs.writeFileSync(path.join(dir, `session-${num}.md`), text);
}
// CANONICAL NESTED layout (Q-F): mkdir <store>/session-<num>/ and return it, so a session's
// session-<num>.{json,md} land in that session's OWN per-session folder.
function nest(store, num) {
  const d = path.join(store, `session-${num}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
// The nested report key for a session (how runDoctor labels a discovered nested session).
function nkey(num) { return path.join(`session-${num}`, `session-${num}.json`); }
function copyLegacyInto(destDir, legacyName) {
  const src = path.join(LEGACY, legacyName);
  fs.mkdirSync(destDir, { recursive: true });
  for (const n of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, n), path.join(destDir, n));
  }
}

// A rich fixture dir exercising EVERY case (incl. hard FAILs).
function buildRichDir() {
  const dir = tmpDir('rich');

  // valid, in sync
  const ok = withNumber('0021');
  writeJson(nest(dir, '0021'), '0021', ok);
  writeMd(nest(dir, '0021'), '0021', render(ok, { now: GOLDEN_NOW }));

  // drift: render md from A, then overwrite json with a mutated B (test setup, not the doctor)
  const a = withNumber('0031');
  writeJson(nest(dir, '0031'), '0031', a);
  writeMd(nest(dir, '0031'), '0031', render(a, { now: GOLDEN_NOW })); // banner carries hash(A)
  const b = withNumber('0031');
  b.handoff.where = 'MUTATED on disk after the .md was rendered';
  writeJson(nest(dir, '0031'), '0031', b); // current json = B; hash(B) ≠ banner hash(A) → DRIFT

  // unstamped md (strip the (generated from: …) token from a real render)
  const u = withNumber('0035');
  writeJson(nest(dir, '0035'), '0035', u);
  writeMd(nest(dir, '0035'), '0035', render(u, { now: GOLDEN_NOW }).replace(/ \(generated from: [0-9a-f]{12}\)/, ''));

  // number-form WARN: canonical filename, non-canonical stored number
  writeJson(nest(dir, '0036'), '0036', withNumber('36'));

  // schema-invalid: handoff present but where empty
  const bad = withNumber('0032');
  bad.handoff.where = '';
  writeJson(nest(dir, '0032'), '0032', bad);

  // unknown-newer schemaVersion
  const newer = withNumber('0033');
  newer.schemaVersion = '2.0.0';
  writeJson(nest(dir, '0033'), '0033', newer);

  // corrupt json
  fs.writeFileSync(path.join(nest(dir, '0034'), 'session-0034.json'), '{ this is not valid json ');

  // old-format present (marked 3-file, no json) → migrate suggestion
  copyLegacyInto(path.join(dir, 'session-0007-clean'), 'session-0007-clean');

  // old-format not-auto-migratable (2-file refusal shape) → advisory
  copyLegacyInto(path.join(dir, 'session-011-2file'), 'refuse-2file');

  return dir;
}

// An advisories-only dir (NO hard FAILs) for the exit-code semantics.
function buildAdvisoryDir() {
  const dir = tmpDir('adv');
  const a = withNumber('0031');
  writeJson(nest(dir, '0031'), '0031', a);
  writeMd(nest(dir, '0031'), '0031', render(a, { now: GOLDEN_NOW }));
  const b = withNumber('0031');
  b.handoff.next = 'mutated';
  writeJson(nest(dir, '0031'), '0031', b); // DRIFT
  copyLegacyInto(path.join(dir, 'session-0007-clean'), 'session-0007-clean'); // old-format
  return dir;
}

// A NESTED per-session-dir store — the CANONICAL layout per json-format-spec §"On-disk naming +
// location" and the live store's real shape: sessions/session-<NNNN>/session-<NNNN>.json (+ the
// sibling session-<NNNN>.md). Contains (a) a valid in-sync nested session and (b) a nested session
// whose JSON was hand-edited AFTER the .md was rendered, so hash-drift MUST be reported. This is the
// exact case the r1 doctor reported as "0 sessions · exit 0 healthy" (verifier C1).
function buildNestedDir() {
  const dir = tmpDir('nested');

  // (a) valid nested session, in sync
  const okDir = path.join(dir, 'session-0021');
  fs.mkdirSync(okDir, { recursive: true });
  const ok = withNumber('0021');
  writeJson(okDir, '0021', ok);
  writeMd(okDir, '0021', render(ok, { now: GOLDEN_NOW }));

  // (b) nested session whose JSON was hand-edited after the .md was rendered → hash drift
  const driftDir = path.join(dir, 'session-0031');
  fs.mkdirSync(driftDir, { recursive: true });
  const a = withNumber('0031');
  writeMd(driftDir, '0031', render(a, { now: GOLDEN_NOW })); // banner carries hash(A)
  const b = withNumber('0031');
  b.handoff.where = 'HAND-EDITED on disk after the .md was rendered';
  writeJson(driftDir, '0031', b); // current json = B; hash(B) ≠ banner hash(A) → DRIFT

  return dir;
}

function byName(results, file) {
  return results.find((r) => r.file === file);
}

// ── VALIDATION + DRIFT + NUMBER-FORM (the §B4 matrix) ────────────────────────

test('MATRIX: runDoctor classifies every case correctly', () => {
  const dir = buildRichDir();
  try {
    const report = doctor.runDoctor({ sessionsDir: dir });

    assert.strictEqual(byName(report.results, nkey('0021')).validate.status, 'OK', 'valid in-sync OK');
    assert.strictEqual(byName(report.results, nkey('0021')).drift.status, 'OK', 'in-sync drift OK');

    const drift = byName(report.results, nkey('0031'));
    assert.strictEqual(drift.validate.status, 'OK', 'drifted record is still schema-valid');
    assert.strictEqual(drift.drift.status, 'DRIFT', 'mutated-on-disk json drifts from its .md banner');
    assert.notStrictEqual(drift.drift.bannerHash, drift.drift.currentHash, 'banner hash ≠ current hash');

    assert.strictEqual(byName(report.results, nkey('0035')).drift.status, 'UNSTAMPED', 'md with no token is UNSTAMPED');

    assert.strictEqual(byName(report.results, nkey('0036')).numberForm.status, 'WARN', 'non-canonical meta.number WARNs');

    const invalid = byName(report.results, nkey('0032'));
    assert.strictEqual(invalid.validate.status, 'FAIL', 'empty handoff.where fails');
    assert.strictEqual(invalid.validate.stage, 'validate', 'labeled at the validate stage');
    assert.ok(/handoff\.where/.test(invalid.validate.problem), 'names the offending field');

    const newer = byName(report.results, nkey('0033'));
    assert.strictEqual(newer.validate.status, 'FAIL', 'unknown-newer fails');
    assert.strictEqual(newer.validate.stage, 'migrate', 'labeled at the migrate stage');
    assert.ok(/2\.0\.0/.test(newer.validate.problem), 'refusal names the version');

    const corrupt = byName(report.results, nkey('0034'));
    assert.strictEqual(corrupt.validate.status, 'FAIL', 'corrupt json fails');
    assert.strictEqual(corrupt.validate.stage, 'read', 'labeled at the read stage');

    // old-format
    const migratable = report.oldFormat.find((o) => o.migratable);
    assert.ok(migratable, 'a migratable old-format session detected');
    assert.ok(/tpm-session-migrate\.js --in/.test(migratable.suggestion), 'suggestion names the real migrator');
    assert.strictEqual(migratable.number, '0007', 'detected number from the marked filenames');
    const refused = report.oldFormat.find((o) => !o.migratable);
    assert.ok(refused, 'a not-auto-migratable old-format dir is reported');
    assert.ok(refused.reason && refused.reason.length, 'refusal reason is carried');

    assert.strictEqual(report.summary.invalid, 3, 'three hard FAILs (schema/newer/corrupt)');
    assert.strictEqual(report.summary.migratable, 1, 'one auto-migratable old-format session');
    assert.strictEqual(report.exitCode, 1, 'a hard FAIL → exit 1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── NESTED PER-SESSION-DIR LAYOUT (C1 regression) ────────────────────────────
// The canonical layout per json-format-spec §"On-disk naming + location". The r1 doctor scanned
// canonical JSON ONLY flat at the top, so against a nested store with a drifted JSON it reported
// "0 session(s) · 0 valid · 0 drift" and exited 0 — inspecting nothing while claiming healthy. This
// asserts the doctor now discovers nested sessions and flags the drift.
test('NESTED: doctor discovers per-session-dir sessions and flags a drifted one (C1 regression)', () => {
  const dir = buildNestedDir();
  try {
    const report = doctor.runDoctor({ sessionsDir: dir });

    // the false-healthy bug: the pre-fix doctor reported 0 sessions here.
    assert.strictEqual(report.summary.sessions, 2, 'both nested sessions discovered (not 0)');

    const ok = byName(report.results, path.join('session-0021', 'session-0021.json'));
    assert.ok(ok, 'the valid nested session is found');
    assert.strictEqual(ok.validate.status, 'OK', 'valid nested session validates');
    assert.strictEqual(ok.drift.status, 'OK', 'in-sync nested session is not drifted');

    const drift = byName(report.results, path.join('session-0031', 'session-0031.json'));
    assert.ok(drift, 'the drifted nested session is found (not silently skipped)');
    assert.strictEqual(drift.validate.status, 'OK', 'hand-edited record is still schema-valid');
    assert.strictEqual(drift.drift.status, 'DRIFT', 'hand-edited nested json drifts from its .md banner');
    assert.notStrictEqual(drift.drift.bannerHash, drift.drift.currentHash, 'banner hash ≠ current hash');

    assert.strictEqual(report.summary.drift, 1, 'exactly one drift reported');
    assert.strictEqual(report.summary.invalid, 0, 'no hard FAILs in this store');
    assert.strictEqual(report.exitCode, 0, 'advisory-only nested store exits 0');

    // still STRICTLY READ-ONLY against the nested layout (byte-snapshot proof holds)
    const before = snapshot(dir);
    doctor.runDoctor({ sessionsDir: dir });
    doctor.runDoctor({ sessionsDir: dir, strict: true });
    const after = snapshot(dir);
    assert.deepStrictEqual(Object.keys(after).sort(), Object.keys(before).sort(),
      'no nested file created or deleted by the doctor');
    for (const k of Object.keys(before)) {
      assert.strictEqual(after[k], before[k], `nested file byte-identical after doctor runs: ${k}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── EXIT CODES ────────────────────────────────────────────────────────────────

test('EXIT: advisories alone exit 0; --strict promotes them to 2', () => {
  const dir = buildAdvisoryDir();
  try {
    const lax = doctor.runDoctor({ sessionsDir: dir });
    assert.strictEqual(lax.summary.invalid, 0, 'no hard FAILs');
    assert.ok(lax.summary.drift >= 1 && lax.summary.oldFormat >= 1, 'has advisories (drift + old-format)');
    assert.strictEqual(lax.exitCode, 0, 'advisories alone → exit 0');

    const strict = doctor.runDoctor({ sessionsDir: dir, strict: true });
    assert.strictEqual(strict.exitCode, 2, '--strict promotes an advisory to exit 2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('EXIT: --strict still exits 1 (not 2) when there is a hard FAIL', () => {
  const dir = buildRichDir();
  try {
    const strict = doctor.runDoctor({ sessionsDir: dir, strict: true });
    assert.strictEqual(strict.exitCode, 1, 'a hard FAIL dominates --strict');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── STRICTLY READ-ONLY (the definitive proof) ────────────────────────────────

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

test('READ-ONLY: no file created, deleted, or mutated across default/--json/--strict runs', () => {
  const dir = buildRichDir();
  try {
    const before = snapshot(dir);

    // exercise all three modes via the in-process API AND the real CLI process
    doctor.runDoctor({ sessionsDir: dir });
    doctor.runDoctor({ sessionsDir: dir, strict: true });
    for (const args of [['--sessions-dir', dir], ['--sessions-dir', dir, '--json'], ['--sessions-dir', dir, '--strict']]) {
      spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
    }

    const after = snapshot(dir);
    assert.deepStrictEqual(Object.keys(after).sort(), Object.keys(before).sort(),
      'no file created or deleted by the doctor');
    for (const k of Object.keys(before)) {
      assert.strictEqual(after[k], before[k], `file byte-identical after doctor runs: ${k}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── CLI surface ────────────────────────────────────────────────────────────────

test('CLI: exits non-zero and prints a FAIL line for an invalid store; JSON mode parses', () => {
  const dir = buildRichDir();
  try {
    const human = spawnSync(process.execPath, [TOOL, '--sessions-dir', dir], { encoding: 'utf8' });
    assert.strictEqual(human.status, 1, 'CLI exits 1 on a hard FAIL');
    assert.ok(/session-0034\.json\s+FAIL \[read\]/.test(human.stdout), 'human report shows the read FAIL');
    assert.ok(/tpm-session-migrate\.js --in/.test(human.stdout), 'human report shows the migrate suggestion');

    const j = spawnSync(process.execPath, [TOOL, '--sessions-dir', dir, '--json'], { encoding: 'utf8' });
    assert.strictEqual(j.status, 1, 'JSON mode exits 1 too');
    const parsed = JSON.parse(j.stdout);
    assert.strictEqual(parsed.exitCode, 1, 'JSON report carries the exit code');
    assert.ok(Array.isArray(parsed.results) && parsed.oldFormat, 'JSON report shape');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --sessions-dir is required (no default); --help exits 0', () => {
  const missing = spawnSync(process.execPath, [TOOL], { encoding: 'utf8' });
  assert.notStrictEqual(missing.status, 0, 'missing --sessions-dir is a non-zero exit');
  const help = spawnSync(process.execPath, [TOOL, '--help'], { encoding: 'utf8' });
  assert.strictEqual(help.status, 0, '--help exits 0');
  assert.ok(/READ-ONLY/.test(help.stdout), 'usage advertises read-only');
});

test('API: runDoctor throws loud without a sessionsDir', () => {
  throwsMatching(() => doctor.runDoctor({}), /sessionsDir is required/, 'no default sessions dir');
});

done('session-doctor.test.js');
