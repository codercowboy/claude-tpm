#!/usr/bin/env node
'use strict';
/**
 * tpm-task.js — the JSON-backed task VERB tool for `kind:"task"` records (P06).
 *
 * The capstone that makes the JSON-first task tooling usable end-to-end against a SCRATCH (or real)
 * tasks dir. Composes the blessed shared pieces — it re-implements NONE of the model / converter / IO:
 *   - `lib/task-model.js`     · loadTask / saveTask / lifecycle ops / subtask ops / import* / index
 *   - `lib/task-converter.js` · render(record,{now}) + renderIndexView(indexObj,{states,now}) — PURE
 *   - `tpm-task-config.js`    · the #1109 history gate (setHistoryEnabled from resolved config)
 *
 * ── VERBS (each MUTATION: load → mutate via the model → saveTask, which writes the canonical JSON
 *    ATOMICALLY first, then regenerates the derived body .md + the machine tasks-index.json + the
 *    three human index .md views via the INJECTED converter) ──
 *   list        — the human index view(s) for a state set (default open+in-progress).
 *   show        — the rendered body .md for a task id.
 *   add         — mint a task (id allocated from the store high-water); #1107 --body-txt-file supported.
 *   edit        — rewrite editable scalar fields (headline/labels/summary/context); #1107 --body-txt-file.
 *   import      — #1106 JSON import/apply: sets ONLY editable fields, IGNORES mechanical (state/
 *                 timestamps/id/history/endAction); full-body swap; subtasks = bulk-replace-by-key
 *                 (keep-missing default, --prune to drop); `--template` emits a blank editable-fields JSON skeleton.
 *   check       — flip a subtask to done (mechanical; the only per-item state verb here).
 *   add-subtask — append an open subtask.
 *   start/finish/drop/remove/reopen — lifecycle transitions. finish carries the #1111 CLOSE-GUARD
 *                 (refused while any subtask is open, names blockers); illegal moves rejected (G3).
 *   reindex     — rebuild tasks-index.json + the human views from the *.json bodies.
 *   history     — read-only: print the #1109 history events for a task.
 *
 * export / search are PHASE 07 (`tpm-task-export.js`) — this tool routes them to a friendly notice.
 *
 * ── F3 (null summary/context) — RESOLVED at this op layer: COERCE-TO-ABSENT (lenient). ──
 * A supplied `null` (or a cleared field) for `summary`/`context` is ACCEPTED, stored as `null`, and
 * rendered `_None yet._` by the converter. It is NEVER rejected and NEVER crashes. This matches the
 * task-schema (which treats null as "absent") and the model (which passes null straight through), so
 * a JSON round-trip that clears a prose field just clears it. Rationale: import is an ergonomic bulk
 * edit; rejecting a null the user legitimately meant as "empty this" would be hostile, and the
 * derived body already shows the field as empty. (decisions.md F3; 04 HANDOFF.)
 *
 * ── SCRATCH-STORE DISCIPLINE ── every verb writes ONLY where --tasks-dir points. The tool NEVER
 * defaults to the live `.claude/claude-tpm/tasks/`; --tasks-dir is REQUIRED for every store op.
 *
 * ── NODE-INVOKABLE ── `node tpm-task.js <verb> --tasks-dir <dir> …`. Programmatic callers require()
 * the `op*` functions. Zero third-party deps; Node built-ins only.
 */
const fs = require('fs');

const model = require('./lib/task-model');
const converter = require('./lib/task-converter');
const { nowIsoTz } = require('./lib/base').timestamp;
const config = require('./tpm-task-config');
const schema = require('./lib/task-schema');

// ── shared save path ───────────────────────────────────────────────────────────

/**
 * persist(record, { tasksDir }) -> record
 * The single save path every mutating verb funnels through: saveTask writes the canonical JSON
 * atomically FIRST, then regenerates the derived body .md (via converter.render), the machine
 * tasks-index.json, and the three human index .md views (via converter.renderIndexView). jsonPath +
 * mdPath default off tasksDir + id (thousand-bucketed). Returns the persisted record.
 */
