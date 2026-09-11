#!/usr/bin/env node
/**
 * tests/run-all.js — runs every shipped tools/task test suite in one shot.
 *
 * PURPOSE
 *   The single "does the tools/task suite pass" entry point. Runs each suite as a real
 *   subprocess (so one suite's crash can't corrupt another's process state), prints a per-suite
 *   PASS/FAIL line, and exits non-zero if anything failed. This is the GREEN baseline the
 *   mutation-check depends on and the verifier re-runs.
 *
 *   NOTE: tests/task/bug-repros.test.js is DELIBERATELY not listed here — it documents
 *   confirmed defects as failing repros (expected RED) for the bug-fixer loop, and would (by
 *   design) fail this runner. Run it directly: `node tests/task/bug-repros.test.js`.
 *
 * HOW TO RUN
 *   node tests/run-all.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SUITES = [
  'format/test.js',
  'render/test.js',
  'task/test.js',
];

function main() {
  let failures = 0;
  for (const rel of SUITES) {
    const p = path.join(__dirname, rel);
    if (!fs.existsSync(p)) {
      process.stderr.write(`✗ MISSING — ${rel}\n`);
      failures += 1;
      continue;
    }
    try {
      const out = execFileSync('node', [p], { encoding: 'utf8' });
      const lastLine = out.trim().split('\n').pop();
      process.stdout.write(`✓ ${rel} — ${lastLine}\n`);
    } catch (err) {
      process.stderr.write(`✗ FAIL — ${rel}\n${err.stdout || ''}${err.stderr || ''}\n`);
      failures += 1;
    }
  }
  process.stdout.write(`\n${failures ? 'FAIL' : 'PASS'} — ${SUITES.length - failures}/${SUITES.length} suites green\n`);
  process.exit(failures ? 1 : 0);
}

main();
