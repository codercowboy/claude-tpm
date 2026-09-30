#!/usr/bin/env node
/**
 * test.js — the R9 doctor rows of tpm-consumer-install.js (`--check` / `tpm doctor`), one test per row/case.
 *
 * Every run goes through the STATEFUL fake `claude` (tests/fake-claude-stateful.js, copied to <work>/claude and
 * put FIRST on PATH) with HOME / CLAUDE_CONFIG_DIR pointed at scratch dirs, so the real `claude`, the real
 * plugin registry and ~/.claude are never reached. TPM_PROJECT_ROOT / TPM_HOME are stripped from the child env
 * unless a test sets them on purpose (they gate the in-session-only `tpm`-on-PATH row).
 *
 * Every doctor run in this file is also asserted to print a `fix:` line directly under EVERY ✗/⚠
 * row (the "every ✗/⚠ prints its fix" rule) — see doctor().
 *
 * Usage: node tools/consumer/tests/tpm-consumer-doctor/test.js   → exit 0 all pass, 1 otherwise.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { mkScratch } = require('../../../tests/lib/scratch');

const TOOL = path.resolve(__dirname, '..', '..', 'tpm-consumer-install.js');
const inst = require(TOOL);
const { PLUGIN_ID, TPM_PKG_NAME, MARKETPLACE_NAME } = inst;
const FAKE = path.resolve(__dirname, '..', 'fake-claude-stateful.js');
const REAL_BUNDLE = fs.realpathSync(path.resolve(__dirname, '..', '..', '..', '..'));
const BUNDLE_VERSION = JSON.parse(fs.readFileSync(path.join(REAL_BUNDLE, 'package.json'), 'utf8')).version;

let pass = 0; let fail = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ✓ ${name}\n`); pass += 1; }
  catch (e) { process.stdout.write(`  ✗ ${name}\n      ${e.message}\n`); fail += 1; }
}
process.stdout.write('tpm-consumer-doctor.test.js\n');

const mkTmp = () => mkScratch('tpm-doctor-test');
const MROW = (p) => [{ name: MARKETPLACE_NAME, source: 'directory', path: p }];
const REC = (dir, over) => [Object.assign({ id: PLUGIN_ID, scope: 'project', enabled: true, installPath: REAL_BUNDLE, projectPath: dir }, over || {})];

// A consumer project. nm: 'link' (symlink to this bundle), 'none', or { version, hooks } (a pruned real copy).
function project(o) {
  o = o || {};
  const dir = mkTmp();
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', optionalDependencies: { [TPM_PKG_NAME]: 'file:../x' } }));
  const scope = path.join(dir, 'node_modules', '@codercowboy');
  if (o.nm === 'none') { /* no node_modules copy */ }
  else if (!o.nm || o.nm === 'link') { fs.mkdirSync(scope, { recursive: true }); fs.symlinkSync(REAL_BUNDLE, path.join(scope, 'claude-tpm')); }
  else {
    const c = path.join(scope, 'claude-tpm'); fs.mkdirSync(path.join(c, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(c, 'package.json'), JSON.stringify({ name: TPM_PKG_NAME, version: o.nm.version }));
    if (o.nm.hooks !== undefined) fs.writeFileSync(path.join(c, 'hooks', 'hooks.json'), typeof o.nm.hooks === 'string' ? o.nm.hooks : JSON.stringify(o.nm.hooks));
  }
  if (o.marker !== false) fs.mkdirSync(path.join(dir, '.claude', 'claude-tpm'), { recursive: true });
  if (o.settings) { fs.mkdirSync(path.join(dir, '.claude'), { recursive: true }); fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify(o.settings)); }
  return dir;
}
const HOOK = (e, name) => ({ [e]: [{ hooks: [{ type: 'command', command: `node "\${CLAUDE_PLUGIN_ROOT}/tools/tpm.js" hooks ${name}` }] }] });
const HOOKS_BOTH = { hooks: Object.assign({}, HOOK('SessionStart', 'session-start'), HOOK('PreToolUse', 'gate-spawn')) };

