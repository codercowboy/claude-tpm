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
 *     2. claude-tpm dependency — INTERACTIVE, consent-gated: ask whether to record the dep at all, then
 *        regular (`--save`) vs dev (`--save-dev`, the default — claude-tpm is dev-time tooling), then
 *        confirm the exact npm command before running. Declining the first question skips the dep entirely
 *        (marketplace + plugin steps still run). Skipped as "already done" when the dep is already declared
 *        AND present in node_modules (unless --force). --quiet/-y never prompts: records it as a dev dep.
 *     3. marketplace — registered at USER scope (the CLI default; no `--scope project`) from THIS
 *        installer's own bundle folder, REALPATH'd (never a project's `./node_modules/...` link). The
 *        registry stores the path exactly as given and a local-folder plugin runs IN PLACE from it, so
 *        the row is live code for every project on that marketplace name. What the step does depends on
 *        the existing row for this (version-scoped) marketplace name, comparing RESOLVED paths:
 *          not registered                       → register it (`marketplace add <real folder>`).
 *          registered, same real folder         → leave the row alone (only per-project steps run);
 *                                                 a symlink-stored path is reported healthy-but-symlinked,
 *                                                 never re-stored automatically.
 *          registered, folder gone              → re-point (remove + add); the message says the folder
 *                                                 moved / was deleted.
 *          registered, alive, resolves elsewhere → NEVER re-pointed silently. Interactive: asks, naming
 *                                                 both folders and the blast radius. `--quiet`: exits 1
 *                                                 unless `--repoint` is given.
 *        REAL COPY IN ANOTHER PROJECT (5.2): when that live row resolves INSIDE a node_modules dir (a project
 *        that installed claude-tpm from GitHub/npm), the install names it ("claude-tpm is already installed on
 *        this machine from <folder>"; "if you keep it, this project will run that copy, not its own"), hashes
 *        both folders (skips .DS_Store, tmp/, node_modules/, .git/) and reports "same version, identical files"
 *        or "same version, files differ (N files)", then offers: 1) one shared folder for several projects
 *        (README / docs/INSTALL.md), 2) uninstall from that project first (`npx tpm uninstall --system` there),
 *        3) proceed sharing that copy (explicit yes; type "share different copy" when the files differ).
 *        Choices 1/2 stop with the exact next commands. `--quiet` stops with exit 1 unless `--force`; with
 *        `--force` it proceeds sharing that copy (the row is NOT re-pointed). `--check` shows a WARN row.
 *        NOTE: `claude plugin marketplace remove` deletes EVERY project's install record + plugin data for
 *        that marketplace (re-adding the same name restores loading — `enabledPlugins` + a registered
 *        marketplace is enough), so any re-point says so.
 *     4. plugin install — `claude plugin install <plugin>@<marketplace> --scope project`, run with cwd =
 *        the target project (so the project's settings end up with only `enabledPlugins`; installing
 *        usually also enables — see step 5).
 *     5. project enablement — `claude plugin enable <plugin>@<marketplace> --scope project`,
 *        ONLY if the plugin is installed but currently disabled for this project (step 4 usually
 *        already leaves it enabled).
 *   Deliberately NOT handled here: writing env vars or hooks into any settings.json. The plugin delivers
 *   its own hooks via the bundle-root hooks/hooks.json (read when the plugin is enabled): a SessionStart
 *   hook that exports TPM_PROJECT_ROOT (the project) and TPM_HOME (this bundle's folder, informational
 *   only; tools always find their own folder), and the spawn gate. Claude Code puts the plugin's bin/ on
 *   PATH in Claude Bash calls, so skills and tool output run bare `tpm …`.
 *   Human terminal: humans run `npx tpm …` in a plain project shell, once the dependency from step 2 exists.
 *   The installer relies on `claude plugin install/enable` to write the project's `enabledPlugins` line; this
 *   tool never edits settings.json directly.
 *
 * USAGE
 *   npx tpm install [dir] [options]
 *   (via the bin: `tpm install <dir> [options]` / `npx tpm install <dir>`; same script via the plugin suite:
 *    `npx tpm plugin install …`, and `npx tpm plugin doctor` / `npx tpm doctor` = `--check`)
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
 *     --repoint        permit step 3 to re-point a LIVE marketplace row that resolves to a different folder
 *                      (without it, `--quiet` stops with an error there and interactive runs ask first).
 *     --force          skip the "already done" checks and (re-)run every step; treat an
 *                      already-added/already-installed response as success, not error. Still asks per
 *                      step unless combined with --quiet. With --quiet it also lets a row that points at a real
 *                      copy in another project's node_modules proceed, sharing that copy (never re-pointed).
 *     --debug          operation trace to STDOUT, prefixed `[tpm-debug]` (a `set -x`-style log): narrate
 *                      every child spawn (bin/argv/cwd → status/signal/elapsed-ms), every `claude … --json`
 *                      probe, and each step decision (already/marketplaceReady/needsEnable + its inputs).
 *                      Also enabled by the TPM_DEBUG=1 env var. Diagnostic ONLY — changes no install
 *                      behavior; the abnormal-exit signal name is surfaced even without it.
 *     --check          read-only: run every state check, print a one-line-per-row checklist, change nothing.
 *                      Exits non-zero if anything is missing. (The consumer "doctor".) Checks:
 *                      Rows (each is ONE line: ✓ ok / ⚠ warning / ✗ problem / · skipped, a label naming what is
 *                      checked, and a message; every ⚠/✗ adds an indented `fix:` line; a summary line ends the run):
 *                        package.json valid · tpm dep declared · marketplace registered ·
 *                        marketplace SOURCE is this bundle's folder and exists (RESOLVED paths: PASS when it
 *                          resolves to this bundle; WARN when it does so only via a symlink path — healthy but
 *                          fragile, or when it is alive but resolves to a different folder (this project runs
 *                          that folder's code); FAIL only when the folder is gone — "moved or deleted",
 *                          which Claude Code misreports as "cache-miss") ·
 *                        plugin installed (a MISSING install record is only a WARN when the plugin is enabled in
 *                          the project's settings and the marketplace is registered — it still loads) ·
 *                        plugin enabled for this project · only one claude-tpm@* enabled (the first silently wins) ·
 *                        project set up (an enabled plugin with no .claude/claude-tpm/ is a FAIL: run
 *                          `npx tpm install .`) · install-record path (INFO only — the cache isn't what runs) ·
 *                        hooks delivered (SessionStart session-start AND PreToolUse gate-spawn) ·
 *                        plugin bundle version vs this project's node_modules copy (mismatch = WARN) ·
 *                        consumer config.json parses · real copy in another node_modules (WARN) ·
 *                        IN-SESSION ONLY (TPM_PROJECT_ROOT / TPM_HOME set, i.e. a Claude Bash call): `tpm` on
 *                          PATH resolves into the plugin's bin/ (WARN names a shadowing file) ·
 *                        TPM_HOME (when set) is this same bundle (WARN otherwise; it is informational — tools
 *                          self-locate). A normal install runs this same doctor as a final step.
 *     -h, --help
 *
 *   Examples:
 *     npx tpm install ../some-project           # positional target dir
 *     npx tpm install ../some-project --check
 *     npx tpm install --quiet --from file:../claude-tpm ../some-project
 *     npx tpm install --quiet --repoint ../some-project   # explicitly re-point a live row elsewhere
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

// The marketplace + plugin identity are READ from THIS bundle's own .claude-plugin/marketplace.json
// (the installer and that manifest ship together in the same version folder, so they can never
// disagree) rather than hardcoded. The marketplace NAME is version-scoped there
// (e.g. "claude-tpm-market-0.2.0") — this is the load-bearing fix for the cross-version bug: Claude
// Code keys marketplaces by NAME in ONE machine-global ~/.claude/plugins/known_marketplaces.json
// record, so a bare "claude-tpm-market" shared by every version is a last-add-wins singleton. Two
// projects on different versions then fight over one source path and resolve each other's skills
// ("my 0.1.0 project is seeing 0.2.0 skills"). A version-scoped name makes each installed version an
// independent registry citizen; the install-record + cache layers (installed_plugins.json,
// cache/<market>/<plugin>/<version>) were already version-aware. Falls back to the historical bare
// name if the manifest is unreadable, so a corrupt bundle degrades rather than crashes.
function readBundleIdentity() {
  const fallback = { marketplace: 'claude-tpm-market', plugin: 'claude-tpm' };
  const bundleRoot = findBundleRoot(__dirname);
  if (!bundleRoot) return fallback;
  try {
    const mp = JSON.parse(fs.readFileSync(path.join(bundleRoot, '.claude-plugin', 'marketplace.json'), 'utf8'));
    const marketplace = (mp && typeof mp.name === 'string' && mp.name) ? mp.name : fallback.marketplace;
    const plugin = (mp && Array.isArray(mp.plugins) && mp.plugins[0] && typeof mp.plugins[0].name === 'string' && mp.plugins[0].name)
      ? mp.plugins[0].name : fallback.plugin;
    return { marketplace, plugin };
  } catch (_e) { return fallback; }
}
const _ident = readBundleIdentity();
const MARKETPLACE_NAME = _ident.marketplace;
const PLUGIN_NAME = _ident.plugin;
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
// The marketplace source = THIS installer's own bundle folder, REALPATH'd (null if it can't self-locate).
// Node realpaths the main module, so this is the canonical folder even when the installer is invoked
// THROUGH a project's node_modules symlink; every project on this version registers the same (name, path).
// Never a project's `./node_modules/...` path: the registry stores the path as given, and a local-folder
// plugin runs in place from it (probe-findings #1-#3).
function realOrResolved(p) {
  try { return fs.realpathSync(p); } catch (_e) { return path.resolve(p); }
}
const BUNDLE_ROOT = findBundleRoot(__dirname);
const MARKETPLACE_SOURCE = BUNDLE_ROOT ? realOrResolved(BUNDLE_ROOT) : null;

// Fail-loud version-stamp guard. The marketplace NAME must equal `claude-tpm-market-<package.json
// version>` — that pin is what keeps two installed versions from colliding on one machine-global,
// last-add-wins marketplace record. `npm version` re-stamps it automatically (tools/build/
// stamp-manifests.js via the `version` lifecycle), but a HAND-EDITED version bump skips that hook and
// would silently register a stale, wrong-version name. We REFUSE the install rather than self-heal:
// this tool never mutates the vendored bundle inside node_modules. Returns { ok, version, expected,
// actual }. Unreadable/absent version → ok:true (identity already fell back; don't add a 2nd failure
// mode over a bundle we can't even read a version from).
function manifestVersionStamp(bundleRoot) {
  try {
    const version = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'package.json'), 'utf8')).version;
    if (!version) return { ok: true };
    const expected = `claude-tpm-market-${version}`;
    return { ok: MARKETPLACE_NAME === expected, version, expected, actual: MARKETPLACE_NAME };
  } catch (_e) { return { ok: true }; }
}