function persist(record, o) {
  if (!o || !o.tasksDir) throw new Error('tpm-task: --tasks-dir <dir> is required (scratch or real store)');
  return model.saveTask(record, {
    tasksDir: o.tasksDir,
    render: converter.render,             // body .md — now optional (body carries no relative age)
    indexRender: converter.renderIndexView, // three human index views (writeIndexViews injects {states,now})
  });
}

/** loadCurrent(tasksDir, id) -> record — fail-loud via the model's canonical load path. */
function loadCurrent(tasksDir, id) {
  if (!tasksDir) throw new Error('tpm-task: --tasks-dir <dir> is required');
  if (id === undefined || id === null || String(id) === '') throw new Error('tpm-task: a task id is required');
  return model.loadTask(model.bodyPathFor(tasksDir, model.canonicalId(id)));
}

// ── labels helper ────────────────────────────────────────────────────────────────

/** Combine repeated --label + a --labels csv into an array (or undefined when none supplied). */
function collectLabels(args) {
  const out = [];
  if (Array.isArray(args.labels)) for (const l of args.labels) if (l != null) out.push(String(l));
  if (typeof args.labelsCsv === 'string') {
    for (const part of args.labelsCsv.split(',')) {
      const t = part.trim();
      if (t !== '') out.push(t);
    }
  }
  return out.length || args.labels.length || args.labelsCsv !== undefined ? out : undefined;
}

// ── OPS (require()-able; return the persisted / loaded record) ────────────────────

/**
 * opAdd({ tasksDir, headline, labels?, summary?, context?, id?, bodyTxtFile?, field? }) -> record
 * Mint a fresh task (id allocated from the store high-water unless `id` given) and persist. #1107:
 * `bodyTxtFile` reads a raw text file verbatim into summary|context (field default "summary").
 */
function opAdd(opts) {
  const o = opts || {};
  let record = model.openTask({
    id: o.id,
    headline: o.headline,
    labels: o.labels,
    summary: o.summary,
    context: o.context,
    tasksDir: o.tasksDir,      // allocate id from the high-water when no id given
  });
  if (o.bodyTxtFile) {
    const field = o.field || 'summary';
    record = model.importBodyText(record, { field, text: readFileText(o.bodyTxtFile) });
  }
  return persist(record, o);
}

/**
 * opEdit({ tasksDir, id, headline?, labels?, summary?, context?, bodyTxtFile?, field? }) -> record
 * Rewrite ONLY the editable scalar fields that were supplied (applyTask filters via EDITABLE_TABLE;
 * mechanical fields are never touched). #1107: `bodyTxtFile` overwrites summary|context verbatim.
 * A supplied `null` summary/context clears the field (F3 coerce-to-absent).
 */
function opEdit(opts) {
  const o = opts || {};
  let record = loadCurrent(o.tasksDir, o.id);
  const patch = {};
  if (o.headline !== undefined) patch.headline = o.headline;
  if (o.labels !== undefined) patch.labels = o.labels;
  if (o.summary !== undefined) patch.summary = o.summary;   // null allowed (F3)
  if (o.context !== undefined) patch.context = o.context;   // null allowed (F3)
  if (Object.keys(patch).length) record = model.applyTask(record, patch);
  if (o.bodyTxtFile) {
    const field = o.field || 'summary';
    record = model.importBodyText(record, { field, text: readFileText(o.bodyTxtFile) });
  }
  return persist(record, o);
}

/**
 * opImport({ tasksDir, id, file?, jsonText?, prune? }) -> record   (#1106)
 * Apply an edited JSON patch (from `file`, or the `jsonText` string) to a task: sets ONLY the
 * editable fields (headline/labels/summary/context) and — when `subtasks` is present — bulk-replaces
 * the subtask set matched by key (keep-missing default per OQ1; `prune:true` removes record-only
 * subtasks). EVERY mechanical field in the JSON (id/state/timestamps/endAction/history) is IGNORED. Accepts a bare
 * editable-fields object OR a FULL exported task record (full-body swap — mechanical fields dropped).
 */
