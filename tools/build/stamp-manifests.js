#!/usr/bin/env node
'use strict';
/**
 * stamp-manifests.js — make package.json the SINGLE source of truth for the version.
 *
 * WHY
 *   The plugin's version literal used to live in THREE places: package.json (`version`),
 *   .claude-plugin/marketplace.json (`name` = "claude-tpm-market-<v>"), and
 *   .claude-plugin/plugin.json (`version`). The last two were hand-typed, so a version bump that
 *   forgot them registered a STALE, wrong-version marketplace name — the exact cross-version
 *   registry-collision class fixed in session 0027 (a machine-global, last-add-wins marketplace
 *   keyed by NAME). Claude Code reads that `name` STATICALLY from the file at
 *   `claude plugin marketplace add`, so the correct versioned name has to physically be in the file
 *   before install — computing it in JS at install time is not enough.
 *
 * WHAT
 *   Derives both stamped fields from package.json's `version`:
 *     - marketplace.json  .name              → "claude-tpm-market-<version>"
 *     - plugin.json       .version           → "<version>"   (Claude keys its cache path on this)
 *   Idempotent: writes only the files that are actually out of date. Re-serializes touched files as
 *   canonical 2-space JSON (they are generated artifacts now, not hand-formatted).
 *
 * HOW IT RUNS (never a manual step on the blessed path)
 *   package.json wires it into npm's `version` lifecycle:  "version": "npm run stamp".
 *   `npm version <newversion>` rewrites package.json's version, THEN runs this — so one command
 *   bumps + re-stamps together. `.npmrc` sets git-tag-version=false, so npm does NOT commit or tag;
 *   the three changed files just sit in the working tree for you to commit. `prepack` re-stamps
 *   defensively before any publish. A hand-edited version bump that skips `npm version` is caught by
 *   `--check` (this script) and hard-refused at install time by tpm-consumer-install.js.
 *
 * CLI
 *   node tools/build/stamp-manifests.js            # stamp in place (idempotent). exit 0.
 *   node tools/build/stamp-manifests.js --check    # verify only, write nothing. exit 1 on drift.
 *   exit 2 = usage / bad package.json version.
 *
 * Zero third-party deps; Node built-ins only. Self-contained (tool-conventions Part I §2).
 */

const fs = require('fs');
const path = require('path');

// The stable base name; only the version suffix moves. Must match tpm-consumer-install.js's guard.
const MARKETPLACE_PREFIX = 'claude-tpm-market';

// tools/build/stamp-manifests.js → <bundle root>
function bundleRootFrom(dir) { return path.resolve(dir, '..', '..'); }

function marketplaceNameFor(version) { return `${MARKETPLACE_PREFIX}-${version}`; }

// package.json versions are semver; accept the core X.Y.Z plus an optional -prerelease / +build tail.
function isSemver(v) { return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/.test(String(v)); }

/**
 * Read the bundle's three files and compute what (if anything) is out of date.
 * Returns { version, wantName, mp, pl, mpPath, plPath, changes:[{file,field,from,to}] }.
 * Throws (caught by the CLI → exit 2) if package.json's version is missing/not semver.
 */
function plan(bundleRoot) {
  const pkgPath = path.join(bundleRoot, 'package.json');
  const mpPath = path.join(bundleRoot, '.claude-plugin', 'marketplace.json');
  const plPath = path.join(bundleRoot, '.claude-plugin', 'plugin.json');
  const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  if (!isSemver(version)) throw new Error(`package.json version is not a valid semver string: '${version}'`);
  const mp = JSON.parse(fs.readFileSync(mpPath, 'utf8'));
  const pl = JSON.parse(fs.readFileSync(plPath, 'utf8'));
  const wantName = marketplaceNameFor(version);
  const changes = [];
  if (mp.name !== wantName) changes.push({ file: 'marketplace.json', field: 'name', from: mp.name, to: wantName });
  if (pl.version !== version) changes.push({ file: 'plugin.json', field: 'version', from: pl.version, to: version });
  return { version, wantName, mp, pl, mpPath, plPath, changes };
}

/**
 * stamp(bundleRoot, { check }) — the core op.
 *   check:false → write the out-of-date files, return { changed, version, wantName, changes }.
 *   check:true  → write NOTHING, return the same shape with `drift:true` when changes exist.
 */
function stamp(bundleRoot, opts = {}) {
  const p = plan(bundleRoot);
  if (p.changes.length === 0) return { changed: false, version: p.version, wantName: p.wantName, changes: [] };
  if (opts.check) return { changed: true, drift: true, version: p.version, wantName: p.wantName, changes: p.changes };
  p.mp.name = p.wantName;
  fs.writeFileSync(p.mpPath, JSON.stringify(p.mp, null, 2) + '\n');
  p.pl.version = p.version;
  fs.writeFileSync(p.plPath, JSON.stringify(p.pl, null, 2) + '\n');
  return { changed: true, version: p.version, wantName: p.wantName, changes: p.changes };
}

if (require.main === module) {
  const check = process.argv.slice(2).includes('--check');
  const bundleRoot = bundleRootFrom(__dirname);
  try {
    const r = stamp(bundleRoot, { check });
    if (check) {
      if (r.changed) {
        process.stderr.write(`✗ manifest drift — package.json is ${r.version}, but:\n`);
        for (const c of r.changes) process.stderr.write(`    ${c.file} .${c.field}: '${c.from}' → should be '${c.to}'\n`);
        process.stderr.write('  fix: npm run stamp\n');
        process.exit(1);
      }
      process.stdout.write(`✓ manifests in sync at ${r.version} (${r.wantName})\n`);
      process.exit(0);
    }
    if (r.changed) {
      process.stdout.write(`stamped → ${r.version}\n`);
      for (const c of r.changes) process.stdout.write(`    ${c.file} .${c.field}: '${c.from}' → '${c.to}'\n`);
    } else {
      process.stdout.write(`already stamped at ${r.version} (${r.wantName}) — no change\n`);
    }
    process.exit(0);
  } catch (e) {
    process.stderr.write(`stamp: ${e.message}\n`);
    process.exit(2);
  }
}

module.exports = { stamp, plan, marketplaceNameFor, bundleRootFrom, isSemver, MARKETPLACE_PREFIX };
