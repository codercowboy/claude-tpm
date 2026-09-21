#!/usr/bin/env node
/**
 * tests/session/tpm-session-boot-read/test.js — genuine tests for tools/session/tpm-session-boot-read.js,
 * UPDATED for the #1094 naming sweep + version read-gate (spec §13.6).
 *
 * PURPOSE
 *   Drives tpm-session-boot-read.js as a real subprocess against fixture sandbox dirs and asserts on
 *   its stdout AND — the load-bearing contract — that it EXITS 0 IN EVERY CASE (it must never crash
 *   boot). Coverage under the new model:
 *     • a v1.0 prior session -> RICH emit: session-NNNN-handoff.md VERBATIM + open punchlist count/items
 *       + the three PREFIXED file locations + the bottom-to-top log reminder
 *     • it emits the highest PRIOR v1.0 session and EXCLUDES the just-opened current one
 *     • VERSION READ-GATE: a non-v1.0 / unmarked / handoff-less prior is IGNORED (skip-and-continue),
 *       NOT parsed and NOT pointed-at — the point-at-path tier is REMOVED. If none qualify -> "first
 *       session". A mix of a v1.0 + a non-v1.0 prior selects the v1.0 one.
 *     • no prior / missing dir / empty dir -> clean messages
 *     • exit 0 in ALL of the above
 *
 * HOW TO RUN
 *   node tests/session/tpm-session-boot-read/test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeChecker, runNode, mkSandbox, TOOLS } = require('../lib/harness');

const fmt = require(TOOLS.format);
const { check, count } = makeChecker();

function openSession(sessionsDir) {
  const r = runNode(TOOLS.currentSession, ['--sessions-dir', sessionsDir, '--open']);
  assert.strictEqual(r.code, 0, `helper openSession failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function bootRead(dir) {
  return runNode(TOOLS.sessionBootRead, ['--sessions-dir', dir]);
}

/** Seed a v1.0 three-file session at the PREFIXED paths (via the SSOT → carries the 1.0 preamble). */
function seedNewFormatSession(dir, number, { where, next, openText, mustNot, noteText }) {
  const folder = path.join(dir, `session-${number}`);
  fs.mkdirSync(folder, { recursive: true });
  const num = Number(number);
  const items = openText
    ? [{ done: false, session: num, n: 1, text: openText, slug: 'sl1234', created: '2026-09-16T10:00:00-07:00', closed: null,
        notes: noteText ? [{ date: '2026-09-16', text: noteText }] : [] }]
    : [];
  fs.writeFileSync(path.join(folder, `session-${number}-punchlist.md`), fmt.renderPunchlist({ number, date: '2026-09-16', items }));
  fs.writeFileSync(path.join(folder, `session-${number}-log.md`), fmt.renderNote({ number, date: '2026-09-16', theme: 't', decisions: [], log: [] }));
  const openSpecs = items.map((it) => ({ session: it.session, n: it.n, text: it.text, slug: it.slug, created: it.created }));
  fs.writeFileSync(path.join(folder, `session-${number}-handoff.md`), fmt.renderHandoff({ where, next, must_not_redo: mustNot }, openSpecs, { number, date: '2026-09-16' }));
}

/** Seed a NON-v1.0 prior: a hand-made session-NNNN-handoff.md WITHOUT the version preamble. */
function seedNonV1Session(dir, number, marker = 'OLD-UNMARKED-BODY') {
  const folder = path.join(dir, `session-${number}`);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `session-${number}-handoff.md`),
    `# HANDOFF — session ${number} — 2020-01-01\n\n## Where we are / Next / In flight\n**Where we are:** ${marker}\n`);
  // sanity: this hand-made file must NOT read as v1.0
  assert.ok(!fmt.readsAsV1(path.join(folder, `session-${number}-handoff.md`)), 'fixture must be non-v1.0');
}

// =====================================================================================
// no prior / degenerate inputs — clean messages, ALWAYS exit 0
// =====================================================================================

check('no prior session -> a clean "first session" message, exit 0', () => {
  const dir = mkSandbox('br-no-prior');
  openSession(dir); // mints session 0001; there is no PRIOR
  const r = bootRead(dir);
  assert.strictEqual(r.code, 0);
  assert.ok(/no prior session found/.test(r.stdout));
});

check('a missing/nonexistent sessions dir -> clean message, exit 0 (never crashes boot)', () => {
  const r = runNode(TOOLS.sessionBootRead, ['--sessions-dir', '/nonexistent/does/not/exist-xyz']);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.length > 0, 'must still print something');
});

