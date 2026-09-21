#!/usr/bin/env node
/**
 * tpm-session-notes.js — the session-notes LEDGER write API (spec §3, §12.5).
 *
 * PURPOSE
 *   The orchestrator supplies CONTENT (judgment); this tool owns FORMAT + PLACEMENT +
 *   DISCIPLINE. It writes the CURRENT session's `session-NNNN-log.md` (resolved via
 *   tpm-session-current.js — never a stale/other session), which under the three-file redesign
 *   is a pure APPEND-ONLY LEDGER: `## Decisions` + `## Log`. RESUME now lives in
 *   `session-NNNN-handoff.md` (written by `tpm-session-save.js`); open work items now live in
 *   `session-NNNN-punchlist.md` (written by `tpm-session-punchlist.js`) — so the `resume` and `open`
 *   verbs are GONE from this tool.
 *
 * VERBS
 *   init [--theme "<text>"] [--date <YYYY-MM-DD>]
 *       Create the current session's session-NNNN-log.md skeleton if it doesn't exist yet.
 *       Idempotent — a no-op (prints a notice) if the file already exists. Any other write
 *       verb auto-inits lazily with theme "(untitled)" if you skip this, so calling it
 *       explicitly is a convenience for setting the theme up front, not a hard prerequisite.
 *
 *   log --status <TAG> "<text>"
 *       APPENDS one entry to ## Log: `- [<TAG>] <text>  [<ISO-8601-TZ>]` (timestamp TRAILING).
 *       <TAG> is free text (no enforced enum — the convention set DONE/WIP/BLOCKED/HELD/PARKED/
 *       DROPPED is a convention, not a hard validator).
 *
 *   decide "<what>" --why "<why>"
 *       APPENDS one entry to ## Decisions: `- **Decided:** <what> — <why>  [<ISO-8601-TZ>]`
 *       (the trailing timestamp mirrors the Log line, for symmetry / future time-bounded search).
 *
 *   seal
 *       Stamps `SEALED <date>` at the end of the note AND marks the current-session pointer
 *       closed (tpm-session-current.js sealSession) so the next bare `tpm-session` invocation
 *       opens fresh rather than reusing this session.
 *
 * IMMUTABILITY GUARD
 *   Every verb above operates ONLY on the CURRENT open session (per
 *   tpm-session-current.js#resolveCurrentSession). If no session is open, every verb errors with
 *   a clear message telling the caller to run `tpm-session open` first.
 *
 *   To edit a SEALED (past) session, pass `--edit-sealed <NNNN> --confirm` on any verb. Without
 *   BOTH flags together, editing a non-current session is refused outright — there is no
 *   casual path to it. `--edit-sealed` targets that session's `session-NNNN-log.md` and enforces the
 *   append-only discipline. No back-compat: only a v1.0 (four-digit, prefixed) session can be an
 *   edit-sealed target; a non-canonical note is refused (the tool never auto-rewrites prose).
 *
 * NOTE ON init-vs-current
 *   `log`/`decide` require an OPEN session (see IMMUTABILITY GUARD) — this tool never silently
 *   allocates a new session-NNN itself; that is `tpm-session-current.js#openSession`'s job,
 *   invoked by the `tpm-session open` skill mode. If a write verb is called with a session
 *   already open but no session-NNNN-log.md written yet for it, the tool DOES lazily create the
 *   skeleton file (not a new session number) so the first `log` call after `open` doesn't
 *   require a separate `init` step.
 *
 * CLI
 *   --sessions-dir <dir>   REQUIRED on every invocation (resolve via tpm-session-config.js --sessions-dir).
 *   --edit-sealed <NNNN> --confirm  Override the current-session-only guard (see above).
 *   --help
 *
 * EXAMPLES
 *   npx tpm session notes --sessions-dir .claude/claude-tpm/sessions init --theme "session tools redesign"
 *   npx tpm session notes --sessions-dir .claude/claude-tpm/sessions log --status WIP "wrote tpm-session-save.js"
 *   npx tpm session notes --sessions-dir .claude/claude-tpm/sessions decide "JSON file payload, not stdin" --why "portable, greppable, no shell-quoting traps"
 *   npx tpm session notes --sessions-dir .claude/claude-tpm/sessions seal
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveCurrentSession, sealSession } = require('./tpm-session-current');
const { parseNote, renderNote, buildTitle, nowIsoTz, todayISODate } = require('./tpm-session-format');

/**
 * The current (or given) session's ledger file: `session-NNNN-log.md`. ONE path — no back-compat, no
 * legacy `notes.md` fallback (§13.6: the ledger is renamed to `log` and prefixed with the number).
 */
