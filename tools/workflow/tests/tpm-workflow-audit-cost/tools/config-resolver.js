#!/usr/bin/env node
/**
 * config-resolver.js — the workflow-module config resolver.
 *
 * PURPOSE
 *   Per-suite domain resolver (Tier 2) for the `workflow` section of a project's
 *   `.claude/claude-tpm/config.json`, per claude-context/config-guide.md §2 and
 *   claude-context/dev/framework-config-design.md §"Config reading". Reads the config file
 *   (if any), merges it over built-in defaults, and hands back the fully RESOLVED workflow
 *   registry (subagentConfigs / teams / charterVariants / verifier / deliverables / etc) so
 *   callers never hand-parse JSON. Absent or partial config is NOT an error — it means "use
 *   the defaults." A config that points at a file that doesn't exist on disk IS an error
 *   (--validate), fails loudly rather than silently at spawn time.
 *
 * INPUTS
 *   --config <path>   Optional. Path to a claude-tpm config.json. Defaults to
 *                      <projectRoot>/.claude/claude-tpm/config.json, where <projectRoot> is
 *                      found by walking up from the current directory looking for a CLAUDE.md
 *                      marker file (falls back to the current directory if no marker is found).
 *                      A default path that doesn't exist is NOT an error — it resolves to
 *                      built-in defaults, same as an explicit --config pointing nowhere... except
 *                      an explicit --config that points nowhere IS a friendly error (the caller
 *                      asked for a specific file; it should exist). See "Missing --config" below.
 *   --json             Emit the resolved `workflow` config as JSON to stdout. Exit 0.
 *   --get <dotted.key> Emit one value out of the resolved config, JSON-stringified, e.g.
 *                      `--get verifier.requireAllPass` or `--get deliverables.tldr`. Exit 0, or
 *                      a friendly error + exit 1 if the path doesn't resolve to anything.
 *   --validate         Confirm every file the resolved config REFERENCES (planTemplateFile,
 *                      each subagentConfigs[].charterFile, each charterVariants[role]'s
 *                      alternates[]/addenda[]) exists on disk relative to <projectRoot>. Prints
 *                      "OK" + exit 0 if all exist (or none are referenced); a friendly error
 *                      listing every missing path + exit 1 otherwise.
 *   --help             Print usage and exit 0.
 *   Exactly one of --json / --get / --validate / --help is expected; omitting all of them
 *   prints usage to stderr and exits 1 (nothing to do is treated as a usage error, not a
 *   silent no-op).
 *
 * MISSING --config
 *   An explicitly-passed --config path that does not exist on disk is a friendly error + exit 1
 *   (the caller named a specific file; treat a typo/missing file as a mistake worth surfacing).
 *   The *default* location not existing is NOT an error (that's the normal "no config yet"
 *   case) — it silently resolves to built-in defaults.
 *
 * VERSION AWARENESS
 *   Reads the top-level `version` field (defaults to 1 if absent). This resolver understands
 *   version 1. An unrecognized version prints a warning to stderr (best-effort resolution
 *   continues) rather than hard-failing, since the shape has been stable at version 1.
 *
 * REUSABLE API (this file is also a module)
 *   resolveConfig(configPath, opts)  -> { resolved, projectRoot, configPath, usedDefault }
 *   validateResolved(resolved, projectRoot) -> { ok, missing: [{key, filePath}] }
 *   getDefaults()                    -> the built-in workflow defaults (deep-cloned)
 *   findProjectRoot(startDir)        -> absolute path
 *
 * EXAMPLES
 *   node config-resolver.js --json
 *   node config-resolver.js --config ./sample-config.json --json
 *   node config-resolver.js --get verifier.multiCountMode
 *   node config-resolver.js --config ./sample-config.json --validate
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SUPPORTED_VERSION = 1;

// ---------------------------------------------------------------------------
// Root resolution (suite-local helper, duplicated per tool-conventions.md —
// no shared project-paths module). Walks upward from startDir looking for a
// CLAUDE.md marker file; falls back to startDir if none is found anywhere
// up the tree.
// ---------------------------------------------------------------------------
function findProjectRoot(startDir, marker = 'CLAUDE.md') {
  let dir = path.resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (fs.existsSync(path.join(dir, marker))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return path.resolve(startDir); // no marker found anywhere up the tree
    }
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Built-in defaults — mirrors claude-context/config-guide.md §2 "Workflow config".
// charterVariants defaults to {} (empty): the config-guide.md example entry
// (`builder: { alternates: ["charters/mvp.md"] }`) is illustrative of the SHAPE a
// consumer would add, not a file this framework ships by default — defaulting it
// non-empty would make `--validate` fail out of the box on a fresh project before
// charters/mvp.md exists. See findings/HANDOFF.md for this judgment call.
// ---------------------------------------------------------------------------
function getDefaults() {
  return {
    enabled: true,
    planTemplateFile: '',
    subagentConfigs: [
      { name: 'planning', defaultModel: 'opus', charterFile: '', retryCount: 1 },
      { name: 'builder', defaultModel: 'opus', charterFile: '', retryCount: 5 },
      { name: 'verifier', defaultModel: 'opus', charterFile: '', retryCount: 1 },
      { name: 'researcher', defaultModel: 'opus', charterFile: '', retryCount: 1 },
    ],
    teams: [
      { name: 'full', subagents: [{ name: 'planning' }, { name: 'builder' }, { name: 'verifier' }] },
      { name: 'ship', subagents: [{ name: 'builder' }, { name: 'verifier' }] },
      { name: 'research', subagents: [{ name: 'researcher' }] },
      { name: 'build', subagents: [{ name: 'builder' }] },
    ],
    defaultParallelism: 'serial',
    verifyLoopCap: 5,
    deliverables: { tldr: true, toolFeedback: true, wiki: true },
    charterVariants: {},
    verifier: { requireAllPass: true, multiCountMode: 'blind-pair' },
    costLedger: { epicPath: '00-epic-plan/cost-ledger.md' },
    blockedFilenamePatterns: ['report', 'summary', 'analysis', 'findings'],
  };
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Merge an array of {name,...} entries: override by name, append new names. */
function mergeByName(defaults, overrides) {
  if (!Array.isArray(overrides)) return deepClone(defaults);
  const result = deepClone(defaults);
  for (const entry of overrides) {
    if (!entry || typeof entry.name !== 'string') continue;
    const idx = result.findIndex((e) => e.name === entry.name);
    if (idx === -1) {
      result.push(deepClone(entry));
    } else {
      result[idx] = Object.assign({}, result[idx], entry);
    }
  }
  return result;
}

