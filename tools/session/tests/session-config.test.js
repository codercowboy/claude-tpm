'use strict';
/**
 * session-config.test.js — the RESTORED session config resolver (#1123 Stage C gap-fix).
 *
 * tpm-session-config.js is format-agnostic plumbing the notes-rework never touched and Stage A
 * over-removed; this suite pins the behaviour the tpm-session skill's config-gate + sessions-dir
 * resolution depend on: the resolved default shape, config-over-defaults merge, sessionsDirAbs,
 * the cross-module enablement map (--modules), and the CLI surface (bare path / JSON / --get /
 * lenient-on-absent / loud-on-explicit-missing).
 *
 * Zero deps; hermetic (every config file is written into a fresh OS-tmp sandbox). Exits non-zero on
 * any failure (ship-tool bar).
 *
 * Run: node tests/session-config.test.js
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const { spawnSync } = require('child_process');

const cfg = require('../tpm-session-config');
const TOOL = path.join(__dirname, '..', 'tpm-session-config.js');

function runCli(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function writeConfig(obj) {
  const dir = tmpDir('tpm-session-config-');
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

// ── defaults + merge (module API) ──────────────────────────────────────────────

test('getDefaults returns the locked resolved shape (enabled, notes.enabled, sessionsDir default)', () => {
  const d = cfg.getDefaults();
  assert.strictEqual(d.enabled, true);
  assert.strictEqual(d.notes.enabled, true);
  assert.strictEqual(d.notes.sessionsDir, '.claude/claude-tpm/sessions');
  assert.strictEqual(d.showTPMOpenMessage, true);
});

test('resolveSessionConfig on a MISSING default location resolves to defaults (never an error)', () => {
  const dir = tmpDir('tpm-session-cfg-none-');
  const { resolved, configExists } = cfg.resolveSessionConfig(undefined, { startDir: dir });
  assert.strictEqual(configExists, false, 'a missing config is not an error');
  assert.strictEqual(resolved.enabled, true);
  assert.strictEqual(resolved.notes.sessionsDir, '.claude/claude-tpm/sessions');
});

test('mergeSessionConfig lets a config override enabled + notes.sessionsDir over defaults', () => {
  const merged = cfg.mergeSessionConfig({ enabled: false, notes: { enabled: false, sessionsDir: 'custom/sessions' } });
  assert.strictEqual(merged.enabled, false);
  assert.strictEqual(merged.notes.enabled, false);
  assert.strictEqual(merged.notes.sessionsDir, 'custom/sessions');
});

test('mergeSessionConfig honours a legacy FLAT sessionsDir (back-compat)', () => {
  const merged = cfg.mergeSessionConfig({ sessionsDir: 'flat/dir' });
  assert.strictEqual(merged.notes.sessionsDir, 'flat/dir');
});

test('resolveSessionConfig reads an EXPLICIT --config file and merges its session section', () => {
  const p = writeConfig({ session: { enabled: false, notes: { sessionsDir: 'explicit/sessions' } } });
  const { resolved, configExists } = cfg.resolveSessionConfig(p);
  assert.strictEqual(configExists, true);
  assert.strictEqual(resolved.enabled, false);
  assert.strictEqual(resolved.notes.sessionsDir, 'explicit/sessions');
});

test('sessionsDirAbs joins a relative sessionsDir onto projectRoot; leaves an absolute one alone', () => {
  assert.strictEqual(cfg.sessionsDirAbs({ notes: { sessionsDir: 'a/b' } }, '/root'), path.join('/root', 'a/b'));
  assert.strictEqual(cfg.sessionsDirAbs({ notes: { sessionsDir: '/abs/x' } }, '/root'), '/abs/x');
});

// ── module enablement map (--modules) ───────────────────────────────────────────

test('readModuleEnablement defaults every module to true when no config exists', () => {
  const dir = tmpDir('tpm-session-mods-none-');
  const { modules } = cfg.readModuleEnablement(undefined, { startDir: dir });
  assert.deepStrictEqual(modules, { session: true, workflow: true, tasks: true, hygiene: true });
});

test('readModuleEnablement reflects an explicit per-module enabled:false', () => {
  const p = writeConfig({ workflow: { enabled: false }, tasks: { enabled: false } });
  const { modules } = cfg.readModuleEnablement(p);
  assert.strictEqual(modules.workflow, false);
  assert.strictEqual(modules.tasks, false);
  assert.strictEqual(modules.session, true, 'an absent section defaults to enabled');
});

// ── CLI surface (subprocess, real exit codes) ────────────────────────────────────

test('CLI --json prints the resolved section as JSON (exit 0)', () => {
  const p = writeConfig({ session: { enabled: false } });
  const r = runCli(['--config', p, '--json']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(JSON.parse(r.stdout).enabled, false);
});

test('CLI --sessions-dir prints a bare absolute path (exit 0)', () => {
  const p = writeConfig({ session: { notes: { sessionsDir: '/abs/sessions' } } });
  const r = runCli(['--config', p, '--sessions-dir']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout.trim(), '/abs/sessions');
});

test('CLI --modules prints the enablement map as JSON (exit 0)', () => {
  const p = writeConfig({ hygiene: { enabled: false } });
  const r = runCli(['--config', p, '--modules']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(JSON.parse(r.stdout).hygiene, false);
});

test('CLI --get notes.enabled prints the resolved value (exit 0)', () => {
  const p = writeConfig({ session: { notes: { enabled: false } } });
  const r = runCli(['--config', p, '--get', 'notes.enabled']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout.trim(), 'false');
});

test('CLI with no action flag exits 1 (nothing to do)', () => {
  const r = runCli([]);
  assert.strictEqual(r.code, 1);
  assert.ok(/nothing to do/.test(r.stderr));
});

test('CLI with an EXPLICIT --config that does not exist exits 1 (loud)', () => {
  const r = runCli(['--config', path.join(tmpDir('cfg-missing-'), 'nope.json'), '--json']);
  assert.strictEqual(r.code, 1);
  assert.ok(/does not exist/.test(r.stderr));
});

test('CLI --help exits 0', () => {
  const r = runCli(['--help']);
  assert.strictEqual(r.code, 0);
  assert.ok(/Usage:/.test(r.stdout));
});

done('session-config.test');
