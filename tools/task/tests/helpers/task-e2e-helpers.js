'use strict';
/**
 * task-e2e-helpers.js — shared scratch + assertion helpers for the P08 cross-cutting task suites
 * (integration-e2e, ops-persist-fault, dogfood-corpus, base-load, exit-code). NOT a *.test.js, and
 * it lives under helpers/ so run-all (flat, non-recursive) never executes it standalone; it only
 * provides the tiny harness + assertions the new suites `require`.
 *
 * Every helper works against a SCRATCH dir (os.tmpdir mkdtemp) — NEVER the live task store.
 * Node built-ins only; zero third-party deps.
 */
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const model = require('../../lib/task-model');

// A fixed local-offset reference time for deterministic index-view age rendering.
const NOW = '2026-09-20T15:00:00-07:00';

// ── tiny per-process harness (each suite is its own `node <file>` process) ─────
let passed = 0;
let failed = 0;

function test(name, fn) {
  // Preserve the module-level history gate around each case (some cases toggle it).
  const savedGate = model.isHistoryEnabled();
  try {
    fn();
    passed++;
    console.log('  ok   - ' + name);
  } catch (e) {
    failed++;
    const detail = e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n         ') : String(e);
    console.log('  FAIL - ' + name + '\n         ' + detail);
  } finally {
    model.setHistoryEnabled(savedGate);
  }
}

