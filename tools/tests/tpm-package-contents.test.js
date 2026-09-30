#!/usr/bin/env node
'use strict';
/**
 * tpm-package-contents.test.js — what `npm pack` would actually ship.
 *
 * The plugin is installed from this package, so what the `files` list ships IS the product. This pins it:
 *   MUST ship   bin/tpm (executable) · hooks/hooks.json · .claude-plugin/* · every .claude/skills file ·
 *               every non-test file under tools/ · every claude-context/methodology file · docs/config-guide.md ·
 *               package.json / README / LICENSE
 *   MUST NOT    any **\/tests/** folder or *.test.js · tmp/ · .claude/claude-tpm/ (a project's own task/session store) ·
 *               node_modules/
 *   ALSO        a REAL `npm pack` of a temp copy: bin/tpm keeps mode 0755 inside the tarball, and the EXTRACTED package
 *               is self-contained (bin/tpm → tools/tpm.js works with no tests folder around; no shipped file requires
 *               anything under tests/).
 *
 * Safe by construction: everything runs on a temp COPY of the bundle (so `prepack`/stamp can never touch the real tree),
 * `--ignore-scripts --offline`, HOME + npm cache in a scratch dir, never `npm publish`. Planted junk (tmp/, node_modules/,
 * .claude/claude-tpm/) is added to the copy to prove the exclusions bite; deliberate breakage of package.json `files` /
 * the shim's mode proves the checks go red.
 *
 * Run: node tools/tests/tpm-package-contents.test.js   (exit 0 = green)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { mkScratch } = require('./lib/scratch');
const { walk, copyBundle, makeFakeClaude } = require('./lib/guard-helpers');

const fake = makeFakeClaude('pack');
const NPM_ENV = {
  PATH: process.env.PATH, HOME: fake.home, npm_config_cache: path.join(fake.home, 'npm-cache'),
  npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
};
function npm(args, cwd) { return spawnSync('npm', args, { cwd, env: NPM_ENV, encoding: 'utf8', timeout: 120000 }); }

/** Fail loudly (exit 1, no stack) when the `npm` on PATH is not a real npm — e.g. a test shim that prints nothing / non-JSON. */
function needRealNpm(why) {
  process.stderr.write(`tpm-package-contents.test.js needs the real npm on PATH, but the \`npm\` it found is not one (${why}).\n` +
    'Run this test without a fake npm first on PATH (a fake claude shim is fine).\n');
  process.exit(1);
}
(function preflightRealNpm() {
  const v = npm(['--version'], process.cwd());
  if (v.error) needRealNpm('cannot run `npm --version`: ' + v.error.message);
  const ver = String(v.stdout || '').trim();
  if (v.status !== 0 || !/^\d+\.\d+\.\d+/.test(ver)) needRealNpm(`\`npm --version\` exit ${v.status}, printed ${JSON.stringify(ver.slice(0, 60))} instead of a semver`);
})();

/** Parse `npm … --json` output, or fail with the "needs the real npm" message instead of a JSON stack. */
function parseNpmJson(r) {
  try { return JSON.parse(r.stdout); } catch (_e) { return needRealNpm(`\`npm … --json\` printed non-JSON: ${JSON.stringify(String(r.stdout).slice(0, 60))}`); }
}

const copy = copyBundle('pack-copy');
// planted junk that MUST NOT ship
for (const [rel, body] of [['tmp/planted.txt', 'x'], ['node_modules/dep/index.js', 'x'], ['.claude/claude-tpm/tasks/planted.json', '{}'],
  ['tools/session/tests/planted.test.js', '//'], ['tools/zz-planted.test.js', '//']]) {
  const p = path.join(copy, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body);
}

const isTest = (rel) => rel.split('/').includes('tests') || /\.test\.js$/.test(rel);
const posix = (p) => p.split(path.sep).join('/');
const treeFiles = (sub, root, accept) => walk(path.join(root, sub), accept, ['node_modules', '.git', 'tmp']).map((p) => posix(path.relative(root, p)));

