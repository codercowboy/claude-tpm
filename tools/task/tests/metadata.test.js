'use strict';
/**
 * metadata.test.js — the 02-metadata additions: #1071 labels + #1074 annotations (ADDITIVE on the
 * complete Epic-1 tooling). Zero-dep, Node built-ins only; inline harness that exits NON-ZERO on any
 * failure (tool-conventions ship-tool bar). Run:
 *   node dev/20260920-task-features/task-tooling/tests/metadata.test.js
 *
 * Covers every 02-metadata DoD row:
 *   - #1071 label reverse-index (T-Q6): a `labels:{label:[id,…]}` map INSIDE tasks-index.json,
 *     rebuilt on save (upsertRow) AND reindex, deterministic (sorted keys/ids), consistent with each
 *     task's per-task labels[]; deriveLabelIndex is pure + sorted.
 *   - label verbs + filter: model.addLabels/removeLabels (dedup, order, no-op); CLI label/unlabel/
 *     labels round-trip; list --label filter (AND).
 *   - #1074 annotation shape (T-Q3): endAction = {action?, note?, refs:[]}; finish/drop accept
 *     --action/--note/repeatable --ref (→ refs[]); legacy single ref folds into refs (back-compat).
 *   - close-time ONLY (T-Q2): endAction stays null before close; there is NO mid-life note/comment
 *     verb, and edit/import cannot set endAction (mechanical).
 *   - render + schema: body .md shows a Resolution section (omitted when endAction null); the schema
 *     type-checks endAction's known keys (bad refs rejected).
 *   - MUTATION-PROVEN: deriveLabelIndex determinism — see findings/HANDOFF.md (break→RED→restore).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const t = require('../tpm-task.js');
const model = require('../lib/task-model');
const converter = require('../lib/task-converter');
const schema = require('../lib/task-schema');

let passed = 0;
let failed = 0;

function test(name, fn) {
  const savedGate = model.isHistoryEnabled();
  try {
    fn();
    passed++;
    console.log('  ok   - ' + name);
  } catch (e) {
    failed++;
    const detail = e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n         ') : String(e);
    console.log('  FAIL - ' + name + '\n         ' + detail);
  } finally {
    model.setHistoryEnabled(savedGate);
  }
}

function done(suite) {
  console.log(`\n${suite}: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

function throwsMatching(fn, re, msg) {
  let threw = false;
  try { fn(); } catch (e) {
    threw = true;
    assert.ok(re.test(e.message), (msg || 'error') + ` should match ${re}, got: ${e.message}`);
  }
  assert.ok(threw, (msg || 'call') + ' should have thrown');
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-task-meta-')); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function indexJson(dir) { return readJson(path.join(dir, 'tasks-index.json')); }
function bodyJson(dir, id) { return readJson(model.bodyPathFor(dir, String(id))); }

const NOW = '2026-09-20T15:00:00-07:00';

// ── #1071 · deriveLabelIndex (pure, deterministic) ───────────────────────────────

test('deriveLabelIndex builds a sorted label→id-set map from index rows', () => {
  const rows = [
    { id: '1003', labels: ['urgent', 'backlog'] },
    { id: '1001', labels: ['backlog'] },
    { id: '1002', labels: [] },
    { id: '1010', labels: ['urgent'] },
  ];
  const map = model.deriveLabelIndex(rows);
  // keys sorted lexicographically; ids sorted numerically; a label with no tasks never appears
  assert.deepStrictEqual(Object.keys(map), ['backlog', 'urgent']);
  assert.deepStrictEqual(map.backlog, ['1001', '1003']);
  assert.deepStrictEqual(map.urgent, ['1003', '1010']);
});

test('deriveLabelIndex is pure + stable: two calls on the same rows are byte-identical', () => {
  const rows = [{ id: '1002', labels: ['b', 'a'] }, { id: '1001', labels: ['a'] }];
  const a = JSON.stringify(model.deriveLabelIndex(rows));
  const b = JSON.stringify(model.deriveLabelIndex(rows));
  assert.strictEqual(a, b, 'deterministic output');
  assert.strictEqual(a, '{"a":["1001","1002"],"b":["1002"]}');
});

// ── #1071 · model.addLabels / removeLabels ───────────────────────────────────────

test('addLabels unions + dedups, preserving order; removeLabels drops survivors in order', () => {
  const dir = tmpDir();
  let rec = t.opAdd({ tasksDir: dir, headline: 'h', labels: ['a', 'b'] });
  rec = model.addLabels(rec, ['b', 'c', 'c']);       // b already present, c new (once)
  assert.deepStrictEqual(rec.labels, ['a', 'b', 'c'], 'dedup + append in order');
  rec = model.removeLabels(rec, ['b']);
  assert.deepStrictEqual(rec.labels, ['a', 'c'], 'survivor order preserved');
});

test('addLabels with nothing new is a no-op (no updatedAt churn, no history event)', () => {
  const dir = tmpDir();
  const rec = t.opAdd({ tasksDir: dir, headline: 'h', labels: ['a'] });
  const before = { updatedAt: rec.timestamps.updatedAt, hist: rec.history.length };
  const same = model.addLabels(rec, ['a']);
  assert.deepStrictEqual(same.labels, ['a']);
  assert.strictEqual(same.timestamps.updatedAt, before.updatedAt, 'no re-stamp when unchanged');
  assert.strictEqual(same.history.length, before.hist, 'no edit history event when unchanged');
});

// ── #1071 · the reverse-index lives in tasks-index.json, rebuilt on save + reindex ──

test('tasks-index.json carries the label reverse-index, consistent with per-task labels[]', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'one', labels: ['backlog'] });
  t.opAdd({ tasksDir: dir, headline: 'two', labels: ['backlog', 'urgent'] });
  const idx = indexJson(dir);
  assert.deepStrictEqual(idx.labels, { backlog: ['1000', '1001'], urgent: ['1001'] });
  // consistency: every id under a label carries that label in its per-task labels[]
  for (const [label, ids] of Object.entries(idx.labels)) {
    for (const id of ids) assert.ok(bodyJson(dir, id).labels.includes(label), `#${id} carries ${label}`);
  }
});

test('reindex rebuilds the SAME label reverse-index from the bodies', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'one', labels: ['x'] });
  t.opAdd({ tasksDir: dir, headline: 'two', labels: ['x', 'y'] });
  const fromSaves = indexJson(dir).labels;
  // wipe the map + rebuild purely from bodies
  model.writeIndex(dir, Object.assign(model.readIndex(dir), { labels: {} }));
  const rebuilt = model.reindex(dir);
  assert.deepStrictEqual(rebuilt.labels, fromSaves, 'reindex reconstructs the identical map');
  assert.deepStrictEqual(rebuilt.labels, { x: ['1000', '1001'], y: ['1001'] });
});

test('the reverse-index tracks label + unlabel edits (stays consistent)', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'one', labels: ['a'] });
  t.opLabel({ tasksDir: dir, id: '1000', labels: ['b', 'c'] });
  assert.deepStrictEqual(indexJson(dir).labels, { a: ['1000'], b: ['1000'], c: ['1000'] });
  t.opUnlabel({ tasksDir: dir, id: '1000', labels: ['a', 'c'] });
  assert.deepStrictEqual(indexJson(dir).labels, { b: ['1000'] }, 'emptied labels drop out of the map');
  assert.deepStrictEqual(bodyJson(dir, '1000').labels, ['b']);
});

// ── #1071 · CLI verbs + list --label ─────────────────────────────────────────────

test('CLI label/unlabel/labels round-trip through main()', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'one', labels: ['backlog'] });
  t.opAdd({ tasksDir: dir, headline: 'two', labels: ['backlog', 'urgent'] });
  // `label <id> <labels…>` positional form
  assert.strictEqual(t.main(['label', '1000', 'urgent', 'ship', '--tasks-dir', dir]), 0);
  assert.deepStrictEqual(bodyJson(dir, '1000').labels, ['backlog', 'urgent', 'ship']);
  // `unlabel`
  assert.strictEqual(t.main(['unlabel', '1000', 'backlog', '--tasks-dir', dir]), 0);
  assert.deepStrictEqual(bodyJson(dir, '1000').labels, ['urgent', 'ship']);
  // `labels` list surface reflects the reverse index
  const rows = t.opLabels({ tasksDir: dir });
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.ids]));
  assert.deepStrictEqual(byLabel.urgent, ['1000', '1001']);
  assert.deepStrictEqual(byLabel.ship, ['1000']);
});

test('label verb requires at least one label (loud)', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'one' });
  throwsMatching(() => t.opLabel({ tasksDir: dir, id: '1000', labels: [] }), /at least one label/);
});

test('list --label filters to tasks carrying ALL requested labels (AND)', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'alpha', labels: ['backlog'] });
  t.opAdd({ tasksDir: dir, headline: 'beta', labels: ['backlog', 'urgent'] });
  const onlyUrgent = t.opList({ tasksDir: dir, labels: ['urgent'], now: NOW });
  assert.ok(onlyUrgent.includes('beta') && !onlyUrgent.includes('alpha'), 'single-label filter');
  const both = t.opList({ tasksDir: dir, labels: ['backlog', 'urgent'], now: NOW });
  assert.ok(both.includes('beta') && !both.includes('alpha'), 'AND of two labels');
  const none = t.opList({ tasksDir: dir, labels: ['nope'], now: NOW });
  assert.ok(!none.includes('alpha') && !none.includes('beta'), 'no match → empty view');
});

// ── #1074 · endAction {action?, note?, refs:[]} on finish/drop ───────────────────

test('finish --action --note --ref --ref builds endAction {action, note, refs[]}', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'to ship' });
  const rec = t.opTransition('finish', {
    tasksDir: dir, id: '1000', action: 'shipped', note: 'merged to main', refs: ['#42', 'PR-9'],
  });
  assert.strictEqual(rec.state, 'finished');
  assert.deepStrictEqual(rec.endAction, { action: 'shipped', note: 'merged to main', refs: ['#42', 'PR-9'] });
});

test('drop carries the same annotation shape (--reason maps to action)', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'to drop' });
  const rec = t.opTransition('drop', { tasksDir: dir, id: '1000', action: 'wontfix', refs: ['#7'] });
  assert.strictEqual(rec.state, 'dropped');
  assert.deepStrictEqual(rec.endAction, { action: 'wontfix', refs: ['#7'] });
});

test('legacy single `ref` folds into refs[] (back-compat, model layer)', () => {
  const started = model.startTask(model.openTask({ id: '1000', headline: 'h' }));
  const fin = model.finishTask(started, { action: 'done', ref: '#1' });
  assert.deepStrictEqual(fin.endAction, { action: 'done', refs: ['#1'] });
});

test('a bare finish (no flags) leaves endAction null; blank refs are dropped', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'h' });
  const bare = t.opTransition('finish', { tasksDir: dir, id: '1000' });
  assert.strictEqual(bare.endAction, null, 'nothing supplied → endAction stays null');
  // a lone empty --ref contributes nothing
  const rec = model.dropTask(model.openTask({ id: '1001', headline: 'x' }), { refs: ['', '  '] });
  assert.strictEqual(rec.endAction, null, 'blank refs are dropped → null');
});

test('CLI finish wires --note + repeatable --ref onto endAction.refs[]', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'h' });
  assert.strictEqual(
    t.main(['finish', '1000', '--action', 'shipped', '--note', 'done', '--ref', 'a', '--ref', 'b', '--tasks-dir', dir]),
    0,
  );
  assert.deepStrictEqual(bodyJson(dir, '1000').endAction, { action: 'shipped', note: 'done', refs: ['a', 'b'] });
});

// ── #1074 · close-time ONLY (T-Q2) ───────────────────────────────────────────────

test('T-Q2: endAction is null until close (no mid-life resolution)', () => {
  const dir = tmpDir();
  const opened = t.opAdd({ tasksDir: dir, headline: 'h', summary: 's' });
  assert.strictEqual(opened.endAction, null, 'open task has no endAction');
  const started = t.opTransition('start', { tasksDir: dir, id: '1000' });
  assert.strictEqual(started.endAction, null, 'in-progress task still has no endAction');
});

test('T-Q2: there is NO mid-life note/comment verb, and edit cannot set endAction', () => {
  const { globals, sub } = t.parseArgs(['note', '--tasks-dir', 'x']);
  assert.strictEqual(sub, '__bad__', 'a `note` verb is not recognised (no mid-life comment surface)');
  assert.ok(globals.badSub === 'note');
  // edit/import ignore mechanical endAction (it is not in EDITABLE_TABLE)
  assert.ok(!Object.prototype.hasOwnProperty.call(schema.EDITABLE_TABLE, 'endAction'),
    'endAction is mechanical — never editable/importable');
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'h' });
  const edited = model.applyTask(bodyJson(dir, '1000'), { endAction: { note: 'sneaky' } });
  assert.strictEqual(edited.endAction, null, 'applyTask ignores a hand-set endAction');
});

test('reopen clears the endAction (annotation is close-scoped)', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'h' });
  t.opTransition('finish', { tasksDir: dir, id: '1000', action: 'shipped', refs: ['#1'] });
  const reopened = t.opTransition('reopen', { tasksDir: dir, id: '1000' });
  assert.strictEqual(reopened.endAction, null, 'reopen clears the close-time annotation');
});

// ── #1074 · converter Resolution render + schema validation ──────────────────────

test('converter renders a Resolution section for a closed task (omitted when null)', () => {
  const rec = model.finishTask(model.startTask(model.openTask({ id: '1000', headline: 'h' })),
    { action: 'shipped', note: 'landed', refs: ['#1', '#2'] });
  const md = converter.render(rec, { now: NOW });
  assert.ok(md.includes('## Resolution'), 'Resolution heading present');
  assert.ok(md.includes('- **Action:** shipped'), 'action line');
  assert.ok(md.includes('- **Note:** landed'), 'note line');
  assert.ok(md.includes('- **Refs:** #1, #2'), 'refs line');
  // an open task has no Resolution section
  const open = converter.render(model.openTask({ id: '1001', headline: 'h' }), { now: NOW });
  assert.ok(!open.includes('## Resolution'), 'no Resolution section when endAction is null');
});

test('schema type-checks endAction known keys (bad refs rejected; good shape validates)', () => {
  const good = model.finishTask(model.openTask({ id: '1000', headline: 'h' }),
    { action: 'a', note: 'n', refs: ['r1'] });
  schema.validatePayload(good);   // no throw
  const bad = model.openTask({ id: '1001', headline: 'h' });
  bad.endAction = { refs: 'not-an-array' };
  throwsMatching(() => schema.validatePayload(bad), /endAction\.refs must be a string\[\]/);
  const badNote = model.openTask({ id: '1002', headline: 'h' });
  badNote.endAction = { note: 42 };
  throwsMatching(() => schema.validatePayload(badNote), /endAction\.note must be a string/);
});

done('metadata');
