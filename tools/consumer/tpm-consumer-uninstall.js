#!/usr/bin/env node
/**
 * tpm-consumer-uninstall.js — reverse tpm-consumer-install.js: remove claude-tpm from an EXISTING
 * consumer project. Calls `npm` and `claude plugin …` DIRECTLY (does NOT go through
 * tpm-consumer-manage-plugin.js). Never deletes the user's package.json, source, or docs — it only
 * removes what install.js added.
 *
 * PURPOSE
 *   Check-then-act, idempotent, SCOPE-AWARE uninstall from the target dir (default: cwd). It MIRRORS
 *   tpm-consumer-install.js: the marketplace is registered at USER scope (one row per version-scoped name,
 *   shared by every project on that version) and the plugin is installed at PROJECT scope (one install
 *   record per project). Because one row serves every project, the tool forks on scope (asked
 *   interactively; `--project`/`--system` set it non-interactively; a bare `--quiet` defaults to the safer
 *   project scope). <market> below is the RESOLVED, version-scoped marketplace name read from this bundle's
 *   .claude-plugin/marketplace.json (e.g. claude-tpm-market-0.2.0) — never a hardcoded bare name.
 *
 *   • PROJECT (default) — the mirror rule:
 *       1. `claude plugin uninstall <plugin>@<market> --scope project`  (this project's record + enablement)
 *       2. the marketplace row is removed (`claude plugin marketplace remove <market>`) ONLY when no OTHER
 *          project still has an install record for this plugin id (read from `claude plugin list --json`
 *          UNION the machine's installed_plugins.json). Otherwise the row is LEFT and the message names the
 *          projects still using it — removing it would uninstall the plugin for them too (`marketplace
 *          remove` deletes every project's install record + plugin data; probe #11a).
 *       3. `npm uninstall @codercowboy/claude-tpm`                     (this project's dep)
 *      GUARD: if the row that is left behind points INSIDE this project's node_modules, removing the dep
 *      here orphans it for the other projects — it asks for a secondary consent first.
 *   • SYSTEM — remove claude-tpm for the entire machine (asks a secondary consent first, naming the other
 *     projects that lose it):
 *       1. `claude plugin uninstall <plugin>@<market> --scope project`
 *       2. `claude plugin marketplace remove <market>`   (user scope → the whole machine, other projects'
 *          install records included)
 *       3. `npm uninstall @codercowboy/claude-tpm`
 *
 *   Every step prints a one-line header ("Step 1/3 · …"), its exact command and one plain sentence of why
 *   (plus what it edits where that isn't obvious), and asks per-step consent (skipped under --quiet). No package.json/README/LICENSE/.gitignore is touched beyond what
 *   `npm uninstall` edits. There is no env/hooks settings.json step to reverse — install.js never wrote
 *   one (the plugin delivers its own hooks via bundle-root hooks/hooks.json, so nothing was wired by hand).
 *
 * USAGE
 *   npx tpm uninstall [dir] [options]
 *   (same script via the plugin suite: `npx tpm plugin uninstall [dir] [options]`)
 *
 *   Options:
 *     [dir]          target project dir — POSITIONAL (first non-flag arg), e.g. `uninstall ../proj`.
 *     --dir <path>   same target dir, as a flag (alias for the positional). Default if neither: cwd.
 *     --project      scope: remove from THIS project (uninstall the plugin here + drop the dep; the shared
 *                    marketplace row is removed only if no other project still uses it). The default.
 *     --system       scope: remove the plugin + the marketplace row for the WHOLE machine (every
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
 *     --check        retired: exits 2 pointing at `tpm doctor` (the read-only state report).
 *     -h, --help
 *
 *   Examples:
 *     npx tpm uninstall ../proj              # interactive: asks project-only vs whole-system
 *     npx tpm uninstall ../proj --project    # this project only (non-interactive scope)
 *     npx tpm uninstall ../proj --system -y  # whole machine, no prompts
 *     npx tpm doctor ../proj                 # read-only: what is still set up there?
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

// Detection comes from the ONE shared observer (tpm-consumer-observe.js) — the same 5-layer snapshot `tpm install`
// and `tpm doctor` read. Uninstall keeps no private copy of any detector; it only consumes State and re-reads a
// layer (reobserveLayer) after a step. The marketplace + plugin identity are READ from this bundle's own
// .claude-plugin/marketplace.json (version-scoped, e.g. "claude-tpm-market-0.2.0"), so uninstall removes the SAME
// row install registered and a bare-named 0.1.0 bundle never clobbers a scoped 0.2.0 one.
const O = require('./tpm-consumer-observe');

const TPM_PKG_NAME = O.TPM_PKG_NAME;
const findBundleRoot = O.findBundleRoot;
const _bundleRoot = O.findBundleRoot(__dirname);
function readBundleIdentity() { return O.readBundleIdentity(_bundleRoot); }
const _ident = readBundleIdentity();
const MARKETPLACE_NAME = _ident.marketplace;
const PLUGIN_NAME = _ident.plugin;
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
const realOrResolved = O.realOrResolved;

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

// ── detection: ONE observe() per run, plus re-reads of the layer a step touched ───────────────────────────
// State fields used: env.claudeOnPath/claudeError (preflight) · en.record.present (this project's plugin install
// record) · reg.state/storedPath/realPath (the shared marketplace row) · dep.declared + target.pkg (package.json).
// `--debug` narrates each probe through the injected exec so the trace is unchanged.
function tracedExec(bin, argv, cwd, env) {
  const r = spawnSync(bin, argv, { encoding: 'utf8', cwd, env, timeout: 30000 });
  _dbg('probe:', bin + ' ' + argv.join(' '), '(cwd=' + cwd + ')',
    '→ status=' + r.status + ' signal=' + (r.signal || 'none') + (r.error ? ' error=' + r.error.code : '') +
    ' json=' + (!r.error && r.status === 0 && r.stdout ? 'parsed' : 'null'));
  return r;
}
function observeNow(targetDir) { return O.observe(targetDir, null, process.env, { exec: tracedExec }); }

// Pure: State → the classifySpawn-shaped verdict for `claude` (callers read .ok/.errorCode/.status).
function claudeVerdict(state) {
  const e = state.env || {};
  if (e.claudeOnPath === true) return { ok: true, ran: true, status: 0, signal: null, errorCode: null };
  const ce = e.claudeError || null;
  const exited = /^exited (\d+)$/.exec(ce || '');
  if (exited) return { ok: false, ran: true, status: Number(exited[1]), signal: null, errorCode: null };
  return { ok: false, ran: false, status: null, signal: null, errorCode: ce || 'ESPAWN' };
}
// Pure: is the plugin installed for THIS project (the project-scope record), and the shared row registered?
function pluginInstalled(state) { return !!(state.en && state.en.record && state.en.record.present); }
function rowRegistered(state) { return state.reg.state !== 'absent' && state.reg.state !== 'unknown'; }
function depDeclared(state) { return !!state.dep.declared; }
// Does the shared marketplace's row point INTO this project's node_modules? If so, removing the dependency
// here orphans that source for every OTHER project still using the row — which triggers the guard/consent
// below. A row stored as the node_modules symlink path counts (string match); so does a row that resolves to
// a REAL copy living there. A row that merely resolves (through a link) to a central folder does NOT — that
// folder survives `npm uninstall`.
function rowPointsInside(state, targetDir) {
  if (!rowRegistered(state) || !state.reg.storedPath) return false;
  const nm = path.resolve(targetDir, 'node_modules', TPM_PKG_NAME);
  if (path.resolve(state.reg.storedPath) === nm) return true;
  let nmIsLink = true;
  try { nmIsLink = fs.lstatSync(nm).isSymbolicLink(); } catch (_e) { return false; }
  return !nmIsLink && realOrResolved(state.reg.storedPath) === realOrResolved(nm);
}

// ── the MIRROR RULE: which OTHER projects still have an install record for this plugin id? ──────────────
// Two read-only sources, UNIONed (the dangerous error is removing a row someone else uses, so we'd rather
// see a record twice than miss one): `claude plugin list --json` (machine-wide records, one per project) and
// the machine's installed_plugins.json (v2: { plugins: { "<id>": [ {scope, projectPath, installPath…} ] } }).
// The file lives under $CLAUDE_CONFIG_DIR (tests point it at a scratch dir) else ~/.claude.
function claudeConfigDir() { return O.claudeConfigDir(process.env); }

// Pure: flatten a parsed installed_plugins.json (v2 map-of-arrays; also tolerates a plain array of records
// or a v1 map-of-objects) into [{id, scope, projectPath, installPath}] — only records for `id`.
function flattenInstalledPlugins(obj, id) {
  const out = [];
  const push = (rid, r) => { if (rid === id && r && typeof r === 'object') out.push({ id: rid, scope: r.scope, projectPath: r.projectPath, installPath: r.installPath }); };
  if (Array.isArray(obj)) { obj.forEach((r) => { if (r) push(r.id, r); }); return out; }
  const plugins = obj && typeof obj === 'object' ? (obj.plugins && typeof obj.plugins === 'object' ? obj.plugins : obj) : null;
  if (!plugins) return out;
  Object.keys(plugins).forEach((rid) => {
    const v = plugins[rid];
    if (Array.isArray(v)) v.forEach((r) => push(rid, r)); else push(rid, v);
  });
  return out;
}
function readInstalledPluginsFile(id) {
  try {
    return flattenInstalledPlugins(JSON.parse(fs.readFileSync(path.join(claudeConfigDir(), 'plugins', 'installed_plugins.json'), 'utf8')), id);
  } catch (_e) { return []; }
}

// Pure: from install records for this plugin id, the distinct OTHER users — every record that is not THIS
// target's own. A project-scope/local record is labelled with its projectPath; a user-scope record (applies to
// every project) or one with no projectPath (can't prove it's ours) is labelled conservatively and counts.
function otherUsersOf(records, targetDir) {
  const mine = realOrResolved(targetDir);
  const seen = new Set(); const out = [];
  for (const r of records || []) {
    if (!r || r.id !== PLUGIN_ID) continue;
    if (typeof r.projectPath === 'string' && r.projectPath && realOrResolved(r.projectPath) === mine) continue;
    const label = (typeof r.projectPath === 'string' && r.projectPath) ? r.projectPath
      : r.scope === 'user' ? '(a user-scope install — every project on this machine)' : '(an install record with no recorded project)';
    if (!seen.has(label)) { seen.add(label); out.push(label); }
  }
  return out.sort();
}
// The machine-wide `plugin list` was already probed by observe (memoized) — reuse that answer, don't re-ask.
function otherProjectsUsing(state, targetDir) {
  const p = state._ctx && state._ctx.probes ? state._ctx.probes.pluginList() : null;
  const list = p && p.ok ? p.json : null;
  const cli = Array.isArray(list) ? list.filter((e) => e && typeof e === 'object') : [];
  return otherUsersOf(cli.concat(readInstalledPluginsFile(PLUGIN_ID)), targetDir);
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

// ── presentation helpers (5.6) — presentation only; they never change what runs ─────────────────────────
// A step prints ONE header line ("Step 2/3 · Remove the marketplace row"), then the exact command and ONE plain
// sentence of why; `edit` (optional) only where the effect isn't obvious (the machine-wide registry). A skipped /
// already-done step is a single ✓ line.
// A DISPLAYED command line must be copy-pasteable: an argument with a space / quote / shell metacharacter is
// shown single-quoted. Display only — the real spawn uses the argv ARRAY (no shell), which is never altered.
function shellQuote(arg) {
  const s = String(arg);
  if (/^[A-Za-z0-9_@%+=:,.\/~-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
function displayCommand(bin, argv) { return [bin].concat(argv).map(shellQuote).join(' '); }

function stepHeader(n, total, title) { return `Step ${n}/${total} · ${title}`; }

async function doStep(opts, step) {
  const { already, describe, command, edit, what, bin, argv, cwd, verify } = step;
  if (already && !opts.force) {
    process.stdout.write(`✓ ${describe} — already done, skipped.\n`);
    return { ok: true, skipped: true };
  }
  process.stdout.write(`\n${describe}\n`);
  process.stdout.write(`  $ ${command}\n`);
  process.stdout.write(`  ${what}\n`);
  if (edit) process.stdout.write(`  (changes: ${edit})\n`);
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

// ── the uninstall run (default / --quiet / --force) ──────────────────────────────────────────────────

// Shared step: remove the claude-tpm dependency from THIS project's package.json + node_modules. Returns
// the doStep result, or null when package.json is present-but-invalid (a hard error the caller surfaces).
async function removeDependencyStep(opts, targetDir, stepLabel, state0) {
  const state = state0 || observeNow(targetDir);
  if (state.target.pkg.exists && !state.target.pkg.valid) {
    process.stderr.write(`error: ${path.join(targetDir, 'package.json')} is not valid JSON: ${state.target.pkg.err}\n`);
    return null;
  }
  const depPresent = state.target.pkg.exists && depDeclared(state);
  return doStep(opts, {
    already: !depPresent,
    describe: `Step ${stepLabel} · Remove the claude-tpm dependency`,
    command: displayCommand('npm', ['uninstall', TPM_PKG_NAME]),
    what: `Removes ${TPM_PKG_NAME} from package.json and node_modules; nothing else in the project is touched.`,
    bin: 'npm', argv: ['uninstall', TPM_PKG_NAME], cwd: targetDir,
    verify: () => !depDeclared(O.reobserveLayer(state, 'dep')),
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
  let state = observeNow(targetDir);
  const claudeProbe = claudeVerdict(state);
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
    process.stdout.write(`\nThe marketplace row "${MARKETPLACE_NAME}" is shared by every project on this version. Remove claude-tpm from:\n`);
    process.stdout.write('  [1] THIS project   (the shared row goes only if no other project still uses it)\n');
    process.stdout.write('  [2] The WHOLE system (the row goes too — every project loses claude-tpm)\n');
    const a = (await ask('  Choose [1/2] (default 1): ')).trim();
    system = (a === '2');
  }

  _dbg('scope: system=' + system + ' (from ' + (opts.system ? '--system' : opts.project ? '--project' : opts.quiet ? '--quiet default' : 'interactive prompt') + ')');

  // The mirror rule's input: who ELSE has an install record for this plugin id (CLI list ∪ installed_plugins.json).
  const others = otherProjectsUsing(state, targetDir);
  const rowThere = rowRegistered(state);
  const removeRow = rowThere && (system || others.length === 0);
  _dbg('mirror rule: otherProjects=' + JSON.stringify(others) + ' rowRegistered=' + rowThere + ' → removeRow=' + removeRow);
  const othersText = others.map((o) => `      - ${o}`).join('\n');
  const REMOVE_NOTE = `Removing the row uninstalls the plugin for every project on "${MARKETPLACE_NAME}": it deletes their install records + plugin data (re-adding restores loading).\n`;

  // Landmine: only when the row is LEFT behind — does it point INTO this project's node_modules? If so,
  // removing the dependency here orphans that source for the projects still using the row.
  const pointsHere = !system && rowThere && !removeRow && rowPointsInside(state, targetDir);
  _dbg('landmine: rowPointsInside(targetDir)=' + pointsHere);

  // ── secondary consent gates ──
  if (system) {
    process.stdout.write(`\n⚠ WHOLE-SYSTEM uninstall — removes the claude-tpm plugin AND the "${MARKETPLACE_NAME}" marketplace row.\n`);
    if (others.length) {
      process.stdout.write('  These other projects still have it installed and will lose claude-tpm until they re-run `npx tpm install`:\n' + othersText + '\n');
    } else {
      process.stdout.write('  No other project has an install record for it.\n');
    }
    process.stdout.write('  ' + REMOVE_NOTE);
    if (!opts.quiet) {
      const a = (await ask('  Proceed with whole-system removal? [y/N] ')).trim().toLowerCase();
      if (a !== 'y' && a !== 'yes') { process.stdout.write('  declined — stopping.\n'); return 1; }
    }
  } else if (pointsHere) {
    process.stdout.write(`\n⚠ The shared "${MARKETPLACE_NAME}" marketplace row points INSIDE this project's node_modules:\n`);
    process.stdout.write(`      ${path.resolve(targetDir, 'node_modules', TPM_PKG_NAME)}\n`);
    process.stdout.write('  Removing the dependency here breaks that source for the other projects still using it:\n' + othersText + '\n');
    process.stdout.write('  Their `npx tpm doctor` will show ✗ on "marketplace source"; they then re-run `npx tpm install` to re-point it.\n');
    if (!opts.quiet) {
      const a = (await ask('  I understand other projects may need `npx tpm doctor` + re-install — continue? [y/N] ')).trim().toLowerCase();
      if (a !== 'y' && a !== 'yes') { process.stdout.write('  declined — stopping.\n'); return 1; }
    }
  }

  // ── STEPS ── (both scopes: plugin uninstall at PROJECT scope → marketplace row decision → dep)
  const total = removeRow ? 3 : 2;
  const s1installed = pluginInstalled(state);
  _dbg(`step 1/${total}: installed=` + s1installed + ' → already=' + !s1installed);
  const r1 = await doStep(opts, {
    already: !s1installed,
    describe: stepHeader(1, total, 'Uninstall the plugin from this project'),
    command: displayCommand('claude', ['plugin', 'uninstall', PLUGIN_ID, '--scope', 'project'].concat(opts.quiet ? ['-y'] : [])),
    what: `Removes ${PLUGIN_ID}'s install record and enablement for this project only.`,
    bin: 'claude', argv: ['plugin', 'uninstall', PLUGIN_ID, '--scope', 'project'].concat(opts.quiet ? ['-y'] : []), cwd: targetDir,
    verify: () => !pluginInstalled(O.reobserveLayer(state, 'enablement')),
    benign: /not installed|is not installed|not found|no such/i,
  });
  if (!r1.ok) return 1;

  let nextLabel = '2/' + total;
  if (removeRow) {
    // Mirror rule satisfied (or --system): remove the user-scope row. `benign` treats an already-absent one as success.
    _dbg('step 2/3: removing marketplace row ' + MARKETPLACE_NAME);
    const r2 = await doStep(opts, {
      already: false,
      describe: stepHeader(2, 3, 'Remove the marketplace row' + (system ? ' (whole system)' : ' (no other project uses it)')),
      command: displayCommand('claude', ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]),
      edit: "this machine's Claude Code marketplace registry, user scope",
      what: system && others.length
        ? `Removes the "${MARKETPLACE_NAME}" row for the whole machine; ${others.length} other project${others.length === 1 ? '' : 's'} lose${others.length === 1 ? 's' : ''} it (listed above).`
        : `Removes the "${MARKETPLACE_NAME}" row; no other project has the plugin installed.`,
      bin: 'claude', argv: ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME], cwd: targetDir,
      verify: () => !rowRegistered(O.reobserveLayer(state, 'registration')),
      benign: /not declared|not registered|not found|no such marketplace/i,
    });
    if (!r2.ok) return 1;
    nextLabel = '3/3';
  } else if (rowThere) {
    process.stdout.write(`\n✓ Marketplace row "${MARKETPLACE_NAME}" left in place — ${others.length === 1 ? '1 other project still uses' : others.length + ' other projects still use'} it:\n${othersText}\n` +
      '  Removing the row would uninstall it for them (it deletes every project\'s install record + plugin data).\n');
  } else {
    process.stdout.write(`\n✓ Marketplace "${MARKETPLACE_NAME}" is not registered — nothing to remove.\n`);
  }

  const r3 = await removeDependencyStep(opts, targetDir, nextLabel, state);
  if (r3 === null || !r3.ok) return 1;

  process.stdout.write(`\n✓ claude-tpm removed from ${system ? 'the whole system' : 'this project'} (${targetDir}).\n`);
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
    else if (x === '--check') a.check = true; // retired: main() points at `tpm doctor` and exits 2
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
  if (opts.check) {
    process.stderr.write('error: `uninstall --check` is retired. Run `tpm doctor` to see what is still set up here, or `tpm uninstall` to remove it.\n');
    process.exit(2);
  }
  process.exit(await runUninstall(opts));
}

if (require.main === module) {
  main().catch((err) => { process.stderr.write(`tpm-consumer-uninstall: ${err.message}\n`); process.exit(1); });
}

module.exports = {
  shellQuote, displayCommand, main, runUninstall, parseArgs, removeDependencyStep,
  makeDbg, debugEnabled, formatChildExit, classifySpawn, spawnErrorReason, preflightMessage,
  observeNow, claudeVerdict, pluginInstalled, rowRegistered, depDeclared, rowPointsInside,
  otherUsersOf, otherProjectsUsing, flattenInstalledPlugins,
  readInstalledPluginsFile, claudeConfigDir, realOrResolved,
  findBundleRoot, readBundleIdentity,
  TPM_PKG_NAME, MARKETPLACE_NAME, PLUGIN_NAME, PLUGIN_ID,
};
