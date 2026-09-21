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
 *        regular (`--save`) vs optional (`--save-optional`, the default), then confirm the exact npm
 *        command before running. Declining the first question skips the dep entirely (marketplace +
 *        plugin steps still run). Skipped as "already done" when the dep is already declared AND present
 *        in node_modules (unless --force). --quiet/-y never prompts: records it as optional (unchanged).
 *     3. marketplace — `claude plugin marketplace add ./node_modules/@codercowboy/claude-tpm
 *        --scope project` if not already registered.
 *     4. plugin install — `claude plugin install claude-tpm@claude-tpm-market --scope project`
 *        (installing usually also enables — see step 5).
 *     5. project enablement — `claude plugin enable claude-tpm@claude-tpm-market --scope project`,
 *        ONLY if the plugin is installed but currently disabled for this project (step 4 usually
 *        already leaves it enabled).
 *   Deliberately NOT handled here: writing env.TPM_HOME or hooks into any settings.json. The plugin
 *   delivers its hooks itself, via the bundle-root hooks/hooks.json (auto-discovered on plugin enable
 *   — confirmed firing end-to-end, session 013), and env.TPM_HOME is retired (zero consumers: skills
 *   call `npx tpm …` and %TPM_HOME% is resolved anchor-first via `npx tpm resolve-home`, not a hook).
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
 *     --debug          operation trace to STDOUT, prefixed `[tpm-debug]` (a `set -x`-style log): narrate
 *                      every child spawn (bin/argv/cwd → status/signal/elapsed-ms), every `claude … --json`
 *                      probe, and each step decision (already/marketplaceReady/needsEnable + its inputs).
 *                      Also enabled by the TPM_DEBUG=1 env var. Diagnostic ONLY — changes no install
 *                      behavior; the abnormal-exit signal name is surfaced even without it.
 *     --check          read-only: run every state check, print a PASS/FAIL checklist, change nothing.
 *                      Exits non-zero if anything is missing. (The consumer "doctor".) Checks:
 *                      package.json valid · tpm dep declared · marketplace registered · marketplace
 *                      SOURCE resolves (catches a registration whose source path is gone — "points at
 *                      the wrong place") · plugin installed · plugin enabled for the project · plugin
 *                      CACHE present (catches an installed record whose cache dir is gone — "registered
 *                      but not there" / cache-miss) · the bundle delivers its hook (gate-spawn
 *                      PreToolUse) · any consumer config.json parses as JSON. (There
 *                      is NO env.TPM_HOME / settings.json hook wiring to check — the plugin delivers the
 *                      hook itself; env.TPM_HOME is retired.) A normal install runs this same doctor as
 *                      a final step, and SELF-HEALS a dead-source marketplace (removes + re-adds it).
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
  const result = { gateSpawn: false };
  if (!manifest || typeof manifest !== 'object' || !manifest.hooks) return result;
  const scan = (groups, pred) => {
    if (!Array.isArray(groups)) return;
    for (const group of groups) {
      const hooks = group && Array.isArray(group.hooks) ? group.hooks : [];
      for (const h of hooks) pred(h && typeof h.command === 'string' ? h.command : '');
    }
  };
  scan(manifest.hooks.PreToolUse, (cmd) => { if (/hooks\s+gate-spawn/.test(cmd)) result.gateSpawn = true; });
  return result;
}

// Reader: locate + parse the delivered bundle's hooks/hooks.json inside the target's node_modules.
// present:false ⇒ the manifest file isn't there (dep not installed yet, or a pre-hooks bundle) — the
// check row degrades to a skip rather than a hard fail when node_modules has no bundle.
function bundleHooksHealth(targetDir) {
  const p = path.join(targetDir, 'node_modules', TPM_PKG_NAME, 'hooks', 'hooks.json');
  if (!fs.existsSync(p)) return { present: false, error: null, gateSpawn: false };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return { present: true, error: e.message, gateSpawn: false }; }
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

// ── plugin CACHE health (the "version registered but it's not there" shape) ─────────────────────────────
// `claude plugin list --json` can report an installed-plugin RECORD whose cached copy under
// ~/.claude/plugins/cache/ is gone ("failed to load: cache-miss" in the human list). pluginState().installed
// is true for such a record, so a name-only "installed?" check misses it. This verifies the record's
// installPath cache dir exists on disk. Split pure-parse / disk-read.
//
// Pure: given parsed `plugin list --json`, return OUR project-scope entry's installPath (the cache dir),
// or null when there's no such entry / it reports no installPath.
function parsePluginInstallPath(list) {
  if (!Array.isArray(list)) return null;
  const entry = list.find((e) => e && typeof e === 'object' && e.id === PLUGIN_ID &&
    (e.scope === undefined || e.scope === 'project'));
  return entry && typeof entry.installPath === 'string' ? entry.installPath : null;
}

