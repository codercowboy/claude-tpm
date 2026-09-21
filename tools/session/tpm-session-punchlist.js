#!/usr/bin/env node
/**
 * tpm-session-punchlist.js — the punchlist mini task-manager (spec §4, §12.4) + cross-session provenance (#1093).
 *
 * PURPOSE
 *   Owns the CURRENT session's `session-NNNN-punchlist.md` — the open/done work list with session-prefixed ids and
 *   a stable machine tag `[<slug>, <created-ISO-TZ>]` per item. These are LIVE verbs: usable any time,
 *   append/mark-only (never a wholesale re-author of judgment), one file path each. The orchestrator
 *   supplies the item TEXT; this tool owns FORMAT + PLACEMENT + id/slug/timestamp minting (spec §6: the
 *   tool owns all markdown — every token comes from the `tpm-session-format.js` SSOT, never hand-authored
 *   here).
 *
 *   `save` READS this file (its "What remains" head is the Open section, pulled mechanically);
 *   `boot-read` emits the Open items of the prior session. This tool is the only WRITER of items.
 *
 * IDENTITY — the SLUG is the key (#1093)
 *   The 6-char slug minted at `add` is the OPERATIONAL IDENTITY of an item: minted exactly once, never
 *   reused, and PRESERVED across carry/close/reopen (only a fresh `add` mints a new one). The
 *   session-prefixed NUMBER `#<session>.<n>` is COSMETIC DISPLAY, frozen at origin — it is NEVER
 *   re-minted when an item is carried into a later session, so `#20.4` keeps reading `#20.4` wherever it
 *   travels. carry/close/reopen/drop/origin all resolve on the slug (an `<n>`/`<session>.<n>` id token is
 *   still accepted as a convenience for items already in — or originating in — the current session).
 *
 * CROSS-SESSION (#1093)
 *   Sealed prior sessions are IMMUTABLE snapshots — this tool NEVER edits a source session's file. Carrying
 *   or closing a prior item RECORDS a fresh copy in the CURRENT session's punchlist, preserving the origin
 *   number + slug + text:
 *     carry <slug>   copy a prior item forward into the current punchlist as OPEN.
 *     close <slug>   (cross-session) write the `[x]` done copy into the current session, stamped (closed ..).
 *     origin <slug>  print the session-NNNN/session-NNNN-punchlist.md the slug FIRST appeared in (also the internal resolver).
 *
 * LEDGER
 *   EVERY mutating op (add/close/carry/reopen/drop/note) appends a tagged line to the current session's
 *   `session-NNNN-log.md` `## Log`: `- [ADDED|CLOSED|CARRIED|REOPENED|DROPPED|NOTE] #<id> [<slug>] <text>  [<ISO-TZ>]`
 *   (the `--log` note variant additionally writes a `[PLNOTE] <full text>  [<note-slug>, <ISO-TZ>]` line)
 *   (a human-readable audit trail — the punchlist files stay the source of truth). Refused / no-op ops do
 *   NOT log. Two files, no transaction: content is validated by render before either file is written, then
 *   the punchlist is written, then the ledger; an I/O failure on the ledger append re-throws LOUDLY (exit 1)
 *   so a partial write is never silent.
 *
 * VERBS
 *   add "<text>"          Mint a new open item: new `#<session>.<n>` + 6-char slug + created ISO-TZ.
 *   close <slug|id>       Flip `[ ]`→`[x]`, move to `## Done`, stamp `(closed <ISO-TZ>)`. A prior-session
 *                         slug/id copies the item forward as DONE (never edits the source). Already closed → no-op.
 *   carry <slug|id>       Copy a prior session's item forward into the current punchlist as OPEN.
 *   origin <slug|id>      Print the session-NNNN/session-NNNN-punchlist.md the slug first appeared in.
 *   list [--all]          Print items (default: Open only; `--all` includes Done).
 *   reopen <slug|id>      Flip `[x]`→`[ ]`, move back to `## Open` (restored to id order), clear the closed stamp.
 *   drop <slug|id>        Hard-remove the item (the session punchlist is ephemeral-per-epic).
 *   note <slug|id> "<t>"  Attach a dated inline note (≤300 chars, single line) to the CURRENT session's copy.
 *   note <slug|id> --log "<full>"  Offload unlimited (single-line) detail to the log as a `[PLNOTE]` line
 *                         under a unique note-slug; drop a `see-log:session-NNNN-log.md:<note-slug>` sentinel
 *                         on the item. Notes are per-session (carry/close never copy them forward — #1095).
 *
 *   An invalid / unknown ref → exit 1 (nothing written). No open session → exit 1 with a clear
 *   "run tpm-session open first" message (same guard tpm-session-notes.js / tpm-session-save.js use).
 *
 * CLI
 *   --sessions-dir <dir>   REQUIRED (resolve via tpm-session-config.js --sessions-dir).
 *   --all                  (list only) include Done items.
 *   --help
 *
 * EXAMPLES
 *   npx tpm session punchlist --sessions-dir .claude/claude-tpm/sessions add "wire the save payload lint"
 *   npx tpm session punchlist --sessions-dir .claude/claude-tpm/sessions close 4
 *   npx tpm session punchlist --sessions-dir .claude/claude-tpm/sessions carry k3f9az
 *   npx tpm session punchlist --sessions-dir .claude/claude-tpm/sessions close 20.4
 *   npx tpm session punchlist --sessions-dir .claude/claude-tpm/sessions origin k3f9az
 *   npx tpm session punchlist --sessions-dir .claude/claude-tpm/sessions list --all
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveCurrentSession } = require('./tpm-session-current');
const { appendLogEntry } = require('./tpm-session-notes');
const {
  parsePunchlist,
  renderPunchlist,
  openItems,
  randomSlug,
  freshNoteSlug,
  assertNoNewline,
  nowIsoTz,
  todayISODate,
  nextPunchlistN,
  readsAsV1,
} = require('./tpm-session-format');

// Inline note cap (#1095, §13.4): terse single-line notes ≤300 chars keep the punchlist a skimmable
// index; anything longer uses the `--log` sentinel (unlimited text offloaded to the ledger).
const INLINE_NOTE_MAX = 300;

// ---- disk helpers -----------------------------------------------------------
function punchlistPathFor(sessionsDir, number) {
  return path.join(sessionsDir, `session-${number}`, `session-${number}-punchlist.md`);
}

/**
 * Load the current session's punchlist. Returns { number, date, items }. If the file does not
 * exist yet, returns an empty item list seeded with the current session number/date (the first
 * `add` creates the file). `number` is the header/title number (padded-4, e.g. "0020"); item ids
 * strip the leading zeros via the SSOT.
 */
