#!/usr/bin/env node
/**
 * test.js — unit test for the tpm-workflow doctor preflight. Zero-dep (node assert). Exercises the
 * pure check functions (wired vs unwired hooks), charter resolution against the real bundle, and the
 * full runAll (all-green in claude-admin). Usage: node tools/workflow/tests/doctor/test.js
 */
'use strict';

const assert = require('assert');
const doctor = require('../../tpm-workflow-doctor.js');

let pass = 0; let fail = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ✓ ${name}\n`); pass += 1; }
  catch (e) { process.stdout.write(`  ✗ ${name}\n      ${e.message}\n`); fail += 1; }
}

const wired = {
  hooks: {
    PreToolUse: [
      { matcher: 'Agent|Task', hooks: [{ type: 'command', command: 'x/tools/workflow/hooks/gate-spawn.js' }] },
      { matcher: 'Read|Glob|Grep|NotebookRead', hooks: [{ type: 'command', command: 'y/tools/consumer/hooks/expand-tpm-home.js' }] },
    ],
  },
};

check('checkGateHook: wired → ok', () => assert.strictEqual(doctor.checkGateHook(wired).ok, true));
check('checkExpandHook: wired → ok', () => assert.strictEqual(doctor.checkExpandHook(wired).ok, true));
check('checkGateHook: missing → FAIL with a fix', () => {
  const r = doctor.checkGateHook({ hooks: { PreToolUse: [] } });
  assert.strictEqual(r.ok, false); assert.ok(r.fix, 'a fail must carry a fix');
});
check('checkExpandHook: null settings → FAIL', () => assert.strictEqual(doctor.checkExpandHook(null).ok, false));
check('checkCharters: all default charters resolve under the bundle', () => {
  const r = doctor.checkCharters(doctor.BUNDLE);
  assert.strictEqual(r.ok, true, r.detail);
});
check('runAll: 5 checks, all green in claude-admin', () => {
  const results = doctor.runAll(doctor.BUNDLE);
  assert.strictEqual(results.length, 5);
  const failed = results.filter(([, r]) => !r.ok);
  assert.strictEqual(failed.length, 0, `failed: ${failed.map(([n]) => n).join(', ')}`);
});
check('every FAIL result carries a fix (fail-loud contract)', () => {
  const r = doctor.checkExpandHook({});
  assert.strictEqual(r.ok, false);
  assert.ok(typeof r.fix === 'string' && r.fix.length > 0);
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
