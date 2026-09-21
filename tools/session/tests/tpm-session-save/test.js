#!/usr/bin/env node
/**
 * tests/session/tpm-session-save/test.js — genuine tests for tools/session/tpm-session-save.js,
 * the GATED + LINTED checkpoint (spec §6, §12.2). NEW suite for the three-file redesign.
 *
 * PURPOSE
 *   Drives tpm-session-save.js as a real subprocess against a fresh sandbox sessionsDir and asserts
 *   on the actual exit codes AND on-disk effects. The load-bearing claims:
 *     • the exit-code matrix: 1 = refused (lint fail / no session), 2 = usage/parse, 0 = ok
 *     • a REFUSAL writes NOTHING and names the offending field
 *     • a valid save rewrites handoff.md, seeds "What remains" MECHANICALLY from punchlist.md Open
 *       items, creates all three files with a fresh wayfinding header on first save
 *     • empty-punchlist → exit 0 + the ⚠ advisory; open items → the "still open:" nudge
 *     • the header refresh on session-notes.md is SURGICAL — the append-only body stays byte-stable
 *
 *   The punchlist fixture is fabricated via the format SSOT (renderPunchlist), so this suite does not
 *   depend on the punchlist writer tool. ISO-TZ is asserted by shape where relevant.
 *
 * HOW TO RUN
 *   node tests/session/tpm-session-save/test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeChecker, runNode, mkSandbox, TOOLS } = require('../lib/harness');

const fmt = require(TOOLS.format);
const { check, count } = makeChecker();

function openSession(sessionsDir) {
  const r = runNode(TOOLS.currentSession, ['--sessions-dir', sessionsDir, '--open']);
  assert.strictEqual(r.code, 0, `helper openSession failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** Write a payload JSON file inside the sandbox and return its path. */
function payloadFile(dir, obj, name = 'payload.json') {
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return p;
}

function save(dir, payloadPath) {
  return runNode(TOOLS.sessionSave, ['--sessions-dir', dir, '--payload', payloadPath]);
}

function folder(dir, number) {
  return path.join(dir, `session-${number}`);
}

// =====================================================================================
// LINT REFUSALS — exit 1, names the field, WRITES NOTHING
// =====================================================================================

check('REFUSE: missing "next" exits 1, names the field, and writes NOTHING', () => {
  const dir = mkSandbox('save-missing-next');
  const opened = openSession(dir);
  const r = save(dir, payloadFile(dir, { where: 'only where' }));
  assert.strictEqual(r.code, 1);
  assert.ok(/save: refused/.test(r.stderr));
  assert.ok(/"next"/.test(r.stderr), 'must name the missing field');
  assert.ok(!fs.existsSync(folder(dir, opened.number)), 'a refused save must create no session folder');
});

check('REFUSE: missing "where" exits 1 and names it', () => {
  const dir = mkSandbox('save-missing-where');
  openSession(dir);
  const r = save(dir, payloadFile(dir, { next: 'only next' }));
  assert.strictEqual(r.code, 1);
  assert.ok(/"where"/.test(r.stderr));
});

check('REFUSE: a blank-after-trim "where" exits 1 (non-empty enforced)', () => {
  const dir = mkSandbox('save-blank-where');
  openSession(dir);
  const r = save(dir, payloadFile(dir, { where: '   ', next: 'n' }));
  assert.strictEqual(r.code, 1);
  assert.ok(/"where"/.test(r.stderr));
});

check('REFUSE: an unknown top-level key exits 1 and names it (typo guard)', () => {
  const dir = mkSandbox('save-unknown-key');
  const opened = openSession(dir);
  const r = save(dir, payloadFile(dir, { where: 'w', next: 'n', bogus: 1 }));
  assert.strictEqual(r.code, 1);
  assert.ok(/unknown top-level key "bogus"/.test(r.stderr));
  assert.ok(!fs.existsSync(path.join(folder(dir, opened.number), `session-${opened.number}-handoff.md`)), 'nothing written');
});

