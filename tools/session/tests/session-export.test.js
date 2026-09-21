'use strict';
/**
 * session-export.test.js — the P05 export tool (tpm-session-export.js).
 *
 * Builds a THROWAWAY multi-session fixture dir (via the real session-model ops → saveSession,
 * so every fixture is a schema-valid canonical envelope) under the OS tmp — NEVER the live
 * `.claude/claude-tpm/sessions/` — then asserts every export shape from the LOCKED export-spec:
 *   - single-session full JSON (bare envelope) + human (one-way .md, age renders via the closure)
 *   - multi-session combined JSON (a BARE ARRAY of envelopes, Q4) + combined human (full header
 *     REPEATED per session, Q4)
 *   - multi-session per-session files (JSON and/or human)
 *   - JSON and/or human selectable
 *   - the search-composition seam (explicit selector list + a pre-loaded record set + a filter)
 *   - thin/editable export is NOT wired (Q3)
 *   - the `now` CLOSURE (open items render age; without it the converter throws)
 *   - the node-invokable CLI (bare `node <file>`) exits 0 and emits the shapes
 *
 * Run: node tests/session-export.test.js
 */
const os = require('os');
const { spawnSync } = require('child_process');
const { assert, test, done, throwsMatching, fs, path } = require('./helpers/harness');

const exporter = require('../tpm-session-export');
const model = require('../lib/session-model');
const { render } = require('../lib/session-converter');

const TOOL = path.join(__dirname, '..', 'tpm-session-export.js');

// ── build a scratch multi-session fixture dir (NEVER the live sessions dir) ────
function pad4(n) { return String(n).padStart(4, '0'); }

// One valid session record with a handoff, a log (note + decision), an open + a done punchlist item.
function makeRecord(i) {
  let rec = model.openSession({ number: String(i), sessionId: `sid-${i}`, tpmVersion: '1.0.0' });
  rec = model.importHandoff(rec, {
    where: `where ${i}`, next: `next ${i}`, in_flight: [`flight ${i}`], must_not_redo: [`redo ${i}`],
  });
  rec = model.appendLog(rec, { status: 'NOTE', text: `opened ${i}` });
  rec = model.appendLog(rec, { type: 'decision', what: `chose ${i}`, why: `because ${i}` });
  rec = model.addPunchlist(rec, { text: `open item ${i}`, slug: `slug${i}o` });
  rec = model.addPunchlist(rec, { text: `done item ${i}`, slug: `slug${i}d` });
  rec = model.closePunchlistItem(rec, `slug${i}d`); // -> one 'done' item; the other stays 'open'
  return rec;
}

function buildFixtureDir(count) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-export-fix-'));
  const records = [];
  for (let i = 1; i <= count; i++) {
    const rec = makeRecord(i);
    // CANONICAL NESTED layout (Q-F): each session in its own folder session-<NNNN>/session-<NNNN>.json.
    const sessionDir = path.join(dir, `session-${pad4(i)}`);
    fs.mkdirSync(sessionDir, { recursive: true });
    const persisted = model.saveSession(rec, { jsonPath: path.join(sessionDir, `session-${pad4(i)}.json`) });
    records.push(persisted);
  }
  return { dir, records };
}

const { dir: FIX_DIR, records: FIX_RECORDS } = buildFixtureDir(3);

// ── enumeration ───────────────────────────────────────────────────────────────

test('enumerateSessions lists session-<NNNN>.json ascending by number', () => {
  const entries = exporter.enumerateSessions(FIX_DIR);
  assert.deepStrictEqual(entries.map((e) => e.number), [1, 2, 3]);
  assert.ok(entries.every((e) => e.path.endsWith('.json')));
});

// ── single-session full JSON ────────────────────────────────────────────────────

test('single-session full JSON = the canonical bare envelope', () => {
  const { outputs } = exporter.exportSessions({ sessionsDir: FIX_DIR, selector: ['1'], styles: ['json'] });
  assert.strictEqual(outputs.length, 1);
  assert.strictEqual(outputs[0].suggestedName, 'session-0001.json');
  const parsed = JSON.parse(outputs[0].body);
  assert.ok(!Array.isArray(parsed), 'a bare envelope, not an array');
  assert.strictEqual(parsed.kind, 'session');
  assert.strictEqual(parsed.meta.number, '0001'); // canonical stored form is zero-padded NNNN (openSession normalizes)
  assert.ok(parsed.schemaVersion, 'every emitted JSON carries schemaVersion');
});

// ── single-session human (one-way) ──────────────────────────────────────────────

