#!/usr/bin/env node
/**
 * tests/session/lib-config/test.js — genuine tests for tools/session/tpm-session-config.js.
 *
 * PURPOSE
 *   The `session` config-section resolver (build-plan.md task A1): defaults, merge-over-
 *   defaults semantics (booleans/strings/nested `notes`/legacy flat `sessionsDir`), the
 *   default-location-missing-is-not-an-error rule vs. an EXPLICIT --config that's missing
 *   (which IS an error), bad-JSON handling, and the CLI surface.
 *
 *   tpm-session-config.js resolves the project root by walking UP from a start directory looking for a
 *   CLAUDE.md marker (tpm-session-paths.js#findRoot). Because this phase folder's sandbox lives INSIDE
 *   the real repo (which has its own real CLAUDE.md far above), every sandbox this file builds
 *   plants its OWN fake CLAUDE.md at the sandbox root so findRoot stops there — never at the
 *   real repo root — keeping every test fully isolated from any real config.json.
 *
 * HOW TO RUN
 *   node tests/session/lib-config/test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeChecker, runNode, mkSandbox, TOOLS } = require('../lib/harness');

const cfg = require(TOOLS.config);
const { check, count } = makeChecker();

/** A fresh sandbox "project": has its own CLAUDE.md marker so findRoot never escapes it. */
function fakeProject(prefix) {
  const root = mkSandbox(prefix);
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# fake project marker, for test isolation\n');
  return root;
}

function writeConfig(root, sessionSection) {
  const dir = path.join(root, '.claude', 'claude-tpm');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ session: sessionSection }, null, 2));
}

// ---- getDefaults ---------------------------------------------------------------

check('getDefaults returns the documented default shape', () => {
  const d = cfg.getDefaults();
  assert.deepStrictEqual(d, {
    enabled: true,
    notes: { enabled: true, sessionsDir: '.claude/claude-tpm/sessions' },
    showTPMOpenMessage: true,
    showTPMCloseMessage: true,
    additionalOpenMessage: '',
    additionalCloseMessage: '',
  });
});

check('getDefaults returns a fresh deep clone each call (mutating one result must not affect the next)', () => {
  const a = cfg.getDefaults();
  a.notes.enabled = false;
  a.notes.sessionsDir = 'MUTATED';
  const b = cfg.getDefaults();
  assert.strictEqual(b.notes.enabled, true);
  assert.strictEqual(b.notes.sessionsDir, '.claude/claude-tpm/sessions');
});

// ---- mergeSessionConfig ---------------------------------------------------------

check('mergeSessionConfig returns defaults for a missing/non-object session section', () => {
  assert.deepStrictEqual(cfg.mergeSessionConfig(undefined), cfg.getDefaults());
  assert.deepStrictEqual(cfg.mergeSessionConfig(null), cfg.getDefaults());
  assert.deepStrictEqual(cfg.mergeSessionConfig('not-an-object'), cfg.getDefaults());
  assert.deepStrictEqual(cfg.mergeSessionConfig([1, 2, 3]), cfg.getDefaults());
});

check('mergeSessionConfig overrides top-level booleans and message strings', () => {
  const merged = cfg.mergeSessionConfig({
    enabled: false,
    showTPMOpenMessage: false,
    showTPMCloseMessage: false,
    additionalOpenMessage: 'hi open',
    additionalCloseMessage: 'hi close',
  });
  assert.strictEqual(merged.enabled, false);
  assert.strictEqual(merged.showTPMOpenMessage, false);
  assert.strictEqual(merged.showTPMCloseMessage, false);
  assert.strictEqual(merged.additionalOpenMessage, 'hi open');
  assert.strictEqual(merged.additionalCloseMessage, 'hi close');
  // notes untouched -> stays at defaults
  assert.deepStrictEqual(merged.notes, { enabled: true, sessionsDir: '.claude/claude-tpm/sessions' });
});

check('mergeSessionConfig honors a legacy flat `sessionsDir` (pre-nesting back-compat)', () => {
  const merged = cfg.mergeSessionConfig({ sessionsDir: 'legacy/path/sessions' });
  assert.strictEqual(merged.notes.sessionsDir, 'legacy/path/sessions');
  assert.strictEqual(merged.notes.enabled, true); // untouched
});

check('mergeSessionConfig honors the nested `notes.{enabled,sessionsDir}` and it OVERRIDES the legacy flat key when both are present', () => {
  const merged = cfg.mergeSessionConfig({
    sessionsDir: 'legacy/path', // should be superseded by the nested value below
    notes: { enabled: false, sessionsDir: 'nested/path' },
  });
  assert.strictEqual(merged.notes.enabled, false);
  assert.strictEqual(merged.notes.sessionsDir, 'nested/path');
});

