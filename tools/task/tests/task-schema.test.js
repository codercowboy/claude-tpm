'use strict';
/**
 * task-schema.test.js — kind:"task" payload schema + editable table + registration.
 *
 * Zero-dep, Node built-ins only. A tiny inline harness (mirrors the session harness contract:
 * exit NON-ZERO on any failure, per tool-conventions ship-tool bar). Run:
 *   node dev/20260920-task-features/task-tooling/tests/task-schema.test.js
 *
 * Covers (DoD):
 *  - KNOWN_KINDS registers "task" (via base envelope) with a validator + editable table.
 *  - EDITABLE_TABLE is EXACTLY the D3 editable set (headline·labels·summary·context·subtasks),
 *    and every mechanical field (id·state·timestamps·endAction·history) is ABSENT.
 *  - validatePayload ACCEPTS a spec-valid task AND works through the base validateEnvelope
 *    2-arg call (payload=record["task"]=undefined under the sibling shape → 2nd arg used).
 *  - validatePayload REJECTS: missing/blank headline, bad state, non-array labels, malformed
 *    subtasks, bad timestamp (+ more) — each rejection is REAL (mutation-proven).
 *  - Lifecycle constants: STATES exact; TRANSITIONS derived from the current tool's G3 matrix.
 */
const assert = require('assert');

const base = require('../lib/base');
const { KNOWN_KINDS } = base.envelope;
const { validateEnvelope } = base.validate;
const schema = require('../lib/task-schema');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   - ' + name);
  } catch (e) {
    failed++;
    const detail = e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n         ') : String(e);
    console.log('  FAIL - ' + name + '\n         ' + detail);
  }
}

