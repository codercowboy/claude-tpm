'use strict';
/**
 * lib-observe-world.js — shared fixtures for the observe + voice suites (tests only; never shipped as a tool).
 * Builds scratch claude-tpm folders / consumer projects and a hermetic world: the STATEFUL fake `claude`
 * (tests/fake-claude-stateful.js) and a fake `npm` first on PATH, HOME/CLAUDE_CONFIG_DIR in scratch, and an
 * env-leak sentinel that proves neither the real `claude` nor the real `npm` is reachable.
 */
const fs = require('fs');
const path = require('path');
const { mkScratch } = require('../../tests/lib/scratch');
const { findOnPath } = require('../tpm-consumer-observe');

const FAKE = path.resolve(__dirname, 'fake-claude-stateful.js');
const PKG = '@codercowboy/claude-tpm';

const real = (p) => fs.realpathSync(p);
const mk = (prefix) => real(mkScratch(prefix));

const HOOK = (e, name) => ({ [e]: [{ hooks: [{ type: 'command', command: `node "\${CLAUDE_PLUGIN_ROOT}/tools/tpm.js" hooks ${name}` }] }] });
const HOOKS_BOTH = { hooks: Object.assign({}, HOOK('SessionStart', 'session-start'), HOOK('PreToolUse', 'gate-spawn')) };

/** A claude-tpm folder. o: {version, name (marketplace), hooks: false|'garbage'|object, manifest: false|'garbage'} */
function bundle(dir, o) {
  o = o || {};
  const version = o.version || '0.2.0-dev';
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: PKG, version }));
  if (o.manifest === 'garbage') fs.writeFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), '{nope');
  else if (o.manifest !== false) fs.writeFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name: o.name || `claude-tpm-market-${version}`, owner: { name: 'x' }, plugins: [{ name: 'claude-tpm', source: './' }] }));
  if (o.hooks === 'garbage') fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), '{nope');
  else if (o.hooks !== false) fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify(o.hooks || HOOKS_BOTH));
  return real(dir);
}
function standalone(o) { return bundle(path.join(mk('sb'), 'claude-tpm-folder'), o); }

/** A consumer project. o: {pkg: false|'garbage'|{bucket,spec}|null, marker: false|true|'config-valid'|'config-bad', settings, local} */
function project(o) {
  o = o || {};
  const dir = path.join(mk('pj'), 'proj'); fs.mkdirSync(dir);
  if (o.pkg === 'garbage') fs.writeFileSync(path.join(dir, 'package.json'), '{{{');
  else if (o.pkg !== false) {
    const pj = { name: 'fixture', version: '1.0.0' };
    const dep = o.pkg === undefined ? { bucket: 'devDependencies', spec: 'file:../x' } : o.pkg;
    if (dep) pj[dep.bucket] = { [PKG]: dep.spec };
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pj));
  }
  if (o.marker) {
    fs.mkdirSync(path.join(dir, '.claude', 'claude-tpm'), { recursive: true });
    if (o.marker === 'config-valid') fs.writeFileSync(path.join(dir, '.claude', 'claude-tpm', 'config.json'), '{"version":1}');
    if (o.marker === 'config-bad') fs.writeFileSync(path.join(dir, '.claude', 'claude-tpm', 'config.json'), '{"version":');
  }
  if (o.settings !== undefined || o.local !== undefined) fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const w = (n, v) => v !== undefined && fs.writeFileSync(path.join(dir, '.claude', n), typeof v === 'string' ? v : JSON.stringify(v));
  w('settings.json', o.settings); w('settings.local.json', o.local);
  return dir;
}
/** node_modules/@codercowboy/claude-tpm → symlink to `to`, or a real copy bundle when to===null. */
function nm(dir, to, bundleOpts) {
  const scope = path.join(dir, 'node_modules', '@codercowboy'); fs.mkdirSync(scope, { recursive: true });
  const p = path.join(scope, 'claude-tpm');
  if (to === null) bundle(p, bundleOpts); else fs.symlinkSync(to, p);
  return p;
}

/** A hermetic world. o: {marketplaces, records, env} → {env, log(), calls(), state path…}. */
function world(o) {
  o = o || {};
  const work = mk('tpm-obs-world');
  const shim = path.join(work, 'claude'); fs.copyFileSync(FAKE, shim); fs.chmodSync(shim, 0o755);
  const npm = path.join(work, 'npm'); fs.writeFileSync(npm, '#!/usr/bin/env node\nconsole.log("10.0.0");\n'); fs.chmodSync(npm, 0o755);
  const statePath = path.join(work, 'state.json'); const logPath = path.join(work, 'calls.jsonl');
  fs.writeFileSync(statePath, JSON.stringify({ marketplaces: o.marketplaces || [], records: o.records || [] }));
  const home = path.join(work, 'home'); fs.mkdirSync(home);
  const env = Object.assign({}, process.env);
  ['TPM_PROJECT_ROOT', 'TPM_HOME', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PROJECT_DIR', 'FAKE_CLAUDE_FAIL'].forEach((k) => delete env[k]);
  Object.assign(env, { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), FAKE_CLAUDE_STATE: statePath, FAKE_CLAUDE_LOG: logPath });
  env.PATH = [work, path.dirname(process.execPath)].join(path.delimiter);
  if (o.noClaude) { // node + the fake npm only: `claude` is not on PATH at all
    const only = mk('tpm-obs-noclaude'); fs.symlinkSync(process.execPath, path.join(only, 'node')); fs.copyFileSync(npm, path.join(only, 'npm')); fs.chmodSync(path.join(only, 'npm'), 0o755);
    env.PATH = only;
  }
  Object.assign(env, o.env || {});
  return {
    work, env, statePath, logPath,
    calls() { try { return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_e) { return []; } },
    claudeCalls() { return this.calls().map((c) => c.argv.join(' ')); },
    shimPath: shim,
  };
}

/** Env-leak sentinel: in a normal world the first `claude`/`npm` on PATH is OUR shim, never a real binary. */
function assertHermetic(w) {
  const c = findOnPath('claude', w.env.PATH); const n = findOnPath('npm', w.env.PATH);
  if (c !== w.shimPath) throw new Error(`env leak: claude on PATH resolves to ${c}, not the fake`);
  if (n !== path.join(w.work, 'npm')) throw new Error(`env leak: npm on PATH resolves to ${n}, not the fake`);
}

module.exports = { bundle, standalone, project, nm, world, assertHermetic, mk, real, HOOKS_BOTH, HOOK, PKG };
