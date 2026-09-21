'use strict';
/**
 * session-ops.test.js — the P06 session OPS + IMPORT tool (tpm-session-ops.js) + the #1115
 * close-guard + the fromSession carry-in provenance end-to-end.
 *
 * Every op runs against a THROWAWAY sessions dir under the OS tmp (mkdtemp) — NEVER the live
 * `.claude/claude-tpm/sessions/`. Asserts the REAL result of each op (state change / file
 * content / thrown message), not just "it ran":
 *   - open (fresh + prior-fold carry-in with fromSession provenance) writes JSON (atomic) + the
 *     derived .md via the converter; the .md renders "⤴ _carried from NNNN_".
 *   - save re-persists + regenerates the .md.
 *   - note appends a log entry (log + decision), append-only, monotonic seq.
 *   - punchlist add / close / reopen / drop / carry-in.
 *   - close-guard (#1115): REFUSES unless a handoff AND a punchlist are both present, naming what's
 *     missing (both directions tested — the guard is load-bearing, proven it fails red); passes when
 *     both present and stamps closedAt.
 *   - import-handoff (JSON obj / full-record extraction / text+next / mechanical ignored / text w/o
 *     next fails), import-log (append-only text, monotonic seq), import-punchlist (JSON array + text
 *     lines; state NEVER set by import).
 *   - the node-invokable CLI (bare `node <file>`) exits 0 on success and 1 when the close-guard fires.
 *
 * Run: node tests/session-ops.test.js   (also auto-discovered by run-all).
 * Node built-ins only.
 */
const os = require('os');
const { spawnSync } = require('child_process');
const { assert, test, done, throwsMatching, fs, path } = require('./helpers/harness');

const ops = require('../tpm-session-ops');
const model = require('../lib/session-model');
const { render } = require('../lib/session-converter');

const TOOL = path.join(__dirname, '..', 'tpm-session-ops.js');
const ISO_TZ = /[+-]\d{2}:\d{2}$/;
const NOW = '2026-09-19T13:36:00-07:00';

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-ops-')); }
// NESTED canonical layout (Q-F): <dir>/session-<NNNN>/session-<NNNN>.{json,md} — what ops writes.
function jsonPath(dir, n) { const p = String(n).padStart(4, '0'); return path.join(dir, `session-${p}`, `session-${p}.json`); }
function mdPath(dir, n) { const p = String(n).padStart(4, '0'); return path.join(dir, `session-${p}`, `session-${p}.md`); }

// Build + persist a valid, closeable session (handoff + a punchlist item) in `dir`.
function seedClosable(dir, number) {
  ops.opOpen({ sessionsDir: dir, number, sessionId: `sid-${number}`, tpmVersion: '1.0.0', now: NOW });
  ops.opImportHandoff({ sessionsDir: dir, number, txtFile: writeTmp(dir, 'h.txt', 'we are here'), next: 'do next', now: NOW });
  ops.opPunchlist({ sessionsDir: dir, number, action: 'add', text: 'a task', slug: 'seed01', now: NOW });
  return model.loadSession(jsonPath(dir, number));
}

function writeTmp(dir, name, contents) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, contents);
  return p;
}

// ── open + save + atomic JSON-then-md ──────────────────────────────────────────

test('open: fresh session writes canonical JSON (atomic) + derived .md; lifecycle defaults', () => {
  const dir = scratch();
  const rec = ops.opOpen({ sessionsDir: dir, number: '0021', sessionId: 'sid-a', tpmVersion: '1.0.0', now: NOW });
  assert.ok(fs.existsSync(jsonPath(dir, 21)), 'canonical JSON written');
  assert.ok(fs.existsSync(mdPath(dir, 21)), 'derived .md written');
  assert.strictEqual(rec.handoff, null, 'null handoff on fresh open');
  assert.deepStrictEqual(rec.punchlist, []);
  const md = fs.readFileSync(mdPath(dir, 21), 'utf8');
  assert.strictEqual(md, render(rec, { now: NOW }), 'md == render(persisted, {now}) — regenerated via the converter');
  assert.ok(md.includes('_No handoff yet'), 'null handoff placeholder in the .md');
});

