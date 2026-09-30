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
const uninst = require(path.resolve(path.dirname(TOOL), 'tpm-consumer-uninstall.js'));
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
// After #1126 gate-spawn is the SOLE auto-wired hook (the %TPM_HOME% resolution hooks were retired), so
// the real delivered manifest carries only a PreToolUse gate-spawn entry.
const REAL_MANIFEST = {
  hooks: {
    PreToolUse: [
      { matcher: 'Agent|Task', hooks: [{ type: 'command', command: 'npx tpm hooks gate-spawn' }] },
    ],
  },
};
const NODE_FORM = {
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/tools/tpm.js" hooks session-start' }] }],
    PreToolUse: [{ matcher: 'Agent|Task', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/tools/tpm.js" hooks gate-spawn' }] }],
  },
};
check('parseHooksManifest: node "${CLAUDE_PLUGIN_ROOT}" form → gate-spawn AND session-start detected', () => {
  assert.deepStrictEqual(inst.parseHooksManifest(NODE_FORM), { gateSpawn: true, sessionStart: true });
});
check('parseHooksManifest: the shipped hooks/hooks.json → both detected', () => {
  const real = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'hooks', 'hooks.json'), 'utf8'));
  assert.deepStrictEqual(inst.parseHooksManifest(real), { gateSpawn: true, sessionStart: true });
});
check('parseHooksManifest: session-start under the wrong event (PreToolUse) is NOT detected as sessionStart', () => {
  const wrong = { hooks: { PreToolUse: [{ hooks: [{ command: 'tpm hooks session-start' }] }] } };
  assert.deepStrictEqual(inst.parseHooksManifest(wrong), { gateSpawn: false, sessionStart: false });
});
check('parseHooksManifest: SessionStart alone → sessionStart true, gateSpawn false', () => {
  const only = { hooks: { SessionStart: [{ hooks: [{ command: 'tpm hooks session-start' }] }] } };
  assert.deepStrictEqual(inst.parseHooksManifest(only), { gateSpawn: false, sessionStart: true });
});
check('parseHooksManifest: the real hooks.json → gate-spawn detected', () => {
  assert.deepStrictEqual(inst.parseHooksManifest(REAL_MANIFEST), { gateSpawn: true, sessionStart: false });
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
check('parseHooksManifest: gate-spawn present in PreToolUse → detected', () => {
  const partial = { hooks: { PreToolUse: [{ hooks: [{ command: 'npx tpm hooks gate-spawn' }] }] } };
  assert.deepStrictEqual(inst.parseHooksManifest(partial), { gateSpawn: true, sessionStart: false });
});
check('parseHooksManifest: the retired %TPM_HOME% content hook is NOT detected (no such field)', () => {
  // The content hook was retired in #1126 — a stray one must not resurrect any field or affect gate-spawn.
  const stray = { hooks: { PostToolUse: [{ hooks: [{ command: 'npx tpm hooks expand-tpm-home-content' }] }] } };
  assert.deepStrictEqual(inst.parseHooksManifest(stray), { gateSpawn: false, sessionStart: false });
});
check('parseHooksManifest: garbage/empty input → gate-spawn false, no throw', () => {
  assert.deepStrictEqual(inst.parseHooksManifest(null), { gateSpawn: false, sessionStart: false });
  assert.deepStrictEqual(inst.parseHooksManifest({}), { gateSpawn: false, sessionStart: false });
  assert.deepStrictEqual(inst.parseHooksManifest({ hooks: { PreToolUse: 'nope' } }), { gateSpawn: false, sessionStart: false });
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
    { present: false, error: null, gateSpawn: false, sessionStart: false });
});
check('bundleHooksHealth: real delivered manifest → present + gate-spawn', () => {
  const dir = mkTmp();
  writeBundleHooks(dir, REAL_MANIFEST);
  assert.deepStrictEqual(inst.bundleHooksHealth(dir),
    { present: true, error: null, gateSpawn: true, sessionStart: false });
});
check('bundleHooksHealth: malformed manifest JSON → present:true + error, hooks false', () => {
  const dir = mkTmp();
  writeBundleHooks(dir, '{ not json');
  const r = inst.bundleHooksHealth(dir);
  assert.strictEqual(r.present, true);
  assert.ok(typeof r.error === 'string' && r.error.length > 0);
  assert.strictEqual(r.gateSpawn, false);
  assert.strictEqual(r.sessionStart, false, 'the parse-error early return carries the full shape incl. sessionStart');
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
  const bucket=flag==='--save'?'dependencies':(flag==='--save-optional'?'optionalDependencies':(flag==='--save-dev'?'devDependencies':'dependencies'));
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

check('doDependencyStep: interactive DEV (y / enter / y) → --save-dev, dep in devDependencies', () => {
  const r = runDepStep({ answers: 'y\n\ny\n' });
  assert.strictEqual(r.result.ok, true);
  assert.deepStrictEqual(r.installCalls[0], ['install', 'file:../bundle', '--save-dev']);
  assert.ok(r.pkg.devDependencies && r.pkg.devDependencies[TPM_PKG_NAME], 'dep in devDependencies');
  assert.ok(!r.pkg.dependencies || !r.pkg.dependencies[TPM_PKG_NAME], 'not in dependencies');
  assert.ok(!r.pkg.optionalDependencies || !r.pkg.optionalDependencies[TPM_PKG_NAME], 'not in optionalDependencies (0.2.0 default moved from optional → dev)');
  assert.ok(/Install .*into this project's package.json via npm\? \(y\/n\)/.test(r.out), 'asks the add-at-all question');
  assert.ok(/\(1\) regular dependency or \(2\) dev dependency\? \[default 2\]/.test(r.out), 'asks regular vs dev');
  assert.ok(/About to run: npm install .* --save-dev\. Proceed\? \(y\/n\)/.test(r.out), 'confirms the exact command');
});
check('doDependencyStep: interactive REGULAR (y / 1 / y) → --save, dep in dependencies', () => {
  const r = runDepStep({ answers: 'y\n1\ny\n' });
  assert.strictEqual(r.result.ok, true);
  assert.deepStrictEqual(r.installCalls[0], ['install', 'file:../bundle', '--save']);
  assert.ok(r.pkg.dependencies && r.pkg.dependencies[TPM_PKG_NAME], 'dep in dependencies');
  assert.ok(!r.pkg.devDependencies || !r.pkg.devDependencies[TPM_PKG_NAME], 'not in devDependencies');
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
check('doDependencyStep: --quiet → NO prompts, records as DEV (headless default: dev bucket)', () => {
  const r = runDepStep({ quiet: true, answers: '' });
  assert.strictEqual(r.result.ok, true);
  assert.deepStrictEqual(r.installCalls[0], ['install', 'file:../bundle', '--save-dev']);
  assert.ok(r.pkg.devDependencies && r.pkg.devDependencies[TPM_PKG_NAME]);
  assert.ok(!/Install .*via npm\?/.test(r.out), 'quiet mode asks nothing');
});
check('doDependencyStep: already declared+present → skip without prompting or running npm', () => {
  const r = runDepStep({ already: true, answers: '' });
  assert.strictEqual(r.result.ok, true);
  assert.strictEqual(r.result.skipped, true);
  assert.strictEqual(r.installCalls.length, 0);
  assert.ok(/already done, skipped/.test(r.out));
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
  assert.ok(/Step 3\/5 · Register the marketplace — already done, skipped/.test(r.out), 'marketplace register skips');
  assert.ok(/Step 4\/5 · Install the plugin — already done, skipped/.test(r.out), 'plugin install skips');
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
  assert.ok(/Step 3\/5 · Register the marketplace — already done, skipped/.test(r.out), 'marketplace register skips cleanly');
});

// ── #1132.C: the installer seeds a default config.json (idempotent, never clobbers) ─────────────────
check('#1132.C: ensureConsumerConfig writes .claude/claude-tpm/config.json with both store-dir keys', () => {
  const dir = mkTmp();
  const r = inst.ensureConsumerConfig(dir);
  assert.strictEqual(r.wrote, true, 'a fresh consumer gets a seeded config');
  assert.strictEqual(r.reason, 'created');
  const p = path.join(dir, '.claude', 'claude-tpm', 'config.json');
  assert.ok(fs.existsSync(p), 'config.json exists at .claude/claude-tpm/');
  const body = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(body.tasks.tasksDir, '.claude/claude-tpm/tasks', 'tasks.tasksDir default');
  assert.strictEqual(body.session.notes.sessionsDir, '.claude/claude-tpm/sessions', 'session.notes.sessionsDir default');
});

check('#1132.C: re-install is idempotent — an existing user config is NEVER clobbered', () => {
  const dir = mkTmp();
  const cdir = path.join(dir, '.claude', 'claude-tpm');
  fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(path.join(cdir, 'config.json'), JSON.stringify({ version: 1, tasks: { tasksDir: 'USER-EDIT' } }, null, 2));
  const r = inst.ensureConsumerConfig(dir);
  assert.strictEqual(r.wrote, false, 'does not overwrite');
  assert.strictEqual(r.reason, 'exists');
  const body = JSON.parse(fs.readFileSync(path.join(cdir, 'config.json'), 'utf8'));
  assert.strictEqual(body.tasks.tasksDir, 'USER-EDIT', 'the user value is preserved verbatim');
});

check('#1132.C: seedConfigDefaults mirrors the resolvers\' project-local defaults', () => {
  const seed = inst.seedConfigDefaults();
  assert.strictEqual(seed.tasks.tasksDir, '.claude/claude-tpm/tasks');
  assert.strictEqual(seed.session.notes.sessionsDir, '.claude/claude-tpm/sessions');
});

// ── marker-swap: the installer→marker contract — a fresh install produces the `.claude/claude-tpm/`
// DIRECTORY that the task/session dir-resolvers now detect as the project-root marker. This locks the
// contract: if ensureConsumerConfig's mkdir were removed, the writeFileSync would ENOENT and this throws.
check('marker-swap: a fresh install creates the `.claude/claude-tpm/` marker DIRECTORY (detectable by the resolvers)', () => {
  const dir = mkTmp();
  const r = inst.ensureConsumerConfig(dir);
  assert.strictEqual(r.wrote, true, 'a fresh consumer is seeded');
  const markerDir = path.join(dir, '.claude', 'claude-tpm');
  assert.ok(fs.existsSync(markerDir), 'the `.claude/claude-tpm/` marker path exists after install');
  assert.ok(fs.statSync(markerDir).isDirectory(),
    'the marker is a DIRECTORY (the install footprint the project-root finder keys off)');
});

// ── version-scoped marketplace identity (the cross-version registry-collision fix) ──────────────────
// The marketplace name MUST be version-scoped so two installed versions of claude-tpm don't fight over
// one global "claude-tpm-market" singleton in ~/.claude/plugins/known_marketplaces.json (last-add-wins
// → a 0.1.0 project resolving 0.2.0 skills). readBundleIdentity derives it from this bundle's own
// .claude-plugin/marketplace.json; this locks that (a) it IS derived, not the bare legacy name, and
// (b) the manifest name stays pinned to package.json's version — the drift a future release could
// forget (bump the version, leave the marketplace name stale).
check('version-scope: marketplace name is derived + pinned to this bundle version', () => {
  const bundleRoot = inst.findBundleRoot(__dirname);
  assert.ok(bundleRoot, 'the bundle root self-locates');
  const version = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'package.json'), 'utf8')).version;
  const ident = inst.readBundleIdentity();
  assert.strictEqual(ident.marketplace, `claude-tpm-market-${version}`,
    'marketplace name = claude-tpm-market-<package.json version> (re-scope marketplace.json on a version bump)');
  assert.strictEqual(inst.MARKETPLACE_NAME, ident.marketplace, 'the module constant uses the derived name');
  assert.strictEqual(inst.PLUGIN_ID, `claude-tpm@claude-tpm-market-${version}`, 'the plugin id carries the scoped marketplace');
  assert.notStrictEqual(inst.MARKETPLACE_NAME, 'claude-tpm-market',
    'NOT the bare legacy singleton name that caused the cross-version collision');
  // plugin.json version is stamped from the SAME source (Claude keys its cache path
  // cache/<market>/<plugin>/<version> on it) — pin it too so a bump can't leave it stale.
  const pluginJson = JSON.parse(fs.readFileSync(path.join(bundleRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.strictEqual(pluginJson.version, version, 'plugin.json version = package.json version (npm run stamp)');
  // the installer's fail-loud stamp guard must PASS for the real (in-sync) bundle.
  assert.ok(inst.manifestVersionStamp(bundleRoot).ok, 'the install-time version-stamp guard passes for the in-sync bundle');
});

// ══ 5.1 — installer registration rules (D2 / D2a row table / D3) ═════════════════════════════════════
// Driven against a STATEFUL fake `claude` (tests/fake-claude-stateful.js) first on PATH: it keeps a fake
// registry in a temp JSON file, logs every call (argv + cwd), models `marketplace remove` wiping install
// records (probe #11a), and writes a project's settings.json like the real CLI. The real `claude` is never
// reached. node_modules/@codercowboy/claude-tpm in each fixture is a SYMLINK to this bundle, as in the wild.
const FAKE_STATEFUL = path.resolve(__dirname, '..', 'fake-claude-stateful.js');
const REAL_BUNDLE = fs.realpathSync(TPM_BUNDLE_ROOT);
function runInstallStateful(dir, args, o) {
  o = o || {};
  const work = mkTmp();
  const shim = path.join(work, 'claude'); fs.copyFileSync(FAKE_STATEFUL, shim); fs.chmodSync(shim, 0o755);
  // Guard (fb2): a fake `npm` first on PATH too (records argv; `install` is a no-op — the fixtures already carry the
  // dependency + node_modules link). Without it `--force` ran a REAL `npm install file:…` in the fixture project.
  fs.writeFileSync(path.join(work, 'npm'), '#!/bin/sh\n[ "$1" = "--version" ] && echo 9.9.9\necho "$@" >> "' + path.join(work, 'npm-calls.log') + '"\nexit 0\n', { mode: 0o755 });
  const statePath = path.join(work, 'state.json'); const logPath = path.join(work, 'calls.jsonl');
  fs.writeFileSync(statePath, JSON.stringify({ marketplaces: o.marketplaces || [], records: o.records || [] }));
  const env = Object.assign({}, process.env, { PATH: work + path.delimiter + process.env.PATH,
    FAKE_CLAUDE_STATE: statePath, FAKE_CLAUDE_LOG: logPath });
  const r = spawnSync('node', [o.entry || TOOL, dir].concat(args || []), { encoding: 'utf8', env, input: o.input || '', timeout: 30000 });
  const calls = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const settingsP = path.join(dir, '.claude', 'settings.json');
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), err: r.stderr || '', calls,
    state: JSON.parse(fs.readFileSync(statePath, 'utf8')),
    settings: fs.existsSync(settingsP) ? JSON.parse(fs.readFileSync(settingsP, 'utf8')) : null };
}
const isMut = (c) => (c.argv[1] === 'marketplace' && (c.argv[2] === 'add' || c.argv[2] === 'remove')) ||
  (c.argv[0] === 'plugin' && ['install', 'enable', 'disable', 'uninstall'].indexOf(c.argv[1]) >= 0);
const mutCalls = (r) => r.calls.filter(isMut).map((c) => c.argv.join(' '));
const marketCalls = (r) => r.calls.filter((c) => c.argv[1] === 'marketplace' && (c.argv[2] === 'add' || c.argv[2] === 'remove'));
function decoyBundle() { // a live folder, NOT this bundle, that carries a marketplace manifest of the same name
  const d = path.join(mkTmp(), 'other-central-copy');
  fs.mkdirSync(path.join(d, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(d, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: inst.MARKETPLACE_NAME, plugins: [{ name: inst.PLUGIN_NAME }] }));
  return d;
}

check('5.1: MARKETPLACE_SOURCE is the realpath of the self-located bundle root (not ./node_modules/…)', () => {
  assert.strictEqual(inst.MARKETPLACE_SOURCE, REAL_BUNDLE);
  assert.ok(path.isAbsolute(inst.MARKETPLACE_SOURCE) && !/node_modules/.test(inst.MARKETPLACE_SOURCE));
});

check('5.1 row "not registered": invoked THROUGH a symlinked node_modules → add gets the REAL folder at user scope; plugin install is project scope with cwd=target; settings = only enabledPlugins', () => {
  const dir = makeInstalledConsumer();
  const viaLink = path.join(dir, 'node_modules', '@codercowboy', 'claude-tpm', 'tools', 'consumer', 'tpm-consumer-install.js');
  const r = runInstallStateful(dir, ['--quiet'], { entry: viaLink });
  assert.strictEqual(r.status, 0, r.out);
  const adds = marketCalls(r).filter((c) => c.argv[2] === 'add');
  assert.strictEqual(adds.length, 1);
  assert.deepStrictEqual(adds[0].argv, ['plugin', 'marketplace', 'add', REAL_BUNDLE], 'add argument is the REAL folder, no --scope project');
  assert.ok(!r.calls.some((c) => c.argv.join(' ').indexOf('--scope project') >= 0 && c.argv[1] === 'marketplace'), 'no project-scope marketplace call');
  assert.strictEqual(marketCalls(r).filter((c) => c.argv[2] === 'remove').length, 0);
  const inst1 = r.calls.find((c) => c.argv[1] === 'install');
  assert.deepStrictEqual(inst1.argv, ['plugin', 'install', PLUGIN_ID, '--scope', 'project', '-y']);
  assert.strictEqual(fs.realpathSync(inst1.cwd), fs.realpathSync(dir), 'install runs with cwd = the target');
  assert.strictEqual(r.state.marketplaces[0].path, REAL_BUNDLE, 'the registry row holds the real folder');
  assert.deepStrictEqual(Object.keys(r.settings), ['enabledPlugins'], 'project settings hold ONLY enabledPlugins');
  assert.strictEqual(r.settings.enabledPlugins[PLUGIN_ID], true);
  assert.ok(/doctor clean/.test(r.out), r.out);
});

check('5.1 row "same folder": registered at the real folder → row left alone (NO marketplace add/remove), only per-project steps run', () => {
  const dir = makeInstalledConsumer();
  const r = runInstallStateful(dir, ['--quiet'], { marketplaces: [{ name: inst.MARKETPLACE_NAME, source: 'directory', path: REAL_BUNDLE }] });
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(marketCalls(r).length, 0, 'no marketplace add/remove recorded: ' + JSON.stringify(marketCalls(r)));
  assert.ok(r.calls.some((c) => c.argv[1] === 'install'), 'the per-project install still runs');
  assert.ok(/Register the marketplace — already done, skipped/.test(r.out));
});

check('5.1 row "same folder" via a SYMLINK-stored path: healthy-but-symlinked, row NOT re-stored, no add/remove', () => {
  const dir = makeInstalledConsumer();
  const link = path.join(mkTmp(), 'stored-as-symlink'); fs.symlinkSync(REAL_BUNDLE, link);
  const r = runInstallStateful(dir, ['--quiet'], { marketplaces: [{ name: inst.MARKETPLACE_NAME, source: 'directory', path: link }] });
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(marketCalls(r).length, 0, 'symlink-stored row is not touched');
  assert.strictEqual(r.state.marketplaces[0].path, link, 'stored path unchanged');
  assert.ok(/symlink/.test(r.out) && /healthy but fragile/.test(r.out), 'reported as healthy-but-symlinked');
});

check('5.1 row "folder gone": re-points (remove THEN add real folder); message says moved/deleted and warns about install records — not "cache"', () => {
  const dir = makeInstalledConsumer();
  const gone = path.join(mkTmp(), 'was-here-once');
  const r = runInstallStateful(dir, ['--quiet'], { marketplaces: [{ name: inst.MARKETPLACE_NAME, source: 'directory', path: gone }] });
  assert.strictEqual(r.status, 0, r.out);
  assert.deepStrictEqual(marketCalls(r).map((c) => c.argv.slice(2).join(' ')),
    ['remove ' + inst.MARKETPLACE_NAME, 'add ' + REAL_BUNDLE]);
  assert.ok(/no longer exists/.test(r.out) && /moved or deleted/.test(r.out), r.out);
  assert.ok(/deletes EVERY project's install record/.test(r.out));
  const deadMsg = r.out.slice(r.out.indexOf('is registered, but its folder'), r.out.indexOf('Step 3a/5 · Re-point'));
  assert.ok(deadMsg.length > 40 && !/cache/i.test(deadMsg), 'the re-point message does not blame "cache": ' + deadMsg);
  assert.strictEqual(r.state.marketplaces[0].path, REAL_BUNDLE);
});

check('5.1 row "alive, elsewhere" + --quiet (no flag): exits 1, NOTHING mutated, message names both folders + blast radius + the flag', () => {
  const dir = makeInstalledConsumer(); const decoy = decoyBundle();
  const r = runInstallStateful(dir, ['--quiet'], { marketplaces: [{ name: inst.MARKETPLACE_NAME, source: 'directory', path: decoy }] });
  assert.strictEqual(r.status, 1, r.out);
  assert.deepStrictEqual(mutCalls(r), [], 'no mutating claude call at all');
  assert.strictEqual(r.state.marketplaces[0].path, decoy, 'registry untouched');
  assert.ok(r.err.indexOf(decoy) >= 0 && r.err.indexOf(REAL_BUNDLE) >= 0, 'names both folders');
  assert.ok(/EVERY project/.test(r.err) && /install record/.test(r.err) && /re-adding/.test(r.err));
  assert.ok(/--repoint/.test(r.err));
});

check('5.1 row "alive, elsewhere" + --quiet --repoint: re-points (remove then add real folder), exit 0', () => {
  const dir = makeInstalledConsumer(); const decoy = decoyBundle();
  const r = runInstallStateful(dir, ['--quiet', '--repoint'], { marketplaces: [{ name: inst.MARKETPLACE_NAME, source: 'directory', path: decoy }] });
  assert.strictEqual(r.status, 0, r.out);
  assert.deepStrictEqual(marketCalls(r).map((c) => c.argv.slice(2).join(' ')),
    ['remove ' + inst.MARKETPLACE_NAME, 'add ' + REAL_BUNDLE]);
  assert.strictEqual(r.state.marketplaces[0].path, REAL_BUNDLE);
});

check('5.1 row "alive, elsewhere" interactive NO: asks (naming both folders), declines, exit 1, nothing mutated', () => {
  const dir = makeInstalledConsumer(); const decoy = decoyBundle();
  const r = runInstallStateful(dir, [], { input: 'n\n', marketplaces: [{ name: inst.MARKETPLACE_NAME, source: 'directory', path: decoy }] });
  assert.strictEqual(r.status, 1, r.out);
  assert.deepStrictEqual(mutCalls(r), []);
  assert.ok(/Re-point the marketplace/.test(r.out) && r.out.indexOf(decoy) >= 0 && r.out.indexOf(REAL_BUNDLE) >= 0 && /EVERY project/.test(r.out));
  assert.ok(/declined/.test(r.out));
  assert.strictEqual(r.state.marketplaces[0].path, decoy);
});

check('5.1 row "alive, elsewhere" interactive YES: re-points (remove then add), the rest of the install completes, exit 0', () => {
  const dir = makeInstalledConsumer(); const decoy = decoyBundle();
  const r = runInstallStateful(dir, [], { input: 'y\ny\ny\ny\ny\n', marketplaces: [{ name: inst.MARKETPLACE_NAME, source: 'directory', path: decoy }] });
  assert.strictEqual(r.status, 0, r.out);
  assert.deepStrictEqual(marketCalls(r).map((c) => c.argv.slice(2).join(' ')),
    ['remove ' + inst.MARKETPLACE_NAME, 'add ' + REAL_BUNDLE]);
  assert.strictEqual(r.state.marketplaces[0].path, REAL_BUNDLE);
});

// ── cleanup (13-fb1): numbering, interactive --repoint prompt count, copy-pasteable displayed commands ─────
check('re-point step and register step have DISTINCT titles (3a / 3b), not two "Step 3/5"', () => {
  const dir = makeInstalledConsumer();
  const r = runInstallStateful(dir, ['--quiet'], { marketplaces: [{ name: inst.MARKETPLACE_NAME, source: 'directory', path: path.join(mkTmp(), 'gone') }] });
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(/Step 3a\/5 · Re-point the marketplace/.test(r.out), r.out);
  assert.ok(/Step 3b\/5 · Register the marketplace/.test(r.out), r.out);
  assert.strictEqual((r.out.match(/Step 3\/5/g) || []).length, 0, 'no bare "Step 3/5" when a re-point ran');
});
check('interactive --repoint (no --quiet): ONE confirmation covers remove + add + install + enable — zero per-command "Run this?" prompts; the y/N answer path asks exactly one question', () => {
  const decoy = decoyBundle();
  const rows = [{ name: inst.MARKETPLACE_NAME, source: 'directory', path: decoy }];
  // --repoint IS the confirmation: no input supplied at all, and no step may stop to ask.
  const a = runInstallStateful(makeInstalledConsumer(), ['--repoint'], { input: '', marketplaces: rows });
  assert.strictEqual(a.status, 0, a.out);
  assert.strictEqual((a.out.match(/Run this\? \[y\/N\]/g) || []).length, 0, 'no per-command prompt under --repoint: ' + a.out);
  assert.deepStrictEqual(a.calls.filter(isMut).map((c) => c.argv.slice(0, 3).join(' ')).filter((x) => /marketplace/.test(x)).length, 2);
  assert.ok(a.calls.some((c) => c.argv[1] === 'install'), 'the install ran under the same single confirmation');
  // Without --repoint, interactive: the single "Re-point…?" question is the only [y/N] prompt; answering y once drives everything.
  const b = runInstallStateful(makeInstalledConsumer(), [], { input: 'y\n', marketplaces: rows });
  assert.strictEqual(b.status, 0, b.out);
  assert.strictEqual((b.out.match(/\[y\/N\]/g) || []).length, 1, 'exactly one confirmation prompt: ' + b.out);
  assert.strictEqual(b.state.marketplaces[0].path, REAL_BUNDLE);
});
check('displayed commands are copy-pasteable: shellQuote / displayCommand quote spaces + quotes, leave plain args bare', () => {
  assert.strictEqual(inst.shellQuote('plain-arg_1.0/x@y'), 'plain-arg_1.0/x@y');
  assert.strictEqual(inst.shellQuote('/a b/c'), "'/a b/c'");
  assert.strictEqual(inst.shellQuote("it's"), "'it'\\''s'");
  assert.strictEqual(inst.displayCommand('claude', ['plugin', 'marketplace', 'add', '/a b/c']), "claude plugin marketplace add '/a b/c'");
  assert.strictEqual(uninst.displayCommand('claude', ['plugin', 'marketplace', 'add', '/a b/c']), "claude plugin marketplace add '/a b/c'");
});
check('the registered-bundle path with a SPACE is shown quoted in the "$ claude plugin marketplace add" line, while the spawn argv carries it raw', () => {
  const parent = mkTmp(); const spaced = path.join(parent, 'dir with space', 'claude-tpm');
  fs.mkdirSync(path.dirname(spaced), { recursive: true });
  // Copy the installer + its lib/ + manifests into a spaced folder so its self-located MARKETPLACE_SOURCE contains a space.
  fs.mkdirSync(path.join(spaced, '.claude-plugin'), { recursive: true });
  const bundle = path.resolve(__dirname, '..', '..', '..', '..');
  for (const f of ['package.json']) fs.copyFileSync(path.join(bundle, f), path.join(spaced, f));
  for (const f of fs.readdirSync(path.join(bundle, '.claude-plugin'))) fs.copyFileSync(path.join(bundle, '.claude-plugin', f), path.join(spaced, '.claude-plugin', f));
  for (const sub of [['tools', 'consumer'], ['tools', 'lib']]) {
    fs.mkdirSync(path.join(spaced, ...sub), { recursive: true });
    for (const f of fs.readdirSync(path.join(bundle, ...sub))) {
      const src = path.join(bundle, ...sub, f);
      if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(spaced, ...sub, f));
    }
  }
  const dir = makeInstalledConsumer();
  const real = fs.realpathSync(spaced);
  const r = runInstallStateful(dir, ['--quiet'], { entry: path.join(spaced, 'tools', 'consumer', 'tpm-consumer-install.js') });
  assert.ok(r.out.indexOf("$ claude plugin marketplace add '" + real + "'") >= 0, 'displayed command is shell-quoted: ' + r.out);
  const add = marketCalls(r).filter((c) => c.argv[2] === 'add');
  assert.strictEqual(add.length, 1, JSON.stringify(r.calls));
  assert.deepStrictEqual(add[0].argv, ['plugin', 'marketplace', 'add', real], 'the real argv holds the raw path (no quotes)');
});

// ══ 5.6 — output UX (presentation only; the claude/npm calls are asserted unchanged elsewhere) ══════════
const NO_OLD_TRIPLE = (out) => !/^\s+(command|edits|does):/m.test(out);
// Longest sentence (in words) among the explanatory prose lines — command lines ("$ …"), registry/path lines and
// the doctor rows are excluded (paths with spaces would inflate the count).
function longestSentenceWords(out) {
  let max = 0;
  for (const line of out.split('\n')) {
    if (/^\s*(\$ |registered:|this installer:|Summary|\s*[✓⚠✗·] .*(\/|\\))/.test(line) || /^\s+(fix:|-|\d\.|\d\))/.test(line) || /[\/\\]\S+[\/\\]/.test(line)) continue;
    for (const sent of line.split(/[.;:](?:\s|$)/)) max = Math.max(max, sent.trim().split(/\s+/).filter(Boolean).length);
  }
  return max;
}
check('5.6 fresh install: one header per step ("Step N/5 · Title"), command + ONE sentence, no command:/edits:/does: triple, no stale step-2 text', () => {
  const dir = makeInstalledConsumer(); // package.json + dep present; marketplace absent, plugin absent
  const r = runInstallStateful(dir, ['--quiet']);
  assert.strictEqual(r.status, 0, r.out);
  for (const h of ['Step 1/5 · Preflight', 'Step 2/5 · Add the claude-tpm dependency', 'Step 3/5 · Register the marketplace', 'Step 4/5 · Install the plugin'])
    assert.ok(r.out.split('\n').some((l) => l.indexOf(h) === 0 || l.indexOf('✓ ' + h) === 0), 'header line: ' + h + '\n' + r.out);
  assert.ok(NO_OLD_TRIPLE(r.out), r.out);
  assert.ok(/^\s+\$ claude plugin marketplace add /m.test(r.out), 'the command is always shown');
  assert.ok(!/symlink\/copy that step 3/.test(r.out) && !/creates the node_modules/.test(r.out), 'stale step-2 wording is gone');
  assert.ok(longestSentenceWords(r.out) <= 25, 'longest sentence ' + longestSentenceWords(r.out) + ' words:\n' + r.out);
});
check('5.6 step 2 (real npm path, fake npm): the explanation says it records + installs, never mentions the marketplace symlink', () => {
  const r = runDepStep({ already: false, answers: 'y\n2\ny\n' });
  assert.ok(/Records .* in devDependencies of .*package\.json and installs it into node_modules/.test(r.out), r.out);
  assert.ok(!/symlink|marketplace/i.test(r.out.split('\n').filter((l) => /^\s+(Records|\$)/.test(l)).join('\n')), r.out);
});
check('5.6 re-install (everything already done): every skipped step is ONE line, no command blocks', () => {
  const dir = makeInstalledConsumer(); fs.mkdirSync(path.join(dir, '.claude', 'claude-tpm'), { recursive: true });
  const rec = [{ id: PLUGIN_ID, scope: 'project', enabled: true, installPath: REAL_BUNDLE, projectPath: dir }];
  const r = runInstallStateful(dir, ['--quiet'], { marketplaces: [{ name: inst.MARKETPLACE_NAME, source: 'directory', path: REAL_BUNDLE }], records: rec });
  assert.strictEqual(r.status, 0, r.out);
  const skipped = r.out.split('\n').filter((l) => /^✓ Step \d\/5 · .* — already done, skipped\.$/.test(l));
  assert.strictEqual(skipped.length, 4, 'steps 2-5 each one line: ' + r.out);
  assert.ok(!/^\s+\$ /m.test(r.out), 'no command block when nothing runs: ' + r.out);
  assert.deepStrictEqual(mutCalls(r), [], 'nothing mutated');
});
check('5.6 interactive re-point asks ONCE: one "y" covers remove + add + the plugin install that follows (no "Run this?" after it); same argv as before', () => {
  const dir = makeInstalledConsumer(); const decoy = decoyBundle();
  const r = runInstallStateful(dir, [], { input: 'y\n', marketplaces: [{ name: inst.MARKETPLACE_NAME, source: 'directory', path: decoy }] });
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual((r.out.match(/\[y\/N\]/g) || []).length, 1, 'exactly one y/N prompt: ' + r.out);
  assert.ok(!/Run this\?/.test(r.out), r.out);
  assert.deepStrictEqual(r.calls.filter(isMut).map((c) => c.argv),
    [['plugin', 'marketplace', 'remove', inst.MARKETPLACE_NAME], ['plugin', 'marketplace', 'add', REAL_BUNDLE], ['plugin', 'install', PLUGIN_ID, '--scope', 'project']],
    'interactive re-point: the install has no -y (only --quiet adds it)');
  assert.strictEqual(r.state.marketplaces[0].path, REAL_BUNDLE);
});
check('5.6 non-guarded paths still ask per step: dead-folder re-point interactive with a single "y" stops at the second prompt (meaning of the prompts unchanged)', () => {
  const dir = makeInstalledConsumer(); const gone = path.join(mkTmp(), 'was-here-once');
  const r = runInstallStateful(dir, [], { input: 'y\n', marketplaces: [{ name: inst.MARKETPLACE_NAME, source: 'directory', path: gone }] });
  assert.strictEqual(r.status, 1, r.out);
  assert.ok(/declined — stopping/.test(r.out), r.out);
});
check('5.6 alive-elsewhere under --quiet: refusal message is plain, names both folders, and says how to proceed (exit 1, nothing mutated)', () => {
  const dir = makeInstalledConsumer(); const decoy = decoyBundle();
  const r = runInstallStateful(dir, ['--quiet'], { marketplaces: [{ name: inst.MARKETPLACE_NAME, source: 'directory', path: decoy }] });
  assert.strictEqual(r.status, 1, r.out);
  assert.ok(/Not re-pointing without your say-so\. Re-run with --repoint/.test(r.err), r.err);
  assert.deepStrictEqual(mutCalls(r), []);
  assert.ok(NO_OLD_TRIPLE(r.out), r.out);
});
check('5.6 doctor via install --check: one line per row, summary line, fix: only under ⚠/✗, labels neutral', () => {
  const dir = makeInstalledConsumer(); const decoy = decoyBundle();
  fs.mkdirSync(path.join(dir, '.claude', 'claude-tpm'), { recursive: true });
  const rec = [{ id: PLUGIN_ID, scope: 'project', enabled: true, installPath: decoy, projectPath: dir }];
  const a = runInstallStateful(dir, ['--check'], { marketplaces: [{ name: inst.MARKETPLACE_NAME, source: 'directory', path: decoy }], records: rec });
  assert.ok(/^\s+⚠ marketplace source\s+points at /m.test(a.out), a.out);
  assert.ok(/Summary: \d+ ok · 1 warning · 0 problems/.test(a.out), a.out);
  assert.ok(!/source resolves to this bundle/.test(a.out), 'label never states the passing condition: ' + a.out);
  const lines = a.out.split('\n');
  lines.forEach((l, i) => { if (/^\s+[⚠✗] /.test(l)) assert.ok(/^\s+fix: \S/.test(lines[i + 1] || ''), l); });
});

check('5.1 parseArgs: --repoint sets opts.repoint (default false)', () => {
  assert.strictEqual(inst.parseArgs(['--repoint']).repoint, true);
  assert.strictEqual(inst.parseArgs([]).repoint, false);
});

check('5.1 classifyMarketplaceRow: absent / same / same+symlinked / dead / elsewhere / non-directory source', () => {
  const real = REAL_BUNDLE; const mk = (p, src) => ({ registered: true, source: src === undefined ? 'directory' : src, path: p });
  assert.strictEqual(inst.classifyMarketplaceRow({ registered: false }, real).state, 'absent');
  assert.strictEqual(inst.classifyMarketplaceRow(mk(real), real).state, 'same');
  const link = path.join(mkTmp(), 'lnk'); fs.symlinkSync(real, link);
  const viaLink = inst.classifyMarketplaceRow(mk(link), real);
  assert.strictEqual(viaLink.state, 'same'); assert.strictEqual(viaLink.symlinked, true);
  assert.strictEqual(inst.classifyMarketplaceRow(mk(path.join(mkTmp(), 'nope')), real).state, 'dead');
  assert.strictEqual(inst.classifyMarketplaceRow(mk(decoyBundle()), real).state, 'elsewhere');
  assert.strictEqual(inst.classifyMarketplaceRow(mk(null, 'github'), real).state, 'elsewhere');
});

// ── install records accept our scopes: THIS target's project-scope record (projectPath-matched) ────────
check('5.1 parsePluginList(list, target): matches the project-scope record whose projectPath resolves to the target', () => {
  const target = mkTmp(); const other = mkTmp();
  const list = [{ id: PLUGIN_ID, scope: 'project', enabled: true, projectPath: other },
    { id: PLUGIN_ID, scope: 'project', enabled: false, projectPath: target }];
  assert.deepStrictEqual(inst.parsePluginList(list, target), { installed: true, enabled: false }, 'picks THIS project\'s record, not the other project\'s');
});
check('5.1 parsePluginList(list, target): only ANOTHER project\'s record → not installed here', () => {
  assert.deepStrictEqual(inst.parsePluginList([{ id: PLUGIN_ID, scope: 'project', enabled: true, projectPath: mkTmp() }], mkTmp()),
    { installed: false, enabled: false });
});
check('5.1 parsePluginList(list, target): projectPath through a symlink resolves to the target; record without projectPath still matches', () => {
  const target = mkTmp(); const link = path.join(mkTmp(), 'tlink'); fs.symlinkSync(target, link);
  assert.strictEqual(inst.parsePluginList([{ id: PLUGIN_ID, scope: 'project', enabled: true, projectPath: link }], target).installed, true);
  assert.strictEqual(inst.parsePluginList([{ id: PLUGIN_ID, scope: 'project', enabled: true }], target).installed, true);
});
check('5.1 parsePluginInstallPath(list, target): this target\'s record only', () => {
  const target = mkTmp(); const other = mkTmp();
  const list = [{ id: PLUGIN_ID, scope: 'project', installPath: '/a', projectPath: other },
    { id: PLUGIN_ID, scope: 'project', installPath: '/b', projectPath: target }];
  assert.strictEqual(inst.parsePluginInstallPath(list, target), '/b');
  assert.strictEqual(inst.parsePluginInstallPath([list[0]], target), null);
  assert.strictEqual(inst.parsePluginInstallPath(list), '/a', 'no target given → first project-scope record (back-compat)');
});

// ── doctor (--check) consistent with the new rules ─────────────────────────────────────────────────────
check('5.1 --check on a correctly installed fake world: all rows PASS, exit 0 (resolved-path source row)', () => {
  const dir = makeInstalledConsumer();
  fs.mkdirSync(path.join(dir, '.claude', 'claude-tpm'), { recursive: true }); // R9: an enabled plugin needs the project marker
  const r = runInstallStateful(dir, ['--check'], {
    marketplaces: [{ name: inst.MARKETPLACE_NAME, source: 'directory', path: REAL_BUNDLE }],
    records: [{ id: PLUGIN_ID, scope: 'project', enabled: true, installPath: REAL_BUNDLE, projectPath: dir }] });
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(!/^\s+✗ /m.test(r.out), r.out);
  assert.ok(/✓ marketplace source\s+this bundle's folder/.test(r.out));
  assert.ok(!/^\s+⚠ /m.test(r.out), 'a correct world has no warning either: ' + r.out);
});
check('5.1/R9 --check: a row resolving to a different live folder is a WARN naming both (exit 0); a dead folder FAILS saying moved or deleted', () => {
  const dir = makeInstalledConsumer(); const decoy = decoyBundle();
  fs.mkdirSync(path.join(dir, '.claude', 'claude-tpm'), { recursive: true }); // R9: an enabled plugin needs the project marker
  const rec = [{ id: PLUGIN_ID, scope: 'project', enabled: true, installPath: decoy, projectPath: dir }];
  const a = runInstallStateful(dir, ['--check'], { marketplaces: [{ name: inst.MARKETPLACE_NAME, source: 'directory', path: decoy }], records: rec });
  assert.strictEqual(a.status, 0, a.out);
  assert.ok(/⚠ marketplace source/.test(a.out) && !/^\s+✗ /m.test(a.out), a.out);
  assert.ok(a.out.indexOf(decoy) >= 0 && a.out.indexOf(REAL_BUNDLE) >= 0 && /runs that folder/.test(a.out), a.out);
  const gone = path.join(mkTmp(), 'gone');
  const b = runInstallStateful(dir, ['--check'], { marketplaces: [{ name: inst.MARKETPLACE_NAME, source: 'directory', path: gone }], records: [] });
  assert.strictEqual(b.status, 1);
  assert.ok(/✗ marketplace source/.test(b.out) && /moved or deleted/.test(b.out), b.out);
});
check('5.1 --help describes the new rules and --repoint', () => {
  const r = spawnSync('node', [TOOL, '--help'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.ok(/--repoint/.test(r.stdout) && /user scope/i.test(r.stdout) && /REALPATH/.test(r.stdout));
  assert.ok(!/marketplace add \.\/node_modules/.test(r.stdout), 'no stale ./node_modules source in the help');
});

// ══ 5.2 — "real copy in ANOTHER project's node_modules" (D2a) ════════════════════════════════════════════
// World = two fake projects: the TARGET (a consumer, node_modules → symlink to this bundle) and OTHER (owns a
// REAL, non-symlink copy at OTHER/node_modules/@codercowboy/claude-tpm that the registry row points at).
function otherProjectWithCopy(kind) { // 'identical' (full copy of this bundle) | 'differs' (full copy + edits) | 'small' (tiny stub)
  const other = mkTmp();
  const copy = path.join(other, 'node_modules', '@codercowboy', 'claude-tpm');
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  if (kind === 'small') {
    fs.mkdirSync(path.join(copy, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(copy, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: inst.MARKETPLACE_NAME, plugins: [{ name: inst.PLUGIN_NAME }] }));
    fs.writeFileSync(path.join(copy, 'a.txt'), 'x');
  } else {
    // Manual walk (fs.cpSync refuses to copy a folder into its own subtree — the scratch dir lives under the bundle).
    const skip = new Set(['tmp', 'node_modules', '.git', '.DS_Store']);
    (function cp(from, to) {
      fs.mkdirSync(to, { recursive: true });
      for (const n of fs.readdirSync(from)) {
        if (skip.has(n)) continue;
        const f = path.join(from, n); const t = path.join(to, n); const st = fs.lstatSync(f);
        if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(f), t);
        else if (st.isDirectory()) cp(f, t);
        else if (st.isFile()) fs.copyFileSync(f, t);
      }
    })(REAL_BUNDLE, copy);
    if (kind === 'differs') { fs.appendFileSync(path.join(copy, 'package.json'), '\n'); fs.writeFileSync(path.join(copy, 'EXTRA.txt'), 'x'); }
  }
  return { other, copy: fs.realpathSync(copy) };
}
const rcRow = (copy) => [{ name: inst.MARKETPLACE_NAME, source: 'directory', path: copy }];
const noMut = (r) => assert.deepStrictEqual(mutCalls(r), [], 'no mutating claude call: ' + JSON.stringify(mutCalls(r)));

check('5.2 pure: realCopyInfo detects a folder inside node_modules (names the owning project); null otherwise', () => {
  const i = inst.realCopyInfo('/x/projA/node_modules/@codercowboy/claude-tpm');
  assert.strictEqual(i.projectDir, '/x/projA'); assert.strictEqual(i.folder, '/x/projA/node_modules/@codercowboy/claude-tpm');
  assert.strictEqual(inst.realCopyInfo('/x/shared/claude-tpm'), null);
  assert.strictEqual(inst.realCopyInfo(null), null);
});
check('5.2 pure: hashTree skips .DS_Store / tmp / node_modules / .git at any depth; compareCopies: identical, differs (counts changed + one-sided files), unreadable → unknown (no throw)', () => {
  const mk = (junk) => { const d = mkTmp(); fs.mkdirSync(path.join(d, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(d, 'a'), '1'); fs.writeFileSync(path.join(d, 'sub', 'b'), '2');
    for (const j of ['tmp', 'node_modules', '.git']) { fs.mkdirSync(path.join(d, j)); fs.writeFileSync(path.join(d, j, 'f'), junk); fs.mkdirSync(path.join(d, 'sub', j)); fs.writeFileSync(path.join(d, 'sub', j, 'f'), junk); }
    fs.writeFileSync(path.join(d, '.DS_Store'), junk); fs.writeFileSync(path.join(d, 'sub', '.DS_Store'), junk); return d; };
  const a = mk('A'); const b = mk('B');
  assert.deepStrictEqual(Object.keys(inst.hashTree(a)), ['a', 'sub/b']);
  const same = inst.compareCopies(a, b);
  assert.strictEqual(same.verdict, 'identical'); assert.strictEqual(same.text, 'same version, identical files');
  fs.writeFileSync(path.join(b, 'a'), 'changed'); fs.writeFileSync(path.join(b, 'new.txt'), 'n');
  const diff = inst.compareCopies(a, b);
  assert.strictEqual(diff.verdict, 'differs'); assert.strictEqual(diff.count, 2);
  assert.strictEqual(diff.text, 'same version, files differ (2 files)');
  const unk = inst.compareCopies(a, path.join(mkTmp(), 'does-not-exist'));
  assert.strictEqual(unk.verdict, 'unknown'); assert.ok(/couldn't compare/.test(unk.text));
});

check('5.2 detect + names it plainly + --quiet (no --force): exit 1, NOTHING mutated, message has the two required sentences, the verdict, all 3 options and the --force hint', () => {
  const dir = makeInstalledConsumer(); const w = otherProjectWithCopy('small');
  const r = runInstallStateful(dir, ['--quiet'], { marketplaces: rcRow(w.copy) });
  assert.strictEqual(r.status, 1, r.out);
  noMut(r);
  assert.strictEqual(r.state.marketplaces[0].path, w.copy, 'registry untouched');
  assert.ok(r.err.indexOf('claude-tpm is already installed on this machine from ' + w.copy) >= 0, r.err);
  assert.ok(/If you keep it, this project will run that copy, not its own/.test(r.err), r.err);
  assert.ok(/same version, files differ \(\d+ files?\)/.test(r.err), r.err);
  assert.ok(/1\) Recommended/.test(r.err) && /2\) Uninstall/.test(r.err) && /3\) Proceed anyway/.test(r.err) && /docs\/INSTALL\.md/.test(r.err));
  assert.ok(/--force/.test(r.err));
  assert.ok(!/Re-point the marketplace/.test(r.out), 'not the generic elsewhere prompt');
});

check('5.2 --quiet --force: proceeds sharing the existing copy — row NOT re-pointed (no marketplace add/remove), install completes, doctor shows a WARN row, exit 0', () => {
  const dir = makeInstalledConsumer(); const w = otherProjectWithCopy('small');
  const r = runInstallStateful(dir, ['--quiet', '--force'], { marketplaces: rcRow(w.copy) });
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(marketCalls(r).length, 0, 'no marketplace add/remove: ' + JSON.stringify(marketCalls(r)));
  assert.strictEqual(r.state.marketplaces[0].path, w.copy, 'row still points at the other copy');
  assert.ok(r.calls.some((c) => c.argv[1] === 'install'), 'per-project install still ran');
  assert.ok(/proceeding, sharing that copy/.test(r.out));
  assert.ok(/⚠ real copy in another project/.test(r.out), r.out);
  assert.ok(!/^\s+✗ /m.test(r.out), r.out);
  assert.ok(/⚠ marketplace source/.test(r.out), 'R9: alive-elsewhere source row is a WARN: ' + r.out);
});

check('5.2 interactive, IDENTICAL copies, option 3 + "y": reports "same version, identical files", proceeds sharing, no marketplace add/remove, exit 0', () => {
  const dir = makeInstalledConsumer(); const w = otherProjectWithCopy('identical');
  const r = runInstallStateful(dir, [], { input: '3\ny\ny\ny\ny\ny\n', marketplaces: rcRow(w.copy) });
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(/same version, identical files/.test(r.out), r.out);
  assert.strictEqual(marketCalls(r).length, 0);
  assert.strictEqual(r.state.marketplaces[0].path, w.copy);
  assert.ok(!/type exactly/.test(r.out), 'no stronger confirmation for identical copies');
});

check('5.2 interactive, IDENTICAL copies, option 3 + "n": declined → exit 1, nothing mutated', () => {
  const dir = makeInstalledConsumer(); const w = otherProjectWithCopy('identical');
  const r = runInstallStateful(dir, [], { input: '3\nn\n', marketplaces: rcRow(w.copy) });
  assert.strictEqual(r.status, 1, r.out); noMut(r);
});

check('5.2 interactive, DIFFERING copies, option 3: a plain "y" is NOT enough (needs the typed phrase) → exit 1, nothing mutated; the phrase → proceeds, exit 0, no add/remove', () => {
  const dir = makeInstalledConsumer(); const w = otherProjectWithCopy('differs');
  const a = runInstallStateful(dir, [], { input: '3\ny\ny\ny\n', marketplaces: rcRow(w.copy) });
  assert.strictEqual(a.status, 1, a.out); noMut(a);
  assert.ok(/same version, files differ \(2 files\)/.test(a.out), a.out);
  assert.ok(/type exactly "share different copy"/.test(a.out) && /not confirmed/.test(a.out));
  const dir2 = makeInstalledConsumer();
  const b = runInstallStateful(dir2, [], { input: '3\nshare different copy\ny\ny\ny\ny\n', marketplaces: rcRow(w.copy) });
  assert.strictEqual(b.status, 0, b.out);
  assert.strictEqual(marketCalls(b).length, 0);
  assert.strictEqual(b.state.marketplaces[0].path, w.copy);
});

check('5.2 interactive option 1: stops (exit 1), changes nothing, prints the shared-folder next command (--repoint) + the README pointer', () => {
  const dir = makeInstalledConsumer(); const w = otherProjectWithCopy('small');
  const r = runInstallStateful(dir, [], { input: '1\n', marketplaces: rcRow(w.copy) });
  assert.strictEqual(r.status, 1, r.out); noMut(r);
  assert.ok(/Nothing was changed/.test(r.out) && /one shared folder/.test(r.out) && /docs\/INSTALL\.md/.test(r.out));
  assert.ok(/tools[\\/]tpm\.js" install ".*" --repoint/.test(r.out), r.out);
});

check('5.2 interactive option 2: stops (exit 1), changes nothing, prints `cd <other project> && npx tpm uninstall --system` then the re-run command, and says that project loses tpm', () => {
  const dir = makeInstalledConsumer(); const w = otherProjectWithCopy('small');
  const r = runInstallStateful(dir, [], { input: '2\n', marketplaces: rcRow(w.copy) });
  assert.strictEqual(r.status, 1, r.out); noMut(r);
  assert.ok(r.out.indexOf('cd "' + fs.realpathSync(w.other) + '" && npx tpm uninstall --system') >= 0, r.out);
  assert.ok(/npx tpm install "/.test(r.out) && /loses claude-tpm/i.test(r.out), r.out);
});

check('5.2 interactive: no / unrecognised choice stops safely (exit 1, nothing mutated)', () => {
  const dir = makeInstalledConsumer(); const w = otherProjectWithCopy('small');
  const r = runInstallStateful(dir, [], { input: 'banana\n', marketplaces: rcRow(w.copy) });
  assert.strictEqual(r.status, 1, r.out); noMut(r);
});

check('5.2 unreadable other copy: degrades to "couldn\'t compare" (never crashes); treated as differing (typed phrase required)', () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root ignores chmod
  const dir = makeInstalledConsumer(); const w = otherProjectWithCopy('small');
  const locked = path.join(w.copy, 'locked'); fs.mkdirSync(locked); fs.writeFileSync(path.join(locked, 'f'), 'x'); fs.chmodSync(locked, 0o000);
  try {
    const a = runInstallStateful(dir, ['--quiet'], { marketplaces: rcRow(w.copy) });
    assert.strictEqual(a.status, 1, a.out); assert.ok(/couldn't compare/.test(a.out), a.out); assert.ok(!/TypeError|at Object/.test(a.out), 'no stack trace');
    const b = runInstallStateful(makeInstalledConsumer(), [], { input: '3\ny\n', marketplaces: rcRow(w.copy) });
    assert.strictEqual(b.status, 1, b.out); assert.ok(/type exactly "share different copy"/.test(b.out), b.out);
  } finally { fs.chmodSync(locked, 0o755); }
});

check('5.2 NOT this case: a symlink in another project that resolves to OUR canonical folder is the healthy "same" row — no warning, no prompt, no mutation of the row', () => {
  const dir = makeInstalledConsumer(); const other = mkTmp();
  const link = path.join(other, 'node_modules', '@codercowboy', 'claude-tpm'); fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(REAL_BUNDLE, link);
  const r = runInstallStateful(dir, ['--quiet'], { marketplaces: rcRow(link) });
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(marketCalls(r).length, 0);
  assert.ok(!/already installed on this machine from/.test(r.out), r.out);
});

check('5.2 NOT this case: a row at some other CENTRAL folder (not in node_modules) keeps the generic wording (DIFFERENT folder, re-point offer), not the real-copy message', () => {
  const dir = makeInstalledConsumer(); const decoy = decoyBundle();
  const q = runInstallStateful(dir, ['--quiet'], { marketplaces: rcRow(decoy) });
  assert.strictEqual(q.status, 1); assert.ok(/DIFFERENT folder/.test(q.err) && /--repoint/.test(q.err));
  assert.ok(!/already installed on this machine from/.test(q.out) && !/this project will run that copy/.test(q.out));
});

check('5.2 --quiet --repoint on a real-copy row is still an explicit re-point (the pre-existing flag keeps working): remove then add, exit 0', () => {
  const dir = makeInstalledConsumer(); const w = otherProjectWithCopy('small');
  const r = runInstallStateful(dir, ['--quiet', '--repoint'], { marketplaces: rcRow(w.copy) });
  assert.strictEqual(r.status, 0, r.out);
  assert.deepStrictEqual(marketCalls(r).map((c) => c.argv.slice(2).join(' ')), ['remove ' + inst.MARKETPLACE_NAME, 'add ' + REAL_BUNDLE]);
});

check('5.2/R9 doctor (--check): a real-copy row is a WARN naming the other copy + identical/differs verdict (alongside the R9 source-row WARN, exit 0); central-folder row has no such WARN', () => {
  const dir = makeInstalledConsumer(); const w = otherProjectWithCopy('identical');
  fs.mkdirSync(path.join(dir, '.claude', 'claude-tpm'), { recursive: true }); // R9: an enabled plugin needs the project marker
  const recs = (p) => [{ id: PLUGIN_ID, scope: 'project', enabled: true, installPath: p, projectPath: dir }];
  const a = runInstallStateful(dir, ['--check'], { marketplaces: rcRow(w.copy), records: recs(w.copy) });
  assert.strictEqual(a.status, 0, 'R9: a row resolving to another folder is a source-row WARN: ' + a.out);
  const warn = a.out.split('\n').find((l) => /⚠ real copy in another project/.test(l));
  assert.ok(warn && warn.indexOf(w.copy) >= 0 && /same version, identical files/.test(warn), a.out);
  const w2 = otherProjectWithCopy('differs');
  const b = runInstallStateful(dir, ['--check'], { marketplaces: rcRow(w2.copy), records: recs(w2.copy) });
  assert.ok(/⚠ real copy in another project.*files differ \(2 files\)/.test(b.out), b.out);
  const decoy = decoyBundle();
  const c = runInstallStateful(dir, ['--check'], { marketplaces: rcRow(decoy), records: recs(decoy) });
  assert.ok(!/⚠ real copy in another project/.test(c.out), c.out);
});

check('5.2 --help documents the real-copy handling and --force', () => {
  const r = spawnSync('node', [TOOL, '--help'], { encoding: 'utf8' });
  assert.ok(/real copy/i.test(r.stdout) && /--force/.test(r.stdout) && /node_modules/.test(r.stdout));
});


cleanup();
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
