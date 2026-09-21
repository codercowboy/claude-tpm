#!/usr/bin/env node
/**
 * tpm-session-save.js — the GATED, LINTED session checkpoint (spec §6, §12.2).
 *
 * PURPOSE
 *   The one write path that rewrites `session-NNNN-handoff.md` (the pickup doc) and refreshes the
 *   shared wayfinding header on all three session files. It is DELIBERATELY gated: the orchestrator
 *   supplies a small flat JSON payload (where / next / in_flight? / must_not_redo?) and the tool
 *   LINTS it before touching disk — a typo or a missing field is refused with the offending field
 *   named, and NOTHING is written on a refusal.
 *
 *   `save` owns FORMAT + PLACEMENT (per spec §6: the tool owns all markdown). It imports the SSOT
 *   `tpm-session-format.js` for every token — it never hand-authors handoff/punchlist/notes markup.
 *
 * PAYLOAD (--payload <file.json>, a FILE PATH only — no stdin), a flat object (§12.2):
 *   { "where": "…",            // REQUIRED, non-empty-after-trim
 *     "next":  "…",            // REQUIRED, non-empty-after-trim
 *     "in_flight": "…",        // optional → string OR list of strings (default "Nothing in flight.")
 *     "must_not_redo": ["…"] } // optional → string OR list of strings; section omitted if absent
 *   Any UNKNOWN top-level key is a typo guard → REFUSE.
 *
 * WHAT A SUCCESSFUL SAVE DOES (one pass, after lint passes)
 *   1. Rewrites `session-NNNN-handoff.md` wholesale: head = where/next/in_flight/must_not_redo; the
 *      "## What remains" section is pulled MECHANICALLY from the CURRENT `session-NNNN-punchlist.md`
 *      Open items (via format.js `openItems(parsePunchlist(...))`) — never hand-typed.
 *   2. Refreshes the wayfinding header on all three files (handoff/punchlist/log). The refresh is
 *      SURGICAL on the append-only ledger (`refreshWayfindingHeader` replaces only the anchored
 *      header block; the Log/Decisions body stays byte-stable).
 *   3. CREATES `session-NNNN-handoff.md` / `-punchlist.md` / `-log.md` if absent (first save of a
 *      session) — a freshly-created punchlist/log file is a header + empty sections, so any file
 *      a human opens reveals the other two (the wayfinding invariant).
 *   4. NUDGE: echoes still-open punchlist ids (`still open: #20.1 #20.3`). If the punchlist has 0
 *      open items, prints a `⚠ … intended?` advisory (still exit 0).
 *
 * EXIT CODES (§12.2)
 *   0  ok (possibly with warnings)
 *   1  refused — a lint failure (missing/blank where|next, in_flight/must_not_redo a wrong type, unknown
 *      key) OR no session open. Writes NOTHING, names the field.
 *   2  usage / parse error — bad flag, missing --sessions-dir/--payload, unreadable or invalid JSON.
 *
 * CLI
 *   npx tpm session save --sessions-dir <dir> --payload <file.json>
 *   npx tpm session save --help
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveCurrentSession } = require('./tpm-session-current');
const {
  renderHandoff,
  renderPunchlist,
  renderNote,
  parsePunchlist,
  openItems,
  refreshWayfindingHeader,
  todayISODate,
} = require('./tpm-session-format');

const ALLOWED_KEYS = ['where', 'next', 'in_flight', 'must_not_redo'];

// ---- exit helpers -----------------------------------------------------------
function usageError(msg) {
  process.stderr.write(`tpm-session-save.js: ${msg}\n`);
  process.exit(2);
}
function refuse(msg) {
  // exit 1: refused, NOTHING written.
  process.stderr.write(`save: refused — ${msg}\n`);
  process.exit(1);
}

// ---- payload lint (§12.2) ---------------------------------------------------
/** Validate the parsed payload. Throws { code:'EREFUSE', message } on any lint failure. */
function lintPayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw Object.assign(new Error('payload must be a JSON object.'), { code: 'EREFUSE' });
  }
  // Unknown-key typo guard FIRST — a stray key is almost always a mistake worth surfacing loudly.
  for (const key of Object.keys(payload)) {
    if (!ALLOWED_KEYS.includes(key)) {
      throw Object.assign(
        new Error(`unknown top-level key "${key}" (allowed: ${ALLOWED_KEYS.join(', ')}).`),
        { code: 'EREFUSE' },
      );
    }
  }
  for (const req of ['where', 'next']) {
    const v = payload[req];
    if (typeof v !== 'string' || v.trim() === '') {
      throw Object.assign(new Error(`"${req}" is required and must be a non-empty string.`), { code: 'EREFUSE' });
    }
  }
  // in_flight + must_not_redo each accept EITHER a string OR a list of strings, and are COERCED to
  // their canonical shape (in_flight → one string; must_not_redo → string[]). The shape is not a
  // meaningful gate — where/next above are — so we normalize instead of refusing, to spare the
  // orchestrator a footgun. Only a genuinely wrong type (number, mixed/non-string list) is refused.
  if (payload.in_flight !== undefined) {
    if (Array.isArray(payload.in_flight) && payload.in_flight.every((s) => typeof s === 'string')) {
      payload.in_flight = payload.in_flight.join('; ');
    } else if (typeof payload.in_flight !== 'string') {
      throw Object.assign(new Error('"in_flight" must be a string, or a list of strings, when present.'), { code: 'EREFUSE' });
    }
  }
  if (payload.must_not_redo !== undefined) {
    if (typeof payload.must_not_redo === 'string') {
      payload.must_not_redo = [payload.must_not_redo];
    } else if (!Array.isArray(payload.must_not_redo) || !payload.must_not_redo.every((s) => typeof s === 'string')) {
      throw Object.assign(new Error('"must_not_redo" must be a string, or a list of strings, when present.'), { code: 'EREFUSE' });
    }
  }
  return payload;
}

