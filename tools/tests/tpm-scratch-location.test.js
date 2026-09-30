#!/usr/bin/env node
'use strict';
/**
 * tests/tpm-scratch-location.test.js — test scratch must live OUTSIDE the bundle (under the OS temp dir),
 * so a test run never grows <bundle>/tmp/ (which every bundle-copying / hashing test would then walk).
 *
 * Run: node tools/tests/tpm-scratch-location.test.js   (exit 0 = green)
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mkScratch, scratchRoot, bundleRoot } = require('./lib/scratch');

let n = 0;
function check(name, fn) { fn(); n += 1; process.stdout.write(`  ok - ${name}\n`); }
const real = (p) => fs.realpathSync(p);

check('scratchRoot() is <os.tmpdir()>/tpm-tests/<slug>, not under the bundle', () => {
  const root = scratchRoot();
  assert.ok(fs.statSync(root).isDirectory());
  assert.strictEqual(path.dirname(real(root)), real(path.join(os.tmpdir(), 'tpm-tests')));
  assert.ok(path.relative(real(bundleRoot()), real(root)).startsWith('..'), 'scratch root escapes the bundle: ' + root);
});
check('mkScratch() dirs are unique, exist, and sit under that root (outside <bundle>/tmp)', () => {
  const a = mkScratch('loc'); const b = mkScratch('loc');
  assert.notStrictEqual(a, b);
  for (const d of [a, b]) {
    assert.ok(fs.statSync(d).isDirectory());
    assert.ok(real(d).startsWith(real(scratchRoot()) + path.sep));
    assert.ok(!real(d).startsWith(path.join(real(bundleRoot()), 'tmp')));
  }
});
check('the runner announces the OS-temp scratch location, not tmp/scratch', () => {
  const src = fs.readFileSync(path.join(__dirname, 'run-all.js'), 'utf8');
  assert.ok(!/tmp\/scratch/.test(src.replace(/\/\/.*$/gm, '')), 'run-all.js still references <bundle>/tmp/scratch');
});

process.stdout.write(`\nPASS - ${n}/${n} scratch-location assertions green\n`);
