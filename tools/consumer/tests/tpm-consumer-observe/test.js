#!/usr/bin/env node
/**
 * test.js — tpm-consumer-observe.js: observe() (design §2.1–§2.6), canonical selection (§3), preconditions (§4.2),
 * the layer-5 stamp guard (N8), probe memoization (N6) and tolerance of malformed input (N9). One fixture per
 * documented layer value (§13.1). Hermetic: the stateful fake `claude` + a fake `npm` are first on PATH and an
 * env-leak sentinel proves the real ones are unreachable.
 *
 * Usage: node tools/consumer/tests/tpm-consumer-observe/test.js   → exit 0 all pass, 1 otherwise.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const O = require('../../tpm-consumer-observe');
const V = require('../../tpm-consumer-voice');
const F = require('../lib-observe-world');

let pass = 0; let fail = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ✓ ${name}\n`); pass += 1; }
  catch (e) { process.stdout.write(`  ✗ ${name}\n      ${e.stack.split('\n').slice(0, 3).join('\n      ')}\n`); fail += 1; }
}
process.stdout.write('tpm-consumer-observe.test.js\n');

const MARKET = 'claude-tpm-market-0.2.0-dev';
const ID = `claude-tpm@${MARKET}`;
const mrow = (p, over) => [Object.assign({ name: MARKET, source: 'directory', path: p }, over || {})];
const rec = (dir, over) => Object.assign({ id: ID, scope: 'project', enabled: true, installPath: dir, projectPath: dir, version: '0.0.0' }, over || {});
/** Observe `proj` from installer folder `b` inside world `w`. */
function obs(proj, b, w, opts) { return O.observe(proj, b, w.env, opts); }
/** A fully healthy project: linked to b, registered, enabled, marker+config. */
function healthy(over) {
  const b = F.standalone(); const proj = F.project({ marker: 'config-valid', settings: { enabledPlugins: { [ID]: true } } });
  F.nm(proj, b);
  const w = F.world(Object.assign({ marketplaces: mrow(b), records: [rec(proj, { installPath: b })] }, over || {}));
  F.assertHermetic(w);
  return { b, proj, w };
}

// ── sentinel ─────────────────────────────────────────────────────────────────────────────────────────
check('sentinel: the first claude + npm on PATH are the fakes (no real binary reachable)', () => { F.assertHermetic(F.world()); });
check('sentinel: planted leak is detected (PATH without the fakes fails the guard)', () => {
  const w = F.world(); w.env.PATH = path.dirname(process.execPath);
  assert.throws(() => F.assertHermetic(w), /env leak/);
});

// ── path helpers ─────────────────────────────────────────────────────────────────────────────────────
check('insideNodeModules: owner project, null outside, last node_modules wins', () => {
  assert.deepStrictEqual(O.insideNodeModules('/a/proj/node_modules/@codercowboy/claude-tpm'), { projectDir: '/a/proj', folder: '/a/proj/node_modules/@codercowboy/claude-tpm' });
  assert.strictEqual(O.insideNodeModules('/a/b/claude-tpm'), null);
  assert.strictEqual(O.insideNodeModules('/a/node_modules/x/node_modules/y').projectDir, '/a/node_modules/x');
  assert.strictEqual(O.insideNodeModules(null), null);
});
check('realOrResolved: resolves symlinks; falls back to resolve() for a missing path', () => {
  const b = F.standalone(); const l = path.join(F.mk('tpm-obs-l'), 'lnk'); fs.symlinkSync(b, l);
  assert.strictEqual(O.realOrResolved(l), b);
  assert.strictEqual(O.realOrResolved('/no/such/dir/x'), '/no/such/dir/x');
});
check('findBundleRoot: walks up to the @codercowboy/claude-tpm package.json; null when none', () => {
  const b = F.standalone(); fs.mkdirSync(path.join(b, 'tools', 'consumer'), { recursive: true });
  assert.strictEqual(O.findBundleRoot(path.join(b, 'tools', 'consumer')), b);
  assert.strictEqual(O.findBundleRoot(F.mk('tpm-obs-none')), null);
});
check('readBundleIdentity: reads names from the manifest; falls back (with err) when unreadable', () => {
  assert.deepStrictEqual(O.readBundleIdentity(F.standalone()), { marketplace: MARKET, plugin: 'claude-tpm' });
  const g = O.readBundleIdentity(F.standalone({ manifest: 'garbage' })); assert.strictEqual(g.marketplace, 'claude-tpm-market'); assert.ok(g.err);
  assert.ok(O.readBundleIdentity(null).err);
});
check('stampCheck: name must equal claude-tpm-market-<version>', () => {
  assert.strictEqual(O.stampCheck('0.2.0', 'claude-tpm-market-0.2.0').ok, true);
  const bad = O.stampCheck('0.2.0', 'claude-tpm-market-0.1.0'); assert.strictEqual(bad.ok, false); assert.strictEqual(bad.expected, 'claude-tpm-market-0.2.0');
  assert.strictEqual(O.stampCheck(null, 'whatever').ok, true);
});
check('claudeConfigDir: honours CLAUDE_CONFIG_DIR, else <HOME>/.claude', () => {
  assert.strictEqual(O.claudeConfigDir({ CLAUDE_CONFIG_DIR: '/c' }), '/c');
  assert.strictEqual(O.claudeConfigDir({ HOME: '/h' }), path.join('/h', '.claude'));
});
check('versionFromPluginId: version-scoped id → version; bare 0.1.0 id → 0.1.0; other → null', () => {
  assert.strictEqual(O.versionFromPluginId('claude-tpm@claude-tpm-market-0.2.0'), '0.2.0');
  assert.strictEqual(O.versionFromPluginId('claude-tpm@claude-tpm-market'), '0.1.0');
  assert.strictEqual(O.versionFromPluginId('foo@bar'), null);
});

