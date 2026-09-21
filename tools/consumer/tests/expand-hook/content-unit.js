#!/usr/bin/env node
/**
 * content-unit.js — deterministic unit test for the expand-tpm-home-content PostToolUse hook. Zero
 * deps, no `claude` needed: it pipes sample PostToolUse payloads through the hook and asserts stdout.
 * The bypass-safe counterpart to unit.js (which covers the PreToolUse path hook).
 *
 * Locks in the content hook's contract (see the hook's header):
 *   1. resolves ${TPM_HOME} / %TPM_HOME% found in a read tool's RETURNED CONTENT, emitting
 *      hookSpecificOutput.updatedToolOutput with the token replaced by the bundle root (shape preserved);
 *   2. SOURCE-REPO GUARD — when cwd === the self-located bundle root, it emits NOTHING (so resolving
 *      content can never break in-place doc maintenance in the claude-tpm source repo);
 *   3. READ-FAMILY ONLY — a Write/Edit/Bash result is never rewritten;
 *   4. fail-open — no token, unparseable/empty stdin, or a non-read tool ⇒ exit 0, emit nothing.
 *
 * Usage:  node tools/consumer/tests/expand-hook/content-unit.js   → exit 0 all pass, 1 otherwise.
 */
'use strict';

const cp = require('child_process');
const path = require('path');
const assert = require('assert');

const HOOK = path.resolve(__dirname, '..', '..', 'hooks', 'expand-tpm-home-content.js');
const HOME = '/abs/node_modules/@codercowboy/claude-tpm';            // synthetic root, pinned via override
const SELF_ROOT = path.resolve(path.dirname(HOOK), '..', '..', '..'); // the REAL bundle the hook self-locates
const CWD = '/priv/consumer';                                        // a consumer cwd (≠ bundle root)

// Run the hook with a given stdin payload. By default pin a synthetic bundle root via TPM_HOME_OVERRIDE
// (so assertions are stable); pass { override: undefined } to exercise self-location.
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
function updatedOutput(out) {
  if (!out.trim()) return null;
  const h = JSON.parse(out).hookSpecificOutput || null;
  return h ? (h.updatedToolOutput !== undefined ? h.updatedToolOutput : null) : null;
}

let pass = 0; let fail = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ✓ ${name}\n`); pass += 1; }
  catch (e) { process.stdout.write(`  ✗ ${name}\n      ${e.message}\n`); fail += 1; }
}

// 1. Read content with ${TPM_HOME} → resolved in updatedToolOutput, shape preserved (rule 1).
check('Read content token → resolved, file.content shape preserved', () => {
  const tr = { type: 'text', file: { filePath: 'doc.md', content: 'see ${TPM_HOME}/readme.md' } };
  const u = updatedOutput(run({ tool_name: 'Read', cwd: CWD, tool_response: tr }).out);
  assert(u, 'expected updatedToolOutput');
  assert.strictEqual(u.file.content, `see ${HOME}/readme.md`);
  assert.strictEqual(u.file.filePath, 'doc.md', 'non-token fields must be untouched');
});

// 2. %TPM_HOME% spelling is resolved too (transition spelling, #1098).
check('%TPM_HOME% spelling resolved', () => {
  const u = updatedOutput(run({ tool_name: 'Read', cwd: CWD, tool_response: { file: { content: 'x %TPM_HOME%/y' } } }).out);
  assert.strictEqual(u.file.content, `x ${HOME}/y`);
});

// 3. Both spellings + multiple occurrences in one payload → all replaced.
check('both spellings, multiple occurrences → all replaced', () => {
  const c = '${TPM_HOME}/a and %TPM_HOME%/b and ${TPM_HOME}/c';
  const u = updatedOutput(run({ tool_name: 'Read', cwd: CWD, tool_response: { file: { content: c } } }).out);
  assert.strictEqual(u.file.content, `${HOME}/a and ${HOME}/b and ${HOME}/c`);
});

// 4. BUNDLE GUARD (rule 2): cwd === bundle root → emit nothing.
check('cwd === bundle root → no output (source-repo guard)', () => {
  const out = run({ tool_name: 'Read', cwd: HOME, tool_response: { file: { content: 'see ${TPM_HOME}/x' } } }).out;
  assert.strictEqual(updatedOutput(out), null, 'must not resolve content while editing the bundle in place');
});

// 4b. BUNDLE GUARD (broadened): read TARGET inside the bundle → emit nothing, even from a consumer cwd
//     (the sibling-workspace-editing-the-bundle case a cwd-only guard missed).
check('read target inside bundle → no output (bundle guard, cwd != bundle)', () => {
  const out = run({ tool_name: 'Read', cwd: CWD, tool_input: { file_path: HOME + '/claude-context/x.md' }, tool_response: { file: { content: 'see ${TPM_HOME}/x' } } }).out;
  assert.strictEqual(updatedOutput(out), null, 'an in-bundle read must never be content-rewritten');
});

// 4c. read TARGET outside the bundle (a consumer's own doc) → still resolves normally.
check('read target outside bundle → resolves (consumer own doc)', () => {
  const u = updatedOutput(run({ tool_name: 'Read', cwd: CWD, tool_input: { file_path: CWD + '/own-doc.md' }, tool_response: { file: { content: 'see ${TPM_HOME}/x' } } }).out);
  assert.strictEqual(u.file.content, `see ${HOME}/x`);
});

// 5. READ-FAMILY ONLY (rule 3): a Write result is never rewritten.
check('Write tool result → no output', () => {
  const out = run({ tool_name: 'Write', cwd: CWD, tool_response: { content: 'wrote ${TPM_HOME}/x' } }).out;
  assert.strictEqual(updatedOutput(out), null);
});

// 6. Grep result carrying the token (different shape) → resolved.
check('Grep result token → resolved', () => {
  const u = updatedOutput(run({ tool_name: 'Grep', cwd: CWD, tool_response: 'match: ${TPM_HOME}/tools/x.js' }).out);
  assert.strictEqual(u, `match: ${HOME}/tools/x.js`);
});

// 7. No token in content → no output (no needless rewrite).
check('content without token → no output', () => {
  const out = run({ tool_name: 'Read', cwd: CWD, tool_response: { file: { content: 'nothing to see' } } }).out;
  assert.strictEqual(updatedOutput(out), null);
});

// 8. FAIL-OPEN: unparseable stdin → exit 0, emit nothing (rule 4).
check('malformed stdin → exit 0, no output', () => {
  const r = run('this is not json');
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.out.trim(), '');
});

// 9. Empty stdin → exit 0, emit nothing.
check('empty stdin → exit 0, no output', () => {
  const r = run('');
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.out.trim(), '');
});

// 10. SELF-LOCATION: with no override, resolves to the REAL bundle root derived from __dirname (up 3).
check('no override → self-locates bundle root from __dirname', () => {
  const u = updatedOutput(run({ tool_name: 'Read', cwd: CWD, tool_response: { file: { content: 'ref ${TPM_HOME}/overview.md' } } }, { override: undefined }).out);
  assert(u, 'expected updatedToolOutput via self-location');
  assert.strictEqual(u.file.content, `ref ${SELF_ROOT}/overview.md`);
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
