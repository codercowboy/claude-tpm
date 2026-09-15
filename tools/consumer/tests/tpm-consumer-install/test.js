#!/usr/bin/env node
/**
 * test.js — unit test for tpm-consumer-install.js. Zero-dep (node `assert`), no `claude`/`npm`
 * spawned: every case drives the tool's exported PURE helpers directly, or (for the arg flag-guard's
 * process.exit path) spawns the tool as a child and asserts the exit code. Temp fixture dirs live under
 * os.tmpdir() and are cleaned up.
 *
 * Covers the fix-queue behaviors + the verifier's flagged risk areas:
 *   - parsePluginList (fix b) — the JSON→state mapping spun out of pluginState (THE PRIORITY)
 *   - parseArgs flag-guard (fix c) — --dir/--from reject a missing value or a "-"-leading value (exit 2)
 *   - hasTpmDependency, findBundleRoot (fix d), nodeModulesHasTpm (fix i), readPackageJson
 *
 * Usage: node tools/consumer/tests/tpm-consumer-install/test.js   → exit 0 all pass, 1 otherwise.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { mkScratch } = require('../../../tests/lib/scratch'); // shared: <bundle>/tmp/scratch/<run-slug>/

const TOOL = path.resolve(__dirname, '..', '..', 'tpm-consumer-install.js');
const inst = require(TOOL);
const { PLUGIN_ID, TPM_PKG_NAME } = inst;

let pass = 0; let fail = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ✓ ${name}\n`); pass += 1; }
  catch (e) { process.stdout.write(`  ✗ ${name}\n      ${e.message}\n`); fail += 1; }
}

// Run `fn` while capturing process.stderr.write output; returns { ret, warned }.
function captureStderr(fn) {
  const orig = process.stderr.write;
  let buf = '';
  process.stderr.write = (chunk) => { buf += chunk; return true; };
  try { const ret = fn(); return { ret, warned: buf }; }
  finally { process.stderr.write = orig; }
}

// Fixtures live under <bundle>/tmp/scratch/<run-slug>/ (shared helper) — one isolated, git-ignored
// folder per run, left in place for inspection. Nuke tmp/scratch/ wholesale when you want.
function mkTmp() { return mkScratch('tpm-install-test'); }
function cleanup() { /* no-op: per-run scratch persists for inspection; tmp/ is git-ignored */ }

process.stdout.write('tpm-consumer-install.test.js\n');

