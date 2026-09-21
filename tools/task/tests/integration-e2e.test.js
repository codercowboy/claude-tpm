'use strict';
/**
 * integration-e2e.test.js (P08) — the full cross-cutting task-tooling lifecycle the per-phase suites
 * don't exercise as ONE story, driven end-to-end through the ENTRY-SCRIPT ops against a THROWAWAY
 * store (never the live store):
 *
 *   add → start → add-subtask×2 → finish(REFUSED by the #1111 close-guard) → check×2 → finish →
 *   add(B)+subtask → drop(B, abandons regardless of the open subtask, F4) → add(C) → remove(C) →
 *   reindex (rebuild from bodies)
 *
 * At every mutating step it asserts ALL the derived files the tool promises are correct together:
 *   - the canonical body JSON round-trips through the REAL load path (read→migrate→validate) and
 *     deep-equals what the op returned (on-disk canonical IS the truth);
 *   - the derived body `.md` is well-formed (banner + hash + landmarks + sections + history pointer);
 *   - the machine `tasks-index.json` carries the right row/state and a non-regressing nextId;
 *   - the THREE human index views (open+in-progress / finished∪dropped / removed) exist, are
 *     well-formed, and show/hide each task in the RIGHT view for its state.
 *
 * Node built-ins only. Run: node tests/integration-e2e.test.js  (also via run-all).
 */
const {
  assert, test, done, throwsMatching, scratch, fs,
  bodyMdPath, bodyJson, indexJson, viewPath, HUMAN_VIEWS,
  assertPersistedMatches, assertBodyWellFormed, assertIndexViewWellFormed,
} = require('./helpers/task-e2e-helpers');

const t = require('../tpm-task.js');

// Read + well-formedness of every derived view; return the three view strings for membership checks.
function assertAllDerivedFiles(dir, id, rec) {
  // 1. canonical JSON round-trips + equals the returned record
  assertPersistedMatches(dir, id, rec, `task ${id}`);
  // 2. derived body .md well-formed
  const md = fs.readFileSync(bodyMdPath(dir, id), 'utf8');
  assertBodyWellFormed(md, id, rec.headline, `task ${id} body`);
  // 3. machine index carries the row at the right state
  const idx = indexJson(dir);
  const row = idx.tasks.find((r) => String(r.id) === String(id));
  assert.ok(row, `task ${id} present in tasks-index.json`);
  assert.strictEqual(row.state, rec.state, `index row state == record state for ${id}`);
  assert.ok(Number(idx.nextId) > Number(id), `nextId high-water is past ${id} (got ${idx.nextId})`);
  // 4. all three human views exist + well-formed
  const views = {};
  for (const v of HUMAN_VIEWS) {
    const p = viewPath(dir, v);
    assert.ok(fs.existsSync(p), `human view ${v} exists`);
    views[v] = fs.readFileSync(p, 'utf8');
    assertIndexViewWellFormed(views[v], v);
  }
  return views;
}

