#!/usr/bin/env node
/**
 * test.js — unit test for tpm-consumer-uninstall.js. Zero-dep (node `assert`), no `claude`/`npm`
 * spawned: every case drives the tool's exported PURE helpers directly, or (for the arg flag-guard's
 * process.exit path) spawns the tool as a child and asserts the exit code. Temp fixtures under
 * os.tmpdir(), cleaned up.
 *
 * Covers, over uninstall's exported surface:
 *   - parsePluginList (fix b) — the JSON→state mapping spun out of pluginState
 *   - parseArgs flag-guard (fix c) — --dir rejects a missing value or a "-"-leading value (exit 2)
 *   - hasTpmDependency, readPackageJson
 *
 * Usage: node tools/consumer/tests/tpm-consumer-uninstall/test.js   → exit 0 all pass, 1 otherwise.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { mkScratch } = require('../../../tests/lib/scratch'); // shared: <bundle>/tmp/scratch/<run-slug>/

const TOOL = path.resolve(__dirname, '..', '..', 'tpm-consumer-uninstall.js');
const uninst = require(TOOL);
const { PLUGIN_ID, TPM_PKG_NAME } = uninst;

let pass = 0; let fail = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ✓ ${name}\n`); pass += 1; }
  catch (e) { process.stdout.write(`  ✗ ${name}\n      ${e.message}\n`); fail += 1; }
}

function captureStderr(fn) {
  const orig = process.stderr.write;
  let buf = '';
  process.stderr.write = (chunk) => { buf += chunk; return true; };
  try { const ret = fn(); return { ret, warned: buf }; }
  finally { process.stderr.write = orig; }
}

// Fixtures live under <bundle>/tmp/scratch/<run-slug>/ (shared helper) — one isolated, git-ignored
// folder per run, left in place for inspection. Nuke tmp/scratch/ wholesale when you want.
function mkTmp() { return mkScratch('tpm-uninstall-test'); }
function cleanup() { /* no-op: per-run scratch persists for inspection; tmp/ is git-ignored */ }
function writePkg(dir, obj) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(obj)); }

process.stdout.write('tpm-consumer-uninstall.test.js\n');

// ── parsePluginList (fix b) — same mapping contract as install ──────────────────────────────────────
check('parsePluginList: enabled:true entry → {installed:true, enabled:true}', () => {
  assert.deepStrictEqual(uninst.parsePluginList([{ id: PLUGIN_ID, scope: 'project', enabled: true }]),
    { installed: true, enabled: true });
});
check('parsePluginList: enabled:false entry → {installed:true, enabled:false}', () => {
  assert.deepStrictEqual(uninst.parsePluginList([{ id: PLUGIN_ID, enabled: false }]),
    { installed: true, enabled: false });
});
check('parsePluginList: no matching entry → not installed', () => {
  assert.deepStrictEqual(uninst.parsePluginList([{ id: 'other@market', enabled: true }]),
    { installed: false, enabled: false });
});
check('parsePluginList: empty array → not installed', () => {
  assert.deepStrictEqual(uninst.parsePluginList([]), { installed: false, enabled: false });
});
check('parsePluginList: null → not installed, no warn', () => {
  const { ret, warned } = captureStderr(() => uninst.parsePluginList(null));
  assert.deepStrictEqual(ret, { installed: false, enabled: false });
  assert.strictEqual(warned, '');
});
check('parsePluginList: non-array → warn + fallback not-installed', () => {
  const { ret, warned } = captureStderr(() => uninst.parsePluginList('nope'));
  assert.deepStrictEqual(ret, { installed: false, enabled: false });
  assert.ok(/JSON array/i.test(warned));
});
check('parsePluginList: entries missing `id` → warn + fallback not-installed', () => {
  const { ret, warned } = captureStderr(() => uninst.parsePluginList([{ enabled: true }]));
  assert.deepStrictEqual(ret, { installed: false, enabled: false });
  assert.ok(/id/i.test(warned));
});
check('parsePluginList: matched entry missing boolean enabled → installed+enabled + warn', () => {
  const { ret, warned } = captureStderr(() => uninst.parsePluginList([{ id: PLUGIN_ID }]));
  assert.deepStrictEqual(ret, { installed: true, enabled: true });
  assert.ok(/enabled/i.test(warned));
});
check('parsePluginList: only user-scoped entry → not installed', () => {
  assert.deepStrictEqual(uninst.parsePluginList([{ id: PLUGIN_ID, scope: 'user', enabled: true }]),
    { installed: false, enabled: false });
});
check('parsePluginList: scope absent → still matched', () => {
  assert.deepStrictEqual(uninst.parsePluginList([{ id: PLUGIN_ID, enabled: false }]),
    { installed: true, enabled: false });
});

