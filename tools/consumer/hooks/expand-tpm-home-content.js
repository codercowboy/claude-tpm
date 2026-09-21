#!/usr/bin/env node
/**
 * expand-tpm-home-content.js — PostToolUse hook that resolves the vendored-bundle placeholder
 * `${TPM_HOME}` / `%TPM_HOME%` to its real absolute path in the CONTENT a read-family tool RETURNS
 * (the bytes the model sees), NOT in the read path. It is the bypass-safe successor to the PreToolUse
 * path-rewrite hook `expand-tpm-home.js`.
 *
 * WHY THIS EXISTS (and why PostToolUse, not PreToolUse):
 *   The PreToolUse `expand-tpm-home` hook rewrites the tool INPUT (the read path) via
 *   `hookSpecificOutput.updatedInput`, which the harness honors ONLY alongside
 *   `permissionDecision:"allow"`. That allow-channel is SKIPPED under `--dangerously-skip-permissions`,
 *   so the path rewrite silently no-ops under bypass (proven, session 019). Worse, it only ever
 *   touched the read PATH — a `${TPM_HOME}` token sitting in a file's CONTENT (e.g. a consumer's own
 *   doc that says "see ${TPM_HOME}/readme.md") was NEVER resolved, in ANY permission mode (proven
 *   empirically: dev A/B run 2026-09-17, `no-token-in-location-fields` in bypass AND auto).
 *
 *   A PostToolUse hook returning `hookSpecificOutput.updatedToolOutput` rewrites the tool RESULT
 *   after the read has already succeeded. Empirically this IS honored under bypass (session 019 proof:
 *   tmp/session-tests/run-20260916-210823/, output-doc.md came out fully resolved with the subagent
 *   knowing nothing about the token). So this hook resolves the token in returned content in every
 *   permission mode. It is a READ-TIME FILTER on what the model sees — it does NOT modify any file on
 *   disk, so the literal token is preserved for portability across deployments (different consumers
 *   vendor the bundle at different paths, and consumers may reference ${TPM_HOME} in their OWN docs).
 *
 * BUNDLE GUARD (critical):
 *   This hook must NOT rewrite the content of a file that lives INSIDE the bundle. It exists to resolve
 *   the token in a CONSUMER's own docs (files OUTSIDE the bundle that reference it); an in-bundle read is
 *   either a skill doc-read (which goes through `tpm doc`, self-resolving) or bundle maintenance (which
 *   needs the on-disk LITERAL `${TPM_HOME}` so an Edit's `old_string` matches). So we guard on the READ
 *   TARGET: if the file being read resolves under BUNDLE_ROOT, emit nothing. This covers BOTH the source
 *   repo (cwd===bundle) AND editing the bundle from a sibling workspace (e.g. claude-tpm-dev → ../claude-tpm,
 *   where cwd≠bundle — the case a cwd-only guard missed). A consumer reading its OWN doc (outside the
 *   bundle) still resolves normally.
 *
 * FAIL-OPEN: any error, non-read tool, absent token, unparseable payload, or the source-repo guard ⇒
 *   emit nothing and exit 0, so the tool result passes through UNCHANGED. A content filter must never
 *   block or corrupt a call.
 *
 * CONTRACT:
 *   stdin  : PostToolUse payload JSON — { tool_name, tool_input:{…}, tool_response:<any>, cwd, … }
 *   stdout : {"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":<rewritten>}}
 *            (emitted only when a token was actually replaced)
 *   exit   : always 0 (fail-open; this hook never denies)
 *
 * BUNDLE ROOT IS SELF-LOCATED: this file lives at <bundle>/tools/consumer/hooks/expand-tpm-home-content.js,
 *   so up-3 dirs = the bundle root — correct whether the bundle is claude-tpm itself or a vendored
 *   node_modules/@codercowboy/claude-tpm/. Zero env, zero interpolation. (TPM_HOME_OVERRIDE exists only
 *   so a unit test can pin a synthetic root.)
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Self-locate the bundle: this file is <bundle>/tools/consumer/hooks/expand-tpm-home-content.js → up 3.
let BUNDLE_ROOT = process.env.TPM_HOME_OVERRIDE || path.resolve(__dirname, '..', '..', '..');
try { BUNDLE_ROOT = fs.realpathSync(BUNDLE_ROOT); } catch (_e) { /* leave normalized path if realpath fails */ }