check('an empty sessions dir (no session-NNNN folders) -> clean message, exit 0', () => {
  const dir = mkSandbox('br-empty');
  const r = bootRead(dir);
  assert.strictEqual(r.code, 0);
  assert.ok(/no prior session found/.test(r.stdout));
});

check('CLI: --help exits 0', () => {
  const r = runNode(TOOLS.sessionBootRead, ['--help']);
  assert.strictEqual(r.code, 0);
  assert.ok(/Usage: npx tpm session boot-read/.test(r.stdout));
});

// =====================================================================================
// v1.0 RICH emit (PREFIXED file names)
// =====================================================================================

check('v1.0 prior -> RICH emit: handoff VERBATIM + open punchlist + PREFIXED file locations + bottom-to-top', () => {
  const dir = mkSandbox('br-rich');
  seedNewFormatSession(dir, '0020', {
    where: 'finished the write path', next: 'wire boot-read', openText: 'carryover task', mustNot: ['do not re-add resume'],
  });
  // No current session opened -> currentNumber is null -> highest prior = 0020.
  const r = bootRead(dir);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(/== PRIOR SESSION 0020 /.test(r.stdout), 'names the prior session (padded-4)');
  // handoff verbatim: Where/Next AND the MUST NOT redo line come through
  assert.ok(/finished the write path/.test(r.stdout), 'handoff Where emitted verbatim');
  assert.ok(/wire boot-read/.test(r.stdout), 'handoff Next emitted verbatim');
  assert.ok(/do not re-add resume/.test(r.stdout), 'handoff MUST NOT redo emitted verbatim');
  // open punchlist
  assert.ok(/OPEN PUNCHLIST \(1\)/.test(r.stdout), 'open punchlist count');
  assert.ok(/carryover task/.test(r.stdout), 'the open item text');
  // PREFIXED file locations + reminder
  assert.ok(/session-0020-handoff\.md/.test(r.stdout), 'prefixed handoff file location');
  assert.ok(/session-0020-punchlist\.md/.test(r.stdout), 'prefixed punchlist file location');
  assert.ok(/session-0020-log\.md/.test(r.stdout), 'prefixed log file location');
  assert.ok(/bottom-to-top/.test(r.stdout), 'the bottom-to-top log reminder');
});

check('v1.0 prior with zero open items -> emit shows "(no open punchlist items)"', () => {
  const dir = mkSandbox('br-rich-empty-punch');
  seedNewFormatSession(dir, '0020', { where: 'w', next: 'n' });
  const r = bootRead(dir);
  assert.strictEqual(r.code, 0);
  assert.ok(/OPEN PUNCHLIST \(0\)/.test(r.stdout));
  assert.ok(/no open punchlist items/.test(r.stdout));
});

check('boot-read EXCLUDES the just-opened current session, emitting the PRIOR one', () => {
  const dir = mkSandbox('br-exclude-current');
  // Prior session 0001 (v1.0, distinctive marker).
  seedNewFormatSession(dir, '0001', { where: 'WHERE-PRIOR-ONE', next: 'next-one' });
  // Opening now mints session 0002 (0001 already exists) and writes the current pointer.
  const opened = openSession(dir);
  assert.strictEqual(opened.number, '0002', 'sanity: the newly-opened session is 0002 (padded-4)');
  // Give 0002 its own handoff too, so "highest folder" would be 0002 if exclusion were broken.
  seedNewFormatSession(dir, '0002', { where: 'WHERE-CURRENT-TWO', next: 'next-two' });

  const r = bootRead(dir);
  assert.strictEqual(r.code, 0);
  assert.ok(/== PRIOR SESSION 0001 /.test(r.stdout), 'must emit PRIOR session 0001');
  assert.ok(/WHERE-PRIOR-ONE/.test(r.stdout), 'must emit the prior session content');
  assert.ok(!/WHERE-CURRENT-TWO/.test(r.stdout), 'must NOT emit the current (just-opened) session');
  assert.ok(!/PRIOR SESSION 0002/.test(r.stdout), 'must NOT name the current session as prior');
});

// =====================================================================================
// VERSION READ-GATE: a non-v1.0 / handoff-less prior is IGNORED (no point-at-path tier)
// =====================================================================================

check('READ-GATE: a non-v1.0 (unmarked handoff) prior is IGNORED — "no prior session found", NOT parsed, NOT pointed-at', () => {
  const dir = mkSandbox('br-nonv1-ignored');
  seedNonV1Session(dir, '0005', 'OLD-UNMARKED-CONTENT');
  const r = bootRead(dir); // no current session -> highest folder = 0005, but it is non-v1.0
  assert.strictEqual(r.code, 0, 'must exit 0 even for an unrecognized/unmarked format');
  assert.ok(/no prior session found/.test(r.stdout), 'a non-v1.0 prior is invisible → first session');
  assert.ok(!/OPEN PUNCHLIST/.test(r.stdout), 'must NOT produce the rich three-file emit for a non-v1.0 folder');
  assert.ok(!/OLD-UNMARKED-CONTENT/.test(r.stdout), 'must NOT parse/emit the non-v1.0 body');
  assert.ok(!/read directly|point/.test(r.stdout), 'the point-at-path tier is REMOVED — no "read directly" pointer');
});

