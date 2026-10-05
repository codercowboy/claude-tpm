#!/usr/bin/env node
'use strict';
/**
 * tpm-config-router.test.js — behavioral tests for the `tpm config` suite (tools/config/tpm-config-router.js),
 * driven as a subprocess with real exit codes. Child envs are built from scratch (no inherited
 * TPM_PROJECT_ROOT / CLAUDE_TPM_USER_CONFIG). Temp dirs only.
 *
 * Covers DoD D: get (overlaid + per-layer, with path[i]), set (project/user/default layers, create-if-absent,
 * path[i]/path[+], _comment round-trip), list, --help; every path round-trips (set -> get).
 *
 * MUST be registered in tools/tests/run-all.js TARGETS (config is NOT a globbed group) — see
 * tpm-runner-registration.test.js.
 *
 * Run: node tools/config/tests/tpm-config-router.test.js   (exit 0 = all green)
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOL = path.join(__dirname, '..', 'tpm-config-router.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-config-router-'));
let n = 0;
function freshRoot() {
  const d = path.join(TMP, 'proj' + (n++));
  fs.mkdirSync(path.join(d, '.claude', 'claude-tpm'), { recursive: true });
  return d;
}
function run(args, env) {
  const base = { PATH: process.env.PATH };
  const r = spawnSync(process.execPath, [TOOL, ...args], { env: Object.assign(base, env || {}), encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

let count = 0;
function check(name, fn) { fn(); count += 1; process.stdout.write(`  ✓ ${name}\n`); }
process.stdout.write('tpm-config-router.test.js\n');

check('--help prints usage, exit 0', () => {
  const r = run(['--help']);
  assert.strictEqual(r.code, 0);
  assert.ok(/Usage: tpm config/.test(r.stdout));
});

check('no verb -> usage + exit 1', () => {
  const r = run([]);
  assert.strictEqual(r.code, 1);
  assert.ok(/Usage: tpm config/.test(r.stdout));
});

check('unknown verb -> usage + exit 2', () => {
  const r = run(['frobnicate']);
  assert.strictEqual(r.code, 2);
  assert.ok(/unknown verb/.test(r.stderr));
});

check('get (overlaid) returns a default when nothing overrides it', () => {
  const root = freshRoot();
  const r = run(['get', 'session.notes.sessionsDir'], { TPM_PROJECT_ROOT: root });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(JSON.parse(r.stdout), '.claude/claude-tpm/sessions');
});

check('get --layer defaults reads the shipped defaults layer directly', () => {
  const root = freshRoot();
  const r = run(['get', 'workflow.verifyLoopCap', '--layer', 'defaults'], { TPM_PROJECT_ROOT: root });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(JSON.parse(r.stdout), 5);
});

check('get resolves array indexes: workflow.subagentConfigs[1].name === "builder"', () => {
  const root = freshRoot();
  const r = run(['get', 'workflow.subagentConfigs[1].name'], { TPM_PROJECT_ROOT: root });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(JSON.parse(r.stdout), 'builder');
});

check('get on a missing path -> exit 1 with a clear message', () => {
  const root = freshRoot();
  const r = run(['get', 'tasks.nope.deeper'], { TPM_PROJECT_ROOT: root });
  assert.strictEqual(r.code, 1);
  assert.ok(/no value at/.test(r.stderr));
});

check('set (project) creates config.json if absent, then get reads it back (round-trip)', () => {
  const root = freshRoot();
  const set = run(['set', 'tasks.maxOpenWarn', '100'], { TPM_PROJECT_ROOT: root });
  assert.strictEqual(set.code, 0, set.stderr);
  const file = path.join(root, '.claude', 'claude-tpm', 'config.json');
  assert.ok(fs.existsSync(file), 'project config.json was created');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).tasks.maxOpenWarn, 100);
  // overlaid get + per-layer get both see it
  assert.strictEqual(JSON.parse(run(['get', 'tasks.maxOpenWarn'], { TPM_PROJECT_ROOT: root }).stdout), 100);
  assert.strictEqual(JSON.parse(run(['get', 'tasks.maxOpenWarn', '--layer', 'project'], { TPM_PROJECT_ROOT: root }).stdout), 100);
});

check('set coerces the value (number/bool/string)', () => {
  const root = freshRoot();
  run(['set', 'tasks.allowHardDelete', 'true'], { TPM_PROJECT_ROOT: root });
  run(['set', 'session.additionalOpenMessage', 'hello.md'], { TPM_PROJECT_ROOT: root });
  const file = path.join(root, '.claude', 'claude-tpm', 'config.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(raw.tasks.allowHardDelete, true);
  assert.strictEqual(raw.session.additionalOpenMessage, 'hello.md');
});

check('set --user writes $CLAUDE_TPM_USER_CONFIG; the user layer wins in the overlaid get', () => {
  const root = freshRoot();
  const userFile = path.join(TMP, 'user' + (n++) + '.json');
  const env = { TPM_PROJECT_ROOT: root, CLAUDE_TPM_USER_CONFIG: userFile };
  // project sets 10, user sets 99 -> overlaid is 99
  run(['set', 'tasks.maxOpenWarn', '10'], env);
  const su = run(['set', 'tasks.maxOpenWarn', '99', '--user'], env);
  assert.strictEqual(su.code, 0, su.stderr);
  assert.ok(fs.existsSync(userFile), 'user config file created');
  assert.strictEqual(JSON.parse(run(['get', 'tasks.maxOpenWarn', '--layer', 'user'], env).stdout), 99);
  assert.strictEqual(JSON.parse(run(['get', 'tasks.maxOpenWarn'], env).stdout), 99, 'user layer wins in the overlay');
});

check('set with [+] appends an array element (round-trips through the raw file)', () => {
  const root = freshRoot();
  const userFile = path.join(TMP, 'user' + (n++) + '.json');
  const env = { TPM_PROJECT_ROOT: root, CLAUDE_TPM_USER_CONFIG: userFile };
  run(['set', 'tasks.defaultListState[+]', 'done', '--user'], env);
  run(['set', 'tasks.defaultListState[+]', 'blocked', '--user'], env);
  assert.deepStrictEqual(JSON.parse(run(['get', 'tasks.defaultListState', '--layer', 'user'], env).stdout), ['done', 'blocked']);
});

check('set --default targets the shipped defaults file (TPM_DEFAULTS_FILE override)', () => {
  const defFile = path.join(TMP, 'defaults' + (n++) + '.json');
  fs.writeFileSync(defFile, JSON.stringify({ version: 1, tasks: { maxOpenWarn: 1 } }, null, 2));
  const r = run(['set', 'tasks.maxOpenWarn', '7', '--default'], { TPM_DEFAULTS_FILE: defFile });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(defFile, 'utf8')).tasks.maxOpenWarn, 7);
});

check('set round-trips _comment keys + sibling sections in the raw file', () => {
  const root = freshRoot();
  const file = path.join(root, '.claude', 'claude-tpm', 'config.json');
  fs.writeFileSync(file, JSON.stringify({ _comment: 'keep me', session: { enabled: false } }, null, 2));
  const r = run(['set', 'tasks.maxOpenWarn', '5'], { TPM_PROJECT_ROOT: root });
  assert.strictEqual(r.code, 0, r.stderr);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(raw._comment, 'keep me');
  assert.deepStrictEqual(raw.session, { enabled: false });
  assert.strictEqual(raw.tasks.maxOpenWarn, 5);
});

check('list prints the whole resolved config (version + all four sections), comment-stripped', () => {
  const root = freshRoot();
  const r = run(['list'], { TPM_PROJECT_ROOT: root });
  assert.strictEqual(r.code, 0);
  const cfg = JSON.parse(r.stdout);
  assert.strictEqual(cfg.version, 1);
  for (const s of ['session', 'tasks', 'workflow', 'hygiene']) assert.ok(cfg[s], `section ${s} present`);
  assert.ok(!/_comment|\$comment/.test(r.stdout), 'no comment keys in the resolved list');
});

check('works through the tpm.js dispatcher: `tpm config get ...`', () => {
  const root = freshRoot();
  const TPM = path.join(__dirname, '..', '..', 'tpm.js');
  const r = spawnSync(process.execPath, [TPM, 'config', 'get', 'tasks.startId'], {
    env: { PATH: process.env.PATH, TPM_PROJECT_ROOT: root }, encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout), 1000);
});

process.stdout.write(`\nPASS — ${count} checks\n`);
