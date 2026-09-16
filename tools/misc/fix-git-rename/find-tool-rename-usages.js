#!/usr/bin/env node
/**
 * find-tool-rename-usages.js — find every reference in the claude-tpm tree to a tool script that
 * was RENAMED (staged in git), so the now-broken references to the OLD name/path can be fixed.
 *
 * PURPOSE
 *   A large batch of tool scripts was renamed. Any code/doc/config that still names the OLD path or
 *   OLD basename is now broken. This tool derives the rename map from the git status file (the single
 *   source of truth — nothing hardcoded), then greps the tree for OLD-name references and reports each
 *   hit as file:line + text, grouped by rename, distinguishing high-confidence full-PATH matches from
 *   ambiguous bare-BASENAME matches (many basenames are generic: config.js, format.js, paths.js, …).
 *
 * USAGE
 *   node find-tool-rename-usages.js [options]
 *
 *   Options:
 *     --status-file <path>   git status file to parse rename pairs from
 *                            (default: <repo-root>/current-git-status2.txt)
 *     --scan-root <path>     tree to scan for OLD-name usages
 *                            (default: <repo-root>, self-located from this script)
 *     --report-file <path>   where to also write the report
 *                            (default: <repo-root>/tmp/tool-renames/usages-report.txt)
 *     --help, -h             show this message
 *
 *   Exit code is 0 on a clean run whether or not hits are found (hits are not an error).
 *
 * CONVENTIONS: zero runtime deps (Node built-ins only); also a module (module.exports) so tests can
 *   drive the pure helpers (parseRenameMap, classifyLine, ...). See methodology/tool-conventions.md.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ── defaults (self-located from this file — nothing hardcoded to a machine) ──
// This script lives at tools/misc/fix-git-rename/, so the repo root is three levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULTS = {
  statusFile: path.join(REPO_ROOT, 'current-git-status2.txt'),
  scanRoot: REPO_ROOT,
  reportFile: path.join(REPO_ROOT, 'tmp', 'tool-renames', 'usages-report.txt'),
};

// Dirs never worth scanning, and files that are the rename ledgers themselves.
const EXCLUDE_DIRS = new Set(['.git', 'node_modules']);
const EXCLUDE_FILES = new Set(['current-git-status.txt', 'current-git-status2.txt']);

// ── pure helpers (unit-testable) ─────────────────────────────────────────────

// Parse `\trenamed:    OLD -> NEW` lines out of a git status dump into {old, new, oldBase, newBase}
// records. Filters no-op renames (OLD == NEW) defensively. Nothing hardcoded — the file is the source.
function parseRenameMap(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const m = raw.match(/renamed:\s+(.+?)\s+->\s+(.+?)\s*$/);
    if (!m) continue;
    const oldPath = m[1].trim();
    const newPath = m[2].trim();
    if (!oldPath || !newPath) continue;
    if (oldPath === newPath) continue; // defensive no-op guard
    out.push({
      old: oldPath,
      new: newPath,
      oldBase: path.posix.basename(oldPath),
      newBase: path.posix.basename(newPath),
    });
  }
  return out;
}

// Escape a string for safe use as a literal inside a RegExp.
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Classify one line against one rename. Returns 'path' if the full OLD relative path appears
// (high confidence), else 'basename' if the OLD basename appears as a standalone token
// (lower confidence — generic basenames collide), else null.
//
// The path check is a plain substring (a full old path is unambiguous). The basename check requires
// word-ish boundaries so `config.js` does not match inside `config.json` or `myconfig.js`; a leading
// `/` is allowed (that is just a path segment) and still counts as basename-only when the full old
// path did not match.
function classifyLine(line, rename) {
  if (line.includes(rename.old)) return 'path';
  const re = new RegExp('(?<![A-Za-z0-9_.\\-])' + escapeRegExp(rename.oldBase) + '(?![A-Za-z0-9_\\-])');
  if (re.test(line)) return 'basename';
  return null;
}

// ── filesystem walk ──────────────────────────────────────────────────────────

// Recursively yield absolute file paths under `root`, skipping EXCLUDE_DIRS and EXCLUDE_FILES.
function* walkFiles(root) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      yield* walkFiles(full);
    } else if (e.isFile()) {
      if (EXCLUDE_FILES.has(e.name)) continue;
      yield full;
    }
  }
}

// Read a text file; return null for unreadable or binary (null-byte) files so we skip them.
function readTextFile(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  if (buf.includes(0)) return null; // binary
  return buf.toString('utf8');
}

// ── scan ─────────────────────────────────────────────────────────────────────

// Scan the tree and attribute each matching line to each rename it references.
// Returns { groups: Map(old -> {rename, hits:[{file,line,text,kind}]}), filesScanned }.
function scan(renames, scanRoot) {
  const groups = new Map();
  for (const r of renames) groups.set(r.old, { rename: r, hits: [] });

  let filesScanned = 0;
  for (const file of walkFiles(scanRoot)) {
    const content = readTextFile(file);
    if (content === null) continue;
    filesScanned++;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      // Cheap early-out: skip lines that can't possibly matter.
      if (!text) continue;
      for (const r of renames) {
        const kind = classifyLine(text, r);
        if (!kind) continue;
        groups.get(r.old).hits.push({
          file,
          line: i + 1,
          text: text.replace(/\s+$/, ''),
          kind,
        });
      }
    }
  }
  return { groups, filesScanned };
}

// ── report ───────────────────────────────────────────────────────────────────

function relTo(root, file) {
  const rel = path.relative(root, file);
  return rel.startsWith('..') ? file : rel;
}

function buildReport(result, ctx) {
  const { groups, filesScanned } = result;
  const { scanRoot, statusFile } = ctx;
  const lines = [];
  const push = (s = '') => lines.push(s);

  const renameCount = groups.size;
  let renamesWithHits = 0;
  let totalHits = 0;
  let pathHits = 0;
  let basenameHits = 0;

  push('='.repeat(80));
  push('claude-tpm tool-rename usage report');
  push('='.repeat(80));
  push(`status file : ${statusFile}`);
  push(`scan root   : ${scanRoot}`);
  push(`generated   : ${new Date().toISOString()}`);
  push(`files scanned: ${filesScanned}`);
  push('');
  push('Legend: [PATH] = full old relative path matched (high confidence).');
  push('        [BASE] = only the bare basename matched (LOWER confidence / possibly a false');
  push('               positive — generic names like config.js/format.js/paths.js/test.js collide,');
  push('               and some renames kept the basename at a new location).');
  push('');

  for (const { rename, hits } of groups.values()) {
    const p = hits.filter((h) => h.kind === 'path').length;
    const b = hits.filter((h) => h.kind === 'basename').length;
    totalHits += hits.length;
    pathHits += p;
    basenameHits += b;
    if (hits.length) renamesWithHits++;

    push('-'.repeat(80));
    push(`RENAME: ${rename.old}`);
    push(`    ->  ${rename.new}`);
    push(`    old basename: ${rename.oldBase}   |   hits: ${hits.length} (path: ${p}, basename-only: ${b})`);
    if (!hits.length) {
      push('    (no references found)');
      push('');
      continue;
    }
    push('');
    for (const h of hits) {
      const tag = h.kind === 'path' ? '[PATH]' : '[BASE]';
      push(`    ${tag} ${relTo(scanRoot, h.file)}:${h.line}`);
      push(`           ${h.text.trim()}`);
    }
    push('');
  }

  push('='.repeat(80));
  push('SUMMARY');
  push('='.repeat(80));
  push(`renames scanned        : ${renameCount}`);
  push(`renames with hits      : ${renamesWithHits}`);
  push(`renames with no hits   : ${renameCount - renamesWithHits}`);
  push(`total hits             : ${totalHits}`);
  push(`  full-path matches    : ${pathHits}   (high confidence)`);
  push(`  basename-only matches: ${basenameHits}   (LOWER confidence — review each)`);
  push('');

  return { text: lines.join('\n'), stats: { renameCount, renamesWithHits, totalHits, pathHits, basenameHits } };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { statusFile: DEFAULTS.statusFile, scanRoot: DEFAULTS.scanRoot, reportFile: DEFAULTS.reportFile, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--status-file') out.statusFile = next();
    else if (a === '--scan-root') out.scanRoot = next();
    else if (a === '--report-file') out.reportFile = next();
    else throw new Error(`unrecognized argument: ${a}`);
  }
  return out;
}

function usage() {
  const self = fs.readFileSync(__filename, 'utf8');
  const m = self.match(/\* USAGE\n([\s\S]*?)\n \*\/\n/);
  process.stdout.write('find-tool-rename-usages.js — find references to renamed claude-tpm tool scripts\n\n' +
    (m ? m[1].replace(/^ \*?/gm, '').trimEnd() + '\n' : 'see the header docstring\n'));
}

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`error: ${e.message}\n\n`); usage(); process.exit(2); }

  if (opts.help) { usage(); process.exit(0); }

  let statusText;
  try { statusText = fs.readFileSync(opts.statusFile, 'utf8'); }
  catch (e) { process.stderr.write(`error: cannot read status file: ${opts.statusFile}\n${e.message}\n`); process.exit(1); }

  const renames = parseRenameMap(statusText);
  if (!renames.length) { process.stderr.write(`error: no rename pairs parsed from ${opts.statusFile}\n`); process.exit(1); }

  const result = scan(renames, opts.scanRoot);
  const { text } = buildReport(result, { scanRoot: opts.scanRoot, statusFile: opts.statusFile });

  process.stdout.write(text);

  try {
    fs.mkdirSync(path.dirname(opts.reportFile), { recursive: true });
    fs.writeFileSync(opts.reportFile, text, 'utf8');
    process.stdout.write(`\nreport written to: ${opts.reportFile}\n`);
  } catch (e) {
    process.stderr.write(`warning: could not write report file: ${e.message}\n`);
  }

  process.exit(0);
}

if (require.main === module) main();

module.exports = { parseRenameMap, escapeRegExp, classifyLine, walkFiles, readTextFile, scan, buildReport, DEFAULTS };
