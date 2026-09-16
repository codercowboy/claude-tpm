#!/usr/bin/env node
/**
 * expand-tpm-home.js — PreToolUse hook that resolves the vendored-bundle placeholder `${TPM_HOME}`
 * to its real absolute path in the FILE-LOCATION field of a READ-family tool call, deterministically,
 * before the tool runs. This is how a claude-tpm consumer makes the skills' shared references
 * (`${TPM_HOME}/claude-context/methodology/…`, `${TPM_HOME}/tools/…`) resolve whether the bundle sits
 * at the project root (in claude-tpm itself) or three levels down in
 * `node_modules/@codercowboy/claude-tpm/` (in a consumer) — with ZERO model cooperation.
 *
 * WHY A HOOK (not CLAUDE.md prose): env vars are invisible to the model's reasoning, and nothing
 * auto-prefixes a bare path the model reads. A PreToolUse hook runs on every tool call regardless of
 * the model's judgment and can REWRITE tool_input. (Full option analysis + the CC-mechanism facts we
 * verified empirically: claude-context/dev/consumer-adoption-design.md.)
 *
 * ── THREE THINGS WE PROVED EMPIRICALLY (Claude Code 2.1.258; tools/consumer/tests/expand-hook/) ──
 * 1. `updatedInput` is HONORED ONLY WHEN paired with `permissionDecision:"allow"` in the SAME
 *    hookSpecificOutput. A bare `hookSpecificOutput.updatedInput` (or a top-level `updatedInput`) is
 *    emitted but IGNORED — the tool runs on its original input. So resolving the path REQUIRES
 *    auto-allowing that call. Consequences 2 + 3 fence that power in:
 * 2. READ-FAMILY ONLY. Because we must return "allow", we do it ONLY for read tools (Read/Glob/Grep/
 *    NotebookRead) — NEVER Write/Edit — so the hook can never silently auto-approve a WRITE into the
 *    vendored bundle. (It also means the literal `${TPM_HOME}` survives untouched in any file Claude
 *    authors — the self-referential requirement that lets us maintain the skill docs themselves.)
 * 3. CONTAINMENT. The resolved path must stay UNDER $TPM_HOME. A `${TPM_HOME}/../../etc/passwd` would
 *    otherwise be auto-allowed — so if resolution escapes the bundle, we DON'T allow (fail-open).
 *
 * HARNESS GOTCHA: Claude Code absolutizes a relative file_path (prepends cwd) BEFORE this hook sees
 * it, so a relative `${TPM_HOME}/x` arrives as `<cwd>/${TPM_HOME}/x`. We strip that cwd prefix before
 * substituting, else cwd + abs-home concatenate into garbage. (payload carries `cwd`.)
 *
 * FAIL-OPEN: any error, missing env, non-read tool, absent token, or a containment breach ⇒ emit
 * nothing and exit 0, so the tool proceeds UNCHANGED. A path hook must never block or corrupt a call.
 *
 * CONTRACT:
 *   stdin  : PreToolUse payload JSON — { tool_name, tool_input:{…}, session_id, cwd, … }
 *   stdout : {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow",
 *             "permissionDecisionReason":"…","updatedInput":{<changed location field>}}}
 *   exit   : always 0 (fail-open; this hook never denies)
 *
 * BUNDLE ROOT IS SELF-LOCATED, not read from env. EMPIRICAL (2026-09-01): `${CLAUDE_PROJECT_DIR}` does
 * NOT interpolate inside a settings.json `env` value (contra the docs) — so `env.TPM_HOME` can't carry
 * the abs path portably. Instead this hook derives the bundle from its OWN location: it lives at
 * `<bundle>/tools/consumer/hooks/expand-tpm-home.js`, so up-3 dirs = the bundle root — correct whether
 * the bundle is claude-tpm itself or a vendored `node_modules/@codercowboy/claude-tpm/`. Zero env,
 * zero interpolation. (A TPM_HOME_OVERRIDE env exists only so the unit test can pin a synthetic root.)
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Self-locate the bundle: this file is <bundle>/tools/consumer/hooks/expand-tpm-home.js → up 3 = bundle.
const BUNDLE_ROOT = process.env.TPM_HOME_OVERRIDE || path.resolve(__dirname, '..', '..', '..');

// Fields that name a LOCATION a tool acts on. Content/data fields (content/new_string/…) are never
// touched — but note we also gate on READ_FAMILY below, so Write/Edit are excluded wholesale anyway.
const LOCATION_FIELDS = ['file_path', 'path', 'notebook_path'];
// Only these tools get the resolve+auto-allow treatment (see proof #2). Writes/Edits are never here.
const READ_FAMILY = new Set(['Read', 'Glob', 'Grep', 'NotebookRead']);
const TOKEN = '${TPM_HOME}'; // single-quoted → literal; no JS interpolation here

// Diagnostic breadcrumb (opt-in): set TPM_HOME_DEBUG=<file> to append one JSON line per invocation.
function debug(obj) {
  const dst = process.env.TPM_HOME_DEBUG;
  if (!dst) return;
  try { fs.appendFileSync(dst, JSON.stringify(obj) + '\n'); } catch (_e) { /* logging must never break the hook */ }
}

function emitNothingAndExit(reason) {
  debug({ reason });
  process.exit(0); // fail-open / no-op: tool proceeds with its original input
}

// Is `resolved` inside `home` (no `..` escape)? Both are absolute. Guards the auto-allow (proof #3).
function isContained(resolved, home) {
  const h = path.resolve(home);
  const r = path.resolve(resolved);
  return r === h || r.startsWith(h + path.sep);
}

function main() {
  const home = BUNDLE_ROOT; // self-located; never an un-interpolated ${...} literal
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_e) { return emitNothingAndExit('stdin-read-failed'); }
  if (!home) return emitNothingAndExit('no-bundle-root');
  if (!raw.trim()) return emitNothingAndExit('empty-stdin');

  let payload;
  try { payload = JSON.parse(raw); } catch (_e) { return emitNothingAndExit('unparseable-stdin'); }

  // READ-FAMILY ONLY — never auto-allow a write/edit into the bundle (proof #2).
  if (!READ_FAMILY.has(payload && payload.tool_name)) return emitNothingAndExit('not-read-family');

  const input = payload.tool_input;
  if (!input || typeof input !== 'object') return emitNothingAndExit('no-tool_input');

  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';

  const updated = {};
  for (const field of LOCATION_FIELDS) {
    let val = input[field];
    if (typeof val !== 'string' || val.indexOf(TOKEN) === -1) continue;
    // Undo the harness's cwd-prefixing of a relative token path before substituting (harness gotcha).
    if (cwd && val.startsWith(cwd + '/')) {
      const rel = val.slice(cwd.length + 1);
      if (rel.indexOf(TOKEN) === 0) val = rel;
    }
    const resolved = val.split(TOKEN).join(home); // split/join avoids regex-escaping $ { }
    // Containment: the resolved path must stay under the bundle, or we refuse to auto-allow (proof #3).
    if (!isContained(resolved, home)) return emitNothingAndExit('escapes-bundle');
    updated[field] = resolved;
  }

  if (Object.keys(updated).length === 0) return emitNothingAndExit('no-token-in-location-fields');

  // updatedInput is honored ONLY alongside permissionDecision:"allow" (proof #1).
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'resolved ${TPM_HOME} to the claude-tpm bundle (read-only, contained)',
      updatedInput: updated,
    },
  };
  debug({ tool: payload.tool_name, in: input, home, emitted: out });
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

try { main(); } catch (_e) { process.exit(0); }