// ── operation-trace (--debug / TPM_DEBUG) + child-exit formatter ────────────────────────────────────
// A `set -x`-style trace to STDOUT so an "exit null" run narrates what it did and what every child
// returned (incl. the signal name). Instrumentation ONLY — it changes no install behavior. The writer is
// a module-level singleton (like _prompter below) so runChild, which has no opts in scope, can call it.
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

// Availability = the probe actually RAN and exited 0 (classifySpawn.ok) — NOT merely "the error wasn't
// ENOENT". That one rule catches an absent bin (ENOENT), a directory / non-exec file shadowing it on PATH
// (EACCES), AND a broken bin that errors, all at once. Returns the RICHER classifySpawn verdict (not a
// bare boolean any more) so callers read `.ok` for availability and `.errorCode` for the reason.
function claudeCliAvailable() {
  return classifySpawn(spawnSync('claude', ['--version'], { encoding: 'utf8' }));
}

// Generic PATH probe. Returns the classifySpawn verdict ({ok, ran, status, signal, errorCode}); callers
// read `.ok` for availability and `.errorCode` for the reason. Used by the preflight for `npm`.
function commandAvailable(bin) {
  return classifySpawn(spawnSync(bin, ['--version'], { encoding: 'utf8' }));
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

// `cwd` MATTERS: `claude plugin list --json` reports each plugin's `enabled` state RELATIVE TO the
// project context of the cwd it runs in (verified live — the same entry reads enabled:false from an
// unrelated dir and enabled:true from within its own project). So every project-scoped probe MUST run
// from the TARGET project dir, or it misreads enablement (the false-exit-1 re-enable bug: step 5 saw
// "not enabled" from the wrong cwd, re-ran enable, and `claude` errored "already enabled"). Callers pass
// targetDir; it defaults to process.cwd() only for ad-hoc/module use.
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
// Scopes we manage: the PLUGIN is installed at project scope (the marketplace is user scope, which has no
// install record of its own). `targetDir` (optional) narrows to THIS project's record: `plugin list --json`
// reports the machine-wide records (one per project), so when an entry carries a `projectPath` it must
// resolve to the target. An entry with no projectPath still matches (older shapes / hand-built fixtures).
function recordMatches(e, targetDir) {
  if (!e || typeof e !== 'object' || e.id !== PLUGIN_ID) return false;
  if (!(e.scope === undefined || e.scope === 'project')) return false;
  if (targetDir && typeof e.projectPath === 'string' && e.projectPath) {
    return realOrResolved(e.projectPath) === realOrResolved(targetDir);
  }
  return true;
}

function parsePluginList(list, targetDir) {
  if (list === null) return { installed: false, enabled: false }; // CLI unavailable / non-JSON output
  if (!Array.isArray(list)) {
    process.stderr.write('warning: `claude plugin list --json` did not return a JSON array (schema drift?) — assuming plugin not installed.\n');
    return { installed: false, enabled: false };
  }
  if (list.length > 0 && !list.some((e) => e && typeof e === 'object' && typeof e.id === 'string')) {
    process.stderr.write('warning: `claude plugin list --json` entries lack the expected `id` field (schema drift?) — assuming plugin not installed.\n');
    return { installed: false, enabled: false };
  }
  const entry = list.find((e) => recordMatches(e, targetDir));
  if (!entry) return { installed: false, enabled: false };
  if (typeof entry.enabled !== 'boolean') {
    process.stderr.write(`warning: plugin entry ${PLUGIN_ID} has no boolean "enabled" field (schema drift?) — assuming enabled.\n`);
    return { installed: true, enabled: true };
  }
  return { installed: true, enabled: entry.enabled };
}

function pluginState(cwd) {
  return parsePluginList(runClaudeJson(['plugin', 'list', '--json'], cwd), cwd);
}

// ── hooks-delivery health (the plugin ships its hook itself, via the bundle-root hooks/hooks.json;
// there is NO env.TPM_HOME / settings.json hook wiring to check — that was retired). The doctor verifies
// the delivered artifact is intact: the bundle in the target's node_modules carries a hooks/hooks.json
// that declares gate-spawn (PreToolUse) — the sole auto-wired hook after #1126 retired the %TPM_HOME%
// resolution hooks. Split pure-parse / disk-read like parsePluginList above. ─

// Pure: given a parsed hooks.json object, report whether it declares the sole hook the plugin delivers:
// `gate-spawn` (PreToolUse). The %TPM_HOME% resolution hooks were retired in #1126 (anchor-first
// resolution via `npx tpm resolve-home` replaced them), so gate-spawn is now the only auto-wired hook.
// Matched by the command string CONTAINING `hooks <name>`, so it survives a `node …`→`npx tpm`
// rewording and doesn't pin to one invocation form.
function parseHooksManifest(manifest) {
  const result = { gateSpawn: false, sessionStart: false };
  if (!manifest || typeof manifest !== 'object' || !manifest.hooks) return result;
  const scan = (groups, pred) => {
    if (!Array.isArray(groups)) return;
    for (const group of groups) {
      const hooks = group && Array.isArray(group.hooks) ? group.hooks : [];
      for (const h of hooks) pred(h && typeof h.command === 'string' ? h.command : '');
    }
  };
  scan(manifest.hooks.PreToolUse, (cmd) => { if (/hooks\s+gate-spawn/.test(cmd)) result.gateSpawn = true; });
  scan(manifest.hooks.SessionStart, (cmd) => { if (/hooks\s+session-start/.test(cmd)) result.sessionStart = true; });
  return result;
}

// Reader: locate + parse the delivered bundle's hooks/hooks.json inside the target's node_modules.
// present:false ⇒ the manifest file isn't there (dep not installed yet, or a pre-hooks bundle) — the
// check row degrades to a skip rather than a hard fail when node_modules has no bundle.
function bundleHooksHealth(targetDir) {
  return bundleHooksHealthAt(path.join(targetDir, 'node_modules', TPM_PKG_NAME));
}

// Same, for any bundle folder. EVERY return carries the full shape { present, error, gateSpawn, sessionStart }
// (the early-return paths used to omit sessionStart).
function bundleHooksHealthAt(bundleDir) {
  const p = path.join(bundleDir, 'hooks', 'hooks.json');
  if (!fs.existsSync(p)) return { present: false, error: null, gateSpawn: false, sessionStart: false };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return { present: true, error: e.message, gateSpawn: false, sessionStart: false }; }
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

// ── consumer config.json seed (#1132.C) ──────────────────────────────────────────────────────────
// The default config.json a fresh install lays down: the two store-dir keys the task/session
// resolvers read, pre-populated with the project-relative defaults so `npx tpm task|session config
// --tasks-dir|--sessions-dir` (and every verb) resolve without the operator hand-authoring a config.
// The values MIRROR the resolvers' getDefaults() so the seeded file is behaviourally identical to
// the built-in project-local default — it just makes that default EXPLICIT + hand-editable.
function seedConfigDefaults() {
  return {
    version: 1,
    tasks: { tasksDir: '.claude/claude-tpm/tasks' },
    session: { notes: { sessionsDir: '.claude/claude-tpm/sessions' } },
  };
}

// ensureConsumerConfig(targetDir) -> { wrote, path, reason }
// IDEMPOTENT: writes <targetDir>/.claude/claude-tpm/config.json with seedConfigDefaults() ONLY when
// no config.json is already present — an existing user config is NEVER clobbered (reason 'exists').
// Atomic write (tmp + rename) so a crash mid-write can't leave a half-written config the resolvers
// would choke on. Returns what it did so the caller can print an honest one-liner.
function ensureConsumerConfig(targetDir) {
  const dir = path.join(targetDir, '.claude', 'claude-tpm');
  const p = path.join(dir, 'config.json');
  if (fs.existsSync(p)) return { wrote: false, path: p, reason: 'exists' };
  fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(seedConfigDefaults(), null, 2) + '\n';
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, p);
  return { wrote: true, path: p, reason: 'created' };
}

