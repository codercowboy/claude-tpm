'use strict';
/**
 * dogfood-corpus.test.js (P08) — an adequacy / dogfood run against a REALISTIC synthetic corpus,
 * built THE REAL WAY through the entry-script ops (add / edit / add-subtask / check / lifecycle),
 * so every file on disk is a genuine canonical envelope + its real derived views. Covers the
 * lifecycle edges the corpus must survive:
 *   1000  in-progress, full (labels + summary + context), 3 subtasks (1 checked).
 *   1001  open, NULL summary + NULL context (renders `_None yet._` — the F3 edge), no subtasks.
 *   1002  finished, all subtasks checked (close-guard satisfied).
 *   1003  dropped (abandoned with an open subtask, F4).
 *   1004  removed (soft-stash).
 *
 * It then asserts the two claims the DoD pins:
 *   (a) JSON↔human ROUND-TRIP — each body JSON re-loads through the real read→migrate→validate path
 *       unchanged, AND the on-disk body `.md` is BYTE-EXACT to a fresh pure `render(loadedJSON)`
 *       (the body render reads no clock, so it is byte-stable);
 *   (b) reindex BYTE-STABLE — two reindexes off the same bodies produce identical rows/counts/nextId
 *       (modulo the generatedAt clock stamp), and `renderIndexView(idx,{states,now:NOW})` is
 *       byte-identical across repeated calls (deterministic with an injected reference time).
 *
 * NOTE (F5, decisions.md): the on-disk human index VIEW bytes are NOT byte-stable THROUGH a save,
 * because writeIndexViews stamps `now = new Date()` (and rows carry real-clock createdAt). This suite
 * therefore proves index byte-stability via the PURE converter with an injected `now`, not via the
 * written view files. See findings/HANDOFF.md "F5".
 *
 * Everything runs in a THROWAWAY dir — NEVER the live store. Node built-ins only.
 * Run: node tests/dogfood-corpus.test.js  (also via run-all).
 */
const {
  assert, test, done, scratch, fs,
  bodyMdPath, bodyJson, indexJson, indexPath,
  assertBodyWellFormed,
} = require('./helpers/task-e2e-helpers');

const t = require('../tpm-task.js');
const model = require('../lib/task-model');
const converter = require('../lib/task-converter');

const NOW = '2026-09-25T15:00:00-07:00';   // a fixed reference well past every createdAt

function buildCorpus() {
  const dir = scratch('tpm-task-dogfood-');

  // 1000 — in-progress, full, 3 subtasks (1 checked).
  t.opAdd({ tasksDir: dir, headline: 'build the JSON→human converter', labels: ['tooling', 'session'], summary: 'the meat', context: 'why it matters' });
  t.opTransition('start', { tasksDir: dir, id: '1000' });
  t.opAddSubtask({ tasksDir: dir, id: '1000', text: 'render body' });
  t.opAddSubtask({ tasksDir: dir, id: '1000', text: 'render index' });
  t.opAddSubtask({ tasksDir: dir, id: '1000', text: 'wire into save' });
  t.opCheck({ tasksDir: dir, id: '1000', key: 'A' });

  // 1001 — open, NULL summary + context (F3), no subtasks.
  t.opAdd({ tasksDir: dir, headline: 'quick backlog item', labels: ['backlog'] }); // summary/context default null

  // 1002 — finished, subtasks all checked.
  t.opAdd({ tasksDir: dir, headline: 'land the task schema', labels: ['schema'], summary: 'done work' });
  t.opAddSubtask({ tasksDir: dir, id: '1002', text: 'STATES map' });
  t.opCheck({ tasksDir: dir, id: '1002', key: 'A' });
  t.opTransition('finish', { tasksDir: dir, id: '1002', action: 'merged' });

  // 1003 — dropped (abandoned with an open subtask, F4).
  t.opAdd({ tasksDir: dir, headline: 'abandoned experiment' });
  t.opAddSubtask({ tasksDir: dir, id: '1003', text: 'never done' });
  t.opTransition('drop', { tasksDir: dir, id: '1003', action: 'wontdo' });

  // 1004 — removed (soft-stash).
  t.opAdd({ tasksDir: dir, headline: 'mistaken entry' });
  t.opTransition('remove', { tasksDir: dir, id: '1004' });

  return { dir, ids: ['1000', '1001', '1002', '1003', '1004'] };
}