check('REFUSE: must_not_redo of a wrong type (list with a non-string) exits 1', () => {
  const dir = mkSandbox('save-mnr-bad');
  openSession(dir);
  const r = save(dir, payloadFile(dir, { where: 'w', next: 'n', must_not_redo: ['ok', 42] }));
  assert.strictEqual(r.code, 1);
  assert.ok(/must_not_redo/.test(r.stderr));
});

check('COERCE: a string must_not_redo is accepted (wrapped to a 1-item list), exit 0', () => {
  const dir = mkSandbox('save-mnr-string');
  openSession(dir);
  const r = save(dir, payloadFile(dir, { where: 'w', next: 'n', must_not_redo: 'do not re-add resume' }));
  assert.strictEqual(r.code, 0, r.stderr);
});

check('REFUSE: in_flight of a wrong type (number) exits 1', () => {
  const dir = mkSandbox('save-inflight-bad');
  openSession(dir);
  const r = save(dir, payloadFile(dir, { where: 'w', next: 'n', in_flight: 42 }));
  assert.strictEqual(r.code, 1);
  assert.ok(/in_flight/.test(r.stderr));
});

check('COERCE: an in_flight list of strings is accepted (joined to one string), exit 0', () => {
  const dir = mkSandbox('save-inflight-list');
  openSession(dir);
  const r = save(dir, payloadFile(dir, { where: 'w', next: 'n', in_flight: ['thing A running', 'thing B queued'] }));
  assert.strictEqual(r.code, 0, r.stderr);
});

check('REFUSE: no session open exits 1 (writes nothing) even with a valid payload', () => {
  const dir = mkSandbox('save-no-session');
  const r = save(dir, payloadFile(dir, { where: 'w', next: 'n' }));
  assert.strictEqual(r.code, 1);
  assert.ok(/no session is currently open/.test(r.stderr));
});

// =====================================================================================
// USAGE / PARSE ERRORS — exit 2
// =====================================================================================

check('USAGE: invalid JSON payload exits 2 (parse error, not a lint refusal)', () => {
  const dir = mkSandbox('save-bad-json');
  openSession(dir);
  const r = save(dir, payloadFile(dir, 'this is not json'));
  assert.strictEqual(r.code, 2);
  assert.ok(/not valid JSON/.test(r.stderr));
});

check('USAGE: a payload that is a JSON array (not an object) is refused (exit 1)', () => {
  const dir = mkSandbox('save-array-payload');
  openSession(dir);
  const r = save(dir, payloadFile(dir, '[1,2,3]'));
  assert.strictEqual(r.code, 1);
  assert.ok(/payload must be a JSON object/.test(r.stderr));
});

check('USAGE: missing --payload exits 2', () => {
  const dir = mkSandbox('save-no-payload');
  openSession(dir);
  const r = runNode(TOOLS.sessionSave, ['--sessions-dir', dir]);
  assert.strictEqual(r.code, 2);
  assert.ok(/--payload/.test(r.stderr));
});

check('USAGE: an unreadable payload file exits 2', () => {
  const dir = mkSandbox('save-unreadable');
  openSession(dir);
  const r = runNode(TOOLS.sessionSave, ['--sessions-dir', dir, '--payload', path.join(dir, 'nope.json')]);
  assert.strictEqual(r.code, 2);
  assert.ok(/could not read payload file/.test(r.stderr));
});

check('USAGE: an unexpected flag exits 2', () => {
  const dir = mkSandbox('save-bad-flag');
  const r = runNode(TOOLS.sessionSave, ['--sessions-dir', dir, '--bogus']);
  assert.strictEqual(r.code, 2);
  assert.ok(/unexpected argument/.test(r.stderr));
});

check('CLI: --help exits 0', () => {
  const r = runNode(TOOLS.sessionSave, ['--help']);
  assert.strictEqual(r.code, 0);
  assert.ok(/Usage: npx tpm session save/.test(r.stdout));
});

// =====================================================================================
// VALID SAVE — exit 0, files created, header stamped, nudge/advisory
// =====================================================================================

