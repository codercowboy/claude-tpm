#!/usr/bin/env node
/**
 * tests/session/lib/harness.js — shared test helpers for the tools/session suite's tests.
 *
 * PURPOSE
 *   Common scaffolding every tests/session/<tool>/test.js needs: a pass/fail check() runner
 *   (per this project's tools/workflow/tests/scaffold-config/tests/config-resolver/test.js
 *   convention — check() runs the assertion; an uncaught throw fails the whole script
 *   non-zero, which IS the pass/fail signal a CI or mutation-check reads), a CLI subprocess
 *   runner (runNode), and sandbox-directory creation confined to THIS phase folder's
 *   tmp/test-writer-r1/ — never the real claude-context/sessions/, per this round's
 *   constraint (test-writer charter + spawn prompt).
 *
 * EXPORTS
 *   makeChecker() -> { check(label, fn), count() }
 *   runNode(scriptPath, args, opts) -> { code, stdout, stderr }  (subprocess, never throws)
 *   mkSandbox(prefix) -> absolute path to a fresh, empty scratch dir under
 *     tmp/test-writer-r1/sandbox/<prefix>-XXXXXX (auto-created, unique per call)
 *   PHASE_ROOT, TOOLS_DIR, TOOLS  (paths to the suite under test — all resolved via __dirname,
 *     no hardcoded absolutes, so this test tree stays portable with the phase folder)
 *
 * HOW TO RUN
 *   This file has no CLI of its own — it is required by each tests/session/<tool>/test.js file.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// tools/session/tests/lib/harness.js -> ../.. = the tools/session suite root
const PHASE_ROOT = path.resolve(__dirname, '..', '..');
const TOOLS_DIR = PHASE_ROOT;
const SANDBOX_ROOT = path.join(PHASE_ROOT, 'tmp', 'test-writer-r1', 'sandbox');

const TOOLS = {
  paths: path.join(TOOLS_DIR, 'tpm-session-paths.js'),
  config: path.join(TOOLS_DIR, 'tpm-session-config.js'),
  currentSession: path.join(TOOLS_DIR, 'tpm-session-current.js'),
  format: path.join(TOOLS_DIR, 'tpm-session-format.js'),
  sessionNotes: path.join(TOOLS_DIR, 'tpm-session-notes.js'),
  sessionReview: path.join(TOOLS_DIR, 'tpm-session-review.js'),
};

/** One counter per test file (call once at the top of each test.js). */
function makeChecker() {
  let passCount = 0;
  function check(label, fn) {
    fn(); // an assertion throw here fails the whole test file non-zero — that's the point.
    passCount += 1;
    process.stdout.write(`  PASS: ${label}\n`);
  }
  return { check, count: () => passCount };
}

/** Run a tools/session/* CLI script as a real subprocess. Never throws — inspect .code. */
function runNode(scriptPath, args, opts = {}) {
  try {
    const stdout = execFileSync('node', [scriptPath, ...args], { encoding: 'utf8', ...opts });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
    };
  }
}

/** A fresh, empty scratch directory under tmp/test-writer-r1/sandbox/. */
function mkSandbox(prefix) {
  fs.mkdirSync(SANDBOX_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(SANDBOX_ROOT, `${prefix}-`));
}

module.exports = { makeChecker, runNode, mkSandbox, PHASE_ROOT, TOOLS_DIR, TOOLS, SANDBOX_ROOT };
