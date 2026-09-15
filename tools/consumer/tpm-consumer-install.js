#!/usr/bin/env node
/**
 * tpm-consumer-install.js — graft claude-tpm onto an EXISTING consumer project. Replaces the retired
 * scaffolder (tpm-consumer-scaffold.js, moved to tmp/safe-to-delete/): no package.json/README/LICENSE/
 * .gitignore authoring — this tool only adds the claude-tpm dependency + trusts/installs the plugin.
 * Calls `npm` and `claude plugin …` DIRECTLY (it does NOT go through tpm-consumer-manage-plugin.js).
 *
 * PURPOSE
 *   Check-then-act, idempotent, 5-step install into the target dir (default: cwd):
 *     1. preflight — fail fast unless `npm` is on PATH, a package.json exists (never created — authoring
 *        project identity is the user's call, not this tool's; if missing, print the `npm init -y`
 *        instruction and exit 1), and the `claude` CLI is on PATH.
 *     2. claude-tpm dependency — `npm install <from> --save-optional` unless the dep is already declared
 *        AND present in node_modules (skipped unless --force).
 *     3. marketplace — `claude plugin marketplace add ./node_modules/@codercowboy/claude-tpm
 *        --scope project` if not already registered.
 *     4. plugin install — `claude plugin install claude-tpm@claude-tpm-market --scope project`
 *        (installing usually also enables — see step 5).
 *     5. project enablement — `claude plugin enable claude-tpm@claude-tpm-market --scope project`,
 *        ONLY if the plugin is installed but currently disabled for this project (step 4 usually
 *        already leaves it enabled).
 *   Deliberately NOT handled here: writing env.TPM_HOME or hooks into any settings.json. The plugin
 *   delivers its PreToolUse hooks itself, via the bundle-root hooks/hooks.json (auto-discovered on
 *   plugin enable — confirmed firing end-to-end, session 013), and env.TPM_HOME is retired (zero
 *   consumers: skills call `npx tpm …` and doc-reads resolve through the plugin's expand-tpm-home hook).
 *   `claude plugin … --scope project` performs its own in-repo settings declaration; this tool never
 *   touches settings.json directly.
 *
 * USAGE
 *   npx tpm install [dir] [options]
 *   (via the bin: `tpm install <dir> [options]` / `npx tpm install <dir>`)
 *
 *   Options:
 *     [dir]            target project dir — POSITIONAL (first non-flag arg), e.g. `install ../proj`.
 *     --dir <path>     same target dir, as a flag (alias for the positional). Default if neither: cwd.
 *     --from <spec>    npm dep spec for step 2, e.g. `file:../claude-tpm` or a registry version.
 *                      Default: self-located — this script finds the claude-tpm bundle it ships inside
 *                      (walking up from itself for its own package.json whose name is
 *                      @codercowboy/claude-tpm) and computes the
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
 *                      Exits non-zero if anything is missing. (The consumer "doctor".) Checks:
 *                      package.json valid · tpm dep declared · marketplace registered · plugin
 *                      installed · plugin enabled for the project · the bundle delivers its two
 *                      PreToolUse hooks (gate-spawn + expand-tpm-home) · any consumer config.json
 *                      parses as JSON. (There is NO env.TPM_HOME / settings.json hook wiring to
 *                      check — the plugin delivers the hooks itself; env.TPM_HOME is retired.)
 *     -h, --help
 *
 *   Examples:
 *     npx tpm install ../some-project           # positional target dir
 *     npx tpm install ../some-project --check
 *     npx tpm install --quiet --from file:../claude-tpm ../some-project
 *
 * CONVENTIONS: zero runtime deps (Node built-ins only), portable (`node …/tpm-consumer-install.js`),
 *   also a module (module.exports) so tests can drive the pure helpers directly. See
 *   claude-context/methodology/tool-conventions.md. Tests: tools/consumer/tests/tpm-consumer-install/.
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

// ── self-location (per tool-conventions.md — never hardcode absolutes / __dirname gymnastics for
// project-internal locations; walk up for a repo marker instead). The marker is the bundle's OWN
// package.json (name === "@codercowboy/claude-tpm") — a neutral file that survives packaging, rather
// than the plugin-specific .claude-plugin/marketplace.json. ─────────────────────────────────────────

function findBundleRoot(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg && pkg.name === TPM_PKG_NAME) return dir; // the claude-tpm bundle root
      } catch (_e) { /* unreadable / invalid package.json — not our marker, keep walking up */ }
    }
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

