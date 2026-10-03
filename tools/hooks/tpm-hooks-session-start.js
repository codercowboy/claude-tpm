#!/usr/bin/env node
/**
 * tpm-hooks-session-start.js — the plugin's SessionStart HOOK: publishes the consumer project root
 * (and the plugin home) to every later Bash call in the session.
 *
 * WHY
 *   Bash tool calls inside a Claude Code session do NOT get CLAUDE_PROJECT_DIR, so tpm tools would
 *   guess the project from the current folder — which drifts whenever Claude `cd`s. A plugin
 *   SessionStart hook DOES receive CLAUDE_PROJECT_DIR + CLAUDE_PLUGIN_ROOT, plus CLAUDE_ENV_FILE: a
 *   shell file whose `export` lines Claude Code applies to every later Bash call in the session
 *   (subagents included). This hook appends the exports there.
 *
 * WHAT IT WRITES (to $CLAUDE_ENV_FILE, one `export NAME='<value>'` line each)
 *   TPM_PROJECT_ROOT = $CLAUDE_PROJECT_DIR            (skipped if already set in the hook's env —
 *                                                      e.g. a settings `env` override wins)
 *   TPM_HOME         = realpath($CLAUDE_PLUGIN_ROOT)  (informational; skipped if already set)
 *   NOT PATH — Claude Code already puts the plugin's bin/ on PATH.
 *
 * THE LIGHT HEALTH CHECK (installer-updates phase 03; design §9.1/§9.2, voice §7)
 *   After the exports, the hook runs the LIGHT doctor: `observe(project, null, env, {probes:false})` — file-only, NO `claude`
 *   spawn — and `V.hookMessage(state)` (tpm-consumer-voice.js). Healthy => NOTHING is printed (zero tokens on a normal
 *   start). Unhealthy => at most 3 problems as ONE `[claude-tpm]` line addressed to Claude (stdout of a SessionStart hook
 *   becomes context), which tells Claude to report them and NOT to repair anything. Fires on every `source` (startup /
 *   resume / clear / compact). Gate (D-2): `hygiene.healthCheck.enabled` in .claude/claude-tpm/config.json, default ON;
 *   `false` => silent. A folder with no package.json is not a project the installer manages => silent. There is no full doctor in a hook (D-1) and no `autoRunFullDoctor` key.
 *
 * CONTRACT
 *   - FAIL-OPEN: any problem -> exit 0. stdout stays EMPTY except for the one health line above (stdout of a SessionStart
 *     hook may become model context). Each part (env exports, health check) is isolated: a throw in one never costs the
 *     other. A missing CLAUDE_ENV_FILE is a no-op; a missing CLAUDE_PROJECT_DIR / CLAUDE_PLUGIN_ROOT skips only that line.
 *   - Values are single-quoted (embedded ' escaped as '\''), so spaces, $, backticks round-trip
 *     through `source`.
 *   - IDEMPOTENT: the hook fires on startup/compact/clear/resume and appends to the same file; a line
 *     already present verbatim is not written again. A different value is appended (last wins).
 *
 * WIRED BY hooks/hooks.json:  node "${CLAUDE_PLUGIN_ROOT}/tools/tpm.js" hooks session-start
 * (Reached through the hooks router, which forwards stdin/stdout/exit code.)
 */

'use strict';

const fs = require('fs');
const path = require('path');

function shQuote(v) {
  return "'" + String(v).replace(/'/g, "'\\''") + "'";
}

function nonEmpty(v) {
  return typeof v === 'string' && v !== '';
}

function computeLines(env) {
  const lines = [];
  if (!nonEmpty(env.TPM_PROJECT_ROOT) && nonEmpty(env.CLAUDE_PROJECT_DIR)) {
    lines.push(`export TPM_PROJECT_ROOT=${shQuote(env.CLAUDE_PROJECT_DIR)}`);
  }
  if (!nonEmpty(env.TPM_HOME) && nonEmpty(env.CLAUDE_PLUGIN_ROOT)) {
    let home = null;
    try { home = fs.realpathSync(env.CLAUDE_PLUGIN_ROOT); } catch (_e) { home = null; }
    if (home) lines.push(`export TPM_HOME=${shQuote(home)}`);
  }
  return lines;
}

function run(env) {
  const file = env.CLAUDE_ENV_FILE;
  if (!nonEmpty(file)) return;
  const lines = computeLines(env);
  if (!lines.length) return;
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch (_e) { existing = ''; }
  const have = new Set(existing.split('\n'));
  const missing = lines.filter((l) => !have.has(l));
  if (!missing.length) return;
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, prefix + missing.join('\n') + '\n');
}

// ── the light health check ────────────────────────────────────────────────────────────────────────────────

/** `hygiene.healthCheck.enabled` from the project's config.json: default ON; only an explicit `false` turns it off. */
function healthCheckEnabled(projectDir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', 'claude-tpm', 'config.json'), 'utf8'));
    const hc = cfg && cfg.hygiene && cfg.hygiene.healthCheck;
    return !(hc && hc.enabled === false);
  } catch (_e) { return true; } // absent / unparseable config => the default (on)
}

/**
 * The text the hook prints: '' when healthy, gated off, not in a project, or on ANY error (fail-open).
 * `deps` (tests) = { observe, hookMessage } overrides.
 */
function healthMessage(env, deps) {
  try {
    const projectDir = env.CLAUDE_PROJECT_DIR || env.TPM_PROJECT_ROOT;
    if (!nonEmpty(projectDir)) return '';
    if (!healthCheckEnabled(projectDir)) return '';
    const d = deps || {};
    const observe = d.observe || require('../consumer/tpm-consumer-observe').observe;
    const hookMessage = d.hookMessage || require('../consumer/tpm-consumer-voice').hookMessage;
    const state = observe(projectDir, null, env, { probes: false });
    // not a project `tpm install` could fix (no folder / no package.json: the installer refuses those) => nothing actionable to say
    if (!state || !state.target || !state.target.exists || !state.target.pkg || !state.target.pkg.exists) return '';
    return String(hookMessage(state) || '');
  } catch (_e) { return ''; }
}

function main() {
  try { fs.readFileSync(0); } catch (_e) { /* drain stdin; ignore */ }
  try { run(process.env); } catch (_e) { /* fail-open */ }
  try {
    const msg = healthMessage(process.env);
    if (msg) process.stdout.write(msg + '\n');
  } catch (_e) { /* fail-open */ }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { shQuote, computeLines, run, healthMessage, healthCheckEnabled };
