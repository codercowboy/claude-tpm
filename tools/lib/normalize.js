'use strict';
/**
 * normalize.js — array-canonical normalisation for multi-value fields (kind-agnostic).
 *
 * LOCKED convention (#1116 / json-format-spec O2): multi-value fields are ALWAYS stored
 * as arrays (even at length 1). A bare string is accepted on INPUT as sugar and coerced
 * to a length-1 array; undefined/null -> []. Narrative prose fields (where/next) are NOT
 * run through this — they stay plain strings.
 *
 * Zero third-party deps; Node built-ins only.
 */

/**
 * normalizeArray(value) -> string[]
 *   undefined | null      -> []
 *   a bare string         -> [string]          (input sugar, #1116 A)
 *   an array              -> a shallow COPY as-is
 *   any other scalar      -> [scalar]          (defensive; canonical form is always an array)
 */
function normalizeArray(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.slice();
  return [value];
}

module.exports = { normalizeArray };
