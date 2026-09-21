'use strict';
/**
 * task-migrate.test.js — the #1114.B opt-in OLD-markdown→JSON whole-store migrator
 * (tpm-task-migrate.js).
 *
 * Runs entirely on FIXTURES under tests/fixtures/legacy-tasks/ (COPIES of real live bodies +
 * hand-built refusal fixtures) and writes output ONLY into os.tmpdir() dirs — it NEVER reads or
 * writes the live .claude/claude-tpm/tasks/ tree.
 *
 * Covers every DoD row (plan.md):
 *  - whole-store migrate: reads the 3 index views + landmark bodies → writes canonical
 *    bodies/<bucket>/task-<id>.json + tasks-index.json (incl. the #1071 labels reverse-index) +
 *    (on --emit-derived) the derived body .md + 3 index .md views;
 *  - opt-in / never-auto: requiring the module writes nothing; --dry-run writes nothing;
 *  - STRICT all-or-nothing (T-Q4): the old `**Next ID:**` marker is preserved as the nextId floor;
 *    a partly-migrated store (stray .json) and any unparseable body REFUSE with NO partial write;
 *  - T-Q1 timestamps: Created date-only → createdAt `T00:00:00` at --offset; Started/Ended promoted;
 *    updatedAt = real injected now; a body with NO Created is REFUSED; nothing else fabricated;
 *  - T-Q5 history seed: exactly one {op:"create"} at createdAt;
 *  - old `End action:` → endAction:{action};
 *  - migrated store round-trips (loadTask) + validates; reindex is a no-op; render is byte-stable;
 *  - detectStore is exported (the 04-doctor imports it) and reports bodies + marker.
 *
 * Zero-dep, Node built-ins only; tiny inline harness (exit NON-ZERO on any failure, ship-tool bar).
 * Run: node dev/20260920-task-features/task-tooling/tests/task-migrate.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const migrator = require('../tpm-task-migrate');
const model = require('../lib/task-model');
const converter = require('../lib/task-converter');
const base = require('../lib/base');
const { validatePayload, isIsoTz } = require('../lib/task-schema');

const FIX = path.join(__dirname, 'fixtures', 'legacy-tasks');
const CLEAN = path.join(FIX, 'clean');
const NO_CREATED = path.join(FIX, 'refuse-no-created');
const PARTIAL = path.join(FIX, 'refuse-partial');
const PINNED_NOW = '2026-09-20T12:00:00-07:00';
const OFFSET = '-07:00';

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

function throwsMatching(fn, re, msg) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; assert.ok(re.test(String(e.message)), `${msg} — got: ${e && e.message}`); }
  assert.ok(threw, `${msg} — expected a throw, none happened`);
}

function tmpOut(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-task-mig-' + (tag || '') + '-')); }
function migrateClean(out, extra) {
  return migrator.runMigration(Object.assign({ inDir: CLEAN, outDir: out, offset: OFFSET, now: PINNED_NOW }, extra || {}));
}
function findRecord(res, id) { return res.records.find((r) => String(r.id) === String(id)); }

// ── detectStore (the ONE old-format detector; 04-doctor imports it) ───────────

test('detectStore: exported; reports the .md bodies (sorted) + the **Next ID:** marker', () => {
  assert.strictEqual(typeof migrator.detectStore, 'function', 'detectStore is exported');
  const s = migrator.detectStore(CLEAN);
  assert.deepStrictEqual(s.bodies.map((b) => b.id), ['1000', '1119'], 'bodies enumerated + numerically sorted');
  assert.strictEqual(s.marker, '1150', 'marker read verbatim from task-index.md');
  assert.ok(s.bodies.every((b) => fs.existsSync(b.path)), 'every body path resolves');
});

test('detectStore: REFUSES a partly-migrated store (a stray task-<id>.json is present)', () => {
  throwsMatching(() => migrator.detectStore(PARTIAL), /already \(partly\) migrated/i, 'partial store refused');
});

test('detectStore: REFUSES a non-store dir (no bodies/)', () => {
  const empty = tmpOut('empty');
  throwsMatching(() => migrator.detectStore(empty), /no bodies\/ directory|no old task bodies/i, 'non-store refused');
});

// ── whole-store migrate → canonical JSON + index + derived views ──────────────

test('whole-store migrate: writes a canonical task-<id>.json per body + tasks-index.json', () => {
  const out = tmpOut('write');
  const res = migrateClean(out, { emitDerived: true });
  assert.ok(res.written, 'wrote');
  assert.strictEqual(res.count, 2, '2 bodies converted');
  for (const id of ['1000', '1119']) {
    const jp = model.bodyPathFor(out, id);
    assert.ok(fs.existsSync(jp), `task-${id}.json written at the thousand-bucket path`);
    assert.ok(fs.existsSync(jp.replace(/\.json$/, '.md')), `task-${id}.md derived (--emit-derived)`);
  }
  assert.ok(fs.existsSync(path.join(out, 'tasks-index.json')), 'tasks-index.json written');
  for (const v of ['task-index.md', 'finished-tasks-index.md', 'removed-tasks-index.md']) {
    assert.ok(fs.existsSync(path.join(out, v)), `${v} index view rendered`);
  }
});

test('tasks-index.json carries the #1071 labels reverse-index (empty {} — old store has no labels) + right counts', () => {
  const out = tmpOut('index');
  migrateClean(out);
  const idx = JSON.parse(fs.readFileSync(path.join(out, 'tasks-index.json'), 'utf8'));
  assert.strictEqual(idx.kind, 'task-index', 'machine index kind');
  assert.ok(Object.prototype.hasOwnProperty.call(idx, 'labels'), 'labels reverse-index key present');
  assert.deepStrictEqual(idx.labels, {}, 'no labels in the old store → empty reverse-index');
  assert.strictEqual(idx.counts.open, 1, '1 open');
  assert.strictEqual(idx.counts.finished, 1, '1 finished');
  assert.strictEqual(idx.tasks.length, 2, '2 rows');
});

// ── T-Q4: strict all-or-nothing + nextId floor ───────────────────────────────

test('T-Q4: the old **Next ID:** marker is preserved as the nextId floor (wins over max(bodyId)+1)', () => {
  const out = tmpOut('floor');
  const res = migrateClean(out);
  // marker 1150 > max(bodyId)+1 (1119+1=1120) → floor is the marker.
  assert.strictEqual(res.index.nextId, '1150', 'nextId floored at the preserved marker');
  assert.strictEqual(res.marker, '1150', 'marker carried on the result');
});

test('T-Q4: an unparseable body REFUSES the WHOLE store with NO partial write (no-Created)', () => {
  const out = tmpOut('reject');
  throwsMatching(() => migrator.runMigration({ inDir: NO_CREATED, outDir: out, offset: OFFSET, now: PINNED_NOW }),
    /all-or-nothing[\s\S]*missing '- \*\*Created/i, 'refuses naming the offender');
  assert.strictEqual(fs.readdirSync(out).length, 0, 'NOTHING written on refusal (no partial store)');
});

test('T-Q4: --dry-run on a broken store lists the failure + exit 1, still writes nothing', () => {
  const out = tmpOut('dryreject');
  const res = migrator.runMigration({ inDir: NO_CREATED, outDir: out, offset: OFFSET, now: PINNED_NOW, dryRun: true });
  assert.strictEqual(res.written, false, 'dry-run writes nothing');
  assert.strictEqual(res.valid, false, 'reported invalid');
  assert.ok(/missing '- \*\*Created/i.test(res.refusalMessage), 'dry-run refusalMessage names the offender');
  assert.strictEqual(fs.readdirSync(out).length, 0, 'dry-run writes nothing even on refusal');
  assert.strictEqual(migrator.main(['--in', NO_CREATED, '--out-dir', out, '--offset', OFFSET, '--dry-run']), 1, 'CLI exit 1');
});

test('opt-in / never-auto: --dry-run on a HEALTHY store writes nothing (exit 0), only an explicit run writes', () => {
  const out = tmpOut('dryok');
  const res = migrateClean(out, { dryRun: true });
  assert.strictEqual(res.written, false, 'dry-run wrote nothing');
  assert.strictEqual(res.valid, true, 'healthy');
  assert.strictEqual(fs.readdirSync(out).length, 0, 'no files written by a dry-run');
});

// ── T-Q1: timestamp promotion (the load-bearing ruling) ───────────────────────

test('T-Q1: Created date-only → createdAt T00:00:00 at the explicit --offset', () => {
  const out = tmpOut('tq1');
  const res = migrateClean(out);
  const r1000 = findRecord(res, '1000');
  assert.strictEqual(r1000.timestamps.createdAt, '2026-09-01T00:00:00-07:00', 'createdAt promoted at --offset');
  assert.ok(isIsoTz(r1000.timestamps.createdAt), 'createdAt is local-offset ISO-TZ');
});

test('T-Q1: Ended date-only promoted; updatedAt = the REAL injected now; absent timestamps stay null', () => {
  const out = tmpOut('tq1b');
  const res = migrateClean(out);
  const r1000 = findRecord(res, '1000');
  assert.strictEqual(r1000.timestamps.endedAt, '2026-09-01T00:00:00-07:00', 'Ended promoted (finished task)');
  assert.strictEqual(r1000.timestamps.updatedAt, PINNED_NOW, 'updatedAt = real materialization now (not promoted)');
  assert.strictEqual(r1000.timestamps.startedAt, null, 'no Started in the body → null (nothing fabricated)');
  const r1119 = findRecord(res, '1119');
  assert.strictEqual(r1119.timestamps.startedAt, null, 'open task: startedAt null');
  assert.strictEqual(r1119.timestamps.endedAt, null, 'open task: endedAt null');
  assert.strictEqual(r1119.timestamps.reopenedAt, null, 'open task: reopenedAt null');
});

test('T-Q1: default offset (no --offset) uses the runner-local offset (shape ±HH:MM), noted for provenance', () => {
  const out = tmpOut('tq1c');
  const res = migrator.runMigration({ inDir: CLEAN, outDir: out, now: PINNED_NOW });   // no offset
  const r = findRecord(res, '1000');
  assert.ok(/T00:00:00-07:00$/.test(r.timestamps.createdAt), 'offset derived from the injected now (-07:00)');
  assert.ok(res.notes.some((n) => /runner-local offset/.test(n)), 'a provenance note records the derived offset');
});

test('T-Q1: a body with no Created is REFUSED (never fabricate the required createdAt)', () => {
  throwsMatching(() => migrator.parseOldBody({ raw: '# #7 · x\n\n- **State:** open\n', id: '7', offset: OFFSET }),
    /missing '- \*\*Created/i, 'parseOldBody refuses a no-Created body');
});

// ── T-Q5 history seed + endAction mapping ─────────────────────────────────────

test('T-Q5: each migrated task seeds exactly one {op:"create"} history event at createdAt', () => {
  const out = tmpOut('tq5');
  const res = migrateClean(out);
  for (const r of res.records) {
    assert.strictEqual(r.history.length, 1, `task-${r.id}: single history event`);
    assert.strictEqual(r.history[0].op, 'create', 'op is create');
    assert.strictEqual(r.history[0].at, r.timestamps.createdAt, 'seeded at createdAt');
  }
});

test('old `End action: <text>` → endAction:{action:<text>, refs:[]} (T-Q3 shape); open task → endAction null', () => {
  const out = tmpOut('endaction');
  const res = migrateClean(out);
  const r1000 = findRecord(res, '1000');
  assert.ok(r1000.endAction && typeof r1000.endAction.action === 'string', 'finished task endAction.action set');
  assert.ok(/Relocatable path resolution/.test(r1000.endAction.action), 'End action text carried verbatim');
  assert.deepStrictEqual(r1000.endAction.refs, [], 'refs present as [] (T-Q3 uniform shape; none in old data)');
  assert.strictEqual(findRecord(res, '1119').endAction, null, 'open task endAction null');
});

test('field mapping: subtasks letter→key + [x]→done/[ ]→open; missing Summary → null; Context verbatim', () => {
  const out = tmpOut('map');
  const res = migrateClean(out);
  const r1000 = findRecord(res, '1000');
  assert.deepStrictEqual(r1000.subtasks.map((s) => s.key), ['A', 'B', 'C'], 'letters became keys');
  assert.ok(r1000.subtasks.every((s) => s.state === 'done'), 'all [x] → done');
  assert.strictEqual(r1000.summary, null, 'task-1000 has no Summary line → null');
  assert.ok(/\$\{TPM_HOME\} fix covered/.test(r1000.context), 'context carried verbatim');
  assert.strictEqual(r1000.state, 'finished', 'state mapped');
  assert.strictEqual(r1000.labels.length, 0, 'labels [] (old store has none)');
});

// ── round-trips + validates + reindex no-op + byte-stable render ──────────────

test('every migrated body loads through loadTask + validates under the schema', () => {
  const out = tmpOut('rt');
  const res = migrateClean(out);
  for (const r of res.records) {
    const loaded = model.loadTask(model.bodyPathFor(out, r.id));   // read→migrate→validate
    assert.deepStrictEqual(loaded, r, `task-${r.id} round-trips identity`);
    validatePayload(loaded);   // does not throw
  }
});

test('reindex is a no-op on the migrated store (same nextId / counts / rows / labels)', () => {
  const out = tmpOut('reidx');
  const res = migrateClean(out);
  const before = res.index;
  const after = model.reindex(out);
  assert.strictEqual(after.nextId, before.nextId, 'nextId stable');
  assert.deepStrictEqual(after.counts, before.counts, 'counts stable');
  assert.deepStrictEqual(after.labels, before.labels, 'labels stable');
  assert.deepStrictEqual(after.tasks.map((t) => t.id).sort(), before.tasks.map((t) => t.id).sort(), 'rows stable');
});

test('converter re-renders byte-stably: emitted .md == render(loaded record, {now})', () => {
  const out = tmpOut('render');
  migrateClean(out, { emitDerived: true });
  const jp = model.bodyPathFor(out, '1000');
  const emitted = fs.readFileSync(jp.replace(/\.json$/, '.md'), 'utf8');
  const loaded = model.loadTask(jp);
  assert.strictEqual(converter.render(loaded, { now: PINNED_NOW }), emitted, 'render is deterministic + matches the emitted md');
});

test('determinism: two migrations with the same --now/--offset produce byte-identical body JSON', () => {
  const a = tmpOut('detA'); const b = tmpOut('detB');
  migrateClean(a); migrateClean(b);
  for (const id of ['1000', '1119']) {
    const ja = fs.readFileSync(model.bodyPathFor(a, id), 'utf8');
    const jb = fs.readFileSync(model.bodyPathFor(b, id), 'utf8');
    assert.strictEqual(ja, jb, `task-${id}.json identical across runs`);
  }
});

// ── safety guards ─────────────────────────────────────────────────────────────

test('safety: --in/--out-dir required; out==in refused; live-tasks out-dir refused', () => {
  throwsMatching(() => migrator.runMigration({ outDir: tmpOut('g') }), /--in is required/, '--in required');
  throwsMatching(() => migrator.runMigration({ inDir: CLEAN }), /--out-dir is required/, '--out-dir required');
  throwsMatching(() => migrator.runMigration({ inDir: CLEAN, outDir: path.join(CLEAN, 'x'), offset: OFFSET }),
    /is \(or is inside\) --in/, 'out inside in refused');
  throwsMatching(() => migrator.runMigration({ inDir: CLEAN, outDir: '/p/.claude/claude-tpm/tasks', offset: OFFSET }),
    /live \.claude\/claude-tpm\/tasks tree/, 'live tasks tree refused');
});

test('safety: an existing target body is not clobbered without --force', () => {
  const out = tmpOut('force');
  migrateClean(out);                                  // first run writes
  throwsMatching(() => migrateClean(out), /pass --force to overwrite/, 'second run refuses without --force');
  const res = migrateClean(out, { force: true });     // --force overwrites
  assert.ok(res.written, '--force overwrites cleanly');
});

// ── T-F1: nextId FLOOR branch — a stale-LOW marker must NOT win (complement of T-Q4) ──

/** Recursively copy a directory (Node built-ins only). */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** A healthy CLEAN store copy whose `**Next ID:**` marker is set to `marker` (below max bodyId+1). */
function lowMarkerStore(marker) {
  const dir = tmpOut('floorstore');
  copyDir(path.join(CLEAN, 'bodies'), path.join(dir, 'bodies'));
  fs.writeFileSync(path.join(dir, 'task-index.md'), `# Open tasks\n**Next ID:** ${marker}\n`);
  return dir;
}

