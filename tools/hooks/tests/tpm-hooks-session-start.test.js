#!/usr/bin/env node
/**
 * tpm-hooks-session-start.test.js — behavioral tests for the SessionStart hook
 * (tools/hooks/tpm-hooks-session-start.js), driven both directly and through the router / tpm.js, and
 * for the shipped hooks/hooks.json wiring. Child envs are built from scratch (no inherited
 * TPM_PROJECT_ROOT / TPM_HOME). Temp dirs only.
 *
 * Run: node tools/hooks/tests/tpm-hooks-session-start.test.js   (exit 0 = all green)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOLS = path.resolve(__dirname, '..', '..');
const HOOK = path.join(TOOLS, 'hooks', 'tpm-hooks-session-start.js');
const TPM = path.join(TOOLS, 'tpm.js');
const MANIFEST = path.join(TOOLS, '..', 'hooks', 'hooks.json');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-ss-'));
let n = 0;
const fresh = () => { const d = path.join(TMP, 'c' + (n++)); fs.mkdirSync(d); return d; };

let count = 0;
function check(name, fn) { fn(); count++; process.stdout.write(`  ✓ ${name}\n`); }

// Child env from scratch; `extra` entries with value undefined are omitted.
function runHook(extra, { stdin = '{}', via = 'direct' } = {}) {
  const env = { PATH: process.env.PATH };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  const argv = via === 'tpm' ? [TPM, 'hooks', 'session-start'] : [HOOK];
  return spawnSync('node', argv, { env, input: stdin, encoding: 'utf8' });
}
// Source `envFile` in bash and print the named vars (NUL-separated); returns {name: value|null}.
function sourced(envFile, names, preset = {}) {
  const script = `source "$1"; ` + names.map((x) => `printf '%s\\0' "\${${x}-__UNSET__}"`).join('; ');
  const r = spawnSync('bash', ['-c', script, 'bash', envFile], { env: { PATH: process.env.PATH, ...preset }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const parts = r.stdout.split('\0');
  const out = {};
  names.forEach((x, i) => { out[x] = parts[i] === '__UNSET__' ? null : parts[i]; });
  return out;
}
const read = (f) => fs.readFileSync(f, 'utf8');

process.stdout.write('tpm-hooks-session-start.test.js\n');

check('writes TPM_PROJECT_ROOT from CLAUDE_PROJECT_DIR; sourcing yields exactly the dir', () => {
  const d = fresh(); const envf = path.join(d, 'env.sh'); const proj = path.join(d, 'proj');
  const r = runHook({ CLAUDE_ENV_FILE: envf, CLAUDE_PROJECT_DIR: proj });
  assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, '');
  assert.ok(read(envf).includes(`export TPM_PROJECT_ROOT='${proj}'`));
  assert.strictEqual(sourced(envf, ['TPM_PROJECT_ROOT']).TPM_PROJECT_ROOT, proj);
});

check('TPM_HOME = realpath of CLAUDE_PLUGIN_ROOT (symlink resolved)', () => {
  const d = fresh(); const real = path.join(d, 'real-plugin'); fs.mkdirSync(real);
  const link = path.join(d, 'link-plugin'); fs.symlinkSync(real, link);
  const envf = path.join(d, 'env.sh');
  const r = runHook({ CLAUDE_ENV_FILE: envf, CLAUDE_PLUGIN_ROOT: link });
  assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, '');
  assert.strictEqual(sourced(envf, ['TPM_HOME']).TPM_HOME, fs.realpathSync(real));
  assert.notStrictEqual(fs.realpathSync(real), link);
});

check('both vars written together; works through `tpm hooks session-start` (router + tpm.js)', () => {
  const d = fresh(); const envf = path.join(d, 'env.sh'); const plug = path.join(d, 'p'); fs.mkdirSync(plug);
  const r = runHook({ CLAUDE_ENV_FILE: envf, CLAUDE_PROJECT_DIR: '/x/proj', CLAUDE_PLUGIN_ROOT: plug }, { via: 'tpm' });
  assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, '');
  const v = sourced(envf, ['TPM_PROJECT_ROOT', 'TPM_HOME']);
  assert.strictEqual(v.TPM_PROJECT_ROOT, '/x/proj'); assert.strictEqual(v.TPM_HOME, fs.realpathSync(plug));
});

check('respects existing TPM_PROJECT_ROOT: that line skipped, TPM_HOME still written', () => {
  const d = fresh(); const envf = path.join(d, 'env.sh'); const plug = path.join(d, 'p'); fs.mkdirSync(plug);
  runHook({ CLAUDE_ENV_FILE: envf, CLAUDE_PROJECT_DIR: '/x/proj', CLAUDE_PLUGIN_ROOT: plug, TPM_PROJECT_ROOT: '/override' });
  const t = read(envf);
  assert.ok(!t.includes('TPM_PROJECT_ROOT')); assert.ok(t.includes('export TPM_HOME='));
});

check('respects existing TPM_HOME: that line skipped, TPM_PROJECT_ROOT still written', () => {
  const d = fresh(); const envf = path.join(d, 'env.sh'); const plug = path.join(d, 'p'); fs.mkdirSync(plug);
  runHook({ CLAUDE_ENV_FILE: envf, CLAUDE_PROJECT_DIR: '/x/proj', CLAUDE_PLUGIN_ROOT: plug, TPM_HOME: '/h' });
  const t = read(envf);
  assert.ok(!t.includes('TPM_HOME')); assert.ok(t.includes("export TPM_PROJECT_ROOT='/x/proj'"));
});

check('safe quoting: spaces, single quote, $, backtick round-trip exactly through source', () => {
  const d = fresh(); const envf = path.join(d, 'env.sh');
  const nasty = "/tmp/my proj/it's $HOME `echo hi` \"q\" $(id) \\back";
  const r = runHook({ CLAUDE_ENV_FILE: envf, CLAUDE_PROJECT_DIR: nasty });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(sourced(envf, ['TPM_PROJECT_ROOT']).TPM_PROJECT_ROOT, nasty);
  // TPM_HOME with a nasty real folder name too
  const plug = path.join(d, "pl ug's $x `y`"); fs.mkdirSync(plug);
  const envf2 = path.join(d, 'env2.sh');
  runHook({ CLAUDE_ENV_FILE: envf2, CLAUDE_PLUGIN_ROOT: plug });
  assert.strictEqual(sourced(envf2, ['TPM_HOME']).TPM_HOME, fs.realpathSync(plug));
});

check('idempotent: twice with same inputs -> one set of lines; different value -> appended', () => {
  const d = fresh(); const envf = path.join(d, 'env.sh'); const plug = path.join(d, 'p'); fs.mkdirSync(plug);
  const e = { CLAUDE_ENV_FILE: envf, CLAUDE_PROJECT_DIR: '/a', CLAUDE_PLUGIN_ROOT: plug };
  runHook(e); const once = read(envf); runHook(e);
  assert.strictEqual(read(envf), once);
  assert.strictEqual(once.trim().split('\n').length, 2);
  runHook({ ...e, CLAUDE_PROJECT_DIR: '/b' });
  const lines = read(envf).trim().split('\n');
  assert.strictEqual(lines.length, 3);
  assert.strictEqual(sourced(envf, ['TPM_PROJECT_ROOT']).TPM_PROJECT_ROOT, '/b');
});

check('preserves existing env-file content (and adds a newline if missing)', () => {
  const d = fresh(); const envf = path.join(d, 'env.sh');
  fs.writeFileSync(envf, "export FOO='1'"); // no trailing newline
  runHook({ CLAUDE_ENV_FILE: envf, CLAUDE_PROJECT_DIR: '/a' });
  const v = sourced(envf, ['FOO', 'TPM_PROJECT_ROOT']);
  assert.strictEqual(v.FOO, '1'); assert.strictEqual(v.TPM_PROJECT_ROOT, '/a');
});

check('no CLAUDE_ENV_FILE -> exit 0, no output, nothing created', () => {
  const d = fresh(); const before = fs.readdirSync(d);
  const r = runHook({ CLAUDE_PROJECT_DIR: '/a', CLAUDE_PLUGIN_ROOT: d });
  assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, ''); assert.strictEqual(r.stderr, '');
  assert.deepStrictEqual(fs.readdirSync(d), before);
});

check('missing CLAUDE_PROJECT_DIR skips only that line; missing CLAUDE_PLUGIN_ROOT skips only TPM_HOME', () => {
  const d = fresh(); const plug = path.join(d, 'p'); fs.mkdirSync(plug);
  const a = path.join(d, 'a.sh'); runHook({ CLAUDE_ENV_FILE: a, CLAUDE_PLUGIN_ROOT: plug });
  assert.ok(read(a).includes('TPM_HOME') && !read(a).includes('TPM_PROJECT_ROOT'));
  const b = path.join(d, 'b.sh'); runHook({ CLAUDE_ENV_FILE: b, CLAUDE_PROJECT_DIR: '/a' });
  assert.ok(read(b).includes('TPM_PROJECT_ROOT') && !read(b).includes('TPM_HOME'));
  const c = path.join(d, 'c.sh'); const r = runHook({ CLAUDE_ENV_FILE: c });
  assert.strictEqual(r.status, 0); assert.ok(!fs.existsSync(c));
});

check('nonexistent CLAUDE_PLUGIN_ROOT -> no TPM_HOME line, exit 0', () => {
  const d = fresh(); const envf = path.join(d, 'env.sh');
  const r = runHook({ CLAUDE_ENV_FILE: envf, CLAUDE_PROJECT_DIR: '/a', CLAUDE_PLUGIN_ROOT: path.join(d, 'nope') });
  assert.strictEqual(r.status, 0); assert.ok(!read(envf).includes('TPM_HOME'));
});

check('unwritable env file path -> exit 0, empty stdout', () => {
  const d = fresh();
  const r = runHook({ CLAUDE_ENV_FILE: path.join(d, 'no-such-dir', 'env.sh'), CLAUDE_PROJECT_DIR: '/a' });
  assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, '');
  const asDir = runHook({ CLAUDE_ENV_FILE: d, CLAUDE_PROJECT_DIR: '/a' }); // a directory, not a file
  assert.strictEqual(asDir.status, 0); assert.strictEqual(asDir.stdout, '');
});

check('garbage / empty stdin -> exit 0, empty stdout, still writes', () => {
  for (const stdin of ['not json {{{', '', '\u0000\u0001']) {
    const d = fresh(); const envf = path.join(d, 'env.sh');
    const r = runHook({ CLAUDE_ENV_FILE: envf, CLAUDE_PROJECT_DIR: '/a' }, { stdin });
    assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, '');
    assert.ok(read(envf).includes("TPM_PROJECT_ROOT='/a'"));
  }
});

check('stdout is empty on every success path (stdout may become model context)', () => {
  const d = fresh(); const r = runHook({ CLAUDE_ENV_FILE: path.join(d, 'e.sh'), CLAUDE_PROJECT_DIR: '/a', CLAUDE_PLUGIN_ROOT: d });
  assert.strictEqual(r.stdout, '');
});

check('`tpm hooks --help` lists session-start with a description', () => {
  const r = spawnSync('node', [TPM, 'hooks', '--help'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.ok(/session-start\s+\S.*SessionStart/.test(r.stdout));
  assert.ok(!r.stdout.includes('npx tpm hooks gate-spawn'));
});

check('hooks/hooks.json: parses; SessionStart + gate-spawn use the exact node "${CLAUDE_PLUGIN_ROOT}" form', () => {
  const m = JSON.parse(read(MANIFEST));
  assert.strictEqual(m.hooks.SessionStart[0].hooks[0].type, 'command');
  assert.strictEqual(m.hooks.SessionStart[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/tools/tpm.js" hooks session-start');
  assert.strictEqual(m.hooks.PreToolUse[0].matcher, 'Agent|Task');
  assert.strictEqual(m.hooks.PreToolUse[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/tools/tpm.js" hooks gate-spawn');
});


// ═══ the LIGHT health check (installer-updates phase 03; design §9.1/§9.2, voice §7) ═══════════════════════════
// observe({probes:false}) + V.hookMessage, behind hygiene.healthCheck.enabled (default on). The hook runs from THIS bundle
// (CLAUDE_PLUGIN_ROOT = the bundle root); a sentinel `claude` first on PATH proves the light doctor never spawns one.
const BUNDLE = path.resolve(TOOLS, '..');
const OTHER_ID = { enabledPlugins: { 'claude-tpm@claude-tpm-market': true } }; // 0.1.0's id: "another version is also on"
// A project: marker present unless marker:false; extra files via o.config (config.json text) / o.settings.
function proj(o) {
  o = o || {};
  const d = path.join(fresh(), 'proj'); fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
  if (o.marker !== false) fs.mkdirSync(path.join(d, '.claude', 'claude-tpm'), { recursive: true });
  if (o.config !== undefined) { fs.mkdirSync(path.join(d, '.claude', 'claude-tpm'), { recursive: true }); fs.writeFileSync(path.join(d, '.claude', 'claude-tpm', 'config.json'), typeof o.config === 'string' ? o.config : JSON.stringify(o.config)); }
  if (o.settings) { fs.mkdirSync(path.join(d, '.claude'), { recursive: true }); fs.writeFileSync(path.join(d, '.claude', 'settings.json'), JSON.stringify(o.settings)); }
  return d;
}
// Hook env: a sentinel claude on PATH (logs if ever run), the plugin root = this bundle, an env file.
function hookEnv(d, o) {
  const bin = path.join(fresh(), 'bin'); fs.mkdirSync(bin);
  const log = path.join(bin, 'claude.called');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho called >> "${log}"\nexit 1\n`); fs.chmodSync(path.join(bin, 'claude'), 0o755);
  const envf = path.join(fresh(), 'env.sh');
  return { env: Object.assign({ PATH: bin + path.delimiter + path.dirname(process.execPath), CLAUDE_PROJECT_DIR: d, CLAUDE_PLUGIN_ROOT: BUNDLE, CLAUDE_ENV_FILE: envf }, (o && o.env) || {}), log, envf };
}

check('light doctor · a healthy project -> stdout EMPTY (zero tokens), exit 0, and NO claude spawned', () => {
  const d = proj(); const h = hookEnv(d);
  const r = runHook(h.env);
  assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, ''); assert.strictEqual(r.stderr, '');
  assert.ok(!fs.existsSync(h.log), 'the light doctor never spawns claude');
  assert.ok(read(h.envf).includes(`TPM_PROJECT_ROOT='${d}'`), 'exports still written');
});
check('light doctor · unhealthy -> ONE [claude-tpm] line addressed to Claude, report-only wording, exit 0, exports still written', () => {
  const d = proj({ marker: false }); const h = hookEnv(d);
  const r = runHook(h.env);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.split('\n').filter(Boolean).length, 1, r.stdout);
  assert.ok(/^\[claude-tpm\] 1 problem in this project: \.claude\/claude-tpm\/ is missing/.test(r.stdout), r.stdout);
  assert.ok(/Tell the user/.test(r.stdout) && /Do not edit files to fix this/.test(r.stdout), 'tells Claude to report, not repair');
  assert.ok(!fs.existsSync(path.join(d, '.claude', 'claude-tpm')), 'report-only: nothing created');
  assert.ok(!fs.existsSync(h.log), 'no claude spawned');
  assert.ok(read(h.envf).includes('TPM_PROJECT_ROOT'), 'the env exports are independent of the health check');
});
check('light doctor · at most 3 problems are reported (numbered, one line)', () => {
  const d = proj({ marker: false, settings: OTHER_ID });
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', devDependencies: { '@codercowboy/claude-tpm': 'file:./old' } }));
  const old = path.join(d, 'node_modules', '@codercowboy', 'claude-tpm'); fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'package.json'), JSON.stringify({ name: '@codercowboy/claude-tpm', version: '0.1.0' }));
  const r = runHook(hookEnv(d).env);
  assert.strictEqual(r.status, 0);
  const items = r.stdout.match(/\(\d\) /g) || [];
  assert.ok(items.length >= 2 && items.length <= 3, `1..3 numbered problems: ${r.stdout}`);
  assert.strictEqual(r.stdout.split('\n').filter(Boolean).length, 1);
  assert.ok(/version-skew|npx tpm. runs the old version/.test(r.stdout) || /points at claude-tpm 0\.1\.0/.test(r.stdout), r.stdout);
});
check('light doctor · gate: hygiene.healthCheck.enabled=false -> silent even when unhealthy; true / absent -> reports (default ON, D-2)', () => {
  const off = proj({ marker: false, config: { hygiene: { healthCheck: { enabled: false } } }, settings: OTHER_ID });
  assert.strictEqual(runHook(hookEnv(off).env).stdout, '');
  const on = proj({ config: { hygiene: { healthCheck: { enabled: true } } }, settings: OTHER_ID });
  assert.ok(/^\[claude-tpm\] 1 problem/.test(runHook(hookEnv(on).env).stdout));
  const absent = proj({ config: { tasks: {} }, settings: OTHER_ID });
  assert.ok(/^\[claude-tpm\] 1 problem/.test(runHook(hookEnv(absent).env).stdout));
  const other = proj({ config: { hygiene: { enabled: true } }, settings: OTHER_ID });
  assert.ok(/^\[claude-tpm\] /.test(runHook(hookEnv(other).env).stdout), 'only healthCheck.enabled===false silences it');
});
check('light doctor · an invalid config.json is reported once, in its own words (do not rewrite it without asking); the gate defaults on', () => {
  const d = proj({ config: '{"hygiene":' });
  const r = runHook(hookEnv(d).env);
  assert.strictEqual(r.status, 0);
  assert.ok(/not valid JSON/.test(r.stdout) && /do not rewrite the file without asking/i.test(r.stdout), r.stdout);
});
check('light doctor · fires on every source (startup / resume / clear / compact): the same line each time', () => {
  const d = proj({ marker: false }); const h = hookEnv(d);
  const outs = ['startup', 'resume', 'clear', 'compact'].map((src) => runHook(h.env, { stdin: JSON.stringify({ hook_event_name: 'SessionStart', source: src }) }));
  outs.forEach((r) => { assert.strictEqual(r.status, 0); assert.ok(/^\[claude-tpm\] 1 problem/.test(r.stdout), r.stdout); });
  assert.strictEqual(new Set(outs.map((r) => r.stdout)).size, 1);
});
check('light doctor · fail-open: a throw anywhere in the check -> still exit 0, empty stdout, exports still written', () => {
  const hook = require(HOOK);
  assert.strictEqual(hook.healthMessage({ CLAUDE_PROJECT_DIR: '/x' }, { observe: () => { throw new Error('boom'); } }), '');
  const d = proj({ marker: false });
  assert.strictEqual(hook.healthMessage({ CLAUDE_PROJECT_DIR: d }, { hookMessage: () => { throw new Error('boom'); } }), '');
  assert.strictEqual(hook.healthMessage({ CLAUDE_PROJECT_DIR: d }, { observe: () => null }), '');
  assert.strictEqual(hook.healthMessage({}), '', 'no project dir -> nothing to check');
  // end to end: the project dir is a FILE, a nonexistent dir, and a dir whose config is a directory
  const f = path.join(fresh(), 'afile'); fs.writeFileSync(f, 'x');
  for (const p of [f, '/definitely/not/here', path.join(fresh(), 'nope')]) {
    const h = hookEnv(p); const r = runHook(h.env);
    assert.strictEqual(r.status, 0, p); assert.strictEqual(r.stdout, '', p);
  }
  const weird = proj({ marker: false }); fs.mkdirSync(path.join(weird, '.claude', 'claude-tpm', 'config.json'), { recursive: true });
  const r2 = runHook(hookEnv(weird).env); assert.strictEqual(r2.status, 0);
});
check('light doctor · a folder with no package.json (not a project the installer manages) -> silent, exit 0', () => {
  const d = proj({ marker: false }); fs.unlinkSync(path.join(d, 'package.json'));
  const r = runHook(hookEnv(d).env);
  assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, '');
});
check('light doctor · works through `tpm hooks session-start` (router + tpm.js) and with no CLAUDE_ENV_FILE', () => {
  const d = proj({ marker: false }); const h = hookEnv(d); delete h.env.CLAUDE_ENV_FILE;
  const r = runHook(h.env, { via: 'tpm' });
  assert.strictEqual(r.status, 0); assert.ok(/^\[claude-tpm\] 1 problem/.test(r.stdout), r.stdout);
});
check('light doctor · mutation guard: the hook source does not reference a full doctor, a probe, or autoRunFullDoctor (D-1/D-2)', () => {
  const src = read(HOOK);
  assert.ok(/probes:\s*false/.test(src), 'light = probes:false');
  assert.ok(!/autoRunFullDoctor/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'no autoRunFullDoctor key in code');
  assert.ok(!/tpm-consumer-doctor|spawnSync|execSync|child_process/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'no doctor / no spawn in the hook code');
});

process.stdout.write(`PASS — ${count} checks\n`);
