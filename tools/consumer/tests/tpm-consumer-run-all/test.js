#!/usr/bin/env node
/**
 * test.js — env isolation of tools/consumer/tests/run-all.js (D8). The runner must strip the invoking
 * session's TPM_PROJECT_ROOT / TPM_HOME from every child suite's env, like the other tools/*\/tests/run-all.js.
 * Decoy-env proof: a probe "suite" that FAILS when either variable is visible is run through the runner with
 * decoys set (must pass), and the same probe run DIRECTLY with the decoys (must fail — proving the decoys
 * really reach a child that is not isolated, so a green runner result means something).
 *
 * Usage: node tools/consumer/tests/tpm-consumer-run-all/test.js   → exit 0 all pass, 1 otherwise.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { mkScratch } = require('../../../tests/lib/scratch');

const RUN_ALL = path.resolve(__dirname, '..', 'run-all.js');
let pass = 0; let fail = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ✓ ${name}\n`); pass += 1; }
  catch (e) { process.stdout.write(`  ✗ ${name}\n      ${e.message}\n`); fail += 1; }
}
process.stdout.write('tpm-consumer-run-all.test.js\n');

const dir = mkScratch('tpm-consumer-runall-test');
const probe = path.join(dir, 'probe-suite.js');
fs.writeFileSync(probe, `'use strict';
const leaked = ['TPM_PROJECT_ROOT', 'TPM_HOME'].filter((k) => process.env[k] !== undefined);
if (leaked.length) { console.log('LEAKED ' + leaked.join(',')); process.exit(1); }
console.log('clean'); process.exit(0);
`);
const DECOY = { TPM_PROJECT_ROOT: path.join(dir, 'decoy-project'), TPM_HOME: path.join(dir, 'decoy-home') };
const envWithDecoys = Object.assign({}, process.env, DECOY);

check('cleanEnv(): removes TPM_PROJECT_ROOT + TPM_HOME, keeps the rest', () => {
  const saved = { a: process.env.TPM_PROJECT_ROOT, b: process.env.TPM_HOME };
  Object.assign(process.env, DECOY); process.env.KEEP_ME_X = '1';
  try {
    const e = require(RUN_ALL).cleanEnv();
    assert.strictEqual(e.TPM_PROJECT_ROOT, undefined); assert.strictEqual(e.TPM_HOME, undefined);
    assert.strictEqual(e.KEEP_ME_X, '1'); assert.ok(e.PATH);
  } finally {
    delete process.env.KEEP_ME_X;
    if (saved.a === undefined) delete process.env.TPM_PROJECT_ROOT; else process.env.TPM_PROJECT_ROOT = saved.a;
    if (saved.b === undefined) delete process.env.TPM_HOME; else process.env.TPM_HOME = saved.b;
  }
});
check('control: the probe run DIRECTLY with decoys set sees them and fails (decoys really propagate)', () => {
  const r = spawnSync('node', [probe], { encoding: 'utf8', env: envWithDecoys });
  assert.strictEqual(r.status, 1); assert.ok(/LEAKED TPM_PROJECT_ROOT,TPM_HOME/.test(r.stdout));
});
check('decoy-env proof: the same probe run THROUGH run-all (decoys in the runner\'s env) is clean → exit 0', () => {
  const r = spawnSync('node', ['-e', `require(${JSON.stringify(RUN_ALL)}).main([${JSON.stringify(probe)}])`], { encoding: 'utf8', env: envWithDecoys });
  assert.strictEqual(r.status, 0, (r.stdout || '') + (r.stderr || ''));
  assert.ok(/PASS — 1\/1 suites green/.test(r.stdout), r.stdout);
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