test('single-session human = the converter .md (age renders via the now closure)', () => {
  const { outputs } = exporter.exportSessions({ sessionsDir: FIX_DIR, selector: ['1'], styles: ['human'] });
  assert.strictEqual(outputs.length, 1);
  assert.strictEqual(outputs[0].suggestedName, 'session-0001.md');
  const md = outputs[0].body;
  assert.ok(md.startsWith('# Session 0001'), 'has the human header');
  assert.ok(/## Handoff/.test(md) && /## Punchlist/.test(md) && /## Log/.test(md), 'all sections');
  assert.ok(/\*\*Open \(1\)\*\*/.test(md), 'the open punchlist item is present');
  assert.ok(/\d+[mhd] ago\)_/.test(md), 'punchlist age rendered — the now closure fired (no loud throw)');
});

// ── the now CLOSURE is load-bearing ─────────────────────────────────────────────

test('now closure is load-bearing: bare render(rec) throws on open items; export does NOT', () => {
  const recWithOpen = FIX_RECORDS[0];
  throwsMatching(() => render(recWithOpen), /opts\.now is required/, 'bare render (no now)');
  // The export tool binds now in a closure, so the same record exports cleanly.
  const { outputs } = exporter.exportSessions({ records: [recWithOpen], styles: ['human'] });
  assert.ok(/\d+[mhd] ago\)_/.test(outputs[0].body), 'age rendered because now was bound in the closure');
});

// ── multi-session combined JSON = a BARE ARRAY (Q4) ─────────────────────────────

test('multi combined JSON = a bare array of envelopes (Q4), newest-first', () => {
  const { outputs } = exporter.exportSessions({ sessionsDir: FIX_DIR, last: 3, styles: ['json'], combine: 'one-file' });
  assert.strictEqual(outputs.length, 1);
  const arr = JSON.parse(outputs[0].body);
  assert.ok(Array.isArray(arr), 'combined JSON is a bare array (no wrapper envelope)');
  assert.strictEqual(arr.length, 3);
  assert.deepStrictEqual(arr.map((r) => r.meta.number), ['0003', '0002', '0001'], 'last N is newest-first');
  assert.ok(arr.every((r) => r.kind === 'session' && r.schemaVersion), 'each is a full session envelope');
});

// ── multi-session combined human = full header REPEATED (Q4) ────────────────────

test('multi combined human = the full per-session render REPEATED (Q4)', () => {
  const { outputs } = exporter.exportSessions({ sessionsDir: FIX_DIR, last: 3, styles: ['human'], combine: 'one-file' });
  assert.strictEqual(outputs.length, 1);
  const headers = outputs[0].body.match(/^# Session \d{4}/gm) || [];
  assert.strictEqual(headers.length, 3, 'the full header repeats once per session (not a single top header)');
  assert.deepStrictEqual(headers, ['# Session 0003', '# Session 0002', '# Session 0001']);
});

// ── multi-session per-session files (JSON and/or human) ──────────────────────────

test('multi per-file: one file per session, JSON and human together', () => {
  const { outputs } = exporter.exportSessions({ sessionsDir: FIX_DIR, last: 3, styles: ['json', 'human'], combine: 'per-file' });
  const names = outputs.map((o) => o.suggestedName).sort();
  assert.deepStrictEqual(names, [
    'session-0001.json', 'session-0001.md',
    'session-0002.json', 'session-0002.md',
    'session-0003.json', 'session-0003.md',
  ].sort());
  // each JSON output is a bare envelope (not an array)
  const jsons = outputs.filter((o) => o.style === 'json');
  assert.ok(jsons.every((o) => !Array.isArray(JSON.parse(o.body))), 'per-file JSON = bare envelopes');
});

// ── JSON and/or human selectable ────────────────────────────────────────────────

test('both styles selectable for a single session', () => {
  const { outputs } = exporter.exportSessions({ records: [FIX_RECORDS[0]], styles: 'both' });
  assert.deepStrictEqual(outputs.map((o) => o.style).sort(), ['human', 'json']);
});

test('normalizeStyles: dedupes, accepts comma/both, rejects garbage', () => {
  assert.deepStrictEqual(exporter.normalizeStyles(['json', 'json']), ['json']);
  assert.deepStrictEqual(exporter.normalizeStyles('json,human'), ['json', 'human']);
  assert.deepStrictEqual(exporter.normalizeStyles('both'), ['json', 'human']);
  assert.deepStrictEqual(exporter.normalizeStyles(null), ['json']);
  throwsMatching(() => exporter.normalizeStyles('thin'), /unknown --style/, 'thin is not a style');
});

// ── search-composition SEAM (compose, do NOT re-match) ──────────────────────────

test('seam: an explicit selector list is used verbatim, order preserved', () => {
  const { records, outputs } = exporter.exportSessions({ sessionsDir: FIX_DIR, selector: ['3', '1'], styles: ['json'], combine: 'per-file' });
  assert.deepStrictEqual(records.map((r) => r.meta.number), ['0003', '0001'], 'selector order preserved, no re-sort');
  assert.deepStrictEqual(outputs.map((o) => o.suggestedName), ['session-0003.json', 'session-0001.json']);
});

test('seam: a pre-loaded record result-set exports without a dir (#1092 handoff)', () => {
  const { records } = exporter.exportSessions({ records: [FIX_RECORDS[1]], styles: ['json'] });
  assert.deepStrictEqual(records.map((r) => r.meta.number), ['0002']);
});

test('seam: a filter predicate composes via selectRecords (no re-matching here)', () => {
  const { records } = exporter.exportSessions({ sessionsDir: FIX_DIR, last: 3, filter: (r) => r.meta.number !== '0002', styles: ['json'] });
  assert.deepStrictEqual(records.map((r) => r.meta.number), ['0003', '0001']);
});

test('selector padding: bare and zero-padded numbers both resolve', () => {
  const a = exporter.exportSessions({ sessionsDir: FIX_DIR, selector: ['2'], styles: ['json'] });
  const b = exporter.exportSessions({ sessionsDir: FIX_DIR, selector: ['0002'], styles: ['json'] });
  assert.strictEqual(JSON.parse(a.outputs[0].body).meta.number, '0002'); // filename selector still resolves; stored form is canonical NNNN
  assert.strictEqual(JSON.parse(b.outputs[0].body).meta.number, '0002');
});

test('a selector matching nothing fails loud', () => {
  throwsMatching(() => exporter.exportSessions({ sessionsDir: FIX_DIR, selector: ['999'], styles: ['json'] }), /matched no session/);
});

// ── writing to disk (dir + single file), scratch only ───────────────────────────

test('writes per-session files into a scratch out dir', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-export-out-'));
  const { outputs, written } = exporter.exportSessions({ sessionsDir: FIX_DIR, last: 2, styles: ['json', 'human'], combine: 'per-file', out: outDir });
  assert.strictEqual(written, true);
  for (const o of outputs) {
    assert.ok(fs.existsSync(o.path), `${o.suggestedName} exists on disk`);
    assert.strictEqual(fs.readFileSync(o.path, 'utf8'), o.body, 'file body matches');
  }
});

