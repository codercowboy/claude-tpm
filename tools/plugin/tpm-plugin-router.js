#!/usr/bin/env node
/**
 * tpm-plugin-router.js — the `plugin` sub-router for the `tpm` dispatcher.
 *
 * PURPOSE
 *   `tpm plugin <verb> [args…]` is the claude-tpm PLUGIN-management suite: set the plugin up in a project
 *   (`install`), take it out (`uninstall`), and check that it is wired correctly (`doctor`). This router
 *   OWNS the verb table; the top-level `tools/tpm.js` forwards `plugin <anything…>` here without knowing
 *   the verbs (design: dev/tpm-cli-design.md §0). The three verbs are thin routes to the consumer scripts,
 *   which stay where they live (`tools/consumer/`) — nothing is relocated.
 *
 *   The flat aliases `tpm install` / `tpm uninstall` / `tpm doctor` keep working (they are the human
 *   porcelain: `npx tpm install .`) and dispatch to the SAME scripts, so both spellings behave identically.
 *
 *   There is deliberately NO `update` verb: a local-folder plugin runs IN PLACE from the folder its
 *   marketplace row names (dev/plugin-topology/probe-findings.md), so there is no cached copy to refresh.
 *
 *   Dispatch is by CHILD PROCESS with `stdio:'inherit'`, so args, stdin (the installer's interactive
 *   prompts), stdout/stderr and the EXIT CODE pass straight through unchanged. Scripts resolve against
 *   THIS file's dir (`__dirname`) — no `%TPM_HOME%` / env dependency.
 *
 * USAGE
 *   tpm plugin install [dir] [options]     # → consumer/tpm-consumer-install.js
 *   tpm plugin uninstall [dir] [options]   # → consumer/tpm-consumer-uninstall.js
 *   tpm plugin doctor [dir]                # → consumer/tpm-consumer-install.js … --check (read-only)
 *   tpm plugin --help | -h
 *   (In a plain project shell, outside a Claude Code session, run these as `npx tpm plugin …`.)
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

// verb -> { script (relative to THIS file's dir), extra (fixed trailing args the verb injects) }
const VERBS = {
  install: { script: '../consumer/tpm-consumer-install.js', extra: [] },
  uninstall: { script: '../consumer/tpm-consumer-uninstall.js', extra: [] },
  doctor: { script: '../consumer/tpm-consumer-install.js', extra: ['--check'] }, // read-only = `install --check`
};

function help() {
  console.log(`tpm plugin — claude-tpm plugin management

Usage:
  tpm plugin <verb> [args…]

Verbs:
  install [dir] [options]     set claude-tpm up in a project (marketplace + plugin + dependency)
  uninstall [dir] [options]   reverse it (asks: this project only, or the whole system)
  doctor [dir]                read-only health check (= install --check)

  tpm plugin --help, -h

The flat forms \`tpm install\` / \`tpm uninstall\` / \`tpm doctor\` do the same thing.
In a plain project shell (outside a Claude Code session), run these as \`npx tpm plugin …\`.`);
}

function main(argv) {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    help();
    return 0;
  }

  const verb = args[0];
  const spec = Object.prototype.hasOwnProperty.call(VERBS, verb) ? VERBS[verb] : null;
  if (!spec) {
    process.stderr.write(`tpm plugin: unknown verb '${verb}'.\n\n`);
    help();
    return 2;
  }

  // Dumb forward: everything after the verb, plus any fixed trailing args the verb injects (doctor → --check).
  const tool = path.join(__dirname, spec.script);
  const r = spawnSync('node', [tool, ...args.slice(1), ...spec.extra], { stdio: 'inherit' });
  if (r.error) {
    process.stderr.write(`tpm plugin: failed to run '${verb}': ${r.error.message}\n`);
    return 1;
  }
  return r.status == null ? 1 : r.status; // propagate child exit (null => killed by signal)
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { main, VERBS };
