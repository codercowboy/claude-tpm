#!/usr/bin/env node
/**
 * tests/session/tpm-session-punchlist/test.js — genuine tests for tools/session/tpm-session-punchlist.js,
 * the punchlist mini task-manager (spec §4, §12.4). NEW suite for the three-file redesign.
 *
 * PURPOSE
 *   Drives tpm-session-punchlist.js as a real subprocess against a fresh sandbox sessionsDir and
 *   asserts on the actual on-disk punchlist.md + printed output. Load-bearing claims:
 *     • add mints `#<session>.<n>` (session-prefixed, monotonic n) + a 6-char slug + a created ISO-TZ
 *     • close flips [ ]->[x], moves the item to ## Done, stamps `(closed <ISO-TZ>)`; bare <n> resolves
 *       in the current session, `<session>.<n>` is explicit
 *     • close on an already-closed id is a no-op WARNING (exit 0); an invalid/unknown id exits 1 and
 *       writes NOTHING
 *     • list defaults to Open only; --all includes Done. reopen moves back to Open; drop hard-removes.
 *     • no session open -> exit 1
 *
 *   ISO-TZ is asserted by SHAPE (/[+-]\d{2}:\d{2}/), never a literal offset (CI may run in UTC).
 *
 * HOW TO RUN
 *   node tests/session/tpm-session-punchlist/test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeChecker, runNode, mkSandbox, TOOLS } = require('../lib/harness');

const { check, count } = makeChecker();

const ISO_TZ = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/;

function openSession(sessionsDir) {
  const r = runNode(TOOLS.currentSession, ['--sessions-dir', sessionsDir, '--open']);
  assert.strictEqual(r.code, 0, `helper openSession failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function pl(dir, args) {
  return runNode(TOOLS.sessionPunchlist, ['--sessions-dir', dir, ...args]);
}

function punchText(dir, number) {
  return fs.readFileSync(path.join(dir, `session-${number}`, `session-${number}-punchlist.md`), 'utf8');
}

// =====================================================================================
// GUARDS
// =====================================================================================

check('GUARD: no session open exits 1, telling the caller to run `tpm-session open`', () => {
  const dir = mkSandbox('pl-no-session');
  const r = pl(dir, ['add', 'a thing']);
  assert.strictEqual(r.code, 1);
  assert.ok(/no session is currently open/.test(r.stderr));
  assert.ok(/tpm-session open/.test(r.stderr));
});

check('CLI: missing --sessions-dir exits 1', () => {
  const r = runNode(TOOLS.sessionPunchlist, ['add', 'x']);
  assert.strictEqual(r.code, 1);
  assert.ok(/--sessions-dir is required/.test(r.stderr));
});

check('CLI: unknown verb exits 1', () => {
  const dir = mkSandbox('pl-unknown-verb');
  openSession(dir);
  const r = pl(dir, ['frobnicate']);
  assert.strictEqual(r.code, 1);
  assert.ok(/unknown verb/.test(r.stderr));
});

check('CLI: --help exits 0', () => {
  const r = runNode(TOOLS.sessionPunchlist, ['--help']);
  assert.strictEqual(r.code, 0);
  assert.ok(/Usage: npx tpm session punchlist/.test(r.stdout));
});

// =====================================================================================
// add — mint id + slug + created ts
// =====================================================================================

check('add mints #<session>.<n> + a 6-char slug + a created ISO-TZ, and prints the id', () => {
  const dir = mkSandbox('pl-add');
  const opened = openSession(dir);
  const num = Number(opened.number);
  const r = pl(dir, ['add', 'wire the save payload lint']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(new RegExp(`punchlist: added #${num}\\.1  \\[[0-9a-z]{6}\\]`).test(r.stdout), `add output wrong: ${r.stdout}`);

  const text = punchText(dir, opened.number);
  const line = text.split('\n').find((l) => l.includes('wire the save payload lint'));
  assert.ok(new RegExp(`^- \\[ \\] #${num}\\.1 · wire the save payload lint  \\[[0-9a-z]{6}, `).test(line), `item line wrong: ${line}`);
  assert.ok(ISO_TZ.test(line), 'the created stamp must be an ISO-TZ');
});

check('add is monotonic within the session (#N.1, #N.2, #N.3)', () => {
  const dir = mkSandbox('pl-monotonic');
  const opened = openSession(dir);
  const num = Number(opened.number);
  pl(dir, ['add', 'first']);
  pl(dir, ['add', 'second']);
  const r = pl(dir, ['add', 'third']);
  assert.ok(new RegExp(`added #${num}\\.3`).test(r.stdout), `n must advance: ${r.stdout}`);
  const text = punchText(dir, opened.number);
  assert.ok(text.includes(`#${num}.1 · first`) && text.includes(`#${num}.2 · second`) && text.includes(`#${num}.3 · third`));
});

check('add with empty text exits 1', () => {
  const dir = mkSandbox('pl-add-empty');
  openSession(dir);
  const r = pl(dir, ['add', '']);
  assert.strictEqual(r.code, 1);
  assert.ok(/requires an item text/.test(r.stderr));
});

// =====================================================================================
// close — bare <n> and explicit <session>.<n>
// =====================================================================================

check('close <n> (bare) flips [ ]->[x], moves to ## Done, stamps (closed <ISO-TZ>)', () => {
  const dir = mkSandbox('pl-close-bare');
  const opened = openSession(dir);
  const num = Number(opened.number);
  pl(dir, ['add', 'a task to finish']);
  const r = pl(dir, ['close', '1']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(new RegExp(`closed #${num}\\.1`).test(r.stdout));

  const text = punchText(dir, opened.number);
  const doneIdx = text.indexOf('## Done');
  const itemIdx = text.indexOf('a task to finish');
  assert.ok(doneIdx >= 0 && itemIdx > doneIdx, 'the closed item must sit under ## Done');
  const line = text.split('\n').find((l) => l.includes('a task to finish'));
  assert.ok(/^- \[x\] /.test(line), 'checkbox must be marked [x]');
  assert.ok(/\(closed /.test(line) && ISO_TZ.test(line.split('(closed ')[1]), 'must carry a closed ISO-TZ stamp');
});

check('close <session>.<n> (explicit) resolves the same item', () => {
  const dir = mkSandbox('pl-close-explicit');
  const opened = openSession(dir);
  const num = Number(opened.number);
  pl(dir, ['add', 'explicit-close target']);
  const r = pl(dir, ['close', `${num}.1`]);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(new RegExp(`closed #${num}\\.1`).test(r.stdout));
});

check('close an ALREADY-CLOSED id is a no-op WARNING (exit 0, message says so)', () => {
  const dir = mkSandbox('pl-close-twice');
  const opened = openSession(dir);
  pl(dir, ['add', 'close me twice']);
  pl(dir, ['close', '1']);
  const r = pl(dir, ['close', '1']);
  assert.strictEqual(r.code, 0, 'already-closed is a no-op, exit 0');
  assert.ok(/already closed/.test(r.stdout), `expected the already-closed warning: ${r.stdout}`);
});

check('close an UNKNOWN id exits 1 and writes NOTHING', () => {
  const dir = mkSandbox('pl-close-unknown');
  const opened = openSession(dir);
  pl(dir, ['add', 'the only item']);
  const before = punchText(dir, opened.number);
  const r = pl(dir, ['close', '99']);
  assert.strictEqual(r.code, 1);
  assert.ok(/no item #/.test(r.stderr));
  assert.strictEqual(punchText(dir, opened.number), before, 'file must be unchanged after a refused close');
});

check('close a MALFORMED id token exits 1', () => {
  const dir = mkSandbox('pl-close-malformed');
  openSession(dir);
  pl(dir, ['add', 'x']);
  const r = pl(dir, ['close', 'not-an-id']);
  assert.strictEqual(r.code, 1);
  assert.ok(/not a valid item id/.test(r.stderr));
});

// =====================================================================================
// list / reopen / drop
// =====================================================================================

check('list defaults to Open only; --all also shows the Done section', () => {
  const dir = mkSandbox('pl-list');
  openSession(dir);
  pl(dir, ['add', 'still open']);
  pl(dir, ['add', 'will be done']);
  pl(dir, ['close', '2']);

  const openOnly = pl(dir, ['list']);
  assert.strictEqual(openOnly.code, 0);
  assert.ok(openOnly.stdout.includes('still open'));
  assert.ok(!openOnly.stdout.includes('will be done'), 'default list must NOT include closed items');
  assert.ok(!openOnly.stdout.includes('## Done'), 'default list omits the Done section');

  const all = pl(dir, ['list', '--all']);
  assert.strictEqual(all.code, 0);
  assert.ok(all.stdout.includes('## Done') && all.stdout.includes('will be done'), '--all shows Done items');
});

check('reopen flips a done item back to Open (already-open reopen is a no-op, exit 0)', () => {
  const dir = mkSandbox('pl-reopen');
  const opened = openSession(dir);
  pl(dir, ['add', 'reopen target']);
  pl(dir, ['close', '1']);
  const r = pl(dir, ['reopen', '1']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(/reopened #/.test(r.stdout));
  const line = punchText(dir, opened.number).split('\n').find((l) => l.includes('reopen target'));
  assert.ok(/^- \[ \] /.test(line), 'reopened item must be unchecked again');
  assert.ok(!/\(closed /.test(line), 'the closed stamp must be cleared on reopen');

  const again = pl(dir, ['reopen', '1']);
  assert.strictEqual(again.code, 0);
  assert.ok(/already open/.test(again.stdout), 'reopening an open item is a no-op warning');
});

check('drop hard-removes the item from the file', () => {
  const dir = mkSandbox('pl-drop');
  const opened = openSession(dir);
  pl(dir, ['add', 'keep me']);
  pl(dir, ['add', 'drop me']);
  const r = pl(dir, ['drop', '2']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(/dropped #/.test(r.stdout));
  const text = punchText(dir, opened.number);
  assert.ok(text.includes('keep me'), 'the surviving item stays');
  assert.ok(!text.includes('drop me'), 'the dropped item is gone from disk');
});

check('drop an unknown id exits 1', () => {
  const dir = mkSandbox('pl-drop-unknown');
  openSession(dir);
  pl(dir, ['add', 'x']);
  const r = pl(dir, ['drop', '99']);
  assert.strictEqual(r.code, 1);
  assert.ok(/no item #/.test(r.stderr));
});

// B2 — a newline in an item text is refused, never silently dropped (dogfood P0)
check('B2: a newline in a punchlist item text is refused (exit 1)', () => {
  const dir = mkSandbox('pl-newline');
  openSession(dir);
  const r = pl(dir, ['add', 'alpha\nbeta']);
  assert.strictEqual(r.code, 1);
  assert.ok(/single line|newline/i.test(r.stderr));
});

// =====================================================================================
// #1093 — cross-session provenance (carry / close / origin), log-every-op, polish.
//
// Verification-design.md §"#1093" + global invariants G1–G6. The SLUG is the operational
// identity (frozen origin number is cosmetic display); sealed prior sessions are IMMUTABLE.
// =====================================================================================

const SLUG_RE = /\[([0-9a-z]{6})\]/;
// A ## Log ledger line: `- [TAG] #<id> [<slug>] <text>  [<ISO-TZ>]` — ISO-TZ by SHAPE, never a literal offset.
const LOG_LINE_ISO_TZ = /^- \[[A-Z]+\] .+  \[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\]$/;

function sealSession(dir) {
  const r = runNode(TOOLS.sessionNotes, ['--sessions-dir', dir, 'seal']);
  assert.strictEqual(r.code, 0, `helper sealSession failed: ${r.stderr}`);
}

function slugOf(addResult) {
  const m = SLUG_RE.exec(addResult.stdout);
  assert.ok(m, `could not read a slug from add output: ${addResult.stdout}`);
  return m[1];
}

/** Raw bytes of a session's punchlist file (for byte-for-byte immutability checks — G1). */
function punchBytes(dir, number) {
  return fs.readFileSync(path.join(dir, `session-${number}`, `session-${number}-punchlist.md`));
}

