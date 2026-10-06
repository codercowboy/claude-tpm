#!/usr/bin/env node
/**
 * tpm-consumer-install.js — `tpm install`: graft claude-tpm onto an EXISTING consumer project, as a STATE
 * RECONCILER. (Rewritten in the installer-updates epic, phase 02; design: dev/20261001-installer-updates/
 * installer-design.md, voice: installer-repl-voice.md. The old 5-step command runner is gone.)
 *
 * PIPELINE (design §4):  parseArgs → observe → preconditions → diagnose → [decide] → plan → confirm →
 *                        apply (+ per-action verify) → observe → closing
 *   observe        tpm-consumer-observe.js — ONE shared, pure observer (5 layers + env). Imported, never copied.
 *   preconditions  O.preconditions — refusals before any plan (npm/claude, package.json, stamp, other-project
 *                  copy, incomplete folder, non-TTY). `--plan` never prompts, so it needs no terminal.
 *   diagnose       exactly one of 7 labels, first match wins (registered-elsewhere · not-installed · upgrade ·
 *                  broken · partial · healthy · healthy-with-warnings) + the ⚠/✗ findings that justify it.
 *   decide         ONLY for registered-elsewhere: the `use / re-point / quit` menu (--share ⇒ use, --repoint ⇒
 *                  re-point, --quiet with neither ⇒ refusal). The compare line (hashTree/compareCopies) lives
 *                  here and nowhere else (N7, O3 keep).
 *   plan           the diff between observed and target as an ordered list of actions (design §6):
 *                  repoint → register → dep → plugin-install → plugin-enable → disable-old → config-seed.
 *                  Pure; `--plan` prints it and exits 0.
 *   confirm        ONE `Proceed? [y/N]` (default no). Nothing has been written before it (observe is pure).
 *   apply          sequential; after each action the ONE layer it touched is re-observed and its postcondition
 *                  checked. A non-zero exit OR a failed check stops the run: `Stopped after N of M`, exit 1.
 *                  There is no `--force`: an action only runs when needed() said it was missing, so an "already
 *                  exists" from a CLI is a real disagreement worth stopping on (U4/N4). Re-running plans exactly
 *                  the remainder.
 *   closing        full re-observe, the ⚠/✗ rows, one verdict line, one `Next:` line. Exit 0 iff no ✗.
 *
 * FLAGS:  [dir] | --dir <path> · --plan · --quiet · --save · --from <spec> · --repoint · --share · --debug
 *         (TPM_DEBUG=1) · -h/--help · --check (compat alias of `tpm doctor`, now tpm-consumer-doctor.js)
 *         · --verbose (doctor) · --fix-version-mismatch (re-derive this bundle's version labels from its
 *         package.json via tools/build/stamp-manifests.js when the `stamp` precondition would refuse, then
 *         continue — the ONLY path on which the installer writes to its own folder; see runInstall).
 *         `--force` and `-y` are gone: an unknown token exits 2.
 *
 * USER-FACING WORDS: every string the user reads is built by tpm-consumer-voice.js. The only strings authored
 * here are the `comparing the two copies …` line and the "Claude Code did not report its state" refusal; both
 * are checked against the voice never-print list in the tests. Never-print scope (voice `findNeverPrint`):
 * `$ command` lines and backticked `claude|npm|npx|tpm|node …` spans are exempt (users may see exactly what
 * runs). The install tests apply a STRICTER check than voice's: a backticked span is exempt only if it matches
 * a known command shape, and only the child's verbatim stderr under a ✗ line is exempt besides.
 *
 * RETAINED HELPERS (top of the file): only what the reconciler itself uses — the identity constants, the --debug writer,
 * the stdin prompter, shellQuote/displayCommand, hashTree/compareCopies, and the config.json seed. Every detector
 * lives in tpm-consumer-observe.js; `tpm doctor` is tpm-consumer-doctor.js; the old pre-rewrite helpers (LEGACY block)
 * were retired in phase 04.
 *
 * CONVENTIONS: zero runtime deps (Node built-ins only), portable (`node …/tpm-consumer-install.js`), also a
 * module (module.exports) so tests can drive diagnose/plan/apply directly. Tests: tools/consumer/tests/
 * tpm-consumer-install/ (test.js = the pipeline; test-legacy-helpers.js = the retained helpers + the retired-helper guard).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const O = require('./tpm-consumer-observe');
const V = require('./tpm-consumer-voice');
const STAMP = require('../build/stamp-manifests'); // shared re-stamp op for the --fix-version-mismatch escape hatch

// ── identity: READ from this bundle's own .claude-plugin/marketplace.json via the shared observer (so the installer
// and the manifest can never disagree; the marketplace name is version-scoped there, e.g. claude-tpm-market-0.2.0).
const TPM_PKG_NAME = O.TPM_PKG_NAME;
const findBundleRoot = O.findBundleRoot;
const realOrResolved = O.realOrResolved;
const _ident = O.readBundleIdentity(O.findBundleRoot(__dirname));
const MARKETPLACE_NAME = _ident.marketplace;
const PLUGIN_NAME = _ident.plugin;
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
const BUNDLE_ROOT = O.findBundleRoot(__dirname);
const MARKETPLACE_SOURCE = BUNDLE_ROOT ? realOrResolved(BUNDLE_ROOT) : null;

// ── operation-trace (--debug / TPM_DEBUG) ────────────────────────────────────────────────────────────
// A `set -x`-style trace to STDOUT. Instrumentation ONLY. The writer is a module-level singleton so helpers
// without opts in scope can call it.
let _dbg = () => {};
function makeDbg(enabled) {
  if (!enabled) return () => {};
  return (...parts) => { process.stdout.write('[tpm-debug] ' + parts.filter((p) => p !== '' && p != null).join(' ') + '\n'); };
}
// True when --debug was passed OR TPM_DEBUG is set to a non-empty value.
function debugEnabled(opts) { return !!(opts && opts.debug) || !!process.env.TPM_DEBUG; }


// ── consumer config.json seed (#1132.C) ──────────────────────────────────────────────────────────────
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

// ── content comparison of two claude-tpm copies (the `comparing the two copies …` line) ───────────────
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

// ── one shared stdin prompter + display helpers ──────────────────────────────────────────────────────
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

// ════════ END RETAINED HELPERS ════════

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// THE RECONCILER (design §4) — parseArgs → observe → preconditions → diagnose → [decide] → plan → confirm →
// apply → observe → closing. Everything below imports the shared observer + voice (never re-detects).
// ══════════════════════════════════════════════════════════════════════════════════════════════════════

const ACTION_ORDER = ['repoint', 'register', 'dep', 'plugin-install', 'plugin-enable', 'disable-old', 'config-seed'];
const LABELS = ['registered-elsewhere', 'not-installed', 'upgrade', 'broken', 'partial', 'healthy', 'healthy-with-warnings'];

// Shown when `claude` is installed but would not report its own state (so any plan would be a guess).
const UNKNOWN_STATE_REFUSAL = 'error: not installing — Claude Code is installed but did not report what it has set up (`claude plugin list` failed).\n' +
  '  Try `claude plugin list` yourself; once it works, re-run.\n' + V.NOTHING_CHANGED + '\n';
const COMPARING_LINE = '  comparing the two copies …';

// ── io: everything the pipeline touches outside the filesystem, injectable for tests ───────────────────

function defaultIo() {
  return {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    ask,
    env: process.env,
    stdinIsTTY: !!process.stdin.isTTY,
    self: null, // → observe locates its own claude-tpm folder
    exec: null, // → real spawnSync
  };
}

function realExec(bin, argv, cwd, env) {
  return require('child_process').spawnSync(bin, argv, { encoding: 'utf8', cwd, env, timeout: 600000 });
}

/** exec with the --debug trace; shared by observe's probes and by apply so one flag narrates everything. */
function makeExec(io, dbg) {
  const base = io.exec || realExec;
  return (bin, argv, cwd, env) => {
    dbg('→ spawn:', bin, argv.join(' '), '(cwd=' + cwd + ')');
    const t0 = Date.now();
    const r = base(bin, argv, cwd, env);
    dbg('←', r && r.error ? 'error=' + (r.error.code || 'ESPAWN') : 'status=' + (r ? r.status : '?'), `(${Date.now() - t0}ms)`);
    return r;
  };
}

