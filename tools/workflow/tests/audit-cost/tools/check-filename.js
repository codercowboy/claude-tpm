#!/usr/bin/env node
/**
 * check-filename.js — blocked-filename guard for subagent-authored files.
 *
 * PURPOSE
 *   Subagents are forbidden from naming a deliverable report/summary/analysis/findings.md
 *   (server-side blocked, and a recurring failure mode this project guards against in tooling
 *   too). This CLI + reusable function flags a filename whose *basename* (case-insensitive)
 *   contains any blocked pattern as a plain substring.
 *
 * INPUTS
 *   <filename>          Required positional arg — the filename (or path) to check. Only the
 *                        basename is inspected; directories in the path are ignored.
 *   --patterns a,b,c     Optional. Comma-separated pattern list. When given, REPLACES the
 *                        pattern list entirely (built-in defaults + any --config value are
 *                        both ignored). Matching is substring, case-insensitive.
 *   --config <path>      Optional. Path to a claude-tpm config.json. If present, the tool reads
 *                        `workflow.blockedFilenamePatterns` from it and uses that array as the
 *                        pattern list (replacing the built-in defaults). Ignored if --patterns
 *                        is also given (--patterns wins). A missing/unreadable/malformed config
 *                        file, or a config with no `workflow.blockedFilenamePatterns`, silently
 *                        falls back to the built-in defaults (never an error — "absent config
 *                        means use the defaults" per config-guide.md).
 *   --help               Print this usage and exit 0.
 *
 * OUTPUT / EXIT CODES
 *   Basename contains a blocked pattern → prints a one-line message naming the matched pattern
 *   and exits 1. Otherwise prints an OK line and exits 0.
 *
 * REUSABLE API (for other tools to `require(...)` — this file is also a module)
 *   isBlockedFilename(filename, patterns) -> { blocked, pattern, basename }
 *   loadPatternsFromConfig(configPath)    -> string[] | null   (null = fall back to defaults)
 *   DEFAULT_PATTERNS                      -> string[]
 *
 * EXAMPLES
 *   node check-filename.js my-findings.md                       # exit 1 (matches "findings")
 *   node check-filename.js plan.md                               # exit 0
 *   node check-filename.js notes.md --patterns notes,scratch      # exit 1 (matches "notes")
 *   node check-filename.js out.md --config .claude/claude-tpm/config.json
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_PATTERNS = ['report', 'summary', 'analysis', 'findings'];

/**
 * Check whether a filename's basename (case-insensitive) contains any of the given patterns
 * as a plain substring.
 * @param {string} filename
 * @param {string[]} [patterns] defaults to DEFAULT_PATTERNS
 * @returns {{blocked: boolean, pattern: string|null, basename: string}}
 */
function isBlockedFilename(filename, patterns) {
  const list = Array.isArray(patterns) && patterns.length > 0 ? patterns : DEFAULT_PATTERNS;
  const basename = path.basename(String(filename));
  const lowerBase = basename.toLowerCase();
  const matched = list.find((p) => lowerBase.includes(String(p).toLowerCase()));
  return { blocked: !!matched, pattern: matched || null, basename };
}

/**
 * Read `workflow.blockedFilenamePatterns` out of a claude-tpm config.json.
 * Never throws: any failure (missing file, bad JSON, missing key) returns null so the caller
 * can fall back to defaults, matching the "absent/partial config -> defaults" contract.
 * @param {string} configPath
 * @returns {string[]|null}
 */
function loadPatternsFromConfig(configPath) {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    const patterns = parsed && parsed.workflow && parsed.workflow.blockedFilenamePatterns;
    if (Array.isArray(patterns) && patterns.length > 0) {
      return patterns.map(String);
    }
    return null;
  } catch (_err) {
    return null;
  }
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: node check-filename.js <filename> [--patterns a,b,c] [--config <path>] [--help]',
      '',
      'Exits 1 with a message if the basename (case-insensitive) contains a blocked pattern,',
      'else exits 0.',
      '',
      'Flags:',
      '  --patterns a,b,c   Comma-separated pattern list; replaces defaults/config entirely.',
      '  --config <path>    Read workflow.blockedFilenamePatterns from a claude-tpm config.json.',
      '  --help             Show this message.',
      '',
      `Default patterns: ${DEFAULT_PATTERNS.join(', ')}`,
      '',
      'Examples:',
      '  node check-filename.js my-findings.md',
      '  node check-filename.js plan.md',
      '  node check-filename.js out.md --config .claude/claude-tpm/config.json',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (a === '--patterns') {
      args.patterns = argv[i + 1];
      i += 1;
    } else if (a === '--config') {
      args.config = argv[i + 1];
      i += 1;
    } else {
      args._.push(a);
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

  const filename = args._[0];
  if (!filename) {
    process.stderr.write('check-filename.js: missing required <filename> argument.\n\n');
    printHelp();
    process.exit(1);
  }

  let patterns = null;
  if (typeof args.patterns === 'string' && args.patterns.length > 0) {
    patterns = args.patterns
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
  } else if (args.config) {
    patterns = loadPatternsFromConfig(args.config);
  }
  if (!patterns || patterns.length === 0) {
    patterns = DEFAULT_PATTERNS;
  }

  const result = isBlockedFilename(filename, patterns);
  if (result.blocked) {
    process.stderr.write(
      `BLOCKED: "${result.basename}" contains blocked pattern "${result.pattern}". ` +
        `Rename it (avoid: ${patterns.join(', ')}).\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`OK: "${result.basename}" does not match any blocked pattern.\n`);
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { isBlockedFilename, loadPatternsFromConfig, DEFAULT_PATTERNS };
