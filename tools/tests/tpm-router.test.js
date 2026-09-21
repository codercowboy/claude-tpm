#!/usr/bin/env node
/**
 * tests/tpm-router.test.js — behavioral test for the `tpm` dispatcher + the per-suite routers.
 *
 * PURPOSE
 *   Proves the two-level dispatch (tools/tpm.js → tools/<suite>/tpm-<suite>-router.js → tool script):
 *   suite/verb routing, unknown-command exit codes, faithful arg pass-through, and exit-code
 *   propagation across BOTH hops. Uses only NON-MUTATING child commands (config resolvers,
 *   `--help`/bare menus), so it's safe to run anywhere.
 *
 *   Every path resolves via __dirname — no hardcoded absolutes, portable when the bundle moves.
 *
 * HOW TO RUN
 *   node tests/tpm-router.test.js        # exit 0 = all assertions green
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOLS = path.resolve(__dirname, '..');          // tests/ -> tools/
const TPM = path.join(TOOLS, 'tpm.js');

let count = 0;
function check(name, fn) { fn(); count++; process.stdout.write(`  ✓ ${name}\n`); }

// Run `node <script> <args…>` and capture {status, out} (stdout+stderr merged).
function run(script, args) {
  const r = spawnSync('node', [script, ...args], { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const tpm = (...args) => run(TPM, args);

process.stdout.write('tpm-router.test.js\n');

// ── top dispatcher ────────────────────────────────────────────────────────────────
check('bare `tpm` → exit 0 + lists all three suites', () => {
  const r = tpm();
  assert.strictEqual(r.status, 0);
  for (const s of ['session', 'task', 'workflow']) assert.ok(r.out.includes(s), `menu names ${s}`);
});
check('`tpm --help` → exit 0', () => assert.strictEqual(tpm('--help').status, 0));
check('unknown suite → exit 2', () => assert.strictEqual(tpm('frobnicate').status, 2));

// ── session router ──────────────────────────────────────────────────────────────
check('`tpm session` (bare) → exit 0 + lists session verbs', () => {
  const r = tpm('session');
  assert.strictEqual(r.status, 0);
  for (const v of ['config', 'current', 'notes', 'review']) assert.ok(r.out.includes(v), `lists ${v}`);
});
check('unknown session verb → exit 2', () => assert.strictEqual(tpm('session', 'badverb').status, 2));
check('`tpm session config --json` dispatches (exit 0 + valid JSON)', () => {
  const r = tpm('session', 'config', '--json');
  assert.strictEqual(r.status, 0);
  JSON.parse(r.out); // throws if the child output wasn't passed through cleanly
});
check('pass-through is faithful: `tpm session config --json` === direct tool output', () => {
  const via = tpm('session', 'config', '--json').out;
  const direct = run(path.join(TOOLS, 'session', 'tpm-session-config.js'), ['--json']).out;
  assert.strictEqual(via, direct);
});

// ── task router (single-tool suite + `config` special-case) ─────────────────────
check('`tpm task config --json` → routes to the config resolver (exit 0 + JSON)', () => {
  const r = tpm('task', 'config', '--json');
  assert.strictEqual(r.status, 0);
  const j = JSON.parse(r.out);
  assert.ok('tasksDir' in j, 'config resolver output has tasksDir');
});
check('non-config task verb passes through to tpm-task.js (`--help` exit 0)', () => {
  assert.strictEqual(tpm('task', '--help').status, 0);
});

// ── workflow router ─────────────────────────────────────────────────────────────
check('`tpm workflow` (bare) → exit 0 + lists workflow verbs', () => {
  const r = tpm('workflow');
  assert.strictEqual(r.status, 0);
  for (const v of ['audit', 'compose', 'scaffold', 'doctor', 'signoff']) assert.ok(r.out.includes(v), `lists ${v}`);
});
check('unknown workflow verb → exit 2', () => assert.strictEqual(tpm('workflow', 'nope').status, 2));
check('`tpm workflow config --json` dispatches (exit 0 + valid JSON)', () => {
  const r = tpm('workflow', 'config', '--json');
  assert.strictEqual(r.status, 0);
  JSON.parse(r.out);
});

// ── flat consumer-adoption aliases ──────────────────────────────────────────────
check('`tpm install --help` alias still routes (exit 0)', () => {
  const r = tpm('install', '--help');
  assert.strictEqual(r.status, 0);
  assert.ok(/install/i.test(r.out));
});

// ── flat bundle primitives (home / doc) ───────────────────────────────────────────
check('`tpm home` routes → prints an absolute path (exit 0)', () => {
  const r = tpm('home');
  assert.strictEqual(r.status, 0);
  assert.ok(path.isAbsolute(r.out.trim()), 'home prints an absolute bundle path');
});
check('`tpm doc` (no arg) routes → usage exit 2', () => {
  assert.strictEqual(tpm('doc').status, 2);
});
check('bare `tpm` menu lists the home + doc primitives', () => {
  const r = tpm();
  assert.ok(r.out.includes('home') && r.out.includes('doc'), 'menu names home + doc');
});

process.stdout.write(`\nPASS — ${count}/${count} tpm dispatch assertions green\n`);