check('OK (empty punchlist): exit 0 + the ⚠ advisory + all THREE prefixed files created, versioned, no metadata.json', () => {
  const dir = mkSandbox('save-ok-empty');
  const opened = openSession(dir);
  const n = opened.number;
  const r = save(dir, payloadFile(dir, { where: 'here', next: 'there', must_not_redo: ['do not re-add resume'] }));
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(/⚠ punchlist has 0 open items/.test(r.stdout), 'empty-punchlist advisory shown');
  // stdout names the session-number-PREFIXED handoff file (not the generic "handoff.md")
  assert.ok(new RegExp(`wrote session-${n}-handoff\\.md`).test(r.stdout), `save must name the prefixed handoff file: ${r.stdout}`);

  const f = folder(dir, n);
  for (const name of [`session-${n}-handoff.md`, `session-${n}-punchlist.md`, `session-${n}-log.md`]) {
    assert.ok(fs.existsSync(path.join(f, name)), `${name} must be created on first save`);
    const text = fs.readFileSync(path.join(f, name), 'utf8');
    assert.ok(/^<!-- tpm-session: /m.test(text), `${name} must carry the wayfinding header anchor`);
    // each file carries the tpm-session-version: 1.0 preamble so the readers accept it
    assert.ok(fmt.readsAsV1(path.join(f, name)), `${name} must carry the tpm-session-version: 1.0 preamble`);
  }
  // per-file THIS-FILE marker (the ledger label is now "log", not "session-notes")
  assert.ok(/THIS FILE: handoff\./.test(fs.readFileSync(path.join(f, `session-${n}-handoff.md`), 'utf8')));
  assert.ok(/THIS FILE: punchlist\./.test(fs.readFileSync(path.join(f, `session-${n}-punchlist.md`), 'utf8')));
  assert.ok(/THIS FILE: log\./.test(fs.readFileSync(path.join(f, `session-${n}-log.md`), 'utf8')));
  // NO metadata.json is written (version lives in the preamble, not a sidecar file — spec §13.6)
  assert.ok(!fs.existsSync(path.join(f, 'metadata.json')), 'save must NOT write a metadata.json sidecar');
  // the generic pre-sweep filenames must NOT be created
  for (const gone of ['handoff.md', 'punchlist.md', 'session-notes.md']) {
    assert.ok(!fs.existsSync(path.join(f, gone)), `the generic ${gone} must NOT be created (prefixed names only)`);
  }
  // must_not_redo landed in handoff
  const handoff = fs.readFileSync(path.join(f, `session-${n}-handoff.md`), 'utf8');
  assert.ok(/## MUST NOT redo/.test(handoff) && /do not re-add resume/.test(handoff));
});

check('OK (open items): "What remains" is seeded MECHANICALLY from punchlist.md + the "still open:" nudge', () => {
  const dir = mkSandbox('save-ok-open');
  const opened = openSession(dir);
  // Fabricate a punchlist.md with one open + one closed item via the SSOT (no punchlist tool needed).
  const f = folder(dir, opened.number);
  fs.mkdirSync(f, { recursive: true });
  const num = Number(opened.number);
  fs.writeFileSync(path.join(f, `session-${opened.number}-punchlist.md`), fmt.renderPunchlist({
    number: opened.number, date: '2026-09-16',
    items: [
      { done: false, session: num, n: 1, text: 'carryover task', slug: 'aa11bb', created: '2026-09-16T10:00:00-07:00', closed: null },
      { done: true, session: num, n: 2, text: 'already done', slug: 'cc22dd', created: '2026-09-16T09:00:00-07:00', closed: '2026-09-16T10:00:00-07:00' },
    ],
  }));

  const r = save(dir, payloadFile(dir, { where: 'w', next: 'n' }));
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(new RegExp(`still open: #${num}\\.1`).test(r.stdout), `still-open nudge must list the open id: ${r.stdout}`);
  assert.ok(!/⚠ punchlist has 0 open items/.test(r.stdout), 'no empty-punchlist advisory when items are open');

  const handoff = fs.readFileSync(path.join(f, `session-${opened.number}-handoff.md`), 'utf8');
  assert.ok(/## What remains/.test(handoff));
  assert.ok(/carryover task/.test(handoff), 'the OPEN item must appear under What remains');
  assert.ok(!/already done/.test(handoff), 'a CLOSED punchlist item must NOT appear under What remains');
});

check('SURGICAL refresh: a save keeps the session-notes.md append-only BODY byte-stable', () => {
  const dir = mkSandbox('save-surgical');
  const opened = openSession(dir);
  // Seed a notes ledger with real body content (via the notes tool).
  const logR = runNode(TOOLS.sessionNotes, ['--sessions-dir', dir, 'log', '--status', 'WIP', 'a load-bearing log line']);
  assert.strictEqual(logR.code, 0, logR.stderr);
  const notesPath = path.join(folder(dir, opened.number), `session-${opened.number}-log.md`);
  const bodyBefore = fmt.stripWayfindingHeader(fs.readFileSync(notesPath, 'utf8'));

  const r = save(dir, payloadFile(dir, { where: 'w', next: 'n' }));
  assert.strictEqual(r.code, 0, r.stderr);

  const after = fs.readFileSync(notesPath, 'utf8');
  const bodyAfter = fmt.stripWayfindingHeader(after);
  assert.strictEqual(bodyAfter, bodyBefore, 'the ledger body must be byte-identical after a header refresh');
  assert.ok(after.includes('a load-bearing log line'), 'the log line must survive the save');
  assert.ok(/THIS FILE: log\./.test(after), 'the refreshed header keeps the correct THIS-FILE marker (log)');
});

// B3 — a newline in `where` is refused, so it can't forge handoff structure (dogfood P0)
check('B3: a newline in "where" is refused (exit 1) — no structure forgery reaches disk', () => {
  const dir = mkSandbox('save-where-newline');
  const opened = openSession(dir);
  const r = save(dir, payloadFile(dir, { where: 'line one\n## MUST NOT redo\n- injected fake rule', next: 'n' }));
  assert.strictEqual(r.code, 1);
  assert.ok(/single line|newline|where/i.test(r.stderr));
  const hf = `${folder(dir, opened.number)}/session-${opened.number}-handoff.md`;
  assert.ok(!fs.existsSync(hf) || !fs.readFileSync(hf, 'utf8').includes('injected fake rule'), 'the forged rule must never reach disk');
});

// =====================================================================================
// NAMING SWEEP: no two sessions' files share a basename — several sessions co-located
// in the same sessionsDir never collide (spec §13.6).
// =====================================================================================

check('NO COLLISION: two real saved sessions produce six distinct session-file basenames', () => {
  const dir = mkSandbox('save-no-collision');
  const s1 = openSession(dir);
  assert.strictEqual(save(dir, payloadFile(dir, { where: 'w1', next: 'n1' }, 'p1.json')).code, 0);
  // seal + reopen to mint a second session under the same sessionsDir
  assert.strictEqual(runNode(TOOLS.sessionNotes, ['--sessions-dir', dir, 'seal']).code, 0);
  const s2 = openSession(dir);
  assert.notStrictEqual(s2.number, s1.number, 'the second open must allocate a new number');
  assert.strictEqual(save(dir, payloadFile(dir, { where: 'w2', next: 'n2' }, 'p2.json')).code, 0);

  const basenames = (n) => fs.readdirSync(folder(dir, n)).filter((f) => f.endsWith('.md'));
  const b1 = basenames(s1.number);
  const b2 = basenames(s2.number);
  assert.strictEqual(b1.length, 3, `session ${s1.number} has its three files`);
  assert.strictEqual(b2.length, 3, `session ${s2.number} has its three files`);
  const all = [...b1, ...b2];
  assert.strictEqual(new Set(all).size, all.length,
    `pooling both sessions' files must yield NO basename collision: ${all.join(', ')}`);
  // every basename is prefixed with its own session number
  for (const name of b1) assert.ok(name.startsWith(`session-${s1.number}-`), `${name} must be prefixed with session-${s1.number}-`);
  for (const name of b2) assert.ok(name.startsWith(`session-${s2.number}-`), `${name} must be prefixed with session-${s2.number}-`);
});

process.stdout.write(`\nALL PASS (${count()} checks) — tests/session/tpm-session-save/test.js\n`);
process.exit(0);