// Reader: does the installed plugin record's cached copy exist on disk?
//   present:true  → installPath reported AND exists (healthy)
//   present:false → installPath reported but the cache dir is GONE (the cache-miss shape)
//   present:null  → no installPath reported (nothing to check — e.g. no record, or schema drift)
function pluginCacheHealth(cwd) {
  const installPath = parsePluginInstallPath(runClaudeJson(['plugin', 'list', '--json'], cwd));
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
//   2) regular vs optional? — 1 → --save (dependencies); 2 or bare-enter → --save-optional
//      (optionalDependencies). Default 2 preserves today's behavior + the "won't break the host's own
//      `npm install` if the bundle is absent" safety.
//   3) confirm the exact command before running.
// --quiet / -y (non-interactive) NEVER prompts: it records the dep as OPTIONAL, exactly as the old
// unconditional `--save-optional` did (keeps all headless/automated installs + test harnesses working).
async function doDependencyStep(opts, step) {
  const { already, describe, targetDir, fromSpec } = step;
  if (already && !opts.force) {
    process.stdout.write(`✓ ${describe} — already done, skipping.\n`);
    return { ok: true, skipped: true };
  }
  process.stdout.write(`\n${describe}\n`);

  let saveFlag = '--save-optional';
  let bucket = 'optionalDependencies';
  if (!opts.quiet) {
    const add = (await ask(`  Install ${TPM_PKG_NAME} into this project's package.json via npm? (y/n) `)).trim().toLowerCase();
    if (add !== 'y' && add !== 'yes') {
      process.stdout.write(`  skipped — NOT recording ${TPM_PKG_NAME} in package.json.\n`);
      process.stdout.write('           (the marketplace + plugin steps still run; `npx tpm …` just won\'t\n');
      process.stdout.write('           resolve locally from this project — a legitimate choice.)\n');
      return { ok: true, skippedDep: true };
    }
    const kind = (await ask('  Record it as a (1) regular dependency or (2) optional dependency? [default 2] ')).trim();
    if (kind === '1') { saveFlag = '--save'; bucket = 'dependencies'; }
  }

  const command = `npm install ${fromSpec} ${saveFlag}`;
  process.stdout.write(`  command: ${command}\n`);
  process.stdout.write(`  edits:   ${path.join(targetDir, 'package.json')} (${bucket}) + its lockfile + node_modules/${TPM_PKG_NAME}\n`);
  process.stdout.write(`  does:    Adds "${TPM_PKG_NAME}": "${fromSpec}" to ${bucket}, updates the lockfile, and\n`);
  process.stdout.write(`           creates the node_modules/${TPM_PKG_NAME} symlink/copy that step 3 points the marketplace at.\n`);

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

function runCheck(targetDir) {
  const rows = [];
  const pkgRead = readPackageJson(targetDir);
  rows.push({ label: 'package.json exists', pass: pkgRead.exists && !pkgRead.error,
    note: pkgRead.error ? `(invalid JSON: ${pkgRead.error})` : '' });

  const depOk = pkgRead.exists && !pkgRead.error && hasTpmDependency(pkgRead.value);
  rows.push({ label: `"${TPM_PKG_NAME}" declared as a dependency`, pass: !!depOk,
    note: (pkgRead.exists && !pkgRead.error) ? '' : '(skipped — no valid package.json)' });

  const claudeOk = claudeCliAvailable().ok;
  const marketOk = claudeOk && marketplaceRegistered(targetDir);
  rows.push({ label: `marketplace "${MARKETPLACE_NAME}" registered`, pass: marketOk,
    note: claudeOk ? '' : '(`claude` CLI not found on PATH)' });

  // Marketplace SOURCE resolves — a registration can exist by name while its source path is gone (the
  // "points at the wrong place" / dead-source shape). Only meaningful once it's registered.
  const mHealth = marketOk ? marketplaceSourceHealth(targetDir) : { resolves: true, sourcePath: null };
  rows.push({ label: `marketplace "${MARKETPLACE_NAME}" source resolves`, pass: !marketOk ? true : mHealth.resolves,
    note: !claudeOk ? '(skipped — `claude` CLI not found on PATH)'
      : !marketOk ? '(skipped — not registered)'
      : mHealth.resolves ? ''
      : `(source path missing: ${mHealth.sourcePath || 'unknown'} — re-run \`npx tpm install\` here; install self-repairs the stale marketplace)` });

  // Probe project-scope state FROM the target dir — enablement is cwd-relative (see runClaudeJson).
  const pstate = claudeOk ? pluginState(targetDir) : { installed: false, enabled: false };
  rows.push({ label: `plugin ${PLUGIN_ID} installed`, pass: pstate.installed,
    note: claudeOk ? '' : '(`claude` CLI not found on PATH)' });
  rows.push({ label: `plugin ${PLUGIN_ID} enabled for this project`, pass: pstate.installed && pstate.enabled,
    note: (claudeOk && !pstate.installed) ? '(skipped — not installed)' : '' });

  // Plugin CACHE present — an installed record can point at a cache dir that's gone (the "version
  // registered but it's not there" / cache-miss shape). FAIL only on a definitively-missing cache.
  const cacheH = (claudeOk && pstate.installed) ? pluginCacheHealth(targetDir) : { installPath: null, present: null };
  rows.push({ label: `plugin ${PLUGIN_ID} cache present (loads)`, pass: cacheH.present !== false,
    note: !claudeOk ? '(skipped — `claude` CLI not found on PATH)'
      : !pstate.installed ? '(skipped — not installed)'
      : cacheH.present === null ? '(skipped — no installPath reported)'
      : cacheH.present ? ''
      : `(cache missing: ${cacheH.installPath} — re-run \`npx tpm install\` here to reinstall the plugin)` });

  // Hooks-delivery health: the bundle in node_modules carries a hooks/hooks.json declaring both hooks.
  // Only meaningful once the dep is materialized in node_modules; otherwise skip (step 2 handles that).
  const nmHasTpm = nodeModulesHasTpm(targetDir);
  const hh = bundleHooksHealth(targetDir);
  const hooksNote = !nmHasTpm ? '(skipped — dependency not installed in node_modules)'
    : hh.error ? `(bundle hooks.json invalid JSON: ${hh.error})`
    : !hh.present ? '(bundle carries no hooks/hooks.json)'
    : !hh.gateSpawn ? '(missing: gate-spawn)'
      : '';
  rows.push({ label: 'plugin delivers its hook (gate-spawn PreToolUse)',
    pass: !nmHasTpm ? true : (hh.present && !hh.error && hh.gateSpawn), note: hooksNote });

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
  _dbg = makeDbg(debugEnabled(opts)); // idempotent — main() also sets it; covers a direct module call
  const targetDir = path.resolve(opts.dir);
  _dbg('resolved run: opts=' + JSON.stringify({ dir: opts.dir, from: opts.from, quiet: !!opts.quiet, force: !!opts.force, debug: !!opts.debug }));
  _dbg('resolved run: targetDir=' + targetDir + ' bundleRoot=' + findBundleRoot(__dirname));
  _dbg('tty: stdin.isTTY=' + !!process.stdin.isTTY + ' stdout.isTTY=' + !!process.stdout.isTTY);

  // Step 1/5 — preflight. Fail fast, per-prerequisite: `npm` on PATH, a package.json to write into, and
  // the `claude` CLI on PATH (a missing `claude` used to surface downstream as an unhelpful "exited null").
  // package.json is never created by this tool, in ANY mode (--force included) — authoring project identity
  // is the user's call, not ours; it's also load-bearing (step 2 needs it to exist).
  const npmProbe = commandAvailable('npm');
  if (!npmProbe.ok) {
    process.stderr.write('Step 1/5 — ✗ preflight failed\n');
    process.stderr.write('  error: ' + preflightMessage('npm', npmProbe, 'install Node.js/npm first.') + '\n');
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
  const claudeProbe = claudeCliAvailable();
  if (!claudeProbe.ok) {
    process.stderr.write('Step 1/5 — ✗ preflight failed\n');
    process.stderr.write('  error: ' + preflightMessage('claude', claudeProbe, 'install Claude Code first.') + '\n');
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
  _dbg('resolved run: fromSpec=' + fromSpec);
  const step2Already = hasTpmDependency(pkg) && nodeModulesHasTpm(targetDir);
  _dbg('step 2: hasDep=' + hasTpmDependency(pkg) + ' inNodeModules=' + nodeModulesHasTpm(targetDir) + ' → already=' + step2Already);
  const r2 = await doDependencyStep(opts, {
    already: step2Already,
    describe: 'Step 2/5 — add the claude-tpm dependency',
    targetDir, fromSpec,
  });
  if (!r2.ok) return 1;

  // Step 3 — marketplace registration. (marketplace add/remove take no -y flag; unaffected by --quiet.)
  // SELF-HEAL first: a marketplace registered by NAME whose source path no longer resolves (e.g. the
  // global singleton points at a deleted sibling consumer) would make step 3 "already done" → skip, and
  // step 4 then fails opaquely ("plugin not found in marketplace" / cache-miss). Detect that dead-source
  // shape and repair it (remove the stale registration so the add below re-registers against THIS project).
  const mHealth = marketplaceSourceHealth(targetDir);
  let marketplaceReady = mHealth.registered && mHealth.resolves;
  _dbg('step 3: registered=' + mHealth.registered + ' resolves=' + mHealth.resolves + ' source=' + mHealth.source + ' path=' + mHealth.sourcePath + ' → marketplaceReady=' + marketplaceReady);
  if (mHealth.registered && !mHealth.resolves) {
    _dbg('step 3: dead-source marketplace detected → repairing (remove stale registration first)');
    const rHeal = await doStep(opts, {
      already: false,
      describe: 'Step 3/5 — repair: remove the STALE claude-tpm marketplace (its source no longer resolves)',
      command: `claude plugin marketplace remove ${MARKETPLACE_NAME}`,
      edit: "this machine's Claude Code marketplace registry",
      what: `Marketplace "${MARKETPLACE_NAME}" is registered but its source (${mHealth.sourcePath || 'unknown'})\n` +
        '           is gone — removing the dead registration so it can be re-added against this project below.',
      bin: 'claude', argv: ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME], cwd: targetDir,
      verify: () => !marketplaceRegistered(targetDir),
    });
    if (!rHeal.ok) return 1;
    marketplaceReady = false; // removed → the add below must run
  }
  const r3 = await doStep(opts, {
    already: marketplaceReady,
    describe: 'Step 3/5 — register the claude-tpm marketplace',
    command: `claude plugin marketplace add ${MARKETPLACE_SOURCE} --scope project`,
    edit: "this project's Claude Code settings (project scope)",
    what: `Trusts/registers ${MARKETPLACE_SOURCE} as marketplace "${MARKETPLACE_NAME}" so its plugin becomes installable.`,
    bin: 'claude', argv: ['plugin', 'marketplace', 'add', MARKETPLACE_SOURCE, '--scope', 'project'], cwd: targetDir,
    verify: () => marketplaceRegistered(targetDir) && marketplaceSourceHealth(targetDir).resolves,
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
    describe: 'Step 4/5 — install the claude-tpm plugin',
    command: `claude plugin install ${PLUGIN_ID} --scope project${opts.quiet ? ' -y' : ''}`,
    edit: "~/.claude/plugins/ (global cache) + this project's plugin registry (project scope)",
    what: `Installs ${PLUGIN_ID} and, in the common case, enables it for this project in the same step.`,
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
    describe: 'Step 5/5 — enable the plugin for this project',
    command: `claude plugin enable ${PLUGIN_ID} --scope project`,
    edit: "this project's Claude Code plugin registry (project scope)",
    what: `Flips ${PLUGIN_ID} on for this project. Step 4 usually already leaves it enabled — this only\n` +
      '           runs a standalone enable when the plugin is installed but currently disabled here.',
    bin: 'claude', argv: ['plugin', 'enable', PLUGIN_ID, '--scope', 'project'], cwd: targetDir,
    verify: () => pluginState(targetDir).enabled,
  });
  if (!r5.ok) return 1;

  // Final verification — run the read-only doctor over the END STATE so a broken result (a dead-source
  // marketplace, a cache-miss, a malformed config) is surfaced deterministically rather than assumed. The
  // steps above act; this confirms the acted-on state is actually healthy.
  process.stdout.write('\nFinal check — doctor (verifying the end state):\n');
  const checkCode = runCheck(targetDir);
  if (checkCode !== 0) {
    process.stderr.write('\n✗ the install steps ran, but the final doctor found problems (see the FAIL rows above).\n');
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
  const a = { dir: null, from: null, quiet: false, force: false, check: false, debug: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i];
    if (x === '-h' || x === '--help') a.help = true;
    else if (x === '--quiet') a.quiet = true;
    else if (x === '--force') a.force = true;
    else if (x === '--check') a.check = true;
    else if (x === '--debug') a.debug = true;
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
  makeDbg, debugEnabled, formatChildExit, classifySpawn, spawnErrorReason, preflightMessage,
  readPackageJson, hasTpmDependency, nodeModulesHasTpm, claudeCliAvailable, commandAvailable,
  marketplaceRegistered, pluginState, parsePluginList,
  parseMarketplaceList, marketplaceSourceHealth, parsePluginInstallPath, pluginCacheHealth,
  parseHooksManifest, bundleHooksHealth, configJsonValidity,
  TPM_PKG_NAME, MARKETPLACE_NAME, PLUGIN_NAME, PLUGIN_ID, MARKETPLACE_SOURCE,
};
