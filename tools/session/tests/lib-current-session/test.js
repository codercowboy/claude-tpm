#!/usr/bin/env node
/**
 * tests/session/lib-current-session/test.js — genuine tests for tools/session/lib/current-session.js.
 *
 * PURPOSE
 *   The state-resolver + NNN allocator (build-plan.md task A2) — the single riskiest piece of
 *   this subsystem per build-plan.md §5.1. Exercises the module API directly (in-process,
 *   real fs against a sandbox dir) AND the CLI (subprocess, real exit codes / JSON output),
 *   against the ACTUAL claims the module docstring makes:
 *     - allocateNextNumber = highest existing session-NNN + 1, "001" if none.
 *     - resolveCurrentSession: no pointer / closed pointer => not-opened; open pointer => open.
 *     - openSession is idempotent (same number, isNew:false on the second call).
 *     - sealSession stamps closedAt and throws ENOTHING_OPEN if nothing is open.
 *     - the mechanism stays correct with $CLAUDE_CODE_SESSION_ID fully UNSET (the graceful-
 *       degradation claim build-plan.md §5.1 and HANDOFF.md item 9 both call out).
 *
 *   Never touches the real claude-context/sessions/ — every sessionsDir here is a fresh
 *   sandbox under this phase folder's tmp/test-writer-r1/ (see ../lib/harness.js).
 *
 * HOW TO RUN
 *   node tests/session/lib-current-session/test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeChecker, runNode, mkSandbox, TOOLS } = require('../lib/harness');

const cs = require(TOOLS.currentSession);
const { check, count } = makeChecker();

// ---- readEnvSessionId ---------------------------------------------------------

check('readEnvSessionId reads a non-empty $CLAUDE_CODE_SESSION_ID', () => {
  const prev = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'abc-123';
  try {
    assert.strictEqual(cs.readEnvSessionId(), 'abc-123');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prev;
  }
});

check('readEnvSessionId returns null when unset or blank', () => {
  const prev = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  try {
    assert.strictEqual(cs.readEnvSessionId(), null);
    process.env.CLAUDE_CODE_SESSION_ID = '   ';
    assert.strictEqual(cs.readEnvSessionId(), null);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prev;
  }
});

// ---- allocateNextNumber --------------------------------------------------------

check('allocateNextNumber returns "001" when sessionsDir does not exist yet', () => {
  const dir = mkSandbox('alloc-empty');
  const sessionsDir = path.join(dir, 'sessions'); // deliberately not created
  assert.strictEqual(cs.allocateNextNumber({ sessionsDir }), '001');
});

check('allocateNextNumber returns highest existing session-NNN + 1', () => {
  const dir = mkSandbox('alloc-existing');
  for (const n of ['session-001', 'session-002', 'session-007']) {
    fs.mkdirSync(path.join(dir, n), { recursive: true });
  }
  assert.strictEqual(cs.allocateNextNumber({ sessionsDir: dir }), '008');
});

check('allocateNextNumber ignores non-matching dir names and non-directory entries', () => {
  const dir = mkSandbox('alloc-noise');
  fs.mkdirSync(path.join(dir, 'session-003'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'not-a-session-dir'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'session-999x'), { recursive: true }); // doesn't match \d{3}$ exactly
  fs.writeFileSync(path.join(dir, 'session-010'), 'this is a FILE named like a session dir, not a dir');
  assert.strictEqual(cs.allocateNextNumber({ sessionsDir: dir }), '004');
});

// ---- resolveCurrentSession / openSession / sealSession -------------------------

check('resolveCurrentSession reports not-opened when no pointer file exists', () => {
  const dir = mkSandbox('resolve-nopointer');
  const r = cs.resolveCurrentSession({ sessionsDir: dir });
  assert.strictEqual(r.state, 'not-opened');
  assert.strictEqual(r.number, null);
});

check('openSession on an empty sessionsDir allocates "001" and marks isNew: true', () => {
  const dir = mkSandbox('open-fresh');
  const r = cs.openSession({ sessionsDir: dir });
  assert.strictEqual(r.number, '001');
  assert.strictEqual(r.isNew, true);
  assert.ok(fs.existsSync(path.join(dir, '.current-session.json')), 'pointer file must be written');
});

check('openSession is idempotent — a second call with nothing closed returns the SAME number and isNew: false', () => {
  const dir = mkSandbox('open-idempotent');
  const first = cs.openSession({ sessionsDir: dir });
  const second = cs.openSession({ sessionsDir: dir });
  assert.strictEqual(second.number, first.number);
  assert.strictEqual(second.isNew, false);
});

check('resolveCurrentSession reports state: open with the pointer\'s number after openSession', () => {
  const dir = mkSandbox('resolve-open');
  cs.openSession({ sessionsDir: dir });
  const r = cs.resolveCurrentSession({ sessionsDir: dir });
  assert.strictEqual(r.state, 'open');
  assert.strictEqual(r.number, '001');
});

check('sealSession throws ENOTHING_OPEN when nothing is open', () => {
  const dir = mkSandbox('seal-nothing');
  assert.throws(() => cs.sealSession({ sessionsDir: dir }), (err) => err.code === 'ENOTHING_OPEN');
});

check('sealSession stamps closedAt and flips resolveCurrentSession back to not-opened', () => {
  const dir = mkSandbox('seal-flow');
  const opened = cs.openSession({ sessionsDir: dir });
  const sealed = cs.sealSession({ sessionsDir: dir });
  assert.strictEqual(sealed.number, opened.number);
  assert.ok(sealed.closedAt, 'closedAt must be stamped');
  const after = cs.resolveCurrentSession({ sessionsDir: dir });
  assert.strictEqual(after.state, 'not-opened');
});

check('after seal (with a real session-NNN folder on disk, as a note write would create), the NEXT openSession allocates a NEW number and isNew: true', () => {
  const dir = mkSandbox('seal-then-reopen');
  const first = cs.openSession({ sessionsDir: dir });
  // allocateNextNumber scans actual session-NNN FOLDERS on disk, not the pointer — openSession
  // itself never creates one (that's session-notes.js's job on the first real note write). To
  // exercise the realistic "a note was written, then sealed, then reopened" path, create the
  // folder the write API would have created before sealing.
  fs.mkdirSync(path.join(dir, `session-${first.number}`), { recursive: true });
  cs.sealSession({ sessionsDir: dir });
  const second = cs.openSession({ sessionsDir: dir });
  assert.notStrictEqual(second.number, first.number);
  assert.strictEqual(second.isNew, true);
  assert.strictEqual(second.number, '002');
});

// ---- KNOWN LIMITATION: allocateNextNumber only sees FOLDERS, not the pointer ----
// If a session is opened and sealed WITHOUT ever writing a note (so no session-NNN folder was
// ever created on disk — openSession itself never creates one), the number is never "consumed"
// from allocateNextNumber's point of view: the very next open reuses the SAME number. This is
// probably harmless in practice (nothing was ever written under that number, so reusing it
// loses nothing) but it means the pointer's `number` and "the highest folder that exists" can
// diverge from what a human might expect ("every open consumes a number"). Pinned here as
// documented current behavior, not fixed — see findings/HANDOFF.md.
check('KNOWN LIMITATION — sealing a session that never got a note file written means the NEXT open reuses the SAME number', () => {
  const dir = mkSandbox('seal-empty-reopen');
  const first = cs.openSession({ sessionsDir: dir }); // no folder ever created for this session
  cs.sealSession({ sessionsDir: dir });
  const second = cs.openSession({ sessionsDir: dir });
  assert.strictEqual(second.number, first.number, 'documents that the number is reused, not advanced, when nothing was ever written');
});

// ---- graceful degradation with $CLAUDE_CODE_SESSION_ID fully unset --------------
// This is the direct mitigation for build-plan.md §5.1's residual risk: the mechanism must
// stay correct even if the env var read never works outside a subagent. openSession/seal/state
// must all still function with the env var absent, and sessionId is recorded as null, never
// gating anything.

check('openSession with $CLAUDE_CODE_SESSION_ID unset still opens correctly, recording sessionId: null', () => {
  const dir = mkSandbox('degrade-open');
  const prev = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  try {
    const r = cs.openSession({ sessionsDir: dir });
    assert.strictEqual(r.sessionId, null);
    assert.strictEqual(r.isNew, true);
    const pointer = JSON.parse(fs.readFileSync(path.join(dir, '.current-session.json'), 'utf8'));
    assert.strictEqual(pointer.sessionId, null);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prev;
  }
});

check('resolveCurrentSession state stays "open" (continuity wins) even when the env sessionId does not match the pointer\'s', () => {
  const dir = mkSandbox('degrade-mismatch');
  const prevEnv = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'session-A';
  try {
    cs.openSession({ sessionsDir: dir }); // pointer.sessionId = 'session-A'
    process.env.CLAUDE_CODE_SESSION_ID = 'session-B'; // simulate a different observed sessionId
    const r = cs.resolveCurrentSession({ sessionsDir: dir });
    assert.strictEqual(r.state, 'open', 'a closed-vs-open decision must never hinge on sessionId matching');
    assert.strictEqual(r.sessionIdMismatch, true, 'the mismatch should still be surfaced for diagnostics');
  } finally {
    if (prevEnv === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prevEnv;
  }
});

// ---- CLI surface (subprocess, real exit codes) ----------------------------------

check('CLI --next-number prints the allocation with no side effect (no pointer file written)', () => {
  const dir = mkSandbox('cli-next-number');
  const r = runNode(TOOLS.currentSession, ['--sessions-dir', dir, '--next-number']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout.trim(), '001');
  assert.ok(!fs.existsSync(path.join(dir, '.current-session.json')), '--next-number must not write a pointer');
});

check('CLI --state on an empty dir reports not-opened as JSON', () => {
  const dir = mkSandbox('cli-state-empty');
  const r = runNode(TOOLS.currentSession, ['--sessions-dir', dir, '--state']);
  assert.strictEqual(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.state, 'not-opened');
});

check('CLI --open then --seal then --state round-trips to not-opened, matching the module API', () => {
  const dir = mkSandbox('cli-lifecycle');
  const openR = runNode(TOOLS.currentSession, ['--sessions-dir', dir, '--open']);
  assert.strictEqual(openR.code, 0);
  const sealR = runNode(TOOLS.currentSession, ['--sessions-dir', dir, '--seal']);
  assert.strictEqual(sealR.code, 0);
  const stateR = runNode(TOOLS.currentSession, ['--sessions-dir', dir, '--state']);
  assert.strictEqual(JSON.parse(stateR.stdout).state, 'not-opened');
});

check('CLI exits 1 with no side effect when --sessions-dir is omitted', () => {
  const r = runNode(TOOLS.currentSession, ['--state']);
  assert.strictEqual(r.code, 1);
  assert.ok(/--sessions-dir is required/.test(r.stderr));
});

check('CLI exits 1 when no action flag is given', () => {
  const dir = mkSandbox('cli-no-action');
  const r = runNode(TOOLS.currentSession, ['--sessions-dir', dir]);
  assert.strictEqual(r.code, 1);
  assert.ok(/nothing to do/.test(r.stderr));
});

check('CLI --seal on an empty dir exits 1 with the ENOTHING_OPEN message', () => {
  const dir = mkSandbox('cli-seal-nothing');
  const r = runNode(TOOLS.currentSession, ['--sessions-dir', dir, '--seal']);
  assert.strictEqual(r.code, 1);
  assert.ok(/nothing is currently open to seal/.test(r.stderr));
});

process.stdout.write(`\nALL PASS (${count()} checks) — tests/session/lib-current-session/test.js\n`);
process.exit(0);
