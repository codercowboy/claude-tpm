#!/usr/bin/env node
'use strict';
/**
 * tpm-hygiene-config.test.js — HARDENING tests for the #1152 E′ hygiene resolver
 * (tools/config/tpm-hygiene-config.js) and the SessionStart hook's gate function
 * (tools/hooks/tpm-hooks-session-start.js healthCheckEnabled) — the two pieces that decide whether the
 * light health note fires. EXTENDS (does NOT repeat) the subprocess coverage in
 * tools/hooks/tests/tpm-hooks-session-start.test.js: that file drives the whole hook; this one pins the
 * resolver + gate units directly, where the default-ON and FAIL-OPEN invariants live.
 *
 * Pinned seams (each goes RED if the behaviour regresses — see HANDOFF mutation probes):
 *   - getDefaults() === loadDefaults().hygiene === { enabled:true, healthCheck:{enabled:true} }, comment-stripped.
 *   - resolveHygieneConfig: default-ON with no config; project override honoured; USER layer wins; section-narrowed.
 *   - tolerance: invalid PROJECT config throws EBADJSON (strict); invalid USER config warns+skips (default-ON stands).
 *   - healthCheckEnabled: default ON; only an explicit healthCheck.enabled === false turns it OFF;
 *     FAIL-OPEN — an invalid project config (which makes resolveHygieneConfig THROW) is swallowed -> ON.
 *
 * MUST be registered in tools/tests/run-all.js TARGETS (config/tests is NOT a globbed group) — see
 * tpm-runner-registration.test.js.
 *
 * Run: node tools/config/tests/tpm-hygiene-config.test.js   (exit 0 = all green)
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hygiene = require('../tpm-hygiene-config');
const overlay = require('../../lib/tpm-config-overlay');
const hook = require('../../hooks/tpm-hooks-session-start');

// Hermetic: the hook's gate reads process.env.CLAUDE_TPM_USER_CONFIG when no env override is passed.
// A leaked value from the invoking shell would taint resolveHygieneConfig(projectDir) — strip it.
const SAVED_USER_CONFIG = process.env.CLAUDE_TPM_USER_CONFIG;
delete process.env.CLAUDE_TPM_USER_CONFIG;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-hygiene-'));
let n = 0;
function freshRoot(configObjOrStr) {
  const d = path.join(TMP, 'proj' + (n++));
  fs.mkdirSync(path.join(d, '.claude', 'claude-tpm'), { recursive: true });
  if (configObjOrStr !== undefined) {
    fs.writeFileSync(
      path.join(d, '.claude', 'claude-tpm', 'config.json'),
      typeof configObjOrStr === 'string' ? configObjOrStr : JSON.stringify(configObjOrStr, null, 2),
    );
  }
  return d;
}
function userFile(obj) {
  const f = path.join(TMP, 'user' + (n++) + '.json');
  fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return f;
}

let count = 0;
function check(name, fn) { fn(); count += 1; process.stdout.write(`  ✓ ${name}\n`); }
process.stdout.write('tpm-hygiene-config.test.js\n');

// ── getDefaults ─────────────────────────────────────────────────────────────────────────────────

check('getDefaults() is the shipped hygiene section, default-ON, comment-stripped', () => {
  const d = hygiene.getDefaults();
  assert.deepStrictEqual(d, { enabled: true, healthCheck: { enabled: true } });
  assert.deepStrictEqual(d, overlay.loadDefaults().hygiene, 'byte-identical to loadDefaults().hygiene');
  assert.ok(!/_comment|\$comment/.test(JSON.stringify(d)), 'no comment keys survive');
});

// ── resolveHygieneConfig: layering ──────────────────────────────────────────────────────────────

check('resolveHygieneConfig: no project config -> default ON (enabled + healthCheck.enabled true)', () => {
  const r = hygiene.resolveHygieneConfig(freshRoot(), { env: {} });
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(r.healthCheck.enabled, true);
});

check('resolveHygieneConfig: project healthCheck.enabled=false is honoured', () => {
  const r = hygiene.resolveHygieneConfig(freshRoot({ hygiene: { healthCheck: { enabled: false } } }), { env: {} });
  assert.strictEqual(r.healthCheck.enabled, false);
});

check('resolveHygieneConfig: the USER layer wins over the project layer', () => {
  const root = freshRoot({ hygiene: { healthCheck: { enabled: false } } });
  const uf = userFile({ hygiene: { healthCheck: { enabled: true } } });
  const r = hygiene.resolveHygieneConfig(root, { env: { CLAUDE_TPM_USER_CONFIG: uf } });
  assert.strictEqual(r.healthCheck.enabled, true, 'user re-enables what the project turned off');
});

check('resolveHygieneConfig returns ONLY the hygiene section (section-narrowed), not the whole config', () => {
  const r = hygiene.resolveHygieneConfig(freshRoot({ tasks: { maxOpenWarn: 7 }, hygiene: {} }), { env: {} });
  assert.ok(!('tasks' in r), 'no sibling sections leak in');
  assert.strictEqual(r.healthCheck.enabled, true, 'hygiene defaults still fill in');
});

// ── resolveHygieneConfig: tolerance ───────────────────────────────────────────────────────────────

check('resolveHygieneConfig: an invalid PROJECT config throws EBADJSON (strict project layer)', () => {
  let code = null;
  try { hygiene.resolveHygieneConfig(freshRoot('{ not: valid'), { env: {} }); } catch (e) { code = e.code; }
  assert.strictEqual(code, 'EBADJSON', 'project-layer parse failure must surface (the hook relies on catching it)');
});

check('resolveHygieneConfig: an invalid USER config warns+skips; default-ON stands', () => {
  const warnings = [];
  const r = hygiene.resolveHygieneConfig(freshRoot(), {
    env: { CLAUDE_TPM_USER_CONFIG: userFile('{ broken') },
    warn: (m) => warnings.push(m),
  });
  assert.strictEqual(r.healthCheck.enabled, true, 'bad user layer ignored -> default ON');
  assert.strictEqual(warnings.length, 1);
});

// ── the hook's gate: default-ON + FAIL-OPEN ─────────────────────────────────────────────────────────

check('healthCheckEnabled: no config -> ON (default)', () => {
  assert.strictEqual(hook.healthCheckEnabled(freshRoot()), true);
});

check('healthCheckEnabled: only an explicit healthCheck.enabled === false turns it OFF', () => {
  assert.strictEqual(hook.healthCheckEnabled(freshRoot({ hygiene: { healthCheck: { enabled: false } } })), false);
  assert.strictEqual(hook.healthCheckEnabled(freshRoot({ hygiene: { healthCheck: { enabled: true } } })), true);
  assert.strictEqual(hook.healthCheckEnabled(freshRoot({ hygiene: { enabled: true } } /* no healthCheck */)), true,
    'sibling hygiene.enabled does not gate the health note');
  assert.strictEqual(hook.healthCheckEnabled(freshRoot({ tasks: {} } /* no hygiene at all */)), true,
    'absent gate -> default ON');
});

check('healthCheckEnabled: FAIL-OPEN — an invalid project config (resolver THROWS) is swallowed -> ON', () => {
  // sanity: the resolver really does throw on this input, so the test proves the catch, not a silent path
  let threw = false;
  try { hygiene.resolveHygieneConfig(freshRoot('{ broken json'), { env: {} }); } catch (_e) { threw = true; }
  assert.ok(threw, 'precondition: resolver throws on invalid project JSON');
  const badRoot = freshRoot('{ broken json');
  assert.strictEqual(hook.healthCheckEnabled(badRoot), true, 'a broken config must never silence the health note');
});

// restore the invoking shell's user-config, if any
if (SAVED_USER_CONFIG === undefined) delete process.env.CLAUDE_TPM_USER_CONFIG;
else process.env.CLAUDE_TPM_USER_CONFIG = SAVED_USER_CONFIG;

process.stdout.write(`\nPASS — ${count} checks\n`);