function punchExists(dir, number) {
  return fs.existsSync(path.join(dir, `session-${number}`, `session-${number}-punchlist.md`));
}

/** The `- [TAG] ...` entries under the CURRENT session's ## Log (empty list if the ledger doesn't exist). */
function logLines(dir, number) {
  const p = path.join(dir, `session-${number}`, `session-${number}-log.md`);
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, 'utf8');
  const idx = text.indexOf('## Log');
  if (idx < 0) return [];
  return text.slice(idx).split('\n').filter((l) => /^- \[[A-Z]/.test(l));
}

/**
 * Build a SEALED prior session (session-001) holding two OPEN items, then open a fresh CURRENT
 * session (session-002). Returns the two prior slugs + both session numbers/ints.
 */
function priorAndCurrent(prefix) {
  const dir = mkSandbox(prefix);
  const prior = openSession(dir);               // session-001
  const a1 = pl(dir, ['add', 'first prior task']);
  const a2 = pl(dir, ['add', 'second prior task']);
  assert.strictEqual(a1.code, 0, a1.stderr);
  assert.strictEqual(a2.code, 0, a2.stderr);
  const slug1 = slugOf(a1);
  const slug2 = slugOf(a2);
  sealSession(dir);                              // seal 001 → closes the pointer
  const cur = openSession(dir);                  // session-002
  assert.notStrictEqual(cur.number, prior.number, 'a fresh session must allocate a new number');
  return {
    dir,
    prior: prior.number, priorInt: Number(prior.number),
    cur: cur.number, curInt: Number(cur.number),
    slug1, slug2,
  };
}