// ── display helpers ──────────────────────────────────────────────────────────────────────────────────

/** A path as shown inside a `$ command` line: `~`-shortened only when that stays copy-pasteable unquoted. */
function showPath(p) {
  const t = V.tilde(p);
  return t !== p && /^[A-Za-z0-9_@%+=:,./~-]+$/.test(t) ? t : p;
}
function depSpec(state, target, opts) {
  if (opts && opts.from) return opts.from;
  let rel = path.relative(state.target.real, target);
  if (rel === '') rel = '.';
  else if (!rel.startsWith('.') && !path.isAbsolute(rel)) rel = './' + rel;
  return `file:${rel}`;
}
function bucketFlag(bucket) {
  return bucket === 'dependencies' ? '--save' : bucket === 'optionalDependencies' ? '--save-optional' : '--save-dev';
}

// ── diagnose (§4.3) ──────────────────────────────────────────────────────────────────────────────────

/** The four project-facing rows (layers 1–4) with a non-pass mark: the findings printed under "Checking …". */
function layerRows(state) {
  return [V.rowPackageJson(state), V.rowRegistered(state), V.rowTurnedOn(state), V.rowProjectFolder(state)];
}

/** Nothing of claude-tpm is in this project at all (no dependency, no turned-on plugin, no marker). */
function nothingHere(state) {
  const rec = state.en.record;
  // in vendored mode the dependency IS this installer's own copy (how we got here), so it is not "something installed"
  const depEmpty = state.canonical.mode === 'vendored' || (!state.dep.declared && state.dep.onDisk === 'absent');
  return depEmpty && !(rec && rec.present) && !state.en.enabledHere &&
    state.en.otherIds.length === 0 && !state.marker.dir && state.marker.config === 'absent';
}

