'use strict';
/**
 * task-converter.js — the PURE JSON→human render layer for `kind:"task"` records (P05).
 *
 * Replaces today's surgical-in-place `tpm-task-format.js`: bodies are DERIVED now (format-spec D1),
 * so this module owns the one-way JSON→markdown projection. Mirrors
 * `../../20260919-session-features/session-tooling/lib/session-converter.js`; reaches the shared
 * base lib (hash) through the ONE indirection `./base` (task-tooling convention — the base lib is
 * the single physical copy under session-tooling/lib, referenced in place, 01-plan §3).
 *
 * TWO pure render fns (build-plan §6.05 / §7.3 — the human index .md views are converter output
 * that both saveTask (P06) and export (P07) inject):
 *
 *   render(record, { now }) -> string
 *     the derived body `task-<id>.md`: banner comment + `generated from: <12hex>` content-hash line,
 *     `# #<id> · <headline>`, State/Labels/Created landmarks, Summary, Context, a
 *     `**Subtasks:** (done/total)` checkbox block, and a one-line history pointer.
 *
 *   renderIndexView(indexObj, { states, now }) -> string
 *     one human index `.md`: `tasks-index.json` rows filtered by `states`, as a
 *     `| # | State | Created | Task |` table (task cell = `(done/total)` + labels), with `Next ID:`
 *     in a wayfinding comment. saveTask writes the three views (open+in-progress /
 *     finished∪dropped / removed) through this one fn.
 *
 * ── PURITY (DoD row 1) ──
 * Both fns are pure: no `fs`, no clock, no mutation of the input. Any relative AGE is computed
 * against an INJECTED reference time (`opts.now`, an ISO local-offset string OR a Date) — the
 * converter NEVER reads the clock, so goldens are byte-stable and two calls on the same inputs
 * return identical output. The body carries no relative age today (subtasks have no timestamp), so
 * `render` tolerates a missing `now`; `renderIndexView`'s Created column is relative, so it REQUIRES
 * `now` whenever it emits a row (loud throw otherwise — session `ageOf` discipline).
 *
 * ── PAYLOAD SHAPE (04-task-model HANDOFF) ──
 * For `kind:"task"` the payload IS the whole record: top-level siblings `id`/`state`/`headline`/
 * `labels`/`summary`/`context`/`subtasks`/`timestamps`/`endAction`/`history`. Read the record
 * directly (this module does). `tasks-index.json` rows are the thin `deriveRow` shape:
 * `{ id, state, headline, labels, createdAt, updatedAt, subtasks:{done,total}, path }`.
 *
 * ── HASH BANNER (DoD row 2) ──
 * The `generated from: <12hex>` token is `base.hash.hashRecord(record)` over the WHOLE canonical
 * record (the same shared algorithm session stamps + the doctor recomputes, so drift is detectable).
 * The hash is over the JSON only — it never sees this derived `.md`, so there is no self-reference.
 *
 * Zero third-party deps; Node built-ins only; loadable/inspectable via `node <file>`.
 */
const base = require('./base');
const { hashRecord } = base.hash;

const MS_MIN = 60 * 1000;
const MS_HOUR = 60 * MS_MIN;
const MS_DAY = 24 * MS_HOUR;
const MS_WEEK = 7 * MS_DAY;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyString(s) {
  return typeof s === 'string' && s.trim() !== '';
}

// "YYYY-MM-DD" from a local-offset ISO string (verbatim slice — no reparse/reproject).
function shortDate(isoTz) {
  return typeof isoTz === 'string' && isoTz.length >= 10 ? isoTz.slice(0, 10) : '????-??-??';
}

// ── render (public) — the derived body task-<id>.md ──────────────────────────

/**
 * render(record, opts?) -> string
 *   opts.now — reference time for any relative age (reserved; the body carries none today, so it is
 *              OPTIONAL). ISO-8601 local-offset string OR Date.
 *
 * Pure: reads only; never mutates `record`; never reads the clock. Sections are joined with a single
 * blank line and the file ends with exactly one trailing newline (session convention).
 */
function render(record, opts) {
  if (!isPlainObject(record)) {
    throw new Error('render: record must be an object (the full task record)');
  }
  const options = opts || {};
  const sections = [
    renderBanner(record),
    renderTitle(record),
    renderLandmarks(record),
    renderSummary(record),
    renderContext(record),
    renderResolution(record),          // #1074: close-time resolution/provenance (null → omitted)
    renderSubtasks(record, options.now),
    renderHistoryPointer(record),
  ].filter((s) => s != null);
  return sections.join('\n\n') + '\n';
}

// ── banner + hash (DoD rows 1/2) ─────────────────────────────────────────────

function renderBanner(record) {
  const id = record.id != null ? String(record.id) : '?';
  // (generated from: <12hex>): the content hash of the WHOLE canonical record (shared hash.js —
  // stamped here on every render; the task doctor recomputes it from the on-disk JSON to detect
  // human-file drift). The hash never sees this banner, so there is no self-reference.
  const gen = hashRecord(record);
  return [
    '<!-- Generated from task-' + id + '.json — do not hand-edit; regenerated and overwritten on ' +
      'every save. Change it via `tpm task` ops or import. -->',
    '<!-- generated from: ' + gen + ' -->',
  ].join('\n');
}