// ── carry ────────────────────────────────────────────────────────────────────────
check('#1093 carry <slug>: copies a prior OPEN item into current as OPEN — origin # + slug + text preserved', () => {
  const c = priorAndCurrent('pl-carry');
  const r = pl(c.dir, ['carry', c.slug1]);
  assert.strictEqual(r.code, 0, r.stderr);

  const line = punchText(c.dir, c.cur).split('\n').find((l) => l.includes('first prior task'));
  assert.ok(line, 'the carried item must appear in the current punchlist');
  // Origin number #1.1 is FROZEN (cosmetic), NOT re-minted to the current session; slug + text preserved; OPEN.
  assert.ok(new RegExp(`^- \\[ \\] #${c.priorInt}\\.1 · first prior task  \\[${c.slug1}, `).test(line),
    `carried line must keep origin #${c.priorInt}.1 + slug ${c.slug1} + OPEN checkbox: ${line}`);
});

check('#1093 carry: G1 — the sealed SOURCE session file is byte-for-byte unchanged', () => {
  const c = priorAndCurrent('pl-carry-g1');
  const before = punchBytes(c.dir, c.prior);
  const r = pl(c.dir, ['carry', c.slug1]);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(before.equals(punchBytes(c.dir, c.prior)), 'carry must NOT edit the sealed source punchlist');
});

check('#1093 carry: appends exactly one `- [CARRIED] #<id> [slug] text  [ISO-TZ]` line to the CURRENT ## Log', () => {
  const c = priorAndCurrent('pl-carry-log');
  pl(c.dir, ['carry', c.slug1]);
  const carried = logLines(c.dir, c.cur).filter((l) => /^- \[CARRIED\]/.test(l));
  assert.strictEqual(carried.length, 1, 'exactly one CARRIED ledger line');
  assert.ok(new RegExp(`^- \\[CARRIED\\] #${c.priorInt}\\.1 \\[${c.slug1}\\] first prior task  `).test(carried[0]),
    `CARRIED line shape wrong: ${carried[0]}`);
  assert.ok(LOG_LINE_ISO_TZ.test(carried[0]), 'CARRIED line must carry a trailing ISO-TZ (by shape)');
});