/** A real breakage (vs. merely incomplete): dead folder, dangling link, bad config, lost cache path, set-up missing while on. */
function isBroken(state) {
  const rec = state.en.record;
  const on = state.en.enabledHere || (rec && rec.present);
  return state.reg.state === 'dead' || state.dep.onDisk === 'dangling' || state.marker.config === 'invalid' ||
    !!(rec && rec.present && rec.installPathExists === false) || (!state.marker.dir && !!on);
}

/** The version being upgraded FROM: a different dependency version first, else the first other enabled version. */
function oldVersionOf(state) {
  const dv = state.dep.version;
  if (dv && state.self.version && dv !== state.self.version) return dv;
  const ov = state.en.otherVersions[0];
  return (ov && ov.version) || dv || state.projectVersion || null;
}

/**
 * diagnose(state, opts) → {label, sentence, findings[], rows, ctx, actions}. `actions` is the plan the label was
 * judged against (for a registered-elsewhere state it is the provisional default-canonical plan; the real plan is
 * rebuilt after the decision). One label, first match wins, precedence = design §4.3.
 */
function diagnose(state, opts) {
  const o = opts || {};
  const rows = V.doctorRows(state);
  const lrows = layerRows(state);
  const findings = lrows.filter((r) => r.mark === 'warn' || r.mark === 'fail').map((r) => ({ mark: r.mark, text: r.text, row: r }));
  const ctx = { oldVersion: oldVersionOf(state), checks: rows.filter((r) => r.mark === 'pass').length,
    warnings: rows.filter((r) => r.mark === 'warn').length };
  const p = plan(state, Object.assign({}, o, { choice: null }));
  let label;
  if (state.reg.state === 'elsewhere' || state.reg.state === 'github') {
    // Already set up to run that folder (a previous `use`)? Then there is nothing to ask or do: the registered-from
    // ⚠ row stays as a warning (fix: --repoint) instead of re-asking the menu on every run.
    const settled = plan(state, Object.assign({}, o, { choice: 'use' })).actions.length === 0 && !lrows.some((r) => r.mark === 'fail');
    label = settled ? 'healthy-with-warnings' : 'registered-elsewhere';
  } else if (nothingHere(state)) label = 'not-installed';
  else if (state.en.otherIds.length || (state.dep.version && state.self.version && state.dep.version !== state.self.version)) label = 'upgrade';
  else if (isBroken(state)) label = 'broken';
  else if (p.actions.length) label = 'partial';
  else if (lrows.some((r) => r.mark === 'fail')) label = 'broken';
  else label = findings.length ? 'healthy-with-warnings' : 'healthy';
  return { label, sentence: V.diagnosisSentence(label, state, ctx), findings: label === 'not-installed' ? [] : findings, rows, ctx, actions: p.actions };
}

