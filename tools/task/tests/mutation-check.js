#!/usr/bin/env node
/**
 * tests/mutation-check.js — the mutation proof for the tools/task suite.
 *
 * PURPOSE
 *   Per verification.md + the test-writer charter: "a test that still passes when you break the
 *   thing it tests has verified nothing." For every listed mutant this harness:
 *     1. confirms the anchor occurs EXACTLY ONCE in the tool file (a stale anchor that no-ops
 *        would make the proof vacuous — G9: re-validate anchors after any bug-fixer edit),
 *     2. applies ONE deliberate mutation to the tool file under test,
 *     3. runs the OWNING suite and asserts it goes RED (nonzero exit),
 *     4. restores the tool BYTE-FOR-BYTE and re-runs the suite to confirm it is GREEN again.
 *   A mutant that leaves its suite green is a SURVIVOR and fails this harness.
 *
 *   Every path resolves via __dirname — no hardcoded absolutes, so this tree stays portable when
 *   promoted from out/tools/task/ to tools/task/.
 *
 * HOW TO RUN
 *   node tests/mutation-check.js        # exit 0 = every listed mutant killed
 *   node tests/mutation-check.js --help
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// tests/mutation-check.js -> .. = the suite root (out/tools/task, or tools/task once promoted).
const TOOL_ROOT = path.resolve(__dirname, '..');
const T = (rel) => path.join(TOOL_ROOT, rel);
const TEST = (rel) => path.join(__dirname, rel);

const FORMAT = T('tpm-task-format.js');
const RENDER = T('tpm-task-render.js');
const STORE = T('tpm-task-store.js');
const TASK = T('tpm-task.js');
const CONFIG = T('tpm-task-config.js');

const FORMAT_TEST = TEST('format/test.js');
const RENDER_TEST = TEST('render/test.js');
const TASK_TEST = TEST('tpm-task/test.js');

// Each mutant: id, tool file, the suite that must catch it, and a find->replace pair.
// `find` MUST be a UNIQUE substring of the CURRENT tool source (checked below).
const MUTANTS = [
  // ── tpm-task-format.js  (caught by tests/format/test.js) ─────────────────────────
  { id: 'format · setSubtaskChecked idempotency guard neutered (already-checked re-writes + reports changed)',
    file: FORMAT, test: FORMAT_TEST,
    find: 'if (target.checked === checked) return { raw, existed: true, changed: false };',
    replace: 'if (false && target.checked === checked) return { raw, existed: true, changed: false };' },
  { id: 'format · fieldLine drops the **bold** managed-line normalization',
    file: FORMAT, test: FORMAT_TEST,
    find: 'return `- **${name}:** ${value}`;',
    replace: 'return `- ${name}: ${value}`; /* MUT */' },
  { id: 'format · checkbox letter no longer upper-cased (lenient letter normalization broken)',
    file: FORMAT, test: FORMAT_TEST,
    find: 'letter: bm[2].toUpperCase()',
    replace: 'letter: bm[2] /* MUT */' },
  { id: 'format · subtaskProgress done-count off by one (epic hint wrong)',
    file: FORMAT, test: FORMAT_TEST,
    find: 'const done = parsed.subtasks.items.filter((it) => it.checked).length;',
    replace: 'const done = parsed.subtasks.items.filter((it) => it.checked).length + 1;' },
  // dedupeManagedFields — caught by tests/tpm-task/test.js (the C3 + C3-narrowing regression blocks).
  { id: 'format · dedupeManagedFields collapse neutered (a hand-duplicated in-block State: line is NOT dropped — C3)',
    file: FORMAT, test: TASK_TEST,
    find: 'if (seen.has(key)) drop.add(i); else seen.add(key);',
    replace: 'if (false) drop.add(i); else seen.add(key); /* MUT */' },
  { id: 'format · dedupeManagedFields block-scope broken (break -> continue: free whole-body scan DELETES ## Notes prose — C3 over-reach regression)',
    file: FORMAT, test: TASK_TEST,
    find: 'if (!fm) break; // first blank / non-managed-field line ENDS the contiguous state block',
    replace: 'if (!fm) continue; // MUT: free whole-body scan' },

  // ── tpm-task-render.js  (caught by tests/render/test.js) ─────────────────────────
  { id: 'render · ladder "today" boundary D<=0 -> D<0 (same-day no longer today)',
    file: RENDER, test: RENDER_TEST,
    find: "if (D <= 0) return 'today';",
    replace: "if (D < 0) return 'today';" },
  { id: 'render · ladder day-band cutoff 13 -> 3 (Q3 boundary broken)',
    file: RENDER, test: RENDER_TEST,
    find: 'if (days <= 13) return',
    replace: 'if (days <= 3) return' },
  { id: 'render · ladder week-band cutoff 69 -> 6 (Q3 boundary broken)',
    file: RENDER, test: RENDER_TEST,
    find: 'if (days <= 69) return',
    replace: 'if (days <= 6) return' },
  { id: 'render · descending-range error neutered (illegal selector accepted)',
    file: RENDER, test: RENDER_TEST,
    find: 'if (end < start) return { ids: [], warnings, error:',
    replace: 'if (false) return { ids: [], warnings, error:' },
  { id: 'render · sortRows "id" order reversed (ascending id broken)',
    file: RENDER, test: RENDER_TEST,
    find: "case 'id': copy.sort((a, b) => a.num - b.num); break;",
    replace: "case 'id': copy.sort((a, b) => b.num - a.num); break;" },

  // ── tpm-task.js  (caught by tests/tpm-task/test.js — classifyTransition matrix) ──────
  { id: 'task · classifyTransition redundant branch neutered (redundant cells misclassified)',
    file: TASK, test: TASK_TEST,
    find: "if (t.redundantFrom.includes(current)) return { result: 'redundant', target: t.target };",
    replace: "if (false) return { result: 'redundant', target: t.target };" },
  { id: 'task · classifyTransition illegal fallthrough -> legal (nonsensical transitions allowed)',
    file: TASK, test: TASK_TEST,
    find: "return { result: 'illegal', target: t.target };",
    replace: "return { result: 'legal', target: t.target };" },

  // ── tpm-task-store.js  (caught by tests/tpm-task/test.js — behavioral) ───────────────
  { id: 'store · peekNextId startId floor off-by-one (first id no longer startId)',
    file: STORE, test: TASK_TEST,
    find: 'const highest = Math.max(highestKnownId(tasksDir), startId - 1);',
    replace: 'const highest = Math.max(highestKnownId(tasksDir), startId);' },
  { id: 'store · reindex marker FLOOR dropped (a previously-issued high id can be reused)',
    file: STORE, test: TASK_TEST,
    find: 'if (priorMarker !== null) highest = Math.max(highest, priorMarker - 1);',
    replace: 'if (false) highest = Math.max(highest, priorMarker - 1);' },
  { id: 'store · placeRow no longer removes the stale row (task lingers in its old pool)',
    file: STORE, test: TASK_TEST,
    find: 'indexes[pool].rows = indexes[pool].rows.filter((r) => r.num !== n);',
    replace: 'indexes[pool].rows = indexes[pool].rows.filter((r) => true);' },
  { id: 'store · G10 index-row Next-ID floor dropped (a hand-typed high index row can be reused — C1)',
    file: STORE, test: TASK_TEST,
    find: 'for (const r of idx.rows) highest = Math.max(highest, r.num);',
    replace: 'for (const r of idx.rows) highest = Math.max(highest, 0); /* MUT */' },

  // ── tpm-task-config.js  (caught by tests/tpm-task/test.js — allowHardDelete gate) ────
  { id: 'config · allowHardDelete override ignored (hard-delete cannot be disabled)',
    file: CONFIG, test: TASK_TEST,
    find: "if (typeof rawTasks.allowHardDelete === 'boolean') resolved.allowHardDelete = rawTasks.allowHardDelete;",
    replace: "if (false) resolved.allowHardDelete = rawTasks.allowHardDelete;" },
];

