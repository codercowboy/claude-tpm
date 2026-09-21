#!/usr/bin/env node
/**
 * tests/session/lib-format/test.js — genuine tests for tools/session/tpm-session-format.js,
 * UPDATED for the #1094 naming sweep (4-digit numbering + session-number-prefixed filenames +
 * the `tpm-session-version: 1.0` preamble read-gate; spec §13.6).
 *
 * PURPOSE
 *   tpm-session-format.js is the write/read token SSOT for the three files a session folder holds:
 *     • session-NNNN-log.md       — the append-only ledger (Decisions + Log, TRAILING [ISO-TZ])
 *     • session-NNNN-punchlist.md — the open/done work list (#<session>.<n> + [slug, created])
 *     • session-NNNN-handoff.md   — the pickup doc (Where/Next/In-flight head + What-remains + MUST-NOT)
 *   plus the shared wayfinding-header generator (now carrying the `tpm-session-version: 1.0` sentinel
 *   and the session-number-prefixed filenames) + the `readsAsV1`/`contentReadsAsV1` reader gate +
 *   slug/ISO-TZ/title helpers. Every function is pure (no CLI) so they're tested in-process against
 *   real content strings, asserting on the actual parsed/rendered values — not "it didn't throw."
 *
 *   NAMING SWEEP (#1094): numbers are ONE zero-padded-4 string everywhere (folder/file/title/header);
 *   punchlist item ids stay UNPADDED ints (#20.4). The old `session-notes`/`notes` THIS-FILE label is
 *   GONE — the ledger label is `log`. The header carries `tpm-session-version: 1.0` + the prefixed
 *   `files:` list, and `readsAsV1` gates every reader (an unmarked/old file reads as NOT v1.0).
 *
 *   ISO-TZ is asserted by SHAPE (/[+-]\d{2}:\d{2}$/), never a literal offset (CI may run in UTC).
 *
 * HOW TO RUN
 *   node tests/session/lib-format/test.js
 *   Exits 0 + "ALL PASS" if every assertion holds, else exits non-zero on the first failure.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeChecker, mkSandbox, TOOLS } = require('../lib/harness');

const fmt = require(TOOLS.format);
const { check, count } = makeChecker();

const ISO_TZ_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

// A minimal Date-like object so nowIsoTz's offset math can be pinned WITHOUT depending on the CI
// machine's timezone. nowIsoTz only calls getFullYear/getMonth/getDate/getHours/getMinutes/
// getSeconds/getTimezoneOffset.
function fakeDate(offsetMinutes) {
  return {
    getFullYear: () => 2026,
    getMonth: () => 8, // September (0-based)
    getDate: () => 16,
    getHours: () => 14,
    getMinutes: () => 23,
    getSeconds: () => 7,
    getTimezoneOffset: () => offsetMinutes,
  };
}

// ---- helpers: randomSlug ------------------------------------------------------

check('randomSlug returns a 6-char base36 string by default (500 samples all conform)', () => {
  for (let i = 0; i < 500; i += 1) {
    const s = fmt.randomSlug();
    assert.strictEqual(s.length, 6, `slug "${s}" is not 6 chars`);
    assert.ok(/^[0-9a-z]{6}$/.test(s), `slug "${s}" is not base36`);
  }
  assert.strictEqual(fmt.randomSlug(10).length, 10, 'honors an explicit length');
});

// ---- helpers: nowIsoTz (shape + offset-sign math, TZ-independent) -------------

check('nowIsoTz emits the ISO-8601-with-TZ SHAPE for the real local clock', () => {
  assert.ok(ISO_TZ_SHAPE.test(fmt.nowIsoTz()), 'nowIsoTz() must match YYYY-MM-DDTHH:MM:SS±HH:MM');
});

check('nowIsoTz derives the offset from getTimezoneOffset with the sign FLIPPED (UTC-7 -> -07:00)', () => {
  // getTimezoneOffset() returns minutes BEHIND UTC: 420 for UTC-7.
  assert.strictEqual(fmt.nowIsoTz(fakeDate(420)), '2026-09-16T14:23:07-07:00');
});

check('nowIsoTz handles a sub-hour negative offset (UTC+5:30 -> +05:30)', () => {
  assert.strictEqual(fmt.nowIsoTz(fakeDate(-330)), '2026-09-16T14:23:07+05:30');
});

check('nowIsoTz renders a zero offset as +00:00, never -00:00', () => {
  assert.strictEqual(fmt.nowIsoTz(fakeDate(0)), '2026-09-16T14:23:07+00:00');
});

// ---- helpers: todayISODate / buildTitle / nextPunchlistN ----------------------

check('todayISODate emits a local YYYY-MM-DD (not a UTC Z timestamp)', () => {
  assert.strictEqual(fmt.todayISODate(fakeDate(420)), '2026-09-16');
});

check('buildTitle renders the exact canonical title line with the padded-4 number', () => {
  assert.strictEqual(
    fmt.buildTitle('0008', '2026-08-30', 'built the session tools'),
    '# SESSION 0008 — 2026-08-30 — built the session tools',
  );
});

check('TITLE_RE parses a padded-4 SESSION title (not a 3-digit one)', () => {
  const m = fmt.TITLE_RE.exec('# SESSION 0020 — 2026-09-16 — theme text');
  assert.ok(m, 'a 4-digit SESSION title must parse');
  assert.strictEqual(m[1], '0020');
  assert.strictEqual(fmt.TITLE_RE.exec('# SESSION 020 — 2026-09-16 — theme'), null,
    'a 3-digit number is NOT a valid v1.0 title (numbering is padded-4)');
});

check('nextPunchlistN returns 1 for an empty list, and max(n)+1 (NOT length+1) within the session', () => {
  assert.strictEqual(fmt.nextPunchlistN([], 20), 1);
  assert.strictEqual(fmt.nextPunchlistN(undefined, 20), 1);
  // Non-contiguous ns for session 20: a length-based bug would return 3, not 6.
  const items = [{ session: 20, n: 5 }, { session: 20, n: 1 }, { session: 21, n: 9 }];
  assert.strictEqual(fmt.nextPunchlistN(items, 20), 6, 'max n for THIS session +1');
  assert.strictEqual(fmt.nextPunchlistN(items, 21), 10, 'scoped per-session, not global');
  assert.strictEqual(fmt.nextPunchlistN(items, 99), 1, 'a session with no items starts at 1');
});

// ---- wayfinding header (§12.3, §13.6): version sentinel + prefixed filenames ----

check('buildWayfindingHeader carries the tpm-session-version: 1.0 sentinel + the prefixed files: list', () => {
  const h = fmt.buildWayfindingHeader('0020', '2026-09-16', 'handoff');
  const anchor = h.split('\n')[0];
  assert.ok(/tpm-session-version:\s*1\.0\b/.test(anchor), 'the anchor comment must carry the 1.0 sentinel');
  assert.ok(anchor.includes('files: session-0020-handoff.md, session-0020-punchlist.md, session-0020-log.md'),
    `the anchor must name the three session-number-prefixed files: ${anchor}`);
  // the body bullets name the prefixed files too
  assert.ok(h.includes('**session-0020-handoff.md**'), 'handoff bullet is prefixed');
  assert.ok(h.includes('**session-0020-punchlist.md**'), 'punchlist bullet is prefixed');
  assert.ok(h.includes('**session-0020-log.md**'), 'log bullet is prefixed');
});

check('buildWayfindingHeader is byte-identical across the three files EXCEPT the THIS-FILE token (label is log, not session-notes)', () => {
  const h = fmt.buildWayfindingHeader('0020', '2026-09-16', 'handoff');
  const p = fmt.buildWayfindingHeader('0020', '2026-09-16', 'punchlist');
  const l = fmt.buildWayfindingHeader('0020', '2026-09-16', 'log');

  assert.ok(h.includes('THIS FILE: handoff.'));
  assert.ok(p.includes('THIS FILE: punchlist.'));
  assert.ok(l.includes('THIS FILE: log.'), 'the ledger THIS-FILE label is now "log"');

  // Neutralize ONLY the THIS-FILE token; everything else must be identical across the three.
  const strip = (s) => s.replace(/THIS FILE: [a-z-]+\./, 'THIS FILE: X.');
  assert.strictEqual(strip(h), strip(p), 'handoff vs punchlist differ beyond THIS-FILE');
  assert.strictEqual(strip(h), strip(l), 'handoff vs log differ beyond THIS-FILE');

  // The anchor comment line the refresh keys on must be present and matchable.
  const anchorLine = h.split('\n')[0];
  assert.ok(fmt.HEADER_ANCHOR_RE.test(anchorLine), 'first line must match HEADER_ANCHOR_RE');
});

check('refreshWayfindingHeader replaces ONLY the header block — the body stays byte-stable', () => {
  const body = '# SESSION 0020 — 2026-09-16 — t\n\n## Log\n- [WIP] x  [2026-09-16T00:00:00+00:00]\n';
  const withHeader = `${fmt.buildWayfindingHeader('0020', '2026-09-01', 'log')}\n\n${body}`;
  const refreshed = fmt.refreshWayfindingHeader(withHeader, { number: '0020', date: '2026-09-16', thisFile: 'log' });
  // The date in the header must update...
  assert.ok(refreshed.includes('2026-09-16'), 'header date must refresh');
  // ...and the body after the header must be preserved exactly (byte-stable).
  assert.ok(refreshed.endsWith(body), 'the body must survive a header refresh byte-for-byte');
  // Refreshing twice must not accumulate a second anchor line.
  const twice = fmt.refreshWayfindingHeader(refreshed, { number: '0020', date: '2026-09-17', thisFile: 'log' });
  const anchorCount = (twice.match(/^<!-- tpm-session: /gm) || []).length;
  assert.strictEqual(anchorCount, 1, 'a repeated refresh must not stack header anchors');
});

// ---- version read-gate: readsAsV1 / contentReadsAsV1 (§13.6) -------------------

check('contentReadsAsV1 is true for a rendered file, false for unmarked/old content', () => {
  const rendered = fmt.renderNote({ number: '0020', date: '2026-09-16', theme: 't', decisions: [], log: [] });
  assert.strictEqual(fmt.contentReadsAsV1(rendered), true, 'a freshly rendered file reads as v1.0');
  assert.strictEqual(fmt.contentReadsAsV1('Just freeform prose from before the tool.\n'), false,
    'an unmarked/old file must NOT read as v1.0 (it is IGNORED by readers, not parsed)');
  assert.strictEqual(fmt.contentReadsAsV1(''), false, 'empty content is not v1.0');
  assert.strictEqual(fmt.contentReadsAsV1(null), false, 'non-string content is not v1.0');
});

check('contentReadsAsV1 matches 1.0 on a word boundary — 1.05 does NOT read as v1.0', () => {
  assert.strictEqual(fmt.contentReadsAsV1('<!-- tpm-session: 0020 · tpm-session-version: 1.0 -->'), true);
  assert.strictEqual(fmt.contentReadsAsV1('<!-- tpm-session-version: 1.05 -->'), false,
    'a future 1.05 preamble must not masquerade as 1.0 (\\b after the 0)');
  assert.strictEqual(fmt.contentReadsAsV1('<!-- tpm-session-version: 2.0 -->'), false);
});

check('readsAsV1 reads a real file: true on a rendered file, false on an unmarked file, false on a missing path', () => {
  const dir = mkSandbox('readsasv1');
  const good = path.join(dir, 'good.md');
  const bad = path.join(dir, 'bad.md');
  fs.writeFileSync(good, fmt.renderPunchlist({ number: '0020', date: '2026-09-16', items: [] }));
  fs.writeFileSync(bad, '# SESSION 0020 — 2026-09-16 — old\n\nno version preamble here\n');
  assert.strictEqual(fmt.readsAsV1(good), true, 'a rendered file on disk reads as v1.0');
  assert.strictEqual(fmt.readsAsV1(bad), false, 'a hand-made unmarked file reads as NOT v1.0 (ignored)');
  assert.strictEqual(fmt.readsAsV1(path.join(dir, 'nope.md')), false,
    'a missing path must return false, never throw (ENOENT swallowed)');
});

// ---- session-notes.md ledger: render <-> parse round-trip ---------------------

check('renderNote round-trips through parseNote (header + title + Decisions + Log, trailing ts)', () => {
  const sections = {
    number: '0009',
    date: '2026-08-31',
    theme: 'round-trip check',
    decisions: [{ what: 'chose X', why: 'because Y', ts: '2026-08-31T09:00:00-07:00' }],
    log: [{ status: 'WIP', text: 'started', ts: '2026-08-31T10:00:00-07:00' }],
    sealedAt: null,
  };
  const reparsed = fmt.parseNote(fmt.renderNote(sections));
  assert.strictEqual(reparsed.number, '0009');
  assert.strictEqual(reparsed.date, '2026-08-31');
  assert.strictEqual(reparsed.theme, 'round-trip check');
  assert.deepStrictEqual(reparsed.decisions, sections.decisions);
  assert.deepStrictEqual(reparsed.log, sections.log);
  assert.strictEqual(reparsed.sealedAt, null);
});

check('a rendered ledger carries the v1.0 preamble and the log THIS-FILE label', () => {
  const rendered = fmt.renderNote({ number: '0009', date: '2026-08-31', theme: 't', decisions: [], log: [] });
  assert.ok(fmt.contentReadsAsV1(rendered), 'a rendered ledger must carry the 1.0 preamble');
  assert.ok(/THIS FILE: log\./.test(rendered), 'renderNote uses the "log" THIS-FILE label');
});

check('a rendered Log line carries a TRAILING [ISO-TZ] (shape, not a literal offset)', () => {
  const rendered = fmt.renderNote({
    number: '0009', date: '2026-08-31', theme: 't',
    decisions: [], log: [{ status: 'DONE', text: 'shipped', ts: fmt.nowIsoTz() }],
  });
  const logLine = rendered.split('\n').find((l) => l.includes('shipped'));
  assert.ok(/^- \[DONE\] shipped  \[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\]$/.test(logLine),
    `log line shape wrong: ${logLine}`);
});

check('the OLD single-file sections are GONE — renderNote emits no RESUME / Open items headings', () => {
  const rendered = fmt.renderNote({ number: '0001', date: '2026-01-01', theme: 't', decisions: [], log: [] });
  assert.ok(!/## RESUME/.test(rendered), 'no ## RESUME in the new ledger');
  assert.ok(!/## Open items/.test(rendered), 'no ## Open items in the new ledger');
  assert.ok(rendered.includes('## Decisions') && rendered.includes('## Log'), 'ledger IS Decisions + Log');
});

check('renderNote appends a SEALED trailer only when sealedAt is set', () => {
  const base = { number: '0001', date: '2026-01-01', theme: 't', decisions: [], log: [] };
  assert.ok(!fmt.renderNote(base).includes('SEALED'), 'unsealed render must not contain SEALED');
  const sealed = fmt.renderNote({ ...base, sealedAt: '2026-01-02' });
  assert.ok(sealed.includes('SEALED 2026-01-02'), 'sealed render must carry the stamp');
  assert.strictEqual(fmt.parseNote(sealed).sealedAt, '2026-01-02');
});

check('a non-canonical status tag round-trips (free text, not dropped) and a [bracket] in the text does not steal the ts', () => {
  const withCustom = fmt.renderNote({
    number: '0010', date: '2026-08-30', theme: 't',
    decisions: [],
    log: [
      { status: 'CUSTOM', text: 'a line with a [bracket] inside it', ts: '2026-08-30T00:00:00-07:00' },
      { status: 'DONE', text: 'a canonical entry', ts: '2026-08-30T00:00:01-07:00' },
    ],
  });
  const p = fmt.parseNote(withCustom);
  assert.strictEqual(p.log.length, 2, 'both entries survive parsing');
  assert.strictEqual(p.log[0].status, 'CUSTOM');
  assert.strictEqual(p.log[0].text, 'a line with a [bracket] inside it', 'inner bracket kept in text; trailing ts not stolen');
  assert.strictEqual(p.log[0].ts, '2026-08-30T00:00:00-07:00');
  assert.strictEqual(p.log[1].status, 'DONE');
});

check('parseNote on a freeform legacy note (no "# SESSION NNNN" title) reports number: null', () => {
  const p = fmt.parseNote('Just prose from before the tool existed.\n\nNo headings.\n');
  assert.strictEqual(p.number, null);
  assert.strictEqual(p.date, null);
  assert.deepStrictEqual(p.decisions, []);
  assert.deepStrictEqual(p.log, []);
});

// ---- punchlist.md: render <-> parse round-trip --------------------------------

check('renderPunchlist round-trips through parsePunchlist (open + done, ids/slug/created/closed)', () => {
  const items = [
    { done: false, session: 20, n: 1, id: '20.1', text: 'open task', slug: 'ab12cd', created: '2026-09-16T10:00:00-07:00', closed: null, notes: [] },
    { done: true, session: 20, n: 2, id: '20.2', text: 'done task', slug: 'ef34gh', created: '2026-09-16T10:01:00-07:00', closed: '2026-09-16T11:00:00-07:00', notes: [] },
  ];
  const parsed = fmt.parsePunchlist(fmt.renderPunchlist({ number: '0020', date: '2026-09-16', items }));
  assert.strictEqual(parsed.items.length, 2);
  assert.deepStrictEqual(parsed.items[0], items[0]);
  assert.deepStrictEqual(parsed.items[1], items[1]);
});

check('punchlist ids stay UNPADDED even when the session number is padded-4 (#20.4, never #0020.4)', () => {
  // Pass the padded-4 session number; the render must strip the leading zeros in the id.
  const rendered = fmt.renderPunchlist({
    number: '0020', date: '2026-09-16',
    items: [{ done: false, session: '0020', n: 4, text: 't', slug: 'zz99zz', created: '2026-09-16T10:00:00-07:00', closed: null }],
  });
  assert.ok(rendered.includes('#20.4 ·'), 'id session component must be an int');
  assert.ok(!rendered.includes('#0020.4'), 'id must NOT carry the padding of the folder number');
  const parsed = fmt.parsePunchlist(rendered);
  assert.strictEqual(parsed.items[0].session, 20);
  assert.strictEqual(parsed.items[0].id, '20.4');
});

// ---- #1095: punchlist item NOTES (NOTE_SUB_RE parse/render + freshNoteSlug) ----
// The note channel is dated single-line sub-bullets attached to the item that PRECEDES them. The
// parser attaches each `- note <date>: <text>` to the MOST-RECENT item; render emits them flush after
// the item line; a zero-note item renders BYTE-IDENTICALLY to pre-#1095 (R2). ISO-date by SHAPE.

check('NOTE_SUB_RE matches BOTH the inline + sentinel note forms and is prefix-disjoint from an item line', () => {
  const inline = fmt.NOTE_SUB_RE.exec('- note 2026-09-18: due Tuesday, slipped a day');
  assert.ok(inline, 'inline note must match');
  assert.strictEqual(inline[1], '2026-09-18');
  assert.strictEqual(inline[2], 'due Tuesday, slipped a day');
  const sentinel = fmt.NOTE_SUB_RE.exec('- note 2026-09-19: see-log:session-0020-log.md:zz9kap');
  assert.ok(sentinel, 'sentinel note must match the same regex (distinguishing is #1092\'s job)');
  assert.strictEqual(sentinel[2], 'see-log:session-0020-log.md:zz9kap');
  // R1: a note line is NOT an item, and an item line is NOT a note — the two grammars never cross.
  assert.strictEqual(fmt.NOTE_SUB_RE.exec('- [ ] #20.1 · a task  [aaa111, 2026-09-16T10:00:00-07:00]'), null,
    'a punchlist item line must NOT match NOTE_SUB_RE');
  assert.strictEqual(fmt.PUNCHLIST_ITEM_RE.exec('- note 2026-09-18: due Tuesday'), null,
    'a note sub-bullet must NOT match PUNCHLIST_ITEM_RE');
});

check('parsePunchlist attaches note sub-bullets to the PRECEDING item (item count unchanged; a note before any item is IGNORED)', () => {
  const content = [
    '## Open',
    '- [ ] #20.1 · first item  [aaa111, 2026-09-16T10:00:00-07:00]',
    '- note 2026-09-18: a terse inline note',
    '- note 2026-09-19: see-log:session-0020-log.md:zz9kap',
    '- [ ] #20.2 · second item  [bbb222, 2026-09-16T10:01:00-07:00]',
    '## Done',
  ].join('\n');
  const p = fmt.parsePunchlist(content);
  assert.strictEqual(p.items.length, 2, 'note lines must NOT be mis-parsed as items (R1)');
  assert.deepStrictEqual(p.items[0].notes, [
    { date: '2026-09-18', text: 'a terse inline note' },
    { date: '2026-09-19', text: 'see-log:session-0020-log.md:zz9kap' },
  ], 'both notes attach to the item that precedes them');
  assert.deepStrictEqual(p.items[1].notes, [], 'an item with no following note lines has an empty notes array');

  // A note line before any item is IGNORED (no crash, no phantom item, not attached).
  const orphan = [
    '- note 2026-09-18: orphan note before any item',
    '- [ ] #20.1 · the only item  [aaa111, 2026-09-16T10:00:00-07:00]',
  ].join('\n');
  const po = fmt.parsePunchlist(orphan);
  assert.strictEqual(po.items.length, 1, 'a leading orphan note must not crash or create an item');
  assert.deepStrictEqual(po.items[0].notes, [], 'an orphan note before any item is dropped, not attached');
});

check('renderPunchlistItem emits each note as a flush `- note <date>: <text>` sub-bullet after the item line', () => {
  const item = {
    done: false, session: 20, n: 1, text: 'noted task', slug: 'aaa111',
    created: '2026-09-16T10:00:00-07:00', closed: null,
    notes: [
      { date: '2026-09-18', text: 'due Tuesday' },
      { date: '2026-09-19', text: 'see-log:session-0020-log.md:zz9kap' },
    ],
  };
  const rendered = fmt.renderPunchlist({ number: '0020', date: '2026-09-16', items: [item] });
  assert.ok(rendered.includes('\n- note 2026-09-18: due Tuesday\n'), 'first note sub-bullet must be emitted');
  assert.ok(rendered.includes('\n- note 2026-09-19: see-log:session-0020-log.md:zz9kap'), 'sentinel note sub-bullet emitted');
  // the note lines sit immediately AFTER the item line (they are its sub-bullets).
  const lines = rendered.split('\n');
  const itemIdx = lines.findIndex((l) => l.includes('· noted task'));
  assert.ok(itemIdx >= 0);
  assert.strictEqual(lines[itemIdx + 1], '- note 2026-09-18: due Tuesday');
  assert.strictEqual(lines[itemIdx + 2], '- note 2026-09-19: see-log:session-0020-log.md:zz9kap');
});

check('a punchlist with inline + sentinel notes round-trips through parse (notes preserved exactly)', () => {
  const items = [
    { done: false, session: 20, n: 1, id: '20.1', text: 'open with notes', slug: 'aaa111', created: '2026-09-16T10:00:00-07:00', closed: null,
      notes: [{ date: '2026-09-18', text: 'inline detail' }, { date: '2026-09-19', text: 'see-log:session-0020-log.md:zz9kap' }] },
    { done: true, session: 20, n: 2, id: '20.2', text: 'done no notes', slug: 'bbb222', created: '2026-09-16T10:01:00-07:00', closed: '2026-09-16T11:00:00-07:00', notes: [] },
  ];
  const parsed = fmt.parsePunchlist(fmt.renderPunchlist({ number: '0020', date: '2026-09-16', items }));
  assert.strictEqual(parsed.items.length, 2);
  assert.deepStrictEqual(parsed.items[0], items[0], 'the notes[] survive render→parse byte-for-byte');
  assert.deepStrictEqual(parsed.items[1], items[1]);
});

check('R2: a ZERO-note item renders BYTE-IDENTICALLY whether notes is [] or absent, and emits no `- note` line', () => {
  const base = { done: false, session: 20, n: 1, text: 'plain item', slug: 'aaa111', created: '2026-09-16T10:00:00-07:00', closed: null };
  const withEmpty = fmt.renderPunchlist({ number: '0020', date: '2026-09-16', items: [{ ...base, notes: [] }] });
  const without = fmt.renderPunchlist({ number: '0020', date: '2026-09-16', items: [{ ...base }] });
  assert.strictEqual(withEmpty, without, 'notes:[] must render byte-identically to omitting the notes key (no stray line, no blank line)');
  assert.ok(!/\n- note /.test(withEmpty), 'a zero-note item must emit NO note sub-bullet');
});

check('freshNoteSlug mints a base36 slug distinct from the item slug AND from any note-slug already in use (R6)', () => {
  for (let i = 0; i < 300; i += 1) {
    const s = fmt.freshNoteSlug('abc123', ['def456', 'ghi789']);
    assert.ok(/^[0-9a-z]{6}$/.test(s), `note-slug "${s}" must be 6-char base36`);
    assert.notStrictEqual(s, 'abc123', 'a note-slug must never equal the item slug');
    assert.ok(!['def456', 'ghi789'].includes(s), 'a note-slug must avoid already-used note-slugs');
  }
});

check('openItems returns exactly the not-done items', () => {
  const parsed = fmt.parsePunchlist(fmt.renderPunchlist({
    number: '0020', date: '2026-09-16',
    items: [
      { done: false, session: 20, n: 1, text: 'a', slug: 'aaa111', created: '2026-09-16T10:00:00-07:00', closed: null },
      { done: true, session: 20, n: 2, text: 'b', slug: 'bbb222', created: '2026-09-16T10:00:00-07:00', closed: '2026-09-16T11:00:00-07:00' },
    ],
  }));
  const open = fmt.openItems(parsed);
  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].id, '20.1');
  assert.deepStrictEqual(fmt.openItems(null), [], 'openItems tolerates null');
});

check('renderPunchlist shows empty placeholders for empty sections', () => {
  const rendered = fmt.renderPunchlist({ number: '0020', date: '2026-09-16', items: [] });
  assert.ok(rendered.includes('_No open items._'));
  assert.ok(rendered.includes('_Nothing done yet._'));
});

// ---- handoff.md: render <-> parse round-trip ----------------------------------

check('renderHandoff round-trips through parseHandoff (head + What-remains + MUST-NOT)', () => {
  const payload = { where: 'built the save path', next: 'wire boot-read', in_flight: 'a half-written test', must_not_redo: ['do not re-add resume', 'do not touch config'] };
  const open = [{ session: 20, n: 3, text: 'carryover task', slug: 'cc33cc', created: '2026-09-16T10:00:00-07:00' }];
  const h = fmt.parseHandoff(fmt.renderHandoff(payload, open, { number: '0020', date: '2026-09-16' }));
  assert.strictEqual(h.number, '0020');
  assert.strictEqual(h.date, '2026-09-16');
  assert.strictEqual(h.where, 'built the save path');
  assert.strictEqual(h.next, 'wire boot-read');
  assert.strictEqual(h.inFlight, 'a half-written test');
  assert.strictEqual(h.whatRemains.length, 1);
  assert.strictEqual(h.whatRemains[0].id, '20.3');
  assert.strictEqual(h.whatRemains[0].text, 'carryover task');
  assert.deepStrictEqual(h.mustNotRedo, ['do not re-add resume', 'do not touch config']);
});

check('renderHandoff OMITS the MUST NOT redo section when must_not_redo is absent/empty', () => {
  const withoutMnr = fmt.renderHandoff({ where: 'w', next: 'n' }, [], { number: '0020', date: '2026-09-16' });
  assert.ok(!withoutMnr.includes('## MUST NOT redo'), 'section must be omitted when absent');
  const withEmpty = fmt.renderHandoff({ where: 'w', next: 'n', must_not_redo: [] }, [], { number: '0020', date: '2026-09-16' });
  assert.ok(!withEmpty.includes('## MUST NOT redo'), 'section must be omitted when empty');
});

check('renderHandoff defaults In-flight and shows the empty-remains placeholder', () => {
  const h = fmt.parseHandoff(fmt.renderHandoff({ where: 'w', next: 'n' }, [], { number: '0020', date: '2026-09-16' }));
  assert.strictEqual(h.inFlight, 'Nothing in flight.', 'in_flight defaults');
  assert.deepStrictEqual(h.whatRemains, [], 'no remains items');
  const rendered = fmt.renderHandoff({ where: 'w', next: 'n' }, [], { number: '0020', date: '2026-09-16' });
  assert.ok(rendered.includes('_No open punchlist items._'));
});

check('all three files begin with the SAME wayfinding header bar the THIS-FILE token (cross-file identity)', () => {
  const note = fmt.renderNote({ number: '0020', date: '2026-09-16', theme: 't', decisions: [], log: [] });
  const punch = fmt.renderPunchlist({ number: '0020', date: '2026-09-16', items: [] });
  const handoff = fmt.renderHandoff({ where: 'w', next: 'n' }, [], { number: '0020', date: '2026-09-16' });
  const headerOf = (s) => s.split('\n').slice(0, 5).join('\n');
  const strip = (s) => headerOf(s).replace(/THIS FILE: [a-z-]+\./, 'THIS FILE: X.');
  assert.strictEqual(strip(note), strip(punch), 'notes vs punchlist header differ beyond THIS-FILE');
  assert.strictEqual(strip(note), strip(handoff), 'notes vs handoff header differ beyond THIS-FILE');
});

// ---- naming sweep: NO two session files share a basename (§13.6) --------------

check('prefixed filenames guarantee NO basename collision across sessions (pull several into one dir)', () => {
  // The three canonical basenames for a session number, derived from the header the SSOT emits.
  const basenames = (n) => [`session-${n}-handoff.md`, `session-${n}-punchlist.md`, `session-${n}-log.md`];
  const all = [...basenames('0020'), ...basenames('0021'), ...basenames('0100')];
  assert.strictEqual(new Set(all).size, all.length,
    'every session-file basename across three sessions must be unique — no collision when co-located');
  // And the SSOT header actually emits these prefixed names (not the old generic ones).
  const h = fmt.buildWayfindingHeader('0021', '2026-09-16', 'handoff');
  for (const name of basenames('0021')) {
    assert.ok(h.includes(name), `the header must name the prefixed file ${name}`);
  }
  // The pre-sweep generic names must NOT appear.
  for (const generic of ['session-notes.md', 'handoff.md -->', '· handoff.md,']) {
    assert.ok(!h.includes(generic), `the header must not carry the pre-sweep generic name (${generic})`);
  }
});

process.stdout.write(`\nALL PASS (${count()} checks) — tests/session/lib-format/test.js\n`);
process.exit(0);