// ── layer 1: dep ─────────────────────────────────────────────────────────────────────────────────────
check('L1 absent: no node_modules, nothing declared → onDisk absent, mode none, declared null', () => {
  const b = F.standalone(); const p = F.project({ pkg: null }); const s = obs(p, b, F.world());
  assert.deepStrictEqual([s.dep.declared, s.dep.onDisk, s.dep.mode, s.dep.version], [null, 'absent', 'none', null]);
});
check('L1 declared in each bucket (dependencies / devDependencies / optionalDependencies)', () => {
  const b = F.standalone();
  for (const bucket of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const s = obs(F.project({ pkg: { bucket, spec: 'file:../q' } }), b, F.world());
    assert.deepStrictEqual(s.dep.declared, { bucket, spec: 'file:../q' });
  }
});
check('L1 link → resolves to realpath, version read through the link, mode linked', () => {
  const b = F.standalone({ version: '0.2.0-dev' }); const p = F.project(); F.nm(p, b); const s = obs(p, b, F.world());
  assert.strictEqual(s.dep.onDisk, 'link'); assert.strictEqual(s.dep.linksTo, b); assert.strictEqual(s.dep.version, '0.2.0-dev'); assert.strictEqual(s.dep.mode, 'linked');
});
check('L1 dangling → link to a deleted folder: onDisk dangling, version null, mode linked', () => {
  const b = F.standalone(); const gone = F.standalone(); const p = F.project(); F.nm(p, gone); fs.rmSync(gone, { recursive: true });
  const s = obs(p, b, F.world());
  assert.deepStrictEqual([s.dep.onDisk, s.dep.version, s.dep.mode, s.dep.linksTo], ['dangling', null, 'linked', null]);
});
check('L1 copy → real directory: onDisk copy, its version, mode vendored', () => {
  const b = F.standalone(); const p = F.project(); F.nm(p, null, { version: '0.1.0' }); const s = obs(p, b, F.world());
  assert.deepStrictEqual([s.dep.onDisk, s.dep.version, s.dep.mode], ['copy', '0.1.0', 'vendored']);
});
check('L1 a plain file where the folder should be → recorded invalid, onDisk absent', () => {
  const b = F.standalone(); const p = F.project(); const sc = path.join(p, 'node_modules', '@codercowboy'); fs.mkdirSync(sc, { recursive: true });
  fs.writeFileSync(path.join(sc, 'claude-tpm'), 'x'); const s = obs(p, b, F.world());
  assert.strictEqual(s.dep.onDisk, 'absent'); assert.ok(s.invalid.some((i) => i.layer === 'dep'));
});

