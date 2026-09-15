#!/usr/bin/env node
/**
 * tools/tests/run-all.js — the TOP-LEVEL test aggregator (the `npm test` entry point).
 *
 * PURPOSE
 *   One command to run every claude-tpm test suite: each per-suite group's run-all (session / task /
 *   consumer / workflow) plus the standalone top-level + misc tests. Each target runs as a real
 *   subprocess so one failure can't corrupt another's process state; prints a per-target PASS/FAIL
 *   line and exits non-zero if anything failed.
 *
 *   (Replaces the old `npm test` = mutation-check28.js, which was a single-round mutation harness that
 *   mutated checked-in tool COPIES — both retired 2026-09-14 in favor of suites that run against the
 *   canonical shipped tools. See tools/workflow/tests/run-all.js.)
 *
 * HOW TO RUN
 *   node tools/tests/run-all.js   (or: npm test)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ensureRunSlug } = require('./lib/scratch');

// <bundle>/tools/tests/run-all.js → <bundle>/tools
const TOOLS = path.resolve(__dirname, '..');

// Group run-alls (each fans out to its own suite set) + standalone suites with no group runner.
const TARGETS = [
  'session/tests/run-all.js',
  'task/tests/run-all.js',
  'consumer/tests/run-all.js',
  'workflow/tests/run-all.js',
  'tests/tpm-router.test.js',
  'tests/tpm-workflow-lint-selflocate.test.js',
  'misc/fix-git-rename/tests/tpm-fix-git-rename-refs/test.js',
];

function main() {
  // One scratch slug for the WHOLE run — child suites inherit TPM_TEST_RUN, so every test's output
  // lands under one <bundle>/tmp/scratch/<slug>/ folder.
  const slug = ensureRunSlug();
  process.stdout.write(`test scratch → tmp/scratch/${slug}/\n`);
  let failures = 0;
  for (const rel of TARGETS) {
    const p = path.join(TOOLS, rel);
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
  process.stdout.write(`\n${failures ? 'FAIL' : 'PASS'} — ${TARGETS.length - failures}/${TARGETS.length} targets green\n`);
  process.exit(failures ? 1 : 0);
}

main();