// ── marketplace SOURCE health (the "registered but points at the wrong place" shape) ────────────────────
// A marketplace can be registered by NAME while its SOURCE PATH no longer resolves — e.g. the global
// singleton `claude-tpm-market` still points at a sibling consumer whose node_modules was deleted. A
// name-only "registered?" check reports PASS for that dead registration, yet it blocks every install: the
// plugin "is not found in marketplace" / loads with a cache-miss. This verifies the registered
// marketplace's source actually exists on disk. Split pure-parse / disk-read like parsePluginList.
//
// Pure: given parsed `claude plugin marketplace list --json` (VERIFIED shape, claude 2.1.272: an array of
// { name, source, path?, repo?, installLocation }), return OUR marketplace's registration shape.
// `path` is the on-disk source dir for a `directory` source (absent for a `github` source).
function parseMarketplaceList(list) {
  if (!Array.isArray(list)) return { registered: false, source: null, path: null };
  const m = list.find((e) => e && typeof e === 'object' && e.name === MARKETPLACE_NAME);
  if (!m) return { registered: false, source: null, path: null };
  return {
    registered: true,
    source: typeof m.source === 'string' ? m.source : null,
    path: typeof m.path === 'string' ? m.path : null,
  };
}

// Reader: is our marketplace registered, and if so does its source resolve on disk?
// resolves is true when NOT registered (nothing to resolve — callers gate on `registered`) OR the source
// isn't a local directory (a `github` marketplace has no local path to check) OR the directory source
// exists. A registered directory-source marketplace whose path is gone → resolves:false (dead-source).
function marketplaceSourceHealth(cwd) {
  const parsed = parseMarketplaceList(runClaudeJson(['plugin', 'marketplace', 'list', '--json'], cwd));
  if (!parsed.registered) return { registered: false, source: null, sourcePath: null, resolves: true };
  const isDir = parsed.source === 'directory' || (parsed.source == null && parsed.path != null);
  const resolves = !isDir || (parsed.path != null && fs.existsSync(parsed.path));
  return { registered: true, source: parsed.source, sourcePath: parsed.path, resolves };
}

// Pure: classify OUR marketplace's registry row against the canonical (resolved) bundle folder — the D2a
// row table. `parsed` = parseMarketplaceList(...) output; `canonical` = the realpath'd bundle folder;
// `exists` (injectable for tests) = fs.existsSync-alike. Returns { state, sourcePath, realPath, symlinked }:
//   absent    → not registered
//   same      → registered, its stored path resolves to the canonical folder (symlinked:true when the stored
//               string differs from the resolved one — healthy but fragile; we never re-store it ourselves)
//   dead      → registered directory source whose folder no longer exists (moved / deleted)
//   elsewhere → registered, alive, resolves to a DIFFERENT folder (or is not a local-directory source at all)
function classifyMarketplaceRow(parsed, canonical, exists) {
  const ex = exists || ((p) => fs.existsSync(p));
  if (!parsed || !parsed.registered) return { state: 'absent', sourcePath: null, realPath: null, symlinked: false, source: null };
  const isDir = parsed.source === 'directory' || (parsed.source == null && parsed.path != null);
  if (!isDir) return { state: 'elsewhere', sourcePath: parsed.path, realPath: null, symlinked: false, source: parsed.source };
  if (parsed.path == null || !ex(parsed.path)) {
    return { state: 'dead', sourcePath: parsed.path, realPath: null, symlinked: false, source: parsed.source };
  }
  const realPath = realOrResolved(parsed.path);
  const same = !!canonical && realPath === realOrResolved(canonical);
  return { state: same ? 'same' : 'elsewhere', sourcePath: parsed.path, realPath,
    symlinked: realPath !== path.resolve(parsed.path), source: parsed.source };
}

function marketplaceRow(cwd) {
  return classifyMarketplaceRow(
    parseMarketplaceList(runClaudeJson(['plugin', 'marketplace', 'list', '--json'], cwd)), MARKETPLACE_SOURCE);
}

// ── 5.2 — the "real copy in ANOTHER project's node_modules" case (D2a) ──────────────────────────────────
// Pure: when `realPath` (the RESOLVED folder an existing live row points at) lies inside a node_modules
// directory, return { projectDir, folder } (projectDir = the project that owns that node_modules); else null.
// Only meaningful for a row that is NOT this installer's canonical folder (callers pass 'elsewhere' rows).
function realCopyInfo(realPath) {
  if (!realPath || typeof realPath !== 'string') return null;
  const parts = path.resolve(realPath).split(path.sep);
  const i = parts.lastIndexOf('node_modules');
  if (i < 0) return null;
  const projectDir = parts.slice(0, i).join(path.sep) || path.sep;
  return { projectDir, folder: path.resolve(realPath) };
}

// Names skipped when hashing a claude-tpm copy (at any depth): OS junk, scratch, deps, VCS.
const HASH_SKIP = new Set(['.DS_Store', 'tmp', 'node_modules', '.git']);

// Deterministic content map of a folder: { 'rel/posix/path': sha256 } — sorted walk, skips HASH_SKIP names,
// symlinks hashed by their link text (never followed). THROWS on an unreadable folder (callers degrade).
function hashTree(root) {
  const crypto = require('crypto');
  const out = {};
  (function walk(dir, rel) {
    const names = fs.readdirSync(dir).filter((n) => !HASH_SKIP.has(n)).sort();
    for (const n of names) {
      const full = path.join(dir, n); const r = rel ? rel + '/' + n : n;
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) out[r] = 'link:' + fs.readlinkSync(full);
      else if (st.isDirectory()) walk(full, r);
      else if (st.isFile()) out[r] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  })(root, '');
  return out;
}

// Compare two claude-tpm copies by content. Returns { verdict: 'identical' | 'differs' | 'unknown', count, text }.
// 'unknown' (couldn't read one side) never throws. count = number of files that differ / exist on one side only.
function compareCopies(a, b) {
  try {
    const ha = hashTree(a); const hb = hashTree(b);
    const keys = new Set(Object.keys(ha).concat(Object.keys(hb)));
    let count = 0;
    for (const k of keys) if (ha[k] !== hb[k]) count += 1;
    if (count === 0) return { verdict: 'identical', count: 0, text: 'same version, identical files' };
    return { verdict: 'differs', count, text: `same version, files differ (${count} file${count === 1 ? '' : 's'})` };
  } catch (e) {
    return { verdict: 'unknown', count: 0, text: `couldn't compare the two copies (${e && e.message ? e.message : e})` };
  }
}

// The plain-language heading for the real-copy case (shared by install, quiet error, and the doctor row).
function realCopyMessage(info, cmp, targetDir) {
  const own = path.resolve(info.projectDir) === realOrResolved(targetDir) ? ' (that is this project\'s OWN node_modules copy)' : '';
  return `claude-tpm is already installed on this machine from ${info.folder}${own}.\n` +
    `  If you keep it, this project will run that copy, not its own: the registry row for "${MARKETPLACE_NAME}" points there.\n` +
    `  Compared with this installer's copy (${MARKETPLACE_SOURCE}): ${cmp.text}.\n` +
    (cmp.verdict === 'identical'
      ? '  Sharing is harmless today but fragile: that project owns the files, and deleting its node_modules breaks claude-tpm here too.\n'
      : '  The copies may not match, so this project would silently run the other project\'s variant.\n');
}

// What each remediation option does, with the exact commands. (opt 1/2 stop the install; nothing is changed.)
function realCopyOptionText() {
  return '  Options:\n' +
    '    1) Recommended: use ONE shared claude-tpm folder for several projects (README, docs/INSTALL.md).\n' +
    '    2) Uninstall claude-tpm from that other project first, with `npx tpm uninstall --system` there (it loses claude-tpm until reinstalled).\n' +
    '    3) Proceed anyway, sharing that copy (needs a yes, or a typed phrase if the copies differ).\n';
}
function realCopyNextSteps(choice, info, targetDir) {
  const central = MARKETPLACE_SOURCE && !/(^|[\\/])node_modules([\\/]|$)/.test(MARKETPLACE_SOURCE);
  if (choice === 1) {
    return '  Nothing was changed. Next steps (one shared folder):\n' +
      (central
        ? `    - this installer's folder (${MARKETPLACE_SOURCE}) is already standalone. To point the shared row at it for every project:\n` +
          `        node "${path.join(MARKETPLACE_SOURCE, 'tools', 'tpm.js')}" install "${targetDir}" --repoint\n` +
          '      (re-pointing deletes every project\'s install record; re-adding restores loading)\n'
        : '    - put claude-tpm in a standalone folder (outside any node_modules), then run its installer for each project:\n' +
          `        node "<shared folder>/tools/tpm.js" install "${targetDir}" --repoint\n`) +
      '    - the README "several projects" section (docs/INSTALL.md) has the full recipe.\n';
  }
  return '  Nothing was changed. Next steps (uninstall from the other project first):\n' +
    `    1. cd "${info.projectDir}" && npx tpm uninstall --system      (removes claude-tpm there and the marketplace row; that project loses claude-tpm until reinstalled)\n` +
    `    2. npx tpm install "${targetDir}"                              (re-run this install; it will then register this copy)\n`;
}

// ── plugin CACHE health (the "version registered but it's not there" shape) ─────────────────────────────
// `claude plugin list --json` can report an installed-plugin RECORD whose cached copy under
// ~/.claude/plugins/cache/ is gone ("failed to load: cache-miss" in the human list). pluginState().installed
// is true for such a record, so a name-only "installed?" check misses it. This verifies the record's
// installPath cache dir exists on disk. Split pure-parse / disk-read.
//
// Pure: given parsed `plugin list --json`, return OUR project-scope entry's installPath (the cache dir),
// or null when there's no such entry / it reports no installPath.
function parsePluginInstallPath(list, targetDir) {
  if (!Array.isArray(list)) return null;
  const entry = list.find((e) => recordMatches(e, targetDir));
  return entry && typeof entry.installPath === 'string' ? entry.installPath : null;
}