function done(suite) {
  console.log(`\n${suite}: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

/** Assert `fn` throws AND its message matches `re`. */
function throwsMatching(fn, re, msg) {
  let threw = false;
  try { fn(); } catch (e) {
    threw = true;
    assert.ok(re.test(e.message), (msg || 'error') + ` should match ${re}, got: ${e.message}`);
  }
  assert.ok(threw, (msg || 'call') + ' should have thrown');
}

/**
 * withFailingFs(method, fn) — temporarily replace fs[method] with a throwing stub (fault injection).
 * Because require('fs') is a cached singleton, io.js sees the override at call time; the original is
 * always restored in a finally. Mirrors the session harness.
 */
function withFailingFs(method, fn) {
  const real = fs[method];
  fs[method] = function failingStub() {
    const e = new Error('injected fs.' + method + ' failure');
    e.code = 'EIO';
    throw e;
  };
  try {
    return fn();
  } finally {
    fs[method] = real;
  }
}

// ── scratch + path helpers (mirror the model's on-disk layout) ─────────────────
function scratch(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'tpm-task-e2e-')); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeTmp(dir, name, contents) { const p = path.join(dir, name); fs.writeFileSync(p, contents); return p; }

/** The canonical body JSON path for a task id under a store dir. */
function bodyPath(dir, id) { return model.bodyPathFor(dir, String(id)); }
/** The derived body .md sibling. */
function bodyMdPath(dir, id) { return bodyPath(dir, id).replace(/\.json$/, '.md'); }
/** Read the canonical body JSON off disk. */
function bodyJson(dir, id) { return readJson(bodyPath(dir, id)); }
/** The machine index path + its parsed contents. */
function indexPath(dir) { return path.join(dir, 'tasks-index.json'); }
function indexJson(dir) { return readJson(indexPath(dir)); }
/** One of the three derived human index views. */
function viewPath(dir, name) { return path.join(dir, name); }
const HUMAN_VIEWS = ['task-index.md', 'finished-tasks-index.md', 'removed-tasks-index.md'];

// Tokens that must never leak into a derived human render.
const LEAK_TOKENS = ['undefined', '[object Object]', 'NaN'];

/** assertNoLeaks(md, msg) — no classic template-leak tokens in a human render. */
function assertNoLeaks(md, msg) {
  const m = msg ? msg + ': ' : '';
  for (const tok of LEAK_TOKENS) {
    assert.ok(md.indexOf(tok) === -1, m + `render must not leak the token '${tok}'`);
  }
}

/**
 * assertBodyWellFormed(md, id, headline, msg) — the derived body .md adequacy gate: a non-empty
 * string, the do-not-hand-edit banner + a `generated from: <12hex>` hash line, the `# #<id> · …`
 * title, State/Labels/Created landmarks, Summary/Context/Subtasks sections, a history pointer, a
 * single trailing newline, and no leaked tokens.
 */
function assertBodyWellFormed(md, id, headline, msg) {
  const m = msg ? msg + ': ' : '';
  assert.strictEqual(typeof md, 'string', m + 'body render must be a string');
  assert.ok(md.length > 0, m + 'body render must be non-empty');
  assert.ok(md.endsWith('\n') && !md.endsWith('\n\n'), m + 'body ends with exactly one trailing newline');
  assert.ok(/^<!-- Generated from task-.*do not hand-edit/m.test(md), m + 'do-not-hand-edit banner present');
  assert.ok(/<!-- generated from: [0-9a-f]{12} -->/.test(md), m + 'content-hash banner (12 hex) present');
  if (id != null) assert.ok(md.includes('# #' + String(id) + ' · '), m + 'title carries the id');
  if (headline != null) assert.ok(md.includes(headline), m + 'title carries the headline');
  assert.ok(/^- \*\*State:\*\* /m.test(md), m + 'State landmark');
  assert.ok(/^- \*\*Labels:\*\* /m.test(md), m + 'Labels landmark');
  assert.ok(/^- \*\*Created:\*\* /m.test(md), m + 'Created landmark');
  assert.ok(md.includes('## Summary'), m + 'Summary section');
  assert.ok(md.includes('## Context'), m + 'Context section');
  assert.ok(md.includes('**Subtasks:** ('), m + 'Subtasks header');
  assert.ok(/_History: \d+ event/.test(md), m + 'history pointer');
  assertNoLeaks(md, msg);
}

/**
 * assertIndexViewWellFormed(md, msg) — the human index view adequacy gate: a title, the
 * `Next ID:` wayfinding comment, one trailing newline, and no leaked tokens. (Row/table shape is
 * pinned by the dedicated render golden; this is the "well-formed regardless of rows" gate.)
 */
function assertIndexViewWellFormed(md, msg) {
  const m = msg ? msg + ': ' : '';
  assert.strictEqual(typeof md, 'string', m + 'index view must be a string');
  assert.ok(md.startsWith('# Tasks · '), m + 'index view has a `# Tasks ·` title');
  assert.ok(/<!-- Next ID: .* -->/.test(md), m + 'Next ID wayfinding comment present');
  assert.ok(md.endsWith('\n') && !md.endsWith('\n\n'), m + 'index view ends with exactly one trailing newline');
  assertNoLeaks(md, msg);
}

/**
 * assertPersistedMatches(dir, id, expectedRecord, msg) — reload the persisted canonical body for
 * `id` through the REAL load path (read→migrate→validate) and assert it deep-equals what the op
 * returned (on-disk canonical IS the truth). Returns the reloaded record.
 */
function assertPersistedMatches(dir, id, expectedRecord, msg) {
  const m = msg ? msg + ': ' : '';
  const reloaded = model.loadTask(bodyPath(dir, id));
  assert.deepStrictEqual(reloaded, expectedRecord, m + 'persisted JSON == the record the op returned');
  return reloaded;
}

/** All *.tmp orphans anywhere under `dir` (bodies live in bodies/<bucket>/). */
function tmpOrphans(dir) {
  const out = [];
  (function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.tmp')) out.push(p);
    }
  })(dir);
  return out;
}

module.exports = {
  assert, fs, path, os, model, NOW,
  test, done, throwsMatching, withFailingFs,
  scratch, readJson, writeTmp,
  bodyPath, bodyMdPath, bodyJson, indexPath, indexJson, viewPath, HUMAN_VIEWS,
  assertNoLeaks, assertBodyWellFormed, assertIndexViewWellFormed, assertPersistedMatches, tmpOrphans,
  LEAK_TOKENS,
};
