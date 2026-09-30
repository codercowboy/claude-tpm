#!/usr/bin/env node
'use strict';
/**
 * tpm-findroot-env.test.js — unit tests for `findRoot` (shared resolver tools/lib/paths.js), design D8 precedence:
 * explicit startDir > $TPM_PROJECT_ROOT > cwd walk-up for `.claude/claude-tpm/`; a bad env value warns and
 * falls through; a walk-up miss warns (and `strict: true` throws). Each case runs findRoot in a CHILD
 * process (own cwd + env, captured stderr) so nothing leaks from the parent's env.
 *
 * Run: node tpm-findroot-env.test.js   (exit 0 = all green)
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MODULE = path.resolve(__dirname, '..', 'lib', 'paths.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log('  ok   - ' + name); }
  catch (e) { failed += 1; console.log('  FAIL - ' + name + '\n         ' + (e && e.message)); }
}

const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-findroot-')));
function mkProject(name) {
  const root = path.join(sandbox, name);
  fs.mkdirSync(path.join(root, '.claude', 'claude-tpm'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sub', 'deeper'), { recursive: true });
  return root;
}
function mkBare(name) {
  const d = path.join(sandbox, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Run `findRoot(<argsExpr>)` in a child with cwd + env (envRoot undefined = TPM_PROJECT_ROOT unset).
function run(cwd, envRoot, argsExpr) {
  const env = { ...process.env };
  delete env.TPM_PROJECT_ROOT;
  if (envRoot !== undefined) env.TPM_PROJECT_ROOT = envRoot;
  const code = `try { process.stdout.write(String(require(${JSON.stringify(MODULE)}).findRoot(${argsExpr || ''}))); }` +
    ` catch (e) { process.stdout.write('THROW:' + e.code + ':' + e.message); }`;
  const r = spawnSync(process.execPath, ['-e', code], { cwd, env, encoding: 'utf8' });
  return { out: r.stdout, err: r.stderr, status: r.status };
}

const projA = mkProject('projA');
const projB = mkProject('projB');
const bare = mkBare('bare');

test('env unset: walk-up from a subfolder finds the nearest marker (unchanged behavior)', () => {
  const r = run(path.join(projA, 'sub', 'deeper'), undefined);
  assert.strictEqual(r.out, projA);
  assert.strictEqual(r.err, '', 'no warning on a normal walk-up');
});

test('env set, no explicit start: returns the env dir even when cwd is elsewhere', () => {
  const r = run(bare, projA);
  assert.strictEqual(r.out, projA);
  assert.strictEqual(r.err, '');
});

test('env set, cwd = a subfolder of ANOTHER project: env still wins', () => {
  const r = run(path.join(projB, 'sub'), projA);
  assert.strictEqual(r.out, projA);
});

test('explicit startDir beats the env', () => {
  const r = run(bare, projA, `{ startDir: ${JSON.stringify(path.join(projB, 'sub'))} }`);
  assert.strictEqual(r.out, projB);
});

test('env pointing at a non-existent dir: ONE warning naming var + value, falls through to walk-up', () => {
  const missing = path.join(sandbox, 'does-not-exist');
  const r = run(path.join(projB, 'sub'), missing);
  assert.strictEqual(r.out, projB);
  const lines = r.err.trim().split('\n');
  assert.strictEqual(lines.length, 1, 'exactly one warning line, got: ' + r.err);
  assert.ok(lines[0].includes('TPM_PROJECT_ROOT'), 'names the var');
  assert.ok(lines[0].includes(missing), 'names the value');
});

test('env pointing at a FILE (not a dir) is treated as bad: warns + falls through', () => {
  const f = path.join(sandbox, 'afile');
  fs.writeFileSync(f, 'x');
  const r = run(path.join(projA, 'sub'), f);
  assert.strictEqual(r.out, projA);
  assert.ok(r.err.includes('TPM_PROJECT_ROOT'));
});

test('walk-up miss: returns the start folder (back-compat) AND warns once naming the marker + folder', () => {
  const r = run(bare, undefined);
  assert.strictEqual(r.out, bare);
  const lines = r.err.trim().split('\n');
  assert.strictEqual(lines.length, 1, 'exactly one warning line, got: ' + r.err);
  assert.ok(lines[0].includes('.claude/claude-tpm'), 'says which marker was not found');
  assert.ok(lines[0].includes(bare), 'says which folder is being used');
});

test('walk-up miss with explicit startDir: same loud behavior, returns that dir', () => {
  const r = run(projA, undefined, `{ startDir: ${JSON.stringify(bare)} }`);
  assert.strictEqual(r.out, bare);
  assert.ok(r.err.includes(bare));
});

test('strict: true turns a walk-up miss into a hard error (ETPM_NO_PROJECT_ROOT)', () => {
  const r = run(bare, undefined, '{ strict: true }');
  assert.ok(r.out.startsWith('THROW:ETPM_NO_PROJECT_ROOT:'), r.out);
  assert.ok(r.out.includes(bare));
});

test('strict: true does not throw when the env supplies a valid root', () => {
  const r = run(bare, projA, '{ strict: true }');
  assert.strictEqual(r.out, projA);
});

test('quiet: true suppresses the miss warning (still returns the start folder)', () => {
  const r = run(bare, undefined, '{ quiet: true }');
  assert.strictEqual(r.out, bare);
  assert.strictEqual(r.err, '');
});

test('a custom marker ignores the env (env answers only "which project", not "where is X")', () => {
  fs.writeFileSync(path.join(projB, 'package.json'), '{}');
  const r = run(path.join(projB, 'sub'), projA, `{ marker: 'package.json' }`);
  assert.strictEqual(r.out, projB);
});

// ── warn-once (punchlist 7.1b): a CLI call that resolves the root twice prints each warning ONCE ──────────────
// Both copies (shared lib + session suite-local) carry the identical change, so both are exercised.
const MODULES = [MODULE, path.resolve(__dirname, '..', 'session', 'tpm-session-paths.js')];
function runTwice(mod, cwd, envRoot, argsExpr) {
  const env = { ...process.env };
  delete env.TPM_PROJECT_ROOT;
  if (envRoot !== undefined) env.TPM_PROJECT_ROOT = envRoot;
  const code = `const f = require(${JSON.stringify(mod)}).findRoot; const a = f(${argsExpr || ''}); const b = f(${argsExpr || ''});` +
    ` process.stdout.write(a + '|' + b);`;
  const r = spawnSync(process.execPath, ['-e', code], { cwd, env, encoding: 'utf8' });
  return { out: r.stdout, err: r.stderr, status: r.status };
}
for (const mod of MODULES) {
  const tag = path.basename(mod);
  test(`${tag}: bad-env warning prints once when findRoot is called twice in one process`, () => {
    const missing = path.join(sandbox, 'does-not-exist-twice');
    const r = runTwice(mod, path.join(projB, 'sub'), missing);
    assert.strictEqual(r.out, `${projB}|${projB}`);
    const lines = r.err.trim().split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1, 'exactly one warning for two calls, got: ' + r.err);
    assert.ok(lines[0].includes('TPM_PROJECT_ROOT') && lines[0].includes(missing));
  });
  test(`${tag}: walk-up-miss warning prints once when findRoot is called twice in one process`, () => {
    const r = runTwice(mod, bare, undefined);
    assert.strictEqual(r.out, `${bare}|${bare}`);
    const lines = r.err.trim().split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1, 'exactly one warning for two calls, got: ' + r.err);
    assert.ok(lines[0].includes(bare));
  });
  test(`${tag}: two DIFFERENT warnings in one process each still print once`, () => {
    const other = mkBare('bare-other-' + tag.replace(/\W/g, ''));
    const code = `const f = require(${JSON.stringify(mod)}).findRoot;` +
      ` f({ startDir: ${JSON.stringify(bare)} }); f({ startDir: ${JSON.stringify(other)} }); f({ startDir: ${JSON.stringify(bare)} });`;
    const r = spawnSync(process.execPath, ['-e', code], { cwd: bare, encoding: 'utf8' });
    assert.strictEqual(r.stderr.trim().split('\n').length, 2, r.stderr);
  });
}

console.log(`\ntpm-findroot-env.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
