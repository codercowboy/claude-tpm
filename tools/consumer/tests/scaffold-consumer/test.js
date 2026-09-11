#!/usr/bin/env node
/**
 * test.js — unit test for scaffold-consumer.js. Zero-dep (node assert). Drives the pure content
 * builders directly and runs scaffoldConsumer end-to-end into a temp dir, asserting the two files the
 * consumer-adoption mechanism hinges on: `.claude/claude-tpm/config.json` (config source of truth) and
 * the generated `.claude/settings.json` (env.TPM_HOME + expand/gate hooks, idempotent merge).
 *
 * Usage:  node tools/consumer/tests/scaffold-consumer/test.js   → exit 0 all pass, 1 otherwise.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const S = require('../../scaffold-consumer.js');

let pass = 0; let fail = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ✓ ${name}\n`); pass += 1; }
  catch (e) { process.stdout.write(`  ✗ ${name}\n      ${e.message}\n`); fail += 1; }
}
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'scaf-test-')); }

// ── pure content builders ────────────────────────────────────────────────────

check('pkgJson: @codercowboy name, MIT, file: dep on claude-tpm', () => {
  const p = JSON.parse(S.pkgJson({ name: '@codercowboy/demo', repo: 'demo', author: 'Jason Baker', authorEmail: 'j@x', githubUser: 'codercowboy', depPath: '../claude-admin' }));
  assert.strictEqual(p.name, '@codercowboy/demo');
  assert.strictEqual(p.license, 'MIT');
  assert.strictEqual(p.dependencies[S.TPM_PKG_NAME], 'file:../claude-admin');
});

check('claudeMd: points at the vendored boot.md', () => {
  const md = S.claudeMd({ repo: 'demo' });
  assert(md.includes(`${S.TPM_PKG_NAME}/boot.md`), 'must direct boot to the vendored boot.md');
});

check('tpmConfigJson: bundle.home is the relative vendored path', () => {
  const c = JSON.parse(S.tpmConfigJson());
  assert.strictEqual(c.bundle.home, S.TPM_BUNDLE_HOME);
  assert.strictEqual(c.bundle.home, 'node_modules/@codercowboy/claude-tpm');
  assert.strictEqual(c.session.enabled, true);
});

check('settingsObject: env.TPM_HOME + both hooks, ${CLAUDE_PROJECT_DIR} command paths', () => {
  const s = S.settingsObject(S.TPM_BUNDLE_HOME);
  assert.strictEqual(s.env.TPM_HOME, S.TPM_BUNDLE_HOME);
  const pre = s.hooks.PreToolUse;
  assert.strictEqual(pre.length, 2);
  const matchers = pre.map((e) => e.matcher);
  assert(matchers.includes('Agent|Task'), 'gate hook matcher');
  assert(matchers.some((m) => m.startsWith('Read')), 'expand hook matcher');
  const cmds = pre.flatMap((e) => e.hooks.map((h) => h.command)).join('\n');
  assert(cmds.includes('${CLAUDE_PROJECT_DIR}'), 'commands interpolate the project dir');
  assert(cmds.includes(`${S.TPM_BUNDLE_HOME}/tools/consumer/hooks/expand-tpm-home.js`), 'expand hook path');
  assert(cmds.includes(`${S.TPM_BUNDLE_HOME}/tools/workflow/hooks/gate-spawn.js`), 'gate hook path');
});

// ── mergeSettings ────────────────────────────────────────────────────────────

check('mergeSettings: fresh file → created, 2 hooks', () => {
  const d = tmp();
  try {
    const target = path.join(d, 'settings.json');
    const { text, action } = S.mergeSettings(target, S.TPM_BUNDLE_HOME);
    assert.strictEqual(action, 'created');
    const o = JSON.parse(text);
    assert.strictEqual(o.env.TPM_HOME, S.TPM_BUNDLE_HOME);
    assert.strictEqual(o.hooks.PreToolUse.length, 2);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

check('mergeSettings: idempotent (2nd merge adds 0 hooks) + preserves foreign config', () => {
  const d = tmp();
  try {
    const target = path.join(d, 'settings.json');
    // seed a settings.json with a foreign env key + a foreign hook we must not clobber.
    fs.writeFileSync(target, JSON.stringify({
      env: { MY_VAR: '1' },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard.sh' }] }] },
    }));
    const m1 = S.mergeSettings(target, S.TPM_BUNDLE_HOME);
    fs.writeFileSync(target, m1.text);
    const o1 = JSON.parse(m1.text);
    assert.strictEqual(o1.env.MY_VAR, '1', 'foreign env preserved');
    assert.strictEqual(o1.env.TPM_HOME, S.TPM_BUNDLE_HOME, 'ours added');
    assert.strictEqual(o1.hooks.PreToolUse.length, 3, '1 foreign + 2 ours');
    // 2nd merge → no new hooks.
    const m2 = S.mergeSettings(target, S.TPM_BUNDLE_HOME);
    assert(/\+0 hooks/.test(m2.action), `expected +0 hooks, got: ${m2.action}`);
    assert.strictEqual(JSON.parse(m2.text).hooks.PreToolUse.length, 3);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── end-to-end scaffold ──────────────────────────────────────────────────────

check('scaffoldConsumer: writes config.json + settings.json + core files', () => {
  const d = tmp();
  try {
    const target = path.join(d, 'my-consumer');
    const r = S.scaffoldConsumer(target, { quiet: true });
    assert.strictEqual(r.repo, 'my-consumer');
    assert(r.created.includes('package.json'));
    assert(r.created.includes('.claude/claude-tpm/config.json'));
    // config.json on disk
    const cfg = JSON.parse(fs.readFileSync(path.join(target, '.claude/claude-tpm/config.json'), 'utf8'));
    assert.strictEqual(cfg.bundle.home, S.TPM_BUNDLE_HOME);
    // settings.json on disk with 2 hooks
    const set = JSON.parse(fs.readFileSync(path.join(target, '.claude/settings.json'), 'utf8'));
    assert.strictEqual(set.env.TPM_HOME, S.TPM_BUNDLE_HOME);
    assert.strictEqual(set.hooks.PreToolUse.length, 2);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

check('scaffoldConsumer: re-run (force) keeps settings.json at 2 hooks (merge, no dupes)', () => {
  const d = tmp();
  try {
    const target = path.join(d, 'my-consumer');
    S.scaffoldConsumer(target, { quiet: true });
    S.scaffoldConsumer(target, { quiet: true, force: true });
    const set = JSON.parse(fs.readFileSync(path.join(target, '.claude/settings.json'), 'utf8'));
    assert.strictEqual(set.hooks.PreToolUse.length, 2, 'no duplicate hooks after a 2nd scaffold');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── into-existing merges ─────────────────────────────────────────────────────

check('mergePackageJson: adds dep, preserves everything, idempotent', () => {
  const d = tmp();
  try {
    const p = path.join(d, 'package.json');
    fs.writeFileSync(p, JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { express: '^4' }, scripts: { start: 'x' } }));
    const m1 = S.mergePackageJson(p, 'file:../claude-admin');
    const o1 = JSON.parse(m1.text);
    assert.strictEqual(m1.action, 'added dep');
    assert.strictEqual(o1.dependencies.express, '^4', 'foreign dep preserved');
    assert.strictEqual(o1.dependencies[S.TPM_PKG_NAME], 'file:../claude-admin');
    assert.strictEqual(o1.name, 'app'); assert(o1.scripts, 'scripts preserved');
    fs.writeFileSync(p, m1.text);
    assert.strictEqual(S.mergePackageJson(p, 'file:../claude-admin').action, 'dep unchanged'); // idempotent
    assert.strictEqual(S.mergePackageJson(p, 'file:../other').action, 'updated dep');           // spec change
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

check('mergeClaudeMd: appends boot block, preserves content, idempotent', () => {
  const d = tmp();
  try {
    const p = path.join(d, 'CLAUDE.md');
    fs.writeFileSync(p, '# App\n\nMy own instructions.\n');
    const m1 = S.mergeClaudeMd(p, 'app');
    assert.strictEqual(m1.action, 'appended boot block');
    assert(m1.text.includes('My own instructions.'), 'original preserved');
    assert(m1.text.includes('boot.md'), 'boot block added');
    assert.strictEqual((m1.text.match(/<!-- claude-tpm:boot -->/g) || []).length, 1);
    fs.writeFileSync(p, m1.text);
    assert.strictEqual(S.mergeClaudeMd(p, 'app').action, 'boot block already present'); // idempotent
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

check('mergeClaudeMd: creates a minimal CLAUDE.md if none exists', () => {
  const d = tmp();
  try {
    const p = path.join(d, 'CLAUDE.md');
    const m = S.mergeClaudeMd(p, 'demo-repo');
    assert.strictEqual(m.action, 'created with boot block');
    assert(m.text.startsWith('# demo-repo'));
    assert(m.text.includes('boot.md'));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

check('scaffoldConsumer: EXISTING project → merge mode (dep + boot block, README/LICENSE untouched)', () => {
  const d = tmp();
  try {
    const target = path.join(d, 'existing');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'x', dependencies: { react: '^18' } }));
    fs.writeFileSync(path.join(target, 'CLAUDE.md'), '# X\nkeep me\n');
    fs.writeFileSync(path.join(target, 'README.md'), 'keep readme\n');
    const r = S.scaffoldConsumer(target, { quiet: true });
    assert.strictEqual(r.mode, 'existing');
    const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.dependencies.react, '^18', 'foreign dep kept');
    assert(pkg.dependencies[S.TPM_PKG_NAME], 'claude-tpm dep added');
    const cmd = fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8');
    assert(cmd.includes('keep me') && cmd.includes('boot.md'), 'CLAUDE.md preserved + boot block');
    assert(fs.readFileSync(path.join(target, 'README.md'), 'utf8').includes('keep readme'), 'README untouched');
    assert(!fs.existsSync(path.join(target, 'LICENSE')), 'no LICENSE dropped into existing project');
    assert(fs.existsSync(path.join(target, '.claude/claude-tpm/config.json')), 'config created');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(target, '.claude/settings.json'), 'utf8')).hooks.PreToolUse.length, 2);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