function noteFilePath(sessionsDir, number) {
  return path.join(sessionsDir, `session-${number}`, `session-${number}-log.md`);
}

function loadOrInitSections(filePath, number, theme, date) {
  if (fs.existsSync(filePath)) {
    const parsed = parseNote(fs.readFileSync(filePath, 'utf8'));
    if (!parsed.number) {
      const err = new Error(
        `${filePath} does not look like a canonical-format note (no "# SESSION NNN — ..." ` +
          'title found) — this tool refuses to auto-rewrite a freeform legacy note into the new structure.',
      );
      err.code = 'ENOTCANONICAL';
      throw err;
    }
    return parsed;
  }
  return {
    number,
    date: date || todayISODate(),
    theme: theme || '(untitled)',
    decisions: [],
    log: [],
    sealedAt: null,
  };
}

function writeSections(filePath, sections) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, renderNote(sections), 'utf8');
}

function resolveTargetNumber({ sessionsDir, editSealed, confirm }) {
  if (editSealed) {
    if (!confirm) {
      const err = new Error(
        `--edit-sealed ${editSealed} requires --confirm as well — refusing the casual path to a non-current session.`,
      );
      err.code = 'ECONFIRM_REQUIRED';
      throw err;
    }
    if (!/^\d{4}$/.test(editSealed)) {
      const err = new Error(
        `--edit-sealed ${editSealed}: session number must be four digits (e.g. 0007). Refusing to write to an invalid session id.`,
      );
      err.code = 'EBAD_SESSION';
      throw err;
    }
    if (!fs.existsSync(path.join(sessionsDir, `session-${editSealed}`))) {
      const err = new Error(
        `--edit-sealed ${editSealed}: no such session folder (session-${editSealed}). Refusing to fabricate a session — --edit-sealed only edits an EXISTING past session.`,
      );
      err.code = 'ENO_SESSION';
      throw err;
    }
    return { number: editSealed, isCurrent: false };
  }
  const current = resolveCurrentSession({ sessionsDir });
  if (current.state !== 'open') {
    const err = new Error(
      'no session is currently open. Run `tpm-session open` first, or pass --edit-sealed <NNN> --confirm to edit a past session.',
    );
    err.code = 'ENO_OPEN_SESSION';
    throw err;
  }
  return { number: current.number, isCurrent: true };
}

/**
 * Append ONE ledger line to the CURRENT (or given) session's `## Log`, reusing the same
 * noteFilePath → loadOrInitSections → writeSections path the `log` verb uses (so the ledger
 * format stays owned in one place). Used by tpm-session-punchlist.js to record EVERY punchlist
 * op (add/close/carry/reopen/drop) as a human-readable `- [<TAG>] <text>  [<ISO-TZ>]` line.
 *
 *   appendLogEntry({ sessionsDir, number, status, text, ts? }) -> the file path written.
 *
 * `number` is the padded session number (e.g. "0020"). Lazily creates the session-NNNN-log.md
 * skeleton if it does not exist yet (same as the `log` verb). Throws (loudly) on an I/O failure
 * or a non-canonical note — the caller re-raises so a partial two-file write is never silent.
 *
 * `ts` is OPTIONAL and defaults to `nowIsoTz()` — backward-compatible with every existing caller
 * (punchlist `logOp`, `verbLog`/`verbDecide` pass none). The #1095 `--log` sentinel passes a composite
 * `"<note-slug>, <ISO-TZ>"` so the PLNOTE line renders as `- [PLNOTE] <full>  [<note-slug>, <ISO-TZ>]`
 * (the trailing `[...]` LOG_ENTRY_RE capture carries the note-slug + timestamp — no regex change).
 */
function appendLogEntry({ sessionsDir, number, status, text, ts }) {
  if (!status || typeof text !== 'string') {
    throw Object.assign(new Error('appendLogEntry requires a status and a text string.'), { code: 'EARGS' });
  }
  const filePath = noteFilePath(sessionsDir, number);
  const sections = loadOrInitSections(filePath, number);
  sections.log.push({ status, text, ts: ts || nowIsoTz() });
  writeSections(filePath, sections);
  return filePath;
}

// ---- verb handlers ---------------------------------------------------------

