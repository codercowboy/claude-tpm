#!/usr/bin/env node
/**
 * tpm-consumer-doctor.js — `tpm doctor`: a read-only health check of one project, as `observe() + a renderer`.
 * (Phase 03 of the installer-updates epic; design: dev/20261001-installer-updates/installer-design.md §9,
 * voice §4.9. It replaces the old `install --check`, which survives only as a compatibility alias of this script.)
 *
 * PIPELINE:  parseArgs → observe (full probes) → bundle-folder refusal → rows → print → exit
 *   observe        tpm-consumer-observe.js — the SAME observer the installer uses. Imported, never copied.
 *   rows           V.doctorRows(state) (tpm-consumer-voice.js): package.json · registered · turned on · project folder ·
 *                  claude-tpm folder · claude · [in a Claude session only: tpm on PATH · TPM_HOME]. A project with
 *                  nothing of claude-tpm in it collapses to ONE ✗ row. One row is overridden here:
 *   claude-tpm folder   the stamp guard (Q10, a mislabelled folder is a ✗) and `complete` judged against the
 *                  REGISTERED folder when there is one, else this installer's own folder (S17/S26: the folder that
 *                  RUNS is what is checked — an old node_modules copy is a layer-1 ⚠, never blamed on the bundle).
 *   print          default: the header, only the ⚠/✗ rows (each with its `fix:` line), then ONE summary line.
 *                  `--verbose`: every row (✓ and · too). Exit 1 iff any ✗.
 *
 * REPORT-ONLY (#1143 H): the doctor never writes, never repairs, never prompts. Its fix lines say what to run.
 * REFUSAL: run on a claude-tpm folder itself (the bundle, or its node_modules copy) it prints
 *   "this is the claude-tpm folder, not a project." and exits 1 — before any row.
 * A project on a registration it chose with `tpm install --share` (registered elsewhere/github) is the installer's
 * `healthy-with-warnings`: the registered-from row is a ⚠ with a `--repoint` fix and the exit is 0 (see `verdict`).
 *
 * USAGE:  node tools/consumer/tpm-consumer-doctor.js [dir] [--verbose] [--debug] [-h]      (--check accepted, ignored)
 * Also a module (module.exports) so tests can drive renderDoctor / runDoctor directly. Zero deps; portable `node`.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const O = require('./tpm-consumer-observe');
const V = require('./tpm-consumer-voice');
const inst = require('./tpm-consumer-install');

const { PLUGIN_ID, TPM_PKG_NAME, MARKETPLACE_NAME } = inst;

// ── helpers moved here from the retired install.js doctor (the doctor suite imports them from this module) ──

/** hooks/hooks.json of a claude-tpm folder → { present, error, gateSpawn, sessionStart }. EVERY return carries all four keys. */
function bundleHooksHealthAt(bundleDir) {
  const p = path.join(bundleDir, 'hooks', 'hooks.json');
  if (!fs.existsSync(p)) return { present: false, error: null, gateSpawn: false, sessionStart: false };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return { present: true, error: e.message, gateSpawn: false, sessionStart: false }; }
  return Object.assign({ present: true, error: null }, O.parseHooksManifest(manifest));
}
/** The delivered bundle inside a project's node_modules. */
function bundleHooksHealth(targetDir) {
  return bundleHooksHealthAt(path.join(targetDir, 'node_modules', TPM_PKG_NAME));
}

/**
 * `tpm` on PATH (in-session only): the first `tpm` on PATH must resolve into an expected bundle's bin/.
 * → { applicable, ok, found } — applicable:false outside a Claude session.
 */
function checkTpmOnPath(env, binDirs) {
  if (!(env && (env.TPM_PROJECT_ROOT || env.TPM_HOME))) return { applicable: false, ok: true, found: null };
  const found = O.findOnPath('tpm', env.PATH);
  if (!found) return { applicable: true, ok: false, found: null };
  const real = O.realOrResolved(found);
  const ok = (binDirs || []).filter(Boolean).some((d) => path.dirname(real) === O.realOrResolved(d));
  return { applicable: true, ok, found };
}

// ── the rows ─────────────────────────────────────────────────────────────────────────────────────────────

/** Is `state.target` a claude-tpm folder itself (this installer's own folder, or any folder named as the package)? */
function isBundleFolder(state) {
  if (state.self.root && state.target.real === state.self.root) return true;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(state.target.dir, 'package.json'), 'utf8'));
    return !!j && j.name === TPM_PKG_NAME;
  } catch (_e) { return false; }
}