// ── layer 2: registration ────────────────────────────────────────────────────────────────────────────
check('L2 absent: nothing registered under our name (a row under another name is ignored)', () => {
  const b = F.standalone(); const w = F.world({ marketplaces: [{ name: 'other-market', source: 'directory', path: b }] });
  assert.strictEqual(obs(F.project(), b, w).reg.state, 'absent');
});
check('L2 same: stored path is the real installer folder', () => {
  const b = F.standalone(); const s = obs(F.project(), b, F.world({ marketplaces: mrow(b) }));
  assert.strictEqual(s.reg.state, 'same'); assert.strictEqual(s.reg.realPath, b); assert.strictEqual(s.reg.version, '0.2.0-dev'); assert.strictEqual(s.reg.complete, true);
});
check('L2 same-via-link: stored through a symlink that resolves to the installer folder', () => {
  const b = F.standalone(); const l = path.join(F.mk('tpm-obs-viaL'), 'viaLink'); fs.symlinkSync(b, l);
  const s = obs(F.project(), b, F.world({ marketplaces: mrow(l) }));
  assert.strictEqual(s.reg.state, 'same-via-link'); assert.strictEqual(s.reg.storedPath, l); assert.strictEqual(s.reg.realPath, b);
});
check('L2 dead: directory source whose folder is gone (and a directory row with no path)', () => {
  const b = F.standalone(); const gone = F.standalone(); fs.rmSync(gone, { recursive: true });
  const s = obs(F.project(), b, F.world({ marketplaces: mrow(gone) }));
  assert.strictEqual(s.reg.state, 'dead'); assert.strictEqual(s.reg.live, false); assert.strictEqual(s.reg.storedPath, gone);
  assert.strictEqual(obs(F.project(), b, F.world({ marketplaces: [{ name: MARKET, source: 'directory' }] })).reg.state, 'dead');
});
check('L2 elsewhere/standalone: live row at a different standalone folder', () => {
  const b = F.standalone(); const o = F.standalone(); const s = obs(F.project(), b, F.world({ marketplaces: mrow(o) }));
  assert.deepStrictEqual([s.reg.state, s.reg.where, s.reg.realPath, s.reg.projectDir], ['elsewhere', 'standalone', o, null]);
});
check('L2 elsewhere/other-project-copy: live row inside another project\'s node_modules', () => {
  const b = F.standalone(); const pb = F.project(); const copy = F.nm(pb, null); const s = obs(F.project(), b, F.world({ marketplaces: mrow(copy) }));
  assert.strictEqual(s.reg.state, 'elsewhere'); assert.strictEqual(s.reg.where, 'other-project-copy'); assert.strictEqual(s.reg.projectDir, F.real(pb));
});
check('L2 elsewhere/this-project-copy: live row inside THIS project\'s node_modules (installer is standalone)', () => {
  const b = F.standalone(); const p = F.project(); const copy = F.nm(p, null); const s = obs(p, b, F.world({ marketplaces: mrow(copy) }));
  assert.strictEqual(s.reg.where, 'this-project-copy'); assert.strictEqual(s.reg.projectDir, p);
});
check('L2 github: a non-directory source', () => {
  const b = F.standalone(); const s = obs(F.project(), b, F.world({ marketplaces: [{ name: MARKET, source: 'github', repo: 'codercowboy/claude-tpm' }] }));
  assert.deepStrictEqual([s.reg.state, s.reg.where, s.reg.live], ['github', 'github', true]);
});
check('L2 unknown: marketplace probe fails (claude errors) → state unknown, not a throw', () => {
  const b = F.standalone(); const w = F.world({ env: { FAKE_CLAUDE_FAIL: 'plugin marketplace list' } });
  const s = obs(F.project(), b, w); assert.strictEqual(s.reg.state, 'unknown');
});

// ── layer 3: enablement ──────────────────────────────────────────────────────────────────────────────
check('L3 record present+enabled: installPath existence is read', () => {
  const b = F.standalone(); const p = F.project(); const s = obs(p, b, F.world({ records: [rec(p, { installPath: b })] }));
  assert.deepStrictEqual(s.en.record, { present: true, enabled: true, installPath: b, installPathExists: true });
});
check('L3 record present but disabled', () => {
  const b = F.standalone(); const p = F.project(); const s = obs(p, b, F.world({ records: [rec(p, { enabled: false, installPath: b })] }));
  assert.strictEqual(s.en.record.enabled, false);
});
check('L3 record whose installPath is gone → installPathExists false', () => {
  const b = F.standalone(); const p = F.project(); const s = obs(p, b, F.world({ records: [rec(p, { installPath: path.join(b, 'gone') })] }));
  assert.strictEqual(s.en.record.installPathExists, false);
});
check('L3 record absent; user/local-scope records and other projects\' records are ignored', () => {
  const b = F.standalone(); const p = F.project(); const other = F.project();
  const s = obs(p, b, F.world({ records: [rec(p, { scope: 'user' }), rec(p, { scope: 'local' }), rec(other)] }));
  assert.deepStrictEqual(s.en.record, { present: false });
});
check('L3 enabledHere: settings.json true; settings.local.json overrides it', () => {
  const b = F.standalone(); const w = F.world();
  assert.strictEqual(obs(F.project({ settings: { enabledPlugins: { [ID]: true } } }), b, w).en.enabledHere, true);
  assert.strictEqual(obs(F.project({ settings: { enabledPlugins: { [ID]: true } }, local: { enabledPlugins: { [ID]: false } } }), b, w).en.enabledHere, false);
  assert.strictEqual(obs(F.project({ local: { enabledPlugins: { [ID]: true } } }), b, w).en.enabledHere, true);
  assert.strictEqual(obs(F.project(), b, w).en.enabledHere, false);
});
check('L3 loadsWithoutRecord = enabledHere && no record && reg LIVE (S11: dead source → false)', () => {
  const b = F.standalone(); const gone = F.standalone(); fs.rmSync(gone, { recursive: true });
  const proj = () => F.project({ settings: { enabledPlugins: { [ID]: true } } });
  assert.strictEqual(obs(proj(), b, F.world({ marketplaces: mrow(b) })).en.loadsWithoutRecord, true);
  assert.strictEqual(obs(proj(), b, F.world({ marketplaces: mrow(gone) })).en.loadsWithoutRecord, false);
  assert.strictEqual(obs(proj(), b, F.world()).en.loadsWithoutRecord, false);
  const p2 = proj(); assert.strictEqual(obs(p2, b, F.world({ marketplaces: mrow(b), records: [rec(p2, { installPath: b })] })).en.loadsWithoutRecord, false);
});
check('L3 otherIds: other claude-tpm@* enabled ids in settings-file order, with versions; disabled/foreign ignored', () => {
  const b = F.standalone();
  const p = F.project({ settings: { enabledPlugins: { 'claude-tpm@claude-tpm-market': true, 'zzz@x': true, 'claude-tpm@claude-tpm-market-0.1.5': false, [ID]: true } },
    local: { enabledPlugins: { 'claude-tpm@claude-tpm-market-0.3.0': true } } });
  const s = obs(p, b, F.world());
  assert.deepStrictEqual(s.en.otherIds, ['claude-tpm@claude-tpm-market', 'claude-tpm@claude-tpm-market-0.3.0']);
  assert.deepStrictEqual(s.en.otherVersions.map((o) => o.version), ['0.1.0', '0.3.0']);
  assert.strictEqual(s.projectVersion, '0.1.0'); // §2.7: dep.version null → first other id's version
});
check('L3 otherIds also picks up an enabled project record the settings are silent about', () => {
  const b = F.standalone(); const p = F.project();
  const s = obs(p, b, F.world({ records: [rec(p, { id: 'claude-tpm@claude-tpm-market-0.1.9', installPath: b })] }));
  assert.deepStrictEqual(s.en.otherIds, ['claude-tpm@claude-tpm-market-0.1.9']);
});
check('L3 extraKnownMarketplaces (0.1.0-era block) reported only', () => {
  const b = F.standalone();
  const s = obs(F.project({ settings: { extraKnownMarketplaces: { 'claude-tpm-market': {}, unrelated: {} } } }), b, F.world());
  assert.deepStrictEqual(s.en.extraKnownMarketplaces, { present: true, names: ['claude-tpm-market'] });
  assert.strictEqual(obs(F.project(), b, F.world()).en.extraKnownMarketplaces.present, false);
});
check('projectVersion: dep.version wins over other ids; null when neither', () => {
  const b = F.standalone(); const p = F.project({ settings: { enabledPlugins: { 'claude-tpm@claude-tpm-market': true } } }); F.nm(p, null, { version: '0.1.5' });
  assert.strictEqual(obs(p, b, F.world()).projectVersion, '0.1.5');
  assert.strictEqual(obs(F.project(), b, F.world()).projectVersion, null);
});

