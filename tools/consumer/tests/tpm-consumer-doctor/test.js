#!/usr/bin/env node
/**
 * test.js — `tpm doctor` (tools/consumer/tpm-consumer-doctor.js): observe() + a renderer (phase 03 of the
 * installer-updates epic; design §9, voice §4.9). Replaces the suite of the retired 15-row `install --check`.
 *
 * Covers: the rows (default prints only ⚠/✗ + one summary line; `--verbose` prints every row); never-installed ⇒ ONE ✗ row;
 * the stamp-guard row (Q10); `complete` judged against the REGISTERED folder, else self (S17/S26); in-session rows only when
 * `env.inSession`; report-only (a byte-identical project tree, zero mutating `claude` calls); the bundle-folder refusal;
 * the `healthy-with-warnings` rule for a project on a `use`d registration (⚠ + `--repoint` fix, exit 0); the moved helper
 * exports (bundleHooksHealth / checkTpmOnPath); the CLI (`--verbose`, `--check` alias, unknown flag → 2, `install --check`
 * delegates); and the routers (`tpm doctor`, `tpm plugin doctor` → tpm-consumer-doctor.js).
 *
 * Hermetic: every world is the STATEFUL fake `claude` (tests/fake-claude-stateful.js, copied to <work>/claude and put FIRST on
 * PATH) with HOME / CLAUDE_CONFIG_DIR in scratch, so the real `claude`, the real plugin registry and ~/.claude are never reached.
 *
 * Usage: node tools/consumer/tests/tpm-consumer-doctor/test.js   → exit 0 all pass, 1 otherwise.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const W = require('../lib-observe-world');
const O = require('../../tpm-consumer-observe');
const V = require('../../tpm-consumer-voice');

const TOOL = path.resolve(__dirname, '..', '..', 'tpm-consumer-doctor.js');
const INSTALL = path.resolve(__dirname, '..', '..', 'tpm-consumer-install.js');
const TPM = path.resolve(__dirname, '..', '..', '..', 'tpm.js');
const doc = require(TOOL);
const inst = require(INSTALL);
const FAKE_CLAUDE_SHIM = path.resolve(__dirname, '..', 'fake-claude-stateful.js'); // (every world below copies this to PATH)
const REAL_BUNDLE = fs.realpathSync(path.resolve(__dirname, '..', '..', '..', '..'));

// Rendered paths are ~-shortened under HOME; point THIS process's HOME at the scratch root (a write, never a read of the real home).
Object.assign(process.env, { HOME: path.dirname(W.mk('home-root')) });

const NAME = 'claude-tpm-market-0.2.0-dev';
const ID = `claude-tpm@${NAME}`;
const row = (p, name) => ({ name: name || NAME, source: 'directory', path: p });
const rec = (dir, installPath, o) => Object.assign({ id: ID, version: '0.0.0', scope: 'project', enabled: true, installPath, projectPath: dir }, o || {});
const on = (...ids) => ({ enabledPlugins: Object.fromEntries(ids.map((i) => [i, true])) });
const isMut = (c) => (c.argv[1] === 'marketplace' && (c.argv[2] === 'add' || c.argv[2] === 'remove')) || ['install', 'enable', 'disable', 'uninstall'].indexOf(c.argv[1]) >= 0;

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

function snapshot(dir) {
  const out = {};
  (function walk(d, rel) {
    fs.readdirSync(d).sort().forEach((n) => {
      const p = path.join(d, n); const r = rel ? rel + '/' + n : n; const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[r] = 'link:' + fs.readlinkSync(p);
      else if (st.isDirectory()) { out[r + '/'] = 'dir'; walk(p, r); } else out[r] = fs.readFileSync(p, 'utf8');
    });
  })(dir, '');
  return out;
}

/** A converged project: S linked, registered, turned on, set up. o: {marker, settings, link, regPath, records, noReg, S} */
function good(o) {
  o = o || {};
  const S = o.S || W.standalone();
  const dir = W.project({ marker: o.marker === undefined ? 'config-valid' : o.marker, settings: o.settings !== undefined ? o.settings : on(ID), pkg: o.pkg });
  if (o.link !== false) W.nm(dir, o.link || S);
  const w = W.world({ marketplaces: o.noReg ? [] : [row(o.regPath ? o.regPath(S) : S)], records: o.records ? o.records(dir, S) : [rec(dir, S)], env: o.env, noClaude: o.noClaude });
  return { S, dir, w, self: S };
}

