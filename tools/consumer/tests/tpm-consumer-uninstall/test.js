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
  const v = uninst.claudeCliAvailable();
  assert.strictEqual(typeof v, 'object');
  assert.ok('ok' in v && 'ran' in v && 'errorCode' in v);
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
  const env = Object.assign({}, envExtra, { PATH: plant === 'fake' ? (bin + path.delimiter + process.env.PATH) : bin });
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

cleanup();
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
