'use strict';
/**
 * smoke-fixes.test.js — pins the Stage-D first-run smoke UX fixes for the TASK suite.
 *
 * Covers:
 *   F2 — `task show`'s history hint is a FULLY RUNNABLE command (npx tpm … --tasks-dir "<dir>").
 *   F3 — a required-arg (or any) error prints the `tpm-task:` prefix EXACTLY ONCE (never doubled).
 *   F4 — `--tasks-dir` is OPTIONAL: flag > local project config.json > FAIL LOUD (never a live default).
 *   F5 — `add-subtask` / `check` accept the subtask key as a POSITIONAL and as `--key`.
 *
 * Zero-dep, Node built-ins only; auto-discovered by run-all (ends in .test.js).
 */
const { assert, test, done, scratch, fs, model } = require('./helpers/task-e2e-helpers');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const t = require('../tpm-task.js');
const conv = require('../lib/task-converter.js');
const cfg = require('../tpm-task-config.js');

const TOOL = path.join(__dirname, '..', 'tpm-task.js');
const run = (args, opts) => spawnSync('node', [TOOL, ...args], Object.assign({ encoding: 'utf8' }, opts || {}));

/** A store with one saved task (id 1000) at `tasksDir`. */
function seedStore(dir) {
  const rec = model.openTask({ headline: 'smoke task', tasksDir: dir });
  model.saveTask(rec, { tasksDir: dir, render: conv.render, indexRender: conv.renderIndexView });
  return dir;
}

/** A scratch PROJECT root: the `.claude/claude-tpm/` install-footprint marker + a config.json (no CLAUDE.md). */
function scratchProject(rel) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-proj-'));
  // The project-root MARKER is the `.claude/claude-tpm/` install footprint (NOT CLAUDE.md). It is
  // created here as the parent of config.json, so the marker is present without any CLAUDE.md.
  fs.mkdirSync(path.join(root, '.claude', 'claude-tpm'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude', 'claude-tpm', 'config.json'),
    JSON.stringify({ version: 1, tasks: { tasksDir: rel } }, null, 2) + '\n',
  );
  return root;
}

// ── F2 ────────────────────────────────────────────────────────────────────────────
test('F2: task show history hint is fully runnable (npx tpm … --tasks-dir "<dir>")', () => {
  const rec = model.openTask({ headline: 'h', tasksDir: scratch('tpm-f2-') });
  rec.history = [{ at: '2026-09-19T09:00:00-07:00', op: 'create' }];
  const md = conv.render(rec, { now: '2026-09-19T10:00:00-07:00', tasksDir: '/scratch/x y' });
  assert.ok(md.includes('see `npx tpm task history ' + rec.id + ' --tasks-dir "/scratch/x y"`._'),
    'inlines the resolved --tasks-dir, quoted');
  // With NO tasksDir (the persisted body) the hint still carries the flag shape (portable placeholder).
  const bare = conv.render(rec, { now: '2026-09-19T10:00:00-07:00' });
  assert.ok(bare.includes('see `npx tpm task history ' + rec.id + ' --tasks-dir <dir>`._'),
    'placeholder form still names --tasks-dir + uses npx command-emission');
  assert.ok(bare.indexOf('see `tpm task history') === -1, 'no bare (non-npx) command emitted');
});

// ── F3 ────────────────────────────────────────────────────────────────────────────
test('F3: an op-thrown (already-prefixed) error prints tpm-task: exactly ONCE (never doubled)', () => {
  // `show` with a valid store but NO id makes loadCurrent throw a message that already carries the
  // `tpm-task:` prefix — the exact shape that used to double (`tpm-task: tpm-task: a task id is required`).
  const dir = seedStore(scratch('tpm-f3-'));
  const r = run(['show', '--tasks-dir', dir]);
  assert.strictEqual(r.status, 1, 'missing id fails (exit 1)');
  const hits = (r.stderr.match(/tpm-task:/g) || []).length;
  assert.strictEqual(hits, 1, `exactly one tpm-task: prefix, got ${hits} in: ${r.stderr}`);
  assert.ok(!/tpm-task: tpm-task:/.test(r.stderr), 'no doubled tpm-task: tpm-task:');
  assert.ok(/a task id is required/.test(r.stderr), 'the underlying message survives');
});

