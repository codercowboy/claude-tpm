#!/usr/bin/env node
/**
 * tpm-session-boot-read.js — the boot-time pickup emitter, REWORKED for the JSON-first note format.
 *
 * PURPOSE
 *   A PURE-READ verb whose stdout IS the boot pickup payload: `session open` (the tpm-session skill's
 *   boot ritual) calls it so prior state is pulled into context by a tool call, not by the model
 *   choosing to open a file. It emits, for the highest-numbered PRIOR session (never the just-opened
 *   current one):
 *     • the prior session's HANDOFF (where / next / in flight / must-not-redo), rendered from the
 *       canonical JSON via the new session model — the READ-FIRST slice,
 *     • the still-OPEN punchlist items (HEADLINES ONLY: id · text · slug),
 *     • the file locations of the canonical `session-NNNN.json` + derived `session-NNNN.md`,
 *     • a pointer to the derived `.md` / `tpm session export` for the full log + punchlist detail.
 *
 * FORMAT (rework, #1123 Stage C) — the notes are now ONE canonical `session-NNNN.json` (+ ONE derived
 *   `session-NNNN.md` with `## Handoff` / `## Punchlist` / `## Log` sections), nested under
 *   `<sessionsDir>/session-NNNN/`. The OLD boot-read parsed the retired three-file `.md` layout
 *   (`-handoff.md` / `-punchlist.md` / `-log.md`); this version reads the canonical JSON through
 *   `lib/session-model.loadSession` (read → migrate → validate) instead — no dependence on the old
 *   markdown parser or its v1.0 sentinel. The load path's migrate step REFUSES an unknown-NEWER
 *   schemaVersion, so a session written by a newer tool is skipped (never mis-read), not crashed on.
 *
 * CONTRACT — NEVER crashes boot: exit 0 in ALL cases (no prior session, an unreadable dir, a
 *   corrupt / unknown-newer / partial prior JSON). Side-effect-free (reads only). Any failure
 *   degrades to a clean one-line message + exit 0.
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

const NUMBER_RE = /^session-(\d{3,4})$/;

// meta.number / folder numbers are canonical zero-padded width-4; re-pad defensively so a 3-digit
// legacy folder and a 4-digit one compare + render the same way (tolerant, like the converter).
function padNumber(number) {
  const n = Number(number);
  if (Number.isFinite(n)) return String(n).padStart(4, '0');
  return String(number == null ? '' : number).padStart(4, '0');
}

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
/** All `session-NNN(N)` numbers under sessionsDir, DESCENDING (highest first). [] on any read error. */
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
  // numeric descending so session-0010 outranks session-0009 (string sort would not).
  return numbers.sort((a, b) => Number(b) - Number(a));
}

function sessionPaths(sessionsDir, number) {
  const nnnn = padNumber(number);
  const folder = path.join(sessionsDir, `session-${nnnn}`);
  return {
    folder,
    jsonPath: path.join(folder, `session-${nnnn}.json`),
    mdPath: path.join(folder, `session-${nnnn}.md`),
  };
}

/**
 * Highest PRIOR session (excluding the current pointer's number) that has a canonical
 * `session-NNNN.json` which LOADS through the model (read→migrate→validate). Iterates descending
 * and SKIPS any folder whose JSON is absent / corrupt / unknown-newer — such a folder is invisible,
 * never crashed on. Returns { number, folder, jsonPath, mdPath, record } or null.
 */
function findPrior(sessionsDir, currentNumber) {
  let model = null;
  try {
    // eslint-disable-next-line global-require
    model = require('./lib/session-model');
  } catch (err) {
    model = null;
  }
  for (const n of listSessionNumbers(sessionsDir)) {
    if (currentNumber && padNumber(n) === padNumber(currentNumber)) continue;
    const paths = sessionPaths(sessionsDir, n);
    if (!fs.existsSync(paths.jsonPath)) continue;
    let record = null;
    if (model) {
      try {
        record = model.loadSession(paths.jsonPath);
      } catch (err) {
        continue; // corrupt / unknown-newer / invalid — skip; never crash boot.
      }
    } else {
      // No model available (should not happen — sibling lib) — degrade to raw parse best-effort.
      try {
        record = JSON.parse(fs.readFileSync(paths.jsonPath, 'utf8'));
      } catch (err) {
        continue;
      }
    }
    return { number: padNumber(n), folder: paths.folder, jsonPath: paths.jsonPath, mdPath: paths.mdPath, record };
  }
  return null;
}