function runsGreen(testPath) {
  try {
    execFileSync('node', [testPath], { encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch (_e) {
    return false;
  }
}

function printHelp() {
  process.stdout.write(fs.readFileSync(__filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \*\s?/gm, '') + '\n');
}

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) { printHelp(); process.exit(0); }

  const suites = [
    ['format/test.js', FORMAT_TEST],
    ['render/test.js', RENDER_TEST],
    ['tpm-task/test.js', TASK_TEST],
  ];
  let baselineBad = false;
  for (const [name, t] of suites) {
    if (!runsGreen(t)) { process.stderr.write(`✗ BASELINE NOT GREEN — ${name}\n`); baselineBad = true; }
  }
  if (baselineBad) { process.stderr.write('Fix the suites before mutation-checking.\n'); process.exit(1); }
  process.stdout.write(`baseline: all ${suites.length} suites GREEN\n\n`);

  let survivors = 0;
  for (const m of MUTANTS) {
    const original = fs.readFileSync(m.file, 'utf8');
    const occ = original.split(m.find).length - 1;
    if (occ !== 1) {
      process.stderr.write(`✗ ${m.id}: anchor occurs ${occ}× in ${path.basename(m.file)} (want exactly 1) — harness stale (G9).\n`);
      survivors += 1;
      continue;
    }
    fs.writeFileSync(m.file, original.replace(m.find, m.replace));
    let green;
    try {
      green = runsGreen(m.test);
    } finally {
      fs.writeFileSync(m.file, original); // ALWAYS restore byte-for-byte
    }
    if (green) {
      process.stderr.write(`✗ SURVIVOR — ${m.id}: mutant left ${path.basename(m.test)} GREEN (suite doesn't guard it)\n`);
      survivors += 1;
      continue;
    }
    if (fs.readFileSync(m.file, 'utf8') !== original) {
      process.stderr.write(`✗ RESTORE FAILED — ${m.id}: ${path.basename(m.file)} left dirty!\n`);
      survivors += 1;
      continue;
    }
    if (!runsGreen(m.test)) {
      process.stderr.write(`✗ RESTORE FAILED — ${m.id}: ${path.basename(m.test)} not green after restore.\n`);
      survivors += 1;
      continue;
    }
    process.stdout.write(`✓ killed — ${m.id}\n`);
  }

  process.stdout.write(`\n${survivors ? 'FAIL' : 'PASS'} — ${MUTANTS.length - survivors}/${MUTANTS.length} mutants killed\n`);
  process.exit(survivors ? 1 : 0);
}

main();
