'use strict';
/**
 * session-boot-survival.test.js — `tpm session compose` (the composer verb) must exit 0 and print a USABLE boot
 * procedure in every failure case (#1155 boot-survival is non-negotiable): no config, corrupt project config,
 * unreadable defaults, empty sessions dir, no project marker.
 *
 * Run: node tests/session-boot-survival.test.js
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const { spawnSync } = require('child_process');
const TOOL = path.join(__dirname, '..', 'tpm-session-compose.js');
const BUNDLE = path.join(__dirname, '..', '..', '..');

function cli(args, envOver, cwd) {
  const env = Object.assign({}, process.env, { CLAUDE_TPM_USER_CONFIG: '' }, envOver || {});
  delete env.TPM_PROJECT_ROOT; delete env.TPM_SESSIONS_DIR; delete env.TPM_DEFAULTS_FILE;
  Object.assign(env, envOver || {});
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env, cwd });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
function project(configText) {
  const root = tmpDir('surv-');
  fs.mkdirSync(path.join(root, '.claude', 'claude-tpm'), { recursive: true });
  if (configText !== undefined) fs.writeFileSync(path.join(root, '.claude', 'claude-tpm', 'config.json'), configText);
  return root;
}
const KEY = ['tpm session current --open', 'tpm reading-list orchestrator'];
function assertBootable(r, label) {
  assert.strictEqual(r.code, 0, `${label}: exit 0`);
  for (const k of KEY) assert.ok(r.out.includes(k), `${label}: missing "${k}"\n${r.out.slice(0, 400)}`);
  assert.ok(!/npx tpm/.test(r.out), `${label}: no npx`);
}

test('healthy project: exit 0, full open procedure', () => {
  const root = project('{}');
  assertBootable(cli(['--mode', 'open'], { TPM_PROJECT_ROOT: root }, root), 'healthy');
});
test('no project config file at all', () => {
  const root = project();
  assertBootable(cli(['--mode', 'open'], { TPM_PROJECT_ROOT: root }, root), 'no config');
});
test('CORRUPT project config.json => exit 0, degraded banner, procedure still complete', () => {
  const root = project('{ not json');
  const r = cli(['--mode', 'open'], { TPM_PROJECT_ROOT: root }, root);
  assertBootable(r, 'corrupt');
  assert.ok(/WARNING: tpm degraded config/.test(r.out) && /tpm doctor/.test(r.out));
});
test('UNREADABLE shipped defaults (empty-config fallback) => exit 0, banner, procedure NOT hollow', () => {
  const root = project('{}');
  const r = cli(['--mode', 'open'], { TPM_PROJECT_ROOT: root, TPM_DEFAULTS_FILE: path.join(root, 'nope.json') }, root);
  assertBootable(r, 'no defaults');
  assert.ok(/WARNING: tpm degraded config/.test(r.out));
});
test('corrupt USER layer is skipped (not degraded); boot unaffected', () => {
  const root = project('{}');
  const bad = path.join(root, 'user.json'); fs.writeFileSync(bad, '{{{');
  const r = cli(['--mode', 'open'], { TPM_PROJECT_ROOT: root, CLAUDE_TPM_USER_CONFIG: bad }, root);
  assertBootable(r, 'bad user layer');
  assert.ok(!/degraded config/.test(r.out));
});
test('empty sessions dir + outside any project marker => still exit 0 with a procedure', () => {
  const bare = tmpDir('surv-bare-');
  assertBootable(cli(['--mode', 'open'], {}, bare), 'no marker');
});
test('bare invocation / garbage / reap tokens all exit 0 with non-empty output', () => {
  const root = project('{}');
  for (const args of [[], ['--mode'], ['--mode', ''], ['--mode', 'zzz'], ['--mode', 'reap'], ['--mode', 'save', 'my', 'notes']]) {
    const r = cli(args, { TPM_PROJECT_ROOT: root }, root);
    assert.strictEqual(r.code, 0, JSON.stringify(args)); assert.ok(r.out.trim().length > 20, JSON.stringify(args));
  }
});
test('through the real router: `tpm session compose --help` exits 0 and lists --mode', () => {
  const r = spawnSync(process.execPath, [path.join(BUNDLE, 'tools', 'tpm.js'), 'session', 'compose', '--help'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0); assert.ok(r.stdout.includes('--mode')); assert.ok(!/npx tpm/.test(r.stdout));
});

done('session-boot-survival.test');