// Reader: does the installed plugin record's cached copy exist on disk?
//   present:true  → installPath reported AND exists (healthy)
//   present:false → installPath reported but the cache dir is GONE (the cache-miss shape)
//   present:null  → no installPath reported (nothing to check — e.g. no record, or schema drift)
function pluginCacheHealth(cwd) {
  const installPath = parsePluginInstallPath(runClaudeJson(['plugin', 'list', '--json'], cwd), cwd);
  if (installPath == null) return { installPath: null, present: null };
  return { installPath, present: fs.existsSync(installPath) };
}

// ── child-process runner (captures output so the --force "already" heuristic can inspect it, then
// echoes it so the user still sees what happened) ────────────────────────────────────────────────────

function runChild(bin, argv, cwd) {
  // If an interactive prompter is open, release the TTY (drop raw mode) for the duration of this
  // synchronous spawn — otherwise a real TTY signal-kills the process ("exit null"). No-op under
  // --quiet/--check (no prompter) and under piped stdin (not a TTY), so those paths are unchanged.
  const releaseTty = !!_prompter && !!process.stdin.isTTY;
  _dbg('→ spawn:', bin, argv.join(' '), '(cwd=' + cwd + ')', releaseTty ? '[tty-release]' : '');
  if (releaseTty) _prompter.pause();
  const t0 = Date.now();
  const r = spawnSync(bin, argv, { cwd, encoding: 'utf8' });
  const ms = Date.now() - t0;
  if (releaseTty) _prompter.resume();
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  const cls = classifySpawn(r);
  if (!cls.ran) {
    // Spawn-level error — the child NEVER ran (ENOENT: absent; EACCES: a dir / non-exec file shadows it on
    // PATH; or any other errno). Surface the errno instead of letting it fall through as a fake status:null
    // "killed by signal unknown". The `←` line gains error=<code>, parity with the runClaudeJson probe line.
    _dbg('← status=' + cls.status, 'signal=' + (cls.signal || 'none'), 'error=' + cls.errorCode, `(${ms}ms)`, formatChildExit(r));
    return { status: cls.status, signal: cls.signal, errorCode: cls.errorCode, enoent: cls.errorCode === 'ENOENT', combined: '' };
  }
  _dbg('← status=' + cls.status, 'signal=' + (cls.signal || 'none'), `(${ms}ms)`, formatChildExit(r));
  return { status: cls.status, signal: cls.signal, errorCode: null, enoent: false, combined: (r.stdout || '') + (r.stderr || '') };
}

// ── interactive consent (zero-dep: Node core `readline`) ────────────────────────────────────────────

// A multi-question prompter over ONE readline interface, shared by EVERY prompt in a run. A per-question
// interface can't work with scripted input: piped stdin delivers all its lines (and EOF) in one burst, so
// a second interface finds the stream already drained/closed ("readline was closed") and every line after
// the first is lost. Instead, buffer every `line` event into a queue and let each question() pull the next
// line (or '' once stdin has closed). Prompts are written to stdout manually. ONE prompter per process —
// created lazily on the first prompt (so --quiet / --check, which never prompt, open no readline and the
// process exits cleanly), and torn down by process.exit at the end of a CLI run.
let _prompter = null;
function makePrompter() {
  // ONE shared readline interface for the whole run. It must get TWO things right at once:
  //  (1) piped/scripted stdin flushes every line + EOF in one burst, so we buffer `line` events into a
  //      queue and let each question() pull the next (or '' once closed). Calling rl.question() per prompt
  //      instead races that close and throws "readline was closed" on the 2nd/3rd question.
  //  (2) a real interactive TTY must ECHO what you type — which requires an `output` stream on the
  //      interface. The original omitted `output`, so a human saw nothing and "couldn't even press y".
  // Fix = keep the line-queue AND pass `output: process.stdout`. Prompt strings are written manually.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (line) => { if (waiters.length) waiters.shift()(line); else queue.push(line); });
  rl.on('close', () => { closed = true; while (waiters.length) waiters.shift()(''); });
  return {
    question: (prompt) => new Promise((resolve) => {
      process.stdout.write(prompt);
      if (queue.length) resolve(queue.shift());
      else if (closed) resolve('');
      else waiters.push(resolve);
    }),
    // Release/re-grab the TTY around synchronous child spawns. An open readline holds stdin in RAW mode;
    // spawnSync while raw-mode is active gets the process signal-killed on a real TTY ("exit null") — even
    // though we pipe the child's stdio. pause() drops raw mode + pauses input for the duration of the spawn.
    pause: () => { try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch (_) {} rl.pause(); },
    resume: () => { rl.resume(); try { if (process.stdin.isTTY) process.stdin.setRawMode(true); } catch (_) {} },
    close: () => { rl.close(); _prompter = null; },
  };
}

// Single shared prompter for the whole run (see makePrompter). Every consent prompt — doStep's "Run this?"
// and doDependencyStep's three questions — goes through here, so scripted/piped answers flow across steps.
function ask(question) {
  if (!_prompter) _prompter = makePrompter();
  return _prompter.question(question);
}
function closePrompter() { if (_prompter) _prompter.close(); }

