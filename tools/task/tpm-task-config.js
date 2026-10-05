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
// #1152 — the shared layered-config overlay (required DIRECTLY, not via base.js's MODULES map, so the
// base-load audit is untouched): getDefaults() sources defaults.json, and the USER layer
// ($CLAUDE_TPM_USER_CONFIG) is folded onto the project section before the whitelist.
const overlay = require('../lib/tpm-config-overlay');

// The project-root MARKER: the `.claude/claude-tpm/` install-footprint DIRECTORY (created by the
// installer's ensureConsumerConfig). REPLACED the earlier CLAUDE.md marker (#02-marker-scope) so a
// consumer with the footprint but no CLAUDE.md is still recognised as a project root.
const PROJECT_MARKER = path.join('.claude', 'claude-tpm');

function getDefaults() {
  // #1152: sourced from the shipped tools/config/defaults.json via the overlay lib (comment keys
  // stripped). Byte-identical to the former inline literal — pinned by the task test suite.
  return overlay.loadDefaults().tasks;
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
  const startDir = options.startDir; // undefined = implicit: findRoot applies $TPM_PROJECT_ROOT, then cwd walk-up
  const projectRoot = findRoot({ startDir, marker: PROJECT_MARKER });
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
    // #1152: no project config — still fold the USER layer in (DoD C). No user layer => undefined =>
    // mergeTasksConfig(undefined) === getDefaults().
    const rawMerged = overlay.overlayUserOnto(undefined, 'tasks', { warn: options.warn, env: options.env });
    return { resolved: mergeTasksConfig(rawMerged), projectRoot, configPath, configExists: false, warning: null };
  }

  let parsed;
  let warning = null;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    // Lenient project-layer contract PRESERVED: malformed project config => defaults + warning (never a
    // crash); the user layer is not consulted in this error path (matches pre-#1152 behavior).
    warning = `could not parse ${configPath} as JSON (${err.message}); using built-in defaults.`;
    return { resolved: getDefaults(), projectRoot, configPath, configExists: true, warning };
  }

  // #1152: deep-merge the USER layer over the project `tasks` section (user wins) before the whitelist.
  const rawMerged = overlay.overlayUserOnto(parsed.tasks, 'tasks', { warn: options.warn, env: options.env });
  const resolved = mergeTasksConfig(rawMerged);
  return { resolved, projectRoot, configPath, configExists: true, warning };
}

/** Absolute path to the resolved tasksDir, relative to projectRoot if not already absolute. */
function tasksDirAbs(resolved, projectRoot) {
  const dir = (resolved && resolved.tasksDir) || getDefaults().tasksDir;
  return path.isAbsolute(dir) ? dir : path.join(projectRoot, dir);
}

/**
 * resolveTasksDir(flagValue, configPathArg, opts) -> { tasksDir, source, configPath }   (F4 / #1132)
 *
 * The ONE store-dir resolver every task VERB uses so `--tasks-dir` can be OMITTED. Precedence
 * (#1132 — arg > env > local config > project-local default; matches #1078's resolve() spec):
 *   1. explicit `--tasks-dir` flag         (source: 'flag')    — always wins.
 *   2. `TPM_TASKS_DIR` environment variable (source: 'env')    — an explicit operator opt-in.
 *   3. the LOCAL project's config.json       (source: 'config') — a `.claude/claude-tpm/`-marked project
 *      root whose `.claude/claude-tpm/config.json` exists; its resolved `tasks.tasksDir` is used.
 *   4. project-local DEFAULT                  (source: 'default')— inside a `.claude/claude-tpm/`-marked
 *      project with no config.json: `<root>/.claude/claude-tpm/tasks` (getDefaults().tasksDir under root).
 *   5. FAIL LOUD                                                — no flag, no env, AND no project marker.
 *
 * SAFETY — the whole reason `--tasks-dir` used to be mandatory: we NEVER silently fall back to a
 * global/home/live store. The `default` (item 4) is only permitted when a real project marker
 * (the `.claude/claude-tpm/` install footprint) is present, and it is a PROJECT-RELATIVE path resolved
 * UNDER that marked root — so it is inherently scoped to this project, never an absolute/global/live
 * path. `findRoot` FALLS BACK to cwd when no `.claude/claude-tpm/` marker is found, so a bare cwd that
 * merely happens to contain a stray config.json is NOT treated as a project — the marker must be
 * present (unless an explicit `--config` was given,
 * which the operator opted into by hand). `TPM_TASKS_DIR` and `--tasks-dir` MAY point at any path
 * because setting them is a deliberate operator act, unlike the auto-resolved default.
 */
function resolveTasksDir(flagValue, configPathArg, opts) {
  const options = opts || {};
  // 1. explicit flag — always wins.
  if (flagValue) return { tasksDir: flagValue, source: 'flag', configPath: null };
  // 2. environment variable — an explicit operator opt-in (like the flag); may point anywhere.
  const env = options.env || process.env;
  if (env && env.TPM_TASKS_DIR) return { tasksDir: env.TPM_TASKS_DIR, source: 'env', configPath: null };

  // 3/4 → resolve from the local project (throws ENOENT for an explicit missing --config).
  const res = resolveTasksConfig(configPathArg, options);
  const markerFound = configPathArg
    ? true                                                        // an explicit --config is a hand opt-in
    : fs.existsSync(path.join(res.projectRoot, PROJECT_MARKER));  // else require the `.claude/claude-tpm/` marker
  if (res.configExists && markerFound) {
    // 3. a local project config.json → its resolved tasksDir (a user value, or the built-in default).
    return { tasksDir: tasksDirAbs(res.resolved, res.projectRoot), source: 'config', configPath: res.configPath };
  }
  if (markerFound) {
    // 4. inside a real project (`.claude/claude-tpm/` marker) but no config.json → SAFE project-local default.
    return { tasksDir: tasksDirAbs(getDefaults(), res.projectRoot), source: 'default', configPath: null };
  }
  // 5. no flag, no env, no project marker → FAIL LOUD. NEVER default to a live store.
  const err = new Error(
    '--tasks-dir is required: pass --tasks-dir <dir>, set TPM_TASKS_DIR, or run inside a project ' +
    '(a `.claude/claude-tpm/`-marked root, optionally with a local .claude/claude-tpm/config.json). ' +
    'Refusing to default to a live store outside any project. ' +
    'Human terminal: if this project uses the claude-tpm plugin, run `npx tpm install .` here to set it up.',
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
      'Usage: tpm task config [--config <path>] (--json | --get <dotted.key> | --tasks-dir) [--help]',
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