// ── #1122.C: stored meta.number is canonical NNNN, decoupled from the padded filename ──
test('open with an UN-PADDED number: stored meta.number is canonical "0031"; file is session-0031.json; ops still resolve', () => {
  const dir = scratch();
  // Open with the un-padded form '31' (not '0031'): openSession NORMALIZES the STORED field, and
  // sessionPaths pads the filename independently — both must land on the canonical NNNN.
  const rec = ops.opOpen({ sessionsDir: dir, number: '31', sessionId: 'sid-a', tpmVersion: '1.0.0', now: NOW });
  assert.strictEqual(rec.meta.number, '0031', 'stored meta.number normalized to zero-padded width-4 STRING (load-bearing)');
  assert.ok(fs.existsSync(jsonPath(dir, 31)), 'canonical file is session-0031.json regardless of the input form');
  assert.ok(fs.existsSync(mdPath(dir, 31)), 'derived session-0031.md written');
  // open→ops→save→load all hit session-0031.json even though we passed the un-padded '31'.
  ops.opNote({ sessionsDir: dir, number: '31', type: 'log', status: 'NOTE', text: 'still resolves', now: NOW });
  const saved = ops.opSave({ sessionsDir: dir, number: '31', now: NOW });
  assert.strictEqual(saved.meta.number, '0031', 'save round-trips the canonical stored form');
  const reloaded = model.loadSession(jsonPath(dir, 31));
  assert.strictEqual(reloaded.meta.number, '0031', 'reloaded canonical JSON carries the padded stored number');
  assert.strictEqual(reloaded.log.length, 1, 'the note landed in the session the un-padded number resolved to');
});

test('canonicalNumber normalizes every input form to one zero-padded width-4 STRING; rejects non-integers', () => {
  assert.strictEqual(model.canonicalNumber('31'), '0031', 'un-padded string');
  assert.strictEqual(model.canonicalNumber('0031'), '0031', 'already-padded string is idempotent');
  assert.strictEqual(model.canonicalNumber(31), '0031', 'bare integer');
  assert.strictEqual(model.canonicalNumber('7'), '0007', 'single digit pads to 4');
  assert.strictEqual(model.canonicalNumber('12345'), '12345', 'wider-than-4 keeps its natural width');
  assert.strictEqual(typeof model.canonicalNumber(31), 'string', 'always a STRING, never the integer');
  throwsMatching(() => model.canonicalNumber('abc'), /non-negative integer/, 'a non-integer is refused loud');
  throwsMatching(() => model.canonicalNumber('3.5'), /non-negative integer/, 'a non-integer number is refused loud');
});

test('open with a prior session folds still-open items forward with fromSession provenance', () => {
  const dir = scratch();
  // prior (0020) with one OPEN + one DONE item
  ops.opOpen({ sessionsDir: dir, number: '0020', sessionId: 'sid-prev', tpmVersion: '1.0.0', now: NOW });
  ops.opPunchlist({ sessionsDir: dir, number: '0020', action: 'add', text: 'carry me', slug: 'lineg1', now: NOW });
  ops.opPunchlist({ sessionsDir: dir, number: '0020', action: 'add', text: 'finished', slug: 'done01', now: NOW });
  ops.opPunchlist({ sessionsDir: dir, number: '0020', action: 'close', idOrSlug: 'done01', now: NOW });

  const rec = ops.opOpen({
    sessionsDir: dir, number: '0021', sessionId: 'sid-a', tpmVersion: '1.0.0',
    priorSessionPath: jsonPath(dir, 20), now: NOW,
  });
  assert.strictEqual(rec.punchlist.length, 1, 'only the still-OPEN prior item carries in');
  const carried = rec.punchlist[0];
  assert.strictEqual(carried.slug, 'lineg1', 'lineage slug preserved');
  assert.strictEqual(carried.id, '21.1', 'NEW session-prefixed id');
  const ev = carried.events.find((e) => e.op === 'carry-in');
  assert.ok(ev, 'carry-in event present');
  assert.strictEqual(ev.fromSession, '0020', 'fromSession stamped = source session number verbatim (provenance)');

  const md = fs.readFileSync(mdPath(dir, 21), 'utf8');
  assert.ok(md.includes('⤴ _carried from 0020_ — carry me'), 'the .md renders "⤴ _carried from 0020_"');
});

