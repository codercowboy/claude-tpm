#!/usr/bin/env node
'use strict';
/**
 * tools/tests/lib/scratch.js — the ONE place tools tests get throwaway scratch directories.
 *
 * Every tools test writes its throwaway output under  <os.tmpdir()>/tpm-tests/<run-slug>/  — one
 * easy-to-nuke location OUTSIDE the bundle. (It used to live at <bundle>/tmp/scratch/, but that made the
 * bundle itself grow by hundreds of MB per few runs, which every bundle-copying / hashing test then had to
 * walk — the install suite got slower with every run.) Never inside the bundle, so it can't pollute the repo
 * tree, an `npm pack`, or a bundle copy.
 *
 * ONE slug PER RUN. A run-all calls ensureRunSlug() before spawning its child suites, so every child
 * inherits the same TPM_TEST_RUN env var → all suites in one `npm test` land under ONE
 * tests-run-<slug>/ folder. A standalone `node …/some/test.js` invents its own slug. Nothing is
 * auto-deleted — each run is an isolated, uniquely-named folder you can inspect, then nuke
 * the OS temp dir's `tpm-tests/` wholesale whenever.
 *
 * This is shared TEST infrastructure, deliberately requ­ired across suites. The tool-conventions
 * self-containment rule is about the TOOLS a consumer copies suite-by-suite — not the tests, which are
 * never copied. Keeping this in one file avoids the copy-drift the workflow test tools just suffered.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUNDLE_MARKER = '@codercowboy/claude-tpm';

/** Walk up from startDir for the claude-tpm bundle root (its package.json name is the marker). */
function bundleRoot(startDir) {
  let dir = path.resolve(startDir || __dirname);
  for (;;) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg && pkg.name === BUNDLE_MARKER) return dir;
    } catch (_e) { /* not our marker — keep walking up */ }
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(startDir || __dirname); // reached fs root: fall back to start
    dir = up;
  }
}

/**
 * The run slug (`tests-run-<alphanumeric>`). Set it in process.env.TPM_TEST_RUN the FIRST time it's
 * needed so child processes spawned afterwards inherit the same value — a run-all should call this at
 * startup, before spawning, to give the whole run one shared folder.
 */
function ensureRunSlug() {
  if (!process.env.TPM_TEST_RUN) {
    process.env.TPM_TEST_RUN = `tests-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
  return process.env.TPM_TEST_RUN;
}

/** <os.tmpdir()>/tpm-tests/<run-slug>/ — created on demand (outside the bundle). */
function scratchRoot() {
  const root = path.join(os.tmpdir(), 'tpm-tests', ensureRunSlug());
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** A fresh, unique scratch dir under the run's scratch root (drop-in for fs.mkdtempSync). */
function mkScratch(prefix) {
  return fs.mkdtempSync(path.join(scratchRoot(), `${prefix || 'sbx'}-`));
}

module.exports = { bundleRoot, ensureRunSlug, scratchRoot, mkScratch, BUNDLE_MARKER };