// ── parsePluginList (fix b) — JSON→state mapping ────────────────────────────────────────────────────
check('parsePluginList: enabled:true entry (project scope) → {installed:true, enabled:true}', () => {
  assert.deepStrictEqual(inst.parsePluginList([{ id: PLUGIN_ID, scope: 'project', enabled: true }]),
    { installed: true, enabled: true });
});
check('parsePluginList: enabled:false entry → {installed:true, enabled:false}', () => {
  assert.deepStrictEqual(inst.parsePluginList([{ id: PLUGIN_ID, scope: 'project', enabled: false }]),
    { installed: true, enabled: false });
});
check('parsePluginList: no matching entry (different id) → not installed', () => {
  assert.deepStrictEqual(inst.parsePluginList([{ id: 'other@market', enabled: true }]),
    { installed: false, enabled: false });
});
check('parsePluginList: empty array → not installed', () => {
  assert.deepStrictEqual(inst.parsePluginList([]), { installed: false, enabled: false });
});
check('parsePluginList: null (CLI unavailable / non-JSON) → not installed, no warn', () => {
  const { ret, warned } = captureStderr(() => inst.parsePluginList(null));
  assert.deepStrictEqual(ret, { installed: false, enabled: false });
  assert.strictEqual(warned, '', 'null is the quiet CLI-unavailable path, not a schema-drift warn');
});
check('parsePluginList: non-array output → warn + fallback not-installed', () => {
  const { ret, warned } = captureStderr(() => inst.parsePluginList({ not: 'an array' }));
  assert.deepStrictEqual(ret, { installed: false, enabled: false });
  assert.ok(/JSON array/i.test(warned), 'warns about non-array output');
});
check('parsePluginList: non-empty entries all missing `id` → warn + fallback not-installed', () => {
  const { ret, warned } = captureStderr(() => inst.parsePluginList([{ enabled: true }, { foo: 1 }]));
  assert.deepStrictEqual(ret, { installed: false, enabled: false });
  assert.ok(/id/i.test(warned), 'warns about missing id field');
});
check('parsePluginList: matched entry missing boolean `enabled` → installed+enabled + warn', () => {
  const { ret, warned } = captureStderr(() => inst.parsePluginList([{ id: PLUGIN_ID, scope: 'project' }]));
  assert.deepStrictEqual(ret, { installed: true, enabled: true });
  assert.ok(/enabled/i.test(warned), 'warns about missing boolean enabled');
});
check('parsePluginList: only a user-scoped entry → not installed (project-scoped lookup)', () => {
  assert.deepStrictEqual(inst.parsePluginList([{ id: PLUGIN_ID, scope: 'user', enabled: true }]),
    { installed: false, enabled: false });
});
check('parsePluginList: scope absent (undefined) → still matched', () => {
  assert.deepStrictEqual(inst.parsePluginList([{ id: PLUGIN_ID, enabled: true }]),
    { installed: true, enabled: true });
});
// VERIFIED live shape (claude 2.1.270) — a DISABLED project-scope entry carries every field and
// `enabled: false` (this is the schema that closed the old KNOWN LIMITATION about the disabled shape).
check('parsePluginList: full live disabled project-scope shape → {installed:true, enabled:false}', () => {
  assert.deepStrictEqual(inst.parsePluginList([{
    id: PLUGIN_ID, version: '0.1.0', scope: 'project', enabled: false,
    installPath: '/Users/x/.claude/plugins/cache/claude-tpm-market/claude-tpm/0.1.0',
    installedAt: '2026-09-14T20:11:54.268Z', lastUpdated: '2026-09-14T20:11:54.268Z',
    projectPath: '/some/consumer',
  }]), { installed: true, enabled: false });
});
// A manual `--scope local` install (as the session-015 version-skew rig used) reports scope:"local" —
// NOT what install.js manages (it always uses --scope project), so it must NOT be matched.
check('parsePluginList: a local-scope entry is NOT matched (install.js manages project scope only)', () => {
  assert.deepStrictEqual(inst.parsePluginList([{ id: PLUGIN_ID, scope: 'local', enabled: false }]),
    { installed: false, enabled: false });
});

