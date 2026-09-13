#!/usr/bin/env node
/**
 * test.js — Phase-1 test suite for tpm-fix-git-rename-refs.js
 *
 * Covers the Phase-1-relevant coverage from tpm-fix-git-rename-refs.test-design.md:
 *   §3 unit tests (status parser incl. git-quoting + no-op drop; anchor/resolve; classifier; boundary
 *   matcher; rewrite; only-intended assertion; collision pick), and the §4 `identify` integration
 *   tests against the fabricated kitchen-sink tree from §2.3.
 *
 * Hermetic: every tree is built under a fresh fs.mkdtempSync dir and removed in `finally`. Never
 * touches the real claude-tpm tree. Never calls git. Zero deps (Node builtins + a tiny hand-rolled
 * harness). Prints `PASSED n / FAILED m` and exits non-zero on any failure.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const TOOL = path.join(__dirname, '..', '..', 'tpm-fix-git-rename-refs.js');
const mod = require(TOOL);

// ── tiny harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; failures.push({ name, err: e }); process.stderr.write(`FAIL: ${name}\n  ${e.message}\n`); }
}

// ── fixture helpers ─────────────────────────────────────────────────────────
// makeTree(spec): spec maps rel-path -> string | Buffer | {symlink: target}. Returns the temp root.
function makeTree(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-fixrefs-'));
  for (const [rel, val] of Object.entries(spec)) {
    const abs = path.join(root, rel);
    if (val && typeof val === 'object' && !Buffer.isBuffer(val) && val.symlink) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.symlinkSync(val.symlink, abs);
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.isBuffer(val) ? val : Buffer.from(val));
  }
  return root;
}

// readTree(root): snapshot rel-path -> Buffer for before/after diffing.
function readTree(root) {
  const out = {};
  (function walk(dir, base) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = base ? base + '/' + e.name : e.name;
      if (e.isSymbolicLink()) { out[rel] = { symlink: fs.readlinkSync(abs) }; }
      else if (e.isDirectory()) walk(abs, rel);
      else out[rel] = fs.readFileSync(abs);
    }
  })(root, '');
  return out;
}

// statusFile(entries): render a realistic git status block to a file inside `root`, return its path.
// entries: [{renamed:[old,new]} | {deleted: old} | {raw: '...'}]
function statusFile(root, entries, name = 'git-status.txt') {
  const lines = ['On branch main', 'Changes to be committed:'];
  for (const e of entries) {
    if (e.raw !== undefined) lines.push(e.raw);
    else if (e.renamed) lines.push(`\trenamed:    ${e.renamed[0]} -> ${e.renamed[1]}`);
    else if (e.deleted) lines.push(`\tdeleted:    ${e.deleted}`);
  }
  lines.push('\t(use "git restore --staged <file>..." to unstage)');
  const p = path.join(root, name);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

// runCli(args, cwd, env): spawn the tool, return { status, stdout, stderr }. `env` (optional) is merged
// over process.env (used to drive the test-only fault-injection seam).
function runCli(args, cwd, env) {
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    cwd, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// snapshot a single file's bytes (or null if absent)
function readMaybe(abs) { try { return fs.readFileSync(abs); } catch { return null; } }
// sha256 hex of a file — mirrors the tool's hashContent for building apply-plan expectHash values.
function fileHash(abs) { return mod.hashContent(fs.readFileSync(abs)); }

function rm(root) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } }

// ── the kitchen-sink fabricated tree (§2.3) ───────────────────────────────────
function buildKitchenSink() {
  const KITCHEN_STATUS =
    'On branch main\n' +
    'Changes to be committed:\n' +
    '\trenamed:    src/a/foo.js -> src/a/foo-bar.js\n' +
    '\trenamed:    src/a/keep.js -> src/b/keep.js\n' +
    '\trenamed:    src/a/config.js -> src/a/sess-config.js\n' +
    '\trenamed:    src/c/config.js -> src/c/task-config.js\n' +
    '\trenamed:    src/a/only.js -> src/a/only-1.js\n' +
    '\trenamed:    "src/a/with space.js" -> "src/a/with-space.js"\n' +
    '\tdeleted:    src/a/gone.js\n' +
    '\trenamed:    src/a/foo.js -> src/a/foo.js\n' + // NO-OP, must be dropped
    '\t(use "git restore --staged <file>..." to unstage)\n';

  const root = makeTree({
    'git-status.txt': KITCHEN_STATUS,

    'docs/readme.md':
      'See the rooted path src/a/foo.js for details.\n' +
      'Also see foo.js in prose.\n' +
      'The deleted file src/a/gone.js is gone.\n' +
      'Templated ${FOO}/src/a/foo.js here.\n',

    'src/a/skill.md':
      'relative ./foo.js\n' +
      'dirmove ./keep.js\n',

    'deep/x/y/note.md':
      'up ../../../src/a/foo.js\n' +
      'bare config.js here\n',

    'src/z/uses.js': "const x = require('./foo');\n",

    'src/other/config.js': '// unrelated helper, not renamed\n',

    'docs/points-elsewhere.md': 'rooted src/other/config.js elsewhere\n',

    'docs/edge.md': 'backup src/a/foo.js.bak and src/a/foobar.js\n',

    'weird/crlf.md': Buffer.from('line with src/a/foo.js\r\n', 'utf8'),
    'weird/nonl.txt': Buffer.from('src/a/foo.js no newline', 'utf8'),
    'weird/bom.md': Buffer.from('﻿src/a/foo.js after bom\n', 'utf8'),

    'misc/refs.md': 'rooted ref src/a/only.js here\n',

    'assets/pic.bin': Buffer.from('foo.js\0src/a/foo.js binary', 'utf8'),

    'link-dir': { symlink: 'src/a' },
  });
  return { root, statusPath: path.join(root, 'git-status.txt') };
}

// =============================================================================
// §3.1 — status parser
// =============================================================================
test('§3.1 parseStatus: renamed + deleted parsed; no-op dropped; indexes built', () => {
  const text =
    'On branch main\n' +
    'Changes to be committed:\n' +
    '\trenamed:    src/a/foo.js -> src/a/foo-bar.js\n' +
    '\trenamed:    src/a/config.js -> src/a/sess-config.js\n' +
    '\trenamed:    src/c/config.js -> src/c/task-config.js\n' +
    '\trenamed:    src/a/only.js -> src/a/only-1.js\n' +
    '\tdeleted:    src/a/gone.js\n' +
    '\trenamed:    src/a/same.js -> src/a/same.js\n' + // no-op
    '\t(use "git restore --staged <file>..." to unstage)\n';
  const p = mod.parseStatus(text);
  assert.strictEqual(p.entries.length, 5, 'no-op dropped, 5 remain');
  assert.ok(p.byOldPath.has('src/a/foo.js'));
  assert.strictEqual(p.byOldPath.get('src/a/foo.js').new, 'src/a/foo-bar.js');
  assert.strictEqual(p.byOldPath.get('src/a/gone.js').kind, 'delete');
  assert.strictEqual(p.byBasename.get('config.js').length, 2, 'collision');
  assert.strictEqual(p.byBasename.get('only.js').length, 1, 'unique');
  assert.ok(!p.byOldPath.has('src/a/same.js'), 'no-op not indexed');
});

test('§3.1 parseStatus: unquotes git-quoted paths (spaces + octal non-ASCII)', () => {
  const text =
    '\trenamed:    "src/a/with space.js" -> "src/a/with-space.js"\n' +
    '\trenamed:    "src/a/caf\\303\\251.js" -> src/a/cafe.js\n';
  const p = mod.parseStatus(text);
  assert.strictEqual(p.entries[0].old, 'src/a/with space.js');
  assert.strictEqual(p.entries[0].new, 'src/a/with-space.js');
  assert.strictEqual(p.entries[0].oldBase, 'with space.js');
  assert.strictEqual(p.entries[1].old, 'src/a/café.js', 'octal \\303\\251 -> é');
});

test('§3.1 unquoteGitPath: direct', () => {
  assert.strictEqual(mod.unquoteGitPath('"a b.js"'), 'a b.js');
  assert.strictEqual(mod.unquoteGitPath('plain.js'), 'plain.js');
  assert.strictEqual(mod.unquoteGitPath('"x\\ty.js"'), 'x\ty.js');
});

test('§3.1 parseStatus: ignores non-status lines; tolerates whitespace/multiple spaces', () => {
  const text =
    'On branch main\n\n' +
    '   renamed:  a.js    ->     b.js   \n' + // extra spaces
    '(use "git...")\n';
  const p = mod.parseStatus(text);
  assert.strictEqual(p.entries.length, 1);
  assert.strictEqual(p.entries[0].old, 'a.js');
  assert.strictEqual(p.entries[0].new, 'b.js');
});

test('§3.1 parseStatus: malformed renamed line (no ->) -> warning, not crash', () => {
  const p = mod.parseStatus('\trenamed:    lonely.js\n');
  assert.strictEqual(p.entries.length, 0);
  assert.ok(p.warnings.length >= 1);
  assert.match(p.warnings[0], /malformed/);
});

// =============================================================================
// §3.2 — anchor detection & resolution
// =============================================================================
test('§3.2 resolveRef: rooted', () => {
  const r = mod.resolveRef('src/a/foo.js', 'docs/readme.md');
  assert.strictEqual(r.anchor, 'rooted');
  assert.strictEqual(r.resolved, 'src/a/foo.js');
});

test('§3.2 resolveRef: relative-to-file', () => {
  const r1 = mod.resolveRef('./foo.js', 'src/a/skill.md');
  assert.strictEqual(r1.anchor, 'relative');
  assert.strictEqual(r1.resolved, 'src/a/foo.js');
  const r2 = mod.resolveRef('../../../src/a/foo.js', 'deep/x/y/note.md');
  assert.strictEqual(r2.resolved, 'src/a/foo.js');
});

test('§3.2 resolveRef: variable -> unresolvable, no expansion', () => {
  const r1 = mod.resolveRef('${FOO}/src/a/foo.js', 'docs/readme.md');
  assert.strictEqual(r1.anchor, 'variable');
  assert.ok(r1.unresolvable && r1.variable);
  const r2 = mod.resolveRef('$FOO/src/a/foo.js', 'docs/readme.md');
  assert.strictEqual(r2.anchor, 'variable');
});

test('§3.2 resolveRef: bare -> no anchor', () => {
  const r = mod.resolveRef('foo.js', 'docs/readme.md');
  assert.strictEqual(r.anchor, 'bare');
  assert.ok(r.unresolvable);
});

test('§3.2 resolveRef: escape guard (resolves outside scan-root)', () => {
  const r = mod.resolveRef('../../../../etc/foo.js', 'deep/x/y/note.md');
  assert.ok(r.escape, 'flagged as escape');
  assert.strictEqual(r.resolved, null, 'not resolved');
});

test('§3.2 detectExtensionless: recognized only in specifier context', () => {
  const entries = mod.parseStatus('\trenamed:    src/a/foo.js -> src/a/foo-bar.js\n').entries;
  const hitReq = mod.detectExtensionless("const x = require('./foo');", entries);
  assert.strictEqual(hitReq.length, 1);
  assert.strictEqual(hitReq[0].stem, 'foo');
  const hitImport = mod.detectExtensionless("import x from '../foo'", entries);
  assert.strictEqual(hitImport.length, 1);
  // prose mention (not a specifier) -> not caught
  assert.strictEqual(mod.detectExtensionless('please see foo somewhere', entries).length, 0);
  // with extension -> not extensionless (handled by basename net)
  assert.strictEqual(mod.detectExtensionless("require('./foo.js')", entries).length, 0);
});

// =============================================================================
// §3.3 — classifier
// =============================================================================
test('§3.3 classify: covers all categories', () => {
  const p = mod.parseStatus(
    '\trenamed:    src/a/foo.js -> src/a/foo-bar.js\n' +
    '\trenamed:    src/a/keep.js -> src/b/keep.js\n' +   // dir-move (basename unchanged)
    '\trenamed:    src/a/config.js -> src/a/sess-config.js\n' +
    '\trenamed:    src/c/config.js -> src/c/task-config.js\n' + // collision
    '\tdeleted:    src/a/gone.js\n'
  );
  const idx = { byOldPath: p.byOldPath, byBasename: p.byBasename };

  // Provable rooted
  let c = mod.classify(mod.resolveRef('src/a/foo.js', 'docs/x.md'), idx, 'foo.js');
  assert.strictEqual(c.category, 'provable'); assert.strictEqual(c.sub, 'rooted');
  // Provable resolved (relative)
  c = mod.classify(mod.resolveRef('./foo.js', 'src/a/skill.md'), idx, 'foo.js');
  assert.strictEqual(c.category, 'provable'); assert.strictEqual(c.sub, 'resolved');
  // Dir-move
  c = mod.classify(mod.resolveRef('src/a/keep.js', 'docs/x.md'), idx, 'keep.js');
  assert.strictEqual(c.category, 'dirmove');
  // Deleted
  c = mod.classify(mod.resolveRef('src/a/gone.js', 'docs/x.md'), idx, 'gone.js');
  assert.strictEqual(c.category, 'deleted');
  // Ignored (resolves elsewhere, not renamed)
  c = mod.classify(mod.resolveRef('src/other/config.js', 'docs/x.md'), idx, 'config.js');
  assert.strictEqual(c.category, 'ignored');
  // Ambiguous unique (bare)
  c = mod.classify(mod.resolveRef('foo.js', 'docs/x.md'), idx, 'foo.js');
  assert.strictEqual(c.category, 'ambiguous'); assert.strictEqual(c.sub, 'unique');
  // Ambiguous collision (bare)
  c = mod.classify(mod.resolveRef('config.js', 'docs/x.md'), idx, 'config.js');
  assert.strictEqual(c.category, 'ambiguous'); assert.strictEqual(c.sub, 'collision');
  // Ambiguous variable
  c = mod.classify(mod.resolveRef('${FOO}/src/a/foo.js', 'docs/x.md'), idx, 'foo.js');
  assert.strictEqual(c.category, 'ambiguous'); assert.strictEqual(c.sub, 'variable');
});

// =============================================================================
// §3.4 — boundary matcher
// =============================================================================
test('§3.4 matchFullPath: terminator required', () => {
  assert.strictEqual(mod.matchFullPath('see src/a/foo.js"', 'src/a/foo.js').length, 1);
  assert.strictEqual(mod.matchFullPath('x src/a/foo.js.bak', 'src/a/foo.js').length, 0);
  assert.strictEqual(mod.matchFullPath('x src/a/foobar.js', 'src/a/foo.js').length, 0);
  assert.strictEqual(mod.matchFullPath('a src/a/foo.js and src/a/foo.js!', 'src/a/foo.js').length, 2);
});

test('§3.4 matchBasename: word-boundary', () => {
  assert.strictEqual(mod.matchBasename('use config.js here', 'config.js').length, 1);
  assert.strictEqual(mod.matchBasename('use myconfig.js here', 'config.js').length, 0);
  assert.strictEqual(mod.matchBasename('use config.json here', 'config.js').length, 0);
  assert.strictEqual(mod.matchBasename('use config-resolver.js here', 'config.js').length, 0);
  assert.strictEqual(mod.matchBasename('config.js and config.js', 'config.js').length, 2);
});

// =============================================================================
// §3.5 — style-preserving rewrite
// =============================================================================
test('§3.5 rewriteRef: rooted / relative / dir-move / leading ./', () => {
  const foo = { old: 'src/a/foo.js', new: 'src/a/foo-bar.js', kind: 'rename' };
  assert.strictEqual(mod.rewriteRef('src/a/foo.js', 'rooted', 'docs/x.md', foo), 'src/a/foo-bar.js');
  assert.strictEqual(mod.rewriteRef('./foo.js', 'relative', 'src/a/skill.md', foo), './foo-bar.js');
  assert.strictEqual(
    mod.rewriteRef('../../../src/a/foo.js', 'relative', 'deep/x/y/note.md', foo),
    '../../../src/a/foo-bar.js'
  );
  // relative dir-move: keep.js src/a -> src/b, referenced from src/a/skill.md
  const keep = { old: 'src/a/keep.js', new: 'src/b/keep.js', kind: 'rename' };
  assert.strictEqual(mod.rewriteRef('./keep.js', 'relative', 'src/a/skill.md', keep), '../b/keep.js');
});

// =============================================================================
// §3.6 — only-intended-change assertion
// =============================================================================
test('§3.6 assertOnlyIntended: PASS/FAIL/line-count/untouched-context', () => {
  const orig = 'a\nsee src/a/foo.js here\nb\n';
  const subs = [{ old: 'src/a/foo.js', new: 'src/a/foo-bar.js' }];
  // PASS: only the known swap
  const good = 'a\nsee src/a/foo-bar.js here\nb\n';
  assert.strictEqual(mod.assertOnlyIntended(orig, good, subs).ok, true);
  // FAIL: extra corruption on the changed line
  const corrupt = 'a\nsee src/a/foo-bar.js HERE\nb\n';
  assert.strictEqual(mod.assertOnlyIntended(orig, corrupt, subs).ok, false);
  // FAIL: line-count changed
  const extraLine = 'a\nsee src/a/foo-bar.js here\nb\nEXTRA\n';
  const r = mod.assertOnlyIntended(orig, extraLine, subs);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'line-count');
});

// =============================================================================
// §3.7 — collision pick
// =============================================================================
test('§3.7 pickForce: first-in-file wins; deterministic', () => {
  const p = mod.parseStatus(
    '\trenamed:    src/a/config.js -> src/a/sess-config.js\n' +
    '\trenamed:    src/c/config.js -> src/c/task-config.js\n'
  );
  const r1 = mod.pickForce('config.js', p.byBasename);
  assert.strictEqual(r1.chosen.old, 'src/a/config.js');
  assert.strictEqual(r1.alternatives.length, 1);
  assert.strictEqual(r1.alternatives[0].old, 'src/c/config.js');
  const r2 = mod.pickForce('config.js', p.byBasename);
  assert.deepStrictEqual(r1.chosen.old, r2.chosen.old); // deterministic
});

// =============================================================================
// §4 — identify integration (kitchen-sink)
// =============================================================================
function grepCount(out, label) {
  const re = new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*(\\d+)\\s*$', 'm');
  const m = out.match(re);
  return m ? parseInt(m[1], 10) : null;
}

test('§4 identify: golden category counts + confidence line + exit 0', () => {
  const { root } = buildKitchenSink();
  try {
    const r = runCli(['identify', 'git-status.txt', '--scan-root', root], root);
    assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
    const out = r.stdout;

    assert.strictEqual(grepCount(out, 'Safe fix (rooted)'), 5, 'rooted');
    assert.strictEqual(grepCount(out, 'Safe fix (resolved)'), 2, 'resolved');
    assert.strictEqual(grepCount(out, 'Dir-move (path-only)'), 1, 'dir-move');
    assert.strictEqual(grepCount(out, 'Ignored (elsewhere)'), 2, 'ignored');
    assert.strictEqual(grepCount(out, 'Ambiguous (unique)'), 1, 'amb-unique');
    assert.strictEqual(grepCount(out, 'Ambiguous (collision)'), 1, 'amb-collision');
    assert.strictEqual(grepCount(out, 'Ambiguous (variable)'), 1, 'amb-variable');
    assert.strictEqual(grepCount(out, 'Ambiguous (extless)'), 1, 'amb-extless');
    assert.strictEqual(grepCount(out, 'Deleted ref'), 1, 'deleted');

    assert.match(out, /total findings\s*:\s*15/, 'total');
    assert.match(out, /distinct files\s*:\s*10/, 'distinct files');
    assert.match(out, /files scanned:\s*11\b/, 'files scanned');
    assert.match(out, /Provable 7 · Dir-move 1 · Ambiguous 4 · Deleted 1 · Ignored 2/, 'confidence line');
  } finally { rm(root); }
});

test('§4 identify: category lines carry correct file:line', () => {
  const { root } = buildKitchenSink();
  try {
    const out = runCli(['identify', 'git-status.txt', '--scan-root', root], root).stdout;
    assert.match(out, /Safe fix \(rooted\):\s+docs\/readme\.md:1\s+\(src\/a\/foo\.js -> src\/a\/foo-bar\.js\)/);
    assert.match(out, /Safe fix \(resolved\):\s+src\/a\/skill\.md:1\s+\(\.\/foo\.js\s+->\s+\.\/foo-bar\.js\)\s+\[anchor: relative\]/);
    assert.match(out, /Dir-move \(path-only\):\s+src\/a\/skill\.md:2/);
    assert.match(out, /Deleted ref:\s+docs\/readme\.md:3/);
    assert.match(out, /Ambiguous \(variable\):\s+docs\/readme\.md:4/);
    assert.match(out, /Ambiguous \(extless\):\s+src\/z\/uses\.js:1/);
    assert.match(out, /Ambiguous \(collision\):\s+deep\/x\/y\/note\.md:2/);
  } finally { rm(root); }
});

test('§4 identify: ledger file written; stdout == ledger content', () => {
  const { root } = buildKitchenSink();
  try {
    const out = runCli(['identify', 'git-status.txt', '--scan-root', root], root).stdout;
    const ledger = fs.readFileSync(path.join(root, 'tpm-fix-git-rename-refs-ledger.txt'), 'utf8');
    assert.strictEqual(out, ledger, 'stdout identical to ledger file');
  } finally { rm(root); }
});

test('§4 identify: Ignored excludes src/other (resolves elsewhere, not Provable)', () => {
  const { root } = buildKitchenSink();
  try {
    const out = runCli(['identify', 'git-status.txt', '--scan-root', root], root).stdout;
    // src/other/config.js must appear under Ignored, never under a Safe fix line
    assert.match(out, /Ignored \(elsewhere\):\s+docs\/points-elsewhere\.md:1/);
    const safeLines = out.split('\n').filter((l) => l.startsWith('Safe fix'));
    assert.ok(!safeLines.some((l) => l.includes('src/other/config.js')), 'src/other never provable');
  } finally { rm(root); }
});

test('§4 identify: binary skipped, symlink not descended', () => {
  const { root } = buildKitchenSink();
  try {
    const out = runCli(['identify', 'git-status.txt', '--scan-root', root], root).stdout;
    assert.ok(!out.includes('assets/pic.bin'), 'binary not reported');
    assert.ok(!out.includes('link-dir'), 'symlink not descended / not reported as a finding');
    assert.match(out, /symlinks skipped:\s*1/, 'symlink counted skipped');
    assert.match(out, /binary skipped:\s*1/, 'binary counted skipped');
  } finally { rm(root); }
});

test('§4 identify: boundary safety — foo.js.bak / foobar.js not provable', () => {
  const { root } = buildKitchenSink();
  try {
    const out = runCli(['identify', 'git-status.txt', '--scan-root', root], root).stdout;
    // edge.md's foo.js.bak lands in Ignored (not renamed), foobar.js not matched at all
    assert.match(out, /Ignored \(elsewhere\):\s+docs\/edge\.md:1/);
    const safeLines = out.split('\n').filter((l) => l.startsWith('Safe fix'));
    assert.ok(!safeLines.some((l) => l.includes('edge.md')), 'edge.md never provable');
  } finally { rm(root); }
});

test('§4 identify: --json result + ambiguous worklist', () => {
  const { root } = buildKitchenSink();
  try {
    const r = runCli(['identify', 'git-status.txt', '--scan-root', root, '--json'], root);
    assert.strictEqual(r.status, 0);
    const result = JSON.parse(fs.readFileSync(path.join(root, 'tpm-fix-git-rename-refs-result.json'), 'utf8'));
    assert.strictEqual(result.counts.total, 15);
    assert.strictEqual(result.counts.provable, 7);
    assert.strictEqual(result.counts.ambiguous, 4);
    assert.strictEqual(result.findings.length, 15);
    const work = JSON.parse(fs.readFileSync(path.join(root, 'tpm-fix-git-rename-refs-ambiguous.json'), 'utf8'));
    assert.strictEqual(work.items.length, 4, 'worklist = ambiguous items');
    assert.ok(work.items.every((it) => it.category === 'ambiguous'));
  } finally { rm(root); }
});

test('§4 identify: --log mirrors stdout', () => {
  const { root } = buildKitchenSink();
  try {
    const logPath = path.join(root, 'run.log');
    const out = runCli(['identify', 'git-status.txt', '--scan-root', root, '--log', logPath], root).stdout;
    assert.strictEqual(fs.readFileSync(logPath, 'utf8'), out);
  } finally { rm(root); }
});

test('§4 identify: dead entry (with space.js has zero refs) reported', () => {
  const { root } = buildKitchenSink();
  try {
    const out = runCli(['identify', 'git-status.txt', '--scan-root', root], root).stdout;
    assert.match(out, /renames with no refs\s*:\s*1/);
    assert.match(out, /with space\.js/);
  } finally { rm(root); }
});

// =============================================================================
// §9 CLI / scoping / exit codes (Phase-1 relevant)
// =============================================================================
test('§9 --help exits 0 and prints usage', () => {
  const r = runCli(['--help'], os.tmpdir());
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /USAGE/);
});

test('§9 bad verb -> exit 2', () => {
  const r = runCli(['frobnicate', 'x.txt'], os.tmpdir());
  assert.strictEqual(r.status, 2);
});

test('§9 missing positional -> exit 2', () => {
  const r = runCli(['identify'], os.tmpdir());
  assert.strictEqual(r.status, 2);
});

test('§9 unreadable status file -> exit 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-fixrefs-'));
  try {
    const r = runCli(['identify', 'does-not-exist.txt', '--scan-root', dir], dir);
    assert.strictEqual(r.status, 1);
  } finally { rm(dir); }
});

test('§9 unknown option -> exit 2', () => {
  const r = runCli(['identify', 'x.txt', '--follow-symlinks'], os.tmpdir());
  assert.strictEqual(r.status, 2);
});

test('§9 --only limits to a subtree (repeatable)', () => {
  const { root } = buildKitchenSink();
  try {
    const out = runCli(['identify', 'git-status.txt', '--scan-root', root, '--only', 'docs'], root).stdout;
    // Only docs/* referencing files should appear
    assert.ok(out.includes('docs/readme.md'));
    assert.ok(!out.includes('src/a/skill.md'), 'skill.md excluded by --only docs');
    // union with a second --only
    const out2 = runCli(['identify', 'git-status.txt', '--scan-root', root, '--only', 'docs', '--only', 'src/a'], root).stdout;
    assert.ok(out2.includes('docs/readme.md') && out2.includes('src/a/skill.md'));
  } finally { rm(root); }
});

test('§9 --only-rename limits to that rename (repeatable), unknown is no-op not crash', () => {
  const { root } = buildKitchenSink();
  try {
    const r = runCli(['identify', 'git-status.txt', '--scan-root', root, '--only-rename', 'src/a/keep.js'], root);
    assert.strictEqual(r.status, 0);
    // Only keep.js references chased -> the dir-move finding present, foo.js refs gone
    assert.ok(r.stdout.includes('Dir-move'));
    assert.ok(!/Safe fix \(rooted\):\s+docs\/readme\.md:1/.test(r.stdout), 'foo.js refs not chased');
    // unknown --only-rename -> no crash, exit 0, zero findings for that filter
    const r2 = runCli(['identify', 'git-status.txt', '--scan-root', root, '--only-rename', 'nope/missing.js'], root);
    assert.strictEqual(r2.status, 0);
    assert.match(r2.stdout, /total findings\s*:\s*0/);
  } finally { rm(root); }
});

test('§9 --exclude glob excludes matched paths', () => {
  const { root } = buildKitchenSink();
  try {
    const out = runCli(['identify', 'git-status.txt', '--scan-root', root, '--exclude', 'docs/*'], root).stdout;
    assert.ok(!out.includes('docs/readme.md'), 'docs excluded');
    assert.ok(out.includes('src/a/skill.md'), 'non-excluded still present');
  } finally { rm(root); }
});

// =============================================================================
// Phase-2 UNIT tests — new pure helpers
// =============================================================================
test('P2 boundarySafeReplace: replaces only boundary-safe full-path hits, no re-match', () => {
  // standalone hit replaced; .bak / foobar / ~ / ${…}-prefix hits protected
  assert.strictEqual(mod.boundarySafeReplace('see src/a/foo.js"', 'src/a/foo.js', 'src/a/foo-bar.js'), 'see src/a/foo-bar.js"');
  assert.strictEqual(mod.boundarySafeReplace('src/a/foo.js.bak', 'src/a/foo.js', 'X'), 'src/a/foo.js.bak');
  assert.strictEqual(mod.boundarySafeReplace('src/a/foobar.js', 'src/a/foo.js', 'X'), 'src/a/foobar.js');
  assert.strictEqual(mod.boundarySafeReplace('src/a/foo.js~', 'src/a/foo.js', 'X'), 'src/a/foo.js~', '~ is path-cont (note #3)');
  assert.strictEqual(mod.boundarySafeReplace('${V}/src/a/foo.js', 'src/a/foo.js', 'X'), '${V}/src/a/foo.js', 'preceded by /');
  // no re-match of a freshly written token
  assert.strictEqual(mod.boundarySafeReplace('a a', 'a', 'aa'), 'aa aa');
});

test('P2 basenameSafeReplace: word-boundary swap', () => {
  assert.strictEqual(mod.basenameSafeReplace('use config.js here', 'config.js', 'sess-config.js'), 'use sess-config.js here');
  assert.strictEqual(mod.basenameSafeReplace('myconfig.js', 'config.js', 'X'), 'myconfig.js');
  assert.strictEqual(mod.basenameSafeReplace('config.js and config.js', 'config.js', 'X'), 'X and X');
});

test('P2 applyProvableSubs: longest-OLD-first, no prefix clobber', () => {
  const subs = [
    { old: 'src/a', new: 'DIR' },              // shorter prefix
    { old: 'src/a/foo.js', new: 'src/a/foo-bar.js' }, // longer
  ];
  // longer applied first; boundary safety keeps `src/a` from biting inside the path
  assert.strictEqual(mod.applyProvableSubs('x src/a/foo.js and src/a end', subs), 'x src/a/foo-bar.js and DIR end');
});

test('P2 assertOnlyIntended: note #2 — overlapping substring is NOT a false unexpected-delta', () => {
  // line has the provable path AND a longer path that merely contains it as a prefix; only the
  // standalone one is rewritten. A naive split/join asserter would flag this; the boundary-safe one must not.
  const orig = 'ref src/a/foo.js and src/a/foo.js.bak\n';
  const modified = 'ref src/a/foo-bar.js and src/a/foo.js.bak\n';
  const subs = [{ old: 'src/a/foo.js', new: 'src/a/foo-bar.js' }];
  assert.strictEqual(mod.assertOnlyIntended(orig, modified, subs).ok, true);
  // but a genuine extra change on that line still fails
  const bad = 'ref src/a/foo-bar.js and src/a/foo.js.bak EXTRA\n';
  assert.strictEqual(mod.assertOnlyIntended(orig, bad, subs).ok, false);
});

test('P2 detectExtensionless: note #4 — extensionless-file rename not double-counted', () => {
  // rename of a file that itself has NO extension: require('./tool') must be caught by the basename net,
  // NOT also flagged extensionless (that would double-count the same hit).
  const entries = mod.parseStatus('\trenamed:    bin/tool -> bin/cli\n').entries;
  assert.strictEqual(mod.detectExtensionless("const x = require('./tool');", entries).length, 0, 'no extless double-count');
  // control: a WITH-extension rename still detects the extensionless specifier
  const e2 = mod.parseStatus('\trenamed:    src/a/foo.js -> src/a/foo-bar.js\n').entries;
  assert.strictEqual(mod.detectExtensionless("require('./foo')", e2).length, 1);
});

test('P2 hashContent + computeItemId: deterministic + content-anchored (Decision A)', () => {
  assert.strictEqual(mod.hashContent('abc'), mod.hashContent(Buffer.from('abc')));
  const f = { file: 'a.md', token: 'foo.js', base: 'foo.js', line: 3, text: 'see foo.js here' };
  assert.strictEqual(mod.computeItemId(f), mod.computeItemId({ ...f }), 'stable');
  // itemId is content-anchored: the line number is NOT folded in, so the same reference (same content)
  // at a different line yields the SAME id (was: notStrictEqual under the old line-based scheme).
  assert.strictEqual(mod.computeItemId(f), mod.computeItemId({ ...f, line: 4 }), 'line no longer changes id');
});

test('P2 computeItemId (a): same reference at different line numbers -> same id (content window)', () => {
  // Identical surrounding content window, different absolute line numbers -> identical id.
  const win = 'ctx above\nsee foo.js here\nctx below';
  const a = { file: 'docs/a.md', token: 'foo.js', base: 'foo.js', line: 3, window: win };
  const b = { file: 'docs/a.md', token: 'foo.js', base: 'foo.js', line: 120, window: win };
  assert.strictEqual(mod.computeItemId(a), mod.computeItemId(b));
  // buildContentWindow normalizes whitespace per line, so whitespace reflow yields the same window
  // (and therefore the same id) — the scan-time source of the id's stability.
  const linesA = ['ctx above', 'see foo.js here', 'ctx below'];
  const linesB = ['ctx   above', 'see   foo.js  here', 'ctx below'];
  assert.strictEqual(mod.buildContentWindow(linesA, 1), mod.buildContentWindow(linesB, 1), 'whitespace-normalized window');
});

test('P2 computeItemId (b): distinct references (different surrounding content) -> different ids', () => {
  const a = { file: 'docs/a.md', token: 'foo.js', base: 'foo.js', window: 'alpha\nsee foo.js here\nbeta' };
  const b = { file: 'docs/a.md', token: 'foo.js', base: 'foo.js', window: 'gamma\nsee foo.js here\ndelta' };
  assert.notStrictEqual(mod.computeItemId(a), mod.computeItemId(b), 'different windows -> different ids');
  // different file, same window -> different id
  const c = { file: 'docs/OTHER.md', token: 'foo.js', base: 'foo.js', window: 'alpha\nsee foo.js here\nbeta' };
  assert.notStrictEqual(mod.computeItemId(a), mod.computeItemId(c), 'file participates in id');
});

test('P2 computeItemId (c): deterministic across repeated calls', () => {
  const f = { file: 'a.md', token: 'foo.js', base: 'foo.js', window: 'x\nfoo.js\ny' };
  const id1 = mod.computeItemId(f);
  const id2 = mod.computeItemId({ ...f });
  const id3 = mod.computeItemId({ ...f });
  assert.strictEqual(id1, id2);
  assert.strictEqual(id2, id3);
  assert.match(id1, /^[0-9a-f]{16}$/, '16 hex chars');
});

test('P2 disambiguateItemIds: genuine window collision gets a deterministic ordinal', () => {
  // Two truly-identical ambiguous refs sharing an identical (file, token, window) collide; the helper
  // keeps the first bare and appends an occurrence ordinal to the rest, deterministically.
  const mk = () => ({ category: 'ambiguous', sub: 'unique', file: 'a.md', token: 'foo.js', base: 'foo.js', window: 'p\nfoo.js\nq' });
  const f1 = mk(); const f2 = mk(); const f3 = mk();
  mod.disambiguateItemIds([f1, f2, f3]);
  const ids = [f1, f2, f3].map(mod.computeItemId);
  assert.strictEqual(new Set(ids).size, 3, 'all three ids distinct after disambiguation');
  assert.strictEqual(f1.idOccurrence, 0, 'first keeps bare id');
  assert.ok(f2.idOccurrence === 1 && f3.idOccurrence === 2, 'subsequent get ordinals');
  // deterministic: a second run over freshly-built identical findings yields the same ids in order
  const g = [mk(), mk(), mk()]; mod.disambiguateItemIds(g);
  assert.deepStrictEqual(g.map(mod.computeItemId), ids);
});

test('P2 ambiguousGate: suppression subtracts by itemId', () => {
  const f = { category: 'ambiguous', sub: 'unique', file: 'a.md', token: 'only.js', base: 'only.js', line: 1, text: 'only.js', entries: [{ oldBase: 'only.js', newBase: 'only-1.js' }] };
  const id = mod.computeItemId(f);
  assert.strictEqual(mod.ambiguousGate([f], new Set(), false).remaining, 1);
  assert.strictEqual(mod.ambiguousGate([f], new Set([id]), false).remaining, 0);
});

// =============================================================================
// Phase-2 fix fixtures
// =============================================================================
// buildFixTree: a small mutating-fix fixture whose NEW targets actually exist on disk (so the
// new-target-exists lint passes). Returns { root, statusPath }.
function buildFixTree(extra = {}) {
  const status =
    'On branch main\n' +
    '\trenamed:    src/a/foo.js -> src/a/foo-bar.js\n' +
    '\trenamed:    src/a/keep.js -> src/b/keep.js\n' +          // dir-move
    '\trenamed:    src/a/only.js -> src/a/only-1.js\n' +        // unique basename (force-clean)
    '\trenamed:    src/a/config.js -> src/a/sess-config.js\n' + // collision 1
    '\trenamed:    src/c/config.js -> src/c/task-config.js\n' + // collision 2
    '\tdeleted:    src/a/gone.js\n';
  const spec = Object.assign({
    'git-status.txt': status,
    // NEW targets exist on disk:
    'src/a/foo-bar.js': 'x', 'src/b/keep.js': 'x', 'src/a/only-1.js': 'x',
    'src/a/sess-config.js': 'x', 'src/c/task-config.js': 'x',
  }, extra);
  const root = makeTree(spec);
  return { root, statusPath: path.join(root, 'git-status.txt') };
}

// =============================================================================
// §5 — fix (normal, mutating)
// =============================================================================
test('§5 fix: rewrites only Provable; ambiguous/ignored/deleted/variable untouched; byte-exact', () => {
  const { root } = buildFixTree({
    'docs/readme.md':
      'rooted src/a/foo.js here\n' +          // provable rooted -> changed
      'bare foo.js prose\n' +                 // ambiguous -> untouched
      'deleted src/a/gone.js gone\n' +        // deleted -> untouched
      'templated ${FOO}/src/a/foo.js x\n',    // variable -> untouched
    'src/a/skill.md': 'relative ./foo.js\n',  // provable resolved -> changed
  });
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root], root);
    assert.strictEqual(r.status, 0, `exit0 stderr=${r.stderr}`);
    assert.strictEqual(fs.readFileSync(path.join(root, 'docs/readme.md'), 'utf8'),
      'rooted src/a/foo-bar.js here\nbare foo.js prose\ndeleted src/a/gone.js gone\ntemplated ${FOO}/src/a/foo.js x\n');
    assert.strictEqual(fs.readFileSync(path.join(root, 'src/a/skill.md'), 'utf8'), 'relative ./foo-bar.js\n');
    // no .tmp left behind anywhere
    const after = readTree(root);
    assert.ok(!Object.keys(after).some((k) => /\.tmp\d?$/.test(k)), 'no temp files left');
  } finally { rm(root); }
});

test('§5 fix: dir-move via resolvable relative ref IS fixed; bare dir-move NOT', () => {
  const { root } = buildFixTree({
    'src/a/skill.md': 'dirmove ./keep.js\n',   // relative -> src/a/keep.js -> src/b/keep.js (fixable)
    'docs/bare.md': 'just keep.js bare\n',      // bare -> ambiguous, NOT fixed
  });
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root], root);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(fs.readFileSync(path.join(root, 'src/a/skill.md'), 'utf8'), 'dirmove ../b/keep.js\n');
    assert.strictEqual(fs.readFileSync(path.join(root, 'docs/bare.md'), 'utf8'), 'just keep.js bare\n', 'bare untouched');
  } finally { rm(root); }
});

test('§5 fix: abort+restore on unexpected delta; other files still succeed; exit non-zero', () => {
  const { root } = buildFixTree({
    'a.md': 'rooted src/a/foo.js one\n',   // will be corrupted -> aborted+restored
    'b.md': 'rooted src/a/foo.js two\n',   // succeeds
  });
  const before = fs.readFileSync(path.join(root, 'a.md'));
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root], root, { TPM_FIX_GIT_RENAME_TEST_CORRUPT: 'a.md' });
    assert.strictEqual(r.status, 4, 'file-failed exit code');
    assert.match(r.stdout, /failed: a\.md.*restored=true/);
    assert.ok(fs.readFileSync(path.join(root, 'a.md')).equals(before), 'a.md restored byte-identical');
    assert.strictEqual(fs.readFileSync(path.join(root, 'b.md'), 'utf8'), 'rooted src/a/foo-bar.js two\n', 'b.md still fixed');
    const after = readTree(root);
    assert.ok(!Object.keys(after).some((k) => /\.tmp\d?$/.test(k)), 'no temp left after abort');
  } finally { rm(root); }
});

test('§5 fix: new-target-missing -> failed, original NOT rewritten', () => {
  // craft a rename whose NEW path does not exist in the tree
  const root = makeTree({
    'git-status.txt': 'On branch main\n\trenamed:    src/a/foo.js -> src/a/moved.js\n',
    'ref.md': 'see src/a/foo.js here\n',
  });
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root], root);
    assert.strictEqual(r.status, 4);
    assert.match(r.stdout, /failed: ref\.md.*new-target-missing/);
    assert.strictEqual(fs.readFileSync(path.join(root, 'ref.md'), 'utf8'), 'see src/a/foo.js here\n', 'not rewritten');
  } finally { rm(root); }
});

test('§5 fix: idempotency — second run makes zero changes, exit 0', () => {
  const { root } = buildFixTree({ 'ref.md': 'rooted src/a/foo.js x\n' });
  try {
    runCli(['fix', 'git-status.txt', '--scan-root', root], root);
    const afterFirst = fs.readFileSync(path.join(root, 'ref.md'));
    const r2 = runCli(['fix', 'git-status.txt', '--scan-root', root], root);
    assert.strictEqual(r2.status, 0);
    assert.ok(fs.readFileSync(path.join(root, 'ref.md')).equals(afterFirst), 'unchanged on 2nd run');
    assert.match(r2.stdout, /files changed : 0/);
  } finally { rm(root); }
});

// =============================================================================
// §6 — fix --dry
// =============================================================================
test('§6 fix --dry: originals byte-identical; tmp1/tmp2 lifecycle; dry/real parity', () => {
  const { root: dryRoot } = buildFixTree({ 'ref.md': 'rooted src/a/foo.js x\nrelative refs none\n' });
  const { root: realRoot } = buildFixTree({ 'ref.md': 'rooted src/a/foo.js x\nrelative refs none\n' });
  try {
    const before = fs.readFileSync(path.join(dryRoot, 'ref.md'));
    const rd = runCli(['fix', 'git-status.txt', '--scan-root', dryRoot, '--dry'], dryRoot);
    assert.strictEqual(rd.status, 0);
    assert.ok(fs.readFileSync(path.join(dryRoot, 'ref.md')).equals(before), 'original untouched by --dry');
    const after = readTree(dryRoot);
    assert.ok(!Object.keys(after).some((k) => /\.tmp[12]$/.test(k)), 'no tmp1/tmp2 left');
    assert.match(rd.stdout, /would-change: ref\.md/);
    // parity: what real fix produces
    runCli(['fix', 'git-status.txt', '--scan-root', realRoot], realRoot);
    assert.strictEqual(fs.readFileSync(path.join(realRoot, 'ref.md'), 'utf8'), 'rooted src/a/foo-bar.js x\nrelative refs none\n');
  } finally { rm(dryRoot); rm(realRoot); }
});

test('§6 fix --force --dry: previews forced changes, originals untouched', () => {
  const { root } = buildFixTree({ 'ref.md': 'bare only.js here\n' });
  const before = fs.readFileSync(path.join(root, 'ref.md'));
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root, '--force', '--dry'], root);
    assert.strictEqual(r.status, 0);
    assert.ok(fs.readFileSync(path.join(root, 'ref.md')).equals(before), 'original untouched');
    assert.match(r.stdout, /only\.js -> only-1\.js/);
  } finally { rm(root); }
});

// =============================================================================
// §7 — fix --force
// =============================================================================
test('§7 fix --force: unique basename clean swap', () => {
  const { root } = buildFixTree({ 'ref.md': 'bare only.js here\n' });
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root, '--force'], root);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(fs.readFileSync(path.join(root, 'ref.md'), 'utf8'), 'bare only-1.js here\n');
  } finally { rm(root); }
});

test('§7 fix --force: collision winner applied; all candidates listed with full OLD -> NEW', () => {
  const { root } = buildFixTree({ 'ref.md': 'bare config.js here\n' });
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root, '--force'], root);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(fs.readFileSync(path.join(root, 'ref.md'), 'utf8'), 'bare sess-config.js here\n', 'first-in-file winner');
    assert.match(r.stdout, /src\/a\/config\.js\s+->\s+src\/a\/sess-config\.js\s+◀ CHOSEN/);
    assert.match(r.stdout, /src\/c\/config\.js\s+->\s+src\/c\/task-config\.js/, 'alternative full status line shown');
  } finally { rm(root); }
});

test('§7 fix --force: dir-move winner -> NO textual change reported', () => {
  // keep.js is a dir-move (basename unchanged) and unique -> force can't help
  const { root } = buildFixTree({ 'ref.md': 'bare keep.js here\n' });
  const before = fs.readFileSync(path.join(root, 'ref.md'));
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root, '--force'], root);
    assert.match(r.stdout, /NO-OP/);
    assert.match(r.stdout, /Result: NO textual fix applied/);
    assert.ok(fs.readFileSync(path.join(root, 'ref.md')).equals(before), 'unchanged (basename-global no-op)');
  } finally { rm(root); }
});

test('§7 fix --force: extensionless still excluded; variable-prefixed basename swapped', () => {
  const { root } = buildFixTree({
    'src/z/uses.js': "const x = require('./foo');\n",   // extless: never fixed even under --force
    'docs/v.md': 'templated ${FOO}/only.js here\n',      // variable-prefixed: basename swapped
  });
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root, '--force'], root);
    assert.strictEqual(fs.readFileSync(path.join(root, 'src/z/uses.js'), 'utf8'), "const x = require('./foo');\n", 'extless untouched');
    assert.strictEqual(fs.readFileSync(path.join(root, 'docs/v.md'), 'utf8'), 'templated ${FOO}/only-1.js here\n', 'variable prefix irrelevant');
  } finally { rm(root); }
});

// =============================================================================
// Change 1 — per-substitution --force exemption (Decision C refined)
// A file that gets BOTH a PROVABLE rewrite AND a FORCED (ambiguous/basename) swap must still have its
// PROVABLE region strictly asserted; only the forced-basename change is exempt. (Previously any forced
// sub exempted the WHOLE file, so a corrupted provable rewrite could slip through — the verifier hole.)
// =============================================================================
test('Change1 assertProvableExemptForced: asserts provable region, exempts only listed forced subs', () => {
  const orig = 'a\nsee src/a/foo.js and only.js here\nb\n';
  const prov = [{ old: 'src/a/foo.js', new: 'src/a/foo-bar.js' }];
  const forced = [{ old: 'only.js', new: 'only-1.js' }];
  // exact writer output (provable first, then forced) -> ok
  const good = 'a\nsee src/a/foo-bar.js and only-1.js here\nb\n';
  assert.strictEqual(mod.assertProvableExemptForced(orig, good, prov, forced).ok, true, 'both changes explained -> ok');
  // collateral/corruption on the changed (provable) line -> caught
  const badCollateral = 'a\nsee src/a/foo-bar.js and only-1.js here!\nb\n';
  const rc = mod.assertProvableExemptForced(orig, badCollateral, prov, forced);
  assert.strictEqual(rc.ok, false, 'unexpected delta on a provable-touched line -> fail');
  assert.strictEqual(rc.reason, 'unexpected-delta');
  // a change NOT explained by any listed prov/forced sub -> caught (forced exemption is per-listed-sub)
  const badUnlisted = 'a\nsee src/a/foo-bar.js and QUUX.js here\nb\n';
  assert.strictEqual(mod.assertProvableExemptForced(orig, badUnlisted, prov, forced).ok, false, 'unlisted change -> fail');
  // line-count change -> caught
  assert.strictEqual(mod.assertProvableExemptForced(orig, good + 'x\n', prov, forced).reason, 'line-count');
  // with no forced subs it is equivalent to the plain provable assertion
  const provOnly = 'a\nsee src/a/foo-bar.js and only.js here\nb\n';
  assert.strictEqual(mod.assertProvableExemptForced(orig, provOnly, prov, []).ok, true, 'no forced -> plain provable assertion');
});

test('Change1 --force mixed file: provable rewritten + forced swapped; provable asserted OK; exit 0', () => {
  const { root } = buildFixTree({
    'mix.md': 'rooted src/a/foo.js and bare only.js\n',  // provable rooted + forced ambiguous basename
    'forced.md': 'bare only.js here\n',                   // forced-only file (stays exempt)
  });
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root, '--force'], root);
    assert.strictEqual(r.status, 0, `exit0 stderr=${r.stderr}`);
    assert.strictEqual(fs.readFileSync(path.join(root, 'mix.md'), 'utf8'),
      'rooted src/a/foo-bar.js and bare only-1.js\n', 'both the provable and the forced sub applied');
    assert.strictEqual(fs.readFileSync(path.join(root, 'forced.md'), 'utf8'),
      'bare only-1.js here\n', 'forced-only file applied');
  } finally { rm(root); }
});

test('Change1 --force mixed file: corrupted PROVABLE rewrite -> abort+restore+exit4; forced-only file still applies', () => {
  // The exact hole the verifier demonstrated: with the OLD whole-file exemption, any forced sub made the
  // file skip the assertion, so a corrupted provable rewrite passed silently (exit 0). Per-substitution,
  // the provable region is still asserted -> the injected delta is caught -> abort + restore + exit 4.
  const { root } = buildFixTree({
    'mix.md': 'rooted src/a/foo.js and bare only.js\n',  // corrupted -> must abort
    'forced.md': 'bare only.js here\n',                   // forced-only, not corrupted -> still applies
  });
  const before = fs.readFileSync(path.join(root, 'mix.md'));
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root, '--force'], root, { TPM_FIX_GIT_RENAME_TEST_CORRUPT: 'mix.md' });
    assert.strictEqual(r.status, 4, 'corrupted provable rewrite under --force must NOT silently pass');
    assert.match(r.stdout, /failed: mix\.md.*restored=true/, 'mix.md aborted + restored');
    assert.ok(fs.readFileSync(path.join(root, 'mix.md')).equals(before), 'mix.md restored byte-identical');
    assert.strictEqual(fs.readFileSync(path.join(root, 'forced.md'), 'utf8'),
      'bare only-1.js here\n', 'forced-only file in the same run still applies');
    const after = readTree(root);
    assert.ok(!Object.keys(after).some((k) => /\.tmp\d?$/.test(k)), 'no temp left after abort');
  } finally { rm(root); }
});

// =============================================================================
// §8 — safety / edge cases
// =============================================================================
test('§8 temp-collision: pre-existing <file>.tmp -> file skipped; bystander not edited/deleted', () => {
  const { root } = buildFixTree({ 'ref.md': 'rooted src/a/foo.js x\n', 'ref.md.tmp': 'BYSTANDER CONTENTS' });
  const bystanderBefore = fs.readFileSync(path.join(root, 'ref.md.tmp'));
  const origBefore = fs.readFileSync(path.join(root, 'ref.md'));
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root], root);
    assert.match(r.stdout, /skipped: ref\.md.*already exists/);
    assert.ok(fs.readFileSync(path.join(root, 'ref.md')).equals(origBefore), 'original untouched');
    assert.ok(fs.readFileSync(path.join(root, 'ref.md.tmp')).equals(bystanderBefore), 'bystander .tmp unchanged & present');
  } finally { rm(root); }
});

test('§8 temp-collision (--dry): pre-existing <file>.tmp1 -> file skipped, bystander safe', () => {
  const { root } = buildFixTree({ 'ref.md': 'rooted src/a/foo.js x\n', 'ref.md.tmp1': 'BYSTANDER' });
  const bystander = fs.readFileSync(path.join(root, 'ref.md.tmp1'));
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root, '--dry'], root);
    assert.match(r.stdout, /skipped: ref\.md/);
    assert.ok(fs.readFileSync(path.join(root, 'ref.md.tmp1')).equals(bystander), 'bystander tmp1 unchanged');
  } finally { rm(root); }
});

test('§8 cleanup deletes only ours: stray random.tmp survives, unreported', () => {
  const { root } = buildFixTree({ 'ref.md': 'rooted src/a/foo.js x\n', 'junk/random.tmp': 'STRAY' });
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root], root);
    assert.strictEqual(r.status, 0);
    assert.ok(fs.existsSync(path.join(root, 'junk/random.tmp')), 'stray survives');
    assert.ok(!r.stdout.includes('random.tmp'), 'stray not reported');
  } finally { rm(root); }
});

test('§8 byte-exact: CRLF / BOM / no-final-newline preserved, only token changed', () => {
  const { root } = buildFixTree({
    'crlf.md': Buffer.from('line src/a/foo.js\r\nsecond\r\n', 'utf8'),
    'bom.md': Buffer.from('﻿head src/a/foo.js tail\n', 'utf8'),
    'nonl.txt': Buffer.from('src/a/foo.js no newline', 'utf8'),
  });
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root], root);
    assert.strictEqual(r.status, 0);
    assert.ok(fs.readFileSync(path.join(root, 'crlf.md')).equals(Buffer.from('line src/a/foo-bar.js\r\nsecond\r\n', 'utf8')), 'CRLF kept');
    assert.ok(fs.readFileSync(path.join(root, 'bom.md')).equals(Buffer.from('﻿head src/a/foo-bar.js tail\n', 'utf8')), 'BOM kept');
    assert.ok(fs.readFileSync(path.join(root, 'nonl.txt')).equals(Buffer.from('src/a/foo-bar.js no newline', 'utf8')), 'no final NL kept');
  } finally { rm(root); }
});

test('§8 boundary: foo.js.bak / foobar.js not rewritten by the src/a/foo.js rule', () => {
  const { root } = buildFixTree({ 'edge.md': 'backup src/a/foo.js.bak and src/a/foobar.js and src/a/foo.js real\n' });
  try {
    runCli(['fix', 'git-status.txt', '--scan-root', root], root);
    assert.strictEqual(fs.readFileSync(path.join(root, 'edge.md'), 'utf8'),
      'backup src/a/foo.js.bak and src/a/foobar.js and src/a/foo-bar.js real\n', 'only the standalone path changed');
  } finally { rm(root); }
});

test('§8 symlink: never fixed through a symlinked file', () => {
  const { root } = buildFixTree({ 'realdir/ref.md': 'rooted src/a/foo.js x\n', 'link.md': { symlink: 'realdir/ref.md' } });
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root], root);
    // the symlink itself is never followed as a fix target; real file (scanned) is fixed normally
    assert.strictEqual(fs.readFileSync(path.join(root, 'realdir/ref.md'), 'utf8'), 'rooted src/a/foo-bar.js x\n');
    const st = fs.lstatSync(path.join(root, 'link.md'));
    assert.ok(st.isSymbolicLink(), 'symlink still a symlink');
    assert.strictEqual(r.status, 0);
  } finally { rm(root); }
});

test('§8 multiple hits per line all rewritten', () => {
  const { root } = buildFixTree({ 'ref.md': 'x src/a/foo.js and src/a/foo.js again\n' });
  try {
    runCli(['fix', 'git-status.txt', '--scan-root', root], root);
    assert.strictEqual(fs.readFileSync(path.join(root, 'ref.md'), 'utf8'), 'x src/a/foo-bar.js and src/a/foo-bar.js again\n');
  } finally { rm(root); }
});

// =============================================================================
// §9 — fix scoping + gate
// =============================================================================
test('§9 fix: --only / --only-rename repeatable scoping', () => {
  const { root } = buildFixTree({
    'docs/a.md': 'rooted src/a/foo.js here\n',
    'src/keep/b.md': 'rooted src/a/only.js here\n',   // provable? only.js rooted -> src/a/only.js -> provable
  });
  try {
    // --only docs limits edits to docs/*
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root, '--only', 'docs'], root);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(fs.readFileSync(path.join(root, 'docs/a.md'), 'utf8'), 'rooted src/a/foo-bar.js here\n');
    assert.strictEqual(fs.readFileSync(path.join(root, 'src/keep/b.md'), 'utf8'), 'rooted src/a/only.js here\n', 'outside --only untouched');
  } finally { rm(root); }
});

test('§9 fix: --only-rename limits to that rename only', () => {
  const { root } = buildFixTree({ 'ref.md': 'rooted src/a/foo.js and rooted src/a/only.js\n' });
  try {
    runCli(['fix', 'git-status.txt', '--scan-root', root, '--only-rename', 'src/a/foo.js'], root);
    assert.strictEqual(fs.readFileSync(path.join(root, 'ref.md'), 'utf8'),
      'rooted src/a/foo-bar.js and rooted src/a/only.js\n', 'only foo.js chased');
  } finally { rm(root); }
});

test('§9/§18.1 --fail-on-ambiguous + --suppress gate', () => {
  const { root } = buildFixTree({ 'ref.md': 'bare only.js ambiguous here\n' });
  try {
    // ambiguous present -> gate trips (exit 5)
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root, '--fail-on-ambiguous'], root);
    assert.strictEqual(r.status, 5, 'gate trips on remaining ambiguous');
    // build a suppress file from the identify worklist itemId, then gate should pass
    runCli(['identify', 'git-status.txt', '--scan-root', root, '--json'], root);
    const work = JSON.parse(fs.readFileSync(path.join(root, 'tpm-fix-git-rename-refs-ambiguous.json'), 'utf8'));
    const ids = work.items.map((it) => it.itemId).filter(Boolean);
    assert.ok(ids.length >= 1, 'worklist carries itemId');
    const supPath = path.join(root, 'disposed.json');
    fs.writeFileSync(supPath, JSON.stringify({ suppressed: ids }));
    const r2 = runCli(['fix', 'git-status.txt', '--scan-root', root, '--fail-on-ambiguous', '--suppress', supPath], root);
    assert.strictEqual(r2.status, 0, 'suppressed items do not trip the gate');
  } finally { rm(root); }
});

test('§9/§18.1 identify honors --fail-on-ambiguous (exit 5); plain identify stays 0', () => {
  const { root } = buildFixTree({ 'ref.md': 'bare only.js here\n' });
  try {
    assert.strictEqual(runCli(['identify', 'git-status.txt', '--scan-root', root], root).status, 0, 'plain identify always 0');
    assert.strictEqual(runCli(['identify', 'git-status.txt', '--scan-root', root, '--fail-on-ambiguous'], root).status, 5);
  } finally { rm(root); }
});

// =============================================================================
// §18 — apply-plan
// =============================================================================
function makePlanTree() {
  const root = makeTree({
    'skills/s.md': 'run tpm-old.js now\nsee tpm-old.js and tpm-old.js twice\n',
    'lib/dst.js': 'x', // a new-target that DOES exist (for rooted newText checks)
  });
  return { root, hash: fileHash(path.join(root, 'skills/s.md')) };
}

test('§18 apply-plan: happy path, occurrence addressing, suppression entries, exit 0', () => {
  const { root, hash } = makePlanTree();
  try {
    const plan = { edits: [
      { itemId: 'id1', file: 'skills/s.md', anchor: { line: 1, occurrence: 1 }, oldText: 'tpm-old.js', newText: 'tpm-new.js', expectHash: hash },
      { itemId: 'id2', file: 'skills/s.md', anchor: { line: 2, occurrence: 2 }, oldText: 'tpm-old.js', newText: 'tpm-new.js', expectHash: hash },
    ] };
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
    const r = runCli(['apply-plan', 'plan.json', '--scan-root', root], root);
    assert.strictEqual(r.status, 0, `stderr=${r.stderr}`);
    // line 2 occurrence 1 stays old; occurrence 2 changes -> overreach structurally blocked
    assert.strictEqual(fs.readFileSync(path.join(root, 'skills/s.md'), 'utf8'), 'run tpm-new.js now\nsee tpm-old.js and tpm-new.js twice\n');
    assert.match(r.stdout, /applied\s*:\s*2/);
    assert.match(r.stdout, /Suppression entries/);
    const sup = JSON.parse(fs.readFileSync(path.join(root, 'tpm-fix-git-rename-refs-suppress.json'), 'utf8'));
    assert.deepStrictEqual(sup.suppressed.sort(), ['id1', 'id2']);
  } finally { rm(root); }
});

test('§18 apply-plan: stale expectHash -> skipped-stale, exit non-zero, file untouched', () => {
  const { root } = makePlanTree();
  const before = fs.readFileSync(path.join(root, 'skills/s.md'));
  try {
    const plan = { edits: [{ itemId: 'id1', file: 'skills/s.md', anchor: { line: 1, occurrence: 1 }, oldText: 'tpm-old.js', newText: 'tpm-new.js', expectHash: 'deadbeef' }] };
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
    const r = runCli(['apply-plan', 'plan.json', '--scan-root', root], root);
    assert.strictEqual(r.status, 6);
    assert.match(r.stdout, /skipped-stale\s*:\s*1/);
    assert.ok(fs.readFileSync(path.join(root, 'skills/s.md')).equals(before), 'untouched');
  } finally { rm(root); }
});

test('§18 apply-plan: text-mismatch (notfound) -> skipped, exit non-zero, file untouched', () => {
  const { root, hash } = makePlanTree();
  const before = fs.readFileSync(path.join(root, 'skills/s.md'));
  try {
    const plan = { edits: [{ itemId: 'id1', file: 'skills/s.md', anchor: { line: 1, occurrence: 1 }, oldText: 'NOT-PRESENT.js', newText: 'x.js', expectHash: hash }] };
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
    const r = runCli(['apply-plan', 'plan.json', '--scan-root', root], root);
    assert.strictEqual(r.status, 6);
    assert.match(r.stdout, /skipped-notfound\s*:\s*1/);
    assert.ok(fs.readFileSync(path.join(root, 'skills/s.md')).equals(before), 'untouched');
  } finally { rm(root); }
});

test('§18 apply-plan: injection/overreach blocked — col addressing changes exactly one spot', () => {
  const { root, hash } = makePlanTree();
  try {
    // oldText occurs 3x total; a single col-addressed edit must change ONLY the addressed one
    const line2 = 'see tpm-old.js and tpm-old.js twice';
    const col = line2.indexOf('tpm-old.js') + 1; // 1-based col of the FIRST occurrence on line 2
    const plan = { edits: [{ itemId: 'id1', file: 'skills/s.md', anchor: { line: 2, col }, oldText: 'tpm-old.js', newText: 'tpm-new.js', expectHash: hash }] };
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
    const r = runCli(['apply-plan', 'plan.json', '--scan-root', root], root);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(fs.readFileSync(path.join(root, 'skills/s.md'), 'utf8'),
      'run tpm-old.js now\nsee tpm-new.js and tpm-old.js twice\n', 'only the col-addressed occurrence changed');
  } finally { rm(root); }
});

test('§18 apply-plan: new-target-missing (rooted newText) -> failed, exit non-zero', () => {
  const { root, hash } = makePlanTree();
  try {
    const plan = { edits: [{ itemId: 'id1', file: 'skills/s.md', anchor: { line: 1, occurrence: 1 }, oldText: 'tpm-old.js', newText: 'lib/missing.js', expectHash: hash }] };
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
    const r = runCli(['apply-plan', 'plan.json', '--scan-root', root], root);
    assert.strictEqual(r.status, 6);
    assert.match(r.stdout, /new-target-missing/);
  } finally { rm(root); }
});

test('§18 apply-plan --dry: original untouched; temps cleaned', () => {
  const { root, hash } = makePlanTree();
  const before = fs.readFileSync(path.join(root, 'skills/s.md'));
  try {
    const plan = { edits: [{ itemId: 'id1', file: 'skills/s.md', anchor: { line: 1, occurrence: 1 }, oldText: 'tpm-old.js', newText: 'tpm-new.js', expectHash: hash }] };
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
    const r = runCli(['apply-plan', 'plan.json', '--scan-root', root, '--dry'], root);
    assert.strictEqual(r.status, 0);
    assert.ok(fs.readFileSync(path.join(root, 'skills/s.md')).equals(before), 'original untouched by --dry');
    const after = readTree(root);
    assert.ok(!Object.keys(after).some((k) => /\.tmp[12]?$/.test(k)), 'no temps left');
  } finally { rm(root); }
});

test('§18 apply-plan: temp-collision -> file skipped, bystander safe', () => {
  const { root, hash } = makePlanTree();
  fs.writeFileSync(path.join(root, 'skills/s.md.tmp'), 'BYSTANDER');
  const bystander = fs.readFileSync(path.join(root, 'skills/s.md.tmp'));
  try {
    const plan = { edits: [{ itemId: 'id1', file: 'skills/s.md', anchor: { line: 1, occurrence: 1 }, oldText: 'tpm-old.js', newText: 'tpm-new.js', expectHash: hash }] };
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
    const r = runCli(['apply-plan', 'plan.json', '--scan-root', root], root);
    assert.strictEqual(r.status, 6);
    assert.match(r.stdout, /temp-collision/);
    assert.ok(fs.readFileSync(path.join(root, 'skills/s.md.tmp')).equals(bystander), 'bystander safe');
  } finally { rm(root); }
});

// =============================================================================
// Change 1 — content-anchored itemId: integration (identify worklist)
// =============================================================================
test('C1 itemId: same reference at different line numbers -> same worklist itemId (line shift)', () => {
  // Tree A: the ambiguous `only.js` ref with two real neighbors on each side.
  const { root: rootA } = buildFixTree({
    'docs/ref.md': 'alpha\nbeta\nbare only.js here\ngamma\ndelta\n',
  });
  // Tree B: identical content but shifted DOWN by two padding lines — the ref's ±2 neighbors are the
  // same actual lines, so the content window (and thus the id) must be identical.
  const { root: rootB } = buildFixTree({
    'docs/ref.md': 'pad one\npad two\nalpha\nbeta\nbare only.js here\ngamma\ndelta\n',
  });
  try {
    runCli(['identify', 'git-status.txt', '--scan-root', rootA, '--json'], rootA);
    runCli(['identify', 'git-status.txt', '--scan-root', rootB, '--json'], rootB);
    const workA = JSON.parse(fs.readFileSync(path.join(rootA, 'tpm-fix-git-rename-refs-ambiguous.json'), 'utf8'));
    const workB = JSON.parse(fs.readFileSync(path.join(rootB, 'tpm-fix-git-rename-refs-ambiguous.json'), 'utf8'));
    const itemA = workA.items.find((it) => it.file === 'docs/ref.md' && it.base === 'only.js');
    const itemB = workB.items.find((it) => it.file === 'docs/ref.md' && it.base === 'only.js');
    assert.ok(itemA && itemB, 'only.js ambiguous item present in both worklists');
    assert.strictEqual(itemA.line, 3); assert.strictEqual(itemB.line, 5, 'line differs between trees');
    assert.strictEqual(itemA.itemId, itemB.itemId, 'content-anchored id stable across the line shift');
  } finally { rm(rootA); rm(rootB); }
});

test('C1 itemId: distinct references (different surrounding content) -> different ids', () => {
  const { root } = buildFixTree({
    'docs/a.md': 'context alpha\nbare only.js here\ncontext beta\n',
    'docs/b.md': 'context gamma\nbare only.js here\ncontext delta\n',
  });
  try {
    runCli(['identify', 'git-status.txt', '--scan-root', root, '--json'], root);
    const work = JSON.parse(fs.readFileSync(path.join(root, 'tpm-fix-git-rename-refs-ambiguous.json'), 'utf8'));
    const ids = work.items.filter((it) => it.base === 'only.js').map((it) => it.itemId);
    assert.strictEqual(ids.length, 2, 'two only.js ambiguous refs');
    assert.notStrictEqual(ids[0], ids[1], 'different windows -> different ids');
  } finally { rm(root); }
});

test('C1 itemId: genuine window collision disambiguated to distinct ids', () => {
  // Two identical `only.js` refs with IDENTICAL ±2 windows collide; both must still get distinct ids.
  const { root } = buildFixTree({
    'docs/ref.md': 'X\nY\nbare only.js here\nX\nY\nbare only.js here\nX\nY\n',
  });
  try {
    runCli(['identify', 'git-status.txt', '--scan-root', root, '--json'], root);
    const work = JSON.parse(fs.readFileSync(path.join(root, 'tpm-fix-git-rename-refs-ambiguous.json'), 'utf8'));
    const ids = work.items.filter((it) => it.base === 'only.js').map((it) => it.itemId);
    assert.strictEqual(ids.length, 2, 'two colliding refs');
    assert.strictEqual(new Set(ids).size, 2, 'ids disambiguated to distinct values');
  } finally { rm(root); }
});

// =============================================================================
// Change 2 — --json run report for fix / fix --dry (Decision K)
// =============================================================================
function readFixReport(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'tpm-fix-git-rename-refs-fix-report.json'), 'utf8'));
}

test('C2 fix --json: valid report; counts match the human summary', () => {
  const { root } = buildFixTree({
    'docs/readme.md': 'rooted src/a/foo.js here\nbare foo.js prose\n', // 1 provable sub (+1 ambiguous, untouched)
    'src/a/skill.md': 'relative ./foo.js\n',                            // 1 provable sub
  });
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root, '--json'], root);
    assert.strictEqual(r.status, 0, `stderr=${r.stderr}`);
    const rep = readFixReport(root);
    // valid dialect
    assert.strictEqual(rep.tool, 'tpm-fix-git-rename-refs');
    assert.ok(rep.toolVersion && rep.meta && rep.summary && Array.isArray(rep.applied));
    assert.strictEqual(rep.mode, 'fix');
    assert.strictEqual(rep.exitCode, 0);
    assert.strictEqual(rep.meta.scanRoot, path.resolve(root));
    // filesModified matches the human "files changed" tally and the count of "changed:" lines
    const humanChanged = parseInt(r.stdout.match(/files changed : (\d+)/)[1], 10);
    const changedLines = r.stdout.split('\n').filter((l) => l.startsWith('changed:')).length;
    assert.strictEqual(rep.summary.filesModified, humanChanged);
    assert.strictEqual(rep.summary.filesModified, changedLines);
    assert.strictEqual(rep.summary.filesModified, 2);
    // subsApplied equals the sum of "(N substitution(s))" in the human output, and applied[] length
    const subSum = [...r.stdout.matchAll(/\((\d+) substitution\(s\)/g)].reduce((a, m) => a + parseInt(m[1], 10), 0);
    assert.strictEqual(rep.summary.subsApplied, subSum);
    assert.strictEqual(rep.applied.length, subSum);
    assert.ok(rep.applied.every((e) => e.status === 'applied' && e.old && e.new && typeof e.occurrence === 'number'));
    assert.strictEqual(rep.summary.dry, false);
  } finally { rm(root); }
});

test('C2 fix --dry --json: entries marked would-change; originals untouched', () => {
  const { root } = buildFixTree({ 'ref.md': 'rooted src/a/foo.js x\n' });
  const before = fs.readFileSync(path.join(root, 'ref.md'));
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root, '--dry', '--json'], root);
    assert.strictEqual(r.status, 0);
    assert.ok(fs.readFileSync(path.join(root, 'ref.md')).equals(before), 'original untouched by --dry');
    const rep = readFixReport(root);
    assert.strictEqual(rep.mode, 'fix --dry');
    assert.strictEqual(rep.summary.dry, true);
    assert.strictEqual(rep.summary.filesModified, 1);
    assert.ok(rep.applied.length >= 1 && rep.applied.every((e) => e.status === 'would-change'), 'marked would-change');
  } finally { rm(root); }
});

test('C2 fix --force --json: force collision choice + alternatives represented', () => {
  const { root } = buildFixTree({ 'ref.md': 'bare config.js here\n' });
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root, '--force', '--json'], root);
    assert.strictEqual(r.status, 0);
    const rep = readFixReport(root);
    assert.strictEqual(rep.mode, 'fix --force');
    const cc = rep.forceChoices.find((c) => c.base === 'config.js');
    assert.ok(cc, 'config.js force choice present');
    assert.strictEqual(cc.chosen.new, 'src/a/sess-config.js', 'first-in-file winner recorded');
    assert.ok(cc.alternatives.length >= 1 && cc.alternatives[0].new === 'src/c/task-config.js', 'alternatives recorded');
    assert.ok(rep.summary.forcedCount >= 1, 'forced count > 0');
    assert.ok(rep.applied.some((e) => e.forced === true), 'a forced edit is in applied[]');
  } finally { rm(root); }
});

test('C2 fix --json: aborted file (assertion failure) represented; exit 4 echoed', () => {
  const { root } = buildFixTree({ 'a.md': 'rooted src/a/foo.js one\n' });
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root, '--json'], root, { TPM_FIX_GIT_RENAME_TEST_CORRUPT: 'a.md' });
    assert.strictEqual(r.status, 4);
    const rep = readFixReport(root);
    assert.strictEqual(rep.exitCode, 4, 'exit code echoed into the report');
    assert.strictEqual(rep.summary.filesAborted, 1);
    assert.strictEqual(rep.failed.length, 1);
    assert.strictEqual(rep.failed[0].file, 'a.md');
    assert.ok(rep.failed[0].reason && rep.failed[0].restored === true);
  } finally { rm(root); }
});

test('C2 fix --json: skipped file (temp-collision) represented', () => {
  const { root } = buildFixTree({ 'ref.md': 'rooted src/a/foo.js x\n', 'ref.md.tmp': 'BYSTANDER' });
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root, '--json'], root);
    assert.strictEqual(r.status, 0);
    const rep = readFixReport(root);
    assert.strictEqual(rep.summary.filesSkipped, 1);
    assert.strictEqual(rep.skipped.length, 1);
    assert.strictEqual(rep.skipped[0].reason, 'temp-collision');
  } finally { rm(root); }
});

test('C2 fix / apply-plan share the same JSON report dialect', () => {
  const { root } = buildFixTree({ 'ref.md': 'rooted src/a/foo.js x\n' });
  const { root: proot, hash } = makePlanTree();
  try {
    runCli(['fix', 'git-status.txt', '--scan-root', root, '--json'], root);
    const plan = { edits: [{ itemId: 'id1', file: 'skills/s.md', anchor: { line: 1, occurrence: 1 }, oldText: 'tpm-old.js', newText: 'tpm-new.js', expectHash: hash }] };
    fs.writeFileSync(path.join(proot, 'plan.json'), JSON.stringify(plan));
    runCli(['apply-plan', 'plan.json', '--scan-root', proot, '--json'], proot);
    const fixRep = readFixReport(root);
    const applyRep = JSON.parse(fs.readFileSync(path.join(proot, 'tpm-fix-git-rename-refs-apply-report.json'), 'utf8'));
    const topKeys = (o) => Object.keys(o).sort();
    assert.deepStrictEqual(topKeys(fixRep), topKeys(applyRep), 'identical top-level envelope keys');
    for (const k of ['tool', 'toolVersion', 'mode', 'meta', 'summary', 'applied', 'skipped', 'failed', 'forceChoices', 'exitCode']) {
      assert.ok(k in fixRep && k in applyRep, `both carry ${k}`);
    }
    assert.strictEqual(applyRep.mode, 'apply-plan');
    assert.strictEqual(applyRep.summary.subsApplied, 1);
  } finally { rm(root); rm(proot); }
});

// =============================================================================
// Change 3 — apply-plan occurrence-addressing boundary/uniqueness guard
// =============================================================================
test('C3 findBoundedOccurrence: standalone-only; substring-in-token ignored', () => {
  assert.strictEqual(mod.findBoundedOccurrence('x config.js y', 'config.js', 1), 2);
  assert.strictEqual(mod.findBoundedOccurrence('x myconfig.js y', 'config.js', 1), -1, 'substring-only -> not found');
  const line = 'a myconfig.js and config.js b';
  assert.strictEqual(mod.findBoundedOccurrence(line, 'config.js', 1), line.indexOf('and config.js') + 'and '.length, 'occ1 skips the substring, lands on the standalone');
  assert.strictEqual(mod.findBoundedOccurrence(line, 'config.js', 2), -1, 'only one standalone token');
  assert.strictEqual(mod.findBoundedOccurrence('config.js x config.js', 'config.js', 2), 12, 'two standalone occurrences');
});

test('C3 apply-plan: substring-only occurrence -> skipped (not applied), exit non-zero, untouched', () => {
  const root = makeTree({ 'skills/s.md': 'see myconfig.js here\n' });
  const hash = fileHash(path.join(root, 'skills/s.md'));
  const before = fs.readFileSync(path.join(root, 'skills/s.md'));
  try {
    const plan = { edits: [{ itemId: 'id1', file: 'skills/s.md', anchor: { line: 1, occurrence: 1 }, oldText: 'config.js', newText: 'sess-config.js', expectHash: hash }] };
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
    const r = runCli(['apply-plan', 'plan.json', '--scan-root', root], root);
    assert.strictEqual(r.status, 6, 'non-zero exit');
    assert.match(r.stdout, /occurrence-not-found/);
    assert.ok(fs.readFileSync(path.join(root, 'skills/s.md')).equals(before), 'file untouched (not edited inside myconfig.js)');
  } finally { rm(root); }
});

test('C3 apply-plan: genuine standalone occurrence -> applied (picks standalone over substring)', () => {
  const root = makeTree({ 'skills/s.md': 'x myconfig.js and config.js y\n' });
  const hash = fileHash(path.join(root, 'skills/s.md'));
  try {
    const plan = { edits: [{ itemId: 'id1', file: 'skills/s.md', anchor: { line: 1, occurrence: 1 }, oldText: 'config.js', newText: 'sess-config.js', expectHash: hash }] };
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
    const r = runCli(['apply-plan', 'plan.json', '--scan-root', root], root);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(fs.readFileSync(path.join(root, 'skills/s.md'), 'utf8'),
      'x myconfig.js and sess-config.js y\n', 'standalone config.js replaced, myconfig.js left intact');
  } finally { rm(root); }
});

test('C3 apply-plan: col addressing unaffected by the guard (exact-path escape hatch)', () => {
  const root = makeTree({ 'skills/s.md': 'x myconfig.js and config.js y\n' });
  const hash = fileHash(path.join(root, 'skills/s.md'));
  try {
    // col points at the `config.js` substring INSIDE `myconfig.js`; col addressing is exact and must
    // still hit precisely there (the boundary guard governs occurrence addressing only).
    const line = 'x myconfig.js and config.js y';
    const col = line.indexOf('config.js') + 1; // 1-based; first indexOf lands inside myconfig.js
    const plan = { edits: [{ itemId: 'id1', file: 'skills/s.md', anchor: { line: 1, col }, oldText: 'config.js', newText: 'ZZ', expectHash: hash }] };
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
    const r = runCli(['apply-plan', 'plan.json', '--scan-root', root], root);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(fs.readFileSync(path.join(root, 'skills/s.md'), 'utf8'),
      'x myZZ and config.js y\n', 'col addressing edits the exact spot, even inside a larger token');
  } finally { rm(root); }
});

// =============================================================================
// §10 — exit-code matrix
// =============================================================================
test('§10 exit matrix: identify=0, fix clean=0, fix failed=4, gate=5, apply-plan bad=6, bad args=2, unreadable=1', () => {
  const { root } = buildFixTree({ 'ref.md': 'rooted src/a/foo.js x\n' });
  try {
    assert.strictEqual(runCli(['identify', 'git-status.txt', '--scan-root', root], root).status, 0);
    assert.strictEqual(runCli(['fix', 'git-status.txt', '--scan-root', root], root).status, 0);
    assert.strictEqual(runCli(['fix', 'git-status.txt', '--scan-root', root], root, { TPM_FIX_GIT_RENAME_TEST_CORRUPT: 'ref.md' }).status, 0, 'idempotent 3rd run: nothing left to change');
    assert.strictEqual(runCli(['frobnicate', 'x'], root).status, 2);
    assert.strictEqual(runCli(['fix', 'nope.txt', '--scan-root', root], root).status, 1);
  } finally { rm(root); }
  // dedicated failed-fix exit 4 (fresh tree so there IS a provable change to corrupt)
  const { root: r2 } = buildFixTree({ 'ref.md': 'rooted src/a/foo.js x\n' });
  try {
    assert.strictEqual(runCli(['fix', 'git-status.txt', '--scan-root', r2], r2, { TPM_FIX_GIT_RENAME_TEST_CORRUPT: 'ref.md' }).status, 4);
  } finally { rm(r2); }
});

// =============================================================================
// GAP 1 — natural (non-seam) abort / snapshot integrity
// -----------------------------------------------------------------------------
// The verifiers asked us to exercise the §9 abort-and-restore and the
// "snapshot verified before edit" branch WITHOUT the TPM_FIX_GIT_RENAME_TEST_CORRUPT
// seam — e.g. by making the .tmp unwritable / the original read-only.
//
// FINDING (documented deliberately): those two branches are NOT reachable
// naturally in a hermetic single-process run, for three independent reasons:
//   (a) the assertOnlyIntended (only-intended-change) abort fires only when the
//       writer produced an UNEXPECTED delta. The real writer reproduces exactly
//       what assertOnlyIntended re-derives (same boundary-safe, longest-first
//       substitution), so a correct-by-construction writer can never trip it.
//       The seam exists precisely to inject a delta the writer never makes.
//   (b) the 'snapshot-mismatch' branch compares the freshly-written <file>.tmp
//       against the just-read original buffer. Both come from the same bytes in
//       the same synchronous execution, so they are always equal unless a
//       concurrent external mutator races the process — which a hermetic test
//       cannot inject.
//   (c) the "unwritable .tmp / read-only original" routes do NOT flow through
//       the assertion/snapshot branches — they are WRITE failures. As of
//       Change 2 they are caught and converted to a graceful per-file exit-4
//       abort ({status:'failed', reason:'eacces'|'write-error', restored:true}):
//       the snapshot write (claim) and the in-place write are wrapped in
//       try/catch, so one unwritable file is reported as a failed file and the
//       batch continues to the others rather than crashing with a raw EACCES
//       stack. The tests below now assert that graceful handling.
// So we KEEP the seam-based abort+restore test (§5, above) as the canonical
// coverage of the assertion rails, and use the tests below to (1) lock in the
// safety-critical invariant that even the write-error paths never corrupt/lose
// the original, and (2) prove the writer never naturally trips the assertion.
// =============================================================================

// Probe whether this environment actually enforces a read-only bit (root ignores
// permission bits, so we branch the assertions to stay deterministic everywhere).
function canEnforceReadonly() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-ro-'));
  const f = path.join(d, 'probe');
  try {
    fs.writeFileSync(f, 'x');
    fs.chmodSync(f, 0o444);
    try { fs.writeFileSync(f, 'y'); return false; } // write succeeded -> not enforced (root)
    catch { return true; }
  } catch { return false; }
  finally { try { fs.chmodSync(f, 0o644); } catch { /* ignore */ } rm(d); }
}