// ---- emit -------------------------------------------------------------------
function nonEmptyString(s) {
  return typeof s === 'string' && s.trim() !== '';
}

function bulleted(items) {
  return items.map((x) => '- ' + x).join('\n');
}

/** Render the handoff slice from the canonical `handoff` object (null-safe). */
function renderHandoff(h) {
  if (h === null || h === undefined) {
    return '(no handoff recorded yet — the prior session opened but never saved a handoff.)';
  }
  const blocks = [];
  if (nonEmptyString(h.where)) blocks.push('**Where we are:**\n' + h.where);
  if (nonEmptyString(h.next)) blocks.push('**Next:**\n' + h.next);
  if (Array.isArray(h.in_flight) && h.in_flight.length) blocks.push('**In flight:**\n' + bulleted(h.in_flight));
  if (Array.isArray(h.must_not_redo) && h.must_not_redo.length) {
    blocks.push('**Must not redo:**\n' + bulleted(h.must_not_redo));
  }
  return blocks.length ? blocks.join('\n\n') : '(handoff present but empty.)';
}

function emitNoPrior(sessionsDir) {
  const where = sessionsDir || '(unresolved sessions dir)';
  process.stdout.write(
    `boot-read: no prior session found under ${where} — this looks like the first session. Nothing to pick up.\n`,
  );
}

function emitPrior(prior, sessionsDir) {
  const { number, folder, jsonPath, mdPath, record } = prior;
  const out = [];
  out.push(`== PRIOR SESSION ${number} · ${folder}/ ==`);
  out.push(`files: ${jsonPath} · ${mdPath}   (canonical JSON + derived .md; the log reads newest-first)`);

  // Handoff — the READ-FIRST slice, reconstructed from the canonical JSON.
  out.push('--- HANDOFF (read fully) ---');
  out.push(renderHandoff(record ? record.handoff : null));

  // Open punchlist — HEADLINES ONLY (id · text · slug); dropped/done items are omitted.
  const items = record && Array.isArray(record.punchlist) ? record.punchlist : [];
  const open = items.filter((it) => it && it.state === 'open');
  out.push(`--- OPEN PUNCHLIST (${open.length}) ---`);
  if (open.length) {
    out.push(open.map((it) => `#${it.id} · ${it.text}  [${it.slug}]`).join('\n'));
    out.push(
      `for full detail: read ${mdPath} (## Punchlist / ## Log), or run: ` +
        `npx tpm session export --sessions-dir ${sessionsDir} --session ${number} --style human`,
    );
  } else {
    out.push('(no open punchlist items)');
  }

  process.stdout.write(`${out.join('\n')}\n`);
}

// ---- CLI plumbing -----------------------------------------------------------
function printHelp() {
  process.stdout.write(
    [
      'Usage: npx tpm session boot-read [--sessions-dir <dir>]',
      '',
      "Pure-read boot pickup: emits the highest PRIOR session's handoff (from the canonical",
      'session-NNNN.json, via the session model) + its open punchlist headlines + the JSON/.md file',
      'locations. Never emits the just-opened current session. A corrupt / unknown-newer / partial',
      'prior JSON is SKIPPED, not crashed on. ALWAYS exits 0 — it must never crash boot.',
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
    const prior = findPrior(sessionsDir, currentNumber);
    if (!prior) {
      emitNoPrior(sessionsDir);
      process.exit(0);
    }

    emitPrior(prior, sessionsDir);
    process.exit(0);
  } catch (err) {
    // Last-resort guard: never crash boot.
    process.stdout.write(
      `boot-read: could not build a pickup slice (${err.message}) — open the latest session folder directly.\n`,
    );
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
  sessionPaths,
  findPrior,
  renderHandoff,
  padNumber,
};
