'use strict';
/**
 * task-root-env.test.js — the task suite resolves the project from $TPM_PROJECT_ROOT (D8, punchlist 3.3).
 *
 * Real CLI runs (`tpm-task.js`) from a cwd that is NOT the project — a subfolder of another project, an
 * unrelated temp dir — with TPM_PROJECT_ROOT pointing at the fixture project. The fixture holds a task
 * the other project does not, so reading the wrong store is detectable. Also proves explicit --tasks-dir
 * still beats the env, and a bad env value falls back to the walk-up with a warning.
 *
 * Run: node tests/task-root-env.test.js
 */
const { assert, test, done, fs, path } = require('./helpers/task-e2e-helpers');
const os = require('os');
const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const { spawnSync } = require('child_process');

const TOOL = path.join(__dirname, '..', 'tpm-task.js');

function run(args, cwd, envRoot) {
  const env = { ...process.env };
  delete env.TPM_PROJECT_ROOT;
  delete env.TPM_TASKS_DIR;
  if (envRoot !== undefined) env.TPM_PROJECT_ROOT = envRoot;
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd, env, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function mkProject(base, name) {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, '.claude', 'claude-tpm'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  return root;
}

const base = fs.realpathSync(tmpDir('tpm-task-rootenv-'));
const fixture = mkProject(base, 'fixture');
const other = mkProject(base, 'other');
const unrelated = path.join(base, 'unrelated');
fs.mkdirSync(unrelated);

// Seed distinct tasks, each via the env so each lands in its own project's store.
assert.strictEqual(run(['add', '--headline', 'FIXTURE-ONLY-TASK'], unrelated, fixture).code, 0);
assert.strictEqual(run(['add', '--headline', 'OTHER-ONLY-TASK'], unrelated, other).code, 0);

test('seeding went to the env project store, not cwd', () => {
  assert.ok(fs.existsSync(path.join(fixture, '.claude', 'claude-tpm', 'tasks')));
  assert.ok(!fs.existsSync(path.join(unrelated, '.claude')), 'no store created in the unrelated cwd');
});

test('`task list` from an unrelated cwd + env=fixture reads the fixture store', () => {
  const r = run(['list'], unrelated, fixture);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes('FIXTURE-ONLY-TASK'), r.stdout);
  assert.ok(!r.stdout.includes('OTHER-ONLY-TASK'));
});

test('`task list` from a subfolder of ANOTHER project + env=fixture reads the fixture store (env beats cwd)', () => {
  const r = run(['list'], path.join(other, 'sub'), fixture);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes('FIXTURE-ONLY-TASK'));
  assert.ok(!r.stdout.includes('OTHER-ONLY-TASK'));
});

test('env unset: `task list` from a subfolder walks up to its own project (unchanged behavior)', () => {
  const r = run(['list'], path.join(other, 'sub'));
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes('OTHER-ONLY-TASK'));
  assert.ok(!r.stdout.includes('FIXTURE-ONLY-TASK'));
});

test('explicit --tasks-dir beats the env', () => {
  const r = run(['list', '--tasks-dir', path.join(other, '.claude', 'claude-tpm', 'tasks')], unrelated, fixture);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes('OTHER-ONLY-TASK'));
  assert.ok(!r.stdout.includes('FIXTURE-ONLY-TASK'));
});

test('bad env value: warns on stderr naming TPM_PROJECT_ROOT, falls through to the cwd walk-up', () => {
  const r = run(['list'], path.join(other, 'sub'), path.join(base, 'nope'));
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(r.stderr.includes('TPM_PROJECT_ROOT'), r.stderr);
  assert.ok(r.stdout.includes('OTHER-ONLY-TASK'));
});

test('no env, cwd outside any project: fails loud (no silent store) and says why', () => {
  const r = run(['list'], unrelated);
  assert.notStrictEqual(r.code, 0, 'must not succeed against a guessed store');
  assert.ok(r.stderr.includes('.claude/claude-tpm'), r.stderr);
  assert.ok(!fs.existsSync(path.join(unrelated, '.claude')), 'no store written in the cwd');
});

done('task-root-env');
