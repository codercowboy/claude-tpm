#!/usr/bin/env node
/**
 * tpm-session-review.js — the session READ API (task B2), reworked for the THREE-FILE model.
 *
 * PURPOSE
 *   Extracts the tokened sections of the last N sessions cheaply (grep-shaped, without loading
 *   every note into context) — powers the recurring "look back over the last N sessions: what open
 *   items did we never get back to?" query. Shares tpm-session-format.js's token SSOT with the write
 *   tools so read/write cannot drift.
 *
 * THREE-FILE REWORK + v1.0 GATE (2026-09-17, §13.6)
 *   A session folder holds three session-number-prefixed files, and this tool sources each concern
 *   from its home file:
 *     • Where/Next (the old RESUME overview) ← `session-NNNN-handoff.md` (via `parseHandoff`).
 *     • Open work items                       ← `session-NNNN-punchlist.md` (via `parsePunchlist`/`openItems`).
 *     • Decisions + Log                        ← `session-NNNN-log.md` (via `parseNote`).
 *   Only v1.0 sessions are read (`sessionIsV1` gate on the `tpm-session-version: 1.0` preamble);
 *   pre-v1.0 / unprefixed / unmarked folders are IGNORED (no legacy-parse branch, no back-compat) —
 *   a window with zero v1.0 sessions prints "No sessions found." When a v1.0 session has no handoff
 *   yet (notes written before the first save), the overview FALLS BACK to the ledger (Decisions +
 *   latest Log line).
 *
 * CLI
 *   --sessions-dir <dir>   REQUIRED.
 *   --last N               REQUIRED. How many of the highest-numbered sessions to include.
 *   --open-items           Show only the open punchlist items per included session.
 *   --decisions            Show only the Decisions section per included session.
 *   --since <YYYY-MM-DD>   Restrict to sessions whose note-title (or handoff) date is >= this date. A
 *                          session with no machine-parseable date is always included (unfilterable).
 *   --grep <term>          Case-insensitive substring filter across handoff Where/Next/In-flight,
 *                          open punchlist item text, Decisions, and Log text; prints only matches.
 *   --json                 Emit the selected, filtered data as JSON instead of prose.
 *   --help
 *
 * With no filter flags, prints a one-block-per-session overview (title + handoff Where/Next, or a
 * notes-ledger fallback when a v1.0 session has no handoff yet). Filters combine.
 *
 * EXAMPLES
 *   npx tpm session review --sessions-dir .claude/claude-tpm/sessions --last 5
 *   npx tpm session review --sessions-dir .claude/claude-tpm/sessions --last 10 --open-items
 *   npx tpm session review --sessions-dir .claude/claude-tpm/sessions --last 20 --grep "sessionId"
 *   npx tpm session review --sessions-dir .claude/claude-tpm/sessions --last 5 --json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parseNote, parseHandoff, parsePunchlist, openItems, readsAsV1 } = require('./tpm-session-format');

const NUMBER_RE = /^session-(\d{3,4})$/;

function listSessionNumbers(sessionsDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const numbers = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = NUMBER_RE.exec(e.name);
    if (m) numbers.push(m[1]);
  }
  return numbers.sort().reverse(); // descending, highest (most recent) first
}

function resolveNoteFile(sessionsDir, number) {
  const p = path.join(sessionsDir, `session-${number}`, `session-${number}-log.md`);
  return fs.existsSync(p) ? p : null;
}

/**
 * The v1.0 reader gate (§13.6): a session is VISIBLE iff any of its three prefixed files carries the
 * `tpm-session-version: 1.0` preamble. A pre-v1.0 / unmarked / unprefixed folder returns false and is
 * IGNORED by `collect` — no legacy-parse branch, no back-compat.
 */
function sessionIsV1(sessionsDir, number) {
  const folder = path.join(sessionsDir, `session-${number}`);
  return readsAsV1(path.join(folder, `session-${number}-handoff.md`))
    || readsAsV1(path.join(folder, `session-${number}-log.md`))
    || readsAsV1(path.join(folder, `session-${number}-punchlist.md`));
}

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return null;
  }
}

/**
 * Load one session across all three prefixed files (callers pre-filter to v1.0 via `sessionIsV1`):
 *   { number, filePath (log), handoffPath, punchlistPath, parsed (note),
 *     handoff|null, open:[...open punchlist items] }
 * A v1.0 session may have a log but no handoff yet (notes written before the first save) — the
 * overview falls back to the ledger in that case.
 */
function loadSession(sessionsDir, number) {
  const folder = path.join(sessionsDir, `session-${number}`);
  const notePath = resolveNoteFile(sessionsDir, number);
  const handoffPath = path.join(folder, `session-${number}-handoff.md`);
  const punchlistPath = path.join(folder, `session-${number}-punchlist.md`);

  const parsed = notePath ? parseNote(readIfExists(notePath) || '') : null;
  const handoffRaw = fs.existsSync(handoffPath) ? readIfExists(handoffPath) : null;
  const handoff = handoffRaw ? parseHandoff(handoffRaw) : null;
  const punchRaw = fs.existsSync(punchlistPath) ? readIfExists(punchlistPath) : null;
  const open = punchRaw ? openItems(parsePunchlist(punchRaw)) : [];

  return { number, filePath: notePath, handoffPath, punchlistPath, parsed, handoff, open };
}

