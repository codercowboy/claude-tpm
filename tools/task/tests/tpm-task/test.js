#!/usr/bin/env node
/**
 * tests/tpm-task/test.js — the end-to-end behavioral suite for tpm-task.js.
 *
 * WHAT IT GUARDS
 *   Every §10 test bucket, driven through the REAL CLI as a subprocess against a throwaway store
 *   in os.tmpdir() (G8), asserting on real on-disk index + body state:
 *     - help + required-input guards (E20)
 *     - all 12 user modes: add / import / export / list / show / edit / check / start / finish /
 *       drop / remove(soft + --hard + config-blocked) / reopen, plus resolve / reindex
 *     - ID allocation: monotonic, from startId, max-heal on a stale (low) marker
 *     - G3 state-transition legality matrix (classifyTransition, exhaustive 25 cells) + CLI proof
 *     - G1 preserve-unmanaged-prose across a mutation
 *     - Q9 edit = content-only (never State); hand-edited State reconciled by reindex
 *     - lenient parse of a hand-mangled body on a real mutation
 *     - export -> import -> export losslessness (open tasks) + reindex drift-repair + idempotency
 *     - config gate (enabled:false) + config overrides (startId / bucketSize)
 *
 * HOW TO RUN
 *   node tests/tpm-task/test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  makeChecker, runTask, runTaskRaw, mkStore, writePayload,
  readBody, readOpenIdx, readFinIdx, readRemIdx, bodyPath, TOOLS,
} = require('../lib/harness');

const task = require(TOOLS.task); // in-process: classifyTransition matrix

const { ok, eq, count } = makeChecker();

// ── G3 legality matrix (exhaustive, in-process — the exported classifier) ─────────
const MATRIX = {
  //           open        in-progress  finished    dropped     removed
  start:  { open: 'legal', 'in-progress': 'redundant', finished: 'illegal', dropped: 'illegal', removed: 'illegal' },
  finish: { open: 'legal', 'in-progress': 'legal', finished: 'redundant', dropped: 'illegal', removed: 'illegal' },
  drop:   { open: 'legal', 'in-progress': 'legal', finished: 'illegal', dropped: 'redundant', removed: 'illegal' },
  remove: { open: 'legal', 'in-progress': 'legal', finished: 'legal', dropped: 'legal', removed: 'redundant' },
  reopen: { open: 'redundant', 'in-progress': 'redundant', finished: 'legal', dropped: 'legal', removed: 'legal' },
};
for (const mode of Object.keys(MATRIX)) {
  for (const state of Object.keys(MATRIX[mode])) {
    eq(`G3 matrix: ${mode} from ${state} -> ${MATRIX[mode][state]}`,
      task.classifyTransition(mode, state).result, MATRIX[mode][state]);
  }
}

// ── shared store for the lifecycle walk ──────────────────────────────────────────
const store = mkStore();
const P = (name, text) => writePayload(store, name, text);

// ── help / required-input guards (E20) ───────────────────────────────────────────
ok('--help exits 0 + lists subcommands', (() => { const r = runTaskRaw(['--help']); return r.code === 0 && /Subcommands:/.test(r.stdout); })());
ok('add with no --from fails loudly (exit 1)', runTask(store, ['add']).code === 1);
ok('finish with no id fails loudly', runTask(store, ['finish']).code === 1);
ok('finish with no --action fails loudly', (() => {
  runTask(store, ['add', '--from', P('seed', '# seed\n\n**Summary:** s.\n')]);
  return runTask(store, ['finish', '1000']).code === 1;
})());
ok('unknown subcommand fails loudly', runTask(store, ['frobnicate']).code === 1);

// reset store (drop the seed) for a clean lifecycle
fs.rmSync(store, { recursive: true, force: true });
fs.mkdirSync(store, { recursive: true });

// ── ADD: id from startId, bucket, index row, marker heal ─────────────────────────
let r = runTask(store, ['add', '--from', P('a1', '# Add a dark-mode toggle\n\n**Summary:** add a toggle.\n\n**Context:** touches `CLAUDE.md`.\n')]);
ok('add #1000 (id from startId 1000)', r.code === 0 && /added #1000/.test(r.stdout));
ok('body bucketed at bodies/1000-1999/task-1000.md', readBody(store, 1000) !== null);
ok('open index Next ID marker = 1001', /\*\*Next ID:\*\* 1001/.test(readOpenIdx(store)));
ok('open index has a row for 1000', /\|\s*1000\s*\|\s*open\s*\|/.test(readOpenIdx(store)));

// epic with subtasks
runTask(store, ['add', '--from', P('a2', '# Collapse add and list\n\n**Summary:** merge.\n\n**Context:** epic.\n\n**Subtasks:**\n- [ ] A. draft\n- [ ] B. build\n')]);
ok('epic #1001 added', readBody(store, 1001) !== null);
ok('list shows epic hint (0/2)', /#1001.*\(0\/2\)/.test(runTask(store, ['list']).stdout));

// ── ID monotonicity + max-heal on a STALE (too-low) marker (G10) ─────────────────
// Corrupt the marker DOWN to 3; the next add must still be max(bodies)+1 = 1002, never reuse.
const openIdxPath = path.join(store, 'task-index.md');
fs.writeFileSync(openIdxPath, readOpenIdx(store).replace(/\*\*Next ID:\*\* \d+/, '**Next ID:** 3'), 'utf8');
r = runTask(store, ['add', '--from', P('a3', '# Third\n\n**Summary:** three.\n')]);
ok('add heals a stale low marker -> id is 1002 (max+1), never 3', /added #1002/.test(r.stdout));
ok('marker re-healed to 1003', /\*\*Next ID:\*\* 1003/.test(readOpenIdx(store)));

// ── IMPORT: contiguous block, per-entry created override, one marker heal ─────────
r = runTask(store, ['import', '--from', P('imp', [
  '# First imported\n\n- **Created:** 2026-01-05\n\n**Summary:** one.\n',
  '# Second imported\n\n- **Created:** 2026-02-10\n\n**Summary:** two.\n',
].join('\n'))]);
ok('import 2 tasks contiguous #1003-#1004', r.code === 0 && /imported 2 task\(s\): #1003–#1004/.test(r.stdout));
ok('import honored per-entry Created 2026-01-05', /- \*\*Created:\*\* 2026-01-05/.test(readBody(store, 1003)));
ok('import advanced marker to 1005', /\*\*Next ID:\*\* 1005/.test(readOpenIdx(store)));

// ── LIST: --order (all four) + --state + age + --wip ─────────────────────────────
const listLines = (args) => runTask(store, ['list', ...args]).stdout.trim().split('\n').filter((l) => /^#\d/.test(l));
ok('list default shows 5 open lines', listLines([]).length === 5);
ok('list --order oldest puts #1003 (2026-01-05) first', /^#1003/.test(listLines(['--order', 'oldest'])[0]));
ok('list --order id puts #1000 first', /^#1000/.test(listLines(['--order', 'id'])[0]));
ok('list --order newest puts a recent id first (not #1003)', !/^#1003/.test(listLines(['--order', 'newest'])[0]));

// ── SHOW one / many ──────────────────────────────────────────────────────────────
ok('show 1000 prints its body', /# #1000 · Add a dark-mode toggle/.test(runTask(store, ['show', '1000']).stdout));
ok('show comma-list prints both, separated by ---', (() => {
  const s = runTask(store, ['show', '1003,1004']).stdout;
  return /First imported/.test(s) && /Second imported/.test(s) && /---/.test(s);
})());

// ── EDIT: content-only, never State (Q9); refreshes index ────────────────────────
runTask(store, ['start', '1001']); // put epic in-progress first, to prove edit won't revert it
r = runTask(store, ['edit', '1001', '--from', P('ed', '# Collapse add/list/show\n\n**Summary:** revised.\n')]);
ok('edit 1001 succeeds', r.code === 0);
ok('edit updated headline', /# #1001 · Collapse add\/list\/show/.test(readBody(store, 1001)));
ok('edit updated summary', /\*\*Summary:\*\* revised\./.test(readBody(store, 1001)));
ok('Q9: edit did NOT change State (still in-progress)', /- \*\*State:\*\* in-progress/.test(readBody(store, 1001)));
ok('edit refreshed the index headline', /Collapse add\/list\/show/.test(readOpenIdx(store)));

// ── CHECK: tick, (done/total) index update, letter normalization, edges (G5) ─────
r = runTask(store, ['check', '1001.A']);
ok('check 1001.A -> (1/2)', r.code === 0 && /\(1\/2\)/.test(r.stdout));
ok('index epic hint now (1/2)', /1001.*\(1\/2\)/.test(readOpenIdx(store)));
ok('check 1001.a (lowercase, already) -> no-op notice', /already checked/.test(runTask(store, ['check', '1001.a']).stdout));
ok('check 1001B (no-dot normalization) succeeds', runTask(store, ['check', '1001B']).code === 0);
ok('check missing letter Z errors', runTask(store, ['check', '1001.Z']).code === 1);
ok('check non-epic 1000.A errors (no subtasks)', runTask(store, ['check', '1000.A']).code === 1);

// ── START: -> in-progress + Started; redundant no-op ─────────────────────────────
r = runTask(store, ['start', '1000']);
ok('start 1000 succeeds', r.code === 0);
ok('start stamped in-progress + Started', /- \*\*State:\*\* in-progress/.test(readBody(store, 1000)) && /- \*\*Started:\*\*/.test(readBody(store, 1000)));
ok('list shows ▶ for in-progress 1000', /#1000 ▶/.test(runTask(store, ['list']).stdout));
ok('start again -> redundant no-op notice', /no-op/.test(runTask(store, ['start', '1000']).stdout));

// ── FINISH: end fields + line MOVES to finished index ────────────────────────────
r = runTask(store, ['finish', '1000', '--action', 'shipped in PR #42']);
ok('finish 1000 succeeds', r.code === 0);
ok('1000 removed from OPEN index', !/\|\s*1000\s*\|/.test(readOpenIdx(store)));
ok('1000 now in FINISHED index', /\|\s*1000\s*\|\s*finished\s*\|/.test(readFinIdx(store)));
ok('finish stamped End action', /- \*\*End action:\*\* shipped in PR #42/.test(readBody(store, 1000)));
ok('G3 CLI: start a finished task -> loud error naming state', (() => {
  const x = runTask(store, ['start', '1000']); return x.code === 1 && /it is "finished"/.test(x.stderr);
})());

// ── DROP: dropped + WON'T DO; moves to finished index ────────────────────────────
r = runTask(store, ['drop', '1003', '--reason', 'obsolete']);
ok('drop 1003 succeeds', r.code === 0);
ok('1003 in finished index as dropped', /\|\s*1003\s*\|\s*dropped\s*\|/.test(readFinIdx(store)));
ok("drop stamped WON'T DO reason", /WON'T DO — obsolete/.test(readBody(store, 1003)));

// ── REMOVE: soft, --hard, and config-blocked ─────────────────────────────────────
r = runTask(store, ['remove', '1004']);
ok('remove 1004 soft -> recoverable', r.code === 0 && /recoverable/.test(r.stdout));
ok('1004 in removed index', /\|\s*1004\s*\|\s*removed\s*\|/.test(readRemIdx(store)));
ok('1004 body still exists after soft remove', readBody(store, 1004) !== null);
// hard delete
r = runTask(store, ['remove', '1002', '--hard']);
ok('remove 1002 --hard succeeds', r.code === 0 && /HARD-DELETED/.test(r.stdout));
ok('1002 body gone after --hard', readBody(store, 1002) === null);
ok('1002 in no index after --hard', !/\|\s*1002\s*\|/.test(readOpenIdx(store) + readFinIdx(store) + readRemIdx(store)));
// hard delete blocked by config
const cfgDir = path.join(store, '.claude', 'claude-tpm');
fs.mkdirSync(cfgDir, { recursive: true });
const cfgPath = path.join(cfgDir, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ version: 1, tasks: { allowHardDelete: false } }), 'utf8');
ok('remove --hard BLOCKED when allowHardDelete:false', runTask(store, ['--config', cfgPath, 'remove', '1004', '--hard']).code === 1);
ok('1004 body still present after blocked --hard', readBody(store, 1004) !== null);

// ── REOPEN: G4 strip Ended/End action, keep Reopened; from finished + removed ─────
r = runTask(store, ['reopen', '1000']);
ok('reopen finished 1000 succeeds', r.code === 0);
const b1000r = readBody(store, 1000);
ok('reopen set State open', /- \*\*State:\*\* open/.test(b1000r));
ok('G4: reopen stripped Ended', !/- \*\*Ended:\*\*/.test(b1000r));
ok('G4: reopen stripped End action', !/- \*\*End action:\*\*/.test(b1000r));
ok('G4: reopen kept Reopened', /- \*\*Reopened:\*\*/.test(b1000r));
ok('1000 back in open index', /\|\s*1000\s*\|\s*open\s*\|/.test(readOpenIdx(store)));
ok('reopen an already-open task -> no-op notice', /no-op/.test(runTask(store, ['reopen', '1000']).stdout));
ok('reopen a removed task (1004) succeeds', runTask(store, ['reopen', '1004']).code === 0);
ok('1004 moved out of removed index', !/\|\s*1004\s*\|/.test(readRemIdx(store)));

// ── RESOLVE (internal) grammar over the live store ───────────────────────────────
ok('resolve all --state all lists ids', /1000/.test(runTask(store, ['resolve', '--state', 'all', 'all']).stdout));
ok('resolve descending range errors', runTask(store, ['resolve', '--state', 'all', '1005-1000']).code === 1);
ok('resolve sparse range ok', runTask(store, ['resolve', '--state', 'all', '1000-1004']).code === 0);

// ── EXPORT -> IMPORT -> EXPORT losslessness (open tasks: headline+summary+subtask state) ──
const exp1 = path.join(store, 'exp1.md');
ok('export all succeeds', runTask(store, ['export', '--state', 'all', 'all', '--out', exp1]).code === 0 && fs.existsSync(exp1));
const store2 = mkStore('tpm-task-rt');
ok('re-import into fresh store succeeds', runTask(store2, ['import', '--from', exp1]).code === 0);
const exp2 = path.join(store2, 'exp2.md');
runTask(store2, ['export', '--state', 'all', 'all', '--out', exp2]);
const headlines = (p) => (fs.readFileSync(p, 'utf8').match(/^# #\d+ · (.*)$/gm) || []).map((l) => l.replace(/^# #\d+ · /, '')).sort();
const summaries = (p) => (fs.readFileSync(p, 'utf8').match(/^\*\*Summary:\*\* (.*)$/gm) || []).sort();
eq('export->import->export headlines lossless', JSON.stringify(headlines(exp2)), JSON.stringify(headlines(exp1)));
eq('export->import->export summaries lossless', JSON.stringify(summaries(exp2)), JSON.stringify(summaries(exp1)));
// subtask CHECK STATE round-trips (1001.A was ticked)
ok('export->import preserves ticked subtask state', /- \[x\] A\./.test(fs.readFileSync(exp2, 'utf8')));

// ── G1 preserve-unmanaged-prose across a mutation ────────────────────────────────
// Hand-add a ## Human Notes paragraph, run a state mutation, assert prose survives + State flips.
{
  const b = readBody(store, 1001);
  fs.writeFileSync(path.join(store, 'bodies', '1000-1999', 'task-1001.md'),
    b.replace(/(\n\*\*Subtasks:\*\*)/, '\n## Human Notes\nA stray paragraph a human added. Keep me verbatim.\n$1'), 'utf8');
  // 1001 is in-progress; finishing is a legal transition.
  runTask(store, ['finish', '1001', '--action', 'done']);
  const after = readBody(store, 1001);
  ok('G1: ## Human Notes survived a mutation', /## Human Notes/.test(after) && /Keep me verbatim\./.test(after));
  ok('G1: mutation still flipped State to finished', /- \*\*State:\*\* finished/.test(after));
}

// ── Q9: a HAND-FLIPPED State: is reconciled by reindex ───────────────────────────
{
  // 1000 is open; hand-flip its State to finished directly in the body, then reindex.
  const bp = path.join(store, 'bodies', '1000-1999', 'task-1000.md');
  fs.writeFileSync(bp, readBody(store, 1000).replace(/- \*\*State:\*\* open/, '- **State:** finished'), 'utf8');
  runTask(store, ['reindex']);
  ok('reindex reconciles a hand-flipped State: -> row moves to finished pool',
    /\|\s*1000\s*\|\s*finished\s*\|/.test(readFinIdx(store)) && !/\|\s*1000\s*\|/.test(readOpenIdx(store)));
}

// ── LENIENT parse of a hand-mangled body on a real mutation ──────────────────────
{
  const lstore = mkStore('tpm-task-lenient');
  fs.mkdirSync(path.join(lstore, 'bodies', '1000-1999'), { recursive: true });
  // Deliberately mangle: lowercase label, extra spaces, ':' title separator, no bullet on Created.
  fs.writeFileSync(path.join(lstore, 'bodies', '1000-1999', 'task-1000.md'),
    '#  1000 : messy but valid\n\n-  **state:**   open\n**Created :** 2026-05-05\n\n**summary:** hand written\n', 'utf8');
  runTask(lstore, ['reindex']); // build indexes from the mangled body
  ok('lenient: reindex read the mangled body into the open pool', /\|\s*1000\s*\|\s*open\s*\|/.test(readOpenIdx(lstore)));
  const st = runTask(lstore, ['start', '1000']);
  ok('lenient: a mutation on a mangled body succeeds', st.code === 0);
  const after = readBody(lstore, 1000);
  ok('lenient: mutation normalized State line canonically', /- \*\*State:\*\* in-progress/.test(after));
  ok('lenient: mutation preserved the hand-written headline', /messy but valid/.test(after));
  fs.rmSync(lstore, { recursive: true, force: true });
}

// ── REINDEX: drift repair (garbage row dropped) + idempotency ─────────────────────
{
  const rstore = mkStore('tpm-task-reidx');
  runTask(rstore, ['add', '--from', writePayload(rstore, 'x', '# only task\n\n**Summary:** s.\n')]); // #1000
  // corrupt: garbage row + a marker HIGHER than any body (must be preserved as a floor).
  fs.writeFileSync(path.join(rstore, 'task-index.md'),
    '# Open tasks\n**Next ID:** 1010\n\n| # | State | Created | Task |\n|---|---|---|---|\n| 9999 | open | 2020-01-01 | GARBAGE |\n', 'utf8');
  const rr = runTask(rstore, ['reindex']);
  ok('reindex drops the garbage row 9999', rr.code === 0 && !/GARBAGE/.test(readOpenIdx(rstore)) && !/9999/.test(readOpenIdx(rstore)));
  ok('reindex re-derived the real row for 1000 from the body', /\|\s*1000\s*\|\s*open\s*\|/.test(readOpenIdx(rstore)));
  ok('reindex preserved the HIGH marker floor 1010 (never reuses a previously-issued id)', /\*\*Next ID:\*\* 1010/.test(readOpenIdx(rstore)));
  const snap1 = readOpenIdx(rstore) + readFinIdx(rstore) + readRemIdx(rstore);
  runTask(rstore, ['reindex']);
  const snap2 = readOpenIdx(rstore) + readFinIdx(rstore) + readRemIdx(rstore);
  ok('reindex is idempotent (byte-identical second run)', snap1 === snap2);
  fs.rmSync(rstore, { recursive: true, force: true });
}

// ── CONFIG gate + overrides ──────────────────────────────────────────────────────
{
  const gstore = mkStore('tpm-task-cfg');
  const gcfgDir = path.join(gstore, '.claude', 'claude-tpm');
  fs.mkdirSync(gcfgDir, { recursive: true });
  const gcfg = path.join(gcfgDir, 'config.json');
  fs.writeFileSync(gcfg, JSON.stringify({ version: 1, tasks: { enabled: false } }), 'utf8');
  const gr = runTask(gstore, ['--config', gcfg, 'list']);
  ok('config gate: enabled:false short-circuits (exit 0, message)', gr.code === 0 && /disabled by config/.test(gr.stdout));

  // startId + bucketSize overrides honored
  fs.writeFileSync(gcfg, JSON.stringify({ version: 1, tasks: { startId: 500, bucketSize: 100 } }), 'utf8');
  const gr2 = runTask(gstore, ['--config', gcfg, 'add', '--from', writePayload(gstore, 'c', '# cfg task\n\n**Summary:** s.\n')]);
  ok('config override: startId 500 honored (first id #500)', /added #500/.test(gr2.stdout));
  ok('config override: bucketSize 100 honored (bodies/500-599/)', fs.existsSync(path.join(gstore, 'bodies', '500-599', 'task-500.md')));
  fs.rmSync(gstore, { recursive: true, force: true });
}

// ── C1: G10 index-row Next-ID floor pins the next id above a hand-typed high index row ──
// The floor folds `idx.rows[*].num` into highestKnownId so a fat-fingered high row (with NO
// matching body) can never be reused. r1 verifier: this WORKED but no shipped test pinned it, so
// an independent mutation of the term SURVIVED — this test + the matching mutation-check mutant
// close that coverage hole.
{
  const fstore = mkStore('tpm-task-idxfloor');
  runTask(fstore, ['add', '--from', writePayload(fstore, 'a', '# floor probe\n\n**Summary:** s.\n')]); // #1000
  // Hand-append a bogus HIGH index row (id far above the **Next ID:** marker) with NO body.
  const idxPath = path.join(fstore, 'task-index.md');
  fs.writeFileSync(idxPath,
    `${readOpenIdx(fstore)}| 8000 | open | 2020-01-01 | hand-typed high row, no body |\n`, 'utf8');
  const fr = runTask(fstore, ['add', '--from', writePayload(fstore, 'b', '# above the floor\n\n**Summary:** s.\n')]);
  ok('C1: index-row floor forces the next id ABOVE a hand-typed high row (8000 -> #8001)',
    fr.code === 0 && /added #8001/.test(fr.stdout));
  ok('C1: the new body was written under the 8000-8999 bucket (id really allocated past the floor)',
    fs.existsSync(bodyPath(fstore, 8001, 1000)));
  fs.rmSync(fstore, { recursive: true, force: true });
}

// ── C2: a no-`--out` export under a sandbox --tasks-dir lands INSIDE that sandbox, never escapes ──
{
  const sstore = mkStore('tpm-task-exp-sandbox');
  runTask(sstore, ['add', '--from', writePayload(sstore, 'e', '# sandbox export probe\n\n**Summary:** s.\n')]); // #1000
  const er = runTask(sstore, ['export', '--state', 'all', 'all']); // NO --out -> config-default path
  ok('C2: no-out export under a sandbox --tasks-dir succeeds', er.code === 0);
  const m = /→ (.+)$/m.exec(er.stdout);
  const outPath = m && m[1].trim();
  const sroot = path.resolve(sstore);
  ok('C2: default export path resolves INSIDE the --tasks-dir sandbox (never escapes to project root)',
    !!outPath && (outPath === sroot || outPath.startsWith(sroot + path.sep)));
  ok('C2: default export lands under <tasksDir>/<exportDir=tmp>/',
    !!outPath && outPath.startsWith(path.join(sroot, 'tmp') + path.sep));
  ok('C2: the exported file exists on disk inside the sandbox', !!outPath && fs.existsSync(outPath));
  fs.rmSync(sstore, { recursive: true, force: true });
}

// ── C3: a hand-DUPLICATED managed single-value field collapses to one canonical line on write ──
// A human who hand-adds a second `- **State:**` line leaves a stale duplicate; normalize-on-write
// (store.writeBody -> fmt.dedupeManagedFields) collapses it, keeping the FIRST (authoritative)
// occurrence + its value. Managed single-value fields ONLY — the subtasks checkbox block is never
// touched (that would reintroduce BUG-2).
{
  const dstore = mkStore('tpm-task-dedupe');
  runTask(dstore, ['add', '--from', writePayload(dstore, 'd', '# dupe probe\n\n**Summary:** s.\n')]); // #1000
  // Hand-duplicate the managed `State:` line directly in the body (a human fat-finger).
  const dbp = bodyPath(dstore, 1000, 1000);
  fs.writeFileSync(dbp, readBody(dstore, 1000).replace(/(- \*\*State:\*\* open\n)/, '$1- **State:** open\n'), 'utf8');
  ok('C3 setup: the body now has TWO State: lines',
    (readBody(dstore, 1000).match(/- \*\*State:\*\*/g) || []).length === 2);
  // A content-only edit (Q9 — never touches State) triggers a body write -> normalize-on-write.
  const dr = runTask(dstore, ['edit', '1000', '--from', writePayload(dstore, 'd2', '# dupe probe reworded\n\n**Summary:** s2.\n')]);
  ok('C3: the edit succeeded', dr.code === 0);
  const deduped = readBody(dstore, 1000);
  ok('C3: exactly ONE State: line survives the write (duplicate collapsed)',
    (deduped.match(/- \*\*State:\*\*/g) || []).length === 1);
  ok('C3: the surviving State: value is preserved (still open — edit is content-only)',
    /- \*\*State:\*\* open/.test(deduped));
  ok('C3: unmanaged behavior intact — the content edit still reworded the headline',
    /dupe probe reworded/.test(deduped));
  fs.rmSync(dstore, { recursive: true, force: true });
}

// ── C3-narrowing regression: dedupe is scoped to the TOP state block, never the whole body ──
// The r2 dedupe over-reached: a free whole-body scan silently DELETED a human prose line that
// mimics a managed field (e.g. `- **State:** of the art` under `## Notes`) on the next mutating
// write — a NEW no-data-loss violation. The dedupe now collapses duplicates ONLY within the
// contiguous state block at the top; a managed-field-mimicking bullet AFTER that block is
// UNMANAGED and must survive byte-intact — while a genuine duplicate INSIDE the block still
// collapses (the real C3 fix stays working). Same block-scoping discipline that fixed BUG-2.
{
  const nstore = mkStore('tpm-task-dedupe-notes');
  runTask(nstore, ['add', '--from', writePayload(nstore, 'n', '# dupe-in-notes probe\n\n**Summary:** s.\n')]); // #1000
  const nbp = bodyPath(nstore, 1000, 1000);
  // (a) hand-duplicate the managed State line INSIDE the top state block (a genuine dup), and
  // (b) append a ## Notes section full of prose that MIMICS managed field bullets / lines.
  const notesBlock = [
    '', '## Notes',
    'Human wrote this note paragraph.',
    '- **State:** of the art',
    '- **Created:** by a person, not the tool',
    '- **Ended:** never in this lifetime',
    '**Summary:** this line only looks managed but is prose',
    '',
  ].join('\n');
  const withDupAndNotes = readBody(nstore, 1000)
    .replace(/(- \*\*State:\*\* open\n)/, '$1- **State:** open\n') // in-block genuine duplicate
    + notesBlock;
  fs.writeFileSync(nbp, withDupAndNotes, 'utf8');
  ok('C3-narrow setup: two in-block State: lines + a ## Notes section with mimicking prose',
    (readBody(nstore, 1000).match(/- \*\*State:\*\* open/g) || []).length === 2
    && /## Notes/.test(readBody(nstore, 1000)));
  // A content-only edit triggers a body write -> normalize-on-write (the dedupe).
  const nr = runTask(nstore, ['edit', '1000', '--from', writePayload(nstore, 'n2', '# dupe-in-notes reworded\n\n**Summary:** s2.\n')]);
  ok('C3-narrow: the edit succeeded', nr.code === 0);
  const after = readBody(nstore, 1000);
  ok('C3-narrow: the genuine in-block State: duplicate still collapses to ONE canonical line',
    (after.match(/- \*\*State:\*\* open/g) || []).length === 1);
  ok('C3-narrow: the ## Notes prose `- **State:** of the art` SURVIVES byte-intact (unmanaged)',
    /- \*\*State:\*\* of the art/.test(after));
  ok('C3-narrow: the ## Notes prose `- **Created:** by a person` SURVIVES byte-intact (unmanaged)',
    /- \*\*Created:\*\* by a person, not the tool/.test(after));
  ok('C3-narrow: the ## Notes prose `- **Ended:** never` SURVIVES byte-intact (unmanaged)',
    /- \*\*Ended:\*\* never in this lifetime/.test(after));
  ok('C3-narrow: the ## Notes prose `**Summary:**`-mimic line SURVIVES byte-intact (unmanaged)',
    /\*\*Summary:\*\* this line only looks managed but is prose/.test(after));
  ok('C3-narrow: the ## Notes heading + human paragraph SURVIVE (G1 no-data-loss)',
    /## Notes/.test(after) && /Human wrote this note paragraph\./.test(after));
  ok('C3-narrow: unmanaged behavior intact — the content edit still reworded the headline',
    /dupe-in-notes reworded/.test(after));
  fs.rmSync(nstore, { recursive: true, force: true });
}

// cleanup shared stores
fs.rmSync(store, { recursive: true, force: true });
fs.rmSync(store2, { recursive: true, force: true });

process.stdout.write(`\nPASS — ${count()}/${count()} tpm-task.js behavioral assertions green\n`);
