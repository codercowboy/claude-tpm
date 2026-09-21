#!/usr/bin/env node
/**
 * tests/tpm-reading-list.test.js — unit test for the `tpm reading-list <role>` verb.
 *
 * PURPOSE
 *   Proves the reading-chain emitter: marker parsing (BOTH spellings — `reading-list:begin` and
 *   `lint:begin`), `../`→bundle-relpath resolution, both roles' end-to-end output against a synthetic
 *   bundle, the anchor-form render, and the exit codes (unknown role / missing role / help). No
 *   network, no `claude` — child-processes the script against a synthetic bundle in os.tmpdir() and
 *   drives its pure helpers directly.
 *
 * HOW TO RUN
 *   node tools/tests/tpm-reading-list.test.js   # exit 0 = all assertions green
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOLS = path.resolve(__dirname, '..');            // tests/ -> tools/
const SCRIPT = path.join(TOOLS, 'tpm-reading-list.js');
const {
  parseBlocks, entryLink, toBundleRelpath, chainEntries, render,
} = require('../tpm-reading-list.js');

function run(args, override) {
  const env = { ...process.env };
  delete env.TPM_HOME_OVERRIDE;
  if (override !== undefined) env.TPM_HOME_OVERRIDE = override;
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

let count = 0;
function check(name, fn) { fn(); count += 1; process.stdout.write(`  ✓ ${name}\n`); }

process.stdout.write('tpm-reading-list.test.js\n');

// ── pure: parseBlocks accepts BOTH marker spellings ───────────────────────────────
check('parseBlocks parses reading-list:begin/end blocks', () => {
  const b = parseBlocks('a\n<!-- reading-list:begin core -->\n1. **[`x`](../x.md)**\n<!-- reading-list:end -->\nz');
  assert.deepStrictEqual(Object.keys(b), ['core']);
  assert.strictEqual(b.core.length, 1);
});
check('parseBlocks parses lint:begin/end blocks', () => {
  const b = parseBlocks('<!-- lint:begin base -->\n1. **[`y`](../y.md)**\n<!-- lint:end -->');
  assert.deepStrictEqual(Object.keys(b), ['base']);
});
check('parseBlocks keeps blocks separate + drops out-of-block lines', () => {
  const b = parseBlocks('pre\n<!-- lint:begin a -->\nL1\n<!-- lint:end -->\nmid\n<!-- lint:begin b -->\nL2\nL3\n<!-- lint:end -->\npost');
  assert.deepStrictEqual(b.a, ['L1']);
  assert.deepStrictEqual(b.b, ['L2', 'L3']);
});

// ── pure: entryLink extracts the PRIMARY link only ────────────────────────────────
check('entryLink pulls the first link from a numbered entry', () => {
  assert.strictEqual(
    entryLink('1. **[`project-workspace.md`](../project-workspace.md)** — see [`x`](./x.md)'),
    '../project-workspace.md',
  );
});
check('entryLink returns null for prose / non-entry lines', () => {
  assert.strictEqual(entryLink('> a note with a [link](../z.md)'), null);
  assert.strictEqual(entryLink(''), null);
});

// ── pure: toBundleRelpath resolves against the manifest dir ────────────────────────
check('toBundleRelpath: ../ climbs out of the manifest dir', () => {
  assert.strictEqual(
    toBundleRelpath('claude-context/methodology/orchestrator/reading-list.md', '../project-workspace.md'),
    'claude-context/methodology/project-workspace.md',
  );
});
check('toBundleRelpath: ./ stays in the manifest dir', () => {
  assert.strictEqual(
    toBundleRelpath('claude-context/methodology/subagent/reading-list.md', './handbook.md'),
    'claude-context/methodology/subagent/handbook.md',
  );
});

// ── pure: render is anchor-form ───────────────────────────────────────────────────
check('render emits the resolve-home anchor then one doc line per entry', () => {
  const out = render('orchestrator', ['claude-context/methodology/a.md', 'claude-context/methodology/b.md']);
  const lines = out.trim().split('\n');
  assert.ok(lines[0].startsWith('# Reading list — orchestrator (2 docs'));
  assert.strictEqual(lines[2], 'npx tpm resolve-home');
  assert.strictEqual(lines[3], 'npx tpm doc claude-context/methodology/a.md');
  assert.strictEqual(lines[4], 'npx tpm doc claude-context/methodology/b.md');
});

// ── pure: chainEntries end-to-end from manifest content ───────────────────────────
check('chainEntries derives the ordered orchestrator chain from marked content', () => {
  const content = [
    '# noise',
    '<!-- reading-list:begin tpm-session-open -->',
    '1. **[`project-workspace.md`](../project-workspace.md)** — a',
    '2. **[`handbook.md`](./handbook.md)** — b',
    '3. **[`shared-conventions.md`](../shared-conventions.md)** — c',
    '<!-- reading-list:end -->',
  ].join('\n');
  assert.deepStrictEqual(chainEntries('orchestrator', content), [
    'claude-context/methodology/project-workspace.md',
    'claude-context/methodology/orchestrator/handbook.md',
    'claude-context/methodology/shared-conventions.md',
  ]);
});

// ── integration: a synthetic bundle exercises BOTH roles via child process ─────────
const bundle = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tpmrl-')));
function writeManifest(rel, text) {
  const abs = path.join(bundle, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}
writeManifest('claude-context/methodology/orchestrator/reading-list.md', [
  '<!-- reading-list:begin tpm-session-open -->',
  '1. **[`project-workspace.md`](../project-workspace.md)** — a',
  '2. **[`handbook.md`](./handbook.md)** — b',
  '<!-- reading-list:end -->',
].join('\n'));
writeManifest('claude-context/methodology/subagent/reading-list.md', [
  '<!-- lint:begin base -->',
  '1. **[`project-workspace.md`](../project-workspace.md)** — a',
  '2. **[`handbook.md`](./handbook.md)** — b',
  '<!-- lint:end -->',
  '<!-- lint:begin resume -->',
  '- **`HANDOFF.md`** — not numbered, must be ignored',
  '<!-- lint:end -->',
].join('\n'));

check('orchestrator role → anchor-form chain, exit 0', () => {
  const r = run(['orchestrator'], bundle);
  assert.strictEqual(r.status, 0);
  const lines = r.out.trim().split('\n');
  assert.strictEqual(lines[2], 'npx tpm resolve-home');
  assert.strictEqual(lines[3], 'npx tpm doc claude-context/methodology/project-workspace.md');
  assert.strictEqual(lines[4], 'npx tpm doc claude-context/methodology/orchestrator/handbook.md');
});
check('subagent role → base block only (numbered entries), exit 0', () => {
  const r = run(['subagent'], bundle);
  assert.strictEqual(r.status, 0);
  const docs = r.out.trim().split('\n').filter((l) => l.startsWith('npx tpm doc'));
  assert.deepStrictEqual(docs, [
    'npx tpm doc claude-context/methodology/project-workspace.md',
    'npx tpm doc claude-context/methodology/subagent/handbook.md',
  ]);
});
check('unknown role → exit 2 + lists known roles', () => {
  const r = run(['bogus'], bundle);
  assert.strictEqual(r.status, 2);
  assert.ok(/orchestrator, subagent/.test(r.err));
});
check('missing role → exit 2', () => {
  assert.strictEqual(run([], bundle).status, 2);
});
check('--help → exit 0', () => {
  assert.strictEqual(run(['--help'], bundle).status, 0);
});
check('manifest unreadable under bundle → exit 1', () => {
  const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tpmrl-empty-')));
  assert.strictEqual(run(['orchestrator'], empty).status, 1);
});

// ── integration: the REAL bundle's manifests resolve to on-disk files ──────────────
check('REAL bundle: both roles emit only existing docs', () => {
  for (const role of ['orchestrator', 'subagent']) {
    const r = run([role]); // no override → self-locate the real bundle
    assert.strictEqual(r.status, 0, `${role} should exit 0`);
    const root = path.resolve(TOOLS, '..');
    const docs = r.out.trim().split('\n')
      .filter((l) => l.startsWith('npx tpm doc '))
      .map((l) => l.replace('npx tpm doc ', ''));
    assert.ok(docs.length > 0, `${role} should emit at least one doc`);
    for (const rel of docs) {
      assert.ok(fs.existsSync(path.join(root, rel)), `${role} doc must exist: ${rel}`);
    }
  }
});

process.stdout.write(`\nPASS — ${count}/${count} tpm reading-list assertions green\n`);
