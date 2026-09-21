#!/usr/bin/env node
/**
 * tpm-home.js — `tpm home`: print the absolute claude-tpm bundle root.
 *
 * PURPOSE
 *   The foundational primitive of the %TPM_HOME% resolution redesign (session 019). It self-locates the
 *   vendored bundle from its OWN location and prints the absolute path — no env var, no hook, no
 *   permission channel — so it works IDENTICALLY in every permission mode, including
 *   `--dangerously-skip-permissions` (unlike the retired PreToolUse path-hook, whose rewrite rode the
 *   permission-allow channel that bypass skips). Skills, tools, and humans use it to resolve the bundle
 *   location deterministically; `tpm doc` builds on the exported `bundleRoot()`.
 *
 *   SELF-LOCATION: this file lives at <bundle>/tools/tpm-home.js, so up-1 dir = the bundle root —
 *   correct whether the bundle is claude-tpm itself or a vendored node_modules/@codercowboy/claude-tpm/.
 *   (TPM_HOME_OVERRIDE exists only so a unit test can pin a synthetic root.)
 *
 * USAGE
 *   tpm home            # → prints the absolute bundle root, exit 0
 *   tpm home --help|-h
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Self-locate: <bundle>/tools/tpm-home.js → up 1 = <bundle>. realpath resolves a vendored symlink to the
// true bundle; if it fails (e.g. a synthetic override path that doesn't exist) keep the normalized path.
function bundleRoot() {
  let root = process.env.TPM_HOME_OVERRIDE || path.resolve(__dirname, '..');
  try { root = fs.realpathSync(root); } catch (_e) { /* leave normalized */ }
  return root;
}

function main(argv) {
  const args = argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h') {
    console.log('tpm home — print the absolute claude-tpm bundle root (self-located; works in every permission mode)');
    return 0;
  }
  process.stdout.write(bundleRoot() + '\n');
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { bundleRoot, main };
