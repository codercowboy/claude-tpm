#!/usr/bin/env node
/**
 * tools/workflow/tests/run-all.js — runs every tools/workflow test suite in one shot.
 *
 * PURPOSE
 *   One entry point for "does the tools/workflow suite pass". Runs each suite as a real subprocess
 *   (so one suite's crash can't corrupt another's process state), prints a per-suite PASS/FAIL line,
 *   and exits non-zero if anything failed. Mirrors tools/session/tests/run-all.js.
 *
 *   Every suite runs against the CANONICAL promoted tools (tools/workflow/tpm-workflow-*.js) — the
 *   suites reference the shipped tool directly, NOT a checked-in copy. (The old per-phase `tools/`
 *   copies + the external mutation-check28.js harness that mutated them were retired 2026-09-14; the
 *   compose suite keeps its own inline mutation check, which now reads canonical + writes its mutant to
 *   a tmp scratch file.)
 *
 * HOW TO RUN
 *   node tools/workflow/tests/run-all.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ensureRunSlug } = require('../../tests/lib/scratch');

const SUITES = [
  'tpm-workflow-audit-cost/tests/audit.test.js',
  'tpm-workflow-audit-cost/tests/cost-ledger.test.js',
  'tpm-workflow-compose/tests/compose.test.js',
  'tpm-workflow-doctor/test.js',
  'tpm-workflow-lint/tests/lint-subagent-prompt/test.js',
  'tpm-workflow-scaffold-config/tests/config-resolver/test.js',
  'tpm-workflow-scaffold-config/tests/scaffold-subagent/test.js',
  'tpm-workflow-signoff-gate/test.js',
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