function loadPunchlist(filePath, fallbackNumber) {
  if (fs.existsSync(filePath)) {
    const parsed = parsePunchlist(fs.readFileSync(filePath, 'utf8'));
    return {
      number: parsed.number || fallbackNumber,
      date: parsed.date || todayISODate(),
      items: parsed.items,
    };
  }
  return { number: fallbackNumber, date: todayISODate(), items: [] };
}

/**
 * Write the punchlist, sorting items by (session, n) so Open/Done each render in stable id order —
 * this is what restores a reopened item to its id-order slot in `## Open` (dogfood: reopen no longer
 * appends to the end) and keeps carried foreign items (lower session numbers) sorted above current ones.
 */
function writePunchlist(filePath, state) {
  const items = (state.items || [])
    .slice()
    .sort((a, b) => (Number(a.session) - Number(b.session)) || (Number(a.n) - Number(b.n)));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, renderPunchlist({ ...state, items }), 'utf8');
}

/** A slug not already present on any item in `items` (astronomically-cheap collision guard, R-3). */
function freshSlug(items) {
  const used = new Set((items || []).map((it) => it.slug));
  let slug = randomSlug();
  while (used.has(slug)) slug = randomSlug();
  return slug;
}

/**
 * Resolve a reference token to either an id ref `{ kind:'id', session, n }` or a slug ref
 * `{ kind:'slug', slug }`. Accepts `n`, `session.n`, the `#`-prefixed forms, or a `[0-9a-z]+` slug.
 * A bare `<n>` is prefixed with the current session number. Rejects `n < 1` (so `close 0` / `<s>.0`
 * are "not a valid id" rather than "no item #N.0"). Returns null on a malformed token.
 */