// ── presentation helpers (5.6) — presentation only; they never change what runs ─────────────────────────
// A step prints ONE header line ("Step 3/5 · Register the marketplace"), then the exact command (the honest
// record of what will run) and ONE plain sentence of why. `edit` (optional) is printed only where the effect
// isn't obvious (e.g. the machine-wide registry). A skipped / already-done step is a single ✓ line.
// A DISPLAYED command line must be copy-pasteable: an argument with a space / quote / shell metacharacter is
// shown single-quoted. Display only — the real spawn uses the argv ARRAY (no shell), which is never altered.
function shellQuote(arg) {
  const s = String(arg);
  if (/^[A-Za-z0-9_@%+=:,.\/~-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
function displayCommand(bin, argv) { return [bin].concat(argv).map(shellQuote).join(' '); }

function stepHeader(n, total, title) { return `Step ${n}/${total} · ${title}`; }
function skippedLine(header) { return `✓ ${header} — already done, skipped.\n`; }
function writeStepBody(step) {
  process.stdout.write(`  $ ${step.command}\n`);
  process.stdout.write(`  ${step.what}\n`);
  if (step.edit) process.stdout.write(`  (changes: ${step.edit})\n`);
}

// Run one step: check state, print header + command + why, ask consent (unless --quiet / `preApproved`), run, report.
// `already` = the state check already satisfies this step (skipped unless --force). `preApproved` = a decision the
// user already made (e.g. the single re-point confirmation) covers this step, so it is not asked again — it is NOT
// --quiet: it never changes the argv (no `-y`).
async function doStep(opts, step) {
  const { already, describe, bin, argv, cwd, verify } = step;
  if (already && !opts.force) {
    process.stdout.write(skippedLine(describe));
    return { ok: true, skipped: true };
  }
  process.stdout.write(`\n${describe}\n`);
  writeStepBody(step);
  if (!opts.quiet && !step.preApproved) {
    const answer = (await ask('  Run this? [y/N] ')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      process.stdout.write('  declined — stopping.\n');
      return { ok: false, declined: true };
    }
  }
  const res = runChild(bin, argv, cwd);
  if (res.errorCode) {
    process.stderr.write(`  ✗ could not run '${bin}': ${res.errorCode} (${spawnErrorReason(res.errorCode)})\n`);
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
    process.stderr.write(`  ✗ ${formatChildExit(res)}\n`);
    return { ok: false };
  }
  process.stdout.write('  ✓ done.\n');
  return { ok: true };
}

// Step 2 is special — an INTERACTIVE, consent-gated dependency RECORDER (replaces the old hardcoded
// `npm install <spec> --save-optional`). Three prompts, reusing the same `ask` helper + the
// show-command-before-running pattern as doStep:
//   1) add the dep at all? — a bare `n` SKIPS the dependency step entirely (marketplace + plugin steps
//      still run; `npx tpm …` just won't resolve locally from this project — a legitimate choice).
//   2) regular vs dev? — 1 → --save (dependencies); 2 or bare-enter → --save-dev (devDependencies).
//      Default 2 (dev): claude-tpm is dev-time tooling, so it belongs in devDependencies — a production
//      `npm install --omit=dev` / `npm ci --omit=dev` then skips it (it's never shipped to prod) while a
//      normal dev `npm install` still materializes it. (0.1.0 recorded it as OPTIONAL; 0.2.0 moves to DEV.)
//   3) confirm the exact command before running.
// --quiet / -y (non-interactive) NEVER prompts: it records the dep as DEV (--save-dev), the new default —
// keeps headless/automated installs + test harnesses working, just in the dev bucket instead of optional.
async function doDependencyStep(opts, step) {
  const { already, describe, targetDir, fromSpec } = step;
  if (already && !opts.force) {
    process.stdout.write(skippedLine(describe));
    return { ok: true, skipped: true };
  }
  process.stdout.write(`\n${describe}\n`);

  let saveFlag = '--save-dev';
  let bucket = 'devDependencies';
  if (!opts.quiet) {
    const add = (await ask(`  Install ${TPM_PKG_NAME} into this project's package.json via npm? (y/n) `)).trim().toLowerCase();
    if (add !== 'y' && add !== 'yes') {
      process.stdout.write(`  skipped — NOT recording ${TPM_PKG_NAME} in package.json.\n`);
      process.stdout.write('  The marketplace and plugin steps still run; `npx tpm …` just won\'t resolve locally here.\n');
      return { ok: true, skippedDep: true };
    }
    const kind = (await ask('  Record it as a (1) regular dependency or (2) dev dependency? [default 2] ')).trim();
    if (kind === '1') { saveFlag = '--save'; bucket = 'dependencies'; }
  }

  const command = displayCommand('npm', ['install', fromSpec, saveFlag]);
  writeStepBody({
    command,
    what: `Records ${TPM_PKG_NAME} in ${bucket} of ${path.join(targetDir, 'package.json')} and installs it into node_modules.`,
  });

  if (!opts.quiet) {
    const proceed = (await ask(`  About to run: ${command}. Proceed? (y/n) `)).trim().toLowerCase();
    if (proceed !== 'y' && proceed !== 'yes') {
      process.stdout.write('  declined — stopping.\n');
      return { ok: false, declined: true };
    }
  }

  const argv = ['install', fromSpec, saveFlag];
  const verify = () => hasTpmDependency(readPackageJson(targetDir).value) && nodeModulesHasTpm(targetDir);
  const res = runChild('npm', argv, targetDir);
  if (res.errorCode) {
    process.stderr.write(`  ✗ could not run 'npm': ${res.errorCode} (${spawnErrorReason(res.errorCode)})\n`);
    return { ok: false };
  }
  if (res.status !== 0) {
    if (opts.force && verify()) {
      process.stdout.write('  (already in the desired state — treating as success under --force)\n');
      return { ok: true, alreadyOk: true };
    }
    process.stderr.write(`  ✗ ${formatChildExit(res)}\n`);
    return { ok: false };
  }
  process.stdout.write('  ✓ done.\n');
  return { ok: true };
}

// ── --check mode (read-only doctor) ──────────────────────────────────────────────────────────────────

// Pure-ish readers/helpers for the doctor rows (exported so tests can drive them directly).

function readJsonFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_e) { return null; }
}

// The plugin ids this project's settings files turn ON (`enabledPlugins: { "<id>": true }`), from the
// project's .claude/settings.json and .claude/settings.local.json. Never reads user-level settings.
function settingsEnabledPlugins(targetDir) {
  const ids = [];
  for (const name of ['settings.json', 'settings.local.json']) {
    const j = readJsonFile(path.join(targetDir, '.claude', name));
    const ep = j && typeof j === 'object' ? j.enabledPlugins : null;
    if (ep && typeof ep === 'object') {
      for (const k of Object.keys(ep)) if (ep[k] === true && ids.indexOf(k) < 0) ids.push(k);
    }
  }
  return ids;
}

// Every `claude-tpm@*` plugin enabled for this project: the settings entries UNION this project's enabled
// project-scope records from `claude plugin list --json` (`list` = that parsed JSON, or null).
function claudeTpmEnabledIds(targetDir, list) {
  const ids = settingsEnabledPlugins(targetDir).filter((id) => id.indexOf(PLUGIN_NAME + '@') === 0);
  if (Array.isArray(list)) {
    for (const e of list) {
      if (!e || typeof e !== 'object' || typeof e.id !== 'string' || e.id.indexOf(PLUGIN_NAME + '@') !== 0) continue;
      if (e.enabled !== true || !(e.scope === undefined || e.scope === 'project')) continue;
      if (typeof e.projectPath === 'string' && e.projectPath && realOrResolved(e.projectPath) !== realOrResolved(targetDir)) continue;
      if (ids.indexOf(e.id) < 0) ids.push(e.id);
    }
  }
  return ids;
}

// package.json `version` of a folder, or null.
function bundleVersion(dir) {
  const j = readJsonFile(path.join(dir, 'package.json'));
  return j && typeof j.version === 'string' ? j.version : null;
}

// First executable `name` found by scanning a PATH string (what a shell's `command -v` resolves), or null.
function findOnPath(name, pathStr) {
  for (const dir of String(pathStr || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      if (!fs.statSync(p).isFile()) continue;
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (_e) { /* not here */ }
  }
  return null;
}

// In a Claude Bash call the SessionStart hook has exported TPM_PROJECT_ROOT / TPM_HOME; outside one neither is set.
function inClaudeSession(env) { return !!(env && (env.TPM_PROJECT_ROOT || env.TPM_HOME)); }

// `tpm` on PATH (in-session only): the first `tpm` on PATH must resolve into an expected bundle's bin/
// (this bundle's, or the registered plugin folder's — Claude Code puts the plugin's bin/ on PATH).
// Returns { applicable, ok, found } — applicable:false outside a Claude session.
function checkTpmOnPath(env, binDirs) {
  if (!inClaudeSession(env)) return { applicable: false, ok: true, found: null };
  const found = findOnPath('tpm', env.PATH);
  if (!found) return { applicable: true, ok: false, found: null };
  const real = realOrResolved(found);
  const ok = (binDirs || []).filter(Boolean).some((d) => path.dirname(real) === realOrResolved(d));
  return { applicable: true, ok, found };
}

// `TPM_HOME` vs the doctor's own bundle: TPM_HOME is informational (tools self-locate), but a set value that
// differs from the bundle running this doctor means this project's tpm copy and the enabled plugin differ.
function checkTpmHomeVsSelf(env, bundleRoot) {
  const home = env && env.TPM_HOME;
  if (!home || !bundleRoot) return { applicable: false, differs: false, home: home || null };
  return { applicable: true, differs: realOrResolved(home) !== realOrResolved(bundleRoot), home };
}

// Doctor rendering (5.6): one line per row — a status mark (✓ ok · ⚠ warning · ✗ problem · · skipped/info), a short
// label that names WHAT is checked (never the passing condition — the mark + message carry the verdict), and the
// message. Only ⚠/✗ rows get an indented `fix:` line (plain words + the exact command). One summary line at the end.
const MARKS = { pass: '✓', warn: '⚠', fail: '✗', info: '·', skip: '·' };
function plural(n, one, many) { return `${n} ${n === 1 ? one : (many || one + 's')}`; }
function renderRows(rows) {
  const w = rows.reduce((m, r) => Math.max(m, r.label.length), 0);
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const row of rows) {
    const msg = row.note ? `  ${row.note}` : '';
    process.stdout.write(`  ${MARKS[row.status]} ${(row.note ? row.label.padEnd(w) : row.label)}${msg}\n`);
    if ((row.status === 'fail' || row.status === 'warn') && row.fix) process.stdout.write(`      fix: ${row.fix}\n`);
    counts[row.status === 'info' ? 'pass' : row.status] += 1;
  }
  process.stdout.write(`  Summary: ${counts.pass} ok · ${plural(counts.warn, 'warning')} · ${plural(counts.fail, 'problem')}` +
    (counts.skip ? ` · ${counts.skip} skipped` : '') + '\n');
  return counts.fail === 0 ? 0 : 1;
}

function runCheck(targetDir, env) {
  env = env || process.env;
  const rows = []; // { label, status: 'pass'|'warn'|'fail'|'info'|'skip', note?, fix? }
  const add = (label, status, note, fix) => rows.push({ label, status, note: note || '', fix: fix || '' });
  const INSTALL_FIX = 'run `npx tpm install .` in this project';
  const NO_CLAUDE = 'the `claude` CLI is not on PATH';

  const pkgRead = readPackageJson(targetDir);
  add('package.json', pkgRead.exists && !pkgRead.error ? 'pass' : 'fail',
    pkgRead.error ? `invalid JSON: ${pkgRead.error}` : pkgRead.exists ? '' : 'not found',
    pkgRead.error ? 'fix the JSON syntax in package.json' : 'run `npm init -y` in the project dir, then `npx tpm install .`');

  const depOk = pkgRead.exists && !pkgRead.error && hasTpmDependency(pkgRead.value);
  if (!(pkgRead.exists && !pkgRead.error)) add('claude-tpm dependency', 'fail', 'skipped — no valid package.json', INSTALL_FIX + ' (step 2 records the dependency)');
  else add('claude-tpm dependency', depOk ? 'pass' : 'fail', depOk ? TPM_PKG_NAME : `${TPM_PKG_NAME} is not in package.json`, INSTALL_FIX + ' (step 2 records the dependency)');

  const claudeOk = claudeCliAvailable().ok;
  const mParsed = claudeOk ? parseMarketplaceList(runClaudeJson(['plugin', 'marketplace', 'list', '--json'], targetDir))
    : { registered: false, source: null, path: null };
  const marketOk = claudeOk && mParsed.registered;
  add('marketplace', marketOk ? 'pass' : 'fail', marketOk ? `"${MARKETPLACE_NAME}" is registered` : claudeOk ? `"${MARKETPLACE_NAME}" is not registered` : NO_CLAUDE,
    claudeOk ? INSTALL_FIX + ' (step 3 registers the marketplace)' : 'install Claude Code (the `claude` CLI must be on PATH), then `npx tpm install .`');

  // Marketplace SOURCE: a local-folder plugin runs IN PLACE from the registered folder, so the row must
  // resolve (realpath) to THIS bundle's folder and that folder must exist. Missing folder = the plugin's
  // source was moved/deleted (Claude Code misreports that as "cache-miss").
  const mRow = classifyMarketplaceRow(mParsed, MARKETPLACE_SOURCE);
  const SRC = 'marketplace source';
  const realCopy = mRow.state === 'elsewhere' ? realCopyInfo(mRow.realPath) : null;
  if (!claudeOk) add(SRC, 'skip', `skipped — ${NO_CLAUDE}`);
  else if (!marketOk) add(SRC, 'skip', 'skipped — not registered');
  else if (mRow.state === 'dead') {
    add(SRC, 'fail',
      `the folder was moved or deleted (Claude Code reports this as 'cache-miss'): ${mRow.sourcePath || 'unknown'}`,
      'run `npx tpm install .` from the folder claude-tpm now lives in — it re-points the marketplace at the live folder');
  } else if (mRow.state === 'elsewhere') {
    const where = mRow.realPath || mRow.sourcePath;
    // Real-copy case: the next row carries the folder + comparison, so this row only points at it (no repeat).
    add(SRC, 'warn',
      realCopy ? "points at another project's copy of claude-tpm — details in the real-copy row below"
        : `points at ${where}, not this bundle (${MARKETPLACE_SOURCE}) — this project runs that folder's code`,
      realCopy ? 'see the real-copy row below for the options'
        : 'run `npx tpm install .` here — it explains the options (add --repoint to point the row at this bundle)');
  } else if (mRow.symlinked) {
    add(SRC, 'warn',
      `healthy but fragile: stored as the symlink ${mRow.sourcePath} -> ${mRow.realPath}; it breaks if the link is removed`,
      'to store the real folder instead: `npx tpm uninstall --system`, then `npx tpm install .` from the real folder');
  } else add(SRC, 'pass', "this bundle's folder");

  // Project-scope state — enablement is cwd-relative (see runClaudeJson).
  const pluginListJson = claudeOk ? runClaudeJson(['plugin', 'list', '--json'], targetDir) : null;
  const pstate = claudeOk ? parsePluginList(pluginListJson, targetDir) : { installed: false, enabled: false };
  const settingsOn = settingsEnabledPlugins(targetDir).indexOf(PLUGIN_ID) >= 0;
  // A marketplace re-add wipes install records yet the plugin still LOADS from enabledPlugins + the registered
  // marketplace (probe #11a) — so a missing record is a WARN, never a FAIL, when both of those hold.
  const loadsWithoutRecord = !pstate.installed && settingsOn && marketOk;
  if (pstate.installed) add('plugin install record', 'pass', PLUGIN_ID);
  else if (loadsWithoutRecord) {
    add('plugin install record', 'warn',
      'none for this project, but the plugin is enabled in .claude/settings.json and the marketplace is registered, so it still loads',
      're-run `npx tpm install .` to restore the record');
  } else {
    add('plugin install record', 'fail', claudeOk ? `${PLUGIN_ID} is not installed here` : NO_CLAUDE,
      claudeOk ? INSTALL_FIX + ' (step 4 installs the plugin)' : 'install Claude Code, then `npx tpm install .`');
  }
  const enabledOk = (pstate.installed && pstate.enabled) || loadsWithoutRecord;
  const notInstalled = claudeOk && !pstate.installed && !loadsWithoutRecord;
  add('plugin enablement', enabledOk ? 'pass' : 'fail',
    notInstalled ? 'not enabled — the plugin is not installed' : enabledOk ? 'enabled for this project' : 'not enabled for this project',
    INSTALL_FIX + ' (it enables the plugin for this project)');

  // More than one claude-tpm@* enabled: the first silently wins, the rest are shadowed.
  const enabledIds = claudeTpmEnabledIds(targetDir, pluginListJson);
  add('enabled claude-tpm plugins', enabledIds.length > 1 ? 'warn' : 'pass',
    enabledIds.length > 1 ? `${enabledIds.join(', ')} are all enabled — the first silently wins`
      : enabledIds.length === 1 ? enabledIds[0] : 'none',
    'disable the extras, e.g. `claude plugin disable <id> --scope project` for all but the one you want');

  // Plugin enabled but the project was never installed (no .claude/claude-tpm/ marker): task/session tools
  // refuse ("--tasks-dir is required … run inside a project").
  const markerPresent = fs.existsSync(path.join(targetDir, '.claude', 'claude-tpm'));
  const PROJ = 'project folder';
  if (enabledIds.length > 0 && !markerPresent) {
    add(PROJ, 'fail', 'plugin enabled but no .claude/claude-tpm/ here, so the task and session tools refuse to run',
      'run `npx tpm install .` in this project');
  } else if (enabledIds.length === 0) add(PROJ, 'skip', 'skipped — plugin not enabled for this project');
  else add(PROJ, 'pass', '.claude/claude-tpm/ present');

  // Install-record path: INFORMATIONAL only. A local-folder plugin runs in place from the registered folder;
  // the "cache"/install path in the record is not what runs, and the record isn't needed to load.
  const cacheH = (claudeOk && pstate.installed) ? pluginCacheHealth(targetDir) : { installPath: null, present: null };
  add('install-record path', !claudeOk || !pstate.installed || cacheH.present === null ? 'skip' : 'info',
    !claudeOk ? `skipped — ${NO_CLAUDE}`
      : !pstate.installed ? 'skipped — not installed'
      : cacheH.present === null ? 'skipped — no installPath reported'
      : cacheH.present ? 'present (informational — the cache is not what runs)'
      : `${cacheH.installPath} is missing — harmless${mRow.state === 'dead' ? ' — it is only a record (see the marketplace source row for the real problem)' : ', the plugin runs from the registered marketplace folder'}`);

  // Hooks delivery: the plugin ships BOTH the SessionStart `session-start` hook and the PreToolUse `gate-spawn`
  // hook via the bundle-root hooks/hooks.json. Checked in the project's node_modules copy when there is one,
  // else in this bundle.
  const nmHasTpm = nodeModulesHasTpm(targetDir);
  const hh = nmHasTpm ? bundleHooksHealth(targetDir) : bundleHooksHealthAt(BUNDLE_ROOT || '');
  const missingHooks = [];
  if (!hh.sessionStart) missingHooks.push('session-start (SessionStart)');
  if (!hh.gateSpawn) missingHooks.push('gate-spawn (PreToolUse)');
  const hooksOk = hh.present && !hh.error && missingHooks.length === 0;
  add('plugin hooks', hooksOk ? 'pass' : 'fail',
    hooksOk ? 'session-start + gate-spawn' : hh.error ? `bundle hooks.json is invalid JSON: ${hh.error}`
      : !hh.present ? 'the bundle carries no hooks/hooks.json'
      : `missing: ${missingHooks.join(', ')}`,
    'reinstall or update the claude-tpm bundle so hooks/hooks.json declares both hooks, then `npx tpm install .`');

  // Version agreement: the enabled plugin's bundle (the registered folder) vs this project's node_modules copy.
  const VER = 'bundle version';
  const pluginFolder = (marketOk && mRow.realPath) ? mRow.realPath : null;
  const nmVersion = bundleVersion(path.join(targetDir, 'node_modules', TPM_PKG_NAME));
  const plVersion = pluginFolder ? bundleVersion(pluginFolder) : null;
  if (!pluginFolder) add(VER, 'skip', 'skipped — no registered plugin folder to compare');
  else if (!nmVersion) add(VER, 'skip', `skipped — no node_modules copy here; the plugin runs from ${pluginFolder}`);
  else if (!plVersion) add(VER, 'skip', `skipped — couldn't read the plugin bundle's version in ${pluginFolder}`);
  else if (plVersion !== nmVersion) {
    add(VER, 'warn', `the enabled plugin is ${plVersion} (${pluginFolder}) but this project's node_modules copy is ${nmVersion}`,
      'make them agree: update the project dependency or the registered plugin, then re-run `npx tpm install .`');
  } else add(VER, 'pass', `${plVersion}, plugin and node_modules copy agree`);

  // Consumer override config (optional): if present, it must be valid JSON.
  const cfgv = configJsonValidity(targetDir);
  add('config.json', cfgv.valid ? 'pass' : 'fail',
    !cfgv.present ? 'none — using defaults' : cfgv.valid ? 'valid JSON' : `invalid JSON: ${cfgv.error}`,
    'fix the JSON in .claude/claude-tpm/config.json (or delete it to use defaults)');

  // 5.2 — WARN row: the live row resolves to a real copy inside another node_modules.
  if (claudeOk && marketOk && realCopy) {
    const cmp = compareCopies(realCopy.folder, MARKETPLACE_SOURCE || realCopy.folder);
    add('real copy in another project', 'warn',
      `${realCopy.folder} — this project runs that copy; ${cmp.text}`,
      'run `npx tpm install .` here for the options (one shared folder, or uninstall from the other project first)');
  }

  // In-session only: `tpm` on PATH must resolve into the plugin's bin/ (catches a shadowing `tpm`, e.g. the
  // tmux plugin manager). Needs a Claude Bash call's PATH, so it is skipped outside a session.
  const TPMP = 'tpm on PATH';
  const tpmP = checkTpmOnPath(env, [BUNDLE_ROOT && path.join(BUNDLE_ROOT, 'bin'), pluginFolder && path.join(pluginFolder, 'bin')]);
  if (!tpmP.applicable) add(TPMP, 'skip', 'skipped — only checked inside a Claude Code Bash call (TPM_PROJECT_ROOT / TPM_HOME not set here)');
  else if (tpmP.ok) add(TPMP, 'pass', `resolves into the plugin bin/ (${tpmP.found})`);
  else if (!tpmP.found) add(TPMP, 'warn', 'no `tpm` found on PATH', 'enable the plugin for this project (its bin/ goes on PATH in Claude Bash calls), or use `npx tpm …`');
  else {
    add(TPMP, 'warn', `a different \`tpm\` shadows the plugin's: ${tpmP.found}`,
      `remove or rename ${tpmP.found} (or put the plugin's bin/ earlier on PATH), or use \`npx tpm …\``);
  }

  // TPM_HOME is informational (tools self-locate): warn only when it is set AND names a different folder.
  const th = checkTpmHomeVsSelf(env, BUNDLE_ROOT);
  if (th.applicable) {
    add('TPM_HOME', th.differs ? 'warn' : 'pass',
      th.differs ? `TPM_HOME=${th.home} but this doctor runs from ${BUNDLE_ROOT} — the project's tpm copy and the enabled plugin are different folders` : 'same folder as this tpm copy',
      'start a fresh Claude Code session so the SessionStart hook re-exports it; TPM_HOME is informational, tools find their own folder');
  }

  return renderRows(rows);
}

// ── the install run (default / --quiet / --force) ───────────────────────────────────────────────────

async function runInstall(opts) {
  _dbg = makeDbg(debugEnabled(opts)); // idempotent — main() also sets it; covers a direct module call
  const targetDir = path.resolve(opts.dir);
  _dbg('resolved run: opts=' + JSON.stringify({ dir: opts.dir, from: opts.from, quiet: !!opts.quiet, force: !!opts.force, repoint: !!opts.repoint, debug: !!opts.debug }));
  _dbg('resolved run: targetDir=' + targetDir + ' bundleRoot=' + findBundleRoot(__dirname));
  _dbg('tty: stdin.isTTY=' + !!process.stdin.isTTY + ' stdout.isTTY=' + !!process.stdout.isTTY);

  // Step 1/5 — preflight. Fail fast, per-prerequisite: `npm` on PATH, a package.json to write into, and
  // the `claude` CLI on PATH (a missing `claude` used to surface downstream as an unhelpful "exited null").
  // package.json is never created by this tool, in ANY mode (--force included) — authoring project identity
  // is the user's call, not ours; it's also load-bearing (step 2 needs it to exist).
  const npmProbe = commandAvailable('npm');
  if (!npmProbe.ok) {
    process.stderr.write(stepHeader(1, 5, 'Preflight') + ' — ✗ failed\n');
    process.stderr.write('  error: ' + preflightMessage('npm', npmProbe, 'install Node.js/npm first.') + '\n');
    return 1;
  }
  const pkgRead = readPackageJson(targetDir);
  if (!pkgRead.exists) {
    process.stderr.write(stepHeader(1, 5, 'Preflight') + ' — ✗ failed\n');
    process.stdout.write(`No package.json found in ${targetDir}.\n\n`);
    process.stdout.write('  Run this yourself first:\n');
    process.stdout.write('    npm init -y\n');
    process.stdout.write('  It writes a default package.json (name guessed from the folder). Step 2 needs one to record the dependency in.\n');
    return 1;
  }
  if (pkgRead.error) {
    process.stderr.write(stepHeader(1, 5, 'Preflight') + ' — ✗ failed\n');
    process.stderr.write(`  error: ${path.join(targetDir, 'package.json')} is not valid JSON: ${pkgRead.error}\n`);
    return 1;
  }
  const claudeProbe = claudeCliAvailable();
  if (!claudeProbe.ok) {
    process.stderr.write(stepHeader(1, 5, 'Preflight') + ' — ✗ failed\n');
    process.stderr.write('  error: ' + preflightMessage('claude', claudeProbe, 'install Claude Code first.') + '\n');
    return 1;
  }
  const bundleRoot = findBundleRoot(__dirname);
  const stampGuard = bundleRoot ? manifestVersionStamp(bundleRoot) : { ok: true };
  if (!stampGuard.ok) {
    process.stderr.write(stepHeader(1, 5, 'Preflight') + ' — ✗ failed\n');
    process.stderr.write(`  error: stale marketplace name — this bundle's package.json is ${stampGuard.version}, `);
    process.stderr.write(`but the plugin manifest registers "${stampGuard.actual}" (expected "${stampGuard.expected}").\n`);
    process.stderr.write('  The version was bumped without re-stamping the manifests. Run `npm run stamp` in the claude-tpm source,\n');
    process.stderr.write('  re-vendor, and retry — installing as-is would register a wrong-version marketplace that collides with others.\n');
    return 1;
  }
  const pkg = pkgRead.value;
  process.stdout.write(stepHeader(1, 5, 'Preflight') + ' — ✓ npm, package.json and claude are all available.\n');

  // Config seed (#1132.C) — lay down a default .claude/claude-tpm/config.json (tasks.tasksDir +
  // session.notes.sessionsDir) so the task/session verbs resolve their store without a hand-authored
  // config. Idempotent: an existing user config is left untouched (never clobbered). Not a numbered
  // step — it is a local filesystem write that needs no `claude` CLI and can't fail the install flow.
  const cfgSeed = ensureConsumerConfig(targetDir);
  const cfgRel = path.relative(targetDir, cfgSeed.path) || cfgSeed.path;
  process.stdout.write(cfgSeed.wrote
    ? `✓ Config · wrote ${cfgRel} (default task and session folders).\n`
    : `✓ Config · ${cfgRel} already there, left as-is.\n`);

  // Step 2 — claude-tpm dependency. Idempotent: skip `npm install` (unless --force) when the dep is both
  // declared in package.json AND already present in node_modules.
  const fromSpec = opts.from || defaultFromSpec(targetDir);
  if (!fromSpec) {
    process.stderr.write('error: could not self-locate the claude-tpm bundle to compute a default --from;\n');
    process.stderr.write('  pass --from <spec> explicitly (e.g. --from file:../claude-tpm).\n');
    return 1;
  }
  _dbg('resolved run: fromSpec=' + fromSpec);
  const step2Already = hasTpmDependency(pkg) && nodeModulesHasTpm(targetDir);
  _dbg('step 2: hasDep=' + hasTpmDependency(pkg) + ' inNodeModules=' + nodeModulesHasTpm(targetDir) + ' → already=' + step2Already);
  const r2 = await doDependencyStep(opts, {
    already: step2Already,
    describe: stepHeader(2, 5, 'Add the claude-tpm dependency'),
    targetDir, fromSpec,
  });
  if (!r2.ok) return 1;

  // Step 3 — marketplace registration, from the CANONICAL (realpath'd) bundle folder at USER scope (no
  // --scope flag; the CLI default). marketplace add/remove take no -y flag; unaffected by --quiet.
  // The row table (D2a) is keyed on this version's marketplace NAME and compares RESOLVED paths:
  //   absent → add · same folder → leave alone · folder gone → re-point · alive-but-elsewhere → guarded.
  if (!MARKETPLACE_SOURCE) {
    process.stderr.write('error: could not self-locate the claude-tpm bundle folder to register as the marketplace source.\n');
    return 1;
  }
  const row = marketplaceRow(targetDir);
  let marketplaceReady = row.state === 'same';
  let repointConfirmed = false; // the guarded re-point was explicitly confirmed (or --repoint): remove + add + install share that one answer
  let sharedRealCopy = false; // 5.2: proceeding on another project's real copy — the row is never touched
  _dbg('step 3: state=' + row.state + ' stored=' + row.sourcePath + ' real=' + row.realPath + ' symlinked=' + row.symlinked + ' canonical=' + MARKETPLACE_SOURCE + ' → marketplaceReady=' + marketplaceReady);
  if (row.state === 'same' && row.symlinked) {
    process.stdout.write(`  ⚠ The marketplace is registered as the symlink ${row.sourcePath} -> ${row.realPath}: healthy but fragile (it breaks if the link is removed). Left as-is; \`npx tpm doctor\` shows the fix.\n`);
  }
  const REMOVE_WARNING = `Removing the row deletes EVERY project's install record + plugin data; re-adding "${MARKETPLACE_NAME}" restores loading (their enabledPlugins stay).\n`;
  if (row.state === 'dead') {
    _dbg('step 3: dead-folder marketplace detected → re-pointing (remove stale registration first)');
    process.stdout.write(`\n⚠ Marketplace "${MARKETPLACE_NAME}" is registered, but its folder no longer exists (moved or deleted):\n` +
      `    ${row.sourcePath || '(none recorded)'}\n` +
      '  No project can load the plugin until the row is re-pointed.\n  ' + REMOVE_WARNING);
  } else if (row.state === 'elsewhere' && !opts.repoint && realCopyInfo(row.realPath)) {
    // 5.2 — a real copy inside another project's node_modules (D2a). Never re-pointed here: the options
    // are share it, uninstall there first, or stop. NO marketplace add/remove happens on this path.
    const info = realCopyInfo(row.realPath);
    const cmp = compareCopies(info.folder, MARKETPLACE_SOURCE);
    const head = realCopyMessage(info, cmp, targetDir);
    if (opts.quiet) {
      if (!opts.force) {
        process.stderr.write('error: ' + head + realCopyOptionText() +
          '  Stopping (non-interactive). Re-run with --force to share that copy (the row is NOT re-pointed), or choose option 1 or 2.\n');
        return 1;
      }
      process.stdout.write('\n⚠ ' + head + '  --quiet --force given — proceeding, sharing that copy (marketplace row left as-is).\n');
    } else {
      process.stdout.write('\n⚠ ' + head + realCopyOptionText());
      const choice = (await ask('  Choose 1, 2 or 3 [default: stop]: ')).trim();
      if (choice === '1' || choice === '2') {
        process.stdout.write(realCopyNextSteps(Number(choice), info, targetDir));
        return 1;
      }
      if (choice !== '3') {
        process.stdout.write('  no option chosen — stopping; nothing was changed.\n');
        return 1;
      }
      if (cmp.verdict === 'identical') {
        const a = (await ask('  Proceed, sharing that copy? [y/N] ')).trim().toLowerCase();
        if (a !== 'y' && a !== 'yes') { process.stdout.write('  declined — nothing was changed.\n'); return 1; }
      } else {
        const a = (await ask('  The copies differ. To run the other project\'s variant anyway, type exactly "share different copy": ')).trim();
        if (a !== 'share different copy') { process.stdout.write('  not confirmed — stopping; nothing was changed.\n'); return 1; }
      }
    }
    marketplaceReady = true; sharedRealCopy = true;
  } else if (row.state === 'elsewhere') {
    const where = row.realPath
      ? `${row.sourcePath}${row.symlinked ? ` (resolves to ${row.realPath})` : ''}`
      : `${row.sourcePath || '(no local path)'} (a ${row.source || 'non-directory'} source)`;
    const msg = `Marketplace "${MARKETPLACE_NAME}" is already registered at a DIFFERENT folder (it still exists):\n` +
      `    registered:     ${where}\n` +
      `    this installer: ${MARKETPLACE_SOURCE}\n` +
      '  Re-pointing makes EVERY project on this machine that uses this marketplace run the code in this installer\'s folder.\n' +
      '  It also deletes every project\'s install record + plugin data for it; re-adding restores loading, but they need re-installing.\n';
    if (!opts.repoint) {
      if (opts.quiet) {
        process.stderr.write('error: ' + msg + '  Not re-pointing without your say-so. Re-run with --repoint to do it, or without --quiet to be asked.\n');
        return 1;
      }
      process.stdout.write('\n⚠ ' + msg);
      // ONE confirmation covers the whole re-point: the remove + add below AND the plugin install that follows.
      const a = (await ask('  Re-point the marketplace to this installer\'s folder (remove + add + reinstall the plugin here)? [y/N] ')).trim().toLowerCase();
      if (a !== 'y' && a !== 'yes') {
        process.stdout.write('  declined — leaving the marketplace registry alone; nothing was changed.\n');
        return 1;
      }
    } else {
      process.stdout.write('\n⚠ ' + msg + '  --repoint given — proceeding.\n');
    }
    repointConfirmed = true;
  }
  const healed = row.state === 'dead' || (row.state === 'elsewhere' && !sharedRealCopy); // a guarded re-point runs first as step 3a
  if (healed) {
    // The elsewhere path was just explicitly confirmed (or --repoint) — don't re-ask per command.
    const rHeal = await doStep(opts, {
      already: false,
      preApproved: repointConfirmed,
      describe: stepHeader('3a', 5, row.state === 'dead' ? 'Re-point the marketplace (remove the row whose folder is gone)' : 'Re-point the marketplace (remove the row at the other folder)'),
      command: displayCommand('claude', ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]),
      edit: "this machine's Claude Code marketplace registry",
      what: `Removes the "${MARKETPLACE_NAME}" row so it can be re-added from this installer's folder.`,
      bin: 'claude', argv: ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME], cwd: targetDir,
      verify: () => !marketplaceRegistered(targetDir),
    });
    if (!rHeal.ok) return 1;
    marketplaceReady = false; // removed → the add below must run
  }
  const r3 = sharedRealCopy ? { ok: true, skipped: true } : await doStep(opts, {
    already: marketplaceReady,
    preApproved: repointConfirmed,
    describe: stepHeader(healed ? '3b' : 3, 5, 'Register the marketplace'),
    command: displayCommand('claude', ['plugin', 'marketplace', 'add', MARKETPLACE_SOURCE]),
    edit: "this machine's Claude Code marketplace registry, user scope",
    what: `Makes this bundle folder installable as marketplace "${MARKETPLACE_NAME}".`,
    bin: 'claude', argv: ['plugin', 'marketplace', 'add', MARKETPLACE_SOURCE], cwd: targetDir,
    verify: () => marketplaceRow(targetDir).state === 'same',
  });
  if (!r3.ok) return 1;

  // Step 4 — plugin install (usually also enables it for this project — see step 5). A plugin RECORD that
  // exists but whose cache dir is gone (cache-miss / "version registered but it's not there") is NOT
  // "already done" — require the cache present so a broken record triggers a reinstall rather than a skip.
  const p4 = pluginState(targetDir);
  const cache4 = p4.installed ? pluginCacheHealth(targetDir) : { present: null };
  const alreadyInstalled = p4.installed && cache4.present !== false;
  _dbg('step 4: installed=' + p4.installed + ' enabled=' + p4.enabled + ' cachePresent=' + cache4.present + ' → already=' + alreadyInstalled);
  const r4 = await doStep(opts, {
    already: alreadyInstalled,
    preApproved: repointConfirmed,
    describe: stepHeader(4, 5, 'Install the plugin'),
    command: displayCommand('claude', ['plugin', 'install', PLUGIN_ID, '--scope', 'project'].concat(opts.quiet ? ['-y'] : [])),
    what: `Installs ${PLUGIN_ID} for this project; this usually enables it too.`,
    bin: 'claude', argv: ['plugin', 'install', PLUGIN_ID, '--scope', 'project'].concat(opts.quiet ? ['-y'] : []), cwd: targetDir,
    verify: () => pluginState(targetDir).installed && pluginCacheHealth(targetDir).present !== false,
  });
  if (!r4.ok) return 1;

  // Step 5 — project enablement. Only a real action when step 4 left it installed-but-disabled;
  // an already-enabled plugin (enabled:true) is a skip, not an error. Probe FROM targetDir — `enabled`
  // is cwd-relative, so a probe from anywhere else misreads it (the false-exit-1 re-enable bug).
  const afterInstall = pluginState(targetDir);
  const needsEnable = afterInstall.installed && !afterInstall.enabled;
  _dbg('step 5: installed=' + afterInstall.installed + ' enabled=' + afterInstall.enabled + ' → needsEnable=' + needsEnable);
  const r5 = await doStep(opts, {
    already: !needsEnable,
    preApproved: repointConfirmed,
    describe: stepHeader(5, 5, 'Enable the plugin for this project'),
    command: displayCommand('claude', ['plugin', 'enable', PLUGIN_ID, '--scope', 'project']),
    what: 'Turns the plugin on here; only needed when step 4 left it installed but disabled.',
    bin: 'claude', argv: ['plugin', 'enable', PLUGIN_ID, '--scope', 'project'], cwd: targetDir,
    verify: () => pluginState(targetDir).enabled,
  });
  if (!r5.ok) return 1;

  // Final verification — run the read-only doctor over the END STATE so a broken result (a dead-source
  // marketplace, a cache-miss, a malformed config) is surfaced deterministically rather than assumed. The
  // steps above act; this confirms the acted-on state is actually healthy.
  process.stdout.write('\nFinal check · doctor\n');
  const checkCode = runCheck(targetDir, process.env);
  if (checkCode !== 0) {
    process.stderr.write('\n✗ the install steps ran, but the final doctor found problems (see the ✗ rows above).\n');
    return 1;
  }
  process.stdout.write(`\n✓ claude-tpm is installed and enabled (${PLUGIN_ID}) for ${targetDir} — doctor clean.\n`);
  return 0;
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

