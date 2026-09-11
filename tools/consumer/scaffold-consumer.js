#!/usr/bin/env node
/**
 * scaffold-consumer.js — scaffold a NEW claude-tpm CONSUMER project (a downstream project that adopts
 * claude-tpm as a dependency), per Jason's conventions (claude-context/dev/jason-conventions.md).
 *
 * PURPOSE
 *   Turn an empty (or new) sibling folder into a ready-to-adopt claude-tpm consumer with ZERO hand file
 *   layout: it writes package.json (name @codercowboy/<folder>, the `file:` dep on claude-tpm, MIT,
 *   author credits), a CLAUDE.md that boots claude-tpm (reads its boot.md → triggers vendored-skill
 *   discovery), a README.md (MIT + credits + the codercowboy GitHub link), a .gitignore, and a LICENSE.
 *   After scaffolding, one `npm i` installs claude-tpm into node_modules. See the flow +
 *   the known relocatable-paths limitation in docs/consuming-claude-tpm.md.
 *
 *   AUTO-DETECTS an EXISTING project (one that already has a package.json): instead of a full starter
 *   scaffold it MERGES surgically — adds the claude-tpm dep to the existing package.json, appends a
 *   delimited boot block to the existing CLAUDE.md (idempotent), merges .claude/settings.json, and
 *   creates .claude/claude-tpm/config.json — never touching the project's README/LICENSE/.gitignore.
 *
 * USAGE
 *   node tools/consumer/scaffold-consumer.js <target-dir> [options]
 *     --name <pkg>          package.json name (default: @codercowboy/<target-folder-basename>)
 *     --tpm-path <path>     path to claude-admin (the dep source); default: THIS repo, as a path
 *                           relative FROM the target dir (so the sibling `file:../claude-admin` shape works)
 *     --description <text>  package/README description
 *     --author <name>       default "Jason Baker"
 *     --author-email <e>    default "jason@onejasonforsale.com"
 *     --github-user <u>     default "codercowboy" (for the README repo link)
 *     --force               overwrite existing files (default: refuse)
 *     --quiet               suppress per-file progress
 *     -h, --help
 *
 * CONVENTIONS: zero runtime deps (Node built-ins only). Portable `node scaffold-consumer.js …`. Also a
 * module (module.exports) so tests drive the pure helpers directly. (See methodology/tool-conventions.md.)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// This repo's root = two levels up from tools/consumer/.
const CLAUDE_TPM_ROOT = path.resolve(__dirname, '..', '..');
const TPM_PKG_NAME = '@codercowboy/claude-tpm';
// Where the `file:` dep lands in a consumer's tree (relative to the consumer root). This is the
// `bundle.home` — a RELATIVE literal, since ${CLAUDE_PROJECT_DIR} does NOT interpolate in an env value
// (see claude-context/dev/child-project-path-resolution.md). The shell expands $TPM_HOME from cwd=root.
const TPM_BUNDLE_HOME = `node_modules/${TPM_PKG_NAME}`;
const DEFAULTS = {
  scope: '@codercowboy',
  author: 'Jason Baker',
  authorEmail: 'jason@onejasonforsale.com',
  githubUser: 'codercowboy',
  version: '0.1.0',
};

// ── file content builders (each pure: opts → string) ────────────────────────

function pkgJson({ name, description, author, authorEmail, githubUser, repo, depPath }) {
  return JSON.stringify({
    name,
    version: DEFAULTS.version,
    description: description || `A claude-tpm consumer project (${repo}).`,
    license: 'MIT',
    author: `${author} <${authorEmail}>`,
    contributors: ['Claude (Anthropic) — code, docs, and tools'],
    repository: { type: 'git', url: `https://github.com/${githubUser}/${repo}` },
    homepage: `https://github.com/${githubUser}/${repo}`,
    dependencies: { [TPM_PKG_NAME]: `file:${depPath}` },
  }, null, 2) + '\n';
}

function claudeMd({ repo }) {
  return [
    '# CLAUDE.md',
    '',
    `\`${repo}\` consumes the **claude-tpm** framework (installed via npm as \`${TPM_PKG_NAME}\`).`,
    '',
    '## On boot — read this first',
    '',
    `Before anything else, read \`node_modules/${TPM_PKG_NAME}/boot.md\` and follow its instructions.`,
    'That read boots claude-tpm and surfaces its vendored `tpm-*` skills (Claude Code discovers the',
    'nested `.claude/skills/` once a file in the vendored dir is read). Everything about the',
    'orchestrator role, the reading chain, and the workflow lives in claude-tpm — this file just points',
    'you at it.',
    '',
    '## This project',
    '',
    '_(Add your project-specific context, goals, and constraints here.)_',
    '',
  ].join('\n');
}

function readmeMd({ repo, description, author, authorEmail, githubUser }) {
  return [
    `# ${repo}`,
    '',
    description || `A claude-tpm consumer project.`,
    '',
    '## Credits',
    '',
    `1. **Ideas:** ${author} (${authorEmail}) — the "ideas guy".`,
    '2. **Code / docs / tools:** Claude (Anthropic).',
    '',
    '## License',
    '',
    'MIT — see [LICENSE](./LICENSE).',
    '',
    `<https://github.com/${githubUser}/${repo}>`,
    '',
  ].join('\n');
}

function gitignore() {
  return ['node_modules/', 'tmp/', '.playwright-mcp/', '.DS_Store', ''].join('\n');
}

function licenseMit({ author, year }) {
  return [
    'MIT License',
    '',
    `Copyright (c) ${year} ${author}`,
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy',
    'of this software and associated documentation files (the "Software"), to deal',
    'in the Software without restriction, including without limitation the rights',
    'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
    'copies of the Software, and to permit persons to whom the Software is',
    'furnished to do so, subject to the following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included in all',
    'copies or substantial portions of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
    'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
    'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
    'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
    'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
    'SOFTWARE.',
    '',
  ].join('\n');
}

// `.claude/claude-tpm/config.json` — the SOURCE OF TRUTH for claude-tpm consumer config (extends the
// same config the tpm-session/tpm-task tools read). `bundle.home` is the relative path to the vendored
// bundle; the scaffolder generates .claude/settings.json's env.TPM_HOME + hook paths FROM it.
function tpmConfigJson() {
  return JSON.stringify({
    bundle: { home: TPM_BUNDLE_HOME },
    session: { enabled: true },
    tasks: { enabled: true },
  }, null, 2) + '\n';
}

// The Claude-Code-facing plumbing that MUST live in .claude/settings.json (the only file CC reads env +
// hooks from): env.TPM_HOME (relative literal → shell resolves $TPM_HOME for Bash tool-invocations) and
// the two PreToolUse hooks (expand → resolves ${TPM_HOME} in read paths; gate → the spawn sign-off).
// Hook command paths use ${CLAUDE_PROJECT_DIR} (which DOES interpolate in a command string).
function settingsObject(bundleHome) {
  const hookCmd = (rel) => `node "\${CLAUDE_PROJECT_DIR}/${bundleHome}/${rel}"`;
  return {
    env: { TPM_HOME: bundleHome },
    hooks: {
      PreToolUse: [
        { matcher: 'Agent|Task', hooks: [{ type: 'command', command: hookCmd('tools/workflow/hooks/gate-spawn.js') }] },
        { matcher: 'Read|Glob|Grep|NotebookRead', hooks: [{ type: 'command', command: hookCmd('tools/consumer/hooks/expand-tpm-home.js') }] },
      ],
    },
  };
}

// Merge our env + hooks into any existing .claude/settings.json (never clobber the user's other config).
// Returns { text, action }. Hooks are deduped by command string; env.TPM_HOME is set (ours wins).
function mergeSettings(targetPath, bundleHome) {
  const add = settingsObject(bundleHome);
  let cur = {}; let existed = false;
  if (fs.existsSync(targetPath)) {
    existed = true;
    try { cur = JSON.parse(fs.readFileSync(targetPath, 'utf8')) || {}; } catch (_e) { cur = {}; }
  }
  cur.env = Object.assign({}, cur.env, add.env);
  cur.hooks = cur.hooks || {};
  cur.hooks.PreToolUse = Array.isArray(cur.hooks.PreToolUse) ? cur.hooks.PreToolUse : [];
  const seen = new Set();
  for (const e of cur.hooks.PreToolUse) for (const h of (e.hooks || [])) seen.add(h.command);
  let addedHooks = 0;
  for (const e of add.hooks.PreToolUse) {
    if ((e.hooks || []).some((h) => seen.has(h.command))) continue; // already wired
    cur.hooks.PreToolUse.push(e); addedHooks += 1;
  }
  return { text: JSON.stringify(cur, null, 2) + '\n', action: existed ? `merged (+${addedHooks} hooks)` : 'created' };
}

// ── into-existing merges (surgical; never clobber the project's own files) ───

// Add the claude-tpm dep to an existing package.json, preserving everything else.
function mergePackageJson(targetPath, depSpec) {
  let cur;
  try { cur = JSON.parse(fs.readFileSync(targetPath, 'utf8')); }
  catch (e) { throw new Error(`existing package.json is not valid JSON: ${e.message}`); }
  cur.dependencies = cur.dependencies || {};
  const prev = cur.dependencies[TPM_PKG_NAME];
  cur.dependencies[TPM_PKG_NAME] = depSpec;
  const action = prev === undefined ? 'added dep' : (prev === depSpec ? 'dep unchanged' : 'updated dep');
  return { text: JSON.stringify(cur, null, 2) + '\n', action };
}

// The claude-tpm boot block appended to an existing CLAUDE.md — delimited by a marker so it's
// idempotent (re-running never double-adds) and easy to find/remove.
const CLAUDE_MD_MARKER = '<!-- claude-tpm:boot -->';
function claudeMdBlock() {
  return [
    '',
    CLAUDE_MD_MARKER,
    '## claude-tpm',
    '',
    'Before anything else, read `node_modules/@codercowboy/claude-tpm/boot.md` and follow its',
    'instructions — this boots the vendored claude-tpm framework and surfaces its `tpm-*` skills.',
    '<!-- /claude-tpm:boot -->',
    '',
  ].join('\n');
}
// Append the boot block to an existing CLAUDE.md (idempotent via the marker); create a minimal one if
// the project has no CLAUDE.md yet (it has a package.json, so it IS an existing project).
function mergeClaudeMd(targetPath, repo) {
  if (fs.existsSync(targetPath)) {
    const cur = fs.readFileSync(targetPath, 'utf8');
    if (cur.includes(CLAUDE_MD_MARKER)) return { text: cur, action: 'boot block already present' };
    return { text: cur + (cur.endsWith('\n') ? '' : '\n') + claudeMdBlock(), action: 'appended boot block' };
  }
  return { text: `# ${repo}\n${claudeMdBlock()}`, action: 'created with boot block' };
}

// ── the scaffold ────────────────────────────────────────────────────────────

/**
 * Scaffold a consumer project into targetDir. Returns { created:[], skipped:[] }.
 * @param {string} targetDir
 * @param {object} opts  { name, tpmPath, description, author, authorEmail, githubUser, year, force, quiet }
 */
