'use strict';
/**
 * session-hardening.test.js — mutation-targeted tests for the #1155 session half (test-writer round 1).
 * Complements session-compose / session-boot-survival / session-skeleton / overlay-config (no duplication):
 *   - CLI-level EMERGENCY_BOOT: an INTERNAL composer failure (render throws / config resolution throws /
 *     shipped template missing) still exits 0 and prints the literal procedure — through the real CLI.
 *   - degraded banner appears exactly once, first, for corrupt config.
 *   - END-TO-END stacking: proseInjections + readingList STACK across project+user layers into the composed
 *     output (project first), while an ordinary array (tasks.defaultListState) REPLACES.
 *   - skeleton extras: frontmatter has exactly name+description, `!`-pre-inject is the ONLY expansion and it is
 *     last, primary-path instruction names the same command.
 *
 * Run: node tools/session/tests/session-hardening.test.js
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const { spawnSync } = require('child_process');
const TOOL = path.join(__dirname, '..', 'tpm-session-compose.js');
const BUNDLE = path.join(__dirname, '..', '..', '..');
const c = require('../tpm-session-compose');
const overlay = require('../../lib/tpm-config-overlay');

function project(cfg) {
  const root = tmpDir('hard-');
  fs.mkdirSync(path.join(root, '.claude', 'claude-tpm'), { recursive: true });
  if (cfg !== undefined) fs.writeFileSync(path.join(root, '.claude', 'claude-tpm', 'config.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
  return root;
}
function baseEnv(root, extra) {
  const env = Object.assign({}, process.env, { CLAUDE_TPM_USER_CONFIG: '', TPM_PROJECT_ROOT: root }, extra || {});
  delete env.TPM_SESSIONS_DIR; delete env.TPM_DEFAULTS_FILE;
  return Object.assign(env, extra || {});
}
/** Run the composer CLI with a `node -r` preload that sabotages internals. */
function cliSabotaged(preloadSrc, args, root) {
  const pre = path.join(tmpDir('pre-'), 'sabotage.js');
  fs.writeFileSync(pre, preloadSrc.replace(/__BUNDLE__/g, JSON.stringify(BUNDLE)));
  const r = spawnSync(process.execPath, ['-r', pre, TOOL, ...args], { encoding: 'utf8', env: baseEnv(root), cwd: root });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const STEPS = ['tpm session current --open', 'tpm session config --json', 'tpm reading-list orchestrator', 'tpm session boot-read', 'tpm session current --state'];
function assertEmergency(r, label, msgFragment) {
  assert.strictEqual(r.code, 0, `${label}: must exit 0 (stderr: ${r.err.slice(0, 200)})`);
  assert.ok(r.out.includes('EMERGENCY BOOT'), `${label}: EMERGENCY BOOT header\n${r.out.slice(0, 300)}`);
  for (const s of STEPS) assert.ok(r.out.includes(s), `${label}: missing step "${s}"`);
  assert.ok(!r.out.includes('{MSG}'), `${label}: {MSG} placeholder must be substituted`);
  if (msgFragment) assert.ok(r.out.includes(msgFragment), `${label}: failure message surfaced`);
  assert.ok(!/npx tpm/.test(r.out));
}

// ── fallback-primary boot-survival through the real CLI ──
test('CLI: engine render() throwing => exit 0 + EMERGENCY_BOOT with the failure message', () => {
  const root = project('{}');
  const r = cliSabotaged(`const t = require(require('path').join(__BUNDLE__, 'tools', 'lib', 'tpm-template')); t.render = () => { throw new Error('render-kaboom'); };`,
    ['--mode', 'open'], root);
  assertEmergency(r, 'render throws', 'render-kaboom');
});
test('CLI: config resolution throwing (resolveConfig) => exit 0 + EMERGENCY_BOOT', () => {
  const root = project('{}');
  const r = cliSabotaged(`const t = require(require('path').join(__BUNDLE__, 'tools', 'lib', 'tpm-template')); t.resolveConfig = () => { throw new Error('cfg-kaboom'); };`,
    ['--mode', 'open'], root);
  assertEmergency(r, 'resolveConfig throws', 'cfg-kaboom');
});
test('CLI: EVERY mode survives a sabotaged engine with a non-empty procedure (save/close/info/auto)', () => {
  const root = project('{}');
  for (const m of ['save', 'close', 'info', 'auto', '']) {
    const r = cliSabotaged(`const t = require(require('path').join(__BUNDLE__, 'tools', 'lib', 'tpm-template')); t.render = () => { throw new Error('x'); };`, ['--mode', m], root);
    assertEmergency(r, `mode "${m}"`);
  }
});
test('compose(): shipped template missing (templatesDir empty) => emergency result, not a throw; open + save', () => {
  const empty = tmpDir('notpl-');
  for (const m of ['open', 'save']) {
    let r; assert.doesNotThrow(() => { r = c.compose(m, { config: overlay.loadDefaults(), templatesDir: empty, pickup: 'P', projectRoot: empty, env: {} }); });
    assert.strictEqual(r.emergency, true); assert.strictEqual(r.kind, 'emergency');
    assert.ok(r.text.includes('tpm session current --open') && r.text.includes('shipped template missing'));
  }
});
test('EMERGENCY_BOOT literal: carries all 5 boot steps, a {MSG} slot, doctor pointer, bare tpm', () => {
  for (const s of STEPS) assert.ok(c.EMERGENCY_BOOT.includes(s), s);
  assert.ok(c.EMERGENCY_BOOT.includes('{MSG}') && c.EMERGENCY_BOOT.includes('tpm session doctor'));
  assert.ok(!/npx tpm/.test(c.EMERGENCY_BOOT));
});
test('NON-emergency paths do not print EMERGENCY (healthy open, corrupt config, ambiguous, reap)', () => {
  const root = project('{ corrupt');
  for (const a of ['open', 'save', 'zzz', 'reap']) {
    const r = c.compose(a, { projectRoot: root, env: { CLAUDE_TPM_USER_CONFIG: '' }, pickup: 'P', sessionsDir: path.join(root, 's') });
    assert.strictEqual(r.emergency, false, a); assert.ok(!r.text.includes('EMERGENCY BOOT'), a);
  }
});
test('corrupt project config: degraded banner is the FIRST line, appears exactly once, procedure follows', () => {
  const root = project('{ not json');
  const r = spawnSync(process.execPath, [TOOL, '--mode', 'open'], { encoding: 'utf8', env: baseEnv(root), cwd: root });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.startsWith('> WARNING: tpm degraded config ('), r.stdout.slice(0, 120));
  assert.strictEqual(r.stdout.split('WARNING: tpm degraded config').length, 2, 'exactly one banner (engine banner suppressed)');
  assert.ok(r.stdout.includes('tpm session current --open') && r.stdout.includes('tpm reading-list orchestrator'));
});
test('healthy config: NO banner at all', () => {
  const root = project('{}');
  const r = c.compose('open', { projectRoot: root, env: { CLAUDE_TPM_USER_CONFIG: '' }, pickup: 'P', sessionsDir: path.join(root, 's') });
  assert.ok(!/degraded config/.test(r.text));
});
test('empty-config fallback keeps the MINIMAL procedure: module-gated steps still render (tasks/notes ON)', () => {
  const root = project('{}');
  const r = spawnSync(process.execPath, [TOOL, '--mode', 'open'], { encoding: 'utf8', cwd: root,
    env: baseEnv(root, { TPM_DEFAULTS_FILE: path.join(root, 'absent.json') }) });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('tpm task list') && r.stdout.includes('Prior session pickup'), r.stdout.slice(0, 600));
});