// ── layer 4: marker ──────────────────────────────────────────────────────────────────────────────────
check('L4 marker: dir missing / dir without config / valid config / invalid config (+err)', () => {
  const b = F.standalone(); const w = F.world();
  assert.deepStrictEqual(obs(F.project(), b, w).marker, { dir: false, config: 'absent', err: null });
  assert.deepStrictEqual(obs(F.project({ marker: true }), b, w).marker, { dir: true, config: 'absent', err: null });
  assert.deepStrictEqual(obs(F.project({ marker: 'config-valid' }), b, w).marker, { dir: true, config: 'valid', err: null });
  const bad = obs(F.project({ marker: 'config-bad' }), b, w); assert.strictEqual(bad.marker.config, 'invalid'); assert.ok(bad.marker.err);
});

// ── layer 5: self ────────────────────────────────────────────────────────────────────────────────────
check('L5 standalone shape: version, name, id, stamp ok, complete', () => {
  const b = F.standalone(); const s = obs(F.project(), b, F.world());
  assert.deepStrictEqual([s.self.root, s.self.version, s.self.name, s.self.id, s.self.shape, s.self.stampOk, s.self.complete],
    [b, '0.2.0-dev', MARKET, ID, 'standalone', true, true]);
});
check('L5 shape this-project-copy: installer lives in <target>/node_modules', () => {
  const p = F.project(); const copy = F.nm(p, null); const s = obs(p, copy, F.world());
  assert.strictEqual(s.self.shape, 'this-project-copy'); assert.strictEqual(s.self.root, copy); assert.strictEqual(s.self.ownerProject, p);
});
check('L5 shape other-project-copy: installer lives in another project\'s node_modules', () => {
  const pb = F.project(); const copy = F.nm(pb, null); const s = obs(F.project(), copy, F.world());
  assert.strictEqual(s.self.shape, 'other-project-copy'); assert.strictEqual(s.self.ownerProject, pb);
});
check('L5 invoked THROUGH a node_modules symlink → realpath\'d to the standalone folder (shape standalone)', () => {
  const b = F.standalone(); const p = F.project(); const lnk = F.nm(p, b); const s = obs(p, lnk, F.world());
  assert.strictEqual(s.self.root, b); assert.strictEqual(s.self.shape, 'standalone');
});
check('L5 stamp guard: hand-bumped version (name disagrees) → stampOk false, expectedName given', () => {
  const b = F.standalone({ version: '0.2.0', name: 'claude-tpm-market-0.1.0' }); const s = obs(F.project(), b, F.world());
  assert.strictEqual(s.self.stampOk, false); assert.strictEqual(s.self.expectedName, 'claude-tpm-market-0.2.0');
});
check('L5 complete: false for missing hooks.json / garbage / lacking session-start / lacking gate-spawn', () => {
  const w = F.world();
  const cases = [[{ hooks: false }, false, null], [{ hooks: 'garbage' }, true, true],
    [{ hooks: { hooks: HOOK1('PreToolUse', 'gate-spawn') } }, true, false], [{ hooks: { hooks: HOOK1('SessionStart', 'session-start') } }, true, false]];
  for (const [o, present, hasErr] of cases) {
    const s = obs(F.project(), F.standalone(o), w);
    assert.strictEqual(s.self.complete, false); assert.strictEqual(s.self.hooks.present, present);
    if (hasErr !== null) assert.strictEqual(!!s.self.hooks.err, hasErr);
  }
});
function HOOK1(e, n) { return F.HOOK(e, n); }

