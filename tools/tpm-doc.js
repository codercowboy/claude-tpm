#!/usr/bin/env node
/**
 * tpm-doc.js — `tpm doc <bundle-relative-path>`: print a bundle doc with the home token resolved.
 *
 * PURPOSE
 *   The bypass-safe replacement for `Read %TPM_HOME%/...` inside skills (session 019 redesign, 2nd
 *   piece). It self-locates the bundle (via tpm-home's `bundleRoot()` — ONE self-location impl),
 *   reads <bundle>/<relpath>, substitutes the home token (${TPM_HOME} / %TPM_HOME%) in the CONTENT with
 *   the absolute bundle root, and prints to stdout. Because it resolves the token ITSELF — no hook, no
 *   permission channel — it works under `--dangerously-skip-permissions` and even when a skill reads it
 *   via Bash, killing the fragility class the PreToolUse path-hook had. Skills call this INSTEAD of
 *   `Read %TPM_HOME%/<relpath>` (the #1098 skill-migration).
 *
 * CONTAINMENT: the relpath must resolve INSIDE the bundle — a `../`-escape or absolute path is refused
 *   (exit 2), so `tpm doc` can only ever surface bundle docs.
 *
 * USAGE
 *   tpm doc claude-context/methodology/orchestrator/reading-list.md
 *   tpm doc <relpath>     # exit 0 = printed · 1 = unreadable/missing file · 2 = usage / escapes bundle
 *   tpm doc --help|-h
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { bundleRoot } = require('./tpm-home.js');

// The bundle-home token in two spellings: `${TPM_HOME}` (today's on-disk form) and `%TPM_HOME%` (the
// shell-safe respelling, #1102). Both resolve to the absolute bundle root. split/join = literal replace.
const TOKENS = ['${TPM_HOME}', '%TPM_HOME%'];

function resolveContent(content, root) {
  let s = content;
  for (const tok of TOKENS) s = s.split(tok).join(root);
  return s;
}

function main(argv) {
  const args = argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h') {
    console.log('tpm doc <bundle-relative-path> — print a bundle doc with ${TPM_HOME}/%TPM_HOME% resolved to the bundle root');
    return 0;
  }
  const rel = args[0];
  if (!rel) {
    process.stderr.write('tpm doc: missing <bundle-relative-path>\n');
    return 2;
  }

  const root = bundleRoot();
  const abs = path.resolve(root, rel);
  // Containment: the resolved target must stay under the bundle root (no `..`/absolute escape).
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    process.stderr.write(`tpm doc: '${rel}' resolves outside the bundle root — refused\n`);
    return 2;
  }

  let content;
  try { content = fs.readFileSync(abs, 'utf8'); }
  catch (e) { process.stderr.write(`tpm doc: cannot read '${rel}' under the bundle (${e.code || e.message})\n`); return 1; }

  process.stdout.write(resolveContent(content, root));
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { resolveContent, main };