test('writes a single combined file to an explicit --out file path', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-export-out1-'));
  const outFile = path.join(outDir, 'combined.json');
  const { outputs } = exporter.exportSessions({ sessionsDir: FIX_DIR, last: 3, styles: ['json'], combine: 'one-file', out: outFile });
  assert.strictEqual(outputs[0].path, outFile);
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(outFile, 'utf8'))), 'the combined bare array landed at the file path');
});

test('refuses a single-file --out when many files would be produced', () => {
  throwsMatching(
    () => exporter.exportSessions({ sessionsDir: FIX_DIR, last: 3, styles: ['json'], combine: 'per-file', out: path.join(os.tmpdir(), 'x.json') }),
    /give a directory/,
  );
});

// ── the live sessions dir is never touched (guard) ──────────────────────────────

test('nothing is written when --out is omitted', () => {
  const before = fs.readdirSync(FIX_DIR).sort();
  const { written } = exporter.exportSessions({ sessionsDir: FIX_DIR, last: 3, styles: ['json'] });
  assert.strictEqual(written, false);
  assert.deepStrictEqual(fs.readdirSync(FIX_DIR).sort(), before, 'the sessions dir is read-only to export');
});

// ── the node-invokable CLI (bare `node <file>`) ─────────────────────────────────

function runCli(args) {
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
}

test('CLI: bare `node tpm-session-export.js --last N --style json` -> exit 0 + a bare array', () => {
  const res = runCli(['--sessions-dir', FIX_DIR, '--last', '2', '--style', 'json']);
  assert.strictEqual(res.status, 0, res.stderr);
  const arr = JSON.parse(res.stdout);
  assert.ok(Array.isArray(arr) && arr.length === 2, 'stdout is the combined bare array');
});

test('CLI: --session selector + --out dir writes files, exit 0', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-export-cli-'));
  const res = runCli(['--sessions-dir', FIX_DIR, '--session', '1,3', '--style', 'both', '--combine', 'per-file', '--out', outDir]);
  assert.strictEqual(res.status, 0, res.stderr);
  const wrote = fs.readdirSync(outDir).sort();
  assert.deepStrictEqual(wrote, ['session-0001.json', 'session-0001.md', 'session-0003.json', 'session-0003.md']);
});

test('CLI: thin/editable export is NOT wired (Q3) — --thin is an unknown arg (exit 2)', () => {
  const res = runCli(['--sessions-dir', FIX_DIR, '--last', '1', '--thin']);
  assert.strictEqual(res.status, 2, 'no thin flag exists');
  assert.ok(/unknown argument/.test(res.stderr));
});

test('CLI: --help exits 0 and documents the surface', () => {
  const res = runCli(['--help']);
  assert.strictEqual(res.status, 0);
  assert.ok(/--last/.test(res.stdout) && /--style/.test(res.stdout) && /Thin/.test(res.stdout));
});

done('session-export.test');
