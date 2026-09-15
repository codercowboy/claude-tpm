#!/usr/bin/env node
/**
 * tpm-consumer-uninstall.js — reverse tpm-consumer-install.js: remove claude-tpm from an EXISTING
 * consumer project. Calls `npm` and `claude plugin …` DIRECTLY (does NOT go through
 * tpm-consumer-manage-plugin.js). Never deletes the user's package.json, source, or docs — it only
 * removes what install.js added.
 *
 * PURPOSE
 *   Check-then-act, idempotent, REVERSE-ORDER 3-step uninstall from the target dir (default: cwd):
 *     1. plugin      — `claude plugin uninstall claude-tpm@claude-tpm-market --scope project`
 *                       if it's currently installed.
 *     2. marketplace — `claude plugin marketplace remove claude-tpm-market --scope project`
 *                       if it's currently registered. (`--scope project` mirrors the scope install.js
 *                       always uses, so this only undoes what install.js could have done — it won't
 *                       remove a marketplace entry someone registered at a different scope by hand.)
 *     3. dependency  — `npm uninstall @codercowboy/claude-tpm` if it's declared in package.json.
 *   No package.json/README/LICENSE/.gitignore is ever touched beyond what `npm uninstall` itself edits.
 *   There is no env/hooks settings.json step to reverse — install.js never wrote one. The plugin
 *   delivers its hooks itself (bundle-root hooks/hooks.json, auto-discovered) and env.TPM_HOME is
 *   retired, so plugin uninstall removes the hooks along with the plugin; nothing in settings.json to
 *   undo.
 *
 * USAGE
 *   npx tpm uninstall [dir] [options]
 *
 *   Options:
 *     [dir]          target project dir — POSITIONAL (first non-flag arg), e.g. `uninstall ../proj`.
 *     --dir <path>   same target dir, as a flag (alias for the positional). Default if neither: cwd.
 *     --quiet        non-interactive: assume yes to every step, pass -y to `claude plugin uninstall`
 *                    (required when stdin/stdout isn't a TTY). Still exits 1 on real errors.
 *     --force        skip the "already gone" checks and (re-)run every step; treat an
 *                    already-removed/not-found response as success, not error. Still asks per step
 *                    unless combined with --quiet.
 *     --check        read-only: run every state check, print a PASS/FAIL checklist (PASS = cleanly
 *                    removed), change nothing. Exits non-zero if anything claude-tpm added is still
 *                    present.
 *     -h, --help
 *
 *   Examples:
 *     npx tpm uninstall --check
 *     npx tpm uninstall --quiet
 *
 * CONVENTIONS: zero runtime deps (Node built-ins only), portable (`node …/tpm-consumer-uninstall.js`),
 *   also a module (module.exports) so tests can drive the pure helpers directly. See
 *   claude-context/methodology/tool-conventions.md. Tests: tools/consumer/tests/tpm-consumer-uninstall/.
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

// ── `claude` state checks (read-only; defensive about JSON shape — see tpm-consumer-install.js for
// the same caveat: this machine has no installed plugin to sample the real shape from) ─────────────

function claudeCliAvailable() {
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  return !(r.error && r.error.code === 'ENOENT');
}

// `cwd` MATTERS: `claude plugin list --json` reports each plugin's `enabled` state RELATIVE TO the
// project context of the cwd it runs in (verified live). So project-scoped probes MUST run from the
// TARGET project dir or they misread enablement. Callers pass targetDir; defaults to process.cwd().
function runClaudeJson(argv, cwd) {
  const r = spawnSync('claude', argv, { encoding: 'utf8', cwd: cwd || process.cwd() });
  if (r.error || r.status !== 0 || !r.stdout) return null;
  try { return JSON.parse(r.stdout); } catch (_e) { return null; }
}

function marketplaceRegistered(cwd) {
  const list = runClaudeJson(['plugin', 'marketplace', 'list', '--json'], cwd);
  return Array.isArray(list) && list.some((m) => m && m.name === MARKETPLACE_NAME);
}

// Parse `claude plugin list --json` — an array of installed-plugin objects, each shaped like
//   { "id": "claude-tpm@claude-tpm-market", "scope": "project", "enabled": true, … }
// Find OUR entry by id (project scope, mirroring the --scope project install always uses) and read
// `.enabled`. No entry → not installed. Defensive against schema drift: if the output isn't an array of
// objects carrying the expected keys, warn and fall back conservatively (assume not installed).
// Pure JSON→state mapping (spun out of pluginState so it's unit-testable without spawning `claude`).
// `list` is the ALREADY-PARSED JSON value returned by runClaudeJson (or null when the CLI was
// unavailable / emitted non-JSON). Behavior is identical to the logic that previously lived inline in
// pluginState — this extraction is purely so tests can drive the mapping directly.
function parsePluginList(list) {
  if (list === null) return { installed: false, enabled: false }; // CLI unavailable / non-JSON output
  if (!Array.isArray(list)) {
    process.stderr.write('warning: `claude plugin list --json` did not return a JSON array (schema drift?) — assuming plugin not installed.\n');
    return { installed: false, enabled: false };
  }
  if (list.length > 0 && !list.some((e) => e && typeof e === 'object' && typeof e.id === 'string')) {
    process.stderr.write('warning: `claude plugin list --json` entries lack the expected `id` field (schema drift?) — assuming plugin not installed.\n');
    return { installed: false, enabled: false };
  }
  const entry = list.find((e) => e && typeof e === 'object' && e.id === PLUGIN_ID &&
    (e.scope === undefined || e.scope === 'project'));
  if (!entry) return { installed: false, enabled: false };
  if (typeof entry.enabled !== 'boolean') {
    process.stderr.write(`warning: plugin entry ${PLUGIN_ID} has no boolean "enabled" field (schema drift?) — assuming enabled.\n`);
    return { installed: true, enabled: true };
  }
  return { installed: true, enabled: entry.enabled };
}

function pluginState(cwd) {
  return parsePluginList(runClaudeJson(['plugin', 'list', '--json'], cwd));
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

async function doStep(opts, step) {
  const { already, describe, command, edit, what, bin, argv, cwd, verify } = step;
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
    // Idempotent "nothing to remove" recovery — fires EVEN WITHOUT --force (belt-and-suspenders): a
    // step may declare a `benign` regex naming the child responses that mean "there was nothing of ours
    // to undo at this scope" (e.g. `marketplace remove --scope project` when the marketplace was only
    // ever registered GLOBALLY by another project — correctly NOT ours to remove). Treating that as a
    // hard exit 1 would false-fail an otherwise-clean uninstall.
    const benignOk = step.benign instanceof RegExp && step.benign.test(res.combined);
    // --force "already gone" recovery: prefer a STRUCTURED re-check of the end state (parsed from
    // `claude plugin … --json` / package.json), and fall back to the old prose match only for steps
    // that carry no verify.
    const structurallyOk = opts.force && typeof verify === 'function' && verify();
    const proseOk = opts.force && typeof verify !== 'function' && /already|not found|not installed|no such|unknown/i.test(res.combined);
    if (benignOk || structurallyOk || proseOk) {
      process.stdout.write(benignOk
        ? '  (nothing of ours to remove at this scope — treating as success)\n'
        : '  (already gone — treating as success under --force)\n');
      return { ok: true, alreadyOk: true };
    }
    process.stderr.write(`  ✗ exited ${res.status}\n`);
    return { ok: false };
  }
  process.stdout.write('  ✓ done.\n');
  return { ok: true };
}

// ── --check mode (read-only doctor; PASS means "cleanly removed") ───────────────────────────────────

function runCheck(targetDir) {
  const rows = [];
  const claudeOk = claudeCliAvailable();

  const pstate = claudeOk ? pluginState(targetDir) : { installed: false, enabled: false };
  rows.push({ label: `plugin ${PLUGIN_ID} is NOT installed`, pass: !pstate.installed,
    note: claudeOk ? '' : '(`claude` CLI not found on PATH — cannot verify)' });

  const marketOk = claudeOk && marketplaceRegistered(targetDir);
  rows.push({ label: `marketplace "${MARKETPLACE_NAME}" is NOT registered`, pass: !marketOk,
    note: claudeOk ? '' : '(`claude` CLI not found on PATH — cannot verify)' });

  const pkgRead = readPackageJson(targetDir);
  const depPresent = pkgRead.exists && !pkgRead.error && hasTpmDependency(pkgRead.value);
  rows.push({ label: `"${TPM_PKG_NAME}" is NOT declared as a dependency`, pass: !depPresent,
    note: !pkgRead.exists ? '(no package.json — nothing to remove)' : (pkgRead.error ? `(invalid JSON: ${pkgRead.error})` : '') });

  let allPass = true;
  for (const row of rows) {
    process.stdout.write(`  [${row.pass ? 'PASS' : 'FAIL'}] ${row.label}${row.note ? ' ' + row.note : ''}\n`);
    if (!row.pass) allPass = false;
  }
  return allPass ? 0 : 1;
}

// ── the uninstall run (default / --quiet / --force) ──────────────────────────────────────────────────

async function runUninstall(opts) {
  const targetDir = path.resolve(opts.dir);

  if (!claudeCliAvailable()) {
    process.stderr.write('error: `claude` CLI not found on PATH — install Claude Code first.\n');
    return 1;
  }

  // Step 1 — plugin.
  const r1 = await doStep(opts, {
    already: !pluginState(targetDir).installed,
    describe: 'Step 1/3 — uninstall the claude-tpm plugin',
    command: `claude plugin uninstall ${PLUGIN_ID} --scope project${opts.quiet ? ' -y' : ''}`,
    edit: "~/.claude/plugins/ (global cache) + this project's plugin registry (project scope)",
    what: `Disables and removes ${PLUGIN_ID} from this project.`,
    bin: 'claude', argv: ['plugin', 'uninstall', PLUGIN_ID, '--scope', 'project'].concat(opts.quiet ? ['-y'] : []), cwd: targetDir,
    verify: () => !pluginState(targetDir).installed,
    benign: /not installed|is not installed|not found|no such/i, // already-gone → success, not a failure
  });
  if (!r1.ok) return 1;

  // Step 2 — marketplace. (marketplace remove takes no -y flag; unaffected by --quiet. `--scope
  // project` mirrors the scope install.js always uses, so we only undo what install.js could have
  // registered rather than removing a marketplace entry declared at a different scope.) When the
  // marketplace was only ever registered GLOBALLY (by another claude-tpm project — the shared-singleton
  // case), `remove --scope project` reports "not declared in project settings"; that is NOT an error —
  // it correctly means there is nothing of OURS to remove at this scope (the `benign` regex catches it).
  // Deliberately do NOT "Omit --scope to remove from all scopes" as the CLI suggests — that would nuke a
  // marketplace another project relies on. (The shared-singleton scope model is slated for the GitHub-prep
  // rework; here we just avoid the false hard-fail.)
  const r2 = await doStep(opts, {
    already: !marketplaceRegistered(targetDir),
    describe: 'Step 2/3 — remove the claude-tpm marketplace',
    command: `claude plugin marketplace remove ${MARKETPLACE_NAME} --scope project`,
    edit: "this project's Claude Code settings (project scope)",
    what: `Untrusts/removes the "${MARKETPLACE_NAME}" marketplace declaration for this project (a global-only registration by another project is left alone).`,
    bin: 'claude', argv: ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME, '--scope', 'project'], cwd: targetDir,
    verify: () => !marketplaceRegistered(targetDir),
    benign: /not declared|not registered|not found|no such marketplace|omit --scope/i,
  });
  if (!r2.ok) return 1;

  // Step 3 — dependency. Skipped (not an error) if there's no package.json, or the dep isn't declared.
  const pkgRead = readPackageJson(targetDir);
  if (pkgRead.error) {
    process.stderr.write(`error: ${path.join(targetDir, 'package.json')} is not valid JSON: ${pkgRead.error}\n`);
    return 1;
  }
  const depPresent = pkgRead.exists && hasTpmDependency(pkgRead.value);
  const r3 = await doStep(opts, {
    already: !depPresent,
    describe: 'Step 3/3 — remove the claude-tpm dependency',
    command: `npm uninstall ${TPM_PKG_NAME}`,
    edit: `${path.join(targetDir, 'package.json')} + its lockfile + node_modules/${TPM_PKG_NAME}`,
    what: `Removes "${TPM_PKG_NAME}" from package.json (whichever dependency bucket it's in) and deletes\n` +
      `           node_modules/${TPM_PKG_NAME}. Never touches any other file (README, LICENSE, etc.).`,
    bin: 'npm', argv: ['uninstall', TPM_PKG_NAME], cwd: targetDir,
    verify: () => !hasTpmDependency(readPackageJson(targetDir).value),
  });
  if (!r3.ok) return 1;

  process.stdout.write(`\n✓ claude-tpm removed from ${targetDir}\n`);
  return 0;
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

function printHelp() {
  const src = fs.readFileSync(__filename, 'utf8');
  const m = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (m) process.stdout.write(m[1].split('\n').map((l) => l.replace(/^ \*\s?/, '')).join('\n').trim() + '\n');
}

function parseArgs(argv) {
  const a = { dir: null, quiet: false, force: false, check: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i];
    if (x === '-h' || x === '--help') a.help = true;
    else if (x === '--quiet') a.quiet = true;
    else if (x === '--force') a.force = true;
    else if (x === '--check') a.check = true;
    else if (x === '--dir') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('-')) {
        process.stderr.write(`error: ${x} requires a value (got ${v === undefined ? 'nothing' : `'${v}'`}).\n`);
        process.exit(2);
      }
      a.dir = v; i += 1;
    }
    else if (!x.startsWith('-') && a.dir === null) { a.dir = x; } // positional target dir: `uninstall <dir>` (mirrors install)
    else { process.stderr.write(`Unknown argument: ${x}\n`); process.exit(2); }
  }
  if (a.dir === null) a.dir = process.cwd(); // neither positional nor --dir given → cwd
  return a;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); process.exit(0); }
  const targetDir = path.resolve(opts.dir);
  if (opts.check) { process.exit(runCheck(targetDir)); }
  process.exit(await runUninstall(opts));
}

if (require.main === module) {
  main().catch((err) => { process.stderr.write(`tpm-consumer-uninstall: ${err.message}\n`); process.exit(1); });
}

module.exports = {
  main, runUninstall, runCheck, parseArgs,
  readPackageJson, hasTpmDependency, claudeCliAvailable, marketplaceRegistered, pluginState, parsePluginList,
  TPM_PKG_NAME, MARKETPLACE_NAME, PLUGIN_NAME, PLUGIN_ID,
};
