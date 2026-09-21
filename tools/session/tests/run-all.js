'use strict';
/**
 * run-all.js — the base-lib test entrypoint. Runs every *.test.js in this dir as its own
 * `node <file>` process (so each stays independently runnable) and aggregates exit codes.
 * Exits 0 only if ALL suites pass; non-zero otherwise (ship-tool bar).
 *
 * Run: node tests/run-all.js
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
