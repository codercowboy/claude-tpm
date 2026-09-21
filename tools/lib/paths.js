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
 *     `startDir` looking for `marker` (default `CLAUDE.md`); falls back to the resolved
 *     `startDir` if the marker is not found anywhere up the tree.
 *
 * EXAMPLE
 *   const { findRoot } = require('./lib/paths');            // from an entry tool
 *   const { paths } = require('../lib/base');               // via task-tooling's base.js indirection
 *   const root = findRoot({ startDir: __dirname, marker: 'CLAUDE.md' });
 *
 * Zero third-party deps; Node built-ins only; loadable/inspectable via `node <file>`.
 */

const fs = require('fs');
const path = require('path');

function findRoot({ startDir, marker = 'CLAUDE.md' } = {}) {
  let dir = path.resolve(startDir || process.cwd());
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (fs.existsSync(path.join(dir, marker))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return path.resolve(startDir || process.cwd()); // marker not found anywhere up the tree
    }
    dir = parent;
  }
}

module.exports = { findRoot };