function opImport(opts) {
  const o = opts || {};
  const raw = o.jsonText !== undefined ? o.jsonText : readFileText(o.file);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`import: ${o.file ? `'${o.file}'` : 'input'} is not valid JSON: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('import: JSON must be an object (editable fields OR a full task record)');
  }
  let record = loadCurrent(o.tasksDir, o.id);
  // Scalar editables + their edit history (applyTask ignores mechanical keys by construction).
  record = model.applyTask(record, parsed);
  // Subtasks: bulk-replace-by-key with prune control (the CLI's --prune drives it; default keep-missing per OQ1).
  if (Array.isArray(parsed.subtasks)) {
    const prune = o.prune === true;
    record = model.importSubtasks(record, parsed.subtasks, { prune });
  }
  return persist(record, o);
}

/**
 * blankTemplate() -> string — a blank editable-fields JSON skeleton (D3 set only) to fill + re-import.
 * Emits ONLY import-editable fields — never a mechanical field — so a filled template is safe to
 * `import` verbatim.
 */
function blankTemplate() {
  return JSON.stringify(
    {
      headline: '',
      labels: [],
      summary: '',
      context: '',
      subtasks: [{ key: 'A', text: '' }],
    },
    null,
    2,
  ) + '\n';
}

/** opAddSubtask({ tasksDir, id, text, key? }) -> record. */
function opAddSubtask(opts) {
  const o = opts || {};
  if (o.text === undefined || o.text === null || String(o.text) === '') {
    throw new Error('add-subtask: --text "<subtask>" is required');
  }
  let record = loadCurrent(o.tasksDir, o.id);
  record = model.addSubtask(record, { text: o.text, key: o.key });
  return persist(record, o);
}

/** opCheck({ tasksDir, id, key }) -> record — flip a subtask to done. */
function opCheck(opts) {
  const o = opts || {};
  if (o.key === undefined || o.key === null || String(o.key) === '') {
    throw new Error('check: a subtask key is required (`check <id> <key>` or --key <k>)');
  }
  let record = loadCurrent(o.tasksDir, o.id);
  record = model.checkSubtask(record, o.key);
  return persist(record, o);
}

/**
 * opTransition(verb, { tasksDir, id, action?, note?, refs? }) -> record
 * start/finish/drop/remove/reopen. finish enforces the #1111 close-guard (model throws, naming
 * blockers); illegal moves throw (G3). `action`/`note`/`refs` fill the #1074 close-time endAction
 * on finish/drop (CLOSE-TIME ONLY — no mid-life note surface, T-Q2).
 */
function opTransition(verb, opts) {
  const o = opts || {};
  const end = { action: o.action, note: o.note, refs: o.refs };
  let record = loadCurrent(o.tasksDir, o.id);
  switch (verb) {
    case 'start': record = model.startTask(record); break;
    case 'finish': record = model.finishTask(record, end); break;
    case 'drop': record = model.dropTask(record, end); break;
    case 'remove': record = model.removeTask(record); break;
    case 'reopen': record = model.reopenTask(record); break;
    default: throw new Error(`transition: unknown verb '${verb}'`);
  }
  return persist(record, o);
}

/**
 * opHardRemove({ tasksDir, id, config? }) -> { id } (the hard-deleted id)
 *
 * The `remove --hard` PURGE (#1086, ported #1123): permanently deletes the task's canonical JSON body
 * (+ its derived `.md` sibling) and rebuilds the index/views so the row is gone — UNRECOVERABLE, unlike
 * the soft-stash `remove` (which only flips state → removed). CONFIG-GATED: refuses unless the resolved
 * `tasks.allowHardDelete` is exactly `true`. Default is OFF/safe (#1086) — a config-resolution failure
 * or an absent/false key REFUSES loud, naming the config key. `reindex` preserves the nextId high-water,
 * so a purged top id is never reissued.
 */
function opHardRemove(opts) {
  const o = opts || {};
  if (!o.tasksDir) throw new Error('tpm-task: --tasks-dir <dir> is required (scratch or real store)');
  if (o.id === undefined || o.id === null || String(o.id) === '') throw new Error('tpm-task: a task id is required');
  const id = model.canonicalId(o.id);

  // CONFIG GATE — fail SAFE: refuse unless allowHardDelete is explicitly true.
  let allow = false;
  try {
    const { resolved } = config.resolveTasksConfig(o.config);
    allow = !!(resolved && resolved.allowHardDelete === true);
  } catch (_) {
    allow = false; // a config-resolution failure must never silently enable a destructive purge.
  }
  if (!allow) {
    throw new Error(
      `hard delete is disabled by config (tasks.allowHardDelete is not true). #${id} not touched. ` +
      'Set "tasks": { "allowHardDelete": true } in config.json to enable --hard, or use `remove` (soft-stash, recoverable).',
    );
  }

  const jsonPath = model.bodyPathFor(o.tasksDir, id);
  if (!fs.existsSync(jsonPath)) throw new Error(`no task #${id} found.`);
  const mdPath = jsonPath.replace(/\.json$/, '.md');

  fs.unlinkSync(jsonPath);                       // purge the canonical body — unrecoverable.
  try { if (fs.existsSync(mdPath)) fs.unlinkSync(mdPath); } catch (_) { /* derived .md is disposable */ }

  // Rebuild the machine index + the three human views from the SURVIVING bodies (row now gone).
  const idx = model.reindex(o.tasksDir);
  model.writeIndexViews(o.tasksDir, idx, converter.renderIndexView);
  return { id };
}