/** Run the doctor in-process. → {code, out, err, text, state, calls[], mut[]} */
async function doctor(f, flags, o) {
  o = o || {};
  let out = ''; let err = '';
  const c0 = f.w.calls().length;
  const opts = doc.parseArgs([f.dir].concat(flags || []));
  const code = await doc.runDoctor(opts, { out: (s) => { out += s; }, err: (s) => { err += s; }, env: Object.assign({}, f.w.env, o.env || {}), self: f.self });
  const calls = f.w.calls().slice(c0);
  const text = out + err;
  const bad = V.findNeverPrint(text);
  assert.deepStrictEqual(bad, [], 'never-print words in doctor output:\n' + text);
  return { code, out, err, text, calls: calls.map((c) => c.argv.join(' ')), mut: calls.filter(isMut).map((c) => c.argv.join(' ')) };
}
const lines = (t) => t.split('\n');
/** Every ⚠/✗ row is followed by an indented fix line; ✓/· rows never are. */
function assertFixRule(text) {
  const ls = lines(text);
  ls.forEach((l, i) => {
    if (/^\s+[⚠✗] /.test(l)) assert.ok(/^\s+fix: \S/.test(ls[i + 1] || '') || /^\s+fix: \S/.test(ls[i + 2] || ''), `no fix under: ${l}\n${text}`);
    if (/^\s+[✓·] /.test(l)) assert.ok(!/^\s+fix:/.test(ls[i + 1] || ''), `unexpected fix under: ${l}`);
  });
}
const flat = (t) => String(t).replace(/\n {2,}(?=[^\s$✓✗⚠·(\d])/g, ' ');

// ═══ default vs --verbose ═══════════════════════════════════════════════════════════════════════════════
test('healthy · default prints the header + ONE summary line (no rows); exit 0; exactly the 3 claude calls', async () => {
  const f = good();
  const r = await doctor(f);
  assert.strictEqual(r.code, 0, r.text);
  const body = lines(r.out).filter(Boolean);
  assert.strictEqual(body.length, 2, 'header + summary only:\n' + r.out);
  assert.ok(/^claude-tpm 0\.2\.0-dev → /.test(body[0]), body[0]);
  assert.ok(/^✓ \d+ checks ok\.$/.test(body[1]), body[1]);
  assert.ok(!/^[ \t]+[✓⚠✗·] /m.test(r.out), 'no rows by default');
  assert.deepStrictEqual(r.calls, ['--version', 'plugin marketplace list --json', 'plugin list --json']);
});
test('healthy · --verbose prints every row (✓) then the same summary; rows regroup to the layers a user can act on', async () => {
  const f = good();
  const r = await doctor(f, ['--verbose']);
  assert.strictEqual(r.code, 0, r.text);
  for (const label of ['package.json', 'registered', 'turned on', 'project folder', 'claude-tpm folder', 'claude']) {
    assert.ok(new RegExp(`^  ✓ ${label} +`, 'm').test(r.out), `row ${label}:\n${r.out}`);
  }
  assert.ok(!/tpm on PATH|TPM_HOME/.test(r.out), 'in-session rows are absent outside a Claude session');
  assert.ok(/^✓ \d+ checks ok\.$/m.test(r.out));
  const nRows = lines(r.out).filter((l) => /^  [✓⚠✗·] /.test(l)).length;
  assert.strictEqual(nRows, 6);
  assertFixRule(r.out);
});
test('unhealthy · default prints ONLY the ⚠/✗ rows with their fix lines, then a summary; exit 1 iff a ✗', async () => {
  const f = good({ marker: false });
  const r = await doctor(f);
  assert.strictEqual(r.code, 1, r.text);
  assert.ok(/^  ✗ project folder +\.claude\/claude-tpm\/ is missing/m.test(r.out), r.out);
  assert.ok(!/^  ✓ /m.test(r.out), 'passing rows are hidden by default:\n' + r.out);
  assert.ok(/^✗ \d+ checks? ok, 1 problem\.$/m.test(r.out), r.out);
  assertFixRule(r.text);
  const v = await doctor(f, ['--verbose']);
  assert.ok(/^  ✓ package\.json /m.test(v.out) && /^  ✗ project folder /m.test(v.out), v.out);
  assertFixRule(v.text);
});
test('warning only · exit 0, summary says ⚠ with the warning count', async () => {
  const f = good({ regPath: (S) => { const L = path.join(W.mk('lnk'), 'reg-link'); fs.symlinkSync(S, L); return L; } });
  const r = await doctor(f);
  assert.strictEqual(r.code, 0, r.text);
  assert.ok(/^  ⚠ registered +registered through a link/m.test(flat(r.out)), r.out);
  assert.ok(/fix: register the real folder: `tpm install \. --repoint`/.test(r.out));
  assert.ok(/^⚠ \d+ checks? ok, 1 warning\.$/m.test(r.out), r.out);
});
test('old copy · package.json points at an older version → ⚠ with a `tpm install .` fix (report-only; the old copy is never blamed on the bundle)', async () => {
  const S = W.standalone(); const Old = W.standalone({ version: '0.1.0', name: 'claude-tpm-market-0.1.0' });
  const f = good({ S, link: Old });
  const r = await doctor(f);
  assert.strictEqual(r.code, 0, r.text);
  assert.ok(/^  ⚠ package\.json +points at claude-tpm 0\.1\.0 /m.test(flat(r.out)), r.out);
  assert.ok(/fix: run `tpm install \.` to upgrade/.test(r.out));
  assert.ok(!/✗ claude-tpm folder/.test(r.out));
});

// ═══ never installed ═════════════════════════════════════════════════════════════════════════════════════
test('never installed · ONE ✗ row (default and --verbose alike), exit 1, the fix says `tpm install .`', async () => {
  const S = W.standalone(); const dir = W.project({ pkg: null });
  const f = { S, dir, w: W.world(), self: S };
  for (const flags of [[], ['--verbose']]) {
    const r = await doctor(f, flags);
    assert.strictEqual(r.code, 1, r.text);
    const rows = lines(r.out).filter((l) => /^  [✓⚠✗·] /.test(l));
    assert.strictEqual(rows.length, 1, r.out);
    assert.ok(/^  ✗ registered +claude-tpm is not installed here/.test(rows[0]), rows[0]);
    assert.ok(/fix: run `tpm install \.`/.test(r.out));
    assert.ok(/^✗ 0 checks ok, 1 problem\.$/m.test(r.out), r.out);
  }
});
test('no package.json / invalid package.json → a ✗ package.json row (the doctor reports it, it does not refuse)', async () => {
  const S = W.standalone();
  const pa = W.project({ pkg: false }); W.nm(pa, S);
  const a = await doctor({ S, dir: pa, w: W.world(), self: S });
  assert.strictEqual(a.code, 1); assert.ok(/✗ package\.json +not found/.test(a.out), a.out);
  const pb = W.project({ pkg: 'garbage' }); W.nm(pb, S);
  const b = await doctor({ S, dir: pb, w: W.world(), self: S });
  assert.strictEqual(b.code, 1); assert.ok(/✗ package\.json +is not valid JSON/.test(b.out), b.out);
});
test('claude missing → a ✗ claude row (and the doctor still reports the file-only rows); exit 1', async () => {
  const f = good({ noClaude: true });
  const r = await doctor(f);
  assert.strictEqual(r.code, 1, r.text);
  assert.ok(/^  ✗ claude +the claude command is not on PATH/m.test(r.out), r.out);
  assertFixRule(r.text);
});

// ═══ the bundle-folder refusal ═══════════════════════════════════════════════════════════════════════════
test('refusal · run on a claude-tpm folder itself (standalone, and a node_modules copy) → "this is the claude-tpm folder, not a project.", exit 1, no rows', async () => {
  const S = W.standalone();
  const r1 = await doctor({ S, dir: S, w: W.world(), self: S });
  assert.strictEqual(r1.code, 1);
  assert.ok(/this is the claude-tpm folder, not a project\./.test(r1.err), r1.err);
  assert.strictEqual(r1.out, '', 'nothing on stdout: no rows, no summary');
  const proj = W.project({}); const C = W.nm(proj, null);
  const r2 = await doctor({ S, dir: C, w: W.world(), self: S });
  assert.strictEqual(r2.code, 1); assert.ok(/this is the claude-tpm folder, not a project\./.test(r2.err), r2.err);
  const here = spawnSync(process.execPath, [TOOL, REAL_BUNDLE], { encoding: 'utf8', env: Object.assign({}, W.world().env) });
  assert.strictEqual(here.status, 1); assert.ok(/this is the claude-tpm folder, not a project\./.test(here.stderr), here.stderr);
});

// ═══ stamp guard + self.complete vs the registered folder ════════════════════════════════════════════════
test('stamp guard (Q10) · a mislabelled claude-tpm folder → ✗ "claude-tpm folder … mislabelled", exit 1', async () => {
  const S = W.standalone({ version: '0.2.0', name: 'claude-tpm-market-0.1.0' });
  const f = good({ S });
  const r = await doctor(f, ['--verbose']);
  assert.strictEqual(r.code, 1, r.text);
  assert.ok(/^  ✗ claude-tpm folder +mislabelled — its version \(0\.2\.0\)/m.test(flat(r.out)), r.out);
  assertFixRule(r.text);
});
test('self.complete (S17/S26) · the REGISTERED folder is what is checked: registered folder incomplete → ✗ naming it, even when self is fine', async () => {
  const S = W.standalone(); const E = W.standalone({ hooks: false });
  const dir = W.project({ marker: 'config-valid', settings: on(ID) }); W.nm(dir, E);
  const f = { S, dir, w: W.world({ marketplaces: [row(E)], records: [rec(dir, E)] }), self: S };
  const r = await doctor(f);
  assert.strictEqual(r.code, 1, r.text);
  const l = lines(flat(r.out)).find((x) => /✗ claude-tpm folder/.test(x));
  assert.ok(l && /the registered folder .* is incomplete — missing hooks\/hooks\.json/.test(l), r.out);
});
test('self.complete (S17/S26) · an incomplete SELF is fine when the registered folder (which runs) is complete → ✓ naming the registered folder', async () => {
  const S = W.standalone({ hooks: false }); const E = W.standalone();
  const dir = W.project({ marker: 'config-valid', settings: on(ID) }); W.nm(dir, E);
  const f = { S, dir, w: W.world({ marketplaces: [row(E)], records: [rec(dir, E)] }), self: S };
  const r = await doctor(f, ['--verbose']);
  assert.ok(/^  ✓ claude-tpm folder +complete \(0\.2\.0-dev\), the registered folder /m.test(flat(r.out)), r.out);
  const none = await doctor({ S, dir, w: W.world({ marketplaces: [], records: [] }), self: S }, ['--verbose']);
  assert.ok(/✗ claude-tpm folder +incomplete — missing hooks\/hooks\.json/.test(flat(none.out)), 'no registration → self is checked:\n' + none.out);
});

// ═══ in-session rows ═════════════════════════════════════════════════════════════════════════════════════
test('in-session rows (tpm on PATH, TPM_HOME) appear ONLY when env.inSession; a TPM_HOME elsewhere is a ⚠ with a fix', async () => {
  const f = good();
  const out = await doctor(f, ['--verbose']);
  assert.ok(!/tpm on PATH/.test(out.out) && !/TPM_HOME/.test(out.out));
  const ins = await doctor(f, ['--verbose'], { env: { TPM_PROJECT_ROOT: f.dir, TPM_HOME: '/elsewhere/home' } });
  assert.ok(/^  [⚠✓] tpm on PATH /m.test(ins.out), ins.out);
  assert.ok(/^  ⚠ TPM_HOME +set to \/elsewhere\/home/m.test(flat(ins.out)), ins.out);
  assert.strictEqual(ins.code, 0, 'in-session rows are warnings, never ✗');
  assertFixRule(ins.text);
  const same = await doctor(f, ['--verbose'], { env: { TPM_PROJECT_ROOT: f.dir, TPM_HOME: f.S } });
  assert.ok(/^  ✓ TPM_HOME +this folder/m.test(same.out), same.out);
});

// ═══ report-only ═════════════════════════════════════════════════════════════════════════════════════════
test('report-only · across healthy / broken / never-installed projects: zero mutating claude calls, a byte-identical project tree', async () => {
  const fs_ = [good(), good({ marker: false }), { S: W.standalone(), dir: W.project({ pkg: null }), w: W.world(), self: null }];
  fs_[2].self = fs_[2].S;
  for (const f of fs_) {
    const snap = snapshot(f.dir);
    const r = await doctor(f, ['--verbose']);
    assert.deepStrictEqual(r.mut, [], 'mutating calls: ' + r.mut.join(' | '));
    assert.deepStrictEqual(snapshot(f.dir), snap, 'the project tree is untouched');
  }
});

// ═══ concern C: the healthy-with-warnings rule for a `use`d registration ═════════════════════════════════
test('use\'d registration (concern C) · a project on an elsewhere registration it chose to use → ⚠ registered-from + `--repoint` fix, exit 0, never a menu', async () => {
  const S = W.standalone(); const E = W.standalone();
  const dir = W.project({ marker: 'config-valid', settings: on(ID) }); W.nm(dir, E);
  const f = { S, dir, w: W.world({ marketplaces: [row(E)], records: [rec(dir, E)] }), self: S };
  const state = O.observe(f.dir, f.self, f.w.env);
  assert.strictEqual(state.reg.state, 'elsewhere');
  assert.strictEqual(inst.diagnose(state, {}).label, 'healthy-with-warnings', 'install treats it as settled');
  const r = await doctor(f);
  assert.strictEqual(r.code, 0, r.text);
  assert.ok(/^  ⚠ registered +registered from .* not from /m.test(flat(r.out)), r.out);
  assert.ok(/fix: run `tpm install \. --repoint`/.test(r.out), r.out);
  assert.ok(!/1\) |2\) |Proceed\?|re-point|\[1\/2\/3\]/i.test(r.out.replace(/--repoint/g, '')), 'no menu, no prompt:\n' + r.out);
  assert.ok(/^⚠ \d+ checks? ok, 1 warning\.$/m.test(r.out), r.out);
  const res = doc.renderDoctor(state, {});
  assert.strictEqual(res.verdict, 'healthy-with-warnings');
});
test('use\'d registration · a github registration with this project set up is also ⚠ (not ✗), exit 0, `--repoint` fix', async () => {
  const S = W.standalone();
  const dir = W.project({ marker: 'config-valid', settings: on(ID) }); W.nm(dir, S);
  const f = { S, dir, w: W.world({ marketplaces: [{ name: NAME, source: 'github', repo: 'codercowboy/claude-tpm' }], records: [rec(dir, S)] }), self: S };
  const r = await doctor(f);
  assert.strictEqual(r.code, 0, r.text);
  assert.ok(/^  ⚠ registered +registered from a GitHub source/m.test(flat(r.out)), r.out);
  assert.ok(/fix: run `tpm install \. --repoint`/.test(r.out));
});

