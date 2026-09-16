#!/usr/bin/env node
/**
 * test.js — unit test for the tpm-workflow doctor preflight. Zero-dep (node assert). Exercises the
 * pure check functions, charter resolution against the real bundle, and the full runAll (all-green in
 * claude-tpm). Usage: node tools/workflow/tests/doctor/test.js
 *
 * (The doctor no longer checks PreToolUse hook wiring — those hooks are plugin-delivered now — so the
 * former checkGateHook / checkExpandHook tests are gone.)
 */
'use strict';

const assert = require('assert');
const doctor = require('../../tpm-workflow-doctor.js');

let pass = 0; let fail = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ✓ ${name}\n`); pass += 1; }
  catch (e) { process.stdout.write(`  ✗ ${name}\n      ${e.message}\n`); fail += 1; }
}

check('checkCharters: all default charters resolve under the bundle', () => {
  const r = doctor.checkCharters(doctor.BUNDLE);
  assert.strictEqual(r.ok, true, r.detail);
});
check('runAll: 3 checks, all green in claude-tpm', () => {
  const results = doctor.runAll(doctor.BUNDLE);
  assert.strictEqual(results.length, 3);
  const failed = results.filter(([, r]) => !r.ok);
  assert.strictEqual(failed.length, 0, `failed: ${failed.map(([n]) => n).join(', ')}`);
});
check('every FAIL result carries a fix (fail-loud contract)', () => {
  const r = doctor.checkSignoffWritable('/dev/null'); // mkdir under a non-directory → guaranteed FAIL
  assert.strictEqual(r.ok, false);
  assert.ok(typeof r.fix === 'string' && r.fix.length > 0);
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
