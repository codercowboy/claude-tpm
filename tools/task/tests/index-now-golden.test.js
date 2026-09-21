'use strict';
/**
 * index-now-golden.test.js (F5) — the through-the-writer byte-stable index golden.
 *
 * BEFORE the F5 seam, `task-model.writeIndexViews` hard-coded `now = new Date()`, so the three
 * derived human index `.md` views were NOT byte-stable through a save: `renderIndexView`'s relative
 * Created-age column ("6h ago") shifts with the wall clock, and the writer gave no way to pin it.
 * Only the DIRECT `renderIndexView(indexObj, {now})` call was byte-exact (task-converter.test.js).
 *
 * F5 threaded an INJECTABLE `now` into `writeIndexViews` (default `new Date()` — unchanged). This
 * suite pins that the STORE WRITERS themselves are byte-stable given a fixed index + an injected now:
 *   - writeIndex(dir, fixture) writes tasks-index.json byte-deterministically (no clock of its own);
 *   - writeIndexViews(dir, fixture, renderIndexView, {now}) reproduces the committed golden view
 *     BYTE-FOR-BYTE — proving the injected `now` reaches renderIndexView through the writer;
 *   - the seam is LOAD-BEARING: a different injected now produces different view bytes (so `now` is
 *     genuinely consumed, not ignored) — and the default (no now) path still writes well-formed views.
 *
 * Reuses the SAME committed golden inputs as task-converter.test.js (tests/golden/) + the same pinned
 * reference time, so the existing goldens stay byte-intact (this suite reads them, never regenerates).
 *
 * Zero-dep, Node built-ins only; scratch dirs only (never the live store). Run:
 *   node dev/20260920-task-features/task-tooling/tests/index-now-golden.test.js  (also via run-all)
 */
const { assert, test, done, scratch, fs, path } = require('./helpers/task-e2e-helpers');

const model = require('../lib/task-model');
const conv = require('../lib/task-converter');

const GOLDEN_DIR = path.join(__dirname, 'golden');
const INDEX_FIXTURE = path.join(GOLDEN_DIR, 'tasks-index.fixture.json');
const INDEX_EXPECTED = path.join(GOLDEN_DIR, 'task-index.expected.md');
// The SAME pinned reference time task-converter.test.js used to author task-index.expected.md.
const GOLDEN_NOW = '2026-09-20T13:12:00-07:00';

function loadIndex() { return JSON.parse(fs.readFileSync(INDEX_FIXTURE, 'utf8')); }
function read(p) { return fs.readFileSync(p, 'utf8'); }

// ── tasks-index.json — the machine index writer is byte-deterministic ────────────

test('writeIndex writes tasks-index.json byte-deterministically for a fixed index', () => {
  const idx = loadIndex();
  const a = scratch('tpm-f5-idx-a-');
  const b = scratch('tpm-f5-idx-b-');
  model.writeIndex(a, idx);
  model.writeIndex(b, idx);
  const bytesA = read(path.join(a, 'tasks-index.json'));
  const bytesB = read(path.join(b, 'tasks-index.json'));
  assert.strictEqual(bytesA, bytesB, 'two writeIndex calls on the same object are byte-identical');
  // Canonical 2-space serialization + one trailing newline (the writer adds no clock of its own).
  assert.strictEqual(bytesA, JSON.stringify(idx, null, 2) + '\n', 'tasks-index.json == canonical serialization');
  // Round-trips back to the exact object (nothing mangled/dropped through the write).
  assert.deepStrictEqual(JSON.parse(bytesA), idx, 'tasks-index.json round-trips to the fixture object');
});

// ── index views — byte-stable THROUGH the writer given an injected now ───────────

test('GOLDEN: writeIndexViews(fixture, {now}) reproduces task-index.expected.md byte-for-byte', () => {
  const dir = scratch('tpm-f5-view-');
  model.writeIndexViews(dir, loadIndex(), conv.renderIndexView, { now: GOLDEN_NOW });
  const actual = read(path.join(dir, 'task-index.md'));
  const expected = read(INDEX_EXPECTED);
  assert.strictEqual(actual, expected,
    'the written open/in-progress view must match the committed golden byte-for-byte (now threaded through)');
});

test('writeIndexViews writes all three views, byte-deterministically for the same injected now', () => {
  const a = scratch('tpm-f5-v3a-');
  const b = scratch('tpm-f5-v3b-');
  model.writeIndexViews(a, loadIndex(), conv.renderIndexView, { now: GOLDEN_NOW });
  model.writeIndexViews(b, loadIndex(), conv.renderIndexView, { now: GOLDEN_NOW });
  for (const v of ['task-index.md', 'finished-tasks-index.md', 'removed-tasks-index.md']) {
    assert.ok(fs.existsSync(path.join(a, v)), v + ' written');
    assert.strictEqual(read(path.join(a, v)), read(path.join(b, v)), v + ' is byte-identical across runs (same now)');
  }
});

test('SEAM is load-bearing: a DIFFERENT injected now yields different view bytes (now is consumed)', () => {
  const a = scratch('tpm-f5-now1-');
  const b = scratch('tpm-f5-now2-');
  model.writeIndexViews(a, loadIndex(), conv.renderIndexView, { now: GOLDEN_NOW });
  // +40 days: the relative Created-age column ("6h ago" / "1d ago") must shift, so the bytes MUST
  // differ. If `now` were ignored (the pre-F5 behaviour), both would render against `new Date()` and
  // this would incorrectly match — the assertion that pins the seam.
  const later = '2026-10-30T13:12:00-07:00';
  model.writeIndexViews(b, loadIndex(), conv.renderIndexView, { now: later });
  assert.notStrictEqual(read(path.join(a, 'task-index.md')), read(path.join(b, 'task-index.md')),
    'a later injected now must change the rendered ages — proves writeIndexViews actually uses opts.now');
});

test('DEFAULT preserved: writeIndexViews with NO opts still writes well-formed views (real clock)', () => {
  const dir = scratch('tpm-f5-default-');
  // No opts → the writer falls back to new Date() exactly as before the seam (additive default).
  model.writeIndexViews(dir, loadIndex(), conv.renderIndexView);
  const view = read(path.join(dir, 'task-index.md'));
  assert.ok(view.startsWith('# Tasks · '), 'default-now view still renders a title');
  assert.ok(/<!-- Next ID: 1124 /.test(view), 'default-now view still carries the Next ID wayfinding comment');
  assert.ok(view.endsWith('\n') && !view.endsWith('\n\n'), 'default-now view ends with exactly one trailing newline');
});

done('index-now-golden.test.js');
