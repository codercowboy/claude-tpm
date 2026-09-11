#!/usr/bin/env node
/**
 * lib/config.js — the `tasks` config-section resolver (checklist A3 / build-plan Wave 1).
 *
 * PURPOSE
 *   A minimal, SUITE-LOCAL resolver for the `tasks` section of a project's
 *   `.claude/claude-tpm/config.json` (config-guide §3). Reads the config file if present,
 *   merges its `tasks` section over built-in defaults, and hands back the fully resolved
 *   registry so every tools/task/* script AND the tpm-task skill read the SAME 12 keys the
 *   SAME way. Mirrors the structure of tools/session/lib/config.js but scoped to `tasks` —
 *   per tool-conventions.md Part I §2 (portability) this does NOT require() any shared
 *   config-resolver; it is a small, deliberately-duplicated copy of just what this suite needs.
 *
 *   Absent config file, or an absent `tasks` key, is NOT an error — it means "use the
 *   defaults" (system ON). A malformed config file resolves to defaults + a stderr warning
 *   (never a crash) — matching the module's lenient philosophy. An EXPLICIT --config path that
 *   does not exist IS a friendly error + exit 1.
 *
 * RESOLVED SHAPE (defaults shown — spec §9)
 *   {
 *     enabled: true,
 *     tasksDir: ".claude/claude-tpm/tasks",
 *     startId: 1000,
 *     bucketSize: 1000,
 *     defaultOrder: "newest",
 *     defaultListState: ["open", "in-progress"],
 *     timezone: "local",
 *     exportDir: "tmp",
 *     allowHardDelete: true,
 *     maxOpenWarn: 50,
 *     autoConfirm: { finish: false, drop: false },
 *     minimalTasks: false,
 *     subtaskStyle: "letters"
 *   }
 *
 * CLI
 *   --config <path>    Optional. Default: <projectRoot>/.claude/claude-tpm/config.json, where
 *                       <projectRoot> is found by walking up from cwd for a CLAUDE.md marker.
 *                       A default location that doesn't exist resolves to defaults, not an
 *                       error. An EXPLICIT --config path that doesn't exist IS an error + exit 1.
 *   --json             Print the resolved `tasks` config as JSON.
 *   --get <dotted.key> Print one resolved value, e.g. --get autoConfirm.finish
 *   --tasks-dir        Shortcut for the resolved tasksDir as a bare ABSOLUTE path (no JSON
 *                       quoting) — convenient for the skill/other scripts to consume.
 *   --help             Usage.
 *
 * REUSABLE API (also a module)
 *   resolveTasksConfig(configPathArg, opts) -> { resolved, projectRoot, configPath, configExists, warning }
 *   getDefaults() -> the built-in tasks defaults (deep-cloned)
 *   tasksDirAbs(resolved, projectRoot) -> absolute path to the resolved tasksDir
 *   getDotted(obj, key) -> { found, value }
 *
 * EXAMPLES
 *   node lib/config.js --json
 *   node lib/config.js --get startId
 *   node lib/config.js --tasks-dir
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { findRoot } = require('./paths');

function getDefaults() {
  return {
    enabled: true,
    tasksDir: '.claude/claude-tpm/tasks',
    startId: 1000,
    bucketSize: 1000,
    defaultOrder: 'newest',
    defaultListState: ['open', 'in-progress'],
    timezone: 'local',
    exportDir: 'tmp',
    allowHardDelete: true,
    maxOpenWarn: 50,
    autoConfirm: { finish: false, drop: false },
    minimalTasks: false,
    subtaskStyle: 'letters',
  };
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Merge a parsed config.json's `tasks` section over the built-in defaults (lenient). */
function mergeTasksConfig(rawTasks) {
  const defaults = getDefaults();
  if (!isPlainObject(rawTasks)) return defaults;

  const resolved = deepClone(defaults);

  if (typeof rawTasks.enabled === 'boolean') resolved.enabled = rawTasks.enabled;
  if (typeof rawTasks.tasksDir === 'string' && rawTasks.tasksDir) resolved.tasksDir = rawTasks.tasksDir;
  if (Number.isInteger(rawTasks.startId) && rawTasks.startId >= 0) resolved.startId = rawTasks.startId;
  if (Number.isInteger(rawTasks.bucketSize) && rawTasks.bucketSize > 0) resolved.bucketSize = rawTasks.bucketSize;
  if (typeof rawTasks.defaultOrder === 'string' && rawTasks.defaultOrder) resolved.defaultOrder = rawTasks.defaultOrder;
  if (Array.isArray(rawTasks.defaultListState) && rawTasks.defaultListState.every((s) => typeof s === 'string')) {
    resolved.defaultListState = rawTasks.defaultListState.slice();
  }
  if (typeof rawTasks.timezone === 'string' && rawTasks.timezone) resolved.timezone = rawTasks.timezone;
  if (typeof rawTasks.exportDir === 'string' && rawTasks.exportDir) resolved.exportDir = rawTasks.exportDir;
  if (typeof rawTasks.allowHardDelete === 'boolean') resolved.allowHardDelete = rawTasks.allowHardDelete;
  if (Number.isInteger(rawTasks.maxOpenWarn) && rawTasks.maxOpenWarn >= 0) resolved.maxOpenWarn = rawTasks.maxOpenWarn;
  if (isPlainObject(rawTasks.autoConfirm)) {
    if (typeof rawTasks.autoConfirm.finish === 'boolean') resolved.autoConfirm.finish = rawTasks.autoConfirm.finish;
    if (typeof rawTasks.autoConfirm.drop === 'boolean') resolved.autoConfirm.drop = rawTasks.autoConfirm.drop;
  }
  if (typeof rawTasks.minimalTasks === 'boolean') resolved.minimalTasks = rawTasks.minimalTasks;
  if (rawTasks.subtaskStyle === 'letters' || rawTasks.subtaskStyle === 'numbers') {
    resolved.subtaskStyle = rawTasks.subtaskStyle;
  }

  return resolved;
}

