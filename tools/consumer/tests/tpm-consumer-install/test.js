#!/usr/bin/env node
/**
 * test.js — the `tpm install` STATE RECONCILER (phase 02 of the installer-updates epic).
 *
 * Covers design §13.2–13.6 against the shared observer + voice (imported, never copied):
 *   §13.2  one scenario per row of the §7 matrix (24 rows): the diagnosis LABEL, the exact ORDERED plan (action ids
 *          + rendered prose + `$` commands), the fake-CLI calls made under apply, the post-state, the exit code.
 *   §13.3  consent: decline at `Proceed?` and at the menu → zero mutating calls, zero file writes, `Nothing was changed.`
 *   §13.4  failure: fake CLI fails on action N → ✓ for 1..N-1, ✗ + stderr for N, `Stopped after N of M`, exit 1, and
 *          the NEXT run plans exactly the remainder (resumable); a "ran but did not take effect" verify failure too.
 *   §13.5  voice: every output of every run is checked against the never-print list by a STRICTER check than voice's
 *          own (see strictNeverPrint) — closes phase-01 concern #2.
 *   §13.6  probe count: a healthy run makes exactly 3 `claude` calls, AND memoization is genuinely guarded (a probe
 *          called twice → ONE spawn; goes red if the memo is disabled) — closes phase-01 concern #1.
 *   flags  §8: --plan --quiet --save --from --repoint --share --debug; --force / -y gone; unknown token → exit 2.
 *
 * Hermetic: the STATEFUL fake `claude` (tests/fake-claude-stateful.js) and a stateful fake `npm` (fake-npm-stateful.js)
 * are first on PATH in a scratch world (HOME/CLAUDE_CONFIG_DIR in scratch); `assertHermetic` proves neither real binary
 * is reachable. The pipeline runs IN-PROCESS (runInstall(opts, io) with scripted answers); a few cases spawn the CLI
 * to prove the wiring and exit codes.
 *
 * Usage: node tools/consumer/tests/tpm-consumer-install/test.js   → exit 0 all pass, 1 otherwise.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const W = require('../lib-observe-world');
const O = require('../../tpm-consumer-observe');
const V = require('../../tpm-consumer-voice');

const TOOL = path.resolve(__dirname, '..', '..', 'tpm-consumer-install.js');
const inst = require(TOOL);
const FAKE_NPM = path.resolve(__dirname, 'fake-npm-stateful.js');

// Scratch lives under a long os.tmpdir() path; the voice shortens paths under $HOME to `~/…` (and wraps >100 cols), so
// point THIS process's HOME at the scratch run dir: every fixture path then prints as `~/pj-xxxx/proj`, like a real
// user's. (The fake-claude/npm worlds carry their own HOME in env; this only affects voice's tilde().)
Object.assign(process.env, { HOME: path.dirname(W.mk('home-root')) }); // (a write to a scratch dir, never a read of the real home)

const NAME = 'claude-tpm-market-0.2.0-dev';
const ID = `claude-tpm@${NAME}`;
const OLD_ID = 'claude-tpm@claude-tpm-market'; // 0.1.0's bare id
const T = (p) => V.tilde(p);

// ── tiny runner (async-aware; sequential) ─────────────────────────────────────────────────────────────
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
let pass = 0; let fail = 0;

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────
function mkWorld(o) {
  const w = W.world(o);
  fs.copyFileSync(FAKE_NPM, path.join(w.work, 'npm')); fs.chmodSync(path.join(w.work, 'npm'), 0o755);
  w.env.NPM_LOG = path.join(w.work, 'npm.jsonl');
  if (!(o && o.noClaude)) W.assertHermetic(w);
  w.npmCalls = () => { try { return fs.readFileSync(w.env.NPM_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.argv[0] === 'install'); } catch (_e) { return []; } };
  return w;
}
const row = (p, name) => ({ name: name || NAME, source: 'directory', path: p });
const rec = (dir, installPath, o) => Object.assign({ id: ID, version: '0.0.0', scope: 'project', enabled: true, installPath, projectPath: dir }, o || {});
const on = (...ids) => ({ enabledPlugins: Object.fromEntries(ids.map((i) => [i, true])) });
const DEADDIR = () => path.join(W.mk('gone'), 'claude-tpm-folder'); // never created
const isMut = (c) => (c.argv[1] === 'marketplace' && (c.argv[2] === 'add' || c.argv[2] === 'remove')) || ['install', 'enable', 'disable', 'uninstall'].indexOf(c.argv[1]) >= 0;

/** Every file under dir → {rel: sha-ish (size+content)} so "zero file writes" can be asserted. */
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

