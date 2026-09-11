#!/usr/bin/env node
/**
 * tests/session/lib-format/test.js — genuine tests for tools/session/lib/format.js.
 *
 * PURPOSE
 *   format.js is the write/read token SSOT: buildTitle/parseNote/renderNote/nextOpenItemId.
 *   Every one of these is a pure function (no fs, no CLI) so they're tested in-process,
 *   directly against real content strings, asserting on the actual parsed/rendered values —
 *   not "it didn't throw."
 *
 *   Includes a test (see "log status round-trip" below) pinning that a non-canonical
 *   `--status` tag round-trips through parseNote — session-notes.js's docstring promises
 *   `log <TAG>` is free text ("no enforced enum"), and format.js's LOG_ENTRY_RE must honor
 *   that, not silently drop any tag outside the 6 STATUS_TAGS. (Bug-fixer r1: this test used
 *   to pin the OPPOSITE — the data-loss bug the verifier's verdict flagged as blocking — see
 *   findings/HANDOFF.md "Bug-fixer r1" for the fix write-up.)
 *
 * HOW TO RUN
 *   node tests/session/lib-format/test.js
 *   Exits 0 + "ALL PASS" if every assertion holds, else exits non-zero on the first failure.
 */

'use strict';

const assert = require('assert');
const { makeChecker, TOOLS } = require('../lib/harness');

const fmt = require(TOOLS.format);
const { check, count } = makeChecker();

// ---- buildTitle -------------------------------------------------------------

check('buildTitle renders the exact canonical title line', () => {
  assert.strictEqual(fmt.buildTitle('008', '2026-08-30', 'built the session tools'), '# SESSION 008 — 2026-08-30 — built the session tools');
});

// ---- parseNote: full canonical note ------------------------------------------

const CANONICAL = [
  '# SESSION 008 — 2026-08-30 — session tools build',
  '',
  '## RESUME',
  '**Where we are:** wrote lib/format.js',
  '**Next action:** write session-notes.js',
  '**In flight:** nothing',
  '',
  '## Open items',
  '- [ ] OPEN(jason) #1: review the config-guide patch',
  '- [x] OPEN(jason) #2: write the format module',
  '',
  '## Decisions',
  '- **Decided:** single pointer, not a sessionId map — env var unreliable outside subagents',
  '',
  '## Log',
  '- [WIP] 2026-08-30T10:00:00.000Z — wrote lib/format.js',
  '- [DONE] 2026-08-30T11:00:00.000Z — wrote session-notes.js',
  '',
  'SEALED 2026-08-30',
  '',
].join('\n');

check('parseNote extracts number/date/theme from the title line', () => {
  const p = fmt.parseNote(CANONICAL);
  assert.strictEqual(p.number, '008');
  assert.strictEqual(p.date, '2026-08-30');
  assert.strictEqual(p.theme, 'session tools build');
});

check('parseNote extracts the RESUME block fields verbatim', () => {
  const p = fmt.parseNote(CANONICAL);
  assert.strictEqual(p.resume.whereWeAre, 'wrote lib/format.js');
  assert.strictEqual(p.resume.nextAction, 'write session-notes.js');
  assert.strictEqual(p.resume.inFlight, 'nothing');
});

check('parseNote extracts open items with correct id/owner/done/text', () => {
  const p = fmt.parseNote(CANONICAL);
  assert.strictEqual(p.openItems.length, 2);
  assert.deepStrictEqual(p.openItems[0], { done: false, owner: 'jason', id: 1, text: 'review the config-guide patch' });
  assert.deepStrictEqual(p.openItems[1], { done: true, owner: 'jason', id: 2, text: 'write the format module' });
});

check('parseNote extracts decisions (what/why split on the em dash)', () => {
  const p = fmt.parseNote(CANONICAL);
  assert.strictEqual(p.decisions.length, 1);
  assert.strictEqual(p.decisions[0].what, 'single pointer, not a sessionId map');
  assert.strictEqual(p.decisions[0].why, 'env var unreliable outside subagents');
});

check('parseNote extracts log entries with status/date/text, in file order', () => {
  const p = fmt.parseNote(CANONICAL);
  assert.strictEqual(p.log.length, 2);
  assert.strictEqual(p.log[0].status, 'WIP');
  assert.strictEqual(p.log[0].text, 'wrote lib/format.js');
  assert.strictEqual(p.log[1].status, 'DONE');
  assert.strictEqual(p.log[1].text, 'wrote session-notes.js');
});

check('parseNote extracts the SEALED trailer date', () => {
  const p = fmt.parseNote(CANONICAL);
  assert.strictEqual(p.sealedAt, '2026-08-30');
});

check('parseNote reports sealedAt: null for an unsealed note', () => {
  const p = fmt.parseNote(CANONICAL.replace('\nSEALED 2026-08-30\n', '\n'));
  assert.strictEqual(p.sealedAt, null);
});

// ---- parseNote: legacy / non-canonical note ----------------------------------

