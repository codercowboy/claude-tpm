#!/usr/bin/env node
/**
 * lint-subagent-prompt.js (v2) - validate a subagent spawn prompt AND catch
 * unresolved template sentinels before a subagent is spawned or a plan/charter
 * is handed to a worker.
 *
 * PURPOSE. Two jobs, one poka-yoke tool:
 *   1. SPAWN-PROMPT LINT (default mode) - the legacy checks: the step-zero
 *      reading chain (manifest-driven), the env-source ritual, the project-root
 *      anchor, the working-folder mention, verifier HARD RULE. Catches an
 *      incomplete brief before the Agent tool spawns a subagent.
 *   2. SENTINEL LINT (the v2 addition) - grep a *finalized* plan / charter /
 *      spawn prompt for template sentinels that must (not) still be there. The
 *      orchestrator greps the template rather than loading it whole (token
 *      savings) and so works from a partial view - this lint is what makes that
 *      partial-read SAFE. Taxonomy (workflow-design.md "The sentinel mechanism"):
 *        - FILL sentinel   `{{PLACEHOLDER}}` - must be filled; survives -> forgot it.
 *        - STRIP sentinel  `<!-- ORCHESTRATOR NOTE ... -->` (any orchestrator-only
 *                          block) - must be stripped before a worker sees it;
 *                          survives in a worker-facing file -> leak.
 *        - REQUIRED sentinel `<!-- required: X -->` - must be present; absent ->
 *                          missed inclusion. (Which markers are required is told
 *                          to the lint via --require.)
 *        - CONFIG-GATED sentinel - a block whose presence must MATCH a config
 *                          flag; present-when-false / absent-or-unfilled-when-true
 *                          -> drift. (Told via --config + --config-gate.)
 *   Plus two structural guards folded in from the design-review:
 *        - CHARTER-FILE-PRESENT - the charter file the spawn prompt NAMES exists
 *          on disk and is non-empty (the charter is the agent's definition of
 *          done; a spawn prompt that names a missing/empty charter is a footgun).
 *        - BLOCKED-FILENAME - a deliverable filename arg does not match a
 *          server-side-blocked pattern (report/summary/analysis/findings), via
 *          the sibling `check-filename.js`.
 *
 * PORTABILITY. Zero third-party deps (Node built-ins only). The one local
 * dependency is the sibling `check-filename.js` in this same tools/ folder -
 * per the per-suite portability rule, copy the WHOLE folder and it just works.
 *
 * USAGE.
 *   # Full spawn-prompt lint (manifest chain + structural + sentinels):
 *   node lint-subagent-prompt.js --file draft-prompt.md
 *   node lint-subagent-prompt.js --file draft.md --manifest path/to/reading-list.md
 *   node lint-subagent-prompt.js --file draft.md --verifier --verbose
 *
 *   # Sentinel-only scan of a finalized plan / charter (no env ritual, no chain):
 *   node lint-subagent-prompt.js --file plan.md --sentinels-only --require charter
 *
 *   # Standalone blocked-filename guard (no body needed):
 *   node lint-subagent-prompt.js --sentinels-only --filename my-findings.md
 *
 * FLAGS.
 *   --file <path>          Read the prompt/plan/charter from a file (default: stdin,
 *                          or empty when stdin is a TTY and no --file given).
 *   --sentinels-only       Run ONLY the sentinel family (fill/strip/required/
 *                          config-gated) + charter-file + blocked-filename. Skips
 *                          the manifest doc-chain and the env/working-folder
 *                          structural checks - use it to lint a finalized plan or
 *                          charter that is not itself a spawn prompt.
 *   --manifest <path>      Explicit path to the subagent reading-list manifest
 *                          (overrides discovery). If no manifest is found AND none
 *                          is given, the doc-chain checks are SKIPPED with a NOTE
 *                          (v2 no longer hard-exits) so the sentinel checks still run.
 *   --require <name[,..]>  A `<!-- required: <name> -->` marker that MUST be present.
 *                          Repeatable; comma-lists accepted. Absent -> fail.
 *   --filename <name[,..]> A deliverable filename to run through the blocked-filename
 *                          guard. Repeatable; comma-lists accepted. Blocked -> fail.
 *   --require-charter      Require the prompt to NAME a charter file (charter*.md)
 *                          AND that file to exist + be non-empty.
 *   --charter-dir <path>   Directory to resolve a named charter file against
 *                          (default: the directory of --file, else cwd).
 *   --config <path>        A claude-tpm config.json for --config-gate cross-checks.
 *   --config-gate <g>      `<dot.path>=<marker>` : the config boolean at <dot.path>
 *                          must MATCH the presence of literal <marker> in the body.
 *                          Repeatable. Requires --config.
 *   --live-system          Enable the live-system reading block (per-project).
 *   --verifier             Enable verifier checks (chain block + HARD-RULE reminder).
 *   --shipping             Enable shipping-artifact-worker checks.
 *   --resume               Enable the HANDOFF.md read check.
 *   --verbose              Print each check's rationale + doc pointer.
 *   --help                 Print this message.
 *
 * OUTPUT.
 *   On PASS: "PASS: prompt looks complete (<N> checks)"
 *   On FAIL: "FAIL: <N> of <M> required directives missing" + per-check list
 *            (each failing sentinel check prints the offending detail).
 *   Exit code: 0 = PASS, 1 = FAIL, 2 = bad CLI usage.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Sibling dependency (same suite/folder) - per-suite portability rule: this
// file + check-filename.js travel together. Build on it; do not re-implement.
const { isBlockedFilename } = require('./check-filename.js');

// PORT-NOTE: unchanged from legacy - the library include-token must byte-match
// the token consumer manifests write. Provisional value; a one-line flip.
const LIBRARY_INCLUDE_TOKEN = 'claude-admin';
const INCLUDE_RE = new RegExp('<!--\\s*include:\\s*' + LIBRARY_INCLUDE_TOKEN + '\\s*-->');

function parseArgs(argv) {
  const opts = {
    file: null,
    sentinelsOnly: false,
    manifest: null,
    require: [],
    filenames: [],
    requireCharter: false,
    charterDir: null,
    config: null,
    configGates: [],
    liveSystem: false,
    verifier: false,
    shipping: false,
    resume: false,
    verbose: false,
  };
  const pushList = (target, val) => {
    if (val == null) return;
    for (const p of String(val).split(',').map(s => s.trim()).filter(Boolean)) target.push(p);
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') opts.file = argv[++i];
    else if (a === '--sentinels-only') opts.sentinelsOnly = true;
    else if (a === '--manifest') opts.manifest = argv[++i];
    else if (a === '--require') pushList(opts.require, argv[++i]);
    else if (a === '--filename') pushList(opts.filenames, argv[++i]);
    else if (a === '--require-charter') opts.requireCharter = true;
    else if (a === '--charter-dir') opts.charterDir = argv[++i];
    else if (a === '--config') opts.config = argv[++i];
    else if (a === '--config-gate') opts.configGates.push(argv[++i]);
    else if (a === '--live-system') opts.liveSystem = true;
    else if (a === '--verifier') opts.verifier = true;
    else if (a === '--shipping') opts.shipping = true;
    else if (a === '--resume') opts.resume = true;
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    // Accept a bare positional path as --file (matches documented `lint … --sentinels-only plan.md`
    // usage in the plan-template). First non-flag positional only; extras are still errors. (2026-08-29.)
    else if (!a.startsWith('-') && opts.file == null) opts.file = a;
    else { console.error('Unknown arg: ' + a); process.exit(2); }
  }
  return opts;
}

function printHelp() {
  console.log(fs.readFileSync(__filename, 'utf8').match(/\/\*\*[\s\S]*?\*\//)[0]);
}

function readPromptSync(opts) {
  if (opts.file) return fs.readFileSync(path.resolve(opts.file), 'utf8');
  // No --file: read stdin only if something is actually piped in; a TTY means
  // there is no body (e.g. a standalone --filename check) - do NOT block.
  if (process.stdin.isTTY) return '';
  try { return fs.readFileSync(0, 'utf8'); }
  catch (e) { return ''; }
}

// -----------------------------------------------------------------------------
// Manifest-driven doc-chain checks (inherited from legacy, unchanged in spirit).
// -----------------------------------------------------------------------------

function reAny(body, ...res) {
  return res.some(re => re.test(body));
}

const MANIFEST_REL = path.join('claude-context', 'methodology', 'subagent', 'reading-list.md');

function libraryManifest() {
  const p = path.resolve(__dirname, '..', '..', MANIFEST_REL);
  return fs.existsSync(p) ? p : null;
}

/**
 * Locate the manifest to lint against: an explicit --manifest wins, then the
 * invoking project's copy, then the library's own. Returns null if none found
 * (v2: the caller SKIPS doc-chain checks rather than hard-exiting).
 */
