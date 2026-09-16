#!/usr/bin/env node
/**
 * tests/format/test.js — unit suite for tpm-task-format.js (the format token SSOT / G1 surgical rewrite).
 *
 * WHAT IT GUARDS
 *   - Lenient landmark parse (case / whitespace / missing-bullet / separator / checkbox variants).
 *   - The SURGICAL in-place mutations (setField / removeField / setHeadline / setSummary /
 *     setContext / setSubtasks / setSubtaskChecked): every one edits ONLY its managed line(s) and
 *     leaves unmanaged prose byte-for-byte intact (the G1 no-data-loss contract).
 *   - FIELD_ORDER-correct insertion; setSubtaskChecked existed/changed semantics (idempotency).
 *   - buildBody canonical output; index parse/render round-trip.
 *
 * HOW TO RUN
 *   node tests/format/test.js        # exit 0 = all green; any assertion throw = non-zero
 */

'use strict';

const { makeChecker, TOOLS } = require('../lib/harness');
const fmt = require(TOOLS.format);

const { check, ok, eq, count } = makeChecker();

// ── canonical parse ─────────────────────────────────────────────────────────────
const canonical = [
  '# #1245 · Add a dark-mode toggle',
  '',
  '- **State:** in-progress',
  '- **Created:** 2026-08-27',
  '- **Started:** 2026-08-28',
  '',
  '**Summary:** add a toggle.',
  '',
  '**Context:** touches `CLAUDE.md`.',
  '',
  '**Subtasks:**',
  '- [ ] A. draft',
  '- [x] B. write',
  '',
].join('\n');

const p = fmt.parseBody(canonical);
eq('parse: number', p.number, 1245);
eq('parse: headline', p.headline, 'Add a dark-mode toggle');
eq('parse: State value', p.fields.State.value, 'in-progress');
eq('parse: Created value', p.fields.Created.value, '2026-08-27');
eq('parse: Started value', p.fields.Started.value, '2026-08-28');
eq('parse: Summary value', p.summary.value, 'add a toggle.');
eq('parse: Context value', p.context.value, 'touches `CLAUDE.md`.');
eq('parse: subtasks count', p.subtasks.items.length, 2);
eq('parse: subtask A unchecked', p.subtasks.items[0].checked, false);
eq('parse: subtask B checked', p.subtasks.items[1].checked, true);
eq('parse: subtaskProgress 1/2', fmt.subtaskProgress(p), { done: 1, total: 2 });

// ── LENIENT parse of a hand-mangled body (the §1 hard constraint) ────────────────
const mangled = [
  '#  1300 : messy headline',                 // ': ' separator, double space, no '#' before num
  '',
  '-  **state:**   OPEN',                       // lowercase label, lowercase value, extra spaces
  '**Created :** 2026-01-02',                   // no leading bullet, space before colon
  '',
  '**summary:**  lowercased label',             // lowercase Summary
  '',
  '**Subtasks:**',
  '- [X] a) capital-X, paren, lowercase letter', // [X], ')' terminator, lowercase letter
  '  - [ ] B.  indented checkbox',              // leading indent
].join('\n');
const pm = fmt.parseBody(mangled);
eq('lenient: number parsed from "#  1300 :"', pm.number, 1300);
eq('lenient: headline after ":" separator', pm.headline, 'messy headline');
eq('lenient: lowercase "state" -> State', pm.fields.State.value, 'OPEN');
eq('lenient: bulletless "**Created :**" -> Created', pm.fields.Created.value, '2026-01-02');
eq('lenient: lowercase summary', pm.summary.value, 'lowercased label');
eq('lenient: [X] a) parsed as checked A', pm.subtasks.items[0].checked, true);
eq('lenient: subtask letter normalized to A', pm.subtasks.items[0].letter, 'A');
eq('lenient: indented "- [ ] B." parsed', pm.subtasks.items[1].letter, 'B');

// ── setField: replace in place, preserve everything else ─────────────────────────
const withProse = [
  '# #1400 · has prose',
  '',
  'A human intro paragraph the tool must never touch.',
  '',
  '- **State:** open',
  '- **Created:** 2026-03-03',
  '',
  '**Summary:** s.',
  '',
  '## Human Notes',
  'Free-form note. Keep me.',
].join('\n');