// ── environment ──────────────────────────────────────────────────────────────────────────────────────
check('env: claude + npm found via the fakes; inSession false; claudeConfigDir honours override', () => {
  const w = F.world(); const s = obs(F.project(), F.standalone(), w);
  assert.deepStrictEqual([s.env.claudeOnPath, s.env.npmOnPath, s.env.inSession], [true, true, false]);
  assert.strictEqual(s.env.claudeConfigDir, w.env.CLAUDE_CONFIG_DIR);
});
check('env: inSession when TPM_PROJECT_ROOT or TPM_HOME is set; tpmHome + tpmOnPath (realpath) reported', () => {
  const w = F.world({ env: { TPM_HOME: '/some/home' } });
  const d = F.mk('tpm-obs-tpmbin'); fs.writeFileSync(path.join(d, 'tpm'), '#!/bin/sh\n'); fs.chmodSync(path.join(d, 'tpm'), 0o755);
  w.env.PATH = d + path.delimiter + w.env.PATH;
  const s = obs(F.project(), F.standalone(), w);
  assert.strictEqual(s.env.inSession, true); assert.strictEqual(s.env.tpmHome, '/some/home'); assert.strictEqual(s.env.tpmOnPath, path.join(d, 'tpm'));
});
check('env: claude absent from PATH → claudeOnPath false, layers 2/3 unknown, no throw (N9)', () => {
  const w = F.world({ noClaude: true }); const s = obs(F.project(), F.standalone(), w);
  assert.strictEqual(s.env.claudeOnPath, false); assert.strictEqual(s.reg.state, 'unknown'); assert.strictEqual(s.en.record, 'unknown');
  assert.strictEqual(s.en.loadsWithoutRecord, null); assert.strictEqual(s.probes.count, 1); // only --version attempted
});
check('env: claude --version fails (exit 1) → claudeOnPath false with reason; list probes never run', () => {
  const w = F.world({ env: { FAKE_CLAUDE_FAIL: '--version' } }); const s = obs(F.project(), F.standalone(), w);
  assert.strictEqual(s.env.claudeOnPath, false); assert.ok(/exited 1/.test(s.env.claudeError)); assert.deepStrictEqual(w.claudeCalls(), ['--version']);
});

// ── canonical (§3 step A) ────────────────────────────────────────────────────────────────────────────
check('canonical: standalone → self.root, linked', () => {
  const b = F.standalone(); assert.deepStrictEqual(obs(F.project(), b, F.world()).canonical, { root: b, mode: 'linked', refuse: null, owner: null });
});
check('canonical: this-project-copy → self.root, vendored', () => {
  const p = F.project(); const c = F.nm(p, null); assert.deepStrictEqual(obs(p, c, F.world()).canonical, { root: c, mode: 'vendored', refuse: null, owner: null });
});
check('canonical: other-project-copy → refuse, names the owning project', () => {
  const pb = F.project(); const c = F.nm(pb, null); const s = obs(F.project(), c, F.world());
  assert.deepStrictEqual(s.canonical, { root: null, mode: null, refuse: 'other-project-copy', owner: pb });
});

