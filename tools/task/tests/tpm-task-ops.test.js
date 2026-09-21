'use strict';
/**
 * tpm-task-ops.test.js — the JSON-backed verb tool + import surface (P06 DoD).
 *
 * Zero-dep, Node built-ins only; a tiny inline harness (exit NON-ZERO on any failure, per
 * tool-conventions' ship-tool bar). Run:
 *   node dev/20260920-task-features/task-tooling/tests/tpm-task-ops.test.js
 *
 * Exercises the ENTRY SCRIPT (`tpm-task.js`) end-to-end against a fresh SCRATCH tasks dir (never
 * the live store) — the op functions call the real model + converter and write real files. Covers
 * every DoD row:
 *   - verb surface works end-to-end: add/edit/check/add-subtask/start/finish/drop/remove/reopen +
 *     list/show/history/reindex; EACH mutation regenerates the canonical JSON, the body .md, the
 *     machine tasks-index.json, and the three human index .md views;
 *   - #1106 JSON import/apply: sets ONLY editable fields; IGNORES a hand-set state/id/timestamps/
 *     history/endAction; full-body swap; subtasks = bulk-replace-by-key (prune default + --no-prune);
 *     blank-template emit;
 *   - #1107 raw --body-txt-file import on add/edit (verbatim body);
 *   - F3 null summary/context: COERCE-TO-ABSENT — accepted, stored null, no crash;
 *   - #1111 close-guard + G3 illegal-transition enforced through the CLI op layer;
 *   - MUTATION-PROVEN: the import-editability guard (a hand-set `state` is ignored) — see
 *     tpm-task.js opImport; break→RED→restore demonstrated in findings/HANDOFF.md.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const t = require('../tpm-task.js');
const model = require('../lib/task-model');
const config = require('../tpm-task-config.js');

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
    const detail = e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n         ') : String(e);
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

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-task-ops-'));
}
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function bodyJson(dir, id) { return readJson(model.bodyPathFor(dir, String(id))); }
function writeTmp(dir, name, contents) { const p = path.join(dir, name); fs.writeFileSync(p, contents); return p; }

const NOW = '2026-09-20T15:00:00-07:00';

// ── add: allocates id, persists canonical JSON + body + machine index + THREE human views ──

test('add mints a task, allocates the id, and regenerates all derived views', () => {
  const dir = tmpDir();
  const rec = t.opAdd({ tasksDir: dir, headline: 'first', labels: ['a', 'b'], summary: 's' });
  assert.strictEqual(rec.id, '1000', 'first id is the 1000 high-water floor');
  assert.strictEqual(rec.state, 'open');
  // canonical JSON present + round-trips
  const disk = bodyJson(dir, 1000);
  assert.strictEqual(disk.headline, 'first');
  assert.deepStrictEqual(disk.labels, ['a', 'b']);
  // ALL derived files regenerated
  assert.ok(fs.existsSync(model.bodyPathFor(dir, '1000').replace(/\.json$/, '.md')), 'body .md');
  assert.ok(fs.existsSync(path.join(dir, 'tasks-index.json')), 'machine index');
  for (const v of ['task-index.md', 'finished-tasks-index.md', 'removed-tasks-index.md']) {
    assert.ok(fs.existsSync(path.join(dir, v)), `human view ${v}`);
  }
  // the machine index carries the row + advances nextId high-water
  const idx = readJson(path.join(dir, 'tasks-index.json'));
  assert.strictEqual(idx.tasks.length, 1);
  assert.strictEqual(idx.nextId, '1001');
  // the open view shows it
  assert.ok(fs.readFileSync(path.join(dir, 'task-index.md'), 'utf8').includes('first'));
});

test('add ids are monotonic across two adds (high-water never reused)', () => {
  const dir = tmpDir();
  const a = t.opAdd({ tasksDir: dir, headline: 'one' });
  const b = t.opAdd({ tasksDir: dir, headline: 'two' });
  assert.strictEqual(a.id, '1000');
  assert.strictEqual(b.id, '1001');
});

test('add with #1107 --body-txt-file fills summary verbatim', () => {
  const dir = tmpDir();
  const f = writeTmp(dir, 'body.txt', 'line1\nline2\n');
  const rec = t.opAdd({ tasksDir: dir, headline: 'h', bodyTxtFile: f });   // field defaults to summary
  assert.strictEqual(rec.summary, 'line1\nline2\n', 'raw text stored verbatim');
});

// ── edit: scalar editables + #1107 ──

test('edit rewrites only the supplied editable scalar fields', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'orig', summary: 'orig-sum', context: 'orig-ctx' });
  const rec = t.opEdit({ tasksDir: dir, id: '1000', headline: 'new headline' });
  assert.strictEqual(rec.headline, 'new headline');
  assert.strictEqual(rec.summary, 'orig-sum', 'unsupplied fields untouched');
  assert.strictEqual(rec.context, 'orig-ctx');
});

test('edit with #1107 --body-txt-file --field context overwrites context verbatim', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'h' });
  const f = writeTmp(dir, 'ctx.txt', 'raw ctx body');
  const rec = t.opEdit({ tasksDir: dir, id: '1000', bodyTxtFile: f, field: 'context' });
  assert.strictEqual(rec.context, 'raw ctx body');
});

// ── #1106 JSON import/apply ──

test('import sets ONLY editable fields and IGNORES mechanical (id/state/timestamps/history)', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'orig', summary: 's' });
  const before = bodyJson(dir, 1000);
  const patch = {
    id: '9999', state: 'finished',
    headline: 'imported headline', labels: ['x'],
    timestamps: { createdAt: '1999-01-01T00:00:00-07:00' },
    history: [{ at: 'garbage' }],
    endAction: { action: 'hand-set' },
  };
  const rec = t.opImport({ tasksDir: dir, id: '1000', jsonText: JSON.stringify(patch) });
  // editable applied
  assert.strictEqual(rec.headline, 'imported headline');
  assert.deepStrictEqual(rec.labels, ['x']);
  // MECHANICAL IGNORED (the editability guard)
  assert.strictEqual(rec.id, '1000', 'id NOT taken from import');
  assert.strictEqual(rec.state, 'open', 'state NOT taken from import');
  assert.strictEqual(rec.timestamps.createdAt, before.timestamps.createdAt, 'createdAt NOT taken from import');
  assert.strictEqual(rec.endAction, null, 'endAction NOT taken from import');
  // history was not replaced by the garbage array (still a valid, tool-written log)
  assert.ok(Array.isArray(rec.history));
  assert.ok(rec.history.every((ev) => typeof ev.at === 'string' && ev.at.includes('T')), 'history untouched by import');
  // persisted JSON matches the returned record
  assert.deepStrictEqual(bodyJson(dir, 1000), rec);
});

test('import accepts a FULL exported task record (full-body swap) — mechanical dropped', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'orig' });
  const full = model.exportTask(bodyJson(dir, 1000), { style: 'json' });
  full.headline = 'swapped';
  full.state = 'dropped';       // mechanical — must be ignored
  full.id = '5';                // mechanical — must be ignored
  const rec = t.opImport({ tasksDir: dir, id: '1000', jsonText: JSON.stringify(full) });
  assert.strictEqual(rec.headline, 'swapped');
  assert.strictEqual(rec.state, 'open');
  assert.strictEqual(rec.id, '1000');
});

test('F3: import a null summary/context — COERCE-TO-ABSENT (accepted, stored null, no crash)', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'h', summary: 'had one' });
  const rec = t.opImport({ tasksDir: dir, id: '1000', jsonText: '{"summary":null,"context":null}' });
  assert.strictEqual(rec.summary, null, 'null accepted + stored');
  assert.strictEqual(rec.context, null);
  // and the derived body renders it as absent, not a crash
  const md = fs.readFileSync(model.bodyPathFor(dir, '1000').replace(/\.json$/, '.md'), 'utf8');
  assert.ok(md.includes('## Summary\n\n_None yet._'), 'null summary renders _None yet._');
});

// ── subtasks import: bulk-replace-by-key (§4 / OQ1) ──

test('import subtasks bulk-replaces by key with --prune: survive keeps state, new is open, missing pruned', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'h' });
  t.opAddSubtask({ tasksDir: dir, id: '1000', text: 'A text' });   // key A, open
  t.opCheck({ tasksDir: dir, id: '1000', key: 'A' });               // A -> done
  t.opAddSubtask({ tasksDir: dir, id: '1000', text: 'B text' });   // key B, open
  // import with explicit --prune: keep A (edit text), add C; drop B
  const rec = t.opImport({
    tasksDir: dir, id: '1000', prune: true,
    jsonText: JSON.stringify({ subtasks: [{ key: 'A', text: 'A edited' }, { key: 'C', text: 'C new' }] }),
  });
  const byKey = Object.fromEntries(rec.subtasks.map((s) => [s.key, s]));
  assert.deepStrictEqual(Object.keys(byKey).sort(), ['A', 'C'], 'B pruned; A kept; C added');
  assert.strictEqual(byKey.A.text, 'A edited', 'A text edited');
  assert.strictEqual(byKey.A.state, 'done', 'A mechanical state PRESERVED across import');
  assert.strictEqual(byKey.C.state, 'open', 'new subtask defaults open');
});

test('import subtasks default (OQ1 keep-missing): record-only subtasks are retained', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'h' });
  t.opAddSubtask({ tasksDir: dir, id: '1000', text: 'A text' });
  const rec = t.opImport({
    tasksDir: dir, id: '1000',                                       // no --prune → default keep-missing
    jsonText: JSON.stringify({ subtasks: [{ key: 'B', text: 'B new' }] }),
  });
  const keys = rec.subtasks.map((s) => s.key).sort();
  assert.deepStrictEqual(keys, ['A', 'B'], 'A retained by default (keep-missing)');
});

test('import IGNORES a hand-set subtask state (done/open flips only via check/reopen)', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'h' });
  t.opAddSubtask({ tasksDir: dir, id: '1000', text: 'A' });   // A open
  const rec = t.opImport({
    tasksDir: dir, id: '1000',
    jsonText: JSON.stringify({ subtasks: [{ key: 'A', text: 'A', state: 'done' }] }),
  });
  assert.strictEqual(rec.subtasks[0].state, 'open', 'incoming subtask state ignored');
});

// ── blank template ──

test('blankTemplate emits ONLY editable fields (never a mechanical field)', () => {
  const tmpl = JSON.parse(t.blankTemplate());
  assert.deepStrictEqual(Object.keys(tmpl).sort(), ['context', 'headline', 'labels', 'subtasks', 'summary']);
  for (const mech of ['id', 'state', 'timestamps', 'history', 'endAction']) {
    assert.ok(!(mech in tmpl), `template must not carry mechanical field ${mech}`);
  }
});

// ── lifecycle + guards through the CLI op layer ──

test('lifecycle: start -> finish reaches finished and stamps endAction', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'h' });
  t.opTransition('start', { tasksDir: dir, id: '1000' });
  const rec = t.opTransition('finish', { tasksDir: dir, id: '1000', action: 'shipped' });
  assert.strictEqual(rec.state, 'finished');
  assert.deepStrictEqual(rec.endAction, { action: 'shipped', refs: [] });
});

test('#1111 close-guard: finish is REFUSED through the CLI while a subtask is open (names blocker)', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'h' });
  t.opAddSubtask({ tasksDir: dir, id: '1000', text: 'A' });
  throwsMatching(
    () => t.opTransition('finish', { tasksDir: dir, id: '1000' }),
    /refused.*open subtask.*A/,
    'finish with open subtask',
  );
  // and after checking it, finish succeeds
  t.opCheck({ tasksDir: dir, id: '1000', key: 'A' });
  const rec = t.opTransition('finish', { tasksDir: dir, id: '1000' });
  assert.strictEqual(rec.state, 'finished');
});

test('G3 illegal transition: start on a finished task is rejected loud', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'h' });
  t.opTransition('finish', { tasksDir: dir, id: '1000' });
  throwsMatching(
    () => t.opTransition('start', { tasksDir: dir, id: '1000' }),
    /illegal 'start' from state 'finished'/,
    'illegal start',
  );
});

test('lifecycle: drop, remove (soft-stash), reopen round-trip through views', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'h' });
  assert.strictEqual(t.opTransition('drop', { tasksDir: dir, id: '1000', action: 'wontdo' }).state, 'dropped');
  assert.strictEqual(t.opTransition('remove', { tasksDir: dir, id: '1000' }).state, 'removed');
  const reopened = t.opTransition('reopen', { tasksDir: dir, id: '1000' });
  assert.strictEqual(reopened.state, 'open');
  assert.strictEqual(reopened.endAction, null, 'reopen clears endAction');
});

// ── check + add-subtask ──

test('add-subtask appends an open subtask; check flips it done', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'h' });
  const a = t.opAddSubtask({ tasksDir: dir, id: '1000', text: 'do it' });
  assert.strictEqual(a.subtasks[0].state, 'open');
  const c = t.opCheck({ tasksDir: dir, id: '1000', key: 'A' });
  assert.strictEqual(c.subtasks[0].state, 'done');
});

// ── list / show / history / reindex ──

test('list renders the human index view filtered by state set', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'openone' });
  t.opAdd({ tasksDir: dir, headline: 'tofinish' });
  t.opTransition('finish', { tasksDir: dir, id: '1001' });
  const openView = t.opList({ tasksDir: dir, states: ['open', 'in-progress'], now: NOW });
  assert.ok(openView.includes('openone') && !openView.includes('tofinish'), 'open view filters state');
  const finishedView = t.opList({ tasksDir: dir, states: ['finished', 'dropped'], now: NOW });
  assert.ok(finishedView.includes('tofinish') && !finishedView.includes('openone'));
});

test('show renders the derived body for a task id', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'showme', summary: 'the summary' });
  const body = t.opShow({ tasksDir: dir, id: '1000', now: NOW });
  assert.ok(body.includes('# #1000 · showme'));
  assert.ok(body.includes('## Summary\n\nthe summary'));
});

test('history returns the #1109 events; gate off writes none', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'h' });
  t.opTransition('start', { tasksDir: dir, id: '1000' });
  const events = t.opHistory({ tasksDir: dir, id: '1000' });
  assert.ok(events.length >= 2 && events[0].op === 'create');
  // gate OFF: a fresh task writes zero history
  model.setHistoryEnabled(false);
  const dir2 = tmpDir();
  t.opAdd({ tasksDir: dir2, headline: 'h2' });
  assert.strictEqual(t.opHistory({ tasksDir: dir2, id: '1000' }).length, 0, 'gate off ⇒ no history');
});

test('reindex rebuilds the machine index + human views from the bodies', () => {
  const dir = tmpDir();
  t.opAdd({ tasksDir: dir, headline: 'a' });
  t.opAdd({ tasksDir: dir, headline: 'b' });
  // clobber the machine index, then reindex from bodies
  fs.writeFileSync(path.join(dir, 'tasks-index.json'), JSON.stringify({ kind: 'task-index', tasks: [] }));
  const idx = t.opReindex({ tasksDir: dir });
  assert.strictEqual(idx.tasks.length, 2, 'both bodies re-scanned');
  assert.ok(fs.existsSync(path.join(dir, 'task-index.md')));
});

// ── scratch discipline + arg guards ──

test('every store op requires --tasks-dir (never defaults to the live store)', () => {
  throwsMatching(() => t.opAdd({ headline: 'h' }), /tasksDir|tasks-dir/, 'add without tasks-dir');
  throwsMatching(() => t.opList({}), /tasks-dir/, 'list without tasks-dir');
});

test('config resolver exposes the #1109 history gate default (enabled)', () => {
  const d = config.getDefaults();
  assert.strictEqual(d.history.enabled, true, 'history gate defaults ON');
  const off = config.mergeTasksConfig({ history: { enabled: false } });
  assert.strictEqual(off.history.enabled, false, 'config can disable history');
});

done('tpm-task-ops');
