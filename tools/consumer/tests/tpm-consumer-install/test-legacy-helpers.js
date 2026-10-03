#!/usr/bin/env node
/**
 * test-legacy-helpers.js — the helpers tpm-consumer-install.js still exports after phase 04 retired its LEGACY block
 * (the detectors now live in tpm-consumer-observe.js, tested there). Covers: parseArgs flag-guard (exit 2), the
 * --debug trace, findBundleRoot, parseHooksManifest (the observer's), bundleHooksHealth (the doctor's), the retained
 * hashTree/compareCopies/shellQuote/displayCommand/ensureConsumerConfig, and a GUARD that every retired helper is gone
 * from install.js's exports and that nothing in tools/ still requires one.
 *
 * Pure: no real `claude`/`npm` is ever run (the flag-guard children exit at argument parsing, before any CLI call).
 *
 * Usage: node tools/consumer/tests/tpm-consumer-install/test-legacy-helpers.js   → exit 0 all pass, 1 otherwise.
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
const doctorMod = require(path.resolve(path.dirname(TOOL), 'tpm-consumer-doctor.js')); // bundleHooksHealth moved here (phase 03)
const O = require(path.resolve(path.dirname(TOOL), 'tpm-consumer-observe.js')); // the shared observer owns parseHooksManifest
const { PLUGIN_ID, TPM_PKG_NAME } = inst;

const FAKE_CLAUDE = null; // none needed: pure helpers only (see header)
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

process.stdout.write('tpm-consumer-install retained helpers (flag-guard, debug trace, findBundleRoot, hooks health, compare/hash/quote/config seed, retired-helper guard)\n');

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
check('makeDbg: disabled → no-op; enabled → one [tpm-debug]-prefixed stdout line', () => {
  assert.strictEqual(typeof inst.makeDbg(false), 'function');
  const orig = process.stdout.write; let buf = '';
  process.stdout.write = (chunk) => { buf += chunk; return true; };
  try { inst.makeDbg(false)('hidden'); inst.makeDbg(true)('→ spawn:', 'claude', 'x'); }
  finally { process.stdout.write = orig; }
  assert.ok(!/hidden/.test(buf), 'disabled dbg writes nothing');
  assert.ok(/^\[tpm-debug\] → spawn: claude x\n$/.test(buf), 'enabled dbg writes one prefixed line');
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
  assert.deepStrictEqual(O.parseHooksManifest(NODE_FORM), { gateSpawn: true, sessionStart: true });
});
check('parseHooksManifest: the shipped hooks/hooks.json → both detected', () => {
  const real = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'hooks', 'hooks.json'), 'utf8'));
  assert.deepStrictEqual(O.parseHooksManifest(real), { gateSpawn: true, sessionStart: true });
});
check('parseHooksManifest: session-start under the wrong event (PreToolUse) is NOT detected as sessionStart', () => {
  const wrong = { hooks: { PreToolUse: [{ hooks: [{ command: 'tpm hooks session-start' }] }] } };
  assert.deepStrictEqual(O.parseHooksManifest(wrong), { gateSpawn: false, sessionStart: false });
});
check('parseHooksManifest: SessionStart alone → sessionStart true, gateSpawn false', () => {
  const only = { hooks: { SessionStart: [{ hooks: [{ command: 'tpm hooks session-start' }] }] } };
  assert.deepStrictEqual(O.parseHooksManifest(only), { gateSpawn: false, sessionStart: true });
});
check('parseHooksManifest: the real hooks.json → gate-spawn detected', () => {
  assert.deepStrictEqual(O.parseHooksManifest(REAL_MANIFEST), { gateSpawn: true, sessionStart: false });
});
check('parseHooksManifest: matches by substring so a `node …` command form still detects', () => {
  const legacy = { hooks: { PreToolUse: [
    { hooks: [{ command: 'node x/tools/workflow/hooks/tpm-workflow-gate-spawn.js' }] },
  ] } };
  // command lacks "hooks gate-spawn" wording → NOT matched (we key on the routed `hooks <name>` form)
  assert.strictEqual(O.parseHooksManifest(legacy).gateSpawn, false);
  const routed = { hooks: { PreToolUse: [{ hooks: [{ command: 'tpm hooks gate-spawn' }] }] } };
  assert.strictEqual(O.parseHooksManifest(routed).gateSpawn, true);
});
check('parseHooksManifest: gate-spawn present in PreToolUse → detected', () => {
  const partial = { hooks: { PreToolUse: [{ hooks: [{ command: 'npx tpm hooks gate-spawn' }] }] } };
  assert.deepStrictEqual(O.parseHooksManifest(partial), { gateSpawn: true, sessionStart: false });
});
check('parseHooksManifest: the retired %TPM_HOME% content hook is NOT detected (no such field)', () => {
  // The content hook was retired in #1126 — a stray one must not resurrect any field or affect gate-spawn.
  const stray = { hooks: { PostToolUse: [{ hooks: [{ command: 'npx tpm hooks expand-tpm-home-content' }] }] } };
  assert.deepStrictEqual(O.parseHooksManifest(stray), { gateSpawn: false, sessionStart: false });
});
check('parseHooksManifest: garbage/empty input → gate-spawn false, no throw', () => {
  assert.deepStrictEqual(O.parseHooksManifest(null), { gateSpawn: false, sessionStart: false });
  assert.deepStrictEqual(O.parseHooksManifest({}), { gateSpawn: false, sessionStart: false });
  assert.deepStrictEqual(O.parseHooksManifest({ hooks: { PreToolUse: 'nope' } }), { gateSpawn: false, sessionStart: false });
});

// ── bundleHooksHealth (2a: disk read from the target's node_modules) ─────────────────────────────────
function writeBundleHooks(dir, manifestOrRaw) {
  const hooksDir = path.join(dir, 'node_modules', TPM_PKG_NAME, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'hooks.json'),
    typeof manifestOrRaw === 'string' ? manifestOrRaw : JSON.stringify(manifestOrRaw));
}
check('bundleHooksHealth: absent manifest → present:false (degrades to skip)', () => {
  assert.deepStrictEqual(doctorMod.bundleHooksHealth(mkTmp()),
    { present: false, error: null, gateSpawn: false, sessionStart: false });
});
check('bundleHooksHealth: real delivered manifest → present + gate-spawn', () => {
  const dir = mkTmp();
  writeBundleHooks(dir, REAL_MANIFEST);
  assert.deepStrictEqual(doctorMod.bundleHooksHealth(dir),
    { present: true, error: null, gateSpawn: true, sessionStart: false });
});
check('bundleHooksHealth: malformed manifest JSON → present:true + error, hooks false', () => {
  const dir = mkTmp();
  writeBundleHooks(dir, '{ not json');
  const r = doctorMod.bundleHooksHealth(dir);
  assert.strictEqual(r.present, true);
  assert.ok(typeof r.error === 'string' && r.error.length > 0);
  assert.strictEqual(r.gateSpawn, false);
  assert.strictEqual(r.sessionStart, false, 'the parse-error early return carries the full shape incl. sessionStart');
});

// ── retained: hashTree / compareCopies (the `comparing the two copies …` verdict) ─────────────────────
function writeTree(dir, files) { for (const k of Object.keys(files)) { const p = path.join(dir, k); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, files[k]); } return dir; }
check('compareCopies: identical trees → identical; one changed + one extra file → differs with the exact count', () => {
  const a = writeTree(mkTmp(), { 'a.txt': '1', 'd/b.txt': '2' });
  const b = writeTree(mkTmp(), { 'a.txt': '1', 'd/b.txt': '2' });
  assert.deepStrictEqual(inst.compareCopies(a, b), { verdict: 'identical', count: 0, text: 'same version, identical files' });
  fs.writeFileSync(path.join(b, 'a.txt'), 'changed'); fs.writeFileSync(path.join(b, 'new.txt'), 'x');
  const r = inst.compareCopies(a, b);
  assert.strictEqual(r.verdict, 'differs'); assert.strictEqual(r.count, 2);
});
check('hashTree: skips .DS_Store / tmp / node_modules / .git at any depth; compareCopies of a missing folder → unknown, never throws', () => {
  const a = writeTree(mkTmp(), { 'x.txt': '1', '.DS_Store': 'j', 'tmp/s': 's', 'node_modules/m': 'm', 'd/.git/c': 'c' });
  assert.deepStrictEqual(Object.keys(inst.hashTree(a)), ['x.txt']);
  assert.strictEqual(inst.compareCopies(a, path.join(mkTmp(), 'nope')).verdict, 'unknown');
});

// ── retained: shellQuote / displayCommand (copy-pasteable $ lines) ────────────────────────────────────
check('shellQuote / displayCommand: plain args bare; spaces and quotes single-quoted (display only)', () => {
  assert.strictEqual(inst.shellQuote('npm'), 'npm');
  assert.strictEqual(inst.shellQuote('/a b/c'), "'/a b/c'");
  assert.strictEqual(inst.shellQuote("it's"), "'it'\\''s'");
  assert.strictEqual(inst.displayCommand('claude', ['plugin', 'install', '/a b']), "claude plugin install '/a b'");
});

// ── retained: ensureConsumerConfig / seedConfigDefaults ───────────────────────────────────────────────
check('ensureConsumerConfig: writes the seed once, never clobbers an existing config', () => {
  const dir = mkTmp();
  const r1 = inst.ensureConsumerConfig(dir);
  assert.strictEqual(r1.wrote, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(r1.path, 'utf8')), inst.seedConfigDefaults());
  fs.writeFileSync(r1.path, '{"mine":true}');
  const r2 = inst.ensureConsumerConfig(dir);
  assert.deepStrictEqual({ wrote: r2.wrote, reason: r2.reason }, { wrote: false, reason: 'exists' });
  assert.strictEqual(fs.readFileSync(r1.path, 'utf8'), '{"mine":true}');
});

// ── GUARD: the LEGACY block is gone and nothing dangles ───────────────────────────────────────────────
const RETIRED = ['parsePluginList', 'parseMarketplaceList', 'parsePluginInstallPath', 'hasTpmDependency', 'nodeModulesHasTpm', 'readPackageJson',
  'classifySpawn', 'formatChildExit', 'spawnErrorReason', 'preflightMessage', 'configJsonValidity', 'parseHooksManifest', 'claudeCliAvailable',
  'commandAvailable', 'marketplaceRegistered', 'pluginState', 'marketplaceSourceHealth', 'classifyMarketplaceRow', 'marketplaceRow', 'realCopyInfo',
  'realCopyMessage', 'pluginCacheHealth', 'settingsEnabledPlugins', 'claudeTpmEnabledIds', 'bundleVersion', 'recordMatches', 'defaultFromSpec', 'manifestVersionStamp', 'readBundleIdentity'];
check('install.js no longer exports any retired LEGACY helper', () => {
  for (const k of RETIRED) assert.strictEqual(inst[k], undefined, k);
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.ok(!/LEGACY DOCTOR/.test(src) && !/END LEGACY/.test(src), 'the LEGACY banners are gone');
});
check('no file under tools/ requires a retired install.js helper (grep guard)', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const hits = [];
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      if (n === 'node_modules' || n === 'tmp' || n === '.git') continue;
      const p = path.join(d, n); const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.js$/.test(n)) {
        const t = fs.readFileSync(p, 'utf8');
        if (!/require\([^)]*tpm-consumer-install/.test(t)) continue;
        for (const k of RETIRED) if (new RegExp('\\binst(?:all)?\\.' + k + '\\b').test(t) && p !== __filename) hits.push(path.relative(root, p) + ' → ' + k);
      }
    }
  })(root);
  assert.deepStrictEqual(hits, []);
});

cleanup();
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
