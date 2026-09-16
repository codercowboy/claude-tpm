#!/usr/bin/env node
/**
 * tpm-session-router.js — the `session` sub-router for the `tpm` dispatcher.
 *
 * PURPOSE
 *   `tpm session <verb> [args…]` dispatches to the matching session tool script. This router OWNS
 *   the session verb table; the top-level `tpm.js` is deliberately dumb about verbs and just forwards
 *   `session <anything…>` here (see tools/tpm.js). Verbs are SHORT — the `session` suite name already
 *   namespaces them (design: dev/tpm-cli-design.md §0).
 *
 *   Sibling scripts are resolved against THIS file's own directory (`__dirname`), so nothing here
 *   depends on `${TPM_HOME}` or any env var — the whole point of routing skill invocations through
 *   `tpm`: it eliminates the `${TPM_HOME}` token from Bash invocations (Path A).
 *
 *   Dispatch is by CHILD PROCESS (`spawnSync('node', [tool, …args], {stdio:'inherit'})`) — process
 *   isolation + faithful argv/stdio pass-through; the child's exit code is propagated.
 *
 *   NOTE: the skill MODES `open`/`close`/`save`/`info` are NOT here — those are the `/tpm-session`
 *   slash command (orchestration + model doc-reads + MOTD), not scripts. This router exposes only the
 *   scripts those modes shell out to.
 *
 * USAGE
 *   tpm session <config|current|notes|review> [args…]
 *   tpm session --help | -h
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

// short verb -> sibling script (in this same dir). Self-contained; no shared imports (tool-conventions I§2).
const VERBS = {
  config: 'tpm-session-config.js',
  current: 'tpm-session-current.js',
  notes: 'tpm-session-notes.js',
  review: 'tpm-session-review.js',
};

function help() {
  console.log(`tpm session — session-notes tooling router

Usage:
  tpm session <verb> [args…]

Verbs:
  config    resolve session config / sessions-dir (--json / --sessions-dir / --get)
  current   the current-session pointer (--state / --open / --seal / --next-number)
  notes     the notes WRITE API (init / resume / open / log / decide / seal)
  review    the notes READ API (--last N …)

Remaining args pass straight through, e.g.:
  tpm session current --sessions-dir .claude/claude-tpm/sessions --open
  tpm session notes resume --where "…" --next "…"`);
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    help();
    return 0;
  }

  const verb = args[0];
  const rel = VERBS[verb];
  if (!rel) {
    process.stderr.write(`tpm session: unknown verb '${verb}'.\n\n`);
    help();
    return 2;
  }

  const tool = path.join(__dirname, rel);
  const r = spawnSync('node', [tool, ...args.slice(1)], { stdio: 'inherit' });
  if (r.error) {
    process.stderr.write(`tpm session: failed to run '${verb}': ${r.error.message}\n`);
    return 1;
  }
  return r.status == null ? 1 : r.status; // propagate child exit (null => killed by signal)
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { main, VERBS };
