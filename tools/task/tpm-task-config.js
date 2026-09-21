#!/usr/bin/env node
'use strict';
/**
 * tpm-task-config.js — the `tasks` config-section resolver (P06 port; governs the #1109 history gate).
 *
 * PURPOSE
 *   A minimal, SUITE-LOCAL resolver for the `tasks` section of a project's
 *   `.claude/claude-tpm/config.json`. Reads the config file if present, merges its `tasks` section
 *   over built-in defaults, and hands back the fully resolved registry so every task tool AND the
 *   tpm-task skill read the same keys the same way. Near-verbatim port of
 *   `../../../claude-tpm/tools/task/tpm-task-config.js`, with TWO deltas for the JSON-first rework:
 *     1. `findRoot` now comes from the shared base lib via `./lib/base` (paths #1058), NOT the
 *        retired `./tpm-task-paths`.
 *     2. a new `history: { enabled: true }` key — the #1109 history gate the JSON model reads
 *        (`tpm-task.js` calls `model.setHistoryEnabled(resolved.history.enabled)`).
 *
 *   Absent config file, or an absent `tasks` key, is NOT an error — it means "use the defaults"
 *   (system ON, history ON). A malformed config resolves to defaults + a stderr warning (never a
 *   crash). An EXPLICIT --config path that does not exist IS a friendly error + exit 1.
 *
 * CLI
 *   --config <path>    Optional. Default: <projectRoot>/.claude/claude-tpm/config.json.
 *   --json             Print the resolved `tasks` config as JSON.
 *   --get <dotted.key> Print one resolved value, e.g. --get history.enabled
 *   --tasks-dir        Print the resolved tasksDir as a bare absolute path.
 *   --help             Usage.
 *
 * REUSABLE API (also a module)
 *   resolveTasksConfig(configPathArg, opts) -> { resolved, projectRoot, configPath, configExists, warning }
 *   getDefaults() -> the built-in tasks defaults (deep-cloned)
 *   tasksDirAbs(resolved, projectRoot) -> absolute path to the resolved tasksDir
 *   getDotted(obj, key) -> { found, value }
 *
 * Zero third-party deps; Node built-ins only; loadable via `node tpm-task-config.js --help`.
 */

const fs = require('fs');
const path = require('path');
const base = require('./lib/base');
const { findRoot } = base.paths;

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
    allowHardDelete: false,   // #1086: OFF/safe by default — `remove --hard` refuses unless opt-in true.
    maxOpenWarn: 50,
    autoConfirm: { finish: false, drop: false },
    minimalTasks: false,
    subtaskStyle: 'letters',
    history: { enabled: true },   // #1109 history gate — ON by default (P06)
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
  // #1109 history gate: accept either { history: { enabled: bool } } or a bare boolean `history`.
  if (isPlainObject(rawTasks.history)) {
    if (typeof rawTasks.history.enabled === 'boolean') resolved.history.enabled = rawTasks.history.enabled;
  } else if (typeof rawTasks.history === 'boolean') {
    resolved.history.enabled = rawTasks.history;
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
function resolveTasksConfig(configPathArg, opts) {
  const options = opts || {};
  const startDir = options.startDir || process.cwd();
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

/**
 * resolveTasksDir(flagValue, configPathArg, opts) -> { tasksDir, source, configPath }   (F4)
 *
 * The ONE store-dir resolver every task VERB uses so `--tasks-dir` can be OMITTED. Precedence:
 *   1. explicit `--tasks-dir` flag        (source: 'flag')      — always wins.
 *   2. the LOCAL project's config.json     (source: 'config')    — a CLAUDE.md-marked project root
 *      whose `.claude/claude-tpm/config.json` exists; its resolved `tasks.tasksDir` is used.
 *   3. FAIL LOUD                                                  — no flag AND no local project config.
 *
 * SAFETY (the whole reason `--tasks-dir` used to be mandatory): we NEVER silently fall back to a
 * global/home/live store. `findRoot` FALLS BACK to cwd when no CLAUDE.md marker is found, so a bare
 * cwd that merely happens to contain a stray config.json is NOT treated as a project — the marker
 * must be present (unless an explicit `--config` was given, which the operator opted into by hand).
 */
function resolveTasksDir(flagValue, configPathArg, opts) {
  const options = opts || {};
  if (flagValue) return { tasksDir: flagValue, source: 'flag', configPath: null };

  // No flag → resolve from the local project config (throws ENOENT for an explicit missing --config).
  const res = resolveTasksConfig(configPathArg, options);
  const markerFound = configPathArg
    ? true                                                   // an explicit --config is a hand opt-in
    : fs.existsSync(path.join(res.projectRoot, 'CLAUDE.md')); // else require a real project root marker
  if (res.configExists && markerFound) {
    return { tasksDir: tasksDirAbs(res.resolved, res.projectRoot), source: 'config', configPath: res.configPath };
  }
  const err = new Error(
    '--tasks-dir is required: pass --tasks-dir <dir>, or set "tasks": { "tasksDir": … } in a local ' +
    '.claude/claude-tpm/config.json (refusing to default to a live store).',
  );
  err.storeResolveFail = true;
  throw err;
}

function getDotted(obj, dottedKey) {
  const parts = String(dottedKey).split('.');
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
      'Usage: npx tpm task config [--config <path>] (--json | --get <dotted.key> | --tasks-dir) [--help]',
      '',
      "Resolves the 'tasks' section of a claude-tpm config.json over built-in defaults.",
      '',
      'Flags:',
      '  --config <path>     Path to config.json. Default: <projectRoot>/.claude/claude-tpm/config.json',
      '  --json               Print the resolved tasks config as JSON.',
      '  --get <dotted.key>   Print one resolved value, e.g. --get history.enabled',
      '  --tasks-dir           Print the resolved tasksDir as a bare absolute path.',
      '  --help                Show this message.',
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

function main(argv) {
  const args = parseArgs(argv);

  if (args.help) { printHelp(); return 0; }

  if (!args.json && !args.get && !args.tasksDir) {
    process.stderr.write('tpm task config: nothing to do — pass one of --json / --get / --tasks-dir.\n\n');
    printHelp();
    return 1;
  }

  let resolution;
  try {
    resolution = resolveTasksConfig(args.config);
  } catch (err) {
    process.stderr.write(`config: ${err.message}\n`);
    return 1;
  }

  const { resolved, projectRoot, warning } = resolution;
  if (warning) process.stderr.write(`config: ${warning}\n`);

  if (args.json) { process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`); return 0; }
  if (args.tasksDir) { process.stdout.write(`${tasksDirAbs(resolved, projectRoot)}\n`); return 0; }
  if (args.get) {
    const { found, value } = getDotted(resolved, args.get);
    if (!found) { process.stderr.write(`config: no such key "${args.get}" in resolved config.\n`); return 1; }
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return 0;
  }
  return 0;
}

module.exports = {
  resolveTasksConfig,
  resolveTasksDir,
  mergeTasksConfig,
  getDefaults,
  tasksDirAbs,
  getDotted,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
