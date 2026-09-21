'use strict';
/**
 * harness.js — a tiny zero-dep test harness for the base-lib unit tests.
 *
 * Each test file requires this, registers cases with test(), and calls done(name) last.
 * done() prints a summary and exits NON-ZERO if any case failed (ship-tool bar,
 * tool-conventions "exit non-zero on failure"). Also ships:
 *  - tmpDir(prefix): a fresh scratch dir under the OS tmp (never the live sessions dir).
 *  - withFailingFs(method, fn): temporarily replaces fs[method] with a throwing stub —
 *    the fault-injecting fs wrapper used by the forced-write-failure test. Because
 *    require('fs') is a cached singleton, io.js sees the override at call time; the
 *    original is always restored in a finally.
 *
 * Node built-ins only.
 */
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   - ' + name);
  } catch (e) {
    failed++;
    const detail = e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n         ') : String(e);
    console.log('  FAIL - ' + name + '\n         ' + detail);
  }
}

function done(suite) {
  console.log(`\n${suite}: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'tpm-base-'));
}

function withFailingFs(method, fn) {
  const real = fs[method];
  fs[method] = function failingStub() {
    const e = new Error('injected fs.' + method + ' failure');
    e.code = 'EIO';
    throw e;
  };
  try {
    return fn();
  } finally {
    fs[method] = real;
  }
}

/** Assert that `fn` throws AND its message matches `re` (a RegExp). */
function throwsMatching(fn, re, msg) {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    assert.ok(re.test(e.message), (msg || 'error message') + ` should match ${re}, got: ${e.message}`);
  }
  assert.ok(threw, (msg || 'call') + ' should have thrown');
}

module.exports = { assert, test, done, tmpDir, withFailingFs, throwsMatching, fs, path };
