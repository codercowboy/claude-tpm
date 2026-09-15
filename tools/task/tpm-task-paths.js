/**
 * tpm-task-paths.js — suite-local root resolution for tools/task/*.
 *
 *   (Byte-identical logic to tools/session/tpm-session-paths.js — copied per the portability rule
 *   in tool-conventions.md Part I §2: each suite carries its OWN copy, no shared paths lib.)
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
 *     startDir looking for `marker`; falls back to startDir if no marker is found anywhere
 *     up the tree).
 *
 * EXAMPLE
 *   const { findRoot } = require('./tpm-task-paths');
 *   const root = findRoot({ startDir: __dirname, marker: 'CLAUDE.md' });
 */

'use strict';

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
