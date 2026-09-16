#!/usr/bin/env node
/**
 * tpm-consumer-uninstall.js — reverse tpm-consumer-install.js: remove claude-tpm from an EXISTING
 * consumer project. Calls `npm` and `claude plugin …` DIRECTLY (does NOT go through
 * tpm-consumer-manage-plugin.js). Never deletes the user's package.json, source, or docs — it only
 * removes what install.js added.
 *
 * PURPOSE
 *   Check-then-act, idempotent, SCOPE-AWARE uninstall from the target dir (default: cwd). Because the
 *   plugin + the "claude-tpm-market" marketplace are machine-global singletons SHARED by every consumer,
 *   the tool first forks on scope (asked interactively; `--project`/`--system` set it non-interactively;
 *   a bare `--quiet` defaults to the safer project-only):
 *
 *   • PROJECT-ONLY (default) — leave claude-tpm working for other projects:
 *       1. `claude plugin disable claude-tpm@claude-tpm-market --scope project`  (off HERE only)
 *       2. `npm uninstall @codercowboy/claude-tpm`                               (this project's dep)
 *      The shared marketplace is LEFT registered. GUARD: if the shared marketplace's source points at
 *      THIS project's node_modules, removing the dep here breaks it for other projects — so it asks for a
 *      secondary consent acknowledging they may need `npx tpm doctor` + re-install.
 *   • WHOLE-SYSTEM — remove claude-tpm for the entire machine (asks a secondary consent first):
 *       1. `claude plugin uninstall claude-tpm@claude-tpm-market --scope project`
 *       2. `claude plugin marketplace remove claude-tpm-market`   (NO --scope → the whole machine)
 *       3. `npm uninstall @codercowboy/claude-tpm`
 *
 *   Every step prints its command + the files it edits + what it does, and asks per-step consent
 *   (skipped under --quiet). No package.json/README/LICENSE/.gitignore is touched beyond what
 *   `npm uninstall` edits. There is no env/hooks settings.json step to reverse — install.js never wrote
 *   one (the plugin delivers its hooks via bundle-root hooks/hooks.json; env.TPM_HOME is retired).
 *
 * USAGE
 *   npx tpm uninstall [dir] [options]
 *
 *   Options:
 *     [dir]          target project dir — POSITIONAL (first non-flag arg), e.g. `uninstall ../proj`.
 *     --dir <path>   same target dir, as a flag (alias for the positional). Default if neither: cwd.
 *     --project      scope: remove from THIS project only (disable here + drop the dep; leave the shared
 *                    marketplace + plugin for other projects). The interactive default.
 *     --system       scope: remove the plugin + the shared marketplace for the WHOLE machine (every
 *                    project loses claude-tpm). Mutually exclusive with --project.
 *     --quiet        non-interactive: assume yes to every step + skip the scope/consent prompts (defaults
 *                    to --project unless --system is given); pass -y to `claude plugin uninstall`
 *                    (required when stdin/stdout isn't a TTY). Still exits 1 on real errors.
 *     --force        skip the "already gone" checks and (re-)run every step; treat an
 *                    already-removed/not-found response as success, not error. Still asks per step
 *                    unless combined with --quiet.
 *     --debug        operation trace to STDOUT, prefixed `[tpm-debug]` (a `set -x`-style log): narrate
 *                    every child spawn (bin/argv/cwd → status/signal/elapsed-ms/error), every
 *                    `claude … --json` probe, and each step decision. Also enabled by TPM_DEBUG=1.
 *                    Diagnostic ONLY — changes no uninstall behavior; the abnormal-exit signal name and
 *                    the spawn errno are surfaced even without it.
 *     --check        read-only: run every state check, print a PASS/FAIL checklist (PASS = cleanly
 *                    removed), change nothing. Exits non-zero if anything claude-tpm added is still
 *                    present.
 *     -h, --help
 *
 *   Examples:
 *     npx tpm uninstall ../proj              # interactive: asks project-only vs whole-system
 *     npx tpm uninstall ../proj --project    # this project only (non-interactive scope)
 *     npx tpm uninstall ../proj --system -y  # whole machine, no prompts
 *     npx tpm uninstall --check              # read-only: is it cleanly removed?
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

// ── operation-trace (--debug / TPM_DEBUG) + honest spawn-error model ────────────────────────────────
// Lifted VERBATIM from tpm-consumer-install.js (only the prefix / env var differ per package). A
// `set -x`-style trace to STDOUT so an "exit null" run narrates what it did and what every child returned
// (incl. the signal name AND the spawn errno). Instrumentation ONLY — changes no uninstall behavior. The
// writer is a module-level singleton so runChild, which has no opts in scope, can call it.
let _dbg = () => {};
function makeDbg(enabled) {
  if (!enabled) return () => {};
  return (...parts) => { process.stdout.write('[tpm-debug] ' + parts.filter((p) => p !== '' && p != null).join(' ') + '\n'); };
}
// True when --debug was passed OR TPM_DEBUG is set to a non-empty value.
function debugEnabled(opts) { return !!(opts && opts.debug) || !!process.env.TPM_DEBUG; }

// Human-readable reason per spawn errno, shared by every message that renders a spawn error so the
// failure line, the --debug '←' line, and formatChildExit all speak with one voice.
const SPAWN_ERROR_REASON = { ENOENT: 'not found on PATH', EACCES: 'permission denied' };
function spawnErrorReason(code) { return SPAWN_ERROR_REASON[code] || 'spawn error'; }

// Pure primitive: classify a spawnSync-style result into ONE honest verdict the whole tool builds on.
// `ran` is false when the child never executed (a spawn-level error — ENOENT for an absent bin, EACCES for
// a directory / non-executable file shadowing it on PATH, or any other errno); `errorCode` carries that
// errno. `ok` is the single availability rule: the probe actually RAN and exited 0. Feeding a fake result
// shape here (no real spawn) is how the tests reproduce the EACCES/ENOENT misdetection deterministically.
function classifySpawn(r) {
  const errorCode = r && r.error ? (r.error.code || 'ESPAWN') : null;
  const ran = !errorCode;
  const status = r && typeof r.status === 'number' ? r.status : null;
  const signal = r && r.signal ? r.signal : null;
  return { ok: ran && status === 0, ran, status, signal, errorCode };
}

// Pure: render a spawnSync-style result as a human string. A spawn error (the child NEVER ran) →
// 'could not run (<CODE>: <reason>)', NOT a signal branch. Otherwise status 0 → 'ok'; status>0 →
// 'exited N'; a genuine status null WITHOUT a spawn error (signal-killed) → the signal string. Accepts
// either a raw spawnSync result (carrying `error`) or a runChild result (carrying `errorCode`). Exported
// so the always-on failure line AND the --debug '←' line share ONE formatting, and tests drive it directly.
function formatChildExit(r) {
  const errorCode = r ? (r.errorCode || (r.error && r.error.code) || null) : null;
  if (errorCode) return `could not run (${errorCode}: ${spawnErrorReason(errorCode)})`;
  const status = r ? r.status : undefined;
  const signal = r ? r.signal : undefined;
  if (status === 0) return 'ok';
  if (typeof status === 'number' && status > 0) return 'exited ' + status;
  return `exited null (killed by signal ${signal || 'unknown'})`;
}

// Pure: build the honest preflight line for a bin that isn't runnable, from its classifySpawn verdict.
// ENOENT → truly absent (install it). EACCES → present on PATH but not executable — the classic "the bin
// lives in the VM, not on THIS host" / a directory shadowing the real bin. Any other errno → surfaced
// verbatim. A bin that RAN but exited non-zero → reported as such (rare). `installHint` tails the ENOENT case.
function preflightMessage(bin, cls, installHint) {
  if (cls.errorCode === 'ENOENT') return `\`${bin}\` not found on PATH — ${installHint}`;
  if (cls.errorCode === 'EACCES') return `\`${bin}\` found on PATH but not executable (EACCES) — is \`${bin}\` installed on THIS host? (e.g. the binary lives in the VM, not the host).`;
  if (cls.errorCode) return `\`${bin}\` could not be run: ${cls.errorCode} (${spawnErrorReason(cls.errorCode)}).`;
  return `\`${bin}\` is on PATH but \`${bin} --version\` exited ${cls.status} — check the install.`;
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

// ── `claude` state checks (read-only; defensive about JSON shape — see tpm-consumer-install.js for
// the same caveat: this machine has no installed plugin to sample the real shape from) ─────────────

// Availability = the probe actually RAN and exited 0 (classifySpawn.ok) — NOT merely "the error wasn't
// ENOENT". That one rule catches an absent bin (ENOENT), a directory / non-exec file shadowing it on PATH
// (EACCES), AND a broken bin that errors, all at once. Returns the RICHER classifySpawn verdict (not a
// bare boolean any more) so callers read `.ok` for availability and `.errorCode` for the reason.
function claudeCliAvailable() {
  return classifySpawn(spawnSync('claude', ['--version'], { encoding: 'utf8' }));
}

// `cwd` MATTERS: `claude plugin list --json` reports each plugin's `enabled` state RELATIVE TO the
// project context of the cwd it runs in (verified live). So project-scoped probes MUST run from the
// TARGET project dir or they misread enablement. Callers pass targetDir; defaults to process.cwd().
function runClaudeJson(argv, cwd) {
  const r = spawnSync('claude', argv, { encoding: 'utf8', cwd: cwd || process.cwd() });
  _dbg('probe:', 'claude ' + argv.join(' '), '(cwd=' + (cwd || process.cwd()) + ')',
    '→ status=' + r.status + ' signal=' + (r.signal || 'none') + (r.error ? ' error=' + r.error.code : '') +
    ' json=' + (!r.error && r.status === 0 && r.stdout ? 'parsed' : 'null'));
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

// ── marketplace SOURCE health — needed to detect the "shared marketplace points at THIS project" landmine
// before removing the dependency here. (Mirrors install.js's helper; the consumer suite keeps each tool
// self-contained per tool-conventions.md §2, so it carries its own copy rather than cross-importing.) ──
function parseMarketplaceList(list) {
  if (!Array.isArray(list)) return { registered: false, source: null, path: null };
  const m = list.find((e) => e && typeof e === 'object' && e.name === MARKETPLACE_NAME);
  if (!m) return { registered: false, source: null, path: null };
  return { registered: true, source: typeof m.source === 'string' ? m.source : null,
    path: typeof m.path === 'string' ? m.path : null };
}
// Does the shared marketplace's source point at THIS project's vendored bundle? If so, removing the
// dependency here orphans that source for every OTHER project sharing this singleton marketplace — which
// is exactly what triggers the guard/consent below (they'll need `npx tpm doctor` + re-install).
function marketplacePointsAt(targetDir) {
  const parsed = parseMarketplaceList(runClaudeJson(['plugin', 'marketplace', 'list', '--json'], targetDir));
  if (!parsed.registered || !parsed.path) return false;
  return path.resolve(parsed.path) === path.resolve(targetDir, 'node_modules', TPM_PKG_NAME);
}

// ── child-process runner (captures output so the --force "already" heuristic can inspect it, then
// echoes it so the user still sees what happened) ────────────────────────────────────────────────────

function runChild(bin, argv, cwd) {
  _dbg('→ spawn:', bin, argv.join(' '), '(cwd=' + cwd + ')');
  const t0 = Date.now();
  const r = spawnSync(bin, argv, { cwd, encoding: 'utf8' });
  const ms = Date.now() - t0;
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  const cls = classifySpawn(r);
  if (!cls.ran) {
    // Spawn-level error — the child NEVER ran (ENOENT: absent; EACCES: a dir / non-exec file shadows it on
    // PATH; or any other errno). Surface the errno instead of letting anything other than ENOENT fall
    // through as a misleading status:null "exit null". The `←` line gains error=<code>, parity with the
    // runClaudeJson probe line. `enoent` is preserved for any legacy caller but callers now read errorCode.
    _dbg('← status=' + cls.status, 'signal=' + (cls.signal || 'none'), 'error=' + cls.errorCode, `(${ms}ms)`, formatChildExit(r));
    return { status: cls.status, signal: cls.signal, errorCode: cls.errorCode, enoent: cls.errorCode === 'ENOENT', combined: '' };
  }
  _dbg('← status=' + cls.status, 'signal=' + (cls.signal || 'none'), `(${ms}ms)`, formatChildExit(r));
  return { status: cls.status, signal: cls.signal, errorCode: null, enoent: false, combined: (r.stdout || '') + (r.stderr || '') };
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
  if (res.errorCode) {
    // Spawn-level error (child never ran) — surface the honest errno instead of a fake "exit null".
    process.stderr.write(`  ✗ could not run '${bin}': ${res.errorCode} (${spawnErrorReason(res.errorCode)})\n`);
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
    process.stderr.write(`  ✗ ${formatChildExit(res)}\n`);
    return { ok: false };
  }
  process.stdout.write('  ✓ done.\n');
  return { ok: true };
}

// ── --check mode (read-only doctor; PASS means "cleanly removed") ───────────────────────────────────

function runCheck(targetDir) {
  const rows = [];
  const claudeOk = claudeCliAvailable().ok;

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

// Shared step: remove the claude-tpm dependency from THIS project's package.json + node_modules. Returns
// the doStep result, or null when package.json is present-but-invalid (a hard error the caller surfaces).
async function removeDependencyStep(opts, targetDir, stepLabel) {
  const pkgRead = readPackageJson(targetDir);
  if (pkgRead.error) {
    process.stderr.write(`error: ${path.join(targetDir, 'package.json')} is not valid JSON: ${pkgRead.error}\n`);
    return null;
  }
  const depPresent = pkgRead.exists && hasTpmDependency(pkgRead.value);
  return doStep(opts, {
    already: !depPresent,
    describe: `Step ${stepLabel} — remove the claude-tpm dependency`,
    command: `npm uninstall ${TPM_PKG_NAME}`,
    edit: `${path.join(targetDir, 'package.json')} + its lockfile + node_modules/${TPM_PKG_NAME}`,
    what: `Removes "${TPM_PKG_NAME}" from package.json (whichever dependency bucket it's in) and deletes\n` +
      `           node_modules/${TPM_PKG_NAME}. Never touches any other file (README, LICENSE, etc.).`,
    bin: 'npm', argv: ['uninstall', TPM_PKG_NAME], cwd: targetDir,
    verify: () => !hasTpmDependency(readPackageJson(targetDir).value),
  });
}

async function runUninstall(opts) {
  _dbg = makeDbg(debugEnabled(opts)); // idempotent — main() also sets it; covers a direct module call
  const targetDir = path.resolve(opts.dir);
  _dbg('resolved run: opts=' + JSON.stringify({ dir: opts.dir, quiet: !!opts.quiet, force: !!opts.force, system: !!opts.system, project: !!opts.project, debug: !!opts.debug }));
  _dbg('resolved run: targetDir=' + targetDir);
  _dbg('tty: stdin.isTTY=' + !!process.stdin.isTTY + ' stdout.isTTY=' + !!process.stdout.isTTY);

  // Preflight — the `claude` CLI must be RUNNABLE (ran && exit 0), not merely "the error wasn't ENOENT".
  // Honest per-reason message: ENOENT (absent) vs EACCES (a dir / non-exec file shadowing it on PATH) vs
  // any other errno — instead of the old ENOENT-only check that let a non-runnable `claude` slip through.
  const claudeProbe = claudeCliAvailable();
  _dbg('preflight: claude ok=' + claudeProbe.ok + ' errorCode=' + claudeProbe.errorCode + ' status=' + claudeProbe.status);
  if (!claudeProbe.ok) {
    process.stderr.write('error: ' + preflightMessage('claude', claudeProbe, 'install Claude Code first.') + '\n');
    return 1;
  }

  // ── SCOPE FORK — the plugin + marketplace are machine-global singletons shared by EVERY consumer, so
  // removing them affects other projects. An explicit flag wins; interactively we ASK; a non-interactive
  // run (--quiet) with no flag defaults to the SAFER project-only.
  if (opts.system && opts.project) {
    process.stderr.write('error: pass only one of --system / --project.\n');
    return 1;
  }
  let system;
  if (opts.system) system = true;
  else if (opts.project) system = false;
  else if (opts.quiet) system = false; // safest non-interactive default
  else {
    process.stdout.write('\nclaude-tpm\'s plugin + marketplace are shared across every project on this machine.\n');
    process.stdout.write('  [1] Remove from THIS project only  (other projects keep working)\n');
    process.stdout.write('  [2] Remove from the WHOLE system   (every project loses claude-tpm)\n');
    const a = (await ask('  Choose [1/2] (default 1): ')).trim();
    system = (a === '2');
  }

  _dbg('scope: system=' + system + ' (from ' + (opts.system ? '--system' : opts.project ? '--project' : opts.quiet ? '--quiet default' : 'interactive prompt') + ')');

  // Landmine: does the shared marketplace's source point at THIS project's vendored bundle? If so,
  // removing the dependency here orphans that source for every OTHER project on the machine.
  const pointsHere = marketplacePointsAt(targetDir);
  _dbg('landmine: marketplacePointsAt(targetDir)=' + pointsHere);

  // ── secondary consent gates ──
  if (system) {
    if (!opts.quiet) {
      process.stdout.write('\n⚠️  WHOLE-SYSTEM uninstall — this removes the claude-tpm plugin AND the shared\n');
      process.stdout.write('    "claude-tpm-market" marketplace for EVERY project on this machine. Other consumers\n');
      process.stdout.write('    will lose claude-tpm until they re-run `npx tpm install`.\n');
      const a = (await ask('  Proceed with whole-system removal? [y/N] ')).trim().toLowerCase();
      if (a !== 'y' && a !== 'yes') { process.stdout.write('  declined — stopping.\n'); return 1; }
    }
  } else if (pointsHere && !opts.quiet) {
    process.stdout.write('\n⚠️  The shared "claude-tpm-market" marketplace points at THIS project\'s bundle:\n');
    process.stdout.write(`      ${path.resolve(targetDir, 'node_modules', TPM_PKG_NAME)}\n`);
    process.stdout.write('    Removing the dependency here breaks that source for any OTHER project on this machine\n');
    process.stdout.write('    that uses claude-tpm. Those projects will need to run `npx tpm doctor` (it will FAIL on\n');
    process.stdout.write('    "marketplace source resolves"), then `npx tpm install` again to re-point the marketplace\n');
    process.stdout.write('    at themselves.\n');
    const a = (await ask('  I understand other projects may need `npx tpm doctor` + re-install — continue? [y/N] ')).trim().toLowerCase();
    if (a !== 'y' && a !== 'yes') { process.stdout.write('  declined — stopping.\n'); return 1; }
  }

  // ── STEPS ──
  if (system) {
    // WHOLE-SYSTEM: uninstall the plugin, remove the marketplace GLOBALLY (no --scope), remove the dep.
    const s1installed = pluginState(targetDir).installed;
    _dbg('step 1/3: installed=' + s1installed + ' → already=' + !s1installed);
    const r1 = await doStep(opts, {
      already: !s1installed,
      describe: 'Step 1/3 — uninstall the claude-tpm plugin',
      command: `claude plugin uninstall ${PLUGIN_ID} --scope project${opts.quiet ? ' -y' : ''}`,
      edit: "~/.claude/plugins/ (global cache) + this project's plugin registry (project scope)",
      what: `Disables and removes ${PLUGIN_ID}.`,
      bin: 'claude', argv: ['plugin', 'uninstall', PLUGIN_ID, '--scope', 'project'].concat(opts.quiet ? ['-y'] : []), cwd: targetDir,
      verify: () => !pluginState(targetDir).installed,
      benign: /not installed|is not installed|not found|no such/i,
    });
    if (!r1.ok) return 1;

    // Marketplace remove with NO --scope → removes it for the whole machine (the deliberate difference
    // from project-only, which leaves it registered). `benign` treats an already-absent one as success.
    const s2registered = marketplaceRegistered(targetDir);
    _dbg('step 2/3: marketplaceRegistered=' + s2registered + ' → already=' + !s2registered);
    const r2 = await doStep(opts, {
      already: !s2registered,
      describe: 'Step 2/3 — remove the claude-tpm marketplace (WHOLE system)',
      command: `claude plugin marketplace remove ${MARKETPLACE_NAME}`,
      edit: "this machine's Claude Code marketplace registry (all scopes)",
      what: `Removes the "${MARKETPLACE_NAME}" marketplace for the whole machine — every project loses it.`,
      bin: 'claude', argv: ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME], cwd: targetDir,
      verify: () => !marketplaceRegistered(targetDir),
      benign: /not declared|not registered|not found|no such marketplace/i,
    });
    if (!r2.ok) return 1;

    const r3 = await removeDependencyStep(opts, targetDir, '3/3');
    if (r3 === null || !r3.ok) return 1;
  } else {
    // PROJECT-ONLY: DISABLE the plugin here (leave it installed + available for others), LEAVE the shared
    // marketplace registered, remove the dep from this project.
    const p1enabled = pluginState(targetDir).enabled;
    _dbg('step 1/2: enabled=' + p1enabled + ' → already=' + !p1enabled);
    const r1 = await doStep(opts, {
      already: !p1enabled,
      describe: 'Step 1/2 — disable the claude-tpm plugin for THIS project',
      command: `claude plugin disable ${PLUGIN_ID} --scope project`,
      edit: "this project's Claude Code plugin registry (project scope)",
      what: `Turns ${PLUGIN_ID} OFF for this project only — it stays installed + available for other projects.`,
      bin: 'claude', argv: ['plugin', 'disable', PLUGIN_ID, '--scope', 'project'], cwd: targetDir,
      verify: () => !pluginState(targetDir).enabled,
      benign: /not enabled|already disabled|is disabled|not installed|not found/i,
    });
    if (!r1.ok) return 1;

    process.stdout.write('\n(Leaving the "claude-tpm-market" marketplace registered — it\'s shared with other projects.)\n');

    const r2 = await removeDependencyStep(opts, targetDir, '2/2');
    if (r2 === null || !r2.ok) return 1;
  }

  process.stdout.write(`\n✓ claude-tpm removed from ${system ? 'the whole system' : 'this project'} (${targetDir})\n`);
  return 0;
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

function printHelp() {
  const src = fs.readFileSync(__filename, 'utf8');
  const m = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (m) process.stdout.write(m[1].split('\n').map((l) => l.replace(/^ \*\s?/, '')).join('\n').trim() + '\n');
}

function parseArgs(argv) {
  const a = { dir: null, quiet: false, force: false, check: false, system: false, project: false, debug: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i];
    if (x === '-h' || x === '--help') a.help = true;
    else if (x === '--quiet') a.quiet = true;
    else if (x === '--force') a.force = true;
    else if (x === '--check') a.check = true;
    else if (x === '--debug') a.debug = true;
    else if (x === '--system') a.system = true;   // remove the plugin + marketplace for the WHOLE machine
    else if (x === '--project') a.project = true; // remove from THIS project only (leave it for others)
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
  _dbg = makeDbg(debugEnabled(opts)); // enable the operation trace before any spawn/probe happens
  if (opts.help) { printHelp(); process.exit(0); }
  const targetDir = path.resolve(opts.dir);
  if (opts.check) { process.exit(runCheck(targetDir)); }
  process.exit(await runUninstall(opts));
}

if (require.main === module) {
  main().catch((err) => { process.stderr.write(`tpm-consumer-uninstall: ${err.message}\n`); process.exit(1); });
}

module.exports = {
  main, runUninstall, runCheck, parseArgs, removeDependencyStep,
  makeDbg, debugEnabled, formatChildExit, classifySpawn, spawnErrorReason, preflightMessage,
  readPackageJson, hasTpmDependency, claudeCliAvailable, marketplaceRegistered, pluginState, parsePluginList,
  parseMarketplaceList, marketplacePointsAt,
  TPM_PKG_NAME, MARKETPLACE_NAME, PLUGIN_NAME, PLUGIN_ID,
};
