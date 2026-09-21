#!/usr/bin/env node
/**
 * tests/session/tpm-session-review/test.js — genuine tests for tools/session/tpm-session-review.js,
 * UPDATED for the #1094 naming sweep + version read-gate (spec §13.6).
 *
 * WHAT CHANGED FROM THE PRIOR SUITE
 *   Files are now session-number-PREFIXED (session-NNNN-{handoff,punchlist,log}.md) and numbers are
 *   padded-4. The reader is GATED on the `tpm-session-version: 1.0` preamble: a pre-v1.0 / unmarked /
 *   unprefixed folder is IGNORED (not "flagged legacy", not crashed) — there is NO legacy tier and NO
 *   `legacy` field in the JSON. A window with zero v1.0 sessions prints "No sessions found." A v1.0
 *   session with a log but no handoff still shows via the ledger fallback (that is NOT legacy).
 *
 *   Fixtures are built via renderHandoff / renderPunchlist / renderNote (the SAME SSOT the write tools
 *   use, so read/write share one ground truth) — every canonical file therefore carries the v1.0
 *   preamble. A hand-made unmarked file exercises the IGNORE (read-gate) path.
 *
 * HOW TO RUN
 *   node tests/session/tpm-session-review/test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeChecker, runNode, mkSandbox, TOOLS } = require('../lib/harness');

const fmt = require(TOOLS.format);
const { check, count } = makeChecker();

function review(sessionsDir, args) {
  return runNode(TOOLS.sessionReview, ['--sessions-dir', sessionsDir, ...args]);
}

const TS = (d) => `${d}T10:00:00-07:00`; // a fixed created/decision stamp; shape is what matters elsewhere

/**
 * Write a full three-file canonical (v1.0) session at the PREFIXED paths, via the SSOT (so every file
 * carries the tpm-session-version: 1.0 preamble). `open`/`done` are punchlist item texts; handoff (if
 * given) supplies Where/Next; notes supply decisions/log.
 */
function writeCanonicalSession(dir, number, { theme, date, where, next, open = [], done = [], decisions = [], log = [], noHandoff = false }) {
  const folder = path.join(dir, `session-${number}`);
  fs.mkdirSync(folder, { recursive: true });
  const num = Number(number);
  const items = [
    ...open.map((t, i) => ({ done: false, session: num, n: i + 1, text: t, slug: `op${number}${i}`.slice(0, 6).padEnd(6, '0'), created: TS(date), closed: null })),
    ...done.map((t, i) => ({ done: true, session: num, n: open.length + i + 1, text: t, slug: `dn${number}${i}`.slice(0, 6).padEnd(6, '0'), created: TS(date), closed: TS(date) })),
  ];
  fs.writeFileSync(path.join(folder, `session-${number}-punchlist.md`), fmt.renderPunchlist({ number, date, items }));
  fs.writeFileSync(path.join(folder, `session-${number}-log.md`), fmt.renderNote({
    number, date, theme,
    decisions: decisions.map((d) => ({ what: d.what, why: d.why, ts: TS(date) })),
    log: log.map((l) => ({ status: l.status, text: l.text, ts: TS(date) })),
  }));
  if (!noHandoff) {
    const openSpecs = items.filter((it) => !it.done).map((it) => ({ session: it.session, n: it.n, text: it.text, slug: it.slug, created: it.created }));
    fs.writeFileSync(path.join(folder, `session-${number}-handoff.md`), fmt.renderHandoff({ where, next }, openSpecs, { number, date }));
  }
}

/**
 * Write a NON-v1.0 (pre-sweep / hand-made) session: a `session-NNNN-log.md` at the prefixed path but
 * WITHOUT the tpm-session-version: 1.0 preamble. The reader must IGNORE it (read-gate), never parse or
 * crash on it. The `mentions` string lets a grep test target its body if needed.
 */
function writeNonV1Session(dir, number, mentions = 'old freeform prose') {
  const folder = path.join(dir, `session-${number}`);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `session-${number}-log.md`),
    `# SESSION ${number} — 2020-01-01 — pre-sweep\n\n## RESUME\n**Where we are:** ${mentions}\n\n## Open items\n- [ ] an old open item\n`);
}

// ---- fixture set: 0001 non-v1 (IGNORED), 0002 canonical (older), 0003 canonical (newer) ----

