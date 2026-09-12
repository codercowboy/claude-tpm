#!/usr/bin/env node
/**
 * lib/tpm-task-render.js — the tpm-task VIEW layer (build-plan Waves 5): age ladder, list/show
 * rendering, and the shared selector grammar (`resolve`).
 *
 * AGE LADDER (G2 — ONE pinned algorithm; the resolved decision Q3 wins over spec §4's
 * contradicting "(<1d)" annotation). In the configured timezone:
 *   D = calendar-day difference (today = 0);  H = elapsed WHOLE hours (floored).
 *     D === 0                → "today"
 *     else H < 24            → "{H}h ago"
 *     else days = floor(H/24):
 *       days <= 13           → "{days}d ago"
 *       days <= 69           → "{floor(days/7)}w ago"
 *       else                 → "{floor(days/30)}mo ago"
 *   `ageString(fromDate,nowDate,tz)` works on two Date objects (so a timestamp can land in the
 *   sub-24h "Xh ago" band on a different calendar day — the cross-midnight case). `list` calls
 *   `ageForCreated(createdYmd,...)`, which anchors a stored date-only `Created:` at midnight —
 *   so with date-only inputs the "today"/day/week/month bands are what render in practice.
 *   NOTE: for a NAMED timezone the calendar-day diff is exact; the midnight-instant used for H
 *   is a local-midnight approximation (documented in tpm-task.md). The default `timezone:"local"`
 *   is exact end-to-end.
 */

'use strict';

const fmt = require('./tpm-task-format');

function pad2(n) { return String(n).padStart(2, '0'); }

/** Format a Date as YYYY-MM-DD in the given tz ("local" or an IANA name). */
function ymdInTz(date, tz) {
  if (!tz || tz === 'local') {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
  } catch (_e) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }
}