// ═══ the exports moved from install.js ═══════════════════════════════════════════════════════════════════
test('moved exports · bundleHooksHealth carries the full shape on EVERY return path; checkTpmOnPath is in-session only; the identity constants resolve', () => {
  const keys = (o) => Object.keys(o).sort().join(',');
  const want = 'error,gateSpawn,present,sessionStart';
  const none = doc.bundleHooksHealth(W.mk('x'));
  assert.strictEqual(keys(none), want); assert.strictEqual(none.present, false);
  const bad = W.project({}); W.nm(bad, null, { hooks: 'garbage' });
  const b = doc.bundleHooksHealth(bad); assert.strictEqual(keys(b), want); assert.ok(b.present && b.error);
  const g = W.project({}); W.nm(g, null);
  assert.deepStrictEqual(doc.bundleHooksHealth(g), { present: true, error: null, gateSpawn: true, sessionStart: true });
  const bin = path.join(W.mk('bin'), 'b'); fs.mkdirSync(bin); const shadow = path.join(W.mk('sh'), 'b'); fs.mkdirSync(shadow);
  [bin, shadow].forEach((d) => { fs.writeFileSync(path.join(d, 'tpm'), '#!/bin/sh\n'); fs.chmodSync(path.join(d, 'tpm'), 0o755); });
  assert.strictEqual(doc.checkTpmOnPath({}, [bin]).applicable, false);
  const a = doc.checkTpmOnPath({ TPM_HOME: 'x', PATH: [shadow, bin].join(path.delimiter) }, [bin]);
  assert.ok(a.applicable && !a.ok, 'a different tpm first → not ok');
  const c = doc.checkTpmOnPath({ TPM_HOME: 'x', PATH: [bin, shadow].join(path.delimiter) }, [bin]);
  assert.ok(c.applicable && c.ok);
  assert.strictEqual(doc.TPM_PKG_NAME, '@codercowboy/claude-tpm');
  assert.ok(/^claude-tpm@claude-tpm-market-/.test(doc.PLUGIN_ID) && /^claude-tpm-market-/.test(doc.MARKETPLACE_NAME));
});
test('install.js no longer carries the legacy doctor (runCheck + its row helpers are gone)', () => {
  ['runCheck', 'bundleHooksHealth', 'bundleHooksHealthAt', 'checkTpmOnPath', 'checkTpmHomeVsSelf'].forEach((k) => assert.strictEqual(inst[k], undefined, k));
  const src = fs.readFileSync(INSTALL, 'utf8');
  assert.ok(!/function runCheck|function renderRows/.test(src));
});