check('mergeSessionConfig ignores wrong-typed fields (a number where a boolean/string is expected) and keeps the default', () => {
  const merged = cfg.mergeSessionConfig({ enabled: 'yes', additionalOpenMessage: 42, notes: { enabled: 'nope' } });
  assert.strictEqual(merged.enabled, true); // default, wrong type ignored
  assert.strictEqual(merged.additionalOpenMessage, ''); // default, wrong type ignored
  assert.strictEqual(merged.notes.enabled, true); // default, wrong type ignored
});

// ---- resolveSessionConfig --------------------------------------------------------

check('resolveSessionConfig at the default location, with NO config.json present, resolves to defaults (not an error)', () => {
  const root = fakeProject('resolve-default-missing');
  const { resolved, configExists, projectRoot } = cfg.resolveSessionConfig(undefined, { startDir: root });
  assert.strictEqual(configExists, false);
  assert.strictEqual(projectRoot, root);
  assert.deepStrictEqual(resolved, cfg.getDefaults());
});

check('resolveSessionConfig with an EXPLICIT --config path that does not exist THROWS ENOENT_CONFIG', () => {
  const root = fakeProject('resolve-explicit-missing');
  const missing = path.join(root, 'nope.json');
  assert.throws(
    () => cfg.resolveSessionConfig(missing, { startDir: root }),
    (err) => err.code === 'ENOENT_CONFIG',
  );
});

check('resolveSessionConfig reads and merges a real config.json at the default location', () => {
  const root = fakeProject('resolve-real-config');
  writeConfig(root, { enabled: true, notes: { enabled: false, sessionsDir: 'custom/sessions' } });
  const { resolved, configExists } = cfg.resolveSessionConfig(undefined, { startDir: root });
  assert.strictEqual(configExists, true);
  assert.strictEqual(resolved.notes.enabled, false);
  assert.strictEqual(resolved.notes.sessionsDir, 'custom/sessions');
});

check('resolveSessionConfig THROWS EBADJSON for a config.json that is not valid JSON', () => {
  const root = fakeProject('resolve-bad-json');
  const dir = path.join(root, '.claude', 'claude-tpm');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{ this is not json ');
  assert.throws(
    () => cfg.resolveSessionConfig(undefined, { startDir: root }),
    (err) => err.code === 'EBADJSON',
  );
});

// ---- sessionsDirAbs ---------------------------------------------------------------

check('sessionsDirAbs joins a relative sessionsDir onto projectRoot', () => {
  const resolved = cfg.getDefaults();
  assert.strictEqual(cfg.sessionsDirAbs(resolved, '/some/root'), path.join('/some/root', '.claude/claude-tpm/sessions'));
});

check('sessionsDirAbs passes an already-absolute sessionsDir through unchanged', () => {
  const resolved = { notes: { sessionsDir: '/already/absolute/dir' } };
  assert.strictEqual(cfg.sessionsDirAbs(resolved, '/some/root'), '/already/absolute/dir');
});

// ---- getDotted ---------------------------------------------------------------------

check('getDotted resolves a nested dotted key', () => {
  const r = cfg.getDotted({ notes: { sessionsDir: 'x' } }, 'notes.sessionsDir');
  assert.deepStrictEqual(r, { found: true, value: 'x' });
});

check('getDotted reports found: false for a missing key', () => {
  const r = cfg.getDotted({ notes: {} }, 'notes.doesNotExist');
  assert.strictEqual(r.found, false);
});

// ---- CLI surface (subprocess) -------------------------------------------------------

check('CLI --json prints the resolved defaults when run inside a fake project with no config.json', () => {
  const root = fakeProject('cli-json-defaults');
  const r = runNode(TOOLS.config, ['--json'], { cwd: root });
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(JSON.parse(r.stdout), cfg.getDefaults());
});

check('CLI --get notes.sessionsDir prints the resolved value as JSON', () => {
  const root = fakeProject('cli-get');
  const r = runNode(TOOLS.config, ['--get', 'notes.sessionsDir'], { cwd: root });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout.trim(), '".claude/claude-tpm/sessions"');
});

check('CLI --get on an unknown key exits 1', () => {
  const root = fakeProject('cli-get-unknown');
  const r = runNode(TOOLS.config, ['--get', 'nope.nope'], { cwd: root });
  assert.strictEqual(r.code, 1);
  assert.ok(/no such key/.test(r.stderr));
});

check('CLI --sessions-dir prints a bare absolute path (no JSON quoting)', () => {
  const root = fakeProject('cli-sessions-dir');
  const r = runNode(TOOLS.config, ['--sessions-dir'], { cwd: root });
  assert.strictEqual(r.code, 0);
  const printed = r.stdout.trim();
  assert.ok(!printed.startsWith('"'), 'must be a bare path, not JSON-quoted');
  assert.strictEqual(printed, path.join(root, '.claude/claude-tpm/sessions'));
});

