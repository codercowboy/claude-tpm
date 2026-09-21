'use strict';
/**
 * hash.js — the SHARED canonical content-hash of a record (Q-D, Jason 2026-09-20).
 *
 * ONE module, imported by BOTH the write side (session-converter.renderHeader, to STAMP the
 * banner) and the read side (tpm-session-doctor, to RECOMPUTE + compare). Keeping the algorithm in
 * a single place is the whole point: the embedded `(generated from: …)` token and the doctor's recompute can
 * never diverge.
 *
 * ── WHAT IS HASHED (Q-D.1, resolved) ──
 * The ENTIRE canonical record — the full envelope + payload (`schemaVersion`, `kind`, `meta`,
 * `handoff`, `log`, `punchlist`, plus any preserved-unknown fields), INCLUDING the volatile fields
 * (`handoff.updatedAt`, `meta.closedAt`, every `ts`). Nothing is excluded. `saveSession` writes the
 * JSON and renders the banner from the identical object in one call, so "every save bumps the hash"
 * is harmless — the banner is rewritten in that same save — and drift then means "this `.md` was
 * generated from EXACTLY these JSON bytes". Any later JSON mutation not followed by a re-render is
 * caught.
 *
 * ── CANONICALIZATION (deterministic, JSON-semantics-faithful) ──
 *  1. Object keys sorted ascending by UTF-16 code unit.
 *  2. Arrays stay in source order (order is semantic — log[].seq, punchlist[], events[]).
 *  3. A key whose value is `undefined` is SKIPPED — exactly what JSON.stringify drops. This is the
 *     load-bearing rule for save/doctor agreement: hashRecord(rec) === hashRecord(JSON.parse(
 *     JSON.stringify(rec))). An `undefined` ARRAY element becomes `null` (again matching
 *     JSON.stringify).
 *  4. No insignificant whitespace (compact).
 *  5. Leaf primitives are emitted via JSON.stringify (correct string escaping/quoting).
 *
 * Then sha256(canonicalString) → hex → first 12 chars (48 bits; an integrity/drift check, not an
 * adversarial one).
 *
 * ── NO SELF-REFERENCE ── the hash is computed over the JSON record (written to
 * session-<NNNN>.json); the token that CARRIES it lives only in the derived session-<NNNN>.md. The
 * JSON never contains the hash, so hashing the JSON never includes the hash — no fixpoint.
 *
 * Zero third-party deps; Node built-in `crypto` only; loadable/inspectable via `node <file>`.
 */
const crypto = require('crypto');

/**
 * canonicalize(value) -> string | undefined
 *
 * The canonical JSON serialization per the rules above. Returns `undefined` for a value
 * JSON.stringify would omit (a bare `undefined`, a function, a symbol) so an OBJECT can drop that
 * key and an ARRAY can substitute `null`. The public entry (`hashRecord`) always feeds an object,
 * so it always gets a string.
 */
function canonicalize(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'; // JSON.stringify(NaN/Inf) === "null"
  if (t === 'boolean' || t === 'string') return JSON.stringify(value);
  if (t === 'undefined' || t === 'function' || t === 'symbol') return undefined;
  if (Array.isArray(value)) {
    const parts = value.map((el) => {
      const s = canonicalize(el);
      return s === undefined ? 'null' : s; // undefined array element -> null (JSON.stringify parity)
    });
    return '[' + parts.join(',') + ']';
  }
  // plain object (or any other object type — treated as its own enumerable keys)
  const keys = Object.keys(value).sort(); // ascending by UTF-16 code unit
  const parts = [];
  for (const k of keys) {
    const s = canonicalize(value[k]);
    if (s === undefined) continue; // skip undefined-valued keys (JSON.stringify parity)
    parts.push(JSON.stringify(k) + ':' + s);
  }
  return '{' + parts.join(',') + '}';
}

/**
 * hashRecord(record) -> string  (12 lowercase hex chars)
 * sha256 over the canonical serialization of the WHOLE record, truncated to 12 hex.
 */
function hashRecord(record) {
  const canonical = canonicalize(record);
  if (typeof canonical !== 'string') {
    throw new Error('hashRecord: record must serialize to a canonical string (got a non-JSON value)');
  }
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12);
}

module.exports = { canonicalize, hashRecord };