// ── label ops (#1071) ─────────────────────────────────────────────────────────────

/** opLabel({ tasksDir, id, labels }) -> record — union `labels` onto the task's labels[] (dedup). */
function opLabel(opts) {
  const o = opts || {};
  const labels = Array.isArray(o.labels) ? o.labels : [];
  if (!labels.length) throw new Error('label: at least one label is required (`label <id> <label…>` or --label L)');
  let record = loadCurrent(o.tasksDir, o.id);
  record = model.addLabels(record, labels);
  return persist(record, o);
}

/** opUnlabel({ tasksDir, id, labels }) -> record — drop `labels` from the task's labels[]. */
function opUnlabel(opts) {
  const o = opts || {};
  const labels = Array.isArray(o.labels) ? o.labels : [];
  if (!labels.length) throw new Error('unlabel: at least one label is required (`unlabel <id> <label…>` or --label L)');
  let record = loadCurrent(o.tasksDir, o.id);
  record = model.removeLabels(record, labels);
  return persist(record, o);
}

/**
 * opLabels({ tasksDir }) -> { label, ids }[]  — the label→id-set reverse index (from tasks-index.json),
 * as sorted rows. Read-only; reads the derived `labels` map, falling back to deriving it from rows when
 * an older index predates the map (so `labels` works before the first re-save/reindex).
 */
function opLabels(opts) {
  const o = opts || {};
  if (!o.tasksDir) throw new Error('labels: --tasks-dir <dir> is required');
  const idx = model.readIndex(o.tasksDir);
  const map = idx && idx.labels && typeof idx.labels === 'object'
    ? idx.labels
    : model.deriveLabelIndex(Array.isArray(idx.tasks) ? idx.tasks : []);
  return Object.keys(map).sort().map((label) => ({ label, ids: Array.isArray(map[label]) ? map[label] : [] }));
}

/** opReindex({ tasksDir }) -> indexObj — rebuild the machine index + the human views from bodies. */
function opReindex(opts) {
  const o = opts || {};
  if (!o.tasksDir) throw new Error('reindex: --tasks-dir <dir> is required');
  const idx = model.reindex(o.tasksDir);
  model.writeIndexViews(o.tasksDir, idx, converter.renderIndexView);
  return idx;
}

/** opHistory({ tasksDir, id }) -> event[] — the read-only #1109 history surface. */
function opHistory(opts) {
  const o = opts || {};
  const record = loadCurrent(o.tasksDir, o.id);
  return model.readHistory(record);
}

