#!/usr/bin/env node
/**
 * test.js — unit test for tpm-consumer-uninstall.js. Zero-dep (node `assert`), no `claude`/`npm`
 * spawned: every case drives the tool's exported PURE helpers directly, or (for the arg flag-guard's
 * process.exit path) spawns the tool as a child and asserts the exit code. Temp fixtures under
 * os.tmpdir(), cleaned up.
 *
 * Covers, over uninstall's exported surface:
 *   - parsePluginList (fix b) — the JSON→state mapping spun out of pluginState
 *   - parseArgs flag-guard (fix c) — --dir rejects a missing value or a "-"-leading value (exit 2)
 *   - hasTpmDependency, readPackageJson
 *
 * Usage: node tools/consumer/tests/tpm-consumer-uninstall/test.js   → exit 0 all pass, 1 otherwise.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { mkScratch } = require('../../../tests/lib/scratch'); // shared: <bundle>/tmp/scratch/<run-slug>/

const TOOL = path.resolve(__dirname, '..', '..', 'tpm-consumer-uninstall.js');
const uninst = require(TOOL);
const { PLUGIN_ID, TPM_PKG_NAME } = uninst;

let pass = 0; let fail = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ✓ ${name}\n`); pass += 1; }
  catch (e) { process.stdout.write(`  ✗ ${name}\n      ${e.message}\n`); fail += 1; }
}

function captureStderr(fn) {
  const orig = process.stderr.write;
  let buf = '';
  process.stderr.write = (chunk) => { buf += chunk; return true; };
  try { const ret = fn(); return { ret, warned: buf }; }
  finally { process.stderr.write = orig; }
}

// Fixtures live under <bundle>/tmp/scratch/<run-slug>/ (shared helper) — one isolated, git-ignored
// folder per run, left in place for inspection. Nuke tmp/scratch/ wholesale when you want.
function mkTmp() { return mkScratch('tpm-uninstall-test'); }
function cleanup() { /* no-op: per-run scratch persists for inspection; tmp/ is git-ignored */ }
function writePkg(dir, obj) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(obj)); }

process.stdout.write('tpm-consumer-uninstall.test.js\n');

// ── parsePluginList (fix b) — same mapping contract as install ──────────────────────────────────────
check('parsePluginList: enabled:true entry → {installed:true, enabled:true}', () => {
  assert.deepStrictEqual(uninst.parsePluginList([{ id: PLUGIN_ID, scope: 'project', enabled: true }]),
    { installed: true, enabled: true });
});
check('parsePluginList: enabled:false entry → {installed:true, enabled:false}', () => {
  assert.deepStrictEqual(uninst.parsePluginList([{ id: PLUGIN_ID, enabled: false }]),
    { installed: true, enabled: false });
});
check('parsePluginList: no matching entry → not installed', () => {
  assert.deepStrictEqual(uninst.parsePluginList([{ id: 'other@market', enabled: true }]),
    { installed: false, enabled: false });
});
check('parsePluginList: empty array → not installed', () => {
  assert.deepStrictEqual(uninst.parsePluginList([]), { installed: false, enabled: false });
});
check('parsePluginList: null → not installed, no warn', () => {
  const { ret, warned } = captureStderr(() => uninst.parsePluginList(null));
  assert.deepStrictEqual(ret, { installed: false, enabled: false });
  assert.strictEqual(warned, '');
});
check('parsePluginList: non-array → warn + fallback not-installed', () => {
  const { ret, warned } = captureStderr(() => uninst.parsePluginList('nope'));
  assert.deepStrictEqual(ret, { installed: false, enabled: false });
  assert.ok(/JSON array/i.test(warned));
});
check('parsePluginList: entries missing `id` → warn + fallback not-installed', () => {
  const { ret, warned } = captureStderr(() => uninst.parsePluginList([{ enabled: true }]));
  assert.deepStrictEqual(ret, { installed: false, enabled: false });
  assert.ok(/id/i.test(warned));
});
check('parsePluginList: matched entry missing boolean enabled → installed+enabled + warn', () => {
  const { ret, warned } = captureStderr(() => uninst.parsePluginList([{ id: PLUGIN_ID }]));
  assert.deepStrictEqual(ret, { installed: true, enabled: true });
  assert.ok(/enabled/i.test(warned));
});
check('parsePluginList: only user-scoped entry → not installed', () => {
  assert.deepStrictEqual(uninst.parsePluginList([{ id: PLUGIN_ID, scope: 'user', enabled: true }]),
    { installed: false, enabled: false });
});
check('parsePluginList: scope absent → still matched', () => {
  assert.deepStrictEqual(uninst.parsePluginList([{ id: PLUGIN_ID, enabled: false }]),
    { installed: true, enabled: false });
});

// ── parseArgs — positional <dir> + --dir flag + flag-guards (mirrors install) ───────────────────────
function runTool(args) {
  const r = spawnSync('node', [TOOL, ...args], { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
check('parseArgs: no args → dir defaults to cwd', () => {
  assert.strictEqual(uninst.parseArgs([]).dir, process.cwd());
});
check('parseArgs: positional dir → dir (mirrors install; `tpm uninstall <dir>` must work via the dispatcher)', () => {
  assert.strictEqual(uninst.parseArgs(['../proj']).dir, '../proj');
});
check('parseArgs: --dir <path> parses', () => {
  assert.strictEqual(uninst.parseArgs(['--dir', '../p']).dir, '../p');
});
check('flag-guard: `--dir` with no value → exit 2', () => {
  assert.strictEqual(runTool(['--dir']).status, 2);
});
check('flag-guard: `--dir -x` (value starts with `-`) → exit 2', () => {
  assert.strictEqual(runTool(['--dir', '-x']).status, 2);
});
check('flag-guard: unknown argument → exit 2', () => {
  assert.strictEqual(runTool(['--bogus']).status, 2);
});

// ── hasTpmDependency ────────────────────────────────────────────────────────────────────────────────
check('hasTpmDependency: dependencies → true', () => {
  assert.strictEqual(uninst.hasTpmDependency({ dependencies: { [TPM_PKG_NAME]: '1.0.0' } }), true);
});
check('hasTpmDependency: optionalDependencies → true', () => {
  assert.strictEqual(uninst.hasTpmDependency({ optionalDependencies: { [TPM_PKG_NAME]: 'file:x' } }), true);
});
check('hasTpmDependency: absent → false', () => {
  assert.strictEqual(uninst.hasTpmDependency({ dependencies: { lodash: '^4' } }), false);
});
check('hasTpmDependency: null pkg → false', () => {
  assert.strictEqual(uninst.hasTpmDependency(null), false);
});

// ── readPackageJson ─────────────────────────────────────────────────────────────────────────────────
check('readPackageJson: exists + valid', () => {
  const dir = mkTmp();
  writePkg(dir, { name: 'consumer', version: '9.9.9' });
  const r = uninst.readPackageJson(dir);
  assert.strictEqual(r.exists, true);
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.value.version, '9.9.9');
});
check('readPackageJson: exists + invalid JSON → error string, null value', () => {
  const dir = mkTmp();
  fs.writeFileSync(path.join(dir, 'package.json'), 'not json');
  const r = uninst.readPackageJson(dir);
  assert.strictEqual(r.exists, true);
  assert.strictEqual(r.value, null);
  assert.ok(typeof r.error === 'string' && r.error.length > 0);
});
check('readPackageJson: absent → {exists:false, value:null, error:null}', () => {
  assert.deepStrictEqual(uninst.readPackageJson(mkTmp()), { exists: false, value: null, error: null });
});

cleanup();
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
