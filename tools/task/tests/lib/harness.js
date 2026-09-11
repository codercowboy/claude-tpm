#!/usr/bin/env node
/**
 * tests/lib/harness.js — shared test scaffolding for the tools/task suite.
 *
 * PURPOSE
 *   Everything every tests/<area>/test.js needs, and nothing project-structure-specific:
 *     - makeChecker() -> a pass/fail runner. check()/ok()/eq() run the assertion; an uncaught
 *       throw fails the whole test file non-zero, which IS the pass/fail signal run-all.js and
 *       mutation-check.js read (same convention as tools/session/tests/lib/harness.js).
 *     - runTask()/runTaskRaw()/runNode() — real subprocess drivers over the CLI; never throw,
 *       inspect .code.
 *     - mkStore() — a fresh throwaway store under os.tmpdir() via fs.mkdtempSync (G8: NO
 *       phase-relative sandbox, so this test tree survives promotion into tools/task/ unchanged).
 *     - TOOLS — absolute paths to the suite under test, resolved via __dirname only (no
 *       hardcoded absolutes, no ../../.. into the project) so the tree is portable.
 *     - body/index read helpers.
 *
 * HOW TO RUN
 *   No CLI of its own — required by each tests/<area>/test.js.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// tests/lib/harness.js -> ../.. = the suite root (out/tools/task, or tools/task once promoted).
const TOOL_ROOT = path.resolve(__dirname, '..', '..');

const TOOLS = {
  task: path.join(TOOL_ROOT, 'task.js'),
  paths: path.join(TOOL_ROOT, 'lib', 'paths.js'),
  config: path.join(TOOL_ROOT, 'lib', 'config.js'),
  format: path.join(TOOL_ROOT, 'lib', 'format.js'),
  store: path.join(TOOL_ROOT, 'lib', 'store.js'),
  render: path.join(TOOL_ROOT, 'lib', 'render.js'),
};

/** One counter per test file (call once at the top of each test.js). */
function makeChecker() {
  let passCount = 0;
  function check(label, fn) {
    fn(); // an assertion throw here fails the whole file non-zero — that's the point.
    passCount += 1;
    process.stdout.write(`  PASS: ${label}\n`);
  }
  function ok(label, cond) {
    check(label, () => {
      if (!cond) throw new Error(`expected truthy: ${label}`);
    });
  }
  function eq(label, actual, expected) {
    check(label, () => {
      const a = typeof actual === 'object' ? JSON.stringify(actual) : String(actual);
      const e = typeof expected === 'object' ? JSON.stringify(expected) : String(expected);
      if (a !== e) throw new Error(`${label}\n    expected: ${e}\n    actual:   ${a}`);
    });
  }
  return { check, ok, eq, count: () => passCount };
}

/** Run a Node CLI script as a real subprocess. Never throws — inspect .code. */
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

/** task.js with the store bound via --tasks-dir. */
function runTask(store, args, opts = {}) {
  return runNode(TOOLS.task, ['--tasks-dir', store, ...args], opts);
}

/** task.js with NO --tasks-dir (for --help / --config-driven runs). */
function runTaskRaw(args, opts = {}) {
  return runNode(TOOLS.task, args, opts);
}

/** A fresh, empty store directory under os.tmpdir() (G8 — survives promotion). */
function mkStore(prefix = 'tpm-task') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

/** Write a payload markdown file inside the store dir; return its path. */
function writePayload(store, name, text) {
  const p = path.join(store, `_payload-${name}.md`);
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

// ── store read helpers ──────────────────────────────────────────────────────────
function bucketDir(bucketSize, n) {
  const lo = Math.floor(n / bucketSize) * bucketSize;
  return `${lo}-${lo + bucketSize - 1}`;
}
function bodyPath(store, n, bucketSize = 1000) {
  return path.join(store, 'bodies', bucketDir(bucketSize, n), `task-${n}.md`);
}
function readBody(store, n, bucketSize = 1000) {
  const p = bodyPath(store, n, bucketSize);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}
function readOpenIdx(store) {
  const p = path.join(store, 'task-index.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}
function readFinIdx(store) {
  const p = path.join(store, 'finished-tasks-index.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}
function readRemIdx(store) {
  const p = path.join(store, 'removed-tasks-index.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

module.exports = {
  makeChecker,
  runNode,
  runTask,
  runTaskRaw,
  mkStore,
  writePayload,
  bodyPath,
  readBody,
  readOpenIdx,
  readFinIdx,
  readRemIdx,
  TOOL_ROOT,
  TOOLS,
};