test('T-F1: a stale-LOW **Next ID:** marker does NOT win — nextId floors at max(bodyId)+1 (no id reuse)', () => {
  // CLEAN bodies are 1000 + 1119 → max(bodyId)+1 = 1120. A marker of 1050 is BELOW that floor.
  const inDir = lowMarkerStore('1050');
  const out = tmpOut('floorout');
  const res = migrator.runMigration({ inDir, outDir: out, offset: OFFSET, now: PINNED_NOW });
  assert.strictEqual(res.marker, '1050', 'the stale-low marker is still read + carried on the result');
  assert.strictEqual(res.index.nextId, '1120',
    'nextId floors at max(bodyId)+1 (1120), NOT the stale-low marker (1050) — else id 1050..1119 could be reused');
  const idx = JSON.parse(fs.readFileSync(path.join(out, 'tasks-index.json'), 'utf8'));
  assert.strictEqual(idx.nextId, '1120', 'persisted tasks-index.json nextId floored at 1120');
});

// ── T-F2: reason-specific migrate refusals (each REFUSES loud + exit 1 + 0 writes) ──
// The existing suite mutation-pins only the no-`Created` refusal; T-F2 adds one test per remaining
// refusal reason. Each targets ONE reason at the unit layer (parseOldBody names it) AND proves the
// STRICT all-or-nothing whole-store contract at the CLI layer (main → exit 1, nothing written).

