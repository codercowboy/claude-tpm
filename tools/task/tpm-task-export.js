#!/usr/bin/env node
'use strict';
/**
 * tpm-task-export.js — the node-invokable EXPORT + SEARCH tool for `kind:"task"` records (P07).
 *
 * `tpm task export` + `tpm task search` on ONE selector core (#1092 C/D · E3), built by COMPOSING the
 * blessed shared pieces — it re-implements NONE of the model / converter / scaffold:
 *   - `lib/task-model.js`     · loadTask / bodyPathFor / readIndex / stripHistory (the --thin
 *                               projection, G1 — NOT the base `trimNonEditable`).
 *   - `lib/task-converter.js` · render(record,{now}) — the PURE JSON→human body render.
 *   - `lib/base.js` (exportScaffold) · selectRecords / combine / dispatch — kind-agnostic
 *                               filter / combine / one-vs-many / JSON-vs-human dispatch.
 *
 * ── ONE SELECTOR CORE (#1092 C/D · spec §3) ──
 * `buildSelector(argv)` parses the identical selector set ONCE; `selectCandidates(selector)` evaluates
 * it against `tasks-index.json` (the fast path — a body `task-<id>.json` is opened ONLY when a predicate
 * needs it: `--closed-since` / `--by closed` need `endedAt`, `--match` reaches into `summary`/`context`).
 * BOTH `runExport` and `runSearch` call the SAME `buildSelector` + `selectCandidates`; export emits the
 * RECORDS, search emits `id·file·line·snippet` POINTERS. No double-build.
 *
 * Selectors (AND together): ids/ranges (also the comma-quoted form "1112,1119", feeds #1125) ·
 *   --state <s>[,<s>] (+ --open = open∪in-progress, --closed = finished∪dropped) · --label (repeatable,
 *   AND) · --match <text> · --opened-since/--opened-after/--opened-before · --updated-since ·
 *   --closed-since · --last N + --by updated|created|closed (default updated).
 *   `<Nd|Nh|Nw>` relative window OR `YYYY-MM-DD`. An INVALID window is an EXIT-2 usage error — never a
 *   silent empty result (#1092-I hardening; the parse happens in buildSelector, which main() maps to 2).
 *
 * Shapes (export): --json / --human (default --human to stdout, OQ4) · --combined (default; JSON = a
 *   BARE ARRAY of envelopes, human = each body rendered with its full `# #<id> · …` header repeated) ·
 *   --per-file --out <dir> (one task-<id>.{json,md} each) · --thin (drops history[] via
 *   model.stripHistory) · --out <path> (write to file/dir instead of stdout).
 *
 * ── SCRATCH-STORE DISCIPLINE ── every run reads ONLY where --tasks-dir points; it NEVER defaults to the
 * live `.claude/claude-tpm/tasks/`. --tasks-dir is REQUIRED.
 *
 * Zero third-party deps; Node built-ins only.
 */
const fs = require('fs');
const path = require('path');

const model = require('./lib/task-model');
const converter = require('./lib/task-converter');
const schema = require('./lib/task-schema');
const base = require('./lib/base');

const { selectRecords, combine, dispatch } = base.exportScaffold;
const { nowIsoTz } = base.timestamp;

const MS_MIN = 60 * 1000;
const MS_HOUR = 60 * MS_MIN;
const MS_DAY = 24 * MS_HOUR;
const MS_WEEK = 7 * MS_DAY;
const UNIT_MS = { h: MS_HOUR, d: MS_DAY, w: MS_WEEK };

const CLOSED_STATES = ['finished', 'dropped'];
const OPEN_STATES = ['open', 'in-progress'];

// ── time helpers ───────────────────────────────────────────────────────────────

function toMs(t) {
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'string' && t) {
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? NaN : ms;
  }
  return NaN;
}

/**
 * parseWindow(value, nowMs, { pointInTime }) -> threshold ms
 * A relative window `<N>[hdw]` resolves to `nowMs - N*unit`; a `YYYY-MM-DD` date resolves to that
 * day's UTC start (or, for a "-before" bound, is caller-adjusted). Anything else THROWS — the loud
 * exit-2 path (#1092-I): an unparseable window must never masquerade as an empty result.
 */