// ── title ────────────────────────────────────────────────────────────────────

function renderTitle(record) {
  const id = record.id != null ? String(record.id) : '?';
  const headline = nonEmptyString(record.headline) ? record.headline : '(no headline)';
  return '# #' + id + ' · ' + headline;
}

// ── State / Labels / Created landmarks ────────────────────────────────────────

function renderLandmarks(record) {
  const state = nonEmptyString(record.state) ? record.state : '?';
  const labels = Array.isArray(record.labels) ? record.labels.filter(nonEmptyString) : [];
  const labelStr = labels.length ? labels.join(', ') : '_none_';
  const created = record.timestamps ? shortDate(record.timestamps.createdAt) : '????-??-??';
  return [
    '- **State:** ' + state,
    '- **Labels:** ' + labelStr,
    '- **Created:** ' + created,
  ].join('\n');
}

// ── Summary / Context ─────────────────────────────────────────────────────────

function renderSummary(record) {
  return '## Summary\n\n' + (nonEmptyString(record.summary) ? record.summary : '_None yet._');
}

function renderContext(record) {
  return '## Context\n\n' + (nonEmptyString(record.context) ? record.context : '_None yet._');
}

// ── Resolution — #1074 close-time resolution/provenance (endAction) ────────────

/**
 * renderResolution(record) -> string | null
 *   The `## Resolution` section derived from `endAction` = `{action?, note?, refs:[]}` (#1074/T-Q3).
 *   Returns null when there is no endAction (an open/unresolved task) so `render` OMITS the section
 *   entirely — a closed task's outcome + provenance shows, an open task's body is unchanged. Only the
 *   keys actually present render (a bare `finish` with no flags leaves endAction null → no section).
 */
function renderResolution(record) {
  const ea = record.endAction;
  if (!isPlainObject(ea)) return null;
  const lines = [];
  if (nonEmptyString(ea.action)) lines.push('- **Action:** ' + ea.action);
  if (nonEmptyString(ea.note)) lines.push('- **Note:** ' + ea.note);
  const refs = Array.isArray(ea.refs) ? ea.refs.filter(nonEmptyString) : [];
  if (refs.length) lines.push('- **Refs:** ' + refs.join(', '));
  if (!lines.length) return null;
  return '## Resolution\n\n' + lines.join('\n');
}

// ── Subtasks — `**Subtasks:** (done/total)` checkbox block ─────────────────────

/**
 * renderSubtasks(record, now?) -> string
 *   `**Subtasks:** (done/total)` then a `- [x] KEY: text` / `- [ ] KEY: text` checkbox list.
 *   `done` = state==='done'; every other subtask renders unchecked. `now` is accepted for signature
 *   parity (a future per-subtask age would use it) but the current shape has no subtask timestamp.
 */
function renderSubtasks(record /* , now */) {
  const subs = Array.isArray(record.subtasks) ? record.subtasks : [];
  const done = subs.filter((st) => st && st.state === 'done').length;
  const header = '**Subtasks:** (' + done + '/' + subs.length + ')';
  if (!subs.length) return header + '\n\n_No subtasks._';
  const lines = subs.map((st) => {
    const box = st && st.state === 'done' ? '- [x] ' : '- [ ] ';
    const key = st && st.key != null ? String(st.key) : '?';
    const text = st && typeof st.text === 'string' ? st.text : '';
    return box + key + ': ' + text;
  });
  return header + '\n\n' + lines.join('\n');
}

// ── one-line history pointer ───────────────────────────────────────────────────

// `_History: N events — see \`tpm task history <id>\`_` (format-spec §"Derived human files").
function renderHistoryPointer(record) {
  const n = Array.isArray(record.history) ? record.history.length : 0;
  const id = record.id != null ? String(record.id) : '?';
  const noun = n === 1 ? 'event' : 'events';
  return '_History: ' + n + ' ' + noun + ' — see `tpm task history ' + id + '`._';
}

// ── renderIndexView (public) — a human index .md view ─────────────────────────

/**
 * renderIndexView(indexObj, opts) -> string
 *   opts.states — the state set this view shows (e.g. ['open','in-progress']); rows whose `state`
 *                 is not in the set are filtered out.
 *   opts.now    — reference time for the Created age column (REQUIRED when the view emits any row;
 *                 ISO local-offset string OR Date). Never reads the clock.
 *
 * Renders `tasks-index.json` → `| # | State | Created | Task |`. The Task cell carries the
 * `(done/total)` subtask hint + labels. `Next ID:` rides in a wayfinding HTML comment. Rows are
 * ordered by numeric id ascending (deterministic → byte-stable goldens). Pure.
 */