/**
 * opList({ tasksDir, states, labels?, now }) -> string — the human index view for a state set.
 * `labels` (#1071) is an optional AND filter: only rows carrying EVERY requested label survive (the
 * index rows are pre-filtered before the state-scoped render, so `list --label` composes with --state).
 */
function opList(opts) {
  const o = opts || {};
  if (!o.tasksDir) throw new Error('list: --tasks-dir <dir> is required');
  let idx = model.readIndex(o.tasksDir);
  const states = Array.isArray(o.states) && o.states.length ? o.states : ['open', 'in-progress'];
  const want = Array.isArray(o.labels) ? o.labels.filter((l) => l != null && String(l) !== '') : [];
  if (want.length) {
    const rows = (Array.isArray(idx.tasks) ? idx.tasks : []).filter((r) => {
      const have = Array.isArray(r.labels) ? r.labels : [];
      return want.every((l) => have.includes(String(l)));
    });
    idx = Object.assign({}, idx, { tasks: rows });
  }
  return converter.renderIndexView(idx, { states, now: o.now || nowIsoTz() });
}

/** opShow({ tasksDir, id, now }) -> string — the rendered body .md for a task. */
function opShow(opts) {
  const o = opts || {};
  const record = loadCurrent(o.tasksDir, o.id);
  return converter.render(record, { now: o.now || nowIsoTz() });
}

// ── file read helper ──────────────────────────────────────────────────────────────

function readFileText(file) {
  if (!file) throw new Error('a file path is required');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`cannot read file '${file}': ${e.message}`);
  }
}

// stdin read (for `import` with no --file) — returns '' when nothing is piped.
function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

// ── state selector ──────────────────────────────────────────────────────────────

/** Map a --state arg to the state set the list/index view shows. */
function statesFor(stateArg) {
  if (!stateArg) return ['open', 'in-progress'];
  const s = String(stateArg).toLowerCase();
  if (s === 'all') return schema.STATES.slice();
  if (s === 'wip') return ['in-progress'];
  if (s === 'open+wip' || s === 'active') return ['open', 'in-progress'];
  if (schema.STATES.includes(s)) return [s];
  // T-Q7: an invalid flag VALUE is misuse, not a runtime fault — tag it so main() exits 2 (uniform
  // "usage error → 2", the same e.usageExit idiom as tpm-task-export.js), rather than the dispatch-1.
  const err = new Error(`--state: unknown state '${stateArg}' (one of ${schema.STATES.join('|')}|all)`);
  err.usageExit = true;
  throw err;
}

// ── CLI ────────────────────────────────────────────────────────────────────────

const SUBCOMMANDS = [
  'list', 'show', 'add', 'import', 'edit', 'check', 'add-subtask',
  'start', 'finish', 'drop', 'remove', 'reopen', 'reindex', 'history',
  'label', 'unlabel', 'labels',   // #1071 label verbs
];
// export/search live in phase 07 — recognised so we can print a helpful pointer, not silently fail.
const PHASE07 = ['export', 'search'];