test('corpus is built via the ops and every body is a valid canonical task at its true state', () => {
  const { dir, ids } = buildCorpus();
  const expectedState = { 1000: 'in-progress', 1001: 'open', 1002: 'finished', 1003: 'dropped', 1004: 'removed' };
  ids.forEach((id) => {
    const rec = model.loadTask(model.bodyPathFor(dir, id));   // read→migrate→validate; throws loud if bad
    assert.strictEqual(rec.kind, 'task', `${id} is a task envelope`);
    assert.strictEqual(rec.id, id);
    assert.strictEqual(rec.state, expectedState[id], `${id} at its true state`);
  });
  // the null-summary task genuinely stored null and renders the placeholder
  const backlog = bodyJson(dir, '1001');
  assert.strictEqual(backlog.summary, null, '1001 has a genuine null summary (F3)');
  assert.strictEqual(backlog.context, null, '1001 has a genuine null context (F3)');
  const md1001 = fs.readFileSync(bodyMdPath(dir, '1001'), 'utf8');
  assert.ok(md1001.includes('## Summary\n\n_None yet._'), 'null summary renders _None yet._ (no crash, no leak)');
});

test('JSON↔human ROUND-TRIP: each body re-loads unchanged AND its .md is byte-exact to a fresh pure render', () => {
  const { dir, ids } = buildCorpus();
  ids.forEach((id) => {
    const loaded = model.loadTask(model.bodyPathFor(dir, id));
    // round-trip: a full re-serialise → re-load equals the loaded record
    const rtDir = scratch('tpm-task-dogfood-rt-');
    const p = require('path').join(rtDir, `rt-${id}.json`);
    fs.writeFileSync(p, JSON.stringify(loaded, null, 2) + '\n');
    assert.deepStrictEqual(model.loadTask(p), loaded, `${id} survives a JSON write→read round-trip`);
    // human byte-exactness: the on-disk .md == a fresh pure render of the loaded JSON
    const onDisk = fs.readFileSync(bodyMdPath(dir, id), 'utf8');
    const fresh = converter.render(loaded, { now: NOW });
    assert.strictEqual(onDisk, fresh, `${id} body .md is byte-exact to render(loadedJSON) (pure, byte-stable)`);
    // and a second render is identical to the first (determinism)
    assert.strictEqual(converter.render(loaded, { now: NOW }), fresh, `${id} body render is deterministic`);
    assertBodyWellFormed(onDisk, id, loaded.headline, `${id} body`);
  });
});

test('reindex is BYTE-STABLE: two rebuilds off the same bodies agree on rows/counts/nextId', () => {
  const { dir } = buildCorpus();
  const idx1 = t.opReindex({ tasksDir: dir });
  const raw1 = fs.readFileSync(indexPath(dir), 'utf8');
  const idx2 = t.opReindex({ tasksDir: dir });
  const raw2 = fs.readFileSync(indexPath(dir), 'utf8');

  // Everything but the generatedAt clock stamp must be identical across the two rebuilds.
  const strip = (s) => s.replace(/"generatedAt": "[^"]*"/, '"generatedAt": "<stamp>"');
  assert.strictEqual(strip(raw1), strip(raw2), 'tasks-index.json is byte-stable across reindexes (modulo generatedAt)');
  assert.deepStrictEqual(idx1.tasks, idx2.tasks, 'reindex rows are stable');
  assert.deepStrictEqual(idx1.counts, idx2.counts, 'reindex counts are stable');
  assert.strictEqual(idx1.nextId, idx2.nextId, 'reindex nextId is stable');
  assert.strictEqual(idx1.tasks.length, 5, 'all five bodies re-scanned');
  assert.deepStrictEqual(idx1.counts, { open: 1, 'in-progress': 1, finished: 1, dropped: 1, removed: 1 },
    'counts reflect the one-per-state corpus');
});

test('index VIEW render is deterministic with an injected now (byte-stable goldens)', () => {
  const { dir } = buildCorpus();
  const idx = indexJson(dir);
  for (const states of [['open', 'in-progress'], ['finished', 'dropped'], ['removed']]) {
    const a = converter.renderIndexView(idx, { states, now: NOW });
    const b = converter.renderIndexView(idx, { states, now: NOW });
    assert.strictEqual(a, b, `renderIndexView(${states.join('+')}) is byte-stable with an injected now`);
    assert.ok(a.startsWith('# Tasks · '), 'view has a title');
    assert.ok(a.indexOf('NaN') === -1 && a.indexOf('undefined') === -1, 'no leaked tokens in the view');
  }
});

done('dogfood-corpus.test.js');
