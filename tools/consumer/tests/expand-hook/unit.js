#!/usr/bin/env node
/**
 * unit.js — deterministic unit test for the expand-tpm-home PreToolUse hook. Zero deps, no `claude`
 * needed: it pipes sample PreToolUse payloads through the hook and asserts stdout. This is the FAST
 * half of proving the mechanism; smoke.sh is the LLM-in-the-loop half.
 *
 * Locks in the three empirically-verified rules (see the hook's header):
 *   1. resolve is emitted WITH `permissionDecision:"allow"` (updatedInput is ignored without it);
 *   2. READ-FAMILY ONLY — Write/Edit are never rewritten or auto-allowed (so writes to the bundle are
 *      never silently approved, and the literal ${TPM_HOME} survives in anything Claude authors);
 *   3. CONTAINMENT — a resolved path that escapes $TPM_HOME via `..` is refused.
 * Plus the harness cwd-prefix gotcha and fail-open behavior.
 *
 * Usage:  node tools/consumer/tests/expand-hook/unit.js   → exit 0 all pass, 1 otherwise.
 */
'use strict';

const cp = require('child_process');
const path = require('path');
const assert = require('assert');

const HOOK = path.resolve(__dirname, '..', '..', 'hooks', 'expand-tpm-home.js');
const HOME = '/abs/node_modules/@codercowboy/claude-tpm';           // synthetic root, pinned via override
const SELF_ROOT = path.resolve(path.dirname(HOOK), '..', '..', '..'); // the REAL bundle the hook self-locates

// Run the hook with a given stdin payload. By default we pin a synthetic bundle root via
// TPM_HOME_OVERRIDE (so assertions are stable); pass { override: undefined } to exercise self-location.
function run(payload, opts = { override: HOME }) {
  const env = { ...process.env };
  delete env.TPM_HOME_OVERRIDE;
  if (opts.override !== undefined) env.TPM_HOME_OVERRIDE = opts.override;
  const r = cp.spawnSync('node', [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env,
    encoding: 'utf8',
  });
  return { out: r.stdout || '', code: r.status };
}
function hookOut(out) {
  if (!out.trim()) return null;
  return JSON.parse(out).hookSpecificOutput || null;
}
function updatedInput(out) {
  const h = hookOut(out);
  return h ? (h.updatedInput || null) : null;
}

let pass = 0; let fail = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ✓ ${name}\n`); pass += 1; }
  catch (e) { process.stdout.write(`  ✗ ${name}\n      ${e.message}\n`); fail += 1; }
}

// 1. Read.file_path WITH token → expanded, AND paired with permissionDecision:"allow" (rule 1).
check('Read.file_path expands + returns permissionDecision:allow', () => {
  const out = run({ tool_name: 'Read', tool_input: { file_path: '${TPM_HOME}/claude-context/methodology/x.md' } }).out;
  const h = hookOut(out);
  assert(h, 'expected hookSpecificOutput');
  assert.strictEqual(h.permissionDecision, 'allow', 'must auto-allow, else updatedInput is ignored by CC');
  assert.strictEqual(h.updatedInput.file_path, `${HOME}/claude-context/methodology/x.md`);
});

// 1b. HARNESS GOTCHA: relative token path arrives cwd-prefixed → strip cwd first, then expand cleanly.
check('cwd-prefixed ${TPM_HOME} path is un-prefixed, then expanded cleanly', () => {
  const cwd = '/priv/project';
  const u = updatedInput(run({ tool_name: 'Read', cwd, tool_input: { file_path: cwd + '/${TPM_HOME}/sentinel.txt' } }).out);
  assert(u, 'expected updatedInput');
  assert.strictEqual(u.file_path, `${HOME}/sentinel.txt`, 'must be <home>/sentinel.txt, not <cwd>/<home>/…');
});

// 2. SAFETY (rule 2): Write is NOT read-family → never rewritten/allowed, so its content token survives
//    and no write into the bundle is ever silently approved.
check('Write is not read-family → no output (content token survives, no auto-allow)', () => {
  const out = run({ tool_name: 'Write', tool_input: { file_path: './skills/foo.md', content: 'read ${TPM_HOME}/tools/bar.js' } }).out;
  assert.strictEqual(hookOut(out), null, 'Write must never be rewritten or auto-allowed');
});

// 3. SAFETY (rule 2): Edit with a ${TPM_HOME} file_path is NOT auto-allowed either.
check('Edit is not read-family → no output (never auto-allow a bundle edit)', () => {
  const out = run({ tool_name: 'Edit', tool_input: { file_path: '${TPM_HOME}/tools/x.js', old_string: 'a', new_string: 'b' } }).out;
  assert.strictEqual(hookOut(out), null);
});

// 4. Read WITHOUT the token → untouched (no corruption, no needless auto-allow).
check('plain relative file_path (no token) → no output', () => {
  assert.strictEqual(hookOut(run({ tool_name: 'Read', tool_input: { file_path: 'dev/task/plan.md' } }).out), null);
});

// 5. Multiple occurrences in one path → all replaced.
check('multiple ${TPM_HOME} occurrences all replaced', () => {
  const u = updatedInput(run({ tool_name: 'Grep', tool_input: { path: '${TPM_HOME}/a/${TPM_HOME}/b' } }).out);
  assert.strictEqual(u.path, `${HOME}/a/${HOME}/b`);
});

// 6. CONTAINMENT (rule 3): a resolved path escaping the bundle via `..` is refused (no auto-allow).
check('${TPM_HOME}/../../etc/passwd escapes bundle → refused', () => {
  const out = run({ tool_name: 'Read', tool_input: { file_path: '${TPM_HOME}/../../../../etc/passwd' } }).out;
  assert.strictEqual(hookOut(out), null, 'must refuse to resolve+allow a path that escapes $TPM_HOME');
});

// 7. FAIL-OPEN: unparseable stdin → exit 0, emit nothing.
check('malformed stdin → exit 0, no output', () => {
  const r = run('this is not json');
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.out.trim(), '');
});

// 8. SELF-LOCATION: with no override, the hook derives the bundle root from its own __dirname (up 3)
//    and expands to the REAL bundle — no env var, no ${CLAUDE_PROJECT_DIR} interpolation needed.
check('no override → self-locates bundle root from __dirname', () => {
  const u = updatedInput(run({ tool_name: 'Read', tool_input: { file_path: '${TPM_HOME}/claude-context/methodology/overview.md' } }, { override: undefined }).out);
  assert(u, 'expected updatedInput via self-location');
  assert.strictEqual(u.file_path, `${SELF_ROOT}/claude-context/methodology/overview.md`);
});

// 9. Empty stdin → exit 0, emit nothing.
check('empty stdin → exit 0, no output', () => {
  const r = run('');
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.out.trim(), '');
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
