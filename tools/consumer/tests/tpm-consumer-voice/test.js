#!/usr/bin/env node
/**
 * test.js — tpm-consumer-voice.js: wording pinned against installer-repl-voice.md and the §13.5 never-print grep
 * over EVERY rendered string, across a spread of observed States (healthy, fresh, upgrade, dead folder, other
 * registrations, light mode, no claude, garbage input). Includes planted-defect checks so the grep is proven able
 * to fail.
 *
 * Usage: node tools/consumer/tests/tpm-consumer-voice/test.js   → exit 0 all pass, 1 otherwise.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const O = require('../../tpm-consumer-observe');
const V = require('../../tpm-consumer-voice');
const F = require('../lib-observe-world');

let pass = 0; let fail = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ✓ ${name}\n`); pass += 1; }
  catch (e) { process.stdout.write(`  ✗ ${name}\n      ${e.stack.split('\n').slice(0, 3).join('\n      ')}\n`); fail += 1; }
}
process.stdout.write('tpm-consumer-voice.test.js\n');

const MARKET = 'claude-tpm-market-0.2.0-dev';
const ID = `claude-tpm@${MARKET}`;
const mrow = (p) => [{ name: MARKET, source: 'directory', path: p }];
const rec = (dir, over) => Object.assign({ id: ID, scope: 'project', enabled: true, installPath: dir, projectPath: dir }, over || {});
// Wrapping (voice §3 width rule) may fold a long line; wording is compared with the folds undone.
const flat = (t) => t.replace(/\n {2,}(?=\S)/g, ' ');
const obs = (proj, b, w, opts) => O.observe(proj, b, w.env, opts);
// Real users see ~-shortened paths: make the scratch root the fake $HOME so rendered widths are realistic.
// (assigned via Object.assign, never read back from the real environment: the env-leak audit forbids reading the real HOME)
let FAKE_HOME = F.real(require('../../../tests/lib/scratch').scratchRoot());
Object.assign(process.env, { HOME: FAKE_HOME });
const setHome = (v) => { FAKE_HOME = v; Object.assign(process.env, { HOME: v }); };
// Every world here is built on the STATEFUL fake claude (lib-observe-world copies tests/fake-claude-stateful.js to PATH):
const FAKE_CLAUDE_SHIM = 'fake-claude-stateful.js';

// ── a spread of observed States ──────────────────────────────────────────────────────────────────────
function states() {
  const out = {};
  { const b = F.standalone(); const p = F.project({ marker: 'config-valid', settings: { enabledPlugins: { [ID]: true } } }); F.nm(p, b);
    out.healthy = obs(p, b, F.world({ marketplaces: mrow(b), records: [rec(p, { installPath: b })] })); out.healthyLight = obs(p, b, F.world(), { probes: false }); }
  { const b = F.standalone(); out.fresh = obs(F.project({ pkg: null }), b, F.world()); }
  { const b = F.standalone(); const p = F.project({ marker: true, settings: { enabledPlugins: { 'claude-tpm@claude-tpm-market': true, [ID]: true } } }); F.nm(p, null, { version: '0.1.0' });
    out.upgrade = obs(p, b, F.world({ marketplaces: mrow(b), records: [rec(p, { installPath: b })] })); }
  { const b = F.standalone(); const gone = F.standalone(); fs.rmSync(gone, { recursive: true }); const p = F.project({ marker: 'config-bad', settings: { enabledPlugins: { [ID]: true } } }); F.nm(p, gone);
    out.dead = obs(p, b, F.world({ marketplaces: mrow(gone) })); }
  { const b = F.standalone(); const pb = F.project(); const copy = F.nm(pb, null); out.otherCopy = obs(F.project(), b, F.world({ marketplaces: mrow(copy) })); }
  { const b = F.standalone(); const o = F.standalone(); out.standaloneElsewhere = obs(F.project(), b, F.world({ marketplaces: mrow(o) })); }
  { const b = F.standalone(); out.github = obs(F.project(), b, F.world({ marketplaces: [{ name: MARKET, source: 'github', repo: 'codercowboy/claude-tpm' }] })); }
  { const b = F.standalone(); const l = path.join(F.mk('tpm-voice-l'), 'viaLink'); fs.symlinkSync(b, l); out.viaLink = obs(F.project(), b, F.world({ marketplaces: mrow(l) })); }
  { out.noClaude = obs(F.project(), F.standalone(), F.world({ noClaude: true })); }
  { out.mislabelled = obs(F.project(), F.standalone({ version: '0.2.0', name: 'claude-tpm-market-0.1.0' }), F.world()); }
  { out.incomplete = obs(F.project(), F.standalone({ hooks: false }), F.world()); }
  { out.garbage = obs(F.project({ pkg: 'garbage', marker: 'config-bad', settings: '{{' }), F.standalone({ hooks: 'garbage', manifest: 'garbage' }), F.world()); }
  { const b = F.standalone(); const p = F.project(); out.inSession = obs(p, b, F.world({ env: { TPM_HOME: '/elsewhere/home', TPM_PROJECT_ROOT: p } })); }
  { out.badHooks = obs(F.project(), F.standalone({ hooks: 'garbage' }), F.world()); }
  { const p = F.project(); const copy = F.nm(p, null); out.ownCopy = obs(p, copy, F.world()); }
  { const pb = F.project(); const copy = F.nm(pb, null); out.refusedOther = obs(F.project(), copy, F.world()); }
  return out;
}
const S = states();

// ── primitives ───────────────────────────────────────────────────────────────────────────────────────
check('tilde shortens $HOME, leaves other paths; empty → empty', () => {
  const h = FAKE_HOME; setHome('/Users/u');
  try { assert.strictEqual(V.tilde('/Users/u/proj'), '~/proj'); assert.strictEqual(V.tilde('/Users/u'), '~'); assert.strictEqual(V.tilde('/Users/uu/x'), '/Users/uu/x'); assert.strictEqual(V.tilde('/opt/x'), '/opt/x'); assert.strictEqual(V.tilde(''), ''); }
  finally { setHome(h); }
});
check('displayCommand quotes only what needs it (spaces)', () => {
  assert.strictEqual(V.displayCommand('claude', ['plugin', 'marketplace', 'add', '/a b/c']), "claude plugin marketplace add '/a b/c'");
  assert.strictEqual(V.displayCommand('npm', ['install', 'file:../x', '--save-dev']), 'npm install file:../x --save-dev');
});
check('plural / ver', () => { assert.strictEqual(V.plural(1, 'check'), '1 check'); assert.strictEqual(V.plural(2, 'check'), '2 checks'); assert.strictEqual(V.ver('0.2.0-dev'), 'claude-tpm 0.2.0-dev'); });

// ── pinned wording (voice spec) ──────────────────────────────────────────────────────────────────────
check('header: "claude-tpm <ver> → <project>  (from <folder>)"; own-copy wording; ~-shortening', () => {
  const h = FAKE_HOME; setHome(path.dirname(path.dirname(S.fresh.target.dir)));
  try {
    assert.ok(/^claude-tpm 0\.2\.0-dev → ~\/[^ ]+\/proj {2}\(from ~\/[^ ]+\/claude-tpm-folder\)$/.test(V.header(S.fresh)), V.header(S.fresh));
  } finally { setHome(h); }
  assert.ok(/\(from this project's own copy in node_modules\)$/.test(V.header(S.ownCopy)));
});
check('diagnosis sentences are the design §4.3 / voice sentences, verbatim', () => {
  const s = S.fresh; const proj = V.projectName(s);
  assert.strictEqual(V.diagnosisSentence('not-installed', s), 'claude-tpm is not installed here.');
  assert.strictEqual(V.diagnosisSentence('upgrade', s, { oldVersion: '0.1.0' }), 'claude-tpm 0.1.0 is installed here. This is an upgrade to 0.2.0-dev.');
  assert.strictEqual(V.diagnosisSentence('broken', s), 'claude-tpm 0.2.0-dev is installed here but broken.');
  assert.strictEqual(V.diagnosisSentence('partial', s), 'claude-tpm 0.2.0-dev is partly installed here.');
  assert.strictEqual(V.diagnosisSentence('registered-elsewhere', s), 'claude-tpm 0.2.0-dev is already registered on this machine, from a different folder:');
  assert.strictEqual(flat(V.diagnosisSentence('healthy', s, { checks: 12 })), `claude-tpm 0.2.0-dev is already installed in ${proj} and healthy — 12 checks ok, nothing to do.`);
  assert.strictEqual(V.diagnosisSentence('nonsense', s), '');
  assert.strictEqual(V.checking(s), `Checking ${proj} …`);
});
check('closing: the three forms of voice §4.8, verbatim; Next lines', () => {
  const s = S.fresh; const proj = V.projectName(s);
  assert.strictEqual(V.closing(s, { checks: 12 }), `✓ claude-tpm 0.2.0-dev is installed in ${proj} — 12 checks ok.`);
  assert.strictEqual(V.closing(s, { checks: 11, warnings: 1 }), `✓ claude-tpm 0.2.0-dev is installed in ${proj} — 11 checks ok, 1 warning (see ⚠ above).`);
  assert.strictEqual(V.closing(s, { failures: 2 }), '✗ The steps ran, but 2 checks still fail (see ✗ above). `npx tpm doctor .` shows the full list.');
  assert.ok(/\(upgraded from 0\.1\.0\)/.test(V.closing(s, { checks: 12, upgradedFrom: '0.1.0' })));
  assert.ok(!/doctor clean/i.test(V.closing(s, { checks: 12 })));
  assert.strictEqual(V.nextLine(s, { upgradedFrom: '0.1.0' }), `  Next: start a new \`claude\` session in ${proj} to pick up the new version.`);
});
check('refusals: verdict first, "error: not installing — …", ends "  Nothing was changed.", exact texts', () => {
  const s = S.fresh;
  assert.strictEqual(V.refusal({ id: 'non-tty', detail: {} }, s), 'error: not installing — stdin is not a terminal — pass `--quiet` to accept the plan without prompts.\n  Nothing was changed.\n');
  assert.strictEqual(V.refusal({ id: 'no-package-json', detail: {} }, s), `error: not installing — ${V.projectName(s)} has no package.json. Run \`npm init -y\` there first.\n  Nothing was changed.\n`);
  const o = flat(V.refusal({ id: 'other-project-copy', detail: { owner: '/x/projB' } }, S.refusedOther));
  assert.ok(/^error: not installing — this claude-tpm is \/x\/projB's copy \(/.test(o) && /Run the install from a standalone folder, or from inside /.test(o), o);
  assert.ok(/EACCES/.test(V.refusal({ id: 'tool-missing', detail: { bin: 'npm', errorCode: 'EACCES' } }, s)));
});
check('quiet menu refusal matches voice §4.6 (two option lines + Nothing was changed.)', () => {
  const raw = V.quietMenuRefusal(S.otherCopy); const t = raw;
  assert.ok(/^error: not installing — claude-tpm 0\.2\.0-dev is already registered from\s/.test(t), t);
  assert.ok(raw.includes('  Re-run with --share to use that copy, or --repoint to register this folder instead.\n  Nothing was changed.\n'), t);
  assert.ok(/a GitHub source/.test(V.quietMenuRefusal(S.github)));
});
check('decision menu: 3 options, quit says Nothing was changed., compare line, github has none; prompts are the two kinds only', () => {
  const m = V.decisionMenu(S.otherCopy, 'same version, 3 files differ');
  assert.ok(/1\. use /.test(m) && /2\. re-point /.test(m) && /3\. quit {6}Nothing was changed\./.test(m), m);
  assert.ok(/Compared with this folder: same version, 3 files differ\./.test(m) && /a copy inside another project/.test(m));
  const g = V.decisionMenu(S.github, 'x'); assert.ok(!/Compared with/.test(g) && /github:codercowboy\/claude-tpm/.test(g));
  assert.strictEqual(V.MENU_PROMPT, 'Choose [1/2/3]: '); assert.strictEqual(V.CONFIRM_PROMPT, 'Proceed? [y/N] ');
  assert.ok(/standalone folder/.test(V.decisionMenu(S.standaloneElsewhere, null)));
});
check('plan lines: numbered prose + indented `$ command`; pinned to voice §4.1/§4.4/§4.5', () => {
  const s = S.fresh;
  const dep = V.planLine(1, { id: 'dep', commands: ['npm install file:../x --save-dev --no-fund --no-audit'] }, s);
  assert.strictEqual(dep, '  1. Add claude-tpm to package.json as a dev dependency, so `npx tpm` works in this project\n       $ npm install file:../x --save-dev --no-fund --no-audit');
  assert.ok(V.planLine(2, { id: 'plugin-install', commands: ['c'] }, s).startsWith('  2. Turn the plugin on for this project (writes one line to .claude/settings.json)\n       $ c'));
  assert.ok(V.planLine(3, { id: 'disable-old', oldVersion: '0.1.0', commands: ['c'] }, s).startsWith('  3. Turn the 0.1.0 plugin off for this project — with both on, Claude Code would keep using 0.1.0'));
  assert.ok(/Other projects on 0\.2\.0-dev start working again/.test(V.planLine(1, { id: 'repoint' }, s)));
  assert.ok(/^ {2}1\. Register this project's copy of claude-tpm with Claude Code, once for this machine/.test(V.planLine(1, { id: 'register', ownCopy: true }, s)));
  assert.ok(/as a dependency, so/.test(V.planLine(1, { id: 'dep', saveDev: false }, s)));
  assert.ok(/^ {2}1\. Write \.claude\/claude-tpm\/config\.json with the default task and session folders/.test(V.planLine(1, { id: 'config-seed' }, s)));
});
check('planBlock: "I will:", already-fine line, one Not touched: line, warnings after', () => {
  const t = V.planBlock([{ id: 'config-seed' }], S.upgrade, { fine: [V.ALREADY_REGISTERED(S.upgrade)], notTouched: V.notTouched('0.1.0'), warnings: [V.fragilityWarning()] });
  const lines = t.split('\n'); assert.strictEqual(lines[0], 'I will:');
  assert.ok(lines.some((l) => /^ {2}\(.* is already registered — nothing to do there\)$/.test(l)));
  assert.strictEqual(lines.filter((l) => /Not touched:/.test(l)).length, 1);
  assert.ok(lines.some((l) => /^ {2}⚠ Registering a folder inside node_modules works/.test(l)));
});
check('apply lines: ✓ per action (no command repeated), ✗ with stderr verbatim indented, Stopped after N of M', () => {
  const s = S.fresh;
  assert.ok(/^ {2}✓ registered {3,}/.test(V.applyOk({ id: 'register', commands: ['claude plugin marketplace add /x'] }, s)));
  assert.ok(!/\$ /.test(V.applyOk({ id: 'register', commands: ['claude plugin marketplace add /x'] }, s)));
  const f = V.applyFail({ id: 'register', commands: ['claude plugin marketplace add /x'] }, { status: 1, stderr: 'bad\nworse\n' });
  assert.ok(/✗ registered +`claude plugin marketplace` exited 1:\n +bad\n +worse$/.test(f), f);
  assert.strictEqual(V.stoppedAfter(1, 4), '  Stopped after 1 of 4. Re-running `tpm install .` picks up where this left off.');
  assert.strictEqual(V.declined(), '  Nothing was changed.');
});

// ── the doctor rows ──────────────────────────────────────────────────────────────────────────────────
const row = (st, fn) => V[fn](S[st]);
check('rows: package.json (ok link / old version warn / dangling / not declared / missing)', () => {
  assert.strictEqual(row('healthy', 'rowPackageJson').mark, 'pass'); assert.ok(/^claude-tpm 0\.2\.0-dev, links to /.test(row('healthy', 'rowPackageJson').text));
  const u = row('upgrade', 'rowPackageJson'); assert.strictEqual(u.mark, 'warn'); assert.ok(/points at claude-tpm 0\.1\.0 .*old version from npx/.test(u.text));
  const d = row('dead', 'rowPackageJson'); assert.strictEqual(d.mark, 'fail'); assert.ok(/dangling/.test(d.text));
  assert.ok(/not in package.json/.test(row('fresh', 'rowPackageJson').text)); assert.strictEqual(row('garbage', 'rowPackageJson').mark, 'fail');
  assert.ok(/a copy inside this project/.test(row('ownCopy', 'rowPackageJson').text));
});
check('rows: registered — one wording per reg state', () => {
  assert.strictEqual(row('healthy', 'rowRegistered').mark, 'pass');
  assert.ok(/not registered with Claude Code/.test(row('fresh', 'rowRegistered').text));
  assert.ok(/and that folder is gone \(moved or deleted\)/.test(row('dead', 'rowRegistered').text));
  assert.ok(/a copy inside another project\), not from /.test(row('otherCopy', 'rowRegistered').text));
  assert.ok(/a standalone folder/.test(row('standaloneElsewhere', 'rowRegistered').text));
  assert.ok(/GitHub source, not a local folder/.test(row('github', 'rowRegistered').text));
  assert.ok(/registered through a link \(.* → .*\); it breaks if the link is removed/.test(row('viaLink', 'rowRegistered').text));
  assert.strictEqual(row('noClaude', 'rowRegistered').mark, 'skip');
});
check('rows: turned on / project folder / claude-tpm folder / claude', () => {
  assert.strictEqual(row('healthy', 'rowTurnedOn').mark, 'pass');
  assert.ok(/two versions are turned on here \(0\.1\.0 and 0\.2\.0-dev\) — Claude Code uses the first and ignores the other/.test(row('upgrade', 'rowTurnedOn').text));
  assert.ok(/^not turned on for /.test(row('fresh', 'rowTurnedOn').text));
  assert.ok(/lost its note/.test(row('dead', 'rowTurnedOn').text) === false); // dead source → loadsWithoutRecord false → plain "not turned on"
  assert.strictEqual(row('healthyLight', 'rowTurnedOn').mark, 'pass');
  assert.ok(/is missing — the task and session tools refuse to run without it/.test(row('fresh', 'rowProjectFolder').text));
  assert.ok(/config\.json is not valid JSON: /.test(row('dead', 'rowProjectFolder').text));
  assert.strictEqual(row('healthy', 'rowProjectFolder').mark, 'pass');
  assert.ok(/^mislabelled — its version \(0\.2\.0\) and its registration name \(claude-tpm-market-0\.1\.0\) disagree; a packaging problem in claude-tpm$/.test(row('mislabelled', 'rowClaudeTpmFolder').text));
  assert.ok(/incomplete — missing hooks\/hooks\.json/.test(row('incomplete', 'rowClaudeTpmFolder').text));
  assert.ok(/hooks\/hooks\.json is not valid JSON/.test(row('badHooks', 'rowClaudeTpmFolder').text));
  assert.strictEqual(row('healthy', 'rowClaudeTpmFolder').text, 'complete (0.2.0-dev)');
  assert.ok(/the claude command is not on PATH — install Claude Code first/.test(row('noClaude', 'rowClaude').text));
});
check('rows: in-session rows appear only when inSession; TPM_HOME mismatch warns', () => {
  assert.strictEqual(V.rowTpmOnPath(S.healthy), null); assert.strictEqual(V.rowTpmHome(S.healthy), null);
  const t = V.rowTpmHome(S.inSession); assert.strictEqual(t.mark, 'warn'); assert.ok(/set to \/elsewhere\/home, but this doctor runs from /.test(t.text));
  assert.strictEqual(V.rowTpmOnPath(S.inSession).mark, 'warn');
});
check('every warn/fail row renders a `fix:` line directly under it; pass rows do not', () => {
  Object.keys(S).forEach((k) => V.doctorRows(S[k]).forEach((r) => {
    const t = V.renderRow(r);
    if (r.mark === 'warn' || r.mark === 'fail') { assert.ok(r.fix, `${k}/${r.label} has no fix`); assert.ok(/\n {6}fix: /.test(t), t); } else assert.ok(!/fix:/.test(t));
  }));
});
check('never-installed project collapses to ONE ✗ row (S22); a healthy one keeps its rows', () => {
  const r = V.doctorRows(S.fresh); assert.strictEqual(r.length, 1); assert.strictEqual(r[0].mark, 'fail'); assert.ok(/not installed here/.test(r[0].text));
  assert.ok(V.doctorRows(S.healthy).length >= 6);
});
check('doctorSummary: counts', () => {
  assert.strictEqual(V.doctorSummary([{ mark: 'pass' }, { mark: 'pass' }]), '✓ 2 checks ok.');
  assert.strictEqual(V.doctorSummary([{ mark: 'pass' }, { mark: 'warn' }, { mark: 'fail' }, { mark: 'fail' }]), '✗ 1 check ok, 1 warning, 2 problems.');
});

// ── the hook voice (§7) ──────────────────────────────────────────────────────────────────────────────
check('hook voice: SILENT when healthy (empty string); never a "✓ all good"', () => {
  assert.strictEqual(V.hookMessage(S.healthyLight), ''); assert.strictEqual(V.hookMessage(S.healthy), '');
});
check('hook voice: the three §7 examples, verbatim', () => {
  const base = S.healthyLight;
  const skew = Object.assign({}, base, { dep: Object.assign({}, base.dep, { version: '0.1.0' }) });
  assert.strictEqual(V.hookMessage(skew), '[claude-tpm] 1 problem in this project: package.json points at claude-tpm 0.1.0 but the running plugin is 0.2.0-dev, so `npx tpm` runs the old version. Tell the user and suggest `npx tpm install .` from a terminal. Do not edit files to fix this.');
  const two = Object.assign({}, base, { en: Object.assign({}, base.en, { otherIds: ['claude-tpm@claude-tpm-market'] }), marker: { dir: false, config: 'absent', err: null } });
  assert.strictEqual(V.hookMessage(two), '[claude-tpm] 2 problems in this project. (1) Another claude-tpm version is also turned on here (claude-tpm@claude-tpm-market); Claude Code uses whichever is first. (2) .claude/claude-tpm/ is missing, so the task and session tools will refuse to run. Tell the user and suggest `npx tpm install .` from a terminal. Do not edit files to fix this.');
  const cfg = Object.assign({}, base, { marker: { dir: true, config: 'invalid', err: 'Unexpected token } at line 4' } });
  assert.strictEqual(V.hookMessage(cfg), '[claude-tpm] 1 problem in this project: .claude/claude-tpm/config.json is not valid JSON (Unexpected token } at line 4). The task and session tools will refuse to run until it is fixed. Tell the user; do not rewrite the file without asking.');
});
check('hook voice: one line, tagged, at most 3 problems listed', () => {
  const base = S.healthyLight;
  const sick = Object.assign({}, base, { dep: Object.assign({}, base.dep, { version: '0.1.0' }), en: Object.assign({}, base.en, { otherIds: ['claude-tpm@x'] }), marker: { dir: false, config: 'invalid', err: 'e' } });
  const m = V.hookMessage(sick); assert.ok(m.startsWith('[claude-tpm] 3 problems')); assert.ok(!m.includes('\n')); assert.strictEqual(V.lightProblems(sick).length, 4);
});

// ── help ─────────────────────────────────────────────────────────────────────────────────────────────
check('help: human block ≤ 22 lines, ≤ 100 cols, no --force / -y, mentions --plan/--quiet/--repoint/--share', () => {
  const h = V.help().replace(/\n$/, '').split('\n');
  assert.ok(h.length <= 22, `lines=${h.length}`); h.forEach((l) => assert.ok(l.length <= 100, `${l.length}: ${l}`));
  const t = h.join('\n'); ['--plan', '--quiet', '--repoint', '--share', '--save', '--from', '--debug'].forEach((f) => assert.ok(t.includes(f), f));
  assert.ok(!/--force/.test(t) && !/\s-y\b/.test(t));
});

// ── §13.5 never-print grep + style rules over EVERY rendered string ──────────────────────────────────
check('findNeverPrint: detects every word in the list (planted defects), exempts $ commands, backticked commands and hooks/hooks.json', () => {
  const planted = { marketplace: 'the marketplace is down', row: 'a dead row here', registry: 'registry entry', record: 'install record', cache: 'the cache folder', 'cache-miss': 'cache-miss!', scope: 'at user scope',
    symlink: 'a symlink', realpath: 'the realpath', canonical: 'canonical folder', bundle: 'the bundle', manifest: 'the manifest', hook: 'a hook fired', stamp: 'stamp guard', spawn: 'we spawn it', probe: 'a probe ran',
    preflight: 'preflight check', idempotent: 'idempotent step', legitimate: 'a legitimate choice', 'step N/5': 'Step 3/5 · register' };
  V.NEVER_PRINT.forEach(([word]) => { const hits = V.findNeverPrint(planted[word]); assert.ok(hits.some((h) => h.word === word), `not caught: ${word} (${JSON.stringify(hits)})`); });
  assert.strictEqual(V.findNeverPrint('       $ claude plugin marketplace add ~/x --scope project').length, 0);
  assert.strictEqual(V.findNeverPrint('✗ registered `claude plugin marketplace` exited 1:').length, 0);
  assert.strictEqual(V.findNeverPrint('incomplete — missing hooks/hooks.json').length, 0);
  assert.strictEqual(V.findNeverPrint('registered from ~/x (a copy inside another project)').length, 0);
});
check('planted leak: a State whose project path contains a banned word makes the sampleAll grep FAIL (the grep can fail)', () => {
  const leaky = Object.assign({}, S.healthy, { target: Object.assign({}, S.healthy.target, { dir: '/x/marketplace-proj' }) });
  const hits = V.sampleAll(leaky).filter((s) => V.findNeverPrint(s.text).length);
  assert.ok(hits.length > 3, `only ${hits.length} strings flagged`);
});
check('§13.5: the never-print grep over every rendered string, across 17 observed States → zero offences', () => {
  const offences = []; let n = 0;
  Object.keys(S).forEach((k) => V.sampleAll(S[k]).forEach((s) => { n += 1; V.findNeverPrint(s.text).forEach((o) => offences.push(`${k}/${s.name}: "${o.word}" in: ${o.line}`)); }));
  assert.ok(n > 1000, `only ${n} strings rendered`);
  assert.deepStrictEqual(offences, []);
});
check('style: no exclamation marks, only the four marks, no line > 100 cols (except $ command lines), no "legitimate"/"error:" outside refusals', () => {
  Object.keys(S).forEach((k) => V.sampleAll(S[k]).forEach((s) => {
    assert.ok(!/!/.test(s.text.replace(/hello!/g, '')), `${k}/${s.name} has "!"`);
    s.text.split('\n').forEach((l) => {
      if (/^\s*\$ /.test(l) || /^hook/.test(s.name)) return; // commands + the one-line hook-to-Claude voice (§7) are not column-bound
      assert.ok(l.length <= 100, `${k}/${s.name}: ${l.length} cols: ${l}`);
    });
    if (!/^refusal|^quietMenuRefusal/.test(s.name)) assert.ok(!/^error:/m.test(s.text), `${k}/${s.name} starts a line with error:`);
    if (/^refusal|^quietMenuRefusal/.test(s.name)) assert.ok(/^error: not installing — /.test(s.text) && /\n {2}Nothing was changed\.\n$/.test(s.text), `${k}/${s.name}`);
  }));
});
check('sampleAll covers every exported renderer family (catalogue is not stale)', () => {
  const names = new Set(V.sampleAll(S.healthy).map((s) => s.name.split(':')[0]));
  ['header', 'checking', 'diagnosis', 'row', 'rowfn', 'refusal', 'quietMenuRefusal', 'menu', 'plan', 'ok', 'fail', 'planBlock', 'closing', 'next', 'hook', 'help', 'prompts', 'stoppedAfter', 'declined']
    .forEach((n) => assert.ok(names.has(n), `sampleAll lacks ${n}`));
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
