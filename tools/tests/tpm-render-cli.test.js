#!/usr/bin/env node
'use strict';
/**
 * tests/tpm-render-cli.test.js — the `tpm render` verb, run through the real bare-`tpm` dispatcher
 * (`node tools/tpm.js render …`): default render, --explain, --list-flags, --lint, --slot, --config,
 * usage / missing-file exit codes, degraded-config survival, and --help hygiene.
 *
 * HOW TO RUN
 *   node tools/tests/tpm-render-cli.test.js   # exit 0 = all assertions green
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { BUNDLE, runTpm, makeFakeClaude, safeEnv, makeProject } = require('./lib/guard-helpers');
const { mkScratch } = require('./lib/scratch');

const FIX = path.join(__dirname, 'fixtures', 'template');
const fake = makeFakeClaude('render-cli');
const ENV = safeEnv(fake, {});
const proj = makeProject('render-cli-proj');
const work = mkScratch('render-cli-work');

function tpm(args, extraEnv) {
  const env = extraEnv ? safeEnv(fake, extraEnv) : ENV;
  return runTpm(BUNDLE, ['render', ...args], { env, cwd: proj });
}
function put(name, text) { const p = path.join(work, name); fs.writeFileSync(p, text); return p; }

let count = 0;
function check(name, fn) { fn(); count += 1; process.stdout.write(`  ✓ ${name}\n`); }
process.stdout.write('tpm-render-cli.test.js\n');

const TPL = put('t.md', 'head\n<!-- tpm:if tasks.enabled -->\ntasks-on\n<!-- tpm:endif -->\n<!-- tpm:if !session.enabled -->\nsess-off\n<!-- tpm:endif -->\n<!-- tpm:inject extra -->\nfoot\n');
const CFG = put('c.json', '{"tasks":{"enabled":false},"session":{"enabled":false}}');

check('default render: --config golden, text on stdout, exit 0', () => {
  const r = tpm([TPL, '--config', CFG, '--slot', 'extra=EXTRA']);
  assert.strictEqual(r.status, 0, r.all);
  assert.strictEqual(r.out, 'head\nsess-off\nEXTRA\nfoot\n'); assert.strictEqual(r.err, '');
});
check('default render resolves the real overlay (shipped defaults): tasks region present', () => {
  const r = tpm([TPL, '--slot', 'extra=X']);
  assert.strictEqual(r.status, 0, r.all); assert.ok(r.out.includes('tasks-on')); assert.ok(!r.out.includes('WARNING'));
});
check('--slot name=@file reads a file; warnings go to stderr, exit stays 0', () => {
  const sf = put('slot.txt', 'FROM FILE\n');
  const t2 = put('t2.md', '<!-- tpm:inject extra -->\n<!-- tpm:inject nope -->\n<!-- tpm:frob -->\n');
  const r = tpm([t2, '--config', CFG, '--slot', `extra=@${sf}`]);
  assert.strictEqual(r.status, 0, r.all); assert.strictEqual(r.out, 'FROM FILE\n<!-- tpm:frob -->\n');
  assert.ok(/render: unknown-slot \(line 2\)/.test(r.err)); assert.ok(/render: unknown-directive \(line 3\)/.test(r.err));
});
check('--explain: kept/dropped + driving flag + value, flags summary, no composed text', () => {
  const r = tpm([TPL, '--config', CFG, '--explain']);
  assert.strictEqual(r.status, 0, r.all);
  assert.ok(/1  if  2-4  DROPPED  because tasks\.enabled=false \(flag-off\)/.test(r.out), r.out);
  assert.ok(/2  if  5-7  KEPT  because !session\.enabled=false \(flag-on\)/.test(r.out), r.out);
  assert.ok(/flags:\n  tasks\.enabled = false -> OFF \(line 2\)\n  !session\.enabled = false -> ON \(line 5\)/.test(r.out), r.out);
  assert.ok(!r.out.includes('head\n'));
});
check('--list-flags: each flag once with its shipped default + lines; static', () => {
  const r = tpm([put('lf.md', '<!-- tpm:if tasks.enabled -->\n<!-- tpm:endif -->\n<!-- tpm:if tasks.enabled -->\n<!-- tpm:endif -->\n<!-- tpm:if made.up -->\n<!-- tpm:endif -->\n'), '--list-flags']);
  assert.strictEqual(r.status, 0, r.all);
  assert.deepStrictEqual(r.out.trim().split('\n'), ['tasks.enabled\ttrue\t1,3', 'made.up\t(not in defaults)\t5']);
});
check('--lint: clean => exit 0; error => exit 1 with file:line code; warning-only => exit 0', () => {
  const ok = tpm([TPL, '--lint']); assert.strictEqual(ok.status, 0, ok.all); assert.strictEqual(ok.out, '');
  const bad = tpm([put('bad.md', '<!-- tpm:if made.up -->\n<!-- tpm:endif -->\n<!-- tpm:endif -->\n'), '--lint']);
  assert.strictEqual(bad.status, 1); assert.ok(/bad\.md:1 unknown-flag/.test(bad.out)); assert.ok(/bad\.md:3 stray-endif/.test(bad.out));
  const warn = tpm([put('w.md', '<!-- tpm:frob -->\n'), '--lint']);
  assert.strictEqual(warn.status, 0); assert.ok(/unknown-directive/.test(warn.out));
});
check('lint accepts the golden fixtures that use real flags; raw-aware', () => {
  const r = tpm([path.join(FIX, 'raw.md'), '--lint']);
  assert.strictEqual(r.status, 1, r.all); // off.flag is a real reference outside raw and is not in defaults
  assert.ok(/unknown-flag/.test(r.out)); assert.ok(!/literal\.flag/.test(r.out));
});
check('usage errors exit 2: no file, two files, unknown option, mutually exclusive modes, bad slot', () => {
  for (const args of [[], [TPL, TPL], [TPL, '--bogus'], [TPL, '--explain', '--lint'], [TPL, '--list-flags', '--explain'], [TPL, '--slot', 'noequals'], [TPL, '--slot', 'Bad=x']]) {
    const r = tpm(args); assert.strictEqual(r.status, 2, JSON.stringify(args) + r.all);
  }
});
check('missing template / slot file / config file => exit 1', () => {
  assert.strictEqual(tpm([path.join(work, 'nope.md')]).status, 1);
  assert.strictEqual(tpm([TPL, '--slot', 'extra=@/nonexistent/x']).status, 1);
  assert.strictEqual(tpm([TPL, '--config', '/nonexistent/c.json']).status, 1);
  assert.strictEqual(tpm([TPL, '--config', put('bad.json', '{nope')]).status, 1);
});
check('degraded config: bad project config.json => exit 0, banner on stdout, body present', () => {
  const p = makeProject('render-cli-degraded');
  fs.writeFileSync(path.join(p, '.claude', 'claude-tpm', 'config.json'), '{ nope');
  const r = tpm([TPL, '--project-root', p, '--slot', 'extra=X']);
  assert.strictEqual(r.status, 0, r.all); assert.ok(r.out.startsWith('> WARNING: tpm degraded config')); assert.ok(r.out.includes('head\n'));
  const nb = tpm([TPL, '--project-root', p, '--no-banner', '--slot', 'extra=X']);
  assert.strictEqual(nb.status, 0); assert.ok(nb.out.startsWith('head\n'));
});
check('missing defaults file: still exit 0 with a banner and unconditional text', () => {
  const r = tpm([TPL, '--slot', 'extra=X'], { TPM_DEFAULTS_FILE: '/nonexistent/defaults.json' });
  assert.strictEqual(r.status, 0, r.all); assert.ok(r.out.includes('rendered with no config')); assert.ok(r.out.includes('foot\n'));
});
check('--help (and -h): exit 0, lists every flag, never says "npx tpm"', () => {
  for (const h of ['--help', '-h']) {
    const r = tpm([h]); assert.strictEqual(r.status, 0);
    for (const f of ['--explain', '--list-flags', '--lint', '--slot', '--config', '--project-root', '--no-banner']) assert.ok(r.out.includes(f), f);
    assert.ok(!/npx tpm/.test(r.out));
  }
});
check('tpm --help advertises render; render is wired as ONE alias line', () => {
  const r = runTpm(BUNDLE, ['--help'], { env: ENV });
  assert.ok(/render <template>/.test(r.out));
  const src = fs.readFileSync(path.join(BUNDLE, 'tools', 'tpm.js'), 'utf8');
  assert.strictEqual(src.split('\n').filter((l) => /^\s*render:\s*'tpm-render\.js'/.test(l)).length, 1);
});

process.stdout.write(`\ntpm-render-cli.test.js: ${count} checks passed\n`);
