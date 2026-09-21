#!/usr/bin/env node
/**
 * tpm-session-format.js — the SHARED SSOT for the THREE-FILE session model (spec §12).
 *
 * PURPOSE
 *   ONE place that owns the canonical headings/tokens/render+parse for the three files a session
 *   folder now holds (spec §2, §12.1, §13.6 — files are session-number-prefixed):
 *     • session-NNNN-log.md       — the append-only LEDGER: Decisions + Log  (§3, §12.5)
 *     • session-NNNN-punchlist.md — the open/done work list (mini task-manager)  (§4, §12.4)
 *     • session-NNNN-handoff.md   — the pickup doc: RESUME-head + What-remains + MUST-NOT-redo  (§5, §12.6)
 *   plus the shared wayfinding-header generator (identical on all three files bar the THIS-FILE
 *   marker — §12.3; it carries the `tpm-session-version: 1.0` sentinel + the prefixed filenames), a
 *   6-char base36 slug helper, an ISO-8601-WITH-TZ timestamp helper, and the `readsAsV1` reader gate.
 *
 *   Every session write/read tool imports THIS module, so on-disk tokens cannot drift:
 *     tpm-session-notes.js  (ledger writer)      → parseNote/renderNote + nowIsoTz
 *     tpm-session-punchlist.js (punchlist writer)→ parsePunchlist/renderPunchlist + slug/nowIsoTz/nextPunchlistN
 *     tpm-session-save.js   (gated checkpoint)    → renderHandoff + refreshWayfindingHeader + openItems
 *     tpm-session-boot-read.js (boot emit)        → parseHandoff/parsePunchlist/openItems + readsAsV1
 *     tpm-session-review.js  (read API)           → parseNote/parseHandoff/parsePunchlist + readsAsV1
 *
 * DESTRUCTIVE REWRITE (ratified 2026-09-17, plan "Ratified build decisions")
 *   The LEGACY single-file format (## RESUME + ## Open items, and the OLD inline-timestamp
 *   `- [TAG] <ISO> — <text>` log shape) is GONE from this SSOT. The reader understands ONLY the new
 *   ledger (Decisions + Log with a TRAILING [ISO-TZ]). RESUME → handoff.md head; Open-items → punchlist.md.
 *   This intentionally breaks tpm-session-review.js + the lib-format/review/notes test suites +
 *   boot-read's rich legacy tier — reconciled downstream (see this phase's findings/HANDOFF.md).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * FILE CONTRACTS (frozen surface for downstream rounds — see §"CONTRACTS" at the bottom for the
 * exact byte-level tokens). All three files begin with the identical wayfinding header block.
 *
 * EXPORTS
 *   Constants: NOTE_HEADINGS, PUNCHLIST_HEADINGS, HANDOFF_HEADINGS, STATUS_TAGS, DECIDED_PREFIX,
 *              SEALED_PREFIX; regexes TITLE_RE, LOG_ENTRY_RE, DECISION_RE, PUNCHLIST_ITEM_RE,
 *              NOTE_SUB_RE, REMAINS_ITEM_RE, HEADER_ANCHOR_RE, VERSION_RE, SEALED_RE.
 *   Helpers:   randomSlug([len]) · freshNoteSlug(itemSlug, used) · nowIsoTz([date]) · todayISODate([date])
 *              · buildTitle(number,date,theme) · nextPunchlistN(items, session)
 *   Header:    buildWayfindingHeader(number, date, thisFile) · stripWayfindingHeader(content)
 *              · refreshWayfindingHeader(content, {number, date, thisFile})
 *   Gate:      readsAsV1(filePath) · contentReadsAsV1(content) — the single reader version gate
 *   Notes:     parseNote(content) · renderNote(sections)
 *   Punchlist: parsePunchlist(content) · renderPunchlist(sections) · openItems(parsed)
 *   Handoff:   renderHandoff(payload, openItemsList, meta) · parseHandoff(content)
 */

'use strict';

