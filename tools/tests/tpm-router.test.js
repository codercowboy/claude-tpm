#!/usr/bin/env node
/**
 * tests/tpm-router.test.js — behavioral test for the `tpm` dispatcher + the per-suite routers.
 *
 * PURPOSE
 *   Proves the two-level dispatch (tools/tpm.js → tools/<suite>/tpm-<suite>-router.js → tool script):
 *   suite/verb routing, unknown-command exit codes, faithful arg pass-through, and exit-code
 *   propagation across BOTH hops. Uses only NON-MUTATING child commands (config resolvers,
 *   `--help`/bare menus), so it's safe to run anywhere.
 *
 *   Every path resolves via __dirname — no hardcoded absolutes, portable when the bundle moves.
 *
 * HOW TO RUN
 *   node tests/tpm-router.test.js        # exit 0 = all assertions green
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOLS = path.resolve(__dirname, '..');          // tests/ -> tools/
const TPM = path.join(TOOLS, 'tpm.js');

let count = 0;
function check(name, fn) { fn(); count++; process.stdout.write(`  ✓ ${name}\n`); }

// Run `node <script> <args…>` and capture {status, out} (stdout+stderr merged).
function run(script, args) {
  const r = spawnSync('node', [script, ...args], { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const tpm = (...args) => run(TPM, args);

process.stdout.write('tpm-router.test.js\n');

// ── top dispatcher ────────────────────────────────────────────────────────────────
check('bare `tpm` → exit 0 + lists all three suites', () => {
  const r = tpm();
  assert.strictEqual(r.status, 0);
  for (const s of ['session', 'task', 'workflow']) assert.ok(r.out.includes(s), `menu names ${s}`);
});
check('`tpm --help` → exit 0', () => assert.strictEqual(tpm('--help').status, 0));
check('`tpm --help` examples are bare `tpm` + one line explains the human `npx tpm` form', () => {
  const o = tpm('--help').out;
  assert.ok(/^  tpm task list/m.test(o), "bare example");
  assert.ok(/plain project shell \(outside a Claude Code session\), run these as `npx tpm /.test(o), 'human-form line present');
  assert.ok(/^  npx tpm install \.( |$)/m.test(o), 'install example stays `npx tpm install .` (pre-install, no bin/ on PATH)');
  assert.ok(!/^  tpm install/m.test(o), 'no bare `tpm install` example');
  assert.strictEqual((o.match(/npx tpm/g) || []).length, 3, 'npx appears only in the human-form line + install example');
});
check('unknown suite → exit 2', () => assert.strictEqual(tpm('frobnicate').status, 2));

// ── session router (JSON-first surface #1113: ops/export/migrate/doctor) ──────────
check('`tpm session` (bare) → exit 0 + lists session verbs', () => {
  const r = tpm('session');
  assert.strictEqual(r.status, 0);
  for (const v of ['ops', 'export', 'migrate', 'doctor']) assert.ok(r.out.includes(v), `lists ${v}`);
});
check('unknown session verb → exit 2', () => assert.strictEqual(tpm('session', 'badverb').status, 2));
check('`tpm session doctor --help` dispatches through the router (exit 0 + output)', () => {
  const r = tpm('session', 'doctor', '--help'); // doctor is READ-ONLY; --help never touches a store
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.trim().length > 0, 'the child --help text made it back through both dispatch hops');
});
check('pass-through is faithful: `tpm session doctor --help` === direct tool output', () => {
  const via = tpm('session', 'doctor', '--help').out;
  const direct = run(path.join(TOOLS, 'session', 'tpm-session-doctor.js'), ['--help']).out;
  assert.strictEqual(via, direct);
});

// ── task router (single-tool suite + `config` special-case) ─────────────────────
check('`tpm task config --json` → routes to the config resolver (exit 0 + JSON)', () => {
  const r = tpm('task', 'config', '--json');
  assert.strictEqual(r.status, 0);
  const j = JSON.parse(r.out);
  assert.ok('tasksDir' in j, 'config resolver output has tasksDir');
});
check('non-config task verb passes through to tpm-task.js (`--help` exit 0)', () => {
  assert.strictEqual(tpm('task', '--help').status, 0);
});

// ── workflow router ─────────────────────────────────────────────────────────────
check('`tpm workflow` (bare) → exit 0 + lists workflow verbs', () => {
  const r = tpm('workflow');
  assert.strictEqual(r.status, 0);
  for (const v of ['audit', 'compose', 'scaffold', 'doctor', 'signoff']) assert.ok(r.out.includes(v), `lists ${v}`);
});
check('unknown workflow verb → exit 2', () => assert.strictEqual(tpm('workflow', 'nope').status, 2));
check('`tpm workflow config --json` dispatches (exit 0 + valid JSON)', () => {
  const r = tpm('workflow', 'config', '--json');
  assert.strictEqual(r.status, 0);
  JSON.parse(r.out);
});

// ── flat consumer-adoption aliases ──────────────────────────────────────────────
check('`tpm install --help` alias still routes (exit 0)', () => {
  const r = tpm('install', '--help');
  assert.strictEqual(r.status, 0);
  assert.ok(/install/i.test(r.out));
});

// ── flat bundle primitives (home / doc) ───────────────────────────────────────────
check('`tpm home` routes → prints an absolute path (exit 0)', () => {
  const r = tpm('home');
  assert.strictEqual(r.status, 0);
  assert.ok(path.isAbsolute(r.out.trim()), 'home prints an absolute bundle path');
});
check('`tpm doc` (no arg) routes → usage exit 2', () => {
  assert.strictEqual(tpm('doc').status, 2);
});
check('bare `tpm` menu lists the home + doc primitives', () => {
  const r = tpm();
  assert.ok(r.out.includes('home') && r.out.includes('doc'), 'menu names home + doc');
});
check('`tpm reading-list orchestrator` routes → anchor-form chain (exit 0)', () => {
  const r = tpm('reading-list', 'orchestrator');
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.includes('tpm resolve-home'), 'emits the resolve-home anchor');
  assert.ok(r.out.includes('tpm doc '), 'emits at least one doc line');
});
check('`tpm reading-list` (no role) routes → usage exit 2', () => {
  assert.strictEqual(tpm('reading-list').status, 2);
});

// ── plugin suite (R9, punchlist 5.4): `tpm plugin <install|uninstall|doctor>` ─────────────────────────────
// Safety: the doctor shells out to `claude`, so every doctor run below has a PATH containing ONLY a stub `claude`
// that exits 1 (+ node's own dir) — the real CLI is never reachable. Stub consumer scripts (in a copied
// tools/ tree) prove args / stdin / exit-code pass-through without touching anything real.
const fs = require('fs');
const { mkScratch } = require('./lib/scratch');

check('`tpm` menu lists the plugin suite; `tpm plugin` (bare) lists install/uninstall/doctor and NO update verb', () => {
  assert.ok(/^\s+plugin\s/m.test(tpm().out), 'top menu names the plugin suite');
  const r = tpm('plugin');
  assert.strictEqual(r.status, 0);
  for (const v of ['install', 'uninstall', 'doctor']) assert.ok(r.out.includes(v), `lists ${v}`);
  assert.ok(!/^\s+update\b/m.test(r.out), 'no `update` verb');
  assert.strictEqual(tpm('plugin', '--help').status, 0);
});
check('unknown plugin verbs → exit 2 (incl. the dropped `update`)', () => {
  assert.strictEqual(tpm('plugin', 'frobnicate').status, 2);
  assert.strictEqual(tpm('plugin', 'update').status, 2);
});
check('`tpm plugin install --help` / `uninstall --help` pass through byte-identically to the consumer scripts (exit 0)', () => {
  for (const [verb, script] of [['install', 'tpm-consumer-install.js'], ['uninstall', 'tpm-consumer-uninstall.js']]) {
    const via = tpm('plugin', verb, '--help');
    const direct = run(path.join(TOOLS, 'consumer', script), ['--help']);
    assert.strictEqual(via.status, 0);
    assert.ok(via.out.trim().length > 0);
    assert.strictEqual(via.out, direct.out, `${verb}: same help as the direct script`);
  }
});
check('flat aliases `tpm install|uninstall --help` still work and equal the plugin-suite forms', () => {
  for (const verb of ['install', 'uninstall']) {
    const flat = tpm(verb, '--help'); const suite = tpm('plugin', verb, '--help');
    assert.strictEqual(flat.status, 0);
    assert.strictEqual(flat.out, suite.out);
  }
});

// A copied mini-tree: tools/plugin/tpm-plugin-router.js (real code) + STUB consumer scripts that echo what they got.
function stubTree() {
  const root = mkScratch('tpm-plugin-router-stub');
  fs.mkdirSync(path.join(root, 'tools', 'plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tools', 'consumer'), { recursive: true });
  fs.copyFileSync(path.join(TOOLS, 'plugin', 'tpm-plugin-router.js'), path.join(root, 'tools', 'plugin', 'tpm-plugin-router.js'));
  const stub = (name) => fs.writeFileSync(path.join(root, 'tools', 'consumer', name),
    `let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{console.log(JSON.stringify({script:${JSON.stringify(name)},argv:process.argv.slice(2),stdin:b}));process.exit(Number(process.env.STUB_EXIT||0));});`);
  stub('tpm-consumer-install.js'); stub('tpm-consumer-uninstall.js');
  return path.join(root, 'tools', 'plugin', 'tpm-plugin-router.js');
}
function viaStub(args, o) {
  const r = spawnSync('node', [stubTree(), ...args], { encoding: 'utf8', input: (o && o.input) || '', env: Object.assign({}, process.env, (o && o.env) || {}) });
  let j = null; try { j = JSON.parse(r.stdout); } catch (_e) { /* leave null */ }
  return { status: r.status, j, out: (r.stdout || '') + (r.stderr || '') };
}
check('routing: install → consumer install script, uninstall → consumer uninstall script; args verbatim', () => {
  const a = viaStub(['install', '../proj', '--quiet', '--from', 'file:../x']);
  assert.deepStrictEqual([a.j.script, a.j.argv], ['tpm-consumer-install.js', ['../proj', '--quiet', '--from', 'file:../x']]);
  const b = viaStub(['uninstall', '--system', '.']);
  assert.deepStrictEqual([b.j.script, b.j.argv], ['tpm-consumer-uninstall.js', ['--system', '.']]);
});
check('routing: doctor → the INSTALL script with `--check` appended after the user args (read-only)', () => {
  const r = viaStub(['doctor', '../proj']);
  assert.deepStrictEqual([r.j.script, r.j.argv], ['tpm-consumer-install.js', ['../proj', '--check']]);
});
check('pass-through: stdin reaches the child (installer prompts) and its exit code propagates (0, 3)', () => {
  const ok = viaStub(['install', '.'], { input: 'y\nsecond line\n' });
  assert.strictEqual(ok.status, 0); assert.strictEqual(ok.j.stdin, 'y\nsecond line\n');
  const bad = viaStub(['uninstall', '.'], { env: { STUB_EXIT: '3' } });
  assert.strictEqual(bad.status, 3);
});
check('end-to-end through `tpm plugin doctor <dir>` with a stub-only-PATH `claude`: runs the read-only doctor (not an install), dir arg honored, exit code from the doctor; equals `tpm doctor <dir>`', () => {
  const work = mkScratch('tpm-plugin-doctor-e2e');
  const stubBin = path.join(work, 'bin'); fs.mkdirSync(stubBin);
  fs.writeFileSync(path.join(stubBin, 'claude'), '#!/bin/sh\nexit 1\n'); fs.chmodSync(path.join(stubBin, 'claude'), 0o755);
  const good = path.join(work, 'good'); fs.mkdirSync(good); fs.writeFileSync(path.join(good, 'package.json'), '{"name":"x"}');
  const bare = path.join(work, 'bare'); fs.mkdirSync(bare);
  const env = Object.assign({}, process.env, { PATH: stubBin + path.delimiter + path.dirname(process.execPath), HOME: work });
  delete env.TPM_PROJECT_ROOT; delete env.TPM_HOME;
  const go = (args) => { const r = spawnSync('node', [TPM, ...args], { encoding: 'utf8', env }); return { status: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
  const a = go(['plugin', 'doctor', good]);
  assert.strictEqual(a.status, 1, a.out);
  assert.ok(/✓ package\.json/.test(a.out) && !/Step 1\/5/.test(a.out), 'ran the doctor, saw the dir: ' + a.out);
  const b = go(['plugin', 'doctor', bare]);
  assert.ok(/✗ package\.json/.test(b.out), 'a different dir arg gives a different answer: ' + b.out);
  assert.strictEqual(go(['doctor', good]).out, a.out, 'flat `tpm doctor` is identical');
});

// ── help examples are real (punchlist 3.5 / cleanup): every `tpm <suite> <verb>` EXAMPLE in the top-level help
// must exist. Derive the list from the help text itself (lines after "Everything after the suite…"), then run
// `--help` on each example's leading verbs and require exit 0.
check('every example verb in the top-level help exists (derived from the help text; `--help` on each exits 0)', () => {
  const help = tpm('--help').out;
  const at = help.indexOf('Everything after the suite');
  assert.ok(at >= 0, 'help has the examples block');
  const examples = help.slice(at).split('\n').slice(1)
    .map((l) => l.trim().replace(/^npx\s+/, ''))
    .filter((l) => /^tpm\s+\S/.test(l));
  assert.ok(examples.length >= 2, 'found example lines: ' + JSON.stringify(examples));
  for (const ex of examples) {
    const words = ex.split(/\s+/).slice(1);            // drop the leading `tpm`
    const verbs = [];
    for (const w of words) { if (/^[a-z][a-z-]*$/.test(w) && verbs.length < 2) verbs.push(w); else break; }
    assert.ok(verbs.length >= 1, 'example has a verb: ' + ex);
    const r = tpm(...verbs, '--help');
    assert.strictEqual(r.status, 0, `example "${ex}": \`tpm ${verbs.join(' ')} --help\` exits ${r.status}: ${r.out.slice(0, 200)}`);
    assert.ok(!/unknown (command|verb)/i.test(r.out), `example "${ex}" names a nonexistent verb: ${r.out.slice(0, 200)}`);
  }
  assert.ok(!/session notes resume/.test(help), 'the retired `session notes resume` example is gone');
});

process.stdout.write(`\nPASS — ${count}/${count} tpm dispatch assertions green\n`);