// Both spellings: `${TPM_HOME}` is today's on-disk token; `%TPM_HOME%` is the shell-safe respelling
// (#1098). Single-quoted → literal; no JS interpolation. Order does not matter (disjoint strings).
const TOKENS = ['${TPM_HOME}', '%TPM_HOME%'];
// Content-bearing read tools. Glob/NotebookRead rarely carry the token but are harmless (no-op if
// absent); this set keeps the hook self-consistent regardless of the hooks.json matcher breadth.
const READ_FAMILY = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);

// Diagnostic breadcrumb (opt-in): set TPM_HOME_DEBUG=<file> to append one JSON line per invocation.
function debug(obj) {
  const dst = process.env.TPM_HOME_DEBUG;
  if (!dst) return;
  try { fs.appendFileSync(dst, JSON.stringify(obj) + '\n'); } catch (_e) { /* logging must never break the hook */ }
}

function emitNothingAndExit(reason) {
  debug({ reason });
  process.exit(0); // fail-open / no-op: tool result passes through unchanged
}

function realpathOrSelf(p) {
  try { return fs.realpathSync(p); } catch (_e) { return path.resolve(p); }
}

// The primary path a read-family tool acted on (absolutized against cwd), or null. Used to detect an
// in-bundle read — Read/NotebookRead name a file; Grep/Glob a search path (absent ⇒ cwd, handled by caller).
function readTargetPath(input, cwd) {
  if (!input || typeof input !== 'object') return null;
  const raw = input.file_path || input.notebook_path || input.path;
  if (typeof raw !== 'string' || !raw) return null;
  return path.isAbsolute(raw) ? raw : (cwd ? path.resolve(cwd, raw) : path.resolve(raw));
}

function isUnderBundle(p, root) {
  const r = realpathOrSelf(p); // resolve a vendored symlink so the target compares against the true root
  return r === root || r.startsWith(root + path.sep);
}

function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_e) { return emitNothingAndExit('stdin-read-failed'); }
  if (!BUNDLE_ROOT) return emitNothingAndExit('no-bundle-root');
  if (!raw.trim()) return emitNothingAndExit('empty-stdin');

  let payload;
  try { payload = JSON.parse(raw); } catch (_e) { return emitNothingAndExit('unparseable-stdin'); }

  // READ-FAMILY ONLY — never touch a Write/Edit/Bash result.
  if (!READ_FAMILY.has(payload && payload.tool_name)) return emitNothingAndExit('not-read-family');

  // BUNDLE GUARD: never rewrite content of a file that lives INSIDE the bundle. This hook exists to
  // resolve the token in a CONSUMER's own docs (files OUTSIDE the bundle that reference it); an in-bundle
  // read is either a skill doc-read (which goes through `tpm doc`, self-resolving) or bundle maintenance
  // (which needs the on-disk LITERAL so an Edit's old_string matches). Guarding on the read TARGET covers
  // BOTH the source repo (cwd===bundle) AND editing the bundle from a sibling workspace (cwd≠bundle).
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : '';
  const target = readTargetPath(payload.tool_input, cwd);
  if (target && isUnderBundle(target, BUNDLE_ROOT)) return emitNothingAndExit('read-target-inside-bundle');
  if (cwd && realpathOrSelf(cwd) === BUNDLE_ROOT) return emitNothingAndExit('in-bundle-source-repo');

  // The tool result lives under one of these keys depending on tool/harness version.
  const tr = payload.tool_response !== undefined ? payload.tool_response
           : payload.tool_output !== undefined ? payload.tool_output
           : undefined;
  if (tr === undefined) return emitNothingAndExit('no-tool-response');

  // Rewrite the token wherever it appears, preserving the original result SHAPE: stringify → replace
  // each token with the bundle root → reparse. split/join avoids regex-escaping the `$ { } %` chars.
  let s = JSON.stringify(tr);
  let hit = false;
  for (const tok of TOKENS) {
    if (s.indexOf(tok) === -1) continue;
    s = s.split(tok).join(BUNDLE_ROOT);
    hit = true;
  }
  if (!hit) return emitNothingAndExit('no-token-in-content');

  let updated;
  try { updated = JSON.parse(s); } catch (_e) { return emitNothingAndExit('reparse-failed'); }

  const out = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: updated,
    },
  };
  debug({ tool: payload.tool_name, bundle: BUNDLE_ROOT, emitted: true });
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

try { main(); } catch (_e) { process.exit(0); }
