#!/usr/bin/env node
/**
 * tpm-consumer-install.js — graft claude-tpm onto an EXISTING consumer project. Replaces the retired
 * scaffolder (tpm-consumer-scaffold.js, moved to tmp/safe-to-delete/): no package.json/README/LICENSE/
 * .gitignore authoring — this tool only adds the claude-tpm dependency + trusts/installs the plugin.
 * Calls `npm` and `claude plugin …` DIRECTLY (it does NOT go through tpm-consumer-manage-plugin.js).
 *
 * PURPOSE
 *   Check-then-act, idempotent, 4-step install into the target dir (default: cwd):
 *     1. package.json guard — if missing, print the `npm init -y` instruction and exit 1 (never
 *        creates it — authoring project identity is the user's call, not this tool's).
 *     2. claude-tpm dependency — `npm install <from> --save-optional` if not already declared.
 *     3. marketplace + plugin — `claude plugin marketplace add ./node_modules/@codercowboy/claude-tpm
 *        --scope project` then `claude plugin install claude-tpm@claude-tpm-market --scope project`,
 *        whichever part is missing (installing usually also enables — see step 4).
 *     4. project enablement — `claude plugin enable claude-tpm@claude-tpm-market --scope project`,
 *        ONLY if the plugin is installed but currently disabled for this project (step 3 usually
 *        already leaves it enabled).
 *   Deliberately NOT handled here: writing env.TPM_HOME or hooks into any settings.json — that step is
 *   gated (see dev/boot-redesign/install-uninstall-design.md) on the bet the plugin itself carries the
 *   hooks and env.TPM_HOME gets eliminated. `claude plugin … --scope project` performs its own
 *   in-repo settings declaration; this tool never touches settings.json directly.
 *
 * USAGE
 *   node tools/consumer/tpm-consumer-install.js [options]
 *
 *   Options:
 *     --dir <path>     target project dir (default: cwd)
 *     --from <spec>    npm dep spec for step 2, e.g. `file:../claude-tpm` or a registry version.
 *                      Default: self-located — this script finds the claude-tpm bundle it ships inside
 *                      (walking up from itself for .claude-plugin/marketplace.json) and computes the
 *                      relative `file:` path from --dir to that bundle root (the same shape as the
 *                      dogfooded `"file:../claude-tpm"` dependency). Errors out if it can't self-locate
 *                      and no --from was given.
 *     --quiet          non-interactive: assume yes to every step, pass -y to `claude plugin
 *                      install/uninstall` (required when stdin/stdout isn't a TTY). Still exits 1 on
 *                      real errors.
 *     --force          skip the "already done" checks and (re-)run every step; treat an
 *                      already-added/already-installed response as success, not error. Still asks per
 *                      step unless combined with --quiet.
 *     --check          read-only: run every state check, print a PASS/FAIL checklist, change nothing.
 *                      Exits non-zero if anything is missing. (The consumer "doctor".)
 *     -h, --help
 *
 *   Examples:
 *     node tools/consumer/tpm-consumer-install.js --check
 *     node tools/consumer/tpm-consumer-install.js --dir ../some-project
 *     node tools/consumer/tpm-consumer-install.js --quiet --from file:../claude-tpm
 *
 * CONVENTIONS: zero runtime deps (Node built-ins only), portable (`node …/tpm-consumer-install.js`),
 *   also a module (module.exports) so tests can drive the pure helpers directly. See
 *   claude-context/methodology/tool-conventions.md. Tests are deliberately deferred for this first pass.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const TPM_PKG_NAME = '@codercowboy/claude-tpm';
const MARKETPLACE_NAME = 'claude-tpm-market';
const PLUGIN_NAME = 'claude-tpm';
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
// Fixed regardless of --from — this is where `npm install` lands the dep in the TARGET's own tree.
const MARKETPLACE_SOURCE = `./node_modules/${TPM_PKG_NAME}`;
const BUNDLE_MARKER = path.join('.claude-plugin', 'marketplace.json');

// ── self-location (per tool-conventions.md — never hardcode absolutes / __dirname gymnastics for
// project-internal locations; walk up for a repo marker instead) ───────────────────────────────────

function findBundleRoot(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, BUNDLE_MARKER))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

// Default --from: the relative `file:` path from targetDir to the bundle this script ships inside.
function defaultFromSpec(targetDir) {
  const bundleRoot = findBundleRoot(__dirname);
  if (!bundleRoot) return null;
  let rel = path.relative(path.resolve(targetDir), bundleRoot);
  if (rel === '') rel = '.';
  else if (!rel.startsWith('.') && !path.isAbsolute(rel)) rel = './' + rel;
  return `file:${rel}`;
}

// ── package.json helpers ─────────────────────────────────────────────────────────────────────────

function readPackageJson(dir) {
  const p = path.join(dir, 'package.json');
  if (!fs.existsSync(p)) return { exists: false, value: null, error: null };
  try { return { exists: true, value: JSON.parse(fs.readFileSync(p, 'utf8')), error: null }; }
  catch (e) { return { exists: true, value: null, error: e.message }; }
}

function hasTpmDependency(pkg) {
  if (!pkg) return false;
  return ['dependencies', 'devDependencies', 'optionalDependencies']
    .some((bucket) => pkg[bucket] && Object.prototype.hasOwnProperty.call(pkg[bucket], TPM_PKG_NAME));
}

// ── `claude` state checks (read-only; defensive about JSON shape) ───────────────────────────────────

function claudeCliAvailable() {
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  return !(r.error && r.error.code === 'ENOENT');
}

function runClaudeJson(argv) {
  const r = spawnSync('claude', argv, { encoding: 'utf8' });
  if (r.error || r.status !== 0 || !r.stdout) return null;
  try { return JSON.parse(r.stdout); } catch (_e) { return null; }
}

function marketplaceRegistered() {
  const list = runClaudeJson(['plugin', 'marketplace', 'list', '--json']);
  return Array.isArray(list) && list.some((m) => m && m.name === MARKETPLACE_NAME);
}

// Best-effort parse of `claude plugin list --json` (an array of installed-plugin objects). Field names
// aren't pinned down by any spec we have on hand (this machine has none installed to sample), so match
// defensively across the plausible shapes rather than assume one.
function pluginState() {
  const list = runClaudeJson(['plugin', 'list', '--json']);
  const arr = Array.isArray(list) ? list : (list && Array.isArray(list.installed) ? list.installed : null);
  if (!arr) return { installed: false, enabled: false };
  const entry = arr.find((e) => e && (
    e.id === PLUGIN_ID || e.pluginId === PLUGIN_ID ||
    (e.name === PLUGIN_NAME && (e.marketplace === MARKETPLACE_NAME || e.marketplaceName === MARKETPLACE_NAME))
  ));
  if (!entry) return { installed: false, enabled: false };
  const enabled = entry.enabled !== false && entry.status !== 'disabled';
  return { installed: true, enabled };
}

// ── child-process runner (captures output so the --force "already" heuristic can inspect it, then
// echoes it so the user still sees what happened) ────────────────────────────────────────────────────

function runChild(bin, argv, cwd) {
  const r = spawnSync(bin, argv, { cwd, encoding: 'utf8' });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error && r.error.code === 'ENOENT') return { status: 127, enoent: true, combined: '' };
  return { status: r.status, enoent: false, combined: (r.stdout || '') + (r.stderr || '') };
}

// ── interactive consent (zero-dep: Node core `readline`) ────────────────────────────────────────────

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    let answered = false;
    rl.question(question, (answer) => { answered = true; rl.close(); resolve(answer); });
    rl.on('close', () => { if (!answered) resolve(''); });
  });
}

// Run one REPL step: check state, print command+edit+what, ask consent (unless --quiet), run, report.
// `already` = the state check already satisfies this step (skipped unless --force).
async function doStep(opts, step) {
  const { already, describe, command, edit, what, bin, argv, cwd } = step;
  if (already && !opts.force) {
    process.stdout.write(`✓ ${describe} — already done, skipping.\n`);
    return { ok: true, skipped: true };
  }
  process.stdout.write(`\n${describe}\n`);
  process.stdout.write(`  command: ${command}\n`);
  process.stdout.write(`  edits:   ${edit}\n`);
  process.stdout.write(`  does:    ${what}\n`);
  if (!opts.quiet) {
    const answer = (await ask('  Run this? [y/N] ')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      process.stdout.write('  declined — stopping.\n');
      return { ok: false, declined: true };
    }
  }
  const res = runChild(bin, argv, cwd);
  if (res.enoent) {
    process.stderr.write(`  ✗ '${bin}' not found on PATH.\n`);
    return { ok: false };
  }
  if (res.status !== 0) {
    if (opts.force && /already/i.test(res.combined)) {
      process.stdout.write('  (already in the desired state — treating as success under --force)\n');
      return { ok: true, alreadyOk: true };
    }
    process.stderr.write(`  ✗ exited ${res.status}\n`);
    return { ok: false };
  }
  process.stdout.write('  ✓ done.\n');
  return { ok: true };
}

// ── --check mode (read-only doctor) ──────────────────────────────────────────────────────────────────

function runCheck(targetDir) {
  const rows = [];
  const pkgRead = readPackageJson(targetDir);
  rows.push({ label: 'package.json exists', pass: pkgRead.exists && !pkgRead.error,
    note: pkgRead.error ? `(invalid JSON: ${pkgRead.error})` : '' });

  const depOk = pkgRead.exists && !pkgRead.error && hasTpmDependency(pkgRead.value);
  rows.push({ label: `"${TPM_PKG_NAME}" declared as a dependency`, pass: !!depOk,
    note: (pkgRead.exists && !pkgRead.error) ? '' : '(skipped — no valid package.json)' });

  const claudeOk = claudeCliAvailable();
  const marketOk = claudeOk && marketplaceRegistered();
  rows.push({ label: `marketplace "${MARKETPLACE_NAME}" registered`, pass: marketOk,
    note: claudeOk ? '' : '(`claude` CLI not found on PATH)' });

  const pstate = claudeOk ? pluginState() : { installed: false, enabled: false };
  rows.push({ label: `plugin ${PLUGIN_ID} installed`, pass: pstate.installed,
    note: claudeOk ? '' : '(`claude` CLI not found on PATH)' });
  rows.push({ label: `plugin ${PLUGIN_ID} enabled for this project`, pass: pstate.installed && pstate.enabled,
    note: (claudeOk && !pstate.installed) ? '(skipped — not installed)' : '' });

  let allPass = true;
  for (const row of rows) {
    process.stdout.write(`  [${row.pass ? 'PASS' : 'FAIL'}] ${row.label}${row.note ? ' ' + row.note : ''}\n`);
    if (!row.pass) allPass = false;
  }
  if (!pkgRead.exists) process.stdout.write('\n  Fix: run `npm init -y` in the target dir, then re-run install (without --check).\n');
  return allPass ? 0 : 1;
}

// ── the install run (default / --quiet / --force) ───────────────────────────────────────────────────

async function runInstall(opts) {
  const targetDir = path.resolve(opts.dir);

  if (!claudeCliAvailable()) {
    process.stderr.write('error: `claude` CLI not found on PATH — install Claude Code first.\n');
    return 1;
  }

  // Step 1 — package.json guard. Never created by this tool, in ANY mode (--force included): authoring
  // project identity is the user's call, not ours. Load-bearing: step 2 needs it to exist.
  const pkgRead = readPackageJson(targetDir);
  if (!pkgRead.exists) {
    process.stdout.write(`No package.json found in ${targetDir}.\n\n`);
    process.stdout.write('  Run this yourself first:\n');
    process.stdout.write('    npm init -y\n');
    process.stdout.write('  (writes a default package.json — name/version guessed from the folder, ISC\n');
    process.stdout.write('  license, no dependencies — that step 2 below needs to exist before it can add\n');
    process.stdout.write('  an optional dependency to it.)\n');
    return 1;
  }
  if (pkgRead.error) {
    process.stderr.write(`error: ${path.join(targetDir, 'package.json')} is not valid JSON: ${pkgRead.error}\n`);
    return 1;
  }
  const pkg = pkgRead.value;

  // Step 2 — claude-tpm dependency.
  const fromSpec = opts.from || defaultFromSpec(targetDir);
  if (!fromSpec) {
    process.stderr.write('error: could not self-locate the claude-tpm bundle to compute a default --from;\n');
    process.stderr.write('  pass --from <spec> explicitly (e.g. --from file:../claude-tpm).\n');
    return 1;
  }
  const r2 = await doStep(opts, {
    already: hasTpmDependency(pkg),
    describe: 'Step 2/4 — add the claude-tpm dependency',
    command: `npm install ${fromSpec} --save-optional`,
    edit: `${path.join(targetDir, 'package.json')} (optionalDependencies) + its lockfile + node_modules/${TPM_PKG_NAME}`,
    what: `Adds "${TPM_PKG_NAME}": "${fromSpec}" to optionalDependencies, updates the lockfile, and\n` +
      `           creates the node_modules/${TPM_PKG_NAME} symlink/copy that step 3 points the marketplace at.`,
    bin: 'npm', argv: ['install', fromSpec, '--save-optional'], cwd: targetDir,
  });
  if (!r2.ok) return 1;

  // Step 3a — marketplace registration. (marketplace add/remove take no -y flag; unaffected by --quiet.)
  const r3a = await doStep(opts, {
    already: marketplaceRegistered(),
    describe: 'Step 3/4 — register the claude-tpm marketplace',
    command: `claude plugin marketplace add ${MARKETPLACE_SOURCE} --scope project`,
    edit: "this project's Claude Code settings (project scope)",
    what: `Trusts/registers ${MARKETPLACE_SOURCE} as marketplace "${MARKETPLACE_NAME}" so its plugin becomes installable.`,
    bin: 'claude', argv: ['plugin', 'marketplace', 'add', MARKETPLACE_SOURCE, '--scope', 'project'], cwd: targetDir,
  });
  if (!r3a.ok) return 1;

  // Step 3b — plugin install (usually also enables it for this project — see step 4).
  const r3b = await doStep(opts, {
    already: pluginState().installed,
    describe: 'Step 3/4 — install the claude-tpm plugin',
    command: `claude plugin install ${PLUGIN_ID} --scope project${opts.quiet ? ' -y' : ''}`,
    edit: "~/.claude/plugins/ (global cache) + this project's plugin registry (project scope)",
    what: `Installs ${PLUGIN_ID} and, in the common case, enables it for this project in the same step.`,
    bin: 'claude', argv: ['plugin', 'install', PLUGIN_ID, '--scope', 'project'].concat(opts.quiet ? ['-y'] : []), cwd: targetDir,
  });
  if (!r3b.ok) return 1;

  // Step 4 — project enablement. Only a real action when step 3 left it installed-but-disabled.
  const afterInstall = pluginState();
  const needsEnable = afterInstall.installed && !afterInstall.enabled;
  const r4 = await doStep(opts, {
    already: !needsEnable,
    describe: 'Step 4/4 — enable the plugin for this project',
    command: `claude plugin enable ${PLUGIN_ID} --scope project`,
    edit: "this project's Claude Code plugin registry (project scope)",
    what: `Flips ${PLUGIN_ID} on for this project. Step 3 usually already leaves it enabled — this only\n` +
      '           runs a standalone enable when the plugin is installed but currently disabled here.',
    bin: 'claude', argv: ['plugin', 'enable', PLUGIN_ID, '--scope', 'project'], cwd: targetDir,
  });
  if (!r4.ok) return 1;

  process.stdout.write(`\n✓ claude-tpm is installed and enabled (${PLUGIN_ID}) for ${targetDir}\n`);
  return 0;
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

function printHelp() {
  const src = fs.readFileSync(__filename, 'utf8');
  const m = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (m) process.stdout.write(m[1].split('\n').map((l) => l.replace(/^ \*\s?/, '')).join('\n').trim() + '\n');
}

function parseArgs(argv) {
  const a = { dir: process.cwd(), from: null, quiet: false, force: false, check: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i];
    if (x === '-h' || x === '--help') a.help = true;
    else if (x === '--quiet') a.quiet = true;
    else if (x === '--force') a.force = true;
    else if (x === '--check') a.check = true;
    else if (x === '--from') { a.from = argv[i + 1]; i += 1; }
    else if (x === '--dir') { a.dir = argv[i + 1]; i += 1; }
    else { process.stderr.write(`Unknown argument: ${x}\n`); process.exit(2); }
  }
  return a;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); process.exit(0); }
  const targetDir = path.resolve(opts.dir);
  if (opts.check) { process.exit(runCheck(targetDir)); }
  process.exit(await runInstall(opts));
}

if (require.main === module) {
  main().catch((err) => { process.stderr.write(`tpm-consumer-install: ${err.message}\n`); process.exit(1); });
}

module.exports = {
  main, runInstall, runCheck, parseArgs, findBundleRoot, defaultFromSpec,
  readPackageJson, hasTpmDependency, claudeCliAvailable, marketplaceRegistered, pluginState,
  TPM_PKG_NAME, MARKETPLACE_NAME, PLUGIN_NAME, PLUGIN_ID, MARKETPLACE_SOURCE,
};