// ---- disk helpers -----------------------------------------------------------
function sessionFolder(sessionsDir, number) {
  return path.join(sessionsDir, `session-${number}`);
}

/** Refresh the header on an existing file, or CREATE it fresh with `factory()` if absent. */
function refreshOrCreate(filePath, meta, thisFile, factory) {
  if (fs.existsSync(filePath)) {
    const refreshed = refreshWayfindingHeader(fs.readFileSync(filePath, 'utf8'), {
      number: meta.number,
      date: meta.date,
      thisFile,
    });
    fs.writeFileSync(filePath, refreshed, 'utf8');
    return false; // existed
  }
  fs.writeFileSync(filePath, factory(), 'utf8');
  return true; // created
}

// ---- CLI plumbing -----------------------------------------------------------
function printHelp() {
  process.stdout.write(
    [
      'Usage: npx tpm session save --sessions-dir <dir> --payload <file.json>',
      '',
      'Gated, linted checkpoint: rewrites handoff.md + refreshes the wayfinding header on all',
      'three session files. Payload is a flat JSON object:',
      '  { "where": "…", "next": "…", "in_flight": "…"?, "must_not_redo": ["…"]? }',
      '',
      'Lint: where+next required & non-empty; in_flight/must_not_redo (if present) a string or list of strings;',
      'any unknown top-level key is refused.',
      '',
      'Exit codes: 0 ok · 1 refused (names the field, writes nothing) · 2 usage/parse error.',
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
    else if (a === '--payload') args.payload = argv[++i];
    else return { error: `unexpected argument "${a}".` };
  }
  return args;
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.help) { printHelp(); process.exit(0); }
  if (args.error) { process.stderr.write(`tpm-session-save.js: ${args.error}\n\n`); printHelp(); process.exit(2); }
  if (!args.sessionsDir) usageError('--sessions-dir is required.');
  if (!args.payload) usageError('--payload <file.json> is required.');

  // Read + parse the payload FILE (parse errors are usage/parse → exit 2).
  let raw;
  try {
    raw = fs.readFileSync(args.payload, 'utf8');
  } catch (err) {
    usageError(`could not read payload file ${args.payload}: ${err.message}`);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    usageError(`payload ${args.payload} is not valid JSON: ${err.message}`);
  }

  // Lint (lint failures → exit 1, nothing written).
  try {
    lintPayload(payload);
  } catch (err) {
    if (err.code === 'EREFUSE') refuse(err.message);
    throw err;
  }

  // Resolve the current session (no open session → refused, nothing written).
  let current;
  try {
    current = resolveCurrentSession({ sessionsDir: args.sessionsDir });
  } catch (err) {
    usageError(err.message);
  }
  if (current.state !== 'open') {
    refuse('no session is currently open — run `tpm-session open` first.');
  }

  const number = current.number;
  const date = todayISODate();
  const meta = { number, date };
  const folder = sessionFolder(args.sessionsDir, number);
  const handoffPath = path.join(folder, `session-${number}-handoff.md`);
  const punchlistPath = path.join(folder, `session-${number}-punchlist.md`);
  const notesPath = path.join(folder, `session-${number}-log.md`);

  fs.mkdirSync(folder, { recursive: true });

  // "What remains" is pulled MECHANICALLY from the CURRENT punchlist Open items (never hand-typed).
  let open = [];
  if (fs.existsSync(punchlistPath)) {
    open = openItems(parsePunchlist(fs.readFileSync(punchlistPath, 'utf8')));
  }

  // 1. Rewrite handoff.md wholesale (fresh header included via renderHandoff).
  fs.writeFileSync(handoffPath, renderHandoff(payload, open, meta), 'utf8');

  // 2. Refresh (or create) punchlist.md + session-notes.md so all three carry a fresh header.
  const punchCreated = refreshOrCreate(punchlistPath, meta, 'punchlist', () =>
    renderPunchlist({ number, date, items: [] }));
  const notesCreated = refreshOrCreate(notesPath, meta, 'log', () =>
    renderNote({ number, date, theme: '(untitled)', decisions: [], log: [] }));

  process.stdout.write(`save: wrote session-${number}-handoff.md for session ${number} (${folder})\n`);
  if (punchCreated) process.stdout.write(`save: created session-${number}-punchlist.md (first save of this session)\n`);
  if (notesCreated) process.stdout.write(`save: created session-${number}-log.md (first save of this session)\n`);

  // 3. NUDGE (§6bb): echo still-open ids, or the empty-punchlist advisory.
  if (open.length) {
    process.stdout.write(`still open: ${open.map((it) => `#${it.id}`).join(' ')}\n`);
  } else {
    process.stdout.write('⚠ punchlist has 0 open items and none were added — is that intended?\n');
  }

  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { lintPayload, ALLOWED_KEYS, sessionFolder, refreshOrCreate };
