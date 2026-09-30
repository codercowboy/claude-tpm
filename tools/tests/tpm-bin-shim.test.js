#!/usr/bin/env node
/**
 * tests/tpm-bin-shim.test.js — behavioral test for bin/tpm (the PATH shim over tools/tpm.js).
 * Covers: cwd independence, args with spaces, exit-code propagation, bundle-dir symlink, shim-file symlink.
 * HOW TO RUN: node tools/tests/tpm-bin-shim.test.js   (exit 0 = green)
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BUNDLE = path.resolve(__dirname, '..', '..');
const SHIM = path.join(BUNDLE, 'bin', 'tpm');
const DISPATCH = path.join(BUNDLE, 'tools', 'tpm.js');

let count = 0;
function check(name, fn) { fn(); count++; process.stdout.write(`  ✓ ${name}\n`); }
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

process.stdout.write('tpm-bin-shim.test.js\n');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-shim-'));
const real = fs.realpathSync(BUNDLE);

check('shim is executable', () => {
  assert(fs.statSync(SHIM).mode & 0o111, 'bin/tpm not executable');
});
check('`tpm home` from an unrelated cwd prints the bundle root', () => {
  const r = run(SHIM, ['home'], tmp);
  assert.strictEqual(r.status, 0, r.err);
  assert.strictEqual(fs.realpathSync(r.out.trim()), real);
});
check('args with spaces pass through intact', () => {
  const via = run(SHIM, ['no such suite', 'a b'], tmp);
  const direct = run('node', [DISPATCH, 'no such suite', 'a b'], tmp);
  assert.notStrictEqual(via.status, 0);
  assert(via.err.includes('no such suite') || via.out.includes('no such suite'), 'spaced arg lost: ' + via.err + via.out);
  assert.strictEqual(via.err + via.out, direct.err + direct.out);
});
check('dispatcher exit code propagates (unknown suite)', () => {
  const via = run(SHIM, ['definitely-not-a-suite'], tmp);
  const direct = run('node', [DISPATCH, 'definitely-not-a-suite'], tmp);
  assert.notStrictEqual(direct.status, 0);
  assert.strictEqual(via.status, direct.status);
  const ok = run(SHIM, ['--help'], tmp);
  assert.strictEqual(ok.status, run('node', [DISPATCH, '--help'], tmp).status);
});
check('works through a SYMLINK to the bundle folder', () => {
  const link = path.join(tmp, 'bundle-link');
  fs.symlinkSync(BUNDLE, link);
  const r = run(path.join(link, 'bin', 'tpm'), ['home'], tmp);
  assert.strictEqual(r.status, 0, r.err);
  assert.strictEqual(fs.realpathSync(r.out.trim()), real);
});
check('works through a symlink to the shim file itself', () => {
  const link = path.join(tmp, 'tpm-link');
  fs.symlinkSync(SHIM, link);
  const r = run(link, ['home'], tmp);
  assert.strictEqual(r.status, 0, r.err);
  assert.strictEqual(fs.realpathSync(r.out.trim()), real);
});

process.stdout.write(`\nPASS — ${count}/${count} tpm-bin-shim assertions green\n`);