// True once `npm install` has actually landed the dep in the target's node_modules (used by step 2's
// idempotency check — a package.json declaration alone doesn't mean it's installed on disk).
function nodeModulesHasTpm(dir) {
  return fs.existsSync(path.join(dir, 'node_modules', TPM_PKG_NAME, 'package.json'));
}

// ── `claude` state checks (read-only; defensive about JSON shape) ───────────────────────────────────

function claudeCliAvailable() {
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  return !(r.error && r.error.code === 'ENOENT');
}

// Generic PATH probe (ENOENT ⇒ not found). Used by the preflight for `npm`.
function commandAvailable(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  return !(r.error && r.error.code === 'ENOENT');
}

// `cwd` MATTERS: `claude plugin list --json` reports each plugin's `enabled` state RELATIVE TO the
// project context of the cwd it runs in (verified live — the same entry reads enabled:false from an
// unrelated dir and enabled:true from within its own project). So every project-scoped probe MUST run
// from the TARGET project dir, or it misreads enablement (the false-exit-1 re-enable bug: step 5 saw
// "not enabled" from the wrong cwd, re-ran enable, and `claude` errored "already enabled"). Callers pass
// targetDir; it defaults to process.cwd() only for ad-hoc/module use.
function runClaudeJson(argv, cwd) {
  const r = spawnSync('claude', argv, { encoding: 'utf8', cwd: cwd || process.cwd() });
  if (r.error || r.status !== 0 || !r.stdout) return null;
  try { return JSON.parse(r.stdout); } catch (_e) { return null; }
}

function marketplaceRegistered(cwd) {
  const list = runClaudeJson(['plugin', 'marketplace', 'list', '--json'], cwd);
  return Array.isArray(list) && list.some((m) => m && m.name === MARKETPLACE_NAME);
}

// Parse `claude plugin list --json` — an array of installed-plugin objects. VERIFIED live shape
// (claude 2.1.270): { id, version, scope, enabled, installPath, installedAt, lastUpdated, projectPath },
// e.g. { "id": "claude-tpm@claude-tpm-market", "scope": "project", "enabled": true, … }. `enabled` is a
// real boolean and IS present + correct on a DISABLED entry ("enabled": false) — verified against a live
// disabled plugin, which CLOSES the old KNOWN LIMITATION (the assume-enabled soft-degrade below now only
// fires on genuine schema drift, never on a normal disabled plugin).
// Find OUR entry by id AND project scope (install.js always uses --scope project; a manual `--scope
// local`/`user` install reports scope "local"/"user" and is deliberately NOT matched — not what this
// tool manages) and read `.enabled`:
//   enabled:true  → already enabled (a success/skip, NOT an error)
//   enabled:false → installed but needs a standalone enable
//   no entry      → not installed (for THIS tool's project scope)
// Defensive against schema drift: if the output isn't an array of objects carrying the expected keys,
// warn and fall back conservatively (assume not installed) rather than crash.
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

// ── hooks-delivery health (the plugin ships its two PreToolUse hooks itself, via the bundle-root
// hooks/hooks.json; there is NO env.TPM_HOME / settings.json hook wiring to check — that was retired).
// The doctor verifies the delivered artifact is intact: the bundle in the target's node_modules carries
// a hooks/hooks.json that declares both hooks. Split pure-parse / disk-read like parsePluginList above. ─

