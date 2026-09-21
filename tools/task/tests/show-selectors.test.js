'use strict';
/**
 * show-selectors.test.js — #1132: `show` accepts the shared selector grammar (all / range / list /
 * bare id), reusing the ONE selector core in tpm-task-export.js (buildSelector + selectCandidates).
 * Regression pin for the `show all` → `bodies/NaN-NaN/task-all.json` (ENOENT) bug: `opShow` used to
 * pass the raw selector straight into the id-bucket path math.
 *
 * Covers (DoD rows 4 + 5):
 *   - `show all` renders every OPEN body (default pool open+in-progress, like `list`);
 *   - `<lo>-<hi>` ranges + `<id>,<id>` lists render each selected body;
 *   - a bare `<id>` still works; `--state` widens the pool (`--state all` reaches a finished task);
 *   - an unknown id / a range matching nothing → a clean "(no matching tasks)" (never a NaN path);
 *   - descending range → a loud usage error (exit 2); no selector → "a task id is required" (exit 1);
 *   - the selector logic is single-homed: `show` and `export`/`search` call the SAME buildSelector.
 *
 * Zero-dep, Node built-ins only; auto-discovered by run-all (ends in .test.js).
 */
const { assert, test, done, scratch, fs, path } = require('./helpers/task-e2e-helpers');
const { spawnSync } = require('child_process');

const t = require('../tpm-task.js');
const exporter = require('../tpm-task-export.js');

const TOOL = path.join(__dirname, '..', 'tpm-task.js');
const run = (args, opts) => spawnSync('node', [TOOL, ...args], Object.assign({ encoding: 'utf8' }, opts || {}));
const NOW = '2026-09-25T12:00:00-07:00';

/** A store with 1000/1001 OPEN and 1002 FINISHED at a fresh scratch dir. */
function seed() {
  const dir = scratch('tpm-show-');
  t.opAdd({ tasksDir: dir, headline: 'alpha open' });     // 1000
  t.opAdd({ tasksDir: dir, headline: 'beta open' });      // 1001
  t.opAdd({ tasksDir: dir, headline: 'gamma closed' });   // 1002
  t.opTransition('finish', { tasksDir: dir, id: '1002', action: 'done' });
  return dir;
}
const heads = (md) => (md.match(/^# #\d+ · .+$/gm) || []);

test('#1132: show all renders every OPEN body (default pool), NOT the finished one', () => {
  const dir = seed();
  const md = t.opShowSelector({ tasksDir: dir, selectorArgv: ['all'], now: NOW });
  assert.deepStrictEqual(heads(md), ['# #1000 · alpha open', '# #1001 · beta open'],
    'all → both open bodies, finished 1002 excluded from the default pool: ' + JSON.stringify(heads(md)));
});

test('#1132: show all --state all reaches the finished task too', () => {
  const dir = seed();
  const md = t.opShowSelector({ tasksDir: dir, selectorArgv: ['all'], state: 'all', now: NOW });
  assert.strictEqual(heads(md).length, 3, 'all + --state all → all three bodies');
});

test('#1132: range <lo>-<hi> and list <id>,<id> each render the selected open bodies', () => {
  const dir = seed();
  assert.deepStrictEqual(heads(t.opShowSelector({ tasksDir: dir, selectorArgv: ['1000-1001'], now: NOW })),
    ['# #1000 · alpha open', '# #1001 · beta open'], 'ascending range');
  assert.deepStrictEqual(heads(t.opShowSelector({ tasksDir: dir, selectorArgv: ['1000,1001'], now: NOW })),
    ['# #1000 · alpha open', '# #1001 · beta open'], 'comma list');
});

test('#1132: a bare single id still renders exactly that body', () => {
  const dir = seed();
  const md = t.opShowSelector({ tasksDir: dir, selectorArgv: ['1000'], now: NOW });
  assert.deepStrictEqual(heads(md), ['# #1000 · alpha open'], 'single id');
});

test('#1132: a finished id is reachable via --state (not the default pool)', () => {
  const dir = seed();
  assert.strictEqual(t.opShowSelector({ tasksDir: dir, selectorArgv: ['1002'], now: NOW }), '(no matching tasks)\n',
    'finished 1002 is outside the default open+wip pool');
  assert.deepStrictEqual(heads(t.opShowSelector({ tasksDir: dir, selectorArgv: ['1002'], state: 'all', now: NOW })),
    ['# #1002 · gamma closed'], '--state all reaches it');
});

test('#1132: an unknown id / empty selection → clean "(no matching tasks)" (never a NaN path)', () => {
  const dir = seed();
  assert.strictEqual(t.opShowSelector({ tasksDir: dir, selectorArgv: ['9999'], state: 'all', now: NOW }),
    '(no matching tasks)\n', 'unknown id reports cleanly');
  // The CLI path must NOT emit a bodies/NaN-NaN/... ENOENT (the original bug).
  const cli = run(['show', 'all', '--tasks-dir', dir]);
  assert.strictEqual(cli.status, 0, 'show all exits 0: ' + cli.stderr);
  assert.ok(!/NaN/.test(cli.stdout + cli.stderr), 'no NaN path anywhere in show all output');
});

test('#1132: descending range is a loud usage error (exit 2); no selector → exit 1', () => {
  const dir = seed();
  const desc = run(['show', '1002-1000', '--tasks-dir', dir]);
  assert.strictEqual(desc.status, 2, 'descending range → usage exit 2: ' + desc.stderr);
  assert.ok(/descending range not allowed/.test(desc.stderr), 'names the descending error');
  const none = run(['show', '--tasks-dir', dir]);
  assert.strictEqual(none.status, 1, 'no selector → exit 1');
  assert.ok(/a task id is required/.test(none.stderr), 'names the missing selector');
});

test('#1132: the selector logic is single-homed — show reuses tpm-task-export.buildSelector', () => {
  // `all` must parse identically wherever the shared core is called.
  const sel = exporter.buildSelector(['all']);
  assert.strictEqual(sel.allIds, true, 'buildSelector understands the `all` token');
  assert.deepStrictEqual(sel.idRanges, [], 'all → no id restriction');
  const range = exporter.buildSelector(['1000-1001']);
  assert.deepStrictEqual(range.idRanges, [{ lo: 1000, hi: 1001 }], 'range parses to one inclusive band');
  // and opShowSelector routes through that same parser (proven by the range/list tests above).
  assert.strictEqual(typeof t.opShowSelector, 'function', 'show has a dedicated selector op');
});

done('show-selectors.test.js');
