#!/usr/bin/env node
/**
 * tpm-session-config.js — the `session` config-section resolver (task A1).
 *
 * PURPOSE
 *   A minimal, SUITE-LOCAL resolver for the `session` section of a project's
 *   `.claude/claude-tpm/config.json`, per docs/config-guide.md §1. Reads the config
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
 *     notes: { enabled: true, sessionsDir: ".claude/claude-tpm/sessions" },
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
 *   --modules          Print the ENABLED-state map of every claude-tpm module as JSON
 *                      ({ session, workflow, tasks, hygiene }), for the boot MOTD's
 *                      "list only the ENABLED tpm-* modules" step. This is a cross-cutting
 *                      READ of the top-level `<module>.enabled` booleans ONLY (every module
 *                      is ON by default) — it does NOT resolve or require() any other suite's
 *                      config, so it keeps this resolver suite-local per tool-conventions I§2.
 *   --help             Usage.
 *
 * REUSABLE API (also a module)
 *   resolveSessionConfig(configPathArg, opts) -> { resolved, projectRoot, configPath, configExists }
 *   readModuleEnablement(configPathArg, opts) -> { modules, projectRoot, configPath, configExists }
 *   getDefaults() -> the built-in session defaults (deep-cloned)
 *   sessionsDirAbs(resolved, projectRoot) -> absolute path to the resolved sessionsDir
 *
 * EXAMPLES
 *   npx tpm session config --json
 *   npx tpm session config --get notes.sessionsDir
 *   npx tpm session config --sessions-dir
 *   npx tpm session config --modules
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { findRoot } = require('./tpm-session-paths');

// The claude-tpm modules that carry a top-level `<module>.enabled` flag in config.json.
// Every module is ON by default (config-guide.md §"Turning a module OFF"): an absent section,
// an absent `enabled` key, or a non-boolean value all resolve to `true`.
const KNOWN_MODULES = ['session', 'workflow', 'tasks', 'hygiene'];

function getDefaults() {
  return {
    enabled: true,
    notes: { enabled: true, sessionsDir: '.claude/claude-tpm/sessions' },
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

/**
 * Report which claude-tpm modules are ENABLED — the map the boot MOTD needs so it lists only
 * the enabled `tpm-*` modules (modes-open.md steps 2 + 5). Reads ONLY the top-level
 * `<module>.enabled` booleans (defaulting `true`); it does not resolve any other suite's full
 * config or `require()` another resolver, so it stays suite-local (tool-conventions I§2).
 *
 * Lenient by design so a broken config never crashes boot:
 *   - default config location absent   -> every module enabled (defaults)
 *   - EXPLICIT --config path absent     -> throws ENOENT_CONFIG (same rule as resolveSessionConfig)
 *   - config present but invalid JSON   -> every module enabled + a stderr warning (no throw;
 *                                          it is the doctor/`install.js --check` that FLAGS a
 *                                          malformed config, not this boot-time reader).
 *
 * @param {string|undefined} configPathArg explicit --config value, or undefined for default
 * @param {object} [opts]
 * @param {string} [opts.startDir] where to start walking up for the project root
 * @param {(msg:string)=>void} [opts.warn] sink for the malformed-JSON warning (default: stderr)
 * @returns {{modules: Record<string,boolean>, projectRoot: string, configPath: string, configExists: boolean}}
 */
function readModuleEnablement(configPathArg, opts = {}) {
  const startDir = opts.startDir || process.cwd();
  const projectRoot = findRoot({ startDir, marker: 'CLAUDE.md' });
  const usedDefaultLocation = !configPathArg;
  const configPath = configPathArg
    ? path.resolve(configPathArg)
    : path.join(projectRoot, '.claude', 'claude-tpm', 'config.json');

  const allEnabled = () => Object.fromEntries(KNOWN_MODULES.map((m) => [m, true]));

  const configExists = fs.existsSync(configPath);
  if (!configExists) {
    if (!usedDefaultLocation) {
      const err = new Error(`--config path does not exist: ${configPath}`);
      err.code = 'ENOENT_CONFIG';
      throw err;
    }
    return { modules: allEnabled(), projectRoot, configPath, configExists: false };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    const warn = opts.warn || ((m) => process.stderr.write(m));
    warn(`config: could not parse ${configPath} as JSON (${err.message}); assuming all modules enabled.\n`);
    return { modules: allEnabled(), projectRoot, configPath, configExists: true };
  }

  const modules = {};
  for (const m of KNOWN_MODULES) {
    const section = parsed[m];
    modules[m] =
      isPlainObject(section) && typeof section.enabled === 'boolean' ? section.enabled : true;
  }
  return { modules, projectRoot, configPath, configExists: true };
}

