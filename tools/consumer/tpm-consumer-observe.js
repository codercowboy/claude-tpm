#!/usr/bin/env node
/**
 * tpm-consumer-observe.js — the shared OBSERVER behind `tpm install`, `tpm doctor` and `tpm uninstall`.
 *
 * Design: dev/20261001-installer-updates/installer-design.md (§2 state model, §3 canonical folder, §4.1
 * observe, §4.2 preconditions, N6 probe caching, N8 stamp guard, N9 tolerance). Phase 01 of the installer
 * rewrite: this file is the keystone every later phase imports. It builds NO diagnose/plan/apply.
 *
 * WHAT IT DOES
 *   observe(targetDir, self, env, opts) → State — a plain-JSON snapshot of five layers:
 *     1 dep     (project; written by npm)            2 reg    (machine; `claude plugin marketplace`)
 *     3 en      (project; `claude plugin install…`)  4 marker (project; the installer)
 *     5 self    (the installer's own folder)          + env   (doctor-only rows)
 *   plus `canonical` (§3 step A), `projectVersion` (§2.7), `invalid[]` and `probes` {count, log}.
 *
 *   PURE: it reads package.json, node_modules/@codercowboy/claude-tpm, both settings files,
 *   .claude/claude-tpm/config.json, the installer's own manifest + hooks/hooks.json, and runs at most the
 *   memoized `claude` probes (--version, marketplace list, plugin list) plus `npm --version`. It writes
 *   nothing and NEVER throws on a missing/malformed input — it records `invalid {layer, err}` and goes on.
 *
 *   `observe(…, {probes:false})` is the file-only LIGHT mode (SessionStart hook): no process is spawned;
 *   layer 2/3 record fields are 'unknown' (layer 2 is filled from env.CLAUDE_PLUGIN_ROOT when set).
 *
 *   reobserveLayer(state, layer) re-reads ONE layer and re-runs only that layer's probe (N6):
 *     'dep' | 'marker' | 'self' → filesystem only · 'registration' → marketplace list · 'enablement' → plugin list.
 *
 * HOW TO USE (tests / later phases):  const o = require('./tpm-consumer-observe');
 *   const state = o.observe(projectDir, bundleRoot, process.env);
 *   const refusal = o.preconditions(state, { quiet: false, stdinIsTTY: process.stdin.isTTY });
 *
 * Zero runtime deps; portable `node`; module.exports for tests. Run `node tools/consumer/tpm-consumer-observe.js
 * [dir]` to dump the State as JSON (light mode with --no-probes).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TPM_PKG_NAME = '@codercowboy/claude-tpm';
const PLUGIN_PREFIX = 'claude-tpm@';
const MARKET_PREFIX = 'claude-tpm-market';
const FALLBACK_IDENTITY = { marketplace: MARKET_PREFIX, plugin: 'claude-tpm' };

// ── path helpers ─────────────────────────────────────────────────────────────────────────────────────

/** realpath, or path.resolve when the path does not exist. */
function realOrResolved(p) {
  try { return fs.realpathSync(p); } catch (_e) { return path.resolve(String(p)); }
}

/**
 * Pure: when `p` lies inside a node_modules directory, {projectDir, folder} (projectDir = the directory that
 * owns that node_modules); else null. Uses the LAST node_modules component (as the old realCopyInfo did).
 */
function insideNodeModules(p) {
  if (!p || typeof p !== 'string') return null;
  const parts = path.resolve(p).split(path.sep);
  const i = parts.lastIndexOf('node_modules');
  if (i < 0) return null;
  return { projectDir: parts.slice(0, i).join(path.sep) || path.sep, folder: path.resolve(p) };
}