function buildFixtures() {
  const dir = mkSandbox('review-fixtures');
  writeNonV1Session(dir, '0001', 'old prose mentioning database once');
  writeCanonicalSession(dir, '0002', {
    theme: 'first canonical session', date: '2026-08-01',
    where: 'built the write API', next: 'build the read API',
    open: ['review the format doc'], done: ['write lib/format.js'],
    decisions: [{ what: 'single pointer mechanism', why: 'env var unreliable outside subagents' }],
    log: [{ status: 'WIP', text: 'started the write API' }],
  });
  writeCanonicalSession(dir, '0003', {
    theme: 'second canonical session', date: '2026-08-15',
    where: 'built the read API', next: 'write tests',
    open: ['design the database schema'],
  });
  return dir;
}

// ---- overview -----------------------------------------------------------------

check('overview lists v1.0 sessions most-recent-first (Where/Next from handoff) and IGNORES the non-v1.0 one', () => {
  const dir = buildFixtures();
  const r = review(dir, ['--last', '3']);
  assert.strictEqual(r.code, 0);
  const idx0002 = r.stdout.indexOf('session-0002');
  const idx0003 = r.stdout.indexOf('session-0003');
  assert.ok(idx0003 >= 0 && idx0002 >= 0 && idx0003 < idx0002, 'must be descending: 0003 before 0002');
  assert.ok(!r.stdout.includes('session-0001'), 'the non-v1.0 session must be INVISIBLE (ignored, not flagged)');
  assert.ok(!/RESUME|old prose|not token-parseable/.test(r.stdout), 'a non-v1.0 file must NOT be parsed at all');
  assert.ok(r.stdout.includes('second canonical session'), 'canonical theme appears');
  assert.ok(/Where: built the read API/.test(r.stdout), 'Where comes from handoff');
  assert.ok(/Next:  write tests/.test(r.stdout), 'Next comes from handoff');
});

check('overview FALLS BACK to the notes ledger (Decided/Log) when a v1.0 session has no handoff yet', () => {
  const dir = mkSandbox('review-no-handoff');
  writeCanonicalSession(dir, '0004', {
    theme: 'ledger-only', date: '2026-09-01', noHandoff: true,
    decisions: [{ what: 'ship it', why: 'good enough' }],
    log: [{ status: 'DONE', text: 'the last thing' }],
  });
  const r = review(dir, ['--last', '1']);
  assert.strictEqual(r.code, 0);
  assert.ok(/Decided: ship it — good enough/.test(r.stdout), 'ledger Decided fallback shown (this is v1.0, NOT legacy)');
  assert.ok(/Log:\s+\[DONE\] the last thing/.test(r.stdout), 'ledger Log fallback shown');
});

check('overview honors --last N, taking only the N most recent v1.0 sessions', () => {
  const dir = buildFixtures();
  const r = review(dir, ['--last', '1']);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('session-0003'));
  assert.ok(!r.stdout.includes('session-0002'));
  assert.ok(!r.stdout.includes('session-0001'));
});

// ---- version read-gate: a window with zero v1.0 sessions ----------------------

check('READ-GATE: a dir of ONLY non-v1.0 sessions prints "No sessions found." (ignored, never crashes)', () => {
  const dir = mkSandbox('review-only-nonv1');
  writeNonV1Session(dir, '0001');
  writeNonV1Session(dir, '0002');
  const r = review(dir, ['--last', '5']);
  assert.strictEqual(r.code, 0, 'a non-v1.0-only window must not crash');
  assert.ok(/No sessions found/.test(r.stdout), 'zero v1.0 sessions → clean "No sessions found."');
  assert.ok(!/session-0001|session-0002/.test(r.stdout), 'no non-v1.0 folder may leak into the output');
});

// ---- --open-items -------------------------------------------------------------