// ── preconditions (§4.2) ─────────────────────────────────────────────────────────────────────────────
function refusalOf(state, o) { const r = O.preconditions(state, o); return r && { r, text: V.refusal(r, state) }; }
check('preconditions: healthy world → null (and quiet/TTY combos)', () => {
  const { b, proj, w } = healthy(); const s = obs(proj, b, w);
  assert.strictEqual(O.preconditions(s, { quiet: false, stdinIsTTY: true }), null);
  assert.strictEqual(O.preconditions(s, { quiet: true, stdinIsTTY: false }), null);
});
check('precondition 1: npm missing → refuse, exit 1, message names npm + Nothing was changed.', () => {
  const w = F.world({ noClaude: true }); w.env.PATH = path.dirname(process.execPath); // node dir has real npm? force failure via exec
  const s = O.observe(F.project(), F.standalone(), w.env, { exec: (bin) => (bin === 'npm' ? { error: { code: 'ENOENT' }, status: null } : { status: 0, stdout: '1\n' }) });
  const { r, text } = refusalOf(s);
  assert.strictEqual(r.id, 'tool-missing'); assert.strictEqual(r.exit, 1); assert.strictEqual(r.detail.bin, 'npm');
  assert.ok(/^error: not installing — `npm` not found on PATH/.test(text), text); assert.ok(/\n {2}Nothing was changed\.\n$/.test(text));
});
check('precondition 1: claude missing → refuse naming claude with the install hint', () => {
  const { r, text } = refusalOf(obs(F.project(), F.standalone(), F.world({ noClaude: true })));
  assert.strictEqual(r.id, 'tool-missing'); assert.strictEqual(r.detail.bin, 'claude'); assert.strictEqual(r.exit, 1);
  assert.ok(/`claude` not found on PATH — install Claude Code first/.test(text), text);
  assert.ok(/^error: not installing — /.test(text));
  const w = F.world({ env: { FAKE_CLAUDE_FAIL: '--version' } }); const x = refusalOf(obs(F.project(), F.standalone(), w));
  assert.strictEqual(x.r.detail.bin, 'claude'); assert.ok(/exited 1/.test(x.text), x.text);
});
check('precondition 2: no package.json → refuse; invalid JSON → refuse with the parse error; missing target dir too', () => {
  const b = F.standalone(); const w = F.world();
  const a = refusalOf(obs(F.project({ pkg: false }), b, w)); assert.strictEqual(a.r.id, 'no-package-json'); assert.ok(/npm init -y/.test(a.text));
  const g = refusalOf(obs(F.project({ pkg: 'garbage' }), b, w)); assert.strictEqual(g.r.id, 'bad-package-json'); assert.ok(/not valid JSON/.test(g.text));
  assert.strictEqual(refusalOf(obs(path.join(F.mk('tpm-obs-x'), 'nope'), b, w)).r.id, 'no-package-json');
});
check('precondition 3 (N8): stamp guard refuses and blames claude-tpm, not the project', () => {
  const b = F.standalone({ version: '0.2.0', name: 'claude-tpm-market-0.1.0' });
  const x = refusalOf(obs(F.project(), b, F.world()));
  assert.strictEqual(x.r.id, 'stamp'); assert.strictEqual(x.r.exit, 1); const one = x.text.replace(/\s+/g, ' '); // voice wraps at 100 cols
  assert.ok(/mislabelled/.test(one) && /packaging problem in claude-tpm, not in your project/.test(one), x.text);
});
check('precondition 4: other-project-copy → refuse with the Run-the-install hint', () => {
  const pb = F.project(); const c = F.nm(pb, null); const x = refusalOf(obs(F.project(), c, F.world()));
  assert.strictEqual(x.r.id, 'other-project-copy'); assert.ok(/Run the install from a standalone folder/.test(x.text), x.text);
});
check('precondition 5: incomplete claude-tpm folder (no hooks.json) → refuse naming hooks/hooks.json', () => {
  const x = refusalOf(obs(F.project(), F.standalone({ hooks: false }), F.world()));
  assert.strictEqual(x.r.id, 'incomplete'); assert.ok(/missing hooks\/hooks\.json/.test(x.text), x.text);
});
check('precondition 6: non-TTY without --quiet → refuse with the --quiet hint; --quiet passes; TTY passes', () => {
  const b = F.standalone(); const p = F.project(); const s = obs(p, b, F.world());
  const x = refusalOf(s, { quiet: false, stdinIsTTY: false });
  assert.strictEqual(x.r.id, 'non-tty'); assert.ok(/stdin is not a terminal — pass `--quiet`/.test(x.text), x.text);
  assert.strictEqual(O.preconditions(s, { quiet: true, stdinIsTTY: false }), null);
  assert.strictEqual(O.preconditions(s, { quiet: false, stdinIsTTY: true }), null);
});
check('preconditions are ordered: missing package.json beats a bad stamp beats TTY', () => {
  const b = F.standalone({ version: '0.2.0', name: 'claude-tpm-market-0.1.0' });
  assert.strictEqual(O.preconditions(obs(F.project({ pkg: false }), b, F.world()), { stdinIsTTY: false }).id, 'no-package-json');
  assert.strictEqual(O.preconditions(obs(F.project(), b, F.world()), { stdinIsTTY: false }).id, 'stamp');
});
check('every refusal id preconditions can return renders through voice with exit 1 + Nothing was changed.', () => {
  const ids = new Set();
  const cases = [obs(F.project({ pkg: false }), F.standalone(), F.world()), obs(F.project({ pkg: 'garbage' }), F.standalone(), F.world()),
    obs(F.project(), F.standalone({ version: '0.2.0', name: 'x' }), F.world()), obs(F.project(), F.standalone({ hooks: false }), F.world()),
    obs(F.project(), F.nm(F.project(), null), F.world()), obs(F.project(), F.standalone(), F.world({ noClaude: true }))];
  cases.forEach((s) => { const x = refusalOf(s, { stdinIsTTY: true }); assert.ok(x, 'expected a refusal'); ids.add(x.r.id); assert.strictEqual(x.r.exit, 1); assert.ok(x.text.endsWith('  Nothing was changed.\n')); });
  assert.ok(ids.size >= 6, [...ids].join());
});