function parseWindow(value, nowMs, opts) {
  const options = opts || {};
  const raw = String(value == null ? '' : value).trim();
  const rel = /^(\d+)([hdw])$/.exec(raw);
  if (rel) {
    const n = Number(rel[1]);
    return nowMs - n * UNIT_MS[rel[2]];
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const ms = Date.parse(raw + 'T00:00:00Z');
    if (Number.isNaN(ms)) throw new Error(`invalid date window '${value}' (expected YYYY-MM-DD)`);
    // A "-before <date>" bound is end-exclusive on the NEXT day so the named day is included.
    return options.pointInTime === 'before' ? ms + MS_DAY : ms;
  }
  throw new Error(
    `invalid window '${value}' — expected a relative window (Nd | Nh | Nw) or a date (YYYY-MM-DD)`,
  );
}

// ── id / range parsing ───────────────────────────────────────────────────────────

/**
 * parseIdTokens(tokens) -> [{ lo, hi }]  (each an inclusive numeric range; a bare id is lo===hi).
 * Accepts the comma-quoted set form ("1112,1119"), explicit ids, and ranges (1100-1120). Feeds #1125.
 */
function parseIdTokens(tokens) {
  const ranges = [];
  for (const token of tokens) {
    for (const partRaw of String(token).split(',')) {
      const part = partRaw.trim();
      if (part === '') continue;
      const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
      if (range) {
        const lo = Number(range[1]);
        const hi = Number(range[2]);
        ranges.push({ lo: Math.min(lo, hi), hi: Math.max(lo, hi) });
        continue;
      }
      if (/^\d+$/.test(part)) {
        const n = Number(part);
        ranges.push({ lo: n, hi: n });
        continue;
      }
      throw new Error(`invalid id/range selector '${part}' (expected an id or a LO-HI range)`);
    }
  }
  return ranges;
}

function idInRanges(id, ranges) {
  const n = Number(id);
  return ranges.some((r) => n >= r.lo && n <= r.hi);
}

// ── the ONE selector core ──────────────────────────────────────────────────────

/**
 * buildSelector(argv) -> selector
 * Parses the shared selector set + the shape flags ONCE. Throws on a malformed window / id / flag —
 * main() maps that to EXIT 2 (usage error). `now` (default nowIsoTz, overridable via --now) anchors
 * every relative window AND the human render age, so tests are deterministic.
 */
function buildSelector(argv) {
  try {
    return _buildSelector(argv);
  } catch (e) {
    // Every buildSelector failure is a USAGE error (bad window / id / flag) → EXIT 2 (#1092-I): a
    // malformed selection must be loud, never a silent empty result. Runtime (IO) errors are thrown
    // later by selectCandidates and stay untagged (EXIT 1).
    if (e && !e.usageExit) e.usageExit = true;
    throw e;
  }
}

function _buildSelector(argv) {
  const sel = {
    tasksDir: null,
    idRanges: [],
    states: null,       // Set<string> | null (null = any)
    labels: [],         // AND
    match: null,        // ci substring over headline+summary+context
    windows: {},        // opened{since,after,before} / updated{since} / closed{since}  (ms)
    last: null,
    by: 'updated',
    json: false,
    human: false,
    perFile: false,
    thin: false,
    out: null,
    now: null,          // ISO string
    help: false,
  };
  const stateAdds = [];
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      i += 1;
      return argv[i];
    };
    switch (a) {
      case '-h': case '--help': sel.help = true; break;
      case '--tasks-dir': sel.tasksDir = val(); break;
      case '--state': for (const s of val().split(',')) { const t = s.trim().toLowerCase(); if (t) stateAdds.push(t); } break;
      case '--open': for (const s of OPEN_STATES) stateAdds.push(s); break;
      case '--closed': for (const s of CLOSED_STATES) stateAdds.push(s); break;
      case '--label': sel.labels.push(val()); break;
      case '--match': sel.match = val(); break;
      case '--opened-since': sel._openedSince = val(); break;
      case '--opened-after': sel._openedAfter = val(); break;
      case '--opened-before': sel._openedBefore = val(); break;
      case '--updated-since': sel._updatedSince = val(); break;
      case '--closed-since': sel._closedSince = val(); break;
      case '--last': sel.last = val(); break;
      case '--by': sel.by = String(val()).trim().toLowerCase(); break;
      case '--json': sel.json = true; break;
      case '--human': sel.human = true; break;
      case '--combined': sel.perFile = false; break;
      case '--per-file': sel.perFile = true; break;
      case '--thin': sel.thin = true; break;
      case '--out': sel.out = val(); break;
      case '--now': sel.now = val(); break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown flag '${a}'`);
        positionals.push(a);
    }
  }

  if (sel.help) return sel;

  sel.idRanges = parseIdTokens(positionals);
  if (stateAdds.length) {
    const known = new Set(schema.STATES || ['open', 'in-progress', 'finished', 'dropped', 'removed']);
    for (const s of stateAdds) {
      if (!known.has(s)) throw new Error(`--state: unknown state '${s}' (one of ${[...known].join('|')})`);
    }
    sel.states = new Set(stateAdds);
  }
  if (sel.last != null) {
    const n = Number(sel.last);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--last must be a positive integer, got '${sel.last}'`);
    sel.last = n;
  }
  if (!['updated', 'created', 'closed'].includes(sel.by)) {
    throw new Error(`--by: unknown key '${sel.by}' (updated|created|closed)`);
  }

  // Resolve + VALIDATE every window NOW (exit-2 on a bad one, #1092-I).
  const nowMs = toMs(sel.now || nowIsoTz());
  if (Number.isNaN(nowMs)) throw new Error(`--now: unparseable reference time '${sel.now}'`);
  sel.nowMs = nowMs;
  if (sel._openedSince != null) (sel.windows.opened = sel.windows.opened || {}).since = parseWindow(sel._openedSince, nowMs);
  if (sel._openedAfter != null) (sel.windows.opened = sel.windows.opened || {}).after = parseWindow(sel._openedAfter, nowMs, { pointInTime: 'after' });
  if (sel._openedBefore != null) (sel.windows.opened = sel.windows.opened || {}).before = parseWindow(sel._openedBefore, nowMs, { pointInTime: 'before' });
  if (sel._updatedSince != null) (sel.windows.updated = sel.windows.updated || {}).since = parseWindow(sel._updatedSince, nowMs);
  if (sel._closedSince != null) (sel.windows.closed = sel.windows.closed || {}).since = parseWindow(sel._closedSince, nowMs);

  return sel;
}