/** `npm pack --dry-run --json` → [{path, mode}] for the package rooted at `root`. */
function packList(root) {
  const r = npm(['pack', '--dry-run', '--json', '--ignore-scripts', '--offline'], root);
  assert.strictEqual(r.status, 0, 'npm pack --dry-run failed: ' + r.stderr.slice(0, 400));
  return parseNpmJson(r)[0].files;
}

/** Every packaging problem (empty array = healthy). */
function problems(root, files) {
  const got = new Map(files.map((f) => [f.path, f.mode]));
  const out = [];
  const need = (rel) => { if (!got.has(rel)) out.push(`MISSING ${rel}`); };
  ['bin/tpm', 'hooks/hooks.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'package.json', 'README.md', 'LICENSE', 'docs/config-guide.md', 'tools/tpm.js'].forEach(need);
  for (const rel of treeFiles('.claude/skills', root)) need(rel);
  for (const rel of treeFiles('claude-context/methodology', root)) need(rel);
  for (const rel of treeFiles('tools', root, (p) => !isTest(posix(path.relative(root, p))))) need(rel);
  for (const rel of got.keys()) {
    if (isTest(rel)) out.push(`SHOULD NOT SHIP (test) ${rel}`);
    if (/^tmp\//.test(rel) || /^\.claude\/claude-tpm\//.test(rel) || /(^|\/)node_modules\//.test(rel)) out.push(`SHOULD NOT SHIP (junk) ${rel}`);
  }
  if (got.has('bin/tpm') && (got.get('bin/tpm') & 0o111) === 0) out.push(`bin/tpm is not executable in the package (mode ${got.get('bin/tpm').toString(8)})`);
  return out;
}

let count = 0;
function check(name, fn) { fn(); count += 1; process.stdout.write(`  ✓ ${name}\n`); }
process.stdout.write('tpm-package-contents.test.js\n');

check('npm pack --dry-run: ships bin/tpm, hooks, plugin manifests, all skills, all tool code, all methodology; ships NO tests/tmp/store/node_modules', () => {
  const files = packList(copy);
  assert.ok(files.length > 100, `suspiciously small pack (${files.length})`);
  assert.deepStrictEqual(problems(copy, files), []);
});

check('the shipped skills / methodology / tools-code lists are non-trivial (guards the guard: the tree really has what we require)', () => {
  assert.ok(treeFiles('.claude/skills', copy).length >= 10);
  assert.ok(treeFiles('claude-context/methodology', copy).length >= 15);
  assert.ok(treeFiles('tools', copy, (p) => !isTest(posix(path.relative(copy, p)))).length >= 60);
});

check('no shipped (non-test) tool file requires anything under a tests/ folder (the package must run without them)', () => {
  const bad = [];
  for (const rel of treeFiles('tools', copy, (p) => /\.(js|sh)$/.test(p) && !isTest(posix(path.relative(copy, p))))) {
    const t = fs.readFileSync(path.join(copy, rel), 'utf8');
    for (const m of t.matchAll(/require\(\s*['"`]([^'"`]*)['"`]\s*\)/g)) if (/(^|\/)tests\//.test(m[1])) bad.push(`${rel} requires ${m[1]}`);
  }
  assert.deepStrictEqual(bad, []);
});

check('REAL npm pack of the temp copy: tarball bin/tpm is mode 0755; the EXTRACTED package runs `bin/tpm` + `tools/tpm.js` stand-alone', () => {
  const dest = mkScratch('pack-out');
  const r = npm(['pack', '--pack-destination', dest, '--ignore-scripts', '--offline', '--json'], copy);
  assert.strictEqual(r.status, 0, r.stderr.slice(0, 400));
  const tgz = path.join(dest, parseNpmJson(r)[0].filename);
  assert.ok(fs.existsSync(tgz), 'tarball exists: ' + tgz);
  const list = spawnSync('tar', ['-tvzf', tgz], { encoding: 'utf8' }).stdout;
  const line = list.split('\n').find((l) => /package\/bin\/tpm$/.test(l));
  assert.ok(line && /^-rwxr-xr-x/.test(line), 'bin/tpm mode in the tarball: ' + line);
  assert.ok(!/package\/(tmp|node_modules)\//.test(list) && !/\/tests\//.test(list) && !/\.test\.js/.test(list), 'no junk/tests in the tarball');
  const ex = mkScratch('pack-extract');
  assert.strictEqual(spawnSync('tar', ['-xzf', tgz, '-C', ex]).status, 0);
  const pkg = path.join(ex, 'package');
  const env = { PATH: process.env.PATH, HOME: fake.home };
  const home = spawnSync(path.join(pkg, 'bin', 'tpm'), ['home'], { env, encoding: 'utf8', cwd: ex });
  assert.strictEqual(home.status, 0, home.stderr);
  assert.strictEqual(fs.realpathSync(home.stdout.trim()), fs.realpathSync(pkg), 'bin/tpm self-locates the extracted package');
  for (const args of [['--help'], ['task', '--help'], ['session', '--help'], ['workflow', '--help'], ['hooks', '--help'], ['plugin', '--help'], ['reading-list', 'subagent'], ['doc', 'claude-context/methodology/tool-conventions.md']]) {
    const r2 = spawnSync('node', [path.join(pkg, 'tools', 'tpm.js'), ...args], { env, encoding: 'utf8', cwd: ex });
    assert.strictEqual(r2.status, 0, `extracted tpm ${args.join(' ')}: ${r2.stderr.slice(0, 200)}`);
  }
  const ss = spawnSync('node', [path.join(pkg, 'tools', 'tpm.js'), 'hooks', 'session-start'], { env: { ...env, CLAUDE_ENV_FILE: path.join(ex, 'envf'), CLAUDE_PROJECT_DIR: ex, CLAUDE_PLUGIN_ROOT: pkg }, input: '{}', encoding: 'utf8' });
  assert.strictEqual(ss.status, 0); assert.strictEqual(ss.stdout, '');
  const envf = fs.readFileSync(path.join(ex, 'envf'), 'utf8');
  assert.ok(envf.includes('TPM_HOME') && envf.includes('TPM_PROJECT_ROOT'), 'extracted package runs the hook: ' + envf);
  // (the tarball lives in the OS-temp scratch dir, outside the bundle — nothing to clean inside the repo)
});

// ── bite proofs on the copy ──
const pkgPath = path.join(copy, 'package.json');
const orig = fs.readFileSync(pkgPath, 'utf8');
const withFiles = (fn) => { const j = JSON.parse(orig); fn(j); fs.writeFileSync(pkgPath, JSON.stringify(j, null, 2)); };

check('BITE: dropping "bin" from package.json `files` → bin/tpm missing is reported', () => {
  withFiles((j) => { j.files = j.files.filter((x) => x !== 'bin'); });
  assert.ok(problems(copy, packList(copy)).includes('MISSING bin/tpm'));
  fs.writeFileSync(pkgPath, orig);
});

check('BITE: dropping the "!**/tests/**" exclusion → shipped tests are reported', () => {
  withFiles((j) => { j.files = j.files.filter((x) => x !== '!**/tests/**' && x !== '!**/*.test.js'); });
  const p = problems(copy, packList(copy));
  assert.ok(p.some((x) => /SHOULD NOT SHIP \(test\)/.test(x)), p.slice(0, 3).join('\n'));
  fs.writeFileSync(pkgPath, orig);
});

check('BITE: dropping "hooks" / ".claude/skills" from `files`, and a non-executable bin/tpm, are each reported', () => {
  withFiles((j) => { j.files = j.files.filter((x) => x !== 'hooks' && x !== '.claude/skills'); });
  const p = problems(copy, packList(copy));
  assert.ok(p.includes('MISSING hooks/hooks.json'));
  assert.ok(p.some((x) => /^MISSING \.claude\/skills\//.test(x)));
  fs.writeFileSync(pkgPath, orig);
  fs.chmodSync(path.join(copy, 'bin', 'tpm'), 0o644);
  const q = problems(copy, packList(copy));
  assert.ok(q.some((x) => /bin\/tpm is not executable/.test(x)), q.join('\n'));
  fs.chmodSync(path.join(copy, 'bin', 'tpm'), 0o755);
  assert.deepStrictEqual(problems(copy, packList(copy)), [], 'restored copy is healthy again');
});

process.stdout.write(`\nPASS — ${count} checks\n`);