// ── probe memoization (N6) ───────────────────────────────────────────────────────────────────────────
check('N6: a healthy observe makes exactly 3 claude calls (--version, marketplace list, plugin list), each once', () => {
  const { b, proj, w } = healthy(); const s = obs(proj, b, w);
  assert.strictEqual(w.calls().length, 3, JSON.stringify(w.claudeCalls()));
  assert.deepStrictEqual(w.claudeCalls().sort(), ['--version', 'plugin list --json', 'plugin marketplace list --json']);
  assert.strictEqual(s.probes.count, 3); assert.ok(s.probes.count <= 3);
  assert.strictEqual(s.reg.state, 'same'); assert.strictEqual(s.en.record.present, true); // and it really is healthy
});
check('N6: probes run with cwd = the target project (enablement is cwd-relative)', () => {
  const { b, proj, w } = healthy(); obs(proj, b, w);
  w.calls().filter((c) => c.argv[0] === 'plugin').forEach((c) => assert.strictEqual(fs.realpathSync(c.cwd), proj));
});
check('N6: reobserveLayer(registration) re-runs ONLY marketplace list; enablement ONLY plugin list; dep/marker/self none', () => {
  const { b, proj, w } = healthy(); let s = obs(proj, b, w);
  const n0 = w.calls().length;
  s = O.reobserveLayer(s, 'registration'); assert.deepStrictEqual(w.claudeCalls().slice(n0), ['plugin marketplace list --json']); assert.strictEqual(s.probes.count, 4);
  const n1 = w.calls().length;
  s = O.reobserveLayer(s, 'enablement'); assert.deepStrictEqual(w.claudeCalls().slice(n1), ['plugin list --json']); assert.strictEqual(s.probes.count, 5);
  const n2 = w.calls().length;
  ['dep', 'marker', 'self'].forEach((l) => { s = O.reobserveLayer(s, l); });
  assert.strictEqual(w.calls().length, n2); assert.strictEqual(s.probes.count, 5);
});
check('N6: reobserveLayer sees the change an action made (registration: absent → same after fake `marketplace add`)', () => {
  const b = F.standalone(); const p = F.project(); const w = F.world(); let s = obs(p, b, w);
  assert.strictEqual(s.reg.state, 'absent');
  assert.strictEqual(spawnSync(w.shimPath, ['plugin', 'marketplace', 'add', b], { env: w.env, cwd: p }).status, 0);
  const s2 = O.reobserveLayer(s, 'registration');
  assert.strictEqual(s2.reg.state, 'same'); assert.strictEqual(s.reg.state, 'absent'); // old state untouched
  // the other layers are carried over verbatim (not re-read)
  assert.strictEqual(s2.dep, s.dep); assert.strictEqual(s2.marker, s.marker);
});
check('N6: reobserveLayer(dep) notices a new link on disk, no claude call; derived fields recomputed', () => {
  const b = F.standalone(); const p = F.project(); const w = F.world({ marketplaces: mrow(b) }); const s = obs(p, b, w);
  assert.strictEqual(s.dep.onDisk, 'absent'); F.nm(p, b);
  const n = w.calls().length; const s2 = O.reobserveLayer(s, 'dep');
  assert.strictEqual(s2.dep.onDisk, 'link'); assert.strictEqual(s2.projectVersion, '0.2.0-dev'); assert.strictEqual(w.calls().length, n);
});
check('N6: reobserveLayer(enablement) after the fake installs the plugin → record present + enabledHere', () => {
  const b = F.standalone(); const p = F.project(); const w = F.world({ marketplaces: mrow(b) }); const s = obs(p, b, w);
  assert.deepStrictEqual(s.en.record, { present: false });
  assert.strictEqual(spawnSync(w.shimPath, ['plugin', 'install', ID, '--scope', 'project'], { env: w.env, cwd: p }).status, 0);
  const s2 = O.reobserveLayer(s, 'enablement'); assert.strictEqual(s2.en.record.present, true); assert.strictEqual(s2.en.enabledHere, true);
});
check('reobserveLayer: unknown layer is recorded invalid, never thrown', () => {
  const { b, proj, w } = healthy(); const s = O.reobserveLayer(obs(proj, b, w), 'nonsense');
  assert.ok(s.invalid.some((i) => i.layer === 'nonsense'));
});

