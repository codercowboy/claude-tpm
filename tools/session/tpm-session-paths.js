/**
 * tpm-session-paths.js — suite-local root resolution for tools/session/*.
 *
 * PURPOSE
 *   Resolve the project root from anywhere inside it, without hardcoding an absolute path
 *   and without __dirname-relative "../../.." gymnastics (both rot the moment this suite
 *   moves). Per claude-context/methodology/tool-conventions.md §"Resolving project-internal
 *   paths" — every suite that needs root resolution keeps its OWN small copy of this helper;
 *   there is no shared cross-suite paths module (portability rule).
 *
 * EXPORTS
 *   findRoot({ startDir, marker }) -> absolute path to the project root (walks upward from
 *     startDir looking for `marker`, default `.claude/claude-tpm` — the claude-tpm install
 *     footprint directory; falls back to startDir if no marker is found anywhere up the tree).
 *     `marker` may be a nested relative path (checked via path.join).
 *
 * MARKER — the project root is the nearest ancestor CONTAINING a `.claude/claude-tpm/` directory
 *   (the install footprint every `tpm install`-ed project has). This REPLACED the earlier
 *   `CLAUDE.md` marker so a consumer with the footprint but no CLAUDE.md is still a project.
 *
 * EXAMPLE
 *   const { findRoot } = require('./tpm-session-paths');
 *   const root = findRoot({ startDir: __dirname, marker: '.claude/claude-tpm' });
 */

'use strict';

const fs = require('fs');
const path = require('path');

function findRoot({ startDir, marker = path.join('.claude', 'claude-tpm') } = {}) {
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