function withinSince(session, since) {
  if (!since) return true;
  const date = (session.parsed && session.parsed.date) || (session.handoff && session.handoff.date) || null;
  if (!date) return true; // unfilterable -> included
  return date >= since;
}

function matchesGrep(text, term) {
  return typeof text === 'string' && text.toLowerCase().includes(term.toLowerCase());
}

function grepFilterSession(session, term) {
  const h = session.handoff;
  const p = session.parsed || { decisions: [], log: [] };
  const hitHandoff = Boolean(h) && (matchesGrep(h.where, term) || matchesGrep(h.next, term) || matchesGrep(h.inFlight, term));
  const open = session.open.filter((it) => matchesGrep(it.text, term));
  const decisions = (p.decisions || []).filter((d) => matchesGrep(d.what, term) || matchesGrep(d.why, term));
  const log = (p.log || []).filter((e) => matchesGrep(e.text, term));
  if (!hitHandoff && open.length === 0 && decisions.length === 0 && log.length === 0) return null;
  return {
    ...session,
    open,
    handoff: hitHandoff ? h : null,
    parsed: { ...p, decisions, log },
  };
}

function collect({ sessionsDir, last, since, grepTerm }) {
  // v1.0 gate FIRST (pre-v1.0 sessions are invisible), THEN take the last N of what remains.
  const numbers = listSessionNumbers(sessionsDir)
    .filter((n) => sessionIsV1(sessionsDir, n))
    .slice(0, last);
  let sessions = numbers.map((n) => loadSession(sessionsDir, n));
  sessions = sessions.filter((s) => withinSince(s, since));
  if (grepTerm) {
    sessions = sessions.map((s) => grepFilterSession(s, grepTerm)).filter(Boolean);
  }
  return sessions;
}

function renderOverview(sessions) {
  const lines = [];
  for (const s of sessions) {
    const p = s.parsed || {};
    const date = (p.date) || (s.handoff && s.handoff.date) || '?';
    lines.push(`session-${s.number} — ${date} — ${p.theme || '(untitled)'}${p.sealedAt ? ` [SEALED ${p.sealedAt}]` : ''}`);
    if (s.handoff && (s.handoff.where || s.handoff.next)) {
      if (s.handoff.where) lines.push(`  Where: ${s.handoff.where}`);
      if (s.handoff.next) lines.push(`  Next:  ${s.handoff.next}`);
    } else {
      // Fall back to the notes ledger (Decisions + latest Log line) when there is no handoff.
      const lastDecision = (p.decisions || []).slice(-1)[0];
      const lastLog = (p.log || []).slice(-1)[0];
      if (lastDecision) lines.push(`  Decided: ${lastDecision.what} — ${lastDecision.why}`);
      if (lastLog) lines.push(`  Log:   [${lastLog.status}] ${lastLog.text}`);
      if (!lastDecision && !lastLog) lines.push('  (no handoff, no ledger entries yet)');
    }
  }
  return lines.join('\n');
}

function renderOpenItems(sessions) {
  const lines = [];
  for (const s of sessions) {
    for (const it of s.open) {
      lines.push(`session-${s.number} — #${it.id} · ${it.text}  [${it.slug}, ${it.created}]`);
    }
  }
  return lines.length ? lines.join('\n') : 'No open items found in the selected sessions.';
}

function renderDecisions(sessions) {
  const lines = [];
  for (const s of sessions) {
    if (!s.parsed) continue;
    for (const d of s.parsed.decisions || []) {
      lines.push(`session-${s.number} — Decided: ${d.what} — ${d.why}`);
    }
  }
  return lines.length ? lines.join('\n') : 'No decisions found in the selected sessions.';
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: npx tpm session review --sessions-dir <dir> --last N [--open-items|--decisions] [--since <date>] [--grep <term>] [--json] [--help]',
      '',
      'See the header docstring in this file for full flag behaviour.',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--sessions-dir') args.sessionsDir = argv[++i];
    else if (a === '--last') args.last = parseInt(argv[++i], 10);
    else if (a === '--open-items') args.openItems = true;
    else if (a === '--decisions') args.decisions = true;
    else if (a === '--since') args.since = argv[++i];
    else if (a === '--grep') args.grep = argv[++i];
    else if (a === '--json') args.json = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.sessionsDir || !args.last || Number.isNaN(args.last)) {
    process.stderr.write('tpm-session-review.js: --sessions-dir and --last <N> are required.\n\n');
    printHelp();
    process.exit(1);
  }

  const sessions = collect({ sessionsDir: args.sessionsDir, last: args.last, since: args.since, grepTerm: args.grep });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
    process.exit(0);
  }

  if (args.openItems) {
    process.stdout.write(`${renderOpenItems(sessions)}\n`);
  } else if (args.decisions) {
    process.stdout.write(`${renderDecisions(sessions)}\n`);
  } else {
    process.stdout.write(`${renderOverview(sessions) || 'No sessions found.'}\n`);
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { listSessionNumbers, resolveNoteFile, sessionIsV1, loadSession, collect, renderOverview, renderOpenItems, renderDecisions };
