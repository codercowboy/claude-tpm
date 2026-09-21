'use strict';
/**
 * base.js — the ONE indirection to the shared base lib (OQ5: reference-in-place).
 *
 * ── THE SINGLE CROSS-SANDBOX PATH ──
 * Per 01-plan §3 (OQ5 → reference-in-place), the base lib stays the ONE physical copy in
 * `dev/20260919-session-features/session-tooling/lib/`. task-tooling reaches it through THIS
 * file — the only place the cross-sandbox path is spelled. Nothing session imports moves; the
 * two kinds share one copy so they cannot diverge (#1121). At promotion (design-notes cutover),
 * the base lib moves into `../claude-tpm` for BOTH consumers at once, and THIS file is the one
 * that gets rewritten.
 *
 * ── WHAT IS RE-EXPORTED ── the 9 kind-agnostic base modules + the shared `paths` (#1058):
 *   io · envelope · version · validate · update · normalize · timestamp · exportScaffold ·
 *   hash (renamed from session-hash, §5 R-a) · paths (new shared, §5 R-b).
 * The three kind-SPECIFIC modules (task-schema / task-model / task-converter) are NOT here —
 * they live under task-tooling/lib/ and are built by phases 03–05.
 *
 * Runs as plain `node <file>` with zero deps, so a computed `require(BASE + '/<name>')` is fine
 * (no bundler; §3 blesses this over a static-analyzable literal).
 *
 * EXAMPLE
 *   const base = require('./base');
 *   const { readEnvelope } = base.envelope;
 *   const { hashRecord }   = base.hash;
 *   const root = base.paths.findRoot({ startDir: __dirname, marker: 'CLAUDE.md' });
 */

const path = require('path');

// The ONE indirection to the blessed shared base lib (#1121). PROMOTED (Stage A / #1123): the base
// lib now lives at the 0.2.0 tree's tools/lib/ as the single physical copy. From tools/task/lib/ walk
// up two (lib → task → tools) then into the sibling tools/lib/. This is the one file the promotion
// rewrites (as its own docstring foretold); every task consumer keeps requiring it unchanged.
const BASE = path.join(__dirname, '..', '..', 'lib');

// Basename → export key. Basenames are the on-disk filenames (export-scaffold, hash, paths).
const MODULES = {
  io:             'io',
  envelope:       'envelope',
  version:        'version',
  validate:       'validate',
  update:         'update',
  normalize:      'normalize',
  timestamp:      'timestamp',
  exportScaffold: 'export-scaffold',
  hash:           'hash',        // ← renamed from session-hash (§5 R-a)
  paths:          'paths',       // ← new shared paths module (§5 R-b)
};

const exported = {};
for (const [key, basename] of Object.entries(MODULES)) {
  exported[key] = require(path.join(BASE, basename));
}

module.exports = exported;

// `node lib/base.js` → a self-check that every base module loaded (loadable/inspectable per convention).
if (require.main === module) {
  const keys = Object.keys(exported);
  for (const k of keys) {
    if (exported[k] == null || typeof exported[k] !== 'object') {
      console.error(`base.js: module '${k}' did not load to an object`);
      process.exit(1);
    }
  }
  console.log(`base.js OK — ${keys.length} base modules re-exported: ${keys.join(', ')}`);
}
