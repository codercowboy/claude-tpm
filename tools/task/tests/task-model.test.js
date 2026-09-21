'use strict';
/**
 * task-model.test.js — the `kind:"task"` engine (P04 DoD).
 *
 * Zero-dep, Node built-ins only; a tiny inline harness (exit NON-ZERO on any failure, per
 * tool-conventions' ship-tool bar). Run:
 *   node dev/20260920-task-features/task-tooling/tests/task-model.test.js
 *
 * Covers every DoD row:
 *  - load/save round-trips (read→migrate→validate; atomic; byte-stable serialization);
 *  - lifecycle ops (start/finish/drop/remove/reopen enforce the legal-transition map, stamp the
 *    right timestamp + a {op:"state"} history event; illegal + redundant transitions handled);
 *  - subtask lifecycle + #1111 CLOSE-GUARD (MUTATION-PROVEN: break → RED → restore, shown);
 *  - importSubtasks §4 bulk-replace-set (survive/add/prune, state preserved, incoming state ignored);
 *  - history append (#1109) correct + gated (flag off ⇒ nothing written);
 *  - machine index writer + nextId high-water (D2) + reindex (never regresses);
 *  - updatedAt stamp (D5) on every mutation;
 *  - F3 null summary/context passes through without crashing.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = require('../lib/base');
const { CURRENT } = base.version;
const m = require('../lib/task-model');

let passed = 0;
let failed = 0;

function test(name, fn) {
  const savedGate = m.isHistoryEnabled();
  try {
    fn();
    passed++;
    console.log('  ok   - ' + name);
  } catch (e) {
    failed++;
    const detail = e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n         ') : String(e);
    console.log('  FAIL - ' + name + '\n         ' + detail);
  } finally {
    m.setHistoryEnabled(savedGate);   // never let a test leak the gate to the next
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

const ISO_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
const OLD = '2020-01-01T00:00:00-07:00';   // a stamp clearly older than nowIsoTz() (year 2026)

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-task-model-'));
}

function freshOpen(over) {
  return m.openTask(Object.assign({ id: 1119, headline: 'Build task-model', labels: ['tooling'] }, over || {}));
}

// ── openTask shape ────────────────────────────────────────────────────────────

test('openTask yields the locked lifecycle defaults (state open, empty subtasks, null ts)', () => {
  const rec = freshOpen();
  assert.strictEqual(rec.schemaVersion, CURRENT);
  assert.strictEqual(rec.kind, 'task');
  assert.strictEqual(rec.id, '1119');            // D4: string, no zero-pad
  assert.strictEqual(rec.state, 'open');
  assert.deepStrictEqual(rec.subtasks, []);
  assert.deepStrictEqual(rec.labels, ['tooling']);
  assert.strictEqual(rec.endAction, null);
  assert.ok(ISO_TZ.test(rec.timestamps.createdAt), 'createdAt is local-offset ISO');
  assert.strictEqual(rec.timestamps.createdAt, rec.timestamps.updatedAt, 'createdAt == updatedAt on open');
  assert.strictEqual(rec.timestamps.startedAt, null);
  assert.ok(!('task' in rec), 'top-level sibling shape, no nested task key');
  assert.strictEqual(rec.history.length, 1);
  assert.strictEqual(rec.history[0].op, 'create');
});

test('openTask allocates an id from tasksDir high-water when none is given', () => {
  const dir = tmpDir();
  // seed the index with a high-water of 1200
  m.writeIndex(dir, Object.assign(m.readIndex(dir), { nextId: '1200', startId: '1000' }));
  const rec = m.openTask({ headline: 'auto id', tasksDir: dir });
  assert.strictEqual(rec.id, '1200');
});

test('openTask requires a non-empty headline', () => {
  throwsMatching(() => m.openTask({ id: 1, headline: '  ' }), /headline. is required/);
});

// ── load/save round-trip (DoD row 1) ────────────────────────────────────────

test('saveTask → loadTask round-trips identity, atomically, byte-stably', () => {
  const dir = tmpDir();
  const jsonPath = path.join(dir, 'bodies', '1000-1999', 'task-1119.json');
  const rec = freshOpen();
  const persisted = m.saveTask(rec, { jsonPath });
  const loaded = m.loadTask(jsonPath);
  assert.deepStrictEqual(loaded, persisted, 'reload deep-equals the persisted record');
  // byte-stable: the file is exactly the canonical serialization of the persisted record
  const bytes = fs.readFileSync(jsonPath, 'utf8');
  assert.strictEqual(bytes, JSON.stringify(persisted, null, 2) + '\n', 'file is the canonical serialization');
  // atomicity: no orphaned .tmp left behind
  const stray = fs.readdirSync(path.dirname(jsonPath)).filter((f) => f.endsWith('.tmp'));
  assert.deepStrictEqual(stray, [], 'no orphaned temp file');
});

test('loadTask honors read→migrate→validate: a NEWER schemaVersion is REFUSED', () => {
  const dir = tmpDir();
  const jsonPath = path.join(dir, 'task-x.json');
  const rec = freshOpen();
  rec.schemaVersion = '9.9.9';                       // pretend a future writer
  fs.writeFileSync(jsonPath, JSON.stringify(rec, null, 2) + '\n');
  throwsMatching(() => m.loadTask(jsonPath), /newer schemaVersion/, 'migrate guard fires in the load path');
});

test('loadTask fails loud on a corrupt canonical file (never a silent empty record)', () => {
  const dir = tmpDir();
  const jsonPath = path.join(dir, 'bad.json');
  fs.writeFileSync(jsonPath, '{ not json');
  throwsMatching(() => m.loadTask(jsonPath), /not valid JSON/);
});

// ── lifecycle transitions (DoD row 2) ────────────────────────────────────────

test('startTask: open → in-progress, stamps startedAt + a state history event', () => {
  let rec = freshOpen();
  rec.timestamps.updatedAt = OLD;
  const started = m.startTask(rec);
  assert.strictEqual(started.state, 'in-progress');
  assert.ok(ISO_TZ.test(started.timestamps.startedAt), 'startedAt stamped');
  assert.notStrictEqual(started.timestamps.updatedAt, OLD, 'updatedAt re-stamped (D5)');
  const last = started.history[started.history.length - 1];
  assert.deepStrictEqual({ op: last.op, from: last.from, to: last.to }, { op: 'state', from: 'open', to: 'in-progress' });
});

test('finishTask (no open subtasks): → finished, stamps endedAt + endAction', () => {
  const started = m.startTask(freshOpen());
  // #1074/T-Q3: legacy single `ref` folds into refs[] (back-compat), alongside action.
  const fin = m.finishTask(started, { action: 'shipped', ref: '#1119' });
  assert.strictEqual(fin.state, 'finished');
  assert.ok(ISO_TZ.test(fin.timestamps.endedAt), 'endedAt stamped');
  assert.deepStrictEqual(fin.endAction, { action: 'shipped', refs: ['#1119'] });
});

test('dropTask + removeTask + reopenTask move + stamp correctly', () => {
  const dropped = m.dropTask(freshOpen(), { action: 'wontfix' });
  assert.strictEqual(dropped.state, 'dropped');
  assert.ok(ISO_TZ.test(dropped.timestamps.endedAt));

  const removed = m.removeTask(dropped);              // dropped → removed (soft-stash)
  assert.strictEqual(removed.state, 'removed');

  const reopened = m.reopenTask(removed);             // removed → open, clears close
  assert.strictEqual(reopened.state, 'open');
  assert.strictEqual(reopened.timestamps.endedAt, null, 'reopen clears endedAt');
  assert.strictEqual(reopened.endAction, null, 'reopen clears endAction');
  assert.ok(ISO_TZ.test(reopened.timestamps.reopenedAt), 'reopenedAt stamped');
});

test('an ILLEGAL transition throws loud; a REDUNDANT one is an idempotent no-op', () => {
  const removed = m.removeTask(m.dropTask(freshOpen()));
  throwsMatching(() => m.startTask(removed), /illegal 'start' from state 'removed'/);
  // redundant: reopen an already-open task → unchanged clone, no new history/state
  const rec = freshOpen();
  const again = m.reopenTask(rec);
  assert.strictEqual(again.state, 'open');
  assert.strictEqual(again.history.length, rec.history.length, 'redundant transition writes no history');
  assert.notStrictEqual(again, rec, 'returns a clone, not the same reference');
});

// ── subtask lifecycle + CLOSE-GUARD (DoD row 3, #1111) ───────────────────────

test('addSubtask mints sequential keys; edit/check/reopen/remove mutate + audit', () => {
  let rec = freshOpen();
  rec = m.addSubtask(rec, { text: 'first' });
  rec = m.addSubtask(rec, { text: 'second' });
  assert.deepStrictEqual(rec.subtasks.map((s) => s.key), ['A', 'B']);
  assert.deepStrictEqual(rec.subtasks.map((s) => s.state), ['open', 'open']);

  rec = m.checkSubtask(rec, 'A');
  assert.strictEqual(rec.subtasks[0].state, 'done');
  rec = m.reopenSubtask(rec, 'A');
  assert.strictEqual(rec.subtasks[0].state, 'open');
  rec = m.editSubtask(rec, 'B', 'second-edited');
  assert.strictEqual(rec.subtasks[1].text, 'second-edited');
  rec = m.removeSubtask(rec, 'A');
  assert.deepStrictEqual(rec.subtasks.map((s) => s.key), ['B']);

  const actions = rec.history.filter((h) => h.op === 'subtask').map((h) => h.action);
  assert.deepStrictEqual(actions, ['add', 'add', 'check', 'reopen', 'edit', 'remove']);
});

test('addSubtask honors a supplied unique key; refuses a duplicate', () => {
  let rec = m.addSubtask(freshOpen(), { text: 'x', key: 'Z' });
  assert.strictEqual(rec.subtasks[0].key, 'Z');
  assert.strictEqual(m.nextSubtaskKey(rec), 'A', 'next mint skips only used keys');
  throwsMatching(() => m.addSubtask(rec, { text: 'y', key: 'Z' }), /already exists/);
});

test('a subtask op on a missing key throws loud', () => {
  throwsMatching(() => m.checkSubtask(freshOpen(), 'Q'), /no subtask with key 'Q'/);
});

test('#1111 CLOSE-GUARD: finishTask REFUSED while a subtask is open, naming blockers', () => {
  let rec = m.addSubtask(freshOpen(), { text: 'blocker' });   // subtask A, open
  rec = m.addSubtask(rec, { text: 'blocker2' });               // subtask B, open
  rec = m.checkSubtask(rec, 'A');                              // A done, B still open
  throwsMatching(() => m.finishTask(rec), /open subtask\(s\) block close.*B/, 'names the open blocker B');
  // once all subtasks are done, finish succeeds
  const ok = m.finishTask(m.checkSubtask(rec, 'B'));
  assert.strictEqual(ok.state, 'finished');
});

// ── importSubtasks §4 (bulk-replace-set) ─────────────────────────────────────

test('importSubtasks §4 with prune:true: survivors keep state, new→open, missing pruned, incoming state ignored', () => {
  let rec = freshOpen();
  rec = m.addSubtask(rec, { text: 'alpha', key: 'A' });
  rec = m.addSubtask(rec, { text: 'bravo', key: 'B' });
  rec = m.checkSubtask(rec, 'A');                              // A is done
  // incoming: keep A (new text + a bogus state that must be IGNORED), drop B (explicit --prune), add C
  const merged = m.importSubtasks(rec, [
    { key: 'A', text: 'alpha-2', state: 'open' },              // state MUST be ignored
    { key: 'C', text: 'charlie' },
  ], { prune: true });
  const byKey = Object.fromEntries(merged.subtasks.map((s) => [s.key, s]));
  assert.deepStrictEqual(Object.keys(byKey).sort(), ['A', 'C']);
  assert.strictEqual(byKey.A.text, 'alpha-2', 'A text overwritten');
  assert.strictEqual(byKey.A.state, 'done', 'A mechanical state PRESERVED (incoming state ignored)');
  assert.strictEqual(byKey.C.state, 'open', 'new C defaults to open');
  assert.ok(!byKey.B, 'B pruned under --prune (missing from incoming)');
  const acts = merged.history.filter((h) => h.op === 'subtask').slice(-3).map((h) => `${h.action}:${h.key}`);
  assert.ok(acts.includes('remove:B') && acts.includes('edit:A') && acts.includes('add:C'), `deltas audited: ${acts}`);
});

test('importSubtasks default (OQ1 keep-missing): record-only subtasks are retained', () => {
  let rec = m.addSubtask(m.addSubtask(freshOpen(), { text: 'a', key: 'A' }), { text: 'b', key: 'B' });
  const merged = m.importSubtasks(rec, [{ key: 'A', text: 'a' }]);   // no opts → default keep-missing
  assert.deepStrictEqual(merged.subtasks.map((s) => s.key).sort(), ['A', 'B'], 'B survives by default (keep-missing)');
});

test('importSubtasks mints keys for keyless incoming items without colliding', () => {
  let rec = m.addSubtask(freshOpen(), { text: 'a', key: 'A' });
  const merged = m.importSubtasks(rec, [{ key: 'A', text: 'a' }, { text: 'new1' }, { text: 'new2' }]);
  const keys = merged.subtasks.map((s) => s.key);
  assert.strictEqual(new Set(keys).size, keys.length, 'all keys unique');
  assert.ok(keys.includes('B') && keys.includes('C'), `minted B and C, got ${keys}`);
});

// ── history gate (#1109, DoD row 4) ──────────────────────────────────────────

test('history append is correct AND config-gated (gate off ⇒ nothing written)', () => {
  // gate ON (default): a create + each op appends
  let rec = freshOpen();
  assert.strictEqual(rec.history.length, 1);
  rec = m.startTask(rec);
  assert.strictEqual(rec.history.length, 2);

  // gate OFF: openTask writes NO create event; ops append NO events
  m.setHistoryEnabled(false);
  const off = m.openTask({ id: 42, headline: 'no history' });
  assert.deepStrictEqual(off.history, [], 'openTask writes no history when gated off');
  const started = m.startTask(off);
  assert.deepStrictEqual(started.history, [], 'startTask writes no history when gated off');
  const withSub = m.addSubtask(started, { text: 'x' });
  assert.deepStrictEqual(withSub.history, [], 'addSubtask writes no history when gated off');
  // but the mutation itself still happened + updatedAt still stamped
  assert.strictEqual(started.state, 'in-progress');
  assert.strictEqual(withSub.subtasks.length, 1);
});

test('appendHistory / readHistory public surface', () => {
  const rec = m.appendHistory(freshOpen(), { op: 'edit', field: 'headline', value: 'v' });
  const h = m.readHistory(rec);
  assert.strictEqual(h[h.length - 1].field, 'headline');
  assert.ok(ISO_TZ.test(h[h.length - 1].at), 'appendHistory stamps `at`');
});

// ── apply / import / body-text / stripHistory ────────────────────────────────

test('applyTask sets only editable scalars, audits changes, ignores mechanical fields', () => {
  let rec = freshOpen();
  rec.timestamps.updatedAt = OLD;
  const next = m.applyTask(rec, {
    headline: 'new headline',
    labels: 'solo',                       // bare-string sugar → ['solo']
    state: 'finished',                    // MECHANICAL — must be ignored
    id: '9999',                           // MECHANICAL — must be ignored
  });
  assert.strictEqual(next.headline, 'new headline');
  assert.deepStrictEqual(next.labels, ['solo']);
  assert.strictEqual(next.state, 'open', 'mechanical state ignored on apply');
  assert.strictEqual(next.id, '1119', 'mechanical id ignored on apply');
  assert.notStrictEqual(next.timestamps.updatedAt, OLD, 'a real edit stamps updatedAt');
  const edits = next.history.filter((h) => h.op === 'edit').map((h) => h.field).sort();
  assert.deepStrictEqual(edits, ['headline', 'labels'], 'one edit event per changed field');
});

test('importTask merges scalars + subtasks in one call, ignoring mechanical fields', () => {
  let rec = m.addSubtask(freshOpen(), { text: 'old', key: 'A' });
  const out = m.importTask(rec, {
    headline: 'imported',
    subtasks: [{ key: 'A', text: 'old' }, { key: 'B', text: 'added' }],
    history: [{ at: OLD, op: 'create' }],     // MECHANICAL — ignored
  });
  assert.strictEqual(out.headline, 'imported');
  assert.deepStrictEqual(out.subtasks.map((s) => s.key), ['A', 'B']);
  assert.ok(!out.history.some((h) => h.at === OLD), 'incoming history ignored');
});

test('F3: null summary/context passes through without crashing (stored null)', () => {
  const rec = m.importTask(freshOpen(), { summary: null, context: null });
  assert.strictEqual(rec.summary, null);
  assert.strictEqual(rec.context, null);
  // and a raw body-text import of null is tolerated too
  const bt = m.importBodyText(rec, { field: 'summary', text: null });
  assert.strictEqual(bt.summary, null);
});

test('importBodyText fills a prose field + audits; rejects a bad field', () => {
  const rec = m.importBodyText(freshOpen(), { field: 'context', text: 'long prose' });
  assert.strictEqual(rec.context, 'long prose');
  assert.strictEqual(rec.history[rec.history.length - 1].field, 'context');
  throwsMatching(() => m.importBodyText(rec, { field: 'headline', text: 'x' }), /field must be/);
});

test('stripHistory is the --thin projection (full record minus history), not trimNonEditable', () => {
  const rec = m.startTask(freshOpen());
  const thin = m.stripHistory(rec);
  assert.ok(!('history' in thin), 'history dropped');
  assert.strictEqual(thin.id, rec.id, 'id kept');
  assert.strictEqual(thin.state, rec.state, 'state kept');
  assert.ok('timestamps' in thin, 'timestamps kept (unlike trimNonEditable)');
});

// ── machine index + nextId high-water + reindex (DoD row 5, D2) ──────────────

test('saveTask writes tasks-index.json with a thin row, counts, and a high-water nextId', () => {
  const dir = tmpDir();
  const rec = freshOpen();                              // id 1119, open
  m.saveTask(rec, { tasksDir: dir });
  const idx = m.readIndex(dir);
  assert.strictEqual(idx.kind, 'task-index');
  assert.strictEqual(idx.tasks.length, 1);
  const row = idx.tasks[0];
  assert.deepStrictEqual(
    { id: row.id, state: row.state, headline: row.headline, subtasks: row.subtasks, path: row.path },
    { id: '1119', state: 'open', headline: 'Build task-model', subtasks: { done: 0, total: 0 }, path: 'bodies/1000-1999/task-1119.json' }
  );
  assert.strictEqual(idx.counts.open, 1);
  assert.strictEqual(idx.nextId, '1120', 'nextId floors at max(bodyId)+1');
  assert.strictEqual(m.allocateNextId(dir), '1120');
});

test('nextId never regresses: high-water survives a removed top task', () => {
  const dir = tmpDir();
  m.saveTask(freshOpen({ id: 1119 }), { tasksDir: dir });
  assert.strictEqual(m.readIndex(dir).nextId, '1120');
  // remove the row's task entirely and reindex → nextId must NOT drop below 1120
  const bodyPath = m.bodyPathFor(dir, '1119');
  fs.unlinkSync(bodyPath);
  const rebuilt = m.reindex(dir, {});
  assert.strictEqual(rebuilt.tasks.length, 0, 'no bodies left');
  assert.strictEqual(rebuilt.nextId, '1120', 'nextId held at the prior high-water (never reused)');
});

test('reindex rebuilds counts + rows from bodies and self-heals nextId', () => {
  const dir = tmpDir();
  m.saveTask(freshOpen({ id: 1119 }), { tasksDir: dir });
  m.saveTask(m.startTask(freshOpen({ id: 1200, headline: 'two' })), { tasksDir: dir });
  m.saveTask(m.finishTask(freshOpen({ id: 1300, headline: 'three' })), { tasksDir: dir });
  // corrupt/clobber the index, then reindex from bodies
  m.writeIndex(dir, Object.assign(m.readIndex(dir), { tasks: [], counts: {}, nextId: '1000' }));
  const rebuilt = m.reindex(dir, {});
  assert.strictEqual(rebuilt.tasks.length, 3);
  assert.strictEqual(rebuilt.counts.open, 1);
  assert.strictEqual(rebuilt.counts['in-progress'], 1);
  assert.strictEqual(rebuilt.counts.finished, 1);
  assert.strictEqual(rebuilt.nextId, '1301', 'nextId = max(bodyId)+1');
});

test('saveTask + injected indexRender writes the three human index .md views', () => {
  const dir = tmpDir();
  const indexRender = (idx, { states }) => `VIEW ${states.join(',')} :: ${idx.tasks.filter((r) => states.includes(r.state)).length} rows\n`;
  m.saveTask(freshOpen(), { tasksDir: dir, indexRender });
  for (const f of ['task-index.md', 'finished-tasks-index.md', 'removed-tasks-index.md']) {
    assert.ok(fs.existsSync(path.join(dir, f)), `${f} written`);
  }
  assert.ok(fs.readFileSync(path.join(dir, 'task-index.md'), 'utf8').startsWith('VIEW open,in-progress'));
});

test('saveTask + injected body render writes the derived .md body only after the JSON', () => {
  const dir = tmpDir();
  const jsonPath = path.join(dir, 'bodies', '1000-1999', 'task-1119.json');
  m.saveTask(freshOpen(), { jsonPath, render: (r) => `# body for ${r.id}\n` });
  const md = jsonPath.replace(/\.json$/, '.md');
  assert.ok(fs.existsSync(md), 'derived body written');
  assert.strictEqual(fs.readFileSync(md, 'utf8'), '# body for 1119\n');
});

// ── updatedAt stamp (DoD row 6, D5) ──────────────────────────────────────────

test('every mutating op stamps timestamps.updatedAt', () => {
  const ops = [
    (r) => m.startTask(r),
    (r) => m.addSubtask(r, { text: 'x' }),
    (r) => m.applyTask(r, { headline: 'changed' }),
    (r) => m.dropTask(r),
    (r) => m.importBodyText(r, { field: 'summary', text: 'y' }),
  ];
  for (const op of ops) {
    const rec = freshOpen();
    rec.timestamps.updatedAt = OLD;
    const next = op(rec);
    assert.notStrictEqual(next.timestamps.updatedAt, OLD, `op stamped updatedAt (${op})`);
    assert.ok(ISO_TZ.test(next.timestamps.updatedAt));
  }
});

done('task-model.test');