check('#1093 carry an UNKNOWN slug exits 1 and writes NOTHING (no current punchlist, no log)', () => {
  const c = priorAndCurrent('pl-carry-unknown');
  const r = pl(c.dir, ['carry', 'zzzzzz']);
  assert.strictEqual(r.code, 1);
  assert.ok(/no item with slug \[zzzzzz\]/.test(r.stderr), `expected a clean not-found message: ${r.stderr}`);
  assert.ok(!punchExists(c.dir, c.cur), 'a refused carry must not create the current punchlist');
  assert.strictEqual(logLines(c.dir, c.cur).length, 0, 'a refused carry must log NOTHING (G2)');
});

check('#1093 carry an ALREADY-PRESENT item is a no-op (exit 0), no duplicate, logs NOTHING (G2)', () => {
  const c = priorAndCurrent('pl-carry-dup');
  assert.strictEqual(pl(c.dir, ['carry', c.slug1]).code, 0);
  const afterFirst = punchText(c.dir, c.cur);
  const logAfterFirst = logLines(c.dir, c.cur).length;

  const again = pl(c.dir, ['carry', c.slug1]);
  assert.strictEqual(again.code, 0, 'a re-carry is a clean no-op, exit 0');
  assert.ok(/already in this session/.test(again.stdout), `expected the already-present warning: ${again.stdout}`);
  assert.strictEqual(punchText(c.dir, c.cur), afterFirst, 'a re-carry must not duplicate the item on disk');
  assert.strictEqual(logLines(c.dir, c.cur).length, logAfterFirst, 'a no-op re-carry must NOT append a log line (G2)');
});

// ── cross-session close (the B4 fix) ───────────────────────────────────────────────
check('#1093 close <slug> (never carried): writes the DONE copy into CURRENT ## Done, stamped (closed <ISO-TZ>)', () => {
  const c = priorAndCurrent('pl-xclose');
  const r = pl(c.dir, ['close', c.slug2]);
  assert.strictEqual(r.code, 0, r.stderr);

  const text = punchText(c.dir, c.cur);
  const doneIdx = text.indexOf('## Done');
  const itemIdx = text.indexOf('second prior task');
  assert.ok(doneIdx >= 0 && itemIdx > doneIdx, 'the cross-session-closed item must sit under ## Done in the CURRENT file');
  const line = text.split('\n').find((l) => l.includes('second prior task'));
  assert.ok(new RegExp(`^- \\[x\\] #${c.priorInt}\\.2 · second prior task  \\[${c.slug2}, `).test(line),
    `done copy must preserve origin #${c.priorInt}.2 + slug: ${line}`);
  assert.ok(/\(closed /.test(line) && ISO_TZ.test(line.split('(closed ')[1]), 'done copy must carry a (closed <ISO-TZ>) stamp');
});

check('#1093 close cross-session: G1 — sealed SOURCE byte-unchanged + one `- [CLOSED]` ISO-TZ log line', () => {
  const c = priorAndCurrent('pl-xclose-g1');
  const before = punchBytes(c.dir, c.prior);
  const r = pl(c.dir, ['close', c.slug2]);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(before.equals(punchBytes(c.dir, c.prior)), 'cross-session close must NOT edit the sealed source (B4 / G1)');
  const closed = logLines(c.dir, c.cur).filter((l) => /^- \[CLOSED\]/.test(l));
  assert.strictEqual(closed.length, 1, 'exactly one CLOSED ledger line');
  assert.ok(new RegExp(`^- \\[CLOSED\\] #${c.priorInt}\\.2 \\[${c.slug2}\\] second prior task  `).test(closed[0]), `CLOSED line shape: ${closed[0]}`);
  assert.ok(LOG_LINE_ISO_TZ.test(closed[0]), 'CLOSED line must carry a trailing ISO-TZ (by shape)');
});

check('#1093 close a CARRIED (already-open-in-current) item flips it in place — one copy, now done', () => {
  const c = priorAndCurrent('pl-carry-then-close');
  assert.strictEqual(pl(c.dir, ['carry', c.slug1]).code, 0);
  const r = pl(c.dir, ['close', c.slug1]);
  assert.strictEqual(r.code, 0, r.stderr);
  const text = punchText(c.dir, c.cur);
  const occurrences = text.split('\n').filter((l) => l.includes('first prior task')).length;
  assert.strictEqual(occurrences, 1, 'closing a carried item must flip it in place, not add a second copy');
  const line = text.split('\n').find((l) => l.includes('first prior task'));
  assert.ok(/^- \[x\] /.test(line) && /\(closed /.test(line), `the carried item must now be done: ${line}`);
});

check('#1093 close an UNKNOWN slug exits 1', () => {
  const c = priorAndCurrent('pl-xclose-unknown');
  const r = pl(c.dir, ['close', 'zzzzzz']);
  assert.strictEqual(r.code, 1);
  assert.ok(/no item with slug \[zzzzzz\]/.test(r.stderr), `expected clean not-found: ${r.stderr}`);
});

// ── origin ─────────────────────────────────────────────────────────────────────────
check('#1093 origin <slug>: prints the session-NNN/punchlist.md the slug first appeared in (exit 0)', () => {
  const c = priorAndCurrent('pl-origin');
  const r = pl(c.dir, ['origin', c.slug1]);
  assert.strictEqual(r.code, 0, r.stderr);
  const printed = r.stdout.trim();
  assert.strictEqual(printed, path.join(c.dir, `session-${c.prior}`, `session-${c.prior}-punchlist.md`),
    `origin must print the ORIGIN session's prefixed punchlist path: ${printed}`);
});

check('#1093 origin <session>.<n> (id-based, cross-session) resolves via padStart(4) to the origin folder', () => {
  // The padStart(4) fix: an id ref #1.1 must resolve to session-0001 (the folder is padded-4), not
  // session-1. This is the one behavioral cross-session bug site inside #1093's resolveSource.
  const c = priorAndCurrent('pl-origin-by-id');
  const r = pl(c.dir, ['origin', `${c.priorInt}.1`]); // e.g. "1.1"
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), path.join(c.dir, `session-${c.prior}`, `session-${c.prior}-punchlist.md`),
    `an id ref #${c.priorInt}.1 must resolve to the padded-4 folder session-${c.prior}: ${r.stdout}`);
});

