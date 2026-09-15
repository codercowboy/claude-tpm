#!/usr/bin/env node
/**
 * tests/session/run-all.js — runs every tests/session/<tool>/test.js suite in one shot.
 *
 * PURPOSE
 *   One entry point for "does the tools/session suite pass". Runs each suite as a real
 *   subprocess (so one suite's crash can't corrupt another's process state), prints a
 *   per-suite PASS/FAIL line, and exits non-zero if anything failed.
 *
 * HOW TO RUN
 *   node tests/session/run-all.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ensureRunSlug } = require('../../tests/lib/scratch');

const SUITES = [
  'lib-format/test.js',
  'lib-config/test.js',
  'lib-current-session/test.js',
  'tpm-session-notes/test.js',
  'tpm-session-review/test.js',
];

function main() {
  ensureRunSlug(); // share one scratch slug across this group's child suites
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