function parseArgs(argv) {
  const globals = {};
  const args = { labels: [], refs: [], positional: [] };
  let sub = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      i += 1;
      return argv[i];
    };
    if (sub === null) {
      if (a === '--help' || a === '-h') globals.help = true;
      else if (a === '--tasks-dir') globals.tasksDir = val();
      else if (a === '--config') globals.config = val();
      else if (a === '--history') globals.history = val();
      else if (a === '--now') globals.now = val();
      else if (SUBCOMMANDS.includes(a) || PHASE07.includes(a)) sub = a;
      else if (a.startsWith('-')) throw new Error(`unknown global flag '${a}'`);
      else { globals.badSub = a; sub = '__bad__'; }
      continue;
    }
    switch (a) {
      case '--help': case '-h': args.help = true; break;
      case '--tasks-dir': globals.tasksDir = val(); break;
      case '--config': globals.config = val(); break;
      case '--history': globals.history = val(); break;
      case '--now': globals.now = val(); break;
      case '--headline': args.headline = val(); break;
      case '--label': args.labels.push(val()); break;
      case '--labels': args.labelsCsv = val(); break;
      case '--summary': args.summary = val(); break;
      case '--context': args.context = val(); break;
      case '--body-txt-file': args.bodyTxtFile = val(); break;
      case '--field': args.field = val(); break;
      case '--file': case '--from': args.file = val(); break;
      case '--template': args.template = true; break;
      case '--prune': args.prune = true; break;
      case '--key': args.key = val(); break;
      case '--text': args.text = val(); break;
      case '--action': args.action = val(); break;
      case '--note': args.note = val(); break;        // #1074: close-time resolution note
      case '--ref': args.refs.push(val()); break;     // #1074: repeatable provenance ref (→ refs[])
      case '--reason': args.action = val(); break;    // drop alias (endAction.action)
      case '--state': args.state = val(); break;
      case '--json': args.json = true; break;
      case '--id': args.id = val(); break;
      case '--hard': args.hard = true; break;    // remove --hard: config-gated permanent purge (#1086)
      default:
        if (a.startsWith('-')) throw new Error(`unknown flag '${a}'`);
        args.positional.push(a);
    }
  }
  return { globals, sub, args };
}

const USAGE = `tpm-task — JSON-backed task verbs (run: node tpm-task.js <verb> --tasks-dir <dir> …)

Common:  --tasks-dir <dir>   the task store (a SCRATCH or real dir; REQUIRED — never defaults to live)
         --config <path>     config.json for the #1109 history gate (default: <root>/.claude/…/config.json)
         --history on|off    override the history gate for this run
         --now <iso>         reference time for list/show ages (default: now, local offset)

Verbs:
  list          [--state open|in-progress|finished|dropped|removed|all] [--label L]…  (--label is AND)
  show          <id>
  add           --headline "…" [--label L]… [--labels "a,b"] [--summary "…"] [--context "…"]
                   [--body-txt-file <f> --field summary|context] [--id <id>]
  edit          <id> [--headline …] [--label L]… [--summary …] [--context …]
                   [--body-txt-file <f> --field summary|context]
  import        <id> (--file <f> | stdin) [--prune]          #1106 JSON import (editable fields only)
  import        --template                                    emit a blank editable-fields JSON skeleton
  add-subtask   <id> --text "…" [--key K]
  check         <id> <key>                                    flip a subtask to done
  label         <id> <label…>                                 add label(s) to a task (also --label L)
  unlabel       <id> <label…>                                 remove label(s) from a task
  labels        [--json]                                      list every label + its task ids (reverse index)
  start         <id>
  finish        <id> [--action "…"] [--note "…"] [--ref "…"]… REFUSED while any subtask is open (#1111)
  drop          <id> [--reason "…"] [--note "…"] [--ref "…"]…  --ref repeatable → endAction.refs[] (#1074)
  remove        <id> [--hard]                                 soft-stash → removed (recoverable); --hard PURGES the body (config-gated: tasks.allowHardDelete)
  reopen        <id>
  reindex                                                     rebuild tasks-index.json + human views
  history       <id> [--json]                                 read the #1109 history events

Every mutation writes the canonical task-<id>.json atomically, then regenerates the derived body .md,
the machine tasks-index.json, and the three human index .md views. Import IGNORES mechanical fields
(id/state/timestamps/history/endAction); state moves only via the lifecycle verbs (G3 enforced).
export / search are phase 07 (tpm-task-export.js).`;

function applyHistoryGate(globals) {
  // Explicit --history wins; else resolve config (tolerant — default ON if resolution fails).
  if (globals.history === 'off' || globals.history === 'false') { model.setHistoryEnabled(false); return; }
  if (globals.history === 'on' || globals.history === 'true') { model.setHistoryEnabled(true); return; }
  try {
    const { resolved } = config.resolveTasksConfig(globals.config);
    const enabled = resolved && resolved.history ? resolved.history.enabled : true;
    model.setHistoryEnabled(enabled !== false);
  } catch (_) {
    model.setHistoryEnabled(true);   // never let config resolution failure break a store op
  }
}