// ── decide (§4.4 / §5) ───────────────────────────────────────────────────────────────────────────────

/** The compare line for the menu (O3: kept, lazily, only here). */
function compareLine(state) {
  const c = compareCopies(state.reg.realPath, state.self.root);
  const same = state.reg.version && state.reg.version === state.self.version;
  const lead = same ? 'same version, ' : `${state.reg.version || 'another version'} vs ${state.self.version}, `;
  if (c.verdict === 'identical') return `${lead}identical files`;
  if (c.verdict === 'differs') return `${lead}${c.count} ${c.count === 1 ? 'file differs' : 'files differ'}`;
  return "couldn't compare";
}

/**
 * decide(state, opts, io) → Promise<{choice:'use'|'repoint'} | {exit:code}>. Fires only for registered-elsewhere.
 * --share ⇒ use · --repoint ⇒ re-point · --quiet with neither ⇒ refusal · else the 1/2/3 menu (Enter = quit).
 */
async function decide(state, opts, io) {
  const pre = opts.share ? 'use' : opts.repoint ? 're-point' : null;
  if (pre) {
    io.out(V.decisionMenu(state, null).split('\n\n')[0] + '\n');
    return { choice: pre === 'use' ? 'use' : 'repoint' };
  }
  // no terminal to answer on (--quiet, or `--plan` piped): never read '' as "quit" — refuse and name the flags (S2)
  if (opts.quiet || !io.stdinIsTTY) { io.err(V.quietMenuRefusal(state)); return { exit: 1 }; }
  let cmp = null;
  if (state.reg.where !== 'github') { io.out(COMPARING_LINE + '\n'); cmp = compareLine(state); }
  io.out(V.decisionMenu(state, cmp) + '\n');
  const a = String(await io.ask(V.MENU_PROMPT)).trim();
  if (!io.stdinIsTTY) io.out('\n');
  if (a === '1') return { choice: 'use' };
  if (a === '2') return { choice: 'repoint' };
  io.out(V.NOTHING_CHANGED + '\n');
  return { exit: 1 };
}

// ── plan (§4.5 / §6) ─────────────────────────────────────────────────────────────────────────────────

/**
 * plan(state, opts) → {actions[], fine[], notTouched, warnings[], canonical, depTarget}. PURE. Walks the action
 * catalogue in fixed order and keeps each action whose needed(state) is true. opts.choice = 'use'|'repoint'|null
 * (the decision phase's answer). Each action: {id, commands[] (display), run[] ({bin,argv,cwd}) | null, verify
 * layer + predicate, variant/folder/oldVersion/saveDev/ownCopy (what voice reads)}.
 */
