#!/usr/bin/env node
/**
 * mutation-check28.js — the mutation proof for the 28-tighten-test-hardening round.
 *
 * PURPOSE
 *   The charter's bar: a test that still passes when you break the thing it tests has
 *   verified nothing. This round ADDED one killing assertion per guard-neutering mutant
 *   the fable review found surviving green (fable-2 #4 + fable-3 #5). This harness PROVES
 *   each added assertion is load-bearing: for every listed mutant it
 *     1. confirms the mutation anchor occurs EXACTLY ONCE in the tool (a stale anchor that
 *        silently no-ops would make the proof vacuous),
 *     2. applies the ONE deliberate mutation to a COPY of the tool (this task's copy — the
 *        canonical sibling under dev/.../23|24|25|02c is never touched),
 *     3. runs the owning suite and asserts it goes RED (nonzero),
 *     4. restores the tool BYTE-FOR-BYTE and re-runs the suite to confirm it is GREEN again.
 *   A mutant that leaves its suite green is a SURVIVOR and fails this harness.
 *
 *   Tool + test paths resolve relative to __dirname (this file lives in the task's tests/),
 *   so there are NO hardcoded absolute paths — copy the task folder elsewhere and it runs.
 *
 * HOW TO RUN
 *   node tests/mutation-check28.js        # exit 0 = every listed mutant killed; nonzero = a survivor
 *   node tests/mutation-check28.js --help
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const raw = String.raw;

// TASK is the folder that holds the per-tool suite trees (scaffold-config/, lint/, compose/,
// audit-cost/). This harness lives INSIDE it, so TASK === __dirname. (In the original
// phase-folder layout the harness sat one level up in tests/, so this was resolve(__dirname,
// '..'); promotion moved the harness in beside the suites, and the old anchor pointed one dir
// too high — every suite path missed, so baseline read "not green". Fixed 2026-08-30.)
const TASK = __dirname;
const T = rel => path.join(TASK, rel);

// Tool + suite locations (grouped by tool).
const SCAFFOLD      = T('tpm-workflow-scaffold-config/tools/scaffold-subagent.js');
const CONFIG        = T('tpm-workflow-scaffold-config/tools/config-resolver.js');
const CHECKFILENAME = T('tpm-workflow-scaffold-config/tools/check-filename.js');
const LINT          = T('tpm-workflow-lint/tools/lint-subagent-prompt.js');
const COMPOSE       = T('tpm-workflow-compose/tools/compose-spawn-prompt.js');
const AUDIT         = T('tpm-workflow-audit-cost/tools/audit.js');
const COSTLEDGER    = T('tpm-workflow-audit-cost/tools/cost-ledger.js');

const SCAFFOLD_TEST = T('tpm-workflow-scaffold-config/tests/scaffold-subagent/test.js');
const CONFIG_TEST   = T('tpm-workflow-scaffold-config/tests/config-resolver/test.js');
const LINT_TEST     = T('tpm-workflow-lint/tests/lint-subagent-prompt/test.js');
const COMPOSE_TEST  = T('tpm-workflow-compose/tests/compose.test.js');
const AUDIT_TEST    = T('tpm-workflow-audit-cost/tests/audit.test.js');
const COST_TEST     = T('tpm-workflow-audit-cost/tests/cost-ledger.test.js');

// Each mutant: id, the tool file it lives in, the suite that must catch it, and a
// find→replace pair (find must be a UNIQUE substring of the tool source).
const MUTANTS = [
  // ── scaffolder (fable-2 #4) ────────────────────────────────────────────────
  { id: 'scaffold · blocked-filename write guard', file: SCAFFOLD, test: SCAFFOLD_TEST,
    find: 'if (check.blocked) {', replace: 'if (false) { /* MUT */' },
  { id: 'scaffold · --slug path-traversal guard', file: SCAFFOLD, test: SCAFFOLD_TEST,
    find: raw`if (slug.includes('/') || slug.includes('\\') || slug.includes('..') || path.isAbsolute(slug)) {`,
    replace: 'if (false) { /* MUT */' },
  { id: 'scaffold · subagent.env no-clobber guard', file: SCAFFOLD, test: SCAFFOLD_TEST,
    find: 'if (fs.existsSync(target)) return null;', replace: 'if (false) return null; /* MUT */' },

  // ── scaffolder pre-task ack gate (2026-08-30 — session-007 skip fix) ────────
  { id: 'scaffold · pre-task ack gate is enforced in add-phase', file: SCAFFOLD, test: SCAFFOLD_TEST,
    find: 'const ackNote = assertPretaskAck(pretaskAck, { startDir });',
    replace: 'const ackNote = undefined; /* MUT */' },
  { id: 'scaffold · ack negative/placeholder rejection', file: SCAFFOLD, test: SCAFFOLD_TEST,
    find: 'if (!value || ACK_NEGATIVE_RE.test(value)) {', replace: 'if (false) { /* MUT */' },
  { id: 'scaffold · ack missing-file rejection', file: SCAFFOLD, test: SCAFFOLD_TEST,
    find: 'if (!fs.existsSync(abs)) {', replace: 'if (false) { /* MUT */' },

  // ── config-resolver (fable-3 #5) ───────────────────────────────────────────
  { id: 'config-resolver · unrecognized-version warning', file: CONFIG, test: CONFIG_TEST,
    find: 'if (version !== SUPPORTED_VERSION) {', replace: 'if (false) { /* MUT */' },
  { id: 'config-resolver · bad-JSON error path', file: CONFIG, test: CONFIG_TEST,
    find: 'parsed = JSON.parse(raw);', replace: 'parsed = {}; /* MUT */' },
  { id: 'config-resolver · --validate charterVariants.alternates[]', file: CONFIG, test: CONFIG_TEST,
    find: 'for (const alt of variant.alternates || []) {', replace: 'for (const alt of [] /* MUT */) {' },

  // ── check-filename (config-resolver row: --patterns beats --config) ────────
  { id: 'check-filename · --patterns-beats-config precedence', file: CHECKFILENAME, test: CONFIG_TEST,
    find: `if (typeof args.patterns === 'string' && args.patterns.length > 0) {`,
    replace: `if (false && args.patterns && args.patterns.length > 0) { /* MUT */` },

  // ── lint (fable-2 #4) ──────────────────────────────────────────────────────
  { id: 'lint · empty-charter (st.size > 0)', file: LINT, test: LINT_TEST,
    find: 'if (!(st.isFile() && st.size > 0)) return false;', replace: 'if (!(st.isFile())) return false; /* MUT */' },
  { id: 'lint · env-source-ritual check', file: LINT, test: LINT_TEST,
    find: raw`test: body => reAny(body, /source.*subagent\.env/i, /set -a.*source/i),`,
    replace: 'test: body => true, /* MUT */' },
  { id: 'lint · working-folder-mentioned check', file: LINT, test: LINT_TEST,
    find: raw`test: body => reAny(body, /dev\//),`, replace: 'test: body => true, /* MUT */' },
  { id: 'lint · FILL-marker regex (not uppercase-only)', file: LINT, test: LINT_TEST,
    find: raw`const FILL_RE = /\{\{\s*[^}]*?\s*\}\}/;`,
    replace: raw`const FILL_RE = /\{\{\s*[A-Z0-9_]*?\s*\}\}/;` },

  // ── compose (fable-3 #5) ───────────────────────────────────────────────────
  { id: 'compose · verifier "Do NOT modify the tool or tests" clause', file: COMPOSE, test: COMPOSE_TEST,
    find: 'FAIL/concern. Do NOT modify the tool or tests.', replace: 'FAIL/concern.' },

  // ── audit (fable-3 #5) ─────────────────────────────────────────────────────
  { id: 'audit · "# Charter —" posture marker', file: AUDIT, test: AUDIT_TEST,
    find: raw`{ label: '# Charter — (pasted charter heading)', re: /^\s*#\s+Charter\s*[—-]/im },`,
    replace: raw`{ label: '# Charter — (pasted charter heading)', re: /X_NEVER_MATCH_MUT/ },` },
  { id: 'audit · EPIC-phase scratch-in-findings', file: AUDIT, test: AUDIT_TEST,
    find: 'if (f.exists && f.scratchDirs.length) {', replace: 'if (false) { /* MUT */' },

  // ── cost-ledger (fable-3 #5) ───────────────────────────────────────────────
  { id: 'cost-ledger · cell() pipe-escape', file: COSTLEDGER, test: COST_TEST,
    find: raw`.replace(/\|/g, '\\|').trim();`, replace: '.trim();' },
];