test('save: re-persists and regenerates the .md; re-stamps handoff.updatedAt', () => {
  const dir = scratch();
  seedClosable(dir, '0021');
  const before = model.loadSession(jsonPath(dir, 21)).handoff.updatedAt;
  // mutate the .md out from under us to prove save regenerates it
  fs.writeFileSync(mdPath(dir, 21), 'STALE');
  const rec = ops.opSave({ sessionsDir: dir, number: '0021', now: NOW });
  const md = fs.readFileSync(mdPath(dir, 21), 'utf8');
  assert.notStrictEqual(md, 'STALE', 'save regenerated the .md');
  assert.strictEqual(md, render(rec, { now: NOW }), 'md == render(persisted)');
  assert.ok(ISO_TZ.test(rec.handoff.updatedAt), 'updatedAt is a valid local-offset stamp');
  assert.ok(rec.handoff.updatedAt >= before, 'updatedAt re-stamped (monotonic)');
});

// ── note (decide + log) ────────────────────────────────────────────────────────

test('note: appends a plain log line and a decision, append-only with monotonic seq', () => {
  const dir = scratch();
  ops.opOpen({ sessionsDir: dir, number: '0021', sessionId: 'sid-a', tpmVersion: '1.0.0', now: NOW });
  ops.opNote({ sessionsDir: dir, number: '0021', type: 'log', status: 'NOTE', text: 'first line', now: NOW });
  const rec = ops.opNote({ sessionsDir: dir, number: '0021', type: 'decision', what: 'chose X', why: 'because Y', now: NOW });
  assert.deepStrictEqual(rec.log.map((e) => e.seq), [1, 2], 'monotonic seq');
  assert.strictEqual(rec.log[0].text, 'first line');
  assert.strictEqual(rec.log[1].type, 'decision');
  assert.strictEqual(rec.log[1].what, 'chose X');
});

// ── punchlist ops ────────────────────────────────────────────────────────────

test('punchlist: add / close / reopen / drop drive state + the event trail', () => {
  const dir = scratch();
  ops.opOpen({ sessionsDir: dir, number: '0021', sessionId: 'sid-a', tpmVersion: '1.0.0', now: NOW });
  ops.opPunchlist({ sessionsDir: dir, number: '0021', action: 'add', text: 'thing', slug: 's1', now: NOW });
  ops.opPunchlist({ sessionsDir: dir, number: '0021', action: 'close', idOrSlug: 's1', now: NOW });
  ops.opPunchlist({ sessionsDir: dir, number: '0021', action: 'reopen', idOrSlug: '21.1', now: NOW });
  const rec = ops.opPunchlist({ sessionsDir: dir, number: '0021', action: 'drop', idOrSlug: 's1', now: NOW });
  assert.strictEqual(rec.punchlist[0].state, 'dropped');
  assert.deepStrictEqual(rec.punchlist[0].events.map((e) => e.op), ['add', 'close', 'reopen', 'drop']);
});

