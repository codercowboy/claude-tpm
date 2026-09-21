#!/usr/bin/env node
/**
 * tpm-hooks-router.js — the `hooks` sub-router for the `tpm` dispatcher.
 *
 * PURPOSE
 *   `tpm hooks <verb> [args…]` dispatches to a claude-tpm HOOK program (PreToolUse).
 *   This router OWNS
 *   the hook verb table; the top-level `tpm.js` forwards `hooks <anything…>` here without knowing the
 *   verbs (design: dev/tpm-cli-design.md §0). It exists so a plugin `hooks.json` can invoke a hook by
 *   a STABLE, path-independent command — `npx tpm hooks gate-spawn` — instead of hard-coding a deep
 *   `node "${CLAUDE_PLUGIN_ROOT}/tools/<suite>/hooks/<script>.js"` path that breaks whenever a script
 *   moves or is renamed.
 *
 *   The hook script still LIVES in its owning suite (gate-spawn under `workflow/`) — a workflow gate
 *   belongs to the workflow suite, and gate-spawn deep-requires its sibling `tpm-workflow-signoff.js`.
 *   This router does NOT relocate it; it only exposes it under one `hooks` verb table. The target runs
 *   from its OWN `__dirname`, so its relative requires and self-location keep resolving exactly as
 *   before. (The retired %TPM_HOME% resolution hooks were removed in #1126 — see docs/technical.md.)
 *
 *   HOOK CONTRACT PRESERVED: dispatch is by CHILD PROCESS with `stdio:'inherit'`, so the harness's
 *   PreToolUse payload on stdin flows straight to the hook, the hook's stdout (e.g. gate-spawn's
 *   decision JSON) flows straight back out, and the hook's EXIT CODE (0 = allow, 2 = block) propagates
 *   up through this router and `tpm.js` unchanged.
 *
 *   Sibling/relative scripts resolve against THIS file's dir (`__dirname`) — no `%TPM_HOME%`/env
 *   dependency.
 *
 * USAGE
 *   tpm hooks gate-spawn         # → workflow/hooks/tpm-workflow-gate-spawn.js  (PreToolUse: Agent|Task)
 *   tpm hooks --help | -h
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

// short verb -> the hook script, relative to THIS file's dir. Targets live in their owning suite.
const VERBS = {
  'gate-spawn': '../workflow/hooks/tpm-workflow-gate-spawn.js',
};

function help() {
  console.log(`tpm hooks — claude-tpm PreToolUse hook router

Usage:
  tpm hooks <verb> [args…]

Verbs:
  gate-spawn               block a tpm-workflow round spawn without a fresh kickoff  (PreToolUse: Agent|Task)

  tpm hooks --help, -h

This is a harness-invoked hook. A PreToolUse hook's exit code decides the tool's fate (0 = allow,
2 = block); the payload arrives on stdin and stdout flows back to the harness. Wire it from a plugin
hooks.json, e.g.:
  { "type": "command", "command": "npx tpm hooks gate-spawn" }`);
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
    process.stderr.write(`tpm hooks: unknown verb '${verb}'.\n\n`);
    help();
    return 2;
  }

  // Dumb forward: hand the hook script EVERYTHING after the verb. stdio:'inherit' preserves the
  // PreToolUse stdin payload, the hook's stdout, and its exit code (0=allow / 2=block).
  const tool = path.join(__dirname, rel);
  const r = spawnSync('node', [tool, ...args.slice(1)], { stdio: 'inherit' });
  if (r.error) {
    process.stderr.write(`tpm hooks: failed to run '${verb}': ${r.error.message}\n`);
    return 1;
  }
  return r.status == null ? 1 : r.status; // propagate child exit (null => killed by signal)
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { main, VERBS };
