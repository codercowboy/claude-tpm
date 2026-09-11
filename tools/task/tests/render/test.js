#!/usr/bin/env node
/**
 * tests/render/test.js — unit suite for lib/render.js (age ladder G2, sort orders, selector grammar G5).
 *
 * WHAT IT GUARDS
 *   - The G2 age ladder at EVERY Q3 boundary (today / Xh / Xd 1-13 / Xw 14-69 / Xmo >=70), incl.
 *     the cross-midnight "Xh ago" case (D>=1 but <24h elapsed).
 *   - --order aliases + all four sort orders (newest / oldest / id / state).
 *   - The §5 selector grammar: all, single, comma-list, range, DESCENDING-range error,
 *     sparse-range skip, empty-range warn, unparseable error, --since window filter.
 *
 * HOW TO RUN
 *   node tests/render/test.js
 */

'use strict';

const { makeChecker, TOOLS } = require('../lib/harness');
const render = require(TOOLS.render);

const { ok, eq, count } = makeChecker();

// ── ladder(D, H) — pure boundary function (Q3 cutoffs) ───────────────────────────
eq('ladder D=0 -> today', render.ladder(0, 0), 'today');
eq('ladder D=0 with hours -> today (same calendar day wins)', render.ladder(0, 10), 'today');
eq('ladder cross-midnight D=1 H=2 -> "2h ago"', render.ladder(1, 2), '2h ago');
eq('ladder H=23 (<24) -> "23h ago"', render.ladder(1, 23), '23h ago');
eq('ladder days=1 (H=24) -> "1d ago"', render.ladder(1, 24), '1d ago');
eq('ladder days=13 -> "13d ago" (top of day band)', render.ladder(13, 13 * 24), '13d ago');
eq('ladder days=14 -> "2w ago" (bottom of week band)', render.ladder(14, 14 * 24), '2w ago');
eq('ladder days=69 -> "9w ago" (top of week band)', render.ladder(69, 69 * 24), '9w ago');
eq('ladder days=70 -> "2mo ago" (bottom of month band)', render.ladder(70, 70 * 24), '2mo ago');
eq('ladder days=365 -> "12mo ago"', render.ladder(365, 365 * 24), '12mo ago');

// ── ageString cross-midnight via real Dates (the documented case) ────────────────
// created yesterday 23:00, now today 01:00 => calendar D=1 but elapsed 2h => "2h ago".
const now = new Date(2026, 7, 30, 1, 0, 0); // Aug 30 2026 01:00 local
const crossMidnight = new Date(2026, 7, 29, 23, 0, 0); // Aug 29 2026 23:00 local
eq('ageString cross-midnight -> "2h ago"', render.ageString(crossMidnight, now, 'local'), '2h ago');

// ── ageForCreated (date-only stored value) day/week/month bands ──────────────────
const nowNoon = new Date(2026, 7, 30, 12, 0, 0); // Aug 30 2026 noon local
eq('ageForCreated same day -> today', render.ageForCreated('2026-08-30', nowNoon, 'local'), 'today');
eq('ageForCreated 3 days ago -> "3d ago"', render.ageForCreated('2026-08-27', nowNoon, 'local'), '3d ago');
eq('ageForCreated 20 days ago -> "2w ago"', render.ageForCreated('2026-08-10', nowNoon, 'local'), '2w ago');
eq('ageForCreated ~3 months ago -> "3mo ago"', render.ageForCreated('2026-05-25', nowNoon, 'local'), '3mo ago');
eq('ageForCreated empty -> ""', render.ageForCreated('', nowNoon, 'local'), '');

// ── order aliases ────────────────────────────────────────────────────────────────
eq('normalizeOrder default -> newest', render.normalizeOrder(undefined), 'newest');
eq('normalizeOrder "stale" -> oldest', render.normalizeOrder('stale'), 'oldest');
eq('normalizeOrder "seq" -> id', render.normalizeOrder('seq'), 'id');
eq('normalizeOrder "grouped" -> state', render.normalizeOrder('grouped'), 'state');
eq('normalizeOrder unknown -> newest', render.normalizeOrder('zzz'), 'newest');

// ── sortRows all four orders ─────────────────────────────────────────────────────
const rows = [
  { num: 1001, state: 'open', created: '2026-01-01' },
  { num: 1002, state: 'in-progress', created: '2026-03-01' },
  { num: 1003, state: 'finished', created: '2026-02-01' },
];
eq('sort newest -> by created desc', render.sortRows(rows, 'newest').map((r) => r.num), [1002, 1003, 1001]);
eq('sort oldest -> by created asc', render.sortRows(rows, 'oldest').map((r) => r.num), [1001, 1003, 1002]);
eq('sort id -> by num asc', render.sortRows(rows, 'id').map((r) => r.num), [1001, 1002, 1003]);
eq('sort state -> in-progress first', render.sortRows(rows, 'state').map((r) => r.num), [1002, 1001, 1003]);

// ── selector grammar (§5 / G5) ───────────────────────────────────────────────────
const pool = [1001, 1002, 1004, 1005].map((n) => ({ num: n, created: '2026-01-01' }));
const R = (sel, ctx) => render.resolveSelector(sel, { rows: pool, ...(ctx || {}) });

eq('selector all -> every id sorted', R('all').ids, [1001, 1002, 1004, 1005]);
eq('selector single', R('1002').ids, [1002]);
eq('selector "#1002" hash-normalized', R('#1002').ids, [1002]);
eq('selector comma-list', R('1005,1001,1002').ids, [1001, 1002, 1005]);
eq('selector range 1001-1005 (sparse: 1003 missing -> skipped)', R('1001-1005').ids, [1001, 1002, 1004, 1005]);
ok('selector DESCENDING range is an ERROR', R('1005-1001').error !== null && /descending/i.test(R('1005-1001').error));
ok('selector descending range yields NO ids', R('1005-1001').ids.length === 0);
ok('selector empty-matching range WARNS not errors', (() => {
  const r = R('2000-2005');
  return r.error === null && r.warnings.length > 0 && r.ids.length === 0;
})());
ok('selector unknown id in comma-list warns + skips', (() => {
  const r = R('1002,9999');
  return r.error === null && r.ids.join(',') === '1002' && r.warnings.some((w) => /9999/.test(w));
})());
ok('selector unparseable -> error', R('gibberish!!').error !== null);
ok('selector empty -> error', R('').error !== null);

// --since window filter
const sinceRows = [
  { num: 1, created: '2026-08-01' },
  { num: 2, created: '2026-08-29' },
];
const sinceRes = render.resolveSelector('all', {
  rows: sinceRows,
  sinceOk: (row) => row.created >= '2026-08-15',
});
eq('selector --since filters out older rows', sinceRes.ids, [2]);

process.stdout.write(`\nPASS — ${count()}/${count()} lib/render.js assertions green\n`);