test('punchlist carry-in: copies a still-open item from a prior file with fromSession', () => {
  const dir = scratch();
  ops.opOpen({ sessionsDir: dir, number: '0020', sessionId: 'sid-prev', tpmVersion: '1.0.0', now: NOW });
  ops.opPunchlist({ sessionsDir: dir, number: '0020', action: 'add', text: 'manual carry', slug: 'man001', now: NOW });
  ops.opOpen({ sessionsDir: dir, number: '0021', sessionId: 'sid-a', tpmVersion: '1.0.0', now: NOW });
  const rec = ops.opPunchlist({
    sessionsDir: dir, number: '0021', action: 'carry-in',
    priorSessionPath: jsonPath(dir, 20), item: 'man001', now: NOW,
  });
  const carried = rec.punchlist[0];
  assert.strictEqual(carried.slug, 'man001', 'same lineage slug');
  assert.strictEqual(carried.events.find((e) => e.op === 'carry-in').fromSession, '0020');
});

test('punchlist carry-in: refuses a non-open source item', () => {
  const dir = scratch();
  ops.opOpen({ sessionsDir: dir, number: '0020', sessionId: 'sid-prev', tpmVersion: '1.0.0', now: NOW });
  ops.opPunchlist({ sessionsDir: dir, number: '0020', action: 'add', text: 'done one', slug: 'dn001', now: NOW });
  ops.opPunchlist({ sessionsDir: dir, number: '0020', action: 'close', idOrSlug: 'dn001', now: NOW });
  ops.opOpen({ sessionsDir: dir, number: '0021', sessionId: 'sid-a', tpmVersion: '1.0.0', now: NOW });
  throwsMatching(
    () => ops.opPunchlist({ sessionsDir: dir, number: '0021', action: 'carry-in', priorSessionPath: jsonPath(dir, 20), item: 'dn001', now: NOW }),
    /only OPEN items carry in/,
  );
});

// ── CLOSE-GUARD (#1115) — load-bearing, tested both directions ──────────────────

test('close-guard: REFUSES with no handoff and no punchlist, naming both', () => {
  const dir = scratch();
  ops.opOpen({ sessionsDir: dir, number: '0021', sessionId: 'sid-a', tpmVersion: '1.0.0', now: NOW });
  throwsMatching(
    () => ops.opClose({ sessionsDir: dir, number: '0021', now: NOW }),
    /missing a handoff and a punchlist/,
    'names both missing assets',
  );
});

test('close-guard: REFUSES when only the punchlist is missing (handoff present)', () => {
  const dir = scratch();
  ops.opOpen({ sessionsDir: dir, number: '0021', sessionId: 'sid-a', tpmVersion: '1.0.0', now: NOW });
  ops.opImportHandoff({ sessionsDir: dir, number: '0021', txtFile: writeTmp(dir, 'h.txt', 'here'), next: 'next', now: NOW });
  throwsMatching(
    () => ops.opClose({ sessionsDir: dir, number: '0021', now: NOW }),
    /missing a punchlist/,
    'names the punchlist as missing',
  );
});

test('close-guard: REFUSES when only the handoff is missing (punchlist present)', () => {
  const dir = scratch();
  ops.opOpen({ sessionsDir: dir, number: '0021', sessionId: 'sid-a', tpmVersion: '1.0.0', now: NOW });
  ops.opPunchlist({ sessionsDir: dir, number: '0021', action: 'add', text: 'a task', now: NOW });
  throwsMatching(
    () => ops.opClose({ sessionsDir: dir, number: '0021', now: NOW }),
    /missing a handoff/,
    'names the handoff as missing',
  );
});

test('close-guard: PASSES when a handoff AND a punchlist are both present; stamps closedAt', () => {
  const dir = scratch();
  seedClosable(dir, '0021');
  const rec = ops.opClose({ sessionsDir: dir, number: '0021', now: NOW });
  assert.ok(ISO_TZ.test(rec.meta.closedAt), 'closedAt stamped');
  const md = fs.readFileSync(mdPath(dir, 21), 'utf8');
  assert.ok(md.includes('· **closed** ·'), 'the derived .md shows the closed state');
});

// ── IMPORT (#1115) ──────────────────────────────────────────────────────────────