check('#1093 close <session>.<n> (id-based, cross-session) copies the done item forward via padStart(4)', () => {
  const c = priorAndCurrent('pl-xclose-by-id');
  const r = pl(c.dir, ['close', `${c.priorInt}.2`]); // resolves to session-0001's #.2
  assert.strictEqual(r.code, 0, r.stderr);
  const line = punchText(c.dir, c.cur).split('\n').find((l) => l.includes('second prior task'));
  assert.ok(line && /^- \[x\] /.test(line), `the id-based cross-session close must record a done copy: ${line}`);
  assert.ok(new RegExp(`#${c.priorInt}\\.2 ·`).test(line), 'the frozen origin id is preserved');
});

check('#1093 origin of an UNKNOWN slug exits 1 with a clean message', () => {
  const c = priorAndCurrent('pl-origin-unknown');
  const r = pl(c.dir, ['origin', 'zzzzzz']);
  assert.strictEqual(r.code, 1);
  assert.ok(/no item with slug \[zzzzzz\]/.test(r.stderr), `expected clean not-found: ${r.stderr}`);
});

// ── log-every-op + refused/no-op logs NOTHING (G2) ──────────────────────────────────
check('#1093 log-every-op: add/close/reopen/drop each append exactly ONE tagged ISO-TZ ledger line', () => {
  const dir = mkSandbox('pl-log-every');
  const opened = openSession(dir);
  const num = opened.number;

  const expectOneMoreTagged = (tag, run) => {
    const before = logLines(dir, num).length;
    const r = run();
    assert.strictEqual(r.code, 0, `${tag} op failed: ${r.stderr}`);
    const after = logLines(dir, num);
    assert.strictEqual(after.length, before + 1, `${tag} must append exactly one ledger line`);
    const newest = after[after.length - 1];
    assert.ok(new RegExp(`^- \\[${tag}\\] `).test(newest), `newest ledger line must be tagged [${tag}]: ${newest}`);
    assert.ok(LOG_LINE_ISO_TZ.test(newest), `[${tag}] line must carry a trailing ISO-TZ by shape: ${newest}`);
  };

  expectOneMoreTagged('ADDED', () => pl(dir, ['add', 'log-op subject']));
  expectOneMoreTagged('CLOSED', () => pl(dir, ['close', '1']));
  expectOneMoreTagged('REOPENED', () => pl(dir, ['reopen', '1']));
  expectOneMoreTagged('DROPPED', () => pl(dir, ['drop', '1']));
});

check('#1093 G2: refused / no-op ops append NOTHING to the ## Log', () => {
  const dir = mkSandbox('pl-log-refuse');
  const opened = openSession(dir);
  const cur = opened.number;                    // the current session (padded-4)
  pl(dir, ['add', 'the subject']);              // one ADDED line
  const baseline = logLines(dir, cur).length;
  assert.ok(baseline >= 1, 'the add should have produced a ledger line to baseline against');

  assert.strictEqual(pl(dir, ['add', '']).code, 1);              // refused: empty text
  assert.strictEqual(pl(dir, ['close', '99']).code, 1);          // refused: unknown id
  assert.strictEqual(pl(dir, ['close', 'not-an-id!']).code, 1);  // refused: malformed token
  assert.strictEqual(pl(dir, ['reopen', '1']).code, 0);          // NO-OP: already open (exit 0)

  const num = logLines(dir, cur).length;
  assert.strictEqual(num, baseline, 'no refused / no-op op may append a ledger line (G2)');
});

// ── both-writes-or-error (G5) — the EISDIR drift case ───────────────────────────────
check('#1093 G5: a ledger-write failure (session-NNNN-log.md is a directory → EISDIR) makes the op error LOUDLY (exit != 0)', () => {
  const dir = mkSandbox('pl-eisdir-drift');
  const opened = openSession(dir);
  // Sabotage the ledger target: put a DIRECTORY where the PREFIXED ledger file must be. Re-pointed
  // to session-NNNN-log.md (the renamed/prefixed ledger) — pointing at the OLD session-notes.md would
  // make this test VACUOUS, since the tool now appends to session-NNNN-log.md (R-5).
  fs.mkdirSync(path.join(dir, `session-${opened.number}`, `session-${opened.number}-log.md`), { recursive: true });
  const r = pl(dir, ['add', 'drift-trigger']);
  assert.notStrictEqual(r.code, 0, 'a mid-sequence ledger I/O failure must NOT exit 0 — the drift must be loud (G5)');
  assert.ok(r.stderr.length > 0, 'the failure must be reported on stderr, not swallowed');
});