function resolveRef(token, currentSessionInt) {
  if (typeof token !== 'string') return null;
  const t = token.trim().replace(/^#/, '');
  if (!t) return null;
  let m = /^(\d+)\.(\d+)$/.exec(t);
  if (m) {
    const session = parseInt(m[1], 10);
    const n = parseInt(m[2], 10);
    if (n < 1) return null;
    return { kind: 'id', session, n };
  }
  m = /^(\d+)$/.exec(t);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n < 1) return null;
    return { kind: 'id', session: currentSessionInt, n };
  }
  if (/^[0-9a-z]+$/.test(t)) return { kind: 'slug', slug: t };
  return null;
}

/**
 * Back-compat id-only resolver (exported): `{ session, n }` or null. Now also rejects `n < 1`.
 */
function parseIdToken(token, currentSessionInt) {
  const ref = resolveRef(token, currentSessionInt);
  return ref && ref.kind === 'id' ? { session: ref.session, n: ref.n } : null;
}

function findItem(items, ref) {
  return items.find((it) => Number(it.session) === ref.session && Number(it.n) === ref.n) || null;
}

/** Find an item in the CURRENT punchlist by an id OR slug ref. */
function findLocal(items, ref) {
  if (ref.kind === 'slug') return items.find((it) => it.slug === ref.slug) || null;
  return findItem(items, ref);
}

// ---- cross-session source resolution (read-only; NEVER writes a source file) -----------------
/** Every v1.0 session-NNNN/session-NNNN-punchlist.md on disk, ascending by session int: [{ sessionInt, padded, filePath, items }]. */
function allSessionPunchlists(sessionsDir) {
  let entries;
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch (_e) {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const mm = /^session-(\d{3,4})$/.exec(ent.name);
    if (!mm) continue;
    const padded = mm[1];
    const filePath = punchlistPathFor(sessionsDir, padded);
    if (!fs.existsSync(filePath)) continue;
    // v1.0 gate (Q3): cross-session carry/close/origin only see v1.0 punchlists; a pre-v1.0 folder
    // is IGNORED, keeping the clean cut honest (a carry across the 019→020 boundary is out of scope).
    if (!readsAsV1(filePath)) continue;
    const parsed = parsePunchlist(fs.readFileSync(filePath, 'utf8'));
    out.push({ sessionInt: parseInt(padded, 10), padded, filePath, items: parsed.items });
  }
  return out.sort((a, b) => a.sessionInt - b.sessionInt);
}

/** The ORIGIN of a slug: the lowest-numbered session folder whose punchlist first carries it. */
function findOriginBySlug(sessionsDir, slug) {
  for (const p of allSessionPunchlists(sessionsDir)) {
    const item = p.items.find((it) => it.slug === slug);
    if (item) return { padded: p.padded, filePath: p.filePath, item };
  }
  return null;
}

/**
 * Resolve a ref to its SOURCE (origin) item, read-only. Returns { padded, filePath, item } or
 * { error } (a clean message, no throw). Slug → origin scan; id `#S.n` → session-S's own file
 * (numbers are frozen at origin, so `#20.4` lives in session-0020).
 */
function resolveSource(sessionsDir, ref) {
  if (ref.kind === 'slug') {
    const found = findOriginBySlug(sessionsDir, ref.slug);
    if (!found) return { error: `no item with slug [${ref.slug}] found in any session punchlist.` };
    return found;
  }
  const padded = String(ref.session).padStart(4, '0');
  const filePath = punchlistPathFor(sessionsDir, padded);
  if (!fs.existsSync(filePath)) {
    return { error: `no session-${padded}/session-${padded}-punchlist.md to resolve #${ref.session}.${ref.n} from.` };
  }
  const parsed = parsePunchlist(fs.readFileSync(filePath, 'utf8'));
  const item = parsed.items.find((it) => Number(it.session) === ref.session && Number(it.n) === ref.n);
  if (!item) return { error: `no item #${ref.session}.${ref.n} in session-${padded}.` };
  return { padded, filePath, item };
}

// ---- ledger coupling --------------------------------------------------------
/**
 * Append the audit line for a SUCCESSFUL op to the current session's ## Log. Called AFTER the
 * punchlist write; a failure here re-throws (caught by main → exit 1) so a two-file drift is loud,
 * never silent. Refused / no-op ops must never reach here.
 */
function logOp(ctx, tag, item) {
  appendLogEntry({
    sessionsDir: ctx.sessionsDir,
    number: ctx.number,
    status: tag,
    text: `#${item.id} [${item.slug}] ${item.text}`,
  });
}

