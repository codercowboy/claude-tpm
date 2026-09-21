'use strict';
/**
 * session-migrate.test.js — the #1114.C opt-in old→new session migrator (tpm-session-migrate.js).
 *
 * Runs entirely on FIXTURES under tests/fixtures/legacy/ (copies of real sessions 0020/0021 +
 * small hand-built clean/sidecar/refusal fixtures) and writes output ONLY into os.tmpdir() dirs —
 * it NEVER reads or writes the live .claude/claude-tpm/sessions/ tree.
 *
 * Covers (against the plan's Definition of Done):
 *   - golden old→new fixture PAIR: real session-0021 migrates BYTE-FOR-BYTE to the frozen
 *     session-0021.expected.json (now pinned so the one clock-stamp, handoff.updatedAt, is stable);
 *     the golden is proven load-bearing (a corrupted record no longer matches it).
 *   - faithful field mapping: handoff where/next/in_flight/must_not_redo, decision what/why,
 *     log seq monotonic + typed, punchlist id/slug/text/state/events (add [+ close]).
 *   - canonical number: meta.number is the zero-padded width-4 STRING via canonicalNumber, after
 *     validating the parsed number (a garbage --number is refused, not fed to canonicalNumber).
 *   - Q-C (no synthesized timestamps): closedAt null + sessionIds [] on a real no-sidecar session;
 *     openedAt is a REAL earliest timestamp from the data (never T00:00:00); a sidecar's
 *     openedAt/closedAt/sessionIds win when present.
 *   - Q-B (marked-3-file only): 2-file / freeform / mixed / no-banner inputs are REFUSED with a
 *     clear message (never best-effort/partial), CLI exits non-zero.
 *   - safety rails: --in/--out-dir required; out-dir == in refused; out-dir inside a live sessions
 *     tree refused; --dry-run writes nothing; existing output refused without --force; --emit-md;
 *     validate-before-write; output round-trips through loadSession.
 *
 * Run: node tests/session-migrate.test.js
 */
const os = require('os');
const { spawnSync } = require('child_process');
const { assert, test, done, throwsMatching, fs, path } = require('./helpers/harness');

const migrator = require('../tpm-session-migrate');
const model = require('../lib/session-model');

const TOOL = path.join(__dirname, '..', 'tpm-session-migrate.js');
const FIX = path.join(__dirname, 'fixtures', 'legacy');
const PINNED_NOW = '2026-09-19T22:00:00-07:00';

function tmpOut(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-migrate-' + (tag || '') + '-'));
}
function fixture(name) { return path.join(FIX, name); }

// ── golden old→new fixture pair (real session-0021) ──────────────────────────

test('golden: real session-0021 migrates byte-for-byte to the frozen expected JSON', () => {
  const out = tmpOut('golden');
  const res = migrator.runMigration({ inDir: fixture('session-0021'), outDir: out, now: PINNED_NOW });
  assert.ok(res.written, 'should have written');
  const produced = fs.readFileSync(res.outPath, 'utf8');
  const expected = fs.readFileSync(fixture('session-0021.expected.json'), 'utf8');
  assert.strictEqual(produced, expected, 'migrated 0021 must match the golden byte-for-byte');
});

test('golden is load-bearing: a corrupted record does NOT match the frozen expected JSON', () => {
  const { record } = migrator.parseOldSession({ inDir: fixture('session-0021'), now: PINNED_NOW });
  const corrupted = JSON.parse(JSON.stringify(record));
  corrupted.handoff.where = 'CORRUPTED';
  const corruptedText = JSON.stringify(corrupted, null, 2) + '\n';
  const expected = fs.readFileSync(fixture('session-0021.expected.json'), 'utf8');
  assert.notStrictEqual(corruptedText, expected, 'a corrupted record must differ from the golden');
});

// ── faithful field mapping ───────────────────────────────────────────────────