/** Walk up from startDir for the folder whose package.json is named @codercowboy/claude-tpm, or null. */
function findBundleRoot(startDir) {
  let dir = path.resolve(String(startDir || '.'));
  for (;;) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg && pkg.name === TPM_PKG_NAME) return dir;
    } catch (_e) { /* missing / unreadable / invalid — not our marker, keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The marketplace + plugin names READ from a bundle's own .claude-plugin/marketplace.json. Returns
 * {marketplace, plugin, err?}; on an unreadable manifest the historical bare names come back with `err`.
 */
function readBundleIdentity(bundleRoot) {
  if (!bundleRoot) return Object.assign({ err: 'no claude-tpm folder located' }, FALLBACK_IDENTITY);
  try {
    const mp = JSON.parse(fs.readFileSync(path.join(bundleRoot, '.claude-plugin', 'marketplace.json'), 'utf8'));
    const marketplace = (mp && typeof mp.name === 'string' && mp.name) ? mp.name : FALLBACK_IDENTITY.marketplace;
    const plugin = (mp && Array.isArray(mp.plugins) && mp.plugins[0] && typeof mp.plugins[0].name === 'string' && mp.plugins[0].name)
      ? mp.plugins[0].name : FALLBACK_IDENTITY.plugin;
    return { marketplace, plugin };
  } catch (e) { return Object.assign({ err: e.message }, FALLBACK_IDENTITY); }
}

/** Layer-5 stamp guard (N8): the marketplace name must equal `claude-tpm-market-<version>`. Unknown version → ok. */
function stampCheck(version, name) {
  if (!version) return { ok: true, expected: null, actual: name || null };
  const expected = `${MARKET_PREFIX}-${version}`;
  return { ok: name === expected, expected, actual: name || null };
}

/** The Claude config dir (shared with the uninstaller): $CLAUDE_CONFIG_DIR else ~/.claude. */
function claudeConfigDir(env) {
  const e = env || process.env;
  return e.CLAUDE_CONFIG_DIR || path.join(e.HOME || os.homedir(), '.claude');
}

function readJson(p) {
  try { return { exists: true, value: JSON.parse(fs.readFileSync(p, 'utf8')), err: null }; }
  catch (e) { return { exists: e.code !== 'ENOENT', value: null, err: e.code === 'ENOENT' ? null : e.message }; }
}

function versionOf(dir) {
  const j = readJson(path.join(dir, 'package.json'));
  return j.value && typeof j.value.version === 'string' ? j.value.version : null;
}

/** Pure: which hooks a parsed hooks.json declares (matched by `hooks <name>` inside the command string). */
function parseHooksManifest(manifest) {
  const out = { gateSpawn: false, sessionStart: false };
  if (!manifest || typeof manifest !== 'object' || !manifest.hooks || typeof manifest.hooks !== 'object') return out;
  const scan = (groups, re) => {
    if (!Array.isArray(groups)) return false;
    return groups.some((g) => g && Array.isArray(g.hooks) && g.hooks.some((h) => h && typeof h.command === 'string' && re.test(h.command)));
  };
  out.gateSpawn = scan(manifest.hooks.PreToolUse, /hooks\s+gate-spawn/);
  out.sessionStart = scan(manifest.hooks.SessionStart, /hooks\s+session-start/);
  return out;
}

/** hooks/hooks.json of a claude-tpm folder → {present, err, gateSpawn, sessionStart, complete}. */
function hooksHealthAt(dir) {
  const p = path.join(dir, 'hooks', 'hooks.json');
  const j = readJson(p);
  if (!j.exists) return { present: false, err: null, gateSpawn: false, sessionStart: false, complete: false };
  if (j.err) return { present: true, err: j.err, gateSpawn: false, sessionStart: false, complete: false };
  const h = parseHooksManifest(j.value);
  return { present: true, err: null, gateSpawn: h.gateSpawn, sessionStart: h.sessionStart, complete: h.gateSpawn && h.sessionStart };
}

/** Pure: the version a claude-tpm plugin id denotes. `…market-0.2.0` → '0.2.0'; bare `…market` → '0.1.0'. */
function versionFromPluginId(id) {
  const m = /@claude-tpm-market(?:-(.+))?$/.exec(String(id));
  if (!m) return null;
  return m[1] || '0.1.0';
}

// ── probes (memoized; N6) ────────────────────────────────────────────────────────────────────────────

function defaultExec(bin, argv, cwd, env) {
  return spawnSync(bin, argv, { encoding: 'utf8', cwd, env, timeout: 30000 });
}

function classifySpawn(r) {
  const errorCode = r && r.error ? (r.error.code || 'ESPAWN') : null;
  const status = r && typeof r.status === 'number' ? r.status : null;
  return { ok: !errorCode && status === 0, ran: !errorCode, status, signal: (r && r.signal) || null, errorCode };
}

/** One memo table per observe(); `fresh:true` re-runs (and re-counts) a probe. Counts only `claude` calls. */
function makeProbes(env, cwd, exec) {
  const memo = new Map();
  const log = [];
  let count = 0;
  function run(key, bin, argv, fresh) {
    if (!fresh && memo.has(key)) return memo.get(key);
    let r;
    try { r = exec(bin, argv, cwd, env); } catch (e) { r = { error: { code: e.code || 'ESPAWN', message: e.message }, status: null }; }
    log.push(`${bin} ${argv.join(' ')}`);
    if (bin === 'claude') count += 1;
    const cls = classifySpawn(r);
    let json = null;
    if (cls.ok && r.stdout) { try { json = JSON.parse(r.stdout); } catch (_e) { json = null; } }
    const out = Object.assign({ stdout: r && r.stdout, stderr: r && r.stderr, json }, cls);
    memo.set(key, out);
    return out;
  }
  return {
    claudeVersion: (f) => run('claude-version', 'claude', ['--version'], f),
    npmVersion: (f) => run('npm-version', 'npm', ['--version'], f),
    marketplaceList: (f) => run('marketplace-list', 'claude', ['plugin', 'marketplace', 'list', '--json'], f),
    pluginList: (f) => run('plugin-list', 'claude', ['plugin', 'list', '--json'], f),
    snapshot: () => ({ count, log: log.slice() }),
  };
}

// ── layer readers ────────────────────────────────────────────────────────────────────────────────────

/** Layer 5 — the installer's own folder. `selfArg` = a folder path | {root} | falsy (→ findBundleRoot(__dirname)). */
function readSelf(selfArg, targetReal) {
  let rootArg = selfArg && typeof selfArg === 'object' ? selfArg.root : selfArg;
  if (!rootArg) rootArg = findBundleRoot(__dirname);
  const out = { root: null, version: null, name: null, plugin: null, id: null, expectedName: null, stampOk: true,
    shape: 'unknown', ownerProject: null, complete: false, hooks: null, err: null };
  if (!rootArg) { out.err = 'could not locate the claude-tpm folder'; return out; }
  out.root = realOrResolved(rootArg);
  out.version = versionOf(out.root);
  const ident = readBundleIdentity(out.root);
  out.name = ident.marketplace; out.plugin = ident.plugin; out.id = `${ident.plugin}@${ident.marketplace}`;
  if (ident.err) out.err = ident.err;
  const st = stampCheck(out.version, out.name);
  out.stampOk = st.ok; out.expectedName = st.expected;
  const nm = insideNodeModules(out.root);
  if (!nm) out.shape = 'standalone';
  else { out.ownerProject = nm.projectDir; out.shape = realOrResolved(nm.projectDir) === targetReal ? 'this-project-copy' : 'other-project-copy'; }
  out.hooks = hooksHealthAt(out.root);
  out.complete = out.hooks.complete;
  return out;
}

/** Layer 1 — package.json buckets + node_modules/@codercowboy/claude-tpm. */
function readDep(target, invalid) {
  const out = { declared: null, onDisk: 'absent', linksTo: null, version: null, mode: 'none' };
  const pj = readJson(path.join(target, 'package.json'));
  if (pj.err) invalid.push({ layer: 'dep', file: 'package.json', err: pj.err });
  if (pj.value && typeof pj.value === 'object') {
    for (const bucket of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const b = pj.value[bucket];
      if (b && typeof b === 'object' && Object.prototype.hasOwnProperty.call(b, TPM_PKG_NAME)) { out.declared = { bucket, spec: b[TPM_PKG_NAME] }; break; }
    }
  }
  const p = path.join(target, 'node_modules', TPM_PKG_NAME);
  let ls = null;
  try { ls = fs.lstatSync(p); } catch (_e) { ls = null; }
  if (ls) {
    if (ls.isSymbolicLink()) {
      out.mode = 'linked';
      try { out.linksTo = fs.realpathSync(p); out.onDisk = 'link'; out.version = versionOf(out.linksTo); }
      catch (_e) { out.onDisk = 'dangling'; }
    } else if (ls.isDirectory()) {
      out.onDisk = 'copy'; out.mode = 'vendored'; out.version = versionOf(p);
    } else invalid.push({ layer: 'dep', file: p, err: 'not a directory or link' });
  }
  return out;
}

/** Layer 4 — .claude/claude-tpm/ + config.json validity. */
function readMarker(target, invalid) {
  const dir = path.join(target, '.claude', 'claude-tpm');
  let isDir = false;
  try { isDir = fs.statSync(dir).isDirectory(); } catch (_e) { isDir = false; }
  const out = { dir: isDir, config: 'absent', err: null };
  const cfg = path.join(dir, 'config.json');
  let exists = false;
  try { fs.lstatSync(cfg); exists = true; } catch (_e) { exists = false; }
  if (exists) {
    try { JSON.parse(fs.readFileSync(cfg, 'utf8')); out.config = 'valid'; }
    catch (e) { out.config = 'invalid'; out.err = e.message; invalid.push({ layer: 'marker', file: cfg, err: e.message }); }
  }
  return out;
}

/** Layer 2 — registration. `list` = parsed `marketplace list --json` | undefined (not probed) | null (probe failed). */
function classifyReg(list, self, targetReal, probed) {
  const out = { state: 'unknown', storedPath: null, realPath: null, where: null, projectDir: null, version: null,
    source: null, complete: null, live: null };
  if (!probed) return out;
  if (!Array.isArray(list)) return out;
  const row = list.find((m) => m && typeof m === 'object' && m.name === self.name);
  if (!row) { out.state = 'absent'; out.live = false; return out; }
  out.source = typeof row.source === 'string' ? row.source : null;
  out.storedPath = typeof row.path === 'string' ? row.path : null;
  const isDir = row.source === 'directory' || (row.source == null && out.storedPath != null);
  if (!isDir) { out.state = 'github'; out.where = 'github'; out.live = true; return out; }
  if (!out.storedPath || !fs.existsSync(out.storedPath)) { out.state = 'dead'; out.live = false; return out; }
  out.realPath = realOrResolved(out.storedPath);
  out.live = true;
  out.version = versionOf(out.realPath);
  out.complete = hooksHealthAt(out.realPath).complete;
  const same = !!self.root && out.realPath === self.root;
  if (same) out.state = out.realPath !== path.resolve(out.storedPath) ? 'same-via-link' : 'same';
  else {
    out.state = 'elsewhere';
    const nm = insideNodeModules(out.realPath);
    if (!nm) out.where = 'standalone';
    else { out.projectDir = nm.projectDir; out.where = realOrResolved(nm.projectDir) === targetReal ? 'this-project-copy' : 'other-project-copy'; }
  }
  return out;
}

/** Layer 3 — enablement. Settings are always read (file-only); the record needs `pluginListJson`. */
function readEn(target, self, targetReal, pluginProbed, pluginListJson, invalid, warnings) {
  const out = { record: 'unknown', enabledHere: false, loadsWithoutRecord: null, otherIds: [], otherVersions: [],
    extraKnownMarketplaces: { present: false, names: [] } };
  const merged = {};
  const order = [];
  const extra = [];
  for (const name of ['settings.json', 'settings.local.json']) {
    const f = path.join(target, '.claude', name);
    const j = readJson(f);
    if (j.err) { invalid.push({ layer: 'enablement', file: f, err: j.err }); continue; }
    const v = j.value;
    if (!v || typeof v !== 'object') continue;
    if (v.enabledPlugins && typeof v.enabledPlugins === 'object') {
      for (const k of Object.keys(v.enabledPlugins)) { if (!(k in merged)) order.push(k); merged[k] = v.enabledPlugins[k]; }
    }
    if (v.extraKnownMarketplaces && typeof v.extraKnownMarketplaces === 'object') {
      for (const k of Object.keys(v.extraKnownMarketplaces)) if (k.indexOf(MARKET_PREFIX) === 0 && extra.indexOf(k) < 0) extra.push(k);
    }
  }
  out.enabledHere = merged[self.id] === true;
  out.extraKnownMarketplaces = { present: extra.length > 0, names: extra };
  const others = order.filter((k) => k !== self.id && k.indexOf(PLUGIN_PREFIX) === 0 && merged[k] === true);

  if (pluginProbed) {
    if (pluginListJson === null) { /* probe failed → record stays 'unknown' */ }
    else if (!Array.isArray(pluginListJson)) { warnings.push('`claude plugin list --json` did not return an array'); }
    else {
      const mine = (e) => e && typeof e === 'object' && (e.scope === undefined || e.scope === 'project') &&
        (!(typeof e.projectPath === 'string' && e.projectPath) || realOrResolved(e.projectPath) === targetReal);
      const rec = pluginListJson.find((e) => mine(e) && e.id === self.id);
      if (!rec) out.record = { present: false };
      else {
        const ip = typeof rec.installPath === 'string' ? rec.installPath : null;
        out.record = { present: true, enabled: typeof rec.enabled === 'boolean' ? rec.enabled : true,
          installPath: ip, installPathExists: ip ? fs.existsSync(ip) : false };
        if (typeof rec.enabled !== 'boolean') warnings.push(`plugin entry ${self.id} has no boolean "enabled" field — assuming enabled`);
      }
      // records add other ids only where settings are silent about that key
      for (const e of pluginListJson) {
        if (mine(e) && typeof e.id === 'string' && e.id !== self.id && e.id.indexOf(PLUGIN_PREFIX) === 0 &&
            e.enabled === true && !(e.id in merged) && others.indexOf(e.id) < 0) others.push(e.id);
      }
    }
  }
  out.otherIds = others;
  out.otherVersions = others.map((id) => ({ id, version: versionFromPluginId(id) }));
  return out;
}

function readEnv(env, probes, probed, self) {
  const out = { claudeOnPath: null, claudeError: null, npmOnPath: null, npmError: null,
    inSession: !!(env.TPM_PROJECT_ROOT || env.TPM_HOME), tpmOnPath: null, tpmHome: env.TPM_HOME || null,
    claudeConfigDir: claudeConfigDir(env) };
  out.tpmOnPath = findOnPath('tpm', env.PATH);
  if (out.tpmOnPath) out.tpmOnPath = realOrResolved(out.tpmOnPath);
  if (probed) {
    const c = probes.claudeVersion(); out.claudeOnPath = c.ok; out.claudeError = c.ok ? null : (c.errorCode || `exited ${c.status}`);
    const n = probes.npmVersion(); out.npmOnPath = n.ok; out.npmError = n.ok ? null : (n.errorCode || `exited ${n.status}`);
  }
  void self;
  return out;
}

/** First executable `name` on a PATH string, or null. */
function findOnPath(name, pathStr) {
  for (const dir of String(pathStr || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { if (!fs.statSync(p).isFile()) continue; fs.accessSync(p, fs.constants.X_OK); return p; } catch (_e) { /* next */ }
  }
  return null;
}

// ── canonical (§3 step A) ────────────────────────────────────────────────────────────────────────────

/**
 * Step A: where the installer runs decides the canonical folder + layer-1 mode.
 *   standalone → {root: self.root, mode:'linked'} · this-project-copy → {root: self.root, mode:'vendored'}
 *   other-project-copy → {root:null, mode:null, refuse:'other-project-copy', owner}  · unknown → refuse 'no-self'.
 * (Step B — the user's use / re-point choice — is the decide phase, phase 02.)
 */
function selectCanonical(self) {
  if (!self || !self.root) return { root: null, mode: null, refuse: 'no-self', owner: null };
  if (self.shape === 'standalone') return { root: self.root, mode: 'linked', refuse: null, owner: null };
  if (self.shape === 'this-project-copy') return { root: self.root, mode: 'vendored', refuse: null, owner: null };
  return { root: null, mode: null, refuse: 'other-project-copy', owner: self.ownerProject };
}

function liveReg(reg) { return reg.state === 'same' || reg.state === 'same-via-link' || reg.state === 'elsewhere' || reg.state === 'github'; }

/** Recompute everything derived from more than one layer. */
function finish(state) {
  state.canonical = selectCanonical(state.self);
  const reg = state.reg;
  state.en.loadsWithoutRecord = (reg.state === 'unknown' || state.en.record === 'unknown')
    ? null : !!(state.en.enabledHere && !(state.en.record && state.en.record.present) && liveReg(reg));
  state.projectVersion = state.dep.version || (state.en.otherVersions[0] && state.en.otherVersions[0].version) || null;
  return state;
}

// ── observe ──────────────────────────────────────────────────────────────────────────────────────────

function makeCtx(targetDir, selfArg, env, opts) {
  const e = env || process.env;
  const target = path.resolve(String(targetDir || '.'));
  return { target, targetReal: realOrResolved(target), selfArg, env: e,
    probed: !(opts && opts.probes === false), exec: (opts && opts.exec) || defaultExec };
}

/**
 * observe(targetDir, self, env, opts) → State.
 *   self  : the installer's own folder (path | {root}); omitted → located from this file's location.
 *   env   : an environment object (PATH is what the `claude` probes resolve against); default process.env.
 *   opts  : {probes:false} for the file-only light mode · {exec} injectable spawn (bin, argv, cwd, env).
 */
function observe(targetDir, selfArg, env, opts) {
  const ctx = makeCtx(targetDir, selfArg, env, opts);
  let probeCwd = ctx.target;
  try { if (!fs.statSync(ctx.target).isDirectory()) probeCwd = process.cwd(); } catch (_e) { probeCwd = process.cwd(); }
  const probes = makeProbes(ctx.env, probeCwd, ctx.exec);
  const invalid = [];
  const warnings = [];
  const state = { target: { dir: ctx.target, real: ctx.targetReal, exists: false, pkg: { exists: false, valid: false, err: null } },
    mode: ctx.probed ? 'full' : 'light', invalid, warnings };
  try { state.target.exists = fs.statSync(ctx.target).isDirectory(); } catch (_e) { state.target.exists = false; }
  const pj = readJson(path.join(ctx.target, 'package.json'));
  state.target.pkg = { exists: pj.exists, valid: !!pj.value && !pj.err, err: pj.err };

  const guard = (layer, fn, fallback) => {
    try { return fn(); } catch (e) { invalid.push({ layer, err: e.message }); return fallback; }
  };
  state.self = guard('self', () => readSelf(ctx.selfArg, ctx.targetReal), { root: null, shape: 'unknown', complete: false, stampOk: true, name: FALLBACK_IDENTITY.marketplace, id: 'claude-tpm@' + FALLBACK_IDENTITY.marketplace, err: 'self unreadable' });
  state.dep = guard('dep', () => readDep(ctx.target, invalid), { declared: null, onDisk: 'absent', linksTo: null, version: null, mode: 'none' });
  state.marker = guard('marker', () => readMarker(ctx.target, invalid), { dir: false, config: 'absent', err: null });
  state.env = guard('env', () => readEnv(ctx.env, probes, ctx.probed, state.self), { claudeOnPath: null, npmOnPath: null, inSession: false, tpmOnPath: null, tpmHome: null });

  const claudeUp = ctx.probed && state.env.claudeOnPath === true;
  let mList; let pList;
  if (claudeUp) {
    const m = probes.marketplaceList(); mList = m.ok ? m.json : null;
    const p = probes.pluginList(); pList = p.ok ? p.json : null;
  }
  state.reg = guard('registration', () => classifyReg(claudeUp ? mList : undefined, state.self, ctx.targetReal, claudeUp),
    { state: 'unknown', storedPath: null, realPath: null, where: null, projectDir: null, version: null, source: null, complete: null, live: null });
  if (!ctx.probed && ctx.env.CLAUDE_PLUGIN_ROOT) fillRegFromPluginRoot(state.reg, ctx);
  state.en = guard('enablement', () => readEn(ctx.target, state.self, ctx.targetReal, claudeUp, pList, invalid, warnings),
    { record: 'unknown', enabledHere: false, loadsWithoutRecord: null, otherIds: [], otherVersions: [], extraKnownMarketplaces: { present: false, names: [] } });
  finish(state);
  state.probes = probes.snapshot();
  hide(state, '_ctx', { ctx, probes });
  return state;
}

/** Light mode: the running plugin IS the registered folder and is live (it is executing) — no probe needed. */
function fillRegFromPluginRoot(reg, ctx) {
  const root = realOrResolved(ctx.env.CLAUDE_PLUGIN_ROOT);
  reg.realPath = root; reg.storedPath = ctx.env.CLAUDE_PLUGIN_ROOT; reg.live = true; reg.version = versionOf(root);
  reg.complete = hooksHealthAt(root).complete; reg.fromPluginRoot = true;
}

function hide(obj, key, val) { Object.defineProperty(obj, key, { value: val, enumerable: false, writable: true, configurable: true }); }

/**
 * Re-read ONE layer (after an action touched it) and return a NEW State; every other layer is carried over.
 * layer: 'dep' | 'marker' | 'self' (filesystem only) · 'registration' (re-runs marketplace list) ·
 * 'enablement' (re-runs plugin list). Only that layer's probe runs (N6). Never throws.
 */
function reobserveLayer(prev, layer) {
  const { ctx, probes } = prev._ctx;
  const state = Object.assign({}, prev, { invalid: prev.invalid.filter((i) => i.layer !== layer), warnings: prev.warnings.slice() });
  const claudeUp = ctx.probed && prev.env.claudeOnPath === true;
  try {
    if (layer === 'dep') state.dep = readDep(ctx.target, state.invalid);
    else if (layer === 'marker') state.marker = readMarker(ctx.target, state.invalid);
    else if (layer === 'self') state.self = readSelf(ctx.selfArg, ctx.targetReal);
    else if (layer === 'registration') {
      const m = claudeUp ? probes.marketplaceList(true) : null;
      state.reg = classifyReg(claudeUp ? (m.ok ? m.json : null) : undefined, state.self, ctx.targetReal, claudeUp);
    } else if (layer === 'enablement') {
      const p = claudeUp ? probes.pluginList(true) : null;
      state.en = readEn(ctx.target, state.self, ctx.targetReal, claudeUp, p && p.ok ? p.json : null, state.invalid, state.warnings);
    } else throw new Error('unknown layer: ' + layer);
  } catch (e) { state.invalid.push({ layer, err: e.message }); }
  finish(state);
  state.probes = probes.snapshot();
  hide(state, '_ctx', { ctx, probes });
  return state;
}

// ── preconditions (§4.2) ─────────────────────────────────────────────────────────────────────────────

/**
 * The first §4.2 refusal that applies, or null. Returns {id, exit:1, detail} — the WORDS are the voice
 * module's (`voice.refusal(refusal, state)`), so this file holds no user-facing prose.
 *   1 tool-missing (npm | claude)   2 no-package-json | bad-package-json   3 stamp
 *   4 other-project-copy | no-self  5 incomplete   6 non-tty
 * opts: {quiet, stdinIsTTY}. Tool checks are skipped in light mode (nothing was probed).
 */
function preconditions(state, opts) {
  const o = opts || {};
  if (state.mode === 'full') {
    if (state.env.npmOnPath === false) return { id: 'tool-missing', exit: 1, detail: { bin: 'npm', errorCode: state.env.npmError } };
    if (state.env.claudeOnPath === false) return { id: 'tool-missing', exit: 1, detail: { bin: 'claude', errorCode: state.env.claudeError } };
  }
  if (!state.target.exists || !state.target.pkg.exists) return { id: 'no-package-json', exit: 1, detail: {} };
  if (!state.target.pkg.valid) return { id: 'bad-package-json', exit: 1, detail: { err: state.target.pkg.err } };
  if (state.self.root && !state.self.stampOk) return { id: 'stamp', exit: 1, detail: { version: state.self.version, expected: state.self.expectedName, actual: state.self.name } };
  if (state.canonical.refuse) return { id: state.canonical.refuse, exit: 1, detail: { owner: state.canonical.owner } };
  if (!state.self.complete) return { id: 'incomplete', exit: 1, detail: { hooks: state.self.hooks } };
  if (o.quiet !== true && o.stdinIsTTY === false) return { id: 'non-tty', exit: 1, detail: {} };
  return null;
}

module.exports = {
  observe, reobserveLayer, preconditions, selectCanonical,
  realOrResolved, insideNodeModules, findBundleRoot, readBundleIdentity, stampCheck, claudeConfigDir,
  parseHooksManifest, hooksHealthAt, versionFromPluginId, findOnPath, classifyReg, readEn, readDep, readMarker, readSelf,
  TPM_PKG_NAME, PLUGIN_PREFIX,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => a[0] !== '-') || process.cwd();
  process.stdout.write(JSON.stringify(observe(dir, null, process.env, { probes: !args.includes('--no-probes') }), null, 2) + '\n');
}