// ── light mode ───────────────────────────────────────────────────────────────────────────────────────
check('light mode (probes:false): ZERO processes spawned; layers 2/3 record unknown; file layers still read', () => {
  const { b, proj, w } = healthy(); const s = obs(proj, b, w, { probes: false });
  assert.strictEqual(w.calls().length, 0); assert.strictEqual(s.probes.count, 0); assert.strictEqual(s.mode, 'light');
  assert.strictEqual(s.reg.state, 'unknown'); assert.strictEqual(s.en.record, 'unknown'); assert.strictEqual(s.env.claudeOnPath, null);
  assert.strictEqual(s.dep.onDisk, 'link'); assert.strictEqual(s.en.enabledHere, true); assert.strictEqual(s.marker.config, 'valid');
  assert.strictEqual(O.preconditions(s, { quiet: true }), null); // tool checks skipped when nothing was probed
});
check('light mode fills layer 2 from CLAUDE_PLUGIN_ROOT (the running plugin is live by definition)', () => {
  const { b, proj, w } = healthy(); w.env.CLAUDE_PLUGIN_ROOT = b;
  const s = obs(proj, b, w, { probes: false });
  assert.deepStrictEqual([s.reg.live, s.reg.realPath, s.reg.version, s.reg.complete], [true, b, '0.2.0-dev', true]);
});

// ── tolerance (N9) ───────────────────────────────────────────────────────────────────────────────────
check('N9: garbage everywhere (package.json, settings, local, config, hooks.json, manifest) → no throw, invalid[] filled', () => {
  const b = F.standalone({ hooks: 'garbage', manifest: 'garbage' });
  const p = F.project({ pkg: 'garbage', marker: 'config-bad', settings: '{{', local: '[[' }); F.nm(p, b);
  const s = obs(p, b, F.world());
  const layers = new Set(s.invalid.map((i) => i.layer));
  ['dep', 'marker', 'enablement'].forEach((l) => assert.ok(layers.has(l), `no invalid for ${l}: ${JSON.stringify(s.invalid)}`));
  assert.strictEqual(s.self.complete, false); assert.ok(s.self.err); assert.strictEqual(s.target.pkg.valid, false);
  JSON.stringify(s); // plain JSON all the way down
});
check('N9: plugin list returns junk (non-array JSON / text / error) → record unknown, observe survives', () => {
  const b = F.standalone(); const p = F.project();
  const w1 = F.world({ env: { FAKE_CLAUDE_FAIL: 'plugin list' } }); assert.strictEqual(obs(p, b, w1).en.record, 'unknown');
  const w2 = F.world(); fs.writeFileSync(w2.statePath, JSON.stringify({ marketplaces: {}, records: { not: 'an array' } }));
  const s2 = obs(p, b, w2); assert.strictEqual(s2.reg.state, 'unknown'); assert.ok(s2.warnings.length >= 1);
  const stub = O.observe(p, b, w1.env, { exec: (bin, argv) => ({ status: 0, stdout: argv[0] === '--version' ? '1\n' : 'not json at all' }) });
  assert.strictEqual(stub.en.record, 'unknown'); assert.strictEqual(stub.reg.state, 'unknown');
});
check('N9: exec that throws is contained (probe treated as failed)', () => {
  const s = O.observe(F.project(), F.standalone(), process.env, { exec: () => { throw new Error('boom'); } });
  assert.strictEqual(s.env.claudeOnPath, false);
});
check('N9: nonexistent target dir and an unlocatable installer folder do not throw', () => {
  const s = O.observe(path.join(F.mk('tpm-obs-x'), 'ghost'), F.mk('tpm-obs-notabundle'), F.world().env);
  assert.strictEqual(s.target.exists, false);
  const t = O.observe(F.project(), '/definitely/not/a/folder', F.world().env); assert.strictEqual(t.self.complete, false);
});
check('observe() output is JSON-serialisable and the internal context is not enumerable', () => {
  const { b, proj, w } = healthy(); const s = obs(proj, b, w);
  assert.ok(!('_ctx' in JSON.parse(JSON.stringify(s)))); assert.ok(JSON.parse(JSON.stringify(s)).reg);
});

// ── the five-layer healthy picture, end to end ───────────────────────────────────────────────────────
check('healthy fixture: all five layers at target', () => {
  const { b, proj, w } = healthy(); const s = obs(proj, b, w);
  assert.strictEqual(s.dep.onDisk, 'link'); assert.strictEqual(s.reg.state, 'same'); assert.ok(s.en.record.present && s.en.record.enabled);
  assert.deepStrictEqual(s.en.otherIds, []); assert.strictEqual(s.marker.config, 'valid'); assert.ok(s.self.complete && s.self.stampOk);
  assert.strictEqual(s.invalid.length, 0); assert.strictEqual(s.canonical.mode, 'linked');
});

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────
check('CLI: `node tpm-consumer-observe.js <dir> --no-probes` prints the State as JSON', () => {
  const { proj } = healthy();
  const r = spawnSync(process.execPath, [path.resolve(__dirname, '..', '..', 'tpm-consumer-observe.js'), proj, '--no-probes'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr); assert.strictEqual(JSON.parse(r.stdout).mode, 'light');
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