// ═══ the CLI + routers ═══════════════════════════════════════════════════════════════════════════════════
function realWorldProject() { // a project wired to THIS bundle (what a spawned doctor self-locates as its own folder)
  const dir = W.project({ marker: 'config-valid', settings: on(ID) }); W.nm(dir, REAL_BUNDLE);
  const w = W.world({ marketplaces: [row(REAL_BUNDLE)], records: [rec(dir, REAL_BUNDLE)] });
  return { dir, w };
}
const spawn = (args, env) => { const r = spawnSync(process.execPath, args, { encoding: 'utf8', env, timeout: 60000 }); return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '', stderr: r.stderr || '' }; };

test('CLI · `node tpm-consumer-doctor.js <dir>` exit codes + --verbose; --check is a compatibility alias; an unknown flag exits 2; -h prints help', () => {
  const { dir, w } = realWorldProject();
  const a = spawn([TOOL, dir], w.env);
  assert.strictEqual(a.status, 0, a.out); assert.ok(/^✓ \d+ checks ok\.$/m.test(a.out), a.out);
  const v = spawn([TOOL, dir, '--verbose'], w.env);
  assert.ok(/^  ✓ package\.json /m.test(v.out), v.out);
  const c = spawn([TOOL, dir, '--check'], w.env);
  assert.strictEqual(c.out, a.out, '--check ≡ no flag');
  assert.strictEqual(spawn([TOOL, dir, '--bogus'], w.env).status, 2);
  const h = spawn([TOOL, '-h'], w.env);
  assert.strictEqual(h.status, 0); assert.ok(/tpm doctor \[dir\]/.test(h.out) && /--verbose/.test(h.out));
  const broken = W.project({ pkg: false });
  assert.strictEqual(spawn([TOOL, broken], w.env).status, 1);
});
test('compat alias · `tpm-consumer-install.js <dir> --check` runs the NEW doctor (same output)', () => {
  const { dir, w } = realWorldProject();
  const a = spawn([TOOL, dir], w.env); const b = spawn([INSTALL, dir, '--check'], w.env);
  assert.strictEqual(b.status, a.status); assert.strictEqual(b.out, a.out);
  assert.ok(!/Step 1\/5/.test(b.out));
});
test('routers · `tpm doctor`, `tpm plugin doctor` and the script itself print the same thing; the tables point at tpm-consumer-doctor.js', () => {
  const { dir, w } = realWorldProject();
  const direct = spawn([TOOL, dir, '--verbose'], w.env);
  const flat1 = spawn([TPM, 'doctor', dir, '--verbose'], w.env);
  const plug = spawn([TPM, 'plugin', 'doctor', dir, '--verbose'], w.env);
  assert.strictEqual(direct.status, 0, direct.out);
  assert.deepStrictEqual([flat1.status, flat1.out], [direct.status, direct.out], '`tpm doctor` ≡ the doctor script');
  assert.deepStrictEqual([plug.status, plug.out], [direct.status, direct.out], '`tpm plugin doctor` ≡ the doctor script');
  const T = require(TPM); const R = require(path.resolve(path.dirname(TPM), 'plugin', 'tpm-plugin-router.js'));
  assert.strictEqual(T.ALIASES.doctor, 'consumer/tpm-consumer-doctor.js');
  assert.deepStrictEqual(T.ALIAS_EXTRA.doctor, undefined, 'no injected --check any more');
  assert.deepStrictEqual(R.VERBS.doctor, { script: '../consumer/tpm-consumer-doctor.js', extra: [] });
  const sick = W.project({ pkg: false });
  assert.strictEqual(spawn([TPM, 'doctor', sick], w.env).status, 1, 'exit code propagates');
});

// ── runner ───────────────────────────────────────────────────────────────────────────────────────────────
(async () => {
  process.stdout.write('tpm-consumer-doctor.test.js\n');
  let pass = 0; let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); process.stdout.write(`  ✓ ${name}\n`); pass += 1; }
    catch (e) { process.stdout.write(`  ✗ ${name}\n      ${String(e.message).split('\n').join('\n      ')}\n`); fail += 1; }
  }
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  void FAKE_CLAUDE_SHIM;
  process.exit(fail ? 1 : 0);
})();