function scaffoldConsumer(targetDir, opts = {}) {
  const abs = path.resolve(targetDir);
  const repo = path.basename(abs);
  const author = opts.author || DEFAULTS.author;
  const authorEmail = opts.authorEmail || DEFAULTS.authorEmail;
  const githubUser = opts.githubUser || DEFAULTS.githubUser;
  const name = opts.name || `${DEFAULTS.scope}/${repo}`;
  const year = opts.year || String(new Date().getFullYear());
  // dep path: path FROM the target dir TO claude-admin (or an explicit --tpm-path), relative when possible.
  const tpmRoot = opts.tpmPath ? path.resolve(opts.tpmPath) : CLAUDE_TPM_ROOT;
  let depPath = path.relative(abs, tpmRoot);
  if (!depPath || depPath === '') depPath = '.';
  if (!depPath.startsWith('.') && !path.isAbsolute(depPath)) depPath = './' + depPath;

  fs.mkdirSync(abs, { recursive: true });

  // AUTO-DETECT mode: an existing project already has a package.json. Fresh dir → full starter scaffold;
  // existing project → surgical merge (add the dep + a CLAUDE.md boot block, never touch README/LICENSE/…).
  const existing = fs.existsSync(path.join(abs, 'package.json'));
  const depSpec = `file:${depPath}`;
  const created = []; const skipped = []; const merged = [];
  const note = (m) => { if (!opts.quiet) process.stdout.write(`  ${m}\n`); };

  if (existing) {
    const pkgPath = path.join(abs, 'package.json');
    const pm = mergePackageJson(pkgPath, depSpec);
    fs.writeFileSync(pkgPath, pm.text); merged.push(`package.json (${pm.action})`); note(`package.json: ${pm.action}`);

    const claudePath = path.join(abs, 'CLAUDE.md');
    const cm = mergeClaudeMd(claudePath, repo);
    fs.writeFileSync(claudePath, cm.text); merged.push(`CLAUDE.md (${cm.action})`); note(`CLAUDE.md: ${cm.action}`);
    // README / LICENSE / .gitignore: intentionally untouched — the existing project owns those.
  } else {
    const shared = { name, repo, description: opts.description, author, authorEmail, githubUser, depPath, year };
    const files = [
      ['package.json', pkgJson(shared)],
      ['CLAUDE.md', claudeMd(shared)],
      ['README.md', readmeMd(shared)],
      ['.gitignore', gitignore()],
      ['LICENSE', licenseMit(shared)],
    ];
    for (const [rel, content] of files) {
      const target = path.join(abs, rel);
      if (fs.existsSync(target) && !opts.force) { skipped.push(rel); note(`skip (exists): ${rel}`); continue; }
      fs.writeFileSync(target, content); created.push(rel); note(`wrote: ${rel}`);
    }
  }

  // BOTH modes: the claude-tpm config source of truth (create if missing) + the settings plumbing (merge).
  const cfgPath = path.join(abs, '.claude', 'claude-tpm', 'config.json');
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  if (fs.existsSync(cfgPath) && !opts.force) { skipped.push('.claude/claude-tpm/config.json'); note('skip (exists): .claude/claude-tpm/config.json'); }
  else { fs.writeFileSync(cfgPath, tpmConfigJson()); created.push('.claude/claude-tpm/config.json'); note('wrote: .claude/claude-tpm/config.json'); }

  // .claude/settings.json is MERGED (never skip-if-exists) so env + hooks are always wired without
  // clobbering any settings the project already has.
  const settingsPath = path.join(abs, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const { text, action } = mergeSettings(settingsPath, TPM_BUNDLE_HOME);
  fs.writeFileSync(settingsPath, text); merged.push(`.claude/settings.json (${action})`); note(`${action}: .claude/settings.json`);

  return { targetDir: abs, repo, name, depPath, tpmRoot, mode: existing ? 'existing' : 'fresh', created, skipped, merged, bundleHome: TPM_BUNDLE_HOME };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function printHelp() {
  const src = fs.readFileSync(__filename, 'utf8');
  const m = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (m) process.stdout.write(m[1].split('\n').map((l) => l.replace(/^ \*\s?/, '')).join('\n').trim() + '\n');
}

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i];
    if (x === '-h' || x === '--help') a.help = true;
    else if (x === '--force') a.force = true;
    else if (x === '--quiet') a.quiet = true;
    else if (x === '--smoke') a.smoke = true;
    else if (x === '--name') { a.name = argv[++i]; }
    else if (x === '--tpm-path') { a.tpmPath = argv[++i]; }
    else if (x === '--description') { a.description = argv[++i]; }
    else if (x === '--author') { a.author = argv[++i]; }
    else if (x === '--author-email') { a.authorEmail = argv[++i]; }
    else if (x === '--github-user') { a.githubUser = argv[++i]; }
    else if (x === '--year') { a.year = argv[++i]; }
    else if (x.startsWith('--')) { process.stderr.write(`Unknown flag: ${x}\n`); process.exit(2); }
    else a._.push(x);
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args._[0]) { printHelp(); process.exit(args.help ? 0 : 1); }
  try {
    const r = scaffoldConsumer(args._[0], args);
    const verb = r.mode === 'existing' ? 'installed claude-tpm into existing project' : 'scaffolded consumer';
    process.stdout.write(`\n✓ ${verb} "${r.name}" at ${r.targetDir}\n`);
    process.stdout.write(`  claude-tpm dep: "${TPM_PKG_NAME}": "file:${r.depPath}"\n`);
    if (r.merged.length) process.stdout.write(`  merged: ${r.merged.join('; ')}\n`);
    if (r.skipped.length) process.stdout.write(`  (skipped existing: ${r.skipped.join(', ')}${r.mode === 'fresh' ? ' — pass --force to overwrite' : ''})\n`);
    const smokePath = path.join(CLAUDE_TPM_ROOT, 'tools', 'consumer', 'smoke.sh');
    if (args.smoke) {
      // --smoke: install the dep + run the consumer smoke tests right here, so scaffold→verify is one honest loop.
      const cp = require('child_process');
      process.stdout.write('\n=== --smoke: npm i + consumer smoke tests ===\n');
      try {
        cp.execFileSync('npm', ['--prefix', r.targetDir, 'install', '--no-audit', '--no-fund'], { stdio: 'inherit' });
        cp.execFileSync('bash', [smokePath, r.targetDir], { stdio: 'inherit' });
      } catch (e) {
        process.stdout.write(`\n(smoke reported a failure — that is the point of running it; exit ${e.status})\n`);
      }
    } else {
      process.stdout.write('\nNext:\n');
      process.stdout.write(`  cd '${r.targetDir}' && npm i     # installs claude-tpm into node_modules/${TPM_PKG_NAME}/\n`);
      process.stdout.write(`  then verify:  bash '${smokePath}' '${r.targetDir}'\n`);
      process.stdout.write('  (or re-run this scaffolder with --smoke to install + smoke-test in one shot)\n');
    }
  } catch (err) {
    process.stderr.write(`scaffold-consumer: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  scaffoldConsumer, pkgJson, claudeMd, readmeMd, gitignore, licenseMit,
  tpmConfigJson, settingsObject, mergeSettings, mergePackageJson, mergeClaudeMd, claudeMdBlock,
  CLAUDE_TPM_ROOT, TPM_PKG_NAME, TPM_BUNDLE_HOME, CLAUDE_MD_MARKER, DEFAULTS,
};