function renderIndexView(indexObj, opts) {
  if (!isPlainObject(indexObj)) {
    throw new Error('renderIndexView: indexObj must be an object (the tasks-index.json record)');
  }
  const options = opts || {};
  const states = Array.isArray(options.states) ? options.states : [];
  const stateSet = new Set(states);
  const allRows = Array.isArray(indexObj.tasks) ? indexObj.tasks : [];
  const rows = allRows
    .filter((r) => r && stateSet.has(r.state))
    .slice()
    .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));

  const nextId = indexObj.nextId != null ? String(indexObj.nextId) : '?';
  const title = '# Tasks · ' + (states.length ? states.join(', ') : '(no states)');
  const wayfind =
    '<!-- Next ID: ' + nextId + ' · generated from tasks-index.json — do not hand-edit; ' +
    'regenerated on every save. -->';

  if (!rows.length) {
    return [title, wayfind, '_No tasks in this view._'].join('\n\n') + '\n';
  }

  const head = '| # | State | Created | Task |';
  const rule = '|---|-------|---------|------|';
  const body = rows.map((r) => renderRow(r, options.now)).join('\n');
  const table = [head, rule, body].join('\n');
  return [title, wayfind, table].join('\n\n') + '\n';
}

/**
 * renderRow(row, now) -> string — one `| # | State | Created | Task |` line.
 *   Task cell = `<headline> (done/total) · <labels>` (labels omitted when none).
 *   Created cell = age of createdAt vs. now (Nm/Nh/Nd ago < 7d, absolute YYYY-MM-DD at >= 7d).
 */
function renderRow(row, now) {
  const id = row.id != null ? String(row.id) : '?';
  const state = nonEmptyString(row.state) ? row.state : '?';
  const created = ageOf(row.createdAt, now);
  const headline = nonEmptyString(row.headline) ? row.headline : '(no headline)';
  const st = isPlainObject(row.subtasks) ? row.subtasks : { done: 0, total: 0 };
  const done = Number(st.done) || 0;
  const total = Number(st.total) || 0;
  const labels = Array.isArray(row.labels) ? row.labels.filter(nonEmptyString) : [];
  let taskCell = headline + ' (' + done + '/' + total + ')';
  if (labels.length) taskCell += ' · ' + labels.join(', ');
  return '| ' + id + ' | ' + state + ' | ' + created + ' | ' + taskCell + ' |';
}

/**
 * ageOf(createdAt, now) -> string  (matches session's Q1 ruling)
 *   `Nm ago` (< 1h) · `Nh ago` (< 24h) · `Nd ago` (< 7d) · absolute `YYYY-MM-DD` at >= 7d.
 * PURE: `now` is injected; the clock is never read. `now` may be an ISO string or a Date.
 */
function ageOf(createdAt, now) {
  if (now === undefined || now === null) {
    throw new Error(
      'renderIndexView: opts.now is required to compute the Created age column (rows are present) — ' +
      'pass a reference time (ISO-8601 local-offset string or Date); the converter never reads the clock',
    );
  }
  const created = toMs(createdAt);
  const ref = toMs(now);
  if (Number.isNaN(created) || Number.isNaN(ref)) return '?';
  const diff = Math.max(0, ref - created);
  if (diff < MS_HOUR) return Math.floor(diff / MS_MIN) + 'm ago';
  if (diff < MS_DAY) return Math.floor(diff / MS_HOUR) + 'h ago';
  if (diff < MS_WEEK) return Math.floor(diff / MS_DAY) + 'd ago';
  return shortDate(typeof createdAt === 'string' ? createdAt : new Date(created).toISOString());
}

function toMs(t) {
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'string') {
    const ms = Date.parse(t); // ISO-8601 with an explicit offset parses deterministically.
    return Number.isNaN(ms) ? NaN : ms;
  }
  return NaN;
}

module.exports = {
  render,
  renderIndexView,
  // Internals exported for unit tests only (not part of the public surface).
  _ageOf: ageOf,
  _renderSubtasks: renderSubtasks,
  _renderRow: renderRow,
  _renderResolution: renderResolution,
};

// `node lib/task-converter.js` → a tiny self-render smoke (loadable/inspectable per convention).
if (require.main === module) {
  const demo = {
    schemaVersion: '1.0.0', kind: 'task', id: '9999', state: 'open',
    headline: 'self-check', labels: ['demo'], summary: 's', context: 'c',
    subtasks: [{ key: 'A', text: 'do it', state: 'open' }],
    timestamps: { createdAt: '2026-09-20T09:00:00-07:00', updatedAt: '2026-09-20T09:00:00-07:00', startedAt: null, endedAt: null, reopenedAt: null },
    endAction: null, history: [{ at: '2026-09-20T09:00:00-07:00', op: 'create' }],
  };
  process.stdout.write(render(demo) + '\n');
  const idx = { schemaVersion: '1.0.0', kind: 'task-index', nextId: '10000', startId: '1000', counts: {}, tasks: [demo].map((r) => ({ id: r.id, state: r.state, headline: r.headline, labels: r.labels, createdAt: r.timestamps.createdAt, updatedAt: r.timestamps.updatedAt, subtasks: { done: 0, total: 1 }, path: 'bodies/9000-9999/task-9999.json' })) };
  process.stdout.write(renderIndexView(idx, { states: ['open', 'in-progress'], now: '2026-09-20T15:00:00-07:00' }) + '\n');
  console.log('task-converter.js OK — render + renderIndexView produced output');
}