check('CLI with no flags exits 1 and prints usage', () => {
  const root = fakeProject('cli-no-flags');
  const r = runNode(TOOLS.config, [], { cwd: root });
  assert.strictEqual(r.code, 1);
  assert.ok(/nothing to do/.test(r.stderr));
});

check('CLI --config pointing at a nonexistent explicit path exits 1', () => {
  const root = fakeProject('cli-explicit-missing');
  const r = runNode(TOOLS.config, ['--json', '--config', path.join(root, 'nope.json')], { cwd: root });
  assert.strictEqual(r.code, 1);
  assert.ok(/does not exist/.test(r.stderr));
});

// ---- readModuleEnablement (the boot MOTD's module map) -----------------------------

/** Write a full config.json (arbitrary sections) at a fake project's default location. */
function writeFullConfig(root, obj) {
  const dir = path.join(root, '.claude', 'claude-tpm');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(obj, null, 2));
}

check('readModuleEnablement: no config at the default location => every module enabled', () => {
  const root = fakeProject('modules-default-missing');
  const { modules, configExists } = cfg.readModuleEnablement(undefined, { startDir: root });
  assert.strictEqual(configExists, false);
  assert.deepStrictEqual(modules, { session: true, workflow: true, tasks: true, hygiene: true });
});

check('readModuleEnablement: honors explicit "enabled": false per module, defaults absent sections to true', () => {
  const root = fakeProject('modules-mixed');
  writeFullConfig(root, {
    session: { enabled: true },
    workflow: { enabled: false },
    tasks: { enabled: true },
    // hygiene section entirely absent -> defaults true
  });
  const { modules } = cfg.readModuleEnablement(undefined, { startDir: root });
  assert.deepStrictEqual(modules, { session: true, workflow: false, tasks: true, hygiene: true });
});

check('readModuleEnablement: a non-boolean or non-object section falls back to enabled', () => {
  const root = fakeProject('modules-wrongtype');
  writeFullConfig(root, { workflow: { enabled: 'nope' }, tasks: 'not-an-object' });
  const { modules } = cfg.readModuleEnablement(undefined, { startDir: root });
  assert.deepStrictEqual(modules, { session: true, workflow: true, tasks: true, hygiene: true });
});

check('readModuleEnablement: malformed JSON is LENIENT (no throw) — every module enabled + a warning', () => {
  const root = fakeProject('modules-badjson');
  const dir = path.join(root, '.claude', 'claude-tpm');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{ this is not json ');
  let warned = '';
  const { modules } = cfg.readModuleEnablement(undefined, { startDir: root, warn: (m) => { warned += m; } });
  assert.deepStrictEqual(modules, { session: true, workflow: true, tasks: true, hygiene: true });
  assert.ok(/could not parse/.test(warned), 'a malformed config should emit a parse warning');
});

check('readModuleEnablement: an EXPLICIT --config path that does not exist THROWS ENOENT_CONFIG', () => {
  const root = fakeProject('modules-explicit-missing');
  assert.throws(
    () => cfg.readModuleEnablement(path.join(root, 'nope.json'), { startDir: root }),
    (err) => err.code === 'ENOENT_CONFIG',
  );
});

check('CLI --modules prints the enablement map as JSON (defaults, no config)', () => {
  const root = fakeProject('cli-modules-defaults');
  const r = runNode(TOOLS.config, ['--modules'], { cwd: root });
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(JSON.parse(r.stdout), { session: true, workflow: true, tasks: true, hygiene: true });
});

check('CLI --modules reflects a disabled module from a real config.json', () => {
  const root = fakeProject('cli-modules-disabled');
  writeFullConfig(root, { workflow: { enabled: false } });
  const r = runNode(TOOLS.config, ['--modules'], { cwd: root });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(JSON.parse(r.stdout).workflow, false);
});

check('CLI --modules stays lenient on a malformed config (exit 0, all enabled)', () => {
  const root = fakeProject('cli-modules-badjson');
  const dir = path.join(root, '.claude', 'claude-tpm');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{ not json ');
  const r = runNode(TOOLS.config, ['--modules'], { cwd: root });
  assert.strictEqual(r.code, 0, 'boot must not crash on a malformed config');
  assert.deepStrictEqual(JSON.parse(r.stdout), { session: true, workflow: true, tasks: true, hygiene: true });
});

process.stdout.write(`\nALL PASS (${count()} checks) — tests/session/lib-config/test.js\n`);
process.exit(0);