const fs = require('fs');

// ── section headings ─────────────────────────────────────────────────────────
const NOTE_HEADINGS = { DECISIONS: '## Decisions', LOG: '## Log' };
const PUNCHLIST_HEADINGS = { OPEN: '## Open', DONE: '## Done' };
const HANDOFF_HEADINGS = {
  HEAD: '## Where we are / Next / In flight',
  REMAINS: '## What remains',
  MUST_NOT: '## MUST NOT redo',
};

const STATUS_TAGS = ['DONE', 'WIP', 'BLOCKED', 'HELD', 'PARKED', 'DROPPED'];
const DECIDED_PREFIX = '**Decided:**';
const SEALED_PREFIX = 'SEALED';

// ── regexes (the on-disk grammar) ──────────────────────────────────────────────
// v1.0 session numbers are zero-padded-4 EVERYWHERE (#1094). This title parser is strict on purpose:
// compatibility with older/mixed folders is owned by the single reader version gate (`readsAsV1` /
// VERSION_RE below) — a pre-v1.0 or inconsistent folder is IGNORED by the readers, NOT leniently
// parsed here. (An in-flight legacy folder is migrated to 4-digit, not tolerated by loosening this.)
const TITLE_RE = /^#\s*SESSION\s+(\d{4})\s*—\s*([^—]+?)\s*—\s*(.+)$/;

// New ledger LOG line (§12.5): `- [<TAG>] <text>  [<ISO-TZ>]` — timestamp TRAILING.
// <TAG> is free text (any bracketed tag round-trips — the STATUS_TAGS set is a convention, not a
// parse-time allowlist; see the Bug-fixer r1 note preserved for the new shape). Text is captured
// non-greedily and the trailing [ISO-TZ] is anchored at end-of-line, so a `[...]` inside the text
// does not steal the timestamp.
const LOG_ENTRY_RE = /^- \[([^\]]+)\] (.*?)\s+\[([^\]]+)\]$/;

// Decision line (§12.5, symmetry): `- **Decided:** <what> — <why>  [<ISO-TZ>]`. The trailing
// [ISO-TZ] is present in tool-written lines; kept OPTIONAL in the regex so a hand-edited decision
// without one still parses (ts → null).
const DECISION_RE = /^- \*\*Decided:\*\* (.+?)\s+—\s+(.+?)(?:\s+\[([^\]]+)\])?$/;

// Punchlist item (§12.4): `- [ |x] #<session>.<n> · <text>  [<slug>, <created-ISO-TZ>]` with an
// optional ` (closed <ISO-TZ>)` suffix on done items. Session component is an INTEGER (no leading
// zeros — `#20.4`, not `#020.4`).
const PUNCHLIST_ITEM_RE = /^- \[( |x)\] #(\d+)\.(\d+) · (.*?)\s+\[([0-9a-z]+), ([^\]]+)\](?: \(closed (.+)\))?$/;

// Punchlist item NOTE sub-bullet (#1095, §13.4): a dated single-line note attached to the item that
// PRECEDES it: `- note <YYYY-MM-DD>: <text>`. DISTINCT from PUNCHLIST_ITEM_RE — the two are prefix-
// disjoint (`- note ` vs `- [`), so neither regex ever matches the other's lines. The `<text>` covers
// BOTH the inline form (`- note 2026-09-20: due Tuesday`) and the sentinel form
// (`- note 2026-09-20: see-log:session-0027-log.md:n4v8xk`) — the sentinel is just a specific text
// payload; distinguishing sentinel-vs-inline is the #1092 lineage reader's job, not this parser's.
const NOTE_SUB_RE = /^- note (\d{4}-\d{2}-\d{2}): (.+)$/;

// Handoff "What remains" item (§5): a punchlist Open line WITHOUT the checkbox.
const REMAINS_ITEM_RE = /^- #(\d+)\.(\d+) · (.*?)\s+\[([0-9a-z]+), ([^\]]+)\]$/;

