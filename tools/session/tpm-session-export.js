#!/usr/bin/env node
'use strict';
/**
 * tpm-session-export.js — the node-invokable EXPORT tool for `kind:"session"` records (P05).
 *
 * Delegated the `export` verb by the router (export-spec Locked #4; #1113 C/D). Turns session
 * JSON on disk into the outputs from the LOCKED `export-spec.md` by COMPOSING the blessed shared
 * pieces — it re-implements NONE of them:
 *   - `lib/session-model.js`     · `loadSession(jsonPath)`     — read→migrate→validate one session.
 *   - `lib/session-converter.js` · `render(record, { now })`   — the PURE JSON→human converter.
 *   - `lib/export-scaffold.js`   · `selectRecords` / `combine` / `dispatch` — kind-agnostic
 *                                  filter / combine / one-vs-many / JSON-vs-human dispatch.
 *
 * ── EXPORT SURFACE (export-spec §Export surface) ──
 *   Single session   — full JSON (canonical envelope) OR human (one-way, NOT re-importable).
 *   Multi-session     — the last N sessions (or an explicit selector list), as either
 *                       ONE combined file OR per-session files, in JSON and/or human.
 *   Combined shape (Q4): JSON = a BARE ARRAY of session envelopes `[ {…}, … ]` (no wrapper);
 *                        human = the FULL per-session render REPEATED for each session.
 *   Filters COMPOSE with a #1092 search result-set (feed an id/selector list or a pre-loaded
 *                        record set in) — matching is NOT reimplemented here (stubbed as the seam).
 *   Thin/editable session export: DROPPED (Q3) — deliberately NOT wired (JSON-full + human-only).
 *
 * ── `now` CLOSURE (P04 concern) ──
 * The converter is `render(record, { now })`, but the scaffold's human dispatcher calls its
 * injected converter as `converter(record)` (one arg). So we bind a real `now` in a CLOSURE:
 *   converter: (r) => render(r, { now })
 * `now` is captured ONCE per export (default `nowIsoTz()`; overridable via `--now`) so punchlist
 * ages render and open items never hit the converter's loud "opts.now is required" throw.
 *
 * ── NODE-INVOKABLE, NO BIN (Q5) ──
 * Runs via `npx tpm session export …` (routed through the `tpm` bin), or bare
 * `node tools/session/tpm-session-export.js …`. Programmatic callers `require()` it for `exportSessions(...)`.
 *
 * Zero third-party deps; Node built-ins only.
 */
const fs = require('fs');
const path = require('path');

const { loadSession } = require('./lib/session-model');
const { render } = require('./lib/session-converter');
const { selectRecords, combine, dispatch } = require('../lib/export-scaffold');
const { nowIsoTz } = require('../lib/timestamp');

const SESSION_FILE_RE = /^session-(\d+)\.json$/;

// ── enumeration / resolution ─────────────────────────────────────────────────

/**
 * enumerateSessions(sessionsDir) -> [{ number, name, path }]  (ascending by number)
 * Discovers canonical sessions in the CANONICAL NESTED per-session-folder layout (json-format-spec
 * §"On-disk naming + location", Q-F): each session is `session-<NNNN>/session-<NNNN>.json`. Used for
 * `--last N` and to resolve a selector's session numbers to on-disk paths. Never touches the live
 * sessions dir (the caller supplies a scratch/real dir explicitly). `name` is the JSON basename
 * (e.g. `session-0021.json`) so the derived export output filename stays flat.
 */
function enumerateSessions(sessionsDir) {
  if (!sessionsDir) throw new Error('enumerateSessions: sessionsDir is required');
  let dirents;
  try {
    dirents = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`tpm-session-export: cannot read --sessions-dir '${sessionsDir}': ${e.message}`);
  }
  const entries = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue; // nested layout: canonical JSON lives inside session-<NNNN>/
    const subPath = path.join(sessionsDir, d.name);
    let subNames;
    try {
      subNames = fs.readdirSync(subPath);
    } catch (_e) {
      continue;
    }
    for (const name of subNames) {
      const m = SESSION_FILE_RE.exec(name);
      if (m) entries.push({ number: Number(m[1]), name, path: path.join(subPath, name) });
    }
  }
  entries.sort((a, b) => a.number - b.number);
  return entries;
}

// Zero-padded 4-wide session number for output file names (matches the human header's "0021").
function padNumber(number) {
  const n = Number(number);
  return Number.isFinite(n) ? String(n).padStart(4, '0') : String(number == null ? '' : number);
}

