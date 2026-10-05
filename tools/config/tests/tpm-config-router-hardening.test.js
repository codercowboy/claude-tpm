#!/usr/bin/env node
'use strict';
/**
 * tpm-config-router-hardening.test.js — HARDENING tests for the `tpm config` suite
 * (tools/config/tpm-config-router.js), driven as a subprocess with real exit codes. EXTENDS (does NOT
 * repeat) tpm-config-router.test.js — it targets the failure paths + seams that file leaves open:
 *   - get --layer user / --layer project when THAT layer is absent -> exit 1, clear message.
 *   - set --user with CLAUDE_TPM_USER_CONFIG UNSET -> exit 1 (ENOUSERCONFIG surfaced), nothing written.
 *   - set into an INVALID-JSON project file -> exit 1, "not valid JSON", the bad file is NOT clobbered.
 *   - ATOMIC write: a successful set leaves NO *.tmp sibling behind.
 *   - --config <file>: get/set operate on an explicit project-config path.
 *   - JSON coercion of null / array / object round-trips (set -> raw file -> get).
 *   - project-layer [i] OVERWRITE + [+] append round-trip; list reflects a project override.
 *
 * Child envs are built from scratch (no inherited TPM_PROJECT_ROOT / CLAUDE_TPM_USER_CONFIG). Temp dirs only.
 * MUST be registered in tools/tests/run-all.js TARGETS (config/tests is NOT a globbed group) — see
 * tpm-runner-registration.test.js.
 *
 * Run: node tools/config/tests/tpm-config-router-hardening.test.js   (exit 0 = all green)
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOL = path.join(__dirname, '..', 'tpm-config-router.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-config-router-hard-'));
let n = 0;
function freshRoot() {
  const d = path.join(TMP, 'proj' + (n++));
  fs.mkdirSync(path.join(d, '.claude', 'claude-tpm'), { recursive: true });
  return d;
}
function configPath(root) { return path.join(root, '.claude', 'claude-tpm', 'config.json'); }
function run(args, env) {
  const base = { PATH: process.env.PATH };
  const r = spawnSync(process.execPath, [TOOL, ...args], { env: Object.assign(base, env || {}), encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

let count = 0;
function check(name, fn) { fn(); count += 1; process.stdout.write(`  ✓ ${name}\n`); }
process.stdout.write('tpm-config-router-hardening.test.js\n');

// ── get on an absent single layer ───────────────────────────────────────────────────────────────

check('get --layer user with CLAUDE_TPM_USER_CONFIG unset -> exit 1, "no value ... in the user layer"', () => {
  const root = freshRoot();
  const r = run(['get', 'tasks.maxOpenWarn', '--layer', 'user'], { TPM_PROJECT_ROOT: root });
  assert.strictEqual(r.code, 1, r.stdout + r.stderr);
  assert.ok(/no value at .*user layer/.test(r.stderr), r.stderr);
});

check('get --layer project with no project config.json -> exit 1 (the layer has no value)', () => {
  const root = freshRoot(); // marker dir exists but no config.json
  const r = run(['get', 'tasks.maxOpenWarn', '--layer', 'project'], { TPM_PROJECT_ROOT: root });
  assert.strictEqual(r.code, 1, r.stdout + r.stderr);
  assert.ok(/no value at .*project layer/.test(r.stderr), r.stderr);
});

// ── set --user with no user-config env ────────────────────────────────────────────────────────────

check('set --user with CLAUDE_TPM_USER_CONFIG unset -> exit 1, names the env var, writes nothing', () => {
  const root = freshRoot();
  const r = run(['set', 'tasks.maxOpenWarn', '5', '--user'], { TPM_PROJECT_ROOT: root });
  assert.strictEqual(r.code, 1, r.stdout);
  assert.ok(/CLAUDE_TPM_USER_CONFIG is not set/.test(r.stderr), r.stderr);
  assert.ok(!fs.existsSync(configPath(root)), 'the project config was not touched by a failed --user set');
});

// ── set refuses to clobber invalid JSON ────────────────────────────────────────────────────────────

check('set into an INVALID-JSON project file -> exit 1 "not valid JSON", the bad file is left byte-identical', () => {
  const root = freshRoot();
  const file = configPath(root);
  const original = '{ this is : not json';
  fs.writeFileSync(file, original);
  const r = run(['set', 'tasks.maxOpenWarn', '5'], { TPM_PROJECT_ROOT: root });
  assert.strictEqual(r.code, 1, r.stdout);
  assert.ok(/not valid JSON/.test(r.stderr), r.stderr);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), original, 'refuse-to-clobber: the invalid file is untouched');
});

// ── atomic write leaves no temp litter ──────────────────────────────────────────────────────────────

check('a successful set leaves NO *.tmp sibling in the config dir (atomic write cleaned up)', () => {
  const root = freshRoot();
  const r = run(['set', 'tasks.maxOpenWarn', '12'], { TPM_PROJECT_ROOT: root });
  assert.strictEqual(r.code, 0, r.stderr);
  const dir = path.dirname(configPath(root));
  const litter = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp') || /\.tmp$/.test(f));
  assert.deepStrictEqual(litter, [], `no temp files left behind, saw: ${fs.readdirSync(dir).join(',')}`);
  assert.deepStrictEqual(fs.readdirSync(dir), ['config.json'], 'only the canonical file remains');
});

// ── --config <file> explicit path ─────────────────────────────────────────────────────────────────

check('set --config <file> then get --config <file> operate on the explicit path (not the walked root)', () => {
  const explicit = path.join(TMP, 'explicit' + (n++) + '.json');
  const set = run(['set', 'tasks.maxOpenWarn', '33', '--config', explicit], {}); // no TPM_PROJECT_ROOT at all
  assert.strictEqual(set.code, 0, set.stderr);
  assert.ok(fs.existsSync(explicit), 'explicit config file created');
  assert.strictEqual(JSON.parse(fs.readFileSync(explicit, 'utf8')).tasks.maxOpenWarn, 33);
  const get = run(['get', 'tasks.maxOpenWarn', '--config', explicit], {});
  assert.strictEqual(get.code, 0, get.stderr);
  assert.strictEqual(JSON.parse(get.stdout), 33);
});

// ── JSON coercion of null / array / object ──────────────────────────────────────────────────────────

check('set coerces null / array / object literals and they round-trip through the raw file', () => {
  const root = freshRoot();
  const env = { TPM_PROJECT_ROOT: root };
  run(['set', 'tasks.exportDir', 'null'], env);
  run(['set', 'tasks.defaultListState', '["open","done"]'], env);
  run(['set', 'tasks.autoConfirm', '{"finish":true,"drop":true}'], env);
  const raw = JSON.parse(fs.readFileSync(configPath(root), 'utf8'));
  assert.strictEqual(raw.tasks.exportDir, null, 'null literal coerced to JSON null');
  assert.deepStrictEqual(raw.tasks.defaultListState, ['open', 'done'], 'array literal parsed');
  assert.deepStrictEqual(raw.tasks.autoConfirm, { finish: true, drop: true }, 'object literal parsed');
  // and get reads them back as JSON
  assert.strictEqual(run(['get', 'tasks.exportDir', '--layer', 'project'], env).stdout.trim(), 'null');
  assert.deepStrictEqual(JSON.parse(run(['get', 'tasks.defaultListState[1]', '--layer', 'project'], env).stdout), 'done');
});

// ── project-layer [i] overwrite + [+] append; list reflects the override ────────────────────────────

check('project-layer [i] overwrites and [+] appends, round-tripping through get', () => {
  const root = freshRoot();
  const env = { TPM_PROJECT_ROOT: root };
  run(['set', 'tasks.defaultListState', '["open","in-progress"]'], env);
  run(['set', 'tasks.defaultListState[0]', 'blocked'], env); // overwrite index 0
  run(['set', 'tasks.defaultListState[+]', 'done'], env);     // append
  assert.deepStrictEqual(
    JSON.parse(run(['get', 'tasks.defaultListState', '--layer', 'project'], env).stdout),
    ['blocked', 'in-progress', 'done'],
  );
});

check('list reflects a project override layered on top of the shipped defaults', () => {
  const root = freshRoot();
  const env = { TPM_PROJECT_ROOT: root };
  run(['set', 'tasks.maxOpenWarn', '7'], env);
  const r = run(['list'], env);
  assert.strictEqual(r.code, 0, r.stderr);
  const cfg = JSON.parse(r.stdout);
  assert.strictEqual(cfg.tasks.maxOpenWarn, 7, 'overlaid list shows the project override');
  assert.strictEqual(cfg.tasks.startId, 1000, 'untouched defaults still present');
});

process.stdout.write(`\nPASS — ${count} checks\n`);