test('GAP1/Change2 read-only ORIGINAL -> graceful exit-4 failed+restored; OTHER files still fixed', () => {
  // Two provable files; only `ref.md` is made read-only. The in-place write to it throws EACCES, which
  // Change 2 catches and converts to a per-file failure. The batch must continue and still fix `ok.md`.
  const { root } = buildFixTree({
    'ok.md': 'rooted src/a/foo.js here\n',   // writable -> still fixed
    'ref.md': 'rooted src/a/foo.js here\n',  // read-only -> graceful failure
  });
  const before = fs.readFileSync(path.join(root, 'ref.md'));
  try {
    if (!canEnforceReadonly()) {
      // Environment can't enforce read-only (e.g. running as root): the fix simply succeeds. Assert the
      // normal happy path so the case is still deterministic.
      const r = runCli(['fix', 'git-status.txt', '--scan-root', root], root);
      assert.strictEqual(r.status, 0);
      assert.strictEqual(fs.readFileSync(path.join(root, 'ref.md'), 'utf8'), 'rooted src/a/foo-bar.js here\n');
      return;
    }
    fs.chmodSync(path.join(root, 'ref.md'), 0o444);
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root, '--json'], root);
    // New behavior: a graceful per-file exit-4 abort (NOT a raw uncaught EACCES crash).
    assert.strictEqual(r.status, 4, 'read-only original -> graceful exit 4');
    assert.doesNotMatch(r.stderr, /at Object|at Module|\n\s+at /, 'no raw stack trace (graceful, not uncaught)');
    assert.match(r.stdout, /failed: ref\.md.*(eacces|write-error).*restored=true/, 'ref.md reported failed + restored');
    // The OTHER file in the same batch is still processed.
    assert.strictEqual(fs.readFileSync(path.join(root, 'ok.md'), 'utf8'), 'rooted src/a/foo-bar.js here\n', 'ok.md still fixed');
    // The fix-report JSON failed[] carries the file + reason.
    const rep = readFixReport(root);
    assert.strictEqual(rep.exitCode, 4);
    const f = rep.failed.find((x) => x.file === 'ref.md');
    assert.ok(f, 'ref.md present in failed[]');
    assert.ok(f.reason === 'eacces' || f.reason === 'write-error', `failed[] carries the reason (${f.reason})`);
    assert.strictEqual(f.restored, true, 'reported restored');
    // SAFETY INVARIANT: original intact (never partially written), no OUR temp left behind.
    fs.chmodSync(path.join(root, 'ref.md'), 0o644);
    assert.ok(fs.readFileSync(path.join(root, 'ref.md')).equals(before), 'original byte-identical (no corruption)');
    const after = readTree(root);
    assert.ok(!Object.keys(after).some((k) => /\.tmp\d?$/.test(k)), 'no temp left behind after graceful abort');
  } finally {
    try { fs.chmodSync(path.join(root, 'ref.md'), 0o644); } catch { /* ignore */ }
    rm(root);
  }
});

