#!/usr/bin/env node
/**
 * tpm-task.js — the tpm-task tool: a portable, zero-dependency CLI over a per-task-file store.
 *
 * The tool owns ALL deterministic mechanics (parse/filter/sort/age/render/CRUD/ID-alloc/index
 * rebuild/resolve/import/export); the /tpm-task skill owns judgment (interpret intent, draft
 * content, confirm destructive ops). This is the ONE write path — the skill hands it payloads,
 * never hand-writes the store. Files are always plain, hand-editable markdown; the tool parses
 * LENIENTLY by landmark, normalizes managed lines on write, and PRESERVES unmanaged human prose
 * (see tpm-task-format.js — the surgical in-place rewrite that makes that hold).
 *
 * SUBCOMMANDS (14 = 12 user modes + resolve/reindex tool-internal)
 *   list [--order <o>] [--state <s>]          List the compact task view (age computed live).
 *   show <selector> [--state <s>]             Print full bodies.
 *   add --from <payload> [--strict]           Add one task (ID allocated, body bucketed, indexed). WARNS on
 *                                             payload prose not in a managed field (dropped); --strict → error.
 *   import --from <payload> [--strict]         Batch-add N tasks: contiguous ID block, one index pass. Same
 *                                             dropped-prose warning per block.
 *   export <selector> [--out <p>] [--state <s>]  Serialize tasks to ONE canonical-body file (round-trips import).
 *   edit <id> --from <payload>                Rewrite CONTENT fields only (headline/summary/context/subtasks).
 *   check <id.LETTER>                         Tick a subtask; refresh the (done/total) index hint.
 *   add-subtask <id> "<text>"                 Append ONE lettered subtask, PRESERVING existing items +
 *                                             their check state (unlike edit's setSubtasks, which resets).
 *   start <id>                                → in-progress.
 *   finish <id> --action <text>              → finished (+Ended +End action).
 *   drop <id> --reason <text>                → dropped (+Ended +"WON'T DO — …").
 *   remove <id> [--hard]                      Soft-stash to removed (recoverable), or --hard purge.
 *   reopen <id>                               Any ended/removed → open (keeps Created; strips Ended/End action).
 *   resolve <selector> [--state <s>] [--since <Nd>]   (tool-internal) selector → validated id set.
 *   reindex                                    (tool-internal) rebuild all indexes from bodies (drift repair).
 *
 * GLOBAL FLAGS
 *   --tasks-dir <path>   Override the store location (tests + the skill pass this). Otherwise the
 *                         resolved config `tasks.tasksDir` is used.
 *   --config <path>      Override the config.json path (default: <root>/.claude/claude-tpm/config.json).
 *   --help               This message (or per-subcommand usage after the subcommand).
 *
 * STATE-TRANSITION LEGALITY (G3): a forward transition from a sensible state succeeds; a
 * REDUNDANT transition (→ the current state) is a no-op with a notice; a NONSENSICAL one (e.g.
 * `start` a removed task) is a loud error naming the current state.
 *
 * CONFIG GATE: `tasks.enabled: false` ⇒ the tool short-circuits with a clear message and does
 * NO store ops. Missing config ⇒ defaults (system ON). Malformed ⇒ defaults + warning.
 *
 * EXAMPLES
 *   npx tpm task --tasks-dir /tmp/store add --from ./payload.md
 *   npx tpm task --tasks-dir /tmp/store list --order oldest --state all
 *   npx tpm task --tasks-dir /tmp/store finish 1245 --action "shipped in PR #42"
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveTasksConfig, tasksDirAbs } = require('./tpm-task-config');
const fmt = require('./tpm-task-format');
const store = require('./tpm-task-store');
const render = require('./tpm-task-render');

// ── small utilities ───────────────────────────────────────────────────────────
function die(msg, code = 1) { process.stderr.write(`task: ${msg}\n`); process.exit(code); }
function out(msg) { process.stdout.write(`${msg}\n`); }

function todayISO(tz) {
  return render.ymdInTz(new Date(), tz || 'local');
}

// ── state-transition legality matrix (G3) ─────────────────────────────────────
const TRANSITIONS = {
  start: { target: 'in-progress', legalFrom: ['open'], redundantFrom: ['in-progress'] },
  finish: { target: 'finished', legalFrom: ['open', 'in-progress'], redundantFrom: ['finished'] },
  drop: { target: 'dropped', legalFrom: ['open', 'in-progress'], redundantFrom: ['dropped'] },
  remove: { target: 'removed', legalFrom: ['open', 'in-progress', 'finished', 'dropped'], redundantFrom: ['removed'] },
  reopen: { target: 'open', legalFrom: ['finished', 'dropped', 'removed'], redundantFrom: ['open', 'in-progress'] },
};

function classifyTransition(mode, current) {
  const t = TRANSITIONS[mode];
  if (t.redundantFrom.includes(current)) return { result: 'redundant', target: t.target };
  if (t.legalFrom.includes(current)) return { result: 'legal', target: t.target };
  return { result: 'illegal', target: t.target };
}

// ── payload parsing (--from) ──────────────────────────────────────────────────
/** Split a payload into task blocks by H1 (`# …`) lines. */
function splitBlocks(raw) {
  const lines = raw.split('\n');
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    if (/^#\s+/.test(line)) {
      if (cur !== null) blocks.push(cur.join('\n'));
      cur = [line];
    } else if (cur !== null) {
      cur.push(line);
    }
  }
  if (cur !== null) blocks.push(cur.join('\n'));
  return blocks;
}

