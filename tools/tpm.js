#!/usr/bin/env node
/**
 * tpm.js — the `tpm` convenience bin: the DUMB top-level dispatcher for claude-tpm's tooling.
 *
 * PURPOSE
 *   One entry point, git-style: `tpm <suite> <verb> [args…]`. This top dispatcher is deliberately
 *   DUMB about verbs — it knows only SUITES, and forwards `<suite> <everything-after>` verbatim to
 *   that suite's own router (`tools/<suite>/tpm-<suite>-router.js`), which owns its verb table
 *   (design: dev/tpm-cli-design.md §0). Adding/renaming a verb never touches this file.
 *
 *   Two flat human-porcelain ALIASES — `install` / `uninstall` — dispatch straight to the consumer
 *   adoption scripts (no suite prefix), because that's how a human adopts claude-tpm:
 *   `npx tpm install .`.
 *
 *   Everything resolves against THIS file's dir (`__dirname`) and dispatches by CHILD PROCESS
 *   (`spawnSync('node', [tool, …args], {stdio:'inherit'})`) — process isolation + faithful argv/stdio
 *   pass-through; the child's exit code is propagated. Because the routers self-locate their scripts,
 *   NOTHING in the `tpm …` chain needs `%TPM_HOME%` or any env var.
 *
 * USAGE
 *   tpm session <verb> [args…]      # session-notes tooling      → session/tpm-session-router.js
 *   tpm task    <verb> [args…]      # task ledger                → task/tpm-task-router.js
 *   tpm workflow <verb> [args…]     # multi-agent round tooling  → workflow/tpm-workflow-router.js
 *   tpm hooks   <verb> [args…]      # PreToolUse hooks           → hooks/tpm-hooks-router.js
 *   tpm install [dir] [options]     # graft claude-tpm onto an existing project
 *   tpm uninstall [dir] [options]   # reverse it (scope-aware: this project vs the whole system)
 *   tpm doctor [dir]                # read-only health check (= `install --check`)
 *   tpm home                        # print the absolute bundle root (self-located, bypass-safe)
 *   tpm doc <bundle-relative-path>  # print a bundle doc with ${TPM_HOME}/%TPM_HOME% resolved
 *   tpm --help | -h
 *
 *   e.g.  npx tpm session notes resume --where "…" --next "…"
 *         npx tpm workflow scaffold add-phase dev/<epic> --slug <slug>
 *         npx tpm install .
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

// suite -> its router script (relative to this file's dir). The top dispatcher knows ONLY these.
const SUITES = {
  session: 'session/tpm-session-router.js',
  task: 'task/tpm-task-router.js',
  workflow: 'workflow/tpm-workflow-router.js',
  hooks: 'hooks/tpm-hooks-router.js',
};

// flat top-level verbs — NOT suites; they map straight to a script. Two groups: consumer-adoption
// porcelain (install/uninstall/doctor) and the self-locating bundle primitives (home/doc), the
// bypass-safe way skills/tools/users resolve the bundle path + read bundle docs (session 019 redesign).
const ALIASES = {
  install: 'consumer/tpm-consumer-install.js',
  uninstall: 'consumer/tpm-consumer-uninstall.js',
  doctor: 'consumer/tpm-consumer-install.js', // read-only health check = `install --check`
  home: 'tpm-home.js',                         // print the absolute bundle root (self-located)
  doc: 'tpm-doc.js',                           // print a bundle doc with ${TPM_HOME}/%TPM_HOME% resolved
};

// Fixed trailing args a porcelain alias injects — `doctor` IS `install --check`, so the dispatcher
// appends --check after whatever the user passed (e.g. `tpm doctor ../proj` → `install ../proj --check`).
const ALIAS_EXTRA = {
  doctor: ['--check'],
};

function help() {
  console.log(`tpm — claude-tpm command dispatcher

Usage:
  tpm <suite> <verb> [args…]

Suites:
  session    session-notes tooling   (config / current / notes / review)
  task       task ledger             (add / list / show / … / config)
  workflow   multi-agent rounds      (audit / compose / lint / scaffold / cost / signoff / doctor / config)
  hooks      PreToolUse hooks        (gate-spawn / expand-tpm-home)

Consumer adoption:
  install [dir] [options]     graft claude-tpm onto an existing project
  uninstall [dir] [options]   reverse it (asks: this project only, or the whole system)
  doctor [dir]                read-only health check (= install --check)

Bundle primitives (self-locating; work in every permission mode):
  home                        print the absolute bundle root
  doc <bundle-relative-path>  print a bundle doc with \${TPM_HOME}/%TPM_HOME% resolved

  tpm <suite> --help          list that suite's verbs
  tpm --help, -h              show this message

Everything after the suite is passed straight through, e.g.:
  npx tpm session notes resume --where "…" --next "…"
  npx tpm install .`);
}

function main(argv) {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    help();
    return 0;
  }

  const cmd = args[0];
  const rel = SUITES[cmd] || ALIASES[cmd];
  if (!rel) {
    process.stderr.write(`tpm: unknown command '${cmd}'.\n\n`);
    help();
    return 2;
  }

  // Dumb forward: hand the suite router (or aliased script) EVERYTHING after the suite/alias token,
  // plus any fixed trailing args a porcelain alias injects (e.g. doctor → install … --check).
  const tool = path.join(__dirname, rel);
  const extra = ALIAS_EXTRA[cmd] || [];
  const r = spawnSync('node', [tool, ...args.slice(1), ...extra], { stdio: 'inherit' });
  if (r.error) {
    process.stderr.write(`tpm: failed to run '${cmd}': ${r.error.message}\n`);
    return 1;
  }
  return r.status == null ? 1 : r.status; // propagate child exit code (null => killed by signal)
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { main, SUITES, ALIASES, ALIAS_EXTRA };
