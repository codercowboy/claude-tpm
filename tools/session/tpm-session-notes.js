#!/usr/bin/env node
/**
 * tpm-session-notes.js — the session-notes WRITE API (task B1).
 *
 * PURPOSE
 *   The orchestrator supplies CONTENT (judgment); this tool owns FORMAT + PLACEMENT +
 *   DISCIPLINE, per session-notes-design.md §"Tooling". It writes the CURRENT session's
 *   `session-notes.md` (resolved via tpm-session-current.js — never a stale/other session),
 *   enforces the two-zone rule (RESUME + Open items are rewritten IN PLACE; Log + Decisions
 *   are APPEND-ONLY), and refuses to touch a SEALED session without an explicit override.
 *
 * VERBS
 *   init [--theme "<text>"] [--date <YYYY-MM-DD>]
 *       Create the current session's session-notes.md skeleton if it doesn't exist yet.
 *       Idempotent — a no-op (prints a notice) if the file already exists. Any other write
 *       verb auto-inits lazily with theme "(untitled)" if you skip this, so calling it
 *       explicitly is a convenience for setting the theme up front, not a hard prerequisite.
 *
 *   resume --where "<text>" --next "<text>" [--in-flight "<text>"]
 *       REWRITES the ## RESUME block in place (STATE zone — always reflects NOW, never
 *       appended around). --in-flight defaults to "Nothing in flight." if omitted.
 *
 *   open add --owner <name> "<text>"
 *       Appends a new open item: `- [ ] OPEN(<owner>) #<id>: <text>`. <name> is free text
 *       (no fixed owner enum) per the resolved build answer.
 *   open done <id>
 *       Marks open item #<id> as checked ([x]). Errors if no such id exists.
 *
 *   log --status <TAG> "<text>"
 *       APPENDS one entry to ## Log: `- [<TAG>] <ISO date> — <text>`. <TAG> is free text (no
 *       enforced enum — the design's closed set DONE/WIP/BLOCKED/HELD/PARKED/DROPPED is a
 *       convention, not a hard validator, per the resolved "verbs take free text" answer).
 *
 *   decide "<what>" --why "<why>"
 *       APPENDS one entry to ## Decisions: `- **Decided:** <what> — <why>`.
 *
 *   seal
 *       Stamps `SEALED <date>` at the end of the note AND marks the current-session pointer
 *       closed (tpm-session-current.js sealSession) so the next bare `tpm-session` invocation
 *       opens fresh rather than reusing this session.
 *
 * IMMUTABILITY GUARD
 *   Every verb above operates ONLY on the CURRENT open session (per
 *   tpm-session-current.js#resolveCurrentSession). If no session is open, every verb except
 *   `init`/`resume` (which lazily open one — see NOTE below) errors with a clear message
 *   telling the caller to run `tpm-session open` first.
 *
 *   To edit a SEALED (past) session, pass `--edit-sealed <NNN> --confirm` on any verb. Without
 *   BOTH flags together, editing a non-current session is refused outright — there is no
 *   casual path to it. `--edit-sealed` targets whichever file exists in that session's folder
 *   (`session-notes.md` for 008+, `notes.md` for the legacy 001–007 sessions) and, if it's a
 *   canonical-format note, still enforces the two-zone discipline (Log/Decisions append-only);
 *   if it's a freeform legacy note (001–007, pre-dating this tool), the tool refuses to
 *   auto-rewrite it into the new structure and tells the caller so — those are prose, not
 *   token-parseable.
 *
 * NOTE ON init-vs-current
 *   `resume`/`log`/`decide`/`open add|done` all require an OPEN session (see IMMUTABILITY
 *   GUARD) — this tool never silently allocates a new session-NNN itself; that is
 *   `tpm-session-current.js#openSession`'s job, invoked by the `tpm-session open` skill mode.
 *   If a write verb is called with a session already open but no session-notes.md written yet
 *   for it, the tool DOES lazily create the skeleton file (not a new session number) so the
 *   first `resume`/`log` call after `open` doesn't require a separate `init` step.
 *
 * CLI
 *   --sessions-dir <dir>   REQUIRED on every invocation (resolve via tpm-session-config.js --sessions-dir).
 *   --edit-sealed <NNN> --confirm   Override the current-session-only guard (see above).
 *   --help
 *
 * EXAMPLES
 *   npx tpm session notes --sessions-dir .claude/claude-tpm/sessions resume \
 *     --where "Built the tools/session suite" --next "write tests" --in-flight "none"
 *   npx tpm session notes --sessions-dir .claude/claude-tpm/sessions open add --owner jason "review the config-guide patch"
 *   npx tpm session notes --sessions-dir .claude/claude-tpm/sessions open done 1
 *   npx tpm session notes --sessions-dir .claude/claude-tpm/sessions log --status WIP "wrote tpm-session-format.js"
 *   npx tpm session notes --sessions-dir .claude/claude-tpm/sessions decide "single pointer, not a sessionId map" --why "env var unreliable outside subagents"
 *   npx tpm session notes --sessions-dir .claude/claude-tpm/sessions seal
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveCurrentSession, sealSession } = require('./tpm-session-current');
const { parseNote, renderNote, nextOpenItemId, buildTitle } = require('./tpm-session-format');

function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}
function nowISO() {
  return new Date().toISOString();
}

function noteFilePath(sessionsDir, number, { preferLegacy = false } = {}) {
  const folder = path.join(sessionsDir, `session-${number}`);
  const modern = path.join(folder, 'session-notes.md');
  const legacy = path.join(folder, 'notes.md');
  if (preferLegacy) {
    if (fs.existsSync(legacy)) return legacy;
    if (fs.existsSync(modern)) return modern;
    return legacy;
  }
  if (fs.existsSync(modern)) return modern;
  if (fs.existsSync(legacy)) return legacy;
  return modern; // new file: always created as session-notes.md going forward (decision 3.2)
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
    resume: { whereWeAre: '', nextAction: '', inFlight: 'Nothing in flight.' },
    openItems: [],
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

function verbResume(args, ctx) {
  const filePath = noteFilePath(ctx.sessionsDir, ctx.number);
  const sections = loadOrInitSections(filePath, ctx.number, args.theme, args.date);
  if (!args.where || !args.next) {
    throw Object.assign(new Error('resume requires --where and --next.'), { code: 'EARGS' });
  }
  sections.resume = {
    whereWeAre: args.where,
    nextAction: args.next,
    inFlight: args.inFlight || 'Nothing in flight.',
  };
  writeSections(filePath, sections);
  process.stdout.write(`session-notes: RESUME updated in ${filePath}\n`);
}

function verbOpen(args, ctx) {
  const filePath = noteFilePath(ctx.sessionsDir, ctx.number);
  const sections = loadOrInitSections(filePath, ctx.number, args.theme, args.date);
  if (args.openSub === 'add') {
    if (!args.owner || !args.text) {
      throw Object.assign(new Error('open add requires --owner and a text argument.'), { code: 'EARGS' });
    }
    const id = nextOpenItemId(sections.openItems);
    sections.openItems.push({ id, owner: args.owner, done: false, text: args.text });
    writeSections(filePath, sections);
    process.stdout.write(`session-notes: added open item #${id} in ${filePath}\n`);
    return;
  }
  if (args.openSub === 'done') {
    const id = parseInt(args.text, 10);
    const item = sections.openItems.find((it) => it.id === id);
    if (!item) {
      throw Object.assign(new Error(`no open item #${args.text} found.`), { code: 'ENOITEM' });
    }
    item.done = true;
    writeSections(filePath, sections);
    process.stdout.write(`session-notes: marked open item #${id} done in ${filePath}\n`);
    return;
  }
  throw Object.assign(new Error('"open" requires a sub-verb: add | done.'), { code: 'EARGS' });
}

function verbLog(args, ctx) {
  const filePath = noteFilePath(ctx.sessionsDir, ctx.number);
  const sections = loadOrInitSections(filePath, ctx.number, args.theme, args.date);
  if (!args.status || !args.text) {
    throw Object.assign(new Error('log requires --status and a text argument.'), { code: 'EARGS' });
  }
  sections.log.push({ status: args.status, date: nowISO(), text: args.text });
  writeSections(filePath, sections);
  process.stdout.write(`session-notes: appended [${args.status}] log entry in ${filePath}\n`);
}

function verbDecide(args, ctx) {
  const filePath = noteFilePath(ctx.sessionsDir, ctx.number);
  const sections = loadOrInitSections(filePath, ctx.number, args.theme, args.date);
  if (!args.text || !args.why) {
    throw Object.assign(new Error('decide requires a text argument and --why.'), { code: 'EARGS' });
  }
  sections.decisions.push({ what: args.text, why: args.why });
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
      'Usage: npx tpm session notes --sessions-dir <dir> [--edit-sealed <NNN> --confirm] <verb> [args]',
      '',
      'Verbs:',
      '  init [--theme "<text>"] [--date <YYYY-MM-DD>]',
      '  resume --where "<text>" --next "<text>" [--in-flight "<text>"]',
      '  open add --owner <name> "<text>"',
      '  open done <id>',
      '  log --status <TAG> "<text>"',
      '  decide "<what>" --why "<why>"',
      '  seal',
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
    else if (a === '--where') { args.where = argv[++i]; }
    else if (a === '--next') { args.next = argv[++i]; }
    else if (a === '--in-flight') { args.inFlight = argv[++i]; }
    else if (a === '--owner') { args.owner = argv[++i]; }
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
    process.stderr.write('tpm-session-notes.js: a verb is required (init|resume|open|log|decide|seal).\n\n');
    printHelp();
    process.exit(1);
  }

  // For "open add|done", args._[1] is the sub-verb and the free-text arg follows.
  if (verb === 'open') {
    args.openSub = args._[1];
    args.text = args._.slice(2).join(' ');
  } else {
    args.text = args._.slice(1).join(' ');
  }

  try {
    const target = resolveTargetNumber({ sessionsDir: args.sessionsDir, editSealed: args.editSealed, confirm: args.confirm });
    const ctx = { sessionsDir: args.sessionsDir, number: target.number, isCurrent: target.isCurrent };

    switch (verb) {
      case 'init': verbInit(args, ctx); break;
      case 'resume': verbResume(args, ctx); break;
      case 'open': verbOpen(args, ctx); break;
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

module.exports = { noteFilePath, loadOrInitSections, writeSections, resolveTargetNumber, buildTitle };