test('full task lifecycle, asserting the canonical JSON + body .md + machine index + 3 human views at every step', () => {
  const dir = scratch('tpm-task-int-');

  // ── 1. add task A ──
  let a = t.opAdd({ tasksDir: dir, headline: 'ship the converter', labels: ['tooling', 'p08'], summary: 'the summary' });
  assert.strictEqual(a.id, '1000', 'first id is the 1000 high-water floor');
  assert.strictEqual(a.state, 'open');
  let views = assertAllDerivedFiles(dir, '1000', a);
  assert.ok(views['task-index.md'].includes('ship the converter'), 'open task A shows in the open view');
  assert.ok(!views['finished-tasks-index.md'].includes('ship the converter'), 'A not in the finished view yet');

  // ── 2. start A → in-progress ──
  a = t.opTransition('start', { tasksDir: dir, id: '1000' });
  assert.strictEqual(a.state, 'in-progress');
  assert.ok(a.timestamps.startedAt, 'startedAt stamped');
  views = assertAllDerivedFiles(dir, '1000', a);
  assert.ok(views['task-index.md'].includes('ship the converter'), 'in-progress A still in the open+wip view');

  // ── 3. add two subtasks ──
  t.opAddSubtask({ tasksDir: dir, id: '1000', text: 'render body' });   // A
  a = t.opAddSubtask({ tasksDir: dir, id: '1000', text: 'render index' }); // B
  assert.deepStrictEqual(a.subtasks.map((s) => s.key), ['A', 'B'], 'two subtasks minted A,B');
  assertAllDerivedFiles(dir, '1000', a);

  // ── 4. finish while a subtask is open → REFUSED (close-guard #1111), store untouched ──
  throwsMatching(
    () => t.opTransition('finish', { tasksDir: dir, id: '1000' }),
    /refused.*open subtask/,
    'finish with open subtasks',
  );
  assert.strictEqual(bodyJson(dir, '1000').state, 'in-progress', 'refused finish left A in-progress on disk');

  // ── 5. check both, then finish → finished, moves views ──
  t.opCheck({ tasksDir: dir, id: '1000', key: 'A' });
  t.opCheck({ tasksDir: dir, id: '1000', key: 'B' });
  a = t.opTransition('finish', { tasksDir: dir, id: '1000', action: 'shipped' });
  assert.strictEqual(a.state, 'finished');
  assert.deepStrictEqual(a.endAction, { action: 'shipped', refs: [] }, 'endAction stamped on finish (T-Q3: refs [])');
  assert.ok(a.timestamps.endedAt, 'endedAt stamped');
  views = assertAllDerivedFiles(dir, '1000', a);
  assert.ok(!views['task-index.md'].includes('ship the converter'), 'finished A left the open view');
  assert.ok(views['finished-tasks-index.md'].includes('ship the converter'), 'finished A now in the finished view');

  // ── 6. add B (1001) with an open subtask, then DROP it — abandons regardless (F4) ──
  let b = t.opAdd({ tasksDir: dir, headline: 'abandon me', labels: [] });
  assert.strictEqual(b.id, '1001');
  t.opAddSubtask({ tasksDir: dir, id: '1001', text: 'never finished' });   // open subtask
  b = t.opTransition('drop', { tasksDir: dir, id: '1001', action: 'wontdo' });
  assert.strictEqual(b.state, 'dropped', 'drop succeeds even with an open subtask (F4: no close-guard on drop)');
  assert.deepStrictEqual(b.endAction, { action: 'wontdo', refs: [] });
  views = assertAllDerivedFiles(dir, '1001', b);
  assert.ok(views['finished-tasks-index.md'].includes('abandon me'), 'dropped B shows in the finished∪dropped view');

  // ── 7. add C (1002), then REMOVE it (soft-stash) ──
  let c = t.opAdd({ tasksDir: dir, headline: 'remove me' });
  assert.strictEqual(c.id, '1002');
  c = t.opTransition('remove', { tasksDir: dir, id: '1002' });
  assert.strictEqual(c.state, 'removed');
  assert.strictEqual(c.timestamps.endedAt, null, 'remove is a soft-stash: no endedAt');
  views = assertAllDerivedFiles(dir, '1002', c);
  assert.ok(views['removed-tasks-index.md'].includes('remove me'), 'removed C shows in the removed view');
  assert.ok(!views['task-index.md'].includes('remove me'), 'removed C not in the open view');

  // ── 8. reindex: clobber tasks-index.json, rebuild from the bodies ──
  const nextBefore = indexJson(dir).nextId;
  fs.writeFileSync(viewPath(dir, 'tasks-index.json'),
    JSON.stringify({ schemaVersion: '1.0.0', kind: 'task-index', nextId: null, startId: '1000', counts: {}, tasks: [] }, null, 2) + '\n');
  const idx = t.opReindex({ tasksDir: dir });
  assert.strictEqual(idx.tasks.length, 3, 'all three bodies re-scanned');
  const byId = Object.fromEntries(idx.tasks.map((r) => [r.id, r.state]));
  assert.deepStrictEqual(byId, { 1000: 'finished', 1001: 'dropped', 1002: 'removed' }, 'reindex restored every row at its true state');
  assert.ok(Number(idx.nextId) >= Number(nextBefore), 'reindex nextId high-water NEVER regresses');
  assert.strictEqual(idx.nextId, '1003', 'nextId floors at max(bodyId)+1');
  // views regenerated from the rebuilt index
  for (const v of HUMAN_VIEWS) assertIndexViewWellFormed(fs.readFileSync(viewPath(dir, v), 'utf8'), 'post-reindex ' + v);
});

done('integration-e2e.test.js');
