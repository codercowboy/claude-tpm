#!/usr/bin/env node
/**
 * tpm-session-boot-read.js — the boot-time pickup emitter (spec §7, §12.6).
 *
 * PURPOSE
 *   A PURE-READ verb whose stdout IS the pickup payload: `session open` calls it so prior state is
 *   pulled into context by a tool call, not by the model choosing to open a file. It emits, for the
 *   highest-numbered PRIOR session (never the just-opened current one):
 *     • the `session-NNNN-handoff.md` VERBATIM (short, always current — the READ-FIRST doc),
 *     • the unfinished (`## Open`) punchlist items, mechanically extracted (HEADLINES ONLY — NO notes),
 *     • when there is ≥1 open item, ONE templated `lineage` pointer using a real slug from the list (#1095),
 *     • the file locations of all three files,
 *     • the reminder that the notes log reads BOTTOM-TO-TOP.
 *
 * CONTRACT — NEVER crashes boot: exit 0 in ALL cases (including no prior session, an unreadable
 *   dir, an unrecognized/old/partial prior session). Side-effect-free (reads only).
 *
 * VERSION GATE (§13.6) — v1.0 only, no back-compat:
 *   The prior session is the highest-numbered PRIOR folder whose `session-NNNN-handoff.md` carries the
 *   `tpm-session-version: 1.0` sentinel (via `readsAsV1`). Any pre-v1.0 / unmarked / handoff-less
 *   folder is IGNORED (skipped), never parsed. If NO prior folder is v1.0 → the clean "first session"
 *   message. The point-at-path tier is REMOVED — an old session is invisible, not pointed-at.
 *
 * SESSIONS DIR
 *   `--sessions-dir <dir>` if given (used by tests + explicit callers). Otherwise resolved from the
 *   session config (the same value `npx tpm session config --sessions-dir` prints), best-effort — a
 *   resolution failure degrades to a clean message + exit 0, it never crashes boot.
 *
 * CLI
 *   npx tpm session boot-read [--sessions-dir <dir>]
 *   npx tpm session boot-read --help
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readsAsV1 } = require('./tpm-session-format');

const NUMBER_RE = /^session-(\d{3,4})$/;

// ---- sessions-dir resolution (best-effort; never throws) --------------------
function resolveSessionsDir(explicit) {
  if (explicit) return explicit;
  try {
    // In-process resolution == `npx tpm session config --sessions-dir`.
    // eslint-disable-next-line global-require
    const cfg = require('./tpm-session-config');
    const { resolved, projectRoot } = cfg.resolveSessionConfig();
    return cfg.sessionsDirAbs(resolved, projectRoot);
  } catch (err) {
    return null;
  }
}

// ---- current-session number (to EXCLUDE it; best-effort) --------------------
function currentSessionNumber(sessionsDir) {
  try {
    // eslint-disable-next-line global-require
    const { resolveCurrentSession } = require('./tpm-session-current');
    const cur = resolveCurrentSession({ sessionsDir });
    return cur && cur.state === 'open' ? cur.number : null;
  } catch (err) {
    return null;
  }
}

// ---- prior-session selection ------------------------------------------------
/** All `session-NNN(N)` numbers under sessionsDir, descending (highest first). [] on any read error. */
function listSessionNumbers(sessionsDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  const numbers = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = NUMBER_RE.exec(e.name);
    if (m) numbers.push(m[1]);
  }
  return numbers.sort().reverse();
}

/**
 * Highest prior session number (excluding the current pointer's number) whose `session-NNNN-handoff.md`
 * reads as v1.0. Iterates descending and SKIPS (ignores) any prior that is not a v1.0 file — a
 * pre-v1.0 / unmarked / handoff-less folder is invisible (no point-at-path tier; removed under
 * no-back-compat). null if nothing qualifies.
 */
function highestPriorNumber(sessionsDir, currentNumber) {
  const numbers = listSessionNumbers(sessionsDir);
  for (const n of numbers) {
    if (currentNumber && n === currentNumber) continue;
    const handoffPath = path.join(sessionsDir, `session-${n}`, `session-${n}-handoff.md`);
    if (!readsAsV1(handoffPath)) continue;
    return n;
  }
  return null;
}