// ── layered stacking, end to end ──
test('E2E stacking: proseInjections from project + user layers BOTH reach the composed open (project first, deduped)', () => {
  const root = project({ session: { proseInjections: [{ mode: 'open', file: 'p.md', location: 'after' }] } });
  fs.writeFileSync(path.join(root, 'p.md'), 'PROJECT-PROSE\n');
  fs.writeFileSync(path.join(root, 'u.md'), 'USER-PROSE\n');
  const userDir = tmpDir('hard-user-');
  const userCfg = path.join(userDir, 'user.json');
  fs.writeFileSync(userCfg, JSON.stringify({ session: { proseInjections: [
    { mode: 'open', file: 'p.md', location: 'after' }, { mode: 'open', file: 'u.md', location: 'after' }] } }));
  const t = c.compose('open', { projectRoot: root, env: { CLAUDE_TPM_USER_CONFIG: userCfg }, pickup: 'P', sessionsDir: path.join(root, 's') }).text;
  const ip = t.indexOf('PROJECT-PROSE'); const iu = t.indexOf('USER-PROSE');
  assert.ok(ip > 0 && iu > ip, `both present, project then user (${ip},${iu})`);
  assert.strictEqual(t.split('PROJECT-PROSE').length, 2, 'dedup: identical entry in both layers renders once');
  assert.strictEqual(t.split('USER-PROSE').length, 2);
});
test('E2E stacking: readingList from project + user layers BOTH appear in the composed open, in layer order', () => {
  const root = project({ session: { readingList: [{ audience: 'all', file: 'a.md' }] } });
  fs.writeFileSync(path.join(root, 'a.md'), 'a'); fs.writeFileSync(path.join(root, 'b.md'), 'b');
  const userCfg = path.join(tmpDir('hard-user-'), 'user.json');
  fs.writeFileSync(userCfg, JSON.stringify({ session: { readingList: [{ audience: 'orchestrator', file: 'b.md' }] } }));
  const t = c.compose('open', { projectRoot: root, env: { CLAUDE_TPM_USER_CONFIG: userCfg }, pickup: 'P', sessionsDir: path.join(root, 's') }).text;
  const ia = t.indexOf('`a.md`'); const ib = t.indexOf('`b.md`');
  assert.ok(ia > 0 && ib > ia, `a.md then b.md (${ia},${ib})`);
});
test('resolveLayers: stacking arrays STACK while sibling arrays REPLACE (same call, same layers)', () => {
  const root = project({
    session: { proseInjections: [{ mode: 'open', file: 'p.md', location: 'before' }], readingList: [{ audience: 'all', file: 'a.md' }] },
    tasks: { defaultListState: ['open', 'in-progress'] }, workflow: { blockedFilenamePatterns: ['AAA'] },
  });
  const userCfg = path.join(tmpDir('hard-user-'), 'user.json');
  fs.writeFileSync(userCfg, JSON.stringify({
    session: { proseInjections: [{ mode: 'save', file: 'u.md', location: 'after' }], readingList: [{ audience: 'all', file: 'b.md' }] },
    tasks: { defaultListState: ['done'] }, workflow: { blockedFilenamePatterns: ['BBB'] },
  }));
  const r = overlay.resolveLayers({ projectRoot: root, env: { CLAUDE_TPM_USER_CONFIG: userCfg } });
  assert.strictEqual(r.session.proseInjections.length, 2, 'proseInjections stacks');
  assert.strictEqual(r.session.readingList.length, 2, 'readingList stacks');
  assert.deepStrictEqual(r.tasks.defaultListState, ['done'], 'defaultListState replaces');
  assert.deepStrictEqual(r.workflow.blockedFilenamePatterns, ['BBB'], 'blockedFilenamePatterns replaces');
});
test('ADDITIVE_ARRAYS is exactly the two session arrays (no accidental widening)', () => {
  assert.deepStrictEqual([...overlay.ADDITIVE_ARRAYS].sort(), ['session.proseInjections', 'session.readingList']);
});
test('defaults ship the new keys empty so stacking starts from []', () => {
  const d = overlay.loadDefaults();
  assert.deepStrictEqual(d.session.proseInjections, []); assert.deepStrictEqual(d.session.readingList, []);
  assert.deepStrictEqual(d.session.templates, { open: '', save: '', close: '' });
});

