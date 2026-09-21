#!/usr/bin/env node
'use strict';
/**
 * tpm-task-router.js — the `task` sub-router for the `tpm` dispatcher (P06 port; near-verbatim).
 *
 * PURPOSE
 *   `task` is a SINGLE-TOOL suite: `tpm-task.js` owns all the ledger subcommands (list/show/add/
 *   import/edit/check/add-subtask/start/finish/drop/remove/reopen/reindex/history). So this router
 *   forwards almost everything straight to `tpm-task.js` with the subcommand intact — `tpm task add …`
 *   ≡ `tpm-task.js add …`. The ONE exception is the `config` verb, which forwards to the config
 *   resolver (`tpm-task-config.js`) that governs the #1109 history gate (`--json` / `--get` /
 *   `--tasks-dir`).
 *
 *   Sibling scripts resolve against `__dirname` — no `%TPM_HOME%`/env dependency. Dispatch is by
 *   CHILD PROCESS; the child's exit is propagated. `tpm-task.js` owns its own `--help` / bare
 *   listing, so those pass straight through.
 *
 * USAGE
 *   tpm task <subcommand> [args…]   # → tpm-task.js  (list/show/add/import/edit/check/…)
 *   tpm task config [args…]         # → tpm-task-config.js  (--tasks-dir / --get / --json)
 *   tpm task export|search [args…]  # → tpm-task-export.js  (P07 selector core)
 *   tpm task doctor [args…]         # → tpm-task-doctor.js  (READ-ONLY validate + drift)
 *   tpm task migrate [args…]        # → tpm-task-migrate.js (opt-in old-format → JSON)
 *   tpm task --help                 # → tpm-task.js --help
 *
 * Zero third-party deps; Node built-ins only.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const MAIN = 'tpm-task.js';           // the ledger tool (owns its own subcommands + --help)
const CONFIG = 'tpm-task-config.js';  // the config-section resolver (the #1109 gate)
const EXPORT_TOOL = 'tpm-task-export.js';  // the export + search tool (P07; ONE selector core)
const DOCTOR = 'tpm-task-doctor.js';  // READ-ONLY health check (symmetric with the session router)
const MIGRATE = 'tpm-task-migrate.js'; // opt-in old-format → canonical JSON

function main(argv) {
  const args = argv.slice(2);

  // Router-reserved verbs: `config` → the config resolver; `export`/`search` → the export+search tool
  // (P07); `doctor` → the health check; `migrate` → the migrator (symmetric with the session router).
  // Everything else (incl. bare + --help + `history`) is tpm-task.js's, passed through verbatim.
  let rel;
  let rest;
  if (args[0] === 'config') {
    rel = CONFIG;
    rest = args.slice(1);
  } else if (args[0] === 'export' || args[0] === 'search') {
    rel = EXPORT_TOOL;
    rest = args; // keep the export|search mode token as argv[0] for the tool's mode dispatch
  } else if (args[0] === 'doctor') {
    rel = DOCTOR;
    rest = args.slice(1);
  } else if (args[0] === 'migrate') {
    rel = MIGRATE;
    rest = args.slice(1);
  } else {
    rel = MAIN;
    rest = args; // pass the subcommand through verbatim
  }

  const tool = path.join(__dirname, rel);
  const r = spawnSync('node', [tool, ...rest], { stdio: 'inherit' });
  if (r.error) {
    process.stderr.write(`tpm task: failed to run '${args[0] || ''}': ${r.error.message}\n`);
    return 1;
  }
  return r.status == null ? 1 : r.status; // propagate child exit (null => killed by signal)
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { main, MAIN, CONFIG, EXPORT_TOOL, DOCTOR, MIGRATE };
