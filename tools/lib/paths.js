'use strict';
/**
 * paths.js — the SHARED project-root resolver for the base lib (#1058).
 *
 * ── WHY THIS IS SHARED (was NOT, before #1058) ──
 * Historically every entry tool carried its OWN byte-identical copy of `findRoot`
 * (the portability rule in tool-conventions.md §"Resolving project-internal paths":
 * `tpm-session-paths.js`, `tpm-task-paths.js`, … all the same code). Once the base lib
 * became a single shared copy reused by BOTH the session and task kinds (reference-in-place,
 * OQ5), the root resolver moved with it: ONE `findRoot` under `lib/`, imported through
 * `base.paths.findRoot`, so the two kinds cannot drift. Lifted byte-for-byte from the current
 * `tpm-task-paths.js` — logic unchanged; only its home changed.
 *
 * ── ADDITIVE ── session-tooling had no paths module (grep-verified), so adding this cannot
 * regress the 24-suite session gate; nothing pre-existing is overwritten.
 *
 * EXPORTS
 *   findRoot({ startDir, marker }) -> absolute path to the project root. Walks upward from
 *     `startDir` looking for `marker` (default `.claude/claude-tpm` — the claude-tpm install
 *     footprint directory); falls back to the resolved `startDir` (with a stderr warning) if the marker is not found
 *     anywhere up the tree. Honors $TPM_PROJECT_ROOT when no startDir is given (D8 precedence below). `marker` may be a nested relative path (checked via path.join).
 *
 * MARKER — the project root is the nearest ancestor that CONTAINS a `.claude/claude-tpm/`
 *   directory (the install footprint every `tpm install`-ed project has, created by the
 *   installer's ensureConsumerConfig). This REPLACED the earlier `CLAUDE.md` marker so a
 *   consumer with the install footprint but no CLAUDE.md is still recognised as a project.
 *
 * EXAMPLE
 *   const { findRoot } = require('./lib/paths');            // from an entry tool
 *   const { paths } = require('../lib/base');               // via task-tooling's base.js indirection
 *   const root = findRoot({ startDir: __dirname, marker: '.claude/claude-tpm' });
 *
 * Zero third-party deps; Node built-ins only; loadable/inspectable via `node <file>`.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_MARKER = path.join('.claude', 'claude-tpm');

/**
 * Resolution precedence (design D8):
 *   1. explicit `startDir` argument  — walk up from it (an explicit argument ALWAYS wins);
 *   2. `$TPM_PROJECT_ROOT`           — only when no `startDir` is given AND `marker` is the default
 *                                      `.claude/claude-tpm` (a custom marker means "find THAT thing",
 *                                      which the project-root env var cannot answer). Must be an existing
 *                                      directory; a bad value → one stderr warning, then falls through;
 *   3. walk up from process.cwd().
 * A walk-up miss returns the start folder (back-compat) but writes ONE stderr warning naming the folder
 * used. Options: `strict: true` → throw (code 'ETPM_NO_PROJECT_ROOT') instead; `quiet: true` → no warning.
 * Callers must NOT pass `process.cwd()` as `startDir` — omit it so the env can win.
 */
// Each distinct warning prints at most ONCE per process (a CLI call often resolves the root twice).
const _warned = new Set();
function warnOnce(text) {
  if (_warned.has(text)) return;
  _warned.add(text);
  process.stderr.write(text);
}

function findRoot({ startDir, marker = DEFAULT_MARKER, strict = false, quiet = false } = {}) {
  if (!startDir && marker === DEFAULT_MARKER) {
    const envRoot = process.env.TPM_PROJECT_ROOT;
    if (envRoot) {
      let ok = false;
      try { ok = fs.statSync(envRoot).isDirectory(); } catch (_e) { ok = false; }
      if (ok) return path.resolve(envRoot);
      if (!quiet) {
        warnOnce(`tpm: warning: TPM_PROJECT_ROOT=${envRoot} is not an existing directory; ` +
          'ignoring it and walking up from the current folder instead.\n');
      }
    }
  }
  const start = path.resolve(startDir || process.cwd());
  let dir = start;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (fs.existsSync(path.join(dir, marker))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      const msg = `no ${marker.split(path.sep).join('/')}/ found at or above ${start}`;
      if (strict) {
        const err = new Error(`tpm: ${msg} (and TPM_PROJECT_ROOT is not set)`);
        err.code = 'ETPM_NO_PROJECT_ROOT';
        throw err;
      }
      if (!quiet) warnOnce(`tpm: warning: ${msg}; using ${start} as the project root.\n`);
      return start; // marker not found anywhere up the tree
    }
    dir = parent;
  }
}

module.exports = { findRoot };