// Run the doctor against a fake world. o: { marketplaces, records, env (extra), tpmDirs (dirs put before the
// rest of PATH, in order) }. Also asserts the every-fail/warn-has-a-fix rule on the output.
function doctor(dir, o) {
  o = o || {};
  const work = mkTmp();
  const shim = path.join(work, 'claude'); fs.copyFileSync(FAKE, shim); fs.chmodSync(shim, 0o755);
  const statePath = path.join(work, 'state.json'); const logPath = path.join(work, 'calls.jsonl');
  fs.writeFileSync(statePath, JSON.stringify({ marketplaces: o.marketplaces || [], records: o.records || [] }));
  const home = path.join(work, 'home'); fs.mkdirSync(home);
  const env = Object.assign({}, process.env);
  delete env.TPM_PROJECT_ROOT; delete env.TPM_HOME;
  Object.assign(env, { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), FAKE_CLAUDE_STATE: statePath, FAKE_CLAUDE_LOG: logPath });
  // PATH: the fake claude first, then any caller dirs, then ONLY node's own dir (so no stray `tpm` on the host PATH).
  env.PATH = [work].concat(o.tpmDirs || [], [path.dirname(process.execPath)]).join(path.delimiter);
  Object.assign(env, o.env || {});
  const r = spawnSync(process.execPath, [TOOL, dir, '--check'], { encoding: 'utf8', env, timeout: 30000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const lines = out.split('\n');
  lines.forEach((l, i) => {
    if (/^\s+[⚠✗] /.test(l)) assert.ok(/^\s+fix: \S/.test(lines[i + 1] || ''), `no fix line under: ${l}\n${out}`);
    // 5.6: ✓ / · rows never carry a fix line
    if (/^\s+[✓·] /.test(l)) assert.ok(!/^\s+fix:/.test(lines[i + 1] || ''), `unexpected fix under: ${l}\n${out}`);
  });
  const calls = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { status: r.status, out, calls, line: (re) => lines.find((l) => re.test(l)) };
}

// ── baseline ────────────────────────────────────────────────────────────────────────────────────────
check('baseline: correct world → every row PASS/INFO, no WARN/FAIL, exit 0; the fake claude is the only claude run', () => {
  const dir = project();
  const r = doctor(dir, { marketplaces: MROW(REAL_BUNDLE), records: REC(dir) });
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(!/^\s+[⚠✗] /m.test(r.out), r.out);
  assert.ok(/Summary: \d+ ok · 0 warnings · 0 problems/.test(r.out), 'summary line: ' + r.out);
  assert.ok(r.calls.length > 0, 'the shim was actually exercised (not the real claude)');
});

// ── row: marketplace source is the canonical folder and exists ────────────────────────────────────────
check('source row: registered path resolves to this bundle → PASS', () => {
  const dir = project();
  const r = doctor(dir, { marketplaces: MROW(REAL_BUNDLE), records: REC(dir) });
  assert.ok(/✓ marketplace source\s+this bundle's folder/.test(r.out), r.out);
});
check('source row: resolves to this bundle only via a SYMLINK path → WARN (healthy but fragile), exit 0', () => {
  const dir = project(); const link = path.join(mkTmp(), 'stored-link'); fs.symlinkSync(REAL_BUNDLE, link);
  const r = doctor(dir, { marketplaces: MROW(link), records: REC(dir) });
  assert.strictEqual(r.status, 0, r.out);
  const l = r.line(/⚠ marketplace source/);
  assert.ok(l && /healthy but fragile/.test(l) && l.indexOf(link) >= 0, r.out);
});
check('source row: resolves to a DIFFERENT live folder → WARN naming both, exit 0', () => {
  const dir = project(); const other = mkTmp();
  const r = doctor(dir, { marketplaces: MROW(other), records: REC(dir, { installPath: other }) });
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(!/^\s+✗ /m.test(r.out), r.out);
  const l = r.line(/⚠ marketplace source/);
  assert.ok(l && l.indexOf(fs.realpathSync(other)) >= 0 && l.indexOf(REAL_BUNDLE) >= 0, r.out);
});
check('source row: folder MISSING → FAIL saying moved or deleted + the misleading "cache-miss" name, with the fix', () => {
  const dir = project(); const gone = path.join(mkTmp(), 'gone');
  const r = doctor(dir, { marketplaces: MROW(gone), records: [] });
  assert.strictEqual(r.status, 1, r.out);
  const l = r.line(/✗ marketplace source/);
  assert.ok(l && /moved or deleted/.test(l) && /cache-miss/.test(l) && l.indexOf(gone) >= 0, r.out);
  assert.ok(/fix: run `npx tpm install \.`/.test(r.out), r.out);
});

// ── row: hooks (SessionStart + gate-spawn) ───────────────────────────────────────────────────────────────
check('hooks row: both hooks declared → PASS', () => {
  const dir = project({ nm: { version: BUNDLE_VERSION, hooks: HOOKS_BOTH } });
  const r = doctor(dir, { marketplaces: MROW(REAL_BUNDLE), records: REC(dir) });
  assert.ok(/✓ plugin hooks\s+session-start \+ gate-spawn/.test(r.out), r.out);
});
check('hooks row: missing SessionStart → FAIL naming session-start only', () => {
  const dir = project({ nm: { version: BUNDLE_VERSION, hooks: { hooks: HOOK('PreToolUse', 'gate-spawn') } } });
  const r = doctor(dir, { marketplaces: MROW(REAL_BUNDLE), records: REC(dir) });
  const l = r.line(/✗ plugin hooks/);
  assert.ok(l && /missing: session-start/.test(l) && !/gate-spawn \(/.test(l), r.out);
});
check('hooks row: missing gate-spawn → FAIL naming gate-spawn only', () => {
  const dir = project({ nm: { version: BUNDLE_VERSION, hooks: { hooks: HOOK('SessionStart', 'session-start') } } });
  const r = doctor(dir, { marketplaces: MROW(REAL_BUNDLE), records: REC(dir) });
  const l = r.line(/✗ plugin hooks/);
  assert.ok(l && /missing: gate-spawn/.test(l) && !/session-start \(/.test(l), r.out);
});
check('hooks row: unparseable hooks.json → FAIL "invalid JSON"; absent hooks.json → FAIL "no hooks/hooks.json"', () => {
  const a = doctor(project({ nm: { version: BUNDLE_VERSION, hooks: '{nope' } }), { marketplaces: MROW(REAL_BUNDLE) });
  assert.ok(/✗ plugin hooks.*invalid JSON/.test(a.out), a.out);
  const b = doctor(project({ nm: { version: BUNDLE_VERSION } }), { marketplaces: MROW(REAL_BUNDLE) });
  assert.ok(/✗ plugin hooks.*no hooks\/hooks\.json/.test(b.out), b.out);
});
check('bundleHooksHealth: EVERY return path carries the full shape incl. sessionStart (no manifest / parse error / ok)', () => {
  const keys = (o) => Object.keys(o).sort().join(',');
  const want = 'error,gateSpawn,present,sessionStart';
  const none = inst.bundleHooksHealth(mkTmp());
  assert.strictEqual(keys(none), want); assert.strictEqual(none.sessionStart, false);
  const bad = inst.bundleHooksHealth(project({ nm: { version: '1.0.0', hooks: '{nope' } }));
  assert.strictEqual(keys(bad), want); assert.strictEqual(bad.sessionStart, false); assert.ok(bad.error);
  const good = inst.bundleHooksHealth(project({ nm: { version: '1.0.0', hooks: HOOKS_BOTH } }));
  assert.strictEqual(keys(good), want); assert.strictEqual(good.sessionStart, true); assert.strictEqual(good.gateSpawn, true);
});
check('hooks row: no node_modules copy → checks THIS bundle\'s hooks (the shipped hooks.json declares both) → PASS', () => {
  const r = doctor(project({ nm: 'none' }), { marketplaces: MROW(REAL_BUNDLE), records: REC('/x') });
  assert.ok(/✓ plugin hooks/.test(r.out), r.out);
});

// ── row: version agreement ───────────────────────────────────────────────────────────────────────────────
check('version row: plugin bundle vs node_modules copy mismatch → WARN naming both versions (exit 0)', () => {
  const dir = project({ nm: { version: '0.0.1-old', hooks: HOOKS_BOTH } });
  const r = doctor(dir, { marketplaces: MROW(REAL_BUNDLE), records: REC(dir) });
  assert.strictEqual(r.status, 0, r.out);
  const l = r.line(/⚠ bundle version/);
  assert.ok(l && l.indexOf(BUNDLE_VERSION) >= 0 && l.indexOf('0.0.1-old') >= 0, r.out);
});
check('version row: equal versions → PASS; no node_modules copy → skipped PASS', () => {
  const a = doctor(project({ nm: { version: BUNDLE_VERSION, hooks: HOOKS_BOTH } }), { marketplaces: MROW(REAL_BUNDLE) });
  assert.ok(/✓ bundle version/.test(a.out), a.out);
  const b = doctor(project({ nm: 'none' }), { marketplaces: MROW(REAL_BUNDLE) });
  assert.ok(/· bundle version.*skipped/.test(b.out), b.out);
});

// ── row: install record missing but the plugin still loads ──────────────────────────────────────────────
check('record row: enabled in project settings + marketplace registered + NO install record → WARN (not FAIL), fix re-run install; exit 0', () => {
  const dir = project({ settings: { enabledPlugins: { [PLUGIN_ID]: true } } });
  const r = doctor(dir, { marketplaces: MROW(REAL_BUNDLE), records: [] });
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(/⚠ plugin install record/.test(r.out), r.out);
  assert.ok(!/^\s+✗ /m.test(r.out), r.out);
  assert.ok(/fix: re-run `npx tpm install \.` to restore the record/.test(r.out), r.out);
  assert.ok(/✓ plugin enablement/.test(r.out), r.out);
});
check('record row: no record AND not enabled in settings → still FAIL', () => {
  const r = doctor(project(), { marketplaces: MROW(REAL_BUNDLE), records: [] });
  assert.strictEqual(r.status, 1, r.out);
  assert.ok(/✗ plugin install record/.test(r.out), r.out);
});
check('record row: no record, enabled in settings but marketplace NOT registered → FAIL (it would not load)', () => {
  const dir = project({ settings: { enabledPlugins: { [PLUGIN_ID]: true } } });
  const r = doctor(dir, { marketplaces: [], records: [] });
  assert.ok(/✗ plugin install record/.test(r.out), r.out);
});

// ── row: more than one claude-tpm@* enabled ──────────────────────────────────────────────────────────────
check('multi row: two claude-tpm@* enabled in the project → WARN naming both ("first silently wins")', () => {
  const dir = project({ settings: { enabledPlugins: { [PLUGIN_ID]: true, 'claude-tpm@claude-tpm-market-0.1.0': true } } });
  const r = doctor(dir, { marketplaces: MROW(REAL_BUNDLE), records: REC(dir) });
  const l = r.line(/⚠ enabled claude-tpm plugins/);
  assert.ok(l && l.indexOf(PLUGIN_ID) >= 0 && l.indexOf('claude-tpm@claude-tpm-market-0.1.0') >= 0 && /first silently wins/.test(l), r.out);
  assert.ok(/fix: disable the extras/.test(r.out), r.out);
});
check('multi row: a single enabled plugin → PASS; a DISABLED second one is not counted', () => {
  const dir = project({ settings: { enabledPlugins: { [PLUGIN_ID]: true, 'claude-tpm@other': false } } });
  const r = doctor(dir, { marketplaces: MROW(REAL_BUNDLE), records: REC(dir) });
  assert.ok(/✓ enabled claude-tpm plugins/.test(r.out), r.out);
});

// ── row: plugin enabled but project not installed ───────────────────────────────────────────────────────
check('project row: plugin enabled but NO .claude/claude-tpm/ → FAIL with fix `npx tpm install .`, exit 1', () => {
  const dir = project({ marker: false });
  const r = doctor(dir, { marketplaces: MROW(REAL_BUNDLE), records: REC(dir) });
  assert.strictEqual(r.status, 1, r.out);
  const l = r.line(/✗ project folder/);
  assert.ok(l && /plugin enabled but no \.claude\/claude-tpm\/ here/.test(l), r.out);
  assert.ok(/fix: run `npx tpm install \.` in this project/.test(r.out), r.out);
});
check('project row: marker present → PASS', () => {
  const dir = project();
  const r = doctor(dir, { marketplaces: MROW(REAL_BUNDLE), records: REC(dir) });
  assert.ok(/✓ project folder/.test(r.out), r.out);
});

// ── row: install-record path is informational ───────────────────────────────────────────────────────────
check('record-path row: a missing recorded path is INFO (never FAIL), says the cache isn\'t what runs; exit 0', () => {
  const dir = project(); const gone = path.join(mkTmp(), 'no-cache');
  const r = doctor(dir, { marketplaces: MROW(REAL_BUNDLE), records: REC(dir, { installPath: gone }) });
  assert.strictEqual(r.status, 0, r.out);
  const l = r.line(/· install-record path/);
  assert.ok(l && /runs from the registered marketplace folder/.test(l) && /harmless/.test(l) && l.indexOf(gone) >= 0, r.out);
  assert.ok(!/^\s+✗ /m.test(r.out), r.out);
});

check('record-path row with a DEAD marketplace folder never claims the plugin runs from the registered folder (no contradiction with the ✗ source row)', () => {
  const dir = project(); const gone = path.join(mkTmp(), 'no-cache'); const deadFolder = path.join(mkTmp(), 'moved-away');
  const r = doctor(dir, { marketplaces: MROW(deadFolder), records: REC(dir, { installPath: gone }) });
  assert.ok(/✗ marketplace source/.test(r.out), 'the source row fails: ' + r.out);
  const l = r.line(/· install-record path/);
  assert.ok(l && l.indexOf(gone) >= 0 && /harmless/.test(l), r.out);
  assert.ok(!/runs from the registered marketplace folder/.test(l), 'must not contradict the ✗ source row: ' + l);
});

// ── row: `tpm` on PATH (in-session only) ─────────────────────────────────────────────────────────────────
function pathDirWithTpm(kind) {
  const d = mkTmp(); const p = path.join(d, 'tpm');
  if (kind === 'plugin') fs.symlinkSync(path.join(REAL_BUNDLE, 'bin', 'tpm'), p);
  else { fs.writeFileSync(p, '#!/bin/sh\necho shadow\n'); fs.chmodSync(p, 0o755); }
  return d;
}
const SESSION_ENV = { TPM_PROJECT_ROOT: '/placeholder-project-root' };
check('PATH row: NOT in a session (no TPM_PROJECT_ROOT/TPM_HOME) → skipped with a note, even if a shadowing tpm is first on PATH', () => {
  const dir = project();
  const r = doctor(dir, { marketplaces: MROW(REAL_BUNDLE), records: REC(dir), tpmDirs: [pathDirWithTpm('shadow')] });
  assert.ok(/· tpm on PATH.*skipped/.test(r.out), r.out);
});
check('PATH row: in session, `tpm` resolves into this bundle\'s bin/ (via a symlink) → PASS', () => {
  const dir = project();
  const r = doctor(dir, { marketplaces: MROW(REAL_BUNDLE), records: REC(dir), tpmDirs: [pathDirWithTpm('plugin')], env: SESSION_ENV });
  assert.ok(/✓ tpm on PATH\s+resolves into the plugin bin\/ \(/.test(r.out), r.out);
});
check('PATH row: in session, a shadowing `tpm` first on PATH → WARN naming that file, exit 0', () => {
  const dir = project(); const shadowDir = pathDirWithTpm('shadow');
  const r = doctor(dir, { marketplaces: MROW(REAL_BUNDLE), records: REC(dir), tpmDirs: [shadowDir, pathDirWithTpm('plugin')], env: SESSION_ENV });
  assert.strictEqual(r.status, 0, r.out);
  const l = r.line(/⚠ tpm on PATH/);
  assert.ok(l && l.indexOf(path.join(shadowDir, 'tpm')) >= 0, r.out);
});
check('PATH row: in session, no `tpm` on PATH at all → WARN; TPM_HOME alone also counts as in-session', () => {
  const dir = project();
  const r = doctor(dir, { marketplaces: MROW(REAL_BUNDLE), records: REC(dir), env: { TPM_HOME: REAL_BUNDLE } });
  assert.ok(/⚠ tpm on PATH.*no `tpm` found/.test(r.out), r.out);
});
check('checkTpmOnPath (unit): fake PATH — shadow vs plugin, not-in-session', () => {
  const shadow = pathDirWithTpm('shadow'); const plug = pathDirWithTpm('plugin');
  const bin = path.join(REAL_BUNDLE, 'bin');
  assert.strictEqual(inst.checkTpmOnPath({}, [bin]).applicable, false);
  const a = inst.checkTpmOnPath({ TPM_HOME: 'x', PATH: [shadow, plug].join(path.delimiter) }, [bin]);
  assert.strictEqual(a.ok, false); assert.strictEqual(a.found, path.join(shadow, 'tpm'));
  const b = inst.checkTpmOnPath({ TPM_HOME: 'x', PATH: [plug, shadow].join(path.delimiter) }, [bin]);
  assert.strictEqual(b.ok, true);
});

// ── row: TPM_HOME vs self-location ───────────────────────────────────────────────────────────────────────
check('TPM_HOME row: set to a different folder → WARN naming both; set to this bundle (even via a symlink) → PASS; unset → no row', () => {
  const dir = project(); const other = mkTmp();
  const a = doctor(dir, { marketplaces: MROW(REAL_BUNDLE), records: REC(dir), env: { TPM_HOME: other } });
  assert.strictEqual(a.status, 0, a.out);
  const l = a.line(/⚠ TPM_HOME/);
  assert.ok(l && l.indexOf(other) >= 0 && /different folders/.test(l), a.out);
  const link = path.join(mkTmp(), 'home-link'); fs.symlinkSync(REAL_BUNDLE, link);
  const b = doctor(dir, { marketplaces: MROW(REAL_BUNDLE), records: REC(dir), env: { TPM_HOME: link } });
  assert.ok(/✓ TPM_HOME\s+same folder/.test(b.out), b.out);
  const c = doctor(dir, { marketplaces: MROW(REAL_BUNDLE), records: REC(dir) });
  assert.ok(!/^\s+[✓⚠✗·] TPM_HOME\b/m.test(c.out), c.out);
});

// ── every ✗/⚠ prints its fix: the broken-everything world (doctor() asserts the rule on every run) ──────
check('every FAIL/WARN prints a fix: a maximally broken world (no pkg dep, dead source, no marker, shadow tpm, bad TPM_HOME)', () => {
  const dir = mkTmp(); fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  const r = doctor(dir, { marketplaces: MROW(path.join(mkTmp(), 'gone')), records: [], env: { TPM_HOME: mkTmp() }, tpmDirs: [pathDirWithTpm('shadow')] });
  assert.strictEqual(r.status, 1, r.out);
  assert.ok((r.out.match(/^\s+✗ /gm) || []).length >= 3, r.out);
  assert.strictEqual((r.out.match(/^\s+fix: /gm) || []).length, (r.out.match(/^\s+[⚠✗] /gm) || []).length, r.out);
});
check('every FAIL prints a fix: no `claude` on PATH at all', () => {
  const dir = project(); const work = mkTmp();
  const env = Object.assign({}, process.env, { PATH: path.dirname(process.execPath), HOME: work });
  delete env.TPM_PROJECT_ROOT; delete env.TPM_HOME;
  const r = spawnSync(process.execPath, [TOOL, dir, '--check'], { encoding: 'utf8', env });
  const out = r.stdout + r.stderr; const lines = out.split('\n');
  assert.strictEqual(r.status, 1, out);
  lines.forEach((l, i) => { if (/^\s+✗ /.test(l)) assert.ok(/^\s+fix: \S/.test(lines[i + 1] || ''), 'no fix under ' + l); });
  assert.ok(/✗ marketplace\s+the `claude` CLI is not on PATH/.test(out), out);
});


// ── 5.6 output UX: one line per row, neutral labels, summary, no repeated source/real-copy rows ─────────
check('5.6 render: every row is ONE line (mark + label [+ message]); only ⚠/✗ rows have a fix: line; summary counts match', () => {
  const dir = project(); const other = mkTmp();
  const r = doctor(dir, { marketplaces: MROW(other), records: REC(dir, { installPath: other }), env: { TPM_HOME: mkTmp() } });
  const lines = r.out.split('\n').filter(Boolean);
  const rowLines = lines.filter((l) => /^\s+[✓⚠✗·] /.test(l));
  const fixLines = lines.filter((l) => /^\s+fix: /.test(l));
  const marks = (re) => rowLines.filter((l) => re.test(l)).length;
  assert.strictEqual(fixLines.length, marks(/^\s+[⚠✗] /), r.out);
  assert.strictEqual(lines.length, rowLines.length + fixLines.length + 1, 'nothing but rows, fixes and ONE summary line: ' + r.out);
  const m = r.out.match(/Summary: (\d+) ok · (\d+) warnings? · (\d+) problems?(?: · (\d+) skipped)?/);
  assert.ok(m, r.out);
  assert.strictEqual(Number(m[2]), marks(/^\s+⚠ /)); assert.strictEqual(Number(m[3]), marks(/^\s+✗ /));
  assert.strictEqual(Number(m[1]) + Number(m[2]) + Number(m[3]) + Number(m[4] || 0), rowLines.length);
});
check('5.6 render: summary pluralisation ("1 warning · 1 problem") on a world with exactly one ⚠ and one ✗', () => {
  const dir = project({ marker: false }); // ✗ project folder
  const link = path.join(mkTmp(), 'stored-link'); fs.symlinkSync(REAL_BUNDLE, link); // ⚠ source via symlink
  const r = doctor(dir, { marketplaces: MROW(link), records: REC(dir) });
  assert.ok(/Summary: \d+ ok · 1 warning · 1 problem\b/.test(r.out), r.out);
});
check('5.6 neutral labels: no label states the passing condition, on ✓, ⚠ and ✗ alike (source row keeps the same label in every state)', () => {
  const dir = project(); const other = mkTmp(); const gone = path.join(mkTmp(), 'gone');
  const link = path.join(mkTmp(), 'stored-link'); fs.symlinkSync(REAL_BUNDLE, link);
  for (const mp of [REAL_BUNDLE, link, other, gone]) {
    const r = doctor(dir, { marketplaces: MROW(mp), records: REC(dir) });
    assert.ok(r.line(/^\s+[✓⚠✗] marketplace source\s{2,}\S/), 'source label constant: ' + r.out);
    assert.ok(!/source resolves to this bundle/.test(r.out), r.out);
    assert.ok(!/ is NOT |installed as a dependency|declared as a dependency/.test(r.out), r.out);
  }
});
check('5.6 real-copy case: the source row and the real-copy row do not repeat each other (folder + verdict appear once; the source row points at the other)', () => {
  const dir = project(); const cp = path.join(mkTmp(), 'node_modules', '@codercowboy', 'claude-tpm');
  fs.mkdirSync(cp, { recursive: true }); fs.writeFileSync(path.join(cp, 'package.json'), JSON.stringify({ name: '@codercowboy/claude-tpm', version: BUNDLE_VERSION }));
  const r = doctor(dir, { marketplaces: MROW(cp), records: REC(dir, { installPath: cp }) });
  const src = r.line(/⚠ marketplace source/); const rc = r.line(/⚠ real copy in another project/);
  assert.ok(src && rc, r.out);
  assert.ok(/real-copy row below/.test(src), src);
  assert.ok(src.indexOf(fs.realpathSync(cp)) < 0, 'source row does not repeat the folder: ' + src);
  assert.ok(rc.indexOf(fs.realpathSync(cp)) >= 0 && /same version, files differ/.test(rc), rc);
  assert.strictEqual(r.status, 0, r.out);
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