test('import-handoff (JSON obj): REPLACE; mechanical fields ignored', () => {
  const dir = scratch();
  ops.opOpen({ sessionsDir: dir, number: '0021', sessionId: 'sid-a', tpmVersion: '1.0.0', now: NOW });
  const f = writeTmp(dir, 'h.json', JSON.stringify({
    where: 'W', next: 'N', in_flight: ['x'], must_not_redo: ['y'],
    updatedAt: 'HACKED', bogus: 'nope',
  }));
  const rec = ops.opImportHandoff({ sessionsDir: dir, number: '0021', jsonFile: f, now: NOW });
  assert.strictEqual(rec.handoff.where, 'W');
  assert.deepStrictEqual(rec.handoff.in_flight, ['x']);
  assert.ok(!('bogus' in rec.handoff), 'non-editable key dropped');
  assert.ok(rec.handoff.updatedAt !== 'HACKED' && ISO_TZ.test(rec.handoff.updatedAt), 'updatedAt is a fresh stamp, not the imported one');
});

test('import-handoff (full session record file): extracts .handoff', () => {
  const dir = scratch();
  ops.opOpen({ sessionsDir: dir, number: '0021', sessionId: 'sid-a', tpmVersion: '1.0.0', now: NOW });
  const fullRecord = { schemaVersion: '1.0.0', kind: 'session', meta: {}, handoff: { where: 'FromRecord', next: 'go' }, log: [], punchlist: [] };
  const f = writeTmp(dir, 'rec.json', JSON.stringify(fullRecord));
  const rec = ops.opImportHandoff({ sessionsDir: dir, number: '0021', jsonFile: f, now: NOW });
  assert.strictEqual(rec.handoff.where, 'FromRecord');
  assert.strictEqual(rec.handoff.next, 'go');
});

test('import-handoff (text): raw text -> where; --next fills the required next', () => {
  const dir = scratch();
  ops.opOpen({ sessionsDir: dir, number: '0021', sessionId: 'sid-a', tpmVersion: '1.0.0', now: NOW });
  const f = writeTmp(dir, 'body.txt', 'multi\nline\nhandoff body\n');
  const rec = ops.opImportHandoff({
    sessionsDir: dir, number: '0021', txtFile: f, next: 'the next step',
    inFlight: ['wip1'], mustNotRedo: ['dont'], now: NOW,
  });
  assert.strictEqual(rec.handoff.where, 'multi\nline\nhandoff body', 'trailing newline trimmed, body preserved');
  assert.strictEqual(rec.handoff.next, 'the next step');
  assert.deepStrictEqual(rec.handoff.in_flight, ['wip1']);
});

test('import-handoff (text) without a next fails loud (replace cannot invent it)', () => {
  const dir = scratch();
  ops.opOpen({ sessionsDir: dir, number: '0021', sessionId: 'sid-a', tpmVersion: '1.0.0', now: NOW });
  const f = writeTmp(dir, 'body.txt', 'just a where');
  throwsMatching(
    () => ops.opImportHandoff({ sessionsDir: dir, number: '0021', txtFile: f, now: NOW }),
    /needs a non-empty `next`/,
  );
});

test('import-log (text): APPEND-ONLY; existing entries never rewritten; monotonic seq', () => {
  const dir = scratch();
  ops.opOpen({ sessionsDir: dir, number: '0021', sessionId: 'sid-a', tpmVersion: '1.0.0', now: NOW });
  ops.opNote({ sessionsDir: dir, number: '0021', type: 'log', status: 'NOTE', text: 'existing', now: NOW });
  const before = JSON.stringify(model.loadSession(jsonPath(dir, 21)).log[0]);
  const f = writeTmp(dir, 'add.txt', 'a rich\nmulti-line\naddendum');
  const rec = ops.opImportLog({ sessionsDir: dir, number: '0021', txtFile: f, status: 'PROGRESS', now: NOW });
  assert.deepStrictEqual(rec.log.map((e) => e.seq), [1, 2], 'append allocates the next monotonic seq');
  assert.strictEqual(JSON.stringify(rec.log[0]), before, 'existing entry byte-identical (never rewritten)');
  assert.strictEqual(rec.log[1].text, 'a rich\nmulti-line\naddendum', 'multi-line body imported without shell-escaping');
  assert.strictEqual(rec.log[1].status, 'PROGRESS');
});

