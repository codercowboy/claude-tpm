#!/usr/bin/env node
'use strict';
/**
 * tpm-stamp-manifests.test.js — the version-stamp derivation (tools/build/stamp-manifests.js).
 *
 * Guards that package.json's `version` is the SINGLE source of truth for the two derived fields
 * (marketplace.json .name = "claude-tpm-market-<v>", plugin.json .version = <v>): idempotency, that
 * `--check` writes nothing, and that a non-semver version is a loud refusal.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { mkScratch } = require('./lib/scratch');
const stampMod = require('../build/stamp-manifests');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ✓ ${name}\n`); pass += 1; }
  catch (e) { process.stdout.write(`  ✗ ${name}\n    ${e.message}\n`); fail += 1; }
}

// Build a throwaway bundle fixture: package.json + .claude-plugin/{marketplace,plugin}.json.
function makeBundle(version, { marketName, pluginVersion } = {}) {
  const root = mkScratch('stamp');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@codercowboy/claude-tpm', version }, null, 2) + '\n');
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name: marketName ?? 'claude-tpm-market-STALE', owner: { name: 'codercowboy' },
      plugins: [{ name: 'claude-tpm', source: './' }] }, null, 2) + '\n');
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'claude-tpm', version: pluginVersion ?? '0.0.0-STALE' }, null, 2) + '\n');
  return root;
}
const readMarket = (root) => JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
const readPlugin = (root) => JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));

check('marketplaceNameFor derives the version-scoped name', () => {
  assert.strictEqual(stampMod.marketplaceNameFor('0.3.0'), 'claude-tpm-market-0.3.0');
});

check('isSemver accepts X.Y.Z (+ pre/build), rejects junk', () => {
  assert.ok(stampMod.isSemver('0.3.0'));
  assert.ok(stampMod.isSemver('1.2.3-rc.1'));
  assert.ok(!stampMod.isSemver('0.3'));
  assert.ok(!stampMod.isSemver('latest'));
});

check('stamp rewrites a stale bundle to the package.json version', () => {
  const root = makeBundle('0.3.0');
  const r = stampMod.stamp(root);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.changes.length, 2, 'both fields were stale');
  assert.strictEqual(readMarket(root).name, 'claude-tpm-market-0.3.0');
  assert.strictEqual(readPlugin(root).version, '0.3.0');
});

check('stamp preserves other marketplace.json fields (targeted, not clobbering)', () => {
  const root = makeBundle('0.3.0');
  stampMod.stamp(root);
  const mp = readMarket(root);
  assert.strictEqual(mp.owner.name, 'codercowboy');
  assert.strictEqual(mp.plugins[0].source, './');
});

check('stamp is idempotent — a second run reports no change', () => {
  const root = makeBundle('0.3.0');
  stampMod.stamp(root);
  const after = fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8');
  const r2 = stampMod.stamp(root);
  assert.strictEqual(r2.changed, false);
  assert.strictEqual(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'), after, 'byte-identical on re-stamp');
});

check('--check reports drift but writes NOTHING', () => {
  const root = makeBundle('0.3.0');
  const before = readMarket(root).name;
  const r = stampMod.stamp(root, { check: true });
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.drift, true);
  assert.strictEqual(readMarket(root).name, before, 'check mode left the file untouched');
  assert.strictEqual(readPlugin(root).version, '0.0.0-STALE');
});

check('--check on an in-sync bundle reports clean', () => {
  const root = makeBundle('0.3.0', { marketName: 'claude-tpm-market-0.3.0', pluginVersion: '0.3.0' });
  const r = stampMod.stamp(root, { check: true });
  assert.strictEqual(r.changed, false);
});

check('a non-semver package.json version is a loud throw', () => {
  const root = makeBundle('not-a-version');
  assert.throws(() => stampMod.stamp(root), /not a valid semver/);
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
