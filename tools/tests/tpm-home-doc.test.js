#!/usr/bin/env node
/**
 * tests/tpm-home-doc.test.js — unit test for the `tpm home` + `tpm doc` bundle primitives.
 *
 * PURPOSE
 *   Proves the self-locating bundle-root printer (`tpm home`) and the token-resolving doc reader
 *   (`tpm doc`): self-location, TPM_HOME_OVERRIDE pinning, in-content ${TPM_HOME}/%TPM_HOME% resolution,
 *   containment (no `..`/absolute escape), and exit codes. No `claude`, no network — child-processes
 *   the scripts and drives their pure helpers against a synthetic bundle in os.tmpdir().
 *
 * HOW TO RUN
 *   node tools/tests/tpm-home-doc.test.js   # exit 0 = all assertions green
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOLS = path.resolve(__dirname, '..');            // tests/ -> tools/
const HOME = path.join(TOOLS, 'tpm-home.js');
const DOC = path.join(TOOLS, 'tpm-doc.js');
const REAL_BUNDLE = fs.realpathSync(path.resolve(TOOLS, '..')); // tools/ -> bundle root (self-located)

// Run a script with args + optional env override; capture {status, out, err}.
function run(script, args, override) {
  const env = { ...process.env };
  delete env.TPM_HOME_OVERRIDE;
  if (override !== undefined) env.TPM_HOME_OVERRIDE = override;
  const r = spawnSync('node', [script, ...args], { encoding: 'utf8', env });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

let count = 0;
function check(name, fn) { fn(); count += 1; process.stdout.write(`  ✓ ${name}\n`); }

process.stdout.write('tpm-home-doc.test.js\n');

// A synthetic bundle in tmp: a doc that references the home token in its CONTENT.
const fakeBundle = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tpmdoc-')));
fs.writeFileSync(path.join(fakeBundle, 'ref.md'), 'see ${TPM_HOME}/a and %TPM_HOME%/b\n');
fs.mkdirSync(path.join(fakeBundle, 'sub'), { recursive: true });
fs.writeFileSync(path.join(fakeBundle, 'sub', 'nested.md'), 'x ${TPM_HOME}/c\n');

// ── tpm home ────────────────────────────────────────────────────────────────────
check('tpm home → self-locates the real bundle root', () => {
  const r = run(HOME, []);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.out.trim(), REAL_BUNDLE);
});
check('tpm home honors TPM_HOME_OVERRIDE', () => {
  const r = run(HOME, [], fakeBundle);
  assert.strictEqual(r.out.trim(), fakeBundle);
});
check('tpm home --help → exit 0', () => assert.strictEqual(run(HOME, ['--help']).status, 0));

// ── tpm doc ─────────────────────────────────────────────────────────────────────
check('tpm doc resolves BOTH token spellings in content', () => {
  const r = run(DOC, ['ref.md'], fakeBundle);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.out, `see ${fakeBundle}/a and ${fakeBundle}/b\n`);
});
check('tpm doc reads a nested relpath under the bundle', () => {
  const r = run(DOC, ['sub/nested.md'], fakeBundle);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.out, `x ${fakeBundle}/c\n`);
});
check('tpm doc missing file → exit 1', () => {
  const r = run(DOC, ['nope.md'], fakeBundle);
  assert.strictEqual(r.status, 1);
});
check('tpm doc no arg → exit 2', () => {
  const r = run(DOC, [], fakeBundle);
  assert.strictEqual(r.status, 2);
});
check('tpm doc containment: ../ escape → exit 2 (refused)', () => {
  const r = run(DOC, ['../../../../etc/passwd'], fakeBundle);
  assert.strictEqual(r.status, 2);
});
check('tpm doc containment: absolute path outside bundle → exit 2', () => {
  const r = run(DOC, ['/etc/passwd'], fakeBundle);
  assert.strictEqual(r.status, 2);
});

// pure helper
const { resolveContent } = require('../tpm-doc.js');
check('resolveContent replaces both spellings, leaves other text intact', () => {
  assert.strictEqual(resolveContent('a ${TPM_HOME}/x %TPM_HOME%/y z', '/R'), 'a /R/x /R/y z');
  assert.strictEqual(resolveContent('no token', '/R'), 'no token');
});

process.stdout.write(`\nPASS — ${count}/${count} tpm home/doc assertions green\n`);
