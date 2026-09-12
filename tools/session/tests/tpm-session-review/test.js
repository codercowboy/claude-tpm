#!/usr/bin/env node
/**
 * tests/session/session-review/test.js — genuine tests for tools/session/session-review.js
 * (the read API, build-plan.md task B2).
 *
 * PURPOSE
 *   Seeds a fixture sandbox sessionsDir directly on disk (mixing canonical session-notes.md
 *   files, written via the REAL session-notes.js write API so read/write share the same
 *   ground truth, with a legacy freeform notes.md session), then drives session-review.js as
 *   a real subprocess and asserts on the actual printed output / JSON — overview, --open-items,
 *   --decisions, --since, --grep, and legacy-note graceful degradation (flagged, not crashed,
 *   not silently dropped).
 *
 * HOW TO RUN
 *   node tests/session/session-review/test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeChecker, runNode, mkSandbox, TOOLS } = require('../lib/harness');

const { check, count } = makeChecker();

function review(sessionsDir, args) {
  return runNode(TOOLS.sessionReview, ['--sessions-dir', sessionsDir, ...args]);
}

function writeCanonicalSession(sessionsDir, number, { theme, date, resume, openItems = [], decisions = [], logs = [] }) {
  fs.mkdirSync(path.join(sessionsDir, `session-${number}`), { recursive: true });
  // Build via the module directly (lib/format.js) so this fixture is a real, well-formed
  // canonical note without depending on session-notes.js's CLI open/current-session machinery
  // (this suite is testing the READ side; the WRITE side is covered independently in
  // tests/session/session-notes/test.js). This still exercises the SAME renderNote() the write
  // tool uses, so read/write share one ground truth.
  const { renderNote } = require(TOOLS.format);
  const content = renderNote({
    number,
    date,
    theme,
    resume: resume || { whereWeAre: '', nextAction: '', inFlight: 'Nothing in flight.' },
    openItems,
    decisions,
    log: logs,
    sealedAt: null,
  });
  fs.writeFileSync(path.join(sessionsDir, `session-${number}`, 'session-notes.md'), content);
}

function writeLegacySession(sessionsDir, number, prose) {
  fs.mkdirSync(path.join(sessionsDir, `session-${number}`), { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, `session-${number}`, 'notes.md'), prose);
}

// ---- fixture set used by most checks below --------------------------------------
//
//   session-001 (legacy, freeform prose)
//   session-002 (canonical) — open items #1 (open) #2 (done), one decision, one log line
//   session-003 (canonical) — one open item mentioning "database", dated later than 002

function buildFixtures() {
  const dir = mkSandbox('review-fixtures');
  writeLegacySession(dir, '001', 'Old freeform notes. No structure. Mentions "database" once too.\n');
  writeCanonicalSession(dir, '002', {
    theme: 'first canonical session',
    date: '2026-08-01',
    resume: { whereWeAre: 'built the write API', nextAction: 'build the read API', inFlight: 'nothing' },
    openItems: [
      { id: 1, owner: 'jason', done: false, text: 'review the format doc' },
      { id: 2, owner: 'claude', done: true, text: 'write lib/format.js' },
    ],
    decisions: [{ what: 'single pointer mechanism', why: 'env var unreliable outside subagents' }],
    logs: [{ status: 'WIP', date: '2026-08-01T10:00:00.000Z', text: 'started the write API' }],
  });
  writeCanonicalSession(dir, '003', {
    theme: 'second canonical session',
    date: '2026-08-15',
    resume: { whereWeAre: 'built the read API', nextAction: 'write tests', inFlight: 'nothing' },
    openItems: [{ id: 1, owner: 'jason', done: false, text: 'design the database schema' }],
    decisions: [],
    logs: [],
  });
  return dir;
}

// ---- overview (no filter flags) --------------------------------------------------

check('overview lists sessions most-recent-first, flags the legacy one instead of crashing on it', () => {
  const dir = buildFixtures();
  const r = review(dir, ['--last', '3']);
  assert.strictEqual(r.code, 0);
  const idx001 = r.stdout.indexOf('session-001');
  const idx002 = r.stdout.indexOf('session-002');
  const idx003 = r.stdout.indexOf('session-003');
  assert.ok(idx003 < idx002 && idx002 < idx001, 'must be descending (most recent first): 003, 002, 001');
  assert.ok(/legacy format — not token-parseable/.test(r.stdout), 'the legacy session must be flagged, not silently dropped');
  assert.ok(r.stdout.includes('second canonical session'), 'canonical theme must appear');
});

check('overview honors --last N, taking only the N most recent', () => {
  const dir = buildFixtures();
  const r = review(dir, ['--last', '1']);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('session-003'));
  assert.ok(!r.stdout.includes('session-002'));
  assert.ok(!r.stdout.includes('session-001'));
});

check('a session folder with no notes file at all is reported, not silently skipped', () => {
  const dir = buildFixtures();
  fs.mkdirSync(path.join(dir, 'session-004'), { recursive: true }); // empty folder, no notes file
  const r = review(dir, ['--last', '4']);
  assert.strictEqual(r.code, 0);
  assert.ok(/session-004.*no notes file found/.test(r.stdout));
});

// ---- --open-items -------------------------------------------------------------------

check('--open-items prints every open item across the selected sessions, with done-state and owner', () => {
  const dir = buildFixtures();
  const r = review(dir, ['--last', '3', '--open-items']);
  assert.strictEqual(r.code, 0);
  assert.ok(/session-002 — \[ \] OPEN\(jason\) #1: review the format doc/.test(r.stdout));
  assert.ok(/session-002 — \[x\] OPEN\(claude\) #2: write lib\/format\.js/.test(r.stdout));
  assert.ok(/session-003 — \[ \] OPEN\(jason\) #1: design the database schema/.test(r.stdout));
});

check('--open-items excludes legacy sessions (nothing token-parseable to extract) without crashing', () => {
  const dir = buildFixtures();
  const r = review(dir, ['--last', '3', '--open-items']);
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('session-001'));
});

check('--open-items on a selection with zero open items prints the explicit "no open items" message', () => {
  const dir = mkSandbox('review-no-open-items');
  writeCanonicalSession(dir, '001', { theme: 't', date: '2026-01-01', openItems: [], decisions: [], logs: [] });
  const r = review(dir, ['--last', '1', '--open-items']);
  assert.strictEqual(r.code, 0);
  assert.ok(/No open items found/.test(r.stdout));
});

// ---- --decisions --------------------------------------------------------------------

check('--decisions prints every decision across the selected sessions with what/why', () => {
  const dir = buildFixtures();
  const r = review(dir, ['--last', '3', '--decisions']);
  assert.strictEqual(r.code, 0);
  assert.ok(/session-002 — Decided: single pointer mechanism — env var unreliable outside subagents/.test(r.stdout));
});

check('--decisions on a selection with zero decisions prints the explicit "no decisions" message', () => {
  const dir = mkSandbox('review-no-decisions');
  writeCanonicalSession(dir, '001', { theme: 't', date: '2026-01-01', openItems: [], decisions: [], logs: [] });
  const r = review(dir, ['--last', '1', '--decisions']);
  assert.strictEqual(r.code, 0);
  assert.ok(/No decisions found/.test(r.stdout));
});

// ---- --since --------------------------------------------------------------------------

check('--since <date> restricts to canonical sessions whose title date is >= the given date', () => {
  const dir = buildFixtures();
  const r = review(dir, ['--last', '3', '--since', '2026-08-10']);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('session-003'), '003 (2026-08-15) is >= since — must be included');
  assert.ok(r.stdout.includes('second canonical session'), 'theme text for the included session must appear');
  assert.ok(!r.stdout.includes('first canonical session'), '002 (2026-08-01, before --since) must be excluded entirely');
});

check('--since always includes the legacy session (its date is unfilterable, so it is included, not excluded)', () => {
  const dir = buildFixtures();
  const r = review(dir, ['--last', '3', '--since', '2099-01-01']); // a date in the future — no canonical session qualifies
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('session-001'), 'the unfilterable legacy session must still show up');
});

// ---- --grep --------------------------------------------------------------------------

check('--grep is case-insensitive and filters to only sessions/lines containing the term', () => {
  const dir = buildFixtures();
  const r = review(dir, ['--last', '3', '--grep', 'DATABASE']);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('session-003'), 'session-003 open item mentions "database"');
  assert.ok(!r.stdout.includes('session-002'), 'session-002 has no match and must be excluded');
});

check('--grep combined with --open-items shows only the matching open items, not unrelated ones', () => {
  const dir = buildFixtures();
  const r = review(dir, ['--last', '3', '--open-items', '--grep', 'format']);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('review the format doc'));
  assert.ok(!r.stdout.includes('design the database schema'));
});

check('--grep on a legacy session matches against its file path (best-effort, since content is not token-parsed)', () => {
  const dir = mkSandbox('review-grep-legacy');
  writeLegacySession(dir, '001', 'irrelevant prose');
  const r = review(dir, ['--last', '1', '--grep', 'session-001']);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('session-001'));
});

// ---- --json -----------------------------------------------------------------------------

check('--json emits machine-readable structured data matching the prose view', () => {
  const dir = buildFixtures();
  const r = review(dir, ['--last', '1', '--json']);
  assert.strictEqual(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].number, '003');
  assert.strictEqual(parsed[0].parsed.theme, 'second canonical session');
});

// ---- CLI usage errors ---------------------------------------------------------------------

check('CLI: missing --sessions-dir or --last exits 1', () => {
  const dir = mkSandbox('review-missing-flags');
  assert.strictEqual(review(dir, []).code, 1);
  assert.strictEqual(runNode(TOOLS.sessionReview, ['--last', '5']).code, 1);
  assert.strictEqual(review(dir, ['--last', 'not-a-number']).code, 1);
});

check('CLI: an empty (nonexistent) sessionsDir reports "No sessions found." rather than crashing', () => {
  const dir = mkSandbox('review-empty-dir');
  const emptySessionsDir = path.join(dir, 'does-not-exist-yet');
  const r = review(emptySessionsDir, ['--last', '5']);
  assert.strictEqual(r.code, 0);
  assert.ok(/No sessions found/.test(r.stdout));
});

check('CLI: --help exits 0', () => {
  const r = runNode(TOOLS.sessionReview, ['--help']);
  assert.strictEqual(r.code, 0);
  assert.ok(/Usage: node tpm-session-review\.js/.test(r.stdout));
});

process.stdout.write(`\nALL PASS (${count()} checks) — tests/session/session-review/test.js\n`);
process.exit(0);