// ── reopen restores id order (row 5) ────────────────────────────────────────────────
check('#1093 reopen restores id order: after close #2 + reopen #2, ## Open lists #1, #2, #3 in order', () => {
  const dir = mkSandbox('pl-reopen-order');
  const opened = openSession(dir);
  const num = Number(opened.number);
  pl(dir, ['add', 'alpha one']);
  pl(dir, ['add', 'bravo two']);
  pl(dir, ['add', 'charlie three']);
  pl(dir, ['close', '2']);
  const r = pl(dir, ['reopen', '2']);
  assert.strictEqual(r.code, 0, r.stderr);

  const text = punchText(dir, opened.number);
  const openSec = text.slice(text.indexOf('## Open'), text.indexOf('## Done'));
  const i1 = openSec.indexOf(`#${num}.1`);
  const i2 = openSec.indexOf(`#${num}.2`);
  const i3 = openSec.indexOf(`#${num}.3`);
  assert.ok(i1 >= 0 && i2 >= 0 && i3 >= 0, 'all three items must be back in ## Open');
  assert.ok(i1 < i2 && i2 < i3, `reopened #${num}.2 must sit in id order (1,2,3), not appended at the end`);
});

// ── slug stability across carry / reopen (G4) ───────────────────────────────────────
check('#1093 G4: a slug is preserved across carry (origin slug travels forward, is not re-minted)', () => {
  const c = priorAndCurrent('pl-slug-carry');
  pl(c.dir, ['carry', c.slug1]);
  const line = punchText(c.dir, c.cur).split('\n').find((l) => l.includes('first prior task'));
  assert.ok(line.includes(`[${c.slug1}, `), `carried item must keep the ORIGIN slug ${c.slug1}: ${line}`);
});

check('#1093 G4: a slug is preserved across close→reopen (byte-identical, never re-minted)', () => {
  const dir = mkSandbox('pl-slug-reopen');
  const opened = openSession(dir);
  const slug = slugOf(pl(dir, ['add', 'slug-stable subject']));
  pl(dir, ['close', '1']);
  pl(dir, ['reopen', '1']);
  const line = punchText(dir, opened.number).split('\n').find((l) => l.includes('slug-stable subject'));
  assert.ok(line.includes(`[${slug}, `), `the slug must survive close→reopen unchanged (${slug}): ${line}`);
});

// ── message hygiene (row 6) ─────────────────────────────────────────────────────────
check('#1093 message hygiene: no-id close/reopen/drop → "requires an item id" (never raw "undefined")', () => {
  const dir = mkSandbox('pl-msg-no-id');
  openSession(dir);
  for (const verb of ['close', 'reopen', 'drop']) {
    const r = pl(dir, [verb]);
    assert.strictEqual(r.code, 1, `${verb} with no id must exit 1`);
    assert.ok(/requires an item id/.test(r.stderr), `${verb} must say "requires an item id": ${r.stderr}`);
    assert.ok(!/undefined/.test(r.stderr), `${verb} must not leak a raw "undefined": ${r.stderr}`);
  }
});

check('#1093 message hygiene: carry / origin with no arg → "requires a slug"', () => {
  const dir = mkSandbox('pl-msg-no-slug');
  openSession(dir);
  for (const verb of ['carry', 'origin']) {
    const r = pl(dir, [verb]);
    assert.strictEqual(r.code, 1, `${verb} with no arg must exit 1`);
    assert.ok(/requires a slug/.test(r.stderr), `${verb} must say "requires a slug": ${r.stderr}`);
  }
});