/**
 * matchesRow(candidate, selector) -> bool — the shared predicate. Reads the index row first (fast
 * path) and opens the body ONLY for `--match` prose or the `--closed-since` (endedAt) window.
 */
function matchesRow(candidate, sel) {
  const row = candidate.row;
  if (sel.idRanges.length && !idInRanges(row.id, sel.idRanges)) return false;
  if (sel.states && !sel.states.has(row.state)) return false;
  if (sel.labels.length) {
    const labels = Array.isArray(row.labels) ? row.labels : [];
    for (const want of sel.labels) if (!labels.includes(want)) return false;
  }
  const w = sel.windows;
  if (w.opened) {
    const c = toMs(row.createdAt);
    if (Number.isNaN(c)) return false;
    if (w.opened.since != null && c < w.opened.since) return false;
    if (w.opened.after != null && c < w.opened.after) return false;
    if (w.opened.before != null && c >= w.opened.before) return false;
  }
  if (w.updated && w.updated.since != null) {
    const u = toMs(row.updatedAt);
    if (Number.isNaN(u) || u < w.updated.since) return false;
  }
  if (w.closed && w.closed.since != null) {
    const ended = closedAtMs(candidate);
    if (Number.isNaN(ended) || ended < w.closed.since) return false;
  }
  if (sel.match) {
    const needle = sel.match.toLowerCase();
    const rec = candidate.body();
    const hay = [row.headline, rec && rec.summary, rec && rec.context]
      .filter((s) => typeof s === 'string')
      .join('\n')
      .toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

/** closedAtMs(candidate) -> ms (NaN when the task has no endedAt) — opens the body (memoized). */
function closedAtMs(candidate) {
  const rec = candidate.body();
  const ended = rec && rec.timestamps ? rec.timestamps.endedAt : null;
  return ended == null ? NaN : toMs(ended);
}

/** orderKeyMs(candidate, by) -> ms — the sort key for --last (updated|created|closed). */
function orderKeyMs(candidate, by) {
  if (by === 'created') return toMs(candidate.row.createdAt);
  if (by === 'closed') { const c = closedAtMs(candidate); return Number.isNaN(c) ? -Infinity : c; }
  return toMs(candidate.row.updatedAt); // default: updated
}

/**
 * selectCandidates(selector) -> candidate[]   (the shared select+order+limit; used by BOTH verbs)
 *   candidate = { id:Number, row, path, body() }  — body() memoizes loadTask (opened only on demand).
 * Reads tasks-index.json (fast path); default order is id-ascending (byte-stable); `--last N` orders
 * by `--by` DESCENDING (newest-first) and slices the top N.
 */
function selectCandidates(sel) {
  // F4: --tasks-dir OPTIONAL — resolve (flag > local project config.json > FAIL LOUD). NEVER a
  // silent live-store default (resolveTasksDir throws loud when neither a flag nor a local config).
  if (!sel.tasksDir) sel.tasksDir = require('./tpm-task-config').resolveTasksDir(null, null).tasksDir;
  const idx = model.readIndex(sel.tasksDir);
  const rows = Array.isArray(idx.tasks) ? idx.tasks : [];
  const candidates = rows.map((row) => {
    const c = { id: Number(row.id), row, path: model.bodyPathFor(sel.tasksDir, model.canonicalId(row.id)) };
    let loaded;
    let didLoad = false;
    c.body = () => {
      if (!didLoad) { loaded = model.loadTask(c.path); didLoad = true; }
      return loaded;
    };
    return c;
  });
  let kept = candidates.filter((c) => matchesRow(c, sel));
  if (sel.last != null) {
    kept = kept
      .slice()
      .sort((a, b) => (orderKeyMs(b, sel.by) - orderKeyMs(a, sel.by)) || (b.id - a.id))
      .slice(0, sel.last);
  } else {
    kept = kept.slice().sort((a, b) => a.id - b.id);
  }
  return kept;
}

// ── export (records) ──────────────────────────────────────────────────────────

function stylesFor(sel) {
  const out = [];
  if (sel.json) out.push('json');
  if (sel.human) out.push('human');
  return out.length ? out : ['human']; // OQ4: default --human to stdout
}

/**
 * runExport(argv) -> int
 * selectCandidates ∘ (thin?) ∘ combine ∘ dispatch(inject task render, nameFor=task-<id>). Emits the
 * records. Combined JSON = a bare array of envelopes; combined human = each body's full render.
 */
function runExport(argv) {
  const sel = buildSelector(argv);
  if (sel.help) { process.stdout.write(USAGE + '\n'); return 0; }
  const candidates = selectCandidates(sel);
  const records = candidates.map((c) => {
    const rec = c.body();
    return sel.thin ? model.stripHistory(rec) : rec;
  });

  const now = sel.now || nowIsoTz();
  const renderFn = (record) => converter.render(record, { now });
  const nameFor = (record) => `task-${record.id}`;
  const combinedName = sel.last != null ? `tasks-last-${records.length}` : 'tasks-combined';
  const mode = sel.perFile ? 'per-file' : 'one-file';
  const styles = stylesFor(sel);

  const outputs = [];
  for (const style of styles) {
    const groups = combine(records, { mode });
    for (const group of groups) {
      const descriptors = dispatch(group, { style, converter: renderFn, nameFor, combinedName });
      for (const d of descriptors) outputs.push({ style, suggestedName: d.suggestedName, body: d.body, path: null });
    }
  }

  if (sel.out != null && sel.out !== '') {
    writeOutputs(outputs, sel.out);
    process.stderr.write(`wrote ${outputs.length} file(s):\n` + outputs.map((o) => '  ' + o.path).join('\n') + '\n');
    return 0;
  }
  if (!outputs.length) { process.stderr.write('tpm-task-export: no tasks matched the selection.\n'); return 0; }
  if (outputs.length === 1) {
    process.stdout.write(outputs[0].body.endsWith('\n') ? outputs[0].body : outputs[0].body + '\n');
  } else {
    process.stdout.write(outputs.map((o) => `===== ${o.suggestedName} =====\n${o.body}`).join('\n') + '\n');
  }
  return 0;
}

/**
 * writeOutputs(outputs, out) — mutates each output's `path`. A single output to a `.json`/`.md` path
 * writes that file; otherwise `out` is a DIRECTORY and each output lands under its suggestedName.
 */
function writeOutputs(outputs, out) {
  const looksFile = /\.(json|md)$/i.test(out) && !isExistingDir(out);
  if (outputs.length === 1 && looksFile) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, outputs[0].body);
    outputs[0].path = out;
    return;
  }
  if (outputs.length > 1 && looksFile) {
    throw new Error(`tpm-task-export: --out '${out}' looks like a single file but ${outputs.length} files were produced — give a directory`);
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

// ── search (pointers) ───────────────────────────────────────────────────────────

/**
 * pointerFor(candidate, selector) -> { id, file, line, snippet }
 * `file` is the body's store-relative path (from the index row). For a `--match` run the pointer is
 * the first body-file line containing the term; otherwise it points at the headline line. Reads the
 * raw body text ONCE only to compute the line/snippet (never re-parses).
 */
function pointerFor(candidate, sel) {
  const file = candidate.row.path || `task-${candidate.id}.json`;
  const headline = candidate.row.headline || '';
  let text = '';
  try { text = fs.readFileSync(candidate.path, 'utf8'); } catch (_e) { text = ''; }
  const lines = text.split('\n');

  const term = sel.match ? sel.match.toLowerCase() : null;
  if (term) {
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].toLowerCase().includes(term)) {
        return { id: String(candidate.id), file, line: i + 1, snippet: snip(lines[i]) };
      }
    }
  }
  // No --match (or the term lives only in a normalized field): point at the headline line.
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes('"headline"')) {
      return { id: String(candidate.id), file, line: i + 1, snippet: snip(headline || lines[i]) };
    }
  }
  return { id: String(candidate.id), file, line: 1, snippet: snip(headline) };
}