test('GAP1/Change2 unwritable DIR (snapshot cannot be taken) -> graceful exit-4; OTHER files still fixed', () => {
  // `d/` is made r-x so `d/ref.md.tmp` cannot be created: the snapshot write inside claim() throws
  // EACCES, which Change 2 catches and converts to a per-file failure. `ok.md` (writable dir) still fixes.
  const { root } = buildFixTree({
    'd/ref.md': 'rooted src/a/foo.js here\n',  // unwritable dir -> graceful failure
    'ok.md': 'rooted src/a/foo.js here\n',     // writable -> still fixed
  });
  const before = fs.readFileSync(path.join(root, 'd/ref.md'));
  const dir = path.join(root, 'd');
  try {
    if (!canEnforceReadonly()) {
      const r = runCli(['fix', 'git-status.txt', '--scan-root', root], root);
      assert.strictEqual(r.status, 0);
      assert.strictEqual(fs.readFileSync(path.join(root, 'd/ref.md'), 'utf8'), 'rooted src/a/foo-bar.js here\n');
      return;
    }
    fs.chmodSync(dir, 0o555); // r-x: can read/scan, cannot create <file>.tmp
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root, '--json'], root);
    // New behavior: the snapshot write failure is caught -> graceful per-file exit-4 abort.
    assert.strictEqual(r.status, 4, 'unwritable temp dir -> graceful exit 4');
    assert.doesNotMatch(r.stderr, /at Object|at Module|\n\s+at /, 'no raw stack trace (graceful, not uncaught)');
    assert.match(r.stdout, /failed: d\/ref\.md.*(eacces|write-error)/, 'd/ref.md reported failed with reason');
    // The other file in the same batch is still processed.
    assert.strictEqual(fs.readFileSync(path.join(root, 'ok.md'), 'utf8'), 'rooted src/a/foo-bar.js here\n', 'ok.md still fixed');
    // The fix-report JSON failed[] carries the file + reason.
    const rep = readFixReport(root);
    const f = rep.failed.find((x) => x.file === 'd/ref.md');
    assert.ok(f, 'd/ref.md present in failed[]');
    assert.ok(f.reason === 'eacces' || f.reason === 'write-error', `failed[] carries the reason (${f.reason})`);
    fs.chmodSync(dir, 0o755);
    assert.ok(fs.readFileSync(path.join(root, 'd/ref.md')).equals(before), 'original untouched (snapshot never taken)');
    const after = readTree(root);
    assert.ok(!Object.keys(after).some((k) => /\.tmp\d?$/.test(k)), 'no temp left behind after graceful abort');
  } finally {
    try { fs.chmodSync(dir, 0o755); } catch { /* ignore */ }
    rm(root);
  }
});