/** Shallow-merge plain-object sections (config keys override matching default keys). */
function mergeShallow(defaults, overrides) {
  if (!isPlainObject(overrides)) return deepClone(defaults);
  return Object.assign({}, deepClone(defaults), deepClone(overrides));
}

/**
 * Merge a parsed config.json's `workflow` section over the built-in defaults.
 * @param {object|undefined} rawWorkflow the `workflow` key of a parsed config.json (may be absent)
 * @returns {object} the resolved workflow config
 */
function mergeWorkflowConfig(rawWorkflow) {
  const defaults = getDefaults();
  if (!isPlainObject(rawWorkflow)) {
    return defaults;
  }

  const resolved = deepClone(defaults);

  if (typeof rawWorkflow.enabled === 'boolean') resolved.enabled = rawWorkflow.enabled;
  if (typeof rawWorkflow.planTemplateFile === 'string') {
    resolved.planTemplateFile = rawWorkflow.planTemplateFile;
  }
  if (typeof rawWorkflow.defaultParallelism === 'string') {
    resolved.defaultParallelism = rawWorkflow.defaultParallelism;
  }
  if (typeof rawWorkflow.verifyLoopCap === 'number') {
    resolved.verifyLoopCap = rawWorkflow.verifyLoopCap;
  }

  resolved.subagentConfigs = mergeByName(defaults.subagentConfigs, rawWorkflow.subagentConfigs);
  resolved.teams = mergeByName(defaults.teams, rawWorkflow.teams);
  resolved.deliverables = mergeShallow(defaults.deliverables, rawWorkflow.deliverables);
  resolved.verifier = mergeShallow(defaults.verifier, rawWorkflow.verifier);
  resolved.costLedger = mergeShallow(defaults.costLedger, rawWorkflow.costLedger);

  // charterVariants: keyed by role name, shallow-merged per role.
  if (isPlainObject(rawWorkflow.charterVariants)) {
    resolved.charterVariants = deepClone(defaults.charterVariants);
    for (const role of Object.keys(rawWorkflow.charterVariants)) {
      resolved.charterVariants[role] = Object.assign(
        {},
        resolved.charterVariants[role] || {},
        rawWorkflow.charterVariants[role],
      );
    }
  }

  // blockedFilenamePatterns: array replace (config's full list wins, not merged).
  if (Array.isArray(rawWorkflow.blockedFilenamePatterns) && rawWorkflow.blockedFilenamePatterns.length > 0) {
    resolved.blockedFilenamePatterns = rawWorkflow.blockedFilenamePatterns.map(String);
  }

  return resolved;
}

/**
 * Locate, read, and resolve config.json's `workflow` section.
 * @param {string|undefined} configPathArg explicit --config value, or undefined for the default location
 * @param {object} [opts]
 * @param {string} [opts.startDir] where to start walking up for the project root (default cwd)
 * @returns {{resolved: object, projectRoot: string, configPath: string, usedDefaultLocation: boolean, configExists: boolean}}
 */
