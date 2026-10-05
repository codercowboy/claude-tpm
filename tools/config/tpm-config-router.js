#!/usr/bin/env node
'use strict';
/**
 * tpm-config-router.js — the `config` suite: user/skill porcelain over the shared layered-config overlay.
 *
 * PURPOSE
 *   `tpm config` lets a human or a skill READ the resolved claude-tpm config (across all sections) and
 *   WRITE a single value into a chosen layer, without hand-editing JSON. It calls the same in-process
 *   overlay lib (tools/lib/tpm-config-overlay.js) the per-suite resolvers call — the CLI is the porcelain,
 *   the function call is the plumbing (decision: `tpm config` wiring). Wired as a SUITE in tools/tpm.js.
 *
 * VERBS
 *   config get  <path> [--layer defaults|project|user] [--config <file>]
 *       Print one resolved value (JSON). Without --layer: the OVERLAID value (defaults -> project ->
 *       $CLAUDE_TPM_USER_CONFIG, user wins). With --layer: that single layer's value at <path>.
 *       <path> is dotted and may index arrays: `workflow.subagentConfigs[1].name`, `tasks.defaultListState[0]`.
 *   config set  <path> <value> [--user | --default] [--config <file>]
 *       Write <value> into a layer's RAW file (comments + sibling keys round-trip), creating it if absent.
 *       <value> is coerced: true/false/numbers/JSON literals parse; anything else stays a string.
 *       Layer: no flag = the PROJECT config.json; --user = $CLAUDE_TPM_USER_CONFIG; --default = the shipped
 *       tools/config/defaults.json. `<path>` supports `name[i]` (set element i) and `name[+]` (append).
 *       ⚠ --default edits the INSTALL-GLOBAL shipped defaults file and can clobber shipped defaults for
 *          every project using this bundle — use it deliberately.
 *   config list [--config <file>]         Print the whole resolved config (comment-stripped) as JSON.
 *   config --help                          This message.
 *
 * NOTE (workflow charterFile): `config get workflow.subagentConfigs[i].charterFile` reports the stored
 *   BUNDLE-RELATIVE path (the generic overlay does not apply workflow's absolutize transform). The
 *   absolute path a workflow consumer sees comes from `tpm workflow config --get subagentConfigs.1.charterFile` (or `--json`).
 *
 * PROJECT ROOT: resolved like every tpm tool — $TPM_PROJECT_ROOT, else walk up from cwd for the
 *   `.claude/claude-tpm/` marker (docs/config-guide.md "Which project a tool works on"). `--config <file>`
 *   names the project config.json explicitly.
 *
 * Zero third-party deps; Node built-ins + the shared overlay lib + lib/paths only. `node <file> --help`.
 */

const path = require('path');
const { findRoot } = require('../lib/paths');
const overlay = require('../lib/tpm-config-overlay');

function printHelp() {
  process.stdout.write(
    [
      'Usage: tpm config <get|set|list> [...] [--help]',
      '',
      'Read + write the layered claude-tpm config (defaults.json -> project config.json -> $CLAUDE_TPM_USER_CONFIG).',
      '',
      'Verbs:',
      '  get <path> [--layer defaults|project|user] [--config <file>]',
      '      Print one value as JSON. No --layer = the overlaid value; --layer = that one layer.',
      '      <path> is dotted and may index arrays, e.g. workflow.subagentConfigs[1].name',
      '  set <path> <value> [--user|--default] [--config <file>]',
      '      Write <value> into a layer (no flag = project config.json; --user = $CLAUDE_TPM_USER_CONFIG;',
      '      --default = the shipped defaults.json). <value> is JSON-coerced. <path> supports name[i]/name[+].',
      '      WARNING: --default edits the install-global shipped defaults file (clobbers shipped defaults).',
      '  list [--config <file>]   Print the whole resolved config as JSON.',
      '  --help                   Show this message.',
      '',
      'Examples:',
      '  tpm config get session.notes.sessionsDir',
      '  tpm config get workflow.verifyLoopCap --layer defaults',
      '  tpm config set tasks.maxOpenWarn 100',
      '  tpm config set tasks.defaultListState[+] done --user',
      '  tpm config list',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--user') args.user = true;
    else if (a === '--default') args.default = true;
    else if (a === '--layer') { args.layer = argv[i + 1]; i += 1; }
    else if (a === '--config') { args.config = argv[i + 1]; i += 1; }
    else args._.push(a);
  }
  return args;
}

function resolveProjectRoot() {
  // Standard precedence: $TPM_PROJECT_ROOT, else walk up from cwd for the `.claude/claude-tpm/` marker.
  return findRoot({});
}

function layerFromFlags(args) {
  if (args.user) return 'user';
  if (args.default) return 'default';
  if (args.layer) return args.layer;
  return null;
}

function doGet(args) {
  const dotted = args._[1];
  if (!dotted) { process.stderr.write('config get: a <path> is required.\n'); return 1; }
  const projectRoot = resolveProjectRoot();
  const opts = { projectRoot, projectConfigPath: args.config && path.resolve(args.config) };
  const layer = layerFromFlags(args);
  let view;
  try {
    view = layer ? overlay.readLayer(layer, opts) : overlay.resolveLayers(opts);
  } catch (err) {
    process.stderr.write(`config: ${err.message}\n`);
    return 1;
  }
  if (view === undefined) {
    process.stderr.write(`config: no value at "${dotted}"${layer ? ` in the ${layer} layer` : ''}.\n`);
    return 1;
  }
  const { found, value } = overlay.getAtPath(view, dotted);
  if (!found) {
    process.stderr.write(`config: no value at "${dotted}"${layer ? ` in the ${layer} layer` : ''}.\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(value)}\n`);
  return 0;
}

function doSet(args) {
  const dotted = args._[1];
  const rawValue = args._[2];
  if (!dotted || rawValue === undefined) {
    process.stderr.write('config set: <path> and <value> are both required.\n');
    return 1;
  }
  const layer = args.user ? 'user' : (args.default ? 'default' : 'project');
  const value = overlay.coerce(rawValue);
  const projectRoot = layer === 'project' ? resolveProjectRoot() : undefined;
  try {
    const res = overlay.setLayer({
      path: dotted,
      value,
      layer,
      projectRoot,
      projectConfigPath: args.config && path.resolve(args.config),
    });
    process.stdout.write(`set ${res.path} = ${JSON.stringify(res.value)} in ${layer} layer (${res.file})\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`config: ${err.message}\n`);
    return 1;
  }
}

function doList(args) {
  const projectRoot = resolveProjectRoot();
  const opts = { projectRoot, projectConfigPath: args.config && path.resolve(args.config) };
  let resolved;
  try {
    resolved = overlay.resolveLayers(opts);
  } catch (err) {
    process.stderr.write(`config: ${err.message}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
  return 0;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args._.length === 0) {
    printHelp();
    return args.help ? 0 : 1;
  }
  const verb = args._[0];
  switch (verb) {
    case 'get': return doGet(args);
    case 'set': return doSet(args);
    case 'list': return doList(args);
    default:
      process.stderr.write(`config: unknown verb '${verb}'.\n\n`);
      printHelp();
      return 2;
  }
}

module.exports = { main, parseArgs };

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