// ---- verb handlers ----------------------------------------------------------
// Each returns an exit code; they write via writePunchlist and print to stdout/stderr.

function verbAdd(ctx, text) {
  if (!text || !text.trim()) {
    process.stderr.write('punchlist: add requires an item text argument.\n');
    return 1;
  }
  const n = nextPunchlistN(ctx.state.items, ctx.sessionInt);
  const slug = freshSlug(ctx.state.items);
  const created = nowIsoTz();
  const id = `${ctx.sessionInt}.${n}`;
  const item = { done: false, session: ctx.sessionInt, n, id, text: text.trim(), slug, created, closed: null };
  ctx.state.items.push(item);
  writePunchlist(ctx.filePath, ctx.state);
  logOp(ctx, 'ADDED', item);
  process.stdout.write(`punchlist: added #${id}  [${slug}]\n`);
  return 0;
}

function verbClose(ctx, token) {
  const ref = resolveRef(token, ctx.sessionInt);
  if (!ref) {
    process.stderr.write(`punchlist: "${token}" is not a valid item id or slug (expected <n>, <session>.<n>, or a slug).\n`);
    return 1;
  }
  const local = findLocal(ctx.state.items, ref);
  if (local) {
    const item = local;
    if (item.done) {
      process.stdout.write(`punchlist: #${item.id} is already closed — nothing to do.\n`);
      return 0; // no-op warning, per plan — must NOT log
    }
    item.done = true;
    item.closed = nowIsoTz();
    writePunchlist(ctx.filePath, ctx.state);
    logOp(ctx, 'CLOSED', item);
    process.stdout.write(`punchlist: closed #${item.id}\n`);
    return 0;
  }
  // Not in the current punchlist. A bare/current-session id that is missing is a plain unknown-id error.
  if (ref.kind === 'id' && ref.session === ctx.sessionInt) {
    process.stderr.write(`punchlist: no item #${ref.session}.${ref.n} in this punchlist.\n`);
    return 1;
  }
  // Cross-session: copy the source item forward into the CURRENT session as DONE (never edit the source).
  const src = resolveSource(ctx.sessionsDir, ref);
  if (src.error) {
    process.stderr.write(`punchlist: ${src.error}\n`);
    return 1;
  }
  const copy = {
    done: true,
    session: src.item.session,
    n: src.item.n,
    id: src.item.id,
    text: src.item.text,
    slug: src.item.slug,
    created: src.item.created,
    closed: nowIsoTz(),
    notes: [], // #1095: carry/close NEVER copy prior notes — each session's copy holds only its own.
    //           HAZARD: a future refactor to `...src.item` would drag notes across — keep this explicit.
  };
  ctx.state.items.push(copy);
  writePunchlist(ctx.filePath, ctx.state);
  logOp(ctx, 'CLOSED', copy);
  process.stdout.write(`punchlist: closed #${copy.id} — recorded a done copy in session ${ctx.sessionInt} (source ${src.padded} untouched).\n`);
  return 0;
}

function verbCarry(ctx, token) {
  const ref = resolveRef(token, ctx.sessionInt);
  if (!ref) {
    process.stderr.write(`punchlist: "${token}" is not a valid item id or slug (expected <n>, <session>.<n>, or a slug).\n`);
    return 1;
  }
  // Already present in the current punchlist? (a prior carry, a local add, or the same slug) → refuse, no write.
  const present = findLocal(ctx.state.items, ref);
  if (present) {
    process.stdout.write(`punchlist: #${present.id} [${present.slug}] is already in this session's punchlist — nothing to carry.\n`);
    return 0; // no-op — must NOT log
  }
  const src = resolveSource(ctx.sessionsDir, ref);
  if (src.error) {
    process.stderr.write(`punchlist: ${src.error}\n`);
    return 1;
  }
  if (Number(src.item.session) === ctx.sessionInt) {
    process.stderr.write(`punchlist: #${src.item.id} originates in the current session — nothing to carry forward.\n`);
    return 1;
  }
  const copy = {
    done: false,
    session: src.item.session,
    n: src.item.n,
    id: src.item.id,
    text: src.item.text,
    slug: src.item.slug,
    created: src.item.created,
    closed: null,
    notes: [], // #1095: carry NEVER copies prior notes — each session's copy holds only its own.
    //           HAZARD: a future refactor to `...src.item` would drag notes across — keep this explicit.
  };
  ctx.state.items.push(copy);
  writePunchlist(ctx.filePath, ctx.state);
  logOp(ctx, 'CARRIED', copy);
  process.stdout.write(`punchlist: carried #${copy.id}  [${copy.slug}] forward into session ${ctx.sessionInt} as open.\n`);
  return 0;
}