test('GAP1 why-impossible lock: a correct writer NEVER naturally trips the only-intended assertion', () => {
  // Many provable rewrites across several files, no seam: zero must fail the §9
  // assertion. This is the structural reason the seam is required to cover the
  // abort branch at all — the writer is correct-by-construction.
  const { root } = buildFixTree({
    'a.md': 'rooted src/a/foo.js A and again src/a/foo.js A2\n',
    'b/c.md': 'rel ./foo.js\n',                              // note: b/c.md dir; ./foo.js -> b/foo.js? see below
    'src/a/skill.md': 'rel ./foo.js and ./keep.js\n',        // provable resolved + dir-move resolved
    'docs/r.md': 'rooted src/a/foo.js and src/a/only.js\n',
  });
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root], root);
    // Some files change, none FAIL. (b/c.md's ./foo.js resolves to b/foo.js which
    // is not a rename target -> ignored, harmless.) The invariant under test is
    // simply: zero assertion failures, exit 0.
    assert.strictEqual(r.status, 0, `no natural assertion failure (stderr=${r.stderr})`);
    assert.ok(!/failed:/.test(r.stdout), 'no file reported failed');
    assert.match(r.stdout, /files failed\s*:\s*0/);
  } finally { rm(root); }
});

// =============================================================================
// GAP — escape guard at the integration level (§17.1 / test-design §8)
// A relative ref that resolves OUTSIDE the scan-root is flagged (escape) and is
// never rewritten by the Provable pass.
// =============================================================================
test('GAP escape-guard: identify flags an escaping ref (escape=true), classified ambiguous not provable', () => {
  const root = makeTree({
    'git-status.txt': 'On branch main\n\trenamed:    src/a/foo.js -> src/a/foo-bar.js\n',
    'src/a/foo-bar.js': 'x',
    'a.md': 'see ../../../foo.js here\n', // resolves above scan-root -> escape
  });
  try {
    const r = runCli(['identify', 'git-status.txt', '--scan-root', root, '--json'], root);
    assert.strictEqual(r.status, 0);
    const result = JSON.parse(fs.readFileSync(path.join(root, 'tpm-fix-git-rename-refs-result.json'), 'utf8'));
    const esc = result.findings.find((f) => f.file === 'a.md' && f.token === '../../../foo.js');
    assert.ok(esc, 'escaping ref present as a finding');
    assert.strictEqual(esc.escape, true, 'flagged escape');
    assert.strictEqual(esc.category, 'ambiguous', 'never Provable');
    // and it never appears under a Safe fix line
    assert.ok(!/Safe fix.*a\.md/.test(r.stdout), 'not provable in the ledger');
  } finally { rm(root); }
});