// ── parseArgs flag-guard (fix c) ────────────────────────────────────────────────────────────────────
// Happy paths run in-process (no exit). Reject paths call process.exit(2), so exercise them via a child.
function runTool(args) {
  const r = spawnSync('node', [TOOL, ...args], { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
check('parseArgs: positional dir', () => {
  assert.strictEqual(inst.parseArgs(['../proj']).dir, '../proj');
});
check('parseArgs: --dir + --from flags parse', () => {
  const a = inst.parseArgs(['--dir', '../p', '--from', 'file:../claude-tpm']);
  assert.strictEqual(a.dir, '../p');
  assert.strictEqual(a.from, 'file:../claude-tpm');
});
check('parseArgs: no args → dir defaults to cwd', () => {
  assert.strictEqual(inst.parseArgs([]).dir, process.cwd());
});
check('flag-guard: `--from` with no value → exit 2', () => {
  assert.strictEqual(runTool(['--from']).status, 2);
});
check('flag-guard: `--from -x` (value starts with `-`) → exit 2', () => {
  assert.strictEqual(runTool(['--from', '-x']).status, 2);
});
check('flag-guard: `--dir` with no value → exit 2', () => {
  assert.strictEqual(runTool(['--dir']).status, 2);
});
check('flag-guard: `--dir --from ...` (--dir swallows a flag) → exit 2', () => {
  assert.strictEqual(runTool(['--dir', '--from', 'file:x']).status, 2);
});

// ── hasTpmDependency ────────────────────────────────────────────────────────────────────────────────
check('hasTpmDependency: dependencies bucket → true', () => {
  assert.strictEqual(inst.hasTpmDependency({ dependencies: { [TPM_PKG_NAME]: '1.0.0' } }), true);
});
check('hasTpmDependency: devDependencies bucket → true', () => {
  assert.strictEqual(inst.hasTpmDependency({ devDependencies: { [TPM_PKG_NAME]: 'file:x' } }), true);
});
check('hasTpmDependency: optionalDependencies bucket → true', () => {
  assert.strictEqual(inst.hasTpmDependency({ optionalDependencies: { [TPM_PKG_NAME]: 'file:x' } }), true);
});
check('hasTpmDependency: only in peerDependencies (not a scanned bucket) → false', () => {
  assert.strictEqual(inst.hasTpmDependency({ peerDependencies: { [TPM_PKG_NAME]: 'x' } }), false);
});
check('hasTpmDependency: no dep → false', () => {
  assert.strictEqual(inst.hasTpmDependency({ dependencies: { lodash: '^4' } }), false);
});
check('hasTpmDependency: null pkg → false', () => {
  assert.strictEqual(inst.hasTpmDependency(null), false);
});

// ── findBundleRoot / neutral sentinel (fix d) ───────────────────────────────────────────────────────
function writePkg(dir, obj) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(obj)); }
check('findBundleRoot: walks up to the dir whose package.json name is @codercowboy/claude-tpm', () => {
  const root = mkTmp();
  writePkg(root, { name: TPM_PKG_NAME });
  const leaf = path.join(root, 'a', 'b');
  fs.mkdirSync(leaf, { recursive: true });
  assert.strictEqual(inst.findBundleRoot(leaf), root);
});
check('findBundleRoot: skips a package.json with a mismatched name and keeps walking up', () => {
  const root = mkTmp();
  writePkg(root, { name: TPM_PKG_NAME });
  const mid = path.join(root, 'mid');
  writePkg(mid, { name: 'some-other-package' }); // decoy — must be skipped, not matched
  const leaf = path.join(mid, 'leaf');
  fs.mkdirSync(leaf, { recursive: true });
  assert.strictEqual(inst.findBundleRoot(leaf), root);
});
check('findBundleRoot: skips an invalid-JSON package.json (unreadable marker) and keeps walking', () => {
  const root = mkTmp();
  writePkg(root, { name: TPM_PKG_NAME });
  const mid = path.join(root, 'mid');
  fs.mkdirSync(mid, { recursive: true });
  fs.writeFileSync(path.join(mid, 'package.json'), '{ not valid json');
  assert.strictEqual(inst.findBundleRoot(mid), root);
});

// ── nodeModulesHasTpm (fix i idempotency) ───────────────────────────────────────────────────────────
check('nodeModulesHasTpm: true when node_modules/<pkg>/package.json exists', () => {
  const dir = mkTmp();
  const pkgDir = path.join(dir, 'node_modules', TPM_PKG_NAME);
  writePkg(pkgDir, { name: TPM_PKG_NAME });
  assert.strictEqual(inst.nodeModulesHasTpm(dir), true);
});
check('nodeModulesHasTpm: false when absent', () => {
  const dir = mkTmp();
  assert.strictEqual(inst.nodeModulesHasTpm(dir), false);
});
check('nodeModulesHasTpm: false for a dangling symlink (target missing → not present)', () => {
  const dir = mkTmp();
  const scopeDir = path.join(dir, 'node_modules', '@codercowboy');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.symlinkSync(path.join(dir, 'does-not-exist'), path.join(scopeDir, 'claude-tpm'));
  assert.strictEqual(inst.nodeModulesHasTpm(dir), false);
});

// ── readPackageJson ─────────────────────────────────────────────────────────────────────────────────
check('readPackageJson: exists + valid → {exists:true, value, error:null}', () => {
  const dir = mkTmp();
  writePkg(dir, { name: 'consumer', version: '1.2.3' });
  const r = inst.readPackageJson(dir);
  assert.strictEqual(r.exists, true);
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.value.version, '1.2.3');
});
check('readPackageJson: exists + invalid JSON → {exists:true, value:null, error:<string>}', () => {
  const dir = mkTmp();
  fs.writeFileSync(path.join(dir, 'package.json'), '{ broken');
  const r = inst.readPackageJson(dir);
  assert.strictEqual(r.exists, true);
  assert.strictEqual(r.value, null);
  assert.ok(typeof r.error === 'string' && r.error.length > 0, 'carries a parse error message');
});
check('readPackageJson: absent → {exists:false, value:null, error:null}', () => {
  const r = inst.readPackageJson(mkTmp());
  assert.deepStrictEqual(r, { exists: false, value: null, error: null });
});

