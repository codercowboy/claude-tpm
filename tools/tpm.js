#!/usr/bin/env node
/**
 * tpm.js — the `tpm` convenience bin: a top-level ROUTER for claude-tpm's tooling.
 *
 * PURPOSE
 *   One entry point, git-style: `tpm <command> [args…]` dispatches to the right tool suite so
 *   consumers don't hand-type `node node_modules/@codercowboy/claude-tpm/tools/<suite>/<tool>.js`.
 *   Installed as the package's `bin`, so `npx tpm …` (or a linked `tpm`) works from any consumer.
 *
 *   Right now this is a HELLO-WORLD skeleton — it establishes the entry point and the routing shape;
 *   real subcommands get wired in as the routing table fills out.
 *
 * USAGE
 *   tpm                 # say hello
 *   tpm --help | -h     # show this message
 */

'use strict';

function help() {
  console.log(`tpm — claude-tpm command router

Usage:
  tpm                 say hello (skeleton)
  tpm --help, -h      show this message

(routing table coming soon — this bin will dispatch to the tool suites git-style)`);
}

function main(argv) {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    help();
    return 0;
  }

  console.log('hello world');
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { main };