// ── parseArgs — positional <dir> + --dir flag + flag-guards (mirrors install) ───────────────────────
function runTool(args) {
  const r = spawnSync('node', [TOOL, ...args], { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
check('parseArgs: no args → dir defaults to cwd', () => {
  assert.strictEqual(uninst.parseArgs([]).dir, process.cwd());
});
check('parseArgs: positional dir → dir (mirrors install; `tpm uninstall <dir>` must work via the dispatcher)', () => {
  assert.strictEqual(uninst.parseArgs(['../proj']).dir, '../proj');
});
check('parseArgs: --dir <path> parses', () => {
  assert.strictEqual(uninst.parseArgs(['--dir', '../p']).dir, '../p');
});
check('flag-guard: `--dir` with no value → exit 2', () => {
  assert.strictEqual(runTool(['--dir']).status, 2);
});
check('flag-guard: `--dir -x` (value starts with `-`) → exit 2', () => {
  assert.strictEqual(runTool(['--dir', '-x']).status, 2);
});
check('flag-guard: unknown argument → exit 2', () => {
  assert.strictEqual(runTool(['--bogus']).status, 2);
});

// ── parseArgs — scope flags (project vs whole-system) ────────────────────────────────────────────────
check('parseArgs: --system sets system, leaves project false', () => {
  const a = uninst.parseArgs(['../p', '--system']);
  assert.strictEqual(a.system, true); assert.strictEqual(a.project, false);
});
check('parseArgs: --project sets project, leaves system false', () => {
  const a = uninst.parseArgs(['../p', '--project']);
  assert.strictEqual(a.project, true); assert.strictEqual(a.system, false);
});
check('parseArgs: neither scope flag → both false (interactive fork / --quiet default)', () => {
  const a = uninst.parseArgs(['../p']);
  assert.strictEqual(a.system, false); assert.strictEqual(a.project, false);
});

// ── parseMarketplaceList — landmine detection (shared marketplace source) ─────────────────────────────
const MK = uninst.MARKETPLACE_NAME;
check('parseMarketplaceList: directory-source entry → {registered, source, path}', () => {
  assert.deepStrictEqual(
    uninst.parseMarketplaceList([{ name: MK, source: 'directory', path: '/some/dir' }]),
    { registered: true, source: 'directory', path: '/some/dir' });
});
check('parseMarketplaceList: our market absent → not registered', () => {
  assert.deepStrictEqual(
    uninst.parseMarketplaceList([{ name: 'other-market', source: 'github' }]),
    { registered: false, source: null, path: null });
});
check('parseMarketplaceList: null / non-array → not registered', () => {
  assert.deepStrictEqual(uninst.parseMarketplaceList(null), { registered: false, source: null, path: null });
});

// ── hasTpmDependency ────────────────────────────────────────────────────────────────────────────────
check('hasTpmDependency: dependencies → true', () => {
  assert.strictEqual(uninst.hasTpmDependency({ dependencies: { [TPM_PKG_NAME]: '1.0.0' } }), true);
});
check('hasTpmDependency: optionalDependencies → true', () => {
  assert.strictEqual(uninst.hasTpmDependency({ optionalDependencies: { [TPM_PKG_NAME]: 'file:x' } }), true);
});
check('hasTpmDependency: absent → false', () => {
  assert.strictEqual(uninst.hasTpmDependency({ dependencies: { lodash: '^4' } }), false);
});
check('hasTpmDependency: null pkg → false', () => {
  assert.strictEqual(uninst.hasTpmDependency(null), false);
});

// ── readPackageJson ─────────────────────────────────────────────────────────────────────────────────
check('readPackageJson: exists + valid', () => {
  const dir = mkTmp();
  writePkg(dir, { name: 'consumer', version: '9.9.9' });
  const r = uninst.readPackageJson(dir);
  assert.strictEqual(r.exists, true);
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.value.version, '9.9.9');
});
check('readPackageJson: exists + invalid JSON → error string, null value', () => {
  const dir = mkTmp();
  fs.writeFileSync(path.join(dir, 'package.json'), 'not json');
  const r = uninst.readPackageJson(dir);
  assert.strictEqual(r.exists, true);
  assert.strictEqual(r.value, null);
  assert.ok(typeof r.error === 'string' && r.error.length > 0);
});
check('readPackageJson: absent → {exists:false, value:null, error:null}', () => {
  assert.deepStrictEqual(uninst.readPackageJson(mkTmp()), { exists: false, value: null, error: null });
});

// ── classifySpawn / EACCES-blind-spot fix — PARITY with the install tool (lifted verbatim). The bug: a
// non-runnable `claude` on PATH (a directory or non-exec file shadowing the real bin) makes spawnSync
// return EACCES, not ENOENT — the OLD `!(r.error && r.error.code==='ENOENT')` check called it AVAILABLE.
// These feed fake spawn result shapes to the pure helper so the misdetection is caught deterministically.
check('classifySpawn: clean run (status 0) → ok + ran, no errorCode', () => {
  assert.deepStrictEqual(uninst.classifySpawn({ status: 0, signal: null }),
    { ok: true, ran: true, status: 0, signal: null, errorCode: null });
});
check('classifySpawn: ENOENT (absent bin) → not ok, not ran, errorCode ENOENT', () => {
  const c = uninst.classifySpawn({ error: { code: 'ENOENT' }, status: null });
  assert.strictEqual(c.ok, false); assert.strictEqual(c.ran, false); assert.strictEqual(c.errorCode, 'ENOENT');
});
check('classifySpawn: EACCES (dir/non-exec shadow on PATH) → not ok, not ran, errorCode EACCES (the blind spot)', () => {
  const c = uninst.classifySpawn({ error: { code: 'EACCES' }, status: null });
  assert.strictEqual(c.ok, false); assert.strictEqual(c.ran, false); assert.strictEqual(c.errorCode, 'EACCES');
});
check('classifySpawn: ran but exited non-zero → not ok, ran true, no errorCode', () => {
  const c = uninst.classifySpawn({ status: 3, signal: null });
  assert.strictEqual(c.ok, false); assert.strictEqual(c.ran, true); assert.strictEqual(c.errorCode, null);
});
check('classifySpawn: signal-killed (status null, no error) → ran true, status null, no errorCode', () => {
  const c = uninst.classifySpawn({ status: null, signal: 'SIGTTIN' });
  assert.strictEqual(c.ran, true); assert.strictEqual(c.status, null);
  assert.strictEqual(c.signal, 'SIGTTIN'); assert.strictEqual(c.errorCode, null);
});

// ── formatChildExit — spawn-error vs status vs signal (drives the ✗ failure line + the --debug `←` line) ──
check('formatChildExit: a spawn error → "could not run (CODE: reason)", NOT a signal branch', () => {
  assert.strictEqual(uninst.formatChildExit({ error: { code: 'EACCES' } }), 'could not run (EACCES: permission denied)');
  assert.strictEqual(uninst.formatChildExit({ error: { code: 'ENOENT' } }), 'could not run (ENOENT: not found on PATH)');
  assert.strictEqual(uninst.formatChildExit({ errorCode: 'EACCES', status: null, signal: null }),
    'could not run (EACCES: permission denied)');
});
check('formatChildExit: status 0 → "ok"; status>0 → "exited N"', () => {
  assert.strictEqual(uninst.formatChildExit({ status: 0, signal: null }), 'ok');
  assert.strictEqual(uninst.formatChildExit({ status: 3, signal: null }), 'exited 3');
});
check('formatChildExit: status null names the killing signal (the exit-null case)', () => {
  assert.strictEqual(uninst.formatChildExit({ status: null, signal: 'SIGTTIN' }),
    'exited null (killed by signal SIGTTIN)');
  assert.strictEqual(uninst.formatChildExit({ status: null, signal: null }),
    'exited null (killed by signal unknown)');
});

// ── spawnErrorReason / preflightMessage — the honest ENOENT-vs-EACCES uninstall preflight lines ──
check('spawnErrorReason: known errno mapped, unknown → generic', () => {
  assert.strictEqual(uninst.spawnErrorReason('ENOENT'), 'not found on PATH');
  assert.strictEqual(uninst.spawnErrorReason('EACCES'), 'permission denied');
  assert.strictEqual(uninst.spawnErrorReason('EWHATEVER'), 'spawn error');
});
check('preflightMessage: ENOENT → "not found on PATH" + install hint', () => {
  const m = uninst.preflightMessage('claude', uninst.classifySpawn({ error: { code: 'ENOENT' } }), 'install Claude Code first.');
  assert.ok(/not found on PATH/.test(m) && /install Claude Code first\./.test(m));
});
check('preflightMessage: EACCES → "found but not executable" + host-vs-VM hint', () => {
  const m = uninst.preflightMessage('claude', uninst.classifySpawn({ error: { code: 'EACCES' } }), 'install Claude Code first.');
  assert.ok(/not executable \(EACCES\)/.test(m) && /THIS host/.test(m) && /VM/.test(m));
});
check('claudeCliAvailable: returns a classifySpawn verdict object (callers read .ok/.errorCode)', () => {
  // Guard (fb2): never probe the AMBIENT `claude` — put a fake first (and ONLY) on PATH for this call.
  const fakeBin = path.join(mkTmp(), 'bin'); fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const savedPath = process.env.PATH;
  let v;
  try { process.env.PATH = fakeBin; v = uninst.claudeCliAvailable(); } finally { process.env.PATH = savedPath; }
  assert.strictEqual(typeof v, 'object');
  assert.ok('ok' in v && 'ran' in v && 'errorCode' in v);
  assert.strictEqual(v.ok, true, 'the fake claude on PATH answered (proves the probe used it, not a real one)');
});

// ── --debug operation-trace flag (parity: --debug / TPM_DEBUG / [tpm-debug] prefix) ──
check('parseArgs: --debug sets opts.debug (default false, order-independent)', () => {
  assert.strictEqual(uninst.parseArgs(['--debug']).debug, true);
  assert.strictEqual(uninst.parseArgs([]).debug, false);
  assert.strictEqual(uninst.parseArgs(['../proj', '--debug', '--system']).debug, true);
});
check('debugEnabled: true from opts.debug OR a non-empty TPM_DEBUG env', () => {
  assert.strictEqual(uninst.debugEnabled({ debug: true }), true);
  const saved = process.env.TPM_DEBUG;
  delete process.env.TPM_DEBUG;
  assert.strictEqual(uninst.debugEnabled({ debug: false }), false);
  process.env.TPM_DEBUG = '1';
  assert.strictEqual(uninst.debugEnabled({ debug: false }), true);
  if (saved === undefined) delete process.env.TPM_DEBUG; else process.env.TPM_DEBUG = saved;
});
check('makeDbg: disabled → no-op; enabled → one [tpm-debug]-prefixed stdout line', () => {
  assert.strictEqual(typeof uninst.makeDbg(false), 'function');
  const orig = process.stdout.write; let buf = '';
  process.stdout.write = (chunk) => { buf += chunk; return true; };
  try { uninst.makeDbg(false)('hidden'); uninst.makeDbg(true)('→ spawn:', 'claude', 'x'); }
  finally { process.stdout.write = orig; }
  assert.ok(!/hidden/.test(buf), 'disabled dbg writes nothing');
  assert.ok(/^\[tpm-debug\] → spawn: claude x\n$/.test(buf), 'enabled dbg writes one prefixed line');
});

// ── honest ENOENT-vs-EACCES preflight (isolated PATH; child process; no host mutation) ──
// A fake `claude` shim (answers --version + list verbs with empty arrays; no-op for mutations) lets the
// real run path exercise without touching the real registry. The EACCES/ENOENT cases plant a
// non-executable / absent `claude` so the preflight sees the exact spawn errno.
const FAKE_CLAUDE_SHIM = "#!/usr/bin/env node\n'use strict';\nvar a=process.argv.slice(2);\nif(a[0]==='--version'){process.stdout.write('9.9.9 (fake)\\n');process.exit(0);} \nif(a[0]==='plugin'&&a[1]==='marketplace'&&a[2]==='list'){process.stdout.write('[]');process.exit(0);} \nif(a[0]==='plugin'&&a[1]==='list'){process.stdout.write('[]');process.exit(0);} \nprocess.exit(0);\n";
function runToolWithClaude(args, plant, envExtra) {
  // plant: 'fake' → runnable fake claude; 'noexec' → non-exec file (EACCES); 'absent' → no claude (ENOENT).
  const dir = mkTmp();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  if (plant === 'fake') { fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE_SHIM); fs.chmodSync(path.join(bin, 'claude'), 0o755); }
  else if (plant === 'noexec') { fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho nope\n'); fs.chmodSync(path.join(bin, 'claude'), 0o644); }
  const env = Object.assign({ CLAUDE_CONFIG_DIR: mkTmp() }, envExtra, { PATH: plant === 'fake' ? (bin + path.delimiter + process.env.PATH) : bin });
  // Launch via process.execPath (absolute node), NOT `node` — env.PATH is restricted for the noexec/absent
  // cases, so relying on PATH to find node would ENOENT on the tool launch itself before its preflight runs.
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env, timeout: 15000 });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}
check('preflight: non-exec `claude` shadowing PATH (EACCES) → honest message + exit 1 (the blind spot)', () => {
  const r = runToolWithClaude([mkTmp(), '--project', '--quiet'], 'noexec');
  assert.strictEqual(r.status, 1);
  assert.ok(/not executable \(EACCES\)/.test(r.err), r.err);
  assert.ok(/THIS host/.test(r.err));
  assert.ok(!/removed from this project/i.test(r.out + r.err));
});
check('preflight: no `claude` on PATH (ENOENT) → honest "not found on PATH" + exit 1', () => {
  const r = runToolWithClaude([mkTmp(), '--project', '--quiet'], 'absent');
  assert.strictEqual(r.status, 1);
  assert.ok(/`claude` not found on PATH/.test(r.err), r.err);
  assert.ok(/install Claude Code first/.test(r.err));
});
check('--debug: emits [tpm-debug] trace lines to STDOUT on a real run path (fake claude, no host mutation)', () => {
  const r = runToolWithClaude([mkTmp(), '--project', '--quiet', '--debug'], 'fake');
  assert.strictEqual(r.status, 0, r.err);
  assert.ok(/\[tpm-debug\]/.test(r.out), r.out.slice(0, 400));
  assert.ok(/\[tpm-debug\] scope: system=false/.test(r.out));
  assert.ok(/\[tpm-debug\] probe:/.test(r.out));
});
check('--debug: TPM_DEBUG=1 env enables the trace without the flag', () => {
  const r = runToolWithClaude([mkTmp(), '--project', '--quiet'], 'fake', { TPM_DEBUG: '1' });
  assert.strictEqual(r.status, 0, r.err);
  assert.ok(/\[tpm-debug\]/.test(r.out));
});
check('--help lists the --debug row', () => {
  const r = spawnSync('node', [TOOL, '--help'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.ok(/--debug/.test(r.stdout || ''));
});

// ══ 5.3 — uninstaller mirror rule + scopes ═══════════════════════════════════════════════════════════
// Stateful fake `claude` (tests/fake-claude-stateful.js) first on PATH; CLAUDE_CONFIG_DIR + HOME point at a
// scratch dir so the "installed_plugins.json" read never reaches the real ~/.claude.
const FAKE_STATEFUL = path.resolve(__dirname, '..', 'fake-claude-stateful.js');
const BUNDLE_REAL = fs.realpathSync(uninst.findBundleRoot(__dirname));
function runUninstStateful(dir, args, o) {
  o = o || {};
  const work = mkTmp();
  const shim = path.join(work, 'claude'); fs.copyFileSync(FAKE_STATEFUL, shim); fs.chmodSync(shim, 0o755);
  const statePath = path.join(work, 'state.json'); const logPath = path.join(work, 'calls.jsonl');
  fs.writeFileSync(statePath, JSON.stringify({ marketplaces: o.marketplaces || [], records: o.records || [] }));
  const cfg = path.join(work, 'claude-config');
  if (o.fileRecords) {
    fs.mkdirSync(path.join(cfg, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(cfg, 'plugins', 'installed_plugins.json'), JSON.stringify(o.fileRecords));
  }
  const env = Object.assign({}, process.env, { PATH: work + path.delimiter + process.env.PATH,
    FAKE_CLAUDE_STATE: statePath, FAKE_CLAUDE_LOG: logPath, CLAUDE_CONFIG_DIR: cfg, HOME: work });
  const r = spawnSync('node', [TOOL, dir].concat(args || []), { encoding: 'utf8', env, input: o.input || '', timeout: 30000 });
  const calls = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), calls, state: JSON.parse(fs.readFileSync(statePath, 'utf8')) };
}
const mutLines = (r) => r.calls.filter((c) => (c.argv[1] === 'marketplace' && c.argv[2] === 'remove') ||
  ['install', 'enable', 'disable', 'uninstall'].indexOf(c.argv[1]) >= 0).map((c) => c.argv.join(' '));
function consumerDir() { const d = mkTmp(); writePkg(d, { name: 'consumer', version: '1.0.0' }); return d; }
const rowSame = () => [{ name: MK, source: 'directory', path: BUNDLE_REAL }];
const rec = (projectPath) => ({ id: PLUGIN_ID, scope: 'project', enabled: true, installPath: BUNDLE_REAL, projectPath });

check('5.3 pure: flattenInstalledPlugins reads the v2 map-of-arrays, a plain array, and ignores other ids', () => {
  const v2 = { version: 2, plugins: { [PLUGIN_ID]: [{ scope: 'project', projectPath: '/a' }, { scope: 'user' }], 'other@m': [{ scope: 'project', projectPath: '/z' }] } };
  assert.deepStrictEqual(uninst.flattenInstalledPlugins(v2, PLUGIN_ID).map((r) => r.projectPath), ['/a', undefined]);
  assert.strictEqual(uninst.flattenInstalledPlugins([{ id: PLUGIN_ID, scope: 'project', projectPath: '/b' }, { id: 'x@y' }], PLUGIN_ID).length, 1);
  assert.deepStrictEqual(uninst.flattenInstalledPlugins(null, PLUGIN_ID), []);
});
check('5.3 pure: otherUsersOf excludes THIS project (even via a symlink), names the others, treats unknowns conservatively', () => {
  const me = mkTmp(); const meLink = path.join(mkTmp(), 'l'); fs.symlinkSync(me, meLink); const other = mkTmp();
  assert.deepStrictEqual(uninst.otherUsersOf([{ id: PLUGIN_ID, projectPath: meLink, scope: 'project' }], me), []);
  assert.deepStrictEqual(uninst.otherUsersOf([{ id: PLUGIN_ID, projectPath: me }, { id: PLUGIN_ID, projectPath: other }, { id: PLUGIN_ID, projectPath: other }], me), [other], 'deduped');
  assert.strictEqual(uninst.otherUsersOf([{ id: PLUGIN_ID, scope: 'user' }], me).length, 1, 'a user-scope install counts as another user');
  assert.strictEqual(uninst.otherUsersOf([{ id: PLUGIN_ID, scope: 'project' }], me).length, 1, 'no projectPath → can\'t prove it is ours → counts');
  assert.deepStrictEqual(uninst.otherUsersOf([{ id: 'unrelated@m', projectPath: other }], me), []);
});
check('5.3 pure: parsePluginList(list, target) matches only THIS project\'s record', () => {
  const me = mkTmp(); const other = mkTmp();
  assert.deepStrictEqual(uninst.parsePluginList([{ id: PLUGIN_ID, scope: 'project', enabled: true, projectPath: other }], me), { installed: false, enabled: false });
  assert.deepStrictEqual(uninst.parsePluginList([{ id: PLUGIN_ID, scope: 'project', enabled: false, projectPath: me }], me), { installed: true, enabled: false });
});

check('5.3 mirror rule: LAST project → plugin uninstalled at project scope (cwd=target), marketplace row removed (resolved name, no --scope), dep step skipped', () => {
  const dir = consumerDir();
  const r = runUninstStateful(dir, ['--quiet'], { marketplaces: rowSame(), records: [rec(dir)] });
  assert.strictEqual(r.status, 0, r.out);
  assert.deepStrictEqual(mutLines(r), [`plugin uninstall ${PLUGIN_ID} --scope project -y`, `plugin marketplace remove ${MK}`]);
  const un = r.calls.find((c) => c.argv[1] === 'uninstall');
  assert.strictEqual(fs.realpathSync(un.cwd), fs.realpathSync(dir));
  assert.deepStrictEqual(r.state.marketplaces, [], 'row gone');
  assert.deepStrictEqual(r.state.records, [], 'record gone');
});
check('5.3 mirror rule: ANOTHER project has an install record (CLI list) → row LEFT, other project NAMED, message warns removal would uninstall it for them', () => {
  const dir = consumerDir(); const other = mkTmp();
  const r = runUninstStateful(dir, ['--quiet'], { marketplaces: rowSame(), records: [rec(dir), rec(other)] });
  assert.strictEqual(r.status, 0, r.out);
  assert.deepStrictEqual(mutLines(r), [`plugin uninstall ${PLUGIN_ID} --scope project -y`], 'no marketplace remove');
  assert.strictEqual(r.state.marketplaces.length, 1, 'row still registered');
  assert.deepStrictEqual(r.state.records.map((x) => x.projectPath), [other], 'only the other project\'s record remains');
  assert.ok(r.out.indexOf(other) >= 0, 'names the project still using it');
  assert.ok(/uninstall it for them/.test(r.out) && /install record/.test(r.out), r.out);
});
check('5.3 mirror rule: the other project is visible ONLY in installed_plugins.json (CLI list shows just this one) → row still LEFT', () => {
  const dir = consumerDir(); const other = mkTmp();
  const r = runUninstStateful(dir, ['--quiet'], { marketplaces: rowSame(), records: [rec(dir)],
    fileRecords: { version: 2, plugins: { [PLUGIN_ID]: [{ scope: 'project', projectPath: other, installPath: BUNDLE_REAL }] } } });
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(!mutLines(r).some((l) => /marketplace remove/.test(l)), 'row not removed: ' + mutLines(r));
  assert.ok(r.out.indexOf(other) >= 0);
});
check('5.3 scopes: --system removes the row EVEN WITH other projects, names them and the #11a consequence', () => {
  const dir = consumerDir(); const other = mkTmp();
  const r = runUninstStateful(dir, ['--quiet', '--system'], { marketplaces: rowSame(), records: [rec(dir), rec(other)] });
  assert.strictEqual(r.status, 0, r.out);
  assert.deepStrictEqual(mutLines(r), [`plugin uninstall ${PLUGIN_ID} --scope project -y`, `plugin marketplace remove ${MK}`]);
  assert.deepStrictEqual(r.state.records, [], 'marketplace remove wiped the other project\'s record too (fake mirrors probe #11a)');
  assert.ok(r.out.indexOf(other) >= 0 && /uninstalls the plugin for every project/.test(r.out) && /WHOLE-SYSTEM/.test(r.out), r.out);
});
check('5.3 scopes: --system interactive decline → exit 1, nothing mutated', () => {
  const dir = consumerDir();
  const r = runUninstStateful(dir, ['--system'], { input: 'n\n', marketplaces: rowSame(), records: [rec(dir)] });
  assert.strictEqual(r.status, 1, r.out);
  assert.deepStrictEqual(mutLines(r), []);
});
check('5.3 messages use the RESOLVED marketplace name, never the bare hardcoded claude-tpm-market', () => {
  const dir = consumerDir(); const other = mkTmp();
  for (const [args, records] of [[['--quiet'], [rec(dir)]], [['--quiet'], [rec(dir), rec(other)]], [['--quiet', '--system'], [rec(dir), rec(other)]]]) {
    const r = runUninstStateful(dir, args, { marketplaces: rowSame(), records });
    assert.ok(!/claude-tpm-market(?![-\w])/.test(r.out), 'bare name leaked: ' + r.out);
    assert.ok(r.out.indexOf(MK) >= 0, 'resolved name present');
  }
});
check('5.3 landmine: row left behind that points INSIDE this project\'s node_modules (real copy) → interactive consent; decline = exit 1, nothing mutated', () => {
  const dir = consumerDir(); const other = mkTmp();
  const nm = path.join(dir, 'node_modules', TPM_PKG_NAME); writePkg(nm, { name: TPM_PKG_NAME });
  const r = runUninstStateful(dir, ['--project'], { input: 'n\n', marketplaces: [{ name: MK, source: 'directory', path: nm }], records: [rec(dir), rec(other)] });
  assert.strictEqual(r.status, 1, r.out);
  assert.ok(/points INSIDE this project's node_modules/.test(r.out) && r.out.indexOf(other) >= 0);
  assert.deepStrictEqual(mutLines(r), []);
});
check('5.3 landmine does NOT fire when node_modules is just a symlink to the central folder the row points at', () => {
  const dir = consumerDir(); const other = mkTmp();
  const scope = path.join(dir, 'node_modules', '@codercowboy'); fs.mkdirSync(scope, { recursive: true });
  fs.symlinkSync(BUNDLE_REAL, path.join(scope, 'claude-tpm'));
  const r = runUninstStateful(dir, ['--quiet'], { marketplaces: rowSame(), records: [rec(dir), rec(other)] });
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(!/points INSIDE/.test(r.out), r.out);
});
// ══ 5.6 — output UX ═════════════════════════════════════════════════════════════════════════════════
check('5.6 uninstall output: step headers ("Step N/M · Title"), command + one sentence, no command:/edits:/does:; leaving the shared row is ONE explanatory block naming the other project', () => {
  const dir = consumerDir(); const other = mkTmp();
  const r = runUninstStateful(dir, ['--quiet'], { marketplaces: rowSame(), records: [rec(dir), rec(other)] });
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(/^Step 1\/2 · Uninstall the plugin from this project$/m.test(r.out), r.out);
  assert.ok(/^\s+\$ claude plugin uninstall /m.test(r.out) && !/^\s+(command|edits|does):/m.test(r.out), r.out);
  assert.ok(/^✓ Marketplace row ".*" left in place — 1 other project still uses it:/m.test(r.out), r.out);
  assert.ok(/^Step 2\/2 · Remove the claude-tpm dependency$|^✓ Step 2\/2 · Remove the claude-tpm dependency — already done, skipped\.$/m.test(r.out), r.out);
});
check('5.6 uninstall --system output names the registry edit once and the whole-system warning; the step header says "(whole system)"', () => {
  const dir = consumerDir();
  const r = runUninstStateful(dir, ['--quiet', '--system'], { marketplaces: rowSame(), records: [rec(dir)] });
  assert.ok(/^Step 2\/3 · Remove the marketplace row \(whole system\)$/m.test(r.out), r.out);
  assert.ok(/\(changes: this machine's Claude Code marketplace registry, user scope\)/.test(r.out), r.out);
});
check('5.6 uninstall --check: one line per row (✓ removed / ✗ still there + fix:), neutral labels, summary line, exit code unchanged', () => {
  const dir = consumerDir();
  const bad = runUninstStateful(dir, ['--check'], { marketplaces: rowSame(), records: [rec(dir)] });
  assert.strictEqual(bad.status, 1, bad.out);
  assert.ok(/^\s+✗ plugin install record\s+.*still installed here/m.test(bad.out) && /^\s+✗ marketplace\s+.*still registered/m.test(bad.out), bad.out);
  const lines = bad.out.split('\n');
  lines.forEach((l, i) => { if (/^\s+✗ /.test(l)) assert.ok(/^\s+fix: \S/.test(lines[i + 1] || ''), l); });
  assert.ok(/Summary: \d ok · \d problems?/.test(bad.out), bad.out);
  assert.ok(!/is NOT/.test(bad.out), 'labels do not state the passing condition: ' + bad.out);
  const clean = runUninstStateful(dir, ['--check'], { marketplaces: [], records: [] });
  const depLeft = /✗ claude-tpm dependency/.test(clean.out);
  assert.strictEqual(clean.status, depLeft ? 1 : 0, clean.out);
  assert.ok(/^\s+✓ plugin install record\s+removed/m.test(clean.out) && /^\s+✓ marketplace\s+not registered/m.test(clean.out), clean.out);
});

check('5.3 help describes the mirror rule and the resolved name', () => {
  const r = spawnSync('node', [TOOL, '--help'], { encoding: 'utf8' });
  assert.ok(/MIRRORS/.test(r.stdout) && /no OTHER\s+project/.test(r.stdout) && /USER scope/.test(r.stdout));
  assert.ok(!/marketplace remove claude-tpm-market`/.test(r.stdout), 'no hardcoded bare name in command examples');
});


// ── 5.2 consistency: the install's "uninstall from the other project first" option prints
//    `cd <other project> && npx tpm uninstall --system` — that flag must exist and free the row. ──────────
check('5.2 hint consistency: `uninstall --system` (printed by the install real-copy option 2) parses, and --quiet --system from the project that owns the real copy removes the marketplace row', () => {
  assert.strictEqual(uninst.parseArgs(['--system']).system, true);
  const other = consumerDir();
  const copy = path.join(other, 'node_modules', '@codercowboy', 'claude-tpm');
  fs.mkdirSync(path.join(copy, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(copy, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: MK, plugins: [{ name: 'claude-tpm' }] }));
  const realCopy = fs.realpathSync(copy);
  const r = runUninstStateful(other, ['--quiet', '--system'], { marketplaces: [{ name: MK, source: 'directory', path: realCopy }],
    records: [{ id: PLUGIN_ID, scope: 'project', enabled: true, installPath: realCopy, projectPath: other }] });
  assert.strictEqual(r.status, 0, r.out);
  assert.deepStrictEqual(r.state.marketplaces, [], 'the row that pointed at the real copy is gone (freed for the next install)');
  assert.ok(mutLines(r).indexOf(`plugin marketplace remove ${MK}`) >= 0, mutLines(r).join(' | '));
});

cleanup();
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
