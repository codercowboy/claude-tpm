#!/usr/bin/env node
/**
 * tests/tpm-workflow-lint-selflocate.test.js — regression test for the REAL shipped
 * `tpm-workflow-lint-subagent-prompt.js` manifest behavior (Option A, 2026-09-13).
 *
 * WHY THIS FILE (not the tpm-workflow-lint suite): that suite runs a STAGED COPY under
 * `tools/workflow/tests/tpm-workflow-lint/tools/`, which has diverged from the shipped tool. This
 * test exercises the ACTUAL tool the `tpm workflow lint` router runs, so the Option-A behavior is
 * covered against reality:
 *   1. With NO --manifest, the tool SELF-LOCATES its bundle's canonical subagent reading-list and
 *      RUNS the doc-chain checks (it must NOT silently skip them).
 *   2. --manifest remains an OPTIONAL override; an explicit path that doesn't exist FAILS LOUD (exit 2).
 *
 * Temp files go under os.tmpdir(); the tool self-locates via __dirname, so cwd is irrelevant here.
 *
 * HOW TO RUN
 *   node tools/tests/tpm-workflow-lint-selflocate.test.js     # exit 0 = all green
 */

'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { mkScratch } = require('./lib/scratch'); // shared: <bundle>/tmp/scratch/<run-slug>/

const TOOL = path.resolve(__dirname, '..', 'workflow', 'tpm-workflow-lint-subagent-prompt.js');

let count = 0;
function check(name, fn) { fn(); count++; process.stdout.write(`  ✓ ${name}\n`); }
function run(args) {
  const r = spawnSync('node', [TOOL, ...args], { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const dir = mkScratch('tpm-lint-selfloc');
const prompt = path.join(dir, 'prompt.md');
fs.writeFileSync(prompt, '# spawn prompt\nRead your charter: `charter-builder.md`.\n');

process.stdout.write('tpm-workflow-lint-selflocate.test.js\n');

try {
  check('no --manifest → self-locates the bundle manifest and RUNS the doc-chain checks (no silent skip)', () => {
    const r = run(['--file', prompt]);
    // The bundle manifest self-locates, so the manifest-driven "step-zero-*" doc-chain checks run.
    assert.ok(/step-zero-/.test(r.out), 'expected manifest doc-chain checks (step-zero-*) to run:\n' + r.out);
    assert.ok(!/no subagent reading-list manifest found/i.test(r.out), 'must NOT report a missing manifest');
    assert.ok(!/SKIPPING doc-chain/i.test(r.out), 'must NOT silently skip the doc-chain');
  });

  check('--manifest is still an OPTIONAL override; an explicit missing path FAILS LOUD (exit 2)', () => {
    const r = run(['--file', prompt, '--manifest', path.join(dir, 'does-not-exist.md')]);
    assert.strictEqual(r.status, 2, 'explicit missing --manifest must exit 2:\n' + r.out);
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

process.stdout.write(`\nPASS — ${count}/${count} lint self-locate assertions green\n`);
