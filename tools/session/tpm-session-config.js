#!/usr/bin/env node
/**
 * tpm-session-config.js — the `session` config-section resolver (task A1).
 *
 * PURPOSE
 *   A minimal, SUITE-LOCAL resolver for the `session` section of a project's
 *   `.claude/claude-tpm/config.json`, per claude-context/config-guide.md §1. Reads the config
 *   file if present, merges it over built-in defaults, and hands back the fully resolved
 *   `session` registry so every tools/session/* script and the tpm-session skill read the
 *   SAME ~6 keys the SAME way. Mirrors the shape of tools/workflow/tpm-workflow-config-resolver.js but
 *   scoped to `session` only — per tool-conventions.md Part I §2 (portability), this does
 *   NOT `require()` tpm-workflow-config-resolver.js; it is a small, deliberately duplicated copy of just
 *   the parts this suite needs.
 *
 *   Absent config file, or an absent `session` key, is NOT an error — it means "use the
 *   defaults." A config that points at a file that doesn't exist is validated separately by
 *   the caller if it cares (this resolver has no --validate; the session section references
 *   no external files as of this build).
 *
 * RESOLVED SHAPE (defaults shown)
 *   {
 *     enabled: true,
 *     notes: { enabled: true, sessionsDir: "claude-context/sessions" },
 *     showTPMOpenMessage: true,
 *     showTPMCloseMessage: true,
 *     additionalOpenMessage: "",
 *     additionalCloseMessage: ""
 *   }
 *   NOTE — `notes.enabled` (nested) does not exist in the LIVE config-guide.md §1 yet; it is
 *   part of this build's staged fix (task E1, out/promote/config-guide-section1.md). This
 *   resolver already understands + defaults it so the tools/skill work correctly the moment
 *   the promoted config-guide + a project's own config.json catch up. A raw `session.enabled`
 *   boolean with no `notes` object still resolves fine (notes.enabled defaults true).
 *
 * CLI
 *   --config <path>   Optional. Defaults to <projectRoot>/.claude/claude-tpm/config.json,
 *                      where <projectRoot> is found by walking up from cwd for a CLAUDE.md
 *                      marker. A default location that doesn't exist resolves to defaults,
 *                      not an error. An EXPLICIT --config path that doesn't exist IS a
 *                      friendly error + exit 1.
 *   --json             Print the resolved `session` config as JSON.
 *   --get <dotted.key> Print one resolved value, e.g. --get notes.sessionsDir
 *   --sessions-dir     Shortcut for --get notes.sessionsDir, printed as a bare path (no
 *                      JSON quoting) — convenient for other scripts/shells to consume.
 *   --help             Usage.
 *
 * REUSABLE API (also a module)
 *   resolveSessionConfig(configPathArg, opts) -> { resolved, projectRoot, configPath, configExists }
 *   getDefaults() -> the built-in session defaults (deep-cloned)
 *   sessionsDirAbs(resolved, projectRoot) -> absolute path to the resolved sessionsDir
 *
 * EXAMPLES
 *   node tpm-session-config.js --json
 *   node tpm-session-config.js --get notes.sessionsDir
 *   node tpm-session-config.js --sessions-dir
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { findRoot } = require('./tpm-session-paths');

function getDefaults() {
  return {
    enabled: true,
    notes: { enabled: true, sessionsDir: 'claude-context/sessions' },
    showTPMOpenMessage: true,
    showTPMCloseMessage: true,
    additionalOpenMessage: '',
    additionalCloseMessage: '',
  };
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Merge a parsed config.json's `session` section over the built-in defaults. */
function mergeSessionConfig(rawSession) {
  const defaults = getDefaults();
  if (!isPlainObject(rawSession)) return defaults;

  const resolved = deepClone(defaults);

  if (typeof rawSession.enabled === 'boolean') resolved.enabled = rawSession.enabled;
  if (typeof rawSession.showTPMOpenMessage === 'boolean') {
    resolved.showTPMOpenMessage = rawSession.showTPMOpenMessage;
  }
  if (typeof rawSession.showTPMCloseMessage === 'boolean') {
    resolved.showTPMCloseMessage = rawSession.showTPMCloseMessage;
  }
  if (typeof rawSession.additionalOpenMessage === 'string') {
    resolved.additionalOpenMessage = rawSession.additionalOpenMessage;
  }
  if (typeof rawSession.additionalCloseMessage === 'string') {
    resolved.additionalCloseMessage = rawSession.additionalCloseMessage;
  }

  // Back-compat: a legacy/flat `sessionsDir` sitting directly on `session` (pre-nesting) is
  // honored as the notes.sessionsDir default before the nested `notes` object is applied.
  if (typeof rawSession.sessionsDir === 'string') {
    resolved.notes.sessionsDir = rawSession.sessionsDir;
  }

  if (isPlainObject(rawSession.notes)) {
    if (typeof rawSession.notes.enabled === 'boolean') {
      resolved.notes.enabled = rawSession.notes.enabled;
    }
    if (typeof rawSession.notes.sessionsDir === 'string') {
      resolved.notes.sessionsDir = rawSession.notes.sessionsDir;
    }
  }

  return resolved;
}