/** Absolute path to the resolved sessionsDir, relative to projectRoot if not already absolute. */
function sessionsDirAbs(resolved, projectRoot) {
  const dir = (resolved && resolved.notes && resolved.notes.sessionsDir) || getDefaults().notes.sessionsDir;
  return path.isAbsolute(dir) ? dir : path.join(projectRoot, dir);
}

/**
 * resolveSessionsDir(flagValue, configPathArg, opts) -> { sessionsDir, source, configPath }   (F4)
 *
 * The ONE store-dir resolver every session VERB uses so `--sessions-dir` can be OMITTED. Precedence:
 *   1. explicit `--sessions-dir` flag       (source: 'flag')    — always wins.
 *   2. the LOCAL project's config.json        (source: 'config') — a CLAUDE.md-marked project root
 *      whose `.claude/claude-tpm/config.json` exists; its `session.notes.sessionsDir` is used.
 *   3. FAIL LOUD                                                 — no flag AND no local project config.
 *
 * SAFETY (why `--sessions-dir` used to be mandatory): we NEVER silently fall back to a global/home/
 * live store. `findRoot` FALLS BACK to cwd when no CLAUDE.md marker is found, so a bare cwd that
 * merely happens to hold a stray config.json is NOT a project — the marker must be present (unless an
 * explicit `--config` was passed by hand).
 */
function resolveSessionsDir(flagValue, configPathArg, opts) {
  const options = opts || {};
  if (flagValue) return { sessionsDir: flagValue, source: 'flag', configPath: null };

  const res = resolveSessionConfig(configPathArg, options);   // throws ENOENT for an explicit missing --config
  const markerFound = configPathArg
    ? true
    : fs.existsSync(path.join(res.projectRoot, 'CLAUDE.md'));
  if (res.configExists && markerFound) {
    return { sessionsDir: sessionsDirAbs(res.resolved, res.projectRoot), source: 'config', configPath: res.configPath };
  }
  const err = new Error(
    '--sessions-dir is required: pass --sessions-dir <dir>, or set "session": { "notes": ' +
    '{ "sessionsDir": … } } in a local .claude/claude-tpm/config.json (refusing to default to a live store).',
  );
  err.storeResolveFail = true;
  throw err;
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
      'Usage: npx tpm session config [--config <path>] (--json | --get <dotted.key> | --sessions-dir | --modules) [--help]',
      '',
      "Resolves the 'session' section of a claude-tpm config.json over built-in defaults.",
      '',
      'Flags:',
      '  --config <path>     Path to config.json. Default: <projectRoot>/.claude/claude-tpm/config.json',
      '  --json               Print the resolved session config as JSON.',
      '  --get <dotted.key>   Print one resolved value, e.g. --get notes.sessionsDir',
      '  --sessions-dir        Print the resolved sessionsDir as a bare absolute path.',
      '  --modules             Print the ENABLED-state map of every module as JSON (session/workflow/tasks/hygiene).',
      '  --help                Show this message.',
      '',
      'Examples:',
      '  npx tpm session config --json',
      '  npx tpm session config --get notes.enabled',
      '  npx tpm session config --sessions-dir',
      '  npx tpm session config --modules',
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
    else if (a === '--modules') args.modules = true;
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

  if (!args.json && !args.get && !args.sessionsDir && !args.modules) {
    process.stderr.write('tpm session config: nothing to do — pass one of --json / --get / --sessions-dir / --modules.\n\n');
    printHelp();
    process.exit(1);
  }

  // --modules is a cross-cutting enablement read; handle it BEFORE resolveSessionConfig so a
  // malformed config stays LENIENT here (boot must not crash) rather than throwing EBADJSON.
  if (args.modules) {
    let out;
    try {
      out = readModuleEnablement(args.config);
    } catch (err) {
      process.stderr.write(`config: ${err.message}\n`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify(out.modules, null, 2)}\n`);
    process.exit(0);
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
  resolveSessionsDir,
  readModuleEnablement,
  mergeSessionConfig,
  getDefaults,
  sessionsDirAbs,
  getDotted,
  KNOWN_MODULES,
};
