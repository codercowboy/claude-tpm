'use strict';
/**
 * e2e-helpers.js — shared scratch + well-formedness helpers for the P07 cross-cutting suites
 * (integration, ops-persist-fault, version-tolerance, dogfood-corpus). NOT a *.test.js, so
 * run-all never executes it standalone; it only provides assertions the new suites `require`.
 *
 * Every helper works against a SCRATCH dir (os.tmpdir mkdtemp) — NEVER the live sessions dir.
 * Node built-ins only.
 */
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const model = require('../../lib/session-model');
const { render } = require('../../lib/session-converter');

// A fixed local-offset reference time for deterministic punchlist-age rendering. ageOf() clamps
// diff to >=0, so this never throws regardless of the (real-clock) createdAt stamps in a fixture.
const NOW = '2026-09-19T13:36:00-07:00';

function scratch(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'tpm-e2e-')); }
function pad4(n) { return String(Number(n)).padStart(4, '0'); }
// CANONICAL NESTED layout (json-format-spec Q-F): each session lives in its OWN folder
// <dir>/session-<NNNN>/ holding session-<NNNN>.{json,md}. These mirror what ops + the migrator write.
function jsonPath(dir, n) { return path.join(dir, `session-${pad4(n)}`, `session-${pad4(n)}.json`); }
function mdPath(dir, n) { return path.join(dir, `session-${pad4(n)}`, `session-${pad4(n)}.md`); }
function writeTmp(dir, name, contents) { const p = path.join(dir, name); fs.writeFileSync(p, contents); return p; }

// Tokens that must NEVER leak into a human render — the classic "undefined leaked into a template"
// / "[object Object]" / "NaN age" bugs. A green render must contain none of them.
const LEAK_TOKENS = ['undefined', '[object Object]', 'NaN'];

/**
 * assertWellFormedHuman(md, expectedSessions?, msg?) — the human-render adequacy gate.
 * Asserts the render is a non-empty string with EXACTLY `expectedSessions` (default 1) full
 * per-session blocks (header + Handoff + Punchlist + Log, per export-spec Q4 "full header
 * repeated"), an Open(N) punchlist header, exactly one trailing newline, and no leaked tokens.
 */
function assertWellFormedHuman(md, expectedSessions, msg) {
  const m = msg ? msg + ': ' : '';
  const n = expectedSessions == null ? 1 : expectedSessions;
  assert.strictEqual(typeof md, 'string', m + 'render must be a string');
  assert.ok(md.length > 0, m + 'render must be non-empty');
  assert.ok(md.endsWith('\n'), m + 'render must end with a trailing newline');
  assert.ok(!md.endsWith('\n\n'), m + 'render must end with exactly one trailing newline');
  const count = (re) => (md.match(re) || []).length;
  assert.strictEqual(count(/^# Session \d{4} · /gm), n, m + `expected ${n} session header(s)`);
  assert.strictEqual(count(/^## Handoff$/gm), n, m + `expected ${n} Handoff section(s)`);
  assert.strictEqual(count(/^## Punchlist$/gm), n, m + `expected ${n} Punchlist section(s)`);
  assert.strictEqual(count(/^## Log$/gm), n, m + `expected ${n} Log section(s)`);
  assert.ok(/^\*\*Open \(\d+\)\*\*/m.test(md), m + 'must render an Open (N) punchlist header');
  for (const tok of LEAK_TOKENS) {
    assert.ok(md.indexOf(tok) === -1, m + `render must not leak the token '${tok}'`);
  }
}

/**
 * renderWellFormed(record, expectedSessions?, msg?) — render(record,{now:NOW}) then assert it is
 * well-formed. Returns the rendered string. Pure read on the record.
 */
function renderWellFormed(record, expectedSessions, msg) {
  const md = render(record, { now: NOW });
  assertWellFormedHuman(md, expectedSessions, msg);
  return md;
}

/**
 * assertJsonRoundTrips(record, dir, msg?) — the canonical-JSON round-trip gate at a step.
 * Serialises `record` exactly as the store does (writeEnvelope shape), reloads it through the
 * REAL load path (read → migrate → validate), and asserts a byte/structural round-trip. Proves
 * the record is a valid canonical envelope AND that nothing is lost across a write→read cycle.
 * Returns the reloaded record.
 */
function assertJsonRoundTrips(record, dir, msg) {
  const m = msg ? msg + ': ' : '';
  const body = JSON.stringify(record, null, 2) + '\n';
  const p = path.join(dir, `roundtrip-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, body);
  const reloaded = model.loadSession(p); // read→migrate→validate; throws loud if malformed
  assert.deepStrictEqual(reloaded, record, m + 'record survives a JSON write→read round-trip unchanged');
  return reloaded;
}

/**
 * assertPersistedMatches(dir, number, expectedRecord, msg?) — reload the persisted session file
 * for `number` and assert it deep-equals what the op returned (the on-disk canonical IS the truth)
 * AND that its human render is well-formed. The per-step "JSON round-trips + human render
 * well-formed" gate for the integration flow.
 */
function assertPersistedMatches(dir, number, expectedRecord, msg) {
  const m = msg ? msg + ': ' : '';
  const reloaded = model.loadSession(jsonPath(dir, number));
  assert.deepStrictEqual(reloaded, expectedRecord, m + 'persisted JSON == the record the op returned');
  renderWellFormed(reloaded, 1, m + 'human render');
  return reloaded;
}

/**
 * loadEnvelopeFromBody(body, dir, tag) — write an exported JSON body to a fresh scratch file and
 * reload it through the REAL load path (validates it). Returns the loaded record.
 */
function loadEnvelopeFromBody(body, dir, tag) {
  const p = path.join(dir, `imported-${tag}.json`);
  fs.writeFileSync(p, body);
  return model.loadSession(p);
}

module.exports = {
  assert, fs, path, os, NOW,
  scratch, pad4, jsonPath, mdPath, writeTmp,
  assertWellFormedHuman, renderWellFormed, assertJsonRoundTrips, assertPersistedMatches,
  loadEnvelopeFromBody, LEAK_TOKENS,
};
