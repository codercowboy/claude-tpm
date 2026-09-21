#!/usr/bin/env node
/**
 * tests/consumer/run-all.js — runs every tools/consumer test suite in one shot.
 *
 * PURPOSE
 *   One entry point for "does the tools/consumer suite pass". Runs each suite as a real subprocess
 *   (so one suite's crash can't corrupt another's process state), prints a per-suite PASS/FAIL line,
 *   and exits non-zero if anything failed. Mirrors tools/session/tests/run-all.js.
 *
 *   None of these suites spawn the real `claude`/`npm` binaries — they drive the tools' pure helpers
 *   and (for the expand-tpm-home hook / arg flag-guards) pipe payloads or child-process the tool — so
 *   this is safe to run anywhere.
 *
 * HOW TO RUN
 *   node tools/consumer/tests/run-all.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ensureRunSlug } = require('../../tests/lib/scratch');

const SUITES = [
  'tpm-consumer-install/test.js',
  'tpm-consumer-uninstall/test.js',
  'tpm-consumer-lint-skill-refs/test.js',
  'expand-hook/unit.js',
  'expand-hook/content-unit.js',
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