function resolveId(args) {
  return args.id !== undefined ? args.id : args.positional[0];
}

/**
 * labelArgsFor(args) -> string[] — the labels for a `label`/`unlabel` verb: positionals AFTER the id
 * (or ALL positionals when the id came from --id) PLUS any --label / --labels flags. Order preserved.
 */
function labelArgsFor(args) {
  const fromPositional = args.id !== undefined ? args.positional.slice() : args.positional.slice(1);
  const fromFlags = collectLabels(args) || [];
  return fromPositional.concat(fromFlags);
}

function dispatch(sub, globals, args) {
  const tasksDir = globals.tasksDir;
  const now = globals.now;
  const common = { tasksDir, now };
  switch (sub) {
    case 'list':
      process.stdout.write(opList({ tasksDir, states: statesFor(args.state), labels: collectLabels(args), now }));
      return 0;
    case 'show':
      process.stdout.write(opShow(Object.assign({ id: resolveId(args) }, common)));
      return 0;
    case 'add': {
      const rec = opAdd(Object.assign({
        headline: args.headline, labels: collectLabels(args), summary: args.summary,
        context: args.context, id: args.id, bodyTxtFile: args.bodyTxtFile, field: args.field,
      }, common));
      process.stderr.write(`tpm-task add: created task #${rec.id} (state ${rec.state}).\n`);
      return 0;
    }
    case 'edit': {
      const patch = { id: resolveId(args), bodyTxtFile: args.bodyTxtFile, field: args.field };
      if (args.headline !== undefined) patch.headline = args.headline;
      if (args.labelsCsv !== undefined || args.labels.length) patch.labels = collectLabels(args);
      if (args.summary !== undefined) patch.summary = args.summary;
      if (args.context !== undefined) patch.context = args.context;
      const rec = opEdit(Object.assign(patch, common));
      process.stderr.write(`tpm-task edit: updated task #${rec.id}.\n`);
      return 0;
    }
    case 'import': {
      if (args.template) { process.stdout.write(blankTemplate()); return 0; }
      const jsonText = args.file ? undefined : readStdin();
      const rec = opImport(Object.assign({
        id: resolveId(args), file: args.file, jsonText, prune: !!args.prune,
      }, common));
      process.stderr.write(`tpm-task import: applied editable fields to task #${rec.id} ` +
        `(${args.prune ? 'prune' : 'keep-missing'} subtasks).\n`);
      return 0;
    }
    case 'add-subtask': {
      const rec = opAddSubtask(Object.assign({ id: resolveId(args), text: args.text, key: args.key }, common));
      const last = rec.subtasks[rec.subtasks.length - 1];
      process.stderr.write(`tpm-task add-subtask: added subtask ${last.key} to task #${rec.id}.\n`);
      return 0;
    }
    case 'check': {
      const key = args.key !== undefined ? args.key : args.positional[1];
      const rec = opCheck(Object.assign({ id: resolveId(args), key }, common));
      process.stderr.write(`tpm-task check: subtask ${key} of #${rec.id} marked done.\n`);
      return 0;
    }
    case 'start': case 'finish': case 'drop': case 'remove': case 'reopen': {
      if (sub === 'remove' && args.hard) {
        const res = opHardRemove(Object.assign({ id: resolveId(args), config: globals.config }, common));
        process.stderr.write(`tpm-task remove --hard: HARD-DELETED #${res.id} — body removed, unrecoverable.\n`);
        return 0;
      }
      const rec = opTransition(sub, Object.assign({ id: resolveId(args), action: args.action, note: args.note, refs: args.refs }, common));
      process.stderr.write(`tpm-task ${sub}: task #${rec.id} is now ${rec.state}.\n`);
      return 0;
    }
    case 'label': {
      const labels = labelArgsFor(args);
      const rec = opLabel(Object.assign({ id: resolveId(args), labels }, common));
      process.stderr.write(`tpm-task label: #${rec.id} labels now [${(rec.labels || []).join(', ')}].\n`);
      return 0;
    }
    case 'unlabel': {
      const labels = labelArgsFor(args);
      const rec = opUnlabel(Object.assign({ id: resolveId(args), labels }, common));
      process.stderr.write(`tpm-task unlabel: #${rec.id} labels now [${(rec.labels || []).join(', ')}].\n`);
      return 0;
    }
    case 'labels': {
      const rows = opLabels(common);
      if (args.json) process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      else if (!rows.length) process.stdout.write('(no labels)\n');
      else for (const r of rows) process.stdout.write(`${r.label} (${r.ids.length}): ${r.ids.map((i) => '#' + i).join(', ')}\n`);
      return 0;
    }
    case 'reindex': {
      const idx = opReindex(common);
      process.stderr.write(`tpm-task reindex: rebuilt index for ${idx.tasks.length} task(s); nextId ${idx.nextId}.\n`);
      return 0;
    }
    case 'history': {
      const events = opHistory(Object.assign({ id: resolveId(args) }, common));
      if (args.json) process.stdout.write(JSON.stringify(events, null, 2) + '\n');
      else {
        if (!events.length) process.stdout.write('(no history events)\n');
        else for (const ev of events) process.stdout.write(formatHistory(ev) + '\n');
      }
      return 0;
    }
    case 'export': case 'search':
      process.stderr.write(`tpm-task: '${sub}' is phase 07 — use tpm-task-export.js (not built in this tool).\n`);
      return 2;
    default:
      throw new Error(`unknown verb '${sub}'`);
  }
}