function runsGreen(testPath) {
  try {
    execFileSync('node', [testPath], { encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch (_e) {
    return false;
  }
}

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(fs.readFileSync(__filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \*\s?/gm, '') + '\n');
    process.exit(0);
  }

  // Baseline: every suite must be green before we start mutating.
  const suites = [
    ['scaffold-subagent', SCAFFOLD_TEST], ['config-resolver', CONFIG_TEST], ['lint', LINT_TEST],
    ['compose', COMPOSE_TEST], ['audit', AUDIT_TEST], ['cost-ledger', COST_TEST],
  ];
  let baselineBad = false;
  for (const [name, t] of suites) {
    const g = runsGreen(t);
    if (!g) { process.stderr.write(`✗ BASELINE NOT GREEN — ${name}\n`); baselineBad = true; }
  }
  if (baselineBad) { process.stderr.write('Fix the suites before mutation-checking.\n'); process.exit(1); }
  process.stdout.write(`baseline: all ${suites.length} suites GREEN\n\n`);

  let survivors = 0;
  for (const m of MUTANTS) {
    const original = fs.readFileSync(m.file, 'utf8');
    const occ = original.split(m.find).length - 1;
    if (occ !== 1) {
      process.stderr.write(`✗ ${m.id}: anchor occurs ${occ}× in ${path.basename(m.file)} (want exactly 1) — harness stale.\n`);
      survivors += 1;
      continue;
    }
    fs.writeFileSync(m.file, original.replace(m.find, m.replace));
    let green;
    try {
      green = runsGreen(m.test);
    } finally {
      fs.writeFileSync(m.file, original); // ALWAYS restore byte-for-byte
    }
    if (green) {
      process.stderr.write(`✗ SURVIVOR — ${m.id}: mutant left ${path.basename(m.test)} GREEN (suite doesn't guard it)\n`);
      survivors += 1;
      continue;
    }
    // Restore sanity: the suite must be green again on the byte-exact original.
    if (fs.readFileSync(m.file, 'utf8') !== original) {
      process.stderr.write(`✗ RESTORE FAILED — ${m.id}: ${path.basename(m.file)} left dirty!\n`);
      survivors += 1;
      continue;
    }
    if (!runsGreen(m.test)) {
      process.stderr.write(`✗ RESTORE FAILED — ${m.id}: ${path.basename(m.test)} not green after restore.\n`);
      survivors += 1;
      continue;
    }
    process.stdout.write(`✓ killed — ${m.id}\n`);
  }

  process.stdout.write(`\n${survivors ? 'FAIL' : 'PASS'} — ${MUTANTS.length - survivors}/${MUTANTS.length} mutants killed\n`);
  process.exit(survivors ? 1 : 0);
}

main();
