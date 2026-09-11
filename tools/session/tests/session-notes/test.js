#!/usr/bin/env node
/**
 * tests/session/session-notes/test.js — genuine tests for tools/session/session-notes.js (the
 * write API, build-plan.md task B1) — the full open->save->seal lifecycle AND every guard rail
 * the tool claims to enforce.
 *
 * PURPOSE
 *   Drives session-notes.js as a REAL subprocess (per-verb CLI invocations) against a fresh
 *   sandbox sessionsDir under this phase folder's tmp/test-writer-r1/ (never the real
 *   claude-context/sessions/), and asserts on the actual on-disk file content each verb
 *   produces — not just exit codes. Covers:
 *     - the full lifecycle: open -> init -> resume -> open add/done -> log -> decide -> seal
 *     - the two-zone rule: RESUME is rewritten in place (exactly one ## RESUME block ever);
 *       Log/Decisions are append-only (never shrink, always grow)
 *     - every guard rail, each confirmed to exit 1: no-open-session, --edit-sealed without
 *       --confirm, --edit-sealed --confirm against a LEGACY freeform note, a bad open-item id
 *     - the deliberate override path DOES work: --edit-sealed <NNN> --confirm against a
 *       CANONICAL sealed note succeeds
 *     - --help / missing --sessions-dir / no-verb usage errors
 *
 * HOW TO RUN
 *   node tests/session/session-notes/test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeChecker, runNode, mkSandbox, TOOLS } = require('../lib/harness');

const { check, count } = makeChecker();

function run(sessionsDir, args) {
  return runNode(TOOLS.sessionNotes, ['--sessions-dir', sessionsDir, ...args]);
}

function noteText(sessionsDir, number, filename = 'session-notes.md') {
  return fs.readFileSync(path.join(sessionsDir, `session-${number}`, filename), 'utf8');
}

function openSession(sessionsDir) {
  const r = runNode(TOOLS.currentSession, ['--sessions-dir', sessionsDir, '--open']);
  assert.strictEqual(r.code, 0, `helper openSession failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// =====================================================================================
// GUARD RAILS — each must exit 1 with no session created / no file mutated
// =====================================================================================

check('GUARD: any write verb with no session open exits 1, telling the caller to `tpm-session open`', () => {
  const dir = mkSandbox('guard-no-open');
  const r = run(dir, ['resume', '--where', 'x', '--next', 'y']);
  assert.strictEqual(r.code, 1);
  assert.ok(/no session is currently open/.test(r.stderr));
  assert.ok(/tpm-session open/.test(r.stderr));
});

check('GUARD: `log` with no session open ALSO refuses (not just resume)', () => {
  const dir = mkSandbox('guard-no-open-log');
  const r = run(dir, ['log', '--status', 'WIP', 'did a thing']);
  assert.strictEqual(r.code, 1);
  assert.ok(/no session is currently open/.test(r.stderr));
});

check('GUARD: --edit-sealed WITHOUT --confirm exits 1 and touches nothing', () => {
  const dir = mkSandbox('guard-edit-sealed-noconfirm');
  const openResult = openSession(dir);
  run(dir, ['resume', '--where', 'a', '--next', 'b']);
  run(dir, ['seal']); // stamps the file AND closes the current-session pointer (ctx.isCurrent)
  const before = noteText(dir, openResult.number);

  const r = run(dir, ['--edit-sealed', openResult.number, 'log', '--status', 'WIP', 'sneaky edit']);
  assert.strictEqual(r.code, 1);
  assert.ok(/requires --confirm/.test(r.stderr));
  assert.strictEqual(noteText(dir, openResult.number), before, 'the file must be byte-identical after a refused edit');
});

check('GUARD: --edit-sealed --confirm against a LEGACY freeform note (no canonical title) refuses with ENOTCANONICAL, touches nothing', () => {
  const dir = mkSandbox('guard-legacy-refuse');
  const folder = path.join(dir, 'session-003');
  fs.mkdirSync(folder, { recursive: true });
  const legacyPath = path.join(folder, 'notes.md');
  const legacyContent = 'Just freeform prose from before this tool existed. No headings.\n';
  fs.writeFileSync(legacyPath, legacyContent);

  const r = run(dir, ['--edit-sealed', '003', '--confirm', 'log', '--status', 'WIP', 'trying to touch legacy']);
  assert.strictEqual(r.code, 1);
  assert.ok(/refuses to auto-rewrite/.test(r.stderr), `expected the ENOTCANONICAL message, got: ${r.stderr}`);
  assert.strictEqual(fs.readFileSync(legacyPath, 'utf8'), legacyContent, 'legacy file must be untouched');
});

check('GUARD: `open done <id>` for a nonexistent open-item id exits 1 and does not mutate the file', () => {
  const dir = mkSandbox('guard-bad-item-id');
  const opened = openSession(dir);
  run(dir, ['open', 'add', '--owner', 'jason', 'a real item']);
  const before = noteText(dir, opened.number);

  const r = run(dir, ['open', 'done', '9999']);
  assert.strictEqual(r.code, 1);
  assert.ok(/no open item #9999/.test(r.stderr));
  assert.strictEqual(noteText(dir, opened.number), before, 'file must be unchanged after a refused done-id');
});

check('GUARD: `resume` without --where/--next exits 1 (required args enforced)', () => {
  const dir = mkSandbox('guard-resume-args');
  openSession(dir);
  const r = run(dir, ['resume', '--where', 'only where, no next']);
  assert.strictEqual(r.code, 1);
  assert.ok(/requires --where and --next/.test(r.stderr));
});

check('GUARD: `open add` without --owner exits 1', () => {
  const dir = mkSandbox('guard-open-add-args');
  openSession(dir);
  const r = run(dir, ['open', 'add', 'text with no --owner flag']);
  assert.strictEqual(r.code, 1);
  assert.ok(/requires --owner/.test(r.stderr));
});

check('GUARD: `decide` without --why exits 1', () => {
  const dir = mkSandbox('guard-decide-args');
  openSession(dir);
  const r = run(dir, ['decide', 'a decision with no why']);
  assert.strictEqual(r.code, 1);
  assert.ok(/requires a text argument and --why/.test(r.stderr));
});

check('CLI: missing --sessions-dir exits 1', () => {
  const r = runNode(TOOLS.sessionNotes, ['resume', '--where', 'x', '--next', 'y']);
  assert.strictEqual(r.code, 1);
  assert.ok(/--sessions-dir is required/.test(r.stderr));
});

check('CLI: no verb given exits 1', () => {
  const dir = mkSandbox('cli-no-verb');
  const r = run(dir, []);
  assert.strictEqual(r.code, 1);
});

check('CLI: unknown verb exits 1', () => {
  const dir = mkSandbox('cli-unknown-verb');
  openSession(dir);
  const r = run(dir, ['bogus-verb']);
  assert.strictEqual(r.code, 1);
  assert.ok(/unknown verb/.test(r.stderr));
});

check('CLI: --help exits 0', () => {
  const r = runNode(TOOLS.sessionNotes, ['--help']);
  assert.strictEqual(r.code, 0);
  assert.ok(/Usage: node session-notes\.js/.test(r.stdout));
});

// =====================================================================================
// THE DELIBERATE OVERRIDE PATH DOES work
// =====================================================================================

check('--edit-sealed <NNN> --confirm against a CANONICAL sealed note DOES succeed (the deliberate override)', () => {
  const dir = mkSandbox('override-canonical-sealed');
  const opened = openSession(dir);
  run(dir, ['resume', '--where', 'setting up', '--next', 'seal it']);
  run(dir, ['seal']); // ctx.isCurrent is true here, so this also closes the current-session pointer

  const r = run(dir, ['--edit-sealed', opened.number, '--confirm', 'log', '--status', 'WIP', 'a deliberate post-seal log line']);
  assert.strictEqual(r.code, 0, `expected the override to succeed, got: ${r.stderr}`);
  const text = noteText(dir, opened.number);
  assert.ok(text.includes('a deliberate post-seal log line'), 'the override log line must actually land in the file');
  assert.ok(text.includes('SEALED'), 'the SEALED stamp must still be present after an override edit');
});

// =====================================================================================
// FULL LIFECYCLE — open -> init -> resume(x2) -> open add/done -> log -> decide -> seal
// =====================================================================================

check('FULL LIFECYCLE: open allocates a new session and init creates the skeleton file', () => {
  const dir = mkSandbox('lifecycle-open-init');
  const opened = openSession(dir);
  assert.strictEqual(opened.isNew, true);

  const initR = run(dir, ['init', '--theme', 'lifecycle test']);
  assert.strictEqual(initR.code, 0);
  const text = noteText(dir, opened.number);
  assert.ok(text.startsWith(`# SESSION ${opened.number} — `), 'file must start with the canonical title');
  assert.ok(text.includes('lifecycle test'));
});

check('FULL LIFECYCLE: init is idempotent — calling it again on an existing file is a no-op that reports so', () => {
  const dir = mkSandbox('lifecycle-init-idempotent');
  const opened = openSession(dir);
  run(dir, ['init', '--theme', 'first theme']);
  const before = noteText(dir, opened.number);
  const r = run(dir, ['init', '--theme', 'a DIFFERENT theme that must be ignored']);
  assert.strictEqual(r.code, 0);
  assert.ok(/already exists — nothing to init/.test(r.stdout));
  assert.strictEqual(noteText(dir, opened.number), before, 'a second init must not touch the existing file');
});

check('FULL LIFECYCLE: resume REWRITES the RESUME block in place — exactly one ## RESUME block ever, latest content wins', () => {
  const dir = mkSandbox('lifecycle-resume-rewrite');
  const opened = openSession(dir);
  run(dir, ['resume', '--where', 'checkpoint 1', '--next', 'do the next thing', '--in-flight', 'nothing']);
  run(dir, ['resume', '--where', 'checkpoint 2 — DIFFERENT text', '--next', 'a different next step']);

  const text = noteText(dir, opened.number);
  const resumeBlockCount = (text.match(/^## RESUME$/gm) || []).length;
  assert.strictEqual(resumeBlockCount, 1, 'must be exactly one ## RESUME heading (update-not-append)');
  assert.ok(text.includes('checkpoint 2 — DIFFERENT text'), 'the LATEST where-we-are text must be present');
  assert.ok(!text.includes('checkpoint 1'), 'the STALE first-checkpoint text must be gone (rewritten, not appended)');
});

check('FULL LIFECYCLE: `open add` appends items with sequential ids; `open done` checks the right one off in place', () => {
  const dir = mkSandbox('lifecycle-open-items');
  const opened = openSession(dir);
  run(dir, ['open', 'add', '--owner', 'jason', 'first open item']);
  run(dir, ['open', 'add', '--owner', 'claude', 'second open item']);
  run(dir, ['open', 'done', '1']);

  const text = noteText(dir, opened.number);
  assert.ok(/- \[x\] OPEN\(jason\) #1: first open item/.test(text), 'item #1 must be checked');
  assert.ok(/- \[ \] OPEN\(claude\) #2: second open item/.test(text), 'item #2 must remain unchecked');
});

check('FULL LIFECYCLE: `log` entries are APPEND-ONLY — two log calls produce two entries, in order, none lost', () => {
  const dir = mkSandbox('lifecycle-log-append');
  const opened = openSession(dir);
  run(dir, ['log', '--status', 'WIP', 'first log line']);
  run(dir, ['log', '--status', 'DONE', 'second log line']);

  const text = noteText(dir, opened.number);
  const firstIdx = text.indexOf('first log line');
  const secondIdx = text.indexOf('second log line');
  assert.ok(firstIdx >= 0 && secondIdx >= 0, 'both log lines must be present');
  assert.ok(firstIdx < secondIdx, 'log lines must appear in chronological (append) order');
  assert.ok(text.includes('[WIP]') && text.includes('[DONE]'), 'both status tags must survive');
});

check('FULL LIFECYCLE: `decide` entries are APPEND-ONLY — two decisions both survive', () => {
  const dir = mkSandbox('lifecycle-decide-append');
  const opened = openSession(dir);
  run(dir, ['decide', 'first decision', '--why', 'reason A']);
  run(dir, ['decide', 'second decision', '--why', 'reason B']);

  const text = noteText(dir, opened.number);
  assert.ok(text.includes('first decision') && text.includes('reason A'));
  assert.ok(text.includes('second decision') && text.includes('reason B'));
});

check('FULL LIFECYCLE: seal stamps SEALED <date> in the file AND closes the current-session pointer', () => {
  const dir = mkSandbox('lifecycle-seal');
  const opened = openSession(dir);
  run(dir, ['resume', '--where', 'wrapping up', '--next', 'none']);

  const stateBeforeSeal = runNode(TOOLS.currentSession, ['--sessions-dir', dir, '--state']);
  assert.strictEqual(JSON.parse(stateBeforeSeal.stdout).state, 'open');

  const sealR = run(dir, ['seal']);
  assert.strictEqual(sealR.code, 0);

  const text = noteText(dir, opened.number);
  assert.ok(/^SEALED \d{4}-\d{2}-\d{2}$/m.test(text), 'file must carry a SEALED <date> trailer line');

  const stateAfterSeal = runNode(TOOLS.currentSession, ['--sessions-dir', dir, '--state']);
  assert.strictEqual(JSON.parse(stateAfterSeal.stdout).state, 'not-opened', 'seal must close the pointer, not just stamp the file');
});

check('FULL LIFECYCLE: a bare invocation right after seal (next --next-number) allocates a NEW number, never reusing the sealed one', () => {
  const dir = mkSandbox('lifecycle-post-seal-next');
  const opened = openSession(dir);
  run(dir, ['seal']); // ctx.isCurrent is true here, so this also closes the current-session pointer

  const nextR = runNode(TOOLS.currentSession, ['--sessions-dir', dir, '--next-number']);
  assert.strictEqual(nextR.code, 0);
  const next = nextR.stdout.trim();
  assert.notStrictEqual(next, opened.number);
});

check('FULL LIFECYCLE: any write verb lazily creates the skeleton file if `init` was never called explicitly', () => {
  const dir = mkSandbox('lifecycle-lazy-init');
  const opened = openSession(dir);
  // No `init` call at all — go straight to `log`.
  const r = run(dir, ['log', '--status', 'WIP', 'first thing, no explicit init']);
  assert.strictEqual(r.code, 0);
  const text = noteText(dir, opened.number);
  assert.ok(text.startsWith(`# SESSION ${opened.number} — `));
  assert.ok(text.includes('(untitled)'), 'a lazily-created note gets the "(untitled)" placeholder theme');
});

// =====================================================================================
// REGRESSION (Bug-fixer r1): a custom `log --status <TAG>` line must survive a SUBSEQUENT
// write, end-to-end via the real CLI — not just at the parser-unit level. This is exactly the
// repro from findings/verifier-r1-v1-verdict.md §2a: a data-loss bug where a free-text status
// tag (the docstring's own promised contract) was silently dropped from disk the next time
// anything else was written to the session, because LOG_ENTRY_RE only recognized the 6
// canonical STATUS_TAGS.
// =====================================================================================

check('REGRESSION: a custom `log --status` tag survives a SECOND write on disk (was silently dropped pre-fix)', () => {
  const dir = mkSandbox('regression-custom-status-survives');
  const opened = openSession(dir);

  const r1 = run(dir, ['log', '--status', 'CUSTOM', 'a custom-tagged log line']);
  assert.strictEqual(r1.code, 0, `first log call failed: ${r1.stderr}`);
  const afterFirst = noteText(dir, opened.number);
  assert.ok(afterFirst.includes('[CUSTOM]') && afterFirst.includes('a custom-tagged log line'),
    'the custom-tagged line must be present immediately after the first write');

  // A SECOND write to the same session — this is the step that previously reloaded the file,
  // failed to parse the [CUSTOM] line (LOG_ENTRY_RE didn't recognize it), and silently
  // re-rendered the file WITHOUT it.
  const r2 = run(dir, ['log', '--status', 'DONE', 'a normal entry']);
  assert.strictEqual(r2.code, 0, `second log call failed: ${r2.stderr}`);

  const afterSecond = noteText(dir, opened.number);
  assert.ok(afterSecond.includes('[CUSTOM]') && afterSecond.includes('a custom-tagged log line'),
    'the custom-tagged line must SURVIVE a subsequent write — this is the data-loss regression');
  assert.ok(afterSecond.includes('[DONE]') && afterSecond.includes('a normal entry'),
    'the new canonical-tag line must also be present');

  // Order + count: both entries present exactly once, custom line first (append order).
  const customIdx = afterSecond.indexOf('a custom-tagged log line');
  const doneIdx = afterSecond.indexOf('a normal entry');
  assert.ok(customIdx >= 0 && doneIdx >= 0 && customIdx < doneIdx, 'both lines present, in append order');
});

process.stdout.write(`\nALL PASS (${count()} checks) — tests/session/session-notes/test.js\n`);
process.exit(0);
