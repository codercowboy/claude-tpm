#!/usr/bin/env node
/**
 * tpm-task-router.js — the `task` sub-router for the `tpm` dispatcher.
 *
 * PURPOSE
 *   `task` is a SINGLE-TOOL suite: `tpm-task.js` owns all the ledger subcommands (add/list/show/
 *   check/start/finish/drop/…). So this router forwards almost everything straight to `tpm-task.js`
 *   with the subcommand intact — `tpm task add …` ≡ `tpm-task.js add …`. The ONE exception is the
 *   `config` verb, which forwards to the config resolver (`tpm-task-config.js`) that the skill's
 *   config-gate calls (`--tasks-dir` / `--get enabled` / `--json`).
 *
 *   The top-level `tpm.js` forwards `task <anything…>` here without knowing verbs
 *   (design: dev/tpm-cli-design.md §0). Sibling scripts resolve against `__dirname` — no `${TPM_HOME}`/
 *   env dependency. Dispatch is by CHILD PROCESS; child exit propagated. `tpm-task.js` owns its own
 *   `--help` / bare-invocation listing, so those pass straight through.
 *
 * USAGE
 *   tpm task <subcommand> [args…]   # → tpm-task.js  (add/list/show/check/start/finish/drop/…)
 *   tpm task config [args…]         # → tpm-task-config.js  (--tasks-dir / --get enabled / --json)
 *   tpm task --help                 # → tpm-task.js --help
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const MAIN = 'tpm-task.js';           // the ledger tool (owns its own subcommands + --help)
const CONFIG = 'tpm-task-config.js';  // the config-section resolver (the skill's gate)

function main(argv) {
  const args = argv.slice(2);

  // `config` is the only router-reserved verb; everything else (incl. bare + --help) is tpm-task.js's.
  let rel, rest;
  if (args[0] === 'config') {
    rel = CONFIG;
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

module.exports = { main, MAIN, CONFIG };
