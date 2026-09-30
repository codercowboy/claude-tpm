#!/usr/bin/env node
'use strict';
/**
 * tpm-runner-registration.test.js — a test that no runner runs is a test that does not exist.
 *
 * Every test file under tools/** (`*.test.js` and the `test.js` suites) must be reachable from `npm test`:
 *   - tools/session/tests and tools/task/tests runners glob their own `*.test.js`
 *   - tools/tests/run-all.js, tools/workflow/tests/run-all.js, tools/consumer/tests/run-all.js list targets explicitly,
 *     and the top-level list must in turn include every group runner
 * Proven to bite on synthetic trees (an unregistered test is reported; a registered one is not).
 *
 * Run: node tools/tests/tpm-runner-registration.test.js   (exit 0 = green)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { walk, BUNDLE } = require('./lib/guard-helpers');

const TOOLS = path.join(BUNDLE, 'tools');
const posix = (p) => p.split(path.sep).join('/');

/** Quoted `*.js` paths inside the runner's TARGETS/SUITES array → resolved to tools-relative paths. */
function listed(runnerRel, toolsRoot) {
  const src = fs.readFileSync(path.join(toolsRoot, runnerRel), 'utf8');
  const m = /const (?:TARGETS|SUITES) = \[([\s\S]*?)\n\];/.exec(src);
  if (!m) return null;
  const base = path.dirname(runnerRel);
  const base2 = runnerRel === 'tests/run-all.js' ? '' : base; // the top-level runner resolves against tools/, the group runners against their dir
  return [...m[1].matchAll(/['"]([^'"]+\.js)['"]/g)].map((x) => posix(path.normalize(path.join(base2, x[1]))));
}

/** Every test entrypoint that exists, and the set `npm test` reaches. */
function audit(toolsRoot) {
  const all = walk(toolsRoot, (p) => {
    const rel = posix(path.relative(toolsRoot, p));
    if (!/\/tests\//.test('/' + rel) || /\/(fixtures|golden|helpers|smoke|lib)\//.test('/' + rel)) return false;
    return /\.test\.js$/.test(rel) || /(^|\/)test\.js$/.test(rel);
  }).map((p) => posix(path.relative(toolsRoot, p)));
  const reached = new Set();
  const top = listed('tests/run-all.js', toolsRoot) || [];
  for (const t of top) reached.add(t);
  for (const group of ['session', 'task']) { // glob runners
    const dir = path.join(toolsRoot, group, 'tests');
    if (!fs.existsSync(path.join(dir, 'run-all.js'))) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.test.js')) reached.add(`${group}/tests/${f}`);
  }
  for (const group of ['workflow', 'consumer']) {
    for (const t of listed(`${group}/tests/run-all.js`, toolsRoot) || []) reached.add(t); // already tools-relative (resolved against the group runner's own dir)
  }
  const missingRunners = ['session', 'task', 'consumer', 'workflow']
    .filter((g) => !top.includes(`${g}/tests/run-all.js`)).map((g) => `top-level runner does not run ${g}/tests/run-all.js`);
  return { all, unreached: all.filter((f) => !reached.has(f)), missingRunners };
}

let count = 0;
function check(name, fn) { fn(); count += 1; process.stdout.write(`  ✓ ${name}\n`); }
process.stdout.write('tpm-runner-registration.test.js\n');

check('every test file in tools/** is reached by `npm test` (group runners globbed/listed; top-level lists every group runner)', () => {
  const r = audit(TOOLS);
  assert.ok(r.all.length > 60, `audit too narrow (${r.all.length} test files)`);
  assert.deepStrictEqual(r.missingRunners, []);
  assert.deepStrictEqual(r.unreached, [], 'unregistered tests (never run by npm test):\n  ' + r.unreached.join('\n  '));
});

check('the cross-cutting guard tests of the final-stage pass are registered in the top-level runner', () => {
  const top = listed('tests/run-all.js', TOOLS);
  for (const t of ['tests/tpm-npx-regression-guard.test.js', 'tests/tpm-doc-examples.test.js', 'tests/tpm-env-leak-guard.test.js',
    'tests/tpm-package-contents.test.js', 'tests/tpm-hook-contract.test.js', 'tests/tpm-shipped-content.test.js', 'tests/tpm-runner-registration.test.js']) {
    assert.ok(top.includes(t), `${t} missing from tools/tests/run-all.js TARGETS`);
  }
});

check('BITE: on a synthetic tree an unregistered test (top-level, workflow suite, consumer suite, session glob) is reported; registered ones are not', () => {
  const root = path.join(require('./lib/scratch').mkScratch('reg'), 'tools');
  const put = (rel, body) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body || '//'); };
  put('tests/run-all.js', "const TARGETS = [\n  'session/tests/run-all.js',\n  'task/tests/run-all.js',\n  'consumer/tests/run-all.js',\n  'workflow/tests/run-all.js',\n  'tests/a.test.js',\n];\n");
  put('workflow/tests/run-all.js', "const SUITES = [\n  'w1/test.js',\n];\n");
  put('consumer/tests/run-all.js', "const SUITES = [\n  'c1/test.js',\n];\n");
  put('session/tests/run-all.js'); put('task/tests/run-all.js');
  for (const f of ['tests/a.test.js', 'workflow/tests/w1/test.js', 'consumer/tests/c1/test.js', 'session/tests/s1.test.js']) put(f);
  assert.deepStrictEqual(audit(root), { all: audit(root).all, unreached: [], missingRunners: [] }, 'control: all registered');
  for (const f of ['tests/b.test.js', 'workflow/tests/w2/test.js', 'consumer/tests/c2/test.js']) put(f);
  const r = audit(root);
  assert.deepStrictEqual(r.unreached.sort(), ['consumer/tests/c2/test.js', 'tests/b.test.js', 'workflow/tests/w2/test.js']);
  // a session test is globbed, so it is reached automatically; a runner dropped from the top-level list is caught
  put('session/tests/s2.test.js');
  assert.ok(!audit(root).unreached.includes('session/tests/s2.test.js'));
  put('tests/run-all.js', "const TARGETS = [\n  'session/tests/run-all.js',\n  'tests/a.test.js',\n];\n");
  assert.ok(audit(root).missingRunners.length === 3, audit(root).missingRunners.join('; '));
});

process.stdout.write(`\nPASS — ${count} checks\n`);