/** A Date at local (or best-effort tz) midnight of a YYYY-MM-DD string. */
function dateAtMidnight(ymd, _tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return new Date(NaN);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function dayDiffYmd(aYmd, bYmd) {
  const a = Date.parse(`${aYmd}T00:00:00Z`);
  const b = Date.parse(`${bYmd}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

function ladder(D, H) {
  if (D <= 0) return 'today';
  if (H < 24) return `${H}h ago`;
  const days = Math.floor(H / 24);
  if (days <= 13) return `${days}d ago`;
  if (days <= 69) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/** Age between two Date objects (general form — used by boundary tests). */
function ageString(fromDate, nowDate, tz) {
  const D = dayDiffYmd(ymdInTz(fromDate, tz), ymdInTz(nowDate, tz));
  const H = Math.floor((nowDate.getTime() - fromDate.getTime()) / 3600000);
  return ladder(D, H);
}

/** Age for a stored date-only `Created:`/`Ended:` value. */
function ageForCreated(createdYmd, nowDate, tz) {
  if (!createdYmd) return '';
  const from = dateAtMidnight(createdYmd, tz);
  const D = dayDiffYmd(createdYmd.slice(0, 10), ymdInTz(nowDate, tz));
  const H = Math.floor((nowDate.getTime() - from.getTime()) / 3600000);
  return ladder(D, H);
}

// ── list rendering ────────────────────────────────────────────────────────────
const ORDER_ALIASES = {
  newest: 'newest', new: 'newest', recent: 'newest',
  oldest: 'oldest', old: 'oldest', age: 'oldest', stale: 'oldest',
  id: 'id', num: 'id', number: 'id', seq: 'id',
  state: 'state', status: 'state', grouped: 'state',
};

const STATE_RANK = { 'in-progress': 0, open: 1, finished: 2, dropped: 3, removed: 4 };

function normalizeOrder(order) {
  if (!order) return 'newest';
  return ORDER_ALIASES[String(order).toLowerCase()] || 'newest';
}

function sortRows(rows, order) {
  const o = normalizeOrder(order);
  const copy = rows.slice();
  switch (o) {
    case 'newest': copy.sort((a, b) => (b.created < a.created ? -1 : b.created > a.created ? 1 : b.num - a.num)); break;
    case 'oldest': copy.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.num - b.num)); break;
    case 'id': copy.sort((a, b) => a.num - b.num); break;
    case 'state': copy.sort((a, b) => {
      const ra = STATE_RANK[a.state] ?? 9; const rb = STATE_RANK[b.state] ?? 9;
      return ra !== rb ? ra - rb : b.num - a.num;
    }); break;
    default: break;
  }
  return copy;
}

/** One compact list line: `#1007 ▶ · 3d ago · headline  (2/5)` (progress already in row.task). */
function renderListLine(row, nowDate, tz) {
  const marker = row.state === 'in-progress' ? '▶' : ' ';
  const age = ageForCreated(row.created, nowDate, tz);
  return `#${row.num} ${marker} · ${age} · ${row.task}`;
}

function renderList(rows, { order, nowDate = new Date(), tz = 'local' } = {}) {
  const sorted = sortRows(rows, order);
  if (sorted.length === 0) return '(no tasks)';
  return sorted.map((r) => renderListLine(r, nowDate, tz)).join('\n');
}

/** show: print the whole body verbatim (trailing newline trimmed for clean concat). */
function renderShow(bodyRaw) {
  return bodyRaw.replace(/\n+$/, '');
}

// ── selector grammar (spec §5; G6 flags handled by the caller) ────────────────
/**
 * Resolve a deterministic selector against a pool of index rows.
 * @param {string} selector  all | <id> | <id>,<id> | <start>-<end>
 * @param {object} ctx
 *   ctx.rows        [{num, created, ...}]  the active --state pool
 *   ctx.sinceOk     optional fn(row) -> boolean  (the --since window filter)
 * @returns {{ ids:number[], warnings:string[], error:string|null }}
 */
function resolveSelector(selector, ctx = {}) {
  const rows = ctx.rows || [];
  const byNum = new Map(rows.map((r) => [r.num, r]));
  const sinceOk = ctx.sinceOk || (() => true);
  const warnings = [];

  const filterSince = (ids) => ids.filter((id) => {
    const row = byNum.get(id);
    return row ? sinceOk(row) : true;
  });

  const sel = String(selector || '').trim();
  if (!sel) return { ids: [], warnings, error: 'empty selector' };

  if (sel.toLowerCase() === 'all') {
    let ids = rows.map((r) => r.num);
    ids = filterSince(ids);
    if (ids.length === 0) warnings.push('selector "all" matched no tasks in this pool.');
    return { ids: [...new Set(ids)].sort((a, b) => a - b), warnings, error: null };
  }

  const rangeM = /^#?(\d+)\s*-\s*#?(\d+)$/.exec(sel);
  if (rangeM) {
    const start = parseInt(rangeM[1], 10);
    const end = parseInt(rangeM[2], 10);
    if (end < start) return { ids: [], warnings, error: `descending range not allowed: ${sel} (start must be ≤ end)` };
    const ids = [];
    for (let i = start; i <= end; i += 1) if (byNum.has(i)) ids.push(i); // sparse skip
    const filtered = filterSince(ids);
    if (filtered.length === 0) warnings.push(`range ${sel} matched no existing tasks in this pool.`);
    return { ids: filtered, warnings, error: null };
  }

  if (/^#?\d+(\s*,\s*#?\d+)*$/.test(sel)) {
    const ids = [];
    for (const part of sel.split(',')) {
      const id = parseInt(part.replace(/^#/, '').trim(), 10);
      if (!byNum.has(id)) { warnings.push(`#${id} not found in this pool — skipped.`); continue; }
      ids.push(id);
    }
    const filtered = filterSince(ids);
    return { ids: [...new Set(filtered)].sort((a, b) => a - b), warnings, error: null };
  }

  return { ids: [], warnings, error: `unparseable selector: "${sel}" (expected: all | <id> | <id>,<id>,… | <start>-<end>)` };
}

module.exports = {
  ymdInTz,
  dateAtMidnight,
  dayDiffYmd,
  ladder,
  ageString,
  ageForCreated,
  normalizeOrder,
  sortRows,
  renderListLine,
  renderList,
  renderShow,
  resolveSelector,
};