// Wayfinding-header anchor (§12.3): the single HTML-comment line at the top of every file. A header
// REFRESH find-and-replaces on this so it never disturbs the body (append-only zones stay byte-stable).
const HEADER_ANCHOR_RE = /^<!-- tpm-session: /;

// Version sentinel (§13.6): the wayfinding-header comment carries `tpm-session-version: 1.0`. This is
// a DISTINCT regex from HEADER_ANCHOR_RE (R-7): the anchor prefix drives strip/refresh, this one drives
// the reader gate. `1\.0\b` matches `1.0` but not `1.05` (word boundary after the trailing 0).
const VERSION_RE = /tpm-session-version:\s*1\.0\b/;

const SEALED_RE = /^SEALED\s+(.+)$/;

// ── helpers ────────────────────────────────────────────────────────────────────
function pad2(n) { return String(n).padStart(2, '0'); }

/** 6-char (default) base36 random slug — a stable, globally-unique handle for a punchlist item. */
function randomSlug(len = 6) {
  let s = '';
  while (s.length < len) s += Math.random().toString(36).slice(2);
  return s.slice(0, len);
}

/**
 * A note-slug (base36, via randomSlug) GUARANTEED distinct from the item's own slug and from any
 * note-slug already in use (#1095, R6). The #1092 lineage reader searches the log for a note-slug, so
 * a collision with the item slug (or a prior note-slug) would fold wrong — this keeps them disjoint.
 */
function freshNoteSlug(itemSlug, used = []) {
  const taken = new Set(used);
  if (itemSlug) taken.add(itemSlug);
  let slug = randomSlug();
  while (taken.has(slug)) slug = randomSlug();
  return slug;
}

/**
 * ISO-8601 timestamp WITH the LOCAL timezone offset — e.g. `2026-09-16T14:23:07-07:00`.
 * `Date.prototype.toISOString()` is ALWAYS UTC `Z`, so this is hand-built from local components and
 * the offset is derived from getTimezoneOffset() with its sign FLIPPED (getTimezoneOffset() returns
 * minutes BEHIND UTC: 420 for UTC-7 → `-07:00`; 0 → `+00:00`, never `-00:00`; handles sub-hour
 * offsets like `+05:30`). Callers assert the SHAPE (/[+-]\d{2}:\d{2}$/), never a literal offset (CI
 * may run in UTC).
 */