function verbOrigin(ctx, token) {
  const ref = resolveRef(token, ctx.sessionInt);
  if (!ref) {
    process.stderr.write(`punchlist: "${token}" is not a valid item id or slug (expected <n>, <session>.<n>, or a slug).\n`);
    return 1;
  }
  const src = resolveSource(ctx.sessionsDir, ref);
  if (src.error) {
    process.stderr.write(`punchlist: ${src.error}\n`);
    return 1;
  }
  process.stdout.write(`${src.filePath}\n`);
  return 0; // read-only — does NOT log
}

function verbReopen(ctx, token) {
  const ref = resolveRef(token, ctx.sessionInt);
  if (!ref) {
    process.stderr.write(`punchlist: "${token}" is not a valid item id or slug (expected <n>, <session>.<n>, or a slug).\n`);
    return 1;
  }
  const item = findLocal(ctx.state.items, ref);
  if (!item) {
    process.stderr.write(`punchlist: no item ${ref.kind === 'slug' ? `[${ref.slug}]` : `#${ref.session}.${ref.n}`} in this punchlist.\n`);
    return 1;
  }
  if (!item.done) {
    process.stdout.write(`punchlist: #${item.id} is already open — nothing to do.\n`);
    return 0; // no-op warning (symmetry with close) — must NOT log
  }
  item.done = false;
  item.closed = null;
  writePunchlist(ctx.filePath, ctx.state); // sorts by (session, n) → reopened item lands in id order
  logOp(ctx, 'REOPENED', item);
  process.stdout.write(`punchlist: reopened #${item.id}\n`);
  return 0;
}

function verbDrop(ctx, token) {
  const ref = resolveRef(token, ctx.sessionInt);
  if (!ref) {
    process.stderr.write(`punchlist: "${token}" is not a valid item id or slug (expected <n>, <session>.<n>, or a slug).\n`);
    return 1;
  }
  const idx = ref.kind === 'slug'
    ? ctx.state.items.findIndex((it) => it.slug === ref.slug)
    : ctx.state.items.findIndex((it) => Number(it.session) === ref.session && Number(it.n) === ref.n);
  if (idx === -1) {
    process.stderr.write(`punchlist: no item ${ref.kind === 'slug' ? `[${ref.slug}]` : `#${ref.session}.${ref.n}`} in this punchlist.\n`);
    return 1;
  }
  const [removed] = ctx.state.items.splice(idx, 1);
  writePunchlist(ctx.filePath, ctx.state);
  logOp(ctx, 'DROPPED', removed);
  process.stdout.write(`punchlist: dropped #${removed.id}\n`);
  return 0;
}

/** Note-slugs already used by `see-log:` sentinels anywhere in the CURRENT punchlist (collision domain, D3). */
function usedNoteSlugs(items) {
  const out = [];
  for (const it of (items || [])) {
    for (const note of (it.notes || [])) {
      const m = /^see-log:[^:]+:([0-9a-z]+)$/.exec(note.text || '');
      if (m) out.push(m[1]);
    }
  }
  return out;
}

/**
 * `note <slug|id> "<text>"` — attach a note to the CURRENT session's copy of the item (spec §13.4, #1095).
 *   INLINE (default): terse dated sub-bullet `- note <today>: <text>`; text ≤300 chars, single line,
 *     newline-guarded (both checks BEFORE any write → refusal writes nothing). Logs `[NOTE]` like every op.
 *   --log SENTINEL: unlimited-length but still single-line full text offloaded to this session's log as
 *     `- [PLNOTE] <full>  [<note-slug>, <ISO-TZ>]` under a UNIQUE note-slug, then a
 *     `- note <today>: see-log:session-NNNN-log.md:<note-slug>` sentinel dropped on the item.
 *
 * Notes attach ONLY to the current session's copy (findLocal) — a slug/id not present locally exits 1
 * with a "carry it first" message (never reaches across to a sealed source — G1). carry/close do NOT
 * copy notes forward, so each session's copy holds only ITS notes (the fold across copies is #1092).
 */
function verbNote(ctx, token, text, opts) {
  const useLog = Boolean(opts && opts.log);
  const ref = resolveRef(token, ctx.sessionInt);
  if (!ref) {
    process.stderr.write(`punchlist: "${token}" is not a valid item id or slug (expected <n>, <session>.<n>, or a slug).\n`);
    return 1;
  }
  if (!text || !text.trim()) {
    process.stderr.write('punchlist: note requires the note text (a non-empty string).\n');
    return 1;
  }
  const item = findLocal(ctx.state.items, ref);
  if (!item) {
    process.stderr.write(
      `punchlist: no item ${ref.kind === 'slug' ? `[${ref.slug}]` : `#${ref.session}.${ref.n}`} in this session's punchlist — `
      + 'carry it forward first (`punchlist carry <slug>`), then note it. Notes attach only to the current session\'s copy.\n',
    );
    return 1;
  }
  const date = todayISODate();

  if (useLog) {
    // --log SENTINEL: unlimited length, but STILL single-line (the log is line-oriented). Guard BEFORE
    // any write. LOG-FIRST order (D2): the sentinel points AT the note-slug, so the PLNOTE line must
    // exist before the pointer — a log-write failure aborts (exit 1) with nothing on the punchlist.
    try {
      assertNoNewline(text, 'note (--log full text)');
    } catch (err) {
      process.stderr.write(`punchlist: ${err.message}\n`);
      return 1;
    }
    const noteSlug = freshNoteSlug(item.slug, usedNoteSlugs(ctx.state.items));
    appendLogEntry({
      sessionsDir: ctx.sessionsDir,
      number: ctx.number,
      status: 'PLNOTE',
      text,
      ts: `${noteSlug}, ${nowIsoTz()}`,
    });
    const sentinel = `see-log:session-${ctx.number}-log.md:${noteSlug}`;
    item.notes.push({ date, text: sentinel });
    writePunchlist(ctx.filePath, ctx.state);
    process.stdout.write(`punchlist: noted #${item.id} [${item.slug}] → full text in session-${ctx.number}-log.md [PLNOTE ${noteSlug}].\n`);
    return 0;
  }

  // INLINE: ≤300 chars + single-line, both BEFORE any write (>300 or newline → exit 1, write NOTHING).
  const trimmed = text.trim();
  if (trimmed.length > INLINE_NOTE_MAX) {
    process.stderr.write(
      `punchlist: inline note is ${trimmed.length} chars — the cap is ${INLINE_NOTE_MAX}. `
      + 'Use `note <slug> --log "<full text>"` to offload longer detail to the log.\n',
    );
    return 1;
  }
  try {
    assertNoNewline(trimmed, 'note');
  } catch (err) {
    process.stderr.write(`punchlist: ${err.message}\n`);
    return 1;
  }
  item.notes.push({ date, text: trimmed });
  writePunchlist(ctx.filePath, ctx.state);
  logOp(ctx, 'NOTE', item); // §13.3 audit line: `- [NOTE] #id [slug] <item text>  [ts]` (logs ITEM text, D1)
  process.stdout.write(`punchlist: noted #${item.id} [${item.slug}].\n`);
  return 0;
}

function fmtItem(it) {
  const box = it.done ? 'x' : ' ';
  const closed = it.done && it.closed ? ` (closed ${it.closed})` : '';
  return `- [${box}] #${it.id} · ${it.text}  [${it.slug}, ${it.created}]${closed}`;
}

function verbList(state, showAll) {
  const open = openItems({ items: state.items });
  const rows = [];
  rows.push('## Open');
  rows.push(open.length ? open.map(fmtItem).join('\n') : '_No open items._');
  if (showAll) {
    const done = state.items.filter((it) => it.done);
    rows.push('## Done');
    rows.push(done.length ? done.map(fmtItem).join('\n') : '_Nothing done yet._');
  }
  process.stdout.write(`${rows.join('\n')}\n`);
  return 0;
}

// ---- CLI plumbing -----------------------------------------------------------
/** Missing-token guard shared by close/carry/origin/reopen/drop (no raw "undefined" leak). */
function requireToken(verb, token, what) {
  if (token === undefined || token === null || String(token).trim() === '') {
    process.stderr.write(`punchlist: ${verb} requires ${what}.\n`);
    return false;
  }
  return true;
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: npx tpm session punchlist --sessions-dir <dir> <verb> [args]',
      '',
      'Verbs:',
      '  add "<text>"          Mint a new open item (#<session>.<n> + slug + created ts); prints the id.',
      '  close <slug|id>       Flip to done, move to ## Done, stamp (closed <ts>). A prior-session slug/id',
      '                        copies the item forward as DONE (source untouched). Already closed → no-op.',
      '  carry <slug|id>       Copy a prior session\'s item forward into this punchlist as OPEN.',
      '  origin <slug|id>      Print the session-NNNN/session-NNNN-punchlist.md the slug first appeared in.',
      '  list [--all]          Print items (default Open only; --all includes Done).',
      '  reopen <slug|id>      Move a done item back to ## Open (restored to id order).',
      '  drop <slug|id>        Hard-remove an item.',
      '  note <slug|id> "<t>"  Add a dated inline note (≤300 chars, single line) to the CURRENT copy of the item.',
      '  note <slug|id> --log "<full>"  Offload UNLIMITED (single-line) detail to the log under a note-slug;',
      '                        drops a `see-log:session-NNNN-log.md:<note-slug>` sentinel on the item.',
      '',
      'Refs: the 6-char SLUG is the durable key (preserved across carry/close/reopen); the number `#<session>.<n>`',
      'is cosmetic display, frozen at origin. A bare `<n>` id resolves in the current session; `<session>.<n>` is explicit.',
      'Notes attach only to the current session\'s copy (carry/close do NOT copy notes forward).',
      'Every add/close/carry/reopen/drop/note appends a tagged line to session-NNNN-log.md ## Log.',
      'Invalid/unknown ref → exit 1. No open session → exit 1 (run `tpm-session open` first).',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--sessions-dir') args.sessionsDir = argv[++i];
    else if (a === '--all') args.all = true;
    else if (a === '--log') args.log = true;
    else args._.push(a);
  }
  return args;
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.help || argv.length === 0) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }
  if (!args.sessionsDir) {
    process.stderr.write('tpm-session-punchlist.js: --sessions-dir is required.\n\n');
    printHelp();
    process.exit(1);
  }

  const verb = args._[0];
  if (!verb) {
    process.stderr.write('tpm-session-punchlist.js: a verb is required (add|close|carry|origin|list|reopen|drop).\n\n');
    printHelp();
    process.exit(1);
  }

  try {
    const current = resolveCurrentSession({ sessionsDir: args.sessionsDir });
    if (current.state !== 'open') {
      process.stderr.write('punchlist: no session is currently open — run `tpm-session open` first.\n');
      process.exit(1);
    }
    const number = current.number; // padded-4, e.g. "0020"
    const sessionInt = Number(number);
    const filePath = punchlistPathFor(args.sessionsDir, number);
    const state = loadPunchlist(filePath, number);
    const ctx = { sessionsDir: args.sessionsDir, number, sessionInt, filePath, state };
    const token = args._[1];

    let code;
    switch (verb) {
      case 'add': code = verbAdd(ctx, args._.slice(1).join(' ')); break;
      case 'close': code = requireToken('close', token, 'an item id') ? verbClose(ctx, token) : 1; break;
      case 'carry': code = requireToken('carry', token, 'a slug') ? verbCarry(ctx, token) : 1; break;
      case 'origin': code = requireToken('origin', token, 'a slug') ? verbOrigin(ctx, token) : 1; break;
      case 'reopen': code = requireToken('reopen', token, 'an item id') ? verbReopen(ctx, token) : 1; break;
      case 'drop': code = requireToken('drop', token, 'an item id') ? verbDrop(ctx, token) : 1; break;
      case 'note': code = requireToken('note', token, 'an item slug/id and note text') ? verbNote(ctx, token, args._.slice(2).join(' '), { log: Boolean(args.log) }) : 1; break;
      case 'list': code = verbList(state, Boolean(args.all)); break;
      default:
        process.stderr.write(`tpm-session-punchlist.js: unknown verb "${verb}".\n\n`);
        printHelp();
        process.exit(1);
    }
    process.exit(code);
  } catch (err) {
    process.stderr.write(`punchlist: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  punchlistPathFor,
  loadPunchlist,
  writePunchlist,
  parseIdToken,
  resolveRef,
  findItem,
  findLocal,
  freshSlug,
  allSessionPunchlists,
  findOriginBySlug,
  resolveSource,
};