function formatHistory(ev) {
  const at = ev.at || '?';
  if (ev.op === 'create') return `${at}  create`;
  if (ev.op === 'edit') return `${at}  edit ${ev.field}`;
  if (ev.op === 'state') return `${at}  state ${ev.from} → ${ev.to}`;
  if (ev.op === 'subtask') return `${at}  subtask ${ev.key} ${ev.action}`;
  return `${at}  ${ev.op || '?'}`;
}

function main(argv) {
  if (!argv.length) { process.stdout.write(USAGE + '\n'); return 1; }
  // export / search are owned by tpm-task-export.js (P07, the ONE selector core). Delegate the RAW
  // argv before parseArgs (whose flag set does not include the export/search selectors). The `tpm`
  // router forwards them straight to the export tool; this covers a direct `node tpm-task.js export …`.
  if (argv[0] === 'export' || argv[0] === 'search') {
    const { spawnSync } = require('child_process');
    const tool = require('path').join(__dirname, 'tpm-task-export.js');
    const r = spawnSync('node', [tool, ...argv], { stdio: 'inherit' });
    if (r.error) { process.stderr.write(`tpm-task: failed to run '${argv[0]}': ${r.error.message}\n`); return 1; }
    return r.status == null ? 1 : r.status;
  }
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    process.stderr.write('tpm-task: ' + String(e.message) + '\n\n' + USAGE + '\n');
    return 2;
  }
  const { globals, sub, args } = parsed;
  if (globals.help || (!sub && !globals.badSub)) { process.stdout.write(USAGE + '\n'); return globals.help ? 0 : 1; }
  if (globals.badSub) { process.stderr.write(`tpm-task: unknown verb '${globals.badSub}' — see --help.\n`); return 2; }
  if (args.help) { process.stdout.write(USAGE + '\n'); return 0; }

  applyHistoryGate(globals);
  try {
    return dispatch(sub, globals, args);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (e && e.usageExit) { // T-Q7: a flag-VALUE misuse (e.g. an invalid --state) is a usage error → 2
      process.stderr.write('tpm-task: ' + msg + '\n\n' + USAGE + '\n');
      return 2;
    }
    process.stderr.write('tpm-task: ' + msg + '\n');
    return 1;
  }
}

module.exports = {
  // ops
  opAdd, opEdit, opImport, opAddSubtask, opCheck, opTransition, opHardRemove, opReindex, opHistory, opList, opShow,
  opLabel, opUnlabel, opLabels,
  // helpers (exported for tests)
  persist, loadCurrent, blankTemplate, collectLabels, labelArgsFor, statesFor, parseArgs, main,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