function verbInit(args, ctx) {
  const filePath = noteFilePath(ctx.sessionsDir, ctx.number);
  if (fs.existsSync(filePath)) {
    process.stdout.write(`session-notes: ${filePath} already exists — nothing to init.\n`);
    return;
  }
  const sections = loadOrInitSections(filePath, ctx.number, args.theme, args.date);
  writeSections(filePath, sections);
  process.stdout.write(`session-notes: created ${filePath}\n`);
}

function verbLog(args, ctx) {
  const filePath = noteFilePath(ctx.sessionsDir, ctx.number);
  const sections = loadOrInitSections(filePath, ctx.number, args.theme, args.date);
  if (!args.status || !args.text) {
    throw Object.assign(new Error('log requires --status and a text argument.'), { code: 'EARGS' });
  }
  sections.log.push({ status: args.status, text: args.text, ts: nowIsoTz() });
  writeSections(filePath, sections);
  process.stdout.write(`session-notes: appended [${args.status}] log entry in ${filePath}\n`);
}

function verbDecide(args, ctx) {
  const filePath = noteFilePath(ctx.sessionsDir, ctx.number);
  const sections = loadOrInitSections(filePath, ctx.number, args.theme, args.date);
  if (!args.text || !args.why) {
    throw Object.assign(new Error('decide requires a text argument and --why.'), { code: 'EARGS' });
  }
  sections.decisions.push({ what: args.text, why: args.why, ts: nowIsoTz() });
  writeSections(filePath, sections);
  process.stdout.write(`session-notes: appended decision in ${filePath}\n`);
}

function verbSeal(args, ctx) {
  const filePath = noteFilePath(ctx.sessionsDir, ctx.number);
  const sections = loadOrInitSections(filePath, ctx.number, args.theme, args.date);
  const date = todayISODate();
  sections.sealedAt = date;
  writeSections(filePath, sections);
  if (ctx.isCurrent) {
    sealSession({ sessionsDir: ctx.sessionsDir });
  }
  process.stdout.write(`session-notes: sealed ${filePath} (${date})\n`);
}

// ---- CLI plumbing -----------------------------------------------------------

function printHelp() {
  process.stdout.write(
    [
      'Usage: npx tpm session notes --sessions-dir <dir> [--edit-sealed <NNNN> --confirm] <verb> [args]',
      '',
      'Verbs:',
      '  init [--theme "<text>"] [--date <YYYY-MM-DD>]',
      '  log --status <TAG> "<text>"',
      '  decide "<what>" --why "<why>"',
      '  seal',
      '',
      'Prior-state pickup now lives in handoff.md (tpm session save); work items live in',
      'punchlist.md (tpm session punchlist).',
      '',
      'See the header docstring in this file for the full behaviour + immutability guard.',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; }
    else if (a === '--sessions-dir') { args.sessionsDir = argv[++i]; }
    else if (a === '--edit-sealed') { args.editSealed = argv[++i]; }
    else if (a === '--confirm') { args.confirm = true; }
    else if (a === '--status') { args.status = argv[++i]; }
    else if (a === '--why') { args.why = argv[++i]; }
    else if (a === '--theme') { args.theme = argv[++i]; }
    else if (a === '--date') { args.date = argv[++i]; }
    else { args._.push(a); }
  }
  return args;
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.help || argv.length === 0) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  if (!args.sessionsDir) {
    process.stderr.write('tpm-session-notes.js: --sessions-dir is required.\n\n');
    printHelp();
    process.exit(1);
  }

  const verb = args._[0];
  if (!verb) {
    process.stderr.write('tpm-session-notes.js: a verb is required (init|log|decide|seal).\n\n');
    printHelp();
    process.exit(1);
  }

  args.text = args._.slice(1).join(' ');

  try {
    const target = resolveTargetNumber({ sessionsDir: args.sessionsDir, editSealed: args.editSealed, confirm: args.confirm });
    const ctx = { sessionsDir: args.sessionsDir, number: target.number, isCurrent: target.isCurrent };

    switch (verb) {
      case 'init': verbInit(args, ctx); break;
      case 'log': verbLog(args, ctx); break;
      case 'decide': verbDecide(args, ctx); break;
      case 'seal': verbSeal(args, ctx); break;
      default:
        process.stderr.write(`tpm-session-notes.js: unknown verb "${verb}".\n\n`);
        printHelp();
        process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`session-notes: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { noteFilePath, loadOrInitSections, writeSections, resolveTargetNumber, buildTitle, appendLogEntry };
