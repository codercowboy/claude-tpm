#!/usr/bin/env node
/**
 * tests/session/tpm-session-notes/test.js — genuine tests for tools/session/tpm-session-notes.js,
 * REWRITTEN for the THREE-FILE model (spec §3, §12.5; destructive rewrite ratified 2026-09-17).
 *
 * WHAT CHANGED FROM THE OLD SUITE
 *   The ledger is now APPEND-ONLY: `## Decisions` + `## Log`, each line carrying a TRAILING
 *   [ISO-8601-TZ] stamp. The `resume` and `open` verbs are GONE (RESUME → handoff.md via `save`;
 *   open items → punchlist.md via `punchlist`). So the ~8 old resume/open-lifecycle assertions were
 *   removed and replaced with: the retired verbs are unknown; log/decide stamp a trailing ISO-TZ.
 *   The Bug-fixer-r1 "a custom --status tag survives a subsequent write" regression is PRESERVED,
 *   adapted to the new trailing-ts log line.
 *
 * PURPOSE
 *   Drives tpm-session-notes.js as a REAL subprocess against a fresh sandbox sessionsDir, and
 *   asserts on the actual on-disk content each verb produces — not just exit codes. ISO-TZ is
 *   asserted by SHAPE (/[+-]\d{2}:\d{2}\]$/), never a literal offset (CI may run in UTC).
 *
 * HOW TO RUN
 *   node tests/session/tpm-session-notes/test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeChecker, runNode, mkSandbox, TOOLS } = require('../lib/harness');

const { check, count } = makeChecker();

const TRAILING_ISO_TZ = /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\]$/m;

function run(sessionsDir, args) {
  return runNode(TOOLS.sessionNotes, ['--sessions-dir', sessionsDir, ...args]);
}

function noteText(sessionsDir, number, filename) {
  // The ledger file is now session-number-PREFIXED and renamed to `-log.md` (spec §13.6).
  const name = filename || `session-${number}-log.md`;
  return fs.readFileSync(path.join(sessionsDir, `session-${number}`, name), 'utf8');
}

function openSession(sessionsDir) {
  const r = runNode(TOOLS.currentSession, ['--sessions-dir', sessionsDir, '--open']);
  assert.strictEqual(r.code, 0, `helper openSession failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// =====================================================================================
// RETIRED VERBS — resume/open are gone
// =====================================================================================

check('RETIRED: `resume` is no longer a verb (unknown verb, exit 1)', () => {
  const dir = mkSandbox('retired-resume');
  openSession(dir);
  const r = run(dir, ['resume', '--where', 'x', '--next', 'y']);
  assert.strictEqual(r.code, 1);
  assert.ok(/unknown verb "resume"/.test(r.stderr), `expected unknown-verb, got: ${r.stderr}`);
});

check('RETIRED: `open` is no longer a verb (unknown verb, exit 1)', () => {
  const dir = mkSandbox('retired-open');
  openSession(dir);
  const r = run(dir, ['open', 'add', 'a thing']);
  assert.strictEqual(r.code, 1);
  assert.ok(/unknown verb "open"/.test(r.stderr), `expected unknown-verb, got: ${r.stderr}`);
});

check('RETIRED: help no longer advertises resume/open; it lists init|log|decide|seal', () => {
  const r = runNode(TOOLS.sessionNotes, ['--help']);
  assert.strictEqual(r.code, 0);
  assert.ok(/log --status/.test(r.stdout) && /decide/.test(r.stdout) && /seal/.test(r.stdout));
  assert.ok(!/^\s+resume\b/m.test(r.stdout), 'help must not list a resume verb');
});

// =====================================================================================
// GUARD RAILS — each must exit 1 with no session created / no file mutated
// =====================================================================================

check('GUARD: `log` with no session open exits 1, telling the caller to `tpm-session open`', () => {
  const dir = mkSandbox('guard-no-open-log');
  const r = run(dir, ['log', '--status', 'WIP', 'did a thing']);
  assert.strictEqual(r.code, 1);
  assert.ok(/no session is currently open/.test(r.stderr));
  assert.ok(/tpm-session open/.test(r.stderr));
});

check('GUARD: `decide` with no session open ALSO refuses', () => {
  const dir = mkSandbox('guard-no-open-decide');
  const r = run(dir, ['decide', 'x', '--why', 'y']);
  assert.strictEqual(r.code, 1);
  assert.ok(/no session is currently open/.test(r.stderr));
});

check('GUARD: --edit-sealed WITHOUT --confirm exits 1 and touches nothing', () => {
  const dir = mkSandbox('guard-edit-sealed-noconfirm');
  const opened = openSession(dir);
  run(dir, ['log', '--status', 'WIP', 'a line']);
  run(dir, ['seal']);
  const before = noteText(dir, opened.number);

  const r = run(dir, ['--edit-sealed', opened.number, 'log', '--status', 'WIP', 'sneaky edit']);
  assert.strictEqual(r.code, 1);
  assert.ok(/requires --confirm/.test(r.stderr));
  assert.strictEqual(noteText(dir, opened.number), before, 'file must be byte-identical after a refused edit');
});

check('GUARD: --edit-sealed --confirm against a non-canonical PREFIXED ledger refuses (ENOTCANONICAL), touches nothing', () => {
  const dir = mkSandbox('guard-noncanonical-refuse');
  const folder = path.join(dir, 'session-0003');
  fs.mkdirSync(folder, { recursive: true });
  // A non-canonical ledger at the PREFIXED path (no "# SESSION NNNN" title) — the tool must refuse
  // to auto-rewrite it, never crash. (No back-compat: only a v1.0 prefixed session is a valid target.)
  const noncanonPath = path.join(folder, 'session-0003-log.md');
  const noncanonContent = 'Just freeform prose from before this tool existed. No headings.\n';
  fs.writeFileSync(noncanonPath, noncanonContent);

  const r = run(dir, ['--edit-sealed', '0003', '--confirm', 'log', '--status', 'WIP', 'touch non-canonical']);
  assert.strictEqual(r.code, 1);
  assert.ok(/refuses to auto-rewrite/.test(r.stderr), `expected ENOTCANONICAL, got: ${r.stderr}`);
  assert.strictEqual(fs.readFileSync(noncanonPath, 'utf8'), noncanonContent, 'the non-canonical file must be untouched');
});

check('GUARD: `log` without --status/text exits 1 (required args enforced)', () => {
  const dir = mkSandbox('guard-log-args');
  openSession(dir);
  const r = run(dir, ['log', 'text with no --status flag but positional']);
  // No --status supplied -> refused.
  assert.strictEqual(r.code, 1);
  assert.ok(/log requires --status and a text argument/.test(r.stderr));
});

check('GUARD: `decide` without --why exits 1', () => {
  const dir = mkSandbox('guard-decide-args');
  openSession(dir);
  const r = run(dir, ['decide', 'a decision with no why']);
  assert.strictEqual(r.code, 1);
  assert.ok(/requires a text argument and --why/.test(r.stderr));
});

check('CLI: missing --sessions-dir exits 1', () => {
  const r = runNode(TOOLS.sessionNotes, ['log', '--status', 'WIP', 'x']);
  assert.strictEqual(r.code, 1);
  assert.ok(/--sessions-dir is required/.test(r.stderr));
});

check('CLI: no verb given exits 1', () => {
  const dir = mkSandbox('cli-no-verb');
  assert.strictEqual(run(dir, []).code, 1);
});

check('CLI: unknown verb exits 1', () => {
  const dir = mkSandbox('cli-unknown-verb');
  openSession(dir);
  const r = run(dir, ['bogus-verb']);
  assert.strictEqual(r.code, 1);
  assert.ok(/unknown verb/.test(r.stderr));
});

check('CLI: --help exits 0', () => {
  const r = runNode(TOOLS.sessionNotes, ['--help']);
  assert.strictEqual(r.code, 0);
  assert.ok(/Usage: npx tpm session notes/.test(r.stdout));
});

// =====================================================================================
// THE DELIBERATE OVERRIDE PATH DOES work
// =====================================================================================

check('--edit-sealed <NNN> --confirm against a CANONICAL sealed note DOES succeed', () => {
  const dir = mkSandbox('override-canonical-sealed');
  const opened = openSession(dir);
  run(dir, ['log', '--status', 'WIP', 'setting up']);
  run(dir, ['seal']);

  const r = run(dir, ['--edit-sealed', opened.number, '--confirm', 'log', '--status', 'WIP', 'a deliberate post-seal log line']);
  assert.strictEqual(r.code, 0, `expected the override to succeed, got: ${r.stderr}`);
  const text = noteText(dir, opened.number);
  assert.ok(text.includes('a deliberate post-seal log line'), 'the override log line must land in the file');
  assert.ok(text.includes('SEALED'), 'the SEALED stamp must still be present after an override edit');
});

// =====================================================================================
// FULL LIFECYCLE — open -> init -> log -> decide -> seal (the NEW ledger)
// =====================================================================================

check('LIFECYCLE: init creates the skeleton with the canonical title + wayfinding header', () => {
  const dir = mkSandbox('lifecycle-init');
  const opened = openSession(dir);
  const r = run(dir, ['init', '--theme', 'lifecycle test']);
  assert.strictEqual(r.code, 0);
  const text = noteText(dir, opened.number);
  assert.ok(/^<!-- tpm-session: /m.test(text), 'skeleton carries the wayfinding header anchor');
  assert.ok(text.includes(`# SESSION ${opened.number} — `), 'canonical title present');
  assert.ok(text.includes('lifecycle test'));
  assert.ok(text.includes('## Decisions') && text.includes('## Log'), 'ledger sections present');
});

check('LIFECYCLE: init is idempotent — a second init is a no-op that reports so', () => {
  const dir = mkSandbox('lifecycle-init-idempotent');
  const opened = openSession(dir);
  run(dir, ['init', '--theme', 'first theme']);
  const before = noteText(dir, opened.number);
  const r = run(dir, ['init', '--theme', 'a DIFFERENT theme that must be ignored']);
  assert.strictEqual(r.code, 0);
  assert.ok(/already exists — nothing to init/.test(r.stdout));
  assert.strictEqual(noteText(dir, opened.number), before, 'a second init must not touch the file');
});

check('LIFECYCLE: `log` writes a TRAILING [ISO-TZ] stamp (shape, not a literal offset)', () => {
  const dir = mkSandbox('lifecycle-log-ts');
  const opened = openSession(dir);
  const r = run(dir, ['log', '--status', 'WIP', 'first log line']);
  assert.strictEqual(r.code, 0);
  const text = noteText(dir, opened.number);
  const logLine = text.split('\n').find((l) => l.includes('first log line'));
  assert.ok(/^- \[WIP\] first log line  \[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\]$/.test(logLine),
    `log line must carry a trailing ISO-TZ: ${logLine}`);
});

check('LIFECYCLE: `decide` writes a TRAILING [ISO-TZ] stamp too (symmetry with log)', () => {
  const dir = mkSandbox('lifecycle-decide-ts');
  const opened = openSession(dir);
  const r = run(dir, ['decide', 'chose JSON payload', '--why', 'portable and greppable']);
  assert.strictEqual(r.code, 0);
  const text = noteText(dir, opened.number);
  const decLine = text.split('\n').find((l) => l.includes('chose JSON payload'));
  assert.ok(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\]$/.test(decLine),
    `decision line must carry a trailing ISO-TZ: ${decLine}`);
  assert.ok(decLine.includes('**Decided:** chose JSON payload — portable and greppable'));
});

check('LIFECYCLE: `log` entries are APPEND-ONLY — two calls produce two ordered entries, none lost', () => {
  const dir = mkSandbox('lifecycle-log-append');
  const opened = openSession(dir);
  run(dir, ['log', '--status', 'WIP', 'first log line']);
  run(dir, ['log', '--status', 'DONE', 'second log line']);
  const text = noteText(dir, opened.number);
  const firstIdx = text.indexOf('first log line');
  const secondIdx = text.indexOf('second log line');
  assert.ok(firstIdx >= 0 && secondIdx >= 0, 'both log lines must be present');
  assert.ok(firstIdx < secondIdx, 'log lines must appear in append order');
  assert.ok(text.includes('[WIP]') && text.includes('[DONE]'), 'both status tags survive');
});

check('LIFECYCLE: `decide` entries are APPEND-ONLY — two decisions both survive', () => {
  const dir = mkSandbox('lifecycle-decide-append');
  const opened = openSession(dir);
  run(dir, ['decide', 'first decision', '--why', 'reason A']);
  run(dir, ['decide', 'second decision', '--why', 'reason B']);
  const text = noteText(dir, opened.number);
  assert.ok(text.includes('first decision') && text.includes('reason A'));
  assert.ok(text.includes('second decision') && text.includes('reason B'));
});

check('LIFECYCLE: seal stamps SEALED <date> AND closes the current-session pointer', () => {
  const dir = mkSandbox('lifecycle-seal');
  const opened = openSession(dir);
  run(dir, ['log', '--status', 'WIP', 'wrapping up']);

  const before = runNode(TOOLS.currentSession, ['--sessions-dir', dir, '--state']);
  assert.strictEqual(JSON.parse(before.stdout).state, 'open');

  const sealR = run(dir, ['seal']);
  assert.strictEqual(sealR.code, 0);
  const text = noteText(dir, opened.number);
  assert.ok(/^SEALED \d{4}-\d{2}-\d{2}$/m.test(text), 'file must carry a SEALED <date> trailer');

  const after = runNode(TOOLS.currentSession, ['--sessions-dir', dir, '--state']);
  assert.strictEqual(JSON.parse(after.stdout).state, 'not-opened', 'seal must close the pointer');
});

check('LIFECYCLE: a write verb lazily creates the skeleton if `init` was never called', () => {
  const dir = mkSandbox('lifecycle-lazy-init');
  const opened = openSession(dir);
  const r = run(dir, ['log', '--status', 'WIP', 'first thing, no explicit init']);
  assert.strictEqual(r.code, 0);
  const text = noteText(dir, opened.number);
  assert.ok(text.includes(`# SESSION ${opened.number} — `));
  assert.ok(text.includes('(untitled)'), 'a lazily-created note gets the "(untitled)" theme');
});

// =====================================================================================
// REGRESSION (Bug-fixer r1, adapted to the trailing-ts log line): a custom `log --status <TAG>`
// entry must survive a SUBSEQUENT write, end-to-end via the real CLI. The tool reloads-then-
// rerenders the whole file on every write, so a tag the parser cannot re-read would silently
// DISAPPEAR from disk the next time anything is written.
// =====================================================================================

check('REGRESSION: a custom `log --status` tag survives a SECOND write on disk', () => {
  const dir = mkSandbox('regression-custom-status-survives');
  const opened = openSession(dir);

  const r1 = run(dir, ['log', '--status', 'CUSTOM', 'a custom-tagged log line']);
  assert.strictEqual(r1.code, 0, `first log call failed: ${r1.stderr}`);
  const afterFirst = noteText(dir, opened.number);
  assert.ok(afterFirst.includes('[CUSTOM]') && afterFirst.includes('a custom-tagged log line'),
    'custom-tagged line present after the first write');
  assert.ok(TRAILING_ISO_TZ.test(afterFirst), 'first write already carries a trailing ISO-TZ');

  const r2 = run(dir, ['log', '--status', 'DONE', 'a normal entry']);
  assert.strictEqual(r2.code, 0, `second log call failed: ${r2.stderr}`);

  const afterSecond = noteText(dir, opened.number);
  assert.ok(afterSecond.includes('[CUSTOM]') && afterSecond.includes('a custom-tagged log line'),
    'the custom-tagged line must SURVIVE a subsequent write — the data-loss regression');
  assert.ok(afterSecond.includes('[DONE]') && afterSecond.includes('a normal entry'),
    'the new canonical-tag line must also be present');

  const customIdx = afterSecond.indexOf('a custom-tagged log line');
  const doneIdx = afterSecond.indexOf('a normal entry');
  assert.ok(customIdx >= 0 && doneIdx >= 0 && customIdx < doneIdx, 'both lines present, in append order');
});

// =====================================================================================
// B1 — --edit-sealed is an immutability guard, NOT an arbitrary-path writer (dogfood P0)
// =====================================================================================

check('B1: --edit-sealed on a NONEXISTENT (4-digit) session refuses (exit 1) and fabricates NO folder', () => {
  const dir = mkSandbox('editsealed-nonexistent');
  openSession(dir);
  // 9999 is a well-formed 4-digit id that does not exist → the ENO_SESSION refusal, no fabrication.
  const r = run(dir, ['--edit-sealed', '9999', '--confirm', 'log', '--status', 'X', 'nope']);
  assert.strictEqual(r.code, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'session-9999')), '--edit-sealed must not create session-9999');
});

check('B1: --edit-sealed with a NON-NUMERIC id refuses (exit 1), no folder', () => {
  const dir = mkSandbox('editsealed-abc');
  openSession(dir);
  const r = run(dir, ['--edit-sealed', 'abc', '--confirm', 'log', '--status', 'X', 'nope']);
  assert.strictEqual(r.code, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'session-abc')));
});

check('B1: --edit-sealed with an UNPADDED (non-4-digit) number refuses (exit 1), no folder', () => {
  const dir = mkSandbox('editsealed-unpadded');
  openSession(dir);
  // The digit guard is now /^\d{4}$/ — a bare "4" (and the old 3-digit "004") is rejected outright.
  const r = run(dir, ['--edit-sealed', '4', '--confirm', 'log', '--status', 'X', 'nope']);
  assert.strictEqual(r.code, 1);
  assert.ok(/four digits/.test(r.stderr), `must reject a non-4-digit id: ${r.stderr}`);
  assert.ok(!fs.existsSync(path.join(dir, 'session-4')));
});

// =====================================================================================
// B2 — a newline in a ledger field is refused, never silently corrupted (dogfood P0)
// =====================================================================================

check('B2: a newline in a `log` text is refused (exit 1)', () => {
  const dir = mkSandbox('log-newline');
  openSession(dir);
  const r = run(dir, ['log', '--status', 'WIP', 'line one\nline two']);
  assert.strictEqual(r.code, 1);
  assert.ok(/single line|newline/i.test(r.stderr));
});

check('B2: a newline in a `decide` field is refused (exit 1)', () => {
  const dir = mkSandbox('decide-newline');
  openSession(dir);
  const r = run(dir, ['decide', 'what\nmore', '--why', 'because']);
  assert.strictEqual(r.code, 1);
  assert.ok(/single line|newline/i.test(r.stderr));
});

// =====================================================================================
// #1093 — appendLogEntry({sessionsDir, number, status, text}): the exported ledger-append
// API that tpm-session-punchlist.js calls to record EVERY punchlist op. Tested here at the
// module level (in-process require) since it has no CLI verb of its own.
// =====================================================================================

const { appendLogEntry } = require(TOOLS.sessionNotes);

check('#1093 appendLogEntry lazily creates the skeleton and appends a `- [TAG] text  [ISO-TZ]` Log line', () => {
  const dir = mkSandbox('append-log-lazy');
  const opened = openSession(dir);
  // No init/log yet — the prefixed ledger file must not exist.
  assert.ok(!fs.existsSync(path.join(dir, `session-${opened.number}`, `session-${opened.number}-log.md`)),
    'precondition: no ledger file yet');

  const written = appendLogEntry({ sessionsDir: dir, number: opened.number, status: 'CARRIED', text: '#1.4 [abc123] carry a prior item' });
  assert.ok(fs.existsSync(written), 'appendLogEntry must return the path it wrote and create the file');

  const text = noteText(dir, opened.number);
  assert.ok(text.includes('## Log') && text.includes(`# SESSION ${opened.number} — `), 'a full skeleton was lazily created');
  const line = text.split('\n').find((l) => l.includes('carry a prior item'));
  assert.ok(/^- \[CARRIED\] #1\.4 \[abc123\] carry a prior item  \[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\]$/.test(line),
    `appendLogEntry line shape wrong: ${line}`);
});

check('#1093 appendLogEntry round-trips: the inner [slug] does NOT steal the trailing [ISO-TZ]', () => {
  const dir = mkSandbox('append-log-roundtrip');
  const opened = openSession(dir);
  appendLogEntry({ sessionsDir: dir, number: opened.number, status: 'CLOSED', text: '#20.4 [k3f9az] the item text' });
  const text = noteText(dir, opened.number);
  const line = text.split('\n').find((l) => l.includes('the item text'));
  // The parser's LOG_ENTRY_RE anchors the timestamp at $, so an inner [slug] must not consume it.
  assert.ok(TRAILING_ISO_TZ.test(line), 'the trailing ISO-TZ must survive even with an inner [slug]');
  assert.ok(line.includes('[k3f9az]'), 'the inner [slug] must be preserved verbatim in the text');
});

check('#1093 appendLogEntry is APPEND-ONLY — two calls yield two ordered entries, none lost', () => {
  const dir = mkSandbox('append-log-append');
  const opened = openSession(dir);
  appendLogEntry({ sessionsDir: dir, number: opened.number, status: 'ADDED', text: 'first ledger line' });
  appendLogEntry({ sessionsDir: dir, number: opened.number, status: 'DROPPED', text: 'second ledger line' });
  const text = noteText(dir, opened.number);
  const firstIdx = text.indexOf('first ledger line');
  const secondIdx = text.indexOf('second ledger line');
  assert.ok(firstIdx >= 0 && secondIdx >= 0 && firstIdx < secondIdx, 'both lines present, in append order');
  assert.ok(text.includes('[ADDED]') && text.includes('[DROPPED]'), 'both tags survive');
});

check('#1093 appendLogEntry coexists with the `log` verb — a manual log line survives a subsequent appendLogEntry', () => {
  const dir = mkSandbox('append-log-coexist');
  const opened = openSession(dir);
  const r = run(dir, ['log', '--status', 'WIP', 'a hand-written note']);
  assert.strictEqual(r.code, 0, r.stderr);
  appendLogEntry({ sessionsDir: dir, number: opened.number, status: 'CARRIED', text: '#1.1 [zzz999] a carried item' });
  const text = noteText(dir, opened.number);
  assert.ok(text.includes('a hand-written note') && text.includes('a carried item'),
    'a punchlist-driven append must not clobber an existing hand-written log line');
});

check('#1093 appendLogEntry rejects a missing status / non-string text (throws)', () => {
  const dir = mkSandbox('append-log-args');
  const opened = openSession(dir);
  assert.throws(() => appendLogEntry({ sessionsDir: dir, number: opened.number, status: '', text: 'x' }), /requires a status/);
  assert.throws(() => appendLogEntry({ sessionsDir: dir, number: opened.number, status: 'ADDED', text: null }), /requires a status/);
});

process.stdout.write(`\nALL PASS (${count()} checks) — tests/session/tpm-session-notes/test.js\n`);
process.exit(0);
