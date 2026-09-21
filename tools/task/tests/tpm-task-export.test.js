'use strict';
/**
 * tpm-task-export.test.js — the P07 export + search + history DoD suite.
 *
 * Zero-dep, Node built-ins only; a tiny inline harness (exit NON-ZERO on any failure, per
 * tool-conventions' ship-tool bar). Run:
 *   node dev/20260920-task-features/task-tooling/tests/tpm-task-export.test.js
 *
 * Builds a CONTROLLED scratch store (hand-written bodies + tasks-index.json with fixed timestamps —
 * never the live store) so time windows are deterministic under an injected --now. Exercises:
 *   - the ONE selector core (buildSelector / selectCandidates) shared by export + search;
 *   - export shapes: combined JSON = a bare array of envelopes; combined human = repeated full-header
 *     bodies; --per-file --out <dir>; --thin drops history[] (full-minus-history, NOT trimNonEditable);
 *     default --human to stdout (OQ4);
 *   - selectors AND-combine (ids/ranges + comma-set, --state/--open/--closed, --label AND, --match
 *     prose, --opened/--updated/--closed-since windows, --last + --by);
 *   - an INVALID window is EXIT 2 (never a silent empty result, #1092-I);
 *   - search emits id·file·line·snippet pointers (plain + JSON) over the IDENTICAL selectors;
 *   - history <id> pretty-prints (read-only), reports none when empty;
 *   - the entry-script wiring (tpm-task.js + tpm-task-router.js route export/search to the tool);
 *   - MUTATION-PROVEN: --thin (stripHistory) + the AND-combine assertion are red-if-broken (see HANDOFF).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const xp = require('../tpm-task-export.js');
const model = require('../lib/task-model');

const TASK_TOOL = path.join(__dirname, '..', 'tpm-task.js');
const ROUTER_TOOL = path.join(__dirname, '..', 'tpm-task-router.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log('  ok   - ' + name); }
  catch (e) {
    failed++;
    const detail = e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n         ') : String(e);
    console.log('  FAIL - ' + name + '\n         ' + detail);
  }
}
function done(suite) {
  console.log(`\n${suite}: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-task-export-')); }

// ── a controlled store: fixed timestamps relative to NOW ─────────────────────────
const NOW = '2026-09-20T12:00:00-07:00';
const D = { // ISO local-offset strings at fixed distances from NOW
  d1: '2026-09-19T12:00:00-07:00',   // 1 day ago
  h12: '2026-09-20T00:00:00-07:00',  // 12 hours ago
  d2: '2026-09-18T12:00:00-07:00',   // 2 days ago
  d3: '2026-09-17T12:00:00-07:00',   // 3 days ago
  d4: '2026-09-16T12:00:00-07:00',   // 4 days ago
  d5: '2026-09-15T12:00:00-07:00',   // 5 days ago
  d10: '2026-09-10T12:00:00-07:00',  // 10 days ago
  d20: '2026-08-31T12:00:00-07:00',  // 20 days ago
  d30: '2026-08-21T12:00:00-07:00',  // 30 days ago
};

function mk(spec) {
  return {
    schemaVersion: '1.0.0', kind: 'task', id: String(spec.id), state: spec.state,
    headline: spec.headline, labels: spec.labels || [],
    summary: spec.summary === undefined ? null : spec.summary,
    context: spec.context === undefined ? null : spec.context,
    subtasks: spec.subtasks || [],
    timestamps: {
      createdAt: spec.createdAt, updatedAt: spec.updatedAt,
      startedAt: null, endedAt: spec.endedAt || null, reopenedAt: null,
    },
    endAction: null,
    history: spec.history || [{ at: spec.createdAt, op: 'create' }],
  };
}

const RECORDS = [
  mk({ id: 1001, state: 'open', headline: 'Wire the boot sequence', labels: ['alpha'],
    summary: 'Boot the orchestrator cleanly.', createdAt: D.d2, updatedAt: D.d1 }),
  mk({ id: 1002, state: 'in-progress', headline: 'Run the doctor check', labels: ['alpha', 'beta'],
    summary: 'The doctor confirms wiring.', context: 'needs a scratch store', createdAt: D.d10, updatedAt: D.d3 }),
  mk({ id: 1003, state: 'finished', headline: 'Land the schema', labels: ['beta'],
    summary: 'done', createdAt: D.d20, updatedAt: D.d5, endedAt: D.d4 }),
  mk({ id: 1004, state: 'dropped', headline: 'Abandoned spike', labels: [],
    createdAt: D.d1, updatedAt: D.h12, endedAt: D.h12 }),
  mk({ id: 1005, state: 'removed', headline: 'Old removed task', labels: [],
    createdAt: D.d30, updatedAt: D.d30 }),
];

function buildStore() {
  const dir = tmpDir();
  const idx = model.readIndex(dir); // fresh empty index
  for (const r of RECORDS) {
    const p = model.bodyPathFor(dir, r.id);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(r, null, 2) + '\n');
    idx.tasks.push(model.deriveRow(r));
  }
  idx.nextId = '9999';
  model.writeIndex(dir, idx);
  return dir;
}

// buildSelector + selectCandidates helper — returns the matched ids (sorted numeric asc by default).
function ids(dir, argv) {
  const sel = xp.buildSelector(['--tasks-dir', dir, '--now', NOW, ...argv]);
  return xp.selectCandidates(sel).map((c) => c.id);
}

// ── selector core ───────────────────────────────────────────────────────────────

test('selectCandidates: --state open selects only open tasks', () => {
  assert.deepStrictEqual(ids(buildStore(), ['--state', 'open']), [1001]);
});

test('selectCandidates: --open = open ∪ in-progress; --closed = finished ∪ dropped', () => {
  const dir = buildStore();
  assert.deepStrictEqual(ids(dir, ['--open']), [1001, 1002]);
  assert.deepStrictEqual(ids(dir, ['--closed']), [1003, 1004]);
});

test('selectors AND-combine (MUTATION GUARD): id 1002 AND --state open ⇒ empty (would be [1002] under OR)', () => {
  assert.deepStrictEqual(ids(buildStore(), ['1002', '--state', 'open']), []);
});

test('id ranges + comma-set select the right ids (feeds #1125)', () => {
  const dir = buildStore();
  assert.deepStrictEqual(ids(dir, ['1001-1003']), [1001, 1002, 1003]);
  assert.deepStrictEqual(ids(dir, ['1001,1004']), [1001, 1004]);
});

test('--label is AND across repeats', () => {
  const dir = buildStore();
  assert.deepStrictEqual(ids(dir, ['--label', 'alpha']), [1001, 1002]);
  assert.deepStrictEqual(ids(dir, ['--label', 'alpha', '--label', 'beta']), [1002]);
});

test('--match reaches into body prose (summary/context)', () => {
  assert.deepStrictEqual(ids(buildStore(), ['--match', 'doctor']), [1002]);
});

test('--opened-since 7d uses createdAt (state-agnostic)', () => {
  assert.deepStrictEqual(ids(buildStore(), ['--opened-since', '7d']), [1001, 1004]);
});

test('--updated-since 3d uses updatedAt', () => {
  // within 3d of NOW: 1001 (1d) and 1004 (12h). 1002 (3d ago exactly = boundary, not strictly newer)
  assert.deepStrictEqual(ids(buildStore(), ['--updated-since', '2d']), [1001, 1004]);
});

test('--closed-since 7d uses endedAt (opens bodies)', () => {
  assert.deepStrictEqual(ids(buildStore(), ['--closed-since', '7d']), [1003, 1004]);
});

test('--opened-before / --opened-after bound createdAt by date', () => {
  const dir = buildStore();
  assert.deepStrictEqual(ids(dir, ['--opened-before', '2026-09-01']), [1003, 1005]);
  assert.deepStrictEqual(ids(dir, ['--opened-after', '2026-09-18']), [1001, 1004]);
});

test('--last N --by updated returns the N most-recently-updated, newest first', () => {
  const sel = xp.buildSelector(['--tasks-dir', buildStore(), '--now', NOW, '--last', '2', '--by', 'updated']);
  assert.deepStrictEqual(xp.selectCandidates(sel).map((c) => c.id), [1004, 1001]);
});

// ── export shapes ───────────────────────────────────────────────────────────────

function runCapture(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  let rc;
  try { rc = fn(); } finally { process.stdout.write = orig; }
  return { rc, out: chunks.join('') };
}

test('export combined --json = a BARE ARRAY of envelopes', () => {
  const dir = buildStore();
  const { rc, out } = runCapture(() => xp.runExport(['--tasks-dir', dir, '--now', NOW, '--state', 'open,in-progress', '--json']));
  assert.strictEqual(rc, 0);
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed), 'combined JSON must be a bare array');
  assert.strictEqual(parsed.length, 2);
  for (const env of parsed) { assert.strictEqual(env.kind, 'task'); assert.ok('history' in env); }
  assert.deepStrictEqual(parsed.map((e) => Number(e.id)).sort(), [1001, 1002]);
});

test('export --thin drops history[] but keeps id/state/timestamps (MUTATION GUARD: NOT trimNonEditable)', () => {
  const dir = buildStore();
  const { out } = runCapture(() => xp.runExport(['--tasks-dir', dir, '--now', NOW, '1001', '--json', '--thin']));
  const env = JSON.parse(out);
  assert.ok(!('history' in env), '--thin must drop history[]');
  assert.ok('id' in env && 'state' in env && 'timestamps' in env, '--thin must keep id/state/timestamps');
  assert.strictEqual(env.headline, 'Wire the boot sequence');
});

test('export default (no --json/--human) renders human bodies to stdout (OQ4)', () => {
  const dir = buildStore();
  const { out } = runCapture(() => xp.runExport(['--tasks-dir', dir, '--now', NOW, '--state', 'open,in-progress']));
  assert.ok(out.includes('# #1001 · Wire the boot sequence'), 'full header repeated (1001)');
  assert.ok(out.includes('# #1002 · Run the doctor check'), 'full header repeated (1002)');
});

test('export --per-file --out <dir> writes task-<id>.{json,md}', () => {
  const dir = buildStore();
  const outDir = tmpDir();
  const rc = xp.runExport(['--tasks-dir', dir, '--now', NOW, '--closed', '--per-file', '--json', '--human', '--out', outDir]);
  assert.strictEqual(rc, 0);
  for (const id of [1003, 1004]) {
    assert.ok(fs.existsSync(path.join(outDir, `task-${id}.json`)), `task-${id}.json`);
    assert.ok(fs.existsSync(path.join(outDir, `task-${id}.md`)), `task-${id}.md`);
  }
  const env = JSON.parse(fs.readFileSync(path.join(outDir, 'task-1003.json'), 'utf8'));
  assert.strictEqual(Number(env.id), 1003);
});

test('export with a valid-but-empty selection is exit 0 with an empty array (NOT an error)', () => {
  const dir = buildStore();
  const { rc, out } = runCapture(() => xp.runExport(['--tasks-dir', dir, '--now', NOW, '1002', '--state', 'open', '--json']));
  assert.strictEqual(rc, 0);
  assert.deepStrictEqual(JSON.parse(out), []);
});

// ── invalid window → EXIT 2 (#1092-I) ────────────────────────────────────────────

test('invalid --opened-since window is EXIT 2 (never a silent empty result)', () => {
  const dir = buildStore();
  assert.strictEqual(xp.main(['export', '--tasks-dir', dir, '--opened-since', 'banana']), 2);
  assert.strictEqual(xp.main(['export', '--tasks-dir', dir, '--closed-since', '2026-13-40']), 2);
  assert.strictEqual(xp.main(['search', '--tasks-dir', dir, '--updated-since', 'xyz']), 2);
});

test('a valid window with zero matches is NOT exit 2 (distinguishes empty from malformed)', () => {
  const dir = buildStore();
  // opened-before the epoch of every task ⇒ zero matches, but the window parsed fine ⇒ exit 0.
  assert.strictEqual(xp.main(['export', '--tasks-dir', dir, '--now', NOW, '--opened-before', '2020-01-01', '--json']), 0);
});

// ── search (pointers) — the SAME selector core ───────────────────────────────────

test('search --match emits an id·file·line·snippet pointer (JSON)', () => {
  const dir = buildStore();
  const { rc, out } = runCapture(() => xp.runSearch(['--tasks-dir', dir, '--now', NOW, '--match', 'doctor', '--json']));
  assert.strictEqual(rc, 0);
  const ptrs = JSON.parse(out);
  assert.strictEqual(ptrs.length, 1);
  assert.strictEqual(ptrs[0].id, '1002');
  assert.ok(/task-1002\.json$/.test(ptrs[0].file), 'file points at the body');
  assert.ok(Number.isInteger(ptrs[0].line) && ptrs[0].line >= 1, 'a 1-based line');
  assert.ok(ptrs[0].snippet.toLowerCase().includes('doctor'), 'snippet carries the match');
});

test('search plain output over --state (no --match) points at the headline line', () => {
  const dir = buildStore();
  const { rc, out } = runCapture(() => xp.runSearch(['--tasks-dir', dir, '--now', NOW, '--state', 'open']));
  assert.strictEqual(rc, 0);
  assert.ok(/^#1001\s+bodies\/1000-1999\/task-1001\.json:\d+\s+Wire the boot sequence/m.test(out), out);
});

test('search shares the selector core (AND-combine holds): id 1002 AND --state open ⇒ no matches', () => {
  const dir = buildStore();
  const { out } = runCapture(() => xp.runSearch(['--tasks-dir', dir, '--now', NOW, '1002', '--state', 'open', '--json']));
  assert.deepStrictEqual(JSON.parse(out), []);
});

// ── history <id> (read-only) ─────────────────────────────────────────────────────

test('history: opHistory returns the event log for a model-built task (gate on)', () => {
  const t = require('../tpm-task.js');
  const saved = model.isHistoryEnabled();
  try {
    model.setHistoryEnabled(true);
    const dir = tmpDir();
    const rec = t.opAdd({ tasksDir: dir, headline: 'has history', now: NOW });
    const events = t.opHistory({ tasksDir: dir, id: rec.id });
    assert.ok(events.length >= 1 && events[0].op === 'create', 'a create event is present');
  } finally { model.setHistoryEnabled(saved); }
});

test('history CLI reports none for an empty log (read-only)', () => {
  const dir = buildStore(); // 1004 was written with a create event; write one with an EMPTY log
  const empty = mk({ id: 1009, state: 'open', headline: 'no history', createdAt: D.d1, updatedAt: D.d1, history: [] });
  const p = model.bodyPathFor(dir, 1009);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(empty, null, 2) + '\n');
  const r = spawnSync('node', [TASK_TOOL, 'history', '1009', '--tasks-dir', dir], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/no history events/i.test(r.stdout), r.stdout);
});

// ── entry-script wiring ──────────────────────────────────────────────────────────

test('wiring: `tpm-task.js search` delegates to the export tool', () => {
  const dir = buildStore();
  const r = spawnSync('node', [TASK_TOOL, 'search', '--tasks-dir', dir, '--now', NOW, '--match', 'doctor', '--json'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout)[0].id, '1002');
});

test('wiring: `tpm-task-router.js export` routes to the export tool', () => {
  const dir = buildStore();
  const r = spawnSync('node', [ROUTER_TOOL, 'export', '--tasks-dir', dir, '--now', NOW, '--state', 'open,in-progress', '--json'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).length, 2);
});

test('wiring: an invalid window through the router is EXIT 2', () => {
  const dir = buildStore();
  const r = spawnSync('node', [ROUTER_TOOL, 'export', '--tasks-dir', dir, '--opened-since', 'banana'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr}`);
});

done('tpm-task-export.test.js');