function resolveConfig(configPathArg, opts = {}) {
  const startDir = opts.startDir || process.cwd();
  const projectRoot = findProjectRoot(startDir);
  const usedDefaultLocation = !configPathArg;
  const configPath = configPathArg
    ? path.resolve(configPathArg)
    : path.join(projectRoot, '.claude', 'claude-tpm', 'config.json');

  const configExists = fs.existsSync(configPath);

  if (!configExists) {
    if (!usedDefaultLocation) {
      // Explicit --config pointing at nothing is a mistake worth surfacing loudly.
      const err = new Error(`config-resolver: --config path does not exist: ${configPath}`);
      err.code = 'ENOENT_CONFIG';
      throw err;
    }
    // Default location absent -> normal "no config yet" case -> defaults, no error.
    return { resolved: getDefaults(), projectRoot, configPath, usedDefaultLocation, configExists: false };
  }

  let parsed;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (err) {
    const wrapped = new Error(`config-resolver: could not parse ${configPath} as JSON: ${err.message}`);
    wrapped.code = 'EBADJSON';
    throw wrapped;
  }

  const version = typeof parsed.version === 'number' ? parsed.version : SUPPORTED_VERSION;
  if (version !== SUPPORTED_VERSION) {
    process.stderr.write(
      `config-resolver: warning — config.json declares version ${version}, this resolver ` +
        `understands version ${SUPPORTED_VERSION}. Resolving best-effort.\n`,
    );
  }

  const resolved = mergeWorkflowConfig(parsed.workflow);
  return { resolved, projectRoot, configPath, usedDefaultLocation, configExists: true };
}

/**
 * Validate that every file the resolved config references exists on disk (relative to projectRoot).
 * @param {object} resolved the resolved workflow config
 * @param {string} projectRoot
 * @returns {{ok: boolean, missing: Array<{key: string, filePath: string}>}}
 */
function validateResolved(resolved, projectRoot) {
  const missing = [];

  function check(key, relPath) {
    if (!relPath) return; // "" = no override, nothing to check
    const abs = path.isAbsolute(relPath) ? relPath : path.join(projectRoot, relPath);
    if (!fs.existsSync(abs)) {
      missing.push({ key, filePath: abs });
    }
  }

  check('planTemplateFile', resolved.planTemplateFile);

  for (const sc of resolved.subagentConfigs || []) {
    check(`subagentConfigs[${sc.name}].charterFile`, sc.charterFile);
  }

  for (const role of Object.keys(resolved.charterVariants || {})) {
    const variant = resolved.charterVariants[role] || {};
    for (const alt of variant.alternates || []) {
      check(`charterVariants.${role}.alternates[]`, alt);
    }
    for (const add of variant.addenda || []) {
      check(`charterVariants.${role}.addenda[]`, add);
    }
  }

  return { ok: missing.length === 0, missing };
}

/** Navigate a resolved object by a dotted key path, e.g. "verifier.requireAllPass". */
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
      'Usage: node config-resolver.js [--config <path>] (--json | --get <dotted.key> | --validate) [--help]',
      '',
      "Resolves the 'workflow' section of a claude-tpm config.json over built-in defaults.",
      'Absent/partial config -> defaults (never an error). A config referencing a missing file',
      'is an error only under --validate.',
      '',
      'Flags:',
      '  --config <path>     Path to config.json. Default: <projectRoot>/.claude/claude-tpm/config.json',
      '  --json               Print the resolved workflow config as JSON.',
      '  --get <dotted.key>   Print one resolved value, e.g. --get verifier.requireAllPass',
      '  --validate           Confirm every referenced file (charters, templates, alternates) exists.',
      '  --help                Show this message.',
      '',
      'Examples:',
      '  node config-resolver.js --json',
      '  node config-resolver.js --config ./sample-config.json --get deliverables.tldr',
      '  node config-resolver.js --config ./sample-config.json --validate',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (a === '--json') {
      args.json = true;
    } else if (a === '--validate') {
      args.validate = true;
    } else if (a === '--get') {
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

  if (!args.json && !args.validate && !args.get) {
    process.stderr.write('config-resolver.js: nothing to do — pass one of --json / --get / --validate.\n\n');
    printHelp();
    process.exit(1);
  }

  let resolution;
  try {
    resolution = resolveConfig(args.config);
  } catch (err) {
    process.stderr.write(`config-resolver: ${err.message}\n`);
    process.exit(1);
  }

  const { resolved, projectRoot } = resolution;

  if (args.json) {
    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
    process.exit(0);
  }

  if (args.get) {
    const { found, value } = getDotted(resolved, args.get);
    if (!found) {
      process.stderr.write(`config-resolver: no such key "${args.get}" in resolved config.\n`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify(value)}\n`);
    process.exit(0);
  }

  if (args.validate) {
    const { ok, missing } = validateResolved(resolved, projectRoot);
    if (ok) {
      process.stdout.write('OK: every file referenced by the resolved config exists.\n');
      process.exit(0);
    }
    process.stderr.write('config-resolver: referenced file(s) do not exist:\n');
    for (const m of missing) {
      process.stderr.write(`  - ${m.key} -> ${m.filePath}\n`);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  resolveConfig,
  validateResolved,
  getDefaults,
  findProjectRoot,
  mergeWorkflowConfig,
  getDotted,
};