check('--open-items prints open punchlist items per selected v1.0 session, with id/slug/created', () => {
  const dir = buildFixtures();
  const r = review(dir, ['--last', '3', '--open-items']);
  assert.strictEqual(r.code, 0);
  assert.ok(/session-0002 — #2\.1 · review the format doc/.test(r.stdout));
  assert.ok(/session-0003 — #3\.1 · design the database schema/.test(r.stdout));
  assert.ok(!/write lib\/format\.js/.test(r.stdout), 'a CLOSED punchlist item must not appear in open-items');
});

check('--open-items excludes non-v1.0 sessions without crashing', () => {
  const dir = buildFixtures();
  const r = review(dir, ['--last', '3', '--open-items']);
  assert.strictEqual(r.code, 0);
  assert.ok(!r.stdout.includes('session-0001'));
});

check('--open-items on a selection with zero open items prints the explicit message', () => {
  const dir = mkSandbox('review-no-open-items');
  writeCanonicalSession(dir, '0001', { theme: 't', date: '2026-01-01', where: 'w', next: 'n' });
  const r = review(dir, ['--last', '1', '--open-items']);
  assert.strictEqual(r.code, 0);
  assert.ok(/No open items found/.test(r.stdout));
});

// ---- --decisions --------------------------------------------------------------

check('--decisions prints every decision across selected v1.0 sessions with what/why', () => {
  const dir = buildFixtures();
  const r = review(dir, ['--last', '3', '--decisions']);
  assert.strictEqual(r.code, 0);
  assert.ok(/session-0002 — Decided: single pointer mechanism — env var unreliable outside subagents/.test(r.stdout));
});

check('--decisions on a selection with zero decisions prints the explicit message', () => {
  const dir = mkSandbox('review-no-decisions');
  writeCanonicalSession(dir, '0001', { theme: 't', date: '2026-01-01', where: 'w', next: 'n' });
  const r = review(dir, ['--last', '1', '--decisions']);
  assert.strictEqual(r.code, 0);
  assert.ok(/No decisions found/.test(r.stdout));
});

// ---- --since ------------------------------------------------------------------

check('--since restricts to v1.0 sessions whose date is >= the given date', () => {
  const dir = buildFixtures();
  const r = review(dir, ['--last', '3', '--since', '2026-08-10']);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('session-0003'), '0003 (2026-08-15) >= since — included');
  assert.ok(r.stdout.includes('second canonical session'));
  assert.ok(!r.stdout.includes('first canonical session'), '0002 (2026-08-01) is before --since — excluded');
});

check('--since with a far-future date excludes all v1.0 sessions AND still ignores non-v1.0 → "No sessions found."', () => {
  const dir = buildFixtures();
  const r = review(dir, ['--last', '3', '--since', '2099-01-01']);
  assert.strictEqual(r.code, 0);
  assert.ok(/No sessions found/.test(r.stdout), 'both v1.0 sessions are before --since; the non-v1.0 one is ignored');
  assert.ok(!r.stdout.includes('session-0001'), 'a non-v1.0 session is never resurrected by --since');
});

// ---- --grep -------------------------------------------------------------------

check('--grep is case-insensitive and filters to only v1.0 sessions containing the term', () => {
  const dir = buildFixtures();
  const r = review(dir, ['--last', '3', '--grep', 'DATABASE']);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('session-0003'), 'session-0003 open item mentions "database"');
  assert.ok(!r.stdout.includes('session-0002'), 'session-0002 has no match and must be excluded');
  assert.ok(!r.stdout.includes('session-0001'), 'the non-v1.0 session is never grepped (it is invisible)');
});

check('--grep combined with --open-items shows only matching open items', () => {
  const dir = buildFixtures();
  const r = review(dir, ['--last', '3', '--open-items', '--grep', 'format']);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('review the format doc'));
  assert.ok(!r.stdout.includes('design the database schema'));
});

// ---- --json -------------------------------------------------------------------

check('--json emits the three-file loadSession shape (number, parsed, handoff, open) with NO legacy field', () => {
  const dir = buildFixtures();
  const r = review(dir, ['--last', '1', '--json']);
  assert.strictEqual(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.length, 1);
  const s = parsed[0];
  assert.strictEqual(s.number, '0003');
  assert.strictEqual(s.parsed.theme, 'second canonical session');
  assert.strictEqual(s.handoff.where, 'built the read API');
  assert.strictEqual(s.open.length, 1);
  assert.strictEqual(s.open[0].text, 'design the database schema');
  assert.ok(!('legacy' in s), 'the removed no-back-compat model has NO legacy field in the JSON');
});

// ---- CLI usage errors ---------------------------------------------------------

check('CLI: missing --sessions-dir or --last exits 1', () => {
  const dir = mkSandbox('review-missing-flags');
  assert.strictEqual(review(dir, []).code, 1);
  assert.strictEqual(runNode(TOOLS.sessionReview, ['--last', '5']).code, 1);
  assert.strictEqual(review(dir, ['--last', 'not-a-number']).code, 1);
});

check('CLI: an empty (nonexistent) sessionsDir reports "No sessions found." rather than crashing', () => {
  const dir = mkSandbox('review-empty-dir');
  const r = review(path.join(dir, 'does-not-exist-yet'), ['--last', '5']);
  assert.strictEqual(r.code, 0);
  assert.ok(/No sessions found/.test(r.stdout));
});

check('CLI: --help exits 0', () => {
  const r = runNode(TOOLS.sessionReview, ['--help']);
  assert.strictEqual(r.code, 0);
  assert.ok(/Usage: npx tpm session review/.test(r.stdout));
});

process.stdout.write(`\nALL PASS (${count()} checks) — tests/session/tpm-session-review/test.js\n`);
process.exit(0);