test('field mapping: handoff / log / punchlist parsed faithfully from real 0021', () => {
  const { record } = migrator.parseOldSession({ inDir: fixture('session-0021'), now: PINNED_NOW });

  // handoff
  assert.ok(/^Session 0021\./.test(record.handoff.where), 'handoff.where preserved');
  assert.ok(/^RUN the session-ship-prep/.test(record.handoff.next), 'handoff.next preserved');
  assert.strictEqual(record.handoff.in_flight.length, 3, 'in_flight split on ";" -> 3');
  assert.strictEqual(record.handoff.must_not_redo.length, 6, 'must_not_redo bullets -> 6');
  assert.strictEqual(record.handoff.updatedAt, PINNED_NOW, 'updatedAt is the injected now (real, not fabricated-historical)');

  // log: typed, seq strictly increasing from 1
  const decisions = record.log.filter((e) => e.type === 'decision');
  const logs = record.log.filter((e) => e.type === 'log');
  assert.strictEqual(decisions.length, 6, '6 decisions');
  assert.strictEqual(logs.length, 18, '18 log lines');
  assert.strictEqual(record.log[0].seq, 1, 'seq starts at 1');
  for (let i = 1; i < record.log.length; i++) {
    assert.ok(record.log[i].seq > record.log[i - 1].seq, 'seq strictly increasing');
    assert.ok(Date.parse(record.log[i].ts) >= Date.parse(record.log[i - 1].ts), 'chronological order');
  }
  const d0 = decisions[0];
  assert.ok(d0.what && d0.why && d0.what !== d0.why, 'decision split into distinct what/why');

  // punchlist: slug (lineage key) preserved verbatim, id kept, events synthesized
  const carried = record.punchlist.find((p) => p.slug === 'h5k0gb');
  assert.ok(carried, 'slug h5k0gb preserved (lineage key)');
  assert.strictEqual(carried.id, '21.1', 'id kept as written');
  assert.strictEqual(carried.state, 'open', 'open item state');
  assert.deepStrictEqual(carried.events.map((e) => e.op), ['add'], 'open item has an add event');
  const doneItem = record.punchlist.find((p) => p.slug === '184udc');
  assert.strictEqual(doneItem.state, 'done', 'done item state');
  assert.deepStrictEqual(doneItem.events.map((e) => e.op), ['add', 'close'], 'done item has add + close events');
});

test('output round-trips: the written file loads cleanly via loadSession', () => {
  const out = tmpOut('roundtrip');
  const res = migrator.runMigration({ inDir: fixture('session-0020'), outDir: out, now: PINNED_NOW });
  const reloaded = model.loadSession(res.outPath);
  assert.strictEqual(reloaded.kind, 'session');
  assert.strictEqual(reloaded.schemaVersion, '1.0.0');
  assert.strictEqual(reloaded.meta.number, '0020');
});

// ── canonical number ─────────────────────────────────────────────────────────

test('canonical number: meta.number is the zero-padded width-4 STRING', () => {
  const { record } = migrator.parseOldSession({ inDir: fixture('session-0021'), now: PINNED_NOW });
  assert.strictEqual(record.meta.number, '0021');
  assert.strictEqual(typeof record.meta.number, 'string');
});

test('canonical number: --number override is validated BEFORE canonicalNumber (garbage refused)', () => {
  // A garbage number must be refused, NOT coerced by canonicalNumber ("" -> "0000", hex, etc.).
  throwsMatching(
    () => migrator.parseOldSession({ inDir: fixture('session-0021'), number: 'nope', now: PINNED_NOW }),
    /unparseable session number/,
    'garbage --number',
  );
  throwsMatching(
    () => migrator.parseOldSession({ inDir: fixture('session-0021'), number: '0x1f', now: PINNED_NOW }),
    /unparseable session number/,
    'hex --number (canonicalNumber would otherwise accept it)',
  );
  // A clean override is honored and canonicalized.
  const { record } = migrator.parseOldSession({ inDir: fixture('session-0021'), number: '42', now: PINNED_NOW });
  assert.strictEqual(record.meta.number, '0042');
});

