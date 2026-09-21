'use strict';
/**
 * io.js — crash-safe atomic write + fail-loud canonical read (kind-agnostic).
 *
 * Implements two LOCKED store invariants (json-format-spec "Store integrity"):
 *  - Atomic writes: temp file (same dir) -> fsync -> atomic rename. A crash/kill
 *    mid-write can NEVER leave a partial/corrupt canonical file (#1100/#1117).
 *  - Fail-loud reads: an unreadable / invalid-JSON canonical file throws a LOUD error
 *    naming the file + the problem; NEVER returns an empty/default record (#1066).
 *
 * Zero third-party deps; Node built-ins only. Runnable/inspectable via `node <file>`.
 */
const fs = require('fs');
const path = require('path');

/**
 * atomicWriteFileSync(filePath, data, { encoding = 'utf8' }) -> void
 *
 * Writes `data` to a temp file in the SAME directory, fsyncs it to durable storage,
 * then atomically renames it over `filePath`. On ANY error the temp file is unlinked
 * and the error is rethrown, so the pre-existing canonical file is left byte-identical
 * and no orphaned `.tmp` is left behind.
 *
 * tmp name: `${basename}.<pid>.<rand>.tmp` in the target's own directory (so the rename
 * is same-filesystem and therefore atomic).
 */
function atomicWriteFileSync(filePath, data, opts) {
  const encoding = (opts && opts.encoding) || 'utf8';
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const rand = Math.random().toString(36).slice(2);
  const tmp = path.join(dir, `${base}.${process.pid}.${rand}.tmp`);

  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, data, null, encoding);
    fs.fsyncSync(fd);        // durability: flush to disk before we expose the file
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath); // atomic swap over the target
  } catch (err) {
    // Roll back: close a still-open fd and remove the partial temp file.
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* best-effort */ }
    }
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (_) { /* best-effort cleanup */ }
    const e = new Error(`atomicWriteFileSync: failed writing '${filePath}': ${err.message}`);
    e.cause = err;
    e.code = err.code;
    throw e;
  }
}

/**
 * readCanonicalSync(filePath) -> object
 *
 * Reads + JSON-parses the canonical file. Fail-loud: a missing/unreadable file or a
 * JSON parse error throws an Error naming the FILE and the problem. NEVER returns an
 * empty object or a default record on failure (that would silently erase real state).
 */
function readCanonicalSync(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`readCanonicalSync: cannot read canonical file '${filePath}': ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`readCanonicalSync: canonical file '${filePath}' is not valid JSON: ${err.message}`);
  }
}

module.exports = { atomicWriteFileSync, readCanonicalSync };
