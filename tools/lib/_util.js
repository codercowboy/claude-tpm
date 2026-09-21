'use strict';
/**
 * _util.js — small, dependency-free helpers shared WITHIN this suite's lib/.
 *
 * Suite-local only (NOT a cross-suite shared module — tool-conventions §2). Provides
 * deepClone + dotted-path get/set + a plain-object test used by envelope/update.
 * Node built-ins only; no third-party deps.
 */

/** True for a non-null, non-array plain object. */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Structural deep clone (JSON-serialisable records only — matches our canonical store). */
function deepClone(v) {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(deepClone);
  const out = {};
  for (const k of Object.keys(v)) out[k] = deepClone(v[k]);
  return out;
}

/**
 * Read a dotted path (e.g. "handoff.where") from `obj`. Returns undefined if any
 * segment is missing. Does NOT support the "[]" array-element notation — callers
 * that carry such keys must skip them (they are kind-specific, handled by the model).
 */
function getPath(obj, dotted) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Set a dotted path on `obj`, creating intermediate plain objects as needed.
 * Mutates `obj` and returns it.
 */
function setPath(obj, dotted, value) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!isPlainObject(cur[p])) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

module.exports = { isPlainObject, deepClone, getPath, setPath };