function nowIsoTz(date = new Date()) {
  const y = date.getFullYear();
  const mo = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  const h = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  const s = pad2(date.getSeconds());
  const offsetMin = -date.getTimezoneOffset(); // flip: 420 (behind UTC) → -420 → "-07:00"
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** Local calendar date `YYYY-MM-DD` (for the title / SEALED stamp). */
function todayISODate(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function buildTitle(number, date, theme) {
  return `# SESSION ${number} — ${date} — ${theme}`;
}

/** Next monotonic item number for `session` within an existing item list (max +1, else 1). */
function nextPunchlistN(items, session) {
  const s = Number(session);
  const ns = (items || []).filter((it) => Number(it.session) === s).map((it) => Number(it.n));
  return ns.length ? Math.max(...ns) + 1 : 1;
}

// ── wayfinding header (§12.3) ───────────────────────────────────────────────────
const THIS_FILE_LABELS = {
  handoff: 'handoff',
  punchlist: 'punchlist',
  log: 'log',
};

/**
 * The shared front-matter block, identical on all three files bar the `THIS FILE:` token. Emits the
 * `tpm-session-version: 1.0` sentinel (the reader gate — see `readsAsV1`) and the session-number-
 * prefixed filenames (`session-NNNN-{handoff,punchlist,log}.md`) so the three files never collide and
 * a note sentinel can name the file. `thisFile` ∈ {handoff | punchlist | log}.
 */
function buildWayfindingHeader(number, date, thisFile) {
  const n = String(number);
  const label = THIS_FILE_LABELS[thisFile] || String(thisFile);
  return [
    `<!-- tpm-session: ${n} · ${date} · tpm-session-version: 1.0 · files: session-${n}-handoff.md, session-${n}-punchlist.md, session-${n}-log.md -->`,
    `> **Session ${n} memory — three files in this folder.  THIS FILE: ${label}.**`,
    `> • **session-${n}-handoff.md** — READ FIRST: where we are, next action, what NOT to redo.`,
    `> • **session-${n}-punchlist.md** — open/done work items (numbered).`,
    `> • **session-${n}-log.md** — append-only ledger: Decisions + Log (log reads **bottom-to-top**).`,
  ].join('\n');
}

/**
 * The single version gate every reader calls. `contentReadsAsV1(content)` tests already-held bytes;
 * `readsAsV1(filePath)` reads the file and swallows ENOENT / any read error (returns false, never
 * throws — so a folder with no prefixed file yet is simply "not v1.0", not a crash). A file "reads as
 * v1.0" iff its wayfinding-header comment carries the `tpm-session-version: 1.0` sentinel. Unmarked /
 * pre-v1.0 files return false and are IGNORED by the readers (no legacy-parse branch, no back-compat).
 */
function contentReadsAsV1(content) {
  return typeof content === 'string' && VERSION_RE.test(content);
}

function readsAsV1(filePath) {
  try {
    return contentReadsAsV1(fs.readFileSync(filePath, 'utf8'));
  } catch (_e) {
    return false;
  }
}

/**
 * Remove the wayfinding-header block (the anchor comment + the contiguous run of `>` blockquote
 * lines that follow it, plus a single trailing blank line) — leaving the rest of the file untouched.
 * Returns `content` unchanged if no anchor is present.
 */
function stripWayfindingHeader(content) {
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => HEADER_ANCHOR_RE.test(l));
  if (idx === -1) return content;
  let end = idx + 1;
  while (end < lines.length && lines[end].startsWith('>')) end += 1;
  if (end < lines.length && lines[end].trim() === '') end += 1;
  return lines.slice(0, idx).concat(lines.slice(end)).join('\n');
}

/**
 * Surgically refresh the wayfinding header: strip the existing block and prepend a fresh one, so the
 * body (a notes ledger's append-only Log/Decisions zones included) stays byte-stable. `save` uses
 * this on all three files rather than re-rendering the ledger.
 */
function refreshWayfindingHeader(content, { number, date, thisFile }) {
  const body = stripWayfindingHeader(content).replace(/^\n+/, '');
  const header = buildWayfindingHeader(number, date, thisFile);
  return `${header}\n\n${body}`;
}

// ── session-notes.md — the ledger (§3, §12.5) ────────────────────────────────────
function splitNoteSections(content) {
  const lines = content.split('\n');
  const sections = { preamble: [], decisions: [], log: [], trailer: [] };
  let cur = 'preamble';
  for (const line of lines) {
    const t = line.trim();
    if (t === NOTE_HEADINGS.DECISIONS) { cur = 'decisions'; continue; }
    if (t === NOTE_HEADINGS.LOG) { cur = 'log'; continue; }
    if (SEALED_RE.test(t)) { cur = 'trailer'; sections.trailer.push(line); continue; }
    sections[cur].push(line);
  }
  return sections;
}

function parseDecisions(lines) {
  const out = [];
  for (const line of lines) {
    const m = DECISION_RE.exec(line.trim());
    if (m) out.push({ what: m[1].trim(), why: m[2].trim(), ts: m[3] ? m[3].trim() : null });
  }
  return out;
}

function parseLog(lines) {
  const out = [];
  for (const line of lines) {
    const m = LOG_ENTRY_RE.exec(line.trim());
    if (m) out.push({ status: m[1], text: m[2].trim(), ts: m[3].trim() });
  }
  return out;
}

function parseSealed(trailerLines) {
  for (const line of trailerLines) {
    const m = SEALED_RE.exec(line.trim());
    if (m) return m[1].trim();
  }
  return null;
}

/** Parse the ledger (session-NNNN-log.md) into { title, number, date, theme, decisions, log, sealedAt, raw }. */
function parseNote(content) {
  const titleLine = content.split('\n').find((l) => l.trim().startsWith('# SESSION'));
  let number = null;
  let date = null;
  let theme = null;
  if (titleLine) {
    const m = TITLE_RE.exec(titleLine.trim());
    if (m) { number = m[1]; date = m[2].trim(); theme = m[3].trim(); }
  }
  const sections = splitNoteSections(content);
  return {
    title: titleLine || null,
    number,
    date,
    theme,
    decisions: parseDecisions(sections.decisions),
    log: parseLog(sections.log),
    sealedAt: parseSealed(sections.trailer),
    raw: content,
  };
}

// Guard: user-supplied fields are single-line BY CONTRACT — the three files are line-oriented and
// regex-parsed, so a newline (or CR) silently corrupts them (forges structure, or vanishes on the
// next parse). Refuse loudly instead, matching the "refuses + writes nothing" contract. Shared by
// every writer via the render functions below.
function assertNoNewline(value, label) {
  if (typeof value === 'string' && /[\r\n]/.test(value)) {
    throw Object.assign(
      new Error(`"${label}" must be a single line — it contains a newline, which the line-oriented session format cannot store.`),
      { code: 'EREFUSE' },
    );
  }
}

function renderDecisions(decisions) {
  if (!decisions || decisions.length === 0) return '_None yet._';
  return decisions
    .map((d) => {
      assertNoNewline(d.what, 'decision (what)');
      assertNoNewline(d.why, 'decision (why)');
      return `- ${DECIDED_PREFIX} ${d.what} — ${d.why}${d.ts ? `  [${d.ts}]` : ''}`;
    })
    .join('\n');
}

function renderLog(log) {
  if (!log || log.length === 0) return '_Nothing logged yet._';
  return log.map((e) => {
    assertNoNewline(e.status, 'log status/tag');
    assertNoNewline(e.text, 'log text');
    return `- [${e.status}] ${e.text}  [${e.ts}]`;
  }).join('\n');
}

/** Render a full session-notes.md (header + title + Decisions + Log + optional SEALED). */
function renderNote(sections) {
  const { number, date, theme, decisions = [], log = [], sealedAt = null } = sections;
  assertNoNewline(theme, 'theme');
  const parts = [
    buildWayfindingHeader(number, date, 'log'),
    '',
    buildTitle(number, date, theme),
    '',
    NOTE_HEADINGS.DECISIONS,
    renderDecisions(decisions),
    '',
    NOTE_HEADINGS.LOG,
    renderLog(log),
  ];
  if (sealedAt) parts.push('', `${SEALED_PREFIX} ${sealedAt}`);
  return `${parts.join('\n')}\n`;
}

// ── punchlist.md — the mini task-manager (§4, §12.4) ──────────────────────────────
function renderPunchlistItem(it) {
  const check = it.done ? 'x' : ' ';
  assertNoNewline(it.text, 'punchlist item text');
  let line = `- [${check}] #${Number(it.session)}.${it.n} · ${it.text}  [${it.slug}, ${it.created}]`;
  if (it.done && it.closed) line += ` (closed ${it.closed})`;
  // Notes (#1095): dated single-line sub-bullets, emitted flush after the item line. `notes` defaults
  // to [] so an item with NO notes renders BYTE-IDENTICALLY to the pre-#1095 format (no trailing lines,
  // no stray blank line — R2). Each note is newline-guarded (defense-in-depth; the verb also guards).
  for (const note of (it.notes || [])) {
    assertNoNewline(note.text, 'note');
    line += `\n- note ${note.date}: ${note.text}`;
  }
  return line;
}

/** Parse punchlist.md into { number, date, items:[{done,session,n,id,text,slug,created,closed,notes}], raw }. */
function parsePunchlist(content) {
  const lines = content.split('\n');
  const titleLine = lines.find((l) => l.trim().startsWith('# Punchlist'));
  let number = null;
  let date = null;
  if (titleLine) {
    const m = /^# Punchlist — session (\S+)(?: — (.+))?$/.exec(titleLine.trim());
    if (m) { number = m[1]; date = m[2] ? m[2].trim() : null; }
  }
  const items = [];
  for (const line of lines) {
    const t = line.trim();
    const m = PUNCHLIST_ITEM_RE.exec(t);
    if (m) {
      const session = parseInt(m[2], 10);
      const n = parseInt(m[3], 10);
      items.push({
        done: m[1] === 'x',
        session,
        n,
        id: `${session}.${n}`,
        text: m[4],
        slug: m[5],
        created: m[6],
        closed: m[7] || null,
        notes: [],
      });
      continue;
    }
    // A `- note <date>: <text>` sub-bullet attaches to the MOST-RECENT item (#1095). Guard: a note
    // line before any item (items.length === 0) is IGNORED, not a crash.
    const nm = NOTE_SUB_RE.exec(t);
    if (nm && items.length > 0) {
      items[items.length - 1].notes.push({ date: nm[1], text: nm[2] });
    }
  }
  return { number, date, items, raw: content };
}

/** Render punchlist.md from { number, date, items } — partitions into ## Open / ## Done by the done flag. */
function renderPunchlist(sections) {
  const { number, date, items = [] } = sections;
  const open = items.filter((it) => !it.done);
  const done = items.filter((it) => it.done);
  const parts = [
    buildWayfindingHeader(number, date, 'punchlist'),
    '',
    `# Punchlist — session ${number}${date ? ` — ${date}` : ''}`,
    '',
    PUNCHLIST_HEADINGS.OPEN,
    open.length ? open.map(renderPunchlistItem).join('\n') : '_No open items._',
    '',
    PUNCHLIST_HEADINGS.DONE,
    done.length ? done.map(renderPunchlistItem).join('\n') : '_Nothing done yet._',
  ];
  return `${parts.join('\n')}\n`;
}

/** The Open (unfinished) items of a parsed punchlist — feeds handoff "What remains" + boot-read. */
function openItems(parsed) {
  if (!parsed || !parsed.items) return [];
  return parsed.items.filter((it) => !it.done);
}

// ── handoff.md — the pickup doc (§5, §12.6) ───────────────────────────────────────
function renderRemainsItem(it) {
  return `- #${Number(it.session)}.${it.n} · ${it.text}  [${it.slug}, ${it.created}]`;
}

/**
 * Render handoff.md, rewritten wholesale each save.
 *   payload: { where (REQUIRED), next (REQUIRED), in_flight?, must_not_redo?: string[] }
 *   openItemsList: the CURRENT punchlist Open items (mechanically seeded — not hand-typed)
 *   meta: { number, date }
 * The MUST NOT redo section is OMITTED when must_not_redo is absent/empty (§12.2).
 */
function renderHandoff(payload = {}, openItemsList = [], meta = {}) {
  assertNoNewline(payload.where, 'where');
  assertNoNewline(payload.next, 'next');
  if (payload.in_flight !== undefined) assertNoNewline(payload.in_flight, 'in_flight');
  (payload.must_not_redo || []).forEach((s) => assertNoNewline(s, 'must_not_redo item'));
  const parts = [
    buildWayfindingHeader(meta.number, meta.date, 'handoff'),
    '',
    `# HANDOFF — session ${meta.number} — ${meta.date}`,
    '> ⚠️ READ THIS FULLY before doing anything. Unfinished punchlist items below are required reading.',
    '',
    HANDOFF_HEADINGS.HEAD,
    `**Where we are:** ${payload.where || ''}`,
    `**Next action:** ${payload.next || ''}`,
    `**In flight:** ${payload.in_flight || 'Nothing in flight.'}`,
    '',
    HANDOFF_HEADINGS.REMAINS,
    (openItemsList && openItemsList.length)
      ? openItemsList.map(renderRemainsItem).join('\n')
      : '_No open punchlist items._',
  ];
  if (payload.must_not_redo && payload.must_not_redo.length) {
    parts.push('', HANDOFF_HEADINGS.MUST_NOT, payload.must_not_redo.map((s) => `- ${s}`).join('\n'));
  }
  return `${parts.join('\n')}\n`;
}

function splitHandoffSections(content) {
  const lines = content.split('\n');
  const sections = { preamble: [], head: [], remains: [], mustNot: [] };
  let cur = 'preamble';
  for (const line of lines) {
    const t = line.trim();
    if (t === HANDOFF_HEADINGS.HEAD) { cur = 'head'; continue; }
    if (t === HANDOFF_HEADINGS.REMAINS) { cur = 'remains'; continue; }
    if (t === HANDOFF_HEADINGS.MUST_NOT) { cur = 'mustNot'; continue; }
    sections[cur].push(line);
  }
  return sections;
}

/**
 * Parse handoff.md into { number, date, where, next, inFlight, whatRemains:[…], mustNotRedo:[…], raw }.
 * Sufficient for boot-read's compact emit AND for a render→parse round-trip check.
 */
function parseHandoff(content) {
  const lines = content.split('\n');
  const titleLine = lines.find((l) => l.trim().startsWith('# HANDOFF'));
  let number = null;
  let date = null;
  if (titleLine) {
    const m = /^# HANDOFF — session (\S+) — (.+)$/.exec(titleLine.trim());
    if (m) { number = m[1]; date = m[2].trim(); }
  }
  const sections = splitHandoffSections(content);
  let where = '';
  let next = '';
  let inFlight = '';
  for (const line of sections.head) {
    const t = line.trim();
    if (t.startsWith('**Where we are:**')) where = t.slice('**Where we are:**'.length).trim();
    else if (t.startsWith('**Next action:**')) next = t.slice('**Next action:**'.length).trim();
    else if (t.startsWith('**In flight:**')) inFlight = t.slice('**In flight:**'.length).trim();
  }
  const whatRemains = [];
  for (const line of sections.remains) {
    const m = REMAINS_ITEM_RE.exec(line.trim());
    if (m) {
      const session = parseInt(m[1], 10);
      const n = parseInt(m[2], 10);
      whatRemains.push({ session, n, id: `${session}.${n}`, text: m[3], slug: m[4], created: m[5] });
    }
  }
  const mustNotRedo = [];
  for (const line of sections.mustNot) {
    const t = line.trim();
    if (t.startsWith('- ')) mustNotRedo.push(t.slice(2).trim());
  }
  return { number, date, where, next, inFlight, whatRemains, mustNotRedo, raw: content };
}

module.exports = {
  // constants
  NOTE_HEADINGS,
  PUNCHLIST_HEADINGS,
  HANDOFF_HEADINGS,
  STATUS_TAGS,
  DECIDED_PREFIX,
  SEALED_PREFIX,
  // regexes
  TITLE_RE,
  LOG_ENTRY_RE,
  DECISION_RE,
  PUNCHLIST_ITEM_RE,
  NOTE_SUB_RE,
  REMAINS_ITEM_RE,
  HEADER_ANCHOR_RE,
  VERSION_RE,
  SEALED_RE,
  // helpers
  randomSlug,
  freshNoteSlug,
  assertNoNewline,
  nowIsoTz,
  todayISODate,
  buildTitle,
  nextPunchlistN,
  // wayfinding header
  buildWayfindingHeader,
  stripWayfindingHeader,
  refreshWayfindingHeader,
  // version gate (the reader guard)
  readsAsV1,
  contentReadsAsV1,
  // notes ledger
  parseNote,
  renderNote,
  // punchlist
  parsePunchlist,
  renderPunchlist,
  openItems,
  // handoff
  renderHandoff,
  parseHandoff,
};