/**
 * resolveRecords(opts) -> record[]  (the records to export, in export order)
 *
 * The search-composition SEAM (export-spec: compose with #1092, do NOT re-match). Three ways in,
 * in precedence order:
 *   1. opts.records   — a PRE-LOADED result-set (the truest #1092 seam): used verbatim.
 *   2. opts.selector  — an explicit id/selector LIST of session numbers (a #1092-style result-set,
 *                       stubbed: we take the list, we do not compute it). Resolved against the dir
 *                       in the ORDER given; a number may be padded ('0021') or bare ('21').
 *   3. opts.last (N)  — the N most-recent sessions (highest numbers), emitted NEWEST-FIRST.
 * An optional `opts.filter` (a predicate fn OR an array result-set) then COMPOSES over the
 * candidates via the scaffold's `selectRecords` — again, no re-matching here.
 */
function resolveRecords(opts) {
  const options = opts || {};
  const load = typeof options.loadSession === 'function' ? options.loadSession : loadSession;
  let records;

  if (Array.isArray(options.records)) {
    records = options.records.slice();
  } else if (Array.isArray(options.selector) && options.selector.length) {
    const byNumber = new Map(enumerateSessions(options.sessionsDir).map((e) => [e.number, e]));
    records = options.selector.map((sel) => {
      const num = Number(sel);
      const entry = Number.isFinite(num) ? byNumber.get(num) : undefined;
      if (!entry) {
        throw new Error(`tpm-session-export: selector '${sel}' matched no session-<NNNN>.json in '${options.sessionsDir}'`);
      }
      return load(entry.path);
    });
  } else if (options.last != null) {
    const n = Number(options.last);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`tpm-session-export: --last must be a positive integer, got ${JSON.stringify(options.last)}`);
    }
    const entries = enumerateSessions(options.sessionsDir);
    const chosen = entries.slice(-n).reverse(); // top-N highest, NEWEST-FIRST
    records = chosen.map((e) => load(e.path));
  } else {
    throw new Error('tpm-session-export: nothing to export — pass records, --session <NNNN>… (selector), or --last N');
  }

  if (options.filter !== undefined && options.filter !== null) {
    records = selectRecords(records, { filter: options.filter });
  }
  if (!records.length) throw new Error('tpm-session-export: the selection resolved to zero sessions');
  return records;
}

// ── the export core ──────────────────────────────────────────────────────────

/**
 * exportSessions(opts) -> { records, outputs, written }
 *
 *   opts.sessionsDir  — dir of `session-<NNNN>.json` (required unless opts.records given).
 *   opts.records      — OPTIONAL pre-loaded result-set (bypasses enumeration; the #1092 seam).
 *   opts.selector     — OPTIONAL explicit list of session numbers (the #1092-style seam).
 *   opts.last         — OPTIONAL N most-recent (highest numbers), newest-first.
 *   opts.filter       — OPTIONAL predicate fn OR array result-set, composed via selectRecords.
 *   opts.styles       — ['json'] | ['human'] | ['json','human']  (default ['json']).
 *   opts.combine      — 'one-file' | 'per-file' (default 'one-file' for multi; moot for a single).
 *   opts.out          — dir (write each file) OR a single file path; omitted -> nothing written.
 *   opts.now          — reference time for punchlist age (ISO string / Date); default nowIsoTz().
 *   opts.render       — injected converter (default session-converter.render).
 *   opts.loadSession  — injected loader (default session-model.loadSession).
 *
 * Returns the resolved `records`, the `outputs` ([{ style, suggestedName, body, path|null }]),
 * and whether files were `written`. `now` is bound ONCE in a closure so the human converter is
 * always called `converter(record)` with age available (P04 concern).
 */
function exportSessions(opts) {
  const options = opts || {};
  const styles = normalizeStyles(options.styles);
  const renderFn = typeof options.render === 'function' ? options.render : render;
  const now = options.now != null ? options.now : nowIsoTz();
  const converter = (record) => renderFn(record, { now }); // ← the `now` CLOSURE (P04 concern)

  const records = resolveRecords(options);
  const mode = options.combine || (records.length > 1 ? 'one-file' : 'per-file');
  const combinedName = options.combinedName ||
    (options.last != null ? `sessions-last-${records.length}` : 'sessions-combined');
  const nameFor = (record) => `session-${padNumber(record && record.meta && record.meta.number)}`;

  const outputs = [];
  for (const style of styles) {
    const groups = combine(records, { mode });
    for (const group of groups) {
      const descriptors = dispatch(group, { style, converter, nameFor, combinedName });
      for (const d of descriptors) outputs.push({ style, suggestedName: d.suggestedName, body: d.body, path: null });
    }
  }

  let written = false;
  if (options.out != null && options.out !== '') {
    writeOutputs(outputs, options.out);
    written = true;
  }
  return { records, outputs, written };
}

// ['json','human'] normalized/deduped; accepts a string, comma-list, 'both', or array.
function normalizeStyles(styles) {
  let list = styles;
  if (list == null) return ['json'];
  if (typeof list === 'string') list = list.split(',');
  if (!Array.isArray(list)) throw new Error('tpm-session-export: styles must be a string or array');
  const out = [];
  for (const raw of list) {
    const s = String(raw).trim().toLowerCase();
    if (s === '' ) continue;
    if (s === 'both') { for (const b of ['json', 'human']) if (!out.includes(b)) out.push(b); continue; }
    if (s !== 'json' && s !== 'human') throw new Error(`tpm-session-export: unknown --style '${raw}' (json|human|both)`);
    if (!out.includes(s)) out.push(s);
  }
  return out.length ? out : ['json'];
}