check('READ-GATE: a prior folder with NO handoff at all is IGNORED -> "no prior session found", exit 0', () => {
  const dir = mkSandbox('br-handoffless');
  fs.mkdirSync(path.join(dir, 'session-0007'), { recursive: true }); // empty folder, no prefixed files
  const r = bootRead(dir);
  assert.strictEqual(r.code, 0);
  assert.ok(/no prior session found/.test(r.stdout), 'a handoff-less folder is not a valid v1.0 prior');
});

check('READ-GATE: a mix of a v1.0 session-0021 + a non-v1.0 session-0020 selects 0021 and IGNORES 0020', () => {
  const dir = mkSandbox('br-mixed');
  seedNonV1Session(dir, '0020', 'IGNORE-ME-0020');
  seedNewFormatSession(dir, '0021', { where: 'PICK-ME-0021', next: 'next', openText: 'the open one' });
  const r = bootRead(dir); // no current -> descending [0021, 0020]; 0021 is the first v1.0
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(/== PRIOR SESSION 0021 /.test(r.stdout), 'must select the v1.0 session 0021');
  assert.ok(/PICK-ME-0021/.test(r.stdout), 'must emit the v1.0 session content');
  assert.ok(!/PRIOR SESSION 0020/.test(r.stdout), 'must NOT select the non-v1.0 session 0020');
  assert.ok(!/IGNORE-ME-0020/.test(r.stdout), 'must NOT parse/emit the non-v1.0 body');
});

// =====================================================================================
// #1095 — boot-read surfacing: HEADLINE open items only (NO notes) + ONE templated `lineage`
// pointer using a REAL slug from the list; the pointer is OMITTED when there are 0 open items.
// The `lineage` reader itself is #1092 (OUT OF SCOPE) — assert only that the pointer LINE is emitted.
// =====================================================================================

check('#1095 boot-read: emits ONE `lineage <real-slug>` pointer using a slug from the open list, and surfaces NO note text', () => {
  const dir = mkSandbox('br-note-pointer');
  seedNewFormatSession(dir, '0030', { where: 'w', next: 'n', openText: 'an open item', noteText: 'SECRET-NOTE-BODY-DO-NOT-SURFACE' });
  // sanity: the seeded punchlist really does carry the note (so "absent from boot-read" is meaningful).
  assert.ok(/SECRET-NOTE-BODY-DO-NOT-SURFACE/.test(fs.readFileSync(path.join(dir, 'session-0030', 'session-0030-punchlist.md'), 'utf8')),
    'fixture sanity: the note must be in the punchlist file');

  const r = bootRead(dir);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(/an open item/.test(r.stdout), 'the open-item HEADLINE is surfaced');
  // the pointer uses the REAL open-item slug (sl1234), templated exactly once.
  assert.ok(/for more detail: npx tpm session punchlist lineage sl1234/.test(r.stdout),
    `the lineage pointer must use the real open-item slug: ${r.stdout}`);
  const pointerCount = (r.stdout.match(/for more detail: npx tpm session punchlist lineage/g) || []).length;
  assert.strictEqual(pointerCount, 1, 'exactly ONE lineage pointer line');
  // NO note text and NO note sub-bullets bleed into boot-read (headlines only — #1095).
  assert.ok(!/SECRET-NOTE-BODY-DO-NOT-SURFACE/.test(r.stdout), 'boot-read must NOT surface note text');
  assert.ok(!/^- note /m.test(r.stdout), 'boot-read must not emit any `- note` sub-bullet');
});

check('#1095 boot-read: OMITS the lineage pointer when there are 0 open items', () => {
  const dir = mkSandbox('br-note-nopointer');
  seedNewFormatSession(dir, '0030', { where: 'w', next: 'n' }); // no open items
  const r = bootRead(dir);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(/OPEN PUNCHLIST \(0\)/.test(r.stdout), 'zero open items');
  assert.ok(!/for more detail: npx tpm session punchlist lineage/.test(r.stdout),
    'the lineage pointer must be OMITTED when nothing is open (nothing to point at)');
});

process.stdout.write(`\nALL PASS (${count()} checks) — tests/session/tpm-session-boot-read/test.js\n`);
process.exit(0);