// ── parseHooksManifest (2a: hooks-delivery health, pure) ─────────────────────────────────────────────
const REAL_MANIFEST = {
  hooks: {
    PreToolUse: [
      { matcher: 'Agent|Task', hooks: [{ type: 'command', command: 'npx tpm hooks gate-spawn' }] },
      { matcher: 'Read|Glob|Grep|NotebookRead', hooks: [{ type: 'command', command: 'npx tpm hooks expand-tpm-home' }] },
    ],
  },
};
check('parseHooksManifest: the real hooks.json → both hooks detected', () => {
  assert.deepStrictEqual(inst.parseHooksManifest(REAL_MANIFEST), { gateSpawn: true, expandTpmHome: true });
});
check('parseHooksManifest: matches by substring so a `node …` command form still detects', () => {
  const legacy = { hooks: { PreToolUse: [
    { hooks: [{ command: 'node x/tools/workflow/hooks/tpm-workflow-gate-spawn.js' }] },
  ] } };
  // command lacks "hooks gate-spawn" wording → NOT matched (we key on the routed `hooks <name>` form)
  assert.strictEqual(inst.parseHooksManifest(legacy).gateSpawn, false);
  const routed = { hooks: { PreToolUse: [{ hooks: [{ command: 'tpm hooks gate-spawn' }] }] } };
  assert.strictEqual(inst.parseHooksManifest(routed).gateSpawn, true);
});
check('parseHooksManifest: only one hook present → the other stays false', () => {
  const partial = { hooks: { PreToolUse: [{ hooks: [{ command: 'npx tpm hooks gate-spawn' }] }] } };
  assert.deepStrictEqual(inst.parseHooksManifest(partial), { gateSpawn: true, expandTpmHome: false });
});
check('parseHooksManifest: garbage/empty input → both false, no throw', () => {
  assert.deepStrictEqual(inst.parseHooksManifest(null), { gateSpawn: false, expandTpmHome: false });
  assert.deepStrictEqual(inst.parseHooksManifest({}), { gateSpawn: false, expandTpmHome: false });
  assert.deepStrictEqual(inst.parseHooksManifest({ hooks: { PreToolUse: 'nope' } }), { gateSpawn: false, expandTpmHome: false });
});

// ── bundleHooksHealth (2a: disk read from the target's node_modules) ─────────────────────────────────
function writeBundleHooks(dir, manifestOrRaw) {
  const hooksDir = path.join(dir, 'node_modules', TPM_PKG_NAME, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'hooks.json'),
    typeof manifestOrRaw === 'string' ? manifestOrRaw : JSON.stringify(manifestOrRaw));
}
check('bundleHooksHealth: absent manifest → present:false (degrades to skip)', () => {
  assert.deepStrictEqual(inst.bundleHooksHealth(mkTmp()),
    { present: false, error: null, gateSpawn: false, expandTpmHome: false });
});
check('bundleHooksHealth: real delivered manifest → present + both hooks', () => {
  const dir = mkTmp();
  writeBundleHooks(dir, REAL_MANIFEST);
  assert.deepStrictEqual(inst.bundleHooksHealth(dir),
    { present: true, error: null, gateSpawn: true, expandTpmHome: true });
});
check('bundleHooksHealth: malformed manifest JSON → present:true + error, hooks false', () => {
  const dir = mkTmp();
  writeBundleHooks(dir, '{ not json');
  const r = inst.bundleHooksHealth(dir);
  assert.strictEqual(r.present, true);
  assert.ok(typeof r.error === 'string' && r.error.length > 0);
  assert.strictEqual(r.gateSpawn, false);
});

// ── configJsonValidity (2b: consumer override config parse-validity) ─────────────────────────────────
function writeConsumerConfig(dir, raw) {
  const cdir = path.join(dir, '.claude', 'claude-tpm');
  fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(path.join(cdir, 'config.json'), raw);
}
check('configJsonValidity: absent → present:false, valid:true (defaults are fine)', () => {
  assert.deepStrictEqual(inst.configJsonValidity(mkTmp()), { present: false, valid: true, error: null });
});
check('configJsonValidity: present + valid JSON → present:true, valid:true', () => {
  const dir = mkTmp();
  writeConsumerConfig(dir, '{"session":{"enabled":true}}');
  assert.deepStrictEqual(inst.configJsonValidity(dir), { present: true, valid: true, error: null });
});
check('configJsonValidity: present + malformed → present:true, valid:false + error', () => {
  const dir = mkTmp();
  writeConsumerConfig(dir, '{ broken');
  const r = inst.configJsonValidity(dir);
  assert.strictEqual(r.present, true);
  assert.strictEqual(r.valid, false);
  assert.ok(typeof r.error === 'string' && r.error.length > 0);
});

cleanup();
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