/**
 * Locate, read, and resolve config.json's `session` section.
 * @param {string|undefined} configPathArg explicit --config value, or undefined for default
 * @param {object} [opts]
 * @param {string} [opts.startDir] where to start walking up for the project root
 * @returns {{resolved: object, projectRoot: string, configPath: string, configExists: boolean}}
 */
function resolveSessionConfig(configPathArg, opts = {}) {
  const startDir = opts.startDir || process.cwd();
  const projectRoot = findRoot({ startDir, marker: 'CLAUDE.md' });
  const usedDefaultLocation = !configPathArg;
  const configPath = configPathArg
    ? path.resolve(configPathArg)
    : path.join(projectRoot, '.claude', 'claude-tpm', 'config.json');

  const configExists = fs.existsSync(configPath);

  if (!configExists) {
    if (!usedDefaultLocation) {
      const err = new Error(`--config path does not exist: ${configPath}`);
      err.code = 'ENOENT_CONFIG';
      throw err;
    }
    return { resolved: getDefaults(), projectRoot, configPath, configExists: false };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    const wrapped = new Error(`could not parse ${configPath} as JSON: ${err.message}`);
    wrapped.code = 'EBADJSON';
    throw wrapped;
  }

  const resolved = mergeSessionConfig(parsed.session);
  return { resolved, projectRoot, configPath, configExists: true };
}

/** Absolute path to the resolved sessionsDir, relative to projectRoot if not already absolute. */
function sessionsDirAbs(resolved, projectRoot) {
  const dir = (resolved && resolved.notes && resolved.notes.sessionsDir) || getDefaults().notes.sessionsDir;
  return path.isAbsolute(dir) ? dir : path.join(projectRoot, dir);
}

function getDotted(obj, dottedKey) {
  const parts = dottedKey.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || !(p in cur)) {
      return { found: false, value: undefined };
    }
    cur = cur[p];
  }
  return { found: true, value: cur };
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: node tpm-session-config.js [--config <path>] (--json | --get <dotted.key> | --sessions-dir) [--help]',
      '',
      "Resolves the 'session' section of a claude-tpm config.json over built-in defaults.",
      '',
      'Flags:',
      '  --config <path>     Path to config.json. Default: <projectRoot>/.claude/claude-tpm/config.json',
      '  --json               Print the resolved session config as JSON.',
      '  --get <dotted.key>   Print one resolved value, e.g. --get notes.sessionsDir',
      '  --sessions-dir        Print the resolved sessionsDir as a bare absolute path.',
      '  --help                Show this message.',
      '',
      'Examples:',
      '  node tpm-session-config.js --json',
      '  node tpm-session-config.js --get notes.enabled',
      '  node tpm-session-config.js --sessions-dir',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--json') args.json = true;
    else if (a === '--sessions-dir') args.sessionsDir = true;
    else if (a === '--get') {
      args.get = argv[i + 1];
      i += 1;
    } else if (a === '--config') {
      args.config = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (!args.json && !args.get && !args.sessionsDir) {
    process.stderr.write('tpm-session-config.js: nothing to do — pass one of --json / --get / --sessions-dir.\n\n');
    printHelp();
    process.exit(1);
  }

  let resolution;
  try {
    resolution = resolveSessionConfig(args.config);
  } catch (err) {
    process.stderr.write(`config: ${err.message}\n`);
    process.exit(1);
  }

  const { resolved, projectRoot } = resolution;

  if (args.json) {
    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
    process.exit(0);
  }

  if (args.sessionsDir) {
    process.stdout.write(`${sessionsDirAbs(resolved, projectRoot)}\n`);
    process.exit(0);
  }

  if (args.get) {
    const { found, value } = getDotted(resolved, args.get);
    if (!found) {
      process.stderr.write(`config: no such key "${args.get}" in resolved config.\n`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify(value)}\n`);
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  resolveSessionConfig,
  mergeSessionConfig,
  getDefaults,
  sessionsDirAbs,
  getDotted,
};