// ── Q-C: no synthesized timestamps ───────────────────────────────────────────

test('Q-C: a real no-sidecar session leaves closedAt null + sessionIds [] (no synthesis)', () => {
  const { record } = migrator.parseOldSession({ inDir: fixture('session-0021'), now: PINNED_NOW });
  assert.strictEqual(record.meta.closedAt, null, 'closedAt left null (SEALED date-only not synthesized)');
  assert.deepStrictEqual(record.meta.sessionIds, [], 'sessionIds [] (no sidecar)');
});

test('Q-C: openedAt is a REAL earliest timestamp from the data, never a T00:00:00 invention', () => {
  const { record } = migrator.parseOldSession({ inDir: fixture('session-0021'), now: PINNED_NOW });
  assert.strictEqual(record.meta.openedAt, '2026-09-19T09:40:33-07:00', 'openedAt = earliest real ts in 0021');
  assert.ok(!/T00:00:00/.test(record.meta.openedAt), 'openedAt is not a synthesized midnight value');
  // and it is genuinely the minimum of the real stamps present
  const stamps = [];
  record.log.forEach((e) => stamps.push(e.ts));
  record.punchlist.forEach((p) => { stamps.push(p.createdAt); p.events.forEach((ev) => stamps.push(ev.ts)); });
  const min = stamps.slice().sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  assert.strictEqual(record.meta.openedAt, min, 'openedAt equals the true earliest stamp');
});

test('Q-C: a sidecar .current-session.json supplies real openedAt/closedAt/sessionIds', () => {
  const { record } = migrator.parseOldSession({ inDir: fixture('session-0009-sidecar'), now: PINNED_NOW });
  assert.strictEqual(record.meta.openedAt, '2026-09-11T08:00:00-07:00', 'sidecar openedAt wins');
  assert.strictEqual(record.meta.closedAt, '2026-09-11T18:30:00-07:00', 'sidecar closedAt used');
  assert.deepStrictEqual(record.meta.sessionIds, ['sid-0009-abc'], 'sidecar sessionId used');
});

test('meta.tpmVersion is a non-empty legacy sentinel (not the note-format version)', () => {
  const { record } = migrator.parseOldSession({ inDir: fixture('session-0021'), now: PINNED_NOW });
  assert.strictEqual(record.meta.tpmVersion, '0.0.0-legacy');
});

// ── Q-B: marked-3-file ONLY — refuse the rest ────────────────────────────────

