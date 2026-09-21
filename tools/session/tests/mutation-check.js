#!/usr/bin/env node
/**
 * tests/session/mutation-check.js — the mutation proof for the tools/session suite's tests.
 *
 * PURPOSE
 *   Per the test-writer charter's bar: "a test that still passes when you break the thing it
 *   tests has verified nothing." This harness proves the load-bearing tests in
 *   tests/session/<tool>/test.js actually catch real breakage, not just happy-path smoke. For every
 *   listed mutant it:
 *     1. confirms the mutation anchor occurs EXACTLY ONCE in the tool file (a stale anchor
 *        that silently no-ops would make the proof vacuous),
 *     2. applies the ONE deliberate mutation directly to the tool file under test,
 *     3. runs the owning suite and asserts it goes RED (nonzero exit),
 *     4. restores the tool BYTE-FOR-BYTE and re-runs the suite to confirm it is GREEN again.
 *   A mutant that leaves its suite green is a SURVIVOR and fails this harness.
 *
 *   REWRITTEN alongside the three-file redesign (destructive format rewrite ratified 2026-09-17):
 *   the old mutants targeted removed functions (nextOpenItemId, renderOpenItems, the RESUME parse,
 *   the `open done` verb). They are replaced with mutants against the new SSOT + the three new tools
 *   (save / punchlist / boot-read) + the reworked review, plus the still-valid config/current mutants.
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
const SESSION_SAVE = T('tpm-session-save.js');
const SESSION_PUNCHLIST = T('tpm-session-punchlist.js');
const SESSION_BOOT_READ = T('tpm-session-boot-read.js');

const CONFIG_TEST = TEST('lib-config/test.js');
const CURRENT_SESSION_TEST = TEST('lib-current-session/test.js');
const FORMAT_TEST = TEST('lib-format/test.js');
const SESSION_NOTES_TEST = TEST('tpm-session-notes/test.js');
const SESSION_REVIEW_TEST = TEST('tpm-session-review/test.js');
const SESSION_SAVE_TEST = TEST('tpm-session-save/test.js');
const SESSION_PUNCHLIST_TEST = TEST('tpm-session-punchlist/test.js');
const SESSION_BOOT_READ_TEST = TEST('tpm-session-boot-read/test.js');

// Each mutant: id, the tool file it lives in, the suite that must catch it, and a
// find->replace pair (find must be a UNIQUE substring of the tool source).
const MUTANTS = [
  // ── tpm-session-format.js (SSOT) ─────────────────────────────────────────────
  { id: 'format · nextPunchlistN uses length+1 instead of max(n)+1', file: FORMAT, test: FORMAT_TEST,
    find: 'return ns.length ? Math.max(...ns) + 1 : 1;',
    replace: 'return ns.length ? ns.length + 1 : 1; /* MUT */' },
  { id: 'format · renderLog always reports "_Nothing logged yet._" regardless of entries', file: FORMAT, test: FORMAT_TEST,
    find: "if (!log || log.length === 0) return '_Nothing logged yet._';",
    replace: "return '_Nothing logged yet._'; /* MUT */ if (!log || log.length === 0) return '_Nothing logged yet._';" },
  { id: 'format · parsePunchlist never marks an item done (checkbox ignored)', file: FORMAT, test: FORMAT_TEST,
    find: "done: m[1] === 'x',",
    replace: 'done: false, /* MUT */' },
  // #1094 naming-sweep mutants (version read-gate + prefixed-file preamble).
  { id: 'format · readsAsV1 always true (version gate neutered — non-v1.0 files wrongly accepted)', file: FORMAT, test: FORMAT_TEST,
    find: "return typeof content === 'string' && VERSION_RE.test(content);",
    replace: 'return true; /* MUT */' },
  { id: 'format · buildWayfindingHeader drops the tpm-session-version: 1.0 sentinel (rendered files no longer read as v1.0)', file: FORMAT, test: FORMAT_TEST,
    find: 'tpm-session-version: 1.0 · files: session-',
    replace: 'files: session-' },
  // #1095 punchlist-item notes: parse-attach + render-emit of the `- note <date>: <text>` sub-bullets.
  { id: 'format · parsePunchlist drops note attach (note sub-bullets never attach to their item)', file: FORMAT, test: FORMAT_TEST,
    find: 'items[items.length - 1].notes.push({ date: nm[1], text: nm[2] });',
    replace: '/* MUT: note attach dropped */' },
  { id: 'format · renderPunchlistItem never emits note sub-bullets (notes vanish on render)', file: FORMAT, test: FORMAT_TEST,
    find: 'line += `\\n- note ${note.date}: ${note.text}`;',
    replace: 'line += ``; /* MUT: note line not rendered */' },

  // ── tpm-session-current.js (unchanged tool — still-valid mutants) ────────────
  { id: 'current-session · allocateNextNumber never advances past 0 (highest never updated)', file: CURRENT_SESSION, test: CURRENT_SESSION_TEST,
    find: 'if (m) highest = Math.max(highest, parseInt(m[1], 10));',
    replace: 'if (m) { /* MUT: highest never updated */ }' },
  { id: 'current-session · allocateNextNumber pads to 3 not 4 (#1094 4-digit numbering broken)', file: CURRENT_SESSION, test: CURRENT_SESSION_TEST,
    find: "return String(highest + 1).padStart(4, '0');",
    replace: "return String(highest + 1).padStart(3, '0'); /* MUT */" },
  { id: 'current-session · a CLOSED pointer no longer reports not-opened (lifecycle disambiguator neutered)', file: CURRENT_SESSION, test: CURRENT_SESSION_TEST,
    find: 'if (pointer.closedAt) {',
    replace: 'if (false) { /* MUT */' },
  { id: 'current-session · sessionIdMismatch always reports false', file: CURRENT_SESSION, test: CURRENT_SESSION_TEST,
    find: 'sessionIdMismatch: Boolean(envSessionId && pointer.sessionId && envSessionId !== pointer.sessionId),',
    replace: 'sessionIdMismatch: false, /* MUT */' },
  { id: 'current-session · sealSession never throws on nothing-open (ENOTHING_OPEN guard neutered)', file: CURRENT_SESSION, test: CURRENT_SESSION_TEST,
    find: "if (current.state !== 'open') {",
    replace: 'if (false) { /* MUT */' },

  // ── tpm-session-config.js (unchanged tool) ───────────────────────────────────
  { id: 'config · nested notes.enabled override silently ignored', file: CONFIG, test: CONFIG_TEST,
    find: "if (typeof rawSession.notes.enabled === 'boolean') {\n      resolved.notes.enabled = rawSession.notes.enabled;\n    }",
    replace: "if (false) { /* MUT */\n      resolved.notes.enabled = rawSession.notes.enabled;\n    }" },

  // ── tpm-session-notes.js (ledger writer) ─────────────────────────────────────
  { id: 'session-notes · no-open-session guard neutered (writes would proceed with nothing open)', file: SESSION_NOTES, test: SESSION_NOTES_TEST,
    find: "if (current.state !== 'open') {",
    replace: 'if (false) { /* MUT */' },
  { id: 'session-notes · --edit-sealed --confirm requirement neutered', file: SESSION_NOTES, test: SESSION_NOTES_TEST,
    find: 'if (!confirm) {',
    replace: 'if (false) { /* MUT */' },
  { id: 'session-notes · log entry no longer stamped with the ISO-TZ timestamp', file: SESSION_NOTES, test: SESSION_NOTES_TEST,
    find: 'sections.log.push({ status: args.status, text: args.text, ts: nowIsoTz() });',
    replace: "sections.log.push({ status: args.status, text: args.text, ts: 'NO-TZ' }); /* MUT */" },

  // ── tpm-session-review.js (reworked read API) ────────────────────────────────
  { id: 'session-review · overview ordering no longer descending (most-recent-first broken)', file: SESSION_REVIEW, test: SESSION_REVIEW_TEST,
    find: 'return numbers.sort().reverse(); // descending, highest (most recent) first',
    replace: 'return numbers.sort(); /* MUT */' },
  { id: 'session-review · --since filter neutered (always includes everything)', file: SESSION_REVIEW, test: SESSION_REVIEW_TEST,
    find: 'return date >= since;',
    replace: 'return true; /* MUT */' },
  { id: 'session-review · --grep drops every session unconditionally', file: SESSION_REVIEW, test: SESSION_REVIEW_TEST,
    find: 'if (!hitHandoff && open.length === 0 && decisions.length === 0 && log.length === 0) return null;',
    replace: 'return null; /* MUT */ if (!hitHandoff && open.length === 0 && decisions.length === 0 && log.length === 0) return null;' },

  // ── tpm-session-save.js (gated checkpoint) ───────────────────────────────────
  { id: 'save · unknown-key typo guard neutered (a stray key would be accepted)', file: SESSION_SAVE, test: SESSION_SAVE_TEST,
    find: 'if (!ALLOWED_KEYS.includes(key)) {',
    replace: 'if (false) { /* MUT */' },
  { id: 'save · where/next non-empty requirement neutered', file: SESSION_SAVE, test: SESSION_SAVE_TEST,
    find: "if (typeof v !== 'string' || v.trim() === '') {",
    replace: 'if (false) { /* MUT */' },

  // ── tpm-session-punchlist.js (item writer) ───────────────────────────────────
  { id: 'punchlist · close no longer marks the item done', file: SESSION_PUNCHLIST, test: SESSION_PUNCHLIST_TEST,
    find: 'item.done = true;',
    replace: 'item.done = false; /* MUT */' },
  { id: 'punchlist · already-closed no-op guard neutered (re-closes instead of warning)', file: SESSION_PUNCHLIST, test: SESSION_PUNCHLIST_TEST,
    find: 'if (item.done) {',
    replace: 'if (false) { /* MUT */' },
  // #1093 cross-session provenance + log-every-op + reopen-order guards.
  { id: 'punchlist · carry stops logging (a successful op no longer records a ## Log line)', file: SESSION_PUNCHLIST, test: SESSION_PUNCHLIST_TEST,
    find: "logOp(ctx, 'CARRIED', copy);",
    replace: '/* MUT: carry no longer logs */' },
  { id: 'punchlist · writePunchlist sort neutered (reopen no longer restored to id order)', file: SESSION_PUNCHLIST, test: SESSION_PUNCHLIST_TEST,
    find: '(Number(a.session) - Number(b.session)) || (Number(a.n) - Number(b.n))',
    replace: '0 /* MUT: sort off */' },
  { id: 'punchlist · cross-session close copy is not marked done (B4 done-copy degraded to open)', file: SESSION_PUNCHLIST, test: SESSION_PUNCHLIST_TEST,
    find: 'done: true,',
    replace: 'done: false, /* MUT */' },
  // #1095 punchlist-item notes: inline cap guard, [NOTE] audit line, [PLNOTE] offload, carry/close skip-notes.
  { id: 'punchlist · inline-note 300-char cap neutered (an over-cap note would be silently stored)', file: SESSION_PUNCHLIST, test: SESSION_PUNCHLIST_TEST,
    find: 'if (trimmed.length > INLINE_NOTE_MAX) {',
    replace: 'if (false) { /* MUT */' },
  { id: 'punchlist · inline note no longer logs (a note op no longer records a [NOTE] ## Log line)', file: SESSION_PUNCHLIST, test: SESSION_PUNCHLIST_TEST,
    find: "logOp(ctx, 'NOTE', item);",
    replace: '/* MUT: note no longer logs */' },
  { id: 'punchlist · --log offload no longer writes the [PLNOTE] ledger line (full detail lost)', file: SESSION_PUNCHLIST, test: SESSION_PUNCHLIST_TEST,
    find: "status: 'PLNOTE',",
    replace: "status: 'XPLNOTE', /* MUT */" },
  { id: 'punchlist · carry copy drags prior notes forward (should be notes: [])', file: SESSION_PUNCHLIST, test: SESSION_PUNCHLIST_TEST,
    find: 'notes: [], // #1095: carry NEVER copies prior notes — each session\'s copy holds only its own.',
    replace: 'notes: src.item.notes || [], // MUT: carry drags notes' },
  { id: 'punchlist · cross-session close copy drags prior notes forward (should be notes: [])', file: SESSION_PUNCHLIST, test: SESSION_PUNCHLIST_TEST,
    find: 'notes: [], // #1095: carry/close NEVER copy prior notes — each session\'s copy holds only its own.',
    replace: 'notes: src.item.notes || [], // MUT: close drags notes' },

  // ── tpm-session-boot-read.js (boot emit) ─────────────────────────────────────
  { id: 'boot-read · current-session exclusion neutered (would emit the just-opened session)', file: SESSION_BOOT_READ, test: SESSION_BOOT_READ_TEST,
    find: 'if (currentNumber && n === currentNumber) continue;',
    replace: 'if (false) continue; /* MUT */' },
  { id: 'boot-read · v1 gate neutered (would select a non-v1.0 / unmarked prior instead of ignoring it)', file: SESSION_BOOT_READ, test: SESSION_BOOT_READ_TEST,
    find: 'if (!readsAsV1(handoffPath)) continue;',
    replace: 'if (false) continue; /* MUT */' },
  // #1095 boot-read: the templated `lineage` pointer emitted when there is ≥1 open item.
  { id: 'boot-read · lineage pointer never emitted (the #1095 boot pointer is dropped)', file: SESSION_BOOT_READ, test: SESSION_BOOT_READ_TEST,
    find: 'if (pointerSlug) out.push(',
    replace: 'if (false) out.push( /* MUT */' },
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
    ['tpm-session-save.js', SESSION_SAVE_TEST],
    ['tpm-session-punchlist.js', SESSION_PUNCHLIST_TEST],
    ['tpm-session-boot-read.js', SESSION_BOOT_READ_TEST],
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
