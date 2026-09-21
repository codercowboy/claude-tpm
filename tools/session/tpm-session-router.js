#!/usr/bin/env node
'use strict';
/**
 * tpm-session-router.js — the `session` sub-router for the `tpm` dispatcher.
 *
 * PURPOSE
 *   `tpm session <verb> [args…]` dispatches to the matching session tool script. This router OWNS the
 *   session verb table; the top-level `tpm.js` is deliberately dumb about verbs and just forwards
 *   `session <anything…>` here (see tools/tpm.js). Verbs are SHORT — the `session` suite name already
 *   namespaces them.
 *
 *   The JSON-first session tooling (#1113) is four node-invokable scripts; this router is the ONE `bin`
 *   seam over them. Each entry script owns its OWN subcommands/flags, so everything after the verb token
 *   passes straight through (`tpm session ops open …` ≡ `tpm-session-ops.js open …`).
 *
 *   Sibling scripts resolve against THIS file's own directory (`__dirname`), so nothing here depends on
 *   an absolute bundle path or any env var. Dispatch is by CHILD PROCESS
 *   (`spawnSync('node', [tool, …args], {stdio:'inherit'})`) — process isolation + faithful argv/stdio
 *   pass-through; the child's exit code is propagated.
 *
 * USAGE
 *   tpm session <ops|export|migrate|doctor|config|current|boot-read> [args…]
 *   tpm session --help | -h
 *
 * Zero third-party deps; Node built-ins only.
 */

const path = require('path');
const { spawnSync } = require('child_process');

// short verb -> sibling script (in this same dir). Self-contained; no shared imports.
const VERBS = {
  ops: 'tpm-session-ops.js',          // session ops + #1115 import (open/save/note/punchlist/close/import-*)
  export: 'tpm-session-export.js',    // #1092 export: single/multi · JSON/human
  migrate: 'tpm-session-migrate.js',  // #1114 opt-in old 3-file markdown -> canonical JSON
  doctor: 'tpm-session-doctor.js',    // #1119 READ-ONLY validate + hash-drift + detect/suggest-migrate
  config: 'tpm-session-config.js',    // #1123 restored: session config resolver (--json/--get/--sessions-dir/--modules)
  current: 'tpm-session-current.js',  // #1123 restored: current-session pointer (--state/--open/--seal/--next-number)
  'boot-read': 'tpm-session-boot-read.js', // #1123 reworked: JSON-first boot pickup emitter (always exit 0)
};

function help() {
  console.log(`tpm session — JSON-first session-notes tooling router

Usage:
  tpm session <verb> [args…]

Verbs:
  ops        session ops + #1115 import (open / save / note / punchlist / close / import-handoff|log|punchlist)
  export     export sessions (single/multi · --style json|human|both · --last N | --session NNNN)
  migrate    #1114 opt-in convert ONE old 3-file markdown session -> canonical JSON (--in / --out-dir)
  doctor     #1119 READ-ONLY health check: validate + hash-drift + detect/suggest-migrate (--sessions-dir)
  config     session config resolver (--json / --get <k> / --sessions-dir / --modules)
  current    current-session pointer (--state / --open / --seal / --next-number · --sessions-dir)
  boot-read  JSON-first boot pickup emitter — prior handoff + open punchlist (always exits 0)

Remaining args pass straight through, e.g.:
  tpm session ops open --sessions-dir .claude/claude-tpm/sessions --session 0043
  tpm session export --sessions-dir .claude/claude-tpm/sessions --last 3 --style human
  tpm session doctor --sessions-dir .claude/claude-tpm/sessions
  tpm session config --sessions-dir
  tpm session boot-read --sessions-dir .claude/claude-tpm/sessions`);
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
