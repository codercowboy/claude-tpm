'use strict';
/**
 * task-router-doctor-migrate.test.js — the `tpm task doctor` / `tpm task migrate` routing
 * (#1123 Stage C gap-fix). Before this, doctor + migrate were node-invokable but UNROUTED — a
 * `tpm task doctor` fell through to tpm-task.js as an unknown verb (exit 2). This suite pins the
 * new router entries (symmetric with the session router) AND the preserved fall-through for real
 * ledger subcommands + unknown verbs.
 *
 * Zero-dep inline harness; drives the router as a subprocess (real child-process dispatch + exit
 * codes). Exits non-zero on any failure.
 *
 * Run: node tests/task-router-doctor-migrate.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const router = require('../tpm-task-router.js');
const t = require('../tpm-task.js');
const ROUTER = path.join(__dirname, '..', 'tpm-task-router.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   - ' + name); }
  catch (e) {
    failed++;
    const detail = e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n         ') : String(e);
    console.log('  FAIL - ' + name + '\n         ' + detail);
  }
}
function done(suite) { console.log(`\n${suite}: ${passed} passed, ${failed} failed`); if (failed > 0) process.exit(1); }
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-router-')); }
function run(args) {
  const r = spawnSync(process.execPath, [ROUTER, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function seed() { const dir = tmpDir(); t.opAdd({ tasksDir: dir, headline: 'router probe' }); return dir; }

// ── the router table exposes the new targets ─────────────────────────────────────

test('router exports DOCTOR + MIGRATE targets', () => {
  assert.strictEqual(router.DOCTOR, 'tpm-task-doctor.js');
  assert.strictEqual(router.MIGRATE, 'tpm-task-migrate.js');
});

// ── doctor routes to the health checker ──────────────────────────────────────────

test('`doctor` reaches tpm-task-doctor.js (its banner + exit 0)', () => {
  const dir = seed();
  const r = run(['doctor', '--tasks-dir', dir]);
  assert.strictEqual(r.code, 0, 'a clean store passes the doctor');
  assert.ok(/task doctor/.test(r.stdout), 'the doctor banner proves the route reached tpm-task-doctor.js');
});

// ── migrate routes to the migrator ───────────────────────────────────────────────

test('`migrate --help` reaches tpm-task-migrate.js (its usage + exit 0)', () => {
  const r = run(['migrate', '--help']);
  assert.strictEqual(r.code, 0);
  assert.ok(/tpm-task-migrate/.test(r.stdout), 'the migrate usage proves the route reached tpm-task-migrate.js');
});

// ── regressions: real subcommands + config still route; unknown still falls through ──

test('`config --get history.enabled` still routes to tpm-task-config.js', () => {
  const r = run(['config', '--get', 'history.enabled']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout.trim(), 'true');
});

test('a real ledger verb (`list`) still passes through to tpm-task.js', () => {
  const dir = seed();
  const r = run(['list', '--state', 'all', '--tasks-dir', dir]);
  assert.strictEqual(r.code, 0);
  assert.ok(/router probe/.test(r.stdout), 'the seeded task renders → tpm-task.js handled list');
});

test('an unknown verb still falls through to tpm-task.js (exit 2)', () => {
  const r = run(['bogus', '--tasks-dir', tmpDir()]);
  assert.strictEqual(r.code, 2);
  assert.ok(/unknown verb 'bogus'/.test(r.stderr));
});

done('task-router-doctor-migrate.test');