/**
 * writeOutputs(outputs, out) — mutates each output's `path` with where it landed.
 *  - Exactly one output AND `out` has a .json/.md extension -> write that single file to `out`.
 *  - Otherwise `out` is treated as a DIRECTORY: created if needed; each output written under it
 *    as its suggestedName. Multiple outputs REQUIRE a directory (never one file path).
 */
function writeOutputs(outputs, out) {
  const singleFile = outputs.length === 1 && /\.(json|md)$/i.test(out) && !isExistingDir(out);
  if (singleFile) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, outputs[0].body);
    outputs[0].path = out;
    return;
  }
  if (outputs.length > 1 && /\.(json|md)$/i.test(out) && !isExistingDir(out)) {
    throw new Error(`tpm-session-export: --out '${out}' looks like a single file but ${outputs.length} files were produced — give a directory`);
  }
  fs.mkdirSync(out, { recursive: true });
  for (const o of outputs) {
    const p = path.join(out, o.suggestedName);
    fs.writeFileSync(p, o.body);
    o.path = p;
  }
}

function isExistingDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_e) { return false; }
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const opts = { selector: [], styles: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`tpm-session-export: ${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case '--sessions-dir': opts.sessionsDir = next(); break;
      case '--last': opts.last = next(); break;
      case '--session': for (const v of next().split(',')) if (v.trim()) opts.selector.push(v.trim()); break;
      case '--style': for (const v of next().split(',')) if (v.trim()) opts.styles.push(v.trim()); break;
      case '--combine': opts.combine = next(); break;
      case '--out': opts.out = next(); break;
      case '--now': opts.now = next(); break;
      case '-h': case '--help': opts.help = true; break;
      default: throw new Error(`tpm-session-export: unknown argument '${a}'`);
    }
  }
  if (!opts.selector.length) delete opts.selector;
  if (!opts.styles.length) delete opts.styles;
  return opts;
}

const USAGE = `tpm-session-export — session export tool (run: npx tpm session export …)

  --sessions-dir <dir>     directory of session-<NNNN>.json (a SCRATCH or real dir). OPTIONAL (F4):
                           omitted → resolved from the LOCAL project's .claude/claude-tpm/config.json
                           (session.notes.sessionsDir); the flag OVERRIDES; with NEITHER, FAILS LOUD.
  --last N                 export the N most-recent sessions (newest first)
  --session <NNNN>[,NNNN]  explicit selector list (repeatable; the #1092 seam) — no re-matching
  --style json|human|both  output format(s); repeatable / comma-list (default: json)
  --combine one-file|per-file   multi-session: ONE combined file (default) or per-session files
  --out <dir|file>         write here (dir = per suggestedName; file = single output). Omit -> stdout.
  --now <iso>              reference time for punchlist age (default: now, local offset)

Combined (Q4): JSON = a bare array of envelopes; human = full per-session render repeated.
Thin/editable session export is intentionally NOT available (Q3).`;

function main(argv) {
  let opts;
  try {
    opts = parseArgv(argv);
  } catch (e) {
    process.stderr.write(String(e.message) + '\n\n' + USAGE + '\n');
    return 2;
  }
  if (opts.help) { process.stdout.write(USAGE + '\n'); return 0; }
  try {
    // F4: --sessions-dir is OPTIONAL — resolve (flag > local project config.json > FAIL LOUD). Never a
    // silent live-store default; resolveSessionsDir throws loud when neither a flag nor a local config.
    if (!opts.sessionsDir && !opts.records) {
      opts.sessionsDir = require('./tpm-session-config').resolveSessionsDir(undefined, undefined).sessionsDir;
    }
    const { outputs, written } = exportSessions(opts);
    if (!written) {
      // stdout: single output raw; multiple outputs delimited by a name banner.
      if (outputs.length === 1) {
        process.stdout.write(outputs[0].body.endsWith('\n') ? outputs[0].body : outputs[0].body + '\n');
      } else {
        process.stdout.write(outputs.map((o) => `===== ${o.suggestedName} =====\n${o.body}`).join('\n') + '\n');
      }
    } else {
      process.stderr.write(`wrote ${outputs.length} file(s):\n` + outputs.map((o) => '  ' + o.path).join('\n') + '\n');
    }
    return 0;
  } catch (e) {
    process.stderr.write('tpm-session-export: ' + String(e.message) + '\n');
    return 1;
  }
}

module.exports = {
  exportSessions,
  resolveRecords,
  enumerateSessions,
  normalizeStyles,
  padNumber,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