test('GAP escape-guard: fix never rewrites an escaping ref', () => {
  const root = makeTree({
    'git-status.txt': 'On branch main\n\trenamed:    src/a/foo.js -> src/a/foo-bar.js\n',
    'src/a/foo-bar.js': 'x',
    'a.md': 'see ../../../foo.js here\n',
  });
  const before = fs.readFileSync(path.join(root, 'a.md'));
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root], root);
    assert.strictEqual(r.status, 0);
    assert.ok(fs.readFileSync(path.join(root, 'a.md')).equals(before), 'escaping ref left untouched');
  } finally { rm(root); }
});

// =============================================================================
// GAP — longest-path-first / multiple distinct renames on one line (integration)
// (§10 substitution ordering; unit-covered by P2 applyProvableSubs, here end-to-end)
// =============================================================================
test('GAP substitution: two distinct provable renames on one line both applied, no clobber', () => {
  const { root } = buildFixTree({ 'ref.md': 'x src/a/foo.js then src/a/only.js end\n' });
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root], root);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(fs.readFileSync(path.join(root, 'ref.md'), 'utf8'),
      'x src/a/foo-bar.js then src/a/only-1.js end\n', 'both renames rewritten independently');
  } finally { rm(root); }
});

// =============================================================================
// GAP — apply-plan additional edges (bad-line / col-mismatch / occurrence=2 /
//        symlink / file-missing) and the shared --json envelope for apply-plan.
// =============================================================================
test('GAP2 apply-plan: line out of range -> skipped-notfound (bad-line), exit 6, untouched', () => {
  const { root, hash } = makePlanTree();
  const before = fs.readFileSync(path.join(root, 'skills/s.md'));
  try {
    const plan = { edits: [{ itemId: 'id1', file: 'skills/s.md', anchor: { line: 99, occurrence: 1 }, oldText: 'tpm-old.js', newText: 'tpm-new.js', expectHash: hash }] };
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
    const r = runCli(['apply-plan', 'plan.json', '--scan-root', root], root);
    assert.strictEqual(r.status, 6);
    assert.match(r.stdout, /skipped-notfound\s*:\s*1/);
    assert.match(r.stdout, /bad-line/);
    assert.ok(fs.readFileSync(path.join(root, 'skills/s.md')).equals(before), 'untouched');
  } finally { rm(root); }
});

