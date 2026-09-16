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

// ── parseMarketplaceList — the "marketplace registered but points at the wrong place" shape ────────────
// VERIFIED live shape (claude 2.1.272): array of { name, source, path?, repo?, installLocation }.
// marketplaceSourceHealth (the reader) then fs.existsSync()-checks a directory source's `path`; the
// registered-but-source-gone case (dead-source) is the failure this guards. Pure mapping tested here.
const MK = inst.MARKETPLACE_NAME;
check('parseMarketplaceList: directory-source entry → {registered, source:"directory", path}', () => {
  assert.deepStrictEqual(
    inst.parseMarketplaceList([{ name: MK, source: 'directory', path: '/some/dir', installLocation: '/some/dir' }]),
    { registered: true, source: 'directory', path: '/some/dir' });
});
check('parseMarketplaceList: github-source entry → registered, no local path', () => {
  assert.deepStrictEqual(
    inst.parseMarketplaceList([{ name: MK, source: 'github', repo: 'owner/repo', installLocation: '/cache' }]),
    { registered: true, source: 'github', path: null });
});
check('parseMarketplaceList: our market absent (only others) → not registered', () => {
  assert.deepStrictEqual(
    inst.parseMarketplaceList([{ name: 'claude-plugins-official', source: 'github', repo: 'a/b' }]),
    { registered: false, source: null, path: null });
});
check('parseMarketplaceList: null / non-array → not registered', () => {
  assert.deepStrictEqual(inst.parseMarketplaceList(null), { registered: false, source: null, path: null });
  assert.deepStrictEqual(inst.parseMarketplaceList({ nope: 1 }), { registered: false, source: null, path: null });
});

