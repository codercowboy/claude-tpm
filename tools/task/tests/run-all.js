'use strict';
/**
 * run-all.js — the task-tooling test entrypoint (mirrors session-tooling/tests/run-all.js).
 *
 * Runs every *.test.js in this dir as its OWN `node <file>` process (so each stays independently
 * runnable, per tool-conventions' ship-tool bar) and aggregates exit codes. Exits 0 only if ALL
 * suites pass; non-zero otherwise. Prints the "N suites run, M failed" summary line.
 *
 * Discovery is FLAT + non-recursive: shared, non-runnable helpers live under `helpers/` and are
 * never picked up (they do not end in `.test.js` at this level).
 *
 * Run: node tests/run-all.js
 * Node built-ins only.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const here = __dirname;
const suites = fs.readdirSync(here)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

let failed = 0;
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const res = spawnSync(process.execPath, [path.join(here, suite)], { stdio: 'inherit' });
  if (res.status !== 0) failed++;
}

console.log(`\n──────────────────────────────`);
console.log(`${suites.length} suites run, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