// ── skeleton extras ──
const SKILL = fs.readFileSync(path.join(BUNDLE, '.claude', 'skills', 'tpm-session', 'SKILL.md'), 'utf8');
test('skeleton: frontmatter keys are exactly name + description (no allowed-tools/model/hooks)', () => {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(SKILL)[1];
  const keys = fm.split('\n').filter((l) => /^[a-z-]+:/.test(l)).map((l) => l.split(':')[0]);
  assert.deepStrictEqual(keys, ['name', 'description']);
});
test('skeleton: exactly one `!`-expansion, it is the LAST line, and it is the same compose verb as the primary path', () => {
  const bangs = SKILL.split('\n').filter((l) => /^!`/.test(l));
  assert.strictEqual(bangs.length, 1);
  assert.ok(SKILL.trimEnd().split('\n').pop().startsWith('!`tpm session compose'));
  assert.ok(/run\s*\n?`tpm session compose --mode /.test(SKILL), 'primary path instructs running the same verb');
  assert.ok(Buffer.byteLength(SKILL) < 3000, `skeleton stays tiny (${Buffer.byteLength(SKILL)} bytes)`);
});
test('skeleton: boot procedure does NOT live only behind the placeholder (SKILL.md names the fallback + footer cue)', () => {
  assert.ok(/Primary path/.test(SKILL) && /unless the block below already holds/.test(SKILL));
  assert.ok(/read-only and safe to run twice/.test(SKILL));
});
test('composed output never leaks the skeleton-forbidden pre-auth: no `allowed-tools` text in any mode', () => {
  for (const m of ['open', 'save', 'close', 'info']) {
    const t = c.compose(m, { config: overlay.loadDefaults(), projectRoot: BUNDLE, pickup: 'P', sessionsDir: '/nonexistent', env: {} }).text;
    assert.ok(!/allowed-tools/.test(t), m);
  }
});

done('session-hardening.test');
