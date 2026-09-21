'use strict';
/**
 * timestamp.js — local-offset ISO-8601 stamps (kind-agnostic).
 *
 * LOCKED convention (json-format-spec "Timestamps"): every canonical timestamp is
 * ISO-8601 WITH an explicit local offset (e.g. 2026-09-19T08:05:00-07:00) — NEVER a
 * bare or UTC-`Z` form. Re-authored in the sandbox from the reference at
 * node_modules/@codercowboy/claude-tpm/tools/session/tpm-session-format.js:141 (copy-
 * portability — do NOT require across suites).
 *
 * Zero third-party deps; Node built-ins only.
 */

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * nowIsoTz(date = new Date()) -> string
 *
 * ISO-8601 with the LOCAL offset. `Date.prototype.toISOString()` is ALWAYS UTC `Z`, so
 * this is hand-built from local components; the offset comes from getTimezoneOffset()
 * with its sign FLIPPED (getTimezoneOffset() returns minutes BEHIND UTC: 420 for UTC-7
 * -> "-07:00"; 0 -> "+00:00", never "-00:00"; handles sub-hour offsets like "+05:30").
 * Callers assert the SHAPE (/[+-]\d{2}:\d{2}$/), never a literal offset (CI may be UTC).
 */
function nowIsoTz(date = new Date()) {
  const y = date.getFullYear();
  const mo = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  const h = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  const s = pad2(date.getSeconds());
  const offsetMin = -date.getTimezoneOffset(); // flip: 420 (behind UTC) -> -420 -> "-07:00"
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/**
 * shortDateTime(isoTz) -> string  ("YYYY-MM-DD HH:MM")
 *
 * The human render's short form (export-spec §Log). Derived purely from the STRING so
 * the local wall-clock time the stamp captured is preserved verbatim — it is NOT
 * re-parsed through Date (which would re-project into the runtime's zone).
 */
function shortDateTime(isoTz) {
  if (typeof isoTz !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(isoTz)) {
    throw new Error(`shortDateTime: expected an ISO-8601 date-time string, got '${isoTz}'`);
  }
  return `${isoTz.slice(0, 10)} ${isoTz.slice(11, 16)}`;
}

module.exports = { nowIsoTz, shortDateTime, pad2 };