// Pure: given a parsed hooks.json object, report whether it declares the two PreToolUse hooks the plugin
// delivers. Matched by the command string CONTAINING `hooks <name>`, so it survives a `node …`→`npx tpm`
// rewording of the command and doesn't pin to one exact invocation form.
function parseHooksManifest(manifest) {
  const result = { gateSpawn: false, expandTpmHome: false };
  if (!manifest || typeof manifest !== 'object') return result;
  const pre = manifest.hooks && manifest.hooks.PreToolUse;
  if (!Array.isArray(pre)) return result;
  for (const group of pre) {
    const hooks = group && Array.isArray(group.hooks) ? group.hooks : [];
    for (const h of hooks) {
      const cmd = h && typeof h.command === 'string' ? h.command : '';
      if (/hooks\s+gate-spawn/.test(cmd)) result.gateSpawn = true;
      if (/hooks\s+expand-tpm-home/.test(cmd)) result.expandTpmHome = true;
    }
  }
  return result;
}

// Reader: locate + parse the delivered bundle's hooks/hooks.json inside the target's node_modules.
// present:false ⇒ the manifest file isn't there (dep not installed yet, or a pre-hooks bundle) — the
// check row degrades to a skip rather than a hard fail when node_modules has no bundle.
function bundleHooksHealth(targetDir) {
  const p = path.join(targetDir, 'node_modules', TPM_PKG_NAME, 'hooks', 'hooks.json');
  if (!fs.existsSync(p)) return { present: false, error: null, gateSpawn: false, expandTpmHome: false };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return { present: true, error: e.message, gateSpawn: false, expandTpmHome: false }; }
  return Object.assign({ present: true, error: null }, parseHooksManifest(manifest));
}