test('F3: prefixOnce strips an already-prefixed message but keeps a sub-scope prefix', () => {
  assert.strictEqual(t.prefixOnce('tpm-task: ', 'tpm-task: boom'), 'tpm-task: boom', 'strips the doubled tool prefix');
  assert.strictEqual(t.prefixOnce('tpm-task: ', 'check: a key is required'),
    'tpm-task: check: a key is required', 'leaves a non-tool sub-scope prefix intact');
});

// ── F4 ────────────────────────────────────────────────────────────────────────────
test('F4: resolveTasksDir — flag wins, else local project config, else FAIL LOUD', () => {
  // 1. explicit flag wins.
  assert.strictEqual(cfg.resolveTasksDir('/explicit/dir').tasksDir, '/explicit/dir', 'flag overrides');
  // 2. local project config.json (`.claude/claude-tpm/`-marked) resolves.
  const proj = scratchProject('.claude/claude-tpm/tasks');
  const res = cfg.resolveTasksDir(undefined, undefined, { startDir: proj });
  assert.strictEqual(res.source, 'config', 'resolved from config');
  assert.strictEqual(res.tasksDir, path.join(proj, '.claude', 'claude-tpm', 'tasks'), 'config tasksDir (project-relative)');
  // 3. no flag AND no local project (no `.claude/claude-tpm/` marker) → FAIL LOUD, never a live default.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-f4-bare-'));
  assert.throws(() => cfg.resolveTasksDir(undefined, undefined, { startDir: bare }), /--tasks-dir is required/,
    'no flag + no local config throws loud');
});

test('F4: CLI works with NO --tasks-dir inside a project, and FAILS LOUD outside one', () => {
  const proj = scratchProject('.claude/claude-tpm/tasks');
  const ok = run(['add', '--headline', 'via config'], { cwd: proj });
  assert.strictEqual(ok.status, 0, `add with no flag resolves from config: ${ok.stderr}`);
  assert.ok(fs.existsSync(path.join(proj, '.claude', 'claude-tpm', 'tasks', 'tasks-index.json')),
    'wrote to the config-resolved store, not a live one');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-f4-cli-'));
  const fail = run(['list'], { cwd: bare });
  assert.strictEqual(fail.status, 1, 'no flag + no project fails loud (exit 1)');
  assert.ok(/--tasks-dir is required/.test(fail.stderr), 'names the flag in the loud error');
});

test('F4: the explicit --tasks-dir flag still overrides (existing tests\' path stays green)', () => {
  const dir = seedStore(scratch('tpm-f4-flag-'));
  const r = run(['list', '--tasks-dir', dir]);
  assert.strictEqual(r.status, 0, 'explicit flag path works');
});

// ── #1132: precedence arg > env > local config > project-local default > FAIL LOUD ──────────────────
test('#1132: TPM_TASKS_DIR env resolves (source env) when no flag; the flag still outranks it', () => {
  const env = { TPM_TASKS_DIR: '/from/env/store' };
  const e = cfg.resolveTasksDir(undefined, undefined, { env });
  assert.strictEqual(e.tasksDir, '/from/env/store', 'env resolves');
  assert.strictEqual(e.source, 'env', 'source is env');
  const both = cfg.resolveTasksDir('/flag/store', undefined, { env });
  assert.strictEqual(both.source, 'flag', 'an explicit flag outranks the env var');
  assert.strictEqual(both.tasksDir, '/flag/store');
});

test('#1132: inside a `.claude/claude-tpm/`-marked project with NO config.json → SAFE project-local default', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-1132-def-'));
  fs.mkdirSync(path.join(root, '.claude', 'claude-tpm'), { recursive: true });   // install-footprint marker, NO config.json
  const res = cfg.resolveTasksDir(undefined, undefined, { startDir: root, env: {} });
  assert.strictEqual(res.source, 'default', 'resolved via the project-local default');
  assert.strictEqual(res.tasksDir, path.join(root, '.claude', 'claude-tpm', 'tasks'),
    'default is <root>/.claude/claude-tpm/tasks');
  assert.ok(res.tasksDir.startsWith(root), 'the default stays INSIDE the project root (never a global/live store)');
});