function findManifest(opts) {
  if (opts && opts.manifest) {
    const p = path.resolve(opts.manifest);
    return fs.existsSync(p) ? p : null;
  }
  const consumer = path.resolve(process.cwd(), MANIFEST_REL);
  if (fs.existsSync(consumer)) return consumer;
  return libraryManifest();
}

function consumerDocExists(basename) {
  const rel = path.join('claude-context', 'methodology', basename);
  return [
    path.resolve(process.cwd(), rel),
    path.resolve(__dirname, '..', '..', rel),
  ].some(c => fs.existsSync(c));
}

function parseManifest(text, activeManifestPath, opts) {
  const resolveIncludes = !opts || opts.resolveIncludes !== false;
  let libraryBlocks = null;
  if (resolveIncludes && INCLUDE_RE.test(text)) {
    const gp = libraryManifest();
    if (gp && path.resolve(gp) !== path.resolve(activeManifestPath || '')) {
      libraryBlocks = parseManifest(fs.readFileSync(gp, 'utf8'), gp, { resolveIncludes: false });
    }
  }

  const blocks = {};
  const re = /<!--\s*lint:begin\s+([\w-]+)\s*-->([\s\S]*?)<!--\s*lint:end\s*-->/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const docs = [];
    for (const line of m[2].split('\n')) {
      if (INCLUDE_RE.test(line)) {
        for (const base of (libraryBlocks && libraryBlocks[m[1]]) || []) {
          if (!docs.includes(base)) docs.push(base);
        }
        continue;
      }
      const d = /`([^`]*?\.md)`/.exec(line);
      if (!d) continue;
      const base = d[1].split('/').pop();
      if (!docs.includes(base)) docs.push(base);
    }
    blocks[m[1]] = docs;
  }
  return blocks;
}

const stemOf = b => b.replace(/\.md$/, '');

const CANONICAL_IDS = {
  'HANDOFF.md':      'handoff-if-resume',
  'plan.md':         'plan-md-read',
  'verification.md': 'verification-if-shipping-or-verifier',
};
const idFor = (block, doc) => CANONICAL_IDS[doc] || `${block}-${stemOf(doc)}`;

const BLOCK_SPEC = {
  'base':              { applies: () => true,                    id: b => `step-zero-${stemOf(b)}` },
  'working-folder':    { applies: () => true,                    id: b => idFor('working-folder', b) },
  'resume':            { applies: o => o.resume,                 id: b => idFor('resume', b) },
  'shipping':          { applies: o => o.shipping || o.verifier, id: b => idFor('shipping', b) },
  'live-system':       { applies: o => o.liveSystem,             id: b => idFor('live-system', b) },
  'verifier':          { applies: o => o.verifier,               id: b => idFor('verifier', b) },
  'consumer-optional': { applies: (_o, b) => consumerDocExists(b), id: b => `step-zero-${stemOf(b)}` },
};

function docMatcher(basename) {
  const stem = basename.replace(/\.md$/, '');
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, m => '\\' + m);
  const parts = stem.split(/[\s_-]+/).filter(Boolean).map(esc);
  return new RegExp(parts.join('[\\s_-]*') + '(\\.md)?', 'i');
}

/** Build the manifest-driven doc-read checks. Returns [] if no manifest found. */
function buildManifestChecks(opts) {
  const manifestPath = findManifest(opts);
  if (!manifestPath) {
    console.error(
      'NOTE: no subagent reading-list manifest found (looked for ' + MANIFEST_REL + ', ' +
      'and --manifest was not given) - SKIPPING doc-chain checks. ' +
      'Structural + sentinel checks still run.',
    );
    return [];
  }
  const blocks = parseManifest(fs.readFileSync(manifestPath, 'utf8'), manifestPath);
  const checks = [];
  const byId = new Map();

  for (const [name, docs] of Object.entries(blocks)) {
    const spec = BLOCK_SPEC[name];
    if (!spec) continue;
    for (const doc of docs) {
      const id = spec.id(doc);
      const stem = doc.replace(/\.md$/, '');
      const existing = byId.get(id);
      if (existing) {
        const prev = existing.applies;
        existing.applies = (b, o) => prev(b, o) || spec.applies(o, doc);
        continue;
      }
      const check = {
        id,
        name: name === 'working-folder'
          ? `Working-folder read: ${doc}`
          : `Step-zero read: ${doc}`,
        docPointer: `subagent/reading-list.md, block "${name}"`,
        applies: (_b, o) => spec.applies(o, doc),
        test: body => docMatcher(stem).test(body),
      };
      byId.set(id, check);
      checks.push(check);
    }
  }
  return checks;
}

// -----------------------------------------------------------------------------
// Structural checks (prompt shape, not doc membership) - inherited from legacy.
// Skipped in --sentinels-only mode (a plan/charter is not a spawn prompt).
// -----------------------------------------------------------------------------

function buildStructuralChecks() {
  return [
    {
      id: 'env-source-ritual',
      name: 'Env-source ritual (single-bash-call + cd to project root)',
      docPointer: 'CLAUDE.md "Subagent prompts: required directives"',
      applies: (_b, o) => !o.sentinelsOnly,
      test: body => reAny(body, /source.*subagent\.env/i, /set -a.*source/i),
    },
    {
      id: 'env-source-project-root-anchor',
      name: 'Env-source cd-to-project-root anchor',
      docPointer: 'CLAUDE.md (project-root anchor)',
      applies: (_b, o) => !o.sentinelsOnly,
      test: body => reAny(body, /cd .*<[^>]*project[^>]*root[^>]*>/i, /cd .*project root/i, /project-root/i, /project root/i),
    },
    {
      id: 'working-folder-mentioned',
      name: 'Working folder path (dev/<task>/)',
      docPointer: 'CLAUDE.md - working folder must be explicit',
      applies: (_b, o) => !o.sentinelsOnly,
      test: body => reAny(body, /dev\//),
    },
    {
      id: "bundle-paths-tokenized",
      name: "Bundle methodology paths are ${TPM_HOME}/-prefixed (relocatable)",
      docPointer: "child-project-path-resolution.md",
      applies: (_b, o) => !o.sentinelsOnly,
      test: body => !/(?<!\$\{TPM_HOME\}\/)claude-context\/methodology\//.test(body),
    },
    {
      id: 'verifier-hard-rule',
      name: 'Verifier HARD RULE reminder (--verifier)',
      docPointer: 'verification.md HARD RULE - verifiers NEVER touch the live system under test',
      applies: (_b, o) => o.verifier && !o.sentinelsOnly,
      test: body => reAny(body, /NEVER.*touch.*live system/i, /HARD RULE/i),
    },
  ];
}

// -----------------------------------------------------------------------------
// Sentinel-taxonomy checks (the v2 addition) - always applicable.
// -----------------------------------------------------------------------------

// NON-global (safe for repeated .test() - no lastIndex state); *_G are the
// global clones used only for match()/count.
const FILL_RE = /\{\{\s*[^}]*?\s*\}\}/;
const STRIP_RE = /<!--\s*ORCHESTRATOR NOTE\b[\s\S]*?-->/i;
const FILL_RE_G = /\{\{\s*[^}]*?\s*\}\}/g;
const STRIP_RE_G = /<!--\s*ORCHESTRATOR NOTE\b[\s\S]*?-->/gi;
const REQUIRED_MARKER_RE = name =>
  new RegExp('<!--\\s*required:\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, m => '\\' + m) + '\\s*-->', 'i');

function uniq(arr) { return Array.from(new Set(arr)); }

/** Resolve a dot-path like "workflow.deliverables.wiki" out of a parsed object. */
function resolveDotPath(obj, dotPath) {
  return String(dotPath).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function buildSentinelChecks(opts) {
  const checks = [];

  // FILL sentinel: no surviving {{PLACEHOLDER}}.
  checks.push({
    id: 'fill-sentinel',
    name: 'No surviving FILL sentinel ({{PLACEHOLDER}})',
    docPointer: 'workflow-design.md "The sentinel mechanism" - fill sentinel',
    applies: () => true,
    test: body => !FILL_RE.test(body),
    detail: body => {
      const found = uniq((body.match(FILL_RE_G) || []).map(s => s.trim()));
      return found.length ? `surviving placeholder(s): ${found.join(', ')}` : '';
    },
  });

  // STRIP sentinel: no surviving <!-- ORCHESTRATOR NOTE ... -->.
  checks.push({
    id: 'strip-sentinel',
    name: 'No surviving STRIP sentinel (<!-- ORCHESTRATOR NOTE ... -->)',
    docPointer: 'workflow-design.md "The sentinel mechanism" - strip sentinel',
    applies: () => true,
    test: body => !STRIP_RE.test(body),
    detail: body => {
      const n = (body.match(STRIP_RE_G) || []).length;
      return n ? `${n} un-stripped orchestrator-only block(s) leaked into a worker-facing file` : '';
    },
  });

  // REQUIRED sentinel: each --require <name> marker must be present.
  for (const name of uniq(opts.require)) {
    checks.push({
      id: `required-sentinel-${name}`,
      name: `REQUIRED sentinel present (<!-- required: ${name} -->)`,
      docPointer: 'workflow-design.md "The sentinel mechanism" - required sentinel',
      applies: () => true,
      test: body => REQUIRED_MARKER_RE(name).test(body),
      detail: () => `missing required marker <!-- required: ${name} -->`,
    });
  }

  // CONFIG-GATED sentinel: config boolean at <dot.path> must MATCH marker presence.
  if (opts.configGates.length) {
    let cfg = null;
    if (opts.config) {
      try { cfg = JSON.parse(fs.readFileSync(path.resolve(opts.config), 'utf8')); }
      catch (e) { cfg = null; }
    }
    for (const gate of opts.configGates) {
      const eq = gate.indexOf('=');
      if (eq < 0) { console.error(`--config-gate must be <dot.path>=<marker>, got: ${gate}`); process.exit(2); }
      const dotPath = gate.slice(0, eq).trim();
      const marker = gate.slice(eq + 1);
      checks.push({
        id: `config-gate-${dotPath}`,
        name: `CONFIG-GATED sentinel matches config flag (${dotPath})`,
        docPointer: 'workflow-design.md "The sentinel mechanism" - config-gated sentinel',
        applies: () => true,
        test: body => {
          if (cfg == null) return false; // gate requested but config unreadable => drift/usage
          const flag = !!resolveDotPath(cfg, dotPath);
          const present = body.includes(marker);
          const unfilled = present && /\{\{[^}]*\}\}/.test(marker);
          if (flag) return present && !unfilled;   // must be present + filled
          return !present;                          // must be absent
        },
        detail: body => {
          if (cfg == null) return `config unreadable/absent (${opts.config || 'no --config'}) but gate ${dotPath} requested`;
          const flag = !!resolveDotPath(cfg, dotPath);
          const present = body.includes(marker);
          if (flag && !present) return `flag ${dotPath}=true but marker absent`;
          if (flag && /\{\{[^}]*\}\}/.test(marker) && present) return `flag ${dotPath}=true but marker still an unfilled placeholder`;
          if (!flag && present) return `flag ${dotPath}=false but marker present (should be stripped)`;
          return '';
        },
      });
    }
  }

  return checks;
}

// -----------------------------------------------------------------------------
// Charter-file-present + blocked-filename structural guards (design-review fold-in).
// -----------------------------------------------------------------------------

const CHARTER_REF_RE = /\bcharter[\w-]*\.md\b/i;

function buildCharterAndFilenameChecks(opts) {
  const checks = [];

  // CHARTER-FILE-PRESENT: if the prompt names a charter file (or --require-charter),
  // that file must exist on disk and be non-empty.
  checks.push({
    id: 'charter-file-present',
    name: 'Named charter file exists on disk and is non-empty',
    docPointer: 'workflow-design.md - charter is the agent\'s definition of done; a named charter must exist',
    applies: body => opts.requireCharter || CHARTER_REF_RE.test(body || ''),
    test: body => {
      const m = (body || '').match(CHARTER_REF_RE);
      if (!m) return false; // requireCharter set but no charter named -> fail
      const baseDir = opts.charterDir
        ? path.resolve(opts.charterDir)
        : (opts.file ? path.dirname(path.resolve(opts.file)) : process.cwd());
      const charterPath = path.join(baseDir, path.basename(m[0]));
      try {
        const st = fs.statSync(charterPath);
        return st.isFile() && st.size > 0;
      } catch (e) { return false; }
    },
    detail: body => {
      const m = (body || '').match(CHARTER_REF_RE);
      if (!m) return 'prompt names no charter*.md file (but --require-charter is set)';
      const baseDir = opts.charterDir
        ? path.resolve(opts.charterDir)
        : (opts.file ? path.dirname(path.resolve(opts.file)) : process.cwd());
      return `charter "${path.basename(m[0])}" missing or empty under ${baseDir}`;
    },
  });

  // BLOCKED-FILENAME: each --filename arg must not match a blocked pattern.
  for (const fn of uniq(opts.filenames)) {
    checks.push({
      id: `blocked-filename:${path.basename(fn)}`,
      name: `Deliverable filename not server-side-blocked (${path.basename(fn)})`,
      docPointer: 'check-filename.js - report/summary/analysis/findings are blocked',
      applies: () => true,
      test: () => !isBlockedFilename(fn).blocked,
      detail: () => {
        const r = isBlockedFilename(fn);
        return r.blocked ? `"${r.basename}" contains blocked pattern "${r.pattern}"` : '';
      },
    });
  }

  return checks;
}

// -----------------------------------------------------------------------------

function buildChecks(opts) {
  const checks = [];
  if (!opts.sentinelsOnly) {
    checks.push(...buildManifestChecks(opts));
  }
  checks.push(...buildStructuralChecks());
  checks.push(...buildSentinelChecks(opts));
  checks.push(...buildCharterAndFilenameChecks(opts));
  return checks;
}

function main() {
  const opts = parseArgs(process.argv);
  const body = readPromptSync(opts);
  const applicable = buildChecks(opts).filter(c => c.applies(body, opts));
  const failing = applicable.filter(c => !c.test(body, opts));

  if (failing.length === 0) {
    console.log(`PASS: prompt looks complete (${applicable.length} checks)`);
    if (opts.verbose) {
      console.log('');
      for (const c of applicable) console.log(`  ok  ${c.id.padEnd(40)} - ${c.name}`);
    }
    process.exit(0);
  }

  console.log(`FAIL: ${failing.length} of ${applicable.length} required directives missing:`);
  for (const c of failing) {
    console.log(`  X  ${c.id}`);
    console.log(`     ${c.name}`);
    if (typeof c.detail === 'function') {
      const d = c.detail(body, opts);
      if (d) console.log(`     -> ${d}`);
    }
    if (opts.verbose) console.log(`     See: ${c.docPointer}`);
  }
  if (!opts.verbose) console.log('\nRun with --verbose for doc pointers.');
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  buildChecks,
  FILL_RE,
  STRIP_RE,
  REQUIRED_MARKER_RE,
  resolveDotPath,
};
