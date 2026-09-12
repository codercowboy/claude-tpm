#!/usr/bin/env node
/**
 * tests/session/mutation-check.js — the mutation proof for the tools/session suite's tests.
 *
 * PURPOSE
 *   Per the test-writer charter's bar: "a test that still passes when you break the thing it
 *   tests has verified nothing." This harness proves the load-bearing tests in
 *   tests/session/*.test.js actually catch real breakage, not just happy-path smoke. For every
 *   listed mutant it:
 *     1. confirms the mutation anchor occurs EXACTLY ONCE in the tool file (a stale anchor
 *        that silently no-ops would make the proof vacuous),
 *     2. applies the ONE deliberate mutation directly to the tool file under test,
 *     3. runs the owning suite and asserts it goes RED (nonzero exit),
 *     4. restores the tool BYTE-FOR-BYTE and re-runs the suite to confirm it is GREEN again.
 *   A mutant that leaves its suite green is a SURVIVOR and fails this harness.
 *
 *   Every path resolves relative to __dirname — no hardcoded absolutes, so this phase folder
 *   stays portable if moved.
 *
 * HOW TO RUN
 *   node tests/session/mutation-check.js        # exit 0 = every listed mutant killed
 *   node tests/session/mutation-check.js --help
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PHASE_ROOT = path.resolve(__dirname, '..');
const TOOLS_DIR = PHASE_ROOT;
const T = (rel) => path.join(TOOLS_DIR, rel);
const TEST = (rel) => path.join(__dirname, rel);

const CONFIG = T('tpm-session-config.js');
const CURRENT_SESSION = T('tpm-session-current.js');
const FORMAT = T('tpm-session-format.js');
const SESSION_NOTES = T('tpm-session-notes.js');
const SESSION_REVIEW = T('tpm-session-review.js');

const CONFIG_TEST = TEST('lib-config/test.js');
const CURRENT_SESSION_TEST = TEST('lib-current-session/test.js');
const FORMAT_TEST = TEST('lib-format/test.js');
const SESSION_NOTES_TEST = TEST('tpm-session-notes/test.js');
const SESSION_REVIEW_TEST = TEST('tpm-session-review/test.js');

// Each mutant: id, the tool file it lives in, the suite that must catch it, and a
// find->replace pair (find must be a UNIQUE substring of the tool source).
const MUTANTS = [
  // ── tpm-session-format.js ──────────────────────────────────────────────────────────
  { id: 'format · nextOpenItemId uses length+1 instead of max(id)+1', file: FORMAT, test: FORMAT_TEST,
    find: 'return Math.max(...openItems.map((it) => it.id)) + 1;',
    replace: 'return openItems.length + 1; /* MUT */' },
  { id: 'format · renderOpenItems always reports "None open." regardless of items', file: FORMAT, test: FORMAT_TEST,
    find: "if (!items || items.length === 0) return 'None open.';",
    replace: "return 'None open.'; /* MUT */ if (!items || items.length === 0) return 'None open.';" },
  { id: 'format · SEALED trailer written unconditionally (even when sealedAt is null)', file: FORMAT, test: FORMAT_TEST,
    find: 'if (sealedAt) {\n    parts.push(\'\', `${SEALED_PREFIX} ${sealedAt}`);\n  }',
    replace: 'if (true) { /* MUT */\n    parts.push(\'\', `${SEALED_PREFIX} ${sealedAt}`);\n  }' },

  // ── tpm-session-current.js ─────────────────────────────────────────────────
  { id: 'current-session · allocateNextNumber never advances past 0 (highest never updated)', file: CURRENT_SESSION, test: CURRENT_SESSION_TEST,
    find: 'if (m) highest = Math.max(highest, parseInt(m[1], 10));',
    replace: 'if (m) { /* MUT: highest never updated */ }' },
  { id: 'current-session · a CLOSED pointer no longer reports not-opened (lifecycle disambiguator neutered)', file: CURRENT_SESSION, test: CURRENT_SESSION_TEST,
    find: 'if (pointer.closedAt) {',
    replace: 'if (false) { /* MUT */' },
  { id: 'current-session · sessionIdMismatch always reports false', file: CURRENT_SESSION, test: CURRENT_SESSION_TEST,
    find: 'sessionIdMismatch: Boolean(envSessionId && pointer.sessionId && envSessionId !== pointer.sessionId),',
    replace: 'sessionIdMismatch: false, /* MUT */' },
  { id: 'current-session · sealSession never throws on nothing-open (ENOTHING_OPEN guard neutered)', file: CURRENT_SESSION, test: CURRENT_SESSION_TEST,
    find: "if (current.state !== 'open') {",
    replace: 'if (false) { /* MUT */' },

  // ── tpm-session-config.js ──────────────────────────────────────────────────────────
  { id: 'config · nested notes.enabled override silently ignored', file: CONFIG, test: CONFIG_TEST,
    find: "if (typeof rawSession.notes.enabled === 'boolean') {\n      resolved.notes.enabled = rawSession.notes.enabled;\n    }",
    replace: "if (false) { /* MUT */\n      resolved.notes.enabled = rawSession.notes.enabled;\n    }" },
  { id: 'config · an explicit missing --config path no longer errors', file: CONFIG, test: CONFIG_TEST,
    find: 'if (!usedDefaultLocation) {',
    replace: 'if (false) { /* MUT */' },

  // ── tpm-session-notes.js ───────────────────────────────────────────────────────
  { id: 'session-notes · no-open-session guard neutered (writes would proceed with nothing open)', file: SESSION_NOTES, test: SESSION_NOTES_TEST,
    find: "if (current.state !== 'open') {",
    replace: 'if (false) { /* MUT */' },
  { id: 'session-notes · --edit-sealed --confirm requirement neutered', file: SESSION_NOTES, test: SESSION_NOTES_TEST,
    find: 'if (!confirm) {',
    replace: 'if (false) { /* MUT */' },
  { id: 'session-notes · ENOTCANONICAL legacy-note refusal neutered', file: SESSION_NOTES, test: SESSION_NOTES_TEST,
    find: 'if (!parsed.number) {',
    replace: 'if (false) { /* MUT */' },
  { id: 'session-notes · "open done <id>" no longer checks the item off', file: SESSION_NOTES, test: SESSION_NOTES_TEST,
    find: 'item.done = true;',
    replace: 'item.done = false; /* MUT */' },
  { id: 'session-notes · bad open-item id no longer refused (ENOITEM guard neutered)', file: SESSION_NOTES, test: SESSION_NOTES_TEST,
    find: 'if (!item) {',
    replace: 'if (false) { /* MUT */' },

  // ── tpm-session-review.js ──────────────────────────────────────────────────────
  { id: 'session-review · --grep match filters out every session unconditionally', file: SESSION_REVIEW, test: SESSION_REVIEW_TEST,
    find: 'if (!hitResume && openItems.length === 0 && decisions.length === 0 && log.length === 0) return null;',
    replace: 'return null; /* MUT */' },
  { id: 'session-review · --since filter neutered (always includes everything)', file: SESSION_REVIEW, test: SESSION_REVIEW_TEST,
    find: 'return session.parsed.date >= since;',
    replace: 'return true; /* MUT */' },
  { id: 'session-review · overview ordering no longer descending (most-recent-first broken)', file: SESSION_REVIEW, test: SESSION_REVIEW_TEST,
    find: 'return numbers.sort().reverse();',
    replace: 'return numbers.sort(); /* MUT */' },
];

function runsGreen(testPath) {
  try {
    execFileSync('node', [testPath], { encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch (_e) {
    return false;
  }
}

function printHelp() {
  process.stdout.write(fs.readFileSync(__filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \*\s?/gm, '') + '\n');
}

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const suites = [
    ['tpm-session-format.js', FORMAT_TEST],
    ['tpm-session-current.js', CURRENT_SESSION_TEST],
    ['tpm-session-config.js', CONFIG_TEST],
    ['tpm-session-notes.js', SESSION_NOTES_TEST],
    ['tpm-session-review.js', SESSION_REVIEW_TEST],
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