test('marker-swap: a CLAUDE.md-only tree (no `.claude/claude-tpm/`) NO LONGER auto-defaults → FAILS LOUD', () => {
  // The marker was REPLACED (was CLAUDE.md). A bare CLAUDE.md is no longer a project-root signal.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-1132-claudemd-'));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# marker\n');   // CLAUDE.md ONLY — no install footprint
  assert.throws(() => cfg.resolveTasksDir(undefined, undefined, { startDir: root, env: {} }),
    /--tasks-dir is required/, 'CLAUDE.md alone must not auto-resolve a store');
});

test('#1132: a config.json tasksDir OUTRANKS the bare default (source config, project-relative)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-1132-cfg-'));
  fs.mkdirSync(path.join(root, '.claude', 'claude-tpm'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'claude-tpm', 'config.json'),
    JSON.stringify({ version: 1, tasks: { tasksDir: 'custom-store' } }) + '\n');
  const res = cfg.resolveTasksDir(undefined, undefined, { startDir: root, env: {} });
  assert.strictEqual(res.source, 'config', 'config wins over the default');
  assert.strictEqual(res.tasksDir, path.join(root, 'custom-store'), 'uses the config tasksDir, project-relative');
});

test('#1132: CLI — a verb resolves the project-local default with NO flag/config, and STILL refuses outside a project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-1132-cli-'));
  fs.mkdirSync(path.join(root, '.claude', 'claude-tpm'), { recursive: true });   // install-footprint marker only, no config.json
  const ok = run(['add', '--headline', 'via project-local default'], { cwd: root });
  assert.strictEqual(ok.status, 0, 'add with no flag/config resolves the default: ' + ok.stderr);
  assert.ok(fs.existsSync(path.join(root, '.claude', 'claude-tpm', 'tasks', 'tasks-index.json')),
    'wrote to the project-local default store');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-1132-bare-'));
  const fail = run(['list'], { cwd: bare });
  assert.strictEqual(fail.status, 1, 'no flag, no env, no project marker → FAILS LOUD (exit 1)');
  assert.ok(/--tasks-dir is required/.test(fail.stderr), 'still refuses to default to a live store outside a project');
});

// ── F5 ────────────────────────────────────────────────────────────────────────────
test('F5: resolveSubtaskKey accepts the key as a positional AND as --key (both verbs)', () => {
  assert.strictEqual(t.resolveSubtaskKey({ positional: ['1000', 's1'] }), 's1', 'positional after id');
  assert.strictEqual(t.resolveSubtaskKey({ key: 'sX', positional: ['1000'] }), 'sX', '--key wins');
  assert.strictEqual(t.resolveSubtaskKey({ id: '1000', positional: ['s2'] }), 's2', 'first positional when id via --id');
});

test('F5: add-subtask + check accept the key both ways end-to-end', () => {
  const dir = seedStore(scratch('tpm-f5-'));
  assert.strictEqual(run(['add-subtask', '--tasks-dir', dir, '1000', 'p1', '--text', 'positional add']).status, 0, 'add-subtask positional key');
  assert.strictEqual(run(['add-subtask', '--tasks-dir', dir, '1000', '--key', 'f1', '--text', 'flag add']).status, 0, 'add-subtask --key');
  assert.strictEqual(run(['check', '--tasks-dir', dir, '1000', 'p1']).status, 0, 'check positional key');
  assert.strictEqual(run(['check', '--tasks-dir', dir, '1000', '--key', 'f1']).status, 0, 'check --key');
  const rec = model.loadTask(model.bodyPathFor(dir, '1000'));
  const byKey = Object.fromEntries(rec.subtasks.map((s) => [s.key, s.state]));
  assert.strictEqual(byKey.p1, 'done', 'positional-added subtask checked done');
  assert.strictEqual(byKey.f1, 'done', 'flag-added subtask checked done');
});

done('smoke-fixes.test.js');
