#!/usr/bin/env node
/**
 * tpm-task-store.js — the tpm-task on-disk STORE engine (build-plan Wave 3).
 *
 * PURPOSE
 *   All filesystem mechanics over a `<tasksDir>/` store: body-file read/write with
 *   thousand-bucketing, the three derived index files (open / finished-∪-dropped / removed),
 *   the self-healing Next-ID marker, per-task index-row placement on a state change, and the
 *   full `reindex` rebuild. Parsing/rendering of the markdown itself lives in format.js — this
 *   module never hand-parses a landmark; it composes format.js's primitives with fs.
 *
 * STORE LAYOUT (spec §2)
 *   <tasksDir>/
 *     task-index.md              # open + in-progress   (+ the **Next ID:** marker)
 *     finished-tasks-index.md    # finished ∪ dropped
 *     removed-tasks-index.md     # removed (soft stash)
 *     bodies/<lo>-<hi>/task-<N>.md   # canonical; NEVER moves on a state change
 *
 * ID ALLOCATION (G10 / spec §2)
 *   nextId = max( Next-ID marker,
 *                 highest # across ALL body filenames,
 *                 highest # across ALL three index rows,
 *                 startId - 1 ) + 1
 *   Monotonic, never reused. The marker self-heals on every add/import so a stale marker, a
 *   concurrent add, or a fat-fingered edit can never reuse an ID.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const fmt = require('./tpm-task-format');

// which index a state belongs to
const STATE_TO_POOL = {
  open: 'open',
  'in-progress': 'open',
  finished: 'finished',
  dropped: 'finished',
  removed: 'removed',
};

const INDEX_FILES = {
  open: { file: 'task-index.md', title: 'Open tasks', includeNextId: true },
  finished: { file: 'finished-tasks-index.md', title: 'Finished & dropped tasks', includeNextId: false },
  removed: { file: 'removed-tasks-index.md', title: 'Removed tasks', includeNextId: false },
};

const POOLS = ['open', 'finished', 'removed'];

// ── bucketing + body paths ────────────────────────────────────────────────────
function bucketFor(n, bucketSize) {
  const lo = Math.floor(n / bucketSize) * bucketSize;
  const hi = lo + bucketSize - 1;
  return `${lo}-${hi}`;
}

function bodyPath(tasksDir, n, bucketSize) {
  return path.join(tasksDir, 'bodies', bucketFor(n, bucketSize), `task-${n}.md`);
}

function readBody(tasksDir, n, bucketSize) {
  const p = bodyPath(tasksDir, n, bucketSize);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

function writeBody(tasksDir, n, bucketSize, raw) {
  const p = bodyPath(tasksDir, n, bucketSize);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Normalize-on-write: collapse any hand-duplicated managed single-value field line to its
  // single canonical (first) occurrence (C3). No-op on a clean body; never touches prose or the
  // subtasks checkbox block. Fresh bodies (buildBody) carry no duplicates, so this is inert there.
  const body = fmt.dedupeManagedFields(raw);
  fs.writeFileSync(p, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
  return p;
}

function deleteBody(tasksDir, n, bucketSize) {
  const p = bodyPath(tasksDir, n, bucketSize);
  if (fs.existsSync(p)) { fs.unlinkSync(p); return true; }
  return false;
}

/** Every task number that has a body file on disk (scans each bodies bucket for task-N.md). */
function listBodyNumbers(tasksDir) {
  const bodiesDir = path.join(tasksDir, 'bodies');
  if (!fs.existsSync(bodiesDir)) return [];
  const nums = [];
  for (const bucket of fs.readdirSync(bodiesDir)) {
    const bdir = path.join(bodiesDir, bucket);
    if (!fs.statSync(bdir).isDirectory()) continue;
    for (const fn of fs.readdirSync(bdir)) {
      const m = /^task-(\d+)\.md$/.exec(fn);
      if (m) nums.push(parseInt(m[1], 10));
    }
  }
  return nums.sort((a, b) => a - b);
}

// ── index read/write ──────────────────────────────────────────────────────────
function indexPath(tasksDir, pool) {
  return path.join(tasksDir, INDEX_FILES[pool].file);
}

function readIndex(tasksDir, pool) {
  const p = indexPath(tasksDir, pool);
  const meta = INDEX_FILES[pool];
  if (!fs.existsSync(p)) {
    return { title: meta.title, nextId: null, rows: [] };
  }
  const parsed = fmt.parseIndex(fs.readFileSync(p, 'utf8'));
  if (!parsed.title) parsed.title = meta.title;
  return parsed;
}

function writeIndex(tasksDir, pool, parsed) {
  const meta = INDEX_FILES[pool];
  fs.mkdirSync(tasksDir, { recursive: true });
  const rows = parsed.rows.slice().sort((a, b) => b.num - a.num); // newest-# first, deterministic
  const raw = fmt.renderIndex({
    title: parsed.title || meta.title,
    nextId: parsed.nextId,
    rows,
    includeNextId: meta.includeNextId,
  });
  fs.writeFileSync(indexPath(tasksDir, pool), raw, 'utf8');
}