test('GAP2 apply-plan: col addressing with wrong oldText -> skipped-notfound (text-mismatch), exit 6', () => {
  const { root, hash } = makePlanTree();
  const before = fs.readFileSync(path.join(root, 'skills/s.md'));
  try {
    // col 1 on line 1 ('run tpm-old.js now') does not begin with 'tpm-old.js'
    const plan = { edits: [{ itemId: 'id1', file: 'skills/s.md', anchor: { line: 1, col: 1 }, oldText: 'tpm-old.js', newText: 'tpm-new.js', expectHash: hash }] };
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
    const r = runCli(['apply-plan', 'plan.json', '--scan-root', root], root);
    assert.strictEqual(r.status, 6);
    assert.match(r.stdout, /text-mismatch/);
    assert.ok(fs.readFileSync(path.join(root, 'skills/s.md')).equals(before), 'untouched');
  } finally { rm(root); }
});

test('GAP2 apply-plan: occurrence=2 targets the 2nd standalone token, 1st left intact', () => {
  const { root, hash } = makePlanTree();
  try {
    const plan = { edits: [{ itemId: 'id1', file: 'skills/s.md', anchor: { line: 2, occurrence: 2 }, oldText: 'tpm-old.js', newText: 'tpm-new.js', expectHash: hash }] };
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
    const r = runCli(['apply-plan', 'plan.json', '--scan-root', root], root);
    assert.strictEqual(r.status, 0, `stderr=${r.stderr}`);
    assert.strictEqual(fs.readFileSync(path.join(root, 'skills/s.md'), 'utf8'),
      'run tpm-old.js now\nsee tpm-old.js and tpm-new.js twice\n', 'only occurrence 2 on line 2 changed');
  } finally { rm(root); }
});

