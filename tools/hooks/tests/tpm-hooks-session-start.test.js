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

process.stdout.write(`PASS — ${count} checks\n`);
