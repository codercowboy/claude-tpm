#!/usr/bin/env node
'use strict';
/**
 * tpm-hooks-expand-tpm-home-content-noop.js — BACK-COMPAT NO-OP shim.
 *
 * 0.2.0 removed the PostToolUse "%TPM_HOME% content-expansion" hook: placeholder resolution moved
 * into `tpm doc` / `tpm-home` (docs are expanded when SERVED), so the read-time content rewrite is
 * dead. But a MIXED install still trips on it — a 0.1.0 plugin `hooks.json` (which wires
 * `npx tpm hooks expand-tpm-home-content` on Read|Grep|Glob) answered by a 0.2.0 `npx tpm` errors
 * `unknown verb 'expand-tpm-home-content'` on EVERY read. That mix is the bare-name marketplace
 * contamination (#27.1 / #27.2), the exact cross-version collision the scoped marketplace prevents
 * going forward.
 *
 * This shim silences the noise until that cleanup lands: it drains stdin and exits 0, emitting no
 * `hookSpecificOutput.updatedToolOutput`, so the harness leaves the tool result UNCHANGED. It never
 * rewrites content — it is a compatibility stub, not a re-implementation.
 *
 * TEMPORARY. Remove (and the VERBS entry that points here) once no live 0.1.0 `hooks.json` can reach
 * a 0.2.0 CLI — i.e. after the #27.1/#27.2 box remediation.
 */

// Drain stdin so the harness's write never blocks/EPIPEs, then exit clean. No output = no change.
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