/** Parse one payload block into a content entry (leniently). */
function parseEntry(block) {
  const p = fmt.parseBody(block);
  const firstHeading = block.split('\n').find((l) => /^#\s+/.test(l));
  // A `#<digits>` SIGIL (`# #1000 · …`) marks a real stored task id — strip it to the bare
  // headline. WITHOUT the sigil the leading digits are just headline text (an author payload
  // like `# 2026 roadmap cleanup`), so keep the whole post-`# ` line. parseBody's number is
  // lenient (it also matches a sigil-less number for reading hand-edited stored bodies), so we
  // gate on the sigil here rather than trusting p.number — otherwise a numeric-leading headline
  // is silently mangled on add/import/edit. (BUG-1)
  let headline;
  if (p.number !== null && firstHeading && /^#\s+#\d+/.test(firstHeading)) {
    headline = p.headline;
  } else {
    headline = firstHeading ? firstHeading.replace(/^#\s+/, '').trim() : '';
  }
  return {
    headline,
    summary: p.summary ? p.summary.value : null,
    context: p.context ? p.context.value : null,
    created: p.fields.Created ? p.fields.Created.value : null,
    state: p.fields.State ? p.fields.State.value : null,
    started: p.fields.Started ? p.fields.Started.value : null,
    ended: p.fields.Ended ? p.fields.Ended.value : null,
    endAction: p.fields['End action'] ? p.fields['End action'].value : null,
    reopened: p.fields.Reopened ? p.fields.Reopened.value : null,
    subtasks: p.subtasks ? p.subtasks.items.map((it) => ({ text: it.text, checked: it.checked })) : [],
  };
}

function readPayload(fromPath) {
  if (!fromPath) die('--from <payload> is required (a markdown file the skill wrote). See --help.');
  if (!fs.existsSync(fromPath)) die(`--from payload not found: ${fromPath}`);
  return fs.readFileSync(fromPath, 'utf8');
}

// ── pool selection for read/selector modes ────────────────────────────────────
// A --state arg maps to which stored index pool(s) to read.
function poolsForState(stateArg, defaultListState) {
  if (!stateArg) {
    // default list pool: whichever states defaultListState names -> the pools that hold them.
    const set = new Set((defaultListState || ['open', 'in-progress']).map((s) => store.STATE_TO_POOL[s] || 'open'));
    return { pools: [...set], stateFilter: null };
  }
  const s = String(stateArg).toLowerCase();
  if (s === 'all') return { pools: store.POOLS, stateFilter: null };
  if (s === 'wip' || s === '--wip' || s === 'in-progress') return { pools: ['open'], stateFilter: 'in-progress' };
  if (s === 'open') return { pools: ['open'], stateFilter: 'open' };
  if (s === 'finished') return { pools: ['finished'], stateFilter: 'finished' };
  if (s === 'dropped') return { pools: ['finished'], stateFilter: 'dropped' };
  if (s === 'removed') return { pools: ['removed'], stateFilter: 'removed' };
  return { pools: ['open'], stateFilter: null };
}

function collectRows(tasksDir, stateArg, cfg) {
  const { pools, stateFilter } = poolsForState(stateArg, cfg.defaultListState);
  let rows = [];
  for (const pool of pools) rows = rows.concat(store.readIndex(tasksDir, pool).rows);
  if (stateFilter) rows = rows.filter((r) => r.state === stateFilter);
  // de-dup by num (a task lives in exactly one pool, but be safe)
  const seen = new Map();
  for (const r of rows) seen.set(r.num, r);
  return [...seen.values()];
}

// ── ctx: resolve config + tasksDir + gate ─────────────────────────────────────
function makeCtx(globals) {
  let resolution;
  try {
    resolution = resolveTasksConfig(globals.config);
  } catch (err) {
    die(err.message);
  }
  if (resolution.warning) process.stderr.write(`task: ${resolution.warning}\n`);
  const cfg = resolution.resolved;
  if (cfg.enabled === false) {
    out('task system disabled by config (tasks.enabled: false). Flip that key to re-enable; no store ops performed.');
    process.exit(0);
  }
  const tasksDir = globals.tasksDir
    ? path.resolve(globals.tasksDir)
    : tasksDirAbs(cfg, resolution.projectRoot);
  return { cfg, tasksDir, projectRoot: resolution.projectRoot };
}

// ── subcommand handlers ───────────────────────────────────────────────────────

// Fail-loud on SILENT DATA LOSS: any payload prose not captured into a managed field is dropped by
// buildBody. Warn (name the lines + the likely fix); --strict turns the warning into a hard error.
// (This is the exact trap that ate 63 task bodies — a `## Notes` block instead of `**Context:**`.)
function warnDropped(block, label, args) {
  const dropped = fmt.unmanagedLines(block);
  if (dropped.length === 0) return;
  process.stderr.write(`⚠️  ${label}: ${dropped.length} payload line(s) NOT in a managed field (**Summary:**/**Context:**/**Subtasks:**) — DROPPED:\n`);
  dropped.slice(0, 4).forEach((d) => process.stderr.write(`      | ${d.text.trim().slice(0, 76)}\n`));
  if (dropped.length > 4) process.stderr.write(`      | … and ${dropped.length - 4} more\n`);
  process.stderr.write('      → did you mean **Context:** <text>? (a ## Notes heading, stray prose, or a bulleted "- **Context:**" is not a managed field)\n');
  if (args.strict) die(`--strict: refusing — ${label} would silently drop ${dropped.length} line(s). Fix the payload or drop --strict.`);
}

function cmdAdd(args, ctx) {
  const raw = readPayload(args.from);
  const block = splitBlocks(raw)[0] || raw;
  const entry = parseEntry(block);
  if (!entry.headline) die('payload has no headline (a `# <headline>` line is required).');
  const id = store.peekNextId(ctx.tasksDir, ctx.cfg.startId);
  warnDropped(block, `#${id}`, args);
  const body = fmt.buildBody({
    number: id,
    headline: entry.headline,
    state: entry.state || 'open',
    created: entry.created || todayISO(ctx.cfg.timezone),
    started: entry.started,
    ended: entry.ended,
    endAction: entry.endAction,
    reopened: entry.reopened,
    summary: entry.summary,
    context: entry.context,
    subtasks: entry.subtasks,
  });
  store.writeBody(ctx.tasksDir, id, ctx.cfg.bucketSize, body);
  store.placeRow(ctx.tasksDir, id, ctx.cfg.bucketSize);
  store.healMarker(ctx.tasksDir, ctx.cfg.startId);
  out(`added #${id} · ${entry.headline}`);
}

function cmdImport(args, ctx) {
  const raw = readPayload(args.from);
  const blocks = splitBlocks(raw).filter((b) => b.trim());
  if (blocks.length === 0) die('payload contains no task blocks (each task starts with a `# <headline>` line).');
  const parsed = blocks.map((b) => ({ block: b, entry: parseEntry(b) })).filter((x) => x.entry.headline);
  if (parsed.length === 0) die('no task blocks had a headline.');
  const startAt = store.peekNextId(ctx.tasksDir, ctx.cfg.startId);
  const ids = [];
  parsed.forEach(({ block, entry }, i) => {
    const id = startAt + i;
    warnDropped(block, `#${id}`, args);
    const body = fmt.buildBody({
      number: id,
      headline: entry.headline,
      state: entry.state || 'open',
      created: entry.created || todayISO(ctx.cfg.timezone),
      started: entry.started,
      ended: entry.ended,
      endAction: entry.endAction,
      reopened: entry.reopened,
      summary: entry.summary,
      context: entry.context,
      subtasks: entry.subtasks,
    });
    store.writeBody(ctx.tasksDir, id, ctx.cfg.bucketSize, body);
    ids.push(id);
  });
  for (const id of ids) store.placeRow(ctx.tasksDir, id, ctx.cfg.bucketSize);
  store.healMarker(ctx.tasksDir, ctx.cfg.startId);
  out(`imported ${ids.length} task(s): #${ids[0]}–#${ids[ids.length - 1]}`);
}

function cmdEdit(args, ctx) {
  const id = parseId(args._[0]);
  if (id === null) die('edit requires a task id: `edit <id> --from <payload>`.');
  const raw = readPayload(args.from);
  let body = store.readBody(ctx.tasksDir, id, ctx.cfg.bucketSize);
  if (body === null) die(`no task #${id} found.`);
  const block = splitBlocks(raw)[0] || raw;
  warnDropped(block, `#${id}`, args);
  const entry = parseEntry(block);
  // CONTENT fields only (Q9) — never State.
  if (entry.headline) body = fmt.setHeadline(body, entry.headline);
  if (entry.summary !== null) body = fmt.setSummary(body, entry.summary);
  if (entry.context !== null) body = fmt.setContext(body, entry.context);
  if (entry.subtasks && entry.subtasks.length) body = fmt.setSubtasks(body, entry.subtasks.map((s) => s.text));
  store.writeBody(ctx.tasksDir, id, ctx.cfg.bucketSize, body);
  store.placeRow(ctx.tasksDir, id, ctx.cfg.bucketSize); // refresh index headline/progress
  out(`edited #${id}`);
}

function cmdCheck(args, ctx) {
  const sel = args._[0];
  if (!sel) die('check requires a subtask selector: `check <id.LETTER>` (e.g. 1245.A).');
  const m = /^#?(\d+)\s*\.?\s*([A-Za-z])$/.exec(String(sel).trim());
  if (!m) die(`unparseable subtask selector "${sel}" — expected <id.LETTER>, e.g. 1245.A / 1245a / #1245.A.`);
  const id = parseInt(m[1], 10);
  const letter = m[2].toUpperCase();
  let body = store.readBody(ctx.tasksDir, id, ctx.cfg.bucketSize);
  if (body === null) die(`no task #${id} found.`);
  const res = fmt.setSubtaskChecked(body, letter, true);
  if (!res.existed) die(`task #${id} has no subtask ${letter}.`);
  if (!res.changed) { out(`#${id}.${letter} already checked — no change.`); return; }
  store.writeBody(ctx.tasksDir, id, ctx.cfg.bucketSize, res.raw);
  store.placeRow(ctx.tasksDir, id, ctx.cfg.bucketSize);
  const prog = fmt.subtaskProgress(fmt.parseBody(res.raw));
  out(`checked #${id}.${letter}${prog ? ` (${prog.done}/${prog.total})` : ''}`);
}

function cmdAddSubtask(args, ctx) {
  const id = parseId(args._[0]);
  if (id === null) die('add-subtask requires a task id: `add-subtask <id> "<text>"`.');
  const text = String(args._[1] || '').trim();
  if (!text) die('add-subtask requires subtask text: `add-subtask <id> "<text>"`.');
  let body = store.readBody(ctx.tasksDir, id, ctx.cfg.bucketSize);
  if (body === null) die(`no task #${id} found.`);
  body = fmt.appendSubtask(body, text); // appends ONE lettered subtask, existing check state preserved
  store.writeBody(ctx.tasksDir, id, ctx.cfg.bucketSize, body);
  store.placeRow(ctx.tasksDir, id, ctx.cfg.bucketSize); // refresh the (done/total) index hint
  const parsed = fmt.parseBody(body);
  const prog = fmt.subtaskProgress(parsed);
  const letter = parsed.subtasks.items[parsed.subtasks.items.length - 1].letter;
  out(`added subtask #${id}.${letter}${prog ? ` (${prog.done}/${prog.total})` : ''}`);
}

function transitionMode(mode, args, ctx) {
  const id = parseId(args._[0]);
  if (id === null) die(`${mode} requires a task id: \`${mode} <id>\`.`);

  // remove --hard is a purge that works from any state (incl. already-removed).
  if (mode === 'remove' && args.hard) {
    if (ctx.cfg.allowHardDelete === false) die(`hard delete is disabled by config (tasks.allowHardDelete: false). #${id} not touched.`);
    const body = store.readBody(ctx.tasksDir, id, ctx.cfg.bucketSize);
    const pool = store.findRowPool(ctx.tasksDir, id);
    if (body === null && pool === null) die(`no task #${id} found.`);
    store.deleteBody(ctx.tasksDir, id, ctx.cfg.bucketSize);
    store.placeRow(ctx.tasksDir, id, ctx.cfg.bucketSize, { removeEverywhere: true });
    out(`HARD-DELETED #${id} — body removed, unrecoverable.`);
    return;
  }

  let body = store.readBody(ctx.tasksDir, id, ctx.cfg.bucketSize);
  if (body === null) die(`no task #${id} found.`);
  const current = fmt.getField(body, 'State') || 'open';
  const cls = classifyTransition(mode, current);

  if (cls.result === 'illegal') {
    die(`cannot ${mode} #${id}: it is "${current}". (${legalityHint(mode, current)})`);
  }
  if (cls.result === 'redundant') {
    out(`#${id} is already "${current}" — ${mode} is a no-op.`);
    return;
  }

  const today = todayISO(ctx.cfg.timezone);
  switch (mode) {
    case 'start':
      body = fmt.setField(body, 'State', 'in-progress');
      if (!fmt.getField(body, 'Started')) body = fmt.setField(body, 'Started', today);
      break;
    case 'finish':
      if (!args.action) die('finish requires --action "<what was done>".');
      body = fmt.setField(body, 'State', 'finished');
      body = fmt.setField(body, 'Ended', today);
      body = fmt.setField(body, 'End action', args.action);
      break;
    case 'drop':
      if (!args.reason) die('drop requires --reason "<why>".');
      body = fmt.setField(body, 'State', 'dropped');
      body = fmt.setField(body, 'Ended', today);
      body = fmt.setField(body, 'End action', `WON'T DO — ${args.reason}`);
      break;
    case 'remove': // soft
      body = fmt.setField(body, 'State', 'removed');
      break;
    case 'reopen': // G4: strip stale Ended/End action, keep Reopened
      body = fmt.setField(body, 'State', 'open');
      body = fmt.removeField(body, 'Ended');
      body = fmt.removeField(body, 'End action');
      body = fmt.setField(body, 'Reopened', today);
      break;
    default: break;
  }
  store.writeBody(ctx.tasksDir, id, ctx.cfg.bucketSize, body);
  store.placeRow(ctx.tasksDir, id, ctx.cfg.bucketSize);

  const verb = { start: 'started', finish: 'finished', drop: 'dropped', remove: 'stashed to removed (recoverable via reopen)', reopen: 'reopened' }[mode];
  out(`#${id} ${verb}.`);
}

function legalityHint(mode, current) {
  if (mode === 'reopen') return 'nothing to reopen from an active state';
  if (['finished', 'dropped'].includes(current)) return `reopen it first to ${mode} again`;
  if (current === 'removed') return `reopen it first to ${mode} again`;
  return `not a valid ${mode} from "${current}"`;
}

function cmdList(args, ctx) {
  const rows = collectRows(ctx.tasksDir, args.state, ctx.cfg);
  const order = args.order || ctx.cfg.defaultOrder;
  out(render.renderList(rows, { order, nowDate: new Date(), tz: ctx.cfg.timezone }));
  if (args.state == null && rows.length > ctx.cfg.maxOpenWarn) {
    process.stderr.write(`task: open list has ${rows.length} tasks (> maxOpenWarn ${ctx.cfg.maxOpenWarn}) — consider finishing/dropping some.\n`);
  }
}

function cmdShow(args, ctx) {
  const sel = args._[0];
  if (!sel) die('show requires a selector: `show <id|range|list|all>`.');
  const rows = collectRows(ctx.tasksDir, args.state, ctx.cfg);
  const { ids, warnings, error } = render.resolveSelector(sel, { rows });
  if (error) die(error);
  for (const w of warnings) process.stderr.write(`task: ${w}\n`);
  if (ids.length === 0) { out('(no matching tasks)'); return; }
  const chunks = [];
  for (const id of ids) {
    const body = store.readBody(ctx.tasksDir, id, ctx.cfg.bucketSize);
    if (body) chunks.push(render.renderShow(body));
  }
  out(chunks.join('\n\n---\n\n'));
}

function cmdResolve(args, ctx) {
  const sel = args._[0];
  if (!sel) die('resolve requires a selector.');
  const rows = collectRows(ctx.tasksDir, args.state, ctx.cfg);
  let sinceOk = null;
  if (args.since) {
    const md = /^(\d+)\s*d?$/.exec(String(args.since).trim());
    if (!md) die(`--since expects <Nd> (e.g. 7d), got "${args.since}".`);
    const days = parseInt(md[1], 10);
    const cutoff = render.ymdInTz(new Date(Date.now() - days * 86400000), ctx.cfg.timezone);
    sinceOk = (row) => (row.created || '') >= cutoff; // created-based window (ended pool would use ended; see tpm-task.md/G6)
  }
  const { ids, warnings, error } = render.resolveSelector(sel, { rows, sinceOk });
  if (error) die(error);
  for (const w of warnings) process.stderr.write(`task: ${w}\n`);
  out(ids.join(' '));
}

function cmdExport(args, ctx) {
  const sel = args._[0];
  if (!sel) die('export requires a selector: `export <id|range|list|all> [--out <path>] [--state <s>]`.');
  const rows = collectRows(ctx.tasksDir, args.state, ctx.cfg);
  const { ids, warnings, error } = render.resolveSelector(sel, { rows });
  if (error) die(error);
  for (const w of warnings) process.stderr.write(`task: ${w}\n`);

  const bodies = [];
  for (const id of ids) {
    const body = store.readBody(ctx.tasksDir, id, ctx.cfg.bucketSize);
    if (body) bodies.push(body.replace(/\n+$/, ''));
  }
  const content = `${bodies.join('\n\n')}\n`;

  let outPath = args.out;
  if (!outPath) {
    // Q4 + C2: config-derived default, auto-timestamped, resolved UNDER the resolved tasksDir
    // (NOT the project root) so a `--tasks-dir <sandbox>` export can never escape its store. An
    // absolute `exportDir` still wins; `--out <path>` (below) overrides to anywhere.
    const dir = path.isAbsolute(ctx.cfg.exportDir) ? ctx.cfg.exportDir : path.join(ctx.tasksDir, ctx.cfg.exportDir);
    outPath = path.join(dir, `tasks-export-${todayISO(ctx.cfg.timezone)}.md`);
  } else {
    outPath = path.resolve(outPath);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, content, 'utf8');
  out(`exported ${ids.length} task(s) → ${outPath}`);
}

function cmdReindex(args, ctx) {
  const res = store.reindex(ctx.tasksDir, ctx.cfg.bucketSize, ctx.cfg.startId);
  out(`reindexed: ${res.counts.open} open, ${res.counts.finished} finished/dropped, ${res.counts.removed} removed; Next ID ${res.nextId}.`);
}

// ── id parse ──────────────────────────────────────────────────────────────────
function parseId(s) {
  if (s == null) return null;
  const m = /^#?(\d+)$/.exec(String(s).trim());
  return m ? parseInt(m[1], 10) : null;
}

// ── CLI plumbing ──────────────────────────────────────────────────────────────
const SUBCOMMANDS = ['list', 'show', 'add', 'import', 'export', 'edit', 'check', 'add-subtask', 'start', 'finish', 'drop', 'remove', 'reopen', 'resolve', 'reindex'];

const USAGE = {
  list: 'list [--order newest|oldest|id|state] [--state open|in-progress|finished|dropped|removed|all]',
  show: 'show <selector> [--state <s>]',
  add: 'add --from <payload.md>',
  import: 'import --from <payload.md>',
  export: 'export <selector> [--out <path>] [--state <s>]',
  edit: 'edit <id> --from <payload.md>',
  check: 'check <id.LETTER>',
  'add-subtask': 'add-subtask <id> "<text>"',
  start: 'start <id>',
  finish: 'finish <id> --action "<what was done>"',
  drop: 'drop <id> --reason "<why>"',
  remove: 'remove <id> [--hard]',
  reopen: 'reopen <id>',
  resolve: 'resolve <selector> [--state <s>] [--since <Nd>]',
  reindex: 'reindex',
};

function printTopHelp() {
  const lines = [
    'Usage: npx tpm task [--tasks-dir <path>] [--config <path>] <subcommand> [args]',
    '',
    'Subcommands:',
  ];
  for (const c of SUBCOMMANDS) lines.push(`  ${USAGE[c]}`);
  lines.push('', 'See the header docstring in this file for full behavior, the G3 legality matrix, and examples.', '');
  process.stdout.write(lines.join('\n'));
}

function parseArgs(argv) {
  const globals = {};
  const args = { _: [] };
  let subcommand = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (subcommand === null) {
      if (a === '--help' || a === '-h') { globals.help = true; }
      else if (a === '--tasks-dir') { globals.tasksDir = argv[++i]; }
      else if (a === '--config') { globals.config = argv[++i]; }
      else if (SUBCOMMANDS.includes(a)) { subcommand = a; }
      else if (a.startsWith('-')) { globals[`unknown_${a}`] = true; }
      else { globals.badSub = a; }
      continue;
    }
    // subcommand args
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--tasks-dir') globals.tasksDir = argv[++i];
    else if (a === '--config') globals.config = argv[++i];
    else if (a === '--from') args.from = path.resolve(argv[++i]);
    else if (a === '--strict') args.strict = true; // add/import/edit: ERROR on dropped payload prose
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--order') args.order = argv[++i];
    else if (a === '--state') args.state = argv[++i];
    else if (a === '--action') args.action = argv[++i];
    else if (a === '--reason') args.reason = argv[++i];
    else if (a === '--since') args.since = argv[++i];
    else if (a === '--hard') args.hard = true;
    else if (a === '--wip') args.state = 'in-progress';
    else args._.push(a);
  }
  return { globals, subcommand, args };
}

function main() {
  const argv = process.argv.slice(2);
  const { globals, subcommand, args } = parseArgs(argv);

  if (globals.help && !subcommand) { printTopHelp(); process.exit(0); }
  if (globals.badSub) { die(`unknown subcommand "${globals.badSub}". Run with --help.`); }
  if (!subcommand) { printTopHelp(); process.exit(argv.length === 0 ? 1 : 0); }
  if (args.help) { process.stdout.write(`Usage: npx tpm task [--tasks-dir <p>] ${USAGE[subcommand]}\n`); process.exit(0); }

  const ctx = makeCtx(globals);

  try {
    switch (subcommand) {
      case 'add': cmdAdd(args, ctx); break;
      case 'import': cmdImport(args, ctx); break;
      case 'edit': cmdEdit(args, ctx); break;
      case 'check': cmdCheck(args, ctx); break;
      case 'add-subtask': cmdAddSubtask(args, ctx); break;
      case 'start': case 'finish': case 'drop': case 'remove': case 'reopen':
        transitionMode(subcommand, args, ctx); break;
      case 'list': cmdList(args, ctx); break;
      case 'show': cmdShow(args, ctx); break;
      case 'resolve': cmdResolve(args, ctx); break;
      case 'export': cmdExport(args, ctx); break;
      case 'reindex': cmdReindex(args, ctx); break;
      default: die(`unhandled subcommand "${subcommand}".`);
    }
  } catch (err) {
    die(err.message);
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { classifyTransition, TRANSITIONS, splitBlocks, parseEntry, parseId, poolsForState };
