#!/usr/bin/env node
/**
 * tests/tpm-task/bug-repros.test.js — failing repros for confirmed defects (NOT in run-all.js).
 *
 * PURPOSE
 *   The test-writer found real bugs while adversarially attacking the defining constraints. Per
 *   the charter, the test-writer does NOT fix — it hands a precise, executable repro to the
 *   verifier + the orchestrator's bug-fixer loop. Each case here asserts the CORRECT behaviour,
 *   so this file exits NON-ZERO while the bug is present and GREEN once fixed. It is deliberately
 *   excluded from tests/run-all.js so the mutation-check baseline stays green; run it directly.
 *
 *   Full write-ups (severity, root cause, fix sketch) live in
 *   dev/tasks-module-build/02-build-task-module/findings/test-writer-notes.md.
 *
 * HOW TO RUN
 *   node tests/tpm-task/bug-repros.test.js     # exit 0 only when ALL listed bugs are fixed
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { runTask, mkStore, writePayload, readBody } = require('../lib/harness');

const results = [];
function repro(id, fn) {
  try {
    fn();
    results.push({ id, ok: true, msg: 'FIXED (assertion holds)' });
  } catch (err) {
    results.push({ id, ok: false, msg: err.message });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ── BUG 1 — a headline that begins with a number loses its leading number ─────────
// TITLE-parse greedily consumes a leading integer as the task NUMBER, so `add`/`import`/`edit`
// of "# 2026 roadmap cleanup" stores the headline as "roadmap cleanup". Data mangle.
repro('BUG-1 leading-number headline is mangled on add', () => {
  const store = mkStore('bug1');
  runTask(store, ['add', '--from', writePayload(store, 'n', '# 2026 roadmap cleanup\n\n**Summary:** s.\n')]);
  const body = readBody(store, 1000) || '';
  fs.rmSync(store, { recursive: true, force: true });
  assert(/# #1000 · 2026 roadmap cleanup/.test(body),
    `headline lost its leading number. body title = ${JSON.stringify((body.split('\n')[0]) || '')}`);
});

// ── BUG 2 — edit-subtasks DELETES unmanaged prose when a lettered checkbox lives in prose ─
// A human writing "- [ ] C. ..." inside a ## Notes section makes parseBody treat that line as a
// subtask item. setSubtasks then splices the whole span from the **Subtasks:** header through
// that stray checkbox — destroying the ## Notes heading + any prose in between. This is a direct
// violation of the module's defining G1 preserve-unmanaged-prose constraint.
repro('BUG-2 edit-subtasks preserves a ## Notes block + prose (G1 no-data-loss)', () => {
  const store = mkStore('bug2');
  runTask(store, ['add', '--from', writePayload(store, 'e', '# Epic\n\n**Summary:** s.\n\n**Subtasks:**\n- [ ] A. one\n- [ ] B. two\n')]);
  const bp = path.join(store, 'bodies', '1000-1999', 'task-1000.md');
  // Human adds a Notes section AFTER the subtasks, containing a lettered checkbox + prose.
  let body = fs.readFileSync(bp, 'utf8').replace(/\n$/, '');
  body += '\n\n## Notes\nImportant human note paragraph.\n- [ ] C. a checkbox a human wrote in notes\n';
  fs.writeFileSync(bp, body, 'utf8');
  // Edit the real subtasks.
  runTask(store, ['edit', '1000', '--from', writePayload(store, 'ed', '# Epic\n\n**Subtasks:**\n- [ ] A. one\n- [ ] B. two\n- [ ] C. three\n')]);
  const after = fs.readFileSync(bp, 'utf8');
  fs.rmSync(store, { recursive: true, force: true });
  assert(/## Notes/.test(after) && /Important human note paragraph/.test(after),
    'edit-subtasks destroyed the ## Notes heading and/or the human note paragraph.');
});

// ── BUG 3 — import DROPS Ended / End action (lossy export->import->export round-trip) ─
// cmdImport (and cmdAdd) call buildBody WITHOUT started/ended/endAction/reopened, so importing a
// finished/dropped task keeps State but silently loses its Ended date + End action. Breaks the
// spec §10 "export -> import -> export is lossless" claim for any ended task.
repro('BUG-3 import of a finished task preserves Ended + End action (round-trip lossless)', () => {
  const store = mkStore('bug3');
  const finBody = '# A finished thing\n\n- **State:** finished\n- **Created:** 2026-01-01\n- **Ended:** 2026-02-02\n- **End action:** shipped in PR #9\n\n**Summary:** done.\n';
  runTask(store, ['import', '--from', writePayload(store, 'imp', finBody)]);
  const body = readBody(store, 1000) || '';
  fs.rmSync(store, { recursive: true, force: true });
  assert(/- \*\*Ended:\*\* 2026-02-02/.test(body) && /- \*\*End action:\*\* shipped in PR #9/.test(body),
    'imported finished task lost its Ended date and/or End action line.');
});

// ── report ───────────────────────────────────────────────────────────────────────
let failed = 0;
for (const r of results) {
  process.stdout.write(`  ${r.ok ? 'FIXED' : 'BUG PRESENT'}: ${r.id}\n`);
  if (!r.ok) { process.stdout.write(`      -> ${r.msg}\n`); failed += 1; }
}
process.stdout.write(`\n${failed ? 'RED' : 'GREEN'} — ${results.length - failed}/${results.length} confirmed bugs fixed`
  + `${failed ? ` (${failed} still present — see findings/test-writer-notes.md)` : ''}\n`);
process.exit(failed ? 1 : 0);