function plan(state, opts) {
  const o = opts || {};
  const s = state.self; const reg = state.reg; const en = state.en; const dep = state.dep; const mk = state.marker;
  const mode = state.canonical.mode; // linked | vendored
  const choice = o.choice || null;
  const target = state.target.dir;

  // canonical + the layer-1 target for this run (design §3 step B, N3)
  let canon = s.root;
  let depTarget = mode === 'linked' ? s.root : null;
  if (choice === 'use') {
    if (reg.state === 'github') { canon = null; depTarget = mode === 'linked' ? s.root : null; }
    else if (reg.state === 'elsewhere') {
      canon = reg.realPath;
      if (reg.where === 'standalone') depTarget = mode === 'linked' ? reg.realPath : null;
      else if (reg.where === 'this-project-copy') depTarget = null;
      else depTarget = mode === 'linked' ? s.root : null; // other-project-copy: never link into another project's node_modules
    }
  }
  // A registration classified `same-via-link` resolves back to THIS repo, but its STORED path is an
  // indirection. When that stored path lives inside a node_modules (an old installer registered a client's
  // vendored copy/symlink of us), the literal registry path is a project's node_modules, not the canonical
  // repo — so running from the repo must re-point it to the real folder, not treat it as a no-op. Scoped to
  // node_modules so an intentional symlink elsewhere is left alone; vendored mode (direct node_modules, state
  // `same`) never trips this. (session 0036: the same-via-link blind spot.)
  const staleNodeModulesLink = reg.state === 'same-via-link' && !!reg.storedPath && !!O.insideNodeModules(path.resolve(reg.storedPath));
  const repointing = reg.state === 'dead' || choice === 'repoint' || staleNodeModulesLink;
  const registering = reg.state === 'absent' && !repointing;
  const record = en.record;
  const installNeeded = !(record && record.present) || record.installPathExists === false || repointing; // a re-point wipes the install note (probe #11a)
  const enableNeeded = !installNeeded && !!(record && record.present && !record.enabled);
  const upgrade = en.otherIds.length > 0 || !!(dep.version && s.version && dep.version !== s.version);
  const oldVersion = oldVersionOf(state);
  const actions = [];

  if (repointing) {
    actions.push({ id: 'repoint', folder: s.root, newVersion: s.version, layer: 'registration', machineWide: true,
      variant: staleNodeModulesLink ? 'relink' : undefined,
      commands: [V.displayCommand('claude', ['plugin', 'marketplace', 'remove', s.name]), V.displayCommand('claude', ['plugin', 'marketplace', 'add', showPath(s.root)])],
      run: [{ bin: 'claude', argv: ['plugin', 'marketplace', 'remove', s.name], cwd: target }, { bin: 'claude', argv: ['plugin', 'marketplace', 'add', s.root], cwd: target }],
      verify: (st) => st.reg.state === 'same' || st.reg.state === 'same-via-link' });
  }
  if (registering) {
    actions.push({ id: 'register', folder: s.root, ownCopy: mode === 'vendored', layer: 'registration', machineWide: true,
      commands: [V.displayCommand('claude', ['plugin', 'marketplace', 'add', showPath(s.root)])],
      run: [{ bin: 'claude', argv: ['plugin', 'marketplace', 'add', s.root], cwd: target }],
      verify: (st) => st.reg.state === 'same' || st.reg.state === 'same-via-link' });
  }
  if (depTarget && (dep.onDisk !== 'link' || dep.linksTo !== depTarget || !dep.declared)) {
    const flag = o.save ? '--save' : dep.declared ? bucketFlag(dep.declared.bucket) : '--save-dev';
    const spec = depSpec(state, depTarget, o);
    const argv = ['install', spec, flag, '--no-fund', '--no-audit'];
    const variant = dep.onDisk === 'dangling' ? 'dangling' : (dep.declared && dep.version && s.version && dep.version !== s.version) ? 'upgrade' : undefined;
    actions.push({ id: 'dep', folder: depTarget, variant, oldVersion: dep.version ? dep.version : undefined, saveDev: flag === '--save-dev', layer: 'dep',
      commands: [V.displayCommand('npm', argv)],
      run: [{ bin: 'npm', argv, cwd: target }],
      verify: (st) => !!st.dep.declared && (o.from ? (st.dep.onDisk === 'link' || st.dep.onDisk === 'copy') : (st.dep.onDisk === 'link' && st.dep.linksTo === depTarget)) });
  }
  if (installNeeded) {
    const hasRec = !!(record && record.present);
    const variant = upgrade ? 'upgrade' : (en.loadsWithoutRecord || (en.enabledHere && !hasRec)) ? 'restore'
      : (hasRec && (record.installPathExists === false || repointing)) ? 'again' : undefined;
    const argv = ['plugin', 'install', s.id, '--scope', 'project'].concat(o.quiet ? ['-y'] : []);
    actions.push({ id: 'plugin-install', variant, newVersion: s.version, layer: 'enablement',
      commands: [V.displayCommand('claude', argv)], run: [{ bin: 'claude', argv, cwd: target }],
      verify: (st) => !!(st.en.record && st.en.record.present) });
  }
  if (enableNeeded) {
    const argv = ['plugin', 'enable', s.id, '--scope', 'project'];
    actions.push({ id: 'plugin-enable', layer: 'enablement', commands: [V.displayCommand('claude', argv)], run: [{ bin: 'claude', argv, cwd: target }],
      verify: (st) => !!(st.en.record && st.en.record.present && st.en.record.enabled) });
  }
  en.otherVersions.forEach((ov) => {
    const argv = ['plugin', 'disable', ov.id, '--scope', 'project'];
    actions.push({ id: 'disable-old', otherId: ov.id, oldVersion: ov.version || undefined, layer: 'enablement',
      commands: [V.displayCommand('claude', argv)], run: [{ bin: 'claude', argv, cwd: target }],
      verify: (st) => st.en.otherIds.indexOf(ov.id) < 0 });
  });
  if (!mk.dir || mk.config === 'absent') {
    actions.push({ id: 'config-seed', layer: 'marker', commands: [], run: null, verify: (st) => st.marker.config === 'valid' });
  }

  // extras around the numbered lines
  const fine = []; const warnings = [];
  if (actions.length) {
    if (!repointing && !registering && (reg.state === 'same' || reg.state === 'same-via-link')) fine.push(V.ALREADY_REGISTERED(state));
    const depAct = actions.find((a) => a.id === 'dep');
    if (depAct && !depAct.variant && !o.save && depAct.saveDev) fine.push('recorded as a dev dependency; pass --save for a regular one');
    if (mode === 'vendored' && (repointing || registering)) warnings.push(V.fragilityWarning());
    if (choice === 'use' && reg.state === 'elsewhere' && reg.where === 'other-project-copy') warnings.push(V.twoTreesWarning(state));
  }
  let notTouched = null;
  if (actions.length && upgrade) notTouched = V.notTouched(oldVersion);
  else if (actions.length && choice === 'use') notTouched = 'the existing registration and the other projects that use it.';

  return { actions, fine, notTouched, warnings, canonical: canon, depTarget, mode, upgrade, oldVersion };
}