const started = fmt.setField(withProse, 'State', 'in-progress');
ok('setField State replaced in place', /- \*\*State:\*\* in-progress/.test(started));
ok('setField preserved intro prose', /A human intro paragraph the tool must never touch\./.test(started));
ok('setField preserved ## Human Notes', /## Human Notes/.test(started) && /Free-form note\. Keep me\./.test(started));
ok('setField did not add/drop lines (count stable on replace)',
  started.split('\n').length === withProse.split('\n').length);

// setField INSERT keeps FIELD_ORDER (Ended must land after Created, before nothing later present)
let ended = fmt.setField(withProse, 'Ended', '2026-03-05');
const el = ended.split('\n');
const idxCreated = el.findIndex((l) => /Created/.test(l));
const idxEnded = el.findIndex((l) => /Ended/.test(l));
ok('setField insert Ended after Created (FIELD_ORDER)', idxEnded === idxCreated + 1);
ok('setField insert preserved ## Human Notes', /## Human Notes/.test(ended));

// ── removeField ──────────────────────────────────────────────────────────────────
const stripped = fmt.removeField(ended, 'Ended');
ok('removeField Ended removes just that line', !/Ended/.test(stripped) && /Created/.test(stripped));
ok('removeField is a no-op when field absent', fmt.removeField(withProse, 'Reopened') === withProse);

// ── setHeadline keeps number + prose ─────────────────────────────────────────────
const rehead = fmt.setHeadline(withProse, 'renamed headline');
ok('setHeadline keeps number, swaps text', /# #1400 · renamed headline/.test(rehead));
ok('setHeadline preserved prose', /A human intro paragraph/.test(rehead));

// ── setSummary / setContext replace + insert ─────────────────────────────────────
ok('setSummary replaces existing', /\*\*Summary:\*\* new sum/.test(fmt.setSummary(withProse, 'new sum')));
const noSum = '# #1500 · x\n\n- **State:** open\n- **Created:** 2026-01-01\n';
ok('setSummary inserts when absent', /\*\*Summary:\*\* inserted/.test(fmt.setSummary(noSum, 'inserted')));
ok('setContext inserts when absent', /\*\*Context:\*\* ctx/.test(fmt.setContext(noSum, 'ctx')));

// ── setSubtasks: replace re-letters; unmanaged prose OUTSIDE the block survives ───
const epic = [
  '# #1600 · epic',
  '',
  '- **State:** open',
  '- **Created:** 2026-01-01',
  '',
  '**Summary:** s.',
  '',
  '**Subtasks:**',
  '- [ ] A. old one',
  '- [x] B. old two',
].join('\n');
const resub = fmt.setSubtasks(epic, ['fresh one', 'fresh two', 'fresh three']);
ok('setSubtasks re-lettered A,B,C', /- \[ \] A\. fresh one/.test(resub) && /- \[ \] C\. fresh three/.test(resub));
ok('setSubtasks dropped old items', !/old one/.test(resub) && !/old two/.test(resub));
ok('setSubtasks preserved Summary above block', /\*\*Summary:\*\* s\./.test(resub));

// ── appendSubtask: adds ONE lettered subtask, PRESERVES existing items + their check state ───
const app = fmt.appendSubtask(epic, 'appended three'); // epic has A[ ], B[x]
ok('appendSubtask kept A[ ] unchanged', /- \[ \] A\. old one/.test(app));
ok('appendSubtask kept B[x] CHECKED (the whole point)', /- \[x\] B\. old two/.test(app));
ok('appendSubtask appended C as next letter, unchecked', /- \[ \] C\. appended three/.test(app));
eq('appendSubtask progress now 1/3 (B still checked)', fmt.subtaskProgress(fmt.parseBody(app)), { done: 1, total: 3 });
// no existing block → creates the **Subtasks:** header + A.
const noSub = ['# #1700 · t', '', '- **State:** open', '', '**Context:** c.'].join('\n');
const app2 = fmt.appendSubtask(noSub, 'first ever');
ok('appendSubtask creates a Subtasks block when none exists', /\*\*Subtasks:\*\*\n- \[ \] A\. first ever/.test(app2));
ok('appendSubtask kept the Context above the new block', /\*\*Context:\*\* c\./.test(app2));

// ── unmanagedLines: flags prose that add/import would SILENTLY DROP (title + managed fields excluded) ──
const dropND = fmt.unmanagedLines('# t\n\n## Notes\nprose one\nprose two\n');
eq('unmanagedLines: ## Notes + 2 prose lines flagged (title excluded)', dropND.length, 3);
ok('unmanagedLines: the ## Notes heading is among the flagged', dropND.some((d) => /## Notes/.test(d.text)));
ok('unmanagedLines: clean payload (title + **Context:**) → nothing dropped', fmt.unmanagedLines('# t\n\n**Context:** c\n').length === 0);
ok('unmanagedLines: a BULLETED "- **Context:**" is NOT a managed field → flagged', fmt.unmanagedLines('# t\n\n- **Context:** oops\n').length === 1);
ok('unmanagedLines: a sigil title `# #12 · x` is also excluded', fmt.unmanagedLines('# #12 · x\n\n**Summary:** s\n').length === 0);

// setSubtasks preserving a ## Notes block that sits ABOVE the subtasks (contiguous block case)
const epicNotesAbove = [
  '# #1650 · epic',
  '',
  '- **State:** open',
  '- **Created:** 2026-01-01',
  '',
  '## Notes',
  'A human paragraph above the subtasks.',
  '',
  '**Subtasks:**',
  '- [ ] A. one',
  '- [ ] B. two',
].join('\n');
const resub2 = fmt.setSubtasks(epicNotesAbove, ['x', 'y']);
ok('setSubtasks preserves ## Notes block above a contiguous subtasks block',
  /## Notes/.test(resub2) && /A human paragraph above the subtasks\./.test(resub2));

// ── setSubtaskChecked: existed/changed semantics (idempotency guard) ──────────────
const c1 = fmt.setSubtaskChecked(epic, 'A', true);
ok('setSubtaskChecked A: existed + changed', c1.existed === true && c1.changed === true);
ok('setSubtaskChecked A ticked the box', /- \[x\] A\. old one/.test(c1.raw));
const c2 = fmt.setSubtaskChecked(epic, 'B', true); // B already [x]
ok('setSubtaskChecked already-checked B: existed but NOT changed (idempotent)',
  c2.existed === true && c2.changed === false);
ok('setSubtaskChecked already-checked returns body unchanged', c2.raw === epic);
const c3 = fmt.setSubtaskChecked(epic, 'Z', true);
ok('setSubtaskChecked missing letter Z: existed=false', c3.existed === false && c3.changed === false);

// ── buildBody canonical author ───────────────────────────────────────────────────
const built = fmt.buildBody({
  number: 1700, headline: 'brand new', state: 'open', created: '2026-04-04',
  summary: 'sum', context: 'ctx', subtasks: ['s1', 's2'],
});
ok('buildBody canonical title', /# #1700 · brand new/.test(built));
ok('buildBody State + Created lines', /- \*\*State:\*\* open/.test(built) && /- \*\*Created:\*\* 2026-04-04/.test(built));
ok('buildBody letters A,B', /- \[ \] A\. s1/.test(built) && /- \[ \] B\. s2/.test(built));

// ── index parse/render round-trip ────────────────────────────────────────────────
const idxRaw = fmt.renderIndex({
  title: 'Open tasks', nextId: 1008, includeNextId: true,
  rows: [{ num: 1007, state: 'in-progress', created: '2026-08-27', task: 'Do a thing (2/5)' }],
});
const idxParsed = fmt.parseIndex(idxRaw);
eq('index: nextId round-trips', idxParsed.nextId, 1008);
eq('index: row num', idxParsed.rows[0].num, 1007);
eq('index: row state', idxParsed.rows[0].state, 'in-progress');
eq('index: row task', idxParsed.rows[0].task, 'Do a thing (2/5)');
ok('index: separator/header rows are not data', idxParsed.rows.length === 1);

process.stdout.write(`\nPASS — ${count()}/${count()} tpm-task-format.js assertions green\n`);
