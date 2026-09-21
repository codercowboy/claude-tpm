'use strict';
/**
 * timestamp.test.js — local-offset ISO-8601 stamps (DoD row 3).
 *
 * Asserts the SHAPE (never a literal offset — CI may run in UTC): nowIsoTz ends in a
 * +HH:MM / -HH:MM offset, never a bare form or a UTC `Z`. Also checks a fixed Date
 * renders the local wall-clock components, and shortDateTime's YYYY-MM-DD HH:MM form.
 *
 * Run: node tests/timestamp.test.js
 */
const { assert, test, done, throwsMatching } = require('./helpers/harness');
const ts = require('../../lib/timestamp');

test('nowIsoTz has a local offset, never bare, never Z', () => {
  const s = ts.nowIsoTz();
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(s), `bad shape: ${s}`);
  assert.ok(!/Z$/.test(s), 'must not be UTC Z');
});

test('nowIsoTz renders the local wall-clock components of a fixed Date', () => {
  const d = new Date(2026, 8, 19, 8, 5, 3); // 2026-09-19 08:05:03 LOCAL (month is 0-based)
  const s = ts.nowIsoTz(d);
  assert.ok(s.startsWith('2026-09-19T08:05:03'), `expected local components, got ${s}`);
  assert.ok(/[+-]\d{2}:\d{2}$/.test(s), 'still carries a local offset');
});

test('offset never renders as -00:00', () => {
  // Simulate a UTC runtime by faking getTimezoneOffset via a Date-like object.
  const fake = {
    getFullYear: () => 2026, getMonth: () => 0, getDate: () => 1,
    getHours: () => 0, getMinutes: () => 0, getSeconds: () => 0,
    getTimezoneOffset: () => 0,
  };
  assert.strictEqual(ts.nowIsoTz(fake), '2026-01-01T00:00:00+00:00');
});

test('sub-hour offset renders correctly (India, UTC+5:30)', () => {
  const fake = {
    getFullYear: () => 2026, getMonth: () => 5, getDate: () => 15,
    getHours: () => 12, getMinutes: () => 0, getSeconds: () => 0,
    getTimezoneOffset: () => -330, // 5h30m ahead of UTC
  };
  assert.strictEqual(ts.nowIsoTz(fake), '2026-06-15T12:00:00+05:30');
});

test('shortDateTime yields YYYY-MM-DD HH:MM', () => {
  assert.strictEqual(ts.shortDateTime('2026-09-19T08:05:03-07:00'), '2026-09-19 08:05');
});

test('shortDateTime rejects a non-ISO string (fail-loud)', () => {
  throwsMatching(() => ts.shortDateTime('not-a-date'), /ISO-8601/);
});

done('timestamp.test');
