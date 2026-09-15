#!/usr/bin/env node
/**
 * tpm-session-review.js — the session-notes READ API (task B2).
 *
 * PURPOSE
 *   Extracts the tokened sections of the last N session-notes cheaply (grep-shaped, without
 *   loading every note into context) — powers the recurring "look back over the last N
 *   sessions: what open items did we never get back to?" query
 *   (session-notes-design.md §"The recurring query"). Shares tpm-session-format.js's token SSOT with
 *   tpm-session-notes.js (write side) so read/write cannot drift.
 *
 * LEGACY NOTES (session-001..007, pre-dating this tool)
 *   Those are freeform prose (`notes.md`, no `# SESSION NNN — ...` title, no canonical
 *   headings — see session-notes-spec.md §3.3). This tool detects that case (parseNote
 *   returns no `number`) and reports the session as "(legacy format — not token-parseable)"
 *   rather than silently omitting it or crashing; the file path is still surfaced so a human
 *   can open it directly.
 *
 * CLI
 *   --sessions-dir <dir>   REQUIRED.
 *   --last N               REQUIRED. How many of the highest-numbered sessions to include.
 *   --open-items            Show only the Open items section per included session.
 *   --decisions              Show only the Decisions section per included session.
 *   --since <YYYY-MM-DD>      Restrict to sessions whose title date is >= this date (canonical
 *                             notes only — a legacy note's date is not machine-parsed, so it is
 *                             always included when --since is given, flagged as unfiltered).
 *   --grep <term>             Case-insensitive substring filter across Resume/Open
 *                             items/Decisions/Log text; prints only matching lines.
 *   --json                    Emit the selected, filtered data as JSON instead of prose.
 *   --help
 *
 * With no filter flags, prints a one-block-per-session overview (title + RESUME summary, or
 * the legacy notice). Filters combine — e.g. --open-items --grep foo shows only open items
 * containing "foo".
 *
 * EXAMPLES
 *   npx tpm session review --sessions-dir claude-context/sessions --last 5
 *   npx tpm session review --sessions-dir claude-context/sessions --last 10 --open-items
 *   npx tpm session review --sessions-dir claude-context/sessions --last 20 --grep "sessionId"
 *   npx tpm session review --sessions-dir claude-context/sessions --last 5 --json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parseNote } = require('./tpm-session-format');

const NUMBER_RE = /^session-(\d{3})$/;

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
  const folder = path.join(sessionsDir, `session-${number}`);
  const modern = path.join(folder, 'session-notes.md');
  const legacy = path.join(folder, 'notes.md');
  if (fs.existsSync(modern)) return modern;
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

function loadSession(sessionsDir, number) {
  const filePath = resolveNoteFile(sessionsDir, number);
  if (!filePath) return { number, filePath: null, legacy: true, parsed: null };
  const parsed = parseNote(fs.readFileSync(filePath, 'utf8'));
  return { number, filePath, legacy: !parsed.number, parsed };
}

function withinSince(session, since) {
  if (!since) return true;
  if (session.legacy || !session.parsed || !session.parsed.date) return true; // unfilterable -> included
  return session.parsed.date >= since;
}

function matchesGrep(text, term) {
  return typeof text === 'string' && text.toLowerCase().includes(term.toLowerCase());
}

function grepFilterSession(session, term) {
  if (session.legacy || !session.parsed) {
    return matchesGrep(session.filePath || '', term) ? session : null;
  }
  const p = session.parsed;
  const hitResume = matchesGrep(p.resume.whereWeAre, term) || matchesGrep(p.resume.nextAction, term) || matchesGrep(p.resume.inFlight, term);
  const openItems = p.openItems.filter((it) => matchesGrep(it.text, term));
  const decisions = p.decisions.filter((d) => matchesGrep(d.what, term) || matchesGrep(d.why, term));
  const log = p.log.filter((e) => matchesGrep(e.text, term));
  if (!hitResume && openItems.length === 0 && decisions.length === 0 && log.length === 0) return null;
  return {
    ...session,
    parsed: { ...p, openItems, decisions, log, resume: hitResume ? p.resume : { whereWeAre: '', nextAction: '', inFlight: '' } },
  };
}

function collect({ sessionsDir, last, since, grepTerm }) {
  const numbers = listSessionNumbers(sessionsDir).slice(0, last);
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
    if (s.legacy || !s.parsed) {
      lines.push(`session-${s.number} — (legacy format — not token-parseable)${s.filePath ? ` — ${s.filePath}` : ' — no notes file found'}`);
      continue;
    }
    const p = s.parsed;
    lines.push(`session-${s.number} — ${p.date || '?'} — ${p.theme || '(untitled)'}${p.sealedAt ? ` [SEALED ${p.sealedAt}]` : ''}`);
    if (p.resume.whereWeAre) lines.push(`  Where: ${p.resume.whereWeAre}`);
    if (p.resume.nextAction) lines.push(`  Next:  ${p.resume.nextAction}`);
  }
  return lines.join('\n');
}

function renderOpenItems(sessions) {
  const lines = [];
  for (const s of sessions) {
    if (s.legacy || !s.parsed) continue;
    for (const it of s.parsed.openItems) {
      lines.push(`session-${s.number} — [${it.done ? 'x' : ' '}] OPEN(${it.owner}) #${it.id}: ${it.text}`);
    }
  }
  return lines.length ? lines.join('\n') : 'No open items found in the selected sessions.';
}

function renderDecisions(sessions) {
  const lines = [];
  for (const s of sessions) {
    if (s.legacy || !s.parsed) continue;
    for (const d of s.parsed.decisions) {
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

module.exports = { listSessionNumbers, resolveNoteFile, loadSession, collect, renderOverview, renderOpenItems, renderDecisions };