/** The `claude-tpm folder` row: stamp guard on self, then `complete` of the REGISTERED folder, else self. */
function folderRow(state) {
  const label = 'claude-tpm folder';
  const base = V.rowClaudeTpmFolder(state);
  if (!state.self.root || !state.self.stampOk) return base; // no folder / mislabelled: the voice row says it
  const r = state.reg;
  const registered = r && (r.state === 'same' || r.state === 'same-via-link' || r.state === 'elsewhere') && r.realPath;
  if (!registered || r.realPath === state.self.root) return base;
  // another folder is what Claude Code actually runs: judge THAT one
  const where = V.tilde(r.realPath);
  if (r.complete === true) return { label, mark: 'pass', text: `complete (${r.version || 'unknown version'}), the registered folder ${where}` };
  const h = bundleHooksHealthAt(r.realPath);
  const why = h.error ? 'hooks/hooks.json is not valid JSON' : !h.present ? 'missing hooks/hooks.json' : 'hooks/hooks.json lacks a required hook';
  return { label, mark: 'fail', text: `the registered folder ${where} is incomplete — ${why}`, fix: 'reinstall claude-tpm; that checkout is broken, then run `tpm install . --repoint`' };
}

/** All doctor rows, in order. Pure on a State. */
function doctorRowsFor(state) {
  const rows = V.doctorRows(state);
  if (rows.length === 1) return rows; // "not installed at all": ONE ✗ row (S22)
  return rows.map((r) => (r.label === 'claude-tpm folder' ? folderRow(state) : r));
}

/**
 * renderDoctor(state, {verbose}) → { text, code, rows, shown, verdict }. Pure on a State (no I/O).
 * verdict = the installer's diagnose() label (healthy | healthy-with-warnings | …) for callers that want it; the doctor
 * itself adds no prose to it — the ⚠ row + fix IS the report for a project that settled on a `use`d registration.
 */
function renderDoctor(state, opts) {
  const o = opts || {};
  const rows = doctorRowsFor(state);
  const shown = o.verbose ? rows : rows.filter((r) => r.mark === 'warn' || r.mark === 'fail');
  let verdict = null;
  try { verdict = inst.diagnose(state, {}).label; } catch (_e) { verdict = null; }
  const lines = [V.header(state), ''];
  shown.forEach((r) => lines.push(V.renderRow(r)));
  if (shown.length) lines.push('');
  lines.push(V.doctorSummary(rows));
  const code = rows.some((r) => r.mark === 'fail') ? 1 : 0;
  return { text: lines.join('\n') + '\n', code, rows, shown, verdict };
}

// ── run / CLI ────────────────────────────────────────────────────────────────────────────────────────────

/** runDoctor(opts, io?) → Promise<exit>. opts: {dir, verbose, debug}. io (tests): {out, err, env, self, exec}. */
async function runDoctor(opts, ioIn) {
  const io = Object.assign({ out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s), env: process.env, self: null, exec: null }, ioIn || {});
  const dir = path.resolve((opts && opts.dir) || process.cwd());
  const dbg = inst.makeDbg(!!(opts && opts.debug) || !!process.env.TPM_DEBUG);
  const oo = io.exec ? { exec: io.exec } : {};
  const state = O.observe(dir, io.self, io.env, oo);
  dbg('doctor observed:', 'reg=' + state.reg.state, 'dep=' + state.dep.onDisk, 'canonical=' + state.canonical.mode);
  if (isBundleFolder(state)) {
    io.err('error: not checking — this is the claude-tpm folder, not a project.\n  Run `tpm doctor` inside a project that uses claude-tpm.\n');
    return 1;
  }
  const res = renderDoctor(state, { verbose: !!(opts && opts.verbose) });
  io.out(res.text);
  return res.code;
}

const HELP = [
  'tpm doctor [dir] [options] — check a project without changing anything',
  '',
  '  [dir]        the project (default: the current folder)',
  '  --verbose    show every row, not just the warnings and problems',
  '  --debug      trace every command (also TPM_DEBUG=1)',
  '  -h, --help',
  '',
  '  Exit 0 when nothing is wrong (warnings are fine); exit 1 when something is broken.',
  '  To fix what it finds: tpm install .',
  '',
].join('\n');

function parseArgs(argv, fail) {
  const bad = fail || ((msg) => { process.stderr.write(msg); process.exit(2); });
  const a = { dir: null, verbose: false, debug: false, help: false, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i];
    if (x === '-h' || x === '--help') a.help = true;
    else if (x === '--verbose') a.verbose = true;
    else if (x === '--debug') a.debug = true;
    else if (x === '--check') a.check = true; // compatibility alias (O4): `doctor --check` ≡ `doctor`
    else if (x === '--dir') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('-')) bad(`error: --dir requires a value (got ${v === undefined ? 'nothing' : `'${v}'`}).\n`);
      a.dir = v; i += 1;
    } else if (!x.startsWith('-') && a.dir === null) a.dir = x;
    else bad(`Unknown argument: ${x}\n`);
  }
  if (a.dir === null) a.dir = process.cwd();
  return a;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP); process.exit(0); }
  process.exit(await runDoctor(opts));
}

if (require.main === module) {
  main().catch((err) => { process.stderr.write(`tpm-consumer-doctor: ${err.message}\n`); process.exit(1); });
}

module.exports = {
  main, runDoctor, renderDoctor, doctorRowsFor, folderRow, isBundleFolder, parseArgs, HELP,
  bundleHooksHealth, bundleHooksHealthAt, checkTpmOnPath,
  PLUGIN_ID, TPM_PKG_NAME, MARKETPLACE_NAME,
};