/**
 * Locate, read, and resolve config.json's `tasks` section.
 * @param {string|undefined} configPathArg explicit --config value, or undefined for default
 * @param {object} [opts]
 * @param {string} [opts.startDir] where to start walking up for the project root
 * @returns {{resolved, projectRoot, configPath, configExists, warning}}
 */
function resolveTasksConfig(configPathArg, opts = {}) {
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
    return { resolved: getDefaults(), projectRoot, configPath, configExists: false, warning: null };
  }

  let parsed;
  let warning = null;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    // Malformed config is NOT fatal — fall back to defaults with a warning (lenient philosophy).
    warning = `could not parse ${configPath} as JSON (${err.message}); using built-in defaults.`;
    return { resolved: getDefaults(), projectRoot, configPath, configExists: true, warning };
  }

  const resolved = mergeTasksConfig(parsed.tasks);
  return { resolved, projectRoot, configPath, configExists: true, warning };
}

/** Absolute path to the resolved tasksDir, relative to projectRoot if not already absolute. */
function tasksDirAbs(resolved, projectRoot) {
  const dir = (resolved && resolved.tasksDir) || getDefaults().tasksDir;
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
      'Usage: node lib/config.js [--config <path>] (--json | --get <dotted.key> | --tasks-dir) [--help]',
      '',
      "Resolves the 'tasks' section of a claude-tpm config.json over built-in defaults.",
      '',
      'Flags:',
      '  --config <path>     Path to config.json. Default: <projectRoot>/.claude/claude-tpm/config.json',
      '  --json               Print the resolved tasks config as JSON.',
      '  --get <dotted.key>   Print one resolved value, e.g. --get autoConfirm.finish',
      '  --tasks-dir           Print the resolved tasksDir as a bare absolute path.',
      '  --help                Show this message.',
      '',
      'Examples:',
      '  node lib/config.js --json',
      '  node lib/config.js --get startId',
      '  node lib/config.js --tasks-dir',
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
    else if (a === '--tasks-dir') args.tasksDir = true;
    else if (a === '--get') { args.get = argv[i + 1]; i += 1; }
    else if (a === '--config') { args.config = argv[i + 1]; i += 1; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (!args.json && !args.get && !args.tasksDir) {
    process.stderr.write('lib/config.js: nothing to do — pass one of --json / --get / --tasks-dir.\n\n');
    printHelp();
    process.exit(1);
  }

  let resolution;
  try {
    resolution = resolveTasksConfig(args.config);
  } catch (err) {
    process.stderr.write(`config: ${err.message}\n`);
    process.exit(1);
  }

  const { resolved, projectRoot, warning } = resolution;
  if (warning) process.stderr.write(`config: ${warning}\n`);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
    process.exit(0);
  }

  if (args.tasksDir) {
    process.stdout.write(`${tasksDirAbs(resolved, projectRoot)}\n`);
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
  resolveTasksConfig,
  mergeTasksConfig,
  getDefaults,
  tasksDirAbs,
  getDotted,
};