function done(suite) {
  console.log(`\n${suite}: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

/** Assert `fn` throws AND its message matches `re`. */
function throwsMatching(fn, re, msg) {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    assert.ok(re.test(e.message), (msg || 'error message') + ` should match ${re}, got: ${e.message}`);
  }
  assert.ok(threw, (msg || 'call') + ' should have thrown');
}

const TS = '2026-09-19T09:12:00-07:00';

/** A spec-valid task record (envelope + top-level sibling payload fields). */
function wellFormed() {
  return {
    schemaVersion: '1.0.0',
    kind: 'task',
    id: '1119',
    state: 'open',
    headline: 'Build task-schema.js',
    labels: ['session', 'tooling'],
    summary: 'The first kind module.',
    context: 'Mirrors session-schema.',
    subtasks: [
      { key: 'A', text: 'design', state: 'done' },
      { key: 'B', text: 'implement', state: 'open' },
    ],
    timestamps: {
      createdAt: TS,
      updatedAt: '2026-09-20T11:30:00-07:00',
      startedAt: null,
      endedAt: null,
      reopenedAt: null,
    },
    endAction: null,
    history: [
      { at: TS, op: 'create' },
      { at: TS, op: 'edit', field: 'headline', value: 'Build task-schema.js' },
      { at: TS, op: 'state', from: 'open', to: 'in-progress' },
      { at: TS, op: 'subtask', key: 'A', action: 'check' },
    ],
  };
}

// ── registration ─────────────────────────────────────────────────────────

test('KNOWN_KINDS registers "task" with a validator + editable table', () => {
  assert.ok(Object.prototype.hasOwnProperty.call(KNOWN_KINDS, 'task'), 'KNOWN_KINDS has task');
  assert.strictEqual(typeof KNOWN_KINDS.task.validatePayload, 'function');
  assert.strictEqual(KNOWN_KINDS.task.editableTable, schema.EDITABLE_TABLE);
  assert.strictEqual(schema.TASK_KIND, 'task');
});

// ── editable table (D3) ────────────────────────────────────────────────────

test('the editable table is EXACTLY the D3 set (nothing more, nothing less)', () => {
  const expected = ['headline', 'labels', 'summary', 'context', 'subtasks[].text'].sort();
  assert.deepStrictEqual(Object.keys(schema.EDITABLE_TABLE).sort(), expected);
  // every mechanical field is ABSENT from the table
  for (const mech of [
    'id', 'state', 'endAction', 'history',
    'timestamps.createdAt', 'timestamps.updatedAt', 'timestamps.startedAt',
    'timestamps.endedAt', 'timestamps.reopenedAt', 'subtasks[].state',
  ]) {
    assert.ok(!(mech in schema.EDITABLE_TABLE), `${mech} must NOT be editable`);
  }
  assert.strictEqual(schema.EDITABLE_TABLE.labels.type, 'string[]');
  assert.strictEqual(schema.EDITABLE_TABLE['subtasks[].text'].edit, 'set');
});

// ── lifecycle constants ─────────────────────────────────────────────────────

test('STATES + SUBTASK_STATES are exactly the locked sets', () => {
  assert.deepStrictEqual(schema.STATES, ['open', 'in-progress', 'finished', 'dropped', 'removed']);
  assert.deepStrictEqual(schema.SUBTASK_STATES, ['open', 'done']);
});

test('TRANSITIONS match the current tool G3 matrix (derived, state-keyed)', () => {
  // Expected legal target states per source state, derived from the tool's verb matrix:
  //   start open→in-progress; finish {open,in-progress}→finished; drop {open,in-progress}→dropped;
  //   remove {open,in-progress,finished,dropped}→removed; reopen {finished,dropped,removed}→open.
  assert.deepStrictEqual(schema.TRANSITIONS, {
    'open':        ['in-progress', 'finished', 'dropped', 'removed'],
    'in-progress': ['finished', 'dropped', 'removed'],
    'finished':    ['open', 'removed'],   // targets listed in STATES order (open before removed)
    'dropped':     ['open', 'removed'],
    'removed':     ['open'],
  });
  // spot-checks of the verb-legality helper straight off the G3 matrix
  assert.ok(schema.isLegalTransition('start', 'open'));
  assert.ok(!schema.isLegalTransition('start', 'in-progress'));   // redundant, not legal-move
  assert.ok(schema.isLegalTransition('finish', 'in-progress'));
  assert.ok(schema.isLegalTransition('remove', 'finished'));
  assert.ok(schema.isLegalTransition('reopen', 'removed'));
  assert.ok(!schema.isLegalTransition('start', 'removed'));       // nonsensical
});

// ── happy path ──────────────────────────────────────────────────────────────

test('a well-formed task validates (direct call AND through validateEnvelope)', () => {
  const rec = wellFormed();
  schema.validatePayload(rec);                                   // direct
  assert.strictEqual(
    validateEnvelope(rec, { payloadValidator: schema.validatePayload, knownKinds: KNOWN_KINDS }),
    rec,
    'validateEnvelope passes the FULL record as 2nd arg so the sibling-shape validator works even though record["task"] is undefined'
  );
});

test('through validateEnvelope, record["task"] is genuinely undefined (2-arg contract holds)', () => {
  const rec = wellFormed();
  assert.strictEqual(rec.task, undefined, 'payload is siblings, not nested under a task key');
  // If validatePayload wrongly read arg-1 (undefined), this would throw "must be an object".
  validateEnvelope(rec, { payloadValidator: schema.validatePayload, knownKinds: KNOWN_KINDS });
});

test('optional payload fields (labels/summary/context/subtasks/history) may be absent', () => {
  const rec = wellFormed();
  delete rec.labels; delete rec.summary; delete rec.context;
  delete rec.subtasks; delete rec.history; delete rec.endAction;
  schema.validatePayload(rec);           // must NOT throw
});

test('a finished task with stamped end timestamps + endAction validates', () => {
  const rec = wellFormed();
  rec.state = 'finished';
  rec.timestamps.startedAt = TS;
  rec.timestamps.endedAt = '2026-09-20T12:00:00-07:00';
  rec.endAction = { action: 'shipped', note: 'landed in main', refs: ['#1119', 'PR-42'] };  // #1074/T-Q3 shape
  schema.validatePayload(rec);
});

// ── MUTATION checks: each rejection is real (validator is not a no-op) ────────

test('missing headline is rejected', () => {
  const rec = wellFormed(); delete rec.headline;
  throwsMatching(() => schema.validatePayload(rec), /headline.*non-empty/);
});

test('blank headline is rejected', () => {
  const rec = wellFormed(); rec.headline = '   ';
  throwsMatching(() => schema.validatePayload(rec), /headline.*non-empty/);
});

test('a bad state is rejected', () => {
  const rec = wellFormed(); rec.state = 'closed';
  throwsMatching(() => schema.validatePayload(rec), /state must be/);
});

test('a non-empty non-string id is rejected', () => {
  const rec = wellFormed(); rec.id = 1119;
  throwsMatching(() => schema.validatePayload(rec), /id.*non-empty string/);
});

test('non-array labels is rejected', () => {
  const rec = wellFormed(); rec.labels = 'session';   // bare string is import sugar, NOT canonical
  throwsMatching(() => schema.validatePayload(rec), /labels.*string\[\]/);
});

test('labels with a non-string element is rejected', () => {
  const rec = wellFormed(); rec.labels = ['ok', 7];
  throwsMatching(() => schema.validatePayload(rec), /labels.*string\[\]/);
});

test('a malformed subtask (bad per-item state) is rejected', () => {
  const rec = wellFormed(); rec.subtasks[1].state = 'checked';
  throwsMatching(() => schema.validatePayload(rec), /subtasks\[1\]\.state must be/);
});

test('a subtask missing its key is rejected', () => {
  const rec = wellFormed(); delete rec.subtasks[0].key;
  throwsMatching(() => schema.validatePayload(rec), /subtasks\[0\]\.key.*non-empty/);
});

test('non-array subtasks is rejected', () => {
  const rec = wellFormed(); rec.subtasks = { A: 'x' };
  throwsMatching(() => schema.validatePayload(rec), /subtasks must be an array/);
});

test('a bare/Z (non-offset) timestamp is rejected', () => {
  const rec = wellFormed(); rec.timestamps.createdAt = '2026-09-19T09:12:00Z';
  throwsMatching(() => schema.validatePayload(rec), /createdAt.*ISO-8601/);
});

test('a missing timestamps block is rejected', () => {
  const rec = wellFormed(); delete rec.timestamps;
  throwsMatching(() => schema.validatePayload(rec), /timestamps block is required/);
});

test('a non-object endAction is rejected', () => {
  const rec = wellFormed(); rec.endAction = 'shipped';
  throwsMatching(() => schema.validatePayload(rec), /endAction must be an object or null/);
});

test('a bad history op is rejected', () => {
  const rec = wellFormed(); rec.history[0].op = 'nuke';
  throwsMatching(() => schema.validatePayload(rec), /history\[0\]\.op must be/);
});

test('a history edit event without a value snapshot is rejected', () => {
  const rec = wellFormed(); delete rec.history[1].value;
  throwsMatching(() => schema.validatePayload(rec), /edit.*value snapshot/);
});

test('a history state event with a bad target is rejected', () => {
  const rec = wellFormed(); rec.history[2].to = 'archived';
  throwsMatching(() => schema.validatePayload(rec), /history\[2\]\.to must be a valid state/);
});

test('a history subtask event with a bad action is rejected', () => {
  const rec = wellFormed(); rec.history[3].action = 'toggle';
  throwsMatching(() => schema.validatePayload(rec), /history\[3\]\.action must be/);
});

test('a non-object record is rejected', () => {
  throwsMatching(() => schema.validatePayload('nope'), /task record must be an object/);
});

done('task-schema.test');