function snip(s) {
  const one = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return one.length > 100 ? one.slice(0, 97) + '…' : one;
}

/**
 * runSearch(argv) -> int
 * The SAME selector core as export; emits `id·file·line·snippet` pointers as plain text (default) or
 * JSON (--json). A valid selection that matches nothing prints an empty result (never an error).
 */
function runSearch(argv) {
  const sel = buildSelector(argv);
  if (sel.help) { process.stdout.write(USAGE + '\n'); return 0; }
  const candidates = selectCandidates(sel);
  const pointers = candidates.map((c) => pointerFor(c, sel));

  if (sel.json) {
    process.stdout.write(JSON.stringify(pointers, null, 2) + '\n');
    return 0;
  }
  if (!pointers.length) { process.stdout.write('(no matches)\n'); return 0; }
  for (const p of pointers) {
    process.stdout.write(`#${p.id}  ${p.file}:${p.line}  ${p.snippet}\n`);
  }
  return 0;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────

const USAGE = `tpm-task-export — task export + search on ONE selector core
  (run: npx tpm task <export|search> [--tasks-dir <dir>] [SELECTORS…] [SHAPE…])

  --tasks-dir <dir>        OPTIONAL (F4): omitted → resolved from the LOCAL project's
                           .claude/claude-tpm/config.json (tasks.tasksDir); the flag OVERRIDES; with
                           NEITHER the run FAILS LOUD (never defaults to a live store).

Selectors (AND together):
  <id|LO-HI>…              explicit ids and/or ranges (also the comma form "1112,1119")
  --state <s>[,<s>]        open|in-progress|finished|dropped|removed
  --open                   sugar: open + in-progress
  --closed                 sugar: finished + dropped
  --label <l>              by label (repeatable; AND)
  --match <text>           substring over headline + summary + context (opens bodies)
  --opened-since <Nd|date> createdAt window (also --opened-after / --opened-before <date>)
  --updated-since <Nd|date>  updatedAt window
  --closed-since <Nd|date>   endedAt window
  --last <N> [--by updated|created|closed]   the N most-recent matching (default: updated)
  <Nd|Nh|Nw> relative OR YYYY-MM-DD.  An invalid window is an EXIT-2 usage error.

Shape (export):
  --json / --human         records vs. rendered bodies (default: --human to stdout)
  --combined (default)     JSON = a bare array of envelopes; human = each body's full render
  --per-file --out <dir>   one task-<id>.{json,md} per task
  --thin                   drop history[] (model.stripHistory)
  --out <dir|file>         write here instead of stdout
  --now <iso>              reference time for windows + human ages (default: now)

search emits id·file·line·snippet pointers (plain, or --json) over the IDENTICAL selectors.`;

function main(argv) {
  const args = argv.slice();
  let mode = 'export';
  if (args[0] === 'export' || args[0] === 'search') mode = args.shift();
  else if (args[0] === '-h' || args[0] === '--help') { process.stdout.write(USAGE + '\n'); return 0; }

  try {
    return mode === 'search' ? runSearch(args) : runExport(args);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (e && e.usageExit) {
      // Bad window / id / flag — a USAGE error, never a silent empty result (#1092-I).
      process.stderr.write('tpm-task-export: ' + msg + '\n\n' + USAGE + '\n');
      return 2;
    }
    process.stderr.write('tpm-task-export: ' + msg + '\n'); // runtime (IO / bad store)
    return 1;
  }
}

module.exports = {
  buildSelector,
  selectCandidates,
  matchesRow,
  parseWindow,
  parseIdTokens,
  runExport,
  runSearch,
  pointerFor,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
