#!/usr/bin/env node
/**
 * lib/current-session.js — current-session state resolver (task A2).
 *
 * PURPOSE
 *   Answers the question `tpm-session`'s bare invocation needs: "has `open` already run this
 *   session, or not?" — and owns allocating the next `session-NNN` folder number
 *   (highest existing `session-NNN` + 1; no UUID involved in the count, per the resolved
 *   build answer). Backs both the skill's bare-invocation state check and the write-API's
 *   "which folder is CURRENT" guard.
 *
 * MECHANISM — a single current-session pointer file, NOT a sessionId->NNN map
 *   `<sessionsDir>/.current-session.json`:
 *     { "sessionId": "<uuid-or-null>", "number": "008", "openedAt": "<ISO8601>",
 *       "closedAt": "<ISO8601>|null" }
 *
 *   This is a deliberate build-time decision (build-plan.md §6 Q2 flagged the exact shape as
 *   open, not locked) — logged in findings/decisions.md. Rationale, briefly:
 *
 *   - `$CLAUDE_CODE_SESSION_ID` is CONFIRMED present in a subagent's process env (this build's
 *     own step-zero + the phase-01/02 planning rounds all observed it). It is NOT yet
 *     confirmed to read reliably from the orchestrator's own interactive/headless invocation
 *     path (build-plan.md §5.1's residual risk) — a different code path than a subagent's.
 *   - Rather than build a mechanism whose correctness silently depends on that unconfirmed
 *     read, `resolveCurrentSession()` degrades gracefully: sessionId is used to CONFIRM a
 *     mismatch when it IS available (proof of a genuinely new process), but a missing/unreadable
 *     sessionId does NOT itself flip the state — the safe default is "assume continuity" (an
 *     existing open pointer is presumed current) because silently minting a duplicate
 *     `session-NNN` folder every invocation is exactly the bug this whole redesign fixes, and
 *     is worse than occasionally missing a genuinely-new-session case that a user can still
 *     force with an explicit `tpm-session open`.
 *   - `close`/`seal()` always stamps `closedAt` on the pointer. A CLOSED pointer reads as
 *     "not-opened" regardless of sessionId — so the very next bare invocation after a close
 *     opens fresh, with no dependency on sessionId matching at all. This is what makes the
 *     mechanism correct even if the sessionId read never works outside a subagent: the
 *     open/close lifecycle itself is the disambiguator, sessionId is a best-effort bonus
 *     (recorded for diagnostics / concurrency notes, per the resolved answer), not the gate.
 *
 * EXPORTS (also a CLI, see --help)
 *   resolveCurrentSession({ sessionsDir })            -> { state: 'open'|'not-opened', number, sessionId, pointerPath, pointer }
 *   openSession({ sessionsDir })                       -> { number, sessionId, isNew, pointerPath }  (idempotent if already open)
 *   sealSession({ sessionsDir })                       -> { number, closedAt } | throws if nothing open
 *   allocateNextNumber({ sessionsDir })                -> "008" (highest existing session-NNN + 1, "001" if none)
 *   readEnvSessionId()                                 -> string|null ($CLAUDE_CODE_SESSION_ID, best-effort)
 *
 * CLI
 *   node lib/current-session.js --sessions-dir <dir> --state         # print resolved state as JSON
 *   node lib/current-session.js --sessions-dir <dir> --open          # ensure open, print result
 *   node lib/current-session.js --sessions-dir <dir> --seal          # close the current session
 *   node lib/current-session.js --sessions-dir <dir> --next-number   # print the next allocation (no side effect)
 *   node lib/current-session.js --help
 */

'use strict';

const fs = require('fs');
const path = require('path');

const POINTER_FILENAME = '.current-session.json';
const NUMBER_RE = /^session-(\d{3})$/;

function readEnvSessionId() {
  const v = process.env.CLAUDE_CODE_SESSION_ID;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function pointerPathFor(sessionsDir) {
  return path.join(sessionsDir, POINTER_FILENAME);
}

function readPointer(sessionsDir) {
  const p = pointerPathFor(sessionsDir);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    const wrapped = new Error(`current-session: could not parse ${p} as JSON: ${err.message}`);
    wrapped.code = 'EBADJSON';
    throw wrapped;
  }
}

function writePointer(sessionsDir, pointer) {
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(pointerPathFor(sessionsDir), `${JSON.stringify(pointer, null, 2)}\n`, 'utf8');
}

/** Highest existing session-NNN + 1, zero-padded to 3 digits. "001" if none exist yet. */
function allocateNextNumber({ sessionsDir }) {
  let entries = [];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') entries = [];
    else throw err;
  }
  let highest = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = NUMBER_RE.exec(e.name);
    if (m) highest = Math.max(highest, parseInt(m[1], 10));
  }
  return String(highest + 1).padStart(3, '0');
}