// ── parsePluginInstallPath — the "plugin version registered but it's not there" (cache-miss) shape ─────
// The installed RECORD carries installPath (its cache dir); pluginCacheHealth (the reader) fs.existsSync()-
// checks it — a record whose cache dir is gone is the cache-miss failure. Pure extraction tested here.
check('parsePluginInstallPath: our project-scope entry → its installPath', () => {
  assert.strictEqual(
    inst.parsePluginInstallPath([{ id: PLUGIN_ID, scope: 'project', installPath: '/cache/x/0.1.0' }]),
    '/cache/x/0.1.0');
});
check('parsePluginInstallPath: entry present but no installPath field → null', () => {
  assert.strictEqual(inst.parsePluginInstallPath([{ id: PLUGIN_ID, scope: 'project' }]), null);
});
check('parsePluginInstallPath: a local-scope entry is NOT matched → null', () => {
  assert.strictEqual(inst.parsePluginInstallPath([{ id: PLUGIN_ID, scope: 'local', installPath: '/c' }]), null);
});
check('parsePluginInstallPath: no matching id / null → null', () => {
  assert.strictEqual(inst.parsePluginInstallPath([{ id: 'other@m', installPath: '/c' }]), null);
  assert.strictEqual(inst.parsePluginInstallPath(null), null);
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

// ── --debug operation-trace flag + formatChildExit (the instrumentation rows) ─────────────────────────
check('parseArgs: --debug sets opts.debug (default false, order-independent)', () => {
  assert.strictEqual(inst.parseArgs(['--debug']).debug, true);
  assert.strictEqual(inst.parseArgs([]).debug, false);
  assert.strictEqual(inst.parseArgs(['../proj', '--debug', '--quiet']).debug, true);
});
check('debugEnabled: true from opts.debug OR a non-empty TPM_DEBUG env', () => {
  assert.strictEqual(inst.debugEnabled({ debug: true }), true);
  const saved = process.env.TPM_DEBUG;
  delete process.env.TPM_DEBUG;
  assert.strictEqual(inst.debugEnabled({ debug: false }), false);
  process.env.TPM_DEBUG = '1';
  assert.strictEqual(inst.debugEnabled({ debug: false }), true);
  if (saved === undefined) delete process.env.TPM_DEBUG; else process.env.TPM_DEBUG = saved;
});
check('formatChildExit: status 0 → "ok"', () => {
  assert.strictEqual(inst.formatChildExit({ status: 0, signal: null }), 'ok');
});
check('formatChildExit: status>0 → "exited N"', () => {
  assert.strictEqual(inst.formatChildExit({ status: 3, signal: null }), 'exited 3');
  assert.strictEqual(inst.formatChildExit({ status: 127, signal: null }), 'exited 127');
});
check('formatChildExit: status null names the killing signal (the exit-null case)', () => {
  assert.strictEqual(inst.formatChildExit({ status: null, signal: 'SIGTTIN' }),
    'exited null (killed by signal SIGTTIN)');
});
check('formatChildExit: status null with no signal → "…unknown"', () => {
  assert.strictEqual(inst.formatChildExit({ status: null, signal: null }),
    'exited null (killed by signal unknown)');
});
check('makeDbg: disabled → no-op; enabled → one [tpm-debug]-prefixed stdout line', () => {
  assert.strictEqual(typeof inst.makeDbg(false), 'function');
  const orig = process.stdout.write; let buf = '';
  process.stdout.write = (chunk) => { buf += chunk; return true; };
  try { inst.makeDbg(false)('hidden'); inst.makeDbg(true)('→ spawn:', 'claude', 'x'); }
  finally { process.stdout.write = orig; }
  assert.ok(!/hidden/.test(buf), 'disabled dbg writes nothing');
  assert.ok(/^\[tpm-debug\] → spawn: claude x\n$/.test(buf), 'enabled dbg writes one prefixed line');
});

// ── classifySpawn / EACCES-blind-spot fix (the honest-availability primitive) ─────────────────────────
// The bug: a non-runnable `claude` on PATH (a directory or non-exec file shadowing the real bin) makes
// spawnSync return EACCES, not ENOENT — the old ENOENT-only checks called it AVAILABLE and preflight
// wrongly passed. These feed fake spawn result shapes to the pure helpers so the misdetection is caught
// deterministically, without depending on the ambient `claude` being runnable or not.
check('classifySpawn: clean run (status 0) → ok + ran, no errorCode', () => {
  assert.deepStrictEqual(inst.classifySpawn({ status: 0, signal: null }),
    { ok: true, ran: true, status: 0, signal: null, errorCode: null });
});
check('classifySpawn: ENOENT (absent bin) → not ok, not ran, errorCode ENOENT', () => {
  const c = inst.classifySpawn({ error: { code: 'ENOENT' }, status: null });
  assert.strictEqual(c.ok, false); assert.strictEqual(c.ran, false); assert.strictEqual(c.errorCode, 'ENOENT');
});
check('classifySpawn: EACCES (dir/non-exec shadow on PATH) → not ok, not ran, errorCode EACCES (the blind spot)', () => {
  const c = inst.classifySpawn({ error: { code: 'EACCES' }, status: null });
  assert.strictEqual(c.ok, false); assert.strictEqual(c.ran, false); assert.strictEqual(c.errorCode, 'EACCES');
});
check('classifySpawn: ran but exited non-zero → not ok, ran true, no errorCode', () => {
  const c = inst.classifySpawn({ status: 3, signal: null });
  assert.strictEqual(c.ok, false); assert.strictEqual(c.ran, true);
  assert.strictEqual(c.errorCode, null); assert.strictEqual(c.status, 3);
});
check('classifySpawn: signal-killed (status null, no error) → ran true, status null, no errorCode', () => {
  const c = inst.classifySpawn({ status: null, signal: 'SIGTTIN' });
  assert.strictEqual(c.ran, true); assert.strictEqual(c.status, null);
  assert.strictEqual(c.signal, 'SIGTTIN'); assert.strictEqual(c.errorCode, null);
});
check('formatChildExit: a spawn error → "could not run (CODE: reason)", NOT a signal branch', () => {
  assert.strictEqual(inst.formatChildExit({ error: { code: 'EACCES' } }), 'could not run (EACCES: permission denied)');
  assert.strictEqual(inst.formatChildExit({ error: { code: 'ENOENT' } }), 'could not run (ENOENT: not found on PATH)');
  // a runChild-shaped result (carries errorCode, not error) renders identically
  assert.strictEqual(inst.formatChildExit({ errorCode: 'EACCES', status: null, signal: null }),
    'could not run (EACCES: permission denied)');
});
check('preflightMessage: ENOENT → "not found on PATH" + install hint', () => {
  const m = inst.preflightMessage('claude', inst.classifySpawn({ error: { code: 'ENOENT' } }), 'install Claude Code first.');
  assert.ok(/not found on PATH/.test(m));
  assert.ok(/install Claude Code first\./.test(m));
});
check('preflightMessage: EACCES → "found but not executable" + host-vs-VM hint', () => {
  const m = inst.preflightMessage('claude', inst.classifySpawn({ error: { code: 'EACCES' } }), 'install Claude Code first.');
  assert.ok(/not executable \(EACCES\)/.test(m));
  assert.ok(/THIS host/.test(m));
  assert.ok(/VM/.test(m));
});
check('spawnErrorReason: known errno mapped, unknown → generic', () => {
  assert.strictEqual(inst.spawnErrorReason('ENOENT'), 'not found on PATH');
  assert.strictEqual(inst.spawnErrorReason('EACCES'), 'permission denied');
  assert.strictEqual(inst.spawnErrorReason('EWHATEVER'), 'spawn error');
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

// ── doDependencyStep — the NEW interactive, consent-gated dependency recorder (branch logic) ──────────
// Driven as a CHILD PROCESS so the REAL piped stdin + shared prompter path is exercised, with a FAKE
// `npm` first on PATH (it records its argv + simulates the install) so no real npm/registry is touched.
const FAKE_NPM = `#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path');
const a=process.argv.slice(2);
try{fs.appendFileSync(process.env.NPM_LOG,JSON.stringify(a)+'\\n')}catch(e){}
if(a[0]==='--version'){process.stdout.write('9.9.9\\n');process.exit(0)}
if(a[0]==='install'){
  const flag=a[a.length-1];
  const bucket=flag==='--save'?'dependencies':(flag==='--save-optional'?'optionalDependencies':'dependencies');
  const pj=path.join(process.cwd(),'package.json');
  const pkg=JSON.parse(fs.readFileSync(pj,'utf8'));
  pkg[bucket]=pkg[bucket]||{}; pkg[bucket][process.env.FAKE_PKG]=a[1];
  fs.writeFileSync(pj,JSON.stringify(pkg,null,2));
  const nm=path.join(process.cwd(),'node_modules',process.env.FAKE_PKG);
  fs.mkdirSync(nm,{recursive:true});
  fs.writeFileSync(path.join(nm,'package.json'),JSON.stringify({name:process.env.FAKE_PKG}));
  process.exit(0);
}
process.exit(0);
`;
const DEP_DRIVER = `'use strict';
const inst=require(process.env.DEP_TOOL);
(async()=>{
  const r=await inst.doDependencyStep(
    {quiet:process.env.DEP_QUIET==='1',force:process.env.DEP_FORCE==='1'},
    {already:process.env.DEP_ALREADY==='1',describe:'Step 2/5 — add the claude-tpm dependency',targetDir:process.env.DEP_DIR,fromSpec:process.env.DEP_SPEC});
  process.stdout.write('\\n<<RESULT>>'+JSON.stringify(r));
  inst.closePrompter();
  process.exit(0);
})().catch(e=>{process.stderr.write('DRIVER-ERR:'+(e&&e.stack||e));process.exit(3)});
`;
function runDepStep({ answers, quiet, force, already }) {
  const work = mkTmp();
  const binDir = path.join(work, 'bin'); fs.mkdirSync(binDir, { recursive: true });
  const npmShim = path.join(binDir, 'npm'); fs.writeFileSync(npmShim, FAKE_NPM); fs.chmodSync(npmShim, 0o755);
  const driver = path.join(work, 'driver.js'); fs.writeFileSync(driver, DEP_DRIVER);
  const consumer = path.join(work, 'consumer'); fs.mkdirSync(consumer, { recursive: true });
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'c', version: '1.0.0' }, null, 2));
  const npmLog = path.join(work, 'npm.log');
  const env = Object.assign({}, process.env, {
    PATH: binDir + path.delimiter + process.env.PATH,
    NPM_LOG: npmLog, FAKE_PKG: TPM_PKG_NAME,
    DEP_TOOL: TOOL, DEP_DIR: consumer, DEP_SPEC: 'file:../bundle',
    DEP_QUIET: quiet ? '1' : '0', DEP_FORCE: force ? '1' : '0', DEP_ALREADY: already ? '1' : '0',
  });
  const r = spawnSync('node', [driver], { encoding: 'utf8', env, input: answers || '', timeout: 15000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = (r.stdout || '').match(/<<RESULT>>([\s\S]*)$/);
  const result = m ? JSON.parse(m[1].trim()) : null;
  const installCalls = fs.existsSync(npmLog)
    ? fs.readFileSync(npmLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((c) => c[0] === 'install') : [];
  const pkg = JSON.parse(fs.readFileSync(path.join(consumer, 'package.json'), 'utf8'));
  return { status: r.status, out, result, installCalls, pkg };
}

check('doDependencyStep: interactive OPTIONAL (y / enter / y) → --save-optional, dep in optionalDependencies', () => {
  const r = runDepStep({ answers: 'y\n\ny\n' });
  assert.strictEqual(r.result.ok, true);
  assert.deepStrictEqual(r.installCalls[0], ['install', 'file:../bundle', '--save-optional']);
  assert.ok(r.pkg.optionalDependencies && r.pkg.optionalDependencies[TPM_PKG_NAME], 'dep in optionalDependencies');
  assert.ok(!r.pkg.dependencies || !r.pkg.dependencies[TPM_PKG_NAME], 'not in dependencies');
  assert.ok(/Install .*into this project's package.json via npm\? \(y\/n\)/.test(r.out), 'asks the add-at-all question');
  assert.ok(/\(1\) regular dependency or \(2\) optional dependency\? \[default 2\]/.test(r.out), 'asks regular vs optional');
  assert.ok(/About to run: npm install .* --save-optional\. Proceed\? \(y\/n\)/.test(r.out), 'confirms the exact command');
});
check('doDependencyStep: interactive REGULAR (y / 1 / y) → --save, dep in dependencies', () => {
  const r = runDepStep({ answers: 'y\n1\ny\n' });
  assert.strictEqual(r.result.ok, true);
  assert.deepStrictEqual(r.installCalls[0], ['install', 'file:../bundle', '--save']);
  assert.ok(r.pkg.dependencies && r.pkg.dependencies[TPM_PKG_NAME], 'dep in dependencies');
  assert.ok(!r.pkg.optionalDependencies || !r.pkg.optionalDependencies[TPM_PKG_NAME], 'not in optionalDependencies');
});
check('doDependencyStep: DECLINE add-at-all (n) → skip, no npm, package.json untouched', () => {
  const r = runDepStep({ answers: 'n\n' });
  assert.strictEqual(r.result.ok, true);
  assert.strictEqual(r.result.skippedDep, true);
  assert.strictEqual(r.installCalls.length, 0, 'npm install never runs');
  assert.ok(!r.pkg.dependencies && !r.pkg.optionalDependencies, 'no dependency buckets added');
  assert.ok(/skipped — NOT recording/.test(r.out));
});
check('doDependencyStep: DECLINE the command confirm (y / 2 / n) → clean abort, nothing installed', () => {
  const r = runDepStep({ answers: 'y\n2\nn\n' });
  assert.strictEqual(r.result.ok, false);
  assert.strictEqual(r.result.declined, true);
  assert.strictEqual(r.installCalls.length, 0, 'npm install never runs');
  assert.ok(/declined — stopping/.test(r.out));
});
check('doDependencyStep: --quiet → NO prompts, records as OPTIONAL (unchanged headless behavior)', () => {
  const r = runDepStep({ quiet: true, answers: '' });
  assert.strictEqual(r.result.ok, true);
  assert.deepStrictEqual(r.installCalls[0], ['install', 'file:../bundle', '--save-optional']);
  assert.ok(r.pkg.optionalDependencies && r.pkg.optionalDependencies[TPM_PKG_NAME]);
  assert.ok(!/Install .*via npm\?/.test(r.out), 'quiet mode asks nothing');
});
check('doDependencyStep: already declared+present → skip without prompting or running npm', () => {
  const r = runDepStep({ already: true, answers: '' });
  assert.strictEqual(r.result.ok, true);
  assert.strictEqual(r.result.skipped, true);
  assert.strictEqual(r.installCalls.length, 0);
  assert.ok(/already done, skipping/.test(r.out));
});

// ── runInstall idempotency regression (marketplace already registered / plugin already installed) ─────
// Driven as a child process with a FAKE `claude` first on PATH (canned `--json` output); the mutating
// verbs are no-ops. Guards the "exited null / crash when already present" failure the coordinator flagged.
const TPM_BUNDLE_ROOT = inst.findBundleRoot(__dirname);
const CLAUDE_SHIM = `#!/usr/bin/env node
'use strict';
var scn={};try{scn=JSON.parse(process.env.TPM_FAKE||'{}')}catch(e){}
var a=process.argv.slice(2);
function emit(x){process.stdout.write(JSON.stringify(x));process.exit(0)}
if(a[0]==='--version'){process.stdout.write('9.9.9\\n');process.exit(0)}
if(a[0]==='plugin'&&a[1]==='marketplace'&&a[2]==='list'){emit(scn.marketplaceList||[])}
if(a[0]==='plugin'&&a[1]==='list'){emit(scn.pluginList||[])}
process.exit(0);
`;
function makeInstalledConsumer() {
  const dir = mkTmp();
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', optionalDependencies: { [TPM_PKG_NAME]: 'file:../x' } }, null, 2));
  const scope = path.join(dir, 'node_modules', '@codercowboy');
  fs.mkdirSync(scope, { recursive: true });
  fs.symlinkSync(TPM_BUNDLE_ROOT, path.join(scope, 'claude-tpm'));
  return dir;
}
function runInstallWithFakeClaude(dir, args, scenario) {
  const work = mkTmp();
  const shim = path.join(work, 'claude'); fs.writeFileSync(shim, CLAUDE_SHIM); fs.chmodSync(shim, 0o755);
  const env = Object.assign({}, process.env, {
    PATH: work + path.delimiter + process.env.PATH, TPM_FAKE: JSON.stringify(scenario || {}),
  });
  const r = spawnSync('node', [TOOL, dir].concat(args || []), { encoding: 'utf8', env, timeout: 20000 });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
check('runInstall idempotent: marketplace registered + plugin installed+enabled → all steps skip, doctor clean, exit 0', () => {
  const dir = makeInstalledConsumer();
  const r = runInstallWithFakeClaude(dir, ['--quiet'], {
    marketplaceList: [{ name: inst.MARKETPLACE_NAME, source: 'directory', path: TPM_BUNDLE_ROOT }],
    pluginList: [{ id: PLUGIN_ID, scope: 'project', enabled: true, installPath: TPM_BUNDLE_ROOT }],
  });
  assert.strictEqual(r.status, 0, 'clean idempotent re-install exits 0');
  assert.ok(!/exited null/.test(r.out), 'never prints "exited null"');
  assert.ok(/Step 3\/5 — register the claude-tpm marketplace — already done, skipping/.test(r.out), 'marketplace register skips');
  assert.ok(/Step 4\/5 — install the claude-tpm plugin — already done, skipping/.test(r.out), 'plugin install skips');
  assert.ok(/doctor clean/.test(r.out));
});
check('runInstall: marketplace already registered but plugin NOT installed → register skips, install runs, exits with an integer code (no crash/null)', () => {
  const dir = makeInstalledConsumer();
  const r = runInstallWithFakeClaude(dir, ['--quiet'], {
    marketplaceList: [{ name: inst.MARKETPLACE_NAME, source: 'directory', path: TPM_BUNDLE_ROOT }],
    pluginList: [],
  });
  assert.strictEqual(typeof r.status, 'number', 'exits with a real integer code, never null');
  assert.ok(!/exited null/.test(r.out), 'never prints "exited null"');
  assert.ok(/Step 3\/5 — register the claude-tpm marketplace — already done, skipping/.test(r.out), 'marketplace register skips cleanly');
});

cleanup();
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
