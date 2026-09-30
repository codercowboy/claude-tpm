#!/usr/bin/env node
/**
 * tests/tpm-home-env-guard.test.js — guard: tools self-locate their bundle; $TPM_HOME is informational only
 * (design D8 / punchlist 3.5). With TPM_HOME pointing at a bogus dir (and at a decoy bundle that has a
 * conflicting doc), `tpm home` and `tpm doc` must still answer from the REAL bundle. A static scan also
 * asserts no shipped tool source reads `process.env.TPM_HOME`.
 *
 * Run: node tools/tests/tpm-home-env-guard.test.js   (exit 0 = green)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOLS = path.resolve(__dirname, '..');
const REAL_BUNDLE = fs.realpathSync(path.resolve(TOOLS, '..'));
const DOC_REL = 'claude-context/methodology/tool-conventions.md';

let count = 0;
function check(name, fn) { fn(); count += 1; process.stdout.write(`  ✓ ${name}\n`); }
function run(script, args, tpmHome) {
  const env = { ...process.env };
  delete env.TPM_HOME_OVERRIDE;
  delete env.TPM_HOME;
  if (tpmHome !== undefined) env.TPM_HOME = tpmHome;
  const r = spawnSync('node', [path.join(TOOLS, script), ...args], { encoding: 'utf8', env });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

process.stdout.write('tpm-home-env-guard.test.js\n');

const decoy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tpmhome-decoy-')));
fs.mkdirSync(path.join(decoy, 'claude-context', 'methodology'), { recursive: true });
fs.writeFileSync(path.join(decoy, DOC_REL), 'DECOY DOC FROM TPM_HOME\n');
const realDoc = fs.readFileSync(path.join(REAL_BUNDLE, DOC_REL), 'utf8');

for (const [label, val] of [['a nonexistent dir', path.join(os.tmpdir(), 'tpm-no-such-home-xyz')], ['a decoy bundle', decoy]]) {
  check(`TPM_HOME=${label}: \`tpm home\` still prints the real bundle`, () => {
    const r = run('tpm-home.js', [], val);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.out.trim(), REAL_BUNDLE);
  });
  check(`TPM_HOME=${label}: \`tpm doc\` still reads the real bundle doc`, () => {
    const r = run('tpm-doc.js', [DOC_REL], val);
    assert.strictEqual(r.status, 0, r.err);
    assert.ok(!r.out.includes('DECOY DOC'), 'must not read the decoy');
    assert.ok(r.out.length > 200, 'real doc content');
    assert.ok(r.out.startsWith(realDoc.split('\n')[0]), 'starts with the real doc first line');
  });
}

check('no shipped tool source reads process.env.TPM_HOME (only TPM_HOME_OVERRIDE, test-only)', () => {
  const offenders = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'tests') walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      if (/process\.env\.TPM_HOME(?!_OVERRIDE)\b|env\[['"]TPM_HOME['"]\]/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(TOOLS, p));
    }
  })(TOOLS);
  assert.deepStrictEqual(offenders, [], 'tools reading TPM_HOME: ' + offenders.join(', '));
});

process.stdout.write(`\n${count} checks passed\n`);
