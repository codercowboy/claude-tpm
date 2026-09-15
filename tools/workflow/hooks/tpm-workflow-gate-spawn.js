#!/usr/bin/env node
/**
 * tpm-workflow-gate-spawn.js — a Claude Code PreToolUse HOOK that blocks a tpm-workflow subagent
 * spawn unless the user has FRESHLY confirmed the kickoff.
 *
 * THIS IS NOT A SKILL / NOT A PROMPT. It is a real program the HARNESS runs (deterministic,
 * no LLM in the loop) BEFORE the `Agent` (subagent-spawn) tool executes. The harness pipes
 * the pending tool call to us as JSON on stdin; our EXIT CODE decides the tool's fate:
 *   • exit 0  → allow the spawn (say nothing).
 *   • exit 2  → BLOCK the spawn; whatever we print to stderr becomes the reason the model sees.
 * (Exit-2-blocks is the documented PreToolUse contract. We deliberately print NOTHING to
 *  stdout so there's no decision-JSON to schema-validate — just exit code + stderr.)
 *
 * WHAT IT GATES (scoped — it does NOT block every Agent call):
 *   Only a tpm-workflow ROUND spawn — recognized by an EXPLICIT MARKER that compose-spawn-prompt
 *   stamps into every real round spawn: `<!-- tpm-workflow-spawn phase="<phase-dir>" role="<role>" -->`.
 *   Ordinary agents (research/explore/guide/etc.) carry no marker and pass through untouched. (A
 *   positive marker replaced an earlier content-guess that false-positived on any prompt merely
 *   mentioning a charter/work path — verifier concern #2.)
 *
 * THE GATE:
 *   A marked spawn is allowed ONLY if tpm-workflow-signoff.js reports a FRESH "spawn" sign-off token (Token 2 —
 *   "the user was asked to kick it off and explicitly confirmed") that is ALSO bound to THIS round
 *   (the token's `round` == the marker's `phase`) and THIS session. No fresh/matching token ⇒ exit 2
 *   with an actionable reason. Freshness matters because a rambly turn, or yesterday's "go", must not
 *   authorize today's spawn; round-binding stops one round's "go" from waving through another.
 *
 * FAIL-OPEN: any internal error ⇒ exit 0 (allow). A bug in this hook must NEVER brick the
 * session's ability to spawn. It gates the trusted orchestrator against ACCIDENTAL/rationalized
 * kickoffs, not an adversary — so "occasionally miss a gate" beats "lock up the session".
 *
 * REGISTER (settings.json):
 *   { "hooks": { "PreToolUse": [ { "matcher": "Agent",
 *       "hooks": [ { "type": "command", "command": "node <abs>/tools/workflow/hooks/tpm-workflow-gate-spawn.js" } ] } ] } }
 *   (Bundled in a plugin, the command uses ${CLAUDE_PLUGIN_ROOT}.)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ALLOW = 0;
const BLOCK = 2;

function main() {
  // 1) Read the whole hook payload from stdin (fd 0). Fail-open if we can't.
  let payload = {};
  try {
    const raw = fs.readFileSync(0, 'utf8');
    payload = raw ? JSON.parse(raw) : {};
  } catch (_e) {
    process.exit(ALLOW); // can't parse → don't gate
  }

  // 2) Only the subagent-spawn tool is our business. (The matcher already filters to Agent;
  //    this is belt-and-suspenders in case the hook is wired more broadly.)
  const tool = payload.tool_name || payload.toolName || '';
  if (tool && tool !== 'Agent' && tool !== 'Task') process.exit(ALLOW);

  // 3) Is THIS spawn a tpm-workflow round spawn? Detect the EXPLICIT marker that compose-spawn-prompt
  //    stamps into every real round spawn: `<!-- tpm-workflow-spawn phase="<phase-dir>" role="<role>" -->`.
  //    A positive, unambiguous signal — NOT a content guess. An ordinary research/read agent carries no
  //    marker → not gated (this is what kills the old content-sniff false-positive: a plain agent that
  //    merely MENTIONS a charter/work path is no longer mistaken for a round).
  const toolInput = payload.tool_input || payload.toolInput || {};
  // Read the RAW prompt string when present — JSON.stringify would escape the marker's quotes
  // (`phase=\"…\"`), breaking the phase-extraction regex. Fall back to a stringified blob only if
  // there is no string prompt field.
  const blob = typeof toolInput === 'string' ? toolInput
    : (typeof (toolInput && toolInput.prompt) === 'string' ? toolInput.prompt : JSON.stringify(toolInput));
  const marker = /<!--\s*tpm-workflow-spawn\b([^>]*?)-->/i.exec(blob);
  if (!marker) process.exit(ALLOW); // no marker → ordinary agent → not gated
  // The marker declares the round (phase-folder path) → bind the token to THIS round (verifier #1):
  const phaseM = /phase\s*=\s*"([^"]*)"/i.exec(marker[1] || '');
  const round = phaseM ? phaseM[1] : null;

  // 4) It IS a workflow spawn → require a FRESH "spawn" sign-off token.
  let signoff;
  try {
    signoff = require(path.join(__dirname, '..', 'tpm-workflow-signoff.js'));
  } catch (_e) {
    process.exit(ALLOW); // helper unavailable → fail-open
  }
  const root = payload.cwd || undefined; // hooks run at project root; let signoff resolve otherwise
  let res;
  try {
    // Bind to the session too (#1): a token stamped in a DIFFERENT Claude session won't authorize this
    // spawn. (When the token carries no sessionId — env var absent at write time — this is a soft no-op;
    // the marker approach, if adopted, carries the round identity explicitly. See gate design notes.)
    res = signoff.isFresh('spawn', { root, round, sessionId: payload.session_id || payload.sessionId });
  } catch (_e) {
    process.exit(ALLOW); // check threw → fail-open
  }

  if (res.ok) process.exit(ALLOW); // fresh confirmation on file → allow the spawn

  // 5) No fresh spawn confirmation → BLOCK with an actionable reason (stderr).
  process.stderr.write(
    '⛔ tpm-workflow spawn BLOCKED — no FRESH user "kick it off" confirmation on file '
    + `(${res.reason}).\n`
    + 'This is Gate B (the spawn gate), separate from answering the pre-task questions (Gate A). '
    + 'A rambly or discussion turn is NOT a kickoff. To proceed: (1) ensure the pre-task roster was '
    + 'presented and answered, (2) ask the user an explicit "kick it off now?" and get an explicit '
    + 'yes, (3) record it: `npx tpm workflow signoff spawn --roster "<one-line>"`, then re-spawn. '
    + '(Never write that token from your own inference of the user\'s intent — only from an explicit confirmation.)\n',
  );
  process.exit(BLOCK);
}

try {
  main();
} catch (_e) {
  // absolute backstop: never brick spawning on an unexpected error
  process.exit(ALLOW);
}