test('import-punchlist (JSON array + text lines): ADD; state NEVER set by import', () => {
  const dir = scratch();
  ops.opOpen({ sessionsDir: dir, number: '0021', sessionId: 'sid-a', tpmVersion: '1.0.0', now: NOW });
  const jf = writeTmp(dir, 'items.json', JSON.stringify([{ text: 'json item', state: 'done', slug: 'keep11' }, 'bare string item']));
  let rec = ops.opImportPunchlist({ sessionsDir: dir, number: '0021', file: jf, now: NOW });
  assert.strictEqual(rec.punchlist.length, 2);
  assert.strictEqual(rec.punchlist[0].state, 'open', 'import NEVER sets state (was "done" in the file)');
  assert.strictEqual(rec.punchlist[0].slug, 'keep11');
  assert.strictEqual(rec.punchlist[0].events[0].op, 'add');
  assert.strictEqual(rec.punchlist[1].text, 'bare string item');

  const tf = writeTmp(dir, 'items.txt', 'line one\n\nline two\n');
  rec = ops.opImportPunchlist({ sessionsDir: dir, number: '0021', file: tf, now: NOW });
  assert.strictEqual(rec.punchlist.length, 4, 'two more items, blank line skipped');
  assert.deepStrictEqual(rec.punchlist.slice(2).map((it) => it.text), ['line one', 'line two']);
});

// ── the node-invokable CLI (bare `node <file>`, Q5: no bin) ──────────────────────

function runCli(args) {
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
}

test('CLI: open then close-guard-passing close exits 0; files land in the scratch dir', () => {
  const dir = scratch();
  let r = runCli(['open', '--sessions-dir', dir, '--session', '0021', '--session-id', 'sid-a', '--tpm-version', '1.0.0', '--now', NOW]);
  assert.strictEqual(r.status, 0, r.stderr);
  const hf = writeTmp(dir, 'h.txt', 'cli where');
  r = runCli(['import-handoff', '--sessions-dir', dir, '--session', '0021', '--txt-file', hf, '--next', 'cli next', '--now', NOW]);
  assert.strictEqual(r.status, 0, r.stderr);
  r = runCli(['punchlist', '--sessions-dir', dir, '--session', '0021', '--action', 'add', '--text', 'cli task', '--now', NOW]);
  assert.strictEqual(r.status, 0, r.stderr);
  r = runCli(['close', '--sessions-dir', dir, '--session', '0021', '--now', NOW]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.readFileSync(mdPath(dir, 21), 'utf8').includes('· **closed** ·'), 'closed via the CLI');
});

test('CLI: close on an unguarded session exits 1 and names what is missing', () => {
  const dir = scratch();
  runCli(['open', '--sessions-dir', dir, '--session', '0021', '--session-id', 'sid-a', '--tpm-version', '1.0.0', '--now', NOW]);
  const r = runCli(['close', '--sessions-dir', dir, '--session', '0021', '--now', NOW]);
  assert.strictEqual(r.status, 1, 'non-zero exit on a refused close');
  assert.ok(/missing a handoff and a punchlist/.test(r.stderr), 'stderr names what is missing');
});

test('CLI: --help exits 0 and documents the verbs + import surface', () => {
  const r = runCli(['--help']);
  assert.strictEqual(r.status, 0);
  assert.ok(/import-handoff/.test(r.stdout) && /close-guard|REFUSES/.test(r.stdout), 'help documents import + close-guard');
});

test('CLI: an unknown verb exits 1', () => {
  const r = runCli(['frobnicate', '--sessions-dir', scratch(), '--session', '0021']);
  assert.strictEqual(r.status, 1);
});

done('session-ops.test.js');