// ── never-print: the STRICT check (phase-01 concern #2) ───────────────────────────────────────────────
// Voice's own findNeverPrint exempts ANY backticked span that starts with claude|npm|npx|tpm|node, so banned prose
// inside such a span would hide. This stricter check exempts a backticked span only when EVERY token is in a closed
// command vocabulary (or a path/spec/flag), `$ command` lines, the file name hooks/hooks.json, and — under a ✗ line —
// the child's own stderr, which is shown verbatim by design (voice §5) and is not our prose.
const CMD_TOKENS = new Set(['claude', 'npm', 'npx', 'tpm', 'node', 'plugin', 'marketplace', 'add', 'remove', 'list', 'install', 'enable', 'disable', 'uninstall', 'init', '--version', 'doctor', '-y', '.']);
function isCommandSpan(span) {
  const toks = span.trim().split(/\s+/);
  if (['claude', 'npm', 'npx', 'tpm', 'node'].indexOf(toks[0]) < 0) return false;
  return toks.every((t) => CMD_TOKENS.has(t) || /^--[a-z-]+$/.test(t) || /^(file:|\.{1,2}\/|\/|~)\S*$/.test(t));
}
function strictNeverPrint(text) {
  const out = []; let inChildBlock = false;
  String(text).split('\n').forEach((line) => {
    if (/^\s*\$ /.test(line)) { inChildBlock = false; return; }
    if (/^\s*✗ /.test(line)) inChildBlock = true;
    else if (inChildBlock && /^ {20,}\S/.test(line)) return; // the child's verbatim stderr
    else inChildBlock = false;
    const scrubbed = line.replace(/hooks\/hooks\.json/g, '').replace(/`([^`]*)`/g, (m, span) => (isCommandSpan(span) ? '' : m));
    V.NEVER_PRINT.forEach(([word, re]) => { if (re.test(scrubbed)) out.push({ word, line: line.trim() }); });
  });
  return out;
}
const OFFENCES = [];
/** Re-join lines the voice wrapped at 100 columns (continuations are indented deeper than their line). */
const flatErr = (t) => String(t).replace(/\n {4,}(?=\S)/g, ' '); // refusals have no `$` lines: join every indented continuation
const flat = (t) => String(t).replace(/\n {2,}(?=[^\s$✓✗⚠·(\d])/g, ' ');

// ── running the pipeline in-process ───────────────────────────────────────────────────────────────────
/** f = {dir, w, self}. o = {answers[], tty, env}. → {code, out, err, text, asked, calls(), mut[], npm[]} for THIS run only. */
async function run(f, argv, o) {
  o = o || {};
  const opts = inst.parseArgs([f.dir].concat(argv));
  let out = ''; let err = ''; const asked = []; const answers = (o.answers || []).slice();
  const c0 = f.w.calls().length; const n0 = f.w.npmCalls().length;
  const io = {
    out: (s) => { out += s; }, err: (s) => { err += s; },
    ask: async (p) => { asked.push(p); const a = answers.length ? answers.shift() : ''; out += p + a + '\n'; return a; },
    env: Object.assign({}, f.w.env, o.env || {}), stdinIsTTY: o.tty !== false, self: f.self,
  };
  const code = await inst.runInstall(opts, io);
  const calls = f.w.calls().slice(c0);
  const res = { code, out, err, text: out + err, asked, calls: calls.map((c) => c.argv.join(' ')),
    mut: calls.filter(isMut).map((c) => c.argv.join(' ')), npm: f.w.npmCalls().slice(n0).map((c) => c.argv.join(' ')) };
  const bad = strictNeverPrint(res.text);
  if (bad.length) OFFENCES.push({ argv, bad });
  return res;
}

/** Replace real paths with stable tokens (also their ~ form and quoted form) so expectations are readable. */
function norm(str, map) {
  let s = String(str);
  Object.keys(map).sort((a, b) => map[b].length - map[a].length).forEach((tok) => {
    const real = map[tok];
    [`'${real}'`, real, `'${T(real)}'`, T(real)].forEach((v) => { s = s.split(v).join(tok); });
  });
  return s.replace(/file:\S+/g, 'file:<REL>');
}

/** Parse the printed plan: numbered items (prose + `$` commands) and the extra lines (fine/Not touched/⚠). */
function parsePlan(text) {
  const items = []; const extras = []; let cur = null; let started = false; let last = null;
  for (const l of text.split('\n')) {
    if (/^I will:/.test(l)) { started = true; continue; }
    if (!started) continue;
    if (/^Proceed\?/.test(l) || l.trim() === '') break;
    let m;
    if ((m = /^ {2}(\d+)\. (.*)$/.exec(l))) { cur = { n: Number(m[1]), prose: m[2], cmds: [] }; items.push(cur); last = cur; continue; }
    if (/^\s*\$ /.test(l) && cur) { cur.cmds.push(l.trim().slice(2)); continue; }
    if (/^ {2}\(|^ {2}Not touched:|^ {2}⚠/.test(l)) { cur = null; last = { extra: l.trim() }; extras.push(last); continue; }
    if (last && last.extra !== undefined) last.extra += ' ' + l.trim(); else if (cur) cur.prose += ' ' + l.trim();
  }
  return { items, extras: extras.map((e) => e.extra) };
}

// ── prose catalogue (pinned literals; they must equal what the voice prints) ───────────────────────────
const P = {
  dep: 'Add claude-tpm to package.json as a dev dependency, so `npx tpm` works in this project',
  depUp: (old) => `Point package.json at claude-tpm 0.2.0-dev instead of ${old} (replaces the node_modules copy)`,
  depDangling: 'Point package.json at this folder (the old link is dangling)',
  register: (S) => `Register ${T(S)} with Claude Code, once for this machine`,
  registerOwn: "Register this project's copy of claude-tpm with Claude Code, once for this machine",
  repoint: (S) => `Re-point claude-tpm 0.2.0-dev at this folder (register ${T(S)} instead).`,
  install: 'Turn the plugin on for this project (writes one line to .claude/settings.json)',
  installAgain: 'Turn the plugin on for this project again',
  installRestore: "Restore Claude Code's note that the plugin is installed here",
  installUp: 'Turn the 0.2.0-dev plugin on for this project',
  enable: 'Turn the plugin on for this project (it is installed but switched off)',
  disable: (old) => `Turn the ${old} plugin off for this project — with both on, Claude Code would keep using ${old}`,
  seed: 'Write .claude/claude-tpm/config.json with the default task and session folders',
};

/**
 * One scenario path. f=build(); asserts the label + ids on a pre-run observe, then (1) a `--plan` run — exit 0, the
 * exact numbered prose, NO mutating calls, no prompt after the menu; (2) the real run with `argv`/`answers` — the
 * mutating fake-CLI calls (normalized), exit code, post-state via `post(f, r)`.
 */
async function scenarioPath(spec) {
  const f = spec.build();
  const R = (x) => (typeof x === 'function' ? x(f) : x);
  const st = O.observe(f.dir, f.self, f.w.env);
  const choice = spec.choice || null;
  const dx = inst.diagnose(st, {});
  assert.strictEqual(dx.label, spec.label, `diagnosis label: ${dx.label} !== ${spec.label}`);
  const pl = inst.plan(st, { choice, quiet: !!spec.quiet, save: false });
  assert.deepStrictEqual(pl.actions.map((a) => a.id), spec.ids, 'ordered action ids');
  const map = Object.assign({ '<DIR>': f.dir }, f.tokens || {});

  // (1) --plan: pre-answered through flags where a menu would appear → no prompt at all
  const pf = spec.planFlags || [];
  const p1 = await run(f, ['--plan'].concat(pf));
  assert.strictEqual(p1.code, 0, '--plan exits 0: ' + p1.text);
  assert.deepStrictEqual(p1.mut, [], '--plan makes no mutating call');
  assert.deepStrictEqual(p1.npm, [], '--plan runs no npm install');
  assert.ok(p1.asked.length === 0, '--plan with a pre-answer never prompts: ' + JSON.stringify(p1.asked));
  const parsed = parsePlan(p1.out);
  const prose = R(spec.prose);
  assert.deepStrictEqual(parsed.items.map((i, k) => i.prose.slice(0, prose[k].length)), prose, 'rendered prose (pinned)');
  assert.strictEqual(parsed.items.length, spec.ids.length);
  if (spec.cmds) assert.deepStrictEqual(parsed.items.map((i) => i.cmds.map((c) => norm(c, map))), R(spec.cmds), '$ command lines');
  (spec.extras || []).forEach((rx) => assert.ok(parsed.extras.some((e) => rx.test(e)), `plan extra ${rx} in ${JSON.stringify(parsed.extras)}`));
  (spec.planHas || []).forEach((rx) => assert.ok(rx.test(p1.out) || rx.test(flat(p1.out)), `--plan output has ${rx}\n${p1.out}`));
  assert.ok(!/Proceed\?/.test(p1.out), '--plan stops before the consent prompt');
  if (spec.planOnly) return { f, r: p1 };

  // (2) the real run
  const r = await run(f, spec.argv, { answers: spec.answers });
  assert.strictEqual(r.code, spec.exit === undefined ? 0 : spec.exit, `exit code (out:\n${r.text})`);
  assert.deepStrictEqual(r.mut.map((m) => norm(m, map)), R(spec.mut), 'mutating claude calls, in order');
  assert.strictEqual(r.npm.length, spec.npm === undefined ? (spec.ids.indexOf('dep') >= 0 ? 1 : 0) : spec.npm, 'npm install calls');
  if (spec.npmArgs) assert.deepStrictEqual(r.npm.map((c) => norm(c, map)), R(spec.npmArgs));
  (spec.has || []).forEach((rx) => assert.ok(rx.test(r.text) || rx.test(flat(r.text)), `output has ${rx}\n${r.text}`));
  (spec.hasNot || []).forEach((rx) => assert.ok(!rx.test(r.text) && !rx.test(flat(r.text)), `output must not have ${rx}\n${r.text}`));
  if (spec.post) await spec.post(f, r, map);
  return { f, r };
}

/** The tree is converged: observed fresh, diagnose says healthy*, and a re-run changes nothing and exits 0. */
async function converged(f, expectLabel) {
  const st = O.observe(f.dir, f.self, f.w.env);
  const dx = inst.diagnose(st, {});
  assert.strictEqual(dx.label, expectLabel || 'healthy', 'post-state label');
  const again = await run(f, ['--quiet']);
  assert.strictEqual(again.code, 0, again.text);
  assert.deepStrictEqual(again.mut, [], 'a converged project is left alone');
  assert.ok(/nothing to\s+do/.test(again.out), again.out);
  return st;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// §13.2 — the 24 scenario rows
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
const Q = ['--quiet'];
const CFG = '.claude/claude-tpm/config.json';
const ok = (st) => { assert.ok(st.dep.declared); assert.strictEqual(st.reg.state, 'same'); assert.ok(st.en.record.present && st.en.record.enabled); assert.deepStrictEqual(st.en.otherIds, []); assert.strictEqual(st.marker.config, 'valid'); };

function bFresh() { const S = W.standalone(); const dir = W.project({ pkg: null }); const w = mkWorld(); return { S, dir, w, self: S, tokens: { '<S>': S } }; }


function bFreshReg() { const f = bFresh(); f.w = mkWorld({ marketplaces: [row(f.S)] }); return f; }
function bVend(regRowFn) {
  const dir = W.project({}); const C = W.nm(dir, null); const E = regRowFn ? W.standalone() : null;
  const w = mkWorld(regRowFn ? { marketplaces: [row(E)] } : undefined);
  return { dir, w, self: C, C, E, tokens: { '<C>': C, '<E>': E || '<none>' } };
}
function bGood(o) { // everything at target (S linked, registered, turned on, set up) unless overridden
  o = o || {};
  const S = W.standalone(); const OTHER = o.other;
  const settings = o.settings !== undefined ? o.settings : on(ID);
  const dir = W.project({ marker: o.marker === undefined ? 'config-valid' : o.marker, settings });
  if (o.link !== false) W.nm(dir, o.link || S);
  const regPath = o.regPath ? o.regPath(S) : S;
  const records = o.records ? o.records(dir, S) : [rec(dir, S)];
  const w = mkWorld({ marketplaces: o.noReg ? [] : [row(regPath)], records });
  return { S, dir, w, self: S, tokens: { '<S>': S, '<DEAD>': o.dead || '<none>' }, OTHER };
}
function bUp(oldVer, oldName, oldId) {
  const S = W.standalone(); const Old = W.standalone({ version: oldVer, name: oldName });
  const dir = W.project({ settings: { enabledPlugins: { [oldId]: true }, extraKnownMarketplaces: { [oldName]: { source: { source: 'directory', path: Old } } } } });
  W.nm(dir, Old);
  const w = mkWorld({ marketplaces: [row(S)], records: [rec(dir, Old, { id: oldId })] });
  return { S, Old, dir, w, self: S, tokens: { '<S>': S, '<OLD>': Old } };
}
function bDead() {
  const S = W.standalone(); const DEAD = DEADDIR();
  const dir = W.project({ marker: 'config-valid', settings: on(ID) });
  W.nm(dir, path.join(W.mk('nolink'), 'nope')); // a dangling link
  const w = mkWorld({ marketplaces: [row(DEAD)], records: [rec(dir, DEAD)] });
  return { S, dir, w, self: S, tokens: { '<S>': S, '<DEAD>': DEAD } };
}
function bElse(kind) {
  const S = W.standalone(); const tokens = { '<S>': S }; let regRow; let dir;
  if (kind === 'standalone') { const E = W.standalone(); regRow = row(E); dir = W.project({ pkg: null }); tokens['<E>'] = E; }
  else if (kind === 'other-project-copy') { const projB = W.project({}); const E = W.nm(projB, null); regRow = row(E); dir = W.project({ pkg: null }); tokens['<E>'] = E; tokens['<PROJB>'] = projB; }
  else if (kind === 'this-project-copy') { dir = W.project({}); const E = W.nm(dir, null); regRow = row(E); tokens['<E>'] = E; }
  else { regRow = { name: NAME, source: 'github', repo: 'codercowboy/claude-tpm' }; dir = W.project({ pkg: null }); }
  return { S, dir, w: mkWorld({ marketplaces: [regRow] }), self: S, tokens };
}

const INSTALL_Q = `plugin install ${ID} --scope project -y`;
const NPM_DEV = 'install file:<REL> --save-dev --no-fund --no-audit';

// 1 ─ nothing anywhere
test('row 1 · L, nothing anywhere → not-installed · register, dep, plugin-install, config-seed (§4.5/§6 order)', async () => {
  const { f } = await scenarioPath({
    build: bFresh, label: 'not-installed', ids: ['register', 'dep', 'plugin-install', 'config-seed'], argv: Q, planFlags: Q,
    prose: (f) => [P.register(f.S), P.dep, P.install, P.seed],
    cmds: [['claude plugin marketplace add <S>'], ['npm ' + NPM_DEV], [`claude ${INSTALL_Q}`], []],
    extras: [/recorded as a dev dependency; pass --save for a regular one/],
    mut: ['plugin marketplace add <S>', INSTALL_Q], npmArgs: [NPM_DEV],
    has: [/^claude-tpm 0\.2\.0-dev → /m, /Checking .* claude-tpm is not installed here\./, /✓ package\.json +node_modules\/@codercowboy\/claude-tpm links to /, /✓ registered /, /✓ turned on /, /✓ config\.json +written/, /✓ claude-tpm 0\.2\.0-dev is installed in .* — \d+ checks ok\./, /Next: open `claude` in /],
    hasNot: [/Proceed\?/, /Nothing was changed/],
    post: async (f) => {
      ok(O.observe(f.dir, f.self, f.w.env));
      assert.strictEqual(fs.realpathSync(path.join(f.dir, 'node_modules/@codercowboy/claude-tpm')), f.S);
      assert.ok(JSON.parse(fs.readFileSync(path.join(f.dir, CFG), 'utf8')).tasks);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(f.dir, '.claude/settings.json'), 'utf8')).extraKnownMarketplaces, undefined, 'U2: the installer never writes extraKnownMarketplaces');
      await converged(f);
    },
  });
  void f;
});

// 2 ─ already registered, nothing in the project
test('row 2 · L, reg same, nothing in project → not-installed · dep, plugin-install, config-seed (+ already registered)', async () => {
  await scenarioPath({
    build: bFreshReg, label: 'not-installed', ids: ['dep', 'plugin-install', 'config-seed'], argv: Q, planFlags: Q,
    prose: [P.dep, P.install, P.seed],
    extras: [/already registered — nothing to do there/],
    mut: [INSTALL_Q],
    post: async (f) => { ok(O.observe(f.dir, f.self, f.w.env)); await converged(f); },
  });
});

// 3 ─ vendored (own copy), nothing yet
test('row 3 · V, own copy, nothing yet → not-installed · register(own copy), plugin-install, config-seed + fragility ⚠; NO npm (closes w2:15)', async () => {
  await scenarioPath({
    build: () => bVend(false), label: 'not-installed', ids: ['register', 'plugin-install', 'config-seed'], argv: Q, planFlags: Q,
    prose: [P.registerOwn, P.install, P.seed],
    cmds: [['claude plugin marketplace add <C>'], [`claude ${INSTALL_Q}`], []],
    extras: [/⚠ Registering a folder inside node_modules works.*rm -rf node_modules/],
    mut: ['plugin marketplace add <C>', INSTALL_Q], npm: 0,
    has: [/from this project's own copy in node_modules\)/],
    post: async (f) => { ok(O.observe(f.dir, f.self, f.w.env)); assert.deepStrictEqual(f.w.npmCalls(), [], 'no dep action in vendored mode'); await converged(f); },
  });
});

// 4 ─ healthy; the probe-count test (§13.6) lives here
test('row 4 · L, all at target → healthy · two lines, exit 0, no change, ≤3 claude calls (exactly 3)', async () => {
  const f = bGood(); const snap = snapshot(f.dir);
  const dx = inst.diagnose(O.observe(f.dir, f.self, f.w.env), {});
  assert.strictEqual(dx.label, 'healthy');
  const c0 = f.w.claudeCalls().length;
  const r = await run(f, Q);
  assert.strictEqual(r.code, 0, r.text);
  assert.deepStrictEqual(r.mut, []); assert.deepStrictEqual(r.npm, []);
  assert.deepStrictEqual(snapshot(f.dir), snap, 'a healthy run writes nothing');
  assert.deepStrictEqual(r.calls, ['--version', 'plugin marketplace list --json', 'plugin list --json'], 'a healthy run makes exactly the 3 claude calls: ' + r.calls.join(' | '));
  assert.ok(r.calls.length <= 3);
  void c0;
  const lines = r.out.split('\n').filter((l) => l.length && !/^\s/.test(l)); // (a >100-col line wraps with an indented continuation)
  assert.strictEqual(lines.length, 2, 'header + one line: ' + r.out);
  assert.ok(/^✓ claude-tpm 0\.2\.0-dev is already installed in .* and healthy — \d+ checks ok, nothing to\s+do\.$/.test(flat(r.out).split('\n').filter(Boolean)[1]), r.out);
});

// 5 ─ registered through a link
test('row 5 · L, target met, reg same-via-link → healthy-with-warnings · ⚠ + fix, exit 0, nothing planned', async () => {
  const f = bGood({ regPath: (S) => { const L = path.join(W.mk('lnk'), 'reg-link'); fs.symlinkSync(S, L); return L; } });
  const st = O.observe(f.dir, f.self, f.w.env);
  assert.strictEqual(st.reg.state, 'same-via-link');
  assert.strictEqual(inst.diagnose(st, {}).label, 'healthy-with-warnings');
  const r = await run(f, Q);
  assert.strictEqual(r.code, 0, r.text);
  assert.deepStrictEqual(r.mut, []);
  assert.ok(/^✓ claude-tpm 0\.2\.0-dev is already installed in .* 1 warning; nothing to do\.$/m.test(flat(r.out)), r.out);
  assert.ok(/⚠ registered +registered through a link/.test(r.out), r.out);
  assert.ok(/fix: register the real folder: `tpm install \. --repoint`/.test(r.out), r.out);
});

// 5b ─ same-via-link whose stored path is INSIDE node_modules → re-point to the canonical repo (session 0036)
test('row 5b · L, reg same-via-link stored INSIDE node_modules → partial · repoint:relink + plugin-install, registry flips to canonical', async () => {
  await scenarioPath({
    build: () => bGood({ regPath: (S) => { const nm = path.join(W.mk('reglink'), 'node_modules', '@codercowboy'); fs.mkdirSync(nm, { recursive: true }); const L = path.join(nm, 'claude-tpm'); fs.symlinkSync(S, L); return L; } }),
    label: 'partial', ids: ['repoint', 'plugin-install'], argv: Q, planFlags: Q,
    prose: () => ['Re-point claude-tpm 0.2.0-dev at ', P.installAgain],
    mut: [`plugin marketplace remove ${NAME}`, 'plugin marketplace add <S>', INSTALL_Q], npm: 0,
    planHas: [/registered through a node_modules link/],
    post: async (f) => {
      const st = O.observe(f.dir, f.self, f.w.env);
      ok(st); // reg.state === 'same' now (literal canonical), plugin enabled, config valid
      assert.strictEqual(st.reg.storedPath, f.S, 'the machine registry now names the canonical repo, not a node_modules path');
      await converged(f);
    },
  });
});

// 6, 7 ─ upgrades
test('row 6 · L, 0.1.0 project → upgrade · dep, plugin-install, disable-old, config-seed + Not touched (exit 0, was exit 1)', async () => {
  await scenarioPath({
    build: () => bUp('0.1.0', 'claude-tpm-market', OLD_ID), label: 'upgrade', ids: ['dep', 'plugin-install', 'disable-old', 'config-seed'], argv: Q, planFlags: Q,
    prose: [P.depUp('0.1.0'), P.installUp, P.disable('0.1.0'), P.seed],
    cmds: [['npm ' + NPM_DEV], [`claude ${INSTALL_Q}`], [`claude plugin disable ${OLD_ID} --scope project`], []],
    extras: [/already registered — nothing to do there/, /Not touched: the 0\.1\.0 folder, its registration and other projects that use it\./],
    mut: [INSTALL_Q, `plugin disable ${OLD_ID} --scope project`],
    has: [/Checking .* claude-tpm 0\.1\.0 is installed here\. This is an upgrade to 0\.2\.0-dev\./, /⚠ points at claude-tpm 0\.1\.0/, /✗ not turned on for /, /✓ turned off +0\.1\.0 for /, /\(upgraded from 0\.1\.0\)/, /Next: start a new `claude` session in /],
    post: async (f) => {
      ok(O.observe(f.dir, f.self, f.w.env));
      const s = JSON.parse(fs.readFileSync(path.join(f.dir, '.claude/settings.json'), 'utf8'));
      assert.strictEqual(s.enabledPlugins[OLD_ID], false); assert.strictEqual(s.enabledPlugins[ID], true);
      assert.ok(s.extraKnownMarketplaces && s.extraKnownMarketplaces['claude-tpm-market'], 'O1: extraKnownMarketplaces left alone');
      await converged(f);
    },
  });
});
test('row 7 · L, 0.2.0 project (…-market-0.2.0 id) → upgrade, same shape as row 6', async () => {
  const OLD7 = 'claude-tpm@claude-tpm-market-0.2.0';
  await scenarioPath({
    build: () => bUp('0.2.0', 'claude-tpm-market-0.2.0', OLD7), label: 'upgrade', ids: ['dep', 'plugin-install', 'disable-old', 'config-seed'], argv: Q, planFlags: Q,
    prose: [P.depUp('0.2.0'), P.installUp, P.disable('0.2.0'), P.seed],
    mut: [INSTALL_Q, `plugin disable ${OLD7} --scope project`],
    has: [/claude-tpm 0\.2\.0 is installed here\. This is an upgrade to 0\.2\.0-dev\./, /Not touched: the 0\.2\.0 folder/],
    post: async (f) => { ok(O.observe(f.dir, f.self, f.w.env)); await converged(f); },
  });
});

// 8 ─ dead registration
test('row 8 · L, reg dead + dep dangling + record → broken · repoint, dep, plugin-install — ONE confirmation', async () => {
  await scenarioPath({
    build: bDead, label: 'broken', ids: ['repoint', 'dep', 'plugin-install'], argv: [], answers: ['y'], planFlags: Q,
    prose: (f) => [P.repoint(f.S), P.depDangling, P.installAgain],
    cmds: [[`claude plugin marketplace remove ${NAME}`, 'claude plugin marketplace add <S>'], ['npm ' + NPM_DEV], [`claude ${INSTALL_Q}`]],
    mut: [`plugin marketplace remove ${NAME}`, 'plugin marketplace add <S>', `plugin install ${ID} --scope project`],
    has: [/Checking .* claude-tpm 0\.2\.0-dev is installed here but broken\./, /✗ registered from .*, and that folder is gone \(moved or deleted\)/,
      /Other projects on 0\.2\.0-dev start working again as soon as this runs/, /Proceed\? \[y\/N\] y/, /✓ re-pointed /],
    post: async (f, r) => { ok(O.observe(f.dir, f.self, f.w.env)); assert.deepStrictEqual(r.asked, [V.CONFIRM_PROMPT], 'asked exactly once'); await converged(f); },
  });
});

// 9–12, 19 ─ registered elsewhere (the decision phase), all four faces
const USE_NOTE = /Not touched: the existing registration and the other projects that use it\./;
test('row 9 · L, reg elsewhere (standalone) → menu · use: dep→that folder / re-point: repoint, dep→self', async () => {
  await scenarioPath({
    build: () => bElse('standalone'), label: 'registered-elsewhere', choice: 'use', ids: ['dep', 'plugin-install', 'config-seed'], argv: [], answers: ['1', 'y'], planFlags: ['--share'],
    prose: [P.dep, P.install, P.seed], extras: [USE_NOTE],
    mut: [`plugin install ${ID} --scope project`],
    has: [/Choose \[1\/2\/3\]: 1/, /\(a standalone folder\)/, /comparing the two copies …/, /Compared with this folder: same version, identical files\./, /1\. use +.* links to and runs that folder/, /Proceed\? \[y\/N\] y/],
    post: async (f, r) => {
      const st = O.observe(f.dir, f.self, f.w.env);
      assert.strictEqual(st.dep.linksTo, f.tokens['<E>'], 'N3: use → the dependency links to the folder in use');
      assert.strictEqual(st.reg.state, 'elsewhere'); assert.ok(st.en.record.present && st.en.record.enabled);
      assert.deepStrictEqual(r.asked, [V.MENU_PROMPT, V.CONFIRM_PROMPT]);
      await converged(f, 'healthy-with-warnings');
    },
  });
  await scenarioPath({
    build: () => bElse('standalone'), label: 'registered-elsewhere', choice: 'repoint', ids: ['repoint', 'dep', 'plugin-install', 'config-seed'], argv: Q.concat('--repoint'), planFlags: ['--repoint'],
    prose: (f) => [P.repoint(f.S), P.dep, P.install, P.seed],
    mut: [`plugin marketplace remove ${NAME}`, 'plugin marketplace add <S>', INSTALL_Q],
    post: async (f) => { ok(O.observe(f.dir, f.self, f.w.env)); assert.strictEqual(O.observe(f.dir, f.self, f.w.env).dep.linksTo, f.S); await converged(f); },
  });
});
test('row 10 · L, reg elsewhere (another project\'s copy) → menu · use: dep→self.root + two-trees ⚠ / re-point', async () => {
  await scenarioPath({
    build: () => bElse('other-project-copy'), label: 'registered-elsewhere', choice: 'use', ids: ['dep', 'plugin-install', 'config-seed'], argv: Q.concat('--share'), planFlags: ['--share'],
    prose: [P.dep, P.install, P.seed],
    extras: [/⚠ .* will run the copy in /, USE_NOTE],
    mut: [INSTALL_Q],
    has: [/\(a copy inside another project\)/],
    post: async (f) => {
      const st = O.observe(f.dir, f.self, f.w.env);
      assert.strictEqual(st.dep.linksTo, f.S, 'N3: never link into another project\'s node_modules');
      assert.ok(!/node_modules/.test(f.w.npmCalls().map((c) => c.argv.join(' ')).join(' ')), 'no file: spec inside a node_modules');
      assert.strictEqual(st.reg.where, 'other-project-copy');
    },
  });
  await scenarioPath({
    build: () => bElse('other-project-copy'), label: 'registered-elsewhere', choice: 'repoint', ids: ['repoint', 'dep', 'plugin-install', 'config-seed'], argv: Q.concat('--repoint'), planFlags: ['--repoint'],
    prose: (f) => [P.repoint(f.S), P.dep, P.install, P.seed],
    mut: [`plugin marketplace remove ${NAME}`, 'plugin marketplace add <S>', INSTALL_Q],
    post: async (f) => { ok(O.observe(f.dir, f.self, f.w.env)); await converged(f); },
  });
});
test('row 11 · L, reg points at THIS project\'s own copy → menu (own-copy wording) · use: no dep / re-point: repoint, dep…', async () => {
  await scenarioPath({
    build: () => bElse('this-project-copy'), label: 'registered-elsewhere', choice: 'use', ids: ['plugin-install', 'config-seed'], argv: [], answers: ['1', 'y'], planFlags: ['--share'],
    prose: [P.install, P.seed], npm: 0,
    mut: [`plugin install ${ID} --scope project`],
    has: [/\(this project's own copy\)/, /1\. use +.* keeps running its own copy; this folder is unused\./],
    post: async (f) => { assert.strictEqual(O.observe(f.dir, f.self, f.w.env).dep.onDisk, 'copy', 'the own copy stays'); },
  });
  await scenarioPath({
    build: () => bElse('this-project-copy'), label: 'registered-elsewhere', choice: 'repoint', ids: ['repoint', 'dep', 'plugin-install', 'config-seed'], argv: Q.concat('--repoint'), planFlags: ['--repoint'],
    prose: (f) => [P.repoint(f.S), P.dep, P.install, P.seed],
    mut: [`plugin marketplace remove ${NAME}`, 'plugin marketplace add <S>', INSTALL_Q],
    post: async (f) => { const st = O.observe(f.dir, f.self, f.w.env); ok(st); assert.strictEqual(st.dep.onDisk, 'link'); assert.strictEqual(st.dep.linksTo, f.S); await converged(f); },
  });
});
test('row 12 · L, reg github → menu (github wording, no compare line) · use: dep, plugin-install… / re-point', async () => {
  await scenarioPath({
    build: () => bElse('github'), label: 'registered-elsewhere', choice: 'use', ids: ['dep', 'plugin-install', 'config-seed'], argv: Q.concat('--share'), planFlags: ['--share'],
    prose: [P.dep, P.install, P.seed], planOnly: true,
  });
  await scenarioPath({
    build: () => bElse('github'), label: 'registered-elsewhere', choice: 'repoint', ids: ['repoint', 'dep', 'plugin-install', 'config-seed'], argv: Q.concat('--repoint'), planFlags: ['--repoint'],
    prose: (f) => [P.repoint(f.S), P.dep, P.install, P.seed],
    mut: [`plugin marketplace remove ${NAME}`, 'plugin marketplace add <S>', INSTALL_Q],
    post: async (f) => { ok(O.observe(f.dir, f.self, f.w.env)); await converged(f); },
  });
});
test('menu faces · all four reg.where faces + quit paths: second line, wording, compare line only for local folders', async () => {
  const faces = { standalone: /\(a standalone folder\)/, 'other-project-copy': /\(a copy inside another project\)/, 'this-project-copy': /\(this project's own copy\)/, github: /github:codercowboy\/claude-tpm {3}\(not a local folder\)/ };
  for (const kind of Object.keys(faces)) {
    const f = bElse(kind);
    const r = await run(f, [], { answers: ['3'] });
    assert.strictEqual(r.code, 1, r.text);
    const fo = flat(r.out);
    assert.ok(faces[kind].test(fo), kind + '\n' + r.out);
    assert.ok(/Checking .* claude-tpm 0\.2\.0-dev is already registered on this machine, from a different folder:/.test(fo), r.out);
    assert.strictEqual(/comparing the two copies/.test(fo), kind !== 'github', 'compare line only for a local folder: ' + kind);
    assert.strictEqual(/Compared with this folder:/.test(fo), kind !== 'github');
    assert.ok(/3\. quit +Nothing was changed\./.test(fo) && /Choose \[1\/2\/3\]: 3/.test(fo), r.out);
    assert.deepStrictEqual(r.asked, [V.MENU_PROMPT]);
    assert.deepStrictEqual(r.mut, []);
  }
  // differing copies: the compare line says how many files differ
  const f = bElse('other-project-copy'); fs.writeFileSync(path.join(f.tokens['<E>'], 'EXTRA.txt'), 'x');
  const r = await run(f, [], { answers: [''] });
  assert.ok(/Compared with this folder: same version, 1 file differs\./.test(flat(r.out)), r.out);
});
test('row 19 · V, reg points at a standalone folder → menu · use: nothing for dep / re-point: register own copy + fragility ⚠', async () => {
  await scenarioPath({
    build: () => bVend(true), label: 'registered-elsewhere', choice: 'use', ids: ['plugin-install', 'config-seed'], argv: Q.concat('--share'), planFlags: ['--share'],
    prose: [P.install, P.seed], npm: 0, mut: [INSTALL_Q],
    post: async (f) => { assert.strictEqual(O.observe(f.dir, f.self, f.w.env).dep.onDisk, 'copy'); },
  });
  await scenarioPath({
    build: () => bVend(true), label: 'registered-elsewhere', choice: 'repoint', ids: ['repoint', 'plugin-install', 'config-seed'], argv: Q.concat('--repoint'), planFlags: ['--repoint'],
    prose: (f) => [P.repoint(f.C), P.install, P.seed], npm: 0,
    extras: [/⚠ Registering a folder inside node_modules works/],
    mut: [`plugin marketplace remove ${NAME}`, 'plugin marketplace add <C>', INSTALL_Q],
    post: async (f) => { ok(O.observe(f.dir, f.self, f.w.env)); await converged(f); },
  });
});

// 13–18 ─ partial / broken shapes
test('row 13 · L, record present but disabled → partial · plugin-enable', async () => {
  await scenarioPath({
    build: () => bGood({ settings: { enabledPlugins: { [ID]: false } }, records: (dir, S) => [rec(dir, S, { enabled: false })] }),
    label: 'partial', ids: ['plugin-enable'], argv: Q, planFlags: Q,
    prose: [P.enable], cmds: [[`claude plugin enable ${ID} --scope project`]], extras: [/already registered — nothing to do there/],
    mut: [`plugin enable ${ID} --scope project`], npm: 0,
    has: [/Checking .* claude-tpm 0\.2\.0-dev is partly installed here\./, /✗ installed but switched off for /],
    post: async (f) => { ok(O.observe(f.dir, f.self, f.w.env)); await converged(f); },
  });
});
test('row 14 · L, no record, enabledHere, reg live → partial · plugin-install ("restore the note")', async () => {
  await scenarioPath({
    build: () => bGood({ records: () => [] }), label: 'partial', ids: ['plugin-install'], argv: Q, planFlags: Q,
    prose: [P.installRestore], mut: [INSTALL_Q], npm: 0,
    has: [/⚠ turned on for .*, but Claude Code has lost its note that the plugin is installed here/],
    post: async (f) => { ok(O.observe(f.dir, f.self, f.w.env)); await converged(f); },
  });
});
test('row 15 · L, no record, enabledHere, reg dead → broken · repoint, plugin-install (S11: "still loads" is false)', async () => {
  const DEAD = DEADDIR();
  await scenarioPath({
    build: () => bGood({ records: () => [], regPath: () => DEAD, dead: DEAD }), label: 'broken', ids: ['repoint', 'plugin-install'], argv: Q, planFlags: Q,
    prose: (f) => [P.repoint(f.S), P.installRestore],
    mut: [`plugin marketplace remove ${NAME}`, 'plugin marketplace add <S>', INSTALL_Q], npm: 0,
    post: async (f) => { ok(O.observe(f.dir, f.self, f.w.env)); await converged(f); },
  });
});
test('row 16 · L, enabled, marker missing → broken · config-seed only', async () => {
  await scenarioPath({
    build: () => bGood({ marker: false }), label: 'broken', ids: ['config-seed'], argv: Q, planFlags: Q,
    prose: [P.seed], cmds: [[]], mut: [], npm: 0,
    has: [/✗ .claude\/claude-tpm\/ is missing — the task and session tools refuse to run without it/],
    post: async (f) => { assert.ok(fs.existsSync(path.join(f.dir, CFG))); ok(O.observe(f.dir, f.self, f.w.env)); await converged(f); },
  });
});
test('row 17 · L, marker.config invalid → broken (✗ finding, never overwritten) · other actions still run, closing ✗ names the file, exit 1', async () => {
  const BAD = '{"version":';
  await scenarioPath({
    build: () => bGood({ marker: 'config-bad', records: () => [], settings: {} }), label: 'broken', ids: ['plugin-install'], argv: Q, planFlags: Q,
    prose: [P.install], mut: [INSTALL_Q], npm: 0, exit: 1,
    has: [/✗ project folder +\.claude\/claude-tpm\/config\.json is not valid JSON/, /fix: fix or delete \.claude\/claude-tpm\/config\.json/, /✗ The steps ran, but 1 check still fails \(see ✗ above\)\./],
    hasNot: [/Next:/],
    post: async (f) => { assert.strictEqual(fs.readFileSync(path.join(f.dir, CFG), 'utf8'), BAD, 'a user\'s file is never overwritten'); },
  });
  // nothing else to do: no plan, the ✗ is explained, exit 1, nothing changed
  const f = bGood({ marker: 'config-bad' }); const snap = snapshot(f.dir);
  const r = await run(f, Q);
  assert.strictEqual(r.code, 1, r.text);
  assert.deepStrictEqual(r.mut, []); assert.deepStrictEqual(snapshot(f.dir), snap);
  assert.ok(/✗ project folder +\.claude\/claude-tpm\/config\.json is not valid JSON/.test(r.out) && /Nothing was changed\./.test(r.out), r.out);
  assert.ok(!/I will:/.test(r.out) && !/healthy/.test(r.out), r.out);
});
test('row 18 · L, two claude-tpm ids on (by hand) → upgrade-shaped · disable-old for the extra', async () => {
  const OTHER = 'claude-tpm@claude-tpm-market-0.2.1';
  await scenarioPath({
    build: () => bGood({ settings: on(ID, OTHER), records: (dir, S) => [rec(dir, S), rec(dir, S, { id: OTHER })] }),
    label: 'upgrade', ids: ['disable-old'], argv: Q, planFlags: Q,
    prose: [P.disable('0.2.1')], mut: [`plugin disable ${OTHER} --scope project`], npm: 0,
    extras: [/Not touched: the 0\.2\.1 folder/], has: [/This is an upgrade to 0\.2\.0-dev\./, /\(upgraded from 0\.2\.1\)/],
    post: async (f) => { ok(O.observe(f.dir, f.self, f.w.env)); await converged(f); },
  });
});

// 20–24 ─ refusals, --plan, decline
test('row 20 · any, self.shape other-project-copy → REFUSED (exit 1, Nothing was changed, nothing written)', async () => {
  const projB = W.project({}); const C2 = W.nm(projB, null);
  const f = { dir: W.project({ pkg: null }), w: mkWorld(), self: C2 }; const snap = snapshot(f.dir);
  const r = await run(f, Q);
  assert.strictEqual(r.code, 1);
  assert.ok(/^error: not installing — this claude-tpm is .*'s copy \(/m.test(flatErr(r.err)) && /Run the install from a standalone folder/.test(flatErr(r.err)) && /Nothing was changed\./.test(r.err), r.err);
  assert.strictEqual(r.out, ''); assert.deepStrictEqual(r.mut, []); assert.deepStrictEqual(r.npm, []); assert.deepStrictEqual(snapshot(f.dir), snap);
});
test('row 21 · any, stamp guard fails → REFUSED (blames claude-tpm, not the project)', async () => {
  const S = W.standalone({ name: 'claude-tpm-market-9.9.9' });
  const f = { dir: W.project({ pkg: null }), w: mkWorld(), self: S };
  const r = await run(f, Q);
  assert.strictEqual(r.code, 1);
  assert.ok(/error: not installing — this claude-tpm folder is mislabelled .* a packaging problem in claude-tpm, not in your project\./.test(flat(r.err)) && /Nothing was changed\./.test(r.err), r.err);
  assert.deepStrictEqual(r.mut, []);
});
test('row 22 · any, non-TTY without --quiet → REFUSED with the --quiet hint; --plan and --quiet still run', async () => {
  const f = bFresh();
  const r = await run(f, [], { tty: false });
  assert.strictEqual(r.code, 1);
  assert.ok(/error: not installing — stdin is not a terminal — pass `--quiet` to accept the plan without prompts\./.test(r.err) && /Nothing was changed\./.test(r.err), r.err);
  assert.deepStrictEqual(r.mut, []); assert.deepStrictEqual(r.npm, []);
  const p = await run(f, ['--plan'], { tty: false });
  assert.strictEqual(p.code, 0, p.text); assert.ok(/I will:/.test(p.out));
  const q = await run(f, Q, { tty: false });
  assert.strictEqual(q.code, 0, q.text);
});
test('row 23 · any, --plan → diagnosis + plan, exit 0, nothing changed, no prompt', async () => {
  const f = bFresh(); const snap = snapshot(f.dir);
  const r = await run(f, ['--plan']);
  assert.strictEqual(r.code, 0); assert.deepStrictEqual(r.asked, []);
  assert.ok(/Checking .* claude-tpm is not installed here\./.test(r.out) && /I will:/.test(r.out), r.out);
  assert.ok(!/Proceed\?/.test(r.out) && !/✓ /.test(r.out), r.out);
  assert.deepStrictEqual(r.mut, []); assert.deepStrictEqual(r.npm, []); assert.deepStrictEqual(snapshot(f.dir), snap);
  assert.deepStrictEqual(r.calls, ['--version', 'plugin marketplace list --json', 'plugin list --json'], '--plan observes once and does nothing else');
});
test('row 24 · any, Proceed? → n → "Nothing was changed.", exit 1, zero mutations, zero writes (#1142 A regression)', async () => {
  for (const ans of ['n', '', 'no', 'maybe', 'yep']) {
    const f = bFresh(); const snap = snapshot(f.dir);
    const r = await run(f, [], { answers: [ans] });
    assert.strictEqual(r.code, 1, `answer ${JSON.stringify(ans)}: ${r.text}`);
    assert.ok(/^ {2}Nothing was changed\.$/m.test(r.out), r.out);
    assert.deepStrictEqual(r.mut, []); assert.deepStrictEqual(r.npm, []);
    assert.deepStrictEqual(snapshot(f.dir), snap, 'zero file writes: the dependency is NOT written before consent');
    assert.deepStrictEqual(r.asked, [V.CONFIRM_PROMPT]);
    assert.ok(!/✓ /.test(r.out));
  }
  const f = bFresh(); // y / yes / Y / YES all consent (case-insensitive)
  const r = await run(f, [], { answers: ['YES'] });
  assert.strictEqual(r.code, 0, r.text);
  assert.ok(r.mut.indexOf(`plugin install ${ID} --scope project`) >= 0, 'interactive run does not pass -y: ' + r.mut.join('|'));
});

test('diagnose · precedence (§4.3): registered-elsewhere beats upgrade; upgrade beats broken; not-installed beats dead; all 7 labels exist', () => {
  assert.deepStrictEqual(inst.LABELS, ['registered-elsewhere', 'not-installed', 'upgrade', 'broken', 'partial', 'healthy', 'healthy-with-warnings']);
  // an upgrade-shaped project whose registration is ALSO elsewhere → the menu label wins
  const u = bUp('0.1.0', 'claude-tpm-market', OLD_ID); const E = W.standalone();
  const uw = mkWorld({ marketplaces: [row(E)], records: [rec(u.dir, u.Old, { id: OLD_ID })] });
  assert.strictEqual(inst.diagnose(O.observe(u.dir, u.self, uw.env), {}).label, 'registered-elsewhere');
  // upgrade + broken (dead registration for our name AND the 0.1.0 id on): the sentence says upgrade, the ✗ findings list the breakage
  const b = bUp('0.1.0', 'claude-tpm-market', OLD_ID); const DEAD = DEADDIR();
  const bw = mkWorld({ marketplaces: [row(DEAD)], records: [rec(b.dir, b.Old, { id: OLD_ID })] });
  const dx = inst.diagnose(O.observe(b.dir, b.self, bw.env), {});
  assert.strictEqual(dx.label, 'upgrade'); assert.ok(dx.findings.some((x) => x.mark === 'fail' && /gone/.test(x.text)), JSON.stringify(dx.findings));
  // a dead registration with NOTHING of ours in the project is still just "not installed" (the plan carries the re-point)
  const n = W.project({ pkg: null }); const nw = mkWorld({ marketplaces: [row(DEADDIR())] }); const S = W.standalone();
  const nd = inst.diagnose(O.observe(n, S, nw.env), {});
  assert.strictEqual(nd.label, 'not-installed'); assert.deepStrictEqual(nd.actions.map((a) => a.id), ['repoint', 'dep', 'plugin-install', 'config-seed']);
  assert.deepStrictEqual(nd.findings, [], 'not-installed prints no findings');
});
test('diagnose · registered elsewhere but already set up to use it → healthy-with-warnings (the menu is not re-asked every run)', async () => {
  const f = bElse('standalone');
  const r1 = await run(f, Q.concat('--share')); assert.strictEqual(r1.code, 0, r1.text);
  const r2 = await run(f, [], { answers: [] });
  assert.strictEqual(r2.code, 0, r2.text); assert.deepStrictEqual(r2.asked, [], 'no menu, no prompt'); assert.deepStrictEqual(r2.mut, []);
  assert.ok(/⚠ registered +registered from /.test(flat(r2.out)) && /--repoint/.test(r2.out), r2.out);
});
test('refusal · a would-be menu with no terminal and no pre-answer (`--plan` piped) is a refusal, never "" read as quit', async () => {
  const f = bElse('standalone'); const snap = snapshot(f.dir);
  const r = await run(f, ['--plan'], { tty: false });
  assert.strictEqual(r.code, 1); assert.ok(/Re-run with --share to use that copy, or --repoint/.test(r.err), r.err);
  assert.deepStrictEqual(r.asked, []); assert.deepStrictEqual(snapshot(f.dir), snap);
  const ok2 = await run(f, ['--plan', '--share'], { tty: false });
  assert.strictEqual(ok2.code, 0, ok2.text);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// §13.3 consent at the menu
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
test('consent · declining at the menu (3 / Enter / junk) = zero mutations, zero writes, Nothing was changed.', async () => {
  for (const ans of ['3', '', 'x', 'quit']) {
    const f = bElse('other-project-copy'); const snap = snapshot(f.dir);
    const r = await run(f, [], { answers: [ans] });
    assert.strictEqual(r.code, 1);
    assert.deepStrictEqual(r.asked, [V.MENU_PROMPT], 'no Proceed? after a quit');
    assert.ok(/^ {2}Nothing was changed\.$/m.test(r.out));
    assert.deepStrictEqual(r.mut, []); assert.deepStrictEqual(r.npm, []); assert.deepStrictEqual(snapshot(f.dir), snap);
  }
});
test('consent · the menu chooses, the prompt consents: use then n → nothing changed', async () => {
  const f = bElse('standalone'); const snap = snapshot(f.dir);
  const r = await run(f, [], { answers: ['1', 'n'] });
  assert.strictEqual(r.code, 1); assert.deepStrictEqual(r.asked, [V.MENU_PROMPT, V.CONFIRM_PROMPT]);
  assert.deepStrictEqual(r.mut, []); assert.deepStrictEqual(r.npm, []); assert.deepStrictEqual(snapshot(f.dir), snap);
  assert.ok(/Nothing was changed\./.test(r.out));
});
test('consent · --quiet with a would-be menu and no pre-answer → refusal on stderr (verdict first), exit 1, nothing changed', async () => {
  const f = bElse('other-project-copy'); const snap = snapshot(f.dir);
  const r = await run(f, Q);
  assert.strictEqual(r.code, 1);
  assert.ok(/^error: not installing — claude-tpm 0\.2\.0-dev is already registered from .*node_modules\/@codercowboy\/claude-tpm\.$/m.test(flatErr(r.err)), r.err);
  assert.ok(/Re-run with --share to use that copy, or --repoint to register this folder instead\./.test(r.err) && /Nothing was changed\./.test(r.err));
  assert.deepStrictEqual(r.mut, []); assert.deepStrictEqual(snapshot(f.dir), snap);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// §13.4 failure + resumability
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
async function remainderIs(f, ids, prose) {
  const p = await run(f, ['--plan', '--quiet']);
  assert.strictEqual(p.code, 0, p.text);
  const parsed = parsePlan(p.out);
  assert.deepStrictEqual(parsed.items.map((i, k) => i.prose.slice(0, prose[k].length)), prose, 'the next run plans exactly the remainder: ' + ids.join(','));
  assert.strictEqual(parsed.items.length, ids.length);
}
test('failure · fail on action 2 of 4 (npm) → ✓ 1, ✗ 2 with npm stderr verbatim, Stopped after 1 of 4, exit 1; re-run plans the remainder and finishes', async () => {
  const f = bFresh();
  const r = await run(f, Q, { env: { FAKE_NPM_FAIL: '1' } });
  assert.strictEqual(r.code, 1);
  assert.ok(/✓ registered +/.test(r.out), r.out);
  assert.ok(/✗ package\.json +`npm install file:[^`]*` exited 1:\n {24}npm ERR! forced failure from the fake npm/.test(r.out), r.out);
  assert.ok(/^ {2}Stopped after 1 of 4\. Re-running `tpm install \.` picks up where this left off\.$/m.test(r.out), r.out);
  assert.ok(!/✓ package\.json/.test(r.out) && !/✓ turned on/.test(r.out) && !/✓ config\.json/.test(r.out) && !/is installed in/.test(flat(r.out)));
  assert.deepStrictEqual(r.mut, ['plugin marketplace add ' + f.S], 'only the registration had run');
  await remainderIs(f, ['dep', 'plugin-install', 'config-seed'], [P.dep, P.install, P.seed]);
  const r2 = await run(f, Q);
  assert.strictEqual(r2.code, 0, r2.text);
  assert.deepStrictEqual(r2.mut.filter((m) => /marketplace/.test(m)), [], 'the finished registration is not repeated');
  ok(O.observe(f.dir, f.self, f.w.env));
  await converged(f);
});
test('failure · fail on action 1 (marketplace add) → Stopped after 0 of 4, claude stderr verbatim, nothing else ran', async () => {
  const f = bFresh();
  const r = await run(f, Q, { env: { FAKE_CLAUDE_FAIL: 'plugin marketplace add' } });
  assert.strictEqual(r.code, 1);
  assert.ok(/✗ registered +`claude plugin marketplace` exited 1:\n {24}fake claude: forced failure/.test(r.out), r.out);
  assert.ok(/Stopped after 0 of 4\./.test(r.out) && !/✓ /.test(r.out));
  assert.deepStrictEqual(r.npm, []);
  await remainderIs(f, ['register', 'dep', 'plugin-install', 'config-seed'], [P.register(f.S), P.dep, P.install, P.seed]);
});
test('failure · fail on action 3 (plugin install) → Stopped after 2 of 4; re-run plans [plugin-install, config-seed]', async () => {
  const f = bFresh();
  const r = await run(f, Q, { env: { FAKE_CLAUDE_FAIL: 'plugin install' } });
  assert.strictEqual(r.code, 1);
  assert.ok(/✓ registered/.test(r.out) && /✓ package\.json/.test(r.out) && /✗ turned on +`claude plugin install` exited 1:/.test(r.out) && /Stopped after 2 of 4\./.test(r.out), r.out);
  await remainderIs(f, ['plugin-install', 'config-seed'], [P.install, P.seed]);
  assert.strictEqual(O.observe(f.dir, f.self, f.w.env).reg.state, 'same');
});
test('failure · a command that exits 0 but changes nothing FAILS its verify (replaces --force)', async () => {
  const f = bFresh();
  const r = await run(f, Q, { env: { FAKE_NPM_NOOP: '1' } });
  assert.strictEqual(r.code, 1);
  assert.ok(/✗ package\.json/.test(r.out) && /did not take effect/.test(flat(r.out)) && /Stopped after 1 of 4\./.test(r.out), r.out);
});
test('failure · Claude Code that will not report its state → refusal, nothing changed (no guessing a plan)', async () => {
  const f = bFresh();
  const r = await run(f, Q, { env: { FAKE_CLAUDE_FAIL: 'plugin list' } });
  assert.strictEqual(r.code, 1);
  assert.ok(/^error: not installing — Claude Code is installed but did not report what it has set up/m.test(r.err) && /Nothing was changed\./.test(r.err), r.err);
  assert.deepStrictEqual(r.mut, []); assert.deepStrictEqual(r.npm, []);
});
test('refusals · claude missing → tool-missing; target is the claude-tpm folder itself → "not a project"', async () => {
  const f = bFresh(); f.w = mkWorld({ noClaude: true });
  const r = await run(f, Q);
  assert.strictEqual(r.code, 1);
  assert.ok(/error: not installing — `claude` not found on PATH — install Claude Code first\./.test(r.err), r.err);
  const g = bFresh(); g.dir = g.S;
  const r2 = await run(g, Q);
  assert.strictEqual(r2.code, 1);
  assert.ok(/error: not installing — this is the claude-tpm folder, not a project\./.test(r2.err), r2.err);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// §13.6 probe count + GENUINE memoization (closes phase-01 concern #1)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
test('memoization · a probe called twice → ONE spawn (red if the memo is disabled)', () => {
  const f = bGood(); const counts = {};
  const exec = (bin, argv, cwd, env) => { const k = [bin].concat(argv).join(' '); counts[k] = (counts[k] || 0) + 1; return spawnSync(bin, argv, { encoding: 'utf8', cwd, env }); };
  const st = O.observe(f.dir, f.self, f.w.env, { exec });
  const probes = st._ctx.probes;
  assert.strictEqual(counts['claude plugin list --json'], 1, 'observe itself spawns plugin list once');
  probes.pluginList(); probes.pluginList(); probes.marketplaceList(); probes.marketplaceList(); probes.claudeVersion(); probes.claudeVersion();
  assert.strictEqual(counts['claude plugin list --json'], 1, 'plugin list called 3× in all → ONE spawn');
  assert.strictEqual(counts['claude plugin marketplace list --json'], 1, 'marketplace list called 3× in all → ONE spawn');
  assert.strictEqual(counts['claude --version'], 1, 'claude --version called 3× in all → ONE spawn');
  probes.pluginList(true);
  assert.strictEqual(counts['claude plugin list --json'], 2, 'fresh:true is the ONLY way to re-run (that is what verify uses)');
  assert.strictEqual(st.probes.count, 3, 'the State records 3 claude spawns for the observe');
});
test('probe count · verify re-probes ONLY the layer an action touched (N6)', () => {
  const f = bGood(); const log = [];
  const exec = (bin, argv, cwd, env) => { log.push([bin].concat(argv).join(' ')); return spawnSync(bin, argv, { encoding: 'utf8', cwd, env }); };
  const st = O.observe(f.dir, f.self, f.w.env, { exec });
  const n0 = log.length;
  O.reobserveLayer(st, 'dep'); O.reobserveLayer(st, 'marker');
  assert.strictEqual(log.length, n0, 'dep / marker verify = filesystem only, zero spawns');
  O.reobserveLayer(st, 'registration');
  assert.deepStrictEqual(log.slice(n0), ['claude plugin marketplace list --json']);
  O.reobserveLayer(st, 'enablement');
  assert.deepStrictEqual(log.slice(n0 + 1), ['claude plugin list --json']);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// §8 flags
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
function cli(args, w, input) {
  const env = w ? w.env : process.env;
  return spawnSync(process.execPath, [TOOL].concat(args), { encoding: 'utf8', env, input: input === undefined ? '' : input, timeout: 120000 });
}
test('flags · parseArgs: every §8 flag, positional + --dir, defaults', () => {
  const a = inst.parseArgs(['../p', '--plan', '--quiet', '--save', '--from', 'file:../x', '--repoint', '--debug', '--verbose', '--check']);
  assert.deepStrictEqual([a.dir, a.plan, a.quiet, a.save, a.from, a.repoint, a.share, a.debug, a.verbose, a.check], ['../p', true, true, true, 'file:../x', true, false, true, true, true]);
  assert.strictEqual(inst.parseArgs(['--share']).share, true);
  assert.strictEqual(inst.parseArgs(['--dir', '../q']).dir, '../q');
  const d = inst.parseArgs([]);
  assert.deepStrictEqual([d.dir, d.plan, d.quiet, d.save, d.repoint, d.share, d.check, d.help], [process.cwd(), false, false, false, false, false, false, false]);
  assert.strictEqual(inst.parseArgs(['-h']).help, true); assert.strictEqual(inst.parseArgs(['--help']).help, true);
});
test('flags · --force, -y, unknown tokens, missing values, --repoint+--share → exit 2 (nothing runs)', () => {
  for (const args of [['--force'], ['-y'], ['--bogus'], ['--from'], ['--from', '-x'], ['--dir'], ['--repoint', '--share'], ['a', 'b']]) {
    const r = cli(args);
    assert.strictEqual(r.status, 2, JSON.stringify(args) + ' → ' + r.status + ' ' + r.stdout + r.stderr);
  }
  assert.ok(/Unknown argument: --force/.test(cli(['--force']).stderr));
});
test('flags · --help prints the voice help (no --force, no -y), exit 0', () => {
  const r = cli(['--help']);
  assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, V.help());
  assert.ok(!/--force/.test(r.stdout) && !/\s-y\b/.test(r.stdout) && /--plan/.test(r.stdout) && /--share/.test(r.stdout));
});
test('flags · the CLI end to end: `--plan` prints the plan and exits 0 (real installer folder, fake claude/npm); `--debug` traces spawns on stdout', () => {
  const w = mkWorld(); const dir = W.project({ pkg: null }); const snap = snapshot(dir);
  const r = cli([dir, '--plan'], w);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(/I will:/.test(r.stdout) && !/Proceed\?/.test(r.stdout), r.stdout);
  assert.deepStrictEqual(snapshot(dir), snap);
  const d = cli([dir, '--plan', '--debug'], w);
  assert.ok(/\[tpm-debug\] → spawn: claude --version/.test(d.stdout) && /\[tpm-debug\] diagnose: not-installed/.test(d.stdout), d.stdout);
  const t = cli([dir], w); // no --quiet, stdin not a TTY (spawnSync pipe) → refused
  assert.strictEqual(t.status, 1); assert.ok(/stdin is not a terminal/.test(t.stderr), t.stderr);
});
test('flags · the CLI end to end: a real `--quiet` install from the actual installer folder (fake claude/npm) converges', () => {
  const w = mkWorld(); const dir = W.project({ pkg: null });
  const r = spawnSync(process.execPath, [TOOL, dir, '--quiet'], { encoding: 'utf8', env: w.env, timeout: 120000 });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(/is installed in /.test(flat(r.stdout)), r.stdout);
  assert.strictEqual(O.observe(dir, null, w.env).reg.state, 'same');
});
test('flags · --save → regular dependency (npm --save, bucket `dependencies`, prose without "dev"); default → dev + the O5 note', async () => {
  const f = bFreshReg();
  const p = await run(f, ['--plan', '--save']);
  const items = parsePlan(p.out);
  assert.ok(/^Add claude-tpm to package\.json as a dependency, /.test(items.items[0].prose), items.items[0].prose);
  assert.ok(!items.extras.some((e) => /dev dependency/.test(e)));
  assert.ok(/ --save --no-fund/.test(items.items[0].cmds[0]) && !/--save-dev/.test(items.items[0].cmds[0]), items.items[0].cmds[0]);
  const r = await run(f, ['--quiet', '--save']);
  assert.strictEqual(r.code, 0, r.text);
  const pj = JSON.parse(fs.readFileSync(path.join(f.dir, 'package.json'), 'utf8'));
  assert.ok(pj.dependencies && pj.dependencies['@codercowboy/claude-tpm'] && !(pj.devDependencies && pj.devDependencies['@codercowboy/claude-tpm']));
  const g = bFreshReg();
  const q = await run(g, ['--plan']);
  assert.ok(parsePlan(q.out).extras.some((e) => /recorded as a dev dependency; pass --save for a regular one/.test(e)));
  assert.ok(/ --save-dev /.test(parsePlan(q.out).items[0].cmds[0]));
});
test('flags · --from <spec> is used verbatim for the dependency', async () => {
  const f = bFreshReg(); const custom = path.join(path.dirname(f.dir), 'custom-source'); fs.mkdirSync(custom);
  const r = await run(f, ['--quiet', '--from', 'file:../custom-source']);
  assert.strictEqual(r.code, 0, r.text);
  assert.deepStrictEqual(r.npm, ['install file:../custom-source --save-dev --no-fund --no-audit']);
  assert.strictEqual(O.observe(f.dir, f.self, f.w.env).dep.linksTo, fs.realpathSync(custom));
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// §13.5 / concern #2 — the strict never-print check, and it is itself tested
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
test('never-print · the STRICT check is strictly stricter than voice\'s (banned prose hidden in a `claude …` span)', () => {
  const planted = 'Some prose with `claude cache is stale` inside a command-looking span.';
  assert.deepStrictEqual(V.findNeverPrint(planted), [], 'voice\'s own check is blind to it (the documented exemption)');
  assert.ok(strictNeverPrint(planted).some((o) => o.word === 'cache'), 'the strict check sees it');
  assert.deepStrictEqual(strictNeverPrint('run `npx tpm doctor .` then `tpm install . --repoint` or `claude plugin marketplace add ~/x`'), []);
  assert.deepStrictEqual(strictNeverPrint('  $ claude plugin marketplace add /x'), [], '$ command lines are exempt');
  assert.ok(strictNeverPrint('The marketplace is gone').length === 1);
  assert.deepStrictEqual(strictNeverPrint('  ✗ registered `claude plugin marketplace` exited 1:\n                        Marketplace not found'), [], 'child stderr under a ✗ is verbatim and exempt');
  assert.ok(strictNeverPrint('  ✗ registered `claude plugin marketplace` exited 1:\n  Marketplace not found').length === 1, 'but only when indented as the child block');
});

// ── run ───────────────────────────────────────────────────────────────────────────────────────────────
(async () => {
  process.stdout.write('tpm-consumer-install.test.js — the state reconciler\n');
  for (const [name, fn] of tests) {
    try { await fn(); process.stdout.write(`  ✓ ${name}\n`); pass += 1; }
    catch (e) { process.stdout.write(`  ✗ ${name}\n      ${String(e.message).split('\n').join('\n      ')}\n`); fail += 1; }
  }
  try {
    assert.deepStrictEqual(OFFENCES, [], 'never-print offences in install output: ' + JSON.stringify(OFFENCES.slice(0, 3)));
    process.stdout.write(`  ✓ never-print · STRICT check over the output of every run above (${tests.length} tests): zero offences\n`); pass += 1;
  } catch (e) { process.stdout.write(`  ✗ never-print\n      ${e.message}\n`); fail += 1; }
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
