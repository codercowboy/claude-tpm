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
 * CONTRACT
 *   - FAIL-OPEN + SILENT: any problem -> exit 0, NOTHING on stdout (stdout of a SessionStart hook may
 *     become model context). A missing CLAUDE_ENV_FILE is a no-op; a missing CLAUDE_PROJECT_DIR /
 *     CLAUDE_PLUGIN_ROOT skips only that line.
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

function main() {
  try { fs.readFileSync(0); } catch (_e) { /* drain stdin; ignore */ }
  try { run(process.env); } catch (_e) { /* fail-open */ }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { shQuote, computeLines, run };