// ── row derivation ────────────────────────────────────────────────────────────
function deriveRow(bodyRaw) {
  const p = fmt.parseBody(bodyRaw);
  const prog = fmt.subtaskProgress(p);
  let task = p.headline || '';
  if (prog) task = `${task} (${prog.done}/${prog.total})`;
  return {
    num: p.number,
    state: (p.fields.State && p.fields.State.value) || 'open',
    created: (p.fields.Created && p.fields.Created.value) || '',
    task,
  };
}

// ── ID allocation (G10) ───────────────────────────────────────────────────────
function highestKnownId(tasksDir) {
  let highest = 0;
  for (const n of listBodyNumbers(tasksDir)) highest = Math.max(highest, n);
  for (const pool of POOLS) {
    const idx = readIndex(tasksDir, pool);
    for (const r of idx.rows) highest = Math.max(highest, r.num);
    if (idx.nextId !== null) highest = Math.max(highest, idx.nextId - 1);
  }
  return highest;
}

/** Peek the next id WITHOUT mutating (max(marker, highest#s, startId-1)+1). */
function peekNextId(tasksDir, startId) {
  const highest = Math.max(highestKnownId(tasksDir), startId - 1);
  return highest + 1;
}

/** Re-write the Next-ID marker in task-index.md to the healed value. */
function healMarker(tasksDir, startId) {
  const openIdx = readIndex(tasksDir, 'open');
  openIdx.nextId = peekNextId(tasksDir, startId);
  writeIndex(tasksDir, 'open', openIdx);
  return openIdx.nextId;
}

// ── row placement on a state change ───────────────────────────────────────────
/**
 * Ensure task N's index row lives in exactly the pool its (current body) state maps to, and
 * nowhere else. Reads the body for the authoritative row. Removed=hard-deleted bodies are
 * dropped from every index (pass removeEverywhere=true).
 */
function placeRow(tasksDir, n, bucketSize, { removeEverywhere = false } = {}) {
  // 1. remove N from every pool.
  const indexes = {};
  for (const pool of POOLS) {
    indexes[pool] = readIndex(tasksDir, pool);
    indexes[pool].rows = indexes[pool].rows.filter((r) => r.num !== n);
  }
  // 2. add to the correct pool (unless we're purging it entirely).
  if (!removeEverywhere) {
    const bodyRaw = readBody(tasksDir, n, bucketSize);
    if (bodyRaw) {
      const row = deriveRow(bodyRaw);
      const pool = STATE_TO_POOL[row.state] || 'open';
      indexes[pool].rows.push(row);
    }
  }
  for (const pool of POOLS) writeIndex(tasksDir, pool, indexes[pool]);
}

/** Locate which pool currently holds a row for N (by index), else null. */
function findRowPool(tasksDir, n) {
  for (const pool of POOLS) {
    const idx = readIndex(tasksDir, pool);
    if (idx.rows.some((r) => r.num === n)) return pool;
  }
  return null;
}

// ── full reindex (drift repair; bodies are truth) ─────────────────────────────
function reindex(tasksDir, bucketSize, startId) {
  const pools = { open: [], finished: [], removed: [] };
  // Marker FLOOR: preserve a previously-issued Next-ID marker so a hard-delete of the highest
  // task can't let reindex reuse its id. We deliberately do NOT trust arbitrary index ROWS here
  // (a corrupt/garbage row must not inflate the marker) — bodies are truth for row content, and
  // the marker + startId are the only non-body floors.
  const priorMarker = readIndex(tasksDir, 'open').nextId;
  let highest = startId - 1;
  if (priorMarker !== null) highest = Math.max(highest, priorMarker - 1);
  for (const n of listBodyNumbers(tasksDir)) {
    const raw = readBody(tasksDir, n, bucketSize);
    if (!raw) continue;
    const row = deriveRow(raw);
    const pool = STATE_TO_POOL[row.state] || 'open';
    pools[pool].push(row);
    highest = Math.max(highest, n);
  }
  const nextId = highest + 1;
  for (const pool of POOLS) {
    writeIndex(tasksDir, pool, {
      title: INDEX_FILES[pool].title,
      nextId: pool === 'open' ? nextId : null,
      rows: pools[pool],
    });
  }
  return { nextId, counts: { open: pools.open.length, finished: pools.finished.length, removed: pools.removed.length } };
}

module.exports = {
  STATE_TO_POOL,
  INDEX_FILES,
  POOLS,
  bucketFor,
  bodyPath,
  readBody,
  writeBody,
  deleteBody,
  listBodyNumbers,
  indexPath,
  readIndex,
  writeIndex,
  deriveRow,
  highestKnownId,
  peekNextId,
  healMarker,
  placeRow,
  findRowPool,
  reindex,
};