function printHelp() {
  const src = fs.readFileSync(__filename, 'utf8');
  const m = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (m) process.stdout.write(m[1].split('\n').map((l) => l.replace(/^ \*\s?/, '')).join('\n').trim() + '\n');
}

function parseArgs(argv) {
  const a = { dir: null, from: null, quiet: false, force: false, check: false, debug: false, repoint: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i];
    if (x === '-h' || x === '--help') a.help = true;
    else if (x === '--quiet') a.quiet = true;
    else if (x === '--force') a.force = true;
    else if (x === '--check') a.check = true;
    else if (x === '--debug') a.debug = true;
    else if (x === '--repoint') a.repoint = true;
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
  _dbg = makeDbg(debugEnabled(opts)); // enable the operation trace before any spawn/probe happens
  if (opts.help) { printHelp(); process.exit(0); }
  const targetDir = path.resolve(opts.dir);
  if (opts.check) { process.exit(runCheck(targetDir)); }
  const code = await runInstall(opts);
  closePrompter(); // release the shared readline (a no-op when nothing prompted, e.g. --quiet)
  process.exit(code);
}

if (require.main === module) {
  main().catch((err) => { process.stderr.write(`tpm-consumer-install: ${err.message}\n`); process.exit(1); });
}

module.exports = {
  main, runInstall, runCheck, parseArgs, doDependencyStep, closePrompter, findBundleRoot, defaultFromSpec,
  shellQuote, displayCommand, makeDbg, debugEnabled, formatChildExit, classifySpawn, spawnErrorReason, preflightMessage,
  readBundleIdentity, manifestVersionStamp,
  readPackageJson, hasTpmDependency, nodeModulesHasTpm, claudeCliAvailable, commandAvailable,
  marketplaceRegistered, pluginState, parsePluginList,
  realCopyInfo, hashTree, compareCopies, realCopyMessage, parseMarketplaceList, marketplaceSourceHealth, classifyMarketplaceRow, marketplaceRow, realOrResolved, recordMatches, parsePluginInstallPath, pluginCacheHealth,
  parseHooksManifest, bundleHooksHealth, bundleHooksHealthAt, configJsonValidity,
  settingsEnabledPlugins, claudeTpmEnabledIds, bundleVersion, findOnPath, checkTpmOnPath, checkTpmHomeVsSelf,
  ensureConsumerConfig, seedConfigDefaults,
  TPM_PKG_NAME, MARKETPLACE_NAME, PLUGIN_NAME, PLUGIN_ID, MARKETPLACE_SOURCE,
};