check('#1093 message hygiene: `close 0` → "not a valid item id" (ids are 1-based), not "no item #N.0"', () => {
  const dir = mkSandbox('pl-msg-zero');
  openSession(dir);
  pl(dir, ['add', 'a thing']);
  const r = pl(dir, ['close', '0']);
  assert.strictEqual(r.code, 1);
  assert.ok(/not a valid item id/.test(r.stderr), `close 0 must be rejected as invalid: ${r.stderr}`);
  assert.ok(!/no item #/.test(r.stderr), 'close 0 must NOT fall through to a "no item #N.0" message');
});

// =====================================================================================
// #1095 — punchlist item NOTES: inline `- note` sub-bullet, the `--log` see-log: sentinel,
// carry/close DON'T copy notes forward. Verification-design.md §"#1095" + spec §13.4/§13.5.
// The punchlist FILES are the source of truth; ISO-TZ / ISO-date asserted by SHAPE.
// =====================================================================================

const ISO_DATE = /\d{4}-\d{2}-\d{2}/;
// A `[PLNOTE]` ledger line: `- [PLNOTE] <full text>  [<note-slug>, <ISO-TZ>]` (note-slug + ISO-TZ tag).
const PLNOTE_TAG = /\[([0-9a-z]+), \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\]$/;

/** The `- note <date>: <text>` sub-bullet lines currently in the CURRENT session's punchlist. */
function noteLines(dir, number) {
  return punchText(dir, number).split('\n').filter((l) => /^- note \d{4}-\d{2}-\d{2}: /.test(l));
}

function logFilePath(dir, number) {
  return path.join(dir, `session-${number}`, `session-${number}-log.md`);
}

// ── inline note ─────────────────────────────────────────────────────────────────
check('#1095 note <slug> "<text>": drops a dated `- note <date>: <text>` sub-bullet on the CURRENT item + logs one [NOTE] ISO-TZ line', () => {
  const dir = mkSandbox('pl-note-inline');
  const opened = openSession(dir);
  const slug = slugOf(pl(dir, ['add', 'note target']));
  const logBefore = logLines(dir, opened.number).length;

  const r = pl(dir, ['note', slug, 'due Tuesday, slipped a day']);
  assert.strictEqual(r.code, 0, r.stderr);

  const lines = punchText(dir, opened.number).split('\n');
  const itemIdx = lines.findIndex((l) => l.includes('· note target'));
  assert.ok(itemIdx >= 0, 'the item line must be present');
  const noteLine = lines[itemIdx + 1];
  assert.ok(/^- note \d{4}-\d{2}-\d{2}: due Tuesday, slipped a day$/.test(noteLine),
    `a dated note sub-bullet must sit directly under the item: ${noteLine}`);
  assert.ok(ISO_DATE.test(noteLine), 'the note carries a dated (ISO-date) prefix');

  // logs a [NOTE] line like every op (D1: logs the ITEM text).
  const after = logLines(dir, opened.number);
  assert.strictEqual(after.length, logBefore + 1, 'a note op appends exactly one ledger line');
  const newest = after[after.length - 1];
  assert.ok(/^- \[NOTE\] /.test(newest), `newest ledger line must be tagged [NOTE]: ${newest}`);
  assert.ok(LOG_LINE_ISO_TZ.test(newest), 'the [NOTE] line carries a trailing ISO-TZ (by shape)');
});

check('#1095 note: a 300-char inline note is ACCEPTED; a 301-char note is REFUSED (exit 1), writing NOTHING and logging NOTHING', () => {
  const dir = mkSandbox('pl-note-cap');
  const opened = openSession(dir);
  const slug = slugOf(pl(dir, ['add', 'cap target']));

  // Boundary: exactly 300 chars is allowed.
  const ok300 = pl(dir, ['note', slug, 'x'.repeat(300)]);
  assert.strictEqual(ok300.code, 0, `a 300-char note must be accepted: ${ok300.stderr}`);

  const before = punchText(dir, opened.number);
  const logBefore = logLines(dir, opened.number).length;
  const r = pl(dir, ['note', slug, 'y'.repeat(301)]);
  assert.strictEqual(r.code, 1, 'a 301-char inline note must be refused');
  assert.ok(/301 chars|cap is 300|300/.test(r.stderr), `expected an over-cap message: ${r.stderr}`);
  assert.strictEqual(punchText(dir, opened.number), before, 'a refused note must write NOTHING (the file is unchanged)');
  assert.strictEqual(logLines(dir, opened.number).length, logBefore, 'a refused note must log NOTHING (G2)');
});

check('#1095 note: a newline in the inline note text is REFUSED (exit 1), writing NOTHING (G3)', () => {
  const dir = mkSandbox('pl-note-newline');
  const opened = openSession(dir);
  const slug = slugOf(pl(dir, ['add', 'newline target']));
  const before = punchText(dir, opened.number);
  const r = pl(dir, ['note', slug, 'alpha\nbeta']);
  assert.strictEqual(r.code, 1, 'a multi-line inline note must be refused');
  assert.ok(/single line|newline/i.test(r.stderr), `expected the newline-guard message: ${r.stderr}`);
  assert.strictEqual(punchText(dir, opened.number), before, 'a refused note must not modify the punchlist');
});

check('#1095 note on a slug NOT in the current session exits 1 (carry-first message) and writes NOTHING', () => {
  const c = priorAndCurrent('pl-note-nonlocal');
  const r = pl(c.dir, ['note', c.slug1, 'a note for a prior item']);
  assert.strictEqual(r.code, 1, 'a note on a non-local item must be refused');
  assert.ok(/carry it forward first/.test(r.stderr), `expected the "carry it forward first" message: ${r.stderr}`);
  assert.ok(!punchExists(c.dir, c.cur), 'a refused note must not create the current punchlist');
});

// ── --log see-log: sentinel ───────────────────────────────────────────────────────
check('#1095 note --log: writes a [PLNOTE] ledger line under a UNIQUE note-slug + drops a `see-log:...:<note-slug>` sentinel on the item', () => {
  const dir = mkSandbox('pl-note-log');
  const opened = openSession(dir);
  const num = opened.number;
  const slug = slugOf(pl(dir, ['add', 'offload target']));
  const full = 'x'.repeat(400); // UNLIMITED length (>300 inline cap), single line

  const r = pl(dir, ['note', slug, '--log', full]);
  assert.strictEqual(r.code, 0, r.stderr);

  // the punchlist gets a see-log sentinel sub-bullet naming this session's PREFIXED log file.
  const sentinel = noteLines(dir, num).find((l) => /: see-log:/.test(l));
  assert.ok(sentinel, 'a see-log sentinel sub-bullet must be dropped on the item');
  const m = new RegExp(`^- note \\d{4}-\\d{2}-\\d{2}: see-log:session-${num}-log\\.md:([0-9a-z]+)$`).exec(sentinel);
  assert.ok(m, `sentinel must be file-precise (session-${num}-log.md:<note-slug>): ${sentinel}`);
  const noteSlug = m[1];
  assert.notStrictEqual(noteSlug, slug, 'the note-slug must be distinct from the item slug (R6)');

  // the log gets exactly one [PLNOTE] line: the full (unlimited) text under the SAME note-slug + ISO-TZ.
  const plnote = logLines(dir, num).filter((l) => /^- \[PLNOTE\] /.test(l));
  assert.strictEqual(plnote.length, 1, 'exactly one [PLNOTE] ledger line');
  assert.ok(plnote[0].includes(full), 'the [PLNOTE] line preserves the full unlimited text');
  const tag = PLNOTE_TAG.exec(plnote[0]);
  assert.ok(tag, `the [PLNOTE] line must carry a [<note-slug>, <ISO-TZ>] trailing tag: ${plnote[0]}`);
  assert.strictEqual(tag[1], noteSlug, 'the sentinel note-slug must match the [PLNOTE] line note-slug (offload is followable)');
});

check('#1095 note --log: two offloads on the same item mint DISTINCT note-slugs (searchable, non-colliding)', () => {
  const dir = mkSandbox('pl-note-log-unique');
  const opened = openSession(dir);
  const num = opened.number;
  const slug = slugOf(pl(dir, ['add', 'double offload']));
  assert.strictEqual(pl(dir, ['note', slug, '--log', 'first long detail']).code, 0);
  assert.strictEqual(pl(dir, ['note', slug, '--log', 'second long detail']).code, 0);
  const slugs = noteLines(dir, num)
    .map((l) => /see-log:session-\d+-log\.md:([0-9a-z]+)$/.exec(l))
    .filter(Boolean)
    .map((mm) => mm[1]);
  assert.strictEqual(slugs.length, 2, 'both offloads leave a sentinel');
  assert.notStrictEqual(slugs[0], slugs[1], 'the two note-slugs must be distinct');
});

check('#1095 note --log is LOG-FIRST (D2/G5): a ledger-write failure aborts with NO sentinel on the punchlist', () => {
  const dir = mkSandbox('pl-note-log-first');
  const opened = openSession(dir);
  const num = opened.number;
  const slug = slugOf(pl(dir, ['add', 'log-first target']));
  const before = punchText(dir, num);
  // Sabotage the ledger target: replace session-NNNN-log.md (created by `add`) with a DIRECTORY → the
  // PLNOTE append hits EISDIR. Because the log is written FIRST, the sentinel writePunchlist never runs.
  const logP = logFilePath(dir, num);
  fs.rmSync(logP);
  fs.mkdirSync(logP);
  const r = pl(dir, ['note', slug, '--log', 'detail that can never be stored']);
  assert.notStrictEqual(r.code, 0, 'a ledger-write failure must be loud (exit != 0), never silently half-applied');
  assert.ok(r.stderr.length > 0, 'the failure must be reported on stderr');
  assert.strictEqual(punchText(dir, num), before,
    'LOG-FIRST: with the log write failing, the punchlist must carry NO sentinel (no dangling pointer)');
});

// ── carry / close DO NOT copy notes forward ─────────────────────────────────────────
check('#1095 carry does NOT copy a prior note forward — the carried copy has NO note sub-bullet', () => {
  const dir = mkSandbox('pl-carry-nonotes');
  const prior = openSession(dir);
  const slug = slugOf(pl(dir, ['add', 'prior task with a note']));
  assert.strictEqual(pl(dir, ['note', slug, 'this note must NOT travel forward']).code, 0);
  assert.ok(/this note must NOT travel forward/.test(punchText(dir, prior.number)), 'sanity: the prior copy HAS the note');
  sealSession(dir);
  const cur = openSession(dir);

  const r = pl(dir, ['carry', slug]);
  assert.strictEqual(r.code, 0, r.stderr);
  const curText = punchText(dir, cur.number);
  assert.ok(/prior task with a note/.test(curText), 'the ITEM itself carries forward');
  assert.ok(!/this note must NOT travel forward/.test(curText), 'the prior note must NOT be copied into the carried copy (#1095)');
  assert.strictEqual(noteLines(dir, cur.number).length, 0, 'the carried copy has zero note sub-bullets (each session holds only its own)');
});

check('#1095 cross-session close does NOT copy a prior note forward — the done copy has NO note sub-bullet', () => {
  const dir = mkSandbox('pl-xclose-nonotes');
  const prior = openSession(dir);
  const slug = slugOf(pl(dir, ['add', 'prior task to close']));
  assert.strictEqual(pl(dir, ['note', slug, 'note must not travel on close']).code, 0);
  sealSession(dir);
  const cur = openSession(dir);

  const r = pl(dir, ['close', slug]);
  assert.strictEqual(r.code, 0, r.stderr);
  const curText = punchText(dir, cur.number);
  assert.ok(/prior task to close/.test(curText), 'the done copy of the item is recorded in the current session');
  assert.ok(!/note must not travel on close/.test(curText), 'cross-session close must NOT copy the prior note (#1095)');
  assert.strictEqual(noteLines(dir, cur.number).length, 0, 'the closed copy has zero note sub-bullets');
});

process.stdout.write(`\nALL PASS (${count()} checks) — tests/session/tpm-session-punchlist/test.js\n`);
process.exit(0);