/**
 * Resolve whether a session is currently "open" (an unclosed pointer exists) or "not-opened"
 * (no pointer, or the pointer's session has been closed/sealed already).
 */
function resolveCurrentSession({ sessionsDir }) {
  const pointer = readPointer(sessionsDir);
  const envSessionId = readEnvSessionId();

  if (!pointer) {
    return { state: 'not-opened', number: null, sessionId: envSessionId, pointerPath: pointerPathFor(sessionsDir), pointer: null };
  }
  if (pointer.closedAt) {
    return { state: 'not-opened', number: null, sessionId: envSessionId, pointerPath: pointerPathFor(sessionsDir), pointer };
  }
  // Open pointer. A confirmed sessionId MISMATCH is treated as informational only in this
  // build (see the module docstring's rationale) — we still report it so a caller/skill can
  // choose to surface a note, but the default state stays 'open' (continuity wins) since the
  // pointer was never closed.
  return {
    state: 'open',
    number: pointer.number,
    sessionId: envSessionId,
    pointerSessionId: pointer.sessionId,
    sessionIdMismatch: Boolean(envSessionId && pointer.sessionId && envSessionId !== pointer.sessionId),
    pointerPath: pointerPathFor(sessionsDir),
    pointer,
  };
}

/** Ensure a session is open. Idempotent: returns the existing open session if one exists. */
function openSession({ sessionsDir }) {
  const current = resolveCurrentSession({ sessionsDir });
  if (current.state === 'open') {
    return { number: current.number, sessionId: current.pointer.sessionId, isNew: false, pointerPath: current.pointerPath };
  }
  const number = allocateNextNumber({ sessionsDir });
  const sessionId = readEnvSessionId();
  const pointer = { sessionId, number, openedAt: new Date().toISOString(), closedAt: null };
  writePointer(sessionsDir, pointer);
  return { number, sessionId, isNew: true, pointerPath: pointerPathFor(sessionsDir) };
}

/** Stamp the current open session's pointer as closed. Throws if nothing is open. */
function sealSession({ sessionsDir }) {
  const current = resolveCurrentSession({ sessionsDir });
  if (current.state !== 'open') {
    const err = new Error('current-session: nothing is currently open to seal.');
    err.code = 'ENOTHING_OPEN';
    throw err;
  }
  const pointer = Object.assign({}, current.pointer, { closedAt: new Date().toISOString() });
  writePointer(sessionsDir, pointer);
  return { number: pointer.number, closedAt: pointer.closedAt };
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: node lib/current-session.js --sessions-dir <dir> (--state | --open | --seal | --next-number) [--help]',
      '',
      'Resolves / mutates the current-session pointer under <dir>/.current-session.json.',
      '',
      'Flags:',
      '  --sessions-dir <dir>  REQUIRED. The resolved sessionsDir (see lib/config.js --sessions-dir).',
      '  --state               Print the resolved { state, number, sessionId, ... } as JSON. No side effect.',
      '  --open                Ensure a session is open (idempotent); print the result as JSON.',
      '  --seal                Close the current open session; print { number, closedAt }. Errors if none open.',
      '  --next-number         Print the next allocation ("008") without writing anything.',
      '  --help                Show this message.',
      '',
      'Examples:',
      '  node lib/current-session.js --sessions-dir claude-context/sessions --state',
      '  node lib/current-session.js --sessions-dir claude-context/sessions --open',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--state') args.state = true;
    else if (a === '--open') args.open = true;
    else if (a === '--seal') args.seal = true;
    else if (a === '--next-number') args.nextNumber = true;
    else if (a === '--sessions-dir') {
      args.sessionsDir = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (!args.sessionsDir) {
    process.stderr.write('lib/current-session.js: --sessions-dir is required.\n\n');
    printHelp();
    process.exit(1);
  }

  if (!args.state && !args.open && !args.seal && !args.nextNumber) {
    process.stderr.write('lib/current-session.js: nothing to do — pass one of --state / --open / --seal / --next-number.\n\n');
    printHelp();
    process.exit(1);
  }

  try {
    if (args.state) {
      process.stdout.write(`${JSON.stringify(resolveCurrentSession({ sessionsDir: args.sessionsDir }), null, 2)}\n`);
    } else if (args.open) {
      process.stdout.write(`${JSON.stringify(openSession({ sessionsDir: args.sessionsDir }), null, 2)}\n`);
    } else if (args.seal) {
      process.stdout.write(`${JSON.stringify(sealSession({ sessionsDir: args.sessionsDir }), null, 2)}\n`);
    } else if (args.nextNumber) {
      process.stdout.write(`${allocateNextNumber({ sessionsDir: args.sessionsDir })}\n`);
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`current-session: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  resolveCurrentSession,
  openSession,
  sealSession,
  allocateNextNumber,
  readEnvSessionId,
  pointerPathFor,
};
