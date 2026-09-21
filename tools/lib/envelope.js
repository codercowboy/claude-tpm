'use strict';
/**
 * envelope.js — the shared {schemaVersion, kind, <payload>} envelope: read/write +
 * preserve-unknown merge (kind-agnostic).
 *
 * LOCKED (json-format-spec "The envelope" + "Forward-compat — preserve unknown fields"):
 *  - Every canonical record is wrapped in {schemaVersion, kind, ...payload}.
 *  - Unknown fields (keys a newer writer added that this code does not recognise) MUST
 *    survive a round-trip — realised by merging OVER the parsed object (_raw), never by
 *    reconstructing a fresh literal from known fields only.
 *  - The refuse-unknown-NEWER guard lives in version.migrate (paired with this so old
 *    code cannot silently destroy new data).
 *
 * KNOWN_KINDS is a registry the kind modules bind into at load (base stays agnostic —
 * it hardcodes no session/task specifics). Zero third-party deps; Node built-ins only.
 */
const io = require('./io');
const { isPlainObject, deepClone } = require('./_util');

/**
 * KNOWN_KINDS: { <kind>: <binding> } — populated by kind modules (e.g. session-schema,
 * #1112 task). The base lib ships it EMPTY and never reads a specific kind out of it;
 * validate.js consults it only when the caller opts in.
 */
const KNOWN_KINDS = {};

/**
 * readEnvelope(filePath) -> { schemaVersion, kind, payload, _raw }
 *  - readCanonicalSync (fail-loud) + assert schemaVersion & kind are present.
 *  - payload = the kind-named sub-object (record[kind]) per build-plan §base-lib.
 *  - _raw retains the FULL parsed object so unknown keys survive round-trip.
 *
 * NOTE (raised for P03): json-format-spec draws handoff/log/punchlist as top-level
 * siblings of `session`, while build-plan defines payload = record[kind]. This base lib
 * stays agnostic — it returns record[kind] as `payload` AND the full `_raw`, so P03 can
 * resolve the nesting either way. See findings/HANDOFF.md.
 */
function readEnvelope(filePath) {
  const raw = io.readCanonicalSync(filePath);
  if (!isPlainObject(raw)) {
    throw new Error(`readEnvelope: '${filePath}' is not a JSON object envelope`);
  }
  const schemaVersion = raw.schemaVersion;
  const kind = raw.kind;
  if (typeof schemaVersion !== 'string' || schemaVersion === '') {
    throw new Error(`readEnvelope: '${filePath}' missing or invalid 'schemaVersion'`);
  }
  if (typeof kind !== 'string' || kind === '') {
    throw new Error(`readEnvelope: '${filePath}' missing or invalid 'kind'`);
  }
  return { schemaVersion, kind, payload: raw[kind], _raw: raw };
}

/**
 * writeEnvelope(filePath, record) -> void
 * Serialises the record (2-space indent, trailing newline) and writes it ATOMICALLY.
 */
function writeEnvelope(filePath, record) {
  const json = JSON.stringify(record, null, 2) + '\n';
  io.atomicWriteFileSync(filePath, json, { encoding: 'utf8' });
}

/**
 * mergePreservingUnknown(existingRaw, nextKnown) -> object
 *
 * Deep-merge `nextKnown` OVER `existingRaw` so keys present only in existingRaw (unknown
 * to the current code) are NOT dropped. nextKnown wins on conflict. Arrays are replaced
 * wholesale (positional element identity is a kind concern, not the generic merge's).
 * Returns a NEW object; neither input is mutated.
 */
function mergePreservingUnknown(existingRaw, nextKnown) {
  if (nextKnown === undefined) return deepClone(existingRaw);
  if (existingRaw === undefined || existingRaw === null) return deepClone(nextKnown);
  if (!isPlainObject(existingRaw) || !isPlainObject(nextKnown)) return deepClone(nextKnown);

  const out = {};
  for (const k of Object.keys(existingRaw)) out[k] = deepClone(existingRaw[k]); // preserve unknown
  for (const k of Object.keys(nextKnown)) {
    if (isPlainObject(existingRaw[k]) && isPlainObject(nextKnown[k])) {
      out[k] = mergePreservingUnknown(existingRaw[k], nextKnown[k]);
    } else {
      out[k] = deepClone(nextKnown[k]);
    }
  }
  return out;
}

module.exports = { KNOWN_KINDS, readEnvelope, writeEnvelope, mergePreservingUnknown };