check('parseNote on a freeform legacy note (no "# SESSION NNN" title) returns number: null', () => {
  const legacy = 'Just some prose notes from before the tool existed.\n\nNo headings here at all.\n';
  const p = fmt.parseNote(legacy);
  assert.strictEqual(p.number, null);
  assert.strictEqual(p.date, null);
  assert.strictEqual(p.theme, null);
  assert.deepStrictEqual(p.openItems, []);
  assert.deepStrictEqual(p.decisions, []);
  assert.deepStrictEqual(p.log, []);
});

// ---- renderNote / round-trip --------------------------------------------------

check('renderNote round-trips through parseNote for a freshly-built note', () => {
  const sections = {
    number: '009',
    date: '2026-08-31',
    theme: 'round-trip check',
    resume: { whereWeAre: 'A', nextAction: 'B', inFlight: 'C' },
    openItems: [{ id: 1, owner: 'x', done: false, text: 'do a thing' }],
    decisions: [{ what: 'chose X', why: 'because Y' }],
    log: [{ status: 'WIP', date: '2026-08-31T00:00:00.000Z', text: 'started' }],
    sealedAt: null,
  };
  const rendered = fmt.renderNote(sections);
  const reparsed = fmt.parseNote(rendered);
  assert.strictEqual(reparsed.number, sections.number);
  assert.strictEqual(reparsed.date, sections.date);
  assert.strictEqual(reparsed.theme, sections.theme);
  assert.deepStrictEqual(reparsed.resume, sections.resume);
  assert.deepStrictEqual(reparsed.openItems, sections.openItems);
  assert.deepStrictEqual(reparsed.decisions, sections.decisions);
  assert.deepStrictEqual(reparsed.log, sections.log);
  assert.strictEqual(reparsed.sealedAt, null);
});

check('renderNote appends a SEALED trailer only when sealedAt is set', () => {
  const base = { number: '001', date: '2026-01-01', theme: 't', resume: {}, openItems: [], decisions: [], log: [] };
  const unsealed = fmt.renderNote(base);
  const sealed = fmt.renderNote({ ...base, sealedAt: '2026-01-02' });
  assert.ok(!unsealed.includes('SEALED'), 'unsealed render must not contain a SEALED line');
  assert.ok(sealed.includes('SEALED 2026-01-02'), 'sealed render must contain the stamp');
});

check('renderNote renders "None open." for an empty open-items list', () => {
  const rendered = fmt.renderNote({ number: '001', date: '2026-01-01', theme: 't', resume: {}, openItems: [], decisions: [], log: [] });
  assert.ok(rendered.includes('None open.'));
});

// ---- nextOpenItemId -----------------------------------------------------------

check('nextOpenItemId returns 1 for an empty list', () => {
  assert.strictEqual(fmt.nextOpenItemId([]), 1);
  assert.strictEqual(fmt.nextOpenItemId(undefined), 1);
});

check('nextOpenItemId returns max(existing ids) + 1, not length + 1', () => {
  // Deliberately non-contiguous / out-of-order ids: a length-based bug would return 3, not 6.
  assert.strictEqual(fmt.nextOpenItemId([{ id: 5 }, { id: 1 }]), 6);
});

// ---- log status round-trip: a non-canonical status tag is preserved, not dropped ----
//
// session-notes.js's docstring says `log --status <TAG>` takes free text ("no enforced enum").
// LOG_ENTRY_RE must honor that: a bracketed tag outside the 6 STATUS_TAGS must still parse.
// (Bug-fixer r1: prior to this fix, LOG_ENTRY_RE only recognized the 6 STATUS_TAGS values, so
// any log line with a different tag failed to match on the NEXT parse — and because
// session-notes.js always reloads-then-rerenders the whole file (loadOrInitSections ->
// writeSections), the unrecognized entry silently DISAPPEARED from the file the next time
// anything was written to that session. See findings/HANDOFF.md "Bug-fixer r1" and the
// end-to-end CLI regression in tests/session/session-notes/test.js for the full-stack proof.)

check('a log line with a non-canonical status tag IS parsed back (no data loss on re-render)', () => {
  const withCustomTag = [
    '# SESSION 010 — 2026-08-30 — status tag round-trip',
    '',
    '## RESUME',
    '**Where we are:** ',
    '**Next action:** ',
    '**In flight:** Nothing in flight.',
    '',
    '## Open items',
    'None open.',
    '',
    '## Decisions',
    '_None yet._',
    '',
    '## Log',
    '- [CUSTOM] 2026-08-30T00:00:00.000Z — a log line session-notes.js would happily WRITE via --status CUSTOM',
    '- [DONE] 2026-08-30T00:00:01.000Z — a canonical entry right after it',
  ].join('\n');
  const p = fmt.parseNote(withCustomTag);
  // BOTH entries survive parsing — the CUSTOM tag is no longer silently dropped.
  assert.strictEqual(p.log.length, 2);
  assert.strictEqual(p.log[0].status, 'CUSTOM');
  assert.strictEqual(p.log[0].text, 'a log line session-notes.js would happily WRITE via --status CUSTOM');
  assert.strictEqual(p.log[1].status, 'DONE');
});

process.stdout.write(`\nALL PASS (${count()} checks) — tests/session/lib-format/test.js\n`);
process.exit(0);
