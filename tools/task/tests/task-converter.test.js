'use strict';
/**
 * task-converter.test.js — unit + BYTE-EXACT golden + wiring tests for the PURE JSON→human render
 * layer (P05). Verifies the LOCKED shapes in `../task-export-spec.md` §1 + `../task-json-format-spec.md`
 * §"Disk layout":
 *   - body render: banner comment + `generated from: <12hex>` line, `# #<id> · <headline>`,
 *     State/Labels/Created landmarks, Summary, Context, `**Subtasks:** (done/total)` checkbox block,
 *     one-line history pointer;
 *   - hash banner = base `hash.hashRecord(record)` (recompute matches — DoD row 2);
 *   - index-view render: `| # | State | Created | Task |` filtered by `states`, `(done/total)` + labels
 *     in the task cell, `Next ID:` wayfinding comment;
 *   - age format `Nm/Nh/Nd ago` < 7d, absolute `YYYY-MM-DD` at >= 7d;
 *   - purity (no mutation / deterministic);
 *   - the byte-exact golden is MUTATION-PROVEN (a changed rendered field breaks the match);
 *   - saveTask injection wiring: body + the three human index views emitted, JSON round-trips.
 *
 * Zero-dep, Node built-ins only; a tiny inline harness (exit NON-ZERO on any failure — the ship-tool
 * bar). Run:
 *   node dev/20260920-task-features/task-tooling/tests/task-converter.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = require('../lib/base');
const { hashRecord } = base.hash;
const c = require('../lib/task-converter');
const { render, renderIndexView, _ageOf } = c;
const model = require('../lib/task-model');

// ── inline harness ─────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   - ' + name);
  } catch (e) {
    failed++;
    const detail = e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n         ') : String(e);
    console.log('  FAIL - ' + name + '\n         ' + detail);
  }
}
function throwsMatching(fn, re, msg) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  assert.ok(threw, (msg || 'expected a throw') + ' (nothing thrown)');
  assert.ok(re.test(String(threw.message || threw)), (msg || 'throw message') + ' — got: ' + threw.message);
}

const GOLDEN_DIR = path.join(__dirname, 'golden');
const BODY_FIXTURE = path.join(GOLDEN_DIR, 'task-1119.fixture.json');
const BODY_EXPECTED = path.join(GOLDEN_DIR, 'task-1119.expected.md');
const INDEX_FIXTURE = path.join(GOLDEN_DIR, 'tasks-index.fixture.json');
const INDEX_EXPECTED = path.join(GOLDEN_DIR, 'task-index.expected.md');
const GOLDEN_NOW = '2026-09-20T13:12:00-07:00';

function loadBody() { return JSON.parse(fs.readFileSync(BODY_FIXTURE, 'utf8')); }
function loadIndex() { return JSON.parse(fs.readFileSync(INDEX_FIXTURE, 'utf8')); }
function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'tpm-taskconv-')); }

// ── GOLDEN: body ─────────────────────────────────────────────────────────────

test('GOLDEN body: render(fixture, {now}) === task-1119.expected.md byte-for-byte', () => {
  const expected = fs.readFileSync(BODY_EXPECTED, 'utf8');
  const actual = render(loadBody(), { now: GOLDEN_NOW });
  assert.strictEqual(actual, expected, 'rendered body must match the committed golden');
});

test('GOLDEN body: MUTATION-PROVEN — a changed rendered field breaks the match', () => {
  const expected = fs.readFileSync(BODY_EXPECTED, 'utf8');
  const mutated = loadBody();
  mutated.headline = mutated.headline + ' (edited)';
  assert.notStrictEqual(render(mutated, { now: GOLDEN_NOW }), expected,
    'editing a rendered field (headline) MUST diverge from the golden — proves the golden is load-bearing');
});

test('GOLDEN body: section order + required landmarks present', () => {
  const out = render(loadBody(), { now: GOLDEN_NOW });
  const iBanner = out.indexOf('<!-- Generated from task-1119.json');
  const iGen = out.indexOf('<!-- generated from: ');
  const iTitle = out.indexOf('# #1119 · Build the task JSON→human converter');
  const iState = out.indexOf('- **State:** in-progress');
  const iSummary = out.indexOf('## Summary');
  const iContext = out.indexOf('## Context');
  const iSubs = out.indexOf('**Subtasks:** (1/3)');
  const iHist = out.indexOf('_History: 4 events — see `tpm task history 1119`._');
  assert.ok(iBanner === 0, 'banner comment is first');
  assert.ok(iBanner < iGen && iGen < iTitle, 'generated-from line follows the banner, before the title');
  assert.ok(iTitle < iState && iState < iSummary && iSummary < iContext && iContext < iSubs && iSubs < iHist,
    'title -> landmarks -> Summary -> Context -> Subtasks -> history pointer');
  assert.ok(out.includes('- **Labels:** session, tooling'), 'labels landmark');
  assert.ok(out.includes('- **Created:** 2026-09-19'), 'created landmark is the createdAt date (YYYY-MM-DD)');
  assert.ok(out.endsWith('\n') && !out.endsWith('\n\n'), 'exactly one trailing newline');
});

test('GOLDEN body: subtask checkbox block — done/total + [x]/[ ] per state', () => {
  const out = render(loadBody(), { now: GOLDEN_NOW });
  assert.ok(out.includes('**Subtasks:** (1/3)'), 'done/total hint');
  assert.ok(out.includes('- [x] A: render(record) → body .md'), 'done subtask checked');
  assert.ok(out.includes('- [ ] B: renderIndexView(indexObj) → the three views'), 'open subtask unchecked');
  assert.ok(out.includes('- [ ] C: byte-exact golden + mutation proof'), 'open subtask unchecked');
});

// ── HASH BANNER (DoD row 2) ────────────────────────────────────────────────────

test('HASH: the `generated from` hex == base hash.hashRecord(record), 12 lowercase hex', () => {
  const rec = loadBody();
  const out = render(rec, { now: GOLDEN_NOW });
  const m = /<!-- generated from: ([0-9a-f]{12}) -->/.exec(out);
  assert.ok(m, 'the generated-from token is present and 12 lowercase hex');
  assert.strictEqual(m[1], hashRecord(rec), 'stamped hex recomputes to hashRecord(record) (drift-detection contract)');
});

test('HASH: mutating any JSON field changes the stamped banner hex', () => {
  const rec = loadBody();
  const before = /generated from: ([0-9a-f]{12})/.exec(render(rec, { now: GOLDEN_NOW }))[1];
  const mut = loadBody();
  mut.summary = mut.summary + ' — touched';
  const after = /generated from: ([0-9a-f]{12})/.exec(render(mut, { now: GOLDEN_NOW }))[1];
  assert.notStrictEqual(after, before, 'a record change moves the content hash');
});

// ── PURITY (DoD row 1) ──────────────────────────────────────────────────────────

test('PURE: render is deterministic (two calls -> identical output)', () => {
  const rec = loadBody();
  assert.strictEqual(render(rec, { now: GOLDEN_NOW }), render(rec, { now: GOLDEN_NOW }), 'same inputs -> identical');
});

test('PURE: render does not mutate the input record', () => {
  const rec = loadBody();
  const before = JSON.stringify(rec);
  render(rec, { now: GOLDEN_NOW });
  assert.strictEqual(JSON.stringify(rec), before, 'record unchanged after render');
});

test('PURE: render tolerates a missing now (the body carries no relative age)', () => {
  const out = render(loadBody()); // no opts
  assert.ok(out.includes('# #1119 · '), 'renders without now');
});

// ── null summary / context ──────────────────────────────────────────────────────

test('BODY: null summary/context render the placeholder, not "null"', () => {
  const rec = loadBody();
  rec.summary = null;
  rec.context = null;
  const out = render(rec, { now: GOLDEN_NOW });
  assert.ok(out.includes('## Summary\n\n_None yet._'), 'summary placeholder');
  assert.ok(out.includes('## Context\n\n_None yet._'), 'context placeholder');
  assert.ok(!out.includes('null'), 'never prints the literal null');
});

test('BODY: no subtasks -> (0/0) with a placeholder; history pointer singular for 1 event', () => {
  const rec = loadBody();
  rec.subtasks = [];
  rec.history = [{ at: '2026-09-19T09:12:00-07:00', op: 'create' }];
  const out = render(rec, { now: GOLDEN_NOW });
  assert.ok(out.includes('**Subtasks:** (0/0)\n\n_No subtasks._'), 'empty subtask block placeholder');
  assert.ok(out.includes('_History: 1 event — see `tpm task history 1119`._'), 'singular "event" for a single history entry');
});

// ── GOLDEN: index view ───────────────────────────────────────────────────────

test('GOLDEN index: renderIndexView(fixture, {states,now}) === task-index.expected.md byte-for-byte', () => {
  const expected = fs.readFileSync(INDEX_EXPECTED, 'utf8');
  const actual = renderIndexView(loadIndex(), { states: ['open', 'in-progress'], now: GOLDEN_NOW });
  assert.strictEqual(actual, expected, 'rendered index view must match the committed golden');
});

test('INDEX: filtered by states — only open + in-progress rows; finished/removed excluded', () => {
  const out = renderIndexView(loadIndex(), { states: ['open', 'in-progress'], now: GOLDEN_NOW });
  assert.ok(out.includes('| 1119 | in-progress |'), 'in-progress row shown');
  assert.ok(out.includes('| 1120 | open |'), 'open row shown');
  assert.ok(out.includes('| 1121 | open |'), 'open row shown');
  assert.ok(!out.includes('1118'), 'finished task excluded from the open view');
  assert.ok(!out.includes('1117'), 'removed task excluded from the open view');
});

test('INDEX: header row, task cell carries (done/total) + labels, Next ID wayfinding comment', () => {
  const out = renderIndexView(loadIndex(), { states: ['open', 'in-progress'], now: GOLDEN_NOW });
  assert.ok(out.includes('| # | State | Created | Task |'), 'column header');
  assert.ok(out.includes('Build the task JSON→human converter (1/3) · session, tooling'), 'task cell = headline + (done/total) + labels');
  assert.ok(out.includes('Wire the converter into save (0/2)'), 'no-label task cell omits the label separator');
  assert.ok(/<!-- Next ID: 1124 .*-->/.test(out), 'Next ID rides in a wayfinding comment');
  assert.ok(out.endsWith('\n') && !out.endsWith('\n\n'), 'exactly one trailing newline');
});

test('INDEX: rows ordered by numeric id ascending', () => {
  const out = renderIndexView(loadIndex(), { states: ['open', 'in-progress'], now: GOLDEN_NOW });
  const i1119 = out.indexOf('| 1119 |');
  const i1120 = out.indexOf('| 1120 |');
  const i1121 = out.indexOf('| 1121 |');
  assert.ok(i1119 < i1120 && i1120 < i1121, 'ascending id order');
});

test('INDEX: finished∪dropped and removed views render (empty -> placeholder)', () => {
  const idx = loadIndex();
  const finished = renderIndexView(idx, { states: ['finished', 'dropped'], now: GOLDEN_NOW });
  assert.ok(finished.includes('| 1118 | finished |'), 'finished view shows the finished task');
  const removed = renderIndexView(idx, { states: ['removed'], now: GOLDEN_NOW });
  assert.ok(removed.includes('| 1117 | removed |'), 'removed view shows the removed task');
});

test('INDEX: an empty view renders the placeholder and needs no now', () => {
  const idx = loadIndex();
  idx.tasks = [];
  const out = renderIndexView(idx, { states: ['open'] }); // no now, no rows
  assert.ok(out.includes('_No tasks in this view._'), 'empty-view placeholder');
});

test('INDEX: missing now with rows present throws loud', () => {
  throwsMatching(() => renderIndexView(loadIndex(), { states: ['open'] }), /opts\.now is required/,
    'now required when a row must show a Created age');
});

// ── AGE boundaries (matches session Q1) ─────────────────────────────────────────

test('AGE: Nm/Nh/Nd boundaries and the 7-day switch to an absolute date', () => {
  const created = '2026-09-01T00:00:00-07:00';
  const at = (ms) => new Date(Date.parse(created) + ms);
  assert.strictEqual(_ageOf(created, at(0)), '0m ago', 'floor at 0 minutes');
  assert.strictEqual(_ageOf(created, at(59 * 60000)), '59m ago', '59 minutes');
  assert.strictEqual(_ageOf(created, at(60 * 60000)), '1h ago', 'exactly 1h -> hours');
  assert.strictEqual(_ageOf(created, at(23 * 3600000)), '23h ago', '23 hours');
  assert.strictEqual(_ageOf(created, at(24 * 3600000)), '1d ago', 'exactly 24h -> days');
  assert.strictEqual(_ageOf(created, at(6 * 86400000)), '6d ago', '6 days');
  assert.strictEqual(_ageOf(created, at(7 * 86400000 - 60000)), '6d ago', '6d23h59m still 6d ago');
  assert.strictEqual(_ageOf(created, at(7 * 86400000)), '2026-09-01', 'exactly 7d -> absolute createdAt date');
  assert.strictEqual(_ageOf(created, at(90 * 86400000)), '2026-09-01', '90d -> absolute createdAt date');
});

test('AGE: clamps a future createdAt to 0m; accepts an ISO-string now', () => {
  assert.strictEqual(_ageOf('2026-09-01T12:00:00-07:00', '2026-09-01T11:00:00-07:00'), '0m ago', 'future clamps to 0m');
});

// ── WIRING (DoD row 5): inject render + renderIndexView into saveTask ────────────

test('WIRING: saveTask({tasksDir,render,indexRender}) emits body + 3 index views; JSON round-trips', () => {
  const dir = tmpDir('tpm-taskconv-wire-');
  try {
    const rec = model.openTask({ id: '1119', headline: 'Wired task', labels: ['x'], summary: 's', context: 'ctx', tasksDir: dir });
    const boundBody = (r) => render(r, { now: GOLDEN_NOW });
    const persisted = model.saveTask(rec, { tasksDir: dir, render: boundBody, indexRender: renderIndexView });

    const jsonPath = model.bodyPathFor(dir, '1119');
    const mdPath = jsonPath.replace(/\.json$/, '.md');
    assert.ok(fs.existsSync(jsonPath), 'canonical JSON written');
    assert.ok(fs.existsSync(mdPath), 'derived body .md written');

    // body == render(persisted) (saveTask calls render(out) with one arg — no now — which the body tolerates)
    assert.strictEqual(fs.readFileSync(mdPath, 'utf8'), render(persisted), 'body .md == render(persisted record)');

    // the three human index views all exist (build-plan §7.3)
    for (const view of ['task-index.md', 'finished-tasks-index.md', 'removed-tasks-index.md']) {
      assert.ok(fs.existsSync(path.join(dir, view)), view + ' written');
    }
    // the open view shows our open task; the closed/removed views are empty placeholders
    const openView = fs.readFileSync(path.join(dir, 'task-index.md'), 'utf8');
    assert.ok(openView.includes('| 1119 | open |'), 'open index view carries the saved task row');
    assert.ok(openView.includes('Wired task (0/0)'), 'task cell rendered');
    assert.ok(fs.readFileSync(path.join(dir, 'removed-tasks-index.md'), 'utf8').includes('_No tasks in this view._'),
      'removed view is an empty placeholder');

    // machine index + JSON round-trip through the model load path
    const reloaded = model.loadTask(jsonPath);
    assert.strictEqual(JSON.stringify(reloaded), JSON.stringify(persisted), 'JSON reload round-trips');
    assert.ok(fs.existsSync(path.join(dir, 'tasks-index.json')), 'machine index written');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('WIRING: no render/indexRender -> saveTask writes JSON + machine index only (render deferral)', () => {
  const dir = tmpDir('tpm-taskconv-nornd-');
  try {
    const rec = model.openTask({ id: '1200', headline: 'no render', tasksDir: dir });
    model.saveTask(rec, { tasksDir: dir });
    assert.ok(fs.existsSync(model.bodyPathFor(dir, '1200')), 'JSON written');
    assert.ok(!fs.existsSync(model.bodyPathFor(dir, '1200').replace(/\.json$/, '.md')), 'no body .md without render');
    assert.ok(!fs.existsSync(path.join(dir, 'task-index.md')), 'no human index view without indexRender');
    assert.ok(fs.existsSync(path.join(dir, 'tasks-index.json')), 'machine index still written');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── summary ─────────────────────────────────────────────────────────────────────
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