/**
 * runStoreWithBody(fileId, bodyText) -> { exit, out, wrote }
 * Build a store holding exactly ONE old body at bodies/1000-1999/task-<fileId>.md (+ a marker),
 * run the CLI `main` against a FRESH out-dir, and report the exit code + how many entries were
 * written under out (0 proves nothing was written on refusal).
 */
function runStoreWithBody(fileId, bodyText) {
  const inDir = tmpOut('reasonin');
  const bucket = path.join(inDir, 'bodies', '1000-1999');
  fs.mkdirSync(bucket, { recursive: true });
  fs.writeFileSync(path.join(bucket, `task-${fileId}.md`), bodyText);
  fs.writeFileSync(path.join(inDir, 'task-index.md'), '# Open tasks\n**Next ID:** 1001\n');
  const out = tmpOut('reasonout');
  const exit = migrator.main(['--in', inDir, '--out-dir', out, '--offset', OFFSET]);
  return { exit, out, wrote: fs.readdirSync(out).length };
}

test('T-F2: id/filename mismatch REFUSES (reason named) — whole-store exit 1, 0 writes', () => {
  const raw = '# #1001 · x\n\n- **State:** open\n- **Created:** 2026-01-01\n';   // title #1001, filename 1000
  throwsMatching(() => migrator.parseOldBody({ raw, id: '1000', offset: OFFSET }),
    /disagrees with the filename id/i, 'id/filename mismatch refused with the right reason');
  const r = runStoreWithBody('1000', raw);
  assert.strictEqual(r.exit, 1, 'CLI exit 1 on the whole-store refusal');
  assert.strictEqual(r.wrote, 0, 'NOTHING written (strict all-or-nothing)');
});

