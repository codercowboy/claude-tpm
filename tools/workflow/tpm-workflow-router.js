#!/usr/bin/env node
/**
 * tpm-workflow-router.js — the `workflow` sub-router for the `tpm` dispatcher.
 *
 * PURPOSE
 *   `tpm workflow <verb> [args…]` dispatches to the matching workflow tool script. This router OWNS
 *   the workflow verb table; the top-level `tpm.js` forwards `workflow <anything…>` here without
 *   knowing the verbs (design: dev/tpm-cli-design.md §0). Verbs are SHORT — the `workflow` suite name
 *   namespaces them (e.g. `scaffold`, not `scaffold-subagent`).
 *
 *   Sibling scripts resolve against THIS file's dir (`__dirname`) — no `%TPM_HOME%`/env dependency.
 *   Dispatch is by CHILD PROCESS (`spawnSync('node', …, {stdio:'inherit'})`); child exit propagated.
 *
 *   NOTE: the skill MODES `plan`/`verify`/`reconcile` are NOT here — those are the `/tpm-workflow`
 *   slash command. This router exposes only the scripts. The spawn-gate hook
 *   (`hooks/tpm-workflow-gate-spawn.js`) is harness-invoked, not a verb.
 *
 * USAGE
 *   tpm workflow <verb> [args…]
 *   tpm workflow --help | -h
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

// short verb -> sibling script (in this same dir). Self-contained; no shared imports (tool-conventions I§2).
const VERBS = {
  audit: 'tpm-workflow-audit.js',
  compose: 'tpm-workflow-compose-spawn-prompt.js',
  lint: 'tpm-workflow-lint-subagent-prompt.js',
  scaffold: 'tpm-workflow-scaffold-subagent.js',
  cost: 'tpm-workflow-cost-ledger.js',
  signoff: 'tpm-workflow-signoff.js',
  doctor: 'tpm-workflow-doctor.js',
  config: 'tpm-workflow-config-resolver.js',
  'check-filename': 'tpm-workflow-check-filename.js',
};

function help() {
  console.log(`tpm workflow — multi-agent round tooling router

Usage:
  tpm workflow <verb> [args…]

Verbs:
  audit           epic-vs-flat structure audit + numbering
  compose         compose a subagent spawn prompt (--role …)
  lint            lint a subagent prompt (--file … --manifest …)
  scaffold        scaffold a task/epic folder (epic-init / add-phase …)
  cost            the per-agent cost ledger (--epic-path … / --rollup …)
  signoff         the pre-spawn signoff gates (questions / spawn)
  doctor          fail-loud preflight before a round
  config          resolve the workflow config (--json)
  check-filename  filename-convention check

Remaining args pass straight through, e.g.:
  tpm workflow scaffold add-phase dev/<epic> --slug <slug> --team <team>
  tpm workflow compose --role builder …`);
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
    process.stderr.write(`tpm workflow: unknown verb '${verb}'.\n\n`);
    help();
    return 2;
  }

  const tool = path.join(__dirname, rel);
  const r = spawnSync('node', [tool, ...args.slice(1)], { stdio: 'inherit' });
  if (r.error) {
    process.stderr.write(`tpm workflow: failed to run '${verb}': ${r.error.message}\n`);
    return 1;
  }
  return r.status == null ? 1 : r.status; // propagate child exit (null => killed by signal)
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { main, VERBS };