// ---- emit -------------------------------------------------------------------
function emitNoPrior(sessionsDir) {
  const where = sessionsDir || '(unresolved sessions dir)';
  process.stdout.write(
    `boot-read: no prior session found under ${where} — this looks like the first session. Nothing to pick up.\n`,
  );
}

function emitNewFormat(number, folder) {
  const handoffPath = path.join(folder, `session-${number}-handoff.md`);
  const punchlistPath = path.join(folder, `session-${number}-punchlist.md`);
  const notesPath = path.join(folder, `session-${number}-log.md`);

  const out = [];
  out.push(`== PRIOR SESSION ${number} · ${folder}/ ==`);
  out.push(`files: ${handoffPath} · ${punchlistPath} · ${notesPath}   (log reads bottom-to-top)`);

  // handoff.md verbatim (the READ-FIRST doc).
  out.push('--- HANDOFF (read fully) ---');
  let handoff = '';
  try {
    handoff = fs.readFileSync(handoffPath, 'utf8').replace(/\n+$/, '');
  } catch (err) {
    handoff = `(could not read ${handoffPath}: ${err.message})`;
  }
  out.push(handoff);

  // Open punchlist items, mechanically extracted — HEADLINES ONLY (incl. carried), NO notes (#1095,
  // §13.5). The emit reads only id/text/slug/created, never `it.notes`, so notes stay hidden by
  // construction. A single templated `lineage` pointer (using a REAL slug from the list) is appended
  // when there is at least one open item — detail is one `lineage` call away (the reader is #1092).
  let openLines = [];
  let pointerSlug = null;
  try {
    if (fs.existsSync(punchlistPath)) {
      // eslint-disable-next-line global-require
      const { parsePunchlist, openItems } = require('./tpm-session-format');
      const open = openItems(parsePunchlist(fs.readFileSync(punchlistPath, 'utf8')));
      openLines = open.map((it) => `#${it.id} · ${it.text}  [${it.slug}, ${it.created}]`);
      if (open.length) pointerSlug = open[0].slug;
    }
  } catch (err) {
    openLines = [`(could not read ${punchlistPath}: ${err.message})`];
  }
  out.push(`--- OPEN PUNCHLIST (${openLines.length}) ---`);
  out.push(openLines.length ? openLines.join('\n') : '(no open punchlist items)');
  if (pointerSlug) out.push(`for more detail: npx tpm session punchlist lineage ${pointerSlug}`);

  process.stdout.write(`${out.join('\n')}\n`);
}

// ---- CLI plumbing -----------------------------------------------------------
function printHelp() {
  process.stdout.write(
    [
      'Usage: npx tpm session boot-read [--sessions-dir <dir>]',
      '',
      'Pure-read boot pickup: emits the highest PRIOR v1.0 session\'s session-NNNN-handoff.md verbatim +',
      'its open punchlist items + the three file locations + the bottom-to-top log reminder. Never emits',
      'the just-opened current session. Pre-v1.0 / unmarked sessions are IGNORED (no back-compat).',
      'ALWAYS exits 0 — it must never crash boot.',
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
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Everything below is best-effort: any failure degrades to a clean message, exit 0.
  try {
    const sessionsDir = resolveSessionsDir(args.sessionsDir);
    if (!sessionsDir) {
      process.stdout.write(
        'boot-read: could not resolve the sessions directory (config unreadable) — pass --sessions-dir, or read the latest session folder directly.\n',
      );
      process.exit(0);
    }

    const currentNumber = currentSessionNumber(sessionsDir);
    const priorNumber = highestPriorNumber(sessionsDir, currentNumber);
    if (!priorNumber) {
      emitNoPrior(sessionsDir);
      process.exit(0);
    }

    // priorNumber is guaranteed v1.0 (highestPriorNumber gates on readsAsV1) — emit the rich slice.
    const folder = path.join(sessionsDir, `session-${priorNumber}`);
    emitNewFormat(priorNumber, folder);
    process.exit(0);
  } catch (err) {
    // Last-resort guard: never crash boot.
    process.stdout.write(`boot-read: could not build a pickup slice (${err.message}) — open the latest session folder directly.\n`);
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  resolveSessionsDir,
  currentSessionNumber,
  listSessionNumbers,
  highestPriorNumber,
};