function renderPlan(p, state) {
  return V.planBlock(p.actions, state, { fine: p.fine, notTouched: p.notTouched, warnings: p.warnings });
}

// ── apply (§4.7) ─────────────────────────────────────────────────────────────────────────────────────

function runSpec(spec, io, exec) {
  const r = exec(spec.bin, spec.argv, spec.cwd, io.env);
  const errorCode = r && r.error ? (r.error.code || 'ESPAWN') : null;
  const status = r && typeof r.status === 'number' ? r.status : null;
  return { ok: !errorCode && status === 0, status, errorCode, signal: r && r.signal || null, stderr: String((r && r.stderr) || (errorCode ? `${spec.bin}: ${errorCode}` : '')) };
}

/**
 * apply(state, actions, io, exec) → {state, done, failedAt, child}. Sequential; each action = run its command(s),
 * re-observe ONLY the layer it touched (N6), check its postcondition. A non-zero exit OR a failed verify stops the
 * run. There is no forgiveness for "already exists" (U4/N4): needed() said it was not there.
 */
function apply(state, actions, io, exec) {
  let st = state; let done = 0;
  for (let i = 0; i < actions.length; i += 1) {
    const a = actions[i];
    let child = { ok: true };
    if (a.id === 'config-seed') {
      try { ensureConsumerConfig(st.target.dir); } catch (e) { child = { ok: false, status: 1, stderr: e.message }; }
    } else {
      for (const spec of a.run) { child = runSpec(spec, io, exec); if (!child.ok) break; }
    }
    if (child.ok) {
      st = O.reobserveLayer(st, a.layer);
      if (!a.verify(st)) child = { ok: false, status: 0, stderr: `ran, but the result is not what was expected — ${a.id} did not take effect.` };
    }
    if (!child.ok) {
      io.out(V.applyFail(a, child) + '\n');
      return { state: st, done, failedAt: i, child };
    }
    io.out(V.applyOk(a, st) + '\n');
    done += 1;
  }
  return { state: st, done, failedAt: null, child: null };
}

// ── --fix-version-mismatch (the one sanctioned write to our OWN folder) ────────────────────────────────

/**
 * applyVersionFix(state, dbg) → { ok, text }. The `--fix-version-mismatch` escape hatch for the `stamp`
 * refusal: re-derive THIS claude-tpm folder's version labels from its own package.json (package.json is the
 * single source of truth) via the shared stamp-manifests op, so the mislabelled registration name / plugin
 * version come back into agreement. This is the ONLY path on which the installer writes to its own bundle —
 * it NEVER touches the consumer project. Idempotent: a folder already in sync reports so and changes nothing.
 */