test('GAP2 apply-plan: file-missing -> skipped-notfound, exit 6', () => {
  const { root, hash } = makePlanTree();
  try {
    const plan = { edits: [{ itemId: 'id1', file: 'no/such.md', anchor: { line: 1, occurrence: 1 }, oldText: 'x', newText: 'y', expectHash: hash }] };
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
    const r = runCli(['apply-plan', 'plan.json', '--scan-root', root], root);
    assert.strictEqual(r.status, 6);
    assert.match(r.stdout, /skipped-notfound\s*:\s*1/);
    assert.match(r.stdout, /file-missing/);
  } finally { rm(root); }
});

test('GAP2 apply-plan: symlinked target -> failed (symlink), exit 6, never followed', () => {
  const { root, hash } = makePlanTree();
  fs.symlinkSync('skills/s.md', path.join(root, 'link.md'));
  const realBefore = fs.readFileSync(path.join(root, 'skills/s.md'));
  try {
    const plan = { edits: [{ itemId: 'id1', file: 'link.md', anchor: { line: 1, occurrence: 1 }, oldText: 'tpm-old.js', newText: 'tpm-new.js', expectHash: hash }] };
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
    const r = runCli(['apply-plan', 'plan.json', '--scan-root', root], root);
    assert.strictEqual(r.status, 6);
    assert.match(r.stdout, /failed.*symlink|symlink/);
    assert.ok(fs.readFileSync(path.join(root, 'skills/s.md')).equals(realBefore), 'real target not edited through the link');
    assert.ok(fs.lstatSync(path.join(root, 'link.md')).isSymbolicLink(), 'link still a symlink');
  } finally { rm(root); }
});

test('GAP4 apply-plan --json: valid envelope; summary counts match human; exit echoed', () => {
  const { root, hash } = makePlanTree();
  try {
    const plan = { edits: [
      { itemId: 'id1', file: 'skills/s.md', anchor: { line: 1, occurrence: 1 }, oldText: 'tpm-old.js', newText: 'tpm-new.js', expectHash: hash },
      { itemId: 'id2', file: 'skills/s.md', anchor: { line: 2, occurrence: 2 }, oldText: 'tpm-old.js', newText: 'tpm-new.js', expectHash: hash },
    ] };
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
    const r = runCli(['apply-plan', 'plan.json', '--scan-root', root, '--json'], root);
    assert.strictEqual(r.status, 0);
    const rep = JSON.parse(fs.readFileSync(path.join(root, 'tpm-fix-git-rename-refs-apply-report.json'), 'utf8'));
    // same fixed envelope as the fix report
    for (const k of ['tool', 'toolVersion', 'mode', 'meta', 'summary', 'applied', 'skipped', 'failed', 'forceChoices', 'exitCode']) {
      assert.ok(k in rep, `envelope carries ${k}`);
    }
    assert.strictEqual(rep.mode, 'apply-plan');
    assert.strictEqual(rep.exitCode, 0);
    // subsApplied matches the human "applied : N" line and applied[] length
    const humanApplied = parseInt(r.stdout.match(/applied\s*:\s*(\d+)/)[1], 10);
    assert.strictEqual(rep.summary.subsApplied, humanApplied);
    assert.strictEqual(rep.applied.length, humanApplied);
    assert.ok(rep.applied.every((e) => e.status === 'applied' && e.itemId && typeof e.line === 'number'));
  } finally { rm(root); }
});

test('GAP4 apply-plan --dry --json: entries marked would-change; original untouched', () => {
  const { root, hash } = makePlanTree();
  const before = fs.readFileSync(path.join(root, 'skills/s.md'));
  try {
    const plan = { edits: [{ itemId: 'id1', file: 'skills/s.md', anchor: { line: 1, occurrence: 1 }, oldText: 'tpm-old.js', newText: 'tpm-new.js', expectHash: hash }] };
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
    const r = runCli(['apply-plan', 'plan.json', '--scan-root', root, '--dry', '--json'], root);
    assert.strictEqual(r.status, 0);
    assert.ok(fs.readFileSync(path.join(root, 'skills/s.md')).equals(before), 'original untouched by --dry');
    const rep = JSON.parse(fs.readFileSync(path.join(root, 'tpm-fix-git-rename-refs-apply-report.json'), 'utf8'));
    assert.strictEqual(rep.mode, 'apply-plan --dry');
    assert.strictEqual(rep.summary.dry, true);
    assert.ok(rep.applied.length >= 1 && rep.applied.every((e) => e.status === 'would-change'), 'marked would-change');
  } finally { rm(root); }
});