test('T-F2: a state ∉ STATES REFUSES (reason named) — whole-store exit 1, 0 writes', () => {
  const raw = '# #1000 · a valid headline\n\n- **State:** bogus\n- **Created:** 2026-01-01\n';
  throwsMatching(() => migrator.parseOldBody({ raw, id: '1000', offset: OFFSET }),
    /state 'bogus' is not one of/i, 'bad state refused with the right reason');
  const r = runStoreWithBody('1000', raw);
  assert.strictEqual(r.exit, 1, 'CLI exit 1 on the whole-store refusal');
  assert.strictEqual(r.wrote, 0, 'NOTHING written (strict all-or-nothing)');
});

test('T-F2: an empty headline REFUSES (reason named) — whole-store exit 1, 0 writes', () => {
  const raw = '# #1000\n\n- **State:** open\n- **Created:** 2026-01-01\n';   // title has no headline text
  throwsMatching(() => migrator.parseOldBody({ raw, id: '1000', offset: OFFSET }),
    /empty headline/i, 'empty headline refused with the right reason');
  const r = runStoreWithBody('1000', raw);
  assert.strictEqual(r.exit, 1, 'CLI exit 1 on the whole-store refusal');
  assert.strictEqual(r.wrote, 0, 'NOTHING written (strict all-or-nothing)');
});

test('T-F2: an empty subtask text REFUSES (reason named) — whole-store exit 1, 0 writes', () => {
  const raw = '# #1000 · h\n\n- **State:** open\n- **Created:** 2026-01-01\n\n**Subtasks:**\n- [ ] A. \n';
  throwsMatching(() => migrator.parseOldBody({ raw, id: '1000', offset: OFFSET }),
    /subtask A has empty text/i, 'empty subtask text refused with the right reason');
  const r = runStoreWithBody('1000', raw);
  assert.strictEqual(r.exit, 1, 'CLI exit 1 on the whole-store refusal');
  assert.strictEqual(r.wrote, 0, 'NOTHING written (strict all-or-nothing)');
});

done('task-migrate.test.js');