const REFUSALS = [
  ['refuse-2file', /mixed\/pre-format session \(stray note file/, '2-file (011-style)'],
  ['refuse-freeform', /freeform session \(found \.txt file/, 'freeform (001-style)'],
  ['refuse-mixed', /mixed\/pre-format session \(stray note file/, 'mixed (0019-style)'],
  ['refuse-nobanner', /lacks the .* banner/, 'no-banner'],
];

for (const [dir, re, label] of REFUSALS) {
  test(`Q-B: refuses ${label} with a clear message (no best-effort)`, () => {
    const out = tmpOut('refuse');
    throwsMatching(
      () => migrator.runMigration({ inDir: fixture(dir), outDir: out, now: PINNED_NOW }),
      re,
      label,
    );
    assert.ok(migrator.MigrateError, 'exposes MigrateError');
    // and it wrote NOTHING
    assert.strictEqual(fs.readdirSync(out).length, 0, 'refusal writes no output');
  });
}

test('Q-B: the refusal is a MigrateError (a clean refuse, not a crash)', () => {
  let err;
  try { migrator.runMigration({ inDir: fixture('refuse-2file'), outDir: tmpOut('r'), now: PINNED_NOW }); }
  catch (e) { err = e; }
  assert.ok(err instanceof migrator.MigrateError, 'refusal is a MigrateError');
});

// ── safety rails ─────────────────────────────────────────────────────────────

test('safety: --in and --out-dir are required (no defaults)', () => {
  throwsMatching(() => migrator.runMigration({ outDir: tmpOut('s') }), /--in is required/, 'missing --in');
  throwsMatching(() => migrator.runMigration({ inDir: fixture('session-0021') }), /--out-dir is required/, 'missing --out-dir');
});

test('safety: --out-dir equal to / inside --in is refused', () => {
  const inDir = fixture('session-0021');
  throwsMatching(() => migrator.runMigration({ inDir, outDir: inDir, now: PINNED_NOW }), /is \(or is inside\) --in/, 'out == in');
  throwsMatching(() => migrator.runMigration({ inDir, outDir: path.join(inDir, 'sub'), now: PINNED_NOW }), /is \(or is inside\) --in/, 'out inside in');
});

test('safety: an --out-dir inside a live .claude/claude-tpm/sessions tree is refused', () => {
  throwsMatching(
    () => migrator.runMigration({
      inDir: fixture('session-0021'),
      outDir: '/tmp/some/.claude/claude-tpm/sessions/session-0099',
      now: PINNED_NOW,
    }),
    /live \.claude\/claude-tpm\/sessions tree/,
    'live sessions guard',
  );
});

test('safety: --dry-run writes nothing but validates', () => {
  const out = tmpOut('dry');
  const res = migrator.runMigration({ inDir: fixture('session-0021'), outDir: out, dryRun: true, now: PINNED_NOW });
  assert.strictEqual(res.written, false);
  assert.strictEqual(res.valid, true);
  assert.strictEqual(fs.readdirSync(out).length, 0, 'dry-run wrote nothing');
});

test('safety: an existing output is refused without --force, overwritten with --force', () => {
  const out = tmpOut('force');
  migrator.runMigration({ inDir: fixture('session-0021'), outDir: out, now: PINNED_NOW });
  throwsMatching(
    () => migrator.runMigration({ inDir: fixture('session-0021'), outDir: out, now: PINNED_NOW }),
    /already exists .* --force/,
    'existing output without --force',
  );
  const res = migrator.runMigration({ inDir: fixture('session-0021'), outDir: out, force: true, now: PINNED_NOW });
  assert.ok(res.written, '--force overwrites');
});

test('safety: --emit-md also writes a derived, non-empty session-<NNNN>.md', () => {
  const out = tmpOut('md');
  const res = migrator.runMigration({ inDir: fixture('session-0021'), outDir: out, emitMd: true, now: PINNED_NOW });
  assert.ok(res.mdPath && fs.existsSync(res.mdPath), 'md written');
  const md = fs.readFileSync(res.mdPath, 'utf8');
  assert.ok(/# Session 0021/.test(md), 'derived md has the session header');
  assert.ok(/## Handoff/.test(md) && /## Punchlist/.test(md) && /## Log/.test(md), 'md has the sections');
});

// #4 (smoke): the derived .md is emitted BY DEFAULT; --no-emit-md opts out.
test('#4: migrate emits the .md by DEFAULT (no flag); emitMd:false opts out', () => {
  const outDefault = tmpOut('md-default');
  const rDef = migrator.runMigration({ inDir: fixture('session-0021'), outDir: outDefault, now: PINNED_NOW });
  assert.ok(rDef.mdPath && fs.existsSync(rDef.mdPath), 'the .md is written with NO emitMd flag (default on)');

  const outOff = tmpOut('md-off');
  const rOff = migrator.runMigration({ inDir: fixture('session-0021'), outDir: outOff, emitMd: false, now: PINNED_NOW });
  assert.strictEqual(rOff.mdPath, null, 'emitMd:false opts out — no mdPath');
  assert.ok(!fs.existsSync(path.join(outOff, 'session-0021', 'session-0021.md')), 'no .md on opt-out');
});

test('#4: CLI migrate writes the .md by default; --no-emit-md skips it', () => {
  const outD = tmpOut('cli-md-default');
  runCli(['--in', fixture('session-0021'), '--out-dir', outD, '--now', PINNED_NOW]);
  assert.ok(fs.existsSync(path.join(outD, 'session-0021', 'session-0021.md')), 'CLI default emits the .md');

  const outN = tmpOut('cli-md-off');
  runCli(['--in', fixture('session-0021'), '--out-dir', outN, '--no-emit-md', '--now', PINNED_NOW]);
  assert.ok(!fs.existsSync(path.join(outN, 'session-0021', 'session-0021.md')), '--no-emit-md skips the .md');
  assert.ok(fs.existsSync(path.join(outN, 'session-0021', 'session-0021.json')), 'json still written');
});

// ── validate-before-write ────────────────────────────────────────────────────

test('validate-before-write: an injected invalid record throws and writes nothing', () => {
  // Simulate a would-be-invalid record by pointing at a marked trio whose log ts is not ISO-TZ.
  const bad = tmpOut('badsrc-in');
  const B = '<!-- tpm-session: 0055 · 2026-09-01 · tpm-session-version: 1.0 · files: x -->';
  fs.writeFileSync(path.join(bad, 'session-0055-handoff.md'),
    B + '\n# HANDOFF\n\n## Where we are / Next / In flight\n**Where we are:** w.\n**Next action:** n.\n**In flight:** a\n');
  fs.writeFileSync(path.join(bad, 'session-0055-log.md'),
    B + '\n# SESSION 0055\n\n## Log\n- [ADDED] #55.1 [aaaaaa] bad ts  [2026-09-01 10:00 no-offset]\n\nSEALED 2026-09-01\n');
  fs.writeFileSync(path.join(bad, 'session-0055-punchlist.md'),
    B + '\n# Punchlist\n\n## Open\n\n## Done\n');
  const out = tmpOut('badsrc-out');
  // The log line lacks a trailing [ISO-TZ] bracket -> parse refuses before any write.
  throwsMatching(
    () => migrator.runMigration({ inDir: bad, outDir: out, now: PINNED_NOW }),
    /timestamp|missing a trailing/,
    'invalid timestamp',
  );
  assert.strictEqual(fs.readdirSync(out).length, 0, 'nothing written on failure');
});

// ── CLI (node-invokable, exit codes) ─────────────────────────────────────────

function runCli(args) {
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
}

test('CLI: --help exits 0 and prints usage', () => {
  const r = runCli(['--help']);
  assert.strictEqual(r.status, 0);
  assert.ok(/tpm-session-migrate/.test(r.stdout), 'usage printed');
});

test('CLI: a successful migration exits 0 and reports what it wrote', () => {
  const out = tmpOut('cli-ok');
  const r = runCli(['--in', fixture('session-0021'), '--out-dir', out, '--now', PINNED_NOW]);
  assert.strictEqual(r.status, 0, 'exit 0');
  assert.ok(/session 0021 . WROTE/.test(r.stderr), 'reports the write');
  assert.ok(fs.existsSync(path.join(out, 'session-0021', 'session-0021.json')), 'file exists (nested per-session folder)');
});

test('CLI: a refused (Q-B) input exits non-zero with a clear message', () => {
  const out = tmpOut('cli-refuse');
  const r = runCli(['--in', fixture('refuse-2file'), '--out-dir', out, '--dry-run']);
  assert.strictEqual(r.status, 1, 'exit 1 on refuse');
  assert.ok(/refused/.test(r.stderr), 'stderr says refused');
});

test('CLI: a missing required flag exits with usage (code 2 for arg error / 1 for runtime)', () => {
  const r = runCli(['--out-dir', tmpOut('cli-missing')]);
  assert.notStrictEqual(r.status, 0, 'non-zero without --in');
});

done('session-migrate.test.js');