// =============================================================================
// GAP-EACCES — apply-plan write/permission hardening (mirrors the fix verb's
// §9/§17.1 EACCES handling). A read-only original / unwritable containing dir on
// any apply-plan write path (snapshot claim, --dry preview write, in-place write)
// must be caught and converted to a graceful per-edit failure routed through
// apply-plan's existing failure path (exit 6) — NOT a raw uncaught EACCES stack
// (exit 1). Read-only cases are guarded by canEnforceReadonly() (root ignores the
// bit). The original stays byte-identical, no temp is left, and OTHER edits apply.
// =============================================================================
test('GAP-EACCES apply-plan: read-only ORIGINAL -> graceful failed(eacces,restored) exit 6; OTHER edits applied', () => {
  const root = makeTree({
    'ro.md': 'run tpm-old.js now\n',   // read-only -> graceful failure
    'ok.md': 'run tpm-old.js now\n',   // writable -> still applied
  });
  const roHash = mod.hashContent(fs.readFileSync(path.join(root, 'ro.md')));
  const okHash = mod.hashContent(fs.readFileSync(path.join(root, 'ok.md')));
  const before = fs.readFileSync(path.join(root, 'ro.md'));
  const plan = { edits: [
    { itemId: 'ro1', file: 'ro.md', anchor: { line: 1, occurrence: 1 }, oldText: 'tpm-old.js', newText: 'tpm-new.js', expectHash: roHash },
    { itemId: 'ok1', file: 'ok.md', anchor: { line: 1, occurrence: 1 }, oldText: 'tpm-old.js', newText: 'tpm-new.js', expectHash: okHash },
  ] };
  fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
  try {
    if (!canEnforceReadonly()) {
      // Environment can't enforce read-only (e.g. root): both edits simply apply. Assert the happy path.
      const r = runCli(['apply-plan', 'plan.json', '--scan-root', root], root);
      assert.strictEqual(r.status, 0);
      assert.strictEqual(fs.readFileSync(path.join(root, 'ro.md'), 'utf8'), 'run tpm-new.js now\n');
      assert.strictEqual(fs.readFileSync(path.join(root, 'ok.md'), 'utf8'), 'run tpm-new.js now\n');
      return;
    }
    fs.chmodSync(path.join(root, 'ro.md'), 0o444);
    const r = runCli(['apply-plan', 'plan.json', '--scan-root', root, '--json'], root);
    // Graceful per-edit failure (NOT a raw uncaught EACCES crash / exit 1).
    assert.strictEqual(r.status, 6, 'read-only original -> graceful exit 6 (apply-plan failure path)');
    assert.doesNotMatch(r.stderr, /at Object|at Module|\n\s+at /, 'no raw stack trace (graceful, not uncaught)');
    assert.match(r.stdout, /failed\s+ro\.md.*(eacces|write-error).*restored=true/, 'ro.md reported failed + restored');
    // The OTHER edit in the same plan still applied.
    assert.strictEqual(fs.readFileSync(path.join(root, 'ok.md'), 'utf8'), 'run tpm-new.js now\n', 'ok.md still applied');
    // The apply-report JSON failed[] carries the file + reason (+ restored).
    const rep = JSON.parse(fs.readFileSync(path.join(root, 'tpm-fix-git-rename-refs-apply-report.json'), 'utf8'));
    assert.strictEqual(rep.exitCode, 6);
    const f = rep.failed.find((x) => x.file === 'ro.md');
    assert.ok(f, 'ro.md present in failed[]');
    assert.ok(f.reason === 'eacces' || f.reason === 'write-error', `failed[].reason in apply-report JSON (${f.reason})`);
    assert.strictEqual(f.restored, true, 'reported restored');
    // SAFETY INVARIANT: original intact (never partially written), no OUR temp left behind.
    fs.chmodSync(path.join(root, 'ro.md'), 0o644);
    assert.ok(fs.readFileSync(path.join(root, 'ro.md')).equals(before), 'original byte-identical (no corruption)');
    const after = readTree(root);
    assert.ok(!Object.keys(after).some((k) => /\.tmp\d?$/.test(k)), 'no temp left behind after graceful abort');
  } finally {
    try { fs.chmodSync(path.join(root, 'ro.md'), 0o644); } catch { /* ignore */ }
    rm(root);
  }
});

test('GAP-EACCES apply-plan: unwritable DIR (snapshot cannot be written) -> graceful exit 6; OTHER edits applied', () => {
  const root = makeTree({
    'd/ref.md': 'run tpm-old.js now\n', // unwritable dir -> snapshot claim throws -> graceful failure
    'ok.md': 'run tpm-old.js now\n',    // writable -> still applied
  });
  const refHash = mod.hashContent(fs.readFileSync(path.join(root, 'd/ref.md')));
  const okHash = mod.hashContent(fs.readFileSync(path.join(root, 'ok.md')));
  const before = fs.readFileSync(path.join(root, 'd/ref.md'));
  const dir = path.join(root, 'd');
  const plan = { edits: [
    { itemId: 'r1', file: 'd/ref.md', anchor: { line: 1, occurrence: 1 }, oldText: 'tpm-old.js', newText: 'tpm-new.js', expectHash: refHash },
    { itemId: 'ok1', file: 'ok.md', anchor: { line: 1, occurrence: 1 }, oldText: 'tpm-old.js', newText: 'tpm-new.js', expectHash: okHash },
  ] };
  fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
  try {
    if (!canEnforceReadonly()) {
      const r = runCli(['apply-plan', 'plan.json', '--scan-root', root], root);
      assert.strictEqual(r.status, 0);
      assert.strictEqual(fs.readFileSync(path.join(root, 'd/ref.md'), 'utf8'), 'run tpm-new.js now\n');
      return;
    }
    fs.chmodSync(dir, 0o555); // r-x: can read/scan, cannot create <file>.tmp
    const r = runCli(['apply-plan', 'plan.json', '--scan-root', root, '--json'], root);
    assert.strictEqual(r.status, 6, 'unwritable temp dir -> graceful exit 6');
    assert.doesNotMatch(r.stderr, /at Object|at Module|\n\s+at /, 'no raw stack trace (graceful, not uncaught)');
    assert.match(r.stdout, /failed\s+d\/ref\.md.*(eacces|write-error)/, 'd/ref.md reported failed with reason');
    // The other edit in the same plan still applied.
    assert.strictEqual(fs.readFileSync(path.join(root, 'ok.md'), 'utf8'), 'run tpm-new.js now\n', 'ok.md still applied');
    const rep = JSON.parse(fs.readFileSync(path.join(root, 'tpm-fix-git-rename-refs-apply-report.json'), 'utf8'));
    const f = rep.failed.find((x) => x.file === 'd/ref.md');
    assert.ok(f, 'd/ref.md present in failed[]');
    assert.ok(f.reason === 'eacces' || f.reason === 'write-error', `failed[].reason present (${f.reason})`);
    fs.chmodSync(dir, 0o755);
    assert.ok(fs.readFileSync(path.join(root, 'd/ref.md')).equals(before), 'original untouched (snapshot never taken)');
    const after = readTree(root);
    assert.ok(!Object.keys(after).some((k) => /\.tmp\d?$/.test(k)), 'no temp left behind after graceful abort');
  } finally {
    try { fs.chmodSync(dir, 0o755); } catch { /* ignore */ }
    rm(root);
  }
});

test('GAP-EACCES apply-plan --dry: unwritable DIR (preview write) -> graceful exit 6, no raw stack, original untouched', () => {
  // The --dry preview also writes (snapshot into tmp1/tmp2 + preview into tmp1); those write paths must
  // be caught too — a read-only target must NEVER produce a raw EACCES stack / exit 1 on any write path.
  const root = makeTree({ 'd/ref.md': 'run tpm-old.js now\n' });
  const refHash = mod.hashContent(fs.readFileSync(path.join(root, 'd/ref.md')));
  const before = fs.readFileSync(path.join(root, 'd/ref.md'));
  const dir = path.join(root, 'd');
  const plan = { edits: [{ itemId: 'r1', file: 'd/ref.md', anchor: { line: 1, occurrence: 1 }, oldText: 'tpm-old.js', newText: 'tpm-new.js', expectHash: refHash }] };
  fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
  try {
    if (!canEnforceReadonly()) {
      const r = runCli(['apply-plan', 'plan.json', '--scan-root', root, '--dry'], root);
      assert.strictEqual(r.status, 0);
      return;
    }
    fs.chmodSync(dir, 0o555);
    const r = runCli(['apply-plan', 'plan.json', '--scan-root', root, '--dry'], root);
    assert.strictEqual(r.status, 6, '--dry preview write failure -> graceful exit 6 (not exit 1)');
    assert.doesNotMatch(r.stderr, /at Object|at Module|\n\s+at /, 'no raw stack trace on the --dry write path');
    assert.match(r.stdout, /failed\s+d\/ref\.md.*(eacces|write-error)/, 'failed with a write reason');
    fs.chmodSync(dir, 0o755);
    assert.ok(fs.readFileSync(path.join(root, 'd/ref.md')).equals(before), 'original untouched by --dry');
    const after = readTree(root);
    assert.ok(!Object.keys(after).some((k) => /\.tmp\d?$/.test(k)), 'no temp left behind');
  } finally {
    try { fs.chmodSync(dir, 0o755); } catch { /* ignore */ }
    rm(root);
  }
});

// =============================================================================
// GAP5 — --fail-on-ambiguous + --suppress: identify path + --force interaction
// =============================================================================
test('GAP5 identify --fail-on-ambiguous --suppress: all suppressed -> exit 0', () => {
  const { root } = buildFixTree({ 'ref.md': 'bare only.js here\n' });
  try {
    // trips without suppression
    assert.strictEqual(runCli(['identify', 'git-status.txt', '--scan-root', root, '--fail-on-ambiguous'], root).status, 5);
    // capture the worklist itemId, suppress it -> gate passes
    runCli(['identify', 'git-status.txt', '--scan-root', root, '--json'], root);
    const work = JSON.parse(fs.readFileSync(path.join(root, 'tpm-fix-git-rename-refs-ambiguous.json'), 'utf8'));
    const ids = work.items.map((it) => it.itemId).filter(Boolean);
    assert.ok(ids.length >= 1);
    const sup = path.join(root, 'disposed.json');
    fs.writeFileSync(sup, JSON.stringify({ suppressed: ids }));
    const r = runCli(['identify', 'git-status.txt', '--scan-root', root, '--fail-on-ambiguous', '--suppress', sup], root);
    assert.strictEqual(r.status, 0, 'suppressed items do not trip the identify gate');
  } finally { rm(root); }
});

test('GAP5 loadSuppress reads the apply-plan suppression artifact shape', () => {
  const { root, hash } = makePlanTree();
  try {
    const plan = { edits: [{ itemId: 'idX', file: 'skills/s.md', anchor: { line: 1, occurrence: 1 }, oldText: 'tpm-old.js', newText: 'tpm-new.js', expectHash: hash }] };
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
    runCli(['apply-plan', 'plan.json', '--scan-root', root], root);
    // apply-plan writes {suppressed:[...]} to cwd; loadSuppress must parse it back to a set
    const supPath = path.join(root, 'tpm-fix-git-rename-refs-suppress.json');
    const set = mod.loadSuppress(supPath);
    assert.ok(set.has('idX'), 'applied itemId feeds the --fail-on-ambiguous allowlist');
  } finally { rm(root); }
});

test('GAP5 fix --force --fail-on-ambiguous: forceable ambiguous is rewritten -> gate passes (exit 0)', () => {
  const { root } = buildFixTree({ 'ref.md': 'bare only.js here\n' });
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root, '--force', '--fail-on-ambiguous'], root);
    assert.strictEqual(r.status, 0, 'force resolves the only ambiguous -> gate does not trip');
    assert.strictEqual(fs.readFileSync(path.join(root, 'ref.md'), 'utf8'), 'bare only-1.js here\n');
    assert.match(r.stdout, /ambiguous remaining:\s*0/);
  } finally { rm(root); }
});

test('GAP5 fix --force --fail-on-ambiguous: extensionless never fixed -> still counts -> exit 5', () => {
  const { root } = buildFixTree({ 'src/z/uses.js': "const x = require('./foo');\n" });
  const before = fs.readFileSync(path.join(root, 'src/z/uses.js'));
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root, '--force', '--fail-on-ambiguous'], root);
    assert.strictEqual(r.status, 5, 'extensionless remains ambiguous even under --force -> gate trips');
    assert.match(r.stdout, /ambiguous remaining:\s*1/);
    assert.ok(fs.readFileSync(path.join(root, 'src/z/uses.js')).equals(before), 'extensionless never rewritten');
  } finally { rm(root); }
});

test('GAP5 fix --force --fail-on-ambiguous: bare dir-move is a no-op -> still counts -> exit 5', () => {
  // keep.js is a dir-move (basename unchanged); a bare mention is unfixable even
  // under --force (basename-global swap is a no-op), so it keeps counting.
  const { root } = buildFixTree({ 'ref.md': 'bare keep.js here\n' });
  const before = fs.readFileSync(path.join(root, 'ref.md'));
  try {
    const r = runCli(['fix', 'git-status.txt', '--scan-root', root, '--force', '--fail-on-ambiguous'], root);
    assert.strictEqual(r.status, 5, 'dir-move winner is a no-op -> remains ambiguous under force');
    assert.ok(fs.readFileSync(path.join(root, 'ref.md')).equals(before), 'unchanged');
  } finally { rm(root); }
});

// =============================================================================
// GAP4 — fix --dry --json is the change-plan preview and matches a real fix
// (dry/real parity, expressed through the JSON report)
// =============================================================================
test('GAP4 fix --dry --json parity: preview old/new set equals a real fix run', () => {
  const { root: dry } = buildFixTree({ 'ref.md': 'x src/a/foo.js and src/a/foo.js\nrel ./foo.js\n', 'src/a/foo.js': 'x' });
  const { root: real } = buildFixTree({ 'ref.md': 'x src/a/foo.js and src/a/foo.js\nrel ./foo.js\n', 'src/a/foo.js': 'x' });
  try {
    runCli(['fix', 'git-status.txt', '--scan-root', dry, '--dry', '--json'], dry);
    runCli(['fix', 'git-status.txt', '--scan-root', real, '--json'], real);
    const dj = JSON.parse(fs.readFileSync(path.join(dry, 'tpm-fix-git-rename-refs-fix-report.json'), 'utf8'));
    const rj = JSON.parse(fs.readFileSync(path.join(real, 'tpm-fix-git-rename-refs-fix-report.json'), 'utf8'));
    const norm = (rep) => rep.applied.map((e) => `${e.file}|${e.old}|${e.new}|${e.occurrence}|${e.forced}`).sort();
    assert.deepStrictEqual(norm(dj), norm(rj), 'dry preview change-set == real change-set');
    assert.ok(dj.applied.every((e) => e.status === 'would-change'));
    assert.ok(rj.applied.every((e) => e.status === 'applied'));
  } finally { rm(dry); rm(real); }
});

// ── report ──────────────────────────────────────────────────────────────────
process.stdout.write(`\nPASSED ${passed} / FAILED ${failed}\n`);
if (failed) {
  process.stdout.write('Failures:\n' + failures.map((f) => '  - ' + f.name).join('\n') + '\n');
  process.exit(1);
}
process.exit(0);