function applyVersionFix(state, dbg) {
  const root = (state.self && state.self.root) || BUNDLE_ROOT;
  if (!root) return { ok: false, text: V.stampFixFailed('its folder could not be located') };
  try {
    (dbg || (() => {}))('fix-version-mismatch: re-deriving version labels in', root);
    const r = STAMP.stamp(root);
    return { ok: true, text: V.stampFixed(r) };
  } catch (e) {
    return { ok: false, text: V.stampFixFailed(e && e.message ? e.message : String(e)) };
  }
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * runInstall(opts, io?) → Promise<exit code>. opts: {dir, plan, quiet, save, from, repoint, share, debug}.
 * io (tests): {out, err, ask, env, stdinIsTTY, self, exec}.
 */
async function runInstall(opts, ioIn) {
  const io = Object.assign(defaultIo(), ioIn || {});
  const dbg = makeDbg(debugEnabled(opts));
  _dbg = dbg;
  const exec = makeExec(io, dbg);
  const targetDir = path.resolve(opts.dir || process.cwd());

  // observe → preconditions (nothing written; --plan needs no terminal because it never prompts)
  let state = O.observe(targetDir, io.self, io.env, { exec });
  dbg('observed:', 'label-inputs reg=' + state.reg.state + ' dep=' + state.dep.onDisk + ' record=' + JSON.stringify(state.en.record) + ' canonical=' + state.canonical.mode);
  let ref = O.preconditions(state, { quiet: !!(opts.quiet || opts.plan), stdinIsTTY: io.stdinIsTTY });
  // --fix-version-mismatch: the sanctioned write to our OWN folder — re-derive the version labels from
  // package.json, re-observe, then re-check. Scoped to the `stamp` refusal; every other refusal still stops.
  if (ref && ref.id === 'stamp' && opts.fixVersionMismatch) {
    const fix = applyVersionFix(state, dbg);
    if (!fix.ok) { io.err(fix.text); return 1; }
    io.out(fix.text);
    state = O.observe(targetDir, io.self, io.env, { exec });
    ref = O.preconditions(state, { quiet: !!(opts.quiet || opts.plan), stdinIsTTY: io.stdinIsTTY });
  }
  if (ref) { io.err(V.refusal(ref, state)); return ref.exit; }
  if (state.self.root && state.target.real === state.self.root) { io.err(V.refusal({ id: 'self-folder', exit: 1, detail: {} }, state)); return 1; }
  if (state.reg.state === 'unknown' || state.en.record === 'unknown') { io.err(UNKNOWN_STATE_REFUSAL); return 1; }

  io.out(V.header(state) + '\n\n');

  // diagnose
  const dx = diagnose(state, opts);
  dbg('diagnose:', dx.label, 'provisional plan=' + dx.actions.map((a) => a.id).join(','));
  if (dx.label === 'healthy' || dx.label === 'healthy-with-warnings') {
    io.out(`✓ ${dx.sentence}\n`);
    dx.rows.filter((r) => r.mark === 'warn').forEach((r) => io.out(V.renderRow(r) + '\n'));
    return 0;
  }

  // decide (only registered-elsewhere)
  let choice = null;
  if (dx.label === 'registered-elsewhere') {
    const d = await decide(state, opts, io);
    if (d.exit !== undefined) { closePrompterIfAny(io); return d.exit; }
    choice = d.choice;
    io.out('\n');
  } else {
    io.out(V.checkingBlock(state, dx.sentence, dx.findings) + '\n\n');
  }

  // plan
  const p = plan(state, Object.assign({}, opts, { choice }));
  dbg('plan:', p.actions.map((a) => a.id).join(',') || '(empty)');
  if (!p.actions.length) {
    // nothing the installer can do, yet not healthy (e.g. an invalid config.json it will never overwrite)
    dx.rows.filter((r) => r.mark === 'warn' || r.mark === 'fail').forEach((r) => io.out(V.renderRow(r) + '\n'));
    io.out(V.NOTHING_CHANGED + '\n');
    return dx.rows.some((r) => r.mark === 'fail') ? 1 : 0;
  }
  io.out(renderPlan(p, state) + '\n');
  if (opts.plan) return 0;

  // confirm — the one consent gate (nothing has been written up to here)
  if (!opts.quiet) {
    const a = String(await io.ask(V.CONFIRM_PROMPT)).trim().toLowerCase();
    if (!io.stdinIsTTY) io.out('\n');
    if (a !== 'y' && a !== 'yes') { io.out(V.NOTHING_CHANGED + '\n'); closePrompterIfAny(io); return 1; }
  }
  closePrompterIfAny(io); // release the TTY before any child process runs
  io.out('\n');

  // apply (+ per-action verify)
  const res = apply(state, p.actions, io, exec);
  if (res.failedAt !== null) {
    io.out(V.stoppedAfter(res.failedAt, p.actions.length) + '\n');
    return 1;
  }

  // closing — a full re-observe, the ⚠/✗ rows, one verdict line, one Next line
  let fin = res.state;
  ['dep', 'marker', 'registration', 'enablement'].forEach((l) => { fin = O.reobserveLayer(fin, l); });
  const rows = V.doctorRows(fin);
  const fails = rows.filter((r) => r.mark === 'fail').length;
  const warns = rows.filter((r) => r.mark === 'warn').length;
  const cctx = { checks: rows.filter((r) => r.mark === 'pass').length, warnings: warns, failures: fails,
    upgradedFrom: p.upgrade && p.oldVersion ? p.oldVersion : undefined };
  io.out('\n');
  rows.filter((r) => r.mark === 'warn' || r.mark === 'fail').forEach((r) => io.out(V.renderRow(r) + '\n'));
  io.out(V.closing(fin, cctx) + '\n');
  if (!fails) io.out(V.nextLine(fin, cctx) + '\n');
  return fails ? 1 : 0;
}

function closePrompterIfAny(io) { if (io.ask === ask) closePrompter(); }

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────

function printHelp() { process.stdout.write(V.help()); }

function usage(msg) { process.stderr.write(msg); process.exit(2); }

function parseArgs(argv) {
  const a = { dir: null, from: null, quiet: false, plan: false, save: false, repoint: false, share: false, check: false, verbose: false, debug: false, help: false, fixVersionMismatch: false };
  const needValue = (i, x) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('-')) usage(`error: ${x} requires a value (got ${v === undefined ? 'nothing' : `'${v}'`}).\n`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i];
    if (x === '-h' || x === '--help') a.help = true;
    else if (x === '--quiet') a.quiet = true;
    else if (x === '--plan') a.plan = true;
    else if (x === '--save') a.save = true;
    else if (x === '--repoint') a.repoint = true;
    else if (x === '--share') a.share = true;
    else if (x === '--check') a.check = true;
    else if (x === '--verbose') a.verbose = true;
    else if (x === '--debug') a.debug = true;
    else if (x === '--fix-version-mismatch') a.fixVersionMismatch = true;
    else if (x === '--from') { a.from = needValue(i, x); i += 1; }
    else if (x === '--dir') { a.dir = needValue(i, x); i += 1; }
    else if (!x.startsWith('-') && a.dir === null) a.dir = x; // positional target dir: `install <dir>`
    else usage(`Unknown argument: ${x}\n`);
  }
  if (a.repoint && a.share) usage('error: --repoint and --share answer the same question differently; pass one.\n');
  if (a.dir === null) a.dir = process.cwd();
  return a;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  _dbg = makeDbg(debugEnabled(opts));
  if (opts.help) { printHelp(); process.exit(0); }
  const targetDir = path.resolve(opts.dir);
  if (opts.check) { // compatibility alias (O4): `install --check` IS the doctor now
    await Promise.resolve(); // let this file's module.exports finish assigning (main() starts before it) — the doctor requires us back
    process.exit(await require('./tpm-consumer-doctor').runDoctor({ dir: opts.dir, verbose: opts.verbose, debug: opts.debug }));
  }
  const code = await runInstall(opts);
  closePrompter();
  process.exit(code);
}

if (require.main === module) {
  main().catch((err) => { process.stderr.write(`tpm-consumer-install: ${err.message}\n`); process.exit(1); });
}

module.exports = {
  // the reconciler (phase 02)
  main, runInstall, parseArgs, diagnose, decide, plan, apply, applyVersionFix, renderPlan, compareLine, layerRows, nothingHere, isBroken,
  ACTION_ORDER, LABELS, UNKNOWN_STATE_REFUSAL, closePrompter,
  // retained helpers (the doctor, the legacy-helpers suite and the install tests import these)
  findBundleRoot, shellQuote, displayCommand, makeDbg, debugEnabled, compareCopies, hashTree, realOrResolved,
  ensureConsumerConfig, seedConfigDefaults,
  TPM_PKG_NAME, MARKETPLACE_NAME, PLUGIN_NAME, PLUGIN_ID, MARKETPLACE_SOURCE,
};