// Optional consumer override config — install.js deliberately does NOT scaffold it, but if a project
// hand-created one, a MALFORMED file silently degrades every resolver to defaults, so the doctor flags
// it. Absent ⇒ fine (defaults). A light parse-validity check only, not schema validation.
function configJsonValidity(targetDir) {
  const p = path.join(targetDir, '.claude', 'claude-tpm', 'config.json');
  if (!fs.existsSync(p)) return { present: false, valid: true, error: null };
  try { JSON.parse(fs.readFileSync(p, 'utf8')); return { present: true, valid: true, error: null }; }
  catch (e) { return { present: true, valid: false, error: e.message }; }
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
    // --force "already in the desired state" recovery: prefer a STRUCTURED re-check of the end state
    // (parsed from `claude plugin … --json` / package.json), and fall back to the old prose match only
    // for steps that carry no verify.
    const structurallyOk = opts.force && typeof verify === 'function' && verify();
    const proseOk = opts.force && typeof verify !== 'function' && /already/i.test(res.combined);
    if (structurallyOk || proseOk) {
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
  const marketOk = claudeOk && marketplaceRegistered(targetDir);
  rows.push({ label: `marketplace "${MARKETPLACE_NAME}" registered`, pass: marketOk,
    note: claudeOk ? '' : '(`claude` CLI not found on PATH)' });

  // Probe project-scope state FROM the target dir — enablement is cwd-relative (see runClaudeJson).
  const pstate = claudeOk ? pluginState(targetDir) : { installed: false, enabled: false };
  rows.push({ label: `plugin ${PLUGIN_ID} installed`, pass: pstate.installed,
    note: claudeOk ? '' : '(`claude` CLI not found on PATH)' });
  rows.push({ label: `plugin ${PLUGIN_ID} enabled for this project`, pass: pstate.installed && pstate.enabled,
    note: (claudeOk && !pstate.installed) ? '(skipped — not installed)' : '' });

  // Hooks-delivery health: the bundle in node_modules carries a hooks/hooks.json declaring both hooks.
  // Only meaningful once the dep is materialized in node_modules; otherwise skip (step 2 handles that).
  const nmHasTpm = nodeModulesHasTpm(targetDir);
  const hh = bundleHooksHealth(targetDir);
  const hooksNote = !nmHasTpm ? '(skipped — dependency not installed in node_modules)'
    : hh.error ? `(bundle hooks.json invalid JSON: ${hh.error})`
    : !hh.present ? '(bundle carries no hooks/hooks.json)'
    : (!hh.gateSpawn || !hh.expandTpmHome)
      ? `(missing: ${[!hh.gateSpawn && 'gate-spawn', !hh.expandTpmHome && 'expand-tpm-home'].filter(Boolean).join(' + ')})`
      : '';
  rows.push({ label: 'plugin delivers its PreToolUse hooks (gate-spawn + expand-tpm-home)',
    pass: !nmHasTpm ? true : (hh.present && !hh.error && hh.gateSpawn && hh.expandTpmHome), note: hooksNote });

  // Consumer override config (optional): if present, it must be valid JSON — a malformed one silently
  // degrades every resolver to defaults. Absent is fine (defaults); present-and-malformed FAILS.
  const cfgv = configJsonValidity(targetDir);
  rows.push({ label: 'consumer config.json is valid JSON (if present)', pass: cfgv.valid,
    note: !cfgv.present ? '(none — using defaults)' : cfgv.valid ? '' : `(invalid JSON: ${cfgv.error})` });

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

  // Step 1/5 — preflight. Fail fast, per-prerequisite: `npm` on PATH, a package.json to write into, and
  // the `claude` CLI on PATH (a missing `claude` used to surface downstream as an unhelpful "exited null").
  // package.json is never created by this tool, in ANY mode (--force included) — authoring project identity
  // is the user's call, not ours; it's also load-bearing (step 2 needs it to exist).
  if (!commandAvailable('npm')) {
    process.stderr.write('Step 1/5 — ✗ preflight failed\n');
    process.stderr.write('  error: `npm` not found on PATH — install Node.js/npm first.\n');
    return 1;
  }
  const pkgRead = readPackageJson(targetDir);
  if (!pkgRead.exists) {
    process.stderr.write('Step 1/5 — ✗ preflight failed\n');
    process.stdout.write(`No package.json found in ${targetDir}.\n\n`);
    process.stdout.write('  Run this yourself first:\n');
    process.stdout.write('    npm init -y\n');
    process.stdout.write('  (writes a default package.json — name/version guessed from the folder, ISC\n');
    process.stdout.write('  license, no dependencies — that step 2 below needs to exist before it can add\n');
    process.stdout.write('  an optional dependency to it.)\n');
    return 1;
  }
  if (pkgRead.error) {
    process.stderr.write('Step 1/5 — ✗ preflight failed\n');
    process.stderr.write(`  error: ${path.join(targetDir, 'package.json')} is not valid JSON: ${pkgRead.error}\n`);
    return 1;
  }
  if (!claudeCliAvailable()) {
    process.stderr.write('Step 1/5 — ✗ preflight failed\n');
    process.stderr.write('  error: `claude` CLI not found on PATH — install Claude Code first.\n');
    return 1;
  }
  const pkg = pkgRead.value;
  process.stdout.write('Step 1/5 — ✓ preflight passed (npm, package.json, claude).\n');

  // Step 2 — claude-tpm dependency. Idempotent: skip `npm install` (unless --force) when the dep is both
  // declared in package.json AND already present in node_modules.
  const fromSpec = opts.from || defaultFromSpec(targetDir);
  if (!fromSpec) {
    process.stderr.write('error: could not self-locate the claude-tpm bundle to compute a default --from;\n');
    process.stderr.write('  pass --from <spec> explicitly (e.g. --from file:../claude-tpm).\n');
    return 1;
  }
  const r2 = await doStep(opts, {
    already: hasTpmDependency(pkg) && nodeModulesHasTpm(targetDir),
    describe: 'Step 2/5 — add the claude-tpm dependency',
    command: `npm install ${fromSpec} --save-optional`,
    edit: `${path.join(targetDir, 'package.json')} (optionalDependencies) + its lockfile + node_modules/${TPM_PKG_NAME}`,
    what: `Adds "${TPM_PKG_NAME}": "${fromSpec}" to optionalDependencies, updates the lockfile, and\n` +
      `           creates the node_modules/${TPM_PKG_NAME} symlink/copy that step 3 points the marketplace at.`,
    bin: 'npm', argv: ['install', fromSpec, '--save-optional'], cwd: targetDir,
    verify: () => hasTpmDependency(readPackageJson(targetDir).value) && nodeModulesHasTpm(targetDir),
  });
  if (!r2.ok) return 1;

  // Step 3 — marketplace registration. (marketplace add/remove take no -y flag; unaffected by --quiet.)
  const r3 = await doStep(opts, {
    already: marketplaceRegistered(targetDir),
    describe: 'Step 3/5 — register the claude-tpm marketplace',
    command: `claude plugin marketplace add ${MARKETPLACE_SOURCE} --scope project`,
    edit: "this project's Claude Code settings (project scope)",
    what: `Trusts/registers ${MARKETPLACE_SOURCE} as marketplace "${MARKETPLACE_NAME}" so its plugin becomes installable.`,
    bin: 'claude', argv: ['plugin', 'marketplace', 'add', MARKETPLACE_SOURCE, '--scope', 'project'], cwd: targetDir,
    verify: () => marketplaceRegistered(targetDir),
  });
  if (!r3.ok) return 1;

  // Step 4 — plugin install (usually also enables it for this project — see step 5).
  const r4 = await doStep(opts, {
    already: pluginState(targetDir).installed,
    describe: 'Step 4/5 — install the claude-tpm plugin',
    command: `claude plugin install ${PLUGIN_ID} --scope project${opts.quiet ? ' -y' : ''}`,
    edit: "~/.claude/plugins/ (global cache) + this project's plugin registry (project scope)",
    what: `Installs ${PLUGIN_ID} and, in the common case, enables it for this project in the same step.`,
    bin: 'claude', argv: ['plugin', 'install', PLUGIN_ID, '--scope', 'project'].concat(opts.quiet ? ['-y'] : []), cwd: targetDir,
    verify: () => pluginState(targetDir).installed,
  });
  if (!r4.ok) return 1;

  // Step 5 — project enablement. Only a real action when step 4 left it installed-but-disabled;
  // an already-enabled plugin (enabled:true) is a skip, not an error. Probe FROM targetDir — `enabled`
  // is cwd-relative, so a probe from anywhere else misreads it (the false-exit-1 re-enable bug).
  const afterInstall = pluginState(targetDir);
  const needsEnable = afterInstall.installed && !afterInstall.enabled;
  const r5 = await doStep(opts, {
    already: !needsEnable,
    describe: 'Step 5/5 — enable the plugin for this project',
    command: `claude plugin enable ${PLUGIN_ID} --scope project`,
    edit: "this project's Claude Code plugin registry (project scope)",
    what: `Flips ${PLUGIN_ID} on for this project. Step 4 usually already leaves it enabled — this only\n` +
      '           runs a standalone enable when the plugin is installed but currently disabled here.',
    bin: 'claude', argv: ['plugin', 'enable', PLUGIN_ID, '--scope', 'project'], cwd: targetDir,
    verify: () => pluginState(targetDir).enabled,
  });
  if (!r5.ok) return 1;

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
  const a = { dir: null, from: null, quiet: false, force: false, check: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i];
    if (x === '-h' || x === '--help') a.help = true;
    else if (x === '--quiet') a.quiet = true;
    else if (x === '--force') a.force = true;
    else if (x === '--check') a.check = true;
    else if (x === '--from') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('-')) {
        process.stderr.write(`error: ${x} requires a value (got ${v === undefined ? 'nothing' : `'${v}'`}).\n`);
        process.exit(2);
      }
      a.from = v; i += 1;
    }
    else if (x === '--dir') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('-')) {
        process.stderr.write(`error: ${x} requires a value (got ${v === undefined ? 'nothing' : `'${v}'`}).\n`);
        process.exit(2);
      }
      a.dir = v; i += 1;
    }
    else if (!x.startsWith('-') && a.dir === null) { a.dir = x; } // positional target dir: `install <dir>`
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
  process.exit(await runInstall(opts));
}

if (require.main === module) {
  main().catch((err) => { process.stderr.write(`tpm-consumer-install: ${err.message}\n`); process.exit(1); });
}

module.exports = {
  main, runInstall, runCheck, parseArgs, findBundleRoot, defaultFromSpec,
  readPackageJson, hasTpmDependency, nodeModulesHasTpm, claudeCliAvailable, commandAvailable,
  marketplaceRegistered, pluginState, parsePluginList,
  parseHooksManifest, bundleHooksHealth, configJsonValidity,
  TPM_PKG_NAME, MARKETPLACE_NAME, PLUGIN_NAME, PLUGIN_ID, MARKETPLACE_SOURCE,
};
